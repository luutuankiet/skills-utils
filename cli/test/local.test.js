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
