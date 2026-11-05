#!/usr/bin/env node
// mcp-piper integration run: real nested Claude Code sessions against the lab server.
// It costs model calls, so it is NOT part of `npm test`. Run it by hand from the repo root:
//
//   node piper/test/lab/run-nested.mjs --out tmp/lab-run            # every lab case
//   node piper/test/lab/run-nested.mjs --out tmp/lab-run ptr-text deny-folder
//   node piper/test/lab/run-nested.mjs --list
//
// Each case runs `claude -p --plugin-dir <repo> --model haiku` with an --mcp-config for
// server.js and --allowedTools naming the lab tools, then reads the session transcript
// under ~/.claude/projects/ and checks needle strings:
//   use    the model's tool_use input (it should hold the pointer, not the bytes)
//   server what the lab server logged as received (it should hold the bytes)
//   result the tool_result the model got (it should hold the stub, not the payload)
//   ctx    hook context that reached the model (attachment / api-request-blob records)
// Evidence per case lands in <out>/<case>/: stream.jsonl, transcript copies, server log,
// checks.txt. A summary table goes to <out>/results.md. Options: --model, --jobs (default 4).
import { spawn } from 'node:child_process';
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..', '..');
const SERVER = join(here, 'server.js');
const sha16 = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const LAB = ['echo', 'text', 'text_n', 'big_text', 'structured', 'image', 'link', 'fail'].map((t) => `mcp__lab__${t}`);
const STUB = 'mcp-piper: saved';
const NOTE = 'mcp-piper is active for MCP tools';
const TIP = 'mcp-piper: next time pass large text as';

// ----------------------------------------------------------------- cases ---
// setup(dir) writes fixtures and returns values used in the prompt and checks.
// Each check is [label, kind, needle, expectPresent] or [label, fn] where fn(ctx) -> [ok, evidence].
const one = (tool, input) => `Call the tool ${tool} exactly once with exactly this JSON input, copied character for character:\n${JSON.stringify(input)}\nThen reply with the tool result verbatim, or the exact error text if the call fails. Do not call any other tool.`;
const fileHas = (p, s) => (c) => {
  const ok = existsSync(p) && readFileSync(p, 'utf8').includes(s);
  return [ok, `${p}${ok ? ' contains' : ' lacks'} ${s}`];
};
const noFile = (p) => () => [!existsSync(p), `${p} ${existsSync(p) ? 'exists' : 'absent'}`];
const noServerCall = (c) => [c.server.length === 0, `${c.serverLog}: ${c.server.length} calls`];

function payloadFile(dir, name, tag) {
  const p = join(dir, name);
  writeFileSync(p, `PAYLOAD_${tag}_${'x'.repeat(200)}\nsecond line\n`);
  return p;
}

