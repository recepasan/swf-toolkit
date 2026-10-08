/**
 * Compiles an edited AS3 class back into an existing ABC.
 *
 * Only members whose source text changed compared with a baseline (by
 * default the decompiled text of the current bytecode) are recompiled; all
 * other methods keep their original bytecode.
 */
import type { AbcFile, Trait } from '../abc/abc-file.js';
import { newTrait } from '../abc/abc-file.js';
import { InstanceFlags, NamespaceKind, TraitAttr, TraitKind } from '../abc/constants.js';
import { decodeCode, encodeCode, insn, type CodeItem, type Instruction } from '../abc/code.js';
import { computeLimits } from '../abc/analysis.js';
import { Interner } from '../abc/interner.js';
import { Op } from '../abc/opcodes.js';
import { decompileClass } from '../decompiler/class-printer.js';
import type { ClassDef, CompilationUnit, Expr, FieldMember, FunctionDef, Member, MethodMember, Stmt } from './ast.js';
import { FunctionCompiler, type ClassScope } from './codegen.js';
import { CompileError, tokenize } from './lexer.js';
import { parseAs3 } from './parser.js';
import { buildClassScope, memberNamespace } from './scope.js';

export interface CompileClassOptions {
  /** File name used in error messages. */
  source?: string;
  /**
   * Baseline source the edit started from. Members identical to the baseline
   * are not recompiled. Defaults to the decompiled class; pass `null` to
   * recompile every member.
   */
  baseline?: string | null;
  /** Reuse an interner across calls on the same ABC. */
  interner?: Interner;
  /** Exact class index to compile into (for ABCs with duplicate class names). */
  classIndex?: number;
}

export interface CompiledMember {
  className: string;
  member: string;
  action: 'replaced' | 'added';
  methodIndex?: number;
}

export interface CompileClassResult {
  changes: CompiledMember[];
}

function normalizedSpan(src: string, span: [number, number]): string {
  try {
    return tokenize(src.slice(span[0], span[1]))
      .map((t) => `${t.kind}:${t.value}${t.flags ?? ''}`)
      .join(' ');
  } catch {
    return src.slice(span[0], span[1]);
  }
}

function memberKey(m: Member): string {
  if (m.k === 'field') return `${m.isStatic ? 's' : 'i'}:field:${m.name}`;
  if (m.k === 'static') return 'static-block';
  return `${m.isStatic ? 's' : 'i'}:${m.kind}:${m.name}`;
}

const TRAIT_KIND: Record<string, number> = { method: TraitKind.Method, get: TraitKind.Getter, set: TraitKind.Setter };

function isConstant(e: Expr): boolean {
  return e.k === 'num' || e.k === 'str' || e.k === 'bool' || e.k === 'null' || e.k === 'undefined' || (e.k === 'id' && (e.name === 'NaN' || e.name === 'Infinity'));
}

/** Compiles every class in `source` into `abc`. */
export function compileClassSource(abc: AbcFile, source: string, options: CompileClassOptions = {}): CompileClassResult {
  const unit = parseAs3(source, options.source);
  const pool = options.interner ?? new Interner(abc);
  const result: CompileClassResult = { changes: [] };
  for (const cls of unit.classes) {
    const qualified = unit.package ? `${unit.package}.${cls.name}` : cls.name;
    let ci = options.classIndex !== undefined && unit.classes.length === 1 ? options.classIndex : abc.findClass(qualified);
    if (options.classIndex !== undefined && abc.className(ci) !== qualified) {
      throw new CompileError(`Class index ${ci} is ${abc.className(ci)}, not ${qualified}`, cls.pos.line, cls.pos.col, options.source);
    }
    let isNew = false;
    if (ci < 0) {
      ci = createClass(abc, pool, unit, cls, options);
      isNew = true;
      result.changes.push({ className: qualified, member: '<class>', action: 'added' });
    }
    let baselineMembers = new Map<string, string>();
    if (isNew) {
      // Everything is new; only the default constructor / cinit exist.
      baselineMembers.set('static-block', '');
    } else if (options.baseline !== null) {
      const baseText = options.baseline ?? decompileClass(abc, ci);
      try {
        const baseUnit = parseAs3(baseText);
        const baseCls = baseUnit.classes.find((c) => c.name === cls.name);
        if (baseCls) baselineMembers = memberTexts(baseText, baseCls);
      } catch {
        baselineMembers = new Map();
      }
    }
    compileIntoClass(abc, pool, unit, cls, ci, source, baselineMembers, options, result);
  }
  return result;
}

