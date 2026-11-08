#!/usr/bin/env node
// SessionStart and SubagentStart hook: tell the agent that nested agent
// context (AGENTS.md, CLAUDE.md, CLAUDE.local.md in folders below its working
// directory) exists, using `peek.sh --nested`. The harness only preloads the
// working directory's own files, so a nested index is otherwise invisible.
//
// peek.sh never reads stdin (ssh mode depends on that), so this wrapper reads
// the hook's JSON, runs the script and writes the hook's JSON answer. Any
// failure prints nothing and exits 0: a nudge must never break a session.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENTS = new Set(['SessionStart', 'SubagentStart']);

function main() {
  let ev = {};
  try { ev = JSON.parse(readFileSync(0, 'utf8') || '{}') || {}; } catch { ev = {}; }
  const event = EVENTS.has(ev.hook_event_name) ? ev.hook_event_name
    : (EVENTS.has(process.argv[2]) ? process.argv[2] : 'SessionStart');
  const cwd = (typeof ev.cwd === 'string' && ev.cwd)
    || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lib', 'peek.sh');
  const res = spawnSync('bash', [script, '--nested', cwd], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 5000,
  });
  if (res.error || res.status !== 0) return;
  const text = (res.stdout || '').trim();
  if (!text) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  }));
}

try { main(); } catch { /* never fail the session */ }
process.exit(0);
