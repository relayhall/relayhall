import { useCallback, useEffect, useState } from 'react';

/**
 * Canvas interaction (design 77950a97 §8): pan, zoom-about-cursor and the
 * measured viewport.
 *
 * THE STRUCTURAL FIX: the canvas is held as ELEMENT-AS-STATE — a ref callback
 * that calls `setCanvas` — so effects depend on the element itself. In the
 * abandoned attempt the listener effect keyed on unrelated values and simply
 * never ran when the canvas mounted after a loading state; its ResizeObserver
 * sibling had the identical defect, freezing the viewport at 1200×800 and
 * poisoning culling, fitting and zoom anchoring (round 11 + diagnosis
 * 7fa7e605 §C). With the element in the dependency array the class is
 * impossible: no element, no effect; element arrives, effect runs.
 */

export interface Viewport { width: number; height: number }

export interface UseMapInteractionsOptions {
  onZoom: (factor: number, anchor: { x: number; y: number }) => void;
  onPan: (dx: number, dy: number) => void;
  /** Keyboard zoom has no cursor to anchor to; it uses the viewport centre. */
  onZoomCentre?: (factor: number) => void;
}

export interface UseMapInteractionsResult {
  /** Attach to the scrolling/zooming surface. */
  canvasRef: (element: HTMLDivElement | null) => void;
  canvas: HTMLDivElement | null;
  viewport: Viewport;
  isPanning: boolean;
}

const ZOOM_STEP = 1.0015;
/** Wheel deltas arrive in three units; only pixels can be used directly. */
const DELTA_LINE_PX = 16;
const DELTA_PAGE_PX = 400;
/** A drag must travel this far before it becomes a pan rather than a click. */
const PAN_THRESHOLD_PX = 4;
/** One arrow press moves the plane this far (§6 keyboard contract). */
const KEY_PAN_PX = 80;
const KEY_ZOOM_FACTOR = 1.2;

