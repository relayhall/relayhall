/**
 * Card 7e66a6c2 — the child half of src/__tests__/pinnedEndpointExclusion.test.ts.
 *
 * Turn-taking between PROCESSES cannot be proved from inside one process: two
 * calls in one process would serialise on the event loop whether the mechanism
 * worked or not. So the control spawns several copies of this file at once,
 * each of which takes the pinned boot-check endpoint through the real helper,
 * holds it, and prints the two timestamps that bound its hold window.
 * Overlapping windows mean the mechanism does not work.
 *
 * Not a suite (jest collects only *.test.ts); it is spawned via tsx.
 */

import { withPinnedBootCheckRecorder } from './pinnedBootCheckEndpoint';

const holdMs = Number(process.env.PROBE_HOLD_MS ?? '400');

void (async (): Promise<void> => {
  try {
    await withPinnedBootCheckRecorder(async (recorder) => {
      const heldAt = Date.now();
      process.stdout.write(`HELD ${heldAt} ${recorder.endpoint.host}:${recorder.endpoint.port}\n`);
      // Card d4315f28: the hold is measured on the clock that stamps it. A
      // timer is not that clock: setTimeout counts the event loop's cached
      // time in whole milliseconds, so it can resolve up to 1ms before
      // Date.now() shows the full delay, and the control then read a 399ms
      // window as a probe that did not hold. So the probe waits until
      // Date.now() itself has advanced by holdMs, and prints the very reading
      // it checked.
      let releasingAt = Date.now();
      while (releasingAt - heldAt < holdMs) {
        const remaining = holdMs - (releasingAt - heldAt);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, remaining);
        });
        releasingAt = Date.now();
      }
      process.stdout.write(`RELEASING ${releasingAt}\n`);
    });
    // The exit code is SET, not forced: process.exit() can truncate a pipe that
    // has not drained, and the two timestamps are the whole point of this
    // process. Nothing holds the event loop open once the recorder is closed,
    // so it ends on its own.
    process.exitCode = 0;
  } catch (e) {
    process.stderr.write(`PROBE FAILED ${String(e)}\n`);
    process.exitCode = 1;
  }
})();
