/**
 * Layout engine properties (design 77950a97 §2 hard invariant, §8 binding).
 *
 * Two disciplines this file is written under, both from diagnosis 7fa7e605:
 *  - The graph input is a RECORDED fixture captured from the real backend
 *    serializer (`__fixtures__/graph.task.json`), never a shape invented to
 *    match the implementation. It contains what real data contains and an
 *    invented one would have missed: 8 of 14 tasks with NO phase, a task
 *    with a null project, and no knowledge edges at all.
 *  - Geometry is asserted by an INDEPENDENT checker (`findOverlaps`) over
 *    measured boxes, plus adversarial size maps. "Locally true" geometry
 *    proofs failed three review rounds in the abandoned attempt.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import recorded from './__fixtures__/graph.task.json';
import { clampScale } from './useMapViewState';
import {
  ALTITUDE_NODE_PX,
  AVAILABLE_ORGANIZATIONS,
  FALLBACK_AGGREGATE,
  FALLBACK_TILE,
  LAYOUT_METRICS,
  buildAggregates,
  buildTreeModel,
  computeDepths,
  aggregateChainState,
  aggregateEdgesToDraw,
  aggregateFactsOf,
  INITIAL_CORRECTIVE_FIT,
  arrivalFitStep,
  buildChain,
  onExplicitFit,
  onExtentChanged,
  onFitSpent,
  revealChain,
  collapseDenseEdges,
  paintedObstacles,
  findOverlaps,
  fitScaleFor,
  focusBoxAcross,
  focusedElement,
  quadraticBounds,
  quadraticIntersectsBox,
  segmentIntersectsBox,
  quadraticPointAt,
  routeEdge,
  routeFlowEdge,
  initialAltitude,
  layoutAtAltitude,
  layoutHorizontal,
  alignOutline,
  CONTAINER_MORPH_POINTS,
  containerMorphsFor,
  interpolateOutline,
  layoutOrganic,
  layoutRadial,
  simulateOrganicCentres,
  morphEase,
  rectOutline,
  resampleOutline,
  layoutTaskAltitude,
  layoutVertical,
  radialSectorSpans,
  RADIAL_METRICS,
  meanNodeWidth,
  rollUpEdges,
  settleAltitude,
  type Box,
  type MapAltitude,
  type MapEdge,
  type MapGraph,
  type MapPhase,
  type MapTaskNode,
  type PlacedAggregate,
  type PlacedHull,
  type PlacedLaneHeader,
  type PlacedTile,
  type SizeMap,
} from './mapGraphModel';

const graphFromRecorded = (): MapGraph => ({
  nodes: (recorded as any).nodes as MapTaskNode[],
  edges: (recorded as any).edges as MapEdge[],
  phases: (recorded as any).phases as MapPhase[],
});

/**
 * The recorded graph predates the §3 taxonomy (see __fixtures__/SHAPE.json),
 * so it carries no reports. Reports are attached here in the serializer's own
 * row shape — {id, taskId, title} as backend queryLinkedReports returns —
 * against tasks that ARE in the recorded fixture.
 */
/** Measured sizes plus a measured size for every pill. SizeMap is readonly, so
 *  this composes a new map rather than mutating one. */
const withPillSizes = (graph: MapGraph, pill: { w: number; h: number }): SizeMap => ({
  ...measuredSizes(graph),
  // The PRODUCTION key is `pill:<report>:<task>` - one pill per PAIR. Writing
  // `pill:<report>` meant the layout never found these sizes and quietly used
  // the fallback instead, so every hostile size here was inert (round 1, B1).
  ...Object.fromEntries((graph.reports ?? [])
    .map(report => [`pill:${report.id}:${report.taskId}`, pill])),
});

const withReports = (graph: MapGraph, perTask = 1): MapGraph => ({
  ...graph,
  reports: graph.nodes.flatMap((node, index) =>
    Array.from({ length: perTask }, (_unused, n) => ({
      id: `report-${index}-${n}`,
      taskId: node.id,
      title: `Linked report ${index}-${n}`,
    }))),
});

/** Sizes as the DOM would report them: varied, never uniform. */
const measuredSizes = (graph: MapGraph, vary = true): SizeMap => {
  const sizes: Record<string, { w: number; h: number }> = {};
  graph.nodes.forEach((node, index) => {
    sizes[node.id] = vary
      // Real tiles differ in height with content — the abandoned attempt
      // assumed a single constant and shipped 446–3,398 overlaps.
      ? { w: 170, h: 78 + (index % 5) * 11 }
      : { w: 170, h: 96 };
  });
  for (const project of new Set(graph.nodes.map(n => n.project ?? '__no_project__'))) {
    sizes[`lane:${project}`] = { w: 180, h: 56 + (project.length % 3) * 8 };
  }
  return sizes;
};

describe('recorded fixture is representative, not convenient', () => {
  test('it carries the cases an invented fixture would have missed', () => {
    const graph = graphFromRecorded();
    expect(graph.nodes.length).toBeGreaterThan(0);
    // Unphased tasks are the majority here — the layout must place them.
    expect(graph.nodes.some(n => !n.phaseId)).toBe(true);
    // A project-less task exists.
    expect(graph.nodes.some(n => n.project === null)).toBe(true);
    // Phase identity arrives with a name (card 8645e81c).
    expect(graph.phases.every(p => typeof p.name === 'string' && p.name.length > 0)).toBe(true);
    // Nodes carry NO goal of their own — goals live on the phase.
    expect(graph.nodes.every(n => !('goal' in n))).toBe(true);
  });
});

describe('dependency depth', () => {
  test('a task with no in-set upstream is depth 0 and a chain increments', () => {
    const edges: MapEdge[] = [
      { from: 'b', to: 'a', kind: 'dependency' },
      { from: 'c', to: 'b', kind: 'dependency' },
    ];
    const depths = computeDepths(['a', 'b', 'c'], edges);
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('c')).toBe(2);
  });

  test('edges leaving the set do not create phantom depth', () => {
    const edges: MapEdge[] = [{ from: 'a', to: 'outside', kind: 'dependency' }];
    expect(computeDepths(['a'], edges).get('a')).toBe(0);
  });

  test('knowledge edges never order the flow', () => {
    const edges: MapEdge[] = [{ from: 'b', to: 'a', kind: 'knowledge' }];
    expect(computeDepths(['a', 'b'], edges).get('b')).toBe(0);
  });

  test('a dependency cycle terminates instead of hanging', () => {
    const edges: MapEdge[] = [
      { from: 'a', to: 'b', kind: 'dependency' },
      { from: 'b', to: 'a', kind: 'dependency' },
    ];
    const depths = computeDepths(['a', 'b'], edges);
    expect(depths.get('a')).toBeGreaterThanOrEqual(0);
    expect(depths.get('b')).toBeGreaterThanOrEqual(0);
  });
});

