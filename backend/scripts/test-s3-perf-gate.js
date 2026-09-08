#!/usr/bin/env node
/**
 * test-s3-perf-gate.js — the AZ-S3 list-p95-under-agent-identity perf gate
 * (design 4d961e37 §5.1 / AZ-34: chain depth ≤ 3 permits a flattened join;
 * the DoD demands a measured gate, not a hope).
 *
 * Seeds 1,000 private tasks into a DISPOSABLE fresh-replay database, then
 * measures authorizedIds() — the ONE adapter behind every list narrowing
 * and point decision — over the full id set, 25 iterations each for
 * (a) a parentless Account actor and (b) a depth-3 Agent-chain actor.
 *
 * GATE (declared thresholds, disclosed in the evidence report): the
 * meaningful signal is the CHAIN OVERHEAD, so the gate is ratio-primary —
 *   agent-chain p95 < 3x the Account p95, AND < 750ms absolute backstop
 * (the absolute backstop tolerates disposable-container PG baselines; the
 * measured numbers print either way and go into the evidence report).
 * Exit 0 = gate passes; the measured numbers print either way.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const probe = `
import { pool } from "../src/db/connection";
import { principalService } from "../src/services/PrincipalService";
import { delegationService } from "../src/services/DelegationService";
import { authorizationRepository } from "../src/services/AuthorizationRepository";
import { randomUUID } from "crypto";

async function main() {
  const tag = "s3perf-" + randomUUID().slice(0, 8);
  const account = (await principalService.createPrincipal({ handle: tag + "-acct", kind: "service", role: "user", purpose: "perf gate" }))!;
  const connector = await pool.query(
    "INSERT INTO principals (kind, handle, status, parent_principal_id, own_expression) VALUES ('service',$1,'active',$2,$3::jsonb) RETURNING id",
    [tag + "-conn", account.id, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  const connectorId = String(connector.rows[0].id);
  await principalService.issueCredential({ principalId: connectorId, scopes: ["tasks:read"] });
  const bound = randomUUID();
  await pool.query("INSERT INTO tasks (id, title, description, status, priority) VALUES ($1,'perf bound','','todo','normal')", [bound]);
  const agent = await pool.query(
    "INSERT INTO principals (kind, handle, status, parent_principal_id, bound_task_id, own_expression) VALUES ('agent',$1,'active',$2,$3,$4::jsonb) RETURNING id",
    [tag + "-agent", connectorId, bound, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  const agentId = String(agent.rows[0].id);
  await principalService.issueCredential({ principalId: agentId, scopes: ["tasks:read"] });

  const ids: string[] = [];
  const batch: string[] = [];
  for (let i = 0; i < 1000; i += 1) {
    const id = randomUUID();
    ids.push(id);
    batch.push("('" + id + "','perf " + i + "','','todo','normal','private')");
  }
  await pool.query("INSERT INTO tasks (id, title, description, status, priority, visibility) VALUES " + batch.join(","));
  // Give the Account authority over half the set so both sides do real work.
  await pool.query(
    "INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb) SELECT 'principal', $1, 'task', unnest($2::uuid[]), 'read'",
    [account.id, ids.slice(0, 500)]);

  const accountActor = { principalId: account.id, handle: "acct", role: "user", scopes: ["tasks:read"], authenticated: true, delegation: null };
  const chain = await delegationService.resolveChain(agentId);
  const agentActor = {
    principalId: agentId, handle: "agent", role: "agent", scopes: ["tasks:read"], authenticated: true,
    delegation: { links: chain.links.map((l) => ({
      principalId: l.principalId, kind: l.kind, parentPrincipalId: l.parentPrincipalId,
      boundTaskId: l.boundTaskId, legacyIdentity: l.legacyIdentity, ownExpression: l.ownExpression })) },
  };

  const measure = async (actor: any): Promise<number[]> => {
    const samples: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const start = process.hrtime.bigint();
      const allowed = await authorizationRepository.authorizedIds(actor, "task", ids, "read");
      const end = process.hrtime.bigint();
      if (i === 0 && allowed.size === 0 && actor === agentActor) {
        // sanity: the agent chain should reach the parent-granted half.
        console.error("agent actor resolved zero rows — evaluator miswired");
        process.exit(1);
      }
      samples.push(Number(end - start) / 1e6);
    }
    return samples.sort((a, b) => a - b);
  };

  const accountSamples = await measure(accountActor);
  const agentSamples = await measure(agentActor);
  const p95 = (samples: number[]) => samples[Math.floor(samples.length * 0.95) - 1];
  const accountP95 = p95(accountSamples);
  const agentP95 = p95(agentSamples);
  console.log(JSON.stringify({
    accountP95Ms: Math.round(accountP95 * 100) / 100,
    agentP95Ms: Math.round(agentP95 * 100) / 100,
    ratio: Math.round((agentP95 / Math.max(accountP95, 0.01)) * 100) / 100,
    thresholdAbsoluteMs: 750,
    thresholdRatio: 3,
  }));
  await pool.end();
  if (agentP95 >= 750 || agentP95 >= accountP95 * 3) {
    console.error("PERF GATE FAILED");
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
`;

const fs = require("fs");
const tmp = path.join(__dirname, ".s3-perf-probe.ts");
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
