#!/usr/bin/env node
'use strict';

/**
 * w2-red-proofs.js — the §4.5(a) mutation set, as a rerunnable procedure.
 *
 * Annex `e6dcadb9` §10b requires FIVE mutations, each with its own red proof:
 *
 *   (i)   remove a target                 -> the gate fails, NAMING it
 *   (ii)  remove a shape class            -> the gate fails, NAMING it
 *   (iii) entry-point bypass              -> the path-stamp leg fails
 *   (iv)  the substitution                -> that target's class assertion fails
 *   (v)   the hollowing, ONCE PER CLASS   -> that class's assertion goes RED
 *                                            while its control stays GREEN
 *
 * Eight hollowing runs, not one: round-5 F2 found class 2 still vacuous after
 * class 3 was repaired, because the repair was applied to the instance named
 * rather than to the shape. **Every class is hollowed and every class must fail
 * its own way.**
 *
 * And the hollowing removes the PROVIDER'S characteristic, never our
 * configuration (round-6 F2). Each mutation below therefore edits what the
 * Identity provider publishes or emits — a document, a token, an address — not
 * a board setting.
 *
 * For each mutation this script:
 *   1. copies the file byte-for-byte;
 *   2. applies the mutation, refusing unless its anchor appears EXACTLY once;
 *   3. runs the gate and requires the EXPECTED failure — not merely a failure;
 *   4. restores the copy and verifies the restore with a byte comparison;
 *   5. runs the gate again and requires it to PASS.
 *
 * A mutation whose gate stays green in step 3 is the finding: the gate does not
 * depend on the characteristic it claims to pin.
 *
 * Usage (from backend/), with DB_* pointed at a DISPOSABLE database carrying
 * the full migration chain:
 *
 *     node scripts/w2-red-proofs.js [--only <id>]
 *
 * Worker note (harness card `9b4e465a`): every run is a single `tsx` process.
 * This driver spawns no pool and caps itself at one child at a time, so it is
 * safe to run inside an agent session.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const CONFORMANCE = 'src/__tests__/conformance';
const VALIDATOR_PATH = 'src/services/identity/idTokenValidation.ts';
const SUITE_PATH = 'src/__tests__/ssoIdTokenRefusals.test.ts';

/** Each entry names the CLAIM it breaks, not just the bytes it edits. */
const MUTATIONS = [
  {
    id: 'M-i',
    claim: 'the census names a target the gate must find among the path-stamped results',
    file: `${CONFORMANCE}/census.ts`,
    find: "  { target: 'authentik', requiredClasses: [1, 2, 3, 7, 8] },\n",
    replace: '',
    expect: (out) => /the census transcribes target 'authentik'/.test(out),
    expectation: "the gate names the missing target 'authentik'",
  },
  {
    id: 'M-ii',
    claim: 'the census names a shape class the gate must find among the path-stamped results',
    file: `${CONFORMANCE}/census.ts`,
    find: "  { target: 'standard-oidc', requiredClasses: [1, 2, 3, 4, 5, 6, 7, 8] },",
    replace: "  { target: 'standard-oidc', requiredClasses: [1, 2, 3, 4, 6, 7, 8] },",
    expect: (out) => /transcribes shape class 5 but the expected relation requires it of no target/.test(out),
    expectation: 'the gate names shape class 5 as required of no target',
  },
  {
    id: 'M-iii',
    claim: 'every fixture reaches the SHARED relying-party entry point, not a shortcut',
    file: `${CONFORMANCE}/gate.ts`,
    find: 'const SHORTCUT_CLASS: number | null = null;',
    replace: 'const SHORTCUT_CLASS: number | null = 1;',
    expect: (out) => /did not traverse SsoAuthenticationService\.completeAuthentication/.test(out)
      && /RESULT class=1 .*stamped=false/.test(out),
    expectation: 'class 1 loses its path stamp and the gate says so',
  },
  {
    id: 'M-iv',
    claim: 'a target\'s fixture actually exhibits that target\'s characteristic',
    file: `${CONFORMANCE}/fixtures.ts`,
    // The substitution: swap two labels, so each class looks up the other's
    // fixture. Both substituted fixtures fail to exhibit the characteristic
    // their label claims.
    edits: [
      ["label: 'no-groups-claim-at-all',", "label: '__SUBSTITUTED_A__',"],
      ["label: 'truncated-groups-claim',", "label: 'no-groups-claim-at-all',"],
      ["label: '__SUBSTITUTED_A__',", "label: 'truncated-groups-claim',"],
    ],
    expect: (out) => /RESULT class=4 assertion=red/.test(out) && /RESULT class=5 assertion=red/.test(out),
    expectation: 'classes 4 and 5 both go red, because each now runs the other\'s fixture',
  },
];

