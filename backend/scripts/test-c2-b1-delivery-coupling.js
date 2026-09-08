#!/usr/bin/env node
/**
 * test-c2-b1-delivery-coupling.js — RH-P3.C2 (card 977c9eac; review r3
 * verdict 840711d1 finding B1; owner ruling 7440b579; AZ-S7 card 446240c4):
 * behavioral proof that an ASSIGNED Connector receives its signed
 * `task.ready` doorbell WITHOUT any separate object or wildcard grant.
 *
 * B1 said: give a published Connector a valid `tasks:read` credential and
 * registry webhook configuration, assign it an armed ready private Task
 * through `tasks.execution_service_id` but no separate grant, and the
 * doorbell is lost — `listSince()` examines the row, the shared predicate
 * removes it, the cursor advances past it anyway, and every retry starts
 * after the lost event.
 *
 * Ruling 7440b579 R1 closed it WITHOUT touching the evaluator: the
 * assignment act itself materializes an access vehicle in the same
 * transaction as the write to `tasks.execution_service_id`, so the
 * assigned-but-invisible state is unrepresentable and section 2.6.4's union
 * holds by construction. This script proves the END STATE rather than citing
 * the ruling, because a ruling is not evidence.
 *
 * Nothing here uses a synthetic actor. The visibility verdict comes from
 * `authorizationRepository.authorizedIds` off a chain resolved by
 * `delegationService.resolveChain` — the same call the shared predicate
 * serves every route — the assignment goes through `taskManagerDB`, and the
 * doorbell is delivered by the real `WebhookDeliveryWorker` over real HTTP.
 * That is the AZ-S3 lesson, restated as an implementation duty by 7440b579.
 *
 * SECTIONS, each with a POSITIVE CONTROL — a step that FAILS THE SCRIPT if
 * the section can no longer detect the defect it exists for:
 *
 *   1. Fixture     — two published Connectors, `tasks:read` credentials,
 *                    registry webhook + endpoint + secret, and ZERO grants
 *                    and ZERO profile assignments anywhere on either chain.
 *                    CONTROL: the emptiness is asserted, not assumed.
 *   2. B1 verbatim — the assignment written STRAIGHT TO SQL, the coupling
 *                    bypassed, is exactly the pre-ruling state: invisible to
 *                    the production predicate and NO doorbell arrives. This
 *                    is the control for everything below it: if a doorbell
 *                    ever arrives here, sections 3-5 have stopped proving
 *                    anything.
 *   3. Coupling    — the SAME assignment through `taskManagerDB` makes the
 *                    task visible to the production predicate, with the
 *                    vehicle's grants provenance-tagged and no hand-written
 *                    grant anywhere. CONTROL: while the dependency is UNMET
 *                    the task is not ready and no doorbell is sent, so the
 *                    doorbell tracks the predicate rather than the fixture.
 *   4. Doorbell    — completing the parent rings A: signed with A's REGISTRY
 *                    secret over the exact transmitted bytes, plane `work`,
 *                    channel = A's registry row, `task.ready` only, ID-only
 *                    payload, about the assigned task.
 *                    CONTROL: Connector B, published and webhook-configured
 *                    but NOT assigned, receives nothing at all.
 *   5. R4 loop     — unassigning detaches the vehicle: the task goes
 *                    invisible again and the doorbell stops.
 *                    CONTROL: the readiness announcement is retracted too,
 *                    so a later re-assignment can ring again.
 *
 * Point DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a DISPOSABLE database
 * already carrying the full ledger (backend/scripts/test-fresh-install-replay.js
 * builds one). Exit 0 = every section and every control passed.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const probe = `
import http from "node:http";
import crypto from "node:crypto";
import { randomUUID } from "crypto";
import { pool } from "../src/db/connection";
import { principalService } from "../src/services/PrincipalService";
import { delegationService } from "../src/services/DelegationService";
import { serviceRegistry } from "../src/services/ServiceRegistry";
import { authorizationRepository } from "../src/services/AuthorizationRepository";
import { taskManagerDB } from "../src/services/TaskManagerDB";
import { syncTaskReadiness } from "../src/utils/taskReadiness";
import { WebhookDeliveryWorker, DEFAULT_DELIVERY_CONFIG } from "../src/services/WebhookDeliveryWorker";

const ACTOR = { principalId: null as string | null, handle: "c2-b1-proof", authMethod: "system" as const };

/**
 * The ASSIGNER: the shape actorFromRequest builds for a root dashboard
 * session on the owner plane (principal null, root scope). R3 caps every
 * materialization at this identity's own effective authority.
 */
