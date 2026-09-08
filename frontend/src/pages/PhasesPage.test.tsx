// @vitest-environment jsdom
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../utils/auth';
import { PhasesPage } from './PhasesPage';

vi.mock('../hooks/usePrincipals', () => ({ useMyPrincipal: () => ({ scopes: ['blueprints:write'] }) }));

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const mockFetch = vi.mocked(authenticatedFetch);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const PHASES = [
  {
    id: 'ph-1', projectId: 'p1', name: 'Substrate', goal: 'Get the substrate into target shape',
    status: 'in-progress', position: 0, revision: 'rev-1',
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  },
  {
    id: 'ph-2', projectId: 'p1', name: 'Falsification gate', goal: null,
    status: 'todo', position: 0, revision: 'rev-2',
    createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z',
  },
];

function routeFetch(overrides: Record<string, Response> = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    const path = String(url);
    for (const [suffix, response] of Object.entries(overrides)) {
      if (path.endsWith(suffix)) return response;
    }
    if (path.includes('/projects/p1/phases')) return jsonResponse({ success: true, phases: PHASES });
    if (path.endsWith('/projects/p1')) return jsonResponse({ success: true, project: { id: 'p1', name: 'Fixture' } });
    throw new Error(`unexpected fetch: ${path}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/phases']}>
      <Routes>
        <Route path="/projects/:id/phases" element={<PhasesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(cleanup);

describe('PhasesPage', () => {
  test('lists a project\'s phases with their goals', async () => {
    routeFetch();
    renderPage();
    expect(await screen.findByText('Substrate')).toBeInTheDocument();
    expect(screen.getByText('Get the substrate into target shape')).toBeInTheDocument();
    // Two phases share position 0: overlapping phases are legal, and the page
    // must render both rather than treating position as a unique key.
    expect(screen.getByText('Falsification gate')).toBeInTheDocument();
  });

  test('empty state explains the backlog rather than reading as an error', async () => {
    routeFetch({ '/phases': jsonResponse({ success: true, phases: [] }) });
    renderPage();
    expect(await screen.findByText('This project has no phases yet')).toBeInTheDocument();
  });

  test('the archived toggle asks the server for archived rows', async () => {
    routeFetch();
    renderPage();
    await screen.findByText('Substrate');
    await userEvent.click(screen.getByLabelText(/Show archived/i));
    await waitFor(() => {
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes('includeArchived=true'))).toBe(true);
    });
  });

  test('create sends the phase under the URL project', async () => {
    routeFetch();
    renderPage();
    await screen.findByText('Substrate');
    await userEvent.click(screen.getByRole('button', { name: /New phase/i }));
    await userEvent.type(screen.getByLabelText('Name'), 'Enforcement');
    await userEvent.type(screen.getByLabelText('Phase goal'), 'One predicate, no bypasses');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const post = mockFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body).toMatchObject({ projectId: 'p1', name: 'Enforcement', goal: 'One predicate, no bypasses' });
    });
  });

  test('an emptied goal is sent as null, not as an empty string', async () => {
    routeFetch();
    renderPage();
    await screen.findByText('Substrate');
    await userEvent.click(screen.getAllByRole('button', { name: /Edit/i })[0]);
    await userEvent.clear(screen.getByLabelText('Phase goal'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = mockFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String((patch![1] as RequestInit).body));
      expect(body.goal).toBeNull();
      // The revision is the If-Match guard and must ride the update.
      expect(body.revision).toBe('rev-1');
    });
  });

  test('the archive verb carries the phase revision', async () => {
    routeFetch();
    renderPage();
    await screen.findByText('Substrate');
    await userEvent.click(screen.getAllByRole('button', { name: /Archive/i })[0]);
    await waitFor(() => {
      const call = mockFetch.mock.calls.find(([url]) => String(url).endsWith('/phases/ph-1/archive'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body)).revision).toBe('rev-1');
    });
  });

  test('delete is confirmation-gated and calls DELETE (review da10a59a F2)', async () => {
    routeFetch({ '/phases/ph-1': jsonResponse({ success: true, phase: PHASES[0] }) });
    renderPage();
    await screen.findByText('Substrate');
    await userEvent.click(screen.getAllByRole('button', { name: /Delete/i })[0]);
    // Nothing is sent on the first click: the confirmation is the gate.
    expect(mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
    expect(screen.getByText('Delete permanently?')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Yes, delete/i }));
    await waitFor(() => {
      const call = mockFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
      expect(call).toBeTruthy();
      expect(String(call![0])).toContain('/phases/ph-1');
    });
  });

  test('a 409 PHASE_IN_USE is surfaced and the phase stays in the list', async () => {
    routeFetch({
      '/phases/ph-1': jsonResponse(
        { success: false, code: 'PHASE_IN_USE', message: 'Phase still holds 2 task(s); move or unphase them first, or archive the Phase instead' },
        false, 409,
      ),
    });
    renderPage();
    await screen.findByText('Substrate');
    await userEvent.click(screen.getAllByRole('button', { name: /Delete/i })[0]);
    await userEvent.click(screen.getByRole('button', { name: /Yes, delete/i }));

    expect(await screen.findByText(/still holds 2 task/i)).toBeInTheDocument();
    // The row must survive a refusal: the page may never imply a deletion
    // that did not happen.
    expect(screen.getByText('Substrate')).toBeInTheDocument();
  });

  test('a delete refused for want of phases:admin points at archive instead', async () => {
    routeFetch({
      '/phases/ph-1': jsonResponse({ success: false, error: 'Forbidden' }, false, 403),
    });
    renderPage();
    await screen.findByText('Substrate');
    await userEvent.click(screen.getAllByRole('button', { name: /Delete/i })[0]);
    await userEvent.click(screen.getByRole('button', { name: /Yes, delete/i }));
    expect(await screen.findByText(/requires phases:admin/i)).toBeInTheDocument();
    expect(screen.getByText('Substrate')).toBeInTheDocument();
  });

  test('a brief refused for want of tasks:read says so instead of failing silently', async () => {
    routeFetch({
      '/phases/ph-1/brief': jsonResponse({ success: false, code: 'BRIEF_TASKS_READ_REQUIRED' }, false, 403),
    });
    renderPage();
    await screen.findByText('Substrate');
    await userEvent.click(screen.getAllByRole('button', { name: /Copy brief/i })[0]);
    expect(await screen.findByText(/also requires tasks:read/i)).toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
