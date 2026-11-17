"""Turn a Google Doc tab pulled as a working copy back into GitHub markdown.

Usage: python3 -I gh-doc-back.py <tab.gdoc.md> <hashes.txt> <out.md> [--upload OWNER/REPO]

<tab.gdoc.md> the tab file from pull_doc with deliver="files"
<hashes.txt>  written by gh-doc-fork.py

- Drops the working-copy marker on line 1.
- An image whose bytes match a line in hashes.txt gets its original tag back.
- Every image takes its width from the size shown in the Doc, so resizing an
  image in the Doc resizes it on GitHub. The Doc gives points; GitHub wants
  pixels (1 pt = 4/3 px). The height is dropped so GitHub keeps the ratio.
- A new image is uploaded to GitHub with --upload (needs gh 2.99.0 or newer and
  write access to the repository). Without --upload it becomes a
  <NEW-IMAGE name size> placeholder, so a dry run posts nothing.
- Removes the https://attach.invalid/... text the Doc leaves after an image.
- Removes the backslash the Doc puts before < and > outside code fences.
- Removes every Mermaid reading copy pull_doc puts under an excalidraw.com
  link (begin marker through end marker, plus the blank line before it), so
  the link line and the text around it come back as the Doc had them.
- Posts nothing when a reading copy marker or its %% header line is still
  there after that: exits non-zero with "gh-doc: nothing posted: ...".
"""
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys

IMAGE = re.compile(r'!\[[^\]]*\]\((\./images/[^ )]+)(?: "(?:(\d+)x\d+)?[^"]*")?\)(?:https://attach\.invalid/\S+)?')
# Same matcher as strip_reading_copies in gh-doc-fork.py; keep the two in step.
# Mirrors the server's own: begin alone on its line, end naming the same id.
BEGIN = re.compile(r'^\s*\\?<!-- excalidraw-mermaid:begin ([A-Za-z0-9_-]+) --\\?>\s*$')
LEFTOVER = re.compile(r'excalidraw-mermaid:|^\s*%% (?:generated from |could not load: )')
TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
         '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'}


def content_type(path):
    ext = os.path.splitext(path)[1].lower()
    return TYPES.get(ext) or mimetypes.guess_type(path)[0] or 'application/octet-stream'


def sized(tag, width_pt):
    """Set the tag's width from the Doc's width in points and drop its height."""
    if not width_pt:
        return tag
    tag = re.sub(r'\s(?:width|height)="[^"]*"', '', tag)
    return tag.replace('<img', f'<img width="{round(int(width_pt) * 4 / 3)}"', 1)


def strip_reading_copies(lines):
    """Drop each begin..end reading copy and the one blank line before it.

    Takes and returns (line number, text) pairs. A begin with no matching end
    is kept, so the leftover check refuses the post."""
    out, i = [], 0
    while i < len(lines):
        m = BEGIN.match(lines[i][1])
        if m:
            end = re.compile(rf'^\s*\\?<!-- excalidraw-mermaid:end {m.group(1)} --\\?>\s*$')
            j = next((k for k in range(i + 1, len(lines)) if end.match(lines[k][1])), None)
            if j is not None:
                if out and not out[-1][1].strip():
                    out.pop()
                i = j + 1
                continue
        out.append(lines[i])
        i += 1
    return out


def upload(path, repo, repo_id):
    url = ('https://uploads.github.com/user-attachments/assets'
           f'?name={os.path.basename(path)}&content_type={content_type(path)}&repository_id={repo_id}')
    out = subprocess.check_output(
        ['gh', 'api', '-X', 'POST', '-H', 'Content-Type: application/octet-stream', url, '--input', path],
        text=True)
    return json.loads(out)['url']


def main(src, hashes_path, out, repo=None):
    known = {}
    with open(hashes_path) as f:
        for line in f:
            if line.strip():
                digest, _url, tag = line.rstrip('\n').split(' ', 2)
                known[digest] = tag
    base = os.path.dirname(src)
    repo_id = None

    def image(m):
        nonlocal repo_id
        path = os.path.join(base, m.group(1))
        with open(path, 'rb') as f:
            data = f.read()
        digest = hashlib.sha256(data).hexdigest()
        if digest in known:
            return sized(known[digest], m.group(2))
        if not repo:
            return f'<NEW-IMAGE {os.path.basename(path)} {len(data)}B>'
        if repo_id is None:
            repo_id = subprocess.check_output(['gh', 'api', f'repos/{repo}', '--jq', '.id'], text=True).strip()
        return sized(f'<img alt="image" src="{upload(path, repo, repo_id)}" />', m.group(2))

    with open(src, encoding='utf-8') as f:
        lines = list(enumerate(f.read().split('\n'), 1))[1:]
    lines = strip_reading_copies(lines)
    for n, line in lines:
        if LEFTOVER.search(line):
            sys.exit(f'gh-doc: nothing posted: line {n} of {src} still holds part of a diagram '
                     f'reading copy: {line.strip()[:120]}. If the Doc holds it as text, delete '
                     f'it there and pull again.')
    result, fence = [], False
    for _n, line in lines:
        if line.startswith('```'):
            fence = not fence
        if not fence:
            line = IMAGE.sub(image, line)
            line = re.sub(r'\\([<>])', r'\1', line)
        result.append(line)
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(result).rstrip('\n') + '\n')


if __name__ == '__main__':
    args = sys.argv[1:]
    repo = None
    if len(args) == 5 and args[3] == '--upload':
        repo = args[4]
        args = args[:3]
    if len(args) != 3:
        sys.exit(__doc__)
    main(*args, repo=repo)
