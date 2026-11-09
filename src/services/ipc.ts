// The one place the UI talks to Rust. Every backend call goes through the single `ipc` Tauri command
// (channel + args), and every backend event arrives as one `odm` event (see src-tauri/src/app.rs).
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type {
  AppState, DeepPartial, Category, DescribeResult, DownloadItem, DownloadStats, GrabberProject, GrabberSummary, HlsVariant,
  LgState, ProgressEntry, Queue, Settings, TorrentFiles, YtdlpInfo,
} from '@/types/models';

type Json = unknown;

/** channel → [args, result] */
export interface Channels {
  state: [[], AppState];
  pending: [[token: string], Json];
  'dl:describe': [[url: string, opts: Record<string, unknown>], DescribeResult];
  'dl:add': [[payload: Record<string, unknown>], { item: DownloadItem; duplicate: boolean }];
  'dl:addMany': [[items: Record<string, unknown>[], opts: { queueId: string | null; start: boolean }], Json];
  'dl:start': [[ids: string[], showProgress?: boolean], Json];
  'dl:stop': [[ids: string[]], Json];
  'dl:stopAll': [[], Json];
  'dl:remove': [[ids: string[], deleteFiles: boolean], Json];
  'dl:removeCompleted': [[], number];
  'dl:redownload': [[id: string], Json];
  'dl:update': [[id: string, patch: Record<string, unknown>], DownloadItem];
  'dl:stats': [[id: string], DownloadStats | null];
  'dl:item': [[id: string], DownloadItem | null];
  'dl:open': [[id: string], Json];
  'dl:openFolder': [[id: string], Json];
  'dl:progressWindow': [[id: string], Json];
  'dl:refreshAddress': [[id: string, url: string], Json];
  'dl:drag': [[id: string], Json];
  'q:create': [[name: string, type: 'download' | 'sync'], Queue];
  'q:update': [[id: string, patch: Partial<Queue>], Json];
  'q:remove': [[id: string], Json];
  'q:start': [[id: string], Json];
  'q:stop': [[id: string], Json];
  'q:addItems': [[id: string, ids: string[]], Json];
  'q:removeItems': [[id: string, ids: string[]], Json];
  'q:move': [[id: string, ids: string[], dir: 'top' | 'up' | 'down' | 'bottom'], Json];
  'cats:save': [[cats: Category[]], Json];
  'settings:save': [[patch: DeepPartial<Settings>], Settings];
  'settings:replaceList': [[section: string, key: string, list: unknown[]], Json];
  'settings:reset': [[], Json];
  'dialog:folder': [[defaultPath?: string], string | null];
  'dialog:file': [[defaultPath?: string, filter?: 'torrent'], string | null];
  'win:open': [[view: string, params: Record<string, unknown>, opts?: Record<string, unknown>], Json];
  'win:close': [[], Json];
  'win:setTitle': [[title: string], Json];
  'win:resize': [[width: number, height: number], Json];
  'win:showMain': [[], Json];
  'win:toggleDrop': [[], Json];
  'clip:urls': [[], string[]];
  'clip:write': [[text: string], Json];
  'util:batch': [[pattern: string, from: string, to: string, width: number], string[]];
  'util:openExternal': [[url: string], Json];
  'util:openPath': [[path: string], string];
  'util:probe': [[urls: string[], opts: { referer?: string }], Record<string, { size?: number; type?: string }>];
  'util:hlsVariants': [[url: string, referer?: string], HlsVariant[]];
  'util:ffmpeg': [[], string | null];
  'util:extensionDir': [[], string];
  'util:ytdlp': [[], string | null];
  'util:ytdlpInstall': [[], Json];
  'util:ytdlpInfo': [[url: string], YtdlpInfo];
  'util:torrentFiles': [[url: string], TorrentFiles];
  'util:torrentFirewall': [[action?: 'allow'], 'allowed' | 'blocked' | 'none' | 'unsupported'];
  'batch:clipboard': [[], Json];
  'power:run': [[kind: string, force: boolean], Json];
  'power:cancel': [[], Json];
  'app:quit': [[], Json];
  /** Runs a command of the native menu (same ids as menu_template in app.rs). */
  'app:menu': [[id: string], Json];
  'grabber:list': [[], GrabberSummary[]];
  'grabber:get': [[id: string], GrabberProject | null];
  'grabber:new': [[patch: Partial<GrabberProject>], GrabberProject];
  'grabber:save': [[project: GrabberProject], GrabberProject];
  'grabber:delete': [[id: string], Json];
  'grabber:run': [[id: string, action: 'explore' | 'download' | 'explore-download'], Json];
  'grabber:stop': [[id: string], Json];
  'grabber:setChecked': [[id: string, urls: string[], checked: boolean], GrabberProject];
  'grabber:addToList': [[id: string, queueId: string], number];
  'lg:state': [[], LgState];
  'lg:add': [[opts: { text: string; packageName?: string; saveDir?: string; deep?: boolean }], number];
  'lg:confirm': [[ids: string[], opts: { queueId?: string; start: boolean; includeOffline?: boolean; includeDupes?: boolean; includeDisabled?: boolean }], string[]];
  'lg:remove': [[ids: string[]], Json];
  'lg:removeOffline': [[], Json];
  'lg:clear': [[], Json];
  'lg:enable': [[ids: string[], on: boolean], Json];
  'lg:updatePackage': [[id: string, patch: { name?: string; saveDir?: string; expanded?: boolean }], Json];
  'lg:renameLink': [[id: string, name: string], Json];
  'lg:merge': [[ids: string[], name: string], Json];
  'lg:splitByHost': [[ids: string[]], Json];
  'lg:recheck': [[ids: string[]], Json];
}

