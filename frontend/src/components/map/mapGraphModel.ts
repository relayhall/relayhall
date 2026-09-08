/**
 * Master-view layout engine — PURE functions only (design 77950a97 §8).
 *
 * One flow logic (§2): tasks group project → phase, ordered by dependency
 * topology within the project. A7a renders it as the DEFAULT **horizontal**
 * organization; A7b adds vertical, radial and organic against this same
 * placement model (owner ruling 037bb84c R3).
 *
 * TWO RULES THIS FILE EXISTS TO OBEY, both learned the hard way from the
 * abandoned attempt (diagnosis 7fa7e605 P3):
 *
 *  1. **Nothing is assumed to have a size.** Every element's box arrives
 *     MEASURED, through `sizes`. The previous attempt hard-coded a 64px tile
 *     height against a real 71–90px and produced three rounds of geometry
 *     "proofs" that were locally true and globally wrong. A missing
 *     measurement is an explicit fallback constant, never a silent guess.
 *  2. **Collision-freedom is a property, not a claim.** `layoutHorizontal`
 *     returns boxes; `findOverlaps` is the independent checker the property
 *     tests run over recorded AND hostile inputs. The engine never asserts
 *     its own correctness.
 */

export interface MapTaskNode {
  id: string;
  title: string;
  status: string;
  priority: string;
  /** Project NAME as the wire emits it (recorded fixture), or null. */
  project: string | null;
  phaseId: string | null;
  updated: string;
  /** Coarse liveness (§3): the working agent's NAME, or null. */
  agent?: string | null;
  /** Subtask progress for the tile bar (§3), or null when there are none. */
  progress?: { done: number; total: number } | null;
}

/** A Report linked to a Task (§3 report pills). */
export interface MapReport {
  id: string;
  taskId: string;
  title: string;
}

export interface MapEdge {
  from: string;
  to: string;
  kind: 'dependency' | 'knowledge';
}

/** Phase identity from the graph read (card 8645e81c). */
export interface MapPhase {
  id: string;
  name: string;
  goal: string | null;
  projectId: string;
  position: number;
}

export interface MapGraph {
  nodes: MapTaskNode[];
  edges: MapEdge[];
  phases: MapPhase[];
  reports?: MapReport[];
}

export interface Box { x: number; y: number; w: number; h: number }

export interface PlacedTile extends Box {
  kind: 'tile';
  id: string;
  node: MapTaskNode;
  /** Dependency depth within its lane: 0 = no unsatisfied upstream. */
  depth: number;
  /**
   * Membership, RECORDED by the continuous-plane engine (amendment
   * §2/§5-A3) rather than searched for afterwards: the cross-fade has to
   * know which container each tile answers to, and deciding that by testing
   * every tile against every container box is a quadratic pass over the
   * estate. Absent from the pre-amendment organizations, which have no
   * cross-fade.
   */
  laneId?: string;
  /** The phase container this tile fades into, or null for a connector task
   *  (A3 clause 3), which fades straight into its project. */
  bandId?: string | null;
}

export interface PlacedBand extends Box {
  kind: 'band';
  id: string;
  /** Phase name, or the synthetic unphased label. */
  label: string;
  goal: string | null;
  laneId: string;
  /**
   * The project's DISPLAY name. A phase tile carries it for the same reason
   * an aggregate node does: "Phase 2" is not an identity, and the seeded
   * estate has 55 of them. Set by the continuous-plane engine, where this
   * band IS the phase container that becomes the phase tile.
   */
  laneLabel?: string;
  /**
   * §1's four answers plus progress for the tasks inside, when this band is
   * the PHASE CONTAINER of the continuous plane (amendment §2/§5-A3 clause
   * 1): zooming out turns the container into the phase tile, and a tile must
   * carry its contents' meaning rather than merely a count (A2).
   */
  facts?: AggregateFacts;
}

/**
 * A PROJECT container on the continuous plane (amendment §2/§5-A3 clauses 1
 * and 2). It is not a node on some other plane: it is the REGION this
 * project's own work occupies in the one world, header included, and it is
 * what the phase containers fade into as the reader zooms out. Its box is
 * derived from its contents, so more work is visibly bigger — the honest
 * picture of scope clause 2 asks for.
 */
export interface PlacedContainer extends Box {
  kind: 'container';
  id: string;
  /** Only the project tier exists today; the phase tier IS the band above. */
  tier: 'project';
  laneId: string;
  label: string;
  laneLabel: string;
  facts: AggregateFacts;
  /** Every Task inside — the roll-up's audit trail, as on AggregateNode. */
  taskIds: readonly string[];
}

export interface PlacedBandChip extends Box {
  kind: 'chip';
  id: string;
  label: string;
  goal: string | null;
  bandId: string;
}

export interface PlacedLaneHeader extends Box {
  kind: 'lane';
  id: string;
  label: string;
  taskCount: number;
  /** The three counters §1 says the Map must answer at a glance, plus the
   *  completion ratio the lane's progress ring renders. */
  completed: number;
  agentsLive: number;
  stuck: number;
  upNext: number;
  progress: number;
}

/**
 * A linked Report (§3). It is a PLACED element, not a decoration hung off the
 * tile: the layout reserves its strip and the overlap checker compares it like
 * anything else. `taskIds` are every in-scope Task it cites — the dashed
 * knowledge edges §3 requires run from this pill to each of them.
 */
export interface PlacedReportPill extends Box {
  kind: 'pill';
  id: string;
  reportId: string;
  title: string;
  /** The Task this pill sits beside, and the one its dashed edge joins. */
  taskId: string;
}

export interface PlacedHull extends Box {
  kind: 'hull';
  /** Same identity a pipeline band carries: `band:<lane>:<band>`. */
  id: string;
  label: string;
  goal: string | null;
  laneId: string;
  /** Closed outline of the annular sector, in plane coordinates. */
  points: ReadonlyArray<readonly [number, number]>;
}

export type PlacedElement =
  | PlacedTile | PlacedBand | PlacedBandChip | PlacedLaneHeader | PlacedReportPill
  | PlacedHull | PlacedContainer
  // The aggregate altitudes place their own nodes, and §2's zero-overlap
  // invariant reaches them for free: findOverlaps compares same-kind pairs, so
  // aggregate-vs-aggregate is checked without a new rule. A Report node at an
  // aggregate altitude is a different kind from the aggregates it converges
  // on, and the checker compares different kinds too unless they are in a
  // containment relationship — which these are not.
  | PlacedAggregate | PlacedAggregateReport;

export interface LayoutResult {
  elements: PlacedElement[];
  width: number;
  height: number;
}

/** Measured boxes, keyed by element id. Absent ⇒ the documented fallback. */
export type SizeMap = Readonly<Record<string, { w: number; h: number }>>;

/**
 * Fallbacks, used ONLY when a measurement is genuinely unavailable (first
 * paint, before the ref callback reports). They are deliberately generous:
 * a too-large fallback spreads the layout and self-corrects on the measured
 * pass, while a too-small one produces overlap — the failure we are
 * engineering against.
 */
export const FALLBACK_TILE = { w: 170, h: 96 } as const;
export const FALLBACK_LANE_HEADER = { w: 170, h: 56 } as const;
export const FALLBACK_CHIP = { w: 132, h: 22 } as const;
export const FALLBACK_PILL = { w: 44, h: 44 } as const;  // the MOBILE touch floor, so the
// pre-measurement pass reserves the largest box the control can paint rather
// than the smallest — under-reserving is what produces overlap.

export const LAYOUT_METRICS = {
  /** Gap between tiles inside a band. */
  tileGapX: 24,
  tileGapY: 16,
  /** Padding inside a phase band, around its tiles. */
  bandPadX: 16,
  bandPadY: 16,
  /** MINIMUM reserved strip at the top of a band for its chip. The strip
      actually used is derived from the chip's MEASURED height — a fixed
      value here would be an assumed size, which is exactly what Rule 1
      forbids and what let a tall chip paint over the first tile. */
  bandHeaderMinH: 30,
  /** Gap between the chip's strip and the first tile row. */
  bandHeaderGapY: 8,
  /** Vertical gap between stacked bands in one lane. */
  bandGapY: 20,
  /** Vertical gap between lanes. */
  laneGapY: 40,
  /** Gap between the lane header and its first band. */
  laneHeaderGapX: 24,
  /** Gap between a tile and its Report pill strip, and between stacked pills. */
  pillGapX: 8,
  pillGapY: 4,
  /** Left/top origin so nothing sits flush against the canvas edge. */
  originX: 32,
  originY: 32,
} as const;

/** The lane a task belongs to. A null project is its own real lane. */
export const UNASSIGNED_LANE = '__no_project__';
/** The band for tasks with no phase — 8 of 14 in the recorded fixture. */
export const UNPHASED_BAND = '__no_phase__';

export const laneKeyOf = (node: MapTaskNode) => node.project ?? UNASSIGNED_LANE;

/**
 * Report pills keyed by the Task they sit beside — one per (report, task) PAIR.
 *
 * An earlier cut placed one pill per REPORT, anchored at the lowest-id task it
 * cited. It read badly: most citing tasks showed no marker at all, and the edge
 * to the single pill ran across the plane and off the viewport (owner
 * walkthrough, 2026-08-17). §3 wants a marker BESIDE ITS TASK and an edge from
 * the Report to every Task it cites; per-pair placement gives both, and every
 * edge stays short and local.
 *
 * Duplicate pairs are collapsed: a report matching through both linkage arms
 * must not become two pills sharing a React key.
 */
