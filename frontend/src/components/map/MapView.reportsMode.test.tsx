// @vitest-environment jsdom
//
// Card 742fae98 (epic 5854f0d6) — the Map's Reports display mode, as RENDERED.
//
//   1. A toolbar switch next to Horizontal | Vertical: "Reports: Collapsed |
//      Expanded", remembered per user across reloads (the principal's own
//      preferences row, through the same provider the Theme uses).
//   2. Collapsed (the default): ONE "Reports · N" node per task, a hover and
//      focus preview, N drawn at every zoom the task is drawn at, and a
//      warning tint above about ten.
//   3. Expanded: a report area per task in the Report colour family, sized by
//      N, holding every Report node, with the task card pushed aside; the
//      Report nodes stay drawn while the owning task card is off-screen.
//   4. N and the area count only what the graph read lists. The server
//      narrows that list Report by Report (backend mapReportsLive.test.ts,
//      two Accounts on PostgreSQL); the dashboard adds nothing to it.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../../utils/auth';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { preferencesCacheKey } from '../../utils/theme';
import graphTaskFixture from './__fixtures__/graph.task.json';
import { MapView } from './MapView';
import * as planeModel from './mapPlaneModel';
import { REPORT_GROUP_WARN_ABOVE, REPORT_PREVIEW_LIMIT } from './mapReportGroups';

vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(),
  auth: { isAuthenticated: () => true },
}));
vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: () => () => {}, connected: false, send: () => {} }),
}));

const fetchMock = vi.mocked(authenticatedFetch);
const VIEW_STORAGE_KEY = 'relayhall_map_view_v2';
const SCALE = { close: 1.5, mid: 1.0, overview: 0.7, far: 0.45 } as const;

const template = (graphTaskFixture as any).nodes[0];
const HEAVY = 'heavy-task';
const LIGHT = 'light-task';
const QUIET = 'quiet-task';
const HEAVY_COUNT = REPORT_GROUP_WARN_ABOVE + 2;
const LIGHT_COUNT = 3;
const titleOf = (task: string, index: number) => `${task} evidence ${String(index).padStart(2, '0')}`;
const reportsOf = (task: string, count: number) => Array.from({ length: count }, (_, index) => ({
  id: `${task}-report-${String(index).padStart(2, '0')}`, taskId: task, title: titleOf(task, index),
}));

function estate() {
  return {
    success: true, lod: 'task', generatedAt: '2026-10-19T00:00:00.000Z', fullCount: 3,
    nodes: [HEAVY, LIGHT, QUIET].map(id => ({ ...template, id, title: `Task ${id}`, status: 'todo',
      agent: null, project: 'Reports project', phaseId: 'reports-phase' })),
    edges: [],
    phases: [{ id: 'reports-phase', name: 'Reports phase', goal: null, projectId: 'rp', position: 0 }],
    reports: [...reportsOf(HEAVY, HEAVY_COUNT), ...reportsOf(LIGHT, LIGHT_COUNT)],
  };
}

/** The server's side of the two calls the Map and its provider make. */
let served: { graph: any; preferences: any; saved: any[] } = { graph: estate(), preferences: null, saved: [] };
function serve() {
  fetchMock.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/preferences')) {
      if (init?.method === 'PUT') {
        const patch = JSON.parse(String(init.body));
        served.saved.push(patch);
        served.preferences = { ...served.preferences, ...patch };
      }
      return { ok: true, status: 200, headers: new Headers(),
        json: async () => ({ success: true, data: served.preferences }) } as unknown as Response;
    }
    return { ok: true, status: 200, headers: new Headers({ ETag: '"g-reports-mode"' }),
      json: async () => served.graph } as unknown as Response;
  });
}

function Shell({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ThemeProvider authenticated>{children}</ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function renderMap(scale: number, onOpenTask: (id: string) => void = () => {}, camera = { offsetX: 0, offsetY: 0 }) {
  sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
    scale, ...camera, organization: 'horizontal', altitude: 'task',
  }));
  const view = render(<MapView query={{}} onOpenTask={onOpenTask} onOpenReport={() => {}} />, { wrapper: Shell });
  await waitFor(() => expect(document.querySelector('[data-project-ground="Reports project"]')).not.toBeNull());
  return view;
}

const reportsSwitch = () => screen.getByRole('radiogroup', { name: 'Reports display' });
const groupOf = (task: string) => document.querySelector<HTMLElement>(`.map-report-pill--group[data-report-task="${task}"]`);
const areaOf = (task: string) => document.querySelector<HTMLElement>(`.map-report-area[data-report-task="${task}"]`);
const singlePills = (task?: string) => [...document.querySelectorAll<HTMLElement>('.map-report-pill:not(.map-report-pill--group)')]
  .filter(pill => !task || pill.dataset.reportTask === task);
