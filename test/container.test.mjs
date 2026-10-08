import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lzmaCompress, lzmaDecompress, packSwf, unpackSwf, Swf, ByteReader, ByteWriter } from '../dist/index.js';
import { buildFixtureSwf, eq } from './helpers.mjs';

test('LZMA round-trips random, repetitive and empty data', () => {
  const text = new TextEncoder().encode('swf-toolkit '.repeat(5000) + 'çğıöşü ✓');
  for (const input of [randomBytes(70000), text, new Uint8Array(0), new Uint8Array(1), new Uint8Array(300000)]) {
    const { props, data } = lzmaCompress(new Uint8Array(input));
    assert.ok(eq(lzmaDecompress(props, data, input.length), new Uint8Array(input)));
  }
});

test('LZMA compresses repetitive data', () => {
  const input = new TextEncoder().encode('abcabcabd'.repeat(20000));
  const { data } = lzmaCompress(input);
  assert.ok(data.length < input.length / 20);
});

test('bit fields round-trip', () => {
  const w = new ByteWriter();
  w.ub(5, 13).sb(13, -1234).fb(20, 1.5).align();
  w.u8(7).encodedU32(0xfffffff0).s24(-5);
  const r = new ByteReader(w.toBytes());
  assert.equal(r.ub(5), 13);
  assert.equal(r.sb(13), -1234);
  assert.equal(r.fb(20), 1.5);
  assert.equal(r.u8(), 7);
  assert.equal(r.encodedU32(), 0xfffffff0);
  assert.equal(r.s24(), -5);
});

test('SWF containers: FWS / CWS / ZWS', () => {
  const { swf } = buildFixtureSwf();
  const body = swf.encodeBody();
  for (const compression of ['none', 'zlib', 'lzma']) {
    const bytes = packSwf({ compression, version: 15, body });
    const back = unpackSwf(bytes);
    assert.equal(back.compression, compression);
    assert.ok(eq(back.body, body));
  }
});

test('parsed SWF re-serialises byte-for-byte', () => {
  const { swf } = buildFixtureSwf();
  const bytes = swf.toBytes({ compression: 'none' });
  const parsed = Swf.parse(bytes);
  assert.ok(eq(parsed.toBytes({ compression: 'none' }), bytes));
  // ABC parse + write is lossless too.
  for (const t of parsed.abcTags) t.abc;
  assert.ok(eq(parsed.toBytes({ compression: 'none' }), bytes));
  assert.equal(parsed.documentClass, 'Main');
});
