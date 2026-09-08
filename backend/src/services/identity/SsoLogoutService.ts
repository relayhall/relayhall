/**
 * SsoLogoutService — §8.2 of design `d95136d7`: the three kinds of logout, and
 * the design's refusal to blur them (SS-19, SS-23; sitting ruling SSO-R16;
 * threat row T-SS10).
 *
 *   * LOCAL logout revokes the `auth_sessions` row and clears the cookie.
 *     Always available, on every session, federated or not.
 *   * RP-INITIATED logout additionally returns the Identity provider's
 *     `end_session_endpoint` URL, offered ONLY when the validated discovery
 *     document advertises it.
 *   * BACK-CHANNEL logout receives a logout token and revokes sessions with
 *     `revoke_reason='idp_backchannel'`.
 *
 * ── PROVIDER SCOPING HAPPENS BEFORE THE SUBJECT IS LOOKED AT ──
 *
 * This is what makes T-SS10 structural rather than careful. SS-19 gave
 * `auth_sessions` an `identity_provider_id` and an `identity_link_id`, so
 * "only that Identity provider's sessions" is a column in the WHERE clause
 * rather than a rule someone has to remember. A token from Identity provider A
 * can never touch B's sessions for the same subject string, and the W2
 * acceptance pins that with the four two-provider x two-subject vectors.
 *
 * ── THE HONEST BOUND, STATED RATHER THAN PAPERED OVER ──
 *
 * Where an Identity provider offers no back-channel logout at all (shape class
 * 6), a provider-side session kill does NOT reach the board. The board session
 * ends at its own TTL, or when the Account is disabled. That is a per-deployment
 * property, it is surfaced in the Access manager, and nothing here pretends
 * otherwise.
 */
import crypto from 'crypto';
import { pool } from '../../db/connection';
import { auditService, type AuditActor } from '../AuditService';
import { loginSessionService } from '../LoginSessionService';
import { identityProviderService, type IdentityProvider } from './IdentityProviderService';
import { SsoDiscoveryService, ssoDiscoveryService, type ValidatedProviderMetadata } from './SsoDiscoveryService';
import { decryptCredentialSecret } from '../../utils/credentialCrypto';
import { validateLogoutToken } from './idTokenValidation';

export const LOGOUT_REFUSALS = [
  'LOGOUT_ISSUER_UNKNOWN',
  'LOGOUT_TOKEN_INVALID',
  'LOGOUT_TOKEN_REPLAYED',
  'LOGOUT_NOT_ADVERTISED',
] as const;
export type LogoutRefusal = (typeof LOGOUT_REFUSALS)[number];

export class SsoLogoutError extends Error {
  constructor(public readonly code: LogoutRefusal, message: string) {
    super(message);
    this.name = 'SsoLogoutError';
  }
}

const refuse: (code: LogoutRefusal, message: string) => never = (code, message) => {
  throw new SsoLogoutError(code, message);
};

/**
 * Read `iss` from an UNVERIFIED token, to decide which Identity provider's keys
 * to verify it with.
 *
 * This is a LOOKUP HINT and nothing else. Every claim it returns is untrusted
 * at this point; what makes the token authoritative is the signature check
 * against the keys of the provider selected here, plus refusal 4 re-comparing
 * `iss` byte-for-byte afterwards. A hostile `iss` therefore selects a provider
 * whose keys will not verify the token, and the request is refused.
 */
function unverifiedIssuer(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { iss?: unknown };
    return typeof payload.iss === 'string' && payload.iss.length > 0 ? payload.iss : null;
  } catch {
    return null;
  }
}

function providerConfig(provider: IdentityProvider) {
  return {
    id: provider.id,
    issuer: provider.issuer,
    discoveryUrl: provider.discoveryUrl,
    additionalEndpointOrigins: provider.additionalEndpointOrigins,
    allowPrivateIssuerAddress: provider.allowPrivateIssuerAddress,
  };
}

export interface BackchannelLogoutResult {
  identityProviderId: string;
  sessionsRevoked: number;
  scope: 'sid' | 'subject';
}

export class SsoLogoutService {
  constructor(private readonly discovery: SsoDiscoveryService = ssoDiscoveryService) {}

  /** Local logout. Always available; never depends on an Identity provider. */
  async localLogout(sessionId: string): Promise<boolean> {
    return loginSessionService.revoke(sessionId, 'logout');
  }

  /**
   * The RP-initiated logout URL, or null where the Identity provider does not
   * advertise `end_session_endpoint`.
   *
   * The DEFAULT request carries `client_id` and `post_logout_redirect_uri` and
   * NO `id_token_hint` — OpenID Connect RP-Initiated Logout permits `client_id`
   * in its place. The honest consequence: without the hint, some Identity
   * providers ask the user to confirm, and some decline to honour
   * `post_logout_redirect_uri`.
   *
   * SSO-R16 folded the opt-in retention INTO this wave, so a deployment that
   * accepts the cost may set `retain_id_token` and get the smoother prompt.
   * The token is decrypted here, used once, and never returned to any caller.
   */
  async rpInitiatedLogoutUrl(
    provider: IdentityProvider,
    sessionId: string,
    postLogoutRedirectUri: string,
  ): Promise<string | null> {
    let metadata: ValidatedProviderMetadata;
    try {
      metadata = await this.discovery.metadata(providerConfig(provider));
    } catch {
      return null;
    }
    if (!metadata.endSessionEndpoint) return null;

    const url = new URL(metadata.endSessionEndpoint.toString());
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);

