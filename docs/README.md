# Documentation

Every page here is written for a maintainer six months from now who opened
exactly this file from a search result and has nothing else loaded.

This index is generated. Run `scripts/gen-docs-index.sh` after adding or
renaming a page; `--check` fails if it is stale.

<!-- BEGIN GENERATED INDEX -- edit the pages, not this block -->

## Where things live

One page per area of the system. Read before going looking for where
something is implemented.

| page | covers | verified |
|---|---|---|
| [mcp-piper](architecture/mcp-piper.md) | where mcp-piper expands @file pointers, routes worktree agents' Read, Write, Edit and Bash through ~/.piper/abs staging paths, handles _save_to, saves a tool result and builds the stub, carries state between the pre and post hooks, adds mermaid.live links under mermaid blocks on screen, wires the Claude Code hooks, and runs doctor or the nested lab tests | 2026-11-11 |
| [peek](architecture/peek.md) | where peek decides local, ssh or git mode, lists nested agent context for the session-start hook, finds the repository root, resolves @ imports, lists skills, caches clones, or prints the README fallback for a repo with no agent context | 2026-11-10 |

## Traps

Failure modes that produce no error message, indexed by the symptom you
would observe. Read before debugging behaviour that is wrong but not
crashing.

| symptom | page | area | verified |
|---|---|---|---|
| an Edit on a ~/.piper/abs staging path fails with "File content has changed since it was last read", although the agent did not touch the file | [edit-on-staging-path-changed-since-read](traps/edit-on-staging-path-changed-since-read.md) | mcp-piper | 2026-11-11 |

## Reference

Simply true, and expensive to re-derive.

_No pages yet._

## Decisions

Why the repo is the way it is. A merged decision is immutable -- supersede
it with a new one rather than editing it.

- [Agent context lives in AGENTS.md and docs/, not in the README](adr/0001-agent-context-in-agents-md-and-docs.md)
- [mcp-piper moves bytes; servers understand formats](adr/0002-mcp-piper-moves-bytes-not-formats.md)
- [Mermaid diagrams get a display-only editor link, built offline, inside mcp-piper](adr/0003-mermaid-links-are-display-only.md)
- [Worktree agents write elsewhere through a full-path staging folder, with Edit replayed](adr/0004-worktree-writes-go-through-a-full-path-staging-folder.md)

<!-- END GENERATED INDEX -->
