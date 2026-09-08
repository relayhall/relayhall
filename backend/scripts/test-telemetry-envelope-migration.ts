#!/usr/bin/env npx tsx
/**
 * Real-PostgreSQL probe for RH-TW1a candidate A (card `beac9c79`), rewritten
 * against review `bfac1dd5` finding F6.
 *
 * F6 was that the first version MODELLED the production seam instead of
 * executing it: it carried a private copy of `CanonicalRuntimeSignalService`'s
 * progress LATERAL, and it hand-wrote the envelope INSERT rather than calling
 * the store. Both could drift and leave the control green. Now:
 *
 *   - the progress predicate is imported from the service that OWNS it
 *     (`PROGRESS_EVENT_KINDS_SQL`), so a change to the service's kind filter
 *     changes this probe's query too;
 *   - the envelope row is written by `TelemetryEnvelopeStore.store()` — the
 *     production write path — against the real migrated schema, so PostgreSQL
 *     parses the real statement, enforces the real constraints and applies the
 *     real ON CONFLICT behaviour.
 *
 * DESTRUCTIVE-BY-POINTING WARNING: this applies migration SQL to whatever
 * database DB_HOST/DB_NAME name. Point it at a DISPOSABLE database only —
 * never at the live ClawBoard database, never at TST, never at PROD.
 *
 * Everything runs inside ONE transaction in a throwaway schema and is rolled
 * back; nothing is left behind and no existing row is touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { PROGRESS_EVENT_KINDS_SQL } from '../src/services/CanonicalRuntimeSignalService';
import { TelemetryEnvelopeStore } from '../src/services/TelemetryEnvelopeStore';
import type { TelemetryPrincipalBinding } from '../src/types/TelemetryEnvelope';

const migrationsDir = path.resolve(__dirname, '../src/migrations');
const foundation = fs.readFileSync(path.join(migrationsDir, '055_canonical_session_foundation.sql'), 'utf8');
const envelopeDelta = fs.readFileSync(path.join(migrationsDir, '111_telemetry_envelope_foundation.sql'), 'utf8');
// Candidate C: the production store now writes the governed raw blob and the
// event in ONE statement, so this probe's schema needs 113's table too. The
// alternative — teaching the probe to skip the blob — would be modelling the
// write path instead of executing it, which is the F6 defect this probe was
// rewritten to remove.
const governanceDelta = fs.readFileSync(path.join(migrationsDir, '113_telemetry_side_channel_governance.sql'), 'utf8');

const schema = `telemetry_envelope_probe_${process.pid}_${Date.now()}`;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'relayhall_dev',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'relayhall_dev',
});

/**
 * The production progress query, built from the OWNING service's exported kind
 * list. If someone adds a kind to the service's filter, this control follows.
 */
const PROGRESS_SEQUENCE_SQL = `
  SELECT COUNT(*)::bigint AS progress_sequence
    FROM session_events e
   WHERE e.attempt_id = $1
     AND e.event_kind IN (${PROGRESS_EVENT_KINDS_SQL})`;

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    event_id: 'evt-1',
    kind: 'tool_call',
    source: { product: 'claude-code', adapter: 'otlp', instance_id: 'inst-1' },
    correlation: { conversation_id: 'conv-1' },
    ...overrides,
  };
}

/** A receiver-derived accounting idempotency key, in the shape the CHECK pins. */
function acctKey(seed: string): string {
  return `rhacct/1:${createHash('sha256').update(seed).digest('hex')}`;
}

