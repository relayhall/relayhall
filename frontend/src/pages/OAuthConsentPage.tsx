/**
 * OAuthConsentPage — the human half of the OAuth 2.1 authorization-code flow
 * (RH-P3.C6; strategy 4e40f06f Phase 3, ratified C3 amendment).
 *
 * The board's `/oauth/authorize` endpoint validates a client's request, parks
 * it, and sends the browser here. THIS page is where a person reads what a
 * client is asking for and decides — which is why it lives in the dashboard
 * and not in a server-rendered form: one design language, one Theme, one
 * accessibility matrix, and the person is already signed in with the session
 * whose authority the decision confers.
 *
 * WHAT THE PAGE MUST NEVER DO IS DECIDE ANYTHING. It renders what the board
 * says the request is, and posts back an approval. The scope ceiling, the
 * exact redirect match, PKCE, one-time codes and the authority the resulting
 * token carries are all server-side; a page that computed any of them would be
 * a second implementation of an authorization decision.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldCheck, AlertTriangle } from 'lucide-react';

import { authenticatedFetch } from '../utils/auth';
import './OAuthConsentPage.css';
import { formatTime } from '../utils/dateFormat';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface ConsentRequest {
  id: string;
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  redirectUri: string;
  requestedScopes: string[];
  grantableScopes: string[];
  unavailableScopes: string[];
  expiresAt: string;
}

/**
 * Plain-language reading of a scope, for a person who is not the operator.
 *
 * Derived from the scope string itself rather than from a hand-maintained
 * table of every scope: a new scope family would otherwise render as nothing
 * at all, and an unexplained permission is worse than a plainly-spelled one.
 * The scope string is always shown beside the sentence, so the sentence is a
 * help, never the only truth on screen.
 */
function describeScope(scope: string): string {
  const [family, verb] = scope.split(':');
  const object = family.replace(/-/g, ' ');
  switch (verb) {
    case 'read': return `Read your ${object}`;
    case 'write': return `Create and change ${object}`;
    case 'use': return `Load ${object} into its own context`;
    case 'invoke': return `Run ${object} outside the board`;
    case 'admin': return `Administer ${object}, including deleting and granting`;
    default: return `Act on ${object}`;
  }
}

/** The client's own name, or its identifying URL when it declares none. */
function clientLabel(request: ConsentRequest): string {
  return request.clientName?.trim() || request.clientId;
}

/**
 * An href this page is willing to build, or null.
 *
 * The board already sanitizes `client_uri` server-side (review 6fe97bc5 B3):
 * an unauthenticated caller's metadata document reaches a signed-in surface,
 * and `javascript:` in an `href` on the page that holds the dashboard session
 * is the worst place for it. This is the SECOND layer, deliberately: a value
 * this function cannot vouch for is rendered as plain text, so the page is
 * safe on its own terms even if it is ever handed a value from somewhere else.
 * `rel="noreferrer noopener"` is not URL validation and never was.
 */
