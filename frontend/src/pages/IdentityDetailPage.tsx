import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../components/Button';
import { Select } from '../components/ui/Select';
import { PrincipalAvatar } from '../components/PrincipalAvatar';
import { RoleSelectionExplanation } from '../components/access/RoleExplanation';
import {
  isRoleChangeTarget, roleChangeNotice, roleChangeRefusalReason, RoleChangeConfirmation,
  ROLE_CHANGE_STEP_UP_DESCRIPTION, sendRoleChange,
} from '../components/access/roleChange';
import { useStepUpRetry } from '../components/access/useStepUpRetry';
import { useRelayHallConfig } from '../contexts/RelayHallConfigContext';
import { useRoleCatalogue } from '../hooks/useRoleCatalogue';
import type { Principal } from '../types/task';
import { authenticatedFetch } from '../utils/auth';
import { assignableBy, mayChangeRoles } from '../utils/administratorSession';
import { formatDateTime } from '../utils/dateFormat';
import './IdentityDetailPage.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * ONE IDENTITY, OPENED FROM THE IDENTITIES LIST (card caea70ef, epic F11).
 *
 * Read-only facts first — kind, role, status, the connectors under it and
 * their credentials with scopes, the grants and Warrants it holds, and the
 * last audit rows about it or by it — then, for an administrator, the role
 * change as an action on the identity itself. The Access manager's Roles panel
 * stays the bulk view; both doors call the same act (`roleChange.tsx`).
 *
 * EVERY FACT IS A ROUTE THAT ALREADY EXISTS. There is no single-identity read
 * (`GET /principals/:id` is not a route), so the identity's own facts are its
 * row in the directory the list already read (`GET /principals`); the rest are
 * `GET /principals/:id/credentials`, `GET /principals/:id/grants`,
 * `GET /warrants` (narrowed here to the Warrants this identity holds) and two
 * `GET /audit` reads (rows about it, and rows it acted in). Each read is
 * decided by the board for this session, and a refused one says so in its own
 * section without hiding the others.
 *
 * What the routes do not carry, the page does not invent: a principal's
 * creation time and a service's declared purpose are not in the public
 * principal shape, and authority that reaches it through a Group or a profile
 * is the Access manager's inventory, not a grant row of its own.
 */

type Read<T> =
  | { state: 'reading' }
  | { state: 'ready'; value: T }
  | { state: 'refused'; message: string };

interface CredentialRow {
  id: string;
  keyId: string;
  label: string | null;
  scopes: string[];
  transport?: string;
  createdAt?: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  graceUntil: string | null;
}

interface GrantRow {
  id: string;
  resourceType: string;
  resourceId: string | null;
  verb: string;
  expiresAt: string | null;
  origin?: string;
}

interface WarrantRow {
  id: string;
  name: string;
  holderPrincipalId: string;
  status: string;
  ceilingProfileName: string | null;
  ceilingProfileVersionNumber: number | null;
  expiresAt: string | null;
  transportPin: string;
  mintedTotal: number;
  liveMinted: number;
}

interface AuditRow {
  id: string;
  occurredAt: string;
  action: string;
  outcome: 'success' | 'denied';
  actorHandle: string;
  actorPrincipalId: string | null;
  resourceType: string;
  resourceId: string | null;
}

/** How many audit rows the page shows, newest first, across both reads. */
const AUDIT_ROWS = 10;

/** Read one route and pick the list it answers; a refusal keeps the board's sentence. */
async function readList<T>(path: string, field: string): Promise<Read<T[]>> {
  try {
    const response = await authenticatedFetch(`${API_BASE}${path}`);
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.success === false) {
      const said = data && (data.message || data.error);
      return { state: 'refused', message: said ? String(said) : `The board answered ${response.status}.` };
    }
    const list = (data as Record<string, unknown>)[field];
    if (!Array.isArray(list)) return { state: 'refused', message: 'The board answered without the list.' };
    return { state: 'ready', value: list as T[] };
  } catch {
    return { state: 'refused', message: 'The RelayHall API could not be reached.' };
  }
}

