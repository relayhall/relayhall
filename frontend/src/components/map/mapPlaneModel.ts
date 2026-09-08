import {
  FALLBACK_TILE,
  FALLBACK_PILL,
  LAYOUT_METRICS,
  UNASSIGNED_LANE,
  UNPHASED_BAND,
  aggregateFactsOf,
  aggregateKeyOf,
  bandKeyOf,
  computeDepths,
  convexHull,
  laneKeyOf,
  reportsByTask,
  sizeOf,
  type AggregateFacts,
  type Box,
  type LayoutResult,
  type MapGraph,
  type MapOrganization,
  type MapPhase,
  type MapTaskNode,
  type PlacedBand,
  type PlacedBandChip,
  type PlacedContainer,
  type PlacedElement,
  type PlacedReportPill,
  type PlacedTile,
  type SizeMap,
} from './mapGraphModel';

/* ======================================================================
 * THE CONTINUOUS PLANE — amendment §2/§5-A3 ("the living map"), clauses 1,
 * 2, 3 and 6, for the HORIZONTAL organization.
 *
 * A3 supersedes the A2-era implementation in which each altitude owned its
 * own plane and a zoom crossed between them. There is now ONE world per
 * organization, treated exactly as a geographic map treats the Earth:
 *
 *   - positions of tasks, phases and projects are RETAINED at every zoom
 *     (clause 1 — "Google-Maps semantics"; sitting record 2d9e4f8a R1);
 *   - a phase's CONTAINER already sits at the truthful position and extent,
 *     so zooming out does not re-land anything: the tiles fade out in place
 *     and the container fades in as the phase tile (clause 1, R2);
 *   - the container occupies the REGION its contents occupy, so more content
 *     is visibly bigger (clause 2, R3);
 *   - phases sequence ALONG the flow axis, with unphased tasks placed in
 *     flow order between them (clause 3, R6, owner sketch 1);
 *   - a project's home survives reloads, new tasks and completions: the
 *     layout is ANCHORED, and reflow is LOCALIZED (clause 6, R1/R4).
 *
 * This module is the horizontal slice. `layoutHorizontal` in mapGraphModel
 * remains the pre-amendment engine and still serves the vertical, radial and
 * organic organizations, which keep the A2 altitude hierarchy until their own
 * slices land (A7c subtasks 3 and 4). Nothing here removes or re-decides any
 * of that; the two engines coexist and the ORGANIZATION selects between them.
 * ====================================================================== */

/* ----------------------------------------------------------------------
 * ANCHORS — what makes a position survive churn and a reload.
 *
 * A layout that recomputes every coordinate from the current data is a
 * GLOBAL recompute: one new task with a new dependency depth re-ranks the
 * columns, one new project re-sorts the lanes, and the reader's memory of
 * where things are is destroyed. Clause 6 forbids exactly that.
 *
 * So the plane keeps three anchors, and the layout is a pure function of
 * (graph, sizes, anchors):
 *
 *   laneOrder   the order lanes stack in, FIRST-SEEN rather than sorted, so
 *               a new project appends at the frontier instead of pushing the
 *               world down. (The unassigned lane keeps its §2 place last.)
 *   laneHeight  a lane's RESERVED height. It grows only when the content
 *               outgrows it, and it grows with a spare row of headroom, so
 *               the ordinary case — a task arriving in an existing lane —
 *               moves nothing at all below it.
 *   slots       every task's (segment, column, row). A task keeps its slot
 *               for as long as it stays in its segment, whatever happens to
 *               the dependency ranking around it; a task that leaves frees
 *               nothing but its own hole, and the hole is reused by the next
 *               arrival rather than closed by shuffling its neighbours up.
 *
 * The anchors a layout RETURNS are the anchors it was given plus whatever it
 * had to decide; feeding them back in reproduces the identical geometry
 * (`layoutHorizontalPlane` is a fixed point in its anchors — asserted in the
 * suite). That is what lets the caller persist them and restore the same
 * world in the next session.
 * ---------------------------------------------------------------------- */

export interface PlaneSlot {
  /** Segment key, lane-qualified: `${laneKey}\u0000${segmentKey}`. */
  seg: string;
  col: number;
  row: number;
}

export interface MapPlaneAnchors {
  version: 1;
  territories?: Readonly<Record<string, Box>>;
  /** A3 Organic homes, independent of the retired rectangular-cluster layout. */
  organicHomes?: Readonly<Record<string, Box>>;
  organicLocal?: Readonly<Record<string, Box>>;
  organicAngles?: Readonly<Record<string, number>>;
  /** Lane keys in the order they stack, first-seen. */
  laneOrder: readonly string[];
  /** Reserved lane heights, monotone. */
  laneHeight: Readonly<Record<string, number>>;
  /**
   * Reserved column widths and row heights per segment, monotone, indexed by
   * column and row. Without them a DELETION shrinks the row its tile was the
   * tallest occupant of, and every row below it in that phase slides up —
   * which is the world moving under the reader on a change that touched
   * something else entirely. Reserved geometry only ever grows, so a hole is
   * a hole and not a re-flow.
   */
  cols: Readonly<Record<string, readonly number[]>>;
  rows: Readonly<Record<string, readonly number[]>>;
  /**
   * The order the segments of a lane sit in along the flow axis, and the
   * ground each has reserved.
   *
   * ROUND-1 FINDING 1. Without these, a filter that empties a phase deleted
   * its segment, and everything to the right of it slid LEFT — the world
   * moving under a reader who had only narrowed what they were looking at.
   * Clause 7 (R8) is explicit that a filter renders "the same world with
   * fewer things in it", so a segment that has been seen keeps its place and
   * its ground whether or not anything is standing on it today. The same
   * finding applies to a whole lane, which is why `laneOrder` and
   * `laneHeight` now retain lanes that are out of scope.
   */
  segOrder: Readonly<Record<string, readonly string[]>>;
  segWidth: Readonly<Record<string, number>>;
  /**
   * The width a lane's header has reserved, monotone.
   *
   * FOUND IN THE ROUND-2 LIVE CAPTURE, and it is the same defect as finding
   * 1 wearing different clothes: the header is a MEASURED element whose
   * §1 counters are computed from the tasks in scope, so applying an
   * ordinary status filter made it narrower — and every tile in the lane
   * slid 7px left behind it. A filter must not move the work it keeps.
   */
  laneHeaderW: Readonly<Record<string, number>>;
  /** Task id → its slot on the plane. */
  slots: Readonly<Record<string, PlaneSlot>>;
}

export const EMPTY_PLANE_ANCHORS: MapPlaneAnchors = {
  version: 1, laneOrder: [], laneHeight: {}, cols: {}, rows: {},
  segOrder: {}, segWidth: {}, laneHeaderW: {}, slots: {},
};

export const PLANE_METRICS = {
  /** Gap between one segment (phase box or connector group) and the next,
   *  along the flow axis. */
  segGapX: 32,
  /** Fixed caption ground: 120 screen px at the aggregate entry (40/170).
   * Reserve it once so LOD never moves content to make room for its ink. */
  captionHeaderH: 512,
  /** Padding inside a phase box, around its tiles. Shared with the
   *  pre-amendment engine so the two read as one visual system (clause 5). */
  bandPadX: LAYOUT_METRICS.bandPadX,
  bandPadY: LAYOUT_METRICS.bandPadY,
  /**
   * The spare ground a lane takes when it has to grow.
   *
   * A reservation with no slack is no reservation at all: every arrival
   * would outgrow it and every arrival would move the lanes below. The
   * slack is GEOMETRIC — a quarter of the lane again, with a floor of three
   * tile rows for a lane too small for a quarter to mean anything — so the
   * ordinary churn of a working estate is free, and the number of growth
   * events over a project life is logarithmic in its size rather than
   * proportional to the tasks that ever passed through it.
   *
   * The price is visible: a lane paints its content and reserves up to a
   * quarter again below it, which reads as air between projects. That is the
   * cost of clause 6, and it is paid deliberately.
   */
  laneHeadroomRows: 3,
  laneHeadroomRatio: 0.25,
  /** One tile row, the unit the headroom floor counts in. */
  rowUnitY: FALLBACK_TILE.h + LAYOUT_METRICS.tileGapY,
  /** Reserved heights round up to this, so lane origins sit on the estate's
   *  8px rhythm rather than on whatever a measured tile happened to be. */
  laneQuantumY: 8,
  /**
   * The lane header's COLUMN — a declared width, not a measured one.
   *
   * Round 2, live: the header renders the §1 counters for the tasks IN
   * SCOPE, so an ordinary status filter made one header 50px wider (a stuck
   * count appearing) and that lane's whole content shifted right behind it.
   * Measured widths are right for a box that must not be under-reserved;
   * they are wrong for a POSITION every other element is measured from,
   * because then the position inherits every wobble in the data.
   *
   * So the header gets a column, the stylesheet keeps the header inside it,
   * and every lane's work starts on the same axis. 220px is the §7 width
   * the aggregate card already uses, so the plane has one column measure
   * rather than two.
   */
  laneHeaderW: 220,
  /**
   * The width a Report pill's strip RESERVES before the pill has measured.
   *
   * Rule 1 says a too-large fallback spreads the layout and self-corrects on
   * the measured pass — which is true of an engine that recomputes, and NOT
   * true here: this plane's reservations are monotone, so a fallback that is
   * too SMALL grows the column on the pass where the pill first measures and
   * pushes every later segment in that lane along with it. Round 2 measured
   * exactly that: one phase box growing 94px and the tile beyond it moving.
   *
   * FALLBACK_PILL.w is 44 — the mobile touch floor, the smallest the control
   * can paint. The reservation is the LARGEST it paints, measured at 86 on
   * the portal, rounded up to the estate's 8px rhythm with a little room.
   */
  pillReserveW: 96,
  /**
   * THE RESERVATION RULE — a reservation is a DECLARED CEILING, never a
   * measured box. Round 2 found the class the +94px filter residual belongs
   * to, and it is not any one element.
   *
   * The size map is not a property of the data: it is a property of what has
   * been MOUNTED. Tiles report their boxes as culling admits them, so the map
   * grows through a session, and which elements are in it depends on the
   * viewport, on where the reader has panned — and on the FILTER. A plane
   * whose reservations are monotone turns any late-arriving measurement into
   * a permanent shove: the engine probe on the parent commit reproduced the
   * live number exactly, one tile measuring for the first time growing a
   * segment from w=202 to w=296 and moving the tile beyond it +94px, with
   * the node set, the anchors and the filter all held constant.
   *
   * So the lattice is DECLARED and the stylesheet holds every element inside
   * its cell (`.map-tile`, `.map-band-chip`, `.map-report-pill` and
   * `.map-lane-header` each carry the matching bound). Measurement still
   * decides INK — a tile's own painted box, the container card's fit — and
   * decides no coordinate at all. This is the lane header's ratified
   * argument (`laneHeaderW` below) applied to the whole plane rather than to
   * the one element that had been caught.
   *
   * Every number here is MEASURED on the 5,023-task portal at all four
   * detail bands and then rounded UP to the estate's 8px rhythm, so the
   * ceiling has headroom over the widest and tallest the control paints.
   */
  /** The tile column. The stylesheet pins `.map-tile` at this width already —
   *  "a design constant the layout engine also assumes" (MapView.css §1). */
  tileCellW: FALLBACK_TILE.w,
  /** The tile row. Live: 81..108 at every band; `.map-tile` is capped here. */
  tileCellH: 128,
  /**
    * The chip's strip. Live: 25 at every band; `.map-band-chip` is capped
    * here. The chip has no declared COLUMN, because it does not need one:
    * it is held inside the band it labels (see the band below), so its
    * width is the band's and the band's is its contents'.
    */
  chipCellH: 32,
  /** The Report pill's cell. Live: 36x36, with a 44px mobile touch floor. */
  pillReserveH: 48,
  /**
   * The lane header's ROW. The column (`laneHeaderW`) was declared in round
   * 2's first pass and its height was left measured — and the height is a
   * coordinate too: it sets the lane's painted bottom, so the lane below
   * moves when it changes. Live it is 66 for every lane at every band, and
   * the fallback the engine used when a header had not reported was 56, so
   * the first measurement of the first header pushed every lane under it
   * down by ten. `.map-lane-header` is capped here.
   */
  laneHeaderH: 88,
} as const;