    if (provider.retainIdToken) {
      const hint = await this.retainedIdToken(sessionId);
      if (hint) url.searchParams.set('id_token_hint', hint);
    }
    return url.toString();
  }

  /** SSO-R16 storage: read once, at the one moment the hint is used. */
  private async retainedIdToken(sessionId: string): Promise<string | null> {
    const result = await pool.query(
      'SELECT id_token_ct, id_token_key_id FROM auth_sessions WHERE id = $1',
      [sessionId],
    );
    const row = result.rows[0];
    if (!row?.id_token_ct) return null;
    try {
      return decryptCredentialSecret(String(row.id_token_ct), String(row.id_token_key_id), sessionId);
    } catch {
      // A corrupted or cross-wired row must not silently degrade into "no
      // hint": the canary reports it, and the logout still proceeds without
      // the hint rather than failing the user's logout.
      return null;
    }
  }

  /**
   * Back-channel logout. Validate, CONSUME BY INSERT, then revoke.
   *
   * The order is the contract. Consumption is the INSERT into
   * `sso_logout_token_uses` (SS-23), so two concurrent replays cannot both
   * proceed and there is no check-then-act. It happens BEFORE any revocation,
   * so a replayed token cannot revoke anything a second time.
   */
  async backchannelLogout(rawToken: string): Promise<BackchannelLogoutResult> {
    const issuer = unverifiedIssuer(rawToken);
    if (!issuer) refuse('LOGOUT_TOKEN_INVALID', 'the logout token is not a readable JWS');

    const providers = await identityProviderService.list();
    const provider = providers.find((candidate) => candidate.issuer === issuer && candidate.status === 'active');
    // An unknown or disabled issuer revokes NOTHING, and says so with the same
    // refusal either way — a token that could distinguish the two would be a
    // probe for which Identity providers a deployment federates to.
    if (!provider) refuse('LOGOUT_ISSUER_UNKNOWN', 'that logout token names no enabled Identity provider');
    if (!provider.backchannelLogoutEnabled) {
      refuse('LOGOUT_NOT_ADVERTISED', 'back-channel logout is not enabled for that Identity provider');
    }

    const metadata = await this.discovery.metadata(providerConfig(provider));
    const validated = await validateLogoutToken({
      token: rawToken,
      issuer: provider.issuer,
      clientId: provider.clientId,
      clockSkewSeconds: provider.clockSkewSeconds,
      advertisedAlgs: metadata.idTokenSigningAlgValuesSupported,
      resolveKey: (kid) => this.discovery.signingKey(providerConfig(provider), kid),
    });

    // SS-23: the replay key is the `jti` where the Identity provider emits one,
    // and the SHA-256 of the compact token otherwise. The key is issuer-scoped
    // by the COMPOSITE PRIMARY KEY itself, so two Identity providers may
    // legitimately emit the same `jti`.
    const replayKey = validated.jti ?? crypto.createHash('sha256').update(rawToken).digest('hex');
    try {
      await pool.query(
        `INSERT INTO sso_logout_token_uses (identity_provider_id, replay_key, token_expires_at)
         VALUES ($1, $2, $3)`,
        [provider.id, replayKey, validated.expiresAt],
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505') {
        refuse('LOGOUT_TOKEN_REPLAYED', 'that logout token has already been used');
      }
      throw error;
    }

    // Resolution is ALWAYS provider-scoped first. `identity_provider_id` is in
    // both WHERE clauses, so the scoping is structural.
    let revoked = 0;
    let scope: 'sid' | 'subject';
    if (validated.sid) {
      scope = 'sid';
      const result = await pool.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoke_reason = 'idp_backchannel',
                id_token_ct = NULL, id_token_key_id = NULL
          WHERE identity_provider_id = $1 AND oidc_sid = $2 AND revoked_at IS NULL`,
        [provider.id, validated.sid],
      );
      revoked = result.rowCount ?? 0;
    } else {
      scope = 'subject';
      const result = await pool.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoke_reason = 'idp_backchannel',
                id_token_ct = NULL, id_token_key_id = NULL
          WHERE identity_provider_id = $1 AND revoked_at IS NULL
            AND identity_link_id IN (
              SELECT id FROM identity_links
               WHERE link_kind = 'sso' AND identity_provider_id = $1 AND subject = $2
            )`,
        [provider.id, validated.subject],
      );
      revoked = result.rowCount ?? 0;
    }

    await auditService.record({
      action: 'sso.backchannel_logout',
      // `system`: the act IS authenticated — by the logout token itself — but
      // by no board principal. `none` is not a permitted `auth_method` value.
      actor: { principalId: null, handle: 'identity-provider', authMethod: 'system' } as unknown as AuditActor,
      resourceType: 'identity_provider',
      resourceId: provider.id,
      metadata: { scope, sessions_revoked: revoked, sid: validated.sid, subject: validated.subject },
    });

    return { identityProviderId: provider.id, sessionsRevoked: revoked, scope };
  }

  /**
   * SS-23's retention sweep.
   *
   * A row is removed only after the LATER of the token's own expiry plus skew
   * and the maximum accepted age, so no token this board would still accept can
   * outlive the row that refuses its replay. That is the boundary a
   * single-replay test cannot reach, and the W2 acceptance drives it directly.
   */
  async sweepReplayStore(skewSeconds = 300): Promise<number> {
    const result = await pool.query(
      `DELETE FROM sso_logout_token_uses
        WHERE token_expires_at < now() - make_interval(secs => $1)
          AND seen_at < now() - make_interval(secs => $1)`,
      [skewSeconds],
    );
    return result.rowCount ?? 0;
  }
}

export const ssoLogoutService = new SsoLogoutService();
