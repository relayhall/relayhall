import { MapConnection } from './MapConnection';
import { MapViewportCard, containerCardInViewport, boundedHeaderStyle } from './MapViewportCard';
import { useArchiveVisibility } from './useArchiveVisibility';
import { recordMapMeasurements, type MapMeasurements } from './mapMeasurements';
import { ArchiveMotionPlane } from './ArchiveMotionPlane';
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileText, LayoutGrid, List, Maximize2, Minus, PanelBottom, Plus } from 'lucide-react';

import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { TaskCard } from '../tasks/TaskCard';
import type { Task } from '../../types/task';
import type { MapGraphQuery } from './mapGraphApi';
import type { MapPlaneJob } from './mapPlaneWorkerClient';
import type { MapPlaneInput } from './computeMapPlane';
import { useMapPlaneLayout } from './useMapPlaneLayout';
import { useMapRoutes } from './useMapRoutes';
import { SPLIT_SIZE_PROPERTY, useMapSplit } from './useMapSplit';
import type { MapRouteRequest, MapRoutesInput } from './computeMapRoutes';
import {
  DETAIL_MATRIX,
  detailBandFor,
  useMapData,
} from './useMapData';
import { useMapInteractions } from './useMapInteractions';
import { clampScale, planeFitScale, PLANE_SCALE_MIN, SCALE_MIN, useMapViewState } from './useMapViewState';
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
  settleAltitude,
  type AggregateEdge,
  type InternalRollup,
  type Box,
  type AggregateFacts,
  type MapAltitude,
  type MapTaskNode,
  type PlacedAggregate,
  type PlacedAggregateReport,
  type PlacedReportPill,
  type PlacedTile,
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
  EMPTY_PLANE_ANCHORS,
  PLANE_CARD_PX,
  PLANE_METRICS,
  planeDetailBand,
  planeContentBounds,
  dominantTier,
  organicPlaneGraph,
  organicPhasePath,
  ORGANIC_CORE,
  planeFade,
  projectPlaneAttention,
  clearStoredPlaneAnchors,
  type MapPlaneAnchors,
  type PlaneFade,
  type PlaneLayoutResult,
  type PlaneTier,
} from './mapPlaneModel';
import { MapCardTitle } from './MapCardTitle';
import { MapAggregateCard, type MapAggregateCardFacts } from './MapAggregateCard';
import {
  REPORT_PREVIEW_LIMIT,
  graphForReportsMode,
  groupReportsByTask,
  isHeavyReportGroup,
  reportGroupTitle,
  taskOfReportGroup,
} from './mapReportGroups';
import { useTheme } from '../../contexts/ThemeContext';
import type { MapReportsMode } from '../../utils/theme';
import { useFocusScrollsRow } from '../ui/scrollRow';
import { useLabelTips } from '../ui/LabelTip';
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
 * Card 742fae98: "Reports: Collapsed | Expanded", beside the organization
 * switch. Collapsed draws one "Reports · N" node per task; Expanded draws every
 * Report node inside a report area. The choice is the principal's own stored
 * preference (the same row as the Theme), so it follows the user across
 * reloads and devices.
 */
const REPORTS_MODE_OPTIONS: Array<SegmentedOption<MapReportsMode>> = [
  { value: 'collapsed', label: 'Collapsed' },
  { value: 'expanded', label: 'Expanded' },
];

/**
 * The Expanded report area's margin around its Report nodes, in plane units.
 * Half the narrowest gap a Report cell keeps from its neighbours and from its
 * own task card (LAYOUT_METRICS.pillGapY = 4, pillGapX = 8), so the area
 * frames the cells without ever reaching another element's ground.
 */
const REPORT_AREA_PAD = 2;

/**
 * Below the close band a "Reports · N" node and a report area show N alone,
 * enlarged up to this factor against the zoom so the count stays readable as
 * the plane shrinks, and never past the cell the layout reserved for it.
 */
const REPORT_COUNT_MAX_SCALE = 2.5;

/**
 * A3 retires Radial into Organic. Persisted Radial views migrate to Organic;
 * the public switcher offers the three owner-ratified organizations.
 */
