import { afterEach, expect, test, vi } from 'vitest';
import { computeMapPlane, type MapPlaneInput } from './computeMapPlane';
import { EMPTY_PLANE_ANCHORS } from './mapPlaneModel';
import type { MapPlaneReply, MapPlaneRequest } from './mapPlaneWorkerProtocol';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
test('worker entry preserves envelope and complete calculation result', async () => {
  const port = { onmessage: null as ((event: MessageEvent<MapPlaneRequest>) => void) | null,
    postMessage: vi.fn<[MapPlaneReply], void>() };
  vi.stubGlobal('self', port); await import('./mapPlane.worker');
  const input: MapPlaneInput = { graph: { nodes: [{ id: 'one', title: 'One', project: 'Project', phaseId: null,
    priority: 'normal', status: 'todo', updated: '' }], edges: [], phases: [] }, sizes: {}, organization: 'organic',
    anchors: structuredClone(EMPTY_PLANE_ANCHORS) };
  port.onmessage?.({ data: { id: 19, channel: 'switch', input } } as MessageEvent<MapPlaneRequest>);
  expect(port.postMessage).toHaveBeenCalledWith({ id: 19, channel: 'switch', ok: true, result: computeMapPlane(input) });
  expect(structuredClone(port.postMessage.mock.calls[0][0])).toEqual(port.postMessage.mock.calls[0][0]);
});

test('worker entry sends an explicit failure for a calculation error', async () => {
  const port = { onmessage: null as ((event: MessageEvent<MapPlaneRequest>) => void) | null,
    postMessage: vi.fn<[MapPlaneReply], void>() };
  vi.stubGlobal('self', port); await import('./mapPlane.worker');
  port.onmessage?.({ data: { id: 20, channel: 'layout', input: {} as MapPlaneInput } } as MessageEvent<MapPlaneRequest>);
  expect(port.postMessage).toHaveBeenCalledTimes(1);
  expect(port.postMessage.mock.calls[0][0]).toMatchObject({ id: 20, channel: 'layout', ok: false, error: expect.any(String) });
});
