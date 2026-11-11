# Worktree agents write elsewhere through a full-path staging folder, with Edit replayed

Claude Code refuses Write, Edit and NotebookEdit from an agent isolated in a
git worktree (a subagent started with worktree isolation, or a session started
with `claude --worktree`) when the path is in the main checkout or in any other
worktree of the repo, the orchestrator's own worktree included. The refusal
runs before any hook, re-checks a hook's `updatedInput`, follows symlinks and
cannot be turned off. Paths outside the repo are allowed. An orchestrator that
keeps a plan or a board in its own checkout therefore cannot have its
subagents write reports back there with the file tools, and Edit is the tool an
agent wants, because it already knows the exact lines from its Read.

## Decision

1. **A staging path is a fixed root followed by the full absolute target:**
   `~/.piper/abs/home/me/repo/tmp/board.md` stands for
   `/home/me/repo/tmp/board.md`. `PIPER_ABS_ROOT` moves the root. The root is a
   real folder outside every repo, so the guard allows it, and the file exists
   on disk, which Edit checks before any hook runs. Encoding the whole path
   means piper never guesses a "project root". That guess cannot be made: from
   any worktree, git points at the main checkout rather than at the
   orchestrator's worktree, and no hook field names the parent session's
   folder. Any absolute target is accepted except one with a `.git` segment or
   a `..` segment.
2. **Hooks on the native tools keep the staging copy and the target in step.**
   Read copies the target in before the tool runs. Write copies the staging
   file out after it runs. Bash commands have staging paths rewritten to the
   real path. These hooks run on every Read, Write, Edit and Bash call, so a
   separate small entry point exits before parsing when the payload does not
   name the root.
3. **Edit is replayed, not copied back.** Before the tool runs, piper checks
   that `old_string` applies to the target as it is now (once, or every time
   with `replace_all`) and denies with a "Read it again" reason if not. After
   the tool has edited the staging copy, piper applies the same replacement to
   the target, then refreshes the staging copy only if the two differ.
   Copying the staging file back over the target would silently lose a change
   another writer made between the agent's Read and its Edit; replay keeps
   both and turns a real conflict into a clean deny. Piper never writes the
   staging file before the tool runs, because a moved mtime makes Claude Code
   refuse the Edit as changed since it was read.
4. **The replay runs after the tool, and piper never sends an allow.** The
   user's own permission rules decide every staging call. Applying the edit
   before the tool would change the target even when the user then rejects the
   permission prompt, and an allow would let any agent write any file on the
   machine without a prompt. Outside bypass mode users add
   `Read(~/.piper/abs/**)` and `Edit(~/.piper/abs/**)`; the Edit rule covers
   Write too.
5. **Agents learn the path from hooks, not from the skill.** A session or
   subagent whose folder is a linked worktree gets two lines at start, and
   piper's deny reasons repeat what to do. Guidance that depends on an agent
   choosing to load a skill does not reach the agents that need it. The hint
   does not explain the mapping: a model told what the prefix maps to resolved
   the real path itself and was refused. There is no failure hook for the
   guard's refusal, because Claude Code raises no failure event for it.

## Consequences

- An agent in a worktree can change any file the user can, through a path
  outside the repo. That is the point, and it is why the permission rules, not
  piper, decide.
- Concurrent Writes to one file: the last one wins. The orchestrator gives each
  agent its own file. Concurrent Edits are handled by the replay.
- After a race, the staging copy is refreshed and its mtime moves, so the
  agent's next Edit without a Read is refused by Claude Code until it reads
  again.
