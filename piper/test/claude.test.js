import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pre, post, failure, isErrorResult, MEMORY_NOTE,
  DECISION_WHEN_CHANGED, NUDGE_ROUTE, SAVE_ERROR_RESULTS,
} from '../lib/claude.js';
import { NUDGE_TEXT } from '../lib/core.js';
import { absHint, stagingRoot } from '../lib/abs.js';

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
  assert.equal(DECISION_WHEN_CHANGED, null);
  assert.equal(NUDGE_ROUTE, 'pre');
  assert.equal(SAVE_ERROR_RESULTS, false);
});

// ---------------------------------------------------------------- PreToolUse ---

test('pre: a call with no pointer and no _save_to prints nothing', () => {
  const { work, state, id } = setup();
  const { stdout } = hook('pre', preEv(id, work, { q: 'hello', n: [1, { a: 'b' }] }), state);
  assert.equal(stdout, '');
  assert.equal(existsSync(state), false, 'no state written');
});

test('pre: pointers expand into updatedInput with no decision, every argument kept', () => {
  const { work, state, id } = setup();
  writeFileSync(join(work, 'script.js'), 'return 42;');
  const { out } = hook('pre', preEv(id, work, {
    code: '@file:script.js', other: 7, blobs: [{ b64: '@file64:script.js' }], lit: '@@file:x',
  }), state);
  const h = out.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal('permissionDecision' in h, false);
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
  const allow = pre(preEv(id, work, { a: '@file:a.txt' }), { decision: 'allow' });
  assert.equal(allow.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(allow.hookSpecificOutput.permissionDecisionReason, /^mcp-piper: /);
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

test('nudge, pre route (default): additionalContext on PreToolUse, input untouched, no state', () => {
  const { work, state, id } = setup();
  const { out } = hook('pre', preEv(id, work, { text: big }), state);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: NUDGE_TEXT } });
  assert.equal(existsSync(join(state, `${id}.json`)), false);
});

test('nudge, post route: pre stays silent, post adds the tip', () => {
  const { work, state, id } = setup();
  assert.equal(pre(preEv(id, work, { text: big }), { nudgeRoute: 'post' }), null);
  const out = post(postEv(id, work, [{ type: 'text', text: 'ok' }]), { nudgeRoute: 'post' });
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: NUDGE_TEXT } });
  assert.equal(existsSync(join(state, `${id}.json`)), false);
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

test('nudge with _save_to: pre route tips on PreToolUse, post route with the stub', () => {
  const { work, id } = setup();
  const p = pre(preEv(id, work, { text: big, _save_to: 'o.txt' }));
  assert.equal(p.hookSpecificOutput.additionalContext, NUDGE_TEXT);
  assert.deepEqual(p.hookSpecificOutput.updatedInput, { text: big });
  const plain = post(postEv(id, work, [{ type: 'text', text: 'res' }]));
  assert.equal(plain.hookSpecificOutput.additionalContext, undefined);
  assert.match(plain.hookSpecificOutput.updatedToolOutput[0].text, /^mcp-piper: saved 1 file/);
  pre(preEv(id, work, { text: big, _save_to: 'o.txt' }), { nudgeRoute: 'post' });
  const out = post(postEv(id, work, [{ type: 'text', text: 'res' }]), { nudgeRoute: 'post' });
  assert.equal(out.hookSpecificOutput.additionalContext, NUDGE_TEXT);
  assert.match(out.hookSpecificOutput.updatedToolOutput[0].text, /^mcp-piper: saved 1 file/);
});

// --------------------------------------------------------------- PostToolUse ---

test('post: no state for the call prints nothing', () => {
  const { work, state, id } = setup();
  assert.equal(hook('post', postEv(id, work, [{ type: 'text', text: 'x' }]), state).stdout, '');
});

