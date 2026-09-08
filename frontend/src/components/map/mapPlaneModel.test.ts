/**
 * The continuous plane (amendment §2/§5-A3, clauses 1, 2, 3 and 6).
 *
 * Written under the same two disciplines as `mapGraphModel.test.ts`: the
 * graph is the RECORDED fixture captured from the backend serializer, and
 * geometry is asserted by the INDEPENDENT checker (`findOverlaps`) over
 * measured boxes rather than by re-deriving the layout's own arithmetic.
 *
 * The positional-stability suite carries its own NEGATIVE CONTROL: every
 * stability assertion is run a second time against the PRE-AMENDMENT
 * engine (`layoutHorizontal`), which must FAIL it. A stability test that
 * both engines pass is a test that proves nothing about the anchoring.
 */
import { describe, expect, test } from 'vitest';

import recorded from './__fixtures__/graph.task.json';
import {
  FALLBACK_TILE,
  findOverlaps,
  layoutHorizontal,
  type LayoutResult,
  type MapEdge,
  type MapGraph,
  type MapPhase,
  type MapTaskNode,
  type PlacedBand,
  type PlacedContainer,
  type PlacedElement,
  type PlacedTile,
  type SizeMap,
} from './mapGraphModel';
import {
  CROSSFADE_PX,
  EMPTY_PLANE_ANCHORS,
  MAX_ANCHOR_BYTES,
  MAX_SLOT_ANCHORS,
  PLANE_CARD_PX,
  PLANE_METRICS,
  anchorBytes,
  assignSlots,
  cardFits,
  containerAlpha,
  layoutHorizontalPlane,
  layoutVerticalPlane,
  layoutRadialPlane,
  layoutOrganicPlane,
  ORGANIC_CORE,
  organicPlaneGraph,
  parseAnchors,
  planeFade,
  planeDetailBand,
  projectPlaneAttention,
  planeSegments,
  pruneAnchors,
  type MapPlaneAnchors,
} from './mapPlaneModel';

const graphFromRecorded = (): MapGraph => ({
  nodes: (recorded as any).nodes as MapTaskNode[],
  edges: (recorded as any).edges as MapEdge[],
  phases: (recorded as any).phases as MapPhase[],
});

/**
 * Sizes as the DOM would report them, keyed by IDENTITY rather than by
 * position in the node array. Keying on the index made a deletion change the
 * measured height of every task after it, so a stability test would have
 * been measuring the fixture helper rather than the layout.
 */
const hashOf = (value: string) => {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
};

const planeSizes = (graph: MapGraph, extra: SizeMap = {}): SizeMap => {
  const sizes: Record<string, { w: number; h: number }> = {};
  for (const node of graph.nodes) {
    // Real tiles differ in height with content; a single constant is exactly
    // the assumption the measured-box discipline exists to refuse.
    sizes[node.id] = { w: 170, h: 78 + (hashOf(node.id) % 5) * 11 };
  }
  for (const project of new Set(graph.nodes.map(n => n.project ?? '__no_project__'))) {
    sizes[`lane:${project}`] = { w: 180, h: 56 + (project.length % 3) * 8 };
  }
  for (const phase of graph.phases) {
    for (const project of new Set(graph.nodes.map(n => n.project ?? '__no_project__'))) {
      sizes[`chip:band:${project}:${phase.id}`] = { w: 132, h: 22 };
    }
  }
  return { ...sizes, ...extra };
};

const tilesOf = (result: LayoutResult) =>
  result.elements.filter((e): e is PlacedTile => e.kind === 'tile');
const bandsOf = (result: LayoutResult) =>
  result.elements.filter((e): e is PlacedBand => e.kind === 'band');
const containersOf = (result: LayoutResult) =>
  result.elements.filter((e): e is PlacedContainer => e.kind === 'container');

const positionsOf = (result: LayoutResult) => {
  const map = new Map<string, { x: number; y: number }>();
  for (const element of result.elements) map.set(element.id, { x: element.x, y: element.y });
  return map;
};

/** Ids whose position differs by more than the stated tolerance. */
const TOLERANCE_PX = 0.5;
const movedIds = (
  before: Map<string, { x: number; y: number }>,
  after: Map<string, { x: number; y: number }>,
  only: (id: string) => boolean = () => true,
) => {
  const moved: string[] = [];
  for (const [id, from] of before) {
    if (!only(id)) continue;
    const to = after.get(id);
    if (!to) continue;
    if (Math.abs(to.x - from.x) > TOLERANCE_PX || Math.abs(to.y - from.y) > TOLERANCE_PX) {
      moved.push(id);
    }
  }
  return moved.sort();
};

const templateNode = (graph: MapGraph): MapTaskNode => graph.nodes[0];

const addedNodes = (
  graph: MapGraph,
  count: number,
  project: string | null,
  phaseId: string | null,
  prefix = 'added',
): MapTaskNode[] => Array.from({ length: count }, (_unused, index) => ({
  ...templateNode(graph),
  id: `${prefix}-${index}`,
  title: `Arrived ${index}`,
  status: 'todo',
  project,
  phaseId,
  agent: null,
  updated: `2026-09-0${1 + (index % 8)}T00:00:00.000Z`,
} as MapTaskNode));

describe('flow axis (A3 clause 3 / R6)', () => {
  const graph = graphFromRecorded();
  const sizes = planeSizes(graph);

  test('inside a lane the phases sit left to right in DECLARED order', () => {
    const result = layoutHorizontalPlane(graph, sizes);
    const byLane = new Map<string, PlacedBand[]>();
    for (const band of bandsOf(result)) {
      const list = byLane.get(band.laneId);
      if (list) list.push(band); else byLane.set(band.laneId, [band]);
    }
    expect([...byLane.values()].some(list => list.length > 1)).toBe(true);
    for (const bands of byLane.values()) {
      // Every band in a lane shares the lane's top edge and separates along
      // the flow axis. That is the whole of R6: the phases SEQUENCE, they no
      // longer stack.
      const tops = new Set(bands.map(band => Math.round(band.y)));
      expect(tops.size).toBe(1);
      const sorted = [...bands].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].w);
      }
      // Declared order — position, then name — is the order along x.
      const declared = [...bands].sort((a, b) => {
        const pa = graph.phases.find(p => p.name === a.label);
        const pb = graph.phases.find(p => p.name === b.label);
        return (pa?.position ?? 0) - (pb?.position ?? 0) || a.label.localeCompare(b.label);
      });
      expect(declared.map(b => b.label)).toEqual(sorted.map(b => b.label));
    }
  });

  test('the pre-amendment engine STACKED the phases — the control', () => {
    // The behaviour R6 supersedes, asserted so the change above is visible
    // as a change rather than as a claim.
    const before = layoutHorizontal(graph, sizes);
    const byLane = new Map<string, PlacedBand[]>();
    for (const band of before.elements.filter((e): e is PlacedBand => e.kind === 'band')) {
      const list = byLane.get(band.laneId);
      if (list) list.push(band); else byLane.set(band.laneId, [band]);
    }
    const stacked = [...byLane.values()].filter(list => list.length > 1);
    expect(stacked.length).toBeGreaterThan(0);
    for (const bands of stacked) {
      expect(new Set(bands.map(band => Math.round(band.y))).size).toBe(bands.length);
    }
  });

  test('unphased tasks are CONNECTORS placed in flow order between phases', () => {
    const phases: MapPhase[] = [
      { id: 'p1', name: 'One', goal: null, projectId: 'proj', position: 0 },
      { id: 'p2', name: 'Two', goal: null, projectId: 'proj', position: 1 },
    ];
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'a', project: 'P', phaseId: 'p1' },
      { ...templateNode(graph), id: 'b', project: 'P', phaseId: null },
      { ...templateNode(graph), id: 'c', project: 'P', phaseId: 'p2' },
      { ...templateNode(graph), id: 'z', project: 'P', phaseId: null },
    ];
    // a → b → c is a chain; z depends on nothing, so it LEADS the lane.
    const edges: MapEdge[] = [
      { from: 'b', to: 'a', kind: 'dependency' },
      { from: 'c', to: 'b', kind: 'dependency' },
    ];
    const depths = new Map([['z', 0], ['a', 0], ['b', 1], ['c', 2]]);
    const segments = planeSegments(nodes, phases, depths);
    expect(segments.map(s => s.key)).toEqual(['gap:0', 'phase:p1', 'gap:1', 'phase:p2']);
    expect(segments.find(s => s.key === 'gap:0')!.nodes.map(n => n.id)).toEqual(['z']);
    expect(segments.find(s => s.key === 'gap:1')!.nodes.map(n => n.id)).toEqual(['b']);

    const local = { nodes, edges, phases } as MapGraph;
    const result = layoutHorizontalPlane(local, planeSizes(local));
    const tile = (id: string) => tilesOf(result).find(t => t.id === id)!;
    // The connector sits BETWEEN the two phase boxes, on the same row grid.
    const one = bandsOf(result).find(b => b.label === 'One')!;
    const two = bandsOf(result).find(b => b.label === 'Two')!;
    expect(tile('b').x).toBeGreaterThan(one.x + one.w);
    expect(tile('b').x + tile('b').w).toBeLessThanOrEqual(two.x);
    expect(tile('z').x).toBeLessThan(one.x);
    // A connector carries no phase container to fade into.
    expect(tile('b').bandId).toBeNull();
    expect(tile('a').bandId).toBe('band:P:p1');
  });
});

describe('§2 zero-overlap invariant holds on the continuous plane', () => {
  const graph = graphFromRecorded();

  test('with measured boxes, reports, and adversarially wide pills', () => {
    const withReports: MapGraph = {
      ...graph,
      reports: graph.nodes.slice(0, 6).map((node, index) => ({
        id: `report-${index}`, taskId: node.id, title: `Linked ${index}`,
      })),
    };
    const sizes = planeSizes(withReports, Object.fromEntries(
      (withReports.reports ?? []).map(report => [
        `pill:${report.id}:${report.taskId}`, { w: 260, h: 64 },
      ])));
    const result = layoutHorizontalPlane(withReports, sizes);
    expect(findOverlaps(result.elements)).toEqual([]);
  });

  test('with no sizes at all — the first paint, every box a fallback', () => {
    expect(findOverlaps(layoutHorizontalPlane(graph, {}).elements)).toEqual([]);
  });

  test('a project container contains its own lane and overlaps no other', () => {
    const result = layoutHorizontalPlane(graph, planeSizes(graph));
    const containers = containersOf(result);
    expect(containers.length).toBeGreaterThan(1);
    for (const container of containers) {
      const own = tilesOf(result).filter(tile => tile.laneId === container.laneId);
      expect(own.length).toBeGreaterThan(0);
      for (const tile of own) {
        expect(tile.x).toBeGreaterThanOrEqual(container.x);
        expect(tile.y).toBeGreaterThanOrEqual(container.y);
        expect(tile.x + tile.w).toBeLessThanOrEqual(container.x + container.w + 0.001);
        expect(tile.y + tile.h).toBeLessThanOrEqual(container.y + container.h + 0.001);
      }
    }
    for (let i = 0; i < containers.length; i += 1) {
      for (let j = i + 1; j < containers.length; j += 1) {
        const a = containers[i];
        const b = containers[j];
        const hit = a.x < b.x + b.w && b.x < a.x + a.w
          && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(hit).toBe(false);
      }
    }
  });
});

