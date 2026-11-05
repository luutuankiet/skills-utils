# mcp-piper moves bytes; servers understand formats

mcp-piper started as one pointer (`"@file:<path>"`) and one save option
(`"_save_to"`). It then grew `@dir:` / `@dir64:` folder pointers and a folder
save that writes embedded resources at their relative paths. Each step invited
the next one: if a file can be sent, why not a file that names other files, or
a string with a placeholder in the middle? This record is the contract every
later feature is checked against, so the hook stays small and a call stays
predictable.

## The contract

1. **Piper moves bytes; servers understand formats.** The hook never reads
   inside a file it sends. A `@file:` pointer becomes the file's contents as
   UTF-8 or base64; a `@dir:` pointer becomes `{"relative/path": contents}`.
   Nothing is parsed, rendered or rewritten on the way (`readPointer` and
   `readDirPointer` in `piper/lib/core.js`). Saving works the same way: a
   result is written as it arrived, and only the resource header Claude Code
   puts in front of an embedded resource decides where it lands.
2. **A pointer is the whole string or nothing.** A string value is expanded
   only when it starts with `@file:`, `@file64:`, `@dir:` or `@dir64:` and the
   rest of the string is the path; `"see @file:/x"` is sent as written. Object
   keys are never touched. `@@file:` and `@@dir:` send the literal text with
   one `@` removed. Nothing is scanned or substituted implicitly.
3. **Folders are the unit of nesting.** A file that refers to other files (a
   Markdown doc and its images, say) is sent as one `@dir64:` map whose keys
   are relative paths, and the server resolves the references against those
   keys. A pointer inside a file is never followed. On the way back, a
   `_save_to` ending in `/` writes each embedded resource whose uri is a
   relative path at `<folder>/<uri>`.
4. **Bounded and checked before sending.** Every check runs before anything
   leaves the machine, and a failure denies the call with a reason starting
   `mcp-piper:`. A missing or unreadable path, a folder given to `@file:` or a
   file given to `@dir:` is refused. One `@dir:` pointer holds at most 500 files
   and 20 MiB (`DIR_MAX_FILES`, `DIR_MAX_BYTES`), counted from file sizes
   before any file is read; it skips names starting with `.` (so `.git`,
   `.env`), symlinks and anything that is not a plain file or folder. A
   `_save_to` must be a writable path. On save, every resource path is checked
   before the first write: an absolute path, a `..` segment, or a target that
   escapes the folder or is a symlink writes nothing and shows the result in
   full instead.

## Considered options

- **A substitution language in the hook** (custom delimiters inside a string,
  variables, pointers nested inside files to some depth). Parked, not
  rejected: issue 9 (https://github.com/luutuankiet/skills-utils/issues/9)
  holds the idea. It would rewrite text that merely mentions the
  syntax, make a call depend on state that is not in the call, and need rules
  per server for what a reference inside a file looks like. A script that
  writes a folder, sent with one `@dir64:` pointer, covers the same need today.
- **Send dot folders with `@dir:`.** Rejected: a working copy's `.git` and
  `.env` would travel to a third-party server by default. A server that needs a
  hidden file gets it through its own `@file:` pointer.

## Consequences

A feature that needs the hook to understand a format, to substitute part of a
string, or to follow a reference belongs on the server or in a script that
writes a folder, not in mcp-piper. A new pointer prefix must be added to
`looksLikePointer` in `piper/lib/core.js`, or the call skips expansion and the
literal pointer reaches the server. Raising a cap or changing what `@dir:`
skips is a change to this contract: supersede this record.