/**
 * Cap on how many slot anchors are carried. See `pruneAnchors`.
 *
 * MEASURED, not guessed: the record for the 5,023-task portal serialises to
 * 692 KB, so a slot costs about 138 bytes of the origin's localStorage. The
 * cap is set where the record cannot reach a third of a 5 MB quota it shares
 * with the auth token and the view — a Map that quietly fills the origin's
 * storage would break surfaces that have nothing to do with it.
 */
export const MAX_SLOT_ANCHORS = 12000;

const quantize = (value: number, step: number) => Math.ceil(value / step) * step;

const segKeyOf = (laneKey: string, segment: string) => `${laneKey}\u0000${segment}`;

/**
 * Stable ordering for the phases inside a lane: the DECLARED order, which
 * clause 3 makes the flow axis's order and which is therefore authoritative
 * rather than anchorable. A phase inserted in the middle moves the phases
 * after it — inside ITS LANE only, which is the localized reflow clause 6
 * allows, not the global shuffle it forbids.
 */
const byPositionThenName = (a: MapPhase, b: MapPhase) =>
  a.position - b.position || a.name.localeCompare(b.name);

/* ----------------------------------------------------------------------
 * SEGMENTS — clause 3's flow axis.
 *
 * Inside a lane the phases sit left→right in declared order. An unphased
 * task is a CONNECTOR (owner sketch 1: "unphased connector tasks between
 * phase boxes"), and its place in the flow is decided by its dependency
 * depth against the phases' own depth ranges: it sits after every phase
 * whose work is entirely upstream of it. A task upstream of everything
 * leads the lane; a task downstream of everything trails it.
 * ---------------------------------------------------------------------- */

export interface PlaneSegment {
  /** Lane-local key: `phase:<phaseId>` or `gap:<index>`. */
  key: string;
  kind: 'phase' | 'connector';
  /** Present for a phase segment. */
  phase: MapPhase | null;
  /** The synthetic band key this segment groups by, for ids and labels. */
  bandKey: string;
  label: string;
  nodes: MapTaskNode[];
}

/**
 * The segments of ONE lane, in flow order.
 *
 * `phases` is the phase list DECLARED for this lane's project, not the
 * estate's. Every one of them is a segment whether or not it currently holds
 * a task: clause 3 says "the phases sit left→right in declared order", and a
 * phase that is merely empty today has not stopped being declared
 * (round-1 finding 6).
 *
 * CONNECTOR PRECEDENCE (round-1 D2). An unphased task sits after the longest
 * PREFIX of phases whose work is entirely upstream of it — the walk stops at
 * the first phase that is not, rather than counting every phase that is.
 * Declared order therefore always wins over depth: a connector can never be
 * placed after a phase that is drawn to its left. The alternative — counting
 * matches anywhere in the sequence — can put a connector between two phases
 * whose depths are not monotone, which reads as a break in the flow.
 */
export function planeSegments(
  laneNodes: readonly MapTaskNode[],
  phases: readonly MapPhase[],
  depths: ReadonlyMap<string, number>,
  /**
   * The connector gap a task is already standing in, if the record knows
   * one. A task's PHASE is declared data and a change to it should move the
   * task; a connector's gap is DERIVED from the depths around it, so a
   * filter that hides its upstream work would otherwise move a task nobody
   * touched — measured live as one connector jumping 94px under an ordinary
   * status filter. Derived placement is anchored; declared placement is not.
   */
  anchoredGap?: (node: MapTaskNode) => number | null,
): PlaneSegment[] {
  const phaseById = new Map(phases.map(phase => [phase.id, phase]));
  const byBand = new Map<string, MapTaskNode[]>();
  for (const node of laneNodes) {
    const key = bandKeyOf(node);
    const list = byBand.get(key);
    if (list) list.push(node); else byBand.set(key, [node]);
  }

  const phaseKeys = new Set<string>(phases.map(phase => phase.id));
  for (const key of byBand.keys()) if (key !== UNPHASED_BAND) phaseKeys.add(key);
  const presentPhases = [...phaseKeys]
    .map((key): MapPhase => phaseById.get(key) ?? ({
      // A phase id the phase list does not carry is still a real grouping —
      // it is drawn under its id rather than dropped, exactly as the
      // pre-amendment engine does.
      id: key, name: key, position: Number.MAX_SAFE_INTEGER, goal: null, projectId: '',
    }))
    .sort(byPositionThenName);

  // The deepest task each phase owns: the boundary a connector is compared
  // against. A phase with no depth information contributes -1, so it never
  // pushes a connector past itself on no evidence.
  const phaseMaxDepth = presentPhases.map(phase => {
    const nodes = byBand.get(phase.id) ?? [];
    let max = -1;
    for (const node of nodes) max = Math.max(max, depths.get(node.id) ?? 0);
    return max;
  });

  const gaps = new Map<number, MapTaskNode[]>();
  for (const node of byBand.get(UNPHASED_BAND) ?? []) {
    const held = anchoredGap ? anchoredGap(node) : null;
    let index = held;
    if (index === null) {
      const depth = depths.get(node.id) ?? 0;
      index = 0;
      while (index < phaseMaxDepth.length && phaseMaxDepth[index] < depth) index += 1;
    }
    const list = gaps.get(index);
    if (list) list.push(node); else gaps.set(index, [node]);
  }

  const segments: PlaneSegment[] = [];
  for (let index = 0; index <= presentPhases.length; index += 1) {
    const connectors = gaps.get(index);
    if (connectors && connectors.length > 0) {
      segments.push({
        key: `gap:${index}`, kind: 'connector', phase: null,
        bandKey: UNPHASED_BAND, label: 'No phase', nodes: connectors,
      });
    }
    const phase = presentPhases[index];
    if (phase) {
      segments.push({
        key: `phase:${phase.id}`, kind: 'phase', phase,
        bandKey: phase.id, label: phase.name, nodes: byBand.get(phase.id) ?? [],
      });
    }
  }
  return segments;
}

/* ----------------------------------------------------------------------
 * SLOTS — clause 6's anchoring, at the tile.
 * ---------------------------------------------------------------------- */

/**
 * The column a task takes when it has no anchor yet: the dense rank of its
 * lane-wide dependency depth among the depths present in ITS SEGMENT. Dense
 * rather than absolute so a phase whose work all sits at depth 40 does not
 * open forty empty columns.
 */
function canonicalColumns(
  nodes: readonly MapTaskNode[],
  depths: ReadonlyMap<string, number>,
): Map<string, number> {
  const distinct = [...new Set(nodes.map(node => depths.get(node.id) ?? 0))].sort((a, b) => a - b);
  const rank = new Map<number, number>(distinct.map((depth, index) => [depth, index]));
  const columns = new Map<string, number>();
  for (const node of nodes) columns.set(node.id, rank.get(depths.get(node.id) ?? 0) ?? 0);
  return columns;
}

/**
 * Assign every node in a segment a (col, row), honouring the anchors.
 *
 * An anchored task keeps its slot even if the dependency ranking around it
 * has moved on: stability outranks re-sorting, which is the whole of clause
 * 6. An unanchored task takes its canonical column and the LOWEST FREE ROW
 * in it — so a hole left by a departed task is filled rather than closed,
 * and no neighbour is asked to move.
 */
export function assignSlots(
  segment: string,
  nodes: readonly MapTaskNode[],
  depths: ReadonlyMap<string, number>,
  anchors: MapPlaneAnchors,
): Map<string, { col: number; row: number }> {
  const assigned = new Map<string, { col: number; row: number }>();
  const taken = new Set<string>();
  const pending: MapTaskNode[] = [];

  for (const node of nodes) {
    const anchor = anchors.slots[node.id];
    if (anchor && anchor.seg === segment
      && Number.isInteger(anchor.col) && anchor.col >= 0
      && Number.isInteger(anchor.row) && anchor.row >= 0
      && !taken.has(`${anchor.col}:${anchor.row}`)) {
      assigned.set(node.id, { col: anchor.col, row: anchor.row });
      taken.add(`${anchor.col}:${anchor.row}`);
      continue;
    }
    pending.push(node);
  }

  // Deterministic arrival order, the same one the pre-amendment engine sorts
  // a column by: identical input therefore lays out identically.
  pending.sort((a, b) => a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id));
  const columns = canonicalColumns(nodes, depths);
  for (const node of pending) {
    const col = columns.get(node.id) ?? 0;
    let row = 0;
    while (taken.has(`${col}:${row}`)) row += 1;
    assigned.set(node.id, { col, row });
    taken.add(`${col}:${row}`);
  }
  return assigned;
}

/* ----------------------------------------------------------------------
 * THE LAYOUT
 * ---------------------------------------------------------------------- */

export const ORGANIC_CORE = '\u0000organic-archive-core';

/** Placement membership only: original task records remain the tile payloads. */
export function organicPlaneGraph(graph: MapGraph): MapGraph {
  return { ...graph, nodes: graph.nodes.map(node => node.status === 'archived'
    ? { ...node, project: ORGANIC_CORE, phaseId: null } : node) };
}

export interface OrganicRegion {
  laneId: string;
  core: boolean;
  box: Box;
  clusters: ReadonlyArray<Box & { phaseId?: string; facts?: AggregateFacts; outline?: string }>;
  captionBox?: Box;
  outline?: string;
  branches: ReadonlyArray<readonly [number, number, number, number]>;
}

export interface PlaneLayoutResult extends LayoutResult {
  organicRegions?: readonly OrganicRegion[];
  /** The anchors this layout decided. Feed them back and nothing moves. */
  anchors: MapPlaneAnchors;
}

/**
 * Report cells occupy a transverse strip above a Horizontal task (left of a
 * Vertical task after transposition). Reservations depend on count, never
 * measured icon size, so measurement cannot move neighbouring tasks.
 */
const cellWidth = (pills: ReadonlyArray<{ id: string }>) =>
  Math.max(PLANE_METRICS.tileCellW, pills.length * (PLANE_METRICS.pillReserveW + LAYOUT_METRICS.pillGapY) - LAYOUT_METRICS.pillGapY);
const cellHeight = (pills: ReadonlyArray<{ id: string }>) =>
  PLANE_METRICS.tileCellH + (pills.length ? PLANE_METRICS.pillReserveH + LAYOUT_METRICS.pillGapX : 0);

