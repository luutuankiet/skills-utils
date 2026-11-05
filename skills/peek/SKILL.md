---
name: peek
description: Load another repository's always-on context — its CLAUDE.md/AGENTS.md and skill list — as if the session had started inside it. Use before reading, exploring or reasoning about files in a repository other than the current working directory.
---

# Peek

A session only preloads the context of the directory it was spawned in. Reaching
into a repository next door otherwise costs a listing plus several speculative
reads before you know what is there.

```bash
npx -y @luutuankiet/peek@latest <target> [<target> ...]
```

| target | what happens |
|---|---|
| `/any/path/inside/a/repo` | read on this machine |
| `host:/path` or `host:~/path` | the script is piped over `ssh`; the host needs only bash |
| `https://github.com/owner/repo` or `git@github.com:owner/repo.git` | shallow clone into a cache, then read |
| `https://github.com/owner/repo/tree/<ref>/<subdir>` | the same, at that branch, starting from that folder |

A path may be a **file** as easily as a directory, and it may be any depth inside
the repository — the canonical root is resolved for you and printed as `ROOT:`.
Pass several targets at once rather than calling repeatedly. `--ssh` or `--git`
before a target forces the mode when the guess would be wrong.

Read the output, then decide what to open. Relative links in it resolve against
`ROOT:`, never against your working directory.

- **`ROOT: host:/path`** means the files are on that host. Open them with
  `ssh host cat /path/FILE`, not your own Read tool.
- **A clone's `ROOT:`** is an ordinary local folder under `~/.cache/peek/`. Read it
  directly. It is deleted 30 minutes after its last peek, so peek the URL again
  rather than trusting an old path. Private repositories use your own git
  credentials; https falls back to ssh on its own, and a clone that fails
  prints `CLONE FAILED` with both reasons.
- **No agent context at all** (no contract, no skills, git or not): the output
  carries the README's first 80 lines, the manifests and a two-level file tree
  instead. That is your first exploration already done; don't repeat it with
  `ls`. Files that may hold secrets (`.env*`, keys) are never listed.

The host needs `node` and `bash`. If `npx` itself is missing, say so rather than
reconstructing the output by hand: a guessed Level 0 is worse than none.