export function reportsByTask(
  reports: MapReport[] | undefined,
  nodeIds: Set<string>,
): Map<string, Array<{ id: string; title: string; taskId: string }>> {
  const byTask = new Map<string, Array<{ id: string; title: string; taskId: string }>>();
  const seen = new Set<string>();
  for (const report of reports ?? []) {
    if (!nodeIds.has(report.taskId)) continue;
    const pairKey = `${report.id}\u0000${report.taskId}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const list = byTask.get(report.taskId) ?? [];
    list.push({ id: report.id, title: report.title, taskId: report.taskId });
    byTask.set(report.taskId, list);
  }
  // Deterministic order within a task, so the same graph lays out identically.
  for (const list of byTask.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return byTask;
}
export const bandKeyOf = (node: MapTaskNode) => node.phaseId ?? UNPHASED_BAND;

export const sizeOf = (id: string, sizes: SizeMap, fallback: { w: number; h: number }) =>
  // Own-property only: an id like `constructor` or `toString` would
  // otherwise resolve to an Object.prototype member and produce a NaN box.
  (Object.prototype.hasOwnProperty.call(sizes, id) ? sizes[id] : undefined) ?? fallback;

/**
 * Dependency depth within a set of ids: 0 for a task with no in-set
 * upstream, otherwise 1 + the deepest upstream. Cycles cannot deadlock the
 * walk — a node already on the stack contributes nothing, so a cyclic
 * component collapses to the depth of its entry point rather than hanging or
 * throwing. Real boards do contain accidental cycles.
 */
export function computeDepths(ids: string[], edges: MapEdge[]): Map<string, number> {
  const inSet = new Set(ids);
  const upstream = new Map<string, string[]>();
  for (const id of ids) upstream.set(id, []);
  for (const edge of edges) {
    if (edge.kind !== 'dependency') continue;
    // `from` depends on `to` (the graph read emits task_id → depends_on).
    // A self-dependency orders nothing.
    if (edge.from === edge.to) continue;
    if (!inSet.has(edge.from) || !inSet.has(edge.to)) continue;
    upstream.get(edge.from)!.push(edge.to);
  }

  // Cyclic components collapse to ONE depth. Walking a cycle naively made
  // depth grow with the cycle's length and — worse — depend on the order
  // the server happened to return nodes in, so identical data could land in
  // different columns. Tarjan gives a deterministic component id; every
  // member of a cycle then shares the component's depth.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentOf = new Map<string, number>();
  const members: string[][] = [];
  let counter = 0;

  const sorted = [...ids].sort();
  const strongConnect = (root: string) => {
    // Iterative: a 10,000-deep chain must not risk the call stack.
    const work: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    index.set(root, counter); low.set(root, counter); counter += 1;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const parents = upstream.get(frame.id) ?? [];
      if (frame.next < parents.length) {
        const parent = parents[frame.next];
        frame.next += 1;
        if (!index.has(parent)) {
          index.set(parent, counter); low.set(parent, counter); counter += 1;
          stack.push(parent); onStack.add(parent);
          work.push({ id: parent, next: 0 });
        } else if (onStack.has(parent)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(parent)!));
        }
        continue;
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const group: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          componentOf.set(member, members.length);
          group.push(member);
          if (member === frame.id) break;
        }
        members.push(group);
      }
      work.pop();
      const parentFrame = work[work.length - 1];
      if (parentFrame) {
        low.set(parentFrame.id, Math.min(low.get(parentFrame.id)!, low.get(frame.id)!));
      }
    }
  };
  for (const id of sorted) if (!index.has(id)) strongConnect(id);

  // Depth over the (acyclic) component graph, memoized.
  const componentDepth = new Map<number, number>();
  const componentUpstream = new Map<number, Set<number>>();
  for (const id of sorted) {
    const from = componentOf.get(id)!;
    if (!componentUpstream.has(from)) componentUpstream.set(from, new Set());
    for (const parent of upstream.get(id) ?? []) {
      const to = componentOf.get(parent)!;
      if (to !== from) componentUpstream.get(from)!.add(to);
    }
  }
  const componentWalk = (component: number): number => {
    const known = componentDepth.get(component);
    if (known !== undefined) return known;
    componentDepth.set(component, 0); // guard against any residual cycle
    let depth = 0;
    for (const parent of componentUpstream.get(component) ?? []) {
      depth = Math.max(depth, componentWalk(parent) + 1);
    }
    componentDepth.set(component, depth);
    return depth;
  };

  const depths = new Map<string, number>();
  for (const id of sorted) depths.set(id, componentWalk(componentOf.get(id)!));
  return depths;
}

/** Stable ordering so a re-layout of identical input is identical output. */
const byPositionThenName = (a: { position: number; name: string }, b: { position: number; name: string }) =>
  a.position - b.position || a.name.localeCompare(b.name) ;

/**
 * Horizontal organization (§2): projects are horizontal LANES; phases are
 * stacked BANDS within a lane; inside a band, dependency depth maps to
 * COLUMNS left→right, so completed work pools left and "next" sits right.
 *
 * Every returned box is derived from `sizes`; the band and lane boxes are
 * computed FROM their contents, never assumed, which is what makes the
 * zero-overlap property hold by construction rather than by assertion.
 */
export function layoutHorizontal(graph: MapGraph, sizes: SizeMap): LayoutResult {
  const { nodes, edges, phases } = graph;
  const metrics = LAYOUT_METRICS;
  const phaseById = new Map(phases.map(phase => [phase.id, phase]));

  // Group into lanes, then bands, preserving deterministic order.
  const lanes = new Map<string, Map<string, MapTaskNode[]>>();
  for (const node of nodes) {
    const laneKey = laneKeyOf(node);
    const bandKey = bandKeyOf(node);
    if (!lanes.has(laneKey)) lanes.set(laneKey, new Map());
    const bands = lanes.get(laneKey)!;
    if (!bands.has(bandKey)) bands.set(bandKey, []);
    bands.get(bandKey)!.push(node);
  }

  const laneKeys = [...lanes.keys()].sort((a, b) => {
    // The unassigned lane always sinks to the bottom; it is a real lane, not
    // a hidden bucket — tasks in it must stay reachable.
    if (a === UNASSIGNED_LANE) return 1;
    if (b === UNASSIGNED_LANE) return -1;
    return a.localeCompare(b);
  });

  const elements: PlacedElement[] = [];
  let cursorY: number = metrics.originY;
  let maxRight: number = metrics.originX;
  // §3 Report pills, resolved once: one per report, anchored deterministically.
  const pillsByTask = reportsByTask(graph.reports, new Set(graph.nodes.map(node => node.id)));

  for (const laneKey of laneKeys) {
    const bands = lanes.get(laneKey)!;
    const laneLabel = laneKey === UNASSIGNED_LANE ? 'No project' : laneKey;
    const laneNodes = [...bands.values()].flat();
    const laneTaskCount = laneNodes.length;
    // §1: what is DONE, what is STUCK, which AGENTS work now, what is NEXT.
    // All four are derivable from the nodes already in scope.
    const laneCompleted = laneNodes.filter(node => node.status === 'completed').length;
    const laneAgentsLive = laneNodes.filter(node => Boolean(node.agent)).length;
    const laneStuck = laneNodes.filter(node => node.status === 'stuck').length;
    const laneUpNext = laneNodes.filter(node => node.status === 'todo' || node.status === 'ideas').length;
    const laneActive = laneTaskCount - laneNodes.filter(node => node.status === 'archived').length;
    const headerSize = sizeOf(`lane:${laneKey}`, sizes, FALLBACK_LANE_HEADER);
    // §2: topology is computed WITHIN THE PROJECT, not within the phase. A
    // dependency that crosses a phase boundary is an ordinary dependency and
    // must drive the flow; computing depth per band made it invisible, so a
    // downstream task sat in the same column as its upstream (review ab5f3ca2).
    const laneDepths = computeDepths(laneNodes.map(node => node.id), edges);

    // Lane-wide COLUMNS: depth N occupies the same x in every band, so the
    // flow reads left→right down the whole project rather than restarting at
    // each phase. Width per depth is the widest occupant anywhere in the lane,
    // including its Report pill strip, so no column can be under-reserved.
    const occupiedWidth = (node: MapTaskNode) => {
      const size = sizeOf(node.id, sizes, FALLBACK_TILE);
      let strip = 0;
      for (const report of pillsByTask.get(node.id) ?? []) {
        const pillSize = sizeOf(`pill:${report.id}:${node.id}`, sizes, FALLBACK_PILL);
        strip = Math.max(strip, metrics.pillGapX + pillSize.w);
      }
      return size.w + strip;
    };
    const laneColumnWidth = new Map<number, number>();
    for (const node of laneNodes) {
      const depth = laneDepths.get(node.id) ?? 0;
      laneColumnWidth.set(depth, Math.max(laneColumnWidth.get(depth) ?? 0, occupiedWidth(node)));
    }
    const laneColumnOffset = new Map<number, number>();
    let laneCursor = 0;
    for (const depth of [...laneColumnWidth.keys()].sort((a, b) => a - b)) {
      laneColumnOffset.set(depth, laneCursor);
      laneCursor += laneColumnWidth.get(depth)! + metrics.tileGapX;
    }

    // Bands sort by the phase's declared position; the unphased band sinks
    // last so real phases read in their authored order.
    const bandKeys = [...bands.keys()].sort((a, b) => {
      if (a === UNPHASED_BAND) return 1;
      if (b === UNPHASED_BAND) return -1;
      const pa = phaseById.get(a);
      const pb = phaseById.get(b);
      if (!pa && !pb) return a.localeCompare(b);
      if (!pa) return 1;
      if (!pb) return -1;
      return byPositionThenName(pa, pb);
    });

    const laneContentX = metrics.originX + headerSize.w + metrics.laneHeaderGapX;
    const laneTop = cursorY;
    let bandY = cursorY;

    for (const bandKey of bandKeys) {
      const bandNodes = bands.get(bandKey)!;
      const phase = phaseById.get(bandKey);

      // The strip is sized from the chip that will sit in it, so a tall
      // chip pushes the tiles down instead of painting over them.
      const chipId = `chip:band:${laneKey}:${bandKey}`;
      const chipSize = sizeOf(chipId, sizes, FALLBACK_CHIP);
      const headerH = Math.max(metrics.bandHeaderMinH, chipSize.h) + metrics.bandHeaderGapY;

      // Columns by depth; within a column, deterministic by updated then id.
      const columns = new Map<number, MapTaskNode[]>();
      for (const node of bandNodes) {
        // Lane-wide depth: the column a task occupies reflects its position in
        // the PROJECT's dependency flow, not merely its phase's.
        const depth = laneDepths.get(node.id) ?? 0;
        if (!columns.has(depth)) columns.set(depth, []);
        columns.get(depth)!.push(node);
      }
      for (const list of columns.values()) {
        list.sort((a, b) => a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id));
      }

      const depthKeys = [...columns.keys()].sort((a, b) => a - b);
      const tilesInBand: PlacedTile[] = [];
      const pillsInBand: PlacedReportPill[] = [];

      for (const depth of depthKeys) {
        const column = columns.get(depth)!;
        // The lane decided where this depth sits; the band only fills it.
        const columnX = laneContentX + metrics.bandPadX + (laneColumnOffset.get(depth) ?? 0);
        let tileY = bandY + headerH + metrics.bandPadY;
        for (const node of column) {
          const size = sizeOf(node.id, sizes, FALLBACK_TILE);
          tilesInBand.push({
            kind: 'tile', id: node.id, node, depth,
            x: columnX, y: tileY, w: size.w, h: size.h,
          });

          // Pills stack down the tile's right-hand side. Each is MEASURED —
          // the 24px in the stylesheet is a fallback here, never an
          // assumption the layout depends on.
          const pills = pillsByTask.get(node.id) ?? [];
          let pillY = tileY;
          let pillStripW = 0;
          for (const report of pills) {
            const pillId = `pill:${report.id}:${node.id}`;
            const pillSize = sizeOf(pillId, sizes, FALLBACK_PILL);
            pillsInBand.push({
              kind: 'pill',
              id: pillId,
              reportId: report.id,
              title: report.title,
              taskId: node.id,
              x: columnX + size.w + metrics.pillGapX,
              y: pillY,
              w: pillSize.w,
              h: pillSize.h,
            });
            pillY += pillSize.h + metrics.pillGapY;
            pillStripW = Math.max(pillStripW, metrics.pillGapX + pillSize.w);
          }

          // The tile's footprint INCLUDES its pill strip. Without this the
          // next column starts under the pills — the reviewed defect.
          tileY = Math.max(tileY + size.h, pillY) + metrics.tileGapY;
          // pillStripW is reserved by the LANE's column width, computed above
          // from the widest occupant of this depth anywhere in the project.
          void pillStripW;
        }
      }

      // The band box is DERIVED from the tiles it contains.
      const contentRight = Math.max(
        tilesInBand.length
          ? Math.max(...tilesInBand.map(t => t.x + t.w))
          : laneContentX + metrics.bandPadX,
        // A pill sits beside its tile and must not escape the band.
        pillsInBand.length ? Math.max(...pillsInBand.map(p => p.x + p.w)) : 0,
        // A long phase name widens the band rather than escaping it.
        laneContentX + metrics.bandPadX + chipSize.w,
      );
      const contentBottom = Math.max(
        tilesInBand.length
          ? Math.max(...tilesInBand.map(t => t.y + t.h))
          : bandY + headerH + metrics.bandPadY,
        pillsInBand.length ? Math.max(...pillsInBand.map(p => p.y + p.h)) : 0,
      );

      const band: PlacedBand = {
        kind: 'band',
        id: `band:${laneKey}:${bandKey}`,
        label: phase ? phase.name : (bandKey === UNPHASED_BAND ? 'No phase' : bandKey),
        goal: phase ? phase.goal : null,
        laneId: laneKey,
        x: laneContentX,
        y: bandY,
        w: contentRight + metrics.bandPadX - laneContentX,
        h: contentBottom + metrics.bandPadY - bandY,
      };
      // The chip's box is EXACTLY what was measured — no clamp. Clamping
      // was the defect: the checker saw a small box while the DOM painted
      // a large one, so the invariant passed on a fiction.
      const chip: PlacedBandChip = {
        kind: 'chip',
        id: chipId,
        label: band.label,
        goal: band.goal,
        bandId: band.id,
        x: band.x + metrics.bandPadX,
        y: band.y + Math.max(0, (headerH - chipSize.h) / 2),
        w: chipSize.w,
        h: chipSize.h,
      };
      elements.push(band, chip, ...tilesInBand, ...pillsInBand);
      maxRight = Math.max(maxRight, band.x + band.w);
      bandY = band.y + band.h + metrics.bandGapY;
    }

    const laneBottom = bandKeys.length ? bandY - metrics.bandGapY : laneTop + headerSize.h;
    // The header is vertically centred against its lane's full band stack.
    const laneHeight = Math.max(headerSize.h, laneBottom - laneTop);
    elements.push({
      kind: 'lane',
      id: `lane:${laneKey}`,
      label: laneLabel,
      taskCount: laneTaskCount,
      completed: laneCompleted,
      agentsLive: laneAgentsLive,
      stuck: laneStuck,
      upNext: laneUpNext,
      progress: laneActive > 0 ? Number((laneCompleted / laneActive).toFixed(4)) : 0,
      x: metrics.originX,
      y: laneTop + Math.max(0, (laneHeight - headerSize.h) / 2),
      w: headerSize.w,
      h: headerSize.h,
    });

    cursorY = laneTop + laneHeight + metrics.laneGapY;
  }

  return {
    elements,
    width: maxRight + metrics.originX,
    height: Math.max(metrics.originY, cursorY - LAYOUT_METRICS.laneGapY + metrics.originY),
  };
}


/* ======================================================================
 * ORGANIZATIONS — §2's "one flow logic, four organizations".
 *
 * The layout engine knows all four names; AVAILABLE_ORGANIZATIONS is the
 * subset that has actually SHIPPED, and is what the UI and persisted-state
 * validation may offer. A7a shipped the default; the A7b slices add the rest
 * serially (owner ruling 037bb84c R3; run packet 15ff4982 slicing).
 * ====================================================================== */

export type MapOrganization = 'horizontal' | 'vertical' | 'radial' | 'organic';

export const AVAILABLE_ORGANIZATIONS: readonly MapOrganization[] =
  ['horizontal', 'vertical', 'organic'];

/**
 * Vertical organization (§2): "the exact transpose" — projects are COLUMNS
 * left→right; a project's phase bands sit SIDE BY SIDE inside its column; and
 * dependency depth maps to lane-wide ROWS top→bottom, so completed work pools
 * at the top and "next" sits at the bottom. Chains flow top→bottom.
 *
 * What transposes is the FLOW GEOMETRY — the lane axis, the band axis and the
 * depth axis. What does NOT transpose is the elements themselves: a lane
 * header, a phase chip and a Report pill are horizontal text boxes in every
 * organization, so the header sits centred ABOVE its column, the chip keeps
 * its horizontal strip at the band's top, and pills keep their §3 place
 * beside (right of) their task. A literal coordinate transpose would have
 * reserved ROTATED boxes for elements that do not rotate — under-reserving
 * exactly where the measured-box discipline exists to prevent it.
 *
 * The metrics are LAYOUT_METRICS with their roles swapped where the axis
 * swapped: laneGapY spaces columns horizontally, bandGapY spaces bands
 * horizontally, laneHeaderGapX drops below the header, tileGapX spaces the
 * depth rows vertically and tileGapY spaces tiles within a row horizontally.
 * The VALUES are shared with the horizontal organization on purpose: the
 * transpose is exact, so the rhythm is too.
 */
export function layoutVertical(graph: MapGraph, sizes: SizeMap): LayoutResult {
  const { nodes, edges, phases } = graph;
  const metrics = LAYOUT_METRICS;
  const phaseById = new Map(phases.map(phase => [phase.id, phase]));

  // Group into lanes, then bands — identical to the horizontal organization:
  // the organizations share ONE flow logic and differ only in arrangement.
  const lanes = new Map<string, Map<string, MapTaskNode[]>>();
  for (const node of nodes) {
    const laneKey = laneKeyOf(node);
    const bandKey = bandKeyOf(node);
    if (!lanes.has(laneKey)) lanes.set(laneKey, new Map());
    const bands = lanes.get(laneKey)!;
    if (!bands.has(bandKey)) bands.set(bandKey, []);
    bands.get(bandKey)!.push(node);
  }

  const laneKeys = [...lanes.keys()].sort((a, b) => {
    // The unassigned lane sinks to the END — the rightmost column here, the
    // bottom lane in horizontal. Same rule, transposed axis.
    if (a === UNASSIGNED_LANE) return 1;
    if (b === UNASSIGNED_LANE) return -1;
    return a.localeCompare(b);
  });

  const elements: PlacedElement[] = [];
  let cursorX: number = metrics.originX;
  let maxBottom: number = metrics.originY;
  const pillsByTask = reportsByTask(graph.reports, new Set(graph.nodes.map(node => node.id)));

  for (const laneKey of laneKeys) {
    const bands = lanes.get(laneKey)!;
    const laneLabel = laneKey === UNASSIGNED_LANE ? 'No project' : laneKey;
    const laneNodes = [...bands.values()].flat();
    const laneTaskCount = laneNodes.length;
    const laneCompleted = laneNodes.filter(node => node.status === 'completed').length;
    const laneAgentsLive = laneNodes.filter(node => Boolean(node.agent)).length;
    const laneStuck = laneNodes.filter(node => node.status === 'stuck').length;
    const laneUpNext = laneNodes.filter(node => node.status === 'todo' || node.status === 'ideas').length;
    const laneActive = laneTaskCount - laneNodes.filter(node => node.status === 'archived').length;
    const headerSize = sizeOf(`lane:${laneKey}`, sizes, FALLBACK_LANE_HEADER);
    // Depth within the PROJECT, exactly as layoutHorizontal computes it
    // (review ab5f3ca2): a dependency crossing a phase boundary drives the
    // flow in every organization.
    const laneDepths = computeDepths(laneNodes.map(node => node.id), edges);

    // Lane-wide ROWS: depth N occupies the same y in every band of the
    // column, so the flow reads top→bottom down the whole project rather
    // than restarting at each phase. Height per depth is the tallest
    // occupant anywhere in the lane; a node's occupied height includes its
    // pill stack, which may outgrow the tile.
    const occupiedHeight = (node: MapTaskNode) => {
      const size = sizeOf(node.id, sizes, FALLBACK_TILE);
      let stack = 0;
      for (const report of pillsByTask.get(node.id) ?? []) {
        const pillSize = sizeOf(`pill:${report.id}:${node.id}`, sizes, FALLBACK_PILL);
        stack += (stack > 0 ? metrics.pillGapY : 0) + pillSize.h;
      }
      return Math.max(size.h, stack);
    };
    const laneRowHeight = new Map<number, number>();
    for (const node of laneNodes) {
      const depth = laneDepths.get(node.id) ?? 0;
      laneRowHeight.set(depth, Math.max(laneRowHeight.get(depth) ?? 0, occupiedHeight(node)));
    }
    const laneRowOffset = new Map<number, number>();
    let laneCursor = 0;
    for (const depth of [...laneRowHeight.keys()].sort((a, b) => a - b)) {
      laneRowOffset.set(depth, laneCursor);
      laneCursor += laneRowHeight.get(depth)! + metrics.tileGapX;
    }

    const bandKeys = [...bands.keys()].sort((a, b) => {
      if (a === UNPHASED_BAND) return 1;
      if (b === UNPHASED_BAND) return -1;
      const pa = phaseById.get(a);
      const pb = phaseById.get(b);
      if (!pa && !pb) return a.localeCompare(b);
      if (!pa) return 1;
      if (!pb) return -1;
      return byPositionThenName(pa, pb);
    });

    // The row origin must be COMMON to every band in the lane — rows align
    // across bands — so the chip strip is sized by the TALLEST chip any band
    // in the lane measured. (In the horizontal organization the shared axis
    // is x and each band's strip is its own; here the strip sits ON the
    // shared axis, so it is shared too.)
    let laneStripH: number = metrics.bandHeaderMinH;
    for (const bandKey of bandKeys) {
      const chipSize = sizeOf(`chip:band:${laneKey}:${bandKey}`, sizes, FALLBACK_CHIP);
      laneStripH = Math.max(laneStripH, chipSize.h);
    }
    const headerH = laneStripH + metrics.bandHeaderGapY;

    const laneContentY = metrics.originY + headerSize.h + metrics.laneHeaderGapX;
    const laneLeft = cursorX;
    let bandX = cursorX;

    for (const bandKey of bandKeys) {
      const bandNodes = bands.get(bandKey)!;
      const phase = phaseById.get(bandKey);
      const chipId = `chip:band:${laneKey}:${bandKey}`;
      const chipSize = sizeOf(chipId, sizes, FALLBACK_CHIP);

      // Rows by depth; within a row, deterministic by updated then id —
      // the same tiebreak the horizontal columns use.
      const rows = new Map<number, MapTaskNode[]>();
      for (const node of bandNodes) {
        const depth = laneDepths.get(node.id) ?? 0;
        if (!rows.has(depth)) rows.set(depth, []);
        rows.get(depth)!.push(node);
      }
      for (const list of rows.values()) {
        list.sort((a, b) => a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id));
      }

      const depthKeys = [...rows.keys()].sort((a, b) => a - b);
      const tilesInBand: PlacedTile[] = [];
      const pillsInBand: PlacedReportPill[] = [];

      for (const depth of depthKeys) {
        const row = rows.get(depth)!;
        // The lane decided where this depth sits; the band only fills it.
        const rowY = laneContentY + headerH + metrics.bandPadY + (laneRowOffset.get(depth) ?? 0);
        let tileX = bandX + metrics.bandPadX;
        for (const node of row) {
          const size = sizeOf(node.id, sizes, FALLBACK_TILE);
          tilesInBand.push({
            kind: 'tile', id: node.id, node, depth,
            x: tileX, y: rowY, w: size.w, h: size.h,
          });

          // Pills keep their §3 place: beside the tile, stacked down its
          // right-hand side, each one MEASURED.
          const pills = pillsByTask.get(node.id) ?? [];
          let pillY = rowY;
          let pillStripW = 0;
          for (const report of pills) {
            const pillId = `pill:${report.id}:${node.id}`;
            const pillSize = sizeOf(pillId, sizes, FALLBACK_PILL);
            pillsInBand.push({
              kind: 'pill',
              id: pillId,
              reportId: report.id,
              title: report.title,
              taskId: node.id,
              x: tileX + size.w + metrics.pillGapX,
              y: pillY,
              w: pillSize.w,
              h: pillSize.h,
            });
            pillY += pillSize.h + metrics.pillGapY;
            pillStripW = Math.max(pillStripW, metrics.pillGapX + pillSize.w);
          }

          // The tile's footprint INCLUDES its pill strip: the next tile in
          // the row starts beyond both. The strip's HEIGHT is already
          // reserved by the lane's row height, computed above from the
          // tallest occupant of this depth anywhere in the project.
          tileX += size.w + pillStripW + metrics.tileGapY;
        }
      }

      // The band box is DERIVED from the tiles it contains.
      const contentRight = Math.max(
        tilesInBand.length
          ? Math.max(...tilesInBand.map(t => t.x + t.w))
          : bandX + metrics.bandPadX,
        pillsInBand.length ? Math.max(...pillsInBand.map(p => p.x + p.w)) : 0,
        // A long phase name widens the band rather than escaping it.
        bandX + metrics.bandPadX + chipSize.w,
      );
      const contentBottom = Math.max(
        tilesInBand.length
          ? Math.max(...tilesInBand.map(t => t.y + t.h))
          : laneContentY + headerH + metrics.bandPadY,
        pillsInBand.length ? Math.max(...pillsInBand.map(p => p.y + p.h)) : 0,
      );

      const band: PlacedBand = {
        kind: 'band',
        id: `band:${laneKey}:${bandKey}`,
        label: phase ? phase.name : (bandKey === UNPHASED_BAND ? 'No phase' : bandKey),
        goal: phase ? phase.goal : null,
        laneId: laneKey,
        x: bandX,
        y: laneContentY,
        w: contentRight + metrics.bandPadX - bandX,
        h: contentBottom + metrics.bandPadY - laneContentY,
      };
      // The chip's box is EXACTLY what was measured — no clamp (the same
      // lesson the horizontal chip carries).
      const chip: PlacedBandChip = {
        kind: 'chip',
        id: chipId,
        label: band.label,
        goal: band.goal,
        bandId: band.id,
        x: band.x + metrics.bandPadX,
        y: band.y + Math.max(0, (headerH - chipSize.h) / 2),
        w: chipSize.w,
        h: chipSize.h,
      };
      elements.push(band, chip, ...tilesInBand, ...pillsInBand);
      maxBottom = Math.max(maxBottom, band.y + band.h);
      bandX = band.x + band.w + metrics.bandGapY;
    }

    const laneRight = bandKeys.length ? bandX - metrics.bandGapY : laneLeft + headerSize.w;
    // The header is horizontally centred against its column's full band row.
    const laneWidth = Math.max(headerSize.w, laneRight - laneLeft);
    elements.push({
      kind: 'lane',
      id: `lane:${laneKey}`,
      label: laneLabel,
      taskCount: laneTaskCount,
      completed: laneCompleted,
      agentsLive: laneAgentsLive,
      stuck: laneStuck,
      upNext: laneUpNext,
      progress: laneActive > 0 ? Number((laneCompleted / laneActive).toFixed(4)) : 0,
      x: laneLeft + Math.max(0, (laneWidth - headerSize.w) / 2),
      y: metrics.originY,
      w: headerSize.w,
      h: headerSize.h,
    });

    cursorX = laneLeft + laneWidth + metrics.laneGapY;
  }

  return {
    elements,
    width: Math.max(metrics.originX, cursorX - LAYOUT_METRICS.laneGapY + metrics.originX),
    height: maxBottom + metrics.originY,
  };
}


/* ======================================================================
 * RADIAL ORGANIZATION (§2): "estate centre outward — each project owns an
 * angular sector (share proportional to task count, minimum sector floor),
 * phases sub-divide the sector, topo depth maps to RADIUS rings (centre =
 * done/start of chains, outward = future)."
 *
 * Geometry discipline: tiles are AXIS-ALIGNED measured boxes placed at polar
 * positions, so every clearance rule is written against the worst relative
 * angle, not the easy one. Two centres L apart are provably disjoint when
 * L ≥ hypot((w1+w2)/2, (h1+h2)/2), and hypot is subadditive, so
 * L ≥ (slot_i + slot_j)/2 + gap with slot = hypot(occupiedW, occupiedH)
 * suffices for every pair at every angle.
 *
 * THE DISTANCE THAT COUNTS IS THE CHORD, NOT THE ARC (review a649f5f7 B1:
 * the first cut spent arc length, and the chord between two wide slots at a
 * small radius is measurably shorter — four 170×500 boxes overlapped). Each
 * item therefore claims an angular HALF-WIDTH α_i = asin((slot_i + gap)/2r);
 * consecutive centres sit α_i + α_j apart, and the chord between them is
 * 2r·sin((α_i+α_j)/2) ≥ r·sin α_i + r·sin α_j = (slot_i+slot_j)/2 + gap —
 * the sufficient bound, exactly (sin a + sin b = 2 sin((a+b)/2)cos((a−b)/2)
 * ≤ 2 sin((a+b)/2)). Ring separation keeps the angle-independent diagonal
 * bound. Deliberately conservative — the radial plane trades density for an
 * invariant that holds by construction, then is checked anyway.
 *
 * Placement runs in PASSES: all tiles and pills first, then chips, then
 * hulls, then headers — a chip or header is collision-resolved against
 * EVERYTHING solid already on the plane, because near the hub a sub-sector
 * is narrower than the rectangular box that labels it, and a box pushed
 * outward may only stop where the whole estate says it can.
 * ====================================================================== */

export const RADIAL_METRICS = {
  /** Clear centre before the first ring — "centre = done" radiates from a
   *  hub, not from a pile of depth-0 tiles at one point. */
  hubRadius: 60,
  /** Radial clearance between ring envelopes (beyond the diagonal bound). */
  ringGap: 28,
  /** Arc clearance between neighbouring slots in a ring. */
  slotGap: 18,
  /** Angular gap between adjacent project sectors. */
  laneGapAngle: 0.06,
  /** Angular gap between adjacent phase sub-sectors inside a project. */
  bandGapAngle: 0.03,
  /** §2's minimum sector floor, as a share of the allocatable circle. */
  minSectorShare: 0.05,
  /** Minimum share of its project's span a phase sub-sector keeps. */
  minBandShare: 0.08,
  /** Radial gap between a band's outermost content and its chip. */
  chipGap: 20,
  /** Radial gap between a sector's outermost furniture and its header. */
  headerGap: 32,
  /** Annulus padding around a band's occupied rings for the hull. */
  hullPad: 14,
  /** The outward step used while collision-resolving chips and headers. */
  resolveStep: 16,
  /** 12 o'clock start, reading clockwise (screen y grows downward). */
  startAngle: -Math.PI / 2,
  originX: 32,
  originY: 32,
} as const;

export interface RadialSector {
  start: number;
  span: number;
  bands: Map<string, { start: number; span: number }>;
}

/**
 * Angular allocation, exported on its own so §2's proportionality and
 * minimum-floor rules are directly testable. Shares are floored, then
 * normalised over the circle net of the fixed inter-sector gaps; phase
 * sub-sectors repeat the same rule inside their project's span. Deterministic
 * for identical input: lane and band orders are the ones every organization
 * sorts by.
 */
export function radialSectorSpans(graph: MapGraph): Map<string, RadialSector> {
  const m = RADIAL_METRICS;
  const lanes = new Map<string, Map<string, MapTaskNode[]>>();
  for (const node of graph.nodes) {
    const laneKey = laneKeyOf(node);
    const bandKey = bandKeyOf(node);
    if (!lanes.has(laneKey)) lanes.set(laneKey, new Map());
    const bands = lanes.get(laneKey)!;
    if (!bands.has(bandKey)) bands.set(bandKey, []);
    bands.get(bandKey)!.push(node);
  }
  const laneKeys = [...lanes.keys()].sort((a, b) => {
    if (a === UNASSIGNED_LANE) return 1;
    if (b === UNASSIGNED_LANE) return -1;
    return a.localeCompare(b);
  });
  const result = new Map<string, RadialSector>();
  if (laneKeys.length === 0) return result;

  const phaseById = new Map(graph.phases.map(phase => [phase.id, phase]));
  const laneGap = Math.min(m.laneGapAngle, Math.PI / Math.max(1, laneKeys.length));
  const available = 2 * Math.PI - laneGap * laneKeys.length;
  const total = graph.nodes.length || 1;
  const floored = laneKeys.map(key =>
    Math.max(m.minSectorShare, [...lanes.get(key)!.values()].flat().length / total));
  const flooredSum = floored.reduce((a, b) => a + b, 0);

  let cursor = m.startAngle;
  laneKeys.forEach((laneKey, index) => {
    const span = (floored[index] / flooredSum) * available;
    const start = cursor + laneGap / 2;
    const bandsIn = lanes.get(laneKey)!;
    const bandKeys = [...bandsIn.keys()].sort((a, b) => {
      if (a === UNPHASED_BAND) return 1;
      if (b === UNPHASED_BAND) return -1;
      const pa = phaseById.get(a);
      const pb = phaseById.get(b);
      if (!pa && !pb) return a.localeCompare(b);
      if (!pa) return 1;
      if (!pb) return -1;
      return byPositionThenName(pa, pb);
    });
    const bandGap = Math.min(m.bandGapAngle, span / (2 * Math.max(1, bandKeys.length)));
    const bandAvailable = span - bandGap * bandKeys.length;
    const laneTaskCount = [...bandsIn.values()].flat().length || 1;
    const bandFloored = bandKeys.map(key =>
      Math.max(m.minBandShare, bandsIn.get(key)!.length / laneTaskCount));
    const bandSum = bandFloored.reduce((a, b) => a + b, 0);
    const bands = new Map<string, { start: number; span: number }>();
    let bandCursor = start;
    bandKeys.forEach((bandKey, bandIndex) => {
      const bandSpan = (bandFloored[bandIndex] / bandSum) * bandAvailable;
      bands.set(bandKey, { start: bandCursor + bandGap / 2, span: bandSpan });
      bandCursor += bandSpan + bandGap;
    });
    result.set(laneKey, { start, span, bands });
    cursor += span + laneGap;
  });
  return result;
}

export function layoutRadial(graph: MapGraph, sizes: SizeMap): LayoutResult {
  const m = RADIAL_METRICS;
  const { nodes, edges, phases } = graph;
  if (nodes.length === 0) {
    return { elements: [], width: m.originX * 2, height: m.originY * 2 };
  }
  const phaseById = new Map(phases.map(phase => [phase.id, phase]));
  const sectors = radialSectorSpans(graph);
  const pillsByTask = reportsByTask(graph.reports, new Set(nodes.map(node => node.id)));

  const lanes = new Map<string, Map<string, MapTaskNode[]>>();
  for (const node of nodes) {
    const laneKey = laneKeyOf(node);
    const bandKey = bandKeyOf(node);
    if (!lanes.has(laneKey)) lanes.set(laneKey, new Map());
    const bands = lanes.get(laneKey)!;
    if (!bands.has(bandKey)) bands.set(bandKey, []);
    bands.get(bandKey)!.push(node);
  }

  // Footprints as the vertical organization computes them: a tile's occupied
  // box includes its pill strip beside it and its pill stack from its top.
  const occupied = (node: MapTaskNode) => {
    const size = sizeOf(node.id, sizes, FALLBACK_TILE);
    let strip = 0;
    let stack = 0;
    for (const report of pillsByTask.get(node.id) ?? []) {
      const pillSize = sizeOf(`pill:${report.id}:${node.id}`, sizes, FALLBACK_PILL);
      strip = Math.max(strip, LAYOUT_METRICS.pillGapX + pillSize.w);
      stack += (stack > 0 ? LAYOUT_METRICS.pillGapY : 0) + pillSize.h;
    }
    const w = size.w + strip;
    const h = Math.max(size.h, stack);
    return { w, h, slot: Math.hypot(w, h), tile: size };
  };

  // Depth per PROJECT, exactly as every organization computes it.
  const laneDepths = new Map<string, Map<string, number>>();
  for (const [laneKey, bands] of lanes) {
    const laneNodes = [...bands.values()].flat();
    laneDepths.set(laneKey, computeDepths(laneNodes.map(node => node.id), edges));
  }

  // Estate-wide rings: worst half-diagonal at each depth, then radii from
  // the radial constraint AND every band's arc capacity — raising a radius
  // only ever helps, so one ascending pass settles both.
  const halfDiag = new Map<number, number>();
  for (const [laneKey, bands] of lanes) {
    const depths = laneDepths.get(laneKey)!;
    for (const node of [...bands.values()].flat()) {
      const depth = depths.get(node.id) ?? 0;
      halfDiag.set(depth, Math.max(halfDiag.get(depth) ?? 0, occupied(node).slot / 2));
    }
  }
  const depthKeys = [...halfDiag.keys()].sort((a, b) => a - b);
  // An item's angular half-width at radius r (the chord-safe claim above).
  const alphaAt = (slot: number, r: number) =>
    Math.asin(Math.min(1, (slot + m.slotGap) / (2 * r)));
  const ringRadius = new Map<number, number>();
  let previousR: number | null = null;
  let previousHalf = 0;
  for (const depth of depthKeys) {
    const half = halfDiag.get(depth)!;
    let radius: number = previousR === null
      ? m.hubRadius + half
      : previousR + previousHalf + half + m.ringGap;
    for (const [laneKey, bands] of lanes) {
      const sector = sectors.get(laneKey)!;
      const depths = laneDepths.get(laneKey)!;
      for (const [bandKey, bandNodes] of bands) {
        const ringNodes = bandNodes.filter(node => (depths.get(node.id) ?? 0) === depth);
        if (ringNodes.length === 0) continue;
        const band = sector.bands.get(bandKey)!;
        // Grow the radius until the CHORD-SAFE angular need fits the
        // sub-sector. Need is monotonically decreasing in r, so the walk
        // terminates; the bound is a backstop, never the mechanism.
        const need = (r: number) => ringNodes.reduce(
          (sum, node) => sum + 2 * alphaAt(occupied(node).slot, r), 0);
        for (let step = 0; step < 80 && need(radius) > band.span; step += 1) {
          radius *= 1.15;
        }
      }
    }
    ringRadius.set(depth, radius);
    previousR = radius;
    previousHalf = half;
  }

  const intersects = (a: Box, b: Box) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // ---- PASS 1: tiles + pills for every band --------------------------------
  interface BandPlacement {
    laneKey: string;
    bandKey: string;
    bandId: string;
    label: string;
    goal: string | null;
    start: number;
    span: number;
    innerR: number;
    outerR: number;
    tiles: PlacedTile[];
    pills: PlacedReportPill[];
  }
  const placements: BandPlacement[] = [];
  const solid: Box[] = [];
  for (const [laneKey, sector] of sectors) {
    const bands = lanes.get(laneKey)!;
    const depths = laneDepths.get(laneKey)!;
    for (const [bandKey, band] of sector.bands) {
      const bandNodes = bands.get(bandKey)!;
      const phase = phaseById.get(bandKey);
      const rows = new Map<number, MapTaskNode[]>();
      for (const node of bandNodes) {
        const depth = depths.get(node.id) ?? 0;
        if (!rows.has(depth)) rows.set(depth, []);
        rows.get(depth)!.push(node);
      }
      for (const list of rows.values()) {
        list.sort((a, b) => a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id));
      }
      const placement: BandPlacement = {
        laneKey, bandKey,
        bandId: `band:${laneKey}:${bandKey}`,
        label: phase ? phase.name : (bandKey === UNPHASED_BAND ? 'No phase' : bandKey),
        goal: phase ? phase.goal : null,
        start: band.start, span: band.span,
        innerR: Number.POSITIVE_INFINITY, outerR: 0,
        tiles: [], pills: [],
      };
      for (const depth of [...rows.keys()].sort((a, b) => a - b)) {
        const row = rows.get(depth)!;
        const radius = ringRadius.get(depth)!;
        // Angle cursor over chord-safe half-widths, centred in the span.
        const used = row.reduce(
          (sum, node) => sum + 2 * alphaAt(occupied(node).slot, radius), 0);
        let angleCursor = band.start + Math.max(0, (band.span - used) / 2);
        for (const node of row) {
          const foot = occupied(node);
          const alpha = alphaAt(foot.slot, radius);
          const theta = angleCursor + alpha;
          angleCursor += 2 * alpha;
          const tileX = radius * Math.cos(theta) - foot.w / 2;
          const tileY = radius * Math.sin(theta) - foot.h / 2;
          placement.tiles.push({
            kind: 'tile', id: node.id, node, depth,
            x: tileX, y: tileY, w: foot.tile.w, h: foot.tile.h,
          });
          let pillY = tileY;
          for (const report of pillsByTask.get(node.id) ?? []) {
            const pillId = `pill:${report.id}:${node.id}`;
            const pillSize = sizeOf(pillId, sizes, FALLBACK_PILL);
            placement.pills.push({
              kind: 'pill', id: pillId, reportId: report.id, title: report.title,
              taskId: node.id,
              x: tileX + foot.tile.w + LAYOUT_METRICS.pillGapX,
              y: pillY, w: pillSize.w, h: pillSize.h,
            });
            pillY += pillSize.h + LAYOUT_METRICS.pillGapY;
          }
          placement.innerR = Math.min(placement.innerR, radius - foot.slot / 2);
          placement.outerR = Math.max(placement.outerR, radius + foot.slot / 2);
        }
      }
      solid.push(...placement.tiles, ...placement.pills);
      placements.push(placement);
    }
  }

  // ---- PASS 2: chips, collision-resolved against EVERYTHING solid ----------
  const chips: PlacedBandChip[] = [];
  for (const placement of placements) {
    const chipId = `chip:band:${placement.laneKey}:${placement.bandKey}`;
    const chipSize = sizeOf(chipId, sizes, FALLBACK_CHIP);
    const chipHalf = Math.hypot(chipSize.w, chipSize.h) / 2;
    const bisector = placement.start + placement.span / 2;
    const baseR = (placement.outerR || m.hubRadius) + m.chipGap + chipHalf;
    let chipR = baseR;
    const boxAt = (r: number): Box => ({
      x: r * Math.cos(bisector) - chipSize.w / 2,
      y: r * Math.sin(bisector) - chipSize.h / 2,
      w: chipSize.w, h: chipSize.h,
    });
    for (let step = 0; step < 80; step += 1) {
      if (!solid.some(b => intersects(boxAt(chipR), b))) break;
      chipR += m.resolveStep;
    }
    const box = boxAt(chipR);
    const chip: PlacedBandChip = {
      kind: 'chip', id: chipId, label: placement.label, goal: placement.goal,
      bandId: placement.bandId, x: box.x, y: box.y, w: box.w, h: box.h,
    };
    chips.push(chip);
    solid.push(box);
    placement.outerR = Math.max(placement.outerR, chipR + chipHalf);
  }

  // ---- PASS 3: hulls around each band's occupied annulus -------------------
  const hulls: PlacedHull[] = [];
  for (const placement of placements) {
    const inner = Math.max(
      8, (Number.isFinite(placement.innerR) ? placement.innerR : m.hubRadius) - m.hullPad);
    const outer = placement.outerR + m.hullPad;
    const points: Array<readonly [number, number]> = [];
    const steps = Math.max(2, Math.ceil(placement.span / 0.18));
    for (let i = 0; i <= steps; i += 1) {
      const angle = placement.start + (placement.span * i) / steps;
      points.push([outer * Math.cos(angle), outer * Math.sin(angle)]);
    }
    for (let i = steps; i >= 0; i -= 1) {
      const angle = placement.start + (placement.span * i) / steps;
      points.push([inner * Math.cos(angle), inner * Math.sin(angle)]);
    }
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    hulls.push({
      kind: 'hull', id: placement.bandId, label: placement.label, goal: placement.goal,
      laneId: placement.laneKey, points,
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
    });
  }

  // ---- PASS 4: lane headers at each sector's bisector, outside its hulls ---
  const headers: PlacedLaneHeader[] = [];
  for (const [laneKey, sector] of sectors) {
    const laneNodes = [...lanes.get(laneKey)!.values()].flat();
    const laneLabel = laneKey === UNASSIGNED_LANE ? 'No project' : laneKey;
    const headerSize = sizeOf(`lane:${laneKey}`, sizes, FALLBACK_LANE_HEADER);
    const headerHalf = Math.hypot(headerSize.w, headerSize.h) / 2;
    const laneOuter = Math.max(
      m.hubRadius,
      ...placements.filter(p => p.laneKey === laneKey).map(p => p.outerR + m.hullPad));
    const bisector = sector.start + sector.span / 2;
    let headerR = laneOuter + m.headerGap + headerHalf;
    const boxAt = (r: number): Box => ({
      x: r * Math.cos(bisector) - headerSize.w / 2,
      y: r * Math.sin(bisector) - headerSize.h / 2,
      w: headerSize.w, h: headerSize.h,
    });
    for (let step = 0; step < 80; step += 1) {
      if (!solid.some(b => intersects(boxAt(headerR), b))) break;
      headerR += m.resolveStep;
    }
    const box = boxAt(headerR);
    solid.push(box);
    const laneTaskCount = laneNodes.length;
    const laneCompleted = laneNodes.filter(node => node.status === 'completed').length;
    const laneActive = laneTaskCount - laneNodes.filter(node => node.status === 'archived').length;
    headers.push({
      kind: 'lane', id: `lane:${laneKey}`, label: laneLabel,
      taskCount: laneTaskCount,
      completed: laneCompleted,
      agentsLive: laneNodes.filter(node => Boolean(node.agent)).length,
      stuck: laneNodes.filter(node => node.status === 'stuck').length,
      upNext: laneNodes.filter(node => node.status === 'todo' || node.status === 'ideas').length,
      progress: laneActive > 0 ? Number((laneCompleted / laneActive).toFixed(4)) : 0,
      x: box.x, y: box.y, w: box.w, h: box.h,
    });
  }

  // Layer order matches the pipelines: containers first, then content.
  const elements: PlacedElement[] = [
    ...hulls,
    ...chips,
    ...placements.flatMap(p => [...p.tiles, ...p.pills]),
    ...headers,
  ];

  // Shift the plane into positive coordinates.
  const minX = Math.min(...elements.map(e => e.x));
  const minY = Math.min(...elements.map(e => e.y));
  const shiftX = m.originX - minX;
  const shiftY = m.originY - minY;
  const shifted = elements.map(element => {
    if (element.kind === 'hull') {
      return {
        ...element,
        x: element.x + shiftX,
        y: element.y + shiftY,
        points: element.points.map(point =>
          [point[0] + shiftX, point[1] + shiftY] as const),
      } as PlacedElement;
    }
    return { ...element, x: element.x + shiftX, y: element.y + shiftY } as PlacedElement;
  });
  return {
    elements: shifted,
    width: Math.max(...shifted.map(e => e.x + e.w)) + m.originX,
    height: Math.max(...shifted.map(e => e.y + e.h)) + m.originY,
  };
}


/* ======================================================================
 * CONTAINER MORPHS (review a649f5f7 B2): §2 says "bands/edges/headers
 * follow" the organization morph, and §3 makes the radial band a bounds
 * HULL. A hull is an SVG path — CSS cannot tween its geometry — so the
 * morph interpolates OUTLINES: both container forms (pipeline rect, radial
 * annular sector) resample to one point count, cyclically align, and lerp
 * under the same 0.5s cubic-bezier(.4,0,.2,1) the tiles ride. Everything
 * here is pure and tested; the component only drives `t`.
 * ====================================================================== */

export type Outline = ReadonlyArray<readonly [number, number]>;

/** A closed rectangle outline, clockwise from the top-left corner. */
export function rectOutline(box: Box, pointsPerSide = 12): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const side = Math.max(1, pointsPerSide);
  for (let i = 0; i < side; i += 1) points.push([box.x + (box.w * i) / side, box.y]);
  for (let i = 0; i < side; i += 1) points.push([box.x + box.w, box.y + (box.h * i) / side]);
  for (let i = 0; i < side; i += 1) points.push([box.x + box.w - (box.w * i) / side, box.y + box.h]);
  for (let i = 0; i < side; i += 1) points.push([box.x, box.y + box.h - (box.h * i) / side]);
  return points;
}

/** Uniform arc-length resampling of a closed polyline to exactly n points. */
export function resampleOutline(outline: Outline, n: number): Array<[number, number]> {
  if (outline.length === 0 || n <= 0) return [];
  const closed = [...outline, outline[0]];
  const lengths: number[] = [0];
  for (let i = 1; i < closed.length; i += 1) {
    lengths.push(lengths[i - 1] + Math.hypot(
      closed[i][0] - closed[i - 1][0], closed[i][1] - closed[i - 1][1]));
  }
  const total = lengths[lengths.length - 1];
  if (total === 0) return Array.from({ length: n }, () => [outline[0][0], outline[0][1]]);
  const points: Array<[number, number]> = [];
  let segment = 0;
  for (let i = 0; i < n; i += 1) {
    const target = (total * i) / n;
    while (segment < closed.length - 2 && lengths[segment + 1] < target) segment += 1;
    const span = lengths[segment + 1] - lengths[segment];
    const t = span > 0 ? (target - lengths[segment]) / span : 0;
    points.push([
      closed[segment][0] + (closed[segment + 1][0] - closed[segment][0]) * t,
      closed[segment][1] + (closed[segment + 1][1] - closed[segment][1]) * t,
    ]);
  }
  return points;
}

/**
 * Cyclic alignment: rotate `from` so its points correspond to `to`'s with
 * minimal total squared distance — without it the lerp twists the container
 * around itself. Deterministic; O(n²) over ≤ 96 points is nothing.
 */
export function alignOutline(
  from: Outline, to: Outline,
): Array<[number, number]> {
  const n = from.length;
  if (n !== to.length || n === 0) return from.map(p => [p[0], p[1]]);
  let bestOffset = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < n; offset += 1) {
    let cost = 0;
    for (let i = 0; i < n; i += 1) {
      const p = from[(i + offset) % n];
      cost += (p[0] - to[i][0]) ** 2 + (p[1] - to[i][1]) ** 2;
      if (cost >= bestCost) break;
    }
    if (cost < bestCost) { bestCost = cost; bestOffset = offset; }
  }
  return Array.from({ length: n }, (_, i) => {
    const p = from[(i + bestOffset) % n];
    return [p[0], p[1]] as [number, number];
  });
}

/** Pointwise lerp between equal-length outlines. */
export function interpolateOutline(
  from: Outline, to: Outline, t: number,
): Array<[number, number]> {
  const n = Math.min(from.length, to.length);
  return Array.from({ length: n }, (_, i) => [
    from[i][0] + (to[i][0] - from[i][0]) * t,
    from[i][1] + (to[i][1] - from[i][1]) * t,
  ]);
}

/** The morph's easing — cubic-bezier(0.4, 0, 0.2, 1), y for x by bisection. */
export function morphEase(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = (t: number) => 3 * t * (1 - t) * (1 - t) * 0.4 + 3 * t * t * (1 - t) * 0.2 + t ** 3;
  const by = (t: number) => 3 * t * t * (1 - t) * 1 + t ** 3;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (bx(mid) < x) low = mid; else high = mid;
  }
  return by((low + high) / 2);
}

export function outlineToPath(outline: Outline): string {
  if (outline.length === 0) return '';
  return 'M ' + outline.map(point => `${point[0]} ${point[1]}`).join(' L ') + ' Z';
}

export const CONTAINER_MORPH_POINTS = 96;

export interface ContainerMorph {
  id: string;
  from: Array<[number, number]>;
  to: Array<[number, number]>;
}

/**
 * The band containers' morph pairs between two layouts of the SAME graph:
 * every band id present in both (a pipeline band is a rect outline, a radial
 * band is its hull polygon), resampled to one count and cyclically aligned.
 */
export function containerMorphsFor(
  fromLayout: LayoutResult, toLayout: LayoutResult,
): ContainerMorph[] {
  const outlineOf = (layout: LayoutResult) => {
    const map = new Map<string, Outline>();
    for (const element of layout.elements) {
      if (element.kind === 'band') map.set(element.id, rectOutline(element));
      else if (element.kind === 'hull') map.set(element.id, element.points);
    }
    return map;
  };
  const fromMap = outlineOf(fromLayout);
  const toMap = outlineOf(toLayout);
  const morphs: ContainerMorph[] = [];
  for (const [id, fromOutline] of fromMap) {
    const toOutline = toMap.get(id);
    if (!toOutline) continue;
    const to = resampleOutline(toOutline, CONTAINER_MORPH_POINTS);
    const from = alignOutline(resampleOutline(fromOutline, CONTAINER_MORPH_POINTS), to);
    morphs.push({ id, from, to });
  }
  return morphs;
}


/* ======================================================================
 * ORGANIC ORGANIZATION (§2): "self-organizing (Second-Brain-map feel) —
 * constrained force layout: project centroid attraction, dependency-link
 * springs, cross-project repulsion, then the separation pass. For
 * exploration of interconnections, not the default."
 *
 * This is the ONE organization that introduces simulation machinery (the
 * technical correction on card 74a1698d: there is no physics engine — the
 * simulation is a pure, DETERMINISTIC gradient relaxation with fixed
 * iteration counts, golden-angle seeding and zero randomness, so identical
 * input still lays out identically and any move to a real physics/GPU
 * engine remains a declared §8 amendment).
 *
 * Two levels keep it bounded: project centroids relax against each other
 * first (dozens of nodes), then each project's Tasks relax around their own
 * centroid (springs on intra-project dependencies, mutual repulsion inside
 * the project, repulsion from OTHER projects' centroids). The simulation is
 * SIZES-INDEPENDENT — it moves centre points — so its result is cached per
 * graph object (WeakMap): the component recomputes the layout on every
 * measurement pass, and re-simulating a 5k estate per measured tile would
 * be the §5 long-task budget spent on nothing. The measured boxes enter in
 * the SEPARATION PASS, which owns the §2 zero-overlap invariant: bounded
 * pairwise relaxation on a spatial grid, then a deterministic spiral
 * placement for anything still colliding — the invariant holds by
 * construction, then is checked anyway.
 * ====================================================================== */

export const ORGANIC_METRICS = {
  /** Level-1 seeding radius step and spring/repulsion tuning. */
  projectSeedRadius: 520,
  projectSpringLength: 1400,
  projectSpringK: 0.03,
  projectRepulsion: 2.6e6,
  projectGravity: 0.012,
  projectIterations: 100,
  /** Level-2 (per-project) tuning. */
  taskSeedRadius: 130,
  taskSpringLength: 300,
  taskSpringK: 0.045,
  taskRepulsion: 5.2e4,
  centroidPull: 0.02,
  foreignRepulsion: 5.2e5,
  taskIterations: 45,
  /** The largest single relaxation step, so one iteration cannot explode. */
  maxStep: 60,
  /** Separation pass: relaxation sweeps before the guaranteed resolve. */
  separationSweeps: 30,
  separationGap: 14,
  /** Deterministic spiral used by the guaranteed resolve. */
  spiralStep: 24,
  /** Spiral search bound before the shelf fallback places the box below
   *  the occupied extent — the guarantee stays a theorem either way. */
  spiralAttempts: 1500,
  hullPad: 18,
  chipGap: 14,
  headerGap: 22,
  /** Nominal footprint pitch used by the density normalisation below —
   *  the sim is sizes-independent by design, so it spaces for a TYPICAL
   *  tile-with-furniture footprint and the measured separation pass
   *  absorbs the real boxes' residual differences. */
  nominalPitch: 235,
  clusterMargin: 380,
  originX: 32,
  originY: 32,
} as const;

// GOLDEN_ANGLE is declared once, further down with the report-placement
// resolver that introduced it; module-level const initialization precedes
// every runtime call into these functions.

interface Point { x: number; y: number }

/**
 * The sizes-independent centre simulation, cached per graph OBJECT. The
 * cache is safe because a MapGraph is treated as immutable by every consumer
 * (useMapData builds a fresh object on every reconcile), and it is the whole
 * reason a 5k organic estate survives the measurement trickle.
 */
const organicCentreCache = new WeakMap<MapGraph, Map<string, Point>>();

export function simulateOrganicCentres(graph: MapGraph): Map<string, Point> {
  const cached = organicCentreCache.get(graph);
  if (cached) return cached;
  const m = ORGANIC_METRICS;

  const lanes = new Map<string, MapTaskNode[]>();
  for (const node of graph.nodes) {
    const laneKey = laneKeyOf(node);
    if (!lanes.has(laneKey)) lanes.set(laneKey, []);
    lanes.get(laneKey)!.push(node);
  }
  const laneKeys = [...lanes.keys()].sort((a, b) => {
    if (a === UNASSIGNED_LANE) return 1;
    if (b === UNASSIGNED_LANE) return -1;
    return a.localeCompare(b);
  });
  const result = new Map<string, Point>();
  if (laneKeys.length === 0) {
    organicCentreCache.set(graph, result);
    return result;
  }

  // ---- LEVEL 1: project centroids -----------------------------------------
  const centroid = new Map<string, Point>();
  laneKeys.forEach((laneKey, index) => {
    const radius = m.projectSeedRadius * Math.sqrt(index + 1);
    const angle = index * GOLDEN_ANGLE;
    centroid.set(laneKey, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  });
  // CANONICAL ACCUMULATION ORDER (pre-review 085a7d7a F1): floating-point
  // addition is not associative, so every force loop below runs over a
  // canonically SORTED sequence — a permuted-but-identical input array must
  // produce byte-identical output, and at 1e-13 "close enough" is still a
  // §8 violation. rollUpEdges already sorts; the sort here makes the
  // guarantee local instead of inherited.
  const projectEdges = rollUpEdges(graph, 'project').edges
    .filter(edge => edge.kind === 'dependency')
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  // The radius a project's cluster will NEED once its tasks spread at the
  // nominal pitch — the normalisation target for both simulation levels.
  const neededRadius = new Map<string, number>(laneKeys.map(key =>
    [key, m.nominalPitch * Math.sqrt(lanes.get(key)!.length) * 0.62]));
  const laneOfKey = (aggregateId: string) => aggregateId.replace(/^project:/, '');
  for (let iteration = 0; iteration < m.projectIterations; iteration += 1) {
    const force = new Map<string, Point>(laneKeys.map(key => [key, { x: 0, y: 0 }]));
    for (const edge of projectEdges) {
      const a = laneOfKey(edge.from);
      const b = laneOfKey(edge.to);
      const pa = centroid.get(a);
      const pb = centroid.get(b);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = m.projectSpringK * Math.min(4, edge.multiplicity)
        * (distance - m.projectSpringLength) / distance;
      force.get(a)!.x += dx * pull; force.get(a)!.y += dy * pull;
      force.get(b)!.x -= dx * pull; force.get(b)!.y -= dy * pull;
    }
    for (let i = 0; i < laneKeys.length; i += 1) {
      for (let j = i + 1; j < laneKeys.length; j += 1) {
        const pa = centroid.get(laneKeys[i])!;
        const pb = centroid.get(laneKeys[j])!;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const distanceSq = Math.max(400, dx * dx + dy * dy);
        const push = m.projectRepulsion / distanceSq;
        const distance = Math.sqrt(distanceSq);
        force.get(laneKeys[i])!.x -= (dx / distance) * push;
        force.get(laneKeys[i])!.y -= (dy / distance) * push;
        force.get(laneKeys[j])!.x += (dx / distance) * push;
        force.get(laneKeys[j])!.y += (dy / distance) * push;
      }
    }
    for (const laneKey of laneKeys) {
      const p = centroid.get(laneKey)!;
      const f = force.get(laneKey)!;
      f.x -= p.x * m.projectGravity;
      f.y -= p.y * m.projectGravity;
      const magnitude = Math.hypot(f.x, f.y);
      const scale = magnitude > m.maxStep ? m.maxStep / magnitude : 1;
      p.x += f.x * scale;
      p.y += f.y * scale;
    }
  }

  // ---- DENSITY NORMALISATION, level 1: force constants can only be tuned
  // for one estate shape, so the GUARANTEE comes from a deterministic
  // post-pass — centroids scale outward until every pair is at least the sum
  // of the clusters' needed radii apart. One global ratio keeps the layout's
  // shape; it only grows, never shrinks.
  {
    let ratio = 1;
    for (let i = 0; i < laneKeys.length; i += 1) {
      for (let j = i + 1; j < laneKeys.length; j += 1) {
        const pa = centroid.get(laneKeys[i])!;
        const pb = centroid.get(laneKeys[j])!;
        const actual = Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y));
        const required = neededRadius.get(laneKeys[i])!
          + neededRadius.get(laneKeys[j])! + m.clusterMargin;
        ratio = Math.max(ratio, required / actual);
      }
    }
    if (ratio > 1) {
      for (const laneKey of laneKeys) {
        const point = centroid.get(laneKey)!;
        point.x *= ratio;
        point.y *= ratio;
      }
    }
  }

  // ---- LEVEL 2: tasks around their project centroid -----------------------
  const foreign = (laneKey: string) =>
    laneKeys.filter(key => key !== laneKey).map(key => centroid.get(key)!);
  for (const laneKey of laneKeys) {
    const nodes = [...lanes.get(laneKey)!]
      .sort((a, b) => a.id.localeCompare(b.id));
    const home = centroid.get(laneKey)!;
    const inLane = new Set(nodes.map(node => node.id));
    const springs = graph.edges.filter(edge => edge.kind === 'dependency'
      && edge.from !== edge.to && inLane.has(edge.from) && inLane.has(edge.to))
      // F1: spring accumulation order must be canonical, not wire order.
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const position = new Map<string, Point>();
    nodes.forEach((node, index) => {
      const radius = m.taskSeedRadius * Math.sqrt(index + 1);
      const angle = index * GOLDEN_ANGLE;
      position.set(node.id, {
        x: home.x + radius * Math.cos(angle),
        y: home.y + radius * Math.sin(angle),
      });
    });
    const others = foreign(laneKey);
    for (let iteration = 0; iteration < m.taskIterations; iteration += 1) {
      const force = new Map<string, Point>(nodes.map(node => [node.id, { x: 0, y: 0 }]));
      for (const edge of springs) {
        const pa = position.get(edge.from)!;
        const pb = position.get(edge.to)!;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const pull = m.taskSpringK * (distance - m.taskSpringLength) / distance;
        force.get(edge.from)!.x += dx * pull; force.get(edge.from)!.y += dy * pull;
        force.get(edge.to)!.x -= dx * pull; force.get(edge.to)!.y -= dy * pull;
      }
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const pa = position.get(nodes[i].id)!;
          const pb = position.get(nodes[j].id)!;
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          const distanceSq = Math.max(100, dx * dx + dy * dy);
          const push = m.taskRepulsion / distanceSq;
          const distance = Math.sqrt(distanceSq);
          force.get(nodes[i].id)!.x -= (dx / distance) * push;
          force.get(nodes[i].id)!.y -= (dy / distance) * push;
          force.get(nodes[j].id)!.x += (dx / distance) * push;
          force.get(nodes[j].id)!.y += (dy / distance) * push;
        }
      }
      for (const node of nodes) {
        const p = position.get(node.id)!;
        const f = force.get(node.id)!;
        f.x += (home.x - p.x) * m.centroidPull;
        f.y += (home.y - p.y) * m.centroidPull;
        for (const other of others) {
          const dx = p.x - other.x;
          const dy = p.y - other.y;
          const distanceSq = Math.max(2500, dx * dx + dy * dy);
          const push = m.foreignRepulsion / distanceSq;
          const distance = Math.sqrt(distanceSq);
          f.x += (dx / distance) * push;
          f.y += (dy / distance) * push;
        }
        const magnitude = Math.hypot(f.x, f.y);
        const scale = magnitude > m.maxStep ? m.maxStep / magnitude : 1;
        p.x += f.x * scale;
        p.y += f.y * scale;
      }
    }
    // Density normalisation, level 2: the cluster spreads to the pitch its
    // population needs — the same only-grow rule as the centroid field.
    {
      let spread = 1;
      for (const node of nodes) {
        const point = position.get(node.id)!;
        spread = Math.max(spread, Math.hypot(point.x - home.x, point.y - home.y));
      }
      const scale = Math.max(1, neededRadius.get(laneKey)! / spread);
      if (scale > 1) {
        for (const node of nodes) {
          const point = position.get(node.id)!;
          point.x = home.x + (point.x - home.x) * scale;
          point.y = home.y + (point.y - home.y) * scale;
        }
      }
    }
    for (const node of nodes) result.set(node.id, position.get(node.id)!);
  }

  organicCentreCache.set(graph, result);
  return result;
}

/** Andrew monotone-chain convex hull over points; returns CCW outline. */
export function convexHull(
  points: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const sorted = [...points].map(p => [p[0], p[1]] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length <= 2) return sorted;
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Array<[number, number]> = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

export function layoutOrganic(graph: MapGraph, sizes: SizeMap): LayoutResult {
  const m = ORGANIC_METRICS;
  const { nodes, phases } = graph;
  if (nodes.length === 0) {
    return { elements: [], width: m.originX * 2, height: m.originY * 2 };
  }
  const phaseById = new Map(phases.map(phase => [phase.id, phase]));
  const centres = simulateOrganicCentres(graph);
  const pillsByTask = reportsByTask(graph.reports, new Set(nodes.map(node => node.id)));

  const occupied = (node: MapTaskNode) => {
    const size = sizeOf(node.id, sizes, FALLBACK_TILE);
    let strip = 0;
    let stack = 0;
    for (const report of pillsByTask.get(node.id) ?? []) {
      const pillSize = sizeOf(`pill:${report.id}:${node.id}`, sizes, FALLBACK_PILL);
      strip = Math.max(strip, LAYOUT_METRICS.pillGapX + pillSize.w);
      stack += (stack > 0 ? LAYOUT_METRICS.pillGapY : 0) + pillSize.h;
    }
    return { w: size.w + strip, h: Math.max(size.h, stack), tile: size };
  };

  // ---- SEPARATION PASS (the §2 invariant lives here) -----------------------
  interface Footprint extends Point { id: string; node: MapTaskNode; w: number; h: number }
  const footprints: Footprint[] = [...nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(node => {
      const centre = centres.get(node.id)!;
      const foot = occupied(node);
      return { id: node.id, node, x: centre.x, y: centre.y, w: foot.w, h: foot.h };
    });
  const gap = m.separationGap;
  const boxesOverlap = (
    ax: number, ay: number, aw: number, ah: number,
    bx: number, by: number, bw: number, bh: number,
  ) => Math.abs(ax - bx) < (aw + bw) / 2 + gap && Math.abs(ay - by) < (ah + bh) / 2 + gap;
  const overlapping = (a: Footprint, b: Footprint) =>
    boxesOverlap(a.x, a.y, a.w, a.h, b.x, b.y, b.w, b.h);

  // ONE spatial-grid shape serves every collision query below. The first cut
  // pushed pairs by half-steps along the centre diagonal and scanned flat
  // arrays — measured at 127s for a 5k estate. Local queries plus FULL
  // resolution along the axis of least penetration (a pair is clear after
  // one move) bring the whole pass to interactive cost.
  const cell = Math.max(64, ...footprints.map(f => Math.max(f.w, f.h))) + gap;
  const gridKey = (cx: number, cy: number) => cx + ':' + cy;
  const neighboursAt = (grid: Map<string, Footprint[]>, x: number, y: number) => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const out: Footprint[] = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = grid.get(gridKey(cx + dx, cy + dy));
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  };
  const buildGrid = () => {
    const grid = new Map<string, Footprint[]>();
    for (const f of footprints) {
      const key = gridKey(Math.floor(f.x / cell), Math.floor(f.y / cell));
      const bucket = grid.get(key);
      if (bucket) bucket.push(f); else grid.set(key, [f]);
    }
    return grid;
  };

  for (let sweep = 0; sweep < m.separationSweeps; sweep += 1) {
    const grid = buildGrid();
    let moved = false;
    for (const f of footprints) {
      for (const other of neighboursAt(grid, f.x, f.y)) {
        if (other.id <= f.id) continue;
        if (!overlapping(f, other)) continue;
        const needX = (f.w + other.w) / 2 + gap - Math.abs(other.x - f.x);
        const needY = (f.h + other.h) / 2 + gap - Math.abs(other.y - f.y);
        if (needX <= needY) {
          // Deterministic direction, id-ordered when the centres coincide.
          const direction = other.x > f.x ? 1 : other.x < f.x ? -1 : 1;
          f.x -= direction * (needX / 2);
          other.x += direction * (needX / 2);
        } else {
          const direction = other.y > f.y ? 1 : other.y < f.y ? -1 : 1;
          f.y -= direction * (needY / 2);
          other.y += direction * (needY / 2);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Guaranteed resolve: anything still colliding walks a BOUNDED
  // deterministic spiral; whatever the spiral cannot seat goes to the shelf —
  // a row strictly below the occupied extent, advancing rightward — so the
  // invariant is a theorem with a terminating construction, never a hope.
  {
    const grid = new Map<string, Footprint[]>();
    const put = (f: Footprint) => {
      const key = gridKey(Math.floor(f.x / cell), Math.floor(f.y / cell));
      const bucket = grid.get(key);
      if (bucket) bucket.push(f); else grid.set(key, [f]);
    };
    const collidesAt = (f: Footprint, x: number, y: number) =>
      neighboursAt(grid, x, y).some(other =>
        other.id !== f.id && boxesOverlap(x, y, f.w, f.h, other.x, other.y, other.w, other.h));
    let shelfY = 0;
    let shelfLeft = 0;
    for (const f of footprints) {
      shelfY = Math.max(shelfY, f.y + f.h);
      shelfLeft = Math.min(shelfLeft, f.x);
    }
    shelfY += gap * 2;
    for (const f of footprints) {
      if (!collidesAt(f, f.x, f.y)) { put(f); continue; }
      let seated = false;
      for (let step = 1; step <= m.spiralAttempts; step += 1) {
        const angle = step * GOLDEN_ANGLE;
        const radius = m.spiralStep * Math.sqrt(step);
        const x = f.x + radius * Math.cos(angle);
        const y = f.y + radius * Math.sin(angle);
        if (!collidesAt(f, x, y)) { f.x = x; f.y = y; seated = true; break; }
      }
      if (!seated) {
        f.x = shelfLeft + f.w / 2;
        f.y = shelfY + f.h / 2;
        while (collidesAt(f, f.x, f.y)) f.x += f.w + gap;
      }
      put(f);
    }
  }

  // ---- Emit tiles + pills --------------------------------------------------
  const tiles: PlacedTile[] = [];
  const pills: PlacedReportPill[] = [];
  const laneDepthsCache = new Map<string, Map<string, number>>();
  const depthOf = (node: MapTaskNode) => {
    const laneKey = laneKeyOf(node);
    if (!laneDepthsCache.has(laneKey)) {
      const laneNodes = nodes.filter(n => laneKeyOf(n) === laneKey);
      laneDepthsCache.set(laneKey, computeDepths(laneNodes.map(n => n.id), graph.edges));
    }
    return laneDepthsCache.get(laneKey)!.get(node.id) ?? 0;
  };
  for (const f of footprints) {
    const foot = occupied(f.node);
    const tileX = f.x - f.w / 2;
    const tileY = f.y - f.h / 2;
    tiles.push({
      kind: 'tile', id: f.id, node: f.node, depth: depthOf(f.node),
      x: tileX, y: tileY, w: foot.tile.w, h: foot.tile.h,
    });
    let pillY = tileY;
    for (const report of pillsByTask.get(f.id) ?? []) {
      const pillId = `pill:${report.id}:${f.id}`;
      const pillSize = sizeOf(pillId, sizes, FALLBACK_PILL);
      pills.push({
        kind: 'pill', id: pillId, reportId: report.id, title: report.title,
        taskId: f.id,
        x: tileX + foot.tile.w + LAYOUT_METRICS.pillGapX,
        y: pillY, w: pillSize.w, h: pillSize.h,
      });
      pillY += pillSize.h + LAYOUT_METRICS.pillGapY;
    }
  }
  const tileById = new Map(tiles.map(tile => [tile.id, tile]));

  // ---- Hulls per band (§3: bounds hull), chips, headers --------------------
  const bands = new Map<string, MapTaskNode[]>();
  for (const node of nodes) {
    const key = `${laneKeyOf(node)}\u0000${bandKeyOf(node)}`;
    if (!bands.has(key)) bands.set(key, []);
    bands.get(key)!.push(node);
  }
  // Furniture placement queries ride their own grid — a flat scan per spiral
  // candidate was quadratic across a few hundred chips and headers.
  const furnitureCell = 256;
  const furnitureGrid = new Map<string, Box[]>();
  const furnitureKey = (cx: number, cy: number) => cx + ':' + cy;
  const addSolid = (box: Box) => {
    const x0 = Math.floor(box.x / furnitureCell);
    const x1 = Math.floor((box.x + box.w) / furnitureCell);
    const y0 = Math.floor(box.y / furnitureCell);
    const y1 = Math.floor((box.y + box.h) / furnitureCell);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = furnitureKey(cx, cy);
        const bucket = furnitureGrid.get(key);
        if (bucket) bucket.push(box); else furnitureGrid.set(key, [box]);
      }
    }
  };
  const intersects = (a: Box, b: Box) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const solidHit = (candidate: Box) => {
    const x0 = Math.floor(candidate.x / furnitureCell);
    const x1 = Math.floor((candidate.x + candidate.w) / furnitureCell);
    const y0 = Math.floor(candidate.y / furnitureCell);
    const y1 = Math.floor((candidate.y + candidate.h) / furnitureCell);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const bucket = furnitureGrid.get(furnitureKey(cx, cy));
        if (bucket && bucket.some(existing => intersects(candidate, existing))) return true;
      }
    }
    return false;
  };
  for (const element of [...tiles, ...pills]) addSolid(element);
  const spiralPlace = (box: { w: number; h: number }, atX: number, atY: number): Box => {
    for (let step = 0; ; step += 1) {
      const radius = step === 0 ? 0 : m.spiralStep * Math.sqrt(step);
      const angle = step * GOLDEN_ANGLE;
      const candidate: Box = {
        x: atX + radius * Math.cos(angle) - box.w / 2,
        y: atY + radius * Math.sin(angle) - box.h / 2,
        w: box.w, h: box.h,
      };
      if (!solidHit(candidate)) return candidate;
    }
  };

  const hulls: PlacedHull[] = [];
  const chips: PlacedBandChip[] = [];
  const bandKeysSorted = [...bands.keys()].sort();
  for (const key of bandKeysSorted) {
    const [laneKey, bandKey] = key.split('\u0000');
    const bandNodes = bands.get(key)!;
    const phase = phaseById.get(bandKey);
    const label = phase ? phase.name : (bandKey === UNPHASED_BAND ? 'No phase' : bandKey);
    const goal = phase ? phase.goal : null;
    const bandId = `band:${laneKey}:${bandKey}`;
    const corners: Array<[number, number]> = [];
    for (const node of bandNodes) {
      const tile = tileById.get(node.id)!;
      const foot = occupied(node);
      corners.push(
        [tile.x - m.hullPad, tile.y - m.hullPad],
        [tile.x + foot.w + m.hullPad, tile.y - m.hullPad],
        [tile.x + foot.w + m.hullPad, tile.y + foot.h + m.hullPad],
        [tile.x - m.hullPad, tile.y + foot.h + m.hullPad],
      );
    }
    const points = convexHull(corners);
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    const hull: PlacedHull = {
      kind: 'hull', id: bandId, label, goal, laneId: laneKey, points,
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
    };
    hulls.push(hull);
    const chipId = `chip:band:${laneKey}:${bandKey}`;
    const chipSize = sizeOf(chipId, sizes, FALLBACK_CHIP);
    const chipBox = spiralPlace(chipSize, hull.x + hull.w / 2, hull.y - m.chipGap - chipSize.h / 2);
    chips.push({
      kind: 'chip', id: chipId, label, goal, bandId,
      x: chipBox.x, y: chipBox.y, w: chipBox.w, h: chipBox.h,
    });
    addSolid(chipBox);
  }

  const headers: PlacedLaneHeader[] = [];
  const laneKeysSorted = [...new Set(nodes.map(node => laneKeyOf(node)))].sort((a, b) => {
    if (a === UNASSIGNED_LANE) return 1;
    if (b === UNASSIGNED_LANE) return -1;
    return a.localeCompare(b);
  });
  for (const laneKey of laneKeysSorted) {
    // F1: the centring reduce below sums floats — id order, not wire order.
    const laneNodes = nodes.filter(node => laneKeyOf(node) === laneKey)
      .sort((a, b) => a.id.localeCompare(b.id));
    const laneTiles = laneNodes.map(node => tileById.get(node.id)!);
    const top = Math.min(...laneTiles.map(tile => tile.y));
    const cx = laneTiles.reduce((sum, tile) => sum + tile.x + tile.w / 2, 0) / laneTiles.length;
    const headerSize = sizeOf(`lane:${laneKey}`, sizes, FALLBACK_LANE_HEADER);
    const box = spiralPlace(
      headerSize, cx, top - m.headerGap - headerSize.h / 2);
    addSolid(box);
    const laneTaskCount = laneNodes.length;
    const laneCompleted = laneNodes.filter(node => node.status === 'completed').length;
    const laneActive = laneTaskCount - laneNodes.filter(node => node.status === 'archived').length;
    headers.push({
      kind: 'lane', id: `lane:${laneKey}`,
      label: laneKey === UNASSIGNED_LANE ? 'No project' : laneKey,
      taskCount: laneTaskCount,
      completed: laneCompleted,
      agentsLive: laneNodes.filter(node => Boolean(node.agent)).length,
      stuck: laneNodes.filter(node => node.status === 'stuck').length,
      upNext: laneNodes.filter(node => node.status === 'todo' || node.status === 'ideas').length,
      progress: laneActive > 0 ? Number((laneCompleted / laneActive).toFixed(4)) : 0,
      x: box.x, y: box.y, w: box.w, h: box.h,
    });
  }

  const elements: PlacedElement[] = [...hulls, ...chips, ...tiles, ...pills, ...headers];
  const minX = Math.min(...elements.map(e => e.x));
  const minY = Math.min(...elements.map(e => e.y));
  const shiftX = m.originX - minX;
  const shiftY = m.originY - minY;
  const shifted = elements.map(element => {
    if (element.kind === 'hull') {
      return {
        ...element,
        x: element.x + shiftX,
        y: element.y + shiftY,
        points: element.points.map(point =>
          [point[0] + shiftX, point[1] + shiftY] as const),
      } as PlacedElement;
    }
    return { ...element, x: element.x + shiftX, y: element.y + shiftY } as PlacedElement;
  });
  return {
    elements: shifted,
    width: Math.max(...shifted.map(e => e.x + e.w)) + m.originX,
    height: Math.max(...shifted.map(e => e.y + e.h)) + m.originY,
  };
}

/** The task altitude's layout for an organization — all four ship. */
export function layoutTaskAltitude(
  graph: MapGraph,
  sizes: SizeMap,
  organization: MapOrganization,
): LayoutResult {
  switch (organization) {
    case 'vertical': return layoutVertical(graph, sizes);
    case 'radial': return layoutRadial(graph, sizes);
    case 'organic': return layoutOrganic(graph, sizes);
    default: return layoutHorizontal(graph, sizes);
  }
}

/**
 * The independent overlap checker (§2 hard invariant). Bands legitimately
 * CONTAIN their tiles and a lane header sits beside its bands, so only
 * same-class pairs and genuinely disjoint classes are compared — a
 * containment relationship is not a collision.
 */
export function findOverlaps(elements: PlacedElement[]): Array<[string, string]> {
  // A non-finite or inverted box cannot be compared, and silently returning
  // "no overlap" for it would be the checker blessing a box it never
  // verified. Report it instead.
  const malformed = (b: Box) =>
    !Number.isFinite(b.x) || !Number.isFinite(b.y) ||
    !Number.isFinite(b.w) || !Number.isFinite(b.h) || b.w < 0 || b.h < 0;
  const intersects = (a: Box, b: Box) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const comparable = (a: PlacedElement, b: PlacedElement) => {
    // A HULL is the radial organization's band (§3: "bounds hull in
    // radial/organic") — a background container, not a collidable element.
    // Its BOUNDING BOX legitimately interleaves with neighbouring sectors'
    // boxes (an annular sector's bounding rect covers angles it does not
    // own), so box-comparison against hulls would flag fictions. The §2
    // invariant enumerates tiles, report pills, phase chips and lane/hub
    // headers — hulls are not among them, and the radial suite asserts
    // sector disjointness separately, in polar terms, the geometry hulls
    // actually have.
    if (a.kind === 'hull' || b.kind === 'hull') return false;
    if (a.kind === b.kind) return true;
    // A tile, chip or Report pill inside its own band is containment, never
    // collision. This is the ONLY exemption a pill gets: pill-vs-tile,
    // pill-vs-pill, pill-vs-chip and pill-vs-lane all stay compared, and
    // pill-vs-tile is precisely the pair that was invisible before.
    const contained = (x: PlacedElement, y: PlacedElement) =>
      (x.kind === 'tile' || x.kind === 'chip' || x.kind === 'pill') && y.kind === 'band';
    if (contained(a, b) || contained(b, a)) return false;
    // A CONTAINER is ONE project's region on the continuous plane, and it
    // contains THAT project's bands, tiles, chips, pills and lane header by
    // construction (amendment §2/§5-A3 clause 2). Containment is not
    // collision — but only for the project that owns it.
    //
    // Round-1 finding 7: an exemption written as "anything that is not a
    // container" is ownership-blind, and an element escaping into ANOTHER
    // project's ground is exactly the collision this checker exists to
    // report. The owner lane is resolved from the elements themselves, so
    // the oracle can still see a foreign escape.
    const inContainer = (x: PlacedElement, y: PlacedElement) =>
      y.kind === 'container' && x.kind !== 'container'
      && ownerLaneOf(x) !== null && ownerLaneOf(x) === y.laneId;
    if (inContainer(a, b) || inContainer(b, a)) return false;
    // Everything else — chip vs tile very much included (§2 names phase
    // chips among the elements that may never intersect) — is compared.
    return true;
  };
  // Owner lanes, resolved ONCE from the placed elements: a chip belongs to
  // its band's lane and a pill to its task's, and neither carries the lane
  // itself.
  const laneOfBand = new Map<string, string>();
  const laneOfTile = new Map<string, string>();
  for (const element of elements) {
    if (element.kind === 'band') laneOfBand.set(element.id, element.laneId);
    else if (element.kind === 'tile' && element.laneId) {
      laneOfTile.set(element.id, element.laneId);
    }
  }
  const ownerLaneOf = (element: PlacedElement): string | null => {
    switch (element.kind) {
      case 'tile': return element.laneId ?? null;
      case 'band': return element.laneId;
      case 'hull': return element.laneId;
      case 'container': return element.laneId;
      case 'lane': return element.id.slice('lane:'.length);
      case 'chip': return laneOfBand.get(element.bandId) ?? null;
      case 'pill': return laneOfTile.get(element.taskId) ?? null;
      default: return null;
    }
  };

  const found: Array<[string, string]> = [];
  for (const element of elements) {
    if (malformed(element)) found.push([element.id, 'MALFORMED_BOX']);
  }
  for (let i = 0; i < elements.length; i += 1) {
    for (let j = i + 1; j < elements.length; j += 1) {
      const a = elements[i];
      const b = elements[j];
      if (!comparable(a, b)) continue;
      if (intersects(a, b)) found.push([a.id, b.id]);
    }
  }
  return found;
}

export interface TreeGroup {
  laneId: string;
  laneLabel: string;
  bands: Array<{ id: string; label: string; goal: string | null; nodes: MapTaskNode[] }>;
}

/**
 * The accessible alternative (§6): the SAME scope and grouping the canvas
 * shows, as a plain tree — project → phase → task.
 *
 * DERIVED FROM THE GRAPH, NOT FROM A LAYOUT. It used to read placed `lane`,
 * `band` and `tile` elements, which exist only at the task altitude; an
 * aggregate layout contains none of them, so round 1 found "Show as list"
 * rendering EMPTY at both aggregate altitudes — and a large estate now ARRIVES
 * at one. §6 is untouched by A2 and requires the alternative over the same
 * scope at all times, so it cannot depend on which altitude happens to be
 * drawn. Membership is altitude-independent; the layout is not.
 */
export function buildTreeModel(graph: MapGraph): TreeGroup[] {
  const phaseById = new Map(graph.phases.map(phase => [phase.id, phase]));
  const lanes = new Map<string, Map<string, MapTaskNode[]>>();
  for (const node of graph.nodes) {
    const laneKey = laneKeyOf(node);
    const bandKey = bandKeyOf(node);
    if (!lanes.has(laneKey)) lanes.set(laneKey, new Map());
    const bands = lanes.get(laneKey)!;
    if (!bands.has(bandKey)) bands.set(bandKey, []);
    bands.get(bandKey)!.push(node);
  }

  // The same ordering the canvas uses, so the two readings agree.
  const laneKeys = [...lanes.keys()].sort((a, b) => {
    if (a === UNASSIGNED_LANE) return 1;
    if (b === UNASSIGNED_LANE) return -1;
    return a.localeCompare(b);
  });

  return laneKeys.map(laneKey => {
    const bands = lanes.get(laneKey)!;
    const bandKeys = [...bands.keys()].sort((a, b) => {
      if (a === UNPHASED_BAND) return 1;
      if (b === UNPHASED_BAND) return -1;
      const pa = phaseById.get(a);
      const pb = phaseById.get(b);
      if (!pa && !pb) return a.localeCompare(b);
      if (!pa) return 1;
      if (!pb) return -1;
      return byPositionThenName(pa, pb);
    });
    return {
      laneId: `lane:${laneKey}`,
      laneLabel: laneKey === UNASSIGNED_LANE ? 'No project' : laneKey,
      bands: bandKeys.map(bandKey => {
        const phase = phaseById.get(bandKey);
        const nodes = [...bands.get(bandKey)!].sort(
          (a, b) => a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id));
        return {
          id: `band:${laneKey}:${bandKey}`,
          label: phase ? phase.name : (bandKey === UNPHASED_BAND ? 'No phase' : bandKey),
          goal: phase ? phase.goal : null,
          nodes,
        };
      }),
    };
  });
}

/* ======================================================================
 * ZOOM AGGREGATION HIERARCHY — design 77950a97 amendment §2/§5-A2
 *
 * Three altitudes, not one: Tasks collapse into their Phase node, Phases
 * into their Project node, and split back on zoom in.
 *
 * THE RULE THIS SECTION EXISTS TO OBEY, learned from candidate 1bccea5
 * (branch rh-map-lod, superseded, blank canvas live at 5,200 tasks):
 * **aggregate nodes get their OWN 2D placement.** Freezing band interiors in
 * place left 55 lanes x 4 phases as a 220-row VERTICAL stack, because in the
 * horizontal organization lanes stack down and bands stack down inside them —
 * the only horizontal axis is dependency depth. Reducing the height of a
 * column does not make it a picture. So an altitude above `task` does NOT
 * reuse the lane/band geometry of §2; it lays its nodes out on a grid across
 * both axes. §2's lanes, bands and depth columns are unchanged AT THE TASK
 * ALTITUDE, which is all the amendment leaves them governing.
 *
 * Everything here is computed CLIENT-SIDE from rows already fetched (brief
 * requirement 5): the `lod=task` pin in mapGraphApi.ts is ratified and is not
 * touched. No altitude issues a read.
 * ====================================================================== */

/** The three altitudes of amendment §2/§5-A2. */
export type MapAltitude = 'task' | 'phase' | 'project';

/** Coarser-to-finer, so a transition can be reasoned about as a direction. */
export const ALTITUDE_ORDER: readonly MapAltitude[] = ['project', 'phase', 'task'];

/**
 * The four questions §1 demands the Map answer at a glance, plus the size and
 * progress A2 requires an aggregate to carry. A2: aggregate nodes carry their
 * contents' MEANING, "not merely a count".
 */
export interface AggregateFacts {
  taskCount: number;
  completed: number;
  /**
   * Archived work inside. Clause 2 (R3) requires "archived reads faded" at
   * every altitude, and a container cannot render a state it cannot count —
   * round-1 finding 3. `progress` has always divided by the ACTIVE total, so
   * this quantity was already being computed; it was merely not surfaced.
   */
  archived: number;
  /** §1 "who is working NOW" — brief requirement 6: from the existing `agent`
   *  field on the graph node (tasks.active_agent), never a new read. */
  agentsLive: number;
  stuck: number;
  upNext: number;
  /** In-progress or in review — what §4 calls "upstream in flight". Derived
   *  here rather than inferred by subtraction so the edge-state rule reads the
   *  same quantity the tile rule does. */
  inFlight: number;
  progress: number;
}

export interface AggregateNode extends AggregateFacts {
  id: string;
  kind: 'phase' | 'project';
  label: string;
  /** The lane key this aggregate belongs to; its own key at project altitude. */
  laneKey: string;
  /**
   * The lane's DISPLAY name. A Phase node carries its Project, because "Phase
   * 2" is not an identity: the seeded estate has 55 of them, and 193 nodes
   * labelled from a pool of four names answers none of the §1 questions at a
   * glance. Measured on DEV before this existed.
   */
  laneLabel: string;
  /** Sort position within the lane (phase altitude); 0 at project altitude. */
  position: number;
  /** Every Task rolled up into this node — the roll-up's audit trail, and what
   *  the edge roll-up and the accessible tree are derived from. */
  taskIds: readonly string[];
}

export interface PlacedAggregate extends Box {
  kind: 'aggregate';
  id: string;
  node: AggregateNode;
}

/**
 * Facts for a set of Tasks. Derived EXACTLY as `layoutHorizontal` derives the
 * lane header's counters, so a Project node and its lane header can never
 * disagree about the same project — the two are the same estate at two
 * altitudes, and a reader moving between them must not see the numbers change.
 */
export function aggregateFactsOf(nodes: readonly MapTaskNode[]): AggregateFacts {
  const taskCount = nodes.length;
  const completed = nodes.filter(node => node.status === 'completed').length;
  const agentsLive = nodes.filter(node => Boolean(node.agent)).length;
  const stuck = nodes.filter(node => node.status === 'stuck').length;
  const upNext = nodes.filter(node => node.status === 'todo' || node.status === 'ideas').length;
  const inFlight = nodes.filter(
    node => node.status === 'in-progress' || node.status === 'review').length;
  const archived = nodes.filter(node => node.status === 'archived').length;
  const active = taskCount - archived;
  return {
    taskCount,
    completed,
    archived,
    agentsLive,
    stuck,
    upNext,
    inFlight,
    progress: active > 0 ? Number((completed / active).toFixed(4)) : 0,
  };
}

/** The aggregate a Task rolls up into at a given altitude. */
export function aggregateKeyOf(node: MapTaskNode, altitude: MapAltitude): string {
  const lane = laneKeyOf(node);
  if (altitude === 'project') return `project:${lane}`;
  if (altitude === 'phase') return `phase:${lane}\u0000${bandKeyOf(node)}`;
  return node.id;
}

/**
 * Build the aggregate nodes for an altitude, in a deterministic order: lanes
 * as `layoutHorizontal` sorts them (unassigned last), and within a lane the
 * phases by declared position then name, with the unphased band last. Identical
 * input therefore lays out identically, which is what makes the grid stable
 * under re-measurement.
 */
export function buildAggregates(graph: MapGraph, altitude: MapAltitude): AggregateNode[] {
  if (altitude === 'task') return [];
  const phaseById = new Map(graph.phases.map(phase => [phase.id, phase]));
  const grouped = new Map<string, MapTaskNode[]>();
  for (const node of graph.nodes) {
    const key = aggregateKeyOf(node, altitude);
    const list = grouped.get(key);
    if (list) list.push(node); else grouped.set(key, [node]);
  }

  const built: AggregateNode[] = [];
  for (const [key, nodes] of grouped) {
    const lane = laneKeyOf(nodes[0]);
    const laneLabel = lane === UNASSIGNED_LANE ? 'No project' : lane;
    if (altitude === 'project') {
      built.push({
        id: key, kind: 'project', label: laneLabel, laneKey: lane, laneLabel, position: 0,
        taskIds: nodes.map(node => node.id),
        ...aggregateFactsOf(nodes),
      });
      continue;
    }
    const bandKey = bandKeyOf(nodes[0]);
    const phase = phaseById.get(bandKey);
    built.push({
      id: key,
      kind: 'phase',
      label: phase ? phase.name : (bandKey === UNPHASED_BAND ? 'No phase' : bandKey),
      laneKey: lane,
      laneLabel,
      // The unphased band sinks last, exactly as it does inside a lane in §2.
      position: phase ? phase.position : Number.MAX_SAFE_INTEGER,
      taskIds: nodes.map(node => node.id),
      ...aggregateFactsOf(nodes),
    });
  }

  const laneRank = (lane: string) => (lane === UNASSIGNED_LANE ? 1 : 0);
  built.sort((a, b) =>
    laneRank(a.laneKey) - laneRank(b.laneKey) ||
    a.laneKey.localeCompare(b.laneKey) ||
    a.position - b.position ||
    a.label.localeCompare(b.label) ||
    a.id.localeCompare(b.id));
  return built;
}

/**
 * An edge between aggregates. A2: "An aggregated edge may indicate
 * multiplicity; it may NEVER silently drop a relationship that exists below
 * it." `multiplicity` is how many Task-level edges this one stands for.
 */
/**
 * §4's chain state for an AGGREGATE, from the Tasks it stands for.
 *
 * §4 is untouched by A2 and requires dependency edges to be coloured by
 * upstream chain state at EVERY zoom — "red = something upstream is stuck, the
 * flow is dammed; blue = upstream in flight; green = fully satisfied". Round 6
 * found the aggregate altitudes drawing every dependency in one neutral
 * colour, which drops the single most information-dense thing an edge carries.
 *
 * The precedence mirrors the tile rule exactly: a dammed flow outranks an
 * in-flight one, and only a wholly completed upstream is satisfied.
 */
export function aggregateChainState(
  facts: AggregateFacts,
): 'dammed' | 'active' | 'satisfied' | 'neutral' {
  if (facts.stuck > 0) return 'dammed';
  if (facts.inFlight > 0) return 'active';
  if (facts.taskCount > 0 && facts.completed === facts.taskCount) return 'satisfied';
  return 'neutral';
}

export interface AggregateEdge {
  from: string;
  to: string;
  kind: 'dependency' | 'knowledge';
  multiplicity: number;
}

/** Same-aggregate relationship multiplicities, kind preserved (round 14). */
export interface InternalRollup {
  dependency: number;
  knowledge: number;
}

export interface AggregateEdgeRollup {
  edges: AggregateEdge[];
  /**
   * Edges whose two endpoints roll up into the SAME aggregate, counted per
   * aggregate id. These are the relationships an altitude cannot draw as a
   * line — and A2 forbids dropping them silently, so they are COUNTED and
   * surfaced on the node rather than discarded. Dropping them was the easy
   * wrong answer here.
   *
   * COUNTED PER KIND (round 14, B1): a single untyped total erased the
   * dependency-versus-Knowledge distinction §4 keeps meaningful at every
   * zoom — one internal dependency and one internal Report link produced
   * identical aggregate state. The kind survives the roll-up for the edges
   * that ARE drawn; it must survive for the ones that fold inside too.
   */
  internal: Map<string, InternalRollup>;
  /**
   * Edges with an endpoint outside the fetched scope. They are not drawable at
   * any altitude and were already invisible at the task altitude; recorded so
   * the count is auditable rather than absent.
   */
  danglingCount: number;
}

/**
 * Roll Task-level edges up to an altitude. Both kinds roll up (A2: "Knowledge
 * (Report) edges roll up the same way"), and each (from,to,kind) triple is
 * emitted ONCE with its multiplicity.
 */
export function rollUpEdges(
  graph: MapGraph,
  altitude: MapAltitude,
): AggregateEdgeRollup {
  const keyByTask = new Map<string, string>();
  for (const node of graph.nodes) keyByTask.set(node.id, aggregateKeyOf(node, altitude));

  const byPair = new Map<string, AggregateEdge>();
  const internal = new Map<string, InternalRollup>();
  let danglingCount = 0;

  for (const edge of graph.edges) {
    const from = keyByTask.get(edge.from);
    const to = keyByTask.get(edge.to);
    if (from === undefined || to === undefined) { danglingCount += 1; continue; }
    if (from === to) {
      const counts = internal.get(from) ?? { dependency: 0, knowledge: 0 };
      counts[edge.kind === 'dependency' ? 'dependency' : 'knowledge'] += 1;
      internal.set(from, counts);
      continue;
    }
    const pairKey = `${edge.kind}\u0000${from}\u0000${to}`;
    const existing = byPair.get(pairKey);
    if (existing) existing.multiplicity += 1;
    else byPair.set(pairKey, { from, to, kind: edge.kind, multiplicity: 1 });
  }

  // Deterministic order so identical input renders identically.
  const edges = [...byPair.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { edges, internal, danglingCount };
}

/**
 * §4's density collapse, as a pure rule so it can be tested rather than
 * inferred from a component.
 *
 * "Above a density threshold non-selected cross-lane edges collapse to
 * hover/selection-only." Until now that only reached the task altitude, and a
 * rolled-up graph is NOT automatically sparse: the seeded estate produces 474
 * Phase-to-Phase edges over 193 nodes - eight times the design's threshold,
 * unreadable as a picture, and ~450ms of routing.
 *
 * This collapses what is PAINTED, never what was rolled up: the roll-up still
 * accounts for every relationship, so A2's no-silent-drop contract is
 * untouched.
 */
/**
 * Everything PAINTED on the plane, as the obstacle set a route must avoid.
 *
 * A pure rule because the composition itself was the bug: round 6 found Report
 * edges routed against the aggregate nodes ONLY, so they ran through other
 * Report nodes while reporting clean. Whether a box blocks has nothing to do
 * with which array it arrived in - if it is drawn, it blocks.
 */
export function paintedObstacles(
  altitude: MapAltitude,
  taskFurniture: readonly Box[],
  aggregates: readonly Box[],
  aggregateReports: readonly Box[],
): Box[] {
  // Round 7: the task altitude passed only the TILES, so a route could run
  // straight through a lane header, a band chip or a Report pill - all of them
  // painted, all of them things a reader sees a line disappear behind. The
  // parameter is named for what it is now: everything the task altitude paints.
  if (altitude === 'task') return [...taskFurniture];
  return [...aggregates, ...aggregateReports];
}

/**
 * The §4 chain a selection lights, or null.
 *
 * `known` is what makes this safe across altitudes: a selection made at an
 * aggregate altitude is an AGGREGATE id, and matching it against Task ids lit
 * nothing while dimming everything - round 6 measured 14 of 14 tiles dimmed,
 * the highlight inverted into a blackout. An id the task altitude does not
 * recognise selects no chain at all.
 */
export function buildChain<T extends { from: string; to: string; kind: string }>(
  selectedId: string | null,
  edges: readonly T[],
  known: (id: string) => boolean,
): Set<string> | null {
  if (!selectedId || !known(selectedId)) return null;
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'dependency') continue;
    (up.get(edge.from) ?? up.set(edge.from, []).get(edge.from)!).push(edge.to);
    (down.get(edge.to) ?? down.set(edge.to, []).get(edge.to)!).push(edge.from);
  }
  const lit = new Set<string>([selectedId]);
  const walk = (id: string, links: Map<string, string[]>) => {
    for (const next of links.get(id) ?? []) {
      if (lit.has(next)) continue;
      lit.add(next);
      walk(next, links);
    }
  };
  walk(selectedId, up);
  walk(selectedId, down);
  return lit;
}

/**
 * The corrective-fit budget, as an explicit state machine.
 *
 * Fitting CHANGES the viewport, which admits tiles culling had withheld; those
 * measure afterwards and move the extent, after the one-shot debt is gone. One
 * corrective pass absorbs that. The subtlety round 7 caught is that the
 * corrective fit comes back through the SAME "a fit was spent" path, and if
 * that path hands out an allowance unconditionally the corrective fit funds
 * its own successor - so the advertised one-pass bound financed an unbounded
 * sequence, one fit per culling expansion.
 *
 * Modelled here rather than in refs so the bound can actually be tested.
 */
export interface CorrectiveFitState {
  /** Corrective passes still available for the CURRENT initial fit. */
  budget: number;
  /** True when the fit now pending is itself the corrective one. */
  armed: boolean;
  /** The extent the spent fit was computed against. */
  spentExtent: { width: number; height: number } | null;
}

export const INITIAL_CORRECTIVE_FIT: CorrectiveFitState = {
  budget: 0, armed: false, spentExtent: null,
};

/** A fit was just spent against `extent`. */
export function onFitSpent(
  state: CorrectiveFitState,
  extent: { width: number; height: number },
): CorrectiveFitState {
  return {
    // A corrective fit does not get a corrective fit of its own.
    budget: state.armed ? 0 : 1,
    armed: false,
    spentExtent: extent,
  };
}

/** The layout extent changed. Should a corrective refit be requested? */
export function onExtentChanged(
  state: CorrectiveFitState,
  extent: { width: number; height: number },
): { state: CorrectiveFitState; refit: boolean } {
  if (state.budget <= 0 || state.spentExtent === null) return { state, refit: false };
  if (state.spentExtent.width === extent.width
    && state.spentExtent.height === extent.height) return { state, refit: false };
  return {
    state: { budget: state.budget - 1, armed: true, spentExtent: null },
    refit: true,
  };
}

/** An explicit "Fit" starts the whole cycle over. */
export function onExplicitFit(): CorrectiveFitState {
  return { ...INITIAL_CORRECTIVE_FIT };
}

/**
 * Everything §4 discloses for a selected chain: the collapsed set, plus every
 * edge whose BOTH endpoints lie in the chain.
 *
 * Round 7: an aggregate selection revealed only its immediate edges, so a
 * chain A->B->C disclosed A->B and hid B->C. Half a relationship is worse than
 * none, because it reads as the whole one.
 */
export function revealChain<T extends { from: string; to: string }>(
  all: readonly T[],
  collapsed: readonly T[],
  chain: ReadonlySet<string> | null,
  origin: string | null = null,
  limit = Number.POSITIVE_INFINITY,
): T[] {
  if (!chain) return [...collapsed];

  // BOUNDED, and by hop distance from what the reader actually pointed at.
  //
  // A transitive chain over a ROLLED-UP graph is not the modest thing it is
  // over Tasks: measured live on the seeded estate, one Phase node's chain
  // reached 506 of 543 edges, because rolled-up dependencies connect almost
  // everything to almost everything. Disclosing all of it re-drew the hairball
  // §4 exists to prevent AND cost 457ms long tasks on an ordinary pan.
  //
  // So the chain still determines WHAT IS RELATED - the dimming is unchanged -
  // while what is DRAWN stays inside the same budget §4 sets for everything
  // else, nearest hops first.
  const hop = new Map<string, number>();
  if (origin && chain.has(origin)) {
    const neighbours = new Map<string, string[]>();
    for (const edge of all) {
      if (!chain.has(edge.from) || !chain.has(edge.to)) continue;
      (neighbours.get(edge.from) ?? neighbours.set(edge.from, []).get(edge.from)!).push(edge.to);
      (neighbours.get(edge.to) ?? neighbours.set(edge.to, []).get(edge.to)!).push(edge.from);
    }
    hop.set(origin, 0);
    const queue = [origin];
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i];
      for (const next of neighbours.get(id) ?? []) {
        if (hop.has(next)) continue;
        hop.set(next, hop.get(id)! + 1);
        queue.push(next);
      }
    }
  }
  const distance = (edge: T) =>
    Math.max(hop.get(edge.from) ?? Number.MAX_SAFE_INTEGER, hop.get(edge.to) ?? Number.MAX_SAFE_INTEGER);

  const inChain = all.filter(edge => chain.has(edge.from) && chain.has(edge.to));
  const ordered = [...inChain].sort((a, b) => distance(a) - distance(b));
  const shown = new Set<T>(collapsed);
  for (const edge of ordered) {
    if (shown.size >= limit) break;
    shown.add(edge);
  }
  return all.filter(edge => shown.has(edge));
}

/**
 * The aggregate edges actually DRAWN: §4's density collapse, then the selected
 * chain's full disclosure on top of it.
 *
 * Composed here rather than in the component because the COMPOSITION is where
 * every defect in this area has lived. Round 8 found a selected chain trimmed
 * to §4's ~60 - a threshold §4 gives for NON-SELECTED cross-lane collapse and
 * never offers as a budget a selection may be cut to. Both halves were
 * individually correct and individually tested; the bug was only in how they
 * were joined, which is exactly what a test of the parts cannot see.
 *
 * There is deliberately NO limit parameter here. A bounded selected chain
 * needs a declared amendment defining a truthful bounded form, not a caller
 * quietly passing a number.
 */
export function aggregateEdgesToDraw<T extends { from: string; to: string }>(
  all: readonly T[],
  threshold: number,
  lit: string | null,
  isCrossLane: (edge: T) => boolean,
  chain: ReadonlySet<string> | null,
): T[] {
  return revealChain(all, collapseDenseEdges(all, threshold, lit, isCrossLane), chain);
}

export function collapseDenseEdges<T extends { from: string; to: string }>(
  edges: readonly T[],
  threshold: number,
  lit: string | null,
  isCrossLane: (edge: T) => boolean = () => true,
): T[] {
  if (edges.length <= threshold) return [...edges];
  // §4 collapses NON-SELECTED CROSS-LANE edges - not every edge. Round 5
  // caught the difference mattering: collapsing everything also hid
  // Phase-to-Phase edges WITHIN one Project, which are same-lane, local, and
  // the most readable relationships on the surface. An arrival with nothing
  // drawn is the "shows nothing useful" defect A2 names, produced by the very
  // rule meant to keep the picture readable.
  return edges.filter(edge =>
    !isCrossLane(edge) || edge.from === lit || edge.to === lit);
}

export const AGGREGATE_METRICS = {
  gapX: 32,
  gapY: 28,
  originX: 32,
  originY: 32,
} as const;

/**
 * Generous like the others (Rule 1): a too-large fallback spreads the grid and
 * self-corrects on the measured pass; a too-small one produces overlap.
 */
export const FALLBACK_AGGREGATE = { w: 220, h: 104 } as const;

/**
 * Choose a column count whose resulting grid best matches the viewport's
 * aspect, using the MEASURED cell boxes rather than an assumed cell size.
 *
 * This is the whole answer to requirement 4. A fixed column count, or a column
 * count derived from an assumed square cell, reproduces the rh-map-lod failure
 * in a new place: the grid has to spread across the axis the estate is wide in,
 * and only the real boxes know how wide that is.
 */
export function chooseColumns(
  cells: ReadonlyArray<{ w: number; h: number }>,
  aspect: number,
): number {
  const count = cells.length;
  if (count <= 1) return Math.max(1, count);
  const target = Math.log(Math.max(0.05, aspect));
  let best = 1;
  let bestError = Number.POSITIVE_INFINITY;
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const columnWidth = new Array<number>(columns).fill(0);
    const rowHeight = new Array<number>(rows).fill(0);
    for (let index = 0; index < count; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      columnWidth[column] = Math.max(columnWidth[column], cells[index].w);
      rowHeight[row] = Math.max(rowHeight[row], cells[index].h);
    }
    const width = columnWidth.reduce((a, b) => a + b, 0) + AGGREGATE_METRICS.gapX * (columns - 1);
    const height = rowHeight.reduce((a, b) => a + b, 0) + AGGREGATE_METRICS.gapY * (rows - 1);
    if (width <= 0 || height <= 0) continue;
    const error = Math.abs(Math.log(width / height) - target);
    // Strict improvement only, so ties keep the SMALLER column count and the
    // choice stays deterministic.
    if (error < bestError - 1e-9) { bestError = error; best = columns; }
  }
  return best;
}

/**
 * Lay aggregate nodes out on a 2D grid (requirement 4). Row-major in the
 * deterministic order `buildAggregates` produced, so a project's phases stay
 * adjacent and the reading order matches the accessible tree.
 *
 * Boxes come from `sizes` like everything else in this file; the grid's own
 * width and height are DERIVED from those boxes, never assumed.
 */
export function layoutAggregateGrid(
  aggregates: readonly AggregateNode[],
  sizes: SizeMap,
  aspect: number = 16 / 10,
): LayoutResult {
  const m = AGGREGATE_METRICS;
  if (aggregates.length === 0) {
    return { elements: [], width: m.originX * 2, height: m.originY * 2 };
  }
  const cells = aggregates.map(node => sizeOf(node.id, sizes, FALLBACK_AGGREGATE));
  const columns = chooseColumns(cells, aspect);
  const rows = Math.ceil(aggregates.length / columns);

  const columnWidth = new Array<number>(columns).fill(0);
  const rowHeight = new Array<number>(rows).fill(0);
  for (let index = 0; index < aggregates.length; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidth[column] = Math.max(columnWidth[column], cells[index].w);
    rowHeight[row] = Math.max(rowHeight[row], cells[index].h);
  }
  const columnX: number[] = [];
  let cursorX = m.originX;
  for (let column = 0; column < columns; column += 1) {
    columnX.push(cursorX);
    cursorX += columnWidth[column] + m.gapX;
  }
  const rowY: number[] = [];
  let cursorY = m.originY;
  for (let row = 0; row < rows; row += 1) {
    rowY.push(cursorY);
    cursorY += rowHeight[row] + m.gapY;
  }

  const elements: PlacedAggregate[] = aggregates.map((node, index) => ({
    kind: 'aggregate',
    id: node.id,
    node,
    x: columnX[index % columns],
    y: rowY[Math.floor(index / columns)],
    w: cells[index].w,
    h: cells[index].h,
  }));

  return {
    elements,
    width: cursorX - m.gapX + m.originX,
    height: cursorY - m.gapY + m.originY,
  };
}

/**
 * The altitude's layout. The task altitude renders the selected ORGANIZATION
 * (§2); the aggregate altitudes get their own grid, which is
 * organization-neutral by construction — it fits the viewport's aspect, and
 * its row-major reading order (lane, then declared position) is the reading
 * order of both pipeline organizations.
 */
export function layoutAtAltitude(
  graph: MapGraph,
  sizes: SizeMap,
  altitude: MapAltitude,
  aspect: number = 16 / 10,
  organization: MapOrganization = 'horizontal',
): LayoutResult {
  if (altitude === 'task') return layoutTaskAltitude(graph, sizes, organization);
  return layoutAggregateAltitude(graph, sizes, altitude, aspect);
}

/* ======================================================================
 * ALTITUDE SELECTION — which altitude a given zoom is looking at.
 *
 * WHY THIS IS NOT A SCALE THRESHOLD. Each altitude has its OWN plane: the
 * task altitude of a 5,200-task estate measures ~1,600 x 538,000, while its
 * project altitude measures ~1,800 x 1,100. `scale` therefore means something
 * different in each — 0.65 shows the whole estate at the project altitude and
 * one corner of one lane at the task altitude. A constant compared against
 * `view.scale` cannot select between them, and a table of per-altitude scale
 * constants would silently go wrong the moment the estate's size changed.
 *
 * WHAT IS INVARIANT is how big a node lands ON SCREEN, in CSS pixels. That is
 * what a reader's eye actually responds to, it is independent of the estate's
 * size and of the layout's units, and it is directly calibratable (brief
 * requirement 7 records these constants for the A8 re-run).
 *
 * THE OSCILLATION HAZARD. 232dc7b3 F4 warns that threshold-crossing reflow
 * MULTIPLIES with two new thresholds. A naive implementation transitions at a
 * boundary, lands next to that same boundary in the new altitude, and
 * transitions straight back — content flickering under a stationary cursor.
 * Two things make that impossible here rather than unlikely:
 *
 *  1. ASCEND and DESCEND use DIFFERENT triggers (40px and 280px), so the bands
 *     overlap and there is no single point where both fire — ordinary
 *     hysteresis.
 *  2. On entering an altitude the scale is set so the mean node lands at the
 *     GEOMETRIC MEAN of the two triggers — the point furthest from both in the
 *     ratio sense, which is the sense a zoom operates in. A freshly entered
 *     altitude is therefore never near either trigger, so `settleAltitude`
 *     makes at most ONE transition and its result is a fixed point.
 * ====================================================================== */

/**
 * Mean on-screen node width, in CSS pixels, at which an altitude stops being
 * readable (ascend to something coarser) or becomes roomy enough to split
 * (descend to something finer).
 *
 * CALIBRATION (brief requirement 7): recorded for the A8 re-run.
 * `ascendBelow` is 40px because design 77950a97 §5 requires the far band to
 * draw "status-tinted shapes ... NEVER unmounted, never dots" — a 170px tile
 * at 40px on screen is still a shape; below that it is a dot. `descendAbove`
 * is 280px because a 220px aggregate drawn wider than that is spending screen
 * on one summary that its children could be using.
 */
export const ALTITUDE_NODE_PX = {
  ascendBelow: 40,
  descendAbove: 280,
} as const;

/**
 * Where a freshly entered altitude puts its nodes: the geometric mean of the
 * two triggers. See the oscillation note above — this is the choice that makes
 * `settleAltitude` a fixed point rather than a probably-fine.
 */
export const ALTITUDE_ENTRY_PX = Math.sqrt(
  ALTITUDE_NODE_PX.ascendBelow * ALTITUDE_NODE_PX.descendAbove,
);

/** The element kind an altitude places, and whose width the triggers read. */
const primaryKindOf = (altitude: MapAltitude): PlacedElement['kind'] =>
  (altitude === 'task' ? 'tile' : 'aggregate');

/**
 * Mean width, in PLANE units, of the nodes this altitude places. Returns null
 * when the altitude placed nothing — an empty scope has no node size, and
 * inventing one would feed a fabricated number to the trigger.
 */
export function meanNodeWidth(layout: LayoutResult, altitude: MapAltitude): number | null {
  const kind = primaryKindOf(altitude);
  let total = 0;
  let count = 0;
  for (const element of layout.elements) {
    if (element.kind !== kind) continue;
    total += element.w;
    count += 1;
  }
  return count > 0 ? total / count : null;
}

const coarserThan = (altitude: MapAltitude): MapAltitude | null => {
  const index = ALTITUDE_ORDER.indexOf(altitude);
  return index > 0 ? ALTITUDE_ORDER[index - 1] : null;
};
const finerThan = (altitude: MapAltitude): MapAltitude | null => {
  const index = ALTITUDE_ORDER.indexOf(altitude);
  return index >= 0 && index < ALTITUDE_ORDER.length - 1 ? ALTITUDE_ORDER[index + 1] : null;
};

export interface AltitudeState {
  altitude: MapAltitude;
  scale: number;
}

export interface AltitudeOptions {
  /** The view's own limits, applied to every scale this module produces. */
  clampScale: (scale: number) => number;
  /** Viewport box, for aspect and for the fitted scale. */
  viewport: { width: number; height: number };
  /** The organization the task altitude renders (§2). Default: horizontal. */
  organization?: MapOrganization;
}

const aspectOf = (viewport: { width: number; height: number }) =>
  (viewport.width > 0 && viewport.height > 0 ? viewport.width / viewport.height : 16 / 10);

/** The scale at which a layout fits the viewport — §5's "fresh view fits content". */
export function fitScaleFor(
  layout: LayoutResult,
  options: AltitudeOptions,
): number {
  const { viewport } = options;
  if (!viewport.width || !viewport.height) return options.clampScale(1);
  return options.clampScale(Math.min(
    viewport.width / Math.max(1, layout.width),
    viewport.height / Math.max(1, layout.height),
  ));
}

/**
 * Settle a (altitude, scale) pair produced by a USER ZOOM to one that fires no
 * trigger. At most one transition, by construction (see the header).
 */
export function settleAltitude(
  graph: MapGraph,
  sizes: SizeMap,
  start: AltitudeState,
  options: AltitudeOptions,
): AltitudeState {
  const aspect = aspectOf(options.viewport);
  let state: AltitudeState = { ...start, scale: options.clampScale(start.scale) };

  // The bound is a backstop against a pathological SizeMap (for instance a
  // clamp pinning the scale to SCALE_MIN so the entry width is unreachable),
  // never the mechanism. When it is what stops the walk the LAST state is
  // returned, so the caller still has something renderable.
  for (let step = 0; step < ALTITUDE_ORDER.length + 1; step += 1) {
    const layout = layoutAtAltitude(graph, sizes, state.altitude, aspect, options.organization);
    const planeWidth = meanNodeWidth(layout, state.altitude);
    // Nothing placed: no node size exists, so no trigger can be evaluated
    // honestly. Stay put — an empty scope renders its empty-state overlay.
    if (planeWidth === null || planeWidth <= 0) return state;

    const screenWidth = planeWidth * state.scale;
    const next =
      screenWidth < ALTITUDE_NODE_PX.ascendBelow ? coarserThan(state.altitude)
        : screenWidth > ALTITUDE_NODE_PX.descendAbove ? finerThan(state.altitude)
          : null;
    if (next === null) {
      // Nothing coarser exists, so a reader zooming out would otherwise shrink
      // the estate until it is unreadable — measured live at 5,200 tasks, the
      // project altitude bottomed out at SCALE_MIN with 26px nodes. A2 is
      // explicit that "a zoom level that shows nothing useful is a defect", and
      // there is no further picture to collapse into, so the scale holds at the
      // floor rather than continuing into noise.
      if (screenWidth < ALTITUDE_NODE_PX.ascendBelow) {
        return {
          ...state,
          scale: options.clampScale(ALTITUDE_NODE_PX.ascendBelow / planeWidth),
        };
      }
      return state;
    }

    const nextWidth = meanNodeWidth(
      layoutAtAltitude(graph, sizes, next, aspect, options.organization), next);
    if (nextWidth === null || nextWidth <= 0) return state;
    state = { altitude: next, scale: options.clampScale(ALTITUDE_ENTRY_PX / nextWidth) };
  }
  return state;
}

/**
 * One step of landing the arrival fit, as a decision rather than as control
 * flow buried in an effect.
 *
 * The hazard this encodes: `initialAltitude` may choose an altitude that has
 * never been MOUNTED, so every box in it is a fallback. Fitting there spends
 * the one-shot debt against placeholder geometry — the exact 232dc7b3 F2 class
 * this card must prevent, reproduced by the adversarial pre-review as a
 * 3308x2280 fallback fit against a 4568x3000 measured layout.
 *
 * So a differing arrival altitude is a MOVE (go there, keep the debt), and
 * only an altitude already on screen may be fitted. `visited` bounds the walk:
 * without it two altitudes could each keep selecting the other as measurements
 * arrive, and the view would never settle.
 */
export function arrivalFitStep(
  current: MapAltitude,
  arrival: MapAltitude,
  visited: ReadonlySet<MapAltitude>,
): { action: 'move'; to: MapAltitude } | { action: 'fit' } {
  if (arrival !== current && !visited.has(arrival)) return { action: 'move', to: arrival };
  return { action: 'fit' };
}

/**
 * The altitude a FRESH view arrives at, and the scale that fits it.
 *
 * This is a direct encoding of A2's governing principle — "show as much detail
 * as the space allows, and SIMPLIFY rather than degrade. A zoom level that
 * shows nothing useful is a defect": take the FINEST altitude whose FITTED
 * view still draws nodes big enough to read, and fit to it.
 *
 * It is deliberately NOT `settleAltitude` from some seed scale. Settling is
 * built for stability under a user's zoom and stops at the first altitude that
 * fires no trigger; arrival wants the most detailed altitude that works, which
 * is a different question. Using the settle rule here stranded a 14-task
 * estate at the project altitude — three summary boxes on an empty canvas,
 * which is precisely the "shows nothing useful" A2 calls a defect.
 *
 * No task-count constant appears anywhere: the same rule sends a small estate
 * to the task altitude and a 5,200-task estate to an aggregate one, because
 * the only input is whether the nodes come out readable.
 */
export function initialAltitude(
  graph: MapGraph,
  sizes: SizeMap,
  options: AltitudeOptions,
): AltitudeState {
  const aspect = aspectOf(options.viewport);
  let fallback: AltitudeState | null = null;

  // Finest last in ALTITUDE_ORDER, so walk it backwards and take the first
  // altitude that reads.
  for (let index = ALTITUDE_ORDER.length - 1; index >= 0; index -= 1) {
    const altitude = ALTITUDE_ORDER[index];
    const layout = layoutAtAltitude(graph, sizes, altitude, aspect, options.organization);
    const planeWidth = meanNodeWidth(layout, altitude);
    if (planeWidth === null || planeWidth <= 0) continue;
    const scale = fitScaleFor(layout, options);
    const state: AltitudeState = { altitude, scale };
    // Remember the coarsest workable altitude: if NOTHING reads (an estate so
    // large that even the project altitude fits below the floor), the coarsest
    // is still the least bad picture, and returning it beats returning a task
    // altitude nobody can see.
    fallback = state;
    if (planeWidth * scale >= ALTITUDE_NODE_PX.ascendBelow) return state;
  }
  return fallback ?? { altitude: ALTITUDE_ORDER[0], scale: options.clampScale(1) };
}

/* ======================================================================
 * EDGE ROUTING — card bd4decb4, absorbed into 29fd5338 by amendment
 * §2/§5-A2: "Edges route around nodes and curve. A connection drawn under a
 * tile is not a connection a reader can follow."
 *
 * A straight chord between two nodes passes under whatever sits between them,
 * and at estate scale something usually does. The fix is a quadratic curve
 * whose control point is pushed off the chord until the curve's own midpoint
 * clears every node box it would otherwise cross.
 *
 * The search is BOUNDED and its failure is honest: if no offset in the ladder
 * clears the obstacles, the largest one is returned rather than looping or
 * pretending. A curve that still clips one node is a legible connection; a
 * hang is not, and neither is a straight line through six tiles.
 * ====================================================================== */

/** Curve offsets tried, as a fraction of chord length, nearest-first and
 *  alternating sides so a curve bows the shortest way that works. */
const ROUTE_OFFSETS = [
  0.12, -0.12, 0.22, -0.22, 0.34, -0.34, 0.5, -0.5,
  0.7, -0.7, 0.95, -0.95, 1.3, -1.3,
] as const;

/** Clearance kept from a node when a route runs beside it. */
const CORRIDOR_MARGIN = 6;
/** How many corridor candidates are tried per axis, nearest-first. */
const CORRIDOR_CANDIDATES = 8;

/** Does a straight segment meet an axis-aligned box? Exact, by clipping. */
export function segmentIntersectsBox(
  x1: number, y1: number, x2: number, y2: number, box: Box,
): boolean {
  // Liang-Barsky: the segment meets the box iff the parameter interval
  // surviving all four half-plane clips is non-empty.
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const tests: Array<[number, number]> = [
    [-dx, x1 - box.x],
    [dx, box.x + box.w - x1],
    [-dy, y1 - box.y],
    [dy, box.y + box.h - y1],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return false;     // parallel and outside this edge
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
}

/** The box a quadratic actually occupies — its extrema, not its control hull. */
export function quadraticBounds(
  x1: number, y1: number, cx: number, cy: number, x2: number, y2: number,
): Box {
  const axis = (a: number, c: number, b: number) => {
    const values = [a, b];
    const denominator = a - 2 * c + b;
    if (Math.abs(denominator) > 1e-9) {
      const t = (a - c) / denominator;
      if (t > 0 && t < 1) values.push((1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b);
    }
    return [Math.min(...values), Math.max(...values)] as const;
  };
  const [minX, maxX] = axis(x1, cx, x2);
  const [minY, maxY] = axis(y1, cy, y2);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

const withinEnvelope = (box: Box, envelope: Box | null) => (
  envelope === null || (
    box.x >= envelope.x && box.y >= envelope.y &&
    box.x + box.w <= envelope.x + envelope.w &&
    box.y + box.h <= envelope.y + envelope.h)
);

/**
 * Centres of the CLEAR GAPS between obstacle spans on one axis, nearest a
 * preferred coordinate first.
 *
 * This is what makes routing guaranteed rather than hopeful. The layout is
 * built from boxes separated by real gaps — `tileGapX` 24, `laneGapY` 40,
 * the aggregate grid's 32/28 — so clear corridors always EXIST; the previous
 * routers just never looked for them, and bowed or stepped at arbitrary
 * offsets that happened to land on a node.
 */
function gapCentres(
  spans: ReadonlyArray<readonly [number, number]>,
  prefer: number,
  lo: number,
  hi: number,
): number[] {
  const merged: Array<[number, number]> = [];
  for (const [a, b] of [...spans].sort((p, q) => p[0] - q[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const centres: number[] = [];
  // Outside the field entirely, on both sides.
  centres.push(merged.length ? merged[0][0] - CORRIDOR_MARGIN : prefer);
  if (merged.length) centres.push(merged[merged.length - 1][1] + CORRIDOR_MARGIN);
  for (let i = 0; i < merged.length - 1; i += 1) {
    const gapStart = merged[i][1];
    const gapEnd = merged[i + 1][0];
    if (gapEnd - gapStart > 1) centres.push((gapStart + gapEnd) / 2);
  }
  return centres
    .filter(value => value >= lo && value <= hi)
    .sort((a, b) => Math.abs(a - prefer) - Math.abs(b - prefer))
    .slice(0, CORRIDOR_CANDIDATES);
}

/**
 * An orthogonal route through the layout's own gaps: out of the source, along
 * a clear vertical corridor, across a clear horizontal one, and into the
 * target. Every segment is verified with the exact test, and the whole path is
 * required to stay inside `envelope` — a route that leaves the plane is clipped
 * by the canvas into disconnected stubs, which is not a connection a reader can
 * follow either.
 */
function corridorRoute(
  x1: number, y1: number, x2: number, y2: number,
  blocking: readonly Box[],
  envelope: Box | null,
): { d: string; clear: boolean } {
  const clearRun = (points: Array<[number, number]>) => {
    for (let i = 0; i < points.length - 1; i += 1) {
      const [ax, ay] = points[i];
      const [bx, by] = points[i + 1];
      if (envelope && !withinEnvelope(
        { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) },
        envelope,
      )) return false;
      if (blocking.some(box => segmentIntersectsBox(ax, ay, bx, by, box))) return false;
    }
    return true;
  };

  const lo = envelope ? envelope.x : -Infinity;
  const hi = envelope ? envelope.x + envelope.w : Infinity;
  const loY = envelope ? envelope.y : -Infinity;
  const hiY = envelope ? envelope.y + envelope.h : Infinity;

  const xSpans = blocking.map(b => [b.x, b.x + b.w] as const);
  const ySpans = blocking.map(b => [b.y, b.y + b.h] as const);
  const exits = gapCentres(xSpans, x1, lo, hi);
  const entries = gapCentres(xSpans, x2, lo, hi);
  const lanes = gapCentres(ySpans, (y1 + y2) / 2, loY, hiY);

  let best = `M ${x1} ${y1} L ${x2} ${y2}`;
  const candidates: Array<{ points: Array<[number, number]>; cost: number }> = [];
  for (const exit of exits) {
    for (const entry of entries) {
      for (const lane of lanes) {
        const points: Array<[number, number]> = [
          [x1, y1], [exit, y1], [exit, lane], [entry, lane], [entry, y2], [x2, y2],
        ];
        const cost = Math.abs(exit - x1) + Math.abs(lane - y1)
          + Math.abs(entry - exit) + Math.abs(y2 - lane) + Math.abs(x2 - entry);
        candidates.push({ points, cost });
      }
    }
  }
  // Shortest first, so the accepted route is the least detour that works.
  candidates.sort((a, b) => a.cost - b.cost);
  for (const candidate of candidates) {
    if (clearRun(candidate.points)) {
      return { d: 'M ' + candidate.points.map(([x, y]) => `${x} ${y}`).join(' L '), clear: true };
    }
  }
  return { d: best, clear: false };
}

/**
 * A point ON a quadratic Bezier at parameter t — NOT the control point. The
 * control point is not on the curve at all, so testing it would clear
 * obstacles the ink still crosses.
 */
export function quadraticPointAt(
  t: number, x1: number, y1: number, cx: number, cy: number, x2: number, y2: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * x1 + 2 * u * t * cx + t * t * x2,
    y: u * u * y1 + 2 * u * t * cy + t * t * y2,
  };
}

/**
 * Does a quadratic Bezier intersect an axis-aligned box? EXACTLY, not by
 * sampling.
 *
 * Two rounds of review killed the sampled versions, and both were right. The
 * first tested t=0.5 alone and missed a crossing at t=0.25. The second tested
 * eleven points and still missed a crossing at t=0.28 between production-sized
 * 170x96 tiles — because on a long route eleven samples are hundreds of pixels
 * apart, and a node fits comfortably between two of them. No sample count
 * fixes that: the gap scales with the chord, so a longer edge always defeats
 * it. The test has to be analytic.
 *
 * Each axis of the curve is a quadratic in t, so the parameters where it meets
 * a box EDGE are the roots of one quadratic per edge. Collect the roots in
 * [0,1], check the other coordinate lies within the box's span there, and add
 * the two endpoints for the case where the curve begins or ends inside.
 */
export function quadraticIntersectsBox(
  x1: number, y1: number, cx: number, cy: number, x2: number, y2: number,
  box: Box,
): boolean {
  const inside = (x: number, y: number) =>
    x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;

  // A curve wholly inside the box never crosses an edge, so test the ends.
  if (inside(x1, y1) || inside(x2, y2)) return true;

  // Roots of a*t^2 + b*t + c = 0 within [0,1]. `a` near zero is the linear
  // case, which a naive quadratic solve turns into a division by zero.
  const roots = (a: number, b: number, c: number): number[] => {
    const out: number[] = [];
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) > 1e-9) out.push(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) return out;
      const root = Math.sqrt(disc);
      out.push((-b + root) / (2 * a), (-b - root) / (2 * a));
    }
    return out.filter(t => t >= 0 && t <= 1);
  };

  const ax = x1 - 2 * cx + x2;
  const bx = 2 * (cx - x1);
  const ay = y1 - 2 * cy + y2;
  const by = 2 * (cy - y1);

  const at = (t: number) => quadraticPointAt(t, x1, y1, cx, cy, x2, y2);
  const EPS = 1e-6;

  for (const edge of [box.x, box.x + box.w]) {
    for (const t of roots(ax, bx, x1 - edge)) {
      const point = at(t);
      if (point.y >= box.y - EPS && point.y <= box.y + box.h + EPS) return true;
    }
  }
  for (const edge of [box.y, box.y + box.h]) {
    for (const t of roots(ay, by, y1 - edge)) {
      const point = at(t);
      if (point.x >= box.x - EPS && point.x <= box.x + box.w + EPS) return true;
    }
  }
  return false;
}

/**
 * Endpoint boxes shrunk by a hair. A route ATTACHES to an endpoint, so it must
 * be allowed to touch its boundary — but it must never pass THROUGH either
 * connected node. Round 4 reproduced exactly that: a reverse-direction edge
 * left the source towards the left, immediately re-entering the source, and
 * approached the target's left edge from the right, crossing the target — all
 * while reporting `clipped:false`, because both endpoint boxes had simply been
 * removed from the obstacle set.
 */
const SHRINK = 0.01;
const shrunk = (box: Box): Box => ({
  x: box.x + SHRINK, y: box.y + SHRINK,
  w: Math.max(0, box.w - 2 * SHRINK), h: Math.max(0, box.h - 2 * SHRINK),
});

type AttachSide = 'right' | 'left' | 'top' | 'bottom';

const attachPoint = (box: Box, side: AttachSide): [number, number] => {
  switch (side) {
    case 'right': return [box.x + box.w, box.y + box.h / 2];
    case 'left': return [box.x, box.y + box.h / 2];
    case 'top': return [box.x + box.w / 2, box.y];
    default: return [box.x + box.w / 2, box.y + box.h];
  }
};

/**
 * Attachment side pairs, best first. A route should LEAVE the source on the
 * side facing the target and ENTER the target on the side facing back — which
 * is what the fixed right-to-left construction got wrong for every edge whose
 * target sits left of or above its source.
 */
function sidePairs(source: Box, target: Box): Array<[AttachSide, AttachSide]> {
  const dx = (target.x + target.w / 2) - (source.x + source.w / 2);
  const dy = (target.y + target.h / 2) - (source.y + source.h / 2);
  const horizontal: [AttachSide, AttachSide] = dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  const vertical: [AttachSide, AttachSide] = dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  const pairs: Array<[AttachSide, AttachSide]> = Math.abs(dx) >= Math.abs(dy)
    ? [horizontal, vertical]
    : [vertical, horizontal];
  // The remaining combinations, so a blocked pair is not the end of the search.
  const others: Array<[AttachSide, AttachSide]> = [
    ['right', 'left'], ['left', 'right'], ['bottom', 'top'], ['top', 'bottom'],
    ['right', 'top'], ['right', 'bottom'], ['left', 'top'], ['left', 'bottom'],
  ];
  const seen = new Set(pairs.map(p => p.join()));
  for (const pair of others) {
    if (!seen.has(pair.join())) { pairs.push(pair); seen.add(pair.join()); }
  }
  return pairs;
}

/**
 * A self-dependency, routed and VERIFIED like any other edge.
 *
 * It used to be one fixed cubic returned before any check ran, so it could
 * leave the plane and cross its neighbours while reporting clean (round 4,
 * B2). Real boards carry accidental self-dependencies, so this is a supported
 * input, not an invented edge case. The loop is orthogonal for the same reason
 * the corridor router is: every segment is exactly checkable.
 */
function selfRoute(
  box: Box,
  blocking: readonly Box[],
  envelope: Box | null,
): EdgeRoute {
  const others = blocking.filter(other => other !== box);
  const obstacles = [...others, shrunk(box)];
  const clearRun = (points: Array<[number, number]>) => {
    for (let i = 0; i < points.length - 1; i += 1) {
      const [ax, ay] = points[i];
      const [bx, by] = points[i + 1];
      if (envelope && !withinEnvelope({
        x: Math.min(ax, bx), y: Math.min(ay, by),
        w: Math.abs(bx - ax), h: Math.abs(by - ay),
      }, envelope)) return false;
      if (obstacles.some(o => segmentIntersectsBox(ax, ay, bx, by, o))) return false;
    }
    return true;
  };

  let last = '';
  for (const lift of [28, 44, 68, 100, 148]) {
    for (const direction of [-1, 1]) {
      const y = direction < 0 ? box.y - lift : box.y + box.h + lift;
      const points: Array<[number, number]> = [
        [box.x + box.w, box.y + box.h / 2],
        [box.x + box.w + lift, box.y + box.h / 2],
        [box.x + box.w + lift, y],
        [box.x - lift, y],
        [box.x - lift, box.y + box.h / 2],
        [box.x, box.y + box.h / 2],
      ];
      last = 'M ' + points.map(([x, py]) => `${x} ${py}`).join(' L ');
      if (clearRun(points)) return { d: last, clipped: false };
    }
  }
  return { d: last, clipped: true };
}

export interface EdgeRoute {
  /** SVG path data for the curve. */
  d: string;
  /** True when every offset in the ladder still left the curve crossing a
   *  node — surfaced rather than swallowed so a dev build can count them. */
  clipped: boolean;
}

/**
 * Route one edge from a source box's right edge to a target box's left edge,
 * curving around `obstacles`. Boxes belonging to the two endpoints are ignored
 * automatically: a curve necessarily touches the nodes it connects.
 */
export function routeEdge(
  source: Box,
  target: Box,
  obstacles: readonly Box[] = [],
  envelope: Box | null = null,
): EdgeRoute {
  const others = obstacles.filter(box => box !== source && box !== target);
  // The endpoints are obstacles too, minus a hair so the attachment itself is
  // allowed. Removing them outright is what let a reverse edge run straight
  // through both nodes it connects (round 4, B1).
  const blocking = [...others, shrunk(source), shrunk(target)];

  if (source === target || (source.x === target.x && source.y === target.y
    && source.w === target.w && source.h === target.h)) {
    return selfRoute(source, obstacles, envelope);
  }

  let last = '';
  for (const [fromSide, toSide] of sidePairs(source, target)) {
    const [x1, y1] = attachPoint(source, fromSide);
    const [x2, y2] = attachPoint(target, toSide);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length < 1e-6) {
      last = `M ${x1} ${y1} L ${x2} ${y2}`;
      continue;
    }
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const normalX = -dy / length;
    const normalY = dx / length;

    for (const fraction of ROUTE_OFFSETS) {
      const offset = fraction * length;
      const cx = midX + normalX * offset;
      const cy = midY + normalY * offset;
      if (!withinEnvelope(quadraticBounds(x1, y1, cx, cy, x2, y2), envelope)) continue;
      if (!blocking.some(box => quadraticIntersectsBox(x1, y1, cx, cy, x2, y2, box))) {
        return { d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`, clipped: false };
      }
    }

    const corridor = corridorRoute(x1, y1, x2, y2, blocking, envelope);
    if (corridor.clear) return { d: corridor.d, clipped: false };
    last = corridor.d;
  }
  return { d: last, clipped: true };
}


