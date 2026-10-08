import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { splitQualifiedName } from '../abc/abc-file.js';
import { decompileClass } from '../decompiler/class-printer.js';
import type { Swf } from '../swf/swf.js';
import { safeSegment } from './pcode-project.js';

/** First-line marker identifying the exact class an exported file belongs to. */
export const CLASS_MARKER = '// swf-toolkit:';

export interface ExportSourcesResult {
  files: string[];
  /** Classes whose decompilation threw (a stub with the error was written). */
  failed: string[];
}

/** Writes decompiled `.as` files (one per class) into `outDir`. */
export async function exportSources(swf: Swf, outDir: string, options: { classes?: string[] } = {}): Promise<ExportSourcesResult> {
  const files: string[] = [];
  const failed: string[] = [];
  const used = new Set<string>();
  const only = options.classes ? new Set(options.classes) : undefined;
  const tags = swf.abcTags;
  for (let k = 0; k < tags.length; k++) {
    const abc = tags[k]!.abc;
    const counts = new Map<string, number>();
    for (let c = 0; c < abc.instances.length; c++) counts.set(abc.className(c), (counts.get(abc.className(c)) ?? 0) + 1);
    for (let c = 0; c < abc.instances.length; c++) {
      const name = abc.className(c);
      if (only && !only.has(name)) continue;
      const { pkg, name: short } = splitQualifiedName(name);
      let rel = [...(pkg ? pkg.split('.').map(safeSegment) : []), safeSegment(short) + '.as'].join('/');
      for (let n = 2; used.has(rel.toLowerCase()); n++) rel = rel.replace(/(~\d+)?\.as$/, `~${n}.as`);
      used.add(rel.toLowerCase());
      let text: string;
      try {
        text = decompileClass(abc, c);
      } catch (e) {
        failed.push(name);
        text = `// Failed to decompile ${name}: ${(e as Error).message}\n`;
      }
      // Ambiguous names (duplicate classes, several ABC tags) get a marker so import finds the right class.
      if (counts.get(name)! > 1 || tags.length > 1) text = `${CLASS_MARKER} abc=${k} class=${c}\n${text}`;
      const abs = join(outDir, ...rel.split('/'));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text, 'utf8');
      files.push(abs);
    }
  }
  return { files, failed };
}
