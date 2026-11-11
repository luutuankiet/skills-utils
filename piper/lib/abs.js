// Staging paths for writes a worktree-isolated agent is refused.
//
// Claude Code refuses Write and Edit from an agent isolated in a git worktree
// when the file sits in the main checkout or a sibling worktree. A staging
// path is a real file outside every repository, so it is allowed:
//
//   <staging root>/<absolute target path>
//   ~/.piper/abs/home/me/repo/notes.md   stands for   /home/me/repo/notes.md
//
// Read copies the target into staging, Write copies staging out to the target,
// Edit is replayed on the target, and Bash commands naming a staging path are
// rewritten to the target. Every handler returns null quickly for a call that
// does not touch the staging root.

import {
  copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';

export class AbsError extends Error {
  constructor(message) {
    super(message.startsWith('mcp-piper:') ? message : `mcp-piper: ${message}`);
    this.name = 'AbsError';
  }
}

const DEFAULT_ROOT = () => join(homedir(), '.piper', 'abs');

/** Absolute staging root, no trailing slash. PIPER_ABS_ROOT overrides. */
export function stagingRoot(env = process.env) {
  const raw = env && typeof env.PIPER_ABS_ROOT === 'string' ? env.PIPER_ABS_ROOT.trim() : '';
  const root = raw ? resolve(raw) : DEFAULT_ROOT();
  return root.length > 1 ? root.replace(/\/+$/, '') : root;
}

/**
 * Literal strings that mean "this text names the staging root": the absolute
 * root, plus the ~/, $HOME/ and ${HOME}/ spellings when it sits under home.
 */
export function rootMarkers(root, home = homedir()) {
  const out = [root];
  if (home && home !== '/' && root.startsWith(home + '/')) {
    const rel = root.slice(home.length + 1);
    out.push(`~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`);
  }
  return out;
}

const hasGitSegment = (p) => p.split('/').some((s) => s.toLowerCase() === '.git');

/**
 * Staging path to absolute target, or null when the path is not under the
 * staging root. Throws AbsError for a path piper refuses to map.
 */
export function toTarget(path, root) {
  if (typeof path !== 'string') return null;
  if (path === root || path === root + '/') {
    throw new AbsError(`mcp-piper: ${path} is the staging root itself. Add the absolute path of the file after it, e.g. ${root}/home/me/repo/notes.md.`);
  }
  if (!path.startsWith(root + '/')) return null;
  const rest = path.slice(root.length);
  // Refuse rather than normalise: a ".." would silently name another file.
  if (rest.split('/').includes('..')) {
    throw new AbsError(`mcp-piper: refused ${path}: it has a ".." segment. Name the target by its full absolute path after ${root}.`);
  }
  let target = posix.normalize(rest);
  if (target.length > 1) target = target.replace(/\/+$/, '');
  if (target === '/' || !target.startsWith('/')) {
    throw new AbsError(`mcp-piper: refused ${path}: it names no file after the staging root ${root}.`);
  }
  // Case-insensitive because macOS file systems usually are.
  if (hasGitSegment(target)) {
    throw new AbsError(`mcp-piper: refused ${path}: the target ${target} is inside a .git folder, which piper never writes.`);
  }
  return target;
}

/** Absolute target to staging path. */
export function toStaging(target, root) {
  const t = posix.normalize(String(target));
  if (!t.startsWith('/')) throw new AbsError(`mcp-piper: ${target} is not an absolute path.`);
  return t === '/' ? root : root + t.replace(/\/+$/, '');
}

function countOf(text, needle) {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

function applyEdit(text, oldS, newS, all) {
  if (all) return text.split(oldS).join(newS);
  const i = text.indexOf(oldS);
  return text.slice(0, i) + newS + text.slice(i + oldS.length);
}

/**
 * Apply an Edit's old_string -> new_string to the current text of the target.
 * Returns the new text or throws AbsError. `where` names the target and the
 * staging path for the messages. A CRLF file is matched as LF, the way Claude
 * Code shows it to the model, and written back with CRLF.
 */
export function checkEdit(currentText, toolInput, where = {}) {
  const target = where.target || 'the target';
  const staging = where.staging || 'the staging path';
  const input = toolInput || {};
  const oldS = input.old_string;
  const newS = typeof input.new_string === 'string' ? input.new_string : '';
  const all = input.replace_all === true;
  if (typeof oldS !== 'string' || oldS === '') {
    throw new AbsError(`mcp-piper: edit not applied. old_string is empty, so it names no place in ${target}. To replace the whole file, Write ${staging}.`);
  }
  let text = currentText;
  let crlf = false;
  if (!text.includes(oldS) && text.includes('\r\n') && !oldS.includes('\r')) {
    text = text.split('\r\n').join('\n');
    crlf = true;
  }
  const n = countOf(text, oldS);
  if (n === 0) {
    throw new AbsError(`mcp-piper: edit not applied. old_string is not in the current file ${target}, so it changed after your last Read. Read ${staging} again to see the current text, then retry the Edit using that text.`);
  }
  if (n > 1 && !all) {
    throw new AbsError(`mcp-piper: edit not applied. old_string matches ${n} places in the current file ${target}. Read ${staging} again, then retry the Edit with more surrounding text to make it unique, or with replace_all.`);
  }
  const out = applyEdit(text, oldS, newS, all);
  return crlf ? out.split('\n').join('\r\n') : out;
}

/** Rewrite every staging root marker followed by "/" to "/". Null when unchanged. */
export function rewriteCommand(command, root, home = homedir()) {
  if (typeof command !== 'string') return null;
  let out = command;
  for (const m of rootMarkers(root, home)) {
    if (out.includes(m + '/')) out = out.split(m + '/').join('/');
  }
  return out === command ? null : out;
}

/** The two hint lines, naming `root` (shown as ~/.piper/abs for the default). */
export function absHint(root = stagingRoot({})) {
  const shown = root === DEFAULT_ROOT() ? '~/.piper/abs' : root;
  return [
    `Writes outside this worktree that are refused can go through ${shown}/<absolute path>, e.g. ${shown}/home/me/repo/notes.md.`,
    `Read the file there first, then Edit or Write that same ${shown} path; keep using it, never the plain path.`,
  ].join('\n');
}

export const ABS_HINT = absHint(DEFAULT_ROOT());

// ------------------------------------------------------------------ handlers ---

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);

const denyOut = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason.startsWith('mcp-piper:') ? reason : `mcp-piper: ${reason}`,
  },
});

