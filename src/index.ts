export * from './errors.js';
export { ByteReader } from './io/reader.js';
export { ByteWriter } from './io/writer.js';

// Compression
export * from './compression/lzma.js';
export * from './compression/swf-container.js';

// SWF container and tags
export * from './swf/tag-codes.js';
export * from './swf/tags.js';
export * from './swf/swf.js';

// AVM2 / ABC
export * from './abc/constants.js';
export * from './abc/abc-file.js';
export * from './abc/opcodes.js';
export * from './abc/code.js';
export * from './abc/analysis.js';
export * from './abc/interner.js';
export * from './abc/model.js';

// P-code
export * from './abc/pcode/format.js';
export * from './abc/pcode/disassembler.js';
export * from './abc/pcode/assembler.js';
export { tokenizeLine } from './abc/pcode/lexer.js';

// Project-level workflows
export * from './project/pcode-project.js';

// Decompiler
export * from './decompiler/ast.js';
export { buildCfg, findLoops, dominates, type Cfg, type Block, type Loop } from './decompiler/cfg.js';
export { simulate, SimulationError, type MethodContext, type Terminator } from './decompiler/simulate.js';
export { Structurer } from './decompiler/structure.js';
export * from './decompiler/method.js';
export * from './decompiler/class-printer.js';
export * from './project/source-export.js';

// Compiler
export { CompileError, tokenize as tokenizeAs3 } from './compiler/lexer.js';
export type * as As3Ast from './compiler/ast.js';
export { parseAs3, Parser as As3Parser } from './compiler/parser.js';
export { FunctionCompiler, TOPLEVEL_NAMES, type ClassScope, type FunctionOptions } from './compiler/codegen.js';
export { buildClassScope } from './compiler/scope.js';
export * from './compiler/class-compiler.js';
export * from './compiler/program.js';
export * from './project/source-import.js';

// Assets
export * from './assets/png.js';
export * from './assets/images.js';
export * from './assets/sounds.js';
export * from './assets/assets.js';

// AVM1 (AS1/AS2)
export * from './avm1/avm1.js';
export * from './avm1/project.js';
