/**
 * Recursive-descent parser for ActionScript 3 source files.
 */
import type { CatchClause, ClassDef, CompilationUnit, Expr, FieldMember, FunctionDef, Member, Metadata, MethodMember, Param, Pos, Stmt, TypeRef, VarDecl } from './ast.js';
import { CompileError, tokenize, type Tok } from './lexer.js';

const BINARY_PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '===': 6,
  '!==': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  instanceof: 7,
  is: 7,
  as: 7,
  in: 7,
  '<<': 8,
  '>>': 8,
  '>>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=']);
const MODIFIERS = new Set(['public', 'private', 'protected', 'internal', 'static', 'override', 'final', 'native', 'dynamic', 'virtual']);

export class Parser {
  private toks: Tok[];
  private p = 0;

  constructor(
    readonly src: string,
    readonly source?: string,
  ) {
    this.toks = tokenize(src, source);
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  private get t(): Tok {
    return this.toks[this.p]!;
  }

  private peek(o = 1): Tok {
    return this.toks[Math.min(this.p + o, this.toks.length - 1)]!;
  }

  private pos(t: Tok = this.t): Pos {
    return { line: t.line, col: t.col };
  }

  private error(msg: string, t: Tok = this.t): CompileError {
    return new CompileError(msg, t.line, t.col, this.source);
  }

  private is(value: string): boolean {
    const t = this.t;
    return (t.kind === 'punct' || t.kind === 'kw') && t.value === value;
  }

  private isId(value?: string): boolean {
    return this.t.kind === 'id' && (value === undefined || this.t.value === value);
  }

  private next(): Tok {
    const t = this.t;
    if (t.kind !== 'eof') this.p++;
    return t;
  }

  private eat(value: string): boolean {
    if (this.is(value)) {
      this.p++;
      return true;
    }
    return false;
  }

  private expect(value: string): Tok {
    // Split '>>' / '>>>' when closing type parameter lists.
    if (value === '>' && this.t.kind === 'punct' && (this.t.value === '>>' || this.t.value === '>>>' || this.t.value === '>=' || this.t.value === '>>=')) {
      const t = this.t;
      const rest = t.value.slice(1);
      this.toks.splice(this.p + 1, 0, { ...t, value: rest, col: t.col + 1, start: t.start + 1, nl: false });
      this.p++;
      return { ...t, value: '>' };
    }
    if (!this.is(value)) throw this.error(`Expected '${value}' but found '${this.t.value || 'end of file'}'`);
    return this.next();
  }

  /** Identifier (keywords allowed where `allowKeyword` is set, e.g. after '.'). */
  private ident(allowKeyword = false): string {
    const t = this.t;
    if (t.kind === 'id' || (allowKeyword && t.kind === 'kw')) {
      this.p++;
      return t.value;
    }
    throw this.error(`Expected identifier but found '${t.value || 'end of file'}'`);
  }

  private semicolon(): void {
    if (this.eat(';')) return;
    if (this.is('}') || this.t.kind === 'eof' || this.t.nl) return;
    throw this.error(`Expected ';' but found '${this.t.value}'`);
  }

  // -------------------------------------------------------------------------
  // Compilation unit
  // -------------------------------------------------------------------------

  parseUnit(): CompilationUnit {
    const unit: CompilationUnit = { package: '', imports: [], useNamespaces: [], classes: [], functions: [] };
    if (this.is('package')) {
      this.next();
      if (!this.is('{')) unit.package = this.dottedName();
      this.expect('{');
      this.parseDirectives(unit, '}');
      this.expect('}');
    }
    this.parseDirectives(unit, '');
    return unit;
  }

  private dottedName(allowStar = false): string {
    let name = this.ident(true);
    while (this.is('.') ) {
      this.next();
      if (allowStar && this.eat('*')) return name + '.*';
      name += '.' + this.ident(true);
    }
    return name;
  }

  private parseDirectives(unit: CompilationUnit, end: string): void {
    while (this.t.kind !== 'eof' && !(end && this.is(end))) {
      if (this.eat(';')) continue;
      if (this.is('import')) {
        this.next();
        unit.imports.push(this.dottedName(true));
        this.semicolon();
        continue;
      }
      if (this.is('use')) {
        this.next();
        if (!this.isId('namespace') && !this.is('namespace')) throw this.error("Expected 'namespace'");
        this.next();
        unit.useNamespaces.push(this.dottedName());
        this.semicolon();
        continue;
      }
      const metadata = this.parseMetadataList();
      const mods = this.parseModifiers();
      if (this.is('class') || this.is('interface')) {
        unit.classes.push(this.parseClass(mods, metadata));
        continue;
      }
      if (this.is('function')) {
        const start = this.t.start;
        const m = this.parseMethodMember(mods, metadata, '', start);
        unit.functions.push(m);
        continue;
      }
      if (this.isId('namespace')) {
        // namespace declarations at package level: skip
        this.next();
        this.ident();
        if (this.eat('=')) this.parseAssign();
        this.semicolon();
        continue;
      }
      throw this.error(`Unexpected '${this.t.value}' at package level`);
    }
  }

  private parseMetadataList(): Metadata[] {
    const list: Metadata[] = [];
    while (this.is('[') && this.peek().kind === 'id') {
      this.next();
      const name = this.ident();
      const items: Metadata['items'] = [];
      if (this.eat('(')) {
        while (!this.is(')')) {
          if ((this.t.kind === 'id' || this.t.kind === 'kw') && this.peek().value === '=') {
            const key = this.next().value;
            this.next();
            items.push({ key, value: this.metaValue() });
          } else items.push({ value: this.metaValue() });
          if (!this.eat(',')) break;
        }
        this.expect(')');
      }
      this.expect(']');
      list.push({ name, items });
    }
    return list;
  }

  private metaValue(): string {
    const t = this.next();
    return t.value;
  }

  private parseModifiers(): string[] {
    const mods: string[] = [];
    for (;;) {
      const t = this.t;
      if ((t.kind === 'kw' || t.kind === 'id') && MODIFIERS.has(t.value)) {
        mods.push(t.value);
        this.next();
        continue;
      }
      // Custom namespace modifier: `mx_internal function ...`
      if (t.kind === 'id' && !this.peek().nl && (this.peek().value === 'function' || this.peek().value === 'var' || this.peek().value === 'const' || MODIFIERS.has(this.peek().value))) {
        mods.push(`ns:${t.value}`);
        this.next();
        continue;
      }
      return mods;
    }
  }

  private accessOf(mods: string[]): string {
    for (const m of mods) if (m === 'public' || m === 'private' || m === 'protected' || m === 'internal' || m.startsWith('ns:')) return m;
    return 'internal';
  }

  private parseType(): TypeRef {
    const pos = this.pos();
    if (this.eat('*')) return { name: '*', pos };
    if (this.is('void')) {
      this.next();
      return { name: 'void', pos };
    }
    let name = this.ident(true);
    while (this.is('.') && (this.peek().kind === 'id' || this.peek().kind === 'kw')) {
      this.next();
      name += '.' + this.ident(true);
    }
    if (this.eat('.<')) {
      const params = [this.parseType()];
      while (this.eat(',')) params.push(this.parseType());
      this.expect('>');
      return { name, params, pos };
    }
    return { name, pos };
  }

  private parseClass(mods: string[], metadata: Metadata[]): ClassDef {
    const pos = this.pos();
    const isInterface = this.next().value === 'interface';
    const name = this.ident();
    const cls: ClassDef = {
      name,
      isInterface,
      isDynamic: mods.includes('dynamic'),
      isFinal: mods.includes('final'),
      access: this.accessOf(mods),
      implements: [],
      members: [],
      metadata,
      pos,
    };
    if (this.eat('extends')) {
      if (isInterface) {
        cls.implements.push(this.parseType());
        while (this.eat(',')) cls.implements.push(this.parseType());
      } else cls.extends = this.parseType();
    }
    if (this.eat('implements')) {
      cls.implements.push(this.parseType());
      while (this.eat(',')) cls.implements.push(this.parseType());
    }
    this.expect('{');
    while (!this.is('}')) {
      if (this.t.kind === 'eof') throw this.error('Unexpected end of file in class body');
      cls.members.push(...this.parseMember(name));
    }
    this.expect('}');
    return cls;
  }

  private parseMember(className: string): Member[] {
    if (this.eat(';')) return [];
    const start = this.t.start;
    const metadata = this.parseMetadataList();
    const mods = this.parseModifiers();
    if (this.is('function')) return [this.parseMethodMember(mods, metadata, className, start)];
    if (this.is('var') || this.is('const')) {
      const isConst = this.next().value === 'const';
      const out: FieldMember[] = [];
      do {
        const pos = this.pos();
        const name = this.ident(true);
        const type = this.eat(':') ? this.parseType() : undefined;
        const init = this.eat('=') ? this.parseAssign() : undefined;
        out.push({ k: 'field', name, isStatic: mods.includes('static'), isConst, access: this.accessOf(mods), type, init, metadata, pos, span: [start, 0] });
      } while (this.eat(','));
      this.semicolon();
      for (const f of out) f.span[1] = this.toks[this.p - 1]!.end;
      return out;
    }
    if (this.is('{') && mods.length === 0) {
      const pos = this.pos();
      const body = this.parseBlock();
      return [{ k: 'static', body, pos, span: [start, this.toks[this.p - 1]!.end] }];
    }
    if (this.isId('namespace')) {
      this.next();
      this.ident();
      if (this.eat('=')) this.parseAssign();
      this.semicolon();
      return [];
    }
    // Loose statements in a class body run in the static initialiser.
    const pos = this.pos();
    const stmt = this.parseStatement();
    return [{ k: 'static', body: [stmt], pos, span: [start, this.toks[this.p - 1]!.end] }];
  }

  private parseMethodMember(mods: string[], metadata: Metadata[], className: string, start: number): MethodMember {
    const pos = this.pos();
    this.expect('function');
    let kind: MethodMember['kind'] = 'method';
    if ((this.isId('get') || this.isId('set')) && (this.peek().kind === 'id' || this.peek().kind === 'kw') && this.peek().value !== '(') {
      kind = this.next().value as 'get' | 'set';
    }
    const name = this.ident(true);
    if (name === className && kind === 'method' && !mods.includes('static')) kind = 'constructor';
    const fn = this.parseFunctionRest(name, mods.includes('native'));
    return {
      k: 'method',
      name,
      kind,
      isStatic: mods.includes('static'),
      isOverride: mods.includes('override'),
      isFinal: mods.includes('final'),
      isNative: mods.includes('native'),
      access: this.accessOf(mods),
      fn,
      metadata,
      pos,
      span: [start, this.toks[this.p - 1]!.end],
    };
  }

  /** Parses `(params):Type { body }` (body optional for interfaces / native). */
  private parseFunctionRest(name: string | undefined, noBody = false): FunctionDef {
    const pos = this.pos();
    this.expect('(');
    const params: Param[] = [];
    let rest: FunctionDef['rest'];
    while (!this.is(')')) {
      if (this.eat('...')) {
        const rname = this.ident(true);
        rest = { name: rname, type: this.eat(':') ? this.parseType() : undefined };
        break;
      }
      const pname = this.ident(true);
      const type = this.eat(':') ? this.parseType() : undefined;
      const init = this.eat('=') ? this.parseAssign() : undefined;
      params.push({ name: pname, type, init });
      if (!this.eat(',')) break;
    }
    this.expect(')');
    const returnType = this.eat(':') ? this.parseType() : undefined;
    let body: Stmt[] | undefined;
    if (this.is('{') && !noBody) body = this.parseBlock();
    else this.semicolon();
    return { name, params, rest, returnType, body, pos };
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private parseBlock(): Stmt[] {
    this.expect('{');
    const body: Stmt[] = [];
    while (!this.is('}')) {
      if (this.t.kind === 'eof') throw this.error("Expected '}'");
      body.push(this.parseStatement());
    }
    this.expect('}');
    return body;
  }

  private parseVarDecls(noIn = false): VarDecl[] {
    const decls: VarDecl[] = [];
    do {
      const pos = this.pos();
      const name = this.ident(true);
      const type = this.eat(':') ? this.parseType() : undefined;
      const init = this.eat('=') ? this.parseAssign(noIn) : undefined;
      decls.push({ name, type, init, pos });
    } while (this.eat(','));
    return decls;
  }

  parseStatement(): Stmt {
    const pos = this.pos();
    const t = this.t;
    if (t.kind === 'punct') {
      if (t.value === '{') return { k: 'block', body: this.parseBlock(), pos };
      if (t.value === ';') {
        this.next();
        return { k: 'empty', pos };
      
}
      if (t.value === '[' ) {
        // Metadata inside function bodies is ignored; otherwise an array expression.
        const save = this.p;
        if (this.peek().kind === 'id') {
          try {
            this.parseMetadataList();
            if (this.is('function') || this.is('var')) return this.parseStatement();
          } catch {
            /* not metadata */
          }
          this.p = save;
        }
      }
    }
    if (t.kind === 'kw') {
      switch (t.value) {
        case 'var':
        case 'const': {
          this.next();
          const decls = this.parseVarDecls();
          this.semicolon();
          return { k: 'var', isConst: t.value === 'const', decls, pos };
        }
        case 'function': {
          if (this.peek().kind === 'id') {
            this.next();
            const name = this.ident();
            return { k: 'function', fn: this.parseFunctionRest(name), pos };
          }
          break;
        }
        case 'if': {
          this.next();
          this.expect('(');
          const c = this.parseExpr();
          this.expect(')');
          const then = this.parseStatement();
          const els = this.eat('else') ? this.parseStatement() : undefined;
          return { k: 'if', c, then, else: els, pos };
        }
        case 'while': {
          this.next();
          this.expect('(');
          const c = this.parseExpr();
          this.expect(')');
          return { k: 'while', c, body: this.parseStatement(), pos };
        }
        case 'do': {
          this.next();
          const body = this.parseStatement();
          this.expect('while');
          this.expect('(');
          const c = this.parseExpr();
          this.expect(')');
          this.eat(';');
          return { k: 'dowhile', c, body, pos };
        }
        case 'for':
          return this.parseFor();
        case 'switch':
          return this.parseSwitch();
        case 'try':
          return this.parseTry();
        case 'return': {
          this.next();
          let e: Expr | undefined;
          if (!this.is(';') && !this.is('}') && !this.t.nl && this.t.kind !== 'eof') e = this.parseExpr();
          this.semicolon();
          return { k: 'return', e, pos };
        }
        case 'throw': {
          this.next();
          const e = this.parseExpr();
          this.semicolon();
          return { k: 'throw', e, pos };
        }
        case 'break':
        case 'continue': {
          this.next();
          let label: string | undefined;
          if (this.t.kind === 'id' && !this.t.nl) label = this.next().value;
          this.semicolon();
          return { k: t.value, label, pos };
        }
        case 'with': {
          this.next();
          this.expect('(');
          const obj = this.parseExpr();
          this.expect(')');
          return { k: 'with', obj, body: this.parseStatement(), pos };
        }
        case 'default': {
          // default xml namespace = expr
          if (this.peek().value === 'xml') {
            this.next();
            this.next();
            if (!this.isId('namespace') && !this.is('namespace')) throw this.error("Expected 'namespace'");
            this.next();
            this.expect('=');
            const e = this.parseAssign();
            this.semicolon();
            return { k: 'dxns', e, pos };
          }
          break;
        }
        case 'use': {
          this.next();
          this.next();
          this.dottedName();
          this.semicolon();
          return { k: 'empty', pos };
        }
        case 'import': {
          this.next();
          this.dottedName(true);
          this.semicolon();
          return { k: 'empty', pos };
        }
      }
    }
    if (t.kind === 'id' && this.peek().value === ':' && this.peek().kind === 'punct') {
      this.next();
      this.next();
      return { k: 'labeled', label: t.value, body: this.parseStatement(), pos };
    }
    const e = this.parseExpr();
    this.semicolon();
    return { k: 'expr', e, pos };
  }

  private parseFor(): Stmt {
    const pos = this.pos();
    this.expect('for');
    let each = false;
    if (this.isId('each')) {
      this.next();
      each = true;
    }
    this.expect('(');
    let init: Stmt | undefined;
    let decl: VarDecl | undefined;
    let target: Expr | undefined;
    if (this.is('var') || this.is('const')) {
      const kpos = this.pos();
      const isConst = this.next().value === 'const';
      const decls = this.parseVarDecls(true);
      if (this.is('in') && decls.length === 1) decl = decls[0];
      else init = { k: 'var', isConst, decls, pos: kpos };
    } else if (!this.is(';')) {
      const e = this.parseExpr(true);
      if (this.is('in')) target = e;
      else init = { k: 'expr', e, pos: e.pos };
    }
    if (this.eat('in')) {
      const obj = this.parseExpr();
      this.expect(')');
      return { k: 'forin', each, decl, target, obj, body: this.parseStatement(), pos };
    }
    if (each) throw this.error("Expected 'in' in for each");
    this.expect(';');
    const c = this.is(';') ? undefined : this.parseExpr();
    this.expect(';');
    const update = this.is(')') ? undefined : this.parseExpr();
    this.expect(')');
    return { k: 'for', init, c, update, body: this.parseStatement(), pos };
  }

  private parseSwitch(): Stmt {
    const pos = this.pos();
    this.expect('switch');
    this.expect('(');
    const disc = this.parseExpr();
    this.expect(')');
    this.expect('{');
    const cases: Array<{ test: Expr | null; body: Stmt[] }> = [];
    while (!this.is('}')) {
      let test: Expr | null;
      if (this.eat('default')) test = null;
      else {
        this.expect('case');
        test = this.parseExpr();
      }
      this.expect(':');
      const body: Stmt[] = [];
      while (!this.is('case') && !this.is('default') && !this.is('}')) body.push(this.parseStatement());
      cases.push({ test, body });
    }
    this.expect('}');
    return { k: 'switch', disc, cases, pos };
  }

  private parseTry(): Stmt {
    const pos = this.pos();
    this.expect('try');
    const body = this.parseBlock();
    const catches: CatchClause[] = [];
    while (this.eat('catch')) {
      this.expect('(');
      const name = this.ident(true);
      const type = this.eat(':') ? this.parseType() : undefined;
      this.expect(')');
      catches.push({ name, type, body: this.parseBlock() });
    }
    const fin = this.eat('finally') ? this.parseBlock() : undefined;
    if (!catches.length && !fin) throw this.error("Expected 'catch' or 'finally'");
    return { k: 'try', body, catches, finally: fin, pos };
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  parseExpr(noIn = false): Expr {
    const first = this.parseAssign(noIn);
    if (!this.is(',')) return first;
    const list = [first];
    while (this.eat(',')) list.push(this.parseAssign(noIn));
    return { k: 'comma', list, pos: first.pos };
  }

  parseAssign(noIn = false): Expr {
    const pos = this.pos();
    const left = this.parseConditional(noIn);
    if (this.t.kind === 'punct' && ASSIGN_OPS.has(this.t.value)) {
      const op = this.next().value;
      if (!isAssignable(left)) throw new CompileError('Invalid assignment target', pos.line, pos.col, this.source);
      const v = this.parseAssign(noIn);
      return { k: 'assign', op: op === '=' ? '' : op.slice(0, -1), target: left, v, pos };
    }
    return left;
  }

  private parseConditional(noIn: boolean): Expr {
    const c = this.parseBinary(0, noIn);
    if (!this.eat('?')) return c;
    const t = this.parseAssign();
    this.expect(':');
    const f = this.parseAssign(noIn);
    return { k: 'cond', c, t, f, pos: c.pos };
  }

  private binaryOp(noIn: boolean): string | undefined {
    const t = this.t;
    if (t.kind !== 'punct' && t.kind !== 'kw') return undefined;
    if (noIn && t.value === 'in') return undefined;
    return BINARY_PREC[t.value] !== undefined ? t.value : undefined;
  }

  private parseBinary(minPrec: number, noIn: boolean): Expr {
    let left = this.parseUnary();
    for (;;) {
      const op = this.binaryOp(noIn);
      if (!op) return left;
      const prec = BINARY_PREC[op]!;
      if (prec <= minPrec) return left;
      this.next();
      if (op === 'as' || op === 'is') {
        // Right side is a type expression (may be '*' or a Vector type).
        if (this.is('*') || this.is('void')) {
          const tpos = this.pos();
          this.next();
          left = { k: 'binary', op, a: left, b: { k: 'id', name: '*', pos: tpos }, pos: left.pos };
          continue;
        }
      }
      const right = this.parseBinary(prec, noIn);
      left = { k: 'binary', op, a: left, b: right, pos: left.pos };
    }
  }

  private parseUnary(): Expr {
    const pos = this.pos();
    const t = this.t;
    if (t.kind === 'punct' && (t.value === '!' || t.value === '~' || t.value === '-' || t.value === '+')) {
      this.next();
      const e = this.parseUnary();
      if (t.value === '-' && e.k === 'num') return { k: 'num', v: -e.v, pos };
      return { k: 'unary', op: t.value, e, pos };
    }
    if (t.kind === 'punct' && (t.value === '++' || t.value === '--')) {
      this.next();
      const e = this.parseUnary();
      return { k: 'update', op: t.value, prefix: true, e, pos };
    }
    if (t.kind === 'kw' && (t.value === 'typeof' || t.value === 'void' || t.value === 'delete')) {
      this.next();
      return { k: 'unary', op: t.value, e: this.parseUnary(), pos };
    }
    const e = this.parsePostfix();
    return e;
  }

  private parsePostfix(): Expr {
    const e = this.parseLeftHandSide();
    if ((this.is('++') || this.is('--')) && !this.t.nl) {
      const op = this.next().value as '++' | '--';
      return { k: 'update', op, prefix: false, e, pos: e.pos };
    }
    return e;
  }

  private parseArgs(): Expr[] {
    this.expect('(');
    const args: Expr[] = [];
    while (!this.is(')')) {
      args.push(this.parseAssign());
      if (!this.eat(',')) break;
    }
    this.expect(')');
    return args;
  }

  private parseLeftHandSide(): Expr {
    let e: Expr;
    const pos = this.pos();
    if (this.is('new')) {
      this.next();
      if (this.is('<')) {
        // Vector literal: new <T>[a, b]
        this.next();
        const type = this.parseType();
        this.expect('>');
        const arr = this.parsePrimary();
        if (arr.k !== 'array') throw this.error('Expected array literal after vector type');
        e = { k: 'vector', type, items: arr.items.map((x) => x ?? { k: 'undefined', pos }), pos };
      } else {
        const ctor = this.parseMemberOnly();
        const args = this.is('(') ? this.parseArgs() : [];
        e = { k: 'new', ctor, args, pos };
      }
    } else {
      e = this.parsePrimary();
    }
    return this.parseSuffixes(e, true);
  }

  /** Member expression without call suffixes (for `new X.Y(args)`). */
  private parseMemberOnly(): Expr {
    if (this.is('new')) return this.parseLeftHandSide();
    return this.parseSuffixes(this.parsePrimary(), false);
  }

  private parseSuffixes(e: Expr, allowCalls: boolean): Expr {
    for (;;) {
      const pos = e.pos;
      if (this.is('.')) {
        this.next();
        if (this.eat('@')) {
          if (this.eat('[')) {
            const index = this.parseExpr();
            this.expect(']');
            e = { k: 'index', obj: e, index, attr: true, pos };
          } else e = { k: 'member', obj: e, name: this.is('*') ? (this.next(), '*') : this.ident(true), attr: true, pos };
          continue;
        }
        if (this.is('(')) {
          this.next();
          const cond = this.parseExpr();
          this.expect(')');
          e = { k: 'filter', obj: e, cond, pos };
          continue;
        }
        const name = this.is('*') ? (this.next(), '*') : this.ident(true);
        if (this.eat('::')) {
          const local = this.ident(true);
          e = { k: 'member', obj: e, name: local, ns: name, pos };
        } else e = { k: 'member', obj: e, name, pos };
        continue;
      }
      if (this.is('..')) {
        this.next();
        const attr = this.eat('@');
        e = { k: 'descendants', obj: e, name: this.is('*') ? (this.next(), '*') : this.ident(true), attr, pos };
        continue;
      }
      if (this.is('.<')) {
        this.next();
        const params = [this.parseType()];
        while (this.eat(',')) params.push(this.parseType());
        this.expect('>');
        e = { k: 'typeapply', base: e, params, pos };
        continue;
      }
      if (this.is('[')) {
        this.next();
        const index = this.parseExpr();
        this.expect(']');
        e = { k: 'index', obj: e, index, pos };
        continue;
      }
      if (allowCalls && this.is('(')) {
        e = { k: 'call', fn: e, args: this.parseArgs(), pos };
        continue;
      }
      return e;
    }
  }

  private parsePrimary(): Expr {
    const t = this.t;
    const pos = this.pos();
    switch (t.kind) {
      case 'num':
        this.next();
        return { k: 'num', v: t.num!, pos };
      case 'str':
        this.next();
        return { k: 'str', v: t.value, pos };
      case 'regex':
        this.next();
        return { k: 'regex', pattern: t.value, flags: t.flags ?? '', pos };
      case 'id': {
        this.next();
        if (t.value === 'undefined') return { k: 'undefined', pos };
        if (this.is('::')) {
          this.next();
          return { k: 'id', name: this.ident(true), ns: t.value, pos };
        }
        return { k: 'id', name: t.value, pos };
      }
      case 'kw':
        switch (t.value) {
          case 'this':
            this.next();
            return { k: 'this', pos };
          case 'super':
            this.next();
            return { k: 'super', pos };
          case 'true':
          case 'false':
            this.next();
            return { k: 'bool', v: t.value === 'true', pos };
          case 'null':
            this.next();
            return { k: 'null', pos };
          case 'function': {
            this.next();
            const name = this.t.kind === 'id' ? this.next().value : undefined;
            return { k: 'function', fn: this.parseFunctionRest(name), pos };
          }
          case 'public':
          case 'private':
          case 'protected':
          case 'internal':
            if (this.peek().value === '::') {
              this.next();
              this.next();
              return { k: 'id', name: this.ident(true), ns: t.value, pos };
            }
            break;
        }
        break;
      case 'punct':
        switch (t.value) {
          case '(': {
            this.next();
            const e = this.parseExpr();
            this.expect(')');
            return e;
          }
          case '[': {
            this.next();
            const items: Array<Expr | null> = [];
            while (!this.is(']')) {
              if (this.is(',')) {
                this.next();
                items.push(null);
                continue;
              }
              items.push(this.parseAssign());
              if (!this.eat(',')) break;
            }
            this.expect(']');
            return { k: 'array', items, pos };
          }
          case '{': {
            this.next();
            const props: Array<{ key: string | number; value: Expr }> = [];
            while (!this.is('}')) {
              const kt = this.next();
              let key: string | number;
              if (kt.kind === 'str' || kt.kind === 'id' || kt.kind === 'kw') key = kt.value;
              else if (kt.kind === 'num') key = kt.num!;
              else throw this.error('Expected property name', kt);
              this.expect(':');
              props.push({ key, value: this.parseAssign() });
              if (!this.eat(',')) break;
            }
            this.expect('}');
            return { k: 'object', props, pos };
          }
          case '@': {
            this.next();
            const name = this.is('*') ? (this.next(), '*') : this.ident(true);
            return { k: 'member', obj: { k: 'this', pos }, name, attr: true, pos };
          }
          case '<':
            return this.parseXmlLiteral();
        }
        break;
    }
    throw this.error(`Unexpected '${t.value || 'end of file'}'`);
  }

  /** Very small XML literal support: the literal is kept as text and parsed at runtime with `new XML(...)`. */
  private parseXmlLiteral(): Expr {
    const pos = this.pos();
    const start = this.t.start;
    // Scan the raw source for the matching close tag.
    let depth = 0;
    let i = start;
    const src = this.src;
    while (i < src.length) {
      if (src.startsWith('<!--', i)) {
        i = src.indexOf('-->', i) + 3;
        continue;
      }
      if (src[i] === '<') {
        const close = src.indexOf('>', i);
        if (close < 0) break;
        const tag = src.slice(i, close + 1);
        if (tag.startsWith('</')) depth--;
        else if (!tag.endsWith('/>') && !tag.startsWith('<?')) depth++;
        i = close + 1;
        if (depth === 0) break;
        continue;
      }
      i++;
    }
    if (depth !== 0) throw this.error('Unterminated XML literal');
    while (this.t.kind !== 'eof' && this.t.start < i) this.next();
    return { k: 'xml', text: src.slice(start, i), pos };
  }
}

function isAssignable(e: Expr): boolean {
  return e.k === 'id' || e.k === 'member' || e.k === 'index' || e.k === 'descendants';
}

export function parseAs3(src: string, source?: string): CompilationUnit {
  return new Parser(src, source).parseUnit();
}
