#!/usr/bin/env npx tsx
/**
 * Real-PostgreSQL probe for RH-TW1a candidate C (card `beac9c79`): migration
 * `113_telemetry_side_channel_governance.sql`.
 *
 * WHY THIS EXISTS AS A PROBE AND NOT A JEST TEST. Everything it checks is a
 * CHECK constraint or a foreign-key action — behaviour that belongs to
 * PostgreSQL, not to TypeScript. A double would confirm only what it was told,
 * and a static read of the migration would confirm only that the text was
 * written. The governance claims of design §6.5 are worth exactly as much as
 * the database's willingness to refuse the rows that would break them, so this
 * asks the database.
 *
 * The controls are NEGATIVE by construction. A schema that merely ACCEPTS the
 * good rows proves nothing: it is satisfied by a table with no constraints at
 * all. Each governance rule therefore has a row that must be REFUSED, and the
 * refusal is asserted by constraint NAME so that dropping the constraint and
 * leaving a same-shaped one behind cannot keep the control green.
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
import { TelemetryEnvelopeStore } from '../src/services/TelemetryEnvelopeStore';
import type { TelemetryEnvelopeStoreOutcome } from '../src/services/TelemetryEnvelopeStore';
import type { TelemetryPrincipalBinding } from '../src/types/TelemetryEnvelope';
import { telemetryEventRetentionDays } from '../src/utils/telemetryRetention';
import { TelemetryQuarantineService } from '../src/services/TelemetryQuarantineService';
import { telemetryQuarantineRetentionDays } from '../src/utils/telemetryRetention';
import { TelemetryRetentionService } from '../src/services/TelemetryRetentionService';

const migrationsDir = path.resolve(__dirname, '../src/migrations');
const sql = (name: string): string => fs.readFileSync(path.join(migrationsDir, name), 'utf8');

const schema = `telemetry_governance_probe_${process.pid}_${Date.now()}`;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'relayhall_dev',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'relayhall_dev',
});

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Narrow an outcome to its accepted arm, or fail with what it actually said. */
function mustAccept(outcome: TelemetryEnvelopeStoreOutcome) {
  assert.ok(outcome.accepted, `the production store must accept a legal envelope: ${JSON.stringify(outcome)}`);
  if (!outcome.accepted) throw new Error('unreachable');
  return outcome;
}

