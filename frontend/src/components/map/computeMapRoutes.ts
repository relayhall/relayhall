import { routeEdge, routeFlowEdge, type Box, type EdgeRoute, type MapOrganization } from './mapGraphModel';

export interface MapRouteRequest {
  key: string;
  source: Box;
  target: Box;
  mode: 'flow' | 'plane-edge' | 'legacy-edge';
  report?: boolean;
}
export interface MapRoutesInput {
  requests: MapRouteRequest[];
  obstacles: Box[];
  envelope: Box | null;
  organization: MapOrganization;
  /** Quantized screen scale; absent preserves legacy caller geometry. */
  scale?: number;
}
export type MapRoutesResult = Array<{ key: string; route: EdgeRoute }>;

/** Strip presentation/authority data while retaining reference-sensitive boxes. */
export function snapshotMapRoutes(input: MapRoutesInput): MapRoutesInput {
  const boxes = new Map<Box, Box>();
  const copy = (box: Box): Box => {
    let result = boxes.get(box);
    if (!result) { result = { x: box.x, y: box.y, w: box.w, h: box.h }; boxes.set(box, result); }
    return result;
  };
  return {
    requests: input.requests.map(request => ({ key: request.key, mode: request.mode,
      source: copy(request.source), target: copy(request.target), report: Boolean(request.report) })),
    obstacles: input.obstacles.map(copy), envelope: input.envelope && copy(input.envelope),
    organization: input.organization, scale: input.scale,
  };
}

/** Full ordered geometry plus alias topology; JSON alone loses endpoint identity. */
export function mapRoutesSignature(input: MapRoutesInput): string {
  const ids = new Map<Box, number>();
  // JSON conflates non-finite values and signed zero. Preserve their identity
  // even though normally admitted Map geometry is finite.
  const number = (value: number) => Object.is(value, -0) ? '-0'
    : Number.isFinite(value) ? value : String(value);
  const box = (value: Box) => {
    if (!ids.has(value)) ids.set(value, ids.size);
    return [ids.get(value), number(value.x), number(value.y), number(value.w), number(value.h)];
  };
  return JSON.stringify([input.organization, input.scale ?? null, input.envelope && box(input.envelope),
    input.obstacles.map(box), input.requests.map(request => [request.key, request.mode,
      Boolean(request.report), box(request.source), box(request.target)])]);
}

/** Exactly the three existing caller modes; no routing approximation or index. */
export function computeMapRoutes(input: MapRoutesInput): MapRoutesResult {
  const stableObstacles = input.obstacles.map(({ x, y, w, h }) => ({ x, y, w, h }));
  const contains = (outer: Box, inner: Box) => outer.x <= inner.x && outer.y <= inner.y
    && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;
  const scale = input.scale;
  const close = scale !== undefined && Number.isFinite(scale) && scale >= 0.35;
  const clearance = scale === undefined ? 0 : close ? Math.min(24, 8 / scale) : 2;
  const separation = close ? Math.min(20, 6 / scale!) : 5;
  const inflate = (box: Box, gap: number): Box => ({
    x: box.x-gap, y: box.y-gap, w: box.w+gap*2, h: box.h+gap*2,
  });
  const occupied: Box[] = [];
  return input.requests.map(({ key, source, target, mode, report }, index) => {
    const obstacles = mode === 'legacy-edge' ? input.obstacles : mode === 'plane-edge'
      ? stableObstacles : stableObstacles.filter(box => !contains(box, source) && !contains(box, target)
        && !contains(source, box) && !contains(target, box));
    if (mode !== 'flow') return { key, route: routeEdge(source, target, obstacles, input.envelope) };
    // Separate long shared corridors as well as attachment ports. Existing routes
    // are soft obstacles: a genuinely tight passage retains its verified fallback.
    const nearby = occupied.filter(box => !contains(box, source) && !contains(box, target)
      && !contains(source, box) && !contains(target, box));
    const portOffset = index === 0 ? 0 : (([...key].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 7) - 3) * 8;
    const padded = obstacles.map(box => inflate(box, clearance));
    let route = routeFlowEdge(source, target, [...padded, ...nearby], input.envelope,
      input.organization, report, portOffset, true);
    if (nearby.length) {
      const direct = routeFlowEdge(source, target, padded,
        input.envelope, input.organization, report, portOffset, true);
      const cost = (candidate: EdgeRoute) => {
        const points = candidate.points ?? [];
        let length = 0, bends = 0;
        for (let i = 1; i < points.length; i++) {
          length += Math.hypot(points[i][0]-points[i-1][0], points[i][1]-points[i-1][1]);
          if (i > 1 && (points[i][0]-points[i-1][0])*(points[i-1][1]-points[i-2][1])
            !== (points[i][1]-points[i-1][1])*(points[i-1][0]-points[i-2][0])) bends++;
        }
        return length + bends * 24;
      };
      // Other links are a preference, never a wall. Crossing one is better
      // than a large excursion around a whole row of task cards.
      if (!direct.clipped && (route.clipped || cost(route) > cost(direct) * 1.15 + 16)) route = direct;
    }
    // Preserve the real relation in a tight gap. Prefer card clearance over
    // avoiding crossings; only reduce the halo when no padded route exists.
    if (route.clipped && clearance > 2) route = routeFlowEdge(source, target,
      obstacles.map(box => inflate(box, 2)), input.envelope, input.organization, report, portOffset, true);
    if (!route.clipped) for (let i=1;i<(route.points?.length ?? 0);i++) {
      const a=route.points![i-1], b=route.points![i];
      if (a[1]===b[1] && Math.abs(b[0]-a[0])>80) occupied.push({
        x:Math.min(a[0],b[0])+24,y:a[1]-separation,w:Math.abs(b[0]-a[0])-48,h:separation*2 });
      if (a[0]===b[0] && Math.abs(b[1]-a[1])>80) occupied.push({
        x:a[0]-separation,y:Math.min(a[1],b[1])+24,w:separation*2,h:Math.abs(b[1]-a[1])-48 });
    }
    return { key, route };
  });
}

/** Temporary ink only. Even coincident endpoints remain visibly represented. */
export function pendingMapRoute(source: Box, target: Box): EdgeRoute {
  const x1 = source.x + source.w / 2, y1 = source.y + source.h / 2;
  const x2 = target.x + target.w / 2, y2 = target.y + target.h / 2;
  return { d: x1 === x2 && y1 === y2
    ? `M ${x1} ${y1} l 16 -16 l 16 16 l -16 16 Z`
    : `M ${x1} ${y1} L ${x2} ${y2}`, clipped: true };
}
