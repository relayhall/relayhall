/**
 * OAuthAuthorizationService — the OAuth 2.1 authorization-code flow
 * (RH-P3.C6; strategy 4e40f06f Phase 3, ratified C3 amendment).
 *
 * ── THE ONE HONEST STORY (ruling TS-12, record 7e7eeca3) ──
 *
 * "C6 issues OPAQUE REFERENCE access tokens with per-call lookup. Very-next-
 * call revocation is therefore TRUE for this class — one honest story with the
 * existing `rh_` reference credentials."
 *
 * This service does not implement that story a second time. An access token
 * issued here IS an `rh_` credential row, minted by
 * `principalService.issueCredential`, and every property the surface claims
 * about it is a property of that machinery, not of this file:
 *
 *   revocation   `authenticatePrincipalKey` selects `WHERE ... revoked_at IS
 *                NULL` and `evaluateCredentialAcceptance` re-checks it, on
 *                EVERY call. Setting `revoked_at` refuses the very next call.
 *   expiry       the same predicate's `CREDENTIAL_EXPIRED` arm.
 *   audience     the credential is minted `transport: 'mcp'`, and
 *                `evaluateTransportPin` refuses it on every REST route
 *                (403 TRANSPORT_MISMATCH). A token for the MCP surface is
 *                useless anywhere else — audience restriction by construction
 *                rather than by an unverified claim in a JWT.
 *   scope        the token is minted onto a CONNECTOR parented to the
 *                consenting Account, so `delegationService.effectiveScopes`
 *                intersects it with the Account's own role authority on every
 *                single call (§5.2 rule 1). A token can never outlive, or out-
 *                rank, the human who authorized it — including if that human
 *                is demoted after the token was issued.
 *
 * ── WHY A CONNECTOR AND NOT AN ACCOUNT CREDENTIAL ──
 *
 * `issueCredential` refuses Accounts outright (`ACCOUNTS_ARE_KEYLESS`, design
 * 4d961e37 A17.1/§7.1): humans act through login sessions, and machine
 * authority lives at the Connector/Agent layers. An OAuth client is precisely
 * a machine acting for a human, which is what a Connector is. One Connector
 * per (client, Account) pair, minted on first consent and reused after, so
 * revoking "the client's access for this person" is one principal to disable.
 *
 * ── WHAT THIS SERVER DOES NOT DO ──
 *
 * No refresh-token grant, no implicit flow, no password grant, no client
 * secrets, and no RFC 8693 token exchange (KS-1, record d92e756c: DEFERRED;
 * vehicle 86508d90 stays Phase-4-parked — any grant-type growth is an owner
 * ruling, never a footnote here). `utils/oauthMetadata` publishes exactly that
 * list, so a client is told rather than left to discover it by failing.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';

import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { auditChainFor } from '../utils/auditChain';
import { principalService } from './PrincipalService';
import { sha256Hex } from '../utils/credentialCrypto';
import { MINTABLE_SCOPES, ROOT_SCOPE, type Scope } from '../utils/scopeMap';
import { scopesForRole } from '../utils/identityScopes';
import {
  oauthResourceIdentifier,
  OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED,
} from '../utils/oauthMetadata';
import {
  oauthClientMetadataService,
  ClientMetadataError,
  sanitizeDisplayUri,
  type ClientMetadataDocument,
} from './OAuthClientMetadataService';

/** How long a human has to decide, from /authorize to the consent click. */
export const OAUTH_CONSENT_WINDOW_MS = 10 * 60 * 1000;
/** How long an issued authorization code stays usable. OAuth 2.1: short. */
export const OAUTH_CODE_TTL_MS = 60 * 1000;
/** Default access-token lifetime. Overridable per deployment; see below. */
export const OAUTH_DEFAULT_ACCESS_TOKEN_TTL_HOURS = 12;
export const OAUTH_ACCESS_TOKEN_TTL_ENV = 'RELAYHALL_OAUTH_ACCESS_TOKEN_TTL_HOURS';
/** Bounds on the configured lifetime: never unbounded, never zero. */
export const OAUTH_ACCESS_TOKEN_TTL_MIN_HOURS = 1;
export const OAUTH_ACCESS_TOKEN_TTL_MAX_HOURS = 24 * 30;