export function layoutHorizontalPlane(
  graph: MapGraph,
  sizes: SizeMap,
  anchors: MapPlaneAnchors = EMPTY_PLANE_ANCHORS,
  vertical = false,
): PlaneLayoutResult {
  const metrics = LAYOUT_METRICS;
  const plane = vertical ? { ...PLANE_METRICS,
    tileCellW: PLANE_METRICS.tileCellH, tileCellH: PLANE_METRICS.tileCellW,
    pillReserveW: PLANE_METRICS.pillReserveH, pillReserveH: PLANE_METRICS.pillReserveW,
    laneHeaderW: PLANE_METRICS.captionHeaderH, laneHeaderH: PLANE_METRICS.laneHeaderW,
  } : PLANE_METRICS;
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const pillsByTask = reportsByTask(graph.reports, nodeIds);

  const lanes = new Map<string, MapTaskNode[]>();
  for (const node of graph.nodes) {
    const key = laneKeyOf(node);
    const list = lanes.get(key);
    if (list) list.push(node); else lanes.set(key, [node]);
  }

  // Lane order: the anchored first-seen order, INCLUDING lanes that are out
  // of scope right now (round-1 finding 1). A filter is not a deletion —
  // clause 7 says the map renders the same world with fewer things in it —
  // so a lane that has been seen keeps its place and its ground, and lifting
  // the filter puts it back where it was instead of at the frontier.
  const anchoredLanes = anchors.laneOrder.filter(key => key !== UNASSIGNED_LANE);
  const fresh = [...lanes.keys()]
    .filter(key => key !== UNASSIGNED_LANE && !anchoredLanes.includes(key))
    .sort((a, b) => a.localeCompare(b));
  const hasUnassigned = lanes.has(UNASSIGNED_LANE)
    || typeof anchors.laneHeight[UNASSIGNED_LANE] === 'number';
  const laneKeys = [
    ...anchoredLanes, ...fresh, ...(hasUnassigned ? [UNASSIGNED_LANE] : []),
  ];

  // Which lane a DECLARED phase belongs to. The wire keys a lane by project
  // NAME and a phase by project ID, so the mapping is derived from the nodes
  // that carry both — the only place both appear.
  const phaseById = new Map(graph.phases.map(phase => [phase.id, phase]));
  const laneOfProjectId = new Map<string, string>();
  for (const node of graph.nodes) {
    const phase = node.phaseId ? phaseById.get(node.phaseId) : undefined;
    if (phase && !laneOfProjectId.has(phase.projectId)) {
      laneOfProjectId.set(phase.projectId, laneKeyOf(node));
    }
  }
  const phasesByLane = new Map<string, MapPhase[]>();
  for (const phase of graph.phases) {
    const lane = laneOfProjectId.get(phase.projectId);
    if (lane === undefined) continue;
    const list = phasesByLane.get(lane);
    if (list) list.push(phase); else phasesByLane.set(lane, [phase]);
  }

  const elements: PlacedElement[] = [];
  const nextSlots: Record<string, PlaneSlot> = { ...anchors.slots };
  const nextHeights: Record<string, number> = { ...anchors.laneHeight };
  const nextCols: Record<string, number[]> = {};
  const nextRows: Record<string, number[]> = {};
  const nextSegOrder: Record<string, string[]> = {};
  const nextSegWidth: Record<string, number> = { ...anchors.segWidth };
  const nextHeaderW: Record<string, number> = { ...anchors.laneHeaderW };

  // Annotated: LAYOUT_METRICS is `as const`, so `metrics.originX` has the
  // literal type 32 and an inferred cursor could never be reassigned.
  let cursorY: number = metrics.originY;
  let maxRight: number = metrics.originX;

  for (const laneKey of laneKeys) {
    const laneNodes = lanes.get(laneKey) ?? [];
    const heldHeight = anchors.laneHeight[laneKey];

    // OUT OF SCOPE, not gone. Its ground is held so the lanes below it do
    // not move, and nothing at all is drawn on it.
    if (laneNodes.length === 0) {
      if (typeof heldHeight === 'number' && Number.isFinite(heldHeight)) {
        nextHeights[laneKey] = heldHeight;
        const heldOrder = anchors.segOrder[laneKey];
        if (heldOrder) nextSegOrder[laneKey] = [...heldOrder];
        cursorY = cursorY + heldHeight + metrics.laneGapY;
      }
      continue;
    }

    const laneLabel = laneKey === UNASSIGNED_LANE ? 'No project' : laneKey;
    const laneTop = cursorY;
    // The lane's content origin is a DECLARED COLUMN, not a measurement. The
    // measured width used to sit in this max "as a backstop"; round 2 showed
    // that a backstop reading the size map IS the defect — it is the one
    // input that changes when the filter changes what is mounted. The
    // stylesheet holds the header inside the column (`inline-size: 220px`),
    // so the backstop was measuring a constant it could only get wrong.
    // The anchored width stays: it is the monotone record, and it is now
    // written from declared values only.
    const headerW = Math.max(
      plane.laneHeaderW, anchors.laneHeaderW[laneKey] ?? 0);
    nextHeaderW[laneKey] = headerW;
    const laneContentX = metrics.originX + headerW + metrics.laneHeaderGapX;

    // §2, unchanged by A3: topology is computed WITHIN THE PROJECT, so a
    // dependency crossing a phase boundary still drives the flow.
    const depths = computeDepths(laneNodes.map(node => node.id), graph.edges);
    const canonical = planeSegments(
      laneNodes, phasesByLane.get(laneKey) ?? [], depths,
      node => {
        const held = anchors.slots[node.id];
        if (!held) return null;
        const prefix = `${laneKey}\u0000gap:`;
        if (!held.seg.startsWith(prefix)) return null;
        const index = Number(held.seg.slice(prefix.length));
        return Number.isInteger(index) && index >= 0 ? index : null;
      });
    const canonicalByKey = new Map(canonical.map(segment => [segment.key, segment]));

    // The anchored order wins, and anything new is inserted where the
    // canonical order says it belongs — after the last canonical predecessor
    // already on the plane. So a phase declared into the middle of a
    // sequence lands in the middle, and a phase that has merely gone out of
    // scope keeps its place until the record itself is pruned.
    const order = [...(anchors.segOrder[laneKey] ?? [])];
    for (let index = 0; index < canonical.length; index += 1) {
      const key = canonical[index].key;
      if (order.includes(key)) continue;
      let at = order.length;
      for (let back = index - 1; back >= 0; back -= 1) {
        const seen = order.indexOf(canonical[back].key);
        if (seen >= 0) { at = seen + 1; break; }
      }
      order.splice(at, 0, key);
    }
    nextSegOrder[laneKey] = order;

    /** A segment the record remembers but the current scope does not fill. */
    const heldSegment = (key: string): PlaneSegment => {
      if (key.startsWith('phase:')) {
        const id = key.slice('phase:'.length);
        const phase = phaseById.get(id) ?? null;
        return {
          key, kind: 'phase', phase, bandKey: id,
          label: phase ? phase.name : id, nodes: [],
        };
      }
      return {
        key, kind: 'connector', phase: null,
        bandKey: UNPHASED_BAND, label: 'No phase', nodes: [],
      };
    };
    const segments = order.map(key => canonicalByKey.get(key) ?? heldSegment(key));

    // One header strip for the whole lane, sized from the tallest chip in
    // it, so rows line up ACROSS segments: a connector between two phase
    // boxes sits on the same row grid as the tasks it connects.
    let headerH = 0;
    for (const segment of segments) {
      if (segment.kind !== 'phase') continue;
      // DECLARED, like every other reservation: a measured chip height put
      // this lane's first tile row — and therefore every row under it — at
      // the mercy of which chips had reported by then.
      headerH = Math.max(headerH, Math.max(metrics.bandHeaderMinH, plane.chipCellH));
    }
    const phaseTop = laneTop + (vertical ? 0 : plane.captionHeaderH);
    const contentTop = phaseTop + (vertical ? 0 : Math.max(headerH, plane.captionHeaderH));

    let segX = laneContentX;
    let laneBottom = contentTop;
    let laneRight = laneContentX;

    for (const segment of segments) {
      const segment_ = segKeyOf(laneKey, segment.key);
      const slots = assignSlots(segment_, segment.nodes, depths, anchors);
      for (const node of segment.nodes) {
        const slot = slots.get(node.id)!;
        nextSlots[node.id] = { seg: segment_, col: slot.col, row: slot.row };
      }

      // Column widths and row heights are the DECLARED cells its occupants
      // reserve, merged with what this segment has already reserved. The
      // merge is a MAX and the extent never shrinks, so a hole keeps its
      // column open instead of collapsing it onto its neighbours, and a
      // departed tall tile does not pull the rows under it upward.
      //
      // These were the MEASURED occupants until round 2. A cell that reads
      // the size map is a cell that grows when a tile is measured for the
      // first time, and a filter decides which tiles that is — so narrowing
      // the scope moved work that the filter had kept. The cell depends on
      // the task's pill COUNT and on nothing else that a render can change.
      const wantCol = new Map<number, number>();
      const wantRow = new Map<number, number>();
      const heldCols = anchors.cols[segment_] ?? [];
      const heldRows = anchors.rows[segment_] ?? [];
      let maxCol = heldCols.length - 1;
      let maxRow = heldRows.length - 1;
      for (const node of segment.nodes) {
        const slot = slots.get(node.id)!;
        const pills = pillsByTask.get(node.id) ?? [];
        maxCol = Math.max(maxCol, slot.col);
        maxRow = Math.max(maxRow, slot.row);
        wantCol.set(slot.col, Math.max(
          wantCol.get(slot.col) ?? 0, vertical
            ? Math.max(plane.tileCellW, pills.length * (plane.pillReserveW + metrics.pillGapY) - metrics.pillGapY)
            : cellWidth(pills)));
        wantRow.set(slot.row, Math.max(
          wantRow.get(slot.row) ?? 0, vertical
            ? plane.tileCellH + (pills.length ? plane.pillReserveH + metrics.pillGapX : 0)
            : cellHeight(pills)));
      }
      const colWidth: number[] = [];
      for (let col = 0; col <= maxCol; col += 1) {
        colWidth.push(Math.max(
          plane.tileCellW, heldCols[col] ?? 0, wantCol.get(col) ?? 0));
      }
      const rowHeight: number[] = [];
      for (let row = 0; row <= maxRow; row += 1) {
        rowHeight.push(Math.max(
          plane.tileCellH, heldRows[row] ?? 0, wantRow.get(row) ?? 0));
      }
      nextCols[segment_] = colWidth;
      nextRows[segment_] = rowHeight;

      const padX = segment.kind === 'phase' ? plane.bandPadX : 0;
      const padY = segment.kind === 'phase' ? plane.bandPadY : 0;
      const colX = new Map<number, number>();
      let cursorX = segX + padX + (vertical && segment.kind === 'phase' ? plane.captionHeaderH : 0);
      for (let col = 0; col <= maxCol; col += 1) {
        colX.set(col, cursorX);
        cursorX += colWidth[col] + metrics.tileGapX;
      }
      const rowY = new Map<number, number>();
      let rowCursor = contentTop + padY;
      for (let row = 0; row <= maxRow; row += 1) {
        rowY.set(row, rowCursor);
        rowCursor += rowHeight[row] + metrics.tileGapY;
      }

      const tiles: PlacedTile[] = [];
      const pillElements: PlacedReportPill[] = [];
      for (const node of segment.nodes) {
        const slot = slots.get(node.id)!;
        // The tile's own painted box is still MEASURED: it is ink, not a
        // coordinate, and the §2 overlap oracle should see the card the
        // reader sees rather than the cell it stands in.
        const measured = sizeOf(node.id, sizes, FALLBACK_TILE);
        const size = vertical ? { w: measured.h, h: measured.w } : measured;
        const x = colX.get(slot.col)!;
        const cellY = rowY.get(slot.row)!;
        const y = cellY + ((pillsByTask.get(node.id)?.length ?? 0) > 0
          ? plane.pillReserveH + metrics.pillGapX : 0);
        tiles.push({
          kind: 'tile', id: node.id, node, depth: depths.get(node.id) ?? 0,
          x, y, w: size.w, h: size.h,
          // Membership is RECORDED here, not searched for later. The fade
          // needs to know which container each tile answers to, and deciding
          // that by testing every tile against every band box is a quadratic
          // pass over the estate — the exact shape the performance guard on
          // this card forbids. The layout already knows.
          laneId: laneKey,
          bandId: segment.kind === 'phase'
            ? `band:${laneKey}:${segment.bandKey}`
            : null,
        });
        let pillX = x;
        for (const report of pillsByTask.get(node.id) ?? []) {
          const pillId = `pill:${report.id}:${node.id}`;
          const measuredPill=sizeOf(pillId,sizes,FALLBACK_PILL);
          const pillSize=vertical?{w:measuredPill.h,h:measuredPill.w}:measuredPill;
          // Each icon has a fixed slot above its task; its measured box
          // supplies the visible connector endpoint, not the cell reserve.
          pillElements.push({
            kind: 'pill', id: pillId, reportId: report.id, title: report.title,
            taskId: node.id,
            x: pillX, y: cellY,
            w: Math.min(plane.pillReserveW,pillSize.w), h: Math.min(plane.pillReserveH,pillSize.h),
          });
          pillX += plane.pillReserveW + metrics.pillGapY;
        }
      }

      // The extent is the RESERVED lattice, not merely the occupied part of
      // it: a trailing row that empties keeps its ground, so nothing to the
      // right of this segment moves because a task was completed and
      // archived out of scope.
      // The pills are INSIDE the lattice now — their strip is part of the
      // cell their task reserves — so the extent is the reserved lattice and
      // nothing else. Taking a max over the pill boxes here is what let a
      // measured pill reach past the column that was supposed to contain it.
      const contentRight = maxCol >= 0
        ? colX.get(maxCol)! + colWidth[maxCol]
        : segX + padX;
      const contentBottom = maxRow >= 0
        ? rowY.get(maxRow)! + rowHeight[maxRow]
        : contentTop + padY;

      if (segment.kind === 'phase') {
        const chipId = `chip:band:${laneKey}:${segment.bandKey}`;
        // Clause 2: the container occupies the REGION its contents occupy.
        // Its box is derived from the tiles, never assumed — which is what
        // makes it the honest picture of scope when it becomes the phase
        // tile. The RESERVED width is monotone, so a segment emptied by a
        // filter keeps the ground the segments to its right are standing
        // beside (round-1 finding 1).
        //
        // THE CHIP IS NOT IN THIS. It used to be — the box was widened to
        // contain its label — and that is the live +94px, measured on the
        // portal and named here so it cannot come back: a status filter
        // changes the estate's extent, the fit changes the scale, the scale
        // crosses a §5 detail band, the chip's goal line expands, the chip
        // measures 265 instead of 107, and the phase box grows from 202 to
        // 297 with the tile beyond it moving 95. Five steps from "the reader
        // narrowed what they were looking at" to "the world moved". A
        // container is its CONTENTS' region (clause 2); the label it carries
        // is held inside that region rather than allowed to set it.
        const right = contentRight;
        const reservedW = Math.max(
          anchors.segWidth[segment_] ?? 0, right + padX - segX);
        nextSegWidth[segment_] = reservedW;
        const band: PlacedBand = {
          kind: 'band',
          id: `band:${laneKey}:${segment.bandKey}`,
          label: segment.label,
          goal: segment.phase ? segment.phase.goal : null,
          laneId: laneKey,
          x: segX,
          y: phaseTop,
          w: reservedW,
          h: contentBottom + padY - phaseTop,
          facts: aggregateFactsOf(segment.nodes),
          laneLabel,
        };
        // The chip's CELL is the band's inner width: it is the phase's
        // label, and a label is drawn inside the thing it labels. The
        // stylesheet ellipsizes the name and contracts the goal within it,
        // and the container card carries both in full at the altitude where
        // the chip has faded out. The narrowest a band can ever be is one
        // tile column and its padding, so a chip is never given less than a
        // tile's worth of room.
        const chip: PlacedBandChip = {
          kind: 'chip', id: chipId, label: band.label, goal: band.goal, bandId: band.id,
          x: band.x + padX,
          y: band.y,
          w: Math.max(0, band.w - 2 * padX), h: plane.chipCellH,
        };
        elements.push(band, chip);
        segX = band.x + band.w + plane.segGapX;
        laneRight = Math.max(laneRight, band.x + band.w);
        laneBottom = Math.max(laneBottom, band.y + band.h);
      } else {
        const reservedW = Math.max(
          anchors.segWidth[segment_] ?? 0, contentRight - segX);
        nextSegWidth[segment_] = reservedW;
        segX = segX + reservedW + plane.segGapX;
        laneRight = Math.max(laneRight, segX - plane.segGapX);
        laneBottom = Math.max(laneBottom, contentBottom);
      }
      elements.push(...tiles, ...pillElements);
    }

    // The lane header is TOP-ALIGNED, not centred on the band stack: a
    // centred header moves whenever the lane's tallest content changes, and
    // clause 6 makes a project's furniture staying put the point.
    elements.push({
      kind: 'lane',
      id: `lane:${laneKey}`,
      label: laneLabel,
      taskCount: laneNodes.length,
      completed: laneNodes.filter(node => node.status === 'completed').length,
      agentsLive: laneNodes.filter(node => Boolean(node.agent)).length,
      stuck: laneNodes.filter(node => node.status === 'stuck').length,
      upNext: laneNodes.filter(
        node => node.status === 'todo' || node.status === 'ideas').length,
      progress: aggregateFactsOf(laneNodes).progress,
      x: metrics.originX,
      y: laneTop,
      w: headerW,
      h: plane.laneHeaderH,
    });

    const paintedBottom = Math.max(laneBottom, laneTop + plane.laneHeaderH);
    const contentH = paintedBottom - laneTop;

    // The PROJECT container: the region the lane's contents occupy, header
    // included, so the project tile at altitude stands exactly where the
    // project's work stands (clauses 1 and 2).
    const container: PlacedContainer = {
      kind: 'container',
      id: `container:${laneKey}`,
      tier: 'project',
      laneId: laneKey,
      label: laneLabel,
      laneLabel,
      x: metrics.originX,
      y: laneTop,
      w: Math.max(laneRight, metrics.originX + headerW) - metrics.originX,
      h: contentH,
      facts: aggregateFactsOf(laneNodes),
      taskIds: laneNodes.map(node => node.id),
    };
    elements.push(container);

    // RESERVED height. It grows only when the content has outgrown it, and
    // when it grows it takes a spare row with it — so the next arrival is
    // free. This is the whole of "a project's home survives new tasks".
    const anchored = nextHeights[laneKey];
    const reserved = (typeof anchored === 'number' && Number.isFinite(anchored)
      && anchored >= contentH)
      ? anchored
      : quantize(contentH + Math.max(
        plane.laneHeadroomRows * plane.rowUnitY, contentH * plane.laneHeadroomRatio,
      ), plane.laneQuantumY);
    nextHeights[laneKey] = reserved;

    maxRight = Math.max(maxRight, laneRight);
    cursorY = laneTop + reserved + metrics.laneGapY;
  }

  return {
    elements,
    width: maxRight + metrics.originX,
    height: Math.max(metrics.originY, cursorY - metrics.laneGapY + metrics.originY),
    anchors: {
      version: 1,
      ...(anchors.territories ? { territories: anchors.territories } : {}),
      laneOrder: laneKeys.filter(key => key !== UNASSIGNED_LANE),
      laneHeight: nextHeights,
      // Segments absent from THIS layout keep their reservation: a phase
      // hidden by a filter (clause 7) must find its own ground again when
      // the filter lifts.
      cols: { ...anchors.cols, ...nextCols },
      rows: { ...anchors.rows, ...nextRows },
      segOrder: { ...anchors.segOrder, ...nextSegOrder },
      segWidth: nextSegWidth,
      laneHeaderW: nextHeaderW,
      slots: nextSlots,
    },
  };
}

