// gh-doc helper scripts (skills/mcp-piper/scripts), run with python3 on small
// fixtures. No network: no images, and gh-doc-back.py runs without --upload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'mcp-piper', 'scripts');
const LINK = 'Edit in Excalidraw: https://excalidraw.com/#json=DBJ8acDzMflZMLA344AQU,Y_Vd2N0tlcS06kKchmRMVw';

const loaded = [
  '<!-- excalidraw-mermaid:begin DBJ8acDzMflZMLA344AQU -->',
  '```mermaid',
  '%% generated from https://excalidraw.com/#json=DBJ8acDzMflZMLA344AQU,Y_Vd2N0tlcS06kKchmRMVw; reading copy, edits here do not change the canvas',
  'flowchart LR',
  '  a --> b',
  '```',
  '<!-- excalidraw-mermaid:end DBJ8acDzMflZMLA344AQU -->',
].join('\n');

const failed = [
  '<!-- excalidraw-mermaid:begin Zx9_k-2 -->',
  '```mermaid',
  '%% could not load: HTTP 404',
  '```',
  '<!-- excalidraw-mermaid:end Zx9_k-2 -->',
].join('\n');

// What the GitHub block should hold: links and text, no reading copies.
const clean = `# Title\n\n${LINK}\n\nNext paragraph.\n\nSecond: https://excalidraw.com/#json=Zx9_k-2,key\n\nLast line.\n`;
const withCopies = `# Title\n\n${LINK}\n\n${loaded}\n\nNext paragraph.\n\nSecond: https://excalidraw.com/#json=Zx9_k-2,key\n\n${failed}\n\nLast line.\n`;

function run(script, args) {
  return spawnSync('python3', ['-I', join(scripts, script), ...args], { encoding: 'utf8' });
}

function back(tabText) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-doc-back-'));
  const tab = join(dir, 'tab.gdoc.md');
  writeFileSync(tab, tabText);
  writeFileSync(join(dir, 'hashes.txt'), '');
  const out = join(dir, 'back.md');
  const res = run('gh-doc-back.py', [tab, join(dir, 'hashes.txt'), out]);
  let text = null;
  try { text = readFileSync(out, 'utf8'); } catch {}
  return { res, text };
}

test('back strips loaded and failed reading copies, leaving links and text byte-identical', () => {
  const { res, text } = back(`<!-- working copy marker -->\n${withCopies}`);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(text, clean);
});

test('back refuses to write when a stray marker is left', () => {
  const stray = `<!-- working copy marker -->\n${LINK}\n\n<!-- excalidraw-mermaid:begin orphan -->\nflowchart LR\n\nText.\n`;
  const { res, text } = back(stray);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /^gh-doc: nothing posted: line 4 /);
  assert.equal(text, null, 'no back.md is written');
});

test('back refuses a lone %% generated from line', () => {
  const { res } = back(`<!-- marker -->\nText\n%% generated from https://excalidraw.com/#json=a,b\n`);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /^gh-doc: nothing posted: line 3 /);
});

test('fork strips reading copies from the GitHub body before doc.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-doc-fork-'));
  writeFileSync(join(dir, 'body.md'), withCopies.replace(/\n/g, '\r\n'));
  writeFileSync(join(dir, 'body.html'), '');
  const res = run('gh-doc-fork.py', [join(dir, 'body.md'), join(dir, 'body.html'), dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(join(dir, 'doc.md'), 'utf8'), clean);
});
