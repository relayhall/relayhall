import { placeArchiveCore, type ArchiveBlock } from './mapOrganicCore';
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
  routeFlowEdge,
  sizeOf,
  type AggregateFacts,
  type Box,
  type LayoutResult,
  type MapGraph,
  type MapEdge,
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
 *   - within a session the ORDER of lanes, phases and cards is anchored, so
 *     a board update does not reshuffle the world (clause 6, R1/R4); the
 *     GROUND is not: every area fits what is shown (owner ruling E386).
 *
 * This module is the horizontal slice. `layoutHorizontal` in mapGraphModel
 * remains the pre-amendment engine and still serves the vertical, radial and
 * organic organizations, which keep the A2 altitude hierarchy until their own
 * slices land (A7c subtasks 3 and 4). Nothing here removes or re-decides any
 * of that; the two engines coexist and the ORGANIZATION selects between them.
 * ====================================================================== */

/* ----------------------------------------------------------------------
 * ANCHORS — the ORDER a session has given the plane, and nothing else.
 *
 * A layout that recomputes every ORDER from the current data is a global
 * reshuffle: one new task with a new dependency depth re-ranks the columns,
 * one new project re-sorts the lanes, and the reader's memory of where
 * things are is destroyed. Clause 6 forbids that, so the session keeps:
 *
 *   laneOrder   the order lanes stack in, FIRST-SEEN rather than sorted, so
 *               a new project appends at the frontier instead of pushing the
 *               world down. (The unassigned lane keeps its §2 place last.)
 *   segOrder    the order a lane's segments sit in along the flow axis.
 *   slots       every SHOWN task's segment, its arrival GENERATION in it and
 *               its place in the segment's SEQUENCE: the tasks a segment
 *               showed first are generation 0, the ones that arrived on a
 *               later update 1, and so on; the sequence orders them once, on
 *               arrival, so an edit to a task (its status, its timestamp)
 *               never re-sorts it. The lattice is REPLAYED from that order
 *               (`replaySlots`), so an arrival fills a free cell or grows
 *               transversely and never moves a card the reader already has.
 *               The slot's column and row are where the task stands now:
 *               the layout's OUTPUT, never read back.
 *
 * OWNER RULING E386 (widening E375) retired everything else the record used
 * to carry. The plane used to RESERVE ground — lane heights, column widths,
 * row heights, segment widths, shelf depths — and the reservations only ever
 * grew and were persisted in the browser, so turning "show archived" on grew
 * every phase area and turning it off left them grown, even after a reload.
 * Now:
 *
 *   - every area is sized ONLY to the cards currently shown: `fitPlaneAnchors`
 *     strips the reserved geometry before each layout, a task that leaves
 *     takes its slot with it, and each segment's lattice is replayed from
 *     what is shown, so the hole a departure leaves closes instead of
 *     holding ground;
 *   - a lane, phase or connector group with nothing shown takes NO ground and
 *     is not drawn, including a declared phase that holds no task;
 *   - nothing is persisted: the record lives in memory for the session and a
 *     reload starts from the data alone (see PERSISTENCE below).
 *
 * GEOMETRY IS A FUNCTION OF (WHAT IS SHOWN, THE SESSION'S ORDER), in every
 * organization (round-1 review B1/B2). No coordinate a layout computed is ever
 * an input to the next one: the lattice is replayed from the generations, the
 * Organic and Radial homes, cells, angles and archive core are placed afresh
 * from what is shown, and the order itself only ever GROWS by appending — an
 * arrival never reorders what the session already had. So showing archived
 * work cannot change what hiding it again lays out: hidden -> shown -> hidden
 * returns every card, area, region and the archive core to the exact
 * rectangle it had, however the archive re-flowed the picture while shown
 * (a live task depending on an archived one moves a column right; the core
 * grows and pushes the projects outward).
 *
 * The anchors a layout RETURNS are the order it was given plus whatever it
 * had to decide; feeding them back in reproduces the identical geometry
 * (`layoutHorizontalPlane` is a fixed point in its anchors — asserted in the
 * suite).
 * ---------------------------------------------------------------------- */

export interface PlaneSlot {
  /** Segment key, lane-qualified: `${laneKey}\u0000${segmentKey}`. */
  seg: string;
  /** Where the task stands now. OUTPUT only: the plane never reads it back. */
  col: number;
  row: number;
  /**
   * The task's arrival generation in its segment — the session's ORDER at
   * the tile (dense from 0 per segment; absent reads as 0). The lattice is
   * replayed generation by generation (`replaySlots`).
   */
  gen?: number;
  /** Its place in the segment's sequence (dense from 0), fixed on arrival. */
  ord?: number;
}

export interface MapPlaneAnchors {
  version: 1;
  /**
   * What the last Organic or Radial layout PLACED: project homes, phase and
   * archive cells, project angles. OUTPUT only (E386, round-1 review B2):
   * `fitPlaneAnchors` strips them, so every home, the archive core and every
   * angle are placed afresh from what is shown, and nothing a region grew to
   * while archived work was shown survives its hiding.
   */
  organicHomes?: Readonly<Record<string, Box>>;
  organicLocal?: Readonly<Record<string, Box>>;
  organicAngles?: Readonly<Record<string, number>>;
  /** Lane keys in the order they stack, first-seen. */
  laneOrder: readonly string[];
  /** The order the segments of a lane sit in along the flow axis. A segment
   *  with nothing shown keeps its place in the ORDER and takes no ground. */
  segOrder: Readonly<Record<string, readonly string[]>>;
  /** Task id → its slot on the plane, for the tasks currently shown. */
  slots: Readonly<Record<string, PlaneSlot>>;
  // The reservations the record used to carry (lane heights, column widths,
  // row heights, segment and header widths), the density-migration stamps
  // and the territory record are gone (E386): the plane never reads them, so
  // nothing writes them.
}

export const EMPTY_PLANE_ANCHORS: MapPlaneAnchors = {
  version: 1, laneOrder: [], segOrder: {}, slots: {},
};

export const PLANE_METRICS = {
  /** Gap between one segment (phase box or connector group) and the next,
   *  along the flow axis. */
  segGapX: 32,
  /** Fixed caption ground: 120 screen px before task takeover (~0.68 scale).
   * Reserve it once so LOD never moves content to make room for its ink. */
  captionHeaderH: 192,
  /** Inner gutter between phase borders and their task cells. */
  bandPadX: 24,
  bandPadY: 24,
  /** Lane and shelf depths round up to this, so lane origins sit on the
   *  estate's 8px rhythm rather than on whatever a tile happened to be. */
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
   * the measured pass — but a correction is still a MOVE: a fallback that is
   * too SMALL grows the column on the pass where the pill first measures and
   * pushes every later segment in that lane along with it (and, while the
   * reservations were monotone before E386, kept it pushed). Round 2 measured
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
   * whose cells read it turns any late-arriving measurement into a shove
   * (a permanent one while reservations were monotone, before E386): the
   * engine probe on the parent commit reproduced the
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
  /** Wrap wide dependency ranks instead of building arbitrarily tall columns. */
  rowsPerColumn: 8,
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
  /**
   * Report cells a task keeps in ONE strip before its cells wrap into a grid
   * (card 31454392). The strip used to grow along the flow axis with every
   * linked Report: on production one task with 782 Reports reserved a column
   * 78,196 units wide, and the whole project read as a hairline at Fit. Up to
   * this many cells nothing changes; beyond it `pillGrid` folds the strip
   * into a block whose sides grow with the square root of the count.
   */
  pillStripMin: 4,
  /**
   * SHELVES (card 31454392). The planner reads a lane at Fit in this DECLARED
   * canvas — never the reader's window, because geometry that followed the
   * window would move the work whenever the browser was resized. A lane whose
   * tasks would land smaller than `shelfMinTilePx` on their short side wraps
   * its segments onto shelves; any other lane keeps the single shelf it has
   * always had. 10px is where `taskShapeAlpha` paints a shape at full ink.
   */
  shelfViewW: 1280,
  shelfViewH: 720,
  shelfMinTilePx: 10,
} as const;

/**
 * The grid a task's Report cells form (card 31454392): `perStrip` cells along
 * the flow axis, `strips` rows of them across it. Pitches are in the
 * organization's flow coordinates, so Vertical gets its own square.
 */
export function pillGrid(count: number, flowPitch: number, crossPitch: number):
  { perStrip: number; strips: number } {
  if (!(count > 0)) return { perStrip: 0, strips: 0 };
  const square = Math.ceil(Math.sqrt(count * crossPitch / flowPitch));
  const perStrip = Math.min(count, Math.max(PLANE_METRICS.pillStripMin, square));
  return { perStrip, strips: Math.ceil(count / perStrip) };
}

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
 * estate's. Clause 3 says "the phases sit left→right in declared order", so
 * the declared list fixes the ORDER and the connector boundaries; but a phase
 * with no shown task is not a segment at all (owner ruling E386, which
 * supersedes round-1 finding 6): it is not displayed and takes no ground.
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
    // E386: a phase with no shown task is not displayed. It still counts in
    // the declared order above, so a connector's gap means the same boundary
    // whether or not the phases around it are showing anything.
    if (phase && (byBand.get(phase.id)?.length ?? 0) > 0) {
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

const byUpdateThenId = (a: MapTaskNode, b: MapTaskNode) =>
  a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id);

/**
 * Assign every node in a segment a (col, row), honouring the anchors.
 *
 * An anchored task keeps its slot even if the dependency ranking around it
 * has moved on: stability outranks re-sorting, which is the whole of clause
 * 6. Arrivals fill the lowest free rows in their rank group, wrapping only
 * before the anchored higher-rank fence. When that space is full they grow
 * transversely instead — holes are filled and no neighbour is asked to move.
 */
