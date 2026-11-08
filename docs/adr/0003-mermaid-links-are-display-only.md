# Mermaid diagrams get a display-only editor link, built offline, inside mcp-piper

A mermaid block in a Claude Code terminal shows as source text, and a reader has
no quick way to see the diagram. The alternatives considered were rendering the
diagram inline in the terminal, sending it to a hosted renderer or a
whiteboard, and asking the agent to paste a link itself. Inline rendering needs
image support most terminals and tmux setups lack. A hosted renderer uploads
the diagram text. Asking the agent costs context on every message and trusts
the agent to build the URL correctly.

## Decision

1. **A `MessageDisplay` hook adds one line, `↳ [open diagram N](<url>)`, after
   every mermaid fence in every assistant message.** That event changes only
   what is drawn on screen. The transcript and the model's context keep the
   original text, so the agent never sees the link, never has to write it, and
   cannot be confused by it. The line shows a label, never a raw URL; Claude
   Code renders it as an OSC 8 hyperlink.
2. **The URL is the mermaid.live editor, `https://mermaid.live/edit#pako:...`,
   built on the user's machine.** The diagram text is deflated with zlib and
   base64url-encoded into the URL fragment. Nothing leaves the machine until
   the user clicks, and a fragment is not sent to the server even then. The
   editor was chosen over the read-only `/view#` page because the usual next
   step after looking at a diagram is fixing it.
3. **It ships in mcp-piper, on by default, with `MCP_PIPER_MERMAID=0` to turn it
   off.** mcp-piper is already the plugin's hook runner on every host that has
   the plugin, so this needs no second install. It does not bend the contract
   in `0002-mcp-piper-moves-bytes-not-formats.md`: that contract is about the
   bytes of MCP tool calls, which this hook never touches. It reads only
   assistant text, and only to find fences.
4. **The batches of one message hand state to each other through files.**
   Claude Code sends a long message to the hook in batches of whole lines, runs
   them as separate processes, and they can finish out of order, while a fence
   can open in one batch and close in a later one. Batch N waits (up to 3 s)
   for the state file of batch N-1. A batch that times out shows its text
   unchanged and passes on a "lost" state, so one slow batch costs one wait,
   not one per remaining batch. The files live under the mcp-piper state
   folder, keyed by message id, and are swept after 24 hours.

## Consequences

- Any failure prints nothing, and Claude Code shows the original text. The
  worst case is a missing link, never a changed or hidden message.
- Inside tmux the outer terminal must allow hyperlinks
  (`terminal-features` with `hyperlinks`); without it the label shows as plain
  text.
- `claude -p` and the SDK send the whole message in one call; a message with no
  `mermaid` in it touches no files at all.
