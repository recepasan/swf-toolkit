/**
 * Whole-program helpers: compile AS3 sources into a fresh ABC / SWF.
 */
import { AbcFile } from '../abc/abc-file.js';
import { Interner } from '../abc/interner.js';
import { Swf } from '../swf/swf.js';
import { TagCode } from '../swf/tag-codes.js';
import { DoABCTag, FileAttributesTag, RawTag, SymbolTableTag } from '../swf/tags.js';
import { compileClassSource, type CompileClassResult } from './class-compiler.js';

export interface SourceFile {
  /** File name (used in error messages). */
  name: string;
  text: string;
}

/** Compiles source files into `abc` (a new ABC when omitted). */
export function compileSources(sources: SourceFile[], abc = new AbcFile()): { abc: AbcFile; result: CompileClassResult } {
  const interner = new Interner(abc);
  const result: CompileClassResult = { changes: [] };
  for (const f of sources) {
    const r = compileClassSource(abc, f.text, { source: f.name, interner, baseline: null });
    result.changes.push(...r.changes);
  }
  return { abc, result };
}

export interface CreateSwfOptions {
  /** Fully qualified document class (instantiated as the main timeline). */
  documentClass: string;
  width?: number;
  height?: number;
  frameRate?: number;
  /** SWF version (default 15). */
  version?: number;
  /** RGB background colour (default white). */
  background?: number;
}

/** Builds a minimal AS3 SWF around an ABC. */
export function createSwf(abc: AbcFile, options: CreateSwfOptions): Swf {
  const bg = options.background ?? 0xffffff;
  const swf = new Swf({
    version: options.version ?? 15,
    compression: 'zlib',
    frameSize: { xMin: 0, xMax: (options.width ?? 550) * 20, yMin: 0, yMax: (options.height ?? 400) * 20 },
    frameRate: options.frameRate ?? 24,
    frameCount: 1,
  });
  swf.tags.push(
    new FileAttributesTag(0x08 | 0x01),
    new RawTag(TagCode.SetBackgroundColor, new Uint8Array([(bg >> 16) & 0xff, (bg >> 8) & 0xff, bg & 0xff])),
    DoABCTag.create(abc, 'main'),
    new SymbolTableTag(TagCode.SymbolClass, [{ id: 0, name: options.documentClass }]),
    new RawTag(TagCode.ShowFrame, new Uint8Array(0)),
    new RawTag(TagCode.End, new Uint8Array(0)),
  );
  return swf;
}
