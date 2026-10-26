// @vitest-environment jsdom
/**
 * Card cae8dfe1 — the Map's A7a deferred features (design 77950a97), each
 * asserted at the RENDERED surface:
 *
 *   (b) the project layer beneath the phase bands (A7c landed it; pinned
 *       here: painted first, containing its phases, overlapping no other
 *       project, and a quieter ground than the phases it holds);
 *   (d) the resizable Map and list split: a separator that is keyboard
 *       operable, keeps a floor for both panes, is remembered for the tab
 *       and changes nothing the layout reads;
 *   (e) hover linking between the list and the map, both ways, by focus as
 *       well as by pointer, in the hover language the tiles already speak,
 *       without touching the chain selection and without re-rendering the
 *       plane for a list hover;
 *   edge-key hardening: a relationship the graph read lists twice draws
 *       once, under a key nothing else can share.
 *
 * The layout and routes run synchronously here (jsdom has no Worker).
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Profiler, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ThemeProvider } from '../../contexts/ThemeContext';
import { MapView } from './MapView';
import { fetchMapGraph, type MapGraphResponse } from './mapGraphApi';
import { uniqueMapEdges, type MapEdge } from './mapGraphModel';
import {
  MAP_SPLIT_STORAGE_KEY, SPLIT_KEY_STEP, clampListSize, readStoredSplit, splitBounds,
} from './useMapSplit';

vi.mock('./mapGraphApi', () => ({ fetchMapGraph: vi.fn() }));
vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: () => () => {}, connected: false, send: () => {} }),
}));
const fetcher = vi.mocked(fetchMapGraph);
const clients: QueryClient[] = [];

const node = (id: string, project: string, phaseId: string | null, status = 'todo', minute = 0) => ({
  id, title: `Task ${id}`, status, priority: 'normal', project, phaseId,
  updated: `2026-10-20T07:${String(minute).padStart(2, '0')}:00.000Z`,
});

/** Two projects, three phases; one dependency and one knowledge link listed TWICE. */
function board(): MapGraphResponse {
  const nodes = [
    ...[0, 1, 2, 3].map(i => node(`a${i}`, 'Alpha', 'pa1', 'todo', i)),
    ...[0, 1].map(i => node(`b${i}`, 'Alpha', 'pa2', 'in-progress', 10 + i)),
    ...[0, 1, 2].map(i => node(`c${i}`, 'Beta', 'pb1', 'todo', 20 + i)),
  ];
  return {
    nodes,
    edges: [
      { from: 'b0', to: 'a0', kind: 'dependency' },
      { from: 'b0', to: 'a0', kind: 'dependency' },
      { from: 'c0', to: 'a1', kind: 'knowledge' },
      { from: 'c0', to: 'a1', kind: 'knowledge' },
      { from: 'b1', to: 'a2', kind: 'dependency' },
    ],
    phases: [
      { id: 'pa1', name: 'Build', goal: null, projectId: 'alpha', position: 0 },
      { id: 'pa2', name: 'Ship', goal: null, projectId: 'alpha', position: 1 },
      { id: 'pb1', name: 'Beta work', goal: null, projectId: 'beta', position: 0 },
    ],
    reports: [],
    fullCount: nodes.length,
    generatedAt: '2026-10-20T08:00:00Z',
  } as unknown as MapGraphResponse;
}

let commits = 0;
function view(children: ReactNode = <MapView query={{}} onOpenTask={() => {}} />) {
  return (
    <QueryClientProvider client={clients[clients.length - 1]}>
      <MemoryRouter><ThemeProvider authenticated={false}>
        <Profiler id="map" onRender={() => { commits += 1; }}>{children}</Profiler>
      </ThemeProvider></MemoryRouter>
    </QueryClientProvider>
  );
}
function mount() {
  clients.push(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return render(view());
}
const tile = (id: string) => document.querySelector<HTMLElement>(`.map-tile[data-task="${id}"]`);
const row = (id: string) => document.querySelector<HTMLElement>(`.map-tree [data-list-task="${id}"]`);
const ring = () => document.querySelector<HTMLElement>('.map-link-ring');
async function ready() {
  await waitFor(() => expect(document.querySelectorAll('.map-tile[data-task]').length).toBe(9));
}
async function openSplit() {
  fireEvent.click(screen.getByRole('button', { name: /map and list/i }));
  return screen.getByRole('separator', { name: /resize the list/i });
}

/**
 * Lay the Map section out at `height` CSS pixels: a 48px toolbar, a 12px
 * separator, the rest shared by the canvas and the list. jsdom has no layout
 * engine, so every measured box is stated here.
 */
function layoutAt(height: number, width = 1200) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const box = (top: number, h: number, w = width) => ({
      x: 0, y: top, left: 0, top, right: w, bottom: top + h, width: w, height: h, toJSON: () => ({}),
    });
    if (this.classList.contains('map-view')) return box(0, height);
    if (this.classList.contains('map-toolbar')) return box(0, 48);
    if (this.classList.contains('map-split-separator')) return box(height - 300, 12);
    // The canvas is stated large, so viewport culling admits every tile.
    if (this.classList.contains('map-canvas')) return box(48, 4000, 6000);
    return box(0, 0, 0);
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem('relayhall_map_view_v2', JSON.stringify({
    organization: 'horizontal', altitude: 'task', scale: 1, offsetX: 0, offsetY: 0 }));
  fetcher.mockReset();
  fetcher.mockImplementation(async () => board());
  commits = 0;
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });

describe('edge-key hardening (absorbed 01282f30)', () => {
  test('a relationship the graph read lists twice draws ONCE, with no duplicate React key', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mount();
    await ready();
    await waitFor(() => expect(document.querySelectorAll('path[data-edge-from]').length).toBeGreaterThan(0));
    const drawn = (from: string, to: string) =>
      document.querySelectorAll(`path[data-edge-from="${from}"][data-edge-to="${to}"]`).length;
    expect(drawn('b0', 'a0')).toBe(1);
    expect(drawn('c0', 'a1')).toBe(1);
    expect(drawn('b1', 'a2')).toBe(1);
    const duplicateKey = errors.mock.calls.some(call => call.some(part => /same key/i.test(String(part))));
    expect(duplicateKey).toBe(false);
  });

  test('uniqueMapEdges keeps the first of each (kind, from, to), in order, and nothing else', () => {
    const edges: MapEdge[] = [
      { from: 'x', to: 'y', kind: 'dependency' },
      { from: 'x', to: 'y', kind: 'knowledge' },
      { from: 'y', to: 'x', kind: 'dependency' },
      { from: 'x', to: 'y', kind: 'dependency' },
      // An id may contain the separator a template key would have used.
      { from: 'x-y', to: 'z', kind: 'dependency' },
      { from: 'x', to: 'y-z', kind: 'dependency' },
    ];
    expect(uniqueMapEdges(edges)).toEqual([edges[0], edges[1], edges[2], edges[4], edges[5]]);
    const clean = edges.slice(0, 3);
    expect(uniqueMapEdges(clean)).toBe(clean);
  });
});