/**
 * The access-token lifetime this deployment issues.
 *
 * Read at CALL time rather than module load so a test can pin it and a
 * restart is not required to observe a change. An unparseable or out-of-range
 * value falls back to the default rather than failing an authorization: the
 * value is an operational preference, and refusing to issue tokens because a
 * number was mistyped would be a worse failure than issuing the documented one.
 */
export function accessTokenTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  const declared = Number(env[OAUTH_ACCESS_TOKEN_TTL_ENV]);
  if (!Number.isFinite(declared)) return OAUTH_DEFAULT_ACCESS_TOKEN_TTL_HOURS;
  if (declared < OAUTH_ACCESS_TOKEN_TTL_MIN_HOURS || declared > OAUTH_ACCESS_TOKEN_TTL_MAX_HOURS) {
    return OAUTH_DEFAULT_ACCESS_TOKEN_TTL_HOURS;
  }
  return declared;
}

/**
 * The scopes this authorization server will ever mint.
 *
 * THE ENUMERATION IS `MINTABLE_SCOPES` ITSELF, minus `root`. It is not a list
 * assembled here and it is not a pattern: no OAuth file gets to decide what a
 * scope string is. A new scope string is a declared vocabulary amendment
 * (b94dd86e) landing in `utils/scopeMap`, and it becomes OAuth-grantable at
 * that moment without this function changing — which is the point.
 *
 * `root` is excluded because `issueCredential` refuses it on any bearer
 * credential (§5.2 rule 2 / AZ-18) and `effectiveScopes` strips it from every
 * delegated chain: advertising it would be advertising a refusal.
 */
export function oauthGrantableScopes(): Scope[] {
  return MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE);
}

/**
 * May a re-consent reuse the Connector this (client, Account) pair already has?
 *
 * A PURE PREDICATE, because the answer is a policy decision and a policy
 * decision buried in a SQL branch is one no test can reach without a database.
 *
 * `disabled` is the kill switch: `evaluateCredentialAcceptance` refuses a
 * non-active principal, so disabling a Connector kills every token issued to
 * that client for that person. An earlier draft of `connectorFor` wrote
 * `status = 'active'` on reuse, which would have let a re-consent silently undo
 * an administrator's disable — the person re-consenting is not necessarily the
 * person who disabled it, and even when they are, quietly re-enabling on a
 * side effect is not a decision anyone made. `terminated` is irreversible by
 * A17.10 and the source tag is UNIQUE, so that pairing can never come back.
 */
export type ConnectorReuse = 'reuse' | 'refuse-disabled' | 'refuse-terminated';

export function connectorReuseVerdict(status: unknown): ConnectorReuse {
  const value = String(status ?? '');
  if (value === 'terminated') return 'refuse-terminated';
  if (value !== 'active') return 'refuse-disabled';
  return 'reuse';
}

export type OAuthRefusal =
  | 'INVALID_REQUEST'
  | 'INVALID_CLIENT'
  | 'INVALID_REDIRECT_URI'
  | 'UNSUPPORTED_RESPONSE_TYPE'
  | 'INVALID_SCOPE'
  | 'INVALID_GRANT'
  | 'UNSUPPORTED_GRANT_TYPE'
  | 'ACCESS_DENIED'
  | 'REQUEST_NOT_FOUND'
  | 'REQUEST_EXPIRED'
  | 'SERVER_ERROR';

export class OAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly refusal: OAuthRefusal,
    /** The RFC 6749 §4.1.2.1 / §5.2 error code returned to the client. */
    public readonly oauthError: string,
    message: string,
    /** True when the refusal may be reported by redirecting to the client. */
    public readonly redirectable = false,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

const fail = (status: number, refusal: OAuthRefusal, oauthError: string, message: string, redirectable = false): never => {
  throw new OAuthError(status, refusal, oauthError, message, redirectable);
};

