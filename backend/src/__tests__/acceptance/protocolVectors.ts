/**
 * SS-W2 protocol-level acceptance vectors — the §11a threat rows that need a
 * real flow rather than a unit test (annex `e6dcadb9` §11a).
 *
 *   - **T-SS3** state fixation / login CSRF: a callback whose `state` matches a
 *     server row but whose cookie is absent or belongs to another browser is
 *     refused; a cookie without a row is refused; **and the row is consumed on
 *     the attempt either way**, which is the half a naive test forgets.
 *   - **T-SS4** provider mix-up: a response carrying provider B's `iss` against
 *     a pending row for A is refused; a missing `iss` where the document
 *     advertises RFC 9207 is refused; and the token endpoint dialled is **A's**,
 *     asserted on the wire.
 *   - **T-SS9** JWKS refresh amplification: an unknown `kid` triggers **at most
 *     one** refetch per cooldown window, and a second miss inside the window is
 *     a refusal rather than a fetch.
 *
 * Each drives the production entry point with a provider double at the one
 * outbound seam, so the observations are of production behaviour on the wire.
 */
import crypto from 'crypto';
import { pool } from '../../db/connection';
import { resetProvidersByIssuerPrefix } from './resetProviders';
import type { AuditActor } from '../../services/AuditService';
import { identityProviderService, type IdentityProvider } from '../../services/identity/IdentityProviderService';
import { SsoAuthenticationService } from '../../services/identity/SsoAuthenticationService';
import { SsoDiscoveryService } from '../../services/identity/SsoDiscoveryService';
import { hashOpaqueValue } from '../../services/identity/SsoAuthenticationRequestService';
import { ProviderDouble } from '../conformance/providerDouble';
import type { VectorResult } from './vectors';

const ACTOR = { principalId: null, handle: 'protocol-vectors', authMethod: 'system' } as unknown as AuditActor;
const HOST = 'https://idp.protocol.test';

