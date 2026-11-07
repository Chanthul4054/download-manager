// Every user command of the main window. Toolbar buttons, context menus, keyboard shortcuts and the
// backend's `menu` event (tray, CLI, second instance) all come through here.
import { toast } from 'sonner';
import { invoke, runMenu } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { navigate, openDialog, useUi, type Page, type SettingsSection } from '@/stores/ui';
import { confirm, prompt } from '@/components/dialogs/confirm';
import { canResume, isRunning } from '@/utils/status';
import type { DownloadItem } from '@/types/models';

export function selectedItems(): DownloadItem[] {
  const items = useApp.getState().items;
  return [...useUi.getState().sel].map((id) => items[id]).filter(Boolean);
}

export const resume = (items = selectedItems()) => {
  const ids = items.filter(canResume).map((x) => x.id);
  if (ids.length) void invoke('dl:start', ids);
};
export const stop = (items = selectedItems()) => {
  const ids = items.filter(isRunning).map((x) => x.id);
  if (ids.length) void invoke('dl:stop', ids);
};

export async function remove(items = selectedItems(), withFiles = false) {
  if (!items.length) return;
  const unfinished = items.some((x) => x.status !== 'complete');
  const r = await confirm(items.length === 1 ? `Remove “${items[0].fileName}”?` : `Remove ${items.length} downloads?`, {
    message: unfinished ? 'Partly downloaded data is deleted.' : items.length === 1 ? 'It is removed from the list.' : 'They are removed from the list.',
    okLabel: withFiles ? 'Remove and delete' : 'Remove',
    danger: true,
    check: !withFiles && items.some((x) => x.status === 'complete') ? 'Also delete the downloaded files from disk' : undefined,
  });
  if (r) {
    await invoke('dl:remove', items.map((x) => x.id), withFiles || r.checked);
    useUi.setState((s) => ({ sel: new Set([...s.sel].filter((id) => !items.some((x) => x.id === id))) }));
  }
}

export async function removeCompleted() {
  if (await confirm('Remove all completed downloads?', { message: 'Downloaded files stay on disk.', okLabel: 'Remove' })) {
    const n = await invoke('dl:removeCompleted');
    toast(typeof n === 'number' ? `Removed ${n} completed download${n === 1 ? '' : 's'}` : 'Removed completed downloads');
  }
}

export async function redownload(it: DownloadItem) {
  if (await confirm(`Download “${it.fileName}” again?`, { message: 'It starts again from the beginning.', okLabel: 'Redownload' })) void invoke('dl:redownload', it.id);
}

export async function refreshAddress(it: DownloadItem) {
  const url = await prompt('Refresh download address', 'New address for this file. Progress is kept if the file is the same.', it.url, 'Refresh');
  if (url?.trim()) void invoke('dl:refreshAddress', it.id, url.trim());
}

/** Double-click / Enter: open a finished file, show progress for a running one, otherwise properties. */
export function openItem(it: DownloadItem) {
  if (it.status === 'complete') void invoke('dl:open', it.id);
  else if (it.status === 'downloading') void invoke('dl:progressWindow', it.id);
  else openDialog({ type: 'properties', id: it.id });
}

export async function copyText(text: string, what = 'Copied') {
  await invoke('clip:write', text);
  toast(what);
}

export const startQueue = (id = 'main') => invoke('q:start', id);
export const stopQueue = (id = 'main') => invoke('q:stop', id);
export function stopAll() {
  void runMenu('stop-all');
}

export async function newQueue() {
  const name = await prompt('New queue', 'Queue name', 'Queue ' + (useApp.getState().queues.length + 1), 'Create');
  if (!name?.trim()) return;
  const q = await invoke('q:create', name.trim(), 'download');
  navigate('queues', { queueId: q.id });
}

export function openSettings(section?: SettingsSection) {
  navigate('settings', { section: section || 'general' });
}

export function toggleSpeedLimiter() {
  const s = useApp.getState().settings.speedLimiter;
  void runMenu(s.enabled ? 'limiter:off' : 'limiter:on');
}

/** Commands sent by the backend (`menu` event) or by the app menu and shortcuts. */
export function runCommand(cmd: string, arg?: unknown, arg2?: unknown) {
  const sel = selectedItems();
  const one = sel[0];
  switch (cmd) {
    case 'nav': {
      const page = arg as Page;
      return page === 'grabber' ? navigate('grabber', { grabberId: (arg2 as string) ?? null }) : navigate(page);
    }
    case 'addUrl': return openDialog({ type: 'addUrl' });
    case 'batch': return openDialog({ type: 'batch' });
    case 'resume': return resume(sel);
    case 'stop': return stop(sel);
    case 'stopAll': return stopAll();
    case 'delete': return remove(sel, false);
    case 'deleteFiles': return remove(sel, true);
    case 'deleteCompleted': return removeCompleted();
    case 'redownload': return one && redownload(one);
    case 'open': return one && (one.status === 'complete' ? invoke('dl:open', one.id) : openDialog({ type: 'properties', id: one.id }));
    case 'openFolder': return one && invoke('dl:openFolder', one.id);
    case 'properties':
    case 'moveRename': return one && openDialog({ type: 'properties', id: one.id });
    case 'progress': return one && invoke('dl:progressWindow', one.id);
    case 'options': return openSettings((arg as SettingsSection) || 'general');
    case 'scheduler': return navigate('queues', { queueId: (arg as string) || null });
    case 'limiter': return openSettings('limits');
    case 'columns': return openDialog({ type: 'columns' });
    case 'find': return document.dispatchEvent(new CustomEvent('odm:find'));
    case 'findNext': return document.dispatchEvent(new CustomEvent('odm:findNext'));
    case 'help': return openDialog({ type: 'help', topic: (arg as string) || 'start' });
    case 'about': return openSettings('about');
    case 'tip': return openDialog({ type: 'tip' });
    case 'grabber': return navigate('grabber');
    case 'linkgrabber': return navigate('linkgrabber');
    case 'copyUrl': return sel.length && copyText(sel.map((x) => x.url).join('\n'), sel.length > 1 ? `Copied ${sel.length} addresses` : 'Address copied');
    case 'refresh': return one && refreshAddress(one);
    default:
  }
}
