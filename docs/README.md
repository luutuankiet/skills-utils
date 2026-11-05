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
| [mcp-piper](architecture/mcp-piper.md) | where mcp-piper expands @file pointers, handles _save_to, saves a tool result and builds the stub, carries state between the pre and post hooks, wires the Claude Code hooks, and runs doctor or the nested lab tests | 2026-11-05 |
| [peek](architecture/peek.md) | where peek decides local, ssh or git mode, finds the repository root, resolves @ imports, lists skills, caches clones, or prints the README fallback for a repo with no agent context | 2026-11-05 |

## Traps

Failure modes that produce no error message, indexed by the symptom you
would observe. Read before debugging behaviour that is wrong but not
crashing.

_No pages yet._

## Reference

Simply true, and expensive to re-derive.

_No pages yet._

## Decisions

Why the repo is the way it is. A merged decision is immutable -- supersede
it with a new one rather than editing it.

- [Agent context lives in AGENTS.md and docs/, not in the README](adr/0001-agent-context-in-agents-md-and-docs.md)

<!-- END GENERATED INDEX -->
