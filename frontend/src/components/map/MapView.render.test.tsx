// @vitest-environment jsdom
//
// RH-UI A7a — what the Map ACTUALLY RENDERS at each detail band.
//
// Review 51a17ab2 B1: the reviewed bytes declared a six-flag, four-band table
// and then consumed four flags at two coarse densities, so overview leaked
// close-only agent names and meta while the committed monotonic-table test
// stayed green. That test asserted the TABLE. These assert the RENDERED
// COMPONENT, which is the thing the table is supposed to govern.
//
// Wire shape comes from the RECORDED fixture. Component props (agent,
// progress, band flags) are supplied directly in the TaskCard suite below —
// props are a component's input, not a wire shape, so there is nothing to
// record there.

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../../utils/auth';
import type { Task } from '../../types/task';
import { TaskCard } from '../tasks/TaskCard';
import graphTaskFixture from './__fixtures__/graph.task.json';
import { MapView } from './MapView';
import { CHAIN_DIM, EDGE_DENSITY_THRESHOLD, planeStateClass } from './MapView';
import { DETAIL_MATRIX, DETAIL_THRESHOLDS } from './useMapData';

const VIEW_STORAGE_KEY = 'relayhall_map_view';

/**
 * The plane suite's estate, hoisted so the round-1 repair tests can share it:
 * the recorded ROW SHAPE at a size where the container tiers are real.
 */
const planeBigGraph = (() => {
  const template = (graphTaskFixture as any).nodes[0];
  const nodes = [...(graphTaskFixture as any).nodes];
  const edges = [...(graphTaskFixture as any).edges];
  const phases = [...(graphTaskFixture as any).phases];
  phases.push({ id: 'wide-phase', name: 'Wide', goal: null, projectId: 'wp', position: 0 });
  for (let depth = 0; depth < 5; depth += 1) {
    for (let row = 0; row < 3; row += 1) {
      const id = `wide-${depth}-${row}`;
      nodes.push({
        ...template, id, title: `Wide ${depth}.${row}`, status: 'todo',
        project: 'Wide Project', phaseId: 'wide-phase',
        updated: `2026-09-0${1 + row}T0${depth}:00:00.000Z`,
      });
      if (depth > 0) edges.push({ from: id, to: `wide-${depth - 1}-0`, kind: 'dependency' });
    }
  }
  for (let phase = 0; phase < 6; phase += 1) {
    phases.push({
      id: `deep-${phase}`, name: `Stage ${phase}`, goal: null,
      projectId: 'dp', position: phase,
    });
    for (let index = 0; index < 4; index += 1) {
      nodes.push({
        ...template, id: `deep-${phase}-${index}`, title: `Deep ${phase}.${index}`,
        status: 'todo', project: 'Deep Project', phaseId: `deep-${phase}`,
        updated: `2026-09-0${1 + index}T00:00:00.000Z`,
      });
    }
  }
  return { ...(graphTaskFixture as any), nodes, edges, phases };
})();


vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: () => () => {}, connected: false, send: () => {} }),
}));

const fetchMock = vi.mocked(authenticatedFetch);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

/**
 * Render the Map with the view pinned to a scale. A RESTORED view owes no fit
 * (useMapViewState), and jsdom reports a 0x0 viewport, which disables both the
 * auto-fit and viewport culling — so the seeded scale survives and every tile
 * is in the DOM.
 */
async function renderMapAtScale(scale: number, organization = 'horizontal') {
  sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
    scale, offsetX: 0, offsetY: 0, organization,
  }));
  render(<MapView query={{}} onOpenTask={() => {}} />, { wrapper });
  await waitFor(() => expect(document.querySelectorAll('.map-tile, .map-container').length).toBeGreaterThan(0));
}

/**
 * WHY SOME OF THESE RUN ON `vertical`.
 *
 * Amendment §2/§5-A3 makes the HORIZONTAL organization one continuous plane:
 * there are no altitudes there any more, and at far zoom a tile hands its
 * region to its phase container rather than staying a card nobody can read.
 * The tests below that are about §5's DETAIL TABLE, or about the A2 altitude
 * HIERARCHY, are about behaviour A3 leaves standing for the organizations
 * that still have it — so they run there, and the continuous plane's own
 * far band is asserted in its own suite at the end of this file.
 */

beforeEach(() => {
  sessionStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ ETag: '"g-test"' }),
    json: async () => graphTaskFixture,
  }) as unknown as Response);
});
afterEach(cleanup);

// A scale comfortably inside each band, derived from the thresholds rather
// than hard-coded, so retuning the thresholds cannot silently retarget these.
const BAND_SCALE = {
  far: DETAIL_THRESHOLDS.overview / 2,
  overview: (DETAIL_THRESHOLDS.overview + DETAIL_THRESHOLDS.mid) / 2,
  mid: (DETAIL_THRESHOLDS.mid + DETAIL_THRESHOLDS.close) / 2,
  close: DETAIL_THRESHOLDS.close + 0.4,
} as const;

describe('MapView — the detail table governs the rendered tile', () => {
  test('overview shows the title and CONTRACTS the meta row, without unmounting it', async () => {
    await renderMapAtScale(BAND_SCALE.overview);
    expect(DETAIL_MATRIX.overview).toMatchObject({ title: true, meta: false });
    const title = document.querySelector('.task-card-title-compact');
    const meta = document.querySelector('.task-card-map-meta');
    // §5: contracted content is FADED, never unmounted — both are present.
    expect(title).toBeInTheDocument();
    expect(meta).toBeInTheDocument();
    expect(title!.classList.contains('map-contracted')).toBe(false);
    expect(meta!.classList.contains('map-contracted')).toBe(true);
  });

  test('far hands controls to containers while the list retains every Task opener', async () => {
    await renderMapAtScale(BAND_SCALE.far, 'vertical');
    expect(document.querySelectorAll('.map-container').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.task-card-map-open')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /show as list/i }));
    expect(document.querySelectorAll('.map-tree button').length).toBe((graphTaskFixture as any).nodes.length);
    expect(document.querySelectorAll('.map-container[aria-hidden="false"]')).toHaveLength(0);
  });

  test('mid uncontracts the meta row INCLUDING the priority chip §3 requires', async () => {
    await renderMapAtScale(BAND_SCALE.mid);
    const meta = document.querySelector('.task-card-map-meta');
    expect(meta).toBeInTheDocument();
    expect(meta!.classList.contains('map-contracted')).toBe(false);
    // The reviewed bytes had no priority chip on the tile at any band.
    expect(document.querySelectorAll('.task-card-priority-compact').length).toBeGreaterThan(0);
  });

  test('the continuous plane retains geometry through all four ink bands', async () => {
    const geometry = () => [...document.querySelectorAll<SVGRectElement>('.map-project-ground,.map-phase-ground')]
      .map(e => ['x','y','width','height'].map(a=>e.getAttribute(a)));
    await renderMapAtScale(1.2, 'vertical');
    const before=geometry();
    expect(before.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-project-ground]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-phase-ground]').length).toBeGreaterThan(0);
    cleanup();
    for(const scale of [0.65,0.3,0.17]) {
      await renderMapAtScale(scale,'vertical');
      expect(geometry()).toEqual(before);
      for(const ground of document.querySelectorAll<SVGElement>('[data-project-ground],[data-phase-ground]'))
        expect(Number(ground.style.opacity)).toBe(1);
      cleanup();
    }
  });

  // PRESERVATION PIN, not a regression test — green on the reviewed bytes too.
  // It asserts that every recorded status reaches the DOM as a data-status
  // hook. It cannot see the tint: jsdom loads no stylesheet, so the
  // ideas/violet fill added for §3 is verified in live QA, not here. The hook
  // is still worth pinning, because the fill has nothing to attach to without
  // it.
  test('every recorded status reaches the DOM as a data-status hook, ideas included', async () => {
    await renderMapAtScale(BAND_SCALE.mid);
    const statuses = new Set(graphTaskFixture.nodes.map(n => n.status));
    expect(statuses.has('ideas')).toBe(true);
    for (const status of statuses) {
      expect(document.querySelectorAll(`.task-card[data-status="${status}"]`).length)
        .toBeGreaterThan(0);
    }
  });
});

describe('§4 density collapse for cross-lane edges', () => {
  /**
   * "above a density threshold (start ~60 visible edges) non-selected
   * cross-lane edges collapse to hover/selection-only."
   *
   * The recorded graph has 6 edges, so the threshold cannot be reached with it.
   * Nodes and their lanes stay recorded; only the edge set is synthesised,
   * which is unavoidable for a density contract.
   */
  const denseGraph = (edgeCount: number) => {
    const nodes = graphTaskFixture.nodes as any[];
    const byLane = new Map<string, any[]>();
    for (const node of nodes) {
      const lane = node.project ?? '__none__';
      byLane.set(lane, [...(byLane.get(lane) ?? []), node]);
    }
    const lanes = [...byLane.values()].filter(list => list.length > 0);
    const edges: any[] = [];
    // Alternate cross-lane and same-lane so both classes are present.
    for (let i = 0; edges.length < edgeCount; i += 1) {
      const a = lanes[i % lanes.length];
      const b = lanes[(i + 1) % lanes.length];
      const from = a[i % a.length];
      const crossTo = b[(i + 1) % b.length];
      const sameTo = a[(i + 1) % a.length];
      if (from && crossTo && from.id !== crossTo.id) {
        edges.push({ from: from.id, to: crossTo.id, kind: 'dependency' });
      }
      if (edges.length < edgeCount && from && sameTo && from.id !== sameTo.id) {
        edges.push({ from: from.id, to: sameTo.id, kind: 'dependency' });
      }
      if (i > edgeCount * 4) break;
    }
    return { ...graphTaskFixture, edges: edges.slice(0, edgeCount) };
  };

  const renderDense = async (edgeCount: number) => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: `"g-${edgeCount}"` }),
      json: async () => denseGraph(edgeCount),
    }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: BAND_SCALE.mid, offsetX: 0, offsetY: 0, organization: 'horizontal',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-tile').length).toBeGreaterThan(0));
  };

  const laneOfTile = (taskId: string) => {
    const node = (graphTaskFixture.nodes as any[]).find(n => n.id === taskId);
    return node?.project ?? null;
  };
  const renderedEdges = () => [...document.querySelectorAll('.map-edge--dependency')];

  test('BELOW the threshold every edge renders, cross-lane included', async () => {
    await renderDense(EDGE_DENSITY_THRESHOLD - 10);
    expect(renderedEdges().length).toBe(EDGE_DENSITY_THRESHOLD - 10);
  });

  test('ABOVE the threshold non-selected cross-lane edges collapse', async () => {
    const count = EDGE_DENSITY_THRESHOLD + 20;
    await renderDense(count);
    const drawn = renderedEdges().length;
    expect(drawn).toBeLessThan(count);
    // Same-lane edges are untouched: the collapse is cross-lane only.
    const graph = denseGraph(count);
    const sameLane = graph.edges.filter((e: any) => laneOfTile(e.from) === laneOfTile(e.to));
    expect(sameLane.length).toBeGreaterThan(0);
    expect(drawn).toBeGreaterThanOrEqual(sameLane.length);
  });

  test('a collapsed cross-lane edge comes back on HOVER (§4 hover/selection-only)', async () => {
    const count = EDGE_DENSITY_THRESHOLD + 20;
    await renderDense(count);
    const collapsed = renderedEdges().length;

    // Hover the tile that actually OWNS a collapsed cross-lane edge. Taking
    // the first tile in the DOM would make this pass or fail on fixture
    // ordering rather than on behaviour.
    const graph = denseGraph(count);
    const crossLane = graph.edges.find((e: any) => laneOfTile(e.from) !== laneOfTile(e.to));
    expect(crossLane, 'the dense fixture must contain a cross-lane edge').toBeTruthy();
    const tile = document.querySelector<HTMLElement>(`.map-tile[data-task="${crossLane.from}"]`);
    expect(tile, 'the cross-lane endpoint must be on the plane').toBeTruthy();

    fireEvent.pointerEnter(tile!);
    await waitFor(() => {
      // Its collapsed cross-lane edges come back, and only its own: the
      // disclosure is scoped to the tile the reader is pointing at.
      expect(renderedEdges().length).toBeGreaterThan(collapsed);
    });
    // The collapsed baseline itself is pinned by the test above, which renders
    // with no hover and no selection. Asserting the return-to-baseline HERE
    // would depend on jsdom's pointerout synthesis and on how many edges this
    // particular tile owns — neither of which is this behaviour.
  });

  test('selection discloses the chain even above the threshold', async () => {
    const count = EDGE_DENSITY_THRESHOLD + 20;
    await renderDense(count);
    const collapsed = renderedEdges().length;

    fireEvent.click(document.querySelector<HTMLElement>('.task-card-map-open')!);
    await waitFor(() => {
      expect(renderedEdges().length).toBeGreaterThanOrEqual(collapsed);
      expect(document.querySelectorAll('.map-tile--lit').length).toBeGreaterThan(0);
    });
  });
});

