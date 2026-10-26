// @vitest-environment jsdom
/**
 * Owner ruling E386 at the surface: the Map's areas fit what is SHOWN.
 *
 *   - showing archived work and hiding it again returns every phase and
 *     project area to the rectangle it had before;
 *   - no layout geometry survives a reload: a stored layout record is never
 *     read, it is removed on load, and nothing is written back;
 *   - a declared phase with no shown task is not drawn;
 *   - "Re-pack layout" (E375) lays the plane out afresh from what is shown.
 *
 * The layout runs synchronously here (jsdom has no Worker), so the rendered
 * ground rectangles are exactly the layout's.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ThemeProvider } from '../../contexts/ThemeContext';
import { MapView } from './MapView';
import { fetchMapGraph, type MapGraphQuery, type MapGraphResponse } from './mapGraphApi';
import * as planeModel from './mapPlaneModel';

vi.mock('./mapGraphApi', () => ({ fetchMapGraph: vi.fn() }));
vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: () => () => {}, connected: false, send: () => {} }),
}));
const fetcher = vi.mocked(fetchMapGraph);
const clients: QueryClient[] = [];

const STORED_KEYS = [
  'relayhall_map_plane_anchors_v2',
  'relayhall_map_plane_anchors_v2:vertical',
  'relayhall_map_plane_anchors_v2:organic',
  'relayhall_map_plane_anchors',
  'relayhall_map_plane_anchors:vertical',
];

const node = (id: string, project: string, phaseId: string | null, status: string, minute: number) => ({
  id, title: `Task ${id}`, status, priority: 'normal', project, phaseId,
  updated: `2026-10-20T07:${String(minute).padStart(2, '0')}:00.000Z`,
});

/** The live board, and the same board with its archive. */
function board(includeArchived: boolean, extraProject?: string, dependsOnArchived = false): MapGraphResponse {
  const nodes = [
    ...[0, 1, 2, 3].map(i => node(`a${i}`, 'Alpha', 'pa1', 'todo', i)),
    ...[0, 1].map(i => node(`b${i}`, 'Alpha', 'pa2', 'in-progress', 10 + i)),
    ...[0, 1, 2].map(i => node(`c${i}`, 'Beta', 'pb1', 'todo', 20 + i)),
    ...(extraProject ? [node('z0', extraProject, null, 'todo', 30)] : []),
    ...(includeArchived ? [
      ...Array.from({ length: 12 }, (_, i) => node(`a-old${i}`, 'Alpha', 'pa1', 'archived', 40 + i)),
      ...Array.from({ length: 9 }, (_, i) => node(`b-old${i}`, 'Alpha', 'pa2', 'archived', 20 + i)),
      ...Array.from({ length: 3 }, (_, i) => node(`d-old${i}`, 'Alpha', 'pa4', 'archived', 33 + i)),
    ] : []),
  ];
  return {
    nodes,
    // Round-1 review B1: live a0 depends on archived a-old0 in its own phase.
    // The wire carries an edge only while both of its tasks are in scope.
    edges: dependsOnArchived && includeArchived ? [{ from: 'a0', to: 'a-old0', kind: 'dependency' }] : [],
    phases: [
      { id: 'pa1', name: 'Build', goal: null, projectId: 'alpha', position: 0 },
      { id: 'pa2', name: 'Ship', goal: null, projectId: 'alpha', position: 1 },
      { id: 'pa3', name: 'Declared, empty', goal: null, projectId: 'alpha', position: 2 },
      { id: 'pa4', name: 'Done and archived', goal: null, projectId: 'alpha', position: 3 },
      { id: 'pb1', name: 'Beta work', goal: null, projectId: 'beta', position: 0 },
    ],
    reports: [],
    fullCount: nodes.length,
    generatedAt: '2026-10-20T08:00:00Z',
  } as unknown as MapGraphResponse;
}

function view(query: MapGraphQuery) {
  return (
    <QueryClientProvider client={clients[clients.length - 1]}>
      <MemoryRouter><ThemeProvider authenticated={false}>
        <MapView query={query} onOpenTask={() => {}} />
      </ThemeProvider></MemoryRouter>
    </QueryClientProvider>
  );
}

