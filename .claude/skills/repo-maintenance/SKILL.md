---
name: repo-maintenance
description: skills-utils keeps a catalogue of its own traps (failure modes in peek or mcp-piper that produce no error, so you find them by symptom, not by stack trace) plus its reference pages and its decision records. Use before debugging behaviour that is wrong but not crashing, before editing the mcp-piper hooks or the peek script, and whenever you finish debugging something that cost more than an hour.
---

# Traps in this repo

What costs time here usually fails **silently**: a hook that quietly leaves a
call unchanged, a peek that prints the wrong repository's context. There is no
stack trace to search, so the catalogue below is keyed on **the symptom you would
observe**, not on the file at fault.

**Before you debug anything that misbehaves without erroring, scan this table.**
Then open exactly one file. Each page is self-contained; you will not need to
open a second one.

<!-- BEGIN GENERATED INDEX -- edit the pages, not this block -->

## Traps

Failure modes that produce no error message, indexed by the symptom you
would observe. Read before debugging behaviour that is wrong but not
crashing.

| symptom | page | area | verified |
|---|---|---|---|
| an Edit on a ~/.piper/abs staging path fails with "File content has changed since it was last read", although the agent did not touch the file | [edit-on-staging-path-changed-since-read](../../../docs/traps/edit-on-staging-path-changed-since-read.md) | mcp-piper | 2026-11-11 |

## Reference

Simply true, and expensive to re-derive.

_No pages yet._

## Decisions

Why the repo is the way it is. A merged decision is immutable -- supersede
it with a new one rather than editing it.

- [Agent context lives in AGENTS.md and docs/, not in the README](../../../docs/adr/0001-agent-context-in-agents-md-and-docs.md)
- [mcp-piper moves bytes; servers understand formats](../../../docs/adr/0002-mcp-piper-moves-bytes-not-formats.md)
- [Mermaid diagrams get a display-only editor link, built offline, inside mcp-piper](../../../docs/adr/0003-mermaid-links-are-display-only.md)
- [Worktree agents write elsewhere through a full-path staging folder, with Edit replayed](../../../docs/adr/0004-worktree-writes-go-through-a-full-path-staging-folder.md)

<!-- END GENERATED INDEX -->

The same tables, browsable, are [docs/README.md](../../../docs/README.md).

## Adding a trap

Write one when you have just spent real time on something that would have taken
minutes if someone had told you. Three tests, all must pass:

1. **It has a symptom.** If a fact is merely true, it is reference, not a trap.
   *If it has a symptom it is a trap; if it is just true it is reference.*
2. **Nothing cheaper catches it.** A doc is the *last* resort, because it only
   works if someone reads it. Stop at the first rung that holds:

   | rung | use when | this repo |
   |---|---|---|
   | make it a **type error** | the mistake is expressible in the type system | none: plain JavaScript and bash, no type checker |
   | make it a **test** | the mistake is an assertable behaviour | `cd cli && npm test`, `cd piper && npm test` (node's built-in runner); real hook behaviour in Claude Code: `node piper/test/lab/run-nested.mjs`, by hand, costs model calls |
   | **comment at the site** | there is exactly one line where someone could get it wrong | the norm here; see the three behaviour settings at the top of `piper/lib/claude.js`, each saying what the other values would do |
   | **a doc** | the mistake can be made from any of several files, or from a file that does not exist yet | the catalogue above |

   Before adding one, say out loud which single line you would have commented
   instead; if you can name it, comment it and stop.
3. **It is not already in the table.** Extend the existing file. Two docs on one
   fact is how a catalogue rots.

Then:

- **Filename is the identifier.** `SCREAMING_SNAKE.md`, describing the symptom,
  not the fix. It is quoted in code comments and commit messages, so it never
  gets renamed; if the understanding changes, edit the body.
- **`symptom:` is the search key.** The string a frustrated person would paste
  into a search box, not a topic name. If something prints a message (a
  `mcp-piper:` deny reason, a peek error line), put that text in verbatim.
- **Date it.** `verified:` is the day someone last confirmed it in the running
  code. An undated trap is a claim with no expiry.
- **Regenerate the index**: `scripts/gen-docs-index.sh`. The block above is
  generated; hand edits to it are overwritten.

## Writing the body

The reader is a maintainer six months from now who opened this one file from a
search result and has **no other context loaded**. Not you, not this session.

- Resolve every reference inline. No "see the other doc", no ticket numbers, no
  "as discussed". If a line number matters, quote the code.
- Publishing tone. It is a page on the project's documentation site, not a note
  to self.
- Lead with the symptom, then the mechanism, then the fix, then how to verify.
  Someone in the middle of a bug reads the first two lines and stops.
- Include the **evidence**: measured numbers, observed values, verbatim code. A
  trap without evidence gets argued with.
- **Say what is deliberate.** Half of what looks like a bug in a mature codebase
  is a trade someone made on purpose. Write down which, and what the trade was.

## The other collections

`docs/` holds five kinds of page, all generated into the same index by the same
script, all governed by the rules above:

| directory | what belongs there | frontmatter |
|---|---|---|
| `docs/traps/` | it has a symptom | `symptom`, `area`, `verified` |
| `docs/architecture/` | where behaviour lives, one page per area | `title`, `covers`, `verified` |
| `docs/reference/` | simply true, no symptom, worth not re-deriving | `title`, `summary`, `verified` |
| `docs/adr/` | **why the repo is the way it is**, a decision record | none; the `# ` heading is the entry |
| `docs/*.md` | a long-form guide belonging to no single area | `title`, `summary`, `verified` |

The architecture pages are the `codebase-map` skill's index; read that skill
before adding one. The escalation ladder does **not** apply to them; a map is not
a warning. Everything else does: date it, resolve references inline, regenerate
the index.

### Decision records

`docs/adr/NNNN-kebab-slug.md`, sequential, created lazily. Offer one only when
**all three** hold:

1. **hard to reverse**: if it is easy to reverse, skip it; you will just reverse it
2. **surprising without context**: otherwise the code explains itself
3. **the result of a real trade-off**: if there was no genuine alternative, there
   is nothing to record beyond "we did the obvious thing"

One to three sentences is a complete record: the context, what was decided, why.

**A merged record is immutable.** Superseding means a *new* file that names what
it replaces; the old one stays readable, because the reason a decision was made is
not invalidated by the decision changing.

This is the one destination that is append-only and unrecoverable. A trap can be
rewritten later; a rationale never written is gone.

## Removing a trap

**Before trusting a page, check it is still true.** These describe code, and code
moves. If the underlying cause is fixed, **delete the file** and say so in the
commit message. Do not leave it with a "fixed in vX" note; a stale trap costs a
reader the same time as a real one, and costs the catalogue its credibility, which
is the only thing making anyone open the next page.
