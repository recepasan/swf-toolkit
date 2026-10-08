/**
 * Export every class of an SWF to editable `.pcode` files and import the
 * edited files back. Only methods whose text actually changed are
 * re-assembled, so untouched code stays byte-identical.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { AbcFile } from '../abc/abc-file.js';
import { splitQualifiedName } from '../abc/abc-file.js';
import { Interner } from '../abc/interner.js';
import { classMethods, describeMethodRef, scriptMethods, scriptOfClass, type MethodRef } from '../abc/model.js';
import { assembleMethods } from '../abc/pcode/assembler.js';
import { disassembleMethod } from '../abc/pcode/disassembler.js';
import { formatMultiname } from '../abc/pcode/format.js';
import { tokenizeLine } from '../abc/pcode/lexer.js';
import { AssemblerError } from '../errors.js';
import type { Swf } from '../swf/swf.js';
import { DoABCTag } from '../swf/tags.js';

export const MANIFEST_NAME = 'swf-toolkit.json';

interface ManifestFile {
  /** Index into Swf.abcTags. */
  abc: number;
  className?: string;
  methods: number[];
}

interface Manifest {
  format: 'swf-toolkit-pcode';
  version: 1;
  abcs: Array<{ name: string; dir: string }>;
  files: Record<string, ManifestFile>;
}

