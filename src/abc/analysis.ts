import type { AbcFile, MethodInfo } from './abc-file.js';
import type { CodeException, CodeItem, Instruction } from './code.js';
import { MethodFlags, MultinameKind } from './constants.js';
import { Op, opInfo } from './opcodes.js';

/** Number of values a multiname pops from the stack at runtime (namespace and/or name). */
export function multinameRuntimeArity(abc: AbcFile, mnIndex: number): number {
  const m = abc.multinames[mnIndex];
  if (!m) return 0;
  switch (m.kind) {
    case MultinameKind.RTQName:
    case MultinameKind.RTQNameA:
    case MultinameKind.MultinameL:
    case MultinameKind.MultinameLA:
      return 1;
    case MultinameKind.RTQNameL:
    case MultinameKind.RTQNameLA:
      return 2;
    default:
      return 0;
  }
}

/** Values popped / pushed by an instruction. */
export function stackEffect(abc: AbcFile, i: Instruction): { pop: number; push: number } {
  const info = opInfo(i.op);
  if (!info) return { pop: 0, push: 0 };
  let pop = info.pop;
  if (info.popArgc) {
    const argcPos = info.operands.filter((t) => t !== 'branch' && t !== 'switch').indexOf('argc');
    pop += info.popArgc * (i.args[argcPos] ?? 0);
  }
  if (info.popMn) {
    const mnPos = info.operands.filter((t) => t !== 'branch' && t !== 'switch').indexOf('multiname');
    pop += multinameRuntimeArity(abc, i.args[mnPos] ?? 0);
  }
  return { pop, push: info.push };
}

/** Local registers referenced by an instruction. */
export function registersUsed(i: Instruction): number[] {
  switch (i.op) {
    case Op.getlocal0:
    case Op.setlocal0:
      return [0];
    case Op.getlocal1:
    case Op.setlocal1:
      return [1];
    case Op.getlocal2:
    case Op.setlocal2:
      return [2];
    case Op.getlocal3:
    case Op.setlocal3:
      return [3];
    case Op.getlocal:
    case Op.setlocal:
    case Op.kill:
    case Op.inclocal:
    case Op.declocal:
    case Op.inclocal_i:
    case Op.declocal_i:
      return [i.args[0] ?? 0];
    case Op.hasnext2:
      return [i.args[0] ?? 0, i.args[1] ?? 0];
    case Op.debug:
      return i.args[0] === 1 ? [i.args[2] ?? 0] : [];
    default:
      return [];
  }
}

export interface CodeLimits {
  maxStack: number;
  /** Maximum scope stack height relative to init_scope_depth. */
  maxScope: number;
  /** Highest register index referenced + 1. */
  registers: number;
}

/**
 * Computes stack / scope / register requirements by walking all control-flow
 * paths (including exception handlers).
 */
export function computeLimits(abc: AbcFile, items: readonly CodeItem[], exceptions: readonly CodeException[] = []): CodeLimits {
  const labelIndex = new Map<number, number>();
  items.forEach((it, idx) => {
    if (it.type === 'label') labelIndex.set(it.id, idx);
  });

  let maxStack = 0;
  let maxScope = 0;
  let registers = 0;
  for (const it of items) if (it.type === 'op') for (const r of registersUsed(it)) registers = Math.max(registers, r + 1);

  const seenStack = new Int32Array(items.length).fill(-1);
  const seenScope = new Int32Array(items.length).fill(-1);
  const work: Array<[number, number, number]> = [[0, 0, 0]];
  for (const e of exceptions) {
    const t = labelIndex.get(e.target);
    if (t !== undefined) work.push([t, 1, 0]);
  }
  if (exceptions.length > 0) maxStack = Math.max(maxStack, 1);

  let budget = items.length * 64 + 1024;
  while (work.length > 0 && budget-- > 0) {
    let [idx, stack, scope] = work.pop()!;
    while (idx < items.length) {
      if (stack <= seenStack[idx]! && scope <= seenScope[idx]!) break;
      seenStack[idx] = Math.max(seenStack[idx]!, stack);
      seenScope[idx] = Math.max(seenScope[idx]!, scope);
      const it = items[idx]!;
      if (it.type === 'label') {
        idx++;
        continue;
      }
      if (it.type === 'bytes') break;
      const info = opInfo(it.op);
      if (!info) break;
      const { pop, push } = stackEffect(abc, it);
      stack = Math.max(0, stack - pop) + push;
      scope = Math.max(0, scope + info.scope);
      maxStack = Math.max(maxStack, stack);
      maxScope = Math.max(maxScope, scope);

      for (let k = 0; k < it.targets.length; k++) {
        const t = labelIndex.get(it.targets[k]!);
        if (t !== undefined) work.push([t, stack, scope]);
      }
      if (info.flow === 'jump' || info.flow === 'switch' || info.flow === 'return' || info.flow === 'throw') break;
      idx++;
    }
  }

  return { maxStack, maxScope, registers };
}

