import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Loader2, ShieldCheck, UserPlus } from 'lucide-react';
import { Button } from '../Button';
import { authenticatedFetch } from '../../utils/auth';
import { useMyPrincipal } from '../../hooks/usePrincipals';
import {
  SCOPE_DISCLOSURE_LABEL, chosenAuthoritySentence, connectableScopes,
  connectionRefusalMessage, defaultAuthoritySentence, defaultScopesFor, holdsRoot,
  lostCredentialRecovery, slugForName, slugIsLegal,
} from '../../types/connections';
import type { OnboardingPack } from '../../types/connections';
import {
  DEFAULT_SERVICE_TRANSPORT, IDENTITY_KINDS, PURPOSE_MAX_LENGTH,
  PURPOSE_REQUIRED_MESSAGE, ROLE_CHOICES, SERVICE_TRANSPORTS,
  defaultRoleFor, handleIsUsable, principalRefusalMessage,
} from '../../types/identities';
import type { IdentityKind } from '../../types/identities';
import { BootstrapPane } from '../connections/BootstrapPane';
import { ConnectAgentWizard } from '../connections/ConnectAgentWizard';
import { ScopeNarrowing } from '../connections/ScopeNarrowing';
import '../connections/connections.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * CREATE IDENTITY — the single flow (card `5592baf6`, owner ruling 2026-09-07).
 *
 *   1. Kind      — Human, Service or Agent, with one sentence each.
 *   2. Identity  — handle, display name, role, and for a Service the REQUIRED
 *                  purpose that defect `43fcd071` was about.
 *   3. Access    — optional credential. For a Service that is a Connector under
 *                  the new Account with a scope chooser and a transport pin;
 *                  for a Human there is no credential at all, because Accounts
 *                  are keyless; for an Agent the whole step is the existing
 *                  connection wizard.
 *   4. Done      — the credential shown ONCE, in the same harness tabs the
 *                  connection wizard renders, with links onward.
 *
 * WHY THE AGENT ARM IS AN EMBED AND NOT A BRANCH. `ConnectAgentWizard` is the
 * agent flow: templates, the delegable-catalogue default, the one-transaction
 * registration-and-mint, the enumerated refusals and the one-time pack. A
 * second implementation of any of that would be a second copy of a rule — the
 * thing this codebase repeatedly finds drifting. So kind = Agent renders it,
 * and My connections' own entry point is this component with the kind preset.
 * There is one agent code path and two doors into it.
 *
 * WHY A SERVICE'S CREDENTIAL IS A CONNECTOR. `POST /principals` creates an
 * ACCOUNT, and `PrincipalService.issueCredential` refuses Accounts outright
 * (`422 ACCOUNTS_ARE_KEYLESS`, A17.1/§7.1). A service Account acts through a
 * Connector, so "mint a credential now" registers one under the Account it just
 * made — `POST /services` with `ownerAccountId`, which §9.1 admits for a root
 * session and which commits the registration and the first credential in one
 * transaction. Both acts are separately audited, exactly as they are today.
 */

export interface CreateIdentityWizardProps {
  /** Preselects the kind. My connections passes 'agent'. */
  initialKind?: IdentityKind;
  /**
   * Hides step 1 entirely. My connections is the caller's own view of their own
   * connections, so the kind there is not a question — offering it would invite
   * a person to create a colleague's Account from a page that lists none.
   */
  lockKind?: boolean;
  /** Called after an identity (or a connection) is created, so a list refreshes. */
  onCreated?: () => void;
  /** Called when the person leaves the wizard. */
  onClose?: () => void;
}

type Step = 1 | 2 | 3 | 4;

interface CreatedIdentity {
  id: string;
  handle: string;
}

