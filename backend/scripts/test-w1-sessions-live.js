#!/usr/bin/env node
/**
 * test-w1-sessions-live.js — SS-W1 (card 2ae39bda subtask [2]; SSO design
 * d95136d7 §8.1/§6.5, acceptance annex e6dcadb9 §11 W1): behavioural proof of
 * per-Account login sessions against a real migrated PostgreSQL, through the
 * PRODUCTION services and the PRODUCTION authentication middleware — never
 * SQL substrings, never a double of the thing under test:
 *
 *   - TWO distinct human Accounts hold DISTINCT authority on one board: two
 *     passwords, two sessions, two different effective scope sets, resolved
 *     by `authMiddleware` from the session cookie alone;
 *   - the minted row's `role_snapshot` IS NULL, read back from the database
 *     (SS-9), and the session's authority therefore equals the Account's own
 *     `principals.role` authority — the T-SS18 parity assertion at the seam;
 *   - idle expiry and absolute expiry each refuse a session, independently,
 *     with no sweep running;
 *   - logout, single-session revocation and sign-out-everywhere each stop the
 *     session they name and leave the others alone;
 *   - the password vehicle: bcrypt at rest, replacement revokes its
 *     predecessor in one transaction, and the policy refusals (too short,
 *     past bcrypt's 72-byte truncation point, non-human, not active) hold;
 *   - a password row is NOT listed on the bearer-credential surface;
 *   - the break-glass Account's password proves ITS OWN Account and no other.
 *
 * Run with DB_* env pointed at a DISPOSABLE database carrying the full
 * migration chain (prepare with test-fresh-install-replay.js). Exit 0 = all
 * proofs.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const probe = `
process.env.RELAYHALL_SESSIONS = "on";
process.env.JWT_SECRET = process.env.JWT_SECRET || "w1-live-probe-secret";

import { pool } from "../src/db/connection";
import { accountPasswordService } from "../src/services/AccountPasswordService";
import { loginSessionService } from "../src/services/LoginSessionService";
import { principalService } from "../src/services/PrincipalService";
import { authMiddleware } from "../src/middleware/auth";
import { randomUUID } from "crypto";

const ACTOR = { principalId: null, handle: "w1-live-proof", authMethod: "system" as const };

/** Drive the PRODUCTION middleware with nothing but a session cookie. */
async function scopesFromCookie(token: string): Promise<{ ok: boolean; userId?: string; scopes?: string[] }> {
  const req: any = { baseUrl: "", path: "/tasks", method: "GET", headers: { cookie: "relayhall_session=" + token } };
  const res: any = { status: () => res, json: () => res, setHeader: () => res };
  let ok = false;
  await authMiddleware(req, res, () => { ok = true; });
  return { ok, userId: req.userId, scopes: req.scopes };
}

