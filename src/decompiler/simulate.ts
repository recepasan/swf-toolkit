/**
 * Symbolic execution of a basic block: turns AVM2 stack code into
 * expressions and statements.
 */
import type { AbcFile, Trait } from '../abc/abc-file.js';
import type { Instruction } from '../abc/code.js';
import { MultinameKind, NamespaceKind, TraitKind } from '../abc/constants.js';
import { Op, opInfo } from '../abc/opcodes.js';
import { formatNamespace } from '../abc/pcode/format.js';
import { exprEquals, hasSideEffects, lit, not, raw, readsLocal, type Expr, type Stmt } from './ast.js';

export type Terminator =
  | { k: 'fall' }
  | { k: 'jump' }
  | { k: 'cond'; c: Expr }
  | { k: 'switch'; e: Expr }
  | { k: 'return'; e?: Expr }
  | { k: 'throw'; e: Expr }
  | { k: 'end' };

export interface MethodContext {
  abc: AbcFile;
  methodIndex: number;
  /** Register names discovered from debug info. */
  regNames: Map<number, string>;
  /** Registers holding activation / catch scope objects. */
  specialRegs: Map<number, Expr>;
  /** Traits of the activation object (method body traits). */
  activationTraits: Trait[];
  /** Traits used to resolve getslot on `this`. */
  thisTraits: Trait[];
  /** Script-level traits for getglobalslot. */
  globalTraits: Trait[];
  /** Catch variable names by exception index. */
  catchNames: Map<number, string>;
  /** Symbolic scope stack, shared across blocks. */
  scope: Expr[];
  /** Type name formatter (records imports). */
  typeName(mn: number): string;
  /** Record a fully qualified name as needing an import. */
  useName(mn: number): void;
}

export class SimulationError extends Error {}

/** Expressions that were duplicated with `dup` (shared across blocks of a method). */
const duplicated = new WeakSet<Expr>();

const BINOPS: Record<number, string> = {
  [Op.add!]: '+',
  [Op.add_i!]: '+',
  [Op.subtract!]: '-',
  [Op.subtract_i!]: '-',
  [Op.multiply!]: '*',
  [Op.multiply_i!]: '*',
  [Op.divide!]: '/',
  [Op.modulo!]: '%',
  [Op.lshift!]: '<<',
  [Op.rshift!]: '>>',
  [Op.urshift!]: '>>>',
  [Op.bitand!]: '&',
  [Op.bitor!]: '|',
  [Op.bitxor!]: '^',
  [Op.equals!]: '==',
  [Op.strictequals!]: '===',
  [Op.lessthan!]: '<',
  [Op.lessequals!]: '<=',
  [Op.greaterthan!]: '>',
  [Op.greaterequals!]: '>=',
  [Op.instanceof!]: 'instanceof',
  [Op.istypelate!]: 'is',
  [Op.astypelate!]: 'as',
  [Op.in!]: 'in',
};

const CONDOPS: Record<number, [string, boolean]> = {
  [Op.ifeq!]: ['==', false],
  [Op.ifne!]: ['!=', false],
  [Op.iflt!]: ['<', false],
  [Op.ifle!]: ['<=', false],
  [Op.ifgt!]: ['>', false],
  [Op.ifge!]: ['>=', false],
  [Op.ifstricteq!]: ['===', false],
  [Op.ifstrictne!]: ['!==', false],
  [Op.ifnlt!]: ['<', true],
  [Op.ifnle!]: ['<=', true],
  [Op.ifngt!]: ['>', true],
  [Op.ifnge!]: ['>=', true],
};

