import { AssemblerError } from '../../errors.js';
import type { AbcFile, MethodBody, MethodInfo, OptionalParam, Trait } from '../abc-file.js';
import { newTrait } from '../abc-file.js';
import { computeLimits, minLocalCount } from '../analysis.js';
import { encodeCode, type CodeException, type CodeItem, type Instruction } from '../code.js';
import { ConstantKind, MethodFlags, MultinameKind, NAMESPACE_KIND_BY_NAME, TraitAttr, TraitKind } from '../constants.js';
import { Interner } from '../interner.js';
import { opByName } from '../opcodes.js';
import { TRAIT_KIND_BY_TEXT } from './format.js';
import { LineCursor, tokenizeLine } from './lexer.js';

export type LimitsMode =
  /** Use the declared values but raise them if the code needs more (default). */
  | 'grow'
  /** Always use computed values. */
  | 'auto'
  /** Use declared values verbatim. */
  | 'keep';

export interface AssembleOptions {
  /** How maxstack / localcount / maxscopedepth are determined. Default 'grow'. */
  limits?: LimitsMode;
  /** File name used in error messages. */
  source?: string;
  /** Reuse an interner across calls (faster when assembling many methods into the same ABC). */
  interner?: Interner;
}

export interface AssembledMethod {
  /** Method index that was replaced or created. */
  methodIndex: number;
  /** True when the method was newly appended (`method new`). */
  created: boolean;
}

interface Line {
  no: number;
  cur: LineCursor;
}

// ---------------------------------------------------------------------------
// Constant parsing
// ---------------------------------------------------------------------------

class ConstParser {
  constructor(
    readonly abc: AbcFile,
    readonly pool: Interner,
  ) {}

  namespace(c: LineCursor): number {
    if (c.tryPunct('*')) return 0;
    const tok = c.peek();
    const kindName = c.id();
    const kind = NAMESPACE_KIND_BY_NAME.get(kindName) ?? (/^Namespace_0x[0-9a-f]+$/i.test(kindName) ? parseInt(kindName.slice(12), 16) : undefined);
    if (kind === undefined) throw c.error(`Unknown namespace kind '${kindName}'`, tok);
    c.punct('(');
    const name = c.stringOrNull();
    let hint: number | undefined;
    if (c.tryPunct(',')) hint = c.integer(0);
    c.punct(')');
    try {
      return this.pool.namespace(kind, name, hint);
    } catch (e) {
      throw c.error((e as Error).message, tok);
    }
  }

  nsSet(c: LineCursor): number {
    c.punct('[');
    const list: number[] = [];
    if (!c.isPunct(']')) {
      do list.push(this.namespace(c));
      while (c.tryPunct(','));
    }
    c.punct(']');
    return this.pool.nsSet(list);
  }

  multiname(c: LineCursor): number {
    if (c.tryPunct('*')) return 0;
    if (c.isId('null')) {
      c.next();
      return 0;
    }
    const tok = c.peek();
    const kindName = c.id();
    const K = MultinameKind;
    const kind = (K as Record<string, number>)[kindName];
    if (kind === undefined) throw c.error(`Unknown multiname kind '${kindName}'`, tok);
    c.punct('(');
    let result: number;
    switch (kind) {
      case K.QName:
      case K.QNameA: {
        const ns = this.namespace(c);
        c.punct(',');
        const name = this.pool.string(c.stringOrNull());
        result = this.pool.multiname({ kind, ns, name });
        break;
      }
      case K.RTQName:
      case K.RTQNameA:
        result = this.pool.multiname({ kind, name: this.pool.string(c.stringOrNull()) });
        break;
      case K.RTQNameL:
      case K.RTQNameLA:
        result = this.pool.multiname({ kind });
        break;
      case K.Multiname:
      case K.MultinameA: {
        const name = this.pool.string(c.stringOrNull());
        c.punct(',');
        result = this.pool.multiname({ kind, name, nsSet: this.nsSet(c) });
        break;
      }
      case K.MultinameL:
      case K.MultinameLA:
        result = this.pool.multiname({ kind, nsSet: this.nsSet(c) });
        break;
      case K.TypeName: {
        const base = this.multiname(c);
        c.punct(',');
        c.punct('[');
        const params: number[] = [];
        if (!c.isPunct(']')) {
          do params.push(this.multiname(c));
          while (c.tryPunct(','));
        }
        c.punct(']');
        result = this.pool.multiname({ kind, base, params });
        break;
      }
      default:
        throw c.error(`Unsupported multiname kind '${kindName}'`, tok);
    }
    c.punct(')');
    return result;
  }

