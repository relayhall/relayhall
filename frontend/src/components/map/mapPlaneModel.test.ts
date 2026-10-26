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

import { readFileSync } from "node:fs";
const mapCss = readFileSync(new URL("./MapView.css", import.meta.url), "utf8");
const taskCss = readFileSync(new URL("../tasks/TaskCard.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("../../styles/variables.css", import.meta.url), "utf8");

import recorded from './__fixtures__/graph.task.json';
import {
  FALLBACK_TILE,
  computeDepths,
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
  PLANE_CARD_PX,
  PLANE_METRICS,
  assignSlots,
  cardFits,
  containerAlpha,
  layoutContinuousPlane,
  layoutHorizontalPlane,
  layoutVerticalPlane,
  layoutRadialPlane,
  layoutOrganicPlane,
  ORGANIC_CORE,
  organicPlaneGraph,
  pillGrid,
  planeFade,
  planeDetailBand,
  planeContentBounds,
  projectPlaneAttention,
  planeSegments,
  type MapPlaneAnchors,
} from './mapPlaneModel';
import { planeFitScale } from './useMapViewState';

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

  test('task geography remains visible independently of container captions', () => {
    for (const scale of scales) {
      const fade = planeFade(result.elements, scale);
      for (const tile of tilesOf(result)) {
        const phase = tile.bandId ? (fade.phase.get(tile.bandId) ?? 0) : 0;
        const project = fade.project.get(`container:${tile.laneId}`) ?? 0;
        const task = fade.task.get(tile.id) ?? 0;
        expect(phase + project).toBeLessThanOrEqual(1);
        expect(task).toBeGreaterThanOrEqual(0);
        expect(task).toBeLessThanOrEqual(1);
        if (Math.min(tile.w, tile.h) * scale >= 10) expect(task).toBe(1);
        if (Math.min(tile.w, tile.h) * scale <= 4) expect(task).toBe(0);
      }
    }
  });

  test('only genuinely tiny tasks disappear while containers retain context', () => {
    // Every task is below four screen pixels on its short side.
    const scale = 3 / Math.max(...tilesOf(result).map(tile => Math.min(tile.w, tile.h)));
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

  test('(a) a task ARRIVES and no card already placed in its phase moves; nothing moves up or left', () => {
    // E386: there is no reserved headroom any more, so an arrival that adds
    // a row may translate what lies below or beyond it — but never a card
    // already standing in its own phase, and never up or left.
    const { anchors, before, result } = baseline();
    const churned: MapGraph = {
      ...graph,
      nodes: [...graph.nodes, ...addedNodes(graph, 2, phased.project, phased.phaseId)],
    };
    const after = positionsOf(layoutHorizontalPlane(churned, planeSizes(churned), anchors));
    const ownBand = `band:${phased.project}:${phased.phaseId}`;
    const inOwnBand = new Set(tilesOf(result).filter(tile => tile.bandId === ownBand).map(tile => tile.id));
    expect(inOwnBand.size).toBeGreaterThan(0);
    expect(movedIds(before, after, id => inOwnBand.has(id))).toEqual([]);
    for (const [id, from] of before) {
      const to = after.get(id);
      if (!to) continue;
      expect(to.x, id).toBeGreaterThanOrEqual(from.x - TOLERANCE_PX);
      expect(to.y, id).toBeGreaterThanOrEqual(from.y - TOLERANCE_PX);
    }
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

  test('(b) tasks LEAVE: their ground is given back and the survivors keep their order (E386)', () => {
    const { anchors, result } = baseline();
    const gone = departures();
    const churned: MapGraph = { ...graph, nodes: graph.nodes.filter(n => !gone.has(n.id)) };
    const next = layoutHorizontalPlane(churned, planeSizes(churned), anchors);
    // No area grew, and the plane did not.
    const bandBefore = new Map(bandsOf(result).map(band => [band.id, band]));
    for (const band of bandsOf(next)) {
      const was = bandBefore.get(band.id)!;
      expect(band.w * band.h, band.id).toBeLessThanOrEqual(was.w * was.h);
    }
    expect(next.height).toBeLessThanOrEqual(result.height);
    // Inside every phase the survivors stand in the same reading order:
    // column by column, top to bottom.
    const order = (layout: LayoutResult, band: string) => tilesOf(layout)
      .filter(tile => tile.bandId === band && !gone.has(tile.id))
      .sort((a, b) => a.x - b.x || a.y - b.y).map(tile => tile.id);
    for (const band of bandsOf(next)) expect(order(next, band.id), band.id).toEqual(order(result, band.id));
  });

  test('(b) CONTROL: the pre-amendment engine closes the hole and shuffles', () => {
    const before = positionsOf(layoutHorizontal(graph, planeSizes(graph)));
    const gone = departures();
    const churned: MapGraph = { ...graph, nodes: graph.nodes.filter(n => !gone.has(n.id)) };
    const after = positionsOf(layoutHorizontal(churned, planeSizes(churned)));
    expect(movedIds(before, after, id => !gone.has(id)).length).toBeGreaterThan(0);
  });

  test('(b) the hole a departure leaves is CLOSED, and the next arrival goes to the frontier (E386)', () => {
    // A phase of three same-rank tasks in one column. The middle one leaves:
    // the third closes up into its row, and the phase is one row shorter.
    const template = templateNode(graph);
    const node = (id: string, minute: number): MapTaskNode => ({ ...template, id, title: id,
      project: 'Hole', phaseId: 'hole-phase', status: 'todo', agent: null,
      updated: `2026-10-20T07:0${minute}:00.000Z` } as MapTaskNode);
    const phases: MapPhase[] = [{ id: 'hole-phase', name: 'Hole', goal: null, projectId: 'hole', position: 0 }];
    const three: MapGraph = { nodes: [node('first', 1), node('middle', 2), node('third', 3)], edges: [], phases };
    const full = layoutHorizontalPlane(three, {}, EMPTY_PLANE_ANCHORS);
    const at = (layout: LayoutResult, id: string) => positionsOf(layout).get(id)!;
    const removed: MapGraph = { ...three, nodes: three.nodes.filter(n => n.id !== 'middle') };
    const step = layoutHorizontalPlane(removed, {}, full.anchors);
    expect(at(step, 'first')).toEqual(at(full, 'first'));
    expect(at(step, 'third')).toEqual(at(full, 'middle'));
    expect(bandsOf(step)[0].h).toBe(bandsOf(full)[0].h - PLANE_METRICS.tileCellH - 16);
    // The next arrival does not reopen the closed hole: it stands below.
    const arrival: MapGraph = { ...removed, nodes: [...removed.nodes, node('fill', 4)] };
    const filled = layoutHorizontalPlane(arrival, {}, step.anchors);
    expect(at(filled, 'first')).toEqual(at(step, 'first'));
    expect(at(filled, 'third')).toEqual(at(step, 'third'));
    expect(at(filled, 'fill')).toEqual(at(full, 'third'));
  });

  test('(c) a task MOVES phase: it travels; other projects move only as whole lanes, vertically', () => {
    const { anchors, before, index } = baseline();
    const target = graph.phases.find(p => p.id !== phased.phaseId)!;
    const churned: MapGraph = {
      ...graph,
      nodes: graph.nodes.map(node =>
        node.id === phased.id ? { ...node, phaseId: target.id } : node),
    };
    const after = positionsOf(layoutHorizontalPlane(churned, planeSizes(churned), anchors));
    const byLane = displacementsByLane(before, after, index);
    for (const [lane, set] of byLane) {
      if (lane === phased.project) continue;
      expect(set.size, lane).toBe(1);
      expect([...set][0].startsWith('0,'), lane).toBe(true);
    }
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
    const restored = JSON.parse(JSON.stringify(first.anchors)) as MapPlaneAnchors;
    // The record as it crosses the worker boundary (a structured clone), the
    // graph arriving in wire order: the same world. (E386: nothing is
    // persisted; the parser that read a stored record is gone.)
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

  test('nothing outside a departure\'s own phase moves UP or LEFT under churn (E386)', () => {
    // The direction rule behind clause 6: the world grows at its frontier.
    // E386 (round-2 repair, by name): a departure CLOSES its hole, so the
    // cards after it in its own phase close up — in their reading order —
    // even when arrivals land in the same update. The arrivals go to the
    // frontier; nothing else moves up or left.
    const { anchors, before, result } = baseline();
    const ownBand = `band:${phased.project}:${phased.phaseId}`;
    const inOwnBand = new Set(tilesOf(result).filter(tile => tile.bandId === ownBand).map(tile => tile.id));
    const churned: MapGraph = {
      ...graph,
      nodes: [
        ...graph.nodes.filter(n => n.id !== phased.id),
        ...addedNodes(graph, 9, phased.project, phased.phaseId, 'grow'),
        ...addedNodes(graph, 2, 'Zed New Project', null, 'zed'),
      ],
    };
    const next = layoutHorizontalPlane(churned, planeSizes(churned), anchors);
    const after = positionsOf(next);
    for (const [id, from] of before) {
      const to = after.get(id);
      if (!to || inOwnBand.has(id)) continue;
      expect(to.x, id).toBeGreaterThanOrEqual(from.x - TOLERANCE_PX);
      expect(to.y, id).toBeGreaterThanOrEqual(from.y - TOLERANCE_PX);
    }
    const reading = (layout: LayoutResult) => tilesOf(layout)
      .filter(tile => inOwnBand.has(tile.id) && tile.id !== phased.id)
      .sort((a, b) => a.x - b.x || a.y - b.y).map(tile => tile.id);
    expect(reading(next)).toEqual(reading(result));
  });
});

describe('anchor persistence', () => {
  const graph = graphFromRecorded();

  // E386 retired persistence, and with it the parser that read a stored
  // record ('a corrupt, foreign or partial record falls back rather than
  // throwing'; 'a rejected record still lays the plane out'): no stored
  // record is ever read, so there is nothing to parse or reject.

  test('anchors for absent tasks are DROPPED — a filter shows less, and fits it (E386)', () => {
    const sizes = planeSizes(graph);
    const full = layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
    const filtered: MapGraph = { ...graph, nodes: graph.nodes.filter(n => n.status !== 'completed') };
    expect(filtered.nodes.length).toBeLessThan(graph.nodes.length);
    const scoped = layoutHorizontalPlane(filtered, planeSizes(filtered), full.anchors);
    // The record carries exactly what is shown: nothing for the hidden tasks.
    expect(Object.keys(scoped.anchors.slots).sort()).toEqual(filtered.nodes.map(n => n.id).sort());
    expect(scoped.height).toBeLessThanOrEqual(full.height);
    // Lifting the filter places the hidden tasks again, without overlap, and
    // the plane is once more the size of the full scope.
    const lifted = layoutHorizontalPlane(graph, sizes, scoped.anchors);
    expect(tilesOf(lifted)).toHaveLength(graph.nodes.length);
    expect(findOverlaps(lifted.elements)).toEqual([]);
  });

  test('the record holds no ground: every reservation comes back empty (E386)', () => {
    const result = layoutHorizontalPlane(graph, planeSizes(graph), {
      ...EMPTY_PLANE_ANCHORS, laneHeight: { Ghost: 9000 }, cols: { g: [9000] }, rows: { g: [9000] },
      segWidth: { g: 9000 }, laneHeaderW: { Ghost: 900 } } as MapPlaneAnchors);
    for (const retired of ['laneHeight', 'cols', 'rows', 'segWidth', 'laneHeaderW']) {
      expect((result.anchors as unknown as Record<string, unknown>)[retired], retired).toBeUndefined();
    }
    expect(positionsOf(result)).toEqual(positionsOf(layoutHorizontalPlane(graph, planeSizes(graph), EMPTY_PLANE_ANCHORS)));
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

  /**
   * The minimum of interleaved samples per size.
   *
   * DEV CI run 5493 (Report 41475352) failed the ratio below at 49.84: in ONE
   * sample 1,000 tasks took 19.5ms and 8,000 took 972.7ms, while the 5,000
   * task layout in the same process took 147.5ms and four other runs at the
   * same Map bytes (5494, 5609, 5614 and the TST run) measured 6.58 to 7.70.
   * A single wall-clock sample cannot tell a quadratic pass from a runner
   * that stalled for most of a second — the backend job records the same
   * class (CI run 1031). A stall only ever ADDS time, so the minimum of a
   * few samples is the cost the code itself imposes; a genuinely quadratic
   * pass is slow in every sample and still fails. The bound is unchanged.
   */
  const minimumLayout = (graphs: readonly MapGraph[], samples = 5) => {
    const prepared = graphs.map(graph => ({ graph, sizes: planeSizes(graph) }));
    for (const { graph, sizes } of prepared) layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
    const best = prepared.map(() => Infinity);
    const all = prepared.map(() => [] as number[]);
    for (let sample = 0; sample < samples; sample += 1) {
      prepared.forEach(({ graph, sizes }, index) => {
        const started = performance.now();
        layoutHorizontalPlane(graph, sizes, EMPTY_PLANE_ANCHORS);
        const spent = performance.now() - started;
        all[index].push(spent);
        best[index] = Math.min(best[index], spent);
      });
    }
    return { best, all };
  };

  test('cost grows LINEARLY, not quadratically, with the estate', () => {
    const { best: [small, large], all } = minimumLayout([syntheticGraph(1000), syntheticGraph(8000)]);
    // eslint-disable-next-line no-console
    console.log(`[A7c perf] 1000: ${small.toFixed(1)}ms  8000: ${large.toFixed(1)}ms`
      + `  ratio ${(large / Math.max(0.01, small)).toFixed(2)} (8x data, minimum of`
      + ` ${all[0].map(v => v.toFixed(1)).join('/')} and ${all[1].map(v => v.toFixed(1)).join('/')})`);
    // Eight times the data. Linear predicts ~8; quadratic predicts ~64. The
    // bound is generous enough that a loaded CI box cannot fail it, and tight
    // enough that a quadratic pass cannot pass it.
    if (small > 2) {
      expect(large / small).toBeLessThan(24);
    }
    expect(large).toBeLessThan(6000);
  });

  test('cost grows linearly at production shape, Report grids and shelves included', () => {
    // The 283-task production-shaped project (card 31454392), one copy
    // against eight: every copy is its own wrapped lane with its own grids.
    const estate = (copies: number): MapGraph => {
      const parts = Array.from({ length: copies }, (_, i) => productionShape(true, `Production ${i}`));
      return { nodes: parts.flatMap(p => p.nodes), edges: parts.flatMap(p => p.edges),
        phases: parts.flatMap(p => p.phases), reports: parts.flatMap(p => p.reports!) };
    };
    const { best: [small, large], all } = minimumLayout([estate(1), estate(8)]);
    // eslint-disable-next-line no-console
    console.log(`[31454392 perf] 283: ${small.toFixed(1)}ms  2264: ${large.toFixed(1)}ms`
      + `  ratio ${(large / Math.max(0.01, small)).toFixed(2)} (8x data, minimum of`
      + ` ${all[0].map(v => v.toFixed(1)).join('/')} and ${all[1].map(v => v.toFixed(1)).join('/')})`);
    if (small > 2) {
      expect(large / small).toBeLessThan(24);
    }
    expect(large).toBeLessThan(6000);
  });
});

describe('metrics are derived, not invented', () => {
  test('no headroom is reserved: a lane takes the depth it paints (E386)', () => {
    expect('laneHeadroomRows' in PLANE_METRICS).toBe(false);
    expect('laneHeadroomRatio' in PLANE_METRICS).toBe(false);
    const graph = graphFromRecorded();
    const containers = containersOf(layoutHorizontalPlane(graph, planeSizes(graph)))
      .sort((a, b) => a.y - b.y);
    expect(containers.length).toBeGreaterThan(1);
    for (let i = 1; i < containers.length; i += 1) {
      // The lane gap less the two 16-unit container margins, plus at most the
      // 8-unit rhythm the lane depth rounds up to — and no headroom at all.
      const gap = containers[i].y - (containers[i - 1].y + containers[i - 1].h);
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(gap).toBeLessThan(8 + PLANE_METRICS.laneQuantumY);
    }
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
describe('round-1 finding 1, superseded by E386 — a filter shows less, and the plane fits it', () => {
  const graph = graphFromRecorded();

  test('emptying the FIRST phase of a lane: it is not drawn, and the second takes its ground (E386)', () => {
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
    const fresh = layoutHorizontalPlane(filtered, planeSizes(filtered), EMPTY_PLANE_ANCHORS);

    expect(bandsOf(after).map(band => band.label)).toEqual(['Two']);
    expect(positionsOf(after)).toEqual(positionsOf(fresh));
    // Lifting the filter puts One back where it was, in declared order.
    const lifted = layoutHorizontalPlane(full, planeSizes(full), after.anchors);
    expect(positionsOf(lifted)).toEqual(positionsOf(first));
  });

  test('a project filtered out takes no ground, and coming back does not reorder (E386)', () => {
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'a1', project: 'A', phaseId: null },
      { ...templateNode(graph), id: 'b1', project: 'B', phaseId: null },
    ];
    const full = { nodes, edges: [], phases: [] } as MapGraph;
    const first = layoutHorizontalPlane(full, planeSizes(full), EMPTY_PLANE_ANCHORS);
    expect(first.anchors.laneOrder).toEqual(['A', 'B']);

    const withoutA = { ...full, nodes: nodes.filter(node => node.project !== 'A') };
    const scoped = layoutHorizontalPlane(withoutA, planeSizes(withoutA), first.anchors);
    // B takes the ground A no longer needs: the plane fits what is shown.
    const alone = layoutHorizontalPlane(withoutA, planeSizes(withoutA), EMPTY_PLANE_ANCHORS);
    expect(positionsOf(scoped)).toEqual(positionsOf(alone));
    // The ORDER is remembered for the session, so nothing is drawn for A...
    expect(scoped.anchors.laneOrder).toEqual(['A', 'B']);
    expect(tilesOf(scoped).map(tile => tile.id)).toEqual(['b1']);
    expect(containersOf(scoped).map(container => container.laneId)).toEqual(['B']);

    // ...and A comes back above B, exactly where it was.
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

    // E386: the hidden connector's row closes, so `keep` may rise; what the
    // narrower header must not do is pull the lane's work LEFT.
    const xOf = (layout: LayoutResult) => tilesOf(layout).find(tile => tile.id === 'keep')!.x;
    expect(xOf(after)).toBe(xOf(first));
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
    // E386: the record holds no header width; the column is declared.
    expect(Object.keys(after.anchors).sort()).toEqual(['laneOrder', 'segOrder', 'slots', 'version']);
    // ROUND 2, AT THE CLASS. This used to end by asserting that a header
    // measuring 300 took 300 of ground — "under-reserving is the worse
    // failure". It is not: a reservation that reads the size map is a
    // reservation the FILTER can move, because the size map holds what has
    // been mounted rather than what exists. The measured box no longer
    // reaches the lattice at all, in either direction.
    const wider = { ...planeSizes(full), 'lane:P': { w: 300, h: 300 } };
    const grown = layoutHorizontalPlane(full, wider, after.anchors);
    expect(Object.keys(grown.anchors).sort()).toEqual(['laneOrder', 'segOrder', 'slots', 'version']);
    expect(movedIds(positionsOf(after), positionsOf(grown))).toEqual([]);
    expect(movedIds(positionsOf(layoutHorizontalPlane(full, planeSizes(full), after.anchors)),
      positionsOf(grown))).toEqual([]);
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
    expect(after.anchors).toEqual(first.anchors);
  });

  test('(b) FILTER: narrowing the scope while measurements arrive moves nothing the filter did not', () => {
    // The live shape: the reader applies a status filter, the mounted set
    // changes, and boxes that had never been measured are measured now.
    // E386: the filter itself closes the hole it leaves (`a2` rises into
    // `a1`'s row); the late measurements must move NOTHING beyond that.
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
    const unmeasured = layoutHorizontalPlane(kept, partial, first.anchors);

    expect(positionsOf(after)).toEqual(positionsOf(unmeasured));
    expect(movedIds(positionsOf(first), positionsOf(after))).toEqual(['a2']);
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
    const restored = JSON.parse(JSON.stringify(first.anchors)) as MapPlaneAnchors;
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
    expect(after.anchors).toEqual(first.anchors);

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

describe('round-1 finding 6, superseded by E386 — a phase with no shown task is not displayed', () => {
  const graph = graphFromRecorded();

  test('an empty declared phase is not a segment, and takes no ground', () => {
    const phases: MapPhase[] = [
      { id: 'p-empty', name: 'Empty', goal: null, projectId: 'proj', position: 0 },
      { id: 'p-used', name: 'Used', goal: null, projectId: 'proj', position: 1 },
    ];
    const nodes: MapTaskNode[] = [
      { ...templateNode(graph), id: 'only', project: 'P', phaseId: 'p-used' },
    ];
    const segments = planeSegments(nodes, phases, new Map([['only', 0]]));
    expect(segments.map(segment => segment.key)).toEqual(['phase:p-used']);

    const local = { nodes, edges: [], phases } as MapGraph;
    const result = layoutHorizontalPlane(local, planeSizes(local));
    expect(bandsOf(result).map(band => band.label)).toEqual(['Used']);
    expect(result.elements.filter(element => element.id.includes('p-empty'))).toEqual([]);
    const alone = layoutHorizontalPlane({ ...local, phases: [phases[1]] }, planeSizes(local));
    expect(positionsOf(result)).toEqual(positionsOf(alone));
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
      { ...templateNode(graph), id: 'n3', project: 'X', phaseId: 'x2' },
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

describe('E386 retired the cap: the record carries only what is shown', () => {
  test('slots exist for the shown tasks and nothing else, whatever the record held', () => {
    const graph = graphFromRecorded();
    const ghosts: Record<string, { seg: string; col: number; row: number }> = {};
    for (let i = 0; i < 5000; i += 1) ghosts[`ghost-${i}`] = { seg: `lane\u0000phase:p${i % 7}`, col: 0, row: i };
    const result = layoutHorizontalPlane(graph, planeSizes(graph), { ...EMPTY_PLANE_ANCHORS, slots: ghosts });
    expect(Object.keys(result.anchors.slots).sort()).toEqual(graph.nodes.map(node => node.id).sort());
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
  test.each([[192, 'full'], [191.99, 'compact'], [136, 'compact'], [135.99, 'aggregate'],
    [96, 'aggregate'], [95.99, 'silhouette']] as const)('%s CSS pixels selects %s', (width, band) => {
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
    expect(layoutOrganicPlane(graph,planeSizes(graph),JSON.parse(JSON.stringify(layout.anchors)) as MapPlaneAnchors)).toEqual(layout);
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
  // E386 round 2 (review B2), superseding by name 'adding a project preserves
  // the inhabited world origin and existing tasks' and 'filtering projects and
  // archived work retains surviving tile positions': Organic keeps no home,
  // cell, angle or core from one layout to the next, because a region that
  // kept the ground it held while the archive was shown would never shrink
  // back. The world is laid out from what is shown, and going back to a
  // scope gives back that scope's world exactly.
  test('adding a project lays the Organic world out for the new scope; removing it gives the old one back (E386)', () => {
    const graph=fixture(),sizes=planeSizes(graph),before=layoutOrganicPlane(graph,sizes);
    const added={...graph,nodes:[...graph.nodes,{...graph.nodes[0],id:'arrival',project:'A new project',phaseId:null}]};
    const after=layoutOrganicPlane(added,planeSizes(added),before.anchors);
    expect(after.organicRegions).toEqual(layoutOrganicPlane(added,planeSizes(added)).organicRegions);
    expect(findOverlaps(after.elements)).toEqual([]);
    const back=layoutOrganicPlane(graph,sizes,after.anchors);
    expect(positionsOf(back)).toEqual(positionsOf(before));
    expect(back.organicRegions).toEqual(before.organicRegions);
  });
  test('filtering projects and archived work fits the Organic world to what is left, and lifting it returns the world (E386)', () => {
    const graph=fixture(),sizes=planeSizes(graph),before=layoutOrganicPlane(graph,sizes);
    const filtered={...graph,nodes:graph.nodes.filter(n=>n.id!=='old'&&n.id!=='small')};
    const after=layoutOrganicPlane(filtered,sizes,before.anchors);
    const fresh=layoutOrganicPlane(filtered,sizes);
    expect(positionsOf(after)).toEqual(positionsOf(fresh));
    expect(after.organicRegions).toEqual(fresh.organicRegions);
    // The core is back to its empty size, and the project region with it.
    const core=(layout:typeof before)=>layout.organicRegions!.find(r=>r.core)!.box;
    expect(core(after).w).toBeLessThanOrEqual(core(before).w);
    const lifted=layoutOrganicPlane(graph,sizes,after.anchors);
    expect(positionsOf(lifted)).toEqual(positionsOf(before));
    expect(lifted.organicRegions).toEqual(before.organicRegions);
  });
});

describe('navigation density and readable overview', () => {
  const phase = { id: 'dense', projectId: 'dense-project', name: 'Delivery', goal: null, position: 0 };
  const nodes = Array.from({ length: 65 }, (_, i) => ({ ...graphFromRecorded().nodes[0],
    id: `dense-${i}`, project: 'Dense project', phaseId: phase.id, updated: '2026-09-24T00:00:00.000Z' }));
  const graph: MapGraph = { nodes, phases: [phase], edges: [
    ...nodes.slice(0, 64).map(node => ({ from: nodes[64].id, to: node.id, kind: 'dependency' as const })),
  ] };

  test.each(['horizontal', 'vertical'] as const)('%s wraps independent work while preserving dependency order and non-overlap', organization => {
    const result = organization === 'horizontal' ? layoutHorizontalPlane(graph, planeSizes(graph))
      : layoutVerticalPlane(graph, planeSizes(graph));
    const tiles = tilesOf(result);
    const downstream = tiles.find(t => t.id === nodes[64].id)!;
    const upstream = tiles.filter(t => t !== downstream);
    expect(findOverlaps(result.elements)).toEqual([]);
    if (organization === 'horizontal') {
      expect(Math.max(...upstream.map(t => t.x + t.w))).toBeLessThan(downstream.x);
      expect(planeContentBounds(result.elements).h).toBeLessThan(2000);
    } else {
      expect(Math.max(...upstream.map(t => t.y + t.h))).toBeLessThan(downstream.y);
      expect(planeContentBounds(result.elements).w).toBeLessThan(2000);
    }
    expect(new Set(upstream.map(t => organization === 'horizontal' ? t.y : t.x)).size).toBe(8);
  });

  test('Fit sees only shown work: a remembered hidden project takes no ground (E386)', () => {
    const anchors = { ...EMPTY_PLANE_ANCHORS,
      laneOrder: ['Hidden project'], laneHeight: { 'Hidden project': 100_000 } } as MapPlaneAnchors;
    const result = layoutHorizontalPlane(graph, planeSizes(graph), anchors);
    const bounds = planeContentBounds(result.elements);
    expect(result.height).toBeLessThan(2000);
    expect(bounds.h).toBeLessThan(2000);
    expect(positionsOf(result)).toEqual(positionsOf(layoutHorizontalPlane(graph, planeSizes(graph))));
    expect(layoutHorizontalPlane(graph, {}, result.anchors).anchors.slots).toEqual(result.anchors.slots);
  });

  test('phase summaries coexist with task silhouettes through successive zoom steps', () => {
    const layout = layoutHorizontalPlane(graph, {});
    const tile = tilesOf(layout)[0];
    for (const scale of [0.30, 0.375, 0.46875, 0.5859375, 0.65]) {
      const fade = planeFade(layout.elements, scale);
      expect(fade.phase.get(tile.bandId!)).toBeGreaterThan(0.5);
      expect(fade.task.get(tile.id)).toBe(1);
    }
    expect(planeFade(layout.elements, 0.8).task.get(tile.id)).toBe(1);
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

// Synthetic acceptance-scale estate, using the recorded task row and the
// maintained Report linkage shape. Author-only model evidence, not browser
// rendering or smoothness evidence.
describe('Map integration: 248 tasks, ten phases and linked Reports', () => {
  const phases = Array.from({ length: 10 }, (_, index) => ({
    id: 'integration-phase-' + index, name: 'Stage ' + index, goal: null,
    projectId: 'integration-project', position: index,
  }));
  const nodes = Array.from({ length: 248 }, (_, index) => ({
    ...graphFromRecorded().nodes[0], id: 'integration-task-' + index,
    title: 'Integration work ' + index, status: 'todo', agent: null,
    project: 'Integration project', phaseId: phases[index % 10].id,
    updated: '2026-09-24T00:00:00.000Z',
  }));
  const graph: MapGraph = { nodes, phases,
    edges: nodes.slice(10).map((node, index) => ({
      from: node.id, to: nodes[index].id, kind: 'dependency' as const,
    })),
    reports: nodes.map(node => ({ id: 'report-' + node.id, taskId: node.id, title: 'Linked evidence' })),
  };

  test.each([
    ['horizontal', layoutHorizontalPlane],
    ['vertical', layoutVerticalPlane],
    ['organic', layoutOrganicPlane],
  ] as const)('%s preserves all work, phase counts, Report cells and anchored geometry', (_name, place) => {
    const sizes = planeSizes(graph);
    const result = place(graph, sizes);
    expect(tilesOf(result)).toHaveLength(248);
    expect(bandsOf(result)).toHaveLength(10);
    expect(result.elements.filter(element => element.kind === 'pill')).toHaveLength(248);
    expect(findOverlaps(result.elements)).toEqual([]);
    for (const phase of phases) {
      const member = tilesOf(result).find(tile => tile.node.phaseId === phase.id)!;
      const band = bandsOf(result).find(element => element.id === member.bandId)!;
      expect(band).toBeDefined();
      expect(band.facts?.taskCount).toBe(nodes.filter(node => node.phaseId === phase.id).length);
    }
    const before = JSON.stringify(result.elements);
    for (const scale of [0.05, 0.30, 0.375, 0.46875, 0.5859375, 0.65, 0.8, 1.2]) {
      const fade = planeFade(result.elements, scale);
      expect(fade.task.size).toBe(248);
      expect(JSON.stringify(result.elements)).toBe(before);
    }
    const again = place(graph, sizes, result.anchors);
    expect(positionsOf(again)).toEqual(positionsOf(result));
    expect(planeContentBounds(again.elements)).toEqual(planeContentBounds(result.elements));
  });
});

// CARD 31454392 — the Map at Fit for a production-shaped project.
//
// PRODUCTION SHAPE: the RelayHall project as the Map's graph read returned it
// on 2026-10-08 — 223 active tasks in five phases, 74 dependency edges and
// 1,938 Report links — anonymized to positions. Each phase lists the Report
// count of each of its tasks; the edges index the tasks in that order. Before
// this card it laid out 133,552 x 2,112 (Horizontal) and 2,448 x 71,832
// (Vertical): at Fit a task was under one pixel tall. The owner's walkthrough
// saw 283 tasks; `extended` adds five phases of twelve at the same edge
// density (one dependency per three tasks) with light Report links, to the
// ~280-task, ten-phase scale the card names.
const PRODUCTION_REPORTS: ReadonlyArray<readonly [number, string]> = [
  [10, '782 11 6 3 0 13 11 2 51'],
  [11, '115 74 50 30 17 13 7 4 1 1 1 1 0 0 0 0 0 0 30 35 1 1'],
  [12, '19 1 0 0 10 0 10 0'],
  [13, '52 35 3 3 3 2 2 2 2 2 2 2 2 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 '
    + '1 1 1 1 1 1 1 1 1 1 1 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 '
    + '0 7 2 2 1 1 1 0 0 9 4 4 4'],
  [14, '45 37 25 22 21 18 17 15 13 13 12 8 7 6 5 5 4 4 4 3 3 3 3 3 2 2 2 1 1 1 1 1 1 1 1 1 1 1 1 0 0 0 0 '
    + '0 0 0 0 0 0 0 0 0 0 0 0 7 7 6 4 0 26 4 4 4 4 3 11 4 4 4 4 7 4 8 7 7'],
];
const PRODUCTION_EDGES = [5,171,6,10,6,11,6,12,6,27,6,28,6,31,6,35,6,37,7,6,8,7,8,27,8,28,27,18,28,27,29,
  28,30,28,35,31,35,34,36,33,37,31,37,36,38,36,135,39,135,160,136,40,137,40,138,40,139,61,140,90,141,75,
  142,75,143,135,144,159,144,204,145,144,145,209,145,210,146,208,202,148,203,9,204,153,205,161,206,17,
  207,150,207,204,208,204,209,159,209,204,210,159,210,204,211,205,212,203,213,147,213,150,213,204,213,
  207,214,204,214,211,215,214,216,146,217,145,218,213,218,215,218,216,218,217,219,172,219,213,219,215,
  219,216,219,217,220,218,221,220,222,221];
const EXTENDED_REPORTS = [0, 1, 1, 2, 0, 1, 4, 1, 0, 3, 1, 7];

const productionShape = (extended = false, project = 'Production project'): MapGraph => {
  const phases: MapPhase[] = [];
  const nodes: MapTaskNode[] = [];
  const reports: Array<{ id: string; taskId: string; title: string }> = [];
  const edges: MapEdge[] = [];
  const add = (position: number, counts: readonly number[]) => {
    const id = `${project}:stage-${position}`;
    phases.push({ id, name: `Stage ${position}`, goal: null, projectId: project, position });
    for (const count of counts) {
      const taskId = `${project}:task-${String(nodes.length).padStart(3, '0')}`;
      nodes.push({ ...graphFromRecorded().nodes[0], id: taskId, title: taskId, status: 'todo',
        agent: null, project, phaseId: id, updated: '2026-10-08T00:00:00.000Z' });
      for (let r = 0; r < count; r += 1) {
        reports.push({ id: `${taskId}:report-${String(r).padStart(3, '0')}`, taskId, title: 'Linked evidence' });
      }
    }
  };
  for (const [position, counts] of PRODUCTION_REPORTS) add(position, counts.trim().split(/\s+/).map(Number));
  for (let i = 0; i < PRODUCTION_EDGES.length; i += 2) {
    edges.push({ from: nodes[PRODUCTION_EDGES[i]].id, to: nodes[PRODUCTION_EDGES[i + 1]].id, kind: 'dependency' });
  }
  if (extended) {
    for (let position = 15; position < 20; position += 1) {
      const first = nodes.length;
      add(position, EXTENDED_REPORTS);
      for (let j = 2; j < EXTENDED_REPORTS.length; j += 3) {
        edges.push({ from: nodes[first + j].id, to: nodes[first + j - 1].id, kind: 'dependency' });
      }
    }
  }
  return { nodes, phases, edges, reports };
};

/** The task's short side on screen at Fit in the planner's declared canvas. */
const fitTilePx = (result: LayoutResult) => {
  const bounds = planeContentBounds(result.elements);
  const scale = planeFitScale({ width: bounds.w, height: bounds.h },
    { width: PLANE_METRICS.shelfViewW, height: PLANE_METRICS.shelfViewH });
  return { bounds, scale, px: FALLBACK_TILE.h * scale,
    aspect: Math.max(bounds.w, bounds.h) / Math.min(bounds.w, bounds.h) };
};

describe('Report cells wrap into a bounded grid (card 31454392)', () => {
  test('a strip keeps its shape up to pillStripMin cells, then folds toward a square', () => {
    const h = [PLANE_METRICS.pillReserveW + 4, PLANE_METRICS.pillReserveH + 8] as const;
    const v = [PLANE_METRICS.pillReserveH + 4, PLANE_METRICS.pillReserveW + 8] as const;
    expect(pillGrid(0, ...h)).toEqual({ perStrip: 0, strips: 0 });
    for (let n = 1; n <= PLANE_METRICS.pillStripMin; n += 1) expect(pillGrid(n, ...h)).toEqual({ perStrip: n, strips: 1 });
    expect(pillGrid(5, ...h)).toEqual({ perStrip: 4, strips: 2 });
    // The production task with 782 Reports: 21 x 38 cells (2,096 x 2,128
    // units) instead of one 78,196-unit strip.
    expect(pillGrid(782, ...h)).toEqual({ perStrip: 21, strips: 38 });
    expect(pillGrid(782, ...v)).toEqual({ perStrip: 40, strips: 20 });
    for (const n of [1, 5, 13, 52, 115, 782]) {
      const { perStrip, strips } = pillGrid(n, ...h);
      expect(perStrip * strips).toBeGreaterThanOrEqual(n);
      expect(perStrip * (strips - 1)).toBeLessThan(n);
    }
  });

  test.each(['horizontal', 'vertical'] as const)('%s keeps every cell of a heavily cited task inside its own column and off its neighbours', organization => {
    const base = productionShape();
    const heavy = base.nodes[0].id;
    expect(base.reports!.filter(r => r.taskId === heavy)).toHaveLength(782);
    const place = organization === 'horizontal' ? layoutHorizontalPlane : layoutVerticalPlane;
    const result = place(base, planeSizes(base));
    const tile = tilesOf(result).find(t => t.id === heavy)!;
    const pills = result.elements.filter(e => e.kind === 'pill' && e.taskId === heavy);
    expect(pills).toHaveLength(782);
    expect(result.elements.filter(e => e.kind === 'pill')).toHaveLength(1938);
    const block = { x: Math.min(...pills.map(p => p.x)), y: Math.min(...pills.map(p => p.y)),
      r: Math.max(...pills.map(p => p.x + p.w)), b: Math.max(...pills.map(p => p.y + p.h)) };
    if (organization === 'horizontal') {
      expect(block.b).toBeLessThan(tile.y);
      expect(block.r - block.x).toBeLessThanOrEqual(21 * (PLANE_METRICS.pillReserveW + 4));
    } else {
      expect(block.r).toBeLessThan(tile.x);
      expect(block.b - block.y).toBeLessThanOrEqual(40 * (PLANE_METRICS.pillReserveH + 4));
    }
    expect(findOverlaps(result.elements)).toEqual([]);
  });

  test('a record from the single-strip engine holds no ground: the grid is declared (E386)', () => {
    const graph: MapGraph = { ...productionShape(), nodes: productionShape().nodes.slice(0, 1),
      edges: [], reports: productionShape().reports!.slice(0, 782) };
    const seg = 'Production project\u0000phase:Production project:stage-10';
    // What the released engine wrote for this one task: a column of 782
    // single-strip cells (782 x 100 - 4) and the band's reserved width.
    const legacy = { ...EMPTY_PLANE_ANCHORS,
      laneOrder: ['Production project'], laneHeight: { 'Production project': 800 },
      cols: { [seg]: [78196] }, rows: { [seg]: [184] }, segWidth: { [seg]: 78244 },
      segOrder: { 'Production project': ['phase:Production project:stage-10'] },
      laneHeaderW: { 'Production project': 220 },
      slots: { [graph.nodes[0].id]: { seg, col: 0, row: 0 } } } as MapPlaneAnchors;
    const upgraded = layoutHorizontalPlane(graph, {}, legacy);
    expect(Object.keys(upgraded.anchors).sort()).toEqual(['laneOrder', 'segOrder', 'slots', 'version']);
    const fresh = layoutHorizontalPlane(graph, {});
    expect(positionsOf(upgraded)).toEqual(positionsOf(fresh));
    const band = bandsOf(upgraded)[0];
    // 21 cells of the folded grid, and the band's padding: 2096 + 2 x 24.
    expect(band.w).toBe(2144);
  });
});

describe('Fit shows task shapes at production shape (card 31454392)', () => {
  test('the anonymized production read keeps its recorded dependency structure', () => {
    const graph = productionShape();
    expect(graph.nodes).toHaveLength(223);
    expect(graph.phases).toHaveLength(5);
    expect(graph.edges).toHaveLength(74);
    expect(graph.reports).toHaveLength(1938);
    const depths = computeDepths(graph.nodes.map(n => n.id), graph.edges);
    const histogram: number[] = [];
    for (const depth of depths.values()) histogram[depth] = (histogram[depth] ?? 0) + 1;
    expect(histogram).toEqual([178, 17, 11, 7, 4, 3, 1, 1, 1]);
    const extended = productionShape(true);
    expect(extended.nodes).toHaveLength(283);
    expect(extended.phases).toHaveLength(10);
    expect(extended.edges.length / extended.nodes.length).toBeCloseTo(74 / 223, 1);
  });

  const integration248 = (): MapGraph => {
    const phases = Array.from({ length: 10 }, (_, index) => ({
      id: 'integration-phase-' + index, name: 'Stage ' + index, goal: null,
      projectId: 'integration-project', position: index,
    }));
    const nodes = Array.from({ length: 248 }, (_, index) => ({
      ...graphFromRecorded().nodes[0], id: 'integration-task-' + index,
      title: 'Integration work ' + index, status: 'todo', agent: null,
      project: 'Integration project', phaseId: phases[index % 10].id,
      updated: '2026-09-24T00:00:00.000Z',
    }));
    return { nodes, phases,
      edges: nodes.slice(10).map((node, index) => ({ from: node.id, to: nodes[index].id, kind: 'dependency' as const })),
      reports: nodes.map(node => ({ id: 'report-' + node.id, taskId: node.id, title: 'Linked evidence' })) };
  };

  // Measured at the planner's 1280 x 720 canvas (task short side at Fit,
  // world aspect) — production as read H 6.1px 1.12, V 7.3px 2.07; at 283
  // tasks H 6.1px 1.35, V 7.2px 1.67; 248/10 H 9.7px 2.61, V 12.8px 1.54.
  // The released single-strip engine: 0.7px 63.2, 0.8px 29.3; 0.7px 66.1,
  // 0.7px 31.1; 2.0px 68.8, 1.4px 96.8. The bounds sit under the measurements
  // and fail that engine by an order of magnitude. The
  // production floor is lower than the synthetic one because its 1,938
  // Report cells are two thirds of its painted area (card 742fae98 groups
  // them); 6px is where `taskShapeAlpha` paints a shape at a third of its ink.
  test.each([
    ['production as read', () => productionShape(), 6, 2.25],
    ['production at 283 tasks', () => productionShape(true), 6, 2.25],
    ['248 tasks, ten phases', integration248, 9.5, 3],
  ] as const)('%s: both organizations frame task shapes at Fit with a bounded aspect', (name, make, minPx, maxAspect) => {
    const graph = make();
    for (const place of [layoutHorizontalPlane, layoutVerticalPlane]) {
      const result = place(graph, {});
      const fit = fitTilePx(result);
      // eslint-disable-next-line no-console
      console.log(`[31454392 fit] ${name} ${place.name}: world ${fit.bounds.w}x${fit.bounds.h}`
        + ` aspect ${fit.aspect.toFixed(2)}, Fit ${fit.scale.toFixed(4)} in`
        + ` ${PLANE_METRICS.shelfViewW}x${PLANE_METRICS.shelfViewH}, task ${fit.px.toFixed(1)}px`);
      expect(fit.px, `${place.name} task short side at Fit`).toBeGreaterThanOrEqual(minPx);
      expect(fit.aspect, `${place.name} world aspect`).toBeLessThanOrEqual(maxAspect);
      // Counts are unchanged by wrapping: every task, phase and Report cell.
      expect(tilesOf(result)).toHaveLength(graph.nodes.length);
      expect(bandsOf(result)).toHaveLength(graph.phases.length);
      expect(result.elements.filter(e => e.kind === 'pill')).toHaveLength(graph.reports!.length);
      for (const band of bandsOf(result)) {
        expect(band.facts?.taskCount).toBe(graph.nodes.filter(n => `band:${n.project}:${n.phaseId}` === band.id).length);
      }
      expect(findOverlaps(result.elements)).toEqual([]);
    }
  });

  test.each([
    ['horizontal', layoutHorizontalPlane, 'y', 'x'],
    ['vertical', layoutVerticalPlane, 'x', 'y'],
  ] as const)('%s wraps phases in declared order and keeps each phase whole', (_name, place, across, along) => {
    const graph = productionShape(true);
    const result = place(graph, planeSizes(graph));
    const bands = bandsOf(result);
    const order = [...graph.phases].sort((a, b) => a.position - b.position)
      .map(phase => bands.find(b => b.id === `band:Production project:${phase.id}`)!);
    const shelves = new Set(order.map(b => b[across])).size;
    expect(shelves).toBeGreaterThan(1);
    for (let i = 1; i < order.length; i += 1) {
      const [a, b] = [order[i - 1], order[i]];
      // Reading order: further along the same shelf, or on a later shelf.
      if (a[across] === b[across]) expect(b[along]).toBeGreaterThan(a[along]);
      else expect(b[across]).toBeGreaterThan(a[across]);
    }
    for (const tile of tilesOf(result)) {
      const band = bands.find(b => b.id === tile.bandId)!;
      expect(tile.x).toBeGreaterThanOrEqual(band.x);
      expect(tile.y).toBeGreaterThanOrEqual(band.y);
      expect(tile.x + tile.w).toBeLessThanOrEqual(band.x + band.w);
      expect(tile.y + tile.h).toBeLessThanOrEqual(band.y + band.h);
    }
  });

  test.each([
    ['horizontal', layoutHorizontalPlane],
    ['vertical', layoutVerticalPlane],
  ] as const)('%s shelves follow what is shown: reload, filter, arrival (E386)', (_name, place) => {
    const graph = productionShape(true);
    const sizes = planeSizes(graph);
    const first = place(graph, sizes);
    const reloaded = place(graph, sizes, JSON.parse(JSON.stringify(first.anchors)) as MapPlaneAnchors);
    expect(positionsOf(reloaded)).toEqual(positionsOf(first));
    // A filter that hides the widest phase re-plans the lane from what is
    // left: the phase is not drawn, the project is smaller, and the new plan
    // is itself a fixed point.
    const hidden = graph.phases.find(p => p.position === 13)!.id;
    const filtered = { ...graph, nodes: graph.nodes.filter(n => n.phaseId !== hidden) };
    const narrowed = place(filtered, sizes, first.anchors);
    expect(bandsOf(narrowed).some(band => band.id.endsWith(':' + hidden))).toBe(false);
    const area = (layout: LayoutResult) => containersOf(layout).reduce((sum, c) => sum + c.w * c.h, 0);
    expect(area(narrowed)).toBeLessThan(area(first));
    expect(positionsOf(place(filtered, sizes, narrowed.anchors))).toEqual(positionsOf(narrowed));
    expect(findOverlaps(narrowed.elements)).toEqual([]);
    // An arrival lands in its rank's free cell; no card of its phase moves
    // relative to the phase.
    const arrival = { ...filtered.nodes[filtered.nodes.length - 1], id: 'Production project:arrival',
      updated: '2026-10-09T00:00:00.000Z' };
    const grown = { ...filtered, nodes: [...filtered.nodes, arrival] };
    const after = place(grown, planeSizes(grown), narrowed.anchors);
    const relative = (layout: LayoutResult) => {
      const bands = new Map(bandsOf(layout).map(band => [band.id, band]));
      return new Map(tilesOf(layout).filter(tile => tile.bandId === `band:${arrival.project}:${arrival.phaseId}`)
        .map(tile => [tile.id, { x: tile.x - bands.get(tile.bandId!)!.x, y: tile.y - bands.get(tile.bandId!)!.y }]));
    };
    expect(relative(after).size).toBeGreaterThan(1);
    expect(movedIds(relative(narrowed), relative(after))).toEqual([]);
    expect(tilesOf(after)).toHaveLength(filtered.nodes.length + 1);
    expect(findOverlaps(after.elements)).toEqual([]);
  });

  test('a lane already readable at Fit keeps one shelf and records none', () => {
    const graph = graphFromRecorded();
    for (const place of [layoutHorizontalPlane, layoutVerticalPlane]) {
      const result = place(graph, planeSizes(graph));
      expect('shelfLen' in result.anchors).toBe(false);
      expect('segShelf' in result.anchors).toBe(false);
    }
  });

  test('a wrapped lane records no shelf either: the plan is made from what is shown (E386)', () => {
    const graph = productionShape(true);
    const result = layoutHorizontalPlane(graph, {});
    expect(new Set(bandsOf(result).map(band => band.y)).size).toBeGreaterThan(1);
    expect('shelfLen' in result.anchors).toBe(false);
    expect('shelfHeight' in result.anchors).toBe(false);
    expect('segShelf' in result.anchors).toBe(false);
    const gone = graph.nodes[graph.nodes.length - 1].id;
    const scoped = { ...graph, nodes: graph.nodes.filter(n => n.id !== gone) };
    expect(positionsOf(layoutHorizontalPlane(scoped, {}, result.anchors)))
      .toEqual(positionsOf(layoutHorizontalPlane(scoped, {}, layoutHorizontalPlane(scoped, {}, result.anchors).anchors)));
  });
});

// F1: fresh density alone misses arrival into anchored downstream territory.
describe("anchored rank wrapping under arrival and churn", () => {
  test.each([
    ["horizontal", layoutHorizontalPlane, "x", "w"],
    ["vertical", layoutVerticalPlane, "y", "h"],
  ] as const)("%s preserves flow, old positions and nonoverlap", (_name, place, axis, extent) => {
    const node = (id: string) => ({ ...graphFromRecorded().nodes[0], id,
      project: "Arrival project", phaseId: "arrival-phase", updated: "2026-10-03T00:00:00Z" });
    const makeGraph = (ids: string[]): MapGraph => ({ nodes: [...ids.map(node), node("d")],
      phases: [{ id: "arrival-phase", name: "Arrival", projectId: "arrival-project", position: 0, goal: null }],
      edges: ids.map(id => ({ from: "d", to: id, kind: "dependency" })),
      reports: ids.map(id => ({ id: "report-" + id, taskId: id, title: "Linked evidence" })),
    });
    let ids = Array.from({ length: 8 }, (_, i) => "a" + i);
    let graph = makeGraph(ids);
    let before = place(graph, planeSizes(graph));
    // E386: a step that only ADDS moves nothing already placed; a step that
    // removes closes the holes it leaves, keeping every survivor's order.
    const check = (nextIds: string[]) => {
      const previous = new Set(tilesOf(before).map(tile => tile.id));
      graph = makeGraph(nextIds);
      const after = place(graph, planeSizes(graph), before.anchors);
      const removes = [...previous].some(id => !nextIds.includes(id) && id !== 'd');
      expect(tilesOf(after)).toHaveLength(nextIds.length + 1);
      expect(after.elements.filter(e => e.kind === "pill")).toHaveLength(nextIds.length);
      expect(findOverlaps(after.elements)).toEqual([]);
      const tiles = tilesOf(after);
      const downstream = tiles.find(t => t.id === "d")!;
      for (const tile of tiles.filter(t => t.id !== "d")) {
        expect(tile[axis] + tile[extent], tile.id + " must precede d").toBeLessThan(downstream[axis]);
      }
      if (!removes) expect(movedIds(positionsOf(before), positionsOf(after), id => tiles.some(t => t.id === id))).toEqual([]);
      const reading = (layout: LayoutResult) => tilesOf(layout).filter(t => t.id !== 'd' && previous.has(t.id)
        && nextIds.includes(t.id)).sort((a, b) => a[axis] - b[axis] || (axis === 'x' ? a.y - b.y : a.x - b.x)).map(t => t.id);
      expect(reading(after)).toEqual(reading(before));
      const permuted = place({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() },
        planeSizes(graph), before.anchors);
      expect(positionsOf(permuted)).toEqual(positionsOf(after));
      before = after;
    };
    ids.push("a8");
    check(ids);
    expect(before.anchors.slots.a8.col).toBe(0);
    expect(before.anchors.slots.a8.row).toBe(8);
    ids.push(...Array.from({ length: 9 }, (_, i) => "a" + (i + 9)));
    check(ids);
    ids = ids.filter(id => id !== "a2" && id !== "a5");
    check(ids);
    ids.push("a18", "a19");
    check(ids);
    const full = before;
    check(ids.filter(id => !["a1", "a7", "a8"].includes(id)));
    check(ids);
    // The returning tasks are arrivals, but every AREA is the size it was.
    const areas = (layout: LayoutResult) => bandsOf(layout).map(band => [band.id, band.w, band.h]);
    expect(areas(before)).toEqual(areas(full));
  });
});

// F2: source-token calculations, NOT browser font measurements.
const titleScreenRem = (scale: number) => {
  const band = planeDetailBand(PLANE_METRICS.tileCellW * scale);
  let expression = taskCss.match(/\.task-card-title-compact\s*\{[^}]*font-size:\s*([^;]+);/)![1];
  for (const match of mapCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].includes(".task-card-title-compact")) continue;
    if (!match[1].includes(".map-plane[data-plane-lod]")
      && !match[1].includes(`.map-plane[data-plane-lod="${band}"]`)) continue;
    const font = match[2].match(/font-size:\s*([^;]+);/);
    if (font) expression = font[1];
  }
  expression = expression.replace(/var\((--[\w-]+)(?:,\s*[^)]+)?\)/g, (_all, token: string) => {
    if (token === "--map-plane-inverse-scale") return String(1 / scale);
    const value = tokensCss.match(new RegExp(token + ":\\s*([0-9.]+)rem"));
    if (!value) throw new Error("Unsupported font token " + token);
    return value[1];
  }).replace(/calc\(/g, "(");
  expect(expression).toMatch(/^[0-9.,+*/()\s\-a-z]+$/);
  const value = Function("clamp", "min", "max", `return (${expression})`)(
    (lo: number, value: number, hi: number) => Math.max(lo, Math.min(value, hi)), Math.min, Math.max);
  return value * scale;
};

describe("continuous screen-space Map title typography (source-derived)", () => {
  test("ordinary zoom steps never reduce the title, including detail takeover", () => {
    const scales = [0.60, 0.65, 0.72, 0.79, 0.80, 0.9, 1, 1.1, 1.13, 1.2, 1.5, 2, 4];
    const sizes = scales.map(titleScreenRem);
    for (let i = 1; i < sizes.length; i += 1) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1] - 1e-10);
    expect(titleScreenRem(0.79) * 16).toBeCloseTo(15.8);
    expect(titleScreenRem(0.8) * 16).toBeCloseTo(16);
    expect(titleScreenRem(1.1) * 16).toBeGreaterThanOrEqual(16);
  });
  test.each([96 / 170, 136 / 170, 192 / 170, 16 / 14])("title is continuous across threshold %s", threshold => {
    const before = titleScreenRem(threshold - 1e-7);
    const after = titleScreenRem(threshold + 1e-7);
    expect(after).toBeGreaterThanOrEqual(before - 1e-10);
    expect(Math.abs(after - before)).toBeLessThan(1e-5);
  });
});

// R1: retain only model-returned anchors through filter/arrival/deletion/return.
// Total rank ordering must not destroy actual edges with feasible free holes.
describe("filtered intermediate-rank return with consumed anchor territory", () => {
  test.each([
    ["horizontal", layoutHorizontalPlane, "x", "w", 0],
    ["horizontal", layoutHorizontalPlane, "x", "w", 1],
    ["vertical", layoutVerticalPlane, "y", "h", 0],
    ["vertical", layoutVerticalPlane, "y", "h", 1],
  ] as const)("%s exact R1 and repeated churn with %i Reports/task", (_org, place, axis, extent, reportCount) => {
    const make = (active: string[], chain: string[]): MapGraph => {
      const ids = [...active, ...chain, "c"];
      return {
        nodes: ids.map(id => ({ ...graphFromRecorded().nodes[0], id, title: id,
          project: "R1", phaseId: "r1-phase", updated: "2026-10-03T00:00:00Z" })),
        phases: [{ id: "r1-phase", name: "Return", projectId: "R1", position: 0, goal: null }],
        edges: [...chain, "c"].map((id, i) => ({ from: id,
          to: i ? chain[i - 1] : "a0", kind: "dependency" })),
        reports: reportCount ? ids.map(id => ({ id: "report-" + id, taskId: id, title: "Evidence" })) : [],
      };
    };
    // While hidden, keep the real edges to missing b: computeDepths ignores
    // absent endpoints. No task or anchor coordinates are manually changed.
    const hidden = (active: string[]): MapGraph => ({ ...make(active, []), edges: [
      { from: "b", to: "a0", kind: "dependency" }, { from: "c", to: "b", kind: "dependency" },
    ] });
    let graph = make(Array.from({ length: 9 }, (_, i) => "a" + i), ["b"]);
    let before = place(graph, planeSizes(graph));
    expect(before.anchors.slots.b).toMatchObject({ col: 2, row: 0 });
    expect(before.anchors.slots.c).toMatchObject({ col: 3, row: 0 });
    // E386: a step that only ADDS moves nothing already placed; a step that
    // hides work closes the holes it leaves, so it is not held to that.
    const check = (next: MapGraph) => {
      const previous = new Set(graph.nodes.map(node => node.id));
      const removes = [...previous].some(id => !next.nodes.some(node => node.id === id))
        // A NEW dependency into existing work may re-flow its segment: flow
        // is the plane's first rule (`flowsBackward`).
        || next.edges.some(edge => [edge.from, edge.to].every(id => next.nodes.some(node => node.id === id))
          && previous.has(edge.from) !== previous.has(edge.to));
      const after = place(next, planeSizes(next), before.anchors);
      const tiles = tilesOf(after);
      expect(tiles).toHaveLength(next.nodes.length);
      expect(after.elements.filter(e => e.kind === "pill")).toHaveLength(next.nodes.length * reportCount);
      expect(findOverlaps(after.elements)).toEqual([]);
      // Also compare task/Report boxes directly, independent of containment rules.
      const boxes = after.elements.filter(e => e.kind === "tile" || e.kind === "pill");
      for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i], b = boxes[j];
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h,
          a.id + " / " + b.id).toBe(false);
      }
      for (const edge of next.edges) {
        const parent = tiles.find(t => t.id === edge.to), child = tiles.find(t => t.id === edge.from);
        if (parent && child) expect(parent[axis] + parent[extent], edge.to + " -> " + edge.from).toBeLessThan(child[axis]);
      }
      if (!removes) expect(movedIds(positionsOf(before), positionsOf(after), id => boxes.some(t => t.id === id))).toEqual([]);
      const permutations = [next.nodes, [...next.nodes].reverse(),
        [...next.nodes.slice(2), ...next.nodes.slice(0, 2)],
        [...next.nodes].sort((a, b) => b.id.localeCompare(a.id))];
      for (const nodes of permutations) {
        const permuted = place({ ...next, nodes, edges: [...next.edges].reverse(), reports: [...(next.reports ?? [])].reverse() },
          planeSizes(next), before.anchors);
        expect(positionsOf(permuted)).toEqual(positionsOf(after));
        expect(permuted.anchors.slots).toEqual(after.anchors.slots);
      }
      expect(positionsOf(place(next, planeSizes(next), after.anchors))).toEqual(positionsOf(after));
      before = after; graph = next;
    };
    const original = Array.from({ length: 9 }, (_, i) => "a" + i);
    const arrivals = Array.from({ length: 9 }, (_, i) => "new" + i);
    check(hidden(original));
    check(hidden([...original, ...arrivals]));
    const survivors = ["a0", "new7", "new8"];
    check(hidden(survivors));
    check(make(survivors, ["b"]));
    expect(before.anchors.slots.b.col).toBeLessThan(before.anchors.slots.c.col);
    // A newly introduced rank between b and fixed c has a feasible col2 hole,
    // despite unrelated depth-zero tasks already occupying that column.
    check(make(survivors, ["b", "intermediate"]));
    for (let cycle = 0; cycle < 6; cycle += 1) {
      check(hidden(survivors));
      const fresh = Array.from({ length: 17 + cycle * 2 }, (_, i) => "churn-" + cycle + "-" + i);
      check(hidden([...survivors, ...fresh]));
      check(hidden([...survivors, fresh[8], fresh[9]]));
      check(make([...survivors, fresh[8], fresh[9]], ["b", "intermediate"]));
      check(make(survivors, ["b", "intermediate"]));
    }
  });
});

// Card 2b6f21f6 (A), owner ruling SQ-1, superseded by owner ruling E386: with
// archived work hidden, a shelf whose phases hold only archived tasks used to
// shrink to its phase headers. E386 goes further: a phase with no shown task
// is not drawn at all, the lane fits what is left, and showing the archive
// again and hiding it returns every area to the same rectangle.
describe('card 2b6f21f6 (A) under E386: an all-archived shelf disappears when archived work is hidden', () => {
  test.each(['horizontal', 'vertical'] as const)('%s', organization => {
    const lane = 'Production project';
    const base = productionShape(true, lane);
    const zeta: MapPhase = { id: 'zeta-phase', name: 'Zeta', goal: null, projectId: 'zeta', position: 0 };
    const graph: MapGraph = { ...base, phases: [...base.phases, zeta],
      nodes: [...base.nodes, ...addedNodes(base, 3, 'Zeta project', zeta.id, 'zeta')] };
    const sizes = planeSizes(graph);
    const place = (scope: MapGraph, anchors: MapPlaneAnchors) =>
      layoutContinuousPlane(scope, sizes, organization, anchors);
    const planned = place(graph, EMPTY_PLANE_ANCHORS);
    const band = (result: LayoutResult, id: string) =>
      bandsOf(result).find(b => b.id === `band:${lane}:${id}`);
    const container = (result: LayoutResult, laneKey: string) =>
      containersOf(result).find(c => c.laneId === laneKey)!;
    // The first shelf: the phases that start the lane's reading order.
    const across = organization === 'horizontal' ? 'y' : 'x';
    const firstShelf = Math.min(...base.phases.map(phase => band(planned, phase.id)![across]));
    const historic = base.phases.filter(phase => band(planned, phase.id)![across] === firstShelf).map(phase => phase.id);
    const later = base.phases.filter(phase => !historic.includes(phase.id)).map(phase => phase.id);
    // Not vacuous: the lane really is wrapped, with history on its first shelf.
    expect(historic.length).toBeGreaterThan(0);
    expect(later.length).toBeGreaterThan(0);

    // The owner's shape: every task on the oldest shelf is archived.
    const withArchive: MapGraph = { ...graph, nodes: graph.nodes.map(node =>
      historic.includes(node.phaseId!) ? { ...node, status: 'archived' as const } : node) };
    const live: MapGraph = { ...withArchive, nodes: withArchive.nodes.filter(node => node.status !== 'archived') };
    const before = place(live, EMPTY_PLANE_ANCHORS);
    const shown = place(withArchive, before.anchors);
    const hidden = place(live, shown.anchors);

    for (const id of historic) {
      expect(band(shown, id), `${id} shown`).toBeDefined();
      expect(band(hidden, id), `${id} hidden`).toBeUndefined();
    }
    for (const id of later) expect(band(hidden, id)).toBeDefined();
    // The project gives the archive's ground back, and the lane after it
    // rises by the same depth.
    const depth = organization === 'horizontal' ? 'h' : 'w';
    const freed = container(shown, lane)[depth] - container(hidden, lane)[depth];
    expect(freed).toBeGreaterThan(0);
    expect(container(shown, 'Zeta project')[across] - container(hidden, 'Zeta project')[across])
      .toBeGreaterThan(0);
    expect(findOverlaps(hidden.elements)).toEqual([]);
    // Exact return: hiding the archive again is the world before it was shown.
    const boxes = (result: LayoutResult) => result.elements.map(e => [e.id, e.x, e.y, e.w, e.h]);
    expect(boxes(hidden)).toEqual(boxes(before));
  });
});