/* ----------------------------------------------------------------------
 * PERSISTENCE — clause 6's "stability holds across sessions".
 * ---------------------------------------------------------------------- */

/** The record's serialized size, which is what the quota actually measures. */
export const anchorBytes = (anchors: MapPlaneAnchors) => JSON.stringify(anchors).length;

/**
 * The largest record this Map will try to persist.
 *
 * MEASURED: the 5,023-task portal serialises to 692 KB. The budget is set
 * where the record cannot take a third of a 5 MB origin quota it shares with
 * the auth token and the view — a Map that quietly fills the origin's
 * storage would break surfaces that have nothing to do with it.
 */
export const MAX_ANCHOR_BYTES = 1_500_000;

const pick = <T>(source: Readonly<Record<string, T>>, keep: ReadonlySet<string>) => {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(source)) if (keep.has(key)) out[key] = value;
  return out;
};

/**
 * Bound the record, giving up what is already out of scope FIRST.
 *
 * Anchors for tasks the graph no longer carries are kept on purpose: clause
 * 7 (R8) says a filter scopes the world and "the map renders the same world
 * with fewer things in it", so a filtered-out task must find its own place
 * again when the filter lifts. But "kept on purpose" is not "kept for ever":
 * round-1 finding 5 showed the previous version was not a cap at all — it
 * returned every present slot however many there were, and it never looked
 * at the lane and segment records, which grow on their own.
 *
 * So this is a real bound, applied in three stages, each giving up strictly
 * less useful memory than the last:
 *
 *   1. the slot count is capped — absent tasks lose their slot first, and
 *      only then do present ones, in a deterministic order;
 *   2. if the record still exceeds the BYTE budget, everything the current
 *      scope is not standing on goes: absent lanes, absent segments, absent
 *      slots. This costs R8's memory of a filtered lane, which is the price
 *      of not breaking the origin's storage;
 *   3. if it STILL does not fit, slots are dropped until it does. A task
 *      without a slot is placed afresh; it is not placed wrongly.
 */
