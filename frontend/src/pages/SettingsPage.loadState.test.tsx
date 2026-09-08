// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { SettingsIndexRedirect, SettingsPage } from './SettingsPage';
import { settingsChildRoutes } from '../config/settingsRoutes';
import { settingsNavEntries } from '../config/settingsNavigation';
import { useMyPrincipal } from '../hooks/usePrincipals';
import { authenticatedFetch } from '../utils/auth';
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
const fetch = vi.mocked(authenticatedFetch);
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const surfaces = settingsNavEntries.flatMap(e => e.surfaceKey ? [{ key: e.surfaceKey, visible: true }] : []);
const answer = { principal: { id: 'account', role: 'admin' }, scopes: ['root'], delegableScopes: ['tasks:read'], settingsSurfaces: surfaces };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function shell(path = '/settings') {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/settings" element={<SettingsPage />}>
    <Route index element={<SettingsIndexRedirect />} />
    {settingsChildRoutes(entry => <div>{entry.label} protected content</div>)}
  </Route></Routes></MemoryRouter>);
}
function closed() {
  expect(screen.queryByRole('navigation', { name: 'Settings sections' })).not.toBeInTheDocument();
  expect(screen.queryByText(/protected content/)).not.toBeInTheDocument();
}
test.each(['429', '503', 'network', 'invalid-json'])('%s failure stays closed and Retry recovers from the server answer', async kind => {
  if (kind === 'network') fetch.mockRejectedValueOnce(new Error('offline'));
  else if (kind === 'invalid-json') fetch.mockResolvedValueOnce(new Response('{', { status: 200 }));
  else fetch.mockResolvedValueOnce(response({}, Number(kind)));
  let resolve!: (value: Response) => void;
  fetch.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  shell();
  expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be loaded');
  closed();
  expect(screen.queryByText(/no settings to administer/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.getByRole('status')).toHaveTextContent('Loading settings');
  closed();
  await act(async () => { resolve(response(answer)); });
  expect(await screen.findByText('Preferences protected content')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('documented 404 remains a valid unresolved identity without error Retry', async () => {
  fetch.mockResolvedValue(response({}, 404)); shell();
  expect(await screen.findByRole('alert')).toHaveTextContent('no settings to administer');
  closed(); expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
});
test('present concealed capabilities stay concealed and retain the existing self connection landing', async () => {
  fetch.mockResolvedValue(response({ ...answer, scopes: [], settingsSurfaces: surfaces.map(s => ({ ...s, visible: false })) })); shell();
  expect(await screen.findByText('My connections protected content')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Appearance/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('index uses the parent answer exactly once and absent context does not invent an audience', async () => {
  fetch.mockResolvedValueOnce(response(answer)); shell();
  expect(await screen.findByText('Preferences protected content')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  cleanup(); fetch.mockClear();
  render(<MemoryRouter><SettingsIndexRedirect /></MemoryRouter>);
  expect(fetch).not.toHaveBeenCalled();
});
test.each([404, 503])('refresh clears all authority fields before %s and rejects duplicate pending reload', async status => {
  fetch.mockResolvedValueOnce(response(answer));
  const { result } = renderHook(() => useMyPrincipal());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.me?.id).toBe('account');
  let resolve!: (value: Response) => void;
  fetch.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  act(() => result.current.reload());
  act(() => result.current.reload());
  expect(result.current).toMatchObject({ me: null, scopes: undefined, delegableScopes: undefined, settingsSurfaces: undefined, loading: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { resolve(response({}, status)); });
  expect(result.current).toMatchObject({ me: null, scopes: undefined, delegableScopes: undefined, settingsSurfaces: undefined, loading: false, failed: status !== 404 });
});
test('older server omission preserves null fields while explicit empty arrays remain empty', async () => {
  fetch.mockResolvedValueOnce(response({ principal: answer.principal }));
  const { result } = renderHook(() => useMyPrincipal());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current).toMatchObject({ scopes: null, delegableScopes: null, settingsSurfaces: null, failed: false });
  fetch.mockResolvedValueOnce(response({ principal: answer.principal, scopes: [], delegableScopes: [], settingsSurfaces: [] }));
  act(() => result.current.reload());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current).toMatchObject({ scopes: [], delegableScopes: [], settingsSurfaces: [], failed: false });
});
test('completion after unmount cannot replace a separately mounted current principal', async () => {
  let resolve!: (value: Response) => void;
  fetch.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  const old = renderHook(() => useMyPrincipal()); old.unmount();
  fetch.mockResolvedValueOnce(response({}, 503));
  const current = renderHook(() => useMyPrincipal());
  await waitFor(() => expect(current.result.current.failed).toBe(true));
  await act(async () => { resolve(response(answer)); });
  expect(current.result.current).toMatchObject({ me: null, failed: true });
});
