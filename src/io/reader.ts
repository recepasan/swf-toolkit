import { SwfFormatError } from '../errors.js';

const utf8Decoder = new TextDecoder('utf-8');

/**
 * Little-endian binary reader with SWF bit-field support.
 *
 * Bit reads (`ub`, `sb`, `fb`) share an internal bit buffer; any byte-aligned
 * read implicitly re-aligns to the next byte boundary, as required by the SWF
 * specification.
 */
export class ByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos: number;
  readonly end: number;

  private bitBuf = 0;
  private bitCount = 0;

  constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
    this.end = end;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.end;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) {
      throw new SwfFormatError(`Unexpected end of data at offset ${this.pos} (need ${n} byte(s), ${this.remaining} left)`);
    }
  }

  align(): void {
    this.bitCount = 0;
    this.bitBuf = 0;
  }

  u8(): number {
    this.align();
    this.need(1);
    return this.bytes[this.pos++]!;
  }

  s8(): number {
    const v = this.u8();
    return v >= 0x80 ? v - 0x100 : v;
  }

  u16(): number {
    this.align();
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  s16(): number {
    this.align();
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u24(): number {
    this.align();
    this.need(3);
    const b = this.bytes;
    const v = b[this.pos]! | (b[this.pos + 1]! << 8) | (b[this.pos + 2]! << 16);
    this.pos += 3;
    return v;
  }

  s24(): number {
    const v = this.u24();
    return v & 0x800000 ? v - 0x1000000 : v;
  }

  u32(): number {
    this.align();
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  s32(): number {
    this.align();
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    this.align();
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.align();
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** 8.8 fixed point. */
  fixed8(): number {
    return this.s16() / 256;
  }

  /** 16.16 fixed point. */
  fixed(): number {
    return this.s32() / 65536;
  }

  bytesView(n: number): Uint8Array {
    this.align();
    this.need(n);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /** Copy of the next `n` bytes. */
  bytesCopy(n: number): Uint8Array {
    return this.bytesView(n).slice();
  }

  rest(): Uint8Array {
    return this.bytesView(this.remaining);
  }

  /** Null-terminated UTF-8 string. */
  cstring(): string {
    this.align();
    const start = this.pos;
    while (this.pos < this.end && this.bytes[this.pos] !== 0) this.pos++;
    if (this.pos >= this.end) throw new SwfFormatError(`Unterminated string at offset ${start}`);
    const s = utf8Decoder.decode(this.bytes.subarray(start, this.pos));
    this.pos++;
    return s;
  }

  /** Unsigned bit field (MSB first). */
  ub(n: number): number {
    let result = 0;
    for (let i = 0; i < n; i++) {
      if (this.bitCount === 0) {
        this.need(1);
        this.bitBuf = this.bytes[this.pos++]!;
        this.bitCount = 8;
      }
      this.bitCount--;
      result = result * 2 + ((this.bitBuf >> this.bitCount) & 1);
    }
    return result;
  }

  /** Signed bit field. */
  sb(n: number): number {
    if (n === 0) return 0;
    const v = this.ub(n);
    const sign = 2 ** (n - 1);
    return v >= sign ? v - 2 * sign : v;
  }

  /** Signed 16.16 fixed-point bit field. */
  fb(n: number): number {
    return this.sb(n) / 65536;
  }

  /** SWF EncodedU32 / AVM2 variable-length unsigned 32-bit integer. */
  encodedU32(): number {
    this.align();
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      this.need(1);
      const b = this.bytes[this.pos++]!;
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }
}
