import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  AVAILABLE_ORGANIZATIONS,
  type MapAltitude,
  type MapOrganization,
} from './mapGraphModel';

/**
 * Map view state (design 77950a97 §8): organization, altitude, zoom and pan,
 * persisted per session and restored on Back.
 *
 * THE ONE RULE THIS HOOK EXISTS TO ENFORCE: the fresh-view flag is a REF and
 * is NEVER persisted. In the abandoned attempt it was written to
 * sessionStorage, so every reload re-fired a fit and destroyed the Back
 * restoration it was meant to serve (diagnosis 7fa7e605 §C). Persisted state
 * never re-fits.
 *
 * ALTITUDE IS PART OF THE VIEW, and is persisted WITH the scale rather than
 * derived from it (amendment §2/§5-A2). Each altitude has its own plane, so a
 * scale means nothing without the altitude it was taken in: restoring
 * `scale: 0.48` alone would place the reader at the phase altitude's zoom on
 * the task altitude's half-million-pixel plane. The pair travels together or
 * neither does.
 */

// The organization vocabulary and its SHIPPED subset live with the layout
// engine (design 77950a97 §8: organizations are layout concepts, and the
// A7b engine work lands there first); re-exported here so view-state
// consumers keep their one import site.
export { AVAILABLE_ORGANIZATIONS } from './mapGraphModel';
export type { MapOrganization } from './mapGraphModel';

const ALTITUDES: readonly MapAltitude[] = ['task', 'phase', 'project'];

export interface MapViewState {
  organization: MapOrganization;
  altitude: MapAltitude;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const DEFAULT_VIEW: MapViewState = {
  organization: 'horizontal', altitude: 'task', scale: 1, offsetX: 0, offsetY: 0,
};

export const SCALE_MIN = 0.12;
export const PLANE_SCALE_MIN = 0.05;
export const SCALE_MAX = 2.5;

const STORAGE_KEY = 'relayhall_map_view';

export const clampScale = (scale: number, floor = SCALE_MIN) =>
  Math.min(SCALE_MAX, Math.max(floor, Number.isNaN(scale) ? floor : scale));

/** Fit the whole plane with ten percent of the viewport free on each side. */
export function planeFitScale(
  plane: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  if (viewport.width <= 0 || viewport.height <= 0) return PLANE_SCALE_MIN;
  return clampScale(Math.min(
    viewport.width * 0.8 / Math.max(1, plane.width),
    viewport.height * 0.8 / Math.max(1, plane.height),
  ), PLANE_SCALE_MIN);
}

/** Reads defensively: a corrupt or partial entry falls back, never throws. */
export function readPersistedView(): MapViewState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MapViewState>;
    const organization = parsed.organization === 'radial' ? 'organic' : AVAILABLE_ORGANIZATIONS.includes(parsed.organization as MapOrganization)
      ? parsed.organization as MapOrganization
      : DEFAULT_VIEW.organization;
    // An entry written before the hierarchy shipped has no altitude. It is
    // not corrupt, it is OLD, and its scale was taken at the task altitude —
    // which is exactly what the default says, so it restores correctly.
    const altitude = ALTITUDES.includes(parsed.altitude as MapAltitude)
      ? parsed.altitude as MapAltitude
      : DEFAULT_VIEW.altitude;
    const numeric = (value: unknown, fallback: number) =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return {
      organization,
      altitude,
      scale: clampScale(numeric(parsed.scale, DEFAULT_VIEW.scale), PLANE_SCALE_MIN),
      offsetX: numeric(parsed.offsetX, 0),
      offsetY: numeric(parsed.offsetY, 0),
    };
  } catch {
    return null;
  }
}

