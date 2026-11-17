"""Turn one GitHub block (a PR or issue body, or one comment) into a Google Doc draft.

Usage: python3 -I gh-doc-fork.py <body.md> <body.html> <outdir>

body.md   the block's markdown: gh api repos/O/R/issues/N --jq .body
body.html the same call with -H "Accept: application/vnd.github.html+json" --jq .body_html
          (its image links are signed for about 5 minutes, so run this at once)

Writes into <outdir>:
  doc.md       the markdown, each GitHub image replaced by ![name](attach:name),
               and any Mermaid reading copy of an excalidraw.com link removed
               (a body posted before gh-doc-back.py stripped them may hold one)
  images/      the downloaded images
  images.json  {name: absolute image path}, for the doc tool's images argument
  hashes.txt   one line per image: sha256, asset URL, original tag
"""
import hashlib
import html
import json
import os
import re
import sys
import urllib.request

ASSET = r'https://github\.com/user-attachments/assets/'
UUID = r'[0-9a-f-]{36}'
IMAGE = re.compile(
    rf'<img[^>]*src="{ASSET}(?P<u>{UUID})"[^>]*/?>'
    rf'|!\[[^\]]*\]\({ASSET}(?P<u2>{UUID})\)')
SIGNED = re.compile(
    rf'src="(https://private-user-images\.githubusercontent\.com/[^"]*?/\d+-({UUID})(\.[a-z]+)\?[^"]*)"')

# Same matcher as strip_reading_copies in gh-doc-back.py; keep the two in step.
BEGIN = re.compile(r'^\s*\\?<!-- excalidraw-mermaid:begin ([A-Za-z0-9_-]+) --\\?>\s*$')


def strip_reading_copies(text):
    """Drop each begin..end reading copy and the one blank line before it."""
    lines, out, i = text.split('\n'), [], 0
    while i < len(lines):
        m = BEGIN.match(lines[i])
        if m:
            end = re.compile(rf'^\s*\\?<!-- excalidraw-mermaid:end {m.group(1)} --\\?>\s*$')
            j = next((k for k in range(i + 1, len(lines)) if end.match(lines[k])), None)
            if j is not None:
                if out and not out[-1].strip():
                    out.pop()
                i = j + 1
                continue
        out.append(lines[i])
        i += 1
    return '\n'.join(out)


def main(md_path, html_path, out):
    md = strip_reading_copies(open(md_path, encoding='utf-8').read().replace('\r\n', '\n'))
    body_html = open(html_path, encoding='utf-8').read()
    signed = {m.group(2): (html.unescape(m.group(1)), m.group(3)) for m in SIGNED.finditer(body_html)}
    os.makedirs(os.path.join(out, 'images'), exist_ok=True)
    images, hashes = {}, []

    def replace(m):
        uuid = m.group('u') or m.group('u2')
        name = uuid[:8]
        if uuid not in signed:
            sys.exit(f'no signed link for {uuid} in {html_path}; fetch body_html again')
        url, ext = signed[uuid]
        path = os.path.abspath(os.path.join(out, 'images', name + ext))
        data = urllib.request.urlopen(url).read()
        with open(path, 'wb') as f:
            f.write(data)
        images[name] = path
        hashes.append(f'{hashlib.sha256(data).hexdigest()} https://github.com/user-attachments/assets/{uuid} {m.group(0)}')
        return f'![{name}](attach:{name})'

    doc = IMAGE.sub(replace, md).replace('\r\n', '\n')
    with open(os.path.join(out, 'doc.md'), 'w', encoding='utf-8') as f:
        f.write(doc)
    with open(os.path.join(out, 'images.json'), 'w') as f:
        json.dump(images, f, indent=1)
    with open(os.path.join(out, 'hashes.txt'), 'w') as f:
        f.write(''.join(h + '\n' for h in hashes))
    print(json.dumps(images, indent=1))


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
