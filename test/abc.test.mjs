import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AbcFile,
  Interner,
  assembleMethods,
  decodeCode,
  disassembleMethod,
  encodeCode,
  exportPcode,
  importPcode,
  findMethod,
  verifyCode,
  Swf,
} from '../dist/index.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureSwf, eq } from './helpers.mjs';

test('ABC parse/write is lossless', () => {
  const { abc } = buildFixtureSwf();
  const bytes = abc.toBytes();
  assert.ok(eq(AbcFile.parse(bytes).toBytes(), bytes));
});

test('method code decodes and re-encodes identically', () => {
  const { abc } = buildFixtureSwf();
  for (const b of abc.bodies) {
    const d = decodeCode(b.code, b.exceptions);
    const e = encodeCode(d.items, d.exceptions);
    assert.ok(eq(e.code, b.code), `method ${b.method}`);
    assert.deepEqual(e.exceptions, b.exceptions);
  }
});

test('compiled code passes structural verification', () => {
  const { abc } = buildFixtureSwf();
  for (const b of abc.bodies) {
    const d = decodeCode(b.code, b.exceptions);
    assert.deepEqual(verifyCode(abc, d.items, d.exceptions), [], `method ${b.method}`);
  }
});

test('P-code disassemble → assemble round-trips every method', () => {
  const { abc } = buildFixtureSwf();
  const original = abc.toBytes();
  const target = AbcFile.parse(original);
  const interner = new Interner(target);
  for (let i = 0; i < abc.methods.length; i++) assembleMethods(target, disassembleMethod(abc, i), { limits: 'keep', interner });
  assert.ok(eq(target.toBytes(), original));
});

test('assembler grows maxstack and interns new constants', () => {
  const { abc } = buildFixtureSwf();
  const m = findMethod(abc, 'tests.Helper', 'twice');
  assert.ok(m >= 0);
  const text = disassembleMethod(abc, m).replace(
    'code\n',
    'code\n  findpropstrict QName(PackageNamespace(""), "trace")\n  pushstring "brand new string"\n  pushstring "x"\n  pushstring "y"\n  callpropvoid QName(PackageNamespace(""), "trace"), 3\n',
  );
  assembleMethods(abc, text);
  const body = abc.methodBody(m);
  assert.ok(body.maxStack >= 4);
  assert.ok(abc.strings.includes('brand new string'));
});

test('assembler reports errors with line numbers', () => {
  const { abc } = buildFixtureSwf();
  assert.throws(() => assembleMethods(abc, 'method 0\ncode\n  pushbyte 1000\nend\n'), /3:\d+:.*range/);
  assert.throws(() => assembleMethods(abc, 'method 0\ncode\n  jump Lmissing\nend\n'), /Undefined label/);
});

test('export-pcode / import-pcode only touches edited methods', async () => {
  const { swf } = buildFixtureSwf();
  const dir = mkdtempSync(join(tmpdir(), 'swft-pcode-'));
  try {
    const parsed = Swf.parse(swf.toBytes());
    await exportPcode(parsed, dir);
    const noop = await importPcode(Swf.parse(swf.toBytes()), dir);
    assert.equal(noop.changed.length, 0);
    const file = join(dir, 'tests', 'Helper.pcode');
    writeFileSync(file, readFileSync(file, 'utf8').replace('pushstring "hi "', 'pushstring "hello "'));
    const target = Swf.parse(swf.toBytes());
    const r = await importPcode(target, dir);
    assert.equal(r.changed.length, 1);
    assert.ok(target.abcTags[0].abc.strings.includes('hello '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
