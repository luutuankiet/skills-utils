// mcp-piper core: pointer expansion, `_save_to` handling, result saving and
// the stub the agent sees instead of the result.
//
// Nothing in this file knows about any particular agent harness. An adapter
// (lib/claude.js for Claude Code) turns the harness's hook payloads into calls
// to these functions and turns the answers back into the harness's format.

import {
  readFileSync, writeFileSync, statSync, mkdirSync, accessSync, unlinkSync,
  readdirSync, constants as fsc,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

export const NUDGE_THRESHOLD = 20000;
export const NUDGE_TEXT = 'mcp-piper: next time pass large text as "@file:<path>" instead of pasting it';
export const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** An error whose message is meant for the agent, as is. */
export class PiperError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PiperError';
  }
}

// ------------------------------------------------------------ pointer scan ---

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const looksLikePointer = (s) =>
  s.startsWith('@file:') || s.startsWith('@file64:') || s.startsWith('@@file');

/**
 * Cheap test run on every tool call: does any string value, at any depth,
 * start with `@file:`, `@file64:` or `@@file`? Stops at the first hit and
 * allocates nothing.
 */
export function hasPointerCandidates(value) {
  if (typeof value === 'string') return looksLikePointer(value);
  if (Array.isArray(value)) {
    for (const v of value) if (hasPointerCandidates(v)) return true;
    return false;
  }
  if (isPlainObject(value)) {
    for (const k in value) if (hasPointerCandidates(value[k])) return true;
  }
  return false;
}

/** Length of the longest string value at any depth. */
export function longestString(value) {
  if (typeof value === 'string') return value.length;
  let max = 0;
  if (Array.isArray(value)) for (const v of value) max = Math.max(max, longestString(v));
  else if (isPlainObject(value)) for (const k in value) max = Math.max(max, longestString(value[k]));
  return max;
}

/** True when a call has no pointers but pastes a string longer than the threshold. */
export function needsInlineNudge(input, threshold = NUDGE_THRESHOLD) {
  return !hasPointerCandidates(input) && longestString(input) > threshold;
}

// ------------------------------------------------------- path resolution ---

/** Resolve a path the agent wrote: `~` and `~/` expand, relative is against cwd. */
export function resolvePath(p, cwd = process.cwd(), home = homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

// ------------------------------------------------------- pointer expansion ---

const POINTER = /^@file(64)?:([\s\S]*)$/;
const ESCAPE = /^@@file(64)?:/;

function readPointer(raw, isBase64, rawPath, cwd, home) {
  if (rawPath === '') {
    throw new PiperError(`mcp-piper: "${raw}" has no path. Write "@file:<path>" with the path right after the colon.`);
  }
  const abs = resolvePath(rawPath, cwd, home);
  const literal = `write "@${raw}" instead to send the text literally`;
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new PiperError(`mcp-piper: file not found: ${abs} (from "${raw}"). Fix the path, or ${literal}.`);
    }
    throw new PiperError(`mcp-piper: cannot read ${abs} (from "${raw}"): ${err.code || err.message}. Check the path and its permissions, or ${literal}.`);
  }
  if (st.isDirectory()) {
    throw new PiperError(`mcp-piper: ${abs} is a folder (from "${raw}"). Pointers take a single file; folders are not supported yet. Point at one file, or pack the folder into one first.`);
  }
  let buf;
  try {
    buf = readFileSync(abs);
  } catch (err) {
    throw new PiperError(`mcp-piper: cannot read ${abs} (from "${raw}"): ${err.code || err.message}. Check the file's permissions, or ${literal}.`);
  }
  return { abs, bytes: buf.length, text: isBase64 ? buf.toString('base64') : buf.toString('utf8') };
}

/**
 * Expand every pointer and escape, depth first, in arrays and objects.
 * Returns a new value; the input is not modified. Object keys are never
 * touched, only values. Throws PiperError with a message for the agent.
 *
 * @returns {{ value: any, pointers: {abs: string, bytes: number, base64: boolean}[], escapes: number }}
 */
