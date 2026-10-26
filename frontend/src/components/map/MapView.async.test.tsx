// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MapView } from './MapView';
import { computeMapPlane } from './computeMapPlane';
import { fetchMapGraph, type MapGraphResponse } from './mapGraphApi';
import { EMPTY_PLANE_ANCHORS } from './mapPlaneModel';
import type { MapPlaneRequest } from './mapPlaneWorkerProtocol';
import type { MapPlaneWorkerPort } from './mapPlaneWorkerClient';
import type { MapRoutesWorkerPort } from './mapRoutesWorkerClient';
import { computeMapRoutes } from './computeMapRoutes';
import retargetFixture from './__fixtures__/retarget.graph.json';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { preferencesCacheKey } from '../../utils/theme';

vi.mock('./mapGraphApi', () => ({ fetchMapGraph: vi.fn() }));
const socket = vi.hoisted(() => ({ handlers: new Map<string, (value: unknown) => void>(),
  subscribe: (name: string, fn: (value: unknown) => void) => { socket.handlers.set(name, fn); return () => socket.handlers.delete(name); } }));
vi.mock('../../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: socket.subscribe, connected: false }) }));
const fetcher = vi.mocked(fetchMapGraph), ports: Port[] = [], clients: QueryClient[] = [];
const routePorts: RoutePort[] = [];
class RoutePort implements MapRoutesWorkerPort {
  sent: Parameters<MapRoutesWorkerPort['postMessage']>[0][] = []; finished = 0;
  onmessage: MapRoutesWorkerPort['onmessage'] = null;
  onerror: MapRoutesWorkerPort['onerror'] = null;
  onmessageerror: MapRoutesWorkerPort['onmessageerror'] = null;
  terminate = vi.fn();
  constructor() { routePorts.push(this); }
  postMessage(request: Parameters<MapRoutesWorkerPort['postMessage']>[0]) { this.sent.push(request); }
  finish() { const request = this.sent[this.finished++];
    this.onmessage?.({ data: { id: request.id, ok: true, result: computeMapRoutes(request.input) } } as MessageEvent); }
}
let canvasWidth = 1200;
let recordedDestination: number | null = null;
class Port implements MapPlaneWorkerPort {
  sent: MapPlaneRequest[] = []; finished = 0;
  onmessage: MapPlaneWorkerPort['onmessage'] = null;
  onerror: MapPlaneWorkerPort['onerror'] = null;
  onmessageerror: MapPlaneWorkerPort['onmessageerror'] = null;
  terminate = vi.fn();
  constructor() { ports.push(this); }
  postMessage(request: MapPlaneRequest) { this.sent.push(request); }
  finish() {
    const request = this.sent[this.finished++];
    this.onmessage?.({ data: { id: request.id, channel: request.channel, ok: true, result: (() => {
      const result=computeMapPlane(request.input);
      const destination=recordedDestination;
      if(destination!==null) result.elements=result.elements.map(e=>e.id===motionOwner||e.id===motionPill
        ? {...e,x:destination,y:e.id===motionOwner?508:452,w:e.id===motionOwner?170:36,h:e.id===motionOwner?100:36}:e);
      return result;
    })() } } as MessageEvent);
  }
}
const source = (): MapGraphResponse => ({ nodes: ['a','b'].map(id => ({ id, title: 'Task ' + id, status: 'todo',
  priority: 'normal', project: 'Project', phaseId: 'phase', updated: '2026-10-07T00:00:00Z' })),
  edges: [{ from: 'b', to: 'a', kind: 'dependency' }], phases: [{ id: 'phase', name: 'Phase', goal: 'Goal', projectId: 'project', position: 0 }],
  reports: [{ id: 'report', taskId: 'a', title: 'Evidence' }], fullCount: 2, generatedAt: '2026-10-07T00:00:00Z' });
const saved = () => JSON.parse(sessionStorage.getItem('relayhall_map_view_v2')!);
async function settleGeometryOnly() {
  for (let turn = 0; turn < 16; turn++) {
    const port = ports.find(p => !p.terminate.mock.calls.length && p.finished < p.sent.length);
    if (!port) { await act(async () => {}); return; }
    await act(async () => port.finish());
  }
  throw new Error('Geometry did not settle');
}
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  // Card 742fae98: these suites follow INDIVIDUAL Report pills through the
  // layout worker, so the reader has chosen Expanded (the principal's
  // preference, read here from the provider's boot cache while signed out).
  localStorage.setItem(preferencesCacheKey(), JSON.stringify({
    theme: null, reducedMotion: 'system', mapReportsMode: 'expanded', deploymentTheme: null }));
  const view = render(<QueryClientProvider client={client}><MemoryRouter><ThemeProvider authenticated={false}><MapView query={{}} onOpenTask={() => {}} onOpenReport={() => {}} /></ThemeProvider></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect((ports[0]?.sent.length ?? 0) + (routePorts[0]?.sent.length ?? 0)).toBeGreaterThan(0)); return view;
}
async function settle() {
  for (let turn = 0; turn < 16; turn++) {
    const port = ports.find(p => !p.terminate.mock.calls.length && p.finished < p.sent.length)
      ?? routePorts.find(p => !p.terminate.mock.calls.length && p.finished < p.sent.length);
    if (!port) { await act(async () => {}); return; }
    await act(async () => port.finish());
  }
  throw new Error('Geometry did not settle within 16 replies');
}
beforeEach(() => {
  ports.length = 0; routePorts.length = 0; socket.handlers.clear(); fetcher.mockReset(); fetcher.mockResolvedValue(source());
  recordedDestination = null; canvasWidth = 1200; vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('Worker', class { constructor(url: URL) {
    return url.pathname.endsWith('/mapRoutes.worker.ts') ? new RoutePort() : new Port();
  } }); localStorage.clear(); sessionStorage.clear();
  sessionStorage.setItem('relayhall_map_view_v2', JSON.stringify({ organization: 'horizontal', altitude: 'task', scale: 1, offsetX: 0, offsetY: 0 }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const w = this.classList.contains('map-canvas') ? canvasWidth : 0, h = this.classList.contains('map-canvas') ? 800 : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(170);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(96);
});
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const motionOwner = '717413de-f888-4502-9808-bee3e97c2d71';
const motionPill = `pill:battery-all-report-0:${motionOwner}`;
function recorded(cohort: keyof typeof retargetFixture): MapGraphResponse {
  return { ...retargetFixture[cohort], generatedAt: '2026-10-07T05:00:00Z' } as unknown as MapGraphResponse;
}
async function replaceAdmittedGraph(cohort: keyof typeof retargetFixture) {
  const client = clients.at(-1)!;
  const active = client.getQueryCache().findAll({ queryKey: ['map-graph'], type: 'active' });
  expect(active).toHaveLength(1);
  act(() => client.setQueryData(active[0].queryKey, recorded(cohort)));
  await waitFor(()=>{const graph=ports.filter(p=>!p.terminate.mock.calls.length).at(-1)?.sent.at(-1)?.input.graph;expect(graph?.nodes).toEqual(recorded(cohort).nodes);expect(graph?.reports).toEqual(recorded(cohort).reports);});
}
test('retarget isolation: accepted replacements retain owner and pill when culling is disabled', async () => {
  canvasWidth = 0; fetcher.mockResolvedValue(recorded('live'));
  sessionStorage.setItem('relayhall_map_view_v2', JSON.stringify({ organization:'organic',altitude:'task',scale:1.25423,offsetX:151.199,offsetY:-518.829 }));
  await mount(); await settle();
  const owner=document.querySelector(`[data-task="${motionOwner}"]`),pill=document.querySelector(`[data-map-motion-id="${motionPill}"]`);
  expect(owner).not.toBeNull();expect(pill).not.toBeNull();
  for(const cohort of ['arrival','archive','retarget'] as const){await replaceAdmittedGraph(cohort);await settle();expect(document.querySelector(`[data-task="${motionOwner}"]`)).toBe(owner);expect(document.querySelector(`[data-map-motion-id="${motionPill}"]`)).toBe(pill);}
});
test('retarget isolation: recorded replacements retain DOM under the test viewport without refetch', async () => {
  canvasWidth = 3840; fetcher.mockResolvedValue(recorded('live'));
  sessionStorage.setItem('relayhall_map_view_v2', JSON.stringify({ organization:'organic',altitude:'task',scale:1.25423,offsetX:151.199,offsetY:-518.829 }));
  await mount(); await settle();
  const owner=document.querySelector(`[data-task="${motionOwner}"]`);expect(owner).not.toBeNull();
  for(const cohort of ['arrival','archive','retarget'] as const){await replaceAdmittedGraph(cohort);await settle();}
  // Direct replacements isolate layout from authority/read lifecycle.
  expect(document.querySelector(`[data-task="${motionOwner}"]`)).toBe(owner);
});
// Owner deferred Organic; its archive-motion contract is retained for reactivation.
test.skip('recorded destination outside cull margin retains committed task and pill during retarget', async () => {
  canvasWidth=3840;recordedDestination=1894;fetcher.mockResolvedValue(recorded('arrival'));
  sessionStorage.setItem('relayhall_map_view_v2',JSON.stringify({organization:'organic',altitude:'task',scale:1.25423,offsetX:151.199,offsetY:0}));
  await mount();await settle();
  const owner=document.querySelector(`[data-task="${motionOwner}"]`),pill=document.querySelector(`[data-map-motion-id="${motionPill}"]`);
  expect(owner).not.toBeNull();expect(pill).not.toBeNull();
  recordedDestination=-458.118;await replaceAdmittedGraph('archive');
  await waitFor(()=>expect(ports[0].sent.at(-1)?.input.graph.nodes.find(n=>n.id===motionOwner)?.status).toBe('archived'));await settle();
  expect(document.querySelector(`[data-task="${motionOwner}"]`)).toBe(owner);
  recordedDestination=-1136.26487;await replaceAdmittedGraph('retarget');
  await waitFor(()=>expect(ports[0].sent.at(-1)?.input.graph.reports).toHaveLength(recorded('retarget').reports.length));await settle();
  expect(document.querySelector(`[data-task="${motionOwner}"]`)).toBe(owner);
  expect(document.querySelector(`[data-map-motion-id="${motionPill}"]`)).toBe(pill);
});

test('same-authority background refetch preserves admitted DOM across parent renders', async () => {
  canvasWidth = 0; fetcher.mockResolvedValue(recorded('live'));
  const view=await mount();await settle();const owner=document.querySelector('[data-task]');expect(owner).not.toBeNull();
  fetcher.mockImplementation(()=>new Promise(()=>{}));const client=clients.at(-1)!;
  await act(async()=>{void client.invalidateQueries({queryKey:['map-graph']});});
  view.rerender(<QueryClientProvider client={client}><MemoryRouter><ThemeProvider authenticated={false}><MapView query={{}} onOpenTask={()=>{}} onOpenReport={()=>{}} /></ThemeProvider></MemoryRouter></QueryClientProvider>);
  expect(document.querySelector('[data-task]')).toBe(owner);
});

test('deferred geometry keeps the canvas and projects metadata/deletion without unmounting survivors', async () => {
  await mount(); expect(screen.getByRole('application', { name: 'Task map canvas' })).toBeInTheDocument();
  expect(document.querySelector('[data-task]')).toBeNull(); expect(screen.queryByText('No Tasks match the current filters.')).toBeNull();
  await settle(); const tile = document.querySelector('[data-task="a"]'); expect(tile).not.toBeNull();
  act(() => socket.handlers.get('task.updated')?.({ task: { ...source().nodes[0], title: 'Current title', activeAgent: { name: 'Working' } } }));
  await waitFor(() => expect(tile?.textContent).toContain('Current title'));
  expect(document.querySelector('[data-task="a"]')).toBe(tile);
  act(() => socket.handlers.get('task.deleted')?.({ id: 'b' }));
  await waitFor(() => expect(document.querySelector('[data-task="b"]')).toBeNull());
  expect(document.querySelector('[data-task="a"]')).toBe(tile);
  expect(screen.getByText(/Updating layout/)).toBeInTheDocument(); await settle();
});

test('route worker keeps current relationships visibly pending then adopts exact paths', async () => {
  await mount(); await settleGeometryOnly();
  const pending = [...document.querySelectorAll('path[data-route-state="pending"]')];
  expect(pending.length).toBeGreaterThan(0);
  expect(screen.getByText('Calculating connections…')).toBeInTheDocument();
  for (const path of pending) {
    expect(path.getAttribute('d')).toBeTruthy(); expect(path.getAttribute('stroke-dasharray')).toBe('3 5');
    expect(path.querySelector('title')?.textContent).toContain('Calculating connection');
  }
  await settle();
  expect(document.querySelector('[data-route-state="pending"]')).toBeNull();
  expect(screen.queryByText('Calculating connections…')).toBeNull();
  const latest = routePorts.filter(p => !p.terminate.mock.calls.length).at(-1)!;
  const expected = computeMapRoutes(latest.sent.at(-1)!.input).map(row => row.route.d);
  const paths = [...document.querySelectorAll('path[data-route-state]')].map(path => path.getAttribute('d'));
  expect(paths.sort()).toEqual(expected.sort());
});

test('route error has explicit retry and does not silently drop pending connections', async () => {
  await mount(); await settleGeometryOnly(); const port = routePorts.filter(p => !p.terminate.mock.calls.length).at(-1)!;
  act(() => port.onerror?.(new Event('error')));
  expect(screen.getByRole('button', { name: 'Retry connections' })).toBeInTheDocument();
  expect(document.querySelectorAll('[data-route-state="failed"]').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Retry connections' })); await settle();
  expect(screen.queryByRole('button', { name: 'Retry connections' })).toBeNull();
  expect(document.querySelector('[data-route-state="pending"]')).toBeNull();
});

test('deletion and authority loss remove current route ink and reject retained callbacks', async () => {
  await mount(); await settleGeometryOnly(); const port = routePorts.filter(p => !p.terminate.mock.calls.length).at(-1)!;
  const request = port.sent[0], callback = port.onmessage;
  act(() => socket.handlers.get('task.deleted')?.({ id: 'b' }));
  await waitFor(() => expect(document.querySelector('[data-task="b"]')).toBeNull());
  expect(document.querySelector('.map-edge--dependency')).toBeNull();
  await settle();
  fetcher.mockImplementation(() => new Promise(() => {}));
  expect(socket.handlers.has('project.authority_changed')).toBe(true);
  act(() => socket.handlers.get('project.authority_changed')?.({}));
  await waitFor(() => expect(document.querySelectorAll('[data-route-state]')).toHaveLength(0));
  expect(document.querySelector('[data-task]')).toBeNull();
  await act(async () => callback?.({ data: { id: request.id, ok: true, result: computeMapRoutes(request.input) } } as MessageEvent));
  expect(document.querySelectorAll('[data-route-state]')).toHaveLength(0);
});

test.each([
  { organization: 'horizontal', altitude: 'task', scale: 0.1, prefix: 'task', mode: 'flow' },
  { organization: 'vertical', altitude: 'task', scale: 0.1, prefix: 'task', mode: 'flow' },
])('routes $prefix connections with the original $mode consumer', async ({ organization, altitude, scale, prefix, mode }) => {
  canvasWidth = 0; // no auto-fit/culling; examine the explicitly selected layer
  const data = source();
  data.nodes[1] = { ...data.nodes[1], project: 'Other', phaseId: 'phase2' };
  data.phases.push({ id: 'phase2', name: 'Phase2', goal: '', projectId: 'other', position: 1 });
  fetcher.mockResolvedValue(data);
  sessionStorage.setItem('relayhall_map_view_v2', JSON.stringify({ organization, altitude, scale, offsetX: 0, offsetY: 0 }));
  await mount(); await settle();
  const sent = routePorts.flatMap(port => port.sent).flatMap(request => request.input.requests);
  const selected = sent.filter(request => JSON.parse(request.key)[0] === prefix);
  expect(selected.length).toBeGreaterThan(0); expect(selected.every(request => request.mode === mode)).toBe(true);
  expect(document.querySelector('[data-route-state="pending"]')).toBeNull();
});

test('Fit waits for geometry and later pan owns the camera across completion', async () => {
  await mount(); const before = saved(); fireEvent.click(screen.getByRole('button', { name: 'Fit view' }));
  expect(saved()).toEqual(before);
  fireEvent.keyDown(screen.getByRole('application', { name: 'Task map canvas' }), { key: 'ArrowRight' });
  const panned = saved(); expect(panned).not.toEqual(before);
  await settle(); expect(saved()).toEqual(panned);
  fireEvent.click(screen.getByRole('button', { name: 'Fit view' })); await settle();
  await waitFor(() => expect(saved()).not.toEqual(panned));
});

test('organization remains committed until target completion and pan cancels a stale target', async () => {
  await mount(); await settle(); const port = ports[0];
  fireEvent.click(screen.getByRole('radio', { name: 'Vertical' }));
  expect(saved().organization).toBe('horizontal'); expect(port.sent.at(-1)?.channel).toBe('switch');
  fireEvent.keyDown(screen.getByRole('application', { name: 'Task map canvas' }), { key: 'ArrowRight' });
  const panned = saved(); await settle(); expect(saved()).toEqual(panned);
  expect(screen.getByText('View changed; select the layout again.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'Vertical' })); await settle();
  await waitFor(() => expect(saved().organization).toBe('vertical'));
  expect(screen.getByRole('radio', { name: 'Vertical' })).toHaveAttribute('aria-checked', 'true');
});

// E386: a target organization starts from the data alone. A record stored by
// an earlier release is never read, and the density migration that once
// demanded a complete membership read before a switch is gone.
test('an organization switch reads no stored record and needs no membership read (E386)', async () => {
  await mount(); await settle();
  localStorage.setItem('relayhall_map_plane_anchors_v2:vertical', JSON.stringify(
    { ...EMPTY_PLANE_ANCHORS, laneOrder: ['Project'], laneHeight: { Project: 400 } } as unknown));
  const reads = vi.spyOn(Storage.prototype, 'getItem');
  const loads = fetcher.mock.calls.length;
  fireEvent.click(screen.getByRole('radio', { name: 'Vertical' })); await settle();
  await waitFor(() => expect(saved().organization).toBe('vertical'));
  expect(fetcher.mock.calls.length).toBe(loads);
  expect(reads.mock.calls.filter(([key]) => String(key).startsWith('relayhall_map_plane_anchors'))).toEqual([]);
  expect(ports[0].sent.at(-1)?.input.anchors).toEqual(EMPTY_PLANE_ANCHORS);
});

test('authority invalidation hides tiles and terminates a pending calculation immediately', async () => {
  await mount(); await settle(); const old = ports[0];
  fetcher.mockImplementation(() => new Promise(() => {}));
  act(() => socket.handlers.get('project.authority_changed')?.({}));
  expect(document.querySelector('[data-task]')).toBeNull(); expect(old.terminate).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Loading the Map…')).toBeInTheDocument();
});

test('worker failure is visible without a synchronous layout fallback', async () => {
  await mount(); await act(async () => ports[0].onerror?.(new Event('error')));
  expect(screen.getByRole('alert')).toHaveTextContent('Map calculation worker failed');
  expect(document.querySelector('[data-task]')).toBeNull(); expect(ports).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry layout' })); expect(ports).toHaveLength(2);
  await settle(); expect(document.querySelector('[data-task]')).not.toBeNull();
});

test('switch-only failure after settled geometry exposes retry and a later switch succeeds', async () => {
  await mount(); await settle();
  fireEvent.click(screen.getByRole('radio', { name: 'Vertical' }));
  await act(async () => ports[0].onerror?.(new Event('error')));
  expect(saved().organization).toBe('horizontal');
  expect(screen.getByRole('button', { name: 'Retry layout' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry layout' })); await settle();
  fireEvent.click(screen.getByRole('radio', { name: 'Vertical' })); await settle();
  expect(saved().organization).toBe('vertical');
});

test('data completion reschedules the chosen target against current metadata', async () => {
  await mount(); await settle(); const port = ports[0];
  fireEvent.click(screen.getByRole('radio', { name: 'Vertical' }));
  act(() => socket.handlers.get('task.updated')?.({ task: { ...source().nodes[0], title: 'Latest switch metadata' } }));
  await waitFor(() => expect(document.querySelector('[data-task="a"]')?.textContent).toContain('Latest switch metadata'));
  await settle(); expect(saved().organization).toBe('vertical');
  const switches = port.sent.filter(request => request.channel === 'switch');
  expect(switches.length).toBeGreaterThan(1);
  expect(switches.at(-1)?.input.graph.nodes.find(n => n.id === 'a')?.title).toBe('Latest switch metadata');
});

test('measurement completion while switching preserves the chosen target and latest sizes', async () => {
  await mount(); const port = ports[0];
  await act(async () => port.finish());
  expect(port.finished).toBeLessThan(port.sent.length); // mounted cards queued measured geometry
  fireEvent.click(screen.getByRole('radio', { name: 'Vertical' }));
  await settle(); expect(saved().organization).toBe('vertical');
  expect(port.sent.filter(request => request.channel === 'switch').at(-1)?.input.sizes.a).toEqual({ w: 170, h: 96 });
});

test('viewport change cancels a pending target without a stale organization commit', async () => {
  await mount(); await settle();
  fireEvent.click(screen.getByRole('radio', { name: 'Vertical' }));
  canvasWidth = 900; fireEvent(window, new Event('resize'));
  await settle(); expect(saved().organization).toBe('horizontal');
  expect(screen.getByText('View changed; select the layout again.')).toBeInTheDocument();
});

// E386: no layout record is written at all — not on a settled layout, not on
// a timer, and not after authority loss — so nothing can outlive the session.
test('no layout record is ever written, before or after authority loss (E386)', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  await mount(); vi.useFakeTimers(); const scheduled = vi.spyOn(window, 'setTimeout'); await settle();
  expect(scheduled.mock.calls.filter(([, delay]) => delay === 750)).toEqual([]);
  fetcher.mockImplementation(() => new Promise(() => {}));
  act(() => socket.handlers.get('project.authority_changed')?.({}));
  await act(async () => vi.advanceTimersByTime(2000));
  expect(storage.mock.calls.filter(([key]) => key.startsWith('relayhall_map_plane'))).toEqual([]);
  expect(document.querySelector('[data-task]')).toBeNull();
});
