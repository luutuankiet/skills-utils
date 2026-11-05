import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pre, post, failure, isErrorResult, MEMORY_NOTE,
  DECISION_WHEN_CHANGED, NUDGE_ROUTE, SAVE_ERROR_RESULTS,
} from '../lib/claude.js';
import { NUDGE_TEXT } from '../lib/core.js';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcp-piper.js');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const fresh = (p = 'piper-cc-') => mkdtempSync(join(tmpdir(), p));

let seq = 0;
function setup() {
  const work = fresh();
  const state = join(fresh('piper-state-'), 'state');
  process.env.MCP_PIPER_STATE_DIR = state;
  return { work, state, id: `toolu_test_${++seq}` };
}

/** Run the real bin with a payload on stdin; returns parsed JSON or null. */
function hook(event, payload, state) {
  const res = spawnSync(process.execPath, [bin, 'hook', event], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, MCP_PIPER_STATE_DIR: state },
  });
  assert.equal(res.status, 0, `hook ${event} exited ${res.status}: ${res.stderr}`);
  return { out: res.stdout ? JSON.parse(res.stdout) : null, stdout: res.stdout, stderr: res.stderr };
}

const preEv = (id, cwd, tool_input) => ({
  hook_event_name: 'PreToolUse', tool_name: 'mcp__lab__echo', tool_use_id: id, cwd, tool_input,
});
const postEv = (id, cwd, tool_response) => ({
  hook_event_name: 'PostToolUse', tool_name: 'mcp__lab__echo', tool_use_id: id, cwd, tool_input: {}, tool_response,
});

test('defaults of the three experiment-driven settings', () => {
  assert.equal(DECISION_WHEN_CHANGED, 'allow');
  assert.equal(NUDGE_ROUTE, 'post');
  assert.equal(SAVE_ERROR_RESULTS, false);
});

// ---------------------------------------------------------------- PreToolUse ---

test('pre: a call with no pointer and no _save_to prints nothing', () => {
  const { work, state, id } = setup();
  const { stdout } = hook('pre', preEv(id, work, { q: 'hello', n: [1, { a: 'b' }] }), state);
  assert.equal(stdout, '');
  assert.equal(existsSync(state), false, 'no state written');
});

test('pre: pointers expand into updatedInput with "allow", every argument kept', () => {
  const { work, state, id } = setup();
  writeFileSync(join(work, 'script.js'), 'return 42;');
  const { out } = hook('pre', preEv(id, work, {
    code: '@file:script.js', other: 7, blobs: [{ b64: '@file64:script.js' }], lit: '@@file:x',
  }), state);
  const h = out.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal(h.permissionDecision, 'allow');
  assert.match(h.permissionDecisionReason, /^mcp-piper: /);
  assert.deepEqual(h.updatedInput, {
    code: 'return 42;', other: 7, blobs: [{ b64: Buffer.from('return 42;').toString('base64') }], lit: '@file:x',
  });
  assert.equal(h.additionalContext, undefined);
});

test('pre: the decision is configurable, including no decision at all', () => {
  const { work, id } = setup();
  writeFileSync(join(work, 'a.txt'), 'A');
  const ask = pre(preEv(id, work, { a: '@file:a.txt' }), { decision: 'ask' });
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask');
  const none = pre(preEv(id, work, { a: '@file:a.txt' }), { decision: null });
  assert.equal('permissionDecision' in none.hookSpecificOutput, false);
  assert.deepEqual(none.hookSpecificOutput.updatedInput, { a: 'A' });
});

for (const [name, input, pattern] of [
  ['missing file', { a: '@file:nope.txt' }, /file not found/],
  ['folder', { a: '@file:.' }, /is a folder/],
  ['_save_to not a string', { a: 'x', _save_to: 5 }, /_save_to must be a file path string/],
  ['_save_to parent cannot be created', { a: 'x', _save_to: 'blocker/sub/out.txt' }, /cannot create the folder/],
]) {
  test(`pre deny: ${name}`, () => {
    const { work, state, id } = setup();
    writeFileSync(join(work, 'blocker'), 'a file in the way');
    const { out } = hook('pre', preEv(id, work, input), state);
    const h = out.hookSpecificOutput;
    assert.equal(h.permissionDecision, 'deny');
    assert.match(h.permissionDecisionReason, /^mcp-piper: /);
    assert.match(h.permissionDecisionReason, pattern);
    assert.equal(h.updatedInput, undefined);
    assert.equal(existsSync(join(state, `${id}.json`)), false);
  });
}

test('pre: _save_to is stripped, its folder created, and state written', () => {
  const { work, state, id } = setup();
  const { out } = hook('pre', preEv(id, work, { q: 'x', _save_to: 'out/r.json' }), state);
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { q: 'x' });
  assert.ok(existsSync(join(work, 'out')));
  const st = JSON.parse(readFileSync(join(state, `${id}.json`), 'utf8'));
  assert.deepEqual(st, { saveTo: join(work, 'out/r.json'), expanded: false, nudge: false });
});

