import * as React from 'react';
import { ArrowDown, ArrowUp, Gauge, Globe2, ListOrdered, Clipboard } from 'lucide-react';
import { runMenu } from '@/services/ipc';
import { saveSettings, useApp } from '@/stores/app';
import { navigate } from '@/stores/ui';
import { Popover, Tooltip } from '@/components/ui/overlay';
import { Switch } from '@/components/ui/controls';
import { NumberInput } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/cn';
import { rate } from '@/utils/format';

function useTotals() {
  const items = useApp((s) => s.items);
  const stats = useApp((s) => s.stats);
  return React.useMemo(() => {
    let active = 0, down = 0, up = 0, total = 0;
    for (const id in items) {
      total++;
      const it = items[id];
      if (it.status === 'downloading') {
        active++;
        down += it.rate || 0;
        up += stats[id]?.uploadRate || 0;
      }
    }
    return { active, down, up, total };
  }, [items, stats]);
}

export function StatusBar() {
  const { active, down, up, total } = useTotals();
  const settings = useApp((s) => s.settings);
  const queues = useApp((s) => s.queues);
  const running = queues.filter((q) => q.running);
  const lim = settings.speedLimiter;
  const integration = settings.general.browserIntegration;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-1 border-t border-line bg-sidebar px-2 text-xs text-fg-3">
      <span className="px-1.5">
        {total} download{total === 1 ? '' : 's'}
        {active ? <span className="text-fg-2"> · {active} active</span> : null}
      </span>
      {down > 0 && (
        <span className="tnum flex items-center gap-0.5 px-1.5 font-medium text-accent">
          <ArrowDown className="size-3" strokeWidth={2.5} />
          {rate(down)}
        </span>
      )}
      {up > 0 && (
        <span className="tnum flex items-center gap-0.5 px-1.5 text-fg-2">
          <ArrowUp className="size-3" strokeWidth={2.5} />
          {rate(up)}
        </span>
      )}
      {running.length > 0 && (
        <button onClick={() => navigate('queues', { queueId: running[0].id })} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-fg-2">
          <ListOrdered className="size-3" />
          {running.map((q) => q.name).join(', ')}
        </button>
      )}

      <div className="flex-1" />

      <Popover
        align="end"
        className="w-64"
        trigger={
          <button className={cn('flex items-center gap-1 rounded px-1.5 py-0.5 outline-none hover:bg-muted hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-ring/40', lim.enabled && 'text-warn hover:text-warn')}>
            <Gauge className="size-3" />
            {lim.enabled ? `Limited to ${lim.kbps} KB/s` : 'No speed limit'}
          </button>
        }
      >
        <LimiterPopover />
      </Popover>

      <Tooltip content={settings.general.monitorClipboard ? 'Clipboard monitoring is on: copied addresses start downloads' : 'Clipboard monitoring is off'}>
        <button onClick={() => runMenu('clipboard')} className={cn('flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-fg-2', settings.general.monitorClipboard && 'text-fg-2')} aria-pressed={settings.general.monitorClipboard}>
          <Clipboard className="size-3" />
          Clipboard
        </button>
      </Tooltip>
      <Tooltip content={integration ? 'Downloads from the browser extension are taken over. Click to turn off.' : 'Browser downloads are not taken over. Click to turn on.'}>
        <button onClick={() => runMenu('integration')} className={cn('flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted', integration ? 'text-fg-2' : 'text-danger')} aria-pressed={integration}>
          <Globe2 className="size-3" />
          {integration ? 'Browser integration' : 'Browser integration off'}
          <span className={cn('size-1.5 rounded-full', integration ? 'bg-ok' : 'bg-danger')} />
        </button>
      </Tooltip>
    </footer>
  );
}

function LimiterPopover() {
  const lim = useApp((s) => s.settings.speedLimiter);
  const [kbps, setKbps] = React.useState(lim.kbps);
  React.useEffect(() => setKbps(lim.kbps), [lim.kbps]);
  const presets = [128, 512, 1024, 4096];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Speed limiter</div>
          <div className="text-xs text-fg-3">Caps the total download speed</div>
        </div>
        <Switch checked={lim.enabled} onChange={(v) => saveSettings({ speedLimiter: { enabled: v } })} aria-label="Speed limiter" />
      </div>
      <div className="flex items-center gap-2">
        <NumberInput value={kbps} min={1} onValue={setKbps} onBlur={() => kbps > 0 && saveSettings({ speedLimiter: { kbps } })} onKeyDown={(e) => e.key === 'Enter' && kbps > 0 && saveSettings({ speedLimiter: { kbps, enabled: true } })} className="w-24" aria-label="Maximum speed" />
        <span className="text-sm text-fg-2">KB/s</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {presets.map((p) => (
          <Button key={p} size="sm" variant={lim.enabled && lim.kbps === p ? 'primary' : 'secondary'} onClick={() => saveSettings({ speedLimiter: { kbps: p, enabled: true } })}>
            {p >= 1024 ? `${p / 1024} MB/s` : `${p} KB/s`}
          </Button>
        ))}
      </div>
    </div>
  );
}