/**
 * The hollowing, once per class. Each removes the PROVIDER'S characteristic
 * and nothing else — the label, the target and the path stamp all survive.
 */
const HOLLOWINGS = [
  {
    classId: 1,
    claim: 'two providers on one host resolve to their OWN endpoint sets',
    file: `${CONFORMANCE}/fixtures.ts`,
    find: "    issuerPath: '/application/beta',\n    documentOverrides: {},",
    replace:
      "    issuerPath: '/application/beta',\n    documentOverrides: { authorization_endpoint: 'https://idp.conformance.test/application/alpha/authorize' },",
  },
  {
    classId: 2,
    claim: 'the configured dotted path finds a claim the provider really nests',
    file: `${CONFORMANCE}/fixtures.ts`,
    find: '    idTokenClaims: { realm_access: { roles: [CLASS_2_CLAIM_VALUE] } },',
    replace: '    idTokenClaims: { realm_access_roles: [CLASS_2_CLAIM_VALUE] },',
  },
  {
    classId: 3,
    claim: 'three differently-shaped opaque values each bind on their own bytes',
    file: `${CONFORMANCE}/fixtures.ts`,
    find: '    idTokenClaims: { groups: [...CLASS_3_GROUP_VALUES] },',
    replace:
      '    idTokenClaims: { groups: [CLASS_3_GROUP_VALUES[0], CLASS_3_GROUP_VALUES[0], CLASS_3_GROUP_VALUES[0]] },',
  },
  {
    classId: 4,
    claim: 'the parser reports claim_absent because the PROVIDER sent no groups claim',
    file: `${CONFORMANCE}/fixtures.ts`,
    find: "    providerConfig: { groupsClaim: 'groups', groupBindingMode: 'off' },\n    idTokenClaims: {},",
    replace:
      "    providerConfig: { groupsClaim: 'groups', groupBindingMode: 'off' },\n    idTokenClaims: { groups: ['hollowed'] },",
  },
  {
    classId: 5,
    claim: 'an overage indicator is recorded as overage, distinguishably from absent',
    file: `${CONFORMANCE}/fixtures.ts`,
    find: "      _claim_names: { groups: 'src1' },",
    replace: "      _claim_names_absent: { groups: 'src1' },",
  },
  {
    classId: 6,
    claim: 'the validated document really does not advertise back-channel logout',
    file: `${CONFORMANCE}/fixtures.ts`,
    find: '    documentOverrides: { backchannel_logout_supported: false },',
    replace: '    documentOverrides: { backchannel_logout_supported: true },',
  },
  {
    classId: 7,
    claim: 'the issuer really is deployed on an address the public internet cannot reach',
    file: `${CONFORMANCE}/fixtures.ts`,
    find: "    resolvesTo: '10.0.0.5',",
    replace: "    resolvesTo: '93.184.216.34',",
  },
  {
    classId: 8,
    claim: 'the four client authentication methods are really four different methods',
    file: `${CONFORMANCE}/fixtures.ts`,
    find: "    providerConfig: { clientAuthMethod: 'client_secret_post' },",
    replace: "    providerConfig: { clientAuthMethod: 'client_secret_basic' },",
  },
];

/**
 * The §5.3 refusals. TWELVE mutations, not eleven with a spare — and each names
 * the ONE test that must go red, because a mutation that reddens "something"
 * proves only that the suite is coupled to the file.
 */
