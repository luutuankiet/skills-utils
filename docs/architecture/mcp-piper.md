---
title: mcp-piper
covers: where mcp-piper expands @file pointers, handles _save_to, saves a tool result and builds the stub, carries state between the pre and post hooks, adds mermaid.live links under mermaid blocks on screen, wires the Claude Code hooks, and runs doctor or the nested lab tests
verified: 2026-11-08
---

# mcp-piper

mcp-piper is a set of Claude Code hooks on every MCP tool (`mcp__.*`). Before a
call, a string argument written as `"@file:<path>"` or `"@file64:<path>"` is
replaced by the file's contents, and `"@dir:<path>"` / `"@dir64:<path>"` by an
object mapping each relative path in the folder to its contents. After a call
that carried a top-level `"_save_to": "<path>"`, the result is written to disk
(into a folder when the path ends in `/`, where embedded resources with a
relative `uri` land at `<folder>/<uri>`) and the agent gets a short stub
instead. A third, separate hook adds a display-only `↳ [open diagram N](...)`
line linking to mermaid.live under every mermaid block in Claude's replies. It ships inside this plugin (hooks in `hooks/hooks.json`, skill in
`skills/mcp-piper/SKILL.md`) and as the npm package `@luutuankiet/mcp-piper`
from `piper/`.

Line numbers below are a starting point, not an address. Jump roughly there and
confirm by what the code says; if a range is off by more than a screen, fix it
here and re-date the page.

## The path of one call

1. `hooks/hooks.json` runs `node "${CLAUDE_PLUGIN_ROOT}/piper/bin/mcp-piper.js" hook <event>`
   for `PreToolUse`, `PostToolUse` and `PostToolUseFailure` on `mcp__.*`, and for
   `SessionStart`, `SubagentStart` and `MessageDisplay` with no matcher.
2. `piper/bin/mcp-piper.js` reads the payload from stdin and calls the matching
   handler in `piper/lib/claude.js`.
3. `pre` expands pointers and strips `_save_to` through `piper/lib/core.js`,
   returns `updatedInput`, and writes a state file keyed by `tool_use_id` when
   the post hook will need to act.
4. `post` reads that state file, saves the result, replaces the tool output with
   the stub, and deletes the state file. `failure` only deletes it.

## The path of one message batch (mermaid links)

1. Claude Code runs `hook messagedisplay` once per batch of finished lines of
   an assistant message (`message_id`, `index`, `final`, `delta`); `claude -p`
   sends one call with the whole message.
2. `messageDisplay` in `piper/lib/claude.js` checks the fields and
   `MCP_PIPER_MERMAID` (`0` turns it off), then calls `processBatch` in
   `piper/lib/mermaid.js`.
3. A single-call message without the word `mermaid` returns at once and
   touches no files. Otherwise batch N waits (polling, up to
   `MCP_PIPER_MERMAID_WAIT_MS`, default 3000) for the state file batch N-1
   wrote under `<state dir>/mermaid/`, reads and deletes it, scans its lines,
   and writes its own state unless it is the final batch. Batches of one
   message run at the same time and finish out of order, which is why they
   hand state on through files.
4. A batch that timed out, or read a `{lost: true}` state, prints nothing (the
   original text shows) and writes `{lost: true}` for the next batch, so one
   missing batch costs one wait, not one per later batch.
5. Output is printed only when a link was inserted. The replacement keeps the
   delta's line endings, so a delta ending in a newline is replaced by text
   ending in one.

## Where things live

