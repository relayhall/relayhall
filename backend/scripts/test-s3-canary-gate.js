#!/usr/bin/env node
/**
 * test-s3-canary-gate.js — the §7.2/T30 refuse-to-run proof (review
 * 6c7d68d2 B4): a server started against a database holding encrypted
 * credentials it cannot verify (wrong keyset) must TERMINATE with a
 * non-zero exit — never keep serving.
 *
 * Run with DB_* env at a DISPOSABLE fresh-replay database. The script
 * (1) mints one encrypted credential under keyset A through the
 * production service, then (2) spawns the real server with keyset B and
 * asserts it exits non-zero within the startup window.
 */
const { spawnSync, spawn } = require("child_process");
const path = require("path");

const BACKEND = path.join(__dirname, "..");
const KEYSET_A = JSON.stringify({ ka: Buffer.alloc(32, 1).toString("base64") });
const KEYSET_B = JSON.stringify({ kb: Buffer.alloc(32, 2).toString("base64") });

// 1. Mint one encrypted credential under keyset A (in-process probe).
const mintProbe = `
import { pool } from "../src/db/connection";
import { principalService } from "../src/services/PrincipalService";
import { randomUUID } from "crypto";
async function main() {
  const tag = "canary-" + randomUUID().slice(0, 8);
  const account = (await principalService.createPrincipal({ handle: tag + "-acct", kind: "service", role: "user", purpose: "canary gate" }))!;
  const conn = await pool.query(
    "INSERT INTO principals (kind, handle, status, parent_principal_id, own_expression) VALUES ('service',$1,'active',$2,$3::jsonb) RETURNING id",
    [tag + "-conn", account.id, JSON.stringify({ scopes: "parent", objects: "parent" })]);
  await principalService.issueCredential({ principalId: String(conn.rows[0].id), scopes: ["tasks:read"] });
  await pool.end();
  console.log("minted");
}
main().catch((err) => { console.error(err); process.exit(1); });
`;
const fs = require("fs");
const tmp = path.join(__dirname, ".canary-mint-probe.ts");
fs.writeFileSync(tmp, mintProbe);
const mint = spawnSync(path.join(BACKEND, "node_modules", ".bin", "tsx"), [tmp], {
  stdio: "inherit",
  env: { ...process.env, RELAYHALL_CREDENTIAL_KEYS: KEYSET_A, RELAYHALL_CREDENTIAL_ACTIVE_KEY: "ka" },
  cwd: BACKEND,
});
fs.unlinkSync(tmp);
if (mint.status !== 0) {
  console.error("mint step failed");
  process.exit(1);
}

// 2. Spawn the REAL server under the WRONG keyset: startup must terminate.
const server = spawn(path.join(BACKEND, "node_modules", ".bin", "tsx"), ["src/server.ts"], {
  env: {
    ...process.env,
    RELAYHALL_CREDENTIAL_KEYS: KEYSET_B,
    RELAYHALL_CREDENTIAL_ACTIVE_KEY: "kb",
    JWT_SECRET: process.env.JWT_SECRET || "canary-gate-secret",
    PORT: "3899",
    AUTO_MIGRATE: "false",
  },
  cwd: BACKEND,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

const timer = setTimeout(() => {
  console.error("CANARY GATE FAILED: server still running 45s after startup with an unverifiable keyset");
  server.kill("SIGKILL");
  process.exit(1);
}, 45000);

server.on("exit", (code) => {
  clearTimeout(timer);
  const refused = code !== 0;
  const loud = /CredentialCanary/.test(output);
  console.log(JSON.stringify({ exitCode: code, refused, loudCanaryLine: loud }));
  process.exit(refused && loud ? 0 : 1);
});
