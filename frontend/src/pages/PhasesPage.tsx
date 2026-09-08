import { useMyPrincipal } from '../hooks/usePrincipals';
import { BlueprintCapture } from '../components/blueprints/BlueprintCapture';
import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Compass, Plus, Pencil, Archive, ArchiveRestore, Copy, Trash2 } from 'lucide-react';
import { authenticatedFetch } from '../utils/auth';
import './PhasesPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

// Phases are the grouping layer between Project and Task (RH-P2.4). They are
// ordered within their Project and MAY OVERLAP — position orders them, it
// does not make them exclusive. A Phase carries a goal: an outcome statement,
// a property and never an object of its own (vocabulary D-6).
//
// Archive is the routine, reversible way a Phase leaves the board. Hard
// delete is the restricted admin verb (§4.4) — offered, but behind an explicit
// confirmation, and the database refuses it while Tasks still point at the
// Phase. The 409 is surfaced in place: the row is never removed from the list
// on a refusal, so the page can never imply a deletion that did not happen.

export type PhaseStatus = 'todo' | 'in-progress' | 'completed' | 'archived';

export interface Phase {
  id: string;
  projectId: string;
  name: string;
  goal: string | null;
  status: PhaseStatus;
  position: number;
  revision: string;
  createdAt: string;
  updatedAt: string;
}

const SETTABLE_STATUSES: PhaseStatus[] = ['todo', 'in-progress', 'completed'];

const STATUS_LABEL: Record<PhaseStatus, string> = {
  'todo': 'To do',
  'in-progress': 'In progress',
  'completed': 'Completed',
  'archived': 'Archived',
};

interface DraftState {
  name: string;
  goal: string;
  status: PhaseStatus;
  position: string;
}

const EMPTY_DRAFT: DraftState = { name: '', goal: '', status: 'todo', position: '0' };

