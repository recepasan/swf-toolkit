/**
 * Bitmap tags ↔ image files.
 *
 * - DefineBitsLossless / DefineBitsLossless2 ↔ PNG (with alpha)
 * - DefineBits (+ JPEGTables), DefineBitsJPEG2/3/4 → original JPEG / PNG / GIF data.
 *   JPEG3/4 alpha channels are exported as a separate grayscale PNG mask.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { ByteReader } from '../io/reader.js';
import { ByteWriter } from '../io/writer.js';
import type { Swf } from '../swf/swf.js';
import { TagCode } from '../swf/tag-codes.js';
import { RawTag, type Tag } from '../swf/tags.js';
import { decodePng, encodePng, isPng, type RgbaImage } from './png.js';

export const IMAGE_TAGS: ReadonlySet<number> = new Set([
  TagCode.DefineBits,
  TagCode.DefineBitsJPEG2,
  TagCode.DefineBitsJPEG3,
  TagCode.DefineBitsJPEG4,
  TagCode.DefineBitsLossless,
  TagCode.DefineBitsLossless2,
]);

export interface ExtractedImage {
  id: number;
  /** File extension: png, jpg or gif. */
  ext: 'png' | 'jpg' | 'gif';
  data: Uint8Array;
  /** Alpha mask (grayscale PNG) for JPEG3/4 images. */
  alphaMask?: Uint8Array;
  width?: number;
  height?: number;
}

function imageType(b: Uint8Array): 'png' | 'jpg' | 'gif' {
  if (isPng(b)) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  return 'jpg';
}

/** Removes the erroneous `FF D9 FF D8` prefix some encoders emit and merges JPEGTables. */
function cleanJpeg(data: Uint8Array, tables?: Uint8Array): Uint8Array {
  let d = data;
  if (d[0] === 0xff && d[1] === 0xd9 && d[2] === 0xff && d[3] === 0xd8) d = d.subarray(4);
  // Some files contain an EOI/SOI pair in the middle (tables + image); remove it.
  const parts: Uint8Array[] = [];
  if (tables && tables.length > 4) {
    let t = tables;
    if (t[0] === 0xff && t[1] === 0xd9 && t[2] === 0xff && t[3] === 0xd8) t = t.subarray(4);
    // tables: SOI ... EOI → drop trailing EOI; image: SOI ... → drop leading SOI
    parts.push(t[t.length - 2] === 0xff && t[t.length - 1] === 0xd9 ? t.subarray(0, -2) : t);
    parts.push(d[0] === 0xff && d[1] === 0xd8 ? d.subarray(2) : d);
  } else {
    for (let i = 2; i + 3 < d.length; i++) {
      if (d[i] === 0xff && d[i + 1] === 0xd9 && d[i + 2] === 0xff && d[i + 3] === 0xd8) {
        parts.push(d.subarray(0, i), d.subarray(i + 4));
        d = new Uint8Array(0);
        break;
      }
    }
    if (d.length) parts.push(d);
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Decodes DefineBitsLossless(2) pixel data to straight RGBA. */
export function decodeLossless(tag: RawTag): RgbaImage {
  const r = new ByteReader(tag.data);
  r.u16(); // id
  const format = r.u8();
  const width = r.u16();
  const height = r.u16();
  const alpha = tag.code === TagCode.DefineBitsLossless2;
  const colorTableSize = format === 3 ? r.u8() + 1 : 0;
  const pixels = new Uint8Array(inflateSync(r.rest()));
  const out = new Uint8Array(width * height * 4);
  const unpremul = (d: number): void => {
    const a = out[d + 3]!;
    if (a > 0 && a < 255) {
      out[d] = Math.min(255, Math.round((out[d]! * 255) / a));
      out[d + 1] = Math.min(255, Math.round((out[d + 1]! * 255) / a));
      out[d + 2] = Math.min(255, Math.round((out[d + 2]! * 255) / a));
    }
  };
  if (format === 3) {
    const entry = alpha ? 4 : 3;
    const table = pixels.subarray(0, colorTableSize * entry);
    const stride = (width + 3) & ~3;
    const base = colorTableSize * entry;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = pixels[base + y * stride + x]!;
        const d = (y * width + x) * 4;
        out[d] = table[idx * entry] ?? 0;
        out[d + 1] = table[idx * entry + 1] ?? 0;
        out[d + 2] = table[idx * entry + 2] ?? 0;
        out[d + 3] = alpha ? (table[idx * entry + 3] ?? 255) : 255;
        if (alpha) unpremul(d);
      }
    }
  } else if (format === 4) {
    const stride = (width * 2 + 3) & ~3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (pixels[y * stride + x * 2]! << 8) | pixels[y * stride + x * 2 + 1]!;
        const d = (y * width + x) * 4;
        out[d] = ((v >> 10) & 0x1f) * 255 / 31;
        out[d + 1] = ((v >> 5) & 0x1f) * 255 / 31;
        out[d + 2] = (v & 0x1f) * 255 / 31;
        out[d + 3] = 255;
      }
    }
  } else if (format === 5) {
    for (let i = 0; i < width * height; i++) {
      const s = i * 4;
      out[s] = pixels[s + 1]!;
      out[s + 1] = pixels[s + 2]!;
      out[s + 2] = pixels[s + 3]!;
      out[s + 3] = alpha ? pixels[s]! : 255;
      if (alpha) unpremul(s);
    }
  } else throw new Error(`Unsupported lossless bitmap format ${format}`);
  return { width, height, data: out };
}

