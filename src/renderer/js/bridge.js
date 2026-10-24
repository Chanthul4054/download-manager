'use strict';
// window.api for the UI: invoke(channel, ...args), on(event, fn) and startDrag(id), carried over
// Tauri's IPC. Loaded as a classic script before the app modules.
(() => {
  const T = window.__TAURI__;
  const label = T.webviewWindow.getCurrentWebviewWindow().label;
  const EVENTS = new Set([
    'dl:changed', 'dl:removed', 'dl:progress', 'q:changed', 'settings', 'categories', 'menu', 'sound', 'payload',
    'grabber:update', 'grabber:done', 'grabber:error', 'grabber:list', 'lg:changed',
  ]);
  const handlers = new Map();

  // Every backend event arrives as one "odm" event; `target` limits it to one window.
  T.event.listen('odm', (e) => {
    const { channel, args, target } = e.payload;
    if (target && target !== label) return;
    for (const fn of [...(handlers.get(channel) || [])]) fn(...(args || []));
  });

  window.api = {
    invoke(channel, ...args) {
      return T.core.invoke('ipc', { channel, args }).catch((err) => {
        throw new Error(`Error invoking remote method '${channel}': Error: ${err && err.message ? err.message : err}`);
      });
    },
    on(channel, fn) {
      if (!EVENTS.has(channel)) throw new Error('Blocked event ' + channel);
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel).add(fn);
      return () => handlers.get(channel).delete(fn);
    },
    startDrag(id) {
      T.core.invoke('ipc', { channel: 'dl:drag', args: [id] }).catch(() => {});
    },
  };
})();
