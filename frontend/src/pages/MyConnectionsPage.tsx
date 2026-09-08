import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, Loader2, Plug, RefreshCw, ShieldOff, Sliders,
} from 'lucide-react';
import { Button } from '../components/Button';
import { authenticatedFetch } from '../utils/auth';
import { useMyPrincipal } from '../hooks/usePrincipals';
import { useMyConnections } from '../hooks/useMyConnections';
import { CreateIdentityWizard } from '../components/identity/CreateIdentityWizard';
import { BootstrapPane } from '../components/connections/BootstrapPane';
import { ScopeNarrowing } from '../components/connections/ScopeNarrowing';
import {
  Connection, ConnectionCredential, ConnectionTransport,
  REGENERATE_ADMIN_ONLY, kindLabelForDescription, lostCredentialRecovery,
  mayRegenerateCredential, templateForDescription,
} from '../types/connections';
import '../components/connections/connections.css';
import './MyConnectionsPage.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * My connections (owner design record 99d6b0ad §3.1).
 *
 * "The person's connectors with status/last use; endpoints and instructions
 * re-shown any time (not secret). Per connection an **Advanced** tab: scopes
 * editor, transport pin, expiry, the agents minted beneath, their warrants and
 * grants — the manual path for edge cases, clearly labelled; not the day-one
 * flow."
 *
 * OWN CHAIN ONLY, BY CONSTRUCTION. Every read this page makes is either
 * `GET /principals/me/connectors` (no id to point elsewhere) or a route
 * carrying the ratified AZ-S4 self-scope arm — `GET /warrants` conceals every
 * holder outside the session's subtree, and `GET /principals/{id}/grants`
 * answers the caller's own descendants. Nothing here can be aimed at another
 * person's chain, so there is no filter to forget.
 *
 * WHAT THIS PAGE DOES NOT DO. It never reveals a credential. Re-showing the
 * instructions re-renders the pack around the server's placeholder; the secret
 * itself was one-time (§7.4) and re-revealing a stored secret is the Access
 * manager's step-up flow, not this page's.
 */

const relative = (iso: string | null): string => {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'never';
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
};

/** The one live credential of a connection, or the newest one if none is live. */
function primaryCredential(connection: Connection): ConnectionCredential | null {
  return connection.credentials.find((c) => c.state === 'live') ?? connection.credentials[0] ?? null;
}

/**
 * What a row says about itself. An ENUMERATED set with its own label and its
 * own class — never a class name built by interpolation, which is how an
 * unstyled state slips through a stylesheet review unnoticed.
 *
 * A disabled Connector principal outranks its credential's state: the kill
 * switch refuses every credential the principal holds, so reporting a 
 * credential under a disabled Connector would be a true fact told misleadingly.
 */
type RowState = 'live' | 'graced' | 'replaced' | 'expired' | 'revoked' | 'none' | 'disabled';

const ROW_STATE_LABEL: Record<RowState, string> = {
  live: 'live',
  // Only the LIVE half of a rotation grace window. Past `grace_until` the door
  // answers CREDENTIAL_GRACE_ELAPSED, so "still working" would be false.
  graced: 'replaced, still working',
  replaced: 'replaced, no longer working',
  expired: 'expired',
  revoked: 'revoked',
  none: 'no credential',
  disabled: 'disabled',
};

const ROW_STATE_CLASS: Record<RowState, string> = {
  live: 'conn-status conn-status--live',
  graced: 'conn-status conn-status--graced',
  replaced: 'conn-status conn-status--replaced',
  expired: 'conn-status conn-status--expired',
  revoked: 'conn-status conn-status--revoked',
  none: 'conn-status conn-status--none',
  disabled: 'conn-status conn-status--disabled',
};

export function rowStateOf(connection: Connection): RowState {
  if (connection.status !== 'active') return 'disabled';
  const credential = primaryCredential(connection);
  return credential ? credential.state : 'none';
}

