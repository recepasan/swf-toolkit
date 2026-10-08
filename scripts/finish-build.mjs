// Post-build step: mark the CommonJS output as CommonJS and make the CLI executable.
import { chmodSync, writeFileSync } from 'node:fs';

writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), JSON.stringify({ type: 'commonjs' }) + '\n');
chmodSync(new URL('../dist/cli.js', import.meta.url), 0o755);