export function PhasesPage() {
  const { id } = useParams<{ id: string }>();
  const { scopes } = useMyPrincipal();
  const canCapture = scopes?.some(scope => ['root','*','blueprints:write'].includes(scope));
  const [capturePhase, setCapturePhase] = useState<Phase | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);

  const [editing, setEditing] = useState<Phase | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Phase | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const query = includeArchived ? '?includeArchived=true' : '';
    authenticatedFetch(`${API_BASE_URL}/projects/${id}/phases${query}`)
      .then(async res => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
        setPhases(data?.phases ?? []);
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load phases'))
      .finally(() => setLoading(false));
  }, [id, includeArchived]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!id) return;
    authenticatedFetch(`${API_BASE_URL}/projects/${id}`)
      .then(res => res.json())
      .then(data => setProjectName(data?.project?.name ?? ''))
      .catch(() => setProjectName(''));
  }, [id]);

  // Defaults are materialised into the draft when the form OPENS and when the
  // edited phase changes — never shown-but-not-submitted (review 66c78a1d F3).
  const openCreate = () => {
    const nextPosition = phases.length > 0 ? Math.max(...phases.map(p => p.position)) + 1 : 0;
    setDraft({ ...EMPTY_DRAFT, position: String(nextPosition) });
    setSaveError(null);
    setEditing(null);
    setCreating(true);
  };

  const openEdit = (phase: Phase) => {
    setDraft({
      name: phase.name,
      goal: phase.goal ?? '',
      status: phase.status === 'archived' ? 'todo' : phase.status,
      position: String(phase.position),
    });
    setSaveError(null);
    setCreating(false);
    setEditing(phase);
  };

  const closeForm = () => { setCreating(false); setEditing(null); setSaveError(null); };

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setSaveError(null);
    try {
      const positionValue = Number(draft.position);
      if (!Number.isInteger(positionValue) || positionValue < 0) {
        throw new Error('Position must be a whole number of 0 or more.');
      }
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        goal: draft.goal.trim() === '' ? null : draft.goal,
        status: draft.status,
        position: positionValue,
      };
      let res: Response;
      if (editing) {
        res = await authenticatedFetch(`${API_BASE_URL}/phases/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, revision: editing.revision }),
        });
      } else {
        res = await authenticatedFetch(`${API_BASE_URL}/phases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, projectId: id }),
        });
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409 && data?.code === 'REVISION_MISMATCH') {
          throw new Error('The phase changed since it was loaded — close, reload and retry.');
        }
        if (res.status === 403) {
          throw new Error('This credential cannot write phases (phases:write is required).');
        }
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      closeForm();
      load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save the phase');
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async (phase: Phase) => {
    const verb = phase.status === 'archived' ? 'unarchive' : 'archive';
    setError(null);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/phases/${phase.id}/${verb}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: phase.revision }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${verb} the phase`);
    }
  };

  const deletePhase = async (phase: Phase) => {
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/phases/${phase.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409 && data?.code === 'PHASE_IN_USE') {
          // The phase stays in the list: nothing was deleted, and the message
          // says what to do instead.
          throw new Error(data.message || 'This phase still holds tasks. Move or unphase them first, or archive the phase instead.');
        }
        if (res.status === 403) {
          throw new Error('Deleting a phase requires phases:admin; archive it instead.');
        }
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      setConfirmDelete(null);
      setNotice(`Phase "${phase.name}" deleted.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the phase');
    } finally {
      setDeleting(false);
    }
  };

  const copyBrief = async (phase: Phase) => {
    setError(null);
    setNotice(null);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/phases/${phase.id}/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 403) {
          throw new Error('Compiling a phase brief also requires tasks:read on this credential.');
        }
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      await navigator.clipboard.writeText(data?.brief ?? '');
      setNotice('Phase brief copied to the clipboard.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compile the phase brief');
    }
  };

  const formOpen = creating || editing !== null;

  return (
    <div className="phases-page">
      <div className="phases-header">
        <Link to="/projects" className="phases-back"><ArrowLeft size={16} /> Projects</Link>
        <h1><Compass size={20} aria-hidden="true" /> Phases{projectName ? ` — ${projectName}` : ''}</h1>
        <div className="phases-actions">
          <label className="phases-toggle">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={e => setIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
          <button type="button" className="phases-action-btn" onClick={openCreate}>
            <Plus size={16} /> New phase
          </button>
        </div>
      </div>

      <p className="phases-intro">
        A phase groups tasks under one outcome. Phases are ordered within the
        project and may overlap — position orders them, it does not make them
        exclusive. A task's phase is optional: unphased tasks are the project
        backlog.
      </p>

      {error && <div className="phases-error">{error}</div>}
      {notice && <div className="phases-notice">{notice}</div>}

      {formOpen && (
        <div className="phases-form">
          <h3>{editing ? 'Edit phase' : 'New phase'}</h3>
          <div className="form-group">
            <label htmlFor="phase-name">Name</label>
            <input
              id="phase-name"
              className="form-input"
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="phase-goal">Phase goal</label>
            <textarea
              id="phase-goal"
              className="form-textarea"
              value={draft.goal}
              placeholder="The outcome this group of tasks serves"
              onChange={e => setDraft({ ...draft, goal: e.target.value })}
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="phase-status">Status</label>
              <select
                id="phase-status"
                className="form-select"
                value={draft.status}
                onChange={e => setDraft({ ...draft, status: e.target.value as PhaseStatus })}
              >
                {SETTABLE_STATUSES.map(s => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="phase-position">Position</label>
              <input
                id="phase-position"
                className="form-input"
                value={draft.position}
                onChange={e => setDraft({ ...draft, position: e.target.value })}
              />
            </div>
          </div>
          {saveError && <div className="phases-error">{saveError}</div>}
          <div className="form-actions">
            <button type="button" className="phases-action-btn" onClick={closeForm} disabled={saving}>Cancel</button>
            <button type="button" className="phases-action-btn phases-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {loading && <div className="phases-loading">Loading phases…</div>}

      {!loading && phases.length === 0 && !error && (
        <div className="phases-empty">
          <Compass size={48} aria-hidden="true" />
          <h2>This project has no phases yet</h2>
          <p>
            Every task in the project is currently in the backlog. Create a phase
            to group work under one outcome and give a harness a goal it can be
            steered by.
          </p>
        </div>
      )}

      {!loading && phases.length > 0 && (
        <ul className="phases-list">
          {phases.map(phase => (
            <li key={phase.id} className={`phases-row phases-row-${phase.status}`}>
              <div className="phases-row-main">
                <span className="phases-position">#{phase.position}</span>
                <span className="phases-name">{phase.name}</span>
                <span className="phases-status">{STATUS_LABEL[phase.status]}</span>
              </div>
              {phase.goal && <p className="phases-goal">{phase.goal}</p>}
              <div className="phases-row-actions">
                {canCapture && <button type="button" className="phases-action-btn" onClick={() => setCapturePhase(phase)}>Save as Blueprint</button>}
                <button type="button" className="phases-action-btn" onClick={() => openEdit(phase)}>
                  <Pencil size={16} /> Edit
                </button>
                <button type="button" className="phases-action-btn" onClick={() => copyBrief(phase)}>
                  <Copy size={16} /> Copy brief
                </button>
                <button type="button" className="phases-action-btn" onClick={() => toggleArchive(phase)}>
                  {phase.status === 'archived'
                    ? <><ArchiveRestore size={16} /> Unarchive</>
                    : <><Archive size={16} /> Archive</>}
                </button>
                {confirmDelete?.id === phase.id ? (
                  <>
                    <span className="phases-confirm">Delete permanently?</span>
                    <button
                      type="button"
                      className="phases-action-btn phases-danger"
                      onClick={() => deletePhase(phase)}
                      disabled={deleting}
                    >
                      {deleting ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button type="button" className="phases-action-btn" onClick={() => setConfirmDelete(null)} disabled={deleting}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="phases-action-btn"
                    onClick={() => { setError(null); setNotice(null); setConfirmDelete(phase); }}
                    title="Hard delete (phases:admin) — archive is the routine path"
                  >
                    <Trash2 size={16} /> Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    {capturePhase && <BlueprintCapture phaseId={capturePhase.id} projectId={id!} phaseName={capturePhase.name} onClose={() => setCapturePhase(null)} />}
    </div>
  );
}
