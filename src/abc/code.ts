/**
 * AVM2 method body code: decoding to a label-based instruction list and
 * encoding back to bytes.
 */
import { ByteReader } from '../io/reader.js';
import { ByteWriter } from '../io/writer.js';
import type { ExceptionInfo } from './abc-file.js';
import { opInfo, type OperandType } from './opcodes.js';

export interface Instruction {
  type: 'op';
  op: number;
  /** Non-branch operands in declaration order. */
  args: number[];
  /** Label ids of branch targets. lookupswitch: [default, case0, case1, ...]. */
  targets: number[];
  /** Byte offset in the original code (-1 for new instructions). */
  offset: number;
}

export interface LabelItem {
  type: 'label';
  id: number;
}

/** Bytes that are not reachable / not decodable; kept verbatim. */
export interface BytesItem {
  type: 'bytes';
  data: Uint8Array;
}

export type CodeItem = Instruction | LabelItem | BytesItem;

/** Exception table entry with label ids instead of byte offsets. */
export interface CodeException {
  from: number;
  to: number;
  target: number;
  excType: number;
  varName: number;
}

export interface DecodedCode {
  items: CodeItem[];
  exceptions: CodeException[];
  /** Next free label id. */
  nextLabel: number;
}

export function insn(op: number, args: number[] = [], targets: number[] = []): Instruction {
  return { type: 'op', op, args, targets, offset: -1 };
}

export class CodeDecodeError extends Error {
  override name = "CodeDecodeError";
}

interface RawInsn {
  op: number;
  args: number[];
  /** Absolute target offsets. */
  targets: number[];
  length: number;
}

function readInsn(code: Uint8Array, pos: number): RawInsn | null {
  const info = opInfo(code[pos]!);
  if (!info) return null;
  const r = new ByteReader(code, pos + 1);
  const args: number[] = [];
  const targets: number[] = [];
  try {
    for (const t of info.operands) {
      switch (t) {
        case 'u8':
          args.push(r.u8());
          break;
        case 's8':
          args.push(r.s8());
          break;
        case 'short':
          args.push(r.encodedU32() | 0);
          break;
        case 'branch': {
          const off = r.s24();
          targets.push(r.pos + off);
          break;
        }
        case 'switch': {
          targets.push(pos + r.s24());
          const count = r.encodedU32();
          for (let i = 0; i <= count; i++) targets.push(pos + r.s24());
          break;
        }
        default:
          args.push(r.encodedU32());
      }
    }
  } catch {
    return null;
  }
  return { op: info.code, args, targets, length: r.pos - pos };
}

function isTerminal(op: number): boolean {
  const f = opInfo(op)?.flow;
  return f === 'jump' || f === 'switch' || f === 'return' || f === 'throw';
}

/**
 * Decodes method code. Instructions are discovered by following control flow
 * from the entry point and exception handlers, so junk bytes inserted by
 * obfuscators are preserved as {@link BytesItem}s instead of breaking decoding.
 * Falls back to linear decoding when control flow overlaps instructions.
 *
 * Throws if the code cannot be represented with labels (e.g. branches
 * outside the method).
 */
export function decodeCode(code: Uint8Array, exceptions: readonly ExceptionInfo[]): DecodedCode {
  try {
    return decodeWith(code, exceptions, flowDecode(code, exceptions));
  } catch (e) {
    if (!(e instanceof CodeDecodeError)) throw e;
    return decodeWith(code, exceptions, linearDecode(code));
  }
}

function flowDecode(code: Uint8Array, exceptions: readonly ExceptionInfo[]): Map<number, RawInsn> {
  const len = code.length;
  const owner = new Int32Array(len).fill(-1); // start offset of the instruction covering each byte
  const insns = new Map<number, RawInsn>();
  const work: number[] = [0];
  for (const e of exceptions) work.push(e.target);

  while (work.length > 0) {
    let pos = work.pop()!;
    while (pos >= 0 && pos < len) {
      if (insns.has(pos)) break;
      if (owner[pos] !== -1) throw new CodeDecodeError(`Overlapping instruction at ${pos}`);
      const ins = readInsn(code, pos);
      // Unknown opcode, or a branch leaving the method: keep as raw bytes.
      if (!ins || ins.targets.some((t) => t < 0 || t > len)) break;
      for (let i = 0; i < ins.length; i++) {
        if (owner[pos + i] !== -1) throw new CodeDecodeError(`Overlapping instruction at ${pos + i}`);
        owner[pos + i] = pos;
      }
      insns.set(pos, ins);
      for (const t of ins.targets) work.push(t);
      if (isTerminal(ins.op)) break;
      pos += ins.length;
    }
  }
  decodeGaps(code, insns);
  return insns;
}

