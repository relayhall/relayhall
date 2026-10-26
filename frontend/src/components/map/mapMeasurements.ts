import type { SizeMap } from './mapGraphModel';

export interface MapMeasurements {
  /** All painted elements: Fit readiness, card bounds and legacy altitudes. */
  sizes: SizeMap;
  /** Only task and task-report ink is read by continuous plane geometry. */
  planeSizes: SizeMap;
}

export interface MapMeasuredSize {
  id: string;
  w: number;
  h: number;
  planeGeometry: boolean;
}

/** Apply one DOM read batch, copying each affected map at most once. */
export function recordMapMeasurements(previous: MapMeasurements, batch: readonly MapMeasuredSize[]): MapMeasurements {
  let sizes: Record<string, SizeMap[string]> | undefined;
  let planeSizes: Record<string, SizeMap[string]> | undefined;
  for (const { id, w, h, planeGeometry } of batch) {
    if (!w || !h) continue;
    const known = (sizes ?? previous.sizes)[id];
    const ink = (planeSizes ?? previous.planeSizes)[id];
    const same = known?.w === w && known.h === h;
    const sameInk = ink?.w === w && ink.h === h;
    if (same && (!planeGeometry || sameInk)) continue;
    const box = { w, h };
    if (!same) {
      sizes ??= { ...previous.sizes };
      sizes[id] = box;
    }
    if (planeGeometry && !sameInk) {
      planeSizes ??= { ...previous.planeSizes };
      planeSizes[id] = box;
    }
  }
  return !sizes && !planeSizes ? previous
    : { sizes: sizes ?? previous.sizes, planeSizes: planeSizes ?? previous.planeSizes };
}

export function recordMapMeasurement(
  previous: MapMeasurements, id: string, w: number, h: number, planeGeometry: boolean,
): MapMeasurements {
  if (!w || !h) return previous;
  const known = previous.sizes[id];
  const ink = previous.planeSizes[id];
  const same = known?.w === w && known.h === h;
  const sameInk = ink?.w === w && ink.h === h;
  if (same && (!planeGeometry || sameInk)) return previous;
  const box = { w, h };
  return {
    sizes: same ? previous.sizes : { ...previous.sizes, [id]: box },
    planeSizes: !planeGeometry || sameInk ? previous.planeSizes
      : { ...previous.planeSizes, [id]: box },
  };
}
