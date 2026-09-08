import React, { useEffect, useState, FormEvent } from 'react';
import { auth } from '../utils/auth';
import { StatusOrb } from '../components/StatusOrb';
import { Wordmark } from '../components/Wordmark';
import { useRelayHallConfig } from '../contexts/RelayHallConfigContext';
import { IS_PUBLIC_BUILD, LICENSE_URL, SOURCE_LABEL, SOURCE_URL } from '../utils/build';
import { RELAYHALL_VERSION } from '../utils/releaseInfo';
import './LoginPage.css';
import { AlertTriangle } from 'lucide-react';

interface LoginPageProps {
  onLoginSuccess: () => void;
}

/**
 * A federated login the board REFUSED lands the person back here by
 * redirect, carrying the refusal's NAMED code in `sso_refused` (card
 * `a07f3277`; `routes/sso` sends only the code, never the error's text).
 * The person-visible sentence is chosen HERE from a fixed vocabulary, and an
 * unknown or malformed code gets the neutral sentence rather than being
 * echoed. The code itself is rendered beside the sentence — a support
 * question about a refused sign-in is answerable only if the person can read
 * it back.
 */
const SSO_REFUSAL_COPY: Record<string, string> = {
  SSO_LOGIN_GROUP_REFUSED: 'This account is not a member of a group permitted to sign in here.',
  SSO_ACCOUNT_UNAVAILABLE: 'No account could be resolved for this sign-in.',
  SSO_INVITATION_REQUIRED: 'This Identity provider admits new people by invitation only.',
  SSO_INVITATION_INVALID: 'That invitation is not valid for this Identity provider.',
  SSO_SUBJECT_ALREADY_LINKED: 'That identity is already linked to another account.',
  SSO_HANDLE_COLLISION: 'That account name is already taken.',
  SSO_CLAIM_MATCH_REFUSED: 'Claim matching is refused for this account.',
  SSO_ID_TOKEN_REFUSED: 'The identity token was refused.',
  SSO_PROVIDER_ERROR: 'The Identity provider refused the authentication.',
  SSO_PROVIDER_UNREACHABLE: 'The Identity provider could not be reached or validated.',
  SSO_STATE_UNKNOWN: 'That sign-in attempt is unknown, expired or already used. Start again.',
  SSO_COOKIE_MISMATCH: 'The sign-in could not be tied to this browser. Start again.',
};

export function ssoRefusalFromSearch(search: string): { code: string; message: string } | null {
  const code = new URLSearchParams(search).get('sso_refused');
  if (!code || !/^[A-Z0-9_]{1,64}$/.test(code)) return null;
  return { code, message: SSO_REFUSAL_COPY[code] ?? 'The sign-in could not be completed.' };
}

/** The client-side half of the password policy. The server is authoritative
 * (`checkPasswordPolicy`); this only spares a round trip and says the rule
 * before it is broken rather than after. */
const MIN_ADMINISTRATOR_PASSWORD = 12;

/**
 * THE FIRST-RUN STEP (owner ruling `60307311` §1.1).
 *
 * A deployment with no administrator Account has no in-band way to make one,
 * and the advice it used to get was "edit the database". This is the step that
 * replaces that advice: it appears exactly while `/config` reports
 * `auth.firstRun`, creates one named local administrator, signs them in, and
 * is gone.
 *
 * The break-glass door stays on the page behind "Sign in instead" throughout:
 * a person who arrives at a first-run deployment and already knows the
 * deployment password must never be forced through a step meant for somebody
 * else.
 */
