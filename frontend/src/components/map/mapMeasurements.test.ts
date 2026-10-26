import { expect, test } from 'vitest';
import { recordMapMeasurement, recordMapMeasurements, type MapMeasurements } from './mapMeasurements';
import { layoutContinuousPlane, EMPTY_PLANE_ANCHORS } from './mapPlaneModel';
import type { MapGraph, MapOrganization } from './mapGraphModel';
import fixture from './__fixtures__/graph.task.json';

test('batched measurements preserve sequential results without mutating earlier states', () => {
  let seed = 9153;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  let previous: MapMeasurements = { sizes: {}, planeSizes: {} };
  for (let pass = 0; pass < 100; pass++) {
    const batch = Array.from({ length: 40 }, () => ({
      id: `element-${random() % 17}`, w: random() % 251, h: random() % 101,
      planeGeometry: random() % 3 === 0,
    }));
    Object.freeze(previous.sizes); Object.freeze(previous.planeSizes); Object.freeze(previous);
    const expected = batch.reduce((state, b) => recordMapMeasurement(state, b.id, b.w, b.h, b.planeGeometry), previous);
    const actual = recordMapMeasurements(previous, batch);
    expect(actual).toEqual(expected);
    expect(recordMapMeasurements(actual, [])).toBe(actual);
    previous = actual;
  }
});

test('batch keeps zero sizes, geometry promotion and last valid duplicate semantics', () => {
  const previous = recordMapMeasurement({ sizes: {}, planeSizes: {} }, 'task', 42, 23, false);
  const promoted = recordMapMeasurements(previous, [{ id: 'task', w: 42, h: 23, planeGeometry: true }]);
  expect(promoted.sizes).toBe(previous.sizes);
  expect(promoted.planeSizes.task).toEqual({ w: 42, h: 23 });
  expect(recordMapMeasurements(promoted, [
    { id: 'task', w: 42, h: 23, planeGeometry: true },
    { id: 'hidden', w: 0, h: 40, planeGeometry: true },
  ])).toBe(promoted);
  const updated = recordMapMeasurements(promoted, [
    { id: 'chip', w: 12, h: 100, planeGeometry: false },
    { id: 'chip', w: 23, h: 100, planeGeometry: false },
    { id: 'chip', w: 0, h: 0, planeGeometry: false },
  ]);
  expect(updated.sizes.chip).toEqual({ w: 23, h: 100 });
  expect(updated.planeSizes).toBe(promoted.planeSizes);
  expect(promoted.sizes.chip).toBeUndefined();
});

test('overview resizing preserves geometry identity while keeping current Fit/card measurements', () => {
  const start: MapMeasurements = { sizes: {}, planeSizes: {} };
  const task = recordMapMeasurement(start, 'task', 170, 96, true);
  const chip = recordMapMeasurement(task, 'chip:band', 12, 100, false);
  const zoom = recordMapMeasurement(chip, 'chip:band', 23, 100, false);
  const card = recordMapMeasurement(zoom, 'card:band', 300, 190, false);
  expect(card.planeSizes).toBe(task.planeSizes);
  expect(card.sizes['chip:band']).toEqual({ w: 23, h: 100 });
  expect(card.sizes['card:band']).toEqual({ w: 300, h: 190 });
  expect(chip.sizes['chip:band']).toEqual({ w: 12, h: 100 });
  const resized = recordMapMeasurement(card, 'task', 170, 120, true);
  expect(resized.planeSizes).not.toBe(card.planeSizes);
  expect(resized.planeSizes.task.h).toBe(120);
  expect(recordMapMeasurement(resized, 'task', 170, 120, true)).toBe(resized);
  expect(recordMapMeasurement(resized, 'hidden', 0, 0, true)).toBe(resized);
});

test('queued duplicate and later geometry measurements remain idempotent', () => {
  const first = recordMapMeasurement({ sizes: {}, planeSizes: {} }, 'same-id', 42, 23, false);
  const promoted = recordMapMeasurement(first, 'same-id', 42, 23, true);
  expect(promoted.sizes).toBe(first.sizes);
  expect(promoted.planeSizes['same-id']).toEqual({ w: 42, h: 23 });
  expect(recordMapMeasurement(promoted, 'same-id', 42, 23, true)).toBe(promoted);
});

test.each(['horizontal', 'vertical', 'organic', 'radial'])('%s measured geometry and saved anchors match the full measurement input', organization => {
  const graph = fixture as MapGraph;
  let measured: MapMeasurements = { sizes: {}, planeSizes: {} };
  for (const node of graph.nodes) measured = recordMapMeasurement(measured, node.id, 180, 112, true);
  const original = layoutContinuousPlane(graph, measured.sizes, organization as MapOrganization, structuredClone(EMPTY_PLANE_ANCHORS));
  for (const element of original.elements) if (element.kind === 'pill') {
    measured = recordMapMeasurement(measured, element.id, 42, 23, true);
  }
  measured = recordMapMeasurement(measured, 'chip:overview', 12, 100, false);
  measured = recordMapMeasurement(measured, 'card:overview', 350, 220, false);
  const full = layoutContinuousPlane(graph, measured.sizes, organization as MapOrganization, structuredClone(original.anchors));
  const projected = layoutContinuousPlane(graph, measured.planeSizes, organization as MapOrganization, structuredClone(original.anchors));
  expect(projected).toEqual(full);
});