export const MyConnectionsPage: React.FC = () => {
  const { me, scopes, loading: principalLoading } = useMyPrincipal();
  const { connections, instructions, loading, unavailable, failed, reload } = useMyConnections();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isRoot = Array.isArray(scopes) && scopes.includes('root');

  if (loading || principalLoading) {
    return (
      <div className="conn-state">
        <Loader2 className="conn-spin" aria-hidden="true" /> Loading your connections…
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="conn-state" role="status">
        Connections need the identity substrate, which this deployment has not migrated yet.
      </div>
    );
  }

  return (
    <div className="conn-page">
      <header className="conn-page-head">
        <div><Plug aria-hidden="true" /><h1>My connections</h1></div>
        {!creating && (
          <Button onClick={() => setCreating(true)} icon={<Plug size={16} />}>Connect an agent</Button>
        )}
      </header>
      <p className="conn-page-intro">
        The agents, editors and scripts you have connected to this board. Each one acts inside your
        own authority and never beyond it, and you see only your own — nobody else&rsquo;s connections
        are listed here, and yours are not listed on theirs.
      </p>

      {error && <div className="conn-error" role="alert">{error}</div>}
      {notice && <div className="conn-notice" role="status">{notice}</div>}
      {failed && (
        <div className="conn-error" role="alert">
          Could not read your connections.{' '}
          <button type="button" className="conn-linkbtn" onClick={reload}>Try again</button>
        </div>
      )}

      {creating && (
        <CreateIdentityWizard
          initialKind="agent"
          lockKind
          onCreated={reload}
          onClose={() => { setCreating(false); reload(); }}
        />
      )}

      {!creating && connections.length === 0 && !failed && (
        <div className="conn-empty">
          <p className="conn-empty-title">No connections yet.</p>
          <p className="conn-empty-body">
            Connect an agent and it can read the board, claim work and file reports on your behalf —
            inside your own authority, never beyond it.
          </p>
          <Button onClick={() => setCreating(true)} icon={<Plug size={16} />}>Connect your agent</Button>
        </div>
      )}

      {connections.length > 0 && (
        <ul className="conn-list">
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.principalId}
              connection={connection}
              instructions={instructions}
              isRoot={isRoot}
              accountScopes={Array.isArray(scopes) ? scopes : []}
              accountId={me?.id ?? null}
              onChanged={reload}
              surface={(kind, message) => {
                if (kind === 'error') { setError(message); setNotice(null); }
                else { setNotice(message); setError(null); }
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
};

const ConnectionRow: React.FC<{
  connection: Connection;
  instructions: ReturnType<typeof useMyConnections>['instructions'];
  isRoot: boolean;
  accountScopes: string[];
  accountId: string | null;
  onChanged: () => void;
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ connection, instructions, isRoot, accountScopes, accountId, onChanged, surface }) => {
  const [open, setOpen] = useState<'none' | 'setup' | 'advanced'>('none');
  const [busy, setBusy] = useState(false);
  const credential = primaryCredential(connection);
  const state = rowStateOf(connection);
  const template = templateForDescription(connection.service.description);
  const transport = (credential?.transport ?? template?.transport ?? 'any') as ConnectionTransport;
  const detailId = `conn-detail-${connection.principalId}`;

  const disable = async () => {
    if (!credential) return;
    setBusy(true);
    try {
      const response = await authenticatedFetch(`${API_BASE}/credentials/${credential.id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'disabled by its owner from My connections' }),
      });
      if (!response.ok) {
        surface('error', 'The board refused to disable that credential.');
        return;
      }
      surface('notice', `${connection.service.name} can no longer reach the board. Its credential is revoked, and the very next call it makes is refused.`);
      onChanged();
    } catch {
      surface('error', 'Could not reach the board.');
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!credential) return;
    setBusy(true);
    try {
      const response = await authenticatedFetch(`${API_BASE}/credentials/${credential.id}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        surface('error', data?.message || 'The board refused the regeneration.');
        return;
      }
      surface('notice', `New credential for ${connection.service.name}: ${data.secretOnce} — shown once, copy it now. The old one keeps working for ${data.graceHours} hours.`);
      onChanged();
    } catch {
      surface('error', 'Could not reach the board.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="conn-item">
      <div className="conn-item-row">
        {/* Each connection is a SECTION of the page, not a bolded row: the
            Advanced panel beneath it carries headings of its own, and without
            a level here the page would jump h1 -> h3 (axe heading-order). */}
        <div className="conn-item-title">
          <h2 className="conn-item-name">{connection.service.name}</h2>
          <small>{kindLabelForDescription(connection.service.description)}</small>
        </div>
        <span className={ROW_STATE_CLASS[state]}>{ROW_STATE_LABEL[state]}</span>
        <span className="conn-item-meta">Last used {relative(credential?.lastUsedAt ?? connection.lastSeenAt)}</span>
        <div className="conn-item-tools">
          <Button
            variant="secondary"
            size="compact"
            ariaExpanded={open === 'setup'}
            ariaControls={detailId}
            onClick={() => setOpen(open === 'setup' ? 'none' : 'setup')}
          >
            {open === 'setup' ? <ChevronDown size={16} /> : <ChevronRight size={16} />} Setup
          </Button>
          <Button
            variant="secondary"
            size="compact"
            icon={<Sliders size={16} />}
            ariaExpanded={open === 'advanced'}
            ariaControls={detailId}
            onClick={() => setOpen(open === 'advanced' ? 'none' : 'advanced')}
          >
            Advanced
          </Button>
        </div>
      </div>

      {open !== 'none' && (
        <div className="conn-item-detail" id={detailId}>
          {open === 'setup' && (
            instructions ? (
              <BootstrapPane
                mcpConfig={instructions.mcpConfig}
                cliEnv={instructions.cliEnv}
                bootstrapLine={instructions.bootstrapLine}
                boardEndpoint={instructions.boardEndpoint}
                transport={transport}
                initialTab={template?.defaultTab}
                carriesSecret={false}
                recovery={lostCredentialRecovery(accountScopes)}
              />
            ) : (
              <p className="conn-note">The board did not return the setup instructions for this session.</p>
            )
          )}

          {open === 'advanced' && (
            <AdvancedTab
              connection={connection}
              credential={credential}
              transport={transport}
              accountScopes={accountScopes}
              accountId={accountId}
              isRoot={isRoot}
              busy={busy}
              onDisable={disable}
              onRegenerate={regenerate}
            />
          )}
        </div>
      )}
    </li>
  );
};

const AdvancedTab: React.FC<{
  connection: Connection;
  credential: ConnectionCredential | null;
  transport: ConnectionTransport;
  accountScopes: string[];
  accountId: string | null;
  isRoot: boolean;
  busy: boolean;
  onDisable: () => void;
  onRegenerate: () => void;
}> = ({ connection, credential, transport, accountScopes, accountId, isRoot, busy, onDisable, onRegenerate }) => {
  // The SAME predicate the wizard's recovery sentence is built from, so the two
  // surfaces cannot disagree about what this session may do (round-2 P3-R2).
  // `isRoot` stays separate below: reading another principal's object grants is
  // a different authority question from rotating a credential.
  const mayRegenerate = mayRegenerateCredential(accountScopes);
  const [warrants, setWarrants] = useState<Array<Record<string, unknown>>>([]);
  const [grants, setGrants] = useState<Array<Record<string, unknown>>>([]);
  const [chainNote, setChainNote] = useState<string | null>(null);

  // WHAT THIS TAB MAY READ, and what it deliberately does not ask for.
  //
  // Warrants: `GET /warrants` carries the ratified §6.1/§9.1 self-scope arm —
  // a non-root session is shown only holders inside its own subtree, and every
  // other one is 404-concealed by the server. So the call is safe to make from
  // any session and the filter below is a display narrowing, not the guard.
  //
  // Object grants: `GET /principals/{id}/grants` splits OWN vs the manage
  // gate; a Connector is not the caller, so an ordinary Account session is
  // refused there. Widening that split to the own subtree would be a change to
  // an authorization gate, which this lane has no mandate to make — so the tab
  // ASKS ONLY when the session already holds the authority, and otherwise says
  // plainly that this view is an administrator one in this release rather than
  // firing a call it knows will be refused. (Handover bounded question Q2.)
  const loadChain = useCallback(async () => {
    try {
      const warrantResponse = await authenticatedFetch(`${API_BASE}/warrants`);
      if (warrantResponse.ok) {
        const data = await warrantResponse.json();
        const all = Array.isArray(data?.warrants) ? data.warrants : [];
        setWarrants(all.filter((w: any) => String(w?.holderPrincipalId ?? '') === connection.principalId));
      }
      if (!isRoot) {
        setChainNote('Standing object grants on a connection are an administrator view in this release.');
        return;
      }
      const grantResponse = await authenticatedFetch(`${API_BASE}/principals/${connection.principalId}/grants`);
      if (grantResponse.ok) {
        const data = await grantResponse.json();
        setGrants(Array.isArray(data?.grants) ? data.grants : []);
      } else {
        setChainNote('The board did not disclose the object grants under this connection to this session.');
      }
    } catch {
      setChainNote('The chain detail could not be read.');
    }
  }, [connection.principalId, isRoot]);

  useEffect(() => { loadChain(); }, [loadChain]);

  const scopes = credential?.scopes ?? [];
  // The credential's own scope set, shown against the ceiling it was cut from.
  const ceiling = useMemo(
    () => Array.from(new Set([...accountScopes, ...scopes])).sort(),
    [accountScopes, scopes],
  );

  return (
    <div className="conn-advanced">
      <p className="conn-note">
        The manual path, for edge cases. The day-one flow is Setup; nothing here is needed to get a
        connection working.
      </p>

      <section className="conn-adv-section" aria-labelledby={`conn-adv-scopes-${connection.principalId}`}>
        <h3 id={`conn-adv-scopes-${connection.principalId}`}>What it can do</h3>
        <ScopeNarrowing
          available={ceiling}
          selected={scopes}
          readOnly
          idPrefix={`conn-adv-${connection.principalId}`}
        />
        <p className="conn-note">
          A credential&rsquo;s authority is fixed when it is issued: regeneration copies the scope set
          and the transport pin verbatim, and the board refuses a regeneration that tries to change
          either. To narrow this connection, make a narrower one and disable this.
        </p>
      </section>

      <section className="conn-adv-section" aria-labelledby={`conn-adv-pin-${connection.principalId}`}>
        <h3 id={`conn-adv-pin-${connection.principalId}`}>Transport and expiry</h3>
        <dl className="conn-facts">
          <dt>Transport pin</dt>
          <dd>
            {transport === 'any'
              ? 'any — this credential works through the MCP endpoint and the REST API'
              : transport === 'mcp'
                ? 'mcp — accepted through the MCP endpoint, refused on every REST route'
                : 'api — accepted on the REST API, refused through the MCP endpoint'}
          </dd>
          <dt>Expires</dt>
          <dd>{credential?.expiresAt ? new Date(credential.expiresAt).toLocaleString() : 'no expiry set'}</dd>
          <dt>Board address</dt>
          <dd><code className="conn-inline-code">{connection.service.slug}</code></dd>
          <dt>Times its secret has been re-revealed</dt>
          <dd>{credential?.revealCount ?? 0}</dd>
        </dl>
      </section>

      <section className="conn-adv-section" aria-labelledby={`conn-adv-agents-${connection.principalId}`}>
        <h3 id={`conn-adv-agents-${connection.principalId}`}>Agents minted beneath it</h3>
        {connection.agents.length === 0 ? (
          <p className="conn-note">None. Agents appear here when this connection mints one for a task.</p>
        ) : (
          <ul className="conn-agents">
            {connection.agents.map((agent) => (
              <li key={agent.id} className="conn-agent">
                <span className="conn-agent-handle">{agent.displayName || agent.handle}</span>
                <span className="conn-agent-meta">
                  {agent.terminatedAt ? 'terminated' : agent.status}
                  {agent.boundTaskId ? ` · bound to task ${agent.boundTaskId.slice(0, 8)}` : ' · not task-bound'}
                  {agent.mintedUnderWarrantId ? ' · minted under a warrant' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="conn-adv-section" aria-labelledby={`conn-adv-warrants-${connection.principalId}`}>
        <h3 id={`conn-adv-warrants-${connection.principalId}`}>Warrants and grants</h3>
        {warrants.length === 0
          ? <p className="conn-note">This connection holds no warrant.</p>
          : (
            <ul className="conn-warrants">
              {warrants.map((warrant) => (
                <li key={String(warrant.id)} className="conn-warrant">
                  <span className="conn-warrant-name">{String(warrant.name)}</span>
                  <span className="conn-agent-meta">{String(warrant.status)}</span>
                </li>
              ))}
            </ul>
          )}
        {grants.length === 0
          ? <p className="conn-note">No standing object grants sit on this connection; short-lived, task-bound grants are issued as work arrives and expire with it.</p>
          : (
            <ul className="conn-grants">
              {grants.map((grant, index) => (
                <li key={String(grant.id ?? index)} className="conn-grant">
                  {String(grant.verb ?? '')} on {String(grant.resourceType ?? '')}
                  {grant.resourceId ? ` ${String(grant.resourceId).slice(0, 8)}` : ' (all of that type)'}
                </li>
              ))}
            </ul>
          )}
        {chainNote && <p className="conn-note" role="status">{chainNote}</p>}
        {accountId && connection.purpose && <p className="conn-note">{connection.purpose}</p>}
      </section>

      <div className="conn-actions">
        <Button
          variant="secondary"
          icon={<RefreshCw size={16} />}
          disabled={!credential || busy || !mayRegenerate}
          title={mayRegenerate ? undefined : REGENERATE_ADMIN_ONLY}
          onClick={onRegenerate}
        >
          Regenerate credential
        </Button>
        <Button
          variant="danger"
          icon={<ShieldOff size={16} />}
          disabled={!credential || busy || credential.state === 'revoked'}
          onClick={onDisable}
        >
          Disable
        </Button>
      </div>
      {!mayRegenerate && (
        <p className="conn-note">
          {REGENERATE_ADMIN_ONLY}. Until that changes, replace a lost credential by connecting a new
          agent and disabling this one.
        </p>
      )}
    </div>
  );
};