const boxOf = (element: HTMLElement) => ({
  x: parseFloat(element.style.left), y: parseFloat(element.style.top),
  w: parseFloat(element.style.width), h: parseFloat(element.style.height),
});
const tilePositions = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-task]')]
  .map(element => [element.dataset.task!, [element.style.left, element.style.top]]));

/** The principal stored Expanded earlier: the server row and the provider's boot cache agree. */
function storedExpanded() {
  served.preferences = { ...served.preferences, mapReportsMode: 'expanded' };
  localStorage.setItem(preferencesCacheKey(), JSON.stringify({ ...served.preferences, deploymentTheme: null }));
}

async function chooseExpanded() {
  fireEvent.click(within(reportsSwitch()).getByRole('radio', { name: 'Expanded' }));
  await waitFor(() => expect(singlePills().length).toBeGreaterThan(0));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fetchMock.mockReset();
  served = { graph: estate(), preferences: { theme: null, reducedMotion: 'system', mapReportsMode: 'collapsed' }, saved: [] };
  serve();
});
afterEach(cleanup);

describe('1. the toolbar switch', () => {
  test('sits next to the organization switch and reads "Reports: Collapsed | Expanded", Collapsed by default', async () => {
    await renderMap(SCALE.close);
    const organization = screen.getByRole('radiogroup', { name: 'Map organization' });
    const reports = reportsSwitch();
    // Next to Horizontal | Vertical: the very next toolbar item.
    const item = reports.closest('.map-toolbar > *');
    expect(item?.previousElementSibling).toBe(organization);
    expect(item).toHaveTextContent(/^Reports:/);
    const radios = within(reports).getAllByRole('radio');
    expect(radios.map(radio => radio.textContent)).toEqual(['Collapsed', 'Expanded']);
    expect(within(reports).getByRole('radio', { name: 'Collapsed' })).toHaveAttribute('aria-checked', 'true');
  });

  test('a choice is saved as the principal\'s own preference and comes back after a reload', async () => {
    const first = await renderMap(SCALE.close);
    await chooseExpanded();
    await waitFor(() => expect(served.saved).toEqual([{ mapReportsMode: 'expanded' }]));
    first.unmount();
    // A reload: a new document, the same principal. The stored row answers.
    sessionStorage.clear();
    await renderMap(SCALE.close);
    await waitFor(() => expect(within(reportsSwitch()).getByRole('radio', { name: 'Expanded' }))
      .toHaveAttribute('aria-checked', 'true'));
    await waitFor(() => expect(singlePills(HEAVY)).toHaveLength(HEAVY_COUNT));
    expect(served.saved).toHaveLength(1);
  });

  test('another principal\'s stored choice is what that principal sees', async () => {
    served.preferences = { ...served.preferences, mapReportsMode: 'expanded' };
    await renderMap(SCALE.close);
    await waitFor(() => expect(singlePills(LIGHT)).toHaveLength(LIGHT_COUNT));
    expect(groupOf(HEAVY)).toBeNull();
  });

  test('a save the server refuses says so and keeps the choice for this visit', async () => {
    await renderMap(SCALE.close);
    fetchMock.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/preferences') && init?.method === 'PUT') {
        return { ok: false, status: 500, headers: new Headers(), json: async () => ({ message: 'nope' }) } as unknown as Response;
      }
      return { ok: true, status: 200, headers: new Headers({ ETag: '"g-reports-mode"' }), json: async () => served.graph } as unknown as Response;
    });
    await chooseExpanded();
    expect(await screen.findByText(/could not be saved/i)).toBeInTheDocument();
    expect(singlePills(HEAVY)).toHaveLength(HEAVY_COUNT);
  });
});

