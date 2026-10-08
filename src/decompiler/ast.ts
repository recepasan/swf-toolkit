/**
 * Small ActionScript 3 AST used by the decompiler, plus a precedence-aware printer.
 */

export type Expr =
  | { k: 'lit'; v: string | number | boolean | null | undefined }
  | { k: 'raw'; text: string }
  | { k: 'this' }
  | { k: 'super' }
  | { k: 'global' }
  | { k: 'local'; reg: number }
  | { k: 'name'; name: string }
  /** Scope object returned by findprop; only meaningful as the target of a member access. */
  | { k: 'findprop'; name: string }
  | { k: 'member'; obj: Expr; name: string; attr?: boolean; ns?: string }
  | { k: 'index'; obj: Expr; index: Expr; attr?: boolean }
  | { k: 'descendants'; obj: Expr; name: string }
  | { k: 'call'; fn: Expr; args: Expr[] }
  | { k: 'new'; ctor: Expr; args: Expr[] }
  | { k: 'unary'; op: string; e: Expr }
  | { k: 'postfix'; op: '++' | '--'; e: Expr }
  | { k: 'binary'; op: string; a: Expr; b: Expr }
  | { k: 'cond'; c: Expr; t: Expr; f: Expr }
  | { k: 'assign'; target: Expr; v: Expr; op?: string }
  | { k: 'array'; items: Expr[] }
  | { k: 'object'; props: Array<[Expr, Expr]> }
  | { k: 'function'; methodIndex: number }
  | { k: 'applytype'; base: Expr; params: Expr[] }
  | { k: 'coerce'; type: string; e: Expr }
  | { k: 'activation' }
  | { k: 'catchscope'; index: number }
  | { k: 'hasnext2'; objReg: number; idxReg: number }
  | { k: 'next'; value: boolean; obj: Expr; idx: Expr }
  | { k: 'hasnext'; obj: Expr; idx: Expr }
  | { k: 'slot'; obj: Expr; slot: number; name?: string };

export interface CatchClause {
  name: string;
  type: string;
  body: Stmt[];
}

export interface SwitchCase {
  /** null = default. */
  test: Expr | null;
  body: Stmt[];
}

export type Stmt =
  | { k: 'expr'; e: Expr }
  | { k: 'var'; name: string; type?: string; init?: Expr }
  | { k: 'return'; e?: Expr }
  | { k: 'throw'; e: Expr }
  | { k: 'if'; c: Expr; then: Stmt[]; else?: Stmt[] }
  | { k: 'while'; c: Expr; body: Stmt[]; label?: string }
  | { k: 'dowhile'; c: Expr; body: Stmt[]; label?: string }
  | { k: 'for'; init?: Stmt; c?: Expr; update?: Expr; body: Stmt[]; label?: string }
  | { k: 'forin'; each: boolean; target: Expr; declare?: { name: string; type?: string }; obj: Expr; body: Stmt[]; label?: string }
  | { k: 'switch'; disc: Expr; cases: SwitchCase[]; label?: string }
  | { k: 'try'; body: Stmt[]; catches: CatchClause[]; finally?: Stmt[] }
  | { k: 'break'; label?: string }
  | { k: 'continue'; label?: string }
  | { k: 'with'; obj: Expr; body: Stmt[] }
  | { k: 'comment'; text: string }
  | { k: 'block'; body: Stmt[] };

// ---------------------------------------------------------------------------
// Constructors / helpers
// ---------------------------------------------------------------------------

export const lit = (v: string | number | boolean | null | undefined): Expr => ({ k: 'lit', v });
export const raw = (text: string): Expr => ({ k: 'raw', text });

/** Logical negation with simplification of comparisons and double negation. */
export function not(e: Expr): Expr {
  if (e.k === 'unary' && e.op === '!') return e.e;
  if (e.k === 'binary') {
    const inv: Record<string, string> = { '==': '!=', '!=': '==', '===': '!==', '!==': '===' };
    const o = inv[e.op];
    if (o) return { ...e, op: o };
  }
  if (e.k === 'lit' && typeof e.v === 'boolean') return lit(!e.v);
  return { k: 'unary', op: '!', e };
}

export function stripCoerce(e: Expr): Expr {
  while (e.k === 'coerce') e = e.e;
  return e;
}

