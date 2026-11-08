import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mermaidLiveUrl, decodeMermaidUrl, scanDelta, newState, mermaidStateDir, sweepMermaidState,
} from '../lib/mermaid.js';
import { messageDisplay } from '../lib/claude.js';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcp-piper.js');

let seq = 0;
function setup() {
  const state = join(mkdtempSync(join(tmpdir(), 'piper-mermaid-')), 'state');
  process.env.MCP_PIPER_STATE_DIR = state;
  return { state, id: `msg-${process.pid}-${++seq}` };
}

const env = (state, extra = {}) => ({ ...process.env, MCP_PIPER_STATE_DIR: state, ...extra });
const ev = (message_id, index, final, delta) => ({ hook_event_name: 'MessageDisplay', message_id, index, final, delta });

/** Run the real bin on one batch; returns displayContent, or null when it printed nothing. */
function hook(payload, state, extra) {
  const res = spawnSync(process.execPath, [bin, 'hook', 'messagedisplay'], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: env(state, extra),
  });
  assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput.displayContent : null;
}

function hookAsync(payload, state, extra) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'hook', 'messagedisplay'], { env: env(state, extra) });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`exit ${code}`));
      resolve(out ? JSON.parse(out).hookSpecificOutput.displayContent : null);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

const links = (text) => [...String(text).matchAll(/^([ \t]*)↳ \[open diagram (\d+)\]\((https:\/\/mermaid\.live\/edit#pako:[^)]+)\)$/gm)]
  .map((m) => ({ indent: m[1], n: Number(m[2]), code: decodeMermaidUrl(m[3]).code }));

const block = (code, fence = '```', indent = '') =>
  `${indent}${fence}mermaid\n${code.split('\n').map((l) => indent + l).join('\n')}\n${indent}${fence}\n`;

test('payload decodes back to the diagram text and the expected settings', () => {
  const code = 'flowchart LR\n  A["ünïcode"] --> B';
  const url = mermaidLiveUrl(code);
  assert.match(url, /^https:\/\/mermaid\.live\/edit#pako:[A-Za-z0-9_-]+$/);
  const obj = decodeMermaidUrl(url);
  assert.deepEqual(obj, { code, mermaid: JSON.stringify({ theme: 'default' }), autoSync: true, updateDiagram: true });
});

test('claude -p shape: one final call carrying the whole message', () => {
  const { state, id } = setup();
  const code = 'flowchart LR\n  A --> B';
  const delta = `Here:\n${block(code)}done\n`;
  const out = hook(ev(id, 0, true, delta), state);
  assert.equal(out, delta.replace('```\ndone', `\`\`\`\n↳ [open diagram 1](${mermaidLiveUrl(code)})\ndone`));
  assert.deepEqual(links(out), [{ indent: '', n: 1, code }]);
  assert.ok(out.endsWith('\n'));
  assert.equal(existsSync(state), false, 'a single-call message leaves no state behind');
});

test('fast path: a single call with no mermaid prints nothing and touches no files', () => {
  const { state, id } = setup();
  assert.equal(hook(ev(id, 0, true, 'plain text\n```js\nx\n```\n'), state), null);
  assert.equal(existsSync(state), false);
});

test('fence split across batches, line endings of every delta kept', () => {
  const { state, id } = setup();
  const b0 = 'intro\n```mermaid\n';
  const b1 = 'flowchart TD\n';
  const b2 = '  A --> B\n```\nafter\n';
  assert.equal(hook(ev(id, 0, false, b0), state), null);
  assert.equal(hook(ev(id, 1, false, b1), state), null);
  const out = hook(ev(id, 2, false, b2), state);
  assert.deepEqual(links(out), [{ indent: '', n: 1, code: 'flowchart TD\n  A --> B' }]);
  assert.ok(out.startsWith('  A --> B\n```\n↳ '));
  assert.ok(out.endsWith('\nafter\n'));
  assert.equal(hook(ev(id, 3, true, ''), state), null);
  assert.deepEqual(readdirSync(join(state, 'mermaid')), [], 'final batch cleans up');
});

test('out of order: final batch 1 starts before batch 0 and still links', async () => {
  const { state, id } = setup();
  const late = hookAsync(ev(id, 1, true, 'flowchart LR\n  A-->B\n```\n\ndone'), state);
  await new Promise((r) => setTimeout(r, 300));
  const first = await hookAsync(ev(id, 0, false, '```mermaid\n'), state);
  assert.equal(first, null);
  const out = await late;
  assert.equal(out, `flowchart LR\n  A-->B\n\`\`\`\n↳ [open diagram 1](${mermaidLiveUrl('flowchart LR\n  A-->B')})\n\ndone`);
});

test('timeout waiting for the previous batch passes through and hands on lost', () => {
  const { state, id } = setup();
  const fast = { MCP_PIPER_MERMAID_WAIT_MS: '50' };
  // Batch 0 never ran. Batch 1 times out and shows the original.
  const t0 = Date.now();
  assert.equal(hook(ev(id, 1, false, '```mermaid\n'), state, fast), null);
  assert.deepEqual(readdirSync(join(state, 'mermaid')), [`${id}.1.json`], 'batch 1 still leaves a state');
  // Batch 2 reads "lost" at once (default wait, so a cascade would show up as 3 s).
  const t1 = Date.now();
  assert.equal(hook(ev(id, 2, false, 'flowchart LR\n  A-->B\n```\n'), state), null);
  assert.ok(Date.now() - t1 < 2000, `batch 2 should not wait, took ${Date.now() - t1} ms`);
  assert.equal(hook(ev(id, 3, true, 'end\n'), state), null);
  assert.deepEqual(readdirSync(join(state, 'mermaid')), []);
  assert.ok(Date.now() - t0 < 6000);
});

test('MCP_PIPER_MERMAID=0 prints nothing', () => {
  const { state, id } = setup();
  assert.equal(hook(ev(id, 0, true, block('flowchart LR\n  A-->B')), state, { MCP_PIPER_MERMAID: '0' }), null);
  assert.equal(existsSync(state), false);
});

test('malformed stdin or missing fields: no output, exit 0', () => {
  const { state, id } = setup();
  const body = block('flowchart LR\n  A-->B');
  for (const p of ['{not json', '', 'null', '[]', '"x"',
    { index: 0, final: true, delta: body },
    { message_id: id, final: true, delta: body },
    { message_id: id, index: 0, delta: body },
    { message_id: id, index: 0, final: true },
    { message_id: id, index: -1, final: true, delta: body },
    { message_id: id, index: '0', final: true, delta: body },
    { message_id: id, index: 0, final: 'yes', delta: body }]) {
    const res = spawnSync(process.execPath, [bin, 'hook', 'messagedisplay'], {
      input: typeof p === 'string' ? p : JSON.stringify(p), encoding: 'utf8', env: env(state),
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', `printed for ${JSON.stringify(p)}`);
  }
});

test('tilde fences and indented fences: indent stripped from the body, kept on the link', () => {
  const st = newState();
  const r = scanDelta(st, `- item\n${block('flowchart LR\n  A-->B', '~~~~', '   ')}`, true);
  assert.deepEqual(links(r.text), [{ indent: '   ', n: 1, code: 'flowchart LR\n  A-->B' }]);
  // A shorter closing fence, or the other fence character, does not close.
  const r2 = scanDelta(newState(), '````mermaid\ngraph TD\n```\n~~~~\n````\n', true);
  assert.deepEqual(links(r2.text), [{ indent: '', n: 1, code: 'graph TD\n```\n~~~~' }]);
});

test('info string: "mermaid title" accepted, look-alikes not', () => {
  assert.equal(links(scanDelta(newState(), '```mermaid title="x"\ngraph TD\n```\n', true).text).length, 1);
  for (const open of ['```mermaidx', '```{mermaid}', '``` js mermaid', '```mermaid `x`']) {
    assert.equal(scanDelta(newState(), `${open}\ngraph TD\n\`\`\`\n`, true).changed, false, open);
  }
});

test('open fence at final is linked at the end, on its own line', () => {
  const r = scanDelta(newState(), 'x\n```mermaid\ngraph TD\n  A-->B', true);
  assert.equal(r.text, `x\n\`\`\`mermaid\ngraph TD\n  A-->B\n↳ [open diagram 1](${mermaidLiveUrl('graph TD\n  A-->B')})`);
  const r2 = scanDelta(newState(), '```mermaid\ngraph TD\n', true);
  assert.ok(r2.text.endsWith(')\n'));
  // Empty body: nothing to link.
  assert.equal(scanDelta(newState(), '```mermaid\n', true).changed, false);
  // Across batches with an empty final delta.
  const { state, id } = setup();
  hook(ev(id, 0, false, '```mermaid\ngraph TD\n'), state);
  const out = hook(ev(id, 1, true, ''), state);
  assert.deepEqual(links(out), [{ indent: '', n: 1, code: 'graph TD' }]);
});

test('several diagrams in one message are numbered in order, across batches', () => {
  const { state, id } = setup();
  const a = hook(ev(id, 0, false, `${block('graph TD\n  A-->B')}text\n${block('graph LR\n  C-->D')}`), state);
  assert.deepEqual(links(a).map((l) => l.n), [1, 2]);
  const b = hook(ev(id, 1, true, block('pie\n  "x": 1')), state);
  assert.deepEqual(links(b), [{ indent: '', n: 3, code: 'pie\n  "x": 1' }]);
});

test('a mermaid opener inside another fence is content and gets no link', () => {
  const msg = '````markdown\n```mermaid\ngraph TD\n```\n````\n';
  assert.equal(scanDelta(newState(), msg, true).changed, false);
  // The outer fence closing at the inner one's length: inner ``` closes ```markdown, as CommonMark reads it.
  const msg2 = '```markdown\n```mermaid\ngraph TD\n```\n';
  assert.equal(scanDelta(newState(), msg2, true).changed, false);
  // A real diagram after the outer fence still gets number 1.
  assert.deepEqual(links(scanDelta(newState(), `${msg}${block('graph TD\n  A-->B')}`, true).text).map((l) => l.n), [1]);
});

test('handler called in process returns MessageDisplay output', () => {
  setup();
  const out = messageDisplay(ev('in-proc', 0, true, block('graph TD\n  A-->B')));
  assert.equal(out.hookSpecificOutput.hookEventName, 'MessageDisplay');
  assert.equal(links(out.hookSpecificOutput.displayContent).length, 1);
});

test('stale state files are swept after 24 hours', () => {
  setup();
  const dir = mermaidStateDir();
  mkdirSync(dir, { recursive: true });
  const old = join(dir, 'gone.0.json');
  writeFileSync(old, '{}');
  const past = (Date.now() - 25 * 3600 * 1000) / 1000;
  utimesSync(old, past, past);
  writeFileSync(join(dir, 'fresh.0.json'), '{}');
  assert.equal(sweepMermaidState(), 1);
  assert.deepEqual(readdirSync(dir), ['fresh.0.json']);
});
