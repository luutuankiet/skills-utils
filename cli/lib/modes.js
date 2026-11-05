// Where each argument is peeked: on this disk, on an SSH host, or in a clone.
//
// The bash core (peek.sh) does the peeking in all three cases. This module only
// decides where it runs and, for git URLs, keeps a short-lived clone cache.

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, rmSync, renameSync, statSync,
  utimesSync, openSync, closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A folder holding this file was created by peek and may be deleted by it.
// The sweep touches nothing else, so a mistyped cache path cannot cost data.
export const MARKER = '.peek-owned';

const CLONE_PREFIX = /^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/;
const SSH_TARGET = /^([A-Za-z0-9._@-]+):(.*)$/;

// Decide the mode for one argument. `forced` is 'git', 'ssh' or null.
export function detect(arg, forced = null, exists = existsSync) {
  if (forced === 'git') return { mode: 'git', ...parseGitUrl(arg) };
  if (forced === 'ssh') {
    const m = SSH_TARGET.exec(arg);
    if (!m) return { mode: 'invalid', reason: `--ssh needs host:path, got ${arg}` };
    return { mode: 'ssh', host: m[1], path: m[2] || '~' };
  }
  if (CLONE_PREFIX.test(arg) || arg.endsWith('.git')) {
    return { mode: 'git', ...parseGitUrl(arg) };
  }
  const m = SSH_TARGET.exec(arg);
  if (m && !exists(arg)) return { mode: 'ssh', host: m[1], path: m[2] || '~' };
  return { mode: 'local', path: arg };
}

// Split a git URL into what to clone and where to look inside it.
// A GitHub https://host/owner/repo/tree/<ref>/<subdir> link becomes a clone of
// owner/repo at <ref>, peeked at <subdir>. A ref containing "/" is ambiguous in
// that form; the first segment is taken as the ref.
export function parseGitUrl(url) {
  const tree = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.*))?$/.exec(url);
  if (tree) {
    return { cloneUrl: `${tree[1]}.git`, ref: tree[2], subdir: (tree[3] || '').replace(/\/+$/, '') };
  }
  return { cloneUrl: url.replace(/\/+$/, ''), ref: null, subdir: '' };
}

// Credentials can ride inside an https URL. Never print them.
export function scrub(text) {
  return String(text).replace(/(\w+:\/\/)[^@/\s]+@/g, '$1***@');
}

export function cacheKey(cloneUrl, ref) {
  const bare = scrub(cloneUrl)
    .replace(/^\w+:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .replace(/\.git$/, '');
  return `${bare}@${ref || 'HEAD'}`.replace(/[^A-Za-z0-9._@-]+/g, '-');
}

export function cacheDir(env = process.env) {
  if (env.PEEK_CACHE_DIR) return env.PEEK_CACHE_DIR;
  const base = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'peek');
}

export function ttlMs(env = process.env) {
  const min = Number(env.PEEK_TTL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 30) * 60 * 1000;
}

// Delete every peek-owned entry not used within the TTL. Runs at the start of
// every peek, because a one-shot CLI has no timer to do it in between.
export function sweep(dir, ttl, now = Date.now()) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const name of entries) {
    const entry = join(dir, name);
    if (!existsSync(join(entry, MARKER))) continue;
    let age;
    try { age = now - statSync(entry).mtimeMs; } catch { continue; }
    if (age > ttl) {
      rmSync(entry, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

// Return the path of a clone of cloneUrl at ref, reusing a live one. Using an
// entry restarts its TTL. Throws with a scrubbed message when git fails.
export function ensureClone(cloneUrl, ref, { dir = cacheDir(), git = 'git' } = {}) {
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, cacheKey(cloneUrl, ref));
  const repo = join(entry, 'repo');

  if (existsSync(join(entry, MARKER)) && existsSync(repo)) {
    const now = new Date();
    utimesSync(entry, now, now);
    return { repo, reused: true };
  }

  // Clone beside the final name, then rename, so a run that dies mid-clone or
  // races another run never leaves a half-cloned entry that looks finished.
  const staging = `${entry}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  closeSync(openSync(join(staging, MARKER), 'w'));

  const args = ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--single-branch', '--no-tags'];
  if (ref) args.push('--branch', ref);
  args.push('--', cloneUrl, join(staging, 'repo'));

  const res = spawnSync(git, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.error || res.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    const why = res.error ? res.error.message : (res.stderr || '').trim();
    throw new Error(scrub(why || `git exited ${res.status}`));
  }

  rmSync(entry, { recursive: true, force: true });
  try {
    renameSync(staging, entry);
  } catch {
    // Another run finished the same clone first; use theirs.
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(repo)) throw new Error('clone vanished while being cached');
  }
  return { repo, reused: false };
}

// Quote one word for a POSIX shell on the far side of ssh.
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