describe('§4 and §5 contracts the earlier rounds did not reach', () => {
  /**
   * The recorded graph carries only NULL phase goals, so nothing here would
   * exercise the goal path without varying it. The graph shape stays recorded;
   * one field is varied and this comment is the record of that.
   */
  const withPhaseGoal = () => ({
    ...graphTaskFixture,
    phases: (graphTaskFixture.phases as any[]).map((phase, index) =>
      (index === 0 ? { ...phase, goal: 'Rollback rehearsed end to end' } : phase)),
  });

  const renderWithGoal = async (scale: number) => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: '"g-goal"' }),
      json: async () => withPhaseGoal(),
    }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale, offsetX: 0, offsetY: 0, organization: 'horizontal',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-band-chip').length).toBeGreaterThan(0));
  };

  test('the phase goal appears at CLOSE, not at mid (§5)', async () => {
    expect(DETAIL_MATRIX.mid.goalLine).toBe(false);
    expect(DETAIL_MATRIX.close.goalLine).toBe(true);

    await renderWithGoal(BAND_SCALE.mid);
    const atMid = document.querySelector('.map-band-goal');
    expect(atMid, 'the goal must stay MOUNTED so the chip box cannot change').toBeInTheDocument();
    expect(atMid!.classList.contains('map-contracted')).toBe(true);
    cleanup();

    await renderWithGoal(BAND_SCALE.close);
    const atClose = document.querySelector('.map-band-goal');
    expect(atClose).toBeInTheDocument();
    expect(atClose!.classList.contains('map-contracted')).toBe(false);
  });

  test('chip composition is identical across bands, so the band cannot resize', async () => {
    // The chip is MEASURED and its box sets the band header height and width,
    // so mounting the goal at a threshold would move the band itself.
    const chipComposition = () => [...document.querySelectorAll('.map-band-chip')]
      .map(chip => [...chip.children]
        .map(child => child.className.toString().replace(/\s*map-contracted/g, '').trim())
        .join(','))
      .join('|');

    await renderWithGoal(BAND_SCALE.overview);
    const overview = chipComposition();
    cleanup();
    await renderWithGoal(BAND_SCALE.mid);
    const mid = chipComposition();
    cleanup();
    await renderWithGoal(BAND_SCALE.close);
    const close = chipComposition();

    expect(overview.length).toBeGreaterThan(0);
    expect(mid).toBe(overview);
    expect(close).toBe(overview);
  });

  test('clicking empty plane clears the chain selection (§4)', async () => {
    // The clear handler required target === currentTarget, but the transformed
    // `.map-plane` covers the canvas, so every empty click had the PLANE as its
    // target and was ignored.
    await renderMapAtScale(BAND_SCALE.mid);
    const opener = document.querySelector<HTMLElement>('.task-card-map-open');
    fireEvent.click(opener!);
    await waitFor(() => {
      expect(document.querySelectorAll('.map-tile--lit').length).toBeGreaterThan(0);
    });

    const plane = document.querySelector<HTMLElement>('.map-plane');
    fireEvent.click(plane!);
    await waitFor(() => {
      expect(document.querySelectorAll('.map-tile--lit')).toHaveLength(0);
      expect(document.querySelectorAll('.map-tile--dimmed')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Tile composition per band, at the component boundary.
// ---------------------------------------------------------------------------

const TILE_TASK = {
  id: 't1', title: 'Cut over the reverse proxy', status: 'in-progress',
  priority: 'high', project: 'Atlas Migration', subtasks: [],
} as unknown as Task;

function renderTile(band: keyof typeof DETAIL_MATRIX) {
  const detail = DETAIL_MATRIX[band];
  return render(
    <MemoryRouter>
    <TaskCard
      task={TILE_TASK}
      density={detail.meta ? 'map-detail' : 'map-tile'}
      mapAgent="Relay"
      mapProgress={{ done: 2, total: 4 }}
      mapDetail={detail}
      onOpen={() => {}}
      onDragStart={() => {}} onDragEnd={() => {}}
      onUpdate={() => {}} onSubtaskTransition={async () => {}} onDelete={() => {}}
      disableDrag
    />
    </MemoryRouter>,
  );
}

describe('the map tile composes exactly what its band allows', () => {
  /** Present in the DOM (always) and NOT contracted (band-dependent). */
  const shown = (selector: string) => {
    const element = document.querySelector(selector);
    expect(element, `${selector} must stay mounted in every band (§5)`).toBeInTheDocument();
    return !element!.classList.contains('map-contracted');
  };

  test.each([
    ['far', false, false, false, false],
    ['overview', true, false, false, false],
    ['mid', true, true, true, false],
    ['close', true, true, true, true],
  ] as const)('%s', (band, title, meta, progress, agentName) => {
    renderTile(band);
    expect(shown('.task-card-title-compact')).toBe(title);
    expect(shown('.task-card-map-meta')).toBe(meta);
    // The priority chip lives inside the meta row and contracts with it.
    expect(document.querySelector('.task-card-priority-compact')).toBeInTheDocument();
    expect(shown('.task-card-map-progress')).toBe(progress);
    // The agent NAME is close-only...
    expect(shown('.task-card-map-agent-name')).toBe(agentName);
    // ...but §3's liveness signal survives EVERY band, far included. This is
    // the assertion that catches a future LOD change quietly hiding the dot,
    // which is how the far-zoom opacity defect reached live QA.
    expect(document.querySelector('.task-card-map-agent')).toBeInTheDocument();
    expect(document.querySelector('.task-card-map-agent-dot')).toBeInTheDocument();
    cleanup();
  });

  // PRESERVATION PIN, not a regression test — the sr-only announcement was
  // never gated, so this is green on the reviewed bytes too. It guards the
  // next LOD change from taking the screen-reader signal away.
  test('the accessible agent announcement survives every band', () => {
    for (const band of ['far', 'overview', 'mid', 'close'] as const) {
      renderTile(band);
      expect(screen.getByText('Relay is working on this now')).toBeInTheDocument();
      cleanup();
    }
  });
});

/**
 * Everything the reader pans and zooms MUST live inside `.map-plane`.
 *
 * This exists because live QA at 5,206 tasks caught the aggregate nodes and
 * the aggregate Report nodes rendering OUTSIDE the transformed plane: they had
 * been anchored, during editing, on the loading overlay — which sits in the
 * canvas, not the plane. The picture looked plausible on arrival (a grid of
 * boxes filling the viewport) and was entirely inert: a 220px node measured
 * 220px on screen at scale 0.347, it did not resize on zoom, and it did not
 * move on pan.
 *
 * The whole suite stayed green through all of it, because a detail-band test
 * asserts what a node DRAWS and a geometry test asserts where the layout PUTS
 * it — neither asks which element the browser will transform. So this asks.
 */
describe('MapView — the transformed plane owns every pannable element', () => {
  const PANNABLE = [
    '.map-tile',
    '.map-band',
    '.map-band-chip',
    '.map-lane-header',
    '.map-report-pill',
    '.map-container:not(.map-container--shape)',
    '.map-aggregate-report',
    '.map-container',
    '.map-edges',
  ];

  const assertInsidePlane = () => {
    const plane = document.querySelector('.map-plane');
    expect(plane).not.toBeNull();
    let checked = 0;
    for (const selector of PANNABLE) {
      for (const element of document.querySelectorAll(selector)) {
        checked += 1;
        // `contains` is true for the node itself, so a plane that somehow
        // matched one of these selectors could not vacuously pass.
        expect(plane!.contains(element)).toBe(true);
        expect(element).not.toBe(plane);
      }
    }
    return checked;
  };

  test('at the task altitude', async () => {
    await renderMapAtScale(BAND_SCALE.mid);
    expect(document.querySelectorAll('.map-tile').length).toBeGreaterThan(0);
    expect(assertInsidePlane()).toBeGreaterThan(0);
  });

  test('at an aggregate altitude', async () => {
    // jsdom reports a 0x0 viewport, so the auto-fit never runs and the
    // persisted altitude is what renders. Pin the phase altitude directly.
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 0.28, offsetX: 0, offsetY: 0, organization: 'vertical', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBeGreaterThan(0));
    // The altitude really did change what is drawn, so this is not the task
    // altitude wearing a different name.
    expect(document.querySelectorAll('.task-card-map-open')).toHaveLength(0);
    expect(assertInsidePlane()).toBeGreaterThan(0);
  });
});

/**
 * B4 from the adversarial pre-review (report 33801b5c): the task-altitude
 * Report pill was a non-focusable <span> with no handler, so the Report was
 * unreachable at that altitude. A2 requires it to be openable from the Map,
 * and A2.1 changes only WHERE it is drawn.
 */
describe('MapView — a Report is openable at the task altitude (A2 via B4)', () => {
  test('the pill is a named control that opens its Report', async () => {
    const opened: string[] = [];
    // The recorded graph fixture carries no Reports (see SHAPE.json), so they
    // are attached here in the serializer's own row shape - {id, taskId,
    // title} exactly as backend queryLinkedReports returns.
    const firstTask = (graphTaskFixture as any).nodes[0].id;
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ ETag: '"g-reports"' }),
      json: async () => ({
        ...(graphTaskFixture as any),
        reports: [{ id: 'report-open-me', taskId: firstTask, title: 'Openable report' }],
      }),
    }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: BAND_SCALE.close, offsetX: 0, offsetY: 0,
      organization: 'horizontal', altitude: 'task',
    }));
    render(
      <MapView query={{}} onOpenTask={() => {}} onOpenReport={id => opened.push(id)} />,
      { wrapper },
    );
    await waitFor(() => expect(document.querySelectorAll('.map-tile').length).toBeGreaterThan(0));

    const pill = document.querySelector('.map-report-pill');
    // NOT an early return: the fixture is seeded with Reports above precisely
    // so this cannot pass by finding nothing. A vacuous version of this test
    // would have gone green against the very defect it exists to catch.
    expect(pill).not.toBeNull();
    const opener = pill!.querySelector('button');
    expect(opener).not.toBeNull();
    // A control with no accessible name is not reachable in practice.
    expect(opener!.getAttribute('aria-label') || opener!.textContent).toBeTruthy();
    fireEvent.click(opener!);
    expect(opened.length).toBeGreaterThan(0);
  });
});

