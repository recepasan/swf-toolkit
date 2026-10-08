#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { Swf } from './swf/swf.js';
import { DefineSpriteTag, DoABCTag, type Tag } from './swf/tags.js';
import { packSwf, unpackSwf, type SwfCompression } from './compression/swf-container.js';
import { classMethods, describeMethodRef, scriptMethods, scriptOfClass } from './abc/model.js';
import { disassembleMethod } from './abc/pcode/disassembler.js';
import { exportPcode, importPcode } from './project/pcode-project.js';
import { decompileClass } from './decompiler/class-printer.js';
import { exportSources } from './project/source-export.js';
import { importSources } from './project/source-import.js';
import { compileSources, createSwf } from './compiler/program.js';
import { exportAs2, importAs2 } from './avm1/project.js';
import { ALL_ASSET_KINDS, exportAssets, replaceAsset, type AssetKind } from './assets/assets.js';

const HELP = `swf-toolkit <command> [options]

Inspect
  info <file.swf>                         Header, tag statistics, ABC summary
  tags <file.swf>                         List tags (nested sprite tags indented)
  classes <file.swf>                      List AS3 classes
  disasm <file.swf> <class> [method]      Print P-code of a class or one of its methods
  decompile <file.swf> <class>            Print decompiled ActionScript 3 source of a class

Edit
  export-pcode <file.swf> <dir>           Write one editable .pcode file per class
  import-pcode <file.swf> <dir> <out.swf> Apply edited .pcode files and save
  export-as3 <file.swf> <dir>             Write decompiled, editable .as sources
  import-as3 <file.swf> <dir> <out.swf>   Compile edited / new .as files and save
  compile <file.swf> <out.swf> <a.as>...  Compile the given .as files into the SWF

Build
  build <out.swf> <Main.as> [more.as...]  Compile sources into a new SWF
        [--main <Class>] [--width N] [--height N]

AS1 / AS2
  export-as2 <file.swf> <dir>             Write DoAction / DoInitAction blocks as P-code
  import-as2 <file.swf> <dir> <out.swf>   Re-assemble edited AS1/AS2 P-code and save

Assets
  export-assets <file.swf> <dir> [kinds]  Export images, sounds, binary, texts (kinds: comma list)
  replace <in.swf> <out.swf> <id> <file> [<id> <file>...]
                                          Replace bitmaps (png/jpg/gif), sounds (mp3/wav),
                                          binary data or edit-text strings by character id

Container
  decompress <in.swf> <out.swf>           Save uncompressed (FWS)
  compress <in.swf> <out.swf> [zlib|lzma] Save compressed (default zlib)

Options
  --compression <none|zlib|lzma>          Output compression for import-pcode
  -h, --help                              Show this help
`;

function fail(msg: string): never {
  process.stderr.write(`swf-toolkit: ${msg}\n`);
  process.exit(1);
}

function compressionArg(v: string | undefined, fallback?: SwfCompression): SwfCompression | undefined {
  if (v === undefined) return fallback;
  if (v === 'none' || v === 'zlib' || v === 'lzma') return v;
  fail(`invalid compression '${v}' (expected none, zlib or lzma)`);
}

