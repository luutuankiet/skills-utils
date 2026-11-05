import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync,
  chmodSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, parseGitUrl, scrub, cacheKey, sweep, MARKER } from '../lib/modes.js';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'peek.js');
const run = (args, env = {}, cwd = tmpdir()) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

// ------------------------------------------------------------- detection ---

test('detection: URLs clone, host:path goes over ssh, the rest is local', () => {
  const none = () => false;
  assert.equal(detect('https://github.com/o/r', null, none).mode, 'git');
  assert.equal(detect('git@github.com:o/r.git', null, none).mode, 'git');
  assert.equal(detect('ssh://git@host/o/r', null, none).mode, 'git');
  assert.equal(detect('../some/repo.git', null, none).mode, 'git');
  assert.deepEqual(detect('pi:/srv/app', null, none), { mode: 'ssh', host: 'pi', path: '/srv/app' });
  assert.deepEqual(detect('thinkpad:', null, none), { mode: 'ssh', host: 'thinkpad', path: '~' });
  assert.equal(detect('/home/me/repo', null, none).mode, 'local');
  assert.equal(detect('weird:name', null, () => true).mode, 'local', 'an existing local path wins');
  assert.equal(detect('a:b.git', 'ssh', none).mode, 'ssh', '--ssh overrides the .git rule');
  assert.equal(detect('/no/colon', 'ssh', none).mode, 'invalid');
});

test('GitHub tree links become a clone at that ref, peeked at that subdir', () => {
  assert.deepEqual(parseGitUrl('https://github.com/o/r/tree/dev/pkg/core/'),
    { cloneUrl: 'https://github.com/o/r.git', ref: 'dev', subdir: 'pkg/core' });
  assert.deepEqual(parseGitUrl('https://github.com/o/r/tree/main'),
    { cloneUrl: 'https://github.com/o/r.git', ref: 'main', subdir: '' });
  assert.deepEqual(parseGitUrl('https://github.com/o/r'),
    { cloneUrl: 'https://github.com/o/r', ref: null, subdir: '' });
});

test('tokens in URLs never reach output or cache folder names', () => {
  assert.equal(scrub('fatal: https://ghp_SECRET@github.com/o/r'), 'fatal: https://***@github.com/o/r');
  assert.equal(scrub('https://user:pw@host/x'), 'https://***@host/x');
  assert.doesNotMatch(cacheKey('https://ghp_SECRET@github.com/o/r.git', null), /SECRET/);
  assert.equal(cacheKey('git@github.com:o/r.git', 'dev'), cacheKey('https://github.com/o/r', 'dev'));
});

// ----------------------------------------------------------------- sweep ---

test('the sweep deletes only expired folders that peek marked as its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peek-sweep-'));
  try {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (const [name, marked, stale] of [['ours-old', 1, 1], ['ours-new', 1, 0], ['theirs-old', 0, 1]]) {
      mkdirSync(join(dir, name));
      if (marked) writeFileSync(join(dir, name, MARKER), '');
      if (stale) utimesSync(join(dir, name), old, old);
    }
    assert.deepEqual(sweep(dir, 30 * 60 * 1000), ['ours-old']);
    assert.deepEqual(readdirSync(dir).sort(), ['ours-new', 'theirs-old']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ clone mode ---

function makeOrigin() {
  const root = mkdtempSync(join(tmpdir(), 'peek-origin-'));
  const work = join(root, 'work');
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: work, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  mkdirSync(join(work, 'skills', 'demo'), { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(work, 'AGENTS.md'), '# Cloned contract\n');
  writeFileSync(join(work, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: From a clone.\n---\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return { root, url: `file://${work}` };
}

test('clone mode peeks a git URL, then reuses the cached clone', () => {
  const { root, url } = makeOrigin();
  const cache = join(root, 'cache');
  try {
    const first = run([url], { PEEK_CACHE_DIR: cache });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^ROOT: .*cache\/.*\/repo$/m);
    assert.match(first.stdout, /# Cloned contract/);
    assert.match(first.stdout, /demo\n\s+From a clone\./);
    assert.match(first.stdout, /Cloned file:\/\//);

    const [entry] = readdirSync(cache);
    assert.ok(existsSync(join(cache, entry, MARKER)));
    writeFileSync(join(cache, entry, 'repo', 'sentinel'), '');

    const second = run([url], { PEEK_CACHE_DIR: cache });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Reused the cached clone/);
    assert.ok(existsSync(join(cache, entry, 'repo', 'sentinel')), 'no fresh clone on reuse');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an expired clone is deleted by the next peek, whatever it targets', () => {
  const { root, url } = makeOrigin();
  const cache = join(root, 'cache');
  try {
    assert.equal(run([url], { PEEK_CACHE_DIR: cache }).status, 0);
    const [entry] = readdirSync(cache);
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(join(cache, entry), old, old);

    run(['/no/such/path'], { PEEK_CACHE_DIR: cache });
    assert.deepEqual(readdirSync(cache), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed clone says so, exits 3, and leaves nothing in the cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'peek-fail-'));
  try {
    const res = run([`file://${root}/missing.git`], { PEEK_CACHE_DIR: join(root, 'cache') });
    assert.equal(res.status, 3);
    assert.match(res.stdout, /CLONE FAILED/);
    assert.deepEqual(readdirSync(join(root, 'cache')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- ssh mode ---

test('ssh mode pipes the script to the host and labels ROOT with the host', () => {
  const root = mkdtempSync(join(tmpdir(), 'peek-ssh-'));
  try {
    const repo = join(root, "it's repo");
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), '# Remote contract\n');
    // Stands in for ssh: drop the host, run the remote command with our stdin.
    const fake = join(root, 'fake-ssh');
    writeFileSync(fake, '#!/bin/sh\nshift\nexec sh -c "$1"\n');
    chmodSync(fake, 0o755);

    const res = run(['box:' + repo], { PEEK_SSH: fake });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`^ROOT: box:${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(res.stdout, /# Remote contract/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
