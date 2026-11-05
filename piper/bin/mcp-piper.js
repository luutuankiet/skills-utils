#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

console.log(`mcp-piper ${pkg.version} (placeholder release; the hook ships in 0.1.0)`);
process.exit(0);