/**
 * B2 from review round 2 (report 82a9fbf7): selecting "Show as list" left the
 * canvas active, so the reader met every Task twice — once as a canvas opener
 * and once in the list — and had to traverse a role=application canvas to
 * reach the alternative that exists to spare them it.
 */
describe('MapView — list mode REPLACES the canvas (§6 via round 2 B2)', () => {
  test('the canvas leaves the accessibility tree and the list is complete', async () => {
    await renderMapAtScale(BAND_SCALE.mid);
    const canvas = document.querySelector('.map-canvas')!;
    const tasksInScope = (graphTaskFixture as any).nodes.length as number;

    // Before: the canvas is the surface.
    expect(canvas.getAttribute('aria-hidden')).toBeNull();
    expect(canvas.getAttribute('tabindex')).toBe('0');
    expect(document.querySelectorAll('.map-tree').length).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /show as list/i }));

    // After: still MOUNTED (§8), but out of the a11y tree and the tab order.
    expect(document.querySelector('.map-canvas')).not.toBeNull();
    expect(document.querySelector('.map-canvas')!.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.map-canvas')!.getAttribute('tabindex')).toBe('-1');
    // aria-hidden is what accessibility queries respect, so the canvas's own
    // Task openers must no longer be reachable through them.
    expect(screen.queryByRole('application')).toBeNull();

    // And the list carries every in-scope Task EXACTLY once.
    const items = document.querySelectorAll('.map-tree li');
    expect(items.length).toBe(tasksInScope);

    // Switching back restores the canvas.
    fireEvent.click(screen.getByRole('button', { name: /show as map/i }));
    expect(document.querySelector('.map-canvas')!.getAttribute('aria-hidden')).toBeNull();
    expect(document.querySelector('.map-canvas')!.getAttribute('tabindex')).toBe('0');
    expect(screen.queryByRole('application')).not.toBeNull();
  });
});

/**
 * B1 from round 5 (report b03f6be6): the §4 collapse was UNREACHABLE at the
 * aggregate altitudes. Aggregate nodes carried no hover, focus or click state,
 * and the collapse was fed Task ids, so a collapsed relationship could never
 * come back - for anyone, by any means.
 */
describe('MapView — an aggregate node can be hovered and selected (round 5 B1)', () => {
  test('it exposes a real control that toggles selection', async () => {
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 0.28, offsetX: 0, offsetY: 0, organization: 'vertical', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBeGreaterThan(0));

    const node = document.querySelector('.map-container:not(.map-container--shape)')!;
    const control = node.querySelector('button');
    // Without a control there is no keyboard path to the reveal at all.
    expect(control).not.toBeNull();
    expect(control!.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(control!);
    expect(control!.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.map-container--selected')).not.toBeNull();

    // And it toggles back off.
    fireEvent.click(control!);
    expect(control!.getAttribute('aria-pressed')).toBe('false');
  });

  test('pointer hover reaches the node too', async () => {
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 0.28, offsetX: 0, offsetY: 0, organization: 'vertical', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBeGreaterThan(0));
    const node = document.querySelector('.map-container:not(.map-container--shape)')!;
    // A node with no pointer handler cannot reveal anything on hover; this
    // fires the real listener rather than asserting on the attribute.
    expect(() => fireEvent.pointerEnter(node)).not.toThrow();
    expect(() => fireEvent.pointerLeave(node)).not.toThrow();
  });
});

/** Regressions for review round 6 (report 1392f386) on the rendered surface. */
describe('MapView — round 6 rendered findings', () => {
  const atPhase = () => {
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 0.28, offsetX: 0, offsetY: 0, organization: 'vertical', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
  };

  test('B5: every aggregate control says WHICH aggregate it selects', async () => {
    atPhase();
    await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBeGreaterThan(0));
    const names = [...document.querySelectorAll('.map-container:not(.map-container--shape) button')]
      .map(b => b.getAttribute('aria-label') ?? b.textContent ?? '');
    expect(names.length).toBeGreaterThan(1);
    // The recorded fixture alone renders several phases named "No phase"; a
    // control performing a different selection must be distinguishable.
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.length).toBeGreaterThan(0);
  });

  test('B4: a stale aggregate selection never dims every Task', async () => {
    atPhase();
    await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBeGreaterThan(0));
    fireEvent.click(document.querySelector('.map-container:not(.map-container--shape) button')!);
    expect(document.querySelector('.map-container--selected')).not.toBeNull();

    // Now render the task altitude with that selection still in storage: an
    // aggregate id must not activate task-chain dimming (round 6, B4 measured
    // 14 of 14 tiles dimmed - the highlight inverted into a blackout).
    cleanup();
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: BAND_SCALE.mid, offsetX: 0, offsetY: 0,
      organization: 'horizontal', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-tile').length).toBeGreaterThan(0));
    const tiles = document.querySelectorAll('.map-tile');
    const dimmed = document.querySelectorAll('.map-tile--dimmed');
    expect(dimmed.length).toBeLessThan(tiles.length);
  });
});

/**
 * B1 from round 9 (report 80daaadf): the aggregate chain was built from
 * `hoveredId ?? selectedId`, so grazing ANY other aggregate replaced an
 * explicit selection — the selected node itself dimmed and every one of its
 * relationships left the DOM while the pointer sat on an unrelated node. §4
 * says the selected chain STAYS lit. This is the fifth composition defect in
 * this candidate: selection worked, hover worked, and the identity that JOINS
 * them was wrong — which is exactly what the round-5/round-8 tests above
 * could not see, because neither ever held a selection and a hover at once.
 *
 * The graph is synthetic for the same reason the density suite's is: the
 * hostile shape needs two DISCONNECTED chains, each larger than the §4
 * collapse threshold, and every edge cross-lane so nothing survives collapse
 * on its own. The recorded fixture cannot express that.
 */
describe('MapView — hover must not replace an explicit aggregate selection (round 9 B1)', () => {
  // A forward bipartite DAG has N²/4 cross-lane edges. This keeps each
  // disconnected chain ABOVE the real collapse threshold using 16 phase
  // cards instead of 71. Adjacent nodes still form a transitive backbone;
  // even-indexed descendants require traversal through an intermediate node.
  const CHAIN_NODES = 2 * Math.ceil(Math.sqrt(EDGE_DENSITY_THRESHOLD + 1));
  const CHAIN = CHAIN_NODES ** 2 / 4;

  const twoChainGraph = () => {
    const nodes: any[] = [];
    const edges: any[] = [];
    const phases: any[] = [];
    const mk = (prefix: string, laneA: string, laneB: string) => {
      for (let i = 0; i < CHAIN_NODES; i += 1) {
        const id = `${prefix}${i}`;
        const project = i % 2 === 0 ? laneA : laneB; // alternate: every edge cross-lane
        nodes.push({
          id, title: `Task ${id}`, status: 'completed', priority: 'medium',
          project, phaseId: `phase-${id}`, updated: '2026-08-20T00:00:00.000Z',
        });
        phases.push({
          id: `phase-${id}`, name: id.toUpperCase(), goal: null,
          projectId: `proj-${project}`, position: i,
        });
        for (let previous = 0; previous < i; previous += 1) {
          if ((i - previous) % 2 === 1) {
            edges.push({ from: `${prefix}${previous}`, to: id, kind: 'dependency' });
          }
        }
      }
    };
    mk('a', 'Alpha', 'Beta');
    mk('b', 'Gamma', 'Delta');
    return { ...graphTaskFixture, nodes, edges, phases };
  };

  const aggregateOf = (label: RegExp) => {
    // Each title already has an explicit accessible label. Resolve that
    // label directly, then check visibility on the matched native button;
    // getByRole computes names/visibility for every button in the dense map.
    const button = screen.getByLabelText(label, { selector: 'button' });
    expect(button).toBeVisible();
    return button.closest('.map-container:not(.map-container--shape)') as HTMLElement;
  };
  const drawn = () => document.querySelectorAll('.map-edge--aggregate').length;

  test('the selected chain stays lit and fully drawn while a disconnected node is hovered, and hover-only disclosure returns once the selection clears', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: '"g-two-chains"' }),
      json: async () => twoChainGraph(),
    }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 0.28, offsetX: 0, offsetY: 0, organization: 'vertical', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBe(2 * CHAIN_NODES));

    expect(CHAIN).toBeGreaterThan(EDGE_DENSITY_THRESHOLD);
    // Baseline: everything is cross-lane and nothing is selected, so the §4
    // collapse leaves fewer edges than one chain owns.
    expect(drawn()).toBeLessThan(CHAIN);

    const a0 = aggregateOf(/select phase A0 of project alpha/i);
    const b0 = aggregateOf(/select phase B0 of project gamma/i);

    // Select a0: its whole above-threshold transitive chain must come back.
    fireEvent.click(a0.querySelector('button')!);
    await waitFor(() => expect(drawn()).toBeGreaterThanOrEqual(CHAIN));
    expect(a0.classList.contains('map-container--selected')).toBe(true);
    expect(a0.classList.contains('map-container--lit')).toBe(true);
    expect(b0.classList.contains('map-container--dimmed')).toBe(true);
    // §4 AT THIS ALTITUDE TOO. The continuous plane had to make its dim a
    // NUMBER because the cross-fade writes opacity inline and an inline
    // number beats any stylesheet rule; the A2 engine writes no inline
    // opacity at all, which is what leaves `.map-container--dimmed`
    // authoritative here. If that ever changes, §4 stops happening on this
    // plane silently — exactly how it was lost on the other one.
    expect(Number(b0.style.opacity)).toBeGreaterThan(0);
    expect(Number(b0.style.opacity)).toBeLessThan(Number(a0.style.opacity));
    expect(Number(a0.style.opacity)).toBeGreaterThan(0);

    // THE HOSTILE MOMENT: hover the disconnected chain. Before the round-9
    // repair this replaced the chain identity — a0 dimmed, its chain edges
    // vanished, and b0's chain lit instead.
    fireEvent.pointerEnter(b0);
    expect(a0.classList.contains('map-container--selected')).toBe(true);
    expect(a0.classList.contains('map-container--lit')).toBe(true);
    expect(a0.classList.contains('map-container--dimmed')).toBe(false);
    expect(b0.classList.contains('map-container--dimmed')).toBe(true);
    expect(drawn()).toBeGreaterThanOrEqual(CHAIN);

    // Clearing the selection hands the chain to the hover that is still
    // sitting on b0: hover-only disclosure must come back on its own.
    fireEvent.click(a0.querySelector('button')!);
    await waitFor(() => expect(b0.classList.contains('map-container--lit')).toBe(true));
    expect(a0.classList.contains('map-container--dimmed')).toBe(true);
    expect(drawn()).toBeGreaterThanOrEqual(CHAIN);
  });
});