export function assignSlots(
  segment: string,
  nodes: readonly MapTaskNode[],
  depths: ReadonlyMap<string, number>,
  anchors: MapPlaneAnchors,
  edges: readonly MapEdge[] = [],
  /** The order arrivals are placed in: the session's sequence when the
   *  caller has one (`replaySlots`), else last update then id. */
  order: (a: MapTaskNode, b: MapTaskNode) => number = byUpdateThenId,
): Map<string, { col: number; row: number }> {
  const assigned = new Map<string, { col: number; row: number }>();
  const taken = new Set<string>();

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
  }

  // Allocate rank by rank, not globally by arrival time. Fresh ranks still
  // wrap compactly; anchored ranks reserve their existing flow territory.
  const ranks = new Map<number, MapTaskNode[]>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    const group = ranks.get(depth);
    if (group) group.push(node); else ranks.set(depth, [node]);
  }
  const ordered = [...ranks.keys()].sort((a, b) => a - b);
  const heldColumns = ordered.map(depth => ranks.get(depth)!
    .flatMap(node => assigned.has(node.id) ? [assigned.get(node.id)!.col] : []));
  // A suffix fence stops upstream arrivals entering ANY anchored higher rank,
  // even when an intervening rank currently has no anchor of its own.
  const fences = new Array<number>(ordered.length).fill(Infinity);
  let fence = Infinity;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    fences[index] = fence;
    for (const col of heldColumns[index]) fence = Math.min(fence, col);
  }
  // Rank territory is a compactness preference, not an edge between unrelated
  // tasks. Churn can exhaust it while a dependency-feasible hole still exists.
  // Propagate actual downstream anchor bounds through unplaced intermediate work.
  const ids = new Set(nodes.map(node => node.id));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== "dependency" || !ids.has(edge.from) || !ids.has(edge.to)
      || (depths.get(edge.from) ?? 0) <= (depths.get(edge.to) ?? 0)) continue;
    const upstream = parents.get(edge.from) ?? [];
    upstream.push(edge.to); parents.set(edge.from, upstream);
    const downstream = children.get(edge.to) ?? [];
    downstream.push(edge.from); children.set(edge.to, downstream);
  }
  const latest = new Map<string, number>();
  for (const depth of [...ordered].reverse()) {
    for (const node of ranks.get(depth)!) {
      let bound = assigned.get(node.id)?.col ?? Infinity;
      for (const child of children.get(node.id) ?? []) {
        bound = Math.min(bound, (latest.get(child) ?? Infinity) - 1);
      }
      latest.set(node.id, bound);
    }
  }
  let previousEnd = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    const group = ranks.get(ordered[index])!;
    const held = heldColumns[index];
    const start = held.length ? Math.min(...held) : previousEnd + 1;
    // Transverse overflow is preferable to moving existing tasks or wrapping
    // beside their downstream work. No zoom state participates in allocation.
    const last = Math.max(start, Math.min(
      start + Math.ceil(group.length / PLANE_METRICS.rowsPerColumn) - 1,
      fences[index] - 1));
    const arrivals = group.filter(node => !assigned.has(node.id)).sort(order);
    for (const node of arrivals) {
      let lower = 0;
      for (const parent of parents.get(node.id) ?? []) {
        lower = Math.max(lower, (assigned.get(parent)?.col ?? -1) + 1);
      }
      const upper = latest.get(node.id) ?? Infinity;
      // Immutable anchors may leave no feasible interval: retain stability in
      // that case. Otherwise actual edges win over unrelated rank ordering.
      const feasible = lower <= upper;
      const useHole = feasible && (start >= fences[index] || start < lower || start > upper);
      let col = useHole ? lower : start;
      const end = feasible ? Math.min(upper, useHole
        ? lower + Math.ceil(group.length / PLANE_METRICS.rowsPerColumn) - 1 : last) : last;
      let row = 0;
      while (taken.has(`${col}:${row}`)) {
        row += 1;
        if (row === PLANE_METRICS.rowsPerColumn && col < end) { col += 1; row = 0; }
      }
      assigned.set(node.id, { col, row });
      taken.add(`${col}:${row}`);
    }
    for (const node of group) previousEnd = Math.max(previousEnd, assigned.get(node.id)!.col);
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
  /** Routed membership/dependency ground; omitted for unchanged Radial. */
  routedBranches?: ReadonlyArray<ReadonlyArray<readonly [number,number]>>;
  blockedBranches?: number;
  blockedRoutes?: ReadonlyArray<{d:string;from:readonly [number,number];to:readonly [number,number]}>;
  outline?: string;
  branches: ReadonlyArray<readonly [number, number, number, number]>;
}

export interface PlaneLayoutResult extends LayoutResult {
  worldBounds?: Box;
  archiveDrift?: boolean;
  archiveRecovery?: boolean;
  archiveScales?: Readonly<Record<string,number>>;
  organicRegions?: readonly OrganicRegion[];
  /** The anchors this layout decided. Feed them back and nothing moves. */
  anchors: MapPlaneAnchors;
}

/**
 * THE FIT (owner ruling E386, widening E375): the record a layout may use.
 *
 * Only the session's ORDER survives into a layout — lane order, segment
 * order and the slots of the tasks shown now. Anything else a record carries
 * (a reservation from an earlier engine, any other field) is dropped, and so
 * is the slot of every task that is not shown, so the areas a layout draws
 * are sized to the cards in `graph` and to nothing else. A task that comes
 * back into view is placed like any other arrival: into a free cell, never
 * over a card the reader is looking at.
 *
 * The Organic and Radial placement records (homes, cells, angles) are
 * dropped too (round-1 review B2): they are coordinates, and a coordinate a
 * layout computed while the archive was shown would hold its ground after
 * the archive is hidden.
 */
export function fitPlaneAnchors(anchors: MapPlaneAnchors, graph: MapGraph): MapPlaneAnchors {
  const slots: Record<string, PlaneSlot> = {};
  for (const node of graph.nodes) {
    const slot = Object.prototype.hasOwnProperty.call(anchors.slots, node.id) ? anchors.slots[node.id] : undefined;
    if (slot) slots[node.id] = slot;
  }
  return {
    version: 1,
    laneOrder: anchors.laneOrder,
    segOrder: anchors.segOrder,
    slots,
  };
}

/**
 * Whether a segment's lattice draws a dependency BACKWARDS: a task standing
 * in a column at or before the column of a task it depends on. Anchors can
 * leave an arrival no feasible column (`assignSlots` keeps the anchors in
 * that case), and closing holes (E386) makes that more likely: hide a task
 * between two others in a dependency chain, and the hole it would return to
 * has closed. Flow is the plane's first rule, so such a generation is
 * replayed afresh rather than drawn wrong (`replaySlots`).
 */
function flowsBackward(slots: ReadonlyMap<string, { col: number; row: number }>,
  depths: ReadonlyMap<string, number>, edges: readonly MapEdge[]): boolean {
  for (const edge of edges) {
    if (edge.kind !== 'dependency') continue;
    const child = slots.get(edge.from);
    const parent = slots.get(edge.to);
    if (!child || !parent) continue;
    if ((depths.get(edge.from) ?? 0) <= (depths.get(edge.to) ?? 0)) continue;
    if (parent.col >= child.col) return true;
  }
  return false;
}

/**
 * ONE SEGMENT'S LATTICE, REPLAYED FROM THE SESSION'S ORDER (E386, round-1
 * review B1).
 *
 * The record keeps no coordinate as an input. It keeps each shown task's
 * arrival GENERATION in its segment, and the lattice is rebuilt from nothing
 * on every layout: the tasks of generation 0 are placed as a fresh segment
 * would place them (dependency rank by rank, `rowsPerColumn` to a column),
 * then each later generation is placed around them as an arrival
 * (`assignSlots`: a free cell, else transverse growth — never moving a card
 * already placed). The depths are always those of what is shown NOW.
 *
 * That makes the lattice a function of (the shown tasks, their generations),
 * which is the property the review asked for. The B1 shape: B depends on
 * archived A. Shown, A makes B rank 1, so generation 0 replays with B one
 * column right of C and D. Hidden again, generation 0 replays with B at rank
 * 0 — exactly the lattice it had before the archive was shown. The round-1
 * engine read B's column back, so B kept the column the archive had forced.
 *
 * The replay leaves no hole to close: a task that has left is not placed at
 * all, the previous step's lattice has none, and an arrival takes the first
 * free row of its column, so every column and row holds a shown card. (The
 * round-1 engine read coordinates back and needed a compaction pass for that;
 * the pass is gone.)
 *
 * Arrivals take generation max + 1, and within the segment every task has a
 * place in one SEQUENCE: the held tasks keep theirs, the arrivals are
 * appended in last-update order. Both are renumbered densely, so the order
 * only grows by appending and a layout is a fixed point in what it returns;
 * and because the sequence is fixed on arrival, an edit to a shown task (a
 * new status, a new timestamp) re-sorts nothing.
 *
 * A generation that cannot be placed without drawing a dependency backwards
 * is replayed afresh together with everything before it, in this layout
 * only: the record is untouched, so hiding the task that forced it gives the
 * earlier lattice back.
 */
