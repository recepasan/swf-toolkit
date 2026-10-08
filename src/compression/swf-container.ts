import { deflateSync, inflateSync } from 'node:zlib';
import { SwfFormatError } from '../errors.js';
import { lzmaCompress, lzmaDecompress, type LzmaCompressOptions } from './lzma.js';

export type SwfCompression = 'none' | 'zlib' | 'lzma';

export interface SwfContainer {
  compression: SwfCompression;
  version: number;
  /** Uncompressed SWF body: everything after the 8-byte file header. */
  body: Uint8Array;
}

const SIG = {
  FWS: [0x46, 0x57, 0x53],
  CWS: [0x43, 0x57, 0x53],
  ZWS: [0x5a, 0x57, 0x53],
} as const;

function sigIs(b: Uint8Array, sig: readonly number[]): boolean {
  return b[0] === sig[0] && b[1] === sig[1] && b[2] === sig[2];
}

function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** Detects whether a buffer starts with an SWF signature. */
export function isSwf(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && (sigIs(bytes, SIG.FWS) || sigIs(bytes, SIG.CWS) || sigIs(bytes, SIG.ZWS));
}

/** Unwraps an FWS/CWS/ZWS file into its uncompressed body. */
export function unpackSwf(bytes: Uint8Array): SwfContainer {
  if (bytes.length < 8) throw new SwfFormatError('File too small to be an SWF');
  const version = bytes[3]!;
  const fileLength = u32(bytes, 4);
  const bodyLength = fileLength - 8;
  if (bodyLength < 0) throw new SwfFormatError(`Invalid SWF file length ${fileLength}`);

  if (sigIs(bytes, SIG.FWS)) {
    // Some tools write a wrong length; trust the actual data when it is shorter.
    const body = bytes.subarray(8, Math.min(bytes.length, fileLength)).slice();
    return { compression: 'none', version, body };
  }

  if (sigIs(bytes, SIG.CWS)) {
    let body: Uint8Array;
    try {
      body = new Uint8Array(inflateSync(bytes.subarray(8), { finishFlush: 2 /* Z_SYNC_FLUSH: tolerate truncated streams */ }));
    } catch (e) {
      throw new SwfFormatError(`zlib decompression failed: ${(e as Error).message}`);
    }
    if (body.length > bodyLength) body = body.subarray(0, bodyLength);
    return { compression: 'zlib', version, body };
  }

  if (sigIs(bytes, SIG.ZWS)) {
    if (bytes.length < 17) throw new SwfFormatError('Truncated ZWS header');
    const compressedLength = u32(bytes, 8);
    const props = bytes.subarray(12, 17);
    const data = bytes.subarray(17, Math.min(bytes.length, 17 + compressedLength));
    const body = lzmaDecompress(props, data, bodyLength);
    return { compression: 'lzma', version, body };
  }

  throw new SwfFormatError('Not an SWF file (missing FWS/CWS/ZWS signature)');
}

export interface PackOptions {
  /** zlib level 0-9 (default 9). */
  zlibLevel?: number;
  lzma?: LzmaCompressOptions;
}

/** Wraps an uncompressed SWF body in an FWS/CWS/ZWS file. */
export function packSwf(container: SwfContainer, options: PackOptions = {}): Uint8Array {
  const { body, version, compression } = container;
  const fileLength = body.length + 8;
  const header = (sig: readonly number[]): Uint8Array => {
    const h = new Uint8Array(8);
    h.set(sig, 0);
    h[3] = version;
    new DataView(h.buffer).setUint32(4, fileLength, true);
    return h;
  };

  if (compression === 'none') {
    const out = new Uint8Array(fileLength);
    out.set(header(SIG.FWS), 0);
    out.set(body, 8);
    return out;
  }

  if (compression === 'zlib') {
    const z = deflateSync(body, { level: options.zlibLevel ?? 9 });
    const out = new Uint8Array(8 + z.length);
    out.set(header(SIG.CWS), 0);
    out.set(z, 8);
    return out;
  }

  const { props, data } = lzmaCompress(body, options.lzma);
  const out = new Uint8Array(17 + data.length);
  out.set(header(SIG.ZWS), 0);
  new DataView(out.buffer).setUint32(8, data.length, true);
  out.set(props, 12);
  out.set(data, 17);
  return out;
}