/**
 * Round 10 (report a34abc19): two more consumers of the chain identity found
 * disagreeing with §4.
 *
 * B1: the round-9 `selectedId ?? hoveredId` swap let a selection an ordinary
 * filter refresh had REMOVED from scope keep outranking the hover — no chain
 * could ever be disclosed again until the reader happened to click something.
 * B2: the A2.1 aggregate Report surface never consumed the chain at all: its
 * nodes and converging edges stayed at full opacity while §4 dimmed every
 * dependency surface around them.
 */
describe('MapView — round 10 rendered findings', () => {
  const CHAIN_NODES = 2 * Math.ceil(Math.sqrt(EDGE_DENSITY_THRESHOLD + 1));
  const CHAIN = CHAIN_NODES ** 2 / 4;

  const chain = (prefix: string, laneA: string, laneB: string) => {
    const nodes: any[] = []; const edges: any[] = []; const phases: any[] = [];
    for (let i = 0; i < CHAIN_NODES; i += 1) {
      const id = `${prefix}${i}`;
      const project = i % 2 === 0 ? laneA : laneB;
      nodes.push({
        id, title: `Task ${id}`, status: 'completed', priority: 'medium',
        project, phaseId: `phase-${id}`, updated: '2026-08-20T00:00:00.000Z',
      });
      phases.push({ id: `phase-${id}`, name: id.toUpperCase(), goal: null, projectId: `proj-${project}`, position: i });
      for (let previous = 0; previous < i; previous += 1) {
        if ((i - previous) % 2 === 1) {
          edges.push({ from: `${prefix}${previous}`, to: id, kind: 'dependency' });
        }
      }
    }
    return { nodes, edges, phases };
  };
  const graphOf = (...parts: ReturnType<typeof chain>[]) => ({
    ...graphTaskFixture,
    nodes: parts.flatMap(p => p.nodes),
    edges: parts.flatMap(p => p.edges),
    phases: parts.flatMap(p => p.phases),
  });
  const chainA = () => chain('a', 'Alpha', 'Beta');
  const chainB = () => chain('b', 'Gamma', 'Delta');

  const serve = (graph: any, tag: string) => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: `"${tag}"` }),
      json: async () => graph,
    }) as unknown as Response);
  };
  const atPhase = () => {
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 0.28, offsetX: 0, offsetY: 0, organization: 'vertical', altitude: 'task',
    }));
    return render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
  };
  const aggregateOf = (label: RegExp) => {
    const button = screen.getByLabelText(label, { selector: 'button' });
    expect(button).toBeVisible();
    return button.closest('.map-container:not(.map-container--shape)') as HTMLElement;
  };
  const drawn = () => document.querySelectorAll('.map-edge--aggregate').length;

  test('B1: a selection removed by an ordinary filter refresh stops outranking hover', async () => {
    serve(graphOf(chainA(), chainB()), 'g-r10-full');
    const { rerender } = atPhase();
    await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBe(2 * CHAIN_NODES));

    expect(CHAIN).toBeGreaterThan(EDGE_DENSITY_THRESHOLD);
    const a0 = aggregateOf(/select phase A0 of project alpha/i);
    fireEvent.click(a0.querySelector('button')!);
    await waitFor(() => expect(document.querySelector('.map-container--selected')).not.toBeNull());

    // An ordinary query change refreshes the graph WITHOUT chain A. No
    // altitude transition happens, so nothing clears selectedId — the round-9
    // code kept preferring the dead id and hover was mute forever.
    serve(graphOf(chainB()), 'g-r10-b-only');
    rerender(<MapView query={{ statuses: ['completed'] }} onOpenTask={() => {}} onOpenReport={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBe(CHAIN_NODES));
    expect(document.querySelector('.map-container--selected')).toBeNull();

    const b0 = aggregateOf(/select phase B0 of project gamma/i);
    fireEvent.pointerEnter(b0);
    await waitFor(() => expect(b0.classList.contains('map-container--lit')).toBe(true));
    expect(drawn()).toBeGreaterThanOrEqual(CHAIN);
  });

  test('B2: a Report cited only by the OTHER chain dims with it — node and converging edge', async () => {
    const graph=graphOf(chainA(),chainB());
    graph.nodes=graph.nodes.filter(n=>['a0','a1','b0','b1'].includes(n.id));
    const ids=new Set(graph.nodes.map(n=>n.id));
    graph.edges=graph.edges.filter(e=>ids.has(e.from)&&ids.has(e.to));
    graph.phases=graph.phases.filter(p=>graph.nodes.some(n=>n.phaseId===p.id));
    (graph as any).reports=[{id:'r-b0',taskId:'b0',title:'Chain B evidence'}];
    serve(graph,'g-r10-report');
    await renderMapAtScale(1.5);
    const reportNode=()=>document.querySelector('.map-report-pill')!;
    const reportEdge=()=>document.querySelector('.map-edge--report')!;
    expect(reportNode()).not.toBeNull();expect(reportEdge()).not.toBeNull();
    expect(reportNode().classList.contains('map-report-pill--dimmed')).toBe(false);
    fireEvent.click(document.querySelector('[data-task="a0"]')!);
    await waitFor(()=>expect(reportNode().classList.contains('map-report-pill--dimmed')).toBe(true));
    expect(reportEdge().classList.contains('map-edge--dimmed')).toBe(true);
    expect(reportEdge().classList.contains('map-edge--lit')).toBe(false);
    fireEvent.click(document.querySelector('[data-task="b0"]')!);
    await waitFor(()=>expect(reportNode().classList.contains('map-report-pill--dimmed')).toBe(false));
    expect(reportEdge().classList.contains('map-edge--lit')).toBe(true);
    expect(reportEdge().classList.contains('map-edge--dimmed')).toBe(false);
  });

});

/**
 * B2 from round 11 (report 0228d375): round 10 brought the AGGREGATE Report
 * surface into §4 and left the TASK altitude's out, so the two altitudes
 * disagreed under the same binding rule — selecting disconnected Task A
 * dimmed Task B while B's Report pill and its local dashed edge stayed at
 * ordinary presentation.
 */
describe('MapView — task-altitude Report pills dim with the chain (round 11 B2)', () => {
  test('a pill cited by a Task outside the selected chain dims, node and edge, and lights with the citing chain', async () => {
    const edges = (graphTaskFixture as any).edges as any[];
    const inEdge = new Set(edges.flatMap(e => [e.from, e.to]));
    const nodes = (graphTaskFixture as any).nodes as any[];
    // Derived from the fixture rather than hard-coded so a re-recording
    // cannot silently retarget the test at a connected pair.
    const isolated = nodes.find(n => !inEdge.has(n.id));
    const connected = nodes.find(n => inEdge.has(n.id));
    expect(isolated, 'the recorded fixture must contain an edgeless task').toBeTruthy();
    expect(connected, 'the recorded fixture must contain a connected task').toBeTruthy();

    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: '"g-r11-pill"' }),
      json: async () => ({
        ...(graphTaskFixture as any),
        reports: [{ id: 'r-dim-me', taskId: isolated.id, title: 'Cited by the other chain' }],
      }),
    }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: BAND_SCALE.close, offsetX: 0, offsetY: 0,
      organization: 'horizontal', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelector('.map-report-pill')).not.toBeNull());

    const pill = () => document.querySelector('.map-report-pill')!;
    const reportEdge = () => document.querySelector('.map-edge--report')!;
    const tileOf = (id: string) => document.querySelector(`.map-tile[data-task="${id}"]`)!;

    // No chain: ordinary presentation.
    expect(pill().classList.contains('map-report-pill--dimmed')).toBe(false);
    expect(reportEdge().classList.contains('map-edge--dimmed')).toBe(false);

    // Select a CONNECTED task: the isolated task leaves the chain — §4 dims
    // its tile, and the Report surface citing it must recede with it.
    fireEvent.click(tileOf(connected.id));
    await waitFor(() => expect(tileOf(isolated.id).classList.contains('map-tile--dimmed')).toBe(true));
    expect(pill().classList.contains('map-report-pill--dimmed')).toBe(true);
    expect(reportEdge().classList.contains('map-edge--dimmed')).toBe(true);
    expect(reportEdge().classList.contains('map-edge--lit')).toBe(false);

    // Positive control — select the CITING task: pill back, edge lit.
    fireEvent.click(tileOf(isolated.id));
    await waitFor(() => expect(pill().classList.contains('map-report-pill--dimmed')).toBe(false));
    expect(reportEdge().classList.contains('map-edge--lit')).toBe(true);
    expect(reportEdge().classList.contains('map-edge--dimmed')).toBe(false);
  });
});

/**
 * B1 from round 13 (report f81782e1): A2 gives each aggregate the taskCount,
 * the same FOUR §1 answers — done, now, stuck, next — PLUS progress. The
 * model always computed facts.completed; the rendered aggregate collapsed the
 * done answer into the progress ring and never consumed it. Two phases at the
 * same percentage but different done counts were indistinguishable.
 */
