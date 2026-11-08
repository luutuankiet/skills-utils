// Mermaid links for Claude Code's MessageDisplay hook: after every ```mermaid
// (or ~~~mermaid) fenced block in an assistant message, one display-only line
// links to the diagram on mermaid.live. The link is built offline: the
// diagram text is deflated and base64url-encoded into the URL fragment.
//
// Claude Code shows a message in batches of whole lines, so a fence can open
// in one batch and close in a later one. The batches of one message run as
// concurrent processes and can finish out of order, so each non-final batch
// leaves its scanner state in a file and batch N waits for the file of batch
// N-1 before it scans. Nothing here knows the hook payload format; the
// adapter in claude.js does.

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { stateDir, STATE_MAX_AGE_MS } from './core.js';

export const WAIT_MS = 3000;
export const POLL_MS = 20;

/** Off when MCP_PIPER_MERMAID is "0", "false", "off" or "no". */
export function mermaidEnabled(env = process.env) {
  const v = env.MCP_PIPER_MERMAID;
  return v === undefined || !/^(0|false|off|no)$/i.test(String(v).trim());
}

/** How long a batch waits for the previous batch's state, from MCP_PIPER_MERMAID_WAIT_MS. */
export function waitMs(env = process.env) {
  const n = Number(env.MCP_PIPER_MERMAID_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : WAIT_MS;
}

// ------------------------------------------------------------------- links ---

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The mermaid.live editor URL for one diagram's text. */
export function mermaidLiveUrl(code) {
  const json = JSON.stringify({ code, mermaid: JSON.stringify({ theme: 'default' }), autoSync: true, updateDiagram: true });
  return `https://mermaid.live/edit#pako:${b64url(deflateSync(Buffer.from(json, 'utf8'), { level: 9 }))}`;
}

/** The JSON object inside a mermaid.live pako URL (for tests and debugging). */
export function decodeMermaidUrl(url) {
  const i = String(url).indexOf('pako:');
  if (i < 0) throw new Error('not a pako URL');
  const s = url.slice(i + 5).replace(/[)\s].*$/s, '').replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(inflateSync(Buffer.from(s, 'base64')).toString('utf8'));
}

export const linkLine = (indent, n, code) => `${indent}↳ [open diagram ${n}](${mermaidLiveUrl(code)})`;

// ----------------------------------------------------------------- scanner ---

/** A fresh scanner state: no open fence, no diagrams yet, no carried text. */
export const newState = () => ({ open: null, n: 0, partial: '' });

// An opening fence: any indent, 3+ backticks or tildes, then an info string.
// CommonMark caps the indent at 3 spaces; messages often indent fences inside
// list items further, so any whitespace indent is accepted.
const OPENER = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
// A backtick fence's info string may not contain a backtick (it would be inline code).
const MERMAID_INFO = /^mermaid(?:\s.*)?$/;

/**
 * Scan one complete line. Returns the link line to insert after it, or null.
 * A fence of any language is tracked, so a ```mermaid line inside a
 * ```markdown block is content, as CommonMark reads it, and gets no link.
 * A diagram whose body is only whitespace gets no link and no number.
 */
export function scanLine(st, line) {
  if (!st.open) {
    const m = OPENER.exec(line);
    if (!m) return null;
    const [, indent, fence, rest] = m;
    if (fence[0] === '`' && rest.includes('`')) return null;
    st.open = { ch: fence[0], len: fence.length, indent, mermaid: MERMAID_INFO.test(rest.trim()), body: [] };
    return null;
  }
  const t = line.trim();
  const o = st.open;
  if (t.length >= o.len && t === o.ch.repeat(t.length)) return closeFence(st);
  if (o.mermaid) o.body.push(stripIndent(line, o.indent.length));
  return null;
}

/** Close the open fence; the link for it, or null when there is nothing to link. */
export function closeFence(st) {
  const o = st.open;
  st.open = null;
  if (!o || !o.mermaid) return null;
  const code = o.body.join('\n');
  if (!code.trim()) return null;
  st.n += 1;
  return linkLine(o.indent, st.n, code);
}