const assignerRoot = {
  principalId: null, handle: "c2-b1-assigner", role: "admin",
  scopes: ["root"], authenticated: true, delegation: null,
} as any;
const assignerTaskActor = {
  principalId: null, handle: "c2-b1-assigner", authMethod: "session",
  credentialId: null, authorization: assignerRoot,
} as any;
const verifierTaskActor = { ...assignerTaskActor, role: "reviewer" } as any;

/**
 * The PRODUCTION visibility verdict for a Connector over a Task: resolve the
 * chain the way the auth middleware does, then ask the shared predicate. No
 * synthetic actor anywhere.
 */
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

async function main() {
  const tag = "c2b1-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};

  // The receiving end: one sink path per Connector, so "B got nothing" is a
  // fact about B's own address rather than about a shared inbox.
  const inbox: Record<string, Array<{ headers: any; raw: string }>> = { a: [], b: [] };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const who = String(req.url).endsWith("/b") ? "b" : "a";
      inbox[who].push({ headers: req.headers, raw: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;

  // claimLeaseSeconds 0 only removes the 60s inter-pass lease so a scripted
  // run can take several passes back to back. Every other production
  // parameter is untouched, and the lease is not what B1 was about.
  const worker = new WebhookDeliveryWorker(pool, { ...DEFAULT_DELIVERY_CONFIG, claimLeaseSeconds: 0 });

  try {
    // 1. Fixture: two Connectors, webhook-configured, ungranted.
    const mkConnector = async (suffix: string, secret: string) => {
      const account = (await principalService.createPrincipal({
        handle: tag + "-acct-" + suffix, kind: "service", role: "user",
        purpose: "c2 b1 proof account",
      }))!;
      const svc: any = await serviceRegistry.register(
        { slug: tag + "-conn-" + suffix, name: "C2 B1 conn " + suffix, kind: "connector" }, account.id);
      const row = await pool.query("SELECT principal_id FROM services WHERE id = $1", [svc.id]);
      const connectorId = String(row.rows[0].principal_id);
      // A delegated principal with no live credential is a DEAD chain
      // (AZ-9/AZ-25); registration mints one, so the fixture does too.
      await principalService.issueCredential({ principalId: connectorId, scopes: ["tasks:read"] }, ACTOR);
      // Only a PUBLISHED Connector is delivered to, and publication needs a
      // descriptor first — the real registration sequence.
      const published: any = await serviceRegistry.publishDescriptor(
        svc.id, { options: [] }, svc.revision, account.id);
      const live: any = await serviceRegistry.update(
        svc.id, { status: "published" }, published.service.revision, account.id);
      // Endpoint, mode and signing secret are REGISTRY data (ruling ccd53781
      // R1): no subscription row is created anywhere in this script.
      const configured: any = await serviceRegistry.updateOwnerPlane(svc.id, {
        deliveryMode: "webhook",
        deliveryEndpoint: "http://127.0.0.1:" + port + "/" + suffix,
        deliverySecret: secret,
      }, live.revision, account.id);
      return { accountId: account.id, serviceId: String(svc.id), connectorId, status: configured.status };
    };

    const secretA = crypto.randomBytes(24).toString("hex");
    const secretB = crypto.randomBytes(24).toString("hex");
    const A = await mkConnector("a", secretA);
    const B = await mkConnector("b", secretB);
    out.s1_bothConnectorsPublishedAndWebhookConfigured = A.status === "published" && B.status === "published";

    // CONTROL for everything below: no grant and no profile assignment
    // exists anywhere on either chain. If this is ever false, a doorbell
    // proves nothing about the coupling.
    const chainIds = [A.accountId, A.connectorId, B.accountId, B.connectorId];
    const grantCount = await pool.query(
      "SELECT count(*)::int AS n FROM grants WHERE grantee_id = ANY($1::uuid[])", [chainIds]);
    const profileCount = await pool.query(
      "SELECT count(*)::int AS n FROM access_profile_assignments WHERE assignee_id = ANY($1::uuid[])", [chainIds]);
    out.control1_noGrantOrProfileAssignmentExistsYet =
      grantCount.rows[0].n === 0 && profileCount.rows[0].n === 0;

    // Let the worker take its head-start baseline for both Connectors: a
    // first-seen Connector is seeded at the CURRENT feed head, so an event
    // emitted before that first pass is already behind its cursor. That is
    // the cold-start seed race, filed as hardening 982142c2 — not this
    // script's subject, so it is removed from the measurement rather than
    // measured.
    await worker.runPass();
    const seeded = await pool.query(
      "SELECT count(*)::int AS n FROM connector_delivery_state WHERE service_id = ANY($1::uuid[])",
      [[A.serviceId, B.serviceId]]);
    out.s1_bothConnectorsSeededAtTheFeedHead = seeded.rows[0].n === 2;

    // 2. B1 verbatim: the coupling BYPASSED is still broken.
    const ctlParent = await taskManagerDB.createTask(
      { title: tag + " control parent", status: "todo" } as any, assignerTaskActor,
      // Card 9c177e6a: the target-Project decision is a required parameter of
      // every create. No fixture here names a Project, so the decision this
      // script hands over resolves nothing and is never reached.
      async () => null);
    await taskManagerDB.updateTask(ctlParent.id, { status: "completed" } as any, verifierTaskActor);
    const ctl = await taskManagerDB.createTask(
      { title: tag + " bypassed assignment", status: "todo", autoStart: true, dependsOn: [ctlParent.id] } as any,
      assignerTaskActor, async () => null);

    // Straight to SQL: exactly what the pre-ruling world did, and exactly
    // what review r3 B1 described.
    await pool.query(
      "UPDATE tasks SET execution_service_id = $1, execution_descriptor_version = 1 WHERE id = $2",
      [A.serviceId, ctl.id]);
    out.control2_bypassedAssignmentIsInvisibleToThePredicate =
      (await connectorCanRead(A.connectorId, ctl.id)) === false;

    // Force the announcement the bypassed write never triggered, so the feed
    // genuinely carries a task.ready for this task. The doorbell must STILL
    // not arrive, because the assignee cannot read it.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await syncTaskReadiness(client as any, ctl.id, null);
      await client.query("COMMIT");
    } finally { client.release(); }
    const ctlAnnounced = await pool.query(
      "SELECT count(*)::int AS n FROM feed_events WHERE name = 'task.ready' AND object_id = $1", [ctl.id]);
    out.control2_theFeedDoesCarryTaskReadyForIt = ctlAnnounced.rows[0].n === 1;

    await worker.runPass();
    out.control2_noDoorbellArrivesForTheBypassedAssignment = inbox.a.length === 0 && inbox.b.length === 0;

    // Clean the bypassed row out of the way before the real path runs.
    await pool.query(
      "UPDATE tasks SET execution_service_id = NULL, execution_descriptor_version = NULL WHERE id = $1", [ctl.id]);
    await pool.query("DELETE FROM task_readiness WHERE task_id = $1", [ctl.id]);

    // 3. The coupled assignment.
    const parent = await taskManagerDB.createTask(
      { title: tag + " parent", status: "todo" } as any, assignerTaskActor, async () => null);
    // Created ALREADY ASSIGNED and ARMED, with one UNMET dependency.
    const subject = await taskManagerDB.createTask({
      title: tag + " assigned subject", status: "todo", autoStart: true,
      dependsOn: [parent.id],
      // The assignment field of record, with the descriptor version the
      // 086 mirror CHECK requires beside it (packet c17ebfff D6).
      executionServiceId: A.serviceId, executionDescriptorVersion: 1,
    } as any, assignerTaskActor, async () => null);

    out.s3_theProductionPredicateNowSeesIt = await connectorCanRead(A.connectorId, subject.id);
    out.s3_theTaskIsAssignedThroughTheFieldOfRecord = String(
      (await pool.query("SELECT execution_service_id FROM tasks WHERE id = $1", [subject.id]))
        .rows[0].execution_service_id,
    ) === A.serviceId;

    // The access it gained is the VEHICLE's, provenance-tagged by the server
    // — not something an operator hand-wrote.
    const vehicleGrants = await pool.query(
      "SELECT provenance FROM grants WHERE grantee_id = ANY($1::uuid[])",
      [[A.accountId, A.connectorId]]);
    out.s3_everyGrantOnTheChainIsVehicleProvenanced =
      vehicleGrants.rows.length > 0 && vehicleGrants.rows.every((r: any) => r.provenance !== null);
    out.s3_theVehicleIsLinkedToThisTask = (await pool.query(
      "SELECT count(*)::int AS n FROM access_vehicle_links WHERE task_id = $1", [subject.id])).rows[0].n > 0;

    // CONTROL: readiness is a PREDICATE, not a side effect of assignment.
    // The dependency is unmet, so no doorbell may ring yet.
    await worker.runPass();
    out.control3_anUnmetDependencyRingsNoDoorbell = inbox.a.length === 0;

    // 4. The doorbell.
    await taskManagerDB.updateTask(parent.id, { status: "completed" } as any, verifierTaskActor);
    const readyRows = await pool.query(
      "SELECT count(*)::int AS n FROM feed_events WHERE name = 'task.ready' AND object_id = $1", [subject.id]);
    out.s4_completingTheParentAnnouncedReadiness = readyRows.rows[0].n === 1;

    for (let i = 0; i < 5 && inbox.a.length === 0; i++) await worker.runPass();
    out.s4_theAssignedConnectorReceivedItsDoorbell = inbox.a.length > 0;

    if (inbox.a.length > 0) {
      const { headers, raw } = inbox.a[0];
      const body = JSON.parse(raw);
      out.s4_signedWithTheRegistrySecretOverTheExactBytes =
        headers["x-relayhall-signature"] ===
          "sha256=" + crypto.createHmac("sha256", secretA).update(raw).digest("hex");
      out.s4_itDeclaresTheWorkPlane = headers["x-relayhall-plane"] === "work" && body.plane === "work";
      out.s4_theChannelIsTheConnectorRegistryRow =
        String(headers["x-relayhall-channel-id"]) === A.serviceId && String(body.channelId) === A.serviceId;
      const names = (body.events || []).map((e: any) => e.name);
      out.s4_itCarriesTaskReadyAndNothingElse = names.length > 0 && names.every((n: string) => n === "task.ready");
      out.s4_itIsAboutTheAssignedTask = (body.events || []).some((e: any) => e.objectId === subject.id);
      out.s4_thePayloadIsIdOnly = (body.events || []).every((e: any) =>
        JSON.stringify(Object.keys(e).sort()) ===
        JSON.stringify(["cursor", "name", "objectId", "objectType", "occurredAt"]));
    }

    // CONTROL: B is published, webhook-configured and credentialed exactly
    // like A. The only difference is that nothing is assigned to it.
    out.control4_theUnassignedConnectorReceivedNothing = inbox.b.length === 0;
    out.control4_andCannotReadTheTaskEither = (await connectorCanRead(B.connectorId, subject.id)) === false;

    // 5. R4: unassigning takes the access with it.
    const beforeUnassign = inbox.a.length;
    await taskManagerDB.updateTask(
      subject.id, { executionServiceId: null, executionDescriptorVersion: null } as any, assignerTaskActor);
    out.s5_unassigningRemovesTheVisibility = (await connectorCanRead(A.connectorId, subject.id)) === false;
    out.s5_theVehicleLinkIsReaped = (await pool.query(
      "SELECT count(*)::int AS n FROM access_vehicle_links WHERE task_id = $1", [subject.id])).rows[0].n === 0;

    // CONTROL: the announcement is retracted as well, so the task can ring
    // again for its NEXT assignee rather than staying permanently announced.
    out.control5_theReadinessAnnouncementIsRetracted = (await pool.query(
      "SELECT count(*)::int AS n FROM task_readiness WHERE task_id = $1", [subject.id])).rows[0].n === 0;

    await worker.runPass();
    out.s5_noFurtherDoorbellAfterUnassignment = inbox.a.length === beforeUnassign;

    console.log(JSON.stringify(out, null, 2));
    const failures = Object.entries(out).filter(([, v]) => typeof v === "boolean" && !v);
    if (failures.length > 0) {
      console.error("FAILED:", failures.map(([k]) => k).join(", "));
      process.exitCode = 1;
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
`;

const fs = require('fs');
const tmp = path.join(__dirname, '.c2-b1-delivery-coupling-probe.ts');
fs.writeFileSync(tmp, probe);
const result = spawnSync(path.join(__dirname, '..', 'node_modules', '.bin', 'tsx'), [tmp], {
  stdio: 'inherit',
  env: {
    ...process.env,
    RELAYHALL_CREDENTIAL_KEYS: process.env.RELAYHALL_CREDENTIAL_KEYS
      || JSON.stringify({ livekey: Buffer.alloc(32, 9).toString('base64') }),
    RELAYHALL_CREDENTIAL_ACTIVE_KEY: process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY || 'livekey',
  },
  cwd: path.join(__dirname, '..'),
});
fs.unlinkSync(tmp);
process.exit(result.status ?? 1);
