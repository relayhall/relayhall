#!/usr/bin/env node
/**
 * test-w4-scim-registry-live.js — RH-P5.SSO.W4 candidate A, owner ruling
 * 4ae7ce53: the SCIM actor rule and the SCIM-client binding against a REAL
 * migrated PostgreSQL, through the PRODUCTION services and middleware.
 *
 * What a mocked pool cannot prove, this does: that the registry predicate is
 * SQL PostgreSQL executes, that migration 097's pairing is what it tests, and
 * that the whole path — owner-plane binding, `rh_` credential acceptance,
 * delegation-chain resolution, the registry question, the A24 scoping lookup,
 * the transactional Account creation — holds together on one database.
 *
 *   binding: a parentless service Account paired with a registry Connector
 *            (registered through ServiceRegistry, so 097 minted the pairing)
 *            binds; an unpaired Account of the same shape is refused
 *            PROVIDER_SCIM_CLIENT_UNPAIRED; the Connector itself is refused
 *            PROVIDER_SCIM_CLIENT_INVALID;
 *   act:     the Connector's credential, through the REAL authMiddleware and
 *            sharedAuthorizationMiddleware, provisions a parentless human
 *            Account at the fixed minimal role, with its provenance row;
 *            a parented service principal under the same Account with NO
 *            registry row (the round-3 probe — inserted directly, which 096
 *            admits) is refused and creates nothing; an Agent beneath the
 *            Connector is refused; clearing the binding refuses the
 *            Connector that just succeeded.
 *
 * Run with DB_* env at a DISPOSABLE fresh-replay database (init.sql, then
 * migrate to 106). NEVER at relayhall-dev-db-1, relayhall-tst-db-1 or the
 * ClawBoard database. Exit 0 = every check true.
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
import { identityProviderService } from "../src/services/identity/IdentityProviderService";
import { authMiddleware } from "../src/middleware/auth";
import { sharedAuthorizationMiddleware } from "../src/middleware/sharedAuthorization";
import scimRouter from "../src/routes/scim";
import { isRegistryConnector, registryConnectorsOf } from "../src/utils/connectorRegistry";
import { jsonBodyOptions } from "../src/utils/jsonBodyTypes";

const ACTOR = { principalId: null, handle: "w4-live-proof", authMethod: "system" as const };
const SCOPE = "directory-provisioning:write";

async function main() {
  const tag = "w4-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};

  // ── the estate: a parentless service Account and its REGISTRY Connector ──
  const account = (await principalService.createPrincipal({ handle: tag + "-svc", kind: "service", role: "user", purpose: "w4 live proof account" }))!;
  const registered = await serviceRegistry.register({ slug: tag + "-dir", name: "Directory " + tag, kind: "connector" }, account.id);
  const pairing = await pool.query("SELECT principal_id FROM services WHERE id = $1 AND kind = 'connector'", [(registered as any).id]);
  const connectorId = String(pairing.rows[0].principal_id);
  out.registryPairsConnector = (await isRegistryConnector(pool, connectorId)) === true;
  out.accountIsNotAConnector = (await isRegistryConnector(pool, account.id)) === false;
  out.pairingListsTheConnector = (await registryConnectorsOf(pool, account.id)).join(",") === connectorId;

  // The round-3 probe: a parented service principal under the SAME Account
  // that no registry row names. 096 admits the row.
  const unregistered = await pool.query(
    "INSERT INTO principals (kind, handle, status, parent_principal_id, own_expression) VALUES ('service',$1,'active',$2,$3::jsonb) RETURNING id",
    [tag + "-unreg", account.id, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  const unregisteredId = String(unregistered.rows[0].id);
  out.unregisteredAdmittedByDatabase = Boolean(unregisteredId);
  out.unregisteredIsNotAConnector = (await isRegistryConnector(pool, unregisteredId)) === false;

  // An Agent beneath the Connector (needs a bound task — 096 agent shape).
  const taskId = randomUUID();
  await pool.query("INSERT INTO tasks (id, title, description, status, priority, visibility) VALUES ($1,$2,'','in-progress','normal','private')", [taskId, "w4 bound " + tag]);
  const agent = await pool.query(
    "INSERT INTO principals (kind, handle, status, parent_principal_id, bound_task_id, own_expression) VALUES ('agent',$1,'active',$2,$3,$4::jsonb) RETURNING id",
    [tag + "-agent", connectorId, taskId, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  const agentId = String(agent.rows[0].id);

  // An unpaired Account: same shape as \`account\`, nothing registered beneath it.
  const unpaired = (await principalService.createPrincipal({ handle: tag + "-unpaired", kind: "service", role: "user", purpose: "w4 live proof unpaired" }))!;

  // ── the Identity provider, and the owner-plane binding (real service) ──
  // SS-14a: exactly one ENABLED Identity provider. A fresh replay may seed
  // one; on this DISPOSABLE database it is disabled so the probe's can be the
  // enabled one. Never run this at an estate database.
  const displaced = await pool.query("UPDATE identity_providers SET status = 'disabled' WHERE status = 'active' RETURNING id");
  const info: Record<string, unknown> = { displacedSeededIdentityProviders: displaced.rowCount };
  const idp = await identityProviderService.create({
    name: "W4 live " + tag, issuer: "https://issuer." + tag + ".example/", clientId: "rh",
    clientAuthMethod: "none", subjectImmutable: true, status: "active", provisioningMode: "jit",
  }, ACTOR);
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: any) => e.code ?? String(e));
  out.bindUnpairedRefusedByName = (await code(identityProviderService.setScimClient(idp.id, unpaired.id, ACTOR))) === "PROVIDER_SCIM_CLIENT_UNPAIRED";
  out.bindConnectorItselfRefused = (await code(identityProviderService.setScimClient(idp.id, connectorId, ACTOR))) === "PROVIDER_SCIM_CLIENT_INVALID";
  out.bindUnregisteredRefused = (await code(identityProviderService.setScimClient(idp.id, unregisteredId, ACTOR))) === "PROVIDER_SCIM_CLIENT_INVALID";
  out.bindPairedAccountSucceeds = (await code(identityProviderService.setScimClient(idp.id, account.id, ACTOR))) === "OK";
  const stored = await pool.query("SELECT scim_client_principal_id FROM identity_providers WHERE id = $1", [idp.id]);
  out.bindingStoresTheAccount = String(stored.rows[0].scim_client_principal_id) === account.id;

  // ── credentials, minted by the production lifecycle ──
  const connectorKey = (await principalService.issueCredential({ principalId: connectorId, scopes: [SCOPE] }, ACTOR)).fullKey;
  const unregisteredKey = (await principalService.issueCredential({ principalId: unregisteredId, scopes: [SCOPE] }, ACTOR)).fullKey;
  const agentKey = (await principalService.issueCredential({ principalId: agentId, scopes: [SCOPE] }, ACTOR)).fullKey;

  // ── the SCIM surface, mounted as server.ts mounts every protected family ──
  const app = express();
  // The parser exactly as server.ts mounts it (card 127556e1): the type list
  // is the shared constant, so this drill speaks the protocol's own type
  // through the SAME configuration production does.
  app.use(express.json(jsonBodyOptions));
  app.use("/scim", authMiddleware, sharedAuthorizationMiddleware, scimRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const post = async (key: string, userName: string, contentType = "application/json") => {
    const r = await fetch(base + "/scim/v2/Users", { method: "POST",
      headers: { "content-type": contentType, authorization: "Bearer " + key },
      body: JSON.stringify({ userName }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  // RFC 7644 §3.1: the protocol's own content type is parsed and provisions
  // (card 127556e1, folded into candidate C by ruling 6bdcc16c §3). This was
  // recorded-not-asserted in candidate A, where it read 400.
  const scimTyped = await post(connectorKey, tag + "-ct-probe", "application/scim+json");
  info.scimJsonContentTypeResponse = scimTyped;
  out.scimJsonBodyParsedAndProvisioned201 = scimTyped.status === 201;
  const accountsNamed = async (handle: string) =>
    (await pool.query("SELECT p.id, p.kind, p.role, p.parent_principal_id, d.identity_provider_id FROM principals p LEFT JOIN directory_provisioned_accounts d ON d.account_principal_id = p.id WHERE p.handle = $1", [handle])).rows;

  const ok = await post(connectorKey, tag + "-ada");
  info.connectorResponse = ok;
  out.connectorProvisions201 = ok.status === 201;
  const created = await accountsNamed(tag + "-ada");
  out.createdAccountIsParentlessHumanWithProvenance = created.length === 1 && created[0].kind === "human"
    && created[0].parent_principal_id === null && String(created[0].identity_provider_id) === idp.id;

  const probeUnregistered = await post(unregisteredKey, tag + "-mallory");
  out.unregisteredRefused403 = probeUnregistered.status === 403;
  out.unregisteredCreatedNothing = (await accountsNamed(tag + "-mallory")).length === 0;

  const probeAgent = await post(agentKey, tag + "-eve");
  out.agentRefused403 = probeAgent.status === 403;
  out.agentCreatedNothing = (await accountsNamed(tag + "-eve")).length === 0;

  await identityProviderService.setScimClient(idp.id, null, ACTOR);
  out.clearedBindingRefusesConnector = (await post(connectorKey, tag + "-grace")).status === 403;

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
const probePath = path.join(backend, "scripts", ".w4-scim-registry-live.probe.ts");
fs.writeFileSync(probePath, probe);
let status = 2;
try {
  const result = spawnSync(path.join(backend, "node_modules", ".bin", "tsx"), [probePath], {
    cwd: backend, stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "development",
      JWT_SECRET: process.env.JWT_SECRET || "w4-live-proof-jwt-secret-not-for-production-0123456789" },
  });
  status = result.status === null ? 2 : result.status;
} finally {
  // `process.exit` inside `try` would skip this block and leave the probe
  // behind for the allowlist gate to find — which is how it was first found.
  fs.unlinkSync(probePath);
}
process.exit(status);
