import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../utils/auth';
import type { Project } from '../../types/project';
import { useStepUpRetry } from '../access/useStepUpRetry';
import { sendWithStepUpRetry } from '../../utils/stepUpChallenge';
import './ProjectOwnerPanel.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface OwnerAccess {
  allowed: boolean;
  reason: string | null;
  owner: { id: string; handle: string; displayName: string | null; status: string } | null;
}
interface Candidate { id: string; handle: string; displayName: string | null }
/** AZ-A12 clause 12: a Group the owner selector offers (root or administrator sessions only). */
interface GroupCandidate { id: string; name: string; featured: boolean }

/** The step-up act a transfer involving a Group binds to (AZ-A12 clause 9(e)). */
export const OWNERSHIP_TRANSFER_ACTION = 'ownership.transfer';
const GROUP_TRANSFER_DESCRIPTION = 'Confirm it is you to transfer this Project\u2019s ownership to, from or between Groups.';

/** A Group principal's handle is `group:<id>` (the prefix is reserved to Groups). */
const isGroupOwner = (owner: OwnerAccess['owner'] | undefined): boolean =>
  Boolean(owner && owner.handle.startsWith('group:'));

const REASON_TEXT: Record<string, string> = {
  REQUIRES_HUMAN_LOGIN: 'Sign in with a human Account to manage Project ownership.',
  SESSION_SCOPE_CEILING: 'This sign-in does not have Project administration scope.',
  CURRENT_ROLE_CEILING: 'Your current Account role cannot administer Projects. An object Grant does not raise that role ceiling.',
  NO_PROJECT_ADMIN: 'You do not currently have Project administration authority.',
  GROUP_OWNER_SESSION_ONLY: 'A transfer involving a Group is a signed-in act; it cannot be made with a connection credential.',
  GROUP_OWNER_REQUIRES_ADMINISTRATOR: 'Only root or an administrator can transfer ownership to, from or between Groups.',
  STEP_UP_REQUIRED: 'The transfer was not confirmed. Confirm it is you and try again.',
};

