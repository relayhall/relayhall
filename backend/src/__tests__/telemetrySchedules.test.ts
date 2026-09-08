/**
 * The telemetry plane's background schedules, RUN.
 *
 * Review `d9697a35` F2 rejected an alarm nothing called. The control that
 * answered it read `server.ts` as text and asserted the name was still there —
 * enough to catch a deletion, useless against anything subtler, and unable to
 * prove the callback does what the comment beside it claims. Review `2b893224`
 * asked for the better shape, and this is it: a fake registrar, fake services,
 * fake timers, and the real callback.
 *
 * What is still NOT proved here, said plainly: that `server.ts` passes the real
 * `setInterval` and the real services. That is one line, and the last assertion
 * in this file is the one that fails if it disappears.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  TELEMETRY_ALARM_SWEEP_MS,
  TELEMETRY_RETENTION_SWEEP_MS,
  registerTelemetrySchedules,
  telemetryAlarmLine,
  telemetrySchedules,
  type IntervalRegistrar,
  type TelemetryScheduleDependencies,
} from '../utils/telemetrySchedules';
import type { TelemetryQuarantineAlarmSignal } from '../services/TelemetryQuarantineService';

const signal = (state: 'raised' | 'continuing' | 'cleared', overrides = {})
  : TelemetryQuarantineAlarmSignal => ({
    state,
    health: {
      connectorId: '11111111-1111-4111-8111-111111111111',
      quarantined: 40,
      dropped: 12,
      accepted: 8,
      rate: 0.8666,
      alarm: state !== 'cleared',
      lastQuarantinedAt: null,
      ...overrides,
    },
  });

function harness(overrides: Partial<TelemetryScheduleDependencies> = {}) {
  const registered: Array<{ handler: () => void; ms: number }> = [];
  const unrefs: number[] = [];
  const emitted: string[] = [];
  const failures: Array<{ context: string; err: unknown }> = [];

  const deps: TelemetryScheduleDependencies = {
    sweepRetention: jest.fn(async () => ({ cutoff: new Date(), receipts: [] })),
    evaluateAlarms: jest.fn(async () => [] as TelemetryQuarantineAlarmSignal[]),
    emitAlarm: (line: string) => { emitted.push(line); },
    onFailure: (context: string, err: unknown) => { failures.push({ context, err }); },
    ...overrides,
  };

  const registrar: IntervalRegistrar = (handler, ms) => {
    registered.push({ handler, ms });
    return { unref: () => { unrefs.push(ms); } };
  };

  return { deps, registrar, registered, unrefs, emitted, failures };
}

/** Let the callback's promise chain settle; the registrar is not awaited. */
const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });

describe('the telemetry schedules are registered, not merely written', () => {
  it('registers exactly the two schedules, at their stated intervals', () => {
    const h = harness();
    const schedules = registerTelemetrySchedules(h.deps, h.registrar);
    expect(schedules.map((s) => s.label)).toEqual([
      'telemetry retention sweep',
      'telemetry quarantine alarm',
    ]);
    expect(h.registered.map((r) => r.ms)).toEqual([
      TELEMETRY_RETENTION_SWEEP_MS,
      TELEMETRY_ALARM_SWEEP_MS,
    ]);
  });

  it('unrefs every timer, so a sweep cannot hold the process open', () => {
    const h = harness();
    registerTelemetrySchedules(h.deps, h.registrar);
    expect(h.unrefs).toEqual([TELEMETRY_RETENTION_SWEEP_MS, TELEMETRY_ALARM_SWEEP_MS]);
  });

  it('the alarm is timelier than the retention sweep', () => {
    // A flooding connector must be visible long before a bounds-in-days pass.
    expect(TELEMETRY_ALARM_SWEEP_MS).toBeLessThan(TELEMETRY_RETENTION_SWEEP_MS);
  });
});

