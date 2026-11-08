// Main-window UI state: current page, list selection, search and open dialogs.
import { create } from 'zustand';
import type { Category } from '@/types/models';

export type Page = 'downloads' | 'video' | 'torrents' | 'history' | 'linkgrabber' | 'grabber' | 'queues' | 'settings';
export type StatusView = 'all' | 'active' | 'queued' | 'paused' | 'completed' | 'failed';
export type SettingsSection =
  | 'general' | 'appearance' | 'downloads' | 'saveto' | 'filetypes' | 'connection' | 'limits' | 'proxy' | 'logins' | 'browser' | 'video' | 'torrent' | 'sounds' | 'about';

export interface FindOpts {
  name: boolean;
  description: boolean;
  address: boolean;
  matchCase: boolean;
  whole: boolean;
}

export type DialogState =
  | { type: 'addUrl'; url?: string }
  | { type: 'batch' }
  | { type: 'properties'; id: string }
  | { type: 'category'; category?: Category }
  | { type: 'columns' }
  | { type: 'help'; topic?: string }
  | { type: 'tip' }
  | null;

interface UiStore {
  page: Page;
  /** Category filter on the downloads page. */
  category: string | null;
  view: StatusView;
  queueId: string | null;
  grabberId: string | null;
  settingsSection: SettingsSection;
  search: string;
  findOpts: FindOpts;
  sel: Set<string>;
  anchor: string | null;
  focus: string | null;
  /** Rows in display order, for keyboard and shift-click. Set by the visible list. */
  order: string[];
  dialog: DialogState;
  detailsId: string | null;
}

export const useUi = create<UiStore>(() => ({
  page: 'downloads',
  category: null,
  view: 'all',
  queueId: null,
  grabberId: null,
  settingsSection: 'general',
  search: '',
  findOpts: { name: true, description: true, address: true, matchCase: false, whole: false },
  sel: new Set(),
  anchor: null,
  focus: null,
  order: [],
  dialog: null,
  detailsId: null,
}));

const set = useUi.setState;

export function navigate(page: Page, opts: { category?: string | null; queueId?: string | null; grabberId?: string | null; section?: SettingsSection; view?: StatusView } = {}) {
  set((s) => ({
    page,
    category: opts.category !== undefined ? opts.category : page === 'downloads' ? s.category : null,
    view: opts.view ?? (page === s.page ? s.view : 'all'),
    queueId: opts.queueId !== undefined ? opts.queueId : s.queueId,
    grabberId: opts.grabberId !== undefined ? opts.grabberId : s.grabberId,
    settingsSection: opts.section ?? s.settingsSection,
    sel: page === s.page && opts.category === undefined ? s.sel : new Set(),
    search: page === s.page ? s.search : '',
    detailsId: page === s.page ? s.detailsId : null,
  }));
}

export const openDialog = (dialog: DialogState) => set({ dialog });
export const closeDialog = () => set({ dialog: null });

// ---- selection ---------------------------------------------------------------------------------

export function selectOnly(id: string) {
  set({ sel: new Set([id]), anchor: id, focus: id });
}

export function clickSelect(id: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
  set((s) => {
    if (e.shiftKey && s.anchor) {
      const a = s.order.indexOf(s.anchor), b = s.order.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [x, y] = a < b ? [a, b] : [b, a];
        const sel = new Set(e.ctrlKey || e.metaKey ? s.sel : []);
        for (const r of s.order.slice(x, y + 1)) sel.add(r);
        return { sel, focus: id };
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const sel = new Set(s.sel);
      if (sel.has(id)) sel.delete(id);
      else sel.add(id);
      return { sel, anchor: id, focus: id };
    }
    return { sel: new Set([id]), anchor: id, focus: id };
  });
}

export const clearSelection = () => set({ sel: new Set(), focus: null });
export const selectAll = () => set((s) => ({ sel: new Set(s.order) }));
