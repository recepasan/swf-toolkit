/**
 * DefineSound ↔ audio files: MP3 passthrough, uncompressed PCM / ADPCM → WAV,
 * MP3 / WAV import.
 */
import { ByteReader } from '../io/reader.js';
import { ByteWriter } from '../io/writer.js';
import type { Swf } from '../swf/swf.js';
import { TagCode } from '../swf/tag-codes.js';
import { RawTag, type Tag } from '../swf/tags.js';

export const SOUND_RATES = [5512, 11025, 22050, 44100];

export interface SoundInfo {
  id: number;
  /** 0 native PCM, 1 ADPCM, 2 MP3, 3 PCM LE, 4-6 Nellymoser, 11 Speex. */
  format: number;
  rate: number;
  bits: 8 | 16;
  channels: 1 | 2;
  sampleCount: number;
  data: Uint8Array;
}

export function parseDefineSound(tag: RawTag): SoundInfo {
  const r = new ByteReader(tag.data);
  const id = r.u16();
  const flags = r.u8();
  return {
    id,
    format: flags >> 4,
    rate: SOUND_RATES[(flags >> 2) & 3]!,
    bits: flags & 2 ? 16 : 8,
    channels: flags & 1 ? 2 : 1,
    sampleCount: r.u32(),
    data: r.rest(),
  };
}

export function encodeWav(pcm: Uint8Array, rate: number, channels: number, bits: number): Uint8Array {
  const w = new ByteWriter(pcm.length + 44);
  const str = (s: string): void => {
    for (const c of s) w.u8(c.charCodeAt(0));
  };
  str('RIFF');
  w.u32(36 + pcm.length);
  str('WAVE');
  str('fmt ');
  w.u32(16).u16(1).u16(channels).u32(rate).u32((rate * channels * bits) / 8).u16((channels * bits) / 8).u16(bits);
  str('data');
  w.u32(pcm.length);
  w.bytes(pcm);
  return w.toBytes();
}

const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190,
  209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385,
  24623, 27086, 29794, 32767,
];
const INDEX_TABLES = [
  [-1, 2],
  [-1, -1, 2, 4],
  [-1, -1, -1, -1, 2, 4, 6, 8],
  [-1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16],
];

/** Decodes SWF ADPCM to 16-bit little-endian PCM. */
export function decodeAdpcm(data: Uint8Array, channels: number, sampleCount: number): Uint8Array {
  const r = new ByteReader(data);
  const bitsTotal = data.length * 8;
  let bitsRead = 0;
  const ub = (n: number): number => {
    bitsRead += n;
    return r.ub(n);
  };
  const sb = (n: number): number => {
    bitsRead += n;
    return r.sb(n);
  };
  const nb = ub(2) + 2;
  const table = INDEX_TABLES[nb - 2]!;
  const signMask = 1 << (nb - 1);
  const out = new Int16Array(sampleCount * channels);
  let o = 0;
  const pred = [0, 0];
  const index = [0, 0];
  outer: while (o < out.length) {
    if (bitsRead + channels * 22 > bitsTotal) break;
    for (let c = 0; c < channels; c++) {
      pred[c] = sb(16);
      index[c] = ub(6);
      out[o++] = pred[c]!;
    }
    for (let i = 0; i < 4095 && o < out.length; i++) {
      for (let c = 0; c < channels; c++) {
        if (bitsRead + nb > bitsTotal) break outer;
        const code = ub(nb);
        let step = STEP_TABLE[index[c]!]!;
        let diff = step >> (nb - 1);
        for (let k = signMask >> 1; k; k >>= 1) {
          if (code & k) diff += step;
          step >>= 1;
        }
        let p = pred[c]! + (code & signMask ? -diff : diff);
        p = Math.max(-32768, Math.min(32767, p));
        pred[c] = p;
        index[c] = Math.max(0, Math.min(88, index[c]! + table[code & ~signMask]!));
        out[o++] = p;
      }
    }
  }
  return new Uint8Array(out.buffer, 0, o * 2);
}

export interface ExtractedSound {
  id: number;
  ext: 'mp3' | 'wav' | 'nelly' | 'speex';
  data: Uint8Array;
  info: Omit<SoundInfo, 'data'>;
}