/** One read per mount and per key; a stale answer never overwrites a newer one. */
function useRead<T>(key: string | null, load: () => Promise<Read<T>>): Read<T> {
  const [result, setResult] = useState<Read<T>>({ state: 'reading' });
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    setResult({ state: 'reading' });
    load().then((next) => { if (live) setResult(next); });
    return () => { live = false; };
    // `load` is rebuilt every render; the key is what names the read.
  }, [key]);
  return result;
}

function when(value: string | null | undefined): React.ReactNode {
  if (!value) return null;
  return <time dateTime={value}>{formatDateTime(value, value)}</time>;
}

/** A credential's state in words — revoked, in grace and expired before live. */
function credentialState(credential: CredentialRow): React.ReactNode {
  if (credential.revokedAt) return <>revoked {when(credential.revokedAt)}</>;
  if (credential.graceUntil) return <>in grace until {when(credential.graceUntil)}</>;
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) return <>expired {when(credential.expiresAt)}</>;
  if (credential.expiresAt) return <>active until {when(credential.expiresAt)}</>;
  return 'active';
}

/** What a read that is not ready says, in its section. */
const ReadState: React.FC<{ read: Read<unknown>; what: string }> = ({ read, what }) => {
  if (read.state === 'reading') return <p className="idd-muted" role="status">Reading {what}&hellip;</p>;
  if (read.state === 'refused') {
    return <p className="idd-refused">{what[0].toUpperCase()}{what.slice(1)} could not be read for this session: {read.message}</p>;
  }
  return null;
};

const CredentialList: React.FC<{ read: Read<CredentialRow[]>; empty: string; label: string }> = ({ read, empty, label }) => {
  if (read.state !== 'ready') return <ReadState read={read} what="the credentials" />;
  if (read.value.length === 0) return <p className="idd-muted">{empty}</p>;
  return (
    <ul className="idd-list" aria-label={label}>
      {read.value.map((credential) => (
        <li key={credential.id} className="idd-row">
          <code className="idd-code">{credential.keyId}</code>
          {credential.label && <span>{credential.label}</span>}
          <span className="idd-muted">{credential.transport ?? 'any'}</span>
          <span className={`idd-state${credential.revokedAt ? ' idd-state--off' : ''}`}>{credentialState(credential)}</span>
          {credential.lastUsedAt && <span className="idd-muted">last used {when(credential.lastUsedAt)}</span>}
          <ul className="idd-scopes" aria-label={`Scopes of ${credential.keyId}`}>
            {credential.scopes.map((scope) => <li key={scope} className="idd-scope">{scope}</li>)}
          </ul>
        </li>
      ))}
    </ul>
  );
};

/** One child identity (a Connector, or an Agent under a Connector) and its credentials. */
const ChildIdentity: React.FC<{ child: Principal }> = ({ child }) => {
  const credentials = useRead<CredentialRow[]>(child.id, () => readList<CredentialRow>(`/principals/${encodeURIComponent(child.id)}/credentials`, 'credentials'));
  return (
    <li className="idd-child">
      <h3 className="idd-child-head">
        <Link to={`?identity=${encodeURIComponent(child.id)}`}>{child.handle}</Link>
      </h3>
      <p className="idd-row">
        <span>{child.kind}</span>
        <span className={`idd-state${child.status === 'active' ? '' : ' idd-state--off'}`}>{child.status}</span>
        {child.harness && <span className="idd-muted">{child.harness}</span>}
      </p>
      <CredentialList read={credentials} empty="No credentials." label={`Credentials of ${child.handle}`} />
    </li>
  );
};

