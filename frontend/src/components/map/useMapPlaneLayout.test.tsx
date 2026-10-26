// @vitest-environment jsdom
import { StrictMode, type PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useMapPlaneLayout } from './useMapPlaneLayout';
import { computeMapPlane, type MapPlaneInput } from './computeMapPlane';
import { EMPTY_PLANE_ANCHORS } from './mapPlaneModel';
import type { MapPlaneRequest } from './mapPlaneWorkerProtocol';
import type { MapPlaneWorkerPort } from './mapPlaneWorkerClient';

const ports: Port[] = [];
class Port implements MapPlaneWorkerPort {
  sent: MapPlaneRequest[] = [];
  onmessage: MapPlaneWorkerPort['onmessage'] = null;
  onerror: MapPlaneWorkerPort['onerror'] = null;
  onmessageerror: MapPlaneWorkerPort['onmessageerror'] = null;
  terminate = vi.fn();
  constructor() { ports.push(this); }
  postMessage(request: MapPlaneRequest) { this.sent.push(request); }
  finish(index: number) {
    const request = this.sent[index];
    this.onmessage?.({ data: { id: request.id, channel: request.channel, ok: true, result: computeMapPlane(request.input) } } as MessageEvent);
  }
}
const input = (): MapPlaneInput => ({ graph: { nodes: ['a','b'].map(id => ({ id, title: id,
  status: 'todo', priority: 'normal', project: 'Project', phaseId: null, updated: '' })),
  edges: [{ from: 'a', to: 'b', kind: 'dependency' }], phases: [], reports: [] }, sizes: {},
  organization: 'horizontal', anchors: structuredClone(EMPTY_PLANE_ANCHORS) });
