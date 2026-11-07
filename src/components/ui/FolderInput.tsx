import { FolderOpen } from 'lucide-react';
import { invoke } from '@/services/ipc';
import { Input } from './input';
import { Button } from './button';
import { cn } from '@/utils/cn';

/** A path field with a Browse button that opens the native folder (or file) picker. */
export function FolderInput({ value, onChange, placeholder, file, className }: { value: string; onChange: (v: string) => void; placeholder?: string; file?: boolean; className?: string }) {
  return (
    <div className={cn('flex gap-1.5', className)}>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="flex-1 font-mono text-xs" />
      <Button
        onClick={async () => {
          const d = await invoke(file ? 'dialog:file' : 'dialog:folder', value || undefined);
          if (d) onChange(d);
        }}
      >
        <FolderOpen />
        Browse
      </Button>
    </div>
  );
}
