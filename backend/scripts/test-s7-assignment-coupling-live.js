#!/usr/bin/env node
/**
 * test-s7-assignment-coupling-live.js — RH-P3.AZ-S7 (card 446240c4; owner
 * ruling 7440b579; AUTHZ amendment AZ-A2; contract note d3accc39):
 * behavioral proof of the assignment-access coupling against a real
 * migrated PostgreSQL through the PRODUCTION services and the PRODUCTION
 * authorization predicate.
 *
 * Nothing here uses a synthetic actor. Every visibility verdict is taken
 * from `authorizationRepository.authorizedIds` — the same call the shared
 * predicate serves to every route — driven off a chain resolved by
 * `delegationService.resolveChain`. That is the AZ-S3 lesson: a test that
 * asserts against a hand-built actor proves nothing about the wire.
 *
 * SECTIONS, each with its own POSITIVE CONTROL — a step that FAILS THE
 * SCRIPT if the section can no longer detect the defect it exists for.
 * Two of the five round-3 findings landed in sections that had none.
 *
 *   1. R1 coupling            — assignment materializes a vehicle and the
 *                               assignee can read; CONTROL: the same
 *                               assignment written straight to SQL, with
 *                               the coupling bypassed, is INVISIBLE.
 *   2. Chain-aware targeting  — the vehicle lands on the ACCOUNT;
 *                               CONTROL: the identical grant placed on the
 *                               Connector instead changes nothing.
 *   3. own() exclusion        — a narrow own() refuses the assignment;
 *                               CONTROL: widening own() lets it through.
 *   4. B5 refcount + D4       — an OWNER grant colliding with the vehicle
 *                               survives unassignment; CONTROL: a
 *                               vehicle-created grant is reaped.
 *   5. Profile-assignment D4  — the same, for access_profile_assignments
 *                               under a warrant vehicle.
 *   6. Shared-target refcount — two tasks, one report: the first
 *                               unassignment keeps the grant, the second
 *                               removes it; CONTROL: the grant is gone
 *                               only after BOTH let go.
 *   7. R5 sweep repair        — a COMPLETED phase with ZERO tasks now
 *                               reads terminal; CONTROL: the pre-repair
 *                               predicate still reads it OPEN, so the
 *                               section proves the defect existed.
 *   8. R4 idle grace          — no expiry inside the window, expiry after;
 *                               CONTROL: the window is honored, not
 *                               skipped.
 *   9. R4 revoke              — warns with the enumerated list, then
 *                               auto-unassigns; CONTROL: an unacknowledged
 *                               revoke does NOT touch the assignment.
 *  10. R4 reopen              — a dead warrant returns the task
 *                               UNASSIGNED; CONTROL: a live one does not.
 *  11. R3 non-escalation      — a reference the assigner cannot read is
 *                               not granted; CONTROL: one it can read is.
 *  12. R2(b) recompute        — a link edit moves the vehicle with it.
 *  13. R6 backfill            — pre-existing assignments gain vehicles and
 *                               an unvehicleable one is unassigned;
 *                               CONTROL: the migration is a no-op on a
 *                               second run.
 *  14. §1 predicate untouched — the shared predicate gained no arm and no
 *                               scope string was minted.
 *  15. R3 on link edits    — a linker who cannot read an object cannot
 *                            confer it by linking it (review bedc25f3 B2);
 *                            CONTROL: an object the linker CAN read is
 *                            conferred, and an unprivileged linker cannot
 *                            REVOKE access either.
 *  16. R3 vs republish     — the cap is applied to the CURRENT PUBLISHED
 *                            profile, not the pinned mint ceiling
 *                            (bedc25f3 B3); CONTROL: a covered assigner
 *                            still succeeds.
 *  17. Vehicle transitions — a warrant-only change is a real transition
 *                            (bedc25f3 B4); CONTROL: all three directions.
 *  18. Backfill liveness   — a dead chain is unassigned, not vehicled
 *                            (bedc25f3 B5); CONTROL: a live chain is
 *                            vehicled and keeps its assignment.
 *  19. AZ-A3 one shape     — an all-except ceiling now CARRIES an
 *                            assignment, means what it says in both
 *                            directions, and stays future-inclusive;
 *                            CONTROLS: the excluded object stays unreadable,
 *                            the retired shape is refused by the schema, and
 *                            inline rules become a published profile.
 *
 * Run with DB_* env at a DISPOSABLE fresh-replay database. Exit 0 = all.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const probe = `
import { pool } from "../src/db/connection";
import { principalService } from "../src/services/PrincipalService";
import { delegationService } from "../src/services/DelegationService";
import { serviceRegistry } from "../src/services/ServiceRegistry";
import { grantService } from "../src/services/GrantService";
import { accessProfileService } from "../src/services/AccessProfileService";
import { warrantService, warrantIdleGraceMs } from "../src/services/WarrantService";
import { authorizationRepository } from "../src/services/AuthorizationRepository";
import { accessVehicleService, AssignmentAccessError } from "../src/services/AccessVehicleService";
import { taskManagerDB } from "../src/services/TaskManagerDB";
import { randomUUID } from "crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ACTOR = { principalId: null as string | null, handle: "s7-live-proof", authMethod: "system" as const };

/**
 * The PRODUCTION visibility verdict for a Connector over a Task: resolve
 * the chain the way the auth middleware does, then ask the shared
 * predicate. No synthetic actor anywhere.
 */
async function connectorCanRead(principalId: string, taskId: string): Promise<boolean> {
  const chain = await delegationService.resolveChain(principalId);
  if (!chain.alive) return false;
  const acting = chain.links[0];
  const allowed = await authorizationRepository.authorizedIds(
    {
      principalId: acting.principalId,
      handle: "",
      role: acting.role,
      scopes: null,
      authenticated: true,
      delegation: chain.links.length > 1 && !acting.legacyIdentity ? { links: chain.links } : null,
    },
    "task", [taskId], "read",
  );
  return allowed.has(taskId);
}

