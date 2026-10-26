import { useState, type CSSProperties, type ReactNode } from 'react';

type Box = { x: number; y: number; w: number; h: number };
type Camera = { scale: number; offsetX: number; offsetY: number };

/** Conservative world-region admission; unknown viewport must not hide ink. */
export function containerCardInViewport(box: Box, camera: Camera,
  viewport: { width: number; height: number }, margin: number): boolean {
  if (viewport.width <= 0 || viewport.height <= 0 || camera.scale <= 0
    || ![box.x, box.y, box.w, box.h, camera.scale, camera.offsetX, camera.offsetY,
      viewport.width, viewport.height, margin].every(Number.isFinite)) return true;
  const left = box.x * camera.scale + camera.offsetX;
  const top = box.y * camera.scale + camera.offsetY;
  return left <= viewport.width + margin && left + box.w * camera.scale >= -margin
    && top <= viewport.height + margin && top + box.h * camera.scale >= -margin;
}

/** Only the expensive nested ink is virtualized. Its outer ground always stays. */
export function MapViewportCard({ admitted, measure, style, children }: {
  admitted: boolean;
  measure: (element: HTMLDivElement | null) => void;
  style: CSSProperties;
  children: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  // The parent keys this component by authority and organization. Removed
  // membership unmounts it, so focus retention cannot retain old authority.
  if (!admitted && !focused) return null;
  return <div className="map-container-card" style={style} ref={measure}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={event => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocused(false);
    }}>{children}</div>;
}

/** Fit every caption into the existing 192-world-unit header reservation,
 * leaving a 16-unit gutter on each side.
 * Keep readable screen size while there is room; never let zoom enlarge
 * the caption over its children. The world layout stays stationary. */
export function boundedHeaderStyle(width: number, scale: number): CSSProperties {
  const factor = Math.max(0, Math.min(1 / Math.max(scale, 0.001), 160 / 120, Math.max(0, width - 32) / 220));
  return { width: 220, maxInlineSize: 'none', height: 120, maxHeight: 120,
    maxBlockSize: 120, boxSizing: 'border-box', overflow: 'hidden',
    transform: `translate(16px, 16px) scale(${factor})`, transformOrigin: 'top left' };
}
