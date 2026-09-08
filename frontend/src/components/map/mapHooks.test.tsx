// @vitest-environment jsdom
//
// RH-UI — the Map lifecycle hooks (design 77950a97 §8): view state, data, and
// canvas interaction. Each hook exists to make ONE historical defect class
// structurally impossible, so every test below pins a defect rather than
// restating the implementation. The defect each one pins is named in a
// comment above it.
//
// Backend shapes come from the RECORDED fixtures in ./__fixtures__ — never
// from an invented response.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Task } from '../../types/task';
import { authenticatedFetch } from '../../utils/auth';
import graphDeltaFixture from './__fixtures__/graph.delta.json';
import graphTaskFixture from './__fixtures__/graph.task.json';
import type { MapGraphQuery } from './mapGraphApi';
import type { DetailBand } from './useMapData';
import { DETAIL_MATRIX, DETAIL_THRESHOLDS, detailBandFor, useMapData } from './useMapData';
import { useMapInteractions } from './useMapInteractions';
import { DEFAULT_VIEW, planeFitScale, SCALE_MAX, SCALE_MIN, useMapViewState } from './useMapViewState';

const STORAGE_KEY = 'relayhall_map_view';

// ---------------------------------------------------------------------------
// Harness (pattern copied from src/pages/TasksPage.windowing.test.tsx)
// ---------------------------------------------------------------------------

const wsHandlers = new Map<string, (msg: unknown) => void>();
// Left DISCONNECTED by default: the reconnect effect fires the same debounced
// delta reconcile, and an unattributed extra fetch would make the "fetches
// once" and "no refetch" assertions below meaningless.
const wsState = { connected: false };

vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    subscribe: (type: string, handler: (msg: unknown) => void) => {
      wsHandlers.set(type, handler);
      return () => wsHandlers.delete(type);
    },
    connected: wsState.connected,
    send: () => {},
  }),
}));

const fetchMock = vi.mocked(authenticatedFetch);
const requestUrls: string[] = [];

/** The exact `generatedAt` the recorded full read emits — the delta anchor. */
const RECORDED_GENERATED_AT = graphTaskFixture.generatedAt;
/** A node present in the recorded graph, with two recorded edges pointing at it. */
const KNOWN_NODE_ID = '8466bafe-12bd-4ee2-bcc4-c9609b528c8f';
const UNKNOWN_NODE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const QUERY: MapGraphQuery = { includeArchived: false };

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

const paramOf = (url: string, name: string) =>
  new URL(url, 'http://localhost').searchParams.get(name);

const flush = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
};

const wsEvent = async (type: string, msg: unknown) => {
  const handler = wsHandlers.get(type);
  expect(handler, `no subscriber for ${type}`).toBeTruthy();
  await act(async () => { handler!(msg); });
};

const taskPayload = (id: string, title: string): Task => ({
  id,
  title,
  status: 'in-progress',
  priority: 'urgent',
  project: 'Atlas Migration',
  phaseId: '68656943-cdcb-416f-a0be-5c37e378a463',
  updated: '2026-08-16T22:00:00.000Z',
} as unknown as Task);

const renderMapData = async () => {
  const rendered = renderHook(() => useMapData(QUERY), { wrapper });
  await waitFor(() => { expect(rendered.result.current.isLoading).toBe(false); });
  return rendered;
};

beforeEach(() => {
  sessionStorage.clear();
  wsHandlers.clear();
  wsState.connected = false;
  requestUrls.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    requestUrls.push(url);
    // A request carrying `updatedSince` is the delta read; anything else is
    // the full graph read. Both bodies are the RECORDED responses.
    const body = paramOf(url, 'updatedSince') ? graphDeltaFixture : graphTaskFixture;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
  sessionStorage.clear();
});

// ---------------------------------------------------------------------------
// useMapViewState
// ---------------------------------------------------------------------------