const CASES = {
  'ptr-text': (d) => {
    const p = payloadFile(d, 'in.txt', 'TEXT_alpha');
    return { prompt: one('mcp__lab__echo', { text: `@file:${p}` }), checks: [
      ['use holds pointer', 'use', `@file:${p}`, true], ['use lacks bytes', 'use', 'PAYLOAD_TEXT_alpha', false],
      ['server got bytes', 'server', 'PAYLOAD_TEXT_alpha', true], ['result lacks bytes', 'result', 'PAYLOAD_TEXT_alpha', false],
      ['result is echo', 'result', 'LAB_ECHO_OK', true]] };
  },
  'ptr-relative': (d) => {
    payloadFile(d, 'rel.txt', 'REL_beta');
    return { prompt: one('mcp__lab__echo', { text: '@file:rel.txt' }), checks: [
      ['use holds pointer', 'use', '@file:rel.txt', true], ['server got bytes', 'server', 'PAYLOAD_REL_beta', true],
      ['result lacks bytes', 'result', 'PAYLOAD_REL_beta', false]] };
  },
  'ptr-base64': (d) => {
    const p = join(d, 'bin.dat');
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, ...Buffer.from('B64_gamma')]);
    writeFileSync(p, bytes);
    const b64 = bytes.toString('base64');
    return { prompt: one('mcp__lab__echo', { data: `@file64:${p}` }), checks: [
      ['use holds pointer', 'use', `@file64:${p}`, true], ['use lacks base64', 'use', b64, false],
      ['server got base64', 'server', b64, true], ['result lacks base64', 'result', b64, false]] };
  },
  'ptr-nested-object': (d) => {
    const p = payloadFile(d, 'deep.txt', 'DEEP_delta');
    return { prompt: one('mcp__lab__echo', { outer: { inner: { body: `@file:${p}` } }, label: 'x' }), checks: [
      ['use holds pointer', 'use', `@file:${p}`, true], ['server got bytes', 'server', 'PAYLOAD_DEEP_delta', true],
      ['result lacks bytes', 'result', 'PAYLOAD_DEEP_delta', false]] };
  },
  'ptr-array': (d) => {
    const p = payloadFile(d, 'arr.txt', 'ARR_epsilon');
    return { prompt: one('mcp__lab__echo', { items: ['plain', `@file:${p}`] }), checks: [
      ['use holds pointer', 'use', `@file:${p}`, true], ['server got bytes', 'server', 'PAYLOAD_ARR_epsilon', true],
      ['server kept plain item', 'server', '"plain"', true], ['result lacks bytes', 'result', 'PAYLOAD_ARR_epsilon', false]] };
  },
  'ptr-escape': () => ({ prompt: one('mcp__lab__echo', { text: '@@file:/nowhere/LITERAL_zeta' }), checks: [
    ['use holds escape', 'use', '@@file:/nowhere/LITERAL_zeta', true],
    ['server got one @', 'server', '"@file:/nowhere/LITERAL_zeta"', true],
    ['not denied', 'result', 'LAB_ECHO_OK', true]] }),
  'deny-missing': (d) => ({ prompt: one('mcp__lab__echo', { text: `@file:${join(d, 'missing.txt')}` }), checks: [
    ['result says not found', 'result', 'mcp-piper: file not found', true], ['server not called', noServerCall]] }),
  'deny-unreadable': (d) => {
    const p = payloadFile(d, 'locked.txt', 'LOCKED_eta');
    chmodSync(p, 0o000);
    return { prompt: one('mcp__lab__echo', { text: `@file:${p}` }), checks: [
      ['result says cannot read', 'result', 'mcp-piper: cannot read', true], ['server not called', noServerCall]] };
  },
  'deny-folder': (d) => {
    mkdirSync(join(d, 'adir'), { recursive: true });
    return { prompt: one('mcp__lab__echo', { text: `@file:${join(d, 'adir')}` }), checks: [
      ['result says folder', 'result', 'is a folder', true], ['server not called', noServerCall]] };
  },
  'deny-saveto-type': () => ({ prompt: one('mcp__lab__text_n', { _save_to: 42 }), checks: [
    ['result says must be string', 'result', 'mcp-piper: _save_to must be a file path string', true], ['server not called', noServerCall]] }),
  'deny-saveto-blocked': (d) => {
    writeFileSync(join(d, 'blocker'), 'a file where a folder should be');
    return { prompt: one('mcp__lab__text', { _save_to: join(d, 'blocker', 'sub', 'out.txt') }), checks: [
      ['result says cannot create', 'result', 'mcp-piper: cannot create the folder', true], ['server not called', noServerCall]] };
  },
  'save-text': (d) => {
    const o = join(d, 'out', 'text.txt');
    return { prompt: one('mcp__lab__text', { _save_to: o }), checks: [
      ['result is stub', 'result', `${STUB} 1 file\n- ${o}`, true], ['result lacks payload', 'result', 'LAB_TEXT_NEEDLE', false],
      ['server lacks _save_to', 'server', '_save_to', false], ['file has payload', fileHas(o, 'LAB_TEXT_NEEDLE')]] };
  },
  'save-big': (d) => {
    const o = join(d, 'out', 'big.txt');
    return { prompt: one('mcp__lab__big_text', { _save_to: o }), checks: [
      ['result is stub', 'result', STUB, true], ['result lacks payload', 'result', 'LAB_BIG_NEEDLE', false],
      ['file has payload', fileHas(o, 'LAB_BIG_NEEDLE end')]] };
  },
  'save-structured': (d) => {
    const o = join(d, 'out', 'struct.json');
    return { prompt: one('mcp__lab__structured', { _save_to: o }), checks: [
      ['result is stub', 'result', STUB, true], ['result lacks payload', 'result', 'LAB_STRUCT_NEEDLE', false],
      ['file has payload', fileHas(o, 'LAB_STRUCT_NEEDLE')]] };
  },
  'save-image': (d) => {
    const o = join(d, 'out', 'pic.txt');
    const img = join(d, 'out', 'pic-img1.png');
    return { prompt: one('mcp__lab__image', { _save_to: o }), checks: [
      ['result is stub', 'result', `- ${img}`, true], ['result has no image block', 'resultRaw', '"type":"image"', false],
      ['image file is the original bytes', (c) => {
        const sent = c.server.find((r) => r.tool === 'image')?.sent;
        const got = existsSync(img) ? sha16(readFileSync(img)) : null;
        return [Boolean(sent) && sent === got, `server sent ${sent}, ${img} sha ${got}`];
      }], ['caption saved', fileHas(o, 'LAB_IMAGE_CAPTION')]] };
  },
  'save-link': (d) => {
    const o = join(d, 'out', 'link.txt');
    return { prompt: one('mcp__lab__link', { _save_to: o }), checks: [
      ['result is stub', 'result', STUB, true], ['result lacks link', 'result', 'LAB_LINK_NEEDLE', false],
      ['link saved as text', fileHas(o, 'https://example.com/LAB_LINK_NEEDLE.bin')]] };
  },
  'save-error': (d) => {
    const o = join(d, 'out', 'err.txt');
    return { prompt: one('mcp__lab__fail', { _save_to: o }), checks: [
      ['error reaches model', 'result', 'LAB_FAIL_NEEDLE', true], ['no stub', 'result', STUB, false],
      ['nothing saved', noFile(o)], ['server got call', 'server', '"tool":"fail"', true],
      ['state cleaned', (c) => { const left = existsSync(c.stateDir) ? readdirSync(c.stateDir).filter((f) => f.endsWith('.json')) : []; return [left.length === 0, `${c.stateDir}: ${left.length} files left`]; }]] };
  },
  'nudge-inline': () => {
    const body = Array.from({ length: 1100 }, (_, i) => `row ${String(i).padStart(4, '0')} lorem ipsum`).join('\n');
    return { prompt: `Call the tool mcp__lab__echo exactly once with input {"text": <the full text between the markers below, every line, exactly>}. Do not shorten it.\n<<<BEGIN\n${body}\nEND>>>\nAfter the call, if you received any note or tip from a hook about how to pass large text, quote it verbatim; otherwise say NO_TIP.`,
      checks: [['input was over 20,000 chars', (c) => { const n = Math.max(0, ...c.uses.map((u) => JSON.stringify(u.input).length)); return [n > 20000, `longest tool_use input ${n} chars`]; }],
        ['tip reached model', 'ctx', TIP, true], ['model quoted tip', 'final', 'next time pass large text', true]] };
  },
  'session-note': () => ({ prompt: 'Without calling any tool: is there a note in your context that starts with "mcp-piper is active"? If yes, quote its first sentence verbatim. If no, say NO_NOTE.',
    tools: [], checks: [['note in context', 'ctx', NOTE, true], ['model quoted note', 'final', NOTE, true]] }),
  'context-lab-coexist': (d) => {
    const o = join(d, 'out', 'cl.txt');
    return { prompt: one('mcp__lab__text', { _save_to: o }), checks: [
      ['result is stub', 'result', STUB, true], ['token tracker line reached model', 'ctx', 'PostToolUse:mcp__lab__text hook additional context: Context:', true],
      ['file has payload', fileHas(o, 'LAB_TEXT_NEEDLE')]] };
  },
  'subagent': (d) => {
    const p = payloadFile(d, 'sub.txt', 'SUB_theta');
    const o = join(d, 'out', 'sub.txt');
    return { tools: ['Agent', 'Task'], prompt: `Use the Agent tool exactly once to start a general-purpose subagent with this task, passed word for word:\n"Make exactly two tool calls, one after the other. First call mcp__lab__echo with input ${JSON.stringify({ text: `@file:${p}` })}. Then call mcp__lab__text with input ${JSON.stringify({ _save_to: o })}. Reply with both tool results verbatim."\nDo not call any lab tool yourself. Reply with what the subagent reported.`,
      checks: [['subagent transcript exists', (c) => [c.subs.length > 0, `${c.subs.length} subagent transcripts`]],
        ['sub use holds pointer', 'subUse', `@file:${p}`, true], ['sub use lacks bytes', 'subUse', 'PAYLOAD_SUB_theta', false],
        ['server got bytes', 'server', 'PAYLOAD_SUB_theta', true], ['sub result is stub', 'subResult', STUB, true],
        ['sub result lacks payload', 'subResult', 'LAB_TEXT_NEEDLE', false], ['file has payload', fileHas(o, 'LAB_TEXT_NEEDLE')],
        ['note reached subagent', 'subCtx', NOTE, true]] };
  },
};

