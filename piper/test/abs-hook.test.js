import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'abs-hook.js');
const hooksFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'hooks.json');

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'piper-abs-hook-'));
  const root = join(base, 'stage');
  const work = join(base, 'work');
  mkdirSync(root, { recursive: true });
  mkdirSync(work, { recursive: true });
  return { base, root, work, done: () => rmSync(base, { recursive: true, force: true }) };
}

function run(event, input, root) {
  const res = spawnSync(process.execPath, [bin, event], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PIPER_ABS_ROOT: root },
  });
  assert.equal(res.status, 0, `abs-hook ${event} exited ${res.status}: ${res.stderr}`);
  return { out: res.stdout ? JSON.parse(res.stdout) : null, stdout: res.stdout, stderr: res.stderr };
}

test('abs-hook: a call that never names the staging root prints nothing', () => {
  const t = setup();
  try {
    const target = join(t.work, 'a.txt');
    writeFileSync(target, 'hello\n');
    for (const event of ['pre', 'post']) {
      const r = run(event, { hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: t.work, tool_input: { file_path: target } }, t.root);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    }
    assert.equal(existsSync(join(t.root, target)), false);
  } finally { t.done(); }
});

test('abs-hook: garbage, empty stdin and an unknown event all exit 0', () => {
  const t = setup();
  try {
    assert.equal(run('pre', `{not json ${t.root}`, t.root).stdout, '');
    assert.equal(run('pre', '', t.root).stdout, '');
    assert.equal(run('post-failure', 'isolated in the worktree {{{', t.root).stdout, '');
    const r = run('nope', '{}', t.root);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /unknown event/);
  } finally { t.done(); }
});

test('abs-hook: a staging Read copies the real file into staging', () => {
  const t = setup();
  try {
    const target = join(t.work, 'board', 'plan.md');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'line one\n');
    const staged = join(t.root, target);
    run('pre', { hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: t.work, tool_input: { file_path: staged } }, t.root);
    assert.equal(readFileSync(staged, 'utf8'), 'line one\n');
  } finally { t.done(); }
});

test('abs-hook: a staging Write is copied to the real path after the call', () => {
  const t = setup();
  try {
    const target = join(t.work, 'new', 'deep', 'out.md');
    const staged = join(t.root, target);
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, 'written\n');
    run('post', {
      hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: t.work,
      tool_input: { file_path: staged, content: 'written\n' }, tool_response: {},
    }, t.root);
    assert.equal(readFileSync(target, 'utf8'), 'written\n');
  } finally { t.done(); }
});

test('abs-hook post-failure: the worktree guard text gets the matching staging path', () => {
  const t = setup();
  try {
    const target = '/home/someone/repo/tmp/board.md';
    const ev = (tool_name, error) => ({
      hook_event_name: 'PostToolUseFailure', tool_name, cwd: t.work,
      tool_input: { file_path: target }, error,
    });
    const guard = '<tool_use_error>This agent is isolated in the worktree /w/agent-1. Edit the worktree copy of this file instead of the shared-checkout path.</tool_use_error>';
    const r = run('post-failure', ev('Edit', guard), t.root);
    assert.equal(r.out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
    assert.ok(r.out.hookSpecificOutput.additionalContext.includes(`${t.root}${target}`));
    assert.ok(r.out.hookSpecificOutput.additionalContext.startsWith('mcp-piper:'));

    const sib = 'This agent is isolated in the worktree /w/a, so its writes are limited to that folder. This path is in a different worktree (/w/b).';
    assert.ok(run('post-failure', ev('Write', sib), t.root).out);
    const sess = 'This session is isolated in the worktree /w/s. Edit the worktree copy of this file instead of the shared-checkout path.';
    assert.ok(run('post-failure', ev('Write', sess), t.root).out);
    // Read from tool_response as well, in case the error text lands there.
    const viaResp = { ...ev('Write', undefined), tool_response: guard };
    assert.ok(run('post-failure', viaResp, t.root).out);

    // Other failures, other tools, .git targets and staging targets get nothing.
    assert.equal(run('post-failure', ev('Edit', 'old_string not found'), t.root).stdout, '');
    assert.equal(run('post-failure', ev('Bash', guard), t.root).stdout, '');
    const gitEv = { ...ev('Write', guard), tool_input: { file_path: '/home/someone/repo/.git/info/x' } };
    assert.equal(run('post-failure', gitEv, t.root).stdout, '');
    const stagedEv = { ...ev('Write', guard), tool_input: { file_path: `${t.root}/x/y` } };
    assert.equal(run('post-failure', stagedEv, t.root).stdout, '');
  } finally { t.done(); }
});

test('hooks.json wires abs-hook on the native file tools and keeps the MCP hooks', () => {
  const h = JSON.parse(readFileSync(hooksFile, 'utf8')).hooks;
  const find = (event, matcher) => h[event].find((e) => e.matcher === matcher);
  for (const [event, matcher, arg] of [
    ['PreToolUse', 'Read|Write|Edit|Bash', 'pre'],
    ['PostToolUse', 'Read|Write|Edit|Bash', 'post'],
    ['PostToolUseFailure', 'Write|Edit', 'post-failure'],
  ]) {
    const e = find(event, matcher);
    assert.ok(e, `${event} ${matcher}`);
    assert.equal(e.hooks[0].command, `node "\${CLAUDE_PLUGIN_ROOT}/piper/bin/abs-hook.js" ${arg}`);
    assert.ok(find(event, 'mcp__.*'), `${event} mcp__.* still there`);
  }
});