describe('2. Collapsed: one "Reports · N" node per task', () => {
  test('each task with Reports has exactly one node showing its N; a task with none has none', async () => {
    await renderMap(SCALE.close);
    await waitFor(() => expect(groupOf(HEAVY)).not.toBeNull());
    expect(groupOf(HEAVY)).toHaveTextContent(`Reports · ${HEAVY_COUNT}`);
    expect(groupOf(LIGHT)).toHaveTextContent(`Reports · ${LIGHT_COUNT}`);
    expect(groupOf(QUIET)).toBeNull();
    expect(document.querySelectorAll('.map-report-pill--group')).toHaveLength(2);
    expect(singlePills()).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^Open linked Report/ })).toHaveLength(0);
  });

  test('the warning tint marks a task above the threshold, and only that one', async () => {
    await renderMap(SCALE.close);
    await waitFor(() => expect(groupOf(HEAVY)).not.toBeNull());
    expect(groupOf(HEAVY)!.querySelector('.map-report-group--many')).not.toBeNull();
    expect(groupOf(LIGHT)!.querySelector('.map-report-group--many')).toBeNull();
  });

  test.each(Object.entries(SCALE))('N is drawn wherever its task is drawn (%s)', async (_band, scale) => {
    await renderMap(scale);
    await waitFor(() => expect(document.querySelector(`[data-task="${HEAVY}"]`)).not.toBeNull());
    for (const [task, count] of [[HEAVY, HEAVY_COUNT], [LIGHT, LIGHT_COUNT]] as const) {
      expect(document.querySelector(`[data-task="${task}"]`), task).not.toBeNull();
      const node = groupOf(task);
      expect(node, `${task} at scale ${scale}`).not.toBeNull();
      expect(node!.querySelector('.map-report-group-count')).toHaveTextContent(String(count));
    }
  });

  test('hover and keyboard focus preview the newest Reports without moving anything', async () => {
    await renderMap(SCALE.close);
    await waitFor(() => expect(groupOf(HEAVY)).not.toBeNull());
    const before = tilePositions();
    const button = within(groupOf(HEAVY)!).getByRole('button');
    fireEvent.pointerEnter(groupOf(HEAVY)!);
    const preview = await screen.findByRole('tooltip');
    expect(button.getAttribute('aria-describedby')).toBe(preview.id);
    const items = within(preview).getAllByRole('listitem');
    // The graph read lists a task's Reports newest first; the preview keeps that order.
    expect(items.map(item => item.textContent)).toEqual(
      Array.from({ length: REPORT_PREVIEW_LIMIT }, (_, index) => titleOf(HEAVY, index)));
    expect(preview).toHaveTextContent(`and ${HEAVY_COUNT - REPORT_PREVIEW_LIMIT} more`);
    expect(tilePositions()).toEqual(before);
    fireEvent.pointerLeave(groupOf(HEAVY)!);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => button.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(titleOf(HEAVY, 0));
    act(() => button.blur());
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(tilePositions()).toEqual(before);
  });

  test('a short list previews every Report and says nothing about more', async () => {
    await renderMap(SCALE.close);
    await waitFor(() => expect(groupOf(LIGHT)).not.toBeNull());
    fireEvent.pointerEnter(groupOf(LIGHT)!);
    const preview = await screen.findByRole('tooltip');
    expect(within(preview).getAllByRole('listitem')).toHaveLength(LIGHT_COUNT);
    expect(preview).not.toHaveTextContent(/more/);
  });

  test('the node is a named control that opens its task, where every Report is listed', async () => {
    const opened: string[] = [];
    await renderMap(SCALE.close, id => opened.push(id));
    await waitFor(() => expect(groupOf(HEAVY)).not.toBeNull());
    const button = within(groupOf(HEAVY)!).getByRole('button');
    expect(button).toHaveAccessibleName(new RegExp(`^Reports · ${HEAVY_COUNT}\\b.*Task ${HEAVY}`));
    fireEvent.click(button);
    expect(opened).toEqual([HEAVY]);
  });
});

