import fs from 'fs';
import path from 'path';

/**
 * The static census behind the 157-replay class (machinery queue 9b761f09).
 *
 * A live suite may replay a published migration to measure that the file is
 * idempotent. With a COMMITTED query that replay re-runs the file's DDL on the
 * one database the full tier's live job shares, so any object the file defines
 * that a LATER migration redefined is put back to the older definition for
 * every suite that runs afterwards. That is how a replay of 157 narrowed the
 * retry-contract CHECKs that 164 and 166 had widened.
 *
 * This module finds (a) every replay site in the test tree and whether it is
 * committed, and (b) for a migration, every later migration that redefines an
 * object it defines. The census test joins them: a committed replay of a file
 * whose objects a later migration redefines is refused by name, before any
 * database is involved. A replay that must stay committed (a mutation drill
 * edits the migration and needs the edit to land) is allowed exactly while no
 * later migration touches what it defines.
 *
 * It reads text. It is the backstop that names the suite; the runtime proof is
 * `replayInRolledBackTransaction`, which fingerprints the whole schema.
 */

export const BACKEND_SRC = path.resolve(__dirname, '..', '..');
export const MIGRATIONS_DIR = path.join(BACKEND_SRC, 'migrations');
export const TESTS_DIR = path.join(BACKEND_SRC, '__tests__');

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;

/** Comments and dollar-quoted bodies removed: a function body's text is not a definition. */
function stripSql(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * The schema objects a migration's text defines or redefines, as
 * `kind:name`: constraints added or dropped by name, functions, triggers,
 * indexes and views created, replaced or dropped, column defaults and types
 * altered, and comments on tables and columns. Rows (INSERT, UPDATE) are data.
 */
export function definedObjects(sql: string): Set<string> {
  const text = stripSql(sql);
  const out = new Set<string>();
  const add = (kind: string, name: string) => out.add(`${kind}:${name.toLowerCase()}`);
  const ident = '(?:"?\\w+"?\\.)?"?(\\w+)"?';
  for (const m of text.matchAll(new RegExp(`\\b(?:ADD|DROP)\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${ident}`, 'gi'))) add('con', m[1]);
  for (const m of text.matchAll(new RegExp(`\\b(?:CREATE(?:\\s+OR\\s+REPLACE)?|DROP)\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?${ident}`, 'gi'))) add('fn', m[1]);
  for (const m of text.matchAll(new RegExp(`\\b(?:CREATE(?:\\s+OR\\s+REPLACE)?(?:\\s+CONSTRAINT)?|DROP)\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${ident}`, 'gi'))) add('trg', m[1]);
  for (const m of text.matchAll(new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${ident}\\s+ON\\b`, 'gi'))) add('idx', m[1]);
  for (const m of text.matchAll(new RegExp(`\\bDROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${ident}`, 'gi'))) add('idx', m[1]);
  for (const m of text.matchAll(new RegExp(`\\b(?:CREATE(?:\\s+OR\\s+REPLACE)?(?:\\s+MATERIALIZED)?|DROP(?:\\s+MATERIALIZED)?)\\s+VIEW\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?${ident}`, 'gi'))) add('view', m[1]);
  for (const m of text.matchAll(/\bCOMMENT\s+ON\s+(TABLE|COLUMN)\s+([\w."]+)/gi)) add('doc', m[2].replace(/"/g, ''));
  for (const statement of text.split(';')) {
    const table = statement.match(new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${ident}`, 'i'));
    if (!table) continue;
    for (const m of statement.matchAll(/\bALTER\s+COLUMN\s+"?(\w+)"?\s+(?:SET\s+DEFAULT|DROP\s+DEFAULT|SET\s+DATA\s+TYPE|TYPE|SET\s+NOT\s+NULL|DROP\s+NOT\s+NULL)/gi)) {
      add('col', `${table[1]}.${m[1]}`);
    }
  }
  return out;
}

/** The numbered migrations in `dir`, in ledger (filename) order. */
export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return fs.readdirSync(dir).filter((name) => MIGRATION_FILE.test(name)).sort();
}