const REFUSAL_MUTATIONS = [
  {
    id: 'R1-alg',
    claim: 'refusal 1: the algorithm allowlist refuses `none` and the HMAC families',
    find: "  if (!(ALLOWED_ID_TOKEN_ALGS as readonly string[]).includes(alg)) {\n    refuse('ALG_NOT_ALLOWED', `the ID token algorithm '${alg}' is not an accepted asymmetric algorithm`);\n  }",
    replace: '  // mutation R1: the allowlist check removed',
    // Named at the vector that ISOLATES the allowlist. `alg=none is refused`
    // would stay green here, because refusal 1's advertised-algorithms
    // condition catches it on its own — which is how this gap was found.
    test: 'refusal 1: an HMAC algorithm is refused even when the Identity provider ADVERTISES it',
  },
  {
    id: 'R2-kid',
    claim: 'refusal 2: an unresolvable `kid` is refused rather than waved through',
    find: "    refuse('KID_UNRESOLVED', 'the ID token signing key could not be resolved');",
    replace: '    jwk = {} as crypto.JsonWebKey; // mutation R2: resolution failure swallowed',
    test: 'refusal 2: a kid the Identity provider does not publish is refused',
  },
  {
    id: 'R3-signature',
    claim: 'refusal 3: the signature is verified before any claim is trusted',
    find: '  if (!verifySignature(alg, `${headerSegment}.${payloadSegment}`, signature, jwk)) {',
    replace: '  if (false && !verifySignature(alg, `${headerSegment}.${payloadSegment}`, signature, jwk)) {',
    test: 'refusal 3: a token whose signature does not verify is refused',
  },
  {
    id: 'R4-iss',
    claim: 'refusal 4: the issuer is compared byte-for-byte, with no normalisation',
    find: "  if (claims.iss !== input.issuer) {\n    refuse('ISSUER_MISMATCH', 'the ID token issuer is not the configured issuer');\n  }",
    replace: '  // mutation R4: the issuer comparison removed',
    test: 'refusal 4: an issuer differing by one byte is refused (no normalisation)',
  },
  {
    id: 'R5-aud',
    claim: 'refusal 5: the audience must contain the configured client id',
    find: "  if (!audiences.includes(input.clientId)) {\n    refuse('AUDIENCE_MISMATCH', 'the ID token audience does not contain the configured client id');\n  }",
    replace: '  // mutation R5: the audience membership check removed',
    test: 'refusal 5: an audience that does not contain the client id is refused',
  },
  {
    id: 'R6-time',
    claim: 'refusal 6: an expired token is refused inside the clock skew',
    find: "  if (exp + skewMs <= now) refuse('TIME_WINDOW', 'the ID token has expired');",
    replace: '  // mutation R6: the expiry check removed',
    test: 'refusal 6: an expired token is refused',
  },
  {
    id: 'R7-nonce',
    claim: 'refusal 7: the nonce must match the pending row, and replay is one property',
    find: "  if (input.hashNonce(nonce) !== input.expectedNonceHash) {\n    refuse('NONCE_MISMATCH', 'the ID token nonce does not match the pending authentication request');\n  }",
    replace: '  // mutation R7: the nonce comparison removed',
    test: 'refusal 7: a nonce belonging to another pending request is refused',
  },
  {
    id: 'R8-sub',
    claim: 'refusal 8: the subject is present, non-empty and bounded at 255 bytes',
    find: "  if (typeof subject !== 'string' || subject.length === 0 || Buffer.byteLength(subject, 'utf8') > 255) {\n    refuse('SUBJECT_INVALID', 'the ID token subject is absent, empty or over 255 bytes');\n  }",
    replace: "  if (typeof subject !== 'string') {\n    refuse('SUBJECT_INVALID', 'the ID token subject is absent, empty or over 255 bytes');\n  }",
    test: 'refusal 8: a subject over 255 bytes is refused',
  },
  {
    id: 'R9-auth-time',
    claim: 'refusal 9: auth_time must post-date the step-up REQUEST, not "now"',
    // Re-anchored after the F2 repair removed the skew term from this line.
    // The skew-reintroducing form is NOT used as the mutation here, because
    // this vector's auth_time sits far enough before the request that adding a
    // 60s allowance would not flip it; that exact defect has its own
    // regression vector (R2-F2). A day-shift is what breaks THIS assertion.
    find: '    if (authTime < requestedAtMs) {',
    replace: '    if (authTime < requestedAtMs - 86400000) {',
    test: 'refusal 9: an auth_time predating the step-up request is refused',
  },
  {
    id: 'R10-required-claims',
    claim: 'refusal 10: every required claim carries a permitted value',
    find: '    const allowed = Array.isArray(permitted) ? permitted : [permitted];',
    replace: '    const allowed = Array.isArray(permitted) ? permitted : [permitted, String(actual)];',
    test: 'refusal 10: a required claim with a value outside the permitted set is refused',
  },
  {
    id: 'R11-userinfo',
    claim: 'refusal 11: a UserInfo response naming another subject is refused and discarded',
    find: "  if (typeof sub !== 'string' || sub !== expectedSubject) {",
    replace: "  if (false && (typeof sub !== 'string' || sub !== expectedSubject)) {",
    test: 'refusal 11: a UserInfo response naming a different subject is refused',
  },
  {
    id: 'R12-bounds',
    claim: 'refusal 12: an oversized token is refused BEFORE parsing',
    find: "  if (typeof input.token !== 'string' || Buffer.byteLength(input.token, 'utf8') > MAX_ID_TOKEN_BYTES) {",
    replace: "  if (typeof input.token !== 'string') {",
    test: 'refusal 12: an oversized token is refused BEFORE parsing',
  },
];

