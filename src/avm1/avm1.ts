/**
 * AVM1 (ActionScript 1/2) bytecode: decoding to a label-based action list,
 * P-code text formatting and parsing, and re-encoding.
 */
import { ByteReader } from '../io/reader.js';
import { ByteWriter } from '../io/writer.js';

const NAMES: Record<number, string> = {
  0x00: 'End', 0x04: 'NextFrame', 0x05: 'PrevFrame', 0x06: 'Play', 0x07: 'Stop', 0x08: 'ToggleQuality', 0x09: 'StopSounds',
  0x0a: 'Add', 0x0b: 'Subtract', 0x0c: 'Multiply', 0x0d: 'Divide', 0x0e: 'Equals', 0x0f: 'Less', 0x10: 'And', 0x11: 'Or',
  0x12: 'Not', 0x13: 'StringEquals', 0x14: 'StringLength', 0x15: 'StringExtract', 0x17: 'Pop', 0x18: 'ToInteger',
  0x1c: 'GetVariable', 0x1d: 'SetVariable', 0x20: 'SetTarget2', 0x21: 'StringAdd', 0x22: 'GetProperty', 0x23: 'SetProperty',
  0x24: 'CloneSprite', 0x25: 'RemoveSprite', 0x26: 'Trace', 0x27: 'StartDrag', 0x28: 'EndDrag', 0x29: 'StringLess',
  0x2a: 'Throw', 0x2b: 'CastOp', 0x2c: 'ImplementsOp', 0x30: 'RandomNumber', 0x31: 'MBStringLength', 0x32: 'CharToAscii',
  0x33: 'AsciiToChar', 0x34: 'GetTime', 0x35: 'MBStringExtract', 0x36: 'MBCharToAscii', 0x37: 'MBAsciiToChar',
  0x3a: 'Delete', 0x3b: 'Delete2', 0x3c: 'DefineLocal', 0x3d: 'CallFunction', 0x3e: 'Return', 0x3f: 'Modulo',
  0x40: 'NewObject', 0x41: 'DefineLocal2', 0x42: 'InitArray', 0x43: 'InitObject', 0x44: 'TypeOf', 0x45: 'TargetPath',
  0x46: 'Enumerate', 0x47: 'Add2', 0x48: 'Less2', 0x49: 'Equals2', 0x4a: 'ToNumber', 0x4b: 'ToString', 0x4c: 'PushDuplicate',
  0x4d: 'StackSwap', 0x4e: 'GetMember', 0x4f: 'SetMember', 0x50: 'Increment', 0x51: 'Decrement', 0x52: 'CallMethod',
  0x53: 'NewMethod', 0x54: 'InstanceOf', 0x55: 'Enumerate2', 0x60: 'BitAnd', 0x61: 'BitOr', 0x62: 'BitXor',
  0x63: 'BitLShift', 0x64: 'BitRShift', 0x65: 'BitURShift', 0x66: 'StrictEquals', 0x67: 'Greater', 0x68: 'StringGreater',
  0x69: 'Extends', 0x81: 'GotoFrame', 0x83: 'GetURL', 0x87: 'StoreRegister', 0x88: 'ConstantPool', 0x8a: 'WaitForFrame',
  0x8b: 'SetTarget', 0x8c: 'GoToLabel', 0x8d: 'WaitForFrame2', 0x8e: 'DefineFunction2', 0x8f: 'Try', 0x94: 'With',
  0x96: 'Push', 0x99: 'Jump', 0x9a: 'GetURL2', 0x9b: 'DefineFunction', 0x9d: 'If', 0x9e: 'Call', 0x9f: 'GotoFrame2',
};
const CODES = new Map(Object.entries(NAMES).map(([k, v]) => [v.toLowerCase(), Number(k)]));

export type Avm1Value =
  | { t: 'string'; v: string }
  | { t: 'float'; v: number }
  | { t: 'null' }
  | { t: 'undefined' }
  | { t: 'register'; v: number }
  | { t: 'boolean'; v: boolean }
  | { t: 'double'; v: number }
  | { t: 'integer'; v: number }
  | { t: 'constant8'; v: number }
  | { t: 'constant16'; v: number };

