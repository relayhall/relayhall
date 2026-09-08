#!/usr/bin/env node
/**
 * test-reports-taskid-arms.js — C1 (RH-UI.7, design 3cdf6e65 §4.2; review
 * ac5d1cf6 F4.2): behavioral proof that GET /reports?taskId= returns rows for
 * BOTH filter arms through the production ReportManager.list — task_ids
 * containment AND task_references kind=report linkage — and excludes an
 * unlinked control, against a real migrated PostgreSQL.
 *
 * Run with DB_* env pointed at a DISPOSABLE database that already carries the
 * repository migration chain (e.g. one prepared by test-fresh-install-replay).
 * Exit 0 = both arms proved. No psql/docker needed — the pg client only.
 */
const path = require("path");
process.env.RELAYHALL_BOOT_CHECK = "";
require("child_process");
const { spawnSync } = require("child_process");

const probe = `
import { pool } from "../src/db/connection";
import { reportManager } from "../src/services/ReportManager";
import { randomUUID } from "crypto";

async function main() {
  const taskId = randomUUID();
  const containment = randomUUID();
  const referenced = randomUUID();
  const control = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO tasks (id, title, description, status, priority) VALUES ($1,$2,$3,$4,$5)",
      [taskId, "arms probe task", "", "todo", "normal"]);
    await client.query(
      "INSERT INTO reports (id, title, content, task_ids) VALUES ($1,$2,$3,$4)",
      [containment, "containment arm", "body", [taskId]]);
    await client.query(
      "INSERT INTO reports (id, title, content, task_ids) VALUES ($1,$2,$3,$4)",
      [referenced, "reference arm", "body", []]);
    await client.query(
      "INSERT INTO reports (id, title, content, task_ids) VALUES ($1,$2,$3,$4)",
      [control, "control unlinked", "body", []]);
    await client.query(
      "INSERT INTO task_references (task_id, kind, target_id, label) VALUES ($1,$2,$3,$4)",
      [taskId, "report", referenced, "linked report"]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }

  const result = await reportManager.list({ taskId, limit: 50 });
  const ids = result.reports.map(r => r.id);
  const okContainment = ids.includes(containment);
  const okReference = ids.includes(referenced);
  const okControl = !ids.includes(control);
  console.log(JSON.stringify({ okContainment, okReference, okControl, returned: ids.length }));

  // cleanup (disposable DB, but leave it tidy for repeat runs)
  await pool.query("DELETE FROM task_references WHERE task_id = $1", [taskId]);
  await pool.query("DELETE FROM reports WHERE id = ANY($1::uuid[])", [[containment, referenced, control]]);
  await pool.query("DELETE FROM tasks WHERE id = $1", [taskId]);
  await pool.end();
  if (!(okContainment && okReference && okControl)) process.exit(1);
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
`;

const fs = require("fs");
const os = require("os");
const tmp = path.join(__dirname, ".arms-probe.ts");
fs.writeFileSync(tmp, probe);
const run = spawnSync(path.join(__dirname, "..", "node_modules", ".bin", "tsx"), [tmp], {
  stdio: "inherit", env: process.env, cwd: path.join(__dirname, ".."),
});
fs.unlinkSync(tmp);
process.exit(run.status ?? 1);
