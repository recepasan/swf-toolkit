import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileSources, createSwf } from '../dist/index.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Order matters: interfaces and base classes first. */
export const AS3_FILES = ['Shapes.as', 'Base.as', 'Square.as', 'Helper.as', 'Bag.as', 'Main.as'];

export function fixtureSources() {
  return AS3_FILES.map((f) => ({ name: f, text: readFileSync(join(FIXTURES, 'as3', f), 'utf8') }));
}

/** Compiles the AS3 fixture program into a fresh SWF. */
export function buildFixtureSwf() {
  const { abc, result } = compileSources(fixtureSources());
  return { swf: createSwf(abc, { documentClass: 'Main' }), abc, result };
}

export const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
