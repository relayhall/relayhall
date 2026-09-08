import {
  TELEMETRY_QUARANTINE_ALARM_FLOOR,
  TELEMETRY_QUARANTINE_ALARM_RENOTIFY_MS,
  TELEMETRY_QUARANTINE_ALARM_MAX_TRACKED,
  TELEMETRY_QUARANTINE_INSTANCE,
  TELEMETRY_QUARANTINE_SOURCE,
  TelemetryQuarantineInputError,
  TelemetryQuarantineService,
  type TelemetryQuarantineAlarmSignal,
} from '../services/TelemetryQuarantineService';

interface Captured { text: string; params: unknown[] }

function harness(results: Array<{ rowCount: number; rows: unknown[] }>) {
  const captured: Captured[] = [];
  let call = 0;
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      return result;
    },
  };
  return { captured, pool: pool as never };
}

const binding = { connectorId: '11111111-1111-4111-8111-111111111111', policyTier: 0 } as const;
const now = new Date('2026-09-04T00:00:00.000Z');

const stored = [{ rowCount: 1, rows: [{ quarantine_id: 'q-1', occurrence_count: 1 }] }];
const overQuota = [
  { rowCount: 0, rows: [] },
  { rowCount: 1, rows: [{ dropped_total: '7' }] },
];

/** Everything the statement could possibly hand to PostgreSQL, as one string. */
function everythingSent(captured: Captured[]): string {
  return captured.map((c) => `${c.text} ${c.params.map((p) => String(p)).join(' ')}`).join(' ');
}

describe('§6.5.2 · Tier-0-stripped before persistence', () => {
  // THE control for this whole module. The property is not "we redact the
  // payload" — it is that no byte of the payload is bound to the statement AT
  // ALL. It is asserted at the SINK: whatever the service sends, the marker
  // must not be in it, in the text or in any parameter.
  const marker = 'SECRET-PAYLOAD-MARKER-ec4b1f';

  it('binds no byte of the payload — not in the text, not in any parameter', async () => {
    const { captured, pool } = harness(stored);
    await new TelemetryQuarantineService(pool).record(binding, {
      reasonCode: 'INVALID_ENVELOPE',
      field: 'outcome.error_message',
      sourceKey: 'connector:INVALID_ENVELOPE',
      payload: { outcome: { error_message: marker }, nested: [{ deep: marker }] },
    }, now);
    expect(captured).toHaveLength(1);
    expect(everythingSent(captured)).not.toContain(marker);
  });

  it('refuses to take source or instance from the body it is quarantining', async () => {
    // A quarantined body is one the validator REFUSED, so `source.adapter` is
    // unvalidated reporter input. If it could reach the TEXT column, the table
    // that exists to prevent a Tier-0 leak would BE one.
    const { captured, pool } = harness(stored);
    await new TelemetryQuarantineService(pool).record(binding, {
      reasonCode: 'INVALID_ENVELOPE',
      sourceKey: 'k',
      payload: { source: { adapter: marker, instance_ref: marker } },
    }, now);
    expect(everythingSent(captured)).not.toContain(marker);
    expect(captured[0].params).toContain(TELEMETRY_QUARANTINE_SOURCE);
    expect(captured[0].params).toContain(TELEMETRY_QUARANTINE_INSTANCE);
  });

  it('stores shapes and sizes, and a hash of the payload — never the payload', async () => {
    const { captured, pool } = harness(stored);
    const payload = { outcome: { error_message: marker } };
    await new TelemetryQuarantineService(pool).record(binding, {
      reasonCode: 'INVALID_ENVELOPE', field: 'outcome.error_message', sourceKey: 'k', payload,
    }, now);
    const metadata = JSON.parse(
      captured[0].params.find((p) => typeof p === 'string' && p.startsWith('{"field"')) as string);
    expect(metadata).toEqual({
      field: 'outcome.error_message',
      payload_bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      payload_shape: 'object',
      policy_tier: 0,
    });
    // Two SHA-256s are bound — the source key and the payload — and neither is
    // reversible into what was sent.
    const hashes = captured[0].params.filter((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p));
    expect(hashes).toHaveLength(2);
  });

  it('refuses free text where a refusal CODE belongs', async () => {
    const { pool } = harness(stored);
    await expect(new TelemetryQuarantineService(pool).record(binding, {
      reasonCode: `the envelope was bad: ${marker}`, sourceKey: 'k', payload: {},
    }, now)).rejects.toThrow(TelemetryQuarantineInputError);
  });

  it('refuses free text where a schema PATH belongs', async () => {
    const { pool } = harness(stored);
    await expect(new TelemetryQuarantineService(pool).record(binding, {
      reasonCode: 'INVALID_ENVELOPE', field: `the field called ${marker}`, sourceKey: 'k', payload: {},
    }, now)).rejects.toThrow(TelemetryQuarantineInputError);
  });
});

