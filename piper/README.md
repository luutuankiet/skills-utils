# mcp-piper

Move files between your disk and MCP tool calls without the bytes passing through the agent's context.

An agent using MCP tools in Claude Code normally has two expensive habits:

- to send a file it already has on disk, it pastes the whole file into the tool call;
- to keep a large or binary result, it reads the whole result first.

mcp-piper is a pair of Claude Code hooks that remove both. The agent writes a short pointer instead of the file, and gets a short stub back instead of the result. It works with any MCP server, including claude.ai connectors, and needs no change to any server.

Both directions are opt-in, per call. A call with no pointer and no `_save_to` behaves exactly as it did before.

## Install

mcp-piper ships inside the `skills-utils` Claude Code plugin, which registers the hooks for you:

```
claude plugin install skills-utils@context-lab
```

The hooks run `node .../piper/bin/mcp-piper.js hook <event>` from the plugin folder. Node 18 or newer is the only requirement. You do not need to edit `~/.claude/settings.json`.

## Send a file: pointers

Write a string argument as exactly one of these:

| you write | the server receives |
|---|---|
| `"@file:/abs/path/script.js"` | the file's contents as UTF-8 text |
| `"@file64:/abs/path/image.png"` | the file's contents as base64 |
| `"@dir:/abs/path/src"` | the folder as a JSON object `{"rel/path": "<text>", ...}` |
| `"@dir64:/abs/path/assets"` | the same object with base64 values |
| `"@@file:/some/text"` | the literal string `@file:/some/text` (one `@` removed; `@@dir:` likewise) |
| `"@@file64:/some/text"` | the literal string `@file64:/some/text` |

- The pointer must be the whole string. `"see @file:/x"` is left alone.
- Pointers work at any depth inside arrays and objects.
- Relative paths resolve against the session's working folder, and `~/` expands to your home folder.
- There is no size limit for `@file:`. If the server rejects a large payload, its error reaches the agent as usual.
- `@dir:` recurses, sorts keys, skips names starting with `.` and symlinks, and refuses a folder over 500 files or 20 MB in total.

Example:

```json
{ "script": "@file:/home/me/work/deck-script.js", "deck": "1AbC..." }
```

## Keep a result: `_save_to`

Add a top-level `_save_to` argument with a file path, or a folder path ending in `/`:

```json
{ "doc": "1AbC...", "_save_to": "/home/me/work/outline.json" }
```

mcp-piper removes `_save_to` before the server sees the call, saves the result there, and the agent receives a stub instead of the result:

```
mcp-piper: saved 2 files
- /home/me/work/outline.json (300.0 KB, sha256 ad7c7bed782c7790, text)
- /home/me/work/outline-img1.png (183.9 KB, sha256 f5760ae9a1b2c3d4, image/png)
```

What gets saved:

