// @vitest-environment jsdom
//
// Released browser state across the E386 boundary. The CAMERA (the tab's view
// state) still survives a reload exactly as released; the LAYOUT RECORD does
// not: owner ruling E386 says no layout geometry is kept across reloads, so
// every record a released Map stored is removed on load without being read,
// and the plane is laid out from the data alone.
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import recorded from './__fixtures__/legacy-continuity.json';
import type { MapGraph, MapOrganization } from './mapGraphModel';
import { EMPTY_PLANE_ANCHORS, clearStoredPlaneAnchors, layoutContinuousPlane } from './mapPlaneModel';
import { readPersistedView, useMapViewState } from './useMapViewState';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const homes = (layout: ReturnType<typeof layoutContinuousPlane>) => Object.fromEntries(
  layout.elements.filter(e => e.kind === 'container').map(e => [e.id, { x: e.x, y: e.y }]));
const focal = (view: NonNullable<ReturnType<typeof readPersistedView>>) =>
  ({ x: (320 - view.offsetX) / view.scale, y: (240 - view.offsetY) / view.scale });

test.each(recorded)('$ref $org released camera survives; the released layout record is removed unread (E386)', f => {
  for (const [key, value] of Object.entries(f.storage)) localStorage.setItem(key, value);
  for (const [key, value] of Object.entries(f.session)) sessionStorage.setItem(key, value);
  localStorage.setItem('relayhall_unrelated', 'kept');
  const graph = f.graph as MapGraph, organization = f.org as MapOrganization;
  const expectedView = f.view as NonNullable<ReturnType<typeof readPersistedView>>;

  const reads = vi.spyOn(Storage.prototype, 'getItem');
  expect(clearStoredPlaneAnchors()).toBe(Object.keys(f.storage).length);
  expect(reads.mock.calls.filter(([key]) => String(key).startsWith('relayhall_map_plane_anchors'))).toEqual([]);
  reads.mockRestore();
  for (const key of Object.keys(f.storage)) expect(localStorage.getItem(key)).toBeNull();
  expect(localStorage.getItem('relayhall_unrelated')).toBe('kept');
  // A second load finds nothing left to remove.
  expect(clearStoredPlaneAnchors()).toBe(0);

  // The camera is the tab's view state, not layout geometry: it is restored.
  const hook = renderHook(() => useMapViewState());
  expect(hook.result.current.needsFit()).toBe(false);
  expect(hook.result.current.view).toEqual(expectedView);
  expect(focal(hook.result.current.view)).toEqual(focal(expectedView));
  for (const [key, value] of Object.entries(f.session)) expect(sessionStorage.getItem(key)).toBe(value);
  hook.unmount();

  // The plane comes from the data alone: every project has a home, and the
  // same data lays out the same world on every load.
  const fresh = layoutContinuousPlane(graph, {}, organization, EMPTY_PLANE_ANCHORS);
  expect(Object.keys(homes(fresh))).toHaveLength(Object.keys(f.homes).length);
  expect(layoutContinuousPlane(graph, {}, organization, EMPTY_PLANE_ANCHORS)).toEqual(fresh);
});

test.each(['', '{bad'])('present v2 camera remains authoritative: %s', current => {
  sessionStorage.setItem('relayhall_map_view', Object.values(recorded[0].session)[0]);
  sessionStorage.setItem('relayhall_map_view_v2', current);
  expect(readPersistedView()).toBeNull();
});
test('valid v2 camera wins over the released one', () => {
  sessionStorage.setItem('relayhall_map_view', Object.values(recorded[0].session)[0]);
  sessionStorage.setItem('relayhall_map_view_v2', JSON.stringify({ ...recorded[0].view, offsetX: 999 }));
  expect(readPersistedView()?.offsetX).toBe(999);
});
test('every organization\'s record, current and legacy, is removed and nothing else is', () => {
  const keys = ['relayhall_map_plane_anchors', 'relayhall_map_plane_anchors:vertical',
    'relayhall_map_plane_anchors:organic', 'relayhall_map_plane_anchors_v2',
    'relayhall_map_plane_anchors_v2:vertical', 'relayhall_map_plane_anchors_v2:organic',
    'relayhall_map_plane_anchors_v2:radial'];
  for (const key of keys) localStorage.setItem(key, '{bad');
  // Look-alikes that are not layout records stay.
  for (const key of ['relayhall_map_plane_anchors_v3', 'relayhall_map_plane_anchorsX', 'relayhall_map_view_v2']) {
    localStorage.setItem(key, 'kept');
  }
  expect(clearStoredPlaneAnchors()).toBe(keys.length);
  for (const key of keys) expect(localStorage.getItem(key)).toBeNull();
  for (const key of ['relayhall_map_plane_anchors_v3', 'relayhall_map_plane_anchorsX', 'relayhall_map_view_v2']) {
    expect(localStorage.getItem(key)).toBe('kept');
  }
});
// The layout-record parser went with the record (E386): nothing reads one.
test('a malformed legacy camera is refused', () => {
  sessionStorage.setItem('relayhall_map_view', '{bad');
  expect(readPersistedView()).toBeNull();
});
test('storage access errors stay contained including hook mount', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  vi.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw new Error('storage unavailable'); });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  expect(clearStoredPlaneAnchors()).toBe(0);
  expect(readPersistedView()).toBeNull();
  const hook = renderHook(() => useMapViewState());
  expect(hook.result.current.needsFit()).toBe(true);
});
