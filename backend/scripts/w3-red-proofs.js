#!/usr/bin/env node
/**
 * w3-red-proofs.js — SS-W3's red proofs (card `2ae39bda` subtask [3]).
 *
 * A test that passes proves nothing about a property until you have watched it
 * FAIL when the property is removed. Every mutation below deletes exactly one
 * mechanism this wave built, and each names the ONE check that must go red —
 * because a mutation that reddens "something" proves only that the suite is
 * coupled to the file (the W2 lesson, evidence `6f63a606`).
 *
 * Two further rules this driver inherits, both paid for:
 *   - **a mutation that fails to COMPILE is not a red proof.** Three W2
 *     mutations were rejected by `noUnusedLocals` and control-flow narrowing
 *     and became type errors rather than test failures. Each mutation here is
 *     written to type-check.
 *   - **the restore is byte-verified.** A driver that leaves a mutated tree
 *     behind is worse than no driver.
 *
 * Run with DB_* pointed at a DISPOSABLE migrated database (the live proofs and
 * the conformance gate both need one):
 *
 *     DB_HOST=... node scripts/w3-red-proofs.js
 *
 * Single-process, no worker pool (harness card `9b4e465a`).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const SSO_SERVICE = 'src/services/identity/SsoAuthenticationService.ts';
const WHITELIST = 'src/services/identity/ssoLoginWhitelist.ts';
const GROUP_SERVICE = 'src/services/GroupService.ts';
const LOGIN_SESSIONS = 'src/services/LoginSessionService.ts';
const CENSUS_TEST = 'src/__tests__/ssoSessionMintCensus.test.ts';
const LOGOUT_SERVICE = 'src/services/identity/SsoLogoutService.ts';
const STEP_UP_SERVICE = 'src/services/StepUpService.ts';
const WEBSOCKET = 'src/services/websocket.ts';

/** Run the live behavioural proofs; returns the named checks that failed. */
function runLive() {
  const result = spawnSync('node', [path.join(BACKEND, 'scripts', 'test-w3-group-sync-live.js')], {
    cwd: BACKEND, encoding: 'utf8', env: process.env,
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/** Run the SS-9 census; returns jest's report. */
function runCensus() {
  // ── THE CENSUS DECLARES A HEAP FLOOR, AND THIS DRIVER IMPOSES IT ──
  //
  // Below that floor the census fails with a named message, which the driver
  // would otherwise report as mutations FAILING for reasons that have nothing
  // to do with the mutations. Round-3 review met that and isolated the cause by
  // hand. The first fix declined to override a `NODE_OPTIONS` the caller had
  // already set — and round-4 review met the SAME failure, because in an agent
  // harness that value is INJECTED, not chosen. A drill whose failures do not
  // mean what they say is worse than no drill, so the floor is now imposed: any
  // smaller cap is replaced.
  const env = { ...process.env };
  const withoutCap = (env.NODE_OPTIONS || '').replace(/--max-old-space-size=[0-9]+/g, '').trim();
  env.NODE_OPTIONS = `${withoutCap} --max-old-space-size=4096`.trim();
  const result = spawnSync(path.join(BACKEND, 'node_modules', '.bin', 'jest'), ['--runInBand', CENSUS_TEST], {
    cwd: BACKEND, encoding: 'utf8', env,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  // ...and if it reports the floor ANYWAY, say so in those words. A verdict of
  // "this mutation was not detected" must never stand for "the census could not
  // run at all".
  if (/needs about [0-9]+ MiB of heap/.test(output)) {
    console.error('  the census could not run: it reported its heap floor even after the driver raised it.');
    console.error(`  NODE_OPTIONS was: ${env.NODE_OPTIONS}`);
    process.exit(2);
  }
  return { status: result.status, output };
}

function runGate() {
  const result = spawnSync('node', [path.join(BACKEND, 'scripts', 'w2-conformance-gate.js')], {
    cwd: BACKEND, encoding: 'utf8', env: process.env,
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/** The A23 added-line naming sweep, run from the repository root it diffs. */
function runAudit() {
  const result = spawnSync('python3', [path.join(BACKEND, 'scripts', 'w3-naming-audit.py')], {
    cwd: path.resolve(BACKEND, '..'), encoding: 'utf8', env: process.env,
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/** Does the whole backend type-check as it stands right now? */
function typeChecks() {
  const result = spawnSync(path.join(BACKEND, 'node_modules', '.bin', 'tsc'), ['--noEmit'], {
    cwd: BACKEND, encoding: 'utf8', env: process.env,
  });
  return result.status === 0;
}

function applyEdits(absolute, edits) {
  let source = fs.readFileSync(absolute, 'utf8');
  for (const [find, replace] of edits) {
    const occurrences = source.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`anchor appears ${occurrences} times, refusing to mutate: ${find.slice(0, 70)}`);
    }
    source = source.split(find).join(replace);
  }
  fs.writeFileSync(absolute, source);
}

/**
 * Copy, mutate, require the NAMED failure, restore byte-for-byte, require green.
 */
function prove(mutation, run) {
  const absolute = path.join(BACKEND, mutation.file);
  const backup = `${absolute}.w3redproof-backup`;
  const probe = mutation.probe ? path.join(BACKEND, mutation.probe.file) : null;
  const dropProbe = () => { if (probe && fs.existsSync(probe)) fs.unlinkSync(probe); };
  fs.copyFileSync(absolute, backup);
  let verdict;
  try {
    // A probe is a real call a caller could write. Before the mutation it must
    // be REJECTED by the compiler — otherwise the mutation is not what admits
    // it and the proof would be about nothing.
    if (probe) {
      fs.writeFileSync(probe, mutation.probe.content);
      const acceptedAlready = typeChecks();
      dropProbe();
      if (acceptedAlready) {
        throw new Error('the probe already type-checks on the CLEAN tree — it proves nothing');
      }
    }
    applyEdits(absolute, mutation.edits);
    // ...and after it, the same call must COMPILE. A mutation that only breaks
    // the build is not an evasion; it is a typo, and reddening under it would
    // be a false proof (the standing rule in this driver's header).
    if (probe) {
      fs.writeFileSync(probe, mutation.probe.content);
      if (!typeChecks()) {
        throw new Error('the mutated tree does not type-check — a compile error is not an evasion');
      }
    }
    const red = run();
    if (mutation.expectGreen) {
      // An over-broad gate is deleted by whoever it blocks, so a gate's SCOPE
      // is a property worth drilling too: this shape must NOT be flagged, and
      // the drill fails if it is.
      verdict = red.status === 0
        ? { ok: true }
        : { ok: false, why: 'the gate FLAGGED this shape — it reaches past what it governs' };
    } else if (red.status === 0) {
      verdict = { ok: false, why: 'the checks stayed GREEN under the mutation — none depends on this mechanism' };
    } else if (!mutation.expect(red.output)) {
      verdict = { ok: false, why: `it failed, but not at the named check (${mutation.named})` };
    } else {
      verdict = { ok: true };
    }
  } catch (error) {
    verdict = { ok: false, why: error.message };
  } finally {
    dropProbe();
    fs.copyFileSync(backup, absolute);
    const restored = Buffer.compare(fs.readFileSync(absolute), fs.readFileSync(backup)) === 0;
    fs.unlinkSync(backup);
    if (!restored) {
      console.error(`  ${mutation.id}: RESTORE FAILED — ${mutation.file} does not match its backup`);
      process.exit(1);
    }
  }
  if (verdict.ok) {
    const green = run();
    if (green.status !== 0) verdict = { ok: false, why: 'the checks did not return to GREEN after the restore' };
  }
  console.log(`  ${verdict.ok ? 'PROVEN ' : 'FAILED '} ${mutation.id}  ${mutation.claim}`);
  if (!verdict.ok) console.log(`           ${verdict.why}`);
  return verdict.ok;
}

/** A check name is "named red" when the live driver reports it as FAIL. */
const liveNamed = (name) => (output) =>
  new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":\\s*\\{`).test(output);

/**
 * A census test is "named red" when jest prints a FAILURE BLOCK for it.
 *
 * Round-7 review observed that matching the bare test name is weaker than the
 * PROVEN label it earns: with one suite selected jest lists every test it ran,
 * passing ones included, so a mutation whose named test PASSED still matches
 * while an unrelated failure supplies the non-zero exit. The bullet prefix is
 * printed only for failures, so this asks whether THIS test failed rather than
 * whether it ran.
 *
 * The seam mutations below are the first to use it. Retro-fitting the earlier
 * census mutations would rewrite evidence this round is not scoped to touch —
 * several of them name a fragment rather than a whole test — so that is carded
 * rather than done here.
 */
const censusFailed = (name) => (output) =>
  new RegExp(`●[^\\n]*›\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(output);

const BEHAVIOUR_MUTATIONS = [
  {
    id: 'M-w3.1',
    claim: 'the snapshot seam is ACCOUNT-SCOPED — the full-snapshot method would wipe every other Account',
    file: SSO_SERVICE,
    named: 'T-SS14',
    // The exact defect T-SS14 names, reproduced verbatim: call the
    // full-snapshot method with ONE Account's entries. It compiles, it looks
    // reasonable, and it deletes every other Account's directory rows.
    edits: [[
      'await groupService.applyAccountDirectorySnapshot(\n        provider.id,\n        link.accountPrincipalId,\n        appliedGroupIds,',
      'await groupService.applyDirectorySnapshot(\n        provider.id,\n        appliedGroupIds.map((groupId) => ({ groupId, accountPrincipalId: link.accountPrincipalId })),',
    ]],
    expect: liveNamed("T-SS14: another Account's directory rows are NOT touched by this login"),
  },
  {
    id: 'M-w3.2',
    claim: 'SS-13 fails CLOSED — an unusable claim applies no snapshot at all',
    file: SSO_SERVICE,
    named: 'SS-13 overage leaves membership unchanged',
    // "Member of nothing": the reading SS-13 forbids, and the one a naive
    // implementation reaches for.
    edits: [[
      "if (provider.groupBindingMode === 'claim' && groupClaim.verdict === 'claim_present') {",
      "if (provider.groupBindingMode === 'claim') {",
    ]],
    expect: liveNamed('SS-13: an overage leaves a NON-EMPTY membership set unchanged'),
  },
  {
    id: 'M-w3.3',
    claim: 'the whitelist REFUSES — removing the refusal admits a non-member',
    file: SSO_SERVICE,
    named: 'whitelist non-member refused',
    edits: [['    if (!whitelist.admitted) {', '    if (false && !whitelist.admitted) {']],
    expect: liveNamed('whitelist: a non-member is refused by name'),
  },
  {
    id: 'M-w3.4',
    claim: 'an ENABLED whitelist with an EMPTY list fails CLOSED, not open',
    file: WHITELIST,
    named: 'whitelist enabled + empty refuses',
    edits: [[
      "    return { admitted: false, reason: 'no_allowed_groups', allowedGroupCount: 0, matchedGroupIds: [] };",
      "    return { admitted: true, reason: 'whitelist_disabled', allowedGroupCount: 0, matchedGroupIds: [] };",
    ]],
    expect: liveNamed('whitelist enabled + EMPTY list refuses (fail closed)'),
  },
  {
    id: 'M-w3.5',
    claim: 'membership admits REGARDLESS OF SOURCE — filtering to directory locks out a local grant',
    file: WHITELIST,
    named: 'local-source membership admits',
    edits: [[
      '             AND m.account_principal_id = $2',
      "             AND m.account_principal_id = $2\n             AND m.source = 'directory'",
    ]],
    expect: liveNamed('W3-D2: a LOCAL-source membership admits a federated login'),
  },
  {
    id: 'M-w3.6',
    claim: 'a Group that gates login cannot be DELETED',
    file: GROUP_SERVICE,
    named: 'group delete refusal',
    edits: [['      if (gating.rows.length > 0) {', '      if (false && gating.rows.length > 0) {']],
    expect: liveNamed('a Group that gates login cannot be deleted (named refusal)'),
  },
  {
    id: 'M-w3.7',
    claim: 'ID-token disposal is bound to LOGIN-SESSION DEATH on the unlink path too',
    file: 'src/services/identity/IdentityLinkService.ts',
    named: 'SS-9 census: enumerated lifecycle column sets',
    // The defect this wave's census FOUND on its first run: an unlink that
    // revokes the login session but leaves the retained ID token on the dead row.
    edits: [[
      "            SET revoked_at = now(), revoke_reason = 'admin',\n                id_token_ct = NULL, id_token_key_id = NULL",
      "            SET revoked_at = now(), revoke_reason = 'admin'",
    ]],
    expect: (output) => /every production UPDATE writes one of the enumerated lifecycle column sets/.test(output),
    run: runCensus,
  },
  {
    id: 'M-w3.8',
    claim: 'disposal covers the SILENT login-session deaths too — expiry and idle timeout, not only revocation',
    file: LOGIN_SESSIONS,
    named: 'SSO-R16 expiry disposal',
    // The exact shape of review R2 finding F1: disposal that only follows an
    // explicit revocation. It compiles, it passes the SS-9 census (whose
    // permitted column sets are unchanged), and it leaves a retained encrypted
    // ID token on every login session that dies the silent way.
    // The mutation KEEPS $1 bound. Dropping the parameter made the statement
    // raise a bind error instead of failing a test, and a mutation that ERRORS
    // proves nothing — the same rule as this driver's no-type-errors note, one
    // layer down in the database.
    edits: [[
      "          AND (revoked_at IS NOT NULL OR expires_at <= now() OR last_seen_at <= $1)",
      "          AND (revoked_at IS NOT NULL AND $1::timestamptz IS NOT NULL)",
    ]],
    expect: liveNamed('SSO-R16: a login session dead by ABSOLUTE EXPIRY has its retained ID token disposed'),
  },
  {
    id: 'M-w3.9',
    claim: 'the OVERAGE form of T-SS18 is load-bearing — a wiping overage breaks parity, not just membership',
    file: SSO_SERVICE,
    named: 'T-SS18 overage-form memberships unchanged',
    // Review R2 finding F2 asked for this explicitly: red-prove that removing
    // retained-snapshot parity makes the NAMED overage vector fail. The edit is
    // SS-13's fail-closed guard again, but the expectation is the parity
    // vector's own check — the same mutation must be shown to redden THIS
    // sentence, or the sentence is riding on another test's coverage.
    edits: [[
      "if (provider.groupBindingMode === 'claim' && groupClaim.verdict === 'claim_present') {",
      "if (provider.groupBindingMode === 'claim') {",
    ]],
    expect: liveNamed('T-SS18 overage form: memberships are UNCHANGED across the overage login'),
  },
  {
    id: 'M-w3.10',
    claim: 'the ACCOUNT CLAUSE inside the method is load-bearing — an unscoped DELETE is caught',
    file: GROUP_SERVICE,
    named: 'T-SS14',
    // Review R1's non-blocking finding, promoted to a permanent drilled
    // mutation: M-w3.1 swaps the whole METHOD, which any fixture would notice.
    // This one leaves the method in place and removes only the account clause
    // from its DELETE — the subtler defect, and the one the fixture could not
    // see until another Account was put in the blast radius.
    // Template literals, so the two-line anchor carries a real newline
    // without an escape. The SQL alone is NOT unique — the full-snapshot
    // method above carries the identical statement — so the anchor includes
    // the parameter line, which names this method's own variable.
    edits: [[
      `'DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2',
            [row.group_id, accountPrincipalId],`,
      `'DELETE FROM group_members WHERE group_id = $1 AND ($2::uuid IS NOT NULL)',
            [row.group_id, accountPrincipalId],`,
    ]],
    expect: liveNamed("T-SS14: another Account's directory rows are NOT touched by this login"),
  },
];
const CENSUS_MUTATIONS = [
  {
    id: 'M-ss9.1',
    claim: 'a SECOND production INSERT into auth_sessions fails the census, naming it',
    file: LOGIN_SESSIONS,
    named: 'exactly ONE production INSERT',
    edits: [[
      '  /** Liveness touch — the ONLY column this lifecycle update is permitted. */',
      '  async shadowMint(principalId: string): Promise<void> {\n'
        + "    await pool.query('INSERT INTO auth_sessions (id, principal_id, token_hash, expires_at) VALUES ($1,$2,$3,now())',\n"
        + '      [crypto.randomUUID(), principalId, principalId]);\n'
        + '  }\n\n'
        + '  /** Liveness touch — the ONLY column this lifecycle update is permitted. */',
    ]],
    expect: (output) => /exactly ONE production INSERT into auth_sessions/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.2',
    claim: 'ANY production statement setting role_snapshot fails the census, naming it',
    file: SSO_SERVICE,
    named: 'no production statement writes role_snapshot',
    edits: [[
      '    await identityLinkService.touch(link.id);',
      "    await pool.query('UPDATE auth_sessions SET role_snapshot = $2 WHERE id = $1', [session.sessionId, 'admin']);\n"
        + '    await identityLinkService.touch(link.id);',
    ]],
    expect: (output) => /NO production statement writes role_snapshot/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.3',
    claim: 'the MINT INPUT accepting a role snapshot fails its CONTRACT test — SS-9 admits no exception',
    file: LOGIN_SESSIONS,
    named: 'EVERY callable signature of the mint refuses a role snapshot',
    // Round-2 review R3 finding B1: the previous M-ss9.3 added role_snapshot to
    // the mint's INSERT column list, which is the SINK rule M-ss9.2 already
    // proves. The annex asks for a different mutation: "the mint accepting a
    // non-NULL snapshot -> its contract test fails". This is that mutation. It
    // changes the TYPED INPUT only and still compiles.
    edits: [[
      `    oidcSid?: string | null;`,
      `    roleSnapshot?: string | null;
    oidcSid?: string | null;`,
    ]],
    expect: (output) => /EVERY callable signature of the mint refuses a role snapshot/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.4',
    claim: 'an INDEX SIGNATURE on the mint input is caught too — the contract is structural, not lexical',
    file: LOGIN_SESSIONS,
    named: 'EVERY callable signature of the mint refuses a role snapshot',
    // Round-3 review R3 finding B1, promoted to a permanent drilled mutation.
    // The first contract test scanned the source for four member spellings, so
    // an index signature accepted `roleSnapshot: 'admin'` and left 23/23 green.
    edits: [[
      `    oidcSid?: string | null;`,
      `    [key: string]: unknown;
    oidcSid?: string | null;`,
    ]],
    expect: (output) => /EVERY callable signature of the mint refuses a role snapshot/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.5',
    claim: 'a FACTORED type is caught too — an intersected role snapshot is still one resolved type',
    file: LOGIN_SESSIONS,
    named: 'EVERY callable signature of the mint refuses a role snapshot',
    edits: [[
      `  async mint(input: {`,
      `  async mint(input: { roleSnapshot?: string | null } & {`,
    ]],
    expect: (output) => /EVERY callable signature of the mint refuses a role snapshot/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.6',
    claim: 'a GENERIC OVERLOAD is caught too — every callable signature must be closed',
    file: LOGIN_SESSIONS,
    named: 'EVERY callable signature of the mint refuses a role snapshot',
    edits: [[
      `  async mint(input: {`,
      `  async mint<T extends { principalId: string }>(input: T): Promise<MintedLoginSession>;
  async mint(input: {`,
    ]],
    expect: (output) => /EVERY callable signature of the mint refuses a role snapshot/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.7',
    claim: 'the EXPORTED surface is the contract: widening it reddens the census, and the forbidden call really compiles',
    file: LOGIN_SESSIONS,
    named: 'EVERY callable signature of the mint refuses a role snapshot',
    // Round-5 review R3 finding B1. Consumers do not call the class; they call
    // the exported singleton, whose type may be wider than the body it wraps.
    edits: [[
      `export const loginSessionService = new LoginSessionService();`,
      `interface WidenedLoginSessionService extends LoginSessionService {
  mint<T extends { principalId: string }>(input: T): Promise<MintedLoginSession>;
}

export const loginSessionService = new LoginSessionService() as WidenedLoginSessionService;`,
    ]],
    probe: {
      file: 'src/ss9ExportedSurfaceProbe.ts',
      content: `// Written and deleted by scripts/w3-red-proofs.js (M-ss9.7). Never committed.
import { loginSessionService } from './services/LoginSessionService';

export const ss9ForbiddenCall = () =>
  loginSessionService.mint({ principalId: 'p', roleSnapshot: 'admin' });
`,
    },
    expect: (output) => /EVERY callable signature of the mint refuses a role snapshot/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.8',
    claim: 'a WIDENED RE-EXPORT of the singleton reddens the importer census, and the laundered call really compiles',
    file: LOGOUT_SERVICE,
    named: 'OUTSIDE a function body, no production module but the definer touches the singleton',
    // Round-6 review R2's construction, reproduced where it was filed: a second
    // production module hands the singleton out through an interface that
    // accepts anything with a principal id. The probe is that consumer, required
    // to be REFUSED by the compiler before the mutation and ACCEPTED after it.
    edits: [[
      `export const ssoLogoutService = new SsoLogoutService();`,
      `interface WidenedLoginSessions {
  mint<T extends { principalId: string }>(input: T): Promise<unknown>;
}

export const widenedLoginSessions = loginSessionService as unknown as WidenedLoginSessions;

export const ssoLogoutService = new SsoLogoutService();`,
    ]],
    probe: {
      file: 'src/ss9ImporterCensusProbe.ts',
      content: `// Written and deleted by scripts/w3-red-proofs.js (M-ss9.8). Never committed.
import { widenedLoginSessions } from './services/identity/SsoLogoutService';

export const ss9LaunderedMint = () =>
  widenedLoginSessions.mint({ principalId: 'p', roleSnapshot: 'admin' });
`,
    },
    expect: (output) => /OUTSIDE a function body, no production module but the definer touches the singleton/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.9',
    claim: 'a PLAIN RENAME re-export reddens it too — the rule is about the singleton, not about the `as` keyword',
    file: LOGOUT_SERVICE,
    named: 'OUTSIDE a function body, no production module but the definer touches the singleton',
    // The cheapest way past a rule that keys on type assertions: do not assert
    // anything. It also probes the import carve-out — an EXPORT specifier must
    // not be mistaken for the import that brings the singleton in.
    edits: [[
      `export const ssoLogoutService = new SsoLogoutService();`,
      `export { loginSessionService as loginSessions } from '../LoginSessionService';

export const ssoLogoutService = new SsoLogoutService();`,
    ]],
    expect: (output) => /OUTSIDE a function body, no production module but the definer touches the singleton/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.10',
    claim: 'a type assertion over the singleton reddens its OWN rule, with nothing exported to carry it',
    file: LOGOUT_SERVICE,
    named: 'NO production type assertion is applied to the singleton',
    // Without this the assertion rule could be riding on the hand-off rule.
    // This one widens the singleton and keeps it, so it must redden the
    // assertion rule by its own name.
    edits: [[
      `export const ssoLogoutService = new SsoLogoutService();`,
      `const widenedLocally = loginSessionService as unknown as { mint(input: unknown): Promise<unknown> };
void widenedLocally;

export const ssoLogoutService = new SsoLogoutService();`,
    ]],
    expect: (output) => /NO production type assertion is applied to the singleton/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.11',
    claim: 'a NEW module reaching the singleton reddens the ALLOWLIST — the population is the part that is actually enforceable',
    file: STEP_UP_SERVICE,
    named: 'every production module reaching the singleton is on the VISIBLE allowlist',
    // The rule that carries the class the type layer cannot close: a module
    // writing `(input: any) => loginSessionService.mint(input)` still has to
    // import the singleton, and importing it puts the module on a list a
    // reviewer approves.
    edits: [[
      `import { pool } from '../db/connection';`,
      `import { pool } from '../db/connection';
import { loginSessionService } from './LoginSessionService';

export const stepUpLoginSessionProbe = (token: string) => loginSessionService.resolve(token);`,
    ]],
    expect: (output) => /every production module reaching the singleton is on the VISIBLE allowlist/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.12',
    claim: 'SCOPE CONTROL: an ORDINARY import and call inside an allowlisted module is NOT flagged',
    file: WEBSOCKET,
    named: 'the importer census stays green on ordinary use',
    // The other half of the ruling's repair shape, which asks for the drill in
    // BOTH directions. A rule that refused every mention of the singleton would
    // satisfy every mutation above and be deleted by the first engineer it
    // blocked, so the shape that must stay green is drilled as hard as the
    // shapes that must go red.
    edits: [[
      `import { principalService } from './PrincipalService';`,
      `import { principalService } from './PrincipalService';

export const ordinaryLoginSessionUse = async (token: string) => {
  const found = await loginSessionService.resolve(token);
  return Boolean(found);
};`,
    ]],
    expectGreen: true,
    run: runCensus,
  },
  {
    id: 'M-ss9.13',
    claim: 'the ORACLE guards the module-evaluation traversal: treat everything as in-function and every vector reddens',
    file: CENSUS_TEST,
    named: 'ORACLE, red direction',
    // A census over a clean tree cannot tell "nothing is wrong" from "the
    // detector is broken", and this programme has already shipped one control
    // that passed because nothing could make it fail. This mutation attacks the
    // DETECTOR rather than the tree, at the one place the whole rule turns: the
    // traversal's entry claims it is already inside a function body, so nothing
    // is ever at module-evaluation level and every hand-off vector goes unseen.
    //
    // Two earlier forms of this mutation went vacuous when the rule they
    // attacked was replaced. That is why the satisfiability control exists
    // beside the refusal rule — this same edit empties the ADMITTED list too,
    // and a rule that refuses an empty population must not read as a clean tree.
    edits: [[
      `    visit(source, false, false, undefined);`,
      `    visit(source, true, false, undefined);`,
    ]],
    expect: (output) => /ORACLE, red direction/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.14',
    claim: 'a CONTAINER hand-off reddens the census — round-3 review evasion, reproduced as it was written',
    file: LOGOUT_SERVICE,
    named: 'OUTSIDE a function body, no production module but the definer touches the singleton',
    // The round-3 REJECT, verbatim. No assertion, no `any`, one object literal
    // in a module already on the allowlist. A consumer then reads `.current`
    // and never imports the singleton, so it never appears on the allowlist
    // either — both halves of the block's claim were false at once, and 14/14
    // tests passed while they were.
    edits: [[
      `export const ssoLogoutService = new SsoLogoutService();`,
      `export const ss9CensusEvasionHolder = { current: loginSessionService };

export const ssoLogoutService = new SsoLogoutService();`,
    ]],
    probe: {
      file: 'src/ss9ContainerHandoffProbe.ts',
      content: `// Written and deleted by scripts/w3-red-proofs.js (M-ss9.14). Never committed.
import { ss9CensusEvasionHolder } from './services/identity/SsoLogoutService';

export const ss9HandedOffResolve = (token: string) =>
  ss9CensusEvasionHolder.current.resolve(token);
`,
    },
    expect: (output) => /OUTSIDE a function body, no production module but the definer touches the singleton/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.15',
    claim: 'a SIBLING container nobody demonstrated reddens it too — the repair is the class, not the reported line',
    file: LOGOUT_SERVICE,
    named: 'OUTSIDE a function body, no production module but the definer touches the singleton',
    // An array, reached through a local alias, one hop further than the shape
    // round 3 reported. Repairing the coordinate a reviewer names and leaving
    // its siblings beside it is the failure this programme has paid for
    // repeatedly, so the drill asks about a shape no review wrote.
    edits: [[
      `export const ssoLogoutService = new SsoLogoutService();`,
      `const ss9LoginSessionRegistry = [loginSessionService];

export const ss9CollectedLoginSessions = ss9LoginSessionRegistry;

export const ssoLogoutService = new SsoLogoutService();`,
    ]],
    expect: (output) => /OUTSIDE a function body, no production module but the definer touches the singleton/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.16',
    claim: 'a WRAPPER CALL reddens it as well, and the assertion rule stays out of it — two rules, not one reported twice',
    file: LOGOUT_SERVICE,
    named: 'OUTSIDE a function body, no production module but the definer touches the singleton',
    // The singleton passed as an argument at the construction site. It carries
    // no assertion at all, so it must redden the hand-off rule and leave the
    // assertion rule green — which is what keeps the assertion rule from
    // quietly becoming a second copy of the hand-off rule.
    edits: [[
      `export const ssoLogoutService = new SsoLogoutService();`,
      `export const ss9WrappedLoginSessions = Object.freeze({ inner: loginSessionService });

export const ssoLogoutService = new SsoLogoutService();`,
    ]],
    expect: (output) => /OUTSIDE a function body, no production module but the definer touches the singleton/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.17',
    claim: 'the ORACLE guards the REDUCTION: stop following local aliases and the assertion rule loses a vector',
    file: CENSUS_TEST,
    named: 'ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing',
    // The assertion rule's own predicate, drilled on its own. Its only
    // mechanism beyond a bare identity comparison is following a local `const`,
    // and the `assertedForms` fixture's first line needs exactly that.
    edits: [[
      `      if (ts.isVariableDeclaration(declaration) && reducesToSingleton(scan, declaration.initializer, depth + 1)) {`,
      `      if (ts.isVariableDeclaration(declaration) && false) {`,
    ]],
    expect: (output) => /ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.18',
    claim: 'the PARENTHESES branch of the reduction is load-bearing — remove it and one oracle line goes',
    file: CENSUS_TEST,
    named: 'ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing',
    // One branch, one mutation, one vector. Round-5 review removed three of
    // these individually and watched all sixteen tests stay green, because the
    // vectors of the day exercised the assertion SCAN rather than the branch.
    // Here: the wrapper round-4 review deleted first.
    edits: [[
      `    ts.isParenthesizedExpression(node) ||`,
      `    false ||`,
    ]],
    expect: (output) => /ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.21',
    claim: 'the NON-NULL branch of the reduction is load-bearing — remove it and one oracle line goes',
    file: CENSUS_TEST,
    named: 'ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing',
    // One branch, one mutation, one vector. Round-5 review removed three of
    // these individually and watched all sixteen tests stay green, because the
    // vectors of the day exercised the assertion SCAN rather than the branch.
    // Here: the second of the four.
    edits: [[
      `    ts.isNonNullExpression(node) ||`,
      `    false ||`,
    ]],
    expect: (output) => /ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.22',
    claim: 'the AS branch of the reduction is load-bearing — remove it and one oracle line goes',
    file: CENSUS_TEST,
    named: 'ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing',
    // One branch, one mutation, one vector. Round-5 review removed three of
    // these individually and watched all sixteen tests stay green, because the
    // vectors of the day exercised the assertion SCAN rather than the branch.
    // Here: round-5 review showed a DIRECT line never enters this branch; the nested vector does.
    edits: [[
      `    ts.isAsExpression(node) ||`,
      `    false ||`,
    ]],
    expect: (output) => /ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.23',
    claim: 'the SATISFIES branch of the reduction is load-bearing — remove it and one oracle line goes',
    file: CENSUS_TEST,
    named: 'ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing',
    // One branch, one mutation, one vector. Round-5 review removed three of
    // these individually and watched all sixteen tests stay green, because the
    // vectors of the day exercised the assertion SCAN rather than the branch.
    // Here: same, and the reason the previous claim was false.
    edits: [[
      `    ts.isSatisfiesExpression(node) ||`,
      `    false ||`,
    ]],
    expect: (output) => /ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.24',
    claim: 'the ANGLE-BRACKET branch of the reduction is load-bearing — remove it and one oracle line goes',
    file: CENSUS_TEST,
    named: 'ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing',
    // One branch, one mutation, one vector. Round-5 review removed three of
    // these individually and watched all sixteen tests stay green, because the
    // vectors of the day exercised the assertion SCAN rather than the branch.
    // Here: the last of them.
    edits: [[
      `    ts.isTypeAssertionExpression(node)
  ) {`,
      `    false
  ) {`,
    ]],
    expect: (output) => /ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.19',
    claim: 'the IMPORT carve-out is narrow: admit an export specifier too and a re-export walks straight out',
    file: CENSUS_TEST,
    named: 'ORACLE, red direction',
    // The rule admits exactly one module-evaluation form — the import that
    // brings the singleton in — and everything rests on that carve-out being
    // narrow. Widen it by one node kind and `export { loginSessionService as
    // loginSessions } from ...` becomes an admitted import, which is the whole
    // re-export family walking out through the one door left open.
    edits: [[
      `        const isImportBinding = !!parent && ts.isImportSpecifier(parent);`,
      `        const isImportBinding = !!parent && (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent));`,
    ]],
    expect: (output) => /ORACLE, red direction/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.25',
    claim: 'the REASON allowlist rule is load-bearing — remove it and the list oracle loses a named line',
    file: CENSUS_TEST,
    named: 'ORACLE: the ALLOWLIST rules each catch their own defect, and spare the good entry',
    // These three rules are about the LIST rather than about the tree, and the
    // tree has no bad list to observe: every entry is listed, live and
    // reasoned. A rule whose violation never occurs cannot be drilled against
    // production at all — it has to be handed a bad list, which is what the
    // allowlist oracle does. Here: round-6 review removed this predicate and blanked an entry's reason, and every one of the sixteen tests stayed green.
    edits: [[
      `    reasonless: permitted.filter((entry) => entry.because.trim().length === 0).map((entry) => entry.module).sort(),`,
      `    reasonless: permitted.filter((entry) => entry.because.trim().length === 0 && false).map((entry) => entry.module).sort(),`,
    ]],
    expect: (output) => /ORACLE: the ALLOWLIST rules each catch their own defect, and spare the good entry/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.26',
    claim: 'the STALE-ENTRY allowlist rule is load-bearing — remove it and the list oracle loses a named line',
    file: CENSUS_TEST,
    named: 'ORACLE: the ALLOWLIST rules each catch their own defect, and spare the good entry',
    // These three rules are about the LIST rather than about the tree, and the
    // tree has no bad list to observe: every entry is listed, live and
    // reasoned. A rule whose violation never occurs cannot be drilled against
    // production at all — it has to be handed a bad list, which is what the
    // allowlist oracle does. Here: the same question asked of the rule beside it, because a class repair that fixes only the coordinate a reviewer named is the mistake this file keeps paying for.
    edits: [[
      `    stale: permitted.map((entry) => entry.module).filter((module) => !observed.has(module)).sort(),`,
      `    stale: permitted.map((entry) => entry.module).filter((module) => !observed.has(module) && false).sort(),`,
    ]],
    expect: (output) => /ORACLE: the ALLOWLIST rules each catch their own defect, and spare the good entry/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.27',
    claim: 'the UNLISTED-MODULE allowlist rule is load-bearing — remove it and the list oracle loses a named line',
    file: CENSUS_TEST,
    named: 'ORACLE: the ALLOWLIST rules each catch their own defect, and spare the good entry',
    // These three rules are about the LIST rather than about the tree, and the
    // tree has no bad list to observe: every entry is listed, live and
    // reasoned. A rule whose violation never occurs cannot be drilled against
    // production at all — it has to be handed a bad list, which is what the
    // allowlist oracle does. Here: and of the third, so all three list rules are proven by the same kind of evidence.
    edits: [[
      `    unlisted: reachingModules.filter((module) => !listed.has(module)).sort(),`,
      `    unlisted: reachingModules.filter((module) => !listed.has(module) && false).sort(),`,
    ]],
    expect: (output) => /ORACLE: the ALLOWLIST rules each catch their own defect, and spare the good entry/.test(output),
    run: runCensus,
  },
  {
    id: 'M-ss9.28',
    claim: 'the UNLISTED seam is handed the REAL SCAN — give it an empty one and the seam notices',
    file: CENSUS_TEST,
    named: 'every production module reaching the singleton is on the VISIBLE allowlist',
    // ── WHY THE SEAM NEEDS ITS OWN VECTOR, AND WHY THIS ONE IS THE PROOF ──
    //
    // Round-7 review handed this call an empty scan and all sixteen tests
    // stayed green. `unlisted` is computed FROM the scan, so an empty scan has
    // nothing to report and the rule is satisfied by observing nothing — the
    // rules were proven as a pure function while the seam feeding them the real
    // populations was only half bound. The seam now reports the population it
    // answered over, and this mutation is the vector for that half.
    edits: [[
      `    const findings = allowlistFindings(PERMITTED_SINGLETON_IMPORTERS, reaching);
    expect(findings.observed).toEqual([...reaching].sort());`,
      `    const findings = allowlistFindings(PERMITTED_SINGLETON_IMPORTERS, []);
    expect(findings.observed).toEqual([...reaching].sort());`,
    ]],
    expect: censusFailed('every production module reaching the singleton is on the VISIBLE allowlist'),
    run: runCensus,
  },
  {
    id: 'M-ss9.29',
    claim: 'the UNLISTED seam is handed the REAL LIST — give it an empty one and the rule itself reddens',
    file: CENSUS_TEST,
    named: 'every production module reaching the singleton is on the VISIBLE allowlist',
    // The other argument at the same seam, so the matrix is complete rather
    // than half-stated. This one reddens through the RULE instead of through
    // the population: an empty list makes every observed module unlisted.
    edits: [[
      `    const findings = allowlistFindings(PERMITTED_SINGLETON_IMPORTERS, reaching);
    expect(findings.observed).toEqual([...reaching].sort());`,
      `    const findings = allowlistFindings([], reaching);
    expect(findings.observed).toEqual([...reaching].sort());`,
    ]],
    expect: censusFailed('every production module reaching the singleton is on the VISIBLE allowlist'),
    run: runCensus,
  },
  {
    id: 'M-ss9.30',
    claim: 'the STALE/REASON seam is handed the REAL LIST — give it an empty one and the seam notices',
    file: CENSUS_TEST,
    named: 'the allowlist carries no STALE entry, and every entry carries its reason',
    // The second half of the round-7 finding. `stale` and `reasonless` are both
    // computed FROM the list, so an empty list satisfies both by having nothing
    // to say — and a mute allowlist is exactly what the rule beside it exists to
    // refuse. This mutation is the vector for the population that seam binds.
    edits: [[
      `    const findings = allowlistFindings(PERMITTED_SINGLETON_IMPORTERS, reaching);
    expect(findings.listed).toEqual(PERMITTED_SINGLETON_IMPORTERS.map((entry) => entry.module).sort());`,
      `    const findings = allowlistFindings([], reaching);
    expect(findings.listed).toEqual(PERMITTED_SINGLETON_IMPORTERS.map((entry) => entry.module).sort());`,
    ]],
    expect: censusFailed('the allowlist carries no STALE entry, and every entry carries its reason'),
    run: runCensus,
  },
  {
    id: 'M-ss9.31',
    claim: 'the STALE/REASON seam is handed the REAL SCAN — give it an empty one and the rule itself reddens',
    file: CENSUS_TEST,
    named: 'the allowlist carries no STALE entry, and every entry carries its reason',
    // The fourth corner: an empty scan makes every listed module stale, so this
    // one reddens through the rule rather than through the population. Four
    // mutations, two seams, two arguments each, and each corner reddens at a
    // DIFFERENT assertion — which is what stops one of them standing in for
    // another.
    edits: [[
      `    const findings = allowlistFindings(PERMITTED_SINGLETON_IMPORTERS, reaching);
    expect(findings.listed).toEqual(PERMITTED_SINGLETON_IMPORTERS.map((entry) => entry.module).sort());`,
      `    const findings = allowlistFindings(PERMITTED_SINGLETON_IMPORTERS, []);
    expect(findings.listed).toEqual(PERMITTED_SINGLETON_IMPORTERS.map((entry) => entry.module).sort());`,
    ]],
    expect: censusFailed('the allowlist carries no STALE entry, and every entry carries its reason'),
    run: runCensus,
  },
  {
    id: 'M-ss9.20',
    claim: 'a LATE ASSIGNMENT reddens it — round-4 review evasion, on the real tree, with the consumer compiling',
    file: LOGOUT_SERVICE,
    named: 'OUTSIDE a function body, no production module but the definer touches the singleton',
    // Round-4 review's first evasion. The hand-off is not in the exported
    // value's construction at all; it is a statement after it, which is why no
    // construction-shaped rule could see it and why the rule now asks WHERE
    // rather than HOW. The probe reads the holder and must compile only under
    // the mutation.
    edits: [[
      `export const ssoLogoutService = new SsoLogoutService();`,
      `export const ss9LateHolder: { current?: typeof loginSessionService } = {};

ss9LateHolder.current = loginSessionService;

export const ssoLogoutService = new SsoLogoutService();`,
    ]],
    probe: {
      file: 'src/ss9LateHandoffProbe.ts',
      content: `// Written and deleted by scripts/w3-red-proofs.js (M-ss9.20). Never committed.
import { ss9LateHolder } from './services/identity/SsoLogoutService';

export const ss9LateResolve = (token: string) =>
  ss9LateHolder.current!.resolve(token);
`,
    },
    expect: (output) => /OUTSIDE a function body, no production module but the definer touches the singleton/.test(output),
    run: runCensus,
  },
];

/**
 * The A23 added-line naming sweep. Round-5 review R3 finding B2 found two real
 * bare uses on added lines that the sweep exited 0 over: it judged the whole
 * extracted prose, so one qualified occurrence excused a different bare noun
 * beside it and a case-insensitive plural excused every plural. Both violations
 * are drilled here, because a gate nobody has watched fail is not a gate.
 */
const ANCHOR = 'const HOST = "https://idp.w3live.test";';

const NAMING_MUTATIONS = [
  {
    id: 'M-a23.1',
    claim: 'a bare PLURAL on an added line reddens the sweep (it was exempted wholesale before)',
    file: 'scripts/test-w3-group-sync-live.js',
    named: 'the sweep names test-w3-group-sync-live.js under A23.7',
    edits: [[' *     login sessions for that Account, including the `jit` case where the',
             ' *     sessions for that Account, including the `jit` case where the']],
    expect: (output) => /test-w3-group-sync-live\.js:\d+\s+bare 'sessions' \(A23\.7\)/.test(output),
    run: runAudit,
  },
  {
    id: 'M-a23.2',
    claim: 'a qualified identifier LATER on the line no longer launders a bare noun earlier on it',
    file: 'src/services/identity/IdentityLinkService.ts',
    named: 'the sweep names IdentityLinkService.ts under A23.7',
    // The mutated line still ends in `LoginSessionService.revoke`, which is
    // exactly what made the old whole-prose form exit 0 over it.
    edits: [['        // revokes the login session, exactly as LoginSessionService.revoke does.',
             '        // revokes the session, exactly as LoginSessionService.revoke does.']],
    expect: (output) => /IdentityLinkService\.ts:\d+\s+bare 'session' \(A23\.7\)/.test(output),
    run: runAudit,
  },
  {
    id: 'M-a23.3',
    claim: 'prose in a comment TRAILING code is swept (round-5 R1 F1, first hostile form)',
    file: 'scripts/test-w3-group-sync-live.js',
    named: 'the sweep names test-w3-group-sync-live.js under A23.3',
    // R1 reproduced this in a scratch clone and the sweep exited 0: it saw a
    // comment only when the line STARTED with one. The anchor also carries a
    // URL, so this fixture drills the scheme scrub at the same time.
    edits: [[ANCHOR, ANCHOR + '  // Login at this provider.']],
    expect: (output) => /test-w3-group-sync-live\.js:\d+\s+bare 'provider' \(A23\.3\)/.test(output),
    run: runAudit,
  },
  {
    id: 'M-a23.4',
    claim: 'prose RENDERED AROUND an interpolation is swept (round-5 R1 F1, second hostile form)',
    file: 'scripts/test-w3-group-sync-live.js',
    named: 'the sweep names test-w3-group-sync-live.js under A23.3',
    // The second form R1 demonstrated: a template literal reads as code to a
    // naive extractor, but what it RENDERS is a sentence a human will read.
    edits: [[ANCHOR, ANCHOR + '\nconst HOSTILE = \`Login at this \${HOST} provider.\`;']],
    expect: (output) => /test-w3-group-sync-live\.js:\d+\s+bare 'provider' \(A23\.3\)/.test(output),
    run: runAudit,
  },
  {
    id: 'M-a23.5',
    claim: 'SCOPE CONTROL: identifiers and member access are not prose, so the sweep stays green on them',
    file: 'scripts/test-w3-group-sync-live.js',
    named: 'the sweep stays green on code tokens',
    // Without this, every mutation above could be satisfied by a sweep that
    // flagged everything — and the first engineer it blocked would delete it.
    edits: [[ANCHOR, ANCHOR + '\nconst ref = { provider: HOST, session: RUN };\nconst refId = ref.provider + ref.session;']],
    expectGreen: true,
    run: runAudit,
  },
  {
    id: 'M-a23.6',
    claim: 'prose in a /* ... */ BLOCK comment is swept (round-6 R3 finding 623b7fdb)',
    file: 'scripts/test-w3-group-sync-live.js',
    named: 'the sweep names test-w3-group-sync-live.js under A23.3',
    // R3 wrote `export const commentControl = 1; /* Login at this provider. */`
    // in a compiling file and the sweep exited 0: it knew `//`, `--`, `#` and a
    // leading `/**`, but nothing matched a one-line block comment. The markers
    // are now taken from the file's language, and this is the shape that was
    // missing entirely.
    edits: [[ANCHOR, ANCHOR + '  /* Login at this provider. */']],
    expect: (output) => /test-w3-group-sync-live\.js:\d+\s+bare 'provider' \(A23\.3\)/.test(output),
    run: runAudit,
  },
  {
    id: 'M-a23.7',
    claim: 'SCOPE CONTROL: a # inside a TypeScript string is not a comment, so the sweep stays green',
    file: 'scripts/test-w3-group-sync-live.js',
    named: 'the sweep stays green on hash characters in code',
    // The other half of the same mistake, also R3's (`4a8ceddf`): applying
    // Python's comment marker to TypeScript made a hash-marked path fragment in
    // an ordinary string read as a comment, and the word after the hash was
    // reported as a naming violation. Guessing the syntax fails in BOTH
    // directions, so both directions are drilled.
    edits: [[ANCHOR, ANCHOR + '\nconst fragmentControl = "/directory#session";']],
    expectGreen: true,
    run: runAudit,
  },
];

/**
 * The conformance classes the W3 carry-forward extends. Re-hollowed here
 * against their MEMBERSHIP legs: the W2 hollowings remove the Identity provider's
 * characteristic from the fixture, and these must still fail — now for a
 * stronger reason, because the assertion reaches all the way to a row.
 */
const REHOLLOWINGS = [
  {
    id: 'M-w3.h2',
    claim: 're-hollow class 2: the nested claim no longer nests -> its MEMBERSHIP leg goes red',
    file: 'src/__tests__/conformance/fixtures.ts',
    named: 'class 2 assertion red, control green',
    edits: [[
      '    idTokenClaims: { realm_access: { roles: [CLASS_2_CLAIM_VALUE] } },',
      '    idTokenClaims: { realm_access_roles: [CLASS_2_CLAIM_VALUE] },',
    ]],
    expect: (output) => /RESULT class=2 assertion=red control=green/.test(output),
    run: runGate,
  },
  {
    id: 'M-w3.h3',
    claim: 're-hollow class 3: three values collapse to one -> three DISTINCT memberships go red',
    file: 'src/__tests__/conformance/fixtures.ts',
    named: 'class 3 assertion red, control green',
    edits: [[
      '    idTokenClaims: { groups: [...CLASS_3_GROUP_VALUES] },',
      '    idTokenClaims: { groups: [CLASS_3_GROUP_VALUES[0], CLASS_3_GROUP_VALUES[0], CLASS_3_GROUP_VALUES[0]] },',
    ]],
    expect: (output) => /RESULT class=3 assertion=red control=green/.test(output),
    run: runGate,
  },
  {
    id: 'M-w3.h5',
    claim: 're-hollow class 5: the overage marker is not an overage -> the unchanged-membership leg goes red',
    file: 'src/__tests__/conformance/fixtures.ts',
    named: 'class 5 assertion red, control green',
    edits: [["      _claim_names: { groups: 'src1' },", "      _claim_names_absent: { groups: 'src1' },"]],
    expect: (output) => /RESULT class=5 assertion=red control=green/.test(output),
    run: runGate,
  },
];

function main() {
  // Named ids re-drill ONE mutation (`node scripts/w3-red-proofs.js M-ss9.7`);
  // with no arguments every mutation runs, which is the form CI and the gate
  // record use. A filtered run announces what it is, so a partial drill can
  // never be read back as a full one.
  const only = new Set(process.argv.slice(2));
  const selected = (mutation) => only.size === 0 || only.has(mutation.id);

  // Round-6 review R3 finding `731a7f01`: a MISSPELLED id selected nothing and
  // the driver reported `0/0 PROVEN` and exited 0. A gate that answers "all
  // green" to a question it never asked is worse than no gate, so an id that
  // names no mutation is a hard error, and a run that proves nothing exits
  // non-zero further down.
  const known = new Set([...BEHAVIOUR_MUTATIONS, ...CENSUS_MUTATIONS,
                         ...NAMING_MUTATIONS, ...REHOLLOWINGS].map((m) => m.id));
  const unknown = [...only].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    console.error(`unknown mutation id(s): ${unknown.join(', ')}`);
    console.error(`known ids: ${[...known].join(', ')}`);
    process.exit(2);
  }
  if (only.size > 0) console.log(`FILTERED RUN — only ${[...only].join(', ')}; this is NOT the full drill`);

  console.log('W3 red proofs — the mechanisms this wave built, each removed and required to go red\n');
  const results = [];

  console.log('BEHAVIOUR (live proofs against a real migrated PostgreSQL):');
  for (const mutation of BEHAVIOUR_MUTATIONS.filter(selected)) {
    results.push(prove(mutation, mutation.run ?? runLive));
  }

  console.log('\nSS-9 CENSUS (the mint contract, then the importer census; the positive controls live in the tests):');
  for (const mutation of CENSUS_MUTATIONS.filter(selected)) {
    results.push(prove(mutation, mutation.run ?? runCensus));
  }

  console.log('\nA23 NAMING SWEEP (both round-5 false greens, drilled):');
  for (const mutation of NAMING_MUTATIONS.filter(selected)) {
    results.push(prove(mutation, mutation.run ?? runAudit));
  }

  console.log('\n§4.5(a) RE-HOLLOWING (the carry-forward classes, against their membership legs):');
  for (const mutation of REHOLLOWINGS.filter(selected)) {
    results.push(prove(mutation, mutation.run ?? runGate));
  }

  const proven = results.filter(Boolean).length;
  console.log(`\nW3 RED PROOFS: ${proven}/${results.length} PROVEN`);
  if (results.length === 0) {
    console.error('no mutation ran — refusing to report a green for an empty drill');
    process.exit(2);
  }
  if (proven !== results.length) process.exit(1);
}

main();