export function expandPointers(value, { cwd = process.cwd(), home = homedir() } = {}) {
  const pointers = [];
  let escapes = 0;
  const walk = (v) => {
    if (typeof v === 'string') {
      if (!v.startsWith('@')) return v;
      if (ESCAPE.test(v)) { escapes++; return v.slice(1); }
      const m = POINTER.exec(v);
      if (!m) return v;
      const r = readPointer(v, Boolean(m[1]), m[2], cwd, home);
      pointers.push({ abs: r.abs, bytes: r.bytes, base64: Boolean(m[1]) });
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return { value: walk(value), pointers, escapes };
}

// ---------------------------------------------------------------- _save_to ---

/**
 * Check a `_save_to` value, create its parent folder and confirm it is
 * writable. Returns the absolute path. Throws PiperError.
 */
export function validateSaveTo(v, { cwd = process.cwd(), home = homedir() } = {}) {
  if (typeof v !== 'string') {
    throw new PiperError(`mcp-piper: _save_to must be a file path string, got ${v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v}. Write "_save_to": "/abs/path/out.txt".`);
  }
  if (v.trim() === '') {
    throw new PiperError('mcp-piper: _save_to is empty. Write "_save_to": "/abs/path/out.txt".');
  }
  const abs = resolvePath(v, cwd, home);
  let st = null;
  try { st = statSync(abs); } catch { /* not there yet, which is normal */ }
  if (st && st.isDirectory()) {
    throw new PiperError(`mcp-piper: _save_to ${abs} is a folder. Give a file path inside it instead, e.g. ${join(abs, 'out.txt')}; saving into a folder is not supported yet.`);
  }
  const parent = dirname(abs);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (err) {
    throw new PiperError(`mcp-piper: cannot create the folder ${parent} for _save_to: ${err.code || err.message}. Choose a path you can write to.`);
  }
  try {
    accessSync(parent, fsc.W_OK);
    if (st) accessSync(abs, fsc.W_OK);
  } catch (err) {
    throw new PiperError(`mcp-piper: cannot write to ${st ? abs : parent} for _save_to: ${err.code || err.message}. Choose a path you can write to.`);
  }
  return abs;
}

/**
 * Everything the pre-call step needs, in one go: expand pointers, resolve
 * escapes, validate and strip `_save_to`. Throws PiperError.
 *
 * @returns {{ input: object, changed: boolean, expanded: boolean, saveTo: string|null,
 *             pointers: object[], escapes: number }}
 */
export function prepareInput(toolInput, opts = {}) {
  const input = isPlainObject(toolInput) ? toolInput : {};
  const hasSave = Object.prototype.hasOwnProperty.call(input, '_save_to');
  const saveTo = hasSave ? validateSaveTo(input._save_to, opts) : null;
  const rest = { ...input };
  delete rest._save_to;
  const { value, pointers, escapes } = hasPointerCandidates(rest)
    ? expandPointers(rest, opts)
    : { value: rest, pointers: [], escapes: 0 };
  return {
    input: value,
    changed: hasSave || pointers.length > 0 || escapes > 0,
    expanded: pointers.length > 0,
    saveTo,
    pointers,
    escapes,
  };
}

// ----------------------------------------------------------- result saving ---

export const humanSize = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(1)} KB`
      : `${n} B`;

export const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
};
const EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};

const IMAGE_SOURCE = /^\[Image: source: (.+)\]$/;

/**
 * Normalise whatever the harness hands over into one of:
 *   { kind: 'blocks', blocks }  an array of content blocks
 *   { kind: 'json', text }      a JSON document (e.g. structuredContent)
 *   { kind: 'text', text }      anything else, as text
 */
export function normaliseResult(resp) {
  if (Array.isArray(resp)) return { kind: 'blocks', blocks: resp };
  if (isPlainObject(resp) && Array.isArray(resp.content)) return { kind: 'blocks', blocks: resp.content };
  if (typeof resp === 'string') {
    try {
      return { kind: 'json', text: JSON.stringify(JSON.parse(resp), null, 2) };
    } catch {
      return { kind: 'text', text: resp };
    }
  }
  if (resp === undefined) return { kind: 'text', text: '' };
  return { kind: 'json', text: JSON.stringify(resp, null, 2) };
}

/** Find the mcpproxy truncation marker in some text. */
export function detectTruncation(text) {
  if (typeof text !== 'string' || !text.includes('[truncated by mcpproxy')) return null;
  const m = /read_cache tool: key="([0-9a-f]{64})"/.exec(text);
  return { key: m ? m[1] : null };
}

export function truncationWarning(t) {
  return t.key
    ? `warning: mcpproxy cut this result short before it arrived, so the saved file is partial. The rest is in mcpproxy's cache: call its read_cache tool with key="${t.key}" in pages, or raise its tool_response_limit.`
    : 'warning: mcpproxy cut this result short before it arrived and kept no cache, so the saved file is partial and the rest is lost. Set mcpproxy\'s tool_response_limit to 0 and call again.';
}

/** `<dir>/<stem>-img<N><ext>` next to the save path. */
export function siblingPath(saveTo, label, n, ext) {
  const stem = basename(saveTo, extname(saveTo));
  return join(dirname(saveTo), `${stem}-${label}${n}${ext}`);
}

function readSource(p) {
  try { return readFileSync(p); } catch { return null; }
}

/**
 * Save a normalised result to `saveTo` (absolute). Text goes to `saveTo`,
 * each image to `<stem>-img<N>.<ext>` beside it. Links are never followed:
 * a `[Resource link: ...]` line is saved as the text it is.
 *
 * @returns {{ files: {path: string, bytes: number, sha: string, kind: string}[], warnings: string[] }}
 */