export interface Avm1Action {
  type: 'action';
  code: number;
  /** Operands; label ids are numbers in `labels`. */
  args: unknown[];
  /** Label operands (jump target / block ends), in action-specific order. */
  labels: number[];
  /** Unknown action payload (kept verbatim). */
  raw?: Uint8Array;
}

export interface Avm1Label {
  type: 'label';
  id: number;
}

export type Avm1Item = Avm1Action | Avm1Label;

export function actionName(code: number): string {
  return NAMES[code] ?? `Action0x${code.toString(16).padStart(2, '0')}`;
}

function readDouble(r: ByteReader): number {
  // AVM1 doubles store the high 32-bit word first.
  const hi = r.bytesView(4);
  const lo = r.bytesView(4);
  const b = new Uint8Array(8);
  b.set(lo, 0);
  b.set(hi, 4);
  return new DataView(b.buffer).getFloat64(0, true);
}

function writeDouble(w: ByteWriter, v: number): void {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  w.bytes(b.subarray(4, 8));
  w.bytes(b.subarray(0, 4));
}

/** Decodes AVM1 action bytes. Branches and block sizes become labels. */
export function decodeActions(bytes: Uint8Array): Avm1Item[] {
  const actions: Array<{ offset: number; end: number; action: Avm1Action; targets: number[] }> = [];
  const r = new ByteReader(bytes);
  while (!r.eof) {
    const offset = r.pos;
    const code = r.u8();
    const action: Avm1Action = { type: 'action', code, args: [], labels: [] };
    const targets: number[] = [];
    if (code < 0x80) {
      actions.push({ offset, end: r.pos, action, targets });
      if (code === 0) break;
      continue;
    }
    const len = r.remaining >= 2 ? r.u16() : 0;
    const bodyStart = r.pos;
    const body = new ByteReader(bytes, bodyStart, Math.min(bytes.length, bodyStart + len));
    const end = bodyStart + len;
    try {
      switch (code) {
        case 0x81:
        case 0x8a:
          action.args.push(body.u16());
          if (code === 0x8a) action.args.push(body.u8());
          break;
        case 0x83:
          action.args.push(body.cstring(), body.cstring());
          break;
        case 0x87:
        case 0x8d:
        case 0x9a:
          action.args.push(body.u8());
          break;
        case 0x9f: {
          const flags = body.u8();
          action.args.push(flags);
          if (flags & 2) action.args.push(body.u16());
          break;
        }
        case 0x88: {
          const n = body.u16();
          for (let i = 0; i < n; i++) action.args.push(body.cstring());
          break;
        }
        case 0x8b:
        case 0x8c:
          action.args.push(body.cstring());
          break;
        case 0x96: {
          const values: Avm1Value[] = [];
          while (!body.eof) {
            const t = body.u8();
            switch (t) {
              case 0: values.push({ t: 'string', v: body.cstring() }); break;
              case 1: values.push({ t: 'float', v: body.f32() }); break;
              case 2: values.push({ t: 'null' }); break;
              case 3: values.push({ t: 'undefined' }); break;
              case 4: values.push({ t: 'register', v: body.u8() }); break;
              case 5: values.push({ t: 'boolean', v: body.u8() !== 0 }); break;
              case 6: values.push({ t: 'double', v: readDouble(body) }); break;
              case 7: values.push({ t: 'integer', v: body.s32() }); break;
              case 8: values.push({ t: 'constant8', v: body.u8() }); break;
              case 9: values.push({ t: 'constant16', v: body.u16() }); break;
              default: throw new Error(`Bad push type ${t}`);
            }
          }
          action.args.push(...values);
          break;
        }
        case 0x99:
        case 0x9d:
          targets.push(end + body.s16());
          break;
        case 0x94:
          targets.push(end + body.u16());
          break;
        case 0x9b: {
          action.args.push(body.cstring());
          const n = body.u16();
          const params: string[] = [];
          for (let i = 0; i < n; i++) params.push(body.cstring());
          action.args.push(params);
          targets.push(end + body.u16());
          break;
        }
        case 0x8e: {
          action.args.push(body.cstring());
          const n = body.u16();
          action.args.push(body.u8(), body.u16());
          const params: Array<[number, string]> = [];
          for (let i = 0; i < n; i++) params.push([body.u8(), body.cstring()]);
          action.args.push(params);
          targets.push(end + body.u16());
          break;
        }
        case 0x8f: {
          const flags = body.u8();
          const trySize = body.u16();
          const catchSize = body.u16();
          const finallySize = body.u16();
          action.args.push(flags, flags & 4 ? body.u8() : body.cstring());
          targets.push(end + trySize, end + trySize + catchSize, end + trySize + catchSize + finallySize);
          break;
        }
        default:
          action.raw = bytes.slice(bodyStart, end);
      }
      if (!action.raw && !body.eof) {
        // Trailing bytes we do not understand: keep the whole payload verbatim.
        action.args = [];
        targets.length = 0;
        action.raw = bytes.slice(bodyStart, end);
      }
    } catch {
      action.args = [];
      targets.length = 0;
      action.raw = bytes.slice(bodyStart, end);
    }
    r.pos = Math.min(bytes.length, end);
    actions.push({ offset, end: r.pos, action, targets });
  }

  // Assign labels.
  const offsets = new Set<number>();
  for (const a of actions) for (const t of a.targets) offsets.add(t);
  const labelOf = new Map<number, number>();
  [...offsets].sort((a, b) => a - b).forEach((o, i) => labelOf.set(o, i));
  const items: Avm1Item[] = [];
  const starts = new Set(actions.map((a) => a.offset));
  const endOffset = actions.length ? actions[actions.length - 1]!.end : 0;
  for (const a of actions) {
    const l = labelOf.get(a.offset);
    if (l !== undefined) items.push({ type: 'label', id: l });
    a.action.labels = a.targets.map((t) => labelOf.get(t)!);
    items.push(a.action);
  }
  for (const [o, l] of labelOf) {
    if (o >= endOffset) items.push({ type: 'label', id: l });
    else if (!starts.has(o)) throw new Error(`AVM1 branch to offset ${o} inside an action`);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function encodeBody(a: Avm1Action, labelPos: (id: number) => number, endOfAction: number): Uint8Array {
  if (a.raw) return a.raw;
  const w = new ByteWriter(32);
  const A = a.args;
  switch (a.code) {
    case 0x81:
      w.u16(A[0] as number);
      break;
    case 0x8a:
      w.u16(A[0] as number).u8(A[1] as number);
      break;
    case 0x83:
      w.cstring(A[0] as string).cstring(A[1] as string);
      break;
    case 0x87:
    case 0x8d:
    case 0x9a:
      w.u8(A[0] as number);
      break;
    case 0x9f:
      w.u8(A[0] as number);
      if ((A[0] as number) & 2) w.u16(A[1] as number);
      break;
    case 0x88:
      w.u16(A.length);
      for (const s of A as string[]) w.cstring(s);
      break;
    case 0x8b:
    case 0x8c:
      w.cstring(A[0] as string);
      break;
    case 0x96:
      for (const v of A as Avm1Value[]) {
        switch (v.t) {
          case 'string': w.u8(0).cstring(v.v); break;
          case 'float': w.u8(1).f32(v.v); break;
          case 'null': w.u8(2); break;
          case 'undefined': w.u8(3); break;
          case 'register': w.u8(4).u8(v.v); break;
          case 'boolean': w.u8(5).u8(v.v ? 1 : 0); break;
          case 'double': w.u8(6); writeDouble(w, v.v); break;
          case 'integer': w.u8(7).s32(v.v); break;
          case 'constant8': w.u8(8).u8(v.v); break;
          case 'constant16': w.u8(9).u16(v.v); break;
        }
      }
      break;
    case 0x99:
    case 0x9d:
      w.s16(labelPos(a.labels[0]!) - endOfAction);
      break;
    case 0x94:
      w.u16(labelPos(a.labels[0]!) - endOfAction);
      break;
    case 0x9b: {
      w.cstring(A[0] as string);
      const params = A[1] as string[];
      w.u16(params.length);
      for (const p of params) w.cstring(p);
      w.u16(labelPos(a.labels[0]!) - endOfAction);
      break;
    }
    case 0x8e: {
      w.cstring(A[0] as string);
      const params = A[3] as Array<[number, string]>;
      w.u16(params.length).u8(A[1] as number).u16(A[2] as number);
      for (const [reg, name] of params) w.u8(reg).cstring(name);
      w.u16(labelPos(a.labels[0]!) - endOfAction);
      break;
    }
    case 0x8f: {
      const flags = A[0] as number;
      const t = labelPos(a.labels[0]!);
      const c = labelPos(a.labels[1]!);
      const f = labelPos(a.labels[2]!);
      w.u8(flags).u16(t - endOfAction).u16(c - t).u16(f - c);
      if (flags & 4) w.u8(A[1] as number);
      else w.cstring(A[1] as string);
      break;
    }
  }
  return w.toBytes();
}

/** Encodes an action list back to bytes. Sizes are fixed-point iterated (branches never change length). */
export function encodeActions(items: readonly Avm1Item[]): Uint8Array {
  // Branch operand sizes are constant, so one sizing pass with dummy label positions suffices.
  const sizes = items.map((it) => (it.type === 'label' ? 0 : it.code < 0x80 ? 1 : 3 + encodeBody(it, () => 0, 0).length));
  const labelPos = new Map<number, number>();
  let off = 0;
  items.forEach((it, i) => {
    if (it.type === 'label') labelPos.set(it.id, off);
    off += sizes[i]!;
  });
  const pos = (id: number): number => {
    const p = labelPos.get(id);
    if (p === undefined) throw new Error(`Undefined AVM1 label L${id}`);
    return p;
  };
  const w = new ByteWriter(off + 16);
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.type === 'label') continue;
    w.u8(it.code);
    if (it.code < 0x80) continue;
    const body = encodeBody(it, pos, w.length + sizes[i]! - 1);
    w.u16(body.length);
    w.bytes(body);
  }
  return w.toBytes();
}