const postContext = (text) => ({
  hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
});

const errText = (err) => (err && (err.code || err.message)) || String(err);

/** Claude Code may pass a ~/ path through as typed. */
function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

function statOrNull(p) {
  try { return statSync(p); } catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null; throw err; }
}

function readUtf8(target) {
  const buf = readFileSync(target);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    throw new AbsError(`mcp-piper: edit not applied. ${target} is not UTF-8 text, and piper only replays edits on UTF-8 text.`);
  }
  return text;
}

/** The staging call a file tool names, or null when it is not on staging. */
function fileCall(ev, root) {
  const input = ev.tool_input;
  if (!input || typeof input !== 'object') return null;
  const path = expandHome(input.file_path);
  if (typeof path !== 'string' || !path.startsWith(root)) return null;
  if (path !== root && path[root.length] !== '/') return null;
  return { input, path };
}

/**
 * PreToolUse. Returns the hook output object, or null to leave the call alone.
 * Success never sends permissionDecision "allow": that would let any agent
 * write any file on the machine through a staging path without a prompt, so
 * the user's own permission rules decide instead.
 */
export function handlePre(ev, env = process.env) {
  const tool = ev && ev.tool_name;
  if (tool !== 'Bash' && !FILE_TOOLS.has(tool)) return null;
  const root = stagingRoot(env);

  if (tool === 'Bash') {
    const input = ev.tool_input;
    const cmd = input && typeof input === 'object' ? input.command : null;
    if (typeof cmd !== 'string' || !rootMarkers(root).some((m) => cmd.includes(m))) return null;
    try {
      const next = rewriteCommand(cmd, root);
      if (next === null) return null;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command: next } } };
    } catch {
      return null;
    }
  }

  const call = fileCall(ev, root);
  if (!call) return null;
  try {
    const target = toTarget(call.path, root);
    if (target === null) return null;
    const staging = toStaging(target, root);

    if (tool === 'Read') {
      const st = statOrNull(target);
      if (st && st.isFile()) {
        mkdirSync(dirname(staging), { recursive: true });
        copyFileSync(target, staging);
      } else if (!st) {
        // So Read reports the file missing rather than showing stale text.
        const old = statOrNull(staging);
        if (old && old.isFile()) rmSync(staging, { force: true });
      }
      return null;
    }

    if (tool === 'Write') return null;

    // Edit: check that the edit applies to the current target. Neither file
    // is written here; a touched staging file makes Claude Code refuse the
    // Edit, and the target changes only in PostToolUse, after any prompt.
    const st = statOrNull(target);
    if (!st || !st.isFile()) {
      return denyOut(`mcp-piper: edit not applied. ${target} does not exist, so there is nothing to edit. To create it, Write ${staging}.`);
    }
    checkEdit(readUtf8(target), call.input, { target, staging });
    return null;
  } catch (err) {
    if (err instanceof AbsError) return denyOut(err.message);
    return denyOut(`mcp-piper: could not prepare ${tool} on ${call.path} (${errText(err)}), so it was stopped. Retry; if it fails again, report this message.`);
  }
}

/** PostToolUse for Write and Edit on a staging path. */
export function handlePost(ev, env = process.env) {
  const tool = ev && ev.tool_name;
  if (tool !== 'Write' && tool !== 'Edit') return null;
  const root = stagingRoot(env);
  const call = fileCall(ev, root);
  if (!call) return null;
  let target = null;
  try {
    target = toTarget(call.path, root);
    if (target === null) return null;
    const staging = toStaging(target, root);

    if (tool === 'Write') {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(staging, target);
      return null;
    }

    // Edit: replay on the target as it is now.
    let next;
    try {
      next = checkEdit(readUtf8(target), call.input, { target, staging });
    } catch (err) {
      if (!(err instanceof AbsError)) throw err;
      copyFileSync(target, staging);
      return postContext(`mcp-piper: your Edit changed only the staging copy; it was NOT applied to ${target}, because that file changed while the Edit ran. Read ${staging} again to see the current text, then retry the Edit using that text.`);
    }
    writeFileSync(target, next);
    // Copy back only when different: a moved mtime on staging makes Claude
    // Code refuse the next Edit with "File content has changed since it was
    // last read."
    const want = readFileSync(target);
    let have = null;
    try { have = readFileSync(staging); } catch { /* missing: copy below */ }
    if (!have || !have.equals(want)) copyFileSync(target, staging);
    return null;
  } catch (err) {
    if (err instanceof AbsError) return postContext(err.message);
    return postContext(`mcp-piper: ${tool} wrote the staging copy ${call.path}, but ${target || 'the target'} may not be updated (${errText(err)}). Check it, then Read the staging path again before retrying.`);
  }
}
