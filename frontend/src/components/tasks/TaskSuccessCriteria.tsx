import { useEffect, useState } from 'react';
import type { Task } from '../../types/task';
import { authenticatedFetch } from '../../utils/auth';
import { Button } from '../Button';
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/** The server's hint controls presentation; the writer rechecks authority. */
export function TaskSuccessCriteria({ task, onSaved }: { task: Task; onSaved: () => Promise<void> }) {
  const values = Array.isArray(task.successCriteria) ? task.successCriteria : task.successCriteria ? [task.successCriteria] : [];
  const allowed = task.successCriteriaAccess?.allowed === true;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setEditing(false); setError(''); }, [task.id, allowed]);
  const save = async () => {
    if (saving || !allowed) return;
    setSaving(true); setError('');
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(task.id)}/success-criteria`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ successCriteria: draft.split('\n').map(value => value.trim()).filter(Boolean) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Success criteria could not be saved.');
      await onSaved(); setEditing(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Success criteria could not be saved.'); }
    finally { setSaving(false); }
  };
  return <div>
    {values.length ? <ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>No Verifier success criteria are stored.</p>}
    {allowed && !editing && <Button variant="secondary" size="compact" type="button" onClick={() => { setDraft(values.join('\n')); setEditing(true); }}>Edit success criteria</Button>}
    {allowed && editing && <div>
      <label htmlFor="task-success-criteria">Success criteria (one check per line)</label>
      <textarea id="task-success-criteria" value={draft} disabled={saving} onChange={event => setDraft(event.target.value)} />
      <Button variant="secondary" size="compact" type="button" disabled={saving} onClick={() => void save()}>Save success criteria</Button>
      <Button variant="secondary" size="compact" type="button" disabled={saving} onClick={() => setEditing(false)}>Cancel success criteria</Button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