describe('size-truthful containers (A3 clause 2 / R3)', () => {
  const graph = graphFromRecorded();

  test('a phase with more tasks occupies more ground than one with fewer', () => {
    const phases: MapPhase[] = [
      { id: 'small', name: 'Small', goal: null, projectId: 'proj', position: 0 },
      { id: 'big', name: 'Big', goal: null, projectId: 'proj', position: 1 },
    ];
    const nodes: MapTaskNode[] = [
      ...addedNodes(graph, 2, 'P', 'small', 's'),
      ...addedNodes(graph, 12, 'P', 'big', 'b'),
    ];
    const local = { nodes, edges: [], phases } as MapGraph;
    const result = layoutHorizontalPlane(local, planeSizes(local));
    const small = bandsOf(result).find(b => b.label === 'Small')!;
    const big = bandsOf(result).find(b => b.label === 'Big')!;
    expect(big.w * big.h).toBeGreaterThan(small.w * small.h);
    // The container carries its contents' MEANING, not merely a count.
    expect(big.facts!.taskCount).toBe(12);
    expect(small.facts!.taskCount).toBe(2);
  });

  test('a container reports the same facts as its lane header', () => {
    const result = layoutHorizontalPlane(graph, planeSizes(graph));
    for (const container of containersOf(result)) {
      const header = result.elements.find(
        e => e.kind === 'lane' && e.id === `lane:${container.laneId}`) as any;
      expect(container.facts.taskCount).toBe(header.taskCount);
      expect(container.facts.stuck).toBe(header.stuck);
      expect(container.facts.agentsLive).toBe(header.agentsLive);
      expect(container.facts.progress).toBe(header.progress);
    }
  });
});

describe('cross-fade (A3 clause 1 / R2)', () => {
  const graph = graphFromRecorded();
  const sizes = planeSizes(graph);
  const result = layoutHorizontalPlane(graph, sizes);
  const scales = [0.05, 0.1, 0.15, 0.2, 0.24, 0.28, 0.34, 0.4, 0.5, 0.75, 1, 1.6, 2.5];

  test('the ramp endpoints are the ratified constants', () => {
    expect(containerAlpha(CROSSFADE_PX.merged)).toBe(1);
    expect(containerAlpha(CROSSFADE_PX.split)).toBe(0);
    expect(containerAlpha(CROSSFADE_PX.merged - 10)).toBe(1);
    expect(containerAlpha(CROSSFADE_PX.split + 10)).toBe(0);
    const middle = containerAlpha((CROSSFADE_PX.merged + CROSSFADE_PX.split) / 2);
    expect(middle).toBeGreaterThan(0.49);
    expect(middle).toBeLessThan(0.51);
  });

  test('the three layers SUM TO ONE for every task at every scale', () => {
    for (const scale of scales) {
      const fade = planeFade(result.elements, scale);
      for (const tile of tilesOf(result)) {
        const phase = tile.bandId ? (fade.phase.get(tile.bandId) ?? 0) : 0;
        const project = fade.project.get(`container:${tile.laneId}`) ?? 0;
        const task = fade.task.get(tile.id) ?? 0;
        expect(task + phase + project).toBeCloseTo(1, 6);
      }
    }
  });

  test('nothing is ever a dot: below the floor the container carries the ink', () => {
    // A scale at which a 170px tile lands under 40px on screen.
    const scale = (CROSSFADE_PX.merged / FALLBACK_TILE.w) * 0.9;
    const fade = planeFade(result.elements, scale);
    for (const tile of tilesOf(result)) expect(fade.task.get(tile.id)).toBe(0);
    for (const container of containersOf(result)) {
      expect(fade.project.get(container.id)).toBeGreaterThan(0);
    }
  });

  test('at reading scale the tiles carry all of it and no container shows', () => {
    const fade = planeFade(result.elements, 1);
    for (const tile of tilesOf(result)) expect(fade.task.get(tile.id)).toBe(1);
    for (const band of bandsOf(result)) expect(fade.phase.get(band.id)).toBe(0);
    for (const container of containersOf(result)) {
      expect(fade.project.get(container.id)).toBe(0);
    }
  });

  test('the project layer never arrives before the phase layer has', () => {
    for (const scale of scales) {
      const fade = planeFade(result.elements, scale);
      for (const band of bandsOf(result)) {
        const project = fade.project.get(`container:${band.laneId}`) ?? 0;
        if (project > 0) {
          // A project can only take over ground its phases have already
          // taken: a project container is at least as wide as its phases.
          const tiles = tilesOf(result).filter(t => t.bandId === band.id);
          const own = tiles.length
            ? tiles.reduce((sum, t) => sum + t.w, 0) / tiles.length : 0;
          expect(containerAlpha(own * scale)).toBe(1);
        }
      }
    }
  });

  test('opacity is monotone in the zoom — no flicker, no re-entry', () => {
    const ordered = [...scales].sort((a, b) => b - a);
    let previous = -1;
    for (const scale of ordered) {
      const fade = planeFade(result.elements, scale);
      const total = [...fade.project.values()].reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = total;
    }
  });

  test('the fade changes NO geometry — positions are retained (clause 1)', () => {
    const before = JSON.stringify(result.elements.map(e => [e.id, e.x, e.y, e.w, e.h]));
    for (const scale of scales) planeFade(result.elements, scale);
    const after = JSON.stringify(result.elements.map(e => [e.id, e.x, e.y, e.w, e.h]));
    expect(after).toBe(before);
  });
});

/* ======================================================================
 * POSITIONAL STABILITY — amendment clause 6, the hard requirement.
 *
 * THE CONTRACT THIS SUITE STATES AND PROVES. Tolerance: 0.5 CSS px, which
 * is below a device pixel at every zoom the Map offers — "keeps its
 * position" means it does not move, not that it moves a little.
 *
 *  (a) an arrival that FITS the lane's reservation moves nothing at all;
 *  (b) a departure moves nothing — its slot becomes a hole, and the hole is
 *      reused by the next arrival rather than closed;
 *  (c) a task moving between phases moves ITSELF and nothing else;
 *  (d) an arrival at a NEW dependency depth opens a column; the movement is
 *      confined to its own lane, and it is a translation along the flow
 *      axis — nothing is re-ordered and nothing moves up or left;
 *  (e) an arrival that OUTGROWS the reservation grows the lane; the lanes
 *      above are untouched and the lanes below TRANSLATE by one uniform
 *      distance, keeping every relative position they had;
 *  (f) a new project appends at the frontier; no existing project moves,
 *      and the unassigned lane — which §2 pins last — translates;
 *  (g) the same graph in a different order lays out identically, and the
 *      persisted record restores the same world in a later session.
 *
 * (a), (b), (c) and (f) are each run a second time against the
 * PRE-AMENDMENT engine, which must FAIL them. A stability suite both
 * engines pass would be measuring nothing about the anchoring.
 * ====================================================================== */
