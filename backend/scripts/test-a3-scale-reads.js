#!/usr/bin/env node
/**
 * test-a3-scale-reads.js — candidate A3 (design 986be411 §5; runbook §4-A3):
 * behavioral proof of the scale read contracts against a real migrated
 * PostgreSQL, through the production TaskManagerDB services:
 *   - queryScopeRows returns the exact filtered scope in one query;
 *   - queryDependencyEdges / queryKnowledgeEdges return exactly the edges
 *     within the id set (an edge touching an out-of-set Task never appears);
 *   - queryTaskIds agrees with queryScopeRows on membership;
 *   - queryBoardColumns pages at 50 with honest recomputed totals, and the
 *     documented OFFSET drift coping is demonstrated: a Task inserted
 *     between two page fetches shifts the window, the totals stay honest,
 *     and id-dedup accumulation (candidate A4's client) reconstructs the
 *     set without duplicates.
 *
 * Run with DB_* env pointed at a DISPOSABLE database carrying the migration
 * chain (prepare with test-fresh-install-replay.js). Exit 0 = all proofs.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const probe = `
import { pool } from "../src/db/connection";
import { taskManagerDB } from "../src/services/TaskManagerDB";
import { randomUUID } from "crypto";

async function main() {
  const tag = "a3-scale-" + randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};
  // Explicit, distinct created_at values: the proof is ordered BY
  // CONSTRUCTION under the production total order (created_at DESC, id
  // DESC), never by insertion timing (review e0f52de7 B1).
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  let seq = 0;
  const mk = async (key: string, status: string, priority = "normal") => {
    const id = randomUUID();
    ids[key] = id;
    seq += 1;
    await pool.query(
      "INSERT INTO tasks (id, title, description, status, priority, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, "A3 " + key, "", status, priority, new Date(baseMs + seq * 1000).toISOString()]);
    // Tag filtering reads the normalized task_tags table, not a column.
    await pool.query("INSERT INTO task_tags (task_id, tag) VALUES ($1,$2)", [id, tag]);
    return id;
  };

  // Scope: five tagged tasks; one untagged control; one tagged-but-archived.
  await mk("t1", "todo");
  await mk("t2", "in-progress");
  await mk("t3", "completed");
  await mk("t4", "completed", "high");
  await mk("arch", "archived");
  const control = randomUUID();
  await pool.query(
    "INSERT INTO tasks (id, title, description, status, priority) VALUES ($1,$2,$3,$4,$5)",
    [control, "A3 control untagged", "", "todo", "normal"]);

  // Edges: t2 depends on t1 (in scope), t2 depends on control (out of set);
  // knowledge: t3 -> t4 (in), t3 -> control (out of set).
  await pool.query("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2)", [ids.t2, ids.t1]);
  await pool.query("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2)", [ids.t2, control]);
  await pool.query("INSERT INTO task_references (task_id, kind, target_id, label) VALUES ($1,$2,$3,$4)", [ids.t3, "task", ids.t4, "knows"]);
  await pool.query("INSERT INTO task_references (task_id, kind, target_id, label) VALUES ($1,$2,$3,$4)", [ids.t3, "task", control, "knows-out"]);

  const out: Record<string, unknown> = {};

  // Scope rows: the six non-archived states, tagged only.
  const active = ["ideas", "todo", "in-progress", "review", "stuck", "completed"];
  const rows = await taskManagerDB.queryScopeRows(active, { tags: [tag] });
  const rowIds = rows.map(r => r.id).sort();
  const expected = [ids.t1, ids.t2, ids.t3, ids.t4].sort();
  out.scopeExact = JSON.stringify(rowIds) === JSON.stringify(expected);
  if (!out.scopeExact) out.scopeDiff = { got: rowIds, expected };
  out.scopeExcludesControlAndArchived = !rowIds.includes(control) && !rowIds.includes(ids.arch);

  // Ids read agrees with scope rows.
  const idList = await taskManagerDB.queryTaskIds(active, { tags: [tag] });
  out.idsAgree = JSON.stringify([...idList].sort()) === JSON.stringify(rowIds);

  // Edges strictly within the set.
  const setIds = [ids.t1, ids.t2, ids.t3, ids.t4];
  const deps = await taskManagerDB.queryDependencyEdges(setIds);
  const know = await taskManagerDB.queryKnowledgeEdges(setIds);
  out.depEdgesExact = JSON.stringify(deps) === JSON.stringify([{ from: ids.t2, to: ids.t1 }]);
  out.knowEdgesExact = JSON.stringify(know) === JSON.stringify([{ from: ids.t3, to: ids.t4 }]);

  // Board paging at 50 + the DOCUMENTED offset drift coping (review 3475a71e
  // B2: the proof is deterministic and FAILS if any coping step is removed).
  // Board order is created_at DESC — a Task inserted mid-pagination lands at
  // position 0 and shifts every later offset right by one, so page 2 is
  // GUARANTEED to repeat page 1's last row; a deletion ahead of the cursor
  // shifts left and GUARANTEES a skip. Coping contract under proof:
  //   (a) totals recomputed honestly on every fetch,
  //   (b) client accumulates by id — the guaranteed duplicate collapses,
  //   (c) the reconcile refetch converges to the exact live membership —
  //       the skipped row is recovered.
  await mk("t5", "completed");
  await mk("t6", "completed");
  // Deterministic timestamps: milliseconds apart so DESC order is total.
  const page1 = await taskManagerDB.queryBoardColumns(["completed"], { tags: [tag] }, 2, {});
  const total1 = page1.columns.completed.total;
  // Churn 1 (insert): t7 sorts FIRST under created_at DESC.
  await mk("t7", "completed");
  const page2 = await taskManagerDB.queryBoardColumns(["completed"], { tags: [tag] }, 2, { completed: 2 });
  const total2 = page2.columns.completed.total;
  out.totalsRecomputedHonestly = total1 === 4 && total2 === 5;
  if (!out.totalsRecomputedHonestly) out.totalsDiff = { total1, total2 };

  // (b) The insert-shift duplicate is GUARANTEED: page1 = [t6,t5]; after the
  // insert the live order is [t7,t6,t5,t4,t3], so page2 (offset 2) = [t5,t4]
  // and t5 repeats. Raw concatenation MUST show exactly one duplicate; the
  // id-dedup accumulation MUST collapse it.
  const rawIds = [...page1.columns.completed.items, ...page2.columns.completed.items].map(i => i.id);
  out.pageIdentitiesExact = JSON.stringify(page1.columns.completed.items.map(i => i.id)) === JSON.stringify([ids.t6, ids.t5])
    && JSON.stringify(page2.columns.completed.items.map(i => i.id)) === JSON.stringify([ids.t5, ids.t4]);
  const rawDupes = rawIds.length - new Set(rawIds).size;
  out.driftDuplicateObserved = rawDupes === 1;
  const accumulated = new Set(rawIds);
  out.dedupCollapses = accumulated.size === rawIds.length - rawDupes;

  // Churn 2 (removal): t4 — ALREADY collected — leaves the scope. Live
  // membership becomes [t7,t6,t5,t3] (order t7>t6>t5>t3). Page 3 at offset
  // 4 over a 4-row set is EMPTY, so t7 and t3 are never collected and the
  // stale t4 stays in the accumulation. The pre-reconcile set is therefore
  // GUARANTEED to differ from live membership — asserted explicitly, so
  // deleting the reconcile step turns the final assertion red while this
  // one proves the drift was real.
  await pool.query("DELETE FROM task_tags WHERE task_id = $1", [ids.t4]);
  const page3 = await taskManagerDB.queryBoardColumns(["completed"], { tags: [tag] }, 2, { completed: 4 });
  for (const item of page3.columns.completed.items) accumulated.add(item.id);
  out.page3Empty = page3.columns.completed.items.length === 0;
  const liveMembership = [ids.t3, ids.t5, ids.t6, ids.t7].sort();
  const accumulatedSorted = [...accumulated].sort();
  out.preReconcileDiffers = JSON.stringify(accumulatedSorted) !== JSON.stringify(liveMembership);
  out.preReconcileMissesLiveRows = [ids.t7, ids.t3].every(id => !accumulated.has(id));
  out.preReconcileCarriesStaleRow = accumulated.has(ids.t4);
  // The reconcile refetch is the coping step under proof: it MUST converge
  // the client to the exact live membership with an honest total.
  const reconcilePage = await taskManagerDB.queryBoardColumns(["completed"], { tags: [tag] }, 50, {});
  const reconciled = reconcilePage.columns.completed.items.map(i => i.id).sort();
  out.reconcileConverges = JSON.stringify(reconciled) === JSON.stringify(liveMembership)
    && JSON.stringify(reconciled) !== JSON.stringify(accumulatedSorted);
  out.reconcileTotalHonest = reconcilePage.columns.completed.total === 4;
  if (!out.reconcileConverges) out.reconcileDiff = { reconciled, liveMembership, accumulatedSorted };

  // Default page size at the service boundary honors the caller; the ROUTE
  // default of 50 is pinned by scaleReadContracts.test.ts.
  const page50 = await taskManagerDB.queryBoardColumns(["completed"], { tags: [tag] }, 50, {});
  out.pageAt50 = page50.columns.completed.limit === 50 && page50.columns.completed.items.length === 4;
  if (!out.pageAt50) out.page50Diff = { limit: page50.columns.completed.limit, count: page50.columns.completed.items.length };

  console.log(JSON.stringify(out));

  // Tidy the disposable DB for repeat runs.
  await pool.query("DELETE FROM task_tags WHERE task_id = ANY($1::uuid[])", [Object.values(ids)]);
  await pool.query("DELETE FROM task_references WHERE task_id = ANY($1::uuid[])", [Object.values(ids)]);
  await pool.query("DELETE FROM task_dependencies WHERE task_id = ANY($1::uuid[])", [Object.values(ids)]);
  await pool.query("DELETE FROM tasks WHERE id = ANY($1::uuid[])", [[...Object.values(ids), control]]);
  await pool.end();

  const failures = Object.entries(out).filter(([key, value]) => typeof value === "boolean" && !value);
  if (failures.length > 0) {
    console.error("FAILED:", failures.map(([key]) => key).join(", "));
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
`;

const fs = require("fs");
const tmp = path.join(__dirname, ".a3-probe.ts");
fs.writeFileSync(tmp, probe);
const result = spawnSync(path.join(__dirname, "..", "node_modules", ".bin", "tsx"), [tmp], {
  stdio: "inherit", env: process.env, cwd: path.join(__dirname, ".."),
});
fs.unlinkSync(tmp);
process.exit(result.status ?? 1);