/** Run the refusal suite; jest reports a failing test as `● <suite> › <name>`. */
function runRefusalSuite() {
  const result = spawnSync(
    path.join(BACKEND, 'node_modules', '.bin', 'jest'),
    ['--runInBand', SUITE_PATH],
    { cwd: BACKEND, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } },
  );
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/**
 * Copy, mutate, require THE NAMED TEST to fail, restore byte-for-byte, require
 * the whole suite green again.
 */
function proveRefusal(mutation) {
  const absolute = path.join(BACKEND, VALIDATOR_PATH);
  const backup = `${absolute}.redproof-backup`;
  fs.copyFileSync(absolute, backup);
  let verdict;
  try {
    applyEdits(absolute, [[mutation.find, mutation.replace]]);
    const red = runRefusalSuite();
    if (red.status === 0) {
      verdict = { ok: false, why: 'the suite stayed GREEN under the mutation — no test depends on this check' };
    } else if (!red.output.includes(mutation.test)) {
      verdict = { ok: false, why: `the suite failed, but not at the named test: ${mutation.test}` };
    } else {
      verdict = { ok: true };
    }
  } catch (error) {
    verdict = { ok: false, why: error.message };
  } finally {
    fs.copyFileSync(backup, absolute);
    const restored = Buffer.compare(fs.readFileSync(absolute), fs.readFileSync(backup)) === 0;
    fs.unlinkSync(backup);
    if (!restored) {
      console.error(`  ${mutation.id}: RESTORE FAILED — ${VALIDATOR_PATH} does not match its backup`);
      process.exit(1);
    }
  }
  if (verdict.ok) {
    const green = runRefusalSuite();
    if (green.status !== 0) verdict = { ok: false, why: 'the suite did not return to GREEN after the restore' };
  }
  console.log(`  ${verdict.ok ? 'PROVEN ' : 'FAILED '} ${mutation.id}  ${mutation.claim}`);
  if (!verdict.ok) console.log(`           ${verdict.why}`);
  return verdict.ok;
}

/**
 * The acceptance vectors whose red proof is a PRODUCTION mutation rather than a
 * fixture edit. Each names the vector that must go red.
 */