describe('§6.5.2 · one connector can neither exhaust nor blind the plane', () => {
  it('decides the budget and writes the row in ONE statement', async () => {
    const { captured, pool } = harness(stored);
    const outcome = await new TelemetryQuarantineService(pool).record(binding, {
      reasonCode: 'INVALID_ENVELOPE', sourceKey: 'k', payload: {},
    }, now);
    expect(outcome).toEqual({ stored: true, quarantineId: 'q-1', occurrences: 1 });
    expect(captured).toHaveLength(1);
    expect(captured[0].text).toContain('WITH');
    expect(captured[0].text).toContain('budget AS (');
    expect(captured[0].text).toContain('INSERT INTO session_quarantine');
    // No transaction: the decision IS the statement.
    expect(captured[0].text).not.toMatch(/\bBEGIN\b/);
    expect(captured[0].text).not.toMatch(/\bCOMMIT\b/);
  });

  it('a refused budget writes NOTHING, then drops and counts', async () => {
    const { captured, pool } = harness(overQuota);
    const outcome = await new TelemetryQuarantineService(pool).record(binding, {
      reasonCode: 'INVALID_ENVELOPE', sourceKey: 'k', payload: {},
    }, now);
    expect(outcome).toEqual({ stored: false, code: 'QUARANTINE_QUOTA_EXHAUSTED', droppedTotal: 7 });
    expect(captured).toHaveLength(2);
    // The counting statement runs AFTER the gate, never inside it.
    expect(captured[1].text).toContain('dropped_total = dropped_total + 1');
    expect(captured[1].text).not.toContain('INSERT INTO session_quarantine');
  });

  it('carries the quota and the window into the statement, not into a comment', async () => {
    const { captured, pool } = harness(stored);
    await new TelemetryQuarantineService(pool, 7, 1234).record(binding, {
      reasonCode: 'INVALID_ENVELOPE', sourceKey: 'k', payload: {},
    }, now);
    expect(captured[0].params[2]).toBe('1234');
    expect(captured[0].params[3]).toBe(7);
    expect(captured[0].text).toContain('stored_count < $4');
  });
});

describe('§6.5.2 · the per-connector quarantine-rate alarm', () => {
  const health = (quarantined: number, dropped: number, accepted: number) => {
    const pool = {
      query: async () => ({
        rowCount: 1,
        rows: [{
          quarantined_total: String(quarantined),
          dropped_total: String(dropped),
          accepted: String(accepted),
          last_quarantined_at: null,
        }],
      }),
    };
    return new TelemetryQuarantineService(pool as never).health(binding.connectorId);
  };

  it('is silent for a connector that has reported nothing', async () => {
    expect(await health(0, 0, 0)).toMatchObject({ rate: 0, alarm: false });
  });

  it('does NOT alarm on one bad event from a quiet connector', async () => {
    // The ratio is 100%, and it means nothing. Without the floor this alarm
    // would fire on the first malformed event every connector ever sends.
    const one = await health(1, 0, 0);
    expect(one.rate).toBe(1);
    expect(one.alarm).toBe(false);
  });

  it('alarms once the ratio is meaningful AND high', async () => {
    expect((await health(TELEMETRY_QUARANTINE_ALARM_FLOOR, 0, 5)).alarm).toBe(true);
  });

  it('stays quiet when a noisy connector is mostly healthy', async () => {
    expect((await health(10, 0, 1000)).alarm).toBe(false);
  });

  it('reports the drops, so a flood is visible after it stops', async () => {
    expect(await health(50, 900, 10)).toMatchObject({ dropped: 900, alarm: true });
  });
});

/**
 * Narrow a signal to its per-connector arm. A `saturated` signal carries counts
 * about the PLANE and has no health of its own, so reaching for one is a bug in
 * the test rather than a type to cast away.
 */
const healthOf = (signal: TelemetryQuarantineAlarmSignal) => {
  if (signal.state === 'saturated') {
    throw new Error(`expected a per-connector signal, got ${signal.state}`);
  }
  return signal.health;
};

