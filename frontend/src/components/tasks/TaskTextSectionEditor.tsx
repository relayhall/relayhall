import { useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../Button';
import { EditableFrame, TaskSectionShell } from './taskFieldEditors';

export function TaskTextSectionEditor({ id, heading, value, activeEditor, updatedElsewhere, onBegin, onEnd, onSave, children }: {
  id: string;
  heading: string;
  value: string;
  activeEditor: string | null;
  updatedElsewhere: boolean;
  onBegin: (id: string) => void;
  onEnd: () => void;
  onSave: (value: string) => Promise<void>;
  children: ReactNode;
}) {
  const editing = activeEditor === id;
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const begin = () => { setDraft(value); setError(''); onBegin(id); };
  const save = async () => {
    setSaving(true); setError('');
    try { await onSave(draft); onEnd(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The section update was rejected.'); }
    finally { setSaving(false); }
  };
  // Amendment 2d5e2caa Ruling 1: the dotted frame + corner pencil IS the
  // affordance; the accessible name "Edit <heading>" is unchanged.
  if (!editing) {
    return <TaskSectionShell id={id} heading={heading}>
      <EditableFrame label={heading} onEdit={begin}>{children}</EditableFrame>
    </TaskSectionShell>;
  }
  return <TaskSectionShell id={id} heading={heading}>
    {editing ? <div className="task-detail-section-editor">
      {updatedElsewhere ? <div className="task-detail-external-update" role="status">Updated elsewhere. <Button variant="secondary" size="compact" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={() => setDraft(value)}>Refresh editor</Button></div> : null}
      <label htmlFor={`task-detail-${id}-editor`} className="sr-only">{heading}</label>
      <textarea id={`task-detail-${id}-editor`} value={draft} onChange={event => setDraft(event.target.value)} rows={10} />
      {error ? <p className="task-detail-section-error" role="alert">{error}</p> : null}
      <div className="task-detail-editor-actions"><Button variant="secondary" size="compact" disabled={saving} onClick={() => void save()}>Save</Button><Button variant="secondary" size="compact" disabled={saving} onClick={onEnd}>Cancel</Button></div>
    </div> : children}
  </TaskSectionShell>;
}