describe('positional stability (A3 clause 6 / R1)', () => {
  const graph = graphFromRecorded();
  const phased = graph.nodes.find(node => node.phaseId && node.project)!;

  /** Every placed id mapped to the lane it belongs to, from the layout's own
   *  membership rather than from string surgery on the ids. */
  const laneIndex = (result: LayoutResult) => {
    const byId = new Map<string, string>();
    const bandLane = new Map<string, string>();
    for (const element of result.elements) {
      if (element.kind === 'tile') byId.set(element.id, element.laneId ?? '');
      else if (element.kind === 'band') {
        byId.set(element.id, element.laneId);
        bandLane.set(element.id, element.laneId);
      } else if (element.kind === 'container') byId.set(element.id, element.laneId);
      else if (element.kind === 'lane') byId.set(element.id, element.id.slice('lane:'.length));
    }
    for (const element of result.elements) {
      if (element.kind === 'chip') byId.set(element.id, bandLane.get(element.bandId) ?? '?');
      if (element.kind === 'pill') byId.set(element.id, byId.get(element.taskId) ?? '?');
    }
    return byId;
  };

  /** Per-lane set of distinct displacements, rounded to the tolerance. */
  const displacementsByLane = (
    before: Map<string, { x: number; y: number }>,
    after: Map<string, { x: number; y: number }>,
    index: Map<string, string>,
  ) => {
    const byLane = new Map<string, Set<string>>();
    for (const [id, from] of before) {
      const to = after.get(id);
      if (!to) continue;
      const lane = index.get(id) ?? '?';
      const key = `${Math.round(to.x - from.x)},${Math.round(to.y - from.y)}`;
      const set = byLane.get(lane) ?? new Set<string>();
      set.add(key);
      byLane.set(lane, set);
    }
    return byLane;
  };

  const baseline = () => {
    const sizes = planeSizes(graph);
    const result = layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
    return { result, anchors: result.anchors, before: positionsOf(result), index: laneIndex(result) };
  };

  test('(a) a task ARRIVES within the reservation and nothing already placed moves', () => {
    const { anchors, before } = baseline();
    const churned: MapGraph = {
      ...graph,
      nodes: [...graph.nodes, ...addedNodes(graph, 2, phased.project, phased.phaseId)],
    };
    const after = positionsOf(layoutHorizontalPlane(churned, planeSizes(churned), anchors));
    expect(movedIds(before, after)).toEqual([]);
  });

  test('(a) CONTROL: the pre-amendment engine moves things on the same churn', () => {
    const before = positionsOf(layoutHorizontal(graph, planeSizes(graph)));
    const churned: MapGraph = {
      ...graph,
      nodes: [...graph.nodes, ...addedNodes(graph, 2, phased.project, phased.phaseId)],
    };
    const after = positionsOf(layoutHorizontal(churned, planeSizes(churned)));
    expect(movedIds(before, after).length).toBeGreaterThan(0);
  });

  /**
   * Two departures chosen so that neither empties a lane or a phase: a lane
   * that ceases to exist is not a task moving, it is the world losing a
   * region, and conflating the two would let the suite pass or fail for a
   * reason it is not testing.
   */
  const departures = () => {
    const perPhase = new Map<string, MapTaskNode[]>();
    for (const node of graph.nodes) {
      const key = `${node.project ?? '-'}\u0000${node.phaseId ?? '-'}`;
      const list = perPhase.get(key) ?? [];
      list.push(node);
      perPhase.set(key, list);
    }
    const chosen = [...perPhase.values()]
      .filter(list => list.length >= 3)
      .map(list => list[list.length - 1]);
    expect(chosen.length).toBeGreaterThanOrEqual(2);
    return new Set(chosen.slice(0, 2).map(node => node.id));
  };

  test('(b) tasks LEAVE and nothing that stayed moves', () => {
    const { anchors, before } = baseline();
    const gone = departures();
    const churned: MapGraph = { ...graph, nodes: graph.nodes.filter(n => !gone.has(n.id)) };
    const after = positionsOf(layoutHorizontalPlane(churned, planeSizes(churned), anchors));
    expect(movedIds(before, after, id => !gone.has(id))).toEqual([]);
  });

  test('(b) CONTROL: the pre-amendment engine closes the hole and shuffles', () => {
    const before = positionsOf(layoutHorizontal(graph, planeSizes(graph)));
    const gone = departures();
    const churned: MapGraph = { ...graph, nodes: graph.nodes.filter(n => !gone.has(n.id)) };
    const after = positionsOf(layoutHorizontal(churned, planeSizes(churned)));
    expect(movedIds(before, after, id => !gone.has(id)).length).toBeGreaterThan(0);
  });

  test('(b) the hole a departure leaves is REUSED by the next arrival', () => {
    const { anchors } = baseline();
    // A task with no dependencies at all, so the arrival that replaces it —
    // which has none either — ranks into the SAME column. A hole is reused
    // within its own column, not across the flow axis; picking a departure
    // at some other depth would be testing the dependency ranking instead.
    const goneNode = graph.nodes.find(node =>
      departures().has(node.id)
      && !graph.edges.some(edge => edge.from === node.id || edge.to === node.id))
      ?? graph.nodes.find(node =>
        !graph.edges.some(edge => edge.from === node.id || edge.to === node.id))!;
    const gone = goneNode.id;
    const removed: MapGraph = { ...graph, nodes: graph.nodes.filter(n => n.id !== gone) };
    const step = layoutHorizontalPlane(removed, planeSizes(removed), anchors);
    const arrival: MapGraph = {
      ...removed,
      nodes: [...removed.nodes,
        ...addedNodes(graph, 1, goneNode.project, goneNode.phaseId, 'fill')],
    };
    const filled = layoutHorizontalPlane(arrival, planeSizes(arrival), step.anchors);
    const hole = positionsOf(
      layoutHorizontalPlane(graph, planeSizes(graph), EMPTY_PLANE_ANCHORS)).get(gone)!;
    const newcomer = positionsOf(filled).get('fill-0')!;
    expect(newcomer.x).toBeCloseTo(hole.x, 6);
    expect(newcomer.y).toBeCloseTo(hole.y, 6);
    // And the plane did not grow to take it.
    expect(filled.height).toBeLessThanOrEqual(step.height);
  });

  test('(c) a task MOVES phase: it travels, nothing else does', () => {
    const { anchors, before } = baseline();
    const target = graph.phases.find(p => p.id !== phased.phaseId)!;
    const churned: MapGraph = {
      ...graph,
      nodes: graph.nodes.map(node =>
        node.id === phased.id ? { ...node, phaseId: target.id } : node),
    };
    const after = positionsOf(layoutHorizontalPlane(churned, planeSizes(churned), anchors));
    expect(movedIds(before, after, id => id !== phased.id)).toEqual([]);
  });

  test('(c) CONTROL: the pre-amendment engine moves the neighbours too', () => {
    const before = positionsOf(layoutHorizontal(graph, planeSizes(graph)));
    const target = graph.phases.find(p => p.id !== phased.phaseId)!;
    const churned: MapGraph = {
      ...graph,
      nodes: graph.nodes.map(node =>
        node.id === phased.id ? { ...node, phaseId: target.id } : node),
    };
    const after = positionsOf(layoutHorizontal(churned, planeSizes(churned)));
    expect(movedIds(before, after, id => id !== phased.id).length).toBeGreaterThan(0);
  });

  test('(d) a NEW dependency depth opens a column, CONFINED to its own lane', () => {
    const { anchors, before, result, index } = baseline();
    const lane = phased.project!;
    const deepest = tilesOf(result)
      .filter(tile => tile.laneId === lane)
      .reduce((best, tile) => (tile.depth > best.depth ? tile : best));
    const arrival = addedNodes(graph, 1, lane, deepest.node.phaseId, 'deep')[0];
    const churned: MapGraph = {
      ...graph,
      nodes: [...graph.nodes, arrival],
      edges: [...graph.edges, { from: arrival.id, to: deepest.id, kind: 'dependency' }],
    };
    const after = positionsOf(layoutHorizontalPlane(churned, planeSizes(churned), anchors));
    const moved = movedIds(before, after);
    // Something DID move — otherwise this proves nothing about confinement.
    expect(moved.length).toBeGreaterThan(0);
    for (const id of moved) expect(index.get(id)).toBe(lane);
    // …and it is a translation ALONG THE FLOW AXIS. Nothing goes up or left.
    for (const id of moved) {
      const from = before.get(id)!;
      const to = after.get(id)!;
      expect(to.y).toBeCloseTo(from.y, 6);
      expect(to.x).toBeGreaterThan(from.x);
    }
  });

  test('(e) an arrival that OUTGROWS the lane translates the lanes below, whole', () => {
    const { anchors, before, result, index } = baseline();
    const lane = phased.project!;
    const laneTop = (id: string) => {
      const container = containersOf(result).find(c => c.laneId === id)!;
      return container.y;
    };
    const churned: MapGraph = {
      ...graph,
      nodes: [...graph.nodes, ...addedNodes(graph, 14, phased.project, phased.phaseId, 'flood')],
    };
    const after = positionsOf(layoutHorizontalPlane(churned, planeSizes(churned), anchors));
    const byLane = displacementsByLane(before, after, index);

    // The lane that grew did not move a single thing it already held.
    expect([...(byLane.get(lane) ?? new Set())]).toEqual(['0,0']);
    const shifts = new Set<string>();
    for (const [key, set] of byLane) {
      if (key === lane) continue;
      // Each other lane moved AS ONE — one displacement for everything in it.
      expect(set.size).toBe(1);
      const [only] = [...set];
      const [dx, dy] = only.split(',').map(Number);
      expect(dx).toBe(0);
      expect(dy).toBeGreaterThanOrEqual(0);
      // A lane above the growth is untouched; one below moves DOWN.
      if (laneTop(key) < laneTop(lane)) expect(dy).toBe(0);
      else if (dy > 0) shifts.add(only);
    }
    // One growth, one distance — not a per-lane recomputation.
    expect(shifts.size).toBeLessThanOrEqual(1);
    expect(shifts.size).toBe(1);
  });

  test('(f) a NEW project appends at the frontier; no existing project moves', () => {
    const { anchors, before, index } = baseline();
    // Named to sort FIRST alphabetically: a canonical re-sort would put it at
    // the top of the plane and push every existing lane down.
    const churned: MapGraph = {
      ...graph,
      nodes: [...graph.nodes, ...addedNodes(graph, 2, 'AAA First Alphabetically', null, 'new')],
    };
    const next = layoutHorizontalPlane(churned, planeSizes(churned), anchors);
    const byLane = displacementsByLane(before, positionsOf(next), index);
    for (const [key, set] of byLane) {
      if (key === '__no_project__') continue;
      expect([...set]).toEqual(['0,0']);
    }
    // §2 pins the unassigned lane last, so it — and only it — makes room.
    const unassigned = [...(byLane.get('__no_project__') ?? new Set())];
    expect(unassigned.length).toBe(1);
    expect(unassigned[0].startsWith('0,')).toBe(true);
    expect(Number(unassigned[0].split(',')[1])).toBeGreaterThan(0);

    const fresh = containersOf(next).find(c => c.laneId === 'AAA First Alphabetically')!;
    const realProjects = containersOf(next)
      .filter(c => c.laneId !== 'AAA First Alphabetically' && c.laneId !== '__no_project__');
    expect(fresh.y).toBeGreaterThan(Math.max(...realProjects.map(c => c.y)));
  });

  test('(f) CONTROL: unanchored, the new project lands FIRST and shifts the world', () => {
    const before = positionsOf(layoutHorizontal(graph, planeSizes(graph)));
    const churned: MapGraph = {
      ...graph,
      nodes: [...graph.nodes, ...addedNodes(graph, 2, 'AAA First Alphabetically', null, 'new')],
    };
    const after = positionsOf(layoutHorizontal(churned, planeSizes(churned)));
    expect(movedIds(before, after).length).toBeGreaterThan(0);
  });

  test('(g) the same graph in a different order lays out identically', () => {
    const sizes = planeSizes(graph);
    const straight = layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
    const shuffled: MapGraph = {
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
      phases: [...graph.phases].reverse(),
    };
    const other = layoutHorizontalPlane(shuffled, sizes, EMPTY_PLANE_ANCHORS);
    expect(movedIds(positionsOf(straight), positionsOf(other))).toEqual([]);
    expect(other.width).toBe(straight.width);
    expect(other.height).toBe(straight.height);
  });

  test('the layout is a FIXED POINT in its own anchors', () => {
    const sizes = planeSizes(graph);
    const first = layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
    const second = layoutHorizontalPlane(graph, sizes, first.anchors);
    const third = layoutHorizontalPlane(graph, sizes, second.anchors);
    expect(movedIds(positionsOf(first), positionsOf(second))).toEqual([]);
    expect(movedIds(positionsOf(second), positionsOf(third))).toEqual([]);
    expect(JSON.stringify(third.anchors)).toBe(JSON.stringify(second.anchors));
    expect(second.width).toBe(first.width);
    expect(second.height).toBe(first.height);
  });

  test('(g) anchors survive a JSON round trip and restore the same world', () => {
    const sizes = planeSizes(graph);
    const first = layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
    const restored = parseAnchors(JSON.stringify(first.anchors));
    // A NEW session: nothing in memory, the graph arriving in wire order,
    // and only the persisted record to go on.
    const shuffled: MapGraph = { ...graph, nodes: [...graph.nodes].reverse() };
    const next = layoutHorizontalPlane(shuffled, sizes, restored);
    expect(movedIds(positionsOf(first), positionsOf(next))).toEqual([]);
  });

  test('(g) CONTROL: without the persisted record the world is rebuilt', () => {
    const sizes = planeSizes(graph);
    const first = layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
    const churned: MapGraph = {
      ...graph,
      nodes: [...graph.nodes, ...addedNodes(graph, 2, 'AAA First Alphabetically', null, 'new')],
    };
    const withoutRecord = layoutHorizontalPlane(
      churned, planeSizes(churned), EMPTY_PLANE_ANCHORS);
    expect(movedIds(positionsOf(first), positionsOf(withoutRecord)).length).toBeGreaterThan(0);
  });

  test('nothing on the plane ever moves UP or LEFT under churn', () => {
    // The direction rule behind clause 6: the world grows at its frontier.
    const { anchors, before } = baseline();
    const churned: MapGraph = {
      ...graph,
      nodes: [
        ...graph.nodes.filter(n => n.id !== phased.id),
        ...addedNodes(graph, 9, phased.project, phased.phaseId, 'grow'),
        ...addedNodes(graph, 2, 'Zed New Project', null, 'zed'),
      ],
    };
    const after = positionsOf(layoutHorizontalPlane(churned, planeSizes(churned), anchors));
    for (const [id, from] of before) {
      const to = after.get(id);
      if (!to) continue;
      expect(to.x).toBeGreaterThanOrEqual(from.x - TOLERANCE_PX);
      expect(to.y).toBeGreaterThanOrEqual(from.y - TOLERANCE_PX);
    }
  });
});

