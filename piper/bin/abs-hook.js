#!/usr/bin/env node
// Hook entry for staging paths on Claude Code's own file tools.
//
//   abs-hook.js pre|post   (stdin: hook JSON)
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
// There is no failure hook: Claude Code's worktree isolation refuses a Write or
// Edit before any hook runs and raises no failure event, so the only guidance
// an agent gets is the session-start hint and the deny reasons from abs.js.

import { readFileSync } from 'node:fs';

const EVENTS = new Set(['pre', 'post']);

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

async function run(event) {
  if (!EVENTS.has(event)) {
    process.stderr.write(`mcp-piper: abs-hook: unknown event "${event}"; expected pre or post\n`);
    return;
  }
  const raw = readStdin();
  if (!raw) return;
  const quick = cheapMarker(process.env);
  if (quick && !raw.includes(quick)) return;

  const abs = await import('../lib/abs.js');
  const markers = abs.rootMarkers(abs.stagingRoot(process.env));
  if (!markers.some((m) => raw.includes(m))) return;

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
    else out = await abs.handlePost(ev, process.env);
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
