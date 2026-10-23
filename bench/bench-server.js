'use strict';
// Local test server for download benchmarks. Started as a child process by download-bench.js so
// its CPU time is not counted against the downloader.
//
//   GET /file/<bytes>[?norange][&rate=<bytes per second per connection>][&badrange][&truncate]
//   GET /hash/<bytes>                → sha256 of /file/<bytes>
//   GET /redirect/<n>/<rest>         → n redirects, then /<rest>
//   GET /status/<code>               → that status (429 sends Retry-After: 1)
//
// Every file is a prefix of one random buffer, so data written at a wrong offset fails the hash.
const http = require('http');
const crypto = require('crypto');

const MAX = Number(process.env.BENCH_MAX_BYTES || 512 * 1024 * 1024);
const DATA = crypto.randomBytes(MAX);
const hashes = new Map();
const hits = { requests: 0, ranged: 0 };
// Per-URL counter so /flaky/ can fail the first N requests.
const flaky = new Map();

function hashOf(n) {
  if (!hashes.has(n)) hashes.set(n, crypto.createHash('sha256').update(DATA.subarray(0, n)).digest('hex'));
  return hashes.get(n);
}

// cut: drop the connection after `body` instead of ending the response (a truncated transfer).
function send(res, body, rate, cut = false) {
  const CH = Number(process.env.BENCH_CHUNK || 64 * 1024);
  let i = 0;
  const started = Date.now();
  const pump = () => {
    while (i < body.length && !res.destroyed) {
      if (rate) {
        // Pace this connection to `rate` bytes per second.
        const due = started + (i / rate) * 1000;
        const wait = due - Date.now();
        if (wait > 2) return setTimeout(pump, wait);
      }
      const chunk = body.subarray(i, i + CH);
      i += chunk.length;
      if (!res.write(chunk)) return res.once('drain', pump);
    }
    if (res.destroyed) return;
    if (cut) res.socket.destroy();
    else res.end();
  };
  pump();
}

const server = http.createServer((req, res) => {
  hits.requests++;
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'stats') return res.end(JSON.stringify(hits));
  if (parts[0] === 'hash') return res.end(hashOf(Number(parts[1])));
  if (parts[0] === 'redirect') {
    const n = Number(parts[1]);
    const rest = parts.slice(2).join('/') + url.search;
    res.writeHead(302, { Location: n > 1 ? `/redirect/${n - 1}/${rest}` : `/${rest}` });
    return res.end();
  }
  if (parts[0] === 'status') {
    const code = Number(parts[1]);
    res.writeHead(code, code === 429 ? { 'Retry-After': '1' } : {});
    return res.end();
  }
  if (parts[0] === 'flaky') {
    // /flaky/<failures>/<code>/file/<bytes>: the first <failures> requests get <code>.
    const key = req.url;
    const n = (flaky.get(key) || 0) + 1;
    flaky.set(key, n);
    if (n <= Number(parts[1])) {
      res.writeHead(Number(parts[2]), Number(parts[2]) === 429 ? { 'Retry-After': '1' } : {});
      return res.end();
    }
    parts.splice(0, 3);
  }
  if (parts[0] !== 'file') {
    res.writeHead(404);
    return res.end();
  }
  const size = Math.min(MAX, Number(parts[1]));
  const rate = Number(url.searchParams.get('rate')) || 0;
  const body = DATA.subarray(0, size);
  const headers = { 'Content-Type': 'application/octet-stream', ETag: `"${size}"`, 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' };
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m && !url.searchParams.has('norange')) {
    hits.ranged++;
    let a = Number(m[1]);
    const b = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (a >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    // A broken server that ignores the requested start but still answers 206.
    if (url.searchParams.has('badrange')) a = 0;
    res.writeHead(206, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
    const slice = body.subarray(a, b + 1);
    const cut = url.searchParams.has('truncate') && a === 0 && !flaky.has('cut:' + req.url);
    if (cut) flaky.set('cut:' + req.url, 1);
    return send(res, cut ? slice.subarray(0, slice.length >> 1) : slice, rate, cut);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  const cut = url.searchParams.has('truncate') && !flaky.has('cut:' + req.url);
  if (cut) flaky.set('cut:' + req.url, 1);
  send(res, cut ? body.subarray(0, size >> 1) : body, rate, cut);
});

server.listen(0, '127.0.0.1', () => process.send?.({ port: server.address().port }));
process.on('disconnect', () => process.exit(0));
