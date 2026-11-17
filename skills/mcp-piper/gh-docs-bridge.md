# GitHub block ↔ Google Doc

A human edits one GitHub block (a PR or issue body, or one comment) in a Google
Doc, and you post it back with `gh` as them, images included. The human reviews
the Doc and only the Doc; you post when they say go. The scripts sit in
`scripts/` beside this file; run them with `python3 -I`. Below, `O/R` is the
repository, `N` the issue or PR number, and `ID` a comment id.

1. Fetch the block into a work folder. For a comment, use
   `repos/O/R/issues/comments/ID` in both calls. The HTML links to the images
   are signed for 5 minutes, so run step 2 straight after.
   ```
   gh api repos/O/R/issues/N --jq .body > body.md
   gh api -H "Accept: application/vnd.github.html+json" repos/O/R/issues/N --jq .body_html > body.html
   ```
2. `gh-doc-fork.py body.md body.html <dir>` writes `doc.md` (each image
   becomes `![name](attach:name)`), `images.json` and `hashes.txt`.
3. Create the Doc with the Google Docs MCP server (google-docs-mcp):
   `create_doc` with `markdown="@file:<dir>/doc.md"` and `images` holding each
   entry of `images.json` as `{name: "@file64:<path>"}`. Mark the start with
   `doc_history` with `doc: <doc id>` and `command: "tag forked"`. Send the human the Doc link.
4. Wait for the human's go or no-go.
5. On go, `pull_doc` with `deliver="files"` and `"_save_to": "<dir>/wc/"`, then
   `gh-doc-back.py <dir>/wc/<tab>.gdoc.md <dir>/hashes.txt back.md --upload O/R`.
   An unchanged image gets its original tag back; a new one is uploaded to
   GitHub (gh 2.99.0 or newer). Every image takes its width from its size in
   the Doc, so the human resizes images in the Doc, not in an `<img>` tag. Without `--upload` new images become
   `<NEW-IMAGE ...>` placeholders, which is a safe dry run.
6. Post `back.md`:
   - edit a body: `gh api -X PATCH repos/O/R/issues/N -F body=@back.md`
   - edit a comment: `gh api -X PATCH repos/O/R/issues/comments/ID -F body=@back.md`
   - new comment: `gh api -X POST repos/O/R/issues/N/comments -F body=@back.md`

To see what the human changed without reading the whole Doc, call `doc_history`
with `command: "diff --stat forked..HEAD"` first, then `diff -p` only if needed. A table alignment row such as `:----`
comes back as `---`; GitHub renders both the same.
