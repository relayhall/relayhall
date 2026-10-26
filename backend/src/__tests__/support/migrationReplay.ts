/**
 * Replaying a published migration inside a live suite without changing the
 * schema the next suite meets (machinery queue 9b761f09, the 157-replay class).
 *
 * The full tier's live job runs every live suite, one after another, on ONE
 * database. A suite that replays a published migration with a committed query
 * re-runs that file's DDL over whatever later migrations made of the same
 * objects. Migration 157 redefines the two retry-contract CHECKs on
 * `operation_idempotency_records` with its own closed set; 164 and 166 widened
 * them since, so a committed replay of 157 narrowed them back and every later
 * suite that wrote a newer operation went red, far from the cause.
 *
 * A replay that only measures the migration's own idempotence runs here: in a
 * transaction that is always rolled back (PostgreSQL DDL is transactional), and
 * the whole public schema is fingerprinted before and after, so the helper
 * itself proves the database is left exactly as it was found. The fast-tier
 * census (`migrationReplayCensus.test.ts`) names every suite that still
 * replays with a committed query and fails when a later migration redefines an
 * object such a replay would put back.
 */

import fs from 'fs';
import path from 'path';
import { laterRedefinitions, MIGRATIONS_DIR } from './migrationReplayCensus';

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface TransactionClient extends Queryable {
  release(): void;
}

export interface ConnectablePool extends Queryable {
  connect(): Promise<TransactionClient>;
}

/**
 * Every schema object a replay can redefine, in the public schema: constraint
 * definitions, index definitions, trigger definitions, function bodies (by
 * identity signature), column shapes and defaults, view bodies and the
 * comments on tables and columns. Rows are data and are not part of it.
 */
export async function schemaFingerprint(q: Queryable): Promise<string[]> {
  const result = await q.query(
    `SELECT 'con:' || c.conrelid::regclass::text || ':' || c.conname || ':' || pg_get_constraintdef(c.oid) AS item
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
     UNION ALL
     SELECT 'idx:' || tablename || ':' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname = 'public'
     UNION ALL
     SELECT 'trg:' || t.tgrelid::regclass::text || ':' || t.tgname || ':' || pg_get_triggerdef(t.oid)
       FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
     UNION ALL
     SELECT 'fn:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || md5(p.prosrc)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
     UNION ALL
     SELECT 'col:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':'
            || coalesce(column_default, '-')
       FROM information_schema.columns WHERE table_schema = 'public'
     UNION ALL
     SELECT 'view:' || viewname || ':' || md5(definition) FROM pg_views WHERE schemaname = 'public'
     UNION ALL
     SELECT 'doc:' || c.relname || ':' || d.objsubid || ':' || md5(d.description)
       FROM pg_description d JOIN pg_class c ON c.oid = d.objoid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE d.classoid = 'pg_class'::regclass AND n.nspname = 'public'
     ORDER BY 1`);
  return result.rows.map((row: any) => String(row.item));
}

/** What changed between two fingerprints, each side sorted. */
export function schemaDrift(before: string[], after: string[]): { removed: string[]; added: string[] } {
  const was = new Set(before);
  const now = new Set(after);
  return {
    removed: before.filter((item) => !now.has(item)).sort(),
    added: after.filter((item) => !was.has(item)).sort(),
  };
}

/** Run `act`; fail, naming every changed object, unless the schema afterwards is the schema before. */
export async function expectSchemaUnchanged<T>(q: Queryable, label: string, act: () => Promise<T>): Promise<T> {
  const before = await schemaFingerprint(q);
  const result = await act();
  const drift = schemaDrift(before, await schemaFingerprint(q));
  if (drift.removed.length > 0 || drift.added.length > 0) {
    throw new Error(`${label} left the shared schema changed (a later suite would meet it): `
      + `before ${JSON.stringify(drift.removed.slice(0, 10))}, after ${JSON.stringify(drift.added.slice(0, 10))}`);
  }
  return result;
}

/**
 * Replay inside ONE transaction that is always rolled back, then prove the
 * schema is the one found. `work` receives the transaction's client; every
 * query that must see the replay goes through it, never through the pool.
 */
