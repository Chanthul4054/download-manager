import { useEffect } from 'react';
import { runMenu } from '@/services/ipc';
import { runCommand } from '@/app/commands';
import { useUi } from '@/stores/ui';

/** The old menu bar's accelerators, for the whole main window. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Radix dialogs trap focus; shortcuts stay quiet while one is open.
      if (document.querySelector('[role=dialog]')) return;
      const typing = (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]');
      const run = (fn: () => unknown) => {
        e.preventDefault();
        fn();
      };
      if (mod && !e.shiftKey && k === 'n') return run(() => runCommand('addUrl'));
      if (mod && !e.shiftKey && k === 'b') return run(() => runCommand('batch'));
      if (mod && k === 'l') return run(() => runCommand('linkgrabber'));
      if (mod && k === 'g') return run(() => runCommand('grabber'));
      if (mod && k === 'q') return run(() => runMenu('quit'));
      if (mod && k === ',') return run(() => runCommand('options'));
      if (mod && !e.shiftKey && k === 'f') return run(() => runCommand('find'));
      if (e.key === 'F3') return run(() => runCommand('findNext'));
      if (e.key === 'F1') return run(() => runCommand('help'));
      if (mod && (k === '=' || k === '+')) return run(() => runMenu('font:larger'));
      if (mod && k === '-') return run(() => runMenu('font:smaller'));
      if (mod && k === '0') return run(() => runMenu('font:reset'));
      if (mod && e.shiftKey && k === 'i') return run(() => runMenu('devtools'));
      if (mod && !typing && /^[1-8]$/.test(e.key)) {
        const pages = ['downloads', 'video', 'torrents', 'history', 'linkgrabber', 'grabber', 'queues', 'settings'] as const;
        return run(() => useUi.setState({ page: pages[Number(e.key) - 1] }));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