function mount(query: MapGraphQuery = {}) {
  clients.push(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return render(view(query));
}

/** Every painted ground rectangle, phase and project, by id. */
const grounds = () => Object.fromEntries([...document.querySelectorAll('rect[data-phase-ground], rect[data-project-ground]')]
  .map(rect => [rect.getAttribute('data-phase-ground') ?? `project:${rect.getAttribute('data-project-ground')}`,
    ['x', 'y', 'width', 'height'].map(name => Number(rect.getAttribute(name)))]));

const tileCount = () => document.querySelectorAll('[data-task]').length;

/** Every painted ground in any organization: phase and project rectangles,
 *  Organic territories and phase outlines, and the archive core. */
const groundGeometry = () => [...document.querySelectorAll(
  '[data-phase-ground], [data-project-ground], [data-testid="map-archive-core"]')]
  .map(element => JSON.stringify([element.tagName,
    element.getAttribute('data-phase-ground') ?? element.getAttribute('data-project-ground') ?? 'archive-core',
    ...['x', 'y', 'width', 'height', 'd', 'cx', 'cy', 'rx', 'ry'].map(name => element.getAttribute(name))]))
  .sort();

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem('relayhall_map_view_v2', JSON.stringify({
    organization: 'horizontal', altitude: 'task', scale: 1, offsetX: 0, offsetY: 0 }));
  fetcher.mockReset();
  fetcher.mockImplementation(async (query: MapGraphQuery) => board(Boolean(query.includeArchived)));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });

test('E386: archived on then off returns every phase and project area to its exact pre-toggle rectangle', async () => {
  const { rerender } = mount({ includeArchived: false });
  await waitFor(() => expect(tileCount()).toBe(9));
  const before = grounds();
  expect(Object.keys(before)).toEqual(expect.arrayContaining(['band:Alpha:pa1', 'band:Alpha:pa2', 'band:Beta:pb1', 'project:Alpha', 'project:Beta']));

  rerender(view({ includeArchived: true }));
  await waitFor(() => expect(tileCount()).toBe(33));
  const shown = grounds();
  // Control: the archive really did grow the areas it landed in.
  expect(shown['band:Alpha:pa1'][3]).toBeGreaterThan(before['band:Alpha:pa1'][3]);
  expect(shown['project:Alpha'][2] * shown['project:Alpha'][3])
    .toBeGreaterThan(before['project:Alpha'][2] * before['project:Alpha'][3]);

  rerender(view({ includeArchived: false }));
  await waitFor(() => expect(tileCount()).toBe(9));
  expect(grounds()).toEqual(before);
});

// Round-1 review, B1 and B2 at the surface: every organization a reader can
// choose, a live task that depends on an archived task in its own phase, and
// two full round trips.
test.each(['horizontal', 'vertical', 'organic'] as const)(
  'E386 round 2: %s archived on, off, on, off returns every ground exactly', async organization => {
    sessionStorage.setItem('relayhall_map_view_v2', JSON.stringify({
      organization, altitude: 'task', scale: 1, offsetX: 0, offsetY: 0 }));
    fetcher.mockImplementation(async (query: MapGraphQuery) => board(Boolean(query.includeArchived), undefined, true));
    const { rerender } = mount({ includeArchived: false });
    await waitFor(() => expect(tileCount()).toBe(9));
    const before = groundGeometry();
    expect(before.length).toBeGreaterThan(0);
    for (let trip = 0; trip < 2; trip += 1) {
      rerender(view({ includeArchived: true }));
      await waitFor(() => expect(tileCount()).toBe(33));
      // Control: the archive really changed the ground it landed in.
      expect(groundGeometry()).not.toEqual(before);
      rerender(view({ includeArchived: false }));
      await waitFor(() => expect(tileCount()).toBe(9));
      expect(groundGeometry()).toEqual(before);
    }
  });