export const CreateIdentityWizard: React.FC<CreateIdentityWizardProps> = ({
  initialKind, lockKind = false, onCreated, onClose,
}) => {
  const { scopes, delegableScopes, loading: principalLoading } = useMyPrincipal();
  const [kind, setKind] = useState<IdentityKind | null>(initialKind ?? null);
  const [step, setStep] = useState<Step>(lockKind || initialKind ? 2 : 1);

  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<string>(defaultRoleFor(initialKind ?? 'service'));
  const [purpose, setPurpose] = useState('');

  const [mintNow, setMintNow] = useState(true);
  const [transport, setTransport] = useState<'api' | 'mcp'>(DEFAULT_SERVICE_TRANSPORT);
  const [narrowing, setNarrowing] = useState(false);
  const [chosenScopes, setChosenScopes] = useState<string[]>([]);
  /** Whether the person has EDITED the selection — see ConnectAgentWizard. */
  const [scopesEdited, setScopesEdited] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The Account, once it exists. A Service is two acts, and the second one can
   * be refused on its own; keeping the first act's result here means a retry
   * does not create a second Account under a second handle.
   */
  const [created, setCreated] = useState<CreatedIdentity | null>(null);
  const [pack, setPack] = useState<OnboardingPack | null>(null);

  const sessionHoldsRoot = useMemo(() => holdsRoot(scopes), [scopes]);
  const available = useMemo(
    () => connectableScopes(scopes, delegableScopes),
    [scopes, delegableScopes],
  );

  useEffect(() => {
    // The 2026-09-07 default: everything the caller may delegate, selected, and
    // still tracking a LATE answer until the person has chosen for themselves.
    if (!scopesEdited) setChosenScopes(defaultScopesFor(available));
  }, [available, scopesEdited]);

  const chooseScopes = (next: string[]) => {
    setScopesEdited(true);
    setChosenScopes(next);
  };

  const chooseKind = (next: IdentityKind) => {
    setKind(next);
    setRole(defaultRoleFor(next));
  };

  const purposeMissing = kind === 'service' && purpose.trim().length === 0;
  const purposeTooLong = purpose.trim().length > PURPOSE_MAX_LENGTH;
  const identityIsUsable = handleIsUsable(handle) && !purposeMissing && !purposeTooLong;

  /** The connector slug for a service's connection, derived from its handle. */
  const connectorSlug = slugForName(handle.trim());

  const submit = async () => {
    if (!kind || kind === 'agent' || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let account = created;
      if (!account) {
        const response = await authenticatedFetch(`${API_BASE}/principals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            handle: handle.trim(),
            displayName: displayName.trim() || null,
            kind,
            role,
            ...(kind === 'service' ? { purpose: purpose.trim() } : {}),
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success) {
          setError(principalRefusalMessage(response.status, data));
          return;
        }
        account = { id: String(data.principal?.id ?? ''), handle: handle.trim() };
        setCreated(account);
        onCreated?.();
      }

      if (kind !== 'service' || !mintNow) {
        setStep(4);
        return;
      }

      if (!slugIsLegal(connectorSlug)) {
        // Unreachable from a legal handle, but a wrong sentence here would send
        // somebody hunting a connection that was never attempted.
        setError(`The identity ${account.handle} was created. Its connection was not: “${connectorSlug}” is not a name the board accepts. Create the connection from My connections.`);
        setStep(4);
        return;
      }

      const connection = await authenticatedFetch(`${API_BASE}/services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: connectorSlug,
          name: displayName.trim() || account.handle,
          description: `Connection for the ${account.handle} service identity.`,
          kind: 'connector',
          ownerAccountId: account.id,
          issueCredential: {
            scopes: chosenScopes,
            label: account.handle.slice(0, 128),
            transport,
          },
        }),
      });
      const connectionData = await connection.json().catch(() => ({}));
      if (!connection.ok) {
        // The Account committed; the connection did not. Say both halves —
        // "nothing was created" would be false, and a retry must not make a
        // second Account, which is why `created` is held above.
        setError(`${account.handle} was created, but its connection was not: ${connectionRefusalMessage(connection.status, connectionData)}`);
        return;
      }
      if (!connectionData?.onboarding) {
        setError(`${account.handle} and its connection were created, but the board returned no setup pack. To recover, ${lostCredentialRecovery(scopes)}.`);
        setStep(4);
        onCreated?.();
        return;
      }
      setPack(connectionData.onboarding as OnboardingPack);
      setStep(4);
      onCreated?.();
    } catch {
      setError(created
        ? `${created.handle} was created. Its connection could not be confirmed — check My connections before trying again.`
        : 'Could not confirm whether the identity was created. Check the Identities list before trying again.');
    } finally {
      setSubmitting(false);
    }
  };

  const authoritySentence = narrowing
    ? chosenAuthoritySentence(chosenScopes.length, available.length, sessionHoldsRoot)
    : defaultAuthoritySentence(sessionHoldsRoot);

  // ── The Agent arm: the connection wizard itself, never a copy of it. ───────
  if (kind === 'agent') {
    return (
      <>
        {!lockKind && (
          <p className="conn-note">
            This connection will belong to you and act inside your own authority. For an agent that
            belongs to somebody else, create their identity here first and let them connect it from
            their own My connections.
          </p>
        )}
        <ConnectAgentWizard
          onCreated={onCreated}
          onClose={() => {
            if (lockKind) { onClose?.(); return; }
            // Back to the kind question rather than out of the flow: the person
            // came here to create an identity, not specifically a connection.
            setKind(null);
            setStep(1);
          }}
        />
      </>
    );
  }

  return (
    <section className="conn-wizard" aria-labelledby="identity-wizard-heading">
      <header className="conn-wizard-head">
        <h2 id="identity-wizard-heading"><UserPlus aria-hidden="true" /> Create identity</h2>
        <p className="conn-wizard-step" aria-live="polite">Step {step} of 4</p>
      </header>

      {error && <div className="conn-error" role="alert">{error}</div>}

      {step === 1 && (
        <div className="conn-step">
          <h3 className="conn-step-title">What are you creating?</h3>
          <div className="conn-templates" role="radiogroup" aria-label="What kind of identity">
            {IDENTITY_KINDS.map((choice) => (
              <div key={choice.kind} className="conn-template">
                <button
                  type="button"
                  role="radio"
                  aria-checked={kind === choice.kind}
                  className={kind === choice.kind ? 'conn-template-btn conn-template-btn--on' : 'conn-template-btn'}
                  onClick={() => chooseKind(choice.kind)}
                >
                  <span className="conn-template-label">{choice.label}</span>
                  <span className="conn-template-blurb">{choice.blurb}</span>
                </button>
              </div>
            ))}
          </div>
          <div className="conn-actions">
            {onClose && <Button variant="secondary" onClick={onClose}>Cancel</Button>}
            <Button onClick={() => setStep(2)} disabled={!kind} icon={<ArrowRight size={16} />}>Next</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="conn-step">
          <h3 className="conn-step-title">Name it</h3>
          <label className="conn-field" htmlFor="identity-handle">
            <span className="conn-field-label">Handle</span>
            <input
              id="identity-handle"
              className="form-input"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              maxLength={64}
              autoComplete="off"
              placeholder="build-agent"
            />
          </label>
          {handle.trim().length > 0 && !handleIsUsable(handle) && (
            <p className="conn-warn" role="status">
              A handle is lowercase letters, digits, hyphens and underscores, and starts with a
              letter or a digit.
            </p>
          )}
          <label className="conn-field" htmlFor="identity-display-name">
            <span className="conn-field-label">Display name</span>
            <input
              id="identity-display-name"
              className="form-input"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={128}
              autoComplete="off"
              placeholder="Build Agent"
            />
          </label>
          <label className="conn-field" htmlFor="identity-role">
            <span className="conn-field-label">Role</span>
            <select
              id="identity-role"
              className="form-select"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {ROLE_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </select>
          </label>
          <p className="conn-note">
            {ROLE_CHOICES.find((choice) => choice.value === role)?.line}
          </p>

          {kind === 'service' && (
            <>
              <label className="conn-field" htmlFor="identity-purpose">
                <span className="conn-field-label">Purpose</span>
                <input
                  id="identity-purpose"
                  className="form-input"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  maxLength={PURPOSE_MAX_LENGTH}
                  autoComplete="off"
                  placeholder="Runs the nightly build and files its reports."
                  aria-describedby="identity-purpose-rule"
                />
              </label>
              <p className="conn-note" id="identity-purpose-rule">
                What this service is for, in one line. {PURPOSE_REQUIRED_MESSAGE}
              </p>
              {purposeMissing && handle.trim().length > 0 && (
                <p className="conn-warn" role="status">{PURPOSE_REQUIRED_MESSAGE}</p>
              )}
            </>
          )}

          <div className="conn-actions">
            <Button
              variant="secondary"
              onClick={() => (lockKind ? onClose?.() : setStep(1))}
              icon={<ArrowLeft size={16} />}
            >
              {lockKind ? 'Cancel' : 'Back'}
            </Button>
            <Button onClick={() => setStep(3)} disabled={!identityIsUsable} icon={<ArrowRight size={16} />}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="conn-step">
          <h3 className="conn-step-title">Access</h3>

          {kind === 'human' && (
            <p className="conn-note">
              People sign in; they never hold a key of their own. Once {handle.trim() || 'this account'} exists,
              give them a password in the Access manager, or send an invitation if an identity
              provider is configured.
            </p>
          )}

          {kind === 'service' && (
            <>
              <label className="conn-check" htmlFor="identity-mint">
                <input
                  id="identity-mint"
                  type="checkbox"
                  checked={mintNow}
                  onChange={(event) => setMintNow(event.target.checked)}
                />
                <span>Mint a credential now</span>
              </label>
              <p className="conn-note">
                A service Account holds no key itself, so this registers a connection under it and
                issues that connection&rsquo;s credential. You can do it later instead.
              </p>

              {mintNow && (
                <>
                  <fieldset className="conn-fieldset">
                    <legend className="conn-field-label">How it will connect</legend>
                    {SERVICE_TRANSPORTS.map((choice) => (
                      <label key={choice.value} className="conn-check" htmlFor={`identity-transport-${choice.value}`}>
                        <input
                          id={`identity-transport-${choice.value}`}
                          type="radio"
                          name="identity-transport"
                          value={choice.value}
                          checked={transport === choice.value}
                          onChange={() => setTransport(choice.value)}
                        />
                        <span>{choice.label} — {choice.note}</span>
                      </label>
                    ))}
                  </fieldset>

                  <div className="conn-authority">
                    <p className="conn-authority-line">
                      <ShieldCheck size={16} aria-hidden="true" />
                      <span>{authoritySentence}</span>
                      {!narrowing && (
                        <button type="button" className="conn-linkbtn" onClick={() => setNarrowing(true)}>
                          {SCOPE_DISCLOSURE_LABEL}
                        </button>
                      )}
                    </p>
                    {narrowing && (
                      <ScopeNarrowing
                        available={available}
                        selected={chosenScopes}
                        onChange={chooseScopes}
                        idPrefix="identity-scope"
                      />
                    )}
                    {principalLoading && (
                      <p className="conn-note"><Loader2 className="conn-spin" aria-hidden="true" /> Reading what you can do…</p>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          <div className="conn-actions">
            <Button variant="secondary" onClick={() => setStep(2)} icon={<ArrowLeft size={16} />}>Back</Button>
            <Button onClick={submit} disabled={submitting || (kind === 'service' && mintNow && chosenScopes.length === 0)}>
              {submitting ? 'Creating…' : 'Create identity'}
            </Button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="conn-step">
          <h3 className="conn-step-title">{created?.handle ?? 'The identity'} is ready</h3>
          {pack ? (
            <BootstrapPane
              mcpConfig={pack.mcpConfig}
              cliEnv={pack.cliEnv}
              bootstrapLine={pack.bootstrapLine}
              boardEndpoint={pack.boardEndpoint}
              transport={transport}
              initialTab={transport === 'api' ? 'cli' : 'generic'}
              carriesSecret
              recovery={lostCredentialRecovery(scopes)}
            />
          ) : (
            <p className="conn-note">
              {kind === 'human'
                ? 'Give them a password in the Access manager, or send an invitation, and they can sign in.'
                : 'No credential was issued. Create a connection for this identity when it needs one.'}
            </p>
          )}
          <p className="conn-note">
            {/* Router links, never root-absolute hrefs: the dashboard is mounted
                under a basename ('/dashboard/' in production), so a root-absolute
                anchor lands on a 404 in every deployment that is not served
                from the site root. */}
            <Link className="conn-linkbtn" to="/settings/principals">Open Identities</Link>
            {' · '}
            <Link className="conn-linkbtn" to="/settings/connections">My connections</Link>
          </p>
          <div className="conn-actions">
            <Button onClick={() => onClose?.()}>Done</Button>
          </div>
        </div>
      )}
    </section>
  );
};

export default CreateIdentityWizard;
