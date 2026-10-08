/**
 * Method-level decompilation: bytecode → structured AS3 statements → text.
 */
import type { AbcFile, MethodInfo, Trait } from '../abc/abc-file.js';
import { decodeCode } from '../abc/code.js';
import { MethodFlags, MultinameKind, NamespaceKind } from '../abc/constants.js';
import { disassembleMethod } from '../abc/pcode/disassembler.js';
import { childLists, exprEquals, not, Printer, stripCoerce, walkStmts, type Expr, type Stmt } from './ast.js';
import { buildCfg } from './cfg.js';
import type { MethodContext } from './simulate.js';
import { Structurer } from './structure.js';

export interface DecompileEnv {
  abc: AbcFile;
  /** Instance traits (for getslot on `this`). */
  thisTraits?: Trait[];
  /** Script traits (for getglobalslot). */
  globalTraits?: Trait[];
  /** Fully qualified names referenced by the code (filled in). */
  imports?: Set<string>;
  /** Package of the class being decompiled (no import needed for it). */
  currentPackage?: string;
  indentUnit?: string;
}

/** Short type name for a multiname; records an import when needed. */
export function typeNameOf(env: DecompileEnv, mn: number): string {
  const { abc } = env;
  if (mn === 0) return '*';
  const m = abc.multinames[mn];
  if (!m) return '*';
  if (m.kind === MultinameKind.TypeName) {
    return `${typeNameOf(env, m.base)}.<${m.params.map((p) => typeNameOf(env, p)).join(',')}>`;
  }
  useNameOf(env, mn);
  return abc.multinameName(mn);
}

export function useNameOf(env: DecompileEnv, mn: number): void {
  const { abc } = env;
  const m = abc.multinames[mn];
  if (!m || (m.kind !== MultinameKind.QName && m.kind !== MultinameKind.QNameA)) return;
  const ns = abc.namespaces[m.ns];
  if (!ns || ns.kind !== NamespaceKind.PackageNamespace) return;
  const pkg = abc.strings[ns.name] ?? '';
  if (!pkg || pkg === env.currentPackage || pkg === '__AS3__.vec') return;
  env.imports?.add(`${pkg}.${abc.strings[m.name] ?? ''}`);
}

export function paramNames(abc: AbcFile, method: MethodInfo): string[] {
  return method.paramTypes.map((_, i) => {
    const n = method.paramNames[i];
    const s = n ? abc.strings[n] : undefined;
    return s && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : `param${i + 1}`;
  });
}

/** Parameter list text: `a:int, b:String = "x", ...rest`. */
export function formatParams(env: DecompileEnv, methodIndex: number, printer?: Printer): string {
  const { abc } = env;
  const m = abc.methods[methodIndex]!;
  const names = paramNames(abc, m);
  const firstOptional = m.paramTypes.length - m.optional.length;
  const parts = m.paramTypes.map((t, i) => {
    let s = `${names[i]}:${typeNameOf(env, t)}`;
    if (i >= firstOptional) {
      const o = m.optional[i - firstOptional]!;
      s += ` = ${formatDefault(abc, o.kind, o.value)}`;
    }
    return s;
  });
  if (m.flags & MethodFlags.NEED_REST) parts.push('...rest');
  void printer;
  return parts.join(', ');
}

/** Default value literal for optional parameters and slots. */
export function formatDefault(abc: AbcFile, kind: number, index: number): string {
  switch (kind) {
    case 0x03:
      return String(abc.ints[index] ?? 0);
    case 0x04:
      return String(abc.uints[index] ?? 0);
    case 0x06: {
      const d = abc.doubles[index] ?? NaN;
      return Number.isNaN(d) ? 'NaN' : String(d);
    }
    case 0x01:
      return JSON.stringify(abc.strings[index] ?? '');
    case 0x0b:
      return 'true';
    case 0x0a:
      return 'false';
    case 0x0c:
      return 'null';
    case 0x00:
      return 'undefined';
    default:
      return JSON.stringify(abc.strings[abc.namespaces[index]?.name ?? 0] ?? '');
  }
}

export interface DecompiledMethod {
  /** Body lines (already indented with `indent + indentUnit`), without braces. */
  lines: string[];
  /** Set when decompilation failed and P-code was emitted instead. */
  error?: string;
}

export interface DecompiledStatements {
  stmts: Stmt[];
  printer: Printer;
}