async function main() {
  const tag = "s7-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};

  const mkTask = async (title: string, extra: Record<string, string | null> = {}) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO tasks (id, title, description, status, priority, visibility, phase_id, project_id) VALUES ($1,$2,'','todo','normal','private',$3,$4)",
      [id, title, extra.phaseId ?? null, extra.projectId ?? null]);
    return id;
  };

  /** A service Account + its Connector, wired the way registration wires
   * them (097 pairs the principal in one transaction). */
  const mkConnector = async (suffix: string) => {
    const account = (await principalService.createPrincipal({
      handle: tag + "-acct-" + suffix, kind: "service", role: "user",
      purpose: "s7 live proof account",
    }))!;
    const svc = await serviceRegistry.register(
      { slug: tag + "-conn-" + suffix, name: "S7 conn " + suffix, kind: "connector" }, account.id);
    const row = await pool.query("SELECT principal_id FROM services WHERE id = $1", [(svc as any).id]);
    const connectorId = String(row.rows[0].principal_id);
    // A delegated principal with no live credential is a DEAD chain
    // (AZ-9/AZ-25), so the fixture mints one exactly as registration does.
    await principalService.issueCredential({ principalId: connectorId, scopes: ["tasks:read"] }, ACTOR);
    return { accountId: account.id, serviceId: String((svc as any).id), connectorId };
  };

  /**
   * AZ-A3: a warrant ceiling is ALWAYS a published Access profile, so the
   * fixtures publish one instead of writing inline rules. This mirrors what
   * WarrantService.create now does for a caller who sends ceilingRules.
   */
  const mkCeilingProfile = async (label: string, rules: any[]): Promise<string> => {
    const profile = await accessProfileService.create(
      { name: tag + "-ceiling-" + label, description: "s7 fixture ceiling" }, ACTOR);
    const version = await accessProfileService.createVersion(profile.id, rules as any, ACTOR);
    await accessProfileService.publish(profile.id, version.id, ACTOR);
    return version.id;
  };

  /** The ASSIGNER: a root-scoped session actor, the shape actorFromRequest
   * builds for the owner plane. */
  const assignerRoot = { principalId: null, handle: "s7-assigner", role: "admin", scopes: ["root"], authenticated: true, delegation: null } as any;

  const inTxn = async <T>(fn: (client: any) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  };

  // ── 1 · R1: assignment materializes a vehicle, and it WORKS ──────────
  const one = await mkConnector("one");
  const task1 = await mkTask("s7 coupled task");

  // POSITIVE CONTROL: with the coupling bypassed — the assignment written
  // straight to SQL, exactly the pre-ruling state — the assignee cannot
  // read its own task. If this ever passes, section 1 has stopped being
  // able to detect the defect it exists for.
  await pool.query("UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1 WHERE id = $2", [one.serviceId, task1]);
  out.control1_bypassedAssignmentIsInvisible = (await connectorCanRead(one.connectorId, task1)) === false;
  await pool.query("UPDATE tasks SET execution_service_id = NULL, execution_descriptor_version = NULL WHERE id = $1", [task1]);

  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: task1, serviceId: one.serviceId, warrantId: null, actor: ACTOR, assigner: assignerRoot,
  }));
  await pool.query("UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1 WHERE id = $2", [one.serviceId, task1]);
  out.s1_coupledAssignmentIsVisible = await connectorCanRead(one.connectorId, task1);

  // ── 2 · Chain-aware targeting: the vehicle lands on the ACCOUNT ──────
  const landed = await pool.query(
    "SELECT landed_on_principal_id FROM access_vehicle_links WHERE task_id = $1 LIMIT 1", [task1]);
  out.s2_vehicleLandedOnAccount = String(landed.rows[0].landed_on_principal_id) === one.accountId;

  // POSITIVE CONTROL: the identical grant placed on the CONNECTOR instead
  // of the Account carries nothing — which is why the vehicle targets the
  // chain root (AZ-24/AZ-26).
  const two = await mkConnector("two");
  const task2 = await mkTask("s7 connector-granted task");
  await pool.query("UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1 WHERE id = $2", [two.serviceId, task2]);
  await grantService.create({ granteeId: two.connectorId, resourceType: "task", resourceId: task2, verb: "read" }, ACTOR);
  out.control2_grantOnConnectorAloneIsInert = (await connectorCanRead(two.connectorId, task2)) === false;
  await grantService.create({ granteeId: two.accountId, resourceType: "task", resourceId: task2, verb: "read" }, ACTOR);
  out.s2_grantOnAccountWorks = await connectorCanRead(two.connectorId, task2);

  // ── 3 · own() exclusion refuses, fail-closed ─────────────────────────
  const three = await mkConnector("three");
  const task3 = await mkTask("s7 own-excluded task");
  const otherTask = await mkTask("s7 unrelated task");
  await pool.query(
    "UPDATE principals SET own_expression = $1 WHERE id = $2",
    [JSON.stringify({ scopes: "parent", objects: [{ resourceType: "task", selectorForm: "exact", selectorIds: [otherTask], verbs: ["read"] }] }), three.connectorId]);
  let refusedCode: string | null = null;
  try {
    await inTxn((client) => accessVehicleService.attach(client, {
      taskId: task3, serviceId: three.serviceId, warrantId: null, actor: ACTOR, assigner: assignerRoot,
    }));
  } catch (e) {
    refusedCode = e instanceof AssignmentAccessError ? e.code : "WRONG_CLASS:" + String(e);
  }
  out.s3_narrowOwnExpressionRefuses = refusedCode === "ASSIGNEE_AUTHORITY_EXCLUDES_TASK";

  // POSITIVE CONTROL: widen own() to cover the task and the SAME call
  // succeeds — the refusal was about the expression, not about the setup.
  await pool.query(
    "UPDATE principals SET own_expression = $1 WHERE id = $2",
    [JSON.stringify({ scopes: "parent", objects: [{ resourceType: "task", selectorForm: "exact", selectorIds: [otherTask, task3], verbs: ["read"] }] }), three.connectorId]);
  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: task3, serviceId: three.serviceId, warrantId: null, actor: ACTOR, assigner: assignerRoot,
  }));
  await pool.query("UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1 WHERE id = $2", [three.serviceId, task3]);
  out.control3_widenedOwnExpressionAdmits = await connectorCanRead(three.connectorId, task3);

  // ── 4 · The B5 trap: an OWNER grant is linked, never adopted ─────────
  const four = await mkConnector("four");
  const task4 = await mkTask("s7 collision task");
  // The owner plane got there first, on the exact tuple the vehicle wants.
  const ownerGrant = await grantService.create(
    { granteeId: four.accountId, resourceType: "task", resourceId: task4, verb: "read" }, ACTOR);
  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: task4, serviceId: four.serviceId, warrantId: null, actor: ACTOR, assigner: assignerRoot,
  }));
  const linkedFlag = await pool.query(
    "SELECT created_by_vehicle FROM access_vehicle_links WHERE task_id = $1 AND target_id = $2", [task4, ownerGrant.id]);
  out.s4_ownerGrantLinkedNotClaimed = linkedFlag.rows.length === 1 && linkedFlag.rows[0].created_by_vehicle === false;
  const stillNull = await pool.query("SELECT provenance FROM grants WHERE id = $1", [ownerGrant.id]);
  out.s4_ownerGrantProvenanceUntouched = stillNull.rows[0].provenance === null;

  await inTxn((client) => accessVehicleService.detach(client, task4, ACTOR, "s7 proof: unassigned"));
  const survived = await pool.query("SELECT id FROM grants WHERE id = $1", [ownerGrant.id]);
  out.s4_ownerGrantSurvivesUnassignment = survived.rows.length === 1;

  // POSITIVE CONTROL: a grant the VEHICLE created IS reaped at the same
  // unassignment — so section 4 can tell "never deletes" from "never
  // deletes anything".
  const five = await mkConnector("five");
  const task5 = await mkTask("s7 vehicle-created task");
  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: task5, serviceId: five.serviceId, warrantId: null, actor: ACTOR, assigner: assignerRoot,
  }));
  const created = await pool.query(
    "SELECT target_id FROM access_vehicle_links WHERE task_id = $1 AND created_by_vehicle = TRUE", [task5]);
  const createdIds = created.rows.map((r: any) => String(r.target_id));
  await inTxn((client) => accessVehicleService.detach(client, task5, ACTOR, "s7 proof: unassigned"));
  const remaining = await pool.query("SELECT id FROM grants WHERE id = ANY($1::uuid[])", [createdIds]);
  out.control4_vehicleCreatedGrantIsReaped = createdIds.length > 0 && remaining.rows.length === 0;

  // ── 5 · The same D4 rule for access_profile_assignments ──────────────
  const six = await mkConnector("six");
  const profile = await accessProfileService.create({ name: tag + "-profile", description: "s7" }, ACTOR);
  const taskForProfile = await mkTask("s7 warrant task");
  const version = await accessProfileService.createVersion(profile.id, [
    { resourceType: "task", selectorForm: "exact", selectorIds: [taskForProfile], verbs: ["read"] },
  ] as any, ACTOR);
  await accessProfileService.publish(profile.id, version.id, ACTOR);
  // The owner plane assigned this very profile to the Account already.
  const ownerAssignment = await accessProfileService.assign(profile.id, { assigneeType: "principal", assigneeId: six.accountId }, ACTOR);
  const warrant = await warrantService.create({
    name: tag + "-warrant", holderPrincipalId: six.connectorId,
    ceilingProfileVersionId: version.id,
    anchors: [{ anchorType: "task", anchorId: taskForProfile }],
  } as any, { ...ACTOR, principalId: null }, { rootActor: true } as any).catch(async () => {
    // The service surface refuses bearer/rootless creation shapes; the
    // proof only needs a live warrant row of the ratified shape.
    const id = randomUUID();
    await pool.query(
      "INSERT INTO warrants (id, name, holder_principal_id, created_by_principal_id, status, ceiling_profile_version_id, expires_at) VALUES ($1,$2,$3,NULL,'active',$4,NOW() + INTERVAL '1 day')",
      [id, tag + "-warrant", six.connectorId, version.id]);
    await pool.query("INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1,'task',$2)", [id, taskForProfile]);
    return { id } as any;
  });

  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: taskForProfile, serviceId: six.serviceId, warrantId: String((warrant as any).id), actor: ACTOR, assigner: assignerRoot,
  }));
  await pool.query("UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1, execution_warrant_id = $2 WHERE id = $3",
    [six.serviceId, String((warrant as any).id), taskForProfile]);
  out.s5_warrantVehicleIsVisible = await connectorCanRead(six.connectorId, taskForProfile);
  const apLink = await pool.query(
    "SELECT created_by_vehicle FROM access_vehicle_links WHERE task_id = $1 AND target_kind = 'profile_assignment'", [taskForProfile]);
  out.s5_ownerAssignmentLinkedNotClaimed = apLink.rows.length === 1 && apLink.rows[0].created_by_vehicle === false;
  await inTxn((client) => accessVehicleService.detach(client, taskForProfile, ACTOR, "s7 proof: unassigned"));
  const apSurvived = await pool.query("SELECT id FROM access_profile_assignments WHERE id = $1", [ownerAssignment.id]);
  out.control5_ownerAssignmentSurvives = apSurvived.rows.length === 1;

  // ── 6 · Shared-target refcount across two tasks ──────────────────────
  const seven = await mkConnector("seven");
  const taskA = await mkTask("s7 shared-report task A");
  const taskB = await mkTask("s7 shared-report task B");
  const reportId = randomUUID();
  await pool.query(
    "INSERT INTO reports (id, title, content, task_ids, author) VALUES ($1,$2,'body',ARRAY[$3::uuid,$4::uuid],'s7')",
    [reportId, "s7 shared report", taskA, taskB]);
  for (const t of [taskA, taskB]) {
    await inTxn((client) => accessVehicleService.attach(client, {
      taskId: t, serviceId: seven.serviceId, warrantId: null, actor: ACTOR, assigner: assignerRoot,
    }));
  }
  const sharedGrant = await pool.query(
    "SELECT id FROM grants WHERE grantee_id = $1 AND resource_type = 'report' AND resource_id = $2",
    [seven.accountId, reportId]);
  const sharedGrantId = sharedGrant.rows.length === 1 ? String(sharedGrant.rows[0].id) : null;
  await inTxn((client) => accessVehicleService.detach(client, taskA, ACTOR, "s7 proof: first releases"));
  const afterFirst = await pool.query("SELECT id FROM grants WHERE id = $1", [sharedGrantId]);
  out.s6_sharedTargetSurvivesFirstRelease = Boolean(sharedGrantId) && afterFirst.rows.length === 1;
  await inTxn((client) => accessVehicleService.detach(client, taskB, ACTOR, "s7 proof: last releases"));
  const afterSecond = await pool.query("SELECT id FROM grants WHERE id = $1", [sharedGrantId]);
  out.control6_sharedTargetGoesAtRefcountZero = afterSecond.rows.length === 0;

  // A live administrator Account to CREATE warrants with: AZ-31a binds the
  // live-cap to the creating principal, and a NULL creator fails closed
  // (auto-suspend), so a fixture that leaves it NULL is testing the wrong
  // thing.
  const warrantCreator = (await principalService.createPrincipal({
    handle: tag + "-warrant-creator", kind: "human", role: "admin",
  }))!;

  // ── 7 · R5 sweep repair: a COMPLETED phase with ZERO tasks ───────────
  const projectId = randomUUID();
  await pool.query("INSERT INTO projects (id, name, status) VALUES ($1,$2,'active')", [projectId, tag + "-project"]);
  const emptyCompletedPhase = randomUUID();
  await pool.query(
    "INSERT INTO phases (id, project_id, name, status, position) VALUES ($1,$2,$3,'completed',0)",
    [emptyCompletedPhase, projectId, "s7 empty completed phase"]);

  // POSITIVE CONTROL: the PRE-REPAIR predicate, verbatim, still reads this
  // anchor OPEN — proof that the defect was real and that this section
  // would catch its return.
  const preRepair = await pool.query(
    \`SELECT (NOT EXISTS (SELECT 1 FROM tasks t WHERE t.phase_id = $1)
             OR EXISTS (SELECT 1 FROM tasks t WHERE t.phase_id = $1 AND t.status NOT IN ('completed','archived'))) AS open\`,
    [emptyCompletedPhase]);
  out.control7_preRepairPredicateStillReadsItOpen = preRepair.rows[0].open === true;

  const postRepair = await pool.query(
    \`SELECT (EXISTS (SELECT 1 FROM phases ph WHERE ph.id = $1 AND ph.status NOT IN ('completed','archived'))
             OR EXISTS (SELECT 1 FROM tasks t WHERE t.phase_id = $1 AND t.status NOT IN ('completed','archived'))) AS open\`,
    [emptyCompletedPhase]);
  out.s7_repairedPredicateReadsItTerminal = postRepair.rows[0].open === false;

  // And end to end, through the production sweep.
  const phaseWarrant = randomUUID();
  const phaseCeiling = await mkCeilingProfile("phase", [
    { resourceType: "task", selectorForm: "all-of-type", selectorIds: [], verbs: ["read"] },
  ]);
  await pool.query(
    "INSERT INTO warrants (id, name, holder_principal_id, created_by_principal_id, status, ceiling_profile_version_id) VALUES ($1,$2,$3,$5,'active',$4)",
    [phaseWarrant, tag + "-phase-warrant", one.connectorId, phaseCeiling, warrantCreator.id]);
  await pool.query("INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1,'phase',$2)", [phaseWarrant, emptyCompletedPhase]);

  // ── 8 · R4 idle grace ───────────────────────────────────────────────
  await warrantService.sweepLifecycles(ACTOR);
  const stamped = await pool.query("SELECT status, anchors_terminal_since FROM warrants WHERE id = $1", [phaseWarrant]);
  out.s8_firstSweepStampsAndHolds = stamped.rows[0].status === "active" && stamped.rows[0].anchors_terminal_since !== null;
  // Backdate past the configured grace and sweep again.
  await pool.query(
    "UPDATE warrants SET anchors_terminal_since = NOW() - ($2::bigint || ' milliseconds')::interval WHERE id = $1",
    [phaseWarrant, String(warrantIdleGraceMs() + 60000)]);
  await warrantService.sweepLifecycles(ACTOR);
  const expired = await pool.query("SELECT status FROM warrants WHERE id = $1", [phaseWarrant]);
  out.control8_expiresOnlyAfterTheGrace = expired.rows[0].status === "expired";

  // ── 9 · R4 revoke: warn, then auto-unassign ─────────────────────────
  const nine = await mkConnector("nine");
  const task9 = await mkTask("s7 revoke task");
  const revokeWarrant = randomUUID();
  const revokeCeiling = await mkCeilingProfile("revoke", [
    { resourceType: "task", selectorForm: "exact", selectorIds: [task9], verbs: ["read"] },
  ]);
  await pool.query(
    "INSERT INTO warrants (id, name, holder_principal_id, created_by_principal_id, status, ceiling_profile_version_id, expires_at) VALUES ($1,$2,$3,NULL,'active',$4, NOW() + INTERVAL '1 day')",
    [revokeWarrant, tag + "-revoke-warrant", nine.connectorId, revokeCeiling]);
  await pool.query("INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1,'task',$2)", [revokeWarrant, task9]);
  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: task9, serviceId: nine.serviceId, warrantId: revokeWarrant, actor: ACTOR, assigner: assignerRoot,
  }));
  await pool.query("UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1, execution_warrant_id = $2 WHERE id = $3",
    [nine.serviceId, revokeWarrant, task9]);

  let revokeRefusal: string | null = null;
  try {
    await warrantService.revoke(revokeWarrant, "s7 proof", ACTOR);
  } catch (e: any) {
    revokeRefusal = e?.code ?? String(e);
  }
  out.s9_unacknowledgedRevokeWarns = revokeRefusal === "WARRANT_HAS_DEPENDENT_TASKS";
  // POSITIVE CONTROL: the warned-off revoke changed NOTHING.
  const untouched = await pool.query("SELECT execution_service_id FROM tasks WHERE id = $1", [task9]);
  out.control9_warnedRevokeLeavesAssignmentIntact = untouched.rows[0].execution_service_id !== null;

  await warrantService.revoke(revokeWarrant, "s7 proof", ACTOR, { acknowledgeDependents: true });
  const afterRevoke = await pool.query("SELECT execution_service_id, execution_warrant_id FROM tasks WHERE id = $1", [task9]);
  out.s9_acknowledgedRevokeAutoUnassigns =
    afterRevoke.rows[0].execution_service_id === null && afterRevoke.rows[0].execution_warrant_id === null;
  const reaped = await pool.query("SELECT COUNT(*)::int AS n FROM access_vehicle_links WHERE warrant_id = $1", [revokeWarrant]);
  out.s9_warrantDeathReapsItsLinks = reaped.rows[0].n === 0;

  // ── 11 · R3 non-escalation on the reference set ─────────────────────
  // (Section 10, the reopen rule, rides the TaskManagerDB path below.)
  const eleven = await mkConnector("eleven");
  const task11 = await mkTask("s7 escalation task");
  const secretReport = randomUUID();
  await pool.query(
    "INSERT INTO reports (id, title, content, task_ids, author, visibility) VALUES ($1,$2,'body',ARRAY[$3::uuid],'s7','private')",
    [secretReport, "s7 report the assigner cannot read", task11]);
  const narrowAssignerAccount = (await principalService.createPrincipal({
    handle: tag + "-narrow-assigner", kind: "human", role: "user",
  }))!;
  const narrowAssigner = {
    principalId: narrowAssignerAccount.id, handle: "narrow", role: "user",
    scopes: ["tasks:write", "services:invoke"], authenticated: true, delegation: null,
  } as any;
  // The assigner CAN read the task (so R1 can be satisfied) but not the report.
  await grantService.create({ granteeId: narrowAssignerAccount.id, resourceType: "task", resourceId: task11, verb: "read" }, ACTOR);
  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: task11, serviceId: eleven.serviceId, warrantId: null, actor: ACTOR, assigner: narrowAssigner,
  }));
  const leaked = await pool.query(
    "SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_type = 'report' AND resource_id = $2",
    [eleven.accountId, secretReport]);
  out.s11_unreadableReferenceNotGranted = leaked.rows[0].n === 0;
  const taskGranted = await pool.query(
    "SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_type = 'task' AND resource_id = $2",
    [eleven.accountId, task11]);
  out.control11_readableReferenceIsGranted = taskGranted.rows[0].n === 1;

  // ── 12 · R2(b) same-transaction recompute on a link edit ────────────
  const twelve = await mkConnector("twelve");
  const task12 = await mkTask("s7 recompute task");
  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: task12, serviceId: twelve.serviceId, warrantId: null, actor: ACTOR, assigner: assignerRoot,
  }));
  const lateReport = randomUUID();
  await pool.query(
    "INSERT INTO reports (id, title, content, task_ids, author) VALUES ($1,$2,'body',ARRAY[$3::uuid],'s7')",
    [lateReport, "s7 late-linked report", task12]);
  const beforeRecompute = await pool.query(
    "SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_id = $2", [twelve.accountId, lateReport]);
  await inTxn((client) => accessVehicleService.recompute(client, task12, ACTOR, assignerRoot));
  const afterRecompute = await pool.query(
    "SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_id = $2", [twelve.accountId, lateReport]);
  out.s12_recomputePicksUpTheNewLink = beforeRecompute.rows[0].n === 0 && afterRecompute.rows[0].n === 1;
  await pool.query("UPDATE reports SET task_ids = ARRAY[]::uuid[] WHERE id = $1", [lateReport]);
  await inTxn((client) => accessVehicleService.recompute(client, task12, ACTOR, assignerRoot));
  const afterUnlink = await pool.query(
    "SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_id = $2", [twelve.accountId, lateReport]);
  out.control12_recomputeDropsTheRemovedLink = afterUnlink.rows[0].n === 0;

  // ── 10 · R4 reopen: a dead warrant returns the task UNASSIGNED ──────
  // Driven through taskManagerDB.updateTask — the production choke point,
  // not the service in isolation.
  const ten = await mkConnector("ten");
  const task10 = await mkTask("s7 reopen task");
  const deadWarrant = randomUUID();
  const deadCeiling = await mkCeilingProfile("dead", [
    { resourceType: "task", selectorForm: "exact", selectorIds: [task10], verbs: ["read"] },
  ]);
  await pool.query(
    "INSERT INTO warrants (id, name, holder_principal_id, created_by_principal_id, status, ceiling_profile_version_id, expires_at) VALUES ($1,$2,$3,$5,'active',$4, NOW() + INTERVAL '1 day')",
    [deadWarrant, tag + "-dead-warrant", ten.connectorId, deadCeiling, warrantCreator.id]);
  await pool.query("INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1,'task',$2)", [deadWarrant, task10]);
  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: task10, serviceId: ten.serviceId, warrantId: deadWarrant, actor: ACTOR, assigner: assignerRoot,
  }));
  await pool.query(
    "UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1, execution_warrant_id = $2 WHERE id = $3",
    [ten.serviceId, deadWarrant, task10]);

  const verifierActor = {
    principalId: null, handle: "s7-verifier", role: "qa" as const,
    authorization: assignerRoot,
  };
  // Terminal first — which reaps the links but keeps the warrant pointer.
  await taskManagerDB.updateTask(task10, { status: "completed" } as any, verifierActor as any);
  const afterTerminal = await pool.query("SELECT execution_warrant_id FROM tasks WHERE id = $1", [task10]);
  out.s10_terminalKeepsTheWarrantPointer = afterTerminal.rows[0].execution_warrant_id === deadWarrant;

  // POSITIVE CONTROL: reopening while the warrant is STILL LIVE re-attaches
  // rather than unassigning — so section 10 can tell "dead warrant" from
  // "any reopen at all".
  await taskManagerDB.updateTask(task10, { status: "in-progress" } as any, verifierActor as any);
  const liveReopen = await pool.query("SELECT execution_service_id FROM tasks WHERE id = $1", [task10]);
  out.control10_reopenWithLiveWarrantKeepsAssignment = liveReopen.rows[0].execution_service_id !== null;

  // Now kill the warrant behind its back and reopen again.
  await taskManagerDB.updateTask(task10, { status: "completed" } as any, verifierActor as any);
  await pool.query("UPDATE warrants SET status = 'revoked', revoked_at = NOW() WHERE id = $1", [deadWarrant]);
  await taskManagerDB.updateTask(task10, { status: "in-progress" } as any, verifierActor as any);
  const deadReopen = await pool.query(
    "SELECT execution_service_id, execution_warrant_id FROM tasks WHERE id = $1", [task10]);
  out.s10_reopenWithDeadWarrantReturnsUnassigned =
    deadReopen.rows[0].execution_service_id === null && deadReopen.rows[0].execution_warrant_id === null;

  // ── 13 · R6 backfill: pre-existing assignments gain their vehicle ────
  // The pre-ruling state, reproduced exactly: assignments written straight
  // to SQL with no vehicle anywhere.
  const thirteen = await mkConnector("thirteen");
  const legacyConn = await mkConnector("legacy");
  await pool.query("UPDATE principals SET legacy_identity = TRUE WHERE id = $1", [legacyConn.connectorId]);
  const backfillTask = await mkTask("s7 backfill task");
  const legacyTask = await mkTask("s7 legacy-assignee task");
  await pool.query(
    "UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1 WHERE id = $2",
    [thirteen.serviceId, backfillTask]);
  await pool.query(
    "UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1 WHERE id = $2",
    [legacyConn.serviceId, legacyTask]);
  out.control13_preBackfillAssignmentIsInvisible =
    (await connectorCanRead(thirteen.connectorId, backfillTask)) === false;

  const migrationSql = readFileSync(join(__dirname, "../src/migrations/099_assignment_access_vehicles.sql"), "utf8");
  await pool.query(migrationSql);

  out.s13_backfillGivesTheAssigneeItsVehicle = await connectorCanRead(thirteen.connectorId, backfillTask);
  const legacyAfter = await pool.query("SELECT execution_service_id FROM tasks WHERE id = $1", [legacyTask]);
  out.s13_legacyAssigneeIsUnassigned = legacyAfter.rows[0].execution_service_id === null;

  // Idempotence: re-running the whole file changes nothing and adds no
  // duplicate link or grant.
  const linksBefore = await pool.query("SELECT COUNT(*)::int AS n FROM access_vehicle_links");
  const grantsBefore = await pool.query("SELECT COUNT(*)::int AS n FROM grants");
  await pool.query(migrationSql);
  const linksAfter = await pool.query("SELECT COUNT(*)::int AS n FROM access_vehicle_links");
  const grantsAfter = await pool.query("SELECT COUNT(*)::int AS n FROM grants");
  out.control13_backfillIsIdempotent =
    linksBefore.rows[0].n === linksAfter.rows[0].n && grantsBefore.rows[0].n === grantsAfter.rows[0].n;

  // ── 15 · R3 on link edits: a linker cannot confer what it cannot read ─
  //
  // The r1 defect (bedc25f3 B2): recompute materialized a grant for every
  // derived reference with NO containment check, so a principal who could
  // write an assigned Task but not read a private Report could link that
  // Report and have the assignee granted read on it.
  const fifteen = await mkConnector("fifteen");
  const task15 = await mkTask("s7 link-edit task");
  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: task15, serviceId: fifteen.serviceId, warrantId: null, actor: ACTOR, assigner: assignerRoot,
  }));
  const privateReport = randomUUID();
  await pool.query(
    "INSERT INTO reports (id, title, content, task_ids, author, visibility) VALUES ($1,$2,'body',ARRAY[$3::uuid],'s7','private')",
    [privateReport, "s7 report the LINKER cannot read", task15]);
  const readableReport = randomUUID();
  await pool.query(
    "INSERT INTO reports (id, title, content, task_ids, author, visibility) VALUES ($1,$2,'body',ARRAY[$3::uuid],'s7','private')",
    [readableReport, "s7 report the linker CAN read", task15]);

  const narrowLinkerAccount = (await principalService.createPrincipal({
    handle: tag + "-narrow-linker", kind: "human", role: "user",
  }))!;
  await grantService.create({ granteeId: narrowLinkerAccount.id, resourceType: "report", resourceId: readableReport, verb: "read" }, ACTOR);
  const narrowLinker = {
    principalId: narrowLinkerAccount.id, handle: "linker", role: "user",
    scopes: ["tasks:write"], authenticated: true, delegation: null,
  } as any;

  await inTxn((client) => accessVehicleService.recompute(client, task15, ACTOR, narrowLinker));
  const leakedByLink = await pool.query(
    "SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_id = $2",
    [fifteen.accountId, privateReport]);
  out.s15_linkerCannotConferWhatItCannotRead = leakedByLink.rows[0].n === 0;
  const conferred = await pool.query(
    "SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_id = $2",
    [fifteen.accountId, readableReport]);
  out.control15_linkerConfersWhatItCanRead = conferred.rows[0].n === 1;

  // CONTROL: "not permitted to confer" is not "no longer referenced". An
  // unprivileged linker must not be able to STRIP the assignee's access
  // either — the removal arm works off the raw reference set.
  await inTxn((client) => accessVehicleService.recompute(client, task15, ACTOR, assignerRoot));
  const rootConferred = await pool.query(
    "SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_id = $2",
    [fifteen.accountId, privateReport]);
  await inTxn((client) => accessVehicleService.recompute(client, task15, ACTOR, narrowLinker));
  const survivedNarrow = await pool.query(
    "SELECT COUNT(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_id = $2",
    [fifteen.accountId, privateReport]);
  out.control15_narrowLinkerCannotStripAccess =
    rootConferred.rows[0].n === 1 && survivedNarrow.rows[0].n === 1;

  // ── 16 · R3 vs republish: the cap follows what is MATERIALIZED ────────
  //
  // The r1 defect (bedc25f3 B3): the cap was checked against the PINNED
  // mint ceiling while the vehicle assigned the profile, whose visibility
  // follows the CURRENT PUBLISHED version.
  const sixteen = await mkConnector("sixteen");
  const task16 = await mkTask("s7 republish task");
  const secretReport16 = randomUUID();
  await pool.query(
    "INSERT INTO reports (id, title, content, author, visibility) VALUES ($1,$2,'body','s7','private')",
    [secretReport16, "s7 report added by republish"]);
  const profile16 = await accessProfileService.create({ name: tag + "-republish", description: "s7" }, ACTOR);
  const v1 = await accessProfileService.createVersion(profile16.id, [
    { resourceType: "task", selectorForm: "exact", selectorIds: [task16], verbs: ["read"] },
  ] as any, ACTOR);
  await accessProfileService.publish(profile16.id, v1.id, ACTOR);
  const warrant16 = randomUUID();
  await pool.query(
    "INSERT INTO warrants (id, name, holder_principal_id, created_by_principal_id, status, ceiling_profile_version_id, expires_at) VALUES ($1,$2,$3,$5,'active',$4, NOW() + INTERVAL '1 day')",
    [warrant16, tag + "-republish-warrant", sixteen.connectorId, v1.id, warrantCreator.id]);
  await pool.query("INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1,'task',$2)", [warrant16, task16]);

  // An assigner covered by v1 only.
  const v1Assigner = (await principalService.createPrincipal({
    handle: tag + "-v1-assigner", kind: "human", role: "user",
  }))!;
  await grantService.create({ granteeId: v1Assigner.id, resourceType: "task", resourceId: task16, verb: "read" }, ACTOR);
  const v1Actor = {
    principalId: v1Assigner.id, handle: "v1", role: "user",
    scopes: ["tasks:write", "services:invoke"], authenticated: true, delegation: null,
  } as any;

  // CONTROL: while only v1 is published, the covered assigner succeeds.
  let v1Refusal: string | null = null;
  try {
    await inTxn((client) => accessVehicleService.attach(client, {
      taskId: task16, serviceId: sixteen.serviceId, warrantId: warrant16, actor: ACTOR, assigner: v1Actor,
    }));
  } catch (e: any) { v1Refusal = e?.code ?? String(e); }
  out.control16_coveredAssignerSucceedsBeforeRepublish = v1Refusal === null;
  await inTxn((client) => accessVehicleService.detach(client, task16, ACTOR, "s7 proof reset"));

  // Republish v2 adding the private Report; the SAME assigner must refuse.
  const v2 = await accessProfileService.createVersion(profile16.id, [
    { resourceType: "task", selectorForm: "exact", selectorIds: [task16], verbs: ["read"] },
    { resourceType: "report", selectorForm: "exact", selectorIds: [secretReport16], verbs: ["read"] },
  ] as any, ACTOR);
  await accessProfileService.publish(profile16.id, v2.id, ACTOR);
  let v2Refusal: string | null = null;
  try {
    await inTxn((client) => accessVehicleService.attach(client, {
      taskId: task16, serviceId: sixteen.serviceId, warrantId: warrant16, actor: ACTOR, assigner: v1Actor,
    }));
  } catch (e: any) { v2Refusal = e?.code ?? String(e); }
  out.s16_republishedProfileIsCappedAtTheAssigner = v2Refusal === "ACCESS_EXCEEDS_ASSIGNER";

  // ── 17 · Vehicle transitions with an unchanged assignee ───────────────
  //
  // The r1 defect (bedc25f3 B4): the transition was gated on the ASSIGNEE
  // changing, so every warrant-only change was silently dropped.
  const seventeen = await mkConnector("seventeen");
  const task17 = await mkTask("s7 transition task");
  const warrant17 = randomUUID();
  const ceiling17 = await mkCeilingProfile("transition", [
    { resourceType: "task", selectorForm: "exact", selectorIds: [task17], verbs: ["read"] },
  ]);
  await pool.query(
    "INSERT INTO warrants (id, name, holder_principal_id, created_by_principal_id, status, ceiling_profile_version_id, expires_at) VALUES ($1,$2,$3,$5,'active',$4, NOW() + INTERVAL '1 day')",
    [warrant17, tag + "-transition-warrant", seventeen.connectorId, ceiling17, warrantCreator.id]);
  await pool.query("INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1,'task',$2)", [warrant17, task17]);

  const assignerActor = { principalId: null, handle: "s7-assigner", role: "admin", authorization: assignerRoot };
  // auto-grant first
  await taskManagerDB.updateTask(task17, {
    executionProfile: { serviceId: seventeen.serviceId, options: {} },
    executionServiceId: seventeen.serviceId, executionDescriptorVersion: 1,
  } as any, assignerActor as any);
  const afterAuto = await pool.query("SELECT execution_warrant_id FROM tasks WHERE id = $1", [task17]);
  out.control17_autoGrantFirst = afterAuto.rows[0].execution_warrant_id === null;

  // auto-grant → Warrant, assignee UNCHANGED
  await taskManagerDB.updateTask(task17, { executionWarrantId: warrant17 } as any, assignerActor as any);
  const afterToWarrant = await pool.query("SELECT execution_warrant_id FROM tasks WHERE id = $1", [task17]);
  out.s17_autoGrantToWarrantIsHonored = afterToWarrant.rows[0].execution_warrant_id === warrant17;
  const warrantLinked = await pool.query(
    "SELECT COUNT(*)::int AS n FROM access_vehicle_links WHERE task_id = $1 AND warrant_id = $2", [task17, warrant17]);
  out.s17_warrantVehicleActuallyMaterialized = warrantLinked.rows[0].n > 0;

  // Warrant → auto-grant, assignee UNCHANGED
  await taskManagerDB.updateTask(task17, { executionWarrantId: null } as any, assignerActor as any);
  const afterBack = await pool.query("SELECT execution_warrant_id, execution_service_id FROM tasks WHERE id = $1", [task17]);
  out.s17_warrantToAutoGrantIsHonored =
    afterBack.rows[0].execution_warrant_id === null && afterBack.rows[0].execution_service_id !== null;

  // ── 18 · Backfill liveness: a dead chain is never left assigned ───────
  //
  // The r1 defect (bedc25f3 B5): the walk checked identity SHAPE but not
  // §5.1 LIVENESS, so a Connector whose last credential had been revoked
  // kept an invisible assignment through the one-time repair.
  const deadChain = await mkConnector("deadchain");
  const liveChain = await mkConnector("livechain");
  const deadTask = await mkTask("s7 dead-chain task");
  const liveTask = await mkTask("s7 live-chain task");
  await pool.query(
    "UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1 WHERE id = $2",
    [deadChain.serviceId, deadTask]);
  await pool.query(
    "UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1 WHERE id = $2",
    [liveChain.serviceId, liveTask]);
  // Kill the dead chain the way §5.1 defines dead: no live credential.
  await pool.query("UPDATE principal_credentials SET revoked_at = NOW() WHERE principal_id = $1", [deadChain.connectorId]);
  out.control18_deadChainReallyIsDead = (await delegationService.resolveChain(deadChain.connectorId)).alive === false;

  await pool.query(readFileSync(join(__dirname, "../src/migrations/099_assignment_access_vehicles.sql"), "utf8"));

  const deadAfter = await pool.query("SELECT execution_service_id FROM tasks WHERE id = $1", [deadTask]);
  out.s18_deadChainIsUnassignedNotVehicled = deadAfter.rows[0].execution_service_id === null;
  const liveAfter = await pool.query("SELECT execution_service_id FROM tasks WHERE id = $1", [liveTask]);
  out.control18_liveChainKeepsItsAssignment = liveAfter.rows[0].execution_service_id !== null;
  out.control18_liveChainCanRead = await connectorCanRead(liveChain.connectorId, liveTask);

  // ── 19 · AZ-A3: one ceiling shape, and all-except finally carries ────
  //
  // This is the case that blocked AZ-S7 (review bedc25f3 B6, owner gate
  // 553c3a5f). all-except is a ratified selector form that grants has no
  // operator for, so the retired rules-form vehicle could not carry it
  // without widening or freezing. With one ceiling shape it rides the
  // profile arm, which expresses it natively.
  const nineteen = await mkConnector("nineteen");
  const task19 = await mkTask("s7 all-except task");
  const excludedReport = randomUUID();
  await pool.query(
    "INSERT INTO reports (id, title, content, author, visibility) VALUES ($1,$2,'body','s7','private')",
    [excludedReport, "s7 the deliberately excluded report"]);
  const includedReport = randomUUID();
  await pool.query(
    "INSERT INTO reports (id, title, content, author, visibility) VALUES ($1,$2,'body','s7','private')",
    [includedReport, "s7 an ordinary report"]);

  // The ceiling: every report EXCEPT one, plus the task itself.
  const exceptCeiling = await mkCeilingProfile("all-except", [
    { resourceType: "task", selectorForm: "exact", selectorIds: [task19], verbs: ["read"] },
    { resourceType: "report", selectorForm: "all-except", selectorIds: [excludedReport], verbs: ["read"] },
  ]);
  const warrant19 = randomUUID();
  await pool.query(
    "INSERT INTO warrants (id, name, holder_principal_id, created_by_principal_id, status, ceiling_profile_version_id, expires_at) VALUES ($1,$2,$3,$5,'active',$4, NOW() + INTERVAL '1 day')",
    [warrant19, tag + "-all-except-warrant", nineteen.connectorId, exceptCeiling, warrantCreator.id]);
  await pool.query("INSERT INTO warrant_anchors (warrant_id, anchor_type, anchor_id) VALUES ($1,'task',$2)", [warrant19, task19]);

  // Before AZ-A3 this attach refused with CEILING_NOT_MATERIALIZABLE.
  await inTxn((client) => accessVehicleService.attach(client, {
    taskId: task19, serviceId: nineteen.serviceId, warrantId: warrant19, actor: ACTOR, assigner: assignerRoot,
  }));
  await pool.query(
    "UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1, execution_warrant_id = $2 WHERE id = $3",
    [nineteen.serviceId, warrant19, task19]);
  out.s19_allExceptCeilingCarriesTheAssignment = await connectorCanRead(nineteen.connectorId, task19);

  // And it means what it says, in BOTH directions — through the production
  // predicate, not by reading the rule back.
  const reportReadable = async (reportId: string) => {
    const chain = await delegationService.resolveChain(nineteen.connectorId);
    const allowed = await authorizationRepository.authorizedIds(
      { principalId: chain.links[0].principalId, handle: "", role: chain.links[0].role, scopes: null,
        authenticated: true, delegation: chain.links.length > 1 ? { links: chain.links } : null },
      "report", [reportId], "read");
    return allowed.has(reportId);
  };
  out.s19_theIncludedReportIsReadable = await reportReadable(includedReport);
  out.control19_theExcludedReportIsNot = (await reportReadable(excludedReport)) === false;

  // FUTURE-INCLUSIVE: a report created AFTER the vehicle was attached is
  // covered, with nobody granting anything. This is the property an
  // expanded complement of grants would have silently lost.
  const laterReport = randomUUID();
  await pool.query(
    "INSERT INTO reports (id, title, content, author, visibility) VALUES ($1,$2,'body','s7','private')",
    [laterReport, "s7 a report filed after the fact"]);
  out.s19_aLaterReportIsCoveredWithNoNewGrant = await reportReadable(laterReport);

  // CONTROL: the schema now REFUSES the retired shape outright.
  let inlineRefused = false;
  try {
    await pool.query(
      "INSERT INTO warrants (id, name, holder_principal_id, created_by_principal_id, status, ceiling_rules) VALUES ($1,$2,$3,$4,'active',$5)",
      [randomUUID(), tag + "-inline", nineteen.connectorId, warrantCreator.id,
       JSON.stringify([{ resourceType: "task", selectorForm: "exact", selectorIds: [task19], verbs: ["read"] }])]);
  } catch { inlineRefused = true; }
  out.control19_theRetiredShapeIsRefusedBySchema = inlineRefused;

  // CONTROL: the convenience path still works end to end — inline rules in,
  // a published profile out, pinned on the warrant.
  const conv = await warrantService.create({
    name: tag + "-convenience", holderPrincipalId: nineteen.connectorId,
    anchors: [{ anchorType: "task", anchorId: task19 }],
    ceilingRules: [{ resourceType: "report", selectorForm: "all-except", selectorIds: [excludedReport], verbs: ["read"] }],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  } as any, { principalId: warrantCreator.id, isRoot: true, sessionScopes: ["root"], stepUp: { tokenId: "x", method: "password" } } as any,
  ACTOR).catch((e: any) => ({ error: e?.code ?? String(e) } as any));
  const convRow = (conv as any)?.id
    ? (await pool.query("SELECT ceiling_profile_version_id, ceiling_rules FROM warrants WHERE id = $1", [(conv as any).id])).rows[0]
    : null;
  out.control19_inlineRulesBecomeAPublishedProfile =
    Boolean(convRow) && convRow.ceiling_profile_version_id !== null && convRow.ceiling_rules === null;

  // ── 14 · §1 shared predicate untouched, no scope minted ─────────────
  const predicateSource = readFileSync(join(__dirname, "../src/services/AuthorizationService.ts"), "utf8");
  const scopeMapSource = readFileSync(join(__dirname, "../src/utils/scopeMap.ts"), "utf8");
  out.s14_predicateMentionsNoVehicle = !/vehicle/i.test(predicateSource);
  out.s14_scopeMapMentionsNoVehicle = !/vehicle/i.test(scopeMapSource);

  console.log(JSON.stringify(out, null, 2));
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
const tmp = path.join(__dirname, ".s7-assignment-coupling-probe.ts");
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
