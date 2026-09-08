import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../../utils/auth';
import { Select } from '../ui/Select';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * The one Phase picker every task surface uses (RH-P2.4).
 *
 * It exists once, deliberately: RH-P2.2's review found a control that behaved
 * differently in the create, edit and detail modals, so the Phase control is a
 * single component all three render rather than three hand-rolled selects.
 *
 * Semantics it enforces on every surface:
 *  - no project selected -> no phase is selectable (a Phase belongs to exactly
 *    one Project, and the server refuses a mismatch);
 *  - the empty option is "No phase (backlog)", which is a legitimate state and
 *    is worded as one, not as a missing value;
 *  - archived Phases are not offered for new membership, but a task already in
 *    one still shows it rather than silently appearing unphased.
 */

export interface PhaseOption {
  id: string;
  name: string;
  status: string;
  position: number;
}

export function usePhaseOptions(projectId: string | null | undefined): PhaseOption[] {
  const [phases, setPhases] = useState<PhaseOption[]>([]);

  useEffect(() => {
    if (!projectId) {
      setPhases([]);
      return;
    }
    let cancelled = false;
    authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/phases`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data?.success && Array.isArray(data.phases)) {
          setPhases(data.phases.map((p: any) => ({
            id: p.id, name: p.name, status: p.status, position: p.position,
          })));
        } else {
          setPhases([]);
        }
      })
      .catch(() => { if (!cancelled) setPhases([]); });
    return () => { cancelled = true; };
  }, [projectId]);

  return phases;
}

interface PhaseSelectProps {
  /** The resolved project UUID, or null when no project is chosen. */
  projectId: string | null | undefined;
  /** Current phase id, or '' for the backlog. */
  value: string;
  onChange: (phaseId: string) => void;
  className?: string;
  id?: string;
  disabled?: boolean;
  /** Phase the task is already in, so an archived membership stays visible. */
  currentPhase?: { id: string; name: string } | null;
}

export function PhaseSelect({
  projectId, value, onChange, className, id, disabled, currentPhase,
}: PhaseSelectProps) {
  const phases = usePhaseOptions(projectId);
  const known = phases.some(p => p.id === value);

  return (
    <Select
      id={id}
      aria-label="Phase"
      className={className}
      value={value}
      disabled={disabled || !projectId}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{projectId ? 'No phase (backlog)' : 'Select a project first'}</option>
      {phases.map(p => (
        <option key={p.id} value={p.id}>
          #{p.position} {p.name}{p.status === 'archived' ? ' (archived)' : ''}
        </option>
      ))}
      {/* A membership that is not in the offered list — archived, or filtered
          out — is still shown so the surface never misrepresents the stored
          value as "backlog". */}
      {!known && value && (
        <option value={value}>{currentPhase?.name ?? 'Current phase'}</option>
      )}
    </Select>
  );
}

/**
 * Read-only display of a Task's Phase. Resolved by id directly rather than by
 * searching a project's list, so it is correct even when the Phase is archived
 * or the project name cannot be resolved. A failed lookup shows the id rather
 * than claiming the task is unphased — absence and unknown are different.
 */
export function PhaseName({ phaseId }: { phaseId: string }) {
  const [phase, setPhase] = useState<PhaseOption | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPhase(null);
    setFailed(false);
    authenticatedFetch(`${API_BASE_URL}/phases/${phaseId}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data?.success && data.phase) {
          setPhase({
            id: data.phase.id, name: data.phase.name,
            status: data.phase.status, position: data.phase.position,
          });
        } else {
          setFailed(true);
        }
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [phaseId]);

  if (phase) {
    return <span>#{phase.position} {phase.name}{phase.status === 'archived' ? ' (archived)' : ''}</span>;
  }
  return <span>{failed ? phaseId.slice(0, 8) : 'Loading…'}</span>;
}