export function pruneAnchors(
  anchors: MapPlaneAnchors,
  present: ReadonlySet<string>,
  cap: number = MAX_SLOT_ANCHORS,
  byteBudget: number = MAX_ANCHOR_BYTES,
): MapPlaneAnchors {
  let next = anchors;
  const ids = Object.keys(anchors.slots);
  if (ids.length > cap) {
    const kept: Record<string, PlaneSlot> = {};
    for (const id of ids.filter(one => present.has(one)).sort().slice(0, cap)) {
      kept[id] = anchors.slots[id];
    }
    const room = cap - Object.keys(kept).length;
    if (room > 0) {
      for (const id of ids.filter(one => !present.has(one)).sort().slice(0, room)) {
        kept[id] = anchors.slots[id];
      }
    }
    next = { ...next, slots: kept };
  }
  if (anchorBytes(next) <= byteBudget) return next;

  const liveSegments = new Set<string>();
  const liveLanes = new Set<string>();
  for (const [id, slot] of Object.entries(next.slots)) {
    if (!present.has(id)) continue;
    liveSegments.add(slot.seg);
    const cut = slot.seg.indexOf('\u0000');
    liveLanes.add(cut >= 0 ? slot.seg.slice(0, cut) : slot.seg);
  }
  next = {
    version: 1,
    laneOrder: next.laneOrder.filter(key => liveLanes.has(key)),
    laneHeight: pick(next.laneHeight, liveLanes),
    cols: pick(next.cols, liveSegments),
    rows: pick(next.rows, liveSegments),
    segOrder: pick(next.segOrder, liveLanes),
    segWidth: pick(next.segWidth, liveSegments),
    laneHeaderW: pick(next.laneHeaderW, liveLanes),
    slots: Object.fromEntries(
      Object.entries(next.slots).filter(([id]) => present.has(id))),
  };
  if (anchorBytes(next) <= byteBudget) return next;

  // Last resort, and it terminates: halve the slot record until it fits, or
  // until there is nothing left to give.
  let slotIds = Object.keys(next.slots).sort();
  while (slotIds.length > 0 && anchorBytes(next) > byteBudget) {
    slotIds = slotIds.slice(0, Math.floor(slotIds.length / 2));
    next = {
      ...next,
      slots: Object.fromEntries(slotIds.map(id => [id, next.slots[id]])),
    };
  }
  return next;
}

/** Reads defensively: a corrupt, partial or foreign entry falls back to the
 *  empty anchor set, exactly as `readPersistedView` does for the view. */
export function parseAnchors(raw: string | null): MapPlaneAnchors {
  if (!raw) return EMPTY_PLANE_ANCHORS;
  try {
    const parsed = JSON.parse(raw) as Partial<MapPlaneAnchors>;
    if (parsed?.version !== 1) return EMPTY_PLANE_ANCHORS;
    const laneOrder = Array.isArray(parsed.laneOrder)
      ? parsed.laneOrder.filter((key): key is string => typeof key === 'string')
      : [];
    const laneHeight: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed.laneHeight ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        laneHeight[key] = value;
      }
    }
    const numberList = (value: unknown): number[] | null => {
      if (!Array.isArray(value)) return null;
      const list: number[] = [];
      for (const entry of value) {
        if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) return null;
        list.push(entry);
      }
      return list;
    };
    const cols: Record<string, number[]> = {};
    for (const [key, value] of Object.entries(parsed.cols ?? {})) {
      const list = numberList(value);
      if (list) cols[key] = list;
    }
    const rows: Record<string, number[]> = {};
    for (const [key, value] of Object.entries(parsed.rows ?? {})) {
      const list = numberList(value);
      if (list) rows[key] = list;
    }
    const segOrder: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed.segOrder ?? {})) {
      if (!Array.isArray(value)) continue;
      const list = value.filter((entry): entry is string => typeof entry === 'string');
      if (list.length === value.length) segOrder[key] = list;
    }
    const segWidth: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed.segWidth ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        segWidth[key] = value;
      }
    }
    const laneHeaderW: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed.laneHeaderW ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        laneHeaderW[key] = value;
      }
    }
    const slots: Record<string, PlaneSlot> = {};
    for (const [key, value] of Object.entries(parsed.slots ?? {})) {
      const slot = value as Partial<PlaneSlot>;
      if (typeof slot?.seg === 'string'
        && Number.isInteger(slot.col) && (slot.col as number) >= 0
        && Number.isInteger(slot.row) && (slot.row as number) >= 0) {
        slots[key] = { seg: slot.seg, col: slot.col as number, row: slot.row as number };
      }
    }
    const territories: Record<string, Box> = {};
    for (const [key, box] of Object.entries(parsed.territories ?? {})) {
      if (box && [box.x, box.y, box.w, box.h].every(n => Number.isFinite(n) && n >= 0)) territories[key] = box;
    }
    const organicHomes: Record<string, Box> = {};
    for (const [key, box] of Object.entries(parsed.organicHomes ?? {})) {
      if (box && [box.x,box.y,box.w,box.h].every(n => Number.isFinite(n) && n >= 0)) organicHomes[key]=box;
    }
    const organicLocal: Record<string, Box> = {};
    for(const [key,box] of Object.entries(parsed.organicLocal ?? {})) {
      if(box&&[box.x,box.y,box.w,box.h].every(Number.isFinite)&&box.w>=0&&box.h>=0) organicLocal[key]=box;
    }
    const organicAngles: Record<string, number> = {};
    for(const [key,value] of Object.entries(parsed.organicAngles ?? {})) {
      if(Number.isFinite(value)) organicAngles[key]=value;
    }
    return {
      ...(Object.keys(organicLocal).length ? {organicLocal} : {}),
      ...(Object.keys(organicAngles).length ? {organicAngles} : {}),
      ...(Object.keys(organicHomes).length ? { organicHomes } : {}),
      version: 1, laneOrder, laneHeight, cols, rows, segOrder, segWidth,
      laneHeaderW, slots, ...(Object.keys(territories).length ? { territories } : {}),
    };
  } catch {
    return EMPTY_PLANE_ANCHORS;
  }
}

export const PLANE_ANCHOR_STORAGE_KEY = 'relayhall_map_plane_anchors';

/**
 * localStorage, not sessionStorage: clause 6 says stability holds ACROSS
 * SESSIONS, and the view state's own store dies with the tab. A quota or a
 * privacy mode must never break the Map, so both ends swallow.
 */
export function readPlaneAnchors(organization: MapOrganization = 'horizontal'): MapPlaneAnchors {
  try {
    return parseAnchors(localStorage.getItem(organization === 'horizontal' ? PLANE_ANCHOR_STORAGE_KEY : `${PLANE_ANCHOR_STORAGE_KEY}:${organization}`));
  } catch {
    return EMPTY_PLANE_ANCHORS;
  }
}

/**
 * Returns whether the record actually landed. A full quota costs the reader
 * their remembered layout and never the Map — but it costs them the
 * cross-session half of clause 6, and round-1 finding 5 is right that
 * swallowing it silently is not good enough. The caller surfaces it.
 */