const ACCEPTANCE_MUTATIONS = [
  {
    id: 'A-SS18-check-then-act',
    claim: 'SS-18: single-use is enforced by the WRITE — check-then-act would let both callbacks through',
    file: 'src/services/identity/SsoAuthenticationRequestService.ts',
    find: `    const result = await pool.query(
      \`UPDATE sso_authentication_requests
          SET consumed_at = now(), consumed_outcome = 'attempted'
        WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id, identity_provider_id, nonce_hash, redirect_uri, return_ref,
                  max_age_requested, requested_at, expires_at, pkce_verifier_ct, pkce_key_id\`,
      [hashOpaqueValue(state)],
    );`,
    replace: `    const found = await pool.query(
      \`SELECT id, identity_provider_id, nonce_hash, redirect_uri, return_ref,
              max_age_requested, requested_at, expires_at, pkce_verifier_ct, pkce_key_id
         FROM sso_authentication_requests
        WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()\`,
      [hashOpaqueValue(state)],
    );
    if (found.rows[0]) {
      // The window check-then-act opens is real but short; in a deployment it
      // is network latency. Holding it open here makes the race OBSERVABLE
      // rather than creating it - and no delay can make the one-statement
      // conditional consume fail, because it has no window at all.
      await new Promise((resolve) => setTimeout(resolve, 40));
      await pool.query(
        \`UPDATE sso_authentication_requests SET consumed_at = now(), consumed_outcome = 'attempted' WHERE id = $1\`,
        [found.rows[0].id],
      );
    }
    const result = found;`,
    vector: 'SS-18-concurrency',
  },
  {
    id: 'A-TSS13-origin-fallback',
    claim: 'T-SS13: an unset public origin REFUSES; a fallback is the permissive-proxy defect itself',
    file: 'src/services/identity/ssoRedirectUri.ts',
    find: `    throw new SsoPublicOriginError(
      \`\${SSO_PUBLIC_ORIGIN_ENV} must be set before an Identity provider can be used: the redirect_uri is constructed from it and from nothing else (T-SS13)\`,
    );`,
    replace: `    // MUTATION: the "sensible default" T-SS13 exists to forbid.
    return 'https://attacker.surface.test/api';`,
    vector: 'T-SS13-unset-origin-refuses-rather-than-falling-back',
  },
  {
    id: 'A-TSS13-header-derived-origin',
    claim: 'T-SS13: the redirect_uri must not move when a request header moves',
    file: 'src/routes/sso.ts',
    find: `    const body = (req.body ?? {}) as Record<string, unknown>;
    assertNotACallerComposedTarget(body.returnRef);`,
    replace: `    const body = (req.body ?? {}) as Record<string, unknown>;
    assertNotACallerComposedTarget(body.returnRef);
    // MUTATION: a "convenience" that derives the deployment's public origin
    // from the request, which is exactly the defect T-SS13 names.
    process.env.RELAYHALL_PUBLIC_API_URL = \`\${req.protocol}://\${req.hostname}/api\`;`,
    vector: 'T-SS13-redirect-uri-header-independence',
  },
  {
    id: 'A-SS56-caller-steered-token-endpoint',
    claim: 'SS-6: no caller-controllable input may reach the outbound destination',
    file: 'src/services/identity/SsoAuthenticationService.ts',
    find: `    // ── 5. token exchange, at THIS ROW'S Identity provider (T-SS4) ─────────
    const tokens = await this.exchangeCode(provider, metadata, input.code, pending.redirectUri, pkceVerifier);`,
    replace: `    // ── 5. token exchange, at THIS ROW'S Identity provider (T-SS4) ─────────
    // MUTATION: treat a URL-shaped authorization code as the place to redeem it.
    // The code is the caller-controllable input that survives every earlier
    // check, because an opaque code cannot be validated before redemption.
    if (input.code && input.code.startsWith('http')) {
      (metadata as { tokenEndpoint: string }).tokenEndpoint = input.code;
    }
    const tokens = await this.exchangeCode(provider, metadata, input.code, pending.redirectUri, pkceVerifier);`,
    vector: 'SS-5-SS-6-destination-steering',
  },
  {
    id: 'A-SS3-scope-map-weakened',
    claim: 'SS-3: /identity-providers sits at root, not at any lesser requirement',
    file: 'src/utils/scopeMap.ts',
    find: `  { pattern: /^\\/identity-providers(\\/|$)/, scope: 'root' },`,
    replace: `  // MUTATION: the family A23.6 declined to mint, minted.
  { pattern: /^\\/identity-providers(\\/|$)/, scope: 'authenticated' },`,
    vector: 'SS-3-identity-providers-root-gated',
  },
  {
    id: 'A-SS7-canary-swallows',
    claim: 'SS-7: a corrupted provider secret must fail LOUDLY, not be skipped',
    file: 'src/utils/credentialCrypto.ts',
    find: `      } catch {
        throw new CredentialCryptoError(
          'IDENTITY_PROVIDER_CANARY_FAILED',
          \`identity provider \${row.id}: the stored \${what} does not decrypt under its declared key (SS-7) — refusing to run silently\`,
        );
      }`,
    replace: `      } catch {
        // MUTATION: the silent skip a canary exists to make impossible.
        continue;
      }`,
    vector: 'SS-7-provider-secret-canary',
  },
];