/**
 * Unreachable regions (dead code emitted by compilers, or obfuscator junk)
 * are decoded linearly when they decode cleanly into whole instructions whose
 * branch targets are valid; otherwise they stay raw bytes.
 */
function decodeGaps(code: Uint8Array, insns: Map<number, RawInsn>): void {
  const len = code.length;
  const sorted = [...insns.keys()].sort((a, b) => a - b);
  const gaps: Array<{ start: number; end: number }> = [];
  let pos = 0;
  for (const s of sorted) {
    if (s > pos) gaps.push({ start: pos, end: s });
    pos = Math.max(pos, s + insns.get(s)!.length);
  }
  if (pos < len) gaps.push({ start: pos, end: len });

  const candidates: Array<Map<number, RawInsn>> = [];
  for (const g of gaps) {
    const found = new Map<number, RawInsn>();
    let p = g.start;
    let ok = true;
    while (p < g.end) {
      const ins = readInsn(code, p);
      if (!ins || p + ins.length > g.end || ins.targets.some((t) => t < 0 || t > len)) {
        ok = false;
        break;
      }
      found.set(p, ins);
      p += ins.length;
    }
    if (ok && found.size > 0) candidates.push(found);
  }

  // Accept gap decodings whose targets all land on instruction boundaries.
  let changed = true;
  let accepted = candidates;
  while (changed) {
    changed = false;
    const starts = new Set<number>(insns.keys());
    for (const c of accepted) for (const k of c.keys()) starts.add(k);
    starts.add(len);
    const next = accepted.filter((c) => {
      for (const ins of c.values()) for (const t of ins.targets) if (!starts.has(t)) return false;
      return true;
    });
    if (next.length !== accepted.length) {
      accepted = next;
      changed = true;
    }
  }
  for (const c of accepted) for (const [k, v] of c) insns.set(k, v);
}

function linearDecode(code: Uint8Array): Map<number, RawInsn> {
  const insns = new Map<number, RawInsn>();
  let pos = 0;
  while (pos < code.length) {
    const ins = readInsn(code, pos);
    if (!ins) {
      pos++;
      continue;
    }
    insns.set(pos, ins);
    pos += ins.length;
  }
  return insns;
}

function decodeWith(code: Uint8Array, exceptions: readonly ExceptionInfo[], insns: Map<number, RawInsn>): DecodedCode {
  const len = code.length;
  const starts = new Uint8Array(len + 1); // 1 = instruction start, 2 = inside instruction
  for (const [pos, ins] of insns) {
    starts[pos] = 1;
    for (let i = 1; i < ins.length; i++) starts[pos + i] = 2;
  }

  const labelAt = new Map<number, number>();
  let nextLabel = 0;
  const label = (offset: number): number => {
    if (offset < 0 || offset > len) throw new CodeDecodeError(`Branch/exception offset ${offset} outside code (0..${len})`);
    if (starts[offset] === 2) throw new CodeDecodeError(`Offset ${offset} points inside an instruction`);
    let id = labelAt.get(offset);
    if (id === undefined) {
      id = nextLabel++;
      labelAt.set(offset, id);
    }
    return id;
  };

  // Allocate labels in offset order for readable output.
  const wanted = new Set<number>();
  for (const ins of insns.values()) for (const t of ins.targets) wanted.add(t);
  for (const e of exceptions) {
    wanted.add(e.from);
    wanted.add(e.to);
    wanted.add(e.target);
  }
  for (const off of [...wanted].sort((a, b) => a - b)) label(off);

  const items: CodeItem[] = [];
  let rawStart = -1;
  const flushRaw = (end: number): void => {
    if (rawStart >= 0) {
      items.push({ type: 'bytes', data: code.slice(rawStart, end) });
      rawStart = -1;
    }
  };

  let pos = 0;
  while (pos <= len) {
    const l = labelAt.get(pos);
    if (l !== undefined) {
      flushRaw(pos);
      items.push({ type: 'label', id: l });
    }
    if (pos === len) break;
    const ins = insns.get(pos);
    if (ins) {
      flushRaw(pos);
      items.push({
        type: 'op',
        op: ins.op,
        args: ins.args,
        targets: ins.targets.map((t) => labelAt.get(t)!),
        offset: pos,
      });
      pos += ins.length;
    } else {
      if (rawStart < 0) rawStart = pos;
      pos++;
    }
  }
  flushRaw(len);

  return {
    items,
    exceptions: exceptions.map((e) => ({
      from: labelAt.get(e.from)!,
      to: labelAt.get(e.to)!,
      target: labelAt.get(e.target)!,
      excType: e.excType,
      varName: e.varName,
    })),
    nextLabel,
  };
}

