import { describe, expect, test } from 'vitest';
import { routeEdge, routeFlowEdge, type Box, type MapOrganization } from './mapGraphModel';
import { computeMapRoutes, snapshotMapRoutes, mapRoutesSignature, pendingMapRoute,
  type MapRoutesInput } from './computeMapRoutes';
import { answerMapRoutes } from './mapRoutes.worker';

const a = { x: 30, y: 40, w: 40, h: 30 }, b = { x: 250, y: 160, w: 40, h: 30 };
const envelope = { x: 0, y: 0, w: 500, h: 400 };
const input = (): MapRoutesInput => ({ requests: [{ key: 'a-b', mode: 'flow', source: a, target: b }],
  obstacles: [a, b], envelope, organization: 'organic' });

describe.each(['horizontal', 'vertical', 'organic', 'radial'] as MapOrganization[])('%s exact prior caller parity', organization => {
  test.each(['ordinary', 'reverse', 'self', 'coincident', 'blocked', 'report'] as const)('%s', kind => {
    const source = kind === 'reverse' ? b : a;
    const target = kind === 'reverse' ? a : kind === 'self' ? a : kind === 'coincident' ? { ...a } : b;
    const report = kind === 'report';
    const obstacles = [source, target, { x: 100, y: 50, w: 50, h: 140 },
      ...(kind === 'blocked' ? [{ x: 0, y: 0, w: 500, h: 400 }] : [])];
    const stable = JSON.parse(JSON.stringify(obstacles)) as Box[];
    const contains = (o: Box, i: Box) => o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
    const filtered = stable.filter(o => !contains(o, source) && !contains(o, target) && !contains(source, o) && !contains(target, o));
    const batch: MapRoutesInput = { organization, envelope, obstacles,
      requests: [
        { key: 'task', source, target, mode: 'flow', report },
        { key: 'plane', source, target, mode: 'plane-edge', report },
        { key: 'legacy', source, target, mode: 'legacy-edge', report },
      ] };
    const expected = [routeFlowEdge(source, target, filtered, envelope, organization, report, 0, true),
      routeEdge(source, target, stable, envelope), routeEdge(source, target, obstacles, envelope)];
    // Exercise both the geometry snapshot and the actual structured-clone boundary.
    const copy = structuredClone(snapshotMapRoutes(batch));
    expect(computeMapRoutes(copy).map(row => row.route)).toEqual(expected);
    expect(answerMapRoutes({ id: 7, input: copy })).toEqual({ id: 7, ok: true,
      result: batch.requests.map((request, i) => ({ key: request.key, route: expected[i] })) });
  });
});

test('geometry snapshots strip metadata, preserve aliases, and isolate caller mutation', () => {
  const rich = { ...a, privateTitle: 'not sent' };
  const value = input(); value.requests[0].source = rich; value.requests[0].target = rich; value.obstacles = [rich, { ...rich }];
  const copy = snapshotMapRoutes(value);
  expect(copy.requests[0].source).toBe(copy.requests[0].target);
  expect(copy.obstacles[0]).toBe(copy.requests[0].source);
  expect(copy.obstacles[1]).not.toBe(copy.obstacles[0]);
  expect(copy.obstacles[0]).not.toHaveProperty('privateTitle');
  rich.x = 900; expect(copy.requests[0].source.x).toBe(30);
});

test('signature captures values, order, routing flags and alias topology', () => {
  const original = input(); const key = mapRoutesSignature(original);
  expect(mapRoutesSignature(snapshotMapRoutes(original))).toBe(key);
  const variants: MapRoutesInput[] = [
    { ...original, organization: 'vertical' }, { ...original, envelope: null },
    { ...original, obstacles: [...original.obstacles].reverse() },
    { ...original, requests: [{ ...original.requests[0], report: true }] },
    { ...original, requests: [{ ...original.requests[0], source: { ...a } }] },
    { ...original, requests: [{ ...original.requests[0], mode: 'legacy-edge' }] },
  ];
  for (const value of variants) expect(mapRoutesSignature(value)).not.toBe(key);
});

test('empty batches settle empty and pending self/coincident ink has visible extent', () => {
  expect(computeMapRoutes({ ...input(), requests: [] })).toEqual([]);
  expect(pendingMapRoute(a, a).d).toContain('l 16 -16');
  expect(pendingMapRoute(a, { ...a })).toEqual(pendingMapRoute(a, a));
  expect(pendingMapRoute(a, b)).toEqual({ d: 'M 50 55 L 270 175', clipped: true });
});

test('signature distinguishes non-finite numbers and signed zero across snapshot/clone', () => {
  const keys = [NaN, Infinity, -Infinity, -0, 0].map(x => {
    const value = input(); value.requests = [{ ...value.requests[0], source: { ...a, x } }];
    const signature = mapRoutesSignature(value);
    expect(mapRoutesSignature(structuredClone(snapshotMapRoutes(value)))).toBe(signature);
    return signature;
  });
  expect(new Set(keys).size).toBe(keys.length);
});
