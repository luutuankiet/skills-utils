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
