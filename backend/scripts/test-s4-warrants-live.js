#!/usr/bin/env node
/**
 * test-s4-warrants-live.js — RH-P3.AZ-S4 (card aa48fb12; design 4d961e37
 * §6, A17.5/A17.11): behavioral proof of Warrants + Approvals against a
 * real migrated PostgreSQL through the PRODUCTION services:
 *
 *   warrant creation: holder-shape / ceiling-required / multi-anchor
 *   expiry refusals; version pinning at creation;
 *   warrant-mint: agent minted with parent = acting Connector (AZ-RT5),
 *   bound task, provenance FK, encrypted credential, minted_total counter,
 *   unique-warrant auto-select and multiplicity refusal (sol M8);
 *   T4: foreign-task mint refuses on anchor containment;
 *   T23: republish the ceiling profile WIDER — the standing warrant stays
 *   pinned and the wider mint still refuses;
 *   T17: max_total and max_concurrent refuse loudly; a freed slot mints;
 *   T18: a GENUINE two-connection concurrent race on max_total=1 admits
 *   exactly one mint; revoke-then-mint refuses;
 *   T2 (mint-time ⊆): scopes beyond the requester's effective set and
 *   rules beyond the Account's sources refuse;
 *   AZ-28: one write-bound Agent per task — a second tasks:write mint
 *   refuses while a read+reports sibling mints;
 *   approvals: quota T21 (6th pending refuses, audited); edit-down
 *   approval; credential-bound collect mints once (single-use);
 *   T27/AZ-31c: rotation lapses pending AND approved items with reason
 *   CREDENTIAL_ROTATED; decide-after-rotate and collect-after-rotate
 *   refuse; task-terminal between decide and collect LAPSES; a held
 *   writer slot refuses WITHOUT consuming (still approved);
 *   §6.1a session mint: atomic Approval row with session evidence,
 *   credential id NULL, parent = the human Account; service Accounts
 *   refuse;
 *   AZ-31a: creator narrowed below the ceiling auto-suspends LOUDLY at
 *   mint; resume refuses while the cap fails and succeeds after a grant
 *   restores it;
 *   sweeps: anchor-terminal expiry persists and is ONE-WAY (the DB
 *   trigger refuses resurrection); pending-TTL lapse persists.
 *
 * Run with DB_* env at a DISPOSABLE fresh-replay database. Exit 0 = all.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const probe = `
import { pool } from "../src/db/connection";
import { runMigrations } from "../src/db/migrate";
import { principalService } from "../src/services/PrincipalService";
import { delegationService } from "../src/services/DelegationService";
import { serviceRegistry } from "../src/services/ServiceRegistry";
import { warrantService } from "../src/services/WarrantService";
import { approvalService } from "../src/services/ApprovalService";
import { accessProfileService } from "../src/services/AccessProfileService";
import { grantService } from "../src/services/GrantService";
import { stepUpService } from "../src/services/StepUpService";
import { randomUUID } from "crypto";

const ACTOR = { principalId: null, handle: "s4-live-proof", authMethod: "system" as const };

async function main() {
  await runMigrations(false);
  const tag = "s4-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};
  const code = (p: Promise<unknown>, expected: string) =>
    p.then(() => false, (e: any) => e.code === expected || (String(e.message).includes(expected)));

  const mkTask = async (title: string, projectId?: string) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO tasks (id, title, description, status, priority, visibility, project_id) VALUES ($1,$2,'','todo','normal','private',$3)",
      [id, title, projectId ?? null]);
    return id;
  };

  // ── setup: admin Account, service Account, Connector + credential ────
  const admin = (await principalService.createPrincipal({ handle: tag + "-admin", kind: "human", role: "admin" }))!;
  const plainHuman = (await principalService.createPrincipal({ handle: tag + "-plain", kind: "human", role: "user" }))!;
  const svcAccount = (await principalService.createPrincipal({ handle: tag + "-svc", kind: "service", role: "user", purpose: "s4 live proof account" }))!;
  const connSvc = await serviceRegistry.register({ slug: tag + "-conn", name: "S4 conn", kind: "connector" }, svcAccount.id);
  const connectorId = String((await pool.query("SELECT principal_id FROM services WHERE id = $1", [(connSvc as any).id])).rows[0].principal_id);
  await pool.query("UPDATE principals SET own_expression = $2::jsonb WHERE id = $1",
    [connectorId, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  const connCred = await principalService.issueCredential(
    { principalId: connectorId, scopes: ["tasks:read", "tasks:write", "reports:write"] }, ACTOR);

  const projectId = randomUUID();
  await pool.query("INSERT INTO projects (id, name) VALUES ($1,$2)", [projectId, "S4 " + tag]);
  const taskA = await mkTask("s4 A " + tag, projectId);
  const taskB = await mkTask("s4 B " + tag, projectId);
  const foreignTask = await mkTask("s4 foreign " + tag);

  const effectiveScopesOf = async (principalId: string, credScopes: string[]) => {
    const chain = await delegationService.resolveChain(principalId);
    const account = chain.links[chain.links.length - 1];
    const { scopesForRole } = await import("../src/utils/identityScopes");
    return delegationService.effectiveScopes(chain, credScopes, scopesForRole(account.role));
  };

  // ── warrant creation validations ─────────────────────────────────────
  const rootCreator = { principalId: admin.id, isRoot: true, stepUp: { tokenId: "probe", method: "password" } };
  out.holderShapeRefused = await code(warrantService.create({
    name: "bad holder", holderPrincipalId: admin.id,
    anchors: [{ anchorType: "task", anchorId: taskA }],
    ceilingRules: [{ resourceType: "task", selectorForm: "all-of-type", selectorIds: [], verbs: ["read"] }],
  } as any, rootCreator, ACTOR), "INVALID_HOLDER_SHAPE");
  out.ceilingRequired = await code(warrantService.create({
    name: "no ceiling", holderPrincipalId: connectorId,
    anchors: [{ anchorType: "task", anchorId: taskA }],
  } as any, rootCreator, ACTOR), "CEILING_REQUIRED");
  out.multiAnchorExpiryRequired = await code(warrantService.create({
    name: "no expiry", holderPrincipalId: connectorId,
    anchors: [{ anchorType: "task", anchorId: taskA }, { anchorType: "task", anchorId: taskB }],
    ceilingRules: [{ resourceType: "task", selectorForm: "all-of-type", selectorIds: [], verbs: ["read"] }],
  } as any, rootCreator, ACTOR), "EXPIRY_REQUIRED");

  // ── T23: version-pinned profile ceiling ──────────────────────────────
  const profile = await accessProfileService.create({ name: "s4 ceiling " + tag, description: "" }, ACTOR);
  const v1 = await accessProfileService.createVersion(profile.id, [
    { resourceType: "report", selectorForm: "all-of-type", selectorIds: [], verbs: ["read"] },
  ], ACTOR);
  await accessProfileService.publish(profile.id, v1.id, ACTOR);
  const pinnedWarrant = await warrantService.create({
    name: "pinned " + tag, holderPrincipalId: connectorId,
    anchors: [{ anchorType: "task", anchorId: taskA }],
    ceilingProfileId: profile.id, ceilingScopes: ["tasks:read", "reports:write"],
  } as any, rootCreator, ACTOR);
  out.warrantPinsPublishedVersion = pinnedWarrant.ceilingProfileVersionId === profile.publishedVersionId
    || pinnedWarrant.ceilingProfileVersionNumber === 1;
  const v2 = await accessProfileService.createVersion(profile.id, [
    { resourceType: "report", selectorForm: "all-of-type", selectorIds: [], verbs: ["read", "write"] },
  ], ACTOR);
  await accessProfileService.publish(profile.id, v2.id, ACTOR);
  const connEff = await effectiveScopesOf(connectorId, ["tasks:read", "tasks:write", "reports:write"]);
  out.t23RepublishNeverWidens = await code(warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskA,
    warrantId: pinnedWarrant.id,
    authority: { scopes: ["tasks:read"], rules: [{ resourceType: "report", selectorForm: "all-of-type", selectorIds: [], verbs: ["read", "write"] }] },
  }, ACTOR), "CEILING_EXCEEDED");

  // ── happy warrant mint + provenance + auto-select ────────────────────
  const projWarrant = await warrantService.create({
    name: "proj " + tag, holderPrincipalId: connectorId,
    anchors: [{ anchorType: "project", anchorId: projectId }],
    ceilingRules: [{ resourceType: "task", selectorForm: "all-of-type", selectorIds: [], verbs: ["read", "write"] }],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    maxTotal: 4, maxConcurrent: 2,
  } as any, rootCreator, ACTOR);
  // ── T2: the mint-time ⊆ check ────────────────────────────────────────
  out.t2ScopeExceedsRefused = await code(warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: await effectiveScopesOf(connectorId, ["tasks:read"]),
    targetTaskId: taskB, warrantId: projWarrant.id,
    authority: { scopes: ["tasks:write", "tasks:read"], rules: [] },
  }, ACTOR), "MINT_EXCEEDS_REQUESTER");

  // Auto-select is now AMBIGUOUS: two live warrants (pinned + proj) contain taskA.
  out.autoSelectAmbiguityRefuses = await code(warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskA,
    warrantId: null, authority: { scopes: ["tasks:read"], rules: [] },
  }, ACTOR), "AMBIGUOUS_WARRANT");
  // taskB is contained ONLY by projWarrant → unique auto-select succeeds.
  const packB = await warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskB,
    warrantId: null, authority: { scopes: ["tasks:read", "tasks:write"], rules: [] },
  }, ACTOR);
  out.autoSelectUniqueSucceeds = packB.mintedUnderWarrantId === projWarrant.id;
  const mintedRow = (await pool.query(
    "SELECT parent_principal_id, bound_task_id, minted_under_warrant_id, kind, role FROM principals WHERE id = $1",
    [packB.principalId])).rows[0];
  out.agentParentIsActingConnector = String(mintedRow.parent_principal_id) === connectorId;
  out.agentBoundToTask = String(mintedRow.bound_task_id) === taskB;
  out.provenanceFkRecorded = String(mintedRow.minted_under_warrant_id) === projWarrant.id;
  out.agentMinimalRole = mintedRow.role === null;
  const credRow = (await pool.query(
    "SELECT secret_ciphertext, expires_at FROM principal_credentials WHERE id = $1", [packB.credentialId])).rows[0];
  out.agentCredentialEncrypted = Boolean(credRow.secret_ciphertext);
  out.agentCredentialExpiryMandatory = Boolean(credRow.expires_at);
  out.mintedTotalCounted = (await warrantService.get(projWarrant.id)).mintedTotal === 1;
  out.selectedWarrantAudited = (await pool.query(
    "SELECT 1 FROM audit_events WHERE action = 'agent.minted' AND resource_id = $1 AND metadata->>'selectedWarrantId' = $2",
    [packB.principalId, projWarrant.id])).rows.length === 1;

  // ── AZ-28: one write-bound Agent per task ────────────────────────────
  out.writerSlotRefusesSecondWriter = await code(warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskB,
    warrantId: projWarrant.id, authority: { scopes: ["tasks:read", "tasks:write"], rules: [] },
  }, ACTOR), "WRITER_SLOT_TAKEN");
  const sibling = await warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskB,
    warrantId: projWarrant.id, authority: { scopes: ["tasks:read", "reports:write"], rules: [] },
  }, ACTOR);
  out.readSiblingMints = Boolean(sibling.principalId);

  // ── T4: containment ──────────────────────────────────────────────────
  out.t4ForeignTaskRefused = await code(warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: foreignTask,
    warrantId: projWarrant.id, authority: { scopes: ["tasks:read"], rules: [] },
  }, ACTOR), "ANCHOR_CONTAINMENT_FAILED");

  // ── T17 + T18: caps, races, revocation ───────────────────────────────
  const taskC = await mkTask("s4 C " + tag, projectId);
  const capWarrant = await warrantService.create({
    name: "cap " + tag, holderPrincipalId: connectorId,
    anchors: [{ anchorType: "task", anchorId: taskC }],
    ceilingRules: [{ resourceType: "task", selectorForm: "all-of-type", selectorIds: [], verbs: ["read"] }],
    maxTotal: 1,
  } as any, rootCreator, ACTOR);
  const race = await Promise.allSettled([
    warrantService.mintUnderWarrant({
      actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskC,
      warrantId: capWarrant.id, authority: { scopes: ["tasks:read"], rules: [] },
    }, ACTOR),
    warrantService.mintUnderWarrant({
      actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskC,
      warrantId: capWarrant.id, authority: { scopes: ["tasks:read"], rules: [] },
    }, ACTOR),
  ]);
  const raceWins = race.filter((r) => r.status === "fulfilled");
  out.t18ExactlyOneConcurrentMint = raceWins.length === 1
    && race.some((r) => r.status === "rejected" && (r as any).reason.code === "WARRANT_CAP_EXHAUSTED");
  out.t18CounterConsistent = (await warrantService.get(capWarrant.id)).mintedTotal === 1;
  out.t17OverCapAudited = (await pool.query(
    "SELECT 1 FROM audit_events WHERE action = 'agent.mint' AND outcome = 'denied' AND metadata->>'refusal' = 'WARRANT_CAP_EXHAUSTED' AND resource_id = $1",
    [capWarrant.id])).rows.length >= 1;
  // concurrent-slot cap: taskB agents (writer + sibling) hold projWarrant's 2 slots.
  const taskD = await mkTask("s4 D " + tag, projectId);
  out.t17ConcurrentCapRefuses = await code(warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskD,
    warrantId: projWarrant.id, authority: { scopes: ["tasks:read"], rules: [] },
  }, ACTOR), "WARRANT_CAP_EXHAUSTED");
  // a slot frees: revoke the sibling's credential → live count drops.
  await principalService.revokeCredentialById(sibling.credentialId, "s4 free slot", ACTOR);
  const packD = await warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskD,
    warrantId: projWarrant.id, authority: { scopes: ["tasks:read"], rules: [] },
  }, ACTOR);
  out.t17SlotFreesOnRevocation = Boolean(packD.principalId);
  // revoke-then-mint refuses.
  await warrantService.revoke(capWarrant.id, "s4 done", ACTOR);
  out.revokedWarrantRefusesMint = await code(warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskC,
    warrantId: capWarrant.id, authority: { scopes: ["tasks:read"], rules: [] },
  }, ACTOR), "WARRANT_REVOKED");

  // ── approvals: quota, edit-down, credential-bound collect ────────────
  const taskE = await mkTask("s4 E " + tag);
  const requested = await approvalService.request({
    requesterPrincipalId: connectorId, requestingCredentialId: connCred.credentialId,
    targetTaskId: taskE, requestedScopes: ["tasks:read", "tasks:write", "reports:write"],
  }, ACTOR);
  out.approvalPending = requested.status === "pending";
  for (let i = 0; i < 4; i += 1) {
    await approvalService.request({
      requesterPrincipalId: connectorId, requestingCredentialId: connCred.credentialId,
      targetTaskId: taskE, requestedScopes: ["tasks:read"],
    }, ACTOR);
  }
  out.t21QuotaRefusesLoudly = await code(approvalService.request({
    requesterPrincipalId: connectorId, requestingCredentialId: connCred.credentialId,
    targetTaskId: taskE, requestedScopes: ["tasks:read"],
  }, ACTOR), "MINT_QUOTA_EXCEEDED");
  out.t21QuotaAudited = (await pool.query(
    "SELECT 1 FROM audit_events WHERE action = 'approval.request' AND outcome = 'denied' AND metadata->>'refusal' = 'MINT_QUOTA_EXCEEDED'")).rows.length >= 1;

  const decided = await approvalService.decide({
    approvalId: requested.id, decision: "approve",
    editedScopes: ["tasks:read", "reports:write"],
    deciderPrincipalId: admin.id, stepUp: { tokenId: "probe", method: "password" },
  }, ACTOR);
  out.editDownRecorded = decided.status === "approved"
    && JSON.stringify(decided.approvedScopes) === JSON.stringify(["tasks:read", "reports:write"]);
  const collected = await approvalService.collect({
    approvalId: requested.id, presentingCredentialId: connCred.credentialId,
    presentingPrincipalId: connectorId, presentingEffectiveScopes: connEff,
  }, ACTOR);
  out.collectMintsApprovedAuthority = JSON.stringify(collected.scopes) === JSON.stringify(["tasks:read", "reports:write"]);
  out.collectSingleUse = await code(approvalService.collect({
    approvalId: requested.id, presentingCredentialId: connCred.credentialId,
    presentingPrincipalId: connectorId, presentingEffectiveScopes: connEff,
  }, ACTOR), "APPROVAL_NOT_COLLECTABLE");

  // ── T27 / AZ-31c: rotation invalidates; task-terminal lapses; writer
  // slot refuses without consuming ─────────────────────────────────────
  const taskF = await mkTask("s4 F " + tag);
  const preRotate = await approvalService.request({
    requesterPrincipalId: connectorId, requestingCredentialId: connCred.credentialId,
    targetTaskId: taskF, requestedScopes: ["tasks:read"],
  }, ACTOR);
  const rotated = await principalService.rotateCredential(connCred.credentialId, 24, ACTOR);
  out.t27RotationLapsesOutstanding = (await approvalService.get(preRotate.id)).status === "lapsed"
    && (await approvalService.get(preRotate.id)).lapseReason === "CREDENTIAL_ROTATED";
  out.t27DecideAfterRotateRefuses = await code(approvalService.decide({
    approvalId: preRotate.id, decision: "approve",
    deciderPrincipalId: admin.id, stepUp: { tokenId: "probe", method: "password" },
  }, ACTOR), "APPROVAL_NOT_PENDING");
  // successor re-requests → approve → task turns terminal → collect lapses.
  const successorCredId = rotated!.credentialId;
  const taskG = await mkTask("s4 G " + tag);
  const termReq = await approvalService.request({
    requesterPrincipalId: connectorId, requestingCredentialId: successorCredId,
    targetTaskId: taskG, requestedScopes: ["tasks:read"],
  }, ACTOR);
  await approvalService.decide({
    approvalId: termReq.id, decision: "approve",
    deciderPrincipalId: admin.id, stepUp: { tokenId: "probe", method: "password" },
  }, ACTOR);
  await pool.query("UPDATE tasks SET status = 'completed' WHERE id = $1", [taskG]);
  out.t27TaskTerminalLapsesAtCollect = await code(approvalService.collect({
    approvalId: termReq.id, presentingCredentialId: successorCredId,
    presentingPrincipalId: connectorId, presentingEffectiveScopes: connEff,
  }, ACTOR), "APPROVAL_LAPSED");
  out.t27LapseReasonRecorded = (await approvalService.get(termReq.id)).status === "lapsed";
  // transient: writer slot held → refuse WITHOUT consuming.
  const writeReq = await approvalService.request({
    requesterPrincipalId: connectorId, requestingCredentialId: successorCredId,
    targetTaskId: taskB, requestedScopes: ["tasks:read", "tasks:write"],
  }, ACTOR);
  await approvalService.decide({
    approvalId: writeReq.id, decision: "approve",
    deciderPrincipalId: admin.id, stepUp: { tokenId: "probe", method: "password" },
  }, ACTOR);
  out.t27WriterSlotTransientRefuses = await code(approvalService.collect({
    approvalId: writeReq.id, presentingCredentialId: successorCredId,
    presentingPrincipalId: connectorId, presentingEffectiveScopes: connEff,
  }, ACTOR), "WRITER_SLOT_TAKEN");
  out.t27TransientKeepsApproved = (await approvalService.get(writeReq.id)).status === "approved";

  // ── §6.1a session mint ───────────────────────────────────────────────
  const taskH = await mkTask("s4 H " + tag);
  const sessionMint = await approvalService.sessionMint({
    accountPrincipalId: admin.id, sessionScopes: ["root"], targetTaskId: taskH,
    requestedScopes: ["tasks:read", "tasks:write"], stepUp: { tokenId: "probe-su", method: "password" },
  }, ACTOR);
  out.sessionMintCollected = sessionMint.approval.status === "collected"
    && sessionMint.approval.requestingCredentialId === null
    && sessionMint.approval.sessionEvidence !== null;
  const sessionAgent = (await pool.query(
    "SELECT parent_principal_id, kind FROM principals WHERE id = $1", [sessionMint.pack.principalId])).rows[0];
  out.sessionMintParentIsAccount = String(sessionAgent.parent_principal_id) === admin.id;
  out.sessionMintServiceRefused = await code(approvalService.sessionMint({
    accountPrincipalId: svcAccount.id, sessionScopes: ["root"], targetTaskId: taskH,
    requestedScopes: ["tasks:read"], stepUp: { tokenId: "x", method: "password" },
  }, ACTOR), "SESSION_MINT_IS_HUMAN");
  // step-up store roundtrip (production path shape): mint + single-use consume.
  const su = await stepUpService.mint(admin.id, "agent.mint", taskH, "password");
  const consumed = await stepUpService.consume(pool, { token: su.token, principalId: admin.id, action: "agent.mint", targetId: taskH });
  out.stepUpConsumes = Boolean(consumed.tokenId);
  out.stepUpSingleUse = await code(stepUpService.consume(pool, { token: su.token, principalId: admin.id, action: "agent.mint", targetId: taskH }), "STEP_UP_REQUIRED");

  // ── AZ-31a: creator live-cap auto-suspend + resume ───────────────────
  const taskI = await mkTask("s4 I " + tag);
  const narrowWarrant = await warrantService.create({
    name: "narrow-creator " + tag, holderPrincipalId: connectorId,
    anchors: [{ anchorType: "task", anchorId: taskI }],
    ceilingRules: [{ resourceType: "task", selectorForm: "exact", selectorIds: [taskI], verbs: ["read"] }],
  } as any, rootCreator, ACTOR);
  // Re-point the creator at a PLAIN human with no sources: the cap fails.
  await pool.query("UPDATE warrants SET created_by_principal_id = $2 WHERE id = $1", [narrowWarrant.id, plainHuman.id]);
  out.az31aAutoSuspendsLoudly = await code(warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskI,
    warrantId: narrowWarrant.id, authority: { scopes: ["tasks:read"], rules: [] },
  }, ACTOR), "WARRANT_SUSPENDED");
  const suspended = await warrantService.get(narrowWarrant.id);
  out.az31aStatusPersisted = suspended.status === "suspended" && Boolean(suspended.suspendedReason);
  out.az31aSuspensionEventWritten = (await pool.query(
    "SELECT 1 FROM warrant_events WHERE warrant_id = $1 AND action = 'warrant.suspended'", [narrowWarrant.id])).rows.length >= 1;
  out.az31aResumeRefusesWhileCapFails = await code(
    warrantService.resume(narrowWarrant.id, ACTOR), "CREATOR_CAP_UNMET");
  await grantService.create({
    granteeType: "principal", granteeId: plainHuman.id, resourceType: "task", resourceId: taskI, verb: "read",
  } as any, ACTOR);
  const resumed = await warrantService.resume(narrowWarrant.id, ACTOR);
  out.az31aResumeAfterRestore = resumed.status === "active";

  // ── round-2 repairs (review 1897c959 B1/B2) ─────────────────────────
  // B1 creation half: a non-root creator cannot put scopes it does not
  // hold into ceilingScopes, even with the object ceiling covered.
  await grantService.create({
    granteeType: "principal", granteeId: plainHuman.id, resourceType: "task", resourceId: null, verb: "read",
  } as any, ACTOR);
  const taskL = await mkTask("s4 L " + tag);
  out.b1CreationScopeHalfRefused = await code(warrantService.create({
    name: "b1 " + tag, holderPrincipalId: connectorId,
    anchors: [{ anchorType: "task", anchorId: taskL }],
    ceilingRules: [{ resourceType: "task", selectorForm: "all-of-type", selectorIds: [], verbs: ["read"] }],
    ceilingScopes: ["tasks:read", "tasks:write"],
  } as any, { principalId: plainHuman.id, isRoot: false, sessionScopes: ["tasks:read"], stepUp: { tokenId: "probe", method: "password" } }, ACTOR),
  "CEILING_EXCEEDS_CREATOR");
  // B1 live-cap half: a creator whose role-derived scopes fall below the
  // scope ceiling auto-suspends the warrant at mint.
  const viewer = (await principalService.createPrincipal({ handle: tag + "-viewer", kind: "human", role: "viewer" }))!;
  const scopeCapWarrant = await warrantService.create({
    name: "b1cap " + tag, holderPrincipalId: connectorId,
    anchors: [{ anchorType: "task", anchorId: taskL }],
    ceilingRules: [{ resourceType: "task", selectorForm: "all-of-type", selectorIds: [], verbs: ["read", "write"] }],
    ceilingScopes: ["tasks:read", "tasks:write"],
  } as any, rootCreator, ACTOR);
  await pool.query("UPDATE warrants SET created_by_principal_id = $2 WHERE id = $1", [scopeCapWarrant.id, viewer.id]);
  out.b1ScopeNarrowedCreatorSuspends = await code(warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: connEff, targetTaskId: taskL,
    warrantId: scopeCapWarrant.id, authority: { scopes: ["tasks:read"], rules: [] },
  }, ACTOR), "WARRANT_SUSPENDED");
  out.b1ScopeSuspensionPersisted = (await warrantService.get(scopeCapWarrant.id)).status === "suspended";

  // B2: an own()-scope narrowing between request and decision refuses AT
  // DECISION TIME (the current-effective evaluator), leaving it pending.
  const taskK = await mkTask("s4 K " + tag);
  const narrowTimingReq = await approvalService.request({
    requesterPrincipalId: connectorId, requestingCredentialId: successorCredId,
    targetTaskId: taskK, requestedScopes: ["tasks:read", "tasks:write"],
  }, ACTOR);
  await pool.query("UPDATE principals SET own_expression = $2::jsonb WHERE id = $1",
    [connectorId, JSON.stringify({ scopes: ["tasks:read"], objects: "parent" })]);
  out.b2DecideAfterNarrowRefuses = await code(approvalService.decide({
    approvalId: narrowTimingReq.id, decision: "approve",
    deciderPrincipalId: admin.id, stepUp: { tokenId: "probe", method: "password" },
  }, ACTOR), "MINT_EXCEEDS_REQUESTER");
  out.b2RefusalKeepsPending = (await approvalService.get(narrowTimingReq.id)).status === "pending";
  await pool.query("UPDATE principals SET own_expression = $2::jsonb WHERE id = $1",
    [connectorId, JSON.stringify({ scopes: "parent", objects: "parent" })]);

  // ── sweeps + one-way triggers ────────────────────────────────────────
  await pool.query("UPDATE tasks SET status = 'completed' WHERE id = $1", [taskI]);
  const sweep = await warrantService.sweepLifecycles(ACTOR);
  out.sweepExpiresAnchorTerminal = sweep.expired >= 1
    && (await warrantService.get(narrowWarrant.id)).status === "expired";
  out.expiryOneWayTriggerHolds = await pool.query(
    "UPDATE warrants SET status = 'active' WHERE id = $1", [narrowWarrant.id])
    .then(() => false, (e) => /one-way/.test(String(e.message)));
  const staleReq = await approvalService.request({
    requesterPrincipalId: connectorId, requestingCredentialId: successorCredId,
    targetTaskId: taskE, requestedScopes: ["tasks:read"],
  }, ACTOR);
  await pool.query("UPDATE approvals SET pending_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [staleReq.id]);
  await approvalService.sweepTtls(ACTOR);
  out.sweepLapsesPendingTtl = (await approvalService.get(staleReq.id)).status === "lapsed";
  out.approvalOneWayTriggerHolds = await pool.query(
    "UPDATE approvals SET status = 'pending' WHERE id = $1", [staleReq.id])
    .then(() => false, (e) => /single-use/.test(String(e.message)));
  out.eventLedgerAppendOnly = await pool.query(
    "DELETE FROM warrant_events WHERE warrant_id = $1", [narrowWarrant.id])
    .then(() => false, (e) => /append-only/.test(String(e.message)));

  // ── T2 object half: rules beyond the Account's sources refuse ────────
  const narrowConnSvc = await serviceRegistry.register({ slug: tag + "-nc", name: "S4 narrow conn", kind: "connector" }, svcAccount.id);
  const narrowConnId = String((await pool.query("SELECT principal_id FROM services WHERE id = $1", [(narrowConnSvc as any).id])).rows[0].principal_id);
  await pool.query("UPDATE principals SET own_expression = $2::jsonb WHERE id = $1",
    [narrowConnId, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  const narrowCred = await principalService.issueCredential({ principalId: narrowConnId, scopes: ["tasks:read"] }, ACTOR);
  const taskJ = await mkTask("s4 J " + tag);
  out.t2ObjectRulesBeyondAccountRefused = await code(approvalService.request({
    requesterPrincipalId: narrowConnId, requestingCredentialId: narrowCred.credentialId,
    targetTaskId: taskJ, requestedScopes: ["tasks:read"],
    requestedRules: [{ resourceType: "task", selectorForm: "all-of-type", selectorIds: [], verbs: ["admin"] }],
  }, ACTOR).then((approval) => approvalService.decide({
    approvalId: approval.id, decision: "approve",
    deciderPrincipalId: admin.id, stepUp: { tokenId: "probe", method: "password" },
  }, ACTOR)), "MINT_EXCEEDS_REQUESTER");

  console.log(JSON.stringify(out, null, 1));
  const failures = Object.entries(out).filter(([, v]) => typeof v === "boolean" && !v);
  await pool.end();
  if (failures.length > 0) {
    console.error("FAILED:", failures.map(([k]) => k).join(", "));
    process.exit(1);
  }
  console.log("S4 LIVE: " + Object.keys(out).length + "/" + Object.keys(out).length + " checks pass");
}

main().catch(err => { console.error(err); process.exit(1); });
`;

const fs = require("fs");
const tmp = path.join(__dirname, ".s4-warrants-probe.ts");
fs.writeFileSync(tmp, probe);
// node + tsx's cli entry rather than the .bin shim: the shim is a shell
// script and does not spawn on a Windows dev host.
const result = spawnSync(process.execPath, [path.join(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs"), tmp], {
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