const RoleAction: React.FC<{
  principal: Principal;
  issuerRole: string | null;
  onChanged: () => void;
}> = ({ principal, issuerRole, onChanged }) => {
  const [role, setRole] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'notice' | 'error'; message: string } | null>(null);
  const catalogue = useRoleCatalogue();
  const { askForToken, retryDialog } = useStepUpRetry(ROLE_CHANGE_STEP_UP_DESCRIPTION);
  const roles = useMemo(() => assignableBy(issuerRole), [issuerRole]);

  const changeRole = async () => {
    setConfirming(false);
    if (!role) return;
    setBusy(true);
    setOutcome(null);
    try {
      const answer = await sendRoleChange(principal.id, role, askForToken);
      setOutcome({ kind: 'notice', message: roleChangeNotice(answer) });
      setRole('');
      onChanged();
    } catch (err) {
      setOutcome({ kind: 'error', message: err instanceof Error ? err.message : 'The role could not be changed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form
        className="idd-role-form"
        aria-label="Change this role"
        onSubmit={(event) => { event.preventDefault(); if (role) setConfirming(true); }}
      >
        <div className="form-group">
          <label htmlFor="idd-role-value">
            New role <span className="idd-muted">bounded by your own role</span>
          </label>
          <Select
            id="idd-role-value"
            aria-describedby="idd-role-description"
            required
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="">Choose a role&hellip;</option>
            {roles.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
          <div id="idd-role-description" aria-live="polite">
            <RoleSelectionExplanation
              catalogue={catalogue}
              role={role}
              emptyText="Choose a role to see what it may reach."
            />
          </div>
        </div>
        <div className="idd-actions">
          <Button type="submit" variant="primary" disabled={busy || !role || role === principal.role}>
            {busy ? 'Changing…' : 'Change role'}
          </Button>
        </div>
      </form>
      {outcome && (
        <p className={outcome.kind === 'error' ? 'idd-error' : 'idd-notice'} role={outcome.kind === 'error' ? 'alert' : 'status'}>
          {outcome.message}
        </p>
      )}
      {confirming && (
        <RoleChangeConfirmation
          principal={principal}
          role={role}
          catalogue={catalogue}
          onConfirm={changeRole}
          onCancel={() => setConfirming(false)}
        />
      )}
      {retryDialog}
    </>
  );
};

export const IdentityDetailPage: React.FC<{
  principal: Principal;
  directory: Principal[];
  me: Principal | null;
  scopes: string[] | null | undefined;
  onDirectoryChanged: () => void;
}> = ({ principal, directory, me, scopes, onDirectoryChanged }) => {
  const location = useLocation();
  const { config } = useRelayHallConfig();
  const heading = useRef<HTMLHeadingElement>(null);
  const roleCatalogue = useRoleCatalogue();
  const id = principal.id;
  const encoded = encodeURIComponent(id);

  // Opening an identity moves focus to its name, so a keyboard or screen-reader
  // user lands on the page they asked for rather than where the link was.
  useEffect(() => { heading.current?.focus(); }, [id]);

  const parent = principal.parentPrincipalId ? directory.find((p) => p.id === principal.parentPrincipalId) : undefined;
  const children = useMemo(
    () => directory.filter((p) => p.parentPrincipalId === id).sort((a, b) => a.handle.localeCompare(b.handle)),
    [directory, id],
  );
  // An Account's children are its Connectors; a Connector's are its Agents.
  const childHeading = principal.parentPrincipalId ? 'Agents' : 'Connectors';

  const credentials = useRead<CredentialRow[]>(id, () => readList<CredentialRow>(`/principals/${encoded}/credentials`, 'credentials'));
  const grants = useRead<GrantRow[]>(id, () => readList<GrantRow>(`/principals/${encoded}/grants`, 'grants'));
  const warrants = useRead<WarrantRow[]>(id, async () => {
    const all = await readList<WarrantRow>('/warrants', 'warrants');
    return all.state === 'ready' ? { state: 'ready', value: all.value.filter((w) => w.holderPrincipalId === id) } : all;
  });
  const audit = useRead<AuditRow[]>(config.features.auditLog ? id : null, async () => {
    const [about, by] = await Promise.all([
      readList<AuditRow>(`/audit?resourceType=principal&resourceId=${encoded}&limit=${AUDIT_ROWS}`, 'events'),
      readList<AuditRow>(`/audit?actorPrincipalId=${encoded}&limit=${AUDIT_ROWS}`, 'events'),
    ]);
    if (about.state !== 'ready') return about;
    if (by.state !== 'ready') return by;
    const seen = new Set<string>();
    const merged = [...about.value, ...by.value].filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
    merged.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    return { state: 'ready', value: merged.slice(0, AUDIT_ROWS) };
  });

  const administrator = mayChangeRoles(me?.role ?? null, scopes);
  // The same targets rule as the Roles panel; the reason names the refusal.
  const refusal = isRoleChangeTarget(principal, me?.id ?? null)
    ? null
    : roleChangeRefusalReason(principal, me?.id ?? null) ?? 'The route refuses a role change on this identity.';

  return (
    <div className="idd-page">
      <Link className="idd-back" to={location.pathname}>
        <ArrowLeft size={16} aria-hidden="true" /> Back to Identities
      </Link>
      <header className="idd-header">
        <PrincipalAvatar principal={principal} size="md" showLabel={false} />
        <h1 ref={heading} tabIndex={-1}>{principal.handle}</h1>
      </header>

      <section className="idd-section" aria-labelledby="idd-facts-heading">
        <h2 id="idd-facts-heading">Identity</h2>
        <dl className="idd-facts">
          <div className="idd-row"><dt>Handle</dt><dd><code className="idd-code">{principal.handle}</code></dd></div>
          <div className="idd-row"><dt>Display name</dt><dd>{principal.displayName || <span className="idd-muted">none</span>}</dd></div>
          <div className="idd-row"><dt>Kind</dt><dd>{principal.kind}</dd></div>
          <div className="idd-row">
            <dt>Status</dt>
            <dd><span className={`idd-state${principal.status === 'active' ? '' : ' idd-state--off'}`}>{principal.status}</span></dd>
          </div>
          <div className="idd-row">
            <dt>Belongs to</dt>
            <dd>
              {parent
                ? <Link to={`?identity=${encodeURIComponent(parent.id)}`}>{parent.handle}</Link>
                : principal.parentPrincipalId
                  ? <span className="idd-muted">an identity this session cannot list</span>
                  : <span className="idd-muted">nobody: this is an Account</span>}
            </dd>
          </div>
          {principal.harness && <div className="idd-row"><dt>Harness</dt><dd>{principal.harness}</dd></div>}
          {principal.provenance && <div className="idd-row"><dt>Provenance</dt><dd>{principal.provenance}</dd></div>}
          <div className="idd-row">
            <dt>Last seen</dt>
            <dd>{when(principal.lastSeenAt) ?? <span className="idd-muted">not recorded</span>}</dd>
          </div>
          <div className="idd-row"><dt>Identity id</dt><dd><code className="idd-id">{principal.id}</code></dd></div>
        </dl>
      </section>

      <section className="idd-section" aria-labelledby="idd-role-heading">
        <h2 id="idd-role-heading">Role</h2>
        {principal.role ? (
          <>
            <p>{principal.handle} carries the role <strong className="idd-code">{principal.role}</strong>.</p>
            <RoleSelectionExplanation
              catalogue={roleCatalogue}
              role={principal.role}
              emptyText="This role is not in the role catalogue."
            />
          </>
        ) : (
          <p>{principal.handle} carries no role of its own; its authority comes from the identity it belongs to.</p>
        )}
        {administrator && (refusal
          ? <p className="idd-muted">{refusal}</p>
          : <RoleAction principal={principal} issuerRole={me?.role ?? null} onChanged={onDirectoryChanged} />)}
        {administrator && !refusal && (
          <p className="idd-muted">
            Changing a role is an administrator-session act: it can never grant more than you hold, it is
            audited with the before and after roles, and it takes effect on the identity&rsquo;s next
            request. Every Account&rsquo;s role is also on the Access manager&rsquo;s Roles section.
          </p>
        )}
      </section>

      <section className="idd-section" aria-labelledby="idd-children-heading">
        <h2 id="idd-children-heading">{childHeading}</h2>
        {children.length === 0
          ? <p className="idd-muted">No {childHeading.toLowerCase()} in the directory this session can read.</p>
          : <ul className="idd-children">{children.map((child) => <ChildIdentity key={child.id} child={child} />)}</ul>}
      </section>

      <section className="idd-section" aria-labelledby="idd-credentials-heading">
        <h2 id="idd-credentials-heading">Credentials</h2>
        <CredentialList
          read={credentials}
          label={`Credentials of ${principal.handle}`}
          empty={principal.parentPrincipalId
            ? 'This identity holds no credentials.'
            : 'This identity holds no credentials. Accounts are keyless: they act through their Connectors.'}
        />
      </section>

      <section className="idd-section" aria-labelledby="idd-grants-heading">
        <h2 id="idd-grants-heading">Grants held</h2>
        {grants.state !== 'ready' ? <ReadState read={grants} what="the grants" /> : grants.value.length === 0 ? (
          <p className="idd-muted">No grant rows name this identity.</p>
        ) : (
          <ul className="idd-list" aria-label={`Grants held by ${principal.handle}`}>
            {grants.value.map((grant) => (
              <li key={grant.id} className="idd-row">
                {grant.resourceId
                  ? <span>{grant.verb} on {grant.resourceType} <code className="idd-code">{grant.resourceId}</code></span>
                  : <span>{grant.verb} on every {grant.resourceType}</span>}
                <span className="idd-muted">{grant.expiresAt ? <>until {when(grant.expiresAt)}</> : 'no expiry'}</span>
                {grant.origin && <span className="idd-muted">{grant.origin}</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="idd-muted">
          Direct grant rows only. Authority that reaches this identity through a Group or an access profile is
          on the Access manager&rsquo;s granted-access inventory.
        </p>
      </section>

      <section className="idd-section" aria-labelledby="idd-warrants-heading">
        <h2 id="idd-warrants-heading">Warrants</h2>
        {warrants.state !== 'ready' ? <ReadState read={warrants} what="the Warrants" /> : warrants.value.length === 0 ? (
          <p className="idd-muted">This identity holds no Warrant this session can read.</p>
        ) : (
          <ul className="idd-list" aria-label={`Warrants held by ${principal.handle}`}>
            {warrants.value.map((warrant) => (
              <li key={warrant.id} className="idd-row">
                <strong>{warrant.name}</strong>
                <span className={`idd-state${warrant.status === 'active' ? '' : ' idd-state--off'}`}>{warrant.status}</span>
                {warrant.ceilingProfileName && (
                  <span className="idd-muted">ceiling {warrant.ceilingProfileName} v{warrant.ceilingProfileVersionNumber}</span>
                )}
                <span className="idd-muted">{warrant.liveMinted} live of {warrant.mintedTotal} minted</span>
                <span className="idd-muted">transport {warrant.transportPin}</span>
                {warrant.expiresAt && <span className="idd-muted">until {when(warrant.expiresAt)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {config.features.auditLog && (
        <section className="idd-section" aria-labelledby="idd-audit-heading">
          <h2 id="idd-audit-heading">Recent audit</h2>
          {audit.state !== 'ready' ? <ReadState read={audit} what="the audit log" /> : audit.value.length === 0 ? (
            <p className="idd-muted">No audit rows about or by this identity.</p>
          ) : (
            <ul className="idd-list" aria-label={`Recent audit rows for ${principal.handle}`}>
              {audit.value.map((row) => (
                <li key={row.id} className="idd-row">
                  {when(row.occurredAt)}
                  <code className="idd-audit-action">{row.action}</code>
                  <span className={`idd-state${row.outcome === 'success' ? '' : ' idd-state--off'}`}>{row.outcome}</span>
                  <span className="idd-muted">
                    {row.actorPrincipalId === id ? 'by this identity' : `by ${row.actorHandle}`}
                    {row.resourceType === 'principal' && row.resourceId === id ? ', about it' : ` on ${row.resourceType}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p>
            <Link to={`/audit?resourceType=principal&resourceId=${encoded}`}>Open in the audit log</Link>
          </p>
        </section>
      )}
    </div>
  );
};

export default IdentityDetailPage;