export function replaySlots(
  segment: string,
  nodes: readonly MapTaskNode[],
  depths: ReadonlyMap<string, number>,
  anchors: MapPlaneAnchors,
  edges: readonly MapEdge[],
): { slots: Map<string, { col: number; row: number }>; gens: Map<string, number>; ords: Map<string, number> } {
  const heldGen = new Map<string, number>();
  const heldOrd = new Map<string, number>();
  const whole = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
  for (const node of nodes) {
    const slot = Object.prototype.hasOwnProperty.call(anchors.slots, node.id) ? anchors.slots[node.id] : undefined;
    if (!slot || slot.seg !== segment) continue;
    heldGen.set(node.id, whole(slot.gen) ? slot.gen : 0);
    if (whole(slot.ord)) heldOrd.set(node.id, slot.ord);
  }
  let arrival = 0;
  for (const gen of heldGen.values()) arrival = Math.max(arrival, gen + 1);
  const genOf = (node: MapTaskNode) => heldGen.get(node.id) ?? arrival;
  // The segment's sequence: held tasks in their recorded order, arrivals
  // after them in last-update order. (A held task with no recorded place —
  // a record from before the sequence — sorts as an arrival of its own
  // generation would.)
  const sequence = [...nodes].sort((a, b) => genOf(a) - genOf(b)
    || (heldOrd.get(a.id) ?? Infinity) - (heldOrd.get(b.id) ?? Infinity)
    || byUpdateThenId(a, b));
  const ords = new Map(sequence.map((node, index) => [node.id, index]));
  const inSequence = (a: MapTaskNode, b: MapTaskNode) => ords.get(a.id)! - ords.get(b.id)!;
  const generations = [...new Set(nodes.map(genOf))].sort((a, b) => a - b);
  let placed = new Map<string, { col: number; row: number }>();
  for (const gen of generations) {
    const prefix = sequence.filter(node => genOf(node) <= gen);
    const step: MapPlaneAnchors = { ...EMPTY_PLANE_ANCHORS, slots: Object.fromEntries([...placed]
      .map(([id, slot]) => [id, { seg: segment, col: slot.col, row: slot.row }])) };
    let slots = assignSlots(segment, prefix, depths, step, edges, inSequence);
    if (flowsBackward(slots, depths, edges)) {
      slots = assignSlots(segment, prefix, depths, EMPTY_PLANE_ANCHORS, edges, inSequence);
    }
    placed = slots;
  }
  const dense = new Map(generations.map((gen, index) => [gen, index]));
  return { slots: placed, gens: new Map(nodes.map(node => [node.id, dense.get(genOf(node))!])), ords };
}