export function extractSound(tag: Tag): ExtractedSound | undefined {
  if (!(tag instanceof RawTag) || tag.code !== TagCode.DefineSound) return undefined;
  const s = parseDefineSound(tag);
  const { data, ...info } = s;
  switch (s.format) {
    case 2:
      return { id: s.id, ext: 'mp3', data: data.subarray(2).slice(), info };
    case 0:
    case 3:
      return { id: s.id, ext: 'wav', data: encodeWav(data, s.rate, s.channels, s.bits), info };
    case 1:
      return { id: s.id, ext: 'wav', data: encodeWav(decodeAdpcm(data, s.channels, s.sampleCount), s.rate, s.channels, 16), info };
    case 11:
      return { id: s.id, ext: 'speex', data: data.slice(), info };
    default:
      return { id: s.id, ext: 'nelly', data: data.slice(), info };
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as Record<number, number[]>;

export interface Mp3Info {
  rate: number;
  channels: 1 | 2;
  sampleCount: number;
  /** Offset of the first frame (after ID3v2). */
  start: number;
  end: number;
}

export function parseMp3(b: Uint8Array): Mp3Info {
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    i = 10 + size;
  }
  let start = -1;
  let rate = 0;
  let channels: 1 | 2 = 2;
  let samples = 0;
  let end = i;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) {
      if (start >= 0) break;
      i++;
      continue;
    }
    const version = (b[i + 1]! >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (b[i + 1]! >> 1) & 3; // 1 = layer III
    const brIdx = b[i + 2]! >> 4;
    const srIdx = (b[i + 2]! >> 2) & 3;
    const pad = (b[i + 2]! >> 1) & 1;
    if (version === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
      if (start >= 0) break;
      i++;
      continue;
    }
    const sr = MP3_RATES[version]![srIdx]!;
    const br = (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[brIdx]! * 1000;
    const len = Math.floor(((version === 3 ? 144 : 72) * br) / sr) + pad;
    if (start < 0) {
      start = i;
      rate = sr;
      channels = (b[i + 3]! >> 6) === 3 ? 1 : 2;
    }
    samples += version === 3 ? 1152 : 576;
    i += len;
    end = Math.min(i, b.length);
  }
  if (start < 0) throw new Error('No MP3 frames found');
  return { rate, channels, sampleCount: samples, start, end };
}

function rateCode(rate: number): number {
  const i = SOUND_RATES.indexOf(rate === 5513 ? 5512 : rate);
  if (i < 0) throw new Error(`Sample rate ${rate} Hz is not supported by SWF (use 5512, 11025, 22050 or 44100)`);
  return i;
}

/** Builds a DefineSound body from an MP3 or WAV file. */
export function encodeDefineSound(id: number, file: Uint8Array): Uint8Array {
  const w = new ByteWriter(file.length + 16);
  const isWav = file[0] === 0x52 && file[1] === 0x49 && file[2] === 0x46 && file[3] === 0x46;
  if (isWav) {
    const r = new ByteReader(file, 12);
    let fmt: { channels: number; rate: number; bits: number } | undefined;
    let pcm: Uint8Array | undefined;
    while (r.remaining >= 8) {
      const ck = String.fromCharCode(...r.bytesView(4));
      const len = r.u32();
      const body = r.bytesView(Math.min(len, r.remaining));
      if (ck === 'fmt ') {
        const f = new ByteReader(body);
        if (f.u16() !== 1) throw new Error('Only PCM WAV files are supported');
        fmt = { channels: f.u16(), rate: f.u32(), bits: (f.u32(), f.u16(), f.u16()) };
      } else if (ck === 'data') pcm = body;
      if (len & 1 && r.remaining) r.u8();
    }
    if (!fmt || !pcm) throw new Error('Invalid WAV file');
    if (fmt.bits !== 8 && fmt.bits !== 16) throw new Error('WAV must be 8 or 16 bit');
    if (fmt.channels !== 1 && fmt.channels !== 2) throw new Error('WAV must be mono or stereo');
    w.u16(id);
    w.u8((3 << 4) | (rateCode(fmt.rate) << 2) | (fmt.bits === 16 ? 2 : 0) | (fmt.channels === 2 ? 1 : 0));
    w.u32(pcm.length / ((fmt.bits / 8) * fmt.channels));
    w.bytes(pcm);
    return w.toBytes();
  }
  const mp3 = parseMp3(file);
  w.u16(id);
  w.u8((2 << 4) | (rateCode(mp3.rate) << 2) | 2 | (mp3.channels === 2 ? 1 : 0));
  w.u32(mp3.sampleCount);
  w.s16(0); // seek samples
  w.bytes(file.subarray(mp3.start, mp3.end));
  return w.toBytes();
}

/** Replaces DefineSound `id` with an MP3 or WAV file. */
export function replaceSound(swf: Swf, id: number, file: Uint8Array): Tag {
  for (const { tag, parent, index } of swf.walkTags()) {
    if (tag.characterId !== id) continue;
    if (tag.code !== TagCode.DefineSound) throw new Error(`Character ${id} is a ${tag.name}, not a sound`);
    const next = new RawTag(TagCode.DefineSound, encodeDefineSound(id, file));
    next.longHeader = true;
    (parent ? parent.tags : swf.tags)[index] = next;
    return next;
  }
  throw new Error(`No character with id ${id}`);
}
