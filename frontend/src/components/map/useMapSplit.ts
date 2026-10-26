import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

/**
 * The Map and list split (card cae8dfe1, absorbed RH-UI.17d).
 *
 * "It would add an option to grab and resize list size." The list opens BELOW
 * the canvas with a separator between them; dragging the separator, or the
 * arrow keys on it, trades map area against list area. Neither pane can be
 * dragged to nothing.
 *
 * WHAT IS REMEMBERED, AND WHERE. Whether the split is open and how tall the
 * list is are kept for the browser tab, the way the Map's view state is
 * (sessionStorage; design 77950a97 §6). That is a reading preference about
 * the SCREEN, never plane geometry: the plane's layout is a function of what
 * is shown and the session's order (owner ruling E386), the split only
 * changes how much of the screen the canvas gets, and a resized canvas
 * changes the camera's viewport and nothing the layout reads.
 */

export const MAP_SPLIT_STORAGE_KEY = 'relayhall_map_split_v1';
/** The list never shrinks below this, nor below a quarter of the space. */
export const SPLIT_LIST_MIN = 120;
/** The canvas keeps at least this, or two fifths of the space when it is small. */
export const SPLIT_CANVAS_MIN = 200;
/** The drawer the list used to be: 40% of the space shared with the canvas. */
export const SPLIT_DEFAULT_SHARE = 0.4;
/** One arrow press; PageUp/PageDown move four of these. */
export const SPLIT_KEY_STEP = 24;
/** The CSS property the list's flex basis reads (MapView.css). */
export const SPLIT_SIZE_PROPERTY = '--map-split-list-size';
/** The list height assumed before the space has been measured. */
const SPLIT_FALLBACK_LIST = 240;
const SPLIT_SANE_MAX = 10000;

export interface StoredMapSplit {
  open: boolean;
  /** The list's height in CSS pixels, or null for the default share. */
  listSize: number | null;
}

/** Reads defensively: a corrupt or absent entry is a closed split. */
export function readStoredSplit(): StoredMapSplit {
  try {
    const raw = sessionStorage.getItem(MAP_SPLIT_STORAGE_KEY);
    if (!raw) return { open: false, listSize: null };
    const parsed = JSON.parse(raw) as Partial<StoredMapSplit> | null;
    const size = typeof parsed?.listSize === 'number' && Number.isFinite(parsed.listSize)
      && parsed.listSize > 0 && parsed.listSize <= SPLIT_SANE_MAX ? Math.round(parsed.listSize) : null;
    return { open: parsed?.open === true, listSize: size };
  } catch {
    return { open: false, listSize: null };
  }
}

function storeSplit(split: StoredMapSplit) {
  try {
    sessionStorage.setItem(MAP_SPLIT_STORAGE_KEY, JSON.stringify(split));
  } catch {
    // A storage quota or a privacy mode must never break the Map.
  }
}

/**
 * The bounds the list height may take in `available` pixels of shared space
 * (the canvas plus the list). Both panes keep a floor; on a short screen the
 * floors shrink in proportion, so they can never sum past the space.
 */
export function splitBounds(available: number): { min: number; max: number } {
  if (!(available > 0)) return { min: SPLIT_LIST_MIN, max: SPLIT_SANE_MAX };
  const min = Math.round(Math.min(SPLIT_LIST_MIN, available * 0.25));
  const canvasMin = Math.min(SPLIT_CANVAS_MIN, available * 0.4);
  const max = Math.max(min, Math.round(available - canvasMin));
  return { min, max };
}

export function clampListSize(value: number, available: number): number {
  const { min, max } = splitBounds(available);
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface UseMapSplitOptions {
  /** The Map section, its toolbar and the separator: the space is what they leave. */
  section: HTMLElement | null;
  toolbar: HTMLElement | null;
  separator: HTMLElement | null;
}

export interface UseMapSplitResult {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The list height now, clamped to the space the two panes share. */
  listSize: number;
  bounds: { min: number; max: number };
  /** The separator's keyboard and pointer contract. */
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
}

export function useMapSplit({ section, toolbar, separator }: UseMapSplitOptions): UseMapSplitResult {
  const [stored] = useState(readStoredSplit);
  const [open, setOpenState] = useState(stored.open);
  const [listSize, setListSize] = useState<number | null>(stored.listSize);
  const [available, setAvailable] = useState(0);

  /** The space the canvas and the list share, read from the real boxes. */
  const measure = useCallback(() => {
    if (!section) return 0;
    const total = section.getBoundingClientRect().height;
    const used = (toolbar?.getBoundingClientRect().height ?? 0)
      + (separator?.getBoundingClientRect().height ?? 0);
    const next = Math.max(0, Math.round(total - used));
    setAvailable(previous => (previous === next ? previous : next));
    return next;
  }, [section, toolbar, separator]);

  // The bounds follow the space: a window resize can make a remembered height
  // too tall for the canvas floor, and the clamp below answers it at once.
  useEffect(() => {
    if (!section || !open) return undefined;
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(() => { measure(); });
    observer.observe(section);
    return () => observer.disconnect();
  }, [section, open, measure]);

  const current = clampListSize(
    listSize ?? (available > 0 ? available * SPLIT_DEFAULT_SHARE : SPLIT_FALLBACK_LIST), available);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    storeSplit({ open: next, listSize });
  }, [listSize]);

  const commit = useCallback((value: number) => {
    const next = clampListSize(value, measure() || available);
    setListSize(next);
    storeSplit({ open: true, listSize: next });
    return next;
  }, [measure, available]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const { min, max } = splitBounds(measure() || available);
    // The value is the LIST's height and the list is below the separator:
    // moving the separator up (ArrowUp, PageUp) gives the list more.
    const step = event.key === 'ArrowUp' ? SPLIT_KEY_STEP
      : event.key === 'ArrowDown' ? -SPLIT_KEY_STEP
        : event.key === 'PageUp' ? SPLIT_KEY_STEP * 4
          : event.key === 'PageDown' ? -SPLIT_KEY_STEP * 4 : null;
    const next = step !== null ? current + step
      : event.key === 'Home' ? min
        : event.key === 'End' ? max : null;
    if (next === null) return;
    event.preventDefault();
    commit(next);
  }, [measure, available, current, commit]);

  /**
   * A drag writes the list's height straight onto the section's custom
   * property, so a pointer move does not re-render the plane; the value is
   * committed (state and storage) once, when the pointer lifts. The committed
   * state then writes the same property, so the two never disagree.
   */
  const drag = useRef<{ pointerId: number; startY: number; startSize: number; space: number; last: number } | null>(null);
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId, startY: event.clientY, startSize: current,
      space: measure() || available, last: current,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [measure, available, current]);
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.last = clampListSize(active.startSize + (active.startY - event.clientY), active.space);
    section?.style.setProperty(SPLIT_SIZE_PROPERTY, `${active.last}px`);
  }, [section]);
  const finish = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commit(active.last);
  }, [commit]);

  return {
    open, setOpen, listSize: current, bounds: splitBounds(available),
    onKeyDown, onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish,
  };
}