  /** Constant value → { kind, index }. */
  value(c: LineCursor): OptionalParam {
    const tok = c.peek();
    const name = c.id();
    const C = ConstantKind;
    const arg = <T>(f: () => T): T => {
      c.punct('(');
      const v = f();
      c.punct(')');
      return v;
    };
    switch (name) {
      case 'Integer':
        return { kind: C.Int, value: this.pool.int(arg(() => c.integer(-0x80000000, 0x7fffffff))) };
      case 'UInteger':
        return { kind: C.UInt, value: this.pool.uint(arg(() => c.integer(0, 0xffffffff))) };
      case 'Double':
        return { kind: C.Double, value: this.pool.double(arg(() => c.number())) };
      case 'Utf8':
        return { kind: C.Utf8, value: this.pool.string(arg(() => c.stringOrNull())) };
      case 'True':
      case 'False':
      case 'Null':
      case 'Undefined': {
        const kind = name === 'True' ? C.True : name === 'False' ? C.False : name === 'Null' ? C.Null : C.Undefined;
        const index = c.isPunct('(') ? arg(() => c.integer(0)) : kind;
        return { kind, value: index };
      }
      case 'RawValue': {
        c.punct('(');
        const kind = c.integer(0, 255);
        c.punct(',');
        const value = c.integer(0);
        c.punct(')');
        return { kind, value };
      }
      default: {
        const nsKind = NAMESPACE_KIND_BY_NAME.get(name);
        if (nsKind === undefined) throw c.error(`Unknown value '${name}'`, tok);
        c.pos--;
        return { kind: nsKind, value: this.namespace(c) };
      }
    }
  }

  trait(c: LineCursor, methodRef: (c: LineCursor) => number): Trait {
    c.id('trait');
    const kindTok = c.peek();
    const kind = TRAIT_KIND_BY_TEXT.get(c.id());
    if (kind === undefined) throw c.error('Unknown trait kind (slot, const, method, getter, setter, class, function)', kindTok);
    const t = newTrait({ name: this.multiname(c), kind });
    while (!c.done) {
      const keyTok = c.peek();
      const key = c.id();
      switch (key) {
        case 'slotid':
        case 'dispid':
          t.id = c.integer(0);
          break;
        case 'type':
          t.typeName = this.multiname(c);
          break;
        case 'value': {
          const v = this.value(c);
          t.valueKind = v.kind;
          t.valueIndex = v.value;
          break;
        }
        case 'class':
          t.classIndex = c.integer(0);
          break;
        case 'method':
          t.method = methodRef(c);
          break;
        case 'final':
          t.attrs |= TraitAttr.Final;
          break;
        case 'override':
          t.attrs |= TraitAttr.Override;
          break;
        case 'metadata':
          t.attrs |= TraitAttr.Metadata;
          c.punct('[');
          if (!c.isPunct(']')) {
            do t.metadata.push(c.integer(0));
            while (c.tryPunct(','));
          }
          c.punct(']');
          break;
        default:
          throw c.error(`Unknown trait attribute '${key}'`, keyTok);
      }
    }
    if (kind !== TraitKind.Slot && kind !== TraitKind.Const && t.valueIndex !== 0) throw c.error('Only slot/const traits can have a value');
    return t;
  }
}

// ---------------------------------------------------------------------------
// Method assembly
// ---------------------------------------------------------------------------

function splitLines(text: string, source?: string): Line[] {
  const out: Line[] = [];
  text.split('\n').forEach((raw, i) => {
    const tokens = tokenizeLine(raw, i + 1, source);
    if (tokens.length) out.push({ no: i + 1, cur: new LineCursor(tokens, i + 1, source) });
  });
  return out;
}

function parseFlags(c: LineCursor): number {
  let flags = 0;
  do {
    const tok = c.peek();
    if (tok?.type === 'num') {
      flags |= c.integer(0, 255);
      continue;
    }
    const name = c.id();
    const bit = (MethodFlags as Record<string, number>)[name];
    if (bit === undefined) throw c.error(`Unknown method flag '${name}'`, tok);
    flags |= bit;
  } while (c.tryPunct('|'));
  return flags;
}

