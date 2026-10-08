/** AST produced by the AS3 parser. */

export interface Pos {
  line: number;
  col: number;
}

export interface TypeRef {
  name: string;
  /** Vector.<T> parameters. */
  params?: TypeRef[];
  pos: Pos;
}

export type Expr = (
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'undefined' }
  | { k: 'regex'; pattern: string; flags: string }
  | { k: 'id'; name: string; ns?: string }
  | { k: 'this' }
  | { k: 'super' }
  | { k: 'member'; obj: Expr; name: string; ns?: string; attr?: boolean }
  | { k: 'index'; obj: Expr; index: Expr; attr?: boolean }
  | { k: 'descendants'; obj: Expr; name: string; attr?: boolean }
  | { k: 'filter'; obj: Expr; cond: Expr }
  | { k: 'typeapply'; base: Expr; params: TypeRef[] }
  | { k: 'call'; fn: Expr; args: Expr[] }
  | { k: 'new'; ctor: Expr; args: Expr[] }
  | { k: 'vector'; type: TypeRef; items: Expr[] }
  | { k: 'unary'; op: string; e: Expr }
  | { k: 'update'; op: '++' | '--'; prefix: boolean; e: Expr }
  | { k: 'binary'; op: string; a: Expr; b: Expr }
  | { k: 'cond'; c: Expr; t: Expr; f: Expr }
  | { k: 'assign'; op: string; target: Expr; v: Expr }
  | { k: 'array'; items: Array<Expr | null> }
  | { k: 'object'; props: Array<{ key: string | number; value: Expr }> }
  | { k: 'function'; fn: FunctionDef }
  | { k: 'comma'; list: Expr[] }
  | { k: 'xml'; text: string }
) & { pos: Pos };

export interface Param {
  name: string;
  type?: TypeRef;
  init?: Expr;
}

export interface FunctionDef {
  name?: string;
  params: Param[];
  rest?: { name: string; type?: TypeRef };
  returnType?: TypeRef;
  body?: Stmt[];
  pos: Pos;
}

export interface VarDecl {
  name: string;
  type?: TypeRef;
  init?: Expr;
  pos: Pos;
}

export interface CatchClause {
  name: string;
  type?: TypeRef;
  body: Stmt[];
}

export type Stmt = (
  | { k: 'expr'; e: Expr }
  | { k: 'var'; isConst: boolean; decls: VarDecl[] }
  | { k: 'function'; fn: FunctionDef }
  | { k: 'if'; c: Expr; then: Stmt; else?: Stmt }
  | { k: 'while'; c: Expr; body: Stmt }
  | { k: 'dowhile'; c: Expr; body: Stmt }
  | { k: 'for'; init?: Stmt; c?: Expr; update?: Expr; body: Stmt }
  | { k: 'forin'; each: boolean; decl?: VarDecl; target?: Expr; obj: Expr; body: Stmt }
  | { k: 'switch'; disc: Expr; cases: Array<{ test: Expr | null; body: Stmt[] }> }
  | { k: 'try'; body: Stmt[]; catches: CatchClause[]; finally?: Stmt[] }
  | { k: 'return'; e?: Expr }
  | { k: 'throw'; e: Expr }
  | { k: 'break'; label?: string }
  | { k: 'continue'; label?: string }
  | { k: 'block'; body: Stmt[] }
  | { k: 'labeled'; label: string; body: Stmt }
  | { k: 'with'; obj: Expr; body: Stmt }
  | { k: 'dxns'; e: Expr }
  | { k: 'empty' }
) & { pos: Pos };

export interface Metadata {
  name: string;
  items: Array<{ key?: string; value: string }>;
}

export interface FieldMember {
  k: 'field';
  name: string;
  isStatic: boolean;
  isConst: boolean;
  access: string;
  type?: TypeRef;
  init?: Expr;
  metadata: Metadata[];
  pos: Pos;
  /** Source span [start, end) of the declaration. */
  span: [number, number];
}

export interface MethodMember {
  k: 'method';
  name: string;
  kind: 'method' | 'get' | 'set' | 'constructor';
  isStatic: boolean;
  isOverride: boolean;
  isFinal: boolean;
  isNative: boolean;
  access: string;
  fn: FunctionDef;
  metadata: Metadata[];
  pos: Pos;
  span: [number, number];
}

export interface StaticBlockMember {
  k: 'static';
  body: Stmt[];
  pos: Pos;
  span: [number, number];
}

export type Member = FieldMember | MethodMember | StaticBlockMember;

export interface ClassDef {
  name: string;
  isInterface: boolean;
  isDynamic: boolean;
  isFinal: boolean;
  access: string;
  extends?: TypeRef;
  implements: TypeRef[];
  members: Member[];
  metadata: Metadata[];
  pos: Pos;
}

export interface CompilationUnit {
  package: string;
  imports: string[];
  /** `use namespace x` declarations. */
  useNamespaces: string[];
  classes: ClassDef[];
  /** Package-level functions / variables (rare). */
  functions: MethodMember[];
}
