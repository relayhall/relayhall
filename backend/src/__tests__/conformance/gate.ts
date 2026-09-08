/**
 * The §4.5(a) conformance gate (annex `e6dcadb9` §10b).
 *
 * **(a) The named targets, and all eight shape classes, traverse ONE production
 * path as configuration.**
 *
 * Every fixture drives `SsoAuthenticationService.startAuthentication` and
 * `.completeAuthentication` — the shared relying-party entry point — against a
 * real migrated PostgreSQL, with a provider double standing in for the Identity
 * provider at the ONE outbound seam. Each run stamps the path it traversed,
 * together with the target and the shape class it claims to be.
 *
 * Three things make this a gate rather than a demonstration:
 *
 *  1. **The census is digest-locked.** It is a transcription of two ratified
 *     sources; the gate recomputes the digest and REFUSES TO RUN on a mismatch,
 *     because a census whose provenance is in doubt cannot discharge anything.
 *  2. **Each class carries a BEHAVIOURAL assertion with a negative control.**
 *     Not a label, not a digest of the fixture's bytes — an observation of
 *     production doing the thing, and a control that could have come out the
 *     other way. Classes 4 and 6 observe the PROVIDER'S characteristic (the
 *     claim parser's verdict, the validated metadata), never a board setting:
 *     round-6 F2 found both vacuous when they watched our own configuration.
 *  3. **The expected relation is asserted.** For every `(target -> required
 *     class)` pair the census names, that pair must appear among the
 *     path-stamped results with its class assertion and its control green.
 *
 * ── THE W2 SCOPE BOUNDARY, NOW CLOSED BY W3 ──
 *
 * W2 declared a limitation here and carried it as card `4502b4dd`: classes 2, 3
 * and 5 are stated in §10a with a MEMBERSHIP leg ("produces the expected
 * membership"), but writing memberships from a claim is SS-W3, so W2 asserted
 * those classes only at the boundary it owned — the parser's verdict and the
 * opaque-ref binding resolution. It said so rather than letting a partial
 * assertion read as a full one.
 *
 * **W3 supplies the writer and the three classes now carry their membership
 * legs**, which changes what they can catch:
 *
 *  - **class 2** asserts the dotted path produces the expected MEMBERSHIP, not
 *    merely a resolved binding — a binding that resolves and then writes
 *    nothing would have passed the W2 form while the feature did not work;
 *  - **class 3** asserts a GUID, a `/path` and a bare name produce THREE
 *    DISTINCT memberships, compared as an exact set, so three values
 *    collapsing onto one (or onto none) fails;
 *  - **class 5** is no longer VACUOUS. Its W2 form asserted "memberships === 0
 *    after an overage", which was true because nothing in W2 ever wrote a
 *    membership — an assertion that could not have come out the other way. The
 *    same subject now logs in FIRST with a well-formed claim that really writes
 *    two memberships and moves the AZ-30 watermark, and only then with the
 *    overage. "Unchanged" is therefore a claim about a non-empty set, and the
 *    T-SS14 directory wipe — reading an overage indicator as "member of
 *    nothing" — makes it red.
 */
import crypto from 'crypto';
import dns from 'dns';
import { pool } from '../../db/connection';
import type { AuditActor } from '../../services/AuditService';
import { SsoAuthenticationService } from '../../services/identity/SsoAuthenticationService';
import { SsoDiscoveryService } from '../../services/identity/SsoDiscoveryService';
import { SsoLogoutService } from '../../services/identity/SsoLogoutService';
import { identityProviderService } from '../../services/identity/IdentityProviderService';
import { resolvePinnedAddress, SsoOutboundError } from '../../services/identity/ssoOutbound';
import {
  CENSUS_DIGEST,
  EXPECTED_RELATION,
  classesNamedInTranscription,
  computeCensusDigest,
  requiredClassIds,
  targetsNamedInTranscription,
  type ShapeClassId,
} from './census';
import { CLASS_2_CLAIM_PATH, CLASS_2_CLAIM_VALUE, CLASS_3_GROUP_VALUES, CONFORMANCE_HOST, FIXTURES } from './fixtures';
import { ProviderDouble } from './providerDouble';

// `system`, not `none`: `audit_events.auth_method` enumerates its permitted
// values and the gate must write the ledger the way production does.
const ACTOR = { principalId: null, handle: 'conformance-gate', authMethod: 'system' } as unknown as AuditActor;

export interface ClassOutcome {
  classId: ShapeClassId;
  label: string;
  targets: readonly string[];
  /** The shared entry point really produced this result. */
  entryPointStamped: boolean;
  assertion: 'green' | 'red';
  control: 'green' | 'red';
  detail: string[];
}

