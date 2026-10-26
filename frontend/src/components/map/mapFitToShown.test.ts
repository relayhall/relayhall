/**
 * Owner ruling E386 (widening E375): the Map's areas fit ONLY what is shown.
 *
 * Reported on production: turning "show archived" on made every phase area
 * grow a lot, and turning it off left them grown, even after a reload. The
 * plane used to keep reserved geometry that only ever grew and persisted it in
 * the browser. These tests pin the replacement contract at the engine:
 *
 *   1. archived on -> off returns every area to its pre-toggle rectangle,
 *      exactly, in every organization (Horizontal, Vertical, Organic and
 *      Radial: regions and the archive core too), including a live task that
 *      depends on an archived one in its own phase;
 *   2. a lane, phase or connector group with nothing shown is not drawn and
 *      takes no ground, including a declared phase that holds no task;
 *   3. a task that leaves gives its ground back: no phase lattice keeps an
 *      empty column or an empty row;
 *   4. the session keeps ORDER only, so an update that does not change what is
 *      shown moves nothing, and an arrival moves no card already shown.
 */
import { describe, expect, test } from 'vitest';

import { LAYOUT_METRICS, type MapGraph, type MapPhase, type MapTaskNode, type PlacedElement } from './mapGraphModel';
import * as model from './mapPlaneModel';
import { EMPTY_PLANE_ANCHORS, PLANE_METRICS, layoutContinuousPlane, type PlaneLayoutResult } from './mapPlaneModel';

const task = (id: string, project: string | null, phaseId: string | null, status: string, minute: number): MapTaskNode => ({
  id, title: `Task ${id}`, status, priority: 'normal', project, phaseId,
  updated: `2026-10-20T07:${String(minute).padStart(2, '0')}:00.000Z`,
});

const TILE_GAP_X = LAYOUT_METRICS.tileGapX;
const TILE_GAP_Y = LAYOUT_METRICS.tileGapY;

const phase = (id: string, projectId: string, position: number): MapPhase => ({
  id, name: `Phase ${id}`, goal: null, projectId, position,
});

/**
 * Two live projects and one archived-only project. Alpha has a live phase
 * with a dependency chain (two columns), a second live phase, a DECLARED
 * phase with no task at all, a phase whose every task is archived, and an
 * unphased connector. Archived work is spread through the live phases too,
 * which is what made every area grow on production.
 */
function estate(includeArchived: boolean): MapGraph {
  const nodes: MapTaskNode[] = [];
  let minute = 0;
  for (let index = 0; index < 6; index += 1) nodes.push(task(`a1-${index}`, 'Alpha', 'a1', 'todo', minute++));
  for (let index = 0; index < 3; index += 1) nodes.push(task(`a2-${index}`, 'Alpha', 'a2', 'in-progress', minute++));
  nodes.push(task('a-connector', 'Alpha', null, 'todo', minute++));
  for (let index = 0; index < 3; index += 1) nodes.push(task(`b1-${index}`, 'Beta', 'b1', 'todo', minute++));
  if (includeArchived) {
    for (let index = 0; index < 11; index += 1) nodes.push(task(`a1-old-${index}`, 'Alpha', 'a1', 'archived', minute++));
    for (let index = 0; index < 13; index += 1) nodes.push(task(`a2-old-${index}`, 'Alpha', 'a2', 'archived', minute++));
    for (let index = 0; index < 4; index += 1) nodes.push(task(`a4-old-${index}`, 'Alpha', 'a4', 'archived', minute++));
    for (let index = 0; index < 2; index += 1) nodes.push(task(`b1-old-${index}`, 'Beta', 'b1', 'archived', minute++));
    for (let index = 0; index < 5; index += 1) nodes.push(task(`g-old-${index}`, 'Gamma', 'g1', 'archived', minute++));
  }
  const edges = [
    { from: 'a1-3', to: 'a1-0', kind: 'dependency' as const },
    { from: 'a1-4', to: 'a1-3', kind: 'dependency' as const },
    { from: 'a-connector', to: 'a2-0', kind: 'dependency' as const },
  ];
  return {
    nodes, edges,
    phases: [phase('a1', 'pa', 0), phase('a2', 'pa', 1), phase('a3', 'pa', 2), phase('a4', 'pa', 3),
      phase('b1', 'pb', 0), phase('g1', 'pg', 0)],
    reports: [{ id: 'r1', taskId: 'a1-0', title: 'Evidence' }],
  };
}

