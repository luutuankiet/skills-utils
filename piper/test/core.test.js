import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync,
  utimesSync, readdirSync, symlinkSync, statSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PiperError, hasPointerCandidates, needsInlineNudge, resolvePath, expandPointers,
  validateSaveTo, prepareInput, normaliseResult, saveResult, buildStub, humanSize,
  detectTruncation, siblingPath, stateDir, writeState, readState, deleteState, sweepState,
  NUDGE_THRESHOLD, DIR_MAX_FILES, DIR_MAX_BYTES,
} from '../lib/core.js';

const fresh = (p = 'piper-core-') => mkdtempSync(join(tmpdir(), p));
const isRoot = process.getuid && process.getuid() === 0;
const sha16 = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

beforeEach(() => { process.env.MCP_PIPER_STATE_DIR = join(fresh('piper-state-'), 'state'); });

// ------------------------------------------------------------ pointer scan ---

test('fast path: finds pointer-like strings at any depth and nothing else', () => {
  assert.equal(hasPointerCandidates({ a: 'x', b: [1, { c: 'plain' }], d: null }), false);
  assert.equal(hasPointerCandidates({ a: '@file:/x' }), true);
  assert.equal(hasPointerCandidates({ a: [{ b: ['@file64:/x'] }] }), true);
  assert.equal(hasPointerCandidates({ a: '@@file:/x' }), true);
  assert.equal(hasPointerCandidates({ a: 'see @file:/x' }), false, 'only at the start');
  assert.equal(hasPointerCandidates({ '@file:/x': 'key, not value' }), false);
});

test('paths: relative against cwd, ~ and ~/ expand, absolute kept', () => {
  assert.equal(resolvePath('a/b.txt', '/w'), '/w/a/b.txt');
  assert.equal(resolvePath('~/x.txt', '/w', '/h'), '/h/x.txt');
  assert.equal(resolvePath('~', '/w', '/h'), '/h');
  assert.equal(resolvePath('/abs/y', '/w'), '/abs/y');
  assert.equal(resolvePath('~/x', '/w'), join(homedir(), 'x'));
});

// ------------------------------------------------------- pointer expansion ---

test('@file: becomes UTF-8 text and @file64: becomes base64, nested in arrays and objects', () => {
  const d = fresh();
  writeFileSync(join(d, 'a.txt'), 'héllo');
  writeFileSync(join(d, 'b.bin'), Buffer.from([0, 1, 2, 255]));
  const { value, pointers } = expandPointers({
    top: '@file:a.txt',
    list: ['@file64:b.bin', 'plain', 3, { deep: ['@file:' + join(d, 'a.txt')] }],
    n: null, ok: true,
  }, { cwd: d });
  assert.equal(value.top, 'héllo');
  assert.equal(value.list[0], Buffer.from([0, 1, 2, 255]).toString('base64'));
  assert.equal(value.list[1], 'plain');
  assert.equal(value.list[2], 3);
  assert.equal(value.list[3].deep[0], 'héllo');
  assert.equal(value.n, null);
  assert.equal(value.ok, true);
  assert.equal(pointers.length, 3);
});

test('a pointer must be the whole string; text around it is left alone', () => {
  const { value, pointers } = expandPointers({ a: 'x @file:/nope', b: '@filex:/nope', c: '@file' });
  assert.deepEqual(value, { a: 'x @file:/nope', b: '@filex:/nope', c: '@file' });
  assert.equal(pointers.length, 0);
});

test('escape: @@file: and @@file64: lose exactly one @ and are not read', () => {
  const { value, pointers, escapes } = expandPointers({
    a: '@@file:/does/not/exist', b: ['@@file64:/x'], c: '@@@file:/x', d: '@@filename',
  });
  assert.equal(value.a, '@file:/does/not/exist');
  assert.equal(value.b[0], '@file64:/x');
  assert.equal(value.c, '@@@file:/x', 'only a leading @@file: is an escape');
  assert.equal(value.d, '@@filename');
  assert.equal(pointers.length, 0);
  assert.equal(escapes, 2);
});

test('deny: pointer to a missing file names the path and the escape', () => {
  const d = fresh();
  assert.throws(() => expandPointers({ a: '@file:missing.txt' }, { cwd: d }), (e) =>
    e instanceof PiperError && e.message.startsWith('mcp-piper: file not found: ' + join(d, 'missing.txt'))
    && e.message.includes('@@file:'));
});

