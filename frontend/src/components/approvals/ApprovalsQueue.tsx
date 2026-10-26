import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, BookOpen, ClipboardCheck, History, Inbox, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import type { Principal } from '../../types/task';
import { authenticatedFetch } from '../../utils/auth';
import { sendWithStepUpRetry } from '../../utils/stepUpChallenge';
import { formatDateTime, formatInstantUtc } from '../../utils/dateFormat';
import { principalLabel, readJson, ruleSummary, type ProfileRule, type StepUpRequest } from '../access/accessShared';
import {
  approvalKind, approvalKindLabel, isAccessRequest, isAuthorityEdit, isChangeRequest, isCredentialRequest, isSkillPublish, isVerification,
  pendingApprovals, viewerMayDecide,
  type AccessRequestRuleView, type ApprovalItem, type ApprovalsViewer, type CredentialDecision,
} from './approvals';
import { ChangeRequestDetail, changeTargetLabel, type ChangeDecision } from './ChangeRequestDetail';
import { groupHubItems, hubListQuery, type HubSection } from './hubGrouping';
import '../../pages/AccessManagerPage.css';
import './ApprovalsQueue.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GrantRules = Array<ProfileRule | null>;

function grantRulesValid(rules: GrantRules, expiresAt: string, editedExpiry: string): boolean {
  if (!rules.some(Boolean)) return false;
  if (rules.some((rule) => rule && (rule.verbs.length === 0
    || (rule.selectorForm === 'exact' && (rule.selectorIds.length === 0 || rule.selectorIds.length > 500
      || rule.selectorIds.some((id) => !UUID.test(id))))))) return false;
  if (!editedExpiry) return true;
  const chosen = Date.parse(`${editedExpiry}Z`);
  return Number.isFinite(chosen) && chosen > Date.now() && chosen <= Date.parse(expiresAt);
}

function grantExpiry(editedExpiry: string): string | null {
  return editedExpiry ? new Date(`${editedExpiry}Z`).toISOString() : null;
}

/**
 * AZ-A13 clause 6j (E94; card 0e07c0c7): the lifetime an authority-edit
 * approval sends. "Until this task ends" is removed when the related task is
 * completed or archived, OR at the date the decider sets, whichever comes
 * first; a request with no related task needs the date. The date input is UTC,
 * like the grant expiry above. Null: the choice is not yet complete or valid.
 */
function authorityEditLifetime(
  choice: '' | 'keep' | 'until-task', relatedTaskId: string | null | undefined, revertInput: string, now = Date.now(),
): { choice: 'keep' } | { choice: 'until-task'; taskId?: string; revertAt?: string } | null {
  if (choice === 'keep') return { choice: 'keep' };
  if (choice !== 'until-task') return null;
  let revertAt: string | undefined;
  if (revertInput) {
    const at = Date.parse(`${revertInput}Z`);
    if (!Number.isFinite(at) || at <= now) return null;
    revertAt = new Date(at).toISOString();
  }
  if (!relatedTaskId && !revertAt) return null;
  return { choice: 'until-task', ...(relatedTaskId ? { taskId: relatedTaskId } : {}), ...(revertAt ? { revertAt } : {}) };
}

/** The words the step-up dialog and the decided item use for a lifetime. */
function lifetimeWords(lifetime: { choice: string; taskId?: string | null; revertAt?: string | null }): string {
  if (lifetime.choice === 'keep') return 'keep (until narrowed)';
  const date = lifetime.revertAt ? formatInstantUtc(lifetime.revertAt) : null;
  if (lifetime.taskId && date) return `until this task ends or ${date}, whichever comes first`;
  return date ? `until ${date}` : 'until this task ends';
}

/**
 * When the added authority is removed, for the hint under the revert date. The
 * authority stays until then and is removed AT the date (round-1 review B1:
 * "removed until <date>" said the opposite).
 */
function revertHintWords(lifetime: { choice: string; taskId?: string | null; revertAt?: string | null }): string {
  const date = lifetime.revertAt ? formatInstantUtc(lifetime.revertAt) : null;
  if (lifetime.taskId && date) return `when this task ends or at ${date}, whichever comes first`;
  return date ? `at ${date}` : 'when this task ends';
}

/** Which approvals the queue lists. The Access manager offers the first and the last. */
export type ApprovalsQueueFilter = 'pending' | 'decided' | 'all';

/**
 * Where the queue is mounted (card b1e3b16d, lane L1; design B.1).
 *
 *  - `access-manager`: the Access manager's "Pending approvals" panel, exactly
 *    as it was before the extraction — its own status select, the published
 *    deep link `?approval=<id>` expanding and marking the item in place — plus
 *    one link into the hub.
 *  - `hub`: `/approvals`. The status filter is the page's URL state, every
 *    row carries its kind and a History control, and `?approval=<id>` opens
 *    the item's drawer (the page owns the drawer; this list only asks for it).
 *
 * ONE list, one decide flow, one narrowing editor: both mounts render this
 * component, so neither can drift from the other.
 */
export type ApprovalsQueueMount = 'access-manager' | 'hub';

interface ApprovalsQueueProps {
  mount: ApprovalsQueueMount;
  principalById: Map<string, Principal>;
  deepLinkApprovalId: string | null;
  requestStepUp: (request: StepUpRequest) => void;
  surface: (kind: 'notice' | 'error', message: string) => void;
  /** Hub only: the filter the page's URL names. The Access manager keeps its own. */
  statusFilter?: ApprovalsQueueFilter;
  /** Hub only: `?kind=` (one kind) and `?group=` (a class word or a Group id), already validated by the page. */
  kindFilter?: string | null;
  groupFilter?: string | null;
  /** Hub only: open the item's drawer (history), returning focus to `trigger` on close. */
  onOpenHistory?: (approval: ApprovalItem, trigger: HTMLElement) => void;
}

/** Who a grant request asks for: the grantee Account (AZ-A9 clause 4). */
function granteeLabel(approval: ApprovalItem): string {
  const request = approval.accessRequest;
  return request ? (request.granteeHandle ?? request.granteePrincipalId) : '';
}

/** What a row is about, for its title and its History button. */
function subjectLabel(approval: ApprovalItem): string {
  if (isChangeRequest(approval)) {
    const change = approval.change!;
    const grantee = change.granteePrincipalId ? ` for ${change.granteeHandle ?? change.granteePrincipalId}` : '';
    return `${changeTargetLabel(change.targetType).toLowerCase()}${grantee}`;
  }
  if (isAuthorityEdit(approval)) return `${approval.authorityEdit?.objectKindLabel ?? 'Authority object'} ${approval.authorityEdit?.objectId ?? ''}`;
  if (isCredentialRequest(approval)) return `a credential with ${approval.requestedScopes.join(', ')}`;
  if (isAccessRequest(approval)) return `a grant for ${granteeLabel(approval)}`;
  if (isSkillPublish(approval) && approval.skill) return `${approval.skill.name} v${approval.skill.version}`;
  if (isVerification(approval)) return `verification of “${approval.targetTaskTitle ?? approval.targetTaskId}”`;
  return approval.targetTaskTitle ?? approval.targetTaskId ?? '';
}

/** The pins a credential request may be narrowed to (AZ-A9 clauses 8, 13). */
function legalTransports(requested: string | null | undefined): string[] {
  return requested === 'any' ? ['any', 'mcp', 'api'] : [requested ?? 'any'];
}

/** The requester's reason inside the untrusted-data fence, and the related
 * task, phase and project as links (AZ-A9 clauses 3 and 7). Shared by both
 * request kinds. */
