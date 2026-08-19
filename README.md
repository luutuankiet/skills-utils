# skills-utils

Small agent-facing utilities, published as one Claude Code plugin.

## teleport

An agent session preloads the context of exactly one directory: the one it was
spawned in. Every other repository on the disk is opaque to it. Asking about one
costs a directory listing, then several speculative reads, before the agent even
knows whether the answer is there.

`teleport` prints what that repository's own Level 0 would have been:

- the contract file — `CLAUDE.md` and `AGENTS.md` — with `@` imports resolved
  in place and deduplicated, because on a real repository `CLAUDE.md` is often
  nothing but a single `@AGENTS.md` pointer, and a pointer the caller cannot
  follow is worse than silence
- the `name` and `description` of every skill the repository ships, from both
  `.claude/skills/` and a plugin's `skills/`

Nothing else. Skill bodies, `docs/` indexes and READMEs are deliberately absent:
each would multiply the cost, and each is one read away once the map says it is
worth reading. That is the whole point of a progressive ladder — this utility
prints rung zero and lets the caller decide whether to climb.

```bash
skills/teleport/bin/teleport.sh ~/dev/some-repo ~/dev/another/deep/file.ts
```

**The path can be wrong and still work.** A file three levels down resolves to
its repository root; the nearest ancestor holding a contract file wins, with the
git boundary as tie-break, and the walk never escapes the repository it was
pointed at. Point it at the repository you are already in and it says so instead
of billing you twice for context you already have.

Exit `0` when a Level 0 was found *or* confidently absent — absence is an answer,
not a failure. `2` on a bad argument, `3` when no given path exists at all.

Dependency-free bash and awk, on purpose. A utility that needs installing before
it can save a few tokens has already lost.

## Install

Available through the `context-lab` marketplace. The skill then resolves as
`skills-utils:teleport`.