/**
 * Rectilinear visibility grid through local obstacle gaps. The older corridor
 * ladder only used gaps clear across the whole map, so staggered rows could
 * conceal every candidate even when an ordinary elbow route existed.
 */
function localGapRoute(x1:number,y1:number,x2:number,y2:number,blocking:readonly Box[],envelope:Box|null): number[][] | null {
  const bounds=envelope??{x:Math.min(x1,x2,...blocking.map(b=>b.x))-32,
    y:Math.min(y1,y2,...blocking.map(b=>b.y))-32,
    w:Math.max(x1,x2,...blocking.map(b=>b.x+b.w))-Math.min(x1,x2,...blocking.map(b=>b.x))+64,
    h:Math.max(y1,y2,...blocking.map(b=>b.y+b.h))-Math.min(y1,y2,...blocking.map(b=>b.y))+64};
  const xs=[...new Set([x1,x2,bounds.x,bounds.x+bounds.w,...blocking.flatMap(b=>[b.x-2,b.x+b.w+2])])]
    .filter(x=>x>=bounds.x&&x<=bounds.x+bounds.w).sort((a,b)=>a-b);
  const ys=[...new Set([y1,y2,bounds.y,bounds.y+bounds.h,...blocking.flatMap(b=>[b.y-2,b.y+b.h+2])])]
    .filter(y=>y>=bounds.y&&y<=bounds.y+bounds.h).sort((a,b)=>a-b);
  if(xs.length*ys.length>250000)return null;
  const width=xs.length,start=ys.indexOf(y1)*width+xs.indexOf(x1),goal=ys.indexOf(y2)*width+xs.indexOf(x2);
  if(!xs.includes(x1)||!xs.includes(x2)||!ys.includes(y1)||!ys.includes(y2))return null;
  const costs=new Map<number,number>([[start,0]]),parents=new Map<number,number>();
  const heap:Array<{id:number;score:number;cost:number}>=[];
  const push=(item:{id:number;score:number;cost:number})=>{
    heap.push(item);let i=heap.length-1;
    while(i>0){const parent=(i-1)>>1;if(heap[parent].score<=item.score)break;heap[i]=heap[parent];i=parent;}heap[i]=item;
  };
  const pop=()=>{
    const first=heap[0],last=heap.pop()!;
    if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].score<heap[child].score)child++;
      if(heap[child].score>=last.score)break;heap[i]=heap[child];i=child;}heap[i]=last;}return first;
  };
  push({id:start,score:Math.abs(x1-x2)+Math.abs(y1-y2),cost:0});
  while(heap.length){
    const current=pop();if(current.cost!==costs.get(current.id))continue;
    if(current.id===goal){
      const points:number[][]=[];let id=goal;
      while(true){points.push([xs[id%width],ys[Math.floor(id/width)]]);if(id===start)break;id=parents.get(id)!;}
      points.reverse();
      return points.filter((p,i)=>!i||i===points.length-1
        || (p[0]-points[i-1][0])*(points[i+1][1]-p[1])!==(p[1]-points[i-1][1])*(points[i+1][0]-p[0]));
    }
    const ix=current.id%width,iy=Math.floor(current.id/width),x=xs[ix],y=ys[iy];
    for(const [nx,ny] of [[ix-1,iy],[ix+1,iy],[ix,iy-1],[ix,iy+1]]){
      if(nx<0||ny<0||nx>=width||ny>=ys.length)continue;
      const tx=xs[nx],ty=ys[ny],id=ny*width+nx;
      const cost=current.cost+Math.abs(tx-x)+Math.abs(ty-y);
      if(cost>=(costs.get(id)??Infinity)||blocking.some(b=>segmentIntersectsBox(x,y,tx,ty,b)))continue;
      costs.set(id,cost);parents.set(id,current.id);
      push({id,cost,score:cost+Math.abs(tx-x2)+Math.abs(ty-y2)});
    }
  }
  return null;
}

