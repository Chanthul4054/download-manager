import * as React from 'react';
import { invoke } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { Dialog } from '@/components/ui/overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/display';
import { FolderInput } from '@/components/ui/FolderInput';
import type { Category } from '@/types/models';

export function CategoryDialog({ category, onOpenChange }: { category?: Category; onOpenChange: (o: boolean) => void }) {
  const categories = useApp((s) => s.categories);
  const [c, setC] = React.useState<Category>(category ? { ...category } : { id: '', name: '', exts: '', folder: '' });
  const [error, setError] = React.useState('');

  const save = async () => {
    if (!c.name.trim()) return setError('Give the category a name.');
    const list = categories.map((x) => ({ ...x }));
    // New categories get their id from the backend (cats:save fills a missing one).
    if (category) list[list.findIndex((x) => x.id === category.id)] = c;
    else list.push({ ...c, id: null as unknown as string, builtin: false, folder: c.folder || categories[0].folder });
    await invoke('cats:save', list);
    onOpenChange(false);
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={category ? 'Edit category' : 'New category'}
      description="Downloads whose file type matches go to the category's folder."
      onSubmit={save}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            {category ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input autoFocus value={c.name} onChange={(e) => (setC({ ...c, name: e.target.value }), setError(''))} aria-invalid={!!error} />
        </Field>
        <Field label="File types" hint={c.id === 'general' ? 'General takes every file that matches no other category.' : 'Extensions separated by spaces; * is allowed, e.g. mp4 mkv r0*'}>
          <Input value={c.exts} onChange={(e) => setC({ ...c, exts: e.target.value })} placeholder="mp4 mkv webm" disabled={c.id === 'general'} className="font-mono text-xs" />
        </Field>
        <Field label="Save to">
          <FolderInput value={c.folder} onChange={(v) => setC({ ...c, folder: v })} placeholder={categories[0]?.folder} />
        </Field>
        {error && <div className="text-xs text-danger">{error}</div>}
      </div>
    </Dialog>
  );
}
