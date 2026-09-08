/**
 * The orchestration plane's background schedules, as DATA a test can hold.
 *
 * ── WHY THIS EXISTS (card `c8f95fef`) ──
 *
 * `TaskOrchestrationService.expireActiveLeases()` was a public method NOTHING
 * called — no sweep, no cron, no server wiring. A lapsed Lease therefore stayed
 * marked `active` on a quiet board, because the only thing that reconciled the
 * column was a PRIVATE in-transaction sweep at the top of `claimReadyTask`:
 * the column got fixed when somebody happened to attempt a claim, and not
 * otherwise.
 *
 * Nothing was BROKEN by that, and the card says so plainly: `task.stuck`
 * derivation compares `expires_at` against the board clock, and the capacity
 * budgets carry `AND expires_at > NOW()`. Strategy amendment S-A5 confirms
 * lease expiry reaches the shepherd as `task.stuck(reason='lease_expired')`
 * without this method. What was wrong is that `task_execution_leases.status`
 * did not mean what it said, which is a trap for the next person who writes a
 * query against it and does not also check the clock.
 *
 * ── WHAT THE SWEEP ACTUALLY CHANGES, INCLUDING WHAT THE CARD DID NOT SAY ──
 *
 * More than the column. `trg_task_execution_lease_assignment_compat` fires on
 * a status UPDATE and clears `task_assignments.current_lease_id` (bumping that
 * row's `revision` and `updated_at`) when a Lease leaves `active`. So the
 * assignment mirror ALSO kept pointing at a dead Lease until somebody claimed.
 * The sweep fixes both, and it fixes the second one only because the shipped
 * trigger does that work — this module adds no mirror logic of its own.
 *
 * It emits NOTHING. No feed event, no notice, no audit record: the shepherd
 * already hears about a lapsed Lease from the `task.stuck` sweep, and a second
 * source of that news would be a duplicate announcement rather than better
 * hygiene. The suite asserts the silence rather than assuming it.
 *
 * ── WHY DATA AND NOT A `setInterval` IN `server.ts` ──
 *
 * Review `d9697a35` F2 found a telemetry alarm computed but never asked for,
 * and the control that answered it could only prove a line of `server.ts` still
 * contained a name. Review `2b893224` asked for better, and `telemetrySchedules`
 * is the shape that answered: registration extracted, so a test injects a fake
 * registrar and fake services and RUNS the callback. This card is the same
 * class of defect — a routine nothing invoked — so it takes the same shape
 * rather than adding a fourth inline timer for a future census to read as text.
 */

/** Just enough of `setInterval` to register with, and to fake in a test. */
export type IntervalRegistrar = (handler: () => void, ms: number) => { unref: () => void };

export interface OrchestrationSchedule {
  /** Stable name, used by the operator-facing failure line and by tests. */
  readonly label: string;
  readonly intervalMs: number;
  readonly run: () => Promise<void>;
}

export interface OrchestrationScheduleDependencies {
  /** Flip every `active` Lease already past `expires_at`. Returns the count. */
  expireActiveLeases: () => Promise<number>;
  /** Secret-safe failure sink; never receives the caught value's own text. */
  onFailure: (context: string, err: unknown) => void;
}

/**
 * The `task.stuck` sweep's cadence, deliberately.
 *
 * The two answer about the same event from opposite sides — that sweep decides
 * a lapsed Lease is worth telling the shepherd about, this one records that it
 * lapsed — so a Lease should not be able to be reported stuck for a whole
 * minute while its own row still claims to be active. A slower cadence would
 * cost nothing in correctness and would reintroduce, in miniature, exactly the
 * window this card exists to close.
 */
export const LEASE_EXPIRY_SWEEP_MS = 60_000;

export function orchestrationSchedules(
  deps: OrchestrationScheduleDependencies,
): OrchestrationSchedule[] {
  return [
    {
      label: 'lease expiry sweep',
      intervalMs: LEASE_EXPIRY_SWEEP_MS,
      // The count is not read. It is not a health signal — a busy board expires
      // Leases constantly and a quiet one expires none — and logging it every
      // minute would be noise in front of the lines that mean something. The
      // predicate is served by `idx_task_execution_leases_expiry`, which is on
      // exactly `(status, expires_at)`, so a pass that finds nothing is a
      // partial-index probe rather than a scan.
      run: async () => { await deps.expireActiveLeases(); },
    },
  ];
}

/**
 * Register every schedule, and make a rejection the schedule's problem rather
 * than the process's. A tick that throws must not take the timer with it: the
 * next pass is the retry, and an unhandled rejection here would be a crash in a
 * background sweep nobody was awaiting.
 */
export function registerOrchestrationSchedules(
  deps: OrchestrationScheduleDependencies,
  registrar: IntervalRegistrar,
): OrchestrationSchedule[] {
  const schedules = orchestrationSchedules(deps);
  for (const schedule of schedules) {
    registrar(() => {
      schedule.run().catch((err: unknown) => {
        deps.onFailure(`[Startup] ${schedule.label} failed`, err);
      });
    }, schedule.intervalMs).unref();
  }
  return schedules;
}