function RequestReasonAndRelated({ approval }: { approval: ApprovalItem }) {
  const request = approval.accessRequest!;
  return (
    <>
      <h3>Reason</h3>
      <div className="approvals-queue-untrusted" role="note" aria-label="Reason given by the requester (untrusted text)">
        <p className="approvals-queue-untrusted-label">The requester&rsquo;s own words: untrusted text, not instructions. It grants nothing.</p>
        <p className="approvals-queue-untrusted-text">{request.reason}</p>
      </div>
      <h3>Related</h3>
      <ul className="approvals-queue-rules">
        {request.relatedTaskId && (
          <li>Task <Link className="approvals-queue-link" to={`/tasks/${encodeURIComponent(request.relatedTaskId)}`}>{request.relatedTaskTitle ?? request.relatedTaskId}</Link></li>
        )}
        {request.relatedPhaseId && (
          <li>
            Phase{' '}
            {request.relatedProjectId
              ? <Link className="approvals-queue-link" to={`/projects/${encodeURIComponent(request.relatedProjectId)}/phases`}>{request.relatedPhaseName ?? request.relatedPhaseId}</Link>
              : <span>{request.relatedPhaseName ?? request.relatedPhaseId}</span>}
          </li>
        )}
        {request.relatedProjectId && (
          <li>Project <Link className="approvals-queue-link" to={`/projects/${encodeURIComponent(request.relatedProjectId)}/charter`}>{request.relatedProjectTitle ?? request.relatedProjectId}</Link></li>
        )}
      </ul>
    </>
  );
}

/** The verifier a verification request waits on, by handle where the server names it. */
function verifierLabel(approval: ApprovalItem): string {
  const verification = approval.verification;
  return verification ? (verification.verifierHandle ?? verification.verifierPrincipalId) : 'the verifier';
}

/** The second line of a row: what exactly is asked. */
function askLine(approval: ApprovalItem): string {
  if (isChangeRequest(approval)) return `requests a change: ${subjectLabel(approval)}`;
  if (isAuthorityEdit(approval)) return `requests an edit to ${subjectLabel(approval)}`;
  if (isAccessRequest(approval)) return `requests ${subjectLabel(approval)}`;
  if (isSkillPublish(approval)) return `asks to publish ${subjectLabel(approval)}`;
  if (isVerification(approval)) return `asked ${verifierLabel(approval)} to verify “${approval.targetTaskTitle ?? approval.targetTaskId}”`;
  return `wants an agent on “${approval.targetTaskTitle ?? approval.targetTaskId}”`;
}

function editValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function AuthorityEditDetail({ approval }: { approval: ApprovalItem }) {
  const edit = approval.authorityEdit;
  if (!edit) return <p role="alert">The board did not provide the edit details. This request cannot be approved here.</p>;
  return (
    <>
      <h3>{edit.objectKindLabel}</h3>
      <p>Object {edit.objectId}</p>
      <h3>Requested changes</h3>
      {edit.diff.length === 0 ? <p>No changed fields were reported.</p> : (
        <dl className="approval-drawer-facts">
          {edit.diff.map(({ field, before, after }) => (
            <React.Fragment key={field}>
              <dt>{field}</dt><dd>{editValue(before)} → {editValue(after)}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {edit.lifetime && <p>Chosen lifetime: {edit.lifetime.label}{edit.lifetime.taskId ? ` (task ${edit.lifetime.taskId})` : ''}{edit.lifetime.revertAt ? `; reverts at ${formatInstantUtc(edit.lifetime.revertAt)}` : ''}{edit.lifetime.revertedAt ? `; reverted ${formatInstantUtc(edit.lifetime.revertedAt)}` : ''}.</p>}
      {approval.accessRequest && <RequestReasonAndRelated approval={approval} />}
    </>
  );
}

/**
 * One requested row as the decider reads it (AZ-A9 clauses 5 and 7): the
 * resource type, each object by title (its id when the title is not served),
 * or "every current and future object of this type", and the verbs.
 */
function RuleViewLine({ view }: { view: AccessRequestRuleView }) {
  return (
    <li className="approvals-queue-rule">
      <strong>{view.resourceType}</strong>{' '}
      {view.allOfType !== null
        ? <em>{view.allOfType}</em>
        : view.objects.map((object, index) => (
          <React.Fragment key={object.id}>
            {index > 0 && ', '}
            {view.resourceType === 'task'
              ? <Link className="approvals-queue-link" to={`/tasks/${encodeURIComponent(object.id)}`}>{object.title ?? object.id}</Link>
              : <span>{object.title ?? object.id}</span>}
            {object.title !== null && <small className="axm-muted"> ({object.id})</small>}
          </React.Fragment>
        ))}
      {' — '}{view.verbs.join(', ')}
    </li>
  );
}

/**
 * The grant request's requested facts stay visible beside the decider's
 * downward-only draft. The server validates the final editedRules/expiry.
 */
function AccessRequestDetail({ approval, editable, rules, expiry, selectorText, onRow, onVerb, onObject, onForm, onSelector, onExpiry }: {
  approval: ApprovalItem; editable: boolean; rules: GrantRules; expiry: string;
  selectorText: Record<string, string>;
  onRow: (index: number) => void; onVerb: (index: number, verb: string) => void;
  onObject: (index: number, id: string) => void; onForm: (index: number, form: 'exact' | 'all-of-type') => void;
  onSelector: (index: number, text: string) => void; onExpiry: (value: string) => void;
}) {
  const request = approval.accessRequest!;
  const views: AccessRequestRuleView[] = request.ruleViews ?? approval.requestedRules.map((rule) => ({
    resourceType: rule.resourceType,
    selectorForm: rule.selectorForm,
    verbs: [...rule.verbs],
    objects: rule.selectorForm === 'exact' ? rule.selectorIds.map((id) => ({ id, title: null })) : [],
    allOfType: rule.selectorForm === 'all-of-type' ? 'every current and future object of this type' : null,
  }));
  return (
    <>
      <h3>Grantee Account</h3>
      <p>{granteeLabel(approval)} <small className="axm-muted">(the requester&rsquo;s own Account; its connectors and agents reach these rows only within their own caps)</small></p>
      <h3>Requested rows</h3>
      <ul className="approvals-queue-rules">
        {views.map((view, index) => <RuleViewLine key={`${view.resourceType}-${index}`} view={view} />)}
      </ul>
      {editable && (
        <>
          <h3>Approve with <small>(remove authority before approving)</small></h3>
          <div className="approvals-queue-grant-editor">
            {approval.requestedRules.map((requested, index) => {
              const rule = rules[index];
              const view = views[index];
              return (
                <fieldset key={`${requested.resourceType}-${index}`} className="approvals-queue-grant-row">
                  <legend>{requested.resourceType}</legend>
                  <label className="axm-scope">
                    <input type="checkbox" checked={Boolean(rule)} onChange={() => onRow(index)} /> Include row
                  </label>
                  {rule && (
                    <>
                      <p className="axm-muted">Keep verbs</p>
                      <div className="axm-chipset">
                        {requested.verbs.map((verb) => (
                          <label key={verb} className={`axm-scope ${rule.verbs.includes(verb) ? '' : 'axm-scope--dropped'}`}>
                            <input type="checkbox" checked={rule.verbs.includes(verb)} onChange={() => onVerb(index, verb)} /> {verb}
                          </label>
                        ))}
                      </div>
                      {requested.selectorForm === 'all-of-type' ? (
                        <div className="form-group">
                          <label htmlFor={`grant-selector-form-${approval.id}-${index}`}>Selector for {requested.resourceType}</label>
                          <Select id={`grant-selector-form-${approval.id}-${index}`} value={rule.selectorForm}
                            onChange={(event) => onForm(index, event.target.value as 'exact' | 'all-of-type')}>
                            <option value="all-of-type">Every current and future object</option>
                            <option value="exact">Only these exact IDs</option>
                          </Select>
                          {rule.selectorForm === 'exact' && (
                            <>
                              <label htmlFor={`grant-selector-ids-${approval.id}-${index}`}>Exact {requested.resourceType} IDs <span className="axm-muted">full UUIDs, separated by commas or spaces</span></label>
                              <textarea id={`grant-selector-ids-${approval.id}-${index}`} className="form-input"
                                value={selectorText[`${approval.id}:${index}`] ?? ''}
                                onChange={(event) => onSelector(index, event.target.value)} />
                            </>
                          )}
                        </div>
                      ) : (
                        <>
                          <p className="axm-muted">Keep requested objects</p>
                          <div className="axm-chipset">
                            {requested.selectorIds.map((id) => (
                              <label key={id} className={`axm-scope ${rule.selectorIds.includes(id) ? '' : 'axm-scope--dropped'}`}>
                                <input type="checkbox" checked={rule.selectorIds.includes(id)} onChange={() => onObject(index, id)} />
                                {view?.objects.find((object) => object.id === id)?.title ?? id}
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </fieldset>
              );
            })}
          </div>
          <div className="form-group">
            <label htmlFor={`grant-expiry-${approval.id}`}>Approve until (UTC) <span className="axm-muted">optional; earlier than requested</span></label>
            <input id={`grant-expiry-${approval.id}`} className="form-input" type="datetime-local"
              value={expiry} max={request.requestedExpiresAt.slice(0, 16)} onChange={(event) => onExpiry(event.target.value)} />
            <p className="axm-muted">{expiry && grantRulesValid(rules, request.requestedExpiresAt, expiry)
              ? `Proposed expiry: ${formatInstantUtc(grantExpiry(expiry)!)}.`
              : `Requested expiry remains ${formatInstantUtc(request.requestedExpiresAt)} unless shortened.`}</p>
          </div>
          {!grantRulesValid(rules, request.requestedExpiresAt, expiry) && (
            <p role="alert">Keep at least one row, one verb and a valid selector per row; any new expiry must be in the future and no later than requested.</p>
          )}
        </>
      )}
      {request.approvedRuleViews && (
        <>
          <h3>Approved rows</h3>
          <ul className="approvals-queue-rules">
            {request.approvedRuleViews.map((view, index) => <RuleViewLine key={`${view.resourceType}-${index}`} view={view} />)}
          </ul>
        </>
      )}
      <h3>Expires</h3>
      <p>
        Requested until <time dateTime={request.requestedExpiresAt}>{formatDateTime(request.requestedExpiresAt, request.requestedExpiresAt)}</time>
        {request.approvedExpiresAt && (
          <>; approved until <time dateTime={request.approvedExpiresAt}>{formatDateTime(request.approvedExpiresAt, request.approvedExpiresAt)}</time></>
        )}
        . The grants are revoked when the related task (for a phase-only request, the phase) is completed or archived.
      </p>
      <RequestReasonAndRelated approval={approval} />
      {request.createdGrantIds.length > 0 && (
        <p className="axm-muted">Wrote {request.createdGrantIds.length} grant row{request.createdGrantIds.length === 1 ? '' : 's'}.</p>
      )}
    </>
  );
}

type DecisionState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; credential: CredentialDecision | null };

interface CredentialNarrowing {
  keptScopes: string[];
  transport: string;
  expiryDate: string;
  onToggleScope: (scope: string) => void;
  onTransport: (transport: string) => void;
  onExpiryDate: (date: string) => void;
}

/**
 * The detail of a CREDENTIAL request (AZ-A9 clause 13; card 785e1eed P1-B-2):
 * a connector asks for ONE new credential on itself, carrying scopes it lacks.
 * What the decider needs to judge it (clause 7) is read on expand from
 * `GET /approvals/:id` — the credentials the connector already holds (label,
 * key id, scopes, pin; never a secret), which requested scopes are new, which
 * would be carried but unusable, and what this session may put on a
 * credential. A decider narrows here: untick scopes, narrow the pin from any,
 * shorten the expiry. Approval issues nothing: the connector collects the new
 * credential itself, once, within 24 hours, and its current credential stays.
 */
function CredentialRequestDetail({ approval, editable, narrowing }: {
  approval: ApprovalItem; editable: boolean; narrowing: CredentialNarrowing;
}) {
  const request = approval.accessRequest!;
  const [decision, setDecision] = useState<DecisionState>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const data = await readJson(await authenticatedFetch(`${API_BASE}/approvals/${encodeURIComponent(approval.id)}`));
        const credential = data?.decision?.credential ?? null;
        if (live) setDecision({ status: 'ready', credential: credential as CredentialDecision | null });
      } catch {
        if (live) setDecision({ status: 'failed' });
      }
    })();
    return () => { live = false; };
  }, [approval.id]);
  const held = decision.status === 'ready' ? decision.credential : null;
  const isNew = (scope: string): boolean | null => {
    if (!held) return null;
    const entry = held.requestedScopes.find((candidate) => candidate.scope === scope);
    return entry ? !entry.heldByAnyLiveCredential : null;
  };
  const requester = approval.requesterHandle ?? approval.requesterPrincipalId;
  const transports = legalTransports(request.requestedTransport);
  const transportId = `credential-transport-${approval.id}`;
  const expiryId = `credential-expiry-${approval.id}`;
  return (
    <>
      <h3>Credential for</h3>
      <p>
        {requester}{' '}
        <small className="axm-muted">(the requesting connector itself; the new credential is added beside its current one, which stays live)</small>
      </p>
      <h3>Credentials it holds now</h3>
      {decision.status === 'loading' && <p className="axm-muted">Loading the connector&rsquo;s credentials…</p>}
      {decision.status === 'failed' && <p className="axm-muted" role="status">Couldn&rsquo;t load the connector&rsquo;s credentials.</p>}
      {decision.status === 'ready' && !held && (
        <p className="axm-muted">Only root or an administrator sees the credentials a connector holds.</p>
      )}
      {held && (
        <ul className="approvals-queue-rules">
          {held.liveCredentials.map((credential) => (
            <li key={credential.id}>
              <strong>{credential.label ?? credential.keyId ?? credential.id}</strong>
              {credential.requesting && <small className="axm-muted"> (filed this request)</small>}
              {' — '}{credential.scopes.join(', ')}{'; pin '}{credential.transport ?? 'any'}
              {credential.expiresAt && <>{'; expires '}<time dateTime={credential.expiresAt}>{formatDateTime(credential.expiresAt, credential.expiresAt)}</time></>}
            </li>
          ))}
        </ul>
      )}
      <h3>Requested scopes {editable && <small>(untick to narrow before approving)</small>}</h3>
      <div className="axm-chipset">
        {approval.requestedScopes.map((scope) => {
          const fresh = isNew(scope);
          const tag = fresh === null ? null : <span className="approvals-queue-scope-tag">{fresh ? 'new' : 'already held'}</span>;
          return editable ? (
            <label key={scope} className={`axm-scope ${narrowing.keptScopes.includes(scope) ? '' : 'axm-scope--dropped'}`}>
              <input
                type="checkbox"
                checked={narrowing.keptScopes.includes(scope)}
                onChange={() => narrowing.onToggleScope(scope)}
              /> {scope} {tag}
            </label>
          ) : <span key={scope} className="axm-scope">{scope} {tag}</span>;
        })}
      </div>
      {approval.approvedScopes && approval.status !== 'pending' && (
        <>
          <h3>Approved scopes</h3>
          <div className="axm-chipset">
            {approval.approvedScopes.map((scope) => <span key={scope} className="axm-scope">{scope}</span>)}
          </div>
        </>
      )}
      {held && held.inertScopes.length > 0 && (
        <p className="axm-muted">
          Carried but unusable by this connector — its Account or chain does not reach them: {held.inertScopes.join(', ')}.
        </p>
      )}
      {held && held.deciderCap.exceeding.length > 0 && (
        <p className="axm-muted" role="status">
          Beyond what you may put on a credential, so approving as is will be refused: {held.deciderCap.exceeding.join(', ')}.
        </p>
      )}
      <h3>Transport</h3>
      {editable && transports.length > 1 ? (
        <div className="form-group">
          <label htmlFor={transportId}>Transport pin <span className="axm-muted">narrow from any, never wider</span></label>
          <Select id={transportId} value={narrowing.transport} onChange={(event) => narrowing.onTransport(event.target.value)}>
            {transports.map((pin) => <option key={pin} value={pin}>{pin}</option>)}
          </Select>
        </div>
      ) : (
        <p>{request.approvedTransport ?? request.requestedTransport ?? 'any'}</p>
      )}
      <h3>Expires</h3>
      <p>
        Requested until <time dateTime={request.requestedExpiresAt}>{formatDateTime(request.requestedExpiresAt, request.requestedExpiresAt)}</time>
        {request.approvedExpiresAt && (
          <>; approved until <time dateTime={request.approvedExpiresAt}>{formatDateTime(request.approvedExpiresAt, request.approvedExpiresAt)}</time></>
        )}
        . The credential is revoked when the related task (for a phase-only request, the phase) is completed or archived.
      </p>
      {editable && (
        <div className="form-group">
          <label htmlFor={expiryId}>Approve until <span className="axm-muted">optional; no later than requested</span></label>
          <input
            id={expiryId}
            className="form-input"
            type="date"
            value={narrowing.expiryDate}
            max={request.requestedExpiresAt.slice(0, 10)}
            onChange={(event) => narrowing.onExpiryDate(event.target.value)}
          />
        </div>
      )}
      {request.credentialLabel && <p>Label: {request.credentialLabel}</p>}
      <RequestReasonAndRelated approval={approval} />
      {approval.status === 'approved' && approval.collectExpiresAt && (
        <p className="axm-muted">
          Approved: the connector collects it with the same key until{' '}
          <time dateTime={approval.collectExpiresAt}>{formatDateTime(approval.collectExpiresAt, approval.collectExpiresAt)}</time>.
        </p>
      )}
      {request.issuedCredentialId && (
        <p className="axm-muted">Issued credential {request.issuedCredentialId.slice(0, 8)}.</p>
      )}
    </>
  );
}

/**
 * T10, the hub's item facts (card b1e3b16d): who asked, what exactly, when,
 * where it belongs and who decides — each from the server's hub fields. The
 * decider sentence and whether THIS session may decide are the server's
 * (`deciders`, `decidable`: the decide route's own rule); nothing here works
 * authority out.
 */
function HubFacts({ approval }: { approval: ApprovalItem }) {
  const refs = approval.refs;
  const groups = approval.ownership?.groups ?? [];
  return (
    <div className="approvals-queue-facts">
      <p className="approvals-queue-fact">
        Asked {formatDateTime(approval.requestedAt, approval.requestedAt)}
        {approval.status === 'pending' && approval.pendingExpiresAt && (
          <>; lapses {formatDateTime(approval.pendingExpiresAt, approval.pendingExpiresAt)}</>
        )}
        {approval.status === 'pending' && isSkillPublish(approval) && <>; waits until someone decides</>}
        .
      </p>
      {refs && (refs.project || refs.phase || refs.task) && (
        <p className="approvals-queue-fact">
          About{' '}
          {refs.task && (
            refs.task.title !== null
              ? <Link className="approvals-queue-link" to={`/tasks/${encodeURIComponent(refs.task.id)}`}>{refs.task.title}</Link>
              : <span>a task you cannot read</span>
          )}
          {refs.phase && (<>{refs.task ? ', phase ' : 'phase '}{refs.phase.title ?? 'not visible to you'}</>)}
          {refs.project && (
            refs.project.title !== null
              ? (
                <>
                  {refs.task || refs.phase ? ', in project ' : 'project '}
                  <Link className="approvals-queue-link" to={`/projects/${encodeURIComponent(refs.project.id)}/charter`}>{refs.project.title}</Link>
                </>
              )
              : <>{refs.task || refs.phase ? ', in ' : ''}<span>a project you cannot read</span></>
          )}
          {groups.length > 1 && (
            <span className="approvals-queue-groups-more" title={groups.map((group) => group.name).join(', ')}>
              {' '}+{groups.length - 1} {groups.length - 1 === 1 ? 'group' : 'groups'}
            </span>
          )}
        </p>
      )}
      {approval.deciders && (isVerification(approval) ? (
        <p className="approvals-queue-fact">
          Verified by: {approval.deciders.rule}{' '}
          <span className="approvals-queue-others">Waiting on the verifier</span>
        </p>
      ) : (
        <p className="approvals-queue-fact">
          Decided by: {approval.deciders.rule}{' '}
          {approval.status === 'pending' && (approval.decidable
            ? <span className="approvals-queue-yours">You can decide this</span>
            : <span className="approvals-queue-others">Waiting on someone else</span>)}
        </p>
      ))}
    </div>
  );
}

/**
 * A skill version waiting for review (the hub's read adapter, E44 Q2). It is
 * decided where skill versions are always decided — the Skill's own page, by a
 * person with skills:admin who did not write it — so the hub links there and
 * offers no Approve or Deny of its own.
 */
function SkillPublishDetail({ approval }: { approval: ApprovalItem }) {
  const skill = approval.skill;
  if (!skill) return null;
  return (
    <>
      <h3>Version</h3>
      <p>{skill.name} v{skill.version} <small className="axm-muted">({skill.provenance})</small></p>
      <h3>Description</h3>
      <p>{skill.description}</p>
      <p>
        <Link className="approvals-queue-link" to={`/skills?skill=${encodeURIComponent(skill.id)}`}>
          <BookOpen size={16} aria-hidden="true" /> Open {skill.name} to publish or return it
        </Link>
      </p>
    </>
  );
}

/** Where a verification request stands, in words. */
function verificationStateLine(approval: ApprovalItem): React.ReactNode {
  const verification = approval.verification;
  if (!verification) return null;
  const at = (value: string) => <time dateTime={value}>{formatDateTime(value, value)}</time>;
  if (verification.state === 'pending') {
    return <>Not yet picked up by the verifier. The request lapses {at(verification.requestExpiresAt)} if nobody takes it.</>;
  }
  const holding = verification.state === 'attested' ? 'The verifier has started its review session' : 'The verifier has taken the request';
  return verification.leaseExpiresAt ? <>{holding}; its lease runs until {at(verification.leaseExpiresAt)}.</> : <>{holding}.</>;
}

/**
 * A native verification request waiting on its verifier (card b1e3b16d,
 * review round 2). READ-ONLY: the task's assigned verifier leases it and
 * records the verdict on the task's own routes, so the hub offers no decision
 * of any kind — it shows who verifies, where the request stands, and the task.
 */
function VerificationDetail({ approval }: { approval: ApprovalItem }) {
  const verification = approval.verification;
  if (!verification) return null;
  return (
    <>
      <h3>Verifier</h3>
      <p>
        {verifierLabel(approval)}
        {verification.serviceName && <> through {verification.serviceName}</>}{' '}
        <small className="axm-muted">(descriptor version {verification.descriptorVersion})</small>
      </p>
      <h3>Where it stands</h3>
      <p>{verificationStateLine(approval)}</p>
      <p className="axm-muted">
        Nothing is decided on this page: the verifier records its verdict on the task, and the result appears with
        the task&rsquo;s reviews.
      </p>
      {approval.targetTaskId && (
        <p>
          <Link className="approvals-queue-link" to={`/tasks/${encodeURIComponent(approval.targetTaskId)}`}>
            <ClipboardCheck size={16} aria-hidden="true" /> Open the task under review
          </Link>
        </p>
      )}
    </>
  );
}

/** The approved expiry a date input means: the end of that day (UTC), never
 * later than the requested expiry (clause 8). */
function expiryFromDate(date: string, requestedExpiresAt: string): string | null {
  if (!date) return null;
  const endOfDay = Date.parse(`${date}T23:59:59.000Z`);
  if (Number.isNaN(endOfDay)) return null;
  return new Date(Math.min(endOfDay, Date.parse(requestedExpiresAt))).toISOString();
}

function emptyText(filter: ApprovalsQueueFilter, mount: ApprovalsQueueMount): string {
  if (mount === 'access-manager') return `No ${filter === 'pending' ? 'pending ' : ''}approvals.`;
  if (filter === 'pending') return 'No pending decisions.';
  if (filter === 'decided') return 'No decided approvals.';
  return 'No approvals.';
}

export const ApprovalsQueue: React.FC<ApprovalsQueueProps> = ({
  mount, principalById, deepLinkApprovalId, requestStepUp, surface, statusFilter, onOpenHistory,
  kindFilter = null, groupFilter = null,
}) => {
  const hub = mount === 'hub';
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [ownFilter, setOwnFilter] = useState<'pending' | 'all'>('pending');
  const filter: ApprovalsQueueFilter = hub ? (statusFilter ?? 'pending') : ownFilter;
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(deepLinkApprovalId);
  const [editedScopes, setEditedScopes] = useState<Record<string, string[]>>({});
  const [editedRuleDrops, setEditedRuleDrops] = useState<Record<string, number[]>>({});
  const [editedGrantRules, setEditedGrantRules] = useState<Record<string, GrantRules>>({});
  const [grantSelectorText, setGrantSelectorText] = useState<Record<string, string>>({});
  const [grantExpiryDateTime, setGrantExpiryDateTime] = useState<Record<string, string>>({});
  // A credential request's narrowing (AZ-A9 clause 8): the pin and the date.
  const [editedTransport, setEditedTransport] = useState<Record<string, string>>({});
  const [editedExpiryDate, setEditedExpiryDate] = useState<Record<string, string>>({});
  const [editLifetime, setEditLifetime] = useState<Record<string, '' | 'keep' | 'until-task'>>({});
  const [editRevertAt, setEditRevertAt] = useState<Record<string, string>>({});
  // The revert-date error is announced only after the decider has left the
  // field (or typed a value), never as soon as the field appears.
  const [editRevertTouched, setEditRevertTouched] = useState<Record<string, boolean>>({});
  const [viewer, setViewer] = useState<ApprovalsViewer | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const deepLinkRef = useRef<HTMLLIElement>(null);
  const headingId = hub ? 'approvals-queue-heading' : 'axm-approvals-heading';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The Access manager asks exactly what it always asked; the hub asks the
      // hub view, with its URL's filters.
      const query = hub
        ? hubListQuery(filter, kindFilter, groupFilter)
        : (filter === 'pending' ? '?status=pending' : '');
      const data = await readJson(await authenticatedFetch(`${API_BASE}/approvals${query}`));
      // A body without the list is a failed read, not an empty queue.
      if (!Array.isArray(data.approvals)) throw new Error('Could not load approvals');
      const listed = data.approvals as ApprovalItem[];
      setApprovals(filter === 'decided' ? listed.filter((approval) => approval.status !== 'pending') : listed);
      const standing = data.viewer;
      setViewer(standing && typeof standing.isRoot === 'boolean' && typeof standing.isAdministrator === 'boolean'
        ? { isRoot: standing.isRoot, isAdministrator: standing.isAdministrator } : null);
      setLoadFailed(false);
    } catch (caught) {
      setLoadFailed(true);
      surface('error', caught instanceof Error ? caught.message : 'Could not load approvals');
    } finally {
      setLoading(false);
    }
  }, [filter, surface, hub, kindFilter, groupFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (deepLinkApprovalId && typeof deepLinkRef.current?.scrollIntoView === 'function') {
      deepLinkRef.current.scrollIntoView({ block: 'center' });
    }
  }, [deepLinkApprovalId, approvals.length]);

  const decide = (approval: ApprovalItem, decision: 'approve' | 'deny') => {
    // A grant request writes rows at decide; a credential request is collected
    // later. Both edits are checked before step-up and again by the server.
    const credential = isCredentialRequest(approval);
    const authorityEdit = isAuthorityEdit(approval);
    const grant = isAccessRequest(approval) && !credential;
    const lifetime = authorityEdit
      ? authorityEditLifetime(editLifetime[approval.id] ?? '', approval.accessRequest?.relatedTaskId, editRevertAt[approval.id] ?? '')
      : null;
    if (decision === 'approve' && authorityEdit && (!approval.authorityEdit || !lifetime)) return;
    const requesterName = approval.requesterHandle ?? approval.requesterPrincipalId;
    const keptScopes = editedScopes[approval.id] ?? approval.requestedScopes;
    const pin = editedTransport[approval.id];
    const until = credential ? expiryFromDate(editedExpiryDate[approval.id] ?? '', approval.accessRequest!.requestedExpiresAt) : null;
    const narrowed = credential && (keptScopes.length !== approval.requestedScopes.length
      || (pin !== undefined && pin !== approval.accessRequest!.requestedTransport) || until !== null);
    const grantRules = editedGrantRules[approval.id] ?? approval.requestedRules;
    const grantExpiryInput = grantExpiryDateTime[approval.id] ?? '';
    if (decision === 'approve' && grant && !grantRulesValid(grantRules, approval.accessRequest!.requestedExpiresAt, grantExpiryInput)) return;
    const editedGrantExpiry = decision === 'approve' && grant && grantExpiryInput ? grantExpiry(grantExpiryInput) : null;
    const grantRuleEdit = grant && JSON.stringify(grantRules.filter((rule) => rule !== null)) !== JSON.stringify(approval.requestedRules);
    const grantNarrowed = grantRuleEdit || (editedGrantExpiry !== null
      && Date.parse(editedGrantExpiry) < Date.parse(approval.accessRequest!.requestedExpiresAt));
    requestStepUp({
      action: 'approval.decide',
      targetId: approval.id,
      description: authorityEdit
        ? (decision === 'approve'
          ? `Approve the edit to ${subjectLabel(approval)} with lifetime ${lifetimeWords(lifetime!)}.`
          : `Deny the edit to ${subjectLabel(approval)}.`)
        : credential
        ? (decision === 'approve'
          ? `Approve${narrowed ? ', narrowed,' : ''} the credential request from ${requesterName} for ${keptScopes.join(', ')}. The connector collects the new credential with the same key within 24 hours; the secret is shown to it once.`
          : `Deny the credential request from ${requesterName}.`)
        : grant
        ? (decision === 'approve'
          ? `Approve${grantNarrowed ? ', narrowed,' : ', as requested,'} the grant request from ${requesterName} for Account ${granteeLabel(approval)}.`
          : `Deny the grant request from ${requesterName}.`)
        : decision === 'approve'
          ? `Approve the agent-mint request from ${approval.requesterHandle ?? approval.requesterPrincipalId} for task “${approval.targetTaskTitle ?? approval.targetTaskId}”.`
          : `Deny the agent-mint request from ${approval.requesterHandle ?? approval.requesterPrincipalId}.`,
      onToken: async (stepUpToken) => {
        setBusyId(approval.id);
        try {
          const body: Record<string, unknown> = { stepUpToken };
          if (decision === 'approve' && authorityEdit) {
            body.lifetime = lifetime;
          } else if (decision === 'approve' && credential) {
            // Only what the decider changed is sent, and only ever narrower.
            if (keptScopes.length !== approval.requestedScopes.length) body.editedScopes = keptScopes;
            if (pin !== undefined && pin !== approval.accessRequest!.requestedTransport) body.editedTransport = pin;
            if (until !== null) body.editedExpiresAt = until;
          } else if (decision === 'approve' && grant) {
            if (grantRuleEdit) body.editedRules = grantRules.filter((rule) => rule !== null);
            if (editedGrantExpiry !== null && Date.parse(editedGrantExpiry) < Date.parse(approval.accessRequest!.requestedExpiresAt)) {
              body.editedExpiresAt = editedGrantExpiry;
            }
          } else if (decision === 'approve') {
            const scopesEdit = editedScopes[approval.id];
            if (scopesEdit && scopesEdit.length !== approval.requestedScopes.length) body.editedScopes = scopesEdit;
            const drops = editedRuleDrops[approval.id] ?? [];
            if (drops.length > 0) {
              body.editedRules = approval.requestedRules.filter((_, index) => !drops.includes(index));
            }
          } else if (denyReason.trim()) {
            body.reason = denyReason.trim();
          }
          // Card 7a99d63e (SU-33): if the token no longer counts when the
          // decision arrives (it lives about five minutes, and is single-use),
          // the board answers with the step-up challenge for this very
          // approval; the person confirms once more and the decision is sent
          // ONE more time. Never twice, never for another binding.
          const sent = await sendWithStepUpRetry(
            (token) => authenticatedFetch(`${API_BASE}/approvals/${approval.id}/${decision}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stepUpToken: token }),
            }),
            stepUpToken,
            { action: 'approval.decide', targetId: approval.id },
            (challenge) => new Promise<string | null>((resolve) => requestStepUp({
              action: challenge.action,
              targetId: challenge.targetId,
              description: 'Your confirmation was no longer valid when the decision arrived. Confirm it is you once more to finish this decision.',
              onToken: resolve,
              onCancel: () => resolve(null),
            })),
          );
          const answer = (sent.body ?? {}) as { success?: boolean; message?: string; error?: string };
          if (!sent.response.ok || answer.success === false) {
            throw new Error(answer.message || answer.error || `Request failed (${sent.response.status})`);
          }
          surface('notice', decision === 'approve'
            ? (authorityEdit
              ? 'Approved. The edit is applied now with the chosen lifetime.'
              : credential
              ? 'Approved. The connector collects the new credential with the same key within 24 hours; the secret is shown to it once, and its current credential stays live.'
              : grant
              ? `Approved. The grant rows are written on the Account now and expire at ${formatDateTime(editedGrantExpiry ?? approval.accessRequest!.requestedExpiresAt, editedGrantExpiry ?? approval.accessRequest!.requestedExpiresAt)}.`
              : 'Approved. The requesting connector collects the credential with the same key it requested with; the authorization lapses unused after 24 hours.')
            : 'Denied and recorded in the audit ledger.');
          setDenyReason('');
          await load();
          // The bell and the dashboard notice count the same queue.
          void pendingApprovals.refresh();
        } catch (caught) {
          surface('error', caught instanceof Error ? caught.message : `Could not ${decision} the approval`);
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  /**
   * A change request's decision (card 502fb19e, slice S3): the generic form
   * says what is being decided and what was narrowed; ONE step-up bound to
   * (approval.decide, id), and only the narrowed fields are sent as
   * `editedChange`. The server applies the change in the decide transaction.
   */
  const decideChange = (approval: ApprovalItem, chosen: ChangeDecision) => {
    requestStepUp({
      action: 'approval.decide',
      targetId: approval.id,
      description: chosen.description,
      onToken: async (stepUpToken) => {
        setBusyId(approval.id);
        try {
          const body: Record<string, unknown> = {};
          if (chosen.decision === 'approve' && chosen.editedChange) body.editedChange = chosen.editedChange;
          if (chosen.decision === 'deny' && chosen.denialReason) body.reason = chosen.denialReason;
          const sent = await sendWithStepUpRetry(
            (token) => authenticatedFetch(`${API_BASE}/approvals/${approval.id}/${chosen.decision}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stepUpToken: token }),
            }),
            stepUpToken,
            { action: 'approval.decide', targetId: approval.id },
            (challenge) => new Promise<string | null>((resolve) => requestStepUp({
              action: challenge.action,
              targetId: challenge.targetId,
              description: 'Your confirmation was no longer valid when the decision arrived. Confirm it is you once more to finish this decision.',
              onToken: resolve,
              onCancel: () => resolve(null),
            })),
          );
          const answer = (sent.body ?? {}) as { success?: boolean; message?: string; error?: string; code?: string };
          if (!sent.response.ok || answer.success === false) {
            throw new Error(answer.message || answer.error || `Request failed (${sent.response.status})`);
          }
          surface('notice', chosen.decision === 'approve'
            ? 'Approved. The change is applied now and recorded in the audit ledger.'
            : 'Denied and recorded in the audit ledger.');
          await load();
          void pendingApprovals.refresh();
        } catch (caught) {
          surface('error', caught instanceof Error ? caught.message : `Could not ${chosen.decision} the change request`);
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  const toggleScope = (approval: ApprovalItem, scope: string) => {
    setEditedScopes((current) => {
      const present = current[approval.id] ?? approval.requestedScopes;
      const next = present.includes(scope) ? present.filter((s) => s !== scope) : [...present, scope];
      return { ...current, [approval.id]: next };
    });
  };

  const toggleRule = (approval: ApprovalItem, index: number) => {
    setEditedRuleDrops((current) => {
      const drops = current[approval.id] ?? [];
      const next = drops.includes(index) ? drops.filter((i) => i !== index) : [...drops, index];
      return { ...current, [approval.id]: next };
    });
  };

  const updateGrantRule = (approval: ApprovalItem, index: number, edit: (rule: ProfileRule | null) => ProfileRule | null) => {
    setEditedGrantRules((current) => {
      const rules = [...(current[approval.id] ?? approval.requestedRules)];
      rules[index] = edit(rules[index]);
      return { ...current, [approval.id]: rules };
    });
  };

  /** One item, in either mount: the row, the hub's facts, and the review/decide detail. */
  const renderItem = (approval: ApprovalItem): React.ReactElement => {
    const expanded = expandedId === approval.id;
    const keptScopes = editedScopes[approval.id] ?? approval.requestedScopes;
    const drops = editedRuleDrops[approval.id] ?? [];
    const requester = principalById.get(approval.requesterPrincipalId);
    const grant = isAccessRequest(approval);
    const credential = isCredentialRequest(approval);
    const grantKind = grant && !credential;
    const grantRules = editedGrantRules[approval.id] ?? approval.requestedRules;
    const grantExpiryInput = grantExpiryDateTime[approval.id] ?? '';
    const grantValid = !grantKind || grantRulesValid(grantRules, approval.accessRequest!.requestedExpiresAt, grantExpiryInput);
    const grantNarrowed = grantKind && (JSON.stringify(grantRules.filter((rule) => rule !== null)) !== JSON.stringify(approval.requestedRules)
      || (Boolean(grantExpiryInput) && Date.parse(`${grantExpiryInput}Z`) < Date.parse(approval.accessRequest!.requestedExpiresAt)));
    const authorityEdit = isAuthorityEdit(approval);
    const skillPublish = isSkillPublish(approval);
    const verification = isVerification(approval);
    const changeRequest = isChangeRequest(approval);
    // The hub shows the decide controls only where the server says this
    // session may decide; the Access manager's items carry no flag and
    // keep their controls exactly as before. Where the list says what the
    // viewer may decide (`viewer`, P1-B-2), a grant or credential request
    // offers no controls to a session the decide route refuses.
    // A change request is decided where the server says this session may
    // (the decide route's own ordered predicate, `decidable`), never on a guess.
    const mayDecide = changeRequest
      ? approval.status === 'pending' && approval.decidable === true
      : approval.status === 'pending' && approval.decidable !== false && viewerMayDecide(viewer, approval);
    const credentialNarrowed = credential && (keptScopes.length !== approval.requestedScopes.length
      || (editedTransport[approval.id] !== undefined && editedTransport[approval.id] !== approval.accessRequest!.requestedTransport)
      || Boolean(editedExpiryDate[approval.id]));
    return (
      <li key={approval.id} ref={approval.id === deepLinkApprovalId ? deepLinkRef : undefined}
          className={`axm-item ${approval.id === deepLinkApprovalId ? 'axm-item--linked' : ''}`}>
        <div className="axm-item-row">
          <span className={`axm-status axm-status--${approval.status}`}>{approval.status}</span>
          {(hub || grant || authorityEdit || changeRequest) && <span className="approvals-queue-kind">{authorityEdit ? approval.authorityEdit?.objectKindLabel ?? 'Authority edit' : approvalKindLabel(approvalKind(approval))}</span>}
          <span className="axm-item-title">
            <strong>{approval.requesterHandle ?? principalLabel(requester)}</strong>
            <small>{askLine(approval)}</small>
          </span>
          <span className="axm-item-meta">{formatDateTime(approval.requestedAt, approval.requestedAt)}</span>
          {hub && onOpenHistory && !skillPublish && !verification && (
            <Button
              variant="secondary" size="compact" icon={<History size={16} />}
              ariaLabel={`History: ${approval.requesterHandle ?? principalLabel(requester)}, ${subjectLabel(approval)}`}
              onClick={(event) => onOpenHistory(approval, event.currentTarget)}
            >
              History
            </Button>
          )}
          <Button
            variant="secondary" size="compact"
            ariaExpanded={expanded}
            onClick={() => setExpandedId(expanded ? null : approval.id)}
          >
            {expanded ? 'Hide' : 'Review'}
          </Button>
        </div>
        {hub && <HubFacts approval={approval} />}
        {expanded && skillPublish && (
          <div className="axm-item-detail">
            <SkillPublishDetail approval={approval} />
          </div>
        )}
        {expanded && verification && (
          <div className="axm-item-detail">
            <VerificationDetail approval={approval} />
          </div>
        )}
        {expanded && changeRequest && (
          <div className="axm-item-detail">
            <ChangeRequestDetail
              approval={approval}
              mayDecide={mayDecide}
              busy={busyId !== null}
              labelOf={(value) => {
                const principal = principalById.get(value);
                return principal ? principalLabel(principal) : value;
              }}
              onDecide={(chosen) => decideChange(approval, chosen)}
            />
          </div>
        )}
        {expanded && credential && (
          <div className="axm-item-detail">
            <CredentialRequestDetail
              approval={approval}
              editable={mayDecide}
              narrowing={{
                keptScopes,
                transport: editedTransport[approval.id] ?? approval.accessRequest!.requestedTransport ?? 'any',
                expiryDate: editedExpiryDate[approval.id] ?? '',
                onToggleScope: (scope) => toggleScope(approval, scope),
                onTransport: (pin) => setEditedTransport((current) => ({ ...current, [approval.id]: pin })),
                onExpiryDate: (date) => setEditedExpiryDate((current) => ({ ...current, [approval.id]: date })),
              }}
            />
            {approval.lapseReason && <p className="axm-muted">Lapsed: {approval.lapseReason}</p>}
            {approval.denialReason && <p className="axm-muted">Denied: {approval.denialReason}</p>}
            {approval.status === 'pending' && !mayDecide && (
              <p className="axm-muted">Only root or an administrator decides a credential request.</p>
            )}
            {mayDecide && (
              <div className="axm-decide">
                <div className="form-group axm-deny-reason">
                  <label htmlFor={`deny-reason-${approval.id}`}>Denial reason <span className="axm-muted">optional</span></label>
                  <input
                    id={`deny-reason-${approval.id}`}
                    className="form-input"
                    type="text"
                    value={denyReason}
                    onChange={(event) => setDenyReason(event.target.value)}
                  />
                </div>
                <div className="axm-decide-actions">
                  <Button
                    variant="danger" size="compact" icon={<XCircle size={16} />}
                    disabled={busyId !== null}
                    onClick={() => decide(approval, 'deny')}
                  >
                    {busyId === approval.id ? 'Working…' : 'Deny'}
                  </Button>
                  <Button
                    variant="success" size="compact" icon={<BadgeCheck size={16} />}
                    disabled={busyId !== null || keptScopes.length === 0}
                    onClick={() => decide(approval, 'approve')}
                  >
                    {busyId === approval.id ? 'Working…' : (credentialNarrowed ? 'Approve narrowed' : 'Approve')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {expanded && grantKind && (
          <div className="axm-item-detail">
            <AccessRequestDetail approval={approval} editable={mayDecide} rules={grantRules} expiry={grantExpiryInput}
              selectorText={grantSelectorText}
              onRow={(index) => updateGrantRule(approval, index, (rule) => rule ? null : { ...approval.requestedRules[index], selectorIds: [...approval.requestedRules[index].selectorIds], verbs: [...approval.requestedRules[index].verbs] })}
              onVerb={(index, verb) => updateGrantRule(approval, index, (rule) => rule && ({
                ...rule,
                verbs: approval.requestedRules[index].verbs.filter((value) => value === verb ? !rule.verbs.includes(value) : rule.verbs.includes(value)),
              }))}
              onObject={(index, id) => updateGrantRule(approval, index, (rule) => rule && ({
                ...rule,
                selectorIds: approval.requestedRules[index].selectorIds.filter((value) => value === id ? !rule.selectorIds.includes(value) : rule.selectorIds.includes(value)),
              }))}
              onForm={(index, form) => updateGrantRule(approval, index, (rule) => rule && ({ ...rule, selectorForm: form, selectorIds: form === 'exact' ? (grantSelectorText[`${approval.id}:${index}`] ?? '').split(/[\s,;]+/).filter(Boolean) : [] }))}
              onSelector={(index, value) => {
                setGrantSelectorText((current) => ({ ...current, [`${approval.id}:${index}`]: value }));
                updateGrantRule(approval, index, (rule) => rule && ({ ...rule, selectorIds: value.split(/[\s,;]+/).filter(Boolean) }));
              }}
              onExpiry={(value) => setGrantExpiryDateTime((current) => ({ ...current, [approval.id]: value }))} />
            {approval.lapseReason && <p className="axm-muted">Lapsed: {approval.lapseReason}</p>}
            {approval.denialReason && <p className="axm-muted">Denied: {approval.denialReason}</p>}
            {approval.status === 'pending' && !mayDecide && (
              <p className="axm-muted">Only root or an administrator decides a grant request.</p>
            )}
            {mayDecide && (
              <div className="axm-decide">
                <div className="form-group axm-deny-reason">
                  <label htmlFor={`deny-reason-${approval.id}`}>Denial reason <span className="axm-muted">optional</span></label>
                  <input
                    id={`deny-reason-${approval.id}`}
                    className="form-input"
                    type="text"
                    value={denyReason}
                    onChange={(event) => setDenyReason(event.target.value)}
                  />
                </div>
                <div className="axm-decide-actions">
                  <Button
                    variant="danger" size="compact" icon={<XCircle size={16} />}
                    disabled={busyId !== null}
                    onClick={() => decide(approval, 'deny')}
                  >
                    {busyId === approval.id ? 'Working…' : 'Deny'}
                  </Button>
                  <Button
                    variant="success" size="compact" icon={<BadgeCheck size={16} />}
                    disabled={busyId !== null || !grantValid}
                    onClick={() => decide(approval, 'approve')}
                  >
                    {busyId === approval.id ? 'Working…' : grantNarrowed ? 'Approve narrowed' : 'Approve as requested'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {expanded && authorityEdit && (
          <div className="axm-item-detail">
            <AuthorityEditDetail approval={approval} />
            {approval.lapseReason && <p className="axm-muted">Lapsed: {approval.lapseReason}</p>}
            {approval.denialReason && <p className="axm-muted">Denied: {approval.denialReason}</p>}
            {mayDecide && approval.authorityEdit && (
              <div className="axm-decide">
                <div className="form-group">
                  <label htmlFor={`edit-lifetime-${approval.id}`}>Lifetime for this edit</label>
                  <Select id={`edit-lifetime-${approval.id}`} value={editLifetime[approval.id] ?? ''}
                    onChange={(event) => setEditLifetime((current) => ({ ...current, [approval.id]: event.target.value as 'keep' | 'until-task' }))}>
                    <option value="">Choose a lifetime</option>
                    <option value="until-task">{approval.accessRequest?.relatedTaskId ? 'Until this task ends, or a date' : 'Until a date'}</option>
                    <option value="keep">Keep (until narrowed)</option>
                  </Select>
                </div>
                {editLifetime[approval.id] === 'until-task' && (() => {
                  const revertInput = editRevertAt[approval.id] ?? '';
                  const chosen = authorityEditLifetime('until-task', approval.accessRequest?.relatedTaskId, revertInput);
                  const showError = !chosen && (Boolean(revertInput) || Boolean(editRevertTouched[approval.id]));
                  const hintId = `edit-revert-hint-${approval.id}`;
                  const errorId = `edit-revert-error-${approval.id}`;
                  return (
                    <div className="form-group">
                      <label htmlFor={`edit-revert-at-${approval.id}`}>
                        Revert at (UTC){' '}
                        <span className="axm-muted">{approval.accessRequest?.relatedTaskId ? 'optional; whichever comes first' : 'required'}</span>
                      </label>
                      <input id={`edit-revert-at-${approval.id}`} className="form-input" type="datetime-local"
                        value={revertInput}
                        aria-describedby={chosen ? hintId : showError ? errorId : undefined}
                        aria-invalid={showError ? true : undefined}
                        onBlur={() => setEditRevertTouched((current) => ({ ...current, [approval.id]: true }))}
                        onChange={(event) => setEditRevertAt((current) => ({ ...current, [approval.id]: event.target.value }))} />
                      {chosen
                        ? <p className="axm-muted" id={hintId}>The added authority is removed {revertHintWords(chosen)}.</p>
                        : showError && <p role="alert" id={errorId}>{revertInput ? 'The revert date must be in the future.' : 'Set the date the added authority is removed.'}</p>}
                    </div>
                  );
                })()}
                <div className="form-group axm-deny-reason">
                  <label htmlFor={`deny-reason-${approval.id}`}>Denial reason <span className="axm-muted">optional</span></label>
                  <input id={`deny-reason-${approval.id}`} className="form-input" type="text"
                    value={denyReason} onChange={(event) => setDenyReason(event.target.value)} />
                </div>
                <div className="axm-decide-actions">
                  <Button variant="danger" size="compact" icon={<XCircle size={16} />}
                    disabled={busyId !== null} onClick={() => decide(approval, 'deny')}>Deny</Button>
                  <Button variant="success" size="compact" icon={<BadgeCheck size={16} />}
                    disabled={busyId !== null || !authorityEditLifetime(editLifetime[approval.id] ?? '', approval.accessRequest?.relatedTaskId, editRevertAt[approval.id] ?? '')}
                    onClick={() => decide(approval, 'approve')}>Approve</Button>
                </div>
              </div>
            )}
          </div>
        )}
        {expanded && !grant && !authorityEdit && !skillPublish && !verification && !changeRequest && (
          <div className="axm-item-detail">
            <h3>Requested scopes {approval.status === 'pending' && <small>(untick to narrow before approving)</small>}</h3>
            <div className="axm-chipset">
              {approval.requestedScopes.map((scope) => (
                approval.status === 'pending' ? (
                  <label key={scope} className={`axm-scope ${keptScopes.includes(scope) ? '' : 'axm-scope--dropped'}`}>
                    <input
                      type="checkbox"
                      checked={keptScopes.includes(scope)}
                      onChange={() => toggleScope(approval, scope)}
                    /> {scope}
                  </label>
                ) : <span key={scope} className="axm-scope">{scope}</span>
              ))}
            </div>
            <h3>Requested object rules</h3>
            {/* Card c334177b: an Agent approved with NO object rule reads
                as read+write on its bound task (and nothing else), so
                the approver is told what "none" grants and which
                switch withholds it - also when they untick every rule. */}
            {approval.requestedRules.length === 0 ? (
              <p className="axm-muted">
                None. With tasks:write the agent can claim, move, report on and finish its bound task — that
                task only, and never beyond what the requesting connector may do there. Untick tasks:write to
                withhold it.
              </p>
            ) : (
              <>
                <div className="axm-chipset">
                  {approval.requestedRules.map((rule, index) => (
                    approval.status === 'pending' ? (
                      <label key={index} className={`axm-scope ${drops.includes(index) ? 'axm-scope--dropped' : ''}`}>
                        <input
                          type="checkbox"
                          checked={!drops.includes(index)}
                          onChange={() => toggleRule(approval, index)}
                        /> {ruleSummary(rule)}
                      </label>
                    ) : <span key={index} className="axm-scope">{ruleSummary(rule)}</span>
                  ))}
                </div>
                {approval.status === 'pending' && drops.length === approval.requestedRules.length && (
                  <p className="axm-muted">
                    Every rule unticked: approved with none, the agent can still claim, move, report on and
                    finish its bound task with tasks:write, and nothing else. Untick tasks:write to withhold that
                    too.
                  </p>
                )}
              </>
            )}
            {approval.lapseReason && <p className="axm-muted">Lapsed: {approval.lapseReason}</p>}
            {approval.denialReason && <p className="axm-muted">Denied: {approval.denialReason}</p>}
            {mayDecide && (
              <div className="axm-decide">
                <div className="form-group axm-deny-reason">
                  <label htmlFor={`deny-reason-${approval.id}`}>Denial reason <span className="axm-muted">optional</span></label>
                  <input
                    id={`deny-reason-${approval.id}`}
                    className="form-input"
                    type="text"
                    value={denyReason}
                    onChange={(event) => setDenyReason(event.target.value)}
                  />
                </div>
                <div className="axm-decide-actions">
                  <Button
                    variant="danger" size="compact" icon={<XCircle size={16} />}
                    disabled={busyId !== null}
                    onClick={() => decide(approval, 'deny')}
                  >
                    {busyId === approval.id ? 'Working…' : 'Deny'}
                  </Button>
                  <Button
                    variant="success" size="compact" icon={<BadgeCheck size={16} />}
                    disabled={busyId !== null || keptScopes.length === 0}
                    onClick={() => decide(approval, 'approve')}
                  >
                    {busyId === approval.id ? 'Working…' : (keptScopes.length !== approval.requestedScopes.length || drops.length > 0 ? 'Approve narrowed' : 'Approve')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="axm-section" aria-labelledby={headingId}>
      <div className="axm-section-head">
        <h2 id={headingId}><Inbox aria-hidden="true" /> {hub ? 'Requests' : 'Pending approvals'}</h2>
        <div className="axm-section-tools">
          {!hub && (
            <label className="axm-filter">
              Show
              <Select value={ownFilter} onChange={(event) => setOwnFilter(event.target.value as 'pending' | 'all')}>
                <option value="pending">pending only</option>
                <option value="all">every state</option>
              </Select>
            </label>
          )}
          <Button variant="secondary" size="compact" icon={<RefreshCw size={16} />} onClick={() => load()} ariaLabel="Refresh approvals">Refresh</Button>
        </div>
      </div>
      <p className="axm-section-intro">
        A connector&rsquo;s agent-mint request becomes a pending item here. The decision happens only on this
        authenticated surface after step-up — the notification deep link carries no authority. You may edit
        the requested authority <em>down</em> before approving; the approval is a single-use authorization the
        requesting credential collects within 24 hours.
        Root and administrators decide every request here; an Account also decides its own connectors&rsquo;
        agent-mint requests. Approving an agent&rsquo;s grant request writes the requested grant rows on the
        requester&rsquo;s Account, which expire at the stated time. Approving a connector&rsquo;s credential
        request lets that connector collect one new credential with the approved scopes, once, within 24 hours;
        its current credential stays live.
      </p>
      {!hub && (
        <p className="approvals-queue-hub-link">
          <Link to={deepLinkApprovalId ? `/approvals?approval=${encodeURIComponent(deepLinkApprovalId)}` : '/approvals'}>
            Open in approvals hub
          </Link>
        </p>
      )}
      {loading ? (
        <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Loading approvals…</div>
      ) : loadFailed ? (
        // Never "No pending approvals." for a list that was not read.
        <div className="approvals-queue-failed" role="alert">
          <span>Couldn&rsquo;t load approvals.</span>
          <Button variant="secondary" size="compact" onClick={() => load()}>Retry</Button>
        </div>
      ) : approvals.length === 0 ? (
        <div className="axm-empty">{emptyText(filter, mount)}</div>
      ) : hub ? (
        groupHubItems(approvals).map((section: HubSection<ApprovalItem>) => (
          <section key={section.key} className="approvals-queue-section" aria-labelledby={`approvals-section-${section.key}`}>
            <h3 id={`approvals-section-${section.key}`} className="approvals-queue-section-heading">
              {section.title} <span className="axm-muted">({section.items.length})</span>
            </h3>
            <ul className="axm-list">{section.items.map(renderItem)}</ul>
          </section>
        ))
      ) : (
        <ul className="axm-list">{approvals.map(renderItem)}</ul>
      )}
    </section>
  );
};
