export function bytes(n: number | null | undefined, empty = ''): string {
  if (n == null || !Number.isFinite(n) || n < 0) return empty;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(n)} B` : `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${u[i]}`;
}

export function rate(n: number | null | undefined): string {
  return n && n > 0 ? bytes(n) + '/s' : '';
}

export function duration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function date(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "Today", "Yesterday" or a date — for grouping history. */
export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function time(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function percent(done: number, total: number | null | undefined): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, (100 * done) / total);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** File name from an address, for rows that have no name yet. */
export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').pop() || '') || u.hostname;
  } catch {
    return url;
  }
}

/** A local file path as a file:/// address (how .torrent files are added). */
export function fileUrl(f: string): string {
  // Only Windows paths (C:\… or \\server\…) use backslashes as separators; on Unix it is a file-name character.
  const p = /^([a-z]:)?\\/i.test(f) ? f.replace(/\\/g, '/') : f;
  return 'file:///' + p.replace(/^\//, '').split('/').map((x, i) => (i === 0 && /^[a-z]:$/i.test(x) ? x : encodeURIComponent(x))).join('/');
}

export const URL_RE = /^((https?|ftp):\/\/\S+|magnet:\?\S+|file:\/\/\/\S+\.torrent)$/i;

/** Addresses in dropped or pasted text. */
export function extractUrls(text: string, magnets = true): string[] {
  const re = magnets ? /\b(?:(?:https?|ftp):\/\/|magnet:\?)[^\s"'<>]+/gi : /\b(?:https?|ftp):\/\/[^\s"'<>]+/gi;
  return [...new Set(text.match(re) || [])];
}

/** Glob with * to a case-insensitive whole-string RegExp. */
export function glob(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
}
