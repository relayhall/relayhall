#!/usr/bin/env node
/**
 * test-w3-group-sync-live.js — SS-W3 (card `2ae39bda` subtask [3]; SSO design
 * `d95136d7` §7; acceptance annex `e6dcadb9` §11 W3 and §11a rows SS-9, SS-12,
 * SS-13, SS-14a, T-SS7, T-SS14, T-SS18; sitting `5a7fd9af` ruling SSO-R4;
 * owner decision W3-D2 on run packet `05492f21`).
 *
 * Behavioural proof against a REAL migrated PostgreSQL, through the PRODUCTION
 * relying party and the PRODUCTION authentication middleware — never SQL
 * substrings, never a double of the thing under test. The one double is the
 * Identity provider itself, at the single outbound seam, which is the same
 * boundary the §4.5(a) conformance gate doubles.
 *
 * What these pin:
 *
 *  1. **T-SS14, the directory wipe.** A login-time claim sync applies ONE
 *     Account's membership and leaves every other Account's directory rows
 *     untouched. This is the proof that the account-scoped seam is real: the
 *     full-snapshot `applyDirectorySnapshot` would delete Account B's rows
 *     while Account A logged in, and the audit ledger would call it legitimate.
 *  2. **T33 carried forward.** A `source='local'` assignment survives a
 *     directory sync that does not mention it.
 *  3. **SS-13 fail-closed, non-vacuously.** An overage indicator arriving for
 *     an Account that ALREADY HOLDS memberships changes nothing and does not
 *     advance the AZ-30 watermark; a well-formed claim changes both.
 *  4. **SSO-R4, every arm of W3-D2.** Disabled admits; a member admits; a
 *     LOCAL-source member admits (the source is not filtered — the question is
 *     whether the board considers this person a member); a non-member is
 *     refused BEFORE a login session exists; an enabled-but-empty list refuses
 *     everyone (fail closed); and an Account whose claim was unusable is still
 *     judged on its RETAINED membership, so an overage is not a lockout.
 *  5. **The refusal costs no login session.** A refused login leaves zero live
 *     login sessions for that Account, including the `jit` case where the
 *     itself was just created.
 *  6. **T-SS18 parity.** ONE Account, both doors, at one moment: the effective
 *     scopes resolved by `authMiddleware` from an SSO login-session cookie
 *     are byte-identical to those from a password login-session cookie.
 *  7. **The named refusals.** A Group that gates login cannot be deleted; a
 *     half-set directory binding is refused.
 *
 * Run with DB_* env pointed at a DISPOSABLE database carrying the full
 * migration chain (prepare with test-fresh-install-replay.js). Exit 0 = all
 * proofs. This driver runs a single `tsx` process and spawns no pool, so it is
 * safe inside an agent session (harness card `9b4e465a`).
 */
const { spawnSync } = require("child_process");
const path = require("path");

const BACKEND = path.resolve(__dirname, "..");

