import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { FilePlus2, Loader2, X } from 'lucide-react';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { Select } from '../ui/Select';
import { authenticatedFetch } from '../../utils/auth';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useMyPrincipal, usePrincipals } from '../../hooks/usePrincipals';
import { changeExpiryFromDate } from './ChangeRequestDetail';
import '../../pages/AccessManagerPage.css';
import './ApprovalDrawer.css';
import './ChangeRequests.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MIN = 20;
const REASON_MAX = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Where "Request a change" was opened (design section 9.4): a Project, or the Knowledge page. */
export type RequestChangeTarget =
  | { kind: 'project'; projectId: string; projectName: string }
  | { kind: 'knowledge'; sources: Array<{ id: string; name: string }>; serviceId?: string };

/** One requestable entry of the preview (`GET /approvals/requests/preview`, design section 4.3). */
interface Requestable {
  targetType: string;
  grantees: 'self' | 'any' | 'none';
  fields: string[];
  bound: { verbs?: string[]; operations?: string[] };
  deciders: Array<{ standing: string; rule: string }>;
}

interface Preview { requestable: Requestable[]; refused: Array<{ targetType: string; code: string; hint?: string }> }

type PreviewState = { status: 'idle' | 'loading' } | { status: 'ready'; preview: Preview } | { status: 'failed'; message: string };

/** The knowledge compartment the preview admits on one ticked Project, or why not (design sections 4.3 and 9.4). */
type CompartmentAnswer =
  | { status: 'loading' }
  | { status: 'requestable'; entry: Requestable }
  | { status: 'refused'; code: string; hint?: string }
  | { status: 'failed'; message: string };

function compartmentAnswerOf(preview: Preview): CompartmentAnswer {
  const entry = preview.requestable.find((candidate) => candidate.targetType === 'knowledge.compartment');
  if (entry) return { status: 'requestable', entry };
  const refused = preview.refused.find((candidate) => candidate.targetType === 'knowledge.compartment');
  return refused ? { status: 'refused', code: refused.code, hint: refused.hint } : { status: 'refused', code: 'TARGET_NOT_REQUESTABLE' };
}

type Result = { status: 'idle' | 'sending' } | { status: 'filed'; id: string; rule: string | null } | { status: 'refused'; code: string; message: string };

async function readAnswer(response: Response): Promise<any> {
  return response.json().catch(() => null);
}

/** The refusal the server named, in words: its code and its own message. */
function refusalWords(body: any, status: number): { code: string; message: string } {
  const code = typeof body?.code === 'string' ? body.code : `HTTP_${status}`;
  const message = typeof body?.message === 'string' ? body.message : 'The board refused the request.';
  return { code, message };
}

async function fetchPreview(query: Record<string, string>, signal: AbortSignal): Promise<Preview> {
  const response = await authenticatedFetch(`${API_BASE}/approvals/requests/preview?${new URLSearchParams(query).toString()}`, { signal });
  const body = await readAnswer(response);
  if (!response.ok || !body || !Array.isArray(body.requestable)) {
    const refusal = refusalWords(body, response.status);
    throw new Error(`${refusal.code}: ${refusal.message}`);
  }
  return { requestable: body.requestable as Requestable[], refused: Array.isArray(body.refused) ? body.refused : [] };
}

/**
 * THE "REQUEST A CHANGE" DIALOG (change-request design section 9.4; card
 * 502fb19e, slice S3). One form, target-aware: on a Project it reads what may
 * be requested there (`GET /approvals/requests/preview`: the verbs the preview
 * bounds, and whom the request may be for), on the Knowledge page it asks for
 * a knowledge compartment on chosen Projects, each previewed before filing so
 * a refusal is named first (or, with no knowledge source to
 * read yet, the read grant on a knowledge Service by its id). It files on
 * `POST /approvals/requests` as the signed-in Account and changes nothing
 * itself: a person who may decide it does so on the approvals hub. Disabled
 * principals are hidden from the grantee picker (E312).
 */