export interface GateResult {
  ok: boolean;
  refusedToRun: string | null;
  failures: string[];
  outcomes: ClassOutcome[];
}

const ENTRY_POINT = 'SsoAuthenticationService.completeAuthentication';

/**
 * MUTATION (iii) ANCHOR — "make one fixture reach a shortcut instead of the
 * shared RP entry point". `null` in the committed tree; the red-proof driver
 * sets it to a class id, and that class's fixture then composes its result
 * from helpers instead of calling the entry point, so the path-stamp leg must
 * fail while nothing else changes.
 */
const SHORTCUT_CLASS: number | null = null;

export async function runConformanceGate(): Promise<GateResult> {
  const failures: string[] = [];
  const outcomes: ClassOutcome[] = [];

  // ── the digest lock ────────────────────────────────────────────────────
  if (computeCensusDigest() !== CENSUS_DIGEST) {
    return {
      ok: false,
      refusedToRun:
        'the expected census does not match its recorded digest: it has been edited without editing the ratified source it transcribes',
      failures: [],
      outcomes: [],
    };
  }

  const double = new ProviderDouble();
  const discovery = new SsoDiscoveryService(double);
  const service = new SsoAuthenticationService(discovery, double);
  const logout = new SsoLogoutService(discovery);

  await resetConformanceState();

  /** Create the fixture's Identity provider and make it THE active one (SS-14a). */
  const provisionProvider = async (
    issuerPath: string,
    config: Record<string, unknown> = {},
    documentOverrides?: Record<string, unknown>,
  ) => {
    const issuer = `${CONFORMANCE_HOST}${issuerPath}`;
    const clientId = `client-${issuerPath.replace(/\W+/g, '-')}`;
    double.register({ issuer, clientId, documentOverrides });
    await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active'");
    return identityProviderService.create(
      {
        name: `Conformance ${issuerPath}`,
        issuer,
        clientId,
        clientSecret: 'conformance-secret',
        clientPrivateKey: privateKeyPem(),
        subjectImmutable: true,
        status: 'active',
        provisioningMode: 'jit',
        ...config,
      } as never,
      ACTOR,
    );
  };

  /** Per-run, so repeated runs never collide on a handle. */
  const RUN = crypto.randomBytes(4).toString('hex');

  /** ONE login through the shared entry point. Returns what production said. */
  const login = async (
    provider: { id: string; issuer: string; clientId: string },
    subjectBase: string,
    extraClaims: Record<string, unknown> = {},
  ) => {
    const subject = `${subjectBase}-${RUN}`;
    double.resetRequests();
    discovery.reset();
    const started = await service.startAuthentication({ identityProviderId: provider.id });
    const authorizeUrl = new URL(started.authorizeUrl);
    const state = authorizeUrl.searchParams.get('state') ?? '';
    const nonce = authorizeUrl.searchParams.get('nonce') ?? '';
    const now = Math.floor(Date.now() / 1000);
    const code = double.issueCode(provider.issuer, {
      iss: provider.issuer,
      sub: subject,
      aud: provider.clientId,
      exp: now + 300,
      iat: now - 5,
      nonce,
      preferred_username: subject,
      ...extraClaims,
    });
    const completed = await service.completeAuthentication({
      state,
      code,
      iss: provider.issuer,
      cookieState: state,
    });
    if (SHORTCUT_CLASS !== null && shortcutArmedFor === SHORTCUT_CLASS) {
      // The shortcut a fixture would take if it reached past the entry point:
      // a result that never carries the stamp the entry point produces.
      return {
        completed: { ...completed, traversedEntryPoint: '<shortcut>' },
        authorizeUrl,
        dialled: double.dialled(),
      };
    }
    return { completed, authorizeUrl, dialled: double.dialled() };
  };

  /** The path-stamp leg: the entry point produced it AND the wire shows it. */
  const stamped = (completed: { traversedEntryPoint: string }, dialled: string[]): boolean =>
    completed.traversedEntryPoint === ENTRY_POINT &&
    dialled.some((url) => url.endsWith('/.well-known/openid-configuration')) &&
    dialled.some((url) => url.endsWith('/token')) &&
    dialled.some((url) => url.endsWith('/jwks'));

  const record = (
    classId: ShapeClassId,
    label: string,
    targets: readonly string[],
    entryPointStamped: boolean,
    assertion: boolean,
    control: boolean,
    detail: string[],
  ): void => {
    outcomes.push({
      classId,
      label,
      targets,
      entryPointStamped,
      assertion: assertion ? 'green' : 'red',
      control: control ? 'green' : 'red',
      detail,
    });
    if (!entryPointStamped) failures.push(`class ${classId} (${label}): the fixture did not traverse ${ENTRY_POINT}`);
    if (!assertion) failures.push(`class ${classId} (${label}): its behavioural assertion is RED`);
    if (!control) failures.push(`class ${classId} (${label}): its negative control is RED`);
  };

  /** Which class the next login belongs to, for the shortcut anchor above. */
  let shortcutArmedFor: number | null = null;

  const fixtureFor = (label: string) => {
    const found = FIXTURES.find((fixture) => fixture.label === label);
    if (!found) throw new Error(`no fixture labelled ${label}`);
    return found;
  };

  // ── class 1 — issuer is a path under a shared host ──────────────────────
  {
    const alphaFixture = fixtureFor('issuer-path-under-shared-host-alpha');
    const betaFixture = fixtureFor('issuer-path-under-shared-host-beta');
    shortcutArmedFor = 1;
    const alpha = await provisionProvider(alphaFixture.issuerPath, {}, alphaFixture.documentOverrides);
    const alphaRun = await login(alpha, 'class1-alpha');
    const beta = await provisionProvider(betaFixture.issuerPath, {}, betaFixture.documentOverrides);
    const betaRun = await login(beta, 'class1-beta');
    shortcutArmedFor = null;

    // Read from the authorize URL the login actually built, which the relying
    // party took from each document — never from a template.
    const alphaAuthorize = `${alphaRun.authorizeUrl.origin}${alphaRun.authorizeUrl.pathname}`;
    const betaAuthorize = `${betaRun.authorizeUrl.origin}${betaRun.authorizeUrl.pathname}`;

    // The assertion: two providers on the SAME HOST, each resolving to ITS OWN
    // endpoint set.
    const ownEndpoints =
      alphaAuthorize === `${CONFORMANCE_HOST}${alphaFixture.issuerPath}/authorize` &&
      betaAuthorize === `${CONFORMANCE_HOST}${betaFixture.issuerPath}/authorize`;

    // The control is an ORACLE REBUILT HERE rather than a second reading of
    // production: what a templated implementation WOULD have produced. If the
    // relying party built endpoints from the host origin, both would have gone
    // here, and the assertion could not have distinguished them.
    const templated = `${CONFORMANCE_HOST}/authorize`;
    const notTemplated = alphaAuthorize !== templated && betaAuthorize !== templated;

    record(1, alphaFixture.label, alphaFixture.targets,
      stamped(alphaRun.completed, alphaRun.dialled) && stamped(betaRun.completed, betaRun.dialled),
      ownEndpoints, notTemplated,
      [`alpha authorization endpoint: ${alphaAuthorize}`, `beta authorization endpoint: ${betaAuthorize}`]);
  }

  // ── class 2 — the groups claim has no fixed name or nesting ─────────────
  {
    const fixture = fixtureFor('nested-groups-claim');
    const provider = await provisionProvider(fixture.issuerPath, {
      groupsClaim: CLASS_2_CLAIM_PATH,
      groupBindingMode: 'claim',
    }, fixture.documentOverrides);
    const boundGroupId = await bindGroup(provider.id, CLASS_2_CLAIM_VALUE, 'Class 2 bound group');

    const run = await login(provider, 'class2-subject', fixture.idTokenClaims);
    const nested = run.completed.groupClaim;
    // W3 carry-forward `4502b4dd` [0]: the dotted path must produce the
    // EXPECTED MEMBERSHIP, not merely a resolved binding. A binding that
    // resolves and then writes nothing would have passed the W2 form of this
    // assertion while the feature did not work.
    const membership = await membershipGroupIds(run.completed.principalId);
    const assertion =
      nested.verdict === 'claim_present' &&
      nested.values.includes(CLASS_2_CLAIM_VALUE) &&
      run.completed.boundGroupRefs.includes(CLASS_2_CLAIM_VALUE) &&
      membership.length === 1 &&
      membership[0] === boundGroupId;

    // Control: THE SAME BYTES addressed as a flat claim yield no value, no
    // binding AND no membership — so "both resolve nothing" cannot pass.
    await identityProviderService.update(provider.id, { groupsClaim: 'roles' }, ACTOR);
    const flatRun = await login(provider, 'class2-subject-flat', fixture.idTokenClaims);
    const flatMembership = await membershipGroupIds(flatRun.completed.principalId);
    const control =
      flatRun.completed.groupClaim.verdict === 'claim_absent' &&
      flatRun.completed.boundGroupRefs.length === 0 &&
      flatMembership.length === 0;

    record(2, fixture.label, fixture.targets, stamped(run.completed, run.dialled), assertion, control, [
      `nested verdict: ${nested.verdict} values=${JSON.stringify(nested.values)}`,
      `nested membership: ${JSON.stringify(membership)} (expected [${boundGroupId}])`,
      `flat verdict: ${flatRun.completed.groupClaim.verdict}, membership=${flatMembership.length}`,
    ]);
  }

  // ── class 3 — group values are opaque and of no fixed type ──────────────
  {
    const fixture = fixtureFor('opaque-group-values');
    const provider = await provisionProvider(fixture.issuerPath, {
      groupsClaim: 'groups',
      groupBindingMode: 'claim',
    }, fixture.documentOverrides);
    const groupIds: string[] = [];
    for (const [index, value] of CLASS_3_GROUP_VALUES.entries()) {
      groupIds.push(await bindGroup(provider.id, value, `Class 3 group ${index + 1}`));
    }

    const run = await login(provider, 'class3-subject', fixture.idTokenClaims);
    const bound = run.completed.boundGroupRefs;
    // W3 carry-forward `4502b4dd` [1]: a GUID, a `/path` and a bare name must
    // produce THREE DISTINCT MEMBERSHIPS. Distinct GROUPS was all W2 could
    // show; three values collapsing onto one membership, or onto none, would
    // have passed that. The set comparison is exact in both directions, so an
    // extra membership fails it too.
    const membership = await membershipGroupIds(run.completed.principalId);
    const expectedMembership = [...groupIds].sort();
    const assertion =
      bound.length === CLASS_3_GROUP_VALUES.length &&
      CLASS_3_GROUP_VALUES.every((value) => bound.includes(value)) &&
      new Set(groupIds).size === CLASS_3_GROUP_VALUES.length &&
      membership.length === CLASS_3_GROUP_VALUES.length &&
      JSON.stringify([...membership].sort()) === JSON.stringify(expectedMembership);

    // Control: each value differing by ONE BYTE binds nothing and writes no
    // membership — and the positives above really did both, so
    // refuse-everything cannot pass.
    const offByOne = CLASS_3_GROUP_VALUES.map((value) => `${value}x`);
    const controlRun = await login(provider, 'class3-subject-offbyone', { groups: offByOne });
    const controlMembership = await membershipGroupIds(controlRun.completed.principalId);
    const control =
      controlRun.completed.groupClaim.verdict === 'claim_present' &&
      controlRun.completed.boundGroupRefs.length === 0 &&
      controlMembership.length === 0;

    record(3, fixture.label, fixture.targets, stamped(run.completed, run.dialled), assertion, control, [
      `bound: ${JSON.stringify(bound)}`,
      `distinct groups: ${new Set(groupIds).size}`,
      `memberships: ${membership.length} (expected ${CLASS_3_GROUP_VALUES.length}, exact set match ${JSON.stringify([...membership].sort()) === JSON.stringify(expectedMembership)})`,
      `off-by-one bound: ${controlRun.completed.boundGroupRefs.length}, memberships: ${controlMembership.length}`,
    ]);
  }

  // ── class 4 — a provider may emit no groups at all ──────────────────────
  {
    const fixture = fixtureFor('no-groups-claim-at-all');
    const provider = await provisionProvider(fixture.issuerPath, {
      groupsClaim: 'groups',
      groupBindingMode: 'off',
    }, fixture.documentOverrides);

    const run = await login(provider, 'class4-subject', fixture.idTokenClaims);
    const memberships = await membershipCount(run.completed.principalId);
    // The characteristic, observed where the code decides it: the PARSER says
    // this token carries no groups claim. Then the behaviour that follows.
    const assertion =
      run.completed.groupClaim.verdict === 'claim_absent' &&
      run.completed.boundGroupRefs.length === 0 &&
      memberships === 0;

    // Control 1: a token that DOES carry a groups claim changes the parser's
    // verdict even though `group_binding_mode` is still `off` — so the class
    // cannot be satisfied by our own configuration.
    const withClaim = await login(provider, 'class4-subject-with-claim', { groups: ['anything'] });
    const controlOne = withClaim.completed.groupClaim.verdict === 'claim_present';

    // Control 2: the same shape at a groups-emitting provider in `claim` mode
    // DOES resolve a binding. (§10a states this leg as "does write a
    // snapshot"; the write is SS-W3 per the scope note at the head of this
    // file, so W2 asserts the resolution the login really performs.)
    const emitting = await provisionProvider('/application/class4-control', {
      groupsClaim: 'groups',
      groupBindingMode: 'claim',
    });
    await bindGroup(emitting.id, 'class4-control-group', 'Class 4 control group');
    const emittingRun = await login(emitting, 'class4-control-subject', { groups: ['class4-control-group'] });
    const controlTwo = emittingRun.completed.boundGroupRefs.includes('class4-control-group');

    record(4, fixture.label, fixture.targets, stamped(run.completed, run.dialled), assertion,
      controlOne && controlTwo, [
        `verdict: ${run.completed.groupClaim.verdict}`,
        `with-claim verdict: ${withClaim.completed.groupClaim.verdict}`,
        `emitting provider bound: ${JSON.stringify(emittingRun.completed.boundGroupRefs)}`,
      ]);
  }

  // ── class 5 — a provider may TRUNCATE the claim ─────────────────────────
  {
    const fixture = fixtureFor('truncated-groups-claim');
    const provider = await provisionProvider(fixture.issuerPath, {
      groupsClaim: 'groups',
      groupBindingMode: 'claim',
    }, fixture.documentOverrides);
    const groupA = await bindGroup(provider.id, 'class5-group', 'Class 5 group');
    const groupB = await bindGroup(provider.id, 'class5-group-b', 'Class 5 group B');

    // ── W3 carry-forward `4502b4dd` [2] — killing this class's vacuity ──────
    //
    // W2's form of this assertion read "memberships === 0 after an overage".
    // That was TRUE, and it proved NOTHING: no code in W2 wrote a membership,
    // so the count was zero whatever the parser decided. The assertion could
    // not have come out the other way, which is the definition of a vacuous
    // control, and W2's own evidence recorded it as such.
    //
    // The repair is to give the overage something to destroy. THE SAME SUBJECT
    // logs in twice: first with a well-formed claim that really does write two
    // memberships and moves the watermark, and then with the overage. If an
    // overage indicator were read as "member of nothing" — the T-SS14
    // directory wipe — the second login would delete both rows. So
    // "unchanged" is now a claim about a NON-EMPTY set, and it fails if the
    // fail-closed rule is removed.
    const SUBJECT = 'class5-subject';
    const seed = await login(provider, SUBJECT, { groups: ['class5-group', 'class5-group-b'] });
    const seededMembership = await membershipGroupIds(seed.completed.principalId);
    const seededWatermark = await syncWatermark(provider.id);

    const run = await login(provider, SUBJECT, fixture.idTokenClaims);
    const afterOverageMembership = await membershipGroupIds(run.completed.principalId);
    const afterOverageWatermark = await syncWatermark(provider.id);

    // The recorded reason is `overage`, DISTINGUISHABLE from `claim_absent`;
    // the memberships this Account already held are UNTOUCHED; and the
    // staleness watermark did not move, so AZ-30's alarm can fire.
    const assertion =
      run.completed.groupClaim.verdict === 'overage' &&
      run.completed.boundGroupRefs.length === 0 &&
      seededMembership.length === 2 &&
      JSON.stringify(afterOverageMembership) === JSON.stringify(seededMembership) &&
      afterOverageWatermark === seededWatermark;

    // Controls: a well-formed claim changes BOTH — the membership set AND the
    // watermark — so a rule that simply never wrote anything cannot pass; and
    // an ordinary absent claim still records `claim_absent`, so hollowing the
    // overage fixture into an absent one turns the reason assertion red.
    const narrowed = await login(provider, SUBJECT, { groups: ['class5-group'] });
    const narrowedMembership = await membershipGroupIds(narrowed.completed.principalId);
    const narrowedWatermark = await syncWatermark(provider.id);
    const absent = await login(provider, 'class5-absent', {});
    const control =
      narrowed.completed.groupClaim.verdict === 'claim_present' &&
      narrowed.completed.boundGroupRefs.includes('class5-group') &&
      narrowedMembership.length === 1 &&
      narrowedMembership[0] === groupA &&
      narrowedWatermark !== null &&
      narrowedWatermark !== seededWatermark &&
      absent.completed.groupClaim.verdict === 'claim_absent';

    record(5, fixture.label, fixture.targets, stamped(run.completed, run.dialled), assertion, control, [
      `seeded membership: ${seededMembership.length} (groups ${groupA}, ${groupB})`,
      `overage verdict: ${run.completed.groupClaim.verdict}, membership after: ${afterOverageMembership.length}`,
      `watermark held: ${afterOverageWatermark === seededWatermark}`,
      `control narrowed membership: ${narrowedMembership.length}, watermark moved: ${narrowedWatermark !== seededWatermark}`,
      `absent verdict: ${absent.completed.groupClaim.verdict}`,
    ]);
  }

  // ── class 6 — logout support varies ────────────────────────────────────
  {
    const fixture = fixtureFor('no-backchannel-logout');
    const provider = await provisionProvider(fixture.issuerPath, { backchannelLogoutEnabled: false }, fixture.documentOverrides);
    const run = await login(provider, 'class6-subject');

    // The characteristic, read from the DOCUMENT THE CODE VALIDATED — not from
    // our `backchannel_logout_enabled` setting (round-6 F2).
    const metadata = await discovery.metadata({
      id: provider.id,
      issuer: provider.issuer,
      discoveryUrl: provider.discoveryUrl,
      additionalEndpointOrigins: provider.additionalEndpointOrigins,
      allowPrivateIssuerAddress: provider.allowPrivateIssuerAddress,
    });
    const rpUrl = await logout.rpInitiatedLogoutUrl(provider, run.completed.sessionId, 'https://board.test/');
    const postRefusal = await refusalCodeOf(() =>
      logout.backchannelLogout(double.signIdToken(provider.issuer, backchannelClaims(provider))),
    );
    const assertion =
      metadata.backchannelLogoutSupported === false &&
      rpUrl !== null &&
      rpUrl.startsWith(`${provider.issuer}/logout`) &&
      postRefusal === 'LOGOUT_NOT_ADVERTISED';

    // Control 1: a provider whose document DOES advertise it makes the
    // metadata assertion fail, even with our flag still off.
    const advertising = await provisionProvider('/application/class6-advertised', { backchannelLogoutEnabled: false }, {
      backchannel_logout_supported: true,
    });
    const advertisedMetadata = await discovery.metadata({
      id: advertising.id,
      issuer: advertising.issuer,
      discoveryUrl: advertising.discoveryUrl,
      additionalEndpointOrigins: advertising.additionalEndpointOrigins,
      allowPrivateIssuerAddress: advertising.allowPrivateIssuerAddress,
    });
    const controlOne = advertisedMetadata.backchannelLogoutSupported === true;

    // Control 2: advertising it AND enabling it accepts the same POST — so
    // refuse-everything cannot pass.
    await identityProviderService.update(advertising.id, { backchannelLogoutEnabled: true }, ACTOR);
    const enabled = await identityProviderService.require(advertising.id);
    const accepted = await logout
      .backchannelLogout(double.signIdToken(enabled.issuer, backchannelClaims(enabled)))
      .then(() => true)
      .catch(() => false);

    record(6, fixture.label, fixture.targets, stamped(run.completed, run.dialled), assertion,
      controlOne && accepted, [
        `advertised: ${metadata.backchannelLogoutSupported}`,
        `rp-initiated url: ${rpUrl}`,
        `back-channel refusal: ${postRefusal}`,
        `control advertised: ${advertisedMetadata.backchannelLogoutSupported}, accepted: ${accepted}`,
      ]);
  }

  // ── class 7 — the issuer may be unreachable from the public internet ────
  {
    const fixture = fixtureFor('private-issuer-address');
    // Class 7's characteristic IS the address the issuer's host resolves to.
    // It must come from the fixture: a gate-side default would let the gate
    // supply the very provider characteristic this class claims to observe
    // (round-6 F2), and would keep a hollowing that stripped the fixture from
    // being visible here. Absent is loud, never defaulted.
    const { resolvesTo, publicControlAddress } = fixture;
    if (!resolvesTo || !publicControlAddress) {
      throw new Error(
        'class 7 fixture must declare resolvesTo and publicControlAddress: these addresses are '
          + 'the provider characteristic the class observes, and the gate must not substitute its own',
      );
    }
    const provider = await provisionProvider(fixture.issuerPath, { allowPrivateIssuerAddress: true }, fixture.documentOverrides);
    const run = await login(provider, 'class7-subject');

    // The provider's characteristic here is the ADDRESS ITS HOST RESOLVES TO,
    // so the gate controls the resolver rather than the policy: the production
    // function under test is unchanged.
    const realLookup = dns.promises.lookup;
    const resolveTo = (address: string): void => {
      (dns.promises as unknown as { lookup: unknown }).lookup = (async () => [
        { address, family: address.includes(':') ? 6 : 4 },
      ]) as unknown as typeof dns.promises.lookup;
    };
    let refusedWithFlagOff = '';
    let pinnedWithFlagOn = '';
    let publicWithFlagOff = '';
    try {
      resolveTo(resolvesTo);
      refusedWithFlagOff = await refusalCodeOf(() =>
        resolvePinnedAddress('idp.conformance.test', {
          issuerOrigin: CONFORMANCE_HOST,
          additionalEndpointOrigins: [],
          allowPrivateIssuerAddress: false,
        }),
      );
      pinnedWithFlagOn = (
        await resolvePinnedAddress('idp.conformance.test', {
          issuerOrigin: CONFORMANCE_HOST,
          additionalEndpointOrigins: [],
          allowPrivateIssuerAddress: true,
        })
      ).address;
      // Hollowing this class moves the provider onto the public internet: the
      // address above is then public, and "refused with the flag off" stops
      // being true of it.
      // The control: a PUBLIC address is permitted with the flag OFF, proving
      // the flag governs the private case only, not everything.
      resolveTo(publicControlAddress);
      publicWithFlagOff = (
        await resolvePinnedAddress('idp.conformance.test', {
          issuerOrigin: CONFORMANCE_HOST,
          additionalEndpointOrigins: [],
          allowPrivateIssuerAddress: false,
        })
      ).address;
    } finally {
      (dns.promises as unknown as { lookup: unknown }).lookup = realLookup;
    }

    const assertion =
      refusedWithFlagOff === 'ADDRESS_NOT_PERMITTED' && pinnedWithFlagOn === resolvesTo;
    const control = publicWithFlagOff === publicControlAddress;

    record(7, fixture.label, fixture.targets, stamped(run.completed, run.dialled), assertion, control, [
      `flag off, private address: ${refusedWithFlagOff}`,
      `flag on, pinned to: ${pinnedWithFlagOn}`,
      `flag off, public address: ${publicWithFlagOff}`,
    ]);
  }

  // ── class 8 — client authentication varies ─────────────────────────────
  {
    const methods = [
      'client-auth-secret-basic',
      'client-auth-secret-post',
      'client-auth-private-key-jwt',
      'client-auth-none',
    ] as const;
    const observed: string[] = [];
    let allStamped = true;
    for (const label of methods) {
      const fixture = fixtureFor(label);
      const method = fixture.providerConfig?.clientAuthMethod ?? 'client_secret_basic';
      const provider = await provisionProvider(fixture.issuerPath, { clientAuthMethod: method }, fixture.documentOverrides);
      // The subject is derived from the fixture LABEL, not from the method.
      // Naming it after the characteristic under test made the class-8
      // hollowing collide two handles and error the gate instead of turning
      // the class red — a harness coupling the mutation found.
      const run = await login(provider, `class8-${label}`);
      allStamped = allStamped && stamped(run.completed, run.dialled);
      // Observed ON THE WIRE by the double — not "the exchange succeeded".
      observed.push(`${method}:${double.observedClientAuth()}`);
    }
    const assertion = observed.every((entry) => {
      const [configured, seen] = entry.split(':');
      return configured === seen;
    }) && new Set(observed.map((entry) => entry.split(':')[1])).size === 4;

    // Control: a method the Identity provider does NOT advertise is refused.
    const narrow = await provisionProvider('/application/class8-control', { clientAuthMethod: 'private_key_jwt' }, {
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    });
    const refusal = await refusalCodeOf(() => login(narrow, 'class8-control-subject'));
    const control = refusal === 'SSO_TOKEN_EXCHANGE_FAILED';

    record(8, 'client-auth-secret-basic', fixtureFor('client-auth-secret-basic').targets, allStamped, assertion, control, [
      `observed: ${JSON.stringify(observed)}`,
      `unadvertised method refusal: ${refusal}`,
    ]);
  }

  // ── the relation must cover what the DIGEST-LOCKED transcription names ──
  //
  // This is where mutations (i) and (ii) land. The relation is the
  // machine-readable form of the census; the transcription is the ratified
  // text. Dropping a target or a class from the relation leaves the
  // transcription still naming it, and the gate says which one by name.
  for (const classId of classesNamedInTranscription()) {
    if (!requiredClassIds().includes(classId as ShapeClassId)) {
      failures.push(
        `the census transcribes shape class ${classId} but the expected relation requires it of no target`,
      );
    }
  }
  for (const target of targetsNamedInTranscription()) {
    if (!EXPECTED_RELATION.some((row) => row.target === target)) {
      failures.push(`the census transcribes target '${target}' but the expected relation does not name it`);
    }
  }

  // ── the expected relation ──────────────────────────────────────────────
  for (const row of EXPECTED_RELATION) {
    for (const classId of row.requiredClasses) {
      const found = outcomes.find(
        (outcome) =>
          outcome.classId === classId &&
          outcome.targets.includes(row.target) &&
          outcome.entryPointStamped &&
          outcome.assertion === 'green' &&
          outcome.control === 'green',
      );
      if (!found) {
        failures.push(
          `the expected relation is unsatisfied: target '${row.target}' requires shape class ${classId}, ` +
            'which has no path-stamped result with both its assertion and its control green',
        );
      }
    }
  }

  return { ok: failures.length === 0, refusedToRun: null, failures, outcomes };
}

