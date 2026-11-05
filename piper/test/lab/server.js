#!/usr/bin/env node
// Lab MCP server for the mcp-piper integration run (run-nested.mjs). No dependencies.
// Speaks MCP over stdio, one JSON-RPC message per line.
//
// Every tools/call is appended to the file named by LAB_LOG as one JSON line:
//   { run: $LAB_RUN, tool, args, sent }   (sent = sha256 prefix of an image it returned)
//
// Tools and what they return:
//   echo        text "LAB_ECHO_OK" + sha256 prefix and length of the arguments it got (never the arguments)
//   text        a short text block holding LAB_TEXT_NEEDLE
//   big_text    one text block of about 40,000 characters ending in LAB_BIG_NEEDLE
//   structured  a text block plus structuredContent holding LAB_STRUCT_NEEDLE
//   image       a text block plus a generated 16x16 PNG
//   link        a text block plus a resource_link to https://example.com/LAB_LINK_NEEDLE.bin
//   resources   a text block, embedded resources at relative uris (tab.md, images/dot.png, data/raw.bin)
//               and one at https://example.com/LAB_URL_RES.txt
//   fail        isError: true with LAB_FAIL_NEEDLE
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const LOG = process.env.LAB_LOG;
const RUN = process.env.LAB_RUN || '';
const sha16 = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const log = (o) => { if (LOG) appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), run: RUN, ...o })}\n`); };

// ------------------------------------------------------------------ png ---
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(size = 16) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) row.push((x * 16) & 255, (y * 16) & 255, 128);
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = makePng();

// ---------------------------------------------------------------- tools ---
const anyArgs = { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true };
// Typed schemas so the model sends a real object, array or number instead of a JSON string.
const schemas = {
  echo: { type: 'object', additionalProperties: true, properties: {
    text: { type: 'string' }, label: { type: 'string' },
    outer: { type: 'object', additionalProperties: true }, items: { type: 'array', items: { type: 'string' } } } },
  text_n: { type: 'object', additionalProperties: true, properties: { _save_to: { type: 'number' } } },
};
const tools = [
  ['echo', 'Records the arguments it receives and returns only their sha256 prefix and length.'],
  ['text', 'Returns a short text result.'],
  ['text_n', 'Same as text; its schema types _save_to as a number, to test the non-string deny.'],
  ['big_text', 'Returns a text result of about 40,000 characters.'],
  ['structured', 'Returns a JSON result as structuredContent.'],
  ['image', 'Returns a small PNG image.'],
  ['link', 'Returns a resource link.'],
  ['resources', 'Returns several files as embedded resources.'],
  ['fail', 'Always returns a tool error (isError true).'],
].map(([name, description]) => ({ name, description, inputSchema: schemas[name] ?? anyArgs }));

function call(name, a) {
  const t = (text) => ({ type: 'text', text });
  switch (name) {
    case 'echo': {
      const s = JSON.stringify(a ?? {});
      return { content: [t(`LAB_ECHO_OK sha=${sha16(s)} len=${s.length}`)] };
    }
    case 'text': case 'text_n': return { content: [t('LAB_TEXT_NEEDLE short result')] };
    case 'big_text': {
      const line = 'lab big text line, padding to make the result large enough to matter\n';
      return { content: [t(`${line.repeat(Math.ceil(40000 / line.length))}LAB_BIG_NEEDLE end`)] };
    }
    case 'structured': {
      const data = { needle: 'LAB_STRUCT_NEEDLE', rows: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }] };
      return { content: [t(JSON.stringify(data))], structuredContent: data };
    }
    case 'image':
      return { content: [t('LAB_IMAGE_CAPTION'), { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }] };
    case 'link':
      return { content: [t('LAB_LINK_CAPTION'), { type: 'resource_link', uri: 'https://example.com/LAB_LINK_NEEDLE.bin', name: 'LAB_LINK_NEEDLE.bin', mimeType: 'application/octet-stream' }] };
    case 'resources':
      return { content: [
        t('LAB_RES_CAPTION'),
        { type: 'resource', resource: { uri: 'tab.md', mimeType: 'text/markdown', text: '# LAB_RES_TEXT_NEEDLE\n' } },
        { type: 'resource', resource: { uri: 'images/dot.png', mimeType: 'image/png', blob: PNG.toString('base64') } },
        { type: 'resource', resource: { uri: 'data/raw.bin', mimeType: 'application/octet-stream', blob: Buffer.from('LAB_RES_BLOB_NEEDLE\x00\x01\xff', 'latin1').toString('base64') } },
        { type: 'resource', resource: { uri: 'https://example.com/LAB_URL_RES.txt', mimeType: 'text/plain', text: 'LAB_URL_RES_NEEDLE' } },
      ] };
    case 'fail':
      return { isError: true, content: [t('LAB_FAIL_NEEDLE: the tool failed on purpose')] };
    default: return null;
  }
}

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
function handle(m) {
  if (m.id === undefined) return;
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') {
    return ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'lab', version: '0.0.1' } });
  }
  if (m.method === 'tools/list') return ok({ tools });
  if (m.method === 'ping') return ok({});
  if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params || {};
    log({ tool: name, args: a, ...(name === 'image' || name === 'resources' ? { sent: sha16(PNG) } : {}) });
    const r = call(name, a);
    if (r) return ok(r);
  }
  return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) { try { handle(JSON.parse(line)); } catch { /* ignore bad lines */ } }
  }
});