/** Decompiles a method body into lines of AS3. */
export function decompileMethodBody(env: DecompileEnv, methodIndex: number, indent: string): DecompiledMethod {
  const r = decompileMethodStatements(env, methodIndex);
  if ('error' in r) {
    const unit = env.indentUnit ?? '   ';
    const pcode = disassembleMethod(env.abc, methodIndex).trimEnd().split('\n');
    return {
      error: r.error,
      lines: [`${indent + unit}// Decompilation failed: ${r.error}`, `${indent + unit}// P-code:`, ...pcode.map((l) => `${indent + unit}// ${l}`)],
    };
  }
  if (!r.stmts.length) return { lines: [] };
  return { lines: r.printer.stmts(r.stmts, indent + (env.indentUnit ?? '   ')) };
}

/** Decompiles a method body to statements plus a printer bound to its local names. */
export function decompileMethodStatements(env: DecompileEnv, methodIndex: number): DecompiledStatements | { error: string } {
  const { abc } = env;
  const unit = env.indentUnit ?? '   ';
  const method = abc.methods[methodIndex];
  const body = abc.methodBody(methodIndex);
  if (!method || !body) return { stmts: [], printer: new Printer({ localName: (r) => `_loc${r}_`, indentUnit: unit, functionExpr: () => 'function(){}' }) };
  const names = paramNames(abc, method);
  const nParams = method.paramTypes.length;

  const ctx: MethodContext = {
    abc,
    methodIndex,
    regNames: new Map(),
    specialRegs: new Map(),
    activationTraits: body.traits,
    thisTraits: env.thisTraits ?? [],
    globalTraits: env.globalTraits ?? [],
    catchNames: new Map(),
    scope: [],
    typeName: (mn) => typeNameOf(env, mn),
    useName: (mn) => useNameOf(env, mn),
  };

  try {
    const decoded = decodeCode(body.code, body.exceptions);
    const cfg = buildCfg(abc, decoded.items, decoded.exceptions);
    let stmts = new Structurer(ctx, cfg).run();
    stmts = postProcess(stmts, nParams + (method.flags & (MethodFlags.NEED_REST | MethodFlags.NEED_ARGUMENTS) ? 1 : 0), (reg) => localName(reg));

    function localName(reg: number): string {
      if (reg === 0) return 'this';
      if (reg <= nParams) return names[reg - 1]!;
      if (reg === nParams + 1 && method!.flags & MethodFlags.NEED_REST) return 'rest';
      if (reg === nParams + 1 && method!.flags & MethodFlags.NEED_ARGUMENTS) return 'arguments';
      const dbg = ctx.regNames.get(reg);
      if (dbg && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(dbg)) return dbg;
      return `_loc${reg}_`;
    }

    const printer = new Printer({
      localName,
      indentUnit: unit,
      functionExpr: (mi, ind) => {
        const inner = decompileMethodBody(env, mi, ind);
        const m = abc.methods[mi]!;
        const ret = typeNameOf(env, m.returnType);
        return [`function(${formatParams(env, mi)}):${ret}`, `${ind}{`, ...inner.lines, `${ind}}`].join('\n');
      },
    });
    // Resolve `var` declarations now that names are known.
    removeSelfAssignments(stmts, localName);
    declareLocals(stmts, nParams + (method.flags & (MethodFlags.NEED_REST | MethodFlags.NEED_ARGUMENTS) ? 1 : 0), localName);
    // Variables living in the activation object (captured by closures) are declared up front.
    if (method.flags & MethodFlags.NEED_ACTIVATION && body.traits.length) {
      const params = new Set(names);
      if (method.flags & MethodFlags.NEED_REST) params.add('rest');
      const decls: Stmt[] = [];
      for (const t of body.traits) {
        const n = abc.multinameName(t.name);
        if (params.has(n) || t.kind !== 0) continue;
        decls.push({ k: 'var', name: n, type: t.typeName ? typeNameOf(env, t.typeName) : undefined });
      }
      stmts = [...decls, ...stmts];
    }
    return { stmts, printer };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Post-processing passes
// ---------------------------------------------------------------------------

function postProcess(stmts: Stmt[], paramRegs: number, localName: (r: number) => string): Stmt[] {
  void paramRegs;
  void localName;
  stmts = stripTrailingReturn(stmts);
  cleanLoops(stmts);
  walkStmts(stmts, (s, list, i) => {
    if (s.k === 'expr') list[i] = { k: 'expr', e: simplifyAssign(s.e) };
    if (s.k === 'for' && s.update) s.update = simplifyComma(s.update);
  });
  recoverForIn(stmts);
  whileToFor(stmts);
  mergeForInit(stmts);
  hoistElse(stmts);
  liftLoopConditions(stmts);
  return stmts;
}

/** `while(true) { if(!c) break; ... }` → `while(c) { ... }` */
function liftLoopConditions(stmts: Stmt[]): void {
  walkStmts(stmts, (s) => {
    if (s.k !== 'while' || !(s.c.k === 'lit' && s.c.v === true)) return;
    const first = s.body[0];
    if (first && first.k === 'if' && !first.else && first.then.length === 1 && first.then[0]!.k === 'break' && !(first.then[0] as { label?: string }).label) {
      s.c = not(first.c);
      s.body.shift();
    }
  });
}

function stripTrailingReturn(stmts: Stmt[]): Stmt[] {
  const last = stmts[stmts.length - 1];
  if (last && last.k === 'return' && !last.e) return stmts.slice(0, -1);
  return stmts;
}

/** Removes redundant trailing `continue` statements in loop bodies. */
function cleanLoops(stmts: Stmt[]): void {
  const stripTail = (list: Stmt[]): void => {
    for (;;) {
      const last = list[list.length - 1];
      if (!last) return;
      if (last.k === 'continue' && !last.label) {
        list.pop();
        continue;
      }
      if (last.k === 'if') {
        stripTail(last.then);
        if (last.else) stripTail(last.else);
      }
      return;
    }
  };
  walkStmts(stmts, (s) => {
    if ((s.k === 'while' || s.k === 'dowhile' || s.k === 'for' || s.k === 'forin') && s.body) stripTail(s.body);
  });
}

function endsAbruptly(list: Stmt[]): boolean {
  const last = list[list.length - 1];
  if (!last) return false;
  if (last.k === 'return' || last.k === 'throw' || last.k === 'break' || last.k === 'continue') return true;
  if (last.k === 'if' && last.else) return endsAbruptly(last.then) && endsAbruptly(last.else);
  return false;
}

/** `if(c){...return;} else {B}` → `if(c){...return;} B` */
function hoistElse(stmts: Stmt[]): void {
  const fix = (list: Stmt[]): void => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      for (const child of childLists(s)) fix(child);
      if (s.k === 'if' && s.else && s.else.length && endsAbruptly(s.then) && !(s.else.length === 1 && s.else[0]!.k === 'if')) {
        const rest = s.else;
        delete s.else;
        list.splice(i + 1, 0, ...rest);
      }
    }
  };
  fix(stmts);
}