export async function replayInRolledBackTransaction<T>(
  pool: ConnectablePool, label: string, work: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  return expectSchemaUnchanged(pool, label, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await work(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
}

/**
 * The CHECK constraints a migration's text (re)adds BY NAME, with the table and
 * the predicate exactly as the file writes it: every
 * `ALTER TABLE <t> ... ADD CONSTRAINT <c> CHECK (<predicate>)`. Comments and
 * dollar-quoted bodies are not definitions and are skipped; the predicate is
 * read up to its balancing parenthesis, quoted literals included.
 */
export function replayedChecks(sql: string): Array<{ table: string; constraint: string; predicate: string }> {
  const text = sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out: Array<{ table: string; constraint: string; predicate: string }> = [];
  const ident = String.raw`(?:"?\w+"?\.)?"?(\w+)"?`;
  for (const statement of text.split(';')) {
    const table = statement.match(new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?` + ident, 'i'));
    if (!table) continue;
    for (const m of statement.matchAll(new RegExp(String.raw`\bADD\s+CONSTRAINT\s+` + ident + String.raw`\s+CHECK\s*\(`, 'gi'))) {
      const open = (m.index ?? 0) + m[0].length - 1;
      let depth = 0;
      let quoted = false;
      let close = -1;
      for (let at = open; at < statement.length; at += 1) {
        const ch = statement[at];
        if (quoted) { if (ch === "'") quoted = false; continue; }
        if (ch === "'") quoted = true;
        else if (ch === '(') depth += 1;
        else if (ch === ')' && --depth === 0) { close = at; break; }
      }
      if (close < 0) throw new Error(`the CHECK of ${m[1]} has no balancing parenthesis`);
      out.push({ table: table[1].toLowerCase(), constraint: m[1].toLowerCase(), predicate: statement.slice(open + 1, close).trim() });
    }
  }
  return out;
}

/**
 * Scope a rolled-back replay of `file` to the rows that file's own contract
 * admits (machinery queue 9b761f09, the 157-replay class, data half).
 *
 * Re-adding a CHECK validates every row of its table. On the full tier's one
 * shared database a LATER migration may have widened that CHECK, and an earlier
 * suite may have committed rows only the wider set admits (the Timeline suite
 * writes `task.subtask.*` retry records, which 164 added after 157); a replay
 * of the older file then fails on data it never produced, not on its own text.
 *
 * Inside the replay's transaction (so always rolled back), for every CHECK the
 * file re-adds, the rows its OWN predicate rejects are counted and set aside,
 * but only where a later migration, named by file, redefines that same
 * constraint. A rejected row with no later redefinition is not data from a
 * wider contract: it means the replayed file narrows what it already admitted,
 * and the replay fails naming the constraint. Every row the file's own
 * predicate admits stays, so the replay still validates them.
 */
export async function setAsideRowsOnlyLaterMigrationsAdmit(
  client: Queryable, file: string, dir = MIGRATIONS_DIR,
): Promise<Array<{ constraint: string; table: string; rows: number; admittedBy: string[] }>> {
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  const later = laterRedefinitions(file, dir);
  const out: Array<{ constraint: string; table: string; rows: number; admittedBy: string[] }> = [];
  for (const check of replayedChecks(sql)) {
    const rejected = Number((await client.query(
      `SELECT count(*)::int AS n FROM ${check.table} WHERE NOT (${check.predicate})`)).rows[0].n);
    if (rejected === 0) continue;
    const admittedBy = later.filter((entry) => entry.objects.includes(`con:${check.constraint}`)).map((entry) => entry.later);
    if (admittedBy.length === 0) {
      throw new Error(`${rejected} row(s) of ${check.table} fail ${file}'s own ${check.constraint}, and no later migration `
        + 'redefines that constraint: the replayed file rejects rows its own contract once admitted');
    }
    await client.query(`DELETE FROM ${check.table} WHERE NOT (${check.predicate})`);
    out.push({ constraint: check.constraint, table: check.table, rows: rejected, admittedBy });
  }
  return out;
}
