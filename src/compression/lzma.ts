/**
 * Pure TypeScript LZMA ("LZMA1", as used by ZWS SWF files) decoder and encoder.
 *
 * Written from the public LZMA format description (LZMA SDK `lzma-specification.txt`).
 * The SWF variant stores a 5-byte properties header and raw LZMA data with a known
 * uncompressed size and usually no end marker.
 */
import { SwfFormatError } from '../errors.js';

const NUM_STATES = 12;
const POS_STATES_MAX = 1 << 4;
const END_POS_MODEL_INDEX = 14;
const NUM_FULL_DISTANCES = 128;
const NUM_LEN_TO_POS_STATES = 4;
const NUM_ALIGN_BITS = 4;
const MATCH_MIN_LEN = 2;
const MATCH_MAX_LEN = 273;
const PROB_INIT = 1024;
const TOP = 0x1000000;

export interface LzmaProperties {
  lc: number;
  lp: number;
  pb: number;
  dictSize: number;
}

export function parseLzmaProperties(props: Uint8Array): LzmaProperties {
  if (props.length < 5) throw new SwfFormatError('LZMA properties must be 5 bytes');
  let d = props[0]!;
  if (d >= 9 * 5 * 5) throw new SwfFormatError(`Invalid LZMA properties byte ${d}`);
  const lc = d % 9;
  d = Math.floor(d / 9);
  const lp = d % 5;
  const pb = Math.floor(d / 5);
  const dictSize = (props[1]! | (props[2]! << 8) | (props[3]! << 16) | (props[4]! << 24)) >>> 0;
  return { lc, lp, pb, dictSize };
}

export function encodeLzmaProperties(p: LzmaProperties): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = (p.pb * 5 + p.lp) * 9 + p.lc;
  out[1] = p.dictSize & 0xff;
  out[2] = (p.dictSize >>> 8) & 0xff;
  out[3] = (p.dictSize >>> 16) & 0xff;
  out[4] = (p.dictSize >>> 24) & 0xff;
  return out;
}

function probs(n: number): Uint16Array {
  return new Uint16Array(n).fill(PROB_INIT);
}

class LenModel {
  choice = probs(2); // [0] = choice, [1] = choice2
  low = probs(POS_STATES_MAX << 3);
  mid = probs(POS_STATES_MAX << 3);
  high = probs(256);
}

class Model {
  isMatch = probs(NUM_STATES << 4);
  isRep = probs(NUM_STATES);
  isRepG0 = probs(NUM_STATES);
  isRepG1 = probs(NUM_STATES);
  isRepG2 = probs(NUM_STATES);
  isRep0Long = probs(NUM_STATES << 4);
  posSlot = probs(NUM_LEN_TO_POS_STATES << 6);
  specPos = probs(1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX);
  align = probs(1 << NUM_ALIGN_BITS);
  len = new LenModel();
  repLen = new LenModel();
  literal: Uint16Array;

  constructor(lc: number, lp: number) {
    this.literal = probs(0x300 << (lc + lp));
  }
}

function stateAfterLiteral(s: number): number {
  return s < 4 ? 0 : s < 10 ? s - 3 : s - 6;
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private pos: number;

  constructor(private readonly data: Uint8Array, start = 0) {
    this.pos = start;
    if (this.next() !== 0) throw new SwfFormatError('Corrupted LZMA stream (first byte must be 0)');
    for (let i = 0; i < 4; i++) this.code = this.code * 256 + this.next();
    if (this.code === this.range) throw new SwfFormatError('Corrupted LZMA stream');
  }

  private next(): number {
    // Reading past the end yields zeros; well-formed streams never depend on it.
    return this.pos < this.data.length ? this.data[this.pos++]! : (this.pos++, 0);
  }

  get overrun(): boolean {
    return this.pos > this.data.length + 4;
  }

  bit(p: Uint16Array, i: number): number {
    const prob = p[i]!;
    const bound = (this.range >>> 11) * prob;
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      p[i] = prob + ((2048 - prob) >>> 5);
      b = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      p[i] = prob - (prob >>> 5);
      b = 1;
    }
    if (this.range < TOP) {
      this.range = this.range * 256;
      this.code = this.code * 256 + this.next();
    }
    return b;
  }

  direct(numBits: number): number {
    let res = 0;
    for (let i = 0; i < numBits; i++) {
      this.range = this.range >>> 1;
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      res = res * 2 + b;
      if (this.range < TOP) {
        this.range = this.range * 256;
        this.code = this.code * 256 + this.next();
      }
    }
    return res;
  }

  tree(p: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) + this.bit(p, base + m);
    return m - (1 << numBits);
  }

  reverseTree(p: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < numBits; i++) {
      const b = this.bit(p, base + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  }

  len(l: LenModel, posState: number): number {
    if (this.bit(l.choice, 0) === 0) return this.tree(l.low, posState << 3, 3);
    if (this.bit(l.choice, 1) === 0) return 8 + this.tree(l.mid, posState << 3, 3);
    return 16 + this.tree(l.high, 0, 8);
  }
}

