---
name: codebase-map
description: Where behaviour lives in skills-utils (peek and mcp-piper), a per-area map of which files and line ranges own what, so you can open the right file instead of searching for it. Use before hunting for where something is implemented, before adding a feature that touches existing behaviour, and when a change seems to need edits in more places than expected.
---

# Where things live

This repo ships two tools, peek (`cli/`) and mcp-piper (`piper/`), each split
across a Node entry point and a library. The pages below are maps: for each
tool, which files own which behaviour and roughly where in them.

**Pick the area, open that one page, then go straight to the file.** Do not read
every page; that defeats the point.

<!-- BEGIN GENERATED INDEX -- edit the pages, not this block -->

## Where things live

One page per area of the system. Read before going looking for where
something is implemented.

| page | covers | verified |
|---|---|---|
| [mcp-piper](../../../docs/architecture/mcp-piper.md) | where mcp-piper expands @file pointers, routes worktree agents' Read, Write, Edit and Bash through ~/.piper/abs staging paths, handles _save_to, saves a tool result and builds the stub, carries state between the pre and post hooks, adds mermaid.live links under mermaid blocks on screen, wires the Claude Code hooks, and runs doctor or the nested lab tests | 2026-11-11 |
| [peek](../../../docs/architecture/peek.md) | where peek decides local, ssh or git mode, lists nested agent context for the session-start hook, finds the repository root, resolves @ imports, lists skills, caches clones, or prints the README fallback for a repo with no agent context | 2026-11-10 |

<!-- END GENERATED INDEX -->

The same table, browsable, is [docs/README.md](../../../docs/README.md).

## How to read a line range

Every entry is `file - lines - what lives there`. **The line numbers are a
starting point, not an address.** They drift with every commit that touches the
file above them, and nothing regenerates them.

So: jump to roughly that line, then confirm you are in the right place by what the
code says, not by the number. If a range is off by more than a screen or two, fix
it in the page and re-date it; that is a one-line edit and it is how the map
stays worth having.

Line ranges are given at all because the two files that matter most are each
close to 400 lines: `piper/lib/core.js` (391) and `cli/lib/peek.sh` (383).
"It's in core.js" is not an answer.

## What this map does not tell you

It tells you **where**, not **why it is dangerous**. Failure modes that produce
no error message are catalogued separately, by symptom, in the
`repo-maintenance` skill and in [docs/README.md](../../../docs/README.md). If you
are about to change the mcp-piper `pre` hook (it runs on every MCP tool call of
every session that has the plugin) or anything `peek.sh` does over ssh, look
there first.

## Keeping it accurate

A map that lies is worse than none, because it sends people confidently to the
wrong file. Two habits keep it honest:

- **Re-date what you touch.** If you worked in an area and the page was right,
  bump `verified:`. If it was wrong, fix it and bump.
- **Add an area when you create one, not later.** A new tool or subsystem with no
  page is invisible; the next person re-derives its shape from scratch.

To add a page, follow the same rules as any other doc; see the `repo-maintenance`
skill. Frontmatter for an area page is `title`, `covers` (what someone would be
looking for, phrased as they would phrase it), and `verified`. Then run
`scripts/gen-docs-index.sh`; the block above is generated and hand edits to it
are overwritten.