export interface AuthorizeRequestInput {
  clientId: unknown;
  redirectUri: unknown;
  responseType: unknown;
  codeChallenge: unknown;
  codeChallengeMethod: unknown;
  scope: unknown;
  state: unknown;
  resource: unknown;
  /** This deployment's own API endpoint, for the RFC 8707 resource check. */
  boardEndpoint: string;
}

export interface PendingAuthorization {
  id: string;
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  redirectUri: string;
  requestedScopes: string[];
  state: string | null;
  resource: string | null;
  expiresAt: string;
}

export interface ConsentView extends PendingAuthorization {
  /** The scopes the consenting Account could actually confer right now. */
  grantableScopes: string[];
  /** Requested scopes the Account cannot confer; shown, never silently kept. */
  unavailableScopes: string[];
}

export interface IssuedToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  scope: string;
  credentialId: string;
  connectorPrincipalId: string;
}

/**
 * The PKCE method gate: is `method` one this server accepts at /authorize?
 *
 * Named and exported (review dc8691db B1) so the published constant is
 * anchored to the gate that actually decides, rather than to a test's model of
 * what the method means. `beginAuthorization` asks this and nothing else.
 */
export function isSupportedCodeChallengeMethod(method: unknown): boolean {
  return typeof method === 'string'
    && (OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED as readonly string[]).includes(method);
}

/** `code_challenge` must be the base64url of a 32-byte SHA-256 digest. */
export const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** OAuth 2.1 §7.5.2: the verifier is 43–128 unreserved characters. */
export const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * PKCE S256: does `verifier` produce `challenge`?
 *
 * Named and exported so the token endpoint and the suite that proves the
 * endpoint exercise the SAME comparison. A test that recomputed the digest
 * itself would prove that SHA-256 works, not that this server checks it.
 *
 * Constant-time, because the challenge is a secret-derived value and a length-
 * or-prefix-sensitive comparison leaks it a character at a time.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const presented = Buffer.from(computed, 'utf8');
  const stored = Buffer.from(challenge, 'utf8');
  if (presented.length !== stored.length) return false;
  return crypto.timingSafeEqual(presented, stored);
}

function parseScopeParameter(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string' || value.length > 2048) {
    return fail(400, 'INVALID_SCOPE', 'invalid_scope', 'scope must be a space-delimited string');
  }
  return [...new Set(value.split(/\s+/).filter(Boolean))];
}

function parseStoredScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export class OAuthAuthorizationService {
  /**
   * Validate an /authorize request and park it for the human.
   *
   * Ordering is deliberate and is a security property: the client and its
   * redirect_uri are established FIRST, because RFC 6749 §4.1.2.1 only permits
   * reporting an error by redirect once the redirect target is known to belong
   * to the client. Everything validated before that point can only be reported
   * directly to the browser — which is why an unregistered redirect_uri is a
   * 400 page and never a redirect.
   */
  async beginAuthorization(input: AuthorizeRequestInput): Promise<PendingAuthorization> {
    let document: ClientMetadataDocument;
    try {
      document = await oauthClientMetadataService.resolve(input.clientId);
    } catch (error) {
      // ONLY this class's message reaches the caller. Its text is
      // developer-authored by construction and names which bound of the
      // outbound policy the URL crossed, which is the whole diagnostic value
      // of the refusal; an unexpected error is a server fault and gets the
      // generic envelope with a correlating id instead of its own words.
      if (error instanceof ClientMetadataError) {
        return fail(400, 'INVALID_CLIENT', 'invalid_client', error.message);
      }
      throw error;
    }

    // EXACT STRING MATCH. OAuth 2.1 removed prefix and substring matching
    // because both are open-redirector generators; the comparison is against
    // the FRESHLY fetched document, never a cached list.
    const redirectUri = typeof input.redirectUri === 'string' ? input.redirectUri : '';
    if (!redirectUri || !document.redirectUris.includes(redirectUri)) {
      return fail(400, 'INVALID_REDIRECT_URI', 'invalid_request',
        'redirect_uri must exactly match one the client metadata document declares');
    }

    // Past this line the redirect target is trusted, so refusals are
    // redirectable — the client learns why instead of the browser dead-ending.
    if (input.responseType !== 'code') {
      return fail(400, 'UNSUPPORTED_RESPONSE_TYPE', 'unsupported_response_type',
        'this authorization server issues authorization codes only', true);
    }
    if (!isSupportedCodeChallengeMethod(input.codeChallengeMethod)) {
      return fail(400, 'INVALID_REQUEST', 'invalid_request',
        `code_challenge_method must be ${OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED.join(' or ')} (PKCE is required)`, true);
    }
    if (typeof input.codeChallenge !== 'string' || !CODE_CHALLENGE_PATTERN.test(input.codeChallenge)) {
      return fail(400, 'INVALID_REQUEST', 'invalid_request',
        'code_challenge must be the base64url SHA-256 of the code_verifier', true);
    }
    if (input.state !== undefined && input.state !== null
        && (typeof input.state !== 'string' || input.state.length > 512)) {
      return fail(400, 'INVALID_REQUEST', 'invalid_request', 'state must be a short opaque string', true);
    }

    const requested = parseScopeParameter(input.scope);
    const grantable = new Set<string>(oauthGrantableScopes());
    const unknown = requested.filter((scope) => !grantable.has(scope));
    if (unknown.length > 0) {
      return fail(400, 'INVALID_SCOPE', 'invalid_scope',
        `this authorization server does not issue: ${unknown.join(', ')}`, true);
    }
    if (requested.length === 0) {
      return fail(400, 'INVALID_SCOPE', 'invalid_scope',
        'scope is required: an access token with no authority is never issued', true);
    }

    // RFC 8707 resource indicator. This server issues tokens for exactly one
    // resource — its own MCP endpoint — so a request naming another is
    // refused rather than quietly served a token that would not work there.
    // Checked BEFORE the row is written: a refusal must leave nothing parked.
    const resource = input.resource === undefined || input.resource === null || input.resource === ''
      ? null
      : String(input.resource);
    this.assertResourceServed(resource, input.boardEndpoint);

    const expiresAt = new Date(Date.now() + OAUTH_CONSENT_WINDOW_MS);
    const created = await pool.query(
      `INSERT INTO oauth_authorization_requests
         (client_id, redirect_uri, code_challenge, code_challenge_method,
          requested_scopes, resource, state, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING id, expires_at`,
      [
        document.clientId, redirectUri, input.codeChallenge,
        OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED[0],
        JSON.stringify(requested), resource,
        typeof input.state === 'string' ? input.state : null,
        expiresAt,
      ],
    );
    return {
      id: String(created.rows[0].id),
      clientId: document.clientId,
      clientName: document.clientName,
      clientUri: document.clientUri,
      redirectUri,
      requestedScopes: requested,
      state: typeof input.state === 'string' ? input.state : null,
      resource,
      expiresAt: new Date(created.rows[0].expires_at).toISOString(),
    };
  }

  /** Validate the resource indicator against what this server actually serves. */
  assertResourceServed(resource: string | null, boardEndpoint: string): void {
    if (resource === null) return;
    const served = oauthResourceIdentifier(boardEndpoint);
    const normalize = (value: string): string => value.replace(/\/+$/, '');
    if (normalize(resource) !== normalize(served)) {
      fail(400, 'INVALID_REQUEST', 'invalid_target',
        `this authorization server issues tokens for ${served} only`, true);
    }
  }

  /** The consent view for a pending request, for the human who will decide. */
  async consentView(requestId: string, accountRole: string | null | undefined): Promise<ConsentView> {
    const result = await pool.query(
      `SELECT r.*, c.client_name, c.document ->> 'client_uri' AS client_uri
         FROM oauth_authorization_requests r
         JOIN oauth_clients c ON c.client_id = r.client_id
        WHERE r.id = $1`,
      [requestId],
    );
    const row = result.rows[0];
    if (!row) return fail(404, 'REQUEST_NOT_FOUND', 'invalid_request', 'no such authorization request');
    if (row.state_name !== 'pending') {
      return fail(409, 'INVALID_REQUEST', 'invalid_request', 'this authorization request has already been decided');
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return fail(410, 'REQUEST_EXPIRED', 'invalid_request', 'this authorization request has expired');
    }
    const requested = parseStoredScopes(row.requested_scopes);
    // The ceiling the consenting Account can actually confer. A root Account's
    // sentinel means "everything this server issues" (the same reading
    // `effectiveScopes` takes — the sentinel is a superset, not a literal
    // one-element set), so it is expanded rather than intersected to nothing.
    const accountScopes = scopesForRole(accountRole);
    const ceiling = accountScopes.includes(ROOT_SCOPE)
      ? new Set<string>(oauthGrantableScopes())
      : new Set<string>(accountScopes);
    return {
      id: String(row.id),
      clientId: String(row.client_id),
      clientName: row.client_name ? String(row.client_name) : null,
      // Sanitized on the way OUT as well as on the way in (review 6fe97bc5
      // B3): the cached document is data, and a row written by any other path
      // must not be able to put an unusable URL in front of a person.
      clientUri: sanitizeDisplayUri(row.client_uri),
      redirectUri: String(row.redirect_uri),
      requestedScopes: requested,
      state: row.state === null ? null : String(row.state),
      resource: row.resource === null ? null : String(row.resource),
      expiresAt: new Date(row.expires_at).toISOString(),
      grantableScopes: requested.filter((scope) => ceiling.has(scope)),
      unavailableScopes: requested.filter((scope) => !ceiling.has(scope)),
    };
  }

  /**
   * Record the human's decision.
   *
   * On approval this mints the authorization code and returns it exactly once.
   * The board stores only its sha256 digest, exactly as it stores credential
   * digests, so the board cannot replay a code it issued.
   */
  async decide(input: {
    requestId: string;
    accountPrincipalId: string;
    accountRole: string | null | undefined;
    approve: boolean;
    grantedScopes: string[];
  }, actor: AuditActor): Promise<{ approved: boolean; redirectTo: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT * FROM oauth_authorization_requests WHERE id = $1 FOR UPDATE`,
        [input.requestId],
      );
      const row = result.rows[0];
      if (!row) return fail(404, 'REQUEST_NOT_FOUND', 'invalid_request', 'no such authorization request');
      if (row.state_name !== 'pending') {
        return fail(409, 'INVALID_REQUEST', 'invalid_request', 'this authorization request has already been decided');
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        return fail(410, 'REQUEST_EXPIRED', 'invalid_request', 'this authorization request has expired');
      }

      const redirect = new URL(String(row.redirect_uri));
      if (row.state !== null) redirect.searchParams.set('state', String(row.state));

      if (!input.approve) {
        await client.query(
          `UPDATE oauth_authorization_requests
              SET state_name = 'denied', decided_at = now(), account_principal_id = $2
            WHERE id = $1`,
          [input.requestId, input.accountPrincipalId],
        );
        await auditService.record({
          action: 'oauth.authorization_denied', actor, outcome: 'denied',
          resourceType: 'principal', resourceId: input.accountPrincipalId,
          metadata: { clientId: String(row.client_id), requestId: input.requestId },
        }, client);
        await client.query('COMMIT');
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('error_description', 'the person declined this authorization');
        return { approved: false, redirectTo: redirect.toString() };
      }

      // The granted set is bounded twice: by what was REQUESTED (a consent
      // page cannot grant more than the client asked for) and by what the
      // consenting Account can confer. The second bound is re-evaluated on
      // every call anyway by `effectiveScopes`; applying it here means the
      // token is not minted carrying authority that would silently evaporate.
      const requested = new Set(parseStoredScopes(row.requested_scopes));
      const accountScopes = scopesForRole(input.accountRole);
      const ceiling = accountScopes.includes(ROOT_SCOPE)
        ? new Set<string>(oauthGrantableScopes())
        : new Set<string>(accountScopes);
      const granted = [...new Set(input.grantedScopes)]
        .filter((scope) => requested.has(scope) && ceiling.has(scope));
      if (granted.length === 0) {
        return fail(400, 'INVALID_SCOPE', 'invalid_scope',
          'approving with no grantable scope would issue an access token with no authority');
      }

      const code = crypto.randomBytes(32).toString('base64url');
      await client.query(
        `UPDATE oauth_authorization_requests
            SET state_name = 'approved', decided_at = now(),
                account_principal_id = $2, granted_scopes = $3::jsonb,
                code_hash = $4, expires_at = $5
          WHERE id = $1`,
        [
          input.requestId, input.accountPrincipalId, JSON.stringify(granted),
          sha256Hex(code), new Date(Date.now() + OAUTH_CODE_TTL_MS),
        ],
      );
      await auditService.record({
        action: 'oauth.authorization_approved', actor,
        resourceType: 'principal', resourceId: input.accountPrincipalId,
        metadata: {
          clientId: String(row.client_id), requestId: input.requestId,
          requestedScopes: [...requested], grantedScopes: granted,
          chain: await auditChainFor(client, input.accountPrincipalId),
        },
      }, client);
      await client.query('COMMIT');
      redirect.searchParams.set('code', code);
      return { approved: true, redirectTo: redirect.toString() };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Exchange an authorization code for an access token.
   *
   * The code row is claimed with a single conditional UPDATE, so a replayed
   * code loses the race rather than being detected afterwards: `WHERE
   * state_name = 'approved'` flips to `'consumed'` exactly once. Everything
   * else — client_id, redirect_uri, PKCE — is re-verified against the row the
   * claim returned, so no check reads a value the second caller could have
   * changed.
   *
   * CONSUMPTION HAPPENS ON THE ATTEMPT, NOT ON SUCCESS, and that is
   * deliberate: a refused exchange COMMITS the consumption rather than rolling
   * it back, so a wrong `code_verifier` cannot be tried twice. Verifier
   * guessing is therefore impossible online rather than merely impractical,
   * and a legitimate client — which presents the right verifier the first
   * time — never observes the difference. `docs/oauth.md` states it plainly
   * so no client author is surprised by it.
   */
  async exchangeCode(input: {
    grantType: unknown;
    code: unknown;
    clientId: unknown;
    redirectUri: unknown;
    codeVerifier: unknown;
  }, actor: AuditActor): Promise<IssuedToken> {
    if (input.grantType !== 'authorization_code') {
      return fail(400, 'UNSUPPORTED_GRANT_TYPE', 'unsupported_grant_type',
        'this authorization server implements the authorization_code grant only');
    }
    if (typeof input.code !== 'string' || input.code.length === 0 || input.code.length > 512) {
      return fail(400, 'INVALID_GRANT', 'invalid_grant', 'code is required');
    }
    if (typeof input.codeVerifier !== 'string' || !CODE_VERIFIER_PATTERN.test(input.codeVerifier)) {
      return fail(400, 'INVALID_GRANT', 'invalid_grant', 'code_verifier is required (PKCE)');
    }

    const client = await pool.connect();
    // Several refusals below must COMMIT (they burn the code) and then throw.
    // Tracking whether the transaction is still open keeps the catch arm from
    // issuing a ROLLBACK against a transaction that already ended.
    let open = false;
    try {
      await client.query('BEGIN');
      open = true;
      // ONE-TIME USE, atomically. A replay finds no row in state 'approved'.
      const claimed = await client.query(
        `UPDATE oauth_authorization_requests
            SET state_name = 'consumed', consumed_at = now()
          WHERE code_hash = $1 AND state_name = 'approved'
        RETURNING *`,
        [sha256Hex(input.code)],
      );
      const row = claimed.rows[0];
      if (!row) {
        await client.query('ROLLBACK'); open = false;
        // A replayed, unknown, denied or already-consumed code are one answer:
        // telling them apart would confirm which codes existed.
        return fail(400, 'INVALID_GRANT', 'invalid_grant', 'the authorization code is not valid');
      }
      // Expiry is checked AFTER the claim so an expired code is also burned.
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query('COMMIT'); open = false;
        return fail(400, 'INVALID_GRANT', 'invalid_grant', 'the authorization code has expired');
      }
      // §4.1.3: the code is bound to the client and the redirect_uri it was
      // issued for. Both are compared to the ROW, not to anything the caller
      // supplied twice.
      if (input.clientId !== String(row.client_id)) {
        await client.query('COMMIT'); open = false;
        return fail(400, 'INVALID_GRANT', 'invalid_grant', 'the authorization code was issued to another client');
      }
      if (input.redirectUri !== String(row.redirect_uri)) {
        await client.query('COMMIT'); open = false;
        return fail(400, 'INVALID_GRANT', 'invalid_grant', 'redirect_uri does not match the authorization request');
      }
      // PKCE S256: base64url(sha256(verifier)) === the stored challenge,
      // compared in constant time by the one exported predicate.
      if (!verifyPkceS256(input.codeVerifier, String(row.code_challenge))) {
        await client.query('COMMIT'); open = false;
        return fail(400, 'INVALID_GRANT', 'invalid_grant', 'code_verifier does not match the code_challenge');
      }

      const granted = parseStoredScopes(row.granted_scopes);
      const accountPrincipalId = String(row.account_principal_id);
      const connectorId = await this.connectorFor(
        client, accountPrincipalId, String(row.client_id), granted,
      );
      const ttlHours = accessTokenTtlHours();
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
      const issued = await principalService.issueCredential({
        principalId: connectorId,
        scopes: granted,
        label: `oauth:${String(row.client_id)}`,
        expiresAt,
        // The audience restriction: this token is refused on every REST route
        // by `evaluateTransportPin`. It works on the MCP surface and nowhere
        // else, which is what the protected-resource metadata claims.
        transport: 'mcp',
        createdByPrincipalId: accountPrincipalId,
        metadata: {
          issued_by: 'oauth',
          oauth_client_id: String(row.client_id),
          oauth_request_id: String(row.id),
          access_token_ttl_hours: ttlHours,
        },
      }, actor, client);
      await client.query(
        `UPDATE oauth_authorization_requests
            SET connector_principal_id = $2, credential_id = $3
          WHERE id = $1`,
        [String(row.id), connectorId, issued.credentialId],
      );
      await auditService.record({
        action: 'oauth.token_issued', actor,
        resourceType: 'credential', resourceId: issued.credentialId,
        metadata: {
          clientId: String(row.client_id),
          accountPrincipalId,
          connectorPrincipalId: connectorId,
          scopes: granted,
          expiresAt: expiresAt.toISOString(),
          chain: await auditChainFor(client, connectorId),
        },
      }, client);
      await client.query('COMMIT'); open = false;
      return {
        accessToken: issued.fullKey,
        tokenType: 'Bearer',
        expiresInSeconds: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
        scope: granted.join(' '),
        credentialId: issued.credentialId,
        connectorPrincipalId: connectorId,
      };
    } catch (error) {
      if (open) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The Connector for (client, Account), created on first consent and reused.
   *
   * `own_expression` is written every time: inheritance is never implicit
   * (AZ-24 — no expression, no authority), and a re-consent that widened the
   * granted set must widen the expression with it or `effectiveScopes` would
   * intersect the new token down to the old consent. The row's STATUS is never
   * written — see `connectorReuseVerdict` for why.
   */
  private async connectorFor(
    client: PoolClient, accountPrincipalId: string, clientId: string, granted: string[],
  ): Promise<string> {
    // The source tag is the (Account, client) pair, and 062's
    // ux_principals_source_tag is UNIQUE — so the pairing is enforced by the
    // index rather than by this function having remembered to look first.
    const sourceTag = `oauth:${accountPrincipalId}:${sha256Hex(clientId).slice(0, 32)}`;
    const existing = await client.query(
      `SELECT id, status FROM principals WHERE source_tag = $1`,
      [sourceTag],
    );
    if (existing.rows[0]) {
      const verdict = connectorReuseVerdict(existing.rows[0].status);
      if (verdict === 'refuse-terminated') {
        // A17.10: termination is irreversible and the source tag is UNIQUE, so
        // this pairing can never be re-created. Say so, rather than failing on
        // the index with a 500 that reads like an outage.
        return fail(409, 'ACCESS_DENIED', 'access_denied',
          'this application was permanently terminated for this account and cannot be re-authorized');
      }
      if (verdict === 'refuse-disabled') {
        return fail(409, 'ACCESS_DENIED', 'access_denied',
          'this application is disabled for this account; re-enable it before authorizing again');
      }
      const id = String(existing.rows[0].id);
      // The expression is rewritten — inheritance is never implicit (AZ-24), so
      // a re-consent that widened the granted set must widen it here or
      // `effectiveScopes` would intersect the new token down to the old
      // consent. The STATUS is deliberately not touched: see
      // `connectorReuseVerdict`.
      await client.query(
        `UPDATE principals
            SET own_expression = $2::jsonb, updated_at = now()
          WHERE id = $1`,
        [id, JSON.stringify({ scopes: granted, objects: [] })],
      );
      return id;
    }
    const handle = `oauth-${crypto.randomBytes(6).toString('hex')}`;
    const created = await client.query(
      `INSERT INTO principals
         (kind, handle, display_name, role, status, parent_principal_id, own_expression, source_tag, purpose)
       VALUES ('service', $1, $2, NULL, 'active', $3, $4::jsonb, $5, $6)
       RETURNING id`,
      [
        handle,
        `OAuth client ${clientId}`,
        accountPrincipalId,
        JSON.stringify({ scopes: granted, objects: [] }),
        sourceTag,
        `OAuth 2.1 client authorized by this Account (${clientId})`,
      ],
    );
    return String(created.rows[0].id);
  }

  /**
   * RFC 7009 revocation.
   *
   * Revoking sets `revoked_at` on the credential row. Because acceptance reads
   * that row on EVERY call (ruling TS-12's per-call lookup), the very next MCP
   * call with this token is refused — no cache to wait out, no epoch to
   * propagate. RFC 7009 §2.2: an unknown or already-revoked token is a 200,
   * so revocation is idempotent and does not disclose which tokens exist.
   */
  async revoke(token: unknown, actor: AuditActor): Promise<{ revoked: boolean }> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
      return { revoked: false };
    }
    const result = await pool.query(
      `UPDATE principal_credentials
          SET revoked_at = now(),
              metadata = jsonb_set(metadata, '{revoke_reason}', to_jsonb('oauth revocation endpoint (RFC 7009)'::text))
        WHERE secret_hash = $1 AND revoked_at IS NULL
          AND metadata ->> 'issued_by' = 'oauth'
      RETURNING id, principal_id`,
      [sha256Hex(token)],
    );
    const row = result.rows[0];
    if (!row) return { revoked: false };
    await auditService.record({
      action: 'oauth.token_revoked', actor,
      resourceType: 'credential', resourceId: String(row.id),
      metadata: { principalId: String(row.principal_id), via: 'rfc7009' },
    }).catch(() => undefined);
    return { revoked: true };
  }

  /**
   * Sweep decided/expired rows so the table does not grow without bound.
   *
   * Rows only ever hold protocol state — a code digest, a challenge, a scope
   * list — never a token, so deleting them destroys no evidence: the audit
   * ledger holds the approval and the issuance, and the credential row holds
   * the grant.
   */
  async sweepExpired(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
    const result = await pool.query(
      `DELETE FROM oauth_authorization_requests
        WHERE expires_at < now() - make_interval(secs => $1)
      RETURNING id`,
      [Math.floor(olderThanMs / 1000)],
    );
    return result.rows.length;
  }
}

export const oauthAuthorizationService = new OAuthAuthorizationService();
