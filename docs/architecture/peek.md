---
title: peek
covers: where peek decides local, ssh or git mode, lists nested agent context for the session-start hook, finds the repository root, resolves @ imports, lists skills, caches clones, or prints the README fallback for a repo with no agent context
verified: 2026-11-08
---

# peek

peek prints what another repository's always-on agent context would have been:
its `CLAUDE.md` and `AGENTS.md` with `@` imports resolved in place, and the
`name` and `description` of every skill under `.claude/skills/` and `skills/`.
It is published as `@luutuankiet/peek` from `cli/` and wrapped by the shipped
skill `skills/peek/SKILL.md`.

Line numbers below are a starting point, not an address. Jump roughly there and
confirm by what the code says; if a range is off by more than a screen, fix it
here and re-date the page.

## Two layers

The Node entry point only decides *where* the repository is. The bash script
decides *what to print*. The split is deliberate: in ssh mode the same bash file
is piped to the remote host, which may have nothing but bash.

| file | lines | what lives there |
|---|---|---|
| `cli/bin/peek.js` | 82-121 | `main`: `--nested` goes straight to the script; otherwise parse arguments, `detect` each target, sweep expired clones, dispatch per mode |
| `cli/bin/peek.js` | 53-81 | `peekSsh` (pipe `peek.sh` over `ssh`) and `peekGit` (clone, then run locally) |
| `cli/lib/modes.js` | 22-53 | `detect` (local, `host:path` or git URL) and `parseGitUrl`, including GitHub `/tree/<ref>/<subdir>` links |
| `cli/lib/modes.js` | 54-139 | clone cache under `~/.cache/peek/`: key, TTL (`PEEK_CACHE_DIR`, `PEEK_TTL_MIN`), `sweep`, `ensureClone` |
| `cli/lib/modes.js` | 140-166 | `sshForm` and `gitClone`: an https clone that is refused is retried as `git@host:owner/repo.git` |
| `cli/lib/peek.sh` | 25-31 | the one list of vendored and build directories that every scan prunes |
| `cli/lib/peek.sh` | 46-94 | resolution: `realdir`, `find_root` (nearest contract file wins, git root is the tie-break), `suggest_children` |
| `cli/lib/peek.sh` | 95-181 | payload: `emit_file` resolves `@` imports with dedupe, `emit_skills` reads skill frontmatter |
| `cli/lib/peek.sh` | 182-297 | fallback for a repo with no agent context: README head, manifest heads, a two-level tree of tracked files, with secret-shaped names withheld |
| `cli/lib/peek.sh` | 298-513 | `--nested`: walk with `rg` or pruned `find` under a background kill timer (`PEEK_NESTED_BUDGET_MS`, `PEEK_NESTED_ENGINE`), one `git ls-files` call for the tags, rank, preview |
| `hooks/nested-context.mjs` | all | the hook wrapper: reads `cwd` and the event from stdin, runs `peek.sh --nested`, prints hook JSON or nothing |
| `cli/lib/peek.sh` | 514-608 | main: per target, find the root, refuse to re-print the caller's own repo, emit or explore |

## Tests

`cli/test/modes.test.js` covers the Node layer; `cli/test/local.test.js` runs
`bin/peek.js` end to end against fixture folders it builds in a temp directory. Run `npm test` from `cli/`.

## The rule

Keep the bash file free of dependencies and of stdin reads, and keep exactly one
copy of any list both layers need. Two copies of the prune list once let a
vendored `SKILL.md` print as if the repository shipped it.