// ------------------------------------------------------------- inline nudge ---

const big = 'y'.repeat(20001);

test('nudge, post route (default): pre stays silent, post adds the tip', () => {
  const { work, state, id } = setup();
  const p = hook('pre', preEv(id, work, { text: big }), state);
  assert.equal(p.stdout, '');
  const { out } = hook('post', postEv(id, work, [{ type: 'text', text: 'ok' }]), state);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: NUDGE_TEXT } });
  assert.equal(existsSync(join(state, `${id}.json`)), false);
});

test('nudge, pre route: additionalContext on PreToolUse, input untouched', () => {
  const { work, id } = setup();
  const out = pre(preEv(id, work, { text: big }), { nudgeRoute: 'pre' });
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: NUDGE_TEXT } });
});

test('nudge: never on a call whose input was expanded from a pointer', () => {
  const { work, id } = setup();
  writeFileSync(join(work, 'big.txt'), big);
  for (const nudgeRoute of ['pre', 'post']) {
    const out = pre(preEv(id, work, { text: '@file:big.txt' }), { nudgeRoute });
    assert.equal(out.hookSpecificOutput.additionalContext, undefined);
    assert.equal(post(postEv(id, work, [{ type: 'text', text: 'ok' }]), { nudgeRoute }), null);
  }
});

test('nudge with _save_to: the stub and the tip arrive together', () => {
  const { work, id } = setup();
  pre(preEv(id, work, { text: big, _save_to: 'o.txt' }));
  const out = post(postEv(id, work, [{ type: 'text', text: 'res' }]));
  assert.equal(out.hookSpecificOutput.additionalContext, NUDGE_TEXT);
  assert.match(out.hookSpecificOutput.updatedToolOutput[0].text, /^mcp-piper: saved 1 file/);
});

// --------------------------------------------------------------- PostToolUse ---

test('post: no state for the call prints nothing', () => {
  const { work, state, id } = setup();
  assert.equal(hook('post', postEv(id, work, [{ type: 'text', text: 'x' }]), state).stdout, '');
});

function roundTrip(response, saveTo = 'res.txt') {
  const { work, state, id } = setup();
  hook('pre', preEv(id, work, { q: 'x', _save_to: saveTo }), state);
  const { out } = hook('post', postEv(id, work, response), state);
  assert.equal(existsSync(join(state, `${id}.json`)), false, 'state deleted');
  return { work, out, text: out && out.hookSpecificOutput.updatedToolOutput[0].text };
}

test('post: text array result saved, output replaced by a one-block array stub', () => {
  const needle = 'PAYLOAD_NEEDLE_' + 'z'.repeat(5000);
  const { work, out, text } = roundTrip([{ type: 'text', text: needle }]);
  const u = out.hookSpecificOutput.updatedToolOutput;
  assert.ok(Array.isArray(u));
  assert.equal(u.length, 1);
  assert.equal(u[0].type, 'text');
  assert.equal(readFileSync(join(work, 'res.txt'), 'utf8'), needle);
  assert.ok(!text.includes('PAYLOAD_NEEDLE'));
  assert.match(text, new RegExp(`- ${join(work, 'res.txt')} \\(4\\.9 KB, sha256 [0-9a-f]{16}, text\\)`));
});

test('post: structuredContent JSON string is pretty-printed', () => {
  const { work, text } = roundTrip('{"needle":"S","rows":[1]}', 'sc.json');
  assert.equal(readFileSync(join(work, 'sc.json'), 'utf8'), '{\n  "needle": "S",\n  "rows": [\n    1\n  ]\n}');
  assert.match(text, /, json\)$/m);
});

test('post: an object with content is handled like an array', () => {
  const { work } = roundTrip({ content: [{ type: 'text', text: 'obj' }] });
  assert.equal(readFileSync(join(work, 'res.txt'), 'utf8'), 'obj');
});

test('post: image result copies the original and lists it in the stub', () => {
  const { work: src } = setup();
  const orig = join(src, 'orig.png');
  writeFileSync(orig, Buffer.from('ORIGINAL_PNG'));
  const { work, text } = roundTrip([
    { type: 'image', data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg' },
    { type: 'text', text: `[Image: source: ${orig}]` },
  ], 'shot.png');
  assert.deepEqual(readdirSync(work), ['shot-img1.png']);
  assert.equal(readFileSync(join(work, 'shot-img1.png'), 'utf8'), 'ORIGINAL_PNG');
  assert.match(text, /^mcp-piper: saved 1 file\n- .*shot-img1\.png \(12 B, sha256 [0-9a-f]{16}, image\/png\)$/);
});

test('post: truncation warning reaches the stub with the cache key', () => {
  const key = 'b'.repeat(64);
  const { text } = roundTrip([{ type: 'text', text: `[1,2]\n\n... [truncated by mcpproxy]\nUse read_cache tool: key="${key}", offset=0` }]);
  assert.ok(text.includes(`key="${key}"`));
});

test('post: an error result is passed through, not saved, and state deleted', () => {
  const { work, state, id } = setup();
  hook('pre', preEv(id, work, { q: 'x', _save_to: 'err.txt' }), state);
  const r = hook('post', postEv(id, work, { isError: true, content: [{ type: 'text', text: 'boom' }] }), state);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(join(work, 'err.txt')), false);
  assert.equal(existsSync(join(state, `${id}.json`)), false);
});

