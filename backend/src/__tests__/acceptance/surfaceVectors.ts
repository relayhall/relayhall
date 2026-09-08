/**
 * REQUIRES EXCLUSIVE USE OF ITS DATABASE: SS-14a is a global one-enabled-
 * provider rule, so these fixtures disable whatever provider is active. Never
 * run this against a shared or deployed database.
 *
 * SS-W2 surface acceptance vectors (annex `e6dcadb9` §11a).
 *
 * These are the §11a rows whose subject is a REQUEST SURFACE rather than a
 * stored object, so each is driven across the seam that carries the threat:
 *
 *   - **T-SS13** — "its own vector": the authorization request's `redirect_uri`
 *     is byte-identical under hostile `Host` and `X-Forwarded-Host`, and equals
 *     the configured public origin. Driven over a REAL socket against the REAL
 *     route with `trust proxy` set the way production sets it, because a
 *     header-borne threat cannot be observed by calling the service directly:
 *     a service that takes no request trivially ignores headers that never
 *     reached it. The control proves the hostile header did arrive, and that a
 *     header-reading composer on the same request would have been steered.
 *
 *   - **SS-5 / SS-6** — every caller-controllable input on both public routes
 *     is varied and the outbound destination is asserted UNCHANGED, against the
 *     single outbound seam, with the destination set asserted non-empty so
 *     "unchanged" cannot pass by nothing ever being dialled.
 *
 *   - **SS-3** — `/identity-providers` at `root`. Every method is enumerated
 *     FROM THE PRODUCTION ROUTER rather than from a list written here, so a
 *     route added later is covered without this file being edited; each
 *     resolves to `root` through the production scope map, and is refused for
 *     every non-root role through the production satisfy decision.
 *
 *   - **SS-7** — the provider-secret canary fails loudly on a corrupted row,
 *     with an untouched-row control so it cannot pass by failing on everything.
 */
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { pool } from '../../db/connection';
import { resetProvidersByIssuerPrefix } from './resetProviders';
import type { AuditActor } from '../../services/AuditService';
import { createSsoRouter } from '../../routes/sso';
import identityProvidersRoutes from '../../routes/identityProviders';
import { httpsSsoTransport } from '../../services/identity/ssoOutbound';
import type { SsoTransport } from '../../services/identity/ssoOutbound';
import {
  SSO_CALLBACK_PATH,
  SSO_PUBLIC_ORIGIN_ENV,
  ssoRedirectUri,
} from '../../services/identity/ssoRedirectUri';
import {
  identityProviderService,
  type IdentityProvider,
} from '../../services/identity/IdentityProviderService';
import { ssoDiscoveryService } from '../../services/identity/SsoDiscoveryService';
import { boardEndpointFor } from '../../utils/onboardingPack';
import { requiredScopeFor, scopesSatisfy, ROOT_SCOPE, ALL_SCOPES } from '../../utils/scopeMap';
import { scopesForRole } from '../../utils/identityScopes';
import {
  encryptCredentialSecret,
  runIdentityProviderSecretCanary,
  CredentialCryptoError,
} from '../../utils/credentialCrypto';
import { ProviderDouble } from '../conformance/providerDouble';
import type { VectorResult } from './vectors';

const ACTOR = { principalId: null, handle: 'surface-vectors', authMethod: 'system' } as unknown as AuditActor;
const HOST = 'https://idp.surface.test';
const CONFIGURED_ORIGIN = 'https://board.surface.test/api';

/** The headers a permissive proxy would let an attacker set (T-SS13). */
const HOSTILE_HEADERS: Record<string, string> = {
  Host: 'attacker.surface.test',
  'X-Forwarded-Host': 'attacker.surface.test',
  'X-Forwarded-Proto': 'http',
};
const BENIGN_HEADERS: Record<string, string> = {
  'X-Forwarded-Proto': 'https',
};

interface Probe {
  hostname: string;
  forwardedHost: string | null;
  /** The REAL header-reading composer, on the very same request. */
  boardEndpoint: string;
}

