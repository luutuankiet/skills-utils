#!/usr/bin/env node
// Entry point for `npx @luutuankiet/peek`.
//
// The peeking itself stays in lib/peek.sh, in bash, because SSH mode pipes that
// same script to a remote host that may have no Node at all. This file only
// decides where the script runs. Today that is always here, on a local path;
// SSH and git-URL modes land on top of this dispatch.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'peek.sh');

const res = spawnSync('bash', [script, ...process.argv.slice(2)], { stdio: 'inherit' });

if (res.error) {
  // ENOENT here means no bash on PATH, which is the one host requirement.
  console.error(`peek: could not run bash: ${res.error.message}`);
  process.exit(127);
}
process.exit(res.status ?? 1);
