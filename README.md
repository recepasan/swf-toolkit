# swf-toolkit

**English** | [Türkçe](README.tr.md)

[![npm](https://img.shields.io/npm/v/swf-toolkit.svg)](https://www.npmjs.com/package/swf-toolkit)
[![CI](https://github.com/recepasan/swf-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/recepasan/swf-toolkit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/swf-toolkit.svg)](LICENSE)

A pure TypeScript library and CLI for reading, editing and writing Adobe Flash SWF files. No Java or other external tools required.

- **SWF:** Reads and writes FWS, CWS (zlib) and ZWS (LZMA). LZMA encoder and decoder included. Unmodified files are written back byte-for-byte.
- **AS3 decompiler:** Produces readable ActionScript 3 source. Recovers if/else, loops, for-in/for-each, switch, try/catch and `&&`/`||`/ternary expressions.
- **AS3 compiler:** Compiles edited or newly written `.as` files to AVM2 bytecode. Add methods and fields to existing classes, define new classes and interfaces, or build a SWF from scratch.
- **AVM2 P-code:** Disassembler and assembler for bytecode-level editing. Constant pools, stack and scope limits are handled automatically.
- **AS1/AS2 (AVM1):** Disassembler and assembler for DoAction/DoInitAction blocks.
- **Assets:** Export and replace images (PNG/JPEG/GIF), sounds (MP3/WAV), binary data and text fields.

Requires Node.js 18+. Ships both ESM (`import`) and CommonJS (`require()`) builds. No runtime dependencies.

## Installation

```bash
npm install swf-toolkit        # as a library
npm install -g swf-toolkit     # as a CLI (swf-toolkit command)
npx swf-toolkit info game.swf  # run without installing
```

## CLI

```bash
# Inspect
swf-toolkit info game.swf
swf-toolkit classes game.swf
swf-toolkit decompile game.swf com.foo.Bar
swf-toolkit disasm game.swf com.foo.Bar init

# Source-level AS3 editing
swf-toolkit export-as3 game.swf ./src           # one .as file per class
#   … edit files under ./src, add new .as files …
swf-toolkit import-as3 game.swf ./src out.swf   # only changed members are compiled
swf-toolkit compile game.swf out.swf New.as Other.as

# Build a SWF from scratch
swf-toolkit build app.swf Main.as lib/Helper.as --main Main --width 800 --height 600

# Bytecode (P-code) editing
swf-toolkit export-pcode game.swf ./pcode
swf-toolkit import-pcode game.swf ./pcode out.swf

# AS1/AS2
swf-toolkit export-as2 old.swf ./as2
swf-toolkit import-as2 old.swf ./as2 out.swf

# Assets
swf-toolkit export-assets game.swf ./assets            # images, sounds, binary, texts
swf-toolkit replace game.swf out.swf 12 new.png 40 music.mp3

# Compression
swf-toolkit decompress game.swf plain.swf
swf-toolkit compress plain.swf small.swf lzma
```

`import-as3` compares each class with the decompiled form of its current bytecode. Methods whose text has not changed keep their original bytecode, so code the decompiler cannot reproduce perfectly stays intact as long as you leave it alone. Methods that could not be decompiled are written with a `// Decompilation failed` comment and their P-code. They are never replaced with an empty body unless you write a new body yourself.

## Library

```ts
import { Swf, decompileClass, compileClassSource, compileSources, createSwf } from 'swf-toolkit';

const swf = await Swf.load('game.swf');
const abc = swf.abcTags[0].abc;

// Edit a class as AS3
const ci = abc.findClass('com.foo.Bar');
const src = decompileClass(abc, ci);
const edited = src.replace('return 10;', 'return 99;');
compileClassSource(abc, edited);              // only changed members are compiled
await swf.save('game-patched.swf');

// Build a SWF from scratch
const { abc: fresh } = compileSources([{ name: 'Main.as', text: mainSource }]);
await createSwf(fresh, { documentClass: 'Main' }).save('app.swf');
```

Other APIs:

- P-code: `disassembleMethod`, `assembleMethod`, `exportPcode`, `importPcode`.
- Bytecode tools: `decodeCode`, `encodeCode`, `computeLimits`, `verifyCode`.
- Parser: `parseAs3`.
- Assets: `exportAssets`, `replaceAsset`.
- AVM1: `decodeActions`, `formatActions`, `parseActions`, `encodeActions`.

## How the compiler resolves names

Local variables and parameters are bound to registers. Variables captured by closures are stored in activation-object slots. Every other name is emitted as a `Multiname` with the class's open namespace set and resolved by the VM through the scope chain, which is what the Flex compiler does for names it cannot bind early. Type annotations (`var x:Foo`, parameters, return types) are resolved to QNames using imports, the same package, top-level classes and the SWF's own constant pool, so `playerglobal.swc` is not needed.

For classes without a constructor, an implicit constructor is generated for non-constant field initialisers. As in Flex, these values are assigned before the `super()` call.

Supported language features: classes, interfaces, inheritance, `super`, getters/setters, static members, constants, default and `...rest` parameters, closures, every loop form (including labelled break/continue), switch, try/catch/finally, `with`, regular expressions, Vector, object and array literals, `as`/`is`/`instanceof`/`in`/`typeof`/`delete`, compound assignments (including `&&=` and `||=`), E4X access (`.@attr`, `..child`, `.(filter)`) and XML literals (compiled to `new XML(...)` at runtime).

## Tests

```bash
npm test
```

Tests use Node's built-in `node:test` module. They cover:

- LZMA, SWF container and ABC round-trips, the P-code round-trip and the verifier.
- The parser, the compiler and decompile → compile → decompile stability.
- PNG, sound and AVM1 round-trips.

If [Ruffle](https://ruffle.rs) is installed (`/Applications/Ruffle.app` or `RUFFLE=/path/to/ruffle`), the compiled test program runs in a real Flash VM and 59 runtime checks are verified. Without Ruffle this test is skipped.

## Limitations

- **No type checking.** Type errors only surface at runtime. Interface conformance and override signatures are not checked either.
- **finally:** `finally` blocks are duplicated on the normal exit, `return`, `break` and `continue` paths.
- **Namespace declarations:** Package-level namespace declarations (`public namespace x = "..."`) are not compiled. Existing namespaces can be used with `use namespace` and `ns::name`.
- **XML literals:** `{expression}` interpolation is not supported.
- **Decompiler:** Works well on Flex/ASC output. Methods that fail on obfuscated code are shown as P-code in comments.
- **Assets:** Fonts and shape/sprite vector graphics are not converted and are kept as raw tags. JPEG3/4 alpha channels are exported as a separate mask PNG. Nellymoser and Speex sounds are exported as raw data.

## License

MIT