/** Directional ports for the continuous plane. The short perpendicular stubs
 * are fixed, and the corridor between them is checked against every obstacle.
 * Transposing the routing space gives Vertical the same guarantees as Horizontal. */
export function routeFlowEdge(
  source: Box, target: Box, obstacles: readonly Box[], envelope: Box | null,
  organization: MapOrganization, report = false,
): EdgeRoute {
  if (source === target) return routeEdge(source, target, obstacles, envelope);
  const dx = target.x + target.w / 2 - source.x - source.w / 2;
  const dy = target.y + target.h / 2 - source.y - source.h / 2;
  const vertical = report ? organization !== 'vertical'
    : organization === 'vertical' || (organization === 'organic' && Math.abs(dy) > Math.abs(dx));
  const reverse = organization === 'organic' && !report && (vertical ? dy < 0 : dx < 0);
  const transform = (b: Box): Box => vertical
    ? { x: b.y, y: b.x, w: b.h, h: b.w } : b;
  const a = transform(source), b = transform(target);
  const blocking = [...obstacles.filter(o => o !== source && o !== target), shrunk(source), shrunk(target)].map(transform);
  const bounds = envelope && transform(envelope);
  const sign = reverse ? -1 : 1;
  const x1 = reverse ? a.x : a.x + a.w, y1 = a.y + a.h / 2;
  const x2 = reverse ? b.x + b.w : b.x, y2 = b.y + b.h / 2;
  const path = (points: Array<[number, number]>) =>
    'M ' + points.map(([x,y]) => vertical ? `${y} ${x}` : `${x} ${y}`).join(' L ');
  const clear = (points: Array<[number, number]>) => points.every(([x,y],i) => {
    if (!i) return true;
    const [px,py] = points[i-1];
    return withinEnvelope({x:Math.min(x,px),y:Math.min(y,py),w:Math.abs(x-px),h:Math.abs(y-py)},bounds)
      && !blocking.some(o => segmentIntersectsBox(px,py,x,y,o));
  });
  for (const stub of [16, 8, 4, 1]) {
    const sx=x1+sign*stub, tx=x2-sign*stub;
    const middle=(sx+tx)/2;
    const direct: Array<[number,number]>=[[x1,y1],[sx,y1],[middle,y1],[middle,y2],[tx,y2],[x2,y2]];
    if (sign*(tx-sx)>=0 && clear(direct)) return {d:path(direct),clipped:false};
    if (!clear([[x1,y1],[sx,y1]]) || !clear([[tx,y2],[x2,y2]])) continue;
    const route=corridorRoute(sx,y1,tx,y2,blocking,bounds);
    if (!route.clear) {
      const local=localGapRoute(sx,y1,tx,y2,blocking,bounds);
      if(local)return {d:path([[x1,y1],...local.map(p=>[p[0],p[1]] as [number,number]),[x2,y2]]),clipped:false};
    }
    if (route.clear) {
      const numbers=route.d.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
      const points: Array<[number,number]>=[[x1,y1]];
      for(let i=0;i<numbers.length;i+=2) points.push([numbers[i],numbers[i+1]]);
      points.push([x2,y2]);
      return {d:path(points),clipped:false};
    }
  }
  return {d:path([[x1,y1],[x1+sign*16,y1],[x2-sign*16,y2],[x2,y2]]),clipped:true};
}