describe('what each callback actually does when the timer fires', () => {
  it('the retention tick sweeps', async () => {
    const h = harness();
    registerTelemetrySchedules(h.deps, h.registrar);
    h.registered[0].handler();
    await settle();
    expect(h.deps.sweepRetention).toHaveBeenCalledTimes(1);
    expect(h.failures).toEqual([]);
  });

  it('the alarm tick emits ONE line per signal, and nothing when there are none', async () => {
    const h = harness({
      evaluateAlarms: jest.fn(async () => [signal('raised'), signal('cleared')]),
    });
    registerTelemetrySchedules(h.deps, h.registrar);
    h.registered[1].handler();
    await settle();
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[0]).toContain('quarantine alarm raised');
    expect(h.emitted[1]).toContain('quarantine alarm cleared');

    const quiet = harness();
    registerTelemetrySchedules(quiet.deps, quiet.registrar);
    quiet.registered[1].handler();
    await settle();
    expect(quiet.emitted).toEqual([]);
  });

  it('the emitted line carries identifiers and numbers, and nothing else (§6.5.3)', () => {
    const line = telemetryAlarmLine(signal('raised'));
    expect(line).toContain('11111111-1111-4111-8111-111111111111');
    expect(line).toContain('quarantined=40');
    expect(line).toContain('dropped=12');
    expect(line).toContain('accepted=8');
    expect(line).toContain('rate=0.867');
    // No free text, and nothing long enough to be a body.
    expect(line.length).toBeLessThanOrEqual(200);
  });

  it('a SATURATED plane emits counts, not an identity', async () => {
    // The condition belongs to the alarm plane rather than to any connector,
    // so the line carries what saturated and by how much (review 7b0ea9dd F7).
    const line = telemetryAlarmLine({ state: 'saturated', tracked: 500, cap: 500, untracked: 7 });
    expect(line).toContain('SATURATED');
    expect(line).toContain('500');
    expect(line).toContain('7');
    expect(line).not.toContain('11111111-1111-4111-8111-111111111111');
  });

  it('a rejecting tick reports and does NOT escape as an unhandled rejection', async () => {
    // The next pass is the retry. An unhandled rejection here would be a crash
    // in a background sweep nobody was awaiting.
    const boom = new Error('nope');
    const h = harness({ sweepRetention: jest.fn(async () => { throw boom; }) });
    registerTelemetrySchedules(h.deps, h.registrar);
    expect(() => h.registered[0].handler()).not.toThrow();
    await settle();
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0].context).toBe('[Startup] telemetry retention sweep failed');
    expect(h.failures[0].err).toBe(boom);
  });

  it('one failing schedule does not stop the other from being registered or running', async () => {
    const h = harness({
      sweepRetention: jest.fn(async () => { throw new Error('nope'); }),
      evaluateAlarms: jest.fn(async () => [signal('raised')]),
    });
    registerTelemetrySchedules(h.deps, h.registrar);
    h.registered[0].handler();
    h.registered[1].handler();
    await settle();
    expect(h.failures).toHaveLength(1);
    expect(h.emitted).toHaveLength(1);
  });

  it('builds the same schedules whether or not they are registered', () => {
    // `telemetrySchedules` is the data; `registerTelemetrySchedules` is the
    // side effect. A test that could only see the side effect would not notice
    // the two drifting apart.
    const h = harness();
    expect(telemetrySchedules(h.deps).map((s) => [s.label, s.intervalMs]))
      .toEqual(registerTelemetrySchedules(h.deps, h.registrar).map((s) => [s.label, s.intervalMs]));
  });
});

describe('and production hands over the real timer and the real services', () => {
  // The one line the harness above cannot reach. It is a source-text check and
  // says so: it cannot prove the interval fires, but it fails the moment the
  // registration is deleted, renamed, or handed a stub.
  const server = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

  it('imports and calls the bootstrap', () => {
    expect(server).toContain("import { registerTelemetrySchedules } from './utils/telemetrySchedules'");
    expect(server).toContain('registerTelemetrySchedules({');
  });

  it('passes the real services and the real setInterval', () => {
    const call = server.slice(server.indexOf('registerTelemetrySchedules({'));
    const registration = call.slice(0, call.indexOf('}, setInterval') + '}, setInterval'.length);
    expect(registration).toContain('telemetryRetentionService.sweep()');
    expect(registration).toContain('telemetryQuarantineService.evaluateAlarms()');
    expect(registration).toContain('setInterval');
  });

  it('registers only outside boot-check mode', () => {
    // The compiled boot check must not start background sweeps.
    const before = server.slice(0, server.indexOf('registerTelemetrySchedules({'));
    expect(before.lastIndexOf('if (!BOOT_CHECK_MODE) {')).toBeGreaterThan(before.lastIndexOf('\n}\n'));
  });
});