function simplifyComma(e: Expr): Expr {
  if (e.k === 'binary' && e.op === ',') return { ...e, a: simplifyComma(e.a), b: simplifyComma(e.b) };
  return simplifyAssign(e);
}

/** `while(i < n) { ...; i++; }` (no continue) → `for(; i < n; i++) { ... }` */
function whileToFor(stmts: Stmt[]): void {
  const hasOwnContinue = (list: Stmt[]): boolean => {
    let found = false;
    const visit = (l: Stmt[]): void => {
      for (const s of l) {
        if (s.k === 'continue' && !s.label) found = true;
        if (s.k === 'while' || s.k === 'dowhile' || s.k === 'for' || s.k === 'forin') continue;
        for (const c of childLists(s)) visit(c);
      }
    };
    visit(list);
    return found;
  };
  const fix = (list: Stmt[]): void => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      for (const child of childLists(s)) fix(child);
      if (s.k !== 'while' || s.body.length < 2) continue;
      const last = s.body[s.body.length - 1]!;
      if (last.k !== 'expr') continue;
      const e = last.e;
      const target = e.k === 'postfix' ? e.e : e.k === 'assign' && e.op ? e.target : undefined;
      if (!target || target.k !== 'local' || !readsLocalAny(s.c, target.reg) || hasOwnContinue(s.body)) continue;
      list[i] = { k: 'for', c: s.c, update: e, body: s.body.slice(0, -1), label: s.label };
    }
  };
  fix(stmts);
}

/** `i = 0; for(; i < n; i++)` → `for(i = 0; i < n; i++)` */
function mergeForInit(stmts: Stmt[]): void {
  const fix = (list: Stmt[]): void => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      for (const child of childLists(s)) fix(child);
      if (s.k !== 'for' || s.init || i === 0) continue;
      const prev = list[i - 1]!;
      if (prev.k !== 'expr' || prev.e.k !== 'assign' || prev.e.op || prev.e.target.k !== 'local') continue;
      const reg = prev.e.target.reg;
      if (!s.c || !readsLocalAny(s.c, reg)) continue;
      s.init = prev;
      list.splice(i - 1, 1);
      i--;
    }
  };
  fix(stmts);
}

