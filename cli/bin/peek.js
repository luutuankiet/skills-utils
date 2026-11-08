#!/usr/bin/env node
// Entry point for `npx @luutuankiet/peek`.
//
// The peeking itself stays in lib/peek.sh, in bash, because SSH mode pipes that
// same script to a remote host that may have no Node at all. This file decides,
// per argument, where the script runs: here, over SSH, or in a cached clone.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detect, ensureClone, sweep, cacheDir, ttlMs, scrub, shQuote,
} from '../lib/modes.js';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'peek.sh');
const BAR = '━'.repeat(60);

const USAGE = `usage: peek [--ssh | --git] <target> [<target> ...]
       peek --nested [<dir>]

  <target> is one of
    /any/path/inside/a/repo          a file or directory on this machine
    host:/path/on/that/host          read over ssh; the host needs only bash
    https://github.com/owner/repo    clone, cached ${'$'}PEEK_TTL_MIN (30) minutes
    git@github.com:owner/repo.git    same, over ssh credentials
    https://github.com/o/r/tree/<ref>/<subdir>

  --ssh / --git force the mode for every target after them.
  --nested lists folders below <dir> (default: here) that hold their own
  AGENTS.md, CLAUDE.md or CLAUDE.local.md, one preview line each.
  Clones live in ${cacheDir()} and are deleted 30 minutes after their
  last peek, at the start of the next peek run.`;

function runBash(args, opts = {}) {
  const res = spawnSync('bash', [script, ...args], { stdio: 'inherit', ...opts });
  if (res.error) {
    // ENOENT here means no bash on PATH, which is the one host requirement.
    console.error(`peek: could not run bash: ${res.error.message}`);
    return 127;
  }
  return res.status ?? 1;
}

function failure(label, target, detail) {
  console.log(BAR);
  console.log(`${label}  ${scrub(target)}`);
  for (const line of String(detail).split('\n')) if (line.trim()) console.log(`  ${line}`);
  console.log('');
  return 3;
}

function peekSsh({ host, path }) {
  const ssh = process.env.PEEK_SSH || 'ssh';
  const remote = `bash -s -- --root-prefix ${shQuote(`${host}:`)} ${shQuote(path)}`;
  const res = spawnSync(ssh, [host, remote], {
    input: readFileSync(script),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (res.error) return failure('SSH FAILED', `${host}:${path}`, res.error.message);
  // 255 is ssh's own failure (unreachable, auth); anything else is peek's code.
  if (res.status === 255) return failure('SSH FAILED', `${host}:${path}`, 'ssh could not connect; see the error above.');
  return res.status ?? 1;
}

function peekGit({ cloneUrl, ref, subdir }) {
  let clone;
  try {
    clone = ensureClone(cloneUrl, ref);
  } catch (err) {
    return failure('CLONE FAILED', cloneUrl + (ref ? `@${ref}` : ''), err.message);
  }
  const target = subdir ? join(clone.repo, subdir) : clone.repo;
  const status = runBash([target]);
  const minutes = Math.round(ttlMs() / 60000);
  const via = clone.url && clone.url !== cloneUrl ? ` (https was refused, so over ssh as ${clone.url})` : '';
  console.log(`  ${clone.reused ? 'Reused the cached clone of' : 'Cloned'} ${scrub(cloneUrl)}${ref ? ` at ${ref}` : ''}${via}.`);
  console.log(`  It is a shallow copy kept ${minutes} minutes after its last peek, then deleted.\n`);
  return status;
}

function main(argv) {
  if (argv.length === 0) {
    console.error('peek: no target given\n');
    console.error(USAGE);
    return 2;
  }

  // Local only, one folder: the same listing the session-start hook prints.
  if (argv[0] === '--nested') return runBash(['--nested', argv[1] || process.cwd()]);

  let forced = null;
  const targets = [];
  let flagsDone = false;
  for (const a of argv) {
    if (!flagsDone && (a === '-h' || a === '--help')) { console.log(USAGE); return 0; }
    if (!flagsDone && a === '--ssh') { forced = 'ssh'; continue; }
    if (!flagsDone && a === '--git') { forced = 'git'; continue; }
    if (!flagsDone && a === '--') { flagsDone = true; continue; }
    targets.push(detect(a, forced));
  }
  if (targets.length === 0) { console.error('peek: no target given'); return 2; }

  // Lazy garbage collection: the only moment a one-shot CLI gets to run.
  sweep(cacheDir(), ttlMs());

  const codes = targets.map((t) => {
    switch (t.mode) {
      case 'local': return runBash([t.path]);
      case 'ssh': return peekSsh(t);
      case 'git': return peekGit(t);
      default: console.error(`peek: ${t.reason}`); return 2;
    }
  });

  // Same contract as the script: 3 only when nothing could be read at all.
  if (codes.every((c) => c === 3)) return 3;
  const bad = codes.find((c) => c !== 0 && c !== 3);
  return bad ?? 0;
}

process.exit(main(process.argv.slice(2)));
