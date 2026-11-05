---
name: mcp-piper
description: Send a file on disk as an MCP tool argument, or save an MCP tool's result to disk, without the bytes entering your context. Use before passing a large file (a script, a document, an image) to any MCP tool, and before calling an MCP tool whose result is large or binary (a full document read, a rendered image, an export).
---

# mcp-piper

mcp-piper is a pair of hooks on every MCP tool call. It gives you two opt-in
moves per call: a **pointer** that uploads a file, and **`_save_to`** that
downloads the result. A call that uses neither runs exactly as it would without
mcp-piper.

## Upload: pointers

Write a string argument as one of these, and nothing else in the string:

| you write | the server receives |
|---|---|
| `"@file:/abs/path/notes.md"` | the file's text (UTF-8) |
| `"@file64:/abs/path/chart.png"` | the file's bytes as base64 |
| `"@dir:/abs/path/src"` | a JSON object `{"rel/path.txt": "<text>", ...}` of the folder |
| `"@dir64:/abs/path/assets"` | the same object with base64 values |
| `"@@file:/x"` | the literal text `@file:/x` (one `@` removed) |
| `"@@file64:/x"` | the literal text `@file64:/x` |
| `"@@dir:/x"` | the literal text `@dir:/x` |

- Pointers work at any depth: inside arrays and nested objects, including as
  the values of a map argument.
- The pointer must be the whole string; `"see @file:/x"` is sent as written.
- Relative paths resolve against the session's working folder; `~/` is your
  home folder. Prefer absolute paths.
- No size limit on mcp-piper's side. A server that rejects the size answers
  with its own error.
- Use `@file64:` only when the tool wants base64 (images, binary uploads).
- `@dir:` recurses into subfolders. It skips names starting with `.` (so
  `.git`, `.env`) and symlinks, sorts the keys, and stops at 500 files or 20 MB
  in total. Use it only where the tool takes an object of files. A folder of
  images goes as `@dir64:`.
- **Never write or read base64 yourself.** When a tool takes an image or other
  base64 argument, pass `@file64:`. When it returns one, use `_save_to`. The
  bytes stay out of your context, so send the full-quality file. To look at
  an image yourself, ask the server for its smallest preview, or `Read` a saved
  file.

```json
{ "script": "@file:/home/me/work/deck-script.js", "deck": "1AbC..." }
```

### Example: diagrams into a Google Doc

Render the scenes locally. Per diagram, `c2m` writes `<name>.png` (for the doc)
and `<name>.review.png` (small, for a review agent) to `~/.cache/c2m/renders/`,
and prints the image line, the edit link line and the `images` entry to paste.

```
npx -y @luutuankiet/clipboard2markdown excalidraw --png flow.json states.json
```

Then one `edit_lines` call (same for `edit_doc` and `create_doc`) sends every
image. Each name in `images` is referred to as `![Alt](attach:<name>)`, alone
on its line:

```json
{
  "doc": "1AbC...", "tab": "2", "lines": "40", "revision": "...",
  "new": "![Request flow](attach:flow)\n[Edit this diagram](https://excalidraw.com/#json=...)\n\n![Order states](attach:states)\n[Edit this diagram](https://excalidraw.com/#json=...)",
  "images": {
    "flow": "@file64:/home/me/.cache/c2m/renders/flow.png",
    "states": "@file64:/home/me/.cache/c2m/renders/states.png"
  }
}
```

Send the `.png`, never the `.review.png`.

If you are about to paste more than a few thousand characters that already
exist in a file, use a pointer instead. Over 20,000 pasted characters, mcp-piper
reminds you.

## Download: `_save_to`

Add a top-level `"_save_to": "<abs path>"` to the call. It is removed before
the server sees the call, even when the tool's schema does not allow extra
properties. The result is written to disk and you get a stub back:

```
mcp-piper: saved 2 files
- /home/me/work/outline.json (300.0 KB, sha256 ad7c7bed782c7790, text)
- /home/me/work/outline-img1.png (183.9 KB, sha256 f5760ae9a1b2c3d4, image/png)
```

- End the path in `/` (or name an existing folder) to save **into a folder**:
  the text goes to `result.txt` (`result.json` for a JSON result) and images
  to `img1.png`, `img2.jpg` and so on inside it. A path without `/` that does
  not exist yet is a file.
- Text blocks go into the `_save_to` file, joined by newlines.
- A JSON result (`structuredContent`) is pretty-printed into the `_save_to` file.
- Each image goes to its own file beside it: `<stem>-img1.png`, `<stem>-img2.jpg`,
  and so on. If the result is only images, the `_save_to` file itself is not
  written; read the paths from the stub.
- The parent folder is created if missing. An existing file is overwritten.
- **Links are never followed.** A resource link is saved as its text line. Fetch
  the target with the server's own tool if you need it.
- If an MCP proxy truncated the result, the stub says so and gives the cache key
  when there is one; fetch the rest through the proxy's cache tool.
- If the tool returns an error, nothing is saved and you see the error as usual.

Then work from the file with your normal tools (`Read` with a line range, `grep`,
`jq`) instead of reading it whole.

## When a call is stopped

A refused call never reaches the server. The reason starts with `mcp-piper:`.

| reason says | what to do |
|---|---|
| `file not found` | fix the path; check the working folder for relative paths |
| `cannot read` | the file's permissions block you; pick a readable file |
| `is a folder` (pointer) | use `@dir:` / `@dir64:` if the tool takes a map of files, else point at one file |
| `is a file, not a folder` | use `@file:` / `@file64:` for one file |
| `holds more than` | the `@dir:` folder is over 500 files or 20 MB; point at a smaller one |
| `has no path` | write the path right after the colon |
| `_save_to must be a file path string` | pass a string, not an object or array |
| `_save_to is empty` | give a full path, e.g. `/tmp/out.json` or `/tmp/out/` |
| `ends in "/" but ... is a file` | drop the `/`, or choose a folder path |
| `cannot create the folder` / `cannot write to` | choose a location you can write to |

If you meant the literal text `@file:...`, write `@@file:...` instead.

## Privacy

Claude Code writes hook output into the session's transcript file on disk. The
expanded contents of every pointer land there, so a secret you upload through a
pointer is stored in that file, even though it never enters your context.

If a tool needs the user's approval, the approval prompt shows the expanded
input, not the pointer. mcp-piper never approves a call by itself.
