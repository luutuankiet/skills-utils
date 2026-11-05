# skills-utils

Small agent-facing utilities, shipped as one Claude Code plugin and as two npm
packages from the same tree:

- **peek** (`cli/`, `@luutuankiet/peek`, skill `skills/peek/`): prints another
  repository's always-on agent context from a local path, an ssh host or a git URL.
- **mcp-piper** (`piper/`, `@luutuankiet/mcp-piper`, skill `skills/mcp-piper/`,
  hooks `hooks/hooks.json`): hooks on every MCP tool call. `"@file:<path>"` sends
  a file as an argument; `"_save_to": "<path>"` saves the result to disk.

## Hard constraints

- **Ships unbundled.** The plugin and npm run `bin/` and `lib/` as they are.
- **`cli/lib/peek.sh` is bash and awk only**, and never reads stdin: ssh mode
  pipes it to hosts that may have nothing else.
- **A mcp-piper hook never breaks the call it watches.** An unexpected error
  passes the call through, unless it carries a pointer or `_save_to`; then it is
  denied with a reason starting `mcp-piper:`.
- **`skills/` ships to plugin users; `.claude/skills/` is for agents in this repo.**

## Layout

```
.claude-plugin/plugin.json  plugin manifest, lists shipped skills
hooks/hooks.json            mcp-piper hooks, run with node
cli/bin/peek.js             picks local, ssh or git mode
cli/lib/peek.sh             the peeking itself
cli/lib/modes.js            target detection, clone cache
piper/bin/mcp-piper.js      hook <event>, doctor
piper/lib/core.js           pointer expansion, result saving
piper/lib/claude.js         Claude Code hook adapter
piper/test/lab/             nested real sessions, cost model calls
.github/workflows/release.yml  npm publish on vX.Y.Z / piper-vX.Y.Z
```

## Commands

```
cd cli && npm test      # no network
cd piper && npm test    # unit tests only, never the lab runs
node piper/test/lab/run-nested.mjs --list   # by hand, costs model calls
scripts/gen-docs-index.sh [--check]
```

No type checker, no build step. Release: bump the package's `package.json`,
push the matching tag.

<!-- Standard block. Everything above belongs to this project; everything below is
     the pointer every repo laid out this way carries. -->

## Documentation

Indexed in [docs/README.md](docs/README.md). Every page is self-contained: it
assumes you opened that one file and have nothing else loaded.

| where | what | read it |
|---|---|---|
| [architecture/](docs/architecture/) | where behaviour lives, one page per area | before going looking for something |
| [traps/](docs/traps/) | failure modes with no error message, indexed by symptom | before debugging something wrong but not crashing |
| [reference/](docs/reference/) | simply true, expensive to re-derive | when you need the detail |
| [adr/](docs/adr/) | why the repo is the way it is | before changing something that looks odd |

## Before you wrap up

Leave the repo holding what this session cost you to find out. Four rules.

1. **Sort it, and expect most of it to go nowhere.** A next action is an issue. A
   durable, expensive-to-re-derive fact is a page. A choice that was hard to
   reverse, surprising without context and a real trade-off is a decision record
   under `docs/adr/`. Status, dates, version pins and plans are none of those;
   delete them.
2. **A doc is the last resort.** Type error, then test, then comment at the site,
   then doc. Name the single line you would have commented instead; if you can
   name it, comment it and stop.
3. **Verify against running code before writing, and date the page `verified:`.**
   Anything remembered from earlier in the session is stale until re-read.
   Deleting a draft because the problem is already fixed is a success.
4. **Append, never rewrite.** Supersede a merged decision record with a new one
   naming what it replaces. A trap filename is an identifier quoted elsewhere:
   edit the body, never the name.

Then run `scripts/gen-docs-index.sh`. Never hand-maintain an index.
