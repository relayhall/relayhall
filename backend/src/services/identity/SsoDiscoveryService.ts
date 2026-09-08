/**
 * SsoDiscoveryService — §4.2 of design `d95136d7`: discovery and JWKS.
 *
 * ── ENDPOINTS ARE NEVER TEMPLATED FROM THE ISSUER ──
 *
 * They are READ from the discovery document. That single rule is what absorbs
 * shape class 1 (an issuer that is a path under a shared host — a per-tenant,
 * per-realm or per-application path is routine), and it is why two Identity
 * providers on the SAME host resolve to their own endpoint sets rather than to
 * whichever one a template would have produced.
 *
 * The document is remote data, so it is validated before it is believed:
 *   * its own `issuer` must equal the configured `issuer` BYTE-FOR-BYTE — the
 *     mix-up defence applied at configuration time, before any user exists;
 *   * every endpoint URL must be https and same-origin with the issuer, unless
 *     the operator listed that exact origin (see `assertEndpointOrigin`).
 *
 * ── THE JWKS COOLDOWN IS A CONTROL, NOT A CACHE POLICY (T-SS9) ──
 *
 * A `kid` that misses the cache triggers AT MOST ONE re-fetch per Identity
 * provider per cooldown window. A miss INSIDE the window is a REFUSAL, not a
 * fetch. Without that, anyone who can hand the callback a token with a random
 * `kid` has a request amplifier pointed at the Identity provider.
 *
 * Rotation stays free: a provider publishes a new key, the next miss (or the
 * next scheduled refresh) picks it up, and the old key stays valid until it
 * leaves the document.
 */
import {
  SsoOutboundError,
  SsoOutboundPolicy,
  SsoTransport,
  assertEndpointOrigin,
  fetchJsonDocument,
  httpsSsoTransport,
  validateOutboundUrl,
} from './ssoOutbound';

/** Default window; a miss inside it is refused rather than fetched. */
export const JWKS_REFRESH_COOLDOWN_MS = 60_000;
/** Scheduled staleness: a document older than this is re-read on next use. */
export const DISCOVERY_MAX_AGE_MS = 3_600_000;

export type DiscoveryRejection =
  | 'DISCOVERY_ISSUER_MISMATCH'
  | 'DISCOVERY_MISSING_ENDPOINT'
  | 'DISCOVERY_MALFORMED'
  | 'JWKS_MALFORMED'
  | 'JWKS_KID_UNKNOWN'
  | 'JWKS_REFRESH_COOLING_DOWN';

export class SsoDiscoveryError extends Error {
  constructor(public readonly code: DiscoveryRejection, message: string) {
    super(message);
    this.name = 'SsoDiscoveryError';
  }
}

/**
 * The subset of the discovery document this relying party relies on, already
 * origin-validated. Everything here came from the document; nothing was
 * constructed from the issuer string.
 */
export interface ValidatedProviderMetadata {
  issuer: string;
  authorizationEndpoint: URL;
  tokenEndpoint: URL;
  jwksUri: URL;
  userinfoEndpoint: URL | null;
  endSessionEndpoint: URL | null;
  /** §5.3 refusal 1 intersects the allowlist with THIS advertised set. */
  idTokenSigningAlgValuesSupported: readonly string[];
  /** §5.2 step 3: a missing `iss` is refused where this is advertised. */
  authorizationResponseIssParameterSupported: boolean;
  /**
   * Shape class 6 reads its characteristic HERE — from the document the code
   * actually validated — rather than from our own `backchannel_logout_enabled`
   * setting. A class satisfiable by our configuration alone is testing us, not
   * the Identity provider.
   */
  backchannelLogoutSupported: boolean;
  codeChallengeMethodsSupported: readonly string[];
  tokenEndpointAuthMethodsSupported: readonly string[];
  deviceAuthorizationEndpoint: URL | null;
  fetchedAt: number;
}

export interface JsonWebKey {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  [key: string]: unknown;
}

