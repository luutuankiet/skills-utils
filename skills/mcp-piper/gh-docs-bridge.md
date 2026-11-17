# GitHub block ↔ Google Doc

A human edits one GitHub block (a PR or issue body, or one comment) in a Google
Doc, and you post it back with `gh` as them, images included. The human works in
the Doc only. When they say go, read their changes and post. Do not ask them
to review again.

`<block>` is `OWNER/REPO#N` for a body, `OWNER/REPO#issuecomment-ID` for a
comment, or the GitHub URL of either.

1. **Fork.** `create_doc` with a `title` and `"_pipe": "gh-doc <block>"`. The
   snippet fetches the block, downloads its images and fills `markdown` and
   `images`. Code blocks arrive at 5 pt, too small to read, so set them to
   the body size with `run_doc_script`, `dry_run: false`:

   ```js
   doc.tabs.forEach(t => t.lines.forEach(l => l.runs.forEach(r => {
     if (r.text.trim() && r.style.size < 12) style(r, {size: 12}, {includeCode: true}) })))
   ```

   Then `doc_history` with `doc: <doc id>`, `command: "tag forked"`. Send the
   human the Doc link.
2. **Read the human's changes.** `doc_history` with
   `command: "diff --stat forked..HEAD"`, then `diff -p` only if you need it.
3. **Post on go.** `pull_doc` with `doc: <doc id>` and
   `"_pipe": "gh-doc <block>"`. The snippet pulls the Doc and converts it back
   to GitHub markdown:
   - an unchanged image gets its original link back;
   - a new image is uploaded to GitHub (needs gh 2.99.0 or newer);
   - every image takes its width from its size in the Doc.

   Then it edits the block on GitHub, and the result is the posted URL. If the
   block changed on GitHub after the fork, it posts nothing and says so.

A table alignment row such as `:----` comes back as `---`; GitHub renders both
the same. The snippet handles a Doc with one tab and edits an existing block.
To post a new comment, or when the snippet is not available, run the scripts in
`scripts/` by hand with `python3 -I`:

```
gh api repos/O/R/issues/N --jq .body > body.md
gh api -H "Accept: application/vnd.github.html+json" repos/O/R/issues/N --jq .body_html > body.html
gh-doc-fork.py body.md body.html <dir>      # image links last 5 minutes: run at once
create_doc markdown="@file:<dir>/doc.md" images={name: "@file64:<path>"}   # from images.json
pull_doc deliver="files" _save_to="<dir>/wc/"
gh-doc-back.py <dir>/wc/<tab>.gdoc.md <dir>/hashes.txt back.md --upload O/R
gh api -X POST repos/O/R/issues/N/comments -F body=@back.md
```

For a comment, use `repos/O/R/issues/comments/ID` in the two fetch commands.
To edit a block instead of adding a comment, post with `-X PATCH` to the
block's own address.