export interface UseMapViewStateResult {
  view: MapViewState;
  setScaleFloor: (floor: number) => void;
  setOrganization: (organization: MapOrganization) => void;
  zoomTo: (scale: number, anchor?: { x: number; y: number }) => void;
  zoomBy: (factor: number, anchor?: { x: number; y: number }) => void;
  panBy: (dx: number, dy: number) => void;
  /**
   * Replace the whole view atomically — altitude, scale and offset in ONE
   * commit. `zoomBy` above stays the anchor-preserving zoom WITHIN an
   * altitude, which is all it ever was and all its tests assert. Crossing an
   * altitude additionally remaps the offset onto a different plane, and that
   * cannot be two setState calls: the intermediate would paint a frame with
   * the new scale against the old plane.
   */
  applyView: (next: (previous: MapViewState) => MapViewState) => void;
  /** Apply a computed fit. Clears the pending-fit flag. */
  applyFit: (fit: MapViewState) => void;
  /**
   * True only while a FRESH view still needs its one fit. Restored state
   * returns false forever — reading it consumes nothing.
   */
  needsFit: () => boolean;
  /** Explicit user action ("Fit"), always allowed. */
  requestRefit: () => void;
  /**
   * Bumped by `requestRefit`. The pending-fit flag is a REF — it must never be
   * persisted, which is the whole reason it is a ref — but a ref cannot wake
   * the effect that spends it. Round 1 reproduced the consequence: the toolbar
   * Fit control set the flag and nothing rendered, so Fit did nothing at all
   * until some unrelated update happened to come along. Depending on this
   * value is what schedules that render.
   */
  refitNonce: number;
}

export function useMapViewState(): UseMapViewStateResult {
  const restored = useMemo(() => readPersistedView(), []);
  const [view, setView] = useState<MapViewState>(() => restored ?? DEFAULT_VIEW);

  const floorRef = useRef(SCALE_MIN);
  const setScaleFloor = useCallback((floor: number) => {
    floorRef.current = clampScale(floor, PLANE_SCALE_MIN);
    setView(previous => {
      const scale = clampScale(previous.scale, floorRef.current);
      return scale === previous.scale ? previous : { ...previous, scale };
    });
  }, []);

  // REF, not state, and not persisted: a fresh view owes exactly one fit.
  const pendingFitRef = useRef(restored === null);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view));
    } catch {
      // A storage quota or a privacy mode must never break the Map.
    }
  }, [view]);

  const setOrganization = useCallback((organization: MapOrganization) => {
    setView(previous => previous.organization === organization
      ? previous
      : { ...previous, organization });
  }, []);

  const applyView = useCallback(
    (next: (previous: MapViewState) => MapViewState) => setView(next),
    [],
  );

  const zoomTo = useCallback((scale: number, anchor?: { x: number; y: number }) => {
    setView(previous => {
      const next = clampScale(scale, floorRef.current);
      if (next === previous.scale) return previous;
      if (!anchor) return { ...previous, scale: next };
      // Keep the anchor point stationary: the plane coordinate under the
      // cursor must not move while the scale changes.
      const planeX = (anchor.x - previous.offsetX) / previous.scale;
      const planeY = (anchor.y - previous.offsetY) / previous.scale;
      return {
        ...previous,
        scale: next,
        offsetX: anchor.x - planeX * next,
        offsetY: anchor.y - planeY * next,
      };
    });
  }, []);

  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    setView(previous => {
      const next = clampScale(previous.scale * factor, floorRef.current);
      if (next === previous.scale) return previous;
      if (!anchor) return { ...previous, scale: next };
      const planeX = (anchor.x - previous.offsetX) / previous.scale;
      const planeY = (anchor.y - previous.offsetY) / previous.scale;
      return {
        ...previous,
        scale: next,
        offsetX: anchor.x - planeX * next,
        offsetY: anchor.y - planeY * next,
      };
    });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    setView(previous => ({ ...previous, offsetX: previous.offsetX + dx, offsetY: previous.offsetY + dy }));
  }, []);

  const applyFit = useCallback((fit: MapViewState) => {
    pendingFitRef.current = false;
    setView(previous => ({ ...fit, organization: previous.organization }));
  }, []);

  const needsFit = useCallback(() => pendingFitRef.current, []);
  const [refitNonce, setRefitNonce] = useState(0);
  const requestRefit = useCallback(() => {
    pendingFitRef.current = true;
    // The ref carries the DEBT; this carries the WAKE-UP. Without it the
    // pending-fit effect has no reason to re-run and Fit is inert.
    setRefitNonce(nonce => nonce + 1);
  }, []);

  return {
    view, setScaleFloor, setOrganization, zoomTo, zoomBy, panBy, applyView, applyFit,
    needsFit, requestRefit, refitNonce,
  };
}