/** event → handler args */
export interface Events {
  'dl:changed': [item: DownloadItem];
  'dl:removed': [ids: string[]];
  'dl:progress': [batch: ProgressEntry[]];
  'q:changed': [queues: Queue[]];
  settings: [settings: Settings];
  categories: [categories: Category[]];
  menu: [cmd: string, ...args: unknown[]];
  sound: [kind: 'complete' | 'failed' | 'queueDone'];
  payload: [payload: unknown];
  'grabber:update': [id: string, project: GrabberProject];
  'grabber:done': [id: string];
  'grabber:error': [id: string, message: string];
  'grabber:list': [];
  'lg:changed': [state: LgState];
}

export async function invoke<C extends keyof Channels>(channel: C, ...args: Channels[C][0]): Promise<Channels[C][1]> {
  try {
    return (await tauriInvoke('ipc', { channel, args })) as Channels[C][1];
  } catch (err) {
    const msg = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
    throw new Error(msg);
  }
}

type Handler = (...args: never[]) => void;
const handlers = new Map<string, Set<Handler>>();
const label = getCurrentWebviewWindow().label;

// One listener for the whole window; `target` limits an event to one window.
void listen<{ channel: string; args?: unknown[]; target?: string }>('odm', (e) => {
  const { channel, args, target } = e.payload;
  if (target && target !== label) return;
  const set = handlers.get(channel);
  if (set) for (const fn of [...set]) (fn as (...a: unknown[]) => void)(...(args || []));
});

/** Subscribes to a backend event; returns the unsubscribe function. */
export function on<E extends keyof Events>(event: E, fn: (...args: Events[E]) => void): () => void {
  let set = handlers.get(event);
  if (!set) handlers.set(event, (set = new Set()));
  set.add(fn as Handler);
  return () => set.delete(fn as Handler);
}

export const windowLabel = label;
export const params = new URLSearchParams(location.search);
export const closeWindow = () => invoke('win:close');
/** Drags a finished file out of the app to Explorer or another program. */
export const startDrag = (id: string) => invoke('dl:drag', id).catch(() => {});
export const runMenu = (id: string) => invoke('app:menu', id);