function readsLocalAny(e: Expr, reg: number): boolean {
  return JSON.stringify(e).includes(`"k":"local","reg":${reg}}`);
}

function simplifyAssign(e: Expr): Expr {
  if (e.k !== 'assign' || e.op) return e;
  const v = stripCoerce(e.v);
  if (v.k === 'binary' && exprEquals(v.a, e.target)) {
    if ((v.op === '+' || v.op === '-') && v.b.k === 'lit' && v.b.v === 1) return { k: 'postfix', op: v.op === '+' ? '++' : '--', e: e.target };
    if (['+', '-', '*', '/', '%', '<<', '>>', '>>>', '&', '|', '^'].includes(v.op)) return { k: 'assign', target: e.target, v: v.b, op: v.op };
  }
  return e;
}

/** while(hasnext2(o,i)) { x = nextname(o,i); ... } → for(x in obj) { ... } */
function recoverForIn(stmts: Stmt[]): void {
  const fix = (list: Stmt[]): void => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      for (const child of childLists(s)) fix(child);
      if (s.k !== 'while' || s.c.k !== 'hasnext2') continue;
      const { objReg, idxReg } = s.c;
      const first = s.body[0];
      if (!first || first.k !== 'expr' || first.e.k !== 'assign') continue;
      const v = stripCoerce(first.e.v);
      if (v.k !== 'next' || v.obj.k !== 'local' || v.obj.reg !== objReg) continue;
      // Find the initialisers of the object and index registers.
      let obj: Expr | undefined;
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        const p = list[j]!;
        if (p.k !== 'expr' || p.e.k !== 'assign' || p.e.target.k !== 'local') continue;
        if (p.e.target.reg === objReg && !obj) {
          obj = stripCoerce(p.e.v);
          list.splice(j, 1);
          i--;
        } else if (p.e.target.reg === idxReg) {
          list.splice(j, 1);
          i--;
        }
      }
      if (!obj) obj = { k: 'local', reg: objReg };
      list[i] = { k: 'forin', each: v.value, target: first.e.target, obj, body: s.body.slice(1), label: s.label };
    }
  };
  fix(stmts);
}

/** Drops `x = x` produced by activation objects copying parameters into slots. */
function removeSelfAssignments(stmts: Stmt[], localName: (r: number) => string): void {
  const fix = (list: Stmt[]): void => {
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i]!;
      for (const child of childLists(s)) fix(child);
      if (s.k === 'expr' && s.e.k === 'assign' && !s.e.op && s.e.target.k === 'name') {
        const v = stripCoerce(s.e.v);
        if (v.k === 'local' && localName(v.reg) === s.e.target.name) list.splice(i, 1);
      }
    }
  };
  fix(stmts);
}

/** Turns the first assignment of each local register into a `var` declaration. */
function declareLocals(stmts: Stmt[], paramRegs: number, localName: (r: number) => string): void {
  const declared = new Set<number>();
  const declare = (s: Stmt): Stmt => {
    if (s.k === 'expr' && s.e.k === 'assign' && !s.e.op && s.e.target.k === 'local' && s.e.target.reg > paramRegs && !declared.has(s.e.target.reg)) {
      declared.add(s.e.target.reg);
      const v = s.e.v;
      const litType = v.k === 'lit' ? (typeof v.v === 'boolean' ? 'Boolean' : typeof v.v === 'string' ? 'String' : undefined) : undefined;
      return { k: 'var', name: localName(s.e.target.reg), type: v.k === 'coerce' ? v.type : litType, init: v.k === 'coerce' ? v.e : v };
    }
    return s;
  };
  const visit = (list: Stmt[]): void => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      if (s.k === 'expr') {
        list[i] = declare(s);
      } else if (s.k === 'for' && s.init) {
        s.init = declare(s.init);
      } else if (s.k === 'forin' && s.target.k === 'local' && s.target.reg > paramRegs && !declared.has(s.target.reg)) {
        declared.add(s.target.reg);
        s.declare = { name: localName(s.target.reg) };
      }
      for (const child of childLists(s)) visit(child);
    }
  };
  visit(stmts);
}