/**
 * Decompress raw LZMA data.
 * @param props 5-byte LZMA properties
 * @param data compressed stream (without properties)
 * @param outSize exact uncompressed size
 */
export function lzmaDecompress(props: Uint8Array, data: Uint8Array, outSize: number): Uint8Array {
  const { lc, lp, pb } = parseLzmaProperties(props);
  const m = new Model(lc, lp);
  const rc = new RangeDecoder(data);
  const out = new Uint8Array(outSize);
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let pos = 0;

  while (pos < outSize) {
    const posState = pos & pbMask;

    if (rc.bit(m.isMatch, (state << 4) + posState) === 0) {
      const prev = pos > 0 ? out[pos - 1]! : 0;
      const base = 0x300 * (((pos & lpMask) << lc) + (prev >>> (8 - lc)));
      let sym = 1;
      if (state >= 7) {
        let matchByte = out[pos - rep0 - 1]!;
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const b = rc.bit(m.literal, base + ((1 + matchBit) << 8) + sym);
          sym = (sym << 1) | b;
          if (matchBit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | rc.bit(m.literal, base + sym);
      out[pos++] = sym & 0xff;
      state = stateAfterLiteral(state);
      continue;
    }

    let len: number;
    if (rc.bit(m.isRep, state) !== 0) {
      if (pos === 0) throw new SwfFormatError('Corrupted LZMA stream (rep match at start)');
      if (rc.bit(m.isRepG0, state) === 0) {
        if (rc.bit(m.isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          out[pos] = out[pos - rep0 - 1]!;
          pos++;
          continue;
        }
      } else {
        let dist: number;
        if (rc.bit(m.isRepG1, state) === 0) {
          dist = rep1;
        } else {
          if (rc.bit(m.isRepG2, state) === 0) {
            dist = rep2;
          } else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = rc.len(m.repLen, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = rc.len(m.len, posState);
      state = state < 7 ? 7 : 10;

      const lenState = len < NUM_LEN_TO_POS_STATES - 1 ? len : NUM_LEN_TO_POS_STATES - 1;
      const posSlot = rc.tree(m.posSlot, lenState << 6, 6);
      if (posSlot < 4) {
        rep0 = posSlot;
      } else {
        const numDirectBits = (posSlot >>> 1) - 1;
        let dist = (2 | (posSlot & 1)) * 2 ** numDirectBits;
        if (posSlot < END_POS_MODEL_INDEX) {
          dist += rc.reverseTree(m.specPos, dist - posSlot, numDirectBits);
        } else {
          dist += rc.direct(numDirectBits - NUM_ALIGN_BITS) * 16;
          dist += rc.reverseTree(m.align, 0, NUM_ALIGN_BITS);
        }
        rep0 = dist;
      }
      if (rep0 === 0xffffffff) break; // end marker
      if (rep0 >= pos) throw new SwfFormatError('Corrupted LZMA stream (distance out of range)');
    }

    len += MATCH_MIN_LEN;
    let src = pos - rep0 - 1;
    const end = Math.min(outSize, pos + len);
    while (pos < end) out[pos++] = out[src++]!;
  }

  if (rc.overrun) throw new SwfFormatError('Corrupted LZMA stream (input truncated)');
  return out;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

class RangeEncoder {
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private buf: Uint8Array;
  length = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(Math.max(1024, capacity));
  }

  private write(b: number): void {
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = b;
  }

  private shiftLow(): void {
    const lo32 = this.low >>> 0;
    const carry = this.low > 0xffffffff ? 1 : 0;
    if (lo32 < 0xff000000 || carry !== 0) {
      let temp = this.cache;
      do {
        this.write((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = lo32 >>> 24;
    }
    this.cacheSize++;
    this.low = (lo32 & 0x00ffffff) * 256;
  }

  bit(p: Uint16Array, i: number, b: number): void {
    const prob = p[i]!;
    const bound = (this.range >>> 11) * prob;
    if (b === 0) {
      this.range = bound;
      p[i] = prob + ((2048 - prob) >>> 5);
    } else {
      this.low += bound;
      this.range -= bound;
      p[i] = prob - (prob >>> 5);
    }
    while (this.range < TOP) {
      this.range = this.range * 256;
      this.shiftLow();
    }
  }

  direct(value: number, numBits: number): void {
    for (let i = numBits - 1; i >= 0; i--) {
      this.range = this.range >>> 1;
      if (Math.floor(value / 2 ** i) & 1) this.low += this.range;
      while (this.range < TOP) {
        this.range = this.range * 256;
        this.shiftLow();
      }
    }
  }

  tree(p: Uint16Array, base: number, numBits: number, sym: number): void {
    let m = 1;
    for (let i = numBits - 1; i >= 0; i--) {
      const b = (sym >>> i) & 1;
      this.bit(p, base + m, b);
      m = (m << 1) | b;
    }
  }

  reverseTree(p: Uint16Array, base: number, numBits: number, sym: number): void {
    let m = 1;
    for (let i = 0; i < numBits; i++) {
      const b = sym & 1;
      sym >>>= 1;
      this.bit(p, base + m, b);
      m = (m << 1) | b;
    }
  }

  len(l: LenModel, posState: number, len: number): void {
    if (len < 8) {
      this.bit(l.choice, 0, 0);
      this.tree(l.low, posState << 3, 3, len);
    } else if (len < 16) {
      this.bit(l.choice, 0, 1);
      this.bit(l.choice, 1, 0);
      this.tree(l.mid, posState << 3, 3, len - 8);
    } else {
      this.bit(l.choice, 0, 1);
      this.bit(l.choice, 1, 1);
      this.tree(l.high, 0, 8, len - 16);
    }
  }

  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return this.buf.slice(0, this.length);
  }
}

export interface LzmaCompressOptions {
  /** Literal context bits (0-8). Default 3. */
  lc?: number;
  /** Literal position bits (0-4). Default 0. */
  lp?: number;
  /** Position bits (0-4). Default 2. */
  pb?: number;
  /** Dictionary size in bytes. Defaults to the input size rounded up to a power of two (max 64 MiB). */
  dictSize?: number;
  /** Maximum hash-chain depth for the match finder. Higher = better ratio, slower. Default 48. */
  depth?: number;
  /** Stop searching once a match of this length is found. Default 128. */
  niceLength?: number;
}

function posSlotOf(dist: number): number {
  if (dist < 4) return dist;
  const n = 31 - Math.clz32(dist);
  return (n << 1) | ((dist >>> (n - 1)) & 1);
}

/**
 * Compress data with LZMA. Returns the 5-byte properties and the raw stream
 * (no end marker, no size header), as stored in ZWS SWF files.
 */
export function lzmaCompress(input: Uint8Array, options: LzmaCompressOptions = {}): { props: Uint8Array; data: Uint8Array } {
  const lc = options.lc ?? 3;
  const lp = options.lp ?? 0;
  const pb = options.pb ?? 2;
  let dictSize = options.dictSize ?? 0;
  if (!dictSize) {
    dictSize = 1 << 16;
    while (dictSize < input.length && dictSize < 1 << 26) dictSize *= 2;
  }
  const depth = options.depth ?? 48;
  const niceLength = Math.min(options.niceLength ?? 128, MATCH_MAX_LEN);

  const m = new Model(lc, lp);
  const rc = new RangeEncoder((input.length >>> 1) + 1024);
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  const n = input.length;

  const HASH_BITS = 18;
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(n);
  const hash3 = (i: number): number =>
    Math.imul(input[i]! | (input[i + 1]! << 8) | (input[i + 2]! << 16), 0x9e3779b1) >>> (32 - HASH_BITS);
  const insert = (i: number): void => {
    if (i + 2 >= n) return;
    const h = hash3(i);
    prev[i] = head[h]!;
    head[h] = i;
  };

  const reps = [0, 0, 0, 0];
  let state = 0;
  let pos = 0;

  const matchLen = (a: number, b: number, max: number): number => {
    let l = 0;
    while (l < max && input[a + l] === input[b + l]) l++;
    return l;
  };

  const encodeLiteral = (): void => {
    const posState = pos & pbMask;
    rc.bit(m.isMatch, (state << 4) + posState, 0);
    const prevByte = pos > 0 ? input[pos - 1]! : 0;
    const base = 0x300 * (((pos & lpMask) << lc) + (prevByte >>> (8 - lc)));
    const byte = input[pos]!;
    let sym = 1;
    if (state >= 7) {
      const matchByte = input[pos - reps[0]! - 1]!;
      let matched = true;
      for (let i = 7; i >= 0; i--) {
        const b = (byte >>> i) & 1;
        if (matched) {
          const mb = (matchByte >>> i) & 1;
          rc.bit(m.literal, base + ((1 + mb) << 8) + sym, b);
          matched = mb === b;
        } else {
          rc.bit(m.literal, base + sym, b);
        }
        sym = (sym << 1) | b;
      }
    } else {
      for (let i = 7; i >= 0; i--) {
        const b = (byte >>> i) & 1;
        rc.bit(m.literal, base + sym, b);
        sym = (sym << 1) | b;
      }
    }
    state = stateAfterLiteral(state);
  };

  const encodeShortRep = (): void => {
    const posState = pos & pbMask;
    rc.bit(m.isMatch, (state << 4) + posState, 1);
    rc.bit(m.isRep, state, 1);
    rc.bit(m.isRepG0, state, 0);
    rc.bit(m.isRep0Long, (state << 4) + posState, 0);
    state = state < 7 ? 9 : 11;
  };

  const encodeRep = (repIndex: number, len: number): void => {
    const posState = pos & pbMask;
    rc.bit(m.isMatch, (state << 4) + posState, 1);
    rc.bit(m.isRep, state, 1);
    if (repIndex === 0) {
      rc.bit(m.isRepG0, state, 0);
      rc.bit(m.isRep0Long, (state << 4) + posState, 1);
    } else {
      rc.bit(m.isRepG0, state, 1);
      if (repIndex === 1) {
        rc.bit(m.isRepG1, state, 0);
      } else {
        rc.bit(m.isRepG1, state, 1);
        rc.bit(m.isRepG2, state, repIndex - 2);
      }
      const dist = reps[repIndex]!;
      for (let i = repIndex; i > 0; i--) reps[i] = reps[i - 1]!;
      reps[0] = dist;
    }
    rc.len(m.repLen, posState, len - MATCH_MIN_LEN);
    state = state < 7 ? 8 : 11;
  };

  const encodeMatch = (dist: number, len: number): void => {
    const posState = pos & pbMask;
    rc.bit(m.isMatch, (state << 4) + posState, 1);
    rc.bit(m.isRep, state, 0);
    rc.len(m.len, posState, len - MATCH_MIN_LEN);
    const lenState = Math.min(len - MATCH_MIN_LEN, NUM_LEN_TO_POS_STATES - 1);
    const posSlot = posSlotOf(dist);
    rc.tree(m.posSlot, lenState << 6, 6, posSlot);
    if (posSlot >= 4) {
      const footerBits = (posSlot >>> 1) - 1;
      const base = (2 | (posSlot & 1)) << footerBits;
      const reduced = dist - base;
      if (posSlot < END_POS_MODEL_INDEX) {
        rc.reverseTree(m.specPos, base - posSlot, footerBits, reduced);
      } else {
        rc.direct(reduced >>> NUM_ALIGN_BITS, footerBits - NUM_ALIGN_BITS);
        rc.reverseTree(m.align, 0, NUM_ALIGN_BITS, reduced & 0xf);
      }
    }
    reps[3] = reps[2]!;
    reps[2] = reps[1]!;
    reps[1] = reps[0]!;
    reps[0] = dist;
    state = state < 7 ? 7 : 10;
  };

  while (pos < n) {
    const maxLen = Math.min(MATCH_MAX_LEN, n - pos);

    // Repeat matches (cheap to encode).
    let bestRepLen = 0;
    let bestRepIndex = 0;
    if (pos > 0 && maxLen >= 2) {
      for (let r = 0; r < 4; r++) {
        const src = pos - reps[r]! - 1;
        if (src < 0) continue;
        const l = matchLen(src, pos, maxLen);
        if (l > bestRepLen) {
          bestRepLen = l;
          bestRepIndex = r;
        }
      }
    }

    // Main match via hash chains.
    let bestLen = 0;
    let bestDist = 0;
    if (maxLen >= 3 && pos + 2 < n) {
      let cand = head[hash3(pos)]!;
      let chain = depth;
      const minPos = pos - dictSize;
      while (cand >= 0 && cand >= minPos && chain-- > 0) {
        if (input[cand + bestLen] === input[pos + bestLen]) {
          const l = matchLen(cand, pos, maxLen);
          if (l > bestLen) {
            bestLen = l;
            bestDist = pos - cand - 1;
            if (l >= niceLength) break;
          }
        }
        cand = prev[cand]!;
      }
    }

    let advance: number;
    if (bestRepLen >= 2 && bestRepLen + 1 >= bestLen) {
      encodeRep(bestRepIndex, bestRepLen);
      advance = bestRepLen;
    } else if (bestLen >= 3 && !(bestLen === 3 && bestDist >= 1 << 14)) {
      encodeMatch(bestDist, bestLen);
      advance = bestLen;
    } else if (pos > reps[0]! && input[pos] === input[pos - reps[0]! - 1] && state >= 7) {
      encodeShortRep();
      advance = 1;
    } else {
      encodeLiteral();
      advance = 1;
    }

    for (let i = 0; i < advance; i++) insert(pos + i);
    pos += advance;
  }

  return { props: encodeLzmaProperties({ lc, lp, pb, dictSize }), data: rc.finish() };
}
