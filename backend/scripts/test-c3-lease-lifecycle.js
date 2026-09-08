#!/usr/bin/env node
/**
 * test-c3-lease-lifecycle.js — RH-P3.C3 (card c8db4b3d; strategy 4e40f06f
 * §2.6.4; vocabulary b94dd86e §5.3): behavioural proof, on REAL PostgreSQL
 * through the PRODUCTION services, of the four things this candidate owes.
 *
 * Nothing here is a mock. The claim/renew/release calls are
 * `TaskOrchestrationService`; the assignment writes are `taskManagerDB`; the
 * task roles are written by `taskManagerDB.assignTaskRoles` and read back out
 * of the production `task_assignments` row; the finish is
 * `taskElementService.finish`; the visibility verdicts come from
 * `authorizationRepository.authorizedIds` off a chain resolved by
 * `delegationService.resolveChain` — the same call the shared predicate
 * serves every route. Runbook `daf703a6` §2 names mocks-of-the-thing as a
 * standing rejection class, and review r3 on C2 (`840711d1`) is why the bar
 * is "reproduce the defect as the control" rather than "assert the fix".
 *
 * SECTIONS, each with a POSITIVE CONTROL — a step that FAILS THE SCRIPT if
 * the section can no longer detect the defect it exists for:
 *
 *   1. Fixture   — two published Connectors with live credentials, a Project,
 *                  armed Tasks assigned through the production write.
 *                  CONTROL: the subject Task is genuinely READY, so a refusal
 *                  below is a refusal and not an unclaimable fixture.
 *   2. Claim     — the exact request retried returns the SAME lease, acquires
 *                  nothing, and leaves exactly ONE lease row.
 *                  CONTROL: a DIFFERENT resource key on the same Task is
 *                  refused ACTIVE_LEASE_CONFLICT, so "not acquired" is a
 *                  verdict rather than a blanket yes.
 *   3. Renew     — heartbeat is idempotent and never forks the lease.
 *                  CONTROL: a wrong lease id, and an EXPIRED lease, both
 *                  refuse LEASE_NOT_ACTIVE.
 *   4. Release   — releasing twice is one release; `released_at` does not
 *                  move on the replay.
 *                  CONTROL: a wrong lease id refuses.
 *   5. Race      — twelve concurrent claims of one Task produce exactly ONE
 *                  acquisition, ONE lease row, ONE history row and ONE
 *                  status-bearing feed event.
 *   6. Verifier  — the C3 refusal at the ORCHESTRATION claim.
 *                  CONTROL A: the pre-C3 call shape — the identical request
 *                  with the claimant identity omitted, which is exactly what
 *                  the route passed before this candidate — still claims. The
 *                  defect reproduced verbatim, so the refusal is provably the
 *                  new guard and not the fixture.
 *                  CONTROL B: a non-Verifier principal claims the same Task.
 *                  CONTROL C: the principal-plane claim answers `self_review`
 *                  for the same identity, so both doors now agree.
 *   7. Finish    — the Verifier cannot finish the work it must judge.
 *                  CONTROL: the CLAIMANT finishes the same Task, so the
 *                  refusal is about the role and not about finishability.
 *   8. Meltdown  — force-release + reassign seeded from the last good report,
 *                  as ONE operation, with the vehicle moving with it.
 *                  CONTROL A: the outgoing Connector loses read authority and
 *                  the incoming one gains it, both judged by the production
 *                  predicate.
 *                  CONTROL B: the Task is announceable again.
 *                  CONTROL C: the replay writes nothing.
 *                  CONTROL D: no linked Report seeds null and still recovers.
 *                  CONTROL E: a completed Task refuses and writes nothing.
 *   9. Shepherd   — the S-A5 + A20 path: a lapsed lease raises exactly one
 *                  `task.stuck(reason='lease_expired')`, and the SHEPHERD is
 *                  the recipient. No `lease.` name exists on any transport.
 *                  CONTROL: two live leases raise nothing; the claimant is NOT
 *                  the recipient (and the Task really has one); the episode is
 *                  announced once but re-arms on new activity; the staleness
 *                  arm reports a DIFFERENT reason, so `lease_expired` above is
 *                  attributable to the lease; and a Task that has left
 *                  `in-progress` raises nothing.
 *  10. Lease sweep — card `c8f95fef`: `expireActiveLeases()` was a public
 *                  method NOTHING called, so a lapsed lease stayed marked
 *                  `active` until somebody happened to attempt a claim. The
 *                  sweep flips it, and the shipped
 *                  `trg_task_execution_lease_assignment_compat` trigger
 *                  clears the assignment mirror with it.
 *                  CONTROL A: a LIVE lease in the same pass is untouched, so
 *                  "expired" is a verdict rather than a blanket flip.
 *                  CONTROL B: both rows were genuinely `active` and the
 *                  mirror genuinely pointed at them BEFORE the sweep, so
 *                  neither assertion can pass vacuously.
 *                  CONTROL C: the sweep emits NOTHING — no feed event on
 *                  either Task — because section 9's derivation is already
 *                  the shepherd's news and a second source would duplicate
 *                  it.
 *                  CONTROL D: a second pass finds nothing and moves no
 *                  `released_at`, so the sweep converges.
 *
 * Point DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a DISPOSABLE database
 * already carrying the full ledger (backend/scripts/test-fresh-install-replay.js
 * builds one). Exit 0 = every section and every control passed.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const probe = `
import { randomUUID } from "crypto";
import { pool } from "../src/db/connection";
import { principalService } from "../src/services/PrincipalService";
import { delegationService } from "../src/services/DelegationService";
import { serviceRegistry } from "../src/services/ServiceRegistry";
import { authorizationRepository } from "../src/services/AuthorizationRepository";
import { taskManagerDB } from "../src/services/TaskManagerDB";
import { taskElementService } from "../src/services/TaskElementService";
import { TaskOrchestrationService, OrchestrationConflictError } from "../src/services/TaskOrchestrationService";
import { telemetryService, TASK_STUCK_STALE_MINUTES } from "../src/services/TelemetryService";
import { notificationManager } from "../src/services/NotificationManager";

const ACTOR = { principalId: null as string | null, handle: "c3-lease-proof", authMethod: "system" as const };

/** The shape actorFromRequest builds for a root owner-plane session. */
const rootAuthorization = {
  principalId: null, handle: "c3-assigner", role: "admin",
  scopes: ["root"], authenticated: true, delegation: null,
} as any;
const assignerActor = {
  principalId: null, handle: "c3-assigner", authMethod: "session",
  credentialId: null, authorization: rootAuthorization,
} as any;