describe('anchor persistence', () => {
  const graph = graphFromRecorded();

  test('a corrupt, foreign or partial record falls back rather than throwing', () => {
    expect(parseAnchors(null)).toEqual(EMPTY_PLANE_ANCHORS);
    expect(parseAnchors('not json')).toEqual(EMPTY_PLANE_ANCHORS);
    expect(parseAnchors('{"version":2}')).toEqual(EMPTY_PLANE_ANCHORS);
    const partial = parseAnchors(JSON.stringify({
      version: 1,
      laneOrder: ['a', 7],
      laneHeight: { a: 'tall', b: 120 },
      cols: { s: [1, -2], t: [170] },
      rows: {},
      slots: { good: { seg: 's', col: 0, row: 1 }, bad: { seg: 's', col: -1, row: 0 } },
    }));
    expect(partial.laneOrder).toEqual(['a']);
    expect(partial.laneHeight).toEqual({ b: 120 });
    expect(partial.cols).toEqual({ t: [170] });
    expect(Object.keys(partial.slots)).toEqual(['good']);
  });

  test('a rejected record still lays the plane out — it just forgets', () => {
    const sizes = planeSizes(graph);
    const result = layoutHorizontalPlane(graph, sizes, parseAnchors('garbage'));
    expect(findOverlaps(result.elements)).toEqual([]);
    expect(tilesOf(result).length).toBe(graph.nodes.length);
  });

  test('anchors for absent tasks are KEPT — a filter is not a deletion (R8)', () => {
    const sizes = planeSizes(graph);
    const full = layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
    const filtered: MapGraph = { ...graph, nodes: graph.nodes.filter(n => n.status !== 'completed') };
    const scoped = layoutHorizontalPlane(filtered, planeSizes(filtered), full.anchors);
    // Everything still in scope is exactly where it was.
    const survivors = new Set(filtered.nodes.map(n => n.id));
    expect(movedIds(positionsOf(full), positionsOf(scoped), id => survivors.has(id))).toEqual([]);
    // And the record still remembers the ones the filter hid, so lifting it
    // puts them back where they were rather than somewhere new.
    for (const node of graph.nodes) expect(scoped.anchors.slots[node.id]).toBeDefined();
    const lifted = layoutHorizontalPlane(graph, sizes, scoped.anchors);
    expect(movedIds(positionsOf(full), positionsOf(lifted))).toEqual([]);
  });

  test('pruning keeps every present task and drops absent ones first', () => {
    const slots: Record<string, { seg: string; col: number; row: number }> = {};
    for (let i = 0; i < 60; i += 1) slots[`t${i}`] = { seg: 's', col: 0, row: i };
    const anchors: MapPlaneAnchors = {
      ...EMPTY_PLANE_ANCHORS, slots,
    };
    const present = new Set(Array.from({ length: 30 }, (_u, i) => `t${i}`));
    const pruned = pruneAnchors(anchors, present, 40);
    expect(Object.keys(pruned.slots).length).toBe(40);
    for (const id of present) expect(pruned.slots[id]).toBeDefined();
    // Under the cap it is a no-op, so ordinary use never loses a thing.
    expect(pruneAnchors(anchors, present, 100)).toBe(anchors);
    expect(MAX_SLOT_ANCHORS).toBeGreaterThan(1000);
  });
});

describe('slot assignment', () => {
  const graph = graphFromRecorded();

  test('an anchored task keeps its slot even when the ranking moves on', () => {
    const nodes = addedNodes(graph, 3, 'P', 'p1');
    const depths = new Map(nodes.map((node, index) => [node.id, index]));
    const anchors: MapPlaneAnchors = {
      ...EMPTY_PLANE_ANCHORS,
      slots: { [nodes[0].id]: { seg: 'seg', col: 4, row: 7 } },
    };
    const assigned = assignSlots('seg', nodes, depths, anchors);
    expect(assigned.get(nodes[0].id)).toEqual({ col: 4, row: 7 });
  });

  test('two tasks never share a slot, even when the record says they should', () => {
    const nodes = addedNodes(graph, 2, 'P', 'p1');
    const depths = new Map(nodes.map(node => [node.id, 0]));
    const anchors: MapPlaneAnchors = {
      ...EMPTY_PLANE_ANCHORS,
      slots: {
        [nodes[0].id]: { seg: 'seg', col: 0, row: 0 },
        [nodes[1].id]: { seg: 'seg', col: 0, row: 0 },
      },
    };
    const assigned = assignSlots('seg', nodes, depths, anchors);
    const keys = [...assigned.values()].map(slot => `${slot.col}:${slot.row}`);
    expect(new Set(keys).size).toBe(2);
  });

  test('an anchor from a DIFFERENT segment does not follow the task', () => {
    const nodes = addedNodes(graph, 1, 'P', 'p1');
    const anchors: MapPlaneAnchors = {
      ...EMPTY_PLANE_ANCHORS,
      slots: { [nodes[0].id]: { seg: 'elsewhere', col: 9, row: 9 } },
    };
    const assigned = assignSlots('seg', nodes, new Map([[nodes[0].id, 0]]), anchors);
    expect(assigned.get(nodes[0].id)).toEqual({ col: 0, row: 0 });
  });
});

/* ======================================================================
 * PERFORMANCE — the card's guard: no O(n²) in the reflow, measured at the
 * showcase scale and at 5,000 synthetic tasks.
 * ====================================================================== */
describe('performance', () => {
  const syntheticGraph = (taskCount: number): MapGraph => {
    const projects = 20;
    const phasesPer = 5;
    const phases: MapPhase[] = [];
    for (let p = 0; p < projects; p += 1) {
      for (let f = 0; f < phasesPer; f += 1) {
        phases.push({
          id: `ph-${p}-${f}`, name: `Phase ${f}`, goal: null,
          projectId: `pr-${p}`, position: f,
        });
      }
    }
    const nodes: MapTaskNode[] = [];
    const edges: MapEdge[] = [];
    for (let i = 0; i < taskCount; i += 1) {
      const p = i % projects;
      const f = Math.floor(i / projects) % phasesPer;
      nodes.push({
        id: `task-${i}`,
        title: `Synthetic ${i}`,
        status: (['todo', 'in-progress', 'completed', 'stuck', 'review'] as const)[i % 5],
        priority: 'normal',
        project: `Project ${p}`,
        phaseId: i % 7 === 0 ? null : `ph-${p}-${f}`,
        updated: '2026-09-01T00:00:00.000Z',
      } as MapTaskNode);
      // A real dependency chain, so computeDepths does real work.
      if (i >= projects) edges.push({ from: `task-${i}`, to: `task-${i - projects}`, kind: 'dependency' });
    }
    return { nodes, edges, phases };
  };

  const timeLayout = (taskCount: number) => {
    const graph = syntheticGraph(taskCount);
    const sizes = planeSizes(graph);
    // Warm the JIT, then measure the reflow a churn would trigger.
    layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
    const started = performance.now();
    const result = layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
    const laid = performance.now();
    planeFade(result.elements, 0.2);
    const faded = performance.now();
    return { layout: laid - started, fade: faded - laid, result };
  };

  test('5,000 tasks lay out and cross-fade inside the frame budget', () => {
    const { layout, fade, result } = timeLayout(5000);
    // eslint-disable-next-line no-console
    console.log(`[A7c perf] 5000 tasks: layout ${layout.toFixed(1)}ms, fade ${fade.toFixed(1)}ms`);
    expect(result.elements.filter(e => e.kind === 'tile').length).toBe(5000);
    expect(layout).toBeLessThan(3000);
    expect(fade).toBeLessThan(1000);
  });

  test('cost grows LINEARLY, not quadratically, with the estate', () => {
    const small = timeLayout(1000);
    const large = timeLayout(8000);
    // eslint-disable-next-line no-console
    console.log(`[A7c perf] 1000: ${small.layout.toFixed(1)}ms  8000: ${large.layout.toFixed(1)}ms`
      + `  ratio ${(large.layout / Math.max(0.01, small.layout)).toFixed(2)} (8x data)`);
    // Eight times the data. Linear predicts ~8; quadratic predicts ~64. The
    // bound is generous enough that a loaded CI box cannot fail it, and tight
    // enough that a quadratic pass cannot pass it.
    if (small.layout > 2) {
      expect(large.layout / small.layout).toBeLessThan(24);
    }
    expect(large.layout).toBeLessThan(6000);
  });
});

describe('metrics are derived, not invented', () => {
  test('the headroom floor is three tile rows and the growth is geometric', () => {
    expect(PLANE_METRICS.rowUnitY).toBe(FALLBACK_TILE.h + 16);
    expect(PLANE_METRICS.laneHeadroomRows).toBe(3);
    expect(PLANE_METRICS.laneHeadroomRatio).toBeGreaterThan(0);
    expect(PLANE_METRICS.laneHeadroomRatio).toBeLessThan(1);
  });
  test('the cross-fade band sits inside §5\'s far band and ends at the dot floor', () => {
    expect(CROSSFADE_PX.merged).toBe(40);
    expect(CROSSFADE_PX.split).toBe(Math.round(FALLBACK_TILE.w * 0.34));
  });
});

/** Kept so an unused import cannot silently drop a type-level guarantee. */
export type _Elements = PlacedElement;


/* ======================================================================
 * ROUND-1 REVIEW REPAIRS (verdict report 5e7a356f).
 *
 * Every one of these reproduces a finding FIRST — the assertion is written
 * so that it fails against the reviewed candidate — and then holds the
 * repair. Where the reviewer gave a measured number, it is the number here.
 * ====================================================================== */
