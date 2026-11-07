import * as React from 'react';
import { toast } from 'sonner';
import { closeWindow, invoke } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox, CheckField, Select } from '@/components/ui/controls';
import { FileIcon, Field } from '@/components/ui/display';
import { FolderInput } from '@/components/ui/FolderInput';
import { bytes, glob } from '@/utils/format';
import { extOf, typeOfName } from '@/utils/files';
import type { LinksPayload } from '@/types/models';
import { WindowShell, usePayload } from './shell';

const PAGE_EXT = new Set(['', 'htm', 'html', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'cgi']);
type LinkRow = { url: string; name: string; text: string; ext: string; size: number | null; type: string; checked: boolean; probed: boolean };

function toRow(l: { url: string; text?: string }): LinkRow {
  let name = l.url;
  let last = '';
  try {
    const u = new URL(l.url);
    last = decodeURIComponent(u.pathname.split('/').pop() || '');
    name = last || u.hostname;
  } catch {
    /* keep the raw address */
  }
  const ext = extOf(last);
  return { url: l.url, name, text: l.text || '', ext, size: null, type: '', checked: !PAGE_EXT.has(ext), probed: false };
}

// A web page rather than a file: the server says HTML, or (before probing) the address looks like one.
const isPage = (r: LinkRow) => (r.type ? /html/.test(r.type) : PAGE_EXT.has(r.ext));

/** “Download all links”, batch downloads and imports: pick which addresses to add. */
export default function LinksWindow() {
  const p = usePayload<LinksPayload>();
  const queues = useApp((s) => s.queues);
  const [rows, setRows] = React.useState<LinkRow[]>([]);
  const [hidePages, setHidePages] = React.useState(true);
  const [filter, setFilter] = React.useState('');
  const [saveDir, setSaveDir] = React.useState('');
  const [queueId, setQueueId] = React.useState('main');
  const [start, setStart] = React.useState(false);

  React.useEffect(() => {
    if (p === undefined) return;
    if (!p) return void closeWindow();
    void invoke('win:setTitle', p.title || 'Download all links');
    const all = p.links.map(toRow);
    setRows(all);
    if (p.noProbe) return;
    // Two workers probe six addresses at a time for size and type.
    let live = true;
    const todo = all.map((r) => r.url);
    const worker = async () => {
      while (live && todo.length) {
        const batch = todo.splice(0, 6);
        const res = await invoke('util:probe', batch, { referer: p.referer }).catch(() => ({}) as Record<string, { size?: number; type?: string }>);
        if (!live) return;
        setRows((rs) =>
          rs.map((r) => {
            if (!batch.includes(r.url)) return r;
            const x = res[r.url] || {};
            const type = x.type || '';
            return { ...r, size: x.size ?? null, type, probed: true, checked: /html/.test(type) ? false : r.checked };
          }),
        );
      }
    };
    void Promise.all([worker(), worker()]);
    return () => {
      live = false;
    };
  }, [p]);

  const res = React.useMemo(() => filter.split(/[\s,;]+/).filter(Boolean).map(glob), [filter]);
  const visible = rows.filter((r) => (!hidePages || !isPage(r)) && (!res.length || res.some((re) => re.test(r.name))));
  const chosen = visible.filter((r) => r.checked);
  const setChecked = (urls: Set<string>, on: boolean) => setRows((rs) => rs.map((r) => (urls.has(r.url) ? { ...r, checked: on } : r)));
  const ok = async () => {
    if (!p || !chosen.length) return toast('Nothing is checked');
    await invoke(
      'dl:addMany',
      chosen.map((r) => ({ url: r.url, description: r.text, referer: p.referer, cookies: p.cookies, userAgent: p.userAgent, auth: p.auth || undefined, saveDir: saveDir || undefined, size: r.size || undefined })),
      { queueId: queueId || null, start },
    );
    void closeWindow();
  };
  if (!p) return null;

  return (
    <WindowShell
      className="flex flex-col gap-3"
      footerStart={
        <span className="tnum text-sm text-fg-2">
          {chosen.length} of {visible.length} checked · {bytes(chosen.reduce((a, r) => a + (r.size || 0), 0), '0 B')}
        </span>
      }
      footer={
        <>
          <Button onClick={() => closeWindow()}>Cancel</Button>
          <Button variant="primary" disabled={!chosen.length} onClick={ok}>
            Add {chosen.length || ''} download{chosen.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm text-fg-2">Check the files to download. Sizes and types are checked in the background.</p>
        <CheckField label="Hide web pages" checked={hidePages} onChange={setHidePages} />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter, e.g. *.zip *.pdf" className="w-44" aria-label="Filter by file name" />
      </div>
      <div className="min-h-40 flex-1 overflow-auto rounded-lg border border-line">
        <table className="w-full min-w-[44rem] table-fixed text-sm">
          <thead className="sticky top-0 z-[1] bg-raised text-xs text-fg-3">
            <tr className="border-b border-line">
              <th className="w-9 px-2 py-1.5">
                <Checkbox checked={chosen.length && chosen.length === visible.length ? true : chosen.length ? 'indeterminate' : false} onChange={(v) => setChecked(new Set(visible.map((r) => r.url)), v)} aria-label="Check all" />
              </th>
              <th className="w-[30%] px-2 py-1.5 text-left font-medium">File name</th>
              <th className="w-20 px-2 py-1.5 text-right font-medium">Size</th>
              <th className="w-28 px-2 py-1.5 text-left font-medium">Type</th>
              <th className="w-[20%] px-2 py-1.5 text-left font-medium">Description</th>
              <th className="px-2 py-1.5 text-left font-medium">Address</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.url} className="border-b border-line/60 hover:bg-subtle" onClick={(e) => (e.target as HTMLElement).tagName !== 'BUTTON' && setChecked(new Set([r.url]), !r.checked)}>
                <td className="px-2 py-1 text-center">
                  <Checkbox checked={r.checked} onChange={(v) => setChecked(new Set([r.url]), v)} aria-label={`Download ${r.name}`} />
                </td>
                <td className="px-2 py-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <FileIcon type={typeOfName(r.name)} size="sm" />
                    <span className="truncate" title={r.name}>
                      {r.name}
                    </span>
                  </span>
                </td>
                <td className="tnum truncate px-2 py-1 text-right text-fg-2">{r.size != null ? bytes(r.size) : r.probed ? '' : '…'}</td>
                <td className="truncate px-2 py-1 text-fg-2" title={r.type}>
                  {r.type.split(';')[0]}
                </td>
                <td className="truncate px-2 py-1 text-fg-2" title={r.text}>
                  {r.text}
                </td>
                <td className="truncate px-2 py-1 font-mono text-xs text-fg-3" title={r.url}>
                  {r.url}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && <div className="p-6 text-center text-sm text-fg-3">{rows.length ? 'No links match the filter' : 'No links'}</div>}
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field label="Save to">
          <FolderInput value={saveDir} onChange={setSaveDir} placeholder="The category folder for each file type" />
        </Field>
        <div className="flex items-center gap-3">
          <Field label="Add to">
            <Select value={queueId} onChange={setQueueId} options={[['', 'No queue'], ...queues.filter((q) => q.type === 'download').map((q) => [q.id, q.name] as const)]} className="w-40" />
          </Field>
          <div className="pb-1.5">
            <CheckField label="Start now" checked={start} onChange={setStart} />
          </div>
        </div>
      </div>
    </WindowShell>
  );
}
