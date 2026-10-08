import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixtureSources } from './helpers.mjs';

const require = createRequire(import.meta.url);

test('CommonJS build works with require()', () => {
  // Resolved through package.json "exports" → "require" condition.
  const cjs = require('swf-toolkit');
  assert.equal(typeof cjs.compileSources, 'function');
  assert.match(require.resolve('swf-toolkit'), /dist[\\/]cjs[\\/]index\.js$/);

  const { abc } = cjs.compileSources(fixtureSources());
  const swf = cjs.createSwf(abc, { documentClass: 'Main' });
  const bytes = swf.toBytes({ compression: 'lzma' });
  const back = cjs.Swf.parse(bytes);
  assert.equal(back.documentClass, 'Main');
  assert.ok(cjs.decompileClass(back.abcTags[0].abc, back.abcTags[0].abc.findClass('tests.Helper')).includes('public static function twice'));
});