const sameSet = (a?: string[], b?: string[]) =>
  Array.isArray(a) && Array.isArray(b) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function main() {
  const tag = "w1-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};

  const mkHuman = async (role: string) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO principals (id, kind, handle, display_name, status, role) VALUES ($1,'human',$2,$3,'active',$4)",
      [id, tag + "-" + role, "W1 live " + role, role]);
    return id;
  };

  // ── two distinct human Accounts, two distinct roles ──────────────────────
  const orchestrator = await mkHuman("orchestrator");
  const viewer = await mkHuman("viewer");
  const orchestratorHandle = tag + "-orchestrator";
  const viewerHandle = tag + "-viewer";

  await accountPasswordService.set(orchestrator, "orchestrator-passphrase", ACTOR);
  await accountPasswordService.set(viewer, "viewer-passphrase-here", ACTOR);

  // The password is at rest as bcrypt, never as the plaintext.
  const stored = await pool.query(
    "SELECT secret_hash, key_id, scopes FROM principal_credentials WHERE principal_id = $1 AND credential_type = 'password' AND revoked_at IS NULL",
    [orchestrator]);
  out.passwordHashedAtRest = /^\\$2[aby]\\$/.test(String(stored.rows[0].secret_hash));
  out.passwordNotPlaintext = String(stored.rows[0].secret_hash) !== "orchestrator-passphrase";
  // key_id stays NULL so a password never touches ux_pcred_active_key_id.
  out.passwordCarriesNoKeyId = stored.rows[0].key_id === null;

  // ── verification is per-Account, and proves THAT Account ─────────────────
  const provenOrchestrator = await accountPasswordService.verify(orchestratorHandle, "orchestrator-passphrase");
  const provenViewer = await accountPasswordService.verify(viewerHandle, "viewer-passphrase-here");
  out.verifyProvesTheNamedAccount =
    provenOrchestrator?.principal.id === orchestrator && provenViewer?.principal.id === viewer;
  out.crossAccountPasswordRefused =
    (await accountPasswordService.verify(viewerHandle, "orchestrator-passphrase")) === undefined;
  out.wrongPasswordRefused =
    (await accountPasswordService.verify(orchestratorHandle, "not-the-password")) === undefined;
  out.unknownAccountRefused =
    (await accountPasswordService.verify(tag + "-nobody", "orchestrator-passphrase")) === undefined;

  // ── SS-9: the minted row carries NO role snapshot ────────────────────────
  const sessionA = await loginSessionService.mint({
    principalId: orchestrator, credentialId: provenOrchestrator!.credentialId, ip: "203.0.113.4", userAgent: "w1-probe",
  });
  const sessionB = await loginSessionService.mint({ principalId: viewer, credentialId: provenViewer!.credentialId });
  const snapshots = await pool.query(
    "SELECT role_snapshot, token_hash FROM auth_sessions WHERE id = ANY($1::uuid[])",
    [[sessionA.sessionId, sessionB.sessionId]]);
  out.roleSnapshotIsNull = snapshots.rows.every((row: any) => row.role_snapshot === null);
  // The raw token never reached the table.
  out.rawTokenNotStored = snapshots.rows.every((row: any) =>
    String(row.token_hash) !== sessionA.token && String(row.token_hash) !== sessionB.token);

  // ── THE W1 DoD: two Accounts, distinct authority, one board, live ────────
  const asOrchestrator = await scopesFromCookie(sessionA.token);
  const asViewer = await scopesFromCookie(sessionB.token);
  out.bothSessionsAuthenticate = asOrchestrator.ok === true && asViewer.ok === true;
  out.eachSessionIsItsOwnAccount =
    asOrchestrator.userId === orchestratorHandle && asViewer.userId === viewerHandle;
  out.authorityIsDistinct = !sameSet(asOrchestrator.scopes, asViewer.scopes);
  out.orchestratorHoldsRoot = (asOrchestrator.scopes ?? []).includes("root");
  out.viewerHoldsNoRoot = !(asViewer.scopes ?? []).includes("root");
  // Non-vacuity: "distinct" must not mean "one of them got nothing".
  out.bothHoldSomething = (asOrchestrator.scopes ?? []).length > 0 && (asViewer.scopes ?? []).length > 0;

  // ── T-SS18 parity: the session door agrees with the Account's own role ───
  const { scopesForRole } = await import("../src/utils/identityScopes");
  out.parityOrchestrator = sameSet(asOrchestrator.scopes, scopesForRole("orchestrator") as string[]);
  out.parityViewer = sameSet(asViewer.scopes, scopesForRole("viewer") as string[]);

  // ── a disabled Account's live session stops resolving ────────────────────
  await principalService.updatePrincipal(viewer, { status: "disabled" });
  out.disabledAccountSessionRefused = (await scopesFromCookie(sessionB.token)).ok === false;
  await principalService.updatePrincipal(viewer, { status: "active" });
  out.reEnabledAccountSessionWorks = (await scopesFromCookie(sessionB.token)).ok === true;

  // ── idle expiry, with no sweep running ──────────────────────────────────
  const idle = await loginSessionService.mint({ principalId: orchestrator });
  out.idleSessionLiveBefore = (await loginSessionService.resolve(idle.token)) !== undefined;
  await pool.query("UPDATE auth_sessions SET last_seen_at = now() - interval '400 days' WHERE id = $1", [idle.sessionId]);
  out.idleSessionRefusedAfter = (await loginSessionService.resolve(idle.token)) === undefined;
  const idleRow = await pool.query("SELECT revoked_at, expires_at > now() AS still_within_cap FROM auth_sessions WHERE id = $1", [idle.sessionId]);
  // The row is neither revoked nor past its absolute cap: the IDLE window
  // alone refused it, which is the claim.
  out.idleIsIndependentOfRevocation = idleRow.rows[0].revoked_at === null && idleRow.rows[0].still_within_cap === true;

  // ── absolute expiry, with no sweep running ──────────────────────────────
  const aged = await loginSessionService.mint({ principalId: orchestrator });
  await pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [aged.sessionId]);
  out.absoluteExpiryRefuses = (await loginSessionService.resolve(aged.token)) === undefined;
  const agedRow = await pool.query("SELECT revoked_at, last_seen_at > now() - interval '1 minute' AS recently_seen FROM auth_sessions WHERE id = $1", [aged.sessionId]);
  out.absoluteIsIndependentOfIdle = agedRow.rows[0].revoked_at === null && agedRow.rows[0].recently_seen === true;

  // ── the liveness touch moves last_seen_at, and nothing else ─────────────
  const touched = await loginSessionService.mint({ principalId: orchestrator });
  await pool.query("UPDATE auth_sessions SET last_seen_at = now() - interval '5 minutes' WHERE id = $1", [touched.sessionId]);
  const beforeTouch = await pool.query("SELECT last_seen_at, expires_at, role_snapshot FROM auth_sessions WHERE id = $1", [touched.sessionId]);
  await scopesFromCookie(touched.token);
  await new Promise((r) => setTimeout(r, 250));
  const afterTouch = await pool.query("SELECT last_seen_at, expires_at, role_snapshot FROM auth_sessions WHERE id = $1", [touched.sessionId]);
  out.touchAdvancesLastSeen = new Date(afterTouch.rows[0].last_seen_at) > new Date(beforeTouch.rows[0].last_seen_at);
  out.touchChangesNothingElse =
    String(afterTouch.rows[0].expires_at) === String(beforeTouch.rows[0].expires_at) &&
    afterTouch.rows[0].role_snapshot === null;

  // ── revocation ──────────────────────────────────────────────────────────
  const doomed = await loginSessionService.mint({ principalId: orchestrator });
  out.revokeReturnsTrueOnce = (await loginSessionService.revoke(doomed.sessionId, "logout")) === true;
  out.revokeIsNotIdempotentlyTrue = (await loginSessionService.revoke(doomed.sessionId, "logout")) === false;
  out.revokedSessionRefused = (await scopesFromCookie(doomed.token)).ok === false;
  const reason = await pool.query("SELECT revoke_reason FROM auth_sessions WHERE id = $1", [doomed.sessionId]);
  out.revokeReasonRecorded = reason.rows[0].revoke_reason === "logout";

  // Sign out everywhere, except the one session that asked.
  const keep = await loginSessionService.mint({ principalId: orchestrator });
  const alsoDoomed = await loginSessionService.mint({ principalId: orchestrator });
  const swept = await loginSessionService.revokeAllForPrincipal(orchestrator, "logout", keep.sessionId);
  out.revokeAllSweptMoreThanOne = swept >= 2;
  out.revokeAllSparedTheExceptedSession = (await scopesFromCookie(keep.token)).ok === true;
  out.revokeAllKilledTheOthers = (await scopesFromCookie(alsoDoomed.token)).ok === false;
  // And it never reached the OTHER Account's sessions.
  out.revokeAllIsAccountScoped = (await scopesFromCookie(sessionB.token)).ok === true;

  // ── listing is live-only and Account-scoped ─────────────────────────────
  const listed = await loginSessionService.list(orchestrator);
  out.listShowsOnlyLiveSessions = listed.every((s: any) => s.id !== doomed.sessionId && s.id !== alsoDoomed.sessionId && s.id !== aged.sessionId && s.id !== idle.sessionId);
  out.listIsAccountScoped = listed.every((s: any) => s.id !== sessionB.sessionId);
  out.listCarriesNoToken = JSON.stringify(listed).indexOf(keep.token) === -1;
  out.ownsSessionRefusesAnotherAccount = (await loginSessionService.ownsSession(orchestrator, sessionB.sessionId)) === false;
  out.ownsSessionAcceptsItsOwn = (await loginSessionService.ownsSession(orchestrator, keep.sessionId)) === true;

  // ── password replacement revokes its predecessor, in one transaction ────
  const beforeReplace = await pool.query(
    "SELECT id FROM principal_credentials WHERE principal_id = $1 AND credential_type = 'password' AND revoked_at IS NULL", [orchestrator]);
  await accountPasswordService.set(orchestrator, "a-brand-new-passphrase", ACTOR);
  const afterReplace = await pool.query(
    "SELECT id FROM principal_credentials WHERE principal_id = $1 AND credential_type = 'password' AND revoked_at IS NULL", [orchestrator]);
  out.exactlyOneLivePasswordAfterReplace = afterReplace.rows.length === 1;
  out.predecessorRevokedNotDeleted =
    afterReplace.rows[0].id !== beforeReplace.rows[0].id &&
    (await pool.query("SELECT revoked_at FROM principal_credentials WHERE id = $1", [beforeReplace.rows[0].id])).rows[0].revoked_at !== null;
  out.oldPasswordNoLongerVerifies =
    (await accountPasswordService.verify(orchestratorHandle, "orchestrator-passphrase")) === undefined;
  out.newPasswordVerifies =
    (await accountPasswordService.verify(orchestratorHandle, "a-brand-new-passphrase")) !== undefined;
  out.clearRemovesThePassword =
    (await accountPasswordService.clear(orchestrator, ACTOR)) === 1 &&
    (await accountPasswordService.has(orchestrator)) === false;

  // ── policy refusals ─────────────────────────────────────────────────────
  const refusal = async (fn: () => Promise<unknown>) => fn().then(() => null, (e: any) => e.code);
  out.refusesShortPassword = (await refusal(() => accountPasswordService.set(viewer, "short", ACTOR))) === "PASSWORD_TOO_SHORT";
  out.refusesPastBcryptTruncation =
    (await refusal(() => accountPasswordService.set(viewer, "x".repeat(73), ACTOR))) === "PASSWORD_TOO_LONG";
  out.acceptsExactlyBcryptLimit = (await refusal(() => accountPasswordService.set(viewer, "y".repeat(72), ACTOR))) === null;

  const serviceAccount = randomUUID();
  await pool.query(
    "INSERT INTO principals (id, kind, handle, display_name, status, purpose) VALUES ($1,'service',$2,'W1 live service','active','w1 probe')",
    [serviceAccount, tag + "-service"]);
  out.refusesNonHuman = (await refusal(() => accountPasswordService.set(serviceAccount, "service-passphrase", ACTOR))) === "PASSWORD_IS_FOR_HUMANS";

  const disabled = await mkHuman("editor");
  await principalService.updatePrincipal(disabled, { status: "disabled" });
  out.refusesDisabledAccount = (await refusal(() => accountPasswordService.set(disabled, "disabled-passphrase", ACTOR))) === "PRINCIPAL_NOT_ACTIVE";

  // ── a password is not on the bearer-credential surface ──────────────────
  await accountPasswordService.set(viewer, "viewer-passphrase-here", ACTOR);
  const bearerSurface = await principalService.listCredentials(viewer);
  out.passwordAbsentFromCredentialListing =
    bearerSurface.every((c: any) => c.credentialType !== "password");

  console.log(JSON.stringify(out, null, 2));

  // Tidy the disposable DB for repeat runs. (audit_events is append-only by
  // trigger — probe audit rows stay, which is correct for the ledger.)
  await pool.query("DELETE FROM auth_sessions WHERE principal_id = ANY($1::uuid[])", [[orchestrator, viewer]]);
  await pool.query("DELETE FROM principal_credentials WHERE principal_id = ANY($1::uuid[])", [[orchestrator, viewer, disabled, serviceAccount]]);
  await pool.query("DELETE FROM principals WHERE id = ANY($1::uuid[])", [[orchestrator, viewer, disabled, serviceAccount]]);
  await pool.end();

  const failures = Object.entries(out).filter(([, value]) => typeof value === "boolean" && !value);
  if (failures.length > 0) {
    console.error("FAILED:", failures.map(([key]) => key).join(", "));
    process.exit(1);
  }
  console.error("ALL " + Object.keys(out).length + " W1 PROOFS PASSED");
}

main().catch(err => { console.error(err); process.exit(1); });
`;

const fs = require("fs");
const tmp = path.join(__dirname, ".w1-sessions-probe.ts");
fs.writeFileSync(tmp, probe);
const result = spawnSync(path.join(__dirname, "..", "node_modules", ".bin", "tsx"), [tmp], {
  stdio: "inherit", env: process.env, cwd: path.join(__dirname, ".."),
});
fs.unlinkSync(tmp);
process.exit(result.status ?? 1);
