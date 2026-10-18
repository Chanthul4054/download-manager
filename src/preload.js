'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'state', 'pending',
  'dl:describe', 'dl:add', 'dl:addMany', 'dl:start', 'dl:stop', 'dl:stopAll', 'dl:remove', 'dl:removeCompleted', 'dl:redownload',
  'dl:update', 'dl:stats', 'dl:item', 'dl:open', 'dl:openFolder', 'dl:progressWindow', 'dl:refreshAddress',
  'q:list', 'q:create', 'q:update', 'q:remove', 'q:start', 'q:stop', 'q:addItems', 'q:removeItems', 'q:move',
  'cats:save', 'cats:reset', 'settings:save', 'settings:replaceList', 'settings:reset',
  'dialog:folder', 'dialog:file', 'dialog:confirm',
  'win:open', 'win:close', 'win:resize', 'win:setTitle', 'win:showMain', 'win:toggleDrop',
  'clip:urls', 'clip:write', 'util:batch', 'util:openExternal', 'util:openPath', 'util:probe', 'util:hlsVariants', 'util:ffmpeg', 'util:ytdlp', 'util:ytdlpInstall', 'util:ytdlpInfo',
  'import', 'export', 'batch:clipboard', 'power:run', 'power:cancel', 'app:quit',
  'grabber:list', 'grabber:get', 'grabber:new', 'grabber:save', 'grabber:delete', 'grabber:run', 'grabber:stop',
  'grabber:setChecked', 'grabber:addToList', 'grabber:open',
]);
const EVENTS = new Set([
  'dl:changed', 'dl:removed', 'dl:progress', 'q:changed', 'settings', 'categories', 'menu', 'sound', 'payload',
  'grabber:update', 'grabber:done', 'grabber:error', 'grabber:list',
]);

contextBridge.exposeInMainWorld('api', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error('Blocked channel ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) throw new Error('Blocked event ' + channel);
    const h = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.off(channel, h);
  },
  startDrag(id) {
    ipcRenderer.send('dl:drag', id);
  },
});
