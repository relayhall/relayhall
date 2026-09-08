#!/usr/bin/env node
/**
 * w2-conformance-gate.js — the §4.5(a) conformance gate, as a command.
 *
 * Annex `e6dcadb9` §10b asks for a gate, not a demonstration: fixtures for the
 * named targets and all eight shape classes traversing ONE production path as
 * configuration, each class carrying a behavioural assertion with a negative
 * control, and the expected relation asserted against the digest-locked census.
 *
 * It runs against a REAL migrated PostgreSQL through the production relying
 * party, with a provider double at the one outbound seam. Prepare a disposable
 * database with `test-fresh-install-replay.js`, point DB_* at it, and run:
 *
 *     node scripts/w2-conformance-gate.js
 *
 * Exit 0 = every class green and the relation satisfied. Exit 1 = the gate
 * FAILS BY NAME, which is what the five §4.5(a) mutations require of it.
 *
 * Worker note (harness card `9b4e465a`): this driver runs a single `tsx`
 * process and spawns no pool, so it is safe to run inside an agent session.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');

const probe = `
process.env.RELAYHALL_SESSIONS = "on";
process.env.JWT_SECRET = process.env.JWT_SECRET || "w2-conformance-secret";
process.env.RELAYHALL_PUBLIC_API_URL = process.env.RELAYHALL_PUBLIC_API_URL || "https://board.conformance.test/api";
process.env.RELAYHALL_CREDENTIAL_KEYS = process.env.RELAYHALL_CREDENTIAL_KEYS
  || JSON.stringify({ conformance: Buffer.alloc(32, 11).toString("base64") });
process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY = process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY || "conformance";

import { pool } from "../src/db/connection";
import { runConformanceGate } from "../src/__tests__/conformance/gate";

(async () => {
  const result = await runConformanceGate();

  if (result.refusedToRun) {
    console.error("GATE REFUSED TO RUN: " + result.refusedToRun);
    await pool.end();
    process.exit(1);
  }

  const width = 7;
  console.log("");
  console.log("  class  assertion  control  entry-point  label");
  for (const outcome of result.outcomes) {
    console.log(
      "  " + String(outcome.classId).padEnd(width)
      + outcome.assertion.padEnd(11)
      + outcome.control.padEnd(9)
      + (outcome.entryPointStamped ? "stamped" : "MISSING").padEnd(13)
      + outcome.label
    );
    for (const line of outcome.detail) console.log("           . " + line);
    // A machine-readable line per outcome, so w2-red-proofs.js can require
    // that a hollowing turns THAT class's assertion red while its control
    // stays green - which is the property, not merely "the gate failed".
    console.log("RESULT class=" + outcome.classId
      + " assertion=" + outcome.assertion
      + " control=" + outcome.control
      + " stamped=" + (outcome.entryPointStamped ? "true" : "false"));
  }
  console.log("");

  if (result.failures.length > 0) {
    console.error("§4.5(a) CONFORMANCE GATE FAILED:");
    for (const failure of result.failures) console.error("  - " + failure);
    await pool.end();
    process.exit(1);
  }

  console.log("§4.5(a) conformance gate PASSED: "
    + result.outcomes.length + " fixtures, all eight shape classes, expected relation satisfied.");
  await pool.end();
  process.exit(0);
})().catch(async (error) => {
  console.error("§4.5(a) CONFORMANCE GATE ERRORED: " + (error && error.stack ? error.stack : error));
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