export function ProjectOwnerPanel({ project, onChanged, onReload, onUnavailable }: {
  project: Project;
  onChanged: (next: Project) => void;
  onReload: () => void;
  onUnavailable: () => void;
}) {
  const [access, setAccess] = useState<OwnerAccess | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [groups, setGroups] = useState<GroupCandidate[]>([]);
  const { askForToken: askForTransferToken, retryDialog: transferDialog } = useStepUpRetry(GROUP_TRANSFER_DESCRIPTION);
  const { askForToken, retryDialog } = useStepUpRetry();
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [candidateError, setCandidateError] = useState(false);
  const [selection, setSelection] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  // Focus and post-refusal refreshes revalidate the same Project revision in
  // the background: they must not blank the panel or discard an unsaved owner
  // selection or open Review unless the verified owner or eligibility changed.
  const accessRef = useRef<OwnerAccess | null>(null);
  const loadedKey = useRef<string | null>(null);
  const selectionRef = useRef(selection);
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  const load = useCallback(async (isCurrent: () => boolean, key: string, background: boolean) => {
    if (!background) setState('loading');
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/owner-access`);
      if (response.status === 404) {
        // Fail closed even if the parent keeps this panel mounted.
        if (isCurrent()) {
          accessRef.current = null;
          loadedKey.current = null;
          setAccess(null); setCandidates([]); setGroups([]); setConfirming(false); setState('unavailable');
          onUnavailable();
        }
        return;
      }
      if (!response.ok) throw new Error('Owner access unavailable');
      const body = await response.json();
      if (body?.success !== true || typeof body?.access?.allowed !== 'boolean') throw new Error('Malformed owner access');
      if (!isCurrent()) return;
      const next: OwnerAccess = body.access;
      let nextCandidates: Candidate[] = [];
      let nextGroups: GroupCandidate[] = [];
      let nextCandidateError = false;
      if (next.allowed && project.status === 'active') {
        const candidateResponse = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/owner-candidates`);
        const candidateBody = await candidateResponse.json().catch(() => null);
        if (!isCurrent()) return;
        if (!candidateResponse.ok || candidateBody?.success !== true || !Array.isArray(candidateBody.candidates)) {
          nextCandidateError = true;
        } else {
          nextCandidates = candidateBody.candidates;
          nextGroups = Array.isArray(candidateBody.groups) ? candidateBody.groups : [];
        }
      }
      const ownerId = next.owner?.id ?? '';
      const draft = selectionRef.current;
      const keepDraft = background
        && accessRef.current?.allowed === true
        && (accessRef.current.owner?.id ?? '') === ownerId
        && next.allowed && !nextCandidateError
        && (draft === '' || draft === ownerId || nextCandidates.some(candidate => candidate.id === draft)
          || nextGroups.some(group => group.id === draft));
      accessRef.current = next;
      loadedKey.current = key;
      setAccess(next);
      setCandidates(nextCandidates);
      setGroups(nextGroups);
      setCandidateError(nextCandidateError);
      if (!keepDraft) {
        setSelection(ownerId);
        setConfirming(false);
      }
      setState('ready');
    } catch {
      if (isCurrent()) {
        accessRef.current = null;
        loadedKey.current = null;
        setAccess(null); setCandidates([]); setGroups([]); setConfirming(false); setState('unavailable');
      }
    }
  }, [project.id, project.status, onUnavailable]);

  useEffect(() => {
    let active = true;
    const key = `${project.id}\n${project.status}\n${project.revision}`;
    void load(() => active, key, loadedKey.current === key);
    return () => { active = false; };
  }, [load, project.id, project.status, project.revision, refresh]);

  useEffect(() => {
    const onFocus = () => setRefresh(value => value + 1);
    if (typeof window === 'undefined') return;
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const save = async () => {
    if (!access?.allowed || candidateError || saving || !confirming || project.status !== 'active') return;
    setSaving(true);
    setMessage(null);
    try {
      // AZ-A12 clause 9(e): a transfer to, from or between Groups carries a
      // single-use step-up bound to (ownership.transfer, this Project).
      const groupInvolved = groups.some(group => group.id === selection) || isGroupOwner(access.owner);
      const send = (stepUpToken?: string) => authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/owner`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': project.revision },
        body: JSON.stringify(stepUpToken === undefined
          ? { ownerPrincipalId: selection || null }
          : { ownerPrincipalId: selection || null, stepUpToken }),
      });
      let response: Response;
      let body: any;
      if (groupInvolved) {
        const binding = { action: OWNERSHIP_TRANSFER_ACTION, targetId: project.id };
        const token = await askForTransferToken(binding);
        if (!token) { setConfirming(false); return; }
        const attempt = await sendWithStepUpRetry(send, token, binding, askForToken);
        response = attempt.response;
        body = attempt.body;
      } else {
        response = await send();
        body = await response.json().catch(() => null);
      }
      if (response.status === 404) { onUnavailable(); return; }
      if (response.status === 412) {
        setMessage('The Project changed. Reload it and review ownership before trying again.');
        setConfirming(false);
        onReload();
        return;
      }
      if (!response.ok || body?.success !== true || !body.project) {
        const code = body?.code;
        setMessage(typeof code === 'string' && REASON_TEXT[code]
          ? REASON_TEXT[code]
          : 'Ownership could not be changed. Review current access and try again.');
        // A refused write must be explicitly reviewed again before another Confirm.
        setConfirming(false);
        setRefresh(value => value + 1);
        return;
      }
      onChanged(body.project);
      setMessage('Project ownership updated. Existing independent Grants remain in force.');
      setConfirming(false);
    } catch {
      setMessage('Ownership could not be changed. Check your connection and reload the Project.');
    } finally {
      setSaving(false);
    }
  };

  const ownerLabel = access?.owner
    ? `${access.owner.displayName || access.owner.handle}${isGroupOwner(access.owner) ? ' (Group)' : ''}${access.owner.status !== 'active' ? ' (inactive)' : ''}`
    : 'Unassigned';
  const ownerOffered = (id: string | undefined) => candidates.some(candidate => candidate.id === id)
    || groups.some(group => group.id === id);
  const changed = (selection || null) !== (access?.owner?.id ?? null);

  return (
    <section className="project-owner-panel" aria-labelledby="project-owner-heading">
      <h4 id="project-owner-heading">Project owner</h4>
      {state === 'loading' ? <p role="status">Loading current ownership and access…</p> : null}
      {state === 'unavailable' ? <p role="alert">Ownership or access could not be verified. Reload to try again.</p> : null}
      {state === 'ready' && access ? <>
        <p>Current owner: <strong>{ownerLabel}</strong></p>
        <p className="project-owner-note">An owner may act on this Project and its Phases within their Account’s role and scope limits. Existing delegated children may inherit bounded access. Task roles and independent Grants are separate.</p>
        {project.status === 'archived' ? <p>Restore this Project before changing its owner.</p> : null}
        {!access.allowed && project.status === 'active' ? <p role="note">{REASON_TEXT[access.reason || ''] || 'Project owner management is unavailable.'} Ask an authorized human Project administrator to transfer or clear ownership.</p> : null}
        {access.allowed && project.status === 'active' ? <>
          {candidateError ? <p role="alert">Eligible Account choices are unavailable. No owner change can be submitted.</p> : <>
            <label htmlFor="project-owner-selection">Assign, transfer or clear owner</label>
            <select id="project-owner-selection" value={selection} onChange={event => { setSelection(event.target.value); setConfirming(false); }}>
              <option value="">Unassigned — clear owner</option>
              {access.owner && !ownerOffered(access.owner.id)
                ? <option value={access.owner.id} disabled>{ownerLabel} — current owner is no longer eligible</option> : null}
              {groups.length > 0 ? <optgroup label="Accounts">
                {candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.displayName || candidate.handle} ({candidate.handle})</option>)}
              </optgroup> : candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.displayName || candidate.handle} ({candidate.handle})</option>)}
              {groups.length > 0 ? <optgroup label="Groups">
                {groups.map(group => <option key={group.id} value={group.id}>{group.name}{group.featured ? ' (featured)' : ''}</option>)}
              </optgroup> : null}
            </select>
            {access.owner && !ownerOffered(access.owner.id)
              ? <p role="note">The current owner is not an eligible new selection; choose another Account or clear ownership.</p> : null}
            {groups.length > 0 ? <p className="project-owner-note">Moving ownership to, from or between Groups asks you to confirm it is you. A Group&apos;s members read and use what it owns; its managers and owners edit it.</p> : null}
            {changed && !confirming ? <button type="button" onClick={() => setConfirming(true)}>Review owner change</button> : null}
            {changed && confirming ? <div className="project-owner-confirm" role="group" aria-label="Confirm owner change">
              <p>{selection ? 'Transfer ownership to the selected Account?' : 'Clear this Project’s owner?'}</p>
              <p>Owner-derived Project and Phase authority changes immediately. Separate Grants and Task roles remain until changed independently.</p>
              <button type="button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Confirm owner change'}</button>
              <button type="button" disabled={saving} onClick={() => setConfirming(false)}>Cancel</button>
            </div> : null}
          </>}
        </> : null}
      </> : null}
      {message ? <p role="status">{message}</p> : null}
      {transferDialog}
      {retryDialog}
    </section>
  );
}
