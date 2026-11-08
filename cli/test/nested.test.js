import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'lib', 'peek.sh');
const repoRoot = join(here, '..', '..');
const hook = join(repoRoot, 'hooks', 'nested-context.mjs');
const hasRg = spawnSync('rg', ['--version']).status === 0;

function nested(dir, env = {}) {
  return spawnSync('bash', [script, '--nested', dir], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function put(root, rel, body) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

// Root repo with its own contract, a gitignored WIP folder, a tracked nested
// folder and a nested clone, each with an AGENTS.md.
function buildTree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'peek-nested-')));
  git(root, 'init', '-q');
  put(root, 'AGENTS.md', '# Root contract\n');
  put(root, 'CLAUDE.md', '@AGENTS.md\n');
  put(root, '.gitignore', 'wip/\n');
  put(root, 'wip/AGENTS.md', '# WIP index\nChurn study notes.\n');
  put(root, 'wip/CLAUDE.md', '@AGENTS.md\n');
  put(root, 'pkg/AGENTS.md', '# Package contract\nTracked rules.\n');
  git(root, 'add', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'pkg/AGENTS.md');
  git(root, 'commit', '-q', '-m', 'fixture');
  put(root, 'clones/lib/AGENTS.md', '# Upstream lib\nCloned for reading.\n');
  git(join(root, 'clones', 'lib'), 'init', '-q');
  return root;
}

for (const engine of ['find', 'rg']) {
  test(`nested lines rank WIP, tracked, separate repo (${engine})`,
    { skip: engine === 'rg' && !hasRg && 'rg not on PATH' }, () => {
      const root = buildTree();
      try {
        const res = nested(root, { PEEK_NESTED_ENGINE: engine });
        assert.equal(res.status, 0, res.stderr);
        const lines = res.stdout.split('\n').filter((l) => l.startsWith('- '));
        assert.equal(lines.length, 3, res.stdout);
        assert.match(lines[0], /^- wip · work in progress \(gitignored\) · /);
        assert.match(lines[0], /"WIP index" Churn study notes\./);
        assert.match(lines[1], /^- pkg · tracked · /);
        assert.match(lines[2], /^- clones\/lib · separate repo · /);
        assert.equal(res.stdout.match(/^- wip /gm).length, 1);
        assert.doesNotMatch(res.stdout, /Root contract/);
        assert.match(res.stdout, /^If one of these relates to this task, run peek <path>/m);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
}

test('no nested markers: empty output, exit 0', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'peek-nested-')));
  try {
    put(root, 'AGENTS.md', '# Only the root\n');
    put(root, 'src/a.txt', 'x\n');
    const res = nested(root);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tiny budget prints scan incomplete and returns promptly', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'peek-nested-')));
  try {
    put(root, 'wip/AGENTS.md', '# WIP\n');
    for (let d = 0; d < 50; d++) {
      mkdirSync(join(root, 'scratch', `d${d}`), { recursive: true });
      for (let f = 0; f < 80; f++) writeFileSync(join(root, 'scratch', `d${d}`, `f${f}`), '');
    }
    const t0 = Date.now();
    const res = nested(root, { PEEK_NESTED_BUDGET_MS: '1', PEEK_NESTED_ENGINE: 'find' });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /scan incomplete/);
    assert.ok(elapsed < 3000, `took ${elapsed} ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook wrapper answers SubagentStart with the nudge, and nothing on an empty tree', () => {
  const root = buildTree();
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'peek-nested-')));
  const runHook = (cwd) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd, hook_event_name: 'SubagentStart' }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: repoRoot },
  });
  try {
    const res = runHook(root);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.match(out.hookSpecificOutput.additionalContext, /^- wip · /m);

    const none = runHook(empty);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});