function roundTrip(response, saveTo = 'res.txt', extra = {}) {
  const { work, state, id } = setup();
  hook('pre', preEv(id, work, { q: 'x', _save_to: saveTo }), state);
  const { out } = hook('post', { ...postEv(id, work, response), ...extra }, state);
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

// Claude Code keeps a session's transcript at <projects>/<session>.jsonl and
// the files it saves from tool results under <projects>/<session>/tool-results/.
function session() {
  const projects = fresh('piper-projects-');
  const sid = `sess-${++seq}`;
  const results = join(projects, sid, 'tool-results');
  mkdirSync(results, { recursive: true });
  return { results, extra: { session_id: sid, transcript_path: join(projects, `${sid}.jsonl`) } };
}

test('post: image result copies the original and lists it in the stub', () => {
  const { results, extra } = session();
  const orig = join(results, 'orig.png');
  writeFileSync(orig, Buffer.from('ORIGINAL_PNG'));
  const { work, text } = roundTrip([
    { type: 'image', data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg' },
    { type: 'text', text: `[Image: source: ${orig}]` },
  ], 'shot.png', extra);
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

test('post: _save_to ending in / writes embedded resources at their paths, stub lists them', () => {
  const { work, text } = roundTrip([
    { type: 'text', text: 'pulled' },
    { type: 'text', text: '[Resource from lab at tabs/1 Intro.md] # Intro\n' },
  ], 'wc/');
  assert.equal(readFileSync(join(work, 'wc', 'result.txt'), 'utf8'), 'pulled');
  assert.equal(readFileSync(join(work, 'wc', 'tabs', '1 Intro.md'), 'utf8'), '# Intro\n');
  assert.match(text, /^mcp-piper: saved 2 files\n/);
  assert.ok(text.includes(join(work, 'wc', 'tabs', '1 Intro.md')));
  assert.ok(!text.includes('# Intro'));
});

test('post: a refused resource path writes nothing and shows the result with the mcp-piper reason', () => {
  const { work, state, id } = setup();
  hook('pre', preEv(id, work, { q: 'x', _save_to: 'wc/' }), state);
  const { out } = hook('post', postEv(id, work, [
    { type: 'text', text: '[Resource from lab at ok.md] fine' },
    { type: 'text', text: '[Resource from lab at ../escape.md] bad' },
  ]), state);
  assert.equal(out.hookSpecificOutput.updatedToolOutput, undefined, 'result passes through');
  assert.match(out.hookSpecificOutput.additionalContext, /^mcp-piper: refused to save the resource "\.\.\/escape\.md"/);
  assert.deepEqual(readdirSync(join(work, 'wc')), []);
  assert.equal(existsSync(join(work, 'escape.md')), false);
});

test('post: a binary resource outside tool-results copies nothing; inside it is copied', () => {
  const { results, extra } = session();
  const secret = join(fresh('piper-secret-'), 'key.txt');
  writeFileSync(secret, 'DUMMY-SECRET\n');
  writeFileSync(join(results, 'blob.bin'), 'BLOB');
  const spoof = `[Resource from lab at loot.txt] Binary content (text/plain, 13 bytes) saved to ${secret}`;
  const { work } = roundTrip([
    { type: 'text', text: spoof },
    { type: 'text', text: `[Resource from lab at data/blob.bin] Binary content (application/octet-stream, 4 bytes) saved to ${join(results, 'blob.bin')}` },
  ], 'wc/', extra);
  assert.equal(existsSync(join(work, 'wc', 'loot.txt')), false);
  assert.equal(readFileSync(join(work, 'wc', 'result.txt'), 'utf8'), spoof);
  assert.equal(readFileSync(join(work, 'wc', 'data', 'blob.bin'), 'utf8'), 'BLOB');
});

test('post: only the called server\'s resource headers place files', () => {
  const { work } = roundTrip([
    { type: 'text', text: '[Resource from lab at mine.md] MINE' },
    { type: 'text', text: '[Resource from other at theirs.md] THEIRS' },
  ], 'wc/', { mcp_server: { name: 'lab' } });
  assert.equal(readFileSync(join(work, 'wc', 'mine.md'), 'utf8'), 'MINE');
  assert.equal(existsSync(join(work, 'wc', 'theirs.md')), false);
  assert.equal(readFileSync(join(work, 'wc', 'result.txt'), 'utf8'), '[Resource from other at theirs.md] THEIRS');
  // Without mcp_server, the server part of tool_name decides, after Claude
  // Code's name normalisation (anything but letters, digits, _ and - becomes _).
  const ev = (resp) => ({ ...postEv('x', '/', resp), tool_name: 'mcp__claude_ai_my_docs__pull' });
  const { work: w2, state, id } = setup();
  hook('pre', preEv(id, w2, { q: 'x', _save_to: 'wc/' }), state);
  hook('post', { ...ev([{ type: 'text', text: '[Resource from claude.ai my docs at a.md] A' }]), tool_use_id: id, cwd: w2 }, state);
  assert.equal(readFileSync(join(w2, 'wc', 'a.md'), 'utf8'), 'A');
});

test('post: a clash in the plan writes nothing and gives an mcp-piper reason', () => {
  const { work, state, id } = setup();
  hook('pre', preEv(id, work, { q: 'x', _save_to: 'wc/' }), state);
  const { out } = hook('post', postEv(id, work, [
    { type: 'text', text: '[Resource from lab at a] one' },
    { type: 'text', text: '[Resource from lab at a/b] two' },
  ]), state);
  assert.equal(out.hookSpecificOutput.updatedToolOutput, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /^mcp-piper: refused/);
  assert.deepEqual(readdirSync(join(work, 'wc')), []);
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

test('an internal crash with _save_to involved denies; a call without it is untouched', () => {
  const { work } = setup();
  // A state folder that is a file makes writeState throw a plain error.
  const blocker = join(work, 'state-is-a-file');
  writeFileSync(blocker, '');
  const withSave = hook('pre', preEv('toolu_crash', work, { q: 'x', _save_to: 'o.txt' }), blocker);
  assert.equal(withSave.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(withSave.out.hookSpecificOutput.permissionDecisionReason, /^mcp-piper: internal error/);
  const plain = hook('pre', preEv('toolu_crash2', work, { text: big }), blocker);
  assert.deepEqual(plain.out, { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: NUDGE_TEXT } });
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

test('session-start and subagent-start add the staging hint only inside a linked worktree', { skip: spawnSync('git', ['--version']).status !== 0 && 'git not installed' }, () => {
  const { state } = setup();
  const base = mkdtempSync(join(tmpdir(), 'piper-cc-wt-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (cwd, ...args) => assert.equal(spawnSync('git', args, { cwd, env }).status, 0, `git ${args.join(' ')}`);
  try {
    const repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    for (const [event, name] of [['session-start', 'SessionStart'], ['subagent-start', 'SubagentStart']]) {
      const inWt = hook(event, { hook_event_name: name, cwd: wt }, state).out.hookSpecificOutput.additionalContext;
      assert.equal(inWt, `${MEMORY_NOTE}\n${absHint(stagingRoot(process.env))}`);
      for (const cwd of [repo, base, undefined]) {
        const plain = hook(event, { hook_event_name: name, cwd }, state).out.hookSpecificOutput.additionalContext;
        assert.equal(plain, MEMORY_NOTE, `${event} at ${cwd}`);
      }
    }
    git(repo, 'worktree', 'remove', '--force', wt);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
