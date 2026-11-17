// `_pipe`: run a snippet, or inline bash, around one MCP tool call.
//
// "_pipe": "<snippet> <args>"          a script found by name, run before and after
// "_pipe": {"pre": "<bash>", "post": "<bash>"}   inline bash, either key optional
//
// Before the call the code reads {tool, input} on stdin and may print a JSON
// object, which is merged into the call's arguments (pointers such as
// "@file:" in it are then expanded as usual). After the call it reads
// {tool, input, result, saved} and may print text, which replaces the result
// the agent sees. PIPER_STAGE is "pre" or "post", PIPER_TOOL the tool name.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiperError } from './core.js';

export const PIPE_KEY = '_pipe';
export const PIPE_TIMEOUT_MS = 110_000; // the hook itself gets 120 s

const SHIPPED = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'mcp-piper', 'pipes');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Split "name a 'b c'" into words, honouring single and double quotes. */
export function splitWords(s) {
  const out = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Folders searched for a snippet name, nearest first. */
export function snippetFolders(cwd, env = process.env) {
  const dirs = [];
  for (let d = resolve(cwd || process.cwd()); ; d = dirname(d)) {
    dirs.push(join(d, '.mcp-piper', 'pipes'));
    if (dirname(d) === d) break;
  }
  dirs.push(join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mcp-piper', 'pipes'));
  dirs.push(SHIPPED);
  return dirs;
}

/** The snippet's file: an absolute path, or `name` / `name.<ext>` in a snippet folder. */
export function findSnippet(name, cwd, env = process.env) {
  if (isAbsolute(name)) {
    if (existsSync(name)) return name;
    throw new PiperError(`mcp-piper: _pipe snippet ${name} does not exist.`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) {
    throw new PiperError(`mcp-piper: _pipe snippet name "${name}" may hold only letters, digits, ".", "_" and "-", or be an absolute path.`);
  }
  const folders = snippetFolders(cwd, env);
  for (const dir of folders) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    const hit = names.find((n) => n === name) || names.find((n) => n.startsWith(`${name}.`));
    if (hit && statSync(join(dir, hit)).isFile()) return join(dir, hit);
  }
  throw new PiperError(`mcp-piper: no _pipe snippet named "${name}" in ${folders.join(', ')}. Use inline code instead: "_pipe": {"pre": "<bash>", "post": "<bash>"}.`);
}

/**
 * Check a `_pipe` value and turn it into a plan. Throws PiperError.
 * @returns {{ label: string, pre: string[]|null, post: string[]|null }} argv per stage
 */
export function parsePipe(value, cwd, env = process.env) {
  if (typeof value === 'string') {
    const [name, ...args] = splitWords(value.trim());
    if (!name) throw new PiperError('mcp-piper: _pipe is empty. Write "_pipe": "<snippet> <args>" or {"pre": "<bash>", "post": "<bash>"}.');
    const file = findSnippet(name, cwd, env);
    return { label: name, pre: [file, ...args], post: [file, ...args] };
  }
  if (isPlainObject(value)) {
    const extra = Object.keys(value).filter((k) => k !== 'pre' && k !== 'post');
    if (extra.length || !Object.keys(value).length) {
      throw new PiperError(`mcp-piper: _pipe as an object takes only "pre" and "post" (bash code), got ${extra.length ? extra.map((k) => `"${k}"`).join(', ') : 'neither'}.`);
    }
    const stage = (k) => {
      if (value[k] === undefined) return null;
      if (typeof value[k] !== 'string' || !value[k].trim()) throw new PiperError(`mcp-piper: _pipe.${k} must be bash code as a non-empty string.`);
      return ['bash', '-c', value[k]];
    };
    return { label: 'inline', pre: stage('pre'), post: stage('post') };
  }
  throw new PiperError('mcp-piper: _pipe must be "<snippet> <args>" or {"pre": "<bash>", "post": "<bash>"}.');
}

function run(argv, stage, payload, ev) {
  const res = spawnSync(argv[0], argv.slice(1), {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: ev.cwd && existsSync(ev.cwd) ? ev.cwd : process.cwd(),
    env: { ...process.env, PIPER_STAGE: stage, PIPER_TOOL: ev.tool_name || '' },
    timeout: PIPE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  // EPIPE only means the code exited without reading its stdin.
  if (res.error && res.error.code !== 'EPIPE') {
    const why = res.error.code === 'ETIMEDOUT' ? `timed out after ${PIPE_TIMEOUT_MS / 1000} s` : (res.error.code || res.error.message);
    throw new PiperError(`mcp-piper: _pipe ${stage} step could not run ${argv[0]}: ${why}.`);
  }
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout || '').trim().split('\n').slice(-15).join('\n');
    throw new PiperError(`mcp-piper: _pipe ${stage} step failed (exit ${res.status})${tail ? `:\n${tail}` : '.'}`);
  }
  return res.stdout.trim();
}

/** Before the call: the object to merge into the arguments, or null. Throws PiperError. */
export function runPre(plan, input, ev) {
  if (!plan.pre) return null;
  const out = run(plan.pre, 'pre', { tool: ev.tool_name, input }, ev);
  if (!out) return null;
  let obj;
  try { obj = JSON.parse(out); } catch { obj = null; }
  if (!isPlainObject(obj)) throw new PiperError(`mcp-piper: _pipe pre step must print a JSON object or nothing, got: ${out.slice(0, 200)}`);
  return obj;
}

/** After the call: the text to show instead of the result, or null. Throws PiperError. */
export function runPost(argv, payload, ev) {
  const out = run(argv, 'post', payload, ev);
  return out || null;
}
