import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MapPlaneWorkerClient, type MapPlaneWorkerPort, type MapPlaneJob } from './mapPlaneWorkerClient';
import type { MapPlaneRequest } from './mapPlaneWorkerProtocol';
import { computeMapPlane, type MapPlaneInput } from './computeMapPlane';
import type { MapGraph, MapOrganization } from './mapGraphModel';
import recorded from './__fixtures__/organic-density.json';
import { EMPTY_PLANE_ANCHORS } from './mapPlaneModel';

const input = (): MapPlaneInput => ({ graph: { nodes: [], edges: [], phases: [] }, sizes: {},
  organization: 'organic', anchors: structuredClone(EMPTY_PLANE_ANCHORS) });
const result = () => ({ elements: [], width: 10, height: 20, anchors: structuredClone(EMPTY_PLANE_ANCHORS) });
class Port implements MapPlaneWorkerPort {
  sent: MapPlaneRequest[] = [];
  onmessage: MapPlaneWorkerPort['onmessage'] = null;
  onerror: MapPlaneWorkerPort['onerror'] = null;
  onmessageerror: MapPlaneWorkerPort['onmessageerror'] = null;
  terminate = vi.fn();
  postMessage = vi.fn((request: MapPlaneRequest) => { this.sent.push(request); });
  reply(index: number, extra = {}) {
    const request = this.sent[index];
    this.onmessage?.({ data: { id: request.id, channel: request.channel, ok: true, result: result(), ...extra } } as MessageEvent);
  }
}
const clients: MapPlaneWorkerClient[] = [];
function setup() { const port = new Port(); const client = new MapPlaneWorkerClient(() => port); clients.push(client); return { port, client }; }
const observe = (job: MapPlaneJob) => job.result.catch((error: Error) => error);
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { clients.splice(0).forEach(c => c.dispose()); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.restoreAllMocks(); });

test('submits a snapshot, validates reply and reuses its single worker', async () => {
  const { port, client } = setup(); const source = input(); const first = client.submit('layout', source);
  source.graph.nodes.push({ id: 'late', title: 'late', status: 'todo', priority: 'normal', project: null, phaseId: null, updated: '' });
  expect(port.sent[0].input.graph.nodes).toEqual([]);
  port.reply(0); expect(await first.result).toEqual(result());
  const next = client.submit('switch', input()); port.reply(1); await next.result;
  expect(port.terminate).not.toHaveBeenCalled();
});

test('supersession retains occupied slot, coalesces pending jobs and gives both channels service', async () => {
  const { port, client } = setup();
  const a = observe(client.submit('layout', input()));
  const b = observe(client.submit('layout', input()));
  const sw = client.submit('switch', input());
  const source = input(); const latest = client.submit('layout', source);
  source.anchors = { ...source.anchors, laneOrder: ['mutated after submission'] };
  expect((await a) as Error).toMatchObject({ name: 'AbortError' });
  expect((await b) as Error).toMatchObject({ name: 'AbortError' });
  expect(port.sent).toHaveLength(1);
  port.reply(0); expect(port.sent[1].channel).toBe('switch');
  port.reply(1); await sw.result; expect(port.sent[2].channel).toBe('layout');
  expect(port.sent[2].input.anchors.laneOrder).toEqual([]);
  port.reply(2); await latest.result;
});

test('explicit active cancellation keeps busy slot and pending cancellation never dispatches', async () => {
  const { port, client } = setup(); const a = client.submit('layout', input()); const pa = observe(a);
  const b = client.submit('switch', input()); const pb = observe(b);
  a.cancel(); b.cancel(); expect(port.sent).toHaveLength(1);
  expect(await pa).toMatchObject({ name: 'AbortError' }); expect(await pb).toMatchObject({ name: 'AbortError' });
  port.reply(0); expect(port.sent).toHaveLength(1);
});

test('unknown and duplicate replies cannot release an occupied slot', async () => {
  const { port, client } = setup(); const a = client.submit('layout', input()); const b = client.submit('switch', input());
  port.reply(0, { id: 999 }); expect(port.sent).toHaveLength(1);
  port.reply(0); await a.result; expect(port.sent).toHaveLength(2);
  port.reply(0); expect(vi.getTimerCount()).toBe(1);
  port.reply(1); await b.result;
});

test.each([{ channel: 'wrong' }, { ok: 'yes' }, { result: {} }, { result: { ...result(), width: NaN } },
  { result: { ...result(), anchors: { version: 1, laneOrder: [], slots: {} } } },
  { result: { ...result(), elements: [{ id: 'bad', kind: 'tile', x: 0, y: 0, w: 1, h: 1 }] } },
  { ok: false, error: 42 }])(
  'malformed active reply fails all consumers: %j', async extra => {
    const { port, client } = setup(); const a = observe(client.submit('layout', input())); const b = observe(client.submit('switch', input()));
    port.reply(0, extra); expect(await a).toBeInstanceOf(Error); expect(await b).toBeInstanceOf(Error);
    expect(port.terminate).toHaveBeenCalledTimes(1); expect(port.sent).toHaveLength(1);
    expect(port.onmessage).toBeNull(); expect(port.onerror).toBeNull(); expect(port.onmessageerror).toBeNull();
  });

