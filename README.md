# skills-utils

Small agent-facing utilities, published as one Claude Code plugin.

## peek

An agent session preloads the context of exactly one directory: the one it was
spawned in. Every other repository on the disk is opaque to it. Asking about one
costs a directory listing, then several speculative reads, before the agent even
knows whether the answer is there.

`peek` prints what that repository's own Level 0 would have been:

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
npx -y @luutuankiet/peek ~/dev/some-repo ~/dev/another/deep/file.ts
npx -y @luutuankiet/peek myhost:/srv/app                 # over ssh
npx -y @luutuankiet/peek https://github.com/owner/repo   # shallow clone
```

**Three places to look, one script.** A local path is read in place. A
`host:path` target pipes the same bash script to the host over `ssh`, so the
host needs nothing but bash, and `ROOT:` comes back as `host:/path`. A git URL
(https, ssh, or a GitHub `/tree/<ref>/<subdir>` link) is cloned with
`--depth 1 --filter=blob:none` into `~/.cache/peek/`. Peeking the same repo and
ref again within 30 minutes reuses that clone and restarts its 30 minutes. A CLI
that exits has no timer, so expired clones are deleted at the start of the next
peek run, and only folders peek marked as its own. `PEEK_CACHE_DIR` and
`PEEK_TTL_MIN` override the folder and the 30 minutes.

**The path can be wrong and still work.** A file three levels down resolves to
its repository root; the nearest ancestor holding a contract file wins, with the
git boundary as tie-break, and the walk never escapes the repository it was
pointed at. Point it at the repository you are already in and it says so instead
of billing you twice for context you already have.

**A repository with no agent context still gets a first look.** With no
contract file and no skills, the absence alone would cost the agent its next
three calls (`ls`, the README, `ls src`), so peek prints those answers itself:
the README's first 80 lines, each manifest's first 25, and a two-level tree of
tracked files. A folder that is not a git repository yet is handled the same
way, rooted at the nearest folder holding a README or a manifest. Names that may
hold key material (`.env*`, `*.pem`, `id_rsa`, anything with secret, token or
credential in it) are never listed.

Exit `0` when a Level 0 was found *or* confidently absent — absence is an answer,
not a failure. `2` on a bad argument, `3` when no given path exists at all.

The peeking itself is dependency-free bash and awk (`cli/lib/peek.sh`), on
purpose: it is the one piece that may have to run on a host with nothing else
installed. The npm package is a thin Node entry point in front of it.

## Install

The skill is available through the `context-lab` marketplace and resolves as
`skills-utils:peek`. It calls the npm package `@luutuankiet/peek`, so the host
needs `node` and `bash`; there is nothing else to install.

## Releasing

Bump `cli/package.json`, then push a matching `vX.Y.Z` tag.
`.github/workflows/release.yml` tests and publishes it to npm through trusted
publishing, without a token.
