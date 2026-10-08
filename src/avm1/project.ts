/**
 * AS1/AS2 code blocks (DoAction / DoInitAction) export & import as P-code.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Swf } from '../swf/swf.js';
import { TagCode } from '../swf/tag-codes.js';
import { RawTag } from '../swf/tags.js';
import { decodeActions, encodeActions, formatActions, parseActions } from './avm1.js';

export interface ActionBlock {
  /** Stable file key, e.g. "root_f3_t17" or "sprite12_f0_t2_init". */
  key: string;
  tag: RawTag;
  /** Byte offset of the action stream inside the tag body (2 for DoInitAction). */
  offset: number;
}

/** All AVM1 code blocks of an SWF (main timeline and sprites). */
export function actionBlocks(swf: Swf): ActionBlock[] {
  const out: ActionBlock[] = [];
  const frames = new Map<unknown, number>();
  for (const { tag, parent, index } of swf.walkTags()) {
    const owner = parent ?? swf;
    if (tag.code === TagCode.ShowFrame) frames.set(owner, (frames.get(owner) ?? 0) + 1);
    if (!(tag instanceof RawTag) || (tag.code !== TagCode.DoAction && tag.code !== TagCode.DoInitAction)) continue;
    const scope = parent ? `sprite${parent.spriteId}` : 'root';
    const init = tag.code === TagCode.DoInitAction;
    const key = `${scope}_f${frames.get(owner) ?? 0}_t${index}${init ? `_init${tag.data[0]! | (tag.data[1]! << 8)}` : ''}`;
    out.push({ key, tag, offset: init ? 2 : 0 });
  }
  return out;
}

export function disassembleBlock(b: ActionBlock): string {
  return formatActions(decodeActions(b.tag.data.subarray(b.offset)));
}

export function assembleBlock(b: ActionBlock, text: string): void {
  const code = encodeActions(parseActions(text));
  const data = new Uint8Array(b.offset + code.length);
  data.set(b.tag.data.subarray(0, b.offset), 0);
  data.set(code, b.offset);
  b.tag.data = data;
}

export async function exportAs2(swf: Swf, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const b of actionBlocks(swf)) {
    let text: string;
    try {
      text = disassembleBlock(b);
    } catch (e) {
      text = `; could not decode: ${(e as Error).message}\n`;
    }
    const p = join(dir, `${b.key}.as2pcode`);
    await writeFile(p, text, 'utf8');
    files.push(p);
  }
  return files;
}

/** Re-assembles blocks whose files changed. Returns the keys that were updated. */
export async function importAs2(swf: Swf, dir: string): Promise<string[]> {
  const present = new Set(await readdir(dir));
  const changed: string[] = [];
  for (const b of actionBlocks(swf)) {
    const name = `${b.key}.as2pcode`;
    if (!present.has(name)) continue;
    const text = await readFile(join(dir, name), 'utf8');
    let current: string;
    try {
      current = disassembleBlock(b);
    } catch {
      current = '';
    }
    const norm = (s: string): string => s.split('\n').map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean).join('\n');
    if (norm(text) === norm(current)) continue;
    try {
      assembleBlock(b, text);
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
    changed.push(b.key);
  }
  return changed;
}
