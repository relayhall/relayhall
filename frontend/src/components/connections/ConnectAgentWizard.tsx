import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, Plug, ShieldCheck } from 'lucide-react';
import { Button } from '../Button';
import { authenticatedFetch } from '../../utils/auth';
import { useMyPrincipal } from '../../hooks/usePrincipals';
import {
  CONNECTION_TEMPLATES, ConnectionTemplate, OnboardingPack, SCOPE_DISCLOSURE_LABEL,
  chosenAuthoritySentence, connectableScopes, defaultAuthoritySentence,
  defaultScopesFor, holdsRoot, lostCredentialRecovery, recommendedScopesFor,
  connectionRefusalMessage, slugForName, slugIsLegal, slugRefusal,
} from '../../types/connections';
import { BootstrapPane } from './BootstrapPane';
import { ScopeNarrowing } from './ScopeNarrowing';
import './connections.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * The three-step "Connect your agent" wizard (owner design record 99d6b0ad
 * §3.1 and decision 1).
 *
 *   1. What is it for?  — a template: transport class, bootstrap tab, kind.
 *   2. Name it.
 *   3. Bootstrap pane — the one-time pack, one tab per harness.
 *
 * WHAT IT CALLS, AND WHY THAT ONE. Registration and the first credential are a
 * SINGLE act on the existing self-service route: `POST /services` with
 * `kind: 'connector'` and `issueCredential`. That route is the §7.4 sentence in
 * code — "CONNECTOR packs return in the Connector-creation response" — it is
 * login-session-only, it refuses any scope outside the session's own effective
 * set (§5.2 rule 1, `ISSUE_EXCEEDS_SESSION`), and it refuses an owner other
 * than the caller unless the caller is root (`OWNER_OUT_OF_SUBTREE`). The
 * wizard therefore adds NO authority: everything it can do, the person could
 * already do with the same session against the same route.
 *
 * DECISION 1. The default authority is everything the person may delegate. The
 * wizard reads that set from the board itself (`GET /principals/me` answers
 * `delegableScopes` per authentication kind) and pre-selects ALL of it — the
 * one-sentence summary says so — with *narrow it* revealing the same scopes
 * editor the Advanced tab uses. The template's working set stays on screen as a
 * one-click RECOMMENDATION and is never applied on its own.
 *
 * THE ADMINISTRATOR ARM (card 6e25ae48). For `admin` and `orchestrator` — the
 * two roles a fresh deployment can possibly be administered by — the session's
 * own set is exactly `['root']`, and `root` is the one scope credential
 * issuance refuses outright (§5.2 rule 2 / AZ-18). Read literally against the
 * session's OWN scopes, decision 1 named a credential the board will never
 * mint, so the headline day-one flow returned HTTP 500 to the only person who
 * could run it. What the wizard offers such a session is therefore the SERVER's
 * delegable set, never the caller's own.
 *
 * WHY THERE IS NO SECOND ARM ANY MORE (owner ruling 2026-09-07, card
 * `07d09eaf`). Declared amendment UX-A1 briefly made an administrator's default
 * the step-1 template's working set. A credential carrying only that set cannot
 * bootstrap — `relayhall_brief_compile {session: true}` needs `principals:read`
 * and no template names it — so the flow ended in a 403 instead of a 500. The
 * owner ruled the default rather than the check: every session, every template,
 * starts from the full delegable catalogue and narrows from there. The rule and
 * the copy both live in `types/connections`, so this file chooses nothing.
 *
 * THE PACK IS NEVER FETCHED AGAIN. It is not stored server-side (§7.4), so step
 * 3 holds the only copy there will ever be, in this page, until it is closed.
 */

export interface ConnectAgentWizardProps {
  /** Called after a connection is created, so a list can refresh. */
  onCreated?: () => void;
  /** Called when the person leaves the wizard. */
  onClose?: () => void;
}

type Step = 1 | 2 | 3;

