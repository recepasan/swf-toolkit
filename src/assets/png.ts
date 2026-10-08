/**
 * Minimal PNG encoder / decoder (8-bit RGBA output, all standard colour types
 * with bit depth 8 on input; 1/2/4-bit palette and grayscale also accepted).
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA, row-major. */
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return crc >>> 0;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(b: Uint8Array): boolean {
  return SIGNATURE.every((v, i) => b[i] === v);
}

export function encodePng(img: RgbaImage, options: { level?: number } = {}): Uint8Array {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: options.level ?? 9 });
  const chunks: Uint8Array[] = [];
  const chunk = (type: string, body: Uint8Array): void => {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)) ^ 0xffffffff);
    chunks.push(out);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  chunk('IHDR', ihdr);
  chunk('IDAT', new Uint8Array(idat));
  chunk('IEND', new Uint8Array(0));
  const total = 8 + chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  let o = 8;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!isPng(bytes)) throw new Error('Not a PNG file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      depth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (interlace) throw new Error('Interlaced PNG files are not supported');
  if (depth === 16) throw new Error('16-bit PNG files are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);
  const total = idat.reduce((a, c) => a + c.length, 0);
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    z.set(c, o);
    o += c.length;
  }
  const raw = new Uint8Array(inflateSync(z));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  const pixels = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let v = line[x]!;
      switch (filter) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: v += paeth(a, b, c); break;
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }

  const out = new Uint8Array(width * height * 4);
  const sample = (row: Uint8Array, i: number): number => {
    if (depth === 8) return row[i]!;
    const bit = i * depth;
    return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const scale = depth === 8 ? 1 : 255 / ((1 << depth) - 1);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      switch (colorType) {
        case 0: {
          const g = sample(row, x);
          const v = Math.round(g * scale);
          out[d] = out[d + 1] = out[d + 2] = v;
          out[d + 3] = trns && trns.length >= 2 && ((trns[0]! << 8) | trns[1]!) === g ? 0 : 255;
          break;
        }
        case 2:
          out[d] = row[x * 3]!;
          out[d + 1] = row[x * 3 + 1]!;
          out[d + 2] = row[x * 3 + 2]!;
          out[d + 3] = 255;
          break;
        case 3: {
          const idx = sample(row, x);
          out[d] = palette?.[idx * 3] ?? 0;
          out[d + 1] = palette?.[idx * 3 + 1] ?? 0;
          out[d + 2] = palette?.[idx * 3 + 2] ?? 0;
          out[d + 3] = trns && idx < trns.length ? trns[idx]! : 255;
          break;
        }
        case 4:
          out[d] = out[d + 1] = out[d + 2] = row[x * 2]!;
          out[d + 3] = row[x * 2 + 1]!;
          break;
        case 6:
          out.set(row.subarray(x * 4, x * 4 + 4), d);
          break;
      }
    }
  }
  return { width, height, data: out };
}
