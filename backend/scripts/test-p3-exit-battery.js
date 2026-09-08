#!/usr/bin/env node
/**
 * test-p3-exit-battery.js — RH-P3.EXIT (card 1da24b37).
 *
 * The Phase-3 exit criteria, drilled. Strategy 4e40f06f Phase 3 states them
 * verbatim below. Each is a numbered section in this file EXCEPT criterion 3,
 * which this file deliberately does not claim to discharge — see the note
 * under the list and §7.
 *
 *   1  a webhook-triggered pickup whose task carries an execution profile
 *      validated against the connector's declared descriptor (an
 *      out-of-descriptor value is rejected at pull);
 *   2  loop-guards demonstrably cap a two-party trigger cycle;
 *   3  a deliberately dropped webhook is recovered by cursor reconciliation
 *      within the configured window;
 *   4  a cursor query by an under-granted principal demonstrably excludes
 *      objects outside its grants;
 *   5  the same pickup path succeeds for a poll-only connector;
 *   6  the pickup path includes an explicit arming act, and an unarmed
 *      control task neither fires `task.ready` nor accepts a claim;
 *   7  an expired lease or a status-stale claimant raises `task.stuck` to the
 *      task's shepherd;
 *   8  the shepherd's one-click meltdown recovery is drilled.
 *
 * ── CRITERION 3 IS NOT DISCHARGED HERE (owner ruling b696c5b4) ──
 *
 * "The configured window" in criterion 3 is the RECEIVER's configured
 * reconciliation schedule — strategy §2.6.2 item 2, the reconciliation
 * doctrine: "the cursor feed is authoritative; webhooks are a latency
 * optimization; every subscriber also reconciles by cursor on a slow schedule
 * (10-15 minutes), so a missed webhook is late work, never lost work." The
 * schedule belongs to the subscriber, which is a satellite in its own
 * repository; core holds no receiver reconciliation cadence to configure or to
 * measure against.
 *
 * Two non-author reviewers held that the board's webhook PUSH retry backoff is
 * not that window (d096ddc4 B4, eab24f63 B4-R2) and the owner ruled with them.
 * §7 below therefore names the backoff as the backoff, states the two
 * cursor-side facts it can actually observe, and claims NOTHING about
 * criterion 3's window. The criterion is discharged by the reconciliation-loop
 * drill in the reference runner (relayhall-runner, C9 lane), reviewed in that
 * repository. Do not re-label anything in §7 as "the configured window": that
 * relabelling is the exact over-claim this file was rejected for twice.
 *
 * ── WHAT THIS SCRIPT DOES AND DELIBERATELY DOES NOT DO ──
 *
 * Items 7 and 8 are already drilled, with controls, by
 * `test-c3-lease-lifecycle.js` (68 checks), and the assignment→doorbell
 * coupling item 1 depends on is drilled by `test-c2-b1-delivery-coupling.js`.
 * Re-implementing them here would be a SECOND proof of the same thing that
 * could drift from the first. This battery therefore COMPOSES those two
 * scripts.
 *
 * COMPOSITION IS ENFORCED BY THIS COMMAND, not by a sentence in this comment.
 * The runner at the bottom SPAWNS both probes before its own and exits
 * non-zero if either does — so `node scripts/test-p3-exit-battery.js` cannot
 * report success while item 7, item 8 or the doorbell coupling is broken.
 * Review d096ddc4 B1 rejected the previous version for claiming exactly this
 * and doing none of it: the header said the battery "runs them and requires
 * them to pass" while its only child process was its own probe. Set
 * `RH_EXIT_SKIP_COMPOSED=1` to run this file's own sections alone while
 * iterating; the canonical command never sets it.
 *
 * Nothing here is a mock. The profile validator is `validateConnectorProfile`;
 * the feed verdicts come from `feedEventService.listSince` off an actor built
 * the way the shared predicate receives one; the claim refusals are
 * `TaskOrchestrationService`; the deliveries are the real
 * `WebhookDeliveryWorker` over real HTTP to a real listener. Runbook
 * `daf703a6` §2 names mocks-of-the-thing as a standing rejection class.
 *
 * EVERY SECTION CARRIES A POSITIVE CONTROL — a step that FAILS THE SCRIPT if
 * the section can no longer detect the thing it exists for. A refusal proves
 * nothing unless the corresponding acceptance is shown beside it.
 *
 * Point DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a DISPOSABLE database
 * already carrying the full ledger (backend/scripts/test-fresh-install-replay.js
 * builds one). Exit 0 = every composed probe, every section and every control
 * passed.
 *
 * THE CANONICAL COMMAND WANTS A FRESH LEDGER, and that is inherited rather
 * than chosen. This file's own sections are re-runnable on a used one — every
 * feed read starts from a cursor captured at the start of the run, so
 * accumulated history cannot push this run's events off the page, and that is
 * proven by running it twice over. The two COMPOSED probes carry the stricter
 * precondition their own headers state, so the composition as a whole does
 * too. Give it a fresh database per run and none of this matters; give it a
 * used one and the composed probes are what will complain.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const probe = `
import http from "http";
import express from "express";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join as pathJoin } from "path";
import { execSync } from "child_process";
import { pool } from "../src/db/connection";
import { principalService } from "../src/services/PrincipalService";
import { serviceRegistry } from "../src/services/ServiceRegistry";
import { taskManagerDB } from "../src/services/TaskManagerDB";
import { feedEventService } from "../src/services/FeedEventService";
import { TaskOrchestrationService } from "../src/services/TaskOrchestrationService";
import { WebhookDeliveryWorker, DEFAULT_DELIVERY_CONFIG } from "../src/services/WebhookDeliveryWorker";
import { validateConnectorProfile, ProfileValidationError } from "../src/utils/executionProfile";
import { syncTaskReadiness } from "../src/utils/taskReadiness";
import { authMiddleware } from "../src/middleware/auth";
import { sharedAuthorizationMiddleware } from "../src/middleware/sharedAuthorization";
import tasksRoutes from "../src/routes/tasks";
import eventsRoutes from "../src/routes/events";

const ACTOR = { principalId: null as string | null, handle: "p3-exit-battery", authMethod: "system" as const };

/** The shape actorFromRequest builds for a root owner-plane session. */
const rootAuthorization = {
  principalId: null, handle: "p3-exit-assigner", role: "admin",
  scopes: ["root"], authenticated: true, delegation: null,
} as any;
const assignerActor = {
  principalId: null, handle: "p3-exit-assigner", authMethod: "session",
  credentialId: null, authorization: rootAuthorization,
} as any;

