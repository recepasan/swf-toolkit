/**
 * AS3 → AVM2 bytecode generation for method bodies.
 *
 * Name resolution strategy: locals and parameters are resolved statically to
 * registers (or activation slots when closures capture them). Every other
 * name is emitted as a `Multiname(name, openNamespaces)` and resolved by the
 * VM at runtime through the scope chain, exactly as the Flex compiler does
 * for names it cannot bind early. Type annotations are resolved to QNames.
 */
import type { AbcFile, MethodBody, MethodInfo, Trait } from '../abc/abc-file.js';
import { newTrait } from '../abc/abc-file.js';
import { computeLimits, minLocalCount, verifyCode } from '../abc/analysis.js';
import { encodeCode, type CodeException, type CodeItem, type Instruction } from '../abc/code.js';
import { ConstantKind, MethodFlags, MultinameKind, NamespaceKind, TraitKind } from '../abc/constants.js';
import type { Interner } from '../abc/interner.js';
import { Op } from '../abc/opcodes.js';
import type { Expr, FunctionDef, Pos, Stmt, TypeRef, VarDecl } from './ast.js';
import { CompileError } from './lexer.js';

/** Names of top-level (public, unnamed package) classes and functions of the Flash runtime. */
export const TOPLEVEL_NAMES = new Set([
  'Object', 'Class', 'Function', 'Namespace', 'QName', 'Boolean', 'Number', 'int', 'uint', 'String', 'Array', 'Vector',
  'Error', 'DefinitionError', 'EvalError', 'RangeError', 'ReferenceError', 'SecurityError', 'SyntaxError', 'TypeError',
  'URIError', 'VerifyError', 'ArgumentError', 'UninitializedError', 'Date', 'Math', 'RegExp', 'XML', 'XMLList', 'JSON',
  'void', 'trace', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'escape', 'unescape', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'isXMLName', 'NaN', 'Infinity', 'undefined',
]);

export interface ClassScope {
  abc: AbcFile;
  pool: Interner;
  /** Package of the compilation unit. */
  pkg: string;
  /** Namespace set used for unqualified / runtime names. */
  openNsSet: number;
  /** Namespace indices referenced by `ns` names (private, protected, custom...). */
  namespaceByName(name: string): number | undefined;
  /** QName / TypeName for a type annotation. */
  resolveType(t: TypeRef): number;
  /** Resolve a short or dotted name used as a value (class reference etc.); undefined = runtime lookup. */
  resolveName(name: string): number | undefined;
  source?: string;
}

interface LocalVar {
  name
: string;
  /** Register index, or -1 when stored in the activation object. */
  reg: number;
  /** Activation slot id (when reg === -1). */
  slot: number;
  type: number;
}

interface LoopTarget {
  kind: 'loop' | 'switch' | 'block';
  label?: string;
  breakLabel: number;
  /** -1 for switch / labelled blocks (no continue). */
  continueLabel: number;
}

export interface FunctionOptions {
  /** Index to replace; omitted = append a new method. */
  methodIndex?: number;
  initScopeDepth: number;
  /** Debug name stored in MethodInfo.name. */
  name?: string;
  /** Constructor: emits an implicit `super()` call when the body has none. */
  isConstructor?: boolean;
  /** Static initialiser / constructor field initialisers to run first. */
  prologue?: (fc: FunctionCompiler) => void;
  /** Names of const members that this function initialises (assignments use initproperty). */
  constTargets?: ReadonlySet<string>;
}

const isIntLiteral = (v: number): boolean => Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff && !Object.is(v, -0);

/** Compiles one function (method, accessor, constructor or closure). */
export class FunctionCompiler {
  readonly items: CodeItem[] = [];
  private nextLabelId = 0;
  private exceptions: CodeException[] = [];
  private locals = new Map<string, LocalVar>();
  private nextReg: number;
  private freeTemps: number[] = [];
  private loops: LoopTarget[] = [];
  private activationReg = -1;
  private activationTraits: Trait[] = [];
  private needsActivation: boolean;
  /** Pending label for the next loop/switch statement. */
  private pendingLabel: string | undefined;
  private scopeDepth = 0;
  readonly method: MethodInfo;

  constructor(
    readonly scope: ClassScope,
    readonly fn: FunctionDef,
    readonly options: FunctionOptions,
  ) {
    const { pool } = scope;
    this.method = {
      paramTypes: fn.params.map((p) => (p.type ? scope.resolveType(p.type) : 0)),
      returnType: fn.returnType ? scope.resolveType(fn.returnType) : 0,
      name: pool.string(options.name ?? fn.name ?? ''),
      flags: 0,
      optional: [],
      paramNames: fn.params.map((p) => pool.string(p.name)),
    };
    const firstOpt = fn.params.findIndex((p) => p.init);
    if (firstOpt >= 0) {
      for (const p of fn.params.slice(firstOpt)) {
        if (!p.init) throw this.err('Required parameter after optional parameter', fn.pos);
        this.method.optional.push(this.constantValue(p.init));
      }
    }
    if (fn.rest) this.method.flags |= MethodFlags.NEED_REST;
    this.needsActivation = containsFunction(fn.body ?? []);
    if (this.needsActivation) this.method.flags |= MethodFlags.NEED_ACTIVATION;
    if (!fn.rest && usesArguments(fn.body ?? [])) this.method.flags |= MethodFlags.NEED_ARGUMENTS;

    // Registers: 0 = this, 1..n = params, then rest/arguments.
    fn.params.forEach((p, i) => this.declare(p.name, i + 1, this.method.paramTypes[i]!));
    this.nextReg = fn.params.length + 1;
    if (fn.rest) this.declare(fn.rest.name, this.nextReg++, 0);
    else if (this.method.flags & MethodFlags.NEED_ARGUMENTS) this.declare('arguments', this.nextReg++, 0);
  }

  err(msg: string, pos?: Pos): CompileError {
    return new CompileError(msg, pos?.line ?? 0, pos?.col ?? 0, this.scope.source);
  }

  // -------------------------------------------------------------------------
  // Emission helpers
  // -------------------------------------------------------------------------

  newLabel(): number {
    return this.nextLabelId++;
  }

  place(label: number): void {
    this.items.push({ type: 'label', id: label });
    // Branch targets in AVM2 code must not be skipped by the verifier's
    // backward-branch rule; a `label` op is only needed for backward targets.
  }

  emit(op: number, ...args: number[]): void {
    this.items.push({ type: 'op', op, args, targets: [], offset: -1 } satisfies Instruction);
    if (op === Op.pushscope || op === Op.pushwith) this.scopeDepth++;
    if (op === Op.popscope) this.scopeDepth--;
  }

  jump(op: number, label: number): void {
    this.items.push({ type: 'op', op, args: [], targets: [label], offset: -1 });
  }

  private temp(): number {
    return this.freeTemps.pop() ?? this.nextReg++;
  }

  private release(reg: number): void {
    this.emit(Op.kill, reg);
    this.freeTemps.push(reg);
  }