/** Minimum local_count required by a method signature (this + params + rest/arguments). */
export function minLocalCount(method: MethodInfo): number {
  let n = 1 + method.paramTypes.length;
  if (method.flags & (MethodFlags.NEED_REST | MethodFlags.NEED_ARGUMENTS)) n++;
  return n;
}

export interface VerifyIssue {
  /** Index into the code item list. */
  item: number;
  message: string;
}

/**
 * Structural verification similar to the AVM2 verifier's first pass:
 * stack underflow, inconsistent stack / scope heights at merge points,
 * falling off the end of the code and scope underflow.
 */
export function verifyCode(abc: AbcFile, items: readonly CodeItem[], exceptions: readonly CodeException[] = []): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const labelIndex = new Map<number, number>();
  items.forEach((it, idx) => {
    if (it.type === 'label') labelIndex.set(it.id, idx);
  });
  const stackAt = new Int32Array(items.length + 1).fill(-1);
  const scopeAt = new Int32Array(items.length + 1).fill(-1);
  const work: Array<[number, number, number]> = [[0, 0, 0]];
  for (const e of exceptions) {
    const t = labelIndex.get(e.target);
    if (t === undefined) issues.push({ item: -1, message: `Exception target label ${e.target} undefined` });
    else work.push([t, 1, 0]);
  }
  const report = (item: number, message: string): void => {
    if (issues.length < 50 && !issues.some((i) => i.item === item && i.message === message)) issues.push({ item, message });
  };

  while (work.length) {
    let [idx, stack, scope] = work.pop()!;
    while (true) {
      if (idx >= items.length) {
        report(idx, 'Control falls off the end of the code');
        break;
      }
      if (stackAt[idx]! >= 0) {
        if (stackAt[idx] !== stack) report(idx, `Stack height mismatch at merge (${stackAt[idx]} vs ${stack})`);
        if (scopeAt[idx] !== scope) report(idx, `Scope height mismatch at merge (${scopeAt[idx]} vs ${scope})`);
        break;
      }
      stackAt[idx] = stack;
      scopeAt[idx] = scope;
      const it = items[idx]!;
      if (it.type === 'label') {
        idx++;
        continue;
      }
      if (it.type === 'bytes') break;
      const info = opInfo(it.op);
      if (!info) {
        report(idx, `Unknown opcode ${it.op}`);
        break;
      }
      const { pop, push } = stackEffect(abc, it);
      if (pop > stack) report(idx, `Stack underflow in ${info.name} (needs ${pop}, has ${stack})`);
      stack = Math.max(0, stack - pop) + push;
      scope += info.scope;
      if (scope < 0) {
        report(idx, `Scope underflow in ${info.name}`);
        scope = 0;
      }
      for (const t of it.targets) {
        const ti = labelIndex.get(t);
        if (ti === undefined) report(idx, `Undefined label ${t}`);
        else work.push([ti, stack, scope]);
      }
      if (info.flow === 'jump' || info.flow === 'switch' || info.flow === 'return' || info.flow === 'throw') break;
      idx++;
    }
  }
  return issues;
}