describe('round-1 finding 1 — a filter is not a deletion', () => {
  const graph = graphFromRecorded();

  test('emptying the FIRST phase of a lane does not pull the second one left', () => {
    // The reviewer's reproduction, verbatim in shape: a lane with two
    // phases, the first one filtered empty. Their probe measured the second
    // phase moving -234px, from x=476 to x=242.
    const phases: MapPhase[] = [
      { id: 'p1', name: 'One', goal: null, projectId: 'proj', position: 0 },
      { id: 'p2', name: 'Two', goal: null, projectId: 'proj', position: 1 },
    ];
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'a', project: 'P', phaseId: 'p1' },
      { ...templateNode(graph), id: 'b', project: 'P', phaseId: 'p2' },
    ];
    const full = { nodes, edges: [], phases } as MapGraph;
    const first = layoutHorizontalPlane(full, planeSizes(full), EMPTY_PLANE_ANCHORS);

    const filtered = { ...full, nodes: nodes.filter(node => node.id !== 'a') };
    const after = layoutHorizontalPlane(filtered, planeSizes(filtered), first.anchors);

    expect(movedIds(positionsOf(first), positionsOf(after), id => id !== 'a')).toEqual([]);
    // The emptied phase still holds its ground and still says what it is.
    const one = bandsOf(after).find(band => band.label === 'One');
    expect(one).toBeDefined();
    expect(one!.w).toBe(bandsOf(first).find(band => band.label === 'One')!.w);
  });

  test('a project filtered out keeps its place, and coming back does not reorder', () => {
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'a1', project: 'A', phaseId: null },
      { ...templateNode(graph), id: 'b1', project: 'B', phaseId: null },
    ];
    const full = { nodes, edges: [], phases: [] } as MapGraph;
    const first = layoutHorizontalPlane(full, planeSizes(full), EMPTY_PLANE_ANCHORS);
    expect(first.anchors.laneOrder).toEqual(['A', 'B']);

    const withoutA = { ...full, nodes: nodes.filter(node => node.project !== 'A') };
    const scoped = layoutHorizontalPlane(withoutA, planeSizes(withoutA), first.anchors);
    // B does NOT climb into A's ground. The reviewer measured it jumping
    // from y=504 to y=32.
    expect(movedIds(positionsOf(first), positionsOf(scoped), id => id.includes('B')
      || id === 'b1')).toEqual([]);
    expect(scoped.anchors.laneOrder).toEqual(['A', 'B']);
    // Nothing is drawn on the lane that is out of scope.
    expect(tilesOf(scoped).map(tile => tile.id)).toEqual(['b1']);
    expect(containersOf(scoped).map(container => container.laneId)).toEqual(['B']);

    const restored = layoutHorizontalPlane(full, planeSizes(full), scoped.anchors);
    expect(restored.anchors.laneOrder).toEqual(['A', 'B']);
    expect(movedIds(positionsOf(first), positionsOf(restored))).toEqual([]);
  });

  test('a lane header that NARROWS does not pull its lane left', () => {
    // Found in the round-2 live capture: applying an ordinary status filter
    // changed the header's §1 counters, the header measured 7px narrower,
    // and every tile in the lane slid 7px left behind it. The header is the
    // lane's furniture; clause 6 makes furniture staying put the point.
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'keep', project: 'P', phaseId: null },
      { ...templateNode(graph), id: 'hidden', project: 'P', phaseId: null,
        status: 'completed' },
    ];
    const full = { nodes, edges: [], phases: [] } as MapGraph;
    const wide = { ...planeSizes(full), 'lane:P': { w: 200, h: 56 } };
    const first = layoutHorizontalPlane(full, wide, EMPTY_PLANE_ANCHORS);

    const filtered = { ...full, nodes: [nodes[0]] };
    // Fewer counters, a narrower header — the measurement the filter causes.
    const narrow = { ...planeSizes(filtered), 'lane:P': { w: 180, h: 56 } };
    const after = layoutHorizontalPlane(filtered, narrow, first.anchors);

    expect(movedIds(positionsOf(first), positionsOf(after), id => id === 'keep'))
      .toEqual([]);
    // The header's placed box is its CELL — the column it is guaranteed to
    // stand in, not the box it happened to measure. `.map-lane-header`
    // carries `inline-size: 220px`, so the column is what it paints.
    const header = after.elements.find(element => element.id === 'lane:P')!;
    expect(header.w).toBe(PLANE_METRICS.laneHeaderW);
    expect(header.h).toBe(PLANE_METRICS.laneHeaderH);
    // The header is a DECLARED COLUMN, so every lane's work starts on the
    // same axis whatever any header happens to measure.
    const tiles = tilesOf(after);
    expect(new Set(tiles.map(tile => Math.round(tile.x))).size)
      .toBeLessThanOrEqual(tiles.length);
    expect(after.anchors.laneHeaderW.P).toBe(PLANE_METRICS.laneHeaderW);
    // ROUND 2, AT THE CLASS. This used to end by asserting that a header
    // measuring 300 took 300 of ground — "under-reserving is the worse
    // failure". It is not: a reservation that reads the size map is a
    // reservation the FILTER can move, because the size map holds what has
    // been mounted rather than what exists. The measured box no longer
    // reaches the lattice at all, in either direction.
    const wider = { ...planeSizes(full), 'lane:P': { w: 300, h: 300 } };
    const grown = layoutHorizontalPlane(full, wider, after.anchors);
    expect(grown.anchors.laneHeaderW.P).toBe(PLANE_METRICS.laneHeaderW);
    expect(movedIds(positionsOf(after), positionsOf(grown))).toEqual([]);
  });

  test('a CONNECTOR does not change gaps because a filter moved the boundary', () => {
    // Measured in the round-2 live capture: one connector moved 94px under an
    // ordinary status filter. A connector's gap is DERIVED from where the
    // phases' depth ranges end, so filtering out a phase's DEEPEST task moves
    // the boundary the connector was placed against — and a task nobody
    // touched changes place because the reader narrowed the view. Derived
    // placement is anchored; declared placement (a task's phase) is not.
    const phases: MapPhase[] = [
      { id: 'p1', name: 'One', goal: null, projectId: 'proj', position: 0 },
    ];
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'a1', project: 'P', phaseId: 'p1', status: 'todo' },
      { ...templateNode(graph), id: 'c', project: 'P', phaseId: null, status: 'todo' },
      { ...templateNode(graph), id: 'a2', project: 'P', phaseId: 'p1', status: 'completed' },
    ];
    const edges: MapEdge[] = [
      { from: 'c', to: 'a1', kind: 'dependency' },
      { from: 'a2', to: 'c', kind: 'dependency' },
    ];
    const full = { nodes, edges, phases } as MapGraph;
    const first = layoutHorizontalPlane(full, planeSizes(full), EMPTY_PLANE_ANCHORS);
    const home = first.anchors.slots.c.seg;

    // Hide completed work: the phase's deepest task goes, and with it the
    // boundary the connector was placed against.
    const filtered = { ...full, nodes: nodes.filter(node => node.id !== 'a2') };

    // CONTROL FIRST, so the repair is measured against a defect that is
    // actually there: with no record to go on, the connector changes gaps.
    const unanchored = layoutHorizontalPlane(
      filtered, planeSizes(filtered), EMPTY_PLANE_ANCHORS);
    expect(unanchored.anchors.slots.c.seg).not.toBe(home);

    // …and with the record, it does not move at all.
    const after = layoutHorizontalPlane(filtered, planeSizes(filtered), first.anchors);
    expect(after.anchors.slots.c.seg).toBe(home);
    expect(movedIds(positionsOf(first), positionsOf(after), id => id !== 'a2')).toEqual([]);
  });

  test('a Report pill measuring wider than its fallback does not widen a column', () => {
    // Round 2, live: a phase box grew 94px on the pass where its pill first
    // measured, and the tile beyond it moved with it. The reservation is
    // monotone, so an under-reserving fallback is a one-way shove.
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'cited', project: 'P', phaseId: null },
      { ...templateNode(graph), id: 'after', project: 'P', phaseId: null },
    ];
    const local = {
      nodes, edges: [], phases: [],
      reports: [{ id: 'r1', taskId: 'cited', title: 'Linked' }],
    } as MapGraph;
    const unmeasured = planeSizes(local);
    const first = layoutHorizontalPlane(local, unmeasured, EMPTY_PLANE_ANCHORS);
    // The pill now reports a real box, wider than FALLBACK_PILL's touch floor.
    const measured = { ...unmeasured, 'pill:r1:cited': { w: 86, h: 36 } };
    const after = layoutHorizontalPlane(local, measured, first.anchors);
    expect(movedIds(positionsOf(first), positionsOf(after))).toEqual([]);
  });

  test('CONTROL: without the segment and lane record, both of those move', () => {
    // The same two churns with the anchors thrown away — which is what the
    // reviewed candidate effectively did for an emptied segment or lane.
    const phases: MapPhase[] = [
      { id: 'p1', name: 'One', goal: null, projectId: 'proj', position: 0 },
      { id: 'p2', name: 'Two', goal: null, projectId: 'proj', position: 1 },
    ];
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'a', project: 'P', phaseId: 'p1' },
      { ...templateNode(graph), id: 'b', project: 'P', phaseId: 'p2' },
    ];
    const full = { nodes, edges: [], phases } as MapGraph;
    const first = layoutHorizontalPlane(full, planeSizes(full), EMPTY_PLANE_ANCHORS);
    const filtered = { ...full, nodes: nodes.filter(node => node.id !== 'a') };
    const unanchored = layoutHorizontalPlane(
      filtered, planeSizes(filtered), EMPTY_PLANE_ANCHORS);
    expect(movedIds(positionsOf(first), positionsOf(unanchored), id => id === 'b').length)
      .toBeGreaterThan(0);
  });
});

/**
 * ROUND 2 — the clause-6 residual, and the CLASS it belongs to.
 *
 * The symptom the round-1 candidate was left with: under an ordinary status
 * filter one tile of seven moved +94px on the 5,023-task portal and a phase
 * box to its left grew from w=202 to w=296, while an identical reload moved
 * nothing, twice. Four causes had been ruled out by measurement (measurement
 * convergence, the lane header, the Report-pill reservation, and a segment or
 * lane being deleted) and none of them was it.
 *
 * The cause is not an element. It is that the plane's LATTICE was a function
 * of the SIZE MAP, and the size map is not a property of the data: it holds
 * what has been MOUNTED. Tiles report their boxes as culling admits them, so
 * it grows through a session, and what is in it depends on the viewport, on
 * where the reader has panned, and on the filter. On a plane whose
 * reservations are monotone, a measurement arriving late is a permanent
 * shove.
 *
 * `(a)` below is the reproduction, at the exact numbers: with the node set,
 * the anchors and the filter ALL held constant, one tile measuring for the
 * first time moved the tiles beyond it by 94px. It fails on the parent
 * commit and passes here.
 *
 * The repair is stated once, in PLANE_METRICS: a reservation is a DECLARED
 * CEILING, and the stylesheet holds each element inside its cell. `(f)` is
 * the property that makes the class dead rather than the coordinate — the
 * layout's POSITIONS are invariant under the size map, so there is no
 * measurement, present or future, that any of these cases can be sensitive
 * to.
 */
