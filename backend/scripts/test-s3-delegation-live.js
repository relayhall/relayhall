#!/usr/bin/env node
/**
 * test-s3-delegation-live.js — RH-P3.AZ-S3 (card 25e5fb92; design 4d961e37
 * §5/§7/§10): behavioral proof of the delegation core against a real
 * migrated PostgreSQL through the PRODUCTION services:
 *
 *   chain + intersection: Account→Connector→Agent resolves; a wide
 *   Connector sees exactly its parent's object authority; narrowing the
 *   live own() expression narrows instantly; widening own() beyond the
 *   parent grants NOTHING (the live cap half of T1/T2 — the mint-time ⊆
 *   check rides AZ-S5's mint surface);
 *   liveness (T10): disabling the Account or revoking the Connector's last
 *   live credential kills the subtree NOW; re-enabling restores;
 *   role-arm parity (AZ-26): the Agent claimant-writes its bound task while
 *   no ancestor holds a grant there; T36: cross-bound write refused even
 *   under a broad grant; T19: elevated-role parented rows refused; rule 6:
 *   agent→agent and service-Account→Agent shapes refused;
 *   T24: terminate cascades the subtree, revokes credentials, refuses
 *   re-enable and re-issuance, idempotent;
 *   T16/T20: reveal refuses plain sessions and out-of-lineage bearers;
 *   step-up single-use consumption; graced tokens not revealable;
 *   T30: a corrupted ciphertext errors loudly on reveal and canary;
 *   §7.3: rotation is an exact copy, revokes the prior graced ancestor,
 *   grace evaluated live (between-sweep replay);
 *   T29: an over-depth chain fails the evaluator (503-class error);
 *   T37 + §10: legacy rows keep Phase-2 route authorization (upgrade
 *   fixture: a credentialed legacy account still authenticates and reads)
 *   while every new-machinery act refuses with an audited marker;
 *   097: connector registration mints the paired principal in-txn; hard
 *   delete terminates it in-txn.
 *
 * Run with DB_* env at a DISPOSABLE fresh-replay database. Exit 0 = all.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const probe = `
import { pool } from "../src/db/connection";
import { principalService } from "../src/services/PrincipalService";
import { delegationService, DelegationEvaluatorError } from "../src/services/DelegationService";
import { credentialLifecycleService } from "../src/services/CredentialLifecycleService";
import { stepUpService } from "../src/services/StepUpService";
import { grantService } from "../src/services/GrantService";
import { serviceRegistry } from "../src/services/ServiceRegistry";
import { authorizationRepository } from "../src/services/AuthorizationRepository";
import { parseOwnExpression } from "../src/services/DelegationService";
import { randomUUID } from "crypto";

const ACTOR = { principalId: null, handle: "s3-live-proof", authMethod: "system" as const };

async function main() {
  const tag = "s3-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};

  const mkTask = async (title: string) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO tasks (id, title, description, status, priority, visibility) VALUES ($1,$2,'','todo','normal','private')",
      [id, title]);
    return id;
  };

  // ── Accounts ──
  const human = (await principalService.createPrincipal({ handle: tag + "-human", kind: "human", role: "user" }))!;
  const svcAccount = (await principalService.createPrincipal({ handle: tag + "-svc", kind: "service", role: "user", purpose: "s3 live proof account" }))!;

  // ── 097: connector registration mints the paired principal in ONE txn ──
  const connectorService = await serviceRegistry.register(
    { slug: tag + "-conn", name: "S3 conn " + tag, kind: "connector" }, svcAccount.id);
  const connRow = await pool.query("SELECT principal_id FROM services WHERE id = $1", [(connectorService as any).id]);
  const connectorId = String(connRow.rows[0].principal_id);
  out.registryPairsPrincipal = Boolean(connectorId);
  const connP = await pool.query("SELECT kind, parent_principal_id, own_expression FROM principals WHERE id = $1", [connectorId]);
  out.connectorParentedToAccount = connP.rows[0].parent_principal_id === svcAccount.id
    && parseOwnExpression(connP.rows[0].own_expression) !== null;

  // Connector credential.
  const connCred = await principalService.issueCredential({ principalId: connectorId, scopes: ["tasks:read", "tasks:write"] }, ACTOR);

  // ── Agent under the Connector (direct row: the mint FLOW is AZ-S5) ──
  const boundTask = await mkTask("s3 bound " + tag);
  const agentInsert = await pool.query(
    "INSERT INTO principals (kind, handle, display_name, status, parent_principal_id, bound_task_id, own_expression) VALUES ('agent',$1,'S3 agent','active',$2,$3,$4::jsonb) RETURNING id",
    [tag + "-agent", connectorId, boundTask, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  const agentId = String(agentInsert.rows[0].id);
  const agentCred = await principalService.issueCredential({ principalId: agentId, scopes: ["tasks:read", "tasks:write"] }, ACTOR);

  // ── Chain shapes (rule 6, T19) ──
  out.t19ElevatedParentedRefused = await pool.query(
    "INSERT INTO principals (kind, handle, status, parent_principal_id, role) VALUES ('service',$1,'active',$2,'admin')",
    [tag + "-elev", svcAccount.id]).then(() => false, (e) => /parentless/.test(String(e.message)));
  out.rule6NoAgentAgent = await pool.query(
    "INSERT INTO principals (kind, handle, status, parent_principal_id, bound_task_id) VALUES ('agent',$1,'active',$2,$3)",
    [tag + "-aa", agentId, boundTask]).then(() => false, (e) => /agent→agent|agent->agent/.test(String(e.message)));
  out.rule6NoServiceAccountAgent = await pool.query(
    "INSERT INTO principals (kind, handle, status, parent_principal_id, bound_task_id) VALUES ('agent',$1,'active',$2,$3)",
    [tag + "-sa", svcAccount.id, boundTask]).then(() => false, (e) => /keyless|Connector/.test(String(e.message)));

  // ── The chain intersection, live ──
  const chainFor = async (principalId: string) => {
    const chain = await delegationService.resolveChain(principalId);
    return chain;
  };
  const actorFor = async (principalId: string, scopes: string[]) => {
    const chain = await chainFor(principalId);
    return {
      principalId, handle: "probe", role: "agent", scopes, authenticated: true,
      delegation: { links: chain.links.map((l) => ({
        principalId: l.principalId, kind: l.kind, parentPrincipalId: l.parentPrincipalId,
        boundTaskId: l.boundTaskId, legacyIdentity: l.legacyIdentity, ownExpression: l.ownExpression,
      })) },
    };
  };
  const canRead = async (principalId: string, taskId: string) =>
    (await authorizationRepository.authorizedIds(await actorFor(principalId, ["tasks:read"]), "task", [taskId], "read")).has(taskId);
  const canWrite = async (principalId: string, taskId: string) =>
    (await authorizationRepository.authorizedIds(await actorFor(principalId, ["tasks:write"]), "task", [taskId], "write")).has(taskId);

  const t1 = await mkTask("s3 parent-granted " + tag);
  const t2 = await mkTask("s3 other " + tag);
  await grantService.create({ granteeId: svcAccount.id, resourceType: "task", resourceId: t1, verb: "read" }, ACTOR);

  out.wideConnectorSeesParentAuthority = await canRead(connectorId, t1);
  out.connectorNeverExceedsParent = !(await canRead(connectorId, t2));

  // Narrow the live own() → instant effect; widening beyond parent grants nothing.
  await pool.query("UPDATE principals SET own_expression = $1::jsonb WHERE id = $2",
    [JSON.stringify({ scopes: "parent", objects: [{ resourceType: "task", selectorForm: "exact", selectorIds: [t2], verbs: ["read"] }] }), connectorId]);
  out.ownNarrowingInstant = !(await canRead(connectorId, t1));
  out.ownWideningGrantsNothing = !(await canRead(connectorId, t2)); // parent holds no t2 authority: own ∩ parent = ∅ (live T1/T2 cap)
  await pool.query("UPDATE principals SET own_expression = $1::jsonb WHERE id = $2",
    [JSON.stringify({ scopes: "parent", objects: "parent" }), connectorId]);

  // AZ-26 parity: the Agent claimant-writes its bound task with NO ancestor grant there.
  await pool.query("UPDATE tasks SET owner_principal_id = $1 WHERE id = $2", [agentId, boundTask]);
  out.agentClaimantWriteParity = await canWrite(agentId, boundTask);
  // T36: a broad grant cannot open a cross-bound write.
  await grantService.create({ granteeId: connectorId, resourceType: "task", resourceId: t2, verb: "write" }, ACTOR).catch(() => undefined);
  out.t36CrossBoundWriteRefused = !(await canWrite(agentId, t2));

  // ── Liveness (T10) ──
  await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [svcAccount.id]);
  out.t10DisabledAccountKillsSubtree = !(await chainFor(agentId)).alive;
  await pool.query("UPDATE principals SET status = 'active' WHERE id = $1", [svcAccount.id]);
  out.t10ReenableRestores = (await chainFor(agentId)).alive;
  await principalService.revokeCredentialById(connCred.credentialId, "t10 probe", ACTOR);
  out.t10RevokedIntermediateKillsDescendants = !(await chainFor(agentId)).alive;
  const connCred2 = await principalService.issueCredential({ principalId: connectorId, scopes: ["tasks:read", "tasks:write"] }, ACTOR);
  out.t10FreshCredentialRestores = (await chainFor(agentId)).alive;

  // ── Reveal (T16/T20/T30) + step-up ──
  out.t16PlainSessionRevealRefused = await credentialLifecycleService.reveal(connCred2.credentialId,
    { principalId: human.id, handle: human.handle, isRootSession: true, viaBearer: false, presentingScopes: null, stepUpToken: null }, ACTOR)
    .then(() => false, (e: any) => e.code === "STEP_UP_REQUIRED");
  const step = await stepUpService.mint(human.id, "credential.reveal", connCred2.credentialId, "password");
  const revealed = await credentialLifecycleService.reveal(connCred2.credentialId,
    { principalId: human.id, handle: human.handle, isRootSession: true, viaBearer: false, presentingScopes: null, stepUpToken: step.token }, ACTOR);
  out.revealReturnsTrueSecret = revealed.token === connCred2.fullKey;
  out.stepUpSingleUse = await credentialLifecycleService.reveal(connCred2.credentialId,
    { principalId: human.id, handle: human.handle, isRootSession: true, viaBearer: false, presentingScopes: null, stepUpToken: step.token }, ACTOR)
    .then(() => false, (e: any) => e.code === "STEP_UP_REQUIRED");
  // T20: an out-of-lineage bearer gets the 404-CONCEAL (the credential's
  // existence is never confirmed); the parent Connector succeeds within
  // its presenting-credential ceiling.
  out.t20OutOfLineageConcealed = await credentialLifecycleService.reveal(agentCred.credentialId,
    { principalId: human.id, handle: human.handle, isRootSession: false, viaBearer: true, presentingScopes: ["tasks:read", "tasks:write"], stepUpToken: null }, ACTOR)
    .then(() => false, (e: any) => e.status === 404 && e.code === "CREDENTIAL_NOT_FOUND");
  // B3: a NARROW presenting credential never discloses a broader
  // descendant secret, even inside the same lineage.
  out.t20NarrowPresentingRefused = await credentialLifecycleService.reveal(agentCred.credentialId,
    { principalId: connectorId, handle: "conn", isRootSession: false, viaBearer: true, presentingScopes: ["tasks:read"], stepUpToken: null }, ACTOR)
    .then(() => false, (e: any) => e.code === "REVEAL_EXCEEDS_PRESENTING");
  const parentReveal = await credentialLifecycleService.reveal(agentCred.credentialId,
    { principalId: connectorId, handle: "conn", isRootSession: false, viaBearer: true, presentingScopes: ["tasks:read", "tasks:write"], stepUpToken: null }, ACTOR);
  out.t20LineageRevealWorks = parentReveal.token === agentCred.fullKey;
  // B5 (§5.2 rule 8): the reveal audit row carries the FULL resolved chain.
  const revealAudit = await pool.query(
    "SELECT metadata FROM audit_events WHERE action = 'credential.reveal' ORDER BY occurred_at DESC LIMIT 1");
  const auditChain = (revealAudit.rows[0]?.metadata?.chain ?? []) as Array<{ principalId: string }>;
  out.b5RevealAuditCarriesFullChain = auditChain.length === 3
    && auditChain[0].principalId === agentId
    && auditChain[1].principalId === connectorId
    && auditChain[2].principalId === svcAccount.id;
  // B1 (§4): a profile ASSIGNED to the Connector is accepted and its
  // effective authority stays own ∩ parent — an all-of-type profile on the
  // Connector grants nothing beyond what the parent Account holds.
  const { accessProfileService } = await import("../src/services/AccessProfileService");
  const capProfile = await accessProfileService.create({ name: "s3-cap " + tag }, ACTOR);
  const capVersion = await accessProfileService.createVersion(capProfile.id, [
    { resourceType: "task", selectorForm: "all-of-type", verbs: ["read"] },
  ], ACTOR);
  await accessProfileService.publish(capProfile.id, capVersion.id, ACTOR);
  out.b1ConnectorAssignable = await accessProfileService
    .assign(capProfile.id, { assigneeType: "principal", assigneeId: connectorId }, ACTOR)
    .then(() => true, () => false);
  out.b1AssignmentStaysIntersected = (await canRead(connectorId, t1)) && !(await canRead(connectorId, t2));
  // T30: corrupt the ciphertext → loud error, no reveal.
  await pool.query("UPDATE principal_credentials SET secret_ciphertext = 'AAAA' || substr(secret_ciphertext, 5) WHERE id = $1", [agentCred.credentialId]);
  out.t30CorruptRowErrsLoudly = await credentialLifecycleService.reveal(agentCred.credentialId,
    { principalId: connectorId, handle: "conn", isRootSession: false, viaBearer: true, presentingScopes: ["tasks:read", "tasks:write"], stepUpToken: null }, ACTOR)
    .then(() => false, (e: any) => /CREDENTIAL_DECRYPT_FAILED|CREDENTIAL_INTEGRITY_FAILURE/.test(String(e.code)));

  // ── Rotation (§7.3) ──
  const rot1 = await principalService.rotateCredential(connCred2.credentialId, 24, ACTOR);
  const rotRow = await pool.query("SELECT scopes, transport, rotated_from_id FROM principal_credentials WHERE id = $1", [rot1!.credentialId]);
  out.rotationExactCopy = JSON.stringify(JSON.parse(JSON.stringify(rotRow.rows[0].scopes))) === JSON.stringify(["tasks:read", "tasks:write"])
    && rotRow.rows[0].transport === "any" && rotRow.rows[0].rotated_from_id === connCred2.credentialId;
  const graced = await pool.query("SELECT grace_until, revoked_at FROM principal_credentials WHERE id = $1", [connCred2.credentialId]);
  out.gracedNotRevoked = graced.rows[0].revoked_at === null && graced.rows[0].grace_until !== null;
  out.gracedNotRevealable = await credentialLifecycleService.reveal(connCred2.credentialId,
    { principalId: svcAccount.id, handle: "acct", isRootSession: false, viaBearer: true, presentingScopes: ["tasks:read", "tasks:write"], stepUpToken: null }, ACTOR)
    .then(() => false, (e: any) => e.code === "CREDENTIAL_GRACED");
  const rot2 = await principalService.rotateCredential(rot1!.credentialId, 24, ACTOR);
  const ancestor = await pool.query("SELECT revoked_at FROM principal_credentials WHERE id = $1", [connCred2.credentialId]);
  out.priorGracedRevokedOnNewRotation = ancestor.rows[0].revoked_at !== null;
  // Between-sweep replay: an elapsed grace watermark refuses authentication LIVE.
  await pool.query("UPDATE principal_credentials SET grace_until = NOW() - INTERVAL '1 minute' WHERE id = $1", [rot1!.credentialId]);
  const parts = { env: rot1!.fullKey.split("_")[1] as "dev" | "live", keyId: rot1!.keyId, secret: rot1!.fullKey.split(".")[1] };
  out.betweenSweepReplayDies = (await principalService.authenticatePrincipalKey(parts)) === undefined;

  // ── T29: an over-depth chain fails the evaluator ──
  let deep = null as string | null;
  for (let i = 0; i < 4; i += 1) {
    const row = await pool.query(
      "INSERT INTO principals (kind, handle, status, parent_principal_id, legacy_identity) VALUES ('service',$1,'active',$2,TRUE) RETURNING id",
      [tag + "-deep" + i, deep]);
    deep = String(row.rows[0].id);
  }
  out.t29OverDepthFailsClosed = await delegationService.resolveChain(deep!)
    .then(() => false, (e) => e instanceof DelegationEvaluatorError);

  // ── §10 legacy upgrade fixture + T37 freeze-outs ──
  const legacyRow = await pool.query(
    "INSERT INTO principals (kind, handle, status, legacy_identity, role) VALUES ('agent',$1,'active',TRUE,'agent') RETURNING id",
    [tag + "-legacy"]);
  const legacyId = String(legacyRow.rows[0].id);
  // A legacy principal still cannot be minted NEW credentials (T37)…
  out.t37LegacyMintRefused = await principalService.issueCredential({ principalId: legacyId, scopes: ["tasks:read"] }, ACTOR)
    .then(() => false, (e: any) => e.code === "LEGACY_FROZEN");
  // …but a PRE-EXISTING legacy credential keeps Phase-2 route authorization
  // (the upgrade fixture): insert a hash-only credential the Phase-2 way and
  // authenticate + read through the production path.
  const legacySecret = "legacy-secret-" + tag;
  const crypto2 = await import("crypto");
  const legacyKeyId = "legacyk" + tag.slice(3, 8);
  // GENUINE pre-096 shape (review a9e0e07d B1): base code stored SHA256 of
  // the SECRET SUFFIX only, no ciphertext. Write exactly that row.
  const legacyHash = crypto2.createHash("sha256").update(legacySecret).digest("hex");
  await pool.query(
    "INSERT INTO principal_credentials (principal_id, credential_type, key_id, secret_hash, scopes) VALUES ($1,'api_key',$2,$3,'[\\"tasks:read\\"]')",
    [legacyId, legacyKeyId, legacyHash]);
  const legacyAuth = await principalService.authenticatePrincipalKey({ env: process.env.NODE_ENV === "production" ? "live" : "dev", keyId: "legacyk" + tag.slice(3, 8), secret: legacySecret });
  out.legacyUpgradeFixtureAuthenticates = Boolean(legacyAuth && legacyAuth.principal.legacyIdentity);
  // Legacy actors evaluate under the unchanged Phase-2 arms (no delegation).
  const legacyActor = { principalId: legacyId, handle: "legacy", role: "agent", scopes: ["tasks:read"], authenticated: true, delegation: null };
  await pool.query("UPDATE tasks SET visibility = 'shared' WHERE id = $1", [t2]);
  out.legacyPhase2ArmsWork = (await authorizationRepository.authorizedIds(legacyActor as any, "task", [t2], "read")).has(t2);

  // ── Round-7 (review 731415a7) ──
  // B1: own() is a FINAL AND-CAP — a broad direct grant AND a broad
  // published profile on the Connector authorize NOTHING outside an
  // explicit narrow own() selector (point AND list).
  await pool.query("UPDATE principals SET own_expression = $1::jsonb WHERE id = $2",
    [JSON.stringify({ scopes: "parent", objects: [{ resourceType: "task", selectorForm: "exact", selectorIds: [t1], verbs: ["read"] }] }), connectorId]);
  await grantService.create({ granteeId: connectorId, resourceType: "task", resourceId: t2, verb: "read" }, ACTOR).catch(() => undefined);
  const capProfile2 = await accessProfileService.create({ name: "s3-cap2 " + tag }, ACTOR);
  const capVersion2 = await accessProfileService.createVersion(capProfile2.id, [
    { resourceType: "task", selectorForm: "all-of-type", verbs: ["read"] },
  ], ACTOR);
  await accessProfileService.publish(capProfile2.id, capVersion2.id, ACTOR);
  await accessProfileService.assign(capProfile2.id, { assigneeType: "principal", assigneeId: connectorId }, ACTOR).catch(() => undefined);
  await grantService.create({ granteeId: svcAccount.id, resourceType: "task", resourceId: t2, verb: "read" }, ACTOR).catch(() => undefined);
  out.b1OwnCapsDirectGrant = !(await canRead(connectorId, t2));
  out.b1OwnCapsProfile = !(await authorizationRepository.authorizePoint(await actorFor(connectorId, ["tasks:read"]), "task", t2, "read")).allowed;
  out.b1OwnStillAdmitsSelected = await canRead(connectorId, t1);
  await pool.query("UPDATE principals SET own_expression = $1::jsonb WHERE id = $2",
    [JSON.stringify({ scopes: "parent", objects: "parent" }), connectorId]);

  // B2: deleting a principal with descendants REFUSES (FK RESTRICT) and
  // every lineage byte survives.
  out.b2ParentDeleteRefused = await pool.query("DELETE FROM principals WHERE id = $1", [connectorId])
    .then(() => false, (e) => /foreign key|violates/.test(String(e.message)));
  out.b2LineageIntact = (await pool.query(
    "SELECT parent_principal_id FROM principals WHERE id = $1", [agentId])).rows[0].parent_principal_id === connectorId;

  // B3 (T36): a cross-bound Agent role mutation refuses in the
  // transactional service; the bound task itself accepts.
  const roleTask = await mkTask("s3 b3 roles " + tag);
  const { taskManagerDB } = await import("../src/services/TaskManagerDB");
  out.b3CrossBoundRoleRefused = await taskManagerDB.assignTaskRoles(roleTask, { verifierPrincipalId: agentId })
    .then(() => false, (e) => /CROSS_BOUND_ROLE/.test(String(e.message)));
  out.b3BoundTaskRoleAccepted = await taskManagerDB.assignTaskRoles(boundTask, { verifierPrincipalId: agentId })
    .then((outcome) => outcome === "updated" || outcome === "self_review", () => false);

  // B4: exact affected chains in the denial ledger.
  await principalService.issueCredential({ principalId: svcAccount.id, scopes: ["tasks:read"] }, ACTOR)
    .catch(() => undefined); // ACCOUNTS_ARE_KEYLESS refusal for the ledger check
  const keylessDenial = await pool.query(
    "SELECT metadata FROM audit_events WHERE action = 'credential.mint' AND outcome = 'denied' AND metadata->>'refusal' = 'ACCOUNTS_ARE_KEYLESS' ORDER BY occurred_at DESC LIMIT 1");
  const keylessChain = keylessDenial.rows[0]?.metadata?.chain ?? [];
  out.b4KeylessDenialExactChain = keylessChain.length === 1 && keylessChain[0].principalId === svcAccount.id;
  // A step-up replay denial (session path, affected = the connector chain).
  const replayStep = await stepUpService.mint(human.id, "credential.reveal", connCred2.credentialId, "password");
  await stepUpService.consume(pool, { token: replayStep.token, principalId: human.id, action: "credential.reveal", targetId: connCred2.credentialId });
  await credentialLifecycleService.reveal(connCred2.credentialId,
    { principalId: human.id, handle: human.handle, isRootSession: true, viaBearer: false, presentingScopes: null, stepUpToken: replayStep.token }, ACTOR)
    .catch(() => undefined);
  const stepDenial = await pool.query(
    "SELECT metadata FROM audit_events WHERE action = 'credential.reveal' AND outcome = 'denied' AND metadata->>'refusal' = 'STEP_UP_REQUIRED' ORDER BY occurred_at DESC LIMIT 1");
  const stepChain = stepDenial.rows[0]?.metadata?.chain ?? [];
  out.b4StepUpReplayDenialAffectedChain = stepChain.length >= 2 && stepChain[0].principalId === connectorId;

  // ── Round-6 (review 6c7d68d2) ──
  // B2: a wide Connector under a ROOT-role Account inherits board-wide
  // OBJECT authority through the production point/list adapter — proven on
  // a PRIVATE, UNOWNED task with zero grants.
  const rootAccount = await pool.query(
    "INSERT INTO principals (kind, handle, status, role) VALUES ('human',$1,'active','admin') RETURNING id",
    [tag + "-rootacct"]);
  const rootAccountId = String(rootAccount.rows[0].id);
  const rootConn = await pool.query(
    "INSERT INTO principals (kind, handle, status, parent_principal_id, own_expression) VALUES ('service',$1,'active',$2,$3::jsonb) RETURNING id",
    [tag + "-rootconn", rootAccountId, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  const rootConnId = String(rootConn.rows[0].id);
  const rootConnCred = await principalService.issueCredential({ principalId: rootConnId, scopes: ["tasks:read", "tasks:admin"] }, ACTOR);
  const unownedPrivate = await mkTask("s3 b2 unowned " + tag);
  // FULL production sequence: authenticate -> chain -> effectiveScopes ->
  // point/list authorization.
  const rootParts = { env: rootConnCred.fullKey.split("_")[1] as "dev" | "live", keyId: rootConnCred.keyId, secret: rootConnCred.fullKey.split(".")[1] };
  const rootAuth = await principalService.authenticatePrincipalKey(rootParts);
  const rootChainLive = await delegationService.resolveChain(rootConnId);
  const { scopesForRole } = await import("../src/utils/identityScopes");
  const rootEffective = delegationService.effectiveScopes(rootChainLive, rootAuth!.credential.scopes, scopesForRole("admin"));
  const rootConnActor = {
    principalId: rootConnId, handle: "rc", role: "agent", scopes: rootEffective, authenticated: true,
    delegation: { links: rootChainLive.links.map((l) => ({
      principalId: l.principalId, kind: l.kind, role: l.role, parentPrincipalId: l.parentPrincipalId,
      boundTaskId: l.boundTaskId, legacyIdentity: l.legacyIdentity, ownExpression: l.ownExpression })) },
  };
  out.b2RootAccountObjectSuperset = (await authorizationRepository.authorizedIds(rootConnActor as any, "task", [unownedPrivate], "read")).has(unownedPrivate);
  out.b2RootAccountPoint = (await authorizationRepository.authorizePoint(rootConnActor as any, "task", unownedPrivate, "read")).allowed === true;
  out.b2EffectiveHasAdminNotRoot = rootEffective.includes("tasks:admin") && !rootEffective.includes("root");

  // B3: rule-8 refusal + rotation audits in the COMMITTED ledger.
  await principalService.issueCredential({ principalId: svcAccount.id, scopes: ["tasks:read"] }, ACTOR)
    .catch(() => undefined); // ACCOUNTS_ARE_KEYLESS — the denial must be durable
  const deniedMint = await pool.query(
    "SELECT metadata FROM audit_events WHERE action = 'credential.mint' AND outcome = 'denied' ORDER BY occurred_at DESC LIMIT 1");
  out.b3MintRefusalAudited = deniedMint.rows[0]?.metadata?.refusal === "ACCOUNTS_ARE_KEYLESS"
    && Array.isArray(deniedMint.rows[0]?.metadata?.chain);
  const rotateAudit = await pool.query(
    "SELECT metadata FROM audit_events WHERE action = 'credential.rotate' ORDER BY occurred_at DESC LIMIT 1");
  out.b3RotationActAudited = Boolean(rotateAudit.rows[0])
    && Boolean(rotateAudit.rows[0].metadata?.predecessorId)
    && Boolean(rotateAudit.rows[0].metadata?.successorId)
    && Array.isArray(rotateAudit.rows[0].metadata?.chain);
  // The reveal section above already produced denials (concealed foreign
  // target, narrow presenting, missing step-up): the LEDGER must carry
  // them durably with reason + chain despite the transaction rollbacks.
  const deniedReveal = await pool.query(
    "SELECT metadata FROM audit_events WHERE action = 'credential.reveal' AND outcome = 'denied' ORDER BY occurred_at DESC LIMIT 3");
  out.b3RevealRefusalAudited = deniedReveal.rows.length > 0
    && deniedReveal.rows.every((r) => typeof r.metadata?.refusal === "string" && Array.isArray(r.metadata?.chain));

  // ── Round-4 (review ab857740) ──
  // B2: a Connector exercises a delegated per-object admin scope through
  // the PRODUCTION authorization path; the Agent layer never does.
  const adminTask = await mkTask("s3 b2 admin " + tag);
  await grantService.create({ granteeId: svcAccount.id, resourceType: "task", resourceId: adminTask, verb: "admin" }, ACTOR);
  const connectorAdminActor = await actorFor(connectorId, ["tasks:admin"]);
  out.b2ConnectorAdminReachable = (await authorizationRepository.authorizedIds(connectorAdminActor, "task", [adminTask], "admin")).has(adminTask);
  const agentAdminActor = await actorFor(agentId, ["tasks:admin"]);
  out.b2AgentAdminRefused = !(await authorizationRepository.authorizedIds(agentAdminActor, "task", [adminTask], "admin")).has(adminTask);

  // B3 (T36): assigning an Agent a profile carrying OPEN task write
  // authority refuses at the MUTATION; a bound-only exact write profile is
  // accepted.
  const crossProfile = await accessProfileService.create({ name: "s3-cross " + tag }, ACTOR);
  const crossVersion = await accessProfileService.createVersion(crossProfile.id, [
    { resourceType: "task", selectorForm: "all-of-type", verbs: ["write"] },
  ], ACTOR);
  await accessProfileService.publish(crossProfile.id, crossVersion.id, ACTOR);
  out.b3CrossBoundAssignmentRefused = await accessProfileService
    .assign(crossProfile.id, { assigneeType: "principal", assigneeId: agentId }, ACTOR)
    .then(() => false, (e: any) => e.code === "ASSIGNMENT_CROSS_BOUND");
  const boundProfile = await accessProfileService.create({ name: "s3-bound " + tag }, ACTOR);
  const boundVersion = await accessProfileService.createVersion(boundProfile.id, [
    { resourceType: "task", selectorForm: "exact", selectorIds: [boundTask], verbs: ["write"] },
  ], ACTOR);
  await accessProfileService.publish(boundProfile.id, boundVersion.id, ACTOR);
  out.b3BoundOnlyAssignmentAccepted = await accessProfileService
    .assign(boundProfile.id, { assigneeType: "principal", assigneeId: agentId }, ACTOR)
    .then(() => true, () => false);

  // ── Round-3 (review 2fcd548c) ──
  // B2: a foreign bearer probing a REVOKED credential still sees only 404 —
  // lifecycle state is concealed outside the lineage.
  const foreignProbe = await principalService.issueCredential({ principalId: connectorId, scopes: ["tasks:read"] }, ACTOR);
  await principalService.revokeCredentialById(foreignProbe.credentialId, "b2 probe", ACTOR);
  out.b2ForeignRevokedConcealed = await credentialLifecycleService.reveal(foreignProbe.credentialId,
    { principalId: human.id, handle: human.handle, isRootSession: false, viaBearer: true, presentingScopes: ["tasks:read"], stepUpToken: null }, ACTOR)
    .then(() => false, (e: any) => e.status === 404 && e.code === "CREDENTIAL_NOT_FOUND");

  // B5: rotating an already-graced source refuses — at most two live per
  // chain holds sequentially, not just under the happy path.
  out.b5GracedSourceRotateRefused = await principalService.rotateCredential(rot1!.credentialId, 24, ACTOR)
    .then(() => false, (e: any) => e.code === "ROTATE_FROM_RETIRED");
  const liveCount = await pool.query(
    "SELECT COUNT(*)::int AS n FROM principal_credentials WHERE principal_id = $1 AND revoked_at IS NULL AND (grace_until IS NULL OR grace_until > NOW())",
    [connectorId]);
  out.b5AtMostTwoLive = Number(liveCount.rows[0].n) <= 2;

  // B1: re-running migration 096 must NOT reclassify valid post-096
  // identities as legacy (one-time disposition by construction).
  const fs2 = await import("node:fs");
  const m096 = fs2.readFileSync(require("path").join(__dirname, "../src/migrations/096_delegation_substrate.sql"), "utf8");
  await pool.query(m096);
  const post096 = await pool.query(
    "SELECT id, legacy_identity FROM principals WHERE id = ANY($1::uuid[])", [[connectorId, agentId]]);
  out.b1RerunKeepsIdentitiesValid = post096.rows.every((r) => r.legacy_identity === false);
  out.b1RerunKeepsChainAlive = (await chainFor(agentId)).alive;

  // B5: termination invalidates the Principal caches — a warmed cache row
  // cannot let the login-JWT plane outlive the offboarding.
  const cacheVictim = (await principalService.createPrincipal({ handle: tag + "-cachev", kind: "human", role: "user" }))!;
  await principalService.getPrincipalById(cacheVictim.id); // warm the cache
  await credentialLifecycleService.terminate(cacheVictim.id, ACTOR);
  const afterTerminate = await principalService.getPrincipalById(cacheVictim.id);
  out.b5TerminateInvalidatesCache = afterTerminate?.status === "terminated";

  // ── T24: terminate cascades ──
  const termination = await credentialLifecycleService.terminate(connectorId, ACTOR);
  const agentAfter = await pool.query("SELECT status FROM principals WHERE id = $1", [agentId]);
  out.t24SubtreeTerminated = termination.terminated.includes(agentId) && agentAfter.rows[0].status === "terminated";
  out.t24CredentialsRevoked = (await pool.query(
    "SELECT COUNT(*)::int AS n FROM principal_credentials WHERE principal_id = ANY($1::uuid[]) AND revoked_at IS NULL",
    [[connectorId, agentId]])).rows[0].n === 0;
  out.t24ReenableRefused = await pool.query(
    "UPDATE principals SET status = 'active' WHERE id = $1", [connectorId])
    .then(() => false, (e) => /irreversible/.test(String(e.message)));
  out.t24IssuanceRefused = await principalService.issueCredential({ principalId: connectorId, scopes: ["tasks:read"] }, ACTOR)
    .then(() => false, (e: any) => e.code === "PRINCIPAL_TERMINATED");
  const again = await credentialLifecycleService.terminate(connectorId, ACTOR);
  out.t24Idempotent = again.terminated.includes(connectorId);

  // ── 097: hard delete terminates the paired principal AND its subtree ──
  const conn2 = await serviceRegistry.register({ slug: tag + "-conn2", name: "S3 conn2", kind: "connector" }, svcAccount.id);
  const conn2Pid = String((await pool.query("SELECT principal_id FROM services WHERE id = $1", [(conn2 as any).id])).rows[0].principal_id);
  await principalService.issueCredential({ principalId: conn2Pid, scopes: ["tasks:read"] }, ACTOR);
  const childTask = await mkTask("s3 b6 child " + tag);
  const childAgent = await pool.query(
    "INSERT INTO principals (kind, handle, status, parent_principal_id, bound_task_id, own_expression) VALUES ('agent',$1,'active',$2,$3,$4::jsonb) RETURNING id",
    [tag + "-b6agent", conn2Pid, childTask, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  const childAgentId = String(childAgent.rows[0].id);
  const childCred = await principalService.issueCredential({ principalId: childAgentId, scopes: ["tasks:read"] }, ACTOR);
  await serviceRegistry.delete((conn2 as any).id);
  out.registryDeleteTerminatesPrincipal = (await pool.query(
    "SELECT status FROM principals WHERE id = $1", [conn2Pid])).rows[0].status === "terminated";
  // B6: the descendant Agent is durably terminated and its credential revoked.
  out.b6DeleteTerminatesSubtree = (await pool.query(
    "SELECT status FROM principals WHERE id = $1", [childAgentId])).rows[0].status === "terminated";
  out.b6DescendantCredentialRevoked = (await pool.query(
    "SELECT revoked_at FROM principal_credentials WHERE id = $1", [childCred.credentialId])).rows[0].revoked_at !== null;
  // B1 (round 4): a HOSTILE pre-existing principal already holding the
  // derived connector handle is NEVER linked by the 097 backfill — the
  // service gets a fresh remediation principal, and deleting the service
  // leaves the hostile principal untouched.
  const hostile = await pool.query(
    "INSERT INTO principals (kind, handle, display_name, status) VALUES ('human',$1,'Hostile squatter','active') RETURNING id",
    ["connector-hostile-" + tag]);
  const hostileId = String(hostile.rows[0].id);
  // Recreate the PRE-097 orphan shape: the connector-required CHECK is
  // dropped (as before 097), the orphan row inserted, and the re-run of
  // 097 below re-adds the CHECK after backfilling — the exact upgrade path.
  await pool.query("ALTER TABLE services DROP CONSTRAINT IF EXISTS services_connector_principal_required");
  const orphanSvc = await pool.query(
    "INSERT INTO services (slug, name, kind) VALUES ($1,$2,'connector') RETURNING id",
    ["hostile-" + tag, "Hostile collision " + tag]);
  const orphanSvcId = String(orphanSvc.rows[0].id);
  const fs097 = await import("node:fs");
  const m097 = fs097.readFileSync(require("path").join(__dirname, "../src/migrations/097_registry_unification.sql"), "utf8");
  await pool.query(m097);
  const linked = await pool.query("SELECT principal_id FROM services WHERE id = $1", [orphanSvcId]);
  const linkedId = String(linked.rows[0].principal_id);
  out.b1HostileCollisionNotLinked = linkedId !== hostileId && Boolean(linkedId);
  await serviceRegistry.delete(orphanSvcId);
  const hostileAfter = await pool.query("SELECT status FROM principals WHERE id = $1", [hostileId]);
  out.b1HostileSurvivesDeletion = hostileAfter.rows[0].status === "active";

  // B2 (round 5): a ROOT-style caller registers a Connector for a NAMED
  // owning Account via ownerAccountId — the Connector parents to the named
  // Account, not to the acting principal.
  const ownerTargeted = await serviceRegistry.register(
    { slug: tag + "-owned", name: "b2 owner-targeted", kind: "connector", ownerAccountId: svcAccount.id }, human.id);
  const ownedParent = await pool.query(
    "SELECT p.parent_principal_id FROM services s JOIN principals p ON p.id = s.principal_id WHERE s.id = $1",
    [(ownerTargeted as any).id]);
  out.b2OwnerTargetedRegistration = String(ownedParent.rows[0].parent_principal_id) === svcAccount.id;

  // B4: boundary slugs — 54 chars keeps the plain handle; 64 chars derives a
  // fitting collision-safe handle; both register with paired principals.
  const shortSlug = "s".repeat(54);
  const longSlug = "l".repeat(64);
  const svcShort = await serviceRegistry.register({ slug: shortSlug, name: "b4 short", kind: "connector" }, svcAccount.id);
  const svcLong = await serviceRegistry.register({ slug: longSlug, name: "b4 long", kind: "connector" }, svcAccount.id);
  const pShort = await pool.query("SELECT p.handle FROM services s JOIN principals p ON p.id = s.principal_id WHERE s.id = $1", [(svcShort as any).id]);
  const pLong = await pool.query("SELECT p.handle FROM services s JOIN principals p ON p.id = s.principal_id WHERE s.id = $1", [(svcLong as any).id]);
  out.b4ShortSlugPlainHandle = pShort.rows[0].handle === "connector-" + shortSlug;
  out.b4LongSlugDerivedHandle = pLong.rows[0].handle.length <= 64 && pLong.rows[0].handle.startsWith("connector-" + "l".repeat(45));

  console.log(JSON.stringify(out));
  const failures = Object.entries(out).filter(([, v]) => typeof v === "boolean" && !v);
  await pool.end();
  if (failures.length > 0) {
    console.error("FAILED:", failures.map(([k]) => k).join(", "));
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
`;

const fs = require("fs");
const tmp = path.join(__dirname, ".s3-delegation-probe.ts");
fs.writeFileSync(tmp, probe);
const result = spawnSync(path.join(__dirname, "..", "node_modules", ".bin", "tsx"), [tmp], {
  stdio: "inherit",
  env: {
    ...process.env,
    RELAYHALL_CREDENTIAL_KEYS: process.env.RELAYHALL_CREDENTIAL_KEYS
      || JSON.stringify({ livekey: Buffer.alloc(32, 9).toString("base64") }),
    RELAYHALL_CREDENTIAL_ACTIVE_KEY: process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY || "livekey",
  },
  cwd: path.join(__dirname, ".."),
});
fs.unlinkSync(tmp);
process.exit(result.status ?? 1);