export function layoutHorizontalPlane(
  graph: MapGraph,
  sizes: SizeMap,
  given: MapPlaneAnchors = EMPTY_PLANE_ANCHORS,
  vertical = false,
  /** Shelf planning; Organic and Radial place their own regions and pass false. */
  wrap = true,
): PlaneLayoutResult {
  const metrics = LAYOUT_METRICS;
  const plane = vertical ? { ...PLANE_METRICS,
    tileCellW: PLANE_METRICS.tileCellH, tileCellH: PLANE_METRICS.tileCellW,
    pillReserveW: PLANE_METRICS.pillReserveH, pillReserveH: PLANE_METRICS.pillReserveW,
    laneHeaderW: PLANE_METRICS.captionHeaderH, laneHeaderH: PLANE_METRICS.laneHeaderW,
  } : PLANE_METRICS;
  /**
   * Report cells occupy a transverse strip above a Horizontal task (left of a
   * Vertical task after transposition). Cells depend on count, never on the
   * measured icon size, so measurement cannot move neighbouring tasks. Past
   * `pillStripMin` cells the strip wraps into a grid (card 31454392), so one
   * heavily-cited task no longer stretches its whole project along the flow.
   */
  const pillFlow = plane.pillReserveW + metrics.pillGapY;
  const pillCross = plane.pillReserveH + metrics.pillGapX;
  const gridOf = (count: number) => pillGrid(count, pillFlow, pillCross);
  const cellOf = (count: number) => {
    const grid = gridOf(count);
    return { w: Math.max(plane.tileCellW, grid.perStrip * pillFlow - metrics.pillGapY),
      h: plane.tileCellH + grid.strips * pillCross };
  };
  // E386: the session's order and the shown tasks' slots, and no ground.
  const anchors = fitPlaneAnchors(given, graph);
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const pillsByTask = reportsByTask(graph.reports, nodeIds);

  const lanes = new Map<string, MapTaskNode[]>();
  for (const node of graph.nodes) {
    const key = laneKeyOf(node);
    const list = lanes.get(key);
    if (list) list.push(node); else lanes.set(key, [node]);
  }

  // Lane order: the session's first-seen order. A lane out of scope keeps its
  // place in the ORDER, so it comes back where it was, but it takes no
  // ground while nothing in it is shown (E386).
  const anchoredLanes = anchors.laneOrder.filter(key => key !== UNASSIGNED_LANE);
  const fresh = [...lanes.keys()]
    .filter(key => key !== UNASSIGNED_LANE && !anchoredLanes.includes(key))
    .sort((a, b) => a.localeCompare(b));
  const laneKeys = [
    ...anchoredLanes, ...fresh, ...(lanes.has(UNASSIGNED_LANE) ? [UNASSIGNED_LANE] : []),
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
  const nextSlots: Record<string, PlaneSlot> = {};
  const nextSegOrder: Record<string, string[]> = {};
  for (const [laneKey, order] of Object.entries(anchors.segOrder)) nextSegOrder[laneKey] = [...order];

  // Annotated: LAYOUT_METRICS is `as const`, so `metrics.originX` has the
  // literal type 32 and an inferred cursor could never be reassigned.
  let cursorY: number = metrics.originY;
  let maxRight: number = metrics.originX;

  for (const laneKey of laneKeys) {
    const laneNodes = lanes.get(laneKey) ?? [];
    // Nothing shown, nothing drawn, no ground held (E386).
    if (laneNodes.length === 0) continue;

    const laneLabel = laneKey === UNASSIGNED_LANE ? 'No project' : laneKey;
    const laneTop = cursorY;
    // The lane's content origin is a DECLARED COLUMN, not a measurement:
    // a measured header width is the one input that changes when the filter
    // changes what is mounted, and the stylesheet holds the header inside the
    // column (`inline-size: 220px`), so every lane's work starts on one axis.
    const headerW = plane.laneHeaderW;
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

    // The session's order wins, and anything new is inserted where the
    // canonical order says it belongs — after the last canonical predecessor
    // already in the order. So a phase declared into the middle of a
    // sequence lands in the middle, and a phase that has merely gone out of
    // scope keeps its place in the ORDER — but only segments with something
    // shown are laid out (E386).
    //
    // A segment with no canonical predecessor in the order goes BEFORE its
    // first canonical successor there, not at the end: since E386 a declared
    // phase with nothing shown is not a segment, so a lane does not always
    // start with its first phases — the archive shows a finished phase that
    // is declared first, a new task lands in an early phase — and that phase
    // must take its declared place rather than trail the lane.
    const order = [...(anchors.segOrder[laneKey] ?? [])];
    for (let index = 0; index < canonical.length; index += 1) {
      const key = canonical[index].key;
      if (order.includes(key)) continue;
      let at = -1;
      for (let back = index - 1; back >= 0 && at < 0; back -= 1) {
        const seen = order.indexOf(canonical[back].key);
        if (seen >= 0) at = seen + 1;
      }
      for (let ahead = index + 1; ahead < canonical.length && at < 0; ahead += 1) {
        const seen = order.indexOf(canonical[ahead].key);
        if (seen >= 0) at = seen;
      }
      order.splice(at < 0 ? order.length : at, 0, key);
    }
    nextSegOrder[laneKey] = order;
    const segments = order.flatMap(key => {
      const segment = canonicalByKey.get(key);
      return segment ? [segment] : [];
    });

    // One header strip for the whole lane, so rows line up ACROSS segments:
    // a connector between two phase boxes sits on the same row grid as the
    // tasks it connects. DECLARED, like every other cell: a measured chip
    // height put this lane's first tile row at the mercy of which chips had
    // reported by then.
    let headerH = 0;
    for (const segment of segments) {
      if (segment.kind !== 'phase') continue;
      headerH = Math.max(headerH, Math.max(metrics.bandHeaderMinH, plane.chipCellH));
    }
    // The lane caption's ground sits above the FIRST shelf only; every shelf
    // carries its own band-header strip, so its phases label themselves.
    const captionH = vertical ? 0 : plane.captionHeaderH;
    const bandHeaderH = vertical ? 0 : Math.max(headerH, plane.captionHeaderH);

    // PASS 1 — every segment's lattice. Nothing here depends on WHERE the
    // segment stands, so the shelf planner below can read each segment's
    // extent before any of them is placed.
    // Each segment's dependency edges, bucketed once: the replay places a
    // segment once per generation, and the whole estate's edge list is not
    // something to walk that many times.
    const segmentOfNode = new Map<string, string>();
    for (const segment of segments) for (const node of segment.nodes) segmentOfNode.set(node.id, segment.key);
    const edgesBySegment = new Map<string, MapEdge[]>();
    for (const edge of graph.edges) {
      if (edge.kind !== 'dependency') continue;
      const key = segmentOfNode.get(edge.from);
      if (key === undefined || segmentOfNode.get(edge.to) !== key) continue;
      const list = edgesBySegment.get(key);
      if (list) list.push(edge); else edgesBySegment.set(key, [edge]);
    }
    const plans = segments.map(segment => {
      const segment_ = segKeyOf(laneKey, segment.key);
      const { slots, gens, ords } = replaySlots(segment_, segment.nodes, depths, anchors,
        edgesBySegment.get(segment.key) ?? []);
      for (const node of segment.nodes) {
        const slot = slots.get(node.id)!;
        nextSlots[node.id] = { seg: segment_, col: slot.col, row: slot.row,
          gen: gens.get(node.id)!, ord: ords.get(node.id)! };
      }

      // Column widths and row heights are the DECLARED cells their occupants
      // need, and nothing else (E386): a column or row with no shown card in
      // it does not exist after the replay (`replaySlots`), so the segment is
      // exactly as big as the cards it holds.
      //
      // The cell depends on the task's pill COUNT and on nothing that a
      // render can change. These were the MEASURED occupants until round 2;
      // a cell that reads the size map grows when a tile is measured for the
      // first time, and a filter decides which tiles that is.
      const wantCol = new Map<number, number>();
      const wantRow = new Map<number, number>();
      let maxCol = -1;
      let maxRow = -1;
      for (const node of segment.nodes) {
        const slot = slots.get(node.id)!;
        const cell = cellOf(pillsByTask.get(node.id)?.length ?? 0);
        maxCol = Math.max(maxCol, slot.col);
        maxRow = Math.max(maxRow, slot.row);
        wantCol.set(slot.col, Math.max(wantCol.get(slot.col) ?? 0, cell.w));
        wantRow.set(slot.row, Math.max(wantRow.get(slot.row) ?? 0, cell.h));
      }
      const colWidth: number[] = [];
      for (let col = 0; col <= maxCol; col += 1) {
        colWidth.push(Math.max(plane.tileCellW, wantCol.get(col) ?? 0));
      }
      const rowHeight: number[] = [];
      for (let row = 0; row <= maxRow; row += 1) {
        rowHeight.push(Math.max(plane.tileCellH, wantRow.get(row) ?? 0));
      }

      const phase = segment.kind === 'phase';
      const padX = phase ? plane.bandPadX : 0;
      const padY = phase ? plane.bandPadY : 0;
      const lead = padX + (vertical && phase ? plane.captionHeaderH : 0);
      let span = lead;
      for (let col = 0; col <= maxCol; col += 1) span += colWidth[col] + metrics.tileGapX;
      const contentFlow = maxCol >= 0 ? span - metrics.tileGapX : padX;
      let depth = padY;
      for (let row = 0; row <= maxRow; row += 1) depth += rowHeight[row] + metrics.tileGapY;
      const contentCross = maxRow >= 0 ? depth - metrics.tileGapY : padY;
      // A phase band adds its padding on the far side too.
      const flowW = contentFlow + padX;
      const crossH = contentCross + padY;
      return { segment, key: segment_, slots, colWidth, rowHeight, maxCol, maxRow,
        padX, padY, lead, flowW, crossH };
    });

    /* SHELVES (card 31454392) — the lane's aspect at Fit.
     *
     * A lane used to be ONE run of segments along the flow axis however many
     * it held, so a project with many phases or long dependency chains read
     * as a hairline at Fit (production shape: 133,552 x 2,112 units, 223 tasks).
     * The planner reads the lane in the declared canvas and, only when its
     * tasks would land under `shelfMinTilePx`, wraps its segments onto
     * shelves stacked across the flow — left to right then the next shelf
     * down (Horizontal), top to bottom then the next shelf right (Vertical),
     * declared order throughout. It keeps the shelf count that frames the
     * tasks largest, so a lane that wrapping cannot help stays as it was.
     *
     * E386: the plan is a function of what is SHOWN and is made afresh on
     * every layout; nothing about it is remembered. A shelf is exactly as
     * deep as its deepest segment, so hiding work gives the depth back. */
    const shelfGap = plane.segGapX;
    const fitShelf = (content: number) => quantize(content, plane.laneQuantumY);
    const shelfContent = (members: readonly number[], first: boolean) =>
      (first ? captionH : 0) + bandHeaderH + Math.max(0, ...members);
    const shelvesOf = (shelf: readonly number[]) => {
      const count = shelf.length ? shelf[shelf.length - 1] + 1 : 1;
      const lengths = new Array<number>(count).fill(0);
      const depths_ = Array.from({ length: count }, () => [] as number[]);
      shelf.forEach((s, i) => {
        lengths[s] += (lengths[s] ? shelfGap : 0) + plans[i].flowW;
        depths_[s].push(plans[i].crossH);
      });
      return { count, lengths, contents: depths_.map((d, k) => shelfContent(d, k === 0)) };
    };
    const headFlow = headerW + metrics.laneHeaderGapX;
    // planeContentBounds frames the project container (16 out on every side)
    // with the origin margin on both ends.
    const frame = 32 + 2 * metrics.originX;
    const fitScale = (shelf: readonly number[]) => {
      const { count, lengths, contents } = shelvesOf(shelf);
      let cross = 0;
      for (let k = 0; k < count - 1; k += 1) cross += fitShelf(contents[k]) + shelfGap;
      cross = Math.max(cross + contents[count - 1], plane.laneHeaderH);
      const flow = headFlow + Math.max(...lengths);
      const [w, h] = vertical ? [cross + frame, flow + frame] : [flow + frame, cross + frame];
      return Math.min(0.8 * plane.shelfViewW / w, 0.8 * plane.shelfViewH / h);
    };
    const pack = (limit: number) => {
      const shelf: number[] = [];
      let s = 0;
      let length = 0;
      for (const plan of plans) {
        if (length > 0 && length + shelfGap + plan.flowW > limit) { s += 1; length = 0; }
        length += (length ? shelfGap : 0) + plan.flowW;
        shelf.push(s);
      }
      return shelf;
    };

    let shelf: number[] = plans.map(() => 0);
    if (wrap && plans.length > 1) {
      let best = fitScale(shelf);
      if (best * FALLBACK_TILE.h < plane.shelfMinTilePx) {
        // Every shelf a greedy pack can produce is a run of consecutive
        // segments, so the run lengths are the only limits worth trying.
        // Ascending, so of two limits that frame the lane equally the
        // shorter, more compact one is kept. A lane with very many segments
        // tries the runs that start or end it only, which bounds the planner
        // at a quadratic in segments rather than a cubic.
        const limits = new Set<number>();
        const every = plans.length <= 48;
        for (let from = 0; from < plans.length; from += 1) {
          let run = 0;
          for (let to = from; to < plans.length; to += 1) {
            run += (to > from ? shelfGap : 0) + plans[to].flowW;
            if (every || from === 0 || to === plans.length - 1) limits.add(run);
          }
        }
        for (const limit of [...limits].sort((a, b) => a - b)) {
          const candidate = pack(limit);
          if (candidate[candidate.length - 1] === 0) continue;
          const scale = fitScale(candidate);
          if (scale > best) { best = scale; shelf = candidate; }
        }
      }
    }

    const { count: shelfCount, contents: shelfContents } = shelvesOf(shelf);
    const shelfTop: number[] = [laneTop];
    for (let k = 1; k < shelfCount; k += 1) {
      shelfTop.push(shelfTop[k - 1] + fitShelf(shelfContents[k - 1]) + shelfGap);
    }

    // PASS 2 — positions, shelf by shelf, in declared order.
    const contentTopOf = (k: number) => shelfTop[k] + (k === 0 ? captionH : 0) + bandHeaderH;
    let laneBottom = contentTopOf(0);
    let laneRight = laneContentX;
    let segX = laneContentX;

    plans.forEach((plan, index) => {
      const { segment, slots, colWidth, rowHeight, maxCol, maxRow, padX, padY } = plan;
      const k = shelf[index];
      if (index > 0 && k !== shelf[index - 1]) segX = laneContentX;
      const phaseTop = shelfTop[k] + (k === 0 ? captionH : 0);
      const contentTop = contentTopOf(k);
      const colX = new Map<number, number>();
      let cursorX = segX + plan.lead;
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
        const reports = pillsByTask.get(node.id) ?? [];
        const grid = gridOf(reports.length);
        const y = cellY + grid.strips * pillCross;
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
        reports.forEach((report, cell) => {
          const pillId = `pill:${report.id}:${node.id}`;
          const measuredPill=sizeOf(pillId,sizes,FALLBACK_PILL);
          const pillSize=vertical?{w:measuredPill.h,h:measuredPill.w}:measuredPill;
          // Each icon has a fixed slot above its task — strip by strip, in
          // Report order — and its measured box supplies the visible
          // connector endpoint, not the cell reserve.
          pillElements.push({
            kind: 'pill', id: pillId, reportId: report.id, title: report.title,
            taskId: node.id,
            x: x + (cell % grid.perStrip) * pillFlow,
            y: cellY + Math.floor(cell / grid.perStrip) * pillCross,
            w: Math.min(plane.pillReserveW,pillSize.w), h: Math.min(plane.pillReserveH,pillSize.h),
          });
        });
      }

      // The extent is the lattice its cards stand in. The pills are INSIDE
      // the lattice — their strip is part of the cell their task needs — so
      // nothing measured reaches past the column that contains it.
      const contentBottom = maxRow >= 0
        ? rowY.get(maxRow)! + rowHeight[maxRow]
        : contentTop + padY;

      if (segment.kind === 'phase') {
        const chipId = `chip:band:${laneKey}:${segment.bandKey}`;
        // Clause 2: the container occupies the REGION its contents occupy.
        // Its box is derived from the tiles, never assumed — which is what
        // makes it the honest picture of scope when it becomes the phase
        // tile.
        //
        // THE CHIP IS NOT IN THIS. It used to be — the box was widened to
        // contain its label — and that is the live +94px, measured on the
        // portal and named here so it cannot come back: a status filter
        // changes the estate's extent, the fit changes the scale, the scale
        // crosses a §5 detail band, the chip's goal line expands, the chip
        // measures 265 instead of 107, and the phase box grows from 202 to
        // 297 with the tile beyond it moving 95. A container is its CONTENTS'
        // region (clause 2); the label it carries is held inside that region
        // rather than allowed to set it.
        const band: PlacedBand = {
          kind: 'band',
          id: `band:${laneKey}:${segment.bandKey}`,
          label: segment.label,
          goal: segment.phase ? segment.phase.goal : null,
          laneId: laneKey,
          x: segX,
          y: phaseTop,
          w: plan.flowW,
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
        segX = segX + plan.flowW + plane.segGapX;
        laneRight = Math.max(laneRight, segX - plane.segGapX);
        laneBottom = Math.max(laneBottom, contentBottom);
      }
      elements.push(...tiles, ...pillElements);
    });

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
      // Keep the border clear of both unphased tasks and nested phases.
      // Expand only the ground: task homes and route anchors stay stable.
      x: metrics.originX - 16,
      y: laneTop - 16,
      w: Math.max(laneRight, metrics.originX + headerW) - metrics.originX + 32,
      h: contentH + 32,
      facts: aggregateFactsOf(laneNodes),
      taskIds: laneNodes.map(node => node.id),
    };
    elements.push(container);

    // The lane takes the depth it paints, on the estate's 8px rhythm, and
    // nothing more (E386): no headroom is reserved, because nothing is kept.
    maxRight = Math.max(maxRight, laneRight);
    cursorY = laneTop + quantize(contentH, plane.laneQuantumY) + metrics.laneGapY;
  }

  return {
    elements,
    width: maxRight + metrics.originX,
    height: Math.max(metrics.originY, cursorY - metrics.laneGapY + metrics.originY),
    anchors: {
      version: 1,
      laneOrder: laneKeys.filter(key => key !== UNASSIGNED_LANE),
      segOrder: nextSegOrder,
      slots: nextSlots,
    },
  };
}

