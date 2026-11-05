---
title: mcp-piper
covers: where mcp-piper expands @file pointers, handles _save_to, saves a tool result and builds the stub, carries state between the pre and post hooks, wires the Claude Code hooks, and runs doctor or the nested lab tests
verified: 2026-11-05
---

# mcp-piper

mcp-piper is a set of Claude Code hooks on every MCP tool (`mcp__.*`). Before a
call, a string argument written as `"@file:<path>"` or `"@file64:<path>"` is
replaced by the file's contents, and `"@dir:<path>"` / `"@dir64:<path>"` by an
object mapping each relative path in the folder to its contents. After a call
that carried a top-level `"_save_to": "<path>"`, the result is written to disk
(into a folder when the path ends in `/`, where embedded resources with a
relative `uri` land at `<folder>/<uri>`) and the agent gets a short stub
instead. It ships inside this plugin (hooks in `hooks/hooks.json`, skill in
`skills/mcp-piper/SKILL.md`) and as the npm package `@luutuankiet/mcp-piper`
from `piper/`.

Line numbers below are a starting point, not an address. Jump roughly there and
confirm by what the code says; if a range is off by more than a screen, fix it
here and re-date the page.

## The path of one call

1. `hooks/hooks.json` runs `node "${CLAUDE_PLUGIN_ROOT}/piper/bin/mcp-piper.js" hook <event>`
   for `PreToolUse`, `PostToolUse` and `PostToolUseFailure` on `mcp__.*`, and for
   `SessionStart` and `SubagentStart` with no matcher.
2. `piper/bin/mcp-piper.js` reads the payload from stdin and calls the matching
   handler in `piper/lib/claude.js`.
3. `pre` expands pointers and strips `_save_to` through `piper/lib/core.js`,
   returns `updatedInput`, and writes a state file keyed by `tool_use_id` when
   the post hook will need to act.
4. `post` reads that state file, saves the result, replaces the tool output with
   the stub, and deletes the state file. `failure` only deletes it.

## Where things live

| file | lines | what lives there |
|---|---|---|
| `piper/bin/mcp-piper.js` | 28-58 | `runHook`: stdin parse, dispatch, and the rule that an internal error denies the call only when it involved a pointer or `_save_to` |
| `piper/bin/mcp-piper.js` | 60-133 | `doctor`: checks the node version, looks for `hooks/hooks.json` next to the package, dry-runs a pointer through `pre`, and checks the state folder is writable |
| `piper/lib/claude.js` | 11-48 | the three behaviour settings (`DECISION_WHEN_CHANGED`, `NUDGE_ROUTE`, `SAVE_ERROR_RESULTS`) with the reason for each default, and the session note text |
| `piper/lib/claude.js` | 76-102 | `toolResultsFolders` (the only folders a result may name a file in, from `transcript_path`) and `serverMatcher` (whose resource headers place files, from `mcp_server.name` or the tool name) |
| `piper/lib/claude.js` | 118-162 | `pre` handler, including the fast path for calls with nothing to do |
| `piper/lib/claude.js` | 164-224 | `post` (passes the two above to `saveResult`), `failure`, `sessionStart`, `subagentStart`, and the `HANDLERS` table |
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

`claude.js` is the only file that speaks the hook payload format. One leak:
`saveResult` in `core.js` reads the text Claude Code puts in a result in place
of image and resource blocks (`[Image: source: ...]`, `[Resource from ...]`).
Which folders those lines may point into and which server's headers count
come from `claude.js` (`toolResultsFolders`, `serverMatcher`) as
`opts.trusted` and `opts.server`. A second harness would get its own adapter
next to it.

## Tests

- `cd piper && npm test` runs `test/core.test.js` and `test/claude.test.js` only.
  The script names `test/*.test.js` on purpose so the lab runs below are never
  picked up.
- `piper/test/lab/run-nested.mjs` starts real nested `claude -p` sessions with
  this repo as the plugin and `piper/test/lab/server.js` as a stdio MCP server,
  then checks the transcripts. It costs model calls, so it is run by hand; see
  the header comment of `run-nested.mjs` for its options.

## The rule

A hook must never break the call it watches, and a literal `@file:` or `@dir:` must never
reach a server. When the two pull apart, deny the call with a reason starting
`mcp-piper:`; otherwise pass it through untouched.
