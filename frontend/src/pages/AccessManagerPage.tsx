import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthorityPreviewTable, type AuthorityPreviewData } from '../components/AuthorityPreviewTable';
import { useSearchParams } from 'react-router-dom';
import { Fingerprint,
  AlertTriangle, Eye, FileKey2, KeyRound, Loader2,
  RefreshCw, ScrollText, ShieldCheck, Stamp,
} from 'lucide-react';
import { Button } from '../components/Button';
import { Select } from '../components/ui/Select';
import { ConfirmationModal } from '../components/ConfirmationModal';
import { StepUpDialog } from '../components/access/StepUpDialog';
import { STEP_UP_RETRY_DESCRIPTION, useStepUpRetry } from '../components/access/useStepUpRetry';
import { sendWithStepUpRetry, type StepUpChallenge } from '../utils/stepUpChallenge';
import { SetPasswordPanel } from '../components/access/SetPasswordPanel';
import { SharedWritersPanel } from '../components/access/SharedWritersPanel';
import { useRelayHallConfig } from '../contexts/RelayHallConfigContext';
import { GroupStewardsPanel } from '../components/access/GroupStewardsPanel';
import { principalLabel, readJson, ruleSummary, type ProfileRule, type StepUpRequest } from '../components/access/accessShared';
import { CeilingRulesField } from '../components/access/CeilingRulesField';
import { ceilingRuleProblems, rowsToRules, type CeilingRuleRow } from '../components/access/ceilingRules';
import { ApprovalsQueue } from '../components/approvals/ApprovalsQueue';
import { useMyPrincipal, usePrincipals } from '../hooks/usePrincipals';
import type { Principal } from '../types/task';
import { authenticatedFetch } from '../utils/auth';
import { formatInstantForDateTimeLocal } from '../utils/dateFormat';
import { assignableBy, mayChangeRoles } from '../utils/administratorSession';
import { useRoleCatalogue } from '../hooks/useRoleCatalogue';
import { RoleCatalogueList, RoleSelectionExplanation } from '../components/access/RoleExplanation';
import {
  isRoleChangeTarget, roleChangeNotice, RoleChangeConfirmation, ROLE_CHANGE_STEP_UP_DESCRIPTION, sendRoleChange,
} from '../components/access/roleChange';
import './AccessManagerPage.css';

/**
 * The Access manager (AZ-S4, card aa48fb12; design 4d961e37 A17.9/§9.5) —
 * the GUI surface for the AZ-S4 slice scope: the pending-Approval queue
 * with edit-before-approve (§6.1, T7 board-only decisions under step-up),
 * the Warrant registry with per-warrant minted-identity lists and
 * suspension flags (§6.4), the granted-access inventory (what-if over the
 * live evaluator tables), credential reveals with reveal counters (§7.1,
 * step-up), and the §10 remediation queues with the directory staleness
 * alarms. Connector creation/narrowing, previews-for-self and the session
 * mint dialog's CLI/REST parity ride later slices per §13.
 */

import { AGENT_WORKING_SCOPES } from '../types/connections';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

interface WarrantItem {
  id: string;
  name: string;
  description: string;
  holderPrincipalId: string;
  status: 'active' | 'suspended' | 'revoked' | 'expired';
  ceilingProfileName: string | null;
  ceilingProfileVersionNumber: number | null;
  /** The pinned version's profile and id (`WarrantService` mapWarrant). The
   * detail panel reads the pinned rules through them; optional because older
   * fixtures and payloads may omit them, and an absent pin reads nothing. */
  ceilingProfileId?: string | null;
  ceilingProfileVersionId?: string | null;
  /** Inline rules on the warrant row itself. Every warrant created since
   * AZ-A3 stores NULL here and pins a profile version instead
   * (`WarrantService.create` inserts `ceiling_rules` as NULL), so this is
   * non-null only for rows written before that. */
  ceilingRules: ProfileRule[] | null;
  ceilingScopes: string[] | null;
  expiresAt: string | null;
  transportPin: string;
  maxConcurrent: number | null;
  maxTotal: number | null;
  mintedTotal: number;
  liveMinted: number;
  suspendedReason: string | null;
  anchors: Array<{ anchorType: string; anchorId: string }>;
}

interface MintedIdentity {
  principalId: string;
  handle: string;
  status: string;
  boundTaskId: string | null;
  live: boolean;
  createdAt: string;
}

/**
 * THE ROLE CONTROL (owner ruling `60307311` §1.2).
 *
 * The People half of the identity plane: pick an Account, give it a role. It
 * is the GUI seam onto `POST /principals/:id/role` and it shares that route's
 * every refusal — the server is the authority, and the panel renders the
 * refusal it is given rather than pre-judging it. What the panel decides
 * locally is only what to OFFER: the role list is narrowed by the viewer's own
 * role (`assignableBy`, the display half of `canAssignRole`), and the target
 * list excludes the identities the route refuses outright, so the common
 * refusals are unreachable rather than merely explained.
 *
 * The server asks for no step-up here, unlike the mint and reveal panels
 * beside it. The act is bounded by non-escalation and cannot exceed the
 * authority the session already holds, which is precisely the condition §7.6
 * reserves step-up for the absence of; should the route ever answer with the
 * step-up challenge, the shared act (`roleChange.tsx`) asks once through the
 * existing dialog. There IS a confirmation (card a2d1e317): it names the
 * Account, the role it carries now and the role it will carry, and shows the
 * new role's catalogue entry, so the person reads what they are giving before
 * the request is sent.
 *
 * Card caea70ef: the same act is offered on an identity's own detail page
 * (Identities → open a row). This panel stays the bulk view, and both call
 * the targets rule, the request and the confirmation in `roleChange.tsx`.
 *
 * EVERY ROLE EXPLANATION here comes from the board's role catalogue
 * (`GET /principals/roles`, rendered by `RoleExplanation`). There is no local
 * copy of what a role means: the list this panel used to carry was the second
 * hand-written list card a2d1e317 removes.
 */
const ROLE_DOCS_URL = 'https://github.com/relayhall/relayhall/blob/main/docs/roles.md';

