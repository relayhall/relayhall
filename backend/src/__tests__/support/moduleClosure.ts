import fs from 'fs';
import path from 'path';

/**
 * The transitive relative-import closure and the SQL-sink scanner — the
 * TypeScript form of the `closure.py` the design record ran, shared by the
 * posture gate's writer census (§3.13) and the retry-contract suite's manifest
 * derivation (§4.2). Card fb06c930, design record `bf8928ee` v5 (D2/D3).
 *
 * WHAT IT IS FOR, stated so nothing leans on it further than it reaches.
 *
 * The closure OVER-APPROXIMATES reachability: a module in the closure is
 * imported, not necessarily called. That is the safe direction for a census
 * whose job is to miss nothing. It resolves RELATIVE specifiers only — a
 * package import cannot write these tables — and reads table names from string
 * literals.
 *
 * It is a static BACKSTOP and never the proof. The convergence oracle measures
 * the property at runtime over the WHOLE schema, with no manifest in its
 * comparison path (round 4 broke a manifest-limited comparison with a
 * trigger-driven in-place write, and the repair was to stop depending on any
 * census being complete). What survives here is documentation of what the
 * oracle is expected to find, plus ONE assertion that genuinely rests on it:
 * the sink-anchored writer census, which is anchored at the SQL sink rather
 * than at a hand-curated module allowlist, so a new writer in a NEW module is
 * a violation rather than an omission.
 */

export const BACKEND_SRC = path.resolve(__dirname, '..', '..');

const IMPORT_PATTERNS: RegExp[] = [
  /\bimport\s+[^'"]*?from\s*['"](\.[^'"]+)['"]/g,
  /\bimport\s*['"](\.[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  /\bfrom\s*['"](\.[^'"]+)['"]/g,
];

/** Resolve a relative specifier the way the compiler does, .ts before /index.ts. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    `${base}.ts`, `${base}.tsx`, base,
    path.join(base, 'index.ts'), path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every module reachable from `entry` through relative imports, transitively. */
export function moduleClosure(entry: string): string[] {
  const start = path.isAbsolute(entry) ? entry : path.join(BACKEND_SRC, entry);
  if (!fs.existsSync(start)) throw new Error(`moduleClosure: no such entry module: ${entry}`);
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(source);
      while (match !== null) {
        const resolved = resolveSpecifier(file, match[1]);
        if (resolved && !seen.has(resolved)) { seen.add(resolved); queue.push(resolved); }
        match = pattern.exec(source);
      }
    }
  }
  return [...seen].sort();
}

/** Every `.ts` file under `backend/src`, excluding migrations and the suites. */
export function backendModules(options: { includeTests?: boolean } = {}): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'migrations') continue;
        if (!options.includeTests && entry.name === '__tests__') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  walk(BACKEND_SRC);
  return out.sort();
}

/** Table names appearing in a module's SQL text, from string literals only. */
export function tablesIn(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const found = new Set<string>();
  const patterns = [
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)/gi,
    /\bDELETE\s+FROM\s+([a-z_][a-z0-9_]*)/gi,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) { found.add(match[1].toLowerCase()); match = pattern.exec(source); }
  }
  return [...found].sort();
}

/**
 * Sink-anchored: every module under `backend/src` whose SQL text WRITES the
 * named table. Anchored at the statement, not at a module list, so a writer
 * that appears in a module nobody thought of is found.
 */
export function writersOf(table: string, options: { includeTests?: boolean } = {}): string[] {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A DOUBLE-QUOTED identifier is the same table to PostgreSQL and was a
  // different string to the first version of this scanner — review round 1 broke
  // the census with `UPDATE "operation_idempotency_records" …` and it stayed
  // green. A census anchored at the SQL sink has to read SQL's own spelling
  // rules, so both forms count, and so does a schema qualifier.
  const write = new RegExp(
    '(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:ONLY\\s+)?'
    + `(?:"?[a-z_][a-z0-9_]*"?\\s*\\.\\s*)?"?${escaped}"?\\b`, 'i');
  return backendModules(options)
    .filter((file) => write.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(BACKEND_SRC, file).split(path.sep).join('/'))
    .sort();
}

/** Audit-ledger call sites inside a module set — the D2 transitive census. */
export function auditSites(files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const relative = path.relative(BACKEND_SRC, file).split(path.sep).join('/');
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/auditService\s*\.\s*record\s*\(/.test(line)) out.push(`${relative}:${index + 1}`);
    });
  }
  return out.sort();
}

/** The tables a route entry's closure references — documentation, not a basis. */
export function derivedTableManifest(entry: string, schemaTables: readonly string[]): string[] {
  const known = new Set(schemaTables.map((name) => name.toLowerCase()));
  const found = new Set<string>();
  for (const file of moduleClosure(entry)) {
    for (const table of tablesIn(file)) if (known.has(table)) found.add(table);
  }
  return [...found].sort();
}