/** Extracts the image stored in a bitmap tag. */
export function extractImage(tag: Tag, jpegTables?: Uint8Array): ExtractedImage | undefined {
  if (!(tag instanceof RawTag) || !IMAGE_TAGS.has(tag.code)) return undefined;
  const id = tag.characterId!;
  const r = new ByteReader(tag.data);
  r.u16();
  switch (tag.code) {
    case TagCode.DefineBitsLossless:
    case TagCode.DefineBitsLossless2: {
      const img = decodeLossless(tag);
      return { id, ext: 'png', data: encodePng(img), width: img.width, height: img.height };
    }
    case TagCode.DefineBits:
      return { id, ext: 'jpg', data: cleanJpeg(r.rest(), jpegTables) };
    case TagCode.DefineBitsJPEG2: {
      const d = r.rest();
      const ext = imageType(d);
      return { id, ext, data: ext === 'jpg' ? cleanJpeg(d) : d.slice() };
    }
    case TagCode.DefineBitsJPEG3:
    case TagCode.DefineBitsJPEG4: {
      const alphaOffset = r.u32();
      if (tag.code === TagCode.DefineBitsJPEG4) r.u16(); // deblock
      const d = r.bytesView(alphaOffset);
      const ext = imageType(d);
      const result: ExtractedImage = { id, ext, data: ext === 'jpg' ? cleanJpeg(d) : d.slice() };
      const alphaZ = r.rest();
      if (ext === 'jpg' && alphaZ.length) {
        const dims = jpegSize(result.data);
        if (dims) {
          const a = new Uint8Array(inflateSync(alphaZ));
          const rgba = new Uint8Array(dims.width * dims.height * 4);
          for (let i = 0; i < dims.width * dims.height; i++) {
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = a[i] ?? 255;
            rgba[i * 4 + 3] = 255;
          }
          result.alphaMask = encodePng({ width: dims.width, height: dims.height, data: rgba });
          result.width = dims.width;
          result.height = dims.height;
        }
      }
      return result;
    }
  }
  return undefined;
}

/** Reads width/height from a JPEG's SOF marker. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    i += 2 + len;
  }
  return undefined;
}

/** Builds a DefineBitsLossless2 tag body from an RGBA image. */
export function encodeLossless2(id: number, img: RgbaImage): Uint8Array {
  const { width, height, data } = img;
  const argb = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3]!;
    const s = i * 4;
    argb[s] = a;
    argb[s + 1] = Math.round((data[s]! * a) / 255);
    argb[s + 2] = Math.round((data[s + 1]! * a) / 255);
    argb[s + 3] = Math.round((data[s + 2]! * a) / 255);
  }
  const w = new ByteWriter(argb.length / 2 + 16);
  w.u16(id).u8(5).u16(width).u16(height);
  w.bytes(new Uint8Array(deflateSync(argb, { level: 9 })));
  return w.toBytes();
}

/**
 * Replaces the bitmap with character `id`. PNG files become
 * DefineBitsLossless2 (exact pixels, alpha); JPEG / GIF files are stored
 * as DefineBitsJPEG2.
 */
export function replaceImage(swf: Swf, id: number, file: Uint8Array): Tag {
  for (const { tag, parent, index } of swf.walkTags()) {
    if (tag.characterId !== id) continue;
    if (!IMAGE_TAGS.has(tag.code)) throw new Error(`Character ${id} is a ${tag.name}, not a bitmap`);
    let next: RawTag;
    if (isPng(file)) next = new RawTag(TagCode.DefineBitsLossless2, encodeLossless2(id, decodePng(file)));
    else {
      const w = new ByteWriter(file.length + 2);
      w.u16(id).bytes(file);
      next = new RawTag(TagCode.DefineBitsJPEG2, w.toBytes());
    }
    next.longHeader = true;
    (parent ? parent.tags : swf.tags)[index] = next;
    return next;
  }
  throw new Error(`No character with id ${id}`);
}
