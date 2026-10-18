'use strict';
const http = require('http');
const { EventEmitter } = require('events');

/**
 * Localhost endpoint used by the browser extension.
 * Requests must come from an extension origin and carry `X-OpenDM: 1`, which forces a CORS
 * preflight that we never approve — so ordinary web pages cannot drive the app.
 * Emits: download(payload) · links(payload)
 */
class IntegrationServer extends EventEmitter {
  constructor(getSettings, version) {
    super();
    this.getSettings = getSettings;
    this.version = version;
    this.server = null;
  }

  allowed(req) {
    const origin = req.headers.origin || '';
    if (origin && !/^(chrome|moz|ms-browser|safari-web)-extension:\/\//.test(origin) && !/^extension:\/\//.test(origin)) return false;
    return req.headers['x-opendm'] === '1';
  }

  config() {
    const s = this.getSettings();
    return {
      app: 'OpenDM',
      version: this.version,
      enabled: s.general.browserIntegration,
      captureTypes: s.fileTypes.capture,
      excludedSites: s.fileTypes.excludedSites,
      excludedAddresses: s.fileTypes.excludedAddresses,
      forceKey: s.general.forceKey,
      preventKey: s.general.preventKey,
      contextMenu: s.general.contextMenu,
      videoPanel: s.videoPanel,
    };
  }

  start() {
    this.stop();
    const port = this.getSettings().general.integrationPort;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('error', (e) => this.emit('error', e));
    this.server.listen(port, '127.0.0.1');
  }

  stop() {
    this.server?.close();
    this.server = null;
  }

  send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  async handle(req, res) {
    if (!this.allowed(req)) return this.send(res, 403, { error: 'forbidden' });
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/api/ping') return this.send(res, 200, { app: 'OpenDM', version: this.version });
    if (req.method === 'GET' && path === '/api/config') return this.send(res, 200, this.config());
    if (req.method !== 'POST') return this.send(res, 404, { error: 'not found' });
    let body = '';
    for await (const c of req) {
      body += c;
      if (body.length > 4 * 1024 * 1024) return this.send(res, 413, { error: 'too large' });
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return this.send(res, 400, { error: 'bad json' });
    }
    if (!this.getSettings().general.browserIntegration && !data.force) return this.send(res, 409, { error: 'integration disabled' });
    if (path === '/api/download' && typeof data.url === 'string') {
      this.emit('download', data);
      return this.send(res, 200, { ok: true });
    }
    if (path === '/api/links' && Array.isArray(data.links)) {
      this.emit('links', data);
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { error: 'not found' });
  }
}

module.exports = { IntegrationServer };
