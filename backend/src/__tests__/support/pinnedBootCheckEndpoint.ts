/**
 * Card 7e66a6c2 — the boot-check pinned endpoint is ONE exclusive resource,
 * and more than one suite needs it.
 *
 * `src/db/connection.ts` pins the boot-check pool to a single fixed loopback
 * endpoint at construction. Two suites bind a recorder there to observe
 * whether anything ever connects:
 *   - src/__tests__/bootCheckMode.test.ts
 *   - src/__tests__/orchestrationConfigurationReachability.test.ts
 * jest runs test FILES in parallel workers, so whether they collided was
 * decided by worker scheduling. The loser failed with EADDRINUSE and reported
 * a different number of assertions each run, which reads as "the change under
 * test is flaky" rather than "two suites share a port".
 *
 * Every other listener under src/__tests__ binds port 0 and reads the assigned
 * port back; src/__tests__/testPortHygiene.test.ts is the control that keeps it
 * that way. This endpoint cannot do that: the port is a PRODUCTION constant,
 * and a recorder that chose its own port would be watching the wrong one. So
 * the resource is genuinely exclusive, and this module serialises access to it:
 *
 *   1. the endpoint is READ out of `databasePoolConfig` in boot-check mode, so
 *      no test file carries the port as a literal. Change the production
 *      constant and every recorder follows it. The unit assertion in
 *      bootCheckMode.test.ts still pins the literal value it expects, which is
 *      what makes the pair a cross-check rather than a tautology: this module
 *      derives, that assertion measures against a constant it does not own.
 *   2. the LISTENING SOCKET IS THE MUTEX. A caller that finds the endpoint
 *      taken waits and tries again until it gets it.
 *   3. the recorder's close() is AWAITED before the next caller can have it, so
 *      the socket is fully down before the endpoint is offered on. The original
 *      code called close() and moved on, which left a race open even between
 *      two tests in one file.
 *
 * (2) replaced a marker-file mutex that review round 1 took apart — finding F1:
 * reclaiming a marker whose holder looked dead, and releasing one by pathname,
 * are both unownable acts, so a reclaim racing a fresh acquisition could delete
 * the new holder's marker and admit two processes at once; finding F5: the
 * control never exercised that path. Rather than add a fourth guard to a
 * userspace lock, the lock is gone. The kernel already refuses a second
 * listener on one address, it never gets the ownership question wrong, and it
 * reclaims the name the instant the holder dies — no stale records, no
 * reaping, no marker directory, and nothing that depends on TMPDIR.
 *
 * src/__tests__/pinnedEndpointExclusion.test.ts is the control: it drives three
 * SEPARATE processes through this module at once and proves their hold windows
 * do not overlap.
 */

import net from 'net';
import type { PoolConfig } from 'pg';

export interface PinnedEndpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * How long a caller waits for the endpoint before giving up and saying so.
 *
 * This MUST stay below the jest timeout of every suite that calls this module,
 * and below the kill deadline of any process spawned to call it: review round 1
 * finding F2 was a 180s ceiling sitting above 90s and 120s test ceilings, so a
 * generic "test timed out" always fired first and the true cause never reached
 * the reader. pinnedEndpointExclusion.test.ts reads those ceilings out of the
 * calling files and holds this value under the smallest of them.
 */
export const WAIT_CEILING_MS = 60_000;

const POLL_MIN_MS = 25;
const POLL_SPREAD_MS = 65;

let cachedEndpoint: PinnedEndpoint | undefined;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The endpoint the boot-check pool is pinned to, read from production.
 *
 * Inside jest the production module is loaded in an isolated registry so the
 * ambient one is untouched. In a plain process (the exclusion control spawns
 * them) there is no jest registry to isolate, so the process must have been
 * started with RELAYHALL_BOOT_CHECK=1; if the module was already loaded without
 * it this fails loudly rather than reporting the wrong endpoint.
 */
/**
 * The endpoint a recorder can actually bind, or a refusal that names what it
 * was handed.
 *
 * The upper bound is not decoration: review round 1 finding F7 was that any
 * integer reaching here, 65536 included, was cached as an endpoint and only
 * failed later inside net.listen, where the message names the wrong thing.
 * Exported so the range can be measured directly rather than inferred from a
 * production constant that is currently in range.
 */
export function bindableEndpoint(host: unknown, port: unknown): PinnedEndpoint {
  if (
    typeof host !== 'string' || host.length === 0
    || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535
  ) {
    throw new Error(
      `the boot-check pool is not pinned to a usable host:port (host=${String(host)}, port=${String(port)}). `
      + 'A recorder cannot watch an endpoint that is not a bindable address.',
    );
  }
  return { host, port };
}