describe('useMapViewState', () => {
  test('1. a FRESH view owes exactly one fit, and applying it settles the debt', () => {
    // Pins: a fresh map that never fits opens at scale 1 / offset 0 with the
    // graph off-screen. needsFit() must be true before, false after.
    const { result } = renderHook(() => useMapViewState());

    expect(result.current.needsFit()).toBe(true);
    // Reading it must not consume it — the caller reads once per render.
    expect(result.current.needsFit()).toBe(true);

    act(() => {
      result.current.applyFit({ organization: 'horizontal', altitude: 'task', scale: 0.42, offsetX: -120, offsetY: 33 });
    });

    expect(result.current.needsFit()).toBe(false);
    expect(result.current.view.scale).toBeCloseTo(0.42, 5);
    expect(result.current.view.offsetX).toBe(-120);
  });

  test('2. a RESTORED view reports needsFit() FALSE from the very first call, and the flag is never persisted', () => {
    // Pins diagnosis 7fa7e605 §C: the fresh-view flag was WRITTEN to
    // sessionStorage, so every reload read it back as "still fresh",
    // re-fired a fit, and destroyed the Back-restoration it existed to serve.
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      organization: 'horizontal', scale: 0.55, offsetX: -400, offsetY: 90,
    }));

    const restored = renderHook(() => useMapViewState());
    // FIRST call, before anything else touches the hook.
    expect(restored.result.current.needsFit()).toBe(false);
    // The stored record above has NO `altitude`: it is what a session that
    // predates amendment §2/§5-A2 left behind. It is old, not corrupt, and its
    // scale was taken at the task altitude — so restoring it as `task` returns
    // the reader to the view they actually left, and a Map shipped mid-session
    // does not throw away anyone's position.
    expect(restored.result.current.view).toEqual({
      organization: 'horizontal', altitude: 'task', scale: 0.55, offsetX: -400, offsetY: 90,
    });

    // The persisted record must carry view geometry ONLY — no fit flag under
    // any spelling. This is the assertion the old implementation failed.
    const persisted = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual(['altitude', 'offsetX', 'offsetY', 'organization', 'scale']);
    expect(sessionStorage.getItem(STORAGE_KEY) ?? '').not.toMatch(/fit/i);

    // And the real reload path: pan, unmount, mount again against the same
    // storage. A second fit must never fire.
    act(() => { restored.result.current.panBy(-25, -15); });
    restored.unmount();

    const reloaded = renderHook(() => useMapViewState());
    expect(reloaded.result.current.needsFit()).toBe(false);
    expect(reloaded.result.current.view.offsetX).toBe(-425);
    expect(reloaded.result.current.view.offsetY).toBe(75);
  });

  test('3. corrupt sessionStorage falls back to defaults and never throws', () => {
    // Pins: a half-written or foreign entry used to throw out of the initial
    // useState, taking the whole Map page down on mount.
    sessionStorage.setItem(STORAGE_KEY, '{{{');

    let result!: ReturnType<typeof renderHook<ReturnType<typeof useMapViewState>, unknown>>['result'];
    expect(() => { ({ result } = renderHook(() => useMapViewState())); }).not.toThrow();

    expect(result.current.view).toEqual(DEFAULT_VIEW);
    // Unreadable state is not restored state, so the fresh view still owes a fit.
    expect(result.current.needsFit()).toBe(true);
    // And the corrupt entry is replaced by a readable one.
    expect(() => JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '')).not.toThrow();
  });

  test('4. zoomBy about an anchor keeps the plane point under the anchor stationary', () => {
    // Pins: zoom that scaled without re-solving the offset walked the graph
    // out from under the cursor, which is what made "zoom to a tile"
    // unusable. The invariant is (anchor - offset) / scale.
    const { result } = renderHook(() => useMapViewState());
    act(() => { result.current.panBy(-310, 145); });

    const anchor = { x: 512, y: 288 };
    const planeBefore = {
      x: (anchor.x - result.current.view.offsetX) / result.current.view.scale,
      y: (anchor.y - result.current.view.offsetY) / result.current.view.scale,
    };

    act(() => { result.current.zoomBy(1.37, anchor); });
    const planeAfterZoomIn = {
      x: (anchor.x - result.current.view.offsetX) / result.current.view.scale,
      y: (anchor.y - result.current.view.offsetY) / result.current.view.scale,
    };
    expect(result.current.view.scale).toBeCloseTo(1.37, 5);
    expect(planeAfterZoomIn.x).toBeCloseTo(planeBefore.x, 2);
    expect(planeAfterZoomIn.y).toBeCloseTo(planeBefore.y, 2);

    act(() => { result.current.zoomBy(0.41, anchor); });
    const planeAfterZoomOut = {
      x: (anchor.x - result.current.view.offsetX) / result.current.view.scale,
      y: (anchor.y - result.current.view.offsetY) / result.current.view.scale,
    };
    expect(planeAfterZoomOut.x).toBeCloseTo(planeBefore.x, 2);
    expect(planeAfterZoomOut.y).toBeCloseTo(planeBefore.y, 2);
    // Non-vacuous: the offset really did move to pay for the scale change.
    expect(result.current.view.offsetX).not.toBe(-310);
  });

  test('5. scale clamps at SCALE_MIN and SCALE_MAX however many times you zoom', () => {
    // Pins: unclamped repeated wheel zoom drove scale to 0 (division by zero
    // in the anchor solve → NaN offsets → blank canvas) or to a scale where
    // the layout boxes overflowed the canvas transform.
    const { result } = renderHook(() => useMapViewState());
    const anchor = { x: 640, y: 360 };

    for (let i = 0; i < 60; i += 1) act(() => { result.current.zoomBy(0.7, anchor); });
    expect(result.current.view.scale).toBe(SCALE_MIN);
    expect(Number.isFinite(result.current.view.offsetX)).toBe(true);
    expect(Number.isFinite(result.current.view.offsetY)).toBe(true);

    for (let i = 0; i < 60; i += 1) act(() => { result.current.zoomBy(1.4, anchor); });
    expect(result.current.view.scale).toBe(SCALE_MAX);

    // zoomTo is clamped by the same gate, including through absurd input.
    act(() => { result.current.zoomTo(10_000, anchor); });
    expect(result.current.view.scale).toBe(SCALE_MAX);
    act(() => { result.current.zoomTo(0, anchor); });
    expect(result.current.view.scale).toBe(SCALE_MIN);
  });
});