const FirstRunStep: React.FC<{
  onCreated: () => void;
  onDismiss: () => void;
}> = ({ onCreated, onDismiss }) => {
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const trimmedHandle = handle.trim().toLowerCase();
  const ready = trimmedHandle.length > 1
    && password.length >= MIN_ADMINISTRATOR_PASSWORD
    && password === confirmation;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirmation) {
      setError('The two passwords do not match');
      return;
    }
    if (password.length < MIN_ADMINISTRATOR_PASSWORD) {
      setError(`The password must be at least ${MIN_ADMINISTRATOR_PASSWORD} characters`);
      return;
    }
    setLoading(true);
    const result = await auth.completeFirstRun(trimmedHandle, displayName.trim(), password);
    if (result.success) {
      onCreated();
      return;
    }
    setError(result.error || 'The administrator could not be created');
    setPassword('');
    setConfirmation('');
    setLoading(false);
  };

  return (
    <form onSubmit={handleSubmit} className="login-form" aria-labelledby="login-firstrun-heading">
      <p className="login-firstrun-lede" id="login-firstrun-heading">
        This deployment has no administrator yet. Create one to get started — you will be signed
        in as that person, and this step will not appear again.
      </p>

      <div className="login-input-group">
        <label className="login-label" htmlFor="login-firstrun-handle">Account name</label>
        <input
          id="login-firstrun-handle"
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="ada"
          className="login-input"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby="login-firstrun-handle-hint"
          autoFocus
          disabled={loading}
        />
        <p className="login-hint" id="login-firstrun-handle-hint">
          Lowercase letters, digits, dot, dash and underscore. This is the name you sign in with.
        </p>
      </div>

      <div className="login-input-group">
        <label className="login-label" htmlFor="login-firstrun-name">Display name</label>
        <input
          id="login-firstrun-name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Ada Lovelace"
          className="login-input"
          autoComplete="name"
          aria-describedby="login-firstrun-name-hint"
          disabled={loading}
        />
        <p className="login-hint" id="login-firstrun-name-hint">Optional — how your name appears on the board.</p>
      </div>

      <div className="login-input-group">
        <label className="login-label" htmlFor="login-firstrun-password">Password</label>
        <input
          id="login-firstrun-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="login-input"
          autoComplete="new-password"
          aria-describedby="login-firstrun-password-hint"
          disabled={loading}
        />
        <p className="login-hint" id="login-firstrun-password-hint">
          At least {MIN_ADMINISTRATOR_PASSWORD} characters. This is your own password, not the
          deployment one.
        </p>
      </div>

      <div className="login-input-group">
        <label className="login-label" htmlFor="login-firstrun-confirm">Confirm password</label>
        <input
          id="login-firstrun-confirm"
          type="password"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          className="login-input"
          autoComplete="new-password"
          disabled={loading}
        />
      </div>

      {error && (
        <div className="login-error" role="alert">
          <span className="error-icon"><AlertTriangle size={16} aria-hidden="true" /></span>
          <span>{error}</span>
        </div>
      )}

      <button type="submit" className="login-button" disabled={loading || !ready}>
        {loading ? (
          <>
            <span className="login-spinner" />
            <span>Creating the administrator...</span>
          </>
        ) : (
          <span>Create the first administrator</span>
        )}
      </button>

      <button type="button" className="login-link" onClick={onDismiss} disabled={loading}>
        Sign in with the deployment password instead
      </button>
    </form>
  );
};

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const { config } = useRelayHallConfig();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  // Read once on mount; the query string is then cleared so a reload does not
  // re-announce a refusal that is over.
  const [ssoRefusal] = useState(() => ssoRefusalFromSearch(window.location.search));
  useEffect(() => {
    if (!ssoRefusal) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('sso_refused');
      window.history.replaceState(window.history.state, '', url.toString());
    } catch {
      // A history that refuses the rewrite costs nothing but a second read.
    }
  }, [ssoRefusal]);

  /**
   * SS-W1: the account field appears only where the deployment actually
   * offers per-Account login sessions, which `/config` says in a
   * presence-only block. Where it does not, this page is byte-for-byte the
   * password-only form it has always been.
   */
  const sessionsAvailable = config.auth.sessions;
  const trimmedAccount = account.trim();

  /**
   * SS-W2: the same presence-only treatment. The block carries whether this
   * deployment federates and what to call the button, which a caller learns
   * anyway the moment they click it, and nothing else — no issuer, no
   * endpoint, no client id.
   */
  const ssoAvailable = config.auth.sso.enabled;
  const ssoLabel = config.auth.sso.displayName ?? 'your identity provider';

  /**
   * The first-run step (owner ruling 60307311 §1.1). Derived on every render
   * rather than seeded into state: `/config` arrives after the first paint, so
   * a state initialiser would read the fail-closed default and the step would
   * never appear. Dismissal is the only local half — it is this visit's
   * choice, not a fact about the deployment.
   */
  const [firstRunDismissed, setFirstRunDismissed] = useState(false);
  const firstRunMode = config.auth.firstRun && !firstRunDismissed;

  const handleSso = async () => {
    setError('');
    setSsoLoading(true);
    const result = await auth.startSso();
    if (result.success && result.authorizeUrl) {
      // The browser makes the navigation, which is what makes this a real
      // top-level redirect to the provider rather than a fetch it would block.
      window.location.assign(result.authorizeUrl);
      return;
    }
    // A federated login that cannot start must not strand anyone: the
    // password form below is still here, and 8.5's break-glass door with it.
    setError(result.error || 'Could not start single sign-on');
    setSsoLoading(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // An account name signs that Account in. A blank one is the permanent
    // break-glass door (design d95136d7 §8.5), which no configuration can
    // take away — including a broken identity provider.
    const result = sessionsAvailable && trimmedAccount
      ? await auth.loginWithAccount(trimmedAccount, password)
      : await auth.login(password);

    if (result.success) {
      onLoginSuccess();
    } else {
      setError(result.error || 'Invalid password');
      setShake(true);
      setTimeout(() => setShake(false), 500);
      setPassword('');
    }

    setLoading(false);
  };

  return (
    <div className="login-page">
      <div className={`login-container ${shake ? 'shake' : ''}`}>
        <div className="login-logo">
          {config.assets.logo
            ? <img src={config.assets.logo} alt={`${config.displayName} logo`} />
            : <StatusOrb state="idle" size={100} />}
        </div>

        <h1 className="login-title">{config.loginTitle}</h1>
        <p className="login-subtitle">{config.loginSubtitle}</p>

        {ssoRefusal && (
          <div className="login-error" role="alert" data-sso-refusal={ssoRefusal.code}>
            <span className="error-icon"><AlertTriangle size={16} aria-hidden="true" /></span>
            <span>Sign-in refused: {ssoRefusal.message} (reason {ssoRefusal.code})</span>
          </div>
        )}

        {firstRunMode ? (
          <FirstRunStep onCreated={onLoginSuccess} onDismiss={() => setFirstRunDismissed(true)} />
        ) : (
        <>
        {ssoAvailable && (
          <div className="login-sso">
            <button
              type="button"
              className="login-button login-button--sso"
              onClick={handleSso}
              disabled={ssoLoading || loading}
            >
              {ssoLoading ? (
                <>
                  <span className="login-spinner" />
                  <span>Contacting {ssoLabel}…</span>
                </>
              ) : (
                <span>Sign in with {ssoLabel}</span>
              )}
            </button>
            <div className="login-sso-divider" role="separator">
              <span>or sign in with a password</span>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          {sessionsAvailable && (
            <div className="login-input-group">
              <label className="login-label" htmlFor="login-account">Account</label>
              <input
                id="login-account"
                type="text"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="Account"
                className="login-input"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby="login-account-hint"
                autoFocus
                disabled={loading}
              />
              <p className="login-hint" id="login-account-hint">
                Leave blank to sign in with the local administrator password.
              </p>
            </div>
          )}

          <div className="login-input-group">
            <label className="login-label" htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="login-input"
              autoComplete="current-password"
              autoFocus={!sessionsAvailable}
              disabled={loading}
            />
          </div>

          {error && (
            <div className="login-error">
              <span className="error-icon"><AlertTriangle size={16} aria-hidden="true" /></span>
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="login-button"
            disabled={loading || !password}
          >
            {loading ? (
              <>
                <span className="login-spinner" />
                <span>Authenticating...</span>
              </>
            ) : (
              <span>Login</span>
            )}
          </button>
        </form>
        </>
        )}

        {/* Fixed product attribution (§5.3 / §6): not reachable by any
            Appearance field, and deliberately below the deployment's own title
            and subtitle. */}
        <div className="login-footer">
          <p className="login-attribution">
            <span>Powered by</span>{' '}
            <Wordmark height={15} />{' '}
            <span>v{RELAYHALL_VERSION}</span>
          </p>
          <p className="login-attribution-links">
            {IS_PUBLIC_BUILD ? (
              <>
                <a href={LICENSE_URL} target="_blank" rel="noreferrer noopener">MIT licensed</a>
                <span className="login-attribution-separator" aria-hidden="true">·</span>
                <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener">{SOURCE_LABEL}</a>
              </>
            ) : (
              <>
                <span>MIT licensed</span>
                <span className="login-attribution-separator" aria-hidden="true">·</span>
                <span>{SOURCE_LABEL}</span>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};