/** Claims a conforming back-channel logout token carries (§8.2). */
function backchannelClaims(provider: { issuer: string; clientId: string }): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: provider.issuer,
    aud: provider.clientId,
    iat: now,
    exp: now + 120,
    jti: crypto.randomUUID(),
    sub: 'class6-subject',
    events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
  };
}

async function refusalCodeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return '<no refusal>';
  } catch (error) {
    if (error instanceof SsoOutboundError) return error.code;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : String((error as Error).message ?? error);
  }
}

async function bindGroup(identityProviderId: string, externalGroupRef: string, name: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO groups (name, identity_provider_id, external_group_ref) VALUES ($1, $2, $3) RETURNING id`,
    [`${name} ${crypto.randomBytes(3).toString('hex')}`, identityProviderId, externalGroupRef],
  );
  return String(result.rows[0].id);
}

async function membershipCount(accountPrincipalId: string): Promise<number> {
  const result = await pool.query('SELECT count(*)::int AS n FROM group_members WHERE account_principal_id = $1', [
    accountPrincipalId,
  ]);
  return Number(result.rows[0].n);
}

/**
 * The Group ids this Account actually belongs to — the MEMBERSHIP leg the W3
 * carry-forward (`4502b4dd`) adds to classes 2, 3 and 5.
 *
 * W2 could only observe that a claim RESOLVED to a binding, because nothing in
 * W2 wrote a membership; class 5's "memberships unchanged" was therefore
 * vacuously true and said so in its own evidence. W3 supplies the writer, so
 * these classes now assert the thing §10a actually claims: that the value the
 * Identity provider sent became THIS person's membership, and that a claim the code
 * must refuse became none.
 */
async function membershipGroupIds(accountPrincipalId: string): Promise<string[]> {
  const result = await pool.query(
    'SELECT group_id FROM group_members WHERE account_principal_id = $1 ORDER BY group_id',
    [accountPrincipalId],
  );
  return result.rows.map((row) => String(row.group_id));
}

/**
 * The AZ-30 staleness watermark for one Identity provider, or null when the
 * Identity provider has never had a successful sync.
 *
 * Class 5 asserts this does NOT move on an overage: SS-13's fail-closed rule is
 * a pair — memberships untouched AND the watermark held back — because a
 * Identity provider that stopped being able to enumerate groups must surface
 * as stale
 * rather than as "successfully synced to nothing".
 */
async function syncWatermark(providerId: string): Promise<string | null> {
  const result = await pool.query(
    'SELECT last_success_at FROM directory_sync_state WHERE provider = $1',
    [providerId],
  );
  const value = result.rows[0]?.last_success_at ?? null;
  return value === null ? null : new Date(value).toISOString();
}

/** A throwaway RSA key so `private_key_jwt` has something to sign with. */
let cachedPem: string | null = null;
function privateKeyPem(): string {
  if (!cachedPem) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    cachedPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }
  return cachedPem;
}

/**
 * Scoped to the conformance host, so a re-run is idempotent.
 *
 * Identity providers are removed (which unbinds their Groups and cascades their
 * links); ACCOUNTS ARE NOT. `audit_events` is append-only by trigger, and the
 * accounts a previous run provisioned are named in that ledger — deleting them
 * would ask the ledger to forget, which it correctly refuses. Instead every run
 * mints its own subjects, so nothing collides and the ledger stays whole.
 */
async function resetConformanceState(): Promise<void> {
  // Links are removed FIRST and explicitly. The FK is ON DELETE RESTRICT since
  // review round 2 (R1 B1 / R3 B2) — a provider delete no longer destroys the
  // links beneath it, which is the point, so a fixture that wants a clean slate
  // has to say which links it is discarding.
  await pool.query(
    `DELETE FROM identity_links WHERE identity_provider_id IN
       (SELECT id FROM identity_providers WHERE issuer LIKE $1)`,
    [`${CONFORMANCE_HOST}%`],
  );
  await pool.query('DELETE FROM identity_providers WHERE issuer LIKE $1', [`${CONFORMANCE_HOST}%`]);
}
