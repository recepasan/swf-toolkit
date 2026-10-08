/**
 * Higher-level navigation over an ABC file: classes, their methods, and
 * human-readable method descriptions.
 */
import type { AbcFile, Trait } from './abc-file.js';
import { decodeCode } from './code.js';
import { TraitKind } from './constants.js';
import { Op } from './opcodes.js';

export type MethodRole =
  | 'script-init'
  | 'class-init'
  | 'constructor'
  | 'method'
  | 'getter'
  | 'setter'
  | 'function'
  | 'closure';

export interface MethodRef {
  methodIndex: number;
  role: MethodRole;
  /** Trait / method name ("" for initialisers and anonymous closures). */
  name: string;
  isStatic: boolean;
  trait?: Trait;
}

const ROLE_BY_TRAIT: Record<number, MethodRole> = {
  [TraitKind.Method]: 'method',
  [TraitKind.Getter]: 'getter',
  [TraitKind.Setter]: 'setter',
  [TraitKind.Function]: 'function',
};

function traitMethods(abc: AbcFile, traits: Trait[], isStatic: boolean): MethodRef[] {
  const out: MethodRef[] = [];
  for (const t of traits) {
    const role = ROLE_BY_TRAIT[t.kind];
    if (role) out.push({ methodIndex: t.method, role, name: abc.multinameName(t.name), isStatic, trait: t });
  }
  return out;
}

/** Methods created with `newfunction` inside the given methods (recursively). */
export function closuresOf(abc: AbcFile, methodIndices: Iterable<number>): number[] {
  const seen = new Set<number>(methodIndices);
  const queue = [...seen];
  const found: number[] = [];
  while (queue.length) {
    const m = queue.pop()!;
    const body = abc.methodBody(m);
    if (!body) continue;
    let items;
    try {
      items = decodeCode(body.code, body.exceptions).items;
    } catch {
      continue;
    }
    for (const it of items) {
      if (it.type === 'op' && it.op === Op.newfunction) {
        const f = it.args[0]!;
        if (!seen.has(f)) {
          seen.add(f);
          found.push(f);
          queue.push(f);
        }
      }
    }
  }
  return found;
}

/** Script index whose traits define class `classIndex` (-1 if none). */
export function scriptOfClass(abc: AbcFile, classIndex: number): number {
  for (let s = 0; s < abc.scripts.length; s++) {
    if (abc.scripts[s]!.traits.some((t) => t.kind === TraitKind.Class && t.classIndex === classIndex)) return s;
  }
  return -1;
}

/**
 * All methods belonging to a class: static initialiser, constructor, static
 * and instance methods/accessors and the closures they create.
 */
export function classMethods(abc: AbcFile, classIndex: number, includeClosures = true): MethodRef[] {
  const inst = abc.instances[classIndex];
  const cls = abc.classes[classIndex];
  if (!inst || !cls) throw new Error(`Class index ${classIndex} out of range`);
  const refs: MethodRef[] = [
    { methodIndex: cls.cinit, role: 'class-init', name: '', isStatic: true },
    { methodIndex: inst.iinit, role: 'constructor', name: abc.multinameName(inst.name), isStatic: false },
    ...traitMethods(abc, cls.traits, true),
    ...traitMethods(abc, inst.traits, false),
  ];
  if (includeClosures) {
    for (const m of closuresOf(abc, refs.map((r) => r.methodIndex))) refs.push({ methodIndex: m, role: 'closure', name: abc.strings[abc.methods[m]?.name ?? 0] ?? '', isStatic: false });
  }
  return refs;
}

/** Methods of a script: its initialiser plus package-level functions. */
export function scriptMethods(abc: AbcFile, scriptIndex: number, includeClosures = true): MethodRef[] {
  const s = abc.scripts[scriptIndex];
  if (!s) throw new Error(`Script index ${scriptIndex} out of range`);
  const refs: MethodRef[] = [{ methodIndex: s.init, role: 'script-init', name: '', isStatic: true }, ...traitMethods(abc, s.traits, true)];
  if (includeClosures) {
    for (const m of closuresOf(abc, refs.map((r) => r.methodIndex))) refs.push({ methodIndex: m, role: 'closure', name: abc.strings[abc.methods[m]?.name ?? 0] ?? '', isStatic: true });
  }
  return refs;
}

export interface FindMethodOptions {
  /** Restrict to static (true) or instance (false) members. */
  isStatic?: boolean;
  role?: MethodRole;
}

/**
 * Finds a method of a class by name. Use the class's own name (or
 * "constructor") for the constructor and "cinit" for the static initialiser.
 * Returns the method index or -1.
 */
export function findMethod(abc: AbcFile, className: string, methodName: string, options: FindMethodOptions = {}): number {
  const ci = abc.findClass(className);
  if (ci < 0) return -1;
  const refs = classMethods(abc, ci, false);
  for (const r of refs) {
    if (options.isStatic !== undefined && r.isStatic !== options.isStatic) continue;
    if (options.role !== undefined && r.role !== options.role) continue;
    if (methodName === 'constructor' && r.role === 'constructor') return r.methodIndex;
    if (methodName === 'cinit' && r.role === 'class-init') return r.methodIndex;
    if (r.role !== 'class-init' && r.name === methodName) return r.methodIndex;
  }
  return -1;
}

/** "com.foo.Bar/doThing", "com.foo.Bar/static get value", "com.foo.Bar/<cinit>", ... */
export function describeMethodRef(abc: AbcFile, owner: string, r: MethodRef): string {
  switch (r.role) {
    case 'script-init':
      return `${owner}/<script init>`;
    case 'class-init':
      return `${owner}/<cinit>`;
    case 'constructor':
      return `${owner}/<constructor>`;
    case 'closure':
      return `${owner}/<closure${r.name ? ' ' + r.name : ''}> (method ${r.methodIndex})`;
    default: {
      const prefix = (r.isStatic ? 'static ' : '') + (r.role === 'getter' ? 'get ' : r.role === 'setter' ? 'set ' : r.role === 'function' ? 'function ' : '');
      return `${owner}/${prefix}${r.name}`;
    }
  }
}

/** Finds the owner of every method (class or script) and describes it. */
export function methodOwners(abc: AbcFile): Map<number, string> {
  const map = new Map<number, string>();
  for (let c = 0; c < abc.instances.length; c++) {
    const owner = abc.className(c);
    for (const r of classMethods(abc, c)) if (!map.has(r.methodIndex)) map.set(r.methodIndex, describeMethodRef(abc, owner, r));
  }
  for (let s = 0; s < abc.scripts.length; s++) {
    for (const r of scriptMethods(abc, s)) if (!map.has(r.methodIndex)) map.set(r.methodIndex, describeMethodRef(abc, `script${s}`, r));
  }
  return map;
}
