import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inLinkedWorktree } from '../lib/worktree.js';

function git(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const hasGit = spawnSync('git', ['--version']).status === 0;

test('inLinkedWorktree: true only inside a linked worktree', { skip: !hasGit && 'git not installed' }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'piper-wt-')));
  try {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'sub', 'deeper'), { recursive: true });
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'sub', 'f.txt'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const wt = join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt);

    // Agree with git's own answer.
    assert.notEqual(git(wt, 'rev-parse', '--absolute-git-dir'), realpathSync(join(repo, '.git')));

    assert.equal(inLinkedWorktree(repo), false, 'main checkout');
    assert.equal(inLinkedWorktree(join(repo, 'sub', 'deeper')), false, 'main checkout subfolder');
    assert.equal(inLinkedWorktree(wt), true, 'linked worktree');
    assert.equal(inLinkedWorktree(join(wt, 'sub')), true, 'linked worktree subfolder');

    // A submodule-like checkout: a .git file pointing into .git/modules/<name>.
    const modDir = join(repo, '.git', 'modules', 'm');
    mkdirSync(modDir, { recursive: true });
    writeFileSync(join(modDir, 'HEAD'), 'ref: refs/heads/main\n');
    const sm = join(repo, 'm');
    mkdirSync(sm);
    writeFileSync(join(sm, '.git'), 'gitdir: ../.git/modules/m\n');
    assert.equal(inLinkedWorktree(sm), false, 'submodule');

    git(repo, 'worktree', 'remove', '--force', wt);
    assert.equal(inLinkedWorktree(wt), false, 'removed worktree');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('inLinkedWorktree: outside any repo, bad input and a broken .git file give false', () => {
  const base = mkdtempSync(join(tmpdir(), 'piper-wt-none-'));
  try {
    assert.equal(inLinkedWorktree(base), false);
    assert.equal(inLinkedWorktree(undefined), false);
    assert.equal(inLinkedWorktree('relative/path'), false);
    assert.equal(inLinkedWorktree(join(base, 'missing', 'folder')), false);
    const broken = join(base, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, '.git'), 'not a gitdir line\n');
    assert.equal(inLinkedWorktree(broken), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