describe('(d) the resizable Map and list split', () => {
  test('"Map and list" keeps the map and opens the list below it, behind a keyboard-operable separator', async () => {
    layoutAt(900);
    mount();
    await ready();
    const separator = await openSplit();
    // The map stays the map: still focusable, still in the a11y tree.
    const canvas = screen.getByRole('application', { name: 'Task map canvas' });
    expect(canvas!.hasAttribute('aria-hidden')).toBe(false);
    expect(canvas!.getAttribute('tabindex')).toBe('0');
    const list = document.querySelector<HTMLElement>('.map-tree')!;
    expect(list).toBeInTheDocument();
    expect(list!.getAttribute('role')).toBe('region');
    expect(list).toHaveAccessibleName('Task list');
    expect(screen.getByRole('button', { name: /map and list/i })!.getAttribute('aria-pressed')).toBe('true');

    expect(separator!.getAttribute('aria-orientation')).toBe('horizontal');
    expect(separator!.getAttribute('aria-controls')).toBe(list.id);
    expect(separator!.getAttribute('tabindex')).toBe('0');
    // 900 - 48 - 12 = 840 shared: list floor 120, canvas floor 200, default 40%.
    expect(separator!.getAttribute('aria-valuemin')).toBe('120');
    expect(separator!.getAttribute('aria-valuemax')).toBe('640');
    expect(separator!.getAttribute('aria-valuenow')).toBe('336');
    separator.focus();
    fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(separator!.getAttribute('aria-valuenow')).toBe(String(336 + SPLIT_KEY_STEP));
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(separator!.getAttribute('aria-valuenow')).toBe(String(336 - SPLIT_KEY_STEP));
    fireEvent.keyDown(separator, { key: 'PageUp' });
    expect(separator!.getAttribute('aria-valuenow')).toBe(String(336 + 3 * SPLIT_KEY_STEP));
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator!.getAttribute('aria-valuenow')).toBe('120');
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(separator!.getAttribute('aria-valuenow')).toBe('120');
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator!.getAttribute('aria-valuenow')).toBe('640');
    fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(separator!.getAttribute('aria-valuenow')).toBe('640');
    // The list's height is what the stylesheet reads.
    expect(document.querySelector<HTMLElement>('.map-view')!.style.getPropertyValue('--map-split-list-size')).toBe('640px');
  });

  test('a drag resizes, and neither pane can be dragged to nothing', async () => {
    // jsdom has no PointerEvent; without one a pointer event carries no
    // clientY, button or pointerId (the Task detail separator's shim).
    if (typeof window.PointerEvent !== 'function') {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
      }
      Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent });
    }
    layoutAt(900);
    mount();
    await ready();
    const separator = await openSplit();
    const section = document.querySelector<HTMLElement>('.map-view')!;
    fireEvent.pointerDown(separator, { clientY: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(separator, { clientY: 400, pointerId: 1 });
    expect(section.style.getPropertyValue('--map-split-list-size')).toBe('436px');
    fireEvent.pointerMove(separator, { clientY: -5000, pointerId: 1 });
    expect(section.style.getPropertyValue('--map-split-list-size')).toBe('640px');
    fireEvent.pointerUp(separator, { clientY: -5000, pointerId: 1 });
    expect(separator!.getAttribute('aria-valuenow')).toBe('640');
    fireEvent.pointerDown(separator, { clientY: 100, pointerId: 2, button: 0 });
    fireEvent.pointerMove(separator, { clientY: 9000, pointerId: 2 });
    fireEvent.pointerUp(separator, { clientY: 9000, pointerId: 2 });
    expect(separator!.getAttribute('aria-valuenow')).toBe('120');
    // A secondary button is not a drag.
    fireEvent.pointerDown(separator, { clientY: 100, pointerId: 3, button: 2 });
    fireEvent.pointerMove(separator, { clientY: -9000, pointerId: 3 });
    expect(separator!.getAttribute('aria-valuenow')).toBe('120');
  });

  test.each([
    ['a phone', 640, 120, 380],
    ['a short window', 300, 60, 144],
  ])('narrow: on %s (%ipx tall) both panes keep a floor', async (_name, height, min, max) => {
    layoutAt(height, 375);
    mount();
    await ready();
    const separator = await openSplit();
    expect(separator!.getAttribute('aria-valuemin')).toBe(String(min));
    expect(separator!.getAttribute('aria-valuemax')).toBe(String(max));
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator!.getAttribute('aria-valuenow')).toBe(String(min));
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator!.getAttribute('aria-valuenow')).toBe(String(max));
    const shared = height - 48 - 12;
    expect(min).toBeGreaterThan(0);
    expect(shared - max).toBeGreaterThan(0);
  });

  test('the bounds are a pure function of the space, and a corrupt stored entry is a closed split', () => {
    expect(splitBounds(840)).toEqual({ min: 120, max: 640 });
    expect(clampListSize(-50, 840)).toBe(120);
    expect(clampListSize(5000, 840)).toBe(640);
    sessionStorage.setItem(MAP_SPLIT_STORAGE_KEY, '{{{');
    expect(readStoredSplit()).toEqual({ open: false, listSize: null });
    sessionStorage.setItem(MAP_SPLIT_STORAGE_KEY, JSON.stringify({ open: true, listSize: -4 }));
    expect(readStoredSplit()).toEqual({ open: true, listSize: null });
  });

  test('the split and its size are remembered for the tab (sessionStorage), and no plane geometry is stored', async () => {
    layoutAt(900);
    const first = mount();
    await ready();
    const separator = await openSplit();
    fireEvent.keyDown(separator, { key: 'ArrowUp' });
    fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(JSON.parse(sessionStorage.getItem(MAP_SPLIT_STORAGE_KEY)!)).toEqual({ open: true, listSize: 384 });
    first.unmount();
    mount();
    await ready();
    const restored = screen.getByRole('separator', { name: /resize the list/i });
    expect(restored!.getAttribute('aria-valuenow')).toBe('384');
    // E386: nothing about the plane's layout is written to the browser.
    const stored = [...Array(localStorage.length).keys()].map(i => localStorage.key(i) ?? '')
      .concat([...Array(sessionStorage.length).keys()].map(i => sessionStorage.key(i) ?? ''));
    expect(stored.filter(key => /plane|anchor/i.test(key))).toEqual([]);
    // Closing it is remembered too.
    fireEvent.click(screen.getByRole('button', { name: /map and list/i }));
    expect(screen.queryByRole('separator', { name: /resize the list/i })).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(MAP_SPLIT_STORAGE_KEY)!)).toMatchObject({ open: false });
  });

  test('resizing the split moves the viewport only: every ground keeps its exact rectangle', async () => {
    layoutAt(900);
    mount();
    await ready();
    const geometry = () => [...document.querySelectorAll('rect[data-phase-ground], rect[data-project-ground]')]
      .map(rect => ['data-phase-ground', 'data-project-ground', 'x', 'y', 'width', 'height']
        .map(name => rect.getAttribute(name))).sort();
    const tiles = () => [...document.querySelectorAll<HTMLElement>('.map-tile[data-task]')]
      .map(element => [element.dataset.task, element.style.left, element.style.top]).sort();
    const before = { grounds: geometry(), tiles: tiles() };
    expect(before.grounds.length).toBe(5);
    const separator = await openSplit();
    fireEvent.keyDown(separator, { key: 'End' });
    act(() => { window.dispatchEvent(new Event('resize')); });
    fireEvent.keyDown(separator, { key: 'Home' });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(geometry()).toEqual(before.grounds);
    expect(tiles()).toEqual(before.tiles);
  });

  test('"Show as list" still REPLACES the canvas (round 2 B2), and leaving it returns to the split', async () => {
    layoutAt(900);
    mount();
    await ready();
    await openSplit();
    fireEvent.click(screen.getByRole('button', { name: /show as list/i }));
    expect(document.querySelector('.map-canvas')!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('separator', { name: /resize the list/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show as map/i }));
    expect(document.querySelector('.map-canvas')!.hasAttribute('aria-hidden')).toBe(false);
    expect(screen.getByRole('separator', { name: /resize the list/i })).toBeInTheDocument();
  });

  test('the split view is axe-clean', async () => {
    layoutAt(900);
    mount();
    await ready();
    await openSplit();
    const results = await axe.run(document.querySelector<HTMLElement>('.map-view')!, {
      rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'],
    });
    expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)).toEqual([]);
  });
});