/** True when evaluating `e` can have side effects (so it must not be dropped or duplicated). */
export function hasSideEffects(e: Expr): boolean {
  switch (e.k) {
    case 'call':
    case 'new':
    case 'assign':
    case 'postfix':
    case 'function':
      return e.k !== 'function';
    case 'unary':
      return e.op === 'delete' || e.op === '++' || e.op === '--' || hasSideEffects(e.e);
    case 'member':
      return hasSideEffects(e.obj);
    case 'index':
      return hasSideEffects(e.obj) || hasSideEffects(e.index);
    case 'binary':
      return hasSideEffects(e.a) || hasSideEffects(e.b);
    case 'cond':
      return hasSideEffects(e.c) || hasSideEffects(e.t) || hasSideEffects(e.f);
    case 'coerce':
      return hasSideEffects(e.e);
    case 'array':
      return e.items.some(hasSideEffects);
    case 'object':
      return e.props.some(([a, b]) => hasSideEffects(a) || hasSideEffects(b));
    default:
      return false;
  }
}

/** Structural equality ignoring implicit coercions (used to detect `x = x + 1` → `x++` etc.). */
export function exprEquals(a: Expr, b: Expr): boolean {
  const canon = (e: Expr): string =>
    JSON.stringify(e, (_k, v: unknown) => {
      let x = v as { k?: string; e?: unknown };
      while (x && typeof x === 'object' && x.k === 'coerce') x = x.e as typeof x;
      return x;
    });
  return canon(a) === canon(b);
}

export function readsLocal(e: Expr, reg: number): boolean {
  let found = false;
  walkExpr(e, (x) => {
    if (x.k === 'local' && x.reg === reg) found = true;
  });
  return found;
}

export function walkExpr(e: Expr, f: (e: Expr) => void): void {
  f(e);
  switch (e.k) {
    case 'member':
    case 'descendants':
      walkExpr(e.obj, f);
      break;
    case 'index':
      walkExpr(e.obj, f);
      walkExpr(e.index, f);
      break;
    case 'call':
      walkExpr(e.fn, f);
      e.args.forEach((x) => walkExpr(x, f));
      break;
    case 'new':
      walkExpr(e.ctor, f);
      e.args.forEach((x) => walkExpr(x, f));
      break;
    case 'unary':
    case 'postfix':
    case 'coerce':
      walkExpr(e.e, f);
      break;
    case 'binary':
      walkExpr(e.a, f);
      walkExpr(e.b, f);
      break;
    case 'cond':
      walkExpr(e.c, f);
      walkExpr(e.t, f);
      walkExpr(e.f, f);
      break;
    case 'assign':
      walkExpr(e.target, f);
      walkExpr(e.v, f);
      break;
    case 'array':
      e.items.forEach((x) => walkExpr(x, f));
      break;
    case 'object':
      e.props.forEach(([a, b]) => {
        walkExpr(a, f);
        walkExpr(b, f);
      });
      break;
    case 'applytype':
      walkExpr(e.base, f);
      e.params.forEach((x) => walkExpr(x, f));
      break;
    case 'next':
    case 'hasnext':
      walkExpr(e.obj, f);
      walkExpr(e.idx, f);
      break;
    case 'slot':
      walkExpr(e.obj, f);
      break;
  }
}

/** Visits every statement list recursively (pre-order). */
export function walkStmts(list: Stmt[], f: (s: Stmt, list: Stmt[], index: number) => void): void {
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    f(s, list, i);
    for (const child of childLists(s)) walkStmts(child, f);
  }
}