  private getReg(r: number): void {
    if (r <= 3) this.emit(Op.getlocal0 + r);
    else this.emit(Op.getlocal, r);
  }

  private setReg(r: number): void {
    if (r <= 3) this.emit(Op.setlocal0 + r);
    else this.emit(Op.setlocal, r);
  }

  private declare(name: string, reg: number, type: number): LocalVar {
    const v: LocalVar = { name, reg, slot: 0, type };
    this.locals.set(name, v);
    return v;
  }

  // -------------------------------------------------------------------------
  // Constant pool helpers
  // -------------------------------------------------------------------------

  private get pool(): Interner {
    return this.scope.pool;
  }

  /** Runtime-resolved name: Multiname(name, open namespaces). */
  mn(name: string): number {
    return this.pool.multiname({ kind: MultinameKind.Multiname, name: this.pool.string(name), nsSet: this.scope.openNsSet });
  }

  /** Attribute multiname (`@name`). */
  private mnAttr(name: string): number {
    return this.pool.multiname({ kind: MultinameKind.MultinameA, name: this.pool.string(name === '*' ? null : name), nsSet: this.scope.openNsSet });
  }

  /** Late-bound multiname for `obj[expr]`. */
  private mnLate(attr = false): number {
    return this.pool.multiname({ kind: attr ? MultinameKind.MultinameLA : MultinameKind.MultinameL, nsSet: this.scope.openNsSet });
  }

  /** Name with an explicit namespace (`ns::name`). */
  private mnQualified(ns: string, name: string, pos: Pos): number {
    if (ns === '*') return this.pool.multiname({ kind: MultinameKind.QName, ns: 0, name: this.pool.string(name) });
    const nsIndex = this.scope.namespaceByName(ns);
    if (nsIndex === undefined) throw this.err(`Unknown namespace '${ns}'`, pos);
    return this.pool.multiname({ kind: MultinameKind.QName, ns: nsIndex, name: this.pool.string(name) });
  }

  private publicQName(name: string): number {
    return this.pool.qname(this.pool.namespace(NamespaceKind.PackageNamespace, ''), name);
  }

  /** Default value for optional parameters / slots. */
  constantValue(e: Expr): { kind: number; value: number } {
    const abc = this.scope.abc;
    switch (e.k) {
      case 'num':
        if (isIntLiteral(e.v)) return { kind: ConstantKind.Int, value: abc.int(e.v) };
        return { kind: ConstantKind.Double, value: abc.double(e.v) };
      case 'str':
        return { kind: ConstantKind.Utf8, value: this.pool.string(e.v) };
      case 'bool':
        return e.v ? { kind: ConstantKind.True, value: ConstantKind.True } : { kind: ConstantKind.False, value: ConstantKind.False };
      case 'null':
        return { kind: ConstantKind.Null, value: ConstantKind.Null };
      case 'undefined':
        return { kind: ConstantKind.Undefined, value: 0 };
      case 'id':
        if (e.name === 'NaN') return { kind: ConstantKind.Double, value: abc.double(NaN) };
        if (e.name === 'Infinity') return { kind: ConstantKind.Double, value: abc.double(Infinity) };
        break;
      case 'unary':
        if (e.op === '-' && e.e.k === 'id' && e.e.name === 'Infinity') return { kind: ConstantKind.Double, value: abc.double(-Infinity) };
        break;
    }
    throw this.err('Default value must be a compile-time constant', e.pos);
  }

  // -------------------------------------------------------------------------
  // Function compilation
  // -------------------------------------------------------------------------

  /** Compiles the function and installs it in the ABC. Returns the method index. */
  compile(): number {
    const { abc } = this.scope;
    const fn = this.fn;

    // Hoist `var` declarations and nested function declarations.
    const hoisted: VarDecl[] = [];
    collectVars(fn.body ?? [], hoisted);
    for (const d of hoisted) {
      if (!this.locals.has(d.name)) this.declare(d.name, this.nextReg++, d.type ? this.scope.resolveType(d.type) : 0);
    }

    // Move locals into the activation object when closures may capture them.
    if (this.needsActivation) {
      let slot = 1;
      for (const v of this.locals.values()) {
        v.slot = slot++;
        this.activationTraits.push(newTrait({ kind: TraitKind.Slot, name: this.publicQName(v.name), id: v.slot, typeName: v.type }));
      }
      this.activationReg = this.nextReg++;
    }

    this.emit(Op.getlocal0);
    this.emit(Op.pushscope);
    if (this.needsActivation) {
      this.emit(Op.newactivation);
      
this.emit(Op.dup);
      this.setReg(this.activationReg);
      this.emit(Op.pushscope);
      // Copy parameters (still in registers) into their slots.
      for (const v of this.locals.values()) {
        if (v.reg > 0 && v.reg <= fn.params.length + (fn.rest || this.method.flags & MethodFlags.NEED_ARGUMENTS ? 1 : 0)) {
          this.getReg(this.activationReg);
          this.getReg(v.reg);
          this.emit(Op.setslot, v.slot);
        }
      }
      for (const v of this.locals.values()) v.reg = -1;
    }

    // Typed locals start with their type's default value (ASC does the same for int/uint/Number/Boolean),
    // unless the declaration initialises them before any possible use.
    const skipDefault = new Set<string>();
    const seen = new Set<string>();
    for (const st of fn.body ?? []) {
      if (st.k === 'var') {
        for (const d of st.decls) {
          if (d.init) walkAllExprs([{ k: 'expr', e: d.init, pos: d.pos }], (x) => void (x.k === 'id' && seen.add(x.name)));
          if (d.init && !seen.has(d.name)) skipDefault.add(d.name);
          seen.add(d.name);
        }
        continue;
      }
      walkAllExprs([st], (x) => void (x.k === 'id' && seen.add(x.name)));
      if (st.k !== 'expr') break;
    }
    for (const d of hoisted) {
      const v = this.locals.get(d.name)!;
      const def = this.defaultFor(v.type);
      if (def !== undefined && !this.needsActivation && !skipDefault.has(d.name)) {
        def();
        this.setReg(v.reg);
      }
    }

    // Nested function declarations are initialised up front.
    for (const s of fn.body ?? []) {
      if (s.k === 'function') {
        this.compileClosure(s.fn);
        this.storeLocal(this.locals.get(s.fn.name!)!);
      }
    }

    this.options.prologue?.(this);

    const body = fn.body ?? [];
    if (this.options.isConstructor && !hasSuperCall(body)) {
      this.emit(Op.getlocal0);
      this.emit(Op.constructsuper, 0);
    }
    for (const s of body) this.stmt(s);
    this.emit(Op.returnvoid);

    // Encode and install.
    const issues = verifyCode(abc, this.items, this.exceptions);
    if (issues.length) {
      throw this.err(`Internal compiler error in ${this.options.name ?? fn.name ?? 'function'}: ${issues.map((i) => i.message).join('; ')}`, fn.pos);
    }
    const encoded = encodeCode(this.items, this.exceptions);
    const limits = computeLimits(abc, this.items, this.exceptions);
    const index = this.options.methodIndex ?? abc.methods.length;
    if (this.options.methodIndex === undefined) abc.methods.push(this.method);
    else abc.methods[index] = this.method;
    const mb: MethodBody = {
      method: index,
      maxStack: Math.max(1, limits.maxStack),
      localCount: Math.max(limits.registers, minLocalCount(this.method), this.nextReg),
      initScopeDepth: this.options.initScopeDepth,
      maxScopeDepth: this.options.initScopeDepth + Math.max(1, limits.maxScope),
      code: encoded.code,
      exceptions: encoded.exceptions,
      traits: this.activationTraits,
    };
    const existing = abc.bodies.findIndex((b) => b.method === index);
    if (existing >= 0) abc.bodies[existing] = mb;
    else abc.bodies.push(mb);
    return index;
  }

