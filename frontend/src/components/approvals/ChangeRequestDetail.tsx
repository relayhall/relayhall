import { useEffect, useId, useMemo, useState } from 'react';
import { BadgeCheck, XCircle } from 'lucide-react';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import { authenticatedFetch } from '../../utils/auth';
import { formatInstantUtc } from '../../utils/dateFormat';
import type { ProfileRule } from '../access/accessShared';
import type { ApprovalItem, FieldChange, RelationshipEdge } from './approvals';
import './ChangeRequests.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The words a target type is shown with (design section 3). An unknown type reads as itself. */
const TARGET_LABELS: Record<string, string> = {
  'grant.rows': 'Grant rows',
  'grant.edit': 'Edit a grant',
  'grant.revoke': 'Revoke a grant',
  'credential.scopes': 'Credential scopes',
  'credential.issue': 'A new credential for a connector',
  'knowledge.compartment': 'Knowledge compartment',
  'knowledge.shared_writer': 'Shared-area writer',
  // Slice S4 (card 9ce0b0b0): the identity targets.
  'identity.role': 'A role',
  'identity.create': 'A new Account',
  'identity.status': 'An Account enabled or disabled',
  'credential.revoke': 'Revoke a credential',
  'warrant.create': 'A new warrant',
  'warrant.edit': 'Edit a warrant',
  'warrant.revoke': 'Revoke a warrant',
  'warrant.resume': 'Resume a warrant',
  // Slice S5 (card 9ce0b0b0): the object targets.
  'project.owner': "A Project's owner",
  'task.account_owner': "A Task's account owner",
  'report.account_owner': "A Report's account owner",
  'project.default_verifier': "A Project's default Verifier",
  'phase.default_verifier': "A Phase's default Verifier",
  'charter.revision': 'A Charter revision',
  'phase.goal': "A Phase's goal",
  'task.roles': "A Task's Shepherd or Verifier",
  'task.access': "A Task's restricted access",
  'phase.access': "A Phase's restricted access",
  'report.visibility': 'A Report opened to every reader',
};

/**
 * The rank of a role by the scope class it derives (the server's own order,
 * design section 5.4): an identity.role change narrows to a LOWER role only.
 */
const ROLE_RANK: Record<string, number> = {
  admin: 4, orchestrator: 4, operator: 3, editor: 2, user: 2, reviewer: 2, qa: 2, agent: 2, viewer: 1,
};

/** The roles a decider may approve instead of `requested`: the requested one, or a lower one other than `held`. */
export function narrowerRoles(requested: string, held: string | null): string[] {
  const rank = ROLE_RANK[requested] ?? 0;
  return [requested, ...Object.keys(ROLE_RANK).filter((role) => (ROLE_RANK[role] ?? 0) < rank && role !== held)];
}

/** The targets a decider approves or denies as filed (section 5.4): no field narrows. */
const AS_FILED_TARGETS = ['grant.edit', 'grant.revoke', 'identity.create', 'identity.status', 'credential.revoke', 'warrant.revoke', 'warrant.resume',
  // Slice S5: every object target is approved with the value it names, or denied.
  'project.owner', 'task.account_owner', 'report.account_owner', 'project.default_verifier', 'phase.default_verifier',
  'charter.revision', 'phase.goal', 'task.roles', 'task.access', 'phase.access', 'report.visibility'];

export function changeTargetLabel(targetType: string): string {
  return TARGET_LABELS[targetType] ?? targetType;
}

function shownValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.length === 0 ? 'none' : value.join(', ');
  return JSON.stringify(value);
}

const STATE_WORDS: Record<RelationshipEdge['state'], string> = { added: 'added', removed: 'removed', kept: 'kept' };

/**
 * BEFORE AND AFTER (change-request design section 6; card 502fb19e, slice S3):
 * the field diff as a table, and, for a decider, the relationship edges with
 * their one-line summary. A requester's own view carries the field diff only
 * (the server never sends it the relationships). Rendered as real tables with
 * captions, inside one region named "Before and after".
 */
