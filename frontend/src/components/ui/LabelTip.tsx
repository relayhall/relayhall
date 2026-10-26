import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './LabelTip.css';

/**
 * The visible label of an icon-only toolbar button on a phone (E469).
 *
 * A native `title` never shows on touch, so a phone's icon-only buttons had no
 * visible name. This is the ONE shared label: a small `role="tooltip"` bubble
 * that appears on a long press (touch, pen), on hover (a mouse at phone width)
 * and on keyboard focus (`:focus-visible`), for the controls of a row that
 * carry `data-label-tip` (the kit's `labelTip` prop on Button, IconButton and
 * a SegmentedControl option). It is dismissed on release, pointer-leave, blur,
 * Escape and scroll.
 *
 * Phone width only (768 px and below, the range of the phone toolbar rules):
 * wider than that the hook does nothing at all, so the desktop toolbars keep
 * the native title exactly as before.
 *
 * Rules the component keeps:
 * - A long press (about 500 ms, moving less than 10 px) shows the label and
 *   fires NO click: the click the browser may send on release is swallowed in
 *   the capture phase before any handler sees it, and the context menu, the
 *   selection and the iOS callout are suppressed (LabelTip.css).
 * - `aria-describedby` points at the bubble only WHILE it is shown, and only
 *   when the label adds something: a label the accessible name already contains
 *   is not announced a second time. An existing `aria-describedby` is kept.
 * - The native `title` is set aside while the bubble is shown, so a mouse does
 *   not get two tooltips, and put back when it goes.
 * - The bubble is a fixed-position portal (nothing clips it, nothing around it
 *   moves), centred on the control, above it when there is room and below it
 *   otherwise, and clamped to the screen edges.
 */

/** The attribute that opts a control in; the kit components write it for `labelTip`. */
export const LABEL_TIP_ATTRIBUTE = 'data-label-tip';
/** How long a touch must rest on a control before its label shows. */
export const LONG_PRESS_MS = 500;
/** How long a mouse rests on a control before its label shows. */
export const HOVER_DELAY_MS = 300;
/** How long the label stays when the mouse leaves, so it can be reached (WCAG 1.4.13). */
export const HOVER_LEAVE_GRACE_MS = 150;
/** A press that moves farther than this is a scroll or a drag, not a long press. */
export const LONG_PRESS_SLOP_PX = 10;
/** How long after a long press's release a click on the same control is swallowed. */
export const CLICK_SUPPRESS_MS = 700;
/** A scroll this soon after the label appeared is the focus scrolling the row, not the reader. */
export const SCROLL_GRACE_MS = 250;
/** The phone range: the same 768 px the phone toolbar rules use. */
export const LABEL_TIP_PHONE_QUERY = '(max-width: 768px)';

const EDGE_PX = 8;
const GAP_PX = 8;

type Source = 'press' | 'hover' | 'focus';

interface Shown {
  target: HTMLElement;
  label: string;
  source: Source;
}

interface Placed {
  shown: Shown;
  left: number;
  top: number;
  placement: 'above' | 'below';
}

function isPhoneWidth(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') return window.matchMedia(LABEL_TIP_PHONE_QUERY).matches;
  return window.innerWidth <= 768;
}

