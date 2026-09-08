/**
 * SsoAuthenticationService — the authentication flow (design `d95136d7` §5.1,
 * §5.2, §6.3, §6.4, §6.6; SS-4, SS-11, SS-17, SS-20, SS-24; sitting ruling
 * SSO-R5; threat rows T-SS3, T-SS4, T-SS5, T-SS6, T-SS15).
 *
 * ── THE SHARED RELYING-PARTY ENTRY POINT ──
 *
 * `startAuthentication` and `completeAuthentication` are THE production path.
 * The §4.5(a) conformance suite drives its fixtures through these two functions
 * and stamps the path it traversed, which is what makes "five named targets and
 * eight shape classes traverse ONE production path as configuration" a measured
 * property rather than a claim about fixtures. A fixture that reached a helper
 * directly would fail the path-stamp leg.
 *
 * ── CALLBACK ORDERING IS PART OF THE CONTRACT (§5.2) ──
 *
 *   1. `state` present, cookie present, both resolving to the SAME pending row;
 *      the row is consumed ON THE ATTEMPT, not on success.
 *   2. the row is unexpired, unconsumed, bound to an ACTIVE Identity provider.
 *   3. `iss` (RFC 9207) must equal the row's provider issuer; a MISSING `iss`
 *      is a refusal where the document advertises support.
 *   4. an `error` parameter is a refusal with a fixed message; provider error
 *      text is audited, never rendered.
 *   5. token exchange with `code_verifier`, over the DISCOVERY-SUPPLIED token
 *      endpoint of the row's Identity provider — whatever the response claims.
 *
 * Step 5 is where T-SS4 is actually closed: the pending row NAMES the Identity
 * provider, so the token endpoint dialled is that provider's regardless of any
 * `iss` in the response. The acceptance asserts the dialled endpoint on the
 * wire, not merely that a mix-up was refused.
 */
import crypto from 'crypto';
import { pool } from '../../db/connection';
import { auditService, type AuditActor } from '../AuditService';
import { loginSessionService } from '../LoginSessionService';
import { principalService } from '../PrincipalService';
import { decryptCredentialSecret } from '../../utils/credentialCrypto';
import {
  IdentityProvider,
  identityProviderService,
} from './IdentityProviderService';
import { identityLinkService, type IdentityLink } from './IdentityLinkService';
import { ssoInvitationService } from './SsoInvitationService';
import {
  SsoDiscoveryService,
  ValidatedProviderMetadata,
  ssoDiscoveryService,
} from './SsoDiscoveryService';
import { SsoTransport, httpsSsoTransport } from './ssoOutbound';
import { assertUserInfoSubject, validateIdToken } from './idTokenValidation';
import { readGroupClaim, type GroupClaimReading } from './ssoGroupClaims';
import { resolveGroupBindings } from './ssoGroupBinding';
import { evaluateLoginWhitelist } from './ssoLoginWhitelist';
import { directoryCarriageService } from '../DirectoryCarriageService';
import {
  hashOpaqueValue,
  mintOpaqueValue,
  mintPkceVerifier,
  pkceChallengeFor,
  ssoAuthenticationRequestService,
} from './SsoAuthenticationRequestService';
import { ssoRedirectUri } from './ssoRedirectUri';
// The two answers every Account producer must give identically — the
// fixed minimal role (AZ-RT1) and the handle folding. Two producers
// normalising differently decides whether two people COLLIDE, and the
// collision is what forces an operator decision instead of a silent suffix.
import { FIXED_MINIMAL_ACCOUNT_ROLE, normalizeAccountHandle } from './accountProvisioning';

export const SSO_STATE_COOKIE_NAME = 'rh_sso_state';

export const SSO_REFUSALS = [
  'SSO_NOT_CONFIGURED',
  'SSO_PROVIDER_INACTIVE',
  'SSO_STATE_MISSING',
  'SSO_STATE_UNKNOWN',
  'SSO_COOKIE_MISMATCH',
  'SSO_ISSUER_MISMATCH',
  'SSO_PROVIDER_ERROR',
  'SSO_TOKEN_EXCHANGE_FAILED',
  'SSO_RETURN_REF_INVALID',
  'SSO_INVITATION_REQUIRED',
  'SSO_INVITATION_INVALID',
  'SSO_SUBJECT_ALREADY_LINKED',
  'SSO_HANDLE_COLLISION',
  'SSO_ACCOUNT_UNAVAILABLE',
  'SSO_CLAIM_MATCH_REFUSED',
  /** SSO-R4: no membership admits login at this Identity provider. */
  'SSO_LOGIN_GROUP_REFUSED',
] as const;
export type SsoRefusal = (typeof SSO_REFUSALS)[number];

export class SsoAuthenticationError extends Error {
  constructor(public readonly code: SsoRefusal, message: string) {
    super(message);
    this.name = 'SsoAuthenticationError';
  }
}

const refuse: (code: SsoRefusal, message: string) => never = (code, message) => {
  throw new SsoAuthenticationError(code, message);
};

