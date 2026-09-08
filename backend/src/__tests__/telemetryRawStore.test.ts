import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  TELEMETRY_RAW_BLOB_CTE,
  TELEMETRY_RAW_PAYLOAD_CLASS,
  describeTelemetryRawBlob,
  rawBlobParams,
  telemetryRawBlobKey,
  telemetryRawBlobPayload,
} from '../services/TelemetryRawStore';
import { canonicalJson } from '../utils/telemetryEnvelopeValidator';
import type { TelemetryPrincipalBinding } from '../types/TelemetryEnvelope';
import type { TelemetryRedactionCounts } from '../services/TelemetryPolicyEngine';

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../migrations/113_telemetry_side_channel_governance.sql'), 'utf8');

const binding: TelemetryPrincipalBinding = {
  connectorId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  agentId: null,
  policyTier: 0,
} as TelemetryPrincipalBinding;

const counts: TelemetryRedactionCounts = {
  attributesDropped: 1,
  identifiersPseudonymized: 2,
  structuralLabelsDropped: 0,
  contentReferencesDropped: 0,
  fieldsDropped: 3,
};

const observedAt = new Date('2026-09-04T00:00:00.000Z');

describe('§6.5.1 · the blob key is the database\'s key, not this module\'s idea of one', () => {
  // The OUTSIDE ANCHOR. The scheme is enforced by a CHECK in migration 113;
  // if this test only compared the builder to a string typed here, the two
  // could drift apart and both stay green. The expectation is therefore READ
  // OUT OF THE MIGRATION, so a change to the CHECK reddens this test.
  it('is built exactly as the migration CHECK derives it', () => {
    const check = /blob_key = '([^']+)'\s*\|\|\s*connector_id::text\s*\|\|\s*'([^']+)'\s*\|\|\s*content_hash/
      .exec(MIGRATION);
    expect(check).not.toBeNull();
    const [, prefix, separator] = check!;
    const hash = 'a'.repeat(64);
    expect(telemetryRawBlobKey(binding.connectorId, hash))
      .toBe(`${prefix}${binding.connectorId}${separator}${hash}`);
  });

  it('names the AUTHENTICATED connector, so per-source deletion is well defined', () => {
    const blob = describeTelemetryRawBlob(binding, { source: { product: 'p' } }, counts, observedAt);
    expect(blob.blobKey.includes(binding.connectorId)).toBe(true);
    expect(blob.blobKey.includes('99999999')).toBe(false);
  });

  it('writes only the payload class the migration admits at Tier 0', () => {
    expect(TELEMETRY_RAW_BLOB_CTE).toContain(`'${TELEMETRY_RAW_PAYLOAD_CLASS}'`);
    // …and the migration must forbid the other class here, or the constant is
    // the only thing standing between Tier 0 and an unredacted original.
    expect(MIGRATION).toContain("CHECK (policy_tier = 2 OR payload_class = 'telemetry_raw_redacted')");
  });
});

