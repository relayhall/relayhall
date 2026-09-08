/**
 * The SS-W2 behavioural acceptance vectors (annex `e6dcadb9` §11 W2 DoD and
 * the §11a coverage matrix), against a real migrated PostgreSQL through the
 * production services.
 *
 * These are the DoD bullets the conformance gate does not cover, because they
 * are not about provider-agnosticism — they are about what the relying party
 * does under concurrency, under expiry, and under a hostile logout token:
 *
 *   - **concurrency** — two simultaneous callbacks on one
 *     `sso_authentication_requests` row: exactly one succeeds (SS-18, T-SS10c);
 *   - **between-sweep replay** — an expired pending row is refused at
 *     consumption WITH THE SWEEP DISABLED, because expiry is evaluated live in
 *     the consuming statement and never left to a sweep that might stop;
 *   - **the sweep, both directions** — eligible rows go, live rows survive;
 *   - **logout isolation** — the four two-provider × two-subject vectors of
 *     §8.2 (SS-19, T-SS10);
 *   - **SS-23 replay**, including the boundary vector a single-replay test
 *     cannot reach: a token still inside its own validity must still be
 *     refused after a sweep has run.
 *
 * Nothing here is doubled except the Identity provider itself, at the one
 * outbound seam. The pending rows, the sessions, the links and the replay rows
 * are real rows written by production code.
 */
import crypto from 'crypto';
import { pool } from '../../db/connection';
import { resetProvidersByIssuerPrefix } from './resetProviders';
import type { AuditActor } from '../../services/AuditService';
import { identityProviderService, type IdentityProvider } from '../../services/identity/IdentityProviderService';
import { SsoAuthenticationService } from '../../services/identity/SsoAuthenticationService';
import { SsoDiscoveryService } from '../../services/identity/SsoDiscoveryService';
import { SsoLogoutService } from '../../services/identity/SsoLogoutService';
import {
  ssoAuthenticationRequestService,
  hashOpaqueValue,
} from '../../services/identity/SsoAuthenticationRequestService';
import { ProviderDouble } from '../conformance/providerDouble';

const ACTOR = { principalId: null, handle: 'acceptance-vectors', authMethod: 'system' } as unknown as AuditActor;
const HOST = 'https://idp.acceptance.test';

export interface VectorResult {
  id: string;
  claim: string;
  ok: boolean;
  detail: string;
}

export interface AcceptanceResult {
  ok: boolean;
  results: VectorResult[];
}

