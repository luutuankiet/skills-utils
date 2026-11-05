// Claude Code adapter for mcp-piper: hook payload JSON in, hook output JSON out.
//
// Each handler takes the parsed stdin payload and returns the object to print,
// or null to print nothing (which leaves the tool call exactly as it was).

import {
  PiperError, NUDGE_TEXT, hasPointerCandidates, needsInlineNudge, prepareInput,
  normaliseResult, saveResult, buildStub, writeState, readState, deleteState, humanSize,
} from './core.js';

// ---------------------------------------------------------------- settings ---
// Three behaviours, each settled by nested Claude Code runs (version 2.1.318).

/**
 * permissionDecision sent with updatedInput when mcp-piper changed the input.
 * "allow" skips the user's permission prompt for that call; "ask" keeps it;
 * null sends no decision at all. Calls mcp-piper does not change get no output.
 * null is the default: Claude Code still applies updatedInput, and the user's
 * own permission rules decide as they would without mcp-piper. "allow" would
 * run tools the user never allowed; "ask" forces a prompt even in bypass mode.
 */
export const DECISION_WHEN_CHANGED = null;

/**
 * Where the inline-paste tip goes: "pre" adds it as PreToolUse
 * additionalContext; "post" flags the call in a state file and adds it as
 * PostToolUse additionalContext once the result is back.
 * "pre" is the default: it needs no state file and reaches the agent even
 * when the call then fails.
 */
export const NUDGE_ROUTE = 'pre';

/**
 * When a result looks like an error and the call asked for `_save_to`:
 * false passes the error through to the agent untouched and saves nothing;
 * true saves it like any other result. Claude Code sends a tool error to
 * PostToolUseFailure rather than PostToolUse, so this only matters for a
 * result that marks itself as an error inside a successful call.
 */
export const SAVE_ERROR_RESULTS = false;

const DEFAULTS = {
  decision: DECISION_WHEN_CHANGED,
  nudgeRoute: NUDGE_ROUTE,
  saveErrors: SAVE_ERROR_RESULTS,
};

export const MEMORY_NOTE = 'mcp-piper is active for MCP tools. To send a file on disk as a tool argument, write the argument as "@file:<abs path>" (text) or "@file64:<abs path>" (base64); "@dir:<abs path>" / "@dir64:<abs path>" send a folder as a {"relative/path": contents} map. The bytes are read for you and never enter your context. To save a tool\'s result to disk instead of reading it, add "_save_to": "<abs path>" to the call (end it in "/" to save into a folder); you get back a short stub with the paths. Never write or read base64 yourself when a pointer or _save_to can carry it. Details: the mcp-piper skill.';

// ------------------------------------------------------------------ helpers ---

export function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason.startsWith('mcp-piper:') ? reason : `mcp-piper: ${reason}`,
    },
  };
}

/** True when the payload's tool call involves mcp-piper at all. */
export function involvesPiper(ev) {
  const input = ev && ev.tool_input;
  if (!input || typeof input !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(input, '_save_to') || hasPointerCandidates(input);
}

/** Does a PostToolUse tool_response look like a tool error? */
export function isErrorResult(resp) {
  if (!resp || typeof resp !== 'object') return false;
  if (Array.isArray(resp)) return resp.some((b) => b && typeof b === 'object' && (b.isError === true || b.is_error === true));
  return resp.isError === true || resp.is_error === true;
}

function describe(prep) {
  const parts = [];
  for (const p of prep.pointers) {
    parts.push(p.files === undefined
      ? `${p.base64 ? 'base64' : 'text'} ${humanSize(p.bytes)} from ${p.abs}`
      : `folder of ${p.files} file${p.files === 1 ? '' : 's'} (${p.base64 ? 'base64' : 'text'}, ${humanSize(p.bytes)}) from ${p.abs}`);
  }
  if (prep.escapes) parts.push(`${prep.escapes} escaped "@@file" value${prep.escapes === 1 ? '' : 's'} sent literally`);
  if (prep.saveTo) parts.push(`result will be saved to ${prep.saveTo}`);
  return `mcp-piper: ${parts.join('; ')}`;
}

// ----------------------------------------------------------------- handlers ---

export function pre(ev, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const input = ev && ev.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = ev.tool_use_id;

  // Fast path: nothing for mcp-piper to do except maybe the paste tip.
  if (!involvesPiper(ev)) {
    if (!needsInlineNudge(input)) return null;
    if (o.nudgeRoute === 'pre') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: NUDGE_TEXT } };
    }
    if (id) writeState(id, { saveTo: null, expanded: false, nudge: true });
    return null;
  }

  let prep;
  try {
    prep = prepareInput(input, { cwd: ev.cwd || process.cwd() });
  } catch (err) {
    if (err instanceof PiperError) return deny(err.message);
    throw err;
  }

  // Never nudge on a call whose input came from a pointer.
  const nudge = !prep.expanded && needsInlineNudge(prep.input);

  if (prep.saveTo || (nudge && o.nudgeRoute === 'post')) {
    if (!id) {
      if (prep.saveTo) return deny('mcp-piper: cannot honour _save_to because Claude Code gave this call no tool_use_id. Call again without _save_to.');
    } else {
      writeState(id, { saveTo: prep.saveTo, expanded: prep.expanded, nudge: nudge && o.nudgeRoute === 'post' });
    }
  }

  if (!prep.changed) return null;
  const out = { hookEventName: 'PreToolUse' };
  if (o.decision) {
    out.permissionDecision = o.decision;
    out.permissionDecisionReason = describe(prep);
  }
  out.updatedInput = prep.input;
  if (nudge && o.nudgeRoute === 'pre') out.additionalContext = NUDGE_TEXT;
  return { hookSpecificOutput: out };
}

export function post(ev, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const id = ev && ev.tool_use_id;
  if (!id) return null;
  const state = readState(id);
  if (!state) return null;
  try {
    const resp = ev.tool_response;
    if (!o.saveErrors && isErrorResult(resp)) return null;
    const extra = state.nudge ? { additionalContext: NUDGE_TEXT } : {};
    if (!state.saveTo) {
      return state.nudge ? { hookSpecificOutput: { hookEventName: 'PostToolUse', ...extra } } : null;
    }
    let saved;
    try {
      saved = saveResult(normaliseResult(resp), state.saveTo);
    } catch (err) {
      // Better the agent reads the result than loses it.
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `mcp-piper: could not save the result to ${state.saveTo} (${err.code || err.message}), so it is shown in full instead.`,
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: [{ type: 'text', text: buildStub(saved) }],
        ...extra,
      },
    };
  } finally {
    deleteState(id);
  }
}

/** For a tool call that failed outright: forget it, change nothing. */
export function failure(ev) {
  if (ev && ev.tool_use_id) deleteState(ev.tool_use_id);
  return null;
}

export function sessionStart() {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: MEMORY_NOTE } };
}

export function subagentStart() {
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: MEMORY_NOTE } };
}

export const HANDLERS = {
  pre,
  post,
  'post-failure': failure,
  'session-start': sessionStart,
  'subagent-start': subagentStart,
};
