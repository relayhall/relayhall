import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileText, List, Maximize2, Minus, Plus } from 'lucide-react';

import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { TaskCard } from '../tasks/TaskCard';
import type { Task } from '../../types/task';
import type { MapGraphQuery } from './mapGraphApi';
import {
  DETAIL_MATRIX,
  detailBandFor,
  useMapData,
} from './useMapData';
import { useMapInteractions } from './useMapInteractions';
import { clampScale, planeFitScale, SCALE_MIN, useMapViewState } from './useMapViewState';
import {
  buildTreeModel,
  aggregateChainState,
  INITIAL_CORRECTIVE_FIT,
  aggregateEdgesToDraw,
  arrivalFitStep,
  buildChain,
  onExplicitFit,
  onExtentChanged,
  onFitSpent,
  paintedObstacles,
  type CorrectiveFitState,
  findOverlaps,
  AVAILABLE_ORGANIZATIONS,
  fitScaleFor,
  focusBoxAcross,
  focusedElement,
  initialAltitude,
  layoutAtAltitude,
  rollUpEdges,
  routeEdge,
  routeFlowEdge,
  settleAltitude,
  type AggregateEdge,
  type InternalRollup,
  type Box,
  type EdgeRoute,
  type AggregateFacts,
  type MapAltitude,
  type MapTaskNode,
  type PlacedAggregate,
  type PlacedAggregateReport,
  type PlacedReportPill,
  type PlacedTile,
  type SizeMap,
  containerMorphsFor,
  interpolateOutline,
  morphEase,
  outlineToPath,
  type ContainerMorph,
  type MapOrganization,
  type PlacedBand,
  type PlacedContainer,
  type PlacedHull,
} from './mapGraphModel';
import {
  FADE_EPSILON,
  PLANE_CARD_PX,
  PLANE_METRICS,
  planeDetailBand,
  dominantTier,
  layoutContinuousPlane,
  organicPlaneGraph,
  organicPhasePath,
  ORGANIC_CORE,
  planeFade,
  projectPlaneAttention,
  pruneAnchors,
  readPlaneAnchors,
  writePlaneAnchors,
  type MapPlaneAnchors,
  type PlaneFade,
  type PlaneTier,
} from './mapPlaneModel';
import { MapAggregateCard, type MapAggregateCardFacts } from './MapAggregateCard';
import './MapView.css';

/**
 * The Map — thin composition over three hooks and a pure layout engine
 * (design 77950a97 §8).
 *
 * The canvas is ALWAYS MOUNTED. Loading and error are overlays, never early
 * returns, because an early return unmounts the element every effect depends
 * on — which is how the abandoned attempt lost its listeners and froze its
 * viewport. There is exactly one `return` in this component.
 */

export interface MapViewProps {
  query: MapGraphQuery;
  onOpenTask: (taskId: string) => void;
  /**
   * Amendment §2/§5-A2 requires a Report drawn at an aggregate altitude to be
   * OPENABLE from the Map. Routing is the page's business, exactly as it is
   * for a Task, so the Map asks rather than navigating on its own.
   */
  onOpenReport?: (reportId: string) => void;
}

const ORGANIZATION_LABELS: Record<MapOrganization, string> = {
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  radial: 'Radial',
  organic: 'Organic',
};

/**
 * A3 retires Radial into Organic. Persisted Radial views migrate to Organic;
 * the public switcher offers the three owner-ratified organizations.
 */
const ORGANIZATION_OPTIONS: Array<SegmentedOption<MapOrganization>> = (
  ['horizontal', 'vertical', 'organic'] as const
).map(organization => ({
  value: organization,
  label: ORGANIZATION_LABELS[organization],
  disabled: !AVAILABLE_ORGANIZATIONS.includes(organization),
  title: AVAILABLE_ORGANIZATIONS.includes(organization)
    ? undefined
    : 'Coming with the organic organization',
}));

/**
 * Clause 2 (R3): "State stays legible at every altitude by tint:
 * essentially-complete reads green, blocked reads red, archived reads
 * faded." Round-1 finding 3 found only the blocked arm implemented, so at
 * the zoom where containers carry the plane three distinct required states
 * read as one. The precedence mirrors the tile rule: a dammed flow outranks
 * everything, and a region that is wholly archived is history rather than
 * work.
 */
export const planeStateClass = (facts: AggregateFacts): string => {
  if (facts.stuck > 0) return ' map-container--stuck';
  const active = facts.taskCount - facts.archived;
  if (facts.taskCount > 0 && active === 0) return ' map-container--archived';
  if (active > 0 && facts.completed >= active) return ' map-container--complete';
  return '';
};

/**
 * §4's chain dim, as a NUMBER rather than a class.
 *
 * "Click/focus a tile → its full upstream+downstream chain stays lit,
 * everything else dims (tiles to ~0.13 opacity, edges to ~0.05)." The
 * stylesheet has always said that with an `opacity` rule — which an INLINE
 * opacity beats outright, and the continuous plane gives every element an
 * inline opacity from the cross-fade. Left as a class, §4's dim would
 * simply stop happening on this plane.
 *
 * So the two statements COMPOSE, the way the three fade layers do: the
 * cross-fade says how much of this layer is on screen, the chain says how
 * much of the reader's attention this element has, and the product is what
 * is painted. Both constants are §4's own.
 */
export const CHAIN_DIM = { node: 0.13, edge: 0.05 } as const;

const chainScale = (
  chain: ReadonlySet<string> | null,
  isLit: boolean,
  dim: number,
) => (chain ? (isLit ? 1 : dim) : 1);

/** The Phase's identity is shared by its frame, label and container card. */
const phaseKeyOfBand = (band: Pick<PlacedBand, 'id' | 'laneId'>) =>
  `phase:${band.laneId}\u0000${band.id.slice(`band:${band.laneId}:`.length)}`;

/** Culling margin in screen px, so tiles exist slightly before they scroll in. */
const CULL_MARGIN = 240;

/**
 * §4: above this many VISIBLE edges, non-selected cross-lane edges collapse to
 * hover/selection-only. The design sets the starting point ("start ~60 visible
 * edges") and assigns the tuning to A7; 60 is that starting point, kept until
 * a measured reason to move it exists.
 */
export const EDGE_DENSITY_THRESHOLD = 60;

/**
 * Which organizations render as ONE CONTINUOUS PLANE (amendment §2/§5-A3).
 *
 * This is the slice's switch, and it is an ORGANIZATION switch rather than a
 * build flag on purpose: A3's plane is a different world, not a different
 * setting of the same one, and half of it is not a state anything should be
 * able to land in. The vertical, radial and organic organizations keep the
 * A2 altitude hierarchy — unchanged, reachable, and still passing their own
 * suites — until their slices land (card 03acc0b2 subtasks 3 and 4).
 */
export const CONTINUOUS_PLANE_ORGANIZATIONS: readonly MapOrganization[] = ['horizontal', 'vertical', 'radial', 'organic'];