/** Every painted area and card, keyed by id: the rectangles a reader sees. */
const rects = (layout: PlaneLayoutResult) => Object.fromEntries(layout.elements
  .filter((element: PlacedElement) => ['band', 'chip', 'container', 'lane', 'tile', 'pill'].includes(element.kind))
  .map(element => [element.id, { x: element.x, y: element.y, w: element.w, h: element.h }]));

const area = (layout: PlaneLayoutResult, id: string) => {
  const found = layout.elements.find(element => element.id === id);
  if (!found) throw new Error(`no element ${id}`);
  return found.w * found.h;
};

describe('E386: archived on -> off returns every area to its pre-toggle size', () => {
  test.each(['horizontal', 'vertical'] as const)('%s: exact rectangles after showing and hiding archived work', organization => {
    const before = layoutContinuousPlane(estate(false), {}, organization, EMPTY_PLANE_ANCHORS);
    const shown = layoutContinuousPlane(estate(true), {}, organization, before.anchors);
    // Control: showing archived work really did grow the areas it lands in.
    expect(area(shown, 'band:Alpha:a1')).toBeGreaterThan(area(before, 'band:Alpha:a1'));
    expect(area(shown, 'band:Alpha:a2')).toBeGreaterThan(area(before, 'band:Alpha:a2'));
    expect(area(shown, 'container:Alpha')).toBeGreaterThan(area(before, 'container:Alpha'));

    const after = layoutContinuousPlane(estate(false), {}, organization, shown.anchors);
    expect(rects(after)).toEqual(rects(before));
    expect({ width: after.width, height: after.height }).toEqual({ width: before.width, height: before.height });

    // And again: a second round trip is not a different world either.
    const again = layoutContinuousPlane(estate(false), {}, organization,
      layoutContinuousPlane(estate(true), {}, organization, after.anchors).anchors);
    expect(rects(again)).toEqual(rects(before));
  });

  test('hiding archived work SHRINKS the areas it had grown', () => {
    const shown = layoutContinuousPlane(estate(true), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    const hidden = layoutContinuousPlane(estate(false), {}, 'horizontal', shown.anchors);
    for (const id of ['band:Alpha:a1', 'band:Alpha:a2', 'band:Beta:b1', 'container:Alpha', 'container:Beta']) {
      expect(area(hidden, id)).toBeLessThan(area(shown, id));
    }
    // Sized to what is shown: the same as a world that never saw the archive.
    const fresh = layoutContinuousPlane(estate(false), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    for (const id of ['band:Alpha:a1', 'band:Alpha:a2', 'band:Beta:b1']) {
      const [a, b] = [hidden, fresh].map(layout => layout.elements.find(element => element.id === id)!);
      expect({ w: a.w, h: a.h }).toEqual({ w: b.w, h: b.h });
    }
  });
});

/**
 * Round-1 review, blockers B1 and B2: the fit must be a property of EVERY
 * organization and of every shape of archived work, not of the estates the
 * first tests happened to choose. Geometry is a function of what is shown and
 * of the session's order, so hidden -> shown -> hidden returns every
 * rectangle, every region and the archive core exactly, and does so again on
 * a second round trip.
 *
 *   B1: a live task that depends on an archived task in its OWN phase. When
 *       the archive is shown the dependency becomes visible and the phase
 *       re-flows (the live task moves a column right); when it is hidden the
 *       phase must come back to the lattice it had, not keep that column.
 *   B2: Organic and Radial regions, and the Organic archive core, grow when
 *       archived work is shown; they must shrink back when it is hidden.
 */
const ORGANIZATIONS = ['horizontal', 'vertical', 'organic', 'radial'] as const;

/** B1, the reviewer's shape: phase p1 holds live B, C and D and archived A
 *  and A2, and B depends on A. The edge stays on the wire while A is hidden,
 *  as it does on the board; depths ignore an absent endpoint. */
const dependsOnArchived = (includeArchived: boolean): MapGraph => ({
  nodes: [task('B', 'P', 'p1', 'todo', 10), task('C', 'P', 'p1', 'todo', 11), task('D', 'P', 'p1', 'todo', 12),
    ...(includeArchived ? [task('A', 'P', 'p1', 'archived', 1), task('A2', 'P', 'p1', 'archived', 2)] : [])],
  edges: [{ from: 'B', to: 'A', kind: 'dependency' }],
  phases: [phase('p1', 'pp', 0), phase('p2', 'pp', 1)],
});

/** B2, the reviewer's shape: two live projects, P and Q, and twenty archived
 *  tasks split between their phases. */
const archivedInRegions = (includeArchived: boolean): MapGraph => ({
  nodes: [task('L1', 'P', 'p1', 'todo', 10), task('L2', 'P', 'p1', 'todo', 11), task('Q1', 'Q', 'q1', 'todo', 12),
    ...(includeArchived ? Array.from({ length: 20 }, (_, index) => task(`X${index}`,
      index % 2 ? 'P' : 'Q', index % 2 ? 'p1' : 'q1', 'archived', 20 + index)) : [])],
  edges: [], phases: [phase('p1', 'pp', 0), phase('q1', 'pq', 0)],
});

/** Everything a reader can see: cards, areas, Organic and Radial regions with
 *  their phase clusters and outlines, the archive core and the plane. */
const geometry = (layout: PlaneLayoutResult) => ({
  rects: rects(layout),
  regions: (layout.organicRegions ?? []).map(region => ({
    lane: region.laneId, core: region.core, box: region.box,
    clusters: region.clusters.map(({ x, y, w, h }) => [x, y, w, h]), outline: region.outline ?? null,
  })),
  plane: [layout.width, layout.height],
});

const regionBox = (layout: PlaneLayoutResult, lane: string) => {
  const found = (layout.organicRegions ?? []).find(region => region.laneId === lane);
  if (!found) throw new Error(`no region ${lane}`);
  return found.box;
};

function roundTripTwice(build: (includeArchived: boolean) => MapGraph,
  organization: (typeof ORGANIZATIONS)[number]) {
  const place = (includeArchived: boolean, anchors: model.MapPlaneAnchors) =>
    layoutContinuousPlane(build(includeArchived), {}, organization, anchors);
  const before = place(false, EMPTY_PLANE_ANCHORS);
  const trips: Array<{ shown: PlaneLayoutResult; after: PlaneLayoutResult }> = [];
  let anchors = before.anchors;
  for (let trip = 0; trip < 2; trip += 1) {
    const shown = place(true, anchors);
    const after = place(false, shown.anchors);
    trips.push({ shown, after });
    anchors = after.anchors;
  }
  return { before, trips };
}

describe('E386 round 2: hidden -> shown -> hidden is exact in every organization', () => {
  test.each(ORGANIZATIONS)('%s: B1 a live task depending on an archived task in its own phase', organization => {
    const { before, trips } = roundTripTwice(dependsOnArchived, organization);
    const [first] = trips;
    // Control: the archive is shown and B is drawn downstream of A.
    const tile = (layout: PlaneLayoutResult, id: string) => layout.elements.find(element => element.id === id)!;
    const flow = organization === 'vertical' ? 'y' : 'x';
    if (organization !== 'organic') {
      expect(tile(first.shown, 'B')[flow]).toBeGreaterThan(tile(first.shown, 'A')[flow]);
    }
    for (const { after } of trips) expect(geometry(after)).toEqual(geometry(before));
    // The phase is exactly the lattice its three live cards need.
    if (organization === 'horizontal' || organization === 'vertical') {
      const band = (layout: PlaneLayoutResult) => layout.elements.find(element => element.id === 'band:P:p1')!;
      expect({ w: band(trips[1].after).w, h: band(trips[1].after).h }).toEqual({ w: band(before).w, h: band(before).h });
    }
    // Showing the archive a second time is the same picture as the first.
    expect(geometry(trips[1].shown)).toEqual(geometry(first.shown));
  });

  test.each(ORGANIZATIONS)('%s: B2 regions and the archive core shrink back when archived work is hidden', organization => {
    const { before, trips } = roundTripTwice(archivedInRegions, organization);
    const [first] = trips;
    if (organization === 'organic') {
      // Control: the archive core and the regions around it really grew.
      const core = (layout: PlaneLayoutResult) => layout.organicRegions!.find(region => region.core)!.box;
      expect(core(first.shown).w).toBeGreaterThan(core(before).w);
      expect(regionBox(first.shown, 'P').w * regionBox(first.shown, 'P').h)
        .toBeGreaterThan(regionBox(before, 'P').w * regionBox(before, 'P').h);
      for (const { after } of trips) expect(core(after)).toEqual(core(before));
    }
    if (organization === 'radial') {
      expect(regionBox(first.shown, 'P').h).toBeGreaterThan(regionBox(before, 'P').h);
      expect(regionBox(first.shown, 'Q').h).toBeGreaterThan(regionBox(before, 'Q').h);
    }
    for (const { after } of trips) {
      for (const lane of organization === 'organic' || organization === 'radial' ? ['P', 'Q'] : []) {
        expect(regionBox(after, lane)).toEqual(regionBox(before, lane));
      }
      expect(geometry(after)).toEqual(geometry(before));
    }
    expect(geometry(trips[1].shown)).toEqual(geometry(first.shown));
  });

  test.each(ORGANIZATIONS)('%s: the estate round trip is exact, twice', organization => {
    const { before, trips } = roundTripTwice(estate, organization);
    for (const { after } of trips) expect(geometry(after)).toEqual(geometry(before));
  });

  test.each(['horizontal', 'vertical'] as const)('%s: a finished phase declared first takes its declared place when shown', organization => {
    // Since E386 a phase with nothing shown is not a segment, so a lane can
    // start mid-way through its declared phases. A phase that starts showing
    // work later (the archive shows a finished first phase) must take its
    // declared place, not trail the lane.
    const build = (includeArchived: boolean): MapGraph => ({
      nodes: [task('m1', 'P', 'p1', 'todo', 10), task('n1', 'P', 'p2', 'todo', 11),
        ...(includeArchived ? [task('done1', 'P', 'p0', 'archived', 1), task('done2', 'P', 'p0', 'archived', 2)] : [])],
      edges: [], phases: [phase('p0', 'pp', 0), phase('p1', 'pp', 1), phase('p2', 'pp', 2)],
    });
    const { before, trips } = roundTripTwice(build, organization);
    const flow = organization === 'vertical' ? 'y' : 'x';
    const band = (layout: PlaneLayoutResult, id: string) => layout.elements.find(element => element.id === `band:P:${id}`)!;
    for (const { shown } of trips) {
      expect(band(shown, 'p0')[flow]).toBeLessThan(band(shown, 'p1')[flow]);
      expect(band(shown, 'p1')[flow]).toBeLessThan(band(shown, 'p2')[flow]);
      expect(geometry(shown)).toEqual(geometry(layoutContinuousPlane(build(true), {}, organization, EMPTY_PLANE_ANCHORS)));
    }
    for (const { after } of trips) expect(geometry(after)).toEqual(geometry(before));
  });

  test.each(ORGANIZATIONS)('%s: hidden after shown is the world that never saw the archive', organization => {
    // Geometry is a function of what is shown and of the session's order:
    // a session that STARTS with the archive shown and then hides it lays out
    // exactly what a fresh layout of the live work does.
    for (const build of [dependsOnArchived, archivedInRegions, estate]) {
      const shown = layoutContinuousPlane(build(true), {}, organization, EMPTY_PLANE_ANCHORS);
      const hidden = layoutContinuousPlane(build(false), {}, organization, shown.anchors);
      const fresh = layoutContinuousPlane(build(false), {}, organization, EMPTY_PLANE_ANCHORS);
      expect(geometry(hidden)).toEqual(geometry(fresh));
    }
  });
});

describe('E386: nothing shown, nothing drawn', () => {
  test('a declared phase with no task is not displayed', () => {
    const layout = layoutContinuousPlane(estate(false), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    expect(layout.elements.filter(element => element.id.includes('Alpha:a3'))).toEqual([]);
  });

  test('a phase whose every task is archived disappears, with its ground, when archived is hidden', () => {
    const shown = layoutContinuousPlane(estate(true), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    expect(shown.elements.some(element => element.id === 'band:Alpha:a4')).toBe(true);
    const hidden = layoutContinuousPlane(estate(false), {}, 'horizontal', shown.anchors);
    expect(hidden.elements.filter(element => element.id.includes('Alpha:a4'))).toEqual([]);
    // The connector after a2 stands where it would in a world without a4.
    const fresh = layoutContinuousPlane(estate(false), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    const container = (layout: PlaneLayoutResult) => layout.elements.find(element => element.id === 'container:Alpha')!;
    expect(container(hidden).w).toBe(container(fresh).w);
  });

  test('an archived-only project takes no ground once archived is hidden', () => {
    const shown = layoutContinuousPlane(estate(true), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    expect(shown.elements.some(element => element.id === 'container:Gamma')).toBe(true);
    const hidden = layoutContinuousPlane(estate(false), {}, 'horizontal', shown.anchors);
    expect(hidden.elements.some(element => element.id.endsWith(':Gamma') || element.id.includes(':Gamma:'))).toBe(false);
    const fresh = layoutContinuousPlane(estate(false), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    expect(hidden.height).toBe(fresh.height);
  });
});

describe('E386: a task that leaves gives its ground back', () => {
  const crowd = (keep: (index: number) => boolean): MapGraph => ({
    nodes: Array.from({ length: 12 }, (_, index) => task(`t${String(index).padStart(2, '0')}`, 'Solo', 'p', 'todo', index))
      .filter((_, index) => keep(index)),
    edges: [], phases: [phase('p', 'ps', 0)],
  });

  test('a column the departures empty closes, and the rows close up in order', () => {
    // Twelve same-rank tasks fill one column of eight and four of the next.
    const full = layoutContinuousPlane(crowd(() => true), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    const columns = new Set(full.elements.filter(element => element.kind === 'tile').map(element => element.x));
    expect(columns.size).toBe(2);
    // Every task of the second column leaves, and every other one of the first.
    const remaining = (index: number) => index < 8 && index % 2 === 0;
    const after = layoutContinuousPlane(crowd(remaining), {}, 'horizontal', full.anchors);
    const fresh = layoutContinuousPlane(crowd(remaining), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    expect(rects(after)).toEqual(rects(fresh));
    // Order is kept: t00 above t02 above t04 above t06.
    const ys = ['t00', 't02', 't04', 't06'].map(id => after.elements.find(element => element.id === id)!.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  test('no phase lattice keeps an empty row or column after churn', () => {
    let anchors = EMPTY_PLANE_ANCHORS;
    const steps = [() => true, (i: number) => i % 3 !== 0, (i: number) => i > 5, () => true, (i: number) => i === 11];
    for (const keep of steps) {
      const layout = layoutContinuousPlane(crowd(keep), {}, 'horizontal', anchors);
      anchors = layout.anchors;
      const tiles = layout.elements.filter(element => element.kind === 'tile');
      const band = layout.elements.find(element => element.kind === 'band')!;
      const xs = [...new Set(tiles.map(tile => tile.x))].sort((a, b) => a - b);
      const ys = [...new Set(tiles.map(tile => tile.y))].sort((a, b) => a - b);
      // Every column and every row of the lattice holds a shown card: the
      // occupied columns and rows are contiguous at the declared pitch...
      xs.forEach((x, index) => expect(x).toBe(xs[0] + index * (PLANE_METRICS.tileCellW + TILE_GAP_X)));
      ys.forEach((y, index) => expect(y).toBe(ys[0] + index * (PLANE_METRICS.tileCellH + TILE_GAP_Y)));
      // ...and the band ends where the last of them does, plus its padding.
      expect(xs[0]).toBe(band.x + PLANE_METRICS.bandPadX);
      expect(band.x + band.w).toBe(xs[xs.length - 1] + PLANE_METRICS.tileCellW + PLANE_METRICS.bandPadX);
      expect(band.y + band.h).toBe(ys[ys.length - 1] + PLANE_METRICS.tileCellH + PLANE_METRICS.bandPadY);
    }
  });
});

describe('E386: the session keeps order, not ground', () => {
  test('an update that does not change what is shown moves nothing', () => {
    const first = layoutContinuousPlane(estate(false), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    const touched = estate(false);
    touched.nodes = [...touched.nodes].reverse().map(node => node.id === 'a2-1' ? { ...node, status: 'stuck', updated: '2026-10-20T09:00:00.000Z' } : node);
    const next = layoutContinuousPlane(touched, {}, 'horizontal', first.anchors);
    expect(rects(next)).toEqual(rects(first));
  });

  test('a card arriving in a phase moves no card already shown in it', () => {
    const first = layoutContinuousPlane(estate(false), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    const grown = estate(false);
    grown.nodes = [task('a1-new', 'Alpha', 'a1', 'todo', 59), ...grown.nodes];
    const next = layoutContinuousPlane(grown, {}, 'horizontal', first.anchors);
    for (let index = 0; index < 6; index += 1) {
      const id = `a1-${index}`;
      expect(rects(next)[id]).toEqual(rects(first)[id]);
    }
  });

  test('the fit strips reserved geometry and the slots of tasks not shown', () => {
    expect(typeof (model as Record<string, unknown>).fitPlaneAnchors).toBe('function');
    const fit = (model as unknown as { fitPlaneAnchors: (a: model.MapPlaneAnchors, g: MapGraph) => model.MapPlaneAnchors }).fitPlaneAnchors;
    const shown = layoutContinuousPlane(estate(true), {}, 'horizontal', EMPTY_PLANE_ANCHORS);
    // A record carrying the reservations an earlier engine kept: the type no
    // longer has them, and the fit drops whatever a record carries besides
    // the order.
    const fitted = fit({ ...shown.anchors, laneHeight: { Alpha: 99999 }, cols: { x: [999] }, rows: { x: [999] },
      segWidth: { x: 9999 }, laneHeaderW: { Alpha: 999 } } as model.MapPlaneAnchors, estate(false));
    for (const retired of ['laneHeight', 'cols', 'rows', 'segWidth', 'laneHeaderW']) {
      expect((fitted as unknown as Record<string, unknown>)[retired], retired).toBeUndefined();
    }
    expect(Object.keys(fitted.slots).sort()).toEqual(estate(false).nodes.map(node => node.id).sort());
    expect(fitted.laneOrder).toEqual(shown.anchors.laneOrder);
  });
});
