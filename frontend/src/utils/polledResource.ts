import { useCallback, useSyncExternalStore } from 'react';
import { isIntentionalAbort } from './fetchAbort';

/**
 * ONE READ, SHARED BY EVERY SURFACE THAT SHOWS IT (card b1e3b16d, lane L1).
 *
 * The sidebar bell and the dashboard's decision notice both say how many
 * decisions are waiting. Two independent pollers would ask the server at two
 * different moments and could show "2" in one place and "3" in the other on the
 * same screen. So a count that several surfaces show is read through one of
 * these: the first subscriber starts the read and a 30 s poll, every later
 * subscriber gets the same snapshot, and the last one to leave stops the poll
 * and forgets the value, so nothing stale survives an unmount.
 *
 * THE STATE NEVER SAYS ZERO FOR "UNKNOWN". `loading` and `error` are states
 * of their own, and a read that answers without the expected list is an
 * error, not an empty list (the Batch 8 lesson: a failed read rendered as
 * "0 waiting" is a false statement, not a degraded one).
 */
export type PolledState<T> =
  | { status: 'loading' }
  | { status: 'error'; httpStatus: number | null }
  | { status: 'ready'; value: T };

/** A read that failed, carrying the HTTP status when there was a response. */
export class ReadFailure extends Error {
  readonly httpStatus: number | null;

  constructor(httpStatus: number | null) {
    super(httpStatus === null ? 'The read failed' : `The read failed (${httpStatus})`);
    this.name = 'ReadFailure';
    this.httpStatus = httpStatus;
  }
}

export interface PolledResource<T> {
  getSnapshot(): PolledState<T>;
  subscribe(listener: () => void): () => void;
  /** Read again now. A no-op while nothing is subscribed. */
  refresh(): Promise<void>;
}

export const POLL_INTERVAL_MS = 30_000;

const LOADING = { status: 'loading' } as const;

export function createPolledResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number = POLL_INTERVAL_MS,
): PolledResource<T> {
  let state: PolledState<T> = LOADING;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let controller: AbortController | null = null;
  // Only the newest read may write. A slow answer that lands after a newer one
  // (or after the last subscriber left) is dropped rather than shown.
  let generation = 0;

  const publish = (next: PolledState<T>) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const refresh = async (): Promise<void> => {
    if (listeners.size === 0) return;
    const mine = ++generation;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    try {
      const value = await load(current.signal);
      if (mine !== generation) return;
      publish({ status: 'ready', value });
    } catch (caught) {
      if (mine !== generation) return;
      if (isIntentionalAbort(caught, current.signal)) return;
      publish({ status: 'error', httpStatus: caught instanceof ReadFailure ? caught.httpStatus : null });
    }
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timer = setInterval(() => { void refresh(); }, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        if (timer !== null) clearInterval(timer);
        timer = null;
        generation += 1;
        controller?.abort();
        controller = null;
        state = LOADING;
      };
    },
    refresh,
  };
}

const NO_SUBSCRIPTION = () => () => undefined;

/**
 * Subscribe a component to a shared read. `enabled: false` neither starts the
 * read nor counts as a subscriber, and reports `loading` — the caller decides
 * what a surface shows for an identity it does not read for.
 */
export function usePolledResource<T>(resource: PolledResource<T>, enabled = true): PolledState<T> {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? resource.subscribe(listener) : NO_SUBSCRIPTION()),
    [resource, enabled],
  );
  const snapshot = useSyncExternalStore(subscribe, resource.getSnapshot, resource.getSnapshot);
  return enabled ? snapshot : LOADING;
}
