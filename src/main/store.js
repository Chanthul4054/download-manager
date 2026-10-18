'use strict';
const path = require('path');
const { readJson, writeJsonAtomic } = require('./util');
const { defaultSettings, defaultCategories, defaultQueues } = require('./defaults');

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

// JSON-file persistence with debounced atomic writes.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.timers = {};
    this.settings = deepMerge(defaultSettings(), readJson(this.file('settings'), {}));
    this.categories = readJson(this.file('categories'), null) || defaultCategories();
    this.queues = readJson(this.file('queues'), null) || defaultQueues();
    this.downloads = readJson(this.file('downloads'), []);
    this.grabberProjects = readJson(this.file('grabber'), []);
  }

  file(name) {
    return path.join(this.dir, name + '.json');
  }

  save(name, delay = 400) {
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(() => this.flush(name), delay);
  }

  async flush(name) {
    clearTimeout(this.timers[name]);
    delete this.timers[name];
    const data = name === 'downloads' ? this.serializeDownloads() : this[name === 'grabber' ? 'grabberProjects' : name];
    await writeJsonAtomic(this.file(name), data);
  }

  async flushAll() {
    await Promise.all(['settings', 'categories', 'queues', 'downloads', 'grabber'].map((n) => this.flush(n).catch(() => {})));
  }

  serializeDownloads() {
    return this.downloads.map((d) => {
      const { runtime, ...rest } = d;
      if (rest.segments) rest.segments = rest.segments.map((s) => ({ start: s.start, end: s.end === Infinity ? null : s.end, pos: s.pos }));
      return rest;
    });
  }

  resetSettings() {
    this.settings = defaultSettings();
    this.save('settings');
  }
}

module.exports = { Store, deepMerge };
