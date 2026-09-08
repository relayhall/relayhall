/**
 * The three bounds on liveness bookkeeping writes, and the ONE way each of
 * them could become a bug — card 8491557e.
 *
 * The burst gate (`sessionTouchBurst.test.ts`) measures the property that
 * matters, end to end, against a real PostgreSQL: a burst never spends the
 * pool and never answers 503. It cannot run in the default jest run, and it is
 * a coarse instrument — it says the pool survived, not WHICH bound saved it.
 * This suite is the fine one. Every assertion here is about a decision the
 * writer makes, and every decision has a companion assertion for the case
 * where making it too eagerly would break something real:
 *
 *   coalesce      — and a DIFFERENT key is never suppressed by it
 *   single-flight — and a completed write releases the key
 *   shed          — and shedding never STAMPS the throttle, because a shed
 *                   write did not happen and must be retried
 *   bound memory  — and forgetting a key only ever permits an extra write
 *
 * The last of those is the one worth naming: a bound on a liveness write that
 * records writes it never performed would let `last_seen_at` go stale on load
 * alone, and sign an active operator out. That is a worse defect than the pool
 * exhaustion this whole module exists to prevent, so it gets its own test.
 */
import {
  BoundedPresenceWriter,
  PRESENCE_MAX_IN_FLIGHT,
  PRESENCE_THROTTLE_MS,
} from '../db/boundedPresenceWrites';
import { sessionTouchThrottleMs, sessionIdleMs } from '../services/LoginSessionService';

