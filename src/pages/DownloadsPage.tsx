import * as React from 'react';
import { Download, Folder, FolderOpen, SearchX } from 'lucide-react';
import { invoke } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { openDialog, useUi } from '@/stores/ui';
import { DownloadsView } from '@/components/downloads/DownloadsView';
import { ToolButton } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/display';
import { Button } from '@/components/ui/button';

export function DownloadsPage() {
  const category = useUi((s) => s.category);
  const cat = useApp((s) => s.categories.find((c) => c.id === category));
  const filter = React.useMemo(() => (category ? (x: { category?: string }) => (x.category || 'general') === category : undefined), [category]);
  return (
    <DownloadsView
      title={cat ? cat.name : 'Downloads'}
      icon={cat ? Folder : Download}
      filter={filter}
      actions={cat && <ToolButton icon={FolderOpen} label="Open folder" tip={cat.folder} onClick={() => invoke('util:openPath', cat.folder)} />}
      empty={(filtered) =>
        filtered ? (
          <EmptyState icon={SearchX} title="Nothing matches">
            Try another status tab or search text.
          </EmptyState>
        ) : (
          <EmptyState
            icon={Download}
            title={cat ? `No ${cat.name.toLowerCase()} downloads` : 'No downloads yet'}
            action={
              <>
                <Button variant="primary" onClick={() => openDialog({ type: 'addUrl' })}>
                  New download
                </Button>
                <Button onClick={() => openDialog({ type: 'help', topic: 'extension' })}>Set up the browser</Button>
              </>
            }
          >
            Paste an address, drop a link here, or click a download link in your browser with the OpenDM extension.
          </EmptyState>
        )
      }
    />
  );
}
