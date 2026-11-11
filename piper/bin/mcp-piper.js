#!/usr/bin/env node
// Entry point for the mcp-piper hooks and the `doctor` check.
//
//   mcp-piper hook pre|post|post-failure|session-start|subagent-start|messagedisplay   (stdin: hook JSON)
//   mcp-piper doctor
//   mcp-piper --version
//
// A hook must never break the tool call it watches. Any unexpected error lets
// the call through untouched, except when the call carries a pointer or
// `_save_to`: then it is denied, so a literal "@file:" never reaches a server.
// messagedisplay only changes what is shown on screen; on any error it prints
// nothing and the original text is shown.

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDLERS, deny, involvesPiper, pre } from '../lib/claude.js';
import { stateDir } from '../lib/core.js';
import { decodeMermaidUrl, mermaidEnabled, scanDelta, newState } from '../lib/mermaid.js';
import { handlePre, stagingRoot } from '../lib/abs.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const USAGE = `usage: mcp-piper hook <event>     run a Claude Code hook, payload on stdin
       mcp-piper doctor           check this install
       mcp-piper --version

  <event> is one of: ${Object.keys(HANDLERS).join(', ')}`;

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function runHook(event) {
  const handler = HANDLERS[event];
  if (!handler) {
    process.stderr.write(`mcp-piper: unknown hook event "${event}"\n${USAGE}\n`);
    return 2;
  }
  let ev = null;
  try {
    const raw = readStdin();
    ev = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return 0; // not our payload to judge; leave the call alone
  }
  let out = null;
  try {
    out = handler(ev);
  } catch (err) {
    process.stderr.write(`mcp-piper: internal error in hook ${event}: ${err && err.stack ? err.stack : err}\n`);
    if (event === 'pre' && involvesPiper(ev)) {
      out = deny(`mcp-piper: internal error while preparing this call (${err && err.message}). The call was stopped so no unexpanded pointer reaches the server. Retry, or pass the value inline without "@file:" and without _save_to.`);
    } else {
      out = null;
    }
  }
  if (out) process.stdout.write(JSON.stringify(out));
  return 0;
}

function pluginHookFile() {
  const roots = [];
  if (process.env.CLAUDE_PLUGIN_ROOT) roots.push(process.env.CLAUDE_PLUGIN_ROOT);
  roots.push(join(here, '..', '..'));
  for (const r of roots) {
    const p = join(r, 'hooks', 'hooks.json');
    if (existsSync(p)) return p;
  }
  return null;
}

function doctor() {
  const rows = [];
  const check = (name, fn) => {
    try {
      const r = fn();
      rows.push({ name, ...r });
    } catch (err) {
      rows.push({ name, status: 'fail', detail: err.message });
    }
  };

  check('node version', () => {
    const major = Number(process.versions.node.split('.')[0]);
    return major >= 18
      ? { status: 'ok', detail: process.version }
      : { status: 'fail', detail: `${process.version}; mcp-piper needs Node 18 or newer` };
  });

  check('plugin hook file', () => {
    const p = pluginHookFile();
    return p
      ? { status: 'ok', detail: p }
      : { status: 'warn', detail: 'hooks/hooks.json not found next to this package; hooks run only when installed through the skills-utils plugin' };
  });

  check('pointer dry run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-piper-doctor-'));
    try {
      const text = `doctor sample ${Date.now()}`;
      writeFileSync(join(dir, 'sample.txt'), text);
      const out = pre({
        tool_name: 'mcp__doctor__echo',
        tool_use_id: 'doctor',
        cwd: dir,
        tool_input: { text: '@file:sample.txt', nested: ['@file64:sample.txt'], keep: '@@file:literal' },
      }, { nudgeRoute: 'pre' });
      const got = out && out.hookSpecificOutput && out.hookSpecificOutput.updatedInput;
      const ok = got && got.text === text
        && got.nested[0] === Buffer.from(text).toString('base64')
        && got.keep === '@file:literal';
      return ok
        ? { status: 'ok', detail: 'text, base64 and escape all expanded as expected' }
        : { status: 'fail', detail: `unexpected hook output: ${JSON.stringify(out)}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check('staging paths', () => {
    const p = pluginHookFile();
    const wired = p && readFileSync(p, 'utf8').includes('piper/bin/abs-hook.js');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-piper-doctor-abs-'));
    try {
      const root = join(dir, 'stage');
      const target = join(dir, 'real', 'sample.txt');
      mkdirSync(dirname(target), { recursive: true });
      const text = `doctor staging ${Date.now()}`;
      writeFileSync(target, text);
      const staged = `${root}${target}`;
      handlePre({ tool_name: 'Read', cwd: dir, tool_input: { file_path: staged } }, { PIPER_ABS_ROOT: root });
      const copied = existsSync(staged) && readFileSync(staged, 'utf8') === text;
      if (!copied) return { status: 'fail', detail: 'a Read of a staging path did not copy the real file into staging' };
      return wired
        ? { status: 'ok', detail: `hook wired; staging root ${stagingRoot()}` }
        : { status: 'warn', detail: 'a staging Read works, but no abs-hook.js entry was found in hooks/hooks.json' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check('mermaid links', () => {
    if (!mermaidEnabled()) return { status: 'ok', detail: 'off (MCP_PIPER_MERMAID is set to turn it off)' };
    const code = 'flowchart LR\n  A --> B';
    const r = scanDelta(newState(), `\`\`\`mermaid\n${code}\n\`\`\`\n`, true);
    const m = /\]\((https:\/\/mermaid\.live\/edit#pako:[^)]+)\)/.exec(r.text);
    const ok = r.changed && m && decodeMermaidUrl(m[1]).code === code;
    return ok
      ? { status: 'ok', detail: 'a sample block got a mermaid.live link that decodes back to its text' }
      : { status: 'fail', detail: `unexpected output: ${JSON.stringify(r.text)}` };
  });

  check('state folder writable', () => {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return { status: 'ok', detail: dir };
  });

  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  console.log(`mcp-piper ${pkg.version} doctor`);
  for (const r of rows) console.log(`  ${mark[r.status]}  ${r.name}: ${r.detail}`);
  return rows.some((r) => r.status === 'fail') ? 1 : 0;
}

function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === '--version' || cmd === '-v') { console.log(`mcp-piper ${pkg.version}`); return 0; }
  if (cmd === 'hook') return runHook(arg);
  if (cmd === 'doctor') return doctor();
  if (cmd === '-h' || cmd === '--help') { console.log(USAGE); return 0; }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