test('E386: a phase with no shown task is not drawn, and an all-archived phase leaves with the archive', async () => {
  const { rerender } = mount({ includeArchived: true });
  await waitFor(() => expect(tileCount()).toBe(33));
  expect(grounds()['band:Alpha:pa4']).toBeDefined();
  expect(grounds()['band:Alpha:pa3']).toBeUndefined();
  expect(screen.queryByText('Declared, empty')).toBeNull();

  rerender(view({ includeArchived: false }));
  await waitFor(() => expect(tileCount()).toBe(9));
  expect(grounds()['band:Alpha:pa4']).toBeUndefined();
  expect(screen.queryByText('Done and archived')).toBeNull();
  expect(screen.queryByText('Declared, empty')).toBeNull();
});

test('E386: a stored layout record is never read, is removed on load, and is never written again', async () => {
  // A record from the old engine, with reservations far larger than the board.
  const stale = JSON.stringify({ ...planeModel.EMPTY_PLANE_ANCHORS, cols: {}, rows: {}, laneHeaderW: {},
    laneOrder: ['Beta', 'Alpha'], laneHeight: { Alpha: 9000, Beta: 9000 },
    segWidth: { 'Alpha\u0000phase:pa1': 7000 }, segOrder: { Alpha: ['phase:pa3', 'phase:pa1', 'phase:pa2'] } });
  for (const key of STORED_KEYS) localStorage.setItem(key, stale);
  localStorage.setItem('relayhall_unrelated_preference', 'kept');
  const reads = vi.spyOn(Storage.prototype, 'getItem');
  const layouts = vi.spyOn(planeModel, 'layoutContinuousPlane');

  mount();
  await waitFor(() => expect(tileCount()).toBe(9));
  for (const key of STORED_KEYS) expect(localStorage.getItem(key)).toBeNull();
  expect(localStorage.getItem('relayhall_unrelated_preference')).toBe('kept');
  const anchorReads = reads.mock.calls.filter(([key]) => String(key).startsWith('relayhall_map_plane_anchors'));
  // The assertions above read the keys themselves; the Map must not have.
  expect(anchorReads.length).toBe(STORED_KEYS.length);

  // The first layout started from nothing, and the ground fits the board.
  expect(layouts.mock.calls[0][3]).toEqual(planeModel.EMPTY_PLANE_ANCHORS);
  const fresh = planeModel.layoutContinuousPlane(board(false) as never, {}, 'horizontal', planeModel.EMPTY_PLANE_ANCHORS);
  const band = fresh.elements.find(element => element.id === 'band:Alpha:pa1')!;
  expect(grounds()['band:Alpha:pa1']).toEqual([band.x, band.y, band.w, band.h]);

  // Nothing is written back, however long the reader stays.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)); });
  for (const key of STORED_KEYS) expect(localStorage.getItem(key)).toBeNull();
});

test('E375/E386: Re-pack layout lays the plane out afresh from what is shown now', async () => {
  mount({});
  await waitFor(() => expect(tileCount()).toBe(9));
  // A project that arrives mid-session keeps the session's order: it stacks
  // at the frontier, below the projects the reader already knows.
  fetcher.mockImplementation(async (query: MapGraphQuery) => board(Boolean(query.includeArchived), 'Aardvark'));
  await act(async () => { await clients[0].invalidateQueries(); });
  await waitFor(() => expect(tileCount()).toBe(10));
  expect(grounds()['project:Aardvark'][1]).toBeGreaterThan(grounds()['project:Beta'][1]);

  const layouts = vi.spyOn(planeModel, 'layoutContinuousPlane');
  // The control says what it costs before it is pressed (round-1 review).
  expect(screen.getByRole('button', { name: 'Re-pack layout' }))
    .toHaveAccessibleDescription(/discards the order this session has given the Map/i);
  fireEvent.click(screen.getByRole('button', { name: 'Re-pack layout' }));
  await waitFor(() => expect(layouts).toHaveBeenCalled());
  expect(layouts.mock.calls.at(-1)![3]).toEqual(planeModel.EMPTY_PLANE_ANCHORS);
  // Afresh: the projects stack in their declared (alphabetical) order again.
  await waitFor(() => expect(grounds()['project:Aardvark'][1]).toBeLessThan(grounds()['project:Alpha'][1]));
  expect(tileCount()).toBe(10);
});