/* ======================================================================
 * REPORTS AT THE AGGREGATE ALTITUDES — amendment §2/§5-A2, as split by
 * amendment §2/§5-A2.1 (owner ruling 2026-08-19).
 *
 * A2.1 divides the two behaviours by altitude, and this file implements only
 * the aggregate half:
 *
 *   TASK altitude    one pill per (report, task) PAIR, beside its Task, short
 *                    local dashed edge. That is `reportsByTask` above, it is
 *                    the 1e0653e7 walkthrough decision, and it is NOT changed.
 *   PHASE / PROJECT  a Report cited by several in-scope aggregates draws ONCE,
 *                    with a converging dashed edge to each aggregate citing
 *                    it, and stays openable from the Map.
 *
 * "Converging lines are the point" (A2), so the node is placed at the
 * CENTROID of the aggregates that cite it: the lines then meet where the
 * reader is already looking, and each one is as short as that citation set
 * allows. A centroid can easily land on top of an aggregate, so placement is
 * resolved outward until the box is clear — §3 already requires Report pills
 * to be collision-resolved, and `findOverlaps` checks this kind like any
 * other.
 * ====================================================================== */

export interface PlacedAggregateReport extends Box {
  kind: 'aggregate-report';
  id: string;
  reportId: string;
  title: string;
  /** Every in-scope aggregate citing it — one converging dashed edge each. */
  aggregateIds: readonly string[];
}

