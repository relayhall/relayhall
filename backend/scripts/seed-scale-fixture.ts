/**
 * seed-scale-fixture.ts — card `590e88cc`.
 *
 * The synthetic estate the intermittent-500 defect was reported against: the
 * A8 exit-battery shape (5,200 Tasks / 55 Projects / 220 Phases / 578
 * dependency edges) PLUS the child rows every Task read hydrates — tags,
 * subtasks and links — because the defect lives in how those child rows are
 * fetched, not in the Task rows themselves. A fixture that seeds Tasks alone
 * cannot reproduce it.
 *
 * It is a COMMITTED script rather than a throwaway because the load gate
 * (`src/__tests__/scaleReadLoad.test.ts`) seeds through it: the fixture a proof
 * runs against must be reproducible by whoever re-runs the proof.
 *
 * DESTRUCTIVE. It writes Principals, Projects, Phases, Tasks and their child
 * rows into whatever database DB_* names, and it refuses every deployment
 * database and every non-local host except the exact CI service fixture. Bring a disposable database up with
 * `database/init.sql` then `npm run migrate`, and throw it away afterwards.
 *
 *   DB_HOST=127.0.0.1 DB_PORT=15701 DB_NAME=relayhall_scale \
 *   DB_USER=scale DB_PASSWORD=scale \
 *     node ./node_modules/.bin/tsx scripts/seed-scale-fixture.ts --tasks 5200
 *
 * Determinism: every row is derived from a seeded PRNG, so two runs at the same
 * size produce the same shape (ids differ; counts, the dependency mix and the
 * child-row distribution do not). A measurement that cannot be repeated on the
 * same fixture measures the fixture.
 */
import { randomUUID } from 'crypto';
import { isScaleFixtureHost } from './scale-fixture-host';

const FORBIDDEN_DATABASES = ['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'];

/**
 * Round-1 REJECT, blocking finding 1. This guard used to read `process.env`
 * and treat an ABSENT `DB_NAME` as the empty string — which is in no forbidden
 * list, so it passed. The pool imported a line later resolves that same absent
 * variable to `relayhall_dev`. A destructive script that claims to refuse
 * deployment databases would therefore have written thousands of rows into DEV
 * whenever it was run with no environment at all, which is the most likely way
 * anyone runs it by accident.
 *
 * The repair is not a longer list. It is to stop asking the environment and
 * ask the POOL: `databasePoolConfig` is the object `new Pool()` is constructed
 * from, so `databasePoolConfig.database` and `.host` are exactly what a query
 * would connect to, defaults resolved. Constructing the pool opens nothing —
 * `pg` connects lazily — so importing it before the check is safe, and reading
 * the config it was built from is the only reading that cannot drift from it.
 */
export function assertDisposableTarget(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { databasePoolConfig } = require('../src/db/connection');
  const dbName = String(databasePoolConfig.database ?? '');
  const dbHost = String(databasePoolConfig.host ?? '');

  if (!dbName) {
    throw new Error('The pool resolves to no database name at all. Refusing to write.');
  }
  if (FORBIDDEN_DATABASES.includes(dbName)) {
    throw new Error(
      `The pool would connect to a deployment database (${dbName}) — set DB_NAME, or it defaults to one. `
      + 'This script writes thousands of rows and archives Tasks; point it at a disposable database '
      + 'loaded from database/init.sql + npm run migrate.',
    );
  }
  if (!isScaleFixtureHost(dbHost, dbName, process.env.CI)) {
    throw new Error(`The pool would connect to a non-local host (${dbHost}). Use a disposable local database, or postgres/relayhall_ci with CI=true.`);
  }
}