export const ConnectAgentWizard: React.FC<ConnectAgentWizardProps> = ({ onCreated, onClose }) => {
  const { scopes, delegableScopes, loading: principalLoading } = useMyPrincipal();
  const [step, setStep] = useState<Step>(1);
  const [template, setTemplate] = useState<ConnectionTemplate | null>(null);
  const [narrowing, setNarrowing] = useState(false);
  const [chosenScopes, setChosenScopes] = useState<string[]>([]);
  /**
   * Whether the person has actually EDITED the selection — not merely opened
   * the disclosure. Opening *narrow it* used to be what stopped the default
   * from tracking the session, so someone who opened it while
   * "Reading what you can do…" was still on screen ended up with every box
   * unchecked under a sentence promising the opposite, and a create call
   * carrying an empty scope set that the board refuses with 422.
   */
  const [scopesEdited, setScopesEdited] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pack, setPack] = useState<OnboardingPack | null>(null);

  /** Whether this session holds the sentinel it can never pass on. */
  const sessionHoldsRoot = useMemo(() => holdsRoot(scopes), [scopes]);

  /** What this connection MAY be given: the ceiling, the menu and the default's
   *  source. Never the caller's literal `root` — see `connectableScopes`. */
  const available = useMemo(
    () => connectableScopes(scopes, delegableScopes),
    [scopes, delegableScopes],
  );

  useEffect(() => {
    // Decision 1: everything you may delegate, selected by default, every time
    // the ceiling resolves — and it keeps tracking a LATE answer until the
    // person has edited the selection themselves. The gate is "have they chosen
    // something?", never "have they opened the panel?".
    //
    // `template` is NOT a dependency, and that is the 2026-09-07 ruling in one
    // line: the default no longer depends on what the connection is for, so
    // changing the step-1 choice cannot silently rewrite an authority the
    // person has already read.
    if (!scopesEdited) setChosenScopes(defaultScopesFor(available));
  }, [available, scopesEdited]);

  /** Every path that changes the selection goes through here, so the flag
   *  cannot be set by one control and missed by another. */
  const chooseScopes = (next: string[]) => {
    setScopesEdited(true);
    setChosenScopes(next);
  };

  const slug = slugForName(name);
  const nameIsUsable = name.trim().length > 0 && slugIsLegal(slug);

  const create = async () => {
    if (!template || !nameIsUsable) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`${API_BASE}/services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          name: name.trim(),
          description: template.registrationText,
          kind: 'connector',
          issueCredential: {
            scopes: chosenScopes,
            label: name.trim().slice(0, 128),
            transport: template.transport,
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(connectionRefusalMessage(response.status, data));
        return;
      }
      if (!data?.onboarding) {
        // The registry row exists but no pack came back. Say exactly that:
        // pretending the flow succeeded would leave a connection with a
        // credential nobody ever saw.
        setError(`The connection was registered but the board returned no setup pack. To recover, ${lostCredentialRecovery(scopes)}.`);
        onCreated?.();
        return;
      }
      setPack(data.onboarding as OnboardingPack);
      setStep(3);
      onCreated?.();
    } catch {
      // The request may have COMMITTED before the response was lost — the
      // client cannot tell a refused connection from a lost reply. Claiming
      // "nothing was created" would send a person to retry the same name,
      // collect the global-slug 409, and never see the one-time credential the
      // committed call already issued.
      // The recovery instruction is derived from the SAME predicate that
      // enables My connections' Regenerate control, so this sentence cannot
      // send a person to an action the next screen refuses them (P3-R2).
      setError(`Could not confirm whether the connection was created. Check My connections before trying again — if it is there, its credential was shown only in the reply that was lost, so ${lostCredentialRecovery(scopes)}.`);
      onCreated?.();
    } finally {
      setSubmitting(false);
    }
  };

  const authoritySentence = narrowing
    ? chosenAuthoritySentence(chosenScopes.length, available.length, sessionHoldsRoot)
    : defaultAuthoritySentence(sessionHoldsRoot);

  return (
    <section className="conn-wizard" aria-labelledby="conn-wizard-heading">
      <header className="conn-wizard-head">
        <h2 id="conn-wizard-heading"><Plug aria-hidden="true" /> Connect your agent</h2>
        <p className="conn-wizard-step" aria-live="polite">Step {step} of 3</p>
      </header>

      {error && <div className="conn-error" role="alert">{error}</div>}

      {step === 1 && (
        <div className="conn-step">
          <h3 className="conn-step-title">What is it for?</h3>
          {/* A radiogroup, deliberately NOT a list: putting role="radiogroup"
              on a <ul> strips the implicit list role from the element, and its
              <li> children are then orphaned items with no owning list — which
              is exactly what the a11y suite caught. Divs carry the layout. */}
          <div className="conn-templates" role="radiogroup" aria-label="What the connection is for">
            {CONNECTION_TEMPLATES.map((candidate) => {
              const unavailable = Boolean(candidate.unavailableReason);
              const selected = template?.key === candidate.key;
              return (
                <div key={candidate.key} className="conn-template">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-disabled={unavailable || undefined}
                    disabled={unavailable}
                    className={selected ? 'conn-template-btn conn-template-btn--on' : 'conn-template-btn'}
                    onClick={() => setTemplate(candidate)}
                  >
                    <span className="conn-template-label">{candidate.label}</span>
                    <span className="conn-template-blurb">{candidate.blurb}</span>
                    {unavailable
                      ? <span className="conn-template-note">{candidate.unavailableReason}</span>
                      : <span className="conn-template-note">Transport: {candidate.transport}</span>}
                  </button>
                </div>
              );
            })}
          </div>

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
                idPrefix="conn-wizard-scope"
                recommended={template ? recommendedScopesFor(template, available) : undefined}
                recommendedLabel={template ? `Use the recommended set for ${template.label}` : undefined}
              />
            )}
            {principalLoading && (
              <p className="conn-note"><Loader2 className="conn-spin" aria-hidden="true" /> Reading what you can do…</p>
            )}
          </div>

          <div className="conn-actions">
            {onClose && <Button variant="secondary" onClick={onClose}>Cancel</Button>}
            <Button
              onClick={() => setStep(2)}
              disabled={!template}
              icon={<ArrowRight size={16} />}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="conn-step">
          <h3 className="conn-step-title">Name it</h3>
          <p className="conn-note">
            A name you will recognise in a list — &ldquo;Laptop&rdquo;, &ldquo;CI runner&rdquo;.
          </p>
          <label className="conn-field" htmlFor="conn-name">
            <span className="conn-field-label">Name</span>
            <input
              id="conn-name"
              className="form-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={128}
              autoComplete="off"
            />
          </label>
          {name.trim().length > 0 && slugRefusal(slug) === 'shape' && (
            <p className="conn-warn" role="status">
              That name has no letters or digits the board can turn into an address. Add at least one.
            </p>
          )}
          {name.trim().length > 0 && slugRefusal(slug) === 'reserved' && (
            <p className="conn-warn" role="status">
              &ldquo;{slug}&rdquo; is a name the board keeps for itself. Pick another.
            </p>
          )}
          {nameIsUsable && (
            <p className="conn-note">Board address: <code className="conn-inline-code">{slug}</code></p>
          )}
          <div className="conn-actions">
            <Button variant="secondary" onClick={() => setStep(1)} icon={<ArrowLeft size={16} />}>Back</Button>
            <Button onClick={create} disabled={!nameIsUsable || submitting}>
              {submitting ? 'Creating…' : 'Create connection'}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && pack && (
        <div className="conn-step">
          <h3 className="conn-step-title">Set up {name.trim()}</h3>
          <BootstrapPane
            mcpConfig={pack.mcpConfig}
            cliEnv={pack.cliEnv}
            bootstrapLine={pack.bootstrapLine}
            boardEndpoint={pack.boardEndpoint}
            transport={template?.transport ?? 'any'}
            initialTab={template?.defaultTab}
            carriesSecret
            recovery={lostCredentialRecovery(scopes)}
          />
          <div className="conn-actions">
            <Button onClick={() => onClose?.()}>Done</Button>
          </div>
        </div>
      )}
    </section>
  );
};
