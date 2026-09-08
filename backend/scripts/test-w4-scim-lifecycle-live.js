#!/usr/bin/env node
/**
 * test-w4-scim-lifecycle-live.js — RH-P5.SSO.W4 candidate B against a REAL
 * migrated PostgreSQL, through the PRODUCTION services and middleware.
 *
 * What a mocked pool cannot prove, this does — four things, each named by the
 * sentence that governs it:
 *
 *   expected:   the SCIM producer writes an `expected` Identity link whose
 *               subject is `externalId` (ruling 6bdcc16c §1), in the Account's
 *               transaction; a push without one is refused by name and creates
 *               nothing. AT THE DATABASE BOUNDARY, application out of the
 *               picture: a direct INSERT INTO auth_sessions naming that row is
 *               rejected by migration 104's trigger (SS-24, annex row extended
 *               to this producer); after promotion the same INSERT is accepted
 *               (positive control), and a link revoked while expected stays
 *               unusable.
 *   promotion:  `promote` succeeds once; a CONCURRENT second promotion loses;
 *               a subject mismatch promotes nothing (annex SS-24 vectors).
 *   disable:    AZ-A4 clause 2 as amended 2026-09-01, asserted not assumed —
 *               through the REAL authMiddleware and sharedAuthorizationMiddleware
 *               mount: an rh_ key beneath the Account that worked ONE REQUEST
 *               AGO fails on the very next request after `active=false`; an
 *               open login session (the cached-principal plane) ends on ITS
 *               next request; the Account is disabled, NOT terminated; the flag
 *               is raised; retained tokens on the dead login sessions = 0;
 *               a LOCAL group membership survives; `active=true` reverses it;
 *               an Account disabled on the board is not re-enabled by the
 *               directory; DELETE is the second signal.
 *   heartbeat:  SSO-R8 — the `scim:<id>` row is stale before the first push,
 *               fresh after it, stale again past the interval on the existing
 *               AZ-30 read, and absent when the interval is NULL.
 *
 * Run with DB_* env at a DISPOSABLE fresh-replay database (init.sql, then
 * migrate to 107). NEVER at relayhall-dev-db-1, relayhall-tst-db-1 or the
 * ClawBoard database — the drill disables the seeded Identity provider and
 * writes principals. Exit 0 = every check true.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const probe = `
import express from "express";
import http from "http";
import { randomUUID } from "crypto";
import { pool } from "../src/db/connection";
import { principalService } from "../src/services/PrincipalService";
import { serviceRegistry } from "../src/services/ServiceRegistry";
import { loginSessionService, SESSION_COOKIE_NAME } from "../src/services/LoginSessionService";
import { groupService } from "../src/services/GroupService";
import { identityProviderService } from "../src/services/identity/IdentityProviderService";
import { identityLinkService } from "../src/services/identity/IdentityLinkService";
import { scimProvisioningService, scimHeartbeatKey, ScimError } from "../src/services/identity/ScimProvisioningService";
import { authMiddleware } from "../src/middleware/auth";
import { sharedAuthorizationMiddleware } from "../src/middleware/sharedAuthorization";
import scimRouter from "../src/routes/scim";
import { jsonBodyOptions } from "../src/utils/jsonBodyTypes";

const ACTOR = { principalId: null, handle: "w4b-live-proof", authMethod: "system" as const };
const SCOPE = "directory-provisioning:write";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

async function main() {
  const tag = "w4b-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};
  const info: Record<string, unknown> = {};

  // ── the estate: a parentless service Account and its REGISTRY Connector, bound as the SCIM client ──
  const account = (await principalService.createPrincipal({ handle: tag + "-svc", kind: "service", role: "user", purpose: "w4b live proof" }))!;
  const registered = await serviceRegistry.register({ slug: tag + "-dir", name: "Directory " + tag, kind: "connector" }, account.id);
  const pairing = await pool.query("SELECT principal_id FROM services WHERE id = $1 AND kind = 'connector'", [(registered as any).id]);
  const connectorId = String(pairing.rows[0].principal_id);
  const displaced = await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active' RETURNING id");
  info.displacedSeededIdentityProviders = displaced.rowCount;

  // The ENABLED Identity provider the route-level acts go through. SS-22's
  // configuration-time refusal (migration 104) still stands until candidate C,
  // so it is jit-mode; the lifecycle and the heartbeat do not read the mode.
  const idp = await identityProviderService.create({
    name: "W4B live " + tag, issuer: "https://issuer." + tag + ".example/", clientId: "rh",
    clientAuthMethod: "none", subjectImmutable: true, status: "active", provisioningMode: "jit",
    scimHeartbeatIntervalHours: 6,
  }, ACTOR);
  await identityProviderService.setScimClient(idp.id, account.id, ACTOR);
  const connectorKey = (await principalService.issueCredential({ principalId: connectorId, scopes: [SCOPE] }, ACTOR)).fullKey;

  // ── heartbeat, before any push: the row exists and reads STALE ──
  const key = scimHeartbeatKey(idp.id);
  const status = async () => (await groupService.syncStatus()).find((row) => row.provider === key);
  const before = await status();
  out.heartbeatRowCreatedWithTheInterval = before !== undefined && before.stalenessThresholdHours === 6;
  out.heartbeatStaleBeforeFirstPush = before !== undefined && before.stale === true && before.lastSuccessAt === null;

  // ── the surfaces, mounted as server.ts mounts every protected family ──
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use("/scim", authMiddleware, sharedAuthorizationMiddleware, scimRouter);
  // The acceptance probe: the REAL ingress authentication and nothing behind
  // it, so "the key works" and "the key fails" are decided by authMiddleware
  // alone — the seam AZ-A4 clause 2 is a statement about.
  app.get("/probe", authMiddleware, (_req, res) => { res.json({ ok: true }); });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const scim = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + "/scim/v2" + p, { method,
      headers: { "content-type": "application/json", authorization: "Bearer " + connectorKey },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const probeKey = async (k: string) => (await fetch(base + "/probe", { headers: { authorization: "Bearer " + k } })).status;
  const probeCookie = async (token: string) => (await fetch(base + "/probe", { headers: { cookie: SESSION_COOKIE_NAME + "=" + token } })).status;
  const principalRow = async (id: string) => (await pool.query("SELECT status FROM principals WHERE id = $1", [id])).rows[0];
  const flagRow = async (id: string) => (await pool.query("SELECT deprovision_signal, deprovisioned_at FROM directory_provisioned_accounts WHERE account_principal_id = $1", [id])).rows[0];

  // ── arrival: the push creates the Account; the heartbeat moves ──
  const ada = await scim("POST", "/Users", { userName: tag + "-ada", externalId: "ext-" + tag + "-ada", displayName: "Ada " + tag });
  out.pushCreates201 = ada.status === 201;
  const adaId = String(ada.body.id);
  const after = await status();
  out.heartbeatFreshAfterPush = after !== undefined && after.stale === false && after.lastSuccessAt !== null && after.stalenessThresholdHours === 6;

  // ── the two planes that must die on the NEXT request ──
  // rh_ plane: a Connector beneath the provisioned human Account, holding a live key.
  const adaConnector = await serviceRegistry.register({ slug: tag + "-ada-agent", name: "Ada's tool " + tag, kind: "connector", ownerAccountId: adaId }, null);
  const adaConnectorId = String((await pool.query("SELECT principal_id FROM services WHERE id = $1", [(adaConnector as any).id])).rows[0].principal_id);
  const adaKey = (await principalService.issueCredential({ principalId: adaConnectorId, scopes: ["tasks:read"] }, ACTOR)).fullKey;
  // login-JWT plane: an open login session for the human Account (the cached-principal path).
  const login = await loginSessionService.mint({ principalId: adaId });
  // a LOCAL group membership that must survive (T-SS14 blast radius)
  const group = await groupService.create({ name: "w4b local " + tag }, ACTOR);
  await groupService.addMember(group.id, { accountPrincipalId: adaId, source: "local" }, ACTOR);

  out.keyWorksOneRequestAgo = (await probeKey(adaKey)) === 200;
  out.loginSessionWorksOneRequestAgo = (await probeCookie(login.token)) === 200;

  // ── the FIRST signal: active=false by PUT ──
  const disabled = await scim("PUT", "/Users/" + adaId, { userName: tag + "-ada", externalId: "ext-" + tag + "-ada", active: false });
  out.activeFalseAnswers200Inactive = disabled.status === 200 && disabled.body.active === false;
  out.keyFailsOnTheVeryNextRequest = (await probeKey(adaKey)) === 401;
  out.loginSessionEndsOnItsNextRequest = (await probeCookie(login.token)) === 401;
  const adaRow = await principalRow(adaId);
  out.accountDisabledNotTerminated = adaRow.status === "disabled";
  const adaFlag = await flagRow(adaId);
  out.flagRaisedInactive = adaFlag.deprovision_signal === "inactive" && adaFlag.deprovisioned_at !== null;
  const dead = await pool.query("SELECT count(*)::int AS live, count(id_token_ct)::int AS retained FROM auth_sessions WHERE principal_id = $1 AND revoked_at IS NULL", [adaId]);
  out.noLiveLoginSessionRemains = dead.rows[0].live === 0;
  const retained = await pool.query("SELECT count(id_token_ct)::int AS retained FROM auth_sessions WHERE principal_id = $1", [adaId]);
  out.retainedTokensOnDeadLoginSessionsZero = retained.rows[0].retained === 0;
  const membership = await pool.query("SELECT source FROM group_members WHERE group_id = $1 AND account_principal_id = $2", [group.id, adaId]);
  out.localMembershipSurvives = membership.rows.length === 1 && membership.rows[0].source === "local";
  const audit = await pool.query("SELECT metadata FROM audit_events WHERE action = 'directory.account.deprovision' AND resource_id = $1", [adaId]);
  out.deprovisionAudited = audit.rows.length === 1 && audit.rows[0].metadata.signal === "inactive" && audit.rows[0].metadata.status_after === "disabled";

  // ── the reverse signal: active=true by PATCH ──
  const reenabled = await scim("PATCH", "/Users/" + adaId, { schemas: [PATCH_SCHEMA], Operations: [{ op: "replace", path: "active", value: true }] });
  out.activeTrueReenables = reenabled.status === 200 && reenabled.body.active === true && (await principalRow(adaId)).status === "active";
  out.flagClearedOnReenable = (await flagRow(adaId)).deprovision_signal === null;
  out.keyWorksAgainAfterReenable = (await probeKey(adaKey)) === 200;

  // ── an Account disabled ON THE BOARD is not the directory's to re-enable ──
  await principalService.updatePrincipal(adaId, { status: "disabled" });
  const refused = await scim("PUT", "/Users/" + adaId, { userName: tag + "-ada", active: true });
  out.boardDisabledNotReenabledByDirectory = refused.status === 400 && refused.body.scimType === "mutability" && (await principalRow(adaId)).status === "disabled";

  // ── the SECOND signal: DELETE = removal from the provisioning scope ──
  const grace = await scim("POST", "/Users", { userName: tag + "-grace", externalId: "ext-" + tag + "-grace" });
  const graceId = String(grace.body.id);
  const removed = await scim("DELETE", "/Users/" + graceId);
  out.deleteAnswers204 = removed.status === 204;
  out.deleteDisablesNotTerminates = (await principalRow(graceId)).status === "disabled";
  out.deleteRaisesFlagRemoved = (await flagRow(graceId)).deprovision_signal === "removed";
  const graceRead = await scim("GET", "/Users/" + graceId);
  out.removedResourceStaysReadableInactive = graceRead.status === 200 && graceRead.body.active === false;

  // ── heartbeat silence past the interval, on the existing AZ-30 read ──
  await pool.query("UPDATE directory_sync_state SET last_success_at = now() - interval '7 hours' WHERE provider = $1", [key]);
  out.silencePastIntervalIsStale = (await status())!.stale === true;
  await scim("GET", "/Users?count=0");
  out.aReadIsAPushAndClearsIt = (await status())!.stale === false;
  await pool.query("UPDATE directory_sync_state SET last_success_at = now() - interval '5 hours' WHERE provider = $1", [key]);
  out.silenceWithinIntervalIsNotStale = (await status())!.stale === false;
  await identityProviderService.update(idp.id, { scimHeartbeatIntervalHours: null }, ACTOR);
  out.nullIntervalRemovesTheRow = (await status()) === undefined;
  await scim("GET", "/Users?count=0");
  out.nullIntervalRecordsNoPush = (await status()) === undefined;
  const claimRow = await pool.query("SELECT 1 FROM directory_sync_state WHERE provider = $1", [idp.id]);
  out.claimSyncRowUntouched = claimRow.rows.length === 0;

  // ── the expected-link producer and the DB boundary (SS-24), through the REAL service ──
  // A directory-mode Identity provider row: migration 104 admits it DISABLED
  // (SS-22's refusal is on activation, lifted in candidate C), and the producer
  // reads the mode from the row, so the writer is drilled on real schema. The
  // route-level resolution needs an ENABLED Identity provider and is therefore
  // the part candidate C's live drill covers.
  const dirIdp = await identityProviderService.create({
    name: "W4B dir " + tag, issuer: "https://dir." + tag + ".example/", clientId: "rh",
    clientAuthMethod: "none", subjectImmutable: true, status: "disabled", provisioningMode: "directory",
  }, ACTOR);
  out.directoryModeRowIsDisabledUntilC = dirIdp.provisioningMode === "directory" && dirIdp.status === "disabled";
  const scimActor = { principalId: connectorId, handle: "scim", authMethod: "principal_api_key" as const };
  const noSubject = await scimProvisioningService.createUser(dirIdp, scimActor, { userName: tag + "-nosub" }).then(() => null, (e) => e);
  out.directoryModeRefusesMissingExternalIdByName = noSubject instanceof ScimError && noSubject.status === 400 && /externalId/.test(noSubject.message);
  out.refusedPushCreatedNothing = (await pool.query("SELECT 1 FROM principals WHERE handle = $1", [tag + "-nosub"])).rows.length === 0;

  const subject = "sub-" + tag;
  const expectedUser = await scimProvisioningService.createUser(dirIdp, scimActor, { userName: tag + "-exp", externalId: subject });
  const link = await pool.query("SELECT id, state, promoted_at, subject FROM identity_links WHERE account_principal_id = $1", [expectedUser.id]);
  out.expectedLinkWrittenWithExternalIdAsSubject = link.rows.length === 1 && link.rows[0].state === "expected" && link.rows[0].promoted_at === null && link.rows[0].subject === subject;
  const linkId = String(link.rows[0].id);
  const sessionInsert = (accountId: string, l: string) => pool.query(
    "INSERT INTO auth_sessions (id, principal_id, token_hash, expires_at, identity_provider_id, identity_link_id) VALUES ($1, $2, $3, now() + interval '1 hour', $4, $5) RETURNING id",
    [randomUUID(), accountId, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), dirIdp.id, l]);
  const rejected = await sessionInsert(expectedUser.id, linkId).then(() => null, (e) => e);
  out.dbBoundaryRefusesSessionOnExpectedLink = rejected !== null && rejected.code === "23514" && /expectation is not a proof/.test(String(rejected.message));

  // promotion vectors
  out.mismatchPromotesNothing = (await identityLinkService.promote(dirIdp.id, subject + "-other")) === undefined
    && (await pool.query("SELECT state FROM identity_links WHERE id = $1", [linkId])).rows[0].state === "expected";
  const race = await Promise.all([identityLinkService.promote(dirIdp.id, subject), identityLinkService.promote(dirIdp.id, subject)]);
  out.concurrentPromotionExactlyOneWins = race.filter(Boolean).length === 1;
  out.promotedIsProvenWithInstant = (await pool.query("SELECT state, promoted_at FROM identity_links WHERE id = $1", [linkId])).rows[0].state === "proven"
    && (await pool.query("SELECT promoted_at FROM identity_links WHERE id = $1", [linkId])).rows[0].promoted_at !== null;
  out.secondPromotionLoses = (await identityLinkService.promote(dirIdp.id, subject)) === undefined;
  const accepted = await sessionInsert(expectedUser.id, linkId).then((r) => r.rows[0].id, () => null);
  out.positiveControlProvenLinkIssuesSession = accepted !== null;
  if (accepted) await pool.query("DELETE FROM auth_sessions WHERE id = $1", [accepted]);

  // a link revoked while expected stays unusable
  const revokedUser = await scimProvisioningService.createUser(dirIdp, scimActor, { userName: tag + "-rev", externalId: subject + "-rev" });
  const revokedLinkId = String((await pool.query("SELECT id FROM identity_links WHERE account_principal_id = $1", [revokedUser.id])).rows[0].id);
  await identityLinkService.unlink(revokedLinkId, "w4b-drill", ACTOR);
  out.revokedWhileExpectedCannotPromote = (await identityLinkService.promote(dirIdp.id, subject + "-rev")) === undefined;
  const revokedInsert = await sessionInsert(revokedUser.id, revokedLinkId).then(() => null, (e) => e);
  out.revokedWhileExpectedIssuesNoSession = revokedInsert !== null && revokedInsert.code === "23514";

  server.close();
  await pool.end();
  const failed = Object.entries(out).filter(([, v]) => v !== true).map(([k]) => k);
  console.log(JSON.stringify({ tag, checks: out, info, failed }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error("PROBE ERROR:", e && e.stack || e); process.exit(2); });
`;

const backend = path.resolve(__dirname, "..");
const fs = require("fs");
const probePath = path.join(backend, "scripts", ".w4-scim-lifecycle-live.probe.ts");
fs.writeFileSync(probePath, probe);
let status = 2;
try {
  const result = spawnSync(path.join(backend, "node_modules", ".bin", "tsx"), [probePath], {
    cwd: backend, stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "development",
      // The login-session cookie is inert until this flag is on (SS-W1); the
      // clause-2 assertion about the cached-principal plane needs it live.
      // Without it the "works one request ago" control fails, which is the
      // point of that control: the plane must be proven alive before it is
      // proven dead.
      RELAYHALL_SESSIONS: process.env.RELAYHALL_SESSIONS || "on",
      JWT_SECRET: process.env.JWT_SECRET || "w4b-live-proof-jwt-secret-not-for-production-0123456789" },
  });
  status = result.status === null ? 2 : result.status;
} finally {
  // `process.exit` inside `try` would skip this block and leave the probe
  // behind for the allowlist gate to find — which is how it was first found.
  fs.unlinkSync(probePath);
}
process.exit(status);