// ------------------------------------------------------------ transcript ---
function findTranscript(sid) {
  const root = join(homedir(), '.claude', 'projects');
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sid}.jsonl`);
    if (existsSync(f)) return { main: f, subDir: join(root, d, sid, 'subagents') };
  }
  return null;
}

function parse(file) {
  const out = { uses: [], results: [], ctx: [], file };
  readFileSync(file, 'utf8').split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    let r; try { r = JSON.parse(l); } catch { return; }
    const line = i + 1;
    const content = Array.isArray(r.message?.content) ? r.message.content : [];
    if (r.type === 'assistant') for (const b of content) if (b.type === 'tool_use') out.uses.push({ line, name: b.name, input: b.input, text: JSON.stringify(b.input) });
    if (r.type === 'user') for (const b of content) if (b.type === 'tool_result') out.results.push({ line, text: typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text ?? '').join('\n'), raw: JSON.stringify(b.content) });
    if (r.type === 'attachment' || r.type === 'api-request-blob' || r.type === 'system') out.ctx.push({ line, text: l });
  });
  return out;
}

// ------------------------------------------------------------------ run ---
function runClaude(args, cwd, env, streamFile) {
  return new Promise((res) => {
    const p = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { writeFileSync(streamFile, out); writeFileSync(`${streamFile}.stderr`, err); res(code); });
  });
}

async function runCase(name, opts) {
  const dir = join(opts.out, name);
  if (existsSync(dir)) { try { chmodSync(join(dir, 'work', 'locked.txt'), 0o600); } catch { /* none */ } rmSync(dir, { recursive: true, force: true }); }
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const spec = CASES[name](work);
  const serverLog = join(dir, 'server-received.jsonl');
  const stateDir = join(dir, 'state');
  const mcp = join(dir, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { lab: { command: process.execPath, args: [SERVER], env: { LAB_LOG: serverLog, LAB_RUN: name } } } }));
  const tools = [...LAB, ...(spec.tools || [])];
  const args = ['-p', spec.prompt, '--output-format', 'stream-json', '--verbose', '--model', opts.model,
    '--plugin-dir', REPO, '--mcp-config', mcp, '--strict-mcp-config', '--permission-mode', 'default',
    '--allowedTools', tools.join(',')];
  const env = { ...process.env, MCP_PIPER_STATE_DIR: stateDir };
  const code = await runClaude(args, work, env, join(dir, 'stream.jsonl'));
  const stream = readFileSync(join(dir, 'stream.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const init = stream.find((x) => x.type === 'system' && x.subtype === 'init') || {};
  const result = stream.find((x) => x.type === 'result') || {};
  const lines = [`case ${name} exit=${code} session=${init.session_id} plugins=${JSON.stringify((init.plugins || []).map((p) => p.name))}`];
  const t = init.session_id && findTranscript(init.session_id);
  const ctx = { server: [], serverLog, stateDir, uses: [], subs: [], final: result.result || '' };
  if (existsSync(serverLog)) ctx.server = readFileSync(serverLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let main = { uses: [], results: [], ctx: [], file: '(no transcript)' };
  if (t) {
    const copy = join(dir, 'transcript.jsonl');
    copyFileSync(t.main, copy);
    main = parse(copy);
    if (existsSync(t.subDir)) {
      for (const s of readdirSync(t.subDir).filter((f) => f.endsWith('.jsonl'))) {
        const c = join(dir, `sub-${s}`);
        copyFileSync(t.subDir + '/' + s, c);
        ctx.subs.push(parse(c));
      }
    }
  }
  ctx.uses = main.uses;
  const pick = {
    use: () => main.uses.filter((u) => u.name.startsWith('mcp__lab__')).map((u) => ({ ...u, f: main.file })),
    result: () => main.results.map((r) => ({ ...r, f: main.file })),
    resultRaw: () => main.results.map((r) => ({ line: r.line, text: r.raw, f: main.file })),
    ctx: () => main.ctx.map((r) => ({ ...r, f: main.file })),
    server: () => ctx.server.map((r, i) => ({ line: i + 1, text: JSON.stringify(r), f: serverLog })),
    final: () => [{ line: 0, text: ctx.final, f: join(dir, 'stream.jsonl') + ' result' }],
    subUse: () => ctx.subs.flatMap((s) => s.uses.filter((u) => u.name.startsWith('mcp__lab__')).map((u) => ({ ...u, f: s.file }))),
    subResult: () => ctx.subs.flatMap((s) => s.results.map((r) => ({ ...r, f: s.file }))),
    subCtx: () => ctx.subs.flatMap((s) => s.ctx.map((r) => ({ ...r, f: s.file }))),
  };
  let pass = true;
  for (const c of spec.checks) {
    let ok; let ev;
    if (typeof c[1] === 'function') [ok, ev] = c[1](ctx);
    else {
      const [, kind, needle, want] = c;
      const recs = pick[kind]();
      const hits = recs.filter((r) => r.text.includes(needle));
      ok = want ? hits.length > 0 : hits.length === 0 && recs.length > 0;
      const where = hits.length ? hits.slice(0, 3).map((h) => `${h.f}:${h.line}`).join(', ') : `${recs.length} ${kind} records searched`;
      ev = `${want ? 'has' : 'lacks'} ${JSON.stringify(needle.slice(0, 60))}: ${hits.length} hits; ${where}`;
    }
    pass = pass && ok;
    lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${c[0]} | ${ev}`);
  }
  lines.push(`  final: ${JSON.stringify(ctx.final.slice(0, 300))}`);
  writeFileSync(join(dir, 'checks.txt'), `${lines.join('\n')}\n`);
  try { chmodSync(join(work, 'locked.txt'), 0o600); } catch { /* none */ }
  return { name, pass, lines };
}

