import * as React from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { invoke } from '@/services/ipc';
import { extractUrls } from '@/utils/format';
import { cn } from '@/utils/cn';

/** The floating drop target: drop links on it to download them; double-click opens OpenDM. */
export default function DropWindow() {
  const [over, setOver] = React.useState(false);
  return (
    <div
      title="Drop links here to download them with OpenDM. Double-click to open OpenDM."
      className={cn('grid h-screen w-screen place-items-center rounded-2xl text-white transition-colors [-webkit-app-region:drag]', over ? 'bg-accent outline-3 -outline-offset-6 outline-white outline-dashed' : 'bg-accent/90')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
        const urls = extractUrls(text, false);
        if (urls.length === 1) void invoke('win:open', 'newdl', {}, { key: 'newdl:' + Date.now(), payload: { url: urls[0], source: 'drop' }, width: 640, height: 480, title: 'Download File Info', alwaysOnTop: true });
        else if (urls.length > 1) void invoke('win:open', 'links', {}, { payload: { links: urls.map((url) => ({ url })), title: 'Download dropped links' } });
      }}
      onDoubleClick={() => invoke('win:showMain')}
      onContextMenu={(e) => {
        e.preventDefault();
        void invoke('win:showMain');
      }}
    >
      <ArrowDownToLine className="size-8" strokeWidth={2.2} />
    </div>
  );
}