/** Make a class / package name safe as a path segment on all platforms. */
export function safeSegment(s: string): string {
  if (s === '' || s === '.' || s === '..') return `_${s.length}_`;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (/[\\/:*?"<>|%]/.test(ch) || cp < 0x20 || cp === 0x7f || (cp >= 0xd800 && cp <= 0xdfff)) out += `%${cp.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = `%${out}`;
  if (/[. ]$/.test(out)) out += '%';
  return out.length > 180 ? out.slice(0, 160) + '%' + hash(s) : out;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

function classFilePath(className: string): string {
  const { pkg, name } = splitQualifiedName(className);
  const parts = pkg ? pkg.split('.').map(safeSegment) : [];
  return [...parts, safeSegment(name) + '.pcode'].join('/');
}

function renderFile(abc: AbcFile, header: string[], owner: string, refs: MethodRef[], done: Set<number>): { text: string; methods: number[] } {
  const chunks: string[] = [header.map((h) => `; ${h}`).join('\n') + '\n'];
  const methods: number[] = [];
  for (const r of refs) {
    if (done.has(r.methodIndex) || !abc.methods[r.methodIndex]) continue;
    done.add(r.methodIndex);
    methods.push(r.methodIndex);
    chunks.push(disassembleMethod(abc, r.methodIndex, { title: describeMethodRef(abc, owner, r) }));
  }
  return { text: chunks.join('\n'), methods };
}

export interface ExportPcodeResult {
  outDir: string;
  files: string[];
  methodCount: number;
}

/** Writes one `.pcode` file per class (plus a manifest) into `outDir`. */
export async function exportPcode(swf: Swf, outDir: string): Promise<ExportPcodeResult> {
  const tags = swf.abcTags;
  const manifest: Manifest = { format: 'swf-toolkit-pcode', version: 1, abcs: [], files: {} };
  const written: string[] = [];
  let methodCount = 0;

  for (let k = 0; k < tags.length; k++) {
    const tag = tags[k]!;
    const abc = tag.abc;
    const base = tags.length > 1 ? `_abc${k}_${safeSegment(tag.abcName || 'unnamed')}` : '';
    manifest.abcs.push({ name: tag.abcName, dir: base });
    const done = new Set<number>();
    const used = new Set<string>();
    const unique = (p: string): string => {
      let candidate = p;
      for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = p.replace(/\.pcode$/, `~${n}.pcode`);
      used.add(candidate.toLowerCase());
      return candidate;
    };
    const emit = async (rel: string, text: string, entry: ManifestFile): Promise<void> => {
      const path = base ? `${base}/${rel}` : rel;
      const abs = join(outDir, ...path.split('/'));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text, 'utf8');
      manifest.files[path] = entry;
      written.push(abs);
      methodCount += entry.methods.length;
    };

    const scriptDone = new Set<number>();
    for (let c = 0; c < abc.instances.length; c++) {
      const name = abc.className(c);
      const inst = abc.instances[c]!;
      const header = [
        `class ${name}  (class index ${c})`,
        `extends ${inst.superName ? formatMultiname(abc, inst.superName) : '-'}`,
        ...(inst.interfaces.length ? [`implements ${inst.interfaces.map((i) => formatMultiname(abc, i)).join(', ')}`] : []),
        'Edit method blocks and run import; blocks you do not change are left untouched.',
      ];
      const refs: MethodRef[] = [];
      const s = scriptOfClass(abc, c);
      if (s >= 0 && !scriptDone.has(s)) {
        scriptDone.add(s);
        refs.push(...scriptMethods(abc, s, false));
      }
      refs.push(...classMethods(abc, c));
      const { text, methods } = renderFile(abc, header, name, refs, done);
      await emit(unique(classFilePath(name)), text, { abc: k, className: name, methods });
    }
    for (let s = 0; s < abc.scripts.length; s++) {
      if (scriptDone.has(s)) continue;
      const refs = scriptMethods(abc, s);
      const { text, methods } = renderFile(abc, [`script ${s}`], `script${s}`, refs, done);
      if (methods.length) await emit(unique(`_scripts/script_${s}.pcode`), text, { abc: k, methods });
    }
    // Anything not reachable from classes or scripts.
    const rest: MethodRef[] = [];
    for (let m = 0; m < abc.methods.length; m++) if (!done.has(m)) rest.push({ methodIndex: m, role: 'closure', name: abc.strings[abc.methods[m]!.name] ?? '', isStatic: false });
    if (rest.length) {
      const { text, methods } = renderFile(abc, ['methods not referenced by any class or script'], '<orphan>', rest, done);
      await emit(unique('_scripts/orphans.pcode'), text, { abc: k, methods });
    }
  }

  const manifestPath = join(outDir, MANIFEST_NAME);
  await mkdir(outDir, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { outDir, files: written, methodCount };
}

/** Splits a P-code document into `method ... end` blocks with their method index. */
export function splitMethodBlocks(text: string): Array<{ text: string; startLine: number; methodIndex: number | 'new' }> {
  const lines = text.split('\n');
  const blocks: Array<{ text: string; startLine: number; methodIndex: number | 'new' }> = [];
  let start = -1;
  let index: number | 'new' = 'new';
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*method\s+(\d+|new)\b/.exec(lines[i]!);
    if (m && start < 0) {
      start = i;
      index = m[1] === 'new' ? 'new' : Number(m[1]);
    } else if (start >= 0 && /^\s*end\s*(;.*)?$/.test(lines[i]!)) {
      // Pad with blank lines so assembler line numbers match the file.
      blocks.push({ text: '\n'.repeat(start) + lines.slice(start, i + 1).join('\n'), startLine: start + 1, methodIndex: index });
      start = -1;
    }
  }
  if (start >= 0) throw new AssemblerError("Missing 'end'", lines.length, 1);
  return blocks;
}

/** Token-level normalisation: ignores comments, indentation and spacing. */
function normalize(text: string): string {
  return text
    .split('\n')
    .map((l, i) => tokenizeLine(l, i + 1).map((t) => t.text).join(' '))
    .filter((l) => l.length > 0)
    .join('\n');
}

export interface ImportPcodeResult {
  /** Methods that were re-assembled. */
  changed: Array<{ file: string; methodIndex: number }>;
  /** Number of method blocks that were identical to the current SWF. */
  unchanged: number;
}

export interface ImportPcodeOptions {
  /** Only import these files (paths relative to the project dir). */
  files?: string[];
}

/** Applies edited `.pcode` files from `dir` (created by {@link exportPcode}) to `swf`. */
export async function importPcode(swf: Swf, dir: string, options: ImportPcodeOptions = {}): Promise<ImportPcodeResult> {
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST_NAME), 'utf8')) as Manifest;
  if (manifest.format !== 'swf-toolkit-pcode') throw new Error(`${MANIFEST_NAME} is not a swf-toolkit P-code manifest`);
  const tags = swf.abcTags;
  const interners = new Map<number, Interner>();
  const result: ImportPcodeResult = { changed: [], unchanged: 0 };
  const only = options.files ? new Set(options.files.map((f) => f.split(sep).join('/'))) : undefined;

  for (const [rel, entry] of Object.entries(manifest.files)) {
    if (only && !only.has(rel)) continue;
    const tag: DoABCTag | undefined = tags[entry.abc];
    if (!tag) throw new Error(`${rel}: ABC tag #${entry.abc} not found in SWF`);
    const abc = tag.abc;
    const path = join(dir, ...rel.split('/'));
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue; // file deleted: leave methods as they are
    }
    for (const block of splitMethodBlocks(text)) {
      if (block.methodIndex !== 'new') {
        const current = abc.methods[block.methodIndex] ? disassembleMethod(abc, block.methodIndex) : '';
        if (normalize(current) === normalize(block.text)) {
          result.unchanged++;
          continue;
        }
      }
      let interner = interners.get(entry.abc);
      if (!interner) {
        interner = new Interner(abc);
        interners.set(entry.abc, interner);
      }
      const assembled = assembleMethods(abc, block.text, { source: relative(process.cwd(), path), interner });
      for (const a of assembled) result.changed.push({ file: rel, methodIndex: a.methodIndex });
    }
  }
  return result;
}