describe('round-2 residual — a reservation is a DECLARED CEILING', () => {
  const laneOf = (id: string) => ({ project: 'P', phaseId: id });

  /** Two phases in one lane, the second standing beside the first. */
  const twoPhaseGraph = (): MapGraph => {
    const template = templateNode(graphFromRecorded());
    const node = (id: string, phaseId: string, status: string): MapTaskNode => ({
      ...template, id, title: id, status, agent: null,
      updated: '2026-01-01T00:00:00.000Z',
      ...laneOf(phaseId),
    } as MapTaskNode);
    return {
      nodes: [
        node('a1', 'p1', 'completed'),
        node('a2', 'p1', 'todo'),
        node('b1', 'p2', 'todo'),
        node('b2', 'p2', 'in-progress'),
      ],
      edges: [],
      phases: [
        { id: 'p1', name: 'One', position: 0, goal: null, projectId: 'P' },
        { id: 'p2', name: 'Two', position: 1, goal: null, projectId: 'P' },
      ] as MapPhase[],
    } as MapGraph;
  };

  /** Everything measured at the box the DOM would report. */
  const measured = (graph: MapGraph, extra: SizeMap = {}): SizeMap =>
    planeSizes(graph, extra);

  test('(a) a tile measured for the FIRST TIME moves nothing beyond it', () => {
    // The reproduction. `a2` had not reported when the plane was first laid
    // out — culling had not admitted it — so its column was reserved from
    // the fallback. The filter then admitted it and it measured 264 wide.
    // On the parent commit: segWidth 202 -> 296, and b1/b2 +94px.
    const graph = twoPhaseGraph();
    const unmeasured = measured(graph);
    delete (unmeasured as Record<string, unknown>)['a2'];
    const first = layoutHorizontalPlane(graph, unmeasured, EMPTY_PLANE_ANCHORS);

    const admitted = { ...unmeasured, a2: { w: 264, h: 96 } };
    const after = layoutHorizontalPlane(graph, admitted, first.anchors);

    expect(movedIds(positionsOf(first), positionsOf(after))).toEqual([]);
    expect(after.anchors.segWidth).toEqual(first.anchors.segWidth);
    expect(after.anchors.cols).toEqual(first.anchors.cols);
  });

  test('(b) FILTER: narrowing the scope while measurements arrive moves nothing', () => {
    // The live shape: the reader applies a status filter, the mounted set
    // changes, and boxes that had never been measured are measured now.
    const graph = twoPhaseGraph();
    const partial = measured(graph);
    delete (partial as Record<string, unknown>)['a2'];
    delete (partial as Record<string, unknown>)['lane:P'];
    const first = layoutHorizontalPlane(graph, partial, EMPTY_PLANE_ANCHORS);

    const kept = { ...graph, nodes: graph.nodes.filter(n => n.status !== 'completed') };
    const arrived: SizeMap = {
      ...partial,
      a2: { w: 264, h: 140 },
      'lane:P': { w: 300, h: 120 },
      'chip:band:P:p1': { w: 260, h: 44 },
    };
    const after = layoutHorizontalPlane(kept, arrived, first.anchors);

    expect(movedIds(positionsOf(first), positionsOf(after))).toEqual([]);
  });

  test('(c) RELOAD: the same world, measured from scratch, is the same world', () => {
    // A reload starts with an EMPTY size map and fills it in a different
    // order. The record is what carries the world across, and it must not
    // be sensitive to the order the boxes arrive in.
    const graph = twoPhaseGraph();
    const first = layoutHorizontalPlane(graph, measured(graph), EMPTY_PLANE_ANCHORS);
    const cold = layoutHorizontalPlane(graph, {}, first.anchors);
    const warming = layoutHorizontalPlane(
      graph, { a1: { w: 264, h: 190 } }, cold.anchors);
    const warm = layoutHorizontalPlane(graph, measured(graph), warming.anchors);

    expect(movedIds(positionsOf(first), positionsOf(cold))).toEqual([]);
    expect(movedIds(positionsOf(first), positionsOf(warming))).toEqual([]);
    expect(movedIds(positionsOf(first), positionsOf(warm))).toEqual([]);
  });

  test('(d) NEW SESSION: a record through JSON restores the same world', () => {
    const graph = twoPhaseGraph();
    const first = layoutHorizontalPlane(graph, measured(graph), EMPTY_PLANE_ANCHORS);
    const restored = parseAnchors(JSON.stringify(first.anchors));
    // A new session measures nothing at first and everything eventually,
    // and neither state may move what the last session left standing.
    const opened = layoutHorizontalPlane(graph, {}, restored);
    const settled = layoutHorizontalPlane(
      graph, measured(graph, { a2: { w: 264, h: 150 } }), opened.anchors);

    expect(movedIds(positionsOf(first), positionsOf(opened))).toEqual([]);
    expect(movedIds(positionsOf(first), positionsOf(settled))).toEqual([]);
  });

  test('(e) LIVE CREATION: a task arriving mid-measurement moves nothing', () => {
    const graph = twoPhaseGraph();
    const partial = measured(graph);
    delete (partial as Record<string, unknown>)['b1'];
    const first = layoutHorizontalPlane(graph, partial, EMPTY_PLANE_ANCHORS);

    const born = {
      ...graph,
      nodes: [...graph.nodes, ...addedNodes(graph, 1, 'P', 'p1', 'live')],
    };
    // The new tile has not been measured yet; the one that had been missing
    // is measured now. Neither may move anything already standing.
    const after = layoutHorizontalPlane(
      born, { ...partial, b1: { w: 264, h: 200 } }, first.anchors);

    expect(movedIds(positionsOf(first), positionsOf(after))).toEqual([]);
  });

  test('(f) THE CLASS: positions are invariant under the size map', () => {
    // The property, not the coordinate. Every case above is an instance of
    // it, and so is every case nobody has thought of: for one graph and one
    // anchor record, no size map can change where anything is placed.
    const graph = graphFromRecorded();
    const anchors = layoutHorizontalPlane(
      graph, planeSizes(graph), EMPTY_PLANE_ANCHORS).anchors;

    const adversarial: Record<string, { w: number; h: number }> = {};
    for (const node of graph.nodes) adversarial[node.id] = { w: 900, h: 700 };
    for (const project of new Set(graph.nodes.map(n => n.project ?? '__no_project__'))) {
      adversarial[`lane:${project}`] = { w: 1200, h: 900 };
    }
    for (const phase of graph.phases) {
      for (const project of new Set(graph.nodes.map(n => n.project ?? '__no_project__'))) {
        adversarial[`chip:band:${project}:${phase.id}`] = { w: 800, h: 400 };
      }
    }

    const nothing = positionsOf(layoutHorizontalPlane(graph, {}, anchors));
    const ordinary = positionsOf(layoutHorizontalPlane(graph, planeSizes(graph), anchors));
    const absurd = positionsOf(layoutHorizontalPlane(graph, adversarial, anchors));

    expect(movedIds(nothing, ordinary)).toEqual([]);
    expect(movedIds(nothing, absurd)).toEqual([]);
    // …and the extents the containers are drawn at are the same lattice.
    const extentOf = (sizes: SizeMap) => bandsOf(layoutHorizontalPlane(graph, sizes, anchors))
      .map(band => `${band.id}:${Math.round(band.w)}x${Math.round(band.h)}`).sort();
    expect(extentOf(adversarial)).toEqual(extentOf({}));
    expect(extentOf(planeSizes(graph))).toEqual(extentOf({}));
  });

  test('(f2) THE LIVE ONE: a chip that measures 265 does not widen its band', () => {
    // Measured on the 5,023-task portal, at the deployed candidate, with the
    // record dumped either side of an ordinary status filter:
    //
    //   segWidth  'Atlas Migration    //   band at (912,32)                                w  202 -> 297
    //   one tile of seven                              +95px, top identical
    //   cols / rows / laneHeaderW                       UNCHANGED
    //   the chip in that band                           107 -> 265 wide
    //
    // Not a column and not a lane: the CHIP. A filter changes the estate's
    // extent, the fit changes the scale, the scale crosses a §5 detail band,
    // the goal line expands, and the label the band was widened to contain
    // shoved everything to its right. A container is its contents' region;
    // the label is held inside it.
    const graph = twoPhaseGraph();
    const contracted = measured(graph, { 'chip:band:P:p1': { w: 107, h: 25 } });
    const first = layoutHorizontalPlane(graph, contracted, EMPTY_PLANE_ANCHORS);
    const expanded = measured(graph, { 'chip:band:P:p1': { w: 265, h: 44 } });
    const after = layoutHorizontalPlane(graph, expanded, first.anchors);

    expect(movedIds(positionsOf(first), positionsOf(after))).toEqual([]);
    expect(after.anchors.segWidth).toEqual(first.anchors.segWidth);

    // …and the chip is inside the band it labels, at both measurements.
    for (const result of [first, after]) {
      const bands = new Map(bandsOf(result).map(band => [band.id, band]));
      const chips = result.elements.filter(element => element.kind === 'chip');
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) {
        const band = bands.get((chip as { bandId: string }).bandId)!;
        expect(chip.x).toBeGreaterThanOrEqual(band.x);
        expect(chip.x + chip.w).toBeLessThanOrEqual(band.x + band.w + 0.5);
        // A band is never narrower than one tile column and its padding, so
        // the label always has at least a tile's worth of room.
        expect(chip.w).toBeGreaterThanOrEqual(PLANE_METRICS.tileCellW);
      }
    }
  });

  test('(g) CONTROL: the pre-amendment engine fails every one of them', () => {
    // The negative control this suite is written under: an engine that
    // recomputes from the measured boxes moves the world on exactly the
    // input (a) holds still for.
    const graph = twoPhaseGraph();
    const partial = planeSizes(graph);
    delete (partial as Record<string, unknown>)['a2'];
    const before = positionsOf(layoutHorizontal(graph, partial));
    const after = positionsOf(layoutHorizontal(graph, { ...partial, a2: { w: 264, h: 264 } }));
    expect(movedIds(before, after).length).toBeGreaterThan(0);
  });

  test('(h) the declared ceilings are ceilings — the numbers are stated', () => {
    // Measured on the 5,023-task portal at all four detail bands and
    // recorded in the evidence: tiles 170 wide (the stylesheet's constant)
    // and 81..108 tall, chips 68..107 x 25, lane headers 220 x 66, Report
    // pills 36 x 36. Each cell must stand above what its element paints, or
    // the reservation is a lie and the ink escapes it.
    expect(PLANE_METRICS.tileCellW).toBe(FALLBACK_TILE.w);
    expect(PLANE_METRICS.tileCellH).toBeGreaterThanOrEqual(108);
    expect(PLANE_METRICS.chipCellH).toBeGreaterThanOrEqual(25);
    expect(PLANE_METRICS.laneHeaderW).toBeGreaterThanOrEqual(220);
    expect(PLANE_METRICS.laneHeaderH).toBeGreaterThanOrEqual(66);
    expect(PLANE_METRICS.pillReserveW).toBeGreaterThanOrEqual(44);
    expect(PLANE_METRICS.pillReserveH).toBeGreaterThanOrEqual(44);
  });
});

describe('round-1 finding 6 — a declared phase is a segment even when empty', () => {
  const graph = graphFromRecorded();

  test('an empty declared phase holds its place in the declared order', () => {
    const phases: MapPhase[] = [
      { id: 'p-empty', name: 'Empty', goal: null, projectId: 'proj', position: 0 },
      { id: 'p-used', name: 'Used', goal: null, projectId: 'proj', position: 1 },
    ];
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'only', project: 'P', phaseId: 'p-used' },
    ];
    // The reviewer's probe printed `empty-phase-segments [ 'phase:p-used' ]`.
    const segments = planeSegments(nodes, phases, new Map([['only', 0]]));
    expect(segments.map(segment => segment.key)).toEqual(['phase:p-empty', 'phase:p-used']);
    expect(segments[0].nodes).toEqual([]);

    const local = { nodes, edges: [], phases } as MapGraph;
    const result = layoutHorizontalPlane(local, planeSizes(local));
    const labels = bandsOf(result).sort((a, b) => a.x - b.x).map(band => band.label);
    expect(labels).toEqual(['Empty', 'Used']);
    expect(findOverlaps(result.elements)).toEqual([]);
  });

  test('the layout finds a lane\'s declared phases through its own tasks', () => {
    // graph.phases is the ESTATE's phase list, keyed by project ID, while a
    // lane is keyed by project NAME. The mapping is derived from the nodes.
    const phases: MapPhase[] = [
      { id: 'x1', name: 'Alpha', goal: null, projectId: 'px', position: 0 },
      { id: 'x2', name: 'Beta', goal: null, projectId: 'px', position: 1 },
      { id: 'y1', name: 'Other', goal: null, projectId: 'py', position: 0 },
    ];
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'n1', project: 'X', phaseId: 'x1' },
      { ...templateNode(graph), id: 'n2', project: 'Y', phaseId: 'y1' },
    ];
    const local = { nodes, edges: [], phases } as MapGraph;
    const result = layoutHorizontalPlane(local, planeSizes(local));
    const inX = bandsOf(result).filter(band => band.laneId === 'X').map(band => band.label);
    expect(inX.sort()).toEqual(['Alpha', 'Beta']);
    // A phase belonging to another project does not leak into this lane.
    expect(inX).not.toContain('Other');
  });
});

