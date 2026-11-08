import * as React from 'react';
import { FileUp, Link2 } from 'lucide-react';
import { invoke } from '@/services/ipc';
import { Dialog } from '@/components/ui/overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CheckField } from '@/components/ui/controls';
import { Field } from '@/components/ui/display';
import { fileUrl, URL_RE } from '@/utils/format';

/** Step one of a manual download: the address. "Download File Info" (its own window) does the rest. */
export function AddUrlDialog({ url: prefill, onOpenChange }: { url?: string; onOpenChange: (o: boolean) => void }) {
  const [url, setUrl] = React.useState(prefill || '');
  const [useAuth, setUseAuth] = React.useState(false);
  const [user, setUser] = React.useState('');
  const [pass, setPass] = React.useState('');
  const [error, setError] = React.useState('');
  const ref = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (prefill) return;
    void invoke('clip:urls').then((clip) => clip.length === 1 && setUrl((u) => u || clip[0]));
  }, [prefill]);

  const submit = () => {
    const v = url.trim();
    if (!URL_RE.test(v)) {
      setError('Enter a full address that starts with http://, https://, ftp:// or magnet:, or open a .torrent file.');
      ref.current?.focus();
      return;
    }
    const payload: Record<string, unknown> = { url: v, source: 'manual' };
    if (useAuth && user) payload.auth = { user, pass };
    void invoke('win:open', 'newdl', {}, { key: 'newdl:' + Date.now(), payload, width: 640, height: 480, title: 'Download File Info', alwaysOnTop: true });
    onOpenChange(false);
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="New download"
      description="Paste a web, FTP or magnet address. Video pages such as YouTube work too."
      onSubmit={submit}
      footerStart={
        <Button
          variant="ghost"
          onClick={async () => {
            const f = await invoke('dialog:file', '', 'torrent');
            if (f) setUrl(fileUrl(f));
          }}
        >
          <FileUp />
          Open .torrent file
        </Button>
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            Continue
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="relative">
          <Link2 className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" />
          <Input
            ref={ref}
            autoFocus
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError('');
            }}
            onFocus={(e) => e.target.select()}
            placeholder="https://example.com/file.zip"
            aria-invalid={!!error}
            className="h-9 pl-8 text-base"
          />
        </div>
        {error && (
          <div role="alert" className="-mt-2 text-xs text-danger">
            {error}
          </div>
        )}
        <CheckField label="The server needs a login" checked={useAuth} onChange={setUseAuth} />
        {useAuth && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="User name">
              <Input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Password">
              <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}
