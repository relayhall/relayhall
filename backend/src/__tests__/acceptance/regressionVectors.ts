/**
 * Regression vectors for the four blocking defects round-1 review found.
 *
 * Each of these was REPRODUCED by a reviewer against production code before it
 * was repaired, so each one below is red against the parent commit and green
 * against the repair. They live together because what they have in common is
 * their provenance, not their subsystem: they are the wave's proof that the
 * round-1 findings cannot silently return.
 *
 *   - **R1 B1** — the missing-keyset refusal counted only Account credentials,
 *     so a deployment holding federated providers and no encrypted Account
 *     credentials warned and continued with its provider secrets unreachable.
 *   - **R2 F1** — a provider-error callback refused BEFORE the pending row was
 *     consumed, leaving a live row that could be attempted again. SS-18 says
 *     the row is consumed on the ATTEMPT, and an error callback is an attempt.
 *   - **R2 F2** — the step-up `auth_time` comparison added clock skew to
 *     `auth_time`, accepting an authentication up to a full skew window BEFORE
 *     the request that was supposed to force it.
 *   - **R2 F3** — the logout-token validator never read `nbf`, so a correctly
 *     signed token explicitly not yet valid was consumed and could revoke
 *     sessions.
 */
import crypto from 'crypto';
import path from 'path';
import { spawnSync } from 'child_process';
import { pool } from '../../db/connection';
import { resetProvidersByIssuerPrefix } from './resetProviders';
import type { AuditActor } from '../../services/AuditService';
import { validateIdToken, validateLogoutToken } from '../../services/identity/idTokenValidation';
import { identityLinkService } from '../../services/identity/IdentityLinkService';
import { principalService } from '../../services/PrincipalService';
import {
  identityProviderService,
  type IdentityProvider,
} from '../../services/identity/IdentityProviderService';
import { SsoAuthenticationService } from '../../services/identity/SsoAuthenticationService';
import { SsoDiscoveryService } from '../../services/identity/SsoDiscoveryService';
import { ProviderDouble } from '../conformance/providerDouble';
import type { VectorResult } from './vectors';

const ACTOR = { principalId: null, handle: 'regression-vectors', authMethod: 'system' } as unknown as AuditActor;
const HOST = 'https://idp.regression.test';