async function main(): Promise<void> {
  // The pepper must reach this process exactly as it must reach the backend.
  process.env.RELAYHALL_TELEMETRY_PEPPERS = process.env.RELAYHALL_TELEMETRY_PEPPERS
    || JSON.stringify({ probe: Buffer.alloc(32, 11).toString('base64') });
  process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER || 'probe';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE subtasks (task_id uuid NOT NULL REFERENCES tasks(id), "index" integer NOT NULL, PRIMARY KEY(task_id,"index"));
      CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE agent_types (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE principals (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);
    await client.query(foundation);
    await client.query(envelopeDelta);
    await client.query(governanceDelta);
    // Replaying the additive migrations must be harmless.
    await client.query(envelopeDelta);
    await client.query(governanceDelta);

    const accountId = (await client.query('INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id;
    const connectorId = (await client.query('INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id;
    const otherConnectorId = (await client.query('INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id;

    // THE PRODUCTION WRITE PATH, bound to this transaction's client so every
    // statement lands in the throwaway schema and rolls back with it (F6).
    const store = new TelemetryEnvelopeStore({
      query: (text: string, params?: unknown[]) => client.query(text, params),
    } as never);
    const binding: TelemetryPrincipalBinding = {
      accountId, connectorId, agentId: null, policyTier: 0,
    };

    const attempt = (await client.query(`INSERT INTO session_attempts
      (harness,runtime_kind,first_observed_at,identity_confidence,identity_reason,created_by_adapter)
      VALUES ('hermes','hermes_chat',NOW(),'authoritative','probe','probe@1') RETURNING attempt_id`)).rows[0].attempt_id;

    // A normal 055 attempt-bound row, so the control starts from non-zero.
    await client.query(`INSERT INTO session_events
      (attempt_id,source,source_instance,stream_generation,event_kind,payload,payload_hash,redaction_policy_version,idempotency_key)
      VALUES ($1,'hermes_sqlite','probe','generation:1','tool_call','{}',repeat('a',64),'probe-v1','probe:event:1')`, [attempt]);

    const before = Number((await client.query(PROGRESS_SEQUENCE_SQL, [attempt])).rows[0].progress_sequence);
    assert.equal(before, 1, 'the control must start from a NON-ZERO count, or it proves nothing');

    // ---- the production store writes an envelope row --------------------
    const stored = await store.store(binding, envelope());
    assert.ok(stored.accepted, `the production store must accept a legal envelope: ${JSON.stringify(stored)}`);
    assert.equal(stored.accepted && stored.duplicate, false, 'the first write is not a duplicate');

    const row = (await client.query(
      `SELECT attempt_id, event_kind, connector_id, account_id, source_product, session_ref,
              policy_tier, schema_version, observed_at, payload
         FROM session_events WHERE idempotency_key = $1`,
      [stored.accepted ? stored.identityKey : ''])).rows[0];
    assert.ok(row, 'the stored row must be findable by its identity key');
    assert.equal(row.attempt_id, null, 'the production store must write envelope rows ATTEMPT-LESS (owner decision D1)');
    assert.equal(row.event_kind, 'tool_call', 'the mapped kind must be the coinciding 055 spelling');
    assert.equal(row.connector_id, connectorId, 'connector_id comes from the BINDING');
    assert.equal(row.policy_tier, 0);
    assert.equal(row.schema_version, 'rh.ai.telemetry/1.0');
    assert.ok(row.observed_at, 'the receiver clock must be set');
    assert.ok(String(row.session_ref).startsWith('rhp_'), 'the grouping key must be an opaque pseudonym');
    assert.ok(!JSON.stringify(row.payload).includes('conv-1'), 'the source conversation id must not survive Tier 0');

    // ---- OWNER DECISION D1 CONTROL, on the production predicate ---------
    const after = Number((await client.query(PROGRESS_SEQUENCE_SQL, [attempt])).rows[0].progress_sequence);
    assert.equal(after, before,
      'attempt-less envelope rows must NOT move CanonicalRuntimeSignalService progress_sequence (owner decision D1)');

    // Negative control: the SAME kind of row, attempt-BOUND, WOULD move it —
    // so the control above is protected by the NULL binding and not by some
    // incidental property of the row.
    await client.query(`INSERT INTO session_events
      (attempt_id,source,source_instance,stream_generation,event_kind,payload,payload_hash,redaction_policy_version,idempotency_key,
       connector_id,account_id,source_product,policy_tier,schema_version,observed_at)
      VALUES ($1,'otlp','rhp_x','envelope:none','tool_call','{}',repeat('c',64),'rh.telemetry.tier0/1.0','probe:bound:1',
              $2,$3,'claude-code',0,'rh.ai.telemetry/1.0',NOW())`, [attempt, connectorId, accountId]);
    const withBinding = Number((await client.query(PROGRESS_SEQUENCE_SQL, [attempt])).rows[0].progress_sequence);
    assert.equal(withBinding, before + 1, 'the negative control must move the count, or the D1 control is vacuous');

    // ---- dedupe, through the production path ----------------------------
    const again = await store.store(binding, envelope());
    assert.ok(again.accepted && again.duplicate, 'a repeated identity must be an accepted DUPLICATE, not a second row');

    // §4.3: the SAME event from a DIFFERENT connector is a different event.
    const cross = await store.store({ ...binding, connectorId: otherConnectorId }, envelope());
    assert.ok(cross.accepted && !cross.duplicate, 'dedupe must never merge across connectors');

    // ---- the widened kind vocabulary, through the production path -------
    for (const kind of ['session', 'turn', 'model_call', 'agent_step', 'metric', 'audit', 'health', 'feedback', 'usage', 'error']) {
      const out = await store.store(binding, envelope({ kind, event_id: `evt-${kind}` }));
      assert.ok(out.accepted, `the schema must admit the envelope kind '${kind}': ${JSON.stringify(out)}`);
    }
    await client.query('SAVEPOINT k');
    await assert.rejects(
      client.query(`INSERT INTO session_events
        (attempt_id,source,source_instance,stream_generation,event_kind,payload,payload_hash,redaction_policy_version,idempotency_key)
        VALUES (NULL,'otlp','p','g','not_a_kind','{}',repeat('e',64),'v','k1')`),
      /session_events_event_kind_envelope_check/,
      'an unlisted kind must still be refused — the CHECK is widened, not removed',
    );
    await client.query('ROLLBACK TO SAVEPOINT k');

    // ---- the envelope binding constraint --------------------------------
    await client.query('SAVEPOINT b');
    await assert.rejects(
      client.query(`INSERT INTO session_events
        (attempt_id,source,source_instance,stream_generation,event_kind,payload,payload_hash,redaction_policy_version,idempotency_key,
         schema_version,observed_at)
        VALUES (NULL,'otlp','p','g','tool_call','{}',repeat('9',64),'v','k2','rh.ai.telemetry/1.0',NOW())`),
      /session_events_envelope_binding_check/,
      'an envelope row without its derived principal binding must be refused',
    );
    await client.query('ROLLBACK TO SAVEPOINT b');

    // ---- §2.2.1 on session_observations ---------------------------------
    await client.query(`INSERT INTO session_observations
      (attempt_id,source,source_instance,source_generation,observation_kind,provenance,payload,payload_hash,idempotency_key)
      VALUES (NULL,'otlp','p','g','envelope','{}','{}',repeat('7',64),'obs:1')`);

    // ---- §2.2.3 — org/key/day accounting receipts (F7: closed by construction)
    const receipt = await client.query(`INSERT INTO session_accounting_receipts
      (account_id,connector_id,usage_day,authority,scope,unit,amount,currency,idempotency_key,observed_at)
      VALUES ($1,$2,CURRENT_DATE,'provider','org','tokens',1234,'USD',$3,NOW()) RETURNING receipt_id`,
    [accountId, connectorId, acctKey('1')]);
    await client.query(`INSERT INTO session_accounting_receipts
      (account_id,connector_id,usage_day,authority,scope,unit,amount,idempotency_key,observed_at,supersedes_receipt_id)
      VALUES ($1,$2,CURRENT_DATE,'provider','org','tokens',1300,$3,NOW(),$4)`,
    [accountId, connectorId, acctKey('2'), receipt.rows[0].receipt_id]);
    const both = await client.query('SELECT COUNT(*)::int AS n FROM session_accounting_receipts');
    assert.equal(both.rows[0].n, 2, 'a superseding receipt must not remove the one it supersedes');

    // F7: the closed vocabularies, each proven to REFUSE and then to ACCEPT,
    // so a rejection is attributable to the constraint and not to a malformed
    // statement any schema would have refused.
    for (const [column, bad, good, constraint] of [
      ['authority', 'invented', 'derived', /session_accounting_receipts_authority_check/],
      ['scope', 'org_product', 'key', /session_accounting_receipts_scope_check/],
      ['unit', 'prompt_text', 'requests', /session_accounting_receipts_unit_check/],
    ] as Array<[string, string, string, RegExp]>) {
      const columns = { authority: 'provider', scope: 'org', unit: 'tokens' } as Record<string, string>;
      const build = (value: string, key: string) => {
        const v = { ...columns, [column]: value };
        return client.query(`INSERT INTO session_accounting_receipts
          (account_id,usage_day,authority,scope,unit,amount,idempotency_key,observed_at)
          VALUES ($1,CURRENT_DATE,$2,$3,$4,1,$5,NOW())`,
        [accountId, v.authority, v.scope, v.unit, key]);
      };
      await client.query('SAVEPOINT r');
      await assert.rejects(build(bad, acctKey(`bad-${column}`)), constraint,
        `the ${column} vocabulary must stay closed`);
      await client.query('ROLLBACK TO SAVEPOINT r');
      await build(good, acctKey(`good-${column}`));
    }
    // ---- R2-F6: prove CLOSURE, not the absence of unexpected column NAMES.
    //
    // The previous version listed every text/JSON column and asserted an
    // allowlist of their names — which included the two UNCONSTRAINED columns
    // the reviewer then used as an open channel. A name census cannot decide
    // whether a column is safe. So: (a) every string-bearing column must be
    // covered by a CHECK constraint, read from pg_constraint; and (b) a hostile
    // value is actually pushed at every one of them and must be REFUSED.
    const stringColumns = (await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='session_accounting_receipts'
          AND data_type IN ('jsonb','json','text','character varying')
        ORDER BY column_name`, [schema])).rows.map((r: any) => String(r.column_name));
    assert.ok(stringColumns.length > 0, 'the census must find columns, or it proves nothing');

    const checkSrc = (await client.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname=$1 AND t.relname='session_accounting_receipts' AND c.contype='c'`,
      [schema])).rows.map((r: any) => String(r.def)).join('\n');
    const uncovered = stringColumns.filter((col) => !checkSrc.includes(col));
    assert.deepEqual(uncovered, [],
      `every string-bearing accounting column must carry a CHECK; uncovered: ${uncovered.join(', ')}`);

    // (b) the behavioural half — a hostile value at every string column.
    // R3-F3: one universal prose marker proved only that prose is rejected.
    // Each column is now attacked with several VALUE CLASSES — prose, a raw
    // customer identifier, an email, a path — because "rejects prose" and
    // "rejects identity" are different claims and the second is the one this
    // table makes.
    const HOSTILE_CLASSES: ReadonlyArray<readonly [string, string]> = [
      ['prose', 'PROMPT: tell me the user secret /etc/shadow --token=abc'],
      ['raw identifier', 'CustomerSSN123456789'],
      ['address', 'operator@example.com'],
      ['path', '/home/operator/.ssh/id_ed25519'],
      ['long opaque', 'x'.repeat(200)],
    ];
    const baseRow: Record<string, unknown> = {
      account_id: accountId, connector_id: connectorId,
      authority: 'provider', scope: 'org', unit: 'tokens',
      amount: 1, currency: 'USD',
    };
    let attacked = 0;
    for (const column of stringColumns) {
      if (!(column in baseRow) && column !== 'idempotency_key') continue;
      for (const [label, hostile] of HOSTILE_CLASSES) {
        const row = { ...baseRow };
        let key = acctKey(`hostile-${column}-${label}`);
        if (column === 'idempotency_key') key = hostile;
        else row[column] = hostile;
        await client.query('SAVEPOINT h');
        await assert.rejects(
          client.query(`INSERT INTO session_accounting_receipts
            (account_id,connector_id,usage_day,authority,scope,unit,amount,currency,idempotency_key,observed_at)
            VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,NOW())`,
          [row.account_id, row.connector_id, row.authority, row.scope, row.unit,
            row.amount, row.currency, key]),
          /violates check constraint/,
          `a ${label} value in session_accounting_receipts.${column} must be REFUSED by the database`,
        );
        await client.query('ROLLBACK TO SAVEPOINT h');
        attacked += 1;
      }
    }
    assert.ok(attacked >= 10, `the hostile sweep must actually attack columns; it made ${attacked} attempts`);

    // The control's own control: legal values succeed, so the rejections above
    // are attributable to the hostile value and not to a broken statement.
    await client.query(`INSERT INTO session_accounting_receipts
      (account_id,connector_id,usage_day,authority,scope,unit,amount,currency,idempotency_key,observed_at)
      VALUES ($1,$2,CURRENT_DATE,'provider','org','tokens',1,'USD',$3,NOW())`,
    [accountId, connectorId, acctKey('hostile-control-positive')]);

    // R3-F3: the withdrawn column must be GONE, not merely constrained.
    assert.ok(!stringColumns.includes('source_product'),
      'session_accounting_receipts.source_product must not exist — it was withdrawn, not narrowed');

    // ---- the TW1c grouping indexes --------------------------------------
    const indexes = await client.query(
      'SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename=$2', [schema, 'session_events']);
    const names = indexes.rows.map((r: any) => r.indexname);
    assert.ok(names.includes('idx_session_events_envelope_grouping'), 'the TW1c grouping index must exist');
    assert.ok(names.includes('idx_session_events_envelope_presence'), 'the TW1c presence index must exist');

    console.log('PROBE_RESULT=PASS');
    console.log('✅ migration 111 probe: the PRODUCTION store wrote through the real schema; §2.2.1–§2.2.4 deltas, the D1 progress_sequence control on the OWNING service\'s predicate plus its negative control, cross-connector dedupe, and the closed accounting grain all hold.');
    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error('❌ migration 111 probe FAILED:', err.message);
  console.error('PROBE_RESULT=FAIL');
  process.exit(1);
});