describe('MapView — aggregates answer DONE independently of progress (round 13 B1)', () => {
  test('equal progress, different completed counts: the done answer differs while the percentage does not', async () => {
    // Two phases engineered to the SAME 50% progress with DIFFERENT done
    // counts — the only way to prove the answer is not derived from the ring.
    const nodes: any[] = []; const phases: any[] = [];
    const seed = (phase: string, total: number, completed: number) => {
      for (let i = 0; i < total; i += 1) {
        nodes.push({
          id: `${phase}-t${i}`, title: `Task ${phase}-${i}`,
          status: i < completed ? 'completed' : 'todo', priority: 'medium',
          project: 'Indep', phaseId: `phase-${phase}`, updated: '2026-08-20T00:00:00.000Z',
        });
      }
      phases.push({ id: `phase-${phase}`, name: phase.toUpperCase(), goal: null, projectId: 'proj-indep', position: phases.length });
    };
    seed('two-of-four', 4, 2);
    seed('three-of-six', 6, 3);
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: '"g-r13-done"' }),
      json: async () => ({ ...graphTaskFixture, nodes, edges: [], phases }),
    }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 0.28, offsetX: 0, offsetY: 0, organization: 'vertical', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBe(2));

    const byName = (name: RegExp) =>
      screen.getByRole('button', { name }).closest('.map-container:not(.map-container--shape)') as HTMLElement;
    const a = byName(/select phase TWO-OF-FOUR/i);
    const b = byName(/select phase THREE-OF-SIX/i);

    // The visible done answer differs...
    expect(a.textContent).toContain('2 done');
    expect(b.textContent).toContain('3 done');
    expect(a.textContent).not.toContain('3 done');
    // ...and it is announced, not only painted.
    expect(a.querySelector('.sr-only')!.textContent).toContain('2 done');
    expect(b.querySelector('.sr-only')!.textContent).toContain('3 done');
    // ...while the progress signal is identical for both, so the done answer
    // cannot be a restatement of the ring.
    expect(a.querySelector('.sr-only')!.textContent).toContain('50% complete');
    expect(b.querySelector('.sr-only')!.textContent).toContain('50% complete');
  });
});

/**
 * B1 from round 14 (report 1e9d61e5): relationships whose two Tasks share an
 * aggregate folded into a single untyped integer whose ONLY consumer was the
 * sr-only sentence — invisible to sighted readers, and one internal
 * dependency was indistinguishable from one internal Report link. A2 forbids
 * dropping a relationship silently; §4 keeps the two kinds distinct at every
 * zoom.
 */
describe('MapView — internal relationships stay visible and keep their kind (round 14 B1)', () => {
  const internalGraph = () => ({
    ...graphTaskFixture,
    nodes: ['a', 'b'].map(id => ({
      id, title: `Task ${id}`, status: 'todo', priority: 'medium',
      project: 'Inner', phaseId: 'phase-inner', updated: '2026-08-20T00:00:00.000Z',
    })),
    edges: [
      { from: 'a', to: 'b', kind: 'dependency' },
      { from: 'a', to: 'b', kind: 'knowledge' },
    ],
    phases: [{ id: 'phase-inner', name: 'Inner Phase', goal: null, projectId: 'proj-inner', position: 0 }],
  });

  for (const altitude of ['phase', 'project'] as const) {
    test(`both kinds render visibly on the ${altitude} aggregate, distinguishably`, async () => {
      fetchMock.mockImplementation(async () => ({
        ok: true, status: 200, headers: new Headers({ ETag: `"g-r14-${altitude}"` }),
        json: async () => internalGraph(),
      }) as unknown as Response);
      sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
        scale: altitude === 'phase' ? 0.28 : 0.08, offsetX: 0, offsetY: 0, organization: 'horizontal', altitude: 'task',
      }));
      render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
      await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBe(1));

      const aggregate = document.querySelector('.map-container:not(.map-container--shape)')!;
      const dep = aggregate.querySelector('[title="1 dependency inside"]');
      const know = aggregate.querySelector('[title="1 Report link inside"]');
      // VISIBLE, per kind — a sighted reader sees two different marks, not an
      // untyped whisper in the accessibility tree.
      expect(dep, 'internal dependency mark must render').not.toBeNull();
      expect(know, 'internal Report-link mark must render').not.toBeNull();
      expect(dep!.closest('.sr-only'), 'the dependency mark must not hide in sr-only').toBeNull();
      expect(know!.closest('.sr-only'), 'the Report-link mark must not hide in sr-only').toBeNull();
      // Distinguishable: two separate elements with different accessible
      // wording (and different icons in the DOM).
      expect(dep).not.toBe(know);
      expect(dep!.innerHTML).not.toBe(know!.innerHTML);
      // And announced per kind, replacing the old untyped sentence.
      const sr = aggregate.querySelector('.sr-only')!.textContent!;
      expect(sr).toContain('1 dependency inside');
      expect(sr).toContain('1 Report link inside');
    });
  }
});

/**
 * Round 15 B1 (report 47c67214): with all six facts present at multi-digit
 * counts the nowrap counters row painted outside the fixed 220px measured
 * box. jsdom cannot lay out, so containment itself is pinned two other ways:
 * the stylesheet wrap contract (MapView.cascade.test.ts) and the executor's
 * live real-layout probe. What THIS test owns is the hostile content: every
 * one of the six chips must actually render together, multi-digit, at both
 * altitudes — the fixture no earlier test produced.
 */
describe('MapView — all six aggregate facts render together (round 15 B1)', () => {
  const allSixGraph = () => {
    const nodes: any[] = [];
    const push = (i: number, status: string, agent: string | null = null) =>
      nodes.push({
        id: `t${i}`, title: `Task ${i}`, status, priority: 'medium', agent,
        project: 'Dense', phaseId: 'phase-dense', updated: '2026-08-20T00:00:00.000Z',
      });
    let i = 0;
    for (let k = 0; k < 12; k += 1) push(i++, 'completed');
    for (let k = 0; k < 11; k += 1) push(i++, 'in-progress', `agent-${k}`);
    for (let k = 0; k < 10; k += 1) push(i++, 'stuck');
    for (let k = 0; k < 25; k += 1) push(i++, 'todo');
    const edges: any[] = [];
    for (let k = 0; k < 14; k += 1) edges.push({ from: `t${k}`, to: `t${k + 20}`, kind: 'dependency' });
    for (let k = 0; k < 12; k += 1) edges.push({ from: `t${k}`, to: `t${k + 40}`, kind: 'knowledge' });
    return {
      ...graphTaskFixture, nodes, edges,
      phases: [{ id: 'phase-dense', name: 'Dense', goal: null, projectId: 'proj-dense', position: 0 }],
    };
  };

  for (const altitude of ['phase', 'project'] as const) {
    test(`all six chips render, multi-digit, on the ${altitude} aggregate`, async () => {
      fetchMock.mockImplementation(async () => ({
        ok: true, status: 200, headers: new Headers({ ETag: `"g-r15-${altitude}"` }),
        json: async () => allSixGraph(),
      }) as unknown as Response);
      sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
        scale: altitude === 'phase' ? 0.28 : 0.08, offsetX: 0, offsetY: 0, organization: 'horizontal', altitude: 'task',
      }));
      render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
      await waitFor(() => expect(document.querySelectorAll('.map-container:not(.map-container--shape)').length).toBe(1));

      const counters = document.querySelector('.map-container .map-aggregate-counters')!;
      expect(counters.textContent).toContain('12 done');
      expect(counters.querySelector('[title="11 working now"]')).not.toBeNull();
      expect(counters.querySelector('[title="10 stuck"]')).not.toBeNull();
      expect(counters.textContent).toContain('25 next');
      expect(counters.querySelector('[title="14 dependencies inside"]')).not.toBeNull();
      expect(counters.querySelector('[title="12 Report links inside"]')).not.toBeNull();
    });
  }
});