export const FALLBACK_AGGREGATE_REPORT = { w: 160, h: 36 } as const;  // §7 compact control height

/** Placement search: a deterministic spiral outward from the centroid. */
const RESOLVE_ATTEMPTS = 60;
/** How far the overflow lane may advance before it gives up looking. It is a
 *  backstop only: the lane is one column, so a clear slot always exists below
 *  the lowest occupied box, and the loop reaches it monotonically. */
const OVERFLOW_ATTEMPTS = 4096;
const RESOLVE_STEP = 26;
/** Golden angle — successive attempts land far apart instead of in a line. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Which aggregates cite each in-scope Report, keyed by report id. Built from
 * the SAME (report, task) rows the task altitude uses — the wire shape is one
 * row per pair (backend `queryLinkedReports`, an unlimited server-side
 * SELECT DISTINCT over both ratified linkage arms), so a Report citing several
 * Tasks in one Phase collapses to that Phase exactly once.
 */
export function reportsByAggregate(
  graph: MapGraph,
  altitude: MapAltitude,
): Map<string, { title: string; aggregateIds: string[] }> {
  const aggregateOfTask = new Map<string, string>();
  for (const node of graph.nodes) aggregateOfTask.set(node.id, aggregateKeyOf(node, altitude));

  const byReport = new Map<string, { title: string; aggregateIds: string[] }>();
  for (const report of graph.reports ?? []) {
    const aggregate = aggregateOfTask.get(report.taskId);
    // A citation of a Task outside the fetched scope has nothing to converge
    // on at this altitude; it is not drawn, exactly as it is not drawn below.
    if (aggregate === undefined) continue;
    const entry = byReport.get(report.id);
    if (entry) {
      if (!entry.aggregateIds.includes(aggregate)) entry.aggregateIds.push(aggregate);
    } else {
      byReport.set(report.id, { title: report.title, aggregateIds: [aggregate] });
    }
  }
  for (const entry of byReport.values()) entry.aggregateIds.sort();
  return byReport;
}

