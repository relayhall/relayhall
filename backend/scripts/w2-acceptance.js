#!/usr/bin/env node
/**
 * w2-acceptance.js — the SS-W2 behavioural acceptance vectors, as a command.
 *
 * These are the W2 definition-of-done bullets the conformance gate does not
 * cover, because they are not about provider-agnosticism: concurrency on the
 * pending row, between-sweep replay, the sweep in both directions, the four
 * logout-isolation vectors, and SS-23's replay bound including the
 * swept-but-still-valid boundary a single-replay test cannot reach.
 *
 * Run against a DISPOSABLE database carrying the full migration chain:
 *
 *     node scripts/w2-acceptance.js
 *
 * Exit 0 = every vector green. Exit 1 = it names the vectors that failed.
 *
 * Worker note (harness card `9b4e465a`): one `tsx` process, no pool.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');

const probe = `
process.env.RELAYHALL_SESSIONS = "on";
process.env.JWT_SECRET = process.env.JWT_SECRET || "w2-acceptance-secret";
process.env.RELAYHALL_PUBLIC_API_URL = process.env.RELAYHALL_PUBLIC_API_URL || "https://board.acceptance.test/api";
process.env.RELAYHALL_CREDENTIAL_KEYS = process.env.RELAYHALL_CREDENTIAL_KEYS
  || JSON.stringify({ acceptance: Buffer.alloc(32, 13).toString("base64") });
process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY = process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY || "acceptance";

import { pool } from "../src/db/connection";
import { runAcceptanceVectors } from "../src/__tests__/acceptance/vectors";
import { runProtocolVectors } from "../src/__tests__/acceptance/protocolVectors";
import { runBindingVectors } from "../src/__tests__/acceptance/bindingVectors";
import { runSurfaceVectors } from "../src/__tests__/acceptance/surfaceVectors";
import { runRegressionVectors } from "../src/__tests__/acceptance/regressionVectors";

(async () => {
  // This harness OWNS its database (see surfaceVectors' header): SS-14a is a
  // global one-enabled-provider rule, so every module disables whatever is
  // active, which makes the suite order-dependent on whatever ran before it.
  // A conformance-gate run leaves an active provider behind and the binding
  // vectors then raced it. The red-proof driver runs this suite dozens of
  // times interleaved with gate runs, so "it passed from a clean database" is
  // not good enough: reset ONCE per run and be deterministic.
  await pool.query("DELETE FROM identity_links");
  await pool.query("DELETE FROM identity_providers");
  const lifecycle = await runAcceptanceVectors();
  const protocol = await runProtocolVectors();
  const binding = await runBindingVectors();
  const surface = await runSurfaceVectors();
  const regression = await runRegressionVectors();
  const merged = [...lifecycle.results, ...protocol, ...binding, ...surface, ...regression];
  const result = { ok: merged.every((vector) => vector.ok), results: merged };
  console.log("");
  for (const vector of result.results) {
    console.log("  " + (vector.ok ? "GREEN" : "RED  ") + "  " + vector.id.padEnd(28) + vector.claim);
    console.log("           . " + vector.detail);
    console.log("VECTOR id=" + vector.id + " ok=" + (vector.ok ? "true" : "false"));
  }
  console.log("");
  const failed = result.results.filter((vector) => !vector.ok);
  if (failed.length > 0) {
    console.error("SS-W2 ACCEPTANCE VECTORS FAILED:");
    for (const vector of failed) console.error("  - " + vector.id + ": " + vector.detail);
    await pool.end();
    process.exit(1);
  }
  console.log("SS-W2 acceptance vectors PASSED: " + result.results.length + " vectors green.");
  await pool.end();
  process.exit(0);
})().catch(async (error) => {
  console.error("SS-W2 ACCEPTANCE VECTORS ERRORED: " + (error && error.stack ? error.stack : error));
  try { await pool.end(); } catch { /* the pool may never have opened */ }
  process.exit(1);
});
`;

const run = spawnSync(
  path.join(BACKEND, 'node_modules', '.bin', 'tsx'),
  ['--eval', probe, '--tsconfig', path.join(BACKEND, 'tsconfig.json')],
  { cwd: path.join(BACKEND, 'scripts'), stdio: 'inherit', env: process.env },
);
process.exit(run.status === null ? 1 : run.status);