/**
 * SS-17: the return reference is an OPAQUE SERVER-SIDE REFERENCE — the id of a
 * row the board already owns, never a URL, never a path, never anything a
 * caller can compose.
 *
 * C6 refused a cached redirect allowlist on exactly this reasoning ("a stale
 * allowlist is an open redirector"), and a caller-supplied return URL here
 * would be worse than there, because the redirect happens immediately after a
 * session cookie is set.
 */
const RETURN_REF_KINDS = ['invitation', 'oauth', 'loopback'] as const;
export type ReturnRefKind = (typeof RETURN_REF_KINDS)[number];

export function composeReturnRef(kind: ReturnRefKind, rowId: string): string {
  return `${kind}:${rowId}`;
}

export function parseReturnRef(ref: string | null): { kind: ReturnRefKind; rowId: string } | null {
  if (!ref) return null;
  const [kind, rowId] = ref.split(':', 2);
  if (!RETURN_REF_KINDS.includes(kind as ReturnRefKind)) return null;
  if (!rowId) return null;
  // `loopback` carries a validated port rather than a row id — the CLI names
  // which port on its OWN machine is listening, and the board composes the
  // destination. Everything else names a row the board already owns.
  if (kind === 'loopback') {
    return LOOPBACK_PORT_PATTERN.test(rowId) ? { kind, rowId } : null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(rowId)) return null;
  return { kind: kind as ReturnRefKind, rowId };
}

/** Unprivileged ports only, and digits only — never a caller-composed string. */
const LOOPBACK_PORT_PATTERN = /^[0-9]{4,5}$/;

export function validLoopbackPort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 1024 && value <= 65535 ? value : null;
}

/**
 * Anything that reaches the return position from a caller is refused BEFORE a
 * flow starts. A URL, a path, a protocol-relative value, a scheme — none of
 * them is a reference to a row the board owns, and the SS-17 acceptance drives
 * exactly these shapes at `/auth/sso/start`.
 */
export function assertNotACallerComposedTarget(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    refuse('SSO_RETURN_REF_INVALID', 'the return reference must be an opaque server-side reference');
  }
  if (/[/\\]/.test(value) || value.includes('://') || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value.replace(/^(invitation|oauth):/, ''))) {
    refuse('SSO_RETURN_REF_INVALID', 'the return reference must not be a URL, a path, or anything a caller composes');
  }
}

export interface StartAuthenticationInput {
  /** Omitted means "the one active Identity provider" (SS-14a makes that total). */
  identityProviderId?: string;
  /** The invitation code a person carried in, if any (§6.3, `invited` mode). */
  invitationCode?: string | null;
  /** §8.3 step-up: forces `prompt=login` and `max_age=0`. */
  stepUp?: boolean;
  /** A loopback port for the CLI browser flow (§8.4). Server-validated. */
  loopbackPort?: number | null;
}

export interface StartedAuthentication {
  authorizeUrl: string;
  /** Set as an httpOnly, SameSite=Lax, Secure, short-TTL cookie (§5.1). */
  stateCookieValue: string;
  pendingRequestId: string;
  expiresAt: Date;
}

export interface CompleteAuthenticationInput {
  state?: string | null;
  code?: string | null;
  iss?: string | null;
  error?: string | null;
  errorDescription?: string | null;
  /** The value read back from the browser cookie. */
  cookieState?: string | null;
  ip?: unknown;
  userAgent?: unknown;
}

export interface CompletedAuthentication {
  sessionToken: string;
  sessionId: string;
  principalId: string;
  expiresAt: Date;
  identityProviderId: string;
  identityLinkId: string;
  /** A destination the SERVER chose. Never a caller value. */
  returnTo: string;
  /**
   * What the Identity provider actually sent in its groups claim, as the
   * production parser read it. Shape classes 2, 4 and 5 observe THIS - the
   * verdict is about the token, never about `group_binding_mode`, so a class
   * cannot be satisfied by our own configuration alone.
   */
  groupClaim: GroupClaimReading;
  /**
   * The opaque values that resolved to a bound board Group, in the order the
   * Identity provider sent them. Shape class 3 observes this: a directory
   * GUID, a `/path` and a bare name each bind on their own bytes.
   *
   * Empty when `group_binding_mode` is `off`, when the claim was unusable, or
   * when nothing is bound. NO MEMBERSHIP IS WRITTEN HERE - that is SS-W3.
   */
  boundGroupRefs: string[];
  /** Stamped by the conformance harness; production callers ignore it. */
  traversedEntryPoint: 'SsoAuthenticationService.completeAuthentication';
}

export class SsoAuthenticationService {
  constructor(
    private readonly discovery: SsoDiscoveryService = ssoDiscoveryService,
    private readonly transport: SsoTransport = httpsSsoTransport,
  ) {}

  private async resolveProvider(identityProviderId?: string): Promise<IdentityProvider> {
    const provider = identityProviderId
      ? await identityProviderService.get(identityProviderId)
      : await identityProviderService.activeProvider();
    if (!provider) refuse('SSO_NOT_CONFIGURED', 'no Identity provider is configured');
    if (provider.status !== 'active') refuse('SSO_PROVIDER_INACTIVE', 'that Identity provider is not enabled');
    return provider;
  }

