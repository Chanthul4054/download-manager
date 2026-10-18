'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const { SocksClient } = require('socks');
const { hostMatches, splitList, wildcardMatch } = require('../util');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function proxyAuthHeader(p) {
  return p.user ? 'Basic ' + Buffer.from(`${p.user}:${p.pass || ''}`).toString('base64') : null;
}

// Opens a raw TCP socket to target through an HTTP CONNECT proxy.
function connectTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    const auth = proxyAuthHeader(proxy);
    if (auth) headers['Proxy-Authorization'] = auth;
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${host}:${port}`, headers, timeout: timeoutMs });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
      } else resolve(socket);
    });
    req.once('timeout', () => req.destroy(new Error('Proxy connect timeout')));
    req.once('error', reject);
    req.end();
  });
}

async function connectSocks(proxy, host, port, timeoutMs) {
  const { socket } = await SocksClient.createConnection({
    proxy: { host: proxy.host, port: Number(proxy.port), type: proxy.version === 4 ? 4 : 5, userId: proxy.user || undefined, password: proxy.pass || undefined },
    command: 'connect',
    destination: { host, port: Number(port) },
    timeout: timeoutMs,
  });
  return socket;
}

// Agent whose sockets are created asynchronously through a proxy, keeping keep-alive pooling.
function makeTunnelAgent(Base, proxy, secure, timeoutMs) {
  const agent = new Base({ keepAlive: true, maxSockets: 64 });
  agent.createConnection = (options, cb) => {
    const host = options.host || options.hostname;
    const port = options.port || (secure ? 443 : 80);
    const open = proxy.type === 'socks' ? connectSocks(proxy, host, port, timeoutMs) : connectTunnel(proxy, host, port, timeoutMs);
    open.then((raw) => {
      if (!secure) return cb(null, raw);
      const s = tls.connect({ socket: raw, servername: options.servername || host, rejectUnauthorized: options.rejectUnauthorized !== false, ALPNProtocols: ['http/1.1'] });
      s.once('secureConnect', () => cb(null, s));
      s.once('error', (e) => cb(e));
    }, (e) => cb(e));
    return undefined;
  };
  return agent;
}

// Parses PAC/Chromium resolveProxy output: "PROXY h:p; SOCKS5 h:p; DIRECT".
function parseProxyString(str) {
  for (const part of String(str || 'DIRECT').split(';').map((s) => s.trim()).filter(Boolean)) {
    const [kind, addr] = part.split(/\s+/);
    if (/^DIRECT$/i.test(kind)) return { type: 'direct' };
    if (!addr) continue;
    const i = addr.lastIndexOf(':');
    const host = addr.slice(0, i), port = Number(addr.slice(i + 1));
    if (/^(PROXY|HTTP|HTTPS)$/i.test(kind)) return { type: 'http', host, port };
    if (/^SOCKS5?$/i.test(kind)) return { type: 'socks', host, port, version: 5 };
    if (/^SOCKS4$/i.test(kind)) return { type: 'socks', host, port, version: 4 };
  }
  return { type: 'direct' };
}

class NetContext {
  /**
   * @param {object} o
   * @param {() => object} o.getSettings
   * @param {(url: string) => Promise<string>} [o.resolveProxy] Chromium-style resolver for system/PAC modes.
   */
  constructor({ getSettings, resolveProxy }) {
    this.getSettings = getSettings;
    this.resolveProxy = resolveProxy || (async () => 'DIRECT');
    this.agents = new Map();
  }

  resetAgents() {
    for (const a of this.agents.values()) a.destroy();
    this.agents.clear();
  }

  async proxyFor(urlStr) {
    const s = this.getSettings().proxy;
    const u = new URL(urlStr);
    const bypass = splitList(s.bypass);
    if (bypass.some((b) => (b === '<local>' ? !u.hostname.includes('.') : hostMatches([b], u.hostname) || wildcardMatch(b + '*', urlStr)))) return { type: 'direct' };
    if (s.mode === 'none') return { type: 'direct' };
    if (s.mode === 'system' || s.mode === 'pac') return parseProxyString(await this.resolveProxy(urlStr));
    if (s.socks.enabled && s.socks.host) return { type: 'socks', ...s.socks };
    const p = u.protocol === 'https:' ? s.https : u.protocol === 'ftp:' ? s.ftp : s.http;
    if (p.enabled && p.host) return { type: 'http', ...p };
    return { type: 'direct' };
  }

  agentFor(proxy, secure) {
    const key = `${secure}|${proxy.type}|${proxy.host || ''}|${proxy.port || ''}|${proxy.user || ''}`;
    let a = this.agents.get(key);
    if (a) return a;
    const timeout = this.getSettings().connection.timeoutSec * 1000;
    if (proxy.type === 'direct') a = new (secure ? https : http).Agent({ keepAlive: true, maxSockets: 64 });
    else if (proxy.type === 'http' && !secure) a = new http.Agent({ keepAlive: true, maxSockets: 64 });
    else a = makeTunnelAgent(secure ? https.Agent : http.Agent, proxy, secure, timeout);
    this.agents.set(key, a);
    return a;
  }

  loginFor(urlStr) {
    const u = new URL(urlStr);
    if (u.username) return { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
    const target = u.host + u.pathname;
    const hit = (this.getSettings().siteLogins || []).find((l) => {
      const pat = l.server.replace(/^\w+:\/\//, '');
      return wildcardMatch(pat, u.host) || wildcardMatch(pat + '*', target) || wildcardMatch('*.' + pat, u.host);
    });
    return hit ? { user: hit.user, pass: hit.pass } : null;
  }

  /**
   * Single HTTP(S) request following redirects. Resolves with the response once headers arrive.
   * @returns {Promise<{res: http.IncomingMessage, url: string, req: http.ClientRequest}>}
   */
  async request(urlStr, opts = {}) {
    const { method = 'GET', headers = {}, auth, signal, maxRedirects = 10 } = opts;
    const settings = this.getSettings();
    const timeout = (opts.timeoutSec || settings.connection.timeoutSec) * 1000;
    let url = urlStr;
    let creds = auth || this.loginFor(url);
    let triedAuth = false;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (signal?.aborted) throw abortError();
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Unsupported protocol ' + u.protocol);
      const secure = u.protocol === 'https:';
      const proxy = await this.proxyFor(url);
      const h = {
        'User-Agent': settings.downloads.userAgent || DEFAULT_UA,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        ...headers,
      };
      if (creds && (triedAuth || auth)) h.Authorization = 'Basic ' + Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
      const reqOpts = {
        method,
        agent: this.agentFor(proxy, secure),
        headers: h,
        host: u.hostname,
        port: u.port || (secure ? 443 : 80),
        path: u.pathname + u.search,
        servername: u.hostname,
        timeout,
      };
      if (proxy.type === 'http' && !secure) {
        reqOpts.host = proxy.host;
        reqOpts.port = proxy.port;
        reqOpts.path = u.href;
        h.Host = u.host;
        const pa = proxyAuthHeader(proxy);
        if (pa) h['Proxy-Authorization'] = pa;
      }
      const { res, req } = await new Promise((resolve, reject) => {
        const req = (secure ? https : http).request(reqOpts);
        const onAbort = () => req.destroy(abortError());
        signal?.addEventListener('abort', onAbort, { once: true });
        req.once('response', (res) => {
          signal?.removeEventListener('abort', onAbort);
          resolve({ res, req });
        });
        req.once('timeout', () => req.destroy(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })));
        req.once('error', (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        });
        if (opts.body) req.end(opts.body);
        else req.end();
      });
      // Idle-read timeout on the body too.
      res.setTimeout?.(timeout, () => res.destroy(Object.assign(new Error('Read timed out'), { code: 'ETIMEDOUT' })));
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        url = new URL(res.headers.location, url).href;
        continue;
      }
      if (res.statusCode === 401 && creds && !triedAuth) {
        res.resume();
        triedAuth = true;
        hop--;
        continue;
      }
      if (res.statusCode === 401 && !creds) {
        res.resume();
        const err = new Error('Authorization required');
        err.code = 'EAUTH';
        err.realm = /realm="([^"]*)"/i.exec(res.headers['www-authenticate'] || '')?.[1] || '';
        throw err;
      }
      return { res, req, url };
    }
    throw new Error('Too many redirects');
  }

  // Fetches a full (small) body as a string/buffer — used by the grabber, HLS and probes.
  async fetchBuffer(url, opts = {}) {
    const { res, url: finalUrl } = await this.request(url, opts);
    if (res.statusCode >= 400) {
      res.resume();
      throw Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode });
    }
    const limit = opts.maxBytes || 32 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    for await (const c of res) {
      total += c.length;
      if (total > limit) {
        res.destroy();
        throw new Error('Response too large');
      }
      chunks.push(c);
    }
    return { body: Buffer.concat(chunks), headers: res.headers, status: res.statusCode, url: finalUrl };
  }

  // HEAD-like probe using a ranged GET (many servers mishandle HEAD).
  async probe(url, opts = {}) {
    const { res, url: finalUrl } = await this.request(url, { ...opts, headers: { ...(opts.headers || {}), Range: 'bytes=0-' } });
    res.destroy();
    const h = res.headers;
    let size = null;
    if (res.statusCode === 206 && h['content-range']) size = Number(h['content-range'].split('/')[1]) || null;
    else if (h['content-length']) size = Number(h['content-length']);
    return { status: res.statusCode, size, type: h['content-type'] || '', headers: h, url: finalUrl, resumable: res.statusCode === 206 };
  }
}

function abortError() {
  return Object.assign(new Error('Aborted'), { code: 'ABORT_ERR', name: 'AbortError' });
}

module.exports = { NetContext, parseProxyString, DEFAULT_UA, abortError };