export function BeforeAndAfter({ fields, relationships, labelOf, headingLevel = 4 }: {
  fields: FieldChange[];
  relationships?: { edges: RelationshipEdge[]; summary: string } | null;
  labelOf?: (value: string) => string;
  /** The region's heading level under its host's own heading. */
  headingLevel?: 3 | 4;
}) {
  const headingId = useId();
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  const label = labelOf ?? ((value: string) => value);
  return (
    <section className="change-request-diff" aria-labelledby={headingId}>
      <Heading id={headingId} className="change-request-diff-heading">Before and after</Heading>
      {fields.length === 0 ? (
        <p className="change-request-muted">No field changes.</p>
      ) : (
        <div className="change-request-table-wrap">
          <table className="change-request-table">
            <caption>Fields</caption>
            <thead>
              <tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr>
            </thead>
            <tbody>
              {fields.map(({ field, before, after }) => (
                <tr key={field}><th scope="row">{field}</th><td>{shownValue(before)}</td><td>{shownValue(after)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {relationships && (
        <>
          <p className="change-request-summary">{relationships.summary}</p>
          {relationships.edges.length > 0 && (
            <div className="change-request-table-wrap">
              <table className="change-request-table">
                <caption>Relationships</caption>
                <thead>
                  <tr>
                    <th scope="col">Who</th><th scope="col">On</th><th scope="col">Action</th>
                    <th scope="col">Before</th><th scope="col">After</th><th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {relationships.edges.map((edge, index) => (
                    <tr key={`${edge.principal.id}-${edge.object}-${edge.action}-${edge.via}-${index}`}>
                      <td>{label(edge.principal.id)}</td>
                      <td>{label(edge.object)}</td>
                      <td>{edge.action}</td>
                      <td>{edge.before ? 'yes' : 'no'}</td>
                      <td>{edge.after ? 'yes' : 'no'}</td>
                      <td>{STATE_WORDS[edge.state] ?? edge.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The approved expiry a date input means: the end of that day (UTC), never later than requested. */
export function changeExpiryFromDate(date: string, requested: unknown): string | null {
  if (!date) return null;
  const endOfDay = Date.parse(`${date}T23:59:59.000Z`);
  if (Number.isNaN(endOfDay) || endOfDay <= Date.now()) return null;
  const ceiling = typeof requested === 'string' ? Date.parse(requested) : Number.NaN;
  return new Date(Number.isFinite(ceiling) ? Math.min(endOfDay, ceiling) : endOfDay).toISOString();
}

/** The field diff of a change read from its own spec: before, and before with the approved (else requested) values. */
export function specFieldDiff(spec: { before: Record<string, unknown>; requested: Record<string, unknown>; approved: Record<string, unknown> | null }): FieldChange[] {
  const before = spec.before ?? {};
  const after = { ...before, ...(spec.approved ?? spec.requested ?? {}) };
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify((after as Record<string, unknown>)[field] ?? null))
    .map((field) => ({ field, before: before[field] ?? null, after: (after as Record<string, unknown>)[field] ?? null }));
}

/** What a decider may narrow on each target type (design section 5.4). */
interface Draft {
  rules: Array<ProfileRule | null>;
  /** Per requested rule, the typed id list of an all-of-type row narrowed to exact ids. */
  selectorText?: string[];
  scopes: string[];
  projectIds: string[];
  operation: string;
  transport: string;
  expiryDate: string;
  /** identity.role: the role approved (the requested one, or a lower one). */
  role: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most ids one exact row carries (the grant rule validator's own bound). */
const EXACT_IDS_MAX = 500;

/** The ids a typed list names: full UUIDs separated by commas, semicolons or spaces, each once. */
export function exactIdsOf(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter(Boolean))];
}

function draftOf(requested: Record<string, any>): Draft {
  const rules = Array.isArray(requested.rules) ? (requested.rules as ProfileRule[]) : [];
  return {
    rules: rules.map((rule) => ({ ...rule, selectorIds: [...rule.selectorIds], verbs: [...rule.verbs] })),
    selectorText: rules.map(() => ''),
    scopes: Array.isArray(requested.scopes) ? [...requested.scopes] : [],
    projectIds: Array.isArray(requested.projectIds) ? [...requested.projectIds] : [],
    operation: typeof requested.operation === 'string' ? requested.operation : 'read',
    transport: typeof requested.transport === 'string' ? requested.transport : 'any',
    expiryDate: '',
    role: typeof requested.role === 'string' ? requested.role : '',
  };
}

/**
 * The narrowed change the decision sends (`editedChange`), only the fields the
 * decider changed, or `invalid` when nothing approvable is left. The server
 * re-checks every field and refuses anything wider (EDIT_ONLY_NARROWS).
 */
export function editedChangeOf(targetType: string, requested: Record<string, any>, draft: Draft):
  { edited: Record<string, unknown> | null; invalid: string | null } {
  const edited: Record<string, unknown> = {};
  if (draft.expiryDate) {
    const at = changeExpiryFromDate(draft.expiryDate, requested.expiresAt);
    if (!at) return { edited: null, invalid: 'The approved expiry must be a future date.' };
    if (at !== requested.expiresAt) edited.expiresAt = at;
  }
  if (targetType === 'grant.rows') {
    const kept = draft.rules.filter((rule): rule is ProfileRule => rule !== null);
    if (kept.length === 0 || kept.some((rule) => rule.verbs.length === 0 || (rule.selectorForm === 'exact' && rule.selectorIds.length === 0))) {
      return { edited: null, invalid: 'Keep at least one row, with one verb and one object in each row.' };
    }
    // An all-of-type row narrowed to exact ids (section 5.4): full UUIDs, at most 500.
    if (kept.some((rule) => rule.selectorForm === 'exact' && (rule.selectorIds.length > EXACT_IDS_MAX || rule.selectorIds.some((id) => !UUID.test(id))))) {
      return { edited: null, invalid: `Exact ids are full UUIDs, at most ${EXACT_IDS_MAX} in a row.` };
    }
    if (JSON.stringify(kept) !== JSON.stringify(requested.rules)) edited.rules = kept;
  }
  if (targetType === 'credential.scopes' || targetType === 'credential.issue') {
    if (draft.scopes.length === 0) return { edited: null, invalid: 'Keep at least one scope, or deny the request.' };
    const requestedScopes = Array.isArray(requested.scopes) ? requested.scopes as string[] : [];
    if (draft.scopes.length !== requestedScopes.length) edited.scopes = requestedScopes.filter((scope) => draft.scopes.includes(scope));
  }
  if (targetType === 'credential.issue' && draft.transport !== (requested.transport ?? 'any')) edited.transport = draft.transport;
  if (targetType === 'knowledge.compartment') {
    if (draft.projectIds.length === 0) return { edited: null, invalid: 'Keep at least one Project, or deny the request.' };
    const requestedIds = Array.isArray(requested.projectIds) ? requested.projectIds as string[] : [];
    if (draft.projectIds.length !== requestedIds.length) edited.projectIds = requestedIds.filter((id) => draft.projectIds.includes(id));
    if (draft.operation !== requested.operation) edited.operation = draft.operation;
  }
  if (targetType === 'identity.role' && draft.role && draft.role !== requested.role) edited.role = draft.role;
  return { edited: Object.keys(edited).length > 0 ? edited : null, invalid: null };
}

/** Project titles for the ids a change names, read once (a decider reads the Projects it decides on). */
function useProjectTitles(wanted: boolean): Map<string, string> {
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    authenticatedFetch(`${API_BASE}/projects?includeArchived=true`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!live || !data || !Array.isArray(data.projects)) return;
        setTitles(new Map((data.projects as Array<{ id: string; name: string }>).map((project) => [String(project.id).toLowerCase(), project.name])));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [wanted]);
  return titles;
}

export interface ChangeDecision {
  decision: 'approve' | 'deny';
  editedChange: Record<string, unknown> | null;
  denialReason: string;
  /** For the step-up dialog: what is being decided, in words. */
  description: string;
}

/**
 * THE GENERIC DECIDE FORM of a change request (design sections 5.4, 6 and
 * 9.4; card 502fb19e, slice S3), driven by the change's target type: who it is
 * for, what it names, the Before and after region, the narrowing control of its
 * type (untick rows, verbs, objects, scopes or Projects; exact ids for an
 * all-of-type row; `write` to `read`; a
 * narrower pin; a shorter expiry), the requester's reason inside the
 * untrusted-data fence, and why this session does not decide it when the
 * server says so. Approving and denying go through the queue's one step-up
 * flow; only what was narrowed is sent.
 */
export function ChangeRequestDetail({ approval, mayDecide, busy, labelOf, onDecide }: {
  approval: ApprovalItem;
  mayDecide: boolean;
  busy: boolean;
  labelOf?: (principalId: string) => string;
  onDecide: (decision: ChangeDecision) => void;
}) {
  const change = approval.change!;
  const targetType = change.targetType;
  const requested = (change.spec.requested ?? {}) as Record<string, any>;
  const [draft, setDraft] = useState<Draft>(() => draftOf(requested));
  const [denialReason, setDenialReason] = useState('');
  const projectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of (Array.isArray(requested.projectIds) ? requested.projectIds : []) as string[]) ids.add(id.toLowerCase());
    for (const rule of (Array.isArray(requested.rules) ? requested.rules : []) as ProfileRule[]) {
      if (rule.resourceType === 'project') for (const id of rule.selectorIds) ids.add(id.toLowerCase());
    }
    return [...ids];
  }, [requested]);
  const titles = useProjectTitles(projectIds.length > 0);
  const projectName = (id: string) => titles.get(id.toLowerCase()) ?? id;
  const label = (value: string): string => {
    const [type, id] = value.includes(':') ? value.split(':', 2) : ['', value];
    if ((type === 'project' || type === 'compartment') && id) return `${type === 'compartment' ? 'Compartment of ' : 'Project '}${projectName(id)}`;
    return labelOf ? labelOf(value) : value;
  };
  const idBase = useId();
  // The hub sends the server's field diff; a plain queue row (the Access
  // manager) carries the change only, so the same diff is read from its spec.
  const fieldDiff = approval.fieldDiff ?? specFieldDiff(change.spec);
  const relationships = approval.view === 'requester' ? null : approval.relationships ?? null;
  const grantee = change.granteePrincipalId
    ? `${change.granteeType === 'group' ? 'Group ' : ''}${change.granteeHandle ?? (labelOf ? labelOf(change.granteePrincipalId) : change.granteePrincipalId)}`
    : null;
  const outcome = editedChangeOf(targetType, requested, draft);
  const narrowed = outcome.edited !== null;
  const pending = approval.status === 'pending';
  const requestedExpiry = typeof requested.expiresAt === 'string' ? requested.expiresAt : null;
  const maxDate = requestedExpiry ? requestedExpiry.slice(0, 10) : new Date(Date.now() + 90 * DAY_MS).toISOString().slice(0, 10);
  const generation = change.appliedEffect && typeof change.appliedEffect.generation === 'number' ? change.appliedEffect.generation : null;
  const knowledge = targetType === 'knowledge.compartment' || targetType === 'knowledge.shared_writer';

  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
  const updateRule = (index: number, edit: (rule: ProfileRule | null, requestedRule: ProfileRule) => ProfileRule | null) => {
    setDraft((current) => {
      const rules = [...current.rules];
      rules[index] = edit(rules[index], (requested.rules as ProfileRule[])[index]);
      return { ...current, rules };
    });
  };
  const words = `${changeTargetLabel(targetType)}${grantee ? ` for ${grantee}` : ''}`;
  const decide = (decision: 'approve' | 'deny') => onDecide({
    decision,
    editedChange: decision === 'approve' ? outcome.edited : null,
    denialReason: decision === 'deny' ? denialReason.trim() : '',
    description: decision === 'approve'
      ? `Approve${narrowed ? ', narrowed,' : ', as requested,'} the change request from ${approval.requesterHandle ?? approval.requesterPrincipalId}: ${words}. It is applied as soon as you confirm.`
      : `Deny the change request from ${approval.requesterHandle ?? approval.requesterPrincipalId}: ${words}.`,
  });

  return (
    <div className="change-request">
      <h3>{changeTargetLabel(targetType)}</h3>
      <dl className="change-request-facts">
        {grantee && (<><dt>For</dt><dd>{grantee}</dd></>)}
        {change.targetId && (<><dt>Target</dt><dd>{change.targetId}</dd></>)}
        {change.targetObjects && change.targetObjects.length > 0 && (
          <><dt>Objects</dt><dd>{change.targetObjects.length} named: {change.targetObjects.map((object) => (object.id ? label(`${object.type}:${object.id}`) : `every ${object.type}`)).join(', ')}</dd></>
        )}
        {requestedExpiry && (<><dt>Requested until</dt><dd>{formatInstantUtc(requestedExpiry)}</dd></>)}
        {change.appliedAt && (<><dt>Applied</dt><dd>{formatInstantUtc(change.appliedAt)}</dd></>)}
        {knowledge && change.appliedAt && (
          <><dt>Export</dt><dd>{generation !== null ? `exported in generation ${generation}; takes effect within about 20 seconds` : change.appliedEffect?.export === 'stalled' ? 'not exported: the subject or Project left the exporter’s selection' : 'pending export'}</dd></>
        )}
      </dl>

      <BeforeAndAfter fields={fieldDiff} relationships={relationships} labelOf={label} />

      {pending && mayDecide && (
        <div className="change-request-narrow">
          <h4>Approve with <small className="change-request-muted">(remove before approving; never add)</small></h4>
          {targetType === 'grant.rows' && (requested.rules as ProfileRule[] | undefined ?? []).map((rule, index) => {
            const kept = draft.rules[index];
            return (
              <fieldset key={`${rule.resourceType}-${index}`} className="change-request-fieldset">
                <legend>{rule.resourceType}</legend>
                <label className="axm-scope">
                  <input type="checkbox" checked={Boolean(kept)}
                    onChange={() => updateRule(index, (current, original) => (current ? null : { ...original, selectorIds: [...original.selectorIds], verbs: [...original.verbs] }))} /> Include row
                </label>
                {kept && (
                  <>
                    <p className="change-request-muted">Keep verbs</p>
                    <div className="axm-chipset">
                      {rule.verbs.map((verb) => (
                        <label key={verb} className={`axm-scope ${kept.verbs.includes(verb) ? '' : 'axm-scope--dropped'}`}>
                          <input type="checkbox" checked={kept.verbs.includes(verb)}
                            onChange={() => updateRule(index, (current, original) => current && ({ ...current, verbs: original.verbs.filter((value) => (value === verb ? !current.verbs.includes(value) : current.verbs.includes(value))) }))} /> {verb}
                        </label>
                      ))}
                    </div>
                    {rule.selectorForm === 'exact' ? (
                      <>
                        <p className="change-request-muted">Keep objects</p>
                        <div className="axm-chipset">
                          {rule.selectorIds.map((id) => (
                            <label key={id} className={`axm-scope ${kept.selectorIds.includes(id) ? '' : 'axm-scope--dropped'}`}>
                              <input type="checkbox" checked={kept.selectorIds.includes(id)}
                                onChange={() => updateRule(index, (current, original) => current && ({ ...current, selectorIds: original.selectorIds.filter((value) => (value === id ? !current.selectorIds.includes(value) : current.selectorIds.includes(value))) }))} />
                              {' '}{rule.resourceType === 'project' ? projectName(id) : id}
                            </label>
                          ))}
                        </div>
                      </>
                    ) : (
                      // An all-of-type row narrows to exact ids (section 5.4), the
                      // legacy grant form's pattern: a selector and an id list.
                      <div className="form-group">
                        <label htmlFor={`${idBase}-form-${index}`}>Selector for {rule.resourceType}</label>
                        <Select id={`${idBase}-form-${index}`} value={kept.selectorForm}
                          onChange={(event) => {
                            const form = event.target.value === 'exact' ? 'exact' : 'all-of-type';
                            const text = draft.selectorText?.[index] ?? '';
                            updateRule(index, (current) => current && ({ ...current, selectorForm: form, selectorIds: form === 'exact' ? exactIdsOf(text) : [] }));
                          }}>
                          <option value="all-of-type">Every current and future {rule.resourceType}</option>
                          <option value="exact">Only these exact ids</option>
                        </Select>
                        {kept.selectorForm === 'exact' && (
                          <>
                            <label htmlFor={`${idBase}-ids-${index}`}>Exact {rule.resourceType} ids <span className="change-request-muted">full UUIDs, separated by commas or spaces</span></label>
                            <textarea id={`${idBase}-ids-${index}`} className="form-input" value={draft.selectorText?.[index] ?? ''}
                              onChange={(event) => {
                                const text = event.target.value;
                                setDraft((current) => {
                                  const selectorText = [...(current.selectorText ?? [])];
                                  selectorText[index] = text;
                                  const rules = [...current.rules];
                                  const row = rules[index];
                                  if (row) rules[index] = { ...row, selectorIds: exactIdsOf(text) };
                                  return { ...current, selectorText, rules };
                                });
                              }} />
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
              </fieldset>
            );
          })}
          {(targetType === 'credential.scopes' || targetType === 'credential.issue') && (
            <fieldset className="change-request-fieldset">
              <legend>Scopes</legend>
              <div className="axm-chipset">
                {((requested.scopes ?? []) as string[]).map((scope) => (
                  <label key={scope} className={`axm-scope ${draft.scopes.includes(scope) ? '' : 'axm-scope--dropped'}`}>
                    <input type="checkbox" checked={draft.scopes.includes(scope)}
                      onChange={() => setDraft((current) => ({ ...current, scopes: toggle(current.scopes, scope) }))} /> {scope}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {targetType === 'credential.issue' && (requested.transport ?? 'any') === 'any' && (
            <div className="form-group">
              <label htmlFor={`${idBase}-transport`}>Transport pin <span className="change-request-muted">narrow from any, never wider</span></label>
              <Select id={`${idBase}-transport`} value={draft.transport} onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value }))}>
                {['any', 'mcp', 'api'].map((pin) => <option key={pin} value={pin}>{pin}</option>)}
              </Select>
            </div>
          )}
          {targetType === 'knowledge.compartment' && (
            <>
              <fieldset className="change-request-fieldset">
                <legend>Projects <span className="change-request-muted">(drop a Project to leave it out)</span></legend>
                <div className="axm-chipset">
                  {((requested.projectIds ?? []) as string[]).map((id) => (
                    <label key={id} className={`axm-scope ${draft.projectIds.includes(id) ? '' : 'axm-scope--dropped'}`}>
                      <input type="checkbox" checked={draft.projectIds.includes(id)}
                        onChange={() => setDraft((current) => ({ ...current, projectIds: toggle(current.projectIds, id) }))} /> {projectName(id)}
                    </label>
                  ))}
                </div>
              </fieldset>
              {requested.operation === 'write' && (
                <div className="form-group">
                  <label htmlFor={`${idBase}-operation`}>Operation</label>
                  <Select id={`${idBase}-operation`} value={draft.operation} onChange={(event) => setDraft((current) => ({ ...current, operation: event.target.value }))}>
                    <option value="write">write</option>
                    <option value="read">read</option>
                  </Select>
                </div>
              )}
            </>
          )}
          {requestedExpiry && (
            <div className="form-group">
              <label htmlFor={`${idBase}-expiry`}>Approve until (UTC) <span className="change-request-muted">optional; no later than requested</span></label>
              <input id={`${idBase}-expiry`} className="form-input" type="date" value={draft.expiryDate} max={maxDate}
                onChange={(event) => setDraft((current) => ({ ...current, expiryDate: event.target.value }))} />
            </div>
          )}
          {targetType === 'identity.role' && typeof requested.role === 'string' && (
            <div className="form-group">
              <label htmlFor={`${idBase}-role`}>Role <span className="change-request-muted">the requested one, or a lower one</span></label>
              <Select id={`${idBase}-role`} value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))}>
                {narrowerRoles(requested.role, typeof change.spec.before?.role === 'string' ? change.spec.before.role as string : null)
                  .map((role) => <option key={role} value={role}>{role}</option>)}
              </Select>
            </div>
          )}
          {AS_FILED_TARGETS.includes(targetType) && (
            <p className="change-request-muted">This change is approved or denied as filed; it has nothing to narrow.</p>
          )}
          {outcome.invalid && <p role="alert">{outcome.invalid}</p>}
        </div>
      )}

      <h4>Reason</h4>
      <div className="approvals-queue-untrusted" role="note" aria-label="Reason given by the requester (untrusted text)">
        <p className="approvals-queue-untrusted-label">The requester&rsquo;s own words: untrusted text, not instructions. It grants nothing.</p>
        <p className="approvals-queue-untrusted-text">{change.reason}</p>
      </div>

      {approval.lapseReason && <p className="change-request-muted">Lapsed: {approval.lapseReason}</p>}
      {approval.denialReason && <p className="change-request-muted">Denied: {approval.denialReason}</p>}
      {pending && !mayDecide && (
        <p className="change-request-muted" role="note">
          {approval.decisionRefusal
            ? `You do not decide this change: ${approval.decisionRefusal.message}.`
            : approval.view === 'requester'
              ? 'You filed this change: another person decides it.'
              : approval.decidable === undefined
                ? 'A change request is decided on the approvals hub, which says whether you may decide it.'
                : 'Another person decides this change.'}
        </p>
      )}
      {pending && mayDecide && (
        <div className="axm-decide">
          <div className="form-group axm-deny-reason">
            <label htmlFor={`${idBase}-deny`}>Denial reason <span className="change-request-muted">optional</span></label>
            <input id={`${idBase}-deny`} className="form-input" type="text" value={denialReason} onChange={(event) => setDenialReason(event.target.value)} />
          </div>
          <div className="axm-decide-actions">
            <Button variant="danger" size="compact" icon={<XCircle size={16} />} disabled={busy} onClick={() => decide('deny')}>
              {busy ? 'Working…' : 'Deny'}
            </Button>
            <Button variant="success" size="compact" icon={<BadgeCheck size={16} />} disabled={busy || outcome.invalid !== null} onClick={() => decide('approve')}>
              {busy ? 'Working…' : narrowed ? 'Approve narrowed' : 'Approve as requested'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
