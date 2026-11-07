import * as React from 'react';
import { invoke } from '@/services/ipc';
import { Dialog } from '@/components/ui/overlay';
import { Button } from '@/components/ui/button';
import { Input, NumberInput } from '@/components/ui/input';
import { Select } from '@/components/ui/controls';
import { Field } from '@/components/ui/display';

/** Numbered or lettered addresses from a pattern with a * wildcard. */
export function BatchDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const [pattern, setPattern] = React.useState('');
  const [kind, setKind] = React.useState<'num' | 'let'>('num');
  const [from, setFrom] = React.useState('1');
  const [to, setTo] = React.useState('10');
  const [width, setWidth] = React.useState(0);
  const [user, setUser] = React.useState('');
  const [pass, setPass] = React.useState('');
  const [urls, setUrls] = React.useState<string[]>([]);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!pattern.includes('*')) {
      setUrls([]);
      setError('');
      return;
    }
    let live = true;
    invoke('util:batch', pattern.trim(), from, to, kind === 'num' ? width : 0)
      .then((u) => live && (setUrls(u), setError('')))
      .catch((e: Error) => live && (setUrls([]), setError(e.message)));
    return () => {
      live = false;
    };
  }, [pattern, from, to, width, kind]);

  const submit = () => {
    if (!urls.length) return;
    const auth = user ? { user, pass } : null;
    void invoke('win:open', 'links', {}, { payload: { links: urls.map((url) => ({ url })), auth, title: 'Batch download', noProbe: urls.length > 300 } });
    onOpenChange(false);
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Batch download"
      description="Put a * where the number or letter changes, for example https://site.com/pics/pic*.jpg."
      size="lg"
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!urls.length} onClick={submit}>
            {urls.length ? `Review ${urls.length} addresses` : 'Review addresses'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Address pattern">
          <Input autoFocus value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="https://example.com/photos/img*.jpg" className="font-mono text-xs" />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Replace * with">
            <Select
              value={kind}
              onChange={(v) => {
                setKind(v);
                setFrom(v === 'num' ? '1' : 'a');
                setTo(v === 'num' ? '10' : 'z');
              }}
              options={[['num', 'Numbers'], ['let', 'Letters']]}
              className="w-32"
            />
          </Field>
          <Field label="From">
            <Input value={from} onChange={(e) => setFrom(e.target.value)} className="w-20" />
          </Field>
          <Field label="To">
            <Input value={to} onChange={(e) => setTo(e.target.value)} className="w-20" />
          </Field>
          <Field label="Digits">
            <NumberInput value={width} min={0} max={10} onValue={setWidth} disabled={kind !== 'num'} className="w-20" title="Pad with zeros to this many digits; 0 = no padding" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="User name (optional)">
            <Input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Password">
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        <Field label={urls.length ? `Preview · ${urls.length} addresses` : 'Preview'}>
          <div className="h-40 overflow-y-auto rounded-md border border-line bg-subtle/50 p-2 font-mono text-xs leading-5 text-fg-2 select-text">
            {error ? <div className="text-danger">{error}</div> : !pattern.includes('*') ? <div className="text-fg-3">The addresses appear here.</div> : urls.slice(0, 200).map((u) => <div key={u} className="truncate">{u}</div>)}
            {urls.length > 200 && <div className="text-fg-3">… and {urls.length - 200} more</div>}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}
