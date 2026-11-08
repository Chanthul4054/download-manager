import * as React from 'react';
import { invoke, on } from '@/services/ipc';
import { refreshGrabbers, useApp } from '@/stores/app';
import { openDialog, useUi } from '@/stores/ui';
import { runCommand } from '@/app/commands';
import { useShortcuts } from '@/hooks/useShortcuts';
import { playSound } from '@/utils/sound';
import { extractUrls } from '@/utils/format';
import { Sidebar } from '@/components/layout/Sidebar';
import { StatusBar } from '@/components/layout/StatusBar';
import { DialogHost } from '@/components/dialogs/DialogHost';
import { DownloadsPage } from '@/pages/DownloadsPage';
import { VideoPage } from '@/pages/VideoPage';
import { TorrentsPage } from '@/pages/TorrentsPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { LinkGrabberPage } from '@/pages/LinkGrabberPage';
import { SiteGrabberPage } from '@/pages/SiteGrabberPage';
import { QueuesPage } from '@/pages/QueuesPage';
import { SettingsPage } from '@/pages/SettingsPage';

const PAGES = {
  downloads: DownloadsPage,
  video: VideoPage,
  torrents: TorrentsPage,
  history: HistoryPage,
  linkgrabber: LinkGrabberPage,
  grabber: SiteGrabberPage,
  queues: QueuesPage,
  settings: SettingsPage,
};

export default function MainWindow() {
  const page = useUi((s) => s.page);
  const Page = PAGES[page];
  useShortcuts();

  React.useEffect(() => {
    void refreshGrabbers();
    void invoke('lg:state').then((lg) => useApp.setState({ lgCount: lg.packages.reduce((a, p) => a + p.links.length, 0) }));
    // A page the backend asked for before this window existed (LinkGrabber from the browser, …).
    void invoke('pending', 'nav').then((nav) => {
      if (Array.isArray(nav)) runCommand('nav', nav[0], nav[1]);
    });
    const offs = [on('menu', (cmd, arg, arg2) => runCommand(cmd, arg, arg2)), on('sound', (kind) => playSound(kind, useApp.getState().settings.sounds))];
    const s = useApp.getState().settings;
    if (s.firstRun !== false) {
      void invoke('settings:save', { firstRun: false });
      setTimeout(() => openDialog({ type: 'help', topic: 'extension' }), 400);
    }
    return () => offs.forEach((f) => f());
  }, []);

  // Links dropped anywhere on the window: one opens "Add download", several open the link list.
  const onDragOver = (e: React.DragEvent) => {
    const t = e.dataTransfer.types;
    if ((t.includes('text/uri-list') || t.includes('text/plain')) && !t.includes('application/x-opendm-ids')) e.preventDefault();
  };
  const onDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-opendm-ids')) return;
    const urls = extractUrls(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
    if (!urls.length) return;
    e.preventDefault();
    if (urls.length === 1) openDialog({ type: 'addUrl', url: urls[0] });
    else void invoke('win:open', 'links', {}, { payload: { links: urls.map((url) => ({ url })), title: 'Download dropped links' } });
  };

  return (
    <div className="flex h-full flex-col" onDragOver={onDragOver} onDrop={onDrop}>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <Page />
        </main>
      </div>
      <StatusBar />
      <DialogHost />
    </div>
  );
}