interface ProviderCacheEntry {
  metadata?: ValidatedProviderMetadata;
  keys?: JsonWebKey[];
  jwksFetchedAt?: number;
  /** When the last cooldown-bounded refresh was ATTEMPTED, hit or miss. */
  lastJwksRefreshAttemptAt?: number;
}

/** What the service needs from an `identity_providers` row. Nothing more. */
export interface DiscoveryProviderConfig {
  id: string;
  issuer: string;
  discoveryUrl: string;
  additionalEndpointOrigins: readonly string[];
  allowPrivateIssuerAddress: boolean;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export class SsoDiscoveryService {
  private readonly cache = new Map<string, ProviderCacheEntry>();

  constructor(private readonly transport: SsoTransport = httpsSsoTransport) {}

  /** Test and conformance-harness hook: forget everything cached. */
  reset(providerId?: string): void {
    if (providerId === undefined) this.cache.clear();
    else this.cache.delete(providerId);
  }

  policyFor(provider: DiscoveryProviderConfig): SsoOutboundPolicy {
    return {
      issuerOrigin: validateOutboundUrl(provider.issuer).origin,
      additionalEndpointOrigins: provider.additionalEndpointOrigins,
      allowPrivateIssuerAddress: provider.allowPrivateIssuerAddress,
    };
  }

  private entry(providerId: string): ProviderCacheEntry {
    let found = this.cache.get(providerId);
    if (!found) {
      found = {};
      this.cache.set(providerId, found);
    }
    return found;
  }

  /**
   * Fetch (or reuse) the validated discovery document.
   *
   * `force` is how the owner-plane test-connection act re-reads on demand; the
   * hot path never forces, so a hostile caller cannot drive fetches.
   */
  async metadata(provider: DiscoveryProviderConfig, force = false): Promise<ValidatedProviderMetadata> {
    const entry = this.entry(provider.id);
    const fresh = entry.metadata && Date.now() - entry.metadata.fetchedAt < DISCOVERY_MAX_AGE_MS;
    if (!force && fresh && entry.metadata) return entry.metadata;

    const policy = this.policyFor(provider);
    const document = await fetchJsonDocument(validateOutboundUrl(provider.discoveryUrl), policy, this.transport);
    if (typeof document !== 'object' || document === null) {
      throw new SsoDiscoveryError('DISCOVERY_MALFORMED', 'the discovery document is not a JSON object');
    }
    const raw = document as Record<string, unknown>;

    // The mix-up defence, at configuration time: byte-for-byte, no
    // normalisation, no trailing-slash tolerance.
    const advertisedIssuer = str(raw.issuer);
    if (advertisedIssuer !== provider.issuer) {
      throw new SsoDiscoveryError(
        'DISCOVERY_ISSUER_MISMATCH',
        'the discovery document advertises an issuer that is not the configured issuer',
      );
    }

    const required = (field: string): URL => {
      const value = str(raw[field]);
      if (value === null) {
        throw new SsoDiscoveryError('DISCOVERY_MISSING_ENDPOINT', `the discovery document has no ${field}`);
      }
      return assertEndpointOrigin(value, policy);
    };
    const optional = (field: string): URL | null => {
      const value = str(raw[field]);
      return value === null ? null : assertEndpointOrigin(value, policy);
    };

    const metadata: ValidatedProviderMetadata = {
      issuer: advertisedIssuer,
      authorizationEndpoint: required('authorization_endpoint'),
      tokenEndpoint: required('token_endpoint'),
      jwksUri: required('jwks_uri'),
      userinfoEndpoint: optional('userinfo_endpoint'),
      endSessionEndpoint: optional('end_session_endpoint'),
      idTokenSigningAlgValuesSupported: strArray(raw.id_token_signing_alg_values_supported),
      authorizationResponseIssParameterSupported: raw.authorization_response_iss_parameter_supported === true,
      backchannelLogoutSupported: raw.backchannel_logout_supported === true,
      codeChallengeMethodsSupported: strArray(raw.code_challenge_methods_supported),
      tokenEndpointAuthMethodsSupported: strArray(raw.token_endpoint_auth_methods_supported),
      deviceAuthorizationEndpoint: optional('device_authorization_endpoint'),
      fetchedAt: Date.now(),
    };
    entry.metadata = metadata;
    return metadata;
  }

  /**
   * Resolve a `kid` to a signing key.
   *
   * THE COOLDOWN IS THE POINT. On a miss the service refreshes only if no
   * MISS-TRIGGERED refresh has been attempted within the window; otherwise it
   * refuses. That makes an unknown-`kid` flood cost at most one outbound
   * request per window per Identity provider, which is what T-SS9 asks for —
   * while still letting the first miss after a key rotation pick up the new
   * key, which is what §4.2 promises.
   */
  async signingKey(provider: DiscoveryProviderConfig, kid: string): Promise<JsonWebKey> {
    const entry = this.entry(provider.id);
    const hit = (): JsonWebKey | undefined => entry.keys?.find((key) => key.kid === kid);

    if (entry.keys === undefined) {
      // The FIRST load is not a re-fetch, so it does not consume the cooldown
      // window. §4.2 requires that "the next miss picks it up" — a rotation
      // arriving seconds after startup must still be resolvable — while the
      // amplification threat stays closed, because once the cache exists every
      // further miss goes through the cooldown-governed path below.
      await this.refreshJwks(provider, { countsTowardCooldown: false });
      const first = hit();
      if (first) return first;
    } else {
      const cached = hit();
      if (cached) return cached;
    }

    const now = Date.now();
    const lastAttempt = entry.lastJwksRefreshAttemptAt ?? 0;
    if (now - lastAttempt < JWKS_REFRESH_COOLDOWN_MS) {
      throw new SsoDiscoveryError(
        'JWKS_REFRESH_COOLING_DOWN',
        'the signing key is unknown and the JWKS refresh window has not elapsed',
      );
    }
    await this.refreshJwks(provider);
    const refreshed = hit();
    if (refreshed) return refreshed;
    throw new SsoDiscoveryError('JWKS_KID_UNKNOWN', 'the token names a signing key the Identity provider does not publish');
  }

  /**
   * One JWKS read, under the same outbound policy as every other fetch. The
   * attempt timestamp is stamped BEFORE the request, so a failing Identity
   * provider cannot be used as an amplifier either.
   */
  private async refreshJwks(
    provider: DiscoveryProviderConfig,
    options: { countsTowardCooldown?: boolean } = {},
  ): Promise<void> {
    const entry = this.entry(provider.id);
    // Stamped BEFORE the request, so a failing Identity provider cannot be
    // used as an amplifier either.
    if (options.countsTowardCooldown !== false) entry.lastJwksRefreshAttemptAt = Date.now();
    const metadata = await this.metadata(provider);
    const document = await fetchJsonDocument(metadata.jwksUri, this.policyFor(provider), this.transport);
    if (typeof document !== 'object' || document === null || !Array.isArray((document as { keys?: unknown }).keys)) {
      throw new SsoDiscoveryError('JWKS_MALFORMED', 'the JWKS document has no keys array');
    }
    entry.keys = ((document as { keys: unknown[] }).keys).filter(
      (key): key is JsonWebKey => typeof key === 'object' && key !== null,
    );
    entry.jwksFetchedAt = Date.now();
  }

  /** Health, for the Access manager. Recorded, never retried into behaviour. */
  health(providerId: string): { metadataFetchedAt: number | null; jwksFetchedAt: number | null } {
    const entry = this.cache.get(providerId);
    return {
      metadataFetchedAt: entry?.metadata?.fetchedAt ?? null,
      jwksFetchedAt: entry?.jwksFetchedAt ?? null,
    };
  }
}

export { SsoOutboundError };
export const ssoDiscoveryService = new SsoDiscoveryService();