const observedAt = new Date('2026-09-04T00:00:00.000Z');
const referencedAgainAt = new Date('2026-09-04T01:00:00.000Z');

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    event_id: 'evt-raw-1',
    kind: 'tool_call',
    source: { product: 'claude-code', adapter: 'otlp' },
    ...overrides,
  };
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
    // The handful of tables migration 055 has foreign keys into. Stubs, exactly
    // as the candidate-A probe uses: this control is about the 113 constraints,
    // and dragging the whole product schema in would only add ways to fail for
    // reasons that are not the thing under test.
    await client.query(`
      CREATE TABLE tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE subtasks (task_id uuid NOT NULL REFERENCES tasks(id), "index" integer NOT NULL, PRIMARY KEY(task_id,"index"));
      CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE agent_types (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE principals (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);
    await client.query(sql('055_canonical_session_foundation.sql'));
    await client.query(sql('111_telemetry_envelope_foundation.sql'));
    await client.query(sql('112_telemetry_receiver_limits.sql'));
    await client.query(sql('113_telemetry_side_channel_governance.sql'));
    // Replaying the additive migration must be harmless — the runner is
    // allowed to see a partially applied deployment.
    await client.query(sql('113_telemetry_side_channel_governance.sql'));

    // Two principals, so "another connector's blob" is a real other connector
    // and not a fabricated uuid the FK would have refused for the wrong reason.
    const connector = (await client.query(
      'INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id as string;
    const otherConnector = (await client.query(
      'INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id as string;

    const redacted = { schema_version: 'rh.ai.telemetry/1.0', kind: 'agent_step', source: { product: 'p' } };
    const body = JSON.stringify(redacted);
    const hash = sha256(body);
    const key = `rhraw/1:${connector}:${hash}`;

    /** Run `work`; return the constraint name PostgreSQL refused it with. */
    const refusedBy = async (label: string, work: () => Promise<unknown>): Promise<string> => {
      // The SAVEPOINT is its own statement: bundling it into a parameterized
      // query is a syntax error, and a failed probe here would read as a
      // passing negative control.
      await client.query('SAVEPOINT probe');
      try {
        await work();
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT probe');
        return String((err as { constraint?: string }).constraint ?? '');
      }
      await client.query('ROLLBACK TO SAVEPOINT probe');
      throw new Error(`${label}: the row was ACCEPTED — this governance rule is not enforced`);
    };

    const insertBlob = (values: {
      blobKey: string; connectorId: string; contentHash: string;
      tier: number; payloadClass: string; bytes: number;
    }) => client.query(
      `INSERT INTO telemetry_raw_blobs
         (blob_key, connector_id, content_hash, policy_tier, payload_class, payload,
          redaction_counts, byte_size, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, $7, NOW() + INTERVAL '90 days')`,
      [values.blobKey, values.connectorId, values.contentHash, values.tier,
        values.payloadClass, body, values.bytes]);

    // ---- §6.5.1 · the namespace is enforced, not conventional -------------
    // A key naming ANOTHER connector is the attack this CHECK exists for: with
    // it, per-source deletion would take a different source's evidence.
    assert.equal(
      await refusedBy('a blob key naming another connector', () => insertBlob({
        blobKey: `rhraw/1:${otherConnector}:${hash}`, connectorId: connector,
        contentHash: hash, tier: 0, payloadClass: 'telemetry_raw_redacted', bytes: body.length,
      })),
      'telemetry_raw_blobs_key_is_namespaced',
      'a blob key that names a different connector must be refused BY THAT CONSTRAINT');

    // …and so is a key that simply does not derive from its own row.
    assert.equal(
      await refusedBy('a hand-written blob key', () => insertBlob({
        blobKey: 'rhraw/1:whatever', connectorId: connector, contentHash: hash,
        tier: 0, payloadClass: 'telemetry_raw_redacted', bytes: body.length,
      })),
      'telemetry_raw_blobs_key_is_namespaced',
      'a key not derived from (connector_id, content_hash) must be refused');

    // ---- §6.5.1 · Tier 0/1 may hold a REDACTED payload and nothing else ---
    assert.equal(
      await refusedBy('a Tier-0 governed (unredacted) payload', () => insertBlob({
        blobKey: key, connectorId: connector, contentHash: hash,
        tier: 0, payloadClass: 'telemetry_raw_governed', bytes: body.length,
      })),
      'telemetry_raw_blobs_tier01_is_redacted',
      'a Tier-0 source storing an unredacted original must be refused — that is the whole of §6.5.1');
    assert.equal(
      await refusedBy('a Tier-1 governed (unredacted) payload', () => insertBlob({
        blobKey: key, connectorId: connector, contentHash: hash,
        tier: 1, payloadClass: 'telemetry_raw_governed', bytes: body.length,
      })),
      'telemetry_raw_blobs_tier01_is_redacted',
      'Tier 1 is governed by the same sentence as Tier 0');

    // ---- the good row, and the pointer it is for --------------------------
    await insertBlob({
      blobKey: key, connectorId: connector, contentHash: hash,
      tier: 0, payloadClass: 'telemetry_raw_redacted', bytes: body.length,
    });

    const account = (await client.query(
      'INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id as string;

    const eventId = (await client.query(
      `INSERT INTO session_events (
         attempt_id, source, source_instance, stream_generation, event_kind,
         payload, payload_hash, redaction_policy_version, idempotency_key,
         connector_id, account_id, source_product, policy_tier, schema_version,
         observed_at, raw_ref)
       VALUES (NULL, 'probe-adapter', 'unattributed', 'envelope:none', 'agent_step',
               $1::jsonb, $2, 'rh.telemetry.tier0/1.0', $3,
               $4, $5, 'p', 0, 'rh.ai.telemetry/1.0', NOW(), $6)
       RETURNING event_id`,
      [body, sha256(`${body}event`), `probe-identity-${process.pid}`, connector, account, key],
    )).rows[0].event_id as string;

    // A dangling pointer must be impossible: raw_ref is a real foreign key.
    assert.equal(
      await refusedBy('an event pointing at a blob that does not exist', () => client.query(
        `UPDATE session_events SET raw_ref = $1 WHERE event_id = $2`,
        [`rhraw/1:${connector}:${sha256('nothing stored under this')}`, eventId])),
      'session_events_raw_ref_fkey',
      'raw_ref must be a foreign key, so an event cannot point at a blob that was never written');

    // ---- deletion is provable and does NOT mutate Tier-0 history ----------
    // §6.3: "events carry content by reference — Tier-2 deletion cannot orphan
    // or mutate Tier-0/1 history." The same must hold for the raw store: when
    // retention erases a blob the event metadata survives, minus its pointer.
    await client.query(`DELETE FROM telemetry_raw_blobs WHERE blob_key = $1`, [key]);
    const after = (await client.query(
      `SELECT raw_ref, payload_hash FROM session_events WHERE event_id = $1`, [eventId])).rows[0];
    assert.equal(after.raw_ref, null, 'erasing a blob must clear the pointer');
    assert.equal(typeof after.payload_hash, 'string',
      'erasing a blob must NOT remove the event — Tier-0 metadata outlives the raw payload');

    // ---- §6.5.2 · an envelope-plane quarantine row carries owner AND expiry
    const quarantineRow = (owner: string | null, tier: number | null, expires: string | null) => client.query(
      `INSERT INTO session_quarantine
         (attempt_id, source, source_instance, reason_code, source_key_hash, payload_hash,
          safe_metadata, connector_id, policy_tier, expires_at)
       VALUES (NULL, 'probe-adapter', 'unattributed', 'INVALID_ENVELOPE', $1, NULL,
               '{}'::jsonb, $2, $3, $4::timestamptz)`,
      [sha256(`key-${Math.random()}`), owner, tier, expires]);

    assert.equal(
      await refusedBy('a quarantine row with an owner but no retention',
        () => quarantineRow(connector, 0, null)),
      'session_quarantine_envelope_governance_check',
      '§6.5.2 calls the retention MANDATORY — a caller must not be able to omit it');
    assert.equal(
      await refusedBy('a quarantine row with retention but no owner',
        () => quarantineRow(null, null, new Date(Date.now() + 86_400_000).toISOString())),
      'session_quarantine_envelope_governance_check',
      'an unowned envelope-plane row would make the per-connector quota unenforceable');

    // The 055 exemption is deliberate and must keep working: rows written
    // before the envelope plane existed have no connector, and a NOT NULL here
    // would have rewritten their history.
    await quarantineRow(null, null, null);
    await quarantineRow(connector, 0, new Date(Date.now() + 86_400_000).toISOString());

    // ---- §6.5.2 · the budget row, and drop-and-count arithmetic -----------
    // On a principal of its own, so the live quarantine case further down
    // starts from an EMPTY budget rather than one this control pre-spent.
    const budgetOnly = (await client.query(
      'INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id as string;
    await client.query(
      `INSERT INTO telemetry_quarantine_budget (connector_id, stored_count, dropped_total,
                                                quarantined_total)
            VALUES ($1, 3, 17, 20)`, [budgetOnly]);
    assert.equal(
      await refusedBy('a negative drop count', () => client.query(
        `UPDATE telemetry_quarantine_budget SET dropped_total = -1 WHERE connector_id = $1`, [budgetOnly])),
      'telemetry_quarantine_budget_dropped_total_check',
      'the drop count is evidence; it may not go backwards into nonsense');

    // ---- TS-9 · the receipt ledger accepts the telemetry classes ----------
    for (const payloadClass of ['telemetry_event_metadata', 'telemetry_raw_blob', 'telemetry_quarantine']) {
      await client.query(
        `INSERT INTO session_retention_receipts
           (policy_version, attempt_id, payload_class, source_event_id, action,
            copies_examined, copies_removed, evidence_hash)
         VALUES ('ts9/1', NULL, $1, NULL, 'expired', 5, 5, $2)`,
        [payloadClass, sha256(payloadClass)]);
    }
    assert.equal(
      await refusedBy('a receipt claiming more removed than examined', () => client.query(
        `INSERT INTO session_retention_receipts
           (policy_version, attempt_id, payload_class, source_event_id, action,
            copies_examined, copies_removed, evidence_hash)
         VALUES ('ts9/1', NULL, 'telemetry_raw_blob', NULL, 'erased', 1, 2, $1)`,
        [sha256('overclaim')])),
      'session_retention_receipts_check',
      'a receipt that removed more copies than it examined is not evidence, it is a claim');

    // ---- THE PRODUCTION WRITE PATH, against these very constraints -------
    // Everything above proves the schema REFUSES the wrong rows. A schema that
    // only refuses is still useless if the shipped store writes something else,
    // so this drives `TelemetryEnvelopeStore.store()` itself — no hand-written
    // INSERT that could drift from it — and reads back what landed.
    const store = new TelemetryEnvelopeStore({
      query: (text: string, params?: unknown[]) => client.query(text, params),
    } as never);
    const mine: TelemetryPrincipalBinding = {
      accountId: account, connectorId: connector, agentId: null, policyTier: 0,
    };
    const theirs: TelemetryPrincipalBinding = {
      accountId: account, connectorId: otherConnector, agentId: null, policyTier: 0,
    };

    const first = mustAccept(await store.store(mine, envelope(), { observedAt }));
    assert.equal(first.duplicate, false, 'the first write is not a duplicate');

    const blobRow = (await client.query(
      `SELECT connector_id, policy_tier, payload_class, byte_size, expires_at, payload, redaction_counts
         FROM telemetry_raw_blobs WHERE blob_key = $1`, [first.rawRef])).rows[0];
    assert.ok(blobRow, 'the governed raw blob must be written by the SAME statement as the event');
    assert.equal(blobRow.connector_id, connector, 'the blob belongs to the AUTHENTICATED connector');
    assert.equal(blobRow.policy_tier, 0);
    assert.equal(blobRow.payload_class, 'telemetry_raw_redacted', 'Tier 0 stores the redacted payload (§6.5.1)');
    assert.ok(blobRow.byte_size > 0);
    assert.equal(blobRow.payload.source.raw_ref, null,
      'the BLOB holds the record as the policy left it — the pointer belongs to the event');
    assert.equal(typeof blobRow.redaction_counts.fieldsDropped, 'number',
      'the fidelity loss travels with the blob, or it is invisible');

    const eventRow = (await client.query(
      `SELECT raw_ref, payload FROM session_events WHERE idempotency_key = $1`,
      [first.identityKey])).rows[0];
    assert.equal(eventRow.raw_ref, first.rawRef, 'the event points at the blob it was written with');
    assert.equal(eventRow.payload.source.raw_ref, first.rawRef,
      'and the stored record carries the pointer, so its payload_hash covers it');

    // TS-9 at the write, from the configured bound rather than a literal.
    const keptDays = Math.round(
      (new Date(blobRow.expires_at).getTime() - observedAt.getTime()) / 86_400_000);
    assert.equal(keptDays, telemetryEventRetentionDays(),
      'the blob expires by the CONFIGURED retention, not by a number typed into the write path');

    // A REPEAT is a duplicate event, and it stores NOTHING — not a second copy
    // of the payload, and not a pointer it did not write.
    const again = mustAccept(await store.store(mine, envelope(), { observedAt: referencedAgainAt }));
    assert.equal(again.duplicate, true, 'the same envelope again is a duplicate');
    assert.equal(again.rawRef, null,
      'a duplicate stored no blob, so it must not return the key of one (review d9697a35 F1)');
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_raw_blobs WHERE connector_id = $1`,
      [connector])).rows[0].n), 1,
    'a duplicate event must not store a second copy of an identical payload');
    assert.equal(new Date((await client.query(
      `SELECT last_referenced_at FROM telemetry_raw_blobs WHERE blob_key = $1`,
      [first.rawRef])).rows[0].last_referenced_at).getTime(), observedAt.getTime(),
    'and it touched nothing: the blob write is driven by the EVENT winning');

    // ---- F1, the finding's own case: SAME identity, DIFFERENT payload ----
    // This is what the old shape got wrong. The event loses its ON CONFLICT
    // while the blob addresses different content, so the unconditional blob
    // write stored an orphan and the store returned its key while reporting a
    // duplicate. Now the blob is written only when the event wins.
    const blobsBefore = Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_raw_blobs WHERE connector_id = $1`,
      [connector])).rows[0].n);
    const mutated = mustAccept(await store.store(
      mine, envelope({ kind: 'agent_step' }), { observedAt: referencedAgainAt }));
    assert.equal(mutated.duplicate, true,
      'the identity key is unchanged, so this is still a duplicate');
    assert.equal(mutated.rawRef, null, 'and it must claim no pointer');
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_raw_blobs WHERE connector_id = $1`,
      [connector])).rows[0].n), blobsBefore,
    'NO orphan blob: a changed payload under an existing identity stores nothing at all');
    // …and no blob exists anywhere that nothing points at.
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_raw_blobs b
        WHERE b.connector_id = $1
          AND NOT EXISTS (SELECT 1 FROM session_events e WHERE e.raw_ref = b.blob_key)`,
      [connector])).rows[0].n), 0,
    'every blob this connector owns is referenced by an event');

    // §6.5.1: "a blob is never shared across sources/policies". The SAME bytes
    // from ANOTHER connector get their own blob, or per-source deletion would
    // take someone else's evidence with it.
    const stranger = mustAccept(await store.store(theirs, envelope(), { observedAt }));
    assert.notEqual(stranger.rawRef, first.rawRef, 'a blob is never shared across connectors');
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_raw_blobs WHERE connector_id = $1`,
      [otherConnector])).rows[0].n), 1, 'the stranger got its own namespaced copy');
    assert.notEqual(stranger.identityKey, first.identityKey,
      'and its dedupe identity is connector-namespaced too (§4.3)');

    // Deleting ONE connector's blobs must leave the other's untouched — the
    // whole point of putting the owner inside the key.
    await client.query('DELETE FROM telemetry_raw_blobs WHERE connector_id = $1', [connector]);
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_raw_blobs WHERE connector_id = $1`,
      [otherConnector])).rows[0].n), 1, 'per-source deletion must not reach another source');
    assert.equal((await client.query(
      `SELECT raw_ref FROM session_events WHERE idempotency_key = $1`,
      [stranger.identityKey])).rows[0].raw_ref, stranger.rawRef,
    'and the surviving connector still points at its own blob');

    // ---- §6.5.2 QUARANTINE, against a real conditional upsert ------------
    // The quota is the reason this cannot be a unit test: the decision is a
    // WHERE clause on an upsert, and a double decides only what it is told.
    // Quota of 3 in a one-hour window, so exhaustion is reachable in a probe.
    const quarantine = new TelemetryQuarantineService(
      { query: (text: string, params?: unknown[]) => client.query(text, params) } as never, 3, 3_600_000);

    const refused = (n: number) => ({
      reasonCode: 'INVALID_ENVELOPE',
      field: 'source.product',
      sourceKey: `probe:${n}`,
      payload: { source: { product: `p${n}` }, secret: 'MARKER-must-not-land-9f21' },
    });

    const q1 = await quarantine.record(mine, refused(1), observedAt);
    assert.equal(q1.stored, true, 'the first quarantine row is under quota');

    // Tier-0-stripped, asserted against the ROW rather than the call: the
    // marker must be nowhere in what actually landed.
    const qRow = (await client.query(
      `SELECT source, source_instance, reason_code, source_key_hash, payload_hash,
              safe_metadata, connector_id, policy_tier, expires_at, occurrence_count
         FROM session_quarantine WHERE quarantine_id = $1`,
      [q1.stored ? q1.quarantineId : ''])).rows[0];
    assert.ok(qRow, 'the quarantine row must exist');
    assert.equal(JSON.stringify(qRow).includes('MARKER-must-not-land-9f21'), false,
      'NO byte of the quarantined payload may appear in the stored row');
    assert.equal(qRow.source, 'telemetry_envelope',
      'the source is a constant, never a string taken from the body that was refused');
    assert.equal(qRow.connector_id, connector, 'the row carries its owner (§6.5.2)');
    assert.equal(qRow.policy_tier, 0);
    assert.match(qRow.payload_hash, /^[0-9a-f]{64}$/);
    const quarantineDays = Math.round(
      (new Date(qRow.expires_at).getTime() - observedAt.getTime()) / 86_400_000);
    assert.equal(quarantineDays, telemetryQuarantineRetentionDays(),
      'the mandatory short retention comes from the CONFIGURED bound');
    assert.ok(quarantineDays < telemetryEventRetentionDays(),
      'and it really is shorter than the accepted plane keeps');

    // A REPEAT of the identical refusal bumps the occurrence count rather than
    // writing a second row — and still spends quota, because it is still a write.
    const repeat = await quarantine.record(mine, refused(1), observedAt);
    assert.equal(repeat.stored, true);
    assert.equal(repeat.stored && repeat.occurrences, 2, 'an identical refusal bumps the occurrence count');
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM session_quarantine WHERE connector_id = $1 AND source = 'telemetry_envelope'`,
      [connector])).rows[0].n), 1, 'and stores no second row');

    // The third write is the last one the quota admits.
    assert.equal((await quarantine.record(mine, refused(2), observedAt)).stored, true);

    // The fourth is DROPPED AND COUNTED: nothing new is stored, and the
    // evidence that something was refused survives.
    const beforeRows = Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM session_quarantine WHERE connector_id = $1 AND source = 'telemetry_envelope'`,
      [connector])).rows[0].n);
    const dropped = await quarantine.record(mine, refused(3), observedAt);
    assert.equal(dropped.stored, false, 'past the quota the plane refuses the write');
    assert.equal(dropped.stored === false && dropped.code, 'QUARANTINE_QUOTA_EXHAUSTED');
    assert.equal(dropped.stored === false && dropped.droppedTotal, 1, 'and counts the drop');
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM session_quarantine WHERE connector_id = $1 AND source = 'telemetry_envelope'`,
      [connector])).rows[0].n), beforeRows,
    'a refused budget must write NOTHING — the gate and the row are one statement');

    // EXHAUSTING one connector must not touch another: the quota is per-owner.
    assert.equal((await quarantine.record(theirs, refused(4), observedAt)).stored, true,
      'one connector exhausting its quota may not silence a different connector');

    // A window roll restores the budget, and the DROP COUNT survives it —
    // the evidence of a flood has to outlive the flood.
    const afterWindow = new Date(observedAt.getTime() + 7_200_000);
    assert.equal((await quarantine.record(mine, refused(5), afterWindow)).stored, true,
      'the window rolls and the budget is restored');
    const budget = (await client.query(
      `SELECT stored_count, dropped_total, quarantined_total FROM telemetry_quarantine_budget
        WHERE connector_id = $1`, [connector])).rows[0];
    assert.equal(Number(budget.stored_count), 1, 'the new window starts from this write');
    assert.equal(Number(budget.dropped_total), 1, 'the drop count is LIFETIME and survives the roll');
    // The two counters partition the attempts: admitted writes are counted as
    // quarantined, refused ones as dropped, and nothing falls between them.
    assert.equal(Number(budget.quarantined_total), 4, 'four of the five attempts were admitted');
    assert.equal(Number(budget.quarantined_total) + Number(budget.dropped_total), 5,
      'every attempt lands in exactly one of the two counters');

    // The health alarm reads the rate. This connector has one accepted event
    // (deleted above) and five quarantines, so it must be alarming.
    const health = await quarantine.health(connector);
    assert.equal(health.quarantined, 4);
    assert.equal(health.dropped, 1);
    assert.equal(health.alarm, true, 'five quarantines against almost no accepted traffic must alarm');
    const quiet = await quarantine.health(otherConnector);
    assert.equal(quiet.alarm, false, 'one quarantine on a connector with traffic must NOT alarm');

    // ---- the alarm EVALUATOR, against the real query --------------------
    // Review `d9697a35` F2 asked for a production path, and the SQL it needed
    // is the part a double cannot check: a `= ANY($2::uuid[])` over the
    // currently-alarming set, and a lookback predicate on a nullable column.
    const raised = await quarantine.evaluateAlarms(afterWindow);
    assert.equal(raised.length, 1, 'exactly the flooding connector is signalled');
    assert.equal(raised[0].state, 'raised');
    assert.equal(raised[0].health.connectorId, connector);
    assert.equal(raised[0].health.alarm, true);

    // The second pass is SILENT — transitions, not a line every tick.
    assert.deepEqual(await quarantine.evaluateAlarms(afterWindow), [],
      'a continuing flood must not repeat its signal on the next pass');

    // …and once the connector's traffic is overwhelmingly accepted, it CLEARS.
    // The row is reached on this pass only because the alarming set is passed
    // back into the query, which is the clause a double would never exercise.
    for (let i = 0; i < 200; i += 1) {
      await client.query(
        `INSERT INTO session_events
           (attempt_id, source, source_instance, stream_generation, event_kind,
            payload, payload_hash, redaction_policy_version, idempotency_key,
            connector_id, account_id, source_product, policy_tier, schema_version, observed_at)
         VALUES (NULL, 'probe-adapter', 'unattributed', 'envelope:none', 'agent_step',
                 '{}'::jsonb, $1, 'rh.telemetry.tier0/1.0', $2, $3, $4, 'p', 0,
                 'rh.ai.telemetry/1.0', NOW())`,
        [sha256(`recovery-${i}`), `probe-recovery-${i}`, connector, account]);
    }
    // ---- F5: a current alarm is NOT pageable ----------------------------
    // Review `2b893224` F5: the sweep used to apply ONE global
    // `ORDER BY last_quarantined_at DESC ... LIMIT` over the union of "recent"
    // and "currently alarming", so with more recent rows than the limit the
    // alarming connector was displaced — and the cleanup loop, which deletes
    // every alarming key it did not see, read that as "the row is gone". The
    // alarm was forgotten: no `cleared`, and a false `raised` on reappearance.
    //
    // Two newer budget rows and a LIMIT OF ONE reproduce exactly that
    // arrangement. The flooded connector is the OLDEST of the three and has
    // just recovered, so under the old shape this pass would say nothing at
    // all; under the repair the discovery page holds one newcomer while the
    // alarming connector is a target regardless of its recency.
    for (const label of ['newer-a', 'newer-b']) {
      const newcomer = (await client.query(
        'INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id as string;
      await client.query(
        `INSERT INTO telemetry_quarantine_budget
           (connector_id, window_started_at, stored_count, quarantined_total, last_quarantined_at)
         VALUES ($1, $2, 1, 1, $2)`,
        [newcomer, new Date(afterWindow.getTime() + (label === 'newer-a' ? 1_000 : 2_000))]);
    }

    const cleared = await quarantine.evaluateAlarms(afterWindow, 1);
    assert.equal(cleared.length, 1,
      'the recovery is signalled exactly once, even with more recent rows than the limit');
    assert.equal(cleared[0].state, 'cleared');
    assert.equal(cleared[0].health.connectorId, connector,
      'and it is the DISPLACED connector that cleared — a current alarm is not pageable');
    assert.equal(cleared[0].health.alarm, false);
    assert.deepEqual(await quarantine.evaluateAlarms(afterWindow, 1), [],
      'and nothing is said about it again');

    // ---- F7: the tracked set is CAPPED, and saturation is announced ------
    // Review `7b0ea9dd` F7: F5 made current alarms unpageable and, in doing so,
    // made the tracked set unbounded — every pass could admit more and nothing
    // evicted. The cap is red-proved by EXCEEDING it: two flooding connectors,
    // a cap of one. One is taken on; the other is announced, not swallowed.
    const capped = new TelemetryQuarantineService(
      { query: (text: string, params?: unknown[]) => client.query(text, params) } as never,
      3, 3_600_000, 1);
    const floods: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const flooder = (await client.query(
        'INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id as string;
      floods.push(flooder);
      await client.query(
        `INSERT INTO telemetry_quarantine_budget
           (connector_id, window_started_at, stored_count, quarantined_total,
            dropped_total, last_quarantined_at)
         VALUES ($1, $2, 3, 40, 10, $2)`,
        [flooder, new Date(afterWindow.getTime() + 10_000 + i * 1_000)]);
    }

    const saturating = await capped.evaluateAlarms(new Date(afterWindow.getTime() + 20_000), 10);
    const raisedUnderCap = saturating.filter((signal) => signal.state === 'raised');
    const saturated = saturating.filter((signal) => signal.state === 'saturated');
    assert.equal(raisedUnderCap.length, 1, 'the cap admits exactly one of the two floods');
    assert.equal(saturated.length, 1, 'and the plane says so — ONE signal, not one per connector');
    assert.deepEqual(saturated[0], { state: 'saturated', tracked: 1, cap: 1, untracked: 1 },
      'the saturation signal carries the counts an operator needs');
    assert.ok(floods.includes(
      raisedUnderCap[0].state === 'saturated' ? '' : raisedUnderCap[0].health.connectorId),
    'the connector that WAS tracked is one of the two floods');

    // ---- TS-9 RETENTION, with receipts that cover the raw blobs ---------
    // Every claim here is about what the database did, because the sweep is
    // three statements of SQL and nothing else: a double would be asserting
    // that a string contains the words it contains.
    const retention = new TelemetryRetentionService(
      { query: (text: string, params?: unknown[]) => client.query(text, params) } as never);
    const keeper = (await client.query(
      'INSERT INTO principals DEFAULT VALUES RETURNING id')).rows[0].id as string;
    const kept: TelemetryPrincipalBinding = {
      accountId: account, connectorId: keeper, agentId: null, policyTier: 0,
    };

    const old = mustAccept(await store.store(kept, envelope({ event_id: 'evt-old' }), { observedAt }));
    const fresh = mustAccept(await store.store(kept, envelope({ event_id: 'evt-fresh' }), { observedAt }));

    // Age ONE event and its blob past the bound. The sweep's cutoff is
    // computed from the configured retention, so the test moves the ROWS
    // rather than the clock — the bound under test stays the real one.
    const longAgo = new Date(observedAt.getTime() - (telemetryEventRetentionDays() + 1) * 86_400_000);
    await client.query('UPDATE session_events SET observed_at = $1 WHERE idempotency_key = $2',
      [longAgo, old.identityKey]);
    await client.query('UPDATE telemetry_raw_blobs SET expires_at = $1 WHERE blob_key = $2',
      [longAgo, old.rawRef]);

    // An expired quarantine row, a live one, and — the control that matters —
    // a migration 055 row with no expiry at all, which this policy may NEVER
    // touch.
    const expiredQ = (await client.query(
      `INSERT INTO session_quarantine
         (attempt_id, source, source_instance, reason_code, source_key_hash, payload_hash,
          safe_metadata, connector_id, policy_tier, expires_at)
       VALUES (NULL, 'telemetry_envelope', 'unattributed', 'INVALID_ENVELOPE', $1, $2,
               '{}'::jsonb, $3, 0, $4) RETURNING quarantine_id`,
      [sha256('expired-key'), sha256('expired-payload'), keeper, longAgo])).rows[0].quarantine_id;
    await client.query(
      `INSERT INTO session_quarantine
         (attempt_id, source, source_instance, reason_code, source_key_hash, payload_hash,
          safe_metadata, connector_id, policy_tier, expires_at)
       VALUES (NULL, 'telemetry_envelope', 'unattributed', 'INVALID_ENVELOPE', $1, $2,
               '{}'::jsonb, $3, 0, $4)`,
      [sha256('live-key'), sha256('live-payload'), keeper, new Date(observedAt.getTime() + 86_400_000)]);
    const legacyQ = (await client.query(
      `INSERT INTO session_quarantine
         (attempt_id, source, source_instance, reason_code, source_key_hash, payload_hash, safe_metadata)
       VALUES (NULL, 'hermes_sqlite', 'legacy', 'POISON', $1, $2, '{}'::jsonb)
       RETURNING quarantine_id`,
      [sha256('legacy-key'), sha256('legacy-payload')])).rows[0].quarantine_id;

    const swept = await retention.sweep(observedAt);
    assert.equal(swept.receipts.length, 3, 'a sweep writes one receipt per class, always');

    const byClass = new Map(swept.receipts.map((r) => [r.payloadClass, r]));
    const events = byClass.get('telemetry_event_metadata')!;
    assert.equal(events.removed, 1, 'exactly the aged event expired');
    assert.ok(events.examined > events.removed,
      'the receipt must say what it EXAMINED as well as what it removed, or the pair proves nothing');
    assert.equal(events.evidenceHash,
      createHash('sha256').update(old.eventId ?? '', 'utf8').digest('hex'),
      'the evidence hash must be reproducible from the rows that were removed');

    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM session_events WHERE idempotency_key = $1`,
      [fresh.identityKey])).rows[0].n), 1, 'an event inside the bound must survive');
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM session_events WHERE idempotency_key = $1`,
      [old.identityKey])).rows[0].n), 0, 'and one past it must not');

    // §6.5.1: the receipts cover the raw blobs, and ORDER is why this works —
    // the event went first, so its blob was unreferenced by the time the blob
    // sweep asked.
    const blobs = byClass.get('telemetry_raw_blob')!;
    assert.equal(blobs.removed, 1, 'the aged event took its governed payload with it');
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_raw_blobs WHERE blob_key = $1`,
      [old.rawRef])).rows[0].n), 0, 'the blob is erased');
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM telemetry_raw_blobs WHERE blob_key = $1`,
      [fresh.rawRef])).rows[0].n), 1, 'while the live event keeps its own');

    const quarantined = byClass.get('telemetry_quarantine')!;
    assert.equal(quarantined.removed, 1, 'exactly the expired quarantine row went');
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM session_quarantine WHERE quarantine_id = $1`,
      [expiredQ])).rows[0].n), 0);
    // THE CONTROL. A retention policy that reached migration 055's own rows
    // would be deleting evidence that is not this plane's to expire.
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM session_quarantine WHERE quarantine_id = $1`,
      [legacyQ])).rows[0].n), 1,
    'a pre-envelope 055 quarantine row must be untouched by the telemetry policy');

    // A second pass has nothing to do and still leaves receipts, so an auditor
    // can tell "nothing was due" from "the sweep did not run".
    const again2 = await retention.sweep(observedAt);
    assert.equal(again2.receipts.length, 3);
    for (const receipt of again2.receipts) {
      assert.equal(receipt.removed, 0, `${receipt.payloadClass}: nothing was due`);
      assert.match(receipt.evidenceHash, /^[0-9a-f]{64}$/,
        'an empty sweep still records a well-formed hash');
    }
    assert.equal(again2.receipts[0].evidenceHash,
      createHash('sha256').update('', 'utf8').digest('hex'),
      'and that hash is the hash of nothing, not a placeholder');

    console.log('PROBE_RESULT=PASS');
    console.log('✅ 113 governance probe: the raw-blob namespace is a CHECK (a key naming another connector '
      + 'and a hand-written key are both refused BY NAME); Tier 0 and Tier 1 cannot store an unredacted original; '
      + 'raw_ref is a real foreign key, and erasing a blob clears the pointer while the Tier-0 event survives; '
      + 'an envelope-plane quarantine row cannot be written without BOTH an owner and a retention, while '
      + 'migration 055\'s own unowned rows still insert; the budget refuses a negative drop count; and the '
      + 'retention ledger takes the three telemetry payload classes but refuses a receipt that removed more '
      + 'than it examined. THE PRODUCTION STORE was then driven against those constraints: it writes the '
      + 'governed blob and the event in ONE statement, the blob holds the record as the policy left it while '
      + 'the event carries the pointer, the expiry comes from the CONFIGURED TS-9 bound, a duplicate event '
      + 'stores NOTHING and claims no pointer even when its payload differs so no orphan blob can exist, '
      + 'another connector sending identical bytes gets '
      + 'its OWN namespaced blob, and deleting one connector blobs leaves the other intact. QUARANTINE: a stored row carries its owner, its tier and the CONFIGURED short retention and holds no byte of the payload; an identical refusal bumps an occurrence count instead of writing twice; the fourth write past a quota of three is DROPPED AND COUNTED with nothing stored; exhausting one connector does not silence another; a window roll restores the budget while the lifetime drop count survives it; and the rate alarm fires for the flooded connector but not for the quiet one, while the production EVALUATOR raises once, stays silent as the flood continues, and clears exactly once on recovery EVEN WHEN two newer budget rows and a limit of one would have paged the alarming connector out, and the tracked set is CAPPED — two floods against a cap of one admit exactly one and announce the other as a single saturation signal. TS-9 RETENTION: a sweep expires the aged event, takes its governed blob with it because events go first, expires the quarantine row past its short bound, leaves everything inside its bound alone, NEVER touches a pre-envelope 055 quarantine row, writes one receipt per class whose examined count exceeds its removed count and whose evidence hash is reproducible from the removed ids, and writes three receipts again on a pass with nothing due.');
  } finally {
    // ROLLBACK is the whole cleanup: `CREATE SCHEMA` is transactional, so the
    // throwaway schema disappears with it. Dropping it from a SECOND
    // connection would be the R4-M1 mistake in a new place — that DROP would
    // queue behind this very transaction's locks and never return.
    try { await client.query('ROLLBACK'); } catch { /* the transaction may already be gone */ }
    client.release();
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error('113 governance probe FAILED:', err.message);
  console.error((err.stack ?? '').split('\n').slice(0, 5).join('\n'));
  console.error('PROBE_RESULT=FAIL');
  process.exit(1);
});