/* ----------------------------------------------------------------------
 * PERSISTENCE — retired by owner ruling E386.
 *
 * The layout record used to be written to the browser's localStorage so a
 * reload restored the same world, and its monotone reservations came back
 * with it: an area grown by "show archived" stayed grown after a reload.
 * E386: nothing about the layout survives a reload. The record lives in the
 * Map's memory for the session; the browser copy is never written, never
 * read (there is no parser for it any more), and the copies earlier releases
 * left behind are removed on load.
 * ---------------------------------------------------------------------- */

/** The key earlier releases stored the layout record under (horizontal; the
 *  other organizations appended `:<organization>`), and its v1 predecessor. */
export const PLANE_ANCHOR_STORAGE_KEY = 'relayhall_map_plane_anchors_v2';
const LEGACY_PLANE_ANCHOR_STORAGE_KEY = 'relayhall_map_plane_anchors';

const isStoredLayoutKey = (key: string) => [PLANE_ANCHOR_STORAGE_KEY, LEGACY_PLANE_ANCHOR_STORAGE_KEY]
  .some(base => key === base || key.startsWith(`${base}:`));

/**
 * The one-time cleanup E386 asks for: remove every layout record an earlier
 * release stored, for every organization, WITHOUT READING IT — the keys are
 * enumerated and removed, and no value is ever fetched. Other keys are left
 * alone. A storage that refuses (privacy mode, a sandbox) must never break
 * the Map, so it swallows; it returns how many records it removed.
 */
