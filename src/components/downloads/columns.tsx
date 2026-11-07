// Column registry for download lists. The keys the user can show, hide and reorder are the ones
// saved in settings.appearance.columns; the torrent columns are only used by the BitTorrent page.
import * as React from 'react';
import { Check, ListOrdered, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ColumnKey, DownloadItem, DownloadStats, Queue } from '@/types/models';
import { Badge, FileIcon, Progress } from '@/components/ui/display';
import { Tooltip } from '@/components/ui/overlay';
import { bytes, date, duration, rate } from '@/utils/format';
import { typeOfItem } from '@/utils/files';
import { itemSize, phaseOf, PHASE_TONE, progressOf, statusLine } from '@/utils/status';
import { cn } from '@/utils/cn';

export type ListColumn = ColumnKey | 'upRate' | 'peers' | 'uploaded';

export interface ColumnDef {
  label: string;
  /** Header shown in the column picker when the label is short. */
  long?: string;
  width: number;
  num?: boolean;
  sortable?: boolean;
  cell: (it: DownloadItem, st: DownloadStats | undefined, ctx: { queues: Queue[] }) => React.ReactNode;
}

const text = (v: string | null | undefined) => <span className="truncate text-fg-2" title={v || undefined}>{v || ''}</span>;

export const COLUMNS: Record<ListColumn, ColumnDef> = {
  name: {
    label: 'Name',
    width: 320,
    sortable: true,
    cell: (it) => <NameCell it={it} />,
  },
  queue: {
    label: 'Q',
    long: 'Queue',
    width: 40,
    cell: (it, _st, { queues }) => <QueueMark it={it} queues={queues} />,
  },
  size: { label: 'Size', width: 88, num: true, sortable: true, cell: (it) => <span className="tnum text-fg-2">{bytes(it.size) || (it.estimatedSize ? '~' + bytes(it.estimatedSize) : '—')}</span> },
  status: { label: 'Progress', long: 'Status and progress', width: 190, sortable: true, cell: (it, st) => <StatusCell it={it} st={st} /> },
  timeLeft: { label: 'Time left', width: 84, num: true, sortable: true, cell: (it) => <span className="tnum text-fg-2">{it.status === 'downloading' ? duration(it.eta) : ''}</span> },
  rate: { label: 'Speed', long: 'Transfer rate', width: 92, num: true, sortable: true, cell: (it) => <span className="tnum font-medium text-fg">{it.status === 'downloading' ? rate(it.rate) : ''}</span> },
  lastTry: { label: 'Last try', width: 150, sortable: true, cell: (it) => text(date(it.lastTry)) },
  added: { label: 'Added', long: 'Date added', width: 150, sortable: true, cell: (it) => text(date(it.added)) },
  description: { label: 'Description', width: 180, sortable: true, cell: (it) => text(it.description) },
  saveDir: { label: 'Save to', width: 200, sortable: true, cell: (it) => text(it.saveDir) },
  referer: { label: 'Referer', width: 200, sortable: true, cell: (it) => text(it.referer) },
  parentPage: { label: 'Web page', long: 'Parent web page', width: 200, sortable: true, cell: (it) => text(it.parentPage) },
  url: { label: 'Address', width: 260, sortable: true, cell: (it) => <span className="truncate font-mono text-xs text-fg-3" title={it.url}>{it.url}</span> },
  connections: { label: 'Conn.', long: 'Connections', width: 56, num: true, cell: (it, st) => <span className="tnum text-fg-2">{it.status === 'downloading' && st?.connections?.length ? st.connections.length : ''}</span> },
  upRate: { label: 'Upload', width: 88, num: true, cell: (it, st) => <span className="tnum text-fg-2">{it.status === 'downloading' && st?.uploadRate ? rate(st.uploadRate) : ''}</span> },
  peers: { label: 'Peers', width: 76, num: true, cell: (it, st) => <span className="tnum text-fg-2" title={st?.peersSeen ? `${st.peers ?? 0} connected of ${st.peersSeen} found` : undefined}>{it.status === 'downloading' && st ? `${st.peers ?? 0}${st.peersSeen ? ` / ${st.peersSeen}` : ''}` : ''}</span> },
  uploaded: {
    label: 'Ratio',
    long: 'Uploaded and share ratio',
    width: 110,
    num: true,
    cell: (it, st) => {
      if (!st?.uploaded) return null;
      const size = itemSize(it);
      return <span className="tnum text-fg-2">{bytes(st.uploaded)}{size ? <span className="text-fg-3"> · {(st.uploaded / size).toFixed(2)}</span> : null}</span>;
    },
  },
};

/** The columns the user can choose from, in the picker's order. */
export const USER_COLUMNS: ColumnKey[] = ['name', 'queue', 'size', 'status', 'timeLeft', 'rate', 'connections', 'lastTry', 'added', 'description', 'saveDir', 'referer', 'parentPage', 'url'];

const KIND_BADGE: Record<string, string> = { hls: 'HLS', muxed: 'Merged', torrent: 'Torrent', ftp: 'FTP' };

function NameCell({ it }: { it: DownloadItem }) {
  const q = it.kind === 'ytdlp' ? it.ytdlp?.quality : null;
  const badge = q ? (q === 'audio' ? 'Audio' : q === 'best' ? 'Best' : `${q}p`) : KIND_BADGE[it.kind || ''];
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <FileIcon type={typeOfItem(it)} size="sm" />
      <span className="truncate font-medium text-fg" title={it.fileName}>
        {it.fileName || it.url}
      </span>
      {badge && <Badge className="shrink-0">{badge}</Badge>}
    </span>
  );
}

function StatusCell({ it, st }: { it: DownloadItem; st?: DownloadStats }) {
  const ph = phaseOf(it);
  const tone = PHASE_TONE[ph];
  const pct = st?.fraction != null && st.hlsSegments ? st.fraction * 100 : progressOf(it);
  const line = statusLine(it);
  if (ph === 'completed')
    return (
      <span className="flex items-center gap-1.5 text-fg-2">
        <Check className="size-3.5 text-ok" strokeWidth={2.5} />
        Completed
      </span>
    );
  if (ph === 'failed')
    return (
      <Tooltip content={line}>
        <span className="flex min-w-0 items-center gap-1.5 text-danger">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="truncate">{line === 'Failed' ? 'Failed' : line}</span>
        </span>
      </Tooltip>
    );
  const showBar = ph !== 'queued' || (pct ?? 0) > 0;
  return (
    <span className="flex w-full min-w-0 flex-col gap-1">
      <span className="flex items-baseline justify-between gap-2 text-xs leading-none">
        <span className={cn('truncate font-medium', tone.text)} title={line}>
          {line}
        </span>
        {pct != null && pct > 0 && <span className="tnum shrink-0 text-fg-3">{pct.toFixed(pct >= 99.95 ? 0 : 1)}%</span>}
      </span>
      {showBar && <Progress value={ph === 'connecting' || ph === 'processing' ? (pct || null) : pct ?? (ph === 'downloading' ? null : 0)} barClass={tone.bar} className="h-[3px]" />}
    </span>
  );
}

function QueueMark({ it, queues }: { it: DownloadItem; queues: Queue[] }) {
  const qs = queues.filter((q) => q.items.includes(it.id));
  if (!qs.length) return null;
  const Icon = qs.some((q) => q.type === 'sync') ? RefreshCw : ListOrdered;
  return (
    <Tooltip content={qs.map((q) => q.name).join(', ')}>
      <span className="flex items-center text-fg-3">
        <Icon className="size-3.5" />
      </span>
    </Tooltip>
  );
}