export function writePlaneAnchors(anchors: MapPlaneAnchors, organization: MapOrganization = 'horizontal'): boolean {
  try {
    localStorage.setItem(organization === 'horizontal' ? PLANE_ANCHOR_STORAGE_KEY : `${PLANE_ANCHOR_STORAGE_KEY}:${organization}`, JSON.stringify(anchors));
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------
 * CROSS-FADE — clause 1's "cross-fade bands keyed to on-screen region size".
 *
 * There are no altitudes on this plane and nothing to settle. What changes
 * with the zoom is only WHICH LAYER carries the ink: the tiles, their phase
 * containers, or their project container. Each layer's opacity is a pure
 * function of how big its CHILDREN land on screen, in CSS pixels — the
 * quantity a reader's eye actually responds to, and the one the A2 altitude
 * triggers were already calibrated in.
 *
 * The two endpoints are the ratified constants, not new ones:
 *
 *   40px  ALTITUDE_NODE_PX.ascendBelow — "a 170px tile at 40px on screen is
 *         still a shape; below that it is a dot", and §5 forbids dots. At
 *         this width the container has taken over completely, so nothing on
 *         this plane is ever a dot.
 *   58px  §5's far-band entry: 170px x 0.34, the scale at which the tile
 *         stops drawing its title. Above it the tiles are whole.
 *
 * Between them the layers CROSS-FADE, and their three opacities SUM TO ONE
 * at every scale — which is the mechanical form of A2's governing principle
 * that "a zoom level that shows nothing useful is a defect": no scale exists
 * at which the ink is missing, and none at which it is doubled.
 * ---------------------------------------------------------------------- */

export const CROSSFADE_PX = { merged: 40, split: 58 } as const;

/**
 * How much of the CONTAINER shows, given the on-screen width of the children
 * it stands for: 1 when they have shrunk to the dot floor, 0 while they are
 * whole, linear in between.
 */
export function containerAlpha(childOnScreenPx: number): number {
  if (!Number.isFinite(childOnScreenPx) || childOnScreenPx <= CROSSFADE_PX.merged) return 1;
  if (childOnScreenPx >= CROSSFADE_PX.split) return 0;
  return (CROSSFADE_PX.split - childOnScreenPx) / (CROSSFADE_PX.split - CROSSFADE_PX.merged);
}

export interface PlaneFade {
  /** Project container id → opacity. */
  project: Map<string, number>;
  /** Phase container (band) id → opacity. */
  phase: Map<string, number>;
  /** Task id → opacity. */
  task: Map<string, number>;
  /**
   * The UNCOMPOSED ramps, which are what decide who is in charge.
   *
   * Opacity is not the whole story. Three layers drawn at once would mean
   * three sets of controls in the tab order and three names in the
   * accessibility tree for the same work, and a control faded to 12% is one
   * a pointer can still hit and a screen reader still announces at full
   * volume. So exactly ONE layer per region is INTERACTIVE — the dominant
   * one — and the other two render as §5's status-tinted shapes: seen,
   * aria-hidden, and reachable by nobody.
   */
  phaseRamp: Map<string, number>;
  projectRamp: Map<string, number>;
}

export type PlaneTier = 'task' | 'phase' | 'project';

/**
 * Which layer owns a region, from the phase ramp `h` and the project ramp
 * `p` that apply to it. The three composed opacities are (1-h)(1-p),
 * h(1-p) and p, so the layer carrying at least half the ink is the one the
 * reader is actually reading. Ties go to the FINER layer: detail is kept for
 * as long as it is legible, which is §5's discipline exactly.
 */
export function dominantTier(phaseRamp: number, projectRamp: number): PlaneTier {
  if (projectRamp >= 0.5) return 'project';
  if (phaseRamp >= 0.5) return 'phase';
  return 'task';
}

const mean = (values: readonly number[]) =>
  (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/**
 * The whole plane's cross-fade at one scale.
 *
 * A phase container answers for its own tiles, and a project container for
 * its own phase containers — so a BIG phase still shows its tiles at a scale
 * where a small phase beside it has already become one tile. That is the
 * size-truthful behaviour clause 2 asks for, and it is what a geographic map
 * does when it draws a city's streets and a village's dot at once.
 *
 * A connector task has no phase container to fade into (clause 3 places it
 * BETWEEN the phase boxes), so it fades directly into its project.
 */
export function planeFade(elements: readonly PlacedElement[], scale: number): PlaneFade {
  const bands: PlacedBand[] = [];
  const containers: PlacedContainer[] = [];
  const tiles: PlacedTile[] = [];
  for (const element of elements) {
    if (element.kind === 'band') bands.push(element);
    else if (element.kind === 'container') containers.push(element);
    else if (element.kind === 'tile') tiles.push(element);
  }

  // ONE pass to group, using the membership the layout recorded on each
  // element. Nothing here searches, so the whole fade is linear in the
  // number of placed elements.
  const bandWidthsByLane = new Map<string, number[]>();
  for (const band of bands) {
    const list = bandWidthsByLane.get(band.laneId);
    if (list) list.push(band.w); else bandWidthsByLane.set(band.laneId, [band.w]);
  }
  const tileWidthsByBand = new Map<string, number[]>();
  const tileWidthsByLane = new Map<string, number[]>();
  for (const tile of tiles) {
    const laneId = tile.laneId ?? '';
    const laneList = tileWidthsByLane.get(laneId);
    if (laneList) laneList.push(tile.w); else tileWidthsByLane.set(laneId, [tile.w]);
    if (!tile.bandId) continue;
    const bandList = tileWidthsByBand.get(tile.bandId);
    if (bandList) bandList.push(tile.w); else tileWidthsByBand.set(tile.bandId, [tile.w]);
  }

  const project = new Map<string, number>();
  const projectOfLane = new Map<string, number>();
  for (const container of containers) {
    // A project answers for its PHASE containers; a project with no phases
    // at all (every task a connector) answers for its tiles directly, which
    // is the same rule one rung down.
    const childWidths = bandWidthsByLane.get(container.laneId)
      ?? tileWidthsByLane.get(container.laneId)
      ?? [];
    const alpha = childWidths.length ? containerAlpha(mean(childWidths) * scale) : 0;
    project.set(container.id, alpha);
    projectOfLane.set(container.laneId, alpha);
  }

  const phase = new Map<string, number>();
  const phaseOfBand = new Map<string, number>();
  for (const band of bands) {
    const own = tileWidthsByBand.get(band.id) ?? [];
    const alpha = own.length ? containerAlpha(mean(own) * scale) : 0;
    phaseOfBand.set(band.id, alpha);
    phase.set(band.id, alpha * (1 - (projectOfLane.get(band.laneId) ?? 0)));
  }

  const task = new Map<string, number>();
  for (const tile of tiles) {
    const p = projectOfLane.get(tile.laneId ?? '') ?? 0;
    // A connector has no phase container to fade into (clause 3 places it
    // BETWEEN the phase boxes), so it answers only to its project.
    const h = tile.bandId ? (phaseOfBand.get(tile.bandId) ?? 0) : 0;
    task.set(tile.id, (1 - h) * (1 - p));
  }

  return { project, phase, task, phaseRamp: phaseOfBand, projectRamp: projectOfLane };
}

/** Below this a layer is not painted at all: it contributes nothing a reader
 *  can see, and rendering it would spend DOM (and a tab stop) on nothing. */
export const FADE_EPSILON = 0.02;

/* ----------------------------------------------------------------------
 * THE CONTAINER'S INK IS SCREEN-SPACE.
 *
 * On a continuous plane, zooming out shrinks EVERYTHING — including the
 * summary that is supposed to replace what shrank. A phase card drawn in
 * plane units lands at 64 CSS px on screen at the zoom its tiles hand over
 * at, which is A2's "a zoom level that shows nothing useful is a defect"
 * arriving by a new route. This is exactly the problem the A2 aggregate
 * GRID solved by giving each altitude its own plane, and clause 1 has taken
 * that away.
 *
 * A geographic map has the answer and has had it for a century: the
 * GEOMETRY is world-space and the LABELS are screen-space. A city's name
 * does not shrink as you zoom out — it disappears when there is no room for
 * it, and the city's shape carries the meaning until it comes back.
 *
 * So the container's card is drawn at a CONSTANT CSS size (the plane's
 * inverse scale, applied as a transform) and only where its region can hold
 * it. A region too small for its card is a status-TINTED SHAPE, which is
 * what clause 2 already says it should be: "State stays legible at every
 * altitude by tint ... counters, labels and progress detail are close-zoom
 * ink."
 * ---------------------------------------------------------------------- */

/** The card's designed box in CSS pixels: `.map-container-card` is 220 wide
 *  (the §7 aggregate-node width) and about six rows of §7 type tall. */
export const PLANE_CARD_PX = { w: 220, h: 96 } as const;

/**
 * Can this region host its card at full size, at this zoom?
 *
 * `card` is the card's MEASURED CSS box when one has been reported, and the
 * designed box only until then. Round-1 finding 4 is exactly right that the
 * nominal 96px was an assumption: the card's height is content-driven, its
 * counter row wraps, and a card taller than its nominal box would have
 * spilled over ground the region does not own — the one thing §2's
 * zero-overlap invariant exists to prevent. A measured box is the same
 * discipline every other element on this plane is held to (Rule 1).
 *
 * The comparison is in CSS pixels on screen, because that is the space the
 * card is drawn in: the plane's inverse scale rides it back out to its
 * designed size however far the world is zoomed.
 */
export function cardFits(
  region: { w: number; h: number },
  viewScale: number,
  card: { w: number; h: number } = PLANE_CARD_PX,
): boolean {
  return region.w * viewScale >= card.w && region.h * viewScale >= card.h;
}

export type { AggregateFacts };

/** Project the existing selected chain onto every representation sharing its
 * ground. Reachability is decided by the caller at the selected altitude;
 * this projection changes no edge or selection semantics. A container stays
 * lit when it contains chain work; unrelated task shapes dim even while their
 * container owns interaction. All layers multiply this by their own fade.
 */
export function projectPlaneAttention(
  graph: MapGraph,
  taskChain: ReadonlySet<string> | null,
  aggregateChain: ReadonlySet<string> | null,
): { tasks: ReadonlySet<string> | null; containers: ReadonlySet<string> | null } {
  if (!taskChain && !aggregateChain) return { tasks: null, containers: null };
  const tasks = new Set(taskChain ?? []);
  const containers = new Set(taskChain ? [] : aggregateChain ?? []);
  for (const node of graph.nodes) {
    const phase = aggregateKeyOf(node, 'phase');
    const project = aggregateKeyOf(node, 'project');
    if (taskChain ? taskChain.has(node.id) : aggregateChain?.has(phase) || aggregateChain?.has(project)) {
      tasks.add(node.id);
      containers.add(phase);
      containers.add(project);
    }
  }
  return { tasks, containers };
}


/** RH-UI.17i: a single screen-width vocabulary, independent of viewport. */
export type PlaneDetailBand = 'full' | 'compact' | 'aggregate' | 'silhouette';
export const PLANE_DETAIL_PX = { full: 160, compact: 96, aggregate: 40 } as const;
export function planeDetailBand(renderedCardWidth: number): PlaneDetailBand {
  if (renderedCardWidth >= PLANE_DETAIL_PX.full) return 'full';
  if (renderedCardWidth >= PLANE_DETAIL_PX.compact) return 'compact';
  if (renderedCardWidth >= PLANE_DETAIL_PX.aggregate) return 'aggregate';
  return 'silhouette';
}


/** Vertical runs the same anchored lattice in flow coordinates, then transposes
 * geometry back. Ink measurements were transposed on input; cards stay upright. */
export function layoutVerticalPlane(graph: MapGraph, sizes: SizeMap,
  anchors: MapPlaneAnchors = EMPTY_PLANE_ANCHORS): PlaneLayoutResult {
  const flow = layoutHorizontalPlane(graph, sizes, anchors, true);
  const elements = flow.elements.map(element => ({ ...element,
    x: element.y, y: element.x, w: element.h, h: element.w,
  }));
  const bands = new Map(elements.filter((e): e is PlacedBand => e.kind === 'band').map(e => [e.id, e]));
  for (const element of elements) {
    if (element.kind !== 'chip') continue;
    const band = bands.get(element.bandId);
    if (band) { element.x = band.x; element.y = band.y; element.w = Math.min(220, band.w); element.h = 32; }
  }
  return { ...flow, elements, width: flow.height, height: flow.width };
}

export function layoutContinuousPlane(graph: MapGraph, sizes: SizeMap,
  organization: MapOrganization, anchors: MapPlaneAnchors = EMPTY_PLANE_ANCHORS): PlaneLayoutResult {
  if (organization === 'radial') return layoutRadialPlane(graph, sizes, anchors);
  if (organization === 'organic') return layoutOrganicPlane(graph, sizes, anchors);
  return organization === 'vertical' ? layoutVerticalPlane(graph, sizes, anchors)
    : layoutHorizontalPlane(graph, sizes, anchors);
}


const boundsOf = (elements: readonly Box[]): Box => {
  if (!elements.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x = Math.min(...elements.map(e => e.x));
  const y = Math.min(...elements.map(e => e.y));
  return { x, y, w: Math.max(...elements.map(e => e.x + e.w)) - x,
    h: Math.max(...elements.map(e => e.y + e.h)) - y };
};
const moveElements = (elements: readonly PlacedElement[], dx: number, dy: number): PlacedElement[] =>
  elements.map(e => ({ ...e, x: e.x + dx, y: e.y + dy,
    ...(e.kind === 'hull' ? { points: e.points.map(([x,y]) => [x+dx,y+dy] as const) } : {}),
  }));

const boxesOverlap = (a: Box, b: Box, gap = 64) =>
  a.x < b.x+b.w+gap && a.x+a.w+gap > b.x && a.y < b.y+b.h+gap && a.y+a.h+gap > b.y;

/** Owner radial sketch: project spokes around one centre; phases proceed
 * outward in declared order along each spoke, with upright task cards. */
export function layoutRadialPlane(graph: MapGraph, sizes: SizeMap,
  anchors: MapPlaneAnchors = EMPTY_PLANE_ANCHORS): PlaneLayoutResult {
  return layoutOrganicPlane(graph, sizes, anchors, true);
}


const seedOf = (text: string) => {
  let state = 2166136261;
  for (const char of text) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return state;
};

/** A3: archived history at the centre, live work growing outward in branches.
 * Phase clusters retain their anchored task lattice. Dependency-connected phases
 * form arms; independent phases fork. Seeded angular placement supplies the initial
 * homes, and local outward separation resolves measured boxes. Saved homes win.
 * No zoom value enters this function. */
export function layoutOrganicPlane(graph: MapGraph, sizes: SizeMap,
  anchors: MapPlaneAnchors = EMPTY_PLANE_ANCHORS, radial = false): PlaneLayoutResult {
  const placement = radial ? graph : organicPlaneGraph(graph);
  const base = layoutHorizontalPlane(placement, sizes, anchors);
  const originals = new Map(graph.nodes.map(node => [node.id, node]));
  const tiles = new Map(base.elements.filter((e): e is PlacedTile => e.kind === 'tile').map(e => [e.id,e]));
  const bands = new Map(base.elements.filter((e): e is PlacedBand => e.kind === 'band').map(e => [e.id,e]));
  const containers = base.elements.filter((e): e is PlacedContainer => e.kind === 'container');
  const homes = anchors.organicHomes ?? {};
  const allHomes: Record<string, Box> = { ...homes };
  const localHomes: Record<string, Box> = { ...anchors.organicLocal };
  const angles: Record<string, number> = { ...anchors.organicAngles };
  const regions: OrganicRegion[] = [];
  const elements: PlacedElement[] = [];
  const ownLane = (e: PlacedElement) => 'laneId' in e ? e.laneId : e.kind === 'lane'
    ? e.id.slice(5) : e.kind === 'chip' ? bands.get(e.bandId)?.laneId
    : e.kind === 'pill' ? tiles.get(e.taskId)?.laneId : undefined;
  const archive = containers.find(e => e.laneId === ORGANIC_CORE);
  const coreElements = base.elements.filter(e => ownLane(e) === ORGANIC_CORE);
  const coreContents = coreElements.filter(e => e.kind === 'tile' || e.kind === 'pill');
  const archiveBounds = boundsOf(coreContents);
  const diameter = Math.max(1024, Math.hypot(archiveBounds.w + 128,
    archiveBounds.h + PLANE_METRICS.captionHeaderH + 128));
  // The empty core still reserves the same geographic origin; showing or hiding
  // archived work never removes the centre that the branches grow from.
  const oldCore = homes[ORGANIC_CORE];
  const core: Box = { x: oldCore?.x ?? 0, y: oldCore?.y ?? 0,
    w: Math.max(diameter,oldCore?.w ?? 0), h: Math.max(diameter,oldCore?.h ?? 0) };
  const cx=core.x+core.w/2, cy=core.y+core.h/2;
  allHomes[ORGANIC_CORE]=core;
  if (archive) {
    const content=moveElements(coreContents,cx-archiveBounds.w/2-archiveBounds.x,
      cy-(archiveBounds.h-PLANE_METRICS.captionHeaderH)/2-archiveBounds.y);
    elements.push(...content, { ...archive, ...core, label:'Archived core',laneLabel:'Archived core' });
    const header=coreElements.find(e=>e.kind==='lane');
    if(header) elements.push({...header,x:cx-110,y:core.y+64,label:'Archived core'});
  }
  if(!radial) regions.push({laneId:ORGANIC_CORE,core:true,box:core,clusters:[],branches:[]});
  const projects=containers.filter(e=>e.laneId!==ORGANIC_CORE).sort((a,b)=>a.laneId.localeCompare(b.laneId));
  // Constrained force relaxation on the circle: cross-project dependency
  // springs encourage adjacency, neighbouring arms repel, retained angles stay
  // fixed. Canonical traversal and a fixed step count make fresh renders agree.
  const projectIds=projects.map(p=>p.laneId);
  const projectSet=new Set(projectIds);
  const laneByTask=new Map(placement.nodes.map(n=>[n.id,laneKeyOf(n)]));
  const springs=[...new Set(graph.edges.filter(e=>e.kind==='dependency').map(e=> {
    const a=laneByTask.get(e.from),b=laneByTask.get(e.to);
    return a&&b&&a!==b&&projectSet.has(a)&&projectSet.has(b)?JSON.stringify([a,b].sort()):'';
  }).filter(Boolean))].sort().map(value=>JSON.parse(value) as [string,string]);
  projectIds.forEach((id,index)=> { angles[id] ??= -Math.PI/2+2*Math.PI*index/Math.max(1,projects.length)
    +(radial?0:(seedOf(id)/0xffffffff-0.5)*0.12); });
  const delta=(a:number,b:number)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));
  for(let step=0;step<(radial?0:40);step+=1) {
    const force=new Map(projectIds.map(id=>[id,0]));
    for(const [a,b] of springs) {
      const pull=delta(angles[a],angles[b])*0.015;
      force.set(a,force.get(a)!+pull);force.set(b,force.get(b)!-pull);
    }
    const angular=[...projectIds].sort((a,b)=>angles[a]-angles[b]||a.localeCompare(b));
    for(let i=0;i<angular.length&&angular.length>1;i+=1) {
      const a=angular[i],b=angular[(i+1)%angular.length];
      const gap=(angles[b]-angles[a]+Math.PI*4)%(Math.PI*2);
      const push=Math.max(0,Math.PI/Math.max(1,angular.length)-gap)*0.15;
      force.set(a,force.get(a)!-push);force.set(b,force.get(b)!+push);
    }
    for(const id of projectIds) if(anchors.organicAngles?.[id]===undefined)
      angles[id]+=Math.max(-0.03,Math.min(0.03,force.get(id)!));
  }
  const occupied: Box[]=[core];
  for(const [projectIndex,project] of projects.entries()) {
    const own=base.elements.filter(e=>ownLane(e)===project.laneId);
    const groups=new Map<string,PlacedElement[]>();
    for(const e of own) {
      if(e.kind==='container'||e.kind==='lane') continue;
      const key=e.kind==='band'?e.id:e.kind==='chip'?e.bandId:
        e.kind==='tile'?(e.bandId??'connectors'):e.kind==='pill'?(tiles.get(e.taskId)?.bandId??'connectors'):'connectors';
      const list=groups.get(key)??[];list.push(e);groups.set(key,list);
    }
    const clusters=[...groups].map(([id,content])=>({id,content,box:boundsOf(content)}));
    const nodeGroup=new Map(own.filter((e):e is PlacedTile=>e.kind==='tile').map(e=>[e.id,e.bandId??'connectors']));
    const incoming=new Map<string,string[]>();
    for(const edge of [...graph.edges].sort((a,b)=>(a.from+a.to).localeCompare(b.from+b.to))) {
      if(edge.kind!=='dependency') continue;
      const child=nodeGroup.get(edge.from),parent=nodeGroup.get(edge.to);
      if(child&&parent&&child!==parent) {
        const list=incoming.get(child)??[];if(!list.includes(parent))list.push(parent);incoming.set(child,list);
      }
    }
    // Declared order supplies a compact continuation when no dependency chooses
    // a parent. Explicit siblings fork; placement never invents graph edges.
    const assigned=new Map<string,{depth:number;arm:number}>();
    let arms=0;
    const continued=new Set<number>();
    for(const cluster of clusters) {
      const parents=(incoming.get(cluster.id)??[]).map(id=>assigned.get(id)).filter((v):v is {depth:number;arm:number}=>Boolean(v));
      const parent=parents.sort((a,b)=>b.depth-a.depth||a.arm-b.arm)[0]
        ?? [...assigned.values()].at(-1);
      const arm=parent&&(!parents.length||!continued.has(parent.arm))?parent.arm:arms++;
      if(parent) continued.add(parent.arm);
      assigned.set(cluster.id,radial?{depth:assigned.size,arm:0}:{depth:parent?parent.depth+1:0,arm});
    }
    const pitchY=Math.max(1,...clusters.map(c=>c.box.h))+64;
    const angle=Math.round((angles[project.laneId] ?? (-Math.PI/2+2*Math.PI*projectIndex/Math.max(1,projects.length)
      +(seedOf(project.laneId)/0xffffffff-0.5)*0.12))*1e6)/1e6;
    angles[project.laneId]=angle;
    const local: PlacedElement[]=[];
    const localBoxes: Box[]=[];
    const localBranches: Array<readonly [number,number,number,number]>=[];
    for(const cluster of clusters) {
      const position=assigned.get(cluster.id)!;
      const parentId=radial?clusters[clusters.indexOf(cluster)-1]?.id:
        (incoming.get(cluster.id)??[]).find(id=>clusters.findIndex(c=>c.id===id)<clusters.indexOf(cluster))
        ?? clusters[clusters.indexOf(cluster)-1]?.id;
      const parentBox=parentId?localBoxes[clusters.findIndex(c=>c.id===parentId)]:undefined;
      const support=(b:Box)=>Math.abs(Math.cos(angle))*b.w/2+Math.abs(Math.sin(angle))*b.h/2;
      const parentForward=parentBox?(parentBox.x+parentBox.w/2)*Math.cos(angle)+(parentBox.y+parentBox.h/2)*Math.sin(angle):0;
      const forward=parentForward+(parentBox?support(parentBox):0)+support(cluster.box)+48;
      const side=radial?0:(position.arm-(arms-1)/2)*pitchY;
      const localKey=project.laneId+'\u0000'+cluster.id;
      const saved=localHomes[localKey];
      let box={...cluster.box,x:forward*Math.cos(angle)-side*Math.sin(angle)-cluster.box.w/2,
        y:forward*Math.sin(angle)+side*Math.cos(angle)-cluster.box.h/2};
      if(saved) box={...box,x:saved.x,y:saved.y,w:Math.max(box.w,saved.w),h:Math.max(box.h,saved.h)};
      // Upright measured rectangles need more clearance after rotating their
      // centres. Resolve only this cluster outward, never rotate the cards.
      while(localBoxes.some(other=>boxesOverlap(box,other))) {
        box={...box,x:box.x+Math.cos(angle)*128,y:box.y+Math.sin(angle)*128};
      }
      box={x:Math.round(box.x),y:Math.round(box.y),w:Math.ceil(box.w),h:Math.ceil(box.h)};
      localHomes[localKey]=box;
      localBoxes.push(box);
      local.push(...moveElements(cluster.content,box.x-cluster.box.x,box.y-cluster.box.y));
      localBranches.push([parentBox?parentBox.x+parentBox.w/2:0,parentBox?parentBox.y+parentBox.h/2:0,
        box.x+box.w/2,box.y+box.h/2]);
    }
    const extent=boundsOf([...localBoxes,{x:0,y:0,w:1,h:1}]);
    const originKey=project.laneId+'\u0000origin';
    const savedOrigin=localHomes[originKey];
    const dx=Math.max(savedOrigin?.x ?? 0,32-extent.x),dy=Math.max(savedOrigin?.y ?? 0,PLANE_METRICS.captionHeaderH-extent.y);
    const w=Math.max(220,extent.x+extent.w+dx+32),h=extent.y+extent.h+dy+32;
    localHomes[originKey]={x:dx,y:dy,w:0,h:0};
    const held=homes[project.laneId];
    let distance=core.w/2+128;
    let at:Box=held?{x:held.x-(dx-(savedOrigin?.x??dx)),y:held.y-(dy-(savedOrigin?.y??dy)),w:Math.max(w,held.w+dx-(savedOrigin?.x??dx)),h:Math.max(h,held.h+dy-(savedOrigin?.y??dy))}:
      {x:cx+distance*Math.cos(angle)-dx,y:cy+distance*Math.sin(angle)-dy,w,h};
    while(occupied.some(other=>boxesOverlap(at,other))) {
      distance+=128;
      at={...at,x:held?at.x+Math.cos(angle)*128:cx+distance*Math.cos(angle)-dx,
        y:held?at.y+Math.sin(angle)*128:cy+distance*Math.sin(angle)-dy};
    }
    // A new branch must not force a global origin translation of an already
    // inhabited world. If its nominal arm runs beyond the retained origin,
    // grow at the available right frontier; existing territories keep home.
    if(Object.keys(homes).length && (at.x<32 || at.y<32)) {
      at={...at,x:Math.max(32,...occupied.map(b=>b.x+b.w+128)),y:Math.max(32,at.y)};
    }
    at={x:Math.round(at.x),y:Math.round(at.y),w:Math.ceil(at.w),h:Math.ceil(at.h)};
    occupied.push(at);allHomes[project.laneId]=at;
    elements.push(...moveElements(local,at.x+dx,at.y+dy),{...project,...at});
    const header=own.find(e=>e.kind==='lane');
    if(header) elements.push({...header,x:at.x,y:at.y});
    const corePort={x:cx+core.w/2*Math.cos(angle),y:cy+core.h/2*Math.sin(angle),w:0,h:0};
    regions.push({laneId:project.laneId,core:false,box:{x:Math.floor(Math.min(at.x,corePort.x)),y:Math.floor(Math.min(at.y,corePort.y)),
      w:Math.ceil(Math.max(at.x+at.w,corePort.x))-Math.floor(Math.min(at.x,corePort.x)),
      h:Math.ceil(Math.max(at.y+at.h,corePort.y))-Math.floor(Math.min(at.y,corePort.y))},captionBox:at,
      clusters:localBoxes.map((b,i)=>({...b,x:b.x+at.x+dx,y:b.y+at.y+dy,
        ...(clusters[i].id!=='connectors'?{phaseId:clusters[i].content.find((e):e is PlacedTile=>e.kind==='tile')?.node.phaseId ?? undefined}:{}),
        facts:aggregateFactsOf(clusters[i].content.filter((e):e is PlacedTile=>e.kind==='tile').map(e=>e.node))})),
      branches:[[cx+core.w/2*Math.cos(angle),cy+core.h/2*Math.sin(angle),at.x+dx,at.y+dy],...localBranches.map(([x1,y1,x2,y2])=>[x1+at.x+dx,y1+at.y+dy,x2+at.x+dx,y2+at.y+dy] as const)]});
  }
  // Translate a new world once. Retained homes include filtered-out projects,
  // so later filters do not renormalize the survivors.
  const extent=boundsOf(Object.values(allHomes));
  const dx=Math.floor(Math.min(0,extent.x-32)),dy=Math.floor(Math.min(0,extent.y-32));
  for(const [id,box] of Object.entries(allHomes)) allHomes[id]={...box,x:box.x-dx,y:box.y-dy};
  const moved=moveElements(elements,-dx,-dy).map(e=>e.kind==='tile'?{...e,node:originals.get(e.id)!}:e);
  const result: PlaneLayoutResult = {elements:moved,width:extent.x+extent.w-dx+32,height:extent.y+extent.h-dy+32,
    anchors:{...base.anchors,organicHomes:allHomes,organicLocal:localHomes,organicAngles:angles},
    organicRegions:regions.map(r=>({...r,box:{...r.box,x:r.box.x-dx,y:r.box.y-dy},
      ...(r.captionBox?{captionBox:{...r.captionBox,x:r.captionBox.x-dx,y:r.captionBox.y-dy}}:{}),
      clusters:r.clusters.map(b=>({...b,x:b.x-dx,y:b.y-dy})),
      branches:r.branches.map(([a,b,c,d])=>[a-dx,b-dy,c-dx,d-dy])}))};
  // A fixed world-unit precision prevents repeated origin translations from
  // accumulating floating-point noise through persistence round trips.
  result.organicRegions=result.organicRegions?.map(region=>({...region,
    outline:region.core?undefined:organicTerritoryPath(region),
    clusters:region.clusters.map(box=>({...box,outline:organicPhasePath(box,moved.filter(e=>
      (e.kind==='tile'||e.kind==='pill') && e.x>=box.x && e.y>=box.y
      && e.x+e.w<=box.x+box.w && e.y+e.h<=box.y+box.h))}))}));
  return JSON.parse(JSON.stringify(result, (_key,value) => typeof value === 'number'
    ? Math.round(value * 1e6) / 1e6 : value)) as PlaneLayoutResult;
}


/** Union phase ground with diagonal branch ribbons. Unlike a single convex
 * hull, this retains the open gaps between forks in the owner's sketch. */
export function organicTerritoryPath(region: OrganicRegion): string {
  type Point = [number,number];
  const root=region.box,polygons:Point[][]=[];
  const add=(points:Point[])=>{
    const poly=convexHull(points.map(([x,y])=>[
      Math.max(root.x,Math.min(root.x+root.w,x)),
      Math.max(root.y,Math.min(root.y+root.h,y))] as const));
    if(poly.length>=3) polygons.push(poly);
  };
  const rectangle=(b:Box,pad=0)=>add([[b.x-pad,b.y-pad],[b.x+b.w+pad,b.y-pad],
    [b.x+b.w+pad,b.y+b.h+pad],[b.x-pad,b.y+b.h+pad]]);
  for(const box of region.clusters) rectangle(box,24);
  // A branch is a diagonal ribbon, not a staircase. The convex capsule
  // overlaps phase ground and the neighbouring ribbons at each fork.
  const corridor=(x1:number,y1:number,x2:number,y2:number)=>{
    const ends=region.clusters.filter(b=>(x1>=b.x&&x1<=b.x+b.w&&y1>=b.y&&y1<=b.y+b.h)
      ||(x2>=b.x&&x2<=b.x+b.w&&y2>=b.y&&y2<=b.y+b.h));
    const radius=Math.max(48,Math.min(256,...ends.map(b=>Math.min(b.w,b.h)*0.4)));
    add([...[x1,x2].flatMap((x,i)=>Array.from({length:8},(_,j)=>[
      x+radius*Math.cos(j*Math.PI/4),(i?y2:y1)+radius*Math.sin(j*Math.PI/4)] as Point))]);
  };
  for(const [a,b,c,d] of region.branches) corridor(a,b,c,d);
  const caption=region.captionBox??root;
  const headerW=Math.min(caption.w,1024);
  rectangle({x:caption.x,y:caption.y,w:headerW,h:Math.min(caption.h,PLANE_METRICS.captionHeaderH)});
  const first=region.branches[1];
  if(first)corridor(caption.x+headerW/2,caption.y+PLANE_METRICS.captionHeaderH/2,first[0],first[1]);
  // Bound pathological phase counts without losing containment. Dense
  // projects use the enclosing hull; ordinary projects retain their forks.
  if(region.clusters.length<=2||polygons.length>128) return 'M '+convexHull(polygons.flat()).map(p=>p.join(' ')).join(' L ')+' Z';
  // Union convex pieces by splitting their boundary at intersections and
  // retaining only exposed segments. This preserves the gaps between arms.
  const cross=(a:Point,b:Point)=>a[0]*b[1]-a[1]*b[0];
  const sub=(a:Point,b:Point):Point=>[a[0]-b[0],a[1]-b[1]];
  const inside=(p:Point,poly:Point[])=>poly.every((a,i)=>
    cross(sub(poly[(i+1)%poly.length],a),sub(p,a))>1e-5);
  const key=(p:Point)=>p.map(v=>Math.round(v*1e5)/1e5).join(',');
  const segments=new Map<string,[Point,Point]>();
  for(const [index,poly] of polygons.entries())for(let i=0;i<poly.length;i++) {
    const a=poly[i],b=poly[(i+1)%poly.length],v=sub(b,a),cuts=[0,1];
    for(const [otherIndex,other] of polygons.entries())if(otherIndex!==index)
      for(let j=0;j<other.length;j++){
        const c=other[j],d=other[(j+1)%other.length],w=sub(d,c),den=cross(v,w);
        if(Math.abs(den)<1e-8){
          if(Math.abs(cross(sub(c,a),v))<1e-5){
            const length=v[0]*v[0]+v[1]*v[1];
            for(const p of [c,d]){const t=((p[0]-a[0])*v[0]+(p[1]-a[1])*v[1])/length;if(t>0&&t<1)cuts.push(t);}
          }
          continue;
        }
        const t=cross(sub(c,a),w)/den,u=cross(sub(c,a),v)/den;
        if(t>0&&t<1&&u>=0&&u<=1)cuts.push(t);
      }
    cuts.sort((x,y)=>x-y);
    for(let j=1;j<cuts.length;j++){
      const lo=cuts[j-1],hi=cuts[j];if(hi-lo<1e-8)continue;
      const point=(t:number):Point=>[a[0]+v[0]*t,a[1]+v[1]*t];
      if(polygons.some((p,k)=>k!==index&&inside(point((lo+hi)/2),p)))continue;
      const start=point(lo),end=point(hi),id=key(start)+'|'+key(end),reverse=key(end)+'|'+key(start);
      if(segments.has(reverse))segments.delete(reverse);else segments.set(id,[start,end]);
    }
  }
  const outgoing=new Map<string,Array<[Point,Point]>>();
  for(const edge of segments.values()){const at=key(edge[0]),list=outgoing.get(at)??[];list.push(edge);outgoing.set(at,list);}
  const paths:string[]=[];
  while(outgoing.size){
    const start=outgoing.keys().next().value as string;
    let at=start;const points:Point[]=[];
    do{
      const list=outgoing.get(at);if(!list?.length)break;
      const edge=list.pop()!;if(!list.length)outgoing.delete(at);
      points.push(edge[0]);at=key(edge[1]);
    }while(at!==start);
    if(points.length<3)continue;
    const corners=points.filter((p,i)=>Math.abs(cross(sub(p,points[(i+points.length-1)%points.length]),sub(points[(i+1)%points.length],p)))>1e-5);
    const arcs=corners.map((p,i)=>{
      const a=corners[(i+corners.length-1)%corners.length],b=corners[(i+1)%corners.length];
      const before=Math.hypot(...sub(p,a)),after=Math.hypot(...sub(b,p)),r=Math.min(12,before/3,after/3);
      return {p,enter:[p[0]+(a[0]-p[0])*r/before,p[1]+(a[1]-p[1])*r/before],
        exit:[p[0]+(b[0]-p[0])*r/after,p[1]+(b[1]-p[1])*r/after]};
    });
    if(arcs.length)paths.push('M '+arcs[0].enter.join(' ')+arcs.map(v=>' L '+v.enter.join(' ')+' Q '+v.p.join(' ')+' '+v.exit.join(' ')).join('')+' Z');
  }
  return paths.join(' ');
}

/** The phase contour follows its occupied task/report ground. The caption
 * reservation stays inside the top edge; spare lattice corners need not read
 * as work. Padding protects content when convex corners are softened. */
export function organicPhasePath(box: Box, contents: readonly Box[] = []): string {
  const ground: Box[]=[{x:box.x+8,y:box.y+8,w:box.w-16,h:Math.min(box.h-16,PLANE_METRICS.captionHeaderH)}];
  for(const item of contents) ground.push({
    x:Math.max(box.x+8,item.x-16), y:Math.max(box.y+8,item.y-16),
    w:Math.min(box.x+box.w-8,item.x+item.w+16)-Math.max(box.x+8,item.x-16),
    h:Math.min(box.y+box.h-8,item.y+item.h+16)-Math.max(box.y+8,item.y-16),
  });
  if(!contents.length) ground.push({x:box.x+8,y:box.y+8,w:box.w-16,h:box.h-16});
  const corners=convexHull(ground.flatMap(b=>[
    [b.x,b.y] as const,[b.x+b.w,b.y] as const,[b.x+b.w,b.y+b.h] as const,[b.x,b.y+b.h] as const]));
  const arcs=corners.map((p,i)=>{
    const a=corners[(i+corners.length-1)%corners.length],b=corners[(i+1)%corners.length];
    const before=Math.hypot(p[0]-a[0],p[1]-a[1]),after=Math.hypot(b[0]-p[0],b[1]-p[1]);
    const r=Math.min(8,before/3,after/3);
    return {p,enter:[p[0]+(a[0]-p[0])*r/before,p[1]+(a[1]-p[1])*r/before],
      exit:[p[0]+(b[0]-p[0])*r/after,p[1]+(b[1]-p[1])*r/after]};
  });
  return arcs.length?'M '+arcs[0].enter.join(' ')+arcs.map(a=>' L '+a.enter.join(' ')+' Q '+a.p.join(' ')+' '+a.exit.join(' ')).join('')+' Z':'';
}
