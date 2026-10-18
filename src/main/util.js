'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ILLEGAL = /[<>:"/\\|?*\x00-\x1F]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function sanitizeFileName(name) {
  let n = String(name || '').replace(ILLEGAL, '_').replace(/[. ]+$/, '').trim();
  if (!n) n = 'download';
  if (RESERVED.test(n)) n = '_' + n;
  if (n.length > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}

// RFC 6266 / 5987 Content-Disposition filename parsing.
function fileNameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      const v = star[2].trim().replace(/^"|"$/g, '');
      return star[1] && !/utf-?8/i.test(star[1])
        ? Buffer.from(unescape(v), 'latin1').toString('latin1')
        : decodeURIComponent(v);
    } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*("((?:\\.|[^"\\])*)"|[^;]+)/i.exec(header);
  if (plain) {
    let v = plain[2] !== undefined ? plain[2].replace(/\\(.)/g, '$1') : plain[1].trim();
    // Many servers send raw UTF-8 bytes that Node decodes as latin1.
    try {
      const re = Buffer.from(v, 'latin1').toString('utf8');
      if (!re.includes('\uFFFD')) v = re;
    } catch { /* keep */ }
    return v;
  }
  return null;
}

function fileNameFromUrl(u) {
  try {
    const url = new URL(u);
    const seg = url.pathname.split('/').filter(Boolean).pop() || '';
    const dec = decodeURIComponent(seg);
    return dec || url.hostname;
  } catch {
    return null;
  }
}

const MIME_EXT = {
  'application/zip': '.zip', 'application/x-rar-compressed': '.rar', 'application/vnd.rar': '.rar',
  'application/x-7z-compressed': '.7z', 'application/pdf': '.pdf', 'application/x-msdownload': '.exe',
  'application/x-msi': '.msi', 'application/gzip': '.gz', 'application/x-tar': '.tar',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/quicktime': '.mov',
  'video/mp2t': '.ts', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'audio/webm': '.weba', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'text/html': '.html', 'text/plain': '.txt', 'application/json': '.json', 'application/octet-stream': '',
  'application/vnd.apple.mpegurl': '.ts', 'application/x-mpegurl': '.ts',
};

function extForMime(mime) {
  if (!mime) return '';
  return MIME_EXT[String(mime).split(';')[0].trim().toLowerCase()] || '';
}

function extOf(name) {
  return path.extname(String(name || '')).replace(/^\./, '').toLowerCase();
}

// Glob with only `*` (any run) and `?` (one char), case-insensitive.
function wildcardToRegExp(pattern) {
  const esc = String(pattern).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + esc + '$', 'i');
}

function wildcardMatch(pattern, value) {
  return wildcardToRegExp(pattern).test(String(value || ''));
}

function hostMatches(patterns, host) {
  if (!host) return false;
  return splitList(patterns).some((p) => wildcardMatch(p, host) || wildcardMatch('*.' + p, host));
}

function splitList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

async function uniquePath(p, taken = new Set()) {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  let candidate = p;
  for (let i = 2; ; i++) {
    const exists = taken.has(candidate.toLowerCase()) || (await fs.promises.access(candidate).then(() => true, () => false));
    if (!exists) return candidate;
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
}

function formatBytes(n) {
  if (n == null || n < 0 || !isFinite(n)) return '';
  const u = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 1 : 2)) + ' ' + u[i];
}

function id() {
  return crypto.randomBytes(8).toString('hex');
}

// Expand a batch pattern containing a single `*` into URLs.
// from/to are letters (a..z) or numbers; width zero-pads numbers.
function expandBatch(pattern, from, to, width = 0) {
  const out = [];
  if (!pattern.includes('*')) return [pattern];
  const isNum = /^\d+$/.test(String(from)) && /^\d+$/.test(String(to));
  if (isNum) {
    let a = parseInt(from, 10), b = parseInt(to, 10);
    const step = a <= b ? 1 : -1;
    if (Math.abs(b - a) > 100000) throw new Error('Batch range too large');
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
      out.push(pattern.replace('*', String(i).padStart(width, '0')));
    }
  } else {
    const a = String(from).charCodeAt(0), b = String(to).charCodeAt(0);
    const step = a <= b ? 1 : -1;
    for (let c = a; step > 0 ? c <= b : c >= b; c += step) out.push(pattern.replace('*', String.fromCharCode(c)));
  }
  return out;
}

const URL_RE = /\b(?:https?|ftp):\/\/[^\s"'<>`]+/gi;
function extractUrls(text) {
  const set = new Set();
  for (const m of String(text || '').matchAll(URL_RE)) set.add(m[0].replace(/[),.;\]]+$/, ''));
  return [...set];
}

async function writeJsonAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.promises.rename(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function moveFile(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
  }
}

module.exports = {
  sanitizeFileName, fileNameFromDisposition, fileNameFromUrl, extForMime, extOf, wildcardMatch,
  wildcardToRegExp, hostMatches, splitList, uniquePath, formatBytes, id, expandBatch, extractUrls,
  writeJsonAtomic, readJson, moveFile,
};