function memberTexts(src: string, cls: ClassDef): Map<string, string> {
  const map = new Map<string, string>();
  const statics: string[] = [];
  for (const m of cls.members) {
    const text = normalizedSpan(src, m.span);
    if (m.k === 'static') statics.push(text);
    else if (m.k === 'field' && m.isStatic) {
      map.set(memberKey(m), text);
      // Only non-constant initialisers run in the static initialiser.
      if (m.init && !isConstant(m.init)) statics.push(text);
    } else map.set(memberKey(m), text);
  }
  map.set('static-block', statics.join('\n'));
  return map;
}

function compileIntoClass(
  abc: AbcFile,
  pool: Interner,
  unit: CompilationUnit,
  cls: ClassDef,
  ci: number,
  src: string,
  baseline: Map<string, string>,
  options: CompileClassOptions,
  result: CompileClassResult,
): void {
  const inst = abc.instances[ci]!;
  const klass = abc.classes[ci]!;
  const className = abc.className(ci);
  const memberNames = new Set<string>();
  for (const t of [...inst.traits, ...klass.traits]) memberNames.add(abc.multinameName(t.name));
  for (const m of cls.members) if (m.k !== 'static') memberNames.add(m.name);

  const scope = buildClassScope({
    abc,
    pool,
    pkg: unit.package,
    imports: unit.imports,
    useNamespaces: unit.useNamespaces,
    classIndex: ci,
    memberNames,
    source: options.source,
  });

  const edited = memberTexts(src, cls);
  const changed = (m: Member): boolean => baseline.get(memberKey(m)) !== edited.get(memberKey(m));

  // Scope depths taken from existing bodies.
  const iinitBody = abc.methodBody(inst.iinit);
  const cinitBody = abc.methodBody(klass.cinit);
  const instanceDepth = iinitBody?.initScopeDepth ?? (cinitBody ? cinitBody.initScopeDepth + 1 : 1);
  const findTrait = (traits: Trait[], name: string, kinds: number[]): Trait | undefined =>
    traits.find((t) => kinds.includes(t.kind) && abc.multinameName(t.name) === name);

  // ---- Fields --------------------------------------------------------------
  const newInstanceInits: FieldMember[] = [];
  for (const m of cls.members) {
    if (m.k !== 'field') continue;
    const traits = m.isStatic ? klass.traits : inst.traits;
    const existing = findTrait(traits, m.name, [TraitKind.Slot, TraitKind.Const]);
    if (existing && !changed(m)) continue;
    const typeName = m.type ? scope.resolveType(m.type) : 0;
    const fc = new FunctionCompiler(scope, { params: [], pos: m.pos }, { initScopeDepth: 0 });
    const value = m.init && isConstant(m.init) ? fc.constantValue(m.init) : undefined;
    if (existing) {
      existing.typeName = typeName;
      existing.kind = m.isConst ? TraitKind.Const : TraitKind.Slot;
      existing.valueKind = value?.kind ?? 0;
      existing.valueIndex = value ? value.value || 0 : 0;
      if (value && value.value === 0 && value.kind !== 0) existing.valueIndex = value.kind;
      result.changes.push({ className, member: m.name, action: 'replaced' });
    } else {
      const ns = nsFor(scope, m.isStatic && m.access === 'protected' ? 'static protected' : m.access, inst.protectedNs, m.pos);
      const t = newTrait({ kind: m.isConst ? TraitKind.Const : TraitKind.Slot, name: pool.qname(ns, m.name), typeName });
      if (value) {
        t.valueKind = value.kind;
        t.valueIndex = value.value || value.kind;
      }
      traits.push(t);
      result.changes.push({ className, member: m.name, action: 'added' });
    }
    if (m.init && !isConstant(m.init) && !m.isStatic) newInstanceInits.push(m);
  }

  // ---- Static initialiser --------------------------------------------------
  const staticChanged = baseline.get('static-block') !== edited.get('static-block');
  if (staticChanged) {
    const body: Stmt[] = [];
    for (const m of cls.members) {
      if (m.k === 'static') body.push(...m.body);
      else if (m.k === 'field' && m.isStatic && m.init && !isConstant(m.init)) {
        body.push({ k: 'expr', pos: m.pos, e: { k: 'assign', op: '', target: { k: 'id', name: m.name, pos: m.pos }, v: m.init, pos: m.pos } });
      }
    }
    const staticConsts = new Set<string>();
    for (const t of klass.traits) if (t.kind === TraitKind.Const) staticConsts.add(abc.multinameName(t.name));
    const fc = new FunctionCompiler(scope, { params: [], body, pos: cls.pos }, {
      constTargets: staticConsts,
      methodIndex: klass.cinit,
      initScopeDepth: cinitBody?.initScopeDepth ?? Math.max(0, instanceDepth - 1),
      name: '',
    });
    fc.compile();
    result.changes.push({ className, member: '<static initializer>', action: 'replaced', methodIndex: klass.cinit });
  }

  // ---- Methods -------------------------------------------------------------
  const instanceConsts = new Set<string>();
  for (const t of inst.traits) if (t.kind === TraitKind.Const) instanceConsts.add(abc.multinameName(t.name));
  /** Instance field initialisers run at the start of the constructor, before `super()` (as ASC does). */
  const fieldInitPrologue = (f: FunctionCompiler): void => {
    for (const fld of newInstanceInits) {
      f.emit(Op.getlocal0);
      f.expr(fld.init!);
      if (fld.type) f.coerceTo(scope.resolveType(fld.type));
      f.emit(Op.initproperty, f.mn(fld.name));
    }
  };
  const compileConstructor = (fn: FunctionDef): void => {
    const fc = new FunctionCompiler(scope, fn, {
      constTargets: instanceConsts,
      methodIndex: inst.iinit,
      initScopeDepth: instanceDepth,
      name: abc.strings[abc.methods[inst.iinit]?.name ?? 0] ?? '',
      isConstructor: true,
      prologue: fieldInitPrologue,
    });
    fc.compile();
    result.changes.push({ className, member: '<constructor>', action: 'replaced', methodIndex: inst.iinit });
  };

  const hasConstructor = cls.members.some((m) => m.k === 'method' && m.kind === 'constructor');
  if (!hasConstructor && newInstanceInits.length > 0 && !cls.isInterface) {
    // No constructor in the source: synthesise the implicit one so the
    // initialisers are not lost. Only safe when the existing constructor is
    // the compiler-generated default (always true for new classes).
    if (!isDefaultConstructor(abc, inst.iinit)) {
      const f = newInstanceInits[0]!;
      throw new CompileError(
        `Field '${f.name}' has an initialiser that must run in the constructor, but the source of ${className} has no constructor ` +
          'and the existing one contains code. Add the constructor to the source.',
        f.pos.line,
        f.pos.col,
        options.source,
      );
    }
    compileConstructor({ params: [], body: [], pos: cls.pos });
  }

  for (const m of cls.members) {
    if (m.k !== 'method') continue;
    if (m.kind === 'constructor') {
      if (!changed(m) && newInstanceInits.length === 0) continue;
      compileConstructor(m.fn);
      continue;
    }
    if (!changed(m)) continue;
    // Never replace bytecode with the empty body of a method the decompiler could not handle.
    if (src.slice(m.span[0], m.span[1]).includes('// Decompilation failed') && !(m.fn.body ?? []).length) continue;
    if (cls.isInterface) {
      const kind = TRAIT_KIND[m.kind]!;
      if (findTrait(inst.traits, m.name, [kind])) continue;
      const sig = new FunctionCompiler(scope, { ...m.fn, body: undefined }, { initScopeDepth: 0, name: m.name }).method;
      const idx = abc.methods.length;
      abc.methods.push(sig);
      const ifaceNs = pool.namespace(NamespaceKind.Namespace, unit.package ? `${unit.package}:${cls.name}` : cls.name);
      inst.traits.push(newTrait({ kind, name: pool.qname(ifaceNs, m.name), method: idx }));
      result.changes.push({ className, member: describe(m), action: 'added', methodIndex: idx });
      continue;
    }
    if (m.isNative || !m.fn.body) {
      throw new CompileError(`Method ${m.name} has no body`, m.pos.line, m.pos.col, options.source);
    }
    const traits = m.isStatic ? klass.traits : inst.traits;
    const kind = TRAIT_KIND[m.kind]!;
    const existing = findTrait(traits, m.name, [kind]);
    const depthFromExisting = existing ? abc.methodBody(existing.method)?.initScopeDepth : undefined;
    const fc = new FunctionCompiler(scope, m.fn, {
      methodIndex: existing?.method,
      initScopeDepth: depthFromExisting ?? instanceDepth,
      name: m.name,
    });
    const idx = fc.compile();
    if (existing) {
      result.changes.push({ className, member: describe(m), action: 'replaced', methodIndex: idx });
    } else {
      const ns = nsFor(scope, m.isStatic && m.access === 'protected' ? 'static protected' : m.access, inst.protectedNs, m.pos);
      const t = newTrait({ kind, name: pool.qname(ns, m.name), method: idx });
      if (m.isOverride) t.attrs |= TraitAttr.Override;
      if (m.isFinal) t.attrs |= TraitAttr.Final;
      traits.push(t);
      result.changes.push({ className, member: describe(m), action: 'added', methodIndex: idx });
    }
  }
}