export async function runProtocolVectors(): Promise<VectorResult[]> {
  const results: VectorResult[] = [];
  const record = (id: string, claim: string, ok: boolean, detail: string): void => {
    results.push({ id, claim, ok, detail });
  };

  const double = new ProviderDouble();
  const discovery = new SsoDiscoveryService(double);
  const service = new SsoAuthenticationService(discovery, double);
  const run = crypto.randomBytes(4).toString('hex');

  await resetProvidersByIssuerPrefix(`${HOST}%`);

  const provision = async (slug: string, documentOverrides?: Record<string, unknown>): Promise<IdentityProvider> => {
    const issuer = `${HOST}/${slug}`;
    double.register({ issuer, clientId: `client-${slug}`, documentOverrides });
    await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active'");
    return identityProviderService.create(
      {
        name: `Protocol ${slug}`,
        issuer,
        clientId: `client-${slug}`,
        clientSecret: 'protocol-secret',
        subjectImmutable: true,
        status: 'active',
        provisioningMode: 'jit',
      } as never,
      ACTOR,
    );
  };

  const start = async (provider: IdentityProvider) => {
    double.resetRequests();
    discovery.reset();
    const started = await service.startAuthentication({ identityProviderId: provider.id });
    const url = new URL(started.authorizeUrl);
    return { state: url.searchParams.get('state') ?? '', nonce: url.searchParams.get('nonce') ?? '' };
  };

  const armCode = (provider: IdentityProvider, nonce: string, subject: string): string => {
    const now = Math.floor(Date.now() / 1000);
    return double.issueCode(provider.issuer, {
      iss: provider.issuer,
      sub: subject,
      aud: provider.clientId,
      exp: now + 300,
      iat: now - 5,
      nonce,
      preferred_username: `${subject}-${run}`,
    });
  };

  const refusalOf = async (action: () => Promise<unknown>): Promise<string> => {
    try {
      await action();
      return '<accepted>';
    } catch (error) {
      return String((error as { code?: unknown }).code ?? (error as Error).message);
    }
  };

  const consumedAt = async (state: string): Promise<boolean> => {
    const result = await pool.query(
      'SELECT consumed_at IS NOT NULL AS consumed FROM sso_authentication_requests WHERE state_hash = $1',
      [hashOpaqueValue(state)],
    );
    return result.rows[0]?.consumed === true;
  };

  // ── T-SS3 — state bound to BOTH a cookie and a server row ───────────────
  {
    const provider = await provision('state-binding');

    // (1) the row exists, the cookie is ABSENT.
    const a = await start(provider);
    const codeA = armCode(provider, a.nonce, 'tss3-nocookie');
    const noCookie = await refusalOf(() =>
      service.completeAuthentication({ state: a.state, code: codeA, iss: provider.issuer, cookieState: null }),
    );
    const consumedAnyway = await consumedAt(a.state);

    // (2) the cookie belongs to ANOTHER browser.
    const b = await start(provider);
    const codeB = armCode(provider, b.nonce, 'tss3-othercookie');
    const otherCookie = await refusalOf(() =>
      service.completeAuthentication({
        state: b.state,
        code: codeB,
        iss: provider.issuer,
        cookieState: 'a-different-browsers-state',
      }),
    );
    const consumedAnyway2 = await consumedAt(b.state);

    // (3) a cookie with NO server row.
    const orphanCookie = await refusalOf(() =>
      service.completeAuthentication({
        state: 'a-state-that-never-existed',
        code: 'irrelevant',
        iss: provider.issuer,
        cookieState: 'a-state-that-never-existed',
      }),
    );

    record(
      'T-SS3-state-binding',
      'state must match BOTH the cookie and a server row, and the row is consumed on the attempt either way',
      noCookie === 'SSO_COOKIE_MISMATCH' &&
        otherCookie === 'SSO_COOKIE_MISMATCH' &&
        orphanCookie === 'SSO_STATE_UNKNOWN' &&
        consumedAnyway &&
        consumedAnyway2,
      `absent cookie=${noCookie}, other browser=${otherCookie}, cookie without row=${orphanCookie}, ` +
        `rows consumed on the attempt=${consumedAnyway && consumedAnyway2}`,
    );
  }

  // ── T-SS4 — provider mix-up ────────────────────────────────────────────
  {
    const providerB = await provision('mixup-b');
    const providerA = await provision('mixup-a');

    // (1) provider B's `iss` against a pending row for A.
    const a = await start(providerA);
    const codeA = armCode(providerA, a.nonce, 'tss4-mixup');
    const wrongIss = await refusalOf(() =>
      service.completeAuthentication({ state: a.state, code: codeA, iss: providerB.issuer, cookieState: a.state }),
    );

    // (2) a MISSING `iss` where the document advertises RFC 9207.
    const c = await start(providerA);
    const codeC = armCode(providerA, c.nonce, 'tss4-missing');
    const missingIss = await refusalOf(() =>
      service.completeAuthentication({ state: c.state, code: codeC, iss: null, cookieState: c.state }),
    );

    // (3) the token endpoint dialled is A's, ON THE WIRE, whatever the
    // response claims. The pending row names the provider, so this holds by
    // construction rather than by a check someone remembered to write.
    const d = await start(providerA);
    const codeD = armCode(providerA, d.nonce, 'tss4-wire');
    await service.completeAuthentication({ state: d.state, code: codeD, iss: providerA.issuer, cookieState: d.state });
    const tokenCalls = double.dialled().filter((url) => url.endsWith('/token'));

    record(
      'T-SS4-provider-mixup',
      "another provider's iss is refused, a missing iss is refused where advertised, and the token endpoint dialled is the ROW's provider",
      wrongIss === 'SSO_ISSUER_MISMATCH' &&
        missingIss === 'SSO_ISSUER_MISMATCH' &&
        tokenCalls.length === 1 &&
        tokenCalls[0] === `${providerA.issuer}/token`,
      `wrong iss=${wrongIss}, missing iss=${missingIss}, token endpoint dialled=${tokenCalls[0]}`,
    );
  }

  // ── T-SS9 — JWKS refresh amplification ─────────────────────────────────
  {
    const provider = await provision('jwks-cooldown');
    const config = {
      id: provider.id,
      issuer: provider.issuer,
      discoveryUrl: provider.discoveryUrl,
      additionalEndpointOrigins: provider.additionalEndpointOrigins,
      allowPrivateIssuerAddress: provider.allowPrivateIssuerAddress,
    };
    discovery.reset();
    double.resetRequests();

    // Prime the cache with a known key, then miss twice with unknown ones.
    const registered = double.get(provider.issuer);
    await discovery.signingKey(config, registered.kid);
    const primed = double.dialled().filter((url) => url.endsWith('/jwks')).length;

    const firstMiss = await refusalOf(() => discovery.signingKey(config, 'unknown-kid-1'));
    const afterFirst = double.dialled().filter((url) => url.endsWith('/jwks')).length;
    const secondMiss = await refusalOf(() => discovery.signingKey(config, 'unknown-kid-2'));
    const afterSecond = double.dialled().filter((url) => url.endsWith('/jwks')).length;

    record(
      'T-SS9-jwks-cooldown',
      'an unknown kid triggers at most ONE refetch per window; a second miss inside it is refused, not fetched',
      firstMiss === 'JWKS_KID_UNKNOWN' &&
        secondMiss === 'JWKS_REFRESH_COOLING_DOWN' &&
        afterSecond === afterFirst,
      `jwks fetches: primed=${primed}, after first miss=${afterFirst}, after second miss=${afterSecond} ` +
        `(must not grow); first=${firstMiss}, second=${secondMiss}`,
    );
  }

  return results;
}