test('post: error results are saved when the setting says so', () => {
  const { work, id } = setup();
  pre(preEv(id, work, { q: 'x', _save_to: 'err.txt' }));
  const out = post(postEv(id, work, { isError: true, content: [{ type: 'text', text: 'boom' }] }), { saveErrors: true });
  assert.match(out.hookSpecificOutput.updatedToolOutput[0].text, /saved 1 file/);
  assert.equal(readFileSync(join(work, 'err.txt'), 'utf8'), 'boom');
});

test('isErrorResult recognises the usual error shapes only', () => {
  assert.equal(isErrorResult({ isError: true }), true);
  assert.equal(isErrorResult({ is_error: true, content: [] }), true);
  assert.equal(isErrorResult([{ type: 'text', text: 'x' }]), false);
  assert.equal(isErrorResult('{"isError":true}'), false);
});

test('post-failure: deletes the state and prints nothing', () => {
  const { work, state, id } = setup();
  hook('pre', preEv(id, work, { q: 'x', _save_to: 'f.txt' }), state);
  assert.ok(existsSync(join(state, `${id}.json`)));
  const r = hook('post-failure', { hook_event_name: 'PostToolUseFailure', tool_use_id: id }, state);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(join(state, `${id}.json`)), false);
  assert.equal(failure({}), null);
});

test('post: if saving fails, the result is shown in full with a note', () => {
  const { work, id } = setup();
  pre(preEv(id, work, { q: 'x', _save_to: 'sub/out.txt' }));
  // Turn the target into a folder after validation so the write fails.
  mkdirSync(join(work, 'sub', 'out.txt'));
  const out = post(postEv(id, work, [{ type: 'text', text: 'keep me' }]));
  assert.equal(out.hookSpecificOutput.updatedToolOutput, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /could not save the result/);
});

// -------------------------------------------------------------- start notes ---

test('session-start and subagent-start add the memory note verbatim', () => {
  const { state } = setup();
  for (const [event, name] of [['session-start', 'SessionStart'], ['subagent-start', 'SubagentStart']]) {
    const { out } = hook(event, { hook_event_name: name }, state);
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: name, additionalContext: MEMORY_NOTE } });
  }
  assert.ok(MEMORY_NOTE.startsWith('mcp-piper is active for MCP tools.'));
  assert.ok(MEMORY_NOTE.endsWith('Details: the mcp-piper skill.'));
});

// ---------------------------------------------------------------- robustness ---

test('bad stdin never breaks the call', () => {
  const { state } = setup();
  for (const event of ['pre', 'post']) {
    assert.equal(hook(event, 'not json{', state).stdout, '');
    assert.equal(hook(event, '', state).stdout, '');
  }
});

test('an internal crash with a pointer involved denies; without one stays silent', () => {
  const { work } = setup();
  // A state folder that is a file makes writeState throw a plain error.
  const blocker = join(work, 'state-is-a-file');
  writeFileSync(blocker, '');
  const withSave = hook('pre', preEv('toolu_crash', work, { q: 'x', _save_to: 'o.txt' }), blocker);
  assert.equal(withSave.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(withSave.out.hookSpecificOutput.permissionDecisionReason, /^mcp-piper: internal error/);
  const plain = hook('pre', preEv('toolu_crash2', work, { text: big }), blocker);
  assert.equal(plain.stdout, '');
});

// ------------------------------------------------------------------- the CLI ---

test('--version prints the package version', () => {
  const res = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), `mcp-piper ${pkg.version}`);
});

test('doctor passes its checks on this machine', () => {
  const { state } = setup();
  const res = spawnSync(process.execPath, [bin, 'doctor'], {
    encoding: 'utf8', env: { ...process.env, MCP_PIPER_STATE_DIR: state },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /ok +node version/);
  assert.match(res.stdout, /ok +pointer dry run/);
  assert.match(res.stdout, /ok +state folder writable/);
});

test('unknown hook event exits 2', () => {
  const res = spawnSync(process.execPath, [bin, 'hook', 'nope'], { input: '{}', encoding: 'utf8' });
  assert.equal(res.status, 2);
});