function findTarget(row: HTMLElement, node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const target = node.closest<HTMLElement>(`[${LABEL_TIP_ATTRIBUTE}]`);
  return target && row.contains(target) ? target : null;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function accessibleNameOf(target: HTMLElement): string {
  return target.getAttribute('aria-label') ?? target.textContent ?? '';
}

/** The words the bubble shows: an explicit value, else the title, else the accessible name. */
function labelOf(target: HTMLElement): string {
  const explicit = target.getAttribute(LABEL_TIP_ATTRIBUTE);
  const text = explicit || target.getAttribute('title') || accessibleNameOf(target);
  return text.replace(/\s+/g, ' ').trim();
}

function focusIsVisible(target: HTMLElement, modality: 'keyboard' | 'pointer'): boolean {
  try {
    return target.matches(':focus-visible');
  } catch {
    return modality === 'keyboard';
  }
}

/**
 * Wire the label to a toolbar row (an element held in state, like
 * `useFocusScrollsRow`) and return the bubble to render once anywhere in the
 * host's tree. Returns null while nothing is shown.
 */
export function useLabelTips(row: HTMLElement | null): React.ReactNode {
  const bubbleId = useId();
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const shownRef = useRef<Shown | null>(null);
  const shownAtRef = useRef(0);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [shown, setShownState] = useState<Shown | null>(null);

  // Everything that listens lives in one effect keyed on the row; it keeps its
  // own timers and press state in closure variables, and reaches React only
  // through show() and hide().
  useEffect(() => {
    if (!row) return undefined;

    let pressTimer: number | undefined;
    let hoverTimer: number | undefined;
    let press: { target: HTMLElement; x: number; y: number; id: number; fired: boolean } | null = null;
    let suppress: { target: HTMLElement; until: number } | null = null;
    let modality: 'keyboard' | 'pointer' = 'pointer';

    const clearHideTimer = () => {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    };
    const show = (target: HTMLElement, source: Source) => {
      window.clearTimeout(hoverTimer);
      clearHideTimer();
      const label = labelOf(target);
      if (!label) return;
      const next: Shown = { target, label, source };
      shownRef.current = next;
      shownAtRef.current = Date.now();
      setShownState(next);
    };
    const hide = () => {
      window.clearTimeout(hoverTimer);
      clearHideTimer();
      if (!shownRef.current) return;
      shownRef.current = null;
      setShownState(null);
    };

    const onPointerDown = (event: PointerEvent) => {
      hide();
      window.clearTimeout(pressTimer);
      press = null;
      if (!isPhoneWidth() || event.pointerType === 'mouse') return;
      const target = findTarget(row, event.target);
      if (!target) return;
      const current = { target, x: event.clientX, y: event.clientY, id: event.pointerId, fired: false };
      press = current;
      pressTimer = window.setTimeout(() => {
        current.fired = true;
        show(target, 'press');
      }, LONG_PRESS_MS);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!press || press.fired || event.pointerId !== press.id) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP_PX) {
        window.clearTimeout(pressTimer);
        press = null;
      }
    };
    const endPress = () => {
      window.clearTimeout(pressTimer);
      if (press?.fired) {
        // The release of a long press must not act on the control.
        suppress = { target: press.target, until: Date.now() + CLICK_SUPPRESS_MS };
      }
      press = null;
      if (shownRef.current?.source === 'press') hide();
    };
    const onClickCapture = (event: MouseEvent) => {
      if (!suppress) return;
      const { target, until } = suppress;
      if (Date.now() > until) {
        suppress = null;
        return;
      }
      if (event.target instanceof Node && target.contains(event.target)) {
        suppress = null;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const onContextMenu = (event: Event) => {
      // The long press's own menu (Android) — only while a press is on a labelled control.
      if (press || (suppress && Date.now() <= suppress.until)) event.preventDefault();
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || !isPhoneWidth()) return;
      const target = findTarget(row, event.target);
      if (!target) return;
      const from = event.relatedTarget;
      if (from instanceof Node && target.contains(from)) return;
      clearHideTimer();
      if (shownRef.current?.target === target) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => show(target, 'hover'), HOVER_DELAY_MS);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const target = findTarget(row, event.target);
      if (!target) return;
      const to = event.relatedTarget;
      if (to instanceof Node && target.contains(to)) return;
      window.clearTimeout(hoverTimer);
      if (shownRef.current?.source === 'hover' && shownRef.current.target === target) {
        clearHideTimer();
        hideTimerRef.current = window.setTimeout(hide, HOVER_LEAVE_GRACE_MS);
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isPhoneWidth()) return;
      const target = findTarget(row, event.target);
      if (!target || !focusIsVisible(target, modality)) return;
      show(target, 'focus');
    };
    const onFocusOut = (event: FocusEvent) => {
      const current = shownRef.current;
      if (current && event.target instanceof Node && current.target.contains(event.target)) hide();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      modality = 'keyboard';
      if (event.key === 'Escape') hide();
    };
    const onDocumentPointerDown = () => {
      modality = 'pointer';
    };
    const onScroll = () => {
      if (shownRef.current && Date.now() - shownAtRef.current > SCROLL_GRACE_MS) hide();
    };
    const onResize = () => hide();

    row.addEventListener('pointerdown', onPointerDown);
    row.addEventListener('pointermove', onPointerMove);
    row.addEventListener('pointerup', endPress);
    row.addEventListener('pointercancel', endPress);
    row.addEventListener('click', onClickCapture, true);
    row.addEventListener('contextmenu', onContextMenu);
    row.addEventListener('pointerover', onPointerOver);
    row.addEventListener('pointerout', onPointerOut);
    row.addEventListener('focusin', onFocusIn);
    row.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(pressTimer);
      window.clearTimeout(hoverTimer);
      clearHideTimer();
      row.removeEventListener('pointerdown', onPointerDown);
      row.removeEventListener('pointermove', onPointerMove);
      row.removeEventListener('pointerup', endPress);
      row.removeEventListener('pointercancel', endPress);
      row.removeEventListener('click', onClickCapture, true);
      row.removeEventListener('contextmenu', onContextMenu);
      row.removeEventListener('pointerover', onPointerOver);
      row.removeEventListener('pointerout', onPointerOut);
      row.removeEventListener('focusin', onFocusIn);
      row.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      shownRef.current = null;
      setShownState(null);
    };
  }, [row]);

  // While the bubble is shown: the control points at it (when it adds words)
  // and its native title is set aside. Both are undone when it goes.
  useEffect(() => {
    if (!shown) return undefined;
    const { target, label } = shown;
    const previousDescribedBy = target.getAttribute('aria-describedby');
    const previousTitle = target.getAttribute('title');
    const addsWords = !normalise(accessibleNameOf(target)).includes(normalise(label));
    if (addsWords) {
      target.setAttribute('aria-describedby', previousDescribedBy ? `${previousDescribedBy} ${bubbleId}` : bubbleId);
    }
    if (previousTitle !== null) target.removeAttribute('title');
    return () => {
      if (addsWords) {
        if (previousDescribedBy === null) target.removeAttribute('aria-describedby');
        else target.setAttribute('aria-describedby', previousDescribedBy);
      }
      // Put the title back unless the host has written a newer one meanwhile.
      if (previousTitle !== null && target.getAttribute('title') === null) target.setAttribute('title', previousTitle);
    };
  }, [shown, bubbleId]);

  // Position before paint: above the control when there is room, else below;
  // centred, then clamped to the screen edges.
  useLayoutEffect(() => {
    if (!shown) {
      setPlaced(null);
      return;
    }
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const box = shown.target.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    const left = Math.max(EDGE_PX, Math.min(box.left + box.width / 2 - width / 2, viewportWidth - width - EDGE_PX));
    let placement: 'above' | 'below' = 'above';
    let top = box.top - height - GAP_PX;
    if (top < EDGE_PX) {
      placement = 'below';
      top = box.bottom + GAP_PX;
      if (top + height > viewportHeight - EDGE_PX) top = Math.max(EDGE_PX, viewportHeight - height - EDGE_PX);
    }
    setPlaced({ shown, left, top, placement });
  }, [shown]);

  if (!shown || typeof document === 'undefined') return null;
  const ready = placed !== null && placed.shown === shown;
  return createPortal(
    <div
      ref={bubbleRef}
      id={bubbleId}
      role="tooltip"
      className="label-tip"
      data-source={shown.source}
      data-placement={ready ? placed.placement : undefined}
      style={ready ? { left: placed.left, top: placed.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onPointerEnter={() => window.clearTimeout(hideTimerRef.current)}
      onPointerLeave={() => {
        if (shownRef.current?.source === 'hover') {
          shownRef.current = null;
          setShownState(null);
        }
      }}
    >
      {shown.label}
    </div>,
    document.body
  );
}
