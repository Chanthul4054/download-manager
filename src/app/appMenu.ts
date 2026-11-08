// The app menu under the OpenDM logo. It replaces the Windows/Linux menu bar; ids go to the same
// backend handler (`app:menu` → on_menu in app.rs).
import { Bug, CircleHelp, Download, FileDown, FileUp, FolderOpen, Globe, Layers, Lightbulb, Link2, LogOut, MousePointerSquareDashed, Pause, Puzzle, Settings, Square, ClipboardPaste } from 'lucide-react';
import { runMenu } from '@/services/ipc';
import { runCommand } from '@/app/commands';
import type { MenuEntry } from '@/components/ui/menu';

const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+';

export function appMenu(): MenuEntry[] {
  return [
    { label: 'New download…', icon: Download, kbd: mod + 'N', onSelect: () => runCommand('addUrl') },
    { label: 'Batch download…', icon: Layers, kbd: mod + 'B', onSelect: () => runCommand('batch') },
    { label: 'Batch from clipboard', icon: ClipboardPaste, onSelect: () => runMenu('batch-clipboard') },
    '-',
    { label: 'LinkGrabber', icon: Link2, kbd: mod + 'L', onSelect: () => runCommand('linkgrabber') },
    { label: 'Site Grabber', icon: Globe, kbd: mod + 'G', onSelect: () => runCommand('grabber') },
    { label: 'Show or hide drop target', icon: MousePointerSquareDashed, onSelect: () => runMenu('drop') },
    '-',
    { label: 'Pause all', icon: Pause, onSelect: () => runMenu('pause-all') },
    { label: 'Stop all and queues', icon: Square, onSelect: () => runMenu('stop-all') },
    '-',
    {
      label: 'Import',
      icon: FileDown,
      sub: [
        { label: 'From OpenDM export file…', onSelect: () => runMenu('import:json') },
        { label: 'From text file…', onSelect: () => runMenu('import:txt') },
      ],
    },
    {
      label: 'Export',
      icon: FileUp,
      sub: [
        { label: 'To OpenDM export file…', onSelect: () => runMenu('export:json') },
        { label: 'To text file…', onSelect: () => runMenu('export:txt') },
      ],
    },
    '-',
    { label: 'Settings', icon: Settings, kbd: mod + ',', onSelect: () => runCommand('options') },
    {
      label: 'Help',
      icon: CircleHelp,
      sub: [
        { label: 'Help contents', kbd: 'F1', onSelect: () => runCommand('help', 'start') },
        { label: 'Browser extension setup', onSelect: () => runCommand('help', 'extension') },
        { label: 'Scheduler and queues', onSelect: () => runCommand('help', 'queues') },
        { label: 'LinkGrabber', onSelect: () => runCommand('help', 'linkgrabber') },
        { label: 'Site grabber', onSelect: () => runCommand('help', 'grabber') },
        '-',
        { label: 'Tip of the day', icon: Lightbulb, onSelect: () => runCommand('tip') },
        { label: 'About OpenDM', onSelect: () => runCommand('about') },
      ],
    },
    { label: 'Open browser extension folder', icon: Puzzle, onSelect: () => runMenu('ext-folder') },
    { label: 'Open data folder', icon: FolderOpen, onSelect: () => runMenu('data-folder') },
    { label: 'Developer tools', icon: Bug, kbd: mod + 'Shift+I', onSelect: () => runMenu('devtools') },
    '-',
    { label: 'Exit OpenDM', icon: LogOut, kbd: mod + 'Q', onSelect: () => runMenu('quit') },
  ];
}