const RolePanel: React.FC<{
  principals: Principal[];
  issuerRole: string | null;
  ownPrincipalId: string | null;
  onChanged?: () => void;
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ principals, issuerRole, ownPrincipalId, onChanged, surface }) => {
  const [principalId, setPrincipalId] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const catalogue = useRoleCatalogue();
  const { askForToken, retryDialog } = useStepUpRetry(ROLE_CHANGE_STEP_UP_DESCRIPTION);

  const roles = useMemo(() => assignableBy(issuerRole), [issuerRole]);

  /**
   * The targets the route can actually accept: never the caller's own row
   * (no self-promotion, and no self-demotion either), and never the two
   * identities it refuses by name — `system`, the request-less internal
   * actor, and the break-glass local administrator, whose role is fixed so
   * the deployment always has a way back in.
   */
  const targets = useMemo(
    () => principals.filter((p) => isRoleChangeTarget(p, ownPrincipalId)),
    [principals, ownPrincipalId],
  );

  const selected = targets.find((p) => p.id === principalId);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!principalId || !role) return;
    setConfirming(true);
  };

  const changeRole = async () => {
    setConfirming(false);
    if (!principalId || !role) return;
    setBusy(true);
    try {
      const data = await sendRoleChange(principalId, role, askForToken);
      surface('notice', roleChangeNotice(data));
      setRole('');
      onChanged?.();
    } catch (err) {
      surface('error', err instanceof Error ? err.message : 'The role could not be changed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="axm-section" aria-labelledby="axm-roles-heading">
      <div className="axm-section-head">
        <h2 id="axm-roles-heading"><Fingerprint aria-hidden="true" /> Roles</h2>
        <a href={ROLE_DOCS_URL} target="_blank" rel="noopener noreferrer">
          Role guide on GitHub
        </a>
      </div>
      <p className="axm-section-intro">
        An Account&rsquo;s role decides what it may reach. Changing one is an administrator-session
        act: it is audited with the before and after roles, it can never grant more than you hold,
        and it takes effect on that Account&rsquo;s next request &mdash; they do not need to sign in
        again. The break-glass identity and the internal <code>system</code> actor are
        not listed: the route refuses both by name.
      </p>
      <details className="axm-role-guide">
        <summary>Compare every role</summary>
        <p>Roles limit possible actions; object access also depends on ownership, grants, Task assignments and credential scopes.</p>
        <RoleCatalogueList catalogue={catalogue} />
      </details>
      <form className="axm-editor" onSubmit={submit} aria-label="Change a role">
        <div className="axm-editor-grid">
          <div className="form-group">
            <label htmlFor="axm-role-principal">Account</label>
            <Select
              id="axm-role-principal"
              required
              value={principalId}
              onChange={(event) => { setPrincipalId(event.target.value); setRole(''); }}
            >
              <option value="">Choose an identity&hellip;</option>
              {targets.map((principal) => (
                <option key={principal.id} value={principal.id}>
                  {principalLabel(principal)} &middot; {principal.kind} &middot; {principal.role || 'no role'}
                </option>
              ))}
            </Select>
          </div>
          <div className="form-group">
            <label htmlFor="axm-role-value">
              New role{' '}
              <span className="axm-muted">bounded by your own role</span>
            </label>
            <Select
              id="axm-role-value"
              aria-describedby="axm-role-description"
              required
              value={role}
              onChange={(event) => setRole(event.target.value)}
              disabled={!principalId}
            >
              <option value="">Choose a role&hellip;</option>
              {roles.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </Select>
            <div id="axm-role-description" aria-live="polite">
              <RoleSelectionExplanation
                catalogue={catalogue}
                role={role}
                emptyText="Choose a role to see what it may reach, or compare every role above."
              />
            </div>
          </div>
        </div>
        <div className="axm-decide-actions">
          {selected && (
            <span className="axm-muted" role="status">
              {principalLabel(selected)} currently carries the role {selected.role || 'none'}.
            </span>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !principalId || !role || role === selected?.role}
          >
            {busy ? 'Changing…' : 'Change role'}
          </Button>
        </div>
      </form>
      {confirming && selected && (
        <RoleChangeConfirmation
          principal={selected}
          role={role}
          catalogue={catalogue}
          onConfirm={changeRole}
          onCancel={() => setConfirming(false)}
        />
      )}
      {retryDialog}
    </section>
  );
};

export const AccessManagerPage: React.FC = () => {
  const { me, scopes, loading: authorityLoading } = useMyPrincipal();
  const { principals, reload: reloadPrincipals } = usePrincipals();
  const { config } = useRelayHallConfig();
  const [searchParams] = useSearchParams();
  const deepLinkApprovalId = searchParams.get('approval');
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // §6.1/AZ-16 (review 1897c959 B3): the Access manager admits EVERY
  // authenticated Account — the backend self-scope arm confines a non-root
  // session to its own subtree (404-concealed outside it). Only the
  // genuinely root-only surfaces (the cross-principal what-if inventory
  // and the §10 remediation queue) stay behind the root gate.
  const isRoot = Array.isArray(scopes)
    ? scopes.includes('root')
    : me?.role === 'admin' || me?.role === 'orchestrator';

  // LENSES-c c1-A: the Group roles read rides principals:read, as GET /groups
  // does; root also appoints and removes there. A session holding neither
  // would only be refused, so the sub-panel is not mounted for it.
  const canReadGroupRoles = isRoot
    || (Array.isArray(scopes) && (scopes.includes('principals:read') || scopes.includes('principals:admin')));

  const principalById = useMemo(() => new Map(principals.map((p) => [p.id, p])), [principals]);

  const surface = useCallback((kind: 'notice' | 'error', message: string) => {
    if (kind === 'notice') { setNotice(message); setError(null); }
    else { setError(message); setNotice(null); }
  }, []);

  if (authorityLoading) {
    return <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Checking authority…</div>;
  }
  if (!me) {
    return <div className="axm-error" role="alert">The Access manager needs a resolved identity for this session.</div>;
  }

  return (
    <div className="axm-page">
      <header className="axm-header">
        <div><ShieldCheck aria-hidden="true" /><h1>Access manager</h1></div>
      </header>
      <p className="axm-intro">
        Delegated access under the ratified authorization design: decide pending agent-mint approvals
        (editing authority down before approving), keep the warrant registry honest, inspect who holds
        what and from which source, reveal stored credentials under step-up, and work the remediation
        queues. Every act here is attributed in the audit ledger with its full identity chain.
      </p>
      {error && <div className="axm-error" role="alert">{error}</div>}
      {notice && <div className="axm-notice" role="status">{notice}</div>}

      {/* The queue is a shared component since card b1e3b16d (lane L1): the
          approvals hub mounts the same one. This mount is the Access manager
          panel, unchanged — its own filter, the published deep link
          expanding the item in place — plus one link into the hub. */}
      <ApprovalsQueue
        mount="access-manager"
        principalById={principalById}
        deepLinkApprovalId={deepLinkApprovalId}
        requestStepUp={setStepUp}
        surface={surface}
      />
      <MintAgentPanel requestStepUp={setStepUp} surface={surface} />
      <WarrantRegistry
        principals={principals}
        principalById={principalById}
        requestStepUp={setStepUp}
        surface={surface}
      />
      {/* Owner ruling 60307311 §1.2. Offered to administrators, which includes
          the `operator` role the root gate above excludes: an operator may
          change ordinary roles and may not create elevated ones, and the route
          enforces exactly that. */}
      {mayChangeRoles(me?.role ?? null, scopes) && (
        <RolePanel
          principals={principals}
          issuerRole={me?.role ?? null}
          ownPrincipalId={me?.id ?? null}
          onChanged={reloadPrincipals}
          surface={surface}
        />
      )}
      {/* Card bc5cd9f0. Same gate as the role control beside it, and for the
          same reason: both are administrator-session acts bounded by
          `canAssignRole`, and an operator who may change ordinary roles may
          give those Accounts a way in. The route enforces exactly that. */}
      {mayChangeRoles(me?.role ?? null, scopes) && (
        <SetPasswordPanel
          principals={principals}
          issuerRole={me?.role ?? null}
          ownPrincipalId={me?.id ?? null}
          surface={surface}
        />
      )}
      {/* Card 549cc51f (E298, E299): the shared-area writer list. Offered to
          the same administrator sessions as the two panels above; the panel
          asks the board for the administration view and renders nothing when
          the board refuses it, and every change is a root or administrator
          login-session act with a step-up, decided by the route. */}
      {mayChangeRoles(me?.role ?? null, scopes) && (
        <SharedWritersPanel
          principals={principals}
          requestStepUp={setStepUp}
          surface={surface}
          auditTrailAvailable={config.features.auditLog}
        />
      )}
      {isRoot && <InventoryPanel principals={principals} surface={surface} />}
      <RevealPanel principals={principals} requestStepUp={setStepUp} surface={surface} />
      {isRoot && <IdentityProviders surface={surface} />}
      {isRoot && <GroupDirectoryBindings surface={surface} />}
      {/* LENSES-c c1-A (card 46cfbd1d): the Group roles sub-panel. Every
          reader sees role, holder and the live/inert flag; appoint and remove
          are offered to a root session only, as the server allows. */}
      {canReadGroupRoles && <GroupStewardsPanel isRoot={isRoot} principals={principals} surface={surface} />}
      {isRoot && <RemediationQueues surface={surface} />}

      {stepUp && (
        <StepUpDialog
          action={stepUp.action}
          targetId={stepUp.targetId}
          description={stepUp.description}
          onToken={(token) => { const request = stepUp; setStepUp(null); request.onToken(token); }}
          onCancel={() => { const request = stepUp; setStepUp(null); request.onCancel?.(); }}
        />
      )}
    </div>
  );
};

/* ── Session mint (§6.1a/§9.2, AZ-S5): the GUI mint dialog ────────────── */

// Card 653be44f: declared ONCE in types/connections.ts and imported here, so
// the connection wizard's recommended set and this mint dialog cannot drift.
const MINTABLE_AGENT_SCOPES = AGENT_WORKING_SCOPES;

const MintAgentPanel: React.FC<{
  requestStepUp: (request: StepUpRequest) => void;
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ requestStepUp, surface }) => {
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<string[]>(['tasks:read']);
  const [busy, setBusy] = useState(false);
  interface MintedPackView {
    handle: string;
    secretOnce: string;
    bootstrapLine: string;
    bootstrapPrompt: string;
    cliEnv: string[];
    mcpGeneric: string;
    mcpClaudeCode: string;
    mcpCodex: string;
    scopes: string[];
    boundTaskId: string;
    expiresAt: string;
    previewPath: string;
    brief: string;
  }
  const [minted, setMinted] = useState<MintedPackView | null>(null);

  const toggleScope = (scope: string) => {
    setScopes((current) => current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]);
  };

  const mint = (event: React.FormEvent) => {
    event.preventDefault();
    if (!taskId.trim() || scopes.length === 0) return;
    const target = taskId.trim();
    requestStepUp({
      action: 'agent.mint',
      targetId: target,
      description: `Mint a task-bounded agent on task ${target.slice(0, 8)} with ${scopes.join(', ')}. You are requester and approver in one step-up-gated act; the credential pack renders once.`,
      onToken: async (stepUpToken) => {
        setBusy(true);
        try {
          const body: Record<string, unknown> = { targetTaskId: target, requestedScopes: scopes, stepUpToken };
          if (label.trim()) body.label = label.trim();
          const data = await readJson(await authenticatedFetch(`${API_BASE}/delegation/agent-mints`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          }));
          // §7.4/§8.5 (review a0411f86 B1): the ONE-TIME pack renders
          // COMPLETE — nothing is projected away, because nothing is
          // recoverable after dismissal.
          const onboarding = data.pack?.onboarding ?? {};
          const mcp = onboarding.mcpConfig ?? {};
          setMinted({
            handle: String(data.pack?.handle ?? ''),
            secretOnce: String(data.pack?.secretOnce ?? ''),
            bootstrapLine: String(onboarding.bootstrapLine ?? ''),
            bootstrapPrompt: String(onboarding.bootstrapPrompt ?? ''),
            cliEnv: Array.isArray(onboarding.cliEnv) ? onboarding.cliEnv : [],
            mcpGeneric: JSON.stringify(mcp.generic ?? {}, null, 2),
            mcpClaudeCode: JSON.stringify(mcp.claudeCode ?? {}, null, 2),
            mcpCodex: String(mcp.codex ?? ''),
            scopes: Array.isArray(onboarding.authoritySummary?.scopes) ? onboarding.authoritySummary.scopes : [],
            boundTaskId: String(onboarding.authoritySummary?.boundTaskId ?? data.pack?.boundTaskId ?? ''),
            expiresAt: String(data.pack?.expiresAt ?? ''),
            previewPath: String(onboarding.previewPath ?? ''),
            brief: String(onboarding.brief ?? ''),
          });
          surface('notice', 'Agent minted. The complete pack below renders exactly once and is never stored — capture everything you need now.');
        } catch (caught) {
          surface('error', caught instanceof Error ? caught.message : 'Could not mint the agent');
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <section className="axm-section" aria-labelledby="axm-mint-heading">
      <div className="axm-section-head">
        <h2 id="axm-mint-heading"><Stamp aria-hidden="true" /> Mint an agent</h2>
        <Button variant="primary" size="compact" onClick={() => setOpen((o) => !o)} ariaExpanded={open}>
          {open ? 'Close form' : 'New agent'}
        </Button>
      </div>
      <p className="axm-section-intro">
        The direct session mint: you are requester and approver in one step-up-gated act. The minted
        agent is bounded to its task — its write authority never leaves it, and its credential pack
        (endpoint, token, config, compiled brief) renders exactly once, never stored.
      </p>
      {open && (
        <form className="axm-editor" onSubmit={mint} aria-label="Mint a task-bounded agent">
          <div className="axm-editor-grid">
            <div className="form-group">
              <label htmlFor="axm-mint-task">Task id</label>
              <input id="axm-mint-task" className="form-input" type="text" required pattern="[0-9a-fA-F\-]{36}" value={taskId} onChange={(event) => setTaskId(event.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="axm-mint-label">Label <span className="axm-muted">optional</span></label>
              <input id="axm-mint-label" className="form-input" type="text" maxLength={128} value={label} onChange={(event) => setLabel(event.target.value)} />
            </div>
          </div>
          <h3>Scopes <small className="axm-muted">(within your own authority; root and admin verbs never mint)</small></h3>
          <div className="axm-chipset">
            {MINTABLE_AGENT_SCOPES.map((scope) => (
              <label key={scope} className={`axm-scope ${scopes.includes(scope) ? '' : 'axm-scope--dropped'}`}>
                <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} /> {scope}
              </label>
            ))}
          </div>
          <div className="axm-decide-actions">
            <Button type="submit" variant="primary" size="compact" disabled={busy || scopes.length === 0}>
              {busy ? 'Minting…' : 'Mint agent'}
            </Button>
          </div>
        </form>
      )}
      {minted && (
        <div className="axm-revealed axm-pack" role="status" aria-label="One-time agent onboarding pack">
          <div className="axm-pack-head">
            <strong>Minted {minted.handle} — the complete pack, shown once. Store it now:</strong>
            <Button variant="secondary" size="compact" onClick={() => setMinted(null)}>Dismiss</Button>
          </div>
          <p className="axm-muted">{minted.bootstrapLine}</p>
          <h4>Credential <span className="axm-muted">({minted.scopes.join(', ')} · task {minted.boundTaskId.slice(0, 8)} · expires {minted.expiresAt})</span></h4>
          <code>{minted.secretOnce}</code>
          <h4>CLI environment</h4>
          {minted.cliEnv.map((line) => <code key={line}>{line}</code>)}
          <h4>MCP config — Claude Code (.mcp.json)</h4>
          <pre className="axm-pack-pre">{minted.mcpClaudeCode}</pre>
          <h4>MCP config — Codex (config.toml)</h4>
          <pre className="axm-pack-pre">{minted.mcpCodex}</pre>
          <h4>MCP config — generic stdio</h4>
          <pre className="axm-pack-pre">{minted.mcpGeneric}</pre>
          {minted.bootstrapPrompt && (
            <>
              <h4>Bootstrap prompt <span className="axm-muted">(no credential inside; paste it into a fresh session)</span></h4>
              <pre className="axm-pack-pre">{minted.bootstrapPrompt}</pre>
            </>
          )}
          <h4>Effective-access preview</h4>
          <code>GET {minted.previewPath}</code>
          <h4>Compiled Brief</h4>
          <pre className="axm-pack-pre axm-pack-brief">{minted.brief}</pre>
        </div>
      )}
    </section>
  );
};

/* ── Warrants (§6.2–6.4): the registry ────────────────────────────────── */

/** RH-P3.AZ-S7 (R4): a not-yet-terminal task a revoke would unassign. */
interface DependentTask {
  id: string;
  title: string;
  status: string;
}

/**
 * WHAT A REVOKE WILL UNASSIGN, AND WHAT THIS VIEWER MAY BE TOLD ABOUT IT.
 *
 * Two different numbers, and conflating them is a defect in each direction.
 * The API narrows the NAMES - holding a warrant is not authority over the
 * Tasks riding it - and reports the COUNT whole, because the count is what a
 * revoke is acknowledged against. Review f0c51a8e B2: this page modelled only
 * the visible array, so a viewer who could read none of them was told
 * "Revoking it unassigns nothing" and the dialog then sent
 * `acknowledgeDependents: true` anyway.
 *
 * `total` is the number the operator decides on; `tasks` is what may be named;
 * `concealed` is the difference, stated rather than silently dropped.
 */
interface DependentSummary {
  tasks: DependentTask[];
  total: number;
  concealed: number;
}

/**
 * A COUNT IS A STATE, NOT A NUMBER (review `99ba9444` B2).
 *
 * The round-2 repair made the dialog decide on the COUNT rather than on what
 * it can name, and that is right wherever a count exists. It left the third
 * case: the count is not known YET, or is not knowable at all. Both call
 * sites read the absent entry through `?? 0`, so the panel said
 *
 *     "None. Revoking it unassigns nothing."
 *
 * during every first expansion, and kept saying it when the linkage read
 * failed. That sentence is a claim about the estate; an unanswered request is
 * not evidence for it. So the count is one of three things, absent is not one
 * of them, and UNKNOWN IS NEVER COERCED TO ZERO.
 */
export type DependentCount =
  | { state: 'counting' }
  | { state: 'uncounted'; reason: string }
  | ({ state: 'counted' } & DependentSummary);

/** What every reader sees before a response has been parsed. */
export const COUNTING: DependentCount = { state: 'counting' };

function uncounted(reason: string): DependentCount {
  return { state: 'uncounted', reason };
}

/**
 * A count is a finite, non-negative INTEGER. `typeof value === 'number'` is
 * not that test: it also admits NaN, Infinity, -1 and 0.5, and the shipped
 * helper duly composed the impossible sentence "3 ... Tasks ... 4 of them
 * cannot be named" for `{ total: 3, concealed: 4 }` (review `99ba9444`,
 * non-blocking observations).
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * THE ONE NORMALIZER. Both surfaces read the same three raw values through
 * it - the details panel had a second, laxer copy that defaulted a missing
 * `concealed` to zero instead of deriving the difference - and either it
 * returns a self-consistent count or it returns UNCOUNTED. It never repairs a
 * malformed response into a plausible number.
 */
export function readDependentCount(
  rawTasks: unknown, rawTotal: unknown, rawConcealed: unknown,
): DependentCount {
  if (!Array.isArray(rawTasks)) return uncounted('the response carried no Task list');
  const tasks = rawTasks as DependentTask[];

  let total: number;
  if (rawTotal === undefined) {
    // An OLDER response shape, which had no counts: what is listed is all of
    // it. The truthful reading of that shape, and still never zero-by-absence
    // - `tasks` was present and empty, which is a genuine none.
    total = tasks.length;
  } else if (!isCount(rawTotal)) {
    return uncounted('the response carried an unreadable count');
  } else {
    total = rawTotal;
  }

  let concealed: number;
  if (rawConcealed === undefined) {
    concealed = Math.max(total - tasks.length, 0);
  } else if (!isCount(rawConcealed)) {
    return uncounted('the response carried an unreadable count');
  } else {
    concealed = rawConcealed;
  }

  // THE INVARIANT IS AN EQUALITY, and round 1 finding P2 is why it has to be.
  // The one-sided form (`concealed < total - tasks.length`) admitted
  // `{tasks: [a, b], total: 3, concealed: 2}`: four Tasks classified for a
  // total of three, narrated as "3 not-yet-terminal Tasks … 2 of them cannot
  // be named" beside two named ones, and acknowledgeable. It is not a count.
  //
  // Both producers compute `concealed` as the exact difference — the whole
  // set minus the ones this viewer may read (`backend/src/routes/warrants.ts`
  // dependent-tasks and linkage) — so the named ones plus the withheld ones
  // ARE the total, and a response that says otherwise is malformed. If a
  // producer ever narrows the NAMES for a second reason (a page, a cap), this
  // fails closed and says it could not count, which is the correct answer
  // until this rule is taught the new contract.
  if (total < tasks.length || concealed !== total - tasks.length) {
    return uncounted('the response counts contradict each other');
  }
  return { state: 'counted', tasks, total, concealed };
}

/** `GET /warrants/:id/dependent-tasks` — the dialog's count. */
export function dependentTasksCount(payload: unknown): DependentCount {
  const body = (payload ?? {}) as Record<string, unknown>;
  return readDependentCount(body.tasks, body.total, body.concealed);
}

/** `GET /warrants/:id/linkage` — the details panel's count, same normalizer. */
export function warrantLinkageCount(payload: unknown): DependentCount {
  const body = (payload ?? {}) as Record<string, unknown>;
  return readDependentCount(body.carriedTasks, body.carriedTotal, body.carriedConcealed);
}

/**
 * The sentence a revoke surface may say about what it will unassign.
 *
 * EXPORTED because it is the coordinate of review f0c51a8e B2: the rule is
 * that this never reports "nothing" while anything is concealed OR while the
 * count is unknown, and a rule that lives inside a page cannot be asserted
 * without rendering the page.
 */
export function unassignmentSentence(count: DependentCount): string {
  if (count.state === 'counting') {
    return 'Still counting what a revoke would unassign…';
  }
  if (count.state === 'uncounted') {
    return `Could not count what a revoke would unassign — ${count.reason}. This cannot be acknowledged until it counts.`;
  }
  if (count.total === 0) return 'No not-yet-terminal Task rides this warrant, so nothing is unassigned.';
  const plural = count.total === 1 ? '' : 's';
  const head = `${count.total} not-yet-terminal Task${plural} ride this warrant and will be UNASSIGNED`;
  if (count.concealed === 0) return `${head}.`;
  if (count.concealed === count.total) {
    return `${head} — none of them can be named here, because they sit on Tasks you may not read.`;
  }
  return `${head} — ${count.concealed} of them cannot be named here, because they sit on Tasks you may not read.`;
}

/** An acknowledgement is an acknowledgement OF a number. There is no number
 * to acknowledge until the count is counted, so the confirm stays disabled. */
export function acknowledgementReady(count: DependentCount): boolean {
  return count.state === 'counted';
}

/** The confirm label carries the number the operator is acknowledging - the
 * TOTAL, never the length of what happens to be nameable. */
export function revokeConfirmLabel(count: DependentCount): string {
  if (count.state === 'counting') return 'Still counting…';
  if (count.state === 'uncounted') return 'Cannot revoke — count unknown';
  return count.total > 0 ? `Revoke and unassign ${count.total}` : 'Revoke';
}

const EMPTY_WARRANT_DRAFT = {
  name: '', holderPrincipalId: '', anchorType: 'task', anchorId: '',
  ceilingProfileId: '', ceilingScopes: '', expiresAt: '', maxConcurrent: '', maxTotal: '',
  transportPin: 'any',
};

/**
 * THE PINNED CEILING RULES a warrant's details list (card 785e1eed, lane P2-F).
 *
 * An entry is a STATE, for the reason `DependentCount` is: an empty list must
 * never stand in for "not read yet" or "could not be read", because a ceiling
 * that reads as having no rules reads as having no authority.
 *
 * Where the rules come from: a warrant written before AZ-A3 carries them
 * inline (`ceilingRules`); every later warrant stores NULL there and pins a
 * profile VERSION, whose rules `GET /access-profiles/:id/versions` returns
 * (principals:read, the same authority the form's profile list already
 * needs). The pinned version is found by its id, never by "the latest": a
 * republished profile never widens a standing warrant, so its newest version
 * is not the warrant's ceiling.
 */
type PinnedRules =
  | { state: 'reading' }
  | { state: 'read'; rules: ProfileRule[] }
  | { state: 'unreadable'; reason: string }
  | { state: 'unpinned' };

function normalisedRules(rules: unknown[]): ProfileRule[] {
  return rules.filter((rule): rule is Record<string, unknown> => typeof rule === 'object' && rule !== null)
    .map((rule) => ({
      resourceType: String(rule.resourceType ?? ''),
      selectorForm: rule.selectorForm as ProfileRule['selectorForm'],
      selectorIds: Array.isArray(rule.selectorIds) ? rule.selectorIds.map(String) : [],
      verbs: Array.isArray(rule.verbs) ? rule.verbs.map(String) : [],
    }));
}

function initialPinnedRules(warrant: WarrantItem | undefined): PinnedRules {
  if (!warrant) return { state: 'unpinned' };
  if (Array.isArray(warrant.ceilingRules) && warrant.ceilingRules.length > 0) {
    return { state: 'read', rules: normalisedRules(warrant.ceilingRules) };
  }
  if (warrant.ceilingProfileId && warrant.ceilingProfileVersionId) return { state: 'reading' };
  return { state: 'unpinned' };
}

function pinnedVersionRules(data: unknown, versionId: string): PinnedRules {
  const versions = (data as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(versions)) return { state: 'unreadable', reason: 'the profile history came back without a version list' };
  const pinned = versions.find((version) => (version as { id?: unknown } | null)?.id === versionId) as { rules?: unknown } | undefined;
  if (!pinned) return { state: 'unreadable', reason: 'the pinned version is not in the profile history' };
  if (!Array.isArray(pinned.rules)) return { state: 'unreadable', reason: 'the pinned version came back without its rules' };
  return { state: 'read', rules: normalisedRules(pinned.rules) };
}

const PinnedRulesList: React.FC<{ pinned: PinnedRules }> = ({ pinned }) => {
  if (pinned.state === 'unpinned') return null;
  if (pinned.state === 'reading') return <p className="axm-muted" role="status">Reading the pinned rules…</p>;
  if (pinned.state === 'unreadable') {
    return <p className="axm-muted" role="status">The pinned rules could not be read: {pinned.reason}</p>;
  }
  if (pinned.rules.length === 0) return <p className="axm-muted">The pinned version carries no object rules.</p>;
  return (
    <ul className="axm-minted" aria-label="Pinned ceiling rules">
      {pinned.rules.map((rule, index) => (
        <li key={`${rule.resourceType}-${index}`}>
          {ruleSummary(rule)}
          {rule.selectorIds.length > 0 && ' · '}
          {rule.selectorIds.map((id, at) => (
            <React.Fragment key={id}>{at > 0 && ' '}<code>{id.slice(0, 8)}</code></React.Fragment>
          ))}
        </li>
      ))}
    </ul>
  );
};

/** A non-2xx answer from `POST /warrants`, kept whole: the form shows it verbatim. */
interface WarrantRefusal {
  status: number;
  code: string | null;
  message: string;
  errorId: string | null;
}

const WarrantRegistry: React.FC<{
  principals: Principal[];
  principalById: Map<string, Principal>;
  requestStepUp: (request: StepUpRequest) => void;
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ principals, principalById, requestStepUp, surface }) => {
  const [warrants, setWarrants] = useState<WarrantItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [mintedFailure, setMintedFailure] = useState<Record<string, string>>({});
  const [minted, setMinted] = useState<Record<string, MintedIdentity[]>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editWarrant, setEditWarrant] = useState<WarrantItem | null>(null);
  const [editLifetime, setEditLifetime] = useState<'keep' | 'until-task'>('until-task');
  const [editTask, setEditTask] = useState('');
  const [editRevert, setEditRevert] = useState('');
  const [narrowAgents, setNarrowAgents] = useState(false);
  const [editWarning, setEditWarning] = useState<{ count: DependentCount; proceed: () => void } | null>(null);
  // Card 72b8fb97 (SU-33): the second ask when a warrant act answers the
  // step-up challenge, through the page's one dialog, for exactly the
  // challenge's binding; null when the person cancels.
  const askAgain = (challenge: StepUpChallenge) => new Promise<string | null>((resolve) => requestStepUp({
    action: challenge.action, targetId: challenge.targetId, description: STEP_UP_RETRY_DESCRIPTION,
    onToken: resolve, onCancel: () => resolve(null),
  }));

  const [draft, setDraft] = useState({ ...EMPTY_WARRANT_DRAFT });
  // Lane P2-F: the ceiling-rules field. The rows live here, beside the draft,
  // because this component owns the exclusion with the profile selector and
  // the submit; `rulesAttempted` turns the problem list on after a refused
  // submit and keeps it live while the rows are fixed.
  const [ruleRows, setRuleRows] = useState<CeilingRuleRow[]>([]);
  const [rulesAttempted, setRulesAttempted] = useState(false);
  const [refusal, setRefusal] = useState<WarrantRefusal | null>(null);
  const [pinned, setPinned] = useState<Record<string, PinnedRules>>({});
  const ruleProblems = rulesAttempted && ruleRows.length > 0 ? ceilingRuleProblems(ruleRows) : null;
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string; publishedVersionNumber: number | null }>>([]);
  // RH-P3.AZ-S7 (ruling 7440b579 R4/R5): the dependent-task warning a
  // revoke must show first, and the assignments each warrant carries.
  const [revokeTarget, setRevokeTarget] = useState<{ warrant: WarrantItem; dependents: DependentCount } | null>(null);
  // One entry per EXPANDED warrant, and the entry is a state: an absent
  // entry is not a zero, it is a panel that has not asked yet.
  const [carried, setCarried] = useState<Record<string, DependentCount>>({});
  /** Which expansion a response belongs to, so a stale one cannot land. */
  const expansionRef = useRef(0);

  const holders = useMemo(
    () => principals.filter((p) => p.kind === 'service' && p.status === 'active'),
    [principals],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await readJson(await authenticatedFetch(`${API_BASE}/warrants`));
      setWarrants(Array.isArray(data.warrants) ? data.warrants : []);
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'Could not load warrants');
    } finally {
      setLoading(false);
    }
  }, [surface]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    authenticatedFetch(`${API_BASE}/access-profiles`)
      .then(readJson)
      .then((data) => setProfiles(Array.isArray(data.profiles) ? data.profiles : []))
      .catch(() => setProfiles([]));
  }, []);

  const expand = async (warrantId: string) => {
    if (expandedId === warrantId) { setExpandedId(null); return; }
    setExpandedId(warrantId);
    setMintedFailure(current => { const next = { ...current }; delete next[warrantId]; return next; });
    // Installed in the SAME commit as `expandedId`, before either request is
    // even issued: the panel renders as soon as the id is set, and it must
    // have a state to render (review `99ba9444` B2 — the first expansion
    // transiently claimed a revoke unassigns nothing).
    setCarried((current) => ({ ...current, [warrantId]: COUNTING }));
    // Lane P2-F: the pinned rules get their state in the same commit, for the
    // same reason - the panel renders as soon as the id is set.
    const warrant = warrants.find((item) => item.id === warrantId);
    const pinnedStart = initialPinnedRules(warrant);
    setPinned((current) => ({ ...current, [warrantId]: pinnedStart }));
    // ONE TOKEN PER EXPANSION. Collapse-and-re-expand, or two expansions
    // racing, could otherwise let an older response overwrite a newer one for
    // the same warrant (round 1, non-blocking observation). A result is
    // accepted only while its own expansion is still the current one.
    const generation = expansionRef.current + 1;
    expansionRef.current = generation;
    const stillCurrent = () => expansionRef.current === generation;

    // TWO READS, TWO FAILURE DOMAINS — and round 1 finding P3 is why they are
    // STARTED before either is awaited. Separate `try` blocks isolate
    // rejection; they do not isolate NON-settlement, so a hung
    // `GET /warrants/:id` used to prevent the linkage request from even being
    // issued and the count could stay COUNTING for ever on a failure of an
    // unrelated read. Both requests are in flight before the first `await`.
    const detail = (async () => readJson(await authenticatedFetch(`${API_BASE}/warrants/${warrantId}`)))();
    const linkage = (async () => readJson(await authenticatedFetch(`${API_BASE}/warrants/${warrantId}/linkage`)))();
    // A THIRD read and a third failure domain, started with the other two:
    // the pinned version's rules, only when the row pins a version and does
    // not carry its rules inline.
    const pinnedProfileId = warrant?.ceilingProfileId ?? null;
    const pinnedVersionId = warrant?.ceilingProfileVersionId ?? null;
    const versions = pinnedStart.state === 'reading' && pinnedProfileId && pinnedVersionId
      ? (async () => readJson(await authenticatedFetch(`${API_BASE}/access-profiles/${pinnedProfileId}/versions`)))()
      : null;

    // And each one SETTLES on its own. Starting both is not enough: awaiting
    // them in sequence would still hold the count behind the other read, which
    // is the shape round 1 found. Each promise carries its own success and
    // failure handler, so neither can delay the other by any amount.
    const applyDetail = detail.then(
      (data) => {
        if (!stillCurrent()) return;
        setMinted((current) => ({ ...current, [warrantId]: Array.isArray(data.mintedIdentities) ? data.mintedIdentities : [] }));
      },
      (caught) => {
        if (stillCurrent()) setMintedFailure(current => ({ ...current, [warrantId]: caught instanceof Error ? caught.message : 'Could not load the warrant' }));
        surface('error', caught instanceof Error ? caught.message : 'Could not load the warrant');
      },
    );
    const applyLinkage = linkage.then(
      (linked) => {
        if (!stillCurrent()) return;
        setCarried((current) => ({ ...current, [warrantId]: warrantLinkageCount(linked) }));
      },
      (caught) => {
        const message = caught instanceof Error ? caught.message : 'the linkage could not be read';
        surface('error', message);
        // The failure is RECORDED, not dropped. Without this the entry stays
        // COUNTING for ever, which is honest but useless; with the old code it
        // stayed absent, which read as zero and was a lie.
        if (stillCurrent()) {
          setCarried((current) => ({ ...current, [warrantId]: { state: 'uncounted', reason: message } }));
        }
      },
    );
    // Its failure is shown in the panel it belongs to and nowhere else: a
    // session without principals:read cannot read profile history, and that
    // is a fact about this list, not an error about the page.
    const applyPinned = versions && pinnedVersionId
      ? versions.then(
        (data) => {
          if (!stillCurrent()) return;
          setPinned((current) => ({ ...current, [warrantId]: pinnedVersionRules(data, pinnedVersionId) }));
        },
        (caught) => {
          if (!stillCurrent()) return;
          const reason = caught instanceof Error ? caught.message : 'the profile history could not be read';
          setPinned((current) => ({ ...current, [warrantId]: { state: 'unreadable', reason } }));
        },
      )
      : Promise.resolve();
    await Promise.allSettled([applyDetail, applyLinkage, applyPinned]);
  };

  /** R4: revocation WARNS with the enumerated list of dependent
   * not-yet-terminal tasks before it does anything. The dialog is the
   * warning; confirming it is the "proceed" the ruling names, and the
   * server refuses an unacknowledged revoke independently — the dialog is
   * the courtesy, not the control. */
  const askToRevoke = async (warrant: WarrantItem) => {
    setBusyId(warrant.id);
    // The dialog opens on the state it is actually in. It may not open on a
    // number it does not have, and its acknowledgement stays disabled until a
    // successfully parsed response establishes one.
    setRevokeTarget({ warrant, dependents: COUNTING });
    const settle = (dependents: DependentCount) => setRevokeTarget(
      (current) => (current && current.warrant.id === warrant.id ? { warrant: current.warrant, dependents } : current),
    );
    try {
      const data = await readJson(await authenticatedFetch(`${API_BASE}/warrants/${warrant.id}/dependent-tasks`));
      settle(dependentTasksCount(data));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'the dependent tasks could not be read';
      surface('error', message);
      settle({ state: 'uncounted', reason: message });
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (warrant: WarrantItem) => {
    setBusyId(warrant.id);
    try {
      await readJson(await authenticatedFetch(`${API_BASE}/warrants/${warrant.id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledgeDependents: true }),
      }));
      surface('notice', 'Warrant revoked: dependent tasks unassigned, no new mints, running agent leases stop extending. The record and its provenance stay.');
      setRevokeTarget(null);
      await load();
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'Could not revoke the warrant');
    } finally {
      setBusyId(null);
    }
  };

  const resume = (warrant: WarrantItem) => {
    requestStepUp({
      action: 'warrant.resume',
      targetId: warrant.id,
      description: `Resume the suspended warrant “${warrant.name}” — this is the re-approval act; the creator live-cap is re-proven first.`,
      onToken: async (stepUpToken) => {
        setBusyId(warrant.id);
        try {
          await readJson(await authenticatedFetch(`${API_BASE}/warrants/${warrant.id}/resume`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepUpToken }),
          }));
          surface('notice', 'Warrant resumed.');
          await load();
        } catch (caught) {
          surface('error', caught instanceof Error ? caught.message : 'Could not resume the warrant');
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  const revokeMintedAgent = async (identity: MintedIdentity, warrantId: string) => {
    if (!window.confirm(`Revoke every live credential for Agent ${identity.handle}? Its identity and history stay.`)) return;
    setBusyId(identity.principalId);
    try {
      const listed = await readJson(await authenticatedFetch(`${API_BASE}/principals/${identity.principalId}/credentials`));
      if (!Array.isArray(listed.credentials)) throw new Error('Agent credentials could not be read');
      for (const credential of listed.credentials) {
        if (credential.revokedAt || (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())) continue;
        await readJson(await authenticatedFetch(`${API_BASE}/credentials/${credential.id}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Agent credential revoked from warrant registry' }) }));
      }
      const refreshed = await readJson(await authenticatedFetch(`${API_BASE}/warrants/${warrantId}`));
      setMinted(current => ({ ...current, [warrantId]: Array.isArray(refreshed.mintedIdentities) ? refreshed.mintedIdentities : [] }));
      surface('notice', 'Agent credentials revoked; identity and history preserved.'); await load();
    } catch (caught) { surface('error', caught instanceof Error ? caught.message : 'Could not revoke Agent credentials. Refresh to see any completed revocations.'); }
    finally { setBusyId(null); }
  };

  const editFields = (): Record<string, unknown> => {
    if (!editWarrant) return {};
    const fields: Record<string, unknown> = {};
    const originalExpiry = formatInstantForDateTimeLocal(editWarrant.expiresAt ?? '').slice(0, 16);
    const expiry = draft.expiresAt === originalExpiry ? editWarrant.expiresAt : draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null;
    const scopes = draft.ceilingScopes.trim() ? draft.ceilingScopes.split(',').map(value => value.trim()).filter(Boolean) : null;
    if (JSON.stringify(scopes) !== JSON.stringify(editWarrant.ceilingScopes)) fields.ceilingScopes = scopes;
    if (expiry !== editWarrant.expiresAt) fields.expiresAt = expiry;
    if (draft.transportPin !== editWarrant.transportPin) fields.transportPin = draft.transportPin;
    for (const key of ['maxConcurrent', 'maxTotal'] as const) {
      const value = draft[key] ? Number(draft[key]) : null;
      if (value !== editWarrant[key]) fields[key] = value;
    }
    if (ruleRows.length) fields.ceilingRules = rowsToRules(ruleRows);
    else if (draft.ceilingProfileId) fields.ceilingProfileId = draft.ceilingProfileId;
    return fields;
  };
  const fieldsNow = editWarrant ? editFields() : {};
  const ceilingChanged = 'ceilingRules' in fieldsNow || 'ceilingProfileId' in fieldsNow;
  // Profile containment is proved by the server. Until read and proven locally,
  // a changed ceiling receives conservative widening confirmation.
  const knownPinned = editWarrant ? pinned[editWarrant.id] ?? initialPinnedRules(editWarrant) : { state: 'unpinned' as const };
  const rulesNarrow = ruleRows.length > 0 && knownPinned.state === 'read' && rowsToRules(ruleRows).every(rule => rule.verbs.every(verb => knownPinned.rules.some(source => {
    if (source.resourceType !== rule.resourceType || !source.verbs.includes(verb)) return false;
    const ids = rule.selectorIds ?? [];
    if (source.selectorForm === 'all-of-type') return true;
    if (source.selectorForm === 'all-except') return rule.selectorForm === 'exact' ? ids.every(id => !source.selectorIds.includes(id)) : rule.selectorForm === 'all-except' && source.selectorIds.every(id => ids.includes(id));
    if (source.selectorForm === 'all-in-project') return rule.selectorForm === 'all-in-project' && ids.every(id => source.selectorIds.includes(id));
    return source.selectorForm === rule.selectorForm && ids.every(id => source.selectorIds.includes(id));
  })));
  const editWidens = editWarrant !== null && ((ceilingChanged && !rulesNarrow)
    || ('ceilingScopes' in fieldsNow && editWarrant.ceilingScopes !== null && (fieldsNow.ceilingScopes === null || (fieldsNow.ceilingScopes as string[]).some(scope => !editWarrant.ceilingScopes!.includes(scope))))
    || (['maxConcurrent', 'maxTotal'] as const).some(key => key in fieldsNow && editWarrant[key] !== null && (fieldsNow[key] === null || Number(fieldsNow[key]) > editWarrant[key]!))
    || ('expiresAt' in fieldsNow && editWarrant.expiresAt !== null && (fieldsNow.expiresAt === null || Date.parse(String(fieldsNow.expiresAt)) > Date.parse(editWarrant.expiresAt)))
    || ('transportPin' in fieldsNow && editWarrant.transportPin !== 'any'));
  const saveWarrantEdit = async () => {
    if (!editWarrant || busyId !== null) return;
    setRulesAttempted(true);
    if (ruleRows.length && ceilingRuleProblems(ruleRows).length) return;
    if (editWidens && editLifetime === 'until-task' && !editTask.trim() && !editRevert) return;
    const warrant = editWarrant;
    const fields = editFields();
    if (!Object.keys(fields).length) { surface('notice', 'No authority fields changed.'); return; }
    const apply = async (acknowledgeDependents: boolean, stepUpToken?: string) => {
      setBusyId(warrant.id);
      try {
        const bodyWith = (token: string | undefined) => ({ ...fields, acknowledgeDependents, ...(!editWidens && narrowAgents ? { narrowAgents: true } : {}), ...(token ? { stepUpToken: token, lifetime: editLifetime === 'keep' ? { choice: 'keep' } : { choice: 'until-task', ...(editTask.trim() ? { taskId: editTask.trim() } : {}), ...(editRevert ? { revertAt: new Date(editRevert).toISOString() } : {}) } } : {}) });
        const send = (token: string | undefined) => authenticatedFetch(`${API_BASE}/warrants/${warrant.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyWith(token)) });
        // Card 72b8fb97 (SU-33): a widening whose token no longer counts is
        // answered with the challenge for (warrant.edit, id); the SAME edit
        // is sent ONE more time with the token the person confirms.
        const sent = stepUpToken
          ? await sendWithStepUpRetry(send, stepUpToken, { action: 'warrant.edit', targetId: warrant.id }, askAgain)
          : await (async () => { const response = await send(undefined); return { response, body: await response.json() }; })();
        const response = sent.response;
        const data = (sent.body ?? {}) as Record<string, any>;
        if (!response.ok || !data.success) throw new Error(`${data.code ? `${data.code}: ` : ''}${data.message || data.error || 'Could not edit the warrant'}`);
        surface('notice', `Warrant edit applied (${data.edit?.direction || 'saved'}). ${data.edit?.narrowedAgents?.length || 0} Agents narrowed; ${data.edit?.revokedAgents?.length || 0} revoked. The record and provenance stay.`);
        setEditWarrant(null); setCreating(false); setRuleRows([]); await load(); const refreshed = await readJson(await authenticatedFetch(`${API_BASE}/warrants/${warrant.id}`)); setMinted(current => ({ ...current, [warrant.id]: Array.isArray(refreshed.mintedIdentities) ? refreshed.mintedIdentities : [] })); setExpandedId(warrant.id);
      } catch (caught) { surface('error', caught instanceof Error ? caught.message : 'Could not edit the warrant'); }
      finally { setBusyId(null); }
    };
    const proceed = (acknowledge: boolean) => {
      if (editWidens) requestStepUp({ action: 'warrant.edit', targetId: warrant.id, description: `Confirm the edit to “${warrant.name}” with lifetime ${editLifetime === 'keep' ? 'keep' : 'until this task ends'}.`, onToken: token => apply(acknowledge, token) });
      else void apply(acknowledge);
    };
    if (!ceilingChanged) { proceed(false); return; }
    setEditWarning({ count: COUNTING, proceed: () => {} });
    try {
      const data = await readJson(await authenticatedFetch(`${API_BASE}/warrants/${warrant.id}/dependent-tasks`));
      setEditWarning({ count: dependentTasksCount(data), proceed: () => { setEditWarning(null); proceed(true); } });
    } catch (caught) { setEditWarning({ count: { state: 'uncounted', reason: caught instanceof Error ? caught.message : 'Could not read riding tasks' }, proceed: () => {} }); }
  };

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    if (editWarrant) { void saveWarrantEdit(); return; }
    if (!draft.holderPrincipalId || !draft.name.trim() || !draft.anchorId.trim()) return;
    setRefusal(null);
    // EXACTLY ONE CEILING FORM (AZ-31a; `WarrantService.prepareCreate`
    // refuses both and neither). The form cannot hold both - each control
    // disables the other - so the rules, when there are any, ARE the ceiling,
    // and the profile is sent only when there are none. Neither is the
    // existing behaviour: the profile selector is then `required`.
    let ceilingRules: ReturnType<typeof rowsToRules> | null = null;
    if (ruleRows.length > 0) {
      const problems = ceilingRuleProblems(ruleRows);
      setRulesAttempted(true);
      // Refused here, before step-up: a rule the server would refuse is not
      // worth a password, and the token would be burned by the refusal.
      if (problems.length > 0) return;
      ceilingRules = rowsToRules(ruleRows);
    }
    const ceilingWords = ceilingRules
      ? ` Its ceiling is the ${ceilingRules.length === 1 ? 'rule' : `${ceilingRules.length} rules`} you entered, published as this warrant's own Access profile.`
      : '';
    requestStepUp({
      action: 'warrant.create',
      targetId: draft.holderPrincipalId,
      description: `Create the standing warrant “${draft.name.trim()}” for ${principalLabel(principalById.get(draft.holderPrincipalId))} — its holder may then mint agents inside the anchor scope without per-spawn approval.${ceilingWords}`,
      onToken: async (stepUpToken) => {
        setBusyId('create');
        try {
          const body: Record<string, unknown> = {
            stepUpToken,
            name: draft.name.trim(),
            holderPrincipalId: draft.holderPrincipalId,
            anchors: [{ anchorType: draft.anchorType, anchorId: draft.anchorId.trim() }],
            transportPin: draft.transportPin,
          };
          if (ceilingRules) body.ceilingRules = ceilingRules;
          else if (draft.ceilingProfileId) body.ceilingProfileId = draft.ceilingProfileId;
          if (draft.ceilingScopes.trim()) body.ceilingScopes = draft.ceilingScopes.split(',').map((s) => s.trim()).filter(Boolean);
          if (draft.expiresAt) body.expiresAt = new Date(draft.expiresAt).toISOString();
          if (draft.maxConcurrent) body.maxConcurrent = Number(draft.maxConcurrent);
          if (draft.maxTotal) body.maxTotal = Number(draft.maxTotal);
          // Card 72b8fb97 (SU-33): a token that no longer counts when the
          // create arrives is answered with the challenge for
          // (warrant.create, holder); the SAME create is sent ONE more time
          // with the token the person confirms.
          const sent = await sendWithStepUpRetry(
            (token) => authenticatedFetch(`${API_BASE}/warrants`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stepUpToken: token }),
            }),
            stepUpToken,
            { action: 'warrant.create', targetId: draft.holderPrincipalId },
            askAgain,
          );
          const response = sent.response;
          // A REFUSAL IS SHOWN AS SENT. A 4xx is the server's answer about
          // this form's input - the rules, the anchor, the holder, the
          // step-up - so it renders verbatim inside the form, next to what
          // it is about, rather than paraphrased at the top of the page. A
          // 5xx renders there too, with its error id: a rule refusal raised by
          // AccessProfileService (`validateRules` and the selector checks)
          // reaches this route as a 500 WARRANT_CREATE_FAILED, because
          // `sendWarrantError` in routes/warrants.ts maps WarrantError and
          // StepUpError only - and the person at the form needs it either way.
          if (!response.ok) {
            const refused = sent.body as Record<string, unknown> | null;
            setRefusal({
              status: response.status,
              code: typeof refused?.code === 'string' ? refused.code : null,
              message: typeof refused?.message === 'string' ? refused.message
                : typeof refused?.error === 'string' ? refused.error
                  : `The server answered HTTP ${response.status} without a message.`,
              errorId: typeof refused?.errorId === 'string' ? refused.errorId : null,
            });
            return;
          }
          const created = (sent.body ?? {}) as { success?: boolean; message?: string; error?: string };
          if (created.success === false) throw new Error(created.message || created.error || `Request failed (${response.status})`);
          surface('notice', ceilingRules
            ? 'Warrant created: its ceiling rules were published as its own Access profile and that version is pinned.'
            : 'Warrant created and recorded with its pinned ceiling.');
          setDraft({ ...EMPTY_WARRANT_DRAFT });
          setRuleRows([]);
          setRulesAttempted(false);
          setCreating(false);
          await load();
        } catch (caught) {
          surface('error', caught instanceof Error ? caught.message : 'Could not create the warrant');
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  return (
    <section className="axm-section" aria-labelledby="axm-warrants-heading">
      <div className="axm-section-head">
        <h2 id="axm-warrants-heading"><ScrollText aria-hidden="true" /> Warrant registry</h2>
        <div className="axm-section-tools">
          <Button variant="secondary" size="compact" icon={<RefreshCw size={16} />} onClick={() => load()} ariaLabel="Refresh warrants">Refresh</Button>
          <Button variant="primary" size="compact" icon={<Stamp size={16} />} onClick={() => { if (editWarrant) { setEditWarrant(null); setDraft({ ...EMPTY_WARRANT_DRAFT }); setRuleRows([]); } setCreating((c) => !c); }} ariaExpanded={creating}>
            {creating ? 'Close form' : 'New warrant'}
          </Button>
        </div>
      </div>
      <p className="axm-section-intro">
        A warrant is the standing exception to per-mint approval: one holder, an anchor scope, a pinned
        authority ceiling and a mandatory expiry. The ceiling is a published Access profile, or rules
        entered with the warrant, which are published as its own profile in the same act; either way the
        version published at creation is pinned — republishing a profile never widens a standing warrant.
        Suspended warrants resume only through the re-approval act.
      </p>
      {creating && (
        <form className="axm-editor" onSubmit={create} aria-label={editWarrant ? "Edit a warrant" : "Create a warrant"}>
          <div className="axm-editor-grid">
            <div className="form-group">
              <label htmlFor="axm-w-name">Name</label>
              <input id="axm-w-name" disabled={Boolean(editWarrant)} className="form-input" type="text" required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="axm-w-holder">Holder (connector or service account)</label>
              <Select id="axm-w-holder" disabled={Boolean(editWarrant)} required value={draft.holderPrincipalId} onChange={(event) => setDraft({ ...draft, holderPrincipalId: event.target.value })}>
                <option value="">Choose a holder…</option>
                {holders.map((holder) => <option key={holder.id} value={holder.id}>{principalLabel(holder)}</option>)}
              </Select>
            </div>
            <div className="form-group">
              <label htmlFor="axm-w-anchor-type">Anchor</label>
              <Select id="axm-w-anchor-type" disabled={Boolean(editWarrant)} value={draft.anchorType} onChange={(event) => setDraft({ ...draft, anchorType: event.target.value })}>
                <option value="task">task</option>
                <option value="phase">phase</option>
                <option value="project">project</option>
              </Select>
            </div>
            <div className="form-group">
              <label htmlFor="axm-w-anchor-id">Anchor id</label>
              <input id="axm-w-anchor-id" disabled={Boolean(editWarrant)} className="form-input" type="text" required pattern="[0-9a-fA-F\-]{36}" value={draft.anchorId} onChange={(event) => setDraft({ ...draft, anchorId: event.target.value })} />
            </div>
            {/* THE CEILING, ONE OF TWO FORMS (lane P2-F). The profile selector
                and the rules field below exclude each other: rules disable the
                selector, a chosen profile disables the rules. With neither, the
                selector is required, exactly as before the rules existed. */}
            <div className="form-group axm-editor-wide">
              <label htmlFor="axm-w-profile">Ceiling profile (pins the published version)</label>
              <Select
                id="axm-w-profile"
                required={!editWarrant && ruleRows.length === 0}
                disabled={ruleRows.length > 0}
                aria-describedby={ruleRows.length > 0 ? 'axm-w-profile-hint' : undefined}
                value={ruleRows.length > 0 ? '' : draft.ceilingProfileId}
                onChange={(event) => setDraft({ ...draft, ceilingProfileId: event.target.value })}
              >
                <option value="">{editWarrant ? "Keep pinned ceiling" : "Choose a published profile…"}</option>
                {editWarrant?.ceilingProfileId && !profiles.some(profile => profile.id === editWarrant.ceilingProfileId) && <option value={editWarrant.ceilingProfileId}>{editWarrant.ceilingProfileName} (current pin)</option>}
                {profiles.filter((profile) => profile.publishedVersionNumber !== null).map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name} (v{profile.publishedVersionNumber})</option>
                ))}
              </Select>
              {ruleRows.length > 0 && (
                <p id="axm-w-profile-hint" className="axm-muted">
                  Off while ceiling rules are entered below. Remove every rule to choose a profile instead.
                </p>
              )}
            </div>
            <CeilingRulesField
              idPrefix="axm-w-rules"
              rows={ruleRows}
              onRowsChange={(rows) => { setRuleRows(rows); setRefusal(null); }}
              disabled={Boolean(draft.ceilingProfileId)}
              problems={ruleProblems}
            />
            <div className="form-group">
              <label htmlFor="axm-w-scopes">Scope ceiling <span className="axm-muted">optional, comma-separated</span></label>
              <input id="axm-w-scopes" className="form-input" type="text" placeholder="tasks:read, tasks:write, reports:write" value={draft.ceilingScopes} onChange={(event) => setDraft({ ...draft, ceilingScopes: event.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="axm-w-expiry">Expiry {draft.anchorType === 'task' ? <span className="axm-muted">optional for a single task (task-terminal)</span> : <span className="axm-muted">required</span>}</label>
              <input id="axm-w-expiry" className="form-input" type="datetime-local" required={draft.anchorType !== 'task' && !editWarrant} value={draft.expiresAt} onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="axm-w-transport">Transport pin</label>
              <Select id="axm-w-transport" value={draft.transportPin} onChange={(event) => setDraft({ ...draft, transportPin: event.target.value })}>
                <option value="any">any</option>
                <option value="mcp">mcp only</option>
                <option value="api">api only</option>
              </Select>
            </div>
            <div className="form-group">
              <label htmlFor="axm-w-max-concurrent">Max concurrent <span className="axm-muted">optional</span></label>
              <input id="axm-w-max-concurrent" className="form-input" type="number" min={1} value={draft.maxConcurrent} onChange={(event) => setDraft({ ...draft, maxConcurrent: event.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="axm-w-max-total">Max total <span className="axm-muted">optional</span></label>
              <input id="axm-w-max-total" className="form-input" type="number" min={1} value={draft.maxTotal} onChange={(event) => setDraft({ ...draft, maxTotal: event.target.value })} />
            </div>
          </div>
          {editWarrant && <>
            <h3>Edit {editWarrant.name}</h3>
            {editWidens ? <>
              <p>This change may widen authority and needs confirmation with a lifetime.</p>
              <label htmlFor="warrant-edit-lifetime">Lifetime for this edit</label><Select id="warrant-edit-lifetime" value={editLifetime} onChange={event => setEditLifetime(event.target.value as typeof editLifetime)}><option value="until-task">Until this task ends</option><option value="keep">Keep (until narrowed)</option></Select>
              {editLifetime === 'until-task' && <><label htmlFor="warrant-edit-task">Related task ID</label><input id="warrant-edit-task" pattern="[0-9a-fA-F-]{36}" value={editTask} onChange={event => setEditTask(event.target.value)} /><label htmlFor="warrant-edit-revert">Revert at (required without a task)</label><input id="warrant-edit-revert" type="datetime-local" required={!editTask.trim()} value={editRevert} onChange={event => setEditRevert(event.target.value)} /></>}
            </> : <label><input type="checkbox" checked={narrowAgents} onChange={event => setNarrowAgents(event.target.checked)} /> Narrow all live minted Agents to this ceiling (incompatible Agents are revoked)</label>}
            <Button type="button" onClick={() => { setEditWarrant(null); setCreating(false); setRuleRows([]); }}>Cancel edit</Button>
          </>}
          {refusal && (
            <div className="axm-error" role="alert">
              <strong>
                {refusal.status < 500 ? 'The server refused this warrant' : 'The server could not create this warrant'}
                {' '}(HTTP {refusal.status}{refusal.code ? `, ${refusal.code}` : ''}):
              </strong>{' '}
              {refusal.message}
              {refusal.errorId && <> (error id <code>{refusal.errorId}</code>)</>}
            </div>
          )}
          <div className="axm-decide-actions">
            <Button type="submit" variant="primary" size="compact" disabled={busyId !== null}>
              {busyId ? 'Working…' : editWarrant ? 'Save warrant edit' : 'Create warrant'}
            </Button>
          </div>
        </form>
      )}
      {loading ? (
        <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Loading warrants…</div>
      ) : warrants.length === 0 ? (
        <div className="axm-empty">No warrants. Every agent mint then needs a per-spawn approval.</div>
      ) : (
        <ul className="axm-list">
          {warrants.map((warrant) => {
            const expanded = expandedId === warrant.id;
            // An entry this panel has not asked for yet is COUNTING, never zero.
            const carriedCount = carried[warrant.id] ?? COUNTING;
            return (
              <li key={warrant.id} className="axm-item">
                <div className="axm-item-row">
                  <span className={`axm-status axm-status--${warrant.status}`}>{warrant.status}</span>
                  <span className="axm-item-title">
                    <strong>{warrant.name}</strong>
                    <small>
                      held by {principalLabel(principalById.get(warrant.holderPrincipalId))}
                      {' · '}{warrant.liveMinted} live / {warrant.mintedTotal} total minted
                      {warrant.maxConcurrent !== null && ` (cap ${warrant.maxConcurrent} concurrent)`}
                      {warrant.maxTotal !== null && ` (cap ${warrant.maxTotal} total)`}
                    </small>
                  </span>
                  {warrant.status === 'suspended' && (
                    <span className="axm-flag" role="status">
                      <AlertTriangle size={16} aria-hidden="true" /> {warrant.suspendedReason ?? 'suspended'}
                    </span>
                  )}
                  <span className="axm-item-meta">{warrant.expiresAt ? `expires ${new Date(warrant.expiresAt).toLocaleString()}` : 'task-terminal expiry'}</span>
                  {(warrant.status === 'active' || warrant.status === 'suspended') && <Button variant="secondary" size="compact" disabled={busyId !== null} onClick={() => {
                    setEditWarrant(warrant); if (expandedId !== warrant.id) void expand(warrant.id); setCreating(true); setRuleRows([]); setRulesAttempted(false); setRefusal(null); setNarrowAgents(false); setEditLifetime('until-task'); setEditTask(warrant.anchors.length === 1 && warrant.anchors[0].anchorType === 'task' ? warrant.anchors[0].anchorId : ''); setEditRevert('');
                    setDraft({ ...EMPTY_WARRANT_DRAFT, name: warrant.name, holderPrincipalId: warrant.holderPrincipalId, anchorType: warrant.anchors[0]?.anchorType || 'task', anchorId: warrant.anchors[0]?.anchorId || '', ceilingProfileId: '', ceilingScopes: warrant.ceilingScopes?.join(', ') || '', transportPin: warrant.transportPin, maxConcurrent: warrant.maxConcurrent === null ? '' : String(warrant.maxConcurrent), maxTotal: warrant.maxTotal === null ? '' : String(warrant.maxTotal), expiresAt: formatInstantForDateTimeLocal(warrant.expiresAt ?? '').slice(0, 16) });
                  }}>Edit</Button>}
                  <Button variant="secondary" size="compact" ariaExpanded={expanded} onClick={() => expand(warrant.id)}>
                    {expanded ? 'Hide' : 'Details'}
                  </Button>
                </div>
                {expanded && (
                  <div className="axm-item-detail">
                    <h3>Anchors</h3>
                    <div className="axm-chipset">
                      {warrant.anchors.map((anchor) => (
                        <span key={`${anchor.anchorType}-${anchor.anchorId}`} className="axm-scope">{anchor.anchorType} {anchor.anchorId.slice(0, 8)}</span>
                      ))}
                    </div>
                    <h3>Ceiling</h3>
                    <p className="axm-muted">Profile “{warrant.ceilingProfileName}” pinned at v{warrant.ceilingProfileVersionNumber} (republish never widens this warrant).</p>
                    <PinnedRulesList pinned={pinned[warrant.id] ?? initialPinnedRules(warrant)} />
                    {warrant.ceilingScopes && (
                      <div className="axm-chipset">
                        {warrant.ceilingScopes.map((scope) => <span key={scope} className="axm-scope">{scope}</span>)}
                      </div>
                    )}
                    <h3>Assignments this warrant carries</h3>
                    {/* The COUNT decides what this says; the ARRAY decides what
                        it can name. They are different numbers whenever the
                        viewer holds the warrant without being able to read a
                        Task riding it (review f0c51a8e B2) — and while the
                        count is COUNTING or UNCOUNTED this says so, because
                        neither is a zero (review 99ba9444 B2). */}
                    <p className="axm-muted" role="status" aria-live="polite">
                      {unassignmentSentence(carriedCount)}
                    </p>
                    {carriedCount.state === 'counted' && carriedCount.tasks.length > 0 && (
                      <ul className="axm-minted">
                        {carriedCount.tasks.map((task) => (
                          <li key={task.id}>
                            <code>{task.id.slice(0, 8)}</code> — {task.title} ({task.status})
                          </li>
                        ))}
                      </ul>
                    )}
                    <h3>Identities minted under this warrant</h3>
                    {mintedFailure[warrant.id] ? <p role="status">Live Agents could not be read: {mintedFailure[warrant.id]}</p> : !minted[warrant.id] ? <p role="status">Reading minted Agents…</p> : minted[warrant.id].length === 0 ? (
                      <p className="axm-muted">None yet.</p>
                    ) : (
                      <ul className="axm-minted">
                        {(minted[warrant.id] ?? []).map((identity) => (
                          <li key={identity.principalId}>
                            <code>{identity.handle}</code> — {identity.live ? 'live' : identity.status}
                            {identity.boundTaskId && ` · task ${identity.boundTaskId.slice(0, 8)}`}
                            {' · '}{new Date(identity.createdAt).toLocaleString()}
                            {identity.live && <Button variant="danger" size="compact" disabled={busyId !== null} onClick={() => void revokeMintedAgent(identity, warrant.id)}>Revoke Agent credentials</Button>}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="axm-decide-actions">
                      {warrant.status === 'suspended' && (
                        <Button variant="success" size="compact" disabled={busyId !== null} onClick={() => resume(warrant)}>Resume (re-approve)</Button>
                      )}
                      {(warrant.status === 'active' || warrant.status === 'suspended') && (
                        <Button variant="danger" size="compact" disabled={busyId !== null} onClick={() => askToRevoke(warrant)}>
                          {busyId === warrant.id ? 'Working…' : 'Revoke'}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editWarning && <ConfirmationModal danger title="Edit warrant ceiling?" confirmLabel="Acknowledge riding tasks and continue" confirmDisabled={!acknowledgementReady(editWarning.count)} message={<><p>Changing this ceiling releases tasks riding the warrant. Current assignments must be acknowledged first.</p><p role="status">{unassignmentSentence(editWarning.count)}</p>{editWarning.count.state === 'counted' && <ul>{editWarning.count.tasks.map(task => <li key={task.id}>{task.title} ({task.status})</li>)}</ul>}</>} onConfirm={editWarning.proceed} onCancel={() => setEditWarning(null)} />}
      {revokeTarget && (
        <ConfirmationModal
          danger
          title={`Revoke “${revokeTarget.warrant.name}”?`}
          confirmLabel={revokeConfirmLabel(revokeTarget.dependents)}
          confirmDisabled={!acknowledgementReady(revokeTarget.dependents)}
          message={
            <>
              <p>
                Revoking stops new mints immediately and blocks further lease extensions for identities
                already minted under it. Running leases finish; the record and its provenance stay.
              </p>
              {revokeTarget.dependents.state !== 'counted' ? (
                <p role="status" aria-live="polite">{unassignmentSentence(revokeTarget.dependents)}</p>
              ) : revokeTarget.dependents.total === 0 ? (
                <p>{unassignmentSentence(revokeTarget.dependents)}</p>
              ) : (
                <>
                  <p>
                    <strong>{unassignmentSentence(revokeTarget.dependents)}</strong>{' '}
                    — which also silences their delivery. Work already in flight finishes on its own
                    task-bounded credentials.
                  </p>
                  {revokeTarget.dependents.tasks.length > 0 && (
                    <ul className="axm-minted">
                      {revokeTarget.dependents.tasks.map((task) => (
                        <li key={task.id}>
                          <code>{task.id.slice(0, 8)}</code> — {task.title} ({task.status})
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          }
          onConfirm={() => revoke(revokeTarget.warrant)}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
    </section>
  );
};

/* ── Inventory (§9.5): who holds what, from which source ──────────────── */

export const InventoryPanel: React.FC<{
  principals: Principal[];
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ principals, surface }) => {
  const [principalId, setPrincipalId] = useState('');
  const [access, setAccess] = useState<(AuthorityPreviewData & { grants: any[]; profiles: any[]; credentials?: Array<{id: string; live: boolean; transport: string}>; nextCursor?: string | null; credentialsTruncated?: boolean }) | null>(null);
  const [resourceType, setResourceType] = useState('task');
  const [credentialId, setCredentialId] = useState('');
  const [credentialDraft, setCredentialDraft] = useState('');
  const requestVersion = useRef(0);
  const [loading, setLoading] = useState(false);

  const inspect = useCallback(async (id: string, type = resourceType, credential = credentialId, after?: string) => {
    const version = ++requestVersion.current;
    setPrincipalId(id);
    setAccess(null);
    if (!id) { setLoading(false); return; }
    setLoading(true);
    try {
      const query = new URLSearchParams({ principalId: id, resourceType: type, limit: '20' });
      if (credential) query.set('credentialId', credential);
      if (after) query.set('after', after);
      const data = await readJson(await authenticatedFetch(`${API_BASE}/access-profiles/what-if?${query}`));
      if (version === requestVersion.current) setAccess(data.access ?? { grants: [], profiles: [] });
    } catch (caught) {
      if (version === requestVersion.current) surface('error', caught instanceof Error ? caught.message : 'Could not compute the inventory');
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [surface, resourceType, credentialId]);

  return (
    <section className="axm-section" aria-labelledby="axm-inventory-heading">
      <div className="axm-section-head">
        <h2 id="axm-inventory-heading"><FileKey2 aria-hidden="true" /> Granted-access inventory</h2>
      </div>
      <p className="axm-section-intro">
        Inspect current permissions and the sources that allow them. Choose one credential for a
        connector or agent. Stored grants and profile rules are listed separately below.
      </p>
      <label className="axm-filter axm-filter--wide">
        Identity
        <Select value={principalId} onChange={(event) => { setCredentialId(''); setCredentialDraft(''); inspect(event.target.value, resourceType, ''); }} aria-label="Identity to inspect">
          <option value="">Choose an identity…</option>
          {principals.map((principal) => (
            <option key={principal.id} value={principal.id}>{principalLabel(principal)} · {principal.kind}</option>
          ))}
        </Select>
      </label>
      <label>Object type <Select aria-label="Preview object type" value={resourceType} onChange={event => {
        setResourceType(event.target.value); inspect(principalId, event.target.value);
      }}>{['task','phase','project','report','skill','personality','service'].map(type => <option key={type} value={type}>{type}</option>)}</Select></label>
      {access?.credentials && access.credentials.length > 0 && <label>Credential <Select aria-label="Preview credential" value={credentialId} onChange={event => {
        setCredentialId(event.target.value); setCredentialDraft(event.target.value); inspect(principalId, resourceType, event.target.value);
      }}><option value="">Choose a credential…</option>{credentialId && !access.credentials.some(key => key.id === credentialId) && <option value={credentialId}>{credentialId} · selected by ID</option>}{access.credentials.map(credential => <option key={credential.id} value={credential.id}>{credential.id.slice(0, 8)} · {credential.transport} · {credential.live ? 'active' : 'inactive'}</option>)}</Select></label>}
      {access?.credentialsTruncated && <p role="status">Only the first 50 credentials are listed, including inactive history. Enter an exact credential ID to inspect another credential for this identity.</p>}
      {principalId && <form onSubmit={event => {
        event.preventDefault();
        const exact = credentialDraft.trim().toLowerCase();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(exact)) {
          surface('error', 'Enter an exact credential UUID.'); return;
        }
        setCredentialId(exact); inspect(principalId, resourceType, exact);
      }}>
        <label>Exact credential ID <input aria-label="Exact preview credential ID" value={credentialDraft} maxLength={36}
          onChange={event => setCredentialDraft(event.target.value)} /></label>
        <Button type="submit">Inspect credential</Button>
      </form>}
      {loading && <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Computing…</div>}
      {access && !loading && <><AuthorityPreviewTable access={access} />{access.hasMore && access.nextCursor && <Button onClick={() => inspect(principalId, resourceType, credentialId, access.nextCursor!)}>Next objects</Button>}</>}
      {access && !loading && (
        (access.grants.length === 0 && access.profiles.length === 0) ? (
          <div className="axm-empty">No stored grants or profile rules for this identity.</div>
        ) : (
          <div className="axm-table" role="table" aria-label="Object authority sources">
            <div className="axm-trow axm-trow--head" role="row">
              <span role="columnheader">Source</span><span role="columnheader">Authority</span><span role="columnheader">Selector</span>
            </div>
            {access.grants.map((grant: any) => (
              <div className="axm-trow" role="row" key={`g-${grant.grantId}`}>
                <span role="cell">{grant.source}{grant.groupName ? ` (${grant.groupName})` : ''}</span>
                <span role="cell" className="axm-scope">{grant.verb} {grant.resourceType}</span>
                <span role="cell">{grant.resourceId ? `exact ${String(grant.resourceId).slice(0, 8)}` : 'every resource of this type'}</span>
              </div>
            ))}
            {access.profiles.map((rule: any, index: number) => (
              <div className="axm-trow" role="row" key={`p-${index}`}>
                <span role="cell">{rule.source} “{rule.profileName}” v{rule.versionNumber}{rule.groupName ? ` (${rule.groupName})` : ''}</span>
                <span role="cell" className="axm-scope">{(rule.verbs ?? []).join('/')} {rule.resourceType}</span>
                <span role="cell">{rule.selectorForm}{(rule.selectorIds ?? []).length > 0 ? ` (${rule.selectorIds.length} ids)` : ''}</span>
              </div>
            ))}
          </div>
        )
      )}
    </section>
  );
};

/* ── Reveals (§7.1/§7.2): step-up-gated, counter-visible ──────────────── */

const RevealPanel: React.FC<{
  principals: Principal[];
  requestStepUp: (request: StepUpRequest) => void;
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ principals, requestStepUp, surface }) => {
  const [principalId, setPrincipalId] = useState('');
  const [credentials, setCredentials] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState<{ credentialId: string; token: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const delegated = useMemo(() => principals.filter((p) => p.kind !== 'human'), [principals]);

  // Review 1897c959 B4: loading NEVER clears a shown one-time secret —
  // only an identity change does (selectIdentity below); the post-reveal
  // refresh keeps the token on screen until the user dismisses it.
  const loadCredentials = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await readJson(await authenticatedFetch(`${API_BASE}/principals/${id}/credentials`));
      setCredentials(Array.isArray(data.credentials) ? data.credentials : []);
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'Could not list credentials');
    } finally {
      setLoading(false);
    }
  }, [surface]);

  const selectIdentity = useCallback(async (id: string) => {
    setPrincipalId(id);
    setCredentials([]);
    setRevealed(null);
    await loadCredentials(id);
  }, [loadCredentials]);

  const reveal = (credential: any) => {
    requestStepUp({
      action: 'credential.reveal',
      targetId: String(credential.id),
      description: `Reveal the stored secret of credential ${credential.keyId}. The reveal is audited with your identity and this step-up evidence; the counter increments.`,
      onToken: async (stepUpToken) => {
        setBusyId(String(credential.id));
        try {
          const data = await readJson(await authenticatedFetch(`${API_BASE}/credentials/${credential.id}/reveal`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepUpToken }),
          }));
          // Refresh the counters FIRST, then show the one-time value: the
          // token stays visible until the user dismisses it (B4).
          await loadCredentials(principalId);
          setRevealed({ credentialId: String(credential.id), token: String(data.token) });
        } catch (caught) {
          surface('error', caught instanceof Error ? caught.message : 'Could not reveal the credential');
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  return (
    <section className="axm-section" aria-labelledby="axm-reveals-heading">
      <div className="axm-section-head">
        <h2 id="axm-reveals-heading"><KeyRound aria-hidden="true" /> Credential reveals</h2>
      </div>
      <p className="axm-section-intro">
        Stored connector and agent secrets re-reveal only under a single-use step-up bound to the exact
        credential. Graced, revoked and expired credentials never reveal; every reveal is audited and
        counted. Reveals are rate-limited with an audited alert.
      </p>
      <label className="axm-filter axm-filter--wide">
        Identity
        <Select value={principalId} onChange={(event) => selectIdentity(event.target.value)} aria-label="Identity whose credentials to list">
          <option value="">Choose a delegated identity…</option>
          {delegated.map((principal) => (
            <option key={principal.id} value={principal.id}>{principalLabel(principal)} · {principal.kind}</option>
          ))}
        </Select>
      </label>
      {loading && <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Loading credentials…</div>}
      {!loading && principalId && credentials.length === 0 && <div className="axm-empty">No credentials on this identity.</div>}
      {!loading && credentials.length > 0 && (
        <div className="axm-table" role="table" aria-label="Credentials">
          <div className="axm-trow axm-trow--head" role="row">
            <span role="columnheader">Key</span><span role="columnheader">Scopes</span><span role="columnheader">State</span><span role="columnheader">Reveals</span><span role="columnheader">Action</span>
          </div>
          {credentials.map((credential) => {
            const state = credential.revokedAt ? 'revoked'
              : credential.graceUntil ? 'graced'
                : credential.expiresAt && new Date(credential.expiresAt).getTime() <= Date.now() ? 'expired' : 'live';
            return (
              <div className="axm-trow" role="row" key={credential.id}>
                <span role="cell"><code>{credential.keyId}</code>{credential.label ? ` · ${credential.label}` : ''}</span>
                <span role="cell">{(credential.scopes ?? []).join(', ') || '—'}</span>
                <span role="cell" className={state === 'live' ? 'axm-status axm-status--active' : 'axm-status axm-status--lapsed'}>{state} · {credential.transport}</span>
                <span role="cell">{credential.revealCount}</span>
                <span role="cell">
                  {credential.revealable && state === 'live' ? (
                    <Button variant="secondary" size="compact" icon={<Eye size={16} />} disabled={busyId !== null} onClick={() => reveal(credential)}>
                      {busyId === credential.id ? 'Working…' : 'Reveal'}
                    </Button>
                  ) : <span className="axm-muted">not revealable</span>}
                </span>
                {revealed !== null && revealed.credentialId === credential.id && (
                  <div className="axm-revealed" role="status">
                    <strong>Shown once — store it now:</strong> <code>{revealed.token}</code>
                    <Button variant="secondary" size="compact" onClick={() => setRevealed(null)}>Dismiss</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

/* ── Remediation (§10) + directory staleness (AZ-30) ─────────────────── */

const RemediationQueues: React.FC<{
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ surface }) => {
  const [queue, setQueue] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const remediation = await readJson(await authenticatedFetch(`${API_BASE}/principals/remediation-queue`));
        setQueue(Array.isArray(remediation.queue) ? remediation.queue : []);
      } catch (caught) {
        surface('error', caught instanceof Error ? caught.message : 'Could not load the remediation queue');
      }
      try {
        const sync = await readJson(await authenticatedFetch(`${API_BASE}/groups/directory-sync`));
        setProviders(Array.isArray(sync.providers) ? sync.providers : []);
      } catch {
        setProviders([]);
      }
      setLoading(false);
    })();
  }, [surface]);

  const staleProviders = providers.filter((provider) => provider.stale === true);

  return (
    <section className="axm-section" aria-labelledby="axm-remediation-heading">
      <div className="axm-section-head">
        <h2 id="axm-remediation-heading"><AlertTriangle aria-hidden="true" /> Remediation queues</h2>
      </div>
      <p className="axm-section-intro">
        Legacy identities ride the pre-delegation compatibility arm until the owner replaces each with a
        login session or a delegated connector; service accounts still carrying the backfilled purpose
        await an owner review. Directory staleness alarms surface here too.
      </p>
      {loading ? (
        <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Loading…</div>
      ) : (
        <>
          {staleProviders.length > 0 && (
            <div className="axm-error" role="alert">
              Directory sync stale: {staleProviders.map((provider) => String(provider.provider ?? provider.name ?? 'provider')).join(', ')} — group membership may be out of date.
            </div>
          )}
          {queue.length === 0 ? (
            <div className="axm-empty">The remediation queue is empty.</div>
          ) : (
            <div className="axm-table" role="table" aria-label="Remediation queue">
              <div className="axm-trow axm-trow--head" role="row">
                <span role="columnheader">Identity</span><span role="columnheader">Why it is here</span><span role="columnheader">Live credentials</span><span role="columnheader">Status</span>
              </div>
              {queue.map((entry) => (
                <div className="axm-trow" role="row" key={entry.principalId}>
                  <span role="cell"><strong>{entry.displayName || entry.handle}</strong><small>{entry.kind}{entry.role ? ` · ${entry.role}` : ''}</small></span>
                  <span role="cell">{entry.reason}</span>
                  <span role="cell">{entry.liveCredentials}</span>
                  <span role="cell" className={entry.status === 'active' ? 'axm-status axm-status--active' : 'axm-status axm-status--lapsed'}>{entry.status}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
};

/* ── Identity providers (RH-P5.SSO.W2, owner D5): the ratified visibility
      controls — the private-address badge, the subject_immutable declaration,
      and discovery health. Root-gated, matching the backend: the whole
      /identity-providers family sits behind the root sentinel in the scope
      map and mints no scope family of its own (A23.6). ──────────────────── */

/* ── SS-12 · the Group directory binding (RH-P5.SSO.W3) ────────────────────
   A board Group carries an optional binding to ONE Identity provider's group
   value. The value is OPAQUE — a directory GUID, a `/path` and a bare name are
   all legitimate, and the board matches the raw bytes exactly — so this surface
   never parses, trims or case-folds what the operator types. The binding is
   both columns or neither: the service refuses a half-set pair by name and the
   schema forbids it, so "Bind" sends both and "Unbind" sends both as null. ── */

interface GroupBindingRow {
  id: string;
  name: string;
  identityProviderId: string | null;
  externalGroupRef: string | null;
}

const GroupDirectoryBindings: React.FC<{
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ surface }) => {
  const [groups, setGroups] = useState<GroupBindingRow[]>([]);
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { providerId: string; ref: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [groupData, providerData] = await Promise.all([
        readJson(await authenticatedFetch(`${API_BASE}/groups`)),
        readJson(await authenticatedFetch(`${API_BASE}/identity-providers`)),
      ]);
      setGroups(Array.isArray(groupData.groups) ? groupData.groups : []);
      setProviders(Array.isArray(providerData.identityProviders) ? providerData.identityProviders : []);
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'Could not load Groups');
    } finally {
      setLoading(false);
    }
  }, [surface]);

  useEffect(() => { void load(); }, [load]);

  const bind = useCallback(async (group: GroupBindingRow, identityProviderId: string | null, externalGroupRef: string | null) => {
    setBusyId(group.id);
    try {
      await readJson(await authenticatedFetch(`${API_BASE}/groups/${group.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityProviderId, externalGroupRef }),
      }));
      await load();
    } catch (caught) {
      // Surfaced verbatim: the service's refusals name the field an operator
      // has to fix (a half-set pair, or a reference another Group already owns).
      surface('error', caught instanceof Error ? caught.message : 'Could not change the binding');
    } finally {
      setBusyId(null);
    }
  }, [load, surface]);

  const providerName = (id: string | null): string =>
    providers.find((provider) => provider.id === id)?.name ?? (id ? 'unknown Identity provider' : '—');

  return (
    <section className="axm-section" aria-labelledby="axm-binding-heading">
      <div className="axm-section-head">
        <h2 id="axm-binding-heading"><Fingerprint aria-hidden="true" /> Group directory bindings</h2>
      </div>
      <p className="axm-section-intro">
        Bind a board Group to one group in an Identity provider&apos;s directory. On each federated
        sign-in the Identity provider&apos;s group values are matched against these bindings, as sent,
        and matching Groups become that person&apos;s directory membership. The reference is whatever
        the Identity provider emits — an identifier, a path or a name — and it is matched byte for
        byte, so copy and paste it unchanged rather than retyping it. Groups with no binding are
        local-only and no sync ever touches them.
      </p>
      {loading && <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Loading Groups…</div>}
      {!loading && groups.length === 0 && <div className="axm-empty">No Groups exist yet.</div>}
      {!loading && groups.length > 0 && (
        <div className="axm-table" role="table" aria-label="Group directory bindings">
          <div className="axm-trow axm-trow--head" role="row">
            <span role="columnheader">Group</span>
            <span role="columnheader">Identity provider</span>
            <span role="columnheader">External group reference</span>
            <span role="columnheader">Action</span>
          </div>
          {groups.map((group) => {
            const pending = draft[group.id] ?? { providerId: providers[0]?.id ?? '', ref: '' };
            const bound = group.identityProviderId !== null;
            return (
              <div className="axm-trow" role="row" key={group.id}>
                <span role="cell"><strong>{group.name}</strong></span>
                <span role="cell">
                  {bound ? providerName(group.identityProviderId) : (
                    <>
                      <label className="axm-inline-label" htmlFor={`axm-bind-provider-${group.id}`}>
                        Identity provider
                      </label>
                      <select
                        id={`axm-bind-provider-${group.id}`}
                        value={pending.providerId}
                        disabled={busyId !== null || providers.length === 0}
                        onChange={(event) => setDraft((current) => ({
                          ...current,
                          [group.id]: { ...pending, providerId: event.target.value },
                        }))}
                      >
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>{provider.name}</option>
                        ))}
                      </select>
                    </>
                  )}
                </span>
                <span role="cell">
                  {bound ? <code>{group.externalGroupRef}</code> : (
                    <>
                      <label className="axm-inline-label" htmlFor={`axm-bind-ref-${group.id}`}>
                        External group reference
                      </label>
                      <input
                        id={`axm-bind-ref-${group.id}`}
                        type="text"
                        value={pending.ref}
                        disabled={busyId !== null}
                        placeholder="Exactly as the Identity provider sends it"
                        onChange={(event) => setDraft((current) => ({
                          ...current,
                          [group.id]: { ...pending, ref: event.target.value },
                        }))}
                      />
                    </>
                  )}
                </span>
                <span role="cell">
                  {bound ? (
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={busyId !== null}
                      onClick={() => bind(group, null, null)}
                    >
                      Unbind
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={busyId !== null || pending.providerId === '' || pending.ref === ''}
                      onClick={() => bind(group, pending.providerId, pending.ref)}
                    >
                      Bind
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

interface IdentityProviderRow {
  id: string;
  name: string;
  issuer: string;
  status: string;
  provisioningMode: string;
  clientAuthMethod: string;
  hasClientSecret: boolean;
  subjectImmutable: boolean;
  allowPrivateIssuerAddress?: boolean;
  allowClaimMatching?: boolean;
  retainIdToken?: boolean;
  /** SSO-R4: whether an allowed-Group membership is required to sign in at this Identity provider. */
  loginGroupWhitelistEnabled?: boolean;
  /** A24 (W4): the service Account whose Connector pushes SCIM for this Identity provider, or null. */
  scimClientPrincipalId?: string | null;
  /** SSO-R8 (W4): hours of push silence before the AZ-30 alarm; null = claim-sync semantics. */
  scimHeartbeatIntervalHours?: number | null;
  /**
   * Card 7a99d63e (SU-17): how a step-up asks this Identity provider for a
   * fresh sign-in, or null for the default request (prompt=login, max_age=0).
   */
  stepUpPolicy?: StepUpPolicy | null;
}

/** Card 7a99d63e: the step-up policy fields this release accepts. */
interface StepUpPolicy {
  sso_step_up?: 'enabled' | 'disabled';
  prompt_login?: boolean;
  max_age?: number | null;
}

/** The step-up request a policy sends, in the words of the parameters. */
function stepUpRequestSummary(policy: StepUpPolicy | null | undefined): string {
  if (policy?.sso_step_up === 'disabled') return 'step-up by single sign-on off';
  const promptLogin = policy?.prompt_login ?? true;
  const maxAge = policy && 'max_age' in policy ? policy.max_age ?? null : 0;
  const parts = [promptLogin ? 'prompt=login' : null, maxAge === null ? null : `max_age=${maxAge}`].filter(Boolean);
  return `step-up asks ${parts.join(' and ')}`;
}

/** SSO-R4 — one Group admitting a federated login at this Identity provider. */
interface LoginGroupRow {
  groupId: string;
  groupName: string;
}

const fetchedAtLabel = (value: number | null | undefined): string => {
  if (!value) return 'never — cache cold';
  return new Date(value).toLocaleString();
};

const IdentityProviders: React.FC<{
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ surface }) => {
  const [providers, setProviders] = useState<IdentityProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, { metadataFetchedAt: number | null; jwksFetchedAt: number | null }>>({});
  // SSO-R4: the allowed-Group list per Identity provider, and every Group the
  // to choose from. Loaded lazily, when an operator opens the gate editor.
  const [loginGroups, setLoginGroups] = useState<Record<string, LoginGroupRow[]>>({});
  const [allGroups, setAllGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [gateOpenFor, setGateOpenFor] = useState<string | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  /**
   * Review R3 finding B2: an unread allowed-Group list is NOT an empty one.
   * Rendering `loginGroups[id] ?? []` made "no group is allowed, so every
   * federated sign-in is refused" appear while the board had simply not
   * answered yet — a factual claim about a lockout, made from an unknown state,
   * with the mutation controls live beside it. Loading and failure are now
   * states of their own, and the editor asserts nothing until it knows.
   */
  const [gateLoad, setGateLoad] = useState<Record<string, 'loading' | 'loaded' | 'failed'>>({});
  /**
   * Card 7a99d63e (SU-31 a): the root-only step-up editor. Two fields, the
   * two standard knobs a step-up request carries; the server's validator
   * (`validateStepUpPolicy`) decides, and its named refusal is shown as is.
   * Any check here is a convenience only.
   */
  const [stepUpOpenFor, setStepUpOpenFor] = useState<string | null>(null);
  const [stepUpPromptLogin, setStepUpPromptLogin] = useState(true);
  const [stepUpMaxAge, setStepUpMaxAge] = useState('0');
  const [stepUpBusy, setStepUpBusy] = useState(false);
  const [stepUpRefusal, setStepUpRefusal] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await readJson(await authenticatedFetch(`${API_BASE}/identity-providers`));
      setProviders(Array.isArray(data.identityProviders) ? data.identityProviders : []);
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'Could not load Identity providers');
    } finally {
      setLoading(false);
    }
  }, [surface]);

  useEffect(() => { load(); }, [load]);

  const check = useCallback(async (provider: IdentityProviderRow) => {
    setCheckingId(provider.id);
    try {
      await readJson(await authenticatedFetch(`${API_BASE}/identity-providers/${provider.id}/test-connection`, {
        method: 'POST',
      }));
      const detail = await readJson(await authenticatedFetch(`${API_BASE}/identity-providers/${provider.id}`));
      setHealth((prior) => ({ ...prior, [provider.id]: detail.health ?? { metadataFetchedAt: null, jwksFetchedAt: null } }));
      surface('notice', `${provider.name}: discovery document fetched and validated.`);
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'The Identity provider could not be reached');
    } finally {
      setCheckingId(null);
    }
  }, [surface]);

  const openGate = useCallback(async (providerId: string) => {
    const opening = gateOpenFor !== providerId;
    setGateOpenFor(opening ? providerId : null);
    if (!opening) return;
    setGateLoad((current) => ({ ...current, [providerId]: 'loading' }));
    try {
      const [listed, groups] = await Promise.all([
        readJson(await authenticatedFetch(`${API_BASE}/identity-providers/${providerId}/login-groups`)),
        readJson(await authenticatedFetch(`${API_BASE}/groups`)),
      ]);
      setLoginGroups((current) => ({ ...current, [providerId]: Array.isArray(listed.loginGroups) ? listed.loginGroups : [] }));
      setAllGroups(Array.isArray(groups.groups) ? groups.groups : []);
      setGateLoad((current) => ({ ...current, [providerId]: 'loaded' }));
    } catch (caught) {
      // The previous known list, if any, is left untouched: a failed read must
      // not be presented as a changed state.
      setGateLoad((current) => ({ ...current, [providerId]: 'failed' }));
      surface('error', caught instanceof Error ? caught.message : 'Could not load the allowed login groups');
    }
  }, [gateOpenFor, surface]);

  const setGateEnabled = useCallback(async (provider: IdentityProviderRow, enabled: boolean) => {
    setGateBusy(true);
    try {
      await readJson(await authenticatedFetch(`${API_BASE}/identity-providers/${provider.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginGroupWhitelistEnabled: enabled }),
      }));
      // Enabling with an empty list refuses EVERY federated login (fail closed,
      // W3-D2). Saying so at the moment of the change is the difference between
      // a deliberate lockout and a surprise one.
      const listed = loginGroups[provider.id] ?? [];
      if (enabled && listed.length === 0) {
        surface('notice', 'Sign-in is now restricted, and no group is allowed yet — every federated sign-in will be refused until you add one.');
      }
      await load();
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'Could not change the sign-in restriction');
    } finally {
      setGateBusy(false);
    }
  }, [load, loginGroups, surface]);

  const addLoginGroup = useCallback(async (providerId: string, groupId: string) => {
    if (!groupId) return;
    setGateBusy(true);
    try {
      const data = await readJson(await authenticatedFetch(`${API_BASE}/identity-providers/${providerId}/login-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      }));
      setLoginGroups((current) => ({ ...current, [providerId]: Array.isArray(data.loginGroups) ? data.loginGroups : [] }));
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'Could not allow that group');
    } finally {
      setGateBusy(false);
    }
  }, [surface]);

  const openStepUp = useCallback((provider: IdentityProviderRow) => {
    const opening = stepUpOpenFor !== provider.id;
    setStepUpOpenFor(opening ? provider.id : null);
    setStepUpRefusal(null);
    if (!opening) return;
    const policy = provider.stepUpPolicy ?? null;
    setStepUpPromptLogin(policy?.prompt_login ?? true);
    const maxAge = policy && 'max_age' in policy ? policy.max_age ?? null : 0;
    setStepUpMaxAge(maxAge === null ? '' : String(maxAge));
  }, [stepUpOpenFor]);

  /** PATCH the policy (or null for the default request) and show the board's answer. */
  const saveStepUp = useCallback(async (provider: IdentityProviderRow, policy: StepUpPolicy | null) => {
    setStepUpBusy(true);
    setStepUpRefusal(null);
    try {
      const response = await authenticatedFetch(`${API_BASE}/identity-providers/${provider.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepUpPolicy: policy }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = typeof data?.code === 'string' ? data.code : `HTTP ${response.status}`;
        const message = typeof data?.message === 'string' ? data.message : 'The step-up policy was not saved.';
        setStepUpRefusal(`${code}: ${message}`);
        return;
      }
      surface('notice', policy === null
        ? `${provider.name}: step-ups use the default request again (prompt=login and max_age=0).`
        : `${provider.name}: ${stepUpRequestSummary(data?.identityProvider?.stepUpPolicy ?? policy)}.`);
      await load();
    } catch {
      setStepUpRefusal('The step-up policy could not be saved. Nothing has changed.');
    } finally {
      setStepUpBusy(false);
    }
  }, [load, surface]);

  const submitStepUp = useCallback((provider: IdentityProviderRow) => {
    const raw = stepUpMaxAge.trim();
    if (raw !== '' && !/^\d+$/.test(raw)) {
      setStepUpRefusal('Enter a whole number of seconds, or leave the field empty to send no max_age.');
      return;
    }
    const policy: StepUpPolicy = { ...(provider.stepUpPolicy ?? {}), prompt_login: stepUpPromptLogin, max_age: raw === '' ? null : Number(raw) };
    void saveStepUp(provider, policy);
  }, [saveStepUp, stepUpMaxAge, stepUpPromptLogin]);

  const removeLoginGroup = useCallback(async (providerId: string, groupId: string) => {
    setGateBusy(true);
    try {
      const data = await readJson(await authenticatedFetch(`${API_BASE}/identity-providers/${providerId}/login-groups/${groupId}`, {
        method: 'DELETE',
      }));
      setLoginGroups((current) => ({ ...current, [providerId]: Array.isArray(data.loginGroups) ? data.loginGroups : [] }));
    } catch (caught) {
      surface('error', caught instanceof Error ? caught.message : 'Could not remove that group');
    } finally {
      setGateBusy(false);
    }
  }, [surface]);

  return (
    <section className="axm-section" aria-labelledby="axm-idp-heading">
      <div className="axm-section-head">
        <h2 id="axm-idp-heading"><Fingerprint aria-hidden="true" /> Identity providers</h2>
      </div>
      <p className="axm-section-intro">
        Federated sign-in, as configuration. At most one provider is enabled at a time. Two
        declarations are shown because they change what the deployment is trusting: whether the
        provider guarantees immutable, never-recycled subjects, and whether its issuer is allowed
        to live on an address the public internet cannot reach.
      </p>
      {loading && <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Loading Identity providers…</div>}
      {!loading && providers.length === 0 && (
        <div className="axm-empty">No Identity provider is configured. Sign-in uses passwords only.</div>
      )}
      {!loading && providers.length > 0 && (
        <div className="axm-table" role="table" aria-label="Identity providers">
          <div className="axm-trow axm-trow--head" role="row">
            <span role="columnheader">Provider</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Declarations</span>
            <span role="columnheader">Discovery</span>
            <span role="columnheader">Action</span>
          </div>
          {providers.map((provider) => {
            const providerHealth = health[provider.id];
            return (
              <div className="axm-trow" role="row" key={provider.id}>
                <span role="cell">
                  <strong>{provider.name}</strong>
                  <small>{provider.issuer}</small>
                </span>
                <span role="cell" className={provider.status === 'active' ? 'axm-status axm-status--active' : 'axm-status axm-status--lapsed'}>
                  {provider.status} · {provider.provisioningMode}
                </span>
                <span role="cell">
                  {provider.subjectImmutable
                    ? <span className="axm-badge">subjects immutable</span>
                    : <span className="axm-badge axm-badge--warn">subjects NOT declared immutable</span>}
                  {provider.allowPrivateIssuerAddress && (
                    <span className="axm-badge axm-badge--warn">private issuer address permitted</span>
                  )}
                  {provider.loginGroupWhitelistEnabled && (
                    <span className="axm-badge">sign-in restricted to allowed groups</span>
                  )}
                  {provider.allowClaimMatching && <span className="axm-badge">claim matching on</span>}
                  {provider.retainIdToken && <span className="axm-badge">retains ID token</span>}
                  {provider.scimClientPrincipalId && <span className="axm-badge">SCIM client bound</span>}
                  {typeof provider.scimHeartbeatIntervalHours === 'number' && (
                    <span className="axm-badge">directory push expected every {provider.scimHeartbeatIntervalHours} h</span>
                  )}
                  {provider.stepUpPolicy && <span className="axm-badge">{stepUpRequestSummary(provider.stepUpPolicy)}</span>}
                </span>
                <span role="cell">
                  {providerHealth ? (
                    <>
                      metadata {fetchedAtLabel(providerHealth.metadataFetchedAt)}
                      <small>jwks {fetchedAtLabel(providerHealth.jwksFetchedAt)}</small>
                    </>
                  ) : <span className="axm-muted">not checked this session</span>}
                </span>
                <span role="cell">
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={checkingId !== null}
                    onClick={() => check(provider)}
                  >
                    {checkingId === provider.id ? 'Checking…' : 'Check connection'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="compact"
                    aria-expanded={gateOpenFor === provider.id}
                    onClick={() => openGate(provider.id)}
                  >
                    Allowed groups
                  </Button>
                  <Button
                    variant="secondary"
                    size="compact"
                    ariaExpanded={stepUpOpenFor === provider.id}
                    ariaLabel={`Step-up for ${provider.name}`}
                    onClick={() => openStepUp(provider)}
                  >
                    Step-up
                  </Button>
                </span>
              </div>
            );
          })}
          {gateOpenFor !== null && (() => {
            const provider = providers.find((row) => row.id === gateOpenFor);
            if (!provider) return null;
            const loadState = gateLoad[provider.id] ?? 'loading';
            const known = loadState === 'loaded';
            const listed = loginGroups[provider.id] ?? [];
            const listedIds = new Set(listed.map((row) => row.groupId));
            const selectable = allGroups.filter((group) => !listedIds.has(group.id));
            return (
              <div className="axm-trow axm-trow--detail" role="row">
                <span role="cell">
                  <h3>Who may sign in with {provider.name}</h3>
                  {loadState === 'loading' && (
                    <div className="axm-state">
                      <Loader2 className="axm-spin" aria-hidden="true" /> Loading the allowed groups…
                    </div>
                  )}
                  {loadState === 'failed' && (
                    <p className="axm-warn">
                      The allowed groups could not be read, so this list is unknown. Nothing has
                      changed. Close and reopen to try again.
                    </p>
                  )}
                  <p className="axm-section-intro">
                    Membership of one of these groups is required to sign in. It decides who may
                    sign in, never what they may then do — permissions are unchanged, and a person
                    admitted here holds exactly the access their account already had. Local and
                    directory-synced memberships both count.
                  </p>
                  {known && (
                    <>
                      <label className="axm-inline-label">
                        <input
                          type="checkbox"
                          checked={provider.loginGroupWhitelistEnabled === true}
                          disabled={gateBusy}
                          onChange={(event) => setGateEnabled(provider, event.target.checked)}
                        />
                        Restrict sign-in to members of the allowed groups
                      </label>
                      {provider.loginGroupWhitelistEnabled && listed.length === 0 && (
                        <p className="axm-warn">
                          No group is allowed yet, so every federated sign-in is refused. Add a group,
                          or turn the restriction off.
                        </p>
                      )}
                      <ul className="axm-chip-list">
                        {listed.map((row) => (
                          <li key={row.groupId}>
                            {row.groupName}
                            <Button
                              variant="secondary"
                              size="compact"
                              disabled={gateBusy}
                              aria-label={`Remove ${row.groupName} from the allowed sign-in groups`}
                              onClick={() => removeLoginGroup(provider.id, row.groupId)}
                            >
                              Remove
                            </Button>
                          </li>
                        ))}
                        {listed.length === 0 && <li className="axm-muted">No groups allowed yet</li>}
                      </ul>
                      <label className="axm-inline-label" htmlFor="axm-add-login-group">Allow a group</label>
                      <select
                        id="axm-add-login-group"
                        disabled={gateBusy || selectable.length === 0}
                        value=""
                        onChange={(event) => addLoginGroup(provider.id, event.target.value)}
                      >
                        <option value="">Choose a group…</option>
                        {selectable.map((group) => (
                          <option key={group.id} value={group.id}>{group.name}</option>
                        ))}
                      </select>
                    </>
                  )}
                </span>
              </div>
            );
          })()}
          {stepUpOpenFor !== null && (() => {
            const provider = providers.find((row) => row.id === stepUpOpenFor);
            if (!provider) return null;
            return (
              <div className="axm-trow axm-trow--detail" role="row">
                <span role="cell">
                  <h3>How a step-up asks {provider.name}</h3>
                  <p className="axm-section-intro">
                    Approvals and other protected acts ask the identity provider to confirm it is
                    you again. These two standard settings choose the question; the answer is judged
                    the same way whatever is asked, so a sign-in older than the request is always
                    refused. Leave the defaults (prompt=login, maximum age 0) unless the provider
                    keeps reusing an earlier sign-in; a provider that ignores a maximum age of 0
                    often honours one of 30 seconds without prompt=login.
                  </p>
                  <form onSubmit={(event) => { event.preventDefault(); submitStepUp(provider); }}>
                    <label className="axm-inline-label">
                      <input
                        type="checkbox"
                        checked={stepUpPromptLogin}
                        disabled={stepUpBusy}
                        onChange={(event) => setStepUpPromptLogin(event.target.checked)}
                      />
                      Ask with prompt=login
                    </label>
                    <div className="form-group">
                      <label htmlFor="axm-step-up-max-age">
                        Maximum sign-in age (seconds) <span className="axm-muted">empty, 0, or 10 to 300</span>
                      </label>
                      <input
                        id="axm-step-up-max-age"
                        className="form-input"
                        type="text"
                        inputMode="numeric"
                        value={stepUpMaxAge}
                        disabled={stepUpBusy}
                        onChange={(event) => setStepUpMaxAge(event.target.value)}
                      />
                    </div>
                    {stepUpRefusal && <p className="axm-warn" role="alert">{stepUpRefusal}</p>}
                    <Button type="submit" variant="primary" size="compact" disabled={stepUpBusy}>
                      {stepUpBusy ? 'Saving…' : 'Save step-up settings'}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="compact"
                      disabled={stepUpBusy || !provider.stepUpPolicy}
                      onClick={() => { void saveStepUp(provider, null); }}
                    >
                      Use the default request
                    </Button>
                  </form>
                </span>
              </div>
            );
          })()}
        </div>
      )}
    </section>
  );
};