  /** Pushes the default value of a typed local, or returns undefined if none is needed. */
  private defaultFor(type: number): (() => void) | undefined {
    if (type === 0) return undefined;
    const name = this.scope.abc.qualifiedName(type);
    switch (name) {
      case 'int':
      case 'uint':
        return () => this.emit(Op.pushbyte, 0);
      case 'Number':
        return () => this.emit(Op.pushnan);
      case 'Boolean':
        return () => this.emit(Op.pushfalse);
      default:
        return undefined;
    }
  }

  private compileClosure(def: FunctionDef): void {
    const inner = new FunctionCompiler(this.scope, def, {
      initScopeDepth: this.options.initScopeDepth + this.scopeDepth,
      name: def.name ?? '',
    });
    const idx = inner.compile();
    this.emit(Op.newfunction, idx);
  }

  // -------------------------------------------------------------------------
  // Variables
  // -------------------------------------------------------------------------

  private lookupLocal(name: string): LocalVar | undefined {
    return this.locals.get(name);
  }

  private loadLocal(v: LocalVar): void {
    if (v.reg >= 0) this.getReg(v.reg);
    else {
      this.getReg(this.activationReg);
      this.emit(Op.getslot, v.slot);
    }
  }

  /** Stores the value on top of the stack into a local (consumes it). */
  private storeLocal(v: LocalVar): void {
    if (v.type) this.coerceTo(v.type);
    if (v.reg >= 0) this.setReg(v.reg);
    else {
      this.getReg(this.activationReg);
      this.emit(Op.swap);
      this.emit(Op.setslot, v.slot);
    }
  }