// ---------------------------------------------------------------------------
// Text format
// ---------------------------------------------------------------------------

function fmtValue(v: Avm1Value): string {
  switch (v.t) {
    case 'string': return JSON.stringify(v.v);
    case 'float': return `f:${v.v}`;
    case 'null': return 'null';
    case 'undefined': return 'undefined';
    case 'register': return `r:${v.v}`;
    case 'boolean': return String(v.v);
    case 'double': return `d:${Number.isNaN(v.v) ? 'NaN' : v.v}`;
    case 'integer': return String(v.v);
    case 'constant8': return `c:${v.v}`;
    case 'constant16': return `C:${v.v}`;
  }
}

/** Formats actions as editable AS1/AS2 P-code. */
export function formatActions(items: readonly Avm1Item[], options: { constantPool?: string[] } = {}): string {
  const L = (id: number): string => `L${id}`;
  let pool = options.constantPool ?? [];
  const lines: string[] = [];
  for (const it of items) {
    if (it.type === 'label') {
      lines.push(`${L(it.id)}:`);
      continue;
    }
    const name = actionName(it.code);
    if (it.raw) {
      lines.push(`  .action 0x${it.code.toString(16).padStart(2, '0')} ${Array.from(it.raw, (b) => b.toString(16).padStart(2, '0')).join(' ')}`.trimEnd());
      continue;
    }
    const A = it.args;
    let text: string;
    switch (it.code) {
      case 0x88:
        pool = A as string[];
        text = (A as string[]).map((s) => JSON.stringify(s)).join(', ');
        break;
      case 0x96: {
        const vals = A as Avm1Value[];
        text = vals.map(fmtValue).join(', ');
        const hints = vals.filter((v) => v.t === 'constant8' || v.t === 'constant16').map((v) => `${fmtValue(v)}=${JSON.stringify(pool[(v as { v: number }).v] ?? '?')}`);
        if (hints.length) text += `  ; ${hints.join(' ')}`;
        break;
      }
      case 0x99:
      case 0x9d:
      case 0x94:
        text = L(it.labels[0]!);
        break;
      case 0x9b:
        text = `${JSON.stringify(A[0])}, [${(A[1] as string[]).map((p) => JSON.stringify(p)).join(', ')}], ${L(it.labels[0]!)}`;
        break;
      case 0x8e:
        text = `${JSON.stringify(A[0])}, ${A[1]}, 0x${(A[2] as number).toString(16)}, [${(A[3] as Array<[number, string]>).map(([r, n]) => `${r}:${JSON.stringify(n)}`).join(', ')}], ${L(it.labels[0]!)}`;
        break;
      case 0x8f:
        text = `0x${(A[0] as number).toString(16)}, ${typeof A[1] === 'string' ? JSON.stringify(A[1]) : `r:${A[1]}`}, ${it.labels.map(L).join(', ')}`;
        break;
      default:
        text = A.map((x) => (typeof x === 'string' ? JSON.stringify(x) : String(x))).join(', ');
    }
    lines.push(`  ${name}${text ? ' ' + text : ''}`);
  }
  return lines.join('\n') + '\n';
}

