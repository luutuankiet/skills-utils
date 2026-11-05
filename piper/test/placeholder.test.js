import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/mcp-piper.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('bin prints its version and exits 0', () => {
  const out = execFileSync(process.execPath, [bin], { encoding: 'utf8' });
  assert.match(out, new RegExp(`mcp-piper ${pkg.version.replace(/\./g, '\\.')}`));
});
