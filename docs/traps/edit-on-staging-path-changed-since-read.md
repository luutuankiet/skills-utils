---
symptom: an Edit on a ~/.piper/abs staging path fails with "File content has changed since it was last read", although the agent did not touch the file
area: mcp-piper
verified: 2026-11-11
---

# Edit on a staging path: "File content has changed since it was last read"

## What you see

An agent Reads a file through a staging path (`~/.piper/abs/<absolute path>`),
edits it once successfully, then a second Edit on the same staging path fails:

```
File content has changed since it was last read. This commonly happens when a
linter or formatter run via Bash rewrites the file. Call Read on this file to
refresh, then retry the edit.
```

## Why

Claude Code remembers each file's mtime from the last Read or Edit and refuses
an Edit when the mtime has moved. The staging copy has a second writer:
piper's PostToolUse hook in `piper/lib/abs.js` (`handlePost`), which copies the
real target back into the staging file after an Edit whenever the two differ.
They differ only when someone else changed the target between the agent's Read
and its Edit (another agent, a script, the user). The edit itself still landed
on the target along with the other change; only the staging file's mtime moved.

Piper avoids this in every other case: it never writes the staging file before
the tool runs, and after the tool it copies only when the contents differ.

## What to do

Nothing is lost. Read the staging path again, then retry the Edit. The deny
reasons piper writes say the same. If an agent keeps hitting it, two writers
share one file; give each agent its own file.