async function main(argv) {
  const opts = { out: null, model: 'haiku', jobs: 4 };
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--jobs') opts.jobs = Number(argv[++i]);
    else if (a === '--list') { console.log(Object.keys(CASES).join('\n')); return 0; }
    else names.push(a);
  }
  if (!opts.out) { console.error('usage: run-nested.mjs --out <dir> [--model haiku] [--jobs 4] [case ...] | --list'); return 2; }
  const todo = names.length ? names : Object.keys(CASES);
  for (const n of todo) if (!CASES[n]) { console.error(`unknown case ${n}`); return 2; }
  mkdirSync(opts.out, { recursive: true });
  const results = [];
  const queue = [...todo];
  await Promise.all(Array.from({ length: Math.min(opts.jobs, queue.length) }, async () => {
    while (queue.length) {
      const r = await runCase(queue.shift(), opts);
      console.log([`${r.pass ? 'PASS' : 'FAIL'} ${r.name}`, ...r.lines.filter((l) => l.startsWith('  FAIL'))].join('\n'));
      results.push(r);
    }
  }));
  const table = ['| case | result | evidence |', '|---|---|---|', ...todo.map((n) => {
    const r = results.find((x) => x.name === n);
    return `| ${n} | ${r.pass ? 'PASS' : 'FAIL'} | ${join(opts.out, n, 'checks.txt')} |`;
  })];
  appendFileSync(join(opts.out, 'results.md'), `\n## ${new Date().toISOString()}\n\n${table.join('\n')}\n`);
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} cases passed`);
  return results.every((r) => r.pass) ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
