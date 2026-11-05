import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'peek.js');

function run(args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

test('local mode resolves imports and lists skills from a file deep inside the repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'peek-test-'));
  try {
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    writeFileSync(join(repo, 'AGENTS.md'), '# Fixture contract\n');
    mkdirSync(join(repo, 'skills', 'demo'), { recursive: true });
    writeFileSync(
      join(repo, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: A fixture skill.\n---\nbody\n'
    );
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    writeFileSync(join(repo, 'src', 'deep', 'file.ts'), '');

    const res = run([join(repo, 'src', 'deep', 'file.ts')], tmpdir());
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^ROOT: .*peek-test-/m);
    assert.match(res.stdout, /# Fixture contract/);
    assert.match(res.stdout, /demo\n\s+A fixture skill\./);
    assert.doesNotMatch(res.stdout, /^body$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a path that does not exist exits 3', () => {
  const res = run(['/no/such/path/anywhere'], tmpdir());
  assert.equal(res.status, 3);
  assert.match(res.stdout, /NOT FOUND/);
});

function bareProject(withGit) {
  const dir = mkdtempSync(join(tmpdir(), 'peek-bare-'));
  if (withGit) spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Bare project\nWhat it does.\n');
  writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "bare"\n');
  writeFileSync(join(dir, '.env'), 'API_KEY=x\n');
  writeFileSync(join(dir, 'server.pem'), 'x\n');
  mkdirSync(join(dir, 'src', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.py'), '');
  writeFileSync(join(dir, 'src', 'pkg', 'a.py'), '');
  if (withGit) spawnSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

for (const withGit of [true, false]) {
  test(`no agent context (${withGit ? 'git repo' : 'not a git repo'}): README, manifest and tree, never secrets`, () => {
    const dir = bareProject(withGit);
    try {
      const res = run([join(dir, 'src', 'main.py')], tmpdir());
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, new RegExp(`^ROOT: .*${dir.split('/').pop()}$`, 'm'));
      assert.match(res.stdout, /README\.md \(first \d+ lines\)[^]*# Bare project/);
      assert.match(res.stdout, /──── pyproject\.toml ─+\n\[project\]/);
      assert.match(res.stdout, /src\/  \(2 files\)\n\s+main\.py\n\s+pkg\/  \(1\)/);
      assert.doesNotMatch(res.stdout, /\.env|server\.pem|API_KEY/);
      if (!withGit) assert.match(res.stdout, /Not a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a folder of repos still points at the repos instead of exploring itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peek-parent-'));
  try {
    mkdirSync(join(dir, 'child'));
    writeFileSync(join(dir, 'child', 'AGENTS.md'), '# child\n');
    const res = run([dir], tmpdir());
    assert.match(res.stdout, /NO REPOSITORY[^]*child/);
    assert.doesNotMatch(res.stdout, /tree \(/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
