import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, realpathSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  AbsError, stagingRoot, rootMarkers, toTarget, toStaging, checkEdit, rewriteCommand,
  absHint, ABS_HINT, handlePre, handlePost,
} from '../lib/abs.js';

const ROOT = '/home/u/.piper/abs';
const HOME = '/home/u';

/** A temp staging root and a temp target folder, both outside the real ~/.piper. */
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'piper-abs-')));
  const root = join(base, 'stage');
  const work = join(base, 'work');
  mkdirSync(work, { recursive: true });
  const env = { PIPER_ABS_ROOT: root };
  const stage = (p) => root + p;
  return { root, work, env, stage };
}

const ev = (tool, tool_input, event = 'PreToolUse') => ({ hook_event_name: event, tool_name: tool, tool_input, cwd: '/' });
const mtime = (p) => statSync(p).mtimeMs;
/** Push a file's mtime into the past so a later write is visible. */
const age = (p) => { const t = new Date(Date.now() - 60_000); utimesSync(p, t, t); return mtime(p); };

/** Simulate Claude Code applying the Edit to the staging file. */
function ccEdit(staging, input) {
  const text = readFileSync(staging, 'utf8');
  writeFileSync(staging, input.replace_all ? text.split(input.old_string).join(input.new_string) : text.replace(input.old_string, () => input.new_string));
}

// ------------------------------------------------------------------ mapping ---

test('stagingRoot: default under home, override resolved, empty ignored', () => {
  assert.equal(stagingRoot({}), join(homedir(), '.piper', 'abs'));
  assert.equal(stagingRoot({ PIPER_ABS_ROOT: '' }), join(homedir(), '.piper', 'abs'));
  assert.equal(stagingRoot({ PIPER_ABS_ROOT: '/tmp/x/' }), '/tmp/x');
  assert.equal(stagingRoot({ PIPER_ABS_ROOT: 'rel/dir' }), join(process.cwd(), 'rel', 'dir'));
});

test('rootMarkers: home forms only when the root is under home', () => {
  assert.deepEqual(rootMarkers(ROOT, HOME), [ROOT, '~/.piper/abs', '$HOME/.piper/abs', '${HOME}/.piper/abs']);
  assert.deepEqual(rootMarkers('/srv/stage', HOME), ['/srv/stage']);
});

test('toTarget / toStaging map both ways and normalise', () => {
  assert.equal(toTarget(`${ROOT}/home/u/repo/a.md`, ROOT), '/home/u/repo/a.md');
  assert.equal(toTarget(`${ROOT}//tmp/./x//y/`, ROOT), '/tmp/x/y');
  assert.equal(toTarget('/home/u/repo/a.md', ROOT), null);
  assert.equal(toTarget(`${ROOT}-old/tmp/a`, ROOT), null);
  assert.equal(toTarget(undefined, ROOT), null);
  assert.equal(toStaging('/home/u/repo/a.md', ROOT), `${ROOT}/home/u/repo/a.md`);
  assert.equal(toStaging('/tmp//x/', ROOT), `${ROOT}/tmp/x`);
  assert.throws(() => toStaging('rel/x', ROOT), AbsError);
  const t = '/home/u/repo/tmp/board.md';
  assert.equal(toTarget(toStaging(t, ROOT), ROOT), t);
});

test('toTarget refuses .git segments, .. segments and the root itself', () => {
  for (const p of [
    `${ROOT}/x/.git/config`, `${ROOT}/x/.git`, `${ROOT}/x/.GIT/HEAD`,
    `${ROOT}/x/../etc/passwd`, `${ROOT}/..`, `${ROOT}/../../etc/passwd`,
    ROOT, `${ROOT}/`, `${ROOT}/.`, `${ROOT}//`,
  ]) {
    assert.throws(() => toTarget(p, ROOT), (e) => e instanceof AbsError && e.message.startsWith('mcp-piper:'), p);
  }
  // A name merely containing .git is fine.
  assert.equal(toTarget(`${ROOT}/x/.gitignore`, ROOT), '/x/.gitignore');
  assert.equal(toTarget(`${ROOT}/x/a..b`, ROOT), '/x/a..b');
});