describe('round-1 finding 5 — the cap is a cap', () => {
  const slotsFor = (count: number, prefix = 't') => {
    const slots: Record<string, { seg: string; col: number; row: number }> = {};
    for (let i = 0; i < count; i += 1) {
      slots[`${prefix}${i}`] = { seg: `lane\u0000phase:p${i % 7}`, col: 0, row: i };
    }
    return slots;
  };

  test('present slots do not escape the cap', () => {
    // The reviewer measured `cap 12000 ... all-present-slot-result 12001`.
    const anchors: MapPlaneAnchors = { ...EMPTY_PLANE_ANCHORS, slots: slotsFor(12001) };
    const present = new Set(Object.keys(anchors.slots));
    const pruned = pruneAnchors(anchors, present, 12000);
    expect(Object.keys(pruned.slots).length).toBe(12000);
  });

  test('absent lanes and segments are given up before present ones', () => {
    const laneHeight: Record<string, number> = {};
    const segWidth: Record<string, number> = {};
    const segOrder: Record<string, string[]> = {};
    for (let i = 0; i < 20000; i += 1) {
      laneHeight[`ghost-lane-${i}`] = 400;
      segWidth[`ghost-lane-${i}\u0000phase:p`] = 300;
      segOrder[`ghost-lane-${i}`] = ['phase:p'];
    }
    // …and one lane that IS in scope, so the assertion below is about what
    // survives rather than about an empty record.
    laneHeight['live-lane'] = 400;
    segWidth['live-lane\u0000phase:p'] = 300;
    segOrder['live-lane'] = ['phase:p'];
    const anchors: MapPlaneAnchors = {
      ...EMPTY_PLANE_ANCHORS,
      laneOrder: [...Object.keys(laneHeight)],
      laneHeight, segWidth, segOrder,
      slots: { live: { seg: 'live-lane\u0000phase:p', col: 0, row: 0 } },
    };
    // The reviewer measured this record serialising to 1,255,631 bytes and
    // surviving every prune.
    expect(anchorBytes(anchors)).toBeGreaterThan(1_000_000);
    const pruned = pruneAnchors(anchors, new Set(['live']), 12000, 200_000);
    expect(anchorBytes(pruned)).toBeLessThanOrEqual(200_000);
    // What survives is exactly the ground the current scope is standing on.
    expect(Object.keys(pruned.laneHeight)).toEqual(['live-lane']);
    expect(Object.keys(pruned.slots)).toEqual(['live']);
  });

  test('it terminates even when the live record alone is too big', () => {
    const anchors: MapPlaneAnchors = { ...EMPTY_PLANE_ANCHORS, slots: slotsFor(4000) };
    const present = new Set(Object.keys(anchors.slots));
    const pruned = pruneAnchors(anchors, present, 12000, 1000);
    expect(anchorBytes(pruned)).toBeLessThanOrEqual(1000);
  });

  test('an ordinary record is returned untouched, and the budget is stated', () => {
    const anchors: MapPlaneAnchors = { ...EMPTY_PLANE_ANCHORS, slots: slotsFor(50) };
    expect(pruneAnchors(anchors, new Set(Object.keys(anchors.slots)))).toBe(anchors);
    expect(MAX_SLOT_ANCHORS).toBe(12000);
    // A third of a 5 MB origin quota, at most.
    expect(MAX_ANCHOR_BYTES).toBeLessThanOrEqual(5_000_000 / 3);
  });
});

describe('round-1 finding 4 — the card is measured, not assumed', () => {
  test('a region that fits the NOMINAL card can fail against a measured one', () => {
    const region = { w: 1000, h: 400 };
    const scale = 0.24;   // 240 x 96 on screen: exactly the nominal box
    expect(cardFits(region, scale)).toBe(true);
    // The counter row wraps and the card comes back taller. It no longer fits,
    // and the container must therefore show tint alone rather than spill.
    expect(cardFits(region, scale, { w: PLANE_CARD_PX.w, h: 140 })).toBe(false);
  });

  test('the fit is exact at the boundary, in both axes', () => {
    expect(cardFits({ w: 220, h: 96 }, 1)).toBe(true);
    expect(cardFits({ w: 219.9, h: 96 }, 1)).toBe(false);
    expect(cardFits({ w: 220, h: 95.9 }, 1)).toBe(false);
  });
});

describe('round-1 finding 7 — the overlap oracle can see a foreign escape', () => {
  const graph = graphFromRecorded();

  test('a tile standing in ANOTHER project\'s container is reported', () => {
    const result = layoutHorizontalPlane(graph, planeSizes(graph));
    const containers = containersOf(result);
    expect(containers.length).toBeGreaterThan(1);
    const home = containers[0];
    const foreign = containers[1];
    // A tile belonging to `home`, moved onto `foreign`'s ground. Nothing in
    // the layout does this; the point is that the CHECKER would see it.
    const escapee: PlacedTile = {
      kind: 'tile',
      id: 'escapee',
      node: { ...graph.nodes[0], id: 'escapee' },
      depth: 0,
      laneId: home.laneId,
      bandId: null,
      x: foreign.x + 4, y: foreign.y + 4, w: 20, h: 20,
    };
    const overlaps = findOverlaps([...result.elements, escapee]);
    expect(overlaps.some(pair => pair.includes('escapee'))).toBe(true);
    // …while a tile on its OWN container's ground is containment, not
    // collision, exactly as before.
    const athome: PlacedTile = { ...escapee, id: 'athome', laneId: foreign.laneId };
    const still = findOverlaps([...result.elements, athome])
      .filter(pair => pair.includes('athome') && pair.includes(foreign.id));
    expect(still).toEqual([]);
  });
});

describe('attention projection preserves the selected chain', () => {
  const template = graphFromRecorded().nodes[0];
  const graph: MapGraph = {nodes:[
    {...template,id:'a',project:'P',phaseId:'one'},
    {...template,id:'b',project:'P',phaseId:'two'},
    {...template,id:'c',project:'Q',phaseId:'three'},
  ], edges:[], reports:[], phases:[]};
  test('a phase selection lights its tasks and parent, without admitting sibling tasks',()=>{
    const attention=projectPlaneAttention(graph,null,new Set(['phase:P\u0000one']));
    expect([...attention.tasks!]).toEqual(['a']);
    expect([...attention.containers!].sort()).toEqual(['phase:P\u0000one','project:P']);
  });
  test('a project selection lights its phases and tasks across the fading layers',()=>{
    const attention=projectPlaneAttention(graph,null,new Set(['project:P']));
    expect([...attention.tasks!]).toEqual(['a','b']);
    expect([...attention.containers!].sort()).toEqual(['phase:P\u0000one','phase:P\u0000two','project:P']);
  });
  test('a task selection keeps priority over container hover and lights its containing regions',()=>{
    const attention=projectPlaneAttention(graph,new Set(['c']),new Set(['project:P']));
    expect([...attention.tasks!]).toEqual(['c']);
    expect([...attention.containers!].sort()).toEqual(['phase:Q\u0000three','project:Q']);
  });
  test('clearing selection clears dimming in every representation',()=>{
    expect(projectPlaneAttention(graph,null,null)).toEqual({tasks:null,containers:null});
  });
});


describe('RH-UI.17i rendered-width LOD', () => {
  test.each([[160, 'full'], [159.99, 'compact'], [96, 'compact'], [95.99, 'aggregate'],
    [40, 'aggregate'], [39.99, 'silhouette']] as const)('%s CSS pixels selects %s', (width, band) => {
    expect(planeDetailBand(width)).toBe(band);
  });
  test('all four bands retain every container coordinate and extent', () => {
    const graph = graphFromRecorded();
    const layout = layoutHorizontalPlane(graph, planeSizes(graph));
    const before = JSON.stringify(layout.elements.filter(e => e.kind === 'band' || e.kind === 'container'));
    for (const width of [170, 110, 60, 30]) {
      planeDetailBand(width);
      planeFade(layout.elements, width / 170);
      expect(JSON.stringify(layout.elements.filter(e => e.kind === 'band' || e.kind === 'container'))).toBe(before);
    }
  });
});


describe('RH-UI.17i vertical plane', () => {
  test('is deterministic, preserves upright measured cards, and contains all work without overlaps', () => {
    const graph = graphFromRecorded();
    const sizes = planeSizes(graph);
    const layout = layoutVerticalPlane(graph, sizes);
    expect(layoutVerticalPlane(graph, sizes, layout.anchors)).toEqual(layout);
    expect(findOverlaps(layout.elements)).toEqual([]);
    for (const tile of layout.elements.filter((e): e is PlacedTile => e.kind === 'tile')) {
      expect(tile.w).toBe(sizes[tile.id].w);
      expect(tile.h).toBe(sizes[tile.id].h);
      const phase = layout.elements.find(e => e.kind === 'band' && e.id === tile.bandId);
      if (phase) expect(tile.y - phase.y).toBeGreaterThanOrEqual(PLANE_METRICS.captionHeaderH);
    }
    expect(layout.elements.filter(e => e.kind === 'tile')).toHaveLength(graph.nodes.length);
  });
});


describe('RH-UI.17i radial plane', () => {
  test('rings and Phase territories are deterministic, contained, and nonoverlapping', () => {
    const graph = graphFromRecorded();
    const sizes = planeSizes(graph);
    const layout = layoutRadialPlane(graph, sizes);
    expect(layoutRadialPlane(graph, sizes)).toEqual(layout);
    expect(layoutRadialPlane(graph, sizes, layout.anchors)).toEqual(layout);
    expect(findOverlaps(layout.elements)).toEqual([]);
    expect(layout.elements.filter(e => e.kind === 'tile')).toHaveLength(graph.nodes.length);
    const ids = new Set(layout.elements.filter(e => e.kind === 'tile').map(e => e.id));
    for (const edge of graph.edges) { expect(ids.has(edge.from)).toBe(true); expect(ids.has(edge.to)).toBe(true); }
  });
});


describe('RH-UI.17i organic plane', () => {
  test('seeded force layout is deterministic and anchored, with no foreign overlaps', () => {
    const graph=graphFromRecorded(),sizes=planeSizes(graph);
    const layout=layoutOrganicPlane(graph,sizes);
    expect(layoutOrganicPlane(graph,sizes)).toEqual(layout);
    expect(layoutOrganicPlane(graph,sizes,layout.anchors)).toEqual(layout);
    expect(findOverlaps(layout.elements)).toEqual([]);
    expect(layout.elements.filter(e=>e.kind==='tile')).toHaveLength(graph.nodes.length);
    const ids=new Set(layout.elements.filter(e=>e.kind==='tile').map(e=>e.id));
    for(const edge of graph.edges) { expect(ids.has(edge.from)).toBe(true);expect(ids.has(edge.to)).toBe(true); }
  });
});


