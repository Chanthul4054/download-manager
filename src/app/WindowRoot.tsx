// Shared by every window: loads the backend state once, keeps the theme in sync, provides tooltips
// and toasts, and shows a readable error instead of a blank window if something throws.
import * as React from 'react';
import { Toaster } from 'sonner';
import { connectStore, loadState, useApp } from '@/stores/app';
import { useAppearance } from '@/hooks/useAppearance';
import { TooltipProvider } from '@/components/ui/overlay';
import { ConfirmHost } from '@/components/dialogs/confirm';

class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <div className="text-base font-semibold">Something went wrong</div>
        <pre className="max-w-full overflow-auto rounded-md bg-subtle p-3 text-left font-mono text-xs whitespace-pre-wrap text-fg-2 select-text">{this.state.error.message}</pre>
        <button className="text-sm text-accent hover:underline" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

export function WindowRoot({ children }: { children: React.ReactNode }) {
  const ready = useApp((s) => s.ready);
  const appearance = useApp((s) => s.settings?.appearance);
  const [error, setError] = React.useState<string | null>(null);
  useAppearance(appearance);

  React.useEffect(() => {
    const off = connectStore();
    loadState().catch((e: Error) => setError(e.message));
    return off;
  }, []);

  // No browser page behaviour in an app window.
  React.useEffect(() => {
    const block = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('input, textarea, [data-allow-context]')) e.preventDefault();
    };
    const keys = (e: KeyboardEvent) => {
      if ((e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) && !import.meta.env.DEV) e.preventDefault();
      if (e.ctrlKey && (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'u')) e.preventDefault();
    };
    document.addEventListener('contextmenu', block);
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('contextmenu', block);
      document.removeEventListener('keydown', keys);
    };
  }, []);

  if (error) return <div className="p-6 text-sm text-danger">Failed to load: {error}</div>;
  if (!ready) return null;
  return (
    <Boundary>
      <TooltipProvider>
        {children}
        <ConfirmHost />
        <Toaster
          position="bottom-right"
          offset={44}
          toastOptions={{
            className: '!bg-raised !text-fg !border-line !shadow-pop !rounded-lg !text-sm !py-2.5 !px-3.5 !font-sans',
            duration: 2600,
          }}
        />
      </TooltipProvider>
    </Boundary>
  );
}