describe('MapView — the organization switcher (A7b slice 2, §2)', () => {
  test('the switcher lists all four §2 organizations; organic waits honestly', async () => {
    await renderMapAtScale(1);
    const group = screen.getByRole('radiogroup', { name: 'Map organization' });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(3);
    expect(screen.queryByRole('radio', { name: 'Radial' })).not.toBeInTheDocument();
    // Every organization ships now — nothing is disabled any more.
    const organic = screen.getByRole('radio', { name: 'Organic' });
    expect(organic).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Horizontal' })).toBeChecked();
  });

  test('switching to vertical commits atomically, persists, and morphs for 0.5s', async () => {
    await renderMapAtScale(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Vertical' }));
    // The commit is atomic: organization + fitted scale/offset in one view.
    await waitFor(() => {
      const view = JSON.parse(sessionStorage.getItem(VIEW_STORAGE_KEY)!);
      expect(view.organization).toBe('vertical');
    });
    // The morph class rides the plane for the 500ms tween, then leaves so the
    // ordinary 200ms status-glide owns left/top again.
    expect(document.querySelector('.map-plane--morphing')).not.toBeNull();
    await waitFor(
      () => expect(document.querySelector('.map-plane--morphing')).toBeNull(),
      { timeout: 2000 },
    );
    // The vertical arrangement is really rendered — tiles survive the switch.
    expect(document.querySelectorAll('.map-tile').length).toBeGreaterThan(0);
  });

  test('the merged Organic organization draws its §3 bounds hulls in the underlay', async () => {
    await renderMapAtScale(1);
    expect(document.querySelectorAll('.map-hull').length).toBe(0);
    fireEvent.click(screen.getByRole('radio', { name: 'Organic' }));
    await waitFor(() => {
      expect(document.querySelectorAll('.map-hull').length).toBeGreaterThan(0);
    });
    const view = JSON.parse(sessionStorage.getItem(VIEW_STORAGE_KEY)!);
    expect(view.organization).toBe('organic');
    // One hull per band, and the pipeline band rectangles are gone.
    expect(document.querySelectorAll('.map-band').length).toBe(0);
  });

  test('a persisted radial view migrates to Organic', async () => {
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 1, offsetX: 0, offsetY: 0, organization: 'radial',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-hull').length).toBeGreaterThan(0));
    expect(screen.getByRole('radio', { name: 'Organic' })).toBeChecked();
    expect(screen.queryByRole('radio', { name: 'Radial' })).not.toBeInTheDocument();
  });
});


describe('MapView — band containers FOLLOW the morph (review a649f5f7 B2)', () => {
  test('switching into Organic mounts travelling containers that actually travel', async () => {
    await renderMapAtScale(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Organic' }));
    // The overlay is present while the morph runs…
    await waitFor(() => {
      expect(document.querySelectorAll('.map-hull--morph').length).toBeGreaterThan(0);
    });
    const first = document.querySelector('.map-hull--morph')!.getAttribute('d');
    // …and its geometry CHANGES between frames — hidden-then-revealed
    // containers (the rejected behavior) have no frames to change in.
    await waitFor(() => {
      const current = document.querySelector('.map-hull--morph')?.getAttribute('d');
      expect(current === null || current !== first).toBe(true);
    }, { timeout: 1500 });
    // At arrival the overlay unmounts and the static hulls stand.
    await waitFor(() => {
      expect(document.querySelectorAll('.map-hull--morph').length).toBe(0);
      expect(document.querySelectorAll('.map-hull').length).toBeGreaterThan(0);
    }, { timeout: 2500 });
  });

  test('the switch keeps the reader: same altitude, same scale, membership landing', async () => {
    await renderMapAtScale(1);
    const before = JSON.parse(sessionStorage.getItem(VIEW_STORAGE_KEY)!);
    fireEvent.click(screen.getByRole('radio', { name: 'Organic' }));
    await waitFor(() => {
      const view = JSON.parse(sessionStorage.getItem(VIEW_STORAGE_KEY)!);
      expect(view.organization).toBe('organic');
      // Live QA caught the first cut fitting the new plane: the fitted
      // overview was not task-readable and settle turned the switch into a
      // zoom-out. The reader's scale is now preserved outright.
      expect(view.scale).toBe(before.scale ?? 1);
    });
  });
});


describe('MapView — the organic organization ships (A7b slice 3)', () => {
  test('switching to organic renders its hulls and persists', async () => {
    await renderMapAtScale(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Organic' }));
    await waitFor(() => {
      expect(document.querySelectorAll('.map-hull').length).toBeGreaterThan(0);
    }, { timeout: 3000 });
    const view = JSON.parse(sessionStorage.getItem(VIEW_STORAGE_KEY)!);
    expect(view.organization).toBe('organic');
    expect(document.querySelectorAll('.map-tile').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.map-band').length).toBe(0);
  });

  test('a persisted organic view restores directly', async () => {
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 1, offsetX: 0, offsetY: 0, organization: 'organic',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-hull').length).toBeGreaterThan(0));
    expect(screen.getByRole('radio', { name: 'Organic' })).toBeChecked();
  });
});


/* ======================================================================
 * THE CONTINUOUS PLANE, AS RENDERED — amendment §2/§5-A3, card 03acc0b2.
 *
 * The engine's properties live in mapPlaneModel.test.ts. These assert what
 * only the DOM can answer: that the cross-fade hands a region from one layer
 * to the next WITHOUT moving it, that exactly one layer is ever reachable,
 * that §3's agent badge survives being far away, and that a container's card
 * never spills over ground it does not own.
 * ====================================================================== */
describe('MapView — the continuous plane (amendment §2/§5-A3)', () => {
  /**
   * The recorded fixture is 14 tasks in three small projects — an estate
   * nobody ever zooms out of, and too small for a container to be able to
   * carry a card at all. The container tiers exist for estate scale (A2 was
   * ratified after the Map was measured at 5,214 tasks), so these tests run
   * on the recorded ROW SHAPE at a size where the tiers are real: the
   * fixture's own rows, plus a project with a five-deep chain and a project
   * with six phases. Nothing here invents a wire shape.
   */
  const bigGraph = planeBigGraph;

  /**
   * jsdom measures every box as 0x0, which `measure` ignores, so the plane
   * runs on the documented fallbacks: a tile is 170 plane px wide. The
   * cross-fade is keyed to ON-SCREEN size, so these scales are derived from
   * that and from the ratified endpoints rather than guessed.
   */
  const READING = 1;            // 170px of tile on screen: the tiles carry it
  const PHASE_OWNS = 0.28;      // ~48px of tile: the phase container takes over
  const PROJECT_OWNS = 0.2;     // the narrow project's phases hand over in turn

  beforeEach(() => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: '"g-plane"' }),
      json: async () => bigGraph,
    }) as unknown as Response);
  });

  const renderPlaneAt = async (scale: number) => {
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale, offsetX: 0, offsetY: 0, organization: 'horizontal', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
    await waitFor(() => expect(
      document.querySelectorAll('.map-tile, .map-container').length).toBeGreaterThan(0));
  };

  test('at reading zoom the tiles carry the ink and no container shows', async () => {
    await renderPlaneAt(READING);
    expect(document.querySelectorAll('.map-tile').length).toBe(bigGraph.nodes.length);
    expect(document.querySelectorAll('.map-tile--shape').length).toBe(0);
    expect(document.querySelectorAll('.map-container').length).toBe(0);
    // The tiles are the reachable layer, and the only one.
    expect(document.querySelectorAll('.task-card-map-open').length).toBeGreaterThan(0);
  });

  test('clause 1: the region changes hands WITHOUT changing place', async () => {
    await renderPlaneAt(READING);
    const before = new Map([...document.querySelectorAll('.map-tile[data-task]')]
      .map(element => [
        element.getAttribute('data-task')!,
        {
          left: (element as HTMLElement).style.left,
          top: (element as HTMLElement).style.top,
        },
      ]));
    expect(before.size).toBeGreaterThan(0);
    cleanup();

    await renderPlaneAt(PHASE_OWNS);
    const shapes = [...document.querySelectorAll('.map-tile--shape[data-task]')];
    expect(shapes.length).toBeGreaterThan(0);
    // THE ASSERTION CLAUSE 1 IS: the same task, in the same place, drawn by
    // a different layer. Not re-laid out, not re-landed, not re-fitted.
    let compared = 0;
    for (const shape of shapes) {
      const was = before.get(shape.getAttribute('data-task')!);
      if (!was) continue;
      expect((shape as HTMLElement).style.left).toBe(was.left);
      expect((shape as HTMLElement).style.top).toBe(was.top);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
    expect(document.querySelectorAll('.map-container--phase').length).toBeGreaterThan(0);
  });

  test('exactly ONE layer is reachable at a time', async () => {
    await renderPlaneAt(PHASE_OWNS);
    // Tiles have become shapes: aria-hidden, and holding no control at all.
    const tiles = [...document.querySelectorAll('.map-tile')];
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.classList.contains('map-tile--shape')).toBe(true);
      expect(tile.getAttribute('aria-hidden')).toBe('true');
      expect(tile.querySelectorAll('button, a, input, [tabindex]').length).toBe(0);
    }
    // The container that took over IS reachable, and says which one it is.
    const cards = [...document.querySelectorAll('.map-container:not(.map-container--shape)')];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.getAttribute('aria-hidden')).toBeNull();
      expect(card.querySelectorAll('button').length).toBe(1);
    }
    expect(screen.getAllByRole('button', { name: /^Select phase / }).length)
      .toBeGreaterThan(0);
    // A container that could not carry its card carries no control either.
    for (const shape of document.querySelectorAll('.map-container--shape')) {
      expect(shape.getAttribute('aria-hidden')).toBe('true');
      expect(shape.querySelectorAll('button').length).toBe(0);
    }
  });

  test('the project container takes over from the phases the same way', async () => {
    await renderPlaneAt(PROJECT_OWNS);
    expect(document.querySelectorAll('.map-container--project').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^Select project / }).length)
      .toBeGreaterThan(0);
  });

  test('clause 2: a container carrying more work is visibly bigger', async () => {
    await renderPlaneAt(PHASE_OWNS);
    const areas = [...document.querySelectorAll('.map-container--phase')]
      .map(element => {
        const style = (element as HTMLElement).style;
        return parseFloat(style.width) * parseFloat(style.height);
      });
    expect(areas.length).toBeGreaterThan(1);
    // The fifteen-task phase and the four-task phases cannot be the same size.
    expect(Math.max(...areas) / Math.min(...areas)).toBeGreaterThan(1.5);
  });

  test('a card never spills over ground its region does not own', async () => {
    for (const scale of [PHASE_OWNS, PROJECT_OWNS, 0.24, 0.16]) {
      await renderPlaneAt(scale);
      for (const card of document.querySelectorAll('.map-container-card')) {
        const region = card.parentElement as HTMLElement;
        // The card is drawn at its designed CSS size (the plane's inverse
        // scale rides it back out), so "it fits" is a statement about the
        // region measured in CSS pixels on screen.
        expect(parseFloat((card as HTMLElement).style.width)).toBeLessThanOrEqual(parseFloat(region.style.width) * scale);
        expect(parseFloat((card as HTMLElement).style.width)).toBeGreaterThan(0);
        expect(parseFloat((card as HTMLElement).style.maxHeight)).toBeLessThanOrEqual(parseFloat(region.style.height) * scale);
      }
      cleanup();
    }
  });

  test('the ink is never missing: some layer always carries every region', async () => {
    for (const scale of [READING, 0.5, 0.34, 0.3, PHASE_OWNS, 0.24, PROJECT_OWNS, 0.12]) {
      await renderPlaneAt(scale);
      // A2: "a zoom level that shows nothing useful is a defect."
      expect(document.querySelectorAll('.map-tile, .map-container').length)
        .toBeGreaterThan(0);
      cleanup();
    }
  });

  test('§3: the live agent badge survives the tile becoming a shape', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: '"g-agent"' }),
      json: async () => ({
        ...bigGraph,
        nodes: bigGraph.nodes.map((node: any, index: number) =>
          (index === 0 ? { ...node, agent: 'claude-fable-5' } : node)),
      }),
    }) as unknown as Response);
    await renderPlaneAt(PHASE_OWNS);
    // "…survives EVERY zoom level (name label near, pulsing dot far)."
    expect(document.querySelectorAll('.map-tile-shape-agent').length).toBe(1);
  });

  test('the container card answers §1 the way the lane header does', async () => {
    await renderPlaneAt(PROJECT_OWNS);
    const card = document.querySelector('.map-container--project .map-aggregate-count');
    expect(card).toBeInTheDocument();
    expect(Number(card!.textContent)).toBeGreaterThan(0);
    expect(document.querySelector('.map-container--project .sr-only')!.textContent)
      .toMatch(/tasks, .* done, .*% complete, .* working now, .* stuck, .* up next/s);
  });

  test('the OTHER organizations are untouched and still reachable', async () => {
    // A3 governs this slice; the A2 hierarchy still serves the rest (card
    // 03acc0b2 subtasks 3 and 4). Switching away must land on it.
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 1, offsetX: 0, offsetY: 0, organization: 'vertical', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-tile').length).toBeGreaterThan(0));
    expect(document.querySelectorAll('.map-container').length).toBe(0);
    expect(document.querySelectorAll('.map-tile--shape').length).toBe(0);
    for (const option of ['Horizontal', 'Vertical', 'Organic']) {
      expect(screen.getByRole('radio', { name: option })).toBeInTheDocument();
    }
  });

  test.each([1, 0.65, 0.3, 0.13])('RH-UI.17i every painted caption carries the same four fields at %s', async scale => {
    await renderPlaneAt(scale);
    const captions = [...document.querySelectorAll('.map-band-chip, .map-lane-header, .map-container-card')];
    expect(captions.length).toBeGreaterThan(2);
    for (const caption of captions) {
      expect(caption.querySelector('.map-aggregate-name')).not.toBeNull();
      for (const field of ['done', 'active', 'next', 'blocked']) {
        expect(caption.querySelectorAll(`[data-count="${field}"]`)).toHaveLength(1);
      }
    }
  });

  test('clause 6: the anchors are written where a later session can find them', async () => {
    localStorage.removeItem('relayhall_map_plane_anchors');
    await renderPlaneAt(READING);
    // The write is debounced (see MapView): the record is large enough that
    // stringifying it on every measurement pass would be felt.
    await waitFor(() => expect(
      localStorage.getItem('relayhall_map_plane_anchors')).not.toBeNull(),
    { timeout: 4000 });
    const stored = JSON.parse(localStorage.getItem('relayhall_map_plane_anchors')!);
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.slots).length).toBe(bigGraph.nodes.length);
    expect(stored.laneOrder.length).toBeGreaterThan(0);
  });
});