export async function runRegressionVectors(): Promise<VectorResult[]> {
  const results: VectorResult[] = [];
  const record = (id: string, claim: string, ok: boolean, detail: string): void => {
    results.push({ id, claim, ok, detail });
  };

  const double = new ProviderDouble();
  const discovery = new SsoDiscoveryService(double);
  const service = new SsoAuthenticationService(discovery, double);
  const run = crypto.randomBytes(4).toString('hex');

  await resetProvidersByIssuerPrefix(`${HOST}%`);

  const provision = async (slug: string, config: Record<string, unknown> = {}): Promise<IdentityProvider> => {
    const issuer = `${HOST}/${slug}`;
    double.register({ issuer, clientId: `client-${slug}` });
    await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active'");
    return identityProviderService.create(
      {
        name: `Regression ${slug}`,
        issuer,
        clientId: `client-${slug}`,
        clientSecret: 'regression-secret',
        subjectImmutable: true,
        status: 'active',
        provisioningMode: 'jit',
        ...config,
      } as never,
      ACTOR,
    );
  };

  // These vectors measure the TIME checks, so the signing key is taken
  // straight from the double rather than through the discovery cache: routing
  // it through discovery made every one of them fail at KID_UNRESOLVED before
  // reaching the comparison under test.
  // resolveKey returns a JWK, not a KeyObject: handing back a KeyObject made
  // every token fail SIGNATURE_INVALID before reaching the time comparison.
  const keyResolverFor = (issuer: string) => async (): Promise<crypto.JsonWebKey> =>
    double.get(issuer).publicJwk;

  const refusalOf = async (action: () => Promise<unknown>): Promise<string> => {
    try {
      await action();
      return '<accepted>';
    } catch (error) {
      return String((error as { code?: unknown }).code ?? (error as Error).message);
    }
  };

  try {
    // ── F1: an error callback is an ATTEMPT, so the row is consumed ────────
    {
      const provider = await provision(`f1-${run}`);
      const started = await service.startAuthentication({ identityProviderId: provider.id });
      const state = new URL(started.authorizeUrl).searchParams.get('state') ?? '';

      const first = await refusalOf(() => service.completeAuthentication({
        state, code: null, iss: null, error: 'access_denied',
        errorDescription: 'the user said no', cookieState: state,
      }));
      // The property: a SECOND attempt on the same state must find the row
      // gone. Before the repair it found it live.
      const second = await refusalOf(() => service.completeAuthentication({
        state, code: null, iss: null, error: 'access_denied',
        errorDescription: 'replayed', cookieState: state,
      }));

      // Round 2 found the half this vector could not see: it used a MATCHING
      // cookie only, so it could not detect that the provider-error arm ran
      // before the browser binding. An unbound callback carrying a provider
      // error must refuse as a COOKIE mismatch, not as a provider error —
      // otherwise we answer an unbound browser about the provider.
      const startedMissing = await service.startAuthentication({ identityProviderId: provider.id });
      const stateMissing = new URL(startedMissing.authorizeUrl).searchParams.get('state') ?? '';
      const missingCookie = await refusalOf(() => service.completeAuthentication({
        state: stateMissing, code: null, iss: null, error: 'access_denied',
        errorDescription: 'no cookie', cookieState: null,
      }));

      const startedWrong = await service.startAuthentication({ identityProviderId: provider.id });
      const stateWrong = new URL(startedWrong.authorizeUrl).searchParams.get('state') ?? '';
      const wrongCookie = await refusalOf(() => service.completeAuthentication({
        state: stateWrong, code: null, iss: null, error: 'access_denied',
        errorDescription: 'another browser', cookieState: 'not-the-state',
      }));

      const ok = first === 'SSO_PROVIDER_ERROR'
        && second === 'SSO_STATE_UNKNOWN'
        && missingCookie === 'SSO_COOKIE_MISMATCH'
        && wrongCookie === 'SSO_COOKIE_MISMATCH';
      record(
        'R2-F1-provider-error-consumes-the-pending-row',
        'a provider-error callback consumes the pending row (SS-18) and is refused as a COOKIE mismatch when the browser is not bound (T-SS3)',
        ok,
        `matching-cookie=${first} (expected SSO_PROVIDER_ERROR) replay=${second} (expected SSO_STATE_UNKNOWN) `
          + `missing-cookie=${missingCookie} wrong-cookie=${wrongCookie} (both expected SSO_COOKIE_MISMATCH)`,
      );
    }

    // ── F2: auth_time must post-date the request, skew notwithstanding ─────
    {
      const provider = await provision(`f2-${run}`);
      const requestedAt = new Date();
      const nowSeconds = Math.floor(requestedAt.getTime() / 1000);
      const mint = (authTimeOffset: number): string => double.signIdToken(provider.issuer, {
        iss: provider.issuer, sub: `f2-${run}`, aud: provider.clientId,
        exp: nowSeconds + 300, iat: nowSeconds - 5, nonce: 'n',
        auth_time: nowSeconds + authTimeOffset,
      });
      const validate = (token: string) => validateIdToken({
        token, issuer: provider.issuer, clientId: provider.clientId,
        clockSkewSeconds: 60,
        advertisedAlgs: ['RS256'],
        resolveKey: keyResolverFor(provider.issuer),
        hashNonce: (value: string) => crypto.createHash('sha256').update(value).digest('hex'),
        expectedNonceHash: crypto.createHash('sha256').update('n').digest('hex'),
        maxAgeRequested: 0,
        requestedAt,
      } as never);

      // 30 seconds BEFORE the request, well inside the 60s skew that used to
      // wave it through.
      const before = await refusalOf(() => validate(mint(-30)));
      // The control: an authentication AFTER the request is still accepted, so
      // the refusal is about ordering and not about rejecting everything.
      const after = await refusalOf(() => validate(mint(+5)));

      const ok = before === 'AUTH_TIME_STALE' && after === '<accepted>';
      record(
        'R2-F2-step-up-auth-time-has-no-skew-allowance',
        'an auth_time inside the clock skew but BEFORE the step-up request is refused; one after it is accepted',
        ok,
        `thirty-seconds-before=${before} (expected AUTH_TIME_STALE) five-seconds-after=${after} (expected accepted)`,
      );
    }

    // ── F3: a logout token honours nbf ─────────────────────────────────────
    {
      const provider = await provision(`f3-${run}`);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const mint = (nbfOffset: number | null): string => double.signIdToken(provider.issuer, {
        iss: provider.issuer, sub: `f3-${run}`, aud: provider.clientId,
        exp: nowSeconds + 300, iat: nowSeconds - 5,
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
        ...(nbfOffset === null ? {} : { nbf: nowSeconds + nbfOffset }),
      });
      const validate = (token: string) => validateLogoutToken({
        token, issuer: provider.issuer, clientId: provider.clientId,
        clockSkewSeconds: 60,
        advertisedAlgs: ['RS256'],
        resolveKey: keyResolverFor(provider.issuer),
      } as never);

      const future = await refusalOf(() => validate(mint(3600)));
      // Two controls: no nbf at all is legitimate, and an nbf already in the
      // past is legitimate. Without them "the future one was refused" could be
      // true of a validator that refuses every logout token.
      const absent = await refusalOf(() => validate(mint(null)));
      const past = await refusalOf(() => validate(mint(-120)));

      const ok = future === 'TIME_WINDOW' && absent === '<accepted>' && past === '<accepted>';
      record(
        'R2-F3-logout-token-honours-nbf',
        'a logout token whose nbf is in the future is refused; absent and past nbf are still accepted',
        ok,
        `nbf-one-hour-ahead=${future} (expected TIME_WINDOW) nbf-absent=${absent} nbf-two-minutes-ago=${past}`,
      );
    }

    // ── R2-B1: an empty advertised-algorithm set advertises NOTHING ───────
    {
      const provider = await provision(`alg-${run}`);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const token = double.signIdToken(provider.issuer, {
        iss: provider.issuer, sub: `alg-${run}`, aud: provider.clientId,
        exp: nowSeconds + 300, iat: nowSeconds - 5, nonce: 'n',
      });
      const validate = (advertised: string[]) => validateIdToken({
        token, issuer: provider.issuer, clientId: provider.clientId,
        clockSkewSeconds: 60,
        advertisedAlgs: advertised,
        resolveKey: keyResolverFor(provider.issuer),
        hashNonce: (value: string) => crypto.createHash('sha256').update(value).digest('hex'),
        expectedNonceHash: crypto.createHash('sha256').update('n').digest('hex'),
      } as never);

      // The defect: a document with no `id_token_signing_alg_values_supported`
      // maps to [], and the check used to be skipped entirely for an empty set.
      const emptyAdvertised = await refusalOf(() => validate([]));
      // Two controls, so the refusal is about the ADVERTISEMENT and not about
      // the validator rejecting everything: the advertised algorithm is
      // accepted, and one that is allowlisted but NOT advertised is refused.
      const advertised = await refusalOf(() => validate(['RS256']));
      const notAdvertised = await refusalOf(() => validate(['RS512']));

      const ok = emptyAdvertised === 'ALG_NOT_ALLOWED'
        && advertised === '<accepted>'
        && notAdvertised === 'ALG_NOT_ALLOWED';
      record(
        'R2-B1-empty-advertised-algs-refuses',
        'a provider that advertises no signing algorithms has none accepted (5.3 refusal 1)',
        ok,
        `advertised-empty=${emptyAdvertised} (expected ALG_NOT_ALLOWED) `
          + `advertised-RS256=${advertised} (expected accepted) `
          + `advertised-RS512-only=${notAdvertised} (expected ALG_NOT_ALLOWED)`,
      );
    }

    // ── R1-B1 / R3-B2: deleting a provider must not destroy its links ─────
    {
      const provider = await provision(`del-${run}`);
      const account = await principalService.createPrincipal({
        handle: `del-account-${run}`, kind: 'human', displayName: 'deletion vector', role: 'user',
      });
      if (!account) throw new Error('could not create the account for the deletion vector');
      const link = await identityLinkService.establishProven({
        accountPrincipalId: account.id,
        identityProviderId: provider.id,
        subject: `del-subject-${run}`,
      });

      // 1 · a provider that owns a link REFUSES deletion, by name.
      const refused = await refusalOf(() => identityProviderService.remove(provider.id, ACTOR));

      // 2 · and the link is still there, with its history — the whole point.
      const linkStill = await pool.query(
        'SELECT count(*)::int AS n FROM identity_links WHERE id = $1', [link.id]);
      const linkSurvives = Number(linkStill.rows[0]?.n ?? 0) === 1;

      // 3 · the database FK is the floor under that refusal: a direct DELETE,
      // with the service out of the picture, is refused too.
      let databaseRefused = false;
      try {
        await pool.query('DELETE FROM identity_providers WHERE id = $1', [provider.id]);
      } catch {
        databaseRefused = true;
      }

      // 4 · the control: a provider that never linked anyone CAN be deleted,
      // so the refusal is about dependent data and not about deletion itself.
      const disposable = await provision(`del-empty-${run}`);
      const emptyDeleted = await refusalOf(() => identityProviderService.remove(disposable.id, ACTOR));

      const ok = refused === 'PROVIDER_HAS_IDENTITY_LINKS'
        && linkSurvives
        && databaseRefused
        && emptyDeleted === '<accepted>';
      record(
        'R1-B1-R3-B2-provider-deletion-preserves-identity-links',
        'a provider that owns Identity links refuses deletion at BOTH the service and the database; one that owns none can still be deleted',
        ok,
        `service-refusal=${refused} (expected PROVIDER_HAS_IDENTITY_LINKS) link-survives=${linkSurvives} `
          + `database-also-refused=${databaseRefused} empty-provider-deleted=${emptyDeleted} (expected accepted)`,
      );
    }

    // ── B1: the missing-keyset refusal sees provider secrets ──────────────
    //
    // GUARDED, and the reason matters. This vector spawns a REAL server from
    // the current source tree, so ANY mutation the red-proof driver applies
    // anywhere can break that startup - and then B1 fails, the suite goes red,
    // and the driver reports "the vectors failed, but not at <the vector I was
    // proving>". A startup vector cannot live inside a suite that is re-run
    // under arbitrary mutations. It is its own gate:
    //
    //   W2_STARTUP_VECTOR=1 node scripts/w2-acceptance.js
    //
    // and it is recorded as its own line in the evidence rather than hidden in
    // the vector count.
    if (process.env.W2_STARTUP_VECTOR === '1') {
      // Driven through the REAL startup path as a subprocess, because the
      // defect was in startup control flow: an in-process assertion about the
      // condition would be a copy of the code under test.
      const provider = await provision(`b1-${run}`);
      const backend = path.resolve(__dirname, '..', '..', '..');
      // NOT the boot check: RELAYHALL_BOOT_CHECK=1 performs no database
      // activity by design, so it never reaches the startup canary and could
      // not fail this. This drives the real startup. A refusal exits non-zero
      // in a second or two; a healthy start keeps running until the timeout,
      // and that timeout IS the control.
      const startup = (withKeyset: boolean, port: string) => {
        const env = { ...process.env, PORT: port };
        delete env.RELAYHALL_BOOT_CHECK;
        if (!withKeyset) {
          delete env.RELAYHALL_CREDENTIAL_KEYS;
          delete env.RELAYHALL_CREDENTIAL_ACTIVE_KEY;
        }
        // node DIRECTLY, with tsx as a loader — never the tsx CLI. The CLI runs
        // the program as a CHILD process, so the timeout's SIGKILL killed only
        // the wrapper and every healthy-arm server survived as an orphan: a
        // full backend with a pg pool, webhook workers writing to the test
        // database, and a held port. Sixty-eight of them accumulated before
        // this was found, and they were the entire "too many clients" /
        // port-collision / post-restore-flakiness tangle.
        const result = spawnSync(
          process.execPath,
          ['--import', 'tsx', path.join(backend, 'src', 'server.ts')],
          { cwd: backend, env, encoding: 'utf8', timeout: 25000, killSignal: 'SIGKILL' },
        );
        return {
          status: result.status,
          timedOut: result.error !== undefined && String(result.error).includes('ETIMEDOUT'),
          signal: result.signal,
          output: `${result.stdout || ''}${result.stderr || ''}`,
        };
      };

      // Unique ports per run. Fixed ones made this vector flaky: the healthy
      // arm is deliberately SIGKILLed at the timeout, and the socket outlives
      // the process long enough that the next run could not bind and exited 1,
      // which reads exactly like a refusal.
      const portBase = 20000 + (crypto.randomBytes(2).readUInt16BE(0) % 20000);
      const withoutKeyset = startup(false, String(portBase));
      const withKeyset = startup(true, String(portBase + 1));

      // Asserted on the LOG PREFIX, not the thrown message: the message goes
      // through secret-safe logging, which redacts it by design.
      const namedTheCanary = /CredentialCanary.*startup check FAILED/is.test(withoutKeyset.output);
      const refused = withoutKeyset.status !== null && withoutKeyset.status !== 0 && namedTheCanary;
      // Healthy start = it was still running when the timeout killed it.
      const startedCleanly = withKeyset.status === null || withKeyset.signal !== null;
      const ok = refused && startedCleanly;
      record(
        'R1-B1-missing-keyset-refuses-on-provider-secrets',
        'startup refuses when an Identity provider secret exists and the envelope keyset does not, and still starts when it does',
        ok,
        `provider-secret-present=${provider.id.slice(0, 8)} without-keyset-exit=${withoutKeyset.status} `
          + `(expected non-zero) named-the-canary=${namedTheCanary} `
          + `with-keyset: exit=${withKeyset.status} signal=${withKeyset.signal} `
          + `(expected to still be running when killed)`,
      );
    }
  } finally {
    await resetProvidersByIssuerPrefix(`${HOST}%`);
  }

  return results;
}
