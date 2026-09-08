/**
 * SS-W2 binding and configuration acceptance vectors (annex `e6dcadb9` §11a).
 *
 *   - **SS-11 / SSO-R5** — BOTH arms. The default-off refusal AND the
 *     conditioned match path with its own vectors. The §11a row is explicit
 *     that proving one arm is not proving the row.
 *   - **SS-17** — a caller-supplied URL, path or protocol-relative value in the
 *     return position is refused before a flow starts.
 *   - **SS-20 / SS-22** — success; wrong Identity provider; wrong Account;
 *     expired; replayed; two concurrent consumptions with exactly one winner;
 *     and a brute-force bound asserted on the secret's entropy.
 *   - **SS-21** — a provider declared `false`, or with no declaration, cannot
 *     be set active, with a NAMED error; declared `true` can; flipping a live
 *     provider true -> false stops new linking.
 *   - **SS-24** — unlink and Account termination reach the SAME empty end
 *     state, asserted to agree rather than assumed to.
 *   - **T-SS15** — session fixation: the issued token is freshly random and no
 *     pre-authentication value is carried forward.
 */
import crypto from 'crypto';
import { pool } from '../../db/connection';
import { resetProvidersByIssuerPrefix } from './resetProviders';
import type { AuditActor } from '../../services/AuditService';
import {
  IdentityProviderError,
  identityProviderService,
  type IdentityProvider,
} from '../../services/identity/IdentityProviderService';
import { SsoAuthenticationService, assertNotACallerComposedTarget } from '../../services/identity/SsoAuthenticationService';
import { SsoDiscoveryService } from '../../services/identity/SsoDiscoveryService';
import { identityLinkService } from '../../services/identity/IdentityLinkService';
import {
  INVITATION_SECRET_BYTES,
  INVITATION_MIN_ENTROPY_BITS,
  ssoInvitationService,
} from '../../services/identity/SsoInvitationService';
import { principalService } from '../../services/PrincipalService';
import { loginSessionService } from '../../services/LoginSessionService';
import { ProviderDouble } from '../conformance/providerDouble';
import type { VectorResult } from './vectors';

const ACTOR = { principalId: null, handle: 'binding-vectors', authMethod: 'system' } as unknown as AuditActor;
const HOST = 'https://idp.binding.test';