function assembleOne(abc: AbcFile, lines: Line[], start: number, options: AssembleOptions, consts: ConstParser): { result: AssembledMethod; next: number } {
  const header = lines[start]!.cur;
  header.id('method');
  let methodIndex: number;
  let created = false;
  if (header.isId('new')) {
    header.next();
    methodIndex = abc.methods.length;
    created = true;
  } else {
    methodIndex = header.integer(0);
    if (methodIndex >= abc.methods.length) throw header.error(`Method index ${methodIndex} out of range (0..${abc.methods.length - 1}); use 'method new' to add one`);
  }
  header.end();

  const existingBody = created ? undefined : abc.methodBody(methodIndex);
  const method: MethodInfo = { paramTypes: [], returnType: 0, name: 0, flags: 0, optional: [], paramNames: [] };
  const methodRef = (c: LineCursor): number => {
    const tok = c.peek();
    const v = c.integer(0);
    if (v >= abc.methods.length + (created ? 1 : 0)) throw c.error(`Method index ${v} out of range`, tok);
    return v;
  };

  type Section = 'method' | 'body' | 'code';
  let section: Section = 'method';
  let hasBody = false;
  let maxStack: number | 'auto' = 'auto';
  let localCount: number | 'auto' = 'auto';
  let maxScopeDepth: number | 'auto' = 'auto';
  let initScopeDepth = existingBody?.initScopeDepth ?? 0;
  const traits: Trait[] = [];
  const tries: Array<{ line: LineCursor; from: string | number; to: string | number; target: string | number; excType: number; varName: number }> = [];
  const items: CodeItem[] = [];
  const labels = new Map<string, number>();
  const labelDefined = new Set<string>();
  const labelRefs: Array<{ name: string; line: LineCursor; col: number }> = [];

  const labelId = (name: string): number => {
    let id = labels.get(name);
    if (id === undefined) {
      id = labels.size;
      labels.set(name, id);
    }
    return id;
  };
  const labelRef = (c: LineCursor): number => {
    const tok = c.next();
    if (tok.type !== 'id') throw c.error('Expected label', tok);
    labelRefs.push({ name: tok.text, line: c, col: tok.col });
    return labelId(tok.text);
  };
  const tryEndpoint = (c: LineCursor): string | number => {
    const tok = c.next();
    if (tok.type === 'offset') return tok.value as number;
    if (tok.type !== 'id') throw c.error('Expected label or @offset', tok);
    labelRefs.push({ name: tok.text, line: c, col: tok.col });
    labelId(tok.text);
    return tok.text;
  };
  const limitValue = (c: LineCursor): number | 'auto' => {
    if (c.isId('auto')) {
      c.next();
      return 'auto';
    }
    return c.integer(0);
  };

  let i = start + 1;
  let sawEnd = false;
  for (; i < lines.length; i++) {
    const { cur: c } = lines[i]!;
    const first = c.peek()!;

    if (first.type === 'id' && c.tokens.length === 1) {
      if (first.text === 'end') {
        sawEnd = true;
        i++;
        break;
      }
      if (first.text === 'body' && section === 'method') {
        section = 'body';
        hasBody = true;
        continue;
      }
      if (first.text === 'code' && (section === 'body' || section === 'method')) {
        section = 'code';
        hasBody = true;
        continue;
      }
    }
    if (first.type === 'id' && first.text === 'method' && section !== 'code') {
      throw c.error("Missing 'end' before next method");
    }

    if (section === 'method') {
      const key = c.id();
      switch (key) {
        case 'name':
          method.name = consts.pool.string(c.stringOrNull());
          break;
        case 'returns':
          method.returnType = consts.multiname(c);
          break;
        case 'param':
          method.paramTypes.push(consts.multiname(c));
          break;
        case 'flags':
          method.flags |= parseFlags(c);
          break;
        case 'optional':
          method.optional.push(consts.value(c));
          break;
        case 'paramname':
          method.paramNames.push(consts.pool.string(c.stringOrNull()));
          break;
        default:
          throw c.error(`Unknown method field '${key}' (expected name, returns, param, flags, optional, paramname, body, code or end)`, first);
      }
      c.end();
      continue;
    }

    if (section === 'body') {
      if (c.isId('trait')) {
        traits.push(consts.trait(c, methodRef));
        continue;
      }
      const key = c.id();
      switch (key) {
        case 'maxstack':
          maxStack = limitValue(c);
          break;
        case 'localcount':
          localCount = limitValue(c);
          break;
        case 'initscopedepth':
          initScopeDepth = c.integer(0);
          break;
        case 'maxscopedepth':
          maxScopeDepth = limitValue(c);
          break;
        case 'try': {
          c.id('from');
          const from = tryEndpoint(c);
          c.id('to');
          const to = tryEndpoint(c);
          c.id('target');
          const target = tryEndpoint(c);
          let excType = 0;
          let varName = 0;
          while (!c.done) {
            const k = c.id();
            if (k === 'type') excType = consts.multiname(c);
            else if (k === 'name') varName = consts.multiname(c);
            else throw c.error(`Unknown try attribute '${k}'`);
          }
          tries.push({ line: c, from, to, target, excType, varName });
          break;
        }
        default:
          throw c.error(`Unknown body field '${key}' (expected maxstack, localcount, initscopedepth, maxscopedepth, trait, try or code)`, first);
      }
      c.end();
      continue;
    }

    // code section
    if (first.type === 'id' && c.peek(1)?.type === 'punct' && c.peek(1)!.text === ':') {
      c.pos += 2;
      if (labelDefined.has(first.text)) throw c.error(`Label '${first.text}' defined twice`, first);
      labelDefined.add(first.text);
      items.push({ type: 'label', id: labelId(first.text) });
      if (c.done) continue;
    }
    items.push(parseInstruction(c, consts, labelRef, methodRef));
  }

  if (!sawEnd) {
    const last = lines[lines.length - 1]!;
    throw new AssemblerError(`Missing 'end' for method block starting at line ${lines[start]!.no}`, last.no, 1, options.source);
  }

  for (const ref of labelRefs) {
    if (!labelDefined.has(ref.name)) throw new AssemblerError(`Undefined label '${ref.name}'`, ref.line.line, ref.col, options.source);
  }

  // Apply ----------------------------------------------------------------
  if (method.optional.length > 0) method.flags |= MethodFlags.HAS_OPTIONAL;
  if (method.paramNames.length > 0) method.flags |= MethodFlags.HAS_PARAM_NAMES;
  if (created) abc.methods.push(method);
  else abc.methods[methodIndex] = method;

  const bodyIdx = abc.bodies.findIndex((b) => b.method === methodIndex);
  if (!hasBody) {
    if (bodyIdx >= 0) abc.bodies.splice(bodyIdx, 1);
    return { result: { methodIndex, created }, next: i };
  }

  const codeExceptions: CodeException[] = [];
  const numericTries: number[] = [];
  tries.forEach((t, k) => {
    if (typeof t.from === 'number' || typeof t.to === 'number' || typeof t.target === 'number') numericTries.push(k);
    codeExceptions.push({
      from: typeof t.from === 'string' ? labels.get(t.from)! : -1,
      to: typeof t.to === 'string' ? labels.get(t.to)! : -1,
      target: typeof t.target === 'string' ? labels.get(t.target)! : -1,
      excType: t.excType,
      varName: t.varName,
    });
  });

  let encoded;
  try {
    encoded = encodeCode(
      items,
      codeExceptions.filter((_, k) => !numericTries.includes(k)),
    );
  } catch (e) {
    throw new AssemblerError((e as Error).message, lines[start]!.no, 1, options.source);
  }
  const resolve = (v: string | number): number => (typeof v === 'number' ? v : encoded.labelOffsets.get(labels.get(v)!)!);
  const exceptions = tries.map((t) => ({ from: resolve(t.from), to: resolve(t.to), target: resolve(t.target), excType: t.excType, varName: t.varName }));

  const limits = computeLimits(abc, items, codeExceptions.filter((_, k) => !numericTries.includes(k)));
  const mode = options.limits ?? 'grow';
  const pick = (declared: number | 'auto', computed: number): number =>
    declared === 'auto' || mode === 'auto' ? computed : mode === 'grow' ? Math.max(declared, computed) : declared;

  const body: MethodBody = {
    method: methodIndex,
    maxStack: pick(maxStack, limits.maxStack),
    localCount: pick(localCount, Math.max(limits.registers, minLocalCount(method))),
    initScopeDepth,
    maxScopeDepth: pick(maxScopeDepth, initScopeDepth + limits.maxScope),
    code: encoded.code,
    exceptions,
    traits,
  };
  if (bodyIdx >= 0) abc.bodies[bodyIdx] = body;
  else abc.bodies.push(body);

  return { result: { methodIndex, created }, next: i };
}

