import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, KeyRound, Loader2, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { StepUpDialog } from '../components/access/StepUpDialog';
import { GrantCleanup } from '../components/access/GrantCleanup';
import { useStepUpRetry } from '../components/access/useStepUpRetry';
import { sendWithStepUpRetry } from '../utils/stepUpChallenge';
import { Button } from '../components/Button';
import { useMyPrincipal, usePrincipals } from '../hooks/usePrincipals';
import type { Principal } from '../types/task';
import { authenticatedFetch } from '../utils/auth';
import './GrantsPage.css';
import { formatDateTime, formatInstantForDateTimeLocal } from '../utils/dateFormat';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const RESOURCE_TYPES = ['task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'plugin'] as const;
const VERBS = ['read', 'write', 'use', 'invoke', 'admin'] as const;

type ResourceType = typeof RESOURCE_TYPES[number];
type GrantVerb = typeof VERBS[number];

/** The identity a grant is held by, RESOLVED BY THE SERVER on the row.
 *
 * Card f03d459e: this page used to name a grantee by looking its id up in the
 * principals listing, and that listing legitimately excludes hidden
 * compatibility identities — so a fresh install's one seeded grant rendered as
 * "Unknown principal", on the governance surface whose only affordance is
 * "Revoke". A page cannot evaluate what it cannot name. */
interface GrantIdentitySummary {
  id: string;
  handle: string;
  displayName: string | null;
  kind: string;
  status: string;
  /** A seeded compatibility identity, dormant until an integration configures
   * it (migration 065). */
  compatibility: boolean;
}

/** Card ff410dc4 (owner ruling E407 item 1): how a row came to exist, as the
 * SERVER derived it from data the board keeps (the grants columns and the
 * audit ledger; docs/grants.md "Where a grant came from"). Never guessed here:
 * a row without it reads as unknown. */
type MadeClass = 'hand' | 'system' | 'unknown';
interface GrantMadeBy {
  class: MadeClass;
  via: string | null;
  evidence: 'column' | 'audit' | 'none';
}

interface GrantTargetView {
  label: string | null;
  status: string | null;
  state: 'live' | 'archived' | 'missing' | 'wildcard' | 'unchecked';
}

interface GrantRecord {
  id: string;
  granteeType: 'principal' | 'group';
  granteeId: string;
  resourceType: ResourceType;
  resourceId: string | null;
  verb: GrantVerb;
  grantedByPrincipalId: string | null;
  expiresAt: string | null;
  createdAt: string;
  grantee: GrantIdentitySummary | null;
  grantedBy: GrantIdentitySummary | null;
  madeBy?: GrantMadeBy;
  target?: GrantTargetView;
  granteeGroup?: { id: string; name: string | null };
}

/** The list's server-side query (GET /grants; every parameter additive). */
interface ListQuery {
  made: MadeClass | 'all';
  resourceType: '' | ResourceType;
  verb: '' | GrantVerb;
  expiry: 'any' | 'none' | 'live' | 'expired' | 'expiring';
  target: 'any' | 'live' | 'archived' | 'missing' | 'wildcard';
  sort: string;
  q: string;
}

const PAGE_SIZE = 50;
/** The default view is hand-made grants only (E407 item 1). */
const DEFAULT_QUERY: ListQuery = { made: 'hand', resourceType: '', verb: '', expiry: 'any', target: 'any', sort: '-created', q: '' };

const MADE_OPTIONS: Array<[ListQuery['made'], string]> = [
  ['hand', 'Hand-made'], ['system', 'System-made'], ['unknown', 'Unknown origin'], ['all', 'All origins'],
];
const EXPIRY_OPTIONS: Array<[ListQuery['expiry'], string]> = [
  ['any', 'Any expiry'], ['none', 'No expiry'], ['live', 'Not expired'], ['expiring', 'Expiring within 14 days'], ['expired', 'Expired'],
];
const TARGET_OPTIONS: Array<[ListQuery['target'], string]> = [
  ['any', 'Any resource state'], ['live', 'Live resource'], ['archived', 'Archived resource'],
  ['missing', 'Resource not found'], ['wildcard', 'Every resource of a type'],
];
const SORT_OPTIONS: Array<[string, string]> = [
  ['-created', 'Newest first'], ['created', 'Oldest first'], ['grantee', 'Identity A to Z'], ['-grantee', 'Identity Z to A'],
  ['resource', 'Resource A to Z'], ['-resource', 'Resource Z to A'], ['verb', 'Permission'], ['expires', 'Expiry, soonest first'],
  ['-expires', 'Expiry, latest first'],
];

/** What each derivation says about a row, in words an operator can act on. */
const MADE_VIA_LABELS: Record<string, string> = {
  direct: 'Access page, CLI or API',
  approval: 'approved request',
  'task-creator': 'Task creator access',
  'task-sponsor': 'Task sponsor access',
  'report-creator': 'Report creator access',
  'report-sponsor': 'Report sponsor access',
  'project-creator': 'Project creator access',
  'project-default': 'Project creation default',
  steward: 'Group steward',
  assignment: 'assignment access',
  warrant: 'Warrant access',
  automatic: 'written automatically',
};
const MADE_CLASS_LABELS: Record<MadeClass, string> = { hand: 'Hand-made', system: 'System-made', unknown: 'Unknown origin' };
/* An enumerated class per origin, never one built by interpolation. */
const MADE_CLASS_STYLE: Record<MadeClass, string> = {
  hand: 'grants-origin grants-origin--hand', system: 'grants-origin grants-origin--system', unknown: 'grants-origin grants-origin--unknown',
};

function listUrl(query: ListQuery, cursor: string | null, limit: number = PAGE_SIZE): string {
  const params = new URLSearchParams({ limit: String(limit), sort: query.sort, made: query.made });
  if (query.resourceType) params.set('resourceType', query.resourceType);
  if (query.verb) params.set('verb', query.verb);
  if (query.expiry !== 'any') params.set('expiry', query.expiry);
  if (query.target !== 'any') params.set('target', query.target);
  if (query.q.trim()) params.set('q', query.q.trim());
  if (cursor) params.set('cursor', cursor);
  return `${API_BASE}/grants?${params.toString()}`;
}

/**
 * Whether a grant this page just created can be placed at the top of the
 * current list without asking the server: it must match every filter the
 * client can judge (origin, type, permission, expiry, resource state), the
 * list must be newest first, nothing may be searched, and the grant must be a
 * type-wide one, whose row needs no resource title. Anything else is answered
 * by reading the first page again, so the row, its title and the per-origin
 * counts all come from the server.
 */
function placesLocally(grant: GrantRecord, query: ListQuery, now = Date.now()): boolean {
  if (query.sort !== '-created' || query.q.trim() || grant.resourceId !== null) return false;
  if (query.made !== 'all' && query.made !== 'hand') return false;
  if (query.resourceType && query.resourceType !== grant.resourceType) return false;
  if (query.verb && query.verb !== grant.verb) return false;
  if (query.target !== 'any' && query.target !== 'wildcard') return false;
  const expires = grant.expiresAt ? Date.parse(grant.expiresAt) : null;
  switch (query.expiry) {
    case 'none': return expires === null;
    case 'live': return expires === null || expires > now;
    case 'expired': return expires !== null && expires <= now;
    case 'expiring': return expires !== null && expires > now && expires <= now + 14 * 86400000;
    default: return true;
  }
}

function identityName(identity: GrantIdentitySummary | null): string | null {
  if (!identity) return null;
  return identity.displayName ? `${identity.displayName} (${identity.handle})` : identity.handle;
}

/** The origin cell: class, then how and by whom, from the server's fields. */
function originView(grant: GrantRecord): { label: string; detail: string; cls: MadeClass } {
  const made = grant.madeBy;
  const cls: MadeClass = made?.class ?? 'unknown';
  const writer = identityName(grant.grantedBy);
  const how = made?.via ? MADE_VIA_LABELS[made.via] ?? made.via : null;
  const parts: string[] = [];
  if (how) parts.push(how);
  if (cls === 'unknown') parts.push('no creation record');
  parts.push(writer ? `by ${writer}` : 'writer not recorded');
  return { label: MADE_CLASS_LABELS[cls], detail: parts.join(' · '), cls };
}

function targetNote(grant: GrantRecord): string | null {
  switch (grant.target?.state) {
    case 'archived': return 'archived';
    case 'missing': return 'not found';
    default: return null;
  }
}

interface GrantDraft {
  granteeId: string;
  resourceType: ResourceType;
  resourceId: string;
  verb: GrantVerb;
  expiresAt: string;
}

const emptyDraft = (): GrantDraft => ({
  granteeId: '', resourceType: 'project', resourceId: '', verb: 'read', expiresAt: '',
});

function principalLabel(principal?: Principal): string {
  if (!principal) return 'Unknown principal';
  return principal.displayName ? `${principal.displayName} (${principal.handle})` : principal.handle;
}

/** The grantee, from the row itself. The directory listing is not consulted:
 * it is allowed not to contain this identity, and that is the whole defect
 * (card f03d459e). A row whose grantee has genuinely been deleted still says
 * so about a specific id rather than about a name it failed to find. */
function granteeLabel(grant: GrantRecord): string {
  // A Group grantee is named from the groups table by the list read.
  if (grant.granteeType === 'group') return grant.granteeGroup?.name ? `Group ${grant.granteeGroup.name}` : `Deleted group (${grant.granteeId})`;
  if (!grant.grantee) return `Deleted identity (${grant.granteeId})`;
  const { displayName, handle } = grant.grantee;
  return displayName ? `${displayName} (${handle})` : handle;
}

/** What KIND of holder this is, in one line the operator can act on. */
function granteeNote(grant: GrantRecord): string {
  if (grant.granteeType === 'group') return 'group · reaches its active members';
  if (!grant.grantee) return grant.granteeType;
  const parts = [grant.grantee.kind];
  if (grant.grantee.compatibility) {
    parts.push('built-in compatibility identity');
    if (grant.grantee.status !== 'active') parts.push('dormant until configured');
  } else if (grant.grantee.status !== 'active') {
    parts.push(grant.grantee.status);
  }
  return parts.join(' · ');
}

function expiryLabel(value: string | null): string {
  if (!value) return 'No expiry';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const label = formatDateTime(date);
  return date.getTime() <= Date.now() ? `Expired ${label}` : label;
}

/** Card 21787b03: what the form says after a create. It names exactly what
 * the server created (permission, resource type, the one resource or the
 * wildcard, expiry) and the identity as the form showed it, and says the
 * form kept those values. The identity is passed in from the directory row
 * the person picked; the appended table row uses the identity summaries
 * returned by the server, just like a row loaded by the list endpoint. */
function createdGrantNotice(created: GrantRecord, identity: string): string {
  const selector = created.resourceId ?? 'every resource of this type';
  const expiry = created.expiresAt ? `expires ${expiryLabel(created.expiresAt)}` : 'no expiry';
  return `Access grant created and recorded in the audit log: ${created.verb} · ${created.resourceType} · ${selector} · ${expiry}, for ${identity}. The form keeps these values for the next grant; change only what differs.`;
}

export const GrantsPage: React.FC = () => {
  const { me, scopes, loading: authorityLoading } = useMyPrincipal();
  const { principals, loading: principalsLoading, failed: principalsFailed, reload: reloadPrincipals } = usePrincipals();
  const [grants, setGrants] = useState<GrantRecord[]>([]);
  const [draft, setDraft] = useState<GrantDraft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<GrantRecord | null>(null);
  const [editDraft, setEditDraft] = useState({ verb: 'read' as GrantVerb, resourceId: '', expiresAt: '' });
  const [editLifetime, setEditLifetime] = useState<'' | 'keep' | 'until-task'>('');
  const [editTask, setEditTask] = useState('');
  const [editRevertAt, setEditRevertAt] = useState('');
  const [editStepUp, setEditStepUp] = useState<((token: string) => void) | null>(null);
  // Owner ruling E418(b): a revoke takes a step-up bound to (grant.revoke, id).
  const [revokeStepUp, setRevokeStepUp] = useState<GrantRecord | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const { askForToken, retryDialog } = useStepUpRetry();
  // Card ff410dc4 (E407 item 1): the list is read one SERVER page at a time;
  // filters, sort and search are query parameters, never a filter over rows
  // already loaded.
  const [query, setQuery] = useState<ListQuery>(DEFAULT_QUERY);
  const [searchDraft, setSearchDraft] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [madeCounts, setMadeCounts] = useState<Record<MadeClass, number> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Only the newest request may write the list: a slower earlier answer
  // (a filter the person already changed) is dropped.
  const requestSeq = useRef(0);

  const canManage = Array.isArray(scopes)
    ? scopes.includes('root')
    : me?.role === 'admin' || me?.role === 'orchestrator';

  const activePrincipals = useMemo(
    () => principals.filter(principal => principal.status === 'active').sort((a, b) => principalLabel(a).localeCompare(principalLabel(b))),
    [principals],
  );

  useEffect(() => {
    if (!draft.granteeId && activePrincipals.length > 0) {
      setDraft(current => ({ ...current, granteeId: activePrincipals[0].id }));
    }
  }, [activePrincipals, draft.granteeId]);

  /** Reads the FIRST page for `current` (replacing the list), or the page
   * after `cursor` (appending to it). */
  const fetchPage = useCallback(async (current: ListQuery, cursor: string | null) => {
    const seq = ++requestSeq.current;
    setError(null);
    if (cursor) setLoadingMore(true); else setLoading(true);
    try {
      const response = await authenticatedFetch(listUrl(current, cursor));
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || data.error || 'Could not load access grants');
      if (seq !== requestSeq.current) return;
      const rows: GrantRecord[] = Array.isArray(data.grants) ? data.grants : [];
      setGrants(existing => (cursor ? [...existing, ...rows.filter(row => !existing.some(have => have.id === row.id))] : rows));
      setNextCursor(data.pagination?.nextCursor ?? null);
      setTotal(typeof data.pagination?.total === 'number' ? data.pagination.total : (cursor ? null : rows.length));
      if (!cursor) setMadeCounts(data.madeCounts ?? null);
    } catch (caught) {
      if (seq === requestSeq.current) setError(caught instanceof Error ? caught.message : 'Could not load access grants');
    } finally {
      if (seq === requestSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, []);

  const loadGrants = useCallback(() => fetchPage(query, null), [fetchPage, query]);

  useEffect(() => {
    if (!authorityLoading && canManage) void fetchPage(query, null);
    else if (!authorityLoading) setLoading(false);
  }, [authorityLoading, canManage, fetchPage, query]);

  // The search applies when typing pauses, as one server read.
  useEffect(() => {
    if (searchDraft === query.q) return undefined;
    const timer = window.setTimeout(() => setQuery(current => ({ ...current, q: searchDraft })), 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft, query.q]);

  const setFilter = <K extends keyof ListQuery>(key: K, value: ListQuery[K]) => setQuery(current => ({ ...current, [key]: value }));

  const createGrant = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !draft.granteeId) return;
    const identity = principalLabel(activePrincipals.find(principal => principal.id === draft.granteeId));
    // Card 21787b03: a blank resource ID is the type-wide wildcard, the grant
    // the owner made by accident. Ask first, as revocation does.
    if (!draft.resourceId.trim() && !window.confirm(`Grant ${draft.verb} access to every ${draft.resourceType} for ${identity}? Specific resource ID is blank, so this grant covers every resource of this type, not one.`)) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const body: Record<string, string> = {
        granteeType: 'principal',
        granteeId: draft.granteeId,
        resourceType: draft.resourceType,
        verb: draft.verb,
      };
      if (draft.resourceId.trim()) body.resourceId = draft.resourceId.trim();
      if (draft.expiresAt) body.expiresAt = new Date(draft.expiresAt).toISOString();
      const response = await authenticatedFetch(`${API_BASE}/grants`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || data.error || 'Could not create the grant');
      // A grant this form made is hand-made by definition: POST /grants
      // writes its grant.create audit row and no system marker, which is
      // exactly what the list derives for it on the next read.
      const created: GrantRecord = { madeBy: { class: 'hand', via: 'direct', evidence: 'audit' }, ...(data.grant as GrantRecord) };
      if (placesLocally(created, query)) {
        const placed: GrantRecord = { target: { label: null, status: null, state: 'wildcard' }, ...created };
        setGrants(current => [placed, ...current.filter(row => row.id !== placed.id)]);
        setTotal(current => (current === null ? current : current + 1));
        setMadeCounts(current => (current ? { ...current, hand: current.hand + 1 } : current));
      } else {
        void fetchPage(query, null);
      }
      // Card 21787b03: the draft is deliberately kept. Resetting it here put
      // Resource type back to `project` and Permission back to `read`, and
      // cleared the resource ID and the expiry, so a second grant in a row
      // went out as a `project` wildcard with no expiry. Kept, the next grant
      // differs only in what the person changes, and resubmitting the same
      // grant is refused by the server as a duplicate (409 GRANT_EXISTS).
      setNotice(createdGrantNotice(created, identity));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the grant');
    } finally {
      setSaving(false);
    }
  };

  const originalEditExpiry = formatInstantForDateTimeLocal(editing?.expiresAt ?? '').slice(0, 16);
  const editedExpiry = editing && editDraft.expiresAt === originalEditExpiry ? editing.expiresAt : editDraft.expiresAt ? new Date(editDraft.expiresAt).toISOString() : null;
  // Mirrors AZ-A13 clause 3 and grantAllows: use/invoke are incomparable.
  const verbActions = { read: ['read'], write: ['read', 'write', 'claim', 'finish', 'release'], use: ['use'], invoke: ['invoke'], admin: ['read', 'write', 'claim', 'finish', 'release', 'use', 'invoke', 'admin'] };
  const editWidens = editing !== null && (
    verbActions[editDraft.verb].some(action => !verbActions[editing.verb].includes(action))
    || (editing.resourceId !== null && editing.resourceId.toLowerCase() !== (editDraft.resourceId.trim().toLowerCase() || null))
    || (editing.expiresAt !== null && (editedExpiry === null || Date.parse(editedExpiry) > Date.parse(editing.expiresAt)))
  );
  const saveEdit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || saving) return;
    if (editWidens && (!editLifetime || (editLifetime === 'until-task' && !editTask.trim() && !editRevertAt))) return;
    const target = editing;
    const body: Record<string, unknown> = { verb: editDraft.verb, resourceId: editDraft.resourceId.trim() || null, expiresAt: editedExpiry };
    if (editWidens) body.lifetime = editLifetime === 'keep' ? { choice: 'keep' } : { choice: 'until-task', ...(editTask.trim() ? { taskId: editTask.trim() } : {}), ...(editRevertAt ? { revertAt: new Date(editRevertAt).toISOString() } : {}) };
    const apply = async (stepUpToken?: string) => {
      setSaving(true); setError(null); setNotice(null); setEditStepUp(null);
      try {
        const send = (token: string | undefined) => authenticatedFetch(`${API_BASE}/grants/${target.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...(token ? { stepUpToken: token } : {}) }) });
        // Card 72b8fb97 (SU-33): a widening whose token no longer counts is
        // answered with the step-up challenge for this grant; the person
        // confirms once more and the SAME edit is sent ONE more time.
        const sent = stepUpToken
          ? await sendWithStepUpRetry(send, stepUpToken, { action: 'grant.edit', targetId: target.id }, askForToken)
          : await (async () => { const response = await send(undefined); return { response, body: await response.json() }; })();
        const response = sent.response;
        const data = (sent.body ?? {}) as { success?: boolean; code?: string; message?: string; error?: string; edit?: { direction?: string } };
        if (!response.ok || !data.success) throw new Error(`${data.code ? `${data.code}: ` : ''}${data.message || data.error || 'Could not edit the grant'}`);
        setEditing(null);
        await loadGrants();
        setNotice(`Grant edit applied (${data.edit?.direction || 'saved'}). Its ID and audit history are preserved.`);
      } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not edit the grant'); }
      finally { setSaving(false); }
    };
    if (editWidens) setEditStepUp(() => (token: string) => { void apply(token); });
    else void apply();
  };

  /** Card ff410dc4's confirmation, then (owner ruling E418(b)) the step-up
   * bound to (grant.revoke, this grant); the revoke is sent with its token. */
  const revokeGrant = (grant: GrantRecord) => {
    const target = granteeLabel(grant);
    if (!window.confirm(`Revoke ${grant.verb} access to ${grant.resourceType} from ${target}? The revocation remains in the audit log.`)) return;
    setError(null); setNotice(null);
    setRevokeStepUp(grant);
  };

  const sendRevoke = async (grant: GrantRecord, stepUpToken: string) => {
    setRevokeStepUp(null);
    setRevokingId(grant.id); setError(null); setNotice(null);
    try {
      const send = (token: string) => authenticatedFetch(`${API_BASE}/grants/${grant.id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepUpToken: token }),
      });
      // A token that no longer counts is answered with the challenge for this
      // grant; the person confirms once more and the revoke is sent ONE more time.
      const sent = await sendWithStepUpRetry(send, stepUpToken, { action: 'grant.revoke', targetId: grant.id }, askForToken);
      const response = sent.response;
      const data = (sent.body ?? {}) as { success?: boolean; code?: string; message?: string; error?: string };
      if (!response.ok || !data.success) throw new Error(`${data.code ? `${data.code}: ` : ''}${data.message || data.error || 'Could not revoke the grant'}`);
      setGrants(current => current.filter(row => row.id !== grant.id));
      setTotal(current => (current === null ? current : Math.max(0, current - 1)));
      const revokedClass = grant.madeBy?.class;
      if (revokedClass) setMadeCounts(current => (current ? { ...current, [revokedClass]: Math.max(0, current[revokedClass] - 1) } : current));
      setNotice('Access grant revoked and recorded in the audit log.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not revoke the grant');
    } finally {
      setRevokingId(null);
    }
  };

  if (authorityLoading) return <div className="grants-state"><Loader2 className="grants-spin" aria-hidden="true" /> Checking authority…</div>;
  if (!canManage) {
    return <div className="grants-error" role="alert">Access grants are available only to authorised human administrators.</div>;
  }

  const hiddenByOrigin = query.made === 'all' || !madeCounts ? 0
    : (Object.entries(madeCounts) as Array<[MadeClass, number]>).filter(([cls]) => cls !== query.made).reduce((sum, [, n]) => sum + n, 0);
  const hiddenParts = madeCounts ? (Object.entries(madeCounts) as Array<[MadeClass, number]>)
    .filter(([cls, n]) => cls !== query.made && n > 0)
    .map(([cls, n]) => `${n} ${cls === 'hand' ? 'hand-made' : cls === 'system' ? 'system-made' : 'of unknown origin'}`) : [];
  const filtersChanged = JSON.stringify({ ...query, q: searchDraft }) !== JSON.stringify(DEFAULT_QUERY);
  /** One condition for both row actions, so the pair always looks alike. */
  const actionsBusy = saving || revokingId !== null;
  const startEdit = (grant: GrantRecord) => { setEditing(grant); setEditDraft({ verb: grant.verb, resourceId: grant.resourceId || '', expiresAt: formatInstantForDateTimeLocal(grant.expiresAt ?? '').slice(0, 16) }); setEditLifetime(''); setEditTask(''); setEditRevertAt(''); };

  return (
    <div className="grants-page">
      <header className="grants-header">
        <div><KeyRound aria-hidden="true" /><h1>Access grants</h1><span className="grants-count" title="Grants in this view">{total ?? grants.length}</span></div>
        <button type="button" className="grants-refresh" onClick={() => { reloadPrincipals(); loadGrants(); }} aria-label="Refresh access grants">
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </header>
      <p className="grants-intro">Give a specific identity additional access to one object or every object of a type. Normal project visibility remains the default; exceptional restrictions are configured explicitly on the relevant phase.</p>
      <div className="grants-boundary" role="note"><ShieldCheck size={20} aria-hidden="true" /><span>This is a human administration surface. Agents may inspect their own grants, but cannot create, widen, or revoke them. Every change is attributed in the audit log.</span></div>

      {error && <div className="grants-error" role="alert">{error}</div>}
      {notice && <div className="grants-notice" role="status">{notice}</div>}

      <form className="grants-editor" onSubmit={createGrant} aria-busy={saving}>
        <h2>Create a grant</h2>
        <p className="grants-intro">The form keeps every field after a grant is created, so the next grant differs only in what you change. A blank Specific resource ID grants every resource of the type, and the form asks you to confirm that first.</p>
        <div className="grants-editor-grid">
          <div className="form-group grants-span-two">
            <label htmlFor="grant-grantee">Identity</label>
            <select id="grant-grantee" className="form-select" required value={draft.granteeId} onChange={event => setDraft({ ...draft, granteeId: event.target.value })} disabled={principalsLoading || principalsFailed}>
              {activePrincipals.length === 0 && <option value="">No active identities available</option>}
              {activePrincipals.map(principal => <option key={principal.id} value={principal.id}>{principalLabel(principal)} · {principal.kind}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="grant-resource-type">Resource type</label>
            <select id="grant-resource-type" className="form-select" value={draft.resourceType} onChange={event => setDraft({ ...draft, resourceType: event.target.value as ResourceType })}>
              {RESOURCE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="grant-verb">Permission</label>
            <select id="grant-verb" className="form-select" value={draft.verb} onChange={event => setDraft({ ...draft, verb: event.target.value as GrantVerb })}>
              {VERBS.map(verb => <option key={verb} value={verb}>{verb}</option>)}
            </select>
          </div>
          <div className="form-group grants-span-two">
            <label htmlFor="grant-resource-id">Specific resource ID <span className="grants-optional">optional</span></label>
            <input id="grant-resource-id" className="form-input" type="text" pattern="[0-9a-fA-F-]{36}" placeholder="Leave blank to grant access to every resource of this type" value={draft.resourceId} onChange={event => setDraft({ ...draft, resourceId: event.target.value })} />
          </div>
          <div className="form-group grants-span-two">
            <label htmlFor="grant-expires">Expires <span className="grants-optional">optional</span></label>
            <input id="grant-expires" className="form-input" type="datetime-local" value={draft.expiresAt} onChange={event => setDraft({ ...draft, expiresAt: event.target.value })} />
          </div>
        </div>
        <div className="form-actions"><Button type="submit" variant="primary" icon={<Plus size={16} />} disabled={saving || !draft.granteeId}>{saving ? 'Creating…' : 'Create grant'}</Button></div>
      </form>

      {editing && <form className="grants-editor" aria-label="Edit grant" onSubmit={saveEdit}>
        <h2>Edit grant for {granteeLabel(editing)}</h2>
        <p>{editing.resourceType} · Identity and resource type stay fixed. Blank resource ID means every resource of this type.</p>
        <label htmlFor="grant-edit-verb">Edit permission</label>
        <select className="form-select" id="grant-edit-verb" value={editDraft.verb} onChange={event => setEditDraft({ ...editDraft, verb: event.target.value as GrantVerb })}>{VERBS.map(verb => <option key={verb}>{verb}</option>)}</select>
        <label htmlFor="grant-edit-resource">Edit specific resource ID</label>
        <input className="form-input" id="grant-edit-resource" pattern="[0-9a-fA-F-]{36}" value={editDraft.resourceId} onChange={event => setEditDraft({ ...editDraft, resourceId: event.target.value })} />
        <label htmlFor="grant-edit-expiry">Edit expiry</label>
        <input className="form-input" id="grant-edit-expiry" type="datetime-local" value={editDraft.expiresAt} onChange={event => setEditDraft({ ...editDraft, expiresAt: event.target.value })} />
        {editWidens && <>
          <p>This edit widens access and requires confirmation.</p>
          <label htmlFor="grant-edit-lifetime">Lifetime for this edit</label>
          <select className="form-select" id="grant-edit-lifetime" required value={editLifetime} onChange={event => setEditLifetime(event.target.value as typeof editLifetime)}><option value="">Choose a lifetime</option><option value="keep">Keep (until narrowed)</option><option value="until-task">Until this task ends</option></select>
          {editLifetime === 'until-task' && <><label htmlFor="grant-edit-task">Related task ID</label><input className="form-input" id="grant-edit-task" pattern="[0-9a-fA-F-]{36}" value={editTask} onChange={event => setEditTask(event.target.value)} /><label htmlFor="grant-edit-revert">Revert at (required without a task)</label><input className="form-input" id="grant-edit-revert" type="datetime-local" required={!editTask.trim()} value={editRevertAt} onChange={event => setEditRevertAt(event.target.value)} /></>}
        </>}
        <div className="form-actions"><Button type="button" onClick={() => setEditing(null)} disabled={saving}>Cancel edit</Button><Button type="submit" disabled={saving || (editWidens && !editLifetime)}>Save grant edit</Button></div>
      </form>}
      {editStepUp && editing && <StepUpDialog action="grant.edit" targetId={editing.id} description={`Widen the grant for ${granteeLabel(editing)} with the chosen lifetime.`} onToken={editStepUp} onCancel={() => setEditStepUp(null)} />}
      {revokeStepUp && <StepUpDialog action="grant.revoke" targetId={revokeStepUp.id} description={`Revoke ${revokeStepUp.verb} access to ${revokeStepUp.resourceType} from ${granteeLabel(revokeStepUp)}.`} onToken={(token) => { void sendRevoke(revokeStepUp, token); }} onCancel={() => setRevokeStepUp(null)} />}
      {retryDialog}
      <section className="grants-list" aria-labelledby="current-grants-heading">
        <div className="grants-list-header">
          <h2 id="current-grants-heading">Current grants</h2>
          <span className="grants-list-summary" aria-live="polite">
            {loading ? 'Loading…' : `Showing ${grants.length}${total !== null ? ` of ${total}` : ''}`}
          </span>
          {/* Owner ruling E413: the bulk clean-up of grants that change nobody's
              access, over the ids this filter shows, beside the paging. */}
          <Button type="button" variant="secondary" size="compact" icon={<Eraser size={16} />} ariaExpanded={cleanupOpen}
            ariaControls="grants-cleanup-panel" onClick={() => setCleanupOpen(open => !open)}>
            Clean up redundant grants
          </Button>
        </div>
        {cleanupOpen && (
          <div id="grants-cleanup-panel">
            <GrantCleanup pageUrl={(cursor, limit) => listUrl(query, cursor, limit)} onFinished={() => { void loadGrants(); }} />
          </div>
        )}
        {/* Card ff410dc4: the default view is hand-made grants only; system-made
            and unknown-origin rows are one filter away and counted here. */}
        <div className="grants-filters" role="search" aria-label="Filter access grants">
          <div className="grants-search">
            <Search size={16} aria-hidden="true" />
            <input id="grants-search" type="search" className="form-input" value={searchDraft} placeholder="Identity, resource title or ID"
              aria-label="Search grants" onChange={event => setSearchDraft(event.target.value)} />
          </div>
          <label htmlFor="grants-filter-made">Origin
            <select id="grants-filter-made" className="form-select" value={query.made} onChange={event => setFilter('made', event.target.value as ListQuery['made'])}>
              {MADE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label htmlFor="grants-filter-type">Resource type filter
            <select id="grants-filter-type" className="form-select" value={query.resourceType} onChange={event => setFilter('resourceType', event.target.value as ListQuery['resourceType'])}>
              <option value="">All resource types</option>
              {RESOURCE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <label htmlFor="grants-filter-verb">Permission filter
            <select id="grants-filter-verb" className="form-select" value={query.verb} onChange={event => setFilter('verb', event.target.value as ListQuery['verb'])}>
              <option value="">All permissions</option>
              {VERBS.map(verb => <option key={verb} value={verb}>{verb}</option>)}
            </select>
          </label>
          <label htmlFor="grants-filter-expiry">Expiry state
            <select id="grants-filter-expiry" className="form-select" value={query.expiry} onChange={event => setFilter('expiry', event.target.value as ListQuery['expiry'])}>
              {EXPIRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label htmlFor="grants-filter-target">Resource state
            <select id="grants-filter-target" className="form-select" value={query.target} onChange={event => setFilter('target', event.target.value as ListQuery['target'])}>
              {TARGET_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label htmlFor="grants-sort">Sort
            <select id="grants-sort" className="form-select" value={query.sort} onChange={event => setFilter('sort', event.target.value)}>
              {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {filtersChanged && <button type="button" className="grants-link" onClick={() => { setSearchDraft(''); setQuery(DEFAULT_QUERY); }}>Reset to the hand-made view</button>}
        </div>
        {hiddenByOrigin > 0 && (
          <p className="grants-hidden-note">
            {query.made === 'hand' ? 'Showing hand-made grants only. ' : ''}
            {`Hidden by the Origin filter: ${hiddenParts.join(', ')}. `}
            <button type="button" className="grants-link" onClick={() => setFilter('made', 'all')}>Show all origins</button>
          </p>
        )}
        {loading ? (
          <div className="grants-state"><Loader2 className="grants-spin" aria-hidden="true" /> Loading grants…</div>
        ) : grants.length === 0 ? (
          <div className="grants-empty">No grants match this view.</div>
        ) : (
          <div className="grants-table" role="table" aria-label="Current access grants">
            <div className="grants-row grants-row--head" role="row"><span role="columnheader">Identity</span><span role="columnheader">Access</span><span role="columnheader">Resource</span><span role="columnheader">Origin</span><span role="columnheader">Expiry</span><span role="columnheader">Actions</span></div>
            {grants.map(grant => {
              const origin = originView(grant);
              const note = targetNote(grant);
              const named = `${grant.verb} ${grant.resourceType} grant for ${granteeLabel(grant)}`;
              return (
                <div className="grants-row" role="row" key={grant.id}>
                  <span role="cell"><strong>{granteeLabel(grant)}</strong><small>{granteeNote(grant)}</small></span>
                  <span role="cell"><span className="grants-verb">{grant.verb}</span></span>
                  <span role="cell">
                    <strong>{grant.resourceType}{grant.target?.label ? ` · ${grant.target.label}` : ''}</strong>
                    <small title={grant.resourceId || undefined}>{grant.resourceId ? grant.resourceId : 'Every resource of this type'}{note ? ` · ${note}` : ''}</small>
                  </span>
                  <span role="cell"><strong className={MADE_CLASS_STYLE[origin.cls]}>{origin.label}</strong><small>{origin.detail}</small></span>
                  <span role="cell">{expiryLabel(grant.expiresAt)}</span>
                  <span role="cell">
                    {/* Card ff410dc4 (E407 item 1): one inline pair of EQUAL
                        controls, the same size, side by side at every width,
                        and disabled together while a save or a revoke runs. */}
                    <span className="grants-actions" role="group" aria-label={`Actions for the ${named}`}>
                      <button type="button" className="grants-action" disabled={actionsBusy} onClick={() => startEdit(grant)} aria-label={`Edit ${named}`}>
                        <Pencil size={16} aria-hidden="true" /><span>Edit</span>
                      </button>
                      <button type="button" className="grants-action grants-action--danger" onClick={() => revokeGrant(grant)} disabled={actionsBusy} aria-label={`Revoke ${named}`}>
                        <Trash2 size={16} aria-hidden="true" /><span>{revokingId === grant.id ? 'Revoking…' : 'Revoke'}</span>
                      </button>
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {nextCursor && !loading && (
          <div className="grants-more">
            <Button type="button" variant="secondary" size="compact" disabled={loadingMore} onClick={() => { void fetchPage(query, nextCursor); }}>
              {loadingMore ? 'Loading more…' : 'Load more grants'}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
};
