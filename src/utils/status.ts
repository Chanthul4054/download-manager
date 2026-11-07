import type { DownloadItem } from '@/types/models';
import { percent } from './format';

/** What the UI shows; finer than the backend's `status`. */
export type Phase = 'downloading' | 'connecting' | 'processing' | 'queued' | 'paused' | 'completed' | 'failed';

export function isRunning(it: Pick<DownloadItem, 'status'>): boolean {
  return it.status === 'downloading' || it.status === 'waiting';
}

export function canResume(it: Pick<DownloadItem, 'status'>): boolean {
  return it.status !== 'complete' && !isRunning(it);
}

export function phaseOf(it: DownloadItem): Phase {
  switch (it.status) {
    case 'complete':
      return 'completed';
    case 'error':
      return 'failed';
    case 'waiting':
      return 'queued';
    case 'downloading': {
      const t = it.statusText || '';
      if (/connect|starting|resolving|reading video|fetching/i.test(t) && !it.rate) return 'connecting';
      if (/moving|merg|process|convert|verif|checking/i.test(t)) return 'processing';
      return 'downloading';
    }
    default:
      return it.downloaded > 0 ? 'paused' : 'queued';
  }
}

export const PHASE_LABEL: Record<Phase, string> = {
  downloading: 'Downloading',
  connecting: 'Connecting',
  processing: 'Processing',
  queued: 'Queued',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
};

/** Tailwind classes for a phase: text colour and the progress fill. */
export const PHASE_TONE: Record<Phase, { text: string; bar: string; dot: string }> = {
  downloading: { text: 'text-accent', bar: 'bg-accent', dot: 'bg-accent' },
  connecting: { text: 'text-info', bar: 'bg-info', dot: 'bg-info' },
  processing: { text: 'text-violet', bar: 'bg-violet', dot: 'bg-violet' },
  queued: { text: 'text-fg-3', bar: 'bg-fg-3', dot: 'bg-fg-3' },
  paused: { text: 'text-warn', bar: 'bg-warn', dot: 'bg-warn' },
  completed: { text: 'text-ok', bar: 'bg-ok', dot: 'bg-ok' },
  failed: { text: 'text-danger', bar: 'bg-danger', dot: 'bg-danger' },
};

export function itemSize(it: DownloadItem): number | null {
  return it.size || it.estimatedSize || null;
}

export function progressOf(it: DownloadItem): number | null {
  if (it.status === 'complete') return 100;
  return percent(it.downloaded || 0, itemSize(it));
}

/** One line describing the state, like the old status column. */
export function statusLine(it: DownloadItem): string {
  const ph = phaseOf(it);
  if (ph === 'failed') return it.error || 'Failed';
  if (it.status === 'waiting') return 'Waiting for a free slot';
  if (ph === 'connecting' || ph === 'processing') return it.statusText || PHASE_LABEL[ph];
  if (it.statusText && /limit/i.test(it.statusText) && it.status !== 'downloading') return it.statusText;
  return PHASE_LABEL[ph];
}