- **Text** blocks are joined with newlines into the `_save_to` file.
- **JSON** results (an MCP `structuredContent`) are pretty-printed into the `_save_to` file.
- **Into a folder** (`_save_to` ends in `/`, or names an existing folder): text goes to `result.txt` (`result.json` for JSON) and images to `img<N>.<ext>` inside it.
- **Embedded resources into a folder.** In a folder save, an embedded resource whose `uri` is a relative path (no scheme, or `file:` relative) is written to `<folder>/<uri>`: text as UTF-8, a blob as its bytes, subfolders created, an existing file overwritten. A resource with any other `uri` goes into `result.txt` as before. The whole save is planned and checked before the first write: an absolute path, a `..` segment, a NUL byte, a path that resolves outside the folder, a target that is a symlink, an existing file where a folder is needed, a folder that cannot be written, two parts landing on one path (two resources with the same `uri`, or a resource named `result.txt` or `img1.png`) or a resource at `a` beside another at `a/b` refuses the whole save, nothing is written, and the agent sees the full result with a reason starting `mcp-piper: refused`. Claude Code hands hooks each resource already rendered as text (`[Resource from <server> at <uri>] <text>`; an image blob as that line plus the image; any other blob as `Binary content (<mime>, <N> bytes) saved to <path>`), and mcp-piper reads that form as well as the raw MCP `resource` block. Only headers naming the server that was called place files; any other such line is text. A file named by `<path>` (or by an image's `[Image: source: <path>]`) is copied only when it sits, after symlinks resolve, in Claude Code's tool-results folder for the session (`<projects>/<session>/tool-results/`, found from the hook's `transcript_path`); any other path stays text, so a server cannot make the hook copy an arbitrary local file.
- **Images** each go to their own file next to it, named `<stem>-img<N>.<ext>`, numbered from 1. Where Claude Code kept the server's original image bytes, those are copied; otherwise the image is decoded from the result.
- **Links are never followed.** A resource link arrives as a text line and is saved as text. To fetch the linked file, use the server's own tool or `curl`.
- If an MCP proxy cut the result short (`[truncated by mcpproxy`), the stub says so and gives the proxy's cache key when there is one.
- If the tool returns an error, nothing is saved and the agent sees the error as usual.

## When a call is stopped

mcp-piper stops a call before the server sees it, with a reason starting `mcp-piper:`, when:

- a pointer names something that does not exist or cannot be read, `@file:` names a folder, or `@dir:` names a file;
- a `@dir:` folder is over 500 files or 20 MB;
- `_save_to` is not a string, is empty, ends in `/` but names a file, or its folder cannot be created or written to.

The reason says what to fix. An unexpanded `@file:` string never reaches a server.

## For MCP server authors

Nothing in a server has to change. If an argument takes base64 bytes or a map of files, saying so in its description lets an agent with mcp-piper send a pointer instead of producing the bytes itself. One sentence is enough:

```
image_base64: PNG, JPEG or GIF bytes as base64. With mcp-piper, pass "@file64:/abs/path.png".
files: {"relative/path": text}. With mcp-piper, pass "@dir:/abs/folder".
```

When a tool returns base64 or images, add a line such as `With mcp-piper, add "_save_to": "/abs/path/" to save it to disk instead of reading it.` There is no schema flag. The sentence is the whole convention.

## The paste tip

When a call has no pointer but pastes a string longer than 20,000 characters, the call goes through unchanged and the agent gets a one-line tip to use `@file:` next time.

## Mermaid links on screen

The plugin also binds Claude Code's `MessageDisplay` hook. Under each
```` ```mermaid ```` or `~~~mermaid` block in an assistant message, the terminal
shows one line, `↳ open diagram N`, as a clickable link to the diagram in the
mermaid.live editor (`https://mermaid.live/edit#pako:...`).

- **Display only.** The line is never written to the transcript and the model
  never sees it.
- **Offline.** The diagram text is deflated and base64url-encoded into the URL
  fragment on your machine. Nothing is uploaded until you open the link, and a
  URL fragment is not sent to the server even then.
- **Every block.** Indented fences, tilde fences, several diagrams per message
  and a block still open when the message ends all get a link. A mermaid fence
  quoted inside another code block does not.
- **Off switch.** Set `MCP_PIPER_MERMAID=0` (or `false`, `off`, `no`) in the
  environment Claude Code runs in.
- **Terminal.** The label renders as an OSC 8 hyperlink. Inside tmux, the
  outer terminal needs `set -as terminal-features 'xterm*:hyperlinks'` or
  tmux drops the link and you see only the label text.

## Things to know

- Claude Code writes hook output into the session's transcript file on disk. That includes the expanded contents of every pointer, so a secret sent through a pointer lands in that file too. The model never sees it.
- If a tool is not pre-allowed and Claude Code asks you to approve the call, the approval prompt shows the expanded input, so a large upload makes a large prompt. mcp-piper never approves a call on your behalf; your own permission rules decide as usual.
- mcp-piper keeps a small state file per call in your temp folder (`mcp-piper/state`), deleted when the call finishes; leftovers older than a day are cleaned up automatically.

## Check an install

```
npx @luutuankiet/mcp-piper doctor
```

checks the Node version, that the plugin's hook file is where Claude Code looks for it, that a sample pointer expands correctly, and that the state folder is writable.

## License

MIT. Part of `skills-utils`: https://github.com/luutuankiet/skills-utils
