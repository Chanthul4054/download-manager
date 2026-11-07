// Which downloads a list shows, in which order.
import type { DownloadItem, Settings } from '@/types/models';
import type { FindOpts, StatusView } from '@/stores/ui';
import { phaseOf } from '@/utils/status';

export function matchesView(it: DownloadItem, view: StatusView): boolean {
  if (view === 'all') return true;
  const p = phaseOf(it);
  if (view === 'active') return p === 'downloading' || p === 'connecting' || p === 'processing';
  if (view === 'queued') return p === 'queued';
  if (view === 'paused') return p === 'paused';
  if (view === 'completed') return p === 'completed';
  return p === 'failed';
}

export function matchesSearch(it: DownloadItem, q: string, o: FindOpts): boolean {
  q = q.trim();
  if (!q) return true;
  const norm = (s: string | null | undefined) => (o.matchCase ? String(s || '') : String(s || '').toLowerCase());
  const needle = norm(q);
  const hit = (s: string | null | undefined) => (o.whole ? norm(s) === needle : norm(s).includes(needle));
  return (o.name && hit(it.fileName)) || (o.description && hit(it.description)) || (o.address && (hit(it.url) || hit(it.referer) || hit(it.parentPage)));
}

const RANK: Record<string, number> = { downloading: 0, waiting: 1, error: 2, paused: 3, complete: 4 };

export function sortItems(list: DownloadItem[], sort: Settings['appearance']['sort']): DownloadItem[] {
  const { key, dir } = sort;
  const val = (x: DownloadItem): string | number => {
    switch (key) {
      case 'name': return (x.fileName || '').toLowerCase();
      case 'size': return x.size ?? -1;
      case 'status': return RANK[x.status] ?? 5;
      case 'timeLeft': return x.status === 'downloading' ? x.eta ?? 1e12 : 1e13;
      case 'rate': return x.status === 'downloading' ? x.rate || 0 : -1;
      case 'lastTry': return x.lastTry || 0;
      case 'description': return (x.description || '').toLowerCase();
      case 'saveDir': return (x.saveDir || '').toLowerCase();
      case 'referer': return (x.referer || '').toLowerCase();
      case 'parentPage': return (x.parentPage || '').toLowerCase();
      case 'url': return x.url;
      default: return x.added || 0;
    }
  };
  const m = dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = val(a), vb = val(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * m;
  });
}