export function pinnedBootCheckEndpoint(): PinnedEndpoint {
  if (cachedEndpoint) {
    return cachedEndpoint;
  }

  const priorFlag = process.env.RELAYHALL_BOOT_CHECK;
  process.env.RELAYHALL_BOOT_CHECK = '1';
  let config: PoolConfig | undefined;

  try {
    const read = (): void => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const connection = require('../../db/connection') as {
        databasePoolConfig: PoolConfig;
        BOOT_CHECK_MODE: boolean;
      };
      if (!connection.BOOT_CHECK_MODE) {
        throw new Error(
          'the production connection module was loaded OUTSIDE boot-check mode, so the pinned endpoint cannot be read '
          + 'from it. Under jest this module isolates the registry itself; a plain process must be started with '
          + 'RELAYHALL_BOOT_CHECK=1 before it loads anything.',
        );
      }
      config = connection.databasePoolConfig;
    };

    if (typeof jest === 'undefined') {
      read();
    } else {
      jest.isolateModules(read);
    }
  } finally {
    if (priorFlag === undefined) {
      delete process.env.RELAYHALL_BOOT_CHECK;
    } else {
      process.env.RELAYHALL_BOOT_CHECK = priorFlag;
    }
  }

  cachedEndpoint = bindableEndpoint(config?.host, config?.port);
  return cachedEndpoint;
}

export interface PinnedRecorder {
  readonly endpoint: PinnedEndpoint;
  /** Connection attempts observed on the pinned endpoint so far. */
  attempts(): number;
  /**
   * The bound recorder itself. Exposed so a control can drive the one failure
   * that cannot be provoked from outside — a server error AFTER a successful
   * bind, which review round 1 finding F6 showed was being swallowed.
   */
  readonly server: net.Server;
}

/**
 * One bind attempt. Resolves with `null` once the server is listening, or with
 * the error that stopped it. Both listeners are removed on either outcome:
 * review round 1 finding F6 was a retained one-shot 'error' listener that, once
 * the bind had succeeded, swallowed the NEXT server error into an
 * already-settled promise and let a dead recorder report zero attempts.
 */
function tryListen(server: net.Server, endpoint: PinnedEndpoint): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      resolve(e);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint.port, endpoint.host);
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    // A recorder destroys every socket it accepts, so close() should be
    // immediate. The ceiling only stops a wedged socket from holding the
    // endpoint for the rest of the run.
    const timer = setTimeout(finish, 5_000);
    server.close(() => finish());
  });
}

/**
 * Hold the pinned boot-check endpoint exclusively for the duration of `body`,
 * with a recorder bound to it that counts connection attempts.
 *
 * Waits for the endpoint if another process has it, up to WAIT_CEILING_MS.
 * There is deliberately NO per-call override of that ceiling: review round 2
 * finding R2-F1 was that every way of supplying one — a value above the calling
 * suite's own timeout, or NaN or Infinity, which never reach the deadline
 * comparison at all — is a way for the wait to outlive the test that is waiting.
 */
export async function withPinnedBootCheckRecorder<T>(
  body: (recorder: PinnedRecorder) => Promise<T>,
): Promise<T> {
  const endpoint = pinnedBootCheckEndpoint();
  let attempts = 0;
  const onConnection = (socket: net.Socket): void => {
    attempts += 1;
    socket.destroy();
  };

  const deadline = Date.now() + WAIT_CEILING_MS;
  let server: net.Server | undefined;

  for (;;) {
    // A fresh server per attempt. Re-listening a server that has already
    // failed to bind is defined behaviour in some node versions and not in
    // others, and this loop should not depend on which.
    const candidate = net.createServer(onConnection);
    const failure = await tryListen(candidate, endpoint);
    if (!failure) {
      server = candidate;
      break;
    }
    candidate.removeListener('connection', onConnection);

    if (failure.code !== 'EADDRINUSE') {
      throw new Error(
        `could not bind the pinned boot-check endpoint ${endpoint.host}:${endpoint.port} — ${String(failure)}.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waited ${WAIT_CEILING_MS}ms for the pinned boot-check endpoint ${endpoint.host}:${endpoint.port} and never got `
        + 'it. Suites in this tree take turns on it, so a wait this long means a process OUTSIDE the test tree is '
        + 'holding the port the boot-check pool is pinned to; that must be investigated, not skipped.',
      );
    }
    await delay(POLL_MIN_MS + Math.floor(Math.random() * POLL_SPREAD_MS));
  }

  // From here the endpoint is held, and every exit path goes through close().
  let postBindFailure: Error | undefined;
  server.on('error', (e) => { postBindFailure = e; });

  let answer: T;
  let wasListeningAfterBody = false;
  try {
    answer = await body({ endpoint, attempts: () => attempts, server });
    wasListeningAfterBody = server.listening;
  } finally {
    await closeServer(server);
  }

  // Both raised only when the body itself succeeded, so a real assertion
  // failure is never replaced by one of these.
  //
  // A recorder that stopped listening part-way through observed nothing after
  // that moment, so a zero taken from it means nothing — and a zero is exactly
  // what the calling suites assert. `listening` is read BEFORE close() runs, so
  // the ordinary path reads true. Review round 2 finding R2-F4: exposing the
  // server put `recorder.server.close()` within reach of a body, and without
  // this the call resolved cleanly with a dead recorder and a clean-looking
  // count. An error emitted after the bind (finding F6) is the same fault
  // arriving by a different route, and is reported the same way.
  if (!wasListeningAfterBody) {
    throw new Error(
      `the recorder on ${endpoint.host}:${endpoint.port} stopped listening BEFORE its turn was over. `
      + 'Any attempt count taken from it is unsound.',
    );
  }
  if (postBindFailure) {
    throw new Error(
      `the recorder on ${endpoint.host}:${endpoint.port} failed AFTER it was bound — ${String(postBindFailure)}. `
      + 'Any attempt count taken from it is unsound.',
    );
  }
  return answer;
}
