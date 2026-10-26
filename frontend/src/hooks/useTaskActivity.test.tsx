// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Task } from '../types/task';
import { authenticatedFetch } from '../utils/auth';
import { readTaskActivity, useTaskActivity } from './useTaskActivity';
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
const id = '11111111-1111-4111-8111-111111111111';
const task = { id, status: 'in-progress', ownerPrincipalId: 'owner' } as Task;
const body = (ids = [id], state = 'active') => ({ success: true, observedAt: '2026-10-06T12:00:00Z', staleAfterMs: 540000,
  activity: ids.map(taskId => ({ taskId, state, kind: 'status', receivedAt: '2026-10-06T11:59:59Z' })) });
const response = (value: unknown, ok = true) => ({ ok, json: async () => value }) as Response;
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
beforeEach(() => { vi.useFakeTimers(); vi.mocked(authenticatedFetch).mockReset(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

test('sequential requests cap each batch at100 and omit unauthorized data', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => String(i));
  vi.mocked(authenticatedFetch).mockImplementation(async url => response(body(String(url).split('ids=')[1].split(',').slice(0, 1))));
  const rows = await readTaskActivity(ids, new AbortController().signal);
  expect(authenticatedFetch).toHaveBeenCalledTimes(3); expect(rows.size).toBe(201);
  expect(rows.get('1')).toEqual({ state: 'unknown', receivedAt: null });
  expect(String(vi.mocked(authenticatedFetch).mock.calls[0][0]).split('ids=')[1].split(',')).toHaveLength(100);
});

test.each(['foreign', 'duplicate', 'future', 'bad-state'])('rejects hostile %s rows', async variant => {
  const value = body();
  if (variant === 'foreign') value.activity[0].taskId = 'private';
  if (variant === 'duplicate') value.activity.push(value.activity[0]);
  if (variant === 'future') value.activity[0].receivedAt = '2099-01-01T00:00:00Z';
  if (variant === 'bad-state') value.activity[0].state = 'running';
  vi.mocked(authenticatedFetch).mockResolvedValue(response(value));
  await expect(readTaskActivity([id], new AbortController().signal)).rejects.toThrow('Invalid task activity');
});

test('assignment changes abort and clear synchronously; ignored abort cannot publish late data', async () => {
  let late!: (value: Response) => void;
  vi.mocked(authenticatedFetch).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
  vi.mocked(authenticatedFetch).mockResolvedValue(response({ ...body(), activity: [] }));
  const hook = renderHook(({ tasks }) => useTaskActivity(tasks, 'viewer'), { initialProps: { tasks: [task] } });
  const signal = vi.mocked(authenticatedFetch).mock.calls[0][1]?.signal;
  hook.rerender({ tasks: [{ ...task, ownerPrincipalId: 'different' }] });
  expect(signal?.aborted).toBe(true); expect(hook.result.current.size).toBe(0);
  await settle(); expect(hook.result.current.get(id)?.state).toBe('unknown');
  await act(async () => { late(response(body())); });
  expect(hook.result.current.get(id)?.state).toBe('unknown');
});

test('hidden pages cancel and pause; resume fetches; offline clears to unavailable', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(response(body()));
  const hook = renderHook(() => useTaskActivity([task], 'viewer'));
  await settle(); expect(hook.result.current.get(id)?.state).toBe('active');
  act(() => { Object.defineProperty(document, 'hidden', { value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  expect(hook.result.current.size).toBe(0);
  await act(async () => { vi.advanceTimersByTime(120000); }); expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  vi.mocked(authenticatedFetch).mockRejectedValue(new Error('offline'));
  act(() => { Object.defineProperty(document, 'hidden', { value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await settle(); expect(hook.result.current.get(id)).toEqual({ state: 'unavailable', receivedAt: null });
});

test('unmount aborts; a changed viewer never reads previous viewer snapshot', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(response(body()));
  const hook = renderHook(({ viewer }) => useTaskActivity([task], viewer), { initialProps: { viewer: 'one' } });
  await settle(); expect(hook.result.current.get(id)?.state).toBe('active');
  vi.mocked(authenticatedFetch).mockImplementation(() => new Promise(() => {}));
  hook.rerender({ viewer: 'two' }); expect(hook.result.current.size).toBe(0);
  const signal = vi.mocked(authenticatedFetch).mock.calls[1][1]?.signal;
  hook.unmount(); expect(signal?.aborted).toBe(true);
});


test.each(['active', 'idle'])('%s expires at server deadline during a hung refresh, despite wall-clock change', async state => {
  let monotonic = 0; vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const value = body([id], state); value.activity[0].receivedAt = '2026-10-06T11:51:35Z';
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(value));
  vi.mocked(authenticatedFetch).mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(() => useTaskActivity([task], 'viewer'));
  await settle(); expect(hook.result.current.get(id)?.state).toBe(state);
  monotonic = 30000; await act(async () => { vi.advanceTimersByTime(30000); });
  expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
  monotonic = 35000; await act(async () => { vi.advanceTimersByTime(5000); });
  expect(hook.result.current.get(id)?.state).toBe('stale');
  expect(hook.result.current.get(id)?.receivedAt).toBe(value.activity[0].receivedAt);
});

test('repeated old observation cannot renew freshness', async () => {
  let monotonic = 0; vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const value = body(); value.activity[0].receivedAt = '2026-10-06T11:51:35Z';
  vi.mocked(authenticatedFetch).mockImplementation(async () => response(value));
  const hook = renderHook(() => useTaskActivity([task], 'viewer')); await settle();
  monotonic = 30000; await act(async () => { vi.advanceTimersByTime(30000); }); await settle();
  expect(hook.result.current.get(id)?.state).toBe('active');
  monotonic = 35000; await act(async () => { vi.advanceTimersByTime(5000); });
  expect(hook.result.current.get(id)?.state).toBe('stale');
});

test('request transit consumes remaining lifetime rather than starting a fresh lifetime at receipt', async () => {
  let monotonic = 0; vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const value = body(); value.activity[0].receivedAt = '2026-10-06T11:51:01Z';
  vi.mocked(authenticatedFetch).mockImplementation(async () => { monotonic = 2000; return response(value); });
  expect((await readTaskActivity([id], new AbortController().signal)).get(id)?.state).toBe('stale');
});


test('hung transport is bounded and a late timed-out response cannot restore activity', async () => {
  let late!: (value: Response) => void;
  vi.mocked(authenticatedFetch).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
  vi.mocked(authenticatedFetch).mockResolvedValue(response({ ...body(), activity: [] }));
  const hook = renderHook(() => useTaskActivity([task], 'viewer'));
  await act(async () => { vi.advanceTimersByTime(20000); });
  expect(hook.result.current.get(id)?.state).toBe('unavailable');
  await act(async () => { late(response(body())); });
  expect(hook.result.current.get(id)?.state).toBe('unavailable');
  await act(async () => { vi.advanceTimersByTime(30000); }); await settle();
  expect(hook.result.current.get(id)?.state).toBe('unknown');
});

test('out-of-order: an older read that resolves after a newer one cannot overwrite it', async () => {
  let older!: (value: Response) => void;
  vi.mocked(authenticatedFetch).mockImplementationOnce(() => new Promise(resolve => { older = resolve; }));
  vi.mocked(authenticatedFetch).mockResolvedValue(response(body([id], 'idle')));
  const hook = renderHook(() => useTaskActivity([task], 'viewer'));
  // The tab is hidden and shown again before the first read returns, so a second, newer read starts.
  act(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  act(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await settle(); expect(hook.result.current.get(id)?.state).toBe('idle');
  await act(async () => { older(response(body([id], 'active'))); });
  await settle(); expect(hook.result.current.get(id)?.state).toBe('idle');
  expect(authenticatedFetch).toHaveBeenCalledTimes(2);
});

test('a failed refresh after an active observation presents unavailable, never idle or the earlier state', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(body()));
  vi.mocked(authenticatedFetch).mockResolvedValue(response({ success: false, code: 'TASK_ACTIVITY_UNAVAILABLE' }, false));
  const hook = renderHook(() => useTaskActivity([task], 'viewer'));
  await settle(); expect(hook.result.current.get(id)?.state).toBe('active');
  await act(async () => { vi.advanceTimersByTime(30000); }); await settle();
  expect(hook.result.current.get(id)).toEqual({ state: 'unavailable', receivedAt: null });
});

test('a lifecycle change alone never presents activity: the state shown stays the read, not the Task status', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(response({ ...body(), activity: [{ taskId: id, state: 'unknown', kind: null, receivedAt: null }] }));
  const hook = renderHook(({ tasks }) => useTaskActivity(tasks, 'viewer'), { initialProps: { tasks: [{ ...task, status: 'todo' } as Task] } });
  await settle(); expect(hook.result.current.get(id)?.state).toBe('unknown');
  hook.rerender({ tasks: [task] });
  expect(hook.result.current.get(id)?.state).toBe('unknown');
  await settle(); expect(hook.result.current.get(id)?.state).toBe('unknown');
});

// Card 30d198df (1). A board update patches a card's fields; it is not a new
// assignment, so the badge keeps what the read said and the loop is not restarted.
test('a board update to a card keeps its badge: no empty map and no restarted read', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(response(body()));
  const hook = renderHook(({ tasks }) => useTaskActivity(tasks, 'viewer'),
    { initialProps: { tasks: [{ ...task, updated: '2026-10-19T10:00:00Z', title: 'Before' } as Task] } });
  await settle(); expect(hook.result.current.get(id)?.state).toBe('active');
  hook.rerender({ tasks: [{ ...task, updated: '2026-10-19T10:00:05Z', title: 'After', status: 'review' } as Task] });
  expect(hook.result.current.get(id)?.state).toBe('active');
  await settle();
  expect(hook.result.current.get(id)?.state).toBe('active');
  expect(authenticatedFetch).toHaveBeenCalledTimes(1);
});

test('a card joining the set keeps every other badge while the new set is read', async () => {
  const other = '22222222-2222-4222-8222-222222222222';
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(body()));
  vi.mocked(authenticatedFetch).mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(({ tasks }) => useTaskActivity(tasks, 'viewer'), { initialProps: { tasks: [task] } });
  await settle(); expect(hook.result.current.get(id)?.state).toBe('active');
  hook.rerender({ tasks: [task, { ...task, id: other } as Task] });
  expect(hook.result.current.get(id)?.state).toBe('active');
  expect(hook.result.current.has(other)).toBe(false);
  await settle();
  expect(hook.result.current.get(id)?.state).toBe('active');
  expect(String(vi.mocked(authenticatedFetch).mock.calls[1][0]).split('ids=')[1].split(',').sort()).toEqual([id, other]);
});

test('a kept row keeps its own deadline across a set change and still turns stale', async () => {
  let monotonic = 0; vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  // 530 s old at the read: 10 s of lifetime left, inside the 20 s request deadline.
  const value = body(); value.activity[0].receivedAt = '2026-10-06T11:51:10Z';
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(value));
  vi.mocked(authenticatedFetch).mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(({ tasks }) => useTaskActivity(tasks, 'viewer'), { initialProps: { tasks: [task] } });
  await settle(); expect(hook.result.current.get(id)?.state).toBe('active');
  hook.rerender({ tasks: [task, { ...task, id: '33333333-3333-4333-8333-333333333333' } as Task] });
  monotonic = 9000; await act(async () => { vi.advanceTimersByTime(9000); });
  expect(hook.result.current.get(id)?.state).toBe('active');
  monotonic = 10000; await act(async () => { vi.advanceTimersByTime(1000); });
  expect(hook.result.current.get(id)?.state).toBe('stale');
});

// Card 30d198df (5). receivedAt is the database clock, observedAt the API
// process clock; a little disagreement is skew, not a hostile future row.
test('a receivedAt up to 5 s after observedAt is clock skew: accepted at age zero, never extra lifetime', async () => {
  let monotonic = 0; vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  for (const receivedAt of ['2026-10-06T12:00:03Z', '2026-10-06T12:00:05.000Z']) {
    const value = body(); value.activity[0].receivedAt = receivedAt;
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(value));
    // A refusal is caught into the assertion, so a regression fails here, not by a throw.
    const read = await readTaskActivity([id], new AbortController().signal).catch((error: Error) => error.message);
    expect(typeof read === 'string' ? read : read.get(id)).toEqual({ state: 'active', receivedAt, freshUntil: 540000 });
  }
});

test('a receivedAt more than 5 s after observedAt still refuses the batch', async () => {
  const value = body(); value.activity[0].receivedAt = '2026-10-06T12:00:05.001Z';
  vi.mocked(authenticatedFetch).mockResolvedValue(response(value));
  await expect(readTaskActivity([id], new AbortController().signal)).rejects.toThrow('Invalid task activity row');
});