// ---------------------------------------------------------------- checkEdit ---

const where = { target: '/t/f.md', staging: `${ROOT}/t/f.md` };

test('checkEdit: unique match replaced once, $ patterns taken literally', () => {
  assert.equal(checkEdit('a\nb\nc\n', { old_string: 'b', new_string: 'B$&$1' }, where), 'a\nB$&$1\nc\n');
});

test('checkEdit: missing old_string names the target and the staging path', () => {
  assert.throws(() => checkEdit('abc', { old_string: 'zz', new_string: 'y' }, where), (e) =>
    e instanceof AbsError
    && e.message === `mcp-piper: edit not applied. old_string is not in the current file /t/f.md, so it changed after your last Read. Read ${ROOT}/t/f.md again to see the current text, then retry the Edit using that text.`);
});

test('checkEdit: not unique without replace_all', () => {
  assert.throws(() => checkEdit('x x x', { old_string: 'x', new_string: 'y' }, where), (e) =>
    e instanceof AbsError && /matches 3 places in the current file \/t\/f\.md/.test(e.message)
    && e.message.includes(`Read ${ROOT}/t/f.md again`) && e.message.includes('replace_all'));
});

test('checkEdit: replace_all replaces every occurrence', () => {
  assert.equal(checkEdit('x.x.x', { old_string: 'x', new_string: 'yy', replace_all: true }, where), 'yy.yy.yy');
});

test('checkEdit: empty or missing old_string refused', () => {
  assert.throws(() => checkEdit('abc', { old_string: '', new_string: 'y' }, where), AbsError);
  assert.throws(() => checkEdit('abc', { new_string: 'y' }, where), AbsError);
});

test('checkEdit: a CRLF file matches LF old_string and keeps CRLF', () => {
  assert.equal(checkEdit('a\r\nb\r\nc\r\n', { old_string: 'a\nb', new_string: 'A\nB' }, where), 'A\r\nB\r\nc\r\n');
});

// ----------------------------------------------------------- rewriteCommand ---

test('rewriteCommand: absolute, ~ and $HOME forms; null when unchanged', () => {
  assert.equal(rewriteCommand(`cat ${ROOT}/home/u/x`, ROOT, HOME), 'cat /home/u/x');
  assert.equal(rewriteCommand('cat ~/.piper/abs/home/u/x > ~/.piper/abs/tmp/y', ROOT, HOME), 'cat /home/u/x > /tmp/y');
  assert.equal(rewriteCommand('echo hi >> "$HOME/.piper/abs/tmp/a"', ROOT, HOME), 'echo hi >> "/tmp/a"');
  assert.equal(rewriteCommand('ls ${HOME}/.piper/abs/tmp', ROOT, HOME), 'ls /tmp');
  assert.equal(rewriteCommand('ls ~/.piper/abs-old/tmp', ROOT, HOME), null);
  assert.equal(rewriteCommand('ls /tmp', ROOT, HOME), null);
  assert.equal(rewriteCommand(42, ROOT, HOME), null);
});

// -------------------------------------------------------------------- hints ---

test('hint: default shows ~/.piper/abs, an override shows its root', () => {
  assert.match(ABS_HINT, /~\/\.piper\/abs\/<absolute path>/);
  assert.equal(ABS_HINT.split('\n').length, 2);
  const h = absHint('/srv/stage');
  assert.match(h, /\/srv\/stage\/<absolute path>/);
  assert.match(h, /Edit or Write that same \/srv\/stage path/);
  assert.doesNotMatch(h, /~\/\.piper/);
});

// ----------------------------------------------------------------- handlers ---

