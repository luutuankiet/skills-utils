# Agent context lives in AGENTS.md and docs/, not in the README

When mcp-piper joined peek, the only description of either tool was the
user-facing `README.md`, and this repository had no `CLAUDE.md` or `AGENTS.md`,
so an agent opening it (or peeking it from outside) found no always-on context.
We added a small `AGENTS.md` (what the repo is, hard constraints, layout, real
commands), a one-line `CLAUDE.md` importing it, one architecture page per tool
under `docs/architecture/`, and a generated index (`scripts/gen-docs-index.sh`)
that also fills the two repo-local skills in `.claude/skills/`.

## Considered options

- **Keep everything in `README.md`.** Rejected: the README is written for
  users installing the plugin, it is not loaded into a session, and line-level
  maps of `peek.sh` or `core.js` would bury what users need.
- **Write trap and reference pages up front.** Rejected for now: the code
  already explains its own sharp edges in comments at the site (for example the
  three behaviour settings at the top of `piper/lib/claude.js`), and the one
  historical trap found in the git history, `npm test` picking up the paid lab
  runs, is fixed in `piper/package.json`. `docs/traps/` and `docs/reference/`
  start empty and fill when a real symptom costs someone time.

## Consequences

The index in `docs/README.md` and the generated blocks in both repo-local
skills are output of `scripts/gen-docs-index.sh`; edit the pages and rerun it,
never the index.