describe('(e) hover linking between the list and the map', () => {
  test('hovering a list row lights its tile through ONE ring, without re-rendering the Map', async () => {
    layoutAt(900);
    mount();
    await ready();
    await openSplit();
    const target = tile('a2')!;
    const before = commits;
    fireEvent.pointerEnter(row('a2')!);
    expect(ring()!.hasAttribute('data-active')).toBe(true);
    expect(ring()!.getAttribute('data-link-task')).toBe('a2');
    expect(ring()!.style.left).toBe(target.style.left);
    expect(ring()!.style.top).toBe(target.style.top);
    expect(parseFloat(ring()!.style.width)).toBeGreaterThan(0);
    expect(parseFloat(ring()!.style.height)).toBeGreaterThan(0);
    expect(document.querySelectorAll('.map-link-ring')).toHaveLength(1);
    fireEvent.pointerEnter(row('c1')!);
    expect(ring()!.getAttribute('data-link-task')).toBe('c1');
    expect(ring()!.style.top).toBe(tile('c1')!.style.top);
    fireEvent.pointerLeave(row('c1')!);
    expect(ring()!.hasAttribute('data-active')).toBe(false);
    // Cheap at estate scale: a list hover is answered in the DOM, not by a
    // render of the plane.
    expect(commits).toBe(before);
  });

  test('focus drives the list-to-map link as well as the pointer', async () => {
    layoutAt(900);
    mount();
    await ready();
    await openSplit();
    const opener = within(row('b1')!).getByRole('button');
    act(() => { opener.focus(); });
    expect(ring()!.getAttribute('data-link-task')).toBe('b1');
    act(() => { opener.blur(); });
    expect(ring()!.hasAttribute('data-active')).toBe(false);
  });

  test('hovering or focusing a tile lights its list row, scrolling the list only when the row is out of sight', async () => {
    const rects = layoutAt(900);
    mount();
    await ready();
    await openSplit();
    const list = document.querySelector<HTMLElement>('.map-tree')!;
    rects.mockImplementation(function (this: HTMLElement) {
      const box = (top: number, h: number) => ({
        x: 0, y: top, left: 0, top, right: 1200, bottom: top + h, width: 1200, height: h, toJSON: () => ({}),
      });
      if (this === list) return box(600, 240);
      if (this.dataset.listTask === 'c2') return box(1000, 36);
      if (this.dataset.listTask === 'a0') return box(640, 36);
      if (this.classList.contains('map-view')) return box(0, 900);
      if (this.classList.contains('map-toolbar')) return box(0, 48);
      if (this.classList.contains('map-split-separator')) return box(588, 12);
      return box(0, 0);
    });
    list.scrollTop = 10;
    fireEvent.pointerEnter(tile('a0')!);
    expect(row('a0')!.hasAttribute('data-map-linked')).toBe(true);
    expect(list.scrollTop).toBe(10);
    fireEvent.pointerLeave(tile('a0')!);
    expect(row('a0')!.hasAttribute('data-map-linked')).toBe(false);
    act(() => { tile('c2')!.querySelector<HTMLElement>('button, [tabindex]')?.focus(); });
    expect(row('c2')!.hasAttribute('data-map-linked')).toBe(true);
    // 1036 - 840 = 196 below the list's bottom edge.
    expect(list.scrollTop).toBe(10 + 196);
    expect(document.querySelectorAll('.map-tree [data-map-linked]')).toHaveLength(1);
  });

  test('linking never changes the chain selection, and the ring still marks a dimmed tile', async () => {
    layoutAt(900);
    mount();
    await ready();
    await openSplit();
    fireEvent.click(tile('b0')!);
    await waitFor(() => expect(tile('c1')!.className).toMatch(/map-tile--dimmed/));
    const classes = () => [...document.querySelectorAll<HTMLElement>('.map-tile[data-task]')]
      .map(element => `${element.dataset.task}:${element.className}`).sort();
    const selected = classes();
    fireEvent.pointerEnter(row('c1')!);
    expect(ring()!.getAttribute('data-link-task')).toBe('c1');
    expect(classes()).toEqual(selected);
    fireEvent.pointerLeave(row('c1')!);
    expect(classes()).toEqual(selected);
    expect(tile('b0')!.className).toMatch(/map-tile--lit/);
  });

  test('without the split nothing links (the list is not on screen)', async () => {
    mount();
    await ready();
    fireEvent.pointerEnter(tile('a0')!);
    expect(document.querySelector('[data-map-linked]')).toBeNull();
    expect(ring()?.hasAttribute('data-active') ?? false).toBe(false);
  });
});