test('handlers: non-staging calls return null', () => {
  const { env, work } = setup();
  for (const tool of ['Read', 'Write', 'Edit']) {
    assert.equal(handlePre(ev(tool, { file_path: join(work, 'a') }), env), null);
    assert.equal(handlePost(ev(tool, { file_path: join(work, 'a') }, 'PostToolUse'), env), null);
  }
  assert.equal(handlePre(ev('Bash', { command: 'ls /tmp' }), env), null);
  assert.equal(handlePre(ev('NotebookEdit', { notebook_path: env.PIPER_ABS_ROOT + '/x.ipynb' }), env), null);
  assert.equal(handlePre(ev('mcp__x__y', { file_path: env.PIPER_ABS_ROOT + '/x' }), env), null);
  assert.equal(handlePre(null, env), null);
  assert.equal(handlePre({ tool_name: 'Read' }, env), null);
  assert.equal(handlePre(ev('Read', 'not an object'), env), null);
});

test('handlePre: refused staging path is a mcp-piper deny', () => {
  const { env, stage, work } = setup();
  const out = handlePre(ev('Write', { file_path: stage(`${work}/.git/config`), content: 'x' }), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^mcp-piper: refused .*\.git/);
  assert.equal(existsSync(`${work}/.git`), false);
});

test('Read: copies the target fresh into staging, no output', () => {
  const { env, stage, work } = setup();
  const t = join(work, 'sub', 'a.md');
  mkdirSync(dirname(t), { recursive: true });
  writeFileSync(t, 'one\n');
  assert.equal(handlePre(ev('Read', { file_path: stage(t) }), env), null);
  assert.equal(readFileSync(stage(t), 'utf8'), 'one\n');
  writeFileSync(t, 'two\n');
  handlePre(ev('Read', { file_path: stage(t) }), env);
  assert.equal(readFileSync(stage(t), 'utf8'), 'two\n');
});

test('Read: a missing target removes a stale staging file', () => {
  const { env, stage, work } = setup();
  const t = join(work, 'gone.md');
  mkdirSync(dirname(stage(t)), { recursive: true });
  writeFileSync(stage(t), 'stale');
  assert.equal(handlePre(ev('Read', { file_path: stage(t) }), env), null);
  assert.equal(existsSync(stage(t)), false);
});

test('Write: Pre allows silently, Post creates the parent folder and copies out', () => {
  const { env, stage, work } = setup();
  const t = join(work, 'new', 'deep', 'w.md');
  assert.equal(handlePre(ev('Write', { file_path: stage(t), content: 'hi' }), env), null);
  mkdirSync(dirname(stage(t)), { recursive: true });
  writeFileSync(stage(t), 'hi');
  assert.equal(handlePost(ev('Write', { file_path: stage(t), content: 'hi' }, 'PostToolUse'), env), null);
  assert.equal(readFileSync(t, 'utf8'), 'hi');
});

function editSetup(text = 'l1\nl2\nl3\n') {
  const s = setup();
  const t = join(s.work, 'e.md');
  writeFileSync(t, text);
  handlePre(ev('Read', { file_path: s.stage(t) }), s.env);
  return { ...s, t, st: s.stage(t) };
}

test('Edit Pre: success leaves target and staging untouched, mtime included', () => {
  const { env, t, st } = editSetup();
  const mt = age(t);
  const ms = age(st);
  assert.equal(handlePre(ev('Edit', { file_path: st, old_string: 'l2', new_string: 'L2' }), env), null);
  assert.equal(readFileSync(t, 'utf8'), 'l1\nl2\nl3\n');
  assert.equal(readFileSync(st, 'utf8'), 'l1\nl2\nl3\n');
  assert.equal(mtime(t), mt);
  assert.equal(mtime(st), ms);
});

test('Edit Pre: a conflict denies and leaves both files untouched', () => {
  const { env, t, st } = editSetup();
  writeFileSync(t, 'l1\nchanged\nl3\n');
  const ms = age(st);
  const out = handlePre(ev('Edit', { file_path: st, old_string: 'l2', new_string: 'L2' }), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^mcp-piper: edit not applied\. old_string is not in the current file/);
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(`Read ${st} again`));
  assert.equal(readFileSync(t, 'utf8'), 'l1\nchanged\nl3\n');
  assert.equal(readFileSync(st, 'utf8'), 'l1\nl2\nl3\n');
  assert.equal(mtime(st), ms);
});

test('Edit Pre: a missing target denies and suggests Write', () => {
  const { env, stage, work } = setup();
  const t = join(work, 'nope.md');
  const out = handlePre(ev('Edit', { file_path: stage(t), old_string: 'a', new_string: 'b' }), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /does not exist.*Write/);
});

