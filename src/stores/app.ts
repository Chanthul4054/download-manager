// Backend state mirrored in the main window. Progress ticks (every 500 ms) replace only the changed
// items, and `rev` moves only when the list's shape changes (added, removed, status or name), so the
// list re-sorts on real changes while each row re-renders on its own item.
import { create } from 'zustand';
import { invoke, on } from '@/services/ipc';
import type { AppState, Category, DeepPartial, DownloadItem, DownloadStats, GrabberPresets, GrabberSummary, Queue, Settings } from '@/types/models';

interface AppStore {
  ready: boolean;
  version: string;
  platform: string;
  settings: Settings;
  categories: Category[];
  queues: Queue[];
  grabberPresets: GrabberPresets;
  grabbers: GrabberSummary[];
  items: Record<string, DownloadItem>;
  stats: Record<string, DownloadStats>;
  rev: number;
  lgCount: number;
}

export const useApp = create<AppStore>(() => ({
  ready: false,
  version: '',
  platform: '',
  settings: null as unknown as Settings,
  categories: [],
  queues: [],
  grabberPresets: {} as GrabberPresets,
  grabbers: [],
  items: {},
  stats: {},
  rev: 0,
  lgCount: 0,
}));

const set = useApp.setState;
const get = useApp.getState;

const structural = (a: DownloadItem | undefined, b: Partial<DownloadItem>) =>
  !a || (b.status !== undefined && a.status !== b.status) || (b.fileName !== undefined && a.fileName !== b.fileName) || (b.category !== undefined && a.category !== b.category);

export async function loadState(st?: AppState) {
  st = st || (await invoke('state'));
  const items: Record<string, DownloadItem> = {};
  for (const it of st.items) items[it.id] = it;
  set({ ready: true, version: st.version, platform: st.platform, settings: st.settings, categories: st.categories, queues: st.queues, grabberPresets: st.grabberPresets, items, rev: get().rev + 1 });
}

export const refreshGrabbers = async () => set({ grabbers: await invoke('grabber:list') });

/** Wires backend events into the store. Returns the cleanup. */
export function connectStore(): () => void {
  const offs = [
    on('dl:changed', (it) => {
      const prev = get().items[it.id];
      set((s) => ({ items: { ...s.items, [it.id]: { ...prev, ...it } }, rev: structural(prev, it) ? s.rev + 1 : s.rev }));
    }),
    on('dl:removed', (ids) => {
      set((s) => {
        const items = { ...s.items };
        const stats = { ...s.stats };
        for (const id of ids) {
          delete items[id];
          delete stats[id];
        }
        return { items, stats, rev: s.rev + 1 };
      });
    }),
    on('dl:progress', (batch) => {
      set((s) => {
        const items = { ...s.items };
        const stats = { ...s.stats };
        let bump = false;
        for (const { id, item, stats: st } of batch) {
          const prev = items[id];
          if (!prev) continue;
          if (structural(prev, item)) bump = true;
          items[id] = { ...prev, ...item };
          stats[id] = st;
        }
        return { items, stats, rev: bump ? s.rev + 1 : s.rev };
      });
    }),
    on('q:changed', (queues) => set({ queues })),
    on('settings', (settings) => set({ settings })),
    on('categories', (categories) => set((s) => ({ categories, rev: s.rev + 1 }))),
    on('grabber:list', () => void refreshGrabbers()),
    on('grabber:done', () => void refreshGrabbers()),
    on('lg:changed', (lg) => set({ lgCount: lg.packages.reduce((a, p) => a + p.links.length, 0) })),
  ];
  return () => offs.forEach((f) => f());
}

// ---- actions -----------------------------------------------------------------------------------

/** Merges a patch into the settings; the backend broadcasts the result back. */
export const saveSettings = (patch: DeepPartial<Settings>) => invoke('settings:save', patch);
/** Lists are replaced, not merged. */
export const replaceList = (section: keyof Settings, key: string, list: unknown[]) => invoke('settings:replaceList', section, key, list);