// Remove up to `n` leading whitespace characters, the way CommonMark strips a
// fence's indent from its content lines.
function stripIndent(line, n) {
  let i = 0;
  while (i < n && i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

/**
 * Scan one batch. Returns { text, changed }: `text` is the delta with link
 * lines inserted, keeping the delta's own line endings, so a delta ending in
 * "\n" gives text ending in "\n". At `final` a mermaid fence still open is
 * linked at the end with the body seen so far.
 */
export function scanDelta(st, delta, final) {
  const parts = String(delta).split('\n');
  const tail = parts.pop(); // text after the last "\n": "" or a line still being written
  let out = '';
  let changed = false;
  parts.forEach((piece, i) => {
    const line = i === 0 ? st.partial + piece : piece;
    if (i === 0) st.partial = '';
    out += `${piece}\n`;
    const link = scanLine(st, line);
    if (link) { out += `${link}\n`; changed = true; }
  });
  if (!final) {
    // Claude Code promises whole lines before the final batch; if a piece of a
    // line arrives anyway, it is shown as is and scanned with the next batch.
    if (parts.length === 0) st.partial += tail;
    else st.partial = tail;
    return { text: out + tail, changed };
  }
  const last = parts.length === 0 ? st.partial + tail : tail;
  st.partial = '';
  out += tail;
  const links = [];
  if (last) { const l = scanLine(st, last); if (l) links.push(l); }
  if (st.open) { const l = closeFence(st); if (l) links.push(l); }
  for (const l of links) {
    changed = true;
    if (out && !out.endsWith('\n')) out += `\n${l}`;
    else out += `${l}\n`;
  }
  // A final delta that does not end in "\n" (mid-line, or empty) gets no
  // newline after its last link either.
  if (links.length && !String(delta).endsWith('\n') && out.endsWith('\n')) out = out.slice(0, -1);
  return { text: out, changed };
}

// ------------------------------------------------------------- state files ---

export const mermaidStateDir = () => join(stateDir(), 'mermaid');

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
const batchFile = (id, index) => join(mermaidStateDir(), `${safeId(id)}.${index}.json`);

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);

/**
 * Wait up to `wait` ms for batch `index - 1` to leave its state, then read and
 * delete it. Returns the state, or { lost: true } on timeout or a bad file.
 */
export function takePrevState(id, index, wait = waitMs()) {
  const p = batchFile(id, index - 1);
  const deadline = Date.now() + wait;
  for (;;) {
    let raw = null;
    try { raw = readFileSync(p, 'utf8'); } catch { /* not there yet */ }
    if (raw !== null) {
      try { unlinkSync(p); } catch { /* already gone */ }
      try {
        const st = JSON.parse(raw);
        return st && typeof st === 'object' ? st : { lost: true };
      } catch { return { lost: true }; }
    }
    const left = deadline - Date.now();
    if (left <= 0) return { lost: true };
    sleep(Math.min(POLL_MS, left));
  }
}

/** Leave this batch's state for the next one: written to a temp name, then renamed. */
export function putState(id, index, st) {
  mkdirSync(mermaidStateDir(), { recursive: true });
  const p = batchFile(id, index);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(st));
  renameSync(tmp, p);
}

/** Delete state files older than maxAge (messages whose final batch never came). Never throws. */
export function sweepMermaidState(maxAgeMs = STATE_MAX_AGE_MS, now = Date.now()) {
  let removed = 0;
  try {
    const dir = mermaidStateDir();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); removed++; }
      } catch { /* raced with another hook, fine */ }
    }
  } catch { /* no folder yet */ }
  return removed;
}

/**
 * One MessageDisplay batch: returns the replacement text, or null to leave the
 * original on screen. A batch that never got the previous state passes
 * through and hands { lost: true } on, so later batches do not each wait.
 */
export function processBatch({ id, index, final, delta }, opts = {}) {
  const wait = opts.wait === undefined ? waitMs() : opts.wait;
  // Fast path: a whole message in one call (claude -p, the SDK, short replies)
  // with no diagram touches no files.
  if (index === 0 && final && !delta.includes('mermaid')) return null;
  let st = null;
  try {
    if (index === 0) {
      sweepMermaidState();
      st = newState();
    } else {
      st = takePrevState(id, index, wait);
    }
    if (st.lost) {
      if (!final) putState(id, index, { lost: true });
      return null;
    }
    const r = scanDelta(st, delta, final);
    if (!final) putState(id, index, st);
    return r.changed ? r.text : null;
  } catch (err) {
    // Hand the next batch something so it does not wait out its timeout.
    if (!final) { try { putState(id, index, { lost: true }); } catch { /* nothing more to do */ } }
    throw err;
  }
}
