import { expect, test } from 'vitest';
import { computeMapPlane, type MapPlaneInput } from './computeMapPlane';
import type { MapGraph, MapOrganization } from './mapGraphModel';
import { EMPTY_PLANE_ANCHORS, layoutContinuousPlane } from './mapPlaneModel';
import recorded from './__fixtures__/organic-density.json';

// The worker, its synchronous fallback and a switch target all lay the plane
// out through this wrapper, so it must BE the engine: the same result for the
// same input, and the input never written. (E386 removed the density
// migration that used to run first: it upgraded a layout record a released
// Map had stored, and no record is stored or read any more.)
function compare(input: MapPlaneInput) {
  const before = structuredClone(input);
  const actual = computeMapPlane(input);
  expect(actual).toEqual(layoutContinuousPlane(input.graph, input.sizes, input.organization, input.anchors));
  expect(input).toEqual(before);
  return actual;
}

test.each(['horizontal', 'vertical', 'organic', 'radial'] as MapOrganization[])(
  '%s wrapper is the engine for fresh, held, measured and metadata input', organization => {
    const input: MapPlaneInput = { graph: structuredClone(recorded) as MapGraph, sizes: {}, organization,
      anchors: structuredClone(EMPTY_PLANE_ANCHORS) };
    const fresh = compare(input); input.anchors = fresh.anchors; compare(input);
    input.sizes = Object.fromEntries(input.graph.nodes.map(n => [n.id, { w: 180, h: 150 }])); compare(input);
    input.graph.nodes[0] = { ...input.graph.nodes[0], title: 'Current title', agent: 'Active', progress: { done: 2, total: 3 } };
    compare(input);
  });
