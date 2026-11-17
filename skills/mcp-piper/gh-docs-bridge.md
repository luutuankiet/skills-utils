# GitHub block ↔ Google Doc: caveats and the by-hand path

The recipe itself (Copy to Doc, read changes, post) is in [SKILL.md](SKILL.md),
under "GitHub block to Google Doc". This page holds what the snippet does on
the way back, its limits, and the by-hand path for when it does not fit.

## What the post does

`pull_doc` with `"_pipe": "gh-doc <block>"` pulls the Doc and converts it back
to GitHub markdown:

- an unchanged image gets its original link back;
- a new image is uploaded to GitHub (needs gh 2.99.0 or newer);
- every image takes its width from its size in the Doc;
- the Mermaid reading copy `pull_doc` adds under each excalidraw.com link is
  removed; if any part of one is left, nothing is posted;
- a table alignment row such as `:----` comes back as `---`; GitHub renders
  both the same.

Then it edits the block on GitHub. If the block changed on GitHub after the
copy, it posts nothing and says so.

## Limits

The snippet handles a Doc with one tab, and edits an existing block. To post a
new comment, or when the snippet is not available, use the by-hand path.

## By hand

Run the scripts in `scripts/` with `python3 -I`:

```
gh api repos/O/R/issues/N --jq .body > body.md
gh api -H "Accept: application/vnd.github.html+json" repos/O/R/issues/N --jq .body_html > body.html
gh-doc-fork.py body.md body.html <dir>      # image links last 5 minutes: run at once
create_doc markdown="@file:<dir>/doc.md" images={name: "@file64:<path>"} tag="forked"   # images from images.json
pull_doc deliver="files" _save_to="<dir>/wc/"
gh-doc-back.py <dir>/wc/<tab>.gdoc.md <dir>/hashes.txt back.md --upload O/R
gh api -X POST repos/O/R/issues/N/comments -F body=@back.md
```

For a comment, use `repos/O/R/issues/comments/ID` in the two fetch commands.
To edit a block instead of adding a comment, post with `-X PATCH` to the
block's own address.

## Porting to another Docs server

`pipes/gh-doc` and its two scripts were built against one Google Docs MCP server
that is not public. To use them with another server, such as the official
Google Docs MCP, that server needs tools doing these jobs, or the snippet needs
changes where it does not:

| the snippet expects | where |
|---|---|
| a tool whose name ends in `create_doc`, taking `markdown` (GitHub markdown, with images written `![name](attach:name)`), `images` (`{name: base64}`) and `tag` | `fork()` in `pipes/gh-doc` |
| a tool whose name ends in `pull_doc`, taking `deliver: "files"` and saving one `*.gdoc.md` file per tab into the `_save_to` folder | the `pull_doc` branches at the end of `pipes/gh-doc` |
| that file: markdown with a marker on line 1, images as `![...](./images/<file> "<w>x<h>...")` beside the image files, `<` and `>` escaped with a backslash outside code fences | `scripts/gh-doc-back.py` |
| a way to diff the Doc against the `forked` state, for step 2 | `doc_history`; optional, the post does not need it |

The server-specific clean-ups are in `gh-doc-back.py`; its docstring lists
each one. The Mermaid reading copy it removes is added only by that server, so
on another server the removal finds nothing and costs nothing.