export function clearStoredPlaneAnchors(storage?: Storage): number {
  try {
    const store = storage ?? localStorage;
    const doomed: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && isStoredLayoutKey(key)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
    return doomed.length;
  } catch {
    return 0;
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
 * Each handoff uses the screen space its next readable representation needs:
 *
 *   40–58px: phase regions hand over to a project summary.
 *   96–136px: task cards hand over to a phase summary. Task titles need
 *            substantially more room than screen-space aggregate captions.
 *
 * Between them the layers CROSS-FADE, and their three opacities SUM TO ONE
 * at every scale — which is the mechanical form of A2's governing principle
 * that "a zoom level that shows nothing useful is a defect": no scale exists
 * at which the ink is missing, and none at which it is doubled.
 * ---------------------------------------------------------------------- */

export const CROSSFADE_PX = { merged: 40, split: 58 } as const;
/** A task title needs more room than a phase's screen-space caption. */
export const TASK_CROSSFADE_PX = { merged: 96, split: 136 } as const;

/**
 * How much of the CONTAINER shows, given the on-screen width of the children
 * it stands for: 1 when they have shrunk to the dot floor, 0 while they are
 * whole, linear in between.
 */
export function containerAlpha(childOnScreenPx: number,
  thresholds: { merged: number; split: number } = CROSSFADE_PX): number {
  if (!Number.isFinite(childOnScreenPx) || childOnScreenPx <= thresholds.merged) return 1;
  if (childOnScreenPx >= thresholds.split) return 0;
  return (thresholds.split - childOnScreenPx) / (thresholds.split - thresholds.merged);
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
    const alpha = childWidths.length ? containerAlpha(mean(childWidths) * scale,
      bandWidthsByLane.has(container.laneId) ? CROSSFADE_PX : TASK_CROSSFADE_PX) : 0;
    project.set(container.id, alpha);
    projectOfLane.set(container.laneId, alpha);
  }

  const phase = new Map<string, number>();
  const phaseOfBand = new Map<string, number>();
  for (const band of bands) {
    const own = tileWidthsByBand.get(band.id) ?? [];
    const alpha = own.length ? containerAlpha(mean(own) * scale, TASK_CROSSFADE_PX) : 0;
    phaseOfBand.set(band.id, alpha);
    phase.set(band.id, alpha * (1 - (projectOfLane.get(band.laneId) ?? 0)));
  }

  const task = new Map<string, number>();
  for (const tile of tiles) {
    // Owner preview: retain task geography independently of container captions.
    // Fade only across 4–10 screen pixels, not when a phase label appears.
    task.set(tile.id, taskShapeAlpha(Math.min(tile.w, tile.h) * scale));
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

/** Camera bounds exclude reserved homes that currently contain no visible work.
 * Filtering changes the camera's Fit target, never the anchored coordinates. */
export function planeContentBounds(elements: readonly PlacedElement[], ground: readonly Box[] = []): Box {
  const regions = elements.filter(e => e.kind === 'container');
  const content = regions.length ? [...regions,...elements.filter(e=>e.kind==='tile'||e.kind==='pill'||e.kind==='chip'),...ground] : elements.filter(e => e.kind === 'tile');
  if (!content.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x = Math.min(...content.map(e => e.x)) - LAYOUT_METRICS.originX;
  const y = Math.min(...content.map(e => e.y)) - LAYOUT_METRICS.originY;
  return { x, y,
    w: Math.max(...content.map(e => e.x + e.w)) + LAYOUT_METRICS.originX - x,
    h: Math.max(...content.map(e => e.y + e.h)) + LAYOUT_METRICS.originY - y };
}

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
export const PLANE_DETAIL_PX = { full: 192, compact: 136, aggregate: 96 } as const;
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
  const flow = layoutHorizontalPlane(graph, sizes, anchors, true, true);
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
    : layoutHorizontalPlane(graph, sizes, anchors, false, true);
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

/** Ordered retained geography shared by every Organic region in one layout.
 * Keep exact prefix membership: owner names may themselves contain delimiters.
 * Hidden cells and missing-origin behavior are the persisted-world contract. */
export function organicRoutingObstacles(
  allHomes: Record<string, Box>, localHomes: Record<string, Box>,
): Array<{owner:string;box:Box}> {
  const localEntries=Object.entries(localHomes);
  const foreign: Array<{owner:string;box:Box}>=[];
  for(const [owner,home] of Object.entries(allHomes)) {
    if(owner===ORGANIC_CORE){foreign.push({owner,box:home});continue;}
    foreign.push({owner,box:{...home,w:Math.min(home.w,1024),h:PLANE_METRICS.captionHeaderH}});
    const origin=localHomes[owner+'\u0000origin'];
    if(!origin)continue;
    for(const [key,box] of localEntries)if(key.startsWith(owner+'\u0000')&&key!==owner+'\u0000origin')
      // Territory paints a 24-unit apron around each retained cell. The
      // following router inflation adds the corridor/rounding clearance.
      foreign.push({owner,box:{x:box.x+home.x+origin.x-24,y:box.y+home.y+origin.y-24,w:box.w+48,h:box.h+48}});
  }
  return foreign;
}

/** A3: archived history at the centre, live work growing outward in branches.
 * Phase clusters retain their anchored task lattice. Dependency-connected phases
 * form arms; independent phases fork. Seeded angular placement supplies the initial
 * homes, and local outward separation resolves measured boxes. (E386: nothing
 * is saved from one layout to the next; see the fit below.)
 * No zoom value enters this function. */
export function layoutOrganicPlane(graph: MapGraph, sizes: SizeMap,
  given: MapPlaneAnchors = EMPTY_PLANE_ANCHORS, radial = false): PlaneLayoutResult {
  // E386, round-1 review B2: Organic and Radial keep the session's ORDER and
  // nothing they placed. Every home, cell, angle and the archive core is
  // placed afresh from what is shown, so a region (and the core) is exactly
  // as big as its shown work, and hiding archived work gives back every
  // rectangle showing it took. The retention paths below still run; with the
  // fitted record they find nothing held and place from scratch.
  const anchors = fitPlaneAnchors(given, graph);
  const placement = radial ? graph : organicPlaneGraph(graph);
  const base = layoutHorizontalPlane(placement, sizes, anchors, false, false);
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
  let core: Box = { x: oldCore?.x ?? 0, y: oldCore?.y ?? 0,
    w: Math.max(diameter,oldCore?.w ?? 0), h: Math.max(diameter,oldCore?.h ?? 0) };
  let archiveDrift=false;
  let archiveRecovery=false;
  const archiveScales:Record<string,number>={};
  let archiveContent:PlacedElement[]=[];
  const archivePrefix=ORGANIC_CORE+'\u0000archiveBlock\u0000';
  const scalePrefix=ORGANIC_CORE+'\u0000archiveScale\u0000';
  if(!radial) {
    // Circle clearance includes retained captions, phases, task/report cells,
    // including temporarily filtered live work. It is not a tile-only test.
    const foreign:Box[]=[];
    const foreignLocalEntries=Object.entries(localHomes);
    for(const [id,home] of Object.entries(homes)) {
      if(id===ORGANIC_CORE)continue;
      foreign.push({...home,w:Math.min(home.w,1024),h:PLANE_METRICS.captionHeaderH});
      const origin=localHomes[id+'\u0000origin'];
      if(!origin)continue;
      for(const [key,box] of foreignLocalEntries)
        if(key.startsWith(id+'\u0000')&&key!==id+'\u0000origin')
          foreign.push({...box,x:home.x+origin.x+box.x,y:home.y+origin.y+box.y});
    }
    const groups=coreContents.filter((e):e is PlacedTile=>e.kind==='tile').map(tile=> {
      const content=coreContents.filter(e=>e.id===tile.id||(e.kind==='pill'&&e.taskId===tile.id));
      // Reserve declared cells, not first-mounted ink. Semantic zoom admits
      // previously unmeasured cards; that must not requeue the same archived
      // cohort into a larger circle and move it away from the reader.
      const cells=content.map(e=>({...e,w:e.kind==='tile'?PLANE_METRICS.tileCellW:PLANE_METRICS.pillReserveW,
        h:e.kind==='tile'?PLANE_METRICS.tileCellH:PLANE_METRICS.pillReserveH}));
      return {id:tile.id,content,box:boundsOf(cells)};
    });
    const retained:ArchiveBlock[]=Object.entries(localHomes).filter(([key])=>key.startsWith(archivePrefix))
      .map(([key,box])=>({id:key.slice(archivePrefix.length),...box,scale:localHomes[scalePrefix+key.slice(archivePrefix.length)]?.x??1}));
    const pending:ArchiveBlock[]=[];
    for(const group of groups) {
      const found=retained.findIndex(b=>b.id===group.id);
      if(found>=0&&retained[found].w/(retained[found].scale??1)+.001>=group.box.w
        &&retained[found].h/(retained[found].scale??1)+.001>=group.box.h)continue;
      if(found>=0){retained.splice(found,1);archiveDrift=true;}
      pending.push({id:group.id,...group.box});
    }
    const placed=placeArchiveCore(oldCore??{x:0,y:0,w:1024,h:1024},retained,pending,foreign);
    // Derive ports/routes from the same six-decimal circle stored for reload.
    // Rounding only the final result leaves first-render SVG path strings in
    // a different numeric frame from their persisted successor.
    const q=(n:number)=>Math.round(n*1e6)/1e6;
    core={x:q(placed.circle.x),y:q(placed.circle.y),w:q(placed.circle.w),h:q(placed.circle.h)};
    archiveDrift ||= placed.drift;archiveRecovery=placed.recovered;
    for(const block of placed.blocks) {
      localHomes[archivePrefix+block.id]={x:block.x,y:block.y,w:block.w,h:block.h};
      localHomes[scalePrefix+block.id]={x:block.scale??1,y:0,w:0,h:0};
    }
    for(const group of groups) {
      const block=placed.blocks.find(b=>b.id===group.id)!;
      const scale=block.scale??1;
      archiveContent.push(...group.content.map(e=>{
        archiveScales[e.id]=scale;
        return {...e,x:block.x+(e.x-group.box.x)*scale,y:block.y+(e.y-group.box.y)*scale,w:e.w*scale,h:e.h*scale};
      }));
    }
  }
  const cx=core.x+core.w/2, cy=core.y+core.h/2;
  allHomes[ORGANIC_CORE]=core;
  if (archive) {
    const content=radial?moveElements(coreContents,cx-archiveBounds.w/2-archiveBounds.x,
      cy-(archiveBounds.h-PLANE_METRICS.captionHeaderH)/2-archiveBounds.y):archiveContent;
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
  // A retained project's caption is a home, not a rectangular exclusion
  // covering every possible extension. Reserve actual retained cells even
  // when their projects/phases are currently filtered out.
  const worldOccupied: Box[]=[core];
  const occupiedLocalEntries=Object.entries(localHomes);
  for(const [id,home] of Object.entries(homes)) {
    if(id===ORGANIC_CORE)continue;
    worldOccupied.push({...home,w:Math.min(home.w,1024),h:PLANE_METRICS.captionHeaderH});
    const origin=localHomes[id+'\u0000origin'];
    if(!origin)continue;
    for(const [key,box] of occupiedLocalEntries) {
      if(key.startsWith(id+'\u0000')&&key!==id+'\u0000origin')
        worldOccupied.push({...box,x:home.x+origin.x+box.x,y:home.y+origin.y+box.y});
    }
  }
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
        ?? (radial ? [...assigned.values()].at(-1) : undefined);
      const arm=parent&&(!parents.length||!continued.has(parent.arm))?parent.arm:arms++;
      if(parent) continued.add(parent.arm);
      assigned.set(cluster.id,radial?{depth:assigned.size,arm:0}:{depth:parent?parent.depth+1:0,arm});
    }
    const pitchY=Math.max(1,...clusters.map(c=>c.box.h))+64;
    const pitchX=Math.max(1,...clusters.map(c=>c.box.w))+64;
    const roots=clusters.filter(c=>!(incoming.get(c.id)?.length));
    // Independent phases share a compact initial region, not a fabricated
    // predecessor chain. World-space cells do not depend on zoom/viewport.
    const rootColumns=Math.max(1,Math.ceil(Math.sqrt(roots.length*pitchY/pitchX)));
    const heldLocal=Object.entries(localHomes).filter(([key])=>
      key.startsWith(project.laneId+'\u0000')&&key!==project.laneId+'\u0000origin').map(([,box])=>box);
    const angle=Math.round((angles[project.laneId] ?? (-Math.PI/2+2*Math.PI*projectIndex/Math.max(1,projects.length)
      +(seedOf(project.laneId)/0xffffffff-0.5)*0.12))*1e6)/1e6;
    angles[project.laneId]=angle;
    const local: PlacedElement[]=[];
    const localBoxes: Box[]=[];
    const extensions: Array<Box & {clusterIndex:number}>=[];
    const localBranches: Array<readonly [number,number,number,number]>=[];
    for(const cluster of clusters) {
      const position=assigned.get(cluster.id)!;
      const parentId=radial?clusters[clusters.indexOf(cluster)-1]?.id:
        (incoming.get(cluster.id)??[]).find(id=>clusters.findIndex(c=>c.id===id)<clusters.indexOf(cluster));
      const parentBox=parentId?localBoxes[clusters.findIndex(c=>c.id===parentId)]:undefined;
      const support=(b:Box)=>Math.abs(Math.cos(angle))*b.w/2+Math.abs(Math.sin(angle))*b.h/2;
      const parentForward=parentBox?(parentBox.x+parentBox.w/2)*Math.cos(angle)+(parentBox.y+parentBox.h/2)*Math.sin(angle):0;
      const forward=parentForward+(parentBox?support(parentBox):0)+support(cluster.box)+48;
      const side=radial?0:(position.arm-(arms-1)/2)*pitchY;
      const localKey=project.laneId+'\u0000'+cluster.id;
      const saved=localHomes[localKey];
      let box={...cluster.box,x:forward*Math.cos(angle)-side*Math.sin(angle)-cluster.box.w/2,
        y:forward*Math.sin(angle)+side*Math.cos(angle)-cluster.box.h/2};
      if(saved) box=radial?{...box,x:saved.x,y:saved.y,w:Math.max(box.w,saved.w),h:Math.max(box.h,saved.h)}:{...saved};
      if(radial) {
        // Radial retains its original sequential placement/collision policy.
        while(localBoxes.some(other=>boxesOverlap(box,other))) {
          box={...box,x:box.x+Math.cos(angle)*128,y:box.y+Math.sin(angle)*128};
        }
      } else if(!saved && homes[project.laneId] && localHomes[project.laneId+'\u0000origin']) {
        const home=homes[project.laneId],origin=localHomes[project.laneId+'\u0000origin'];
        const ox=home.x+origin.x,oy=home.y+origin.y;
        const occupiedWorld=[...worldOccupied,...localBoxes.map(b=>({...b,x:b.x+ox,y:b.y+oy}))];
        let world={...box,x:Math.max(32,ox+box.x),y:Math.max(32,oy+box.y)};
        if(occupiedWorld.some(other=>boxesOverlap(world,other))) {
          // Finite constructive free frontier. Only the new phase moves;
          // detached extensions retain their real dependency/root connector.
          world={...world,x:Math.max(32,...occupiedWorld.map(b=>b.x+b.w+64))};
        }
        box={...world,x:world.x-ox,y:world.y-oy};
      } else if(!saved && !parentBox) {
        // Reserve every retained cell, including phases later in declared
        // order, before placing a new root. A new root cannot shove a survivor.
        let cell=0;
        do {
          box={...box,x:(cell%rootColumns)*pitchX,y:Math.floor(cell/rootColumns)*pitchY};
          cell+=1;
        } while([...heldLocal,...localBoxes].some(other=>boxesOverlap(box,other)));
      } else if(!saved) {
        // Existing cells win. Only an unplaced dependent cluster searches
        // outward; saved geometry is never displaced by arrival order.
        while([...heldLocal,...localBoxes].some(other=>boxesOverlap(box,other))) {
          box={...box,x:box.x+Math.cos(angle)*128,y:box.y+Math.sin(angle)*128};
        }
      }
      box={x:Math.round(box.x),y:Math.round(box.y),w:Math.ceil(box.w),h:Math.ceil(box.h)};
      localHomes[localKey]=box;
      localBoxes.push(box);
      const content=moveElements(cluster.content,box.x-cluster.box.x,box.y-cluster.box.y);
      const itemKey=(id:string)=>project.laneId+'\u0000item\u0000'+JSON.stringify([cluster.id,id]);
      if(!radial)for(let i=0;i<content.length;i++) {
        const e=content[i],heldItem=localHomes[itemKey(e.id)];
        if((e.kind==='tile'||e.kind==='pill')&&heldItem)content[i]={...e,x:heldItem.x,y:heldItem.y};
      }
      const heldHome=homes[project.laneId],heldOrigin=localHomes[project.laneId+'\u0000origin'];
      if(!radial&&saved&&heldHome&&heldOrigin) {
        const ox=heldHome.x+heldOrigin.x,oy=heldHome.y+heldOrigin.y;
        const taskBlocks=content.filter((e):e is PlacedTile=>e.kind==='tile').map(tile=>{
          const parts=content.filter(e=>e.id===tile.id||(e.kind==='pill'&&e.taskId===tile.id));
          return {id:tile.id,parts,box:boundsOf(parts),key:project.laneId+'\u0000extension\u0000'+JSON.stringify([cluster.id,tile.id])};
        });
        const outside=(b:Box)=>b.x<box.x||b.y<box.y||b.x+b.w>box.x+box.w||b.y+b.h>box.y+box.h;
        const reportBlocks=content.filter((e):e is PlacedReportPill=>e.kind==='pill'&&Boolean(anchors.slots[e.taskId])).map(pill=>
          ({id:pill.id,parts:[pill] as PlacedElement[],box:boundsOf([pill]),key:project.laneId+'\u0000reportExtension\u0000'+JSON.stringify([cluster.id,pill.id])}));
        const freshTasks=taskBlocks.filter(b=>!localHomes[b.key]&&!anchors.slots[b.id]&&outside(b.box));
        const freshReports=reportBlocks.filter(b=>!localHomes[b.key]&&!localHomes[itemKey(b.id)]&&
          (outside(b.box)||content.some(e=>(e.kind==='tile'||e.kind==='pill')&&e.id!==b.id&&boxesOverlap(e,b.box))));
        const fresh=[...freshTasks,...freshReports];
        const cellW=Math.max(1,...fresh.map(b=>b.box.w))+32,cellH=Math.max(1,...fresh.map(b=>b.box.h))+32;
        const columns=Math.max(1,Math.ceil(Math.sqrt(fresh.length*cellH/cellW)));
        // Retained extensions reuse their targets; only new blocks need a frontier.
        const frontier=fresh.length?Math.max(32,...worldOccupied.map(b=>b.x+b.w+64),
          ...localBoxes.map(b=>ox+b.x+b.w+64),...extensions.map(b=>ox+b.x+b.w+64)):0;
        for(const block of [...taskBlocks,...reportBlocks]) {
          const previous=localHomes[block.key],index=fresh.indexOf(block);
          if(!previous&&index<0)continue;
          const target=previous??{...block.box,x:frontier-ox+(index%columns)*cellW,
            y:Math.max(32,oy+box.y)-oy+Math.floor(index/columns)*cellH};
          localHomes[block.key]=target;
          const ids=new Set(block.parts.map(e=>e.id));
          for(let i=0;i<content.length;i++)if(ids.has(content[i].id))
            content[i]={...content[i],x:content[i].x+target.x-block.box.x,y:content[i].y+target.y-block.box.y};
          extensions.push({...target,clusterIndex:clusters.indexOf(cluster)});
          localBranches.push([box.x+box.w/2,box.y+box.h/2,target.x+target.w/2,target.y+target.h/2]);
        }
        // Caption and saved phase ground stay at home; the explicit extension
        // cells carry newly arrived task/report blocks without moving survivors.
        for(let i=0;i<content.length;i++)if(content[i].kind==='band')content[i]={...content[i],w:box.w,h:box.h};
      }
      if(!radial)for(const e of content)if(e.kind==='tile'||e.kind==='pill')
        localHomes[itemKey(e.id)]={x:e.x,y:e.y,w:e.w,h:e.h};
      local.push(...content);
      localBranches.push([parentBox?parentBox.x+parentBox.w/2:0,parentBox?parentBox.y+parentBox.h/2:0,
        box.x+box.w/2,box.y+box.h/2]);
    }
    const extent=boundsOf([...localBoxes,{x:0,y:0,w:1,h:1}]);
    const originKey=project.laneId+'\u0000origin';
    const savedOrigin=localHomes[originKey];
    const dx=!radial&&savedOrigin?savedOrigin.x:Math.max(savedOrigin?.x ?? 0,32-extent.x),
      dy=!radial&&savedOrigin?savedOrigin.y:Math.max(savedOrigin?.y ?? 0,PLANE_METRICS.captionHeaderH-extent.y);
    const w=Math.max(220,extent.x+extent.w+dx+32),h=extent.y+extent.h+dy+32;
    localHomes[originKey]={x:dx,y:dy,w:0,h:0};
    const held=homes[project.laneId];
    let distance=core.w/2+128;
    let at:Box=held&&!radial?{...held}:held?{x:held.x-(dx-(savedOrigin?.x??dx)),y:held.y-(dy-(savedOrigin?.y??dy)),w:Math.max(w,held.w+dx-(savedOrigin?.x??dx)),h:Math.max(h,held.h+dy-(savedOrigin?.y??dy))}:
      {x:cx+distance*Math.cos(angle)-dx,y:cy+distance*Math.sin(angle)-dy,w,h};
    if(!radial&&!held&&worldOccupied.some(other=>boxesOverlap(at,other)))
      at={...at,x:Math.max(32,...worldOccupied.map(b=>b.x+b.w+64)),y:Math.max(32,at.y)};
    while(radial&&occupied.some(other=>boxesOverlap(at,other))) {
      distance+=128;
      at={...at,x:held?at.x+Math.cos(angle)*128:cx+distance*Math.cos(angle)-dx,
        y:held?at.y+Math.sin(angle)*128:cy+distance*Math.sin(angle)-dy};
    }
    // A new branch must not force a global origin translation of an already
    // inhabited world. If its nominal arm runs beyond the retained origin,
    // grow at the available right frontier; existing territories keep home.
    if((radial||!held)&&Object.keys(homes).length && (at.x<32 || at.y<32)) {
      at={...at,x:Math.max(32,...occupied.map(b=>b.x+b.w+128)),y:Math.max(32,at.y)};
    }
    at={x:Math.round(at.x),y:Math.round(at.y),w:Math.ceil(at.w),h:Math.ceil(at.h)};
    occupied.push(at);allHomes[project.laneId]=at;
    worldOccupied.push(...[...localBoxes,...extensions].map(b=>({...b,x:b.x+at.x+dx,y:b.y+at.y+dy})));
    elements.push(...moveElements(local,at.x+dx,at.y+dy),{...project,...at});
    const header=own.find(e=>e.kind==='lane');
    if(header) elements.push({...header,x:at.x,y:at.y});
    const corePort={x:cx+core.w/2*Math.cos(angle),y:cy+core.h/2*Math.sin(angle),w:0,h:0};
    const territory=radial?{x:Math.floor(Math.min(at.x,corePort.x)),y:Math.floor(Math.min(at.y,corePort.y)),
      w:Math.ceil(Math.max(at.x+at.w,corePort.x))-Math.floor(Math.min(at.x,corePort.x)),
      h:Math.ceil(Math.max(at.y+at.h,corePort.y))-Math.floor(Math.min(at.y,corePort.y))}:
      boundsOf([at,corePort,...[...localBoxes,...extensions].map(b=>({...b,x:b.x+at.x+dx,y:b.y+at.y+dy}))]);
    regions.push({laneId:project.laneId,core:false,box:territory,captionBox:at,
      clusters:[...localBoxes.map((b,i)=>({...b,clusterIndex:i})),...extensions].map(({clusterIndex,...b})=>({...b,x:b.x+at.x+dx,y:b.y+at.y+dy,
        ...(clusters[clusterIndex].id!=='connectors'?{phaseId:clusters[clusterIndex].content.find((e):e is PlacedTile=>e.kind==='tile')?.node.phaseId ?? undefined}:{}),
        facts:aggregateFactsOf(clusters[clusterIndex].content.filter((e):e is PlacedTile=>e.kind==='tile').map(e=>e.node))})),
      branches:[[cx+core.w/2*Math.cos(angle),cy+core.h/2*Math.sin(angle),at.x+dx,at.y+dy],...localBranches.map(([x1,y1,x2,y2])=>[x1+at.x+dx,y1+at.y+dy,x2+at.x+dx,y2+at.y+dy] as const)]});
  }
  // Translate the world into the positive quadrant. (Before E386 a retained
  // world was translated once and then held; nothing is retained now, so
  // every world is a new one.)
  const extent=boundsOf(Object.values(allHomes));
  const dx=!radial&&Object.keys(homes).length?0:Math.floor(Math.min(0,extent.x-32)),
    dy=!radial&&Object.keys(homes).length?0:Math.floor(Math.min(0,extent.y-32));
  for(const [id,box] of Object.entries(allHomes)) allHomes[id]={...box,x:box.x-dx,y:box.y-dy};
  if(!radial)for(const [key,box] of Object.entries(localHomes))if(key.startsWith(archivePrefix))
    localHomes[key]={...box,x:box.x-dx,y:box.y-dy};
  const moved=moveElements(elements,-dx,-dy).map(e=>e.kind==='tile'?{...e,node:originals.get(e.id)!}:e);
  const painted=boundsOf(moved);
  const result: PlaneLayoutResult = {elements:moved,width:Math.max(extent.x+extent.w-dx,painted.x+painted.w)+32,
    height:Math.max(extent.y+extent.h-dy,painted.y+painted.h)+32,
    ...(!radial?{archiveDrift,archiveRecovery,archiveScales}:{}),
    anchors:{...base.anchors,organicHomes:allHomes,organicLocal:localHomes,organicAngles:angles},
    organicRegions:regions.map(r=>({...r,box:{...r.box,x:r.box.x-dx,y:r.box.y-dy},
      ...(r.captionBox?{captionBox:{...r.captionBox,x:r.captionBox.x-dx,y:r.captionBox.y-dy}}:{}),
      clusters:r.clusters.map(b=>({...b,x:b.x-dx,y:b.y-dy})),
      branches:r.branches.map(([a,b,c,d])=>[a-dx,b-dy,c-dx,d-dy])}))};
  // A fixed world-unit precision prevents repeated origin translations from
  // accumulating floating-point noise through persistence round trips.
  const routingInventory=radial?[]:organicRoutingObstacles(allHomes,localHomes);
  if(!radial)result.organicRegions=result.organicRegions?.map(region=>{
    if(region.core)return region;
    const caption=region.captionBox!;
    const routed: Array<Array<readonly [number,number]>>=[];
    let blockedBranches=0;
    const blockedRoutes:Array<{d:string;from:readonly [number,number];to:readonly [number,number]}>=[];
    const contains=(b:Box,x:number,y:number)=>x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h;
    const foreign=routingInventory.filter(entry=>entry.owner!==region.laneId);
    for(const [index,[x1,y1,x2,y2]] of region.branches.entries()) {
      const source=index===0?allHomes[ORGANIC_CORE]:region.clusters.find(b=>contains(b,x1,y1))??caption;
      const target=region.clusters.find(b=>contains(b,x2,y2))??caption;
      if(source===target)continue;
      // 12-unit ground radius plus 2 units for rounding. Endpoint identity
      // is resolved before inflation; a clipped router fallback is never fill.
      const obstacles=foreign.filter(v=>!(index===0&&v.owner===ORGANIC_CORE)).map(({box})=>
        ({x:box.x-14,y:box.y-14,w:box.w+28,h:box.h+28}));
      const route=routeFlowEdge(source,target,obstacles,null,'organic');
      if(route.clipped){blockedBranches+=1;blockedRoutes.push({d:route.d,from:[x1,y1],to:[x2,y2]});continue;}
      const values=route.d.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
      const points:Array<readonly [number,number]>=[];
      for(let i=0;i<values.length;i+=2)points.push([values[i],values[i+1]]);
      routed.push(points);
    }
    const ground=boundsOf([region.box,...routed.flatMap(points=>points.map(([x,y])=>({x:x-12,y:y-12,w:24,h:24})))]);
    // Paint strings include quadratic interpolation between canonical ports.
    // Bounds round outward by one persistence unit, never inward across ink.
    const minX=(Math.floor(ground.x*1e6)-1)/1e6,minY=(Math.floor(ground.y*1e6)-1)/1e6;
    const maxX=(Math.ceil((ground.x+ground.w)*1e6)+1)/1e6,maxY=(Math.ceil((ground.y+ground.h)*1e6)+1)/1e6;
    return {...region,box:{x:minX,y:minY,w:maxX-minX,h:maxY-minY},routedBranches:routed,blockedBranches,blockedRoutes};
  });
  result.organicRegions=result.organicRegions?.map(region=>({...region,
    outline:region.core?undefined:organicTerritoryPath(region),
    clusters:region.clusters.map(box=>({...box,outline:organicPhasePath(box,moved.filter(e=>
      (e.kind==='tile'||e.kind==='pill') && e.x>=box.x && e.y>=box.y
      && e.x+e.w<=box.x+box.w && e.y+e.h<=box.y+box.h))}))}));
  if(!radial)for(const region of result.organicRegions??[]) {
    result.width=Math.max(result.width,region.box.x+region.box.w+32);
    result.height=Math.max(result.height,region.box.y+region.box.h+32);
  }
  if(!radial)result.worldBounds=boundsOf([...moved,...(result.organicRegions??[]).map(r=>r.box)]);
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
  const corridor=(x1:number,y1:number,x2:number,y2:number,routed=false)=>{
    const ends=region.clusters.filter(b=>(x1>=b.x&&x1<=b.x+b.w&&y1>=b.y&&y1<=b.y+b.h)
      ||(x2>=b.x&&x2<=b.x+b.w&&y2>=b.y&&y2<=b.y+b.h));
    const radius=routed?12:Math.max(48,Math.min(256,...ends.map(b=>Math.min(b.w,b.h)*0.4)));
    add([...[x1,x2].flatMap((x,i)=>Array.from({length:8},(_,j)=>[
      x+radius*Math.cos(j*Math.PI/4),(i?y2:y1)+radius*Math.sin(j*Math.PI/4)] as Point))]);
  };
  if(region.routedBranches) {
    for(const points of region.routedBranches)for(let i=1;i<points.length;i++)
      corridor(points[i-1][0],points[i-1][1],points[i][0],points[i][1],true);
  } else for(const [a,b,c,d] of region.branches) corridor(a,b,c,d);
  const caption=region.captionBox??root;
  const headerW=Math.min(caption.w,1024);
  rectangle({x:caption.x,y:caption.y,w:headerW,h:Math.min(caption.h,PLANE_METRICS.captionHeaderH)});
  const first=region.branches[1];
  if(first&&!region.routedBranches)corridor(caption.x+headerW/2,caption.y+PLANE_METRICS.captionHeaderH/2,first[0],first[1]);
  // Bound pathological phase counts without losing containment. Dense
  // projects use the enclosing hull; ordinary projects retain their forks.
  if(!region.routedBranches&&(region.clusters.length<=2||polygons.length>128))
    return 'M '+convexHull(polygons.flat()).map(p=>p.join(' ')).join(' L ')+' Z';
  // Preserve the existing bounded union work without filling the empty space
  // between detached cells. Nonzero SVG subpaths paint their actual union.
  if(polygons.length>128)return polygons.map(poly=>'M '+poly.map(p=>p.join(' ')).join(' L ')+' Z').join(' ');
  // Union convex pieces by splitting their boundary at intersections and
  // retaining only exposed segments. This preserves the gaps between arms.
  const cross=(a:Point,b:Point)=>a[0]*b[1]-a[1]*b[0];
  const sub=(a:Point,b:Point):Point=>[a[0]-b[0],a[1]-b[1]];
  const inside=(p:Point,poly:Point[])=>{
    for(let i=0;i<poly.length;i++) {
      const a=poly[i],b=poly[(i+1)%poly.length];
      if(!((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0])>1e-5))return false;
    }
    return true;
  };
  const key=(p:Point)=>p.map(v=>Math.round(v*1e5)/1e5).join(',');
  const segments=new Map<string,[Point,Point]>();
  for(const [index,poly] of polygons.entries())for(let i=0;i<poly.length;i++) {
    const a=poly[i],b=poly[(i+1)%poly.length],v=sub(b,a),cuts=[0,1];
    for(const [otherIndex,other] of polygons.entries())if(otherIndex!==index)
      for(let j=0;j<other.length;j++){
        const c=other[j],d=other[(j+1)%other.length];
        const wx=d[0]-c[0],wy=d[1]-c[1],cax=c[0]-a[0],cay=c[1]-a[1];
        const den=v[0]*wy-v[1]*wx;
        if(Math.abs(den)<1e-8){
          if(Math.abs(cax*v[1]-cay*v[0])<1e-5){
            const length=v[0]*v[0]+v[1]*v[1];
            for(const p of [c,d]){const t=((p[0]-a[0])*v[0]+(p[1]-a[1])*v[1])/length;if(t>0&&t<1)cuts.push(t);}
          }
          continue;
        }
        const t=(cax*wy-cay*wx)/den,u=(cax*v[1]-cay*v[0])/den;
        if(t>0&&t<1&&u>=0&&u<=1)cuts.push(t);
      }
    cuts.sort((x,y)=>x-y);
    for(let j=1;j<cuts.length;j++){
      const lo=cuts[j-1],hi=cuts[j];if(hi-lo<1e-8)continue;
      const point=(t:number):Point=>[a[0]+v[0]*t,a[1]+v[1]*t];
      const midpoint=point((lo+hi)/2);
      if(polygons.some((p,k)=>k!==index&&inside(midpoint,p)))continue;
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

/** Tiny-screen cutoff shared by shapes and their connections. */
export function taskShapeAlpha(shortSidePx: number): number {
  return Math.max(0, Math.min(1, (shortSidePx - 4) / 6));
}
