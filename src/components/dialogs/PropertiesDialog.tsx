import * as React from 'react';
import { ExternalLink, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { invoke } from '@/services/ipc';
import { copyText } from '@/app/commands';
import { useApp } from '@/stores/app';
import { Dialog } from '@/components/ui/overlay';
import { Button } from '@/components/ui/button';
import { Input, NumberInput } from '@/components/ui/input';
import { Select } from '@/components/ui/controls';
import { Badge, Field, FileIcon } from '@/components/ui/display';
import { FolderInput } from '@/components/ui/FolderInput';
import { bytes, date } from '@/utils/format';
import { typeOfItem } from '@/utils/files';
import { phaseOf, PHASE_LABEL } from '@/utils/status';
import type { DownloadItem } from '@/types/models';

type Draft = { fileName: string; saveDir: string; url: string; referer: string; description: string; category: string; maxConnections: number; speedLimitKB: number; user: string; pass: string };

export function PropertiesDialog({ id, onOpenChange }: { id: string; onOpenChange: (o: boolean) => void }) {
  const categories = useApp((s) => s.categories);
  const [it, setIt] = React.useState<DownloadItem | null>(null);
  const [d, setD] = React.useState<Draft | null>(null);

  React.useEffect(() => {
    void invoke('dl:item', id).then((x) => {
      if (!x) return onOpenChange(false);
      setIt(x);
      setD({ fileName: x.fileName, saveDir: x.saveDir || '', url: x.url, referer: x.referer || '', description: x.description || '', category: x.category || 'general', maxConnections: x.maxConnections || 0, speedLimitKB: x.speedLimitKB || 0, user: x.auth?.user || '', pass: x.auth?.pass || '' });
    });
    // Loaded once per dialog; later edits come from the draft.
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!it || !d) return null;
  const up = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });

  const save = async () => {
    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = { ...it, saveDir: it.saveDir || '', referer: it.referer || '', description: it.description || '', category: it.category || 'general', maxConnections: it.maxConnections || 0, speedLimitKB: it.speedLimitKB || 0 };
    for (const k of ['fileName', 'saveDir', 'url', 'referer', 'description', 'category', 'maxConnections', 'speedLimitKB'] as const) if (d[k] !== before[k]) patch[k] = d[k];
    if (d.user !== (it.auth?.user || '') || d.pass !== (it.auth?.pass || '')) patch.auth = d.user ? { user: d.user, pass: d.pass } : null;
    if (Object.keys(patch).length) {
      try {
        await invoke('dl:update', id, patch);
      } catch (e) {
        toast.error((e as Error).message);
        return;
      }
    }
    onOpenChange(false);
  };

  const ph = phaseOf(it);
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Download properties"
      size="lg"
      onSubmit={save}
      footerStart={
        <>
          <Button variant="ghost" disabled={it.status !== 'complete'} onClick={() => invoke('dl:open', id)}>
            <ExternalLink />
            Open
          </Button>
          <Button variant="ghost" onClick={() => invoke('dl:openFolder', id)}>
            <FolderOpen />
            Open folder
          </Button>
        </>
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="mb-5 flex items-center gap-3 rounded-lg border border-line bg-subtle/50 p-3">
        <FileIcon type={typeOfItem(it)} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{it.fileName}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
            <Badge tone={ph === 'completed' ? 'ok' : ph === 'failed' ? 'danger' : ph === 'paused' ? 'warn' : ph === 'queued' ? 'neutral' : 'accent'}>{PHASE_LABEL[ph]}</Badge>
            <span>{bytes(it.size) || 'Size unknown'}</span>
            {it.resumable != null && <span>· {it.resumable ? 'Resumable' : 'Cannot be resumed'}</span>}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
        <Field label="File name" className="col-span-2">
          <Input value={d.fileName} onChange={(e) => up('fileName', e.target.value)} />
        </Field>
        <Field label="Save to" className="col-span-2">
          <FolderInput value={d.saveDir} onChange={(v) => up('saveDir', v)} />
        </Field>
        <Field label="Address" className="col-span-2" hint={it.status !== 'complete' ? 'Change it to refresh an expired link. Progress is kept if the file is the same.' : undefined}>
          <Input value={d.url} onChange={(e) => up('url', e.target.value)} className="font-mono text-xs" />
        </Field>
        <Field label="Category">
          <Select value={d.category} onChange={(v) => up('category', v)} options={categories.map((c) => [c.id, c.name] as const)} />
        </Field>
        <Field label="Referer">
          <Input value={d.referer} onChange={(e) => up('referer', e.target.value)} />
        </Field>
        <Field label="Description" className="col-span-2">
          <Input value={d.description} onChange={(e) => up('description', e.target.value)} />
        </Field>
        <Field label="Login">
          <Input value={d.user} onChange={(e) => up('user', e.target.value)} placeholder="User name" autoComplete="off" />
        </Field>
        <Field label="Password">
          <Input type="password" value={d.pass} onChange={(e) => up('pass', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Connections" hint="0 uses the default from settings">
          <NumberInput value={d.maxConnections} min={0} max={32} onValue={(v) => up('maxConnections', v)} className="w-24" />
        </Field>
        <Field label="Speed limit (KB/s)" hint="0 = unlimited">
          <NumberInput value={d.speedLimitKB} min={0} onValue={(v) => up('speedLimitKB', v)} className="w-24" />
        </Field>
      </div>
      <dl className="mt-5 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 border-t border-line pt-3 text-xs">
        <dt className="text-fg-3">Added</dt>
        <dd className="text-fg-2">{date(it.added) || '—'}</dd>
        <dt className="text-fg-3">Last try</dt>
        <dd className="text-fg-2">{date(it.lastTry) || '—'}</dd>
        {it.savedPath && (
          <>
            <dt className="text-fg-3">Saved as</dt>
            <dd className="truncate font-mono text-fg-2 select-text" title={it.savedPath}>
              {it.savedPath}
            </dd>
          </>
        )}
        {it.error && (
          <>
            <dt className="text-fg-3">Last error</dt>
            <dd className="text-danger">{it.error}</dd>
          </>
        )}
      </dl>
      {!!it.log?.length && (
        <section className="mt-4 border-t border-line pt-3" aria-label="Log">
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-fg-2">Log</h3>
            <Button variant="ghost" size="sm" onClick={() => copyText(it.log!.map((e) => `${new Date(e.tsMs).toISOString()}\t${e.kind}\t${e.text}`).join('\n'), 'Log copied')}>
              Copy log
            </Button>
          </div>
          <ol className="max-h-40 overflow-y-auto rounded-md border border-line bg-subtle/50 px-2 py-1 font-mono text-[11px] leading-5 select-text" tabIndex={0}>
            {it.log.map((e, i) => (
              <li key={i} className="grid grid-cols-[9.5rem_5.5rem_1fr] gap-x-2">
                <time className="text-fg-3">{new Date(e.tsMs).toLocaleString()}</time>
                <span className={e.kind === 'failed' || e.kind === 'changed' ? 'text-danger' : 'text-fg-3'}>{e.kind}</span>
                <span className="min-w-0 break-words text-fg-2">{e.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </Dialog>
  );
}