/** PRODUCTION visibility verdict for a Connector over a Task. */
async function connectorCanRead(principalId: string, taskId: string): Promise<boolean> {
  const chain = await delegationService.resolveChain(principalId);
  if (!chain.alive) return false;
  const acting = chain.links[0];
  const allowed = await authorizationRepository.authorizedIds(
    {
      principalId: acting.principalId, handle: "", role: acting.role, scopes: null,
      authenticated: true,
      delegation: chain.links.length > 1 && !acting.legacyIdentity ? { links: chain.links } : null,
    },
    "task", [taskId], "read",
  );
  return allowed.has(taskId);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "NO_ERROR"; }
  catch (err: any) { return String(err?.code ?? err?.message ?? err); }
}

async function scalar(sql: string, params: unknown[]): Promise<any> {
  const result = await pool.query(sql, params);
  return result.rows[0] ? Object.values(result.rows[0])[0] : null;
}

async function main() {
  const tag = "c3-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};

  // Production limits, widened only in COUNT so the race section can run
  // several tasks side by side. The lease TTL, the advisory lock, the
  // compare-and-set and every refusal are untouched.
  const orchestration = new TaskOrchestrationService(pool, {
    enabled: true, maxActiveGlobal: 50, maxActivePerProject: 50, leaseTtlSeconds: 900,
  });

  try {
    // ══ 1. FIXTURE ═════════════════════════════════════════════════════════
    const projectId = randomUUID();
    await pool.query(
      "INSERT INTO projects (id, name, description) VALUES ($1, $2, '')",
      [projectId, tag + "-project"]);

    const mkConnector = async (suffix: string) => {
      const account = (await principalService.createPrincipal({
        handle: tag + "-acct-" + suffix, kind: "service", role: "user",
        purpose: "c3 lease lifecycle proof",
      }))!;
      const svc: any = await serviceRegistry.register(
        { slug: tag + "-conn-" + suffix, name: "C3 conn " + suffix, kind: "connector" }, account.id);
      const row = await pool.query("SELECT principal_id FROM services WHERE id = $1", [svc.id]);
      const connectorId = String(row.rows[0].principal_id);
      // A delegated principal with no live credential is a DEAD chain
      // (AZ-9/AZ-25); registration mints one, so the fixture does too.
      await principalService.issueCredential({ principalId: connectorId, scopes: ["tasks:read"] }, ACTOR);
      const published: any = await serviceRegistry.publishDescriptor(
        svc.id, { options: [] }, svc.revision, account.id);
      await serviceRegistry.update(svc.id, { status: "published" }, published.service.revision, account.id);
      return { accountId: account.id, serviceId: String(svc.id), connectorId };
    };
    const A = await mkConnector("a");
    const B = await mkConnector("b");

    // Human-plane principals: the task ROLES are principal-typed, and an
    // Agent identity is shape-constrained to a parent AND a bound Task
    // (principals_agent_shape, §8.2/T36), which is not what
    // claimant/shepherd/verifier are being exercised as here.
    const mkPrincipal = async (suffix: string) => (await principalService.createPrincipal({
      handle: tag + "-p-" + suffix, kind: "human", role: "user", purpose: "c3 proof principal",
    }))!;
    const claimantPrincipal = await mkPrincipal("claimant");
    const verifierPrincipal = await mkPrincipal("verifier");
    const shepherdPrincipal = await mkPrincipal("shepherd");

    /** An ARMED todo Task in the project, assigned to a Connector through
     * the production write so the AZ-S7 vehicle is real. */
    const mkTask = async (title: string, serviceId: string | null) => {
      const id = randomUUID();
      await pool.query(
        \`INSERT INTO tasks (id, title, description, status, priority, visibility, project_id, auto_start)
         VALUES ($1,$2,'','todo','normal','private',$3,TRUE)\`,
        [id, tag + "-" + title, projectId]);
      if (serviceId) {
        await taskManagerDB.updateTask(id, {
          executionProfile: { serviceId, options: {} },
          executionServiceId: serviceId, executionDescriptorVersion: 1,
        } as any, assignerActor);
      }
      return id;
    };

    const subject = await mkTask("subject", A.serviceId);
    const snapshotOf = async (taskId: string) =>
      new Date(await scalar("SELECT updated_at FROM tasks WHERE id = $1", [taskId])).toISOString();

    // CONTROL: the subject really is claimable — assigned, todo, armed and
    // dependency-free. Every refusal below is measured against this.
    const readiness = await pool.query(
      \`SELECT t.status, t.auto_start, t.execution_service_id,
              (SELECT count(*)::int FROM task_dependencies d WHERE d.task_id = t.id) AS deps
         FROM tasks t WHERE t.id = $1\`, [subject]);
    out.control1_subjectIsAssignedArmedTodoAndUnblocked =
      readiness.rows[0].status === "todo" && readiness.rows[0].auto_start === true
      && String(readiness.rows[0].execution_service_id) === A.serviceId
      && readiness.rows[0].deps === 0;
    out.s1_assignmentMaterializedItsAccessVehicle =
      (await scalar("SELECT count(*)::int FROM access_vehicle_links WHERE task_id = $1", [subject])) > 0;

    // ══ 2. CLAIM IDEMPOTENCY ═══════════════════════════════════════════════
    const request = {
      taskId: subject, snapshotUpdatedAt: await snapshotOf(subject),
      harness: "hermes" as const, resourceKey: tag + ":worker-1",
      claimantPrincipalId: claimantPrincipal.id,
    };
    const first = await orchestration.claimReadyTask(request);
    out.s2_firstClaimAcquires = first.acquired === true;
    out.s2_taskMovedToInProgress =
      (await scalar("SELECT status FROM tasks WHERE id = $1", [subject])) === "in-progress";

    // The EXACT request again. The snapshot is deliberately the ORIGINAL
    // one, which the claim has already invalidated by bumping updated_at —
    // a real retry after a lost response carries the stale snapshot, and
    // the replay must still be recognised.
    const replay = await orchestration.claimReadyTask(request);
    out.s2_retryOfTheExactRequestAcquiresNothing = replay.acquired === false;
    out.s2_retryReturnsTheSameLease = replay.lease.id === first.lease.id;
    out.s2_exactlyOneLeaseRowExists =
      (await scalar("SELECT count(*)::int FROM task_execution_leases WHERE task_id = $1", [subject])) === 1;

    // CONTROL: a different resource key is a genuine conflict, not a replay.
    out.control2_aDifferentResourceKeyIsRefused = (await codeOf(orchestration.claimReadyTask({
      ...request, resourceKey: tag + ":worker-2",
    }))) === "ACTIVE_LEASE_CONFLICT";

    // ══ 3. RENEW IDEMPOTENCY ═══════════════════════════════════════════════
    const beat1 = await orchestration.heartbeatLease(subject, first.lease.id, undefined, 900);
    const beat2 = await orchestration.heartbeatLease(subject, first.lease.id, undefined, 900);
    out.s3_heartbeatIsIdempotentOnTheSameLease =
      beat1.id === first.lease.id && beat2.id === first.lease.id && beat2.status === "active";
    out.s3_heartbeatNeverForksTheLease =
      (await scalar("SELECT count(*)::int FROM task_execution_leases WHERE task_id = $1", [subject])) === 1;
    out.s3_heartbeatExtendsTheExpiry = new Date(beat2.expiresAt).getTime() >= new Date(first.lease.expiresAt).getTime();

    // CONTROL: an unknown lease, and an expired one, both refuse.
    out.control3_anUnknownLeaseIdIsRefused =
      (await codeOf(orchestration.heartbeatLease(subject, randomUUID()))) === "LEASE_NOT_ACTIVE";
    await pool.query(
      "UPDATE task_execution_leases SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [first.lease.id]);
    out.control3_anExpiredLeaseIsRefused =
      (await codeOf(orchestration.heartbeatLease(subject, first.lease.id))) === "LEASE_NOT_ACTIVE";
    await pool.query(
      "UPDATE task_execution_leases SET expires_at = NOW() + INTERVAL '15 minutes' WHERE id = $1",
      [first.lease.id]);

    // ══ 4. RELEASE IDEMPOTENCY ═════════════════════════════════════════════
    const released = await orchestration.releaseLease(subject, first.lease.id);
    const releasedAt = await scalar("SELECT released_at FROM task_execution_leases WHERE id = $1", [first.lease.id]);
    const releasedAgain = await orchestration.releaseLease(subject, first.lease.id);
    const releasedAtAfter = await scalar("SELECT released_at FROM task_execution_leases WHERE id = $1", [first.lease.id]);
    out.s4_releaseIsIdempotent =
      released.status === "released" && releasedAgain.status === "released"
      && releasedAgain.id === first.lease.id;
    out.s4_theReplayDoesNotMoveReleasedAt =
      new Date(releasedAt).getTime() === new Date(releasedAtAfter).getTime();
    out.control4_releasingAnUnknownLeaseIsRefused =
      (await codeOf(orchestration.releaseLease(subject, randomUUID()))) === "LEASE_NOT_ACTIVE";

    // ══ 5. CONCURRENCY ═════════════════════════════════════════════════════
    const raced = await mkTask("raced", A.serviceId);
    const racedSnapshot = await snapshotOf(raced);
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      orchestration.claimReadyTask({
        taskId: raced, snapshotUpdatedAt: racedSnapshot, harness: "hermes",
        resourceKey: tag + ":racer-" + i, claimantPrincipalId: claimantPrincipal.id,
      }).then((r) => (r.acquired ? "acquired" : "replay")).catch((e: any) => String(e.code))));
    out.s5_exactlyOneConcurrentClaimAcquires =
      attempts.filter((a) => a === "acquired").length === 1;
    out.s5_everyOtherAttemptIsARefusalNotAnAcquisition =
      attempts.filter((a) => a !== "acquired").every((a) => a === "ACTIVE_LEASE_CONFLICT" || a === "replay");
    out.s5_exactlyOneLeaseRow =
      (await scalar("SELECT count(*)::int FROM task_execution_leases WHERE task_id = $1", [raced])) === 1;
    out.s5_exactlyOneHistoryRow = (await scalar(
      "SELECT count(*)::int FROM task_history WHERE task_id = $1 AND event_type = 'orchestration.claimed'",
      [raced])) === 1;
    out.s5_exactlyOneStatusBearingFeedEvent = (await scalar(
      \`SELECT count(*)::int FROM feed_events
        WHERE object_type = 'task' AND object_id = $1 AND payload ? 'status'\`, [raced])) === 1;

    // ══ 6. THE VERIFIER MAY NOT CLAIM ══════════════════════════════════════
    const guarded = await mkTask("guarded", A.serviceId);
    // The role is written by the PRODUCTION role surface and read back out
    // of the production task_assignments row — not a fixture column.
    const assigned = await taskManagerDB.assignTaskRoles(
      guarded, { shepherdPrincipalId: shepherdPrincipal.id, verifierPrincipalId: verifierPrincipal.id },
      { handle: "c3-proof", authMethod: "system" } as any);
    out.s6_verifierRoleWrittenByTheProductionSurface = assigned === "updated";
    out.s6_roleIsVisibleInTheProductionTaskRoleRow = (await scalar(
      "SELECT verifier_principal_id FROM task_assignments WHERE task_id = $1", [guarded])) === verifierPrincipal.id;

    const guardedRequest = {
      taskId: guarded, snapshotUpdatedAt: await snapshotOf(guarded),
      harness: "hermes" as const, resourceKey: tag + ":verifier-worker",
    };
    out.s6_theVerifierIsRefusedAtTheOrchestrationClaim = (await codeOf(
      orchestration.claimReadyTask({ ...guardedRequest, claimantPrincipalId: verifierPrincipal.id })
    )) === "CLAIMANT_VERIFIER_CONFLICT";
    out.s6_theRefusalCreatesNoLease =
      (await scalar("SELECT count(*)::int FROM task_execution_leases WHERE task_id = $1", [guarded])) === 0;
    out.s6_theRefusalLeavesTheTaskInTodo =
      (await scalar("SELECT status FROM tasks WHERE id = $1", [guarded])) === "todo";

    // CONTROL A — THE DEFECT REPRODUCED VERBATIM. The identical request with
    // the claimant identity omitted is exactly what the route passed before
    // this candidate, and it still claims. If this ever fails, section 6 has
    // stopped proving that the guard is what refuses.
    const defect = await mkTask("pre-c3-shape", A.serviceId);
    await taskManagerDB.assignTaskRoles(
      defect, { verifierPrincipalId: verifierPrincipal.id },
      { handle: "c3-proof", authMethod: "system" } as any);
    const preC3 = await orchestration.claimReadyTask({
      taskId: defect, snapshotUpdatedAt: await snapshotOf(defect),
      harness: "hermes", resourceKey: tag + ":pre-c3",
    });
    out.control6a_thePreC3CallShapeStillClaimsTheSameVerifierHeldTask = preC3.acquired === true;

    // CONTROL B — the refusal is identity-specific, not task-specific.
    const other = await orchestration.claimReadyTask({
      ...guardedRequest, resourceKey: tag + ":non-verifier",
      claimantPrincipalId: claimantPrincipal.id,
    });
    out.control6b_aNonVerifierClaimsTheSameTask = other.acquired === true;

    // CONTROL C — the principal-plane door answers the same way, so the
    // ratified sentence now holds on BOTH claim paths rather than one.
    const principalPlane = await mkTask("principal-plane", A.serviceId);
    await taskManagerDB.assignTaskRoles(
      principalPlane, { verifierPrincipalId: verifierPrincipal.id },
      { handle: "c3-proof", authMethod: "system" } as any);
    out.control6c_thePrincipalPlaneClaimAgrees =
      (await taskManagerDB.claimTask(principalPlane, verifierPrincipal.id)) === "self_review";

    // ══ 7. THE VERIFIER MAY NOT FINISH ═════════════════════════════════════
    const finishable = await mkTask("finishable", A.serviceId);
    await taskManagerDB.assignTaskRoles(
      finishable, { verifierPrincipalId: verifierPrincipal.id },
      { handle: "c3-proof", authMethod: "system" } as any);
    // Claimed on the principal plane, so owner_principal_id (the claimant
    // identifier) is really set, then moved to in-progress the way a
    // scheduler claim moves it.
    await taskManagerDB.claimTask(finishable, claimantPrincipal.id);
    await pool.query("UPDATE tasks SET status = 'in-progress' WHERE id = $1", [finishable]);
    const finishReport = randomUUID();
    await pool.query(
      "INSERT INTO reports (id, title, content, project_id, task_ids) VALUES ($1,$2,$3,$4,ARRAY[$5]::uuid[])",
      [finishReport, tag + " finish report", "handover", projectId, finishable]);

    const verifierFinishActor = {
      principalId: verifierPrincipal.id, handle: tag + "-p-verifier", root: false,
      authorization: rootAuthorization,
    } as any;
    out.s7_theVerifierIsRefusedAtFinish = (await codeOf(
      taskElementService.finish(finishable, { reportId: finishReport }, verifierFinishActor)
    )) === "CLAIMANT_VERIFIER_CONFLICT";
    out.s7_theRefusalLeavesTheTaskInProgress =
      (await scalar("SELECT status FROM tasks WHERE id = $1", [finishable])) === "in-progress";

    // A principal holding the SHEPHERD role AS WELL AS the Verifier role.
    // Live QA on DEV caught this: authorRole() resolves claimant -> shepherd
    // -> verifier and returns the FIRST hit, so this identity answered
    // "shepherd" and finished the Task it was assigned to judge. The DB
    // CHECK tasks_claimant_verifier_separation makes claimant+verifier
    // unrepresentable; shepherd+verifier is perfectly representable.
    const doubleRole = await mkTask("double-role", A.serviceId);
    await taskManagerDB.assignTaskRoles(
      doubleRole,
      { shepherdPrincipalId: verifierPrincipal.id, verifierPrincipalId: verifierPrincipal.id },
      { handle: "c3-proof", authMethod: "system" } as any);
    await taskManagerDB.claimTask(doubleRole, claimantPrincipal.id);
    await pool.query("UPDATE tasks SET status = 'in-progress' WHERE id = $1", [doubleRole]);
    const doubleReport = randomUUID();
    await pool.query(
      "INSERT INTO reports (id, title, content, project_id, task_ids) VALUES ($1,$2,$3,$4,ARRAY[$5]::uuid[])",
      [doubleReport, tag + " double-role report", "handover", projectId, doubleRole]);
    out.s7_aShepherdWhoIsAlsoTheVerifierIsRefused = (await codeOf(
      taskElementService.finish(doubleRole, { reportId: doubleReport }, verifierFinishActor)
    )) === "CLAIMANT_VERIFIER_CONFLICT";
    out.s7_thatRefusalAlsoLeavesTheTaskInProgress =
      (await scalar("SELECT status FROM tasks WHERE id = $1", [doubleRole])) === "in-progress";

    // CONTROL: a SHEPHERD who is not the Verifier still finishes, so the
    // repair closed the Verifier arm and nothing else — §2.6.4 gives the
    // shepherd real lifecycle authority.
    const shepherdOnly = await mkTask("shepherd-only", A.serviceId);
    await taskManagerDB.assignTaskRoles(
      shepherdOnly, { shepherdPrincipalId: shepherdPrincipal.id },
      { handle: "c3-proof", authMethod: "system" } as any);
    await taskManagerDB.claimTask(shepherdOnly, claimantPrincipal.id);
    await pool.query("UPDATE tasks SET status = 'in-progress' WHERE id = $1", [shepherdOnly]);
    const shepherdReport = randomUUID();
    await pool.query(
      "INSERT INTO reports (id, title, content, project_id, task_ids) VALUES ($1,$2,$3,$4,ARRAY[$5]::uuid[])",
      [shepherdReport, tag + " shepherd report", "handover", projectId, shepherdOnly]);
    await taskElementService.finish(shepherdOnly, { reportId: shepherdReport }, {
      principalId: shepherdPrincipal.id, handle: tag + "-p-shepherd", root: false,
      authorization: rootAuthorization,
    } as any);
    out.control7_aShepherdWhoIsNotTheVerifierStillFinishes =
      (await scalar("SELECT status FROM tasks WHERE id = $1", [shepherdOnly])) === "review";

    // CONTROL: the CLAIMANT finishes the very same Task with the very same
    // Report. The refusal is about the role, not about finishability.
    const claimantFinishActor = {
      principalId: claimantPrincipal.id, handle: tag + "-p-claimant", root: false,
      authorization: rootAuthorization,
    } as any;
    await taskElementService.finish(finishable, { reportId: finishReport }, claimantFinishActor);
    out.control7_theClaimantFinishesTheSameTask =
      (await scalar("SELECT status FROM tasks WHERE id = $1", [finishable])) === "review";

    // ══ 8. ONE-CLICK MELTDOWN RECOVERY ═════════════════════════════════════
    const melted = await mkTask("melted", A.serviceId);
    await taskManagerDB.assignTaskRoles(
      melted, { shepherdPrincipalId: shepherdPrincipal.id },
      { handle: "c3-proof", authMethod: "system" } as any);
    await taskManagerDB.claimTask(melted, claimantPrincipal.id);
    const meltedLease = await orchestration.claimReadyTask({
      taskId: melted, snapshotUpdatedAt: await snapshotOf(melted), harness: "hermes",
      resourceKey: tag + ":melted-worker", claimantPrincipalId: claimantPrincipal.id,
    });

    // Two linked Reports; the SECOND is the last good one. Written a second
    // apart so "newest" is a fact about the data, not about insertion luck.
    const olderReport = randomUUID();
    const newerReport = randomUUID();
    await pool.query(
      \`INSERT INTO reports (id, title, content, project_id, task_ids, created_at, updated_at)
       VALUES ($1,$2,'first handover',$3,ARRAY[$4]::uuid[], NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours')\`,
      [olderReport, tag + " older", projectId, melted]);
    await pool.query(
      \`INSERT INTO reports (id, title, content, project_id, task_ids, created_at, updated_at)
       VALUES ($1,$2,'last good handover',$3,ARRAY[$4]::uuid[], NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '5 minutes')\`,
      [newerReport, tag + " newer", projectId, melted]);

    const beforeA = await connectorCanRead(A.connectorId, melted);
    const beforeB = await connectorCanRead(B.connectorId, melted);
    out.control8_beforeRecoveryOnlyTheOutgoingConnectorCanRead = beforeA === true && beforeB === false;

    const shepherdActor = {
      principalId: shepherdPrincipal.id, handle: tag + "-p-shepherd", authMethod: "session",
      credentialId: null, authorization: rootAuthorization,
    } as any;
    const recovery: any = await taskManagerDB.recoverTask(melted, {
      executionServiceId: B.serviceId,
      executionProfile: { serviceId: B.serviceId, options: {} },
      executionDescriptorVersion: 1,
      reason: "context meltdown",
    }, shepherdActor);

    out.s8_recoveryReports = recovery.outcome === "recovered";
    out.s8_seededFromTheLastGoodReport = recovery.seedReportId === newerReport;
    out.s8_theForceReleasedClaimantIsReported = recovery.previousClaimantPrincipalId === claimantPrincipal.id;
    out.s8_theTaskIsBackInTodoWithNoClaimant = (await pool.query(
      "SELECT status, owner_principal_id, execution_service_id FROM tasks WHERE id = $1", [melted]
    )).rows[0].status === "todo";
    const meltedRow = (await pool.query(
      "SELECT status, owner_principal_id, execution_service_id, auto_start FROM tasks WHERE id = $1", [melted])).rows[0];
    out.s8_theClaimantIsCleared = meltedRow.owner_principal_id === null;
    out.s8_theWorkIsReassigned = String(meltedRow.execution_service_id) === B.serviceId;
    out.s8_armingIsUntouched = meltedRow.auto_start === true;
    out.s8_theRuntimeLeaseIsReleased =
      (await scalar("SELECT status FROM task_execution_leases WHERE id = $1", [meltedLease.lease.id])) === "released";
    out.s8_bothLedgerEntriesAreWritten = (await scalar(
      \`SELECT count(*)::int FROM audit_events
        WHERE resource_id = $1 AND action IN
        ('task.lifecycle_override.force_release','task.lifecycle_override.recovery')\`, [melted])) === 2;
    // On the RATIFIED transition event, discriminated by metadata rather
    // than by a locally-minted name (review r1 B1, verdict 2834c857).
    out.s8_theSeedIsOnTheTaskStream = (await scalar(
      \`SELECT report_id FROM task_stream_entries
        WHERE task_id = $1 AND event_type = 'task.transitioned'
          AND metadata->>'recovery' = 'true'\`, [melted])) === newerReport;
    out.s8_theRecoveryUsesNoLocallyMintedEventName = (await scalar(
      \`SELECT count(*)::int FROM task_stream_entries
        WHERE task_id = $1 AND event_type NOT IN
          ('task.transitioned','handover.finish','handover.note','outpost.reported')\`,
      [melted])) === 0;

    // CONTROL A: the vehicle moved with the assignment. Judged by the
    // production predicate off a real resolved chain, never a fixture.
    out.control8a_theOutgoingConnectorLostRead = (await connectorCanRead(A.connectorId, melted)) === false;
    out.control8a_theIncomingConnectorGainedRead = (await connectorCanRead(B.connectorId, melted)) === true;

    // CONTROL B: it can be announced again — the whole point of requeueing.
    out.control8b_theTaskIsAnnounceableAgain = (await scalar(
      "SELECT count(*)::int FROM task_readiness WHERE task_id = $1", [melted])) === 1;

    // CONTROL C: the replay writes nothing.
    const auditBefore = await scalar(
      "SELECT count(*)::int FROM audit_events WHERE resource_id = $1", [melted]);
    const streamBefore = await scalar(
      "SELECT count(*)::int FROM task_stream_entries WHERE task_id = $1", [melted]);
    const replayed: any = await taskManagerDB.recoverTask(melted, {
      executionServiceId: B.serviceId,
      executionProfile: { serviceId: B.serviceId, options: {} },
      executionDescriptorVersion: 1,
    }, shepherdActor);
    out.control8c_theReplayIsRecognised = replayed.outcome === "replayed";
    out.control8c_theReplayWritesNothing =
      (await scalar("SELECT count(*)::int FROM audit_events WHERE resource_id = $1", [melted])) === auditBefore
      && (await scalar("SELECT count(*)::int FROM task_stream_entries WHERE task_id = $1", [melted])) === streamBefore;

    // CONTROL D: no linked Report. The honest answer is null, and the
    // recovery still runs — a claimant that melted down before filing
    // anything is precisely the case this operation exists for.
    const unreported = await mkTask("unreported", A.serviceId);
    await taskManagerDB.claimTask(unreported, claimantPrincipal.id);
    const bare: any = await taskManagerDB.recoverTask(unreported, {
      executionServiceId: B.serviceId,
      executionProfile: { serviceId: B.serviceId, options: {} },
      executionDescriptorVersion: 1,
    }, shepherdActor);
    out.control8d_noLinkedReportSeedsNullAndStillRecovers =
      bare.outcome === "recovered" && bare.seedReportId === null
      && (await scalar("SELECT status FROM tasks WHERE id = $1", [unreported])) === "todo";

    // CONTROL E: a completed Task has no meltdown to recover from, and the
    // refusal writes nothing.
    const done = await mkTask("done", A.serviceId);
    await pool.query("UPDATE tasks SET status = 'completed' WHERE id = $1", [done]);
    const auditDoneBefore = await scalar(
      "SELECT count(*)::int FROM audit_events WHERE resource_id = $1", [done]);
    const terminal: any = await taskManagerDB.recoverTask(done, {
      executionServiceId: B.serviceId,
      executionProfile: { serviceId: B.serviceId, options: {} },
      executionDescriptorVersion: 1,
    }, shepherdActor);
    out.control8e_aCompletedTaskIsRefused = terminal.outcome === "task_terminal";
    out.control8e_theRefusalWritesNothing =
      (await scalar("SELECT count(*)::int FROM audit_events WHERE resource_id = $1", [done])) === auditDoneBefore
      && (await scalar("SELECT status FROM tasks WHERE id = $1", [done])) === "completed";

    // ══ 9. THE SHEPHERD HEARS ABOUT AN EXPIRED LEASE (amendment S-A5) ══════
    //
    // Owner gate 3195d0e3 was RULED Option C on 2026-08-26: lease expiry is
    // delivered as task.stuck(reason='lease_expired') and lease.expired
    // retires as a separate wire event.
    //
    // THE RULING WAS FOLDED IN TWO HALVES, and both are load-bearing here:
    //   - strategy 4e40f06f amendment S-A5 amends 2.6.4's exception-event
    //     list and retires the name from the 2.6.2 [PROPOSAL] taxonomy;
    //   - vocabulary b94dd86e amendment A20 is the NAMING half — 3 Lease,
    //     5.3 Shepherd and the 6 Events example, plus 7 Retired words.
    // b94dd86e governs naming where the two documents conflict, so the
    // no-lease-dot-event assertion below rests on A20, not on S-A5. Folding
    // only the strategy was blocking finding B1 of review dc0639f1.
    //
    // The ruling is documentation; what C3 subtask 1 owes is the PROOF that
    // the derivation actually reaches the task's shepherd. This section is
    // that proof, driven through the production TelemetryService sweep and
    // the production notification path.
    const shepherdOf = async (title: string) => {
      const id = await mkTask(title, A.serviceId);
      // shepherd != claimant, and the Task has no creator, so
      // COALESCE(shepherd, creator, owner) has a real discriminator: if the
      // recipient came out as the claimant the COALESCE fell through.
      await taskManagerDB.assignTaskRoles(
        id, { shepherdPrincipalId: shepherdPrincipal.id },
        { handle: "c3-proof", authMethod: "system" } as any);
      await taskManagerDB.claimTask(id, claimantPrincipal.id);
      const claimed = await orchestration.claimReadyTask({
        taskId: id, snapshotUpdatedAt: await snapshotOf(id), harness: "hermes",
        resourceKey: tag + ":" + title, claimantPrincipalId: claimantPrincipal.id,
      });
      return { id, leaseId: claimed.lease.id };
    };
    const lapsedTask = await shepherdOf("lapsed");
    const liveTask = await shepherdOf("live");
    const staleTask = await shepherdOf("stale");
    const lapsed = lapsedTask.id;
    const live = liveTask.id;
    const stale = staleTask.id;

    const stuckCount = async (taskId: string) => await scalar(
      \`SELECT count(*)::int FROM feed_events
        WHERE name = 'task.stuck' AND object_type = 'task' AND object_id = $1\`, [taskId]);
    const noticesFor = async (taskId: string) =>
      (await notificationManager.getNotifications()).filter((n: any) => n.taskId === taskId);

    // Only ONE of the three has a lapsed lease. The other two are the controls
    // that make the emission attributable to the lapse.
    await pool.query(
      "UPDATE task_execution_leases SET expires_at = NOW() - INTERVAL '2 minutes' WHERE task_id = $1",
      [lapsed]);

    await telemetryService.sweepStuckTasks(new Date());
    out.s9_theLapsedLeaseRaisesExactlyOneTaskStuck = (await stuckCount(lapsed)) === 1;
    out.s9_theReasonIsLeaseExpired = (await scalar(
      \`SELECT payload->>'reason' FROM feed_events
        WHERE name = 'task.stuck' AND object_id = $1\`, [lapsed])) === "lease_expired";
    out.control9_aLiveLeaseIsNotStuck = (await stuckCount(live)) === 0;
    out.control9_aSecondLiveLeaseIsAlsoNotStuck = (await stuckCount(stale)) === 0;

    // A20 itself: ONE shape. No lease. name family on any transport. This is
    // the assertion the naming authority now requires, and the one that would
    // have been false against the pre-A20 vocabulary.
    out.s9_noLeaseDotEventExistsAnywhere = (await scalar(
      "SELECT count(*)::int FROM feed_events WHERE name LIKE 'lease.%'", [])) === 0;

    // §2.6.4: "the shepherd receives the exception events".
    const lapsedNotices = await noticesFor(lapsed);
    out.s9_theShepherdIsTheRecipient =
      lapsedNotices.length === 1 && lapsedNotices[0].recipientPrincipalId === shepherdPrincipal.id;
    out.s9_theNoticeCarriesTheCoarseReason =
      lapsedNotices.length === 1
      && lapsedNotices[0].exception?.name === "task.stuck"
      && lapsedNotices[0].exception?.reason === "lease_expired";
    // CONTROL: not the claimant. The Task HAS a claimant (owner_principal_id
    // is set), so this is a live discriminator rather than a vacuous one.
    out.control9_theClaimantIsNotTheRecipient =
      lapsedNotices.every((n: any) => n.recipientPrincipalId !== claimantPrincipal.id)
      && (await scalar("SELECT owner_principal_id FROM tasks WHERE id = $1", [lapsed]))
         === claimantPrincipal.id;

    // Episode dedup: the same lapse does not re-announce on every tick.
    await telemetryService.sweepStuckTasks(new Date());
    out.s9_theEpisodeIsAnnouncedOnce = (await stuckCount(lapsed)) === 1;

    // CONTROL for the dedup: it is EPISODE-scoped, not permanent. New
    // qualifying activity re-arms it, or a task rescued and re-stuck would go
    // silent forever.
    await pool.query(
      \`INSERT INTO reports (id, title, content, project_id, task_ids)
       VALUES (gen_random_uuid(), $1, 'fresh activity', $2, ARRAY[$3]::uuid[])\`,
      [tag + " re-arm", projectId, lapsed]);
    await telemetryService.sweepStuckTasks(new Date());
    out.control9_newActivityReArmsTheEpisode = (await stuckCount(lapsed)) === 2;

    // CONTROL: the OTHER arm still works and is distinguishable. A claimant
    // that keeps its lease alive but shows no activity for the stale window
    // is the F11 heartbeating-but-dead backstop, and it reports a DIFFERENT
    // reason — so section 9's lease_expired above is attributable to the
    // lease and not to staleness.
    const future = new Date(Date.now() + (TASK_STUCK_STALE_MINUTES + 15) * 60_000);
    // Renewed through the production heartbeat, to a TTL that outlives the
    // future clock: at \`future\` this claimant is demonstrably still holding
    // its lease, so anything it reports comes from the STALENESS arm.
    await orchestration.heartbeatLease(stale, staleTask.leaseId, undefined, 3600);
    const leaseStillLiveAtFuture = new Date(await scalar(
      "SELECT expires_at FROM task_execution_leases WHERE id = $1", [staleTask.leaseId]));
    out.control9_theStaleClaimantIsStillHoldingItsLease =
      leaseStillLiveAtFuture.getTime() > future.getTime();
    await telemetryService.sweepStuckTasks(future);
    out.control9_staleActivityReportsADifferentReason = (await scalar(
      \`SELECT payload->>'reason' FROM feed_events
        WHERE name = 'task.stuck' AND object_id = $1\`, [stale])) === "status_stale";

    // CONTROL: the scoping S-A5 records. A Task that has LEFT in-progress is
    // not awaiting rescue — a verifier holds it, or it is already stuck or
    // terminal — so an expired lease on it raises nothing.
    const beforeMove = await stuckCount(live);
    await pool.query("UPDATE tasks SET status = 'review' WHERE id = $1", [live]);
    await pool.query(
      "UPDATE task_execution_leases SET expires_at = NOW() - INTERVAL '2 minutes' WHERE task_id = $1",
      [live]);
    await telemetryService.sweepStuckTasks(new Date());
    out.control9_aTaskThatLeftInProgressRaisesNothing = (await stuckCount(live)) === beforeMove;

    // -- 10. the lease expiry sweep (card c8f95fef) -------------------------
    //
    // expireActiveLeases() shipped as a public method with no caller. The
    // column it maintains is not load-bearing -- the derivation above reads
    // expires_at against the board clock and the budgets carry
    // "AND expires_at > NOW()" -- but a status that does not mean what it says
    // is a trap for the next query written against it, which is what the card
    // asks to close. This section drives the PRODUCTION service against real
    // rows and a real trigger; the jest suite beside it proves only that the
    // schedule calls it.
    //
    // NOTE: only the two columns below are ever read back by name, so the one
    // helper that takes a column name is fed from this closed set and never
    // from anything a fixture computes.
    const LEASE_COLUMNS = ["status", "released_at"];
    const sweepLapsed = await shepherdOf("sweep-lapsed");
    const sweepLive = await shepherdOf("sweep-live");
    const leaseField = async (leaseId: string, column: string) => {
      if (!LEASE_COLUMNS.includes(column)) throw new Error("unlisted column " + column);
      return await scalar("SELECT " + column + " FROM task_execution_leases WHERE id = $1", [leaseId]);
    };
    const mirrorOf = async (taskId: string) => await scalar(
      "SELECT current_lease_id FROM task_assignments WHERE task_id = $1", [taskId]);
    const eventsOn = async () => await scalar(
      "SELECT count(*)::int FROM feed_events WHERE object_type = 'task' AND object_id = ANY($1)",
      [[sweepLapsed.id, sweepLive.id]]);

    await pool.query(
      "UPDATE task_execution_leases SET expires_at = NOW() - INTERVAL '2 minutes' WHERE id = $1",
      [sweepLapsed.leaseId]);

    // CONTROL B -- the pre-state. Without it the assertions below would pass
    // just as well on rows that were never active and never mirrored.
    out.control10_bothLeasesWereActiveBeforeTheSweep =
      (await leaseField(sweepLapsed.leaseId, "status")) === "active"
      && (await leaseField(sweepLive.leaseId, "status")) === "active";
    out.control10_theMirrorPointedAtBothLeasesBeforeTheSweep =
      (await mirrorOf(sweepLapsed.id)) === sweepLapsed.leaseId
      && (await mirrorOf(sweepLive.id)) === sweepLive.leaseId;

    const eventsBefore = await eventsOn();

    const swept = await orchestration.expireActiveLeases();
    out.s10_theSweepReportsWhatItFlipped = typeof swept === "number" && swept >= 1;
    out.s10_theLapsedLeaseIsExpired =
      (await leaseField(sweepLapsed.leaseId, "status")) === "expired";
    out.s10_theLapsedLeaseIsReleased =
      (await leaseField(sweepLapsed.leaseId, "released_at")) !== null;
    out.s10_theAssignmentMirrorNoLongerPointsAtADeadLease =
      (await mirrorOf(sweepLapsed.id)) === null;

    // CONTROL A -- a sweep that expired everything would satisfy all four above.
    out.control10_theLiveLeaseIsUntouched =
      (await leaseField(sweepLive.leaseId, "status")) === "active"
      && (await leaseField(sweepLive.leaseId, "released_at")) === null
      && (await mirrorOf(sweepLive.id)) === sweepLive.leaseId;

    // CONTROL C -- the sweep is hygiene, not a second announcement. The
    // shepherd already hears about a lapse from section 9's derivation.
    out.control10_theSweepEmitsNothing = (await eventsOn()) === eventsBefore;

    // CONTROL D -- it converges: a second pass finds nothing left of this row
    // and does not move the timestamp the first pass wrote.
    const releasedAfterFirst = await leaseField(sweepLapsed.leaseId, "released_at");
    await orchestration.expireActiveLeases();
    out.control10_aSecondPassMovesNothing =
      String(await leaseField(sweepLapsed.leaseId, "released_at")) === String(releasedAfterFirst)
      && (await leaseField(sweepLive.leaseId, "status")) === "active";

    console.log(JSON.stringify(out, null, 2));
    const entries = Object.entries(out);
    const failures = entries.filter(([, v]) => typeof v === "boolean" && !v);
    console.log("checks=" + entries.length + " passed=" + (entries.length - failures.length));
    if (failures.length > 0) {
      console.error("FAILED:", failures.map(([k]) => k).join(", "));
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
`;

const fs = require('fs');
const tmp = path.join(__dirname, '.c3-lease-lifecycle-probe.ts');
fs.writeFileSync(tmp, probe);
const result = spawnSync(path.join(__dirname, '..', 'node_modules', '.bin', 'tsx'), [tmp], {
  stdio: 'inherit',
  env: {
    ...process.env,
    RELAYHALL_CREDENTIAL_KEYS: process.env.RELAYHALL_CREDENTIAL_KEYS
      || JSON.stringify({ livekey: Buffer.alloc(32, 9).toString('base64') }),
    RELAYHALL_CREDENTIAL_ACTIVE_KEY: process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY || 'livekey',
    // Section 9 drives the production notification path, whose store is a
    // FILE (default /data/task-notifications.json). Point it at a disposable
    // path so a proof run never writes into a deployment's notification feed.
    TASK_NOTIFICATIONS_FILE: process.env.TASK_NOTIFICATIONS_FILE
      || path.join(require('os').tmpdir(), 'c3-proof-notifications.json'),
  },
  cwd: path.join(__dirname, '..'),
});
fs.unlinkSync(tmp);
process.exit(result.status ?? 1);