export function childLists(s: Stmt): Stmt[][] {
  switch (s.k) {
    case 'if':
      return s.else ? [s.then, s.else] : [s.then];
    case 'while':
    case 'dowhile':
    case 'for':
    case 'forin':
    case 'with':
    case 'block':
      return [s.body];
    case 'switch':
      return s.cases.map((c) => c.body);
    case 'try':
      return [s.body, ...s.catches.map((c) => c.body), ...(s.finally ? [s.finally] : [])];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------

const BINARY_PREC: Record<string, number> = {
  ',': 0,
  '||': 3,
  '&&': 4,
  '|': 5,
  '^': 6,
  '&': 7,
  '==': 8,
  '!=': 8,
  '===': 8,
  '!==': 8,
  '<': 9,
  '>': 9,
  '<=': 9,
  '>=': 9,
  instanceof: 9,
  is: 9,
  as: 9,
  in: 9,
  '<<': 10,
  '>>': 10,
  '>>>': 10,
  '+': 11,
  '-': 11,
  '*': 12,
  '/': 12,
  '%': 12,
};

export interface PrintContext {
  localName(reg: number): string;
  /** Renders a closure (newfunction) body. */
  functionExpr(methodIndex: number, indent: string): string;
  indentUnit: string;
}

function precOf(e: Expr): number {
  switch (e.k) {
    case 'assign':
      return 1;
    case 'cond':
      return 2;
    case 'binary':
      return BINARY_PREC[e.op] ?? 9;
    case 'unary':
      return 13;
    case 'postfix':
      return 14;
    case 'new':
      return 15;
    case 'call':
    case 'member':
    case 'index':
    case 'descendants':
    case 'applytype':
      return 16;
    case 'coerce':
      return precOf(e.e);
    case 'function':
      return 0;
    default:
      return 17;
  }
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function formatNumber(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (Object.is(v, -0)) return '-0';
  return String(v);
}

export class Printer {
  constructor(readonly ctx: PrintContext) {}

  expr(e: Expr, minPrec = 0, indent = ''): string {
    const s = this.exprInner(e, indent);
    return precOf(e) < minPrec ? `(${s})` : s;
  }

  private member(obj: Expr, indent: string): string {
    if (obj.k === 'new') return `(${this.expr(obj, 0, indent)})`;
    return this.expr(obj, 16, indent);
  }

  private exprInner(e: Expr, indent: string): string {
    switch (e.k) {
      case 'lit':
        if (typeof e.v === 'string') return JSON.stringify(e.v);
        if (typeof e.v === 'number') return formatNumber(e.v);
        if (e.v === undefined) return 'undefined';
        return String(e.v);
      case 'raw':
        return e.text;
      case 'this':
        return 'this';
      case 'super':
        return 'super';
      case 'global':
        return 'global';
      case 'local':
        return this.ctx.localName(e.reg);
      case 'name':
        return e.name;
      case 'findprop':
        return e.name;
      case 'member': {
        if (e.obj.k === 'findprop' || e.obj.k === 'global' || e.obj.k === 'activation' || e.obj.k === 'catchscope') return (e.attr ? '@' : '') + e.name;
        const nsPart = e.ns ? `${e.ns}::` : '';
        if (!e.attr && !nsPart && !IDENT_RE.test(e.name)) return `${this.member(e.obj, indent)}[${JSON.stringify(e.name)}]`;
        return `${this.member(e.obj, indent)}.${e.attr ? '@' : ''}${nsPart}${e.name}`;
      }
      case 'index':
        return `${this.member(e.obj, indent)}${e.attr ? '.@' : ''}[${this.expr(e.index, 0, indent)}]`;
      case 'descendants':
        return `${this.member(e.obj, indent)}..${e.name}`;
      case 'call':
        return `${this.expr(e.fn, 16, indent)}(${e.args.map((a) => this.expr(a, 2, indent)).join(', ')})`;
      case 'new': {
        const ctor = e.ctor.k === 'call' ? `(${this.expr(e.ctor, 0, indent)})` : this.expr(e.ctor, 16, indent);
        return `new ${ctor}(${e.args.map((a) => this.expr(a, 2, indent)).join(', ')})`;
      }
      case 'unary': {
        const word = /^[a-z]/.test(e.op);
        const inner = this.expr(e.e, 13, indent);
        // Avoid "- -x" / "!-x" ambiguities.
        return word ? `${e.op} ${inner}` : e.op === '-' && inner.startsWith('-') ? `-(${inner})` : `${e.op}${inner}`;
      }
      case 'postfix':
        return `${this.expr(e.e, 14, indent)}${e.op}`;
      case 'binary': {
        const p = BINARY_PREC[e.op] ?? 9;
        if (e.op === ',') return `${this.expr(e.a, 1, indent)}, ${this.expr(e.b, 1, indent)}`;
        return `${this.expr(e.a, p, indent)} ${e.op} ${this.expr(e.b, p + 1, indent)}`;
      }
      case 'cond':
        return `${this.expr(e.c, 3, indent)} ? ${this.expr(e.t, 2, indent)} : ${this.expr(e.f, 2, indent)}`;
      case 'assign':
        return `${this.expr(e.target, 16, indent)} ${e.op ?? ''}= ${this.expr(e.v, 1, indent)}`;
      case 'array':
        return `[${e.items.map((a) => this.expr(a, 2, indent)).join(', ')}]`;
      case 'object':
        if (e.props.length === 0) return '{}';
        return `{${e.props
          .map(([k, v]) => {
            const key = k.k === 'lit' && typeof k.v === 'string' && IDENT_RE.test(k.v) ? k.v : this.expr(k, 17, indent);
            return `${key}: ${this.expr(v, 2, indent)}`;
          })
          .join(', ')}}`;
      case 'function':
        return this.ctx.functionExpr(e.methodIndex, indent);
      case 'applytype':
        return `${this.expr(e.base, 16, indent)}.<${e.params.map((p) => this.expr(p, 0, indent)).join(', ')}>`;
      case 'coerce':
        return this.exprInner(e.e, indent);
      case 'activation':
        return '/*activation*/';
      case 'catchscope':
        return '/*catch*/';
      case 'hasnext2':
        return `hasnext2(${this.ctx.localName(e.objReg)}, ${this.ctx.localName(e.idxReg)})`;
      case 'next':
        return `${e.value ? 'nextvalue' : 'nextname'}(${this.expr(e.obj, 0, indent)}, ${this.expr(e.idx, 0, indent)})`;
      case 'hasnext':
        return `hasnext(${this.expr(e.obj, 0, indent)}, ${this.expr(e.idx, 0, indent)})`;
      case 'slot':
        return e.name ?? `${this.member(e.obj, indent)}./*slot ${e.slot}*/`;
    }
  }

  stmts(list: Stmt[], indent: string): string[] {
    const out: string[] = [];
    for (const s of list) out.push(...this.stmt(s, indent));
    return out;
  }

  private block(body: Stmt[], indent: string): string[] {
    return [`${indent}{`, ...this.stmts(body, indent + this.ctx.indentUnit), `${indent}}`];
  }

  private labelPrefix(label: string | undefined, indent: string, out: string[]): void {
    if (label) out.push(`${indent}${label}:`);
  }

  stmt(s: Stmt, indent: string): string[] {
    const I = indent;
    const out: string[] = [];
    switch (s.k) {
      case 'expr':
        out.push(`${I}${this.expr(s.e, 0, I)};`);
        break;
      case 'var':
        out.push(`${I}var ${s.name}${s.type ? ':' + s.type : ''}${s.init ? ' = ' + this.expr(s.init, 1, I) : ''};`);
        break;
      case 'return':
        out.push(s.e ? `${I}return ${this.expr(s.e, 0, I)};` : `${I}return;`);
        break;
      case 'throw':
        out.push(`${I}throw ${this.expr(s.e, 0, I)};`);
        break;
      case 'if': {
        out.push(`${I}if(${this.expr(s.c, 0, I)})`, ...this.block(s.then, I));
        let els = s.else;
        while (els && els.length) {
          const only = els.length === 1 ? els[0]! : undefined;
          if (only && only.k === 'if') {
            out.push(`${I}else if(${this.expr(only.c, 0, I)})`, ...this.block(only.then, I));
            els = only.else;
          } else {
            out.push(`${I}else`, ...this.block(els, I));
            break;
          }
        }
        break;
      }
      case 'while':
        this.labelPrefix(s.label, I, out);
        out.push(`${I}while(${this.expr(s.c, 0, I)})`, ...this.block(s.body, I));
        break;
      case 'dowhile':
        this.labelPrefix(s.label, I, out);
        out.push(`${I}do`, ...this.block(s.body, I), `${I}while(${this.expr(s.c, 0, I)});`);
        break;
      case 'for': {
        this.labelPrefix(s.label, I, out);
        const init = s.init ? this.stmt(s.init, '')[0]!.replace(/;$/, '') : '';
        out.push(`${I}for(${init}; ${s.c ? this.expr(s.c, 0, I) : ''}; ${s.update ? this.expr(s.update, 0, I) : ''})`, ...this.block(s.body, I));
        break;
      }
      case 'forin': {
        this.labelPrefix(s.label, I, out);
        const target = s.declare ? `var ${s.declare.name}${s.declare.type ? ':' + s.declare.type : ''}` : this.expr(s.target, 0, I);
        out.push(`${I}for${s.each ? ' each' : ''}(${target} in ${this.expr(s.obj, 0, I)})`, ...this.block(s.body, I));
        break;
      }
      case 'switch': {
        this.labelPrefix(s.label, I, out);
        out.push(`${I}switch(${this.expr(s.disc, 0, I)})`, `${I}{`);
        const I2 = I + this.ctx.indentUnit;
        for (const c of s.cases) {
          out.push(c.test ? `${I2}case ${this.expr(c.test, 0, I2)}:` : `${I2}default:`);
          out.push(...this.stmts(c.body, I2 + this.ctx.indentUnit));
        }
        out.push(`${I}}`);
        break;
      }
      case 'try':
        out.push(`${I}try`, ...this.block(s.body, I));
        for (const c of s.catches) out.push(`${I}catch(${c.name}:${c.type})`, ...this.block(c.body, I));
        if (s.finally) out.push(`${I}finally`, ...this.block(s.finally, I));
        break;
      case 'break':
        out.push(`${I}break${s.label ? ' ' + s.label : ''};`);
        break;
      case 'continue':
        out.push(`${I}continue${s.label ? ' ' + s.label : ''};`);
        break;
      case 'with':
        out.push(`${I}with(${this.expr(s.obj, 0, I)})`, ...this.block(s.body, I));
        break;
      case 'comment':
        for (const line of s.text.split('\n')) out.push(`${I}// ${line}`);
        break;
      case 'block':
        out.push(...this.block(s.body, I));
        break;
    }
    return out;
  }
}