test.each(['error', 'messageerror', 'replyError', 'postMessage'] as const)('terminal %s rejects pending work and never retries', async kind => {
  const { port, client } = setup();
  if (kind === 'postMessage') port.postMessage.mockImplementationOnce(() => { throw new Error('clone transport'); });
  const a = observe(client.submit('layout', input())); const b = observe(client.submit('switch', input()));
  if (kind === 'error') port.onerror?.(new Event('error'));
  if (kind === 'messageerror') port.onmessageerror?.({} as MessageEvent);
  if (kind === 'replyError') port.reply(0, { ok: false, error: 'calculation failed' });
  expect(await a).toBeInstanceOf(Error); expect(await b).toBeInstanceOf(Error);
  expect(await observe(client.submit('layout', input()))).toBeInstanceOf(Error);
  expect(port.terminate).toHaveBeenCalledTimes(1); client.dispose(); expect(port.terminate).toHaveBeenCalledTimes(1);
});

test('deadline begins at dispatch and repeated supersession cannot reset it', async () => {
  const { port, client } = setup(); const promises = [observe(client.submit('layout', input()))];
  for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(5_000); promises.push(observe(client.submit('layout', input()))); }
  promises.push(observe(client.submit('switch', input())));
  vi.advanceTimersByTime(4_999); expect(port.terminate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(port.terminate).toHaveBeenCalledTimes(1); expect(port.sent).toHaveLength(1);
  const errors = await Promise.all(promises); expect(errors.every(e => e instanceof Error)).toBe(true);
  expect(errors.at(-1)).toMatchObject({ message: 'Map calculation timed out' });
});

test('queued request receives its own full deadline after dispatch', async () => {
  const { port, client } = setup(); const a = client.submit('layout', input()); const b = observe(client.submit('switch', input()));
  vi.advanceTimersByTime(29_000); port.reply(0); await a.result;
  vi.advanceTimersByTime(29_999); expect(port.terminate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(await b).toMatchObject({ message: 'Map calculation timed out' });
});

test('dispose before submission or before queued dispatch rejects without more messages', async () => {
  const { port, client } = setup(); const a = observe(client.submit('layout', input())); const b = observe(client.submit('switch', input()));
  const late = port.onmessage; client.dispose();
  expect(await a).toMatchObject({ name: 'AbortError' }); expect(await b).toMatchObject({ name: 'AbortError' });
  late?.({ data: { id: 1, channel: 'layout', ok: true, result: result() } } as MessageEvent);
  expect(await observe(client.submit('layout', input()))).toMatchObject({ name: 'AbortError' }); expect(port.sent).toHaveLength(1);
  const before = setup(); before.client.dispose(); expect(await observe(before.client.submit('layout', input()))).toBeInstanceOf(Error);
  expect(before.port.sent).toHaveLength(0);
});

test('constructor failure rejects submissions', async () => {
  const client = new MapPlaneWorkerClient(() => { throw new Error('unavailable'); }); clients.push(client);
  expect(await observe(client.submit('layout', input()))).toMatchObject({ message: 'unavailable' });
});

test('terminal failure notification covers idle clients and is emitted once', async () => {
  const port = new Port(), notified = vi.fn();
  const client = new MapPlaneWorkerClient(() => port, notified); clients.push(client);
  const job = client.submit('layout', input()); port.reply(0); await job.result;
  port.onerror?.(new Event('error')); client.dispose();
  expect(notified).toHaveBeenCalledTimes(1);
  expect(notified).toHaveBeenCalledWith(expect.objectContaining({ message: 'Map calculation worker failed' }));
  const constructorFailed = vi.fn();
  clients.push(new MapPlaneWorkerClient(() => { throw new Error('start failed'); }, constructorFailed));
  expect(constructorFailed).toHaveBeenCalledWith(expect.objectContaining({ message: 'start failed' }));
});

test('uncloneable input rejects only that submission without displacing valid work', async () => {
  const { port, client } = setup(); const a = client.submit('layout', input());
  const bad = { ...input(), uncloneable: () => {} };
  expect(await observe(client.submit('layout', bad))).toBeInstanceOf(Error);
  expect(port.sent).toHaveLength(1); port.reply(0); expect(await a.result).toEqual(result());
});

test.each(['horizontal','vertical','organic','radial'] as MapOrganization[])('%s nonempty engine output passes the actual reply boundary', async organization => {
  const { port, client } = setup();
  const source = { ...input(), graph: structuredClone(recorded) as MapGraph, organization };
  const job = client.submit('layout', source);
  const calculated = computeMapPlane(port.sent[0].input);
  expect(calculated.elements.length).toBeGreaterThan(0);
  port.reply(0, { result: structuredClone(calculated) });
  expect(await job.result).toEqual(calculated);
});
