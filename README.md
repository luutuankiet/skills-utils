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

## mcp-piper

An agent using MCP tools pays twice for files. To send a file it already has on
disk, it pastes the whole file into the tool call. To keep a large or binary
result, it reads the whole result first. Both put bytes into the context that
the agent never needed to see.

mcp-piper is a pair of Claude Code hooks on every MCP tool (`mcp__.*`) that
removes both, for any server, claude.ai connectors included, with no change to
the server:

- **Upload.** A string argument written as `"@file:<path>"` (UTF-8 text) or
  `"@file64:<path>"` (base64) is replaced by the file's contents before the
  server sees the call, at any depth in the arguments. `@@file:` sends the
  literal text with one `@` removed.
- **Download.** A top-level `"_save_to": "<path>"` is removed before the server
  sees the call; the result is saved to that path (images to files beside it)
  and the agent gets a short stub with paths, sizes and hashes instead.
- **Mermaid links.** A display-only hook adds `↳ open diagram N` under every
  mermaid block in an assistant message, linking to the diagram in the
  mermaid.live editor. The model never sees it; `MCP_PIPER_MERMAID=0` turns
  it off.

Both are opt-in per call; a call with neither runs untouched. A pointer to a
missing file, a folder or an unreadable file, and a `_save_to` that cannot be
written, stop the call with a reason starting `mcp-piper:`. Links in a result
are never followed. A session and every subagent get a four-line note telling
the model the two moves exist; the `mcp-piper` skill has the details.

The hooks live in `hooks/hooks.json` and run `piper/bin/mcp-piper.js` from the
plugin folder, so the host needs only `node` 18 or newer. The same code is
published as `@luutuankiet/mcp-piper`; `npx @luutuankiet/mcp-piper doctor`
checks an install. See `piper/README.md`.

## Install

The skill is available through the `context-lab` marketplace and resolves as
`skills-utils:peek`. It calls the npm package `@luutuankiet/peek`, so the host
needs `node` and `bash`; there is nothing else to install. Installing the plugin
also registers the mcp-piper hooks and the `skills-utils:mcp-piper` skill.

## Releasing

Bump `cli/package.json`, then push a matching `vX.Y.Z` tag. For mcp-piper, bump
`piper/package.json` and push a matching `piper-vX.Y.Z` tag.
`.github/workflows/release.yml` tests and publishes the matching package to npm
through trusted publishing, without a token.