export function useMapInteractions(
  { onZoom, onPan, onZoomCentre }: UseMapInteractionsOptions,
): UseMapInteractionsResult {
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  const [isPanning, setIsPanning] = useState(false);

  const canvasRef = useCallback((element: HTMLDivElement | null) => {
    setCanvas(element);
  }, []);

  // Viewport measurement. Depends on the ELEMENT, so it runs the moment the
  // canvas exists — and reports the real box rather than a guessed default.
  useEffect(() => {
    if (!canvas) return undefined;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      setViewport(previous =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvas]);

  // Wheel zoom. Registered NON-PASSIVE and on the element itself, because
  // preventDefault on a passive listener is ignored and the page would scroll
  // instead of the map zooming.
  useEffect(() => {
    if (!canvas) return undefined;
    const onWheel = (event: WheelEvent) => {
      // deltaMode says what the number MEANS: Firefox reports lines (±3 per
      // notch) where Chrome reports pixels (±100), so treating it as pixels
      // unconditionally made Firefox zoom ~30x slower.
      const unit = event.deltaMode === 1 ? DELTA_LINE_PX
        : event.deltaMode === 2 ? DELTA_PAGE_PX : 1;
      const deltaPx = event.deltaY * unit;
      if (deltaPx === 0) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      onZoom(Math.pow(ZOOM_STEP, -deltaPx), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvas, onZoom]);

  // Pointer pan. Capture keeps the drag alive when the pointer leaves the
  // canvas, and a pointer that starts on an interactive descendant is left
  // alone so a tile keeps its click.
  useEffect(() => {
    if (!canvas) return undefined;
    // ONE gesture owner (§6). Pan and pinch used to be independent listeners
    // on this element, and the pan's only multi-pointer guard ignored
    // NON-primary moves — which says nothing about the primary pointer. With
    // two fingers down the primary kept panning while the pinch zoomed, so a
    // single physical pinch produced both (review 7fc68646 B1).
    //
    // Now the active pointer count chooses the branch. A pinch move cannot
    // reach the pan path at all, because the pan path is not merely guarded,
    // it is not selected.
    const active = new Map<number, { x: number; y: number }>();
    let armed = false;
    let panning = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let lastSpread = 0;

    const spread = () => {
      const points = [...active.values()];
      if (points.length < 2) return 0;
      return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    };
    const midpoint = () => {
      const points = [...active.values()];
      const rect = canvas.getBoundingClientRect();
      return {
        x: (points[0].x + points[1].x) / 2 - rect.left,
        y: (points[0].y + points[1].y) / 2 - rect.top,
      };
    };
    /** Drop any pan in flight without swallowing a click: a pinch is not a click. */
    const abandonPan = (pointerId: number) => {
      if (panning) {
        panning = false;
        setIsPanning(false);
        canvas.releasePointerCapture?.(pointerId);
      }
      armed = false;
    };

    const onPointerDown = (event: PointerEvent) => {
      active.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (active.size >= 2) {
        // The gesture is a pinch from this moment. Whatever pan was running
        // ends here rather than continuing underneath the zoom.
        for (const id of active.keys()) abandonPan(id);
        lastSpread = spread();
        return;
      }
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      // Text entry keeps its own pointer semantics entirely.
      if (target?.closest('input, textarea, select')) return;
      // A tile's opener stretches over the whole tile, so refusing to pan from
      // any interactive target meant the map could not be dragged from the one
      // surface that covers most of it. Every pointer arms a pan, and only
      // travel beyond a threshold turns it into one — below the threshold the
      // control keeps its click.
      armed = true;
      panning = false;
      startX = event.clientX; startY = event.clientY;
      lastX = event.clientX; lastY = event.clientY;
    };

    const onPointerMove = (event: PointerEvent) => {
      // Self-heal. A pointer reporting no buttons is not down any more, so a
      // lost pointerup cannot leave the gesture owner wedged. This matters
      // more since the pointer COUNT chooses the branch: one stale entry would
      // otherwise disable panning outright, which is the exact symptom this
      // card already had to fix once.
      if (event.buttons === 0 && active.has(event.pointerId)) {
        active.delete(event.pointerId);
        lastSpread = active.size === 2 ? spread() : 0;
      }
      if (active.has(event.pointerId)) {
        active.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (active.size >= 2) {
        if (active.size !== 2) return;
        const next = spread();
        if (!lastSpread || !next) return;
        onZoom(next / lastSpread, midpoint());
        lastSpread = next;
        return;
      }
      if (!armed) return;
      if (!panning) {
        if (Math.abs(event.clientX - startX) < PAN_THRESHOLD_PX &&
            Math.abs(event.clientY - startY) < PAN_THRESHOLD_PX) return;
        panning = true;
        setIsPanning(true);
        canvas.setPointerCapture?.(event.pointerId);
      }
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      onPan(dx, dy);
    };

    const onPointerUp = (event: PointerEvent) => {
      const wasPinching = active.size >= 2;
      active.delete(event.pointerId);
      lastSpread = active.size === 2 ? spread() : 0;
      if (wasPinching) {
        // A finger lifted out of a pinch. Do NOT resume panning with the
        // remaining one: the plane would jump by the gap between them.
        armed = false;
        return;
      }
      if (!armed) return;
      armed = false;
      if (panning) {
        panning = false;
        setIsPanning(false);
        canvas.releasePointerCapture?.(event.pointerId);
        // The gesture was a drag: swallow the click it would otherwise fire on
        // whatever control sits under the pointer.
        const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
        canvas.addEventListener('click', swallow, { capture: true, once: true });
        window.setTimeout(() => canvas.removeEventListener('click', swallow, { capture: true } as EventListenerOptions), 0);
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, [canvas, onPan, onZoom]);

  // Keyboard contract (§6): arrows pan, +/- zoom, Home refits via the
  // toolbar. Keyed on the element for the same reason as the others.
  useEffect(() => {
    if (!canvas) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      // Never steal keys from a control inside the canvas.
      const target = event.target as HTMLElement | null;
      if (target && target !== canvas && target.closest('button, a, input, select, textarea')) return;
      const step = event.shiftKey ? KEY_PAN_PX * 3 : KEY_PAN_PX;
      switch (event.key) {
        case 'ArrowLeft': onPan(step, 0); break;
        case 'ArrowRight': onPan(-step, 0); break;
        case 'ArrowUp': onPan(0, step); break;
        case 'ArrowDown': onPan(0, -step); break;
        case '+': case '=': onZoomCentre?.(KEY_ZOOM_FACTOR); break;
        case '-': case '_': onZoomCentre?.(1 / KEY_ZOOM_FACTOR); break;
        default: return;
      }
      event.preventDefault();
    };
    canvas.addEventListener('keydown', onKeyDown);
    return () => canvas.removeEventListener('keydown', onKeyDown);
  }, [canvas, onPan, onZoomCentre]);

  return { canvasRef, canvas, viewport, isPanning };
}