beforeEach(() => { ports.length = 0; vi.stubGlobal('Worker', Port); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(value: MapPlaneInput | null = input(), strict = false) {
  const accepted = vi.fn();
  const hook = renderHook(({ value, scope }: { value: MapPlaneInput | null; scope: string }) => useMapPlaneLayout(value, scope, accepted),
    { initialProps: { value, scope: 'authority1' }, wrapper: ({ children }: PropsWithChildren) => strict ? <StrictMode>{children}</StrictMode> : <>{children}</> });
  return { ...hook, accepted };
}

test('initial result is withheld until the worker completes and metadata stays usable during replacement', async () => {
  const source = input(), h = mount(source), port = ports[0];
  expect(h.result.current.visible).toBeNull(); expect(h.result.current.complete).toBe(false);
  await act(async () => port.finish(0)); expect(h.result.current.complete).toBe(true);
  const current = { ...source, graph: { ...source.graph, nodes: [{ ...source.graph.nodes[0], title: 'Current' }] } };
  h.rerender({ value: current, scope: 'authority1' });
  expect(h.result.current.complete).toBe(false);
  expect(h.result.current.visible?.graph.nodes.map(n => n.title)).toEqual(['Current']);
  expect(h.result.current.visible?.graph.edges).toEqual([]);
  await act(async () => port.finish(1)); expect(h.result.current.complete).toBe(true);
  expect(h.accepted).toHaveBeenCalledTimes(2);
});

test('superseded pending result cannot commit anchors before the latest input finishes', async () => {
  const source = input(), h = mount(source), port = ports[0];
  const newer = { ...source, sizes: { a: { w: 200, h: 150 } } };
  h.rerender({ value: newer, scope: 'authority1' }); expect(port.sent).toHaveLength(1);
  await act(async () => port.finish(0)); expect(h.accepted).not.toHaveBeenCalled(); expect(port.sent).toHaveLength(2);
  await act(async () => port.finish(1)); expect(h.accepted).toHaveBeenCalledWith(newer, expect.any(Object));
});

test('authority loss hides synchronously and terminates old work without stale commits', async () => {
  const source = input(), h = mount(source), old = ports[0];
  await act(async () => old.finish(0)); const late = old.onmessage;
  h.rerender({ value: null, scope: 'authority2' });
  expect(h.result.current.visible).toBeNull(); expect(h.result.current.complete).toBe(false);
  expect(old.terminate).toHaveBeenCalledTimes(1);
  late?.({ data: { id: 1, channel: 'layout', ok: true, result: computeMapPlane(source) } } as MessageEvent);
  expect(h.accepted).toHaveBeenCalledTimes(1);
  h.rerender({ value: source, scope: 'authority2' });
  expect(h.result.current.visible).toBeNull(); await act(async () => ports[1].finish(0));
  expect(h.result.current.complete).toBe(true);
});

test('measurement updates retain accepted geometry while new computation is pending', async () => {
  const source = input(), h = mount(source), port = ports[0];
  await act(async () => port.finish(0)); const previous = h.result.current.visible!.layout;
  h.rerender({ value: { ...source, sizes: { a: { w: 200, h: 160 } } }, scope: 'authority1' });
  expect(h.result.current.visible!.layout).toBe(previous); expect(h.result.current.complete).toBe(false);
});

test('terminal worker failure has no synchronous fallback and requires explicit retry', async () => {
  const source = input(), h = mount(source), port = ports[0];
  await act(async () => port.onerror?.(new Event('error')));
  expect(h.result.current.error).toBeInstanceOf(Error); expect(h.accepted).not.toHaveBeenCalled();
  h.rerender({ value: { ...source, sizes: {} }, scope: 'authority1' });
  await waitFor(() => expect(h.result.current.error).toBeInstanceOf(Error)); expect(ports).toHaveLength(1);
  act(() => h.result.current.retry()); expect(ports).toHaveLength(2);
  await act(async () => ports[1].finish(0)); expect(h.result.current.complete).toBe(true); expect(h.result.current.error).toBeNull();
});

test('StrictMode and unmount dispose each worker and reject late callbacks', async () => {
  const h = mount(input(), true); expect(ports).toHaveLength(2); expect(ports[0].terminate).toHaveBeenCalledTimes(1);
  await act(async () => ports[1].finish(0)); expect(h.result.current.complete).toBe(true);
  h.unmount(); expect(ports[1].terminate).toHaveBeenCalledTimes(1); expect(ports[1].onmessage).toBeNull();
});

test('unsupported Worker uses the exact compatibility calculation', () => {
  vi.stubGlobal('Worker', undefined); const source = input(), h = mount(source);
  expect(h.result.current.supportsWorker).toBe(false); expect(h.result.current.complete).toBe(true);
  expect(h.result.current.visible?.layout).toEqual(computeMapPlane(source)); expect(ports).toHaveLength(0);
});

test('same-scope authority loss cannot resurrect the previous accepted input on re-enable', async () => {
  const source = input(), h = mount(source);
  await act(async () => ports[0].finish(0)); expect(h.result.current.complete).toBe(true);
  h.rerender({ value: null, scope: 'authority1' });
  h.rerender({ value: source, scope: 'authority1' });
  expect(h.result.current.visible).toBeNull(); expect(h.result.current.complete).toBe(false);
  await act(async () => ports[1].finish(0)); expect(h.result.current.complete).toBe(true);
});

test('commit callback failure becomes an explicit error without automatic replay', async () => {
  const h = mount(input()); h.accepted.mockImplementation(() => { throw new Error('commit failed'); });
  await act(async () => ports[0].finish(0));
  expect(h.result.current.error?.message).toBe('commit failed'); expect(h.result.current.complete).toBe(false);
  expect(ports[0].sent).toHaveLength(1); expect(h.accepted).toHaveBeenCalledTimes(1);
});

test('compatibility callback identity changes do not recommit unchanged geometry', () => {
  vi.stubGlobal('Worker', undefined); const source = input(), committed = vi.fn();
  const h = renderHook(({ callback }) => useMapPlaneLayout(source, 'scope', callback),
    { initialProps: { callback: (_input: MapPlaneInput, _result: unknown) => committed() } });
  expect(committed).toHaveBeenCalledTimes(1);
  h.rerender({ callback: () => committed() }); expect(committed).toHaveBeenCalledTimes(1);
});

test('switch adoption binds its complete target without a second incompatible calculation', async () => {
  const source = input(), h = mount(source), port = ports[0];
  await act(async () => port.finish(0));
  const target = { ...source, organization: 'vertical' as const };
  const job = h.result.current.requestTarget(target); let result!: ReturnType<typeof computeMapPlane>;
  await act(async () => { port.finish(1); result = await job.result; h.result.current.adoptTarget(target, result); });
  h.rerender({ value: { ...target, anchors: result.anchors }, scope: 'authority1' });
  expect(h.result.current.complete).toBe(true); expect(h.result.current.visible?.layout).toBe(result);
  expect(port.sent).toHaveLength(2);
});

test('an old switch adoption callback cannot cross an authority generation', async () => {
  const source = input(), h = mount(source); await act(async () => ports[0].finish(0));
  const oldAdopt = h.result.current.adoptTarget;
  h.rerender({ value: null, scope: 'authority1' }); h.rerender({ value: source, scope: 'authority1' });
  expect(() => oldAdopt(source, computeMapPlane(source))).toThrow('Map authority changed');
  expect(h.result.current.complete).toBe(false); expect(h.result.current.visible).toBeNull();
});

test.each(['switch', 'idle'] as const)('%s terminal failure after normal settlement exposes explicit recovery', async channel => {
  const source = input(), h = mount(source), port = ports[0];
  await act(async () => port.finish(0)); expect(h.result.current.complete).toBe(true);
  const job = channel === 'switch' ? h.result.current.requestTarget({ ...source, organization: 'vertical' }) : null;
  const rejected = job?.result.catch(error => error);
  await act(async () => port.onerror?.(new Event('error')));
  if (rejected) expect(await rejected).toBeInstanceOf(Error);
  expect(h.result.current.error?.message).toBe('Map calculation worker failed');
  expect(h.result.current.complete).toBe(false); expect(ports).toHaveLength(1);
  act(() => h.result.current.retry()); expect(ports).toHaveLength(2);
  await act(async () => ports[1].finish(0));
  expect(h.result.current.error).toBeNull(); expect(h.result.current.complete).toBe(true);
});
