import * as React from 'react';
import { Power } from 'lucide-react';
import { closeWindow, invoke, params } from '@/services/ipc';
import { Button } from '@/components/ui/button';
import { WindowShell } from './shell';

const kind = params.get('kind') || 'shutdown';
const force = params.get('force') === '1';
const VERB: Record<string, string> = { shutdown: 'shut down', restart: 'restart', sleep: 'go to sleep', hibernate: 'hibernate' };

/** Last chance to cancel a shutdown/restart/sleep a queue or download asked for. */
export default function CountdownWindow() {
  const [n, setN] = React.useState(30);
  const done = React.useRef(false);
  const run = React.useCallback(() => {
    if (done.current) return;
    done.current = true;
    void invoke('power:run', kind, force).then(closeWindow);
  }, []);
  React.useEffect(() => {
    const t = setInterval(() => setN((x) => x - 1), 1000);
    return () => clearInterval(t);
  }, []);
  React.useEffect(() => {
    if (n <= 0) run();
  }, [n, run]);
  const cancel = () => {
    done.current = true;
    void invoke('power:cancel').then(closeWindow);
  };
  return (
    <WindowShell
      footer={
        <>
          <Button onClick={run}>Do it now</Button>
          <Button variant="primary" autoFocus onClick={cancel}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-4">
        <div className="grid size-12 shrink-0 place-items-center rounded-full bg-warn-soft text-warn">
          <Power className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="text-base font-semibold">
            The computer will {VERB[kind] || kind} in <span className="tnum">{Math.max(0, n)}</span> seconds
          </div>
          {params.get('reason') && <div className="mt-0.5 text-sm text-fg-2">{params.get('reason')}</div>}
        </div>
      </div>
    </WindowShell>
  );
}