/** The actor shape feedEventService.listSince receives from the predicate. */
function feedActor(principalId: string, role: string) {
  return {
    principalId, handle: "", role, scopes: null, authenticated: true, delegation: null,
  } as any;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "NO_ERROR"; }
  catch (err: any) { return String(err?.code ?? err?.message ?? err); }
}

async function scalar(sql: string, params: unknown[]): Promise<any> {
  const result = await pool.query(sql, params);
  return result.rows[0] ? Object.values(result.rows[0])[0] : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every objectId the listener has actually been delivered. The payload is
 * ID-only and BATCHED - {channelId, events:[{cursor,name,objectId,...}]} -
 * so reading r.body.objectId finds nothing and every assertion built on it
 * passes vacuously. The battery's own control caught exactly that. */
function deliveredIds(received: Array<{ path: string; body: any }>): string[] {
  return received.flatMap((r) => ((r.body?.events ?? []) as any[]).map((e) => String(e.objectId)));
}

async function main() {
  const tag = "p3x-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};

  // A real listener. Each request is recorded; \`drop\` makes the endpoint fail
  // so section 3 has a genuinely undelivered event to reconcile.
  const received: Array<{ path: string; body: any }> = [];
  let drop = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (drop) { res.writeHead(500); res.end("dropped"); return; }
      try { received.push({ path: String(req.url), body: JSON.parse(raw) }); }
      catch { received.push({ path: String(req.url), body: raw }); }
      res.writeHead(200); res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  // THE REAL REQUEST PATH. Sections 2 and 5 drive these routes over real HTTP
  // with a real rh_ credential, through the real authMiddleware and the real
  // shared authorization ceiling — the same stack server.ts mounts, assembled
  // by the same registry contract. A source grep is not behavioural evidence
  // that a route is reachable and refuses before persisting (d096ddc4 B3), and
  // a hand-built actor object is not evidence that a Connector can clear the
  // feed route ceiling (B2).
  const api = express();
  api.use(express.json());
  api.use("/tasks", authMiddleware, sharedAuthorizationMiddleware, tasksRoutes);
  api.use("/events", authMiddleware, sharedAuthorizationMiddleware, eventsRoutes);
  const apiServer = http.createServer(api);
  await new Promise<void>((r) => apiServer.listen(0, "127.0.0.1", r));
  const apiPort = (apiServer.address() as any).port;

  const call = async (method: string, route: string, key: string, body?: unknown) => {
    const response = await fetch("http://127.0.0.1:" + apiPort + route, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: response.status, body: parsed, text };
  };

  const orchestration = new TaskOrchestrationService(pool, {
    enabled: true, maxActiveGlobal: 50, maxActivePerProject: 50, leaseTtlSeconds: 900,
  });
  // claimLeaseSeconds 0 only removes the 60s inter-pass lease so a scripted
  // run can take several passes back to back (the C2 probe's precedent).
  // Every other production parameter is untouched here.
  const worker = new WebhookDeliveryWorker(pool, { ...DEFAULT_DELIVERY_CONFIG, claimLeaseSeconds: 0 });

  try {
    // ══ 1. FIXTURE ═════════════════════════════════════════════════════════
    const projectId = randomUUID();
    await pool.query("INSERT INTO projects (id, name, description) VALUES ($1, $2, '')",
      [projectId, tag + "-project"]);

    /** A published Connector with a live credential and registry delivery. */
    const mkConnector = async (suffix: string, mode: string, options: any[] = []) => {
      const account = (await principalService.createPrincipal({
        handle: tag + "-acct-" + suffix, kind: "service", role: "user",
        purpose: "P3 exit battery",
      }))!;
      const svc: any = await serviceRegistry.register(
        { slug: tag + "-conn-" + suffix, name: "P3X conn " + suffix, kind: "connector" }, account.id);
      const row = await pool.query("SELECT principal_id FROM services WHERE id = $1", [svc.id]);
      const connectorId = String(row.rows[0].principal_id);
      // The FULL key is kept: sections 2 and 5 drive real HTTP as this
      // Connector, through the real middleware, rather than hand-building an
      // actor object (review d096ddc4 B2/B3).
      const issued = await principalService.issueCredential(
        { principalId: connectorId, scopes: ["tasks:read", "tasks:write", "services:read", "services:invoke"] }, ACTOR);
      const published: any = await serviceRegistry.publishDescriptor(
        svc.id, { options }, svc.revision, account.id);
      const live: any = await serviceRegistry.update(
        svc.id, { status: "published" }, published.service.revision, account.id);
      const configured: any = await serviceRegistry.updateOwnerPlane(svc.id, {
        deliveryMode: mode,
        ...(mode === "webhook"
          ? { deliveryEndpoint: "http://127.0.0.1:" + port + "/" + suffix, deliverySecret: tag + "-secret-" + suffix }
          : { deliveryPollIntervalSeconds: 30 }),
      }, live.revision, account.id);
      return {
        accountId: account.id, serviceId: String(svc.id), connectorId,
        status: configured.status, key: issued.fullKey,
      };
    };

    // A DECLARED descriptor: one enumerated option with two permitted values.
    // Section 2 is about what happens to a value OUTSIDE that enumeration.
    const DECLARED_OPTIONS = [
      { key: "profile", label: "Profile", type: "enum",
        values: [{ value: "fast" }, { value: "thorough" }], required: false },
    ];
    const W = await mkConnector("webhook", "webhook", DECLARED_OPTIONS);
    const P = await mkConnector("poll", "poll", DECLARED_OPTIONS);

    // The delivery worker seeds a Connector's cursor at the CURRENT feed head
    // on first sight. Seed BOTH now, before any measured event exists, or
    // every later delivery assertion measures a cursor that is already past
    // the event it is looking for (the C2 probe's precedent).
    await worker.runPass();
    out.s1_bothConnectorsSeededAtTheFeedHead = (await scalar(
      "SELECT count(*)::int FROM connector_delivery_state WHERE service_id = ANY($1::uuid[])",
      [[W.serviceId, P.serviceId]])) === 2;

    // THIS RUN'S OWN STARTING POINT. Every feed read below begins here rather
    // than at cursor 0: a database that has carried earlier runs has more than
    // one page of history, and a read from 0 would return that history instead
    // of this run's events. The battery's own composition red proof caught it -
    // two sections went red on the fourth consecutive run against one ledger.
    const runStartCursor = String(await scalar(
      "SELECT COALESCE(MAX(cursor), 0) FROM feed_events", []) ?? "0");

    out.s1_bothConnectorsArePublished = W.status === "published" && P.status === "published";
    out.s1_theWebhookConnectorIsInWebhookMode =
      (await scalar("SELECT delivery_mode FROM services WHERE id = $1", [W.serviceId])) === "webhook";
    out.s1_thePollConnectorIsInPollMode =
      (await scalar("SELECT delivery_mode FROM services WHERE id = $1", [P.serviceId])) === "poll";
    // CONTROL: the descriptor really declares the enumeration the next
    // section measures against, so an "out-of-descriptor" value is out of
    // something rather than out of nothing.
    const declared = await scalar(
      "SELECT descriptor FROM service_descriptor_versions WHERE service_id = $1 ORDER BY version DESC LIMIT 1",
      [W.serviceId]);
    out.control1_theDescriptorDeclaresTheEnumeration =
      JSON.stringify(declared ?? []).includes("thorough");

    /** A Task in the project. \`armed\` is the explicit arming act. */
    const mkTask = async (title: string, armed: boolean) => {
      const id = randomUUID();
      await pool.query(
        \`INSERT INTO tasks (id, title, description, status, priority, visibility, project_id, auto_start)
         VALUES ($1,$2,'','todo','normal','private',$3,$4)\`,
        [id, tag + "-" + title, projectId, armed]);
      return id;
    };

    // ══ 2. EXIT ITEM 1 · DESCRIPTOR-VALIDATED PICKUP ═══════════════════════
    // "an execution profile validated against the connector's declared
    // descriptor (an out-of-descriptor value is rejected at pull)".
    const inDescriptor = await validateConnectorProfile({
      serviceId: W.serviceId, options: { profile: "thorough" },
    });
    out.s2_anInDescriptorProfileValidates =
      inDescriptor.serviceId === W.serviceId && (inDescriptor.options as any).profile === "thorough";
    out.s2_theDescriptorVersionIsPinnedOntoTheProfile =
      Number(inDescriptor.descriptorVersion) >= 1;

    // The out-of-descriptor value: a key the descriptor declares, carrying a
    // value the descriptor does not enumerate.
    out.s2_anOutOfDescriptorVALUEisRejected = (await codeOf(validateConnectorProfile({
      serviceId: W.serviceId, options: { profile: "reckless" },
    }))) !== "NO_ERROR";
    // ...and a key the descriptor never declared at all.
    out.s2_anUndeclaredOPTIONkeyIsRejected = (await codeOf(validateConnectorProfile({
      serviceId: W.serviceId, options: { nosuchoption: "x" },
    }))) !== "NO_ERROR";

    // THROUGH THE REAL REQUEST PATH (review d096ddc4 B3). A source grep is not
    // behavioural evidence that a route is reachable and refuses BEFORE
    // persisting: a dead call site leaves a text assertion green. So the
    // hostile profile and the permitted one both go through POST /tasks, over
    // HTTP, with a real rh_ credential, through the real middleware.
    const hostile = await call("POST", "/tasks", W.key, {
      title: tag + "-route-hostile", status: "todo",
      executionProfile: { serviceId: W.serviceId, options: { profile: "reckless" } },
    });
    out.s2_theRouteRefusesAnOutOfDescriptorValue = hostile.status >= 400;
    // ...and refuses BEFORE persisting. A refusal that stored the row first
    // would be a different, worse thing.
    out.s2_theRefusedTaskWasNotStored =
      (await scalar("SELECT count(*)::int FROM tasks WHERE title = $1", [tag + "-route-hostile"])) === 0;

    const undeclared = await call("POST", "/tasks", W.key, {
      title: tag + "-route-undeclared", status: "todo",
      executionProfile: { serviceId: W.serviceId, options: { nosuchoption: "x" } },
    });
    out.s2_theRouteRefusesAnUndeclaredOptionKey = undeclared.status >= 400;

    // CONTROL: the permitted value goes through the SAME route and IS stored
    // with the descriptor version pinned — so the refusals above are verdicts
    // about the value and not a route that refuses everything.
    const accepted = await call("POST", "/tasks", W.key, {
      title: tag + "-route-accepted", status: "todo", autoStart: true,
      executionProfile: { serviceId: W.serviceId, options: { profile: "thorough" } },
    });
    out.control2_theRouteAcceptsAnInDescriptorValue = accepted.status < 400;
    const profileTask = String(await scalar(
      "SELECT id FROM tasks WHERE title = $1", [tag + "-route-accepted"]) ?? "");
    out.control2_theAcceptedTaskCarriesTheServiceAndAPinnedDescriptor =
      String(await scalar("SELECT execution_service_id FROM tasks WHERE id = $1", [profileTask])) === W.serviceId
      && Number(await scalar("SELECT execution_descriptor_version FROM tasks WHERE id = $1", [profileTask])) >= 1;

    // ...and the accepted Task is then carried through the PICKUP itself: it
    // becomes ready, its assignee is pushed its doorbell, and the assignee
    // claims it. That is the whole of exit item 1 in one joined path.
    await syncTaskReadiness(pool, profileTask);
    received.length = 0;
    await worker.runPass();
    out.s2_theAcceptedTaskRingsItsAssigneeDoorbell =
      deliveredIds(received).includes(profileTask);
    out.s2_andTheAssigneeClaimsIt = (await codeOf(orchestration.claimReadyTask({
      taskId: profileTask,
      snapshotUpdatedAt: new Date(await scalar("SELECT updated_at FROM tasks WHERE id = $1", [profileTask])).toISOString(),
      harness: "hermes" as const, resourceKey: tag + ":pickup",
      claimantPrincipalId: W.connectorId,
    }))) === "NO_ERROR";

    // ══ 3. EXIT ITEM 6 · ARMING ════════════════════════════════════════════
    // "the pickup path includes an explicit arming act, and an unarmed
    // control task neither fires task.ready nor accepts a claim".
    const armedTask = await mkTask("armed", true);
    const unarmedTask = await mkTask("unarmed", false);
    for (const id of [armedTask, unarmedTask]) {
      await taskManagerDB.updateTask(id, {
        executionProfile: { serviceId: W.serviceId, options: {} },
        executionServiceId: W.serviceId, executionDescriptorVersion: 1,
      } as any, assignerActor);
      await syncTaskReadiness(pool, id);
    }
    const readyNamesFor = async (taskId: string) => (await pool.query(
      "SELECT name FROM feed_events WHERE object_id = $1 AND name = 'task.ready'", [taskId])).rows.length;

    out.s3_theARMEDtaskFiredTaskReady = (await readyNamesFor(armedTask)) > 0;
    out.s3_theUNARMEDtaskFiredNoTaskReady = (await readyNamesFor(unarmedTask)) === 0;

    const claimOf = async (taskId: string) => codeOf(orchestration.claimReadyTask({
      taskId,
      snapshotUpdatedAt: new Date(await scalar("SELECT updated_at FROM tasks WHERE id = $1", [taskId])).toISOString(),
      harness: "hermes" as const, resourceKey: tag + ":arming",
      claimantPrincipalId: W.connectorId,
    }));
    // AUTO_START_DISABLED is the orchestration refusal; TASK_NOT_ARMED is
    // the HTTP mapping the route puts on it (routes/tasks.ts). This drives the
    // service, so it measures the service's code.
    out.s3_theUNARMEDtaskRefusesTheClaim = (await claimOf(unarmedTask)) === "AUTO_START_DISABLED";
    // CONTROL: the armed twin — identical in every other respect — accepts
    // the same claim, so the refusal is the arming gate and not the fixture.
    out.control3_theARMEDtwinAcceptsTheSameClaim = (await claimOf(armedTask)) === "NO_ERROR";

    // ══ 4. EXIT ITEM 4 · UNDER-GRANTED CURSOR EXCLUSION ════════════════════
    // "a cursor query by an under-granted principal demonstrably excludes
    // objects outside its grants".
    const outsider = (await principalService.createPrincipal({
      handle: tag + "-outsider", kind: "human", role: "user", purpose: "P3 exit under-granted control",
    }))!;
    // ASSIGNED, so it genuinely emits a task.ready. Unassigned, it emits
    // nothing at all (readiness requires assignment), and "the outsider does
    // not see it" would have been true of an event that never existed - which
    // is precisely what control4 caught on the previous run.
    const privateTask = await mkTask("private", true);
    await taskManagerDB.updateTask(privateTask, {
      executionProfile: { serviceId: W.serviceId, options: {} },
      executionServiceId: W.serviceId, executionDescriptorVersion: 1,
    } as any, assignerActor);
    await syncTaskReadiness(pool, privateTask);
    out.control4_thePrivateTaskGenuinelyEmittedAnEvent =
      (await scalar("SELECT count(*)::int FROM feed_events WHERE object_id = $1", [privateTask])) > 0;

    const cursorBefore = runStartCursor;
    const outsiderPage = await feedEventService.listSince(feedActor(outsider.id, "user"), cursorBefore, 500);
    // The blanket arm of listSince asks the shared predicate whether this
    // actor may read tasks at all. rootAuthorization is the shape
    // actorFromRequest builds for a root owner-plane session — the same one
    // the assigner uses above — so the control reader is a real granted
    // reader rather than a hand-made object.
    const rootPage = await feedEventService.listSince(rootAuthorization, cursorBefore, 500);
    const sees = (page: any, taskId: string) =>
      page.events.some((e: any) => String(e.objectId) === taskId);

    out.s4_theUnderGrantedPrincipalDoesNotSeeThePrivateTask = !sees(outsiderPage, privateTask);
    out.s4_itDoesNotSeeTheOtherPrivateTasksEither =
      !sees(outsiderPage, armedTask) && !sees(outsiderPage, profileTask);
    // CONTROL: the events ARE in the feed and ARE reachable — a granted
    // reader sees them at the same cursor. Otherwise "excluded" would be
    // indistinguishable from "never emitted".
    out.control4_aGrantedReaderSeesThemAtTheSameCursor =
      sees(rootPage, privateTask) && sees(rootPage, armedTask);
    (out as any).DIAG_rootPageEventCount = rootPage.events.length;
    (out as any).DIAG_outsiderPageEventCount = outsiderPage.events.length;
    out.control4_theFeedReallyAdvanced = Number(rootPage.nextCursor) > 0;

    // ══ 5. EXIT ITEM 5 · POLL-ONLY PICKUP ══════════════════════════════════
    // "the same pickup path succeeds for a poll-only connector".
    const pollTask = await mkTask("poll", true);
    await taskManagerDB.updateTask(pollTask, {
      executionProfile: { serviceId: P.serviceId, options: {} },
      executionServiceId: P.serviceId, executionDescriptorVersion: 1,
    } as any, assignerActor);
    await syncTaskReadiness(pool, pollTask);

    const cursorOf = async (serviceId: string) => String(await scalar(
      "SELECT delivery_cursor FROM connector_delivery_state WHERE service_id = $1", [serviceId]) ?? "0");
    const pollCursorBefore = await cursorOf(P.serviceId);
    const webhookCursorBefore = await cursorOf(W.serviceId);
    received.length = 0;
    await worker.runPass();
    out.s5_thePollConnectorIsNotPushedTo =
      !received.some((r) => r.path.includes("poll"));
    // Behaviour, not a reason string: across a pass in which the WEBHOOK
    // connector's cursor advances, the POLL connector's does not move. It is
    // not pushed to, and its position is held so that flipping the registry
    // back to webhook resumes from where the subscription actually stood.
    out.s5_thePollConnectorsCursorDidNotMoveWhileTheWebhookOnesDid =
      String(pollCursorBefore) === String(await scalar(
        "SELECT delivery_cursor FROM connector_delivery_state WHERE service_id = $1", [P.serviceId]))
      && String(webhookCursorBefore) !== String(await scalar(
        "SELECT delivery_cursor FROM connector_delivery_state WHERE service_id = $1", [W.serviceId]));

    // The pickup itself: the poll-only Connector PULLS the feed with its own
    // identity and claims what it finds. Same path, no push.
    // ITS OWN IDENTITY, through the real cursor route (review d096ddc4 B2).
    // The previous version read the feed as ROOT and called that the poll
    // Connector's pickup - which stayed green even if the Connector could not
    // clear the route ceiling or could not see its own Task.
    const pollFeed = await call("GET", "/events?cursor=" + runStartCursor + "&limit=500", P.key);
    out.s5_thePollConnectorClearsTheFeedRouteCeiling = pollFeed.status === 200;
    out.s5_thePollConnectorFindsItsTaskOnTheFeed =
      ((pollFeed.body?.events ?? []) as any[]).some((e) => String(e.objectId) === pollTask);
    // CONTROL: a Connector with NO authority over that Task pulls the same
    // route at the same cursor and does not see it - so "found it" above is
    // this Connector's own authorization and not a feed that shows everyone
    // everything.
    const strangerFeed = await call("GET", "/events?cursor=" + runStartCursor + "&limit=500", W.key);
    out.control5_aConnectorWithoutAuthorityDoesNotSeeIt =
      strangerFeed.status === 200
      && !((strangerFeed.body?.events ?? []) as any[]).some((e) => String(e.objectId) === pollTask);
    out.s5_thePollOnlyPickupSucceeds = (await codeOf(orchestration.claimReadyTask({
      taskId: pollTask,
      snapshotUpdatedAt: new Date(await scalar("SELECT updated_at FROM tasks WHERE id = $1", [pollTask])).toISOString(),
      harness: "hermes" as const, resourceKey: tag + ":poll-worker",
      claimantPrincipalId: P.connectorId,
    }))) === "NO_ERROR";
    // CONTROL: the WEBHOOK connector in the same pass WAS pushed to, so
    // "not pushed" above is the poll mode and not a dead worker.
    out.control5_theWebhookConnectorWasPushedToInTheSamePass =
      received.some((r) => r.path.includes("webhook"));

    // ══ 6. EXIT ITEM 2 · LOOP GUARDS CAP A TWO-PARTY CYCLE ═════════════════
    // "loop-guards demonstrably cap a two-party trigger cycle".
    //
    // The production guard is a per-subscriber budget over a window
    // (rateLimitPerWindow POSTs, rateLimitEventsPerWindow events). It is
    // exercised here with a SMALL budget rather than a mock: the same code
    // path, the same table, a bound a scripted run can reach.
    const cappedWorker = new WebhookDeliveryWorker(pool, {
      ...DEFAULT_DELIVERY_CONFIG, claimLeaseSeconds: 0,
      rateLimitPerWindow: 1, rateLimitEventsPerWindow: 4,
    });
    await pool.query("DELETE FROM webhook_delivery_rate");
    await pool.query("UPDATE connector_delivery_state SET next_attempt_at = NOW(), last_delivery_error = NULL");

    const mkCycleTask = async (label: string) => {
      const id = await mkTask(label, true);
      await taskManagerDB.updateTask(id, {
        executionProfile: { serviceId: W.serviceId, options: {} },
        executionServiceId: W.serviceId, executionDescriptorVersion: 1,
      } as any, assignerActor);
      await syncTaskReadiness(pool, id);
      return id;
    };

    // WAVE ONE spends the window's budget.
    const wave1: string[] = [];
    for (let i = 0; i < 2; i += 1) wave1.push(await mkCycleTask("cycle1-" + i));
    received.length = 0;
    await cappedWorker.runPass();
    out.s6_theFirstWaveIsDelivered = wave1.every((id) => deliveredIds(received).includes(id));

    // WAVE TWO is what a two-party cycle produces: more work, arriving while
    // the window is still full. THIS is the traffic the guard exists to cap.
    const wave2: string[] = [];
    for (let i = 0; i < 3; i += 1) wave2.push(await mkCycleTask("cycle2-" + i));
    received.length = 0;
    let observedDeferral = false;
    for (let pass = 0; pass < 3; pass += 1) {
      await cappedWorker.runPass();
      const next = await scalar(
        "SELECT next_attempt_at FROM connector_delivery_state WHERE service_id = $1", [W.serviceId]);
      if (next && new Date(next).getTime() > Date.now() + 1000) observedDeferral = true;
    }
    const cappedDeliveries = deliveredIds(received).filter((id) => wave2.includes(id)).length;
    out.s6_theSecondWaveIsCappedInsideTheSameWindow = cappedDeliveries === 0;
    out.s6_theChannelWasDeferredWhileTheWindowWasFull = observedDeferral;
    out.s6_theCapIsRecordedAsTheReason =
      String(await scalar(
        "SELECT last_delivery_error FROM connector_delivery_state WHERE service_id = $1", [W.serviceId]) ?? "")
        === "RATE_LIMITED";
    const budget = await pool.query(
      "SELECT deliveries, events FROM webhook_delivery_rate").then((r) => r.rows);
    // The guard's own bookkeeping shows the window consumed. Asserted as
    // "some subscriber's window records a delivery" rather than "exactly one
    // row": how many principals happen to have a row is not what the cap is
    // about, and pinning it would break on an unrelated fixture.
    out.s6_theBudgetShowsTheWindowConsumed =
      budget.some((r: any) => Number(r.deliveries) >= 1);

    // CONTROL: the cap is a bound, not a breakage. Clear the window and the
    // SAME second wave flows — so "nothing arrived" above was the guard and
    // not a dead worker or an empty queue.
    await pool.query("DELETE FROM webhook_delivery_rate");
    await pool.query("UPDATE connector_delivery_state SET next_attempt_at = NOW(), last_delivery_error = NULL");
    received.length = 0;
    for (let pass = 0; pass < 3; pass += 1) await worker.runPass();
    const flowed = deliveredIds(received);
    out.control6_theSameSecondWaveFlowsOnceTheWindowClears =
      wave2.every((id) => flowed.includes(id));

    // ══ 7. DROPPED DELIVERY — WHAT CORE CAN OBSERVE (NOT exit item 3) ══════
    //
    // Exit criterion 3 reads "a deliberately dropped webhook is recovered by
    // cursor reconciliation within the configured window". Owner ruling
    // b696c5b4 (reading 1a) settled what "the configured window" names: the
    // RECEIVER's configured reconciliation schedule, per strategy §2.6.2. That
    // schedule lives in the subscriber, not in core, so THIS SECTION DOES NOT
    // DISCHARGE CRITERION 3 and must not be read as doing so. The
    // reconciliation-loop drill in relayhall-runner discharges it.
    //
    // What core can honestly observe about a dropped push, and what this
    // section asserts, is exactly three things:
    //   (i)  the delivery cursor does NOT advance past an undelivered event —
    //        the precondition that makes any later reconciliation possible;
    //   (ii) pull recovery is available immediately, under the subscriber's
    //        OWN rh_ credential through the real middleware, not only to root;
    //   (iii) the board resumes PUSH after its own push-failure backoff —
    //        named as the backoff it is, bounded by the production config, and
    //        shown not to fire before that bound elapses.
    const droppedTask = await mkTask("dropped", true);
    await taskManagerDB.updateTask(droppedTask, {
      executionProfile: { serviceId: W.serviceId, options: {} },
      executionServiceId: W.serviceId, executionDescriptorVersion: 1,
    } as any, assignerActor);
    await syncTaskReadiness(pool, droppedTask);

    const cursorBeforeDrop = String(await scalar(
      "SELECT delivery_cursor FROM connector_delivery_state WHERE service_id = $1", [W.serviceId]) ?? "0");
    received.length = 0;
    drop = true;
    await pool.query("DELETE FROM webhook_delivery_rate");
    await pool.query("UPDATE connector_delivery_state SET next_attempt_at = NOW()");
    await worker.runPass();
    drop = false;
    out.s7_theDeliveryWasGenuinelyDropped = !deliveredIds(received).includes(droppedTask);
    const cursorAfterDrop = String(await scalar(
      "SELECT delivery_cursor FROM connector_delivery_state WHERE service_id = $1", [W.serviceId]) ?? "0");
    // The cursor MUST NOT have advanced past an undelivered event: that is
    // what makes reconciliation possible at all.
    out.s7_theCursorDidNotAdvancePastTheUndeliveredEvent =
      cursorAfterDrop === cursorBeforeDrop;

    // (iii) THE PUSH-FAILURE BACKOFF, NAMED AS THE BACKOFF. This is the board's
    // retry schedule on the PUSH path — backoffBaseSeconds * 2^(failures-1),
    // capped at backoffMaxSeconds — read from the production config rather
    // than asserted. It bounds when the board re-pushes to an endpoint that
    // failed. It is NOT the criterion's reconciliation window (ruling
    // b696c5b4), and nothing below calls it one.
    const pushBackoffBoundSeconds = DEFAULT_DELIVERY_CONFIG.backoffBaseSeconds;
    const deferredUntil = new Date(await scalar(
      "SELECT next_attempt_at FROM connector_delivery_state WHERE service_id = $1", [W.serviceId]));
    const deferralSeconds = (deferredUntil.getTime() - Date.now()) / 1000;
    out.s7_theDropDeferredThePushChannelByTheConfiguredPushBackoff =
      deferralSeconds > 0 && deferralSeconds <= pushBackoffBoundSeconds + 2;

    // The backoff is a real bound in both directions: BEFORE it elapses the
    // board does not re-push. Without this half, "resumes after its backoff"
    // would be an unbounded claim dressed up as a bound.
    received.length = 0;
    await worker.runPass();
    out.s7_nothingIsPushedBEFOREthePushBackoffElapses =
      !deliveredIds(received).includes(droppedTask);

    // (ii) PULL RECOVERY IS AVAILABLE, under the subscriber's OWN rh_
    // credential over real HTTP through the real middleware — not only to
    // root. This is availability of the pull path, at one point in time. It is
    // NOT a measurement of any reconciliation schedule, because core has none:
    // no cadence is configured here, none is elapsed, and nothing here would
    // go red if a subscriber never reconciled at all. That is precisely what
    // the runner drill exists to measure.
    const reconciled = await call("GET", "/events?cursor=" + cursorAfterDrop + "&limit=500", W.key);
    out.s7_theDroppedEventIsAvailableByPullingFromTheCursorAsTheSubscriber =
      ((reconciled.body?.events ?? []) as any[])
        .some((e) => String(e.objectId) === droppedTask && e.name === "task.ready");

    // (iii, second half) the board resumes PUSH once its backoff has elapsed.
    // The clock is advanced by expiring the deferral rather than by sleeping
    // for it: the assertion is about the bound, not about wall time.
    await pool.query(
      "UPDATE connector_delivery_state SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE service_id = $1",
      [W.serviceId]);
    received.length = 0;
    for (let pass = 0; pass < 3; pass += 1) await worker.runPass();
    out.s7_theBoardResumesPushAfterItsPushBackoff =
      deliveredIds(received).includes(droppedTask);
    // CONTROL: the drop was the ENDPOINT, not an absent event - the same
    // event arrives by push once the endpoint is healthy and the backoff has
    // elapsed, which the assertion above already observes. Recorded
    // separately so a future edit that removes the resumption assertion does
    // not silently remove the control with it.
    out.control7_theEventExistedAllAlong =
      (await scalar(
        "SELECT count(*)::int FROM feed_events WHERE object_id = $1 AND name = 'task.ready'",
        [droppedTask])) > 0;

    // ── verdict ────────────────────────────────────────────────────────────
    const failed = Object.entries(out).filter(([k, v]) => !k.startsWith("DIAG_") && v !== true);
    console.log(JSON.stringify(out, null, 2));
    const asserted = Object.keys(out).filter((k) => !k.startsWith("DIAG_"));
    console.log("checks=" + asserted.length + " passed=" + (asserted.length - failed.length));
    if (failed.length > 0) {
      console.error("FAILED: " + failed.map(([k]) => k).join(", "));
      process.exitCode = 1;
    }
  } finally {
    server.close();
    apiServer.close();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
`;

// ── the composed probes, run FIRST and required to pass ────────────────────
const COMPOSED = [
  { script: 'test-c3-lease-lifecycle.js', covers: 'exit items 7 and 8 (task.stuck by both reasons; meltdown recovery)' },
  { script: 'test-c2-b1-delivery-coupling.js', covers: 'the assignment-to-doorbell coupling exit item 1 depends on' },
];

if (process.env.RH_EXIT_SKIP_COMPOSED !== '1') {
  for (const { script, covers } of COMPOSED) {
    process.stdout.write(`\n=== composed: ${script} — ${covers} ===\n`);
    const composed = spawnSync(process.execPath, [path.join(__dirname, script)], {
      stdio: 'inherit', env: process.env, cwd: path.join(__dirname, '..'),
    });
    if (composed.status !== 0) {
      process.stderr.write(
        `\nP3 EXIT BATTERY FAILED: composed probe ${script} exited ${composed.status}.\n`
        + `It covers ${covers}, so this battery cannot report the exit criteria as met.\n`);
      process.exit(composed.status ?? 1);
    }
  }
  process.stdout.write('\n=== both composed probes passed; running this battery own sections ===\n');
}

const tmp = path.join(__dirname, '.p3-exit-battery-probe.ts');
fs.writeFileSync(tmp, probe);
const result = spawnSync(path.join(__dirname, '..', 'node_modules', '.bin', 'tsx'), [tmp], {
  stdio: 'inherit',
  env: {
    ...process.env,
    RELAYHALL_CREDENTIAL_KEYS: process.env.RELAYHALL_CREDENTIAL_KEYS
      || JSON.stringify({ livekey: Buffer.alloc(32, 9).toString('base64') }),
    RELAYHALL_CREDENTIAL_ACTIVE_KEY: process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY || 'livekey',
    TASK_NOTIFICATIONS_FILE: process.env.TASK_NOTIFICATIONS_FILE
      || path.join(require('os').tmpdir(), 'p3-exit-notifications.json'),
  },
  cwd: path.join(__dirname, '..'),
});
fs.unlinkSync(tmp);
process.exit(result.status ?? 1);
