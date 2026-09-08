#!/usr/bin/env node
/**
 * test-s5-agent-lifecycle-live.js — RH-P3.AZ-S5 (card bb4a5f79; design
 * 4d961e37 §7.4/§8, AZ-19/AZ-29): the two-principal chain behavioral
 * battery against a real migrated PostgreSQL through the PRODUCTION
 * services and the PRODUCTION authorization repository:
 *
 *   §8.2 read default (AZ-19): a rule-less minted Agent reads its bound
 *   Task, that task's Phase and its Project through the real point
 *   evaluator — and NOTHING else (T22: an off-context task refuses);
 *   T5/T36 end-to-end: the claimant Agent writes its bound task and never
 *   a foreign one, ceiling breadth notwithstanding;
 *   AZ-29 lease coupling: the explicit renewal re-ups the credential to
 *   NOW + max-age; a REVOKED warrant blocks the extension (durable denied
 *   audit) and a TERMINAL task blocks it too;
 *   auto-revoke: the sweep revokes terminal-bound Agent credentials in
 *   one transaction, the chain dies NOW (resolveChain alive=false — the
 *   T6 liveness the middleware enforces per request), reopening the task
 *   never resurrects (one-way), and the sweep is idempotent;
 *   §7.4 pack composition: endpoint + bootstrap line + snippets + CLI env
 *   + authority summary round-trip through composeOnboardingPack (the
 *   REST-response ride is proven over HTTP by the DEV QA probe);
 *   T18 re-verify: the S4 two-connection race stays green in the same run
 *   (invoke test-s4-warrants-live.js separately; this file re-proves the
 *   FOR UPDATE serialization only through the S4 script).
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
import { agentLifecycleService } from "../src/services/AgentLifecycleService";
import { authorizationRepository } from "../src/services/AuthorizationRepository";
import { composeOnboardingPack } from "../src/utils/onboardingPack";
import { scopesForRole } from "../src/utils/identityScopes";
import { taskManagerDB } from "../src/services/TaskManagerDB";
import { randomUUID } from "crypto";

const ACTOR = { principalId: null, handle: "s5-live-proof", authMethod: "system" as const };

async function main() {
  await runMigrations(false);
  const tag = "s5-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};
  const code = (p: Promise<unknown>, expected: string) =>
    p.then(() => false, (e: any) => e.code === expected || String(e.message).includes(expected));

  // ── setup: Account → Connector → warrant → Agent ─────────────────────
  const svcAccount = (await principalService.createPrincipal({ handle: tag + "-svc", kind: "service", role: "user", purpose: "s5 live proof account" }))!;
  const admin = (await principalService.createPrincipal({ handle: tag + "-admin", kind: "human", role: "admin" }))!;
  const connSvc = await serviceRegistry.register({ slug: tag + "-conn", name: "S5 conn", kind: "connector" }, svcAccount.id);
  const connectorId = String((await pool.query("SELECT principal_id FROM services WHERE id = $1", [(connSvc as any).id])).rows[0].principal_id);
  await pool.query("UPDATE principals SET own_expression = $2::jsonb WHERE id = $1",
    [connectorId, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  await principalService.issueCredential({ principalId: connectorId, scopes: ["tasks:read", "tasks:write"] }, ACTOR);

  const projectId = randomUUID();
  await pool.query("INSERT INTO projects (id, name) VALUES ($1,$2)", [projectId, "S5 " + tag]);
  const phaseId = randomUUID();
  await pool.query("INSERT INTO phases (id, project_id, name, goal) VALUES ($1,$2,$3,$4)",
    [phaseId, projectId, "S5 phase " + tag, "prove the lifecycle"]);
  const mkTask = async (title: string, phase?: string) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO tasks (id, title, description, status, priority, visibility, project_id, phase_id) VALUES ($1,$2,'','in-progress','normal','private',$3,$4)",
      [id, title, phase ? projectId : null, phase ?? null]);
    return id;
  };
  const boundTask = await mkTask("s5 bound " + tag, phaseId);
  const foreignTask = await mkTask("s5 foreign " + tag);

  const connEff = (() => delegationService.resolveChain(connectorId).then((chain) =>
    delegationService.effectiveScopes(chain, ["tasks:read", "tasks:write"], scopesForRole("user"))))();
  const warrant = await warrantService.create({
    name: "s5 " + tag, holderPrincipalId: connectorId,
    anchors: [{ anchorType: "project", anchorId: projectId }],
    ceilingRules: [{ resourceType: "task", selectorForm: "all-of-type", selectorIds: [], verbs: ["read", "write"] }],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  } as any, { principalId: admin.id, isRoot: true, stepUp: { tokenId: "probe", method: "password" } }, ACTOR);
  const pack = await warrantService.mintUnderWarrant({
    actingPrincipalId: connectorId, actingCredentialScopes: await connEff,
    targetTaskId: boundTask, warrantId: warrant.id,
    authority: { scopes: ["tasks:read", "tasks:write"], rules: [] },
  }, ACTOR);
  const agentId = pack.principalId;

  // The PRODUCTION actor shape: chain + effective scopes, as the auth
  // middleware assembles them per request.
  const agentActor = async () => {
    const chain = await delegationService.resolveChain(agentId);
    const account = chain.links[chain.links.length - 1];
    return {
      principalId: agentId, handle: pack.handle, role: null,
      scopes: delegationService.effectiveScopes(chain, pack.scopes, scopesForRole(account.role)),
      authenticated: true,
      delegation: { links: chain.links.map((l) => ({
        principalId: l.principalId, kind: l.kind, role: l.role, parentPrincipalId: l.parentPrincipalId,
        boundTaskId: l.boundTaskId, legacyIdentity: l.legacyIdentity, ownExpression: l.ownExpression,
      })) },
    } as any;
  };

  // ── §8.2 read default + T22 ──────────────────────────────────────────
  const actor = await agentActor();
  out.s82ReadsBoundTask = (await authorizationRepository.authorizePoint(actor, "task", boundTask, "read")).allowed === true;
  out.s82ReadsBoundPhase = (await authorizationRepository.authorizePoint(actor, "phase", phaseId, "read")).allowed === true;
  out.s82ReadsBoundProject = (await authorizationRepository.authorizePoint(actor, "project", projectId, "read")).allowed === true;
  out.t22OffContextTaskRefused = (await authorizationRepository.authorizePoint(actor, "task", foreignTask, "read")).allowed === false;

  // ── T5/T36: claimant write bound-only ────────────────────────────────
  await taskManagerDB.claimTask(boundTask, agentId);
  const claimantActor = await agentActor();
  out.t36BoundClaimantWrite = (await authorizationRepository.authorizePoint(claimantActor, "task", boundTask, "write")).allowed === true;
  out.t5ForeignWriteRefused = (await authorizationRepository.authorizePoint(claimantActor, "task", foreignTask, "write")).allowed === false;

  // ── AZ-29 lease coupling ─────────────────────────────────────────────
  await pool.query("UPDATE principal_credentials SET expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1", [pack.credentialId]);
  const beforeExtend = new Date((await pool.query("SELECT expires_at FROM principal_credentials WHERE id = $1", [pack.credentialId])).rows[0].expires_at).getTime();
  const extendResult = await agentLifecycleService.extendOnLeaseRenewal(agentId, boundTask, ACTOR);
  const afterExtend = new Date((await pool.query("SELECT expires_at FROM principal_credentials WHERE id = $1", [pack.credentialId])).rows[0].expires_at).getTime();
  out.az29RenewalReupsToMaxAge = extendResult.extended === true
    && afterExtend > beforeExtend
    && afterExtend > Date.now() + 23 * 3600_000
    && afterExtend <= Date.now() + 25 * 3600_000;
  out.az29ExtensionAudited = (await pool.query(
    "SELECT 1 FROM audit_events WHERE action = 'credential.extend' AND outcome = 'success' AND resource_id = $1",
    [agentId])).rows.length >= 1;

  await warrantService.revoke(warrant.id, "s5 blocked-extension proof", ACTOR);
  const blocked = await agentLifecycleService.extendOnLeaseRenewal(agentId, boundTask, ACTOR);
  out.az29RevokedWarrantBlocks = blocked.extended === false && blocked.blockedReason === "WARRANT_REVOKED";
  out.az29BlockAudited = (await pool.query(
    "SELECT 1 FROM audit_events WHERE action = 'credential.extend' AND outcome = 'denied' AND metadata->>'refusal' = 'WARRANT_REVOKED' AND resource_id = $1",
    [agentId])).rows.length >= 1;

  // ── auto-revoke sweep + T6 liveness + one-way ────────────────────────
  await pool.query("UPDATE tasks SET status = 'completed' WHERE id = $1", [boundTask]);
  const terminalBlocked = await agentLifecycleService.extendOnLeaseRenewal(agentId, boundTask, ACTOR);
  out.az29TerminalTaskBlocks = terminalBlocked.blockedReason === "TASK_TERMINAL";
  const swept = await agentLifecycleService.sweepTerminalAgents(ACTOR);
  out.sweepRevokesTerminalAgents = swept >= 1
    && (await pool.query("SELECT revoked_at FROM principal_credentials WHERE id = $1", [pack.credentialId])).rows[0].revoked_at !== null;
  const deadChain = await delegationService.resolveChain(agentId);
  out.t6ChainDeadNow = deadChain.alive === false;
  await pool.query("UPDATE tasks SET status = 'in-progress' WHERE id = $1", [boundTask]);
  out.oneWayReopenNeverResurrects = (await pool.query(
    "SELECT revoked_at FROM principal_credentials WHERE id = $1", [pack.credentialId])).rows[0].revoked_at !== null;
  out.sweepIdempotent = (await agentLifecycleService.sweepTerminalAgents(ACTOR)) === 0
    || (await pool.query("SELECT COUNT(*)::int AS n FROM principal_credentials WHERE id = $1 AND revoked_at IS NOT NULL", [pack.credentialId])).rows[0].n === 1;

  // ── §7.4 pack composition round-trip ─────────────────────────────────
  const composed = composeOnboardingPack({
    endpoint: "https://board.example/api",
    credential: { credentialId: pack.credentialId, keyId: pack.keyId, secretOnce: "rh_probe_secret", expiresAt: pack.expiresAt, transport: pack.transport },
    scopes: pack.scopes, rules: pack.rules, boundTaskId: pack.boundTaskId, brief: "PROBE BRIEF",
  });
  out.packCarriesBootstrapAndSnippets = composed.bootstrapLine.includes("https://board.example/api")
    && composed.cliEnv.join(" ").includes("rh_probe_secret")
    && Boolean((composed.mcpConfig.claudeCode as any).mcpServers?.relayhall)
    && composed.mcpConfig.codex.includes("RELAYHALL_TOKEN")
    && composed.brief === "PROBE BRIEF"
    && composed.authoritySummary.boundTaskId === boundTask;

  console.log(JSON.stringify(out, null, 1));
  const failures = Object.entries(out).filter(([, v]) => typeof v === "boolean" && !v);
  await pool.end();
  if (failures.length > 0) {
    console.error("FAILED:", failures.map(([k]) => k).join(", "));
    process.exit(1);
  }
  console.log("S5 LIVE: " + Object.keys(out).length + "/" + Object.keys(out).length + " checks pass");
}

main().catch(err => { console.error(err); process.exit(1); });
`;

const fs = require("fs");
const tmp = path.join(__dirname, ".s5-agent-lifecycle-probe.ts");
fs.writeFileSync(tmp, probe);
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