export function saveResult(result, saveTo) {
  mkdirSync(dirname(saveTo), { recursive: true });
  const files = [];
  const warnings = [];
  const write = (p, buf, kind) => {
    writeFileSync(p, buf);
    files.push({ path: p, bytes: buf.length, sha: sha16(buf), kind });
  };

  if (result.kind !== 'blocks') {
    const t = detectTruncation(result.text);
    if (t) warnings.push(truncationWarning(t));
    write(saveTo, Buffer.from(result.text, 'utf8'), result.kind);
    return { files, warnings };
  }

  const texts = [];
  const sources = [];
  const images = [];
  const audio = [];
  for (const b of result.blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') {
      const kept = [];
      let dropped = 0;
      for (const line of String(b.text ?? '').split('\n')) {
        const m = IMAGE_SOURCE.exec(line);
        if (m) { sources.push(m[1]); dropped++; } else kept.push(line);
      }
      // A block that held only image source lines leaves nothing behind.
      if (!(dropped && kept.join('').trim() === '')) texts.push(kept.join('\n'));
    } else if (b.type === 'image') {
      images.push(b);
    } else if (b.type === 'audio') {
      audio.push(b);
    } else {
      texts.push(JSON.stringify(b));
    }
  }

  const text = texts.join('\n');
  const t = detectTruncation(text);
  if (t) warnings.push(truncationWarning(t));
  if (texts.length || (!images.length && !sources.length && !audio.length)) {
    write(saveTo, Buffer.from(text, 'utf8'), 'text');
  }

  // Claude Code hands hooks a recompressed copy of each image plus a line
  // naming the file that holds the server's original bytes. Prefer the
  // original; decode the block only when there is no readable source.
  const count = Math.max(images.length, sources.length);
  for (let i = 0; i < count; i++) {
    const block = images[i];
    const src = sources[i] ? readSource(sources[i]) : null;
    let buf; let ext; let mime;
    if (src) {
      buf = src;
      ext = extname(sources[i]).toLowerCase() || MIME_EXT[block?.mimeType] || '.bin';
      mime = EXT_MIME[ext] || block?.mimeType || 'application/octet-stream';
    } else if (block) {
      mime = block.mimeType || block.source?.media_type || 'application/octet-stream';
      buf = Buffer.from(block.data ?? block.source?.data ?? '', 'base64');
      ext = MIME_EXT[mime] || '.bin';
      if (sources[i]) warnings.push(`warning: the original image ${sources[i]} could not be read, so image ${i + 1} was saved from the recompressed copy.`);
    } else {
      warnings.push(`warning: image ${i + 1} pointed at ${sources[i]}, which could not be read, and had no data to fall back on; it was not saved.`);
      continue;
    }
    write(siblingPath(saveTo, 'img', i + 1, ext), buf, mime);
  }
  audio.forEach((b, i) => {
    const mime = b.mimeType || 'application/octet-stream';
    const sub = mime.split('/')[1];
    const ext = sub && /^[a-z0-9]+$/.test(sub) ? `.${sub}` : '.bin';
    write(siblingPath(saveTo, 'audio', i + 1, ext), Buffer.from(b.data ?? '', 'base64'), mime);
  });
  return { files, warnings };
}

/** The short text the agent sees instead of the result. Never any payload. */
export function buildStub({ files, warnings = [] }) {
  const lines = [`mcp-piper: saved ${files.length} file${files.length === 1 ? '' : 's'}`];
  for (const f of files) lines.push(`- ${f.path} (${humanSize(f.bytes)}, sha256 ${f.sha}, ${f.kind})`);
  for (const w of warnings) lines.push(w);
  return lines.join('\n');
}

// -------------------------------------------------------------------- state ---

export function stateDir() {
  return process.env.MCP_PIPER_STATE_DIR || join(tmpdir(), 'mcp-piper', 'state');
}

const stateFile = (id) => join(stateDir(), `${String(id).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);

/** Delete state files older than maxAge. Never throws. */
export function sweepState(maxAgeMs = STATE_MAX_AGE_MS, now = Date.now()) {
  let removed = 0;
  try {
    const dir = stateDir();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); removed++; }
      } catch { /* raced with another hook, fine */ }
    }
  } catch { /* no folder yet */ }
  return removed;
}

export function writeState(id, data) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(stateFile(id), JSON.stringify(data));
  sweepState();
}

export function readState(id) {
  try { return JSON.parse(readFileSync(stateFile(id), 'utf8')); } catch { return null; }
}

export function deleteState(id) {
  try { unlinkSync(stateFile(id)); return true; } catch { return false; }
}