/**
 * Place one node per in-scope Report at an aggregate altitude.
 *
 * `occupied` is seeded with the aggregate boxes and grows as reports are
 * placed, so reports resolve against each other as well as against the
 * clusters — two reports citing the same single Phase would otherwise stack
 * exactly on top of one another.
 */
export function placeAggregateReports(
  graph: MapGraph,
  altitude: MapAltitude,
  aggregates: readonly PlacedAggregate[],
  sizes: SizeMap,
): PlacedAggregateReport[] {
  if (altitude === 'task') return [];
  const boxById = new Map(aggregates.map(a => [a.id, a]));
  const cited = reportsByAggregate(graph, altitude);

  const occupied: Box[] = aggregates.map(a => ({ x: a.x, y: a.y, w: a.w, h: a.h }));
  const placed: PlacedAggregateReport[] = [];

  // The overflow lane starts clear of the grid's right edge, so a box placed
  // there cannot intersect a cluster whatever the spiral did.
  const overflowX = (aggregates.length
    ? Math.max(...aggregates.map(a => a.x + a.w))
    : AGGREGATE_METRICS.originX) + AGGREGATE_METRICS.gapX;
  let overflowY = AGGREGATE_METRICS.originY;

  // Deterministic order: identical input places identically, which is what
  // keeps the picture stable across a re-measure.
  for (const reportId of [...cited.keys()].sort()) {
    const entry = cited.get(reportId)!;
    const boxes = entry.aggregateIds
      .map(id => boxById.get(id))
      .filter((box): box is PlacedAggregate => box !== undefined);
    if (boxes.length === 0) continue;

    const centreX = boxes.reduce((sum, b) => sum + b.x + b.w / 2, 0) / boxes.length;
    const centreY = boxes.reduce((sum, b) => sum + b.y + b.h / 2, 0) / boxes.length;
    const size = sizeOf(`agg-report:${reportId}`, sizes, FALLBACK_AGGREGATE_REPORT);

    const origin = { x: centreX - size.w / 2, y: centreY - size.h / 2, w: size.w, h: size.h };
    const clear = (candidate: Box) => !occupied.some(other => intersects(candidate, other));

    // EVERY candidate is checked before it is accepted, including the last.
    // An earlier cut tested at the TOP of the loop and then computed one more
    // position, so the final attempt was adopted unvalidated — the overlap
    // checker caught it placing a Report on two clusters it does not even
    // cite. The loop now only ever exits with a box it has verified, or with
    // none at all.
    let box: Box | null = clear(origin) ? origin : null;
    for (let attempt = 1; box === null && attempt <= RESOLVE_ATTEMPTS; attempt += 1) {
      const radius = RESOLVE_STEP * Math.sqrt(attempt);
      const angle = attempt * GOLDEN_ANGLE;
      const candidate: Box = {
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y + Math.sin(angle) * radius,
        w: size.w,
        h: size.h,
      };
      if (clear(candidate)) box = candidate;
    }

    if (box === null) {
      // A dense grid can genuinely have no gap near the centroid. Rather than
      // overlap a cluster, the Report goes to an OVERFLOW LANE clear of the
      // grid, stacked downward. Its converging edges get longer, which is
      // honest: the alternative is a node painted over a Phase that does not
      // cite it, which misreads as a citation that is not there.
      //
      // The lane is clear of the GRID, but not automatically of Reports the
      // spiral already scattered — the adversarial pre-review reproduced two
      // overflow Reports overlapping each other on a 120-Report phase. So the
      // lane advances until the box is actually clear, and the placement is
      // verified like every other rather than assumed by construction.
      let candidate: Box = { x: overflowX, y: overflowY, w: size.w, h: size.h };
      let guard = 0;
      while (!clear(candidate) && guard < OVERFLOW_ATTEMPTS) {
        overflowY += size.h + AGGREGATE_METRICS.gapY;
        candidate = { x: overflowX, y: overflowY, w: size.w, h: size.h };
        guard += 1;
      }
      overflowY += size.h + AGGREGATE_METRICS.gapY;
      box = candidate;
    }

    occupied.push(box);
    placed.push({
      kind: 'aggregate-report',
      id: `agg-report:${reportId}`,
      reportId,
      title: entry.title,
      aggregateIds: entry.aggregateIds,
      ...box,
    });
  }
  return placed;
}

