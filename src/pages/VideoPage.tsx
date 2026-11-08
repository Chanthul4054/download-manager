import * as React from 'react';
import { Film, Plus, SearchX } from 'lucide-react';
import { toast } from 'sonner';
import { invoke } from '@/services/ipc';
import { openDialog } from '@/stores/ui';
import { openSettings } from '@/app/commands';
import { DownloadsView } from '@/components/downloads/DownloadsView';
import { ToolButton } from '@/components/layout/PageHeader';
import { EmptyState, Spinner } from '@/components/ui/display';
import { Button } from '@/components/ui/button';
import { isVideo } from '@/utils/files';
import type { ListColumn } from '@/components/downloads/columns';

const COLS: ListColumn[] = ['name', 'size', 'status', 'rate', 'timeLeft', 'added', 'parentPage'];

/** Video pages (yt-dlp), HLS streams, merged video+audio and plain video files. */
export function VideoPage() {
  return (
    <DownloadsView
      title="Video"
      icon={Film}
      filter={isVideo}
      columns={COLS}
      banner={<ToolsBanner />}
      actions={<ToolButton icon={Plus} label="Add video" tip="Paste a video page address, such as a YouTube link" onClick={() => openDialog({ type: 'addUrl' })} />}
      empty={(filtered) =>
        filtered ? (
          <EmptyState icon={SearchX} title="Nothing matches" />
        ) : (
          <EmptyState icon={Film} title="No videos yet" action={<Button variant="primary" onClick={() => openDialog({ type: 'addUrl' })}>Add a video page</Button>}>
            Paste a video page address, or use “Download this video” on a web player with the browser extension. Video and audio streams are merged with FFmpeg.
          </EmptyState>
        )
      }
    />
  );
}

/** yt-dlp and FFmpeg status, only when one of them is missing. */
function ToolsBanner() {
  const [tools, setTools] = React.useState<{ ytdlp: string | null; ffmpeg: string | null } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(() => {
    void Promise.all([invoke('util:ytdlp'), invoke('util:ffmpeg')]).then(([ytdlp, ffmpeg]) => setTools({ ytdlp, ffmpeg }));
  }, []);
  React.useEffect(load, [load]);
  if (!tools || (tools.ytdlp && tools.ffmpeg)) return null;
  const install = async () => {
    setBusy(true);
    try {
      await invoke('util:ytdlpInstall');
      toast('yt-dlp installed');
    } catch (e) {
      toast.error('Could not download yt-dlp: ' + (e as Error).message);
    }
    setBusy(false);
    load();
  };
  return (
    <div className="flex items-center gap-3 border-b border-line bg-subtle/60 px-4 py-2 text-sm">
      <span className="size-1.5 shrink-0 rounded-full bg-warn" />
      <span className="flex-1 text-fg-2">
        {!tools.ytdlp && 'yt-dlp is not installed, so video pages such as YouTube cannot be downloaded yet. '}
        {!tools.ffmpeg && 'FFmpeg was not found, so separate video and audio streams are saved as two files.'}
      </span>
      {!tools.ytdlp && (
        <Button size="sm" variant="primary" onClick={install} disabled={busy}>
          {busy && <Spinner />}
          {busy ? 'Downloading…' : 'Install yt-dlp'}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => openSettings('video')}>
        Video settings
      </Button>
    </div>
  );
}