describe('(b) the project layer beneath the phase bands', () => {
  test.each(['horizontal', 'vertical'])('%s: each project ground is painted first, contains its phases and overlaps no other project', async organization => {
    sessionStorage.setItem('relayhall_map_view_v2', JSON.stringify({
      organization, altitude: 'task', scale: 1, offsetX: 0, offsetY: 0 }));
    mount();
    await ready();
    const svg = document.querySelector('svg.map-edges')!;
    const order = [...svg.querySelectorAll('rect[data-project-ground], rect[data-phase-ground]')];
    const box = (rect: Element) => ['x', 'y', 'width', 'height'].map(name => Number(rect.getAttribute(name)));
    const projects = order.filter(rect => rect.hasAttribute('data-project-ground'));
    const phases = order.filter(rect => rect.hasAttribute('data-phase-ground'));
    expect(projects.map(rect => rect.getAttribute('data-project-ground')).sort()).toEqual(['Alpha', 'Beta']);
    expect(phases).toHaveLength(3);
    for (const phase of phases) {
      const lane = phase.getAttribute('data-phase-ground')!.split(':')[1];
      const project = projects.find(rect => rect.getAttribute('data-project-ground') === lane)!;
      // Beneath: painted before the phase.
      expect(order.indexOf(project)).toBeLessThan(order.indexOf(phase));
      const [px, py, pw, ph] = box(project);
      const [x, y, w, h] = box(phase);
      expect(x).toBeGreaterThanOrEqual(px);
      expect(y).toBeGreaterThanOrEqual(py);
      expect(x + w).toBeLessThanOrEqual(px + pw);
      expect(y + h).toBeLessThanOrEqual(py + ph);
    }
    const [a, b] = projects.map(box);
    const intersects = a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    expect(intersects).toBe(false);
  });

  test('the two grounds have a legible depth: different fills, and the project carries the heavier rule', () => {
    const css = readFileSync(join(__dirname, 'MapView.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
      expect(found, selector).not.toBeNull();
      const value = (property: string) => new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(found![1])?.[1].trim();
      return { fill: value('fill'), stroke: value('stroke'), width: parseFloat(value('stroke-width') ?? '0') };
    };
    const project = rule('.map-project-ground');
    const phase = rule('.map-phase-ground');
    expect(project.fill).toBeDefined();
    expect(phase.fill).toBeDefined();
    expect(project.fill).not.toBe(phase.fill);
    expect(project.stroke).not.toBe(phase.stroke);
    expect(project.width).toBeGreaterThan(phase.width);
  });
});
