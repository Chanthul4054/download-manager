// Promise-based confirm and prompt dialogs: `await confirm(...)` anywhere, one host renders them.
import * as React from 'react';
import { create } from 'zustand';
import { Dialog, DialogClosing, useExitHold } from '@/components/ui/overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CheckField } from '@/components/ui/controls';

interface ConfirmReq {
  kind: 'confirm';
  title: string;
  message?: React.ReactNode;
  okLabel: string;
  danger: boolean;
  check?: string;
  resolve: (r: { ok: true; checked: boolean } | null) => void;
}
interface PromptReq {
  kind: 'prompt';
  title: string;
  label: string;
  value: string;
  okLabel: string;
  resolve: (r: string | null) => void;
}

const useReq = create<{ req: ConfirmReq | PromptReq | null }>(() => ({ req: null }));

export function confirm(title: string, opts: { message?: React.ReactNode; okLabel?: string; danger?: boolean; check?: string } = {}) {
  return new Promise<{ ok: true; checked: boolean } | null>((resolve) =>
    useReq.setState({ req: { kind: 'confirm', title, message: opts.message, okLabel: opts.okLabel || 'OK', danger: !!opts.danger, check: opts.check, resolve } }),
  );
}

export function prompt(title: string, label: string, value = '', okLabel = 'Save') {
  return new Promise<string | null>((resolve) => useReq.setState({ req: { kind: 'prompt', title, label, value, okLabel, resolve } }));
}

export function ConfirmHost() {
  const live = useReq((s) => s.req);
  const [req, closing] = useExitHold(live);
  const [checked, setChecked] = React.useState(false);
  const [value, setValue] = React.useState('');
  React.useEffect(() => {
    if (!live) return; // keep the closing dialog's state while it animates out
    setChecked(false);
    if (live.kind === 'prompt') setValue(live.value);
  }, [live]);
  if (!req) return null;
  const done = (ok: boolean) => {
    if (closing) return;
    useReq.setState({ req: null });
    if (req.kind === 'confirm') req.resolve(ok ? { ok: true, checked } : null);
    else req.resolve(ok ? value : null);
  };
  return (
    <DialogClosing.Provider value={closing}>
      <Dialog
        open
        onOpenChange={(o) => !o && done(false)}
        title={req.title}
        size="sm"
        onSubmit={() => done(true)}
        footer={
          <>
            <Button onClick={() => done(false)}>Cancel</Button>
            <Button variant={req.kind === 'confirm' && req.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus={req.kind === 'confirm'}>
              {req.okLabel}
            </Button>
          </>
        }
      >
        {req.kind === 'confirm' ? (
          <div className="flex flex-col gap-3 text-sm text-fg-2">
            {req.message && <div>{req.message}</div>}
            {req.check && <CheckField label={req.check} checked={checked} onChange={setChecked} />}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-fg-2">{req.label}</label>
            <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
          </div>
        )}
      </Dialog>
    </DialogClosing.Provider>
  );
}