describe('§6.5.1 · content addressing', () => {
  it('collapses identical payloads whose keys were written in a different order', () => {
    const a = describeTelemetryRawBlob(binding, { kind: 'agent_step', phase: 'end' }, counts, observedAt);
    const b = describeTelemetryRawBlob(binding, { phase: 'end', kind: 'agent_step' }, counts, observedAt);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.blobKey).toBe(b.blobKey);
  });

  it('separates payloads that differ by one byte', () => {
    const a = describeTelemetryRawBlob(binding, { kind: 'agent_step' }, counts, observedAt);
    const b = describeTelemetryRawBlob(binding, { kind: 'agent_stop' }, counts, observedAt);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('hashes the canonical form the rest of the plane hashes', () => {
    const record = { kind: 'agent_step', source: { product: 'p' } };
    const addressed = canonicalJson(telemetryRawBlobPayload(record));
    const blob = describeTelemetryRawBlob(binding, record, counts, observedAt);
    expect(blob.contentHash)
      .toBe(createHash('sha256').update(addressed, 'utf8').digest('hex'));
    expect(blob.serialized).toBe(addressed);
    expect(blob.byteSize).toBe(Buffer.byteLength(addressed, 'utf8'));
  });

  it('addresses the REPORTED payload, so the receiver clock cannot defeat dedupe', () => {
    // Without this the store is content-addressed in name only: `observed_at`
    // differs for every event, so two identical reports would each keep a copy.
    const reported = { kind: 'agent_step', source: { product: 'p' } };
    const early = describeTelemetryRawBlob(
      binding, { ...reported, observed_at: '2026-09-04T00:00:00.000Z', policy: { tier: 0, version: 'v1' } },
      counts, observedAt);
    const late = describeTelemetryRawBlob(
      binding, { ...reported, observed_at: '2026-09-04T06:00:00.000Z', policy: { tier: 0, version: 'v1' } },
      counts, new Date('2026-09-04T06:00:00.000Z'));
    expect(early.blobKey).toBe(late.blobKey);
    // …but a difference the REPORTER made still separates them.
    const different = describeTelemetryRawBlob(
      binding, { ...reported, kind: 'agent_stop', observed_at: '2026-09-04T00:00:00.000Z' }, counts, observedAt);
    expect(different.blobKey).not.toBe(early.blobKey);
  });

  it('never addresses bytes that contain the pointer those bytes produce', () => {
    const withPointer = {
      kind: 'agent_step',
      source: { product: 'p', raw_ref: 'rhraw/1:someone:else' },
    };
    const stripped = telemetryRawBlobPayload(withPointer) as { source: { raw_ref: unknown } };
    expect(stripped.source.raw_ref).toBeNull();
    expect(describeTelemetryRawBlob(binding, withPointer, counts, observedAt).blobKey)
      .toBe(describeTelemetryRawBlob(
        binding, { kind: 'agent_step', source: { product: 'p', raw_ref: null } }, counts, observedAt).blobKey);
  });

  it('carries the redaction counts, so fidelity loss is visible', () => {
    const blob = describeTelemetryRawBlob(binding, { kind: 'agent_step' }, counts, observedAt);
    const params = rawBlobParams(blob, binding.connectorId);
    expect(JSON.parse(params[5] as string)).toEqual(counts);
  });

  it('binds the connector the CALLER authenticated, not one taken from the blob', () => {
    const blob = describeTelemetryRawBlob(binding, { kind: 'agent_step' }, counts, observedAt);
    const params = rawBlobParams(blob, binding.connectorId);
    expect(params[0]).toBe(blob.blobKey);
    expect(params[1]).toBe(binding.connectorId);
    expect(params[2]).toBe(blob.contentHash);
    expect(params[3]).toBe(0);
  });
});

describe('TS-9 · retention is configurable, and refuses what it cannot honour', () => {
  const load = (env: Record<string, string | undefined>) => {
    jest.resetModules();
    const previous = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      return require('../utils/telemetryRetention');
    } finally {
      process.env = previous;
    }
  };

  it('defaults to the ratified 90 days at event grain (TS-9)', () => {
    const m = load({
      RELAYHALL_TELEMETRY_RETENTION_DAYS: undefined,
      RELAYHALL_TELEMETRY_QUARANTINE_RETENTION_DAYS: undefined,
    });
    expect(m.telemetryEventRetentionDays()).toBe(90);
    expect(m.TELEMETRY_EVENT_RETENTION_DAYS_DEFAULT).toBe(90);
  });

  it('honours a deployment override', () => {
    const m = load({ RELAYHALL_TELEMETRY_RETENTION_DAYS: '30' });
    expect(m.telemetryEventRetentionDays()).toBe(30);
    expect(m.telemetryEventExpiry(new Date('2026-01-01T00:00:00.000Z')).toISOString())
      .toBe('2026-01-31T00:00:00.000Z');
  });

  for (const bad of ['0', '-1', 'ninety', '90.5', '4000', '9e1']) {
    it(`REFUSES TO LOAD on ${JSON.stringify(bad)} rather than silently keeping the default`, () => {
      expect(() => load({ RELAYHALL_TELEMETRY_RETENTION_DAYS: bad })).toThrow(/whole number of days/);
    });
  }

  it('treats a BLANK variable as unset, which selects the documented default', () => {
    // Deliberate, and worth pinning: an empty value is how a deployment tool
    // writes "I did not set this", and refusing to boot on it would make the
    // canary fire on the one case that is not a misconfiguration.
    const m = load({ RELAYHALL_TELEMETRY_RETENTION_DAYS: '   ' });
    expect(m.telemetryEventRetentionDays()).toBe(90);
  });

  it('refuses a quarantine window longer than the accepted plane keeps', () => {
    expect(() => load({
      RELAYHALL_TELEMETRY_RETENTION_DAYS: '30',
      RELAYHALL_TELEMETRY_QUARANTINE_RETENTION_DAYS: '31',
    })).toThrow(/must not exceed/);
  });

  it('keeps quarantine SHORT by default (§6.5.2)', () => {
    const m = load({
      RELAYHALL_TELEMETRY_RETENTION_DAYS: undefined,
      RELAYHALL_TELEMETRY_QUARANTINE_RETENTION_DAYS: undefined,
    });
    expect(m.telemetryQuarantineRetentionDays()).toBeLessThan(m.telemetryEventRetentionDays());
  });
});
