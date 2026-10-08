/**
 * Applies edited / new `.as` files to an SWF. Classes are matched by their
 * fully qualified name; within existing classes only members whose text
 * differs from the decompiled original are recompiled.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Interner } from '../abc/interner.js';
import { compileClassSource, type CompiledMember } from '../compiler/class-compiler.js';
import { parseAs3 } from '../compiler/parser.js';
import type { Swf } from '../swf/swf.js';
import type { DoABCTag } from '../swf/tags.js';
import { CLASS_MARKER } from './source-export.js';

export interface ImportSourcesResult {
  changes: CompiledMember[];
  /** Files that were parsed and matched no change. */
  unchanged: number;
}

async function listAsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.as')) out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

export interface ImportSourcesOptions {
  /** Only import these files (absolute, or relative to `dir`). */
  files?: string[];
}

/** Compiles `.as` files from `dir` (or explicit file paths) into the SWF. */
export async function importSources(swf: Swf, dir: string, options: ImportSourcesOptions = {}): Promise<ImportSourcesResult> {
  const files = options.files ? options.files.map((f) => (f.startsWith('/') ? f : join(dir, f))) : await listAsFiles(dir);
  const tags = swf.abcTags;
  if (!tags.length) throw new Error('SWF has no ActionScript 3 code (no DoABC tag)');
  const interners = new Map<DoABCTag, Interner>();
  const result: ImportSourcesResult = { changes: [], unchanged: 0 };

  // New classes are compiled after existing ones so their base classes exist.
  type Item = { file: string; text: string; tag: DoABCTag; classIndex?: number };
  const existing: Item[] = [];
  const added: Item[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const marker = new RegExp(`^${CLASS_MARKER.replace(/[/]/g, '\\/')} abc=(\\d+) class=(\\d+)`).exec(text);
    if (marker) {
      const tag = tags[Number(marker[1])];
      if (!tag) throw new Error(`${file}: ABC tag #${marker[1]} does not exist`);
      existing.push({ file, text, tag, classIndex: Number(marker[2]) });
      continue;
    }
    const unit = parseAs3(text, relative(process.cwd(), file));
    let target: DoABCTag | undefined;
    for (const cls of unit.classes) {
      const q = unit.package ? `${unit.package}.${cls.name}` : cls.name;
      target ??= tags.find((t) => t.abc.findClass(q) >= 0);
    }
    if (target) existing.push({ file, text, tag: target });
    else added.push({ file, text, tag: tags[tags.length - 1]! });
  }
  // Interfaces and base classes first among new files.
  added.sort((a, b) => Number(/\binterface\b/.test(b.text)) - Number(/\binterface\b/.test(a.text)));

  for (const p of [...existing, ...added]) {
    let pool = interners.get(p.tag);
    if (!pool) interners.set(p.tag, (pool = new Interner(p.tag.abc)));
    const r = compileClassSource(p.tag.abc, p.text, { source: relative(process.cwd(), p.file), interner: pool, classIndex: p.classIndex });
    if (r.changes.length) result.changes.push(...r.changes);
    else result.unchanged++;
  }
  return result;
}