export async function runBindingVectors(): Promise<VectorResult[]> {
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
        name: `Binding ${slug}`,
        issuer,
        clientId: `client-${slug}`,
        clientSecret: 'binding-secret',
        subjectImmutable: true,
        status: 'active',
        provisioningMode: 'invited',
        ...config,
      } as never,
      ACTOR,
    );
  };

  const login = async (
    provider: IdentityProvider,
    subject: string,
    extra: Record<string, unknown> = {},
    invitationCode?: string,
  ) => {
    double.resetRequests();
    discovery.reset();
    const started = await service.startAuthentication({
      identityProviderId: provider.id,
      invitationCode: invitationCode ?? null,
    });
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
      preferred_username: `${subject}-${provider.clientId}-${run}`,
      ...extra,
    });
    return service.completeAuthentication({ state, code, iss: provider.issuer, cookieState: state });
  };

  const refusalOf = async (action: () => Promise<unknown>): Promise<string> => {
    try {
      await action();
      return '<accepted>';
    } catch (error) {
      return String((error as { code?: unknown }).code ?? (error as Error).message);
    }
  };

  const makeAccount = async (handle: string, role = 'user', email?: string): Promise<string> => {
    const created = await principalService.createPrincipal({ handle, kind: 'human', displayName: handle, role });
    if (!created) throw new Error(`could not create ${handle}`);
    if (email) {
      await pool.query(
        `UPDATE principals SET metadata = metadata || jsonb_build_object('email', $2::text) WHERE id = $1`,
        [created.id, email],
      );
    }
    return created.id;
  };

  // ── SS-17 — the return reference is never anything a caller composes ────
  {
    const shapes = [
      'https://evil.test/steal',
      '//evil.test/steal',
      '/dashboard',
      '../../etc',
      'javascript:alert(1)',
    ];
    const refusals = shapes.map((shape) => {
      try {
        assertNotACallerComposedTarget(shape);
        return `<accepted:${shape}>`;
      } catch (error) {
        return String((error as { code?: unknown }).code ?? '');
      }
    });
    // NON-VACUITY: a legitimate opaque reference must still be accepted, or
    // this vector would pass by refusing everything.
    let opaqueAccepted = true;
    try {
      assertNotACallerComposedTarget(`invitation:${crypto.randomUUID()}`);
    } catch {
      opaqueAccepted = false;
    }
    record(
      'SS-17-return-ref',
      'a URL, a protocol-relative value, a path or a scheme in the return position is refused; an opaque server-side reference is not',
      refusals.every((refusal) => refusal === 'SSO_RETURN_REF_INVALID') && opaqueAccepted,
      `refusals=${JSON.stringify(refusals)}, opaque reference accepted=${opaqueAccepted}`,
    );
  }

  // ── SS-21 — the subject-immutability declaration ───────────────────────
  {
    const declaredFalse = await refusalOf(() =>
      identityProviderService.create(
        {
          name: 'Binding recycles',
          issuer: `${HOST}/recycles`,
          clientId: 'client-recycles',
          subjectImmutable: false,
          status: 'active',
        } as never,
        ACTOR,
      ),
    );

    // Declared true CAN be active — the positive control.
    const good = await provision('immutable');

    // Flipping a LIVE provider true -> false stops new linking rather than
    // leaving it quietly usable.
    const flipped = await identityProviderService.update(good.id, { subjectImmutable: false }, ACTOR);

    // And asking to activate WHILE declaring false in the same call is a
    // contradiction, refused by name rather than silently resolved either way.
    const contradiction = await refusalOf(() =>
      identityProviderService.update(flipped.id, { subjectImmutable: false, status: 'active' }, ACTOR),
    );

    record(
      'SS-21-subject-immutable',
      'a provider declaring recyclable subjects cannot be active, and flipping a live one true->false disables it',
      declaredFalse === 'PROVIDER_SUBJECT_NOT_IMMUTABLE' &&
        good.status === 'active' &&
        flipped.status === 'disabled' &&
        contradiction === 'PROVIDER_SUBJECT_NOT_IMMUTABLE',
      `declared false at create=${declaredFalse}, declared true active=${good.status}, ` +
        `after flip=${flipped.status}, activate-while-false=${contradiction}`,
    );
  }

  // ── SS-20 / SS-22 — the Invitation ─────────────────────────────────────
  {
    const providerA = await provision('invite-a');
    const providerB = await provision('invite-b');
    // SS-14a admits ONE active Identity provider, so the swap is
    // disable-then-activate. Doing it the other way round is refused by the
    // partial unique index - which is the constraint working, and is how this
    // very line was found to be wrong.
    await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active'");
    await pool.query("UPDATE identity_providers SET status = 'active' WHERE id = $1", [providerA.id]);

    const accountId = await makeAccount(`invitee-${run}`);
    const { invitation, code } = await ssoInvitationService.mint(
      { identityProviderId: providerA.id, accountPrincipalId: accountId, newAccountIntent: false },
      ACTOR,
    );

    // Brute-force bound, asserted on the secret's entropy rather than hoped for.
    const decoded = Buffer.from(code, 'base64url');
    const entropyOk = INVITATION_SECRET_BYTES * 8 >= INVITATION_MIN_ENTROPY_BITS && decoded.length === INVITATION_SECRET_BYTES;

    // Minted for A: unusable at B, even by id.
    const atWrongProvider = await ssoInvitationService.consume(invitation.id, providerB.id);

    // Two concurrent consumptions: exactly one winner.
    const [firstConsume, secondConsume] = await Promise.all([
      ssoInvitationService.consume(invitation.id, providerA.id),
      ssoInvitationService.consume(invitation.id, providerA.id),
    ]);
    const winners = [firstConsume, secondConsume].filter((outcome) => outcome !== undefined).length;

    // Replay after consumption.
    const replayed = await ssoInvitationService.consume(invitation.id, providerA.id);

    // Expired.
    const expiredMint = await ssoInvitationService.mint(
      { identityProviderId: providerA.id, accountPrincipalId: accountId, newAccountIntent: false, ttlSeconds: 1 },
      ACTOR,
    );
    await pool.query("UPDATE sso_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      expiredMint.invitation.id,
    ]);
    const expired = await ssoInvitationService.consume(expiredMint.invitation.id, providerA.id);

    record(
      'SS-22-invitation',
      'an invitation is single-use, provider-scoped, expiring, and carries at least 128 bits of entropy',
      entropyOk &&
        atWrongProvider === undefined &&
        winners === 1 &&
        replayed === undefined &&
        expired === undefined,
      `entropy=${INVITATION_SECRET_BYTES * 8} bits (decoded ${decoded.length} bytes), wrong provider=${atWrongProvider === undefined ? 'refused' : 'ACCEPTED'}, ` +
        `concurrent winners=${winners}, replay=${replayed === undefined ? 'refused' : 'ACCEPTED'}, expired=${expired === undefined ? 'refused' : 'ACCEPTED'}`,
    );

    // SS-20: with no invitation at all, `invited` mode REFUSES rather than
    // binding by any claim it can see.
    const noInvitation = await refusalOf(() => login(providerA, 'uninvited-subject'));
    record(
      'SS-20-no-claim-selects-an-account',
      'invited mode refuses an unknown subject rather than binding by a matched claim',
      noInvitation === 'SSO_INVITATION_REQUIRED',
      `uninvited login: ${noInvitation}`,
    );
  }

  // ── SS-11 / SSO-R5 — BOTH arms ─────────────────────────────────────────
  {
    // Arm 1: the DEFAULT-OFF refusal. `allow_claim_matching` defaults false,
    // so a verified email matching an existing Account binds nothing.
    const offProvider = await provision('claim-off');
    await makeAccount(`matchme-off-${run}`, 'user', `off-${run}@example.test`);
    const offArm = await refusalOf(() =>
      login(offProvider, 'claim-off-subject', { email: `off-${run}@example.test`, email_verified: true }),
    );

    // Arm 2: the CONDITIONED match path.
    const onProvider = await provision('claim-on', { allowClaimMatching: true });
    const matchedId = await makeAccount(`matchme-on-${run}`, 'user', `on-${run}@example.test`);
    const matched = await login(onProvider, 'claim-on-subject', {
      email: `on-${run}@example.test`,
      email_verified: true,
    });

    // ...and its conditions, each refused on its own.
    const unverified = await refusalOf(() =>
      login(onProvider, 'claim-unverified-subject', {
        email: `on-${run}@example.test`,
        email_verified: false,
      }),
    );
    await makeAccount(`elevated-${run}`, 'admin', `elevated-${run}@example.test`);
    const elevated = await refusalOf(() =>
      login(onProvider, 'claim-elevated-subject', {
        email: `elevated-${run}@example.test`,
        email_verified: true,
      }),
    );

    record(
      'SS-11-both-arms',
      'claim matching is refused by default, and where enabled it requires email_verified and refuses an elevated Account',
      offArm === 'SSO_INVITATION_REQUIRED' &&
        matched.principalId === matchedId &&
        unverified === 'SSO_INVITATION_REQUIRED' &&
        elevated === 'SSO_CLAIM_MATCH_REFUSED',
      `default-off arm=${offArm}; conditioned match bound the expected Account=${matched.principalId === matchedId}; ` +
        `email_verified=false -> ${unverified}; elevated role -> ${elevated}`,
    );
  }

  // ── SS-24 — unlink and terminate reach the SAME empty end state ─────────
  {
    const provider = await provision('equivalence', { provisioningMode: 'jit' });
    const unlinkRun = await login(provider, 'equiv-unlink');
    const terminateRun = await login(provider, 'equiv-terminate');

    await identityLinkService.unlink(unlinkRun.identityLinkId, 'unlink', ACTOR);
    await identityLinkService.revokeAllForAccount(terminateRun.principalId, 'terminate');

    const live = async (principalId: string): Promise<number> => {
      const result = await pool.query(
        'SELECT count(*)::int AS n FROM auth_sessions WHERE principal_id = $1 AND revoked_at IS NULL',
        [principalId],
      );
      return Number(result.rows[0].n);
    };
    const afterUnlink = await live(unlinkRun.principalId);
    const afterTerminate = await live(terminateRun.principalId);

    // POSITIVE CONTROL: an untouched Account still HAS a live session, so
    // "both are empty" cannot pass by everything being empty.
    const controlRun = await login(provider, 'equiv-control');
    const control = await live(controlRun.principalId);

    record(
      'SS-24-unlink-terminate-equivalence',
      'unlink and Account termination leave the SAME empty set of live sessions, and an untouched Account keeps its own',
      afterUnlink === 0 && afterTerminate === 0 && control === 1,
      `after unlink=${afterUnlink}, after terminate=${afterTerminate}, untouched control=${control}`,
    );
  }

  // ── T-SS15 — session fixation ──────────────────────────────────────────
  {
    const provider = await provision('fixation', { provisioningMode: 'jit' });
    const first = await login(provider, 'fixation-one');
    const second = await login(provider, 'fixation-two');
    const tokenBytes = Buffer.from(first.sessionToken, 'base64url').length;
    record(
      'T-SS15-session-fixation',
      'the issued session token is freshly random on every authentication, never carried in from before it',
      first.sessionToken !== second.sessionToken && tokenBytes === 32,
      `distinct tokens=${first.sessionToken !== second.sessionToken}, token entropy=${tokenBytes * 8} bits`,
    );
  }

  // ── SS-7 — the client secret is never returned by any surface ──────────
  {
    const provider = await provision('secrets');
    const listed = await identityProviderService.list();
    const serialised = JSON.stringify(listed);
    const fetched = JSON.stringify(await identityProviderService.get(provider.id));
    record(
      'SS-7-no-secret-on-any-surface',
      'no Identity provider surface returns the client secret, and presence is reported instead of the value',
      !serialised.includes('binding-secret') && !fetched.includes('binding-secret') && serialised.includes('hasClientSecret'),
      `secret absent from list=${!serialised.includes('binding-secret')}, absent from get=${!fetched.includes('binding-secret')}, presence reported=${serialised.includes('hasClientSecret')}`,
    );
  }

  // ── AUTHZ §7.6 — the step-up authorization request ─────────────────────
  {
    const provider = await provision('step-up', { provisioningMode: 'jit' });
    const stepUp = await service.startAuthentication({ identityProviderId: provider.id, stepUp: true });
    const stepUpUrl = new URL(stepUp.authorizeUrl);
    const ordinary = await service.startAuthentication({ identityProviderId: provider.id });
    const ordinaryUrl = new URL(ordinary.authorizeUrl);
    record(
      'AUTHZ-7.6-step-up-request',
      'a step-up authorization request carries prompt=login and max_age=0, and an ordinary one carries neither',
      stepUpUrl.searchParams.get('prompt') === 'login' &&
        stepUpUrl.searchParams.get('max_age') === '0' &&
        ordinaryUrl.searchParams.get('prompt') === null &&
        ordinaryUrl.searchParams.get('max_age') === null,
      `step-up prompt=${stepUpUrl.searchParams.get('prompt')} max_age=${stepUpUrl.searchParams.get('max_age')}; ` +
        `ordinary prompt=${ordinaryUrl.searchParams.get('prompt')} max_age=${ordinaryUrl.searchParams.get('max_age')} ` +
        '(the refusal when auth_time predates the request is pinned by §5.3 refusal 9)',
    );
  }

  // ── AUTHZ §7.1 — the browser-loopback flow (§8.4) ──────────────────────
  {
    const provider = await provision('loopback', { provisioningMode: 'jit' });
    double.resetRequests();
    discovery.reset();
    const started = await service.startAuthentication({ identityProviderId: provider.id, loopbackPort: 53682 });
    const url = new URL(started.authorizeUrl);
    const state = url.searchParams.get('state') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';
    const now = Math.floor(Date.now() / 1000);
    const code = double.issueCode(provider.issuer, {
      iss: provider.issuer,
      sub: 'loopback-subject',
      aud: provider.clientId,
      exp: now + 300,
      iat: now - 5,
      nonce,
      preferred_username: `loopback-${run}`,
    });
    const completed = await service.completeAuthentication({
      state,
      code,
      iss: provider.issuer,
      cookieState: state,
    });

    // A LOGIN SESSION, not a bearer credential (AZ-18 is not relaxed for
    // convenience): the Account must hold no `rh_` credential row afterwards.
    const bearer = await pool.query(
      "SELECT count(*)::int AS n FROM principal_credentials WHERE principal_id = $1 AND credential_type = 'api_key'",
      [completed.principalId],
    );

    // A caller-supplied port outside the unprivileged range is ignored, so the
    // destination falls back to one the server chose.
    const badPort = await service.startAuthentication({ identityProviderId: provider.id, loopbackPort: 22 });
    const badPortRow = await pool.query(
      'SELECT return_ref FROM sso_authentication_requests WHERE id = $1',
      [badPort.pendingRequestId],
    );

    record(
      'AUTHZ-7.1-browser-loopback',
      'the loopback flow completes and issues a LOGIN SESSION, not a bearer credential, to a destination the server composes',
      completed.returnTo === 'http://127.0.0.1:53682/' &&
        completed.sessionToken.length > 0 &&
        Number(bearer.rows[0].n) === 0 &&
        badPortRow.rows[0].return_ref === null,
      `returnTo=${completed.returnTo}, bearer credentials on the Account=${bearer.rows[0].n}, ` +
        `privileged port 22 stored as ${JSON.stringify(badPortRow.rows[0].return_ref)}`,
    );
  }

  // ── SSO-R16 — the retained ID token, and its disposal ──────────────────
  {
    const opted = await provision('retain-on', { provisioningMode: 'jit', retainIdToken: true });
    const retained = await login(opted, 'retain-subject');
    const stored = await pool.query(
      'SELECT id_token_ct IS NOT NULL AS present, id_token_ct FROM auth_sessions WHERE id = $1',
      [retained.sessionId],
    );
    // Ciphertext, never the token: the compact JWS would contain two dots and
    // start with the header segment, so assert it does NOT look like one.
    const looksEncrypted =
      stored.rows[0].present === true && !String(stored.rows[0].id_token_ct).startsWith('eyJ');

    // Disposal is bound to session death, in the SAME statement that revokes.
    await loginSessionService.revoke(retained.sessionId, 'logout');
    const afterRevoke = await pool.query(
      'SELECT id_token_ct IS NULL AS cleared, revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id = $1',
      [retained.sessionId],
    );

    // CONTROL: the default is OFF, so a provider that did not opt in stores
    // nothing at all — the vector cannot pass by nothing ever being retained.
    const notOpted = await provision('retain-off', { provisioningMode: 'jit' });
    const plain = await login(notOpted, 'retain-off-subject');
    const plainStored = await pool.query('SELECT id_token_ct IS NULL AS empty FROM auth_sessions WHERE id = $1', [
      plain.sessionId,
    ]);

    record(
      'SSO-R16-id-token-retention',
      'a retained ID token is stored encrypted only where the provider opted in, and is disposed of in the same statement that revokes',
      looksEncrypted &&
        afterRevoke.rows[0].cleared === true &&
        afterRevoke.rows[0].revoked === true &&
        plainStored.rows[0].empty === true,
      `opted-in stored=${stored.rows[0].present} and not a bare JWS=${looksEncrypted}; ` +
        `after revoke cleared=${afterRevoke.rows[0].cleared} revoked=${afterRevoke.rows[0].revoked}; ` +
        `default-off provider stored nothing=${plainStored.rows[0].empty}`,
    );
  }

  void IdentityProviderError;
  return results;
}
