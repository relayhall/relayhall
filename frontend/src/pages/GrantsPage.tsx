import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '../components/Button';
import { useMyPrincipal, usePrincipals } from '../hooks/usePrincipals';
import type { Principal } from '../types/task';
import { authenticatedFetch } from '../utils/auth';
import './GrantsPage.css';
import { formatDateTime } from '../utils/dateFormat';

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

interface GrantRecord {
  id: string;
  granteeType: 'principal';
  granteeId: string;
  resourceType: ResourceType;
  resourceId: string | null;
  verb: GrantVerb;
  grantedByPrincipalId: string | null;
  expiresAt: string | null;
  createdAt: string;
  grantee: GrantIdentitySummary | null;
  grantedBy: GrantIdentitySummary | null;
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
  if (!grant.grantee) return `Deleted identity (${grant.granteeId})`;
  const { displayName, handle } = grant.grantee;
  return displayName ? `${displayName} (${handle})` : handle;
}

/** What KIND of holder this is, in one line the operator can act on. */
function granteeNote(grant: GrantRecord): string {
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
  const [resourceFilter, setResourceFilter] = useState<'all' | ResourceType>('all');

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

  const loadGrants = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await authenticatedFetch(`${API_BASE}/grants`);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || data.error || 'Could not load access grants');
      setGrants(Array.isArray(data.grants) ? data.grants : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load access grants');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authorityLoading && canManage) loadGrants();
    else if (!authorityLoading) setLoading(false);
  }, [authorityLoading, canManage, loadGrants]);

  const createGrant = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !draft.granteeId) return;
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
      setGrants(current => [...current, data.grant]);
      setDraft(current => ({ ...emptyDraft(), granteeId: current.granteeId }));
      setNotice('Access grant created and recorded in the audit log.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the grant');
    } finally {
      setSaving(false);
    }
  };

  const revokeGrant = async (grant: GrantRecord) => {
    const target = granteeLabel(grant);
    if (!window.confirm(`Revoke ${grant.verb} access to ${grant.resourceType} from ${target}? The revocation remains in the audit log.`)) return;
    setRevokingId(grant.id); setError(null); setNotice(null);
    try {
      const response = await authenticatedFetch(`${API_BASE}/grants/${grant.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || data.error || 'Could not revoke the grant');
      setGrants(current => current.filter(row => row.id !== grant.id));
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

  const shownGrants = resourceFilter === 'all' ? grants : grants.filter(grant => grant.resourceType === resourceFilter);

  return (
    <div className="grants-page">
      <header className="grants-header">
        <div><KeyRound aria-hidden="true" /><h1>Access grants</h1><span className="grants-count">{grants.length}</span></div>
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

      <section className="grants-list" aria-labelledby="current-grants-heading">
        <div className="grants-list-header">
          <h2 id="current-grants-heading">Current grants</h2>
          <label>Show <select className="form-select" value={resourceFilter} onChange={event => setResourceFilter(event.target.value as 'all' | ResourceType)}><option value="all">all resource types</option>{RESOURCE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
        </div>
        {loading ? (
          <div className="grants-state"><Loader2 className="grants-spin" aria-hidden="true" /> Loading grants…</div>
        ) : shownGrants.length === 0 ? (
          <div className="grants-empty">No grants match this view.</div>
        ) : (
          <div className="grants-table" role="table" aria-label="Current access grants">
            <div className="grants-row grants-row--head" role="row"><span role="columnheader">Identity</span><span role="columnheader">Access</span><span role="columnheader">Resource</span><span role="columnheader">Expiry</span><span role="columnheader">Action</span></div>
            {shownGrants.map(grant => (
              <div className="grants-row" role="row" key={grant.id}>
                <span role="cell"><strong>{granteeLabel(grant)}</strong><small>{granteeNote(grant)}</small></span>
                <span role="cell" className="grants-verb">{grant.verb}</span>
                <span role="cell"><strong>{grant.resourceType}</strong><small title={grant.resourceId || undefined}>{grant.resourceId ? grant.resourceId : 'Every resource of this type'}</small></span>
                <span role="cell">{expiryLabel(grant.expiresAt)}</span>
                <span role="cell"><button type="button" className="grants-revoke" onClick={() => revokeGrant(grant)} disabled={revokingId !== null} aria-label={`Revoke ${grant.verb} ${grant.resourceType} grant for ${granteeLabel(grant)}`}><Trash2 size={16} aria-hidden="true" /> {revokingId === grant.id ? 'Revoking…' : 'Revoke'}</button></span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
