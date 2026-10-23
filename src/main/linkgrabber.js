'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const u = require('./util');
const { extractLinks } = require('./grabber');

// Patterns that reduce every part of a split archive or recovery set to one base name, so the
// parts land in the same package. Order matters: the first match wins.
const ARCHIVE_PARTS = [
  /^(.*)[._-]part\.?0*\d+\.(?:rar|rev|exe)$/i, // name.part01.rar, name.part2.exe (SFX)
  /^(.*)\.(?:rar|rev)$/i, // name.rar
  /^(.*)\.r\d{2,3}$/i, // name.r00 (old-style volumes)
  /^(.*)\.(?:zip|z\d{2})$/i, // name.zip + name.z01
  /^(.*)\.(?:7z|zip|rar|tar|iso)\.\d{2,3}$/i, // name.7z.001
  /^(.*?)(?:\.vol\d+(?:[+-]\d+)?)?\.par2$/i, // name.par2, name.vol00+01.par2
  /^(.*)\.(?:par|p\d{2})$/i, // name.par, name.p01
  /^(.*)\.(?:isz|i\d{2})$/i, // name.isz + name.i01
  /^(.*)\.\d+\.xtm$/i, // name.001.xtm
  /^(.*)\.(?:_[a-z]|[a-z]{2})_$/i, // hjsplit-style name.aa_
  /^(.*)\.\d{3}$/, // name.001
];

const PAGE_EXT = new Set(['', 'html', 'htm', 'shtml', 'xhtml', 'php', 'asp', 'aspx', 'jsp', 'cfm', 'cgi', 'pl']);

/** Derives a package name from a file name: archive part numbers and the extension are removed. */
function packageNameFor(fileName) {
  let name = String(fileName || '').trim();
  const part = ARCHIVE_PARTS.find((re) => re.test(name));
  if (part) name = part.exec(name)[1];
  else name = name.replace(/(\.tar)?\.[a-z0-9]{1,5}$/i, '');
  name = name.replace(/[\s._-]+$/, '').trim();
  return name || String(fileName || 'Download');
}