/* ======================================================================
 * ROUND-1 REVIEW REPAIRS, at the surface (verdict report 5e7a356f).
 * ====================================================================== */
describe('MapView — round-1 repairs', () => {
  const facts = (over: Partial<Parameters<typeof planeStateClass>[0]>) => ({
    taskCount: 4, completed: 0, archived: 0, agentsLive: 0, stuck: 0, upNext: 4,
    inFlight: 0, progress: 0, ...over,
  });

  test('finding 3: a container tints for ALL THREE ratified states', () => {
    // "State stays legible at every altitude by tint: essentially-complete
    // reads green, blocked reads red, archived reads faded." The reviewed
    // candidate implemented only the blocked arm.
    expect(planeStateClass(facts({ stuck: 1 }))).toBe(' map-container--stuck');
    expect(planeStateClass(facts({ completed: 4, upNext: 0 })))
      .toBe(' map-container--complete');
    expect(planeStateClass(facts({ taskCount: 4, archived: 4, upNext: 0 })))
      .toBe(' map-container--archived');
    expect(planeStateClass(facts({}))).toBe('');
    // A dammed flow outranks the others, exactly as it does on a tile.
    expect(planeStateClass(facts({ stuck: 1, completed: 4 })))
      .toBe(' map-container--stuck');
    // Completion is measured against the ACTIVE total, so archived work
    // cannot hold a finished project back from reading finished.
    expect(planeStateClass(facts({ taskCount: 5, archived: 1, completed: 4 })))
      .toBe(' map-container--complete');
    // An empty aggregate is not "complete".
    expect(planeStateClass(facts({ taskCount: 0, upNext: 0 }))).toBe('');
  });

  test('finding 3: the tint reaches the SHAPE, which is where it matters most', () => {
    // A region too small for its card shows tint alone — so if the tint only
    // reached the card, the smallest regions would say nothing at all.
    const shape = planeStateClass(facts({ stuck: 2 }));
    expect(shape).toBe(' map-container--stuck');
  });

  test('finding 2 + §4: selecting a container lights its own chain', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: '"g-chain"' }),
      json: async () => planeBigGraph,
    }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 0.28, offsetX: 0, offsetY: 0, organization: 'horizontal', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
    await waitFor(() => expect(
      document.querySelectorAll('.map-container').length).toBeGreaterThan(0));

    const control = screen.getAllByRole('button', { name: /^Select phase / })[0];
    fireEvent.click(control);
    await waitFor(() => expect(
      document.querySelectorAll('.map-container--lit').length).toBeGreaterThan(0));
    // The reviewed candidate selected a DOM-shaped id that matched no rolled
    // edge endpoint, so no chain could ever be built: every container stayed
    // un-lit and un-dimmed.
    expect(document.querySelectorAll('.map-container--dimmed').length)
      .toBeGreaterThan(0);
  });

  test('§4\'s dim COMPOSES with the cross-fade instead of being overwritten', async () => {
    // Both are opacity. The cross-fade writes it inline, which beats any
    // stylesheet rule outright — so the chain dim has to be a number too, or
    // §4 simply stops happening on this plane.
    expect(CHAIN_DIM.node).toBe(0.13);
    expect(CHAIN_DIM.edge).toBe(0.05);
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: '"g-dim"' }),
      json: async () => planeBigGraph,
    }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale: 1, offsetX: 0, offsetY: 0, organization: 'horizontal', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} />, { wrapper });
    await waitFor(() => expect(
      document.querySelectorAll('.map-tile').length).toBeGreaterThan(2));

    const tiles = [...document.querySelectorAll('.map-tile')] as HTMLElement[];
    fireEvent.click(tiles[0]);
    await waitFor(() => expect(
      document.querySelectorAll('.map-tile--dimmed').length).toBeGreaterThan(0));
    const dimmed = document.querySelector('.map-tile--dimmed') as HTMLElement;
    // At reading zoom the fade contributes 1, so the painted opacity IS the
    // chain's own constant. The class is still there for everything else it
    // carries; the number is what a reader actually sees.
    expect(Number(dimmed.style.opacity)).toBeCloseTo(CHAIN_DIM.node, 6);
  });

  test.each([0.28, 0.2])('§4 multiplies every container fade at scale %s', async scale => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: '"g-dim-alt"' }),
      json: async () => planeBigGraph,
    }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale, offsetX: 0, offsetY: 0, organization: 'horizontal', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} />, { wrapper });
    await waitFor(() => expect(
      document.querySelectorAll('.map-container').length).toBeGreaterThan(1));

    // Geometry identifies a rendered region independently of selection's
    // class changes. Read the actual fade before the act, then compare the
    // same region afterward: <= dim would falsely accept a constant override.
    const key = (element: HTMLElement) => [
      element.classList.contains('map-container--phase') ? 'phase' : 'project',
      element.style.left, element.style.top, element.style.width, element.style.height,
    ].join('|');
    const before = new Map([...document.querySelectorAll<HTMLElement>('.map-container')]
      .map(element => [key(element), Number(element.style.opacity)]));
    expect(before.size).toBe(document.querySelectorAll('.map-container').length);
    const controls = screen.getAllByRole('button', { name: /^Select (phase|project) / });
    fireEvent.click(controls[0]);
    await waitFor(() => expect(
      document.querySelectorAll('.map-container--dimmed').length).toBeGreaterThan(0));
    const dimmed = [...document.querySelectorAll<HTMLElement>('.map-container--dimmed')];
    const lit = [...document.querySelectorAll<HTMLElement>('.map-container--lit')];
    expect(lit.length).toBeGreaterThan(0);
    expect(dimmed.some(element => {
      const alpha = before.get(key(element))!;
      return alpha > 0 && alpha < 1;
    })).toBe(true);
    for (const element of dimmed) {
      expect(before.has(key(element))).toBe(true);
      expect(Number(element.style.opacity)).toBeCloseTo(before.get(key(element))! * CHAIN_DIM.node, 6);
    }
    for (const element of lit) {
      expect(before.has(key(element))).toBe(true);
      expect(Number(element.style.opacity)).toBeCloseTo(before.get(key(element))!, 6);
    }
  });
});

describe('continuous-plane attention across mixed layers', () => {
  test('selecting a phase dims unrelated task shapes by their actual fade', async () => {
    fetchMock.mockImplementation(async () => ({ ok:true,status:200,headers:new Headers({ETag:'"mixed-attention"'}),json:async()=>planeBigGraph }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({scale:0.28,offsetX:0,offsetY:0,organization:'horizontal',altitude:'task'}));
    render(<MapView query={{}} onOpenTask={()=>{}} onOpenReport={()=>{}} />, {wrapper});
    const select = await screen.findByRole('button',{name:'Select phase Wide of project Wide Project'});
    const before=new Map([...document.querySelectorAll<HTMLElement>('.map-tile--shape')].map(el=>[el.dataset.task!,Number(el.style.opacity)]));
    expect(before.size).toBeGreaterThan(0);
    fireEvent.click(select);
    await waitFor(()=>expect(document.querySelectorAll('.map-tile--shape.map-tile--dimmed').length).toBeGreaterThan(0));
    const lit=[...document.querySelectorAll<HTMLElement>('.map-tile--shape.map-tile--lit')];
    const dimmed=[...document.querySelectorAll<HTMLElement>('.map-tile--shape.map-tile--dimmed')];
    expect(lit.length).toBeGreaterThan(0);
    expect(dimmed.some(el=>before.get(el.dataset.task!)!>0 && before.get(el.dataset.task!)!<1)).toBe(true);
    for(const el of lit){expect(el.dataset.task!.startsWith('wide-')).toBe(true);expect(Number(el.style.opacity)).toBeCloseTo(before.get(el.dataset.task!)!,6);}
    for(const el of dimmed){expect(el.dataset.task!.startsWith('wide-')).toBe(false);expect(Number(el.style.opacity)).toBeCloseTo(before.get(el.dataset.task!)!*CHAIN_DIM.node,6);}
  });
});

describe('painted phase and Project furniture shares chain attention', () => {
  const families = ['band', 'chip', 'header'] as const;
  const samples = families.flatMap(family => [1, 0.28, 0.2].map(scale => ({ family, scale })));

  test.each(samples)('$family composes membership and its actual fade at $scale', async ({ family, scale }) => {
    // A sibling Phase within the selected Project must still dim when a Task
    // or Phase is selected. Project membership alone is not the Phase oracle.
    const fixture = {
      ...planeBigGraph,
      phases: [...planeBigGraph.phases,
        { id: 'wide-sibling', name: 'Unrelated sibling', projectId: 'wp', position: 1, goal: null }],
      nodes: [...planeBigGraph.nodes, ...Array.from({ length: 4 }, (_, index) => ({
        ...planeBigGraph.nodes[0], id: `sibling-${index}`, title: `Sibling ${index}`,
        project: 'Wide Project', phaseId: 'wide-sibling', status: 'todo',
      }))],
    };
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers({ ETag: '"furniture-attention"' }),
      json: async () => fixture,
    }) as unknown as Response);
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      scale, offsetX: 0, offsetY: 0, organization: 'horizontal', altitude: 'task',
    }));
    render(<MapView query={{}} onOpenTask={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelectorAll('.map-band-chip').length).toBeGreaterThan(2));

    const chips = [...document.querySelectorAll<HTMLElement>('.map-band-chip')];
    const bands = [...document.querySelectorAll<SVGRectElement>('.map-phase-ground')];
    // Each placed band has one placed chip in the same layout order. Its
    // visible label identifies the Phase independently of attention classes.
    expect(bands.length).toBe(chips.length);
    const elements = family === 'band' ? bands : family === 'chip' ? chips
      : [...document.querySelectorAll<HTMLElement>('.map-lane-header')];
    const before = elements.map((element, index) => ({
      element,
      label: family === 'header' ? element.querySelector('.map-lane-name')!.textContent
        : chips[index].querySelector('.map-band-name')!.textContent,
      alpha: Number(element.style.opacity),
      geometry: (element instanceof SVGElement ? ['x','y','width','height'].map(a=>element.getAttribute(a)) : [element.style.left, element.style.top, element.style.width, element.style.height]).join('|'),
    }));
    const litLabels = new Set(family === 'header' ? [scale === 0.2 ? 'Deep Project' : 'Wide Project']
      : scale === 0.2 ? Array.from({ length: 6 }, (_, index) => `Stage ${index}`) : ['Wide']);
    expect(before.some(row => litLabels.has(row.label!))).toBe(true);
    const ownerBefore = family === 'chip' && scale !== 1
      ? [...document.querySelectorAll<HTMLElement>('.map-container-card')].map(caption => ({
        element: caption.parentElement!, label: caption.querySelector('.map-aggregate-name')!.textContent,
        alpha: Number(caption.parentElement!.style.opacity),
        geometry: [caption.parentElement!.style.left, caption.parentElement!.style.top,
          caption.parentElement!.style.width, caption.parentElement!.style.height].join('|'),
      })) : [];
    if (family === 'chip' && scale !== 1) {
      // The aggregate now owns the caption. Keep proving hidden-chip
      // attention, and transfer the positive painted-ink proof to its owner.
      expect(before.every(row => row.alpha === 0)).toBe(true);
      expect(ownerBefore.some(row => row.alpha > 0)).toBe(true);
    } else {
      expect(before.some(row => !litLabels.has(row.label!) && row.alpha > 0)).toBe(true);
    }
    if (family !== 'header') expect(before.some(row => row.label === 'Unrelated sibling')).toBe(true);

    if (scale === 1) {
      fireEvent.click(document.querySelector<HTMLElement>('[data-task="wide-0-0"]')!);
    } else if (scale === 0.28) {
      fireEvent.click(await screen.findByRole('button', { name: 'Select phase Wide of project Wide Project' }));
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Select project Deep Project' }));
    }
    await waitFor(() => expect(document.querySelectorAll('.map-tile--dimmed, .map-container--dimmed').length).toBeGreaterThan(0));
    for (const row of before) {
      expect(row.element.isConnected).toBe(true);
      const factor = litLabels.has(row.label!) ? 1 : CHAIN_DIM.node;
      expect(Number(row.element.style.opacity), `attention composition: ${family} ${row.label}`)
        .toBeCloseTo(row.alpha * factor, 6);
      expect((row.element instanceof SVGElement ? ['x','y','width','height'].map(a=>row.element.getAttribute(a)) : [row.element.style.left, row.element.style.top, row.element.style.width, row.element.style.height]).join('|'))
        .toBe(row.geometry);
    }

    for (const row of ownerBefore) {
      const factor = row.label === (scale === 0.2 ? 'Deep Project' : 'Wide') ? 1 : CHAIN_DIM.node;
      expect(Number(row.element.style.opacity)).toBeCloseTo(row.alpha * factor, 6);
      expect((row.element instanceof SVGElement ? ['x','y','width','height'].map(a=>row.element.getAttribute(a)) : [row.element.style.left, row.element.style.top, row.element.style.width, row.element.style.height]).join('|')).toBe(row.geometry);
    }
    fireEvent.click(screen.getByRole('application', { name: 'Task map canvas' }));
    await waitFor(() => expect(document.querySelectorAll('.map-tile--dimmed, .map-container--dimmed').length).toBe(0));
    for (const row of before) expect(Number(row.element.style.opacity)).toBeCloseTo(row.alpha, 6);
    for (const row of ownerBefore) expect(Number(row.element.style.opacity)).toBeCloseTo(row.alpha, 6);
  });
});


