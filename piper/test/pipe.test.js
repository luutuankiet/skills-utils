import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pre, post } from '../lib/claude.js';
import { splitWords, findSnippet, parsePipe } from '../lib/pipe.js';

const fresh = (p = 'piper-pipe-') => mkdtempSync(join(tmpdir(), p));
let seq = 0;
function setup() {
  process.env.MCP_PIPER_STATE_DIR = join(fresh('piper-state-'), 'state');
  return { work: fresh(), id: `toolu_pipe_${++seq}` };
}
const preEv = (id, cwd, tool_input) => ({ hook_event_name: 'PreToolUse', tool_name: 'mcp__lab__echo', tool_use_id: id, cwd, tool_input });
const postEv = (id, cwd, tool_response) => ({ hook_event_name: 'PostToolUse', tool_name: 'mcp__lab__echo', tool_use_id: id, cwd, tool_response });

function snippet(dir, name, body) {
  const folder = join(dir, '.mcp-piper', 'pipes');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

test('splitWords honours quotes', () => {
  assert.deepEqual(splitWords(`gh-doc o/r#1 "a b" 'c d'`), ['gh-doc', 'o/r#1', 'a b', 'c d']);
});

test('findSnippet finds a name with or without its extension, nearest folder first', () => {
  const { work } = setup();
  const deep = join(work, 'a', 'b');
  mkdirSync(deep, { recursive: true });
  const outer = snippet(work, 'tool.sh', 'true');
  assert.equal(findSnippet('tool', deep), outer);
  const inner = snippet(join(work, 'a'), 'tool', 'true');
  assert.equal(findSnippet('tool', deep), inner);
  assert.throws(() => findSnippet('../x', work), /may hold only/);
  assert.throws(() => findSnippet('nope-zz', work), /no _pipe snippet named "nope-zz"/);
});

test('parsePipe rejects bad shapes', () => {
  assert.throws(() => parsePipe('', '/'), /empty/);
  assert.throws(() => parsePipe({ sh: 'x' }, '/'), /only "pre" and "post"/);
  assert.throws(() => parsePipe({ pre: '' }, '/'), /non-empty/);
  assert.throws(() => parsePipe(3, '/'), /must be/);
});

test('inline pre merges printed JSON into the arguments and strips _pipe', () => {
  const { work, id } = setup();
  writeFileSync(join(work, 'note.txt'), 'from a file');
  const code = `read -r j; printf '{"text":"@file:%s/note.txt","tool":"%s"}' "$PWD" "$PIPER_TOOL"`;
  const out = pre(preEv(id, work, { title: 'x', _pipe: { pre: code } }));
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { title: 'x', text: 'from a file', tool: 'mcp__lab__echo' });
  assert.equal(post(postEv(id, work, [{ type: 'text', text: 'r' }])), null, 'no post step, no state');
});

test('pre sees the input on stdin; printing nothing still strips _pipe', () => {
  const { work, id } = setup();
  const out = pre(preEv(id, work, { a: 1, _pipe: { pre: `cat > "${work}/seen.json"` } }));
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { a: 1 });
  assert.deepEqual(JSON.parse(readFileSync(join(work, 'seen.json'), 'utf8')), { tool: 'mcp__lab__echo', input: { a: 1 } });
});

test('a failing or non-JSON pre step denies the call with its message', () => {
  const { work, id } = setup();
  const failed = pre(preEv(id, work, { _pipe: { pre: 'echo "GitHub body changed since the fork" >&2; exit 3' } }));
  assert.equal(failed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(failed.hookSpecificOutput.permissionDecisionReason, /exit 3[\s\S]*body changed since the fork/);
  const junk = pre(preEv(id, work, { _pipe: { pre: 'echo not json' } }));
  assert.match(junk.hookSpecificOutput.permissionDecisionReason, /must print a JSON object/);
});

test('post replaces the result with what it prints, and sees input and result', () => {
  const { work, id } = setup();
  const code = `cat > "${work}/post.json"; echo "posted https://example/1"`;
  pre(preEv(id, work, { a: 1, _pipe: { post: code } }));
  const out = post(postEv(id, work, [{ type: 'text', text: 'the result' }]));
  assert.deepEqual(out.hookSpecificOutput.updatedToolOutput, [{ type: 'text', text: 'posted https://example/1' }]);
  const seen = JSON.parse(readFileSync(join(work, 'post.json'), 'utf8'));
  assert.deepEqual(seen.input, { a: 1 });
  assert.deepEqual(seen.result, [{ type: 'text', text: 'the result' }]);
  assert.equal(seen.saved, null);
});

test('a snippet runs both stages; pre can ask for _save_to and post gets the saved paths', () => {
  const { work, id } = setup();
  const dest = join(work, 'wc') + '/';
  snippet(work, 'demo', [
    'payload=$(cat)',
    `if [ "$PIPER_STAGE" = pre ]; then echo '{"_save_to":"${dest}"}'; exit 0; fi`,
    'echo "args=$1 saved=$(printf %s "$payload" | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).saved.length))\')"',
  ].join('\n'));
  const p = pre(preEv(id, work, { doc: 'd', _pipe: 'demo hello' }));
  assert.deepEqual(p.hookSpecificOutput.updatedInput, { doc: 'd' });
  const out = post(postEv(id, work, [{ type: 'text', text: 'body' }]));
  assert.equal(out.hookSpecificOutput.updatedToolOutput[0].text, 'args=hello saved=1');
  assert.ok(existsSync(join(work, 'wc', 'result.txt')));
});

test('a failing post step keeps the result and says why', () => {
  const { work, id } = setup();
  pre(preEv(id, work, { _pipe: { post: 'echo boom >&2; exit 1' } }));
  const out = post(postEv(id, work, [{ type: 'text', text: 'r' }]));
  assert.equal(out.hookSpecificOutput.updatedToolOutput, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /post step failed \(exit 1\):\nboom/);
});
