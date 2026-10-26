import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../../utils/auth';
import { Select } from '../ui/Select';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/** One principal the usable-Verifier predicate accepts (GET /projects/{id}/default-verifier/candidates). */
export interface DefaultVerifierCandidate {
  id: string;
  kind: string;
  handle: string;
  displayName?: string | null;
}

export interface DefaultVerifierSaved {
  revision: string;
  defaultVerifierPrincipalId: string | null;
}

interface DefaultVerifierFieldProps {
  /** Which owner-plane route writes the value. */
  target: 'projects' | 'phases';
  /** The Project or Phase id the route addresses. */
  objectId: string;
  /** The Project whose candidates are listed (a Phase's own Project). */
  projectId: string;
  /** The revision the write is bound to (If-Match). */
  revision: string;
  value: string | null | undefined;
  /** Root, an administrator, or the person owner of the Project (design Part 2); read-only otherwise. */
  canEdit: boolean;
  /** The empty option's text: "No default Verifier" or "Inherit from Project (<name>)". */
  emptyLabel: string;
  onSaved: (saved: DefaultVerifierSaved) => void;
  /** 412/409 REVISION_MISMATCH: the object changed since it was loaded. */
  onConflict: () => void;
  onMessage: (message: string) => void;
}

/**
 * Whether this session may change a default (design Part 2): root, an
 * administrator, or the person who owns the Project. A display hint only;
 * the server applies the gate on every write.
 */
export function canSetDefaultVerifier(
  me: { id: string; kind?: string; role?: string | null } | null | undefined,
  scopes: string[] | null | undefined,
  projectOwnerPrincipalId: string | null | undefined,
): boolean {
  if (scopes?.includes('root')) return true;
  if (!me) return false;
  if (['admin', 'operator', 'orchestrator'].includes(String(me.role || '').toLowerCase())) return true;
  return me.kind === 'human' && Boolean(projectOwnerPrincipalId) && me.id === projectOwnerPrincipalId;
}

const labelOf = (candidate: DefaultVerifierCandidate): string =>
  `${candidate.displayName || candidate.handle}${candidate.kind === 'service' ? ' (Connector)' : ''}`;

/**
 * The default Verifier of a Project or a Phase (card 41e24358, design
 * ba22fd01 Part 7). New cards inherit it: explicit, then the landing Phase's
 * default, then the Project's. The options are the principals the server's
 * usable-Verifier predicate accepts - active people and Connectors that can
 * judge cards; never a Group or an Agent. A stored default that no longer
 * passes stays visible, marked, rather than the control pretending there is
 * none. Only root, an administrator or the person owner of the Project can
 * change it, from a login session; the server enforces that and its refusal
 * is shown verbatim. Existing cards are never changed by a new default.
 */
export function DefaultVerifierField({
  target, objectId, projectId, revision, value, canEdit, emptyLabel, onSaved, onConflict, onMessage,
}: DefaultVerifierFieldProps) {
  const [candidates, setCandidates] = useState<DefaultVerifierCandidate[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const stored = value ?? '';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/default-verifier/candidates`);
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (response.ok && Array.isArray(data.candidates)) {
          setCandidates(data.candidates as DefaultVerifierCandidate[]);
          setLoadFailed(false);
        } else {
          setLoadFailed(true);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const save = async (next: string) => {
    if (next === stored) return;
    setSaving(true);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/${target}/${objectId}/default-verifier`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': revision },
        body: JSON.stringify({ principalId: next === '' ? null : next }),
      });
      const data = await response.json().catch(() => ({}));
      const saved = target === 'projects' ? data.project : data.phase;
      if (response.ok && data.success && saved) {
        onSaved({ revision: String(saved.revision), defaultVerifierPrincipalId: saved.defaultVerifierPrincipalId ?? null });
        onMessage(next === '' ? 'Default Verifier cleared' : 'Default Verifier updated');
      } else if (data.code === 'REVISION_MISMATCH') {
        onConflict();
      } else {
        onMessage(data.message || data.error || 'Failed to update the default Verifier');
      }
    } catch {
      onMessage('Failed to update the default Verifier');
    } finally {
      setSaving(false);
    }
  };

  const storedIsCandidate = stored === '' || candidates.some(candidate => candidate.id === stored);
  const fieldId = `default-verifier-${target}-${objectId}`;

  return (
    <div className="overview-fact">
      <label className="overview-fact-label" htmlFor={fieldId}>Default Verifier</label>
      <span className="overview-fact-value">
        <Select
          id={fieldId}
          value={stored}
          disabled={!canEdit || saving}
          title={canEdit
            ? 'New tasks inherit this Verifier; existing tasks are never changed'
            : 'Only the Project owner or an administrator can change the default Verifier'}
          onChange={event => { void save(event.target.value); }}
        >
          <option value="">{emptyLabel}</option>
          {candidates.map(candidate => (
            <option key={candidate.id} value={candidate.id}>{labelOf(candidate)}</option>
          ))}
          {!storedIsCandidate && (
            <option value={stored}>Current default (cannot judge cards now)</option>
          )}
        </Select>
        {loadFailed && <span role="status"> Candidates could not be loaded.</span>}
      </span>
    </div>
  );
}