/**
 * True when the constructor only does `super()` (what compilers generate for
 * classes without an explicit constructor).
 */
function isDefaultConstructor(abc: AbcFile, methodIndex: number): boolean {
  const body = abc.methodBody(methodIndex);
  if (!body) return true;
  let items;
  try {
    items = decodeCode(body.code, body.exceptions).items;
  } catch {
    return false;
  }
  if (items.some((i) => i.type === 'bytes')) return false;
  const ignored = new Set([Op.label, Op.nop, Op.debug, Op.debugline, Op.debugfile, Op.kill]);
  const seq = items.filter((i): i is Instruction => i.type === 'op' && !ignored.has(i.op));
  const expected = [Op.getlocal0, Op.pushscope, Op.getlocal0, Op.constructsuper, Op.returnvoid];
  return seq.length === expected.length && seq.every((i, k) => i.op === expected[k] && (i.op !== Op.constructsuper || i.args[0] === 0));
}

function describe(m: MethodMember): string {
  return `${m.isStatic ? 'static ' : ''}${m.kind === 'get' ? 'get ' : m.kind === 'set' ? 'set ' : ''}${m.name}`;
}

function nsFor(scope: ClassScope, access: string, protectedNs: number, pos: { line: number; col: number }): number {
  if (access === 'protected' && !protectedNs) throw new CompileError('Class has no protected namespace', pos.line, pos.col, scope.source);
  try {
    return memberNamespace(scope, access);
  } catch (e) {
    throw new CompileError((e as Error).message, pos.line, pos.col, scope.source);
  }
}