// ---------------------------------------------------------------------------
// useMapData
// ---------------------------------------------------------------------------

describe('useMapData', () => {
  test('6. reads the graph ONCE and exposes the recorded nodes, edges and phases', async () => {
    // Pins: the Map used to issue a second read on mount (the retired
    // lod=project aggregate alongside the task read), racing two responses
    // into one cache key. §5 amendment: one read, at every zoom.
    const { result } = await renderMapData();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(paramOf(requestUrls[0], 'lod')).toBe('task');
    expect(paramOf(requestUrls[0], 'updatedSince')).toBeNull();

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.graph.nodes).toHaveLength(graphTaskFixture.nodes.length);
    expect(result.current.graph.edges).toHaveLength(graphTaskFixture.edges.length);
    expect(result.current.fullCount).toBe(graphTaskFixture.fullCount);
    expect(result.current.generatedAt).toBe(RECORDED_GENERATED_AT);

    // A real phase name out of the RECORDED response, not a synthesized one.
    expect(result.current.graph.phases.map(phase => phase.name)).toContain('Cutover');
    expect(result.current.graph.nodes.map(node => node.title)).toContain('Cut over the reverse proxy');
  });

  test('7. task.updated for a KNOWN node patches in place and triggers NO refetch', async () => {
    // Pins: every WS event used to invalidate the graph query, so a busy
    // estate refetched the whole graph per keystroke of agent activity —
    // and each refetch replaced the node array, killing the pulse and any
    // in-flight interaction.
    const { result } = await renderMapData();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    await wsEvent('task.updated', { task: taskPayload(KNOWN_NODE_ID, 'Cut over the reverse proxy (patched)') });

    const patched = result.current.graph.nodes.find(node => node.id === KNOWN_NODE_ID);
    expect(patched?.title).toBe('Cut over the reverse proxy (patched)');
    expect(patched?.priority).toBe('urgent');
    expect(result.current.graph.nodes).toHaveLength(graphTaskFixture.nodes.length);
    expect(result.current.pulsed.has(KNOWN_NODE_ID)).toBe(true);

    // Past both the 300ms delta debounce and any refetch tick: still one read.
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await flush();
  });

  test('8. task.updated for an UNKNOWN id leaves the cache intact and schedules a delta reconcile', async () => {
    // Pins: an event for a task the client had never seen was written
    // straight into the node array, inventing a node with no layout inputs
    // and no server ruling on whether it is even in the filter scope. Only
    // the server decides membership — via a debounced `updatedSince` read.
    const { result } = await renderMapData();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    await wsEvent('task.updated', { task: taskPayload(UNKNOWN_NODE_ID, 'A task from outside the scope') });

    // Nothing invented, nothing lost, and no fetch before the debounce.
    expect(result.current.graph.nodes.map(node => node.id)).not.toContain(UNKNOWN_NODE_ID);
    expect(result.current.graph.nodes).toHaveLength(graphTaskFixture.nodes.length);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(350); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The reconcile is a DELTA: it carries the exact generatedAt the server
    // emitted, which is the only encoding the route accepts.
    expect(paramOf(requestUrls[1], 'updatedSince')).toBe(RECORDED_GENERATED_AT);
    expect(paramOf(requestUrls[1], 'lod')).toBe('task');

    vi.useRealTimers();
    // The merged result is still the recorded scope — the delta carried no
    // nodes, so membership stands and the unknown id is still absent.
    await waitFor(() => {
      expect(result.current.generatedAt).toBe(graphDeltaFixture.generatedAt);
    });
    expect(result.current.graph.nodes).toHaveLength(graphTaskFixture.nodes.length);
    expect(result.current.graph.nodes.map(node => node.id)).not.toContain(UNKNOWN_NODE_ID);
  });

  test('9. task.deleted carrying the production `{ id }` payload prunes the node AND every edge touching it', async () => {
    // Pins review eac02957 B1: the broadcaster emits `{ id }` for deletion
    // and archival, but the client read `task.id` / `taskId` and therefore
    // pruned NOTHING — deleted tasks stayed on the map until a full reload.
    const { result } = await renderMapData();

    const edgesTouching = graphTaskFixture.edges
      .filter(edge => edge.from === KNOWN_NODE_ID || edge.to === KNOWN_NODE_ID);
    // Non-vacuous: the node really does carry edges before the prune.
    expect(edgesTouching.length).toBeGreaterThan(0);
    expect(result.current.graph.nodes.map(node => node.id)).toContain(KNOWN_NODE_ID);

    await wsEvent('task.deleted', { id: KNOWN_NODE_ID });

    await waitFor(() => {
      expect(result.current.graph.nodes.map(node => node.id)).not.toContain(KNOWN_NODE_ID);
    });
    expect(result.current.graph.nodes).toHaveLength(graphTaskFixture.nodes.length - 1);
    expect(result.current.graph.edges).toHaveLength(graphTaskFixture.edges.length - edgesTouching.length);
    expect(result.current.graph.edges.some(
      edge => edge.from === KNOWN_NODE_ID || edge.to === KNOWN_NODE_ID,
    )).toBe(false);

    // Archival rides the same production payload shape.
    const survivor = result.current.graph.nodes[0].id;
    await wsEvent('task.archived', { id: survivor });
    await waitFor(() => {
      expect(result.current.graph.nodes.map(node => node.id)).not.toContain(survivor);
    });
  });

  test('10. detailBandFor honours the documented thresholds and DETAIL_MATRIX never turns detail OFF as scale rises', async () => {
    // Pins review eac02957 B2 / round-11: the old tier matrix dropped detail
    // back off at higher zoom (and gated FETCHING on the tier), so zooming in
    // could remove a tile's title or trigger the tier-1 full fetch. Detail is
    // now render-only and strictly monotonic. Asserted as a PROPERTY over the
    // exported table, not as a restatement of it.
    const epsilon = 0.001;
    expect(detailBandFor(0)).toBe('far');
    expect(detailBandFor(DETAIL_THRESHOLDS.overview - epsilon)).toBe('far');
    expect(detailBandFor(DETAIL_THRESHOLDS.overview)).toBe('overview');
    expect(detailBandFor(DETAIL_THRESHOLDS.mid - epsilon)).toBe('overview');
    expect(detailBandFor(DETAIL_THRESHOLDS.mid)).toBe('mid');
    expect(detailBandFor(DETAIL_THRESHOLDS.close - epsilon)).toBe('mid');
    expect(detailBandFor(DETAIL_THRESHOLDS.close)).toBe('close');
    expect(detailBandFor(SCALE_MAX)).toBe('close');

    // Walk the scale range and record the band sequence the function actually
    // produces; it must ascend through all four bands and never go backwards.
    const observed: DetailBand[] = [];
    for (let scale = SCALE_MIN; scale <= SCALE_MAX + 1e-9; scale += 0.005) {
      const band = detailBandFor(scale);
      if (observed[observed.length - 1] !== band) observed.push(band);
    }
    expect(observed).toEqual(['far', 'overview', 'mid', 'close']);

    const flags = Object.keys(DETAIL_MATRIX.far) as Array<keyof typeof DETAIL_MATRIX.far>;
    let turnedOn = 0;
    for (let index = 1; index < observed.length; index += 1) {
      const lower = DETAIL_MATRIX[observed[index - 1]];
      const higher = DETAIL_MATRIX[observed[index]];
      for (const flag of flags) {
        if (lower[flag]) {
          expect(higher[flag], `${String(flag)} switched OFF from ${observed[index - 1]} to ${observed[index]}`).toBe(true);
        } else if (higher[flag]) {
          turnedOn += 1;
        }
      }
    }
    // Non-vacuous: detail genuinely accumulates rather than the table being
    // uniformly true or uniformly false.
    expect(turnedOn).toBeGreaterThan(0);
    expect(Object.values(DETAIL_MATRIX.far).every(value => value === false)).toBe(true);
    expect(Object.values(DETAIL_MATRIX.close).every(value => value === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review 7fc68646 B1 — a pinch must zoom and must NOT pan.
//
// The interaction tests elsewhere in this file use a MouseEvent surrogate with
// no pointerId, so they could never see this: with two fingers down the
// primary pointer kept feeding onPan while the pinch fed onZoom. These use
// real PointerEvent shapes with distinct pointerId / isPrimary / pointerType.
// ---------------------------------------------------------------------------

/**
 * jsdom ships no PointerEvent, which is exactly why the older tests in this
 * file fell back to a bare MouseEvent with no pointer identity at all — and so
 * why 390 green tests said nothing about a pinch that also panned. This shim
 * carries the three fields the gesture owner actually reads: a DISTINCT
 * pointerId per finger, isPrimary, and pointerType.
 */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  readonly pointerType: string;
  constructor(type: string, init: MouseEventInit & {
    pointerId: number; isPrimary: boolean; pointerType: string;
  }) {
    super(type, init);
    this.pointerId = init.pointerId;
    this.isPrimary = init.isPrimary;
    this.pointerType = init.pointerType;
  }
}

const pointer = (type: string, id: number, x: number, y: number, primary: boolean) =>
  new TestPointerEvent(type, {
    bubbles: true, cancelable: true,
    pointerId: id, isPrimary: primary, pointerType: 'touch',
    button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: x, clientY: y,
  }) as unknown as PointerEvent;

describe('pinch is one gesture, not a pan and a zoom at once', () => {
  const mountCanvas = () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return element;
  };

  test('two fingers spreading zoom WITHOUT any pan', async () => {
    const element = mountCanvas();
    const onPan = vi.fn();
    const onZoom = vi.fn();
    const { result } = renderHook(() => useMapInteractions({ onZoom, onPan, onZoomCentre: vi.fn() }));
    act(() => { result.current.canvasRef(element); });

    act(() => {
      element.dispatchEvent(pointer('pointerdown', 1, 100, 100, true));
      // A move on the single pointer would pan; the second finger arrives first.
      element.dispatchEvent(pointer('pointerdown', 2, 200, 100, false));
      element.dispatchEvent(pointer('pointermove', 1, 60, 100, true));
      element.dispatchEvent(pointer('pointermove', 2, 240, 100, false));
    });

    expect(onZoom).toHaveBeenCalled();
    expect(onPan).not.toHaveBeenCalled();
    element.remove();
  });

  test('a pan already in flight STOPS the moment a second finger lands', () => {
    const element = mountCanvas();
    const onPan = vi.fn();
    const onZoom = vi.fn();
    const { result } = renderHook(() => useMapInteractions({ onZoom, onPan, onZoomCentre: vi.fn() }));
    act(() => { result.current.canvasRef(element); });

    act(() => {
      element.dispatchEvent(pointer('pointerdown', 1, 100, 100, true));
      element.dispatchEvent(pointer('pointermove', 1, 140, 100, true));
    });
    expect(onPan).toHaveBeenCalled();
    const pansBeforePinch = onPan.mock.calls.length;

    act(() => {
      element.dispatchEvent(pointer('pointerdown', 2, 300, 100, false));
      element.dispatchEvent(pointer('pointermove', 1, 60, 100, true));
      element.dispatchEvent(pointer('pointermove', 2, 360, 100, false));
    });
    // Not one further pan call, however far the primary pointer travels.
    expect(onPan.mock.calls.length).toBe(pansBeforePinch);
    expect(onZoom).toHaveBeenCalled();
    element.remove();
  });

  test('a LOST pointerup does not wedge the map: the next move heals it', () => {
    // Found in a real browser while verifying the pinch repair. Because the
    // pointer COUNT now chooses the branch, one pointer left behind by a
    // missing pointerup disabled panning entirely — the same symptom the owner
    // originally reported. A move reporting no buttons releases it.
    const element = document.createElement('div');
    document.body.appendChild(element);
    const onPan = vi.fn();
    const onZoom = vi.fn();
    const { result } = renderHook(() => useMapInteractions({ onZoom, onPan, onZoomCentre: vi.fn() }));
    act(() => { result.current.canvasRef(element); });

    act(() => {
      element.dispatchEvent(pointer('pointerdown', 1, 100, 100, true));
      element.dispatchEvent(pointer('pointerdown', 2, 300, 100, false));
      // Finger 2 is lifted but its pointerup is LOST. Only a buttons-free move
      // reports the truth.
      element.dispatchEvent(new TestPointerEvent('pointermove', {
        bubbles: true, pointerId: 2, isPrimary: false, pointerType: 'touch',
        buttons: 0, clientX: 300, clientY: 100,
      }) as unknown as PointerEvent);
      element.dispatchEvent(pointer('pointerup', 1, 100, 100, true));
    });

    onPan.mockClear();
    act(() => {
      element.dispatchEvent(pointer('pointerdown', 3, 100, 100, true));
      element.dispatchEvent(pointer('pointermove', 3, 160, 100, true));
    });
    expect(onPan).toHaveBeenCalled();
    element.remove();
  });

  // PRESERVATION PIN, not a regression — green on the reviewed bytes too. It
  // guards the obvious wrong repair to the two tests above: ending the pinch by
  // simply re-arming the pan would jump the plane by the gap between fingers.
  test('lifting one finger does not resume panning with the other', () => {
    const element = mountCanvas();
    const onPan = vi.fn();
    const onZoom = vi.fn();
    const { result } = renderHook(() => useMapInteractions({ onZoom, onPan, onZoomCentre: vi.fn() }));
    act(() => { result.current.canvasRef(element); });

    act(() => {
      element.dispatchEvent(pointer('pointerdown', 1, 100, 100, true));
      element.dispatchEvent(pointer('pointerdown', 2, 200, 100, false));
      element.dispatchEvent(pointer('pointermove', 2, 260, 100, false));
      element.dispatchEvent(pointer('pointerup', 2, 260, 100, false));
      // The remaining finger travels far. Resuming the pan here would jump the
      // plane by the gap between the two fingers.
      element.dispatchEvent(pointer('pointermove', 1, 400, 100, true));
    });
    expect(onPan).not.toHaveBeenCalled();
    element.remove();
  });
});

// ---------------------------------------------------------------------------
// Review 51a17ab2 B3 — taxonomy-only changes must converge without a routine
// full refetch (§6). Verified by falsification: each FAILS on the reviewed
// bytes. The delta body is the recorded fixture with ONE field varied.
// ---------------------------------------------------------------------------

/** Serve a modified DELTA body while the full read stays the recorded one. */
const withDeltaBody = (body: unknown) => {
  fetchMock.mockImplementation(async (url: string) => {
    requestUrls.push(url);
    const payload = paramOf(url, 'updatedSince') ? body : graphTaskFixture;
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });
};

describe('live taxonomy converges through the production reconcile paths', () => {
  test('a progress-only delta reaches a node the updated_at window excludes', async () => {
    // Pins: progress rode ONLY on deltaRows, selected by the task's
    // updated_at. A subtask ticking over need not rotate that timestamp, so
    // the ETag changed while no node in the payload could express the change.
    const { result } = await renderMapData();
    withDeltaBody({
      ...graphDeltaFixture,
      nodes: [],
      taxonomy: [{ id: KNOWN_NODE_ID, progress: { done: 3, total: 5 } }],
    });

    vi.useFakeTimers();
    await wsEvent('task.updated', { task: taskPayload(UNKNOWN_NODE_ID, 'forces a reconcile') });
    act(() => { vi.advanceTimersByTime(350); });
    vi.useRealTimers();

    await waitFor(() => {
      const node = result.current.graph.nodes.find(n => n.id === KNOWN_NODE_ID);
      expect(node?.progress).toEqual({ done: 3, total: 5 });
    });
  });

  test('Reports arriving on a delta reach the rendered graph', async () => {
    // Pins: the merge replaced edges and phases but DROPPED reports, so an
    // added, removed or retitled Report never reached the screen.
    //
    // The recorded graph fixture predates the taxonomy fields (see
    // SHAPE.json), so this drives the falsifying direction: a delta that
    // CARRIES reports must put them on screen. Row shape is the serializer's
    // own — backend queryLinkedReports returns {id, taskId, title}.
    const { result } = await renderMapData();
    expect(result.current.graph.reports ?? []).toEqual([]);
    withDeltaBody({
      ...graphDeltaFixture,
      nodes: [],
      reports: [{ id: 'c7933d8c-bbde-4a37-b57c-f180f8921d35', taskId: KNOWN_NODE_ID,
                  title: 'Showcase: alert tuning round 1' }],
    });

    vi.useFakeTimers();
    await wsEvent('task.updated', { task: taskPayload(UNKNOWN_NODE_ID, 'forces a reconcile') });
    act(() => { vi.advanceTimersByTime(350); });
    vi.useRealTimers();

    await waitFor(() => {
      expect((result.current.graph.reports ?? []).map(report => report.id))
        .toEqual(['c7933d8c-bbde-4a37-b57c-f180f8921d35']);
    });
  });

  test('an agent pickup on an in-scope task patches liveness in place, name only', async () => {
    // Pins: the WS patch rewrote five membership fields and never touched
    // agent. A pickup moves NO membership field, so it also scheduled no
    // reconcile — the every-zoom badge sat stale until something else moved.
    const { result } = await renderMapData();
    const before = result.current.graph.nodes.find(node => node.id === KNOWN_NODE_ID)!;

    await wsEvent('task.updated', {
      task: {
        ...(before as unknown as Task),
        id: KNOWN_NODE_ID,
        activeAgent: { name: 'Relay', sessionKey: 'must-not-leak', harness: 'hermes' },
      },
    });

    await waitFor(() => {
      expect(result.current.graph.nodes.find(n => n.id === KNOWN_NODE_ID)?.agent).toBe('Relay');
    });
    // The graph keeps the NAME and nothing else: session internals stay out.
    expect(JSON.stringify(result.current.graph)).not.toContain('must-not-leak');
  });

  // PRESERVATION PIN, not a regression test — green on the reviewed bytes too,
  // because they never touched progress at all. It guards the obvious WRONG
  // fix to the test above: recomputing progress unconditionally from a payload
  // that never carried subtasks would blank every tile bar in the estate.
  test('a WS payload that omits subtasks does not erase known progress', async () => {
    // Guards the obvious wrong fix: recomputing progress unconditionally from
    // a payload that never carried subtasks would blank every tile bar.
    const { result } = await renderMapData();
    const before = result.current.graph.nodes.find(node => node.id === KNOWN_NODE_ID)!;

    await wsEvent('task.updated', { task: taskPayload(KNOWN_NODE_ID, before.title) });

    await flush();
    expect(result.current.graph.nodes.find(n => n.id === KNOWN_NODE_ID)?.progress)
      .toEqual(before.progress);
  });
});

// ---------------------------------------------------------------------------
// useMapInteractions
// ---------------------------------------------------------------------------

const makeCanvas = () => {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({
    x: 20, y: 10, left: 20, top: 10, right: 820, bottom: 610,
    width: 800, height: 600, toJSON: () => ({}),
  }) as DOMRect;
  // jsdom does not implement pointer capture; the hook calls it optionally.
  element.setPointerCapture = () => {};
  element.releasePointerCapture = () => {};
  document.body.appendChild(element);
  return element;
};

/** jsdom has no PointerEvent constructor; MouseEvent carries every field read. */
const pointerEvent = (type: string, init: MouseEventInit) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });

describe('useMapInteractions', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  test('11. with NO canvas element nothing throws and the viewport stays 0x0', () => {
    // Pins: the effects used to run unconditionally and dereference a null
    // canvas during the loading state. Equally: a guessed default viewport is
    // a lie — before measurement the honest answer is zero, not 1200x800.
    const onZoom = vi.fn();
    const onPan = vi.fn();

    const { result, unmount } = renderHook(() => useMapInteractions({ onZoom, onPan }));

    expect(result.current.canvas).toBeNull();
    expect(result.current.viewport).toEqual({ width: 0, height: 0 });
    expect(result.current.isPanning).toBe(false);
    expect(() => act(() => { result.current.canvasRef(null); })).not.toThrow();
    expect(result.current.viewport).toEqual({ width: 0, height: 0 });
    expect(onZoom).not.toHaveBeenCalled();
    expect(onPan).not.toHaveBeenCalled();
    expect(() => unmount()).not.toThrow();
  });

  test('12. a canvas that mounts AFTER the first render still gets its non-passive wheel listener and a measured viewport', () => {
    // Pins round 11 + diagnosis 7fa7e605 §C: the listener effect keyed on
    // unrelated deps, so when the canvas mounted after a loading state the
    // effect never re-ran — the wheel listener was never installed, and its
    // ResizeObserver sibling froze the viewport at a hard-coded 1200x800,
    // poisoning culling, fitting and zoom anchoring. Element-as-state makes
    // that impossible: no element, no effect; element arrives, effect runs.
    const onZoom = vi.fn();
    const onPan = vi.fn();

    const { result } = renderHook(() => useMapInteractions({ onZoom, onPan }));
    // First render happened with NO canvas — this is the loading state.
    expect(result.current.canvas).toBeNull();
    expect(result.current.viewport).toEqual({ width: 0, height: 0 });

    const canvas = makeCanvas();
    const addSpy = vi.spyOn(canvas, 'addEventListener');

    act(() => { result.current.canvasRef(canvas); });

    const wheelCall = addSpy.mock.calls.find(call => call[0] === 'wheel');
    expect(wheelCall, 'no wheel listener was installed when the canvas arrived').toBeTruthy();
    // preventDefault is ignored on a passive listener, so the page would
    // scroll instead of the map zooming.
    expect(wheelCall![2]).toEqual({ passive: false });

    // The ResizeObserver sibling ran too: the viewport is the MEASURED box.
    expect(result.current.canvas).toBe(canvas);
    expect(result.current.viewport).toEqual({ width: 800, height: 600 });
    expect(addSpy.mock.calls.map(call => call[0])).toEqual(
      expect.arrayContaining(['wheel', 'pointerdown', 'pointermove', 'pointerup']),
    );
  });

  test('13. a wheel event on the canvas zooms about an anchor derived from the event position', () => {
    // Pins: the anchor used to be taken in page coordinates without
    // subtracting the canvas box, so zooming pulled the graph towards the
    // window origin instead of towards the cursor.
    const onZoom = vi.fn();
    const onPan = vi.fn();
    const canvas = makeCanvas();

    const { result } = renderHook(() => useMapInteractions({ onZoom, onPan }));
    act(() => { result.current.canvasRef(canvas); });

    const event = new WheelEvent('wheel', {
      deltaY: -120, clientX: 320, clientY: 210, bubbles: true, cancelable: true,
    });
    act(() => { canvas.dispatchEvent(event); });

    expect(onZoom).toHaveBeenCalledTimes(1);
    const [factor, anchor] = onZoom.mock.calls[0] as [number, { x: number; y: number }];
    // Canvas box is left 20 / top 10, so the anchor is client minus box.
    expect(anchor).toEqual({ x: 300, y: 200 });
    // Scrolling up (negative deltaY) zooms IN.
    expect(factor).toBeGreaterThan(1);
    // Non-passive: the browser default really is suppressed.
    expect(event.defaultPrevented).toBe(true);

    act(() => {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 120, clientX: 320, clientY: 210, bubbles: true, cancelable: true,
      }));
    });
    expect((onZoom.mock.calls[1] as [number, unknown])[0]).toBeLessThan(1);
  });

  test('14. a small drag from a control keeps its click; a real drag pans', () => {
    // Pins BOTH halves of the tension adversarial finding F9 exposed. The
    // opener stretches over the whole tile, so refusing to pan from any
    // interactive target made the map undraggable from its dominant
    // surface. Refusing nothing would steal every click. The threshold is
    // what separates the two, so both directions are asserted here.
    const onZoom = vi.fn();
    const onPan = vi.fn();
    const canvas = makeCanvas();
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.appendChild(label);
    canvas.appendChild(button);

    const { result } = renderHook(() => useMapInteractions({ onZoom, onPan }));
    act(() => { result.current.canvasRef(canvas); });

    // A press and a 2px wobble on a control: still a click, never a pan.
    act(() => { label.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 })); });
    act(() => { canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 102, clientY: 101 })); });
    expect(onPan).not.toHaveBeenCalled();
    expect(result.current.isPanning).toBe(false);
    act(() => { canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 102, clientY: 101 })); });

    // A genuine drag STARTING ON THE SAME CONTROL pans the map.
    act(() => { label.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 })); });
    act(() => { canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 140 })); });
    expect(result.current.isPanning).toBe(true);
    expect(onPan).toHaveBeenCalled();
    act(() => { canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 160, clientY: 140 })); });
    expect(result.current.isPanning).toBe(false);

    // Text entry keeps its own pointer semantics entirely.
    onPan.mockClear();
    const input = document.createElement('input');
    canvas.appendChild(input);
    act(() => { input.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 })); });
    act(() => { canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 200 })); });
    expect(onPan).not.toHaveBeenCalled();
    expect(result.current.isPanning).toBe(false);
  });
});