function tagLine(tag: Tag, index: number, depth: number): string {
  const id = tag.characterId;
  const len = tag.encodeBody().length;
  const extra = tag instanceof DoABCTag ? ` name="${tag.abcName}"` : tag instanceof DefineSpriteTag ? ` frames=${tag.frameCount}` : '';
  return `${'  '.repeat(depth)}${String(index).padStart(5)}  ${tag.name}${id !== undefined ? ` (id ${id})` : ''}  len=${len}${extra}`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      compression: { type: 'string' },
      main: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
    },
  });
  const [cmd, ...args] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(HELP);
    return;
  }
  const need = (n: number, usage: string): void => {
    if (args.length < n) fail(`usage: swf-toolkit ${usage}`);
  };

  switch (cmd) {
    case 'info': {
      need(1, 'info <file.swf>');
      const swf = await Swf.load(args[0]!);
      const counts = new Map<string, number>();
      for (const { tag } of swf.walkTags()) counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
      const out = [
        `version      ${swf.version}`,
        `compression  ${swf.compression}`,
        `stage        ${swf.width} x ${swf.height} px`,
        `frame rate   ${swf.frameRate}`,
        `frames       ${swf.frameCount}`,
        `tags         ${swf.tags.length} top-level`,
      ];
      if (swf.documentClass) out.push(`document     ${swf.documentClass}`);
      for (const tag of swf.abcTags) {
        const abc = tag.abc;
        out.push(`abc "${tag.abcName}"  v${abc.majorVersion}.${abc.minorVersion}  ${abc.instances.length} classes, ${abc.methods.length} methods, ${abc.bodies.length} bodies`);
      }
      out.push('', 'tag counts:');
      for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) out.push(`  ${String(n).padStart(6)}  ${name}`);
      process.stdout.write(out.join('\n') + '\n');
      break;
    }
    case 'tags': {
      need(1, 'tags <file.swf>');
      const swf = await Swf.load(args[0]!);
      const lines: string[] = [];
      const walk = (tags: Tag[], depth: number): void => {
        tags.forEach((t, i) => {
          lines.push(tagLine(t, i, depth));
          if (t instanceof DefineSpriteTag) walk(t.tags, depth + 1);
        });
      };
      walk(swf.tags, 0);
      process.stdout.write(lines.join('\n') + '\n');
      break;
    }
    case 'classes': {
      need(1, 'classes <file.swf>');
      const swf = await Swf.load(args[0]!);
      const lines: string[] = [];
      for (const tag of swf.abcTags) for (const name of tag.abc.classNames()) lines.push(name);
      process.stdout.write(lines.join('\n') + '\n');
      break;
    }
    case 'disasm': {
      need(2, 'disasm <file.swf> <class> [method]');
      const swf = await Swf.load(args[0]!);
      const [, className, methodName] = args;
      for (const tag of swf.abcTags) {
        const abc = tag.abc;
        const ci = abc.findClass(className!);
        if (ci < 0) continue;
        const s = scriptOfClass(abc, ci);
        const refs = [...(s >= 0 ? scriptMethods(abc, s, false) : []), ...classMethods(abc, ci)];
        const selected = methodName
          ? refs.filter((r) => r.name === methodName || (methodName === 'constructor' && r.role === 'constructor') || (methodName === 'cinit' && r.role === 'class-init'))
          : refs;
        if (!selected.length) fail(`method '${methodName}' not found in ${className}`);
        process.stdout.write(selected.map((r) => disassembleMethod(abc, r.methodIndex, { title: describeMethodRef(abc, className!, r) })).join('\n'));
        return;
      }
      fail(`class '${className}' not found`);
    }
    case 'decompile': {
      need(2, 'decompile <file.swf> <class>');
      const swf = await Swf.load(args[0]!);
      for (const tag of swf.abcTags) {
        const ci = tag.abc.findClass(args[1]!);
        if (ci >= 0) {
          process.stdout.write(decompileClass(tag.abc, ci));
          return;
        }
      }
      fail(`class '${args[1]}' not found`);
    }
    case 'export-pcode': {
      need(2, 'export-pcode <file.swf> <dir>');
      const swf = await Swf.load(args[0]!);
      const r = await exportPcode(swf, args[1]!);
      process.stdout.write(`Exported ${r.methodCount} methods in ${r.files.length} files to ${r.outDir}\n`);
      break;
    }
    case 'import-pcode': {
      need(3, 'import-pcode <file.swf> <dir> <out.swf>');
      const swf = await Swf.load(args[0]!);
      const r = await importPcode(swf, args[1]!);
      await swf.save(args[2]!, { compression: compressionArg(values.compression) });
      for (const c of r.changed) process.stdout.write(`  updated method ${c.methodIndex} (${c.file})\n`);
      process.stdout.write(`${r.changed.length} method(s) updated, ${r.unchanged} unchanged. Saved ${args[2]}\n`);
      break;
    }
    case 'export-as3': {
      need(2, 'export-as3 <file.swf> <dir>');
      const swf = await Swf.load(args[0]!);
      const r = await exportSources(swf, args[1]!);
      process.stdout.write(`Wrote ${r.files.length} files to ${args[1]}${r.failed.length ? ` (${r.failed.length} classes failed, see comments in files)` : ''}\n`);
      break;
    }
    case 'import-as3':
    case 'compile': {
      const isImport = cmd === 'import-as3';
      need(3, isImport ? 'import-as3 <file.swf> <dir> <out.swf>' : 'compile <file.swf> <out.swf> <a.as> [b.as...]');
      const swf = await Swf.load(args[0]!);
      const out = isImport ? args[2]! : args[1]!;
      const r = isImport ? await importSources(swf, args[1]!) : await importSources(swf, process.cwd(), { files: args.slice(2) });
      await swf.save(out, { compression: compressionArg(values.compression) });
      for (const c of r.changes) process.stdout.write(`  ${c.action.padEnd(8)} ${c.className}${c.member === '<class>' ? '' : ' :: ' + c.member}\n`);
      process.stdout.write(`${r.changes.length} change(s). Saved ${out}\n`);
      break;
    }
    case 'build': {
      need(2, 'build <out.swf> <Main.as> [more.as...]');
      const files = await Promise.all(args.slice(1).map(async (f) => ({ name: f, text: await readFile(f, 'utf8') })));
      const { abc } = compileSources(files);
      const main = values.main ?? (() => {
        const first = args[1]!.split('/').pop()!.replace(/\.as$/, '');
        const ci = abc.instances.findIndex((_, i) => abc.className(i).split('.').pop() === first);
        return ci >= 0 ? abc.className(ci) : first;
      })();
      const swf = createSwf(abc, {
        documentClass: main,
        width: values.width ? Number(values.width) : undefined,
        height: values.height ? Number(values.height) : undefined,
      });
      await swf.save(args[0]!, { compression: compressionArg(values.compression) });
      process.stdout.write(`Built ${args[0]} (${abc.instances.length} classes, document class ${main})\n`);
      break;
    }
    case 'export-as2': {
      need(2, 'export-as2 <file.swf> <dir>');
      const files = await exportAs2(await Swf.load(args[0]!), args[1]!);
      process.stdout.write(`Wrote ${files.length} AS1/AS2 blocks to ${args[1]}\n`);
      break;
    }
    case 'import-as2': {
      need(3, 'import-as2 <file.swf> <dir> <out.swf>');
      const swf = await Swf.load(args[0]!);
      const changed = await importAs2(swf, args[1]!);
      await swf.save(args[2]!, { compression: compressionArg(values.compression) });
      for (const k of changed) process.stdout.write(`  updated ${k}\n`);
      process.stdout.write(`${changed.length} block(s) updated. Saved ${args[2]}\n`);
      break;
    }
    case 'export-assets': {
      need(2, 'export-assets <file.swf> <dir> [images,sounds,binary,texts]');
      const swf = await Swf.load(args[0]!);
      const kinds = (args[2] ? args[2].split(',') : ALL_ASSET_KINDS) as AssetKind[];
      const r = await exportAssets(swf, args[1]!, kinds);
      for (const s of r.skipped) process.stdout.write(`  skipped ${s.id}: ${s.reason}\n`);
      process.stdout.write(`Exported ${r.files.length} files to ${args[1]}\n`);
      break;
    }
    case 'replace': {
      need(4, 'replace <in.swf> <out.swf> <id> <file> [<id> <file>...]');
      if ((args.length - 2) % 2) fail('expected <id> <file> pairs');
      const swf = await Swf.load(args[0]!);
      for (let i = 2; i < args.length; i += 2) {
        const id = Number(args[i]);
        if (!Number.isInteger(id)) fail(`invalid character id '${args[i]}'`);
        const tag = replaceAsset(swf, id, new Uint8Array(await readFile(args[i + 1]!)));
        process.stdout.write(`  ${id} <- ${args[i + 1]} (${tag.name})\n`);
      }
      await swf.save(args[1]!, { compression: compressionArg(values.compression) });
      process.stdout.write(`Saved ${args[1]}\n`);
      break;
    }
    case 'decompress':
    case 'compress': {
      need(2, `${cmd} <in.swf> <out.swf>`);
      const c = unpackSwf(new Uint8Array(await readFile(args[0]!)));
      const compression: SwfCompression = cmd === 'decompress' ? 'none' : (compressionArg(args[2], 'zlib') as SwfCompression);
      const out = packSwf({ ...c, compression });
      await writeFile(args[1]!, out);
      process.stdout.write(`${args[0]} (${c.compression}) -> ${args[1]} (${compression}, ${out.length} bytes)\n`);
      break;
    }
    default:
      fail(`unknown command '${cmd}' (see --help)`);
  }
}

// Exit quietly when output is piped into e.g. `head`.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

main().catch((e: unknown) => {
  const err = e as Error;
  fail(err.message ?? String(e));
});
