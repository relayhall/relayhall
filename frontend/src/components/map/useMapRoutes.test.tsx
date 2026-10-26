// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useMapRoutes } from './useMapRoutes';
import { computeMapRoutes, type MapRoutesInput } from './computeMapRoutes';
import type { MapRoutesWorkerPort } from './mapRoutesWorkerClient';

const ports: Port[] = [];
class Port implements MapRoutesWorkerPort {
  sent: Parameters<MapRoutesWorkerPort['postMessage']>[0][] = [];
  onmessage: MapRoutesWorkerPort['onmessage'] = null;
  onerror: MapRoutesWorkerPort['onerror'] = null;
  onmessageerror: MapRoutesWorkerPort['onmessageerror'] = null;
  terminate = vi.fn();
  constructor() { ports.push(this); }
  postMessage(request: Parameters<MapRoutesWorkerPort['postMessage']>[0]) { this.sent.push(request); }
  finish(index: number) { const request = this.sent[index]; this.onmessage?.({ data: {
    id: request.id, ok: true, result: computeMapRoutes(request.input),
  } } as MessageEvent); }
}
const input = (): MapRoutesInput => ({ organization: 'horizontal', obstacles: [], envelope: null,
  requests: [{ key: 'edge', mode: 'flow', source: { x: 0, y: 0, w: 10, h: 10 }, target: { x: 100, y: 0, w: 10, h: 10 } }] });
beforeEach(() => { ports.length = 0; vi.stubGlobal('Worker', Port); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(value: MapRoutesInput | null = input()) {
  return renderHook(({ value, scope, revision }: { value: MapRoutesInput | null; scope: string; revision: object }) => useMapRoutes(value, scope, revision),
    { initialProps: { value, scope: 'authority1', revision: {} } });
}

test('pending ink becomes exact current routes only after completed batch', async () => {
  const value = input(), h = mount(value);
  expect(h.result.current.pending).toBe(true); expect(h.result.current.rows.get('edge')).toMatchObject({ pending: true });
  await act(async () => ports[0].finish(0));
  expect(h.result.current.complete).toBe(true); expect(h.result.current.rows.get('edge')).toEqual({ ...computeMapRoutes(value)[0].route, pending: false });
});
test('equal geometry rerenders retain accepted routes, revision change cannot', async () => {
  const revision = {}, value = input(); const h = mount(value);
  h.rerender({ value, scope: 'authority1', revision }); const port = ports.at(-1)!;
  await act(async () => port.finish(0));
  h.rerender({ value: structuredClone(value), scope: 'authority1', revision });
  expect(h.result.current.complete).toBe(true); expect(port.sent).toHaveLength(1);
  h.rerender({ value, scope: 'authority1', revision: {} });
  expect(h.result.current.complete).toBe(false); expect(port.terminate).toHaveBeenCalledOnce();
});
test('rapid geometry changes coalesce and old replies cannot end pending state', async () => {
  const revision = {}, value = input(), h = mount(value);
  h.rerender({ value, scope: 'authority1', revision }); const port = ports.at(-1)!;
  for (const x of [200, 300, 400]) h.rerender({ value: { ...value, requests: [{ ...value.requests[0], target: { ...value.requests[0].target, x } }] }, scope: 'authority1', revision });
  expect(port.sent).toHaveLength(1);
  await act(async () => port.finish(0)); expect(h.result.current.pending).toBe(true); expect(port.sent).toHaveLength(2);
  expect(port.sent[1].input.requests[0].target.x).toBe(400);
  await act(async () => port.finish(1)); expect(h.result.current.complete).toBe(true);
});
test('authority loss clears ink immediately and captured old callbacks cannot restore it', async () => {
  const h = mount(), port = ports[0], callback = port.onmessage;
  h.rerender({ value: null, scope: 'authority1', revision: {} });
  expect(h.result.current.rows.size).toBe(0); expect(port.terminate).toHaveBeenCalledOnce();
  await act(async () => callback?.({ data: { id: port.sent[0].id, ok: true, result: computeMapRoutes(port.sent[0].input) } } as MessageEvent));
  expect(h.result.current.rows.size).toBe(0);
});
test('deleted relationships and empty batches cannot retain old ink or pending settlement', async () => {
  const revision = {}, value = input(), h = mount(value);
  h.rerender({ value, scope: 'authority1', revision }); const port = ports.at(-1)!;
  await act(async () => port.finish(0));
  h.rerender({ value: { ...value, requests: [] }, scope: 'authority1', revision });
  expect(h.result.current.rows.size).toBe(0); expect(h.result.current.pending).toBe(false); expect(h.result.current.complete).toBe(true);
  expect(port.terminate).toHaveBeenCalledOnce();
});
test('worker faults remain explicit with temporary ink until user retry succeeds', async () => {
  const h = mount(); await act(async () => ports[0].onerror?.(new Event('error')));
  expect(h.result.current.error).not.toBeNull(); expect(h.result.current.complete).toBe(false);
  expect(h.result.current.rows.get('edge')?.pending).toBe(true); expect(ports).toHaveLength(1);
  act(() => h.result.current.retry()); expect(ports).toHaveLength(2); expect(h.result.current.error).toBeNull();
  await act(async () => ports[1].finish(0)); expect(h.result.current.complete).toBe(true);
});
test('a malformed current reply fails instead of settling with missing relationships', async () => {
  const h = mount(); await act(async () => ports[0].onmessage?.({ data: { id: ports[0].sent[0].id, ok: true, result: [] } } as MessageEvent));
  expect(h.result.current.error?.message).toBe('Invalid Map routes reply'); expect(h.result.current.complete).toBe(false);
});
test('no-Worker compatibility keeps exact synchronous output', () => {
  vi.stubGlobal('Worker', undefined); const value = input(), h = mount(value);
  expect(h.result.current.complete).toBe(true); expect(h.result.current.rows.get('edge')).toEqual({ ...computeMapRoutes(value)[0].route, pending: false });
  expect(ports).toHaveLength(0);
});
