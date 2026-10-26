import type { MapGraph, MapOrganization, SizeMap } from './mapGraphModel';
import { layoutContinuousPlane, type MapPlaneAnchors, type PlaneLayoutResult } from './mapPlaneModel';

/** Immutable computation input; no browser, camera, persistence or network ownership. */
export interface MapPlaneInput {
  graph: MapGraph;
  sizes: SizeMap;
  organization: MapOrganization;
  anchors: MapPlaneAnchors;
}

/**
 * The plane for one input. E386: what the archived toggle changes is what is
 * SHOWN (the graph), and the plane fits that. The density migration that used
 * to run here first upgraded a layout record a released Map had stored; no
 * record is stored or read any more, so there is nothing to upgrade.
 */
export function computeMapPlane(input: MapPlaneInput): PlaneLayoutResult {
  const { graph, sizes, organization, anchors } = input;
  return layoutContinuousPlane(graph, sizes, organization, anchors);
}
