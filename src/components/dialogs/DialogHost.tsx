import { closeDialog, useUi } from '@/stores/ui';
import { AddUrlDialog } from './AddUrlDialog';
import { BatchDialog } from './BatchDialog';
import { PropertiesDialog } from './PropertiesDialog';
import { CategoryDialog } from './CategoryDialog';
import { ColumnsDialog } from './ColumnsDialog';
import { HelpDialog, TipDialog } from './HelpDialog';

/** Renders the one open main-window dialog. */
export function DialogHost() {
  const d = useUi((s) => s.dialog);
  if (!d) return null;
  const close = (open: boolean) => !open && closeDialog();
  switch (d.type) {
    case 'addUrl': return <AddUrlDialog url={d.url} onOpenChange={close} />;
    case 'batch': return <BatchDialog onOpenChange={close} />;
    case 'properties': return <PropertiesDialog id={d.id} onOpenChange={close} />;
    case 'category': return <CategoryDialog category={d.category} onOpenChange={close} />;
    case 'columns': return <ColumnsDialog onOpenChange={close} />;
    case 'help': return <HelpDialog topic={d.topic} onOpenChange={close} />;
    case 'tip': return <TipDialog onOpenChange={close} />;
    default: return null;
  }
}
