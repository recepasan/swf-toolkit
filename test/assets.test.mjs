import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePng,
  encodePng,
  encodeLossless2,
  decodeLossless,
  RawTag,
  TagCode,
  encodeWav,
  encodeDefineSound,
  extractSound,
  parseMp3,
  parseActions,
  encodeActions,
  decodeActions,
  formatActions,
} from '../dist/index.js';
import { eq } from './helpers.mjs';

function gradient(w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i % 256, (i * 7) % 256, (i * 13) % 256, i % 3 ? 255 : 0], i * 4);
  return { width: w, height: h, data };
}

test('PNG encode / decode round-trip', () => {
  const img = gradient(37, 11);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 37);
  assert.ok(eq(back.data, img.data));
});

test('DefineBitsLossless2 round-trip (opaque and transparent pixels)', () => {
  const img = gradient(20, 20);
  const tag = new RawTag(TagCode.DefineBitsLossless2, encodeLossless2(5, img));
  assert.equal(tag.characterId, 5);
  const back = decodeLossless(tag);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) assert.equal(back.data[i + 3], 0);
    else assert.deepEqual([...back.data.subarray(i, i + 4)], [...img.data.subarray(i, i + 4)]);
  }
});

test('WAV → DefineSound → WAV', () => {
  const pcm = new Int16Array(1000).map((_, i) => Math.round(Math.sin(i / 5) * 9000));
  const wav = encodeWav(new Uint8Array(pcm.buffer), 11025, 1, 16);
  const s = extractSound(new RawTag(TagCode.DefineSound, encodeDefineSound(3, wav)));
  assert.equal(s.ext, 'wav');
  assert.equal(s.info.rate, 11025);
  assert.ok(eq(s.data, wav));
});

test('MP3 frames are parsed and stored', () => {
  const frameLen = Math.floor((144 * 128000) / 44100);
  const mp3 = new Uint8Array(frameLen * 4);
  for (let f = 0; f < 4; f++) mp3.set([0xff, 0xfb, 0x90, 0x44], f * frameLen);
  const info = parseMp3(mp3);
  assert.deepEqual([info.rate, info.channels, info.sampleCount], [44100, 2, 4608]);
  const s = extractSound(new RawTag(TagCode.DefineSound, encodeDefineSound(4, mp3)));
  assert.equal(s.ext, 'mp3');
  assert.ok(eq(s.data, mp3));
});

test('AVM1 P-code round-trip', () => {
  const src = [
    '  ConstantPool "a", "b"',
    'L0:',
    '  Push c:0, 1, d:2.5, f:0.5, r:1, true, null, undefined',
    '  If L1',
    '  DefineFunction "f", ["x"], L1',
    '  Push "x"',
    '  GetVariable',
    '  Return',
    'L1:',
    '  Try 0x1, "e", L2, L3, L3',
    '  Jump L0',
    'L2:',
    '  Trace',
    'L3:',
    '  End',
  ].join('\n');
  const bytes = encodeActions(parseActions(src));
  const text = formatActions(decodeActions(bytes));
  assert.ok(eq(encodeActions(parseActions(text)), bytes));
});
