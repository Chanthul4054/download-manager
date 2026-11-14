import { ClipboardPaste, Copy, ExternalLink, FolderOpen, Info, Layers, ListPlus, ListMinus, Pause, Play, Plus, RotateCcw, Link, Trash2, Activity, CheckSquare } from 'lucide-react';
import { invoke } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { openDialog, selectAll } from '@/stores/ui';
import { copyText, redownload, refreshAddress, remove, resume, stop } from '@/app/commands';
import { canResume, isRunning } from '@/utils/status';
import type { MenuEntry } from '@/components/ui/menu';
import type { DownloadItem } from '@/types/models';

/** Actions for the selected downloads (row context menu and the row's "…" button). */
export function itemMenu(sel: DownloadItem[]): MenuEntry[] {
  if (!sel.length) return emptyMenu();
  const one = sel.length === 1 ? sel[0] : null;
  const done = one?.status === 'complete';
  const queues = useApp.getState().queues;
  const ids = sel.map((s) => s.id);
  // The file changed on the server: nothing is thrown away until the user chooses.
  const changed: MenuEntry[] = one?.status === 'error' && one.errorCode === 'ECHANGED' ? [
    { label: 'Restart from the beginning', icon: RotateCcw, onSelect: () => redownload(one) },
    { label: 'Keep partial file', icon: Pause, onSelect: () => invoke('dl:keepPartial', one.id) },
    '-',
  ] : [];
  return [
    ...changed,
    { label: 'Open', icon: ExternalLink, kbd: 'Enter', disabled: !done, onSelect: () => one && invoke('dl:open', one.id) },
    { label: 'Open folder', icon: FolderOpen, disabled: !one, onSelect: () => one && invoke('dl:openFolder', one.id) },
    { label: 'Show progress', icon: Activity, disabled: !one || one.status !== 'downloading', onSelect: () => one && invoke('dl:progressWindow', one.id) },
    '-',
    { label: 'Resume', icon: Play, disabled: !sel.some(canResume), onSelect: () => resume(sel) },
    { label: 'Pause', icon: Pause, disabled: !sel.some(isRunning), onSelect: () => stop(sel) },
    { label: 'Redownload', icon: RotateCcw, disabled: !one, onSelect: () => one && redownload(one) },
    { label: 'Refresh download address…', icon: Link, disabled: !one || one.status === 'complete', onSelect: () => one && refreshAddress(one) },
    '-',
    { label: 'Add to queue', icon: ListPlus, sub: queues.map((q) => ({ label: q.name, checked: sel.every((s) => q.items.includes(s.id)), onSelect: () => invoke('q:addItems', q.id, ids) })) },
    { label: 'Remove from queue', icon: ListMinus, disabled: !queues.some((q) => sel.some((s) => q.items.includes(s.id))), sub: queues.filter((q) => sel.some((s) => q.items.includes(s.id))).map((q) => ({ label: q.name, onSelect: () => invoke('q:removeItems', q.id, ids) })) },
    '-',
    { label: sel.length > 1 ? `Copy ${sel.length} addresses` : 'Copy address', icon: Copy, onSelect: () => copyText(sel.map((x) => x.url).join('\n'), sel.length > 1 ? `Copied ${sel.length} addresses` : 'Address copied') },
    { label: 'Properties…', icon: Info, kbd: 'Alt+Enter', disabled: !one, onSelect: () => one && openDialog({ type: 'properties', id: one.id }) },
    '-',
    { label: 'Remove', icon: Trash2, kbd: 'Del', danger: true, onSelect: () => remove(sel, false) },
    { label: 'Remove and delete file', icon: Trash2, kbd: 'Shift+Del', danger: true, disabled: !sel.some((s) => s.status === 'complete'), onSelect: () => remove(sel, true) },
  ];
}

export function emptyMenu(): MenuEntry[] {
  return [
    { label: 'New download…', icon: Plus, kbd: 'Ctrl+N', onSelect: () => openDialog({ type: 'addUrl' }) },
    { label: 'Batch download…', icon: Layers, kbd: 'Ctrl+B', onSelect: () => openDialog({ type: 'batch' }) },
    { label: 'Paste addresses from clipboard', icon: ClipboardPaste, onSelect: () => invoke('batch:clipboard') },
    '-',
    { label: 'Select all', icon: CheckSquare, kbd: 'Ctrl+A', onSelect: selectAll },
  ];
}