describe('useMapViewState — re-arming a fit wakes the effect that spends it', () => {
  test('requestRefit bumps a value React can see (round 1, B3)', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      organization: 'horizontal', altitude: 'task', scale: 0.55, offsetX: -10, offsetY: 5,
    }));
    const { result } = renderHook(() => useMapViewState());
    // A restored view owes no fit.
    expect(result.current.needsFit()).toBe(false);
    const before = result.current.refitNonce;

    act(() => { result.current.requestRefit(); });

    // The debt is armed...
    expect(result.current.needsFit()).toBe(true);
    // ...AND something rendered. The pending-fit flag is a ref, so it is
    // invisible to React; without this bump the toolbar Fit control set the
    // flag and nothing re-ran, leaving Fit inert until an unrelated update
    // happened along (round 1, B3).
    expect(result.current.refitNonce).not.toBe(before);
  });
});


describe('continuous plane fit floor', () => {
  test('fits the whole extent with ten percent margins and guards pathological planes', () => {
    expect(planeFitScale({ width: 4000, height: 1000 }, { width: 1000, height: 800 })).toBe(0.2);
    expect(planeFitScale({ width: 1000, height: 4000 }, { width: 1000, height: 800 })).toBe(0.16);
    expect(planeFitScale({ width: 1e9, height: 1e9 }, { width: 1000, height: 800 })).toBe(0.05);
  });

  test('every relative and absolute zoom respects a recomputed floor', () => {
    const { result } = renderHook(() => useMapViewState());
    act(() => result.current.setScaleFloor(0.2));
    act(() => result.current.zoomBy(0.001, { x: 500, y: 400 }));
    expect(result.current.view.scale).toBe(0.2);
    act(() => result.current.zoomTo(0.01));
    expect(result.current.view.scale).toBe(0.2);
    act(() => result.current.setScaleFloor(0.4));
    expect(result.current.view.scale).toBe(0.4);
    act(() => result.current.setScaleFloor(0.1));
    act(() => result.current.zoomBy(0.01));
    expect(result.current.view.scale).toBe(0.1);
  });

  test('restored camera is clamped once extent is known without losing valid pan or zoom access', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_VIEW, scale: 0.06, offsetX: 43, offsetY: 71 }));
    const { result } = renderHook(() => useMapViewState());
    act(() => result.current.setScaleFloor(0.3));
    expect(result.current.view).toMatchObject({ scale: 0.3, offsetX: 43, offsetY: 71 });
    expect(result.current.needsFit()).toBe(false);
    act(() => result.current.zoomBy(2));
    expect(result.current.view.scale).toBe(0.6);
    act(() => result.current.zoomBy(0.01));
    expect(result.current.view.scale).toBe(0.3);
  });
});


