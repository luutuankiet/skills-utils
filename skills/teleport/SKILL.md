---
name: teleport
description: Load another repository's always-on context — its CLAUDE.md/AGENTS.md and skill list — as if the session had started inside it. Use before reading, exploring or reasoning about files in a repository other than the current working directory.
---

# Teleport

A session only preloads the context of the directory it was spawned in. Reaching
into a repository next door otherwise costs a listing plus several speculative
reads before you know what is there.

```bash
<this skill's base directory>/bin/teleport.sh <path> [<path> ...]
```

A path may be a **file** as easily as a directory, and it may be any depth inside
the repository — the canonical root is resolved for you and printed as `ROOT:`.
Pass several paths at once rather than calling repeatedly.

Read the output, then decide what to open. Relative links in it resolve against
`ROOT:`, never against your working directory.
