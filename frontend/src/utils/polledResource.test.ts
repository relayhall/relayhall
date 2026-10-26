/**
 * The shared read behind the bell and the decision notice (card b1e3b16d,
 * lane L1). What it promises, each with the failure it prevents:
 *
 *  - many subscribers, ONE read (two surfaces cannot show two numbers);
 *  - the poll stops and the value is forgotten when the last one leaves
 *    (nothing stale survives an unmount);
 *  - only the newest read may write (a slow answer cannot overwrite a newer);
 *  - a failure is an error state carrying its HTTP status, never a value.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createPolledResource, ReadFailure } from './polledResource';

afterEach(() => { vi.useRealTimers(); });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createPolledResource', () => {
  test('the first subscriber starts one read that every later subscriber shares', async () => {
    const load = vi.fn(async () => 7);
    const resource = createPolledResource(load, 30_000);
    const a = vi.fn();
    const b = vi.fn();
    const offA = resource.subscribe(a);
    const offB = resource.subscribe(b);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(resource.getSnapshot()).toEqual({ status: 'ready', value: 7 });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    offA();
    offB();
  });

  test('polls on the interval while subscribed, and stops and forgets when the last leaves', async () => {
    vi.useFakeTimers();
    let value = 0;
    const load = vi.fn(async () => ++value);
    const resource = createPolledResource(load, 30_000);
    const off = resource.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(resource.getSnapshot()).toEqual({ status: 'ready', value: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resource.getSnapshot()).toEqual({ status: 'ready', value: 2 });
    off();
    expect(resource.getSnapshot()).toEqual({ status: 'loading' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('refresh is a no-op with nobody subscribed', async () => {
    const load = vi.fn(async () => 1);
    const resource = createPolledResource(load, 30_000);
    await resource.refresh();
    expect(load).not.toHaveBeenCalled();
    expect(resource.getSnapshot()).toEqual({ status: 'loading' });
  });

  test('only the newest read writes: a slow older answer is dropped', async () => {
    const resolvers: Array<(value: string) => void> = [];
    const load = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const resource = createPolledResource(load, 30_000);
    const off = resource.subscribe(() => undefined);
    void resource.refresh();
    resolvers[1]('newer');
    await flush();
    resolvers[0]('older');
    await flush();
    expect(resource.getSnapshot()).toEqual({ status: 'ready', value: 'newer' });
    off();
  });

  test('a failure is an error carrying its status — and a later success replaces it', async () => {
    let fail = true;
    const resource = createPolledResource(async () => {
      if (fail) throw new ReadFailure(403);
      return ['row'];
    }, 30_000);
    const off = resource.subscribe(() => undefined);
    await flush();
    expect(resource.getSnapshot()).toEqual({ status: 'error', httpStatus: 403 });
    fail = false;
    await resource.refresh();
    expect(resource.getSnapshot()).toEqual({ status: 'ready', value: ['row'] });
    off();
  });

  test('a thrown non-HTTP failure is an error with no status', async () => {
    const resource = createPolledResource(async () => { throw new TypeError('Failed to fetch'); }, 30_000);
    const off = resource.subscribe(() => undefined);
    await flush();
    expect(resource.getSnapshot()).toEqual({ status: 'error', httpStatus: null });
    off();
  });

  test('an answer that lands after the last subscriber left is dropped', async () => {
    let release: (value: number) => void = () => undefined;
    const resource = createPolledResource(() => new Promise<number>((resolve) => { release = resolve; }), 30_000);
    const off = resource.subscribe(() => undefined);
    off();
    release(5);
    await flush();
    expect(resource.getSnapshot()).toEqual({ status: 'loading' });
  });
});