describe('3. Expanded: a report area per task holding every Report node', () => {
  test('every readable Report is its own openable node, inside its task\'s area', async () => {
    await renderMap(SCALE.close);
    await chooseExpanded();
    expect(document.querySelectorAll('.map-report-pill--group')).toHaveLength(0);
    for (const [task, count] of [[HEAVY, HEAVY_COUNT], [LIGHT, LIGHT_COUNT]] as const) {
      const pills = singlePills(task);
      expect(pills, task).toHaveLength(count);
      const area = areaOf(task)!;
      expect(area, task).not.toBeNull();
      expect(area.dataset.reportCount).toBe(String(count));
      const box = boxOf(area);
      for (const pill of pills) {
        const x = parseFloat(pill.style.left), y = parseFloat(pill.style.top);
        expect(x).toBeGreaterThanOrEqual(box.x);
        expect(y).toBeGreaterThanOrEqual(box.y);
        expect(x).toBeLessThan(box.x + box.w);
        expect(y).toBeLessThan(box.y + box.h);
      }
    }
    expect(areaOf(QUIET)).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Open linked Report/ })).toHaveLength(HEAVY_COUNT + LIGHT_COUNT);
  });

  test('the area is sized by N and pushes the task card aside', async () => {
    await renderMap(SCALE.close);
    await chooseExpanded();
    const heavy = boxOf(areaOf(HEAVY)!), light = boxOf(areaOf(LIGHT)!);
    expect(heavy.w * heavy.h).toBeGreaterThan(light.w * light.h);
    for (const task of [HEAVY, LIGHT]) {
      const area = boxOf(areaOf(task)!);
      const tile = document.querySelector<HTMLElement>(`[data-task="${task}"]`)!;
      // The task card stands clear of its area: the layout reserved the room.
      expect(parseFloat(tile.style.top)).toBeGreaterThanOrEqual(area.y + area.h);
    }
  });

  test('zoomed out, the area still shows how many Reports its task has', async () => {
    storedExpanded();
    await renderMap(SCALE.overview);
    await waitFor(() => expect(areaOf(HEAVY)).not.toBeNull());
    expect(areaOf(HEAVY)!.querySelector('.map-report-area-count')).toHaveTextContent(String(HEAVY_COUNT));
    expect(areaOf(LIGHT)!.querySelector('.map-report-area-count')).toHaveTextContent(String(LIGHT_COUNT));
  });

  test('Report nodes and their area stay drawn while panning with the task card off-screen', async () => {
    const tall = 120;
    served.graph = { ...estate(), nodes: [estate().nodes[0]], reports: reportsOf(HEAVY, tall) };
    storedExpanded();
    const planned = planeModel.layoutContinuousPlane(served.graph, {}, 'horizontal',
      structuredClone(planeModel.EMPTY_PLANE_ANCHORS));
    const tile = planned.elements.find((element: any) => element.kind === 'tile' && element.id === HEAVY)!;
    const pills = planned.elements.filter((element: any) => element.kind === 'pill');
    expect(pills).toHaveLength(tall);
    const top = Math.min(...pills.map(pill => pill.y));
    const viewport = { width: 1200, height: 800 };
    const camera = { offsetX: 100 - tile.x * SCALE.close, offsetY: 40 - top * SCALE.close };
    // Not vacuous: the task card is past the cull margin and Report cells are on screen.
    expect(tile.y * SCALE.close + camera.offsetY).toBeGreaterThan(viewport.height + 240);
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      const width = this.classList.contains('map-canvas') ? viewport.width : 0;
      const height = this.classList.contains('map-canvas') ? viewport.height : 0;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
    });
    try {
      await renderMap(SCALE.close, () => {}, camera);
      expect(JSON.parse(sessionStorage.getItem(VIEW_STORAGE_KEY)!)).toMatchObject({ scale: SCALE.close, ...camera });
      expect(document.querySelector(`[data-task="${HEAVY}"]`)).toBeNull();
      await waitFor(() => expect(singlePills(HEAVY).length).toBeGreaterThan(0));
      expect(areaOf(HEAVY)).not.toBeNull();
      expect(areaOf(HEAVY)!.dataset.reportCount).toBe(String(tall));
      // Pan further along the grid, the card still off-screen: still drawn.
      const canvas = screen.getByRole('application', { name: 'Task map canvas' });
      fireEvent.keyDown(canvas, { key: 'ArrowRight' });
      await waitFor(() => expect(singlePills(HEAVY).length).toBeGreaterThan(0));
      expect(document.querySelector(`[data-task="${HEAVY}"]`)).toBeNull();
      expect(areaOf(HEAVY)).not.toBeNull();
    } finally { rect.mockRestore(); }
  });
});

describe('4. N counts only what the graph read lists', () => {
  test('a pair listed twice is one Report, and a Report on a task out of scope is drawn nowhere', async () => {
    served.graph = { ...estate(), reports: [
      ...reportsOf(LIGHT, LIGHT_COUNT), reportsOf(LIGHT, 1)[0],
      { id: 'elsewhere', taskId: 'not-in-scope', title: 'Out of scope' },
    ] };
    await renderMap(SCALE.close);
    await waitFor(() => expect(groupOf(LIGHT)).not.toBeNull());
    expect(groupOf(LIGHT)).toHaveTextContent(`Reports · ${LIGHT_COUNT}`);
    expect(groupOf(HEAVY)).toBeNull();
    await chooseExpanded();
    expect(singlePills(LIGHT)).toHaveLength(LIGHT_COUNT);
    expect(areaOf(LIGHT)!.dataset.reportCount).toBe(String(LIGHT_COUNT));
    expect(document.body).not.toHaveTextContent('Out of scope');
  });

  test('when the server lists fewer Reports for this viewer, N is smaller — nothing is added back', async () => {
    served.graph = { ...estate(), reports: reportsOf(HEAVY, 4) };
    await renderMap(SCALE.close);
    await waitFor(() => expect(groupOf(HEAVY)).not.toBeNull());
    expect(groupOf(HEAVY)).toHaveTextContent('Reports · 4');
    expect(groupOf(HEAVY)!.querySelector('.map-report-group--many')).toBeNull();
  });
});
