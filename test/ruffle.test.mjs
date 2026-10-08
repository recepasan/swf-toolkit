/**
 * Runtime test: runs the compiled fixture program in the Ruffle Flash player
 * and checks every `check()` trace. Skipped when Ruffle is not installed.
 *
 *   RUFFLE=/path/to/ruffle npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureSwf } from './helpers.mjs';

const RUFFLE = process.env.RUFFLE ?? '/Applications/Ruffle.app/Contents/MacOS/ruffle';
// The sandboxed macOS app can only read files inside its container.
const DIR = process.platform === 'darwin' ? join(homedir(), 'Library/Containers/rs.ruffle.ruffle/Data/swf-toolkit-test') : join(process.cwd(), '.ruffle-test');

test('compiled AS3 runs correctly in Ruffle', { skip: !existsSync(RUFFLE) && 'Ruffle not installed', timeout: 60000 }, async () => {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, 'test.swf');
  writeFileSync(file, buildFixtureSwf().swf.toBytes());
  const out = await new Promise((resolve) => {
    const p = spawn(RUFFLE, ['--storage', 'memory', file], { env: { ...process.env, RUST_LOG: 'warn,avm_trace=trace' } });
    let log = '';
    const onData = (d) => {
      log += d.toString();
      if (/DONE|ERROR/.test(log)) setTimeout(() => p.kill(), 200);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const timer = setTimeout(() => p.kill(), 30000);
    p.on('exit', () => {
      clearTimeout(timer);
      resolve(log.replace(/\x1b\[[0-9;]*m/g, ''));
    });
  });
  const traces = out.split('\n').filter((l) => l.includes('avm_trace')).map((l) => l.replace(/^.*avm_trace: /, ''));
  const failures = traces.filter((l) => l.startsWith('FAIL'));
  assert.deepEqual(failures, []);
  assert.ok(!/ERROR ruffle_core::avm2/.test(out), out.split('\n').filter((l) => l.includes('ERROR')).join('\n'));
  assert.ok(traces.includes('DONE'), 'program did not finish');
  assert.ok(traces.filter((l) => l.startsWith('PASS')).length >= 50);
});