test('deny: @file pointer to a folder is refused and names @dir', () => {
  const d = fresh();
  assert.throws(() => expandPointers({ a: '@file64:' + d }), (e) =>
    e instanceof PiperError && /is a folder/.test(e.message) && e.message.includes(`"@dir64:${d}"`));
});

// -------------------------------------------------------------- @dir pointer ---

const tree = () => {
  const d = fresh();
  mkdirSync(join(d, 'sub/deeper'), { recursive: true });
  mkdirSync(join(d, '.git'));
  writeFileSync(join(d, 'b.txt'), 'B');
  writeFileSync(join(d, 'a.txt'), 'A');
  writeFileSync(join(d, 'sub/c.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(d, 'sub/deeper/d.md'), '# D');
  writeFileSync(join(d, '.env'), 'SECRET=1');
  writeFileSync(join(d, '.git/HEAD'), 'ref');
  symlinkSync('/etc/hostname', join(d, 'link'));
  symlinkSync(join(d, 'sub'), join(d, 'sublink'));
  return d;
};

test('@dir: folder becomes a sorted {relpath: text} map; dotfiles and symlinks skipped', () => {
  const d = tree();
  assert.equal(hasPointerCandidates({ x: '@dir:' + d }), true);
  assert.equal(hasPointerCandidates({ x: '@dir64:' + d }), true);
  const { value, pointers } = expandPointers({ x: { files: '@dir:' + d } });
  assert.deepEqual(Object.keys(value.x.files), ['a.txt', 'b.txt', 'sub/c.bin', 'sub/deeper/d.md']);
  assert.equal(value.x.files['sub/deeper/d.md'], '# D');
  assert.equal(pointers.length, 1);
  assert.equal(pointers[0].files, 4);
  assert.equal(pointers[0].bytes, 1 + 1 + 3 + 3);
  assert.equal(pointers[0].skipped, 4, '.env, .git, link, sublink');
});

test('@dir64: values are base64', () => {
  const d = tree();
  const { value } = expandPointers({ x: '@dir64:' + d });
  assert.equal(value.x['sub/c.bin'], Buffer.from([0, 1, 2]).toString('base64'));
  assert.equal(value.x['a.txt'], 'QQ==');
});

test('@dir: relative path, ~, empty folder and escape', () => {
  const d = fresh();
  mkdirSync(join(d, 'empty'));
  assert.deepEqual(expandPointers({ x: '@dir:empty' }, { cwd: d }).value, { x: {} });
  assert.deepEqual(expandPointers({ x: '@dir:~/empty' }, { home: d }).value, { x: {} });
  const esc = expandPointers({ x: '@@dir:empty' }, { cwd: d });
  assert.deepEqual(esc.value, { x: '@dir:empty' });
  assert.equal(esc.escapes, 1);
});

test('deny: @dir on a file, a missing folder, or no path', () => {
  const d = fresh();
  writeFileSync(join(d, 'a.txt'), 'A');
  assert.throws(() => expandPointers({ x: '@dir:a.txt' }, { cwd: d }), (e) =>
    e instanceof PiperError && /is a file, not a folder/.test(e.message) && e.message.includes('"@file:a.txt"'));
  assert.throws(() => expandPointers({ x: '@dir:nope' }, { cwd: d }), (e) =>
    e instanceof PiperError && e.message.startsWith('mcp-piper: folder not found: ' + join(d, 'nope')));
  assert.throws(() => expandPointers({ x: '@dir:' }), /has no path/);
});

test('deny: @dir over the file-count cap', () => {
  const d = fresh();
  for (let i = 0; i <= DIR_MAX_FILES; i++) writeFileSync(join(d, `f${i}`), '');
  assert.throws(() => expandPointers({ x: '@dir:' + d }), (e) =>
    e instanceof PiperError && e.message.includes(`more than ${DIR_MAX_FILES} files`));
});

test('deny: @dir over the byte cap', () => {
  const d = fresh();
  writeFileSync(join(d, 'big'), Buffer.alloc(DIR_MAX_BYTES + 1));
  assert.throws(() => expandPointers({ x: '@dir:' + d }), (e) =>
    e instanceof PiperError && /more than 20\.0 MB/.test(e.message));
});

test('deny: pointer to an unreadable file', { skip: isRoot && 'root can read anything' }, () => {
  const d = fresh();
  const p = join(d, 'secret.txt');
  writeFileSync(p, 'x');
  chmodSync(p, 0o000);
  assert.throws(() => expandPointers({ a: `@file:${p}` }), (e) =>
    e instanceof PiperError && /cannot read/.test(e.message) && /EACCES/.test(e.message));
});

test('deny: a pointer with no path', () => {
  assert.throws(() => expandPointers({ a: '@file:' }), (e) => e instanceof PiperError && /has no path/.test(e.message));
});

test('input is not modified in place', () => {
  const d = fresh();
  writeFileSync(join(d, 'a.txt'), 'A');
  const input = { x: ['@file:a.txt'] };
  expandPointers(input, { cwd: d });
  assert.deepEqual(input, { x: ['@file:a.txt'] });
});

// ---------------------------------------------------------------- _save_to ---

test('_save_to: parent folders are created, path made absolute, ~ expands', () => {
  const d = fresh();
  const abs = validateSaveTo('deep/er/out.json', { cwd: d });
  assert.equal(abs, join(d, 'deep/er/out.json'));
  assert.ok(existsSync(join(d, 'deep/er')));
  assert.equal(validateSaveTo('~/o.txt', { home: d }), join(d, 'o.txt'));
});

test('deny: _save_to that is not a string, or is empty', () => {
  for (const v of [42, null, ['a'], { p: 'x' }, true]) {
    assert.throws(() => validateSaveTo(v), (e) => e instanceof PiperError && /must be a file path string/.test(e.message));
  }
  assert.throws(() => validateSaveTo('  '), /is empty/);
});

test('deny: _save_to whose parent cannot be created', () => {
  const d = fresh();
  writeFileSync(join(d, 'file'), 'x');
  assert.throws(() => validateSaveTo(join(d, 'file', 'sub', 'out.txt')), (e) =>
    e instanceof PiperError && /cannot create the folder/.test(e.message));
});

test('deny: _save_to whose parent is not writable', { skip: isRoot && 'root can write anywhere' }, () => {
  const d = fresh();
  const ro = join(d, 'ro');
  mkdirSync(ro);
  chmodSync(ro, 0o500);
  assert.throws(() => validateSaveTo(join(ro, 'out.txt')), (e) =>
    e instanceof PiperError && /cannot write to/.test(e.message));
});

test('_save_to: an existing folder, or a path ending in "/", is a folder target', () => {
  const d = fresh();
  assert.equal(validateSaveTo(d), d + sep);
  assert.equal(validateSaveTo('new/out/', { cwd: d }), join(d, 'new/out') + sep);
  assert.ok(statSync(join(d, 'new/out')).isDirectory(), 'created');
  assert.equal(validateSaveTo('new/file', { cwd: d }), join(d, 'new/file'), 'no slash, not there: a file');
});

test('deny: _save_to ending in "/" that is an existing file', () => {
  const d = fresh();
  writeFileSync(join(d, 'f'), 'x');
  assert.throws(() => validateSaveTo('f/', { cwd: d }), (e) =>
    e instanceof PiperError && /ends in "\/" but .* is a file/.test(e.message));
});

test('saveResult into a folder: result.txt plus img<N>, stub lists them', () => {
  const d = fresh();
  const target = validateSaveTo('out/', { cwd: d });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const saved = saveResult(normaliseResult([
    { type: 'text', text: 'hello' },
    { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    { type: 'image', mimeType: 'image/jpeg', data: png.toString('base64') },
  ]), target);
  assert.deepEqual(saved.files.map((f) => f.path), [
    join(d, 'out/result.txt'), join(d, 'out/img1.png'), join(d, 'out/img2.jpg')]);
  assert.equal(readFileSync(join(d, 'out/result.txt'), 'utf8'), 'hello');
  assert.deepEqual(readFileSync(join(d, 'out/img1.png')), png);
  assert.match(buildStub(saved), /^mcp-piper: saved 3 files\n- .*out\/result\.txt/);
});

test('saveResult into a folder: a JSON result lands in result.json', () => {
  const d = fresh();
  const target = validateSaveTo(d);
  const saved = saveResult(normaliseResult('{"a":1}'), target);
  assert.deepEqual(saved.files.map((f) => f.path), [join(d, 'result.json')]);
});

test('prepareInput strips _save_to and reports what changed', () => {
  const d = fresh();
  writeFileSync(join(d, 'a.txt'), 'A');
  const none = prepareInput({ q: 'plain' }, { cwd: d });
  assert.equal(none.changed, false);
  const both = prepareInput({ q: '@file:a.txt', _save_to: 'out.txt' }, { cwd: d });
  assert.deepEqual(both.input, { q: 'A' });
  assert.equal(both.saveTo, join(d, 'out.txt'));
  assert.equal(both.expanded, true);
  assert.equal(both.changed, true);
  const esc = prepareInput({ q: '@@file:x' }, { cwd: d });
  assert.equal(esc.changed, true);
  assert.equal(esc.expanded, false);
});

// ------------------------------------------------------------- inline nudge ---

test('inline nudge: only for long strings with no pointer', () => {
  const big = 'x'.repeat(NUDGE_THRESHOLD + 1);
  assert.equal(needsInlineNudge({ a: big }), true);
  assert.equal(needsInlineNudge({ a: [{ b: big }] }), true);
  assert.equal(needsInlineNudge({ a: 'x'.repeat(NUDGE_THRESHOLD) }), false, 'exactly 20000 is fine');
  assert.equal(needsInlineNudge({ a: big, b: '@file:/x' }), false);
});

// ----------------------------------------------------------- result saving ---

test('humanSize matches the stub format', () => {
  assert.equal(humanSize(12), '12 B');
  assert.equal(humanSize(307200), '300.0 KB');
  assert.equal(humanSize(5 * 1048576), '5.0 MB');
});

test('normalise: array, object with content, JSON string, plain string', () => {
  assert.equal(normaliseResult([{ type: 'text', text: 'a' }]).kind, 'blocks');
  assert.equal(normaliseResult({ content: [] }).kind, 'blocks');
  const j = normaliseResult('{"a":1}');
  assert.deepEqual(j, { kind: 'json', text: '{\n  "a": 1\n}' });
  assert.deepEqual(normaliseResult('not json'), { kind: 'text', text: 'not json' });
});

test('save: text blocks are joined with newlines into _save_to', () => {
  const d = fresh();
  const out = join(d, 'out.txt');
  const r = saveResult(normaliseResult([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]), out);
  assert.equal(readFileSync(out, 'utf8'), 'one\ntwo');
  assert.deepEqual(r.files.map((f) => [f.path, f.kind, f.bytes]), [[out, 'text', 7]]);
  assert.equal(r.files[0].sha, sha16('one\ntwo'));
});

test('save: a structuredContent JSON string is pretty-printed', () => {
  const d = fresh();
  const out = join(d, 'out.json');
  const r = saveResult(normaliseResult('{"rows":[1,2]}'), out);
  assert.equal(readFileSync(out, 'utf8'), JSON.stringify({ rows: [1, 2] }, null, 2));
  assert.equal(r.files[0].kind, 'json');
});

test('save: image copied from its [Image: source:] original, line dropped from text', () => {
  const d = fresh();
  const orig = join(d, 'orig.png');
  const png = Buffer.from('89504e47-original-bytes');
  writeFileSync(orig, png);
  const out = join(d, 'shot.txt');
  const r = saveResult(normaliseResult([
    { type: 'text', text: 'caption' },
    { type: 'image', data: Buffer.from('jpeg-recompressed').toString('base64'), mimeType: 'image/jpeg' },
    { type: 'text', text: `[Image: source: ${orig}]` },
  ]), out);
  assert.equal(readFileSync(out, 'utf8'), 'caption');
  const img = join(d, 'shot-img1.png');
  assert.deepEqual(readFileSync(img), png);
  assert.deepEqual(r.files.map((f) => [f.path, f.kind]), [[out, 'text'], [img, 'image/png']]);
});

test('save: image with no source path is decoded from base64', () => {
  const d = fresh();
  const out = join(d, 'pic.png');
  const raw = Buffer.from([1, 2, 3, 4]);
  const r = saveResult(normaliseResult([{ type: 'image', data: raw.toString('base64'), mimeType: 'image/png' }]), out);
  assert.equal(existsSync(out), false, 'no text, so no text file');
  assert.deepEqual(readFileSync(join(d, 'pic-img1.png')), raw);
  assert.equal(r.files.length, 1);
});

test('save: mixed result, several images numbered from 1, source line inside a longer block', () => {
  const d = fresh();
  const out = join(d, 'deck.json');
  const r = saveResult(normaliseResult([
    { type: 'text', text: '{"ok":true}' },
    { type: 'image', data: Buffer.from('a').toString('base64'), mimeType: 'image/png' },
    { type: 'image', data: Buffer.from('b').toString('base64'), mimeType: 'image/webp' },
    { type: 'text', text: 'note\n[Image: source: /no/such/file.png]' },
  ]), out);
  assert.equal(readFileSync(out, 'utf8'), '{"ok":true}\nnote');
  assert.deepEqual(readFileSync(join(d, 'deck-img1.png')), Buffer.from('a'), 'unreadable source falls back to base64');
  assert.deepEqual(readFileSync(join(d, 'deck-img2.webp')), Buffer.from('b'));
  assert.equal(r.files.length, 3);
  assert.ok(r.warnings.some((w) => w.includes('/no/such/file.png')));
});

test('save: a resource link line is saved as text and never followed', () => {
  const d = fresh();
  const out = join(d, 'link.txt');
  const line = '[Resource link: b.tar.gz] https://storage.googleapis.com/x/b.tar.gz?sig=abc (bundle)';
  const r = saveResult(normaliseResult([{ type: 'text', text: 'ready' }, { type: 'text', text: line }]), out);
  assert.equal(readFileSync(out, 'utf8'), `ready\n${line}`);
  assert.equal(r.files.length, 1);
  assert.deepEqual(readdirSync(d), ['link.txt']);
});

test('truncation marker: with a read_cache key, and without', () => {
  const key = 'a'.repeat(64);
  assert.deepEqual(detectTruncation(`x\n\n... [truncated by mcpproxy]\n\nUse read_cache tool: key="${key}", offset=0, limit=50`), { key });
  assert.deepEqual(detectTruncation('x\n\n... [truncated by mcpproxy, cache not available]'), { key: null });
  assert.equal(detectTruncation('fine'), null);

  const d = fresh();
  const r = saveResult(normaliseResult([{ type: 'text', text: `rows... [truncated by mcpproxy]\nUse read_cache tool: key="${key}"` }]), join(d, 'o.txt'));
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes(key));
  const r2 = saveResult(normaliseResult('partial [truncated by mcpproxy, cache not available]'), join(d, 'o2.txt'));
  assert.match(r2.warnings[0], /rest is lost/);
});

test('stub: one line per file with size, sha prefix and kind, plus warnings, no payload', () => {
  const stub = buildStub({
    files: [
      { path: '/abs/out.json', bytes: 307200, sha: 'ad7c7bed782c7790', kind: 'text' },
      { path: '/abs/out-img1.png', bytes: 188313, sha: 'f5760ae900000000', kind: 'image/png' },
    ],
    warnings: ['warning: x'],
  });
  assert.equal(stub, [
    'mcp-piper: saved 2 files',
    '- /abs/out.json (300.0 KB, sha256 ad7c7bed782c7790, text)',
    '- /abs/out-img1.png (183.9 KB, sha256 f5760ae900000000, image/png)',
    'warning: x',
  ].join('\n'));
  assert.match(buildStub({ files: [{ path: '/a', bytes: 1, sha: '0', kind: 'text' }] }), /^mcp-piper: saved 1 file\n/);
});

test('siblingPath keeps the stem and folder', () => {
  assert.equal(siblingPath('/a/b/out.json', 'img', 2, '.png'), '/a/b/out-img2.png');
  assert.equal(siblingPath('/a/noext', 'img', 1, '.jpg'), '/a/noext-img1.jpg');
});

// -------------------------------------------------------------------- state ---

test('state: write, read, delete under MCP_PIPER_STATE_DIR', () => {
  writeState('toolu_1', { saveTo: '/x', expanded: true });
  assert.ok(existsSync(join(stateDir(), 'toolu_1.json')));
  assert.deepEqual(readState('toolu_1'), { saveTo: '/x', expanded: true });
  assert.equal(deleteState('toolu_1'), true);
  assert.equal(readState('toolu_1'), null);
  assert.equal(deleteState('toolu_1'), false);
});

test('state: ids cannot escape the folder', () => {
  writeState('../../evil', { a: 1 });
  assert.deepEqual(readdirSync(stateDir()), ['.._.._evil.json']);
});

test('state: files older than 24 h are swept on write', () => {
  writeState('old', { a: 1 });
  const old = (Date.now() - 25 * 3600 * 1000) / 1000;
  utimesSync(join(stateDir(), 'old.json'), old, old);
  writeState('new', { a: 2 });
  assert.equal(readState('old'), null);
  assert.deepEqual(readState('new'), { a: 2 });
  assert.equal(sweepState(), 0);
});