/** Parses P-code produced by {@link formatActions}. */
export function parseActions(text: string): Avm1Item[] {
  const items: Avm1Item[] = [];
  const labels = new Map<string, number>();
  const label = (name: string): number => {
    let id = labels.get(name);
    if (id === undefined) labels.set(name, (id = labels.size));
    return id;
  };
  text.split('\n').forEach((rawLine, lineIdx) => {
    const fail = (msg: string): never => {
      throw new Error(`line ${lineIdx + 1}: ${msg}`);
    };
    // Strip comments outside strings.
    let line = '';
    let inStr = false;
    for (let i = 0; i < rawLine.length; i++) {
      const c = rawLine[i]!;
      if (inStr) {
        line += c;
        if (c === '\\') line += rawLine[++i] ?? '';
        else if (c === '"') inStr = false;
      } else if (c === ';') break;
      else {
        if (c === '"') inStr = true;
        line += c;
      }
    }
    line = line.trim();
    if (!line) return;
    const lm = /^([A-Za-z_$][\w$]*):$/.exec(line);
    if (lm) {
      items.push({ type: 'label', id: label(lm[1]!) });
      return;
    }
    const sp = line.search(/\s/);
    const name = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (name === '.action') {
      const parts = rest.split(/\s+/);
      items.push({ type: 'action', code: parseInt(parts[0]!, 16), args: [], labels: [], raw: new Uint8Array(parts.slice(1).map((h) => parseInt(h, 16))) });
      return;
    }
    const code = CODES.get(name.toLowerCase()) ?? (/^Action0x[0-9a-f]{2}$/i.test(name) ? parseInt(name.slice(8), 16) : undefined);
    if (code === undefined) fail(`Unknown action '${name}'`);
    // Tokenise operands: strings, [..] lists, plain words.
    const toks: string[] = [];
    {
      let i = 0;
      while (i < rest.length) {
        const c = rest[i]!;
        if (c === ' ' || c === ',' || c === '\t') {
          i++;
          continue;
        }
        if (c === '"') {
          let j = i + 1;
          while (j < rest.length && rest[j] !== '"') j += rest[j] === '\\' ? 2 : 1;
          toks.push(rest.slice(i, j + 1));
          i = j + 1;
        } else if (c === '[') {
          let depth = 0;
          let j = i;
          let s = false;
          for (; j < rest.length; j++) {
            const ch = rest[j]!;
            if (s) {
              if (ch === '\\') j++;
              else if (ch === '"') s = false;
            } else if (ch === '"') s = true;
            else if (ch === '[') depth++;
            else if (ch === ']' && --depth === 0) break;
          }
          toks.push(rest.slice(i, j + 1));
          i = j + 1;
        } else {
          let j = i;
          while (j < rest.length && !/[\s,]/.test(rest[j]!)) j++;
          toks.push(rest.slice(i, j));
          i = j;
        }
      }
    }
    const str = (t: string | undefined): string => {
      if (!t || !t.startsWith('"')) fail('Expected string');
      return JSON.parse(t!) as string;
    };
    const num = (t: string | undefined): number => {
      const v = Number(t);
      if (t === undefined || Number.isNaN(v)) fail(`Expected number, got '${t}'`);
      return v;
    };
    const list = (t: string | undefined): string[] => {
      if (!t || !t.startsWith('[')) fail('Expected [list]');
      const inner = t!.slice(1, -1).trim();
      if (!inner) return [];
      const out: string[] = [];
      let i = 0;
      while (i < inner.length) {
        if (inner[i] === ',' || inner[i] === ' ') {
          i++;
          continue;
        }
        let j = i;
        let s = false;
        for (; j < inner.length; j++) {
          const ch = inner[j]!;
          if (s) {
            if (ch === '\\') j++;
            else if (ch === '"') s = false;
          } else if (ch === '"') s = true;
          else if (ch === ',') break;
        }
        out.push(inner.slice(i, j).trim());
        i = j + 1;
      }
      return out;
    };
    const a: Avm1Action = { type: 'action', code: code!, args: [], labels: [] };
    switch (code) {
      case 0x88:
        a.args = toks.map(str);
        break;
      case 0x96:
        a.args = toks.map((t): Avm1Value => {
          if (t.startsWith('"')) return { t: 'string', v: str(t) };
          if (t === 'null') return { t: 'null' };
          if (t === 'undefined') return { t: 'undefined' };
          if (t === 'true' || t === 'false') return { t: 'boolean', v: t === 'true' };
          const m = /^([frdcC]):(.*)$/.exec(t);
          if (m) {
            const v = m[2] === 'NaN' ? NaN : num(m[2]);
            const types = { f: 'float', r: 'register', d: 'double', c: 'constant8', C: 'constant16' } as const;
            return { t: types[m[1] as keyof typeof types], v } as Avm1Value;
          }
          const v = num(t);
          return Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff ? { t: 'integer', v } : { t: 'double', v };
        });
        break;
      case 0x99:
      case 0x9d:
      case 0x94:
        a.labels = [label(toks[0] ?? fail('Expected label'))];
        break;
      case 0x9b:
        a.args = [str(toks[0]), list(toks[1]).map(str)];
        a.labels = [label(toks[2] ?? fail('Expected label'))];
        break;
      case 0x8e:
        a.args = [
          str(toks[0]),
          num(toks[1]),
          num(toks[2]),
          list(toks[3]).map((p) => {
            const m = /^(\d+):(".*")$/.exec(p);
            if (!m) fail(`Expected register:"name", got '${p}'`);
            return [Number(m![1]), JSON.parse(m![2]!)] as [number, string];
          }),
        ];
        a.labels = [label(toks[4] ?? fail('Expected label'))];
        break;
      case 0x8f:
        a.args = [num(toks[0]), toks[1]?.startsWith('r:') ? num(toks[1].slice(2)) : str(toks[1])];
        a.labels = toks.slice(2, 5).map(label);
        if (a.labels.length !== 3) fail('Try needs three labels (end of try, catch, finally)');
        break;
      case 0x83:
        a.args = [str(toks[0]), str(toks[1])];
        break;
      case 0x8b:
      case 0x8c:
        a.args = [str(toks[0])];
        break;
      default:
        a.args = toks.map(num);
    }
    items.push(a);
  });
  return items;
}