function runAcceptance() {
  const result = spawnSync('node', [path.join(BACKEND, 'scripts', 'w2-acceptance.js')], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: process.env,
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/** Copy, mutate, require THAT VECTOR to go red, restore, require green again. */
function proveAcceptance(mutation) {
  const absolute = path.join(BACKEND, mutation.file);
  const backup = `${absolute}.redproof-backup`;
  fs.copyFileSync(absolute, backup);
  let verdict;
  try {
    applyEdits(absolute, [[mutation.find, mutation.replace]]);
    const red = runAcceptance();
    if (red.status === 0) {
      verdict = { ok: false, why: 'the vectors stayed GREEN under the mutation — none depends on this property' };
    } else if (!new RegExp(`VECTOR id=${mutation.vector} ok=false`).test(red.output)) {
      verdict = { ok: false, why: `the vectors failed, but not at ${mutation.vector}` };
    } else {
      verdict = { ok: true };
    }
  } catch (error) {
    verdict = { ok: false, why: error.message };
  } finally {
    fs.copyFileSync(backup, absolute);
    const restored = Buffer.compare(fs.readFileSync(absolute), fs.readFileSync(backup)) === 0;
    fs.unlinkSync(backup);
    if (!restored) {
      console.error(`  ${mutation.id}: RESTORE FAILED — ${mutation.file} does not match its backup`);
      process.exit(1);
    }
  }
  if (verdict.ok) {
    const green = runAcceptance();
    if (green.status !== 0) verdict = { ok: false, why: 'the vectors did not return to GREEN after the restore' };
  }
  console.log(`  ${verdict.ok ? 'PROVEN ' : 'FAILED '} ${mutation.id}  ${mutation.claim}`);
  if (!verdict.ok) console.log(`           ${verdict.why}`);
  return verdict.ok;
}

function runGate() {
  const result = spawnSync('node', [path.join(BACKEND, 'scripts', 'w2-conformance-gate.js')], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: process.env,
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function applyEdits(absolute, edits) {
  let source = fs.readFileSync(absolute, 'utf8');
  for (const [find, replace] of edits) {
    const occurrences = source.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`anchor appears ${occurrences} times, refusing to mutate: ${find.slice(0, 60)}`);
    }
    source = source.split(find).join(replace);
  }
  fs.writeFileSync(absolute, source);
}

/** Copy, mutate, require the expected red, restore byte-for-byte, require green. */
function prove(label, claim, file, edits, expect, expectation) {
  const absolute = path.join(BACKEND, file);
  const backup = `${absolute}.redproof-backup`;
  fs.copyFileSync(absolute, backup);
  let verdict;
  try {
    applyEdits(absolute, edits);
    const red = runGate();
    if (red.status === 0) {
      verdict = { ok: false, why: 'the gate stayed GREEN under the mutation — it does not depend on this characteristic' };
    } else if (!expect(red.output)) {
      verdict = { ok: false, why: `the gate failed, but not with the expected result (${expectation})` };
    } else {
      verdict = { ok: true };
    }
  } catch (error) {
    verdict = { ok: false, why: error.message };
  } finally {
    fs.copyFileSync(backup, absolute);
    const restored = Buffer.compare(fs.readFileSync(absolute), fs.readFileSync(backup)) === 0;
    fs.unlinkSync(backup);
    if (!restored) {
      console.error(`  ${label}: RESTORE FAILED — ${file} does not match its backup`);
      process.exit(1);
    }
  }

  if (verdict.ok) {
    const green = runGate();
    if (green.status !== 0) {
      verdict = { ok: false, why: 'the gate did not return to GREEN after the restore' };
    }
  }

  console.log(`  ${verdict.ok ? 'PROVEN ' : 'FAILED '} ${label}  ${claim}`);
  if (!verdict.ok) console.log(`           ${verdict.why}`);
  return verdict.ok;
}

function main() {
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];

  console.log('');
  console.log('W2 red proofs — §5.3 twelve refusals, then §4.5(a) five mutations with the hollowing once per class');
  console.log('');

  const sectionIndex = process.argv.indexOf('--section');
  const section = sectionIndex === -1 ? 'all' : process.argv[sectionIndex + 1];
  let allProven = true;

  // ── §5.3: the twelve refusals. No database needed. ─────────────────────
  if (section === 'all' || section === 'refusals') {
    const refusalBaseline = runRefusalSuite();
    if (refusalBaseline.status !== 0) {
      console.error('the refusal suite is not green before any mutation; nothing below would mean anything');
      console.error(refusalBaseline.output.slice(-2000));
      process.exit(1);
    }
    console.log('  baseline: the §5.3 refusal suite is GREEN before any mutation');
    if (REFUSAL_MUTATIONS.length !== 12) {
      console.error(`  the DoD asks for TWELVE refusal mutations; this driver carries ${REFUSAL_MUTATIONS.length}`);
      process.exit(1);
    }
    for (const mutation of REFUSAL_MUTATIONS) {
      if (only && only !== mutation.id) continue;
      allProven = proveRefusal(mutation) && allProven;
    }
    console.log('');
  }

  // ── acceptance vectors whose red proof mutates PRODUCTION ──────────────
  if (section === 'all' || section === 'acceptance') {
    const acceptanceBaseline = runAcceptance();
    if (acceptanceBaseline.status !== 0) {
      console.error('the acceptance vectors are not green before any mutation; nothing below would mean anything');
      console.error(acceptanceBaseline.output.slice(-2000));
      process.exit(1);
    }
    console.log('  baseline: the acceptance vectors are GREEN before any mutation');
    for (const mutation of ACCEPTANCE_MUTATIONS) {
      if (only && only !== mutation.id) continue;
      allProven = proveAcceptance(mutation) && allProven;
    }
    console.log('');
  }

  if (section === 'acceptance') {
    if (!allProven) {
      console.error('ACCEPTANCE RED PROOFS INCOMPLETE — see the FAILED lines above');
      process.exit(1);
    }
    console.log('Acceptance red proofs COMPLETE.');
    process.exit(0);
  }

  if (section === 'refusals') {
    if (!allProven) {
      console.error('§5.3 RED PROOFS INCOMPLETE — see the FAILED lines above');
      process.exit(1);
    }
    console.log('§5.3 red proofs COMPLETE: twelve refusals, twelve named tests, every restore byte-verified.');
    process.exit(0);
  }

  const baseline = runGate();
  if (baseline.status !== 0) {
    console.error('the gate is not green before any mutation; nothing below would mean anything');
    console.error(baseline.output.slice(-2000));
    process.exit(1);
  }
  console.log('  baseline: the gate is GREEN before any mutation');
  console.log('');

  for (const mutation of MUTATIONS) {
    if (only && only !== mutation.id) continue;
    const edits = mutation.edits ?? [[mutation.find, mutation.replace]];
    allProven =
      prove(mutation.id, mutation.claim, mutation.file, edits, mutation.expect, mutation.expectation) && allProven;
  }

  for (const hollowing of HOLLOWINGS) {
    const id = `M-v.${hollowing.classId}`;
    if (only && only !== id) continue;
    // The property is precise: THAT class's assertion goes red while THAT
    // class's control stays green. A hollowing that reddened the control too
    // would prove the fixture was removed, not that the class observes a
    // characteristic.
    const expect = (out) => new RegExp(`RESULT class=${hollowing.classId} assertion=red control=green`).test(out);
    allProven =
      prove(
        id,
        `hollowing class ${hollowing.classId}: ${hollowing.claim}`,
        hollowing.file,
        [[hollowing.find, hollowing.replace]],
        expect,
        `class ${hollowing.classId} assertion=red control=green`,
      ) && allProven;
  }

  console.log('');
  if (!allProven) {
    console.error('§4.5(a) RED PROOFS INCOMPLETE — see the FAILED lines above');
    process.exit(1);
  }
  console.log('RED PROOFS COMPLETE: twelve §5.3 refusals, plus §4.5(a) five mutations and eight hollowings.');
  process.exit(0);
}

main();