/** Deterministic PRNG (mulberry32) — the shape must not drift between runs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScaleFixture {
  label: string;
  rootPrincipalId: string;
  userPrincipalId: string;
  projectIds: string[];
  phaseIds: string[];
  taskIds: string[];
  dependencyEdges: number;
  taskLinks: number;
  taskTags: number;
  subtasks: number;
}

const STATUSES = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const TAG_POOL = ['backend', 'frontend', 'qa', 'scale', 'defect', 'infra', 'docs', 'security'];

export async function seedScaleFixture(options: {
  tasks?: number;
  projects?: number;
  phases?: number;
  dependencies?: number;
  seed?: number;
  label?: string;
} = {}): Promise<ScaleFixture> {
  // The check reads the pool's OWN resolved configuration, so it must run
  // before the first query — not before the first import. `pg` connects
  // lazily; constructing the pool touches no database.
  assertDisposableTarget();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pool } = require('../src/db/connection');

  const taskCount = options.tasks ?? 5200;
  const projectCount = options.projects ?? 55;
  const phaseCount = options.phases ?? 220;
  const dependencyCount = options.dependencies ?? 578;
  const rnd = prng(options.seed ?? 0x5ca1e);
  const label = options.label ?? `scale-${randomUUID().slice(0, 8)}`;
  const pick = <T>(list: T[]): T => list[Math.floor(rnd() * list.length)];

  // ── Accounts ───────────────────────────────────────────────────────────────
  // A root Account (the operator shape whose reads short-circuit the SQL
  // predicate to TRUE) and a role-`user` Account with no grants (the scoped
  // shape that carries the whole authorization scope into every statement).
  // The defect must be measured on BOTH: one of them is the fast path, and a
  // proof that only ever asks the fast one measures nothing.
  const rootRow = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, 'scale fixture root', 'active', 'admin') RETURNING id`,
    [`scale-root-${label}`],
  );
  const rootPrincipalId = String(rootRow.rows[0].id);
  const userRow = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, 'scale fixture user', 'active', 'user') RETURNING id`,
    [`scale-user-${label}`],
  );
  const userPrincipalId = String(userRow.rows[0].id);

  // ── Projects ───────────────────────────────────────────────────────────────
  const projectIds: string[] = [];
  for (let i = 0; i < projectCount; i += 1) {
    const res = await pool.query(
      `INSERT INTO projects (name, status, visibility, owner_principal_id)
       VALUES ($1, 'active', $2, $3) RETURNING id`,
      [`${label} project ${i}`, i % 4 === 0 ? 'shared' : 'private', rootPrincipalId],
    );
    projectIds.push(String(res.rows[0].id));
  }

  // ── Phases ─────────────────────────────────────────────────────────────────
  const phaseIds: string[] = [];
  const phaseProject: string[] = [];
  for (let i = 0; i < phaseCount; i += 1) {
    const projectId = projectIds[i % projectIds.length];
    const res = await pool.query(
      `INSERT INTO phases (project_id, name, status, position)
       VALUES ($1, $2, 'todo', $3) RETURNING id`,
      [projectId, `${label} phase ${i}`, i],
    );
    phaseIds.push(String(res.rows[0].id));
    phaseProject.push(projectId);
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────
  // Multi-row INSERT in batches: the seeder is not the thing under measurement,
  // and a per-row insert at 5,200 rows spends minutes of the budget on nothing.
  const COLUMNS = 11;
  const taskIds: string[] = [];
  const BATCH = 200;
  const baseMs = Date.parse('2026-01-01T00:00:00.000Z');
  for (let start = 0; start < taskCount; start += BATCH) {
    const size = Math.min(BATCH, taskCount - start);
    const values: unknown[] = [];
    const rows: string[] = [];
    for (let n = 0; n < size; n += 1) {
      const i = start + n;
      const phaseIndex = Math.floor(rnd() * phaseIds.length);
      const withPhase = rnd() < 0.8;
      const id = randomUUID();
      taskIds.push(id);
      const base = values.length;
      rows.push(`(${Array.from({ length: COLUMNS }, (_, k) => `$${base + k + 1}`).join(', ')})`);
      values.push(
        id,
        `${label} task ${i}`,
        pick(STATUSES),
        pick(PRIORITIES),
        withPhase ? phaseProject[phaseIndex] : projectIds[i % projectIds.length],
        withPhase ? phaseIds[phaseIndex] : null,
        rnd() < 0.25 ? 'shared' : 'private',
        // Creator and shepherd are the same root Account throughout, so no Task
        // is readable by accident through a Task-role or initiator arm: every
        // authorized read has exactly one named cause.
        rootPrincipalId,
        rootPrincipalId,
        new Date(baseMs + i * 1000).toISOString(),
        i % 7 === 0 ? new Date(baseMs + i * 1000).toISOString() : null,
      );
    }
    await pool.query(
      `INSERT INTO tasks (id, title, status, priority, project_id, phase_id, visibility,
                          creator_principal_id, shepherd_principal_id, created_at, completed_at)
       VALUES ${rows.join(', ')}`,
      values,
    );
  }

  // ── Child rows ─────────────────────────────────────────────────────────────
  // The four child tables `hydrateTasks` reads. Their POPULATION is what makes
  // an unindexed child-table lookup expensive.
  let taskLinks = 0;
  let taskTags = 0;
  let subtasks = 0;
  const tagValues: unknown[] = [];
  const tagRows: string[] = [];
  const linkValues: unknown[] = [];
  const linkRows: string[] = [];
  const subtaskValues: unknown[] = [];
  const subtaskRows: string[] = [];
  const flushTags = async (): Promise<void> => {
    if (tagRows.length) {
      await pool.query(`INSERT INTO task_tags (task_id, tag) VALUES ${tagRows.join(', ')} ON CONFLICT DO NOTHING`, tagValues);
    }
    tagRows.length = 0; tagValues.length = 0;
  };
  const flushLinks = async (): Promise<void> => {
    if (linkRows.length) {
      await pool.query(`INSERT INTO task_links (task_id, type, title, url) VALUES ${linkRows.join(', ')}`, linkValues);
    }
    linkRows.length = 0; linkValues.length = 0;
  };
  const flushSubtasks = async (): Promise<void> => {
    if (subtaskRows.length) {
      await pool.query(`INSERT INTO subtasks (task_id, index, title, status) VALUES ${subtaskRows.join(', ')} ON CONFLICT DO NOTHING`, subtaskValues);
    }
    subtaskRows.length = 0; subtaskValues.length = 0;
  };

  for (let i = 0; i < taskIds.length; i += 1) {
    const id = taskIds[i];
    const tagCount = 1 + Math.floor(rnd() * 3);
    for (let t = 0; t < tagCount; t += 1) {
      const base = tagValues.length;
      tagRows.push(`($${base + 1}, $${base + 2})`);
      tagValues.push(id, pick(TAG_POOL));
      taskTags += 1;
    }
    const linkCount = Math.floor(rnd() * 3);
    for (let l = 0; l < linkCount; l += 1) {
      const base = linkValues.length;
      linkRows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      linkValues.push(id, 'reference', `link ${l}`, `https://example.invalid/${i}/${l}`);
      taskLinks += 1;
    }
    const subtaskCount = Math.floor(rnd() * 4);
    for (let s = 0; s < subtaskCount; s += 1) {
      const base = subtaskValues.length;
      subtaskRows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      subtaskValues.push(id, s, `subtask ${s}`, 'empty');
      subtasks += 1;
    }
    if (tagRows.length > 400) await flushTags();
    if (linkRows.length > 400) await flushLinks();
    if (subtaskRows.length > 400) await flushSubtasks();
  }
  await flushTags();
  await flushLinks();
  await flushSubtasks();

  // ── Dependency edges ───────────────────────────────────────────────────────
  // Acyclic by construction: an edge always points at a LOWER index, so the
  // fixture can never trip the cycle guard and the count is exact.
  let dependencyEdges = 0;
  const seen = new Set<string>();
  const edgeValues: unknown[] = [];
  const edgeRows: string[] = [];
  let guard = 0;
  while (dependencyEdges < dependencyCount && guard < dependencyCount * 50) {
    guard += 1;
    const to = 1 + Math.floor(rnd() * (taskIds.length - 1));
    const from = Math.floor(rnd() * to);
    const key = `${to}:${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = edgeValues.length;
    edgeRows.push(`($${base + 1}, $${base + 2})`);
    edgeValues.push(taskIds[to], taskIds[from]);
    dependencyEdges += 1;
  }
  if (edgeRows.length) {
    await pool.query(
      `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ${edgeRows.join(', ')} ON CONFLICT DO NOTHING`,
      edgeValues,
    );
  }

  // The planner must see the fixture it is planning against, or a measurement
  // taken here describes an empty-table estimate rather than the estate.
  await pool.query('ANALYZE');

  return {
    label, rootPrincipalId, userPrincipalId, projectIds, phaseIds, taskIds,
    dependencyEdges, taskLinks, taskTags, subtasks,
  };
}

if (require.main === module) {
  const arg = (name: string, fallback: number): number => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? Number(process.argv[index + 1]) : fallback;
  };
  seedScaleFixture({
    tasks: arg('tasks', 5200),
    projects: arg('projects', 55),
    phases: arg('phases', 220),
    dependencies: arg('dependencies', 578),
  })
    .then((fixture) => {
      console.log(JSON.stringify({
        label: fixture.label,
        tasks: fixture.taskIds.length,
        projects: fixture.projectIds.length,
        phases: fixture.phaseIds.length,
        dependencyEdges: fixture.dependencyEdges,
        taskLinks: fixture.taskLinks,
        taskTags: fixture.taskTags,
        subtasks: fixture.subtasks,
        rootPrincipalId: fixture.rootPrincipalId,
        userPrincipalId: fixture.userPrincipalId,
      }, null, 2));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../src/db/connection').pool.end();
    })
    .catch((err: unknown) => { console.error(err); process.exit(1); });
}