/**
 * The aggregate altitude's full layout: the grid, plus the Report nodes that
 * converge on it. The layout box grows to contain any report the spiral
 * pushed past the grid's edge — a node outside the plane's declared extent is
 * unreachable by pan, which is the same "in the DOM and invisible" class of
 * defect live QA caught on the pills at A7a.
 */
export function layoutAggregateAltitude(
  graph: MapGraph,
  sizes: SizeMap,
  altitude: MapAltitude,
  aspect: number,
): LayoutResult {
  const grid = layoutAggregateGrid(buildAggregates(graph, altitude), sizes, aspect);
  const aggregates = grid.elements.filter((e): e is PlacedAggregate => e.kind === 'aggregate');
  const reports = placeAggregateReports(graph, altitude, aggregates, sizes);
  if (reports.length === 0) return grid;

  const minX = Math.min(0, ...reports.map(r => r.x));
  const minY = Math.min(0, ...reports.map(r => r.y));
  // A negative coordinate would sit off the plane's origin, so shift
  // everything back into positive space rather than clipping it away.
  const shiftX = minX < AGGREGATE_METRICS.originX ? AGGREGATE_METRICS.originX - minX : 0;
  const shiftY = minY < AGGREGATE_METRICS.originY ? AGGREGATE_METRICS.originY - minY : 0;
  const shift = <T extends Box>(box: T): T => (
    shiftX || shiftY ? { ...box, x: box.x + shiftX, y: box.y + shiftY } : box
  );

  const elements = [...grid.elements.map(shift), ...reports.map(shift)];
  return {
    elements,
    width: Math.max(
      grid.width + shiftX,
      ...elements.map(e => e.x + e.w + AGGREGATE_METRICS.originX),
    ),
    height: Math.max(
      grid.height + shiftY,
      ...elements.map(e => e.y + e.h + AGGREGATE_METRICS.originY),
    ),
  };
}

/* ======================================================================
 * WHERE THE READER LANDS AFTER AN ALTITUDE CHANGE.
 *
 * The obvious remap — carry the NORMALISED position of the viewport centre
 * from one plane to the other — is wrong, and live QA at 5,200 tasks proved
 * it wrong: descending from the phase altitude put the reader at offsetY
 * -696,634 on a 1,495,990px-tall task plane, holding five tiles that had
 * nothing to do with the Phase they had been looking at. The same FRACTION of
 * a compact grid and of a lane-and-band stack are simply not the same place.
 *
 * What the amendment actually asks for is structural: "Zooming out past the
 * task altitude collapses Tasks into their Phase node; zooming in splits each
 * back into its children." So the landing is found through MEMBERSHIP, not
 * geometry — the reader was looking at some node, that node stands for a set
 * of Tasks, and the new altitude draws that same set somewhere. Land there.
 * ====================================================================== */

/** The Tasks a placed element stands for. A tile stands for itself. */
function taskIdsOf(element: PlacedElement): readonly string[] | null {
  if (element.kind === 'tile') return [element.id];
  if (element.kind === 'aggregate') return element.node.taskIds;
  return null;
}

/** Squared distance from a point to a box (0 when inside). */
const distanceTo = (box: Box, x: number, y: number) => {
  const dx = Math.max(box.x - x, 0, x - (box.x + box.w));
  const dy = Math.max(box.y - y, 0, y - (box.y + box.h));
  return dx * dx + dy * dy;
};

/**
 * The element the reader is looking at: the one under `planePoint`, or failing
 * that the nearest one. Nearest rather than none, because a reader whose
 * cursor happens to sit in a gap between clusters is still looking at the
 * cluster beside it.
 */
export function focusedElement(
  layout: LayoutResult,
  altitude: MapAltitude,
  planePoint: { x: number; y: number },
): PlacedElement | null {
  const kind = altitude === 'task' ? 'tile' : 'aggregate';
  let best: PlacedElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const element of layout.elements) {
    if (element.kind !== kind) continue;
    const distance = distanceTo(element, planePoint.x, planePoint.y);
    if (distance < bestDistance) { bestDistance = distance; best = element; }
  }
  return best;
}

/**
 * The box, in the TARGET altitude's coordinates, holding the same Tasks the
 * reader was looking at in the source altitude. Null when nothing corresponds
 * — an empty scope, or a focus that stands for no Task.
 */
export function focusBoxAcross(
  fromLayout: LayoutResult,
  fromAltitude: MapAltitude,
  toLayout: LayoutResult,
  toAltitude: MapAltitude,
  planePoint: { x: number; y: number },
): Box | null {
  const focused = focusedElement(fromLayout, fromAltitude, planePoint);
  if (!focused) return null;
  const wanted = taskIdsOf(focused);
  if (!wanted || wanted.length === 0) return null;
  const wantedSet = new Set(wanted);

  const targetKind = toAltitude === 'task' ? 'tile' : 'aggregate';
  const matches: PlacedElement[] = [];
  for (const element of toLayout.elements) {
    if (element.kind !== targetKind) continue;
    const ids = taskIdsOf(element);
    if (!ids) continue;
    // Descending, one aggregate becomes many children; ascending, many tiles
    // become one parent. Intersection covers both directions with one test.
    if (ids.some(id => wantedSet.has(id))) matches.push(element);
  }
  if (matches.length === 0) return null;

  // THE UNION RECTANGLE IS NOT A PLACE. Round 1 reproduced why: on a grid the
  // matching children wrap across rows, so the union spans other Projects
  // entirely, and its geometric centre lands on an aggregate that shares no
  // membership at all — the reader zooms in and is shown someone else's work.
  //
  // The landing must be a box a MATCHING child actually owns. The first match
  // in layout order is that child: ordering is deterministic (buildAggregates
  // and layoutHorizontal both sort), so the same view always lands in the same
  // place, and it is the reading-order first of the set the reader asked for.
  const owner = matches.reduce((best, candidate) =>
    (candidate.y < best.y || (candidate.y === best.y && candidate.x < best.x))
      ? candidate : best);
  return { x: owner.x, y: owner.y, w: owner.w, h: owner.h };
}