describe('RH-UI.17i fitted continuous camera', () => {
  test('all three organization commits retain selection and fit atomically; every input shares the resized floor', async () => {
    let viewport={width:1200,height:1200};
    const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      const {width,height}=this.classList.contains('map-canvas') ? viewport : {width:0,height:0};
      return {x:0,y:0,left:0,top:0,right:width,bottom:height,width,height,toJSON:()=>({})};
    });
    const width=vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockImplementation(function(this: HTMLElement) {
      return this.classList.contains('map-tile') ? 170 : this.classList.contains('map-container-card') ? 220 : 0;
    });
    const height=vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this: HTMLElement) {
      return this.classList.contains('map-tile') ? 96 : this.classList.contains('map-container-card') ? 96 : 0;
    });
    const persisted=vi.spyOn(Storage.prototype,'setItem');
    const expected=()=>{
      const plane=document.querySelector<HTMLElement>('.map-plane')!;
      const w=parseFloat(plane.style.width),h=parseFloat(plane.style.height);
      const scale=Math.min(2.5,Math.max(0.05,Math.min(viewport.width*.8/w,viewport.height*.8/h)));
      return {scale,offsetX:(viewport.width-w*scale)/2,offsetY:(viewport.height-h*scale)/2};
    };
    const saved=()=>JSON.parse(sessionStorage.getItem(VIEW_STORAGE_KEY)!);
    try {
      await renderMapAtScale(1);
      const opener=document.querySelector('.task-card-map-open')!;
      fireEvent.focus(opener);
      for(const organization of ['Vertical','Organic','Horizontal']) {
        persisted.mockClear();
        fireEvent.click(screen.getByRole('radio',{name:organization}));
        await waitFor(()=>expect(saved().organization).toBe(organization.toLowerCase()));
        const fit=expected();
        for(const [key,value] of Object.entries(fit)) expect(saved()[key]).toBeCloseTo(value,6);
        const commits=persisted.mock.calls.filter(([key])=>key===VIEW_STORAGE_KEY).map(([,value])=>JSON.parse(value));
        expect(commits.length).toBeGreaterThan(0);
        for(const commit of commits) {
          expect(commit.organization).toBe(organization.toLowerCase());
          expect(commit.scale).toBeCloseTo(fit.scale,6);
        }
        expect(document.querySelectorAll('.map-tile--lit,.map-container--lit').length).toBeGreaterThan(0);
        expect(document.querySelectorAll('.map-edge').length).toBeGreaterThan(0);
        for (const chip of document.querySelectorAll<HTMLElement>('.map-band-chip')) {
          expect(parseFloat(chip.style.left)).toBeGreaterThanOrEqual(0);
          expect(parseFloat(chip.style.top)).toBeGreaterThanOrEqual(0);
        }
      }
      const canvas=document.querySelector('.map-canvas')!;
      fireEvent.wheel(canvas,{deltaY:100000,clientX:400,clientY:300});
      expect(saved().scale).toBeCloseTo(expected().scale,6);
      fireEvent.click(screen.getByRole('button',{name:'Zoom out'}));
      fireEvent.keyDown(canvas,{key:'-'});
      expect(saved().scale).toBeCloseTo(expected().scale,6);
      viewport={width:900,height:500};
      fireEvent(window,new Event('resize'));
      fireEvent.wheel(canvas,{deltaY:100000,clientX:400,clientY:300});
      await waitFor(()=>expect(saved().scale).toBeCloseTo(expected().scale,6));
      fireEvent.click(screen.getByRole('button',{name:'Fit view'}));
      await waitFor(()=>expect(saved().offsetX).toBeCloseTo(expected().offsetX,6));
    } finally { persisted.mockRestore();rect.mockRestore();width.mockRestore();height.mockRestore(); }
  });
});


test('an organization chosen while a restored Map is loading fits the arriving graph', async () => {
  let release!: (response: Response) => void;
  fetchMock.mockImplementation(() => new Promise<Response>(resolve => { release=resolve; }));
  const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement) {
    const width=this.classList.contains('map-canvas')?1200:0,height=this.classList.contains('map-canvas')?800:0;
    return {x:0,y:0,left:0,top:0,right:width,bottom:height,width,height,toJSON:()=>({})};
  });
  const measuredWidth=vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockImplementation(function(this:HTMLElement) {
    return this.classList.contains('map-tile')?170:220;
  });
  const measuredHeight=vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement) {
    return this.classList.contains('map-tile')?96:96;
  });
  sessionStorage.setItem(VIEW_STORAGE_KEY,JSON.stringify({scale:1,offsetX:30,offsetY:40,organization:'horizontal'}));
  try {
    render(<MapView query={{}} onOpenTask={()=>{}} />, {wrapper});
    await waitFor(()=>expect(screen.getByText('Loading the Map…')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('radio',{name:'Organic'}));
    release({ok:true,status:200,headers:new Headers(),json:async()=>graphTaskFixture} as Response);
    await waitFor(()=>expect(screen.queryByText('Loading the Map…')).not.toBeInTheDocument());
    await waitFor(()=> {
      const plane=document.querySelector<HTMLElement>('.map-plane')!;
      const width=parseFloat(plane.style.width),height=parseFloat(plane.style.height);
      const scale=Math.min(2.5,Math.max(.05,Math.min(960/width,640/height)));
      const view=JSON.parse(sessionStorage.getItem(VIEW_STORAGE_KEY)!);
      expect(view.organization).toBe('organic');
      expect(view.scale).toBeCloseTo(scale,6);
      expect(view.offsetX).toBeCloseTo((1200-width*scale)/2,6);
      expect(view.offsetY).toBeCloseTo((800-height*scale)/2,6);
    });
  } finally {rect.mockRestore();measuredWidth.mockRestore();measuredHeight.mockRestore();}
});


describe('continuous caption ownership through the cross-fade', () => {
  test.each(['horizontal', 'vertical', 'organic'] as const)('%s never paints both caption copies for the same region', async organization => {
    sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ organization, scale: .2353529411764706, offsetX: 0, offsetY: 0 }));
    render(<MapView query={{}} onOpenTask={() => {}} />, { wrapper });
    await waitFor(() => expect(document.querySelector('.map-plane')).toBeTruthy());
    await waitFor(() => expect(document.querySelectorAll('.map-band-chip').length).toBeGreaterThan(0));
    for (const scale of [.2353529411764706, .27, .3]) {
      const canvas = document.querySelector('.map-canvas')!;
      const current = JSON.parse(sessionStorage.getItem(VIEW_STORAGE_KEY)!).scale;
      fireEvent.wheel(canvas, { deltaY: -Math.log(scale / current) / Math.log(1.0015), clientX: 0, clientY: 0 });
      const identities = new Set<string>();
      for (const caption of document.querySelectorAll<HTMLElement>('.map-band-chip,.map-lane-header,.map-container-card')) {
        if (caption.style.opacity === '0') continue;
        const parent = caption.closest<HTMLElement>('.map-container');
        if (parent?.style.opacity === '0') continue;
        const name = caption.querySelector('.map-aggregate-name')?.textContent;
        if (!name) continue;
        const identity = `${caption.querySelector('.map-aggregate-lane')?.textContent ?? 'project'}:${name}`;
        expect(identities.has(identity), `duplicate ${identity} at ${scale}`).toBe(false);
        identities.add(identity);
      }
      expect(identities.size).toBeGreaterThan(0);
    }
  });
});