describe('archive core scope', () => {
  test('Show archived explicitly includes the archived status in the graph request', async () => {
    const {result}=renderHook(()=>useMapData({includeArchived:true}),{wrapper});
    await waitFor(()=>expect(result.current.isLoading).toBe(false));
    expect(paramOf(requestUrls[0],'includeArchived')).toBe('true');
    expect(paramOf(requestUrls[0],'statuses')?.split(',')).toContain('archived');
  });
  test('an explicit status filter stays authoritative when archived is shown', async () => {
    const {result}=renderHook(()=>useMapData({includeArchived:true,statuses:['stuck']}),{wrapper});
    await waitFor(()=>expect(result.current.isLoading).toBe(false));
    expect(paramOf(requestUrls[0],'statuses')).toBe('stuck');
  });
  test('archive events reconcile into a visible archive scope instead of removing the tile', async () => {
    const {result}=renderHook(()=>useMapData({includeArchived:true}),{wrapper});
    await waitFor(()=>expect(result.current.isLoading).toBe(false));
    const id=result.current.graph.nodes[0].id;
    await wsEvent('task.archived',{id});
    expect(result.current.graph.nodes.some(node=>node.id===id)).toBe(true);
    await waitFor(()=>expect(requestUrls.length).toBeGreaterThan(1),{timeout:2500});
    expect(paramOf(requestUrls.at(-1)!,'statuses')?.split(',')).toContain('archived');
  });
  test('saved Radial selections migrate to Organic', () => {
    sessionStorage.setItem(STORAGE_KEY,JSON.stringify({organization:'radial',scale:1,offsetX:4,offsetY:5}));
    const {result}=renderHook(()=>useMapViewState());
    expect(result.current.view.organization).toBe('organic');
  });
});
