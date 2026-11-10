import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from 'node:fs';
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

// --- private projects: folders directly under tmp/projects ---

const PROJECT_SENTENCE = /private project is maintained like a repository/;

function age(root, rel, isoDate) {
  const t = new Date(isoDate);
  utimesSync(join(root, rel), t, t);
}

function bullets(res) {
  return res.stdout.split('\n').filter((l) => l.startsWith('- '));
}

// buildTree plus two private projects (one holding a .git), markers deeper
// inside a project, and a marker in the priority folder itself. The projects
// are older than every other marker in the tree.
function buildProjectTree() {
  const root = buildTree();
  put(root, 'tmp/projects/alpha/AGENTS.md', '# Alpha study\nPricing notes.\n');
  put(root, 'tmp/projects/alpha/docs/AGENTS.md', '# Alpha docs\nHidden.\n');
  put(root, 'tmp/projects/alpha/a/b/CLAUDE.md', '# Alpha deep\nHidden.\n');
  put(root, 'tmp/projects/beta/AGENTS.md', '# Beta rebuild\nHas its own history.\n');
  put(root, 'tmp/projects/beta/pkg/AGENTS.md', '# Beta pkg\nHidden.\n');
  git(join(root, 'tmp', 'projects', 'beta'), 'init', '-q');
  put(root, 'tmp/projects/AGENTS.md', '# Projects shelf\nAn ordinary folder.\n');
  age(root, 'tmp/projects/alpha/AGENTS.md', '2020-01-01T00:00:00Z');
  age(root, 'tmp/projects/beta/AGENTS.md', '2020-06-01T00:00:00Z');
  return root;
}

for (const engine of ['find', 'rg']) {
  const skip = engine === 'rg' && !hasRg && 'rg not on PATH';

  test(`private projects rank first, tagged, with what is below them hidden (${engine})`,
    { skip }, () => {
      const root = buildProjectTree();
      try {
        const res = nested(root, { PEEK_NESTED_ENGINE: engine });
        assert.equal(res.status, 0, res.stderr);
        const lines = bullets(res);
        assert.equal(lines.length, 6, res.stdout);
        // Newest first within the rank; both older than the ordinary WIP folder.
        assert.match(lines[0], /^- tmp\/projects\/beta · private project · 2020-06-01 · "Beta rebuild"/);
        assert.match(lines[1], /^- tmp\/projects\/alpha · private project · 2020-01-01 · "Alpha study"/);
        assert.match(lines[2], /· work in progress /);
        assert.match(lines[3], /· work in progress /);
        assert.match(res.stdout, /^- tmp\/projects · work in progress \(untracked\) · /m);
        assert.match(res.stdout, /^- wip · work in progress \(gitignored\) · /m);
        assert.match(lines[4], /^- pkg · tracked · /);
        assert.match(lines[5], /^- clones\/lib · separate repo · /);
        assert.doesNotMatch(res.stdout, /Hidden|alpha\/docs|alpha\/a|beta\/pkg/);
        assert.doesNotMatch(res.stdout, /more$/m);
        const tail = res.stdout.trimEnd().split('\n');
        assert.match(tail[tail.length - 2], /^If one of these relates to this task/);
        assert.match(tail[tail.length - 1], PROJECT_SENTENCE);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

  test(`no private project: the extra sentence is not printed (${engine})`, { skip }, () => {
    const root = buildTree();
    try {
      const res = nested(root, { PEEK_NESTED_ENGINE: engine });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(bullets(res).length, 3, res.stdout);
      assert.doesNotMatch(res.stdout, /private project/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`markers below a project are not counted in "+N more" (${engine})`, { skip }, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'peek-nested-')));
    try {
      put(root, 'tmp/projects/alpha/AGENTS.md', '# Alpha\n');
      for (let i = 0; i < 5; i++) put(root, `tmp/projects/alpha/deep${i}/AGENTS.md`, '# Hidden\n');
      for (let i = 0; i < 12; i++) put(root, `other/o${i}/AGENTS.md`, `# Other ${i}\n`);
      age(root, 'tmp/projects/alpha/AGENTS.md', '2020-01-01T00:00:00Z');
      const res = nested(root, { PEEK_NESTED_ENGINE: engine });
      assert.equal(res.status, 0, res.stderr);
      const lines = bullets(res);
      assert.equal(lines.length, 10, res.stdout);
      assert.match(lines[0], /^- tmp\/projects\/alpha · private project · /);
      assert.match(res.stdout, /^\+3 more$/m);
      assert.match(res.stdout, PROJECT_SENTENCE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`more than ten projects still print ten lines in total (${engine})`, { skip }, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'peek-nested-')));
    try {
      for (let i = 0; i < 12; i++) put(root, `tmp/projects/p${i}/AGENTS.md`, `# Project ${i}\n`);
      put(root, 'wip/AGENTS.md', '# WIP\n');
      const res = nested(root, { PEEK_NESTED_ENGINE: engine });
      assert.equal(res.status, 0, res.stderr);
      const lines = bullets(res);
      assert.equal(lines.length, 10, res.stdout);
      for (const l of lines) assert.match(l, /^- tmp\/projects\/p\d+ · private project · /);
      assert.match(res.stdout, /^\+3 more$/m);
      assert.equal(res.stdout.match(/Nested agent context below/g).length, 1);
      assert.equal(res.stdout.match(PROJECT_SENTENCE).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`PEEK_NESTED_PRIORITY names another priority folder (${engine})`, { skip }, () => {
    const root = buildProjectTree();
    try {
      put(root, 'work/items/gamma/AGENTS.md', '# Gamma\nMoved here.\n');
      put(root, 'work/items/gamma/sub/AGENTS.md', '# Gamma sub\nHidden.\n');
      age(root, 'work/items/gamma/AGENTS.md', '2019-01-01T00:00:00Z');
      const res = nested(root, { PEEK_NESTED_ENGINE: engine, PEEK_NESTED_PRIORITY: './work/items/' });
      assert.equal(res.status, 0, res.stderr);
      const lines = bullets(res);
      assert.match(lines[0], /^- work\/items\/gamma · private project · 2019-01-01 · /);
      assert.equal(res.stdout.match(/· private project ·/g).length, 1, res.stdout);
      assert.doesNotMatch(res.stdout, /gamma\/sub/);
      // The default folder is ordinary again: nothing below it is hidden.
      assert.match(res.stdout, /^- tmp\/projects\/alpha · work in progress \(untracked\) · /m);
      assert.match(res.stdout, /^- tmp\/projects\/beta · separate repo · /m);
      assert.match(res.stdout, /^- tmp\/projects\/alpha\/docs · /m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