function parseInstruction(
  c: LineCursor,
  consts: ConstParser,
  labelRef: (c: LineCursor) => number,
  methodRef: (c: LineCursor) => number,
): CodeItem {
  const tok = c.peek()!;
  const name = c.id();
  if (name === '.bytes') {
    const bytes: number[] = [];
    while (!c.done) {
      const t = c.next();
      const text = t.text;
      if (!/^[0-9a-fA-F]{1,2}$/.test(text)) throw c.error(`Expected hex byte, got '${text}'`, t);
      bytes.push(parseInt(text, 16));
    }
    return { type: 'bytes', data: new Uint8Array(bytes) };
  }
  const info = opByName(name);
  if (!info) throw c.error(`Unknown instruction '${name}'`, tok);
  const ins: Instruction = { type: 'op', op: info.code, args: [], targets: [], offset: -1 };
  const abc = consts.abc;
  info.operands.forEach((t, k) => {
    if (k > 0) c.punct(',');
    switch (t) {
      case 'u8':
        ins.args.push(c.integer(0, 255));
        break;
      case 's8':
        ins.args.push(c.integer(-128, 127));
        break;
      case 'short':
        ins.args.push(c.integer(-0x80000000, 0xffffffff) | 0);
        break;
      case 'u30':
      case 'argc':
      case 'reg':
      case 'class':
      case 'exception':
        ins.args.push(c.integer(0, 0x3fffffff));
        break;
      case 'method':
        ins.args.push(methodRef(c));
        break;
      case 'int':
        ins.args.push(abc.int(c.integer(-0x80000000, 0x7fffffff)));
        break;
      case 'uint':
        ins.args.push(abc.uint(c.integer(0, 0xffffffff)));
        break;
      case 'double':
        ins.args.push(abc.double(c.number()));
        break;
      case 'string':
        ins.args.push(consts.pool.string(c.stringOrNull()));
        break;
      case 'namespace':
        ins.args.push(consts.namespace(c));
        break;
      case 'multiname':
        ins.args.push(consts.multiname(c));
        break;
      case 'branch':
        ins.targets.push(labelRef(c));
        break;
      case 'switch': {
        ins.targets.push(labelRef(c));
        c.punct(',');
        c.punct('[');
        if (!c.isPunct(']')) {
          do ins.targets.push(labelRef(c));
          while (c.tryPunct(','));
        }
        c.punct(']');
        if (ins.targets.length < 2) throw c.error('lookupswitch needs at least one case');
        break;
      }
    }
  });
  c.end();
  return ins;
}

