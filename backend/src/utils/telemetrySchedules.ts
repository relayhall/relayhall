/**
 * The telemetry plane's background schedules, as DATA a test can hold.
 *
 * Review `2b893224` offered this shape in place of the source-text wiring
 * control that shipped with the round-1 repair: "extract scheduler registration
 * into a dependency-injected bootstrap function and assert registration and
 * callback behaviour with fake timers". The old control could only prove that a
 * line of `server.ts` still contained a name. This one runs the callback.
 *
 * `server.ts` does nothing here but hand over the real `setInterval` and the
 * real services. Everything that could be wrong — which schedules exist, how
 * often they run, what each one does with what it gets back, and what happens
 * when one rejects — is decidable without starting a listener.
 */
import type { TelemetryQuarantineAlarmSignal } from '../services/TelemetryQuarantineService';

/** Just enough of `setInterval` to register with, and to fake in a test. */
export type IntervalRegistrar = (handler: () => void, ms: number) => { unref: () => void };

export interface TelemetrySchedule {
  /** Stable name, used by the operator-facing failure line and by tests. */
  readonly label: string;
  readonly intervalMs: number;
  readonly run: () => Promise<void>;
}

export interface TelemetryScheduleDependencies {
  /** TS-9: expire each class and write its receipt. */
  sweepRetention: () => Promise<unknown>;
  /** §6.5.2: which connectors just crossed the alarm threshold, or left it. */
  evaluateAlarms: () => Promise<TelemetryQuarantineAlarmSignal[]>;
  /** Where an alarm transition goes. Identifiers and numbers only (§6.5.3). */
  emitAlarm: (line: string) => void;
  /** Secret-safe failure sink; never receives the caught value's own text. */
  onFailure: (context: string, err: unknown) => void;
}

/** TS-9 bounds are measured in days; a failed pass simply retries. */
export const TELEMETRY_RETENTION_SWEEP_MS = 3_600_000;

/** A flooding connector should be visible long before the hourly sweep. */
export const TELEMETRY_ALARM_SWEEP_MS = 300_000;

/**
 * The one line an alarm transition produces.
 *
 * Exported so the test asserts the SAME formatting production emits, and so the
 * §6.5.3 rule — identifiers and numbers, never a payload byte — is checkable in
 * one place rather than inside a template literal in `server.ts`.
 */
export function telemetryAlarmLine(signal: TelemetryQuarantineAlarmSignal): string {
  // Saturation is a property of the alarm PLANE, not of any one connector, so
  // it carries counts rather than an identity (review `7b0ea9dd` F7).
  if (signal.state === 'saturated') {
    return `[Telemetry] quarantine alarm plane SATURATED — tracking ${signal.tracked} of a maximum `
      + `${signal.cap}; ${signal.untracked} newly-alarming connector(s) could not be tracked this pass`;
  }
  const { connectorId, quarantined, dropped, accepted, rate } = signal.health;
  return `[Telemetry] quarantine alarm ${signal.state} for connector ${connectorId} `
    + `(quarantined=${quarantined} dropped=${dropped} accepted=${accepted} `
    + `rate=${rate.toFixed(3)})`;
}

export function telemetrySchedules(deps: TelemetryScheduleDependencies): TelemetrySchedule[] {
  return [
    {
      label: 'telemetry retention sweep',
      intervalMs: TELEMETRY_RETENTION_SWEEP_MS,
      run: async () => { await deps.sweepRetention(); },
    },
    {
      label: 'telemetry quarantine alarm',
      intervalMs: TELEMETRY_ALARM_SWEEP_MS,
      run: async () => {
        for (const signal of await deps.evaluateAlarms()) {
          deps.emitAlarm(telemetryAlarmLine(signal));
        }
      },
    },
  ];
}

/**
 * Register every schedule, and make a rejection the schedule's problem rather
 * than the process's. A tick that throws must not take the timer with it: the
 * next pass is the retry, and an unhandled rejection here would be a crash in a
 * background sweep nobody was awaiting.
 */
export function registerTelemetrySchedules(
  deps: TelemetryScheduleDependencies,
  registrar: IntervalRegistrar,
): TelemetrySchedule[] {
  const schedules = telemetrySchedules(deps);
  for (const schedule of schedules) {
    registrar(() => {
      schedule.run().catch((err: unknown) => {
        deps.onFailure(`[Startup] ${schedule.label} failed`, err);
      });
    }, schedule.intervalMs).unref();
  }
  return schedules;
}