export async function runAcceptanceVectors(): Promise<AcceptanceResult> {
  const results: VectorResult[] = [];
  const record = (id: string, claim: string, ok: boolean, detail: string): void => {
    results.push({ id, claim, ok, detail });
  };

  const double = new ProviderDouble();
  const discovery = new SsoDiscoveryService(double);
  const service = new SsoAuthenticationService(discovery, double);
  const logout = new SsoLogoutService(discovery);
  const run = crypto.randomBytes(4).toString('hex');

  await resetProvidersByIssuerPrefix(`${HOST}%`);

  const provision = async (slug: string, config: Record<string, unknown> = {}): Promise<IdentityProvider> => {
    const issuer = `${HOST}/${slug}`;
    double.register({ issuer, clientId: `client-${slug}` });
    await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active'");
    return identityProviderService.create(
      {
        name: `Acceptance ${slug}`,
        issuer,
        clientId: `client-${slug}`,
        clientSecret: 'acceptance-secret',
        subjectImmutable: true,
        status: 'active',
        provisioningMode: 'jit',
        backchannelLogoutEnabled: true,
        ...config,
      } as never,
      ACTOR,
    );
  };

  const activate = async (provider: IdentityProvider): Promise<void> => {
    await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active'");
    await pool.query("UPDATE identity_providers SET status = 'active' WHERE id = $1", [provider.id]);
  };

  /** A real login through the production entry point. */
  const login = async (provider: IdentityProvider, subject: string, sid?: string) => {
    double.resetRequests();
    discovery.reset();
    const started = await service.startAuthentication({ identityProviderId: provider.id });
    const url = new URL(started.authorizeUrl);
    const state = url.searchParams.get('state') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';
    const now = Math.floor(Date.now() / 1000);
    const code = double.issueCode(provider.issuer, {
      iss: provider.issuer,
      sub: subject,
      aud: provider.clientId,
      exp: now + 300,
      iat: now - 5,
      nonce,
      // Per PROVIDER, not per subject: the isolation vectors deliberately use
      // the SAME subject string at two Identity providers, and jit provisioning
      // would otherwise derive one handle for both and refuse the second login
      // with SSO_HANDLE_COLLISION - correct behaviour, wrong thing to trip over
      // while testing logout scope.
      preferred_username: `${subject}-${provider.clientId}-${run}`,
      ...(sid ? { sid } : {}),
    });
    return service.completeAuthentication({ state, code, iss: provider.issuer, cookieState: state });
  };

  const liveSessions = async (providerId: string, subject: string): Promise<number> => {
    const result = await pool.query(
      `SELECT count(*)::int AS n FROM auth_sessions s
         JOIN identity_links l ON l.id = s.identity_link_id
        WHERE s.revoked_at IS NULL AND s.identity_provider_id = $1 AND l.subject = $2`,
      [providerId, subject],
    );
    return Number(result.rows[0].n);
  };

  // ── SS-18 / T-SS10c — two simultaneous callbacks, exactly ONE wins ──────
  {
    const provider = await provision('concurrency');
    const started = await service.startAuthentication({ identityProviderId: provider.id });
    const state = new URL(started.authorizeUrl).searchParams.get('state') ?? '';
    // Both consume attempts issued together, against the one row.
    const [first, second] = await Promise.all([
      ssoAuthenticationRequestService.consume(state),
      ssoAuthenticationRequestService.consume(state),
    ]);
    const winners = [first, second].filter((outcome) => outcome !== undefined).length;
    record(
      'SS-18-concurrency',
      'two simultaneous callbacks on one pending row: exactly one succeeds',
      winners === 1,
      `winners=${winners} (the loser must see zero rows, not an error)`,
    );
  }

  // ── SS-18 — between-sweep replay, WITH THE SWEEP DISABLED ──────────────
  {
    const provider = await provision('between-sweep');
    const started = await service.startAuthentication({ identityProviderId: provider.id });
    const state = new URL(started.authorizeUrl).searchParams.get('state') ?? '';
    // Age the row past its expiry WITHOUT running any sweep.
    await pool.query(
      `UPDATE sso_authentication_requests SET expires_at = now() - interval '1 minute' WHERE state_hash = $1`,
      [hashOpaqueValue(state)],
    );
    const consumed = await ssoAuthenticationRequestService.consume(state);
    const stillThere = await pool.query('SELECT count(*)::int AS n FROM sso_authentication_requests WHERE state_hash = $1', [
      hashOpaqueValue(state),
    ]);
    record(
      'SS-18-between-sweep-replay',
      'an expired pending row is refused at consumption with the sweep disabled',
      consumed === undefined && Number(stillThere.rows[0].n) === 1,
      `consumed=${consumed !== undefined}, row still present=${stillThere.rows[0].n} (expiry is evaluated LIVE, not by the sweep)`,
    );
  }

  // ── SS-18 — the sweep, BOTH directions ─────────────────────────────────
  {
    const provider = await provision('sweep');
    const deadStart = await service.startAuthentication({ identityProviderId: provider.id });
    const deadState = new URL(deadStart.authorizeUrl).searchParams.get('state') ?? '';
    await pool.query(
      `UPDATE sso_authentication_requests SET expires_at = now() - interval '1 hour' WHERE state_hash = $1`,
      [hashOpaqueValue(deadState)],
    );
    const liveStart = await service.startAuthentication({ identityProviderId: provider.id });
    const liveState = new URL(liveStart.authorizeUrl).searchParams.get('state') ?? '';

    await ssoAuthenticationRequestService.sweep();

    const deadRows = await pool.query('SELECT count(*)::int AS n FROM sso_authentication_requests WHERE state_hash = $1', [
      hashOpaqueValue(deadState),
    ]);
    const liveRows = await pool.query('SELECT count(*)::int AS n FROM sso_authentication_requests WHERE state_hash = $1', [
      hashOpaqueValue(liveState),
    ]);
    record(
      'SS-18-sweep-both-directions',
      'the sweep removes eligible rows and leaves live ones untouched',
      Number(deadRows.rows[0].n) === 0 && Number(liveRows.rows[0].n) === 1,
      `expired removed=${deadRows.rows[0].n === 0}, live survived=${liveRows.rows[0].n === 1}`,
    );
  }

  // ── §8.2 / SS-19 / T-SS10 — the FOUR logout-isolation vectors ──────────
  //
  // Two Identity providers x two subjects. SS-14a permits only one ACTIVE
  // provider, so B's sessions are established while B is active and then
  // survive B being disabled — which is exactly the shape a real deployment
  // has after a provider swap, and it does not weaken the isolation claim: the
  // question is whether A's token can reach a session A did not prove.
  {
    const providerB = await provision('logout-b');
    await login(providerB, 'shared-subject', `sid-b-${run}`);
    await login(providerB, 'other-subject', `sid-b2-${run}`);

    const providerA = await provision('logout-a');
    await login(providerA, 'shared-subject', `sid-a-${run}`);
    await login(providerA, 'other-subject', `sid-a2-${run}`);
    await activate(providerA);

    const claims = (extra: Record<string, unknown>): Record<string, unknown> => {
      const now = Math.floor(Date.now() / 1000);
      return {
        iss: providerA.issuer,
        aud: providerA.clientId,
        iat: now,
        exp: now + 120,
        jti: crypto.randomUUID(),
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
        ...extra,
      };
    };

    // (1) A's `sid` token revokes exactly A's session for that sid.
    const beforeA = await liveSessions(providerA.id, 'shared-subject');
    await logout.backchannelLogout(double.signIdToken(providerA.issuer, claims({ sid: `sid-a-${run}` })));
    const afterA = await liveSessions(providerA.id, 'shared-subject');
    record(
      'T-SS10-vector-1',
      "A's sid token revokes exactly A's session for that sid",
      beforeA === 1 && afterA === 0,
      `A shared-subject sessions ${beforeA} -> ${afterA}`,
    );

    // (2) A's `sub`-only token revokes exactly A's sessions for that subject.
    const beforeOtherA = await liveSessions(providerA.id, 'other-subject');
    await logout.backchannelLogout(double.signIdToken(providerA.issuer, claims({ sub: 'other-subject' })));
    const afterOtherA = await liveSessions(providerA.id, 'other-subject');
    record(
      'T-SS10-vector-2',
      "A's sub-only token revokes exactly A's sessions for that subject",
      beforeOtherA === 1 && afterOtherA === 0,
      `A other-subject sessions ${beforeOtherA} -> ${afterOtherA}`,
    );

    // (3) NEITHER touched B's sessions for the same subject strings. This is
    // the isolation claim, and SS-19 makes it structural: identity_provider_id
    // is in the WHERE clause, so B's rows were never in scope.
    const bShared1 = await liveSessions(providerB.id, 'shared-subject');
    const bOther1 = await liveSessions(providerB.id, 'other-subject');
    record(
      'T-SS10-vector-3',
      "neither token touched B's sessions for the same subject strings",
      bShared1 === 1 && bOther1 === 1,
      `B shared-subject=${bShared1}, B other-subject=${bOther1} (both must remain 1)`,
    );

    // (4) A token whose `iss` names no configured provider revokes nothing.
    const unknownIssuer = `${HOST}/never-configured`;
    double.register({ issuer: unknownIssuer, clientId: 'client-unknown' });
    let refusal = '<accepted>';
    try {
      await logout.backchannelLogout(
        double.signIdToken(unknownIssuer, {
          iss: unknownIssuer,
          aud: 'client-unknown',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 120,
          jti: crypto.randomUUID(),
          sub: 'shared-subject',
          events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
        }),
      );
    } catch (error) {
      refusal = String((error as { code?: unknown }).code ?? (error as Error).message);
    }
    const bStillThere = await liveSessions(providerB.id, 'shared-subject');
    record(
      'T-SS10-vector-4',
      'a token whose iss names no configured Identity provider revokes nothing at all',
      refusal === 'LOGOUT_ISSUER_UNKNOWN' && bStillThere === 1,
      `refusal=${refusal}, B shared-subject sessions still ${bStillThere}`,
    );
  }

  // ── SS-23 — replay, maximum age, and the swept-but-still-valid boundary ─
  {
    const provider = await provision('replay');
    await login(provider, 'replay-subject', `sid-replay-${run}`);
    const now = Math.floor(Date.now() / 1000);
    const jti = crypto.randomUUID();
    const token = double.signIdToken(provider.issuer, {
      iss: provider.issuer,
      aud: provider.clientId,
      iat: now,
      exp: now + 120,
      jti,
      sub: 'replay-subject',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    });

    await logout.backchannelLogout(token);
    let replayRefusal = '<accepted>';
    try {
      await logout.backchannelLogout(token);
    } catch (error) {
      replayRefusal = String((error as { code?: unknown }).code ?? '');
    }
    record(
      'SS-23-replay',
      'a replayed logout token is accepted once and refused thereafter',
      replayRefusal === 'LOGOUT_TOKEN_REPLAYED',
      `second use: ${replayRefusal}`,
    );

    // A token older than the maximum accepted age is refused — the bound that
    // makes the retention window finite (round-5 F6).
    const stale = double.signIdToken(provider.issuer, {
      iss: provider.issuer,
      aud: provider.clientId,
      iat: now - 3600,
      exp: now + 3600,
      jti: crypto.randomUUID(),
      sub: 'replay-subject',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    });
    let staleRefusal = '<accepted>';
    try {
      await logout.backchannelLogout(stale);
    } catch (error) {
      staleRefusal = String((error as { code?: unknown }).code ?? '');
    }
    record(
      'SS-23-max-age',
      'a logout token older than the maximum accepted age is refused',
      staleRefusal === 'TIME_WINDOW',
      `stale token: ${staleRefusal}`,
    );

    // THE BOUNDARY VECTOR a single-replay test cannot reach: run the sweep,
    // then replay a token that is STILL INSIDE ITS OWN VALIDITY. Its row must
    // have survived, so the replay is still refused. No accepted token may
    // outlive the row that refuses it.
    const swept = await logout.sweepReplayStore();
    const rowSurvived = await pool.query(
      'SELECT count(*)::int AS n FROM sso_logout_token_uses WHERE identity_provider_id = $1 AND replay_key = $2',
      [provider.id, jti],
    );
    let afterSweepRefusal = '<accepted>';
    try {
      await logout.backchannelLogout(token);
    } catch (error) {
      afterSweepRefusal = String((error as { code?: unknown }).code ?? '');
    }
    record(
      'SS-23-swept-but-valid',
      'a token still inside its own validity is still refused after the sweep has run',
      Number(rowSurvived.rows[0].n) === 1 && afterSweepRefusal === 'LOGOUT_TOKEN_REPLAYED',
      `sweep removed ${swept} row(s), this row survived=${rowSurvived.rows[0].n === 1}, replay: ${afterSweepRefusal}`,
    );
  }

  return { ok: results.every((result) => result.ok), results };
}
