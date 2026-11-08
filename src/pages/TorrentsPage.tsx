import { FileUp, Magnet, SearchX } from 'lucide-react';
import { invoke } from '@/services/ipc';
import { openDialog } from '@/stores/ui';
import { openSettings } from '@/app/commands';
import { DownloadsView } from '@/components/downloads/DownloadsView';
import { ToolButton } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/display';
import { Button } from '@/components/ui/button';
import { isTorrent } from '@/utils/files';
import { fileUrl } from '@/utils/format';
import type { ListColumn } from '@/components/downloads/columns';

const COLS: ListColumn[] = ['name', 'size', 'status', 'rate', 'upRate', 'peers', 'uploaded', 'timeLeft', 'saveDir'];

export async function openTorrentFile() {
  const f = await invoke('dialog:file', '', 'torrent');
  if (f) openDialog({ type: 'addUrl', url: fileUrl(f) });
}

/** Magnet links and .torrent files. Peers, upload and ratio come from the running engine. */
export function TorrentsPage() {
  return (
    <DownloadsView
      title="BitTorrent"
      icon={Magnet}
      filter={isTorrent}
      columns={COLS}
      actions={
        <>
          <ToolButton icon={FileUp} label="Open .torrent" tip="Add a .torrent file from disk" onClick={openTorrentFile} />
          <ToolButton icon={Magnet} label="Add magnet" tip="Paste a magnet link" onClick={() => openDialog({ type: 'addUrl' })} />
        </>
      }
      empty={(filtered) =>
        filtered ? (
          <EmptyState icon={SearchX} title="Nothing matches" />
        ) : (
          <EmptyState
            icon={Magnet}
            title="No torrents"
            action={
              <>
                <Button variant="primary" onClick={openTorrentFile}>
                  Open .torrent file
                </Button>
                <Button onClick={() => openSettings('torrent')}>BitTorrent settings</Button>
              </>
            }
          >
            Add a magnet link or a .torrent file. Peers are found with DHT, PEX and local discovery; finished torrents keep seeding until the share ratio in settings.
          </EmptyState>
        )
      }
    />
  );
}