// ---------------------------------------------------------------------------
// New classes
// ---------------------------------------------------------------------------

/**
 * Superclass chains (Object first) of classes extended somewhere in the ABC,
 * harvested from existing script initialisers (`getlex A; pushscope; ... newclass`).
 */
function knownChains(abc: AbcFile): Map<string, number[]> {
  const chains = new Map<string, number[]>();
  for (const s of abc.scripts) {
    const body = abc.methodBody(s.init);
    if (!body) continue;
    let items;
    try {
      items = decodeCode(body.code, body.exceptions).items;
    } catch {
      continue;
    }
    let chain: number[] = [];
    for (const it of items) {
      if (it.type !== 'op') continue;
      if (it.op === Op.getlex) chain.push(it.args[0]!);
      else if (it.op === Op.newclass) {
        // Last getlex is the base class value itself (pushed again for newclass).
        const unique = chain.filter((x, i) => i === 0 || x !== chain[i - 1]);
        if (unique.length) chains.set(abc.qualifiedName(unique[unique.length - 1]!), unique);
        const inst = abc.instances[it.args[0]!];
        if (inst) chains.set(abc.qualifiedName(inst.name), [...unique, inst.name]);
        chain = [];
      } else if (it.op === Op.popscope || it.op === Op.initproperty) chain = [];
    }
  }
  return chains;
}