test('Edit: success never sends permissionDecision allow', () => {
  const { env, st } = editSetup();
  const out = handlePre(ev('Edit', { file_path: st, old_string: 'l2', new_string: 'L2' }), env);
  assert.equal(out, null);
});

test('Edit Post: applies once and keeps the staging mtime when contents match', () => {
  const { env, t, st } = editSetup();
  const input = { file_path: st, old_string: 'l2', new_string: 'L2' };
  assert.equal(handlePre(ev('Edit', input), env), null);
  ccEdit(st, input);
  const ms = age(st);
  assert.equal(handlePost(ev('Edit', input, 'PostToolUse'), env), null);
  assert.equal(readFileSync(t, 'utf8'), 'l1\nL2\nl3\n');
  assert.equal(readFileSync(st, 'utf8'), 'l1\nL2\nl3\n');
  assert.equal(mtime(st), ms, 'staging not rewritten');
});

test('Edit: a race on another line keeps both edits', () => {
  const { env, t, st } = editSetup();
  writeFileSync(t, 'OTHER\nl2\nl3\n');
  const input = { file_path: st, old_string: 'l3', new_string: 'L3' };
  assert.equal(handlePre(ev('Edit', input), env), null);
  ccEdit(st, input);
  assert.equal(handlePost(ev('Edit', input, 'PostToolUse'), env), null);
  assert.equal(readFileSync(t, 'utf8'), 'OTHER\nl2\nL3\n');
  assert.equal(readFileSync(st, 'utf8'), 'OTHER\nl2\nL3\n', 'staging caught up with the target');
});

test('Edit Post: a conflict after Pre does not write the target and says so', () => {
  const { env, t, st } = editSetup();
  const input = { file_path: st, old_string: 'l2', new_string: 'L2' };
  assert.equal(handlePre(ev('Edit', input), env), null);
  ccEdit(st, input);
  writeFileSync(t, 'l1\nraced\nl3\n');
  const out = handlePost(ev('Edit', input, 'PostToolUse'), env);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /NOT applied to .*e\.md/);
  assert.ok(out.hookSpecificOutput.additionalContext.includes(`Read ${st} again`));
  assert.equal(readFileSync(t, 'utf8'), 'l1\nraced\nl3\n');
  assert.equal(readFileSync(st, 'utf8'), 'l1\nraced\nl3\n', 'staging reset to the target');
});

test('Edit: replace_all through Pre and Post', () => {
  const { env, t, st } = editSetup('x\nx\ny\n');
  const input = { file_path: st, old_string: 'x', new_string: 'z', replace_all: true };
  assert.equal(handlePre(ev('Edit', input), env), null);
  ccEdit(st, input);
  assert.equal(handlePost(ev('Edit', input, 'PostToolUse'), env), null);
  assert.equal(readFileSync(t, 'utf8'), 'z\nz\ny\n');
});

test('Bash: staging paths rewritten via updatedInput, every field kept, no decision', () => {
  const { env, root } = setup();
  const input = { command: `cat ${root}/tmp/a > ${root}/tmp/b`, description: 'copy', timeout: 5 };
  const out = handlePre(ev('Bash', input), env);
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'cat /tmp/a > /tmp/b', description: 'copy', timeout: 5 } },
  });
  assert.equal(handlePre(ev('Bash', { command: `ls ${root}` }), env), null);
});

test('handlers: an unexpected error on a staging call denies with a reason', () => {
  const { env, stage, work } = setup();
  // The target is a folder, so Edit cannot read it as a file.
  const t = join(work, 'adir');
  mkdirSync(t);
  const out = handlePre(ev('Edit', { file_path: stage(t), old_string: 'a', new_string: 'b' }), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  // Write Post with no staging file reports the target may not be updated.
  const p = handlePost(ev('Write', { file_path: stage(join(work, 'w.md')), content: '' }, 'PostToolUse'), env);
  assert.match(p.hookSpecificOutput.additionalContext, /^mcp-piper: .*may not be updated/);
});
