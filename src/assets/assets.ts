/**
 * Export / replace SWF resources: bitmaps, sounds, binary data and edit-text strings.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ByteReader } from '../io/reader.js';
import { ByteWriter } from '../io/writer.js';
import type { Swf } from '../swf/swf.js';
import { TagCode } from '../swf/tag-codes.js';
import { DefineBinaryDataTag, RawTag, SymbolTableTag, type Tag } from '../swf/tags.js';
import { extractImage, IMAGE_TAGS, replaceImage } from './images.js';
import { extractSound, replaceSound } from './sounds.js';

export type AssetKind = 'images' | 'sounds' | 'binary' | 'texts';
export const ALL_ASSET_KINDS: AssetKind[] = ['images', 'sounds', 'binary', 'texts'];

export interface ExportAssetsResult {
  files: string[];
  /** Characters that could not be exported, with the reason. */
  skipped: Array<{ id: number; reason: string }>;
}

/** Class / export names per character id (SymbolClass + ExportAssets). */
export function symbolNames(swf: Swf): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const { tag } of swf.walkTags()) {
    if (!(tag instanceof SymbolTableTag)) continue;
    for (const s of tag.symbols) map.set(s.id, [...(map.get(s.id) ?? []), s.name]);
  }
  return map;
}

/** Initial text of a DefineEditText tag (undefined when it has none). */
export function editTextOf(tag: RawTag): { text: string; offset: number; end: number } | undefined {
  const r = new ByteReader(tag.data);
  r.u16(
);
  const bits = r.ub(5);
  r.ub(bits * 4);
  r.align();
  const f1 = r.u8();
  const f2 = r.u8();
  if (f1 & 0x01) r.u16();
  if (f2 & 0x80) r.cstring();
  if (f1 & 0x01) r.u16();
  if (f1 & 0x04) r.u32();
  if (f1 & 0x02) r.u16();
  if (f2 & 0x20) r.bytesView(9);
  r.cstring(); // variable name
  if (!(f1 & 0x80)) return undefined;
  const offset = r.pos;
  const text = r.cstring();
  return { text, offset, end: r.pos };
}

/** Writes resources into `outDir/<kind>/<id>[_<symbol>].<ext>`. */
export async function exportAssets(swf: Swf, outDir: string, kinds: AssetKind[] = ALL_ASSET_KINDS): Promise<ExportAssetsResult> {
  const result: ExportAssetsResult = { files: [], skipped: [] };
  const names = symbolNames(swf);
  let jpegTables: Uint8Array | undefined;
  for (const { tag } of swf.walkTags()) {
    if (tag.code === TagCode.JPEGTables && tag instanceof RawTag) jpegTables = tag.data;
  }
  const fileName = (id: number, ext: string): string => {
    const sym = names.get(id)?.[0];
    const safe = sym ? '_' + sym.replace(/[^A-Za-z0-9_.$-]/g, '_') : '';
    return `${id}${safe}.${ext}`;
  };
  const write = async (kind: string, name: string, data: Uint8Array | string): Promise<void> => {
    const dir = join(outDir, kind);
    await mkdir(dir, { recursive: true });
    const p = join(dir, name);
    await writeFile(p, data);
    result.files.push(p);
  };

  for (const { tag } of swf.walkTags()) {
    const id = tag.characterId;
    if (id === undefined) continue;
    try {
      if (kinds.includes('images') && IMAGE_TAGS.has(tag.code)) {
        const img = extractImage(tag, jpegTables);
        if (img) {
          await write('images', fileName(id, img.ext), img.data);
          if (img.alphaMask) await write('images', fileName(id, 'alpha.png'), img.alphaMask);
        }
      } else if (kinds.includes('sounds') && tag.code === TagCode.DefineSound) {
        const s = extractSound(tag);
        if (s) await write('sounds', fileName(id, s.ext), s.data);
      } else if (kinds.includes('binary') && tag instanceof DefineBinaryDataTag) {
        await write('binary', fileName(id, 'bin'), tag.data);
      } else if (kinds.includes('texts') && tag.code === TagCode.DefineEditText && tag instanceof RawTag) {
        const t = editTextOf(tag);
        if (t) await write('texts', fileName(id, 'txt'), t.text);
      }
    } catch (e) {
      result.skipped.push({ id, reason: (e as Error).message });
    }
  }
  return result;
}

/** Replaces a DefineEditText's initial text. */
export function replaceEditText(swf: Swf, id: number, text: string): Tag {
  for (const { tag } of swf.walkTags()) {
    if (tag.characterId !== id || tag.code !== TagCode.DefineEditText || !(tag instanceof RawTag)) continue;
    const t = editTextOf(tag);
    const w = new ByteWriter(tag.data.length + text.length * 3);
    if (t) {
      w.bytes(tag.data.subarray(0, t.offset));
      w.cstring(text);
      w.bytes(tag.data.subarray(t.end));
    } else {
      // Set HasText and append the text.
      const data = tag.data.slice();
      const r = new ByteReader(data);
      r.u16();
      const bits = r.ub(5);
      r.ub(bits * 4);
      r.align();
      data[r.pos]! |= 0x80;
      w.bytes(data);
      w.cstring(text);
    }
    tag.data = w.toBytes();
    return tag;
  }
  throw new Error(`No DefineEditText with id ${id}`);
}

/** Replaces the resource with character `id` using a file's contents (type chosen by the tag). */
export function replaceAsset(swf: Swf, id: number, file: Uint8Array): Tag {
  const tag = swf.findCharacter(id);
  if (!tag) throw new Error(`No character with id ${id}`);
  if (IMAGE_TAGS.has(tag.code)) return replaceImage(swf, id, file);
  if (tag.code === TagCode.DefineSound) return replaceSound(swf, id, file);
  if (tag instanceof DefineBinaryDataTag) {
    tag.data = file.slice();
    return tag;
  }
  if (tag.code === TagCode.DefineEditText) return replaceEditText(swf, id, new TextDecoder().decode(file));
  throw new Error(`Replacing ${tag.name} (id ${id}) is not supported`);
}
