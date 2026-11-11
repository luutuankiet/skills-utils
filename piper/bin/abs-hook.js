#!/usr/bin/env node
// Hook entry for staging paths on Claude Code's own file tools.
//
//   abs-hook.js pre|post|post-failure   (stdin: hook JSON)
//
// pre and post run on every Read, Write, Edit and Bash call, so this file
// stays small: it reads stdin as text and exits with no output unless the
// text names the staging root, before parsing any JSON. Only ../lib/abs.js is
// loaded, and only once stdin is known to be worth a look.
//
// A hook must never break the call it watches. It always exits 0. Bad JSON,
// or a call that does not concern staging, prints nothing. An unexpected error
// on a staging call is a deny in pre (so the call cannot touch the staging
// path while the real file is left behind) and a note on stderr in post.
//
// post-failure: when Claude Code's worktree isolation refuses a Write or Edit,
// add one line naming the staging path that reaches the same file.

import { readFileSync } from 'node:fs';

const GUARD_TEXT = 'isolated in the worktree';
const EVENTS = new Set(['pre', 'post', 'post-failure']);

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

/**
 * A string every spelling of the staging root contains, found without loading
 * abs.js: ".piper/abs" for the default root, else the last folder name of
 * PIPER_ABS_ROOT. null when there is no safe choice; then abs.js decides.
 */
function cheapMarker(env) {
  const raw = typeof env.PIPER_ABS_ROOT === 'string' ? env.PIPER_ABS_ROOT.trim() : '';
  if (!raw) return '.piper/abs';
  const last = raw.replace(/\/+$/, '').split('/').pop();
  return last && last !== '.' && last !== '..' ? last : null;
}

function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason.startsWith('mcp-piper:') ? reason : `mcp-piper: ${reason}`,
    },
  };
}

/** The failure's text: `error` is the documented field; tool_response is read too, in case. */
function failureText(ev) {
  const parts = [];
  for (const v of [ev.error, ev.tool_response]) {
    if (typeof v === 'string') parts.push(v);
    else if (v && typeof v === 'object') {
      try { parts.push(JSON.stringify(v)); } catch { /* ignore */ }
    }
  }
  return parts.join('\n');
}

/** The staging path for an absolute target, or null when there is none to offer. */
function stagingFor(abs, root, target) {
  if (typeof target !== 'string' || !target.startsWith('/')) return null;
  const staged = abs.toStaging(target, root);
  const t = staged.slice(root.length);
  if (!t || t.split('/').includes('.git') || t === root || t.startsWith(`${root}/`)) return null;
  return staged;
}

async function postFailure(ev, abs) {
  if (!ev || (ev.tool_name !== 'Write' && ev.tool_name !== 'Edit')) return null;
  if (!failureText(ev).includes(GUARD_TEXT)) return null;
  const root = abs.stagingRoot(process.env);
  const target = ev.tool_input && ev.tool_input.file_path;
  const staged = stagingFor(abs, root, target);
  if (!staged) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: `mcp-piper: this path is outside your worktree. Use ${staged} instead: Read it there first, then ${ev.tool_name} it.`,
    },
  };
}

async function run(event) {
  if (!EVENTS.has(event)) {
    process.stderr.write(`mcp-piper: abs-hook: unknown event "${event}"; expected pre, post or post-failure\n`);
    return;
  }
  const raw = readStdin();
  if (!raw) return;
  if (event === 'post-failure') {
    if (!raw.includes(GUARD_TEXT)) return;
  } else {
    const quick = cheapMarker(process.env);
    if (quick && !raw.includes(quick)) return;
  }

  const abs = await import('../lib/abs.js');
  if (event !== 'post-failure') {
    const markers = abs.rootMarkers(abs.stagingRoot(process.env));
    if (!markers.some((m) => raw.includes(m))) return;
  }

  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return; // not our payload to judge; leave the call alone
  }
  if (!ev || typeof ev !== 'object') return;

  let out = null;
  try {
    if (event === 'pre') out = await abs.handlePre(ev, process.env);
    else if (event === 'post') out = await abs.handlePost(ev, process.env);
    else out = await postFailure(ev, abs);
  } catch (err) {
    process.stderr.write(`mcp-piper: abs-hook ${event}: ${err && err.stack ? err.stack : err}\n`);
    if (event === 'pre') {
      out = abs.AbsError && err instanceof abs.AbsError
        ? denyOutput(err.message)
        : denyOutput(`mcp-piper: internal error on a staging path (${err && err.message}). The call was stopped so the staging copy and the real file stay in step. Retry once; if it fails again, use the real path where your tools allow it.`);
    } else {
      out = null;
    }
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

try {
  await run(process.argv[2]);
} catch (err) {
  // Loading abs.js or reading the root failed: never break the call.
  process.stderr.write(`mcp-piper: abs-hook: ${err && err.stack ? err.stack : err}\n`);
}
process.exitCode = 0;
