import { useState } from 'react';
import { authenticatedFetch } from '../../utils/auth';
import { Select } from '../ui/Select';
import { inboxPhaseInForce, usePhaseOptions } from '../tasks/PhaseSelect';
import { Project } from '../../types/project';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface ProjectInboxPhaseFieldProps {
  project: Project;
  /** An archived Project is read-only: the setting shows, it does not edit. */
  disabled?: boolean;
  /** The record PATCH /projects/{id} returned (it carries the new revision). */
  onSaved: (project: Project) => void;
  /** 412 REVISION_MISMATCH: the project changed since it was loaded. */
  onConflict: () => void;
  onMessage: (message: string) => void;
}

/**
 * The Project's inbox phase (card b13e5ac9, Charter v5 §6.1): the Phase a Task
 * created without an explicit phase lands in, with status Ideas. One select on
 * the Project settings: "No inbox phase" or one of the Project's Phases that
 * can be the inbox - not archived and not restricted, the same rule PATCH
 * /projects/{id} enforces. The save is revision-bound like every other
 * Project edit; the server's refusal is shown verbatim.
 *
 * A stored inbox phase that is no longer in force (archived or restricted
 * since it was named) stays visible as the current value, marked suspended,
 * rather than the control pretending the Project has none.
 */
export function ProjectInboxPhaseField({ project, disabled, onSaved, onConflict, onMessage }: ProjectInboxPhaseFieldProps) {
  const phases = usePhaseOptions(project.id);
  const [saving, setSaving] = useState(false);
  const stored = project.inboxPhaseId ?? '';
  const eligible = phases.filter(phase => phase.status !== 'archived' && !phase.restrictedAccess);
  const suspended = stored !== '' && inboxPhaseInForce(phases, stored) === null;

  const save = async (next: string) => {
    if (next === stored) return;
    setSaving(true);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': project.revision },
        body: JSON.stringify({ inboxPhaseId: next === '' ? null : next }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success && data.project) {
        onSaved(data.project as Project);
        onMessage(next === '' ? 'Inbox phase cleared' : 'Inbox phase updated');
      } else if (response.status === 412) {
        onConflict();
      } else {
        onMessage(data.message || data.error || 'Failed to update the inbox phase');
      }
    } catch {
      onMessage('Failed to update the inbox phase');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overview-fact">
      <label className="overview-fact-label" htmlFor={`project-inbox-phase-${project.id}`}>Inbox phase</label>
      <span className="overview-fact-value">
        <Select
          id={`project-inbox-phase-${project.id}`}
          value={stored}
          disabled={disabled || saving}
          title="New tasks created without a phase land here, with status Ideas"
          onChange={event => { void save(event.target.value); }}
        >
          <option value="">No inbox phase</option>
          {eligible.map(phase => (
            <option key={phase.id} value={phase.id}>#{phase.position} {phase.name}</option>
          ))}
          {suspended && (
            <option value={stored}>
              {(phases.find(phase => phase.id === stored)?.name ?? 'Current phase')} (suspended)
            </option>
          )}
        </Select>
      </span>
    </div>
  );
}
