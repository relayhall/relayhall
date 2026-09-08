/**
 * The `rh.ai.telemetry/1.0` FREEZE and the §2.2.2 kind-vocabulary delta.
 *
 * These assertions are deliberately anchored OUTSIDE the TypeScript module
 * under test: the base vocabulary is read out of migration 055 (which this
 * card did not write) and the widened vocabulary out of migration 111's SQL.
 * A drift between the TypeScript map and the database CHECK therefore reddens
 * here rather than at 3am on a live ingest.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import {
  TELEMETRY_ACCEPTED_OUTCOME_FIELDS,
  TELEMETRY_REFUSED_OUTCOME_FIELDS,
} from '../utils/telemetryEnvelopeValidator';
import {
  SESSION_EVENT_KINDS_055,
  TELEMETRY_ENVELOPE_ACCEPTED_MAJORS,
  TELEMETRY_ENVELOPE_KINDS,
  TELEMETRY_ENVELOPE_KIND_TO_EVENT_KIND,
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
} from '../types/TelemetryEnvelope';

const MIGRATIONS = path.resolve(__dirname, '../migrations');

function readMigration(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
}

/** Pull the literal set out of a `CHECK (event_kind IN ( ... ))` clause. */
function eventKindsInCheck(sql: string, marker: string): string[] {
  const start = sql.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('(', sql.indexOf('event_kind IN', start));
  let depth = 0;
  let end = open;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = sql.slice(open + 1, end);
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('rh.ai.telemetry/1.0 freeze', () => {
  it('names the ratified schema version and accepts exactly major 1', () => {
    expect(TELEMETRY_ENVELOPE_SCHEMA_VERSION).toBe('rh.ai.telemetry/1.0');
    expect([...TELEMETRY_ENVELOPE_ACCEPTED_MAJORS]).toEqual([1]);
  });

  it('carries exactly the eleven ratified kinds (design 7d5c0cdc §4.2)', () => {
    expect([...TELEMETRY_ENVELOPE_KINDS].sort()).toEqual([
      'agent_step', 'audit', 'error', 'feedback', 'health', 'metric',
      'model_call', 'session', 'tool_call', 'turn', 'usage',
    ]);
  });
});

describe('§2.2.2 kind-vocabulary delta', () => {
  it('reproduces the migration-055 vocabulary from the migration file itself', () => {
    // Outside anchor: 055 is not this card's file.
    const kinds055 = eventKindsInCheck(readMigration('055_canonical_session_foundation.sql'), 'CREATE TABLE IF NOT EXISTS session_events');
    expect(kinds055.sort()).toEqual([...SESSION_EVENT_KINDS_055].sort());
  });

  it('maps every envelope kind, and NEVER through "other"', () => {
    for (const kind of TELEMETRY_ENVELOPE_KINDS) {
      const mapped = TELEMETRY_ENVELOPE_KIND_TO_EVENT_KIND[kind];
      expect(typeof mapped).toBe('string');
      expect(mapped).not.toBe('other');
    }
    // Every kind has an entry — no silent undefined.
    expect(Object.keys(TELEMETRY_ENVELOPE_KIND_TO_EVENT_KIND).sort())
      .toEqual([...TELEMETRY_ENVELOPE_KINDS].sort());
  });

  it('maps the three COINCIDING kinds onto the existing 055 spellings', () => {
    for (const coinciding of ['tool_call', 'usage', 'error'] as const) {
      expect(SESSION_EVENT_KINDS_055).toContain(coinciding);
      expect(TELEMETRY_ENVELOPE_KIND_TO_EVENT_KIND[coinciding]).toBe(coinciding);
    }
  });

  it('migration 111 admits exactly the 055 vocabulary UNION the mapped kinds', () => {
    const widened = eventKindsInCheck(readMigration('111_telemetry_envelope_foundation.sql'), 'session_events_event_kind_envelope_check');
    const expected = new Set<string>([
      ...SESSION_EVENT_KINDS_055,
      ...Object.values(TELEMETRY_ENVELOPE_KIND_TO_EVENT_KIND),
    ]);
    expect([...new Set(widened)].sort()).toEqual([...expected].sort());
    // And no spelling is admitted twice — a duplicated literal in the CHECK
    // would hide a mapping mistake behind a set comparison.
    expect(widened.length).toBe(new Set(widened).size);
  });

  it('migration 111 makes attempt_id nullable on BOTH 055 tables (§2.2.1)', () => {
    const sql = readMigration('111_telemetry_envelope_foundation.sql');
    expect(sql).toContain('ALTER TABLE session_events ALTER COLUMN attempt_id DROP NOT NULL;');
    expect(sql).toContain('ALTER TABLE session_observations ALTER COLUMN attempt_id DROP NOT NULL;');
  });

  it('migration 111 adds the TW1c grouping columns as COLUMNS, not JSONB probes', () => {
    const sql = readMigration('111_telemetry_envelope_foundation.sql');
    for (const column of ['connector_id', 'account_id', 'agent_id', 'source_product', 'session_ref', 'policy_tier', 'schema_version', 'observed_at']) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`));
    }
    expect(sql).toContain('idx_session_events_envelope_grouping');
  });

  it('migration 111 adds the org/key/day accounting receipts ALONGSIDE the attempt-grained table', () => {
    const sql = readMigration('111_telemetry_envelope_foundation.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS session_accounting_receipts');
    expect(sql).toMatch(/usage_day\s+DATE\s+NOT NULL/);
    // The 055 attempt-grained table is not touched by this file.
    expect(sql).not.toMatch(/ALTER TABLE session_usage_receipts/);
  });
});

/**
 * The members of an interface in `TelemetryEnvelope.ts`, enumerated with the
 * TYPESCRIPT COMPILER API (review `4c1eb429`, R4-F2).
 *
 * The first version matched `/^ {2}([a-z_]+)\??:/` against the raw text, which
 * a perfectly legal member defeated: `error_code_v2?: string | null` contains a
 * digit, so the parser returned the unchanged member list and the parity
 * comparison stayed green — the same false-green class as R3-F4, reappearing in
 * the control written for R3-F4. A regex over source text is not a parser.
 * `ts.createSourceFile` is, and it sees optional markers, type annotations,
 * quoted names, comments and multi-line members without being told about any
 * of them.
 */
function interfaceMembers(source: string, interfaceName: string): string[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name) {
          found.push(member.name.getText(file).replace(/^['"]|['"]$/g, ''));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const ENVELOPE_TYPES_PATH = path.resolve(__dirname, '../types/TelemetryEnvelope.ts');

/** The `TelemetryEnvelopeOutcome` members as the compiler sees them. */
function declaredOutcomeFields(): string[] {
  return interfaceMembers(fs.readFileSync(ENVELOPE_TYPES_PATH, 'utf8'), 'TelemetryEnvelopeOutcome');
}

describe('R3-F4 — the wire contract and the frozen type cannot drift apart', () => {
  it('the accepted outcome fields are exactly what the frozen interface declares', () => {
    // Round 3 found `error_frames` accepted by the validator, documented for
    // reporters and consumed by the engine — while absent from
    // `TelemetryEnvelopeOutcome`, reached instead through a cast that hid the
    // drift from the compiler. TypeScript types do not survive to runtime, so
    // the interface is read from its own source: adding a field to the
    // validator without the interface (or the reverse) reddens here.
    expect(declaredOutcomeFields().sort()).toEqual([...TELEMETRY_ACCEPTED_OUTCOME_FIELDS].sort());
  });

  it('every refused outcome field is absent from the frozen interface, with a stated reason', () => {
    const declared = declaredOutcomeFields();
    for (const [field, reason] of Object.entries(TELEMETRY_REFUSED_OUTCOME_FIELDS)) {
      expect(declared).not.toContain(field);
      expect(reason.length).toBeGreaterThan(40);
    }
    expect(Object.keys(TELEMETRY_REFUSED_OUTCOME_FIELDS).sort())
      .toEqual(['error_fingerprint', 'error_frames']);
  });

  it('the parser is not vacuous — it finds the fields that ARE declared', () => {
    expect(declaredOutcomeFields().length).toBeGreaterThan(1);
    expect(declaredOutcomeFields()).toContain('status');
  });

  it('RED PROOF: the parser sees the exact member that defeated the regex', () => {
    // R4-F2's mutation, run against the real parser. `error_code_v2?: string`
    // is legal TypeScript and contains a digit; the old regex could not see it,
    // so a one-sided interface addition passed the parity check.
    const mutated = fs.readFileSync(ENVELOPE_TYPES_PATH, 'utf8').replace(
      'export interface TelemetryEnvelopeOutcome {',
      'export interface TelemetryEnvelopeOutcome {\n  error_code_v2?: string | null;');
    const seen = interfaceMembers(mutated, 'TelemetryEnvelopeOutcome');
    expect(seen).toContain('error_code_v2');
    // …and the parity comparison it feeds would therefore FAIL, which is the
    // whole point: the control can now redden on a one-sided addition.
    expect(seen.sort()).not.toEqual([...TELEMETRY_ACCEPTED_OUTCOME_FIELDS].sort());
  });

  it('RED PROOF: the parser also sees quoted and multi-line members', () => {
    // Two more shapes a text regex misses. Each must be visible, or the parity
    // control is only as good as the formatting it happened to be written for.
    const quoted = interfaceMembers(
      'export interface Probe {\n  \'quoted-name\'?: string;\n  plain: number;\n}', 'Probe');
    expect(quoted.sort()).toEqual(['plain', 'quoted-name']);
    const multiline = interfaceMembers(
      'export interface Probe {\n  spread?:\n    | string\n    | null;\n}', 'Probe');
    expect(multiline).toEqual(['spread']);
  });

  it('RED PROOF: the parser reports NOTHING for an interface that is absent', () => {
    // Guards the opposite failure: a silently-empty result would make every
    // "field is absent" assertion pass vacuously.
    expect(interfaceMembers('export interface Other { a: string; }', 'TelemetryEnvelopeOutcome'))
      .toEqual([]);
  });

  it('the §6.1 narrowing is stated where the mechanism used to be', () => {
    const engine = fs.readFileSync(
      path.resolve(__dirname, '../services/TelemetryPolicyEngine.ts'), 'utf8');
    expect(engine).toContain('DECLARED NARROWING');
    expect(engine).toContain('TW2');
    expect(engine).not.toContain('telemetryErrorFingerprint');
  });
});