export const MapView: React.FC<MapViewProps> = ({ query, onOpenTask, onOpenReport }) => {
  const { graph, isLoading, error, pulsed, refetch } = useMapData(query);
  const {
    view, setScaleFloor, zoomBy, panBy, applyView, applyFit, needsFit, requestRefit, refitNonce,
  } = useMapViewState();
  const [treeMode, setTreeMode] = useState(false);
  /** §4: which tile the reader is pointing at, or has focused. Collapsed
   *  cross-lane edges are disclosed through this, so it must be state — those
   *  edges are not in the DOM for a stylesheet to reveal. */
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // ---- measurement: the SizeMap is the layout's only source of geometry ----
  // Tiles report their real box; the layout re-runs with measured values.
  // Nothing here guesses a height (diagnosis 7fa7e605 P3).
  const [sizes, setSizes] = useState<SizeMap>({});
  const sizesRef = useRef<SizeMap>({});
  sizesRef.current = sizes;
  const measure = useCallback((id: string, element: HTMLElement | null) => {
    if (!element) return;
    // offsetWidth/Height are LAYOUT dimensions: a CSS transform does not
    // touch them, so these are already plane units. Deriving them from
    // getBoundingClientRect and dividing by the scale made the stored size
    // drift by a rounding step on every zoom, which re-laid out, which
    // re-measured — a loop that only shows up once you zoom real content.
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    if (!w || !h) return;
    const known = sizesRef.current[id];
    if (known && known.w === w && known.h === h) return;
    setSizes(previous => ({ ...previous, [id]: { w, h } }));
  }, []);


  const onZoom = useCallback((factor: number, anchor: { x: number; y: number }) => {
    zoomBy(factor, anchor);
  }, [zoomBy]);
  const viewportRef = useRef({ width: 0, height: 0 });
  const onZoomCentre = useCallback((factor: number) => {
    const { width, height } = viewportRef.current;
    zoomBy(factor, { x: width / 2, y: height / 2 });
  }, [zoomBy]);
  const { canvasRef, viewport, isPanning } = useMapInteractions({ onZoom, onPan: panBy, onZoomCentre });
  viewportRef.current = viewport;

  // The aggregate grid is built for the shape it will actually be read in, so
  // the layout depends on the viewport's aspect as well as on the data.
  const aspect = viewport.width && viewport.height
    ? viewport.width / viewport.height
    : 16 / 10;
  const altitudeOptions = useMemo(
    () => ({ clampScale, viewport, organization: view.organization }),
    [viewport, view.organization],
  );

  // ---- the continuous plane (amendment §2/§5-A3) --------------------------
  const continuous = CONTINUOUS_PLANE_ORGANIZATIONS.includes(view.organization);

  /**
   * The anchors are a REF, restored once from localStorage.
   *
   * They are deliberately not state. The engine is a FIXED POINT in them
   * (asserted in mapPlaneModel.test.ts), so writing back what a layout just
   * decided cannot change what that layout decided; making them state would
   * schedule a second render per layout for a picture identical to the
   * first. The ref is read at layout time and written at layout time, and
   * the effect below is the only thing that touches storage.
   */
  const anchorsRef = useRef<Partial<Record<MapOrganization, MapPlaneAnchors>>>({});
  const planeLayout = useMemo(() => {
    if (!continuous) return null;
    const held = anchorsRef.current[view.organization] ?? readPlaneAnchors(view.organization);
    const result = layoutContinuousPlane(graph, sizes, view.organization, held);
    anchorsRef.current[view.organization] = result.anchors;
    return result;
  }, [continuous, graph, sizes, view.organization]);

  /**
   * Clause 6: "stability holds across sessions".
   *
   * DEBOUNCED, because the record is not small. Measured on the 5,023-task
   * portal it serialises to 692 KB, and this effect re-runs on every
   * measurement pass — tiles report their boxes in dribs as culling admits
   * them, so an undebounced write would stringify most of a megabyte dozens
   * of times while the reader is trying to pan. The layout does not depend on
   * the write, so the last one wins and the ones in between were never
   * needed.
   */
  useEffect(() => {
    if (!planeLayout) return undefined;
    const timer = window.setTimeout(() => {
      const landed = writePlaneAnchors(
        pruneAnchors(planeLayout.anchors, new Set(graph.nodes.map(node => node.id))), view.organization);
      // Round-1 finding 5: a refused write costs the reader the
      // cross-session half of clause 6, and swallowing that silently is not
      // good enough. The Map still works; the record does not.
      if (!landed && import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn('[Map] the layout record could not be stored; '
          + 'positions will not survive this session');
      }
    }, 750);
    return () => window.clearTimeout(timer);
  }, [planeLayout, graph.nodes, view.organization]);

  /**
   * The container card's MEASURED CSS box (round-1 finding 4).
   *
   * Every container card is the same component at the same declared width,
   * so one measurement speaks for all of them — but their HEIGHTS differ,
   * because the counter row wraps. The maximum measured height is taken and
   * never given back, so the fit test below is conservative: a card that
   * has ever been that tall is assumed to be that tall again. Until the
   * first card has reported, the designed box stands in, exactly as every
   * other fallback on this plane does.
   */
  const cardBox = useMemo(() => {
    // Annotated: PLANE_CARD_PX is `as const`, so its members are literal
    // types and an inferred accumulator could never be widened.
    let w: number = PLANE_CARD_PX.w;
    let h: number = PLANE_CARD_PX.h;
    for (const [id, box] of Object.entries(sizes)) {
      if (!id.startsWith('card:')) continue;
      w = Math.max(w, box.w);
      h = Math.max(h, box.h);
    }
    return { w, h };
  }, [sizes]);

  const layout = useMemo(
    () => planeLayout
      ?? layoutAtAltitude(graph, sizes, view.altitude, aspect, view.organization),
    [planeLayout, graph, sizes, view.altitude, aspect, view.organization],
  );

  const scaleFloor = continuous ? planeFitScale(layout, viewport) : SCALE_MIN;
  // Clamp restored views and resized planes before paint. All input paths use
  // this same floor through the view hook, including pinch and keyboard zoom.
  useLayoutEffect(() => {
    if (!isLoading) setScaleFloor(scaleFloor);
  }, [isLoading, scaleFloor, setScaleFloor]);

  /**
   * The cross-fade (clause 1). It is a pure function of the plane and the
   * scale, it touches no geometry, and it is what makes an altitude a
   * RENDERING CONSEQUENCE of the zoom rather than a mode: nothing here
   * decides where anything is.
   */
  const fade: PlaneFade | null = useMemo(
    () => (planeLayout ? planeFade(planeLayout.elements, view.scale) : null),
    [planeLayout, view.scale],
  );
  const taskAlpha = useCallback(
    (id: string) => (fade ? (fade.task.get(id) ?? 0) : 1), [fade]);
  const projectAlpha = useCallback(
    (laneId: string) => (fade ? (fade.projectRamp.get(laneId) ?? 0) : 0), [fade]);
  /**
   * Who is in charge of a region. Exactly ONE layer is interactive at a
   * time; the other two are §5's status-tinted shapes — drawn, aria-hidden,
   * and reachable by nobody. Three focusable copies of the same work is the
   * failure this prevents, and it is a failure a screen-reader reader would
   * meet before anyone else did.
   */
  const tierOf = useCallback(
    (bandId: string | null | undefined, laneId: string | undefined): PlaneTier => {
      if (!fade) return 'task';
      return dominantTier(
        bandId ? (fade.phaseRamp.get(bandId) ?? 0) : 0,
        fade.projectRamp.get(laneId ?? '') ?? 0);
    },
    [fade],
  );

  /**
   * The continuous plane has NO altitudes to normalise against, but a view
   * restored from a session that used them can still be carrying one. It is
   * corrected once, so leaving the plane for an organization that does have
   * altitudes starts from a coherent state rather than a stale one.
   */
  useEffect(() => {
    if (continuous && view.altitude !== 'task') {
      applyView(previous => ({ ...previous, altitude: 'task' }));
    }
  }, [continuous, view.altitude, applyView]);

  // The §2 invariant, surfaced in development rather than merely asserted in
  // a test: if real measurements ever produce a collision, say so loudly. It
  // reaches the aggregate altitudes unchanged — findOverlaps compares
  // same-kind pairs, and an aggregate is a kind.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const overlaps = findOverlaps(layout.elements);
    if (overlaps.length) {
      console.warn('[Map] layout produced overlapping elements', overlaps.slice(0, 5));
    }
  }, [layout]);

  // ---- altitude transitions (amendment §2/§5-A2) --------------------------
  // A zoom is an anchor-preserving operation WITHIN an altitude; crossing one
  // is settled here, after the fact. That is safe precisely because
  // settleAltitude is a FIXED POINT — once a transition is applied, the next
  // run of this effect settles the new state to itself and stops. Without that
  // property this effect would be a render loop.
  useEffect(() => {
    // A3 clause 1 retires the discrete machinery for the continuous plane:
    // there is no altitude to settle, no entry width to land on and no
    // hysteresis to keep, because nothing transitions. Leaving this running
    // would have it re-deciding a value the plane does not use.
    if (continuous) return;
    if (!viewport.width || !viewport.height) return;
    if (graph.nodes.length === 0) return;
    // Arrival owns the altitude until the one-shot fit has landed; letting
    // both choose in the same commit is two authorities on one value.
    if (needsFit()) return;
    const settled = settleAltitude(
      graph, sizes, { altitude: view.altitude, scale: view.scale }, altitudeOptions,
    );
    // A settle can change the SCALE without changing the altitude — the
    // coarsest altitude holds its readability floor that way. Returning early
    // on altitude alone silently dropped that, and live QA caught it: the
    // project altitude still bottomed out at SCALE_MIN with 26px nodes after
    // the floor was implemented, because this guard threw the result away.
    // Comparing with an epsilon keeps float jitter from re-applying forever.
    const altitudeChanged = settled.altitude !== view.altitude;
    const scaleChanged = Math.abs(settled.scale - view.scale) > 1e-6;
    if (!altitudeChanged && !scaleChanged) return;
    if (!altitudeChanged) {
      applyView(previous => ({ ...previous, scale: settled.scale }));
      return;
    }

    const nextLayout = layoutAtAltitude(
      graph, sizes, settled.altitude, aspect, view.organization);
    const centreX = viewport.width / 2;
    const centreY = viewport.height / 2;
    // Land on the SAME TASKS the reader was looking at — found through
    // membership, not geometry. Carrying the NORMALISED centre across instead
    // is what live QA at 5,200 tasks caught: descending from the phase
    // altitude put the view at offsetY -696,634 on a 1,495,990px-tall plane,
    // showing five tiles unrelated to the Phase that had been on screen. The
    // same fraction of a compact grid and of a lane stack are not the same
    // place; the same Tasks are.
    const planePoint = {
      x: (centreX - view.offsetX) / view.scale,
      y: (centreY - view.offsetY) / view.scale,
    };
    const focus = focusBoxAcross(layout, view.altitude, nextLayout, settled.altitude, planePoint);
    const targetX = focus ? focus.x + focus.w / 2 : nextLayout.width / 2;
    const targetY = focus ? focus.y + focus.h / 2 : nextLayout.height / 2;
    // Selection is altitude-scoped: its ids mean different things on either
    // side of the transition, so it is cleared rather than carried across.
    setSelectedId(null);
    setHoveredId(null);
    applyView(previous => ({
      ...previous,
      altitude: settled.altitude,
      scale: settled.scale,
      offsetX: centreX - targetX * settled.scale,
      offsetY: centreY - targetY * settled.scale,
    }));
  }, [
    continuous,
    graph, sizes, view.altitude, view.scale, view.offsetX, view.offsetY,
    view.organization, viewport, aspect, layout, applyView, needsFit,
    altitudeOptions,
  ]);

  const tileById = useMemo(
    () => new Map(layout.elements.filter((e): e is PlacedTile => e.kind === 'tile').map(t => [t.id, t])),
    [layout],
  );

  // Chain selection (§4): focusing or clicking a Task lights its full
  // upstream AND downstream chain and dims everything else; empty canvas
  // clears it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const chain = useMemo(
    () => buildChain(selectedId, graph.edges, id => tileById.has(id)),
    [selectedId, graph.edges, tileById],
  );

  const planeBand = planeDetailBand(PLANE_METRICS.tileCellW * view.scale);
  const band = continuous
    ? ({ full: 'close', compact: 'mid', aggregate: 'overview', silhouette: 'far' } as const)[planeBand]
    : detailBandFor(view.scale);
  const detail = DETAIL_MATRIX[band];

  // ---- viewport culling: bounded live DOM, tiles never "vanish" logically --
  const visibleTiles = useMemo(() => {
    const tiles = layout.elements
      .filter((e): e is PlacedTile => e.kind === 'tile')
      // A tile its container has completely taken over carries no ink and no
      // meaning, and drawing it would spend DOM on nothing. It has not moved
      // and it has not been re-decided — it is simply too far away to be a
      // thing, exactly as a street is on a map of a country.
      //
      // This is applied BEFORE the viewport test, not inside it: culling
      // stands down when the viewport has no size yet, and the cross-fade
      // must not stand down with it.
      .filter(tile => !fade || (fade.task.get(tile.id) ?? 0) > FADE_EPSILON);
    if (!viewport.width || !viewport.height) return tiles;
    const left = (-view.offsetX - CULL_MARGIN) / view.scale;
    const top = (-view.offsetY - CULL_MARGIN) / view.scale;
    const right = (viewport.width - view.offsetX + CULL_MARGIN) / view.scale;
    const bottom = (viewport.height - view.offsetY + CULL_MARGIN) / view.scale;
    return tiles.filter(tile =>
      tile.x + tile.w >= left && tile.x <= right &&
      tile.y + tile.h >= top && tile.y <= bottom);
  }, [layout, viewport, view.offsetX, view.offsetY, view.scale, fade]);


  /** Chain state colours the edge (§4): red dammed, blue in flight, green satisfied. */
  const edgeState = useCallback((toId: string) => {
    const upstream = tileById.get(toId)?.node.status;
    // "dammed" is the design's own word for a stuck upstream — the ratified
    // vocabulary (b94dd86e) for this state is `stuck`/`dammed`.
    if (upstream === 'stuck') return 'dammed';
    if (upstream === 'completed') return 'satisfied';
    if (upstream === 'in-progress' || upstream === 'review') return 'active';
    return 'neutral';
  }, [tileById]);

  // §6's alternative is built from the GRAPH, so it is the same scope at every
  // altitude. Building it from the layout made it EMPTY at the aggregate
  // altitudes, which is where a large estate now arrives (round 1, B5).
  const tree = useMemo(() => buildTreeModel(graph), [graph]);

  /**
   * §4 density collapse. Above the threshold — the design says tune it in A7
   * and start around 60 VISIBLE edges — non-selected CROSS-LANE edges stop
   * being drawn at all and return only through selection or hover. Below it
   * every edge renders, which is the estate's normal case.
   *
   * Counted on drawable edges (both endpoints placed), because that is what
   * "visible" means to a reader; counting the graph's whole edge list would
   * trip the threshold on edges nobody can see.
   */
  const drawableEdges = useMemo(
    () => graph.edges.filter(edge => tileById.has(edge.from) && tileById.has(edge.to)),
    [graph.edges, tileById],
  );
  const laneOf = useCallback(
    (taskId: string) => tileById.get(taskId)?.node.project ?? null,
    [tileById],
  );

  // §5: "the render-count is surfaced in dev builds". Culling exists to keep
  // the live DOM bounded, and the number that proves it is how many tiles are
  // actually mounted versus how many are in scope.
  const pills = useMemo(
    () => layout.elements.filter((e): e is PlacedReportPill => e.kind === 'pill'),
    [layout],
  );
  // Culled with the same rule as tiles: a pill whose anchor is off-screen has
  // nothing to sit beside.
  const visiblePills = useMemo(() => {
    const visibleIds = new Set(visibleTiles.map(tile => tile.id));
    return pills.filter(pill => visibleIds.has(pill.taskId));
  }, [pills, visibleTiles]);
  const asTask = (node: MapTaskNode) => node as unknown as Task;

  // ---- the aggregate altitudes (amendment §2/§5-A2) -----------------------
  /**
   * The continuous plane HAS no altitudes: clause 1 replaces them with one
   * world and a cross-fade. Every task-altitude surface below — the tiles,
   * the bands, the chips, the pills, the §4 edges — therefore renders at
   * every zoom, and what changes with the scale is only how much ink each
   * layer carries.
   */
  const isTaskAltitude = continuous || view.altitude === 'task';
  const bandById = useMemo(
    () => new Map(layout.elements
      .filter((e): e is PlacedBand => e.kind === 'band').map(band => [band.id, band])),
    [layout],
  );
  const placedAggregates = useMemo(
    () => layout.elements.filter((e): e is PlacedAggregate => e.kind === 'aggregate'),
    [layout],
  );
  const aggregateById = useMemo(
    () => new Map(placedAggregates.map(a => [a.id, a])),
    [placedAggregates],
  );
  const rollup = useMemo(
    () => (isTaskAltitude
      ? { edges: [] as AggregateEdge[], internal: new Map<string, InternalRollup>(), danglingCount: 0 }
      : rollUpEdges(graph, view.altitude)),
    [graph, view.altitude, isTaskAltitude],
  );

  /**
   * §4's density collapse, which until now only reached the task altitude.
   * A rolled-up graph is not automatically sparse: the seeded estate produces
   * 474 Phase-to-Phase edges, nearly eight times the threshold the design sets
   * ("tune in A7; start ~60 visible edges"), and drawing them all is both
   * unreadable and expensive.
   *
   * This is a RENDERING rule and not a roll-up rule: `rollup.edges` still
   * accounts for every relationship, so A2's no-silent-drop contract is
   * untouched. What collapses is what is PAINTED when nothing is selected,
   * exactly as it does one altitude down.
   */
  /**
   * §4's collapse needs a LANE to compare, and at the phase altitude that is
   * the Project: two Phases of one Project are same-lane and stay drawn, while
   * Project-to-Project edges collapse to hover/selection. At the project
   * altitude every node IS a lane, so every edge is cross-lane there.
   */
  /** §4's four chain-state classes, at the aggregate altitudes (round 6, B1). */
  const aggregateEdgeState = useCallback(
    (aggregateId: string) => {
      const node = aggregateById.get(aggregateId)?.node;
      return node ? aggregateChainState(node) : 'neutral';
    },
    [aggregateById],
  );

  const laneOfAggregate = useCallback(
    (id: string) => aggregateById.get(id)?.node.laneKey ?? null,
    [aggregateById],
  );
  /**
   * §4's chain selection at the aggregate altitudes. Round 7: selecting an
   * aggregate revealed only its IMMEDIATE edges, so a chain A→B→C disclosed
   * A→B and hid B→C - half a relationship, which is worse than none because it
   * reads as the whole one. The task altitude has always walked the transitive
   * set; this is the same walk over the rolled-up edges.
   *
   * SELECTION IS AUTHORITATIVE OVER HOVER. Round 9: this read
   * `hoveredId ?? selectedId`, so grazing any other aggregate REPLACED an
   * explicit selection's chain - the selected node itself dimmed and every one
   * of its relationships vanished, while §4 says the selected chain STAYS lit.
   * Hover discloses a chain only while nothing is selected, which is also how
   * the task altitude has always scoped its chain (it builds from selectedId
   * alone). Both consumers below must share this identity, or the lit classes
   * and the drawn edges disagree about whose chain is on screen.
   *
   * AND ONLY A SELECTION THAT IS STILL ON THE PLANE HAS THAT AUTHORITY.
   * Round 10: a raw `selectedId ?? hoveredId` kept preferring a selection an
   * ordinary filter refresh had removed from scope - buildChain rightly
   * returned no chain for the absent id, but the dead selection still
   * outranked the hover, so nothing could ever be disclosed again (§4/§6).
   * The identity is the selection only while the aggregate it names is still
   * rendered; otherwise the hover speaks.
   */
  const activeAggregateId = useMemo(
    () => (selectedId && aggregateById.has(selectedId) ? selectedId : hoveredId),
    [selectedId, hoveredId, aggregateById],
  );

  const aggregateChain = useMemo(
    () => (isTaskAltitude
      ? null
      : buildChain(activeAggregateId, rollup.edges, id => aggregateById.has(id))),
    [isTaskAltitude, activeAggregateId, rollup.edges, aggregateById],
  );

  const visibleAggregateEdges = useMemo(
    () => aggregateEdgesToDraw(
      rollup.edges, EDGE_DENSITY_THRESHOLD, activeAggregateId,
      edge => {
        const from = laneOfAggregate(edge.from);
        const to = laneOfAggregate(edge.to);
        return from === null || to === null || from !== to;
      },
      aggregateChain,
    ),
    [rollup.edges, activeAggregateId, laneOfAggregate, aggregateChain],
  );

  /**
   * Boxes an edge must curve around (card bd4decb4, absorbed here). At the
   * task altitude only the tiles actually on screen can be crossed, which also
   * keeps the routing cost proportional to what is drawn rather than to the
   * whole estate.
   */
  /**
   * Everything PAINTED on the plane is an obstacle. Round 6 found Report edges
   * routed against the aggregate nodes only, so they ran straight through
   * other Report nodes while reporting clean — the Report boxes are drawn, so
   * they block, and `routeEdge` filters the actual source and target by
   * identity anyway.
   */
  /**
   * §4 at the CONTAINER tiers of the continuous plane.
   *
   * A dependency between Tasks in different phases is a Phase-to-Phase
   * relationship when the phases are what carries the ink, and A2 forbids
   * dropping it silently. The roll-up runs over the same world the tiles
   * came from, and the edges are drawn between the CONTAINER boxes — which
   * are the same regions the tiles were just in, not a second picture.
   *
   * Computed only when a container tier actually shows: at reading zoom this
   * is a memo that returns nulls.
   */
  const planeGraph = useMemo(() => view.organization === 'organic' ? organicPlaneGraph(graph) : graph, [graph, view.organization]);
  const planeRollup = useMemo(() => {
    if (!fade) return null;
    const anyPhase = [...fade.phase.values()].some(alpha => alpha > FADE_EPSILON);
    const anyProject = [...fade.project.values()].some(alpha => alpha > FADE_EPSILON);
    if (!anyPhase && !anyProject) return null;
    return {
      phase: anyPhase ? rollUpEdges(planeGraph, 'phase') : null,
      project: anyProject ? rollUpEdges(planeGraph, 'project') : null,
    };
  }, [fade, planeGraph]);

  /**
   * Container boxes keyed by the AGGREGATE key the roll-up speaks — rebuilt
   * from each element's own identity rather than re-derived from the graph,
   * so the box an edge lands on is the box the reader is looking at.
   */
  const planeAggregateBox = useMemo(() => {
    const boxes = new Map<string, { x: number; y: number; w: number; h: number; alpha: number }>();
    if (!planeLayout || !fade) return boxes;
    for (const element of planeLayout.elements) {
      if (element.kind === 'band') {
        const bandKey = element.id.slice(`band:${element.laneId}:`.length);
        boxes.set(`phase:${element.laneId}\u0000${bandKey}`, {
          x: element.x, y: element.y, w: element.w, h: element.h,
          alpha: fade.phase.get(element.id) ?? 0,
        });
      } else if (element.kind === 'container') {
        boxes.set(`project:${element.laneId}`, {
          x: element.x, y: element.y, w: element.w, h: element.h,
          alpha: fade.project.get(element.id) ?? 0,
        });
      }
    }
    return boxes;
  }, [planeLayout, fade]);

  /**
   * The container nodes to paint, with the tier that owns each region. A
   * container is not a node on another plane: it IS the region, and clause 2
   * makes its size the honest picture of how much work is inside it.
   */
  interface PlaneContainerEntry {
    id: string;
    tier: 'phase' | 'project';
    core?: boolean;
    x: number; y: number; w: number; h: number;
    alpha: number;
    interactive: boolean;
    facts: MapAggregateCardFacts;
    internal: InternalRollup;
  }
  const planeContainers = useMemo((): PlaneContainerEntry[] => {
    if (!planeLayout || !fade) return [];
    const none: InternalRollup = { dependency: 0, knowledge: 0 };
    const entries: PlaneContainerEntry[] = [];
    for (const element of planeLayout.elements) {
      if (element.kind === 'band' && element.facts) {
        const alpha = fade.phase.get(element.id) ?? 0;
        if (alpha <= FADE_EPSILON) continue;
        const bandKey = element.id.slice(`band:${element.laneId}:`.length);
        entries.push({
          // Round-1 finding 2: the identity a container SELECTS by must be
          // the identity the rolled-up edges are keyed on, or selecting a
          // container can never restore the relationships §4's density rule
          // collapsed. It is the aggregate key, not a DOM-shaped one.
          id: `phase:${element.laneId}\u0000${bandKey}`,
          tier: 'phase',
          x: element.x, y: element.y, w: element.w, h: element.h,
          alpha,
          // Reachable only when it is BOTH the layer in charge and big
          // enough on screen to carry its card (see cardFits).
          interactive: tierOf(element.id, element.laneId) === 'phase'
            && element.w * view.scale >= 40 && element.h * view.scale >= 40,
          facts: {
            ...element.facts,
            kind: 'phase',
            label: element.label,
            laneLabel: element.laneLabel ?? element.laneId,
          },
          internal: planeRollup?.phase?.internal.get(
            `phase:${element.laneId}\u0000${bandKey}`) ?? none,
        });
      } else if (element.kind === 'container') {
        const alpha = fade.project.get(element.id) ?? 0;
        if (alpha <= FADE_EPSILON) continue;
        entries.push({
          id: `project:${element.laneId}`,
          tier: 'project',
          core: element.laneId === ORGANIC_CORE,
          x: element.x, y: element.y, w: element.w, h: element.h,
          alpha,
          interactive: (fade.projectRamp.get(element.laneId) ?? 0) >= 0.5
            && element.w * view.scale >= 40 && element.h * view.scale >= 40,
          facts: {
            ...element.facts,
            kind: 'project',
            label: element.label,
            laneLabel: element.laneLabel,
          },
          internal: planeRollup?.project?.internal.get(`project:${element.laneId}`) ?? none,
        });
      }
    }
    return entries;
  }, [planeLayout, fade, tierOf, planeRollup, view.scale, cardBox]);

  /**
   * §4's reveal at the container tiers (round-1 finding 2). Selection is
   * authoritative over hover while the selected container is still on the
   * plane — the same identity rule the aggregate altitudes carry, for the
   * same reason: a chain lit by a selection must not be replaced by every
   * container the cursor crosses on the way to it.
   */
  const activePlaneId = useMemo(
    () => (selectedId && planeAggregateBox.has(selectedId) ? selectedId : hoveredId),
    [selectedId, hoveredId, planeAggregateBox],
  );
  const selectedPlaneChain = useMemo(() => {
    if (!planeRollup) return null;
    const edges = [
      ...(planeRollup.phase?.edges ?? []),
      ...(planeRollup.project?.edges ?? []),
    ];
    return buildChain(activePlaneId, edges, id => planeAggregateBox.has(id));
  }, [planeRollup, activePlaneId, planeAggregateBox]);
  const planeAttention = useMemo(
    () => projectPlaneAttention(planeGraph, chain, selectedPlaneChain),
    [planeGraph, chain, selectedPlaneChain],
  );
  const paintedTaskChain = continuous ? planeAttention.tasks : chain;
  const planeChain = planeAttention.containers;
  // Close-zoom furniture and fading container overlays describe the same
  // regions. Their attention must use the same projected membership, while
  // each representation keeps its own fade and accessibility threshold.
  const furnitureChain = continuous ? planeChain : null;
  const furnitureScale = (key: string) => chainScale(
    furnitureChain, furnitureChain?.has(key) ?? false, CHAIN_DIM.node);
  const visibleEdges = useMemo(() => {
    if (drawableEdges.length <= EDGE_DENSITY_THRESHOLD) return drawableEdges;
    return drawableEdges.filter(edge => {
      const crossLane = laneOf(edge.from) !== laneOf(edge.to);
      if (!crossLane) return true;
      // Cross-lane and dense: only the chain the reader has asked about, or
      // the one they are pointing at, survives.
      const revealed = paintedTaskChain?.has(edge.from) && paintedTaskChain?.has(edge.to);
      const hovered = hoveredId === edge.from || hoveredId === edge.to;
      return Boolean(revealed || hovered);
    });
  }, [drawableEdges, laneOf, paintedTaskChain, hoveredId]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // eslint-disable-next-line no-console
    console.info(
      `[Map] rendering ${visibleTiles.length} of ${graph.nodes.length} tiles, `
      + `${visibleEdges.length} of ${drawableEdges.length} edges`,
    );
  }, [visibleTiles.length, graph.nodes.length, visibleEdges.length, drawableEdges.length]);




  /**
   * §4's density collapse at the container tiers, exactly as the aggregate
   * altitudes apply it: the roll-up still ACCOUNTS for every relationship —
   * nothing is dropped from it — and what collapses above the threshold is
   * what is PAINTED when the reader has asked about nothing.
   */
  const planeLaneOfAggregate = useCallback((id: string) => {
    if (id.startsWith('project:')) return null;   // every project edge is cross-lane
    const rest = id.slice('phase:'.length);
    const cut = rest.indexOf('\u0000');
    return cut >= 0 ? rest.slice(0, cut) : rest;
  }, []);
  const planeEdges = useMemo(() => {
    const drawn: Array<{ tier: 'phase' | 'project'; edge: AggregateEdge }> = [];
    if (!planeRollup) return drawn;
    for (const tier of ['phase', 'project'] as const) {
      const rolled = tier === 'phase' ? planeRollup.phase : planeRollup.project;
      if (!rolled) continue;
      const visible = aggregateEdgesToDraw(
        // The lit id and the chain are what bring a collapsed relationship
        // back — this passed a DOM id and no chain at all, so above the
        // density threshold nothing could be disclosed (round-1 finding 2).
        rolled.edges, EDGE_DENSITY_THRESHOLD, activePlaneId,
        edge => {
          const from = planeLaneOfAggregate(edge.from);
          const to = planeLaneOfAggregate(edge.to);
          return from === null || to === null || from !== to;
        },
        planeChain,
      );
      for (const edge of visible) drawn.push({ tier, edge });
    }
    return drawn;
  }, [planeRollup, activePlaneId, planeChain, planeLaneOfAggregate]);

  /** Reports drawn ONCE at an aggregate altitude (amendment §2/§5-A2.1). */
  const aggregateReports = useMemo(
    () => layout.elements.filter((e): e is PlacedAggregateReport => e.kind === 'aggregate-report'),
    [layout],
  );

  /**
   * Everything the task altitude PAINTS, culled to the viewport like the tiles
   * are. Round 7 found lane headers, band chips and Report pills missing from
   * the obstacle set - all of them drawn, all of them things a reader watches a
   * line vanish behind. Culling keeps the routing cost proportional to what is
   * on screen rather than to the estate.
   */
  const visibleFurniture = useMemo<Box[]>(() => {
    if (!isTaskAltitude) return [];
    const boxes: Box[] = [...visibleTiles, ...visiblePills];
    if (!viewport.width || !viewport.height) {
      return [...boxes, ...layout.elements.filter(
        e => e.kind === 'lane' || e.kind === 'chip')];
    }
    const left = (-view.offsetX - CULL_MARGIN) / view.scale;
    const top = (-view.offsetY - CULL_MARGIN) / view.scale;
    const right = (viewport.width - view.offsetX + CULL_MARGIN) / view.scale;
    const bottom = (viewport.height - view.offsetY + CULL_MARGIN) / view.scale;
    for (const element of layout.elements) {
      if (element.kind !== 'lane' && element.kind !== 'chip') continue;
      if (element.x + element.w >= left && element.x <= right
        && element.y + element.h >= top && element.y <= bottom) boxes.push(element);
    }
    return boxes;
  }, [isTaskAltitude, visibleTiles, visiblePills, layout, viewport, view.offsetX, view.offsetY, view.scale]);

  const edgeObstacles = useMemo(
    () => (planeLayout
      // Everything the PLANE paints: the task furniture that still carries
      // ink, and the containers that have taken over from it. A container
      // with no ink is not painted and so is not an obstacle — otherwise
      // every edge at reading zoom would be routing around a box covering
      // its own project.
      ? [
        ...visibleFurniture,
        ...planeContainers.map(entry => ({ x: entry.x, y: entry.y, w: entry.w, h: entry.h })),
      ]
      : paintedObstacles(view.altitude, visibleFurniture, placedAggregates, aggregateReports)),
    [planeLayout, planeContainers, view.altitude, visibleFurniture, placedAggregates,
      aggregateReports],
  );

  /**
   * A route must stay inside the plane the canvas declares. Both `.map-view`
   * and `.map-canvas` clip their overflow, so a route that leaves this box is
   * painted as two stubs reaching the boundary rather than as one connection
   * (round 3, B2) — obstacle-clear and still unfollowable.
   */
  const routeEnvelope = useMemo<Box>(
    () => ({ x: 0, y: 0, w: layout.width, h: layout.height }),
    [layout.width, layout.height],
  );

  /**
   * Routes are a property of the LAYOUT, not of the frame. Computing them
   * inline in the render meant every pan and every zoom re-ran the corridor
   * search for every visible edge - measured at 406ms for the phase altitude's
   * rolled-up set, which is a stutter on every gesture rather than a cost paid
   * once. They are memoised on the inputs that can actually change them.
   */
  // Selection and hover rebuild presentation entries without changing their
  // geometry. Keep routing inputs stable so those interactions reuse routes.
  const obstacleGeometry=JSON.stringify(edgeObstacles.map(({x,y,w,h})=>({x,y,w,h})));
  const stableObstacles=useMemo<Box[]>(()=>JSON.parse(obstacleGeometry),[obstacleGeometry]);
  const routeCache=useMemo(()=>new Map<string,EdgeRoute>(),
    [continuous,stableObstacles,routeEnvelope,view.organization]);
  const routeOnPlane = useCallback((source: Box, target: Box, report = false) => {
    const key=[source.x,source.y,source.w,source.h,target.x,target.y,target.w,target.h,report].join(':');
    const cached=routeCache.get(key);
    if(cached)return cached;
    // Containers are geography. The ground containing an endpoint must not
    // block that endpoint's exit, and copied endpoint boxes are the endpoint,
    // not a second obstacle. routeEdge still checks its shrunk endpoints.
    const contains = (outer: Box, inner: Box) => outer.x <= inner.x && outer.y <= inner.y
      && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;
    const obstacles = continuous ? stableObstacles.filter(box =>
      !contains(box, source) && !contains(box, target)
      && !contains(source, box) && !contains(target, box)) : stableObstacles;
    const route=continuous
      ? routeFlowEdge(source, target, obstacles, routeEnvelope, view.organization, report)
      : routeEdge(source, target, obstacles, routeEnvelope);
    routeCache.set(key,route);
    return route;
  }, [continuous, stableObstacles, routeEnvelope, view.organization, routeCache]);

  const taskRoutes = useMemo(() => {
    const routes = new Map<string, EdgeRoute>();
    if (!isTaskAltitude) return routes;
    for (const edge of visibleEdges) {
      const from = tileById.get(edge.from);
      const to = tileById.get(edge.to);
      if (!from || !to) continue;
      routes.set(`${edge.kind}-${edge.from}-${edge.to}`,
        routeOnPlane(to, from));
    }
    return routes;
  }, [isTaskAltitude, visibleEdges, tileById, routeOnPlane]);

  const aggregateRoutes = useMemo(() => {
    const routes = new Map<string, EdgeRoute>();
    if (isTaskAltitude) return routes;
    for (const edge of visibleAggregateEdges) {
      const source = aggregateById.get(edge.to);
      const target = aggregateById.get(edge.from);
      if (!source || !target) continue;
      routes.set(`${edge.kind}-${edge.from}-${edge.to}`,
        routeEdge(source, target, edgeObstacles, routeEnvelope));
    }
    return routes;
  }, [isTaskAltitude, visibleAggregateEdges, aggregateById, edgeObstacles, routeEnvelope]);


  // ---- the one-shot fit, consumed ONLY once measurement has CONVERGED ----
  // 232dc7b3 F2, carried verbatim into this card's brief: the fit was spent in
  // the first commit where nodes existed, while most tiles still carried the
  // FALLBACK size — up to 1,152px of measured offset on a 1,200-task estate.
  // The rh-map-lod blank canvas is HYPOTHESIZED to be the same fault one
  // altitude up: a frozen summary starts on a fallback box, re-measures, and
  // moves the whole layout under a fit that was already spent.
  //
  // So the criterion is that the layout has STOPPED MOVING. It is deliberately
  // NOT "every element measured": viewport culling means an off-screen tile
  // never reports at all (that is F3, still deferred on 232dc7b3), so a
  // completeness test could never pass at the task altitude and the Map would
  // never fit at all. The signature below folds in the measurement COUNT, so a
  // pass that is still collecting boxes is not mistaken for a settled one.
  //
  // Residual, recorded rather than hidden: an element that mounts but never
  // reports a usable box (a 0x0 measurement is ignored by `measure`) keeps the
  // mounted set incomplete, and the fit is then never spent. The Map still
  // renders — unfitted, at the restored or default zoom — and the toolbar Fit
  // control still works, so the failure is visible and recoverable rather than
  // a blank canvas.
  // Convergence is "every element this altitude actually MOUNTS has reported a
  // box", which is decidable in ONE render.
  //
  // The previous criterion compared the layout signature against the previous
  // render's, and needed a spare render in which nothing changed. At the task
  // altitude tiles mount in dribs as culling admits them, so that spare render
  // always happened by accident. At an aggregate altitude every node mounts in
  // ONE batch and then nothing changes again — no spare render, no
  // convergence, and the arrival fit never landed at all. Live QA caught it as
  // an estate sitting at the task altitude at scale 1.
  const mountedIds = useMemo(
    () => (isTaskAltitude
      ? visibleTiles.map(tile => tile.id)
      : [...placedAggregates.map(a => a.id), ...aggregateReports.map(r => r.id)]),
    [isTaskAltitude, visibleTiles, placedAggregates, aggregateReports],
  );
  const measurementSettled = continuous
    // On the continuous plane a fully zoomed-out view mounts no tiles at
    // all: the containers carry the picture, and a container's box is
    // DERIVED from the layout rather than measured. Waiting for a
    // measurement that will never arrive would leave the fit unspent and
    // the reader on an unfitted plane.
    ? mountedIds.every(id => Object.prototype.hasOwnProperty.call(sizes, id))
    : mountedIds.length > 0
      && mountedIds.every(id => Object.prototype.hasOwnProperty.call(sizes, id));

  // Altitudes already visited while trying to land the arrival fit. Moving to
  // an altitude to let it measure must terminate, and this bounds it to one
  // visit each rather than trusting the selection to converge.
  const fitVisitedRef = useRef<Set<MapAltitude>>(new Set());
  /** The corrective-fit budget, as the explicit machine in the model. */
  const correctiveFitRef = useRef<CorrectiveFitState>(INITIAL_CORRECTIVE_FIT);

  useEffect(() => {
    if (!needsFit()) return;
    if (isLoading || graph.nodes.length === 0) return;
    if (!viewport.width || !viewport.height) return;
    if (!measurementSettled) return;

    // The continuous plane has one plane and one fit. There is no altitude
    // to arrive at, so there is no placeholder-geometry hazard to walk
    // around either: the plane on screen IS the plane being fitted.
    if (continuous) {
      const planeScale = planeFitScale(layout, viewport);
      correctiveFitRef.current = onFitSpent(
        correctiveFitRef.current, { width: layout.width, height: layout.height });
      applyFit({
        organization: view.organization,
        altitude: 'task',
        scale: planeScale,
        offsetX: (viewport.width - layout.width * planeScale) / 2,
        offsetY: (viewport.height - layout.height * planeScale) / 2,
      });
      return;
    }

    // Arrival picks the altitude too: A2's "as much detail as the space
    // allows" is a property of the fitted view.
    const arrival = initialAltitude(graph, sizes, altitudeOptions);

    // THE ALTITUDE THAT WILL BE FITTED MUST HAVE MEASURED ITSELF FIRST.
    // The adversarial pre-review reproduced the hole: `measurementSettled`
    // only signatures the layout CURRENTLY rendered, so on a fresh arrival it
    // converges on the task altitude, and `initialAltitude` can then select an
    // aggregate altitude whose nodes have never mounted. Fitting there spends
    // the one-shot debt against FALLBACK_AGGREGATE boxes — measured 3308x2280
    // predicted against 4568x3000 actual — which is precisely the F2
    // placeholder-pass class this card exists to prevent.
    //
    // So a differing arrival altitude is a MOVE, not a fit: switch to it,
    // return with the debt UNSPENT, and let it mount and measure. The next
    // pass runs with that altitude's real boxes.
    const step = arrivalFitStep(view.altitude, arrival.altitude, fitVisitedRef.current);
    if (step.action === 'move') {
      fitVisitedRef.current.add(view.altitude);
      applyView(previous => ({ ...previous, altitude: step.to }));
      return;
    }

    // Fit the altitude ACTUALLY ON SCREEN, from `layout` — the one whose
    // signature `measurementSettled` just certified. Recomputing a layout for
    // some other altitude here would reintroduce the same fallback geometry by
    // the back door.
    const scale = fitScaleFor(layout, altitudeOptions);
    // Remember the extent this fit was computed against. Fitting CHANGES the
    // viewport, which can admit tiles culling had withheld; those measure
    // afterwards and move the extent, but the one-shot debt is already spent
    // (round 6, B3 - the same 232dc7b3 F2 class one step further along).
    correctiveFitRef.current = onFitSpent(
      correctiveFitRef.current, { width: layout.width, height: layout.height });
    applyFit({
      organization: view.organization,
      altitude: view.altitude,
      scale,
      offsetX: (viewport.width - layout.width * scale) / 2,
      offsetY: (viewport.height - layout.height * scale) / 2,
    });
  }, [
    continuous,
    needsFit, isLoading, graph, sizes, viewport, applyFit, applyView,
    view.organization, view.altitude, layout, measurementSettled, altitudeOptions,
    // Re-arming a fit must WAKE this effect; `needsFit` is a ref read and
    // changes nothing React can see (round 1, B3).
    refitNonce,
  ]);

  /**
   * ONE corrective refit, after the extent settles.
   *
   * Bounded deliberately: a corrective fit can itself admit another tile, and
   * an unbounded loop of fits is worse than a slightly-off fit. One pass
   * absorbs the culling expansion the first fit caused; anything beyond that is
   * the reader's own zoom to make, and the Fit control is always there.
   */
  useEffect(() => {
    if (needsFit()) return;
    const next = onExtentChanged(
      correctiveFitRef.current, { width: layout.width, height: layout.height });
    correctiveFitRef.current = next.state;
    if (next.refit) requestRefit();
  }, [layout.width, layout.height, needsFit, requestRefit]);

  const fitNow = useCallback(() => {
    requestRefit();
    if (!viewport.width || !layout.width) return;
    // The explicit control re-picks the altitude as well, so "Fit" from a
    // zoomed-in task view returns the whole estate rather than fitting the
    // task plane at a scale nobody can read. It goes through the SAME
    // pending-fit path rather than fitting here: requestRefit() re-arms the
    // debt AND bumps refitNonce, which is what actually wakes the effect
    // above; the effect then refuses to spend the debt until the chosen
    // altitude has measured itself.
    fitVisitedRef.current = new Set();
    correctiveFitRef.current = onExplicitFit();
  }, [
    requestRefit, viewport, layout.width, applyFit, view.organization,
    graph, sizes, altitudeOptions, aspect,
  ]);

  /**
   * §2: switching organizations recomputes targets and the elements TWEEN to
   * them (0.5s, cubic-bezier(.4,0,.2,1)) under the morph class; reduced
   * motion swaps instantly because the morph transitions stand down under
   * the media query, not because a JS branch guesses. The commit is ONE view
   * change: same altitude, same scale, viewport re-centred on the SAME TASKS
   * in the new arrangement (membership via focusBoxAcross). The plane
   * transform rides the same curve, so the frame and the travelling tiles
   * arrive together.
   */
  const [morphing, setMorphing] = useState(false);
  const morphTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (morphTimer.current !== null) window.clearTimeout(morphTimer.current);
  }, []);

  /**
   * Container morph (review a649f5f7 B2): a hull is an SVG path, and CSS
   * cannot tween path geometry, so band containers FOLLOW the morph as an
   * interpolated-outline overlay — resampled, cyclically aligned pairs from
   * the pure engine, driven through the same 0.5s bezier by rAF writing `d`
   * imperatively (a per-frame setState would re-render the whole plane).
   * Static containers stand aside under .map-plane--container-morph while
   * the overlay travels; at t=1 the overlay unmounts having ARRIVED at the
   * exact target geometry, so nothing pops. Reduced motion skips the
   * overlay entirely — the swap is the committed re-render.
   */
  const [containerMorph, setContainerMorph] = useState<ContainerMorph[] | null>(null);
  const morphPathRefs = useRef(new Map<string, SVGPathElement>());
  useEffect(() => {
    if (!containerMorph) return undefined;
    const startedAt = performance.now();
    let frame = 0;
    // The clock is performance.now() on BOTH ends: the rAF callback timestamp
    // has no guaranteed origin in every runtime (jsdom passes one that need
    // not match, and CI caught the overlay frozen at t<=0 because of it).
    const step = () => {
      const t = Math.min(1, Math.max(0, (performance.now() - startedAt) / 500));
      const eased = morphEase(t);
      for (const morph of containerMorph) {
        const element = morphPathRefs.current.get(morph.id);
        if (element) {
          element.setAttribute(
            'd', outlineToPath(interpolateOutline(morph.from, morph.to, eased)));
        }
      }
      if (t < 1) frame = requestAnimationFrame(step);
      else setContainerMorph(null);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [containerMorph]);
  const switchOrganization = useCallback((next: MapOrganization) => {
    if (next === view.organization) return;
    if (isLoading) {
      applyView(current => ({ ...current, organization: next, altitude: 'task' }));
      requestRefit();
      return;
    }
    // Arriving ON the continuous plane means arriving at ONE world: there is
    // no altitude to carry across, so the target is the plane itself.
    const nextContinuous = CONTINUOUS_PLANE_ORGANIZATIONS.includes(next);
    const nextAltitude: MapAltitude = nextContinuous ? 'task' : view.altitude;
    const nextLayout = nextContinuous
      ? layoutContinuousPlane(graph, sizes, next, anchorsRef.current[next] ?? readPlaneAnchors(next))
      : layoutAtAltitude(graph, sizes, nextAltitude, aspect, next);
    // Commit the target organization and its fitted camera together.
    const planeCentre = {
      x: (viewport.width / 2 - view.offsetX) / view.scale,
      y: (viewport.height / 2 - view.offsetY) / view.scale,
    };
    const focus = focusBoxAcross(layout, view.altitude, nextLayout, nextAltitude, planeCentre);
    const targetX = focus ? focus.x + focus.w / 2 : nextLayout.width / 2;
    const targetY = focus ? focus.y + focus.h / 2 : nextLayout.height / 2;
    // A scale means something different on a grid of summary boxes and on
    // the world those boxes stand for, so a reader leaving an aggregate
    // altitude for the plane keeps their APPARENT SIZE rather than their
    // number: whatever they were looking at stays the size it was.
    const from = focusedElement(layout, view.altitude, planeCentre);
    const scale = nextContinuous && viewport.width > 0 && viewport.height > 0 ? planeFitScale(nextLayout, viewport)
      : (nextAltitude !== view.altitude && focus && from && focus.w > 0)
      ? clampScale(view.scale * (from.w / focus.w))
      : view.scale;
    applyView(() => ({
      organization: next,
      altitude: nextAltitude,
      scale,
      offsetX: nextContinuous ? (viewport.width - nextLayout.width * scale) / 2 : viewport.width / 2 - targetX * scale,
      offsetY: nextContinuous ? (viewport.height - nextLayout.height * scale) / 2 : viewport.height / 2 - targetY * scale,
    }));
    setMorphing(true);
    if (morphTimer.current !== null) window.clearTimeout(morphTimer.current);
    morphTimer.current = window.setTimeout(() => setMorphing(false), 500);
    // Containers follow (B2): only transitions that involve a hull-bearing
    // form need the overlay — pipeline rectangles tween natively as divs.
    const hullBearing = (organization: MapOrganization) =>
      organization === 'radial' || organization === 'organic';
    const involvesHull = hullBearing(view.organization) || hullBearing(next);
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (involvesHull && !reduced && view.altitude === 'task') {
      morphPathRefs.current.clear();
      setContainerMorph(containerMorphsFor(layout, nextLayout));
    }
  }, [view.organization, view.altitude, view.scale, view.offsetX, view.offsetY,
    layout, graph, sizes, aspect, viewport, applyView, isLoading, requestRefit]);


  return (
    <section
      className={`map-view${treeMode ? ' map-view--list' : ''}`}
      aria-label="Task map"
    >
      <div className="map-toolbar">
        <div className="map-toolbar-group">
          <IconButton icon={<Minus size={16} />} ariaLabel="Zoom out"
            onClick={() => zoomBy(0.8)} />
          <IconButton icon={<Plus size={16} />} ariaLabel="Zoom in"
            onClick={() => zoomBy(1.25)} />
          <IconButton icon={<Maximize2 size={16} />} ariaLabel="Fit view" onClick={fitNow} />
        </div>
        <SegmentedControl
          ariaLabel="Map organization"
          options={ORGANIZATION_OPTIONS}
          value={view.organization}
          onChange={switchOrganization}
        />
        <Button variant="secondary" size="compact"
          icon={<List size={16} />}
          ariaPressed={treeMode}
          onClick={() => setTreeMode(value => !value)}>
          {treeMode ? 'Show as map' : 'Show as list'}
        </Button>
        <span className="map-scope-count">
          {graph.nodes.length} task{graph.nodes.length === 1 ? '' : 's'} in view
        </span>
      </div>

      {/* The canvas is mounted unconditionally; status is an overlay. */}
      {/* The canvas is a focusable region: without a tab stop the whole
          surface is unreachable by keyboard (§6, review B3). */}
      {/* §6's alternative REPLACES the canvas; it does not sit beside it.
          Round 2 found "Show as list" leaving the application canvas and all
          of its Task openers active while adding a second complete set, so a
          keyboard or screen-reader reader met every Task twice and had to
          traverse an interactive canvas to reach the alternative meant to
          spare them it.

          The element stays MOUNTED, which is what §8 requires — losing it is
          how the abandoned attempt lost its listeners. It is the a11y tree and
          the tab order it leaves, via aria-hidden, a removed tab stop, and a
          stylesheet rule that takes it out of the visual flow. */}
      <div
        className="map-canvas"
        ref={canvasRef}
        role="application"
        aria-label="Task map canvas"
        aria-hidden={treeMode || undefined}
        tabIndex={treeMode ? -1 : 0}
        onClick={event => {
          // §4: "Click empty canvas clears." The canvas is NOT the element an
          // empty click lands on — the transformed `.map-plane` covers the
          // content extent, and bands are pointer-transparent, so their empty
          // area lands on the plane too. Requiring target === currentTarget
          // therefore ignored every empty click (review 568f3364 B2).
          //
          // Anything that is not a tile, an opener or a pill is background.
          const target = event.target as HTMLElement | null;
          // The aggregate altitudes' nodes are content too. Leaving them out
          // meant clicking a Phase or Project node counted as an EMPTY-canvas
          // click and cleared the very selection the click had just made, so
          // the §4 reveal could never latch (found by the round-5 regression).
          if (!target?.closest(
            // A container is content too: clicking one must not count as an
            // empty-canvas click and clear the selection the click just made
            // (the round-5 regression, one tier up).
            '.map-tile, .map-report-pill, .map-aggregate, .map-aggregate-report,'
            + ' .map-container',
          )) setSelectedId(null);
        }}
      >
        <div
          data-plane-lod={continuous ? planeBand : undefined}
          className={`map-plane${(view.organization === 'organic' || view.organization === 'radial') ? ' map-plane--branched' : ''}${morphing ? ' map-plane--morphing' : ''}${containerMorph ? ' map-plane--container-morph' : ''}`}
          style={{
            transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`,
            width: layout.width,
            height: layout.height,
            // The container cards ride this back out again, so a label keeps
            // its CSS size while the world it labels shrinks — the one thing
            // a map never scales.
            ['--map-plane-inverse-scale' as string]: 1 / view.scale,
          }}
        >
          <svg className="map-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {/* Geography survives every caption/LOD fade and is always below
                connections and task ink. Projects own phases; phases own tasks. */}
            {continuous && view.organization !== 'organic' && planeLayout?.elements
              .filter((e): e is PlacedContainer => e.kind === 'container')
              .map(project => <rect key={'ground:'+project.id}
                data-project-ground={project.laneId}
                className={`map-project-ground${planeStateClass(project.facts)}`}
                style={{opacity:furnitureScale(`project:${project.laneId}`)}}
                x={project.x} y={project.y} width={project.w} height={project.h}
                rx={16} vectorEffect="non-scaling-stroke" />)}
            {continuous && view.organization !== 'organic' && planeLayout?.elements
              .filter((e): e is PlacedBand => e.kind === 'band')
              .map(phase => <rect key={'ground:'+phase.id} data-phase-ground={phase.id}
                className={`map-phase-ground${phase.facts ? planeStateClass(phase.facts) : ''}`}
                style={{opacity:furnitureScale(phaseKeyOfBand(phase))}}
                x={phase.x} y={phase.y} width={phase.w} height={phase.h}
                rx={12} vectorEffect="non-scaling-stroke" />)}

            {/* §3: in the radial organization a phase's spatial container is a
                bounds HULL — an annular sector drawn in the underlay, not a
                rect. It is background furniture: aria-hidden with the svg,
                pointer-transparent with it, exempt from the box invariant
                (mapGraphModel documents why), and painted before the edges so
                nothing hides behind it. */}
            {isTaskAltitude && layout.elements
              .filter((e): e is PlacedHull => e.kind === 'hull')
              .map(hull => (
                <path
                  key={hull.id}
                  className="map-hull"
                  d={`M ${hull.points.map(point => `${point[0]} ${point[1]}`).join(' L ')} Z`}
                />
              ))}
            {planeLayout?.organicRegions?.map(region => (
              <g key={`organic:${region.laneId}`} className={`map-organic-region${region.core ? ' map-organic-region--core' : ''}${planeStateClass(
                  (planeLayout.elements.find(e => e.kind === 'container' && e.laneId === region.laneId) as PlacedContainer | undefined)?.facts
                    ?? { taskCount:0, completed:0, archived:0, agentsLive:0, stuck:0, upNext:0, inFlight:0, progress:0 })}`}>
                {region.core ? <ellipse data-testid="map-archive-core"
                  cx={region.box.x + region.box.w / 2} cy={region.box.y + region.box.h / 2}
                  rx={region.box.w / 2} ry={region.box.h / 2} /> : <>
                  <path data-project-ground={region.laneId} className="map-project-territory" d={region.outline} vectorEffect="non-scaling-stroke" />
                  {region.clusters.filter(box=>box.phaseId).map((box,i) => <path
                    data-phase-ground={box.phaseId}
                    className={`map-hull${box.facts ? planeStateClass(box.facts) : ''}`}
                    vectorEffect="non-scaling-stroke" key={i} d={box.outline ?? organicPhasePath(box)} />)}
                </>}
              </g>
            ))}
            {/* The travelling containers (B2): interpolated outlines that
                arrive at the exact target geometry before unmounting. */}
            {containerMorph?.map(morph => (
              <path
                key={`morph:${morph.id}`}
                className="map-hull map-hull--morph"
                d={outlineToPath(morph.from)}
                ref={element => {
                  if (element) morphPathRefs.current.set(morph.id, element);
                  else morphPathRefs.current.delete(morph.id);
                }}
              />
            ))}
            {/* §4 dependency edges, now CURVED and routed around the nodes
                between them (bd4decb4, absorbed by amendment §2/§5-A2): a
                connection drawn under a tile is not one a reader can follow.
                The upstream end is `to` — the graph read emits
                task_id → depends_on — so the curve runs upstream → downstream
                and the arrow of the flow is preserved. */}
            {isTaskAltitude && visibleEdges.map(edge => {
              const from = tileById.get(edge.from);
              const to = tileById.get(edge.to);
              if (!from || !to) return null;
              const route = taskRoutes.get(`${edge.kind}-${edge.from}-${edge.to}`);
              if (!route) return null;
              // §4 holds at EVERY zoom, and on the plane an edge belongs to
              // the layer its endpoints are on: it recedes with them and the
              // rolled-up edge between their containers takes over.
              const edgeAlpha = Math.min(taskAlpha(edge.from), taskAlpha(edge.to));
              if (edgeAlpha <= FADE_EPSILON) return null;
              return (
                <path
                  key={`${edge.kind}-${edge.from}-${edge.to}`}
                  className={`map-edge map-edge--${edge.kind} map-edge--${edgeState(edge.to)}${route.clipped ? ' map-edge--unrouted' : ''} ${paintedTaskChain ? (paintedTaskChain.has(edge.from) && paintedTaskChain.has(edge.to) ? 'map-edge--lit' : 'map-edge--dimmed') : ''}`}
                  d={route.d}
                  fill="none"
                  style={{
                    opacity: edgeAlpha * chainScale(
                      paintedTaskChain, Boolean(paintedTaskChain?.has(edge.from) && paintedTaskChain?.has(edge.to)),
                      CHAIN_DIM.edge),
                  }}
                >
                  {/* A2 forbids silently dropping a relationship, so an
                      unrouted one is still drawn - but MARKED, never passed off
                      as a clean connection (round 2 B1, round 3 B1). */}
                  {route.clipped ? <title>Could not be routed clear of other nodes</title> : null}
                </path>
              );
            })}

            {/* The same relationships, one and two tiers up, on the SAME
                plane (A3 clause 1 + §4). Multiplicity rides the stroke
                width; nothing is dropped, and what the density rule
                collapses is what is PAINTED, never what is accounted. */}
            {planeEdges.map(({ tier, edge }) => {
              const source = planeAggregateBox.get(edge.to);
              const target = planeAggregateBox.get(edge.from);
              if (!source || !target) return null;
              const opacity = Math.min(source.alpha, target.alpha);
              if (opacity <= FADE_EPSILON) return null;
              const route = routeOnPlane(source, target);
              return (
                <path
                  key={`plane-${tier}-${edge.kind}-${edge.from}-${edge.to}`}
                  className={`map-edge map-edge--${edge.kind} map-edge--aggregate${route.clipped ? ' map-edge--unrouted' : ''}${planeChain ? (planeChain.has(edge.from) && planeChain.has(edge.to) ? ' map-edge--lit' : ' map-edge--dimmed') : ''}`}
                  d={route.d}
                  fill="none"
                  style={{
                    opacity: opacity * chainScale(
                      planeChain,
                      Boolean(planeChain?.has(edge.from) && planeChain?.has(edge.to)),
                      CHAIN_DIM.edge),
                  }}
                  strokeWidth={Math.min(4, 1 + Math.log2(edge.multiplicity))}
                >
                  <title>
                    {(edge.multiplicity === 1
                      ? `1 ${edge.kind} link`
                      : `${edge.multiplicity} ${edge.kind} links`)
                      + (route.clipped ? ', could not be routed clear of other nodes' : '')}
                  </title>
                </path>
              );
            })}

            {/* Rolled-up edges (§2/§5-A2). A dependency between Tasks in
                different Phases draws as a Phase→Phase edge, and the same for
                Projects; knowledge edges roll up identically. Multiplicity is
                carried in the stroke width rather than dropped — the amendment
                allows an aggregated edge to INDICATE multiplicity and forbids
                it silently losing a relationship underneath. */}
            {!isTaskAltitude && visibleAggregateEdges.map(edge => {
              const source = aggregateById.get(edge.to);
              const target = aggregateById.get(edge.from);
              if (!source || !target) return null;
              const route = aggregateRoutes.get(`${edge.kind}-${edge.from}-${edge.to}`);
              if (!route) return null;
              return (
                <path
                  key={`${edge.kind}-${edge.from}-${edge.to}`}
                  className={`map-edge map-edge--${edge.kind} map-edge--aggregate map-edge--${aggregateEdgeState(edge.to)}${route.clipped ? ' map-edge--unrouted' : ''} ${aggregateChain ? (aggregateChain.has(edge.from) && aggregateChain.has(edge.to) ? 'map-edge--lit' : 'map-edge--dimmed') : ''}`}
                  d={route.d}
                  fill="none"
                  strokeWidth={Math.min(4, 1 + Math.log2(edge.multiplicity))}
                >
                  <title>
                    {(edge.multiplicity === 1
                      ? `1 ${edge.kind} link`
                      : `${edge.multiplicity} ${edge.kind} links`)
                      + (route.clipped ? ', could not be routed clear of other nodes' : '')}
                  </title>
                </path>
              );
            })}
            {/* A2: "A Report cited by several in-scope Tasks draws once, with
                a dashed edge to each Task that cites it. Converging lines are
                the point." At an aggregate altitude the convergence is onto
                the PHASE or PROJECT nodes whose work cites it — per amendment
                §2/§5-A2.1, which keeps the per-pair form below for the task
                altitude. */}
            {!isTaskAltitude && aggregateReports.flatMap(report =>
              report.aggregateIds.map(aggregateId => {
                const target = aggregateById.get(aggregateId);
                if (!target) return null;
                // B3 from round 4: this caller alone still threw away
                // `clipped`, so an unresolved Report route was drawn as an
                // ordinary connection while every other surface marked it.
                const route = routeOnPlane(report, target, true);
                return (
                  <path
                    key={`agg-report-${report.reportId}-${aggregateId}`}
                    // Round 10 B2: §4's "everything else dims" includes this
                    // surface. Each converging line answers for the aggregate
                    // it cites, exactly like a dependency edge answers for its
                    // endpoints.
                    className={`map-edge map-edge--knowledge map-edge--report${route.clipped ? ' map-edge--unrouted' : ''}${aggregateChain ? (aggregateChain.has(aggregateId) ? ' map-edge--lit' : ' map-edge--dimmed') : ''}`}
                    d={route.d}
                    fill="none"
                  >
                    {route.clipped
                      ? <title>Could not be routed clear of other nodes</title>
                      : null}
                  </path>
                );
              }))}

            {/* §3: a dashed edge from each Report to EVERY Task it cites —
                including tasks it cites beyond the one it is anchored
                beside. Drawn under the same detail gate as the pills. */}
            {isTaskAltitude && detail.reports && visiblePills.map(pill => {
              const tile = tileById.get(pill.taskId);
              if (!tile) return null;
              // Round 7: this was a raw straight line that never went near the
              // router, so §3's short local Report link was the one edge on the
              // surface that could still be drawn through a node.
              const route = routeOnPlane(pill, tile, true);
              return (
                <path
                  key={`report-${pill.id}`}
                  // Round 11 B2: round 10 brought the AGGREGATE Report surface
                  // into §4 and left this one out — the two altitudes then
                  // disagreed under the same binding rule. A per-(Report,Task)
                  // edge answers for the one Task it cites.
                  className={`map-edge map-edge--knowledge map-edge--report${route.clipped ? ' map-edge--unrouted' : ''}${paintedTaskChain ? (paintedTaskChain.has(pill.taskId) ? ' map-edge--lit' : ' map-edge--dimmed') : ''}`}
                  d={route.d}
                  fill="none"
                />
              );
            })}
          </svg>

          {/* Report pills (§3). PLACED elements, not decorations hung off a
              tile: the layout reserved their strip, they are measured like
              every other element, and findOverlaps compares them. */}
          {/* Amendment §2/§5-A2.1 (owner ruling 2026-08-19): per-(report,
              task) pills and short local edges are the TASK altitude's
              behaviour, unchanged from the 1e0653e7 walkthrough. The
              draw-once converging form governs the aggregate altitudes. */}
          {isTaskAltitude && detail.reports && visiblePills.map(pill => (
            <span
              key={pill.id}
              // Round 11 B2: the pill recedes with the Task it cites (§4) —
              // per-citation, because A2.1 makes the task altitude's Report
              // form per-(Report,Task), unlike the draw-once aggregate node.
              className={`map-report-pill${paintedTaskChain && !paintedTaskChain.has(pill.taskId) ? ' map-report-pill--dimmed' : ''}`}
              // A pill recedes with the Task it cites — it is that Task's
              // close-zoom ink, and §4 keeps the two together.
              style={{
                left: pill.x, top: pill.y,
                opacity: taskAlpha(pill.taskId)
                  * chainScale(paintedTaskChain, paintedTaskChain?.has(pill.taskId) ?? false, CHAIN_DIM.node),
              }}
              ref={element => measure(pill.id, element)}
            >
              {/* A2 requires the Report to be OPENABLE from the Map, and the
                  altitude split in A2.1 changes only WHERE it is drawn, never
                  whether it can be reached. This was a span with a title
                  attribute: unreachable by keyboard and inert to a click.
                  It is a kit control now, like its aggregate counterpart. */}
              <IconButton
                icon={<FileText size={16} aria-hidden="true" />}
                ariaLabel={`Open linked Report: ${pill.title}`}
                title={pill.title}
                variant="ghost"
                size="compact"
                onClick={() => onOpenReport?.(pill.reportId)}
                disabled={!onOpenReport}
              />
            </span>
          ))}

          {!continuous && isTaskAltitude && layout.elements
            .filter((e): e is PlacedBand => e.kind === 'band'
              && view.organization !== 'radial' && view.organization !== 'organic').map(bandEl => (
              <div key={bandEl.id} className="map-band"
                style={{
                  left: bandEl.x, top: bandEl.y, width: bandEl.w, height: bandEl.h,
                  // The phase's frame recedes as its PROJECT takes the ground
                  // over; the phase's own ink is the container node below.
                  opacity: (1 - projectAlpha(bandEl.laneId))
                    * furnitureScale(phaseKeyOfBand(bandEl)),
                }} />
            ))}

          {/* The chip is PLACED, not merely styled inside the band: it is
              named in the §2 overlap invariant, so it carries a real box the
              layout reserves space for and the checker can see. */}
          {isTaskAltitude && layout.elements.filter(e => e.kind === 'chip').map(chip => {
            // The chip is the phase's CLOSE-ZOOM ink (§5, extended to
            // containers by clause 2): it recedes exactly as the tiles it
            // labels do. Caption ownership follows the dominant tier so the
            // close copy cannot remain painted over the aggregate copy.
            const own = bandById.get((chip as any).bandId);
            const chipAlpha = own
              ? (tierOf(own.id, own.laneId) === 'task' ? 1 : 0)
              : 1;
            return (
            <span key={chip.id} className="map-band-chip"
              // The chip is held inside the band it labels: its cell comes
              // from the layout, which took it from the band's own width.
              // Left free, the chip's MEASURED width set the band's — and a
              // §5 detail band crossing then moved every segment to its
              // right (round 2, measured live at +95px).
              style={{
                left: continuous && own ? own.x : chip.x, top: chip.y,
                maxInlineSize: continuous && own ? Math.min(220, own.w * view.scale) : (chip as any).w,
                opacity: chipAlpha * furnitureScale(own ? phaseKeyOfBand(own) : ''),
              }}
              aria-hidden={chipAlpha < 0.5 || undefined}
              ref={element => measure(chip.id, element)}>
              {continuous && own?.facts ? (
                <MapAggregateCard facts={{ ...own.facts, kind: 'phase', label: own.label,
                  laneLabel: own.laneLabel ?? own.laneId }}
                  internal={{ dependency: 0, knowledge: 0 }} selected={false}
                  onSelect={() => {}} passive nameClass="map-band-name" goal={own.goal} showGoal={detail.goalLine} />
              ) : <><span className="map-band-name">{(chip as any).label}</span>
                {(chip as any).goal ? <span className={`map-band-goal${detail.goalLine ? '' : ' map-contracted'}`}>{(chip as any).goal}</span> : null}</>}
            </span>
            );
          })}

          {/* Lane headers are MEASURED like tiles and chips: §2 names all
              three, and leaving this one on a constant meant the model's
              own sizes['lane:…'] lookup was a dead path (review B5). Width
              and height come from the layout, which derives them from this
              measurement — so the box is reported, not dictated. */}
          {isTaskAltitude && layout.elements.filter(e => e.kind === 'lane').map(lane => {
            // The lane header is the PROJECT's close-zoom ink; the project
            // container card is the same four §1 answers, one tier up.
            const laneKey = lane.id.slice('lane:'.length);
            const headerAlpha = projectAlpha(laneKey) < 0.5 ? 1 : 0;
            const territory = planeLayout?.elements.find(element => element.kind === 'container' && element.laneId === laneKey);
            return (
            <div key={lane.id} className="map-lane-header"
              style={{ left: lane.x, top: lane.y,
                maxInlineSize: continuous && territory ? Math.min(220, territory.w * view.scale) : undefined,
                opacity: headerAlpha * furnitureScale(`project:${laneKey}`) }}
              aria-hidden={headerAlpha < 0.5 || undefined}
              ref={element => measure(lane.id, element)}>
              <MapAggregateCard
                facts={{ ...((planeLayout?.elements.find(element =>
                  element.kind === 'container' && element.laneId === laneKey) as any)?.facts ?? lane),
                  kind: 'project', label: (lane as any).label, laneLabel: (lane as any).label }}
                internal={{ dependency: 0, knowledge: 0 }} selected={false}
                onSelect={() => {}} passive nameClass="map-lane-name" />
            </div>
            );
          })}

          {isTaskAltitude && visibleTiles.map(tile => {
            const alpha = taskAlpha(tile.id);
            // §5's far band, exactly as written: "status-tinted shapes
            // (title/meta faded out — NEVER unmounted, never dots) + agent
            // dots + edges". On the continuous plane it is also what keeps
            // the accessibility tree honest — while the container is the
            // layer in charge, the tile does not offer a second, quieter
            // copy of the same opener.
            //
            // THE ONE THING THAT SURVIVES IT is the live agent badge. §3 is
            // untouched by A3 and says the badge "survives EVERY zoom level
            // (name label near, pulsing dot far) ... and must never be
            // hidden by LOD". Far is where the dot form belongs.
            //
            // The shape is NOT MEASURED. Its height is the box the layout
            // already has, so a tile becoming a shape reports nothing new
            // and the plane cannot move underneath the reader — the
            // composition-jump hazard b74ba787 B1 identified, one tier up.
            if (tierOf(tile.bandId, tile.laneId) !== 'task') {
              return (
                <div
                  key={tile.id}
                  aria-hidden="true"
                  className={`map-tile map-tile--shape${paintedTaskChain ? (paintedTaskChain.has(tile.id) ? ' map-tile--lit' : ' map-tile--dimmed') : ''}`}
                  data-status={tile.node.status}
                  data-task={tile.id}
                  style={{
                    left: tile.x, top: tile.y, height: tile.h,
                    opacity: alpha * chainScale(paintedTaskChain, paintedTaskChain?.has(tile.id) ?? false, CHAIN_DIM.node),
                  }}
                >
                  {tile.node.agent ? (
                    <span className="map-tile-shape-agent" title={tile.node.agent} />
                  ) : null}
                </div>
              );
            }
            return (
            <div
              key={tile.id}
              onPointerEnter={() => setHoveredId(tile.id)}
              onPointerLeave={() => setHoveredId(current => (current === tile.id ? null : current))}
              onBlurCapture={() => setHoveredId(current => (current === tile.id ? null : current))}
              className={`map-tile map-tile--${band} ${pulsed.has(tile.id) ? 'map-tile--pulsed' : ''} ${paintedTaskChain ? (paintedTaskChain.has(tile.id) ? 'map-tile--lit' : 'map-tile--dimmed') : ''}`}
              style={{
                left: tile.x, top: tile.y,
                opacity: alpha * chainScale(paintedTaskChain, paintedTaskChain?.has(tile.id) ?? false,
                  CHAIN_DIM.node),
              }}
              onFocusCapture={() => {
                // Focus both selects the chain and discloses the same edges
                // hover does: the opener is a real control, and a keyboard
                // reader must not get less than a pointer one (§4/§6).
                setSelectedId(tile.id);
                setHoveredId(tile.id);
              }}
              onClickCapture={() => setSelectedId(tile.id)}
              ref={element => measure(tile.id, element)}
              data-task={tile.id}
            >
              {/* Board-only machinery the map never reaches: the density
                  early return leaves before any of it runs. */}
              <TaskCard
                task={asTask(tile.node)}
                density={detail.meta ? 'map-detail' : 'map-tile'}
                mapAgent={tile.node.agent ?? null}
                mapProgress={tile.node.progress ?? null}
                mapDetail={detail}
                onOpen={() => onOpenTask(tile.id)}
                onDragStart={() => {}} onDragEnd={() => {}}
                onUpdate={() => {}} onSubtaskTransition={async () => {}} onDelete={() => {}}
                disableDrag
              />
            </div>
            );
          })}

          {/* ---- containers on the continuous plane (clauses 1 and 2) ----
              Not nodes on another plane: the region this phase or project
              already occupies. Zooming out fades its ink IN while the tiles
              inside fade out, in place — nothing lands, nothing jumps, and
              the reader's memory of where the work is keeps working.
              Exactly one tier per region is interactive; the others are
              §5's status-tinted shapes, seen but reachable by nobody. */}
          {planeContainers.map(entry => (entry.interactive ? (
            <div
              key={entry.id}
              className={`map-container map-container--${entry.tier}${entry.core ? ' map-container--core' : ''}${planeStateClass(entry.facts)}${selectedId === entry.id ? ' map-container--selected' : ''}${planeChain ? (planeChain.has(entry.id) ? ' map-container--lit' : ' map-container--dimmed') : ''}`}
              style={{
                left: entry.x, top: entry.y, width: entry.w, height: entry.h,
                // The dominant caption is readable ink, not a half-transparent
                // second layer. Inactive region shapes retain their zoom fade.
                opacity: chainScale(
                  planeChain, planeChain?.has(entry.id) ?? false, CHAIN_DIM.node),
              }}
              // A DRAG IS NOT A HOVER — the same rule the aggregate nodes
              // carry, for the same reason: panning crosses every region.
              onPointerEnter={() => { if (!isPanning) setHoveredId(entry.id); }}
              onPointerLeave={() => setHoveredId(
                current => (current === entry.id ? null : current))}
            >
              <div
                className="map-container-card"
                style={{ width: Math.min(cardBox.w, entry.w * view.scale),
                  maxHeight: entry.h * view.scale, overflow: 'hidden' }}
                ref={element => measure(`card:${entry.id}`, element)}
              >
                <MapAggregateCard
                  facts={entry.facts}
                  internal={entry.internal}
                  selected={selectedId === entry.id}
                  onSelect={() => setSelectedId(
                    selectedId === entry.id ? null : entry.id)}
                />
              </div>
            </div>
          ) : (
            <div
              key={entry.id}
              aria-hidden="true"
              className={`map-container map-container--${entry.tier}${entry.core ? ' map-container--core' : ''} map-container--shape${planeStateClass(entry.facts)}${planeChain ? (planeChain.has(entry.id) ? ' map-container--lit' : ' map-container--dimmed') : ''}`}
              style={{
                left: entry.x, top: entry.y, width: entry.w, height: entry.h,
                opacity: entry.alpha * chainScale(
                  planeChain, planeChain?.has(entry.id) ?? false, CHAIN_DIM.node),
              }}
            />
          )))}
          {/* Aggregate nodes. A2: they carry their contents' MEANING, not
              merely a count — the same four §1 answers a lane header gives,
              derived by the same code so the two altitudes cannot disagree.
              MEASURED like every other element (Rule 1): the grid's cell sizes
              come from these boxes, never from a constant. */}
          {!isTaskAltitude && placedAggregates.map(aggregate => {
            const facts = aggregate.node;
            const internal = rollup.internal.get(aggregate.id) ?? { dependency: 0, knowledge: 0 };
            return (
              <div
                key={aggregate.id}
                className={`map-aggregate map-aggregate--${facts.kind}${facts.stuck > 0 ? ' map-aggregate--stuck' : ''}${selectedId === aggregate.id ? ' map-aggregate--selected' : ''}${aggregateChain ? (aggregateChain.has(aggregate.id) ? ' map-aggregate--lit' : ' map-aggregate--dimmed') : ''}`}
                style={{ left: aggregate.x, top: aggregate.y }}
                ref={element => measure(aggregate.id, element)}
                // A DRAG IS NOT A HOVER. Panning drags the cursor across the
                // plane, which fired pointerenter on every node it crossed and
                // disclosed each one's chain in turn - measured live as 46 long
                // tasks and 457ms on a single pan. The reader panning did not
                // ask about any of them.
                onPointerEnter={() => { if (!isPanning) setHoveredId(aggregate.id); }}
                onPointerLeave={() => setHoveredId(current => (current === aggregate.id ? null : current))}
              >
                <MapAggregateCard
                  facts={facts}
                  internal={internal}
                  selected={selectedId === aggregate.id}
                  onSelect={() => setSelectedId(
                    selectedId === aggregate.id ? null : aggregate.id)}
                />
              </div>
            );
          })}

          {/* One node per in-scope Report, placed at the centroid of the
              aggregates citing it so the converging lines stay short. A2
              requires it to be OPENABLE, so it is a real control with an
              accessible name — not a decorative pill. */}
          {!isTaskAltitude && aggregateReports.map(report => (
            // The POSITIONED WRAPPER carries the plane coordinate and the
            // measuring ref; the control itself is the kit's Button. The
            // control-kit ratchet allows no raw button element here (and it
            // counts them TEXTUALLY, comments included), and the reason
            // to want one would have been visual — which review af33fd17 B1
            // explicitly rules out as an exception. The wrapper is what the
            // layout measures, so the box the grid reserves is the box the
            // control actually paints.
            <div
              key={report.id}
              // Round 10 B2: while a chain is active the Report recedes with
              // everything else unless at least one aggregate citing it is in
              // the chain (§4). The edge-level lit/dimmed above answers per
              // citation; the node answers for the union of its citations.
              className={`map-aggregate-report${aggregateChain && !report.aggregateIds.some(id => aggregateChain.has(id)) ? ' map-aggregate-report--dimmed' : ''}`}
              style={{ left: report.x, top: report.y }}
              ref={element => measure(report.id, element)}
            >
              <Button
                variant="secondary"
                size="compact"
                icon={<FileText size={16} aria-hidden="true" />}
                onClick={() => onOpenReport?.(report.reportId)}
                disabled={!onOpenReport}
                title={report.title}
              >
                <span className="map-aggregate-report-title">{report.title}</span>
                <span className="sr-only">
                  {' '}— linked Report, cited by {report.aggregateIds.length}
                  {report.aggregateIds.length === 1 ? ' group' : ' groups'} in view
                </span>
              </Button>
            </div>
          ))}
        </div>

        {isLoading ? <div className="map-overlay" role="status">Loading the Map…</div> : null}
        {error ? (
          <div className="map-overlay map-overlay--error" role="alert">
            {error.message}
            <Button variant="secondary" size="compact" onClick={refetch}>Retry</Button>
          </div>
        ) : null}
        {!isLoading && !error && graph.nodes.length === 0 ? (
          <div className="map-overlay" role="status">No Tasks match the current filters.</div>
        ) : null}
      </div>

      {/* The accessible alternative (§6): same scope, same grouping, same
          open contract — reachable from the toolbar, not a hidden fallback.
          Derived from graph membership, so it is complete at every altitude. */}
      {treeMode ? (
        <div className="map-tree">
          {tree.map(lane => (
            <section key={lane.laneId} aria-label={lane.laneLabel}>
              <h3>{lane.laneLabel}</h3>
              {lane.bands.map(bandGroup => (
                <div key={bandGroup.id} className="map-tree-band">
                  <h4>
                    {bandGroup.label}
                    {bandGroup.goal ? <span className="map-tree-goal"> — {bandGroup.goal}</span> : null}
                  </h4>
                  <ul>
                    {bandGroup.nodes.map(node => (
                      <li key={node.id}>
                        <Button variant="secondary" size="compact" onClick={() => onOpenTask(node.id)}>
                          {node.title}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
};