function safeHttpsHref(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function OAuthConsentPage() {
  const [params] = useSearchParams();
  const requestId = params.get('request_id') ?? '';
  const [request, setRequest] = useState<ConsentRequest | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!requestId) {
      setError('This link carries no authorization request.');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    (async () => {
      try {
        const response = await authenticatedFetch(
          `${API_BASE_URL}/oauth/authorization-requests/${encodeURIComponent(requestId)}`,
          { signal: controller.signal },
        );
        const body = await response.json().catch(() => ({}));
        if (!active) return;
        if (!response.ok) {
          setError(body.error_description || 'This authorization request could not be read.');
        } else {
          setRequest(body as ConsentRequest);
          setSelected((body as ConsentRequest).grantableScopes ?? []);
        }
      } catch (cause) {
        if (active && (cause as Error).name !== 'AbortError') {
          setError('The board could not be reached.');
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [requestId]);

  const toggle = useCallback((scope: string) => {
    setSelected((current) => (current.includes(scope)
      ? current.filter((entry) => entry !== scope)
      : [...current, scope]));
  }, []);

  const decide = useCallback(async (approve: boolean) => {
    if (!request) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await authenticatedFetch(
        `${API_BASE_URL}/oauth/authorization-requests/${encodeURIComponent(request.id)}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approve, grantedScopes: approve ? selected : [] }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error_description || 'The decision could not be recorded.');
        setSubmitting(false);
        return;
      }
      // The board decides where the browser goes next: the redirect target is
      // the one it matched against the client's own metadata document, never a
      // value this page assembled.
      window.location.assign(body.redirectTo);
    } catch {
      setError('The board could not be reached.');
      setSubmitting(false);
    }
  }, [request, selected]);

  const expiry = useMemo(() => {
    if (!request) return '';
    return formatTime(request.expiresAt);
  }, [request]);

  if (loading) {
    return (
      <div className="oauth-consent">
        <p className="oauth-consent__status" role="status">Loading this authorization request…</p>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="oauth-consent">
        <div className="oauth-consent__card oauth-consent__card--problem" role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <div>
            <h1>This request cannot be shown</h1>
            <p>{error ?? 'This authorization request could not be read.'}</p>
            <p className="oauth-consent__hint">
              Nothing has been authorized. Start the connection again from the application
              that sent you here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="oauth-consent">
      <div className="oauth-consent__card">
        <header className="oauth-consent__header">
          <ShieldCheck size={28} aria-hidden="true" />
          <div>
            <h1>Authorize {clientLabel(request)}</h1>
            <p>
              This application is asking to use the board as you. Nothing is granted
              until you approve it.
            </p>
          </div>
        </header>

        <dl className="oauth-consent__facts">
          <div>
            <dt>Application</dt>
            <dd>
              {safeHttpsHref(request.clientUri)
                ? (
                  <a href={safeHttpsHref(request.clientUri) as string} rel="noreferrer noopener" target="_blank">
                    {clientLabel(request)}
                  </a>
                )
                : clientLabel(request)}
            </dd>
          </div>
          <div>
            <dt>Identified by</dt>
            <dd><code>{request.clientId}</code></dd>
          </div>
          <div>
            <dt>Will return to</dt>
            <dd><code>{request.redirectUri}</code></dd>
          </div>
          {expiry ? (
            <div>
              <dt>Request expires</dt>
              <dd>{expiry}</dd>
            </div>
          ) : null}
        </dl>

        <fieldset className="oauth-consent__scopes">
          <legend>What it is asking for</legend>
          {request.grantableScopes.length === 0 ? (
            <p className="oauth-consent__hint">
              None of the requested permissions are yours to give, so this request cannot
              be approved.
            </p>
          ) : (
            <ul>
              {request.grantableScopes.map((scope) => (
                <li key={scope}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(scope)}
                      onChange={() => toggle(scope)}
                      disabled={submitting}
                    />
                    <span className="oauth-consent__scope-text">
                      <span className="oauth-consent__scope-title">{describeScope(scope)}</span>
                      <code>{scope}</code>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {request.unavailableScopes.length > 0 ? (
            <p className="oauth-consent__unavailable">
              Not offered, because your own access does not include{' '}
              {request.unavailableScopes.map((scope) => <code key={scope}>{scope}</code>)
                .reduce<React.ReactNode[]>((all, node, index) => (
                  index === 0 ? [node] : [...all, ', ', node]), [])}
              .
            </p>
          ) : null}
        </fieldset>

        {error ? <p className="oauth-consent__error" role="alert">{error}</p> : null}

        <div className="oauth-consent__actions">
          <button
            type="button"
            className="oauth-consent__decline"
            onClick={() => decide(false)}
            disabled={submitting}
          >
            Decline
          </button>
          <button
            type="button"
            className="oauth-consent__approve"
            onClick={() => decide(true)}
            disabled={submitting || selected.length === 0}
          >
            {submitting ? 'Working…' : 'Approve'}
          </button>
        </div>
        <p className="oauth-consent__hint">
          An approved application receives a token that is checked against your access on
          every call, and that you can revoke at any time. It can never do more than you can.
        </p>
      </div>
    </div>
  );
}
