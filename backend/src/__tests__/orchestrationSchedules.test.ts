/**
 * The orchestration plane's background schedule, RUN (card `c8f95fef`).
 *
 * `expireActiveLeases()` was a public method nothing called. A control that
 * read `server.ts` as text and found the name would catch a deletion and
 * nothing subtler — and it is the exact control review `d9697a35` F2 rejected
 * for the telemetry alarm, on a defect of this same class. So the registration
 * is data (`utils/orchestrationSchedules`) and this suite injects a fake
 * registrar, a fake service and fake timers, and runs the real callback.
 *
 * What is still NOT proved here, said plainly: that the sweep actually flips
 * rows in PostgreSQL, and that flipping them clears the assignment mirror
 * without emitting anything. Those are properties of a database and a trigger,
 * which no double has — runbook `daf703a6` §2 names mocks-of-the-thing a
 * standing rejection class — so they are proved on REAL PostgreSQL through the
 * production service in `backend/scripts/test-c3-lease-lifecycle.js`, section
 * 10. The last assertion in this file is the one that fails if `server.ts`
 * stops handing over the real timer and the real service.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  LEASE_EXPIRY_SWEEP_MS,
  orchestrationSchedules,
  registerOrchestrationSchedules,
  type IntervalRegistrar,
  type OrchestrationScheduleDependencies,
} from '../utils/orchestrationSchedules';
import { taskOrchestrationService } from '../services/TaskOrchestrationService';
import { loadMutatedModule } from './support/moduleMutation';

/** Multi-line anchors are assembled from lines, never from escapes. */
const NEWLINE = String.fromCharCode(10);
/** The SERVICE method, not the injected dependency of the same name. */
const SERVICE_CALL = 'taskOrchestrationService.expireActiveLeases(';

function harness(overrides: Partial<OrchestrationScheduleDependencies> = {}) {
  const registered: Array<{ handler: () => void; ms: number }> = [];
  const unrefs: number[] = [];
  const failures: Array<{ context: string; err: unknown }> = [];

  const deps: OrchestrationScheduleDependencies = {
    expireActiveLeases: jest.fn(async () => 0),
    onFailure: (context: string, err: unknown) => { failures.push({ context, err }); },
    ...overrides,
  };

  const registrar: IntervalRegistrar = (handler, ms) => {
    registered.push({ handler, ms });
    return { unref: () => { unrefs.push(ms); } };
  };

  return { deps, registrar, registered, unrefs, failures };
}

