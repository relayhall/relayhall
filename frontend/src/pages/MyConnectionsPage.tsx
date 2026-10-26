import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, Loader2, Plug, RefreshCw, ShieldOff, Sliders,
} from 'lucide-react';
import { Button } from '../components/Button';
import { authenticatedFetch } from '../utils/auth';
import { useMyPrincipal } from '../hooks/usePrincipals';
import { useMyConnections } from '../hooks/useMyConnections';
import { CreateIdentityWizard } from '../components/identity/CreateIdentityWizard';
import { BootstrapPane } from '../components/connections/BootstrapPane';
import { CredentialPermissionsEditor } from '../components/connections/CredentialPermissionsEditor';
import {
  Connection, ConnectionCredential, ConnectionTransport,
  REGENERATE_ADMIN_ONLY, kindLabelForDescription, lostCredentialRecovery,
  installLineFor, installNoteFor, mayRegenerateCredential, templateForDescription,
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
 * Which credential the "Credential to edit" picker starts on (E476 finding).
 * The actions beneath it (revoke, regenerate) act on exactly ONE credential,
 * so a connection that holds several starts on NO pick: a press must follow a
 * choice, never a guess at which credential was meant. A connection with
 * exactly one credential has nothing to choose between and stays preselected.
 */
function initialCredentialId(connection: Connection): string {
  return connection.credentials.length === 1 ? connection.credentials[0].id : '';
}

/**
 * The grace window the page asks for when it replaces a credential's secret.
 * Sent explicitly (it equals the board's default) so the sentence on the
 * button is true by construction, not by coincidence with a server default.
 */
const REPLACE_GRACE_HOURS = 24;

const credentialName = (item: ConnectionCredential): string => item.label || item.keyId || 'Unlabelled credential';

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

/* Card ff410dc4 (SQ-4): a connection that can no longer act - its Connector
   disabled, or its credential revoked, expired or replaced past its grace -
   stays readable but folds into one collapsed section with a count, so the
   live connections are not interleaved with dead ones. Nothing is deleted. */
const FOLDED_ROW_STATES: ReadonlySet<RowState> = new Set<RowState>(['disabled', 'revoked', 'expired', 'replaced']);

export function isFoldedConnection(connection: Connection): boolean {
  return FOLDED_ROW_STATES.has(rowStateOf(connection));
}

export const MyConnectionsPage: React.FC = () => {
  const { me, scopes, delegableScopes, loading: principalLoading } = useMyPrincipal();
  const { connections, instructions, mayLoosenCredentialTransport, loading, unavailable, failed, reload } = useMyConnections();
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

      {connections.length > 0 && (() => {
        const renderRow = (connection: Connection) => (
          <ConnectionRow
            key={connection.principalId}
            connection={connection}
            instructions={instructions}
            isRoot={isRoot}
            accountScopes={Array.isArray(scopes) ? scopes : []}
            delegableScopes={delegableScopes}
            mayLoosenCredentialTransport={mayLoosenCredentialTransport}
            accountId={me?.id ?? null}
            onChanged={reload}
            surface={(kind, message) => {
              if (kind === 'error') { setError(message); setNotice(null); }
              else { setNotice(message); setError(null); }
            }}
          />
        );
        const live = connections.filter((connection) => !isFoldedConnection(connection));
        const folded = connections.filter(isFoldedConnection);
        return (
          <>
            {live.length > 0 && <ul className="conn-list">{live.map(renderRow)}</ul>}
            {folded.length > 0 && (
              <details className="conn-folded">
                <summary className="conn-folded-summary">Non-active connections ({folded.length})</summary>
                <ul className="conn-list">{folded.map(renderRow)}</ul>
              </details>
            )}
          </>
        );
      })()}
    </div>
  );
};