function packageKey(fileName) {
  return packageNameFor(fileName).toLowerCase().replace(/[\s._-]+/g, ' ');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Collects links before they become downloads, like JDownloader's LinkGrabber: links are checked
 * online in the background, grouped into packages (split archives together, single files under
 * "Various files", dead links under "Offline"), and only become downloads once confirmed.
 * Emits changed() whenever the list changes and confirmed(ids) after links are moved to the list.
 */
class LinkGrabber extends EventEmitter {
  constructor(store, net, manager) {
    super();
    this.store = store;
    this.net = net;
    this.manager = manager;
    this.todo = [];
    this.checking = 0;
    this.autoTimer = null;
    if (!store.linkGrabber?.packages) store.linkGrabber = { packages: [] };
    // Links that were mid-check when the app closed are checked again.
    for (const l of this.links()) if (l.status === 'checking') this.todo.push(l.id);
    this.pump();
  }

  get settings() {
    return this.store.settings.linkGrabber;
  }

  get packages() {
    return this.store.linkGrabber.packages;
  }

  links() {
    return this.packages.flatMap((p) => p.links);
  }

  find(linkId) {
    for (const p of this.packages) {
      const l = p.links.find((x) => x.id === linkId);
      if (l) return { pkg: p, link: l };
    }
    return null;
  }

  snapshot() {
    return { packages: this.packages, busy: this.checking > 0 || this.todo.length > 0, pending: this.checking + this.todo.length };
  }

  touch() {
    this.store.save('linkgrabber');
    this.emit('changed');
  }

  // ---- adding ----------------------------------------------------------------------------------

  /**
   * Adds links from text or a list. opts: text, links [{url, text}], referer, cookies, userAgent,
   * auth, packageName, saveDir, deep (look inside web pages), source.
   * Returns the number of new links; addresses already in the LinkGrabber are skipped.
   */
  add(opts = {}) {
    const raw = [...(opts.links || []), ...u.extractUrls(opts.text || '').map((url) => ({ url }))];
    const known = new Set(this.links().map((l) => l.url));
    let n = 0;
    for (const r of raw) {
      const url = String(r.url || '').trim();
      if (!/^(https?|ftp):\/\//i.test(url) || known.has(url)) continue;
      known.add(url);
      const link = {
        id: u.id(),
        url,
        name: this.manager.guessName(url),
        size: null,
        type: '',
        host: hostOf(url),
        status: 'checking',
        error: '',
        enabled: true,
        inList: !!this.manager.findDuplicate(url),
        description: r.text || opts.description || '',
        referer: opts.referer || '',
        cookies: opts.cookies || '',
        userAgent: opts.userAgent || '',
        auth: opts.auth && opts.auth.user ? opts.auth : null,
        deep: !!(opts.deep ?? this.settings.deepAnalyse),
        depth: r.depth || 0,
        source: opts.source || '',
        added: Date.now(),
      };
      if (opts.packageName) link.forcedPackage = String(opts.packageName).trim();
      if (opts.saveDir) link.forcedSaveDir = opts.saveDir;
      this.place(link);
      this.todo.push(link.id);
      n++;
    }
    if (n) {
      this.cancelAutoConfirm();
      this.touch();
      this.pump();
    }
    return n;
  }

  // ---- online check ----------------------------------------------------------------------------

  recheck(ids) {
    for (const l of this.select(ids)) {
      if (l.status === 'checking') continue;
      Object.assign(l, { status: 'checking', error: '' });
      this.todo.push(l.id);
    }
    this.touch();
    this.pump();
  }

  pump() {
    const max = Math.max(1, Number(this.settings.checkThreads) || 4);
    while (this.checking < max && this.todo.length) {
      const id = this.todo.shift();
      const hit = this.find(id);
      if (!hit || hit.link.status !== 'checking') continue;
      this.checking++;
      this.check(hit.link)
        .catch((e) => Object.assign(hit.link, { status: 'unknown', error: e.message }))
        .finally(() => {
          this.checking--;
          if (this.find(id)) this.place(hit.link);
          this.touch();
          this.pump();
          if (!this.checking && !this.todo.length) this.scheduleAutoConfirm();
        });
    }
  }

  async check(link) {
    const kind = this.manager.kindFor(link.url);
    if (kind !== 'http') {
      // FTP, streams and video pages are resolved when the download starts.
      Object.assign(link, { status: 'unknown', error: kind === 'ytdlp' ? 'Video page' : '' });
      return;
    }
    const headers = {};
    if (link.referer) headers.Referer = link.referer;
    if (link.cookies) headers.Cookie = link.cookies;
    let p;
    try {
      p = await this.net.probe(link.url, { headers, auth: link.auth, timeoutSec: 20 });
    } catch (e) {
      const transient = /time|abort|reset|ETIMEDOUT|ECONNRESET/i.test(e.code || e.message);
      Object.assign(link, { status: transient ? 'unknown' : 'offline', error: e.message });
      return;
    }
    if (p.status >= 400) {
      const gone = p.status === 404 || p.status === 410 || p.status === 451;
      Object.assign(link, { status: gone ? 'offline' : 'unknown', error: `HTTP ${p.status}` });
      return;
    }
    const fromHeader = u.fileNameFromDisposition(p.headers['content-disposition']);
    Object.assign(link, { status: 'online', error: '', size: p.size, type: p.type.split(';')[0], resumable: p.resumable });
    if (!link.nameLocked) link.name = this.manager.guessName(p.url || link.url, fromHeader, p.type);
    if (/text\/html|xhtml/i.test(p.type) && !fromHeader) {
      if (link.deep && link.depth === 0 && (await this.crawl(link, p.url || link.url))) return;
      // A web page is rarely what the user wants to download.
      link.enabled = false;
      link.error = 'Web page';
    }
  }

  // Replaces a web page with the files it links to. Returns true if any were found.
  async crawl(link, pageUrl) {
    const headers = {};
    if (link.referer) headers.Referer = link.referer;
    if (link.cookies) headers.Cookie = link.cookies;
    const { body } = await this.net.fetchBuffer(pageUrl, { headers, auth: link.auth, maxBytes: 4 * 1024 * 1024, timeoutSec: 20 });
    const files = extractLinks(body.toString('utf8'), pageUrl).filter((x) => x.tag !== 'css' && !PAGE_EXT.has(u.extOf(new URL(x.url).pathname)));
    if (!files.length) return false;
    const hit = this.find(link.id);
    this.add({
      links: files.map((f) => ({ url: f.url, text: f.text, depth: 1 })),
      referer: pageUrl, cookies: link.cookies, userAgent: link.userAgent, auth: link.auth, deep: false,
      packageName: link.forcedPackage, saveDir: link.forcedSaveDir, source: link.source,
    });
    if (hit) this.detach(hit.pkg, link);
    return true;
  }

  // ---- packaging -------------------------------------------------------------------------------

  newPackage(name, kind, key = null) {
    const pkg = { id: u.id(), name, kind, key, saveDir: '', expanded: kind !== 'normal' || !!this.settings.expandPackages, added: Date.now(), links: [] };
    const various = this.packages.findIndex((p) => p.kind !== 'normal' && p.kind !== 'custom');
    // Special packages stay at the bottom, new ones at the end of the regular list.
    if (kind === 'normal' || kind === 'custom') this.packages.splice(various < 0 ? this.packages.length : various, 0, pkg);
    else this.packages.push(pkg);
    return pkg;
  }

  special(kind) {
    return this.packages.find((p) => p.kind === kind) || this.newPackage(kind === 'offline' ? 'Offline' : 'Various files', kind);
  }

  detach(pkg, link) {
    pkg.links = pkg.links.filter((l) => l !== link);
    if (!pkg.links.length) this.store.linkGrabber.packages = this.packages.filter((p) => p !== pkg);
  }

  /** Puts a link into the package it belongs to, moving it out of its current one if needed. */
  place(link) {
    const cur = this.packages.find((p) => p.links.includes(link));
    // Links the user moved by hand stay where they are.
    if (cur && (link.pinned || cur.kind === 'custom')) return;
    const target = this.targetFor(link);
    if (target === cur) return;
    if (cur) this.detach(cur, link);
    target.links.push(link);
  }

  targetFor(link) {
    if (link.forcedPackage) {
      return this.packages.find((p) => p.kind === 'custom' && p.name === link.forcedPackage)
        || Object.assign(this.newPackage(link.forcedPackage, 'custom'), { saveDir: link.forcedSaveDir || '' });
    }
    if (link.status === 'offline') return this.special('offline');
    const key = packageKey(link.name);
    const pkg = this.packages.find((p) => p.kind === 'normal' && p.key === key);
    if (pkg) return pkg;
    if (!this.settings.variousPackage) return this.newPackage(packageNameFor(link.name), 'normal', key);
    // A second file with the same base name (another archive part, say) forms its own package.
    const various = this.packages.find((p) => p.kind === 'various');
    const siblings = various ? various.links.filter((l) => l !== link && !l.pinned && packageKey(l.name) === key) : [];
    if (!siblings.length) return this.special('various');
    const fresh = this.newPackage(packageNameFor(link.name), 'normal', key);
    for (const s of siblings) {
      this.detach(various, s);
      fresh.links.push(s);
    }
    return fresh;
  }

  // ---- editing ---------------------------------------------------------------------------------

  /** Resolves a mixed list of package and link ids to links. */
  select(ids) {
    const set = new Set(ids);
    return this.packages.flatMap((p) => (set.has(p.id) ? p.links : p.links.filter((l) => set.has(l.id))));
  }

  setEnabled(ids, enabled) {
    for (const l of this.select(ids)) l.enabled = enabled;
    this.touch();
  }

  updatePackage(id, patch) {
    const p = this.packages.find((x) => x.id === id);
    if (!p) return;
    if (patch.name != null && patch.name.trim() && patch.name.trim() !== p.name) {
      p.name = patch.name.trim();
      // A renamed package keeps its links and no longer collects new ones automatically.
      if (p.kind !== 'custom') {
        p.kind = 'custom';
        for (const l of p.links) l.pinned = true;
      }
    }
    if (patch.saveDir != null) p.saveDir = patch.saveDir;
    if (patch.expanded != null) p.expanded = !!patch.expanded;
    this.touch();
  }

  renameLink(id, name) {
    const hit = this.find(id);
    if (!hit || !String(name || '').trim()) return;
    hit.link.name = u.sanitizeFileName(name);
    hit.link.nameLocked = true;
    this.touch();
  }

  /** Moves links (or whole packages) into a new package with the given name. */
  merge(ids, name) {
    const links = this.select(ids);
    if (!links.length) return null;
    const pkg = this.newPackage(String(name || '').trim() || packageNameFor(links[0].name), 'custom');
    for (const l of links) {
      const cur = this.packages.find((p) => p !== pkg && p.links.includes(l));
      if (cur) this.detach(cur, l);
      l.pinned = true;
      pkg.links.push(l);
    }
    pkg.saveDir = links.map((l) => l.forcedSaveDir).find(Boolean) || '';
    this.touch();
    return pkg.id;
  }

  /** Splits each selected package into one package per host ("name-host"). */
  splitByHost(ids) {
    const set = new Set(ids);
    for (const p of [...this.packages]) {
      if (!set.has(p.id) && !p.links.some((l) => set.has(l.id))) continue;
      const hosts = [...new Set(p.links.map((l) => l.host))];
      if (hosts.length < 2) continue;
      for (const host of hosts.slice(1)) {
        const part = this.newPackage(`${p.name}-${host}`, 'custom');
        part.saveDir = p.saveDir;
        for (const l of p.links.filter((x) => x.host === host)) {
          this.detach(p, l);
          l.pinned = true;
          part.links.push(l);
        }
      }
    }
    this.touch();
  }

  remove(ids) {
    const drop = new Set(this.select(ids).map((l) => l.id));
    for (const p of this.packages) p.links = p.links.filter((l) => !drop.has(l.id));
    this.store.linkGrabber.packages = this.packages.filter((p) => p.links.length);
    this.todo = this.todo.filter((id) => !drop.has(id));
    this.touch();
  }

  removeOffline() {
    this.remove(this.links().filter((l) => l.status === 'offline').map((l) => l.id));
  }

  clear() {
    this.store.linkGrabber.packages = [];
    this.todo = [];
    this.cancelAutoConfirm();
    this.touch();
  }

  // ---- confirming ------------------------------------------------------------------------------

  /** The folder a package's file is saved to, or undefined for the category default. */
  saveDirFor(pkg, link) {
    if (pkg.saveDir) return pkg.saveDir;
    const own = pkg.kind === 'normal' || pkg.kind === 'custom';
    if (!own || !this.settings.packageFolders || pkg.links.length < 2) return undefined;
    const base = this.manager.folderForCategory(this.manager.categoryForName(link.name));
    return path.join(base, u.sanitizeFileName(pkg.name));
  }

  /**
   * Moves links to the download list. ids: packages and/or links (empty = everything).
   * opts: queueId, start, includeOffline, includeDupes, includeDisabled.
   * Returns the new download ids.
   */
  async confirm(ids, opts = {}) {
    this.cancelAutoConfirm();
    const s = this.settings;
    const includeOffline = opts.includeOffline ?? s.offlineAction === 'include';
    const includeDupes = opts.includeDupes ?? s.dupeAction === 'add';
    const chosen = new Set((ids && ids.length ? this.select(ids) : this.links()).map((l) => l.id));
    const added = [];
    const done = [];
    for (const pkg of [...this.packages]) {
      for (const l of pkg.links) {
        if (!chosen.has(l.id) || l.status === 'checking') continue;
        if (!l.enabled && !opts.includeDisabled) continue;
        if (l.status === 'offline' && !includeOffline) continue;
        if ((l.inList || this.manager.findDuplicate(l.url)) && !includeDupes) {
          done.push(l.id);
          continue;
        }
        const res = await this.manager.add({
          url: l.url, fileName: l.status === 'online' ? l.name : undefined, saveDir: this.saveDirFor(pkg, l),
          description: l.description || (pkg.kind === 'various' ? '' : pkg.name), referer: l.referer, parentPage: l.referer,
          cookies: l.cookies, userAgent: l.userAgent, auth: l.auth || undefined, mime: l.type, size: l.size || undefined,
          queueId: opts.queueId || undefined, duplicateAction: 'number',
        });
        added.push(res.item.id);
        done.push(l.id);
      }
    }
    const confirmed = new Set(done);
    for (const p of this.packages) p.links = p.links.filter((l) => !confirmed.has(l.id));
    this.store.linkGrabber.packages = this.packages.filter((p) => p.links.length);
    if (opts.start) for (const id of added) this.manager.start(id);
    this.touch();
    this.emit('confirmed', added);
    return added;
  }

  scheduleAutoConfirm() {
    if (!this.settings.autoConfirm || !this.links().some((l) => l.enabled && l.status !== 'offline')) return;
    this.cancelAutoConfirm();
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      this.confirm([], { start: this.settings.autoStart, queueId: this.settings.queueId || undefined, auto: true }).catch(() => {});
    }, Math.max(1, Number(this.settings.autoConfirmDelaySec) || 15) * 1000);
    this.emit('changed');
  }

  cancelAutoConfirm() {
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }

  dispose() {
    this.cancelAutoConfirm();
    this.todo = [];
  }
}

module.exports = { LinkGrabber, packageNameFor, packageKey };