describe('§6.5.2 · the alarm is something an operator can HEAR', () => {
  // Review `d9697a35` F2: the rate was computed and never asked for. These
  // pin the asking — the transitions, the silence between them, and the fact
  // that production actually schedules it.
  const budget = (quarantined: number, dropped: number, accepted: number) => ({
    connector_id: binding.connectorId,
    quarantined_total: String(quarantined),
    dropped_total: String(dropped),
    accepted: String(accepted),
    last_quarantined_at: new Date('2026-09-04T00:00:00.000Z'),
  });

  const evaluator = (rows: Array<Record<string, unknown>>) => {
    const state = { rows };
    const pool = { query: async () => ({ rowCount: state.rows.length, rows: state.rows }) };
    return { state, service: new TelemetryQuarantineService(pool as never) };
  };

  const T0 = new Date('2026-09-04T00:00:00.000Z');
  const later = (ms: number) => new Date(T0.getTime() + ms);

  it('RAISES once when a connector starts flooding', async () => {
    const { service } = evaluator([budget(20, 5, 10)]);
    const signals = await service.evaluateAlarms(T0);
    expect(signals).toHaveLength(1);
    expect(signals[0].state).toBe('raised');
    expect(healthOf(signals[0]).alarm).toBe(true);
  });

  it('then STAYS SILENT while the same flood continues', async () => {
    // An every-tick line is one an operator filters out, and a filtered alarm
    // is not an alarm.
    const { service } = evaluator([budget(20, 5, 10)]);
    await service.evaluateAlarms(T0);
    expect(await service.evaluateAlarms(later(60_000))).toEqual([]);
    expect(await service.evaluateAlarms(later(3_600_000))).toEqual([]);
  });

  it('re-notifies once the flood has gone on long enough', async () => {
    const { service } = evaluator([budget(20, 5, 10)]);
    await service.evaluateAlarms(T0);
    const signals = await service.evaluateAlarms(later(TELEMETRY_QUARANTINE_ALARM_RENOTIFY_MS));
    expect(signals).toHaveLength(1);
    expect(signals[0].state).toBe('continuing');
  });

  it('CLEARS when the connector recovers', async () => {
    const { state, service } = evaluator([budget(20, 5, 10)]);
    await service.evaluateAlarms(T0);
    state.rows = [budget(20, 5, 5_000)];
    const signals = await service.evaluateAlarms(later(60_000));
    expect(signals).toHaveLength(1);
    expect(signals[0].state).toBe('cleared');
    expect(healthOf(signals[0]).alarm).toBe(false);
  });

  it('says nothing at all about a connector that never alarmed', async () => {
    const { service } = evaluator([budget(1, 0, 5_000)]);
    expect(await service.evaluateAlarms(T0)).toEqual([]);
  });

  it('keeps evaluating a connector that has gone quiet, so its alarm can clear', async () => {
    // The query must include the currently-alarming set, or a connector that
    // stops reporting stays latched in alarm forever.
    const { service } = evaluator([budget(20, 5, 10)]);
    await service.evaluateAlarms(T0);
    const captured: unknown[][] = [];
    const pool = {
      query: async (_text: string, params?: unknown[]) => {
        captured.push(params ?? []);
        return { rowCount: 1, rows: [budget(20, 5, 5_000)] };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).pool = pool;
    await service.evaluateAlarms(later(60_000));
    expect(captured[0][1]).toEqual([binding.connectorId]);
  });

  it('is reachable from production — see telemetrySchedules.test.ts', () => {
    // The source-text wiring control that used to live here has been replaced
    // by a better one (review `2b893224`): the registration is now a
    // dependency-injected bootstrap, so `telemetrySchedules.test.ts` injects a
    // fake registrar and fake services and RUNS the callback. What remains
    // here is the seam that suite depends on — the evaluator must exist on the
    // service with the shape the bootstrap calls.
    const service = new TelemetryQuarantineService({ query: async () => ({ rowCount: 0, rows: [] }) } as never);
    expect(typeof service.evaluateAlarms).toBe('function');
    expect(service.evaluateAlarms.length).toBeLessThanOrEqual(2);
  });
});

describe('§6.5.2 · the tracked alarm set is BOUNDED, and saturation is announced', () => {
  // Review `7b0ea9dd` F7: making current alarms unpageable (F5) fixed the truth
  // and broke the bound — every pass could admit up to the discovery limit and
  // nothing ever evicted. The cap restores it; the SHAPE of the cap is what
  // these pin, because the wrong shape would be F5 again on purpose.
  const flooding = (id: string) => ({
    connector_id: id,
    quarantined_total: '40',
    dropped_total: '10',
    accepted: '5',
    last_quarantined_at: new Date('2026-09-04T00:00:00.000Z'),
  });
  const healthy = (id: string) => ({
    connector_id: id,
    quarantined_total: '40',
    dropped_total: '10',
    accepted: '100000',
    last_quarantined_at: new Date('2026-09-04T00:00:00.000Z'),
  });

  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  const capped = (cap: number, rows: Array<Record<string, unknown>>) => {
    const state = { rows };
    const pool = { query: async () => ({ rowCount: state.rows.length, rows: state.rows }) };
    return { state, service: new TelemetryQuarantineService(pool as never, 50, 3_600_000, cap) };
  };

  const T0 = new Date('2026-09-04T00:00:00.000Z');

  it('has a cap at all — the default is a number, not a comment', () => {
    expect(Number.isInteger(TELEMETRY_QUARANTINE_ALARM_MAX_TRACKED)).toBe(true);
    expect(TELEMETRY_QUARANTINE_ALARM_MAX_TRACKED).toBeGreaterThan(0);
  });

  it('tracks up to the cap and ANNOUNCES the rest — the red proof of the bound', async () => {
    // Exceed it: three flooding connectors, a cap of two.
    const { service } = capped(2, [flooding(id(1)), flooding(id(2)), flooding(id(3))]);
    const signals = await service.evaluateAlarms(T0);
    const raised = signals.filter((s) => s.state === 'raised');
    const saturated = signals.filter((s) => s.state === 'saturated');
    expect(raised).toHaveLength(2);
    expect(saturated).toHaveLength(1);
    expect(saturated[0]).toEqual({ state: 'saturated', tracked: 2, cap: 2, untracked: 1 });
  });

  it('says it ONCE per pass, carrying the count', async () => {
    // Saturation is a property of the plane, not of each connector that missed
    // out; a line each would be the noise this alarm avoids everywhere else.
    const { service } = capped(1, [flooding(id(1)), flooding(id(2)), flooding(id(3))]);
    const signals = await service.evaluateAlarms(T0);
    expect(signals.filter((s) => s.state === 'saturated'))
      .toEqual([{ state: 'saturated', tracked: 1, cap: 1, untracked: 2 }]);
  });

  it('is SILENT about saturation while under the cap', async () => {
    const { service } = capped(5, [flooding(id(1)), flooding(id(2))]);
    const signals = await service.evaluateAlarms(T0);
    expect(signals.every((s) => s.state !== 'saturated')).toBe(true);
  });

  it('never evicts a TRACKED alarm to make room — that would be F5 on purpose', async () => {
    const { state, service } = capped(1, [flooding(id(1))]);
    expect((await service.evaluateAlarms(T0))[0].state).toBe('raised');

    // A newcomer arrives and cannot be tracked; the incumbent must be untouched.
    state.rows = [flooding(id(1)), flooding(id(2))];
    const second = await service.evaluateAlarms(new Date(T0.getTime() + 60_000));
    expect(second).toEqual([{ state: 'saturated', tracked: 1, cap: 1, untracked: 1 }]);

    // …and the incumbent still clears when it recovers, which is the property
    // an eviction would have destroyed.
    state.rows = [healthy(id(1)), flooding(id(2))];
    const third = await service.evaluateAlarms(new Date(T0.getTime() + 120_000));
    expect(third.map((s) => s.state).sort()).toEqual(['cleared', 'raised']);
  });

  it('stays bounded across many passes of new alarmers', async () => {
    // The failure F7 described is cumulative: pass after pass admitting more.
    const { state, service } = capped(3, []);
    for (let pass = 0; pass < 10; pass += 1) {
      state.rows = Array.from({ length: 5 }, (_, i) => flooding(id(pass * 5 + i)));
      await service.evaluateAlarms(new Date(T0.getTime() + pass * 60_000));
    }
    // The only window onto the private map is the parameter the query receives.
    const seen: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).pool = {
      query: async (_t: string, params?: unknown[]) => {
        seen.push((params ?? [])[1]);
        return { rowCount: 0, rows: [] };
      },
    };
    await service.evaluateAlarms(new Date(T0.getTime() + 600_000));
    expect((seen[0] as string[]).length).toBeLessThanOrEqual(3);
  });
});