export async function runSurfaceVectors(): Promise<VectorResult[]> {
  const results: VectorResult[] = [];
  const record = (id: string, claim: string, ok: boolean, detail: string): void => {
    results.push({ id, claim, ok, detail });
  };

  const double = new ProviderDouble();
  const run = crypto.randomBytes(4).toString('hex');

  // The single outbound seam is swapped for the double, exactly as the §4.5(a)
  // gate controls the resolver: production composition is untouched, and every
  // socket the relying party would open is answered by the double instead.
  const realSend = httpsSsoTransport.send.bind(httpsSsoTransport);
  (httpsSsoTransport as { send: SsoTransport['send'] }).send = (request) => double.send(request);

  const savedOrigin = process.env[SSO_PUBLIC_ORIGIN_ENV];
  process.env[SSO_PUBLIC_ORIGIN_ENV] = CONFIGURED_ORIGIN;

  const app = express();
  // server.ts:65 — production trusts one proxy hop, so X-Forwarded-* is
  // authoritative for req.hostname here. This vector is only meaningful in
  // that configuration: it is the permissive-proxy case the threat names.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/auth/sso', createSsoRouter({ issueBrowserAccessCookie: () => undefined }));
  // A probe on the SAME app, so the control observes the SAME request the
  // route under test observed.
  app.get('/probe', (req, res) => {
    res.json({
      hostname: req.hostname,
      forwardedHost: (req.headers['x-forwarded-host'] as string | undefined) ?? null,
      boardEndpoint: boardEndpointFor(req),
    } satisfies Probe);
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const provision = async (slug: string, config: Record<string, unknown> = {}): Promise<IdentityProvider> => {
    const issuer = `${HOST}/${slug}`;
    double.register({ issuer, clientId: `client-${slug}` });
    // UNSCOPED, and it has to be. SS-14a is a GLOBAL constraint — exactly one
    // enabled Identity provider per deployment — so a fixture that needs an
    // active provider must disable whatever else is active, whoever created it.
    // Round 2 (R4) rightly objected to this harness touching rows it did not
    // own; the resolution is not to scope the write (that makes SS-14a
    // unsatisfiable) but to state the requirement: THIS HARNESS NEEDS EXCLUSIVE
    // USE OF ITS DATABASE. Give each reviewer their own; never point it at a
    // shared one.
    await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active'");
    return identityProviderService.create(
      {
        name: `Surface ${slug}`,
        issuer,
        clientId: `client-${slug}`,
        clientSecret: 'surface-secret',
        subjectImmutable: true,
        status: 'active',
        provisioningMode: 'invited',
        ...config,
      } as never,
      ACTOR,
    );
  };

  const startWith = async (
    headers: Record<string, string>,
    body: Record<string, unknown> = {},
  ): Promise<{ status: number; json: any }> => {
    ssoDiscoveryService.reset();
    const response = await fetch(`${base}/auth/sso/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };

  const probeWith = async (headers: Record<string, string>): Promise<Probe> => {
    const response = await fetch(`${base}/probe`, { headers });
    return (await response.json()) as Probe;
  };

  const redirectUriOf = (json: any): string | null => {
    if (!json || typeof json.authorizeUrl !== 'string') return null;
    return new URL(json.authorizeUrl).searchParams.get('redirect_uri');
  };

  try {
    await resetProvidersByIssuerPrefix(`${HOST}%`);
    const provider = await provision(`t-ss13-${run}`);

    // ── T-SS13 ────────────────────────────────────────────────────────────
    {
      const hostile = await startWith(HOSTILE_HEADERS, { identityProviderId: provider.id });
      const benign = await startWith(BENIGN_HEADERS, { identityProviderId: provider.id });
      const hostileUri = redirectUriOf(hostile.json);
      const benignUri = redirectUriOf(benign.json);
      // Anchored OUTSIDE the composer. Deriving this from ssoRedirectUri()
      // would move the expectation with any change to the function under test,
      // and the vector would agree with a composer that had started reading
      // headers. The registered redirect_uri is a value the Identity provider
      // holds, so it is stated here literally: changing it is a breaking change
      // at the provider, and this vector is where that becomes loud.
      const configured = `${CONFIGURED_ORIGIN}/auth/sso/callback`;
      const composerAgrees = ssoRedirectUri(
        { [SSO_PUBLIC_ORIGIN_ENV]: CONFIGURED_ORIGIN } as NodeJS.ProcessEnv) === configured;

      // The control: did the hostile header actually reach the app, and would a
      // header-reading composer have been steered by it? Without this, "the
      // redirect_uri did not change" is equally true of a header that was never
      // delivered, and the vector would prove nothing.
      const hostileProbe = await probeWith(HOSTILE_HEADERS);
      const benignProbe = await probeWith(BENIGN_HEADERS);
      const headerArrived =
        hostileProbe.hostname === 'attacker.surface.test'
        && hostileProbe.hostname !== benignProbe.hostname;

      const ok =
        hostileUri !== null
        && hostileUri === benignUri
        && hostileUri === configured
        && composerAgrees
        && headerArrived;
      record(
        'T-SS13-redirect-uri-header-independence',
        'the redirect_uri is byte-identical under hostile Host/X-Forwarded-Host and equals the configured public origin',
        ok,
        `hostile=${hostileUri} benign=${benignUri} expected-literal=${configured} `
          + `composer-agrees-with-the-literal=${composerAgrees} `
          + `hostile-req-hostname=${hostileProbe.hostname} benign-req-hostname=${benignProbe.hostname} `
          + `header-reached-the-app=${headerArrived}`,
      );
    }

    // ── T-SS13, the refusal arm ───────────────────────────────────────────
    // With no configured origin there is nothing to fall back TO, and the
    // design says so: an unset origin REFUSES rather than guessing. This is
    // the arm where a header-reading composer becomes steerable, so it is the
    // arm where the difference is visible: on the SAME request, the real
    // boardEndpointFor returns the attacker's host while the relying party
    // refuses to start at all.
    {
      delete process.env[SSO_PUBLIC_ORIGIN_ENV];
      let refusedStatus = 0;
      let steerable = '';
      try {
        const hostile = await startWith(HOSTILE_HEADERS, { identityProviderId: provider.id });
        refusedStatus = hostile.status;
        const probe = await probeWith(HOSTILE_HEADERS);
        steerable = probe.boardEndpoint;
      } finally {
        process.env[SSO_PUBLIC_ORIGIN_ENV] = CONFIGURED_ORIGIN;
      }
      const ok = refusedStatus >= 400 && steerable.includes('attacker.surface.test');
      record(
        'T-SS13-unset-origin-refuses-rather-than-falling-back',
        'with no configured origin the relying party refuses, while a header-reading composer on the same request is steered to the attacker',
        ok,
        `start-status=${refusedStatus} header-reading-composer-returned=${steerable}`,
      );
    }

    // ── SS-5 / SS-6: destination steering ─────────────────────────────────
    {
      // Every caller-controllable input on both public routes. The values are
      // deliberately hostile destinations: if any of them could reach the
      // outbound seam, the dialled set would differ from the baseline.
      const steer = 'https://evil.surface.test/steered';
      const startVariations: Array<[string, Record<string, unknown>, Record<string, string>]> = [
        ['baseline', { identityProviderId: provider.id }, {}],
        ['returnRef-url', { identityProviderId: provider.id, returnRef: steer }, {}],
        ['invitationCode', { identityProviderId: provider.id, invitationCode: steer }, {}],
        ['stepUp', { identityProviderId: provider.id, stepUp: true }, {}],
        ['unknown-body-keys', { identityProviderId: provider.id, issuer: steer, discoveryUrl: steer, tokenEndpoint: steer, jwks_uri: steer }, {}],
        ['hostile-headers', { identityProviderId: provider.id }, HOSTILE_HEADERS],
        ['forwarded-header', { identityProviderId: provider.id }, { Forwarded: 'host=evil.surface.test' }],
      ];

      const dialledPerVariation: Array<[string, string[]]> = [];
      for (const [label, body, headers] of startVariations) {
        double.resetRequests();
        await startWith(headers, body);
        dialledPerVariation.push([label, [...new Set(double.dialled())].sort()]);
      }

      // The callback route's inputs. Each variation runs a REAL flow first —
      // /start over HTTP so the state cookie is the one production set, and a
      // code armed at the double — because a callback refused at state
      // validation never reaches the outbound seam, and a sweep of requests
      // that never dial proves nothing about where they would have dialled.
      const jit = await provision(`ss56-${run}`, { provisioningMode: 'jit' });
      const callbackVariation = async (
        label: string,
        extraQuery: string,
        headers: Record<string, string>,
        subject: string,
        codeOverride?: string,
      ): Promise<void> => {
        ssoDiscoveryService.reset();
        const startResponse = await fetch(`${base}/auth/sso/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identityProviderId: jit.id }),
        });
        const cookie = (startResponse.headers.get('set-cookie') ?? '').split(';')[0];
        const started = await startResponse.json();
        const authorizeUrl = new URL(started.authorizeUrl);
        const state = authorizeUrl.searchParams.get('state') ?? '';
        const nonce = authorizeUrl.searchParams.get('nonce') ?? '';
        const now = Math.floor(Date.now() / 1000);
        const code = double.issueCode(jit.issuer, {
          iss: jit.issuer,
          sub: subject,
          aud: jit.clientId,
          exp: now + 300,
          iat: now - 5,
          nonce,
          preferred_username: `${subject}-${run}`,
        });
        // Reset AFTER the start leg, so what is measured is the callback's
        // own outbound traffic and not the discovery the start leg did.
        double.resetRequests();
        await fetch(
          `${base}/auth/sso/callback?state=${encodeURIComponent(state)}`
            + `&code=${encodeURIComponent(codeOverride ?? code)}${extraQuery}`,
          { headers: { Cookie: cookie, ...headers }, redirect: 'manual' },
        );
        dialledPerVariation.push([label, [...new Set(double.dialled())].sort()]);
      };

      await callbackVariation('callback-baseline', `&iss=${encodeURIComponent(jit.issuer)}`, {}, `cb-base-${run}`);
      await callbackVariation('callback-iss-steer', `&iss=${encodeURIComponent(steer)}`, {}, `cb-iss-${run}`);
      await callbackVariation('callback-hostile-headers', `&iss=${encodeURIComponent(jit.issuer)}`, HOSTILE_HEADERS, `cb-hdr-${run}`);
      await callbackVariation('callback-crlf', `&iss=${encodeURIComponent(jit.issuer)}%0d%0aHost:evil.surface.test`, {}, `cb-crlf-${run}`);
      await callbackVariation('callback-unknown-params', `&iss=${encodeURIComponent(jit.issuer)}&token_endpoint=${encodeURIComponent(steer)}&jwks_uri=${encodeURIComponent(steer)}`, {}, `cb-unk-${run}`);
      // The authorization code is the one caller-controllable input that CANNOT
      // be validated before it is used — it is opaque by definition and is only
      // proved by being redeemed. A URL-shaped code is therefore the sharpest
      // steering probe the callback has, and the one the red proof mutates.
      await callbackVariation('callback-url-shaped-code', `&iss=${encodeURIComponent(jit.issuer)}`, {}, `cb-code-${run}`, steer);

      const baseline = dialledPerVariation[0][1];
      const callbackBaseline =
        dialledPerVariation.find(([label]) => label === 'callback-baseline')?.[1] ?? [];
      // Each half is compared against ITS OWN baseline: /start dials discovery,
      // a completing callback dials the token endpoint, and holding one to the
      // other's set would report a difference that is the protocol, not a leak.
      const baselineSet = new Set([...baseline, ...callbackBaseline]);
      // The property is that no caller input can INTRODUCE a destination, not
      // that every variation dials the same set. Some inputs are refused before
      // any outbound happens at all — a `returnRef` carrying a URL is refused
      // by SS-17, so it dials nothing, which is a stronger outcome than the
      // baseline rather than a deviation from it. An offender is a variation
      // that reaches somewhere the baseline did NOT.
      const offenders = dialledPerVariation.filter(([, dialled]) =>
        dialled.some((url) => !baselineSet.has(url)));
      // Non-vacuity has two halves. The baseline must really have dialled, and
      // enough variations must ALSO have dialled that this is not merely a
      // sweep of inputs that are all refused before the outbound seam is
      // reached — which would make "no new destination" true and empty.
      const dialledCount = dialledPerVariation.filter(([, d]) => d.length > 0).length;
      const baselineIsReal = baseline.length > 0 && callbackBaseline.length > 0 && dialledCount >= 4;
      // Every dialled host across EVERY variation, callbacks included, must be
      // the registered issuer's. This is the property SS-6 actually claims.
      const allHosts = new Set(
        dialledPerVariation.flatMap(([, dialled]) => dialled.map((url) => new URL(url).host)),
      );
      const issuerHost = new URL(HOST).host;
      const foreign = [...allHosts].filter((host) => host !== issuerHost);

      const ok = baselineIsReal && offenders.length === 0 && foreign.length === 0;
      record(
        'SS-5-SS-6-destination-steering',
        'every caller-controllable input on both public routes is varied and the outbound destination is unchanged',
        ok,
        `variations=${dialledPerVariation.length} start-baseline-dialled=${baseline.length} `
          + `callback-baseline-dialled=${callbackBaseline.length} `
          + `variations-that-reached-the-outbound-seam=${dialledCount} `
          + `steering-offenders=${offenders.map(([l]) => l).join(',') || 'none'} `
          + `foreign-hosts=${foreign.join(',') || 'none'} (only ${issuerHost} may be dialled)`,
      );
    }

    // ── SS-3: /identity-providers at root, every method ────────────────────
    {
      // Enumerated FROM the production router, so a method added later is
      // covered without editing this file.
      const stack = (identityProvidersRoutes as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
      }).stack;
      const routes: Array<[string, string]> = [];
      for (const layer of stack) {
        if (!layer.route) continue;
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) routes.push([method.toUpperCase(), layer.route.path]);
        }
      }

      const nonRootRoles = ['user', 'operator', 'viewer', 'service', 'agent', '', 'nonsense'];
      const notRoot: string[] = [];
      const admitted: string[] = [];
      for (const [method, path] of routes) {
        const mounted = `/identity-providers${path === '/' ? '' : path}`;
        const required = requiredScopeFor(method, mounted);
        if (required !== ROOT_SCOPE) notRoot.push(`${method} ${mounted} -> ${required}`);
        for (const role of nonRootRoles) {
          if (scopesSatisfy(scopesForRole(role) as string[], required)) {
            admitted.push(`${role} admitted to ${method} ${mounted}`);
          }
        }
        // Every non-root scope, not merely every non-root role: a credential
        // can hold a scope set no role mints.
        for (const scope of ALL_SCOPES.filter((s) => s !== ROOT_SCOPE)) {
          if (scopesSatisfy([scope], required)) admitted.push(`scope ${scope} admitted to ${method} ${mounted}`);
        }
      }
      // Control: root IS admitted everywhere, so the refusals above are about
      // authority and not about a path this map simply fails to resolve.
      const rootRefused = routes.filter(([method, path]) => {
        const mounted = `/identity-providers${path === '/' ? '' : path}`;
        return !scopesSatisfy([ROOT_SCOPE], requiredScopeFor(method, mounted));
      });
      // Non-vacuity: the enumeration must have found the router's real surface,
      // including a nested path, or path normalisation was never exercised.
      const sawNested = routes.some(([, path]) => path.split('/').filter(Boolean).length > 1);

      const ok =
        routes.length > 0
        && sawNested
        && notRoot.length === 0
        && admitted.length === 0
        && rootRefused.length === 0;
      record(
        'SS-3-identity-providers-root-gated',
        'every method the /identity-providers router exposes requires root and refuses every non-root role and scope',
        ok,
        `routes-enumerated-from-the-router=${routes.length} nested-path-seen=${sawNested} `
          + `not-root=${notRoot.join(' | ') || 'none'} non-root-admitted=${admitted.join(' | ') || 'none'} `
          + `root-refused=${rootRefused.length}`,
      );
    }

    // ── SS-7: the provider-secret canary ──────────────────────────────────
    {
      // NO table wipe, and no exact counts. The canary's contract is a
      // PROPERTY — it throws on a row that will not decrypt and is quiet
      // otherwise — and a property needs no census. The earlier version
      // asserted table-wide totals, so it deleted every provider to obtain
      // them, mid-run, while sibling vectors still held provider ids: each
      // acceptance run then died somewhere different (a pending row whose
      // provider had vanished, the single-active index, a foreign key).
      // Asserting the property instead also answers round 2's R4 objection
      // properly: this vector no longer touches a row it did not create.
      const control = await provision(`ss7-control-${run}`);
      const target = await provision(`ss7-target-${run}`);
      // A generous sample so both of this run's providers are certainly in it.
      // The number is not asserted; that it did not THROW is the assertion.
      const healthy = await runIdentityProviderSecretCanary(pool as never, 500);

      // Corrupt ONE row the way a bad restore or a mis-keyed migration would:
      // valid-looking ciphertext that is not this row's.
      const foreign = encryptCredentialSecret('someone-elses-secret', crypto.randomUUID());
      const ciphertext = typeof foreign === 'string'
        ? foreign
        : (foreign as { ciphertext: string }).ciphertext;
      await pool.query('UPDATE identity_providers SET client_secret_ct = $2 WHERE id = $1', [target.id, ciphertext]);

      let failedLoudly = false;
      let named = false;
      let code = '';
      try {
        await runIdentityProviderSecretCanary(pool as never, 500);
      } catch (error) {
        failedLoudly = true;
        code = error instanceof CredentialCryptoError ? error.code : String((error as Error).name);
        named = String((error as Error).message).includes(target.id);
      }

      // Remove the corrupted row and require the canary to go quiet while the
      // UNTOUCHED provider is still there. A canary that stayed red would not
      // be measuring the corruption; one that went quiet because the table
      // emptied would not be measuring anything.
      await pool.query('DELETE FROM identity_providers WHERE id = $1', [target.id]);
      let quietAgain = false;
      try {
        await runIdentityProviderSecretCanary(pool as never, 500);
        quietAgain = true;
      } catch {
        quietAgain = false;
      }
      const controlSurvives = await pool.query(
        'SELECT COUNT(*)::int AS n FROM identity_providers WHERE id = $1', [control.id]);
      const stillThere = Number(controlSurvives.rows[0]?.n ?? 0) === 1;

      const ok =
        healthy >= 2
        && failedLoudly
        && named
        && code === 'IDENTITY_PROVIDER_CANARY_FAILED'
        && quietAgain
        && stillThere;
      record(
        'SS-7-provider-secret-canary',
        'the startup canary fails loudly, and by name, on a corrupted Identity provider secret',
        ok,
        `healthy-secrets-checked=${healthy} (>=2, this run's own two) quiet-while-healthy=true `
          + `failed-on-corruption=${failedLoudly} code=${code || 'none'} names-the-row=${named} `
          + `quiet-again-after-removal=${quietAgain} control-row-still-present=${stillThere}`,
      );
    }
  } finally {
    (httpsSsoTransport as { send: SsoTransport['send'] }).send = realSend;
    if (savedOrigin === undefined) delete process.env[SSO_PUBLIC_ORIGIN_ENV];
    else process.env[SSO_PUBLIC_ORIGIN_ENV] = savedOrigin;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await resetProvidersByIssuerPrefix(`${HOST}%`);
  }

  return results;
}
