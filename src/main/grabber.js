'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const u = require('./util');

const PAGE_EXT = new Set(['', 'html', 'htm', 'shtml', 'xhtml', 'php', 'php3', 'php4', 'asp', 'aspx', 'jsp', 'jspx', 'cfm', 'cgi', 'pl']);

const FILE_PRESETS = {
  images: '*.jpg,*.jpeg,*.png,*.gif,*.webp,*.bmp,*.tif,*.tiff,*.svg',
  audio: '*.mp3,*.wav,*.wma,*.aac,*.m4a,*.flac,*.ogg,*.opus',
  video: '*.mp4,*.avi,*.mkv,*.webm,*.mov,*.wmv,*.flv,*.mpg,*.mpeg,*.m4v,*.3gp',
  documents: '*.pdf,*.doc,*.docx,*.xls,*.xlsx,*.ppt,*.pptx,*.txt,*.rtf,*.odt,*.epub',
  archives: '*.zip,*.rar,*.7z,*.gz,*.tar,*.bz2,*.xz',
  programs: '*.exe,*.msi,*.dmg,*.deb,*.rpm,*.apk,*.iso',
  all: '*.*',
};

function newProject(patch = {}) {
  return {
    id: u.id(),
    name: 'New project',
    startUrl: '',
    auth: null,
    saveDir: '',
    category: 'general',
    useSubfolders: false,
    overwrite: false,
    levelsThis: 1,
    levelsOther: 0,
    dontExploreParent: true,
    exploreMainDomain: false,
    pageInclude: '',
    pageExclude: '',
    fileTypes: FILE_PRESETS.images,
    fileExcludeTypes: '',
    pathInclude: '',
    pathExclude: '',
    thisSiteOnly: false,
    hideDuplicates: true,
    minSizeKB: 0,
    maxSizeKB: 0,
    startDownloadAll: false,
    concurrentExplore: 4,
    concurrentDownload: 2,
    schedule: { enabled: false, mode: 'once', action: 'explore-download', startTime: '02:00', days: [0, 1, 2, 3, 4, 5, 6], periodicMinutes: 0, stopEnabled: false, stopTime: '08:00' },
    results: { pages: [], files: [] },
    stats: { explored: 0, matched: 0, downloaded: 0, pagesFound: 0, filesFound: 0, errors: 0 },
    ...patch,
  };
}