| file | lines | what lives there |
|---|---|---|
| `piper/bin/mcp-piper.js` | 35-61 | `runHook`: stdin parse, dispatch, and the rule that an internal error denies the call only when it involved a pointer or `_save_to` (only for `pre`, so never for `messagedisplay`) |
| `piper/bin/mcp-piper.js` | 74-146 | `doctor`: checks the node version, looks for `hooks/hooks.json` next to the package, dry-runs a pointer through `pre`, checks a sample mermaid block gets a link that decodes back, and checks the state folder is writable |
| `piper/lib/claude.js` | 13-50 | the three behaviour settings (`DECISION_WHEN_CHANGED`, `NUDGE_ROUTE`, `SAVE_ERROR_RESULTS`) with the reason for each default, and the session note text |
| `piper/lib/claude.js` | 78-103 | `toolResultsFolders` (the only folders a result may name a file in, from `transcript_path`) and `serverMatcher` (whose resource headers place files, from `mcp_server.name` or the tool name) |
| `piper/lib/claude.js` | 119-163 | `pre` handler, including the fast path for calls with nothing to do |
| `piper/lib/claude.js` | 165-217 | `post` (passes the two above to `saveResult`), `failure`, `sessionStart`, `subagentStart` |
| `piper/lib/claude.js` | 219-246 | `messageDisplay` (field checks, any error prints nothing) and the `HANDLERS` table |
| `piper/lib/core.js` | 31-70 | cheap pointer scan run on every call (every new pointer prefix must be added to `looksLikePointer`), and the large-paste tip threshold |
| `piper/lib/core.js` | 72-203 | path resolution and pointer expansion: `@file:` in `readPointer`, `@dir:` with its skip rules and the `DIR_MAX_FILES` / `DIR_MAX_BYTES` caps in `readDirPointer`, and the `@@file:` / `@@dir:` escape |
| `piper/lib/core.js` | 205-274 | `_save_to` validation (a folder target comes back with a trailing separator) and `prepareInput` |
| `piper/lib/core.js` | 276-340 | result normalising, truncation detection, `siblingPath` (names images for a file or a folder target) |
| `piper/lib/core.js` | 342-370 | `readTrusted` and `realFolders`: a local file a result names is read only when its real path is inside a trusted folder |
| `piper/lib/core.js` | 372-445 | embedded resources: how Claude Code renders them before a hook sees them, `resourcePath` (relative path or refusal, NUL refused), `resourceTarget` (stays inside the folder, no symlink, no file in the way, folder writable) |
| `piper/lib/core.js` | 446-461 | `checkPlan`: refuses two parts on one path and a file where another part needs a folder |
| `piper/lib/core.js` | 463-613 | `saveResult` (text, images, audio, resources; the whole write plan checked before the first write; `opts.trusted`, `opts.server`) |
| `piper/lib/core.js` | 615-620 | `buildStub` |
| `piper/lib/core.js` | 622-658 | state files under `MCP_PIPER_STATE_DIR` or the system temp folder, swept after 24 hours |
| `piper/lib/mermaid.js` | 18-51 | `MCP_PIPER_MERMAID` and `MCP_PIPER_MERMAID_WAIT_MS`, `mermaidLiveUrl` (JSON, zlib level 9, base64url without padding) and `decodeMermaidUrl` |
| `piper/lib/mermaid.js` | 53-146 | the fence scanner: `scanLine` tracks fences of every language so a mermaid opener inside a `markdown` fence is content, `closeFence` links a non-empty body, `scanDelta` inserts links per batch, carries a stray partial line, and links a fence still open at `final` |
| `piper/lib/mermaid.js` | 148-203 | per-batch state files under `<state dir>/mermaid/`: `takePrevState` (wait, read, delete, `{lost: true}` on timeout), `putState` (temp file, then rename), `sweepMermaidState` (24 hours, run on batch 0 only) |
| `piper/lib/mermaid.js` | 205-235 | `processBatch`: the single-call fast path, lost propagation, and a `{lost: true}` hand-on when a batch throws |

`claude.js` is the only file that speaks the hook payload format. One leak:
`saveResult` in `core.js` reads the text Claude Code puts in a result in place
of image and resource blocks (`[Image: source: ...]`, `[Resource from ...]`).
Which folders those lines may point into and which server's headers count
come from `claude.js` (`toolResultsFolders`, `serverMatcher`) as
`opts.trusted` and `opts.server`. A second harness would get its own adapter
next to it.

## Tests

- `cd piper && npm test` runs `test/core.test.js`, `test/claude.test.js` and
  `test/mermaid.test.js` only; the mermaid tests spawn the real bin, including
  two concurrent batches finishing out of order.
  The script names `test/*.test.js` on purpose so the lab runs below are never
  picked up.
- `piper/test/lab/run-nested.mjs` starts real nested `claude -p` sessions with
  this repo as the plugin and `piper/test/lab/server.js` as a stdio MCP server,
  then checks the transcripts. It costs model calls, so it is run by hand; see
  the header comment of `run-nested.mjs` for its options.

## The rule

A hook must never break the call it watches, and a literal `@file:` or `@dir:` must never
reach a server. When the two pull apart, deny the call with a reason starting
`mcp-piper:`; otherwise pass it through untouched. The mermaid hook only
changes what is on screen, so for it every failure means printing nothing.