describe('horizontal layout — the zero-overlap invariant', () => {
  test('the recorded estate lays out with no overlapping element', () => {
    const graph = graphFromRecorded();
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('every task in the graph is placed exactly once — none silently dropped', () => {
    const graph = graphFromRecorded();
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    const placed = layout.elements.filter(e => e.kind === 'tile').map(e => e.id);
    expect(placed.slice().sort()).toEqual(graph.nodes.map(n => n.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  test('unphased and project-less tasks get real, non-overlapping homes', () => {
    const graph = graphFromRecorded();
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    const unphased = graph.nodes.filter(n => !n.phaseId);
    const projectless = graph.nodes.filter(n => n.project === null);
    const tiles = layout.elements.filter(e => e.kind === 'tile');
    for (const node of [...unphased, ...projectless]) {
      expect(tiles.some(tile => tile.id === node.id)).toBe(true);
    }
    expect(layout.elements.some(e => e.kind === 'band' && e.label === 'No phase')).toBe(true);
    expect(layout.elements.some(e => e.kind === 'lane' && e.label === 'No project')).toBe(true);
  });

  test('band boxes contain their own tiles', () => {
    const graph = graphFromRecorded();
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    const bands = layout.elements.filter(e => e.kind === 'band') as any[];
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    for (const tile of tiles) {
      const owning = bands.filter(band =>
        tile.x >= band.x && tile.x + tile.w <= band.x + band.w &&
        tile.y >= band.y && tile.y + tile.h <= band.y + band.h);
      expect(owning.length).toBe(1);
    }
  });

  test('depth orders left to right inside a band', () => {
    const graph = graphFromRecorded();
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    for (const a of tiles) {
      for (const b of tiles) {
        if (a.depth < b.depth && a.node.phaseId === b.node.phaseId && a.node.project === b.node.project) {
          expect(a.x).toBeLessThan(b.x);
        }
      }
    }
  });

  test('layout is deterministic — identical input, identical output', () => {
    const graph = graphFromRecorded();
    const sizes = measuredSizes(graph);
    expect(JSON.stringify(layoutHorizontal(graph, sizes).elements))
      .toEqual(JSON.stringify(layoutHorizontal(graph, sizes).elements));
  });
});

describe('phase chips are first-class in the overlap invariant', () => {
  // Found by EYEBALLING the live Map, not by a test: the chip sat on the
  // band's first tile. §2 names phase chips among the elements that may
  // never intersect, but the checker only compared same-kind pairs and the
  // chip was not a placed element at all — so nothing could see it. A check
  // cannot catch what it does not model.
  test('every band emits a chip and no chip touches a tile', () => {
    const graph = graphFromRecorded();
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    const bands = layout.elements.filter(e => e.kind === 'band');
    const chips = layout.elements.filter(e => e.kind === 'chip');
    expect(chips.length).toBe(bands.length);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('the chip sits in the reserved strip and every tile starts below it', () => {
    const graph = graphFromRecorded();
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    const bands = layout.elements.filter(e => e.kind === 'band') as any[];
    const chips = layout.elements.filter(e => e.kind === 'chip') as any[];
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    for (const band of bands) {
      const chip = chips.find(c => c.bandId === band.id);
      expect(chip).toBeDefined();
      // Inside the band, within the reserved strip.
      expect(chip.y).toBeGreaterThanOrEqual(band.y);
      expect(chip.y + chip.h).toBeLessThanOrEqual(band.y + LAYOUT_METRICS.bandHeaderMinH);
      const inBand = tiles.filter(t =>
        t.x >= band.x && t.x + t.w <= band.x + band.w &&
        t.y >= band.y && t.y + t.h <= band.y + band.h);
      for (const tile of inBand) {
        expect(tile.y).toBeGreaterThanOrEqual(band.y + LAYOUT_METRICS.bandHeaderMinH);
      }
    }
  });

  test('an unusually WIDE measured chip still cannot reach the tiles', () => {
    const graph = graphFromRecorded();
    const sizes: Record<string, { w: number; h: number }> = { ...measuredSizes(graph) };
    // A long phase name with a goal line: the hostile case.
    for (const element of layoutHorizontal(graph, measuredSizes(graph)).elements) {
      if (element.kind === 'chip') sizes[element.id] = { w: 900, h: 26 };
    }
    const layout = layoutHorizontal(graph, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });
});

describe('horizontal layout — adversarial shapes', () => {
  const hostile = (nodes: MapTaskNode[], edges: MapEdge[] = [], phases: MapPhase[] = []) =>
    ({ nodes, edges, phases }) as MapGraph;
  const node = (id: string, over: Partial<MapTaskNode> = {}): MapTaskNode => ({
    id, title: 'T ' + id, status: 'todo', priority: 'normal',
    project: 'P', phaseId: null, updated: '2026-08-16T00:00:00.000Z', ...over,
  });

  test('an empty graph produces an empty, non-negative canvas', () => {
    const layout = layoutHorizontal(hostile([]), {});
    expect(layout.elements).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  test('wildly uneven tile heights still never overlap', () => {
    const nodes = Array.from({ length: 40 }, (_, i) =>
      node('n' + i, { phaseId: i % 3 === 0 ? 'ph1' : null, project: i % 2 ? 'A' : 'B' }));
    const sizes: Record<string, { w: number; h: number }> = {};
    // The exact disease that produced 3,398 overlaps: heights that vary by
    // an order of magnitude.
    nodes.forEach((n, i) => { sizes[n.id] = { w: 170, h: i % 7 === 0 ? 420 : 64 }; });
    const layout = layoutHorizontal(
      hostile(nodes, [], [{ id: 'ph1', name: 'Phase one', goal: null, projectId: 'A', position: 0 }]),
      sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('a deep single chain does not stack tiles on each other', () => {
    const nodes = Array.from({ length: 25 }, (_, i) => node('c' + i));
    const edges: MapEdge[] = nodes.slice(1).map((n, i) =>
      ({ from: n.id, to: nodes[i].id, kind: 'dependency' as const }));
    const sizes = Object.fromEntries(nodes.map(n => [n.id, { w: 170, h: 90 }]));
    const layout = layoutHorizontal(hostile(nodes, edges), sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    expect(new Set(tiles.map(t => t.x)).size).toBe(nodes.length);
  });

  test('many lanes and many bands stay disjoint', () => {
    const nodes: MapTaskNode[] = [];
    const phases: MapPhase[] = [];
    for (let p = 0; p < 12; p += 1) {
      for (let ph = 0; ph < 4; ph += 1) {
        const phaseId = `p${p}-ph${ph}`;
        phases.push({ id: phaseId, name: `Phase ${ph}`, goal: null, projectId: `P${p}`, position: ph });
        for (let t = 0; t < 5; t += 1) {
          nodes.push(node(`${phaseId}-t${t}`, { project: `P${p}`, phaseId }));
        }
      }
    }
    const sizes = Object.fromEntries(nodes.map((n, i) => [n.id, { w: 170, h: 70 + (i % 4) * 15 }]));
    const layout = layoutHorizontal(hostile(nodes, [], phases), sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('MISSING measurements fall back without producing overlap', () => {
    // First paint: nothing measured yet. This must not collapse the layout.
    const nodes = Array.from({ length: 15 }, (_, i) => node('m' + i, { project: i % 3 ? 'A' : 'B' }));
    const layout = layoutHorizontal(hostile(nodes), {});
    expect(findOverlaps(layout.elements)).toEqual([]);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    expect(tiles.every(t => t.h === FALLBACK_TILE.h)).toBe(true);
  });

  test('a zero-sized measurement cannot make two tiles share a point', () => {
    const nodes = [node('z0'), node('z1')];
    const layout = layoutHorizontal(hostile(nodes), { z0: { w: 0, h: 0 }, z1: { w: 0, h: 0 } });
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('duplicate phase positions resolve deterministically', () => {
    const phases: MapPhase[] = [
      { id: 'a', name: 'Alpha', goal: null, projectId: 'P', position: 0 },
      { id: 'b', name: 'Beta', goal: null, projectId: 'P', position: 0 },
    ];
    const nodes = [node('n-a', { phaseId: 'a' }), node('n-b', { phaseId: 'b' })];
    const sizes = { 'n-a': { w: 170, h: 80 }, 'n-b': { w: 170, h: 80 } };
    const first = layoutHorizontal(hostile(nodes, [], phases), sizes);
    const second = layoutHorizontal(hostile(nodes, [], phases), sizes);
    expect(JSON.stringify(first.elements)).toEqual(JSON.stringify(second.elements));
    expect(findOverlaps(first.elements)).toEqual([]);
  });
});

describe('the overlap checker itself', () => {
  test('it reports a genuine intersection', () => {
    const overlaps = findOverlaps([
      { kind: 'tile', id: 'a', node: {} as any, depth: 0, x: 0, y: 0, w: 10, h: 10 },
      { kind: 'tile', id: 'b', node: {} as any, depth: 0, x: 5, y: 5, w: 10, h: 10 },
    ]);
    expect(overlaps).toEqual([['a', 'b']]);
  });

  test('touching edges are not an overlap', () => {
    expect(findOverlaps([
      { kind: 'tile', id: 'a', node: {} as any, depth: 0, x: 0, y: 0, w: 10, h: 10 },
      { kind: 'tile', id: 'b', node: {} as any, depth: 0, x: 10, y: 0, w: 10, h: 10 },
    ])).toEqual([]);
  });

  test('a tile inside its band is containment, not collision', () => {
    expect(findOverlaps([
      { kind: 'band', id: 'band', label: 'B', goal: null, laneId: 'L', x: 0, y: 0, w: 100, h: 100 },
      { kind: 'tile', id: 'a', node: {} as any, depth: 0, x: 10, y: 10, w: 10, h: 10 },
    ])).toEqual([]);
  });
});

describe('accessible tree alternative', () => {
  test('it carries the same scope and grouping as the canvas', () => {
    const graph = graphFromRecorded();
    const tree = buildTreeModel(graph);
    const inTree = tree.flatMap(lane => lane.bands.flatMap(band => band.nodes.map(n => n.id)));
    expect(inTree.slice().sort()).toEqual(graph.nodes.map(n => n.id).sort());
    expect(tree.some(lane => lane.laneLabel === 'No project')).toBe(true);
    // §6 is untouched by A2: the alternative carries the whole scope whatever
    // altitude is drawn. It used to be derived from placed lane/band/tile
    // elements, so it went EMPTY at the aggregate altitudes (round 1, B5) —
    // exactly where a large estate arrives.
    expect(tree.length).toBeGreaterThan(0);
    expect(inTree.length).toBe(graph.nodes.length);
  });
});

/**
 * Falsification run against the reviewed bytes: 2 of these 6 go red — the
 * checker-visibility test and the one-pill-per-report test. The other FOUR
 * pass, and they pass VACUOUSLY: with no pill element kind, no pills are
 * placed, so "findOverlaps found nothing" is trivially true.
 *
 * That is exactly why the visibility test comes first. On its own, an empty
 * overlap result proves nothing about pills; it only becomes evidence once
 * the checker has been shown to REPORT a pill it should. Read the four
 * invariant tests as conditional on that first one, never as standalone
 * proof of the repair.
 */
describe('the plane layer stack (live-QA finding: pill painted under its band)', () => {
  // The pill was in the DOM with opacity 1, a real box, a dashed border and an
  // icon — and was invisible, because it had no z-index and the band paints
  // after it. jsdom cannot observe paint order, so this pins the DECLARED
  // stack instead: band < chip < lane header <= pill = tile.
  const css = readFileSync(
    new URL('./MapView.css', import.meta.url), 'utf8');

  const zIndexOf = (selector: string) => {
    const block = css.split(selector)[1]?.split('}')[0] ?? '';
    const match = block.match(/z-index:\s*(-?\d+)/);
    return match ? Number(match[1]) : null;
  };

  test('the Report pill sits on the tile layer, above its band', () => {
    const pill = zIndexOf('.map-report-pill {');
    const band = zIndexOf('.map-band {');
    const tile = zIndexOf('.map-tile {');
    expect(pill, '.map-report-pill must declare a z-index').not.toBeNull();
    expect(band).not.toBeNull();
    expect(tile).not.toBeNull();
    expect(pill!).toBeGreaterThan(band!);
    expect(pill!).toBe(tile!);
  });

  test('the stylesheet is actually readable, so the assertions above mean something', () => {
    // A `?raw` import of this file resolves empty under vitest; a silently
    // empty string would make every check above vacuously pass.
    expect(css.length).toBeGreaterThan(500);
    expect(css).toContain('.map-report-pill');
  });
});

describe('§2 topology is computed WITHIN THE PROJECT, not within the phase', () => {
  // Review ab5f3ca2 B1: computeDepths ran per band, so a dependency crossing a
  // phase boundary contributed nothing and the downstream task sat in its
  // upstream's column. The committed ordering test could not see it because it
  // narrows to same-phase pairs — the case that already worked.
  const twoPhaseProject = (): MapGraph => ({
    nodes: [
      { id: 'upstream', title: 'Upstream', status: 'in-progress', priority: 'high',
        project: 'Atlas', phaseId: 'phase-1', updated: '2026-08-16T10:00:00.000Z' },
      { id: 'downstream', title: 'Downstream', status: 'todo', priority: 'high',
        project: 'Atlas', phaseId: 'phase-2', updated: '2026-08-16T11:00:00.000Z' },
    ] as unknown as MapTaskNode[],
    // downstream depends on upstream.
    edges: [{ from: 'downstream', to: 'upstream', kind: 'dependency' }] as unknown as MapEdge[],
    phases: [
      { id: 'phase-1', name: 'Cutover', goal: null, position: 1, projectId: 'Atlas' },
      { id: 'phase-2', name: 'Decommission', goal: null, position: 2, projectId: 'Atlas' },
    ] as unknown as MapPhase[],
  });

  const sizesFor = (graph: MapGraph) => ({
    ...Object.fromEntries(graph.nodes.map(node => [node.id, { w: 170, h: 90 }])),
    'lane:Atlas': { w: 180, h: 56 },
  });

  test('a dependency crossing phases still drives flow depth', () => {
    const graph = twoPhaseProject();
    const layout = layoutHorizontal(graph, sizesFor(graph));
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    const upstream = tiles.find(t => t.id === 'upstream');
    const downstream = tiles.find(t => t.id === 'downstream');

    expect(upstream.depth).toBe(0);
    // Depth is lane-wide: the phase boundary does not reset it.
    expect(downstream.depth).toBe(1);
  });

  test('the downstream tile sits in a LATER column than its upstream', () => {
    const graph = twoPhaseProject();
    const layout = layoutHorizontal(graph, sizesFor(graph));
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    const upstream = tiles.find(t => t.id === 'upstream');
    const downstream = tiles.find(t => t.id === 'downstream');

    // §2: "Done pools left, the working frontier is mid, next is right."
    expect(downstream.x).toBeGreaterThan(upstream.x);
  });

  test('the recorded graph still lays out without overlap under lane-wide depth', () => {
    // Changing what drives columns must not disturb the hard invariant.
    const graph = graphFromRecorded();
    expect(findOverlaps(layoutHorizontal(graph, measuredSizes(graph)).elements)).toEqual([]);
  });
});

describe('Report pills are placed elements, not decorations (review 51a17ab2 B2)', () => {
  test('THE CHECKER CAN SEE A PILL: a deliberately misplaced one is reported', () => {
    // This test exists because every other geometry test asserts an EMPTY
    // result, and a checker blind to pills would pass all of them. That is
    // precisely how the reviewed defect survived: findOverlaps compared
    // tile|band|chip|lane, so a pill could sit on a tile unseen.
    const graph = withReports(graphFromRecorded());
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    const pill = layout.elements.find(element => element.kind === 'pill')!;
    const tile = layout.elements.find(element => element.kind === 'tile')!;
    expect(pill).toBeTruthy();

    // Drop the pill exactly on top of a tile.
    const sabotaged = layout.elements.map(element =>
      element.id === pill.id ? { ...element, x: tile.x, y: tile.y } : element);

    const found = findOverlaps(sabotaged);
    expect(found.some(([a, b]) => a === pill.id || b === pill.id)).toBe(true);
  });

  test('a pill never overlaps the next column, at the reviewed geometry', () => {
    // The reviewed defect in numbers: pill spanned 178..202 (tile edge 170 +
    // 8 margin + 24 box) while the next column started at 194 (tileGapX 24).
    // The column must now reserve the strip.
    const graph = withReports(graphFromRecorded());
    const layout = layoutHorizontal(graph, withPillSizes(graph, { w: 24, h: 24 }));
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('the invariant holds when pills are far larger than their fallback', () => {
    // A pill is MEASURED. If the layout secretly relied on the 24px in the
    // stylesheet, a wider measured pill would overlap the next column.
    const graph = withReports(graphFromRecorded(), 3);
    const layout = layoutHorizontal(graph, withPillSizes(graph, { w: 96, h: 40 }));
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('a report citing three tasks puts a marker beside EACH of them', () => {
    // Pins the owner-walkthrough repair. An earlier cut placed ONE pill per
    // report at the lowest-id cited task, so the other citing tasks showed no
    // marker at all and their edge ran off the viewport. §3 wants the marker
    // beside its task.
    const base = graphFromRecorded();
    const [first, second, third] = base.nodes;
    const graph: MapGraph = {
      ...base,
      reports: [
        { id: 'shared', taskId: first.id, title: 'Cites three' },
        { id: 'shared', taskId: second.id, title: 'Cites three' },
        { id: 'shared', taskId: third.id, title: 'Cites three' },
      ],
    };
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    const pills = layout.elements.filter(element => element.kind === 'pill') as any[];
    expect(pills).toHaveLength(3);
    expect(pills.map(pill => pill.taskId).sort())
      .toEqual([first.id, second.id, third.id].sort());
    // Ids are unique per PAIR, or React would see duplicate keys.
    expect(new Set(pills.map(pill => pill.id)).size).toBe(3);
  });

  test('each pill sits beside the task it belongs to, not somewhere across the plane', () => {
    // The defect the owner saw was a dashed line arriving from off-screen. A
    // pill must be adjacent to ITS task, so the edge is short and local.
    const graph = withReports(graphFromRecorded());
    const layout = layoutHorizontal(graph, withPillSizes(graph, { w: 24, h: 24 }));
    const tiles = new Map(layout.elements
      .filter(element => element.kind === 'tile').map(tile => [tile.id, tile]));
    const pills = layout.elements.filter(element => element.kind === 'pill') as any[];
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) {
      const tile = tiles.get(pill.taskId)!;
      expect(tile, `pill ${pill.id} has no tile`).toBeTruthy();
      // Immediately to the right of its tile, and vertically within its span.
      expect(pill.x).toBeGreaterThanOrEqual(tile.x + tile.w);
      expect(pill.x).toBeLessThan(tile.x + tile.w + 64);
      expect(pill.y).toBeGreaterThanOrEqual(tile.y);
    }
  });

  test('a duplicate (report, task) pair collapses to one pill', () => {
    // The linkage query matches through two arms; a report satisfying both
    // must not become two pills sharing a key.
    const base = graphFromRecorded();
    const task = base.nodes[0].id;
    const graph: MapGraph = { ...base, reports: [
      { id: 'dup', taskId: task, title: 'Dup' },
      { id: 'dup', taskId: task, title: 'Dup' },
    ] };
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    expect(layout.elements.filter(element => element.kind === 'pill')).toHaveLength(1);
  });

  test('a report citing a task OUTSIDE the scope is not placed', () => {
    const base = graphFromRecorded();
    const graph: MapGraph = {
      ...base,
      reports: [{ id: 'orphan', taskId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', title: 'Out of scope' }],
    };
    const layout = layoutHorizontal(graph, measuredSizes(graph));
    expect(layout.elements.filter(element => element.kind === 'pill')).toHaveLength(0);
  });

  test('PROPERTY: 200 randomised graphs, hostile sizes, zero overlaps', () => {
    // Deterministic pseudo-random so any failure is reproducible from its seed.
    const rng = (seed: number) => () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = rng(seed);
      const base = graphFromRecorded();
      const graph: MapGraph = {
        ...base,
        reports: base.nodes.flatMap((node, index) =>
          Array.from({ length: Math.floor(random() * 4) }, (_unused, n) => ({
            id: `r-${index}-${n}`, taskId: node.id, title: `Report ${index}-${n}`,
          }))),
      };
      const sizes: Record<string, { w: number; h: number }> = {};
      graph.nodes.forEach(node => {
        sizes[node.id] = {
          w: 40 + Math.floor(random() * 260),
          h: 30 + Math.floor(random() * 140),
        };
      });
      for (const project of new Set(graph.nodes.map(n => n.project ?? '__no_project__'))) {
        sizes[`lane:${project}`] = { w: 180, h: 56 };
      }
      // Pills that are WIDER than their tile, and pills of zero size as a
      // first paint reports, are both in range here.
      for (const report of graph.reports ?? []) {
        sizes[`pill:${report.id}`] = {
          w: Math.floor(random() * 300),
          h: Math.floor(random() * 60),
        };
      }
      const found = findOverlaps(layoutHorizontal(graph, sizes).elements);
      expect(found, `seed ${seed} produced ${found.length} overlap(s)`).toEqual([]);
    }
  });

  test('pills stay inside the band that contains their tile', () => {
    const graph = withReports(graphFromRecorded(), 2);
    const layout = layoutHorizontal(graph, withPillSizes(graph, { w: 40, h: 28 }));
    const bands = layout.elements.filter(element => element.kind === 'band');
    for (const pill of layout.elements.filter(element => element.kind === 'pill')) {
      const band = bands.find(b =>
        pill.x >= b.x && pill.y >= b.y &&
        pill.x + pill.w <= b.x + b.w && pill.y + pill.h <= b.y + b.h);
      expect(band, `pill ${pill.id} escaped every band`).toBeTruthy();
    }
  });
});

/* ======================================================================
 * ZOOM AGGREGATION HIERARCHY — design 77950a97 amendment §2/§5-A2.
 *
 * Written under the same two disciplines as the rest of this file: the small
 * estate is the RECORDED fixture, and geometry is asserted by the independent
 * `findOverlaps` checker rather than by the layout agreeing with itself.
 *
 * The large estate is SYNTHETIC and says so. It reproduces the SHAPE the A8
 * battery measured on DEV — 55 projects x 4 phases, ~5,200 tasks, ~578 edges,
 * so nearly every task is depth 0 — because no recorded fixture of that size
 * exists. It is not a substitute for the live measurement the card requires;
 * it is the unit-level reproduction of the defect.
 * ====================================================================== */

const scaleEstate = (
  projects = 55, phasesPer = 4, perProject = 95, edgeCount = 578,
): MapGraph => {
  const nodes: MapTaskNode[] = [];
  const phases: MapPhase[] = [];
  const statuses = ['todo', 'in-progress', 'completed', 'stuck', 'review'];
  for (let p = 0; p < projects; p += 1) {
    for (let f = 0; f < phasesPer; f += 1) {
      phases.push({
        id: `phase-${p}-${f}`, name: `Phase ${f}`, goal: null,
        projectId: `proj-${p}`, position: f,
      });
    }
    for (let t = 0; t < perProject; t += 1) {
      nodes.push({
        id: `task-${p}-${t}`,
        title: `Task ${p}-${t}`,
        status: statuses[(p + t) % statuses.length],
        priority: 'normal',
        project: `Project ${String(p).padStart(2, '0')}`,
        phaseId: `phase-${p}-${t % phasesPer}`,
        updated: `2026-08-1${t % 9}T00:00:00.000Z`,
        agent: t % 37 === 0 ? `agent-${p}` : null,
        progress: null,
      });
    }
  }
  const edges: MapEdge[] = [];
  for (let e = 0; e < edgeCount; e += 1) {
    const p = e % projects;
    const a = (e * 7) % perProject;
    const b = (e * 13 + 1) % perProject;
    // Every 5th edge crosses to the next project, so the roll-up is exercised
    // on real cross-aggregate relationships and not only internal ones.
    const q = e % 5 === 0 ? (p + 1) % projects : p;
    if (p === q && a === b) continue;
    edges.push({ from: `task-${p}-${a}`, to: `task-${q}-${b}`, kind: 'dependency' });
  }
  return { nodes, edges, phases };
};

/** Every aggregate measured at the documented fallback box. */
const aggregateSizes = (graph: MapGraph, altitude: MapAltitude): SizeMap =>
  Object.fromEntries(buildAggregates(graph, altitude).map(a => [a.id, { ...FALLBACK_AGGREGATE }]));

const allSizes = (graph: MapGraph): SizeMap => ({
  ...Object.fromEntries(graph.nodes.map(n => [n.id, { ...FALLBACK_TILE }])),
  ...aggregateSizes(graph, 'phase'),
  ...aggregateSizes(graph, 'project'),
});

const VIEWPORT = { width: 1160, height: 746 };
const options = { clampScale, viewport: VIEWPORT };

describe('altitude aggregation (amendment §2/§5-A2)', () => {
  const big = scaleEstate();
  const small = graphFromRecorded();

  test('the defect reproduces: the task altitude cannot be fitted at estate scale', () => {
    const layout = layoutAtAltitude(big, allSizes(big), 'task', 1160 / 746);
    // 1,600 wide against half a million tall — the single column the A8
    // battery photographed. The assertion is on the ASPECT, which is what
    // makes it unfittable, not on a pixel count that depends on the fixture.
    expect(layout.height / layout.width).toBeGreaterThan(100);
    const fitted = fitScaleFor(layout, options);
    const tile = meanNodeWidth(layout, 'task')!;
    expect(tile * fitted).toBeLessThan(ALTITUDE_NODE_PX.ascendBelow);
  });

  test('aggregate altitudes spread across BOTH axes (requirement 4)', () => {
    for (const altitude of ['phase', 'project'] as const) {
      const layout = layoutAtAltitude(big, allSizes(big), altitude, 1160 / 746);
      const xs = new Set(layout.elements.map(e => e.x));
      const ys = new Set(layout.elements.map(e => e.y));
      // rh-map-lod's failure was ONE column: 220 rows, every node at one x.
      expect(xs.size).toBeGreaterThan(1);
      expect(ys.size).toBeGreaterThan(1);
      // The grid tracks the viewport's aspect rather than running off an axis.
      expect(layout.width / layout.height).toBeGreaterThan(0.5);
      expect(layout.width / layout.height).toBeLessThan(4);
      expect(findOverlaps(layout.elements)).toEqual([]);
    }
  });

  test('a fresh view arrives at the finest altitude that reads (A2 governing principle)', () => {
    const bigArrival = initialAltitude(big, allSizes(big), options);
    expect(bigArrival.altitude).not.toBe('task');
    const bigLayout = layoutAtAltitude(big, allSizes(big), bigArrival.altitude, 1160 / 746);
    expect(meanNodeWidth(bigLayout, bigArrival.altitude)! * bigArrival.scale)
      .toBeGreaterThanOrEqual(ALTITUDE_NODE_PX.ascendBelow);

    // The SAME rule, no task-count constant: the recorded 14-task estate has
    // room for its tiles, so it arrives at the task altitude.
    const smallArrival = initialAltitude(small, allSizes(small), options);
    expect(smallArrival.altitude).toBe('task');
  });

  test('settling is a FIXED POINT — the F4 oscillation guard', () => {
    for (const altitude of ['task', 'phase', 'project'] as const) {
      for (const scale of [0.12, 0.2, 0.34, 0.6, 1, 1.6, 2.5]) {
        const once = settleAltitude(big, allSizes(big), { altitude, scale }, options);
        const twice = settleAltitude(big, allSizes(big), once, options);
        // Settling an already-settled state must change NOTHING. If this ever
        // fails, content flickers under a stationary cursor at the boundary.
        expect(twice).toEqual(once);
      }
    }
  });

  test('a settled altitude sits clear of BOTH triggers', () => {
    for (const scale of [0.12, 0.5, 1, 2.5]) {
      const settled = settleAltitude(big, allSizes(big), { altitude: 'task', scale }, options);
      const layout = layoutAtAltitude(big, allSizes(big), settled.altitude, 1160 / 746);
      const width = meanNodeWidth(layout, settled.altitude);
      if (width === null) continue;
      const onScreen = width * settled.scale;
      // Not merely "did not transition" — actually inside the readable band,
      // unless the view's own clamp pinned the scale first.
      const pinned = settled.scale === clampScale(0) || settled.scale === clampScale(Infinity);
      if (!pinned) {
        expect(onScreen).toBeGreaterThanOrEqual(ALTITUDE_NODE_PX.ascendBelow);
        expect(onScreen).toBeLessThanOrEqual(ALTITUDE_NODE_PX.descendAbove);
      }
    }
  });

  test('edges roll up with multiplicity and NOTHING is silently dropped', () => {
    for (const altitude of ['phase', 'project'] as const) {
      const rollup = rollUpEdges(big, altitude);
      const rolled = rollup.edges.reduce((sum, e) => sum + e.multiplicity, 0);
      const internal = [...rollup.internal.values()]
        .reduce((a, b) => a + b.dependency + b.knowledge, 0);
      // A2: an aggregated edge may indicate multiplicity but may NEVER
      // silently drop a relationship below it. Every input edge is therefore
      // accounted for exactly once — as a drawn edge, as an internal count,
      // or as a dangling endpoint.
      expect(rolled + internal + rollup.danglingCount).toBe(big.edges.length);
      expect(rollup.edges.length).toBeGreaterThan(0);
    }
  });

  /**
   * Round 14 B1 (report 1e9d61e5): the internal count was a single untyped
   * integer, so one internal dependency and one internal Report link produced
   * IDENTICAL aggregate state — the kind §4 keeps meaningful at every zoom
   * was erased exactly where the reviewer's probe predicted. The hostile pair
   * here is the probe's own shape: two contractually different inputs that
   * the old model could not tell apart.
   */
  test('internal relationships keep their KIND at both aggregate altitudes (round 14 B1)', () => {
    const pair: MapTaskNode[] = ['a', 'b'].map((id, i) => ({
      id, title: `Task ${id}`, status: 'todo', priority: 'normal',
      project: 'P', phaseId: 'ph', updated: `2026-08-1${i}T00:00:00.000Z`,
      agent: null, progress: null,
    }));
    const dep = { from: 'a', to: 'b', kind: 'dependency' as const };
    const know = { from: 'a', to: 'b', kind: 'knowledge' as const };
    const graphOf = (edges: MapEdge[]): MapGraph =>
      ({ nodes: pair, edges, phases: [{ id: 'ph', name: 'Ph', goal: null, projectId: 'proj-P', position: 0 }] } as MapGraph);

    for (const altitude of ['phase', 'project'] as const) {
      const rollup = rollUpEdges(graphOf([dep, know]), altitude);
      expect(rollup.edges).toEqual([]);
      expect(rollup.danglingCount).toBe(0);
      const counts = [...rollup.internal.values()];
      expect(counts).toHaveLength(1);
      // Both present, per kind — not a merged total.
      expect(counts[0]).toEqual({ dependency: 1, knowledge: 1 });

      // And the reviewer's exact discriminator: a dependency-only input and a
      // knowledge-only input must produce DIFFERENT aggregate state.
      const depOnly = [...rollUpEdges(graphOf([dep]), altitude).internal.values()][0];
      const knowOnly = [...rollUpEdges(graphOf([know]), altitude).internal.values()][0];
      expect(depOnly).toEqual({ dependency: 1, knowledge: 0 });
      expect(knowOnly).toEqual({ dependency: 0, knowledge: 1 });
      expect(depOnly).not.toEqual(knowOnly);
    }
  });

  test('aggregate facts match the lane header for the same project', () => {
    const projects = buildAggregates(big, 'project');
    const layout = layoutHorizontal(big, allSizes(big));
    const lanes = layout.elements.filter((e): e is PlacedLaneHeader => e.kind === 'lane');
    for (const lane of lanes) {
      const key = lane.id.slice('lane:'.length);
      const aggregate = projects.find(p => p.laneKey === key);
      expect(aggregate).toBeDefined();
      // The two altitudes are the same estate. A reader moving between them
      // must not see the numbers change.
      expect(aggregate!.taskCount).toBe(lane.taskCount);
      expect(aggregate!.agentsLive).toBe(lane.agentsLive);
      expect(aggregate!.stuck).toBe(lane.stuck);
      expect(aggregate!.upNext).toBe(lane.upNext);
      expect(aggregate!.progress).toBe(lane.progress);
    }
  });

  test('every Task is in exactly one aggregate at every altitude', () => {
    for (const altitude of ['phase', 'project'] as const) {
      const seen = new Set<string>();
      for (const aggregate of buildAggregates(big, altitude)) {
        for (const id of aggregate.taskIds) {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }
      }
      expect(seen.size).toBe(big.nodes.length);
    }
  });

  test('a null project and a null phase get real aggregates, not a hidden bucket', () => {
    // The recorded fixture carries both: 8 of 14 tasks with NO phase and a
    // task with a null project. They are real groups and must stay reachable.
    const phaseAggregates = buildAggregates(small, 'phase');
    const projectAggregates = buildAggregates(small, 'project');
    expect(phaseAggregates.some(a => a.label === 'No phase')).toBe(true);
    expect(projectAggregates.some(a => a.label === 'No project')).toBe(true);
    const total = projectAggregates.reduce((sum, a) => sum + a.taskCount, 0);
    expect(total).toBe(small.nodes.length);
  });
});

describe('Reports across the altitudes (amendment §2/§5-A2.1)', () => {
  /** One Report cited by Tasks spread over several projects and phases. */
  const shared = (): MapGraph => {
    const base = scaleEstate(6, 3, 9, 20);
    return {
      ...base,
      reports: [
        // Same report id, four different Tasks, deliberately in different
        // projects — this is the case A2 calls "converging lines are the point".
        { id: 'report-shared', taskId: 'task-0-0', title: 'Shared design' },
        { id: 'report-shared', taskId: 'task-1-0', title: 'Shared design' },
        { id: 'report-shared', taskId: 'task-2-1', title: 'Shared design' },
        { id: 'report-shared', taskId: 'task-2-2', title: 'Shared design' },
        { id: 'report-local', taskId: 'task-3-0', title: 'One project only' },
      ],
    };
  };

  test('a shared Report draws ONCE, with an edge to each aggregate citing it', () => {
    const graph = shared();
    for (const altitude of ['phase', 'project'] as const) {
      const layout = layoutAtAltitude(graph, allSizes(graph), altitude, 1160 / 746);
      const reports = layout.elements.filter(e => e.kind === 'aggregate-report');
      // ONCE: five (report, task) rows, two distinct Reports, two nodes.
      expect(reports.length).toBe(2);
      const sharedNode = reports.find(r => (r as any).reportId === 'report-shared') as any;
      expect(sharedNode).toBeDefined();
      // An edge to EACH citing aggregate, and the citing set is deduplicated:
      // two Tasks in the same phase of project 2 converge to one line there.
      const expected = altitude === 'project' ? 3 : 4;
      expect(sharedNode.aggregateIds.length).toBe(expected);
      expect(new Set(sharedNode.aggregateIds).size).toBe(sharedNode.aggregateIds.length);
    }
  });

  test('Report nodes are collision-resolved against the clusters they converge on', () => {
    const graph = shared();
    for (const altitude of ['phase', 'project'] as const) {
      const layout = layoutAtAltitude(graph, allSizes(graph), altitude, 1160 / 746);
      // The independent checker, over the same boxes the DOM will paint.
      expect(findOverlaps(layout.elements)).toEqual([]);
    }
  });

  test('every Report node sits INSIDE the plane the canvas declares', () => {
    const graph = shared();
    for (const altitude of ['phase', 'project'] as const) {
      const layout = layoutAtAltitude(graph, allSizes(graph), altitude, 1160 / 746);
      for (const element of layout.elements) {
        // A7a live QA caught a pill that was in the DOM, had a real box, and
        // was invisible. A node outside the declared extent is the same class
        // of defect: present, unreachable by pan.
        expect(element.x).toBeGreaterThanOrEqual(0);
        expect(element.y).toBeGreaterThanOrEqual(0);
        expect(element.x + element.w).toBeLessThanOrEqual(layout.width);
        expect(element.y + element.h).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  test('the TASK altitude keeps per-(report, task) pills — the 1e0653e7 walkthrough', () => {
    const graph = shared();
    const layout = layoutAtAltitude(graph, allSizes(graph), 'task', 1160 / 746);
    const pills = layout.elements.filter(e => e.kind === 'pill');
    // Five rows, five pills: one beside each citing Task, NOT one per Report.
    // Amendment §2/§5-A2.1 keeps this altitude exactly as the owner ruled it
    // at the 2026-08-17 walkthrough; the draw-once form is the aggregate
    // altitudes' behaviour and must not leak down here.
    expect(pills.length).toBe(5);
    expect(layout.elements.some(e => e.kind === 'aggregate-report')).toBe(false);
  });

  test('a Report citing a Task outside the fetched scope is not drawn', () => {
    const graph = shared();
    const withStray: MapGraph = {
      ...graph,
      reports: [...(graph.reports ?? []), { id: 'report-stray', taskId: 'not-in-scope', title: 'Elsewhere' }],
    };
    const layout = layoutAtAltitude(withStray, allSizes(withStray), 'project', 1160 / 746);
    const ids = layout.elements
      .filter(e => e.kind === 'aggregate-report')
      .map(e => (e as any).reportId);
    expect(ids).not.toContain('report-stray');
    expect(ids).toContain('report-shared');
  });
});

describe('landing after an altitude change (live-QA regression)', () => {
  const big = scaleEstate();
  const sizes = allSizes(big);
  const ASPECT = 1440 / 900;

  const layoutOf = (altitude: MapAltitude) => layoutAtAltitude(big, sizes, altitude, ASPECT);

  test('descending lands on the CHILDREN of the node under the cursor', () => {
    const phaseLayout = layoutOf('phase');
    const taskLayout = layoutOf('task');
    const phases = phaseLayout.elements.filter(e => e.kind === 'aggregate') as any[];
    // Pick a Phase well away from the origin, so a wrong answer that happens to
    // land near 0,0 cannot pass by luck.
    const target = phases[Math.floor(phases.length * 0.7)];
    const point = { x: target.x + target.w / 2, y: target.y + target.h / 2 };

    const box = focusBoxAcross(phaseLayout, 'phase', taskLayout, 'task', point)!;
    expect(box).not.toBeNull();

    // Every tile inside the returned box must belong to that Phase, and every
    // one of that Phase's tiles must be inside it. This is the assertion that
    // fails for a normalised-fraction remap: live QA measured offsetY -696,634
    // on a 1,495,990px plane, five tiles, none of them the Phase's.
    const wanted = new Set<string>(target.node.taskIds);
    const tiles = taskLayout.elements.filter((e): e is PlacedTile => e.kind === 'tile');
    const inBox = tiles.filter(t =>
      t.x >= box.x && t.x + t.w <= box.x + box.w &&
      t.y >= box.y && t.y + t.h <= box.y + box.h);
    expect(inBox.length).toBeGreaterThan(0);
    // The landing is a box a MATCHING child OWNS - not the union of every
    // match. Round 1 reproduced why the union is wrong: on a grid the matching
    // children wrap across rows, so the union spans foreign aggregates and its
    // centre belongs to nobody. "Contains all the wanted tiles" was therefore
    // both near-tautological and, for a correct implementation, false.
    //
    // What must hold is OWNERSHIP and LOCALITY: everything inside the landing
    // belongs to the focused set, and the landing is a small region of a
    // half-million-pixel plane rather than anywhere at all.
    const foreign = inBox.filter(t => !wanted.has(t.id));
    expect(foreign.length).toBe(0);
    expect(box.h).toBeLessThan(taskLayout.height / 20);
  });

  test('ascending lands on the PARENT of the tile under the cursor', () => {
    const taskLayout = layoutOf('task');
    const phaseLayout = layoutOf('phase');
    const tiles = taskLayout.elements.filter((e): e is PlacedTile => e.kind === 'tile');
    const tile = tiles[Math.floor(tiles.length * 0.6)];
    const point = { x: tile.x + tile.w / 2, y: tile.y + tile.h / 2 };

    const box = focusBoxAcross(taskLayout, 'task', phaseLayout, 'phase', point)!;
    expect(box).not.toBeNull();
    const parent = phaseLayout.elements.find(
      (e): e is PlacedAggregate => e.kind === 'aggregate' && e.node.taskIds.includes(tile.id),
    )!;
    expect(parent).toBeDefined();
    // The landing box is exactly the parent's box: one tile has one parent.
    expect(Math.round(box.x)).toBe(Math.round(parent.x));
    expect(Math.round(box.y)).toBe(Math.round(parent.y));
  });

  test('the coarsest altitude does not shrink below the readable floor', () => {
    // Live QA measured the project altitude bottoming out at SCALE_MIN with
    // 26px nodes — below the 40px floor, with nothing coarser to collapse into.
    const settled = settleAltitude(
      big, sizes, { altitude: 'project', scale: clampScale(0) }, { clampScale, viewport: VIEWPORT },
    );
    expect(settled.altitude).toBe('project');
    const width = meanNodeWidth(layoutOf('project'), 'project')!;
    expect(width * settled.scale).toBeGreaterThanOrEqual(ALTITUDE_NODE_PX.ascendBelow - 0.01);
  });
});

/* ======================================================================
 * Regressions for the four blocking findings of the adversarial pre-review
 * (report 33801b5c, candidate fd21191, REJECT).
 *
 * Each is the reviewer's own reproduction, committed. A repair that only makes
 * the reviewer stop complaining is worth nothing next round; the reproduction
 * is the thing that has to stay failing-if-broken.
 * ====================================================================== */
describe('pre-review 33801b5c blocking findings', () => {
  test('B2: a curve is clean along its WHOLE length, not just at t=0.5', () => {
    // The reviewer's case: an obstacle at t=0.25 that the midpoint test misses.
    const source: Box = { x: 0, y: 0, w: 10, h: 10 };
    const target: Box = { x: 110, y: 0, w: 10, h: 10 };
    const obstacle: Box = { x: 34, y: 8, w: 3, h: 3 };
    const route = routeEdge(source, target, [source, target, obstacle]);

    // Whatever offset it settled on, the drawn curve must not pass through the
    // obstacle at ANY sampled parameter while claiming to be clear.
    const match = /^M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)$/.exec(route.d);
    if (match) {
      const [, x1, y1, cx, cy, x2, y2] = match.map(Number);
      const crossings = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9]
        .map(t => quadraticPointAt(t, x1, y1, cx, cy, x2, y2))
        .filter(p => p.x >= obstacle.x && p.x <= obstacle.x + obstacle.w
          && p.y >= obstacle.y && p.y <= obstacle.y + obstacle.h);
      if (!route.clipped) expect(crossings).toEqual([]);
    }
  });

  test('B2: a self-dependency loops clear of its own node', () => {
    const box: Box = { x: 100, y: 100, w: 170, h: 96 };
    const route = routeEdge(box, box, [box]);
    expect(route.clipped).toBe(false);
    // A straight run from the right edge back to the left edge would cross the
    // tile end to end, so the loop must leave the box entirely - and it is now
    // VERIFIED rather than assumed (round 4, B2). It is an orthogonal loop for
    // the same reason the corridor router is: every segment is exactly
    // checkable, where a fixed cubic was returned before any check ran.
    const points = route.d.replace('M ', '').split(' L ')
      .map(p => p.trim().split(/\s+/).map(Number) as [number, number]);
    expect(points.length).toBeGreaterThan(2);
    const interior: Box = { x: box.x + 0.5, y: box.y + 0.5, w: box.w - 1, h: box.h - 1 };
    for (let i = 0; i < points.length - 1; i += 1) {
      expect(segmentIntersectsBox(
        points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], interior,
      )).toBe(false);
    }
    expect(Math.min(...points.map(p => p[1]))).toBeLessThan(box.y);
  });

  test('B3: overflow-lane Report placement never overlaps', () => {
    // The reviewer's reproduction: enough Reports citing one Phase that the
    // bounded spiral is exhausted and the overflow lane takes over.
    // A SMALL estate is what reproduces it: the overflow lane then starts close
    // enough to the centroid that the spiral reaches into it. A large grid
    // pushes the lane out of the spiral's radius and the bug hides — my first
    // attempt at this test used one and passed against the broken code.
    const base = scaleEstate(1, 1, 4, 0);
    const target = base.nodes[0].id;
    const graph: MapGraph = {
      ...base,
      reports: Array.from({ length: 40 }, (_unused, i) => ({
        id: `r${String(i).padStart(3, '0')}`, taskId: target, title: `Report ${i}`,
      })),
    };
    for (const altitude of ['phase', 'project'] as const) {
      const layout = layoutAtAltitude(graph, allSizes(graph), altitude, 1160 / 746);
      const reports = layout.elements.filter(e => e.kind === 'aggregate-report');
      expect(reports.length).toBe(40);
      // The independent checker over the same boxes the DOM will paint.
      expect(findOverlaps(layout.elements)).toEqual([]);
    }
  });

  test('B1: the fit is never spent on an altitude that is not on screen', () => {
    const none = new Set<MapAltitude>();
    // Arrival elsewhere: MOVE there and keep the debt, because that altitude
    // has never mounted and all of its boxes are fallbacks.
    expect(arrivalFitStep('task', 'phase', none)).toEqual({ action: 'move', to: 'phase' });
    expect(arrivalFitStep('project', 'task', none)).toEqual({ action: 'move', to: 'task' });
    // Arrival is what is already rendered: fit it.
    expect(arrivalFitStep('phase', 'phase', none)).toEqual({ action: 'fit' });
    // Termination: an altitude already visited is never moved to again, so two
    // altitudes cannot select each other forever as measurements arrive.
    expect(arrivalFitStep('task', 'phase', new Set<MapAltitude>(['phase'])))
      .toEqual({ action: 'fit' });
  });
});

/* ======================================================================
 * Regressions for the five blocking findings of review round 1
 * (report 198b46d5, candidate f16a51f, REJECT).
 * ====================================================================== */
describe('round 1 198b46d5 blocking findings', () => {
  test('B1: Report pills reserve the box the control actually paints', () => {
    const graph = graphFromRecorded();
    const task = graph.nodes[0].id;
    const withTwo: MapGraph = {
      ...graph,
      reports: [
        { id: 'r-a', taskId: task, title: 'Report A' },
        { id: 'r-b', taskId: task, title: 'Report B' },
      ],
    };
    // The PRODUCTION key is `pill:<report>:<task>`. The old helper wrote
    // `pill:<report>`, so the layout never found these sizes and silently used
    // the fallback — a hostile size that never reached the code under test.
    const sizes: SizeMap = {
      ...measuredSizes(withTwo),
      // 52, NOT 44: 44 is also FALLBACK_PILL, so asserting 44 would pass even
      // if the production key were never looked up at all.
      [`pill:r-a:${task}`]: { w: 52, h: 52 },
      [`pill:r-b:${task}`]: { w: 52, h: 52 },
    };
    const layout = layoutHorizontal(withTwo, sizes);
    const pills = layout.elements.filter(e => e.kind === 'pill');
    expect(pills.length).toBe(2);
    // Both must have taken the 44px measurement, not the fallback...
    for (const pill of pills) expect(pill.h).toBe(52);
    // ...and stacking them must not overlap at that size. This is what failed
    // live: a 24px wrapper measured against a 36/44px painted control.
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('B2: a long route does not cross a production-sized node', () => {
    // Round 1's reproduction: eleven samples are hundreds of pixels apart on a
    // long chord, and a 170x96 tile fits between two of them.
    const source: Box = { x: 0, y: 0, w: 170, h: 96 };
    const target: Box = { x: 3000, y: 0, w: 170, h: 96 };
    const obstacle: Box = { x: 877, y: 137, w: 170, h: 96 };
    const route = routeEdge(source, target, [source, target, obstacle]);
    const match = /^M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)$/.exec(route.d);
    expect(match).not.toBeNull();
    const [, x1, y1, cx, cy, x2, y2] = match!.map(Number);
    // The claim and the geometry must agree, checked by the EXACT test rather
    // than by more samples: no sample count can be a proof.
    const reallyCrosses = quadraticIntersectsBox(x1, y1, cx, cy, x2, y2, obstacle);
    if (!route.clipped) expect(reallyCrosses).toBe(false);
  });

  test('B2: the exact test finds a crossing that dense sampling misses', () => {
    // A control for the checker itself: a curve that provably enters the box.
    const box: Box = { x: 40, y: -60, w: 20, h: 200 };
    expect(quadraticIntersectsBox(0, 0, 50, 100, 100, 0, box)).toBe(true);
    // And one that provably does not.
    const far: Box = { x: 40, y: 400, w: 20, h: 20 };
    expect(quadraticIntersectsBox(0, 0, 50, 100, 100, 0, far)).toBe(false);
  });

  test('B4: descending lands on a box a MATCHING child owns', () => {
    // Round 1's shape: a wide aspect wraps the grid, so a union rectangle
    // would span foreign Projects and centre on one of them.
    const graph = scaleEstate(2, 2, 6, 0);
    const sizes = allSizes(graph);
    for (const aspect of [3, 16 / 10, 0.6]) {
      const from = layoutAtAltitude(graph, sizes, 'project', aspect);
      const to = layoutAtAltitude(graph, sizes, 'phase', aspect);
      for (const source of from.elements.filter((e): e is PlacedAggregate => e.kind === 'aggregate')) {
        const point = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
        const box = focusBoxAcross(from, 'project', to, 'phase', point)!;
        expect(box).not.toBeNull();
        // The landing's own centre must belong to a child of the source.
        const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
        const landed = focusedElement(to, 'phase', centre) as PlacedAggregate;
        const wanted = new Set(source.node.taskIds);
        expect(landed.node.taskIds.some(id => wanted.has(id))).toBe(true);
      }
    }
  });

  test('B5: the list alternative is complete at EVERY altitude', () => {
    const graph = scaleEstate(3, 2, 7, 4);
    const tree = buildTreeModel(graph);
    const inTree = tree.flatMap(l => l.bands.flatMap(b => b.nodes.map(n => n.id)));
    // §6 is altitude-independent: the alternative is derived from membership,
    // so an aggregate arrival cannot empty it. It used to be built from placed
    // lane/band/tile elements, which an aggregate layout does not contain.
    expect(tree.length).toBeGreaterThan(0);
    expect(inTree.slice().sort()).toEqual(graph.nodes.map(n => n.id).sort());
    for (const altitude of ['task', 'phase', 'project'] as const) {
      const layout = layoutAtAltitude(graph, allSizes(graph), altitude, 16 / 10);
      expect(layout.elements.length).toBeGreaterThan(0);
      // The tree does not change with the drawn altitude.
      expect(buildTreeModel(graph)).toEqual(tree);
    }
  });
});

/* ======================================================================
 * Regressions for review round 2 (report 82a9fbf7, candidate 561047a).
 * ====================================================================== */
describe('round 2 82a9fbf7 blocking findings', () => {
  /** Round 2's reproduction: four Projects x three Phases x ten Tasks. */
  const estate120 = (): MapGraph => {
    const base = scaleEstate(4, 3, 10, 0);
    const edges: MapEdge[] = [];
    // Dependencies that must cross stacked lane geometry - the case a bow
    // cannot solve however far it bends.
    for (let p = 0; p < 4; p += 1) {
      for (let t = 0; t < 10; t += 1) {
        edges.push({
          from: `task-${p}-${t}`,
          to: `task-${(p + 1) % 4}-${(t + 3) % 10}`,
          kind: 'dependency',
        });
      }
    }
    return { ...base, edges };
  };

  test('B1: NO rendered route crosses a node, at any altitude', () => {
    const graph = estate120();
    const sizes = allSizes(graph);
    for (const altitude of ['task', 'phase', 'project'] as const) {
      const layout = layoutAtAltitude(graph, sizes, altitude, 1440 / 900);
      const kind = altitude === 'task' ? 'tile' : 'aggregate';
      const nodes = layout.elements.filter(e => e.kind === kind) as Box[];
      const byId = new Map(
        layout.elements.filter(e => e.kind === kind).map(e => [(e as any).id, e as Box]),
      );
      const pairs = altitude === 'task'
        ? graph.edges.map(e => [e.to, e.from] as const)
        : rollUpEdges(graph, altitude).edges.map(e => [e.to, e.from] as const);

      let drawn = 0;
      let clipped = 0;
      for (const [sourceId, targetId] of pairs) {
        const source = byId.get(sourceId);
        const target = byId.get(targetId);
        if (!source || !target) continue;
        drawn += 1;
        if (routeEdge(source, target, nodes).clipped) clipped += 1;
      }
      expect(drawn).toBeGreaterThan(0);
      // Round 2 measured task drawn=168 clipped=30 and project drawn=3
      // clipped=1, and MapView rendered every one of them as an ordinary
      // connection. A route the engine KNOWS crosses a node is not a route.
      expect(clipped).toBe(0);
    }
  });

  test('B1: a route that cannot be curved goes AROUND, and is verified', () => {
    // A column of tiles between the endpoints: no bow clears it.
    const source: Box = { x: 0, y: 300, w: 170, h: 96 };
    const target: Box = { x: 900, y: 300, w: 170, h: 96 };
    const wall: Box[] = Array.from({ length: 9 }, (_unused, i) => (
      { x: 500, y: i * 110, w: 170, h: 96 }
    ));
    const route = routeEdge(source, target, [source, target, ...wall]);
    expect(route.clipped).toBe(false);
    // WHICHEVER FORM it returns. An earlier version of this test demanded the
    // polyline and failed against correct code: a bow with enough offset
    // clears this wall over the top, and a curve is the better answer when one
    // exists. What must hold is that the returned path is genuinely clear -
    // checked here independently of how it was produced.
    const q = /^M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)$/.exec(route.d);
    if (q) {
      const [, x1, y1, cx, cy, x2, y2] = q.map(Number);
      for (const box of wall) {
        expect(quadraticIntersectsBox(x1, y1, cx, cy, x2, y2, box)).toBe(false);
      }
    } else {
      const points = route.d.replace('M ', '').split(' L ')
        .map(pair => pair.trim().split(/\s+/).map(Number) as [number, number]);
      expect(points.length).toBeGreaterThan(2);
      for (let i = 0; i < points.length - 1; i += 1) {
        for (const box of wall) {
          expect(segmentIntersectsBox(
            points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], box,
          )).toBe(false);
        }
      }
    }
  });

  test('segmentIntersectsBox discriminates', () => {
    const box: Box = { x: 100, y: 100, w: 50, h: 50 };
    expect(segmentIntersectsBox(0, 125, 200, 125, box)).toBe(true);   // straight through
    expect(segmentIntersectsBox(0, 0, 90, 90, box)).toBe(false);      // stops short
    expect(segmentIntersectsBox(0, 300, 200, 300, box)).toBe(false);  // passes under
    expect(segmentIntersectsBox(125, 0, 125, 200, box)).toBe(true);   // vertical through
  });
});

/* ======================================================================
 * Regressions for review round 3 (report f78f2387, candidate d16d089).
 * Round 3's own reproductions, committed.
 * ====================================================================== */
describe('round 3 f78f2387 blocking findings', () => {
  /** Round 3's grid: ordinary 170x96 boxes with 28px gaps both ways. */
  const grid = (cols: number, rows: number): Box[] => {
    const out: Box[] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        out.push({ x: c * (170 + 28), y: r * (96 + 28), w: 170, h: 96 });
      }
    }
    return out;
  };
  const envelopeOf = (boxes: Box[]): Box => ({
    x: 0, y: 0,
    w: Math.max(...boxes.map(b => b.x + b.w)) + 32,
    h: Math.max(...boxes.map(b => b.y + b.h)) + 32,
  });
  /** Independent crossing count over whichever form the router returned. */
  const crossings = (d: string, obstacles: readonly Box[]) => {
    const q = /^M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)$/.exec(d);
    if (q) {
      const [, x1, y1, cx, cy, x2, y2] = q.map(Number);
      return obstacles.filter(b => quadraticIntersectsBox(x1, y1, cx, cy, x2, y2, b)).length;
    }
    const points = d.replace('M ', '').split(' L ')
      .map(p => p.trim().split(/\s+/).map(Number) as [number, number]);
    let hits = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      for (const box of obstacles) {
        if (segmentIntersectsBox(
          points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], box)) hits += 1;
      }
    }
    return hits;
  };

  test('B1: dense grids route clear — 81 boxes and 400 boxes', () => {
    for (const [cols, rows] of [[9, 9], [20, 20]] as const) {
      const boxes = grid(cols, rows);
      const envelope = envelopeOf(boxes);
      const source = boxes[0];
      const target = boxes[11];
      const others = boxes.filter(b => b !== source && b !== target);
      const route = routeEdge(source, target, boxes, envelope);
      // Round 3 measured nine crossings on the 81-box grid and twenty on the
      // 400-box grid, each returned as clipped:true and rendered anyway.
      expect(route.clipped).toBe(false);
      expect(crossings(route.d, others)).toBe(0);
    }
  });

  test('B1: a target left of AND above its source routes clear', () => {
    const boxes = grid(9, 9);
    const source = boxes[40];
    const target = boxes[2];
    const others = boxes.filter(b => b !== source && b !== target);
    const route = routeEdge(source, target, boxes, envelopeOf(boxes));
    expect(route.clipped).toBe(false);
    expect(crossings(route.d, others)).toBe(0);
  });

  test('B2: an accepted route stays INSIDE the plane the canvas declares', () => {
    // Round 3's wall: the old ladder cleared it with a bow whose midpoint sat
    // 126 units ABOVE the plane. Both .map-view and .map-canvas clip their
    // overflow, so that connection was painted as two stubs reaching the
    // boundary. Clear is necessary; visible is the other half.
    const source: Box = { x: 0, y: 300, w: 170, h: 96 };
    const target: Box = { x: 900, y: 300, w: 170, h: 96 };
    const wall: Box[] = Array.from({ length: 9 }, (_unused, i) => (
      { x: 500, y: i * 110, w: 170, h: 96 }
    ));
    const all = [source, target, ...wall];
    const envelope = envelopeOf(all);
    const route = routeEdge(source, target, all, envelope);
    expect(route.clipped).toBe(false);
    expect(crossings(route.d, wall)).toBe(0);

    // Every point of the accepted path lies within the envelope.
    const q = /^M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)$/.exec(route.d);
    if (q) {
      const bounds = quadraticBounds(
        ...(q.slice(1).map(Number) as [number, number, number, number, number, number]));
      expect(bounds.y).toBeGreaterThanOrEqual(envelope.y);
      expect(bounds.y + bounds.h).toBeLessThanOrEqual(envelope.y + envelope.h);
      expect(bounds.x).toBeGreaterThanOrEqual(envelope.x);
      expect(bounds.x + bounds.w).toBeLessThanOrEqual(envelope.x + envelope.w);
    } else {
      const points = route.d.replace('M ', '').split(' L ')
        .map(p => p.trim().split(/\s+/).map(Number) as [number, number]);
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(envelope.x);
        expect(y).toBeGreaterThanOrEqual(envelope.y);
        expect(x).toBeLessThanOrEqual(envelope.x + envelope.w);
        expect(y).toBeLessThanOrEqual(envelope.y + envelope.h);
      }
    }
  });

  test('quadraticBounds reports the CURVE box, not the control hull', () => {
    // The control point is not on the curve, so a hull-based bound would
    // over-report and reject routes that are actually inside the plane.
    const bounds = quadraticBounds(0, 0, 50, 100, 100, 0);
    expect(bounds.y).toBe(0);
    // Apex of this curve is at y=50, not at the control point's y=100.
    expect(bounds.y + bounds.h).toBeCloseTo(50, 6);
  });
});

describe('§4 density collapse reaches the aggregate altitudes', () => {
  const edges = (n: number) =>
    Array.from({ length: n }, (_u, i) => ({ from: `a${i}`, to: `b${i}` }));

  test('below the threshold every edge is drawn', () => {
    const all = edges(10);
    expect(collapseDenseEdges(all, 60, null)).toEqual(all);
    expect(collapseDenseEdges(all, 60, 'a3')).toEqual(all);
  });

  test('above it, nothing is drawn until something is lit', () => {
    // The seeded estate produces 474 Phase-to-Phase edges over 193 nodes -
    // eight times the design's threshold, and a hairball that answers none of
    // §1's questions. §4 collapses exactly this case one altitude down.
    const all = edges(474);
    expect(collapseDenseEdges(all, 60, null)).toEqual([]);
    const lit = collapseDenseEdges(all, 60, 'a17');
    expect(lit).toHaveLength(1);
    expect(lit[0]).toEqual({ from: 'a17', to: 'b17' });
  });

  test('it collapses what is PAINTED, never what was rolled up', () => {
    // The roll-up still accounts for every relationship - A2's no-silent-drop
    // rule is about the model, and this rule is about the frame.
    const graph = scaleEstate(4, 3, 10, 40);
    const rollup = rollUpEdges(graph, 'phase');
    const painted = collapseDenseEdges(rollup.edges, 1, null);
    expect(painted).toEqual([]);
    const accounted = rollup.edges.reduce((sum, e) => sum + e.multiplicity, 0)
      + [...rollup.internal.values()].reduce((a, b) => a + b.dependency + b.knowledge, 0)
      + rollup.danglingCount;
    expect(accounted).toBe(graph.edges.length);
  });
});

/* ======================================================================
 * Regressions for review round 4 (report 4537e51c, candidate ca81907).
 * ====================================================================== */
describe('round 4 4537e51c blocking findings', () => {
  /** The reviewer's oracle: shrink each endpoint so TOUCHING its attachment is
   *  allowed but entering its interior is not. */
  const interiorOf = (box: Box): Box => ({
    x: box.x + 0.001, y: box.y + 0.001,
    w: box.w - 0.002, h: box.h - 0.002,
  });
  const pointsOf = (d: string) => d.replace('M ', '').split(' L ')
    .map(p => p.trim().split(/\s+/).map(Number) as [number, number]);
  const entersBox = (d: string, box: Box) => {
    const q = /^M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)$/.exec(d);
    if (q) {
      const [, x1, y1, cx, cy, x2, y2] = q.map(Number);
      return quadraticIntersectsBox(x1, y1, cx, cy, x2, y2, box);
    }
    // An oracle that cannot read the path must SAY SO. Returning false for an
    // unrecognised form is how the first cut of these tests let the old
    // unverified cubic self-loop pass a crossing check it plainly failed.
    if (!d.includes(' L ')) {
      throw new Error(`crossing oracle cannot verify this path form: ${d}`);
    }
    const points = pointsOf(d);
    for (let i = 0; i < points.length - 1; i += 1) {
      if (segmentIntersectsBox(
        points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], box)) return true;
    }
    return false;
  };

  test('B1: a REVERSE edge does not run through either node it connects', () => {
    // Round 4's case: the router always left by the source's right edge and
    // entered by the target's left, so an edge whose target sits to the LEFT
    // doubled back through both endpoints while reporting clipped:false.
    const source: Box = { x: 300, y: 100, w: 170, h: 60 };
    const target: Box = { x: 0, y: 100, w: 170, h: 60 };
    const envelope: Box = { x: -200, y: -200, w: 900, h: 700 };
    const route = routeEdge(source, target, [source, target], envelope);
    expect(route.clipped).toBe(false);
    expect(entersBox(route.d, interiorOf(source))).toBe(false);
    expect(entersBox(route.d, interiorOf(target))).toBe(false);
  });

  test('B1: a target left of AND above does not run through either node', () => {
    const source: Box = { x: 400, y: 400, w: 170, h: 96 };
    const target: Box = { x: 40, y: 40, w: 170, h: 96 };
    const envelope: Box = { x: -200, y: -200, w: 1200, h: 1000 };
    const route = routeEdge(source, target, [source, target], envelope);
    expect(route.clipped).toBe(false);
    expect(entersBox(route.d, interiorOf(source))).toBe(false);
    expect(entersBox(route.d, interiorOf(target))).toBe(false);
  });

  test('B2: a self-loop stays inside a tight envelope', () => {
    // Round 4: the fixed cubic loop was returned before any check ran, so it
    // left the plane (minY -25.5 against an envelope starting at 0).
    const box: Box = { x: 10, y: 10, w: 100, h: 40 };
    const envelope: Box = { x: 0, y: 0, w: 400, h: 300 };
    const route = routeEdge(box, box, [box], envelope);
    // EVERY coordinate in the path, whatever command produced it. A self-loop
    // is an orthogonal polyline by construction, so its coordinates ARE its
    // geometry - and parsing only ` L ` would silently skip a cubic, which is
    // exactly the unverified form round 4 rejected.
    const coords = [...route.d.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
    const xs = coords.filter((_v, i) => i % 2 === 0);
    const ys = coords.filter((_v, i) => i % 2 === 1);
    if (!route.clipped) {
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(envelope.x);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(envelope.y);
      expect(Math.max(...xs)).toBeLessThanOrEqual(envelope.x + envelope.w);
      expect(Math.max(...ys)).toBeLessThanOrEqual(envelope.y + envelope.h);
    }
  });

  test('B2: a self-loop clears an adjacent node', () => {
    const box: Box = { x: 100, y: 100, w: 170, h: 96 };
    // Positioned where round 4 measured the old fixed cubic passing through.
    const above: Box = { x: 60, y: 50, w: 240, h: 60 };
    const envelope: Box = { x: -400, y: -400, w: 1400, h: 1200 };
    const route = routeEdge(box, box, [box, above], envelope);
    expect(route.clipped).toBe(false);
    // Round 4 measured the old loop crossing exactly this ordinary neighbour.
    expect(entersBox(route.d, above)).toBe(false);
    expect(entersBox(route.d, interiorOf(box))).toBe(false);
  });

  test('endpoint interiors are obstacles for ORDINARY edges too', () => {
    // A third node sitting between two endpoints must still be avoided, and
    // neither endpoint may be traversed on the way.
    const source: Box = { x: 0, y: 200, w: 170, h: 96 };
    const target: Box = { x: 800, y: 200, w: 170, h: 96 };
    const between: Box = { x: 400, y: 180, w: 170, h: 140 };
    const envelope: Box = { x: -300, y: -300, w: 1600, h: 1200 };
    const route = routeEdge(source, target, [source, target, between], envelope);
    expect(route.clipped).toBe(false);
    expect(entersBox(route.d, between)).toBe(false);
    expect(entersBox(route.d, interiorOf(source))).toBe(false);
    expect(entersBox(route.d, interiorOf(target))).toBe(false);
  });
});

/* ======================================================================
 * Regressions for review round 5 (report b03f6be6, candidate 7b9e645).
 * ====================================================================== */
describe('round 5 b03f6be6 blocking finding', () => {
  const edge = (from: string, to: string) => ({ from, to });

  test('B1: SAME-LANE edges survive the collapse; §4 collapses cross-lane only', () => {
    const lanes: Record<string, string> = {};
    const edges: Array<{ from: string; to: string }> = [];
    // 40 same-project Phase-to-Phase edges and 40 cross-project ones: 80 total,
    // comfortably over the threshold.
    for (let i = 0; i < 40; i += 1) {
      lanes[`p${i}a`] = `project${i}`; lanes[`p${i}b`] = `project${i}`;
      edges.push(edge(`p${i}a`, `p${i}b`));
    }
    for (let i = 0; i < 40; i += 1) {
      lanes[`x${i}`] = `projectX${i}`; lanes[`y${i}`] = `projectY${i}`;
      edges.push(edge(`x${i}`, `y${i}`));
    }
    const crossLane = (e: { from: string; to: string }) => lanes[e.from] !== lanes[e.to];

    const painted = collapseDenseEdges(edges, 60, null, crossLane);
    // Round 5: collapsing EVERYTHING left the phase altitude arriving with no
    // dependency edges at all, which is the "shows nothing useful" defect A2
    // names - produced by the rule meant to keep the picture readable.
    expect(painted).toHaveLength(40);
    expect(painted.every(e => !crossLane(e))).toBe(true);

    // A lit node brings its cross-lane edges back on top of those.
    const lit = collapseDenseEdges(edges, 60, 'x7', crossLane);
    expect(lit).toHaveLength(41);
    expect(lit.some(e => e.from === 'x7')).toBe(true);
  });

  test('B1: with no lane information every edge is treated as cross-lane', () => {
    // The project altitude: every node IS a lane, so nothing is same-lane.
    const edges = Array.from({ length: 80 }, (_u, i) => edge(`a${i}`, `b${i}`));
    expect(collapseDenseEdges(edges, 60, null)).toEqual([]);
    expect(collapseDenseEdges(edges, 60, 'a3')).toHaveLength(1);
  });
});

/* ======================================================================
 * Regressions for review round 6 (report 1392f386, candidate 901cbfa).
 * ====================================================================== */
describe('round 6 1392f386 blocking findings', () => {
  const facts = (over: Partial<ReturnType<typeof aggregateFactsOf>>) => ({
    taskCount: 4, completed: 0, archived: 0, agentsLive: 0, stuck: 0, upNext: 4,
    inFlight: 0, progress: 0, ...over,
  });

  test('B1: an aggregate carries §4 chain state, with the tile rule precedence', () => {
    // §4 is untouched by A2 and requires dependency edges coloured by upstream
    // chain state at EVERY zoom. The aggregate altitudes drew one flat colour.
    expect(aggregateChainState(facts({ stuck: 1, inFlight: 2 }))).toBe('dammed');
    expect(aggregateChainState(facts({ inFlight: 1 }))).toBe('active');
    expect(aggregateChainState(facts({ completed: 4, upNext: 0 }))).toBe('satisfied');
    expect(aggregateChainState(facts({}))).toBe('neutral');
    // A dammed flow outranks an in-flight one, exactly as it does on a tile.
    expect(aggregateChainState(facts({ stuck: 1, completed: 4 }))).toBe('dammed');
    // An empty aggregate is not "fully satisfied".
    expect(aggregateChainState(facts({ taskCount: 0, completed: 0, upNext: 0 }))).toBe('neutral');
  });

  test('B1: inFlight is counted, not inferred by subtraction', () => {
    const nodes = [
      { id: 'a', title: 'a', status: 'in-progress', priority: 'normal', project: 'P',
        phaseId: null, updated: '2026-08-18T00:00:00.000Z', agent: null, progress: null },
      { id: 'b', title: 'b', status: 'review', priority: 'normal', project: 'P',
        phaseId: null, updated: '2026-08-18T00:00:00.000Z', agent: null, progress: null },
      { id: 'c', title: 'c', status: 'archived', priority: 'normal', project: 'P',
        phaseId: null, updated: '2026-08-18T00:00:00.000Z', agent: null, progress: null },
    ] as MapTaskNode[];
    const f = aggregateFactsOf(nodes);
    // Subtracting completed/stuck/upNext from taskCount would have counted the
    // archived Task as in flight.
    expect(f.inFlight).toBe(2);
  });

  test('B2: a Report edge routes around OTHER Report nodes', () => {
    // Round 6: Report edges were routed against the aggregate nodes only, so
    // they ran through other Report nodes while reporting clean.
    const source: Box = { x: 0, y: 100, w: 160, h: 36 };
    const target: Box = { x: 700, y: 100, w: 220, h: 104 };
    const otherReport: Box = { x: 380, y: 60, w: 160, h: 120 };
    const envelope: Box = { x: -200, y: -200, w: 1400, h: 900 };
    const route = routeEdge(source, target, [source, target, otherReport], envelope);
    expect(route.clipped).toBe(false);
    const q = /^M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)$/.exec(route.d);
    if (q) {
      const [, x1, y1, cx, cy, x2, y2] = q.map(Number);
      expect(quadraticIntersectsBox(x1, y1, cx, cy, x2, y2, otherReport)).toBe(false);
    } else {
      const points = route.d.replace('M ', '').split(' L ')
        .map(p => p.trim().split(/\s+/).map(Number) as [number, number]);
      for (let i = 0; i < points.length - 1; i += 1) {
        expect(segmentIntersectsBox(
          points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], otherReport)).toBe(false);
      }
    }
  });
});

describe('round 6 — the two rules the first regressions could not reach', () => {
  test('B2: painted Report nodes are obstacles at the aggregate altitudes', () => {
    const tiles: Box[] = [{ x: 0, y: 0, w: 10, h: 10 }];
    const aggregates: Box[] = [{ x: 100, y: 0, w: 20, h: 20 }];
    const reports: Box[] = [{ x: 200, y: 0, w: 30, h: 30 }];
    // Round 6: Report edges routed against the aggregates only, so they ran
    // through other Report nodes while reporting clean. If it is drawn, it
    // blocks - which array it arrived in is not the question.
    expect(paintedObstacles('phase', tiles, aggregates, reports)).toEqual([...aggregates, ...reports]);
    expect(paintedObstacles('project', tiles, aggregates, reports)).toEqual([...aggregates, ...reports]);
    // The task altitude paints tiles; aggregates and Report nodes are not drawn.
    expect(paintedObstacles('task', tiles, aggregates, reports)).toEqual(tiles);
  });

  test('B4: an id the task altitude does not know selects NO chain', () => {
    const edges: MapEdge[] = [
      { from: 't2', to: 't1', kind: 'dependency' },
      { from: 't3', to: 't2', kind: 'dependency' },
    ];
    const known = (id: string) => ['t1', 't2', 't3'].includes(id);
    // A real Task lights its whole chain, both directions.
    const lit = buildChain('t2', edges, known)!;
    expect(lit).not.toBeNull();
    expect([...lit].sort()).toEqual(['t1', 't2', 't3']);
    // An AGGREGATE id lights nothing - and must therefore dim nothing. Round 6
    // measured 14 of 14 tiles dimmed by a stale aggregate selection, which is
    // the chain highlight inverted into a blackout.
    expect(buildChain('phase:P0\u0000ph-1', edges, known)).toBeNull();
    expect(buildChain(null, edges, known)).toBeNull();
  });
});

/* ======================================================================
 * Regressions for review round 7 (report d1b2eae1, candidate dfb5b56).
 * ====================================================================== */
describe('round 7 d1b2eae1 blocking findings', () => {
  test('B1: no unscoped .map-edge--aggregate rule may set a stroke colour', () => {
    // The round-6 chain-state repair computed dammed/active/satisfied
    // correctly and then painted all three the same grey, because this rule
    // sat later in the file at EQUAL specificity and overrode them. The
    // cascade is the defect, so the stylesheet is what gets asserted.
    const css = readFileSync(
      new URL('./MapView.css', import.meta.url).pathname, 'utf8');
    const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const offenders = blocks
      .filter(([, selector, body]) =>
        /\.map-edge--aggregate(?![\w-])/.test(selector)
        && !/map-edge--(dammed|active|satisfied|neutral)/.test(selector)
        && /(^|[;\s])stroke\s*:/.test(body))
      .map(([, selector]) => selector.trim());
    expect(offenders).toEqual([]);
    // And a neutral fallback must still exist, or aggregate edges lose their
    // default colour entirely. It is no longer pinned to an exact selector:
    // round 8 correctly added the dependency kind to it, and a test that pins
    // the shape of a rule rather than its EFFECT blocks its own repair.
    expect(/\.map-edge--aggregate[^{]*\.map-edge--neutral\s*\{/.test(css)).toBe(true);
  });

  test('B2: the task altitude routes around ALL its painted furniture', () => {
    const tile: Box = { x: 0, y: 100, w: 170, h: 96 };
    const target: Box = { x: 700, y: 100, w: 170, h: 96 };
    const laneHeader: Box = { x: 300, y: 60, w: 170, h: 56 };
    const bandChip: Box = { x: 300, y: 140, w: 132, h: 22 };
    const pill: Box = { x: 520, y: 90, w: 44, h: 44 };
    const painted = paintedObstacles('task', [tile, target, laneHeader, bandChip, pill], [], []);
    // Round 7: only the TILES were passed, so a route could run straight
    // through a lane header, a band chip or a Report pill.
    expect(painted).toHaveLength(5);
    const envelope: Box = { x: -300, y: -300, w: 1600, h: 1000 };
    const route = routeEdge(tile, target, painted, envelope);
    expect(route.clipped).toBe(false);
    for (const box of [laneHeader, bandChip, pill]) {
      const q = /^M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)$/.exec(route.d);
      if (q) {
        const [, x1, y1, cx, cy, x2, y2] = q.map(Number);
        expect(quadraticIntersectsBox(x1, y1, cx, cy, x2, y2, box)).toBe(false);
      } else {
        const points = route.d.replace('M ', '').split(' L ')
          .map(p => p.trim().split(/\s+/).map(Number) as [number, number]);
        for (let i = 0; i < points.length - 1; i += 1) {
          expect(segmentIntersectsBox(
            points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], box)).toBe(false);
        }
      }
    }
  });

  test('B3: EXACTLY one corrective refit, across many extent changes', () => {
    // The reviewer drove five sequential culling expansions and got five
    // corrective fits against an advertised bound of one, because the
    // corrective fit came back through "a fit was spent" and refunded itself.
    let state = INITIAL_CORRECTIVE_FIT;
    let refits = 0;
    state = onFitSpent(state, { width: 100, height: 100 });
    for (let generation = 2; generation <= 6; generation += 1) {
      const extent = { width: 100 + generation * 10, height: 100 + generation * 10 };
      const step = onExtentChanged(state, extent);
      state = step.state;
      if (step.refit) {
        refits += 1;
        // The refit lands, and must NOT refund its own budget.
        state = onFitSpent(state, extent);
      }
    }
    expect(refits).toBe(1);

    // An explicit Fit starts the cycle over - that is a user action, not a loop.
    state = onExplicitFit();
    state = onFitSpent(state, { width: 10, height: 10 });
    expect(onExtentChanged(state, { width: 20, height: 20 }).refit).toBe(true);
  });

  test('B3: an unchanged extent never spends the budget', () => {
    let state = onFitSpent(INITIAL_CORRECTIVE_FIT, { width: 500, height: 400 });
    const step = onExtentChanged(state, { width: 500, height: 400 });
    expect(step.refit).toBe(false);
    expect(step.state.budget).toBe(1);
  });

  test('B4: selecting an aggregate discloses the WHOLE chain, not one hop', () => {
    const edges = [
      { from: 'phase:B', to: 'phase:A', kind: 'dependency' as const, multiplicity: 1 },
      { from: 'phase:C', to: 'phase:B', kind: 'dependency' as const, multiplicity: 1 },
      { from: 'phase:Z', to: 'phase:Y', kind: 'dependency' as const, multiplicity: 1 },
    ];
    const known = (id: string) => id.startsWith('phase:');
    const chain = buildChain('phase:B', edges, known)!;
    expect([...chain].sort()).toEqual(['phase:A', 'phase:B', 'phase:C']);

    // Collapsed to nothing, the chain is what brings edges back - and it
    // brings back BOTH hops. Round 7 measured 1 of 2.
    const revealed = revealChain(edges, [], chain);
    expect(revealed).toHaveLength(2);
    expect(revealed.some(e => e.from === 'phase:C' && e.to === 'phase:B')).toBe(true);
    // An unrelated chain elsewhere stays hidden.
    expect(revealed.some(e => e.from === 'phase:Z')).toBe(false);
  });
});

describe('bounded chain reveal (live perf finding, card a8746719)', () => {
  test('what survives the bound is the NEAREST hops, not an arbitrary slice', () => {
    const edges = [
      { from: 'a1', to: 'a0' },
      { from: 'a2', to: 'a1' },
      { from: 'a3', to: 'a2' },
      { from: 'a4', to: 'a3' },
    ];
    const chain = buildChain('a0', edges.map(e => ({ ...e, kind: 'dependency' })), () => true)!;
    const revealed = revealChain(edges, [], chain, 'a0', 2);
    expect(revealed).toHaveLength(2);
    // a0's own edge and the next one out - not the far end of the chain.
    expect(revealed.some(e => e.from === 'a1' && e.to === 'a0')).toBe(true);
    expect(revealed.some(e => e.from === 'a4')).toBe(false);
  });

  test('an unbounded call still returns the whole chain', () => {
    const edges = [{ from: 'b', to: 'a' }, { from: 'c', to: 'b' }];
    const chain = buildChain('a', edges.map(e => ({ ...e, kind: 'dependency' })), () => true)!;
    expect(revealChain(edges, [], chain)).toHaveLength(2);
  });
});

describe('round 8 a9ab1a68 blocking findings', () => {
  test('B1: the neutral aggregate fallback does not outrank the Knowledge kind', () => {
    const css = readFileSync(new URL('./MapView.css', import.meta.url).pathname, 'utf8');
    // Round 7 fixed one cascade collision in this file and round 8 found the
    // next: `.map-edge--aggregate.map-edge--neutral` is 0,0,2 and outranked
    // `.map-edge--knowledge` at 0,0,1, so a neutral rolled-up Report link kept
    // its dash and lost its teal. §4 requires Report links dashed TEAL at every
    // zoom, so the fallback must name the dependency kind it belongs to.
    const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const neutralAggregate = blocks
      .filter(([, selector]) =>
        /\.map-edge--aggregate/.test(selector) && /\.map-edge--neutral/.test(selector))
      .map(([, selector]) => selector.trim());
    expect(neutralAggregate.length).toBeGreaterThan(0);
    for (const selector of neutralAggregate) {
      expect(selector).toContain('.map-edge--dependency');
    }
  });

  test('B2: a SELECTED chain is never silently truncated', () => {
    // §4 licenses collapse for NON-SELECTED cross-lane edges and gives ~60 as
    // that threshold. It does not license trimming a selection's own chain,
    // and A2 forbids silently dropping a relationship. My earlier test asserted
    // the truncation and called 60 "§4's budget"; that misread the clause, and
    // the assertion is inverted here rather than deleted.
    const edges: Array<{ from: string; to: string; kind: string }> = [];
    for (let i = 0; i < 150; i += 1) edges.push({ from: `a${i + 1}`, to: `a${i}`, kind: 'dependency' });
    const chain = buildChain('a0', edges, () => true)!;
    expect(chain.size).toBe(151);
    const revealed = revealChain(edges, [], chain);
    // EVERY relationship in the selected chain is drawn.
    expect(revealed).toHaveLength(edges.length);
  });

  test('B2: the bound still exists for callers that ask for one', () => {
    // The parameter is retained deliberately - it is the right tool for a
    // future declared amendment that defines a truthful bounded form, and
    // removing it would make that amendment harder rather than safer.
    const edges = [
      { from: 'b', to: 'a', kind: 'dependency' },
      { from: 'c', to: 'b', kind: 'dependency' },
      { from: 'd', to: 'c', kind: 'dependency' },
    ];
    const chain = buildChain('a', edges, () => true)!;
    expect(revealChain(edges, [], chain, 'a', 2)).toHaveLength(2);
    expect(revealChain(edges, [], chain)).toHaveLength(3);
  });
});

describe('the aggregate edge COMPOSITION (round 8 B2, and the pattern behind it)', () => {
  const lanes: Record<string, string> = {};
  const chainEdges: Array<{ from: string; to: string; kind: string }> = [];
  for (let i = 0; i < 150; i += 1) {
    lanes[`a${i}`] = `proj${i}`;
    chainEdges.push({ from: `a${i + 1}`, to: `a${i}`, kind: 'dependency' });
  }
  lanes['a150'] = 'proj150';
  const crossLane = (e: { from: string; to: string }) => lanes[e.from] !== lanes[e.to];

  test('a SELECTED chain is drawn in full, however far past the threshold', () => {
    const chain = buildChain('a0', chainEdges, () => true)!;
    const drawn = aggregateEdgesToDraw(chainEdges, 60, 'a0', crossLane, chain);
    // Round 8: this composition trimmed the selected chain to 60, silently
    // dropping 90 relationships. §4's ~60 is the density threshold for
    // NON-SELECTED cross-lane collapse; it is not a budget a selection may be
    // cut to, and A2 forbids dropping a relationship silently.
    expect(drawn).toHaveLength(chainEdges.length);
  });

  test('with nothing selected the collapse still applies', () => {
    const drawn = aggregateEdgesToDraw(chainEdges, 60, null, crossLane, null);
    // All cross-lane and nothing lit: §4 collapses them.
    expect(drawn).toHaveLength(0);
  });

  test('same-lane edges survive the collapse with nothing selected', () => {
    const sameLane = Array.from({ length: 80 }, (_u, i) => (
      { from: `s${i}`, to: `t${i}`, kind: 'dependency' }));
    const drawn = aggregateEdgesToDraw(sameLane, 60, null, () => false, null);
    expect(drawn).toHaveLength(80);
  });
});


/* ======================================================================
 * A7b slice 1 — the vertical organization (§2 exact transpose).
 *
 * Recorded-row derivation (review 28026998 B2): geometry cases need estates
 * the 14-task recorded fixture does not contain, but §8 binds graph rows to
 * recorded serializer provenance. Every derived row below is a COMPLETE copy
 * of a real recorded serializer row — every field the wire carried, in its
 * real shape — with ONLY the identity/grouping fields overridden (id,
 * project, phaseId / id, projectId, position, name / from, to). Nothing is
 * hand-assembled into a wire-like shape. Sizes stay synthetic throughout:
 * they model the DOM measurement, not the wire.
 * ====================================================================== */

const RECORDED = graphFromRecorded();
const deriveNode = (id: string, over: Partial<MapTaskNode>, seed = 0): MapTaskNode => ({
  ...RECORDED.nodes[seed % RECORDED.nodes.length],
  id,
  ...over,
});
const derivePhase = (
  id: string, projectId: string, position: number, name?: string,
): MapPhase => ({
  ...RECORDED.phases[0],
  id, projectId, position, name: name ?? `Phase ${position}`,
});
const deriveEdge = (from: string, to: string): MapEdge => ({
  ...RECORDED.edges.find(e => e.kind === 'dependency')!,
  from, to,
});

describe('vertical layout — the zero-overlap invariant (A7b, §2 transpose)', () => {
  test('the recorded estate lays out with no overlapping element', () => {
    const graph = graphFromRecorded();
    const layout = layoutVertical(graph, measuredSizes(graph));
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('every task in the graph is placed exactly once — none silently dropped', () => {
    const graph = graphFromRecorded();
    const layout = layoutVertical(graph, measuredSizes(graph));
    const placed = layout.elements.filter(e => e.kind === 'tile').map(e => e.id);
    expect(placed.slice().sort()).toEqual(graph.nodes.map(n => n.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  test('unphased and project-less tasks get real, non-overlapping homes', () => {
    const graph = graphFromRecorded();
    const layout = layoutVertical(graph, measuredSizes(graph));
    const unphased = graph.nodes.filter(n => !n.phaseId);
    const projectless = graph.nodes.filter(n => n.project === null);
    const tiles = layout.elements.filter(e => e.kind === 'tile');
    for (const node of [...unphased, ...projectless]) {
      expect(tiles.some(tile => tile.id === node.id)).toBe(true);
    }
    expect(layout.elements.some(e => e.kind === 'band' && e.label === 'No phase')).toBe(true);
    expect(layout.elements.some(e => e.kind === 'lane' && e.label === 'No project')).toBe(true);
  });

  test('band boxes contain their own tiles', () => {
    const graph = graphFromRecorded();
    const layout = layoutVertical(graph, measuredSizes(graph));
    const bands = layout.elements.filter(e => e.kind === 'band') as any[];
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    for (const tile of tiles) {
      const owning = bands.filter(band =>
        tile.x >= band.x && tile.x + tile.w <= band.x + band.w &&
        tile.y >= band.y && tile.y + tile.h <= band.y + band.h);
      expect(owning.length).toBe(1);
    }
  });

  test('depth orders TOP to BOTTOM inside a band — the transposed flow axis', () => {
    const graph = graphFromRecorded();
    const layout = layoutVertical(graph, measuredSizes(graph));
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    for (const a of tiles) {
      for (const b of tiles) {
        if (a.depth < b.depth && a.node.phaseId === b.node.phaseId && a.node.project === b.node.project) {
          expect(a.y).toBeLessThan(b.y);
        }
      }
    }
  });

  test('projects are COLUMNS: headers share the top row, bands hang below their own header', () => {
    const graph = graphFromRecorded();
    const sizes = measuredSizes(graph);
    const layout = layoutVertical(graph, sizes);
    const headers = layout.elements.filter(e => e.kind === 'lane') as any[];
    expect(headers.length).toBeGreaterThan(1);
    for (const header of headers) expect(header.y).toBe(LAYOUT_METRICS.originY);
    expect(new Set(headers.map(h => h.x)).size).toBe(headers.length);
    const bands = layout.elements.filter(e => e.kind === 'band') as any[];
    for (const band of bands) {
      const header = headers.find(h => h.id === `lane:${band.laneId}`);
      expect(header).toBeDefined();
      expect(band.y).toBeGreaterThan(header.y + header.h);
    }
  });

  test('lane-wide rows: depth 0 sits at one y across the bands of a lane', () => {
    // Derived from recorded rows (provenance note above); the phase-crossing
    // dependency makes depth 0 and 1 real, not assumed.
    const phases = [derivePhase('ph1', 'P', 0), derivePhase('ph2', 'P', 1)];
    const nodes = [
      deriveNode('up', { project: 'P', phaseId: 'ph1' }, 0),
      deriveNode('down', { project: 'P', phaseId: 'ph2' }, 1),
      deriveNode('peer', { project: 'P', phaseId: 'ph2' }, 2),
    ];
    const edges = [deriveEdge('down', 'up')];
    const sizes = {
      up: { w: 170, h: 90 }, down: { w: 170, h: 90 }, peer: { w: 170, h: 90 },
      'lane:P': { w: 180, h: 56 },
    };
    const layout = layoutVertical({ nodes, edges, phases }, sizes);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    const at = (id: string) => tiles.find(t => t.id === id)!;
    expect(at('up').y).toBe(at('peer').y);
    expect(at('down').y).toBeGreaterThan(at('up').y);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('a NONZERO depth shares one y across bands whose earlier depths differ in height (review 28026998 B1)', () => {
    // The finding: pinning only depth 0 lets a per-band offset table pass,
    // because every band's depth-0 offset is zero. This case makes the
    // per-band answer WRONG: both phases hold a depth-0 → depth-1 chain, and
    // phase one's depth-0 row is far taller (300px vs 60px). Per-band offsets
    // would seat the two depth-1 tiles ~240px apart; the lane-wide rule seats
    // them at ONE y. Verified to fail against the per-band mutation the
    // reviewer constructed (repair record in the evidence report).
    const phases = [derivePhase('ph1', 'P', 0), derivePhase('ph2', 'P', 1)];
    const nodes = [
      deriveNode('a0', { project: 'P', phaseId: 'ph1' }, 0),
      deriveNode('a1', { project: 'P', phaseId: 'ph1' }, 1),
      deriveNode('b0', { project: 'P', phaseId: 'ph2' }, 2),
      deriveNode('b1', { project: 'P', phaseId: 'ph2' }, 3),
    ];
    const edges = [deriveEdge('a1', 'a0'), deriveEdge('b1', 'b0')];
    const sizes = {
      a0: { w: 170, h: 300 }, a1: { w: 170, h: 90 },
      b0: { w: 170, h: 60 }, b1: { w: 170, h: 90 },
      'lane:P': { w: 180, h: 56 },
    };
    const layout = layoutVertical({ nodes, edges, phases }, sizes);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    const at = (id: string) => tiles.find(t => t.id === id)!;
    // Depth 1 is ONE row, wherever it appears in the lane…
    expect(at('a1').y).toBe(at('b1').y);
    // …seated below the TALLEST depth-0 occupant, not each band's own.
    expect(at('b1').y - at('b0').y).toBeGreaterThan(300 - 60);
    expect(at('a1').y).toBeGreaterThan(at('a0').y);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('layout is deterministic — identical input, identical output', () => {
    const graph = graphFromRecorded();
    const sizes = measuredSizes(graph);
    expect(JSON.stringify(layoutVertical(graph, sizes).elements))
      .toEqual(JSON.stringify(layoutVertical(graph, sizes).elements));
  });
});

describe('vertical layout — chips and pills stay first-class', () => {
  test('every band emits a chip and nothing overlaps', () => {
    const graph = graphFromRecorded();
    const layout = layoutVertical(graph, measuredSizes(graph));
    const bands = layout.elements.filter(e => e.kind === 'band');
    const chips = layout.elements.filter(e => e.kind === 'chip');
    expect(chips.length).toBe(bands.length);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('an unusually WIDE measured chip still cannot reach the tiles', () => {
    const graph = graphFromRecorded();
    const sizes: Record<string, { w: number; h: number }> = { ...measuredSizes(graph) };
    for (const element of layoutVertical(graph, measuredSizes(graph)).elements) {
      if (element.kind === 'chip') sizes[element.id] = { w: 900, h: 26 };
    }
    const layout = layoutVertical(graph, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('a TALL measured chip pushes every row down instead of painting over the first one', () => {
    const graph = graphFromRecorded();
    const sizes: Record<string, { w: number; h: number }> = { ...measuredSizes(graph) };
    for (const element of layoutVertical(graph, measuredSizes(graph)).elements) {
      if (element.kind === 'chip') sizes[element.id] = { w: 200, h: 120 };
    }
    const layout = layoutVertical(graph, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
    const bands = layout.elements.filter(e => e.kind === 'band') as any[];
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    for (const tile of tiles) {
      const band = bands.find(b =>
        tile.x >= b.x && tile.x + tile.w <= b.x + b.w &&
        tile.y >= b.y && tile.y + tile.h <= b.y + b.h)!;
      expect(tile.y).toBeGreaterThanOrEqual(band.y + 120);
    }
  });

  test('report pills sit beside their tasks and survive hostile pill sizes', () => {
    const graph = withReports(graphFromRecorded(), 2);
    const sizes = withPillSizes(graph, { w: 120, h: 60 });
    const layout = layoutVertical(graph, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
    const tiles = new Map((layout.elements.filter(e => e.kind === 'tile') as any[])
      .map(t => [t.id, t]));
    const pills = layout.elements.filter(e => e.kind === 'pill') as any[];
    expect(pills.length).toBe(graph.nodes.length * 2);
    for (const pill of pills) {
      const tile = tiles.get(pill.taskId)!;
      expect(pill.x).toBe(tile.x + tile.w + LAYOUT_METRICS.pillGapX);
      expect(pill.y).toBeGreaterThanOrEqual(tile.y);
    }
  });
});

describe('vertical layout — adversarial shapes (recorded-row derived)', () => {
  test('an empty graph produces an empty, non-negative canvas', () => {
    const layout = layoutVertical({ nodes: [], edges: [], phases: [] }, {});
    expect(layout.elements).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  test('wildly uneven tile heights still never overlap', () => {
    const nodes = Array.from({ length: 40 }, (_, i) =>
      deriveNode('n' + i, {
        project: i % 2 ? 'A' : 'B',
        phaseId: i % 3 === 0 ? 'ph1' : null,
      }, i));
    const sizes: Record<string, { w: number; h: number }> = {};
    nodes.forEach((n, i) => { sizes[n.id] = { w: 170, h: i % 7 === 0 ? 420 : 64 }; });
    const layout = layoutVertical(
      { nodes, edges: [], phases: [derivePhase('ph1', 'A', 0, 'Phase one')] },
      sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('a deep single chain does not stack tiles on each other', () => {
    const nodes = Array.from({ length: 25 }, (_, i) =>
      deriveNode('c' + i, { project: 'P', phaseId: null }, i));
    const edges = nodes.slice(1).map((n, i) => deriveEdge(n.id, nodes[i].id));
    const sizes = Object.fromEntries(nodes.map(n => [n.id, { w: 170, h: 90 }]));
    const layout = layoutVertical({ nodes, edges, phases: [] }, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    expect(new Set(tiles.map(t => t.y)).size).toBe(nodes.length);
  });

  test('many lanes and many bands stay disjoint', () => {
    const nodes: MapTaskNode[] = [];
    const phases: MapPhase[] = [];
    let seed = 0;
    for (let p = 0; p < 12; p += 1) {
      for (let ph = 0; ph < 4; ph += 1) {
        const phaseId = `p${p}-ph${ph}`;
        phases.push(derivePhase(phaseId, `P${p}`, ph, `Phase ${ph}`));
        for (let t = 0; t < 5; t += 1) {
          nodes.push(deriveNode(`${phaseId}-t${t}`, { project: `P${p}`, phaseId }, seed));
          seed += 1;
        }
      }
    }
    const sizes = Object.fromEntries(nodes.map((n, i) => [n.id, { w: 170, h: 70 + (i % 4) * 15 }]));
    const layout = layoutVertical({ nodes, edges: [], phases }, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('MISSING measurements fall back without producing overlap', () => {
    const nodes = Array.from({ length: 15 }, (_, i) =>
      deriveNode('m' + i, { project: i % 3 ? 'A' : 'B', phaseId: null }, i));
    const layout = layoutVertical({ nodes, edges: [], phases: [] }, {});
    expect(findOverlaps(layout.elements)).toEqual([]);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    expect(tiles.every(t => t.h === FALLBACK_TILE.h)).toBe(true);
  });

  test('a zero-sized measurement cannot make two tiles share a point', () => {
    const nodes = [
      deriveNode('z0', { project: 'P', phaseId: null }, 0),
      deriveNode('z1', { project: 'P', phaseId: null }, 1),
    ];
    const layout = layoutVertical(
      { nodes, edges: [], phases: [] },
      { z0: { w: 0, h: 0 }, z1: { w: 0, h: 0 } });
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('duplicate phase positions resolve deterministically', () => {
    const phases = [derivePhase('a', 'P', 0, 'Alpha'), derivePhase('b', 'P', 0, 'Beta')];
    const nodes = [
      deriveNode('n-a', { project: 'P', phaseId: 'a' }, 0),
      deriveNode('n-b', { project: 'P', phaseId: 'b' }, 1),
    ];
    const sizes = { 'n-a': { w: 170, h: 80 }, 'n-b': { w: 170, h: 80 } };
    const first = layoutVertical({ nodes, edges: [], phases }, sizes);
    const second = layoutVertical({ nodes, edges: [], phases }, sizes);
    expect(JSON.stringify(first.elements)).toEqual(JSON.stringify(second.elements));
    expect(findOverlaps(first.elements)).toEqual([]);
  });
});

describe('organization threading (A7b slice 1)', () => {
  const graph = graphFromRecorded();
  const sizes = measuredSizes(graph);

  test('layoutTaskAltitude renders the selected organization', () => {
    expect(JSON.stringify(layoutTaskAltitude(graph, sizes, 'vertical')))
      .toEqual(JSON.stringify(layoutVertical(graph, sizes)));
    expect(JSON.stringify(layoutTaskAltitude(graph, sizes, 'horizontal')))
      .toEqual(JSON.stringify(layoutHorizontal(graph, sizes)));
  });

  test('the two pipeline organizations REALLY differ — the threading is not inert', () => {
    expect(JSON.stringify(layoutTaskAltitude(graph, sizes, 'vertical')))
      .not.toEqual(JSON.stringify(layoutTaskAltitude(graph, sizes, 'horizontal')));
  });

  test('layoutAtAltitude routes the task altitude through the organization', () => {
    expect(JSON.stringify(layoutAtAltitude(graph, sizes, 'task', 16 / 10, 'vertical')))
      .toEqual(JSON.stringify(layoutVertical(graph, sizes)));
  });

  test('the aggregate altitudes are organization-neutral', () => {
    for (const altitude of ['phase', 'project'] as const) {
      expect(JSON.stringify(layoutAtAltitude(graph, sizes, altitude, 16 / 10, 'vertical')))
        .toEqual(JSON.stringify(layoutAtAltitude(graph, sizes, altitude, 16 / 10, 'horizontal')));
    }
  });

  test('every §2 organization now ships', () => {
    expect(AVAILABLE_ORGANIZATIONS).toEqual(['horizontal', 'vertical', 'organic']);
  });

  test('settleAltitude honours the organization option and stays a fixed point', () => {
    const options = {
      clampScale,
      viewport: { width: 1280, height: 800 },
      organization: 'vertical' as const,
    };
    const settled = settleAltitude(graph, sizes, { altitude: 'task', scale: 1 }, options);
    expect(settleAltitude(graph, sizes, settled, options)).toEqual(settled);
  });

  test('initialAltitude under the vertical organization fits the plane it will draw', () => {
    const options = {
      clampScale,
      viewport: { width: 1280, height: 800 },
      organization: 'vertical' as const,
    };
    const arrival = initialAltitude(graph, sizes, options);
    const layout = layoutAtAltitude(graph, sizes, arrival.altitude, 1280 / 800, 'vertical');
    expect(arrival.scale).toBeCloseTo(fitScaleFor(layout, options), 10);
  });
});


/* ======================================================================
 * A7b slice 2 — the radial organization (§2).
 *
 * Polar assertions need the estate CENTRE, which the layout does not carry.
 * It does not need to: every hull's outer arc lies exactly on a circle
 * around it, so the circumcentre of three arc points recovers the centre to
 * floating precision — geometry read back from the layout itself, not a
 * duplicated constant.
 * ====================================================================== */

const circumcentre = (
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
) => {
  const d = 2 * (p1[0] * (p2[1] - p3[1]) + p2[0] * (p3[1] - p1[1]) + p3[0] * (p1[1] - p2[1]));
  const s1 = p1[0] * p1[0] + p1[1] * p1[1];
  const s2 = p2[0] * p2[0] + p2[1] * p2[1];
  const s3 = p3[0] * p3[0] + p3[1] * p3[1];
  return {
    x: (s1 * (p2[1] - p3[1]) + s2 * (p3[1] - p1[1]) + s3 * (p1[1] - p2[1])) / d,
    y: (s1 * (p3[0] - p2[0]) + s2 * (p1[0] - p3[0]) + s3 * (p2[0] - p1[0])) / d,
  };
};

const radialCentreOf = (layout: { elements: readonly unknown[] }) => {
  const hulls = (layout.elements as Array<{ kind: string }>).filter(
    (e): e is PlacedHull => e.kind === 'hull');
  // The widest hull gives the best-conditioned triple.
  const hull = hulls.reduce((best, candidate) =>
    candidate.points.length > best.points.length ? candidate : best);
  const outer = (hull.points.length / 2) - 1;
  return circumcentre(hull.points[0], hull.points[Math.floor(outer / 2)], hull.points[outer]);
};

/** Angle of a point about the centre, unwrapped to [0, 2π) from `from`. */
const angleFrom = (centre: { x: number; y: number }, x: number, y: number, from: number) => {
  const raw = Math.atan2(y - centre.y, x - centre.x);
  let relative = raw - from;
  while (relative < 0) relative += 2 * Math.PI;
  while (relative >= 2 * Math.PI) relative -= 2 * Math.PI;
  return relative;
};

describe('radial layout — the zero-overlap invariant (A7b slice 2, §2)', () => {
  test('the recorded estate lays out with no overlapping element', () => {
    const graph = graphFromRecorded();
    const layout = layoutRadial(graph, measuredSizes(graph));
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('every task is placed exactly once — none silently dropped', () => {
    const graph = graphFromRecorded();
    const layout = layoutRadial(graph, measuredSizes(graph));
    const placed = layout.elements.filter(e => e.kind === 'tile').map(e => e.id);
    expect(placed.slice().sort()).toEqual(graph.nodes.map(n => n.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  test('unphased and project-less tasks get real, non-overlapping homes', () => {
    const graph = graphFromRecorded();
    const layout = layoutRadial(graph, measuredSizes(graph));
    const tiles = layout.elements.filter(e => e.kind === 'tile');
    for (const node of graph.nodes.filter(n => !n.phaseId || n.project === null)) {
      expect(tiles.some(tile => tile.id === node.id)).toBe(true);
    }
    expect(layout.elements.some(e => e.kind === 'hull' && e.label === 'No phase')).toBe(true);
    expect(layout.elements.some(e => e.kind === 'lane' && e.label === 'No project')).toBe(true);
  });

  test('every band gets a hull and a chip; hull bounding boxes are exempt, everything else is not', () => {
    const graph = graphFromRecorded();
    const layout = layoutRadial(graph, measuredSizes(graph));
    const hulls = layout.elements.filter(e => e.kind === 'hull');
    const chips = layout.elements.filter(e => e.kind === 'chip');
    expect(hulls.length).toBeGreaterThan(1);
    expect(chips.length).toBe(hulls.length);
    // Multi-sector hull bounding rects DO interleave — the reason the checker
    // exempts them. If the exemption ever regresses this test turns red with
    // hull pairs, not with a silent pass.
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('topo depth maps to RADIUS rings: same depth = one radius, deeper = strictly further out', () => {
    // Derived rows (provenance block above): one project, two phases, a
    // chain crossing the phase boundary — depths 0 and 1 both real.
    const phases = [derivePhase('ph1', 'P', 0), derivePhase('ph2', 'P', 1)];
    const nodes = [
      deriveNode('up', { project: 'P', phaseId: 'ph1' }, 0),
      deriveNode('down', { project: 'P', phaseId: 'ph2' }, 1),
      deriveNode('peer', { project: 'P', phaseId: 'ph2' }, 2),
    ];
    const edges = [deriveEdge('down', 'up')];
    const sizes = {
      up: { w: 170, h: 90 }, down: { w: 170, h: 90 }, peer: { w: 170, h: 90 },
      'lane:P': { w: 180, h: 56 },
    };
    const layout = layoutRadial({ nodes, edges, phases }, sizes);
    const centre = radialCentreOf(layout);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    const radius = (id: string) => {
      const tile = tiles.find(t => t.id === id)!;
      return Math.hypot(tile.x + tile.w / 2 - centre.x, tile.y + tile.h / 2 - centre.y);
    };
    expect(Math.abs(radius('up') - radius('peer'))).toBeLessThan(1e-6);
    expect(radius('down')).toBeGreaterThan(radius('up') + 90);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('each project owns an angular sector and its tiles stay inside it', () => {
    const graph = graphFromRecorded();
    const layout = layoutRadial(graph, measuredSizes(graph));
    const centre = radialCentreOf(layout);
    const sectors = radialSectorSpans(graph);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    let checked = 0;
    for (const tile of tiles) {
      const laneKey = tile.node.project ?? '__no_project__';
      const sector = sectors.get(laneKey)!;
      const angle = angleFrom(
        centre, tile.x + tile.w / 2, tile.y + tile.h / 2, sector.start);
      // The tile CENTRE sits inside its sector's span (the box may spill).
      expect(angle).toBeLessThanOrEqual(sector.span + 1e-6);
      checked += 1;
    }
    expect(checked).toBe(graph.nodes.length);
  });

  test('phases sub-divide the sector in declared order', () => {
    const graph = graphFromRecorded();
    const sectors = radialSectorSpans(graph);
    for (const sector of sectors.values()) {
      let cursor = sector.start - 1e-9;
      for (const band of sector.bands.values()) {
        expect(band.start).toBeGreaterThanOrEqual(cursor);
        expect(band.start + band.span)
          .toBeLessThanOrEqual(sector.start + sector.span + 1e-9);
        cursor = band.start + band.span;
      }
    }
  });

  test('layout is deterministic — identical input, identical output', () => {
    const graph = graphFromRecorded();
    const sizes = measuredSizes(graph);
    expect(JSON.stringify(layoutRadial(graph, sizes).elements))
      .toEqual(JSON.stringify(layoutRadial(graph, sizes).elements));
  });
});

describe('radial sectors — §2 proportionality and the minimum floor', () => {
  const estate = (bigCount: number, smallCount: number): MapGraph => {
    const nodes: MapTaskNode[] = [];
    for (let i = 0; i < bigCount; i += 1) {
      nodes.push(deriveNode(`big-${i}`, { project: 'Big', phaseId: null }, i));
    }
    for (let i = 0; i < smallCount; i += 1) {
      nodes.push(deriveNode(`small-${i}`, { project: 'Small', phaseId: null }, i));
    }
    return { nodes, edges: [], phases: [] };
  };

  test('sector share grows with task count', () => {
    const sectors = radialSectorSpans(estate(20, 2));
    expect(sectors.get('Big')!.span).toBeGreaterThan(sectors.get('Small')!.span * 3);
  });

  test('a tiny project keeps the minimum sector floor', () => {
    const sectors = radialSectorSpans(estate(200, 1));
    const m = RADIAL_METRICS;
    const laneGap = Math.min(m.laneGapAngle, Math.PI / 2);
    const available = 2 * Math.PI - laneGap * 2;
    const flooredSum = Math.max(m.minSectorShare, 200 / 201)
      + Math.max(m.minSectorShare, 1 / 201);
    const floorSpan = (m.minSectorShare / flooredSum) * available;
    expect(sectors.get('Small')!.span).toBeGreaterThanOrEqual(floorSpan - 1e-9);
  });

  test('sectors and gaps tile the whole circle exactly once', () => {
    const sectors = radialSectorSpans(estate(10, 5));
    const spans = [...sectors.values()].map(s => s.span);
    const m = RADIAL_METRICS;
    const laneGap = Math.min(m.laneGapAngle, Math.PI / 2);
    expect(spans.reduce((a, b) => a + b, 0) + laneGap * 2).toBeCloseTo(2 * Math.PI, 9);
  });
});

describe('radial layout — adversarial shapes (recorded-row derived)', () => {
  test('an empty graph produces an empty, non-negative canvas', () => {
    const layout = layoutRadial({ nodes: [], edges: [], phases: [] }, {});
    expect(layout.elements).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  test('a deep single chain becomes strictly increasing rings, no overlap', () => {
    const nodes = Array.from({ length: 25 }, (_, i) =>
      deriveNode('c' + i, { project: 'P', phaseId: null }, i));
    const edges = nodes.slice(1).map((n, i) => deriveEdge(n.id, nodes[i].id));
    const sizes = Object.fromEntries(nodes.map(n => [n.id, { w: 170, h: 90 }]));
    const layout = layoutRadial({ nodes, edges, phases: [] }, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
    const centre = radialCentreOf(layout);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    const radii = nodes.map(n => {
      const tile = tiles.find(t => t.id === n.id)!;
      return Math.hypot(tile.x + tile.w / 2 - centre.x, tile.y + tile.h / 2 - centre.y);
    });
    for (let i = 1; i < radii.length; i += 1) {
      expect(radii[i]).toBeGreaterThan(radii[i - 1]);
    }
  });

  test('many projects with many phases stay disjoint', () => {
    const nodes: MapTaskNode[] = [];
    const phases: MapPhase[] = [];
    let seed = 0;
    for (let p = 0; p < 12; p += 1) {
      for (let ph = 0; ph < 4; ph += 1) {
        const phaseId = `p${p}-ph${ph}`;
        phases.push(derivePhase(phaseId, `P${p}`, ph, `Phase ${ph}`));
        for (let t = 0; t < 5; t += 1) {
          nodes.push(deriveNode(`${phaseId}-t${t}`, { project: `P${p}`, phaseId }, seed));
          seed += 1;
        }
      }
    }
    const sizes = Object.fromEntries(nodes.map((n, i) => [n.id, { w: 170, h: 70 + (i % 4) * 15 }]));
    const layout = layoutRadial({ nodes, edges: [], phases }, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('wildly uneven tile heights still never overlap', () => {
    const nodes = Array.from({ length: 40 }, (_, i) =>
      deriveNode('n' + i, {
        project: i % 2 ? 'A' : 'B',
        phaseId: i % 3 === 0 ? 'ph1' : null,
      }, i));
    const sizes: Record<string, { w: number; h: number }> = {};
    nodes.forEach((n, i) => { sizes[n.id] = { w: 170, h: i % 7 === 0 ? 420 : 64 }; });
    const layout = layoutRadial(
      { nodes, edges: [], phases: [derivePhase('ph1', 'A', 0, 'Phase one')] }, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('MISSING measurements fall back without producing overlap', () => {
    const nodes = Array.from({ length: 15 }, (_, i) =>
      deriveNode('m' + i, { project: i % 3 ? 'A' : 'B', phaseId: null }, i));
    const layout = layoutRadial({ nodes, edges: [], phases: [] }, {});
    expect(findOverlaps(layout.elements)).toEqual([]);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    expect(tiles.every(t => t.h === FALLBACK_TILE.h)).toBe(true);
  });

  test('a zero-sized measurement cannot make two tiles share a point', () => {
    const nodes = [
      deriveNode('z0', { project: 'P', phaseId: null }, 0),
      deriveNode('z1', { project: 'P', phaseId: null }, 1),
    ];
    const layout = layoutRadial(
      { nodes, edges: [], phases: [] },
      { z0: { w: 0, h: 0 }, z1: { w: 0, h: 0 } });
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('an unusually WIDE measured chip is pushed outward, never onto the tiles', () => {
    const graph = graphFromRecorded();
    const sizes: Record<string, { w: number; h: number }> = { ...measuredSizes(graph) };
    for (const element of layoutRadial(graph, measuredSizes(graph)).elements) {
      if (element.kind === 'chip') sizes[element.id] = { w: 900, h: 26 };
    }
    const layout = layoutRadial(graph, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('report pills ride beside their tasks and survive hostile pill sizes', () => {
    const graph = withReports(graphFromRecorded(), 2);
    const sizes = withPillSizes(graph, { w: 120, h: 60 });
    const layout = layoutRadial(graph, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
    const tiles = new Map((layout.elements.filter(e => e.kind === 'tile') as any[])
      .map(t => [t.id, t]));
    const pills = layout.elements.filter(e => e.kind === 'pill') as any[];
    expect(pills.length).toBe(graph.nodes.length * 2);
    for (const pill of pills) {
      const tile = tiles.get(pill.taskId)!;
      expect(pill.x).toBe(tile.x + tile.w + LAYOUT_METRICS.pillGapX);
      expect(pill.y).toBeGreaterThanOrEqual(tile.y);
    }
  });
});

describe('radial threading (A7b slice 2)', () => {
  const graph = graphFromRecorded();
  const sizes = measuredSizes(graph);

  test('layoutTaskAltitude routes radial to the radial engine', () => {
    expect(JSON.stringify(layoutTaskAltitude(graph, sizes, 'radial')))
      .toEqual(JSON.stringify(layoutRadial(graph, sizes)));
  });

  test('all three shipped organizations REALLY differ', () => {
    const h = JSON.stringify(layoutTaskAltitude(graph, sizes, 'horizontal'));
    const v = JSON.stringify(layoutTaskAltitude(graph, sizes, 'vertical'));
    const r = JSON.stringify(layoutTaskAltitude(graph, sizes, 'radial'));
    expect(h).not.toEqual(v);
    expect(v).not.toEqual(r);
    expect(h).not.toEqual(r);
  });

  test('the aggregate altitudes stay organization-neutral under radial', () => {
    for (const altitude of ['phase', 'project'] as const) {
      expect(JSON.stringify(layoutAtAltitude(graph, sizes, altitude, 16 / 10, 'radial')))
        .toEqual(JSON.stringify(layoutAtAltitude(graph, sizes, altitude, 16 / 10, 'horizontal')));
    }
  });

  test('settleAltitude under radial stays a fixed point', () => {
    const options = {
      clampScale,
      viewport: { width: 1280, height: 800 },
      organization: 'radial' as const,
    };
    const settled = settleAltitude(graph, sizes, { altitude: 'task', scale: 1 }, options);
    expect(settleAltitude(graph, sizes, settled, options)).toEqual(settled);
  });
});


describe('radial chord clearance (review a649f5f7 B1)', () => {
  test('the reviewer estate — four tall recorded-row boxes in one band — stays disjoint', () => {
    // The r1 defect: spacing was spent along the ARC, and the chord between
    // wide slots at a small radius is shorter; these four 170×500 boxes
    // overlapped in pairs. Chord-safe half-angles now own the spacing.
    const nodes = Array.from({ length: 4 }, (_, i) =>
      deriveNode('t' + i, { project: 'P', phaseId: null }, i));
    const sizes = Object.fromEntries(nodes.map(n => [n.id, { w: 170, h: 500 }]));
    const layout = layoutRadial({ nodes, edges: [], phases: [] }, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('tall boxes stay disjoint across ring sizes and counts', () => {
    for (const count of [3, 6, 9]) {
      for (const height of [260, 500, 740]) {
        const nodes = Array.from({ length: count }, (_, i) =>
          deriveNode(`n${count}-${height}-${i}`, { project: 'P', phaseId: null }, i));
        const sizes = Object.fromEntries(nodes.map(n => [n.id, { w: 170, h: height }]));
        const layout = layoutRadial({ nodes, edges: [], phases: [] }, sizes);
        expect(findOverlaps(layout.elements)).toEqual([]);
      }
    }
  });
});

describe('container morph helpers (review a649f5f7 B2)', () => {
  test('morphEase is the pinned bezier: endpoints exact, strictly monotone', () => {
    expect(morphEase(0)).toBe(0);
    expect(morphEase(1)).toBe(1);
    let previous = 0;
    for (let i = 1; i <= 20; i += 1) {
      const value = morphEase(i / 20);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
    // Ease-out character: the first half covers more ground than the second.
    expect(morphEase(0.5)).toBeGreaterThan(0.5);
  });

  test('resampleOutline returns exactly n points on the polyline', () => {
    const rect = rectOutline({ x: 0, y: 0, w: 100, h: 50 });
    const resampled = resampleOutline(rect, CONTAINER_MORPH_POINTS);
    expect(resampled.length).toBe(CONTAINER_MORPH_POINTS);
    // Every resampled point stays on the rectangle's perimeter.
    for (const [x, y] of resampled) {
      const onEdge = Math.abs(x) < 1e-9 || Math.abs(x - 100) < 1e-9
        || Math.abs(y) < 1e-9 || Math.abs(y - 50) < 1e-9;
      expect(onEdge).toBe(true);
    }
  });

  test('interpolateOutline is exact at both ends', () => {
    const from = resampleOutline(rectOutline({ x: 0, y: 0, w: 10, h: 10 }), 16);
    const to = resampleOutline(rectOutline({ x: 100, y: 40, w: 30, h: 20 }), 16);
    expect(interpolateOutline(from, to, 0)).toEqual(from);
    expect(interpolateOutline(from, to, 1)).toEqual(to);
  });

  test('alignOutline finds the rotation that eliminates self-crossing lerp', () => {
    const to = resampleOutline(rectOutline({ x: 0, y: 0, w: 40, h: 40 }), 8);
    // The same outline rotated by three steps must align back exactly.
    const rotated = [...to.slice(3), ...to.slice(0, 3)];
    expect(alignOutline(rotated, to)).toEqual(to);
  });

  test('containerMorphsFor pairs every band across horizontal and radial layouts', () => {
    const graph = graphFromRecorded();
    const sizes = measuredSizes(graph);
    const horizontal = layoutHorizontal(graph, sizes);
    const radial = layoutRadial(graph, sizes);
    const morphs = containerMorphsFor(horizontal, radial);
    const bandIds = horizontal.elements.filter(e => e.kind === 'band').map(e => e.id).sort();
    expect(morphs.map(m => m.id).sort()).toEqual(bandIds);
    for (const morph of morphs) {
      expect(morph.from.length).toBe(CONTAINER_MORPH_POINTS);
      expect(morph.to.length).toBe(CONTAINER_MORPH_POINTS);
    }
  });
});


/* ======================================================================
 * A7b slice 3 — the organic organization (§2 constrained force layout).
 * ====================================================================== */

/** Convex-polygon containment: the point is on the inner side of every edge. */
const insideConvex = (
  points: ReadonlyArray<readonly [number, number]>, x: number, y: number,
): boolean => {
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
};

describe('organic layout — the zero-overlap invariant (A7b slice 3, §2)', () => {
  test('the recorded estate lays out with no overlapping element', () => {
    const graph = graphFromRecorded();
    const layout = layoutOrganic(graph, measuredSizes(graph));
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('every task is placed exactly once — none silently dropped', () => {
    const graph = graphFromRecorded();
    const layout = layoutOrganic(graph, measuredSizes(graph));
    const placed = layout.elements.filter(e => e.kind === 'tile').map(e => e.id);
    expect(placed.slice().sort()).toEqual(graph.nodes.map(n => n.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  test('the simulation is DETERMINISTIC across distinct but identical graph objects', () => {
    // Object identity must not matter (the WeakMap cache is an optimization,
    // never an input): two structurally identical graphs, two layouts,
    // byte-identical output.
    const a = JSON.parse(JSON.stringify(graphFromRecorded())) as MapGraph;
    const b = JSON.parse(JSON.stringify(graphFromRecorded())) as MapGraph;
    const sizes = measuredSizes(a);
    expect(JSON.stringify(layoutOrganic(a, sizes).elements))
      .toEqual(JSON.stringify(layoutOrganic(b, sizes).elements));
  });

  test('the centre cache returns the same result for the same graph object', () => {
    const graph = graphFromRecorded();
    expect(simulateOrganicCentres(graph)).toBe(simulateOrganicCentres(graph));
  });

  test('dependency springs PULL: the same pair sits closer WITH its edge than without', () => {
    // The differential is the point: comparing a linked pair against
    // strangers passed even with the springs deleted (the first cut of this
    // test — caught by its own mutation run), because seeding and repulsion
    // already separate strangers. Same estate, one edge added, SAME pair:
    // only the spring can shrink that distance.
    // A cluster big enough that repulsion spreads its rim far beyond the
    // spring length; the tested pair seeds at opposite ends of the spiral.
    const build = (edges: MapEdge[]): MapGraph => ({
      nodes: Array.from({ length: 30 }, (_, i) =>
        deriveNode('spring-' + String(i).padStart(2, '0'), { project: 'P', phaseId: null }, i)),
      edges,
      phases: [],
    });
    const distance = (graph: MapGraph, a: string, b: string) => {
      const centres = simulateOrganicCentres(graph);
      const pa = centres.get(a)!;
      const pb = centres.get(b)!;
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };
    const linked = distance(
      build([deriveEdge('spring-29', 'spring-00')]), 'spring-00', 'spring-29');
    const unlinked = distance(build([]), 'spring-00', 'spring-29');
    expect(linked).toBeLessThan(unlinked * 0.9);
  });

  test('cross-project repulsion keeps project clusters apart', () => {
    const nodes = [
      deriveNode('p1', { project: 'P', phaseId: null }, 0),
      deriveNode('p2', { project: 'P', phaseId: null }, 1),
      deriveNode('q1', { project: 'Q', phaseId: null }, 2),
      deriveNode('q2', { project: 'Q', phaseId: null }, 3),
    ];
    const centres = simulateOrganicCentres({ nodes, edges: [], phases: [] });
    const centroidOf = (ids: string[]) => {
      const points = ids.map(id => centres.get(id)!);
      return {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      };
    };
    const p = centroidOf(['p1', 'p2']);
    const q = centroidOf(['q1', 'q2']);
    // Clusters separate by more than their internal spread.
    const spread = Math.max(
      ...['p1', 'p2'].map(id => Math.hypot(centres.get(id)!.x - p.x, centres.get(id)!.y - p.y)),
      ...['q1', 'q2'].map(id => Math.hypot(centres.get(id)!.x - q.x, centres.get(id)!.y - q.y)));
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(spread * 2);
  });

  test('every band gets a convex hull that CONTAINS its tiles', () => {
    const graph = graphFromRecorded();
    const layout = layoutOrganic(graph, measuredSizes(graph));
    const hulls = layout.elements.filter((e): e is PlacedHull => e.kind === 'hull');
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    expect(hulls.length).toBeGreaterThan(1);
    let contained = 0;
    for (const tile of tiles) {
      const laneKey = tile.node.project ?? '__no_project__';
      const bandKey = tile.node.phaseId ?? '__no_phase__';
      const hull = hulls.find(h => h.id === `band:${laneKey}:${bandKey}`)!;
      expect(hull).toBeDefined();
      expect(insideConvex(hull.points, tile.x + tile.w / 2, tile.y + tile.h / 2)).toBe(true);
      contained += 1;
    }
    expect(contained).toBe(graph.nodes.length);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('layout is deterministic — identical input, identical output', () => {
    const graph = graphFromRecorded();
    const sizes = measuredSizes(graph);
    expect(JSON.stringify(layoutOrganic(graph, sizes).elements))
      .toEqual(JSON.stringify(layoutOrganic(graph, sizes).elements));
  });
});

describe('organic layout — adversarial shapes (recorded-row derived)', () => {
  test('an empty graph produces an empty, non-negative canvas', () => {
    const layout = layoutOrganic({ nodes: [], edges: [], phases: [] }, {});
    expect(layout.elements).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  test('a dense dependency clique cannot crush tiles into each other', () => {
    const nodes = Array.from({ length: 12 }, (_, i) =>
      deriveNode('k' + i, { project: 'P', phaseId: null }, i));
    const edges: MapEdge[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        edges.push(deriveEdge(nodes[j].id, nodes[i].id));
      }
    }
    const sizes = Object.fromEntries(nodes.map(n => [n.id, { w: 170, h: 96 }]));
    const layout = layoutOrganic({ nodes, edges, phases: [] }, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('wildly uneven tile heights still never overlap', () => {
    const nodes = Array.from({ length: 40 }, (_, i) =>
      deriveNode('n' + i, {
        project: i % 2 ? 'A' : 'B',
        phaseId: i % 3 === 0 ? 'ph1' : null,
      }, i));
    const sizes: Record<string, { w: number; h: number }> = {};
    nodes.forEach((n, i) => { sizes[n.id] = { w: 170, h: i % 7 === 0 ? 420 : 64 }; });
    const layout = layoutOrganic(
      { nodes, edges: [], phases: [derivePhase('ph1', 'A', 0, 'Phase one')] }, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('many projects with many phases stay disjoint', () => {
    const nodes: MapTaskNode[] = [];
    const phases: MapPhase[] = [];
    let seed = 0;
    for (let p = 0; p < 8; p += 1) {
      for (let ph = 0; ph < 3; ph += 1) {
        const phaseId = `p${p}-ph${ph}`;
        phases.push(derivePhase(phaseId, `P${p}`, ph, `Phase ${ph}`));
        for (let t = 0; t < 5; t += 1) {
          nodes.push(deriveNode(`${phaseId}-t${t}`, { project: `P${p}`, phaseId }, seed));
          seed += 1;
        }
      }
    }
    const sizes = Object.fromEntries(nodes.map((n, i) => [n.id, { w: 170, h: 70 + (i % 4) * 15 }]));
    const layout = layoutOrganic({ nodes, edges: [], phases }, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
  });

  test('MISSING measurements fall back without producing overlap', () => {
    const nodes = Array.from({ length: 15 }, (_, i) =>
      deriveNode('m' + i, { project: i % 3 ? 'A' : 'B', phaseId: null }, i));
    const layout = layoutOrganic({ nodes, edges: [], phases: [] }, {});
    expect(findOverlaps(layout.elements)).toEqual([]);
    const tiles = layout.elements.filter(e => e.kind === 'tile') as any[];
    expect(tiles.every(t => t.h === FALLBACK_TILE.h)).toBe(true);
  });

  test('report pills ride beside their tasks and survive hostile pill sizes', () => {
    const graph = withReports(graphFromRecorded(), 2);
    const sizes = withPillSizes(graph, { w: 120, h: 60 });
    const layout = layoutOrganic(graph, sizes);
    expect(findOverlaps(layout.elements)).toEqual([]);
    const tiles = new Map((layout.elements.filter(e => e.kind === 'tile') as any[])
      .map(t => [t.id, t]));
    for (const pill of layout.elements.filter(e => e.kind === 'pill') as any[]) {
      const tile = tiles.get(pill.taskId)!;
      expect(pill.x).toBe(tile.x + tile.w + LAYOUT_METRICS.pillGapX);
      expect(pill.y).toBeGreaterThanOrEqual(tile.y);
    }
  });
});

describe('organic threading (A7b slice 3)', () => {
  const graph = graphFromRecorded();
  const sizes = measuredSizes(graph);

  test('layoutTaskAltitude routes organic to the organic engine', () => {
    expect(JSON.stringify(layoutTaskAltitude(graph, sizes, 'organic')))
      .toEqual(JSON.stringify(layoutOrganic(graph, sizes)));
  });

  test('all four organizations REALLY differ', () => {
    const rendered = (['horizontal', 'vertical', 'radial', 'organic'] as const)
      .map(organization => JSON.stringify(layoutTaskAltitude(graph, sizes, organization)));
    expect(new Set(rendered).size).toBe(4);
  });

  test('the aggregate altitudes stay organization-neutral under organic', () => {
    for (const altitude of ['phase', 'project'] as const) {
      expect(JSON.stringify(layoutAtAltitude(graph, sizes, altitude, 16 / 10, 'organic')))
        .toEqual(JSON.stringify(layoutAtAltitude(graph, sizes, altitude, 16 / 10, 'horizontal')));
    }
  });

  test('settleAltitude under organic stays a fixed point', () => {
    const options = {
      clampScale,
      viewport: { width: 1280, height: 800 },
      organization: 'organic' as const,
    };
    const settled = settleAltitude(graph, sizes, { altitude: 'task', scale: 1 }, options);
    expect(settleAltitude(graph, sizes, settled, options)).toEqual(settled);
  });
});


describe('permutation determinism (pre-review 085a7d7a F1)', () => {
  const permute = <T,>(items: readonly T[]): T[] => {
    const reversed = [...items].reverse();
    const half = Math.ceil(reversed.length / 2);
    const a = reversed.slice(0, half);
    const b = reversed.slice(half);
    const mixed: T[] = [];
    for (let i = 0; i < half; i += 1) {
      mixed.push(a[i]);
      if (b[i] !== undefined) mixed.push(b[i]);
    }
    return mixed;
  };

  test('every organization is BYTE-identical under independently permuted input arrays', () => {
    // Float accumulation order leaks at the 1e-13 level long before any test
    // that compares "about equal" would notice — the assertion is exact
    // string equality of the full layout, nothing softer.
    // The recorded fixture is too sparse for accumulation order to bite (a
    // lane with one spring cannot leak order), so the estate is a DENSE
    // derived one: three projects, forty tasks, a spring mesh thick enough
    // that any wire-order accumulation shows at the byte level.
    const nodes = Array.from({ length: 40 }, (_, i) =>
      deriveNode('perm-' + String(i).padStart(2, '0'), {
        project: 'PQR'[i % 3],
        phaseId: i % 4 === 0 ? null : 'perm-ph' + (i % 3),
      }, i));
    const edges: MapEdge[] = [];
    for (let i = 0; i < 40; i += 1) {
      // Intra-lane steps (3, 6, 9 — same i%3 lane) give nodes ≥3 spring
      // contributions: two-term float sums commute EXACTLY, so an
      // order-of-accumulation leak only shows from three terms up. The
      // cross-lane steps (1, 7) keep the project mesh non-trivial.
      for (const step of [1, 3, 6, 7, 9]) {
        if (i + step < 40) edges.push(deriveEdge(nodes[i + step].id, nodes[i].id));
      }
    }
    const phases = [0, 1, 2].map(i => derivePhase('perm-ph' + i, 'PQR'[i], i));
    const base: MapGraph = withReports({ nodes, edges, phases }, 1);
    const sizes = withPillSizes(base, { w: 44, h: 44 });
    const permuted: MapGraph = {
      nodes: permute(base.nodes),
      edges: permute(base.edges),
      phases: permute(base.phases),
      reports: permute(base.reports ?? []),
    };
    for (const organization of ['horizontal', 'vertical', 'radial', 'organic'] as const) {
      const first = JSON.stringify(layoutTaskAltitude(
        JSON.parse(JSON.stringify(base)) as MapGraph, sizes, organization).elements);
      const second = JSON.stringify(layoutTaskAltitude(
        JSON.parse(JSON.stringify(permuted)) as MapGraph, sizes, organization).elements);
      expect(second).toEqual(first);
    }
  });
});

describe('flow ports on the continuous plane', () => {
  const points=(d:string)=>d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  test.each(['horizontal','vertical'] as const)('%s keeps both ports on the flow axis even for a back-link', organization=>{
    const a={x:400,y:400,w:170,h:96},b={x:100,y:100,w:170,h:96};
    const result=routeFlowEdge(a,b,[],{x:0,y:0,w:900,h:900},organization);
    expect(result.clipped).toBe(false);
    const p=points(result.d);
    expect(p.slice(0,2)).toEqual(organization==='horizontal'?[570,448]:[485,496]);
    expect(p.slice(-2)).toEqual(organization==='horizontal'?[100,148]:[185,100]);
    if(organization==='horizontal') {expect(p[2]).toBeGreaterThan(p[0]);expect(p.at(-4)!).toBeLessThan(p.at(-2)!);}
    else {expect(p[3]).toBeGreaterThan(p[1]);expect(p.at(-3)!).toBeLessThan(p.at(-1)!);}
  });
  test('horizontal report enters from above, away from dependency ports',()=>{
    const report={x:100,y:50,w:96,h:48},task={x:100,y:150,w:170,h:96};
    const result=routeFlowEdge(report,task,[],{x:0,y:0,w:600,h:500},'horizontal',true);
    expect(result.clipped).toBe(false);
    expect(points(result.d).slice(-2)).toEqual([185,150]);
  });
  test('fixed ports still avoid an intervening task',()=>{
    const a={x:40,y:100,w:170,h:96},b={x:650,y:100,w:170,h:96},block={x:350,y:80,w:170,h:140};
    const result=routeFlowEdge(a,b,[block],{x:0,y:0,w:1000,h:500},'horizontal');
    expect(result.clipped).toBe(false);
    const p=points(result.d);
    for(let i=2;i<p.length;i+=2) expect(segmentIntersectsBox(p[i-2],p[i-1],p[i],p[i+1],block)).toBe(false);
  });
});

test('flow routing weaves through local gaps when no corridor spans the whole field',()=>{
  const source={x:40,y:100,w:100,h:60},target={x:800,y:100,w:100,h:60};
  const obstacles=[{x:200,y:0,w:50,h:220},{x:350,y:180,w:50,h:320},
    {x:500,y:0,w:50,h:220},{x:650,y:180,w:50,h:320}];
  const route=routeFlowEdge(source,target,obstacles,{x:0,y:0,w:1000,h:500},'horizontal');
  expect(route.clipped).toBe(false);
  const p=route.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  for(let i=2;i<p.length;i+=2){
    expect(p[i]===p[i-2]||p[i+1]===p[i-1]).toBe(true);
    for(const box of obstacles)expect(segmentIntersectsBox(p[i-2],p[i-1],p[i],p[i+1],box)).toBe(false);
  }
});