/** For `file`, every LATER migration that redefines an object `file` defines, with the shared objects. */
export function laterRedefinitions(file: string, dir = MIGRATIONS_DIR): Array<{ later: string; objects: string[] }> {
  const files = migrationFiles(dir);
  if (!files.includes(file)) throw new Error(`no migration named ${file} in ${dir}`);
  const own = definedObjects(fs.readFileSync(path.join(dir, file), 'utf8'));
  const out: Array<{ later: string; objects: string[] }> = [];
  for (const later of files.filter((name) => name > file)) {
    const theirs = definedObjects(fs.readFileSync(path.join(dir, later), 'utf8'));
    const objects = [...own].filter((name) => theirs.has(name)).sort();
    if (objects.length > 0) out.push({ later, objects });
  }
  return out;
}

export interface ReplaySite {
  suite: string;
  migration: string;
  /** true when the replay runs on the pool (or on a client in a file that never rolls back). */
  committed: boolean;
  line: number;
}

/**
 * Every place a test file EXECUTES a numbered migration's text. Reading the
 * text to inspect it is not a replay; passing it to `.query(` is. A replay on
 * `pool` or `pool()` commits; a replay on a client counts as transactional
 * only when the file rolls a transaction back somewhere.
 */
export function replaySites(suite: string, source: string): ReplaySite[] {
  const paths = new Map<string, string>();
  const texts = new Map<string, string>();
  const funcs = new Map<string, string>();
  const migrationIn = (rhs: string): string | null => {
    const literal = rhs.match(/(\d{3}_[a-z0-9_]+\.sql)/);
    if (literal) return literal[1];
    for (const [name, file] of [...paths, ...texts]) if (new RegExp(`\\b${name}\\b`).test(rhs)) return file;
    return null;
  };
  for (let pass = 0; pass < 3; pass += 1) {
    for (const m of source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*([\s\S]*?);/g)) {
      const file = migrationIn(m[2]);
      if (!file) continue;
      if (/readFileSync\s*\(/.test(m[2]) || texts.has(m[2].trim())) texts.set(m[1], file);
      else if (!texts.has(m[1])) paths.set(m[1], file);
    }
    for (const m of source.matchAll(/\bfunction\s+(\w+)\s*\(\s*\)[^{]*\{\s*return\s+([^;]*);/g)) {
      const file = migrationIn(m[2]);
      if (file && /readFileSync\s*\(/.test(m[2])) funcs.set(m[1], file);
    }
  }
  const rollsBack = /\bROLLBACK\b/.test(source);
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  const out: ReplaySite[] = [];
  for (const m of source.matchAll(/([\w.]+(?:\(\))?)\.query\(/g)) {
    const receiver = m[1];
    // A replay passes the text alone: an identifier, a no-argument call or a
    // readFileSync, closed by `)`. A query with parameters is never a replay.
    const argument = source.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 240);
    let migration: string | null = null;
    const bare = argument.match(/^\s*(\w+)\s*\)/);
    const call = argument.match(/^\s*(\w+)\(\)\s*\)/);
    const read = argument.match(/^\s*(?:fs\.)?readFileSync\s*\(([^;]*?)\)\s*\)/);
    if (bare && texts.has(bare[1])) migration = texts.get(bare[1])!;
    else if (call && (funcs.has(call[1]) || texts.has(call[1]))) migration = funcs.get(call[1]) ?? texts.get(call[1])!;
    else if (read) migration = migrationIn(read[1]);
    if (!migration) continue;
    const onPool = /(^|\.)pool(\(\))?$/.test(receiver);
    out.push({ suite, migration, committed: onPool || !rollsBack, line: lineOf(m.index ?? 0) });
  }
  return out;
}

/**
 * The replay sites of every TypeScript file under the test tree, sorted by
 * suite then line. The census's own test is skipped: its synthetic sources are
 * fixtures for the scanner, not replays.
 */
export function treeReplaySites(dir = TESTS_DIR, skip = ['migrationReplayCensus.test.ts']): ReplaySite[] {
  const out: ReplaySite[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts') || skip.includes(entry.name)) continue;
      out.push(...replaySites(path.relative(dir, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')));
    }
  };
  walk(dir);
  return out.sort((a, b) => a.suite.localeCompare(b.suite) || a.line - b.line);
}
