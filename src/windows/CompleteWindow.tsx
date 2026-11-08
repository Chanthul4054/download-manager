import * as React from 'react';
import { FolderOpen } from 'lucide-react';
import { closeWindow, invoke, params, startDrag } from '@/services/ipc';
import { saveSettings } from '@/stores/app';
import { Button } from '@/components/ui/button';
import { CheckField } from '@/components/ui/controls';
import { FileIcon } from '@/components/ui/display';
import { bytes } from '@/utils/format';
import { typeOfItem } from '@/utils/files';
import type { DownloadItem } from '@/types/models';
import { KV, WindowShell } from './shell';

const id = params.get('id') || '';

export default function CompleteWindow() {
  const [it, setIt] = React.useState<DownloadItem | null | undefined>(undefined);
  const [dont, setDont] = React.useState(false);
  React.useEffect(() => {
    void invoke('dl:item', id).then((x) => (x ? setIt(x) : closeWindow()));
  }, []);
  if (!it) return null;
  const finish = async (fn?: () => Promise<unknown>) => {
    if (dont) await saveSettings({ downloads: { showCompleteDialog: false } });
    await fn?.();
    void closeWindow();
  };
  return (
    <WindowShell
      footerStart={<CheckField label="Don't show this again" checked={dont} onChange={setDont} />}
      footer={
        <>
          <Button onClick={() => finish()}>Close</Button>
          <Button onClick={() => finish(() => invoke('dl:openFolder', id))}>
            <FolderOpen />
            Open folder
          </Button>
          <Button variant="primary" autoFocus onClick={() => finish(() => invoke('dl:open', id))}>
            Open
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-4">
        <div
          draggable
          onDragStart={(e) => {
            e.preventDefault();
            void startDrag(id);
          }}
          title="Drag the file into a folder or another program"
          className="cursor-grab rounded-xl p-1 hover:bg-subtle active:cursor-grabbing"
        >
          <FileIcon type={typeOfItem(it)} size="xl" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ok">Download complete</div>
          <div className="truncate text-base font-semibold" title={it.fileName}>
            {it.fileName}
          </div>
        </div>
      </div>
      <div className="mt-4">
        <KV
          rows={[
            ['Size', bytes(it.size), 'tnum'],
            ['Saved to', it.savedPath || '', 'font-mono text-xs leading-5 select-text'],
            ['Address', it.url, 'font-mono text-xs leading-5 select-text'],
          ]}
        />
      </div>
    </WindowShell>
  );
}