/**
 * Assembles one or more `method ... end` blocks into `abc`, replacing the
 * referenced methods (or appending them for `method new`).
 */
export function assembleMethods(abc: AbcFile, text: string, options: AssembleOptions = {}): AssembledMethod[] {
  const lines = splitLines(text, options.source);
  const consts = new ConstParser(abc, options.interner ?? new Interner(abc));
  const results: AssembledMethod[] = [];
  let i = 0;
  while (i < lines.length) {
    const c = lines[i]!.cur;
    if (!c.isId('method')) throw c.error("Expected 'method'");
    const { result, next } = assembleOne(abc, lines, i, options, consts);
    results.push(result);
    i = next;
  }
  return results;
}

/** Assembles a single method block. */
export function assembleMethod(abc: AbcFile, text: string, options: AssembleOptions = {}): AssembledMethod {
  const r = assembleMethods(abc, text, options);
  if (r.length !== 1) throw new Error(`Expected exactly one method block, got ${r.length}`);
  return r[0]!;
}

/**
 * Parses P-code instructions (the contents of a `code` section) into code
 * items, interning constants into `abc`. Labels are returned by name.
 */
export function assembleCode(abc: AbcFile, text: string, options: { source?: string; interner?: Interner } = {}): { items: CodeItem[]; labels: Map<string, number> } {
  const consts = new ConstParser(abc, options.interner ?? new Interner(abc));
  const labels = new Map<string, number>();
  const defined = new Set<string>();
  const labelId = (name: string): number => {
    let id = labels.get(name);
    if (id === undefined) {
      id = labels.size;
      labels.set(name, id);
    }
    return id;
  };
  const items: CodeItem[] = [];
  const refs: Array<{ name: string; c: LineCursor; col: number }> = [];
  for (const { cur: c } of splitLines(text, options.source)) {
    const first = c.peek()!;
    if (first.type === 'id' && c.peek(1)?.type === 'punct' && c.peek(1)!.text === ':') {
      c.pos += 2;
      if (defined.has(first.text)) throw c.error(`Label '${first.text}' defined twice`, first);
      defined.add(first.text);
      items.push({ type: 'label', id: labelId(first.text) });
      if (c.done) continue;
    }
    items.push(
      parseInstruction(
        c,
        consts,
        (lc) => {
          const t = lc.next();
          if (t.type !== 'id') throw lc.error('Expected label', t);
          refs.push({ name: t.text, c: lc, col: t.col });
          return labelId(t.text);
        },
        (lc) => lc.integer(0),
      ),
    );
  }
  for (const r of refs) if (!defined.has(r.name)) throw new AssemblerError(`Undefined label '${r.name}'`, r.c.line, r.col, options.source);
  return { items, labels };
}