const probe = `
process.env.RELAYHALL_SESSIONS = "on";
process.env.JWT_SECRET = process.env.JWT_SECRET || "w3-live-probe-secret";
process.env.RELAYHALL_PUBLIC_API_URL = process.env.RELAYHALL_PUBLIC_API_URL || "https://board.w3.test/api";
// The §7.2 envelope keyset. A throwaway key for a disposable database: the
// Identity provider secrets these proofs write are fixtures, and nothing key-shaped is
// stored in the tree (the W2 publish-gate lesson).
process.env.RELAYHALL_CREDENTIAL_KEYS = process.env.RELAYHALL_CREDENTIAL_KEYS
  || JSON.stringify({ w3live: Buffer.alloc(32, 23).toString("base64") });
process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY = process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY || "w3live";

import crypto from "crypto";
import { pool } from "../src/db/connection";
import { SsoAuthenticationService } from "../src/services/identity/SsoAuthenticationService";
import { SsoDiscoveryService } from "../src/services/identity/SsoDiscoveryService";
import { identityProviderService } from "../src/services/identity/IdentityProviderService";
import { ssoInvitationService } from "../src/services/identity/SsoInvitationService";
import { groupService } from "../src/services/GroupService";
import { accountPasswordService } from "../src/services/AccountPasswordService";
import { loginSessionService } from "../src/services/LoginSessionService";
import { principalService } from "../src/services/PrincipalService";
import { authMiddleware } from "../src/middleware/auth";
import { ProviderDouble } from "../src/__tests__/conformance/providerDouble";

const ACTOR = { principalId: null, handle: "w3-live-proof", authMethod: "system" as const };
const HOST = "https://idp.w3live.test";
const RUN = crypto.randomBytes(4).toString("hex");

const failures: string[] = [];
const out: Record<string, unknown> = {};
function check(name: string, ok: boolean, detail?: unknown) {
  out[name] = ok ? "PASS" : { FAIL: detail ?? true };
  if (!ok) failures.push(name);
}

/** Drive the PRODUCTION middleware with nothing but a login-session cookie. */
async function scopesFromCookie(token: string): Promise<{ ok: boolean; userId?: string; scopes?: string[] }> {
  const req: any = { baseUrl: "", path: "/tasks", method: "GET", headers: { cookie: "relayhall_session=" + token } };
  const res: any = { status: () => res, json: () => res, setHeader: () => res };
  let ok = false;
  await authMiddleware(req, res, () => { ok = true; });
  return { ok, userId: req.userId, scopes: req.scopes };
}

const double = new ProviderDouble();
const discovery = new SsoDiscoveryService(double);
const service = new SsoAuthenticationService(discovery, double);

async function provisionProvider(slug: string, config: Record<string, unknown> = {}) {
  const issuer = HOST + "/application/" + slug + "-" + RUN;
  const clientId = "client-" + slug + "-" + RUN;
  double.register({ issuer, clientId });
  await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active'");
  return identityProviderService.create({
    name: "W3 live " + slug,
    issuer,
    clientId,
    clientSecret: "w3-live-secret",
    subjectImmutable: true,
    status: "active",
    provisioningMode: "jit",
    groupsClaim: "groups",
    groupBindingMode: "claim",
    ...config,
  } as never, ACTOR);
}

/** ONE login through the shared production entry point. */
async function login(provider: any, subject: string, extraClaims: Record<string, unknown> = {}, invitationCode?: string) {
  double.resetRequests();
  discovery.reset();
  const started = await service.startAuthentication({
    identityProviderId: provider.id,
    ...(invitationCode ? { invitationCode } : {}),
  } as never);
  const url = new URL(started.authorizeUrl);
  const state = url.searchParams.get("state") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
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
  return service.completeAuthentication({ state, code, iss: provider.issuer, cookieState: state });
}

/**
 * A login that is EXPECTED to succeed. A refusal returns null rather than
 * throwing, so a mutation that breaks an admit-path fails the named check
 * instead of crashing this driver — "it failed, but not at the named check" is
 * a red proof that proves nothing.
 */
async function tryLogin(provider: any, subject: string, extraClaims: Record<string, unknown> = {}, invitationCode?: string) {
  try {
    return await login(provider, subject, extraClaims, invitationCode);
  } catch {
    return null;
  }
}

async function loginRefusal(provider: any, subject: string, extraClaims: Record<string, unknown> = {}) {
  try {
    await login(provider, subject, extraClaims);
    return "<no refusal>";
  } catch (error: any) {
    return String(error?.code ?? error?.message ?? error);
  }
}

async function bindGroup(providerId: string, externalRef: string, name: string): Promise<string> {
  const result = await pool.query(
    "INSERT INTO groups (name, identity_provider_id, external_group_ref) VALUES ($1,$2,$3) RETURNING id",
    [name + " " + crypto.randomBytes(3).toString("hex"), providerId, externalRef],
  );
  return String(result.rows[0].id);
}

const membership = async (principalId: string): Promise<string[]> => {
  const r = await pool.query(
    "SELECT group_id FROM group_members WHERE account_principal_id = $1 ORDER BY group_id", [principalId]);
  return r.rows.map((row: any) => String(row.group_id));
};

const watermark = async (providerId: string): Promise<string | null> => {
  const r = await pool.query("SELECT last_success_at FROM directory_sync_state WHERE provider = $1", [providerId]);
  return r.rows[0]?.last_success_at ? new Date(r.rows[0].last_success_at).toISOString() : null;
};

const liveSessions = async (principalId: string): Promise<number> => {
  const r = await pool.query(
    "SELECT count(*)::int AS n FROM auth_sessions WHERE principal_id = $1 AND revoked_at IS NULL", [principalId]);
  return Number(r.rows[0].n);
};

const sameSet = (a?: string[], b?: string[]) =>
  Array.isArray(a) && Array.isArray(b) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function main() {
  // ══ 1-3. the account-scoped snapshot, T33 and SS-13 ══════════════════════
  {
    const provider = await provisionProvider("scope");
    const gA = await bindGroup(provider.id, "grp-a", "W3 A");
    const gB = await bindGroup(provider.id, "grp-b", "W3 B");

    const alice = await login(provider, "alice-" + RUN, { groups: ["grp-a", "grp-b"] });
    // Bob is in BOTH groups, including the one Alice is about to lose.
    //
    // Review R1's non-blocking finding: with Bob in grp-a only, this vector
    // could not detect an UNSCOPED DELETE inside the account-scoped method —
    // Alice's removal loop only ever touched grp-b, and Bob had no grp-b row to
    // destroy, so the fixture passed for the wrong reason. The account clause
    // is the thing under test, so the fixture has to put another Account's row
    // in the blast radius of the exact statement that runs.
    const bob = await login(provider, "bob-" + RUN, { groups: ["grp-a", "grp-b"] });
    const aliceBefore = await membership(alice.principalId);
    const bobBefore = await membership(bob.principalId);
    check("seed: alice holds two directory memberships", aliceBefore.length === 2, aliceBefore);
    check("seed: bob holds BOTH, so the group Alice drops is one Bob still holds",
      bobBefore.length === 2, bobBefore);

    // A local assignment that no claim will ever mention (T33).
    const local = await pool.query("INSERT INTO groups (name) VALUES ($1) RETURNING id",
      ["W3 local " + crypto.randomBytes(3).toString("hex")]);
    const localGroupId = String(local.rows[0].id);
    await groupService.addMember(localGroupId, { accountPrincipalId: alice.principalId, source: "local" }, ACTOR as never);

    // Alice logs in again, now claiming ONLY grp-a. Her grp-b directory row
    // must go; Bob must be untouched; her local row must survive.
    await login(provider, "alice-" + RUN, { groups: ["grp-a"] });
    const aliceAfter = await membership(alice.principalId);
    const bobAfter = await membership(bob.principalId);

    check("T-SS14: another Account's directory rows are NOT touched by this login",
      sameSet(bobAfter, bobBefore), { bobBefore, bobAfter });
    check("the logging-in Account's own snapshot is applied (grp-b dropped)",
      aliceAfter.includes(gA) && !aliceAfter.includes(gB), { aliceAfter, gA, gB });
    check("T33: a source=local assignment survives the directory sync",
      aliceAfter.includes(localGroupId), { aliceAfter, localGroupId });

    // SS-13, non-vacuously: alice HOLDS memberships when the overage arrives.
    const beforeOverage = await membership(alice.principalId);
    const markBefore = await watermark(provider.id);
    await login(provider, "alice-" + RUN, { _claim_names: { groups: "src1" }, _claim_sources: { src1: { endpoint: "https://graph.example/x" } } });
    const afterOverage = await membership(alice.principalId);
    const markAfter = await watermark(provider.id);
    check("SS-13: an overage leaves a NON-EMPTY membership set unchanged",
      beforeOverage.length > 0 && sameSet(afterOverage, beforeOverage), { beforeOverage, afterOverage });
    check("SS-13: an overage does NOT advance the staleness watermark",
      markAfter === markBefore, { markBefore, markAfter });

    // ...and an absent claim behaves identically.
    await login(provider, "alice-" + RUN, {});
    check("SS-13: an absent claim leaves memberships unchanged",
      sameSet(await membership(alice.principalId), beforeOverage));
  }

  // ══ 4-5. SSO-R4, every arm ═══════════════════════════════════════════════
  {
    const provider = await provisionProvider("gate");
    const allowed = await bindGroup(provider.id, "staff", "W3 staff");
    await bindGroup(provider.id, "contractors", "W3 contractors");

    // (a) whitelist DISABLED admits anyone the Identity provider proves.
    const open = await tryLogin(provider, "open-" + RUN, { groups: ["contractors"] });
    check("whitelist disabled: login admitted", Boolean(open?.sessionToken));

    // (b) ENABLED with an EMPTY list refuses everyone — fail closed.
    await identityProviderService.update(provider.id, { loginGroupWhitelistEnabled: true }, ACTOR as never);
    const emptyRefusal = await loginRefusal(provider, "empty-" + RUN, { groups: ["staff"] });
    check("whitelist enabled + EMPTY list refuses (fail closed)",
      emptyRefusal === "SSO_LOGIN_GROUP_REFUSED", emptyRefusal);

    // (c) a member of an allowed Group is admitted...
    await identityProviderService.addLoginGroup(provider.id, allowed, ACTOR as never);
    const member = await tryLogin(provider, "member-" + RUN, { groups: ["staff"] });
    check("whitelist: a member is admitted", Boolean(member?.sessionToken));

    // (d) ...and a non-member is refused, with NO login session left behind.
    const nonMemberSubject = "nonmember-" + RUN;
    const refusal = await loginRefusal(provider, nonMemberSubject, { groups: ["contractors"] });
    check("whitelist: a non-member is refused by name",
      refusal === "SSO_LOGIN_GROUP_REFUSED", refusal);
    const created = await pool.query(
      "SELECT account_principal_id FROM identity_links WHERE subject = $1 AND identity_provider_id = $2",
      [nonMemberSubject, provider.id]);
    const refusedPrincipal = created.rows[0]?.account_principal_id ?? null;
    check("the jit Account exists but holds NO live login session (the refusal costs none)",
      refusedPrincipal !== null && (await liveSessions(String(refusedPrincipal))) === 0, refusedPrincipal);

    // (e) a LOCAL-source membership admits too (W3-D2: the source is not filtered).
    const localOnly = await login(provider, "localmember-" + RUN, { groups: [] })
      .catch(() => null);
    check("a claim naming no allowed group is refused before the local grant", localOnly === null);
    const localSubject = "localgrant-" + RUN;
    const firstTry = await loginRefusal(provider, localSubject, {});
    check("first login for the local-grant subject is refused (not yet a member)",
      firstTry === "SSO_LOGIN_GROUP_REFUSED", firstTry);
    const localLink = await pool.query(
      "SELECT account_principal_id FROM identity_links WHERE subject = $1 AND identity_provider_id = $2",
      [localSubject, provider.id]);
    const localPrincipal = String(localLink.rows[0].account_principal_id);
    await groupService.addMember(allowed, { accountPrincipalId: localPrincipal, source: "local" }, ACTOR as never);
    const admitted = await tryLogin(provider, localSubject, {});
    check("W3-D2: a LOCAL-source membership admits a federated login",
      Boolean(admitted?.sessionToken) && admitted?.principalId === localPrincipal,
      { admitted: admitted === null ? "refused" : admitted.principalId, localPrincipal });

    // (f) claims-unavailable is judged on RETAINED membership — no overage lockout.
    const retained = await tryLogin(provider, localSubject,
      { _claim_names: { groups: "src1" }, _claim_sources: { src1: { endpoint: "https://graph.example/x" } } });
    check("an overage does NOT lock out a retained member", Boolean(retained?.sessionToken));
  }

  // ══ 5b. SS-14a — one enabled Identity provider, and what it means for memberships ══
  //
  // Annex §11a's SS-14a row has two clauses. W2 proved the first (enabling a
  // second Identity provider is refused at the write). The second is W3's and
  // was NAMED in this file's header without being asserted, which is the
  // "claims more than the evidence covers" shape this programme rejects:
  // *a snapshot applied under one provider is the only directory membership
  // that exists*. Since group_members carries no Identity-provider column
  // (SS-14b was
  // not taken), attribution runs through the bound Group.
  {
    const provider = await provisionProvider("single");
    const bound = await bindGroup(provider.id, "single-grp", "W3 single");
    const user = await tryLogin(provider, "single-" + RUN, { groups: ["single-grp"] });
    check("SS-14a: a login under the one enabled Identity provider writes its membership",
      Boolean(user?.sessionToken) && (await membership(user!.principalId)).includes(bound));

    // Enabling a SECOND Identity provider is refused at the write.
    let secondRefusal = "<no refusal>";
    try {
      await identityProviderService.create({
        name: "W3 second", issuer: HOST + "/application/second-" + RUN,
        clientId: "client-second-" + RUN, clientSecret: "x",
        subjectImmutable: true, status: "active",
      } as never, ACTOR);
    } catch (e: any) { secondRefusal = String(e?.code ?? e?.message ?? e); }
    check("SS-14a: a second ENABLED Identity provider is refused at the write",
      secondRefusal === "PROVIDER_SECOND_ACTIVE", secondRefusal);

    // The clause, at the scope it actually holds: for an Account whose
    // memberships this enabled Identity provider wrote, EVERY directory row is
    // attributable to a Group bound to THAT Identity provider. There is no
    // second enabled Identity provider whose snapshot could have written one —
    // which is
    // exactly what makes 14a sufficient in place of 14b's Identity-provider
    // column,
    // and why the two-Identity-provider wipe vector 14b would have to prove
    // is unreachable here.
    //
    // Deliberately scoped PER ACCOUNT, not estate-wide. An estate-wide
    // assertion fails against rows written by an Identity provider that has
    // since been DISABLED or DELETED: those rows survive, attributable to nothing,
    // because no future snapshot will ever mention them. That residue is real
    // and is carded as a hardening follow-up — it is an Identity-provider
    // REPLACEMENT
    // question (SSO-R17, W5's runbook), not something §7 or SSO-R4 rules, and
    // asserting it here would be claiming more than the design decides.
    const attributable = await pool.query(
      "SELECT count(*)::int AS n FROM group_members m JOIN groups g ON g.id = m.group_id " +
      "WHERE m.source = 'directory' AND m.account_principal_id = $1 " +
      "AND (g.identity_provider_id IS NULL OR g.identity_provider_id <> $2)",
      [user!.principalId, provider.id]);
    check("SS-14a: this Account's directory memberships all belong to the ONE enabled Identity provider",
      Number(attributable.rows[0].n) === 0, { unattributable: attributable.rows[0].n });
  }

  // ══ 6. T-SS18 parity: one Account, both doors ════════════════════════════
  {
    const provider = await provisionProvider("parity", { provisioningMode: "invited" });
    const handle = "w3-parity-" + RUN;
    const account = await principalService.createPrincipal({
      handle, kind: "human", role: "user", displayName: "W3 parity",
    } as never, ACTOR as never);
    const principalId = (account as any).id ?? (account as any).principalId;
    await accountPasswordService.set(principalId, "w3-parity-password-long-enough", ACTOR as never);

    const { code } = await ssoInvitationService.mint(
      { identityProviderId: provider.id, accountPrincipalId: principalId }, ACTOR as never);
    const ssoSession = await tryLogin(provider, "parity-" + RUN, {}, code);
    check("the invitation bound the SSO login to the SAME Account",
      ssoSession?.principalId === principalId, { expected: principalId, got: ssoSession?.principalId ?? "refused" });
    if (!ssoSession) throw new Error("the parity block needs an SSO login session to compare");

    const verified = await accountPasswordService.verify(handle, "w3-parity-password-long-enough");
    const pwSession = await loginSessionService.mint({ principalId, ip: null, userAgent: null } as never);

    const viaSso = await scopesFromCookie(ssoSession.sessionToken);
    const viaPassword = await scopesFromCookie(pwSession.token);
    // req.userId is the HANDLE the middleware resolves, not the row id — so
    // the parity claim is that both doors resolve the SAME identity, and that
    // the identity is the Account these two credentials belong to.
    check("T-SS18: both doors authenticate the SAME principal",
      viaSso.ok && viaPassword.ok
      && viaSso.userId === viaPassword.userId
      && viaSso.userId === handle,
      { viaSso: viaSso.userId, viaPassword: viaPassword.userId, handle });
    check("T-SS18: effective scopes are BYTE-IDENTICAL through both doors",
      JSON.stringify(viaSso.scopes) === JSON.stringify(viaPassword.scopes),
      { sso: viaSso.scopes, password: viaPassword.scopes });
    check("the password credential really verified (the parity is between two live doors)",
      Boolean(verified));

    // SS-9: the SSO login session's role_snapshot is NULL, read from the database.
    const snap = await pool.query(
      "SELECT role_snapshot FROM auth_sessions WHERE principal_id = $1", [principalId]);
    check("SS-9: no login path writes role_snapshot",
      snap.rows.length > 0 && snap.rows.every((r: any) => r.role_snapshot === null),
      snap.rows.map((r: any) => r.role_snapshot));

    // ── The OVERAGE form of T-SS18, which the annex requires as ONE sentence ──
    //
    // Review R2 finding F2 against candidate be42278: the annex §11 SS-W3 DoD
    // is a conjunction — "an overage-indicator fixture leaves memberships
    // UNCHANGED, does NOT advance the staleness watermark, and yields a session
    // whose authority is BYTE-IDENTICAL to a password login for the same
    // Account at the same moment" — quoted verbatim, so its bare "session"
    // stands as the annex wrote it; A23.7 governs prose this wave AUTHORS, and
    // editing a quotation of a ratified document would be the worse error.
    // W3 first proved those three parts in three
    // separate places, and separate proofs of the conjuncts are not a proof of
    // the conjunction: nothing exercised one Account whose OVERAGE-driven SSO
    // login session is compared against its own password login session.
    //
    // This is that sequence. It runs on the parity Account, which already holds
    // a password and a proven Identity link, so the two doors are genuinely the
    // same Account.
    await identityProviderService.update(provider.id,
      { groupsClaim: "groups", groupBindingMode: "claim" } as never, ACTOR as never);
    const parityGroup = await bindGroup(provider.id, "parity-grp", "W3 parity group");

    // First a WELL-FORMED claim, so the Account really holds a directory
    // membership for the overage to threaten. Without this the "unchanged"
    // leg would be 0 === 0 — the vacuity class 5 was repaired for.
    await tryLogin(provider, "parity-" + RUN, { groups: ["parity-grp"] });
    const retainedMembership = await membership(principalId);
    const retainedWatermark = await watermark(provider.id);
    check("the overage-parity vector is NOT vacuous: the Account holds a directory membership first",
      retainedMembership.includes(parityGroup), { retainedMembership, parityGroup });

    // Now the OVERAGE, on the same subject, and a password login session minted
    // at the same moment.
    const overageSso = await tryLogin(provider, "parity-" + RUN,
      { _claim_names: { groups: "src1" }, _claim_sources: { src1: { endpoint: "https://graph.example/x" } } });
    const overagePassword = await loginSessionService.mint({ principalId, ip: null, userAgent: null } as never);

    const overageViaSso = await scopesFromCookie(overageSso!.sessionToken);
    const overageViaPassword = await scopesFromCookie(overagePassword.token);
    const afterMembership = await membership(principalId);
    const afterWatermark = await watermark(provider.id);

    check("T-SS18 overage form: the overage login session is admitted at all",
      Boolean(overageSso?.sessionToken) && overageViaSso.ok);
    check("T-SS18 overage form: memberships are UNCHANGED across the overage login",
      JSON.stringify(afterMembership) === JSON.stringify(retainedMembership),
      { before: retainedMembership, after: afterMembership });
    check("T-SS18 overage form: the staleness watermark did NOT advance",
      afterWatermark === retainedWatermark, { before: retainedWatermark, after: afterWatermark });
    check("T-SS18 overage form: effective scopes are BYTE-IDENTICAL to the password door at the same moment",
      JSON.stringify(overageViaSso.scopes) === JSON.stringify(overageViaPassword.scopes),
      { sso: overageViaSso.scopes, password: overageViaPassword.scopes });
  }

  // ══ 6b. SSO-R16 — disposal is bound to EVERY login-session death ═════════
  //
  // Review R2 finding F1 against candidate be42278: W3 first read "login-session
  // death" as "revocation" and repaired only the statements the SS-9 census
  // named. A login session also dies by ABSOLUTE EXPIRY and by IDLE TIMEOUT, and
  // those deaths write nothing at all, so a census over update column sets is
  // structurally blind to them. These are the behavioural proofs that gap
  // needed — including the control that the sweep does NOT touch a live
  // login session, because a sweep that disposed of live tokens would break
  // RP-initiated logout for everyone.
  {
    const provider = await provisionProvider("disposal", { retainIdToken: true });
    const mk = async (label: string) => {
      const user = await tryLogin(provider, label + "-" + RUN, {});
      const row = await pool.query(
        "SELECT id, id_token_ct FROM auth_sessions WHERE id = $1", [user!.sessionId]);
      return { principalId: user!.principalId, sessionId: user!.sessionId, hadToken: row.rows[0].id_token_ct !== null };
    };
    const expired = await mk("disposal-expired");
    const idle = await mk("disposal-idle");
    const alive = await mk("disposal-alive");
    check("a retained ID token is stored when the Identity provider opts in (or these proofs are vacuous)",
      expired.hadToken && idle.hadToken && alive.hadToken,
      { expired: expired.hadToken, idle: idle.hadToken, alive: alive.hadToken });

    // Kill one by ABSOLUTE expiry and one by IDLE timeout, without revoking
    // either — exactly the deaths that perform no update of their own.
    await pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 hour' WHERE id = $1", [expired.sessionId]);
    await pool.query("UPDATE auth_sessions SET last_seen_at = now() - interval '400 days' WHERE id = $1", [idle.sessionId]);

    const disposed = await loginSessionService.disposeRetainedTokensOnDeadLoginSessions();
    const tokenOf = async (id: string) => {
      const r = await pool.query("SELECT id_token_ct, id_token_key_id FROM auth_sessions WHERE id = $1", [id]);
      return r.rows[0];
    };
    const afterExpired = await tokenOf(expired.sessionId);
    const afterIdle = await tokenOf(idle.sessionId);
    const afterAlive = await tokenOf(alive.sessionId);

    check("SSO-R16: a login session dead by ABSOLUTE EXPIRY has its retained ID token disposed",
      afterExpired.id_token_ct === null && afterExpired.id_token_key_id === null, afterExpired);
    check("SSO-R16: a login session dead by IDLE TIMEOUT has its retained ID token disposed",
      afterIdle.id_token_ct === null && afterIdle.id_token_key_id === null, afterIdle);
    // The control: a LIVE login session keeps its token, so the sweep is bounded
    // by death rather than simply clearing the column everywhere.
    check("the disposal sweep leaves a LIVE login session's retained token alone",
      afterAlive.id_token_ct !== null, { disposedRows: disposed });
    // And the dead login sessions were never revoked — they died the silent way.
    const silent = await pool.query(
      "SELECT count(*)::int AS n FROM auth_sessions WHERE id = ANY($1::uuid[]) AND revoked_at IS NOT NULL",
      [[expired.sessionId, idle.sessionId]]);
    check("those deaths were EXPIRY and IDLE, not revocation (the class the census cannot see)",
      Number(silent.rows[0].n) === 0, silent.rows[0]);
  }

  // ══ 7. the named refusals ════════════════════════════════════════════════
  {
    const provider = await provisionProvider("refusals");
    const gating = await bindGroup(provider.id, "gatekeeper", "W3 gatekeeper");
    await identityProviderService.addLoginGroup(provider.id, gating, ACTOR as never);

    let deleteRefusal = "<no refusal>";
    try { await groupService.remove(gating, ACTOR as never); }
    catch (e: any) { deleteRefusal = String(e?.code ?? e?.message ?? e); }
    check("a Group that gates login cannot be deleted (named refusal)",
      deleteRefusal === "GROUP_GATES_LOGIN", deleteRefusal);

    const plain = await pool.query("INSERT INTO groups (name) VALUES ($1) RETURNING id",
      ["W3 plain " + crypto.randomBytes(3).toString("hex")]);
    let bindingRefusal = "<no refusal>";
    try {
      await groupService.update(String(plain.rows[0].id), { identityProviderId: provider.id }, ACTOR as never);
    } catch (e: any) { bindingRefusal = String(e?.code ?? e?.message ?? e); }
    check("a half-set directory binding is refused (both columns or neither)",
      bindingRefusal === "INVALID_GROUP_BINDING", bindingRefusal);
  }

  console.log(JSON.stringify(out, null, 2));
  if (failures.length > 0) {
    console.error("W3 LIVE PROOFS FAILED: " + failures.join(", "));
    process.exit(1);
  }
  console.log("W3 live proofs: ALL PASS");
  await pool.end();
}

main().catch(async (e) => { console.error(e); process.exit(1); });
`;

// Written to a file rather than passed with --eval: relative imports resolve
// from the SCRIPT's directory, and `--eval` has no directory. The W1 live
// driver established this shape; the temp file is removed either way.
const fs = require("fs");
const tmp = path.join(__dirname, ".w3-group-sync-probe.ts");
fs.writeFileSync(tmp, probe);
const result = spawnSync(
  path.join(BACKEND, "node_modules", ".bin", "tsx"),
  [tmp],
  { cwd: BACKEND, stdio: "inherit", env: process.env },
);
fs.unlinkSync(tmp);
process.exit(result.status === null ? 1 : result.status);