function createClass(abc: AbcFile, pool: Interner, unit: CompilationUnit, cls: ClassDef, options: CompileClassOptions): number {
  const pkg = unit.package;
  const nsKind = cls.access === 'internal' ? NamespaceKind.PackageInternalNs : NamespaceKind.PackageNamespace;
  const nameMn = pool.qname(pool.namespace(nsKind, pkg), cls.name);
  const ci = abc.instances.length;
  const protectedNs = pool.namespace(NamespaceKind.ProtectedNamespace, pkg ? `${pkg}:${cls.name}` : cls.name);

  // Provisional scope (for type resolution of extends / implements).
  abc.instances.push({ name: nameMn, superName: 0, flags: 0, protectedNs
, interfaces: [], iinit: 0, traits: [] });
  abc.classes.push({ cinit: 0, traits: [] });
  const scope = buildClassScope({
    abc,
    pool,
    pkg,
    imports: unit.imports,
    useNamespaces: unit.useNamespaces,
    classIndex: ci,
    memberNames: new Set(cls.members.filter((m) => m.k !== 'static').map((m) => (m as FieldMember | MethodMember).name)),
    source: options.source,
  });

  const inst = abc.instances[ci]!;
  const klass = abc.classes[ci]!;
  if (cls.isInterface) {
    inst.flags = InstanceFlags.Interface | InstanceFlags.Sealed;
    inst.superName = 0;
    inst.protectedNs = 0;
  } else {
    inst.flags = (cls.isDynamic ? 0 : InstanceFlags.Sealed) | (cls.isFinal ? InstanceFlags.Final : 0) | InstanceFlags.ProtectedNs;
    inst.superName = cls.extends ? scope.resolveType(cls.extends) : pool.qname(pool.namespace(NamespaceKind.PackageNamespace, ''), 'Object');
  }
  inst.interfaces = cls.implements.map((t) => scope.resolveType(t));

  // Superclass chain for the script initialiser.
  const objectMn = pool.qname(pool.namespace(NamespaceKind.PackageNamespace, ''), 'Object');
  let chain: number[];
  if (cls.isInterface) chain = [];
  else {
    const known = knownChains(abc).get(abc.qualifiedName(inst.superName));
    chain = known ?? (abc.qualifiedName(inst.superName) === 'Object' ? [objectMn] : [objectMn, inst.superName]);
  }
  const n = chain.length;

  // Default constructor and static initialiser (members may replace them).
  const empty = (isCtor: boolean): FunctionCompiler =>
    new FunctionCompiler(scope, { params: [], body: [], pos: cls.pos }, { initScopeDepth: isCtor ? 3 + n : 2 + n, isConstructor: isCtor && !cls.isInterface, name: isCtor ? cls.name : '' });
  inst.iinit = cls.isInterface ? addSignatureOnly(abc, scope, cls) : empty(true).compile();
  klass.cinit = empty(false).compile();

  // Script initialiser.
  const items: CodeItem[] = [];
  const op = (code: number, ...args: number[]): void => {
    items.push(insn(code, args));
  };
  op(Op.getlocal0!);
  op(Op.pushscope!);
  op(Op.getscopeobject!, 0);
  if (cls.isInterface) op(Op.pushnull!);
  else {
    for (const c of chain) {
      op(Op.getlex!, c);
      op(Op.pushscope!);
    }
    op(Op.getlex!, inst.superName);
  }
  op(Op.newclass!, ci);
  for (let i = 0; i < n; i++) op(Op.popscope!);
  op(Op.initproperty!, nameMn);
  op(Op.returnvoid!);
  const encoded = encodeCode(items);
  const limits = computeLimits(abc, items);
  const initMethod = abc.methods.length;
  abc.methods.push({ paramTypes: [], returnType: 0, name: 0, flags: 0, optional: [], paramNames: [] });
  abc.bodies.push({
    method: initMethod,
    maxStack: limits.maxStack,
    localCount: 1,
    initScopeDepth: 1,
    maxScopeDepth: 1 + limits.maxScope,
    code: encoded.code,
    exceptions: [],
    traits: [],
  });
  // Keep the last script last: it is the entry point executed when the ABC loads.
  const script = { init: initMethod, traits: [newTrait({ kind: TraitKind.Class, name: nameMn, id: 1, classIndex: ci })] };
  abc.scripts.splice(Math.max(0, abc.scripts.length - 1), 0, script);
  return ci;
}

/** Interfaces have an iinit without a body. */
function addSignatureOnly(abc: AbcFile, scope: ClassScope, cls: ClassDef): number {
  const idx = abc.methods.length;
  abc.methods.push({ paramTypes: [], returnType: 0, name: scope.pool.string(cls.name), flags: 0, optional: [], paramNames: [] });
  return idx;
}