export function RequestChangeDialog({ target, onClose }: { target: RequestChangeTarget; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  const idBase = useId();
  const headingId = `${idBase}-heading`;
  const { me } = useMyPrincipal();
  const { principals } = usePrincipals();
  const [choice, setChoice] = useState<'grant' | 'knowledge'>(target.kind === 'knowledge' ? 'knowledge' : 'grant');
  const [sources, setSources] = useState<Array<{ id: string; name: string }>>(target.kind === 'knowledge' ? target.sources : []);
  const [sourceId, setSourceId] = useState<string>(target.kind === 'knowledge' ? target.sources[0]?.id ?? '' : '');
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [verbs, setVerbs] = useState<string[]>([]);
  const [operation, setOperation] = useState('read');
  const [grantee, setGrantee] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  // Card 08792425: the Services page opens the dialog on the Service it just registered.
  const [serviceId, setServiceId] = useState(target.kind === 'knowledge' ? target.serviceId ?? '' : '');
  const [expiryDate, setExpiryDate] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<Result>({ status: 'idle' });
  const [compartment, setCompartment] = useState<Record<string, CompartmentAnswer>>({});
  const asked = useRef(new Set<string>());
  const unmounted = useRef(new AbortController());
  const noSources = target.kind === 'knowledge' && target.sources.length === 0;

  useEffect(() => {
    const controller = new AbortController();
    unmounted.current = controller;
    return () => controller.abort();
  }, []);

  // The knowledge sources this session reads, for a Project's compartment.
  useEffect(() => {
    if (target.kind !== 'project') return undefined;
    let live = true;
    authenticatedFetch(`${API_BASE}/knowledge-sources`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!live || !body || !Array.isArray(body.sources)) return;
        const read = (body.sources as Array<{ id: string; name: string }>).map((source) => ({ id: source.id, name: source.name }));
        setSources(read);
        setSourceId((current) => current || read[0]?.id || '');
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [target]);

  // The Projects this session reads, for a compartment filed from the Knowledge page.
  useEffect(() => {
    if (target.kind !== 'knowledge' || noSources) return undefined;
    let live = true;
    authenticatedFetch(`${API_BASE}/projects`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!live || !body || !Array.isArray(body.projects)) return;
        setProjects((body.projects as Array<{ id: string; name: string }>).map((project) => ({ id: project.id, name: project.name })));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [target, noSources]);

  // What may be requested on this Project: the preview, for grant rows, and for the compartment of the chosen source.
  useEffect(() => {
    if (target.kind !== 'project') return undefined;
    if (choice === 'knowledge' && !sourceId) { setPreview({ status: 'idle' }); return undefined; }
    const controller = new AbortController();
    setPreview({ status: 'loading' });
    const query: Record<string, string> = { objectType: 'project', targetId: target.projectId };
    if (choice === 'knowledge') query.sourceId = sourceId;
    fetchPreview(query, controller.signal)
      .then((answer) => setPreview({ status: 'ready', preview: answer }))
      .catch((caught) => { if (!controller.signal.aborted) setPreview({ status: 'failed', message: caught instanceof Error ? caught.message : 'The preview failed.' }); });
    return () => controller.abort();
  }, [target, choice, sourceId]);

  // From the Knowledge page: the form is the preview's too (section 9.4). Each
  // ticked Project is previewed for the chosen source once, and the request
  // is filed only when every ticked Project is requestable; a refusal is shown
  // by its code before anything is filed.
  useEffect(() => {
    if (target.kind !== 'knowledge' || noSources || !sourceId) return;
    for (const projectId of projectIds) {
      const key = `${sourceId}:${projectId}`;
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      const signal = unmounted.current.signal;
      setCompartment((current) => ({ ...current, [key]: { status: 'loading' } }));
      fetchPreview({ objectType: 'project', targetId: projectId, sourceId }, signal)
        .then((answer) => { if (!signal.aborted) setCompartment((current) => ({ ...current, [key]: compartmentAnswerOf(answer) })); })
        .catch((caught) => {
          if (signal.aborted) return;
          setCompartment((current) => ({ ...current, [key]: { status: 'failed', message: caught instanceof Error ? caught.message : 'The preview failed.' } }));
        });
    }
  }, [target, noSources, sourceId, projectIds]);

  const tickedAnswers = target.kind === 'knowledge' && !noSources
    ? projectIds.map((projectId) => ({
      projectId,
      name: projects.find((project) => project.id === projectId)?.name ?? projectId,
      answer: compartment[`${sourceId}:${projectId}`] ?? ({ status: 'loading' } as CompartmentAnswer),
    }))
    : [];
  const knowledgeEntry = tickedAnswers.find((ticked) => ticked.answer.status === 'requestable');
  const everyTickedRequestable = tickedAnswers.length > 0 && tickedAnswers.every((ticked) => ticked.answer.status === 'requestable');

  const wantedType = choice === 'grant' ? 'grant.rows' : 'knowledge.compartment';
  const entry = preview.status === 'ready' ? preview.preview.requestable.find((candidate) => candidate.targetType === wantedType) ?? null : null;
  const refused = preview.status === 'ready' && !entry ? preview.preview.refused.find((candidate) => candidate.targetType === wantedType) ?? null : null;
  const boundVerbs = entry?.bound.verbs ?? [];
  const boundOperations = entry?.bound.operations ?? ['read'];
  const mayNameOthers = target.kind === 'project' && entry?.grantees === 'any';
  const others = useMemo(() => principals
    .filter((principal) => principal.kind === 'human' && principal.status === 'active' && principal.id !== me?.id)
    .sort((a, b) => a.handle.localeCompare(b.handle)), [principals, me?.id]);

  useEffect(() => { setVerbs((current) => current.filter((verb) => boundVerbs.includes(verb))); }, [boundVerbs.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const reasonLength = [...reason.trim()].length;
  const reasonOk = reasonLength >= REASON_MIN && reasonLength <= REASON_MAX;
  const expiresAt = expiryDate ? changeExpiryFromDate(expiryDate, new Date(Date.now() + 90 * DAY_MS).toISOString()) : null;
  const expiryOk = !expiryDate || expiresAt !== null;

  let body: Record<string, unknown> | null = null;
  if (target.kind === 'project' && choice === 'grant' && entry && verbs.length > 0) {
    body = { targetType: 'grant.rows', change: { rules: [{ resourceType: 'project', selectorForm: 'exact', selectorIds: [target.projectId], verbs }] } };
  } else if (target.kind === 'project' && choice === 'knowledge' && entry && sourceId) {
    body = { targetType: 'knowledge.compartment', change: { sourceId, operation, projectIds: [target.projectId] } };
  } else if (target.kind === 'knowledge' && !noSources && sourceId && everyTickedRequestable) {
    body = { targetType: 'knowledge.compartment', change: { sourceId, operation: 'read', projectIds } };
  } else if (noSources && UUID.test(serviceId.trim())) {
    body = { targetType: 'grant.rows', change: { rules: [{ resourceType: 'service', selectorForm: 'exact', selectorIds: [serviceId.trim()], verbs: ['read'] }] } };
  }
  if (body && expiresAt) body.change = { ...(body.change as Record<string, unknown>), expiresAt };
  if (body && mayNameOthers && grantee) body.granteePrincipalId = grantee;
  const ready = body !== null && reasonOk && expiryOk && result.status !== 'sending';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || !body) return;
    setResult({ status: 'sending' });
    try {
      const response = await authenticatedFetch(`${API_BASE}/approvals/requests`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, reason: reason.trim() }),
      });
      const answer = await readAnswer(response);
      if (response.status === 202 && answer?.approval?.id) {
        const decidedBy = entry ?? (knowledgeEntry?.answer.status === 'requestable' ? knowledgeEntry.answer.entry : null);
        setResult({ status: 'filed', id: String(answer.approval.id), rule: decidedBy?.deciders[0]?.rule ?? null });
      } else {
        setResult({ status: 'refused', ...refusalWords(answer, response.status) });
      }
    } catch {
      setResult({ status: 'refused', code: 'NETWORK', message: 'The request could not be sent. Try again.' });
    }
  };

  return createPortal(
    <div className="change-request-scrim" onClick={(event) => { event.stopPropagation(); onClose(); }}>
      <div
        className="change-request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
      >
        <div className="change-request-dialog-head">
          <h2 id={headingId}>Request a change</h2>
          <IconButton icon={<X size={16} aria-hidden="true" />} ariaLabel="Close the change request" onClick={onClose} />
        </div>
        <p className="change-request-muted">
          A request changes nothing by itself. A person who may make the change decides it on the approvals hub,
          after confirming it is them, and may approve less than you ask for.
        </p>
        {result.status === 'filed' ? (
          <div className="change-request-form" role="status">
            <p>Filed. Request {result.id.slice(0, 8)} waits for a decision{result.rule ? `: ${result.rule}` : '.'}</p>
            <p><Link className="approval-drawer-link" to="/action-center?tab=requests">See it under My requests</Link></p>
            <div className="change-request-actions"><Button variant="secondary" size="compact" onClick={onClose}>Close</Button></div>
          </div>
        ) : (
          <form className="change-request-form" onSubmit={submit}>
            {target.kind === 'project' && (
              <div className="form-group">
                <label htmlFor={`${idBase}-what`}>What to request on {target.projectName}</label>
                <Select id={`${idBase}-what`} value={choice} onChange={(event) => setChoice(event.target.value as 'grant' | 'knowledge')}>
                  <option value="grant">Access to this Project (grant rows)</option>
                  {sources.length > 0 && <option value="knowledge">Its knowledge compartment</option>}
                </Select>
              </div>
            )}
            {(choice === 'knowledge' && !noSources) && (
              <div className="form-group">
                <label htmlFor={`${idBase}-source`}>Knowledge source</label>
                <Select id={`${idBase}-source`} value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                  {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
                </Select>
              </div>
            )}
            {target.kind === 'project' && preview.status === 'loading' && (
              <p className="change-request-muted" role="status"><Loader2 className="axm-spin" size={16} aria-hidden="true" /> Checking what you may request here…</p>
            )}
            {target.kind === 'project' && preview.status === 'failed' && <p role="alert">{preview.message}</p>}
            {refused && (
              <p role="alert">
                You cannot request this here ({refused.code}).
                {refused.hint === 'split-by-project' ? ' File one request per Project.' : ''}
              </p>
            )}
            {target.kind === 'project' && choice === 'grant' && entry && (
              <fieldset className="change-request-fieldset">
                <legend>Verbs</legend>
                <div className="axm-chipset">
                  {boundVerbs.map((verb) => (
                    <label key={verb} className={`axm-scope ${verbs.includes(verb) ? '' : 'axm-scope--dropped'}`}>
                      <input type="checkbox" checked={verbs.includes(verb)}
                        onChange={() => setVerbs((current) => (current.includes(verb) ? current.filter((value) => value !== verb) : [...current, verb]))} /> {verb}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {target.kind === 'project' && choice === 'knowledge' && entry && boundOperations.length > 1 && (
              <div className="form-group">
                <label htmlFor={`${idBase}-operation`}>Operation</label>
                <Select id={`${idBase}-operation`} value={operation} onChange={(event) => setOperation(event.target.value)}>
                  {boundOperations.map((value) => <option key={value} value={value}>{value}</option>)}
                </Select>
              </div>
            )}
            {mayNameOthers && (
              <div className="form-group">
                <label htmlFor={`${idBase}-grantee`}>For</label>
                <Select id={`${idBase}-grantee`} value={grantee} onChange={(event) => setGrantee(event.target.value)}>
                  <option value="">My own Account</option>
                  {others.map((principal) => <option key={principal.id} value={principal.id}>{principal.displayName || principal.handle}</option>)}
                </Select>
              </div>
            )}
            {target.kind === 'knowledge' && !noSources && (
              <fieldset className="change-request-fieldset">
                <legend>Projects to read</legend>
                {projects.length === 0 ? <p className="change-request-muted">No Projects you can read.</p> : (
                  <div className="axm-chipset">
                    {projects.map((project) => (
                      <label key={project.id} className={`axm-scope ${projectIds.includes(project.id) ? '' : 'axm-scope--dropped'}`}>
                        <input type="checkbox" checked={projectIds.includes(project.id)}
                          onChange={() => setProjectIds((current) => (current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id]))} />
                        {' '}{project.name}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            )}
            {tickedAnswers.some((ticked) => ticked.answer.status === 'loading') && (
              <p className="change-request-muted" role="status"><Loader2 className="axm-spin" size={16} aria-hidden="true" /> Checking what you may request on the Projects you ticked…</p>
            )}
            {tickedAnswers.some((ticked) => ticked.answer.status === 'refused' || ticked.answer.status === 'failed') && (
              <div role="alert">
                <p>You cannot request this on every Project you ticked. Untick these to file the rest:</p>
                <ul>
                  {tickedAnswers.map(({ projectId, name, answer }) => (answer.status === 'refused'
                    ? <li key={projectId}>{name}: refused ({answer.code}){answer.hint === 'split-by-project' ? '; file one request per Project' : ''}</li>
                    : answer.status === 'failed' ? <li key={projectId}>{name}: the preview failed ({answer.message})</li> : null))}
                </ul>
              </div>
            )}
            {noSources && (
              <div className="form-group">
                <label htmlFor={`${idBase}-service`}>Knowledge Service id <span className="change-request-muted">the read grant opens its sources to you</span></label>
                <input id={`${idBase}-service`} className="form-input" type="text" value={serviceId} onChange={(event) => setServiceId(event.target.value)} />
              </div>
            )}
            <div className="form-group">
              <label htmlFor={`${idBase}-expiry`}>Until (UTC) <span className="change-request-muted">optional; default 14 days, at most 90</span></label>
              <input id={`${idBase}-expiry`} className="form-input" type="date" value={expiryDate}
                max={new Date(Date.now() + 90 * DAY_MS).toISOString().slice(0, 10)} onChange={(event) => setExpiryDate(event.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor={`${idBase}-reason`}>Reason <span className="change-request-muted">{REASON_MIN} to {REASON_MAX} characters; the decider reads it</span></label>
              <textarea id={`${idBase}-reason`} className="form-input" value={reason} maxLength={REASON_MAX} onChange={(event) => setReason(event.target.value)} />
            </div>
            {result.status === 'refused' && <p role="alert">Refused ({result.code}): {result.message}</p>}
            <div className="change-request-actions">
              <Button variant="secondary" size="compact" onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" size="compact" icon={<FilePlus2 size={16} />} disabled={!ready}>
                {result.status === 'sending' ? 'Filing…' : 'File the request'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The "Request a change" entry (design section 9.4): a button that opens the dialog. */
export function RequestChangeButton({ target, intro }: { target: RequestChangeTarget; intro?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="change-request-entry">
      {intro && <span className="change-request-muted">{intro}</span>}
      <Button variant="secondary" size="compact" icon={<FilePlus2 size={16} />} ariaHaspopup="dialog" onClick={() => setOpen(true)}>
        Request a change
      </Button>
      {open && <RequestChangeDialog target={target} onClose={() => setOpen(false)} />}
    </div>
  );
}