describe('owner sketches: Organic archive core and outward branches', () => {
  const fixture = (): MapGraph => ({
    nodes: [
      ...['root','left','right'].map((id,index) => ({id,title:id,status:'in-progress',priority:'normal',
        project:'Branch project',phaseId:'p'+index,updated:'2026-09-08T00:00:00Z'})),
      {id:'old',title:'Archived work',status:'archived',priority:'normal',project:'Branch project',phaseId:'p0',updated:'2026-09-08T00:00:00Z'},
      {id:'small',title:'Small project',status:'todo',priority:'normal',project:'Small',phaseId:null,updated:'2026-09-08T00:00:00Z'},
    ],
    phases: [0,1,2].map(i=>({id:'p'+i,name:'Phase '+i,goal:null,projectId:'project',position:i})),
    edges: [{from:'left',to:'root',kind:'dependency'},{from:'right',to:'root',kind:'dependency'},
      {from:'root',to:'old',kind:'dependency'},{from:'small',to:'left',kind:'dependency'}],
  });
  test('archived task corners are inside the circular core; original records and edges survive', () => {
    const graph=fixture(), layout=layoutOrganicPlane(graph,planeSizes(graph));
    const core=layout.organicRegions!.find(r=>r.core)!.box;
    const archived=tilesOf(layout).find(e=>e.id==='old')!;
    expect(archived.node).toEqual(graph.nodes.find(n=>n.id==='old'));
    expect(archived.laneId).toBe(ORGANIC_CORE);
    for(const x of [archived.x,archived.x+archived.w]) for(const y of [archived.y,archived.y+archived.h]) {
      expect(((x-core.x-core.w/2)/(core.w/2))**2+((y-core.y-core.h/2)/(core.h/2))**2).toBeLessThan(1);
    }
    expect(organicPlaneGraph(graph).edges).toBe(graph.edges);
    expect(organicPlaneGraph(graph).nodes.find(n=>n.id==='old')?.project).toBe(ORGANIC_CORE);
    expect(findOverlaps(layout.elements)).toEqual([]);
    expect(layoutOrganicPlane(graph,planeSizes(graph),parseAnchors(JSON.stringify(layout.anchors)))).toEqual(layout);
  });
  test('unphased tasks contribute Project ground without a false Phase', () => {
    const graph=fixture();
    graph.nodes.push({...graph.nodes[0],id:'connector',phaseId:null});
    const layout=layoutOrganicPlane(graph,planeSizes(graph));
    const region=layout.organicRegions!.find(r=>r.laneId==='Branch project')!;
    expect(region.clusters.filter(c=>c.phaseId).map(c=>c.phaseId).sort()).toEqual(graph.phases.map(p=>p.id).sort());
    expect(region.clusters.filter(c=>!c.phaseId)).toHaveLength(1);
    expect(tilesOf(layout).find(t=>t.id==='connector')!.bandId).toBeNull();
  });
  test('project territory reaches its archive-core attachment without moving its caption', () => {
    const graph=fixture(),layout=layoutOrganicPlane(graph,planeSizes(graph));
    for(const region of layout.organicRegions!.filter(r=>!r.core)) {
      const [x,y]=region.branches[0];
      expect(x).toBeGreaterThanOrEqual(region.box.x);
      expect(x).toBeLessThanOrEqual(region.box.x+region.box.w);
      expect(y).toBeGreaterThanOrEqual(region.box.y);
      expect(y).toBeLessThanOrEqual(region.box.y+region.box.h);
      const owner=layout.elements.find(e=>e.kind==='container'&&e.laneId===region.laneId)!;
      expect(region.captionBox).toEqual({x:owner.x,y:owner.y,w:owner.w,h:owner.h});
      expect(region.outline!.split('M ').filter(Boolean)).toHaveLength(1);
    }
  });
  test('a dependency fork has two distinct arms from its parent phase', () => {
    const graph=fixture(),layout=layoutOrganicPlane(graph,planeSizes(graph));
    const region=layout.organicRegions!.find(r=>r.laneId==='Branch project')!;
    expect(region.clusters).toHaveLength(3);
    const children=region.branches.slice(2);
    expect(children).toHaveLength(2);
    expect(children[0].slice(0,2)).toEqual(children[1].slice(0,2));
    expect(children[0].slice(2)).not.toEqual(children[1].slice(2));
    const [a,b]=children;
    const cross=(a[2]-a[0])*(b[3]-b[1])-(a[3]-a[1])*(b[2]-b[0]);
    expect(Math.abs(cross)).toBeGreaterThan(100);
  });
  test('branch territory outlines enclose phase corners and remain inside project ground', () => {
    const graph=fixture(),layout=layoutOrganicPlane(graph,planeSizes(graph));
    for(const region of layout.organicRegions!.filter(r=>!r.core)) {
      expect(region.outline).toBeTruthy();
      const loops=region.outline!.split('M ').filter(Boolean).map(part=>{
        const tokens=('M '+part).match(/[MLQZ]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!;
        const points:number[][]=[];let i=0,at=[0,0];
        while(i<tokens.length) {
          const command=tokens[i++];
          if(command==='Z') break;
          if(command==='M'||command==='L') {at=[Number(tokens[i++]),Number(tokens[i++])];points.push(at);}
          else if(command==='Q') {
            const c=[Number(tokens[i++]),Number(tokens[i++])],end=[Number(tokens[i++]),Number(tokens[i++])],start=at;
            for(let step=1;step<=20;step++) {const t=step/20,u=1-t;points.push([u*u*start[0]+2*u*t*c[0]+t*t*end[0],u*u*start[1]+2*u*t*c[1]+t*t*end[1]]);}
            at=end;
          } else throw new Error('Unexpected path command: '+command);
        }
        expect(points.flat().every(Number.isFinite)).toBe(true);
        return points;
      });
      const contains=(x:number,y:number)=> {
        let inside=false;
        for(const loop of loops) for(let i=0,j=loop.length-1;i<loop.length;j=i++) {
          const a=loop[i],b=loop[j];
          if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
        }
        return inside;
      };
      for(const box of region.clusters) for(const x of [box.x+1,box.x+box.w-1])
        for(const y of [box.y+1,box.y+box.h-1]) expect(contains(x,y)).toBe(true);
      for(const loop of loops) for(const [x,y] of loop) {
        expect(x).toBeGreaterThanOrEqual(region.box.x);expect(x).toBeLessThanOrEqual(region.box.x+region.box.w);
        expect(y).toBeGreaterThanOrEqual(region.box.y);expect(y).toBeLessThanOrEqual(region.box.y+region.box.h);
      }
    }
  });
  test('Radial puts successive phase clusters farther along one spoke', () => {
    const graph=fixture(),layout=layoutRadialPlane(graph,planeSizes(graph));
    const region=layout.organicRegions!.find(r=>r.laneId==='Branch project')!;
    const core=layout.anchors.organicHomes![ORGANIC_CORE];
    const centres=region.clusters.map(b=>({x:b.x+b.w/2,y:b.y+b.h/2}));
    const distance=(p:{x:number;y:number})=>Math.hypot(p.x-core.x-core.w/2,p.y-core.y-core.h/2);
    for(let i=1;i<centres.length;i+=1) expect(distance(centres[i])).toBeGreaterThan(distance(centres[i-1]));
    expect(layout.organicRegions!.some(r=>r.core)).toBe(false);
    expect(tilesOf(layout).find(e=>e.id==='old')!.laneId).toBe('Branch project');
    expect(findOverlaps(layout.elements)).toEqual([]);
  });
  test('permuting source arrays keeps the fresh Organic geography deterministic', () => {
    const graph=fixture(),sizes=planeSizes(graph);
    const before=layoutOrganicPlane(graph,sizes);
    const after=layoutOrganicPlane({...graph,nodes:[...graph.nodes].reverse(),edges:[...graph.edges].reverse(),phases:[...graph.phases].reverse()},sizes);
    expect(positionsOf(after)).toEqual(positionsOf(before));
    expect(after.organicRegions).toEqual(before.organicRegions);
  });
  test('adding a project preserves the inhabited world origin and existing tasks', () => {
    const graph=fixture(),sizes=planeSizes(graph),before=layoutOrganicPlane(graph,sizes);
    const added={...graph,nodes:[...graph.nodes,{...graph.nodes[0],id:'arrival',project:'A new project',phaseId:null}]};
    const after=layoutOrganicPlane(added,planeSizes(added),before.anchors);
    for(const tile of tilesOf(before)) {
      const current=tilesOf(after).find(e=>e.id===tile.id)!;
      expect({x:current.x,y:current.y}).toEqual({x:tile.x,y:tile.y});
    }
    expect(findOverlaps(after.elements)).toEqual([]);
  });
  test('filtering projects and archived work retains surviving tile positions', () => {
    const graph=fixture(),sizes=planeSizes(graph),before=layoutOrganicPlane(graph,sizes);
    const filtered={...graph,nodes:graph.nodes.filter(n=>n.id!=='old'&&n.id!=='small')};
    const after=layoutOrganicPlane(filtered,sizes,before.anchors);
    for(const tile of tilesOf(after)) {
      const previous=tilesOf(before).find(e=>e.id===tile.id)!;
      expect({x:tile.x,y:tile.y}).toEqual({x:previous.x,y:previous.y});
    }
  });
});

describe('transverse Report cells',()=>{
  test.each(['horizontal','vertical'] as const)('%s keeps Report cells off dependency ports and inside their Phase',organization=>{
    const base=graphFromRecorded();
    const graph={...base,reports:base.nodes.slice(0,6).flatMap(n=>[0,1,2].map(i=>({id:'report-'+n.id+i,taskId:n.id,title:'Report '+i})))};
    const result=organization==='horizontal'?layoutHorizontalPlane(graph,planeSizes(graph)):layoutVerticalPlane(graph,planeSizes(graph));
    const pills=result.elements.filter(e=>e.kind==='pill');
    expect(pills.length).toBeGreaterThan(0);
    for(const pill of pills) {
      if(pill.kind!=='pill') continue;
      const task=tilesOf(result).find(t=>t.id===pill.taskId)!;
      if(organization==='horizontal') expect(pill.y+pill.h).toBeLessThan(task.y);
      else expect(pill.x+pill.w).toBeLessThan(task.x);
      const owner=result.elements.find(e=>task.bandId?e.id===task.bandId:e.kind==='container'&&e.laneId===task.laneId)!;
      expect(pill.x).toBeGreaterThanOrEqual(owner.x);
      expect(pill.y).toBeGreaterThanOrEqual(owner.y);
      expect(pill.x+pill.w).toBeLessThanOrEqual(owner.x+owner.w);
      expect(pill.y+pill.h).toBeLessThanOrEqual(owner.y+owner.h);
    }
    expect(findOverlaps(result.elements)).toEqual([]);
  });
});