const ConnectionRow: React.FC<{
  connection: Connection;
  instructions: ReturnType<typeof useMyConnections>['instructions'];
  isRoot: boolean;
  accountScopes: string[];
  delegableScopes: string[] | null | undefined;
  mayLoosenCredentialTransport: boolean;
  accountId: string | null;
  onChanged: () => void;
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ connection, instructions, isRoot, accountScopes, delegableScopes, mayLoosenCredentialTransport, accountId, onChanged, surface }) => {
  const [open, setOpen] = useState<'none' | 'setup' | 'advanced'>('none');
  const [busy, setBusy] = useState(false);
  // Keep the exact choice across refreshes. If that credential disappears, do
  // not silently switch an open editor to another live credential.
  const [selectedCredentialId, setSelectedCredentialId] = useState(() => initialCredentialId(connection));
  const [editorLocked, setEditorLocked] = useState(false);
  const credential = connection.credentials.find((item) => item.id === selectedCredentialId) ?? null;
  // A pick that was made and has since vanished is a different situation from
  // no pick yet: the first asks the person to choose again, the second asks
  // them to choose at all.
  const selectionVanished = selectedCredentialId !== '' && !credential;
  const setupAvailable = !selectionVanished && connection.credentials.length > 0;
  const state = rowStateOf(connection);
  const template = templateForDescription(connection.service.description);
  const transport = (credential?.transport ?? template?.transport ?? 'any') as ConnectionTransport;
  const detailId = `conn-detail-${connection.principalId}`;

  const toggleOwnerControl = async () => {
    setBusy(true);
    try {
      const enabled = !connection.ownerControl;
      const response = await authenticatedFetch(`${API_BASE}/principals/${connection.principalId}/owner-control`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, reason: enabled
          ? 'Appointed as Main by the account owner in My connections'
          : 'Main appointment revoked by the account owner in My connections' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { surface('error', data.error || 'The Main appointment could not be changed.'); return; }
      surface('notice', enabled ? 'Main appointed for your owned resources. Existing credential limits still apply.'
        : 'Main appointment removed. Delegated worker permissions are unchanged.');
      onChanged();
    } catch { surface('error', 'Could not reach the board.'); }
    finally { setBusy(false); }
  };

  // Both acts take the id the person confirmed and refuse if the picker has
  // moved since: a press can only ever land on the credential it named.
  const revoke = async (credentialId: string) => {
    if (!credential || credential.id !== credentialId) return;
    setBusy(true);
    try {
      const response = await authenticatedFetch(`${API_BASE}/credentials/${credential.id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'revoked by its owner from My connections' }),
      });
      if (!response.ok) {
        surface('error', 'The board refused to revoke that credential.');
        return;
      }
      surface('notice', `Credential ${credential.keyId ?? credential.id} (${credentialName(credential)}) for ${connection.service.name} is revoked. Calls using that credential are refused; other credentials on the connection are unchanged; the connector stays enabled.`);
      onChanged();
    } catch {
      surface('error', 'Could not reach the board.');
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (credentialId: string) => {
    if (!credential || credential.id !== credentialId) return;
    setBusy(true);
    try {
      const response = await authenticatedFetch(`${API_BASE}/credentials/${credential.id}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graceHours: REPLACE_GRACE_HOURS }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        surface('error', data?.message || 'The board refused the regeneration.');
        return;
      }
      // Rotating MINTS a new credential: the route answers with the new
      // credential's id and key id, and the key id it replaces. The secret
      // shown belongs to the new key id, so that is the one the notice names.
      const newKeyId = data.keyId ?? data.id ?? 'the new credential';
      const previousKeyId = data.previousKeyId ?? credential.keyId ?? credential.id;
      surface('notice', `Replacement secret for new key id ${newKeyId} on ${connection.service.name}: ${data.secretOnce} — shown once, copy it now. It replaces ${previousKeyId} (${credentialName(credential)}), which keeps working for ${data.graceHours ?? REPLACE_GRACE_HOURS} hours. Only that credential was replaced. This is not a revoke, and the connection's other credentials are unchanged.`);
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
        <span className="conn-item-meta">Connection last seen {relative(connection.lastSeenAt)}</span>
        <div className="conn-item-tools">
          <Button variant="secondary" size="compact" disabled={busy || editorLocked || connection.status !== 'active'}
            onClick={toggleOwnerControl}>
            {connection.ownerControl ? 'Remove Main appointment' : 'Appoint as Main'}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            ariaExpanded={open === 'setup'}
            ariaControls={detailId}
            disabled={editorLocked}
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
            disabled={editorLocked}
            onClick={() => setOpen(open === 'advanced' ? 'none' : 'advanced')}
          >
            Advanced
          </Button>
        </div>
      </div>

      {open !== 'none' && (
        <div className="conn-item-detail" id={detailId}>
          {(connection.credentials.length > 1 || (connection.credentials.length > 0 && !credential)) && (
            <div className="conn-credential-choice">
              <label htmlFor={`conn-credential-${connection.principalId}`}>Credential to edit</label>
              <select id={`conn-credential-${connection.principalId}`} value={credential?.id ?? ''}
                disabled={busy || editorLocked}
                onChange={(event) => setSelectedCredentialId(event.target.value)}>
                {!credential && <option value="">Choose a credential…</option>}
                {connection.credentials.map((item) => (
                  <option key={item.id} value={item.id}>
                    {credentialName(item)} · {item.transport} · {item.state} · {item.id}
                  </option>
                ))}
              </select>
              {open === 'advanced' && credential && <p className="conn-note">Changing credentials discards unsaved permission edits.</p>}
              {selectionVanished && <p role="status" className="conn-note">The previously selected credential is no longer available. Choose another credential.</p>}
            </div>
          )}
          {open === 'setup' && (<><Button variant="secondary" disabled={!credential || editorLocked} onClick={() => setOpen('advanced')}>Edit permissions</Button>{
            setupAvailable && instructions ? (
              <BootstrapPane
                mcpConfig={instructions.mcpConfig}
                cliEnv={instructions.cliEnv}
                bootstrapLine={instructions.bootstrapLine}
                bootstrapPrompt={instructions.bootstrapPrompt}
                configurationGuidance={instructions.configurationGuidance}
                installLine={installLineFor(template, instructions.boardEndpoint)}
                installNote={installNoteFor(template)}
                boardEndpoint={instructions.boardEndpoint}
                transport={transport}
                initialTab={template?.defaultTab}
                carriesSecret={false}
                recovery={lostCredentialRecovery(accountScopes)}
              />
            ) : setupAvailable ? (
              <p className="conn-note">The board did not return the setup instructions for this session.</p>
            ) : <p className="conn-note">Choose an available credential to see its setup instructions.</p>
          }</>)}

          {open === 'advanced' && (
            <AdvancedTab
              key={`${accountId ?? 'unknown'}:${connection.principalId}:${isRoot ? 'root' : 'member'}`}
              connection={connection}
              credential={credential}
              selectionVanished={selectionVanished}
              accountScopes={accountScopes}
              delegableScopes={delegableScopes}
              mayLoosenCredentialTransport={mayLoosenCredentialTransport}
              onChanged={onChanged}
              accountId={accountId}
              isRoot={isRoot}
              busy={busy || editorLocked}
              onRevoke={revoke}
              onRegenerate={regenerate}
              onEditorLockedChange={setEditorLocked}
            />
          )}
        </div>
      )}
    </li>
  );
};

type DetailRow = Record<string, unknown>;
type DetailRead =
  | { status: 'loading' }
  | { status: 'ready'; items: DetailRow[] }
  | { status: 'unavailable'; message: string };
type GrantRead = DetailRead | { status: 'inaccessible' };

const isDetailRow = (row: unknown): row is DetailRow =>
  typeof row === 'object' && row !== null && !Array.isArray(row);
const isWarrantRow = (row: unknown): row is DetailRow =>
  isDetailRow(row) && typeof row.id === 'string' && typeof row.name === 'string'
  && typeof row.status === 'string' && typeof row.holderPrincipalId === 'string';
const isGrantRow = (row: unknown): row is DetailRow =>
  isDetailRow(row) && typeof row.id === 'string' && typeof row.verb === 'string'
  && typeof row.resourceType === 'string'
  && (row.resourceId === null || (typeof row.resourceId === 'string' && row.resourceId.trim().length > 0));

async function readDetailRows(
  url: string, field: 'warrants' | 'grants', valid: (row: unknown) => row is DetailRow,
  denied: string, failed: string, malformed: string,
): Promise<DetailRead> {
  try {
    const response = await authenticatedFetch(url);
    if (!response.ok) {
      return { status: 'unavailable', message: [401, 403, 404].includes(response.status) ? denied : failed };
    }
    const data = await response.json();
    const rows: unknown = data?.[field];
    if (data?.success !== true || !Array.isArray(rows) || !rows.every(valid)) return { status: 'unavailable', message: malformed };
    return { status: 'ready', items: rows };
  } catch {
    return { status: 'unavailable', message: failed };
  }
}

const AdvancedTab: React.FC<{
  connection: Connection;
  credential: ConnectionCredential | null;
  selectionVanished: boolean;
  accountScopes: string[];
  delegableScopes: string[] | null | undefined;
  mayLoosenCredentialTransport: boolean;
  accountId: string | null;
  isRoot: boolean;
  busy: boolean;
  onChanged: () => void;
  onRevoke: (credentialId: string) => Promise<void>;
  onRegenerate: (credentialId: string) => Promise<void>;
  onEditorLockedChange: (locked: boolean) => void;
}> = ({ connection, credential, selectionVanished, accountScopes, delegableScopes, mayLoosenCredentialTransport, accountId, isRoot, busy, onChanged, onRevoke, onRegenerate, onEditorLockedChange }) => {
  // This is an introspection panel, not a grant. It reads warrants through the
  // caller's self-scoped route; another principal's direct object grants are
  // requested only by a root session, exactly as the existing backend gate
  // permits. A skipped or failed read must never look like an empty result.
  const mayRegenerate = mayRegenerateCredential(accountScopes);
  const [warrants, setWarrants] = useState<DetailRead>({ status: 'loading' });
  const [grants, setGrants] = useState<GrantRead>(isRoot ? { status: 'loading' } : { status: 'inaccessible' });
  const requestSeq = useRef(0);
  const [agentBusy, setAgentBusy] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  // The in-page revoke confirmation. It holds the id the person asked about;
  // it is shown only while the picker still points at that same credential, so
  // a second press can never land on a different one than the panel names.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmRef = useRef<HTMLElement | null>(null);
  const revokeWrapRef = useRef<HTMLSpanElement | null>(null);
  const scopesHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusAfterClose = useRef<'trigger' | 'heading' | null>(null);
  const confirming = credential !== null && confirmingId === credential.id;
  const closeConfirmation = (returnFocusTo: 'trigger' | 'heading' | null) => {
    focusAfterClose.current = returnFocusTo;
    setConfirmingId(null);
  };
  useEffect(() => {
    // The picker moved away from the credential being confirmed: drop the
    // confirmation without taking focus from the control the person is using.
    if (confirmingId !== null && credential?.id !== confirmingId) setConfirmingId(null);
  }, [confirmingId, credential?.id]);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (confirmingId !== null || focusAfterClose.current === null) return;
    const target = focusAfterClose.current;
    focusAfterClose.current = null;
    if (target === 'trigger') revokeWrapRef.current?.querySelector('button')?.focus();
    else scopesHeadingRef.current?.focus();
  }, [confirmingId]);
  const confirmRevoke = () => {
    if (!credential || confirmingId !== credential.id) return;
    const id = credential.id;
    closeConfirmation('heading');
    void onRevoke(id);
  };

  const revokeAgent = async (agent: Connection['agents'][number]) => {
    setAgentBusy(agent.id); setAgentError(null);
    try {
      for (const live of agent.credentials.filter(c => c.state === 'live' || c.state === 'graced')) {
        const response = await authenticatedFetch(`${API_BASE}/credentials/${live.id}/revoke`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'Agent credential revoked by the owner in My connections' }),
        });
        if (!response.ok) throw new Error('The board refused an agent credential revocation. Refresh to see any credentials already revoked.');
      }
    } catch (e) { setAgentError(e instanceof Error ? e.message : 'Could not revoke agent credentials.'); }
    finally { setAgentBusy(null); onChanged(); }
  };

  const loadChain = useCallback(() => {
    const seq = ++requestSeq.current;
    setWarrants({ status: 'loading' });
    setGrants(isRoot ? { status: 'loading' } : { status: 'inaccessible' });
    void readDetailRows(
      `${API_BASE}/warrants`, 'warrants', isWarrantRow,
      'The board did not disclose warrants to this session.',
      'Could not read warrants from the board.',
      'The board returned an incomplete warrant response.',
    ).then((result) => {
      if (seq !== requestSeq.current) return;
      setWarrants(result.status === 'ready'
        ? { status: 'ready', items: result.items.filter((row) => row.holderPrincipalId === connection.principalId) }
        : result);
    });
    if (!isRoot) return;
    void readDetailRows(
      `${API_BASE}/principals/${connection.principalId}/grants`, 'grants', isGrantRow,
      'The board did not disclose direct object grants to this session.',
      'Could not read direct object grants from the board.',
      'The board returned an incomplete direct-grant response.',
    ).then((result) => { if (seq === requestSeq.current) setGrants(result); });
  }, [connection.principalId, isRoot]);

  useEffect(() => {
    loadChain();
    return () => { requestSeq.current += 1; };
  }, [loadChain]);

  const pid = connection.principalId;
  const replaceHelpId = `conn-replace-help-${pid}`;
  const revokeHelpId = `conn-revoke-help-${pid}`;
  const pickHintId = `conn-pick-hint-${pid}`;
  const stateHintId = `conn-state-hint-${pid}`;
  // The board refuses to rotate a credential that is already replaced or
  // revoked (ROTATE_FROM_RETIRED), so the button waits for a live one.
  const notLive = credential !== null && credential.state !== 'live';
  const confirmTitleId = `conn-confirm-title-${pid}`;
  const confirmTextId = `conn-confirm-text-${pid}`;

  const transport = credential?.transport;
  const transportDescription = !credential
    ? 'No credential transport pin is available.'
    : transport === 'any'
      ? 'any — this credential works through the MCP endpoint and the REST API'
      : transport === 'mcp'
        ? 'mcp — accepted through the MCP endpoint, refused on every REST route'
        : transport === 'api'
          ? 'api — accepted on the REST API, refused through the MCP endpoint'
          : 'The board did not report a recognized transport pin for this credential.';
  // The keyed tab remounts if the Account/root authority changes. This extra
  // guard prevents a transient stale grant display before an effect reload.
  const visibleGrants: GrantRead = isRoot ? grants : { status: 'inaccessible' };

  return (
    <div className="conn-advanced">
      <p className="conn-note">
        The manual path, for edge cases. The day-one flow is Setup; nothing here is needed to get a
        connection working.
      </p>

      <section className="conn-adv-section" aria-labelledby={`conn-adv-scopes-${connection.principalId}`}>
        <h3 id={`conn-adv-scopes-${connection.principalId}`} ref={scopesHeadingRef} tabIndex={-1} className="conn-focus-target">Scopes on this credential</h3>
        {credential ? (
          <>
            <p className="conn-note">
              Showing credential <code className="conn-inline-code">{credential.keyId ?? credential.id}</code>
              {credential.label ? ` (${credential.label})` : ''}, state {credential.state}.
              {connection.credentials.length > 1 ? ` This is one of ${connection.credentials.length} credentials on this connection.` : ''}
            </p>
            <p className="conn-note">
              These scopes belong to the credential shown, not the connection&rsquo;s effective authority.
              Access can also depend on current Account authority, grants, warrants and route policy.
            </p>
            <CredentialPermissionsEditor
              key={`${credential.id}:${credential.scopes.join(',')}:${credential.transport}:${credential.state}`}
              credential={credential} delegableScopes={delegableScopes}
              mayLoosenTransport={mayLoosenCredentialTransport}
              onChanged={onChanged} onLockedChange={onEditorLockedChange} />
          </>
        ) : connection.credentials.length === 0 ? (
          <p className="conn-note">No credential is available for this connection.</p>
        ) : selectionVanished ? (
          <p className="conn-note">The credential you picked is gone from this connection. Choose another credential in the picker above to see its scopes and to use the actions below.</p>
        ) : (
          <p className="conn-note">No credential is picked yet. Choose one in the picker above to see its scopes and to use the actions below.</p>
        )}
      </section>

      <section className="conn-adv-section" aria-labelledby={`conn-adv-pin-${connection.principalId}`}>
        <h3 id={`conn-adv-pin-${connection.principalId}`}>Credential transport, expiry and use</h3>
        <dl className="conn-facts">
          <dt>Transport pin</dt><dd>{transportDescription}</dd>
          <dt>Expires</dt><dd>{credential ? credential.expiresAt ? new Date(credential.expiresAt).toLocaleString() : 'no expiry set' : 'No credential to describe.'}</dd>
          <dt>Credential last used</dt><dd>{credential ? relative(credential.lastUsedAt) : 'No credential to describe.'}</dd>
          <dt>Board address</dt><dd><code className="conn-inline-code">{connection.service.slug}</code></dd>
          <dt>Times its secret has been re-revealed</dt><dd>{credential?.revealCount ?? 'No credential to describe.'}</dd>
        </dl>
      </section>

      <section className="conn-adv-section" aria-labelledby={`conn-adv-agents-${connection.principalId}`}>
        <h3 id={`conn-adv-agents-${connection.principalId}`}>Agents minted beneath it</h3>
        {agentError && <p role="alert" className="conn-error">{agentError}</p>}
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
                {!agent.terminatedAt && agent.status === 'active' && <Button variant="danger" size="compact"
                  disabled={agentBusy !== null || !agent.credentials.some(c => c.state === 'live' || c.state === 'graced')}
                  onClick={() => void revokeAgent(agent)}>Revoke agent credentials</Button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="conn-adv-section" aria-labelledby={`conn-adv-warrants-${connection.principalId}`}>
        <div className="conn-adv-heading">
          <h3 id={`conn-adv-warrants-${connection.principalId}`}>Warrants and direct object grants</h3>
          <button type="button" className="conn-linkbtn" onClick={loadChain}>Refresh details</button>
        </div>
        {warrants.status === 'loading'
          ? <p className="conn-note" role="status">Loading warrants…</p>
          : warrants.status === 'unavailable'
            ? <p className="conn-note" role="status">{warrants.message}</p>
            : warrants.items.length === 0
              ? <p className="conn-note">This connection holds no warrant.</p>
              : (
                <ul className="conn-warrants">
                  {warrants.items.map((warrant) => (
                    <li key={String(warrant.id)} className="conn-warrant">
                      <span className="conn-warrant-name">{String(warrant.name)}</span>
                      <span className="conn-agent-meta">{String(warrant.status)}</span>
                    </li>
                  ))}
                </ul>
              )}
        {visibleGrants.status === 'inaccessible'
          ? <p className="conn-note">Direct object grants are an administrator view in this release.</p>
          : visibleGrants.status === 'loading'
            ? <p className="conn-note" role="status">Loading direct object grants…</p>
            : visibleGrants.status === 'unavailable'
              ? <p className="conn-note" role="status">{visibleGrants.message}</p>
              : visibleGrants.items.length === 0
                ? <p className="conn-note">No direct standing object grants were returned for this connection.</p>
                : (
                  <ul className="conn-grants">
                    {visibleGrants.items.map((grant, index) => (
                      <li key={String(grant.id ?? index)} className="conn-grant">
                        {String(grant.verb)} on {String(grant.resourceType)}
                        {grant.resourceId ? ` ${String(grant.resourceId).slice(0, 8)}` : ' (all of that type)'}
                      </li>
                    ))}
                  </ul>
                )}
        <p className="conn-note">These direct rows do not summarize inherited or effective access.</p>
        {accountId && connection.purpose && <p className="conn-note">{connection.purpose}</p>}
      </section>

      <div className="conn-action-help">
        <p id={replaceHelpId} className="conn-note">
          Replacing the secret applies to the picked credential only. The old secret keeps working for {REPLACE_GRACE_HOURS} hours,
          then stops. This is not a revoke, and the connection&rsquo;s other credentials are untouched.
        </p>
        <p id={revokeHelpId} className="conn-note">
          Revoking stops calls that use the picked credential. It leaves the connection&rsquo;s other credentials, and the
          connector itself, as they are.
        </p>
        {!credential && (
          <p id={pickHintId} className="conn-note">
            Choose a credential in the picker above first; these actions apply to one credential at a time.
          </p>
        )}
        {credential && notLive && (
          <p id={stateHintId} className="conn-note">
            Only a live credential can be regenerated; the picked one is {credential.state}.
          </p>
        )}
      </div>

      <div className="conn-actions">
        <Button
          variant="secondary"
          icon={<RefreshCw size={16} />}
          disabled={!credential || notLive || busy || !mayRegenerate || confirming}
          title={mayRegenerate ? undefined : REGENERATE_ADMIN_ONLY}
          ariaDescribedBy={`${replaceHelpId}${credential ? '' : ` ${pickHintId}`}${notLive ? ` ${stateHintId}` : ''}`}
          onClick={() => { if (credential) void onRegenerate(credential.id); }}
        >
          Regenerate credential
        </Button>
        <span ref={revokeWrapRef}>
          <Button
            variant="danger"
            icon={<ShieldOff size={16} />}
            disabled={!credential || busy || credential.state === 'revoked'}
            ariaDescribedBy={`${revokeHelpId}${credential ? '' : ` ${pickHintId}`}`}
            onClick={() => { if (credential) setConfirmingId(credential.id); }}
          >
            Revoke this credential
          </Button>
        </span>
      </div>

      {confirming && credential && (
        <section
          ref={confirmRef}
          tabIndex={-1}
          role="alertdialog"
          aria-labelledby={confirmTitleId}
          aria-describedby={confirmTextId}
          className="conn-confirm"
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.stopPropagation(); closeConfirmation('trigger'); }
          }}
        >
          <h4 id={confirmTitleId} className="conn-confirm-title">Revoke this credential?</h4>
          <dl className="conn-facts">
            <dt>Label</dt><dd>{credentialName(credential)}</dd>
            <dt>Key id</dt><dd><code className="conn-inline-code">{credential.keyId ?? 'none'}</code></dd>
            <dt>Transport</dt><dd>{credential.transport}</dd>
            <dt>Credential id</dt><dd><code className="conn-inline-code">{credential.id}</code></dd>
          </dl>
          <p id={confirmTextId} className="conn-note">
            Calls using this credential will be refused; the other credentials on this connection are unchanged; the connector stays enabled.
          </p>
          <div className="conn-actions">
            <Button variant="secondary" onClick={() => closeConfirmation('trigger')}>Cancel</Button>
            <Button variant="danger" icon={<ShieldOff size={16} />} disabled={busy} onClick={confirmRevoke}>Yes, revoke this credential</Button>
          </div>
        </section>
      )}
      {!mayRegenerate && (
        <p className="conn-note">
          {REGENERATE_ADMIN_ONLY}. Until that changes, replace a lost credential by connecting a new
          agent and revoking this credential.
        </p>
      )}
    </div>
  );
};
