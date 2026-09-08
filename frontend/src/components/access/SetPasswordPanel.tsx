import React, { useMemo, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import { authenticatedFetch } from '../../utils/auth';
import { mayManagePasswordFor } from '../../utils/administratorSession';
import type { Principal } from '../../types/task';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * THE PASSWORD CONTROL (card `bc5cd9f0`).
 *
 * BETA-SMOKE created a second human Account on a fresh install with SSO off and
 * found no shipped way to let that person sign in. `PUT /principals/:id/password`
 * existed and worked; nothing called it. The Identities row offered only
 * "Disable", the CLI had no verb, `relayhall invitation mint` needs an Identity
 * provider a fresh install does not have, and the first-run act is closed after
 * the first administrator. Onboarding a colleague meant hand-written HTTP.
 *
 * ── WHY A NEW COMPONENT, AND WHY HERE ──
 *
 * Here, because giving somebody a way in is an administrator act and the Access
 * manager is where administrator acts live: it sits beside the role control it
 * shares a bound with, and the two together are the whole of "let this person
 * in, and decide what they may reach". Its own file, because the Accounts page
 * is being restyled by another lane in this same window and a shared edit there
 * would collide with work this lane cannot see.
 *
 * ── WHAT IT DECIDES, AND WHAT IT DOES NOT ──
 *
 * The server is the authority. This panel renders the refusal it is given
 * rather than pre-judging it, and the only thing it decides locally is what to
 * OFFER: the target list is narrowed by `mayManagePasswordFor`, the display
 * half of the route's `canAssignRole(issuerRole, target.role)` bound, so the
 * common refusal is unreachable rather than merely explained.
 *
 * IT STATES NO PASSWORD POLICY. The minimum length and the bcrypt byte ceiling
 * live in ONE place, `backend/src/services/AccountPasswordService.checkPasswordPolicy`,
 * shared with the first-run act precisely so a policy cannot come to differ in
 * two places. A mirror here would be a third. A password this board will not
 * accept is refused by name (PASSWORD_TOO_SHORT, PASSWORD_TOO_LONG) and that
 * sentence is what the person reads. The one check made locally is that the two
 * fields match, which is not policy — it is a typing mistake the server cannot
 * see.
 *
 * NOTHING IS REVEALED. The person doing this typed the password; there is no
 * one-time secret to show, and neither field's value is ever echoed back, put
 * in a URL, or kept after the call returns.
 */
export const SetPasswordPanel: React.FC<{
  principals: Principal[];
  issuerRole: string | null;
  ownPrincipalId: string | null;
  surface: (kind: 'notice' | 'error', message: string) => void;
}> = ({ principals, issuerRole, ownPrincipalId, surface }) => {
  const [principalId, setPrincipalId] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'notice' | 'error'; message: string } | null>(null);

  /**
   * The Accounts this session can actually act on.
   *
   * Humans only — AUTHZ §7.1 gives a password to nothing else, and
   * `AccountPasswordService` refuses the rest by name (PASSWORD_IS_FOR_HUMANS).
   * Never the caller's own row: changing your own password is a different act
   * with a different rule (the current one must be re-entered), and it belongs
   * on your own settings rather than in the Access manager. Never `system`, the
   * request-less internal actor, and never the break-glass local administrator,
   * whose password is not set from here so the deployment always has a way back
   * in. And never an Account whose role is above this session's own authority.
   */
  const targets = useMemo(
    () => principals.filter((candidate) => candidate.kind === 'human'
      && candidate.id !== ownPrincipalId
      && candidate.handle !== 'system'
      && candidate.handle !== 'dashboard_user'
      && candidate.status === 'active'
      && mayManagePasswordFor(issuerRole, candidate.role)),
    [principals, issuerRole, ownPrincipalId],
  );

  const selected = targets.find((candidate) => candidate.id === principalId);
  const matches = password.length > 0 && password === confirmation;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!principalId || !matches) return;
    setBusy(true);
    setOutcome(null);
    try {
      const response = await authenticatedFetch(`${API_BASE}/principals/${principalId}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.message || data.error || `The board refused the request (${response.status}).`);
      }
      const message = data.note || `${selected?.handle} can sign in with this password now.`;
      setOutcome({ kind: 'notice', message });
      surface('notice', message);
      // Cleared on success AND on failure below: a typed password has no reason
      // to sit in a live page after the call it was typed for.
      setPassword('');
      setConfirmation('');
    } catch (err) {
      setPassword('');
      setConfirmation('');
      const message = err instanceof Error ? err.message : 'The password could not be set';
      setOutcome({ kind: 'error', message });
      surface('error', message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="axm-section" aria-labelledby="axm-password-heading">
      <div className="axm-section-head">
        <h2 id="axm-password-heading"><KeyRound aria-hidden="true" /> Passwords</h2>
      </div>
      <p className="axm-section-intro">
        How a second person gets in when no Identity provider is configured: give their Account a
        password and tell them what it is. It is an administrator-session act, it is audited, and it
        can never reach an Account whose role is above your own. Setting a password does not sign
        that Account out of anywhere it is already signed in. The break-glass local administrator and
        the internal <code>system</code> actor are not listed: the route refuses both by name.
      </p>
      <form className="axm-editor" onSubmit={submit} aria-label="Set an Account password">
        <div className="axm-editor-grid">
          <div className="form-group">
            <label htmlFor="axm-password-principal">Account</label>
            <Select
              id="axm-password-principal"
              required
              value={principalId}
              onChange={(event) => { setPrincipalId(event.target.value); setOutcome(null); }}
            >
              <option value="">Choose an Account&hellip;</option>
              {targets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.displayName ? `${candidate.displayName} (${candidate.handle})` : candidate.handle}
                  {' '}&middot; {candidate.role || 'no role'}
                </option>
              ))}
            </Select>
          </div>
          <div className="form-group">
            <label htmlFor="axm-password-value">
              New password{' '}
              <span className="axm-muted">wait for confirmation below before trying to sign in</span>
            </label>
            <input
              id="axm-password-value"
              className="form-input"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={!principalId}
              aria-describedby={outcome?.kind === 'error' ? 'axm-password-outcome' : undefined}
            />
          </div>
          <div className="form-group">
            <label htmlFor="axm-password-confirm">Type it again</label>
            <input
              id="axm-password-confirm"
              className="form-input"
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={!principalId}
              aria-describedby={
                confirmation.length > 0 && !matches ? 'axm-password-mismatch' : undefined
              }
            />
            {confirmation.length > 0 && !matches && (
              <span id="axm-password-mismatch" className="axm-muted" role="status">
                The two entries do not match.
              </span>
            )}
          </div>
        </div>
        {outcome && (
          <div
            id="axm-password-outcome"
            className={outcome.kind === 'error' ? 'axm-error' : 'axm-notice'}
            role={outcome.kind === 'error' ? 'alert' : 'status'}
          >
            {outcome.kind === 'error' && <strong>Password not set. </strong>}
            {outcome.message}
          </div>
        )}
        <div className="axm-decide-actions">
          {selected && (
            <span className="axm-muted" role="status">
              {selected.handle} carries the role {selected.role || 'none'}.
            </span>
          )}
          <Button type="submit" variant="primary" disabled={busy || !principalId || !matches}>
            {busy ? 'Setting…' : 'Set password'}
          </Button>
        </div>
      </form>
    </section>
  );
};