/** Let the microtask chain inside `submit` run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A write whose completion this test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

const writer = (over: Partial<ConstructorParameters<typeof BoundedPresenceWriter>[0]> = {}) =>
  new BoundedPresenceWriter({ throttleMs: 60_000, maxInFlight: 4, ...over });

describe('BoundedPresenceWriter — coalescing', () => {
  it('starts ONE write for a hundred submissions of the same key inside the window', async () => {
    const w = writer();
    let started = 0;
    for (let i = 0; i < 100; i += 1) {
      w.submit('session:a', async () => { started += 1; });
    }
    expect(w.counters().started).toBe(1);
    expect(w.counters().coalesced).toBe(99);
    // ...and the write the writer COUNTED is the write that actually ran: the
    // counter is the oracle the burst gate reads, so it is checked against the
    // observable effect here rather than trusted.
    await settle();
    expect(started).toBe(1);
  });

  it('does not let one key suppress another', async () => {
    const w = writer();
    const keys: string[] = [];
    for (const key of ['session:a', 'session:b', 'session:c']) {
      w.submit(key, async () => { keys.push(key); });
    }
    await settle();
    expect(keys.sort()).toEqual(['session:a', 'session:b', 'session:c']);
  });

  it('permits the next write once the window has elapsed', async () => {
    const w = writer({ throttleMs: 0 });
    let started = 0;
    w.submit('session:a', async () => { started += 1; });
    w.submit('session:a', async () => { started += 1; });
    // Both are permitted by the (zero) window; the SECOND is held off only by
    // single-flight, which is the next test's subject. Either way the writer
    // never runs two writes of one row at once.
    expect(w.counters().coalesced).toBe(0);
    expect(w.counters().singleFlighted).toBe(1);
    await settle();
    expect(started).toBe(1);
    // The window is elapsed and the key released, so the next one writes.
    expect(w.submit('session:a', async () => { started += 1; })).toBe(true);
    await settle();
    expect(started).toBe(2);
  });
});

describe('BoundedPresenceWriter — single flight per key', () => {
  it('never runs two writes of the same row at once', async () => {
    const w = writer({ throttleMs: 0 });
    const first = deferred();
    let concurrent = 0;
    let peak = 0;
    const run = (d: { promise: Promise<void> }) => async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await d.promise;
      concurrent -= 1;
    };
    expect(w.submit('session:a', run(first))).toBe(true);
    expect(w.submit('session:a', run(deferred()))).toBe(false);
    await settle();
    expect(peak).toBe(1);
    first.resolve();
    await settle();
  });

  it('releases the key once the write completes', async () => {
    const w = writer({ throttleMs: 0 });
    const first = deferred();
    w.submit('session:a', () => first.promise);
    expect(w.submit('session:a', async () => undefined)).toBe(false);
    first.resolve();
    await settle();
    expect(w.submit('session:a', async () => undefined)).toBe(true);
  });

  it('releases the key when the write REJECTS, and reports it once', async () => {
    const errors: unknown[] = [];
    const w = writer({ throttleMs: 0, onError: (err) => errors.push(err) });
    const first = deferred();
    w.submit('session:a', () => first.promise);
    first.reject(new Error('substrate gone'));
    await settle();
    expect(errors).toHaveLength(1);
    expect(w.counters().failed).toBe(1);
    expect(w.counters().inFlight).toBe(0);
    // A rejection must not wedge the key: the next request writes again.
    expect(w.submit('session:a', async () => undefined)).toBe(true);
  });

  it('catches a SYNCHRONOUS throw from the caller rather than leaking a rejection', async () => {
    const errors: unknown[] = [];
    const w = writer({ throttleMs: 0, onError: (err) => errors.push(err) });
    expect(() => w.submit('session:a', () => { throw new Error('built a bad query'); })).not.toThrow();
    await settle();
    expect(errors).toHaveLength(1);
    expect(w.counters().inFlight).toBe(0);
  });
});

describe('BoundedPresenceWriter — the concurrency bound', () => {
  it('holds at most maxInFlight writes at once', async () => {
    const w = writer({ throttleMs: 0, maxInFlight: 2 });
    const pending = [deferred(), deferred(), deferred()];
    const results = pending.map((d, i) => w.submit(`session:${i}`, () => d.promise));
    expect(results).toEqual([true, true, false]);
    expect(w.counters().shed).toBe(1);
    expect(w.counters().peakInFlight).toBe(2);
    pending.forEach((d) => d.resolve());
    await settle();
  });

  it('SHEDS rather than queues — a shed write never runs later on its own', async () => {
    const w = writer({ throttleMs: 0, maxInFlight: 1 });
    const held = deferred();
    let shedRan = false;
    w.submit('session:holder', () => held.promise);
    w.submit('session:shed', async () => { shedRan = true; });
    held.resolve();
    await settle();
    // The point of shedding: nothing outlives the request that offered it.
    expect(shedRan).toBe(false);
  });

  it('does NOT stamp the throttle for a shed write, so the next request retries', async () => {
    // The defect this forbids: recording a write that never happened would let
    // `last_seen_at` go stale for a whole window under load alone, and idle an
    // active session out.
    const w = writer({ throttleMs: 60_000, maxInFlight: 1 });
    const held = deferred();
    w.submit('session:holder', () => held.promise);
    expect(w.submit('session:shed', async () => undefined)).toBe(false);
    held.resolve();
    await settle();
    // Same key, well inside the 60s window, and it must still be permitted:
    // the earlier submission was refused, not performed.
    expect(w.submit('session:shed', async () => undefined)).toBe(true);
  });

  it('counts every submission into exactly one outcome', () => {
    const w = writer({ throttleMs: 60_000, maxInFlight: 1 });
    w.submit('a', () => new Promise<void>(() => undefined)); // started, never settles
    w.submit('a', async () => undefined); // coalesced
    w.submit('b', async () => undefined); // shed (bound full)
    const c = w.counters();
    expect(c.submitted).toBe(3);
    expect(c.started + c.coalesced + c.singleFlighted + c.shed).toBe(c.submitted);
  });
});

describe('BoundedPresenceWriter — bounded memory', () => {
  it('forgets keys rather than growing without limit, and forgetting only permits a write', async () => {
    const w = writer({ throttleMs: 60_000, maxInFlight: 64, maxTrackedKeys: 4 });
    for (let i = 0; i < 40; i += 1) w.submit(`session:${i}`, async () => undefined);
    // Every key was written once; none was suppressed by the cap.
    expect(w.counters().started).toBe(40);
    expect(w.counters().coalesced).toBe(0);
    await settle();
    // The earliest key has been forgotten, so it writes again. That is the
    // SAFE direction: an extra bookkeeping write, itself bounded by
    // maxInFlight — never a suppressed one.
    expect(w.submit('session:0', async () => undefined)).toBe(true);
  });
});

describe('BoundedPresenceWriter — reset', () => {
  it('clears the throttle so a suite is not coalesced by the previous one', async () => {
    const w = writer();
    expect(w.submit('session:a', async () => undefined)).toBe(true);
    await settle();
    expect(w.submit('session:a', async () => undefined)).toBe(false);
    expect(w.counters().coalesced).toBe(1);
    w.reset();
    expect(w.submit('session:a', async () => undefined)).toBe(true);
  });
});

describe('the session touch window is bounded by the idle window it feeds', () => {
  const original = process.env.RELAYHALL_SESSION_IDLE_MINUTES;
  afterEach(() => {
    if (original === undefined) delete process.env.RELAYHALL_SESSION_IDLE_MINUTES;
    else process.env.RELAYHALL_SESSION_IDLE_MINUTES = original;
  });

  it('is the flat budget under the default twelve-hour idle window', () => {
    delete process.env.RELAYHALL_SESSION_IDLE_MINUTES;
    expect(sessionTouchThrottleMs()).toBe(PRESENCE_THROTTLE_MS);
  });

  it('tightens when an operator shortens the idle window', () => {
    // One minute is the floor `sessionIdleMs` admits, and is the flat 60s
    // budget EXACTLY: an unbounded throttle here could permit one write, then
    // suppress every later one until after the session had already idled out.
    process.env.RELAYHALL_SESSION_IDLE_MINUTES = '1';
    const throttle = sessionTouchThrottleMs();
    expect(throttle).toBeLessThan(sessionIdleMs());
    expect(throttle).toBe(15_000);
  });

  it('never exceeds a quarter of the idle window, at any configured value', () => {
    for (const minutes of ['1', '2', '5', '10', '60', '720', '43200']) {
      process.env.RELAYHALL_SESSION_IDLE_MINUTES = minutes;
      expect(sessionTouchThrottleMs()).toBeLessThanOrEqual(Math.floor(sessionIdleMs() / 4));
      expect(sessionTouchThrottleMs()).toBeLessThan(sessionIdleMs());
    }
  });
});

describe('the shipped bound', () => {
  it('leaves most of the pool for real work', () => {
    // `db/connection.ts` builds the pool with max: 20. The bound is a promise
    // about that pool, so it is asserted against it rather than against a
    // number retyped here.
    const { databasePoolConfig } = require('../db/connection');
    expect(PRESENCE_MAX_IN_FLIGHT).toBeLessThan(Number(databasePoolConfig.max) / 2);
  });
});
