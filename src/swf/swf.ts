import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { ByteReader } from '../io/reader.js';
import { ByteWriter, signedBits } from '../io/writer.js';
import { packSwf, unpackSwf, type PackOptions, type SwfCompression } from '../compression/swf-container.js';
import { DefineSpriteTag, DoABCTag, readTags, SymbolTableTag, Tag, writeTags } from './tags.js';
import { TagCode } from './tag-codes.js';

/** Rectangle in twips (1/20 pixel). */
export interface Rect {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface SwfSaveOptions extends PackOptions {
  /** Override the compression used when saving. Defaults to the original compression. */
  compression?: SwfCompression;
}

function readRect(r: ByteReader): { rect: Rect; bits: number } {
  const bits = r.ub(5);
  const rect = { xMin: r.sb(bits), xMax: r.sb(bits), yMin: r.sb(bits), yMax: r.sb(bits) };
  r.align();
  return { rect, bits };
}

function writeRect(w: ByteWriter, rect: Rect, minBits = 0): void {
  const bits = Math.max(
    minBits,
    signedBits(rect.xMin),
    signedBits(rect.xMax),
    signedBits(rect.yMin),
    signedBits(rect.yMax),
  );
  w.ub(5, bits);
  w.sb(bits, rect.xMin);
  w.sb(bits, rect.xMax);
  w.sb(bits, rect.yMin);
  w.sb(bits, rect.yMax);
  w.align();
}

/** An SWF file: header plus a list of tags. */
export class Swf {
  version: number;
  compression: SwfCompression;
  /** Stage bounds in twips. */
  frameSize: Rect;
  /** Frames per second (8.8 fixed point in the file). */
  frameRate: number;
  frameCount: number;
  tags: Tag[];
  /** Bytes after the End tag (normally empty). Preserved on save. */
  trailing: Uint8Array;
  private rectBits: number;

  constructor(init: {
    version?: number;
    compression?: SwfCompression;
    frameSize?: Rect;
    frameRate?: number;
    frameCount?: number;
    tags?: Tag[];
  } = {}) {
    this.version = init.version ?? 10;
    this.compression = init.compression ?? 'zlib';
    this.frameSize = init.frameSize ?? { xMin: 0, xMax: 550 * 20, yMin: 0, yMax: 400 * 20 };
    this.frameRate = init.frameRate ?? 24;
    this.frameCount = init.frameCount ?? 1;
    this.tags = init.tags ?? [];
    this.trailing = new Uint8Array(0);
    this.rectBits = 0;
  }

  // -------------------------------------------------------------------------
  // Loading / saving
  // -------------------------------------------------------------------------

  /** Parse an SWF file (FWS, CWS or ZWS). */
  static parse(bytes: Uint8Array): Swf {
    const { compression, version, body } = unpackSwf(bytes);
    const r = new ByteReader(body);
    const { rect, bits } = readRect(r);
    const frameRate = r.u16() / 256;
    const frameCount = r.u16();
    const { tags, end } = readTags(body, r.pos, body.length);
    const swf = new Swf({ version, compression, frameSize: rect, frameRate, frameCount, tags });
    swf.rectBits = bits;
    swf.trailing = body.slice(end);
    return swf;
  }

  static async load(path: string): Promise<Swf> {
    return Swf.parse(new Uint8Array(await readFile(path)));
  }

  /** Uncompressed SWF body (everything after the 8-byte file header). */
  encodeBody(): Uint8Array {
    const w = new ByteWriter(1 << 16);
    writeRect(w, this.frameSize, this.rectBits);
    w.u16(Math.round(this.frameRate * 256));
    w.u16(this.frameCount);
    const tags = this.tags;
    writeTags(w, tags);
    if (tags.length === 0 || tags[tags.length - 1]!.code !== TagCode.End) {
      w.u16(0); // End tag
    }
    w.bytes(this.trailing);
    return w.toBytes();
  }

  /** Serialise to a complete SWF file. */
  toBytes(options: SwfSaveOptions = {}): Uint8Array {
    return packSwf({ compression: options.compression ?? this.compression, version: this.version, body: this.encodeBody() }, options);
  }

  /**
   * Write to disk. Uses a temporary file + rename, so saving over the source
   * file is safe.
   */
  async save(path: string, options: SwfSaveOptions = {}): Promise<void> {
    const bytes = this.toBytes(options);
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  // -------------------------------------------------------------------------
  // Convenience accessors
  // -------------------------------------------------------------------------

  get width(): number {
    return (this.frameSize.xMax - this.frameSize.xMin) / 20;
  }

  get height(): number {
    return (this.frameSize.yMax - this.frameSize.yMin) / 20;
  }

  /** Depth-first iteration over all tags, including tags nested in DefineSprite. */
  *walkTags(): Generator<{ tag: Tag; parent: DefineSpriteTag | null; index: number }> {
    function* walk(list: Tag[], parent: DefineSpriteTag | null): Generator<{ tag: Tag; parent: DefineSpriteTag | null; index: number }> {
      for (let i = 0; i < list.length; i++) {
        const tag = list[i]!;
        yield { tag, parent, index: i };
        if (tag instanceof DefineSpriteTag) yield* walk(tag.tags, tag);
      }
    }
    yield* walk(this.tags, null);
  }

  /** All DoABC / DoABC2 tags in file order. */
  get abcTags(): DoABCTag[] {
    return this.tags.filter((t): t is DoABCTag => t instanceof DoABCTag);
  }

  /** Character-defining tag with the given id (searches nested sprites too). */
  findCharacter(id: number): Tag | undefined {
    for (const { tag } of this.walkTags()) if (tag.characterId === id) return tag;
    return undefined;
  }

  /** Merged SymbolClass mapping: class name → character id. */
  symbolClasses(): Map<string, number> {
    const map = new Map<string, number>();
    for (const t of this.tags) {
      if (t instanceof SymbolTableTag && t.code === TagCode.SymbolClass) {
        for (const s of t.symbols) map.set(s.name, s.id);
      }
    }
    return map;
  }

  /** Main document class (SymbolClass entry with id 0), if any. */
  get documentClass(): string | undefined {
    for (const [name, id] of this.symbolClasses()) if (id === 0) return name;
    return undefined;
  }
}