  /** Emits the coercion ASC would insert when storing into a typed location. */
  coerceTo(type: number): void {
    const name = this.scope.abc.qualifiedName(type);
    switch (name) {
      case '*':
        return;
      case 'int':
        this.emit(Op.convert_i);
        return;
      case 'uint':
        this.emit(Op.convert_u);
        return;
      case 'Number':
        this.emit(Op.convert_d);
        return;
      case 'Boolean':
        this.emit(Op.convert_b);
        return;
      case 'String':
        this.emit(Op.coerce_s);
        return;
      case 'Object':
        return;
      default:
        this.emit(Op.coerce, type);
    }
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private stmts(list: Stmt[]): void {
    for (const s of list) this.stmt(s);
  }

  stmt(s: Stmt): void {
    switch (s.k) {
      case 'empty':
      case 'function': // hoisted
        return;
      case 'expr':
        this.exprDiscard(s.e);
        return;
      case 'var':
        for (const d of s.decls) {
          if (!d.init) continue;
          this.expr(d.init);
          this.storeLocal(this.lookupLocal(d.name)!);
        }
        return;
      case 'block':
        this.stmts(s.body);
        return;
      case 'if': {
        const elseL = this.newLabel();
        this.condJump(s.c, false, elseL);
        this.stmt(s.then);
        if (s.else) {
          const endL = this.newLabel();
          this.jump(Op.jump, endL);
          this.place(elseL);
          this.stmt(s.else);
          this.place(endL);
        } else this.place(elseL);
        return;
      }
      case 'while': {
        const condL = this.newLabel();
        const bodyL = this.newLabel();
        const endL = this.newLabel();
        this.jump(Op.jump, condL);
        this.place(bodyL);
        this.emit(Op.label);
        this.loop(endL, condL, () => this.stmt(s.body));
        this.place(condL);
        this.condJump(s.c, true, bodyL);
        this.place(endL);
        return;
      }
      case 'dowhile': {
        const bodyL = this.newLabel();
        const condL = this.newLabel();
        const endL = this.newLabel();
        this.place(bodyL);
        this.emit(Op.label);
        this.loop(endL, condL, () => this.stmt(s.body));
        this.place(condL);
        this.condJump(s.c, true, bodyL);
        this.place(endL);
        return;
      }
      case 'for': {
        if (s.init) this.stmt(s.init);
        const condL = this.newLabel();
        const bodyL = this.newLabel();
        const contL = this.newLabel();
        const endL = this.newLabel();
        this.jump(Op.jump, condL);
        this.place(bodyL);
        this.emit(Op.label);
        this.loop(endL, contL, () => this.stmt(s.body));
        this.place(contL);
        if (s.update) this.exprDiscard(s.update);
        this.place(condL);
        if (s.c) this.condJump(s.c, true, bodyL);
        else this.jump(Op.jump, bodyL);
        this.place(endL);
        return;
      }
      case 'forin':
        this.forIn(s);
        return;
      case 'switch':
        this.switchStmt(s);
        return;
      case 'try':
        this.tryStmt(s);
        return;
      case 'return':
        if (s.e) {
          this.expr(s.e);
          if (this.method.returnType) this.coerceTo(this.method.returnType);
          if (this.finallyStack.length) {
            const t = this.temp();
            this.setReg(t);
            this.runFinallies(0);
            this.getReg(t);
            this.release(t);
          }
          this.emit(Op.returnvalue);
        } else {
          this.runFinallies(0);
          this.emit(Op.returnvoid);
        }
        return;
      case 'throw':
        this.expr(s.e);
        this.emit(Op.throw);
        return;
      case 'break':
      case 'continue': {
        for (let i = this.loops.length - 1; i >= 0; i--) {
          const l = this.loops[i]!;
          if (s.label !== undefined) {
            if (l.label !== s.label) continue;
          } else if (l.kind === 'block' || (s.k === 'continue' && l.kind !== 'loop')) continue;
          if (s.k === 'continue' && l.kind !== 'loop') throw this.err(`Cannot continue label '${s.label}'`, s.pos);
          this.runFinallies(i + 1);
          // Leave with / catch scopes opened inside the target loop.
          for (const sc of this.extraScopes) if (sc.depth > i) this.items.push({ type: 'op', op: Op.popscope, args: [], targets: [], offset: -1 });
          this.jump(Op.jump, s.k === 'break' ? l.breakLabel : l.continueLabel);
          return;
        }
        throw this.err(`'${s.k}' outside of a loop${s.label ? ` (label ${s.label})` : ''}`, s.pos);
      }
      case 'labeled': {
        const inner = s.body;
        if (inner.k === 'while' || inner.k === 'dowhile' || inner.k === 'for' || inner.k === 'forin' || inner.k === 'switch') {
          this.pendingLabel = s.label;
          this.stmt(inner);
        } else {
          const endL = this.newLabel();
          this.loops.push({ kind: 'block', label: s.label, breakLabel: endL, continueLabel: -1 });
          this.stmt(inner);
          this.loops.pop();
          this.place(endL);
        }
        return;
      }
      case 'with': {
        this.expr(s.obj);
        this.emit(Op.dup);
        const t = this.temp();
        this.setReg(t);
        this.emit(Op.pushwith);
        this.extraScopes.push({ depth: this.loops.length, reg: t, isWith: true });
        this.stmt(s.body);
        this.extraScopes.pop();
        this.emit(Op.popscope);
        this.release(t);
        return;
      }
      case 'dxns':
        this.expr(s.e);
        this.emit(Op.dxnslate);
        return;
    }
  }

  private loop(breakLabel: number, continueLabel: number, body: () => void): void {
    const label = this.pendingLabel;
    this.pendingLabel = undefined;
    this.loops.push({ kind: 'loop', label, breakLabel, continueLabel });
    body();
    this.loops.pop();
  }

  private forIn(s: Extract<Stmt, { k: 'forin' }>): void {
    const objReg = this.temp();
    const idxReg = this.temp();
    this.expr(s.obj);
    this.emit(Op.coerce_a);
    this.setReg(objReg);
    this.emit(Op.pushbyte, 0);
    this.setReg(idxReg);
    const condL = this.newLabel();
    const bodyL = this.newLabel();
    const endL = this.newLabel();
    this.jump(Op.jump, condL);
    this.place(bodyL);
    this.emit(Op.label);
    this.getReg(objReg);
    this.getReg(idxReg);
    this.emit(s.each ? Op.nextvalue : Op.nextname);
    if (s.decl) this.storeLocal(this.lookupLocal(s.decl.name)!);
    else this.storeTo(s.target!);
    this.loop(endL, condL, () => this.stmt(s.body));
    this.place(condL);
    this.emit(Op.hasnext2, objReg, idxReg);
    this.jump(Op.iftrue, bodyL);
    this.place(endL);
    this.release(idxReg);
    this.release(objReg);
  }

  /** Compiles `switch` the way ASC does: case bodies first, then a dispatcher feeding lookupswitch. */
  private switchStmt(s: Extract<Stmt, { k: 'switch' }>): void {
    // Switching on a register local needs no temporary.
    const localDisc = s.disc.k === 'id' && !s.disc.ns ? this.lookupLocal(s.disc.name) : undefined;
    const ownTemp = !(localDisc && localDisc.reg >= 0);
    const disc = ownTemp ? this.temp() : localDisc!.reg;
    if (ownTemp) {
      this.expr(s.disc);
      this.setReg(disc);
    }
    const endL = this.newLabel();
    const dispatchL = this.newLabel();
    const caseLabels = s.cases.map(() => this.newLabel());
    this.jump(Op.jump, dispatchL);
    const label = this.pendingLabel;
    this.pendingLabel = undefined;
    this.loops.push({ kind: 'switch', label, breakLabel: endL, continueLabel: -1 });
    s.cases.forEach((c, i) => {
      this.place(caseLabels[i]!);
      this.emit(Op.label);
      this.stmts(c.body);
    });
    this.loops.pop();
    this.jump(Op.jump, endL);

    // Dispatcher: compute the case index, then lookupswitch.
    this.place(dispatchL);
    const tested = s.cases.map((c, i) => ({ c, i })).filter((x) => x.c.test !== null);
    const defaultIdx = s.cases.findIndex((c) => c.test === null);
    const switchL = this.newLabel();
    tested.forEach(({ c }, k) => {
      const next = this.newLabel();
      this.expr(c.test!);
      this.getReg(disc);
      this.jump(Op.ifstrictne, next);
      this.pushNumber(k);
      this.jump(Op.jump, switchL);
      this.place(next);
    });
    this.pushNumber(tested.length);
    this.place(switchL);
    if (ownTemp) this.release(disc);
    const defaultTarget = defaultIdx >= 0 ? caseLabels[defaultIdx]! : endL;
    const targets = [defaultTarget, ...tested.map(({ i }) => caseLabels[i]!), defaultTarget];
    this.items.push({ type: 'op', op: Op.lookupswitch, args: [], targets, offset: -1 });
    this.place(endL);
  }

  private finallyStack: Array<{ body: Stmt[]; loopDepth: number }> = [];
  /** Extra scopes (with / catch) currently open: loop depth when pushed and the register holding the object. */
  private extraScopes: Array<{ depth: number; reg: number; isWith: boolean }> = [];

  /** Re-establishes the scope stack at an exception handler (the VM clears it). */
  private restoreScopes(): void {
    this.emit(Op.getlocal0);
    this.emit(Op.pushscope);
    if (this.activationReg >= 0) {
      this.getReg(this.activationReg);
      this.emit(Op.pushscope);
    }
    for (const sc of this.extraScopes) {
      this.getReg(sc.reg);
      this.emit(sc.isWith ? Op.pushwith : Op.pushscope);
    }
  }

  private tryStmt(s: Extract<Stmt, { k: 'try' }>): void {
    const fromL = this.newLabel();
    const toL = this.newLabel();
    const afterL = this.newLabel();
    const depthBefore = this.scopeDepth;
    if (s.finally) this.finallyStack.push({ body: s.finally, loopDepth: this.loops.length });

    this.place(fromL);
    this.stmts(s.body);
    this.place(toL);
    if (s.finally) this.stmts(s.finally);
    this.jump(Op.jump, afterL);

    const catchEndL = this.newLabel();
    for (const c of s.catches) {
      const handlerL = this.newLabel();
      const excType = c.type ? this.scope.resolveType(c.type) : 0;
      this.exceptions.push({ from: fromL, to: toL, target: handlerL, excType, varName: this.publicQName(c.name) });
      const excIndex = this.exceptions.length - 1;
      this.place(handlerL);
      this.scopeDepth = 0;
      this.restoreScopes();
      // ASC-style catch scope: the variable lives in a scope object so closures can see it.
      const saved = this.locals.get(c.name);
      this.locals.delete(c.name);
      const scopeReg = this.temp();
      this.emit(Op.newcatch, excIndex);
      this.emit(Op.dup);
      this.setReg(scopeReg);
      this.emit(Op.dup);
      this.emit(Op.pushscope);
      this.emit(Op.swap);
      this.emit(Op.setslot, 1);
      this.extraScopes.push({ depth: this.loops.length, reg: scopeReg, isWith: false });
      this.stmts(c.body);
      this.extraScopes.pop();
      this.emit(Op.popscope);
      if (saved) this.locals.set(c.name, saved);
      this.release(scopeReg);
      if (s.finally) this.stmts(s.finally);
      this.jump(Op.jump, afterL);
    }
    this.place(catchEndL);

    if (s.finally) {
      this.finallyStack.pop();
      // Catch-all: run the finally block and rethrow.
      const handlerL = this.newLabel();
      this.exceptions.push({ from: fromL, to: catchEndL, target: handlerL, excType: 0, varName: 0 });
      this.place(handlerL);
      this.scopeDepth = 0;
      this.restoreScopes();
      const t = this.temp();
      this.setReg(t);
      this.stmts(s.finally);
      this.getReg(t);
      this.release(t);
      this.emit(Op.throw);
    }
    this.scopeDepth = depthBefore;
    this.place(afterL);
  }

  /** Inlines pending finally blocks when control leaves them via return/break/continue. */
  private runFinallies(downToLoopDepth: number): void {
    for (let i = this.finallyStack.length - 1; i >= 0; i--) {
      const f = this.finallyStack[i]!;
      if (f.loopDepth < downToLoopDepth) break;
      // Run the block without it being active (a return inside finally must not recurse).
      this.finallyStack.splice(i, 1);
      this.stmts(f.body);
      this.finallyStack.splice(i, 0, f);
    }
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private pushNumber(v: number): void {
    if (Number.isNaN(v)) this.emit(Op.pushnan);
    else if (isIntLiteral(v) && v >= -128 && v <= 127) this.emit(Op.pushbyte, v);
    else if (isIntLiteral(v) && v >= -32768 && v <= 32767) this.emit(Op.pushshort, v);
    else if (isIntLiteral(v)) this.emit(Op.pushint, this.scope.abc.int(v));
    else if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) this.emit(Op.pushuint, this.scope.abc.uint(v));
    else this.emit(Op.pushdouble, this.scope.abc.double(v));
  }

  /** Multiname for a property access expression (member / index / descendants). */
  private propertyName(e: Expr): { mn: number; late: boolean } {
    if (e.k === 'member') {
      if (e.ns) return { mn: this.mnQualified(e.ns, e.name, e.pos), late: false };
      return { mn: e.attr ? this.mnAttr(e.name) : this.mn(e.name), late: false };
    }
    if (e.k === 'index') return { mn: this.mnLate(e.attr), late: true };
    throw this.err('Not a property reference', e.pos);
  }

  /** Name used to look up a bare identifier. */
  private identName(e: Extract<Expr, { k: 'id' }>): number {
    if (e.ns) return this.mnQualified(e.ns, e.name, e.pos);
    return this.scope.resolveName(e.name) ?? this.mn(e.name);
  }

  expr(e: Expr): void {
    switch (e.k) {
      case 'num':
        this.pushNumber(e.v);
        return;
      case 'str':
        this.emit(Op.pushstring, this.pool.string(e.v));
        return;
      case 'bool':
        this.emit(e.v ? Op.pushtrue : Op.pushfalse);
        return;
      case 'null':
        this.emit(Op.pushnull);
        return;
      case 'undefined':
        this.emit(Op.pushundefined);
        return;
      case 'regex':
        this.emit(Op.getlex, this.publicQName('RegExp'));
        this.emit(Op.pushstring, this.pool.string(e.pattern));
        this.emit(Op.pushstring, this.pool.string(e.flags));
        this.emit(Op.construct, 2);
        return;
      case 'xml':
        this.emit(Op.getlex, this.publicQName(e.text.startsWith('<>') ? 'XMLList' : 'XML'));
        this.emit(Op.pushstring, this.pool.string(e.text.startsWith('<>') ? e.text.slice(2, -3) : e.text));
        this.emit(Op.construct, 1);
        return;
      case 'this':
        this.emit(Op.getlocal0);
        return;
      case 'super':
        this.emit(Op.getlocal0);
        return;
      case 'id': {
        const local = e.ns ? undefined : this.lookupLocal(e.name);
        if (local) return this.loadLocal(local);
        if (!e.ns && e.name === 'NaN') return this.emit(Op.pushnan);
        if (!e.ns && e.name === 'Infinity') return this.emit(Op.pushdouble, this.scope.abc.double(Infinity));
        const mn = this.identName(e);
        if (e.ns) {
          this.emit(Op.findpropstrict, mn);
          this.emit(Op.getproperty, mn);
        } else this.emit(Op.getlex, mn);
        return;
      }
      case 'member':
      case 'index': {
        if (e.obj.k === 'super') {
          this.emit(Op.getlocal0);
          if (e.k === 'index') this.expr(e.index);
          this.emit(Op.getsuper, this.propertyName(e).mn);
          return;
        }
        this.expr(e.obj);
        if (e.k === 'index') this.expr(e.index);
        this.emit(Op.getproperty, this.propertyName(e).mn);
        return;
      }
      case 'descendants':
        this.expr(e.obj);
        this.emit(Op.getdescendants, e.attr ? this.mnAttr(e.name) : this.mn(e.name));
        return;
      case 'filter':
        this.filter(e);
        return;
      case 'typeapply':
        this.expr(e.base);
        for (const p of e.params) this.typeValue(p);
        this.emit(Op.applytype, e.params.length);
        return;
      case 'call':
        this.call(e, true);
        return;
      case 'new':
        this.newExpr(e);
        return;
      case 'vector': {
        this.emit(Op.getlex, this.pool.qname(this.pool.namespace(NamespaceKind.PackageNamespace, '__AS3__.vec'), 'Vector'));
        this.typeValue(e.type);
        this.emit(Op.applytype, 1);
        this.pushNumber(e.items.length);
        this.emit(Op.construct, 1);
        e.items.forEach((item, i) => {
          this.emit(Op.dup);
          this.pushNumber(i);
          this.expr(item);
          this.emit(Op.setproperty, this.mnLate());
        });
        return;
      }
      case 'unary':
        this.unary(e);
        return;
      case 'update':
        this.update(e, true);
        return;
      case 'binary':
        this.binary(e);
        return;
      case 'cond': {
        const elseL = this.newLabel();
        const endL = this.newLabel();
        this.condJump(e.c, false, elseL);
        this.expr(e.t);
        this.emit(Op.coerce_a);
        this.jump(Op.jump, endL);
        this.place(elseL);
        this.expr(e.f);
        this.emit(Op.coerce_a);
        this.place(endL);
        return;
      }
      case 'assign':
        this.assign(e, true);
        return;
      case 'array':
        for (const it of e.items) {
          if (it) this.expr(it);
          else this.emit(Op.pushundefined);
        }
        this.emit(Op.newarray, e.items.length);
        return;
      case 'object':
        for (const p of e.props) {
          this.emit(Op.pushstring, this.pool.string(String(p.key)));
          this.expr(p.value);
        }
        this.emit(Op.newobject, e.props.length);
        return;
      case 'function':
        this.compileClosure(e.fn);
        return;
      case 'comma':
        e.list.forEach((x, i) => (i < e.list.length - 1 ? this.exprDiscard(x) : this.expr(x)));
        return;
    }
  }

  /** Pushes a type as a value (for `as`, `is`, `Vector.<T>`). */
  private typeValue(t: TypeRef): void {
    if (t.name === '*') {
      this.emit(Op.pushnull);
      return;
    }
    if (t.params) {
      this.typeValue({ name: t.name, pos: t.pos });
      for (const p of t.params) this.typeValue(p);
      this.emit(Op.applytype, t.params.length);
      return;
    }
    this.emit(Op.getlex, this.scope.resolveType(t));
  }

  /** Evaluates `e` for its side effects only. */
  exprDiscard(e: Expr): void {
    switch (e.k) {
      case 'assign':
        this.assign(e, false);
        return;
      case 'update':
        this.update(e, false);
        return;
      case 'call':
        this.call(e, false);
        return;
      case 'comma':
        for (const x of e.list) this.exprDiscard(x);
        return;
      default:
        this.expr(e);
        this.emit(Op.pop);
    }
  }

  private args(list: Expr[]): void {
    for (const a of list) this.expr(a);
  }

  private call(e: Extract<Expr, { k: 'call' }>, wantValue: boolean): void {
    const fn = e.fn;
    const n = e.args.length;
    if (fn.k === 'super') {
      this.emit(Op.getlocal0);
      this.args(e.args);
      this.emit(Op.constructsuper, n);
      if (wantValue) this.emit(Op.pushundefined);
      return;
    }
    if ((fn.k === 'member' || fn.k === 'index') && fn.obj.k === 'super') {
      this.emit(Op.getlocal0);
      if (fn.k === 'index') this.expr(fn.index);
      this.args(e.args);
      this.emit(wantValue ? Op.callsuper : Op.callsupervoid, this.propertyName(fn).mn, n);
      return;
    }
    if (fn.k === 'member' || fn.k === 'index') {
      this.expr(fn.obj);
      if (fn.k === 'index') this.expr(fn.index);
      this.args(e.args);
      this.emit(wantValue ? Op.callproperty : Op.callpropvoid, this.propertyName(fn).mn, n);
      return;
    }
    if (fn.k === 'id' && !(this.lookupLocal(fn.name) && !fn.ns)) {
      const mn = this.identName(fn);
      this.emit(Op.findpropstrict, mn);
      this.args(e.args);
      this.emit(wantValue ? Op.callproperty : Op.callpropvoid, mn, n);
      return;
    }
    this.expr(fn);
    this.emit(Op.pushnull);
    this.args(e.args);
    this.emit(Op.call, n);
    if (!wantValue) this.emit(Op.pop);
  }

  private newExpr(e: Extract<Expr, { k: 'new' }>): void {
    const c = e.ctor;
    const n = e.args.length;
    if (c.k === 'id' && (c.ns || !this.lookupLocal(c.name))) {
      const mn = this.identName(c);
      this.emit(Op.findpropstrict, mn);
      this.args(e.args);
      this.emit(Op.constructprop, mn, n);
      return;
    }
    if (c.k === 'member' && c.obj.k !== 'super') {
      this.expr(c.obj);
      this.args(e.args);
      this.emit(Op.constructprop, this.propertyName(c).mn, n);
      return;
    }
    this.expr(c);
    this.args(e.args);
    this.emit(Op.construct, n);
  }

  private unary(e: Extract<Expr, { k: 'unary' }>): void {
    switch (e.op) {
      case '!':
        this.expr(e.e);
        this.emit(Op.not);
        return;
      case '-':
        this.expr(e.e);
        this.emit(Op.negate);
        return;
      case '+':
        this.expr(e.e);
        this.emit(Op.convert_d);
        return;
      case '~':
        this.expr(e.e);
        this.emit(Op.bitnot);
        return;
      case 'typeof':
        if (e.e.k === 'id' && !e.e.ns && !this.lookupLocal(e.e.name)) {
          // typeof on an undeclared name must not throw.
          const mn = this.identName(e.e);
          this.emit(Op.findproperty, mn);
          this.emit(Op.getproperty, mn);
        } else this.expr(e.e);
        this.emit(Op.typeof);
        return;
      case 'void':
        this.exprDiscard(e.e);
        this.emit(Op.pushundefined);
        return;
      case 'delete': {
        const t = e.e;
        if (t.k === 'member' || t.k === 'index') {
          this.expr(t.obj);
          if (t.k === 'index') this.expr(t.index);
          this.emit(Op.deleteproperty, this.propertyName(t).mn);
        } else if (t.k === 'id' && !this.lookupLocal(t.name)) {
          const mn = this.identName(t);
          this.emit(Op.findproperty, mn);
          this.emit(Op.deleteproperty, mn);
        } else {
          this.exprDiscard(t);
          this.emit(Op.pushtrue);
        }
        return;
      }
    }
    throw this.err(`Unsupported unary operator '${e.op}'`, e.pos);
  }

  /**
   * Generic read-modify-write on an lvalue. `compute` receives the old value on
   * the stack and must leave the new value. When `wantValue`, `resultOld`
   * selects whether the old (postfix) or new value is left on the stack.
   */
  private modify(target: Expr, compute: () => void, wantValue: boolean, resultOld: boolean): void {
    // Locals.
    if (target.k === 'id' && !target.ns && this.lookupLocal(target.name)) {
      const v = this.lookupLocal(target.name)!;
      this.loadLocal(v);
      if (resultOld) {
        this.emit(Op.convert_d);
        if (wantValue) this.emit(Op.dup);
        compute();
      } else {
        compute();
        if (wantValue) this.emit(Op.dup);
      }
      this.storeLocal(v);
      return;
    }

    // Property targets: obj [, index] evaluated once.
    let mn: number;
    let isSuper = false;
    let idxReg = -1;
    if (target.k === 'id') {
      mn = this.identName(target);
      this.emit(Op.findpropstrict, mn);
    } else if (target.k === 'member' || target.k === 'index') {
      isSuper = target.obj.k === 'super';
      // Re-evaluating trivial operands is cheaper (and decompiles better) than temporaries.
      const trivial = (x: Expr): boolean =>
        x.k === 'num' || x.k === 'str' || x.k === 'bool' || x.k === 'null' || x.k === 'this' || (x.k === 'id' && !x.ns);
      if (!isSuper && target.k === 'index' && trivial(target.obj) && trivial(target.index)) {
        const mnL = this.propertyName(target).mn;
        this.expr(target.obj);
        this.expr(target.index);
        this.expr(target.obj);
        this.expr(target.index);
        this.emit(Op.getproperty, mnL);
        let res = -1;
        const save = (): void => {
          if (!wantValue) return;
          this.emit(Op.dup);
          res = this.temp();
          this.setReg(res);
        };
        if (resultOld) {
          this.emit(Op.convert_d);
          save();
          compute();
        } else {
          compute();
          save();
        }
        this.emit(Op.setproperty, mnL);
        if (res >= 0) {
          this.getReg(res);
          this.release(res);
        }
        return;
      }
      if (isSuper) this.emit(Op.getlocal0);
      else this.expr(target.obj);
      mn = this.propertyName(target).mn;
      if (target.k === 'index') {
        this.expr(target.index);
        idxReg = this.temp();
        this.setReg(idxReg);
      }
    } else throw this.err('Invalid assignment target', target.pos);

    // Stack: obj → obj, obj [, idx] → obj, old
    this.emit(Op.dup);
    if (idxReg >= 0) this.getReg(idxReg);
    this.emit(isSuper ? Op.getsuper : Op.getproperty, mn);
    let resultReg = -1;
    const saveResult = (): void => {
      if (!wantValue) return;
      this.emit(Op.dup);
      resultReg = this.temp();
      this.setReg(resultReg);
    };
    if (resultOld) {
      this.emit(Op.convert_d);
      saveResult();
      compute();
    } else {
      compute();
      saveResult();
    }
    // Stack: obj, new → obj [, idx], new
    if (idxReg >= 0) {
      const valReg = this.temp();
      this.setReg(valReg);
      this.getReg(idxReg);
      this.getReg(valReg);
      this.release(valReg);
    }
    this.emit(isSuper ? Op.setsuper : Op.setproperty, mn);
    if (idxReg >= 0) this.release(idxReg);
    if (resultReg >= 0) {
      this.getReg(resultReg);
      this.release(resultReg);
    }
  }

  private update(e: Extract<Expr, { k: 'update' }>, wantValue: boolean): void {
    // Fast path: int local, statement position.
    if (!wantValue && e.e.k === 'id' && !e.e.ns) {
      const v = this.lookupLocal(e.e.name);
      if (v && v.reg >= 0) {
        const tn = this.scope.abc.qualifiedName(v.type);
        if (tn === 'int') this.emit(e.op === '++' ? Op.inclocal_i : Op.declocal_i, v.reg);
        else this.emit(e.op === '++' ? Op.inclocal : Op.declocal, v.reg);
        return;
      }
    }
    this.modify(e.e, () => this.emit(e.op === '++' ? Op.increment : Op.decrement), wantValue, !e.prefix);
  }

  /** Stores the value on top of the stack into an lvalue (consumes it). */
  storeTo(target: Expr): void {
    if (target.k === 'id' && !target.ns) {
      const v = this.lookupLocal(target.name);
      if (v) return this.storeLocal(v);
    }
    const t = this.temp();
    this.setReg(t);
    if (target.k === 'id') {
      const mn = this.identName(target);
      this.emit(Op.findproperty, mn);
      this.getReg(t);
      this.emit(Op.setproperty, mn);
    } else if (target.k === 'member' || target.k === 'index') {
      const isSuper = target.obj.k === 'super';
      if (isSuper) this.emit(Op.getlocal0);
      else this.expr(target.obj);
      if (target.k === 'index') this.expr(target.index);
      this.getReg(t);
      this.emit(isSuper ? Op.setsuper : Op.setproperty, this.propertyName(target).mn);
    } else throw this.err('Invalid assignment target', target.pos);
    this.release(t);
  }

  private assign(e: Extract<Expr, { k: 'assign' }>, wantValue: boolean): void {
    if (e.op) {
      if (e.op === '&&' || e.op === '||') {
        const op = e.op;
        this.modify(
          e.target,
          () => {
            const endL = this.newLabel();
            this.emit(Op.dup);
            this.jump(op === '&&' ? Op.iffalse : Op.iftrue, endL);
            this.emit(Op.pop);
            this.expr(e.v);
            this.place(endL);
          },
          wantValue,
          false,
        );
        return;
      }
      this.modify(e.target, () => {
        this.expr(e.v);
        this.emit(binaryOp(e.op));
      }, wantValue, false);
      return;
    }
    const target = e.target;
    // Simple, common forms first.
    if (target.k === 'id' && !target.ns) {
      const v = this.lookupLocal(target.name);
      if (v) {
        this.expr(e.v);
        if (wantValue) this.emit(Op.dup);
        this.storeLocal(v);
        return;
      }
      const mn = this.identName(target);
      this.emit(Op.findproperty, mn);
      this.expr(e.v);
      const t = wantValue ? this.temp() : -1;
      if (wantValue) {
        this.emit(Op.dup);
        this.setReg(t);
      }
      this.emit(this.options.constTargets?.has(target.name) ? Op.initproperty : Op.setproperty, mn);
      if (wantValue) {
        this.getReg(t);
        this.release(t);
      }
      return;
    }
    if (target.k === 'member' || target.k === 'index') {
      const isSuper = target.obj.k === 'super';
      if (isSuper) this.emit(Op.getlocal0);
      else this.expr(target.obj);
      if (target.k === 'index') this.expr(target.index);
      this.expr(e.v);
      const t = wantValue ? this.temp() : -1;
      if (wantValue) {
        this.emit(Op.dup);
        this.setReg(t);
      }
      const isInit = !isSuper && target.k === 'member' && !target.ns && target.obj.k === 'this' && this.options.constTargets?.has(target.name);
      this.emit(isSuper ? Op.setsuper : isInit ? Op.initproperty : Op.setproperty, this.propertyName(target).mn);
      if (wantValue) {
        this.getReg(t);
        this.release(t);
      }
      return;
    }
    throw this.err('Invalid assignment target', target.pos);
  }

  private binary(e: Extract<Expr, { k: 'binary' }>): void {
    if (e.op === '&&' || e.op === '||') {
      const endL = this.newLabel();
      this.expr(e.a);
      this.emit(Op.coerce_a);
      this.emit(Op.dup);
      this.jump(e.op === '&&' ? Op.iffalse : Op.iftrue, endL);
      this.emit(Op.pop);
      this.expr(e.b);
      this.emit(Op.coerce_a);
      this.place(endL);
      return;
    }
    if (e.op === 'as' || e.op === 'is') {
      this.expr(e.a);
      if (e.b.k === 'id' && e.b.name === '*') {
        if (e.op === 'is') {
          this.emit(Op.pop);
          this.emit(Op.pushtrue);
        }
        return;
      }
      this.expr(e.b);
      this.emit(e.op === 'as' ? Op.astypelate : Op.istypelate);
      return;
    }
    if (e.op === '!=' || e.op === '!==') {
      this.expr(e.a);
      this.expr(e.b);
      this.emit(e.op === '!=' ? Op.equals : Op.strictequals);
      this.emit(Op.not);
      return;
    }
    this.expr(e.a);
    this.expr(e.b);
    this.emit(binaryOp(e.op));
  }

  /** Jumps to `label` when `e` is truthy (`onTrue`) or falsy. */
  condJump(e: Expr, onTrue: boolean, label: number): void {
    if (e.k === 'unary' && e.op === '!') return this.condJump(e.e, !onTrue, label);
    if (e.k === 'binary' && (e.op === '&&' || e.op === '||')) {
      const isAnd = e.op === '&&';
      if (isAnd !== onTrue) {
        // (a && b) false → a false or b false;  (a || b) true → a true or b true
        this.condJump(e.a, onTrue, label);
        this.condJump(e.b, onTrue, label);
      } else {
        const skip = this.newLabel();
        this.condJump(e.a, !onTrue, skip);
        this.condJump(e.b, onTrue, label);
        this.place(skip);
      }
      return;
    }
    if (e.k === 'binary') {
      const cmp: Record<string, [number, number]> = {
        '==': [Op.ifeq, Op.ifne],
        '!=': [Op.ifne, Op.ifeq],
        '===': [Op.ifstricteq, Op.ifstrictne],
        '!==': [Op.ifstrictne, Op.ifstricteq],
        '<': [Op.iflt, Op.ifnlt],
        '<=': [Op.ifle, Op.ifnle],
        '>': [Op.ifgt, Op.ifngt],
        '>=': [Op.ifge, Op.ifnge],
      };
      const pair = cmp[e.op];
      if (pair) {
        this.expr(e.a);
        this.expr(e.b);
        this.jump(onTrue ? pair[0] : pair[1], label);
        return;
      }
    }
    if (e.k === 'bool') {
      if (e.v === onTrue) this.jump(Op.jump, label);
      return;
    }
    this.expr(e);
    this.jump(onTrue ? Op.iftrue : Op.iffalse, label);
  }

  /** E4X filter: `xml.(cond)`. */
  private filter(e: Extract<Expr, { k: 'filter' }>): void {
    const listReg = this.temp();
    const idxReg = this.temp();
    const resReg = this.temp();
    this.expr(e.obj);
    this.emit(Op.checkfilter);
    this.setReg(listReg);
    this.emit(Op.pushbyte, 0);
    this.setReg(idxReg);
    this.emit(Op.getlex, this.publicQName('XMLList'));
    this.emit(Op.pushstring, this.pool.string(''));
    this.emit(Op.construct, 1);
    this.setReg(resReg);
    const condL = this.newLabel();
    const bodyL = this.newLabel();
    const skipL = this.newLabel();
    this.jump(Op.jump, condL);
    this.place(bodyL);
    this.emit(Op.label);
    this.getReg(listReg);
    this.getReg(idxReg);
    this.emit(Op.nextvalue);
    this.emit(Op.dup);
    const itemReg = this.temp();
    this.setReg(itemReg);
    this.emit(Op.pushwith);
    this.condJump(e.cond, false, skipL);
    this.getReg(resReg);
    this.getReg(idxReg);
    this.getReg(itemReg);
    this.emit(Op.setproperty, this.mnLate());
    this.place(skipL);
    this.emit(Op.popscope);
    this.place(condL);
    this.emit(Op.hasnext2, listReg, idxReg);
    this.jump(Op.iftrue, bodyL);
    this.getReg(resReg);
    for (const r of [itemReg, resReg, idxReg, listReg]) this.release(r);
  }
}

function binaryOp(op: string): number {
  const map: Record<string, number> = {
    '+': Op.add!,
    '-': Op.subtract!,
    '*': Op.multiply!,
    '/': Op.divide!,
    '%': Op.modulo!,
    '<<': Op.lshift!,
    '>>': Op.rshift!,
    '>>>': Op.urshift!,
    '&': Op.bitand!,
    '|': Op.bitor!,
    '^': Op.bitxor!,
    '==': Op.equals!,
    '===': Op.strictequals!,
    '<': Op.lessthan!,
    '<=': Op.lessequals!,
    '>': Op.greaterthan!,
    '>=': Op.greaterequals!,
    instanceof: Op.instanceof!,
    in: Op.in!,
  };
  const code = map[op];
  if (code === undefined) throw new Error(`Unsupported binary operator '${op}'`);
  return code;
}

// ---------------------------------------------------------------------------
// AST queries
// ---------------------------------------------------------------------------

function forEachChildStmt(s: Stmt, f: (s: Stmt) => void): void {
  switch (s.k) {
    case 'if':
      f(s.then);
      if (s.else) f(s.else);
      break;
    case 'while':
    case 'dowhile':
    case 'labeled':
    case 'with':
      f(s.body);
      break;
    case 'for':
      if (s.init) f(s.init);
      f(s.body);
      break;
    case 'forin':
      f(s.body);
      break;
    case 'block':
      s.body.forEach(f);
      break;
    case 'switch':
      for (const c of s.cases) c.body.forEach(f);
      break;
    case 'try':
      s.body.forEach(f);
      for (const c of s.catches) c.body.forEach(f);
      s.finally?.forEach(f);
      break;
  }
}

/** Collects hoisted `var` declarations (and function declarations) of a function body. */
function collectVars(list: Stmt[], out: VarDecl[]): void {
  const visit = (s: Stmt): void => {
    if (s.k === 'var') out.push(...s.decls);
    else if (s.k === 'forin' && s.decl) out.push(s.decl);
    else if (s.k === 'function') out.push({ name: s.fn.name!, pos: s.pos, type: { name: 'Function', pos: s.pos } });
    forEachChildStmt(s, visit);
  };
  list.forEach(visit);
}

function walkAllExprs(list: Stmt[], f: (e: Expr) => boolean | void): void {
  const ex = (e: Expr | undefined | null): void => {
    if (!e) return;
    if (f(e) === false) return;
    for (const v of Object.values(e)) {
      if (Array.isArray(v)) {
        for (const x of v) {
          if (x && typeof x === 'object' && 'k' in x && 'pos' in x) ex(x as Expr);
          else if (x && typeof x === 'object' && 'value' in x) ex((x as { value: Expr }).value);
        }
      } else if (v && typeof v === 'object' && 'k' in v && 'pos' in v) ex(v as Expr);
    }
  };
  const st = (s: Stmt): void => {
    switch (s.k) {
      case 'expr':
      case 'throw':
        ex(s.e);
        break;
      case 'return':
        ex(s.e);
        break;
      case 'var':
        s.decls.forEach((d) => ex(d.init));
        break;
      case 'if':
      case 'while':
      case 'dowhile':
        ex(s.c);
        break;
      case 'for':
        ex(s.c);
        ex(s.update);
        break;
      case 'forin':
        ex(s.obj);
        ex(s.target);
        break;
      case 'switch':
        ex(s.disc);
        s.cases.forEach((c) => ex(c.test));
        break;
      case 'with':
        ex(s.obj);
        break;
      case 'dxns':
        ex(s.e);
        break;
      case 'function':
        f({ k: 'function', fn: s.fn, pos: s.pos });
        break;
    }
    forEachChildStmt(s, st);
  };
  list.forEach(st);
}

function containsFunction(list: Stmt[]): boolean {
  let found = false;
  walkAllExprs(list, (e) => {
    if (e.k === 'function') {
      found = true;
      return false;
    }
  });
  return found;
}

function usesArguments(list: Stmt[]): boolean {
  let found = false;
  walkAllExprs(list, (e) => {
    if (e.k === 'function') return false;
    if (e.k === 'id' && e.name === 'arguments') found = true;
  });
  return found;
}

function hasSuperCall(list: Stmt[]): boolean {
  let found = false;
  walkAllExprs(list, (e) => {
    if (e.k === 'function') return false;
    if (e.k === 'call' && e.fn.k === 'super') found = true;
  });
  return found;
}
