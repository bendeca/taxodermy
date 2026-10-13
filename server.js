#!/usr/bin/env node
/* Taxodermy - tiny local file server. No database, no dependencies (Node 18+).
 *
 *     node server.js [--port 8040] [--data ./data] [--no-open]
 *
 * Same behaviour as server.py: serves the app from this folder and stores everything
 * as plain files under data/<person>/<year>/. Listens on 127.0.0.1 only.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Built into a standalone program (see .github/workflows/release.yml), the app files sit next to the executable.
const STANDALONE = typeof Bun !== 'undefined' && /[\\/](\$bunfs|~BUN)[\\/]/.test(Bun.main);
const ROOT = STANDALONE ? path.dirname(process.execPath) : __dirname;
const SELF = STANDALONE ? path.basename(process.execPath) : 'node server.js';
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : dflt; };
const PORT = parseInt(arg('port', '8040'), 10);
const DATA = path.resolve(arg('data', path.join(ROOT, 'data')));
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const YEAR = /^(19|20)\d\d$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(pdf|json)$/;
const PERSON = /^(?=.*[a-z])[a-z0-9][a-z0-9-]{0,40}$/; // a folder name; never looks like a year
const SHARED = ['forms.json', 'people.json', 'rates.json'];
const MAX_BODY = 80 * 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

function send(req, res, code, body = '', type = 'application/json; charset=utf-8') {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) body = JSON.stringify(body);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : buf);
}
/* Only this machine's own browser tab may talk to us. */
function guard(req, res, write) {
  if (!HOSTS.has(req.headers.host || '')) { send(req, res, 403, { error: 'bad host' }); return false; }
  const origin = req.headers.origin;
  if (origin) { let host = ''; try { host = new URL(origin).host; } catch {} if (!HOSTS.has(host)) { send(req, res, 403, { error: 'bad origin' }); return false; } }
  if (write && req.headers['x-tax-forms'] !== '1') { send(req, res, 403, { error: 'missing header' }); return false; }
  return true;
}
function dataPath(parts) {
  if (parts.length === 1 && SHARED.includes(parts[0])) return path.join(DATA, parts[0]);
  if (parts.length === 3 && PERSON.test(parts[0]) && YEAR.test(parts[1]) && NAME.test(parts[2])) return path.join(DATA, ...parts);
  return null;
}
const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
function yearsIn(folder) {
  const years = {};
  for (const year of fs.readdirSync(folder).sort()) {
    const sub = path.join(folder, year);
    if (!YEAR.test(year) || !isDir(sub)) continue;
    years[year] = {};
    for (const n of fs.readdirSync(sub).sort()) if (NAME.test(n)) years[year][n] = fs.statSync(path.join(sub, n)).size;
  }
  return years;
}
function listing() {
  const people = {};
  if (isDir(DATA)) for (const entry of fs.readdirSync(DATA).sort()) { const folder = path.join(DATA, entry); if (PERSON.test(entry) && isDir(folder)) people[entry] = { years: yearsIn(folder) }; }
  // "legacy": year folders directly under data/, from before people were introduced
  const shared = SHARED.filter((n) => fs.existsSync(path.join(DATA, n)));
  return { people, legacy: isDir(DATA) ? Object.keys(yearsIn(DATA)).sort() : [], shared, folder: DATA };
}
/* Move year folders that sit directly under data/ into data/<person>/. */
function adopt(person) {
  const target = path.join(DATA, person);
  fs.mkdirSync(target, { recursive: true });
  const moved = [], skipped = [];
  for (const year of Object.keys(yearsIn(DATA)).sort()) {
    if (fs.existsSync(path.join(target, year))) skipped.push(year);
    else { fs.renameSync(path.join(DATA, year), path.join(target, year)); moved.push(year); }
  }
  return { ok: true, moved, skipped };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    let parts;
    try { parts = decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/').filter(Boolean); } catch { return send(req, res, 400, { error: 'bad url' }); }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!guard(req, res, false)) return;
      if (parts.join('/') === 'api/list') return send(req, res, 200, listing());
      let target = null;
      if (parts[0] === 'data') target = dataPath(parts.slice(1));
      else {
        const rel = parts.length ? parts : ['index.html'];
        const ok = rel.join('/') === 'index.html' || (rel[0] === 'assets' && rel.every((p) => /^\w[\w.-]*$/.test(p)));
        target = ok ? path.join(ROOT, ...rel) : null;
      }
      if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) return send(req, res, 404, { error: 'not found' });
      return send(req, res, 200, fs.readFileSync(target), TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream');
    }
    if (req.method === 'PUT') {
      if (!guard(req, res, true)) return;
      if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'people' && PERSON.test(parts[2])) {
        fs.mkdirSync(path.join(DATA, parts[2]), { recursive: true });
        return send(req, res, 200, { ok: true });
      }
      if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'years' && PERSON.test(parts[2]) && YEAR.test(parts[3])) {
        fs.mkdirSync(path.join(DATA, parts[2], parts[3]), { recursive: true });
        return send(req, res, 200, { ok: true });
      }
      if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'adopt' && PERSON.test(parts[2])) return send(req, res, 200, adopt(parts[2]));
      const target = parts[0] === 'data' ? dataPath(parts.slice(1)) : null;
      if (!target || Number(req.headers['content-length'] || 0) > MAX_BODY) return send(req, res, 400, { error: 'bad path or file too large' });
      const body = await readBody(req);
      if (target.endsWith('.pdf') && body.subarray(0, 4).toString('latin1') !== '%PDF') return send(req, res, 400, { error: 'not a PDF' });
      if (target.endsWith('.json')) { try { JSON.parse(body.toString('utf8')); } catch { return send(req, res, 400, { error: 'not valid JSON' }); } }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = path.join(path.dirname(target), `.tmp-${process.pid}-${Date.now()}`);
      fs.writeFileSync(tmp, body); // write beside, then swap in: never a half-written file
      fs.renameSync(tmp, target);
      process.stderr.write(`PUT ${req.url}\n`);
      return send(req, res, 200, { ok: true, bytes: body.length });
    }
    if (req.method === 'DELETE') {
      if (!guard(req, res, true)) return;
      const target = parts[0] === 'data' && parts.length === 4 ? dataPath(parts.slice(1)) : null;
      if (!target) return send(req, res, 400, { error: 'bad path' });
      if (fs.existsSync(target)) fs.unlinkSync(target);
      process.stderr.write(`DELETE ${req.url}\n`);
      return send(req, res, 200, { ok: true });
    }
    send(req, res, 405, { error: 'method not allowed' });
  } catch (err) {
    send(req, res, 500, { error: String(err && err.message || err) });
  }
});

fs.mkdirSync(DATA, { recursive: true });
/* Started by double-click, the window would close before the message can be read. */
function fail(msg) {
  console.error(msg);
  if (!STANDALONE || !process.stdin.isTTY) process.exit(1);
  console.error('Press Enter to close.');
  process.stdin.once('data', () => process.exit(1));
}
server.on('error', (err) => fail(`Could not start on port ${PORT} (${err.message}). Is Taxodermy already running? Otherwise try: ${SELF} --port 8041`));
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Taxodermy is running at ${url}\nData folder: ${DATA}\nPress Ctrl+C to stop.`);
  if (!process.argv.includes('--no-open')) {
    const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    try { execFile(cmd[0], cmd[1], () => {}).on('error', () => {}); } catch {}
  }
});
