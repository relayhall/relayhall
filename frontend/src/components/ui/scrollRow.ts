import { useEffect } from 'react';

/** Edge distance kept between the focused control and the row's own edge. */
const ROW_EDGE_PX = 8;

/**
 * Bring a focused control fully inside a row that scrolls sideways (E464).
 *
 * A browser scrolls a focused control into view only when it is mostly hidden:
 * one that is half cut off at the edge of the row stays half cut off. This
 * closes that gap for a toolbar that is one scrolling line on a phone. It is
 * horizontal only: it assigns `scrollLeft` on the row and calls nothing that
 * scrolls an ancestor (`scrollIntoView` can move the page). A control wider
 * than the row is aligned to the row's start. A row that does not overflow is
 * left alone, so on a wide screen this never does anything. Exported for the
 * unit test.
 */
export function scrollFocusedIntoRow(row: HTMLElement, target: HTMLElement): void {
  if (!row.contains(target) || row.scrollWidth <= row.clientWidth + 1) return;
  const port = row.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  let delta = 0;
  if (item.left < port.left + ROW_EDGE_PX || item.width > port.width - 2 * ROW_EDGE_PX) {
    delta = item.left - port.left - ROW_EDGE_PX;
  } else if (item.right > port.right - ROW_EDGE_PX) {
    delta = item.right - port.right + ROW_EDGE_PX;
  }
  if (delta !== 0) row.scrollLeft += delta;
}

/**
 * Keep the focused control of a sideways-scrolling toolbar row in view, for
 * keyboard, switch and screen-reader focus alike. The row is passed as an
 * element held in state, so the listener follows it as it mounts and unmounts.
 */
export function useFocusScrollsRow(row: HTMLElement | null): void {
  useEffect(() => {
    if (!row) return undefined;
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) scrollFocusedIntoRow(row, event.target);
    };
    row.addEventListener('focusin', onFocusIn);
    return () => row.removeEventListener('focusin', onFocusIn);
  }, [row]);
}