const COERCE_TYPES: Record<number, string> = {
  [Op.coerce_a!]: '*',
  [Op.coerce_s!]: 'String',
  [Op.coerce_b!]: 'Boolean',
  [Op.coerce_i!]: 'int',
  [Op.coerce_u!]: 'uint',
  [Op.coerce_d!]: 'Number',
  [Op.coerce_o!]: 'Object',
  [Op.convert_s!]: 'String',
  [Op.convert_b!]: 'Boolean',
  [Op.convert_i!]: 'int',
  [Op.convert_u!]: 'uint',
  [Op.convert_d!]: 'Number',
  [Op.convert_o!]: 'Object',
};

function slotName(traits: Trait[], abc: AbcFile, slot: number): string | undefined {
  const t = traits.find((x) => (x.kind === TraitKind.Slot || x.kind === TraitKind.Const || x.kind === TraitKind.Class || x.kind === TraitKind.Function) && x.id === slot);
  return t ? abc.multinameName(t.name) : undefined;
}

/** Simulates `insns` with the given entry stack, appending statements to `out`. */
export function simulate(ctx: MethodContext, insns: readonly Instruction[], entryStack: Expr[], out: Stmt[]): { stack: Expr[]; term: Terminator } {
  const { abc, scope } = ctx;
  const stack = [...entryStack];
  const pop = (): Expr => {
    const v = stack.pop();
    if (!v) throw new SimulationError('Stack underflow');
    return v;
  };
  const popN = (n: number): Expr[] => {
    const xs: Expr[] = [];
    for (let i = 0; i < n; i++) xs.push(pop());
    return xs.reverse();
  };
  const emit = (s: Stmt): void => {
    out.push(s);
  };

  /** Builds the member expression for a multiname operand, popping runtime parts. */
  const member = (obj: Expr | null, mnIndex: number, popObj: boolean): Expr => {
    const m = abc.multinames[mnIndex];
    let nameExpr: Expr | undefined;
    let nsExpr: Expr | undefined;
    if (m) {
      switch (m.kind) {
        case MultinameKind.RTQNameL:
        case MultinameKind.RTQNameLA:
          nameExpr = pop();
          nsExpr = pop();
          break;
        case MultinameKind.MultinameL:
        case MultinameKind.MultinameLA:
          nameExpr = pop();
          break;
        case MultinameKind.RTQName:
        case MultinameKind.RTQNameA:
          nsExpr = pop();
          break;
      }
    }
    const target = popObj ? pop() : (obj ?? { k: 'global' });
    const attr = !!m && [MultinameKind.QNameA, MultinameKind.RTQNameA, MultinameKind.RTQNameLA, MultinameKind.MultinameA, MultinameKind.MultinameLA].includes(m.kind as 13);
    if (nameExpr) return { k: 'index', obj: target, index: nameExpr, attr };
    if (m && (m.kind === MultinameKind.QName || m.kind === MultinameKind.QNameA)) {
      const ns = abc.namespaces[m.ns];
      if (ns && ns.kind === NamespaceKind.Namespace) {
        const uri = abc.strings[ns.name] ?? '';
        // Hide AS3 builtin and interface ("pkg:Interface") namespaces.
        if (uri !== 'http://adobe.com/AS3/2006/builtin' && !/^[\w.$]*:[\w$]+$/.test(uri)) {
          return { k: 'member', obj: target, name: abc.multinameName(mnIndex), attr, ns: nsLabel(uri) };
        }
      }
    }
    if (nsExpr) {
      const ns = nsExpr.k === 'name' ? nsExpr.name : nsExpr.k === 'member' && nsExpr.obj.k !== 'findprop' ? undefined : nsExpr.k === 'member' ? nsExpr.name : undefined;
      return { k: 'member', obj: target, name: abc.multinameName(mnIndex), attr, ns: ns ?? '*' };
    }
    return { k: 'member', obj: target, name: abc.multinameName(mnIndex), attr };
  };

  /** Simplify `findprop(x).x` → `x`. */
  const access = (e: Expr): Expr => {
    if (e.k === 'member' && (e.obj.k === 'findprop' || e.obj.k === 'global') && !e.ns) return { k: 'name', name: e.name };
    return e;
  };

  /** Assignment with dup / postfix handling. */
  const assign = (target: Expr, value: Expr, isLocalReg?: number): void => {
    // Value duplicated on the stack: the remaining copies now equal the target.
    let dup = false;
    const bare = value.k === 'coerce' ? stripCoerceLocal(value) : value;
    for (let i = 0; i < stack.length; i++) {
      if (stack[i] === value || stack[i] === bare) {
        stack[i] = target;
        dup = true;
      }
    }
    // Postfix: old value still on the stack, new value = old ± 1.
    const v = value.k === 'coerce' ? value.e : value;
    if (!dup && v.k === 'binary' && (v.op === '+' || v.op === '-') && v.b.k === 'lit' && v.b.v === 1 && exprEquals(v.a, target)) {
      const idx = stack.findIndex((s) => exprEquals(s, target));
      if (idx >= 0) {
        stack[idx] = { k: 'postfix', op: v.op === '+' ? '++' : '--', e: target };
        return;
      }
    }
    if (isLocalReg !== undefined) {
      // Old value of the register still referenced on the stack: freeze it.
      for (let i = 0; i < stack.length; i++) {
        if (readsLocal(stack[i]!, isLocalReg) && stack[i] !== target) {
          // Cannot express safely; keep textual order (rare in compiler output).
        }
      }
    }
    emit({ k: 'expr', e: { k: 'assign', target, v: value } });
  };

  const getLocal = (reg: number): Expr => {
    if (reg === 0) return { k: 'this' };
    return ctx.specialRegs.get(reg) ?? { k: 'local', reg };
  };

  const setLocal = (reg: number, value: Expr): void => {
    if (value.k === 'activation' || value.k === 'catchscope' || value.k === 'findprop' || value.k === 'global') {
      ctx.specialRegs.set(reg, value);
      return;
    }
    ctx.specialRegs.delete(reg);
    assign({ k: 'local', reg }, value, reg);
  };

  const resolveSlot = (obj: Expr, slot: number): Expr => {
    switch (obj.k) {
      case 'activation': {
        const n = slotName(ctx.activationTraits, abc, slot);
        return n ? { k: 'name', name: n } : { k: 'slot', obj, slot };
      }
      case 'catchscope':
        return { k: 'name', name: ctx.catchNames.get(obj.index) ?? `e${obj.index}` };
      case 'global': {
        const n = slotName(ctx.globalTraits, abc, slot);
        return n ? { k: 'name', name: n } : { k: 'slot', obj, slot };
      }
      case 'this': {
        const n = slotName(ctx.thisTraits, abc, slot);
        return n ? { k: 'member', obj, name: n } : { k: 'slot', obj, slot };
      }
      default:
        return { k: 'slot', obj, slot };
    }
  };

  for (let pc = 0; pc < insns.length; pc++) {
    const ins = insns[pc]!;
    const a = ins.args;
    const op = ins.op;

    const bin = BINOPS[op];
    if (bin) {
      const b = pop();
      const x = pop();
      stack.push({ k: 'binary', op: bin, a: x, b });
      continue;
    }
    const coerceType = COERCE_TYPES[op];
    if (coerceType) {
      stack.push({ k: 'coerce', type: coerceType, e: pop() });
      continue;
    }

    switch (op) {
      case Op.nop:
      case Op.label:
      case Op.bkpt:
      case Op.debugline:
      case Op.debugfile:
      case Op.bkptline:
      case Op.timestamp:
      case Op.kill:
        break;
      case Op.debug:
        if (a[0] === 1 && a[1]) ctx.regNames.set((a[2] ?? 0) + 1, abc.strings[a[1]] ?? '');
        break;
      case Op.throw:
        return { stack, term: { k: 'throw', e: pop() } };
      case Op.returnvoid:
        return { stack, term: { k: 'return' } };
      case Op.returnvalue:
        return { stack, term: { k: 'return', e: pop() } };
      case Op.jump:
        return { stack, term: { k: 'jump' } };
      case Op.iftrue:
        return { stack, term: { k: 'cond', c: pop() } };
      case Op.iffalse:
        return { stack, term: { k: 'cond', c: not(pop()) } };
      case Op.lookupswitch:
        return { stack, term: { k: 'switch', e: pop() } };
      case Op.getsuper: {
        const m = member(null, a[0]!, true);
        stack.push(m.k === 'member' ? { ...m, obj: { k: 'super' } } : m);
        break;
      }
      case Op.setsuper: {
        const v = pop();
        const m = member(null, a[0]!, true);
        assign(m.k === 'member' ? { ...m, obj: { k: 'super' } } : m, v);
        break;
      }
      case Op.dxns:
        emit({ k: 'comment', text: `default xml namespace = ${JSON.stringify(abc.strings[a[0]!] ?? '')}` });
        break;
      case Op.dxnslate:
        emit({ k: 'comment', text: 'default xml namespace = <runtime>' });
        pop();
        break;
      case Op.pushwith:
        scope.push(pop());
        emit({ k: 'comment', text: 'with(...) scope begins' });
        break;
      case Op.pushscope:
        scope.push(pop());
        break;
      case Op.popscope:
        scope.pop();
        break;
      case Op.nextname:
      case Op.nextvalue: {
        const idx = pop();
        const obj = pop();
        stack.push({ k: 'next', value: op === Op.nextvalue, obj, idx });
        break;
      }
      case Op.hasnext: {
        const idx = pop();
        const obj = pop();
        stack.push({ k: 'hasnext', obj, idx });
        break;
      }
      case Op.hasnext2:
        stack.push({ k: 'hasnext2', objReg: a[0]!, idxReg: a[1]! });
        break;
      case Op.pushnull:
        stack.push(lit(null));
        break;
      case Op.pushundefined:
        stack.push(lit(undefined));
        break;
      case Op.pushtrue:
        stack.push(lit(true));
        break;
      case Op.pushfalse:
        stack.push(lit(false));
        break;
      case Op.pushnan:
        stack.push(lit(NaN));
        break;
      case Op.pushbyte:
      case Op.pushshort:
        stack.push(lit(a[0]!));
        break;
      case Op.pushstring:
        stack.push(lit(abc.strings[a[0]!] ?? ''));
        break;
      case Op.pushint:
        stack.push(lit(abc.ints[a[0]!] ?? 0));
        break;
      case Op.pushuint:
        stack.push(lit(abc.uints[a[0]!] ?? 0));
        break;
      case Op.pushdouble:
        stack.push(lit(abc.doubles[a[0]!] ?? NaN));
        break;
      case Op.pushnamespace:
        stack.push(raw(formatNamespace(abc, a[0]!)));
        break;
      case Op.pop: {
        const v = pop();
        // A duplicated value has already been consumed elsewhere (e.g. by a branch).
        if (hasSideEffects(v) && !duplicated.has(v)) emit({ k: 'expr', e: v });
        break;
      }
      case Op.dup: {
        const v = pop();
        duplicated.add(v);
        stack.push(v, v);
        break;
      }
      case Op.swap: {
        const x = pop();
        const y = pop();
        stack.push(x, y);
        break;
      }
      case Op.li8:
      case Op.li16:
      case Op.li32:
      case Op.lf32:
      case Op.lf64:
      case Op.sxi1:
      case Op.sxi8:
      case Op.sxi16:
        stack.push({ k: 'call', fn: raw(opInfo(op)!.name), args: [pop()] });
        break;
      case Op.si8:
      case Op.si16:
      case Op.si32:
      case Op.sf32:
      case Op.sf64: {
        const addr = pop();
        const v = pop();
        emit({ k: 'expr', e: { k: 'call', fn: raw(opInfo(op)!.name), args: [v, addr] } });
        break;
      }
      case Op.newfunction:
        stack.push({ k: 'function', methodIndex: a[0]! });
        break;
      case Op.call: {
        const args = popN(a[0]!);
        pop(); // receiver
        const fn = pop();
        stack.push({ k: 'call', fn, args });
        break;
      }
      case Op.construct: {
        const args = popN(a[0]!);
        stack.push({ k: 'new', ctor: pop(), args });
        break;
      }
      case Op.callmethod: {
        const args = popN(a[1]!);
        const obj = pop();
        stack.push({ k: 'call', fn: { k: 'member', obj, name: `/*method#${a[0]}*/` }, args });
        break;
      }
      case Op.callstatic: {
        const args = popN(a[1]!);
        pop();
        stack.push({ k: 'call', fn: raw(`/*static method ${a[0]}*/`), args });
        break;
      }
      case Op.callsuper:
      case Op.callsupervoid: {
        const args = popN(a[1]!);
        const m = member(null, a[0]!, true);
        const call: Expr = { k: 'call', fn: m.k === 'member' ? { ...m, obj: { k: 'super' } } : m, args };
        if (op === Op.callsupervoid) emit({ k: 'expr', e: call });
        else stack.push(call);
        break;
      }
      case Op.callproperty:
      case Op.callproplex:
      case Op.callpropvoid: {
        const args = popN(a[1]!);
        const call: Expr = { k: 'call', fn: access(member(null, a[0]!, true)), args };
        if (op === Op.callpropvoid) emit({ k: 'expr', e: call });
        else stack.push(call);
        break;
      }
      case Op.constructsuper: {
        const args = popN(a[0]!);
        pop();
        emit({ k: 'expr', e: { k: 'call', fn: { k: 'super' }, args } });
        break;
      }
      case Op.constructprop: {
        const args = popN(a[1]!);
        stack.push({ k: 'new', ctor: access(member(null, a[0]!, true)), args });
        break;
      }
      case Op.applytype: {
        const params = popN(a[0]!);
        stack.push({ k: 'applytype', base: pop(), params });
        break;
      }
      case Op.newobject: {
        const flat = popN(a[0]! * 2);
        const props: Array<[Expr, Expr]> = [];
        for (let i = 0; i < flat.length; i += 2) props.push([flat[i]!, flat[i + 1]!]);
        stack.push({ k: 'object', props });
        break;
      }
      case Op.newarray:
        stack.push({ k: 'array', items: popN(a[0]!) });
        break;
      case Op.newactivation:
        stack.push({ k: 'activation' });
        break;
      case Op.newclass:
        pop();
        stack.push({ k: 'name', name: abc.multinameName(abc.instances[a[0]!]?.name ?? 0) });
        break;
      case Op.getdescendants: {
        const m = member(null, a[0]!, true);
        stack.push(m.k === 'member' ? { k: 'descendants', obj: m.obj, name: m.name } : m);
        break;
      }
      case Op.newcatch:
        stack.push({ k: 'catchscope', index: a[0]! });
        break;
      case Op.findpropstrict:
      case Op.findproperty: {
        const m = member({ k: 'global' }, a[0]!, false);
        ctx.useName(a[0]!);
        stack.push(m.k === 'member' ? { k: 'findprop', name: m.name } : { k: 'global' });
        break;
      }
      case Op.finddef:
        ctx.useName(a[0]!);
        stack.push({ k: 'findprop', name: abc.multinameName(a[0]!) });
        break;
      case Op.getlex:
        ctx.useName(a[0]!);
        stack.push({ k: 'name', name: abc.multinameName(a[0]!) });
        break;
      case Op.setproperty:
      case Op.initproperty: {
        const v = pop();
        assign(access(member(null, a[0]!, true)), v);
        break;
      }
      case Op.getproperty:
        stack.push(access(member(null, a[0]!, true)));
        break;
      case Op.deleteproperty:
        stack.push({ k: 'unary', op: 'delete', e: access(member(null, a[0]!, true)) });
        break;
      case Op.getlocal:
        stack.push(getLocal(a[0]!));
        break;
      case Op.getlocal0:
      case Op.getlocal1:
      case Op.getlocal2:
      case Op.getlocal3:
        stack.push(getLocal(op - Op.getlocal0!));
        break;
      case Op.setlocal:
        setLocal(a[0]!, pop());
        break;
      case Op.setlocal0:
      case Op.setlocal1:
      case Op.setlocal2:
      case Op.setlocal3:
        setLocal(op - Op.setlocal0!, pop());
        break;
      case Op.getglobalscope:
        stack.push({ k: 'global' });
        break;
      case Op.getscopeobject:
        stack.push(scope[a[0]!] ?? { k: 'global' });
        break;
      case Op.getouterscope:
        stack.push({ k: 'global' });
        break;
      case Op.getslot:
        stack.push(resolveSlot(pop(), a[0]!));
        break;
      case Op.setslot: {
        const v = pop();
        const obj = pop();
        const target = resolveSlot(obj, a[0]!);
        if (obj.k === 'catchscope' && v.k === 'name' && target.k === 'name' && v.name === target.name) break;
        assign(target, v);
        break;
      }
      case Op.getglobalslot:
        stack.push(resolveSlot({ k: 'global' }, a[0]!));
        break;
      case Op.setglobalslot:
        assign(resolveSlot({ k: 'global' }, a[0]!), pop());
        break;
      case Op.esc_xelem:
      case Op.esc_xattr:
      case Op.checkfilter:
        break; // value passes through
      case Op.coerce:
        stack.push({ k: 'coerce', type: ctx.typeName(a[0]!), e: pop() });
        break;
      case Op.astype:
        stack.push({ k: 'binary', op: 'as', a: pop(), b: { k: 'name', name: ctx.typeName(a[0]!) } });
        break;
      case Op.istype:
        stack.push({ k: 'binary', op: 'is', a: pop(), b: { k: 'name', name: ctx.typeName(a[0]!) } });
        break;
      case Op.negate:
      case Op.negate_i:
        stack.push({ k: 'unary', op: '-', e: pop() });
        break;
      case Op.increment:
      case Op.increment_i:
        stack.push({ k: 'binary', op: '+', a: pop(), b: lit(1) });
        break;
      case Op.decrement:
      case Op.decrement_i:
        stack.push({ k: 'binary', op: '-', a: pop(), b: lit(1) });
        break;
      case Op.inclocal:
      case Op.inclocal_i:
        emit({ k: 'expr', e: { k: 'postfix', op: '++', e: getLocal(a[0]!) } });
        break;
      case Op.declocal:
      case Op.declocal_i:
        emit({ k: 'expr', e: { k: 'postfix', op: '--', e: getLocal(a[0]!) } });
        break;
      case Op.typeof:
        stack.push({ k: 'unary', op: 'typeof', e: pop() });
        break;
      case Op.not:
        stack.push(not(pop()));
        break;
      case Op.bitnot:
        stack.push({ k: 'unary', op: '~', e: pop() });
        break;
      default: {
        const cond = CONDOPS[op];
        if (cond) {
          const b = pop();
          const x = pop();
          const c: Expr = { k: 'binary', op: cond[0], a: x, b };
          return { stack, term: { k: 'cond', c: cond[1] ? { k: 'unary', op: '!', e: c } : c } };
        }
        throw new SimulationError(`Unsupported instruction ${opInfo(op)?.name ?? op}`);
      }
    }
  }
  return { stack, term: { k: 'fall' } };
}

function stripCoerceLocal(e: Expr): Expr {
  while (e.k === 'coerce') e = e.e;
  return e;
}

function nsLabel(uri: string): string {
  const tail = uri.split(/[/:]/).filter(Boolean).pop() ?? 'ns';
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tail) ? tail : 'ns';
}
