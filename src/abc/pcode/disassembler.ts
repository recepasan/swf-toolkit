import type { AbcFile, MethodBody } from '../abc-file.js';
import { decodeCode, type CodeItem, type DecodedCode, type Instruction } from '../code.js';
import { METHOD_FLAG_NAMES, MethodFlags } from '../constants.js';
import { opInfo } from '../opcodes.js';
import { formatDouble, formatMultiname, formatNamespace, formatString, formatTrait, formatValue } from './format.js';

export interface DisassembleOptions {
  /** Text appended as a comment after the `method N` header. */
  title?: string;
  /** Indentation for section contents (default two spaces). */
  indent?: string;
}

const labelName = (id: number): string => `L${id}`;

function hex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Formats a single instruction (without indentation). */
export function formatInstruction(abc: AbcFile, ins: Instruction): string {
  const info = opInfo(ins.op);
  if (!info) return `.bytes ${ins.op.toString(16).padStart(2, '0')}`;
  const parts: string[] = [];
  let a = 0;
  let comment = '';
  for (const t of info.operands) {
    switch (t) {
      case 'branch':
        parts.push(labelName(ins.targets[0]!));
        break;
      case 'switch':
        parts.push(labelName(ins.targets[0]!), `[${ins.targets.slice(1).map(labelName).join(', ')}]`);
        break;
      case 'int':
        parts.push(String(abc.ints[ins.args[a++]!] ?? 0));
        break;
      case 'uint':
        parts.push(String(abc.uints[ins.args[a++]!] ?? 0));
        break;
      case 'double':
        parts.push(formatDouble(abc.doubles[ins.args[a++]!] ?? NaN));
        break;
      case 'string':
        parts.push(formatString(abc, ins.args[a++]!));
        break;
      case 'namespace':
        parts.push(formatNamespace(abc, ins.args[a++]!));
        break;
      case 'multiname':
        parts.push(formatMultiname(abc, ins.args[a++]!));
        break;
      case 'class': {
        const c = ins.args[a++]!;
        parts.push(String(c));
        comment = ` ; ${abc.className(c)}`;
        break;
      }
      default:
        parts.push(String(ins.args[a++]!));
    }
  }
  return parts.length ? `${info.name} ${parts.join(', ')}${comment}` : info.name + comment;
}

/** Formats decoded code items, one per line. */
export function formatCode(abc: AbcFile, code: DecodedCode | readonly CodeItem[], indent = '  '): string[] {
  const items = Array.isArray(code) ? code : (code as DecodedCode).items;
  const lines: string[] = [];
  for (const it of items) {
    if (it.type === 'label') lines.push(`${labelName(it.id)}:`);
    else if (it.type === 'bytes') {
      for (let i = 0; i < it.data.length; i += 16) lines.push(`${indent}.bytes ${hex(it.data.subarray(i, i + 16))}`);
    } else lines.push(indent + formatInstruction(abc, it));
  }
  return lines;
}

function formatFlags(flags: number): string | undefined {
  const names: string[] = [];
  for (const [bit, name] of METHOD_FLAG_NAMES) {
    if (flags & bit) names.push(name);
  }
  const known = [...METHOD_FLAG_NAMES.keys()].reduce((x, y) => x | y, 0);
  if (flags & ~known & 0xff) names.push(`0x${(flags & ~known & 0xff).toString(16)}`);
  return names.length ? names.join(' | ') : undefined;
}

function bodyLines(abc: AbcFile, body: MethodBody, ind: string): string[] {
  const lines: string[] = ['body'];
  let decoded: DecodedCode | undefined;
  let error: string | undefined;
  try {
    decoded = decodeCode(body.code, body.exceptions);
  } catch (e) {
    error = (e as Error).message;
  }
  lines.push(`${ind}maxstack ${body.maxStack}`);
  lines.push(`${ind}localcount ${body.localCount}`);
  lines.push(`${ind}initscopedepth ${body.initScopeDepth}`);
  lines.push(`${ind}maxscopedepth ${body.maxScopeDepth}`);
  for (const t of body.traits) lines.push(ind + formatTrait(abc, t));

  if (!decoded) {
    // Not representable with labels: emit raw code and numeric exception offsets.
    lines.push(`${ind}; WARNING: code could not be decoded (${error}); kept as raw bytes`);
    for (const e of body.exceptions) {
      lines.push(
        `${ind}try from @${e.from} to @${e.to} target @${e.target} type ${formatMultiname(abc, e.excType)} name ${formatMultiname(abc, e.varName)}`,
      );
    }
    lines.push('code');
    for (let i = 0; i < body.code.length; i += 16) lines.push(`${ind}.bytes ${hex(body.code.subarray(i, i + 16))}`);
    return lines;
  }

  for (const e of decoded.exceptions) {
    lines.push(
      `${ind}try from ${labelName(e.from)} to ${labelName(e.to)} target ${labelName(e.target)} type ${formatMultiname(abc, e.excType)} name ${formatMultiname(abc, e.varName)}`,
    );
  }
  lines.push('code');
  lines.push(...formatCode(abc, decoded, ind));
  return lines;
}

/**
 * Disassembles a method (signature + body) to P-code text. The output can be
 * edited and fed back to {@link assembleMethods}.
 */
export function disassembleMethod(abc: AbcFile, methodIndex: number, options: DisassembleOptions = {}): string {
  const ind = options.indent ?? '  ';
  const m = abc.methods[methodIndex];
  if (!m) throw new Error(`Method index ${methodIndex} out of range`);
  const lines: string[] = [`method ${methodIndex}${options.title ? ` ; ${options.title}` : ''}`];
  if (m.name !== 0) lines.push(`${ind}name ${formatString(abc, m.name)}`);
  lines.push(`${ind}returns ${formatMultiname(abc, m.returnType)}`);
  for (const p of m.paramTypes) lines.push(`${ind}param ${formatMultiname(abc, p)}`);
  const flags = formatFlags(m.flags & ~(MethodFlags.HAS_OPTIONAL | MethodFlags.HAS_PARAM_NAMES));
  if (flags) lines.push(`${ind}flags ${flags}`);
  if (m.flags & MethodFlags.HAS_OPTIONAL && m.optional.length === 0) lines.push(`${ind}flags HAS_OPTIONAL`);
  for (const o of m.optional) lines.push(`${ind}optional ${formatValue(abc, o.kind, o.value)}`);
  for (const p of m.paramNames) lines.push(`${ind}paramname ${formatString(abc, p)}`);
  if (m.flags & MethodFlags.HAS_PARAM_NAMES && m.paramNames.length === 0) lines.push(`${ind}flags HAS_PARAM_NAMES`);

  const body = abc.methodBody(methodIndex);
  if (body) lines.push(...bodyLines(abc, body, ind));
  lines.push('end');
  return lines.join('\n') + '\n';
}