// Pulls candidate URLs from HTML: href/src/srcset/data-* attributes, CSS url(), and <base>.
function extractLinks(html, pageUrl) {
  const base = /<base\s[^>]*href\s*=\s*["']?([^"'\s>]+)/i.exec(html)?.[1];
  const baseUrl = base ? new URL(base, pageUrl).href : pageUrl;
  const out = new Map();
  const add = (raw, text, tag) => {
    if (!raw) return;
    raw = raw.trim().replace(/&amp;/g, '&');
    if (/^(javascript|mailto|tel|data|blob|about):/i.test(raw) || raw.startsWith('#')) return;
    try {
      const abs = new URL(raw, baseUrl);
      abs.hash = '';
      if (!/^(https?|ftp):$/.test(abs.protocol)) return;
      if (!out.has(abs.href)) out.set(abs.href, { url: abs.href, text: (text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200), tag });
    } catch { /* bad URL */ }
  };
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) add(m[1] ?? m[2] ?? m[3], m[4], 'a');
  for (const m of html.matchAll(/\b(?:src|href|data-src|data-original|data-href|poster|data-url)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(m[1] ?? m[2] ?? m[3], '', 'src');
  for (const m of html.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0], '', 'src');
  for (const m of html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) add(m[1], '', 'css');
  for (const m of html.matchAll(/<(?:frame|iframe)\b[^>]*src\s*=\s*["']?([^"'\s>]+)/gi)) add(m[1], '', 'frame');
  return [...out.values()];
}

function mainDomain(host) {
  const parts = host.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : host;
}

function matchesAny(patterns, value) {
  return u.splitList(String(patterns || '').replace(/,/g, ' ')).some((p) => u.wildcardMatch(p.replace('<start page>', ''), value) || u.wildcardMatch(p, value));
}

/**
 * Runs one grabber project: explores pages breadth-first within level/domain/path filters and
 * collects files that match type/path/size filters. Emits update(projectId, delta) and done(projectId).
 */
class GrabberRun extends EventEmitter {
  constructor(project, { net, manager, getSettings }) {
    super();
    this.p = project;
    this.net = net;
    this.manager = manager;
    this.getSettings = getSettings;
    this.abort = new AbortController();
    this.seenPages = new Set(project.results.pages.map((x) => x.url));
    this.seenFiles = new Map(project.results.files.map((f) => [f.url, f]));
    this.dupKeys = new Set();
  }

  start() {
    const p = this.p;
    const start = new URL(p.startUrl);
    this.startHost = start.hostname;
    this.startDir = start.pathname.replace(/[^/]*$/, '');
    this.main = mainDomain(start.hostname);
    this.running = true;
    this.inflight = 0;
    p.stats = { explored: 0, matched: 0, downloaded: 0, pagesFound: 1, filesFound: 0, errors: 0 };
    p.results = { pages: [], files: [] };
    this.seenPages.clear();
    this.seenFiles.clear();
    const queue = [{ url: start.href, level: 0, otherLevel: 0, parent: null }];
    this.seenPages.add(start.href);
    p.results.pages.push({ url: start.href, level: 0, parent: null, status: 'queued' });
    return this.explore(queue);
  }

  isThisSite(host) {
    return host === this.startHost || (this.p.exploreMainDomain && (host === this.main || host.endsWith('.' + this.main)));
  }

  pageAllowed(url, level, otherLevel) {
    const p = this.p;
    const x = new URL(url);
    const ext = u.extOf(x.pathname);
    if (!PAGE_EXT.has(ext)) return false;
    if (this.isThisSite(x.hostname)) {
      if (level > p.levelsThis) return false;
      if (p.dontExploreParent && x.hostname === this.startHost && !x.pathname.startsWith(this.startDir)) return false;
    } else if (otherLevel > p.levelsOther) return false;
    const hp = x.hostname + x.pathname;
    if (p.pageInclude && !matchesAny(p.pageInclude, hp) && !matchesAny(p.pageInclude, url)) return false;
    if (p.pageExclude && (matchesAny(p.pageExclude, hp) || matchesAny(p.pageExclude, url))) return false;
    return true;
  }

  fileMatches(url) {
    const p = this.p;
    const x = new URL(url);
    const name = decodeURIComponent(x.pathname.split('/').pop() || '');
    if (!name) return false;
    if (!matchesAny(p.fileTypes, name)) return false;
    if (p.fileExcludeTypes && matchesAny(p.fileExcludeTypes, name)) return false;
    if (p.thisSiteOnly && !this.isThisSite(x.hostname)) return false;
    const hp = x.hostname + x.pathname;
    if (p.pathInclude && !matchesAny(p.pathInclude, hp)) return false;
    if (p.pathExclude && matchesAny(p.pathExclude, hp)) return false;
    return true;
  }

  async explore(queue) {
    const p = this.p;
    const workers = Array.from({ length: Math.max(1, p.concurrentExplore) }, async () => {
      while (this.running) {
        const job = queue.shift();
        if (!job) {
          if (this.inflight > 0) {
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
          return;
        }
        this.inflight = (this.inflight || 0) + 1;
        try {
          await this.processPage(job, queue);
        } finally {
          this.inflight--;
        }
      }
    });
    await Promise.all(workers);
    if (this.running && p.startDownloadAll) await this.downloadChecked();
    this.running = false;
    this.emit('done', p.id);
  }

  pageRecord(url) {
    return this.p.results.pages.find((x) => x.url === url);
  }

  async processPage(job, queue) {
    const p = this.p;
    const rec = this.pageRecord(job.url);
    rec.status = 'exploring';
    this.emit('update', p.id);
    try {
      const { body, headers, url: finalUrl } = await this.net.fetchBuffer(job.url, { signal: this.abort.signal, auth: p.auth, maxBytes: 8 * 1024 * 1024, timeoutSec: 30 });
      p.stats.explored++;
      const type = String(headers['content-type'] || '');
      if (!/html|xml|text\/plain/i.test(type)) {
        rec.status = 'not a page';
        return;
      }
      rec.status = 'explored';
      rec.title = /<title[^>]*>([^<]*)<\/title>/i.exec(body.toString('utf8'))?.[1]?.trim() || '';
      const links = extractLinks(body.toString('utf8'), finalUrl);
      for (const l of links) {
        if (!this.running) break;
        const host = new URL(l.url).hostname;
        const onThis = this.isThisSite(host);
        if (this.fileMatches(l.url)) {
          await this.addFile(l, job.url);
          continue;
        }
        if (this.seenPages.has(l.url)) continue;
        const level = onThis ? job.level + 1 : job.level;
        const otherLevel = onThis ? 0 : job.otherLevel + 1;
        if (!this.pageAllowed(l.url, level, otherLevel)) continue;
        this.seenPages.add(l.url);
        p.results.pages.push({ url: l.url, level, parent: job.url, status: 'queued', text: l.text });
        p.stats.pagesFound++;
        queue.push({ url: l.url, level, otherLevel, parent: job.url });
      }
    } catch (e) {
      if (this.abort.signal.aborted) return;
      rec.status = 'error: ' + e.message;
      p.stats.errors++;
    } finally {
      this.emit('update', p.id);
    }
  }

  async addFile(link, page) {
    const p = this.p;
    if (this.seenFiles.has(link.url)) return;
    const f = { url: link.url, page, description: link.text, size: null, type: '', checked: true, status: 'found' };
    this.seenFiles.set(link.url, f);
    p.stats.filesFound++;
    const needSize = p.minSizeKB > 0 || p.maxSizeKB > 0 || p.hideDuplicates;
    if (needSize) {
      try {
        const pr = await this.net.probe(link.url, { signal: this.abort.signal, auth: p.auth, timeoutSec: 20 });
        f.size = pr.size;
        f.type = pr.type;
      } catch {
        f.status = 'unreachable';
      }
      if (p.minSizeKB > 0 && f.size != null && f.size < p.minSizeKB * 1024) return;
      if (p.maxSizeKB > 0 && f.size != null && f.size > p.maxSizeKB * 1024) return;
      if (p.hideDuplicates && !p.useSubfolders) {
        const key = `${u.fileNameFromUrl(link.url)}|${f.size}`;
        if (this.dupKeys.has(key)) return;
        this.dupKeys.add(key);
      }
    }
    p.results.files.push(f);
    p.stats.matched++;
    this.emit('update', p.id);
  }

  targetDir(fileUrl) {
    const p = this.p;
    const base = p.saveDir || this.manager.folderForCategory(p.category);
    if (!p.useSubfolders) return base;
    const x = new URL(fileUrl);
    const dirs = decodeURIComponent(x.pathname).split('/').slice(0, -1).filter(Boolean).map(u.sanitizeFileName);
    return path.join(base, u.sanitizeFileName(x.hostname), ...dirs);
  }

  // Downloads checked files `concurrentDownload` at a time; each file gets 2 attempts.
  async downloadChecked(urls) {
    const p = this.p;
    const files = p.results.files.filter((f) => (urls ? urls.includes(f.url) : f.checked) && f.status !== 'downloaded');
    this.running = true;
    const queue = files.slice();
    await Promise.all(Array.from({ length: Math.max(1, p.concurrentDownload) }, async () => {
      while (this.running && queue.length) {
        const f = queue.shift();
        for (let attempt = 0; attempt < 2 && this.running; attempt++) {
          f.status = 'downloading';
          this.emit('update', p.id);
          const { item } = await this.manager.add({ url: f.url, saveDir: this.targetDir(f.url), category: p.category, description: f.description, referer: f.page, auth: p.auth, duplicateAction: p.overwrite ? 'overwrite' : 'number' });
          f.itemId = item.id;
          const ok = await this.waitItem(item.id);
          f.status = ok ? 'downloaded' : 'failed';
          if (ok) {
            f.savedPath = this.manager.get(item.id)?.savedPath;
            p.stats.downloaded++;
            break;
          }
        }
        this.emit('update', p.id);
      }
    }));
  }

  waitItem(id) {
    return new Promise((resolve) => {
      const m = this.manager;
      const done = (it) => it.id === id && fin(true);
      const fail = (it) => it.id === id && fin(false);
      const stop = (sid) => sid === id && fin(false);
      const fin = (v) => {
        m.off('complete', done);
        m.off('failed', fail);
        m.off('stopped', stop);
        resolve(v);
      };
      m.on('complete', done);
      m.on('failed', fail);
      m.on('stopped', stop);
      if (!m.start(id)) fin(m.get(id)?.status === 'complete');
    });
  }

  // Adds checked files to the main list (and optionally to a queue) without downloading.
  async addToList(queueId) {
    const ids = [];
    for (const f of this.p.results.files.filter((x) => x.checked)) {
      const { item } = await this.manager.add({ url: f.url, saveDir: this.targetDir(f.url), category: this.p.category, description: f.description, referer: f.page, auth: this.p.auth, duplicateAction: 'resume' });
      ids.push(item.id);
    }
    return { ids, queueId };
  }

  stop() {
    this.running = false;
    this.abort.abort();
    for (const f of this.p.results.files) if (f.status === 'downloading' && f.itemId) this.manager.stop(f.itemId);
  }
}

module.exports = { GrabberRun, newProject, extractLinks, FILE_PRESETS };