const ORGANIZATION_OPTIONS: Array<SegmentedOption<MapOrganization>> = (
  ['horizontal', 'vertical'] as const
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
const EMPTY_GRAPH = { nodes: [], edges: [], phases: [], reports: [] };
const EMPTY_LAYOUT: PlaneLayoutResult = { elements: [], width: 0, height: 0, anchors: EMPTY_PLANE_ANCHORS };

export const MapView: React.FC<MapViewProps> = ({ query, onOpenTask, onOpenReport }) => {
  const { graph: loadedGraph, authorityEpoch, authorityReady, isLoading, error, pulsed, refetch } = useMapData(query);
  // ---- the Reports display mode (card 742fae98) ----------------------------
  // The stored choice is the principal's preference; the local copy answers
  // the click at once and survives a save the server refuses, for this visit.
  const { preferences, updatePreferences } = useTheme();
  const storedReportsMode = preferences.mapReportsMode;
  const [reportsMode, setReportsMode] = useState<MapReportsMode>(storedReportsMode);
  useEffect(() => { setReportsMode(storedReportsMode); }, [storedReportsMode]);
  const [reportsModeStatus, setReportsModeStatus] = useState<string | null>(null);
  const chooseReportsMode = useCallback((next: MapReportsMode) => {
    setReportsMode(next);
    setReportsModeStatus(null);
    updatePreferences({ mapReportsMode: next }).catch(() => setReportsModeStatus(
      'The Reports display could not be saved; it applies until you leave the Map.'));
  }, [updatePreferences]);
  // N counts exactly what the graph read lists: the server narrows `reports`
  // Report by Report, so a viewer who may not read a Report is never sent it.
  const reportGroups = useMemo(() => groupReportsByTask(loadedGraph.reports), [loadedGraph.reports]);
  // Collapsed is a Report-layer substitution BEFORE layout: the plane reserves
  // one cell per task for its "Reports · N" node, exactly as it reserves the
  // cells of Report pills, and every pill behaviour follows the node.
  const sourceGraph = useMemo(() => graphForReportsMode(loadedGraph, reportsMode, reportGroups),
    [loadedGraph, reportsMode, reportGroups]);
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null);
  const [mountIdentity] = useState(() => crypto.randomUUID());
  const authorityScope = JSON.stringify([mountIdentity, query, authorityEpoch]);
  const {
    view, setScaleFloor, zoomBy, panBy, applyView, applyFit, needsFit, requestRefit, refitNonce,
  } = useMapViewState();
  const [treeMode, setTreeMode] = useState(false);
  // ---- the Map and list split (card cae8dfe1, RH-UI.17d) ------------------
  // Element-as-state, like the canvas (§8): the split measures the section,
  // its toolbar and the separator, so its effects must run when they exist.
  const [sectionElement, setSectionElement] = useState<HTMLElement | null>(null);
  const [toolbarElement, setToolbarElement] = useState<HTMLDivElement | null>(null);
  // On a phone the toolbar is one line that scrolls sideways (E464): a control
  // that takes focus is brought fully into view.
  useFocusScrollsRow(toolbarElement);
  // E469: a visible label for the icon-only toolbar buttons on a phone (long press, hover, focus).
  const labelTip = useLabelTips(toolbarElement);
  const [separatorElement, setSeparatorElement] = useState<HTMLDivElement | null>(null);
  const split = useMapSplit({ section: sectionElement, toolbar: toolbarElement, separator: separatorElement });
  /** "Show as list" still REPLACES the canvas (§6, round 2 B2); the split is the map WITH the list. */
  const splitActive = split.open && !treeMode;
  const listId = useId();
  const rectangular = view.organization === 'horizontal' || view.organization === 'vertical';
  useEffect(() => {
    if (!rectangular) applyView(previous => ({ ...previous, organization: 'horizontal' }));
  }, [rectangular, applyView]);
  /** §4: which tile the reader is pointing at, or has focused. Collapsed
   *  cross-lane edges are disclosed through this, so it must be state — those
   *  edges are not in the DOM for a stylesheet to reveal. */
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // ---- measurement: the SizeMap is the layout's only source of geometry ----
  // Tiles report their real box; the layout re-runs with measured values.
  // Nothing here guesses a height (diagnosis 7fa7e605 P3).
  const [measurements, setMeasurements] = useState<MapMeasurements>({ sizes: {}, planeSizes: {} });
  const { sizes, planeSizes } = measurements;
  // Ref callbacks run among DOM mutations. Defer dimension reads until all
  // refs for this commit have attached, rather than forcing layout per ref.
  const pendingMeasurements = useRef(new Map<string, { element: HTMLElement; planeGeometry: boolean }>());
  const measure = useCallback((id: string, element: HTMLElement | null, planeGeometry = false) => {
    if (element) pendingMeasurements.current.set(id, { element, planeGeometry });
    else pendingMeasurements.current.delete(id);
  }, []);
  useLayoutEffect(() => {
    if (!pendingMeasurements.current.size) return;
    // offsetWidth/Height remain untransformed layout dimensions, in plane
    // units. Read every attached element before publishing any state change.
    const batch = [...pendingMeasurements.current].map(([id, { element, planeGeometry }]) => ({
      id, w: element.offsetWidth, h: element.offsetHeight, planeGeometry,
    }));
    pendingMeasurements.current.clear();
    setMeasurements(previous => recordMapMeasurements(previous, batch));
  });


  /** Reader navigation takes ownership from any earlier arrival/explicit Fit. */
  const correctiveFitRef = useRef<CorrectiveFitState>(INITIAL_CORRECTIVE_FIT);
  const onZoom = useCallback((factor: number, anchor: { x: number; y: number }) => {
    correctiveFitRef.current = INITIAL_CORRECTIVE_FIT;
    zoomBy(factor, anchor);
  }, [zoomBy]);
  const viewportRef = useRef({ width: 0, height: 0 });
  const onZoomCentre = useCallback((factor: number) => {
    correctiveFitRef.current = INITIAL_CORRECTIVE_FIT;
    const { width, height } = viewportRef.current;
    zoomBy(factor, { x: width / 2, y: height / 2 });
  }, [zoomBy]);
  const onPan = useCallback((dx: number, dy: number) => {
    correctiveFitRef.current = INITIAL_CORRECTIVE_FIT;
    panBy(dx, dy);
  }, [panBy]);
  const { canvasRef, viewport, isPanning } = useMapInteractions({ onZoom, onPan: onPan, onZoomCentre });
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
   * The anchors are a REF, and they live for this session only.
   *
   * They hold the ORDER the session has given the plane — lane order,
   * segment order and the slots of the cards shown — so a board update does
   * not reshuffle what the reader is looking at. They hold no ground: the
   * engine fits every area to what is shown (owner ruling E386), and nothing
   * is restored from or written to the browser, so a reload starts from the
   * data alone.
   *
   * They are deliberately not state. The engine is a FIXED POINT in them
   * (asserted in mapPlaneModel.test.ts), so writing back what a layout just
   * decided cannot change what that layout decided; making them state would
   * schedule a second render per layout for a picture identical to the
   * first. The ref is read at layout time and written at layout time.
   */
  const anchorsRef = useRef<Partial<Record<MapOrganization, MapPlaneAnchors>>>({});
  const anchorEpoch = useRef(0);
  if (continuous && !anchorsRef.current[view.organization]) {
    anchorsRef.current[view.organization] = EMPTY_PLANE_ANCHORS;
    anchorEpoch.current += 1;
  }
  // E386's one-time cleanup: earlier releases stored the layout record in the
  // browser. It is never read; every copy is removed when the Map loads.
  useEffect(() => { clearStoredPlaneAnchors(); }, []);
  /**
   * RE-PACK (E375, kept by E386): the reader's explicit "start again". The
   * session's order for the current organization is discarded, and the plane
   * is laid out afresh from what is shown now — lanes and phases in their
   * declared order, cards by dependency rank — then fitted to the viewport.
   */
  const [repackNonce, setRepackNonce] = useState(0);
  const repackHintId = useId();
  // E386: hiding archived work changes what is SHOWN, and the plane fits what
  // is shown, so the toggle reaches the layout through the graph alone. (The
  // density migration that used to ride on this input upgraded a record a
  // released Map had stored; nothing is stored any more, so it is gone.)
  const anchorGeneration = anchorEpoch.current;
  const planeInput = useMemo<MapPlaneInput | null>(() => continuous && authorityReady && !error ? {
    graph: sourceGraph, sizes: planeSizes, organization: view.organization,
    anchors: anchorsRef.current[view.organization]!,
  } : null, [continuous, authorityReady, error, sourceGraph, planeSizes, view.organization, anchorGeneration,
    repackNonce]);
  const acceptPlane = useCallback((input: MapPlaneInput, result: PlaneLayoutResult) => {
    anchorsRef.current[input.organization] = result.anchors;
  }, []);
  const computation = useMapPlaneLayout(planeInput, authorityScope, acceptPlane);
  const planeLayout = continuous ? computation.visible?.layout ?? EMPTY_LAYOUT : null;
  // All downstream edges, counters, attention, tree and archive targets use
  // this same display membership while a complete replacement is pending.
  const graph = continuous ? computation.visible?.graph ?? EMPTY_GRAPH : sourceGraph;
  const geometryComplete = !continuous || computation.complete;
  const [switchStatus, setSwitchStatus] = useState<string | null>(null);
  const switchContext = useMemo(() => ({ sourceGraph, planeSizes, viewport, view, refitNonce,
    authorityScope, planeLayout, authorityReady }),
  [sourceGraph, planeSizes, viewport, view, refitNonce, authorityScope, planeLayout, authorityReady]);
  const switchTicket = useRef<{ controller: AbortController; job?: MapPlaneJob;
    next: MapOrganization; context: typeof switchContext } | null>(null);
  const restartSwitch = useRef<((next: MapOrganization) => void) | null>(null);
  const currentSwitchContext = useRef(switchContext);
  currentSwitchContext.current = switchContext;
  const cancelSwitch = useCallback((message: string | null = null) => {
    const ticket = switchTicket.current;
    if (!ticket) return;
    ticket.controller.abort(); ticket.job?.cancel(); switchTicket.current = null;
    setSwitchStatus(message);
  }, []);
  useEffect(() => {
    const ticket = switchTicket.current;
    if (!ticket || ticket.context === switchContext) return;
    const prior = ticket.context;
    if (prior.authorityScope !== switchContext.authorityScope || !switchContext.authorityReady
      || prior.view !== switchContext.view || prior.refitNonce !== switchContext.refitNonce
      || prior.viewport !== switchContext.viewport) {
      cancelSwitch('View changed; select the layout again.');
    } else {
      // A measurement/data completion retains the user's chosen target and
      // deliberately recalculates it against the newest coherent snapshot.
      restartSwitch.current?.(ticket.next);
    }
  }, [switchContext, cancelSwitch]);
  useEffect(() => () => cancelSwitch(), [cancelSwitch]);

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
  const fitBounds = useMemo(() => continuous ? planeContentBounds(layout.elements, planeLayout?.organicRegions?.map(r=>r.box))
    : { x: 0, y: 0, w: layout.width, h: layout.height }, [continuous, layout, planeLayout]);

  // Fit is an explicit navigation action, not a limit on zooming out.
  const scaleFloor = continuous ? PLANE_SCALE_MIN : SCALE_MIN;
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

  // ---- hover linking between the list and the map (card cae8dfe1, RH-UI.17e)
  /**
   * List to map. The list row the reader points at, or focuses, is marked on
   * the plane by ONE ring placed over its tile's box, in the tiles' own hover
   * ink (MapView.css) rather than a second highlight vocabulary.
   *
   * It is answered in the DOM, not in state: a pointer travelling down a long
   * list must not re-render the plane once per row (the card's estate-scale
   * rule). And because the ring is its own element above the tiles, the chain
   * selection's lit and dim are neither changed nor hidden by it: a dimmed
   * tile is still found, and the selection is exactly what it was.
   */
  const linkRingRef = useRef<HTMLDivElement | null>(null);
  const listLinkRef = useRef<string | null>(null);
  const tileByIdRef = useRef(tileById);
  tileByIdRef.current = tileById;
  const placeLinkRing = useCallback(() => {
    const ring = linkRingRef.current;
    if (!ring) return;
    const id = listLinkRef.current;
    const tile = id === null ? undefined : tileByIdRef.current.get(id);
    if (id === null || !tile) {
      ring.removeAttribute('data-active');
      ring.removeAttribute('data-link-task');
      return;
    }
    ring.style.left = `${tile.x}px`;
    ring.style.top = `${tile.y}px`;
    ring.style.width = `${tile.w}px`;
    ring.style.height = `${tile.h}px`;
    ring.setAttribute('data-link-task', id);
    ring.setAttribute('data-active', '');
  }, []);
  // The plane can move under a held link (a board update, a re-pack), so
  // every commit re-places the one ring: a single lookup.
  useLayoutEffect(() => { placeLinkRing(); });
  const linkFromList = useCallback((id: string) => {
    listLinkRef.current = id;
    placeLinkRing();
  }, [placeLinkRing]);
  const unlinkFromList = useCallback((id: string) => {
    if (listLinkRef.current !== id) return;
    listLinkRef.current = null;
    placeLinkRing();
  }, [placeLinkRing]);
  useEffect(() => {
    if (splitActive) return;
    listLinkRef.current = null;
    placeLinkRing();
  }, [splitActive, placeLinkRing]);

  /**
   * Map to list. The tile the reader points at or focuses (§4's `hoveredId`,
   * which tile focus already drives) marks its list row, and the list scrolls
   * just far enough to show it when it is out of sight. The list scrolls
   * itself only, never the page, and a row already in sight does not move.
   */
  const listRef = useRef<HTMLDivElement | null>(null);
  const linkedRowRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    const id = splitActive && hoveredId !== null && tileById.has(hoveredId) ? hoveredId : null;
    const row = id !== null && list
      ? list.querySelector<HTMLElement>(`[data-list-task="${id.replace(/["\\]/g, '\\$&')}"]`)
      : null;
    const previous = linkedRowRef.current;
    if (previous && previous !== row) previous.removeAttribute('data-map-linked');
    linkedRowRef.current = row;
    if (!row || !list) return;
    row.setAttribute('data-map-linked', '');
    const frame = list.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    if (box.top < frame.top) list.scrollTop -= frame.top - box.top;
    else if (box.bottom > frame.bottom) list.scrollTop += box.bottom - frame.bottom;
  }, [hoveredId, splitActive, tileById]);

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
  const eligibleTiles = useMemo(() => {
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
    return tiles;
  }, [layout, fade]);
  /** The plane rectangle culling admits, or null while the viewport has no size. */
  const cullRect = useMemo(() => {
    if (!viewport.width || !viewport.height) return null;
    return {
      left: (-view.offsetX - CULL_MARGIN) / view.scale,
      top: (-view.offsetY - CULL_MARGIN) / view.scale,
      right: (viewport.width - view.offsetX + CULL_MARGIN) / view.scale,
      bottom: (viewport.height - view.offsetY + CULL_MARGIN) / view.scale,
    };
  }, [viewport, view.offsetX, view.offsetY, view.scale]);
  const inCull = useCallback((box: Box) => !cullRect || (
    box.x + box.w >= cullRect.left && box.x <= cullRect.right &&
    box.y + box.h >= cullRect.top && box.y <= cullRect.bottom), [cullRect]);
  const inViewport = useMemo(
    () => new Set(eligibleTiles.filter(inCull).map(tile=>tile.id)),
    [eligibleTiles, inCull]);
  const pills = useMemo(
    () => layout.elements.filter((e): e is PlacedReportPill => e.kind === 'pill'), [layout]);
  const visibleTiles = useArchiveVisibility(eligibleTiles, inViewport, pills,
    planeLayout?.archiveScales, JSON.stringify([authorityScope,view.organization]),
    authorityReady && !error && view.organization === 'organic' && !treeMode);


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


  // §5: "the render-count is surfaced in dev builds". Culling exists to keep
  // the live DOM bounded, and the number that proves it is how many tiles are
  // actually mounted versus how many are in scope.
  // Culled by its OWN box, exactly as a tile is (card 2b6f21f6 (C), owner
  // screenshots 07 vs 08): a Report cell inside the viewport is drawn even
  // when the Task it stands beside is not, because a large Report grid
  // reaches far past its Task. It still recedes with that Task — a pill is
  // the Task's close-zoom ink, so a Task its container has taken over
  // carries no pills — and a Task drawn for any other reason keeps its own.
  const visiblePills = useMemo(() => {
    const visibleIds = new Set(visibleTiles.map(tile => tile.id));
    const inkIds = new Set(eligibleTiles.map(tile => tile.id));
    return pills.filter(pill => visibleIds.has(pill.taskId)
      || (inkIds.has(pill.taskId) && inCull(pill)));
  }, [pills, visibleTiles, eligibleTiles, inCull]);
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

  /**
   * The Report nodes this frame DRAWS (card 742fae98). An individual Report
   * pill is the close band's ink, as before; a Collapsed "Reports · N" node is
   * drawn wherever its task is, at every band, because the owner asked for N
   * at every zoom. Both are culled by their OWN box (card 2b6f21f6 (C)).
   */
  const drawnPills = useMemo(
    () => (isTaskAltitude
      ? visiblePills.filter(pill => detail.reports || taskOfReportGroup(pill.reportId) !== null)
      : []),
    [isTaskAltitude, visiblePills, detail.reports],
  );

  /**
   * Expanded's report area (card 742fae98): one per task, framing every
   * Report cell the layout reserved for it, so it is sized by N exactly as
   * the cells are and the task card stands beside it. Built from ALL placed
   * cells, then culled by its own box like a pill — panning across a task's
   * Reports keeps the area while the task card is off-screen.
   */
  const reportAreas = useMemo(() => {
    const bounds = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
    for (const pill of pills) {
      if (taskOfReportGroup(pill.reportId) !== null) continue;
      const held = bounds.get(pill.taskId);
      if (!held) bounds.set(pill.taskId, { x0: pill.x, y0: pill.y, x1: pill.x + pill.w, y1: pill.y + pill.h });
      else {
        held.x0 = Math.min(held.x0, pill.x); held.y0 = Math.min(held.y0, pill.y);
        held.x1 = Math.max(held.x1, pill.x + pill.w); held.y1 = Math.max(held.y1, pill.y + pill.h);
      }
    }
    return [...bounds].map(([taskId, box]) => ({
      id: `report-area:${taskId}`, taskId,
      x: box.x0 - REPORT_AREA_PAD, y: box.y0 - REPORT_AREA_PAD,
      w: box.x1 - box.x0 + 2 * REPORT_AREA_PAD, h: box.y1 - box.y0 + 2 * REPORT_AREA_PAD,
    }));
  }, [pills]);
  const drawnReportAreas = useMemo(() => {
    if (!isTaskAltitude) return [];
    const visibleIds = new Set(visibleTiles.map(tile => tile.id));
    const inkIds = new Set(eligibleTiles.map(tile => tile.id));
    return reportAreas.filter(area => visibleIds.has(area.taskId) || (inkIds.has(area.taskId) && inCull(area)));
  }, [isTaskAltitude, reportAreas, visibleTiles, eligibleTiles, inCull]);
  /** N alone, enlarged against the zoom below the close band (never past its cell). */
  const reportCountScale = Math.min(REPORT_COUNT_MAX_SCALE, Math.max(1, 1 / view.scale));
  const previewPill = previewTaskId === null ? undefined
    : drawnPills.find(pill => pill.taskId === previewTaskId && taskOfReportGroup(pill.reportId) !== null);
  const previewGroup = previewPill ? reportGroups.get(previewPill.taskId) : undefined;
  const previewId = `map-report-preview-${mountIdentity}`;

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
   * Membership is cached independently of zoom; opacity decides which tier
   * paints the cached relationships.
   */
  const planeGraph = useMemo(() => view.organization === 'organic' ? organicPlaneGraph(graph) : graph, [graph, view.organization]);
  // Membership does not change during zoom. Do not rebuild both dependency
  // graphs on every gesture frame merely because their opacity changed.
  const planeRollup = useMemo(() => continuous ? {
    phase: rollUpEdges(planeGraph, 'phase'),
    project: rollUpEdges(planeGraph, 'project'),
  } : null, [continuous, planeGraph]);

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
          // The phase must own the ink and have a discernible region. Its
          // caption can sit in a screen-space gutter, so a narrow phase
          // need not fit the card itself to remain reachable at Fit.
          interactive: tierOf(element.id, element.laneId) === 'phase'
            && element.w * view.scale >= 8 && element.h * view.scale >= 8,
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

  // Overview captions are screen-space annotations, not new world geometry.
  // A tall phase can fit on screen while its ground is too narrow for a card.
  // Place a concise name beside it, without changing persisted lane anchors.
  const overviewCaptions = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    if (rectangular) return positions;
    const occupied: Box[] = [];
    const width = 184;
    const height = 56;
    const gap = 8;
    const intersects = (a: Box, b: Box) => a.x < b.x + b.w + gap
      && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
    const screenBox = (entry: PlaneContainerEntry): Box => ({
      x: entry.x * view.scale + view.offsetX, y: entry.y * view.scale + view.offsetY,
      w: entry.w * view.scale, h: entry.h * view.scale,
    });
    // Passive project headers still occupy screen space while phases own
    // interaction. Reserve them too, or an annotation can cover the title.
    for (const element of layout.elements) {
      if (element.kind !== 'lane' || projectAlpha(element.id.slice('lane:'.length)) >= 0.5) continue;
      occupied.push({ x: element.x * view.scale + view.offsetX,
        y: element.y * view.scale + view.offsetY, w: cardBox.w, h: 120 });
    }
    for (const entry of planeContainers) {
      if (!entry.interactive) continue;
      const box = screenBox(entry);
      if (box.w >= 160 && box.h >= 96) {
        occupied.push({ ...box, w: Math.min(cardBox.w, box.w), h: 120 });
      }
    }
    for (const entry of planeContainers) {
      if (!entry.interactive) continue;
      const box = screenBox(entry);
      if (box.w >= 160 && box.h >= 96) continue;
      if (box.x + box.w < 0 || box.y + box.h < 0
        || box.x > viewport.width || box.y > viewport.height) continue;
      if (viewport.width < width + gap * 2 || viewport.height < height + gap * 2) continue;
      const clampX = (x: number) => Math.max(gap, Math.min(viewport.width - width - gap, x));
      const clampY = (y: number) => Math.max(gap, Math.min(viewport.height - height - gap, y));
      // Prefer the nearest free gutter. On dense views search other rows;
      // never stack labels on top of each other or move the underlying work.
      const xs = [clampX(box.x + box.w + gap), clampX(box.x - width - gap), clampX(box.x)];
      let placed = false;
      for (let row = 0; row < Math.ceil(viewport.height / (height + gap)) && !placed; row++) {
        for (const direction of row ? [1, -1] : [1]) {
          const y = clampY(box.y + direction * row * (height + gap));
          for (const x of xs) {
            const candidate = { x, y, w: width, h: height };
            if (occupied.some(other => intersects(candidate, other))) continue;
            positions.set(entry.id, { x: (x - view.offsetX) / view.scale,
              y: (y - view.offsetY) / view.scale });
            occupied.push(candidate);
            placed = true;
            break;
          }
          if (placed) break;
        }
      }
    }
    return positions;
  }, [rectangular, planeContainers, layout, projectAlpha, view.scale, view.offsetX, view.offsetY, viewport, cardBox.w]);

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
  // Keep visible relationships discoverable; hover changes emphasis, not membership.
  const visibleEdges = useMemo(() => drawableEdges.filter(edge =>
    inViewport.has(edge.from) || inViewport.has(edge.to)), [drawableEdges, inViewport]);

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
    if (!planeRollup || visibleTiles.length > 0) return drawn;
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
  }, [planeRollup, activePlaneId, planeChain, planeLaneOfAggregate, visibleTiles.length]);

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
    const boxes: Box[] = [...visibleTiles, ...drawnPills];
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
  }, [isTaskAltitude, visibleTiles, drawnPills, layout, viewport, view.offsetX, view.offsetY, view.scale]);

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
    () => planeLayout?.worldBounds ?? ({ x: 0, y: 0, w: layout.width, h: layout.height }),
    [planeLayout, layout.width, layout.height],
  );

  // Coarse zoom bands keep a readable screen-space halo without restarting
  // the routing worker on every fractional wheel event.
  const routeScale = view.scale >= 1 ? 1 : view.scale >= 0.5 ? 0.5 : view.scale >= 0.35 ? 0.35 : 0.2;
  const routeInput = useMemo<MapRoutesInput | null>(() => {
    if (!authorityReady || error) return null;
    const requests: MapRouteRequest[] = [];
    const mode = continuous ? 'flow' : 'plane-edge';
    if (isTaskAltitude) {
      for (const edge of visibleEdges) {
        const source = tileById.get(edge.to), target = tileById.get(edge.from);
        if (source && target && Math.min(taskAlpha(edge.from), taskAlpha(edge.to)) > FADE_EPSILON)
          requests.push({ key: JSON.stringify(['task', edge.kind, edge.from, edge.to]), source, target, mode });
      }
    } else {
      for (const edge of visibleAggregateEdges) {
        const source = aggregateById.get(edge.to), target = aggregateById.get(edge.from);
        if (source && target) requests.push({ key: JSON.stringify(['aggregate', edge.kind, edge.from, edge.to]), source, target, mode: 'legacy-edge' });
      }
      for (const report of aggregateReports) for (const id of report.aggregateIds) {
        const target = aggregateById.get(id);
        if (target) requests.push({ key: JSON.stringify(['aggregate-report', report.reportId, id]), source: report, target, mode, report: true });
      }
    }
    for (const { tier, edge } of planeEdges) {
      const source = planeAggregateBox.get(edge.to), target = planeAggregateBox.get(edge.from);
      if (source && target && Math.min(source.alpha, target.alpha) > FADE_EPSILON)
        requests.push({ key: JSON.stringify(['plane', tier, edge.kind, edge.from, edge.to]), source, target, mode });
    }
    if (isTaskAltitude && detail.reports) for (const pill of visiblePills) {
      const target = tileById.get(pill.taskId);
      if (target) requests.push({ key: JSON.stringify(['report', pill.id]), source: pill, target, mode, report: true });
    }
    return { requests, obstacles: edgeObstacles, envelope: routeEnvelope, organization: view.organization, scale: routeScale };
  }, [authorityReady, error, continuous, isTaskAltitude, visibleEdges, tileById, taskAlpha,
    visibleAggregateEdges, aggregateById, aggregateReports, planeEdges, planeAggregateBox,
    detail.reports, visiblePills, edgeObstacles, routeEnvelope, view.organization, routeScale]);
  const routing = useMapRoutes(routeInput, authorityScope, sourceGraph);
  const pendingRouteTitle = routing.error ? 'Connection calculation failed; retry connections' : 'Calculating connection…';

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
      ? visibleTiles
        // The phase-owned silhouette branch never measures its tiles. Only
        // wait for the task cards that actually mount a measurement ref;
        // otherwise Fit deadlocks during the partial cross-fade after zoom.
        .filter(tile => tierOf(tile.bandId, tile.laneId) === 'task')
        .map(tile => tile.id)
      : [...placedAggregates.map(a => a.id), ...aggregateReports.map(r => r.id)]),
    [isTaskAltitude, visibleTiles, placedAggregates, aggregateReports, tierOf],
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

  useEffect(() => {
    if (!needsFit()) return;
    if (isLoading || !geometryComplete || graph.nodes.length === 0) return;
    if (!viewport.width || !viewport.height) return;
    if (!measurementSettled) return;

    // The continuous plane has one plane and one fit. There is no altitude
    // to arrive at, so there is no placeholder-geometry hazard to walk
    // around either: the plane on screen IS the plane being fitted.
    if (continuous) {
      const planeScale = planeFitScale({ width: fitBounds.w, height: fitBounds.h }, viewport);
      correctiveFitRef.current = onFitSpent(
        correctiveFitRef.current, { width: layout.width, height: layout.height });
      applyFit({
        organization: view.organization,
        altitude: 'task',
        scale: planeScale,
        offsetX: (viewport.width - fitBounds.w * planeScale) / 2 - fitBounds.x * planeScale,
        offsetY: (viewport.height - fitBounds.h * planeScale) / 2 - fitBounds.y * planeScale,
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
    needsFit, isLoading, geometryComplete, graph, sizes, viewport, applyFit, applyView,
    view.organization, view.altitude, layout, fitBounds, measurementSettled, altitudeOptions,
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
    if (!geometryComplete) return;
    if (needsFit()) return;
    const next = onExtentChanged(
      correctiveFitRef.current, { width: layout.width, height: layout.height });
    correctiveFitRef.current = next.state;
    if (next.refit) requestRefit();
  }, [layout.width, layout.height, needsFit, requestRefit, geometryComplete]);

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

  const repack = useCallback(() => {
    if (!continuous) return;
    cancelSwitch();
    anchorsRef.current[view.organization] = EMPTY_PLANE_ANCHORS;
    anchorEpoch.current += 1;
    setRepackNonce(value => value + 1);
    fitNow();
  }, [continuous, cancelSwitch, view.organization, fitNow]);

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
  const morphOwner = useRef<{ layout: PlaneLayoutResult; scope: string } | null>(null);
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
  useLayoutEffect(() => {
    const owner = morphOwner.current;
    if (!owner || (owner.scope === authorityScope
      && (!computation.supportsWorker || owner.layout === planeLayout))) return;
    morphOwner.current = null;
    if (morphTimer.current !== null) window.clearTimeout(morphTimer.current);
    setMorphing(false); setContainerMorph(null);
  }, [authorityScope, planeLayout, computation.supportsWorker]);
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
  const commitOrganization = useCallback((next: MapOrganization, nextLayout: PlaneLayoutResult) => {
    // Arriving ON the continuous plane means arriving at ONE world: there is
    // no altitude to carry across, so the target is the plane itself.
    const nextContinuous = CONTINUOUS_PLANE_ORGANIZATIONS.includes(next);
    const nextAltitude: MapAltitude = nextContinuous ? 'task' : view.altitude;
    const nextBounds = nextContinuous ? planeContentBounds(nextLayout.elements, (nextLayout as PlaneLayoutResult).organicRegions?.map(r=>r.box))
      : { x: 0, y: 0, w: nextLayout.width, h: nextLayout.height };
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
    const scale = nextContinuous && viewport.width > 0 && viewport.height > 0 ? planeFitScale({ width: nextBounds.w, height: nextBounds.h }, viewport)
      : (nextAltitude !== view.altitude && focus && from && focus.w > 0)
      ? clampScale(view.scale * (from.w / focus.w))
      : view.scale;
    applyView(() => ({
      organization: next,
      altitude: nextAltitude,
      scale,
      offsetX: nextContinuous ? (viewport.width - nextBounds.w * scale) / 2 - nextBounds.x * scale : viewport.width / 2 - targetX * scale,
      offsetY: nextContinuous ? (viewport.height - nextBounds.h * scale) / 2 - nextBounds.y * scale : viewport.height / 2 - targetY * scale,
    }));
    setMorphing(true);
    const owner = { layout: nextLayout, scope: authorityScope };
    morphOwner.current = owner;
    if (morphTimer.current !== null) window.clearTimeout(morphTimer.current);
    morphTimer.current = window.setTimeout(() => {
      if (morphOwner.current === owner) setMorphing(false);
    }, 500);
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
    layout, graph, sizes, aspect, viewport, applyView, isLoading, requestRefit, authorityScope]);

  const switchOrganization = useCallback((next: MapOrganization) => {
    cancelSwitch();
    if (next === view.organization) { setSwitchStatus(null); return; }
    if (isLoading || !authorityReady) {
      applyView(current => ({ ...current, organization: next, altitude: 'task' }));
      requestRefit(); return;
    }
    const context = switchContext;
    const held = anchorsRef.current[next] ?? EMPTY_PLANE_ANCHORS;
    anchorsRef.current[next] = held;
    const ticket: NonNullable<typeof switchTicket.current> = { controller: new AbortController(), next, context };
    switchTicket.current = ticket;
    const isCurrent = () => switchTicket.current === ticket && !ticket.controller.signal.aborted
      && currentSwitchContext.current === context && anchorsRef.current[next] === held;
    setSwitchStatus(`Preparing ${ORGANIZATION_LABELS[next]} layout…`);
    void (async () => {
      try {
        const target: MapPlaneInput = { graph: sourceGraph, sizes: planeSizes, organization: next, anchors: held };
        ticket.job = computation.requestTarget(target);
        const result = await ticket.job.result;
        if (!isCurrent()) return;
        // Clear the ticket before the batched target layout, anchors and camera
        // update changes the context that invalidates abandoned switches.
        computation.adoptTarget(target, result);
        switchTicket.current = null;
        commitOrganization(next, result);
        setSwitchStatus(null);
      } catch (failure) {
        if (switchTicket.current !== ticket) return;
        switchTicket.current = null;
        setSwitchStatus(failure instanceof Error && failure.name !== 'AbortError'
          ? `Could not change layout: ${failure.message}` : 'View changed; select the layout again.');
      }
    })();
  }, [cancelSwitch, view.organization, isLoading, authorityReady, applyView, requestRefit,
    switchContext, sourceGraph, planeSizes, computation.requestTarget, computation.adoptTarget, commitOrganization]);
  restartSwitch.current = switchOrganization;


  // The list's height reaches the stylesheet as a custom property on the
  // section, which is also where a drag writes it between commits.
  const splitStyle = useMemo(() => (splitActive
    ? { [SPLIT_SIZE_PROPERTY]: `${split.listSize}px` } as React.CSSProperties
    : undefined), [splitActive, split.listSize]);

  return (
    <section
      ref={setSectionElement}
      className={`map-view${treeMode ? ' map-view--list' : ''}${splitActive ? ' map-view--split' : ''}`}
      aria-label="Task map"
      style={splitStyle}
    >
      <div className="map-toolbar" ref={setToolbarElement}>
        <div className="map-toolbar-group">
          <IconButton icon={<Minus size={16} />} ariaLabel="Zoom out" labelTip
            onClick={() => onZoomCentre(0.8)} />
          <IconButton icon={<Plus size={16} />} ariaLabel="Zoom in" labelTip
            onClick={() => onZoomCentre(1.25)} />
          <IconButton icon={<Maximize2 size={16} />} ariaLabel="Fit view" labelTip onClick={fitNow} />
        </div>
        {continuous ? (
          <>
            {/* E466: on a phone this button and the two below are icon-only
                squares (MapView.css hides the words visually, never from the
                accessible name); the title is the tooltip. The desktop toolbar
                is unchanged. */}
            <Button variant="secondary" size="compact"
              className="map-toolbar-iconbtn"
              labelTip
              title="Re-pack layout"
              icon={<LayoutGrid size={16} />}
              ariaDescribedBy={repackHintId}
              onClick={repack}>
              Re-pack layout
            </Button>
            <span id={repackHintId} className="sr-only">
              Discards the order this session has given the Map and lays it out afresh from what is shown.
            </span>
          </>
        ) : null}
        <SegmentedControl
          ariaLabel="Map organization"
          options={ORGANIZATION_OPTIONS}
          value={view.organization}
          onChange={switchOrganization}
        />
        <div className="map-toolbar-reports">
          {/* The group's accessible name is "Reports display"; the visible
              prefix reads the owner's wording, "Reports: Collapsed | Expanded". */}
          <span className="map-toolbar-label" aria-hidden="true">Reports:</span>
          <SegmentedControl
            ariaLabel="Reports display"
            options={REPORTS_MODE_OPTIONS}
            value={reportsMode}
            onChange={chooseReportsMode}
          />
        </div>
        <Button variant="secondary" size="compact"
          className="map-toolbar-iconbtn"
          labelTip
          title={treeMode ? 'Show as map' : 'Show as list'}
          icon={<List size={16} />}
          ariaPressed={treeMode}
          onClick={() => setTreeMode(value => !value)}>
          {treeMode ? 'Show as map' : 'Show as list'}
        </Button>
        {/* Card cae8dfe1 (RH-UI.17d): the map WITH the list below it, the
            two divided by a separator the reader can drag or key. From the
            list, it brings the map back above the list. */}
        <Button variant="secondary" size="compact"
          className="map-toolbar-iconbtn"
          labelTip
          title="Map and list"
          icon={<PanelBottom size={16} />}
          ariaPressed={splitActive}
          onClick={() => {
            if (treeMode) { setTreeMode(false); split.setOpen(true); }
            else split.setOpen(!split.open);
          }}>
          Map and list
        </Button>
        <span className="map-scope-count">
          {graph.nodes.length} task{graph.nodes.length === 1 ? '' : 's'} in view
        </span>
        {continuous && authorityReady && !geometryComplete && !computation.error ?
          <span role="status">Updating layout… {computation.visible?.pendingTaskCount ?? sourceGraph.nodes.length} tasks and {computation.visible?.pendingReportCount ?? sourceGraph.reports?.length ?? 0} reports pending.</span> : null}
        {switchStatus ? <span role="status">{switchStatus}</span> : null}
        {reportsModeStatus ? <span role="status">{reportsModeStatus}</span> : null}
        {routing.pending ? <span role="status">Calculating connections…</span> : null}
      </div>

      {labelTip}

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
        <ArchiveMotionPlane
          motionEnabled={view.organization === 'organic'}
          motionScale={view.scale}
          motionTargets={isTaskAltitude ? [
            ...visibleTiles.map(tile => ({ id: tile.id, owner: tile.id,
              x: tile.x, y: tile.y, archived: tile.node.status === 'archived',
              scale: tierOf(tile.bandId, tile.laneId) === 'task'
                ? planeLayout?.archiveScales?.[tile.id] ?? 1 : 1 })),
            ...drawnPills.map(pill => ({ id: pill.id, owner: pill.taskId,
              x: pill.x, y: pill.y, archived: tileById.get(pill.taskId)?.node.status === 'archived',
              scale: planeLayout?.archiveScales?.[pill.id] ?? 1 })),
          ] : []}
          data-plane-lod={continuous ? planeBand : undefined}
          data-fit-bounds={`${fitBounds.x},${fitBounds.y},${fitBounds.w},${fitBounds.h}`}
          data-world-width={layout.width}
          data-world-height={layout.height}
          className={`map-plane${rectangular ? ' map-plane--rectangular' : ''}${(view.organization === 'organic' || view.organization === 'radial') ? ' map-plane--branched' : ''}${morphing ? ' map-plane--morphing' : ''}${containerMorph ? ' map-plane--container-morph' : ''}`}
          style={{
            transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`,
            width: 0,
            height: 0,
            // The container cards ride this back out again, so a label keeps
            // its CSS size while the world it labels shrinks — the one thing
            // a map never scales.
            ['--map-plane-inverse-scale' as string]: 1 / view.scale,
          }}
        >
          {/* Rasterize only the viewport, not a potentially 100,000px estate.
              Cancel the HTML camera here, then apply it inside SVG so its
              viewport clips paths before rasterization. */}
          <svg className="map-edges" width={viewport.width} height={viewport.height}
            style={{ left: -view.offsetX / view.scale, top: -view.offsetY / view.scale,
              transform: `scale(${1 / view.scale})`, transformOrigin: 'top left',
              overflow: 'hidden', ['--map-plane-inverse-scale' as string]: 1 }} aria-hidden="true">
            <g transform={`translate(${view.offsetX} ${view.offsetY}) scale(${view.scale})`}>
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
                  {/* Never conceal a relation or fill a clipped route as ground.
                      This is explicitly degraded, matching existing edge policy. */}
                  {region.blockedRoutes?.map((route,i)=><path key={`blocked:${i}`}
                    data-project-branch={region.laneId} data-route-state="blocked"
                    data-from={route.from.join(',')} data-to={route.to.join(',')}
                    className="map-edge map-edge--unrouted" fill="none"
                    vectorEffect="non-scaling-stroke" d={route.d}>
                    <title>{`${region.laneId}: project branch could not be routed clear of other nodes`}</title>
                  </path>)}
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
            {isTaskAltitude && visibleEdges.map((edge, edgeIndex) => {
              const from = tileById.get(edge.from);
              const to = tileById.get(edge.to);
              if (!from || !to) return null;
              const route = routing.rows.get(JSON.stringify(['task', edge.kind, edge.from, edge.to]));
              if (!route) return null;
              // §4 holds at EVERY zoom, and on the plane an edge belongs to
              // the layer its endpoints are on: it recedes with them and the
              // rolled-up edge between their containers takes over.
              const edgeAlpha = Math.min(taskAlpha(edge.from), taskAlpha(edge.to));
              if (edgeAlpha <= FADE_EPSILON) return null;
              return (
                <MapConnection
                  pending={route.pending}
                  animate={edgeIndex < 20 && !route.clipped}
                  scale={view.scale}
                  // One key per relationship identity (card cae8dfe1): the
                  // graph's edges are unique by (kind, from, to) since
                  // uniqueMapEdges, and a JSON tuple cannot collide where a
                  // dash-joined string could.
                  key={JSON.stringify([authorityScope, 'task', edge.kind, edge.from, edge.to])}
                  className={`map-edge map-edge--${edge.kind} map-edge--${edgeState(edge.to)}${route.clipped ? ' map-edge--unrouted' : ''}${hoveredId === edge.from || hoveredId === edge.to ? ' map-edge--hovered' : ''} ${paintedTaskChain ? (paintedTaskChain.has(edge.from) && paintedTaskChain.has(edge.to) ? 'map-edge--lit' : 'map-edge--dimmed') : ''}`}
                  data-edge-from={edge.from}
                  data-edge-to={edge.to}
                  onPointerEnter={() => setHoveredId(edge.from)}
                  onPointerLeave={() => setHoveredId(null)}
                  d={route.d}
                  data-route-state={route.pending ? (routing.error ? 'failed' : 'pending') : (route.clipped ? 'clipped' : 'ready')}
                  strokeDasharray={route.pending ? '3 5' : undefined}
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
                  {route.pending ? <title>{pendingRouteTitle}</title> : route.clipped ? <title>Could not be routed clear of other nodes</title> : null}
                </MapConnection>
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
              const route = routing.rows.get(JSON.stringify(['plane', tier, edge.kind, edge.from, edge.to]));
              if (!route) return null;
              return (
                <path
                  key={JSON.stringify(['plane', tier, edge.kind, edge.from, edge.to])}
                  className={`map-edge map-edge--${edge.kind} map-edge--aggregate${route.clipped ? ' map-edge--unrouted' : ''}${planeChain ? (planeChain.has(edge.from) && planeChain.has(edge.to) ? ' map-edge--lit' : ' map-edge--dimmed') : ''}`}
                  d={route.d}
                  data-route-state={route.pending ? (routing.error ? 'failed' : 'pending') : (route.clipped ? 'clipped' : 'ready')}
                  strokeDasharray={route.pending ? '3 5' : undefined}
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
                      + (route.pending ? ', ' + pendingRouteTitle : route.clipped ? ', could not be routed clear of other nodes' : '')}
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
              const route = routing.rows.get(JSON.stringify(['aggregate', edge.kind, edge.from, edge.to]));
              if (!route) return null;
              return (
                <path
                  key={JSON.stringify(['aggregate', edge.kind, edge.from, edge.to])}
                  className={`map-edge map-edge--${edge.kind} map-edge--aggregate map-edge--${aggregateEdgeState(edge.to)}${route.clipped ? ' map-edge--unrouted' : ''} ${aggregateChain ? (aggregateChain.has(edge.from) && aggregateChain.has(edge.to) ? 'map-edge--lit' : 'map-edge--dimmed') : ''}`}
                  d={route.d}
                  data-route-state={route.pending ? (routing.error ? 'failed' : 'pending') : (route.clipped ? 'clipped' : 'ready')}
                  strokeDasharray={route.pending ? '3 5' : undefined}
                  fill="none"
                  strokeWidth={Math.min(4, 1 + Math.log2(edge.multiplicity))}
                >
                  <title>
                    {(edge.multiplicity === 1
                      ? `1 ${edge.kind} link`
                      : `${edge.multiplicity} ${edge.kind} links`)
                      + (route.pending ? ', ' + pendingRouteTitle : route.clipped ? ', could not be routed clear of other nodes' : '')}
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
                const route = routing.rows.get(JSON.stringify(['aggregate-report', report.reportId, aggregateId]));
                if (!route) return null;
                return (
                  <path
                    key={JSON.stringify(['aggregate-report', report.reportId, aggregateId])}
                    // Round 10 B2: §4's "everything else dims" includes this
                    // surface. Each converging line answers for the aggregate
                    // it cites, exactly like a dependency edge answers for its
                    // endpoints.
                    className={`map-edge map-edge--knowledge map-edge--report${route.clipped ? ' map-edge--unrouted' : ''}${aggregateChain ? (aggregateChain.has(aggregateId) ? ' map-edge--lit' : ' map-edge--dimmed') : ''}`}
                    d={route.d}
                  data-route-state={route.pending ? (routing.error ? 'failed' : 'pending') : (route.clipped ? 'clipped' : 'ready')}
                  strokeDasharray={route.pending ? '3 5' : undefined}
                    fill="none"
                  >
                    {route.pending ? <title>{pendingRouteTitle}</title> : route.clipped
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
              const route = routing.rows.get(JSON.stringify(['report', pill.id]));
              if (!route) return null;
              return (
                <path
                  key={`report-${pill.id}`}
                  // Round 11 B2: round 10 brought the AGGREGATE Report surface
                  // into §4 and left this one out — the two altitudes then
                  // disagreed under the same binding rule. A per-(Report,Task)
                  // edge answers for the one Task it cites.
                  className={`map-edge map-edge--knowledge map-edge--report${route.clipped ? ' map-edge--unrouted' : ''}${paintedTaskChain ? (paintedTaskChain.has(pill.taskId) ? ' map-edge--lit' : ' map-edge--dimmed') : ''}`}
                  d={route.d}
                  data-route-state={route.pending ? (routing.error ? 'failed' : 'pending') : (route.clipped ? 'clipped' : 'ready')}
                  strokeDasharray={route.pending ? '3 5' : undefined}
                  fill="none"
                >
                  {route.pending ? <title>{pendingRouteTitle}</title> : route.clipped ? <title>Could not be routed clear of other nodes</title> : null}
                </path>
              );
            })}
            </g>
          </svg>

          {/* Report pills (§3). PLACED elements, not decorations hung off a
              tile: the layout reserved their strip, they are measured like
              every other element, and findOverlaps compares them. */}
          {/* Amendment §2/§5-A2.1 (owner ruling 2026-08-19): per-(report,
              task) pills and short local edges are the TASK altitude's
              behaviour, unchanged from the 1e0653e7 walkthrough. The
              draw-once converging form governs the aggregate altitudes. */}
          {/* Expanded's report area (card 742fae98): the Report colour family
              behind a task's Report cells, sized by N because the cells are.
              Zoomed in the Report nodes inside it are the controls; zoomed out
              it says how many Reports the task has. Ink, not a control. */}
          {drawnReportAreas.map(area => {
            const count = reportGroups.get(area.taskId)?.count ?? 0;
            return (
              <div
                key={area.id}
                className="map-report-area"
                data-report-task={area.taskId}
                data-report-count={count}
                aria-hidden="true"
                style={{
                  left: area.x, top: area.y, width: area.w, height: area.h,
                  opacity: taskAlpha(area.taskId)
                    * chainScale(paintedTaskChain, paintedTaskChain?.has(area.taskId) ?? false, CHAIN_DIM.node),
                }}
              >
                {detail.reports ? null : (
                  <span className="map-report-area-count" style={{ transform: `scale(${reportCountScale})` }}>
                    {count}
                  </span>
                )}
              </div>
            );
          })}

          {/* Collapsed (card 742fae98): ONE "Reports · N" node per task, in the
              cell the layout reserved for it. It is drawn at every band its
              task is drawn at, carries the warning tint above about ten, and
              previews the newest Reports on hover and keyboard focus without
              moving anything. It opens the task, where every Report is listed. */}
          {drawnPills.filter(pill => taskOfReportGroup(pill.reportId) !== null).map(pill => {
            const group = reportGroups.get(pill.taskId);
            const count = group?.count ?? 0;
            const taskTitle = tileById.get(pill.taskId)?.node.title ?? 'this task';
            const previewing = previewPill?.id === pill.id && Boolean(previewGroup) && !isPanning;
            return (
              <span
                key={pill.id}
                data-map-motion-id={pill.id}
                data-report-task={pill.taskId}
                className={`map-report-pill map-report-pill--group${view.organization==='organic'&&tileById.get(pill.taskId)?.node.status==='archived'?' map-archive-motion':''}${paintedTaskChain && !paintedTaskChain.has(pill.taskId) ? ' map-report-pill--dimmed' : ''}`}
                style={{
                  left: pill.x, top: pill.y,
                  transform: planeLayout?.archiveScales?.[pill.id] ? `scale(${planeLayout.archiveScales[pill.id]})` : undefined,
                  transformOrigin: 'top left',
                  opacity: taskAlpha(pill.taskId)
                    * chainScale(paintedTaskChain, paintedTaskChain?.has(pill.taskId) ?? false, CHAIN_DIM.node),
                }}
                ref={element => measure(pill.id, element, true)}
                // A DRAG IS NOT A HOVER, as for every other node on the plane.
                onPointerEnter={() => { if (!isPanning) setPreviewTaskId(pill.taskId); }}
                onPointerLeave={() => setPreviewTaskId(current => (current === pill.taskId ? null : current))}
                onFocus={() => setPreviewTaskId(pill.taskId)}
                onBlur={() => setPreviewTaskId(current => (current === pill.taskId ? null : current))}
              >
                <Button
                  variant="secondary"
                  size="compact"
                  className={`map-report-group${isHeavyReportGroup(count) ? ' map-report-group--many' : ''}`}
                  ariaLabel={`${reportGroupTitle(count)}: open ${taskTitle} to read them`}
                  ariaDescribedBy={previewing ? previewId : undefined}
                  onClick={() => { if (!isPanning) onOpenTask(pill.taskId); }}
                >
                  {detail.reports
                    ? <>Reports &middot; <span className="map-report-group-count">{count}</span></>
                    : <span className="map-report-group-count" style={{ transform: `scale(${reportCountScale})` }}>{count}</span>}
                </Button>
              </span>
            );
          })}

          {drawnPills.filter(pill => taskOfReportGroup(pill.reportId) === null).map(pill => (
            <span
              key={pill.id}
              data-map-motion-id={pill.id}
              data-report-task={pill.taskId}
              // Round 11 B2: the pill recedes with the Task it cites (§4) —
              // per-citation, because A2.1 makes the task altitude's Report
              // form per-(Report,Task), unlike the draw-once aggregate node.
              className={`map-report-pill${view.organization==='organic'&&tileById.get(pill.taskId)?.node.status==='archived'?' map-archive-motion':''}${paintedTaskChain && !paintedTaskChain.has(pill.taskId) ? ' map-report-pill--dimmed' : ''}`}
              // A pill recedes with the Task it cites — it is that Task's
              // close-zoom ink, and §4 keeps the two together.
              style={{
                left: pill.x, top: pill.y,
                transform: planeLayout?.archiveScales?.[pill.id] ? `scale(${planeLayout.archiveScales[pill.id]})` : undefined,
                transformOrigin: 'top left',
                opacity: taskAlpha(pill.taskId)
                  * chainScale(paintedTaskChain, paintedTaskChain?.has(pill.taskId) ?? false, CHAIN_DIM.node),
              }}
              ref={element => measure(pill.id, element, true)}
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
                left: continuous && own ? own.x : chip.x, top: continuous && own ? own.y : chip.y,
                maxInlineSize: continuous && own ? Math.min(220, own.w * view.scale) : (chip as any).w,
                opacity: chipAlpha * furnitureScale(own ? phaseKeyOfBand(own) : ''),
                ...(rectangular && own ? boundedHeaderStyle(own.w, view.scale) : {}),
              }}
              aria-hidden={chipAlpha < 0.5 || undefined}
              ref={continuous ? undefined : element => measure(chip.id, element)}>
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
                maxInlineSize: continuous && territory ? 220 : undefined,
                opacity: headerAlpha * furnitureScale(`project:${laneKey}`),
                ...(rectangular && territory ? boundedHeaderStyle(territory.w, view.scale) : {}) }}
              aria-hidden={headerAlpha < 0.5 || undefined}
              ref={continuous ? undefined : element => measure(lane.id, element)}>
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
            if (tierOf(tile.bandId, tile.laneId) !== 'task' || band === 'far') {
              return (
                <div
                  key={tile.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open task: ${tile.node.title}`}
                  onPointerEnter={() => { if (!isPanning) setHoveredId(tile.id); }}
                  onPointerLeave={() => setHoveredId(current => current === tile.id ? null : current)}
                  onFocus={() => setHoveredId(tile.id)}
                  onBlur={() => setHoveredId(current => current === tile.id ? null : current)}
                  onClick={() => { if (!isPanning) onOpenTask(tile.id); }}
                  onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenTask(tile.id); } }}
                  className={`map-tile map-tile--shape${view.organization === 'organic' && tile.node.status === 'archived' ? ' map-archive-motion' : ''}${paintedTaskChain ? (paintedTaskChain.has(tile.id) ? ' map-tile--lit' : ' map-tile--dimmed') : ''}`}
                  data-status={tile.node.status}
                  data-task={tile.id}
                  data-map-motion-id={tile.id}
                  style={{
                    left: tile.x, top: tile.y, height: tile.h, width:tile.w,
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
              onPointerEnter={() => { if (!isPanning) setHoveredId(tile.id); }}
              onPointerLeave={() => setHoveredId(current => (current === tile.id ? null : current))}
              onBlurCapture={() => setHoveredId(current => (current === tile.id ? null : current))}
              className={`map-tile map-tile--${band}${view.organization==='organic'&&tile.node.status==='archived'?' map-archive-motion':''} ${pulsed.has(tile.id) ? 'map-tile--pulsed' : ''} ${paintedTaskChain ? (paintedTaskChain.has(tile.id) ? 'map-tile--lit' : 'map-tile--dimmed') : ''}`}
              style={{
                left: tile.x, top: tile.y,
                transform: planeLayout?.archiveScales?.[tile.id] ? `scale(${planeLayout.archiveScales[tile.id]})` : undefined,
                transformOrigin: 'top left',
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
              ref={element => measure(tile.id, element, true)}
              data-task={tile.id}
              data-map-motion-id={tile.id}
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
              className={`map-container map-container--${entry.tier}${overviewCaptions.has(entry.id) ? ' map-container--annotated' : ''}${entry.core ? ' map-container--core' : ''}${planeStateClass(entry.facts)}${selectedId === entry.id ? ' map-container--selected' : ''}${planeChain ? (planeChain.has(entry.id) ? ' map-container--lit' : ' map-container--dimmed') : ''}`}
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
              {overviewCaptions.has(entry.id) ? <>
                <svg className="map-overview-leader" aria-hidden="true">
                  <line x1={entry.w} y1={0}
                    x2={overviewCaptions.get(entry.id)!.x - entry.x}
                    y2={overviewCaptions.get(entry.id)!.y - entry.y}
                    vectorEffect="non-scaling-stroke" />
                </svg>
                <div className="map-overview-caption"
                  title={`${entry.facts.laneLabel ? `${entry.facts.laneLabel} — ` : ''}${entry.facts.label}`}
                  style={{ left: overviewCaptions.get(entry.id)!.x - entry.x,
                    top: overviewCaptions.get(entry.id)!.y - entry.y }}>
                  <span className="map-overview-context" title={entry.facts.laneLabel}>
                    {entry.tier === 'phase' ? entry.facts.laneLabel : 'Project'}
                  </span>
                  <MapCardTitle label={entry.facts.label}
                    accessibleName={`Select ${entry.tier} ${entry.facts.label}${entry.tier === 'phase' ? ` of project ${entry.facts.laneLabel}` : ''}`}
                    selected={selectedId === entry.id}
                    onSelect={() => setSelectedId(selectedId === entry.id ? null : entry.id)} />
                </div>
              </> : <MapViewportCard
                key={`${authorityScope}:${view.organization}:${entry.id}`}
                admitted={containerCardInViewport(entry, view, viewport, CULL_MARGIN)}
                style={{ width: Math.min(cardBox.w, entry.w * view.scale),
                  maxHeight: entry.h * view.scale, overflow: 'hidden',
                  ...(rectangular ? boundedHeaderStyle(entry.w, view.scale) : {}) }}
                measure={element => measure(`card:${entry.id}`, element)}
              >
                <MapAggregateCard
                  facts={entry.facts}
                  internal={entry.internal}
                  selected={selectedId === entry.id}
                  onSelect={() => setSelectedId(
                    selectedId === entry.id ? null : entry.id)}
                />
              </MapViewportCard>}
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
          {/* The list-to-map link (card cae8dfe1): one ring, placed in the DOM
              by placeLinkRing, never a per-tile render. Ink, not a control. */}
          <div ref={linkRingRef} className="map-link-ring" aria-hidden="true" />
        </ArchiveMotionPlane>

        {hoveredId && tileById.has(hoveredId) && !isPanning && (() => {
          const tile = tileById.get(hoveredId)!;
          const left = Math.max(8, Math.min(viewport.width - 276, (tile.x + tile.w) * view.scale + view.offsetX + 12));
          const top = Math.max(8, Math.min(viewport.height - 110, tile.y * view.scale + view.offsetY));
          return <div className="map-task-preview" role="tooltip" style={{ left, top }}>
            <strong>{tile.node.title}</strong>
            <span>{tile.node.status} · {tile.node.project || 'No project'}</span>
            {tile.node.agent ? <span>{tile.node.agent}</span> : null}
            <span>Click task to open details</span>
          </div>;
        })()}

        {/* The Collapsed node's preview (card 742fae98): a screen-space
            overlay like the task preview above, never measured and never laid
            out, so a hover cannot move the plane (design 50b5e9c4). The newest
            Reports first, as the graph read lists them. */}
        {previewPill && previewGroup && !isPanning ? (
          <div
            className="map-task-preview"
            role="tooltip"
            id={previewId}
            style={{
              left: Math.max(8, Math.min(viewport.width - 276, previewPill.x * view.scale + view.offsetX)),
              top: Math.max(8, Math.min(viewport.height - 180,
                (previewPill.y + previewPill.h) * view.scale + view.offsetY + 8)),
            }}
          >
            <strong>{reportGroupTitle(previewGroup.count)}</strong>
            <ul className="map-report-preview-list">
              {previewGroup.reports.slice(0, REPORT_PREVIEW_LIMIT).map(report => (
                <li key={report.id}>{report.title}</li>
              ))}
            </ul>
            {previewGroup.count > REPORT_PREVIEW_LIMIT ? (
              <span>and {previewGroup.count - REPORT_PREVIEW_LIMIT} more; open the task to see every Report</span>
            ) : null}
          </div>
        ) : null}

        {isLoading ? <div className="map-overlay" role="status">Loading the Map…</div> : null}
        {routing.error ? <div className="map-overlay map-overlay--error" role="alert">
          {routing.error.message}<Button variant="secondary" size="compact" onClick={routing.retry}>Retry connections</Button>
        </div> : null}
        {computation.error ? <div className="map-overlay map-overlay--error" role="alert">
          {computation.error.message}<Button variant="secondary" size="compact" onClick={computation.retry}>Retry layout</Button>
        </div> : null}
        {error ? (
          <div className="map-overlay map-overlay--error" role="alert">
            {error.message}
            <Button variant="secondary" size="compact" onClick={refetch}>Retry</Button>
          </div>
        ) : null}
        {!isLoading && !error && geometryComplete && !computation.error && graph.nodes.length === 0 ? (
          <div className="map-overlay" role="status">No Tasks match the current filters.</div>
        ) : null}
      </div>

      {/* The accessible alternative (§6): same scope, same grouping, same
          open contract — reachable from the toolbar, not a hidden fallback.
          Derived from graph membership, so it is complete at every altitude. */}
      {splitActive ? (
        <div
          ref={setSeparatorElement}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the list"
          aria-controls={listId}
          aria-valuenow={split.listSize}
          aria-valuemin={split.bounds.min}
          aria-valuemax={split.bounds.max}
          tabIndex={0}
          className="map-split-separator"
          onKeyDown={split.onKeyDown}
          onPointerDown={split.onPointerDown}
          onPointerMove={split.onPointerMove}
          onPointerUp={split.onPointerUp}
          onPointerCancel={split.onPointerCancel}
        />
      ) : null}
      {treeMode || splitActive ? (
        <div
          className="map-tree"
          id={listId}
          ref={listRef}
          role={splitActive ? 'region' : undefined}
          aria-label={splitActive ? 'Task list' : undefined}
        >
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
                      <li key={node.id} data-list-task={node.id}
                        onPointerEnter={splitActive ? () => linkFromList(node.id) : undefined}
                        onPointerLeave={splitActive ? () => unlinkFromList(node.id) : undefined}
                        onFocus={splitActive ? () => linkFromList(node.id) : undefined}
                        onBlur={splitActive ? () => unlinkFromList(node.id) : undefined}>
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