  /**
   * §5.1 — the authorization request.
   *
   * `response_type=code` only. PKCE S256 MANDATORY — sent regardless of whether
   * the Identity provider advertises support, `plain` never used and never
   * accepted as a downgrade. `state` and `nonce` are independent 128-bit random
   * values bound to the browser by a short-TTL, httpOnly, SameSite=Lax, Secure
   * cookie AND to a server row; T-SS3 requires both to agree.
   */
  async startAuthentication(input: StartAuthenticationInput = {}): Promise<StartedAuthentication> {
    const provider = await this.resolveProvider(input.identityProviderId);
    const metadata = await this.discovery.metadata(providerConfig(provider));

    let returnRef: string | null = null;
    // §8.4: the CLI's browser flow. The port is validated and stored
    // server-side; the destination is composed by the board at the callback.
    const loopbackPort = validLoopbackPort(input.loopbackPort);
    if (loopbackPort !== null) returnRef = composeReturnRef('loopback', String(loopbackPort));
    if (input.invitationCode) {
      const invitation = await ssoInvitationService.peek(input.invitationCode, provider.id);
      if (!invitation) refuse('SSO_INVITATION_INVALID', 'that invitation is not valid for this Identity provider');
      // §6.3: the code is carried ONLY through the opaque return reference —
      // never as a claim, and never in a URL a caller composes. What travels to
      // the Identity provider is `state`; the invitation stays on our row.
      returnRef = composeReturnRef('invitation', invitation.id);
    }

    const state = mintOpaqueValue();
    const nonce = mintOpaqueValue();
    const verifier = mintPkceVerifier();
    const redirectUri = ssoRedirectUri();

    const pending = await ssoAuthenticationRequestService.create({
      identityProviderId: provider.id,
      state,
      nonce,
      pkceVerifier: verifier,
      redirectUri,
      returnRef,
      maxAgeRequested: input.stepUp ? 0 : null,
      ttlSeconds: provider.authenticationRequestTtlSeconds,
    });

    const url = new URL(metadata.authorizationEndpoint.toString());
    // `extra_authorize_params` first, so a deployment cannot use it to
    // overwrite a protocol parameter this design pins.
    for (const [key, value] of Object.entries(provider.extraAuthorizeParams)) {
      if (typeof value === 'string') url.searchParams.set(key, value);
    }
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', provider.scopesRequested);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', pkceChallengeFor(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (input.stepUp) {
      // §8.3: both, together. `max_age=0` with an `auth_time` that predates the
      // request is the refusal that DETECTS an Identity provider ignoring it.
      url.searchParams.set('prompt', 'login');
      url.searchParams.set('max_age', '0');
    }

    return {
      authorizeUrl: url.toString(),
      stateCookieValue: state,
      pendingRequestId: pending.id,
      expiresAt: pending.expiresAt,
    };
  }

  /** §5.2 — the callback, in the contract's order. */
  async completeAuthentication(input: CompleteAuthenticationInput): Promise<CompletedAuthentication> {
    // ── 1. state, cookie, and ONE pending row; consumed on the attempt ──────
    if (!input.state) refuse('SSO_STATE_MISSING', 'the callback carries no state');
    // T-SS3: the cookie and the row must AGREE. A callback whose `state`
    // matches a server row but whose cookie is absent or belongs to another
    // browser is refused — and the row is consumed on the attempt either way,
    // which is why the consume happens before this comparison.
    const consumed = await ssoAuthenticationRequestService.consume(input.state);
    if (!consumed) refuse('SSO_STATE_UNKNOWN', 'that authentication request is unknown, expired or already used');
    const { request: pending, pkceVerifier } = consumed;

    if (!input.cookieState || !timingSafeEquals(input.cookieState, input.state)) {
      await ssoAuthenticationRequestService.recordOutcome(pending.id, 'cookie_mismatch');
      refuse('SSO_COOKIE_MISMATCH', 'the authentication could not be tied to this browser');
    }

    // The provider-error arm runs HERE: after the row is consumed AND after the
    // browser binding (review R2 round 2, F1). Round 1's repair moved it past
    // the consume and stopped there, which left an unbound callback carrying
    // `error=...` refusing as a provider error and never recording
    // `cookie_mismatch` — so T-SS3's binding did not apply to this arm at all.
    // A provider error is still an ATTEMPT (SS-18), so the row is consumed
    // above either way; what changes here is that we no longer answer an
    // unbound browser about what the Identity provider said.
    if (input.error) {
      await auditService.record({
        action: 'sso.callback.provider_error',
        actor: anonymousActor(),
        resourceType: 'identity_provider',
        outcome: 'denied',
        metadata: { error: String(input.error).slice(0, 200), description: String(input.errorDescription ?? '').slice(0, 500) },
      });
      refuse('SSO_PROVIDER_ERROR', 'the Identity provider refused the authentication');
    }

    // ── 2. the row must name an ACTIVE Identity provider ────────────────────
    const provider = await identityProviderService.get(pending.identityProviderId);
    if (!provider || provider.status !== 'active') {
      await ssoAuthenticationRequestService.recordOutcome(pending.id, 'provider_inactive');
      refuse('SSO_PROVIDER_INACTIVE', 'that Identity provider is not enabled');
    }
    const metadata = await this.discovery.metadata(providerConfig(provider));

    // ── 3. RFC 9207 `iss` ──────────────────────────────────────────────────
    if (input.iss !== undefined && input.iss !== null && input.iss !== '') {
      if (input.iss !== provider.issuer) {
        await ssoAuthenticationRequestService.recordOutcome(pending.id, 'iss_mismatch');
        refuse('SSO_ISSUER_MISMATCH', 'the response names a different issuer than the request');
      }
    } else if (metadata.authorizationResponseIssParameterSupported) {
      await ssoAuthenticationRequestService.recordOutcome(pending.id, 'iss_missing');
      refuse('SSO_ISSUER_MISMATCH', 'the Identity provider advertises RFC 9207 but the response carries no iss');
    }

    if (!input.code) {
      await ssoAuthenticationRequestService.recordOutcome(pending.id, 'no_code');
      refuse('SSO_PROVIDER_ERROR', 'the callback carries no authorization code');
    }

    // ── 5. token exchange, at THIS ROW'S Identity provider (T-SS4) ─────────
    const tokens = await this.exchangeCode(provider, metadata, input.code, pending.redirectUri, pkceVerifier);

    const validated = await validateIdToken({
      token: tokens.idToken,
      issuer: provider.issuer,
      clientId: provider.clientId,
      clockSkewSeconds: provider.clockSkewSeconds,
      advertisedAlgs: metadata.idTokenSigningAlgValuesSupported,
      resolveKey: (kid) => this.discovery.signingKey(providerConfig(provider), kid),
      expectedNonceHash: pending.nonceHash,
      hashNonce: hashOpaqueValue,
      maxAgeRequested: pending.maxAgeRequested,
      requestedAt: pending.requestedAt,
      requiredClaims: provider.requiredClaims,
    });

    // Refusal 11 — consulted only when the Identity provider offers UserInfo
    // and returned an access token. The response is discarded either way; the
    // board stores no provider access token and no provider refresh token, so
    // there is nothing for a later compromise to replay.
    if (metadata.userinfoEndpoint && tokens.accessToken) {
      const userInfo = await this.transport.send({
        url: metadata.userinfoEndpoint,
        method: 'GET',
        policy: this.discovery.policyFor(providerConfig(provider)),
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      assertUserInfoSubject(userInfo, validated.subject);
    }

    const link = await this.resolveOrProvisionLink(provider, validated.subject, validated.claims, pending.returnRef);

    // ── §7.2 / SS-13 — the group claim, READ then APPLIED ───────────────────
    //
    // The claim is read on every login and its verdict recorded. An absent,
    // unparseable, truncated or overage-indicated claim is "claims
    // unavailable": no snapshot is applied, memberships are left exactly as
    // they were, and the staleness watermark does NOT move, so
    // `directory_sync_state` surfaces the failure and AZ-30's alarm fires past
    // its threshold. It is never read as "member of no groups" — that reading
    // is the directory wipe (T-SS14), and an overage indicator is
    // syntactically indistinguishable from an absent claim.
    //
    // W3 adds the WRITE half W2 deliberately left out. The snapshot is applied
    // through the ACCOUNT-SCOPED seam, never `applyDirectorySnapshot`: the
    // full-snapshot method's removal loop is unfiltered by Account, so calling
    // it with one person's entries would delete every other Account's
    // directory memberships on every login.
    const groupClaim = readGroupClaim(validated.claims as Record<string, unknown>, provider.groupsClaim);
    let boundGroupRefs: string[] = [];
    let appliedGroupIds: string[] = [];
    if (provider.groupBindingMode === 'claim' && groupClaim.verdict === 'claim_present') {
      const bindings = await resolveGroupBindings(provider.id, groupClaim.values);
      const bound = new Set(bindings.map((binding) => binding.externalGroupRef));
      // Order is the Identity provider's, and the values are never touched: SS-12's
      // "opaque string matched exactly" is a property of the query, not of a
      // normalisation step here.
      boundGroupRefs = groupClaim.values.filter((value) => bound.has(value));
      appliedGroupIds = bindings.map((binding) => binding.groupId);
      // ── THE SEAM (RH-LENSES-a, card 74e02a05, design v5 §3.3) ─────────
      //
      // The claim producer no longer writes membership. It records what the
      // Identity provider SAID -- the carriage -- and
      // `DirectoryCarriageService` derives membership from carriage, in ONE
      // transaction, under the three-level lock order, through the same
      // `applyAccountDirectorySnapshot` this line used to call directly.
      //
      // EVERY value goes in, not only the bound ones. A value that binds
      // nothing today is exactly what the catalog exists to show an
      // administrator, and it is why *Use this group* can bind a Group that
      // receives its members immediately instead of at everyone's next
      // login. `resolveGroupBindings` above is unchanged and is still what
      // decides which of them are bound -- for this login's own reporting.
      //
      // SS-13's fail-closed rule is untouched and still lives in the guard
      // on this `if`: an absent, unparseable or overage-indicated claim
      // reaches neither the carriage write nor the membership write.
      await directoryCarriageService.applyAccountCarriage(
        provider.id,
        link.accountPrincipalId,
        groupClaim.values,
        'claim',
        {
          principalId: link.accountPrincipalId,
          handle: 'sso',
          authMethod: 'session',
        } as AuditActor,
      );
    }

    // ── SSO-R4 — the login group whitelist, AFTER the snapshot ─────────────
    //
    // Order is the contract, not a convenience: the whitelist is evaluated
    // against STORED membership (§7.2 — a login never carries group
    // authority), so the claim that just arrived must already have become rows
    // for a first login to be admitted by a group it legitimately belongs to.
    // When the claim was unusable nothing was written, and the evaluation
    // falls back to the RETAINED membership — absence never admits anyone, and
    // a member whose Identity provider merely failed to enumerate their groups this
    // time is not evicted (W3-D2).
    //
    // The refusal happens BEFORE the login session is minted. A `jit`
    // Identity provider may create an Account that receives no login session;
    // that is the ruled
    // behaviour, and the audited refusal is the record of it.
    const whitelist = await evaluateLoginWhitelist({
      identityProviderId: provider.id,
      accountPrincipalId: link.accountPrincipalId,
      enabled: provider.loginGroupWhitelistEnabled,
    });
    if (!whitelist.admitted) {
      await auditService.record({
        action: 'sso.login_refused',
        outcome: 'denied',
        actor: {
          principalId: link.accountPrincipalId,
          handle: 'sso',
          authMethod: 'session',
        } as AuditActor,
        resourceType: 'identity_provider',
        resourceId: provider.id,
        metadata: {
          identity_provider_id: provider.id,
          identity_link_id: link.id,
          subject: validated.subject,
          reason: whitelist.reason,
          allowed_group_count: whitelist.allowedGroupCount,
          group_claim_verdict: groupClaim.verdict,
        },
      });
      await ssoAuthenticationRequestService.recordOutcome(pending.id, 'login_group_refused');
      refuse(
        'SSO_LOGIN_GROUP_REFUSED',
        'this account is not a member of a group permitted to sign in at this Identity provider',
      );
    }

    // §5.2 step 7 / SS-9: `role_snapshot` is not a parameter of the mint, so it
    // can only ever be NULL and `resolveActorRole` falls through to
    // `principals.role` identically for both login paths.
    const session = await loginSessionService.mint({
      principalId: link.accountPrincipalId,
      ip: input.ip,
      userAgent: input.userAgent,
      identityProviderId: provider.id,
      identityLinkId: link.id,
      oidcSid: validated.sid,
      // SSO-R16: retained ONLY when this Identity provider opted in, encrypted
      // under the §7.2 envelope keyset, disposal bound to session death.
      idToken: provider.retainIdToken ? tokens.idToken : null,
    });

    await identityLinkService.touch(link.id);
    await auditService.record({
      action: 'sso.login',
      actor: {
        principalId: link.accountPrincipalId,
        handle: 'sso',
        authMethod: 'session',
      } as AuditActor,
      resourceType: 'auth_session',
      resourceId: session.sessionId,
      metadata: {
        identity_provider_id: provider.id,
        identity_link_id: link.id,
        // The subject is an opaque identifier, not a secret, and it is the one
        // value that makes a support question answerable.
        subject: validated.subject,
        step_up: pending.maxAgeRequested !== null,
        // Recorded so a directory question has an answer months later, and so
        // an overage is distinguishable from an absent claim in the ledger.
        group_claim_verdict: groupClaim.verdict,
        bound_group_refs: boundGroupRefs.length,
        // W3: how many memberships the claim actually became, and whether the
        // login was gated at all. `applied_group_ids` is a count, not a list:
        // the per-Group detail is already in the group.member_add/remove rows
        // this login wrote, and duplicating it here would put the same fact in
        // two ledgers that can disagree.
        applied_group_count: appliedGroupIds.length,
        login_group_whitelist: whitelist.reason,
      },
    });
    await ssoAuthenticationRequestService.recordOutcome(pending.id, 'session_issued');

    return {
      sessionToken: session.token,
      sessionId: session.sessionId,
      principalId: link.accountPrincipalId,
      expiresAt: session.expiresAt,
      identityProviderId: provider.id,
      identityLinkId: link.id,
      returnTo: await this.resolveReturnTarget(pending.returnRef),
      groupClaim,
      boundGroupRefs,
      traversedEntryPoint: 'SsoAuthenticationService.completeAuthentication',
    };
  }

  /**
   * The token exchange, under the CONFIGURED client authentication method.
   *
   * All four of §4.1's methods are constructed here, and shape class 8 asserts
   * the form actually received by the provider double EQUALS the configured
   * one — not merely that the exchange succeeded. A mutation that always sends
   * one fixed form must fail the other three by name.
   */
  private async exchangeCode(
    provider: IdentityProvider,
    metadata: ValidatedProviderMetadata,
    code: string,
    redirectUri: string,
    pkceVerifier: string,
  ): Promise<{ idToken: string; accessToken: string | null }> {
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: pkceVerifier,
      client_id: provider.clientId,
    };
    const headers: Record<string, string> = {};

    // Shape class 8: the configured client authentication method must be one
    // the Identity provider ADVERTISES. Absence of the field is "unstated"
    // under RFC 8414, not "none", so a terse-but-conforming document is not
    // refused; an explicit list that omits our method is.
    const advertised = metadata.tokenEndpointAuthMethodsSupported;
    if (advertised.length > 0 && !advertised.includes(provider.clientAuthMethod)) {
      refuse(
        'SSO_TOKEN_EXCHANGE_FAILED',
        'the Identity provider does not advertise the configured client authentication method',
      );
    }

    const secret = await this.clientSecretFor(provider);

    switch (provider.clientAuthMethod) {
      case 'client_secret_basic':
        headers.Authorization = `Basic ${Buffer.from(
          `${encodeURIComponent(provider.clientId)}:${encodeURIComponent(secret ?? '')}`,
        ).toString('base64')}`;
        break;
      case 'client_secret_post':
        form.client_secret = secret ?? '';
        break;
      case 'private_key_jwt':
        form.client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
        form.client_assertion = await this.clientAssertionFor(provider, metadata);
        break;
      case 'none':
        // A public client. PKCE is the proof, and it is mandatory anyway.
        break;
    }

    const response = await this.transport.send({
      url: metadata.tokenEndpoint,
      method: 'POST',
      policy: this.discovery.policyFor(providerConfig(provider)),
      form,
      headers,
    });
    const body = (typeof response === 'object' && response !== null ? response : {}) as Record<string, unknown>;
    const idToken = typeof body.id_token === 'string' ? body.id_token : null;
    if (!idToken) refuse('SSO_TOKEN_EXCHANGE_FAILED', 'the token response carries no id_token');
    return {
      idToken,
      accessToken: typeof body.access_token === 'string' ? body.access_token : null,
    };
  }

  private async clientSecretFor(provider: IdentityProvider): Promise<string | null> {
    if (!provider.hasClientSecret) return null;
    const result = await pool.query(
      'SELECT client_secret_ct, client_secret_key_id FROM identity_providers WHERE id = $1',
      [provider.id],
    );
    const row = result.rows[0];
    if (!row?.client_secret_ct) return null;
    return decryptCredentialSecret(String(row.client_secret_ct), String(row.client_secret_key_id), provider.id);
  }

  private async clientAssertionFor(provider: IdentityProvider, metadata: ValidatedProviderMetadata): Promise<string> {
    const result = await pool.query(
      'SELECT client_private_key_ct, client_private_key_key_id FROM identity_providers WHERE id = $1',
      [provider.id],
    );
    const row = result.rows[0];
    if (!row?.client_private_key_ct) {
      refuse('SSO_TOKEN_EXCHANGE_FAILED', 'private_key_jwt is configured but no client private key is stored');
    }
    const pem = decryptCredentialSecret(
      String(row.client_private_key_ct),
      String(row.client_private_key_key_id),
      provider.id,
    );
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: provider.clientId,
      sub: provider.clientId,
      // The audience is the token endpoint the DOCUMENT gave us, so an
      // assertion minted for one Identity provider is not replayable at another.
      aud: metadata.tokenEndpoint.toString(),
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 300,
    };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
      JSON.stringify(claims),
    ).toString('base64url')}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput), {
      key: crypto.createPrivateKey(pem),
      padding: crypto.constants.RSA_PKCS1_PADDING,
    });
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  /**
   * §6.3 — provisioning, and the takeover it forbids.
   *
   * A subject already linked to a DIFFERENT Account is a refusal, never a
   * re-bind: re-binding is an owner-plane unlink then a fresh login (A19.2,
   * unchanged).
   */
  private async resolveOrProvisionLink(
    provider: IdentityProvider,
    subject: string,
    claims: Record<string, unknown>,
    returnRef: string | null,
  ): Promise<IdentityLink> {
    const existing = await identityLinkService.findBySubject(provider.id, subject);
    if (existing) {
      if (existing.state !== 'proven') {
        // `directory` mode's expectation, met for the first time.
        const promoted = await identityLinkService.promote(provider.id, subject);
        if (!promoted) refuse('SSO_ACCOUNT_UNAVAILABLE', 'that Identity link could not be promoted');
        return promoted;
      }
      await this.refreshProfile(provider, existing.accountPrincipalId, claims);
      return existing;
    }

    switch (provider.provisioningMode) {
      case 'invited':
        return this.bindByInvitation(provider, subject, claims, returnRef);
      case 'jit':
        return this.provisionJustInTime(provider, subject, claims);
      case 'directory':
        // SS-22: `directory` mode binds ONLY through an `expected` link the
        // SCIM producer wrote, promoted above on the first matching login.
        // A subject no expectation names is refused here — never matched to
        // an Account by `userName`, email or any other claim string (SS-20),
        // and never provisioned just-in-time: an Account the directory did
        // not push is not one it expects. RH-P5.SSO.W4 candidate B supplied
        // the producer and candidate C lifted the configuration-time refusal
        // (migration 108), so this arm is reachable exactly where an
        // Identity provider has a SCIM client and is enabled in this mode.
        refuse('SSO_ACCOUNT_UNAVAILABLE', 'no directory expectation names this subject at this Identity provider');
    }
  }

  private async bindByInvitation(
    provider: IdentityProvider,
    subject: string,
    claims: Record<string, unknown>,
    returnRef: string | null,
  ): Promise<IdentityLink> {
    const parsed = parseReturnRef(returnRef);
    if (!parsed || parsed.kind !== 'invitation') {
      // SSO-R5: claim matching is the ONLY alternative, and only behind its
      // conditions, all of which are checked in `matchByVerifiedEmail`.
      const matched = await this.matchByVerifiedEmail(provider, subject, claims);
      if (matched) return matched;
      refuse('SSO_INVITATION_REQUIRED', 'this Identity provider binds new people by invitation only');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invitation = await ssoInvitationService.consume(parsed.rowId, provider.id, client);
      if (!invitation) {
        await client.query('ROLLBACK');
        refuse('SSO_INVITATION_INVALID', 'that invitation is not valid for this Identity provider');
      }
      let accountId = invitation.accountPrincipalId;
      if (invitation.newAccountIntent) {
        const handle = invitation.intendedHandle ?? deriveHandle(provider, claims, subject);
        const created = await principalService.createPrincipal({
          handle,
          kind: 'human',
          displayName: claimString(claims, provider.displayNameClaim) ?? handle,
          role: FIXED_MINIMAL_ACCOUNT_ROLE,
        });
        if (!created) {
          await client.query('ROLLBACK');
          refuse('SSO_HANDLE_COLLISION', 'that handle is already taken; two people sharing a handle is an operator decision');
        }
        accountId = created.id;
        await this.storeEmailAttribute(created.id, claimString(claims, provider.emailClaim));
      }
      if (!accountId) {
        await client.query('ROLLBACK');
        refuse('SSO_INVITATION_INVALID', 'that invitation names no Account');
      }
      const link = await identityLinkService.establishProven(
        { accountPrincipalId: accountId, identityProviderId: provider.id, subject },
        client,
      );
      await ssoInvitationService.recordLink(invitation.id, link.id, client);
      await client.query('COMMIT');
      return link;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async provisionJustInTime(
    provider: IdentityProvider,
    subject: string,
    claims: Record<string, unknown>,
  ): Promise<IdentityLink> {
    const handle = deriveHandle(provider, claims, subject);
    const created = await principalService.createPrincipal({
      handle,
      kind: 'human',
      displayName: claimString(claims, provider.displayNameClaim) ?? handle,
      // Minimal role, no groups until claims say otherwise, no elevated
      // anything. `jit` is appropriate where the issuer IS the organisation's
      // boundary; `required_claims` is how a deployment pins that.
      role: FIXED_MINIMAL_ACCOUNT_ROLE,
    });
    if (!created) {
      refuse('SSO_HANDLE_COLLISION', 'that handle is already taken; collisions are refused rather than silently suffixed');
    }
    await this.storeEmailAttribute(created.id, claimString(claims, provider.emailClaim));
    return identityLinkService.establishProven({
      accountPrincipalId: created.id,
      identityProviderId: provider.id,
      subject,
    });
  }

  /**
   * SSO-R5 — claim matching, behind EVERY one of its conditions.
   *
   * This AMENDS SS-11's absolute form by owner declaration, and the amendment
   * is only sound because the conditions hold together:
   *
   *   * the per-Identity-provider switch DEFAULTS OFF (migration 104);
   *   * `email_verified` must be literally true — an unverified email at the
   *     configured Identity provider is exactly the takeover SS-11 names;
   *   * exactly ONE Identity provider may be enabled (SS-14a), so a second
   *     issuer cannot assert the same email;
   *   * the match is AUDITED every time;
   *   * it is REFUSED OUTRIGHT for any Account holding an elevated role.
   *
   * With the switch off this function returns undefined and the caller refuses,
   * which is the default-off arm the §11a SS-11 row requires proving alongside
   * the conditioned match path.
   */
  private async matchByVerifiedEmail(
    provider: IdentityProvider,
    subject: string,
    claims: Record<string, unknown>,
  ): Promise<IdentityLink | undefined> {
    if (!provider.allowClaimMatching) return undefined;
    if (claims.email_verified !== true) return undefined;
    const email = claimString(claims, provider.emailClaim);
    if (!email) return undefined;

    // §6.4/§6.6: `principals` has NO email column, deliberately — email is an
    // ATTRIBUTE for display, never an identifier, so it lives in `metadata`.
    // Matching reads the attribute; it never becomes a key, and the LIMIT 2
    // below is what makes an ambiguous match refuse rather than pick.
    const result = await pool.query(
      `SELECT id, role FROM principals
        WHERE kind = 'human' AND status = 'active'
          AND lower(metadata->>'email') = lower($1) LIMIT 2`,
      [email],
    );
    if (result.rows.length !== 1) return undefined;
    const account = result.rows[0] as { id: string; role: string | null };

    // Refused outright for an elevated Account. An elevated role is exactly
    // the authority a takeover would be worth having, so the condition is a
    // refusal rather than a warning.
    if (account.role === 'admin' || account.role === 'orchestrator') {
      await auditService.record({
        action: 'sso.claim_match.refused',
        actor: anonymousActor(),
        outcome: 'denied',
        resourceType: 'principal',
        resourceId: String(account.id),
        metadata: { identity_provider_id: provider.id, reason: 'elevated_role', subject },
      });
      refuse('SSO_CLAIM_MATCH_REFUSED', 'claim matching is refused for an Account holding an elevated role');
    }

    const link = await identityLinkService.establishProven({
      accountPrincipalId: String(account.id),
      identityProviderId: provider.id,
      subject,
    });
    await auditService.record({
      action: 'sso.claim_match',
      actor: anonymousActor(),
      resourceType: 'identity_link',
      resourceId: link.id,
      metadata: { identity_provider_id: provider.id, account_principal_id: account.id, subject, matched_on: 'email_verified' },
    });
    return link;
  }


  /**
   * §6.4/§6.6 — email is stored as an ATTRIBUTE for display, and never as an
   * identifier. `principals` has no email column by design, so it lives in
   * `metadata`; the JSONB merge leaves every other attribute untouched.
   *
   * This is also the only writer that gives SSO-R5's conditioned match path
   * anything to match against, which is worth saying out loud: without it the
   * match arm would be structurally unreachable and its acceptance vector
   * would pass vacuously.
   */
  private async storeEmailAttribute(accountPrincipalId: string, email: string | null): Promise<void> {
    if (!email) return;
    await pool.query(
      `UPDATE principals
          SET metadata = metadata || jsonb_build_object('email', $2::text), updated_at = now()
        WHERE id = $1`,
      [accountPrincipalId, email],
    );
  }

  /**
   * §6.4 — handle and display name refresh on every successful login ONLY when
   * the Account's link owns them. A locally edited display name is not
   * overwritten unless the operator set `provider_owns_profile` — the same
   * "local rows survive" instinct AZ-30 applied to group membership.
   */
  private async refreshProfile(
    provider: IdentityProvider,
    accountPrincipalId: string,
    claims: Record<string, unknown>,
  ): Promise<void> {
    if (!provider.providerOwnsProfile) return;
    await this.storeEmailAttribute(accountPrincipalId, claimString(claims, provider.emailClaim));
    const displayName = claimString(claims, provider.displayNameClaim);
    if (!displayName) return;
    await principalService.updatePrincipal(accountPrincipalId, { displayName });
  }

  /** SS-17: a destination the SERVER chooses, resolved from a row we own. */
  private async resolveReturnTarget(returnRef: string | null): Promise<string> {
    const parsed = parseReturnRef(returnRef);
    if (!parsed) return '/';
    if (parsed.kind === 'loopback') {
      // A fixed host and a validated integer port: there is no caller-supplied
      // string in this destination at all, so the open-redirect class SS-17
      // removes stays removed.
      return `http://127.0.0.1:${parsed.rowId}/`;
    }
    if (parsed.kind === 'oauth') {
      // §9.1: back to the consent page for THAT authorization request.
      const result = await pool.query('SELECT 1 FROM oauth_authorization_requests WHERE id = $1', [parsed.rowId]);
      if (result.rows.length === 0) return '/';
      return `/oauth/consent?request=${encodeURIComponent(parsed.rowId)}`;
    }
    return '/';
  }
}

/** Only what the discovery service needs. Nothing that could steer a fetch. */
function providerConfig(provider: IdentityProvider) {
  return {
    id: provider.id,
    issuer: provider.issuer,
    discoveryUrl: provider.discoveryUrl,
    additionalEndpointOrigins: provider.additionalEndpointOrigins,
    allowPrivateIssuerAddress: provider.allowPrivateIssuerAddress,
  };
}

/**
 * The actor for a relying-party act with no authenticated board principal: a
 * provider error arriving at the callback, or a claim match decided during a
 * login that has not issued a session yet.
 *
 * `unknown` rather than `none`: `audit_events.auth_method` enumerates its
 * permitted values and `none` is not one of them, so an actor built that way
 * throws at the INSERT — which is exactly what happened until the conformance
 * gate drove these paths against a real database.
 */
function anonymousActor(): AuditActor {
  return { principalId: null, handle: 'anonymous', authMethod: 'unknown' } as unknown as AuditActor;
}

function claimString(claims: Record<string, unknown>, path: string): string | null {
  // A DOTTED PATH, so a claim nested under a container is expressible as
  // configuration rather than as code (shape class 2). The value is never
  // parsed beyond this traversal.
  let cursor: unknown = claims;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
}

/**
 * §6.4: the handle comes from `handle_claim`, falling back to a DETERMINISTIC
 * derivation from `sub` when absent. Collisions are refused at provisioning
 * time rather than resolved by silent suffixing — two people sharing a handle
 * is an operator decision, not a rounding error.
 */
function deriveHandle(provider: IdentityProvider, claims: Record<string, unknown>, subject: string): string {
  const claimed = claimString(claims, provider.handleClaim);
  const candidate = claimed ?? `sso-${crypto.createHash('sha256').update(subject).digest('hex').slice(0, 16)}`;
  return normalizeAccountHandle(candidate);
}

function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export const ssoAuthenticationService = new SsoAuthenticationService();
