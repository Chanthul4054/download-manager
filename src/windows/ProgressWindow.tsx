import * as React from 'react';
import { ChevronDown, ChevronUp, Pause, Play } from 'lucide-react';
import { closeWindow, invoke, params } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/input';
import { CheckField, Select } from '@/components/ui/controls';
import { FileIcon, Field, Progress } from '@/components/ui/display';
import { Tabs } from '@/components/ui/overlay';
import { bytes, duration, rate } from '@/utils/format';
import { typeOfItem } from '@/utils/files';
import { isRunning } from '@/utils/status';
import { cn } from '@/utils/cn';
import type { CompletionOptions, DownloadItem, DownloadStats } from '@/types/models';
import { KV, WindowShell } from './shell';

const id = params.get('id') || '';
const CONN = [0, 1, 2, 4, 6, 8, 12, 16, 24, 32].map((v) => [v, v ? String(v) : 'Default'] as const);

/** Live progress of one download: status, per-connection map, its own speed limit and what to do when done. */
export default function ProgressWindow() {
  const item = useApp((s) => s.items[id]);
  const [full, setFull] = React.useState<DownloadItem | null>(null);
  const [stats, setStats] = React.useState<DownloadStats | null>(null);
  const [tab, setTab] = React.useState<'status' | 'limiter' | 'complete'>('status');
  const [details, setDetails] = React.useState(true);

  React.useEffect(() => {
    if (!item) void closeWindow();
  }, [item]);
  React.useEffect(() => {
    void invoke('dl:item', id).then(setFull);
    let live = true;
    const tick = async () => {
      const s = await invoke('dl:stats', id).catch(() => null);
      if (!live) return;
      if (!s) return void closeWindow();
      setStats(s);
    };
    void tick();
    const t = setInterval(tick, 500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const size = stats ? stats.size || stats.estimatedSize : null;
  const pct = !stats ? 0 : stats.fraction != null && stats.hlsSegments ? stats.fraction * 100 : size ? (100 * stats.downloaded) / size : 0;
  const running = !!item && isRunning(item);
  React.useEffect(() => {
    if (item) void invoke('win:setTitle', `${size ? Math.floor(pct) + '% ' : ''}${item.fileName}`);
  }, [item?.fileName, Math.floor(pct), !!size]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;
  const downloading = item.status === 'downloading';
  const statusText = running ? item.statusText || 'Receiving data…' : item.status === 'error' ? 'Error: ' + (item.error || '') : item.status === 'complete' ? 'Complete' : 'Paused';

  return (
    <WindowShell
      className="flex flex-col gap-4"
      footerStart={
        tab === 'status' && (
          <Button variant="ghost" onClick={() => setDetails(!details)}>
            {details ? <ChevronUp /> : <ChevronDown />}
            {details ? 'Hide details' : 'Show details'}
          </Button>
        )
      }
      footer={
        <>
          <Button onClick={() => (running ? invoke('dl:stop', [id]) : invoke('dl:start', [id], false))} disabled={item.status === 'complete'}>
            {running ? <Pause /> : <Play />}
            {running ? 'Pause' : 'Resume'}
          </Button>
          <Button
            onClick={async () => {
              if (running) await invoke('dl:stop', [id]);
              void closeWindow();
            }}
          >
            Cancel
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-3">
        <FileIcon type={typeOfItem(item)} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold" title={item.fileName}>
            {item.fileName}
          </div>
          <div className={cn('truncate text-sm', item.status === 'error' ? 'text-danger' : 'text-fg-2')}>{statusText}</div>
        </div>
        <div className="tnum text-xl font-semibold">{size ? `${pct.toFixed(1)}%` : ''}</div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'status', label: 'Status' },
          { value: 'limiter', label: 'Speed limiter' },
          { value: 'complete', label: 'When done' },
        ]}
      />
      {tab === 'status' && stats && (
        <>
          <KV
            rows={[
              ['Address', item.url, 'font-mono text-xs leading-5'],
              ['File size', stats.size ? bytes(stats.size) : stats.estimatedSize ? '≈ ' + bytes(stats.estimatedSize) : 'Unknown'],
              ['Downloaded', `${bytes(stats.downloaded, '0 B')}${size ? ` (${pct.toFixed(2)}%)` : ''}`, 'tnum'],
              ['Transfer rate', downloading ? rate(stats.rate) || '—' : '—', 'tnum'],
              ['Time left', downloading ? duration(stats.eta) || 'Unknown' : '—', 'tnum'],
              ['Resume capability', stats.resumable == null ? 'Unknown' : stats.resumable ? 'Yes' : 'No', stats.resumable === false ? 'text-danger' : undefined],
              ...(item.kind === 'torrent'
                ? ([
                    ['Uploaded', `${bytes(stats.uploaded, '0 B')}${stats.uploadRate ? ` · ${rate(stats.uploadRate)}` : ''}`, 'tnum'],
                    ['Peers', `${stats.peers ?? 0} connected${stats.peersSeen ? ` · ${stats.peersSeen} seen` : ''}`, 'tnum'],
                  ] as [string, string, string][])
                : []),
            ]}
          />
          <Progress value={size || stats.hlsSegments ? Math.min(100, pct) : downloading ? null : 0} className="h-2" />
          {details && <Details stats={stats} downloading={downloading} />}
        </>
      )}
      {tab === 'limiter' && full && <Limiter item={full} />}
      {tab === 'complete' && full && <Completion item={full} />}
    </WindowShell>
  );
}

function Details({ stats, downloading }: { stats: DownloadStats; downloading: boolean }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth;
    const H = 16;
    c.width = w * dpr;
    c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const col = (v: string) => css.getPropertyValue(v).trim();
    g.fillStyle = col('--seg-todo');
    g.fillRect(0, 0, w, H);
    g.fillStyle = col('--seg-done');
    if (stats.hlsSegments?.total) {
      const n = stats.hlsSegments.total;
      for (const i of stats.hlsSegments.done) g.fillRect((i / n) * w, 0, Math.max(1, w / n), H);
      return;
    }
    const total = stats.size;
    if (!total) {
      g.fillRect(0, 0, w * 0.04 + ((Date.now() / 20) % (w * 0.96)), H);
      return;
    }
    for (const [a, , p] of stats.segments || []) if (p > a) g.fillRect((a / total) * w, 0, Math.max(0.5, ((p - a) / total) * w), H);
    g.fillStyle = col('--seg-start');
    for (const cn of stats.connections || []) g.fillRect(Math.floor((cn.start / total) * w), 0, 2, H);
  }, [stats]);
  const hls = !!stats.hlsSegments;
  const conns = stats.connections || [];
  const dot = (v: string, label: string) => (
    <span className="flex items-center gap-1.5">
      <i className="size-2.5 rounded-sm" style={{ background: `var(${v})` }} />
      {label}
    </span>
  );
  return (
    <div className="flex flex-col gap-2">
      <canvas ref={ref} className="h-4 w-full overflow-hidden rounded" aria-label="Downloaded parts of the file" />
      <div className="flex gap-4 text-xs text-fg-3">
        {dot('--seg-done', 'Downloaded')}
        {dot('--seg-start', 'Connection start')}
        {dot('--seg-todo', 'Remaining')}
      </div>
      <div className="max-h-36 overflow-y-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-raised text-xs text-fg-3">
            <tr className="border-b border-line">
              <th className="w-12 px-3 py-1.5 text-left font-medium">No.</th>
              <th className="w-32 px-3 py-1.5 text-right font-medium">Downloaded</th>
              <th className="px-3 py-1.5 text-left font-medium">Info</th>
            </tr>
          </thead>
          <tbody>
            {conns.length ? (
              conns.map((c, i) => (
                <tr key={i} className="border-b border-line/60 last:border-0">
                  <td className="tnum px-3 py-1 text-fg-3">{i + 1}</td>
                  <td className="tnum px-3 py-1 text-right">{hls ? bytes(c.bytes || 0, '0 B') : bytes(c.pos - c.start, '0 B')}</td>
                  <td className="px-3 py-1 text-fg-2">{hls ? `Segment ${c.id}` : c.receiving ? 'Receiving data…' : 'Connecting…'}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={3} className="px-3 py-2 text-fg-3">
                  {downloading ? 'Connecting…' : 'No active connections'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Limiter({ item }: { item: DownloadItem }) {
  const [on, setOn] = React.useState((item.speedLimitKB || 0) > 0);
  const [kb, setKb] = React.useState(item.speedLimitKB || 500);
  const [conns, setConns] = React.useState(item.maxConnections || 0);
  return (
    <div className="flex flex-col gap-4">
      <CheckField
        label="Limit the speed of this download"
        checked={on}
        onChange={(v) => {
          setOn(v);
          void invoke('dl:update', id, { speedLimitKB: v ? kb : 0 });
        }}
      />
      <Field label="Maximum speed">
        <div className="flex items-center gap-2 text-sm text-fg-2">
          <NumberInput
            value={kb}
            min={1}
            disabled={!on}
            onValue={setKb}
            onBlur={() => on && kb >= 1 && invoke('dl:update', id, { speedLimitKB: kb })}
            onKeyDown={(e) => e.key === 'Enter' && on && kb >= 1 && invoke('dl:update', id, { speedLimitKB: kb })}
            className="w-24"
          />
          KB/s
        </div>
      </Field>
      <Field label="Connections" hint="Applies the next time the download starts.">
        <Select
          value={conns}
          onChange={(v) => {
            setConns(v);
            void invoke('dl:update', id, { maxConnections: v });
          }}
          options={CONN}
          className="w-32"
        />
      </Field>
    </div>
  );
}

function Completion({ item }: { item: DownloadItem }) {
  const def = useApp((s) => s.settings.downloads.showCompleteDialog);
  const [oc, setOc] = React.useState<Required<CompletionOptions>>({ showDialog: item.onComplete?.showDialog ?? def, exitApp: !!item.onComplete?.exitApp, power: item.onComplete?.power || 'none', forceTerminate: !!item.onComplete?.forceTerminate });
  const up = (patch: Partial<CompletionOptions>) => {
    const next = { ...oc, ...patch };
    setOc(next);
    void invoke('dl:update', id, { onComplete: next });
  };
  return (
    <div className="flex flex-col gap-4">
      <CheckField label="Show “Download complete”" checked={!!oc.showDialog} onChange={(v) => up({ showDialog: v })} />
      <CheckField label="Exit OpenDM" checked={oc.exitApp} onChange={(v) => up({ exitApp: v })} />
      <Field label="Then">
        <Select value={oc.power} onChange={(v) => up({ power: v })} options={[['none', 'Do nothing'], ['shutdown', 'Shut down the computer'], ['restart', 'Restart the computer'], ['sleep', 'Sleep'], ['hibernate', 'Hibernate']]} className="w-56" />
      </Field>
      <CheckField label="Force programs to close" hint="Unsaved work in other programs may be lost." checked={oc.forceTerminate} onChange={(v) => up({ forceTerminate: v })} disabled={oc.power === 'none'} />
    </div>
  );
}