function u30Size(v: number): number {
  v >>>= 0;
  let n = 1;
  while (v >= 0x80) {
    v >>>= 7;
    n++;
  }
  return n;
}

function operandSize(t: OperandType, value: number): number {
  switch (t) {
    case 'u8':
    case 's8':
      return 1;
    case 'branch':
      return 3;
    default:
      return u30Size(value);
  }
}

/** Encoded size of an instruction in bytes. */
export function instructionSize(i: Instruction): number {
  const info = opInfo(i.op);
  if (!info) throw new Error(`Unknown opcode 0x${i.op.toString(16)}`);
  let size = 1;
  let argIndex = 0;
  for (const t of info.operands) {
    if (t === 'switch') {
      if (i.targets.length < 2) throw new Error('lookupswitch needs a default target and at least one case');
      size += 3 + u30Size(i.targets.length - 2) + 3 * (i.targets.length - 1);
    } else if (t === 'branch') {
      size += 3;
    } else {
      size += operandSize(t, i.args[argIndex++] ?? 0);
    }
  }
  return size;
}

export interface EncodedCode {
  code: Uint8Array;
  exceptions: ExceptionInfo[];
  /** Byte offset of every label id. */
  labelOffsets: Map<number, number>;
}

/** Encodes a label-based instruction list back into bytecode. */
export function encodeCode(items: readonly CodeItem[], exceptions: readonly CodeException[] = []): EncodedCode {
  const labelOffsets = new Map<number, number>();
  let offset = 0;
  for (const item of items) {
    if (item.type === 'label') {
      if (labelOffsets.has(item.id)) throw new Error(`Label ${item.id} defined twice`);
      labelOffsets.set(item.id, offset);
    } else if (item.type === 'bytes') offset += item.data.length;
    else offset += instructionSize(item);
  }

  const target = (id: number): number => {
    const o = labelOffsets.get(id);
    if (o === undefined) throw new Error(`Undefined label ${id}`);
    return o;
  };

  const w = new ByteWriter(offset + 16);
  for (const item of items) {
    if (item.type === 'label') continue;
    if (item.type === 'bytes') {
      w.bytes(item.data);
      continue;
    }
    const start = w.length;
    const info = opInfo(item.op)!;
    w.u8(item.op);
    let argIndex = 0;
    for (const t of info.operands) {
      switch (t) {
        case 'u8':
          w.u8(item.args[argIndex++] ?? 0);
          break;
        case 's8':
          w.s8(item.args[argIndex++] ?? 0);
          break;
        case 'branch': {
          const end = w.length + 3;
          w.s24(target(item.targets[0]!) - end);
          break;
        }
        case 'switch': {
          w.s24(target(item.targets[0]!) - start);
          w.encodedU32(item.targets.length - 2);
          for (let k = 1; k < item.targets.length; k++) w.s24(target(item.targets[k]!) - start);
          break;
        }
        default:
          w.encodedU32((item.args[argIndex++] ?? 0) >>> 0);
      }
    }
  }

  return {
    code: w.toBytes(),
    exceptions: exceptions.map((e) => ({
      from: target(e.from),
      to: target(e.to),
      target: target(e.target),
      excType: e.excType,
      varName: e.varName,
    })),
    labelOffsets,
  };
}
