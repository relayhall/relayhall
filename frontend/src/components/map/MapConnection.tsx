import { useEffect, useRef, useState, type SVGProps } from 'react';

/** A bounded visual experiment: only the first twenty visible links animate. */
export function MapConnection({ pending, animate, scale = 1, ...props }: SVGProps<SVGPathElement> & {
  pending: boolean; animate: boolean; scale?: number;
}) {
  // A normalized drawing dash must not survive as the permanent stroke:
  // non-scaling-stroke leaves it shorter than the route when zoomed in.
  const [finishedRoute, setFinishedRoute] = useState<string>();
  const revealing = !pending && animate && finishedRoute !== props.d;
  useEffect(() => {
    if (pending) { setFinishedRoute(undefined); return; }
    if (!animate) return;
    // Also settle when reduced motion suppresses animationend.
    const timer = window.setTimeout(() => setFinishedRoute(props.d), 400);
    return () => window.clearTimeout(timer);
  }, [pending, animate, props.d]);
  const previousPending = useRef<string | undefined>(undefined);
  const [ghost, setGhost] = useState<string | undefined>();
  useEffect(() => {
    if (pending) { previousPending.current = props.d; setGhost(undefined); return; }
    if (!animate || !previousPending.current) return;
    setGhost(previousPending.current); previousPending.current = undefined;
    const timer = window.setTimeout(() => setGhost(undefined), 220);
    return () => window.clearTimeout(timer);
  }, [pending, props.d, animate]);
  return <>
    {ghost && !pending ? <path d={ghost} className="map-edge map-connection-ghost"
      strokeDasharray="3 5" fill="none" aria-hidden="true" pointerEvents="none" /> : null}
    <path {...props} key={pending ? 'pending' : props.d}
      pathLength={revealing ? 1 / (Number.isFinite(scale) && scale > 0 ? scale : 1) : undefined}
      onAnimationEnd={event => {
        setFinishedRoute(props.d);
        props.onAnimationEnd?.(event);
      }}
      className={`${props.className ?? ''}${revealing ? ' map-connection-reveal' : ''}`}
      style={{ ...props.style, ...(pending ? { opacity: Number(props.style?.opacity ?? 1) * .35 } : {}) }} />
  </>;
}