describe('the lease expiry sweep is registered, and it runs', () => {
  it('declares exactly one schedule, at the task.stuck sweep cadence', () => {
    const { deps } = harness();
    expect(orchestrationSchedules(deps).map((schedule) => ({
      label: schedule.label, intervalMs: schedule.intervalMs,
    }))).toEqual([{ label: 'lease expiry sweep', intervalMs: 60_000 }]);
    // The constant and the literal above are written independently on purpose:
    // an assertion that read the constant would agree with any value it took.
    expect(LEASE_EXPIRY_SWEEP_MS).toBe(60_000);
  });

  it('registers with the timer it is handed, and unrefs it', () => {
    // Unref'd because a background sweep must never be the reason a process
    // refuses to exit — the same property every other sweep on this board has.
    const { deps, registrar, registered, unrefs } = harness();
    registerOrchestrationSchedules(deps, registrar);
    expect(registered.map((entry) => entry.ms)).toEqual([LEASE_EXPIRY_SWEEP_MS]);
    expect(unrefs).toEqual([LEASE_EXPIRY_SWEEP_MS]);
  });

  it('a tick CALLS the service — which is the whole of what this card is about', async () => {
    const expireActiveLeases = jest.fn(async () => 3);
    const { deps, registrar, registered } = harness({ expireActiveLeases });
    registerOrchestrationSchedules(deps, registrar);
    expect(expireActiveLeases).not.toHaveBeenCalled();
    registered[0].handler();
    await Promise.resolve();
    expect(expireActiveLeases).toHaveBeenCalledTimes(1);
    // …and again on the next tick: a sweep that ran once would leave every
    // later lapse exactly as unswept as before the card.
    registered[0].handler();
    await Promise.resolve();
    expect(expireActiveLeases).toHaveBeenCalledTimes(2);
  });

  it('a rejecting tick is reported and does NOT take the timer with it', async () => {
    const boom = new Error('database unavailable');
    const expireActiveLeases = jest.fn<Promise<number>, []>(async () => { throw boom; });
    const { deps, registrar, registered, failures } = harness({ expireActiveLeases });
    registerOrchestrationSchedules(deps, registrar);

    expect(() => registered[0].handler()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([{ context: '[Startup] lease expiry sweep failed', err: boom }]);

    // The next pass is the retry. An unhandled rejection here would be a crash
    // in a sweep nobody is awaiting, which is worse than the stale column.
    expireActiveLeases.mockImplementationOnce(async () => 1);
    registered[0].handler();
    await Promise.resolve();
    expect(expireActiveLeases).toHaveBeenCalledTimes(2);
  });

  it('MUTATION: with the call taken out of the SHIPPED run(), a tick sweeps nothing', async () => {
    // The control for the control, and it mutates shipped text rather than
    // building a hollow stand-in: a stand-in proves the stand-in behaves as
    // written, which is the failure class this project has been burned by. The
    // anchor is read from the file at run time, so if `run` is rewritten and
    // stops matching, the harness throws instead of drilling nothing.
    const line = '      run: async () => { await deps.expireActiveLeases(); },';
    const mutant = loadMutatedModule<typeof import('../utils/orchestrationSchedules')>(
      'utils/orchestrationSchedules.ts',
      [{ find: line, replace: '      run: async () => { void deps.expireActiveLeases; },' }],
    );
    const expireActiveLeases = jest.fn(async () => 0);
    const { deps, registrar, registered } = harness({ expireActiveLeases });
    mutant.registerOrchestrationSchedules(deps, registrar);
    registered[0].handler();
    await Promise.resolve();
    expect(expireActiveLeases).not.toHaveBeenCalled();

    // …and the shipped one, on the identical harness, does sweep.
    registerOrchestrationSchedules(deps, registrar);
    registered[1].handler();
    await Promise.resolve();
    expect(expireActiveLeases).toHaveBeenCalledTimes(1);
  });
});

describe('server.ts hands over the real timer and the real service', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');

  it('registers the schedules, with the production service and setInterval', () => {
    // The one line the suite above cannot reach. It is text, and text is a weak
    // control — which is why it carries only this one claim, and why the
    // BEHAVIOUR it enables is measured on real PostgreSQL rather than here.
    // Pinned as ONE contiguous block. Three separate `toContain`s would be
    // satisfied by three lines scattered across the file — and `}, setInterval
    // as never);` on its own is satisfied by the telemetry registration.
    expect(source).toContain([
      '  registerOrchestrationSchedules({',
      '    expireActiveLeases: () => taskOrchestrationService.expireActiveLeases(),',
      '    onFailure: (context: string, err: unknown) => { logCaughtWarning(context, err as Error); },',
      '  }, setInterval as never);',
    ].join(NEWLINE));
  });

  it('the method it names is real, and is the one the sweep needs', () => {
    // Not text: the binding itself. A rename that left the string above intact
    // would fail here instead of shipping a sweep that calls nothing.
    expect(typeof taskOrchestrationService.expireActiveLeases).toBe('function');
    expect(taskOrchestrationService.expireActiveLeases.length).toBe(0);
  });

  it('a CENSUS of the tree: the method has exactly one caller, and it is the sweep', () => {
    // The card's finding was "grep across backend/src returns only its own
    // declaration". This is that grep, kept — turned around so it now fails if
    // the method goes back to having no caller, and equally if a second timer
    // starts sweeping the same rows on a different cadence.
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
        return entry.isFile() && full.endsWith('.ts') ? [full] : [];
      });
    const srcRoot = path.join(__dirname, '..');
    const callers = walk(srcRoot)
      .filter((file) => fs.readFileSync(file, 'utf8').includes(SERVICE_CALL))
      .map((file) => path.relative(srcRoot, file).split(path.sep).join('/'))
      .sort();
    expect(callers).toEqual(['server.ts']);

    // `claimReadyTask` keeps its own `expireLeases(client)` inside the claim
    // transaction, and that is not duplication to fold away: it must happen
    // INSIDE the claim's transaction, and this sweep runs outside every one.
    const service = fs.readFileSync(
      path.join(srcRoot, 'services', 'TaskOrchestrationService.ts'), 'utf8',
    );
    expect(service).toContain('private async expireLeases(client: PoolClient)');
  });
});
