// @vitest-environment jsdom
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, cleanup, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../utils/auth';
import { CharterPage } from './CharterPage';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined, connected: false }),
}));

const mockFetch = vi.mocked(authenticatedFetch);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const CHARTER = {
  id: 'c1', projectId: 'p1', content: '# Authority Index\n\nGoverning docs live here.',
  contentHash: 'h', version: 4, revision: 'rev-4', updatedByPrincipalId: 'owner',
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z',
};

function routeFetch(overrides: Record<string, Response> = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    const path = String(url);
    for (const [suffix, response] of Object.entries(overrides)) {
      if (path.endsWith(suffix)) return response;
    }
    if (path.endsWith('/projects/p1/charter')) return jsonResponse({ success: true, charter: CHARTER });
    if (path.endsWith('/projects/p1')) return jsonResponse({ success: true, project: { id: 'p1', name: 'Fixture' } });
    if (path.endsWith('/charter/versions')) {
      return jsonResponse({ success: true, versions: [
        { version: 4, contentHash: 'h', actorPrincipalId: 'owner', createdAt: '2026-08-09T00:00:00Z' },
        { version: 3, contentHash: 'g', actorPrincipalId: 'owner', createdAt: '2026-08-08T00:00:00Z' },
      ]});
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/charter']}>
      <Routes>
        <Route path="/projects/:id/charter" element={<CharterPage />} />
        <Route path="/projects" element={<div>projects list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(cleanup);

describe('CharterPage', () => {
  test('renders the charter content, version and attribution', async () => {
    routeFetch();
    renderPage();
    await screen.findByRole('heading', { name: 'Authority Index' });
    expect(screen.getByText('Version 4')).toBeInTheDocument();
    expect(screen.getByText(/By owner/)).toBeInTheDocument();
    expect(screen.getByText('Governing docs live here.')).toBeInTheDocument();
  });

  test('an unchartered project explains the object instead of erroring', async () => {
    routeFetch({
      '/projects/p1/charter': jsonResponse({ success: false, code: 'CHARTER_NOT_FOUND', error: 'none' }, false, 404),
    });
    renderPage();
    await screen.findByText('This project has no Charter yet');
    expect(screen.getByText(/authority index/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
  });

  test('the version history opens on demand', async () => {
    routeFetch();
    renderPage();
    await screen.findByRole('heading', { name: 'Authority Index' });
    await userEvent.click(screen.getByRole('button', { name: /Versions/ }));
    await screen.findByText('Version history');
    expect(screen.getByText('v3')).toBeInTheDocument();
  });

  test('stored Charter content cannot execute active HTML (review a2b2f742 F2)', async () => {
    routeFetch({
      '/projects/p1/charter': jsonResponse({ success: true, charter: {
        ...CHARTER,
        content: '# Safe Heading\n\n<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n[bad link](javascript:alert(3))\n\n**benign bold**',
      }}),
    });
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Safe Heading' });
    // Benign Markdown still renders.
    expect(screen.getByText('benign bold')).toBeInTheDocument();
    const html = container.innerHTML;
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });

  test('historical version rendering is sanitized through the same path', async () => {
    routeFetch({
      '/charter/versions/3': jsonResponse({ success: true, version: {
        version: 3, content: '<img src=x onerror="alert(1)"> old text', contentHash: 'g',
        actorPrincipalId: 'owner', createdAt: '2026-08-08T00:00:00Z',
      }}),
    });
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Authority Index' });
    await userEvent.click(screen.getByRole('button', { name: /Versions/ }));
    await userEvent.click(await screen.findByRole('button', { name: /v3/ }));
    await screen.findByText(/old text/);
    expect(container.innerHTML).not.toContain('onerror');
  });

  test('a stale save surfaces the 412 conflict message', async () => {
    routeFetch();
    renderPage();
    await screen.findByRole('heading', { name: 'Authority Index' });

    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'POST') {
        return jsonResponse({ success: false, code: 'REVISION_MISMATCH' }, false, 412);
      }
      if (path.endsWith('/projects/p1/charter')) return jsonResponse({ success: true, charter: CHARTER });
      if (path.endsWith('/projects/p1')) return jsonResponse({ success: true, project: { id: 'p1', name: 'Fixture' } });
      throw new Error(`unexpected fetch: ${path}`);
    });

    await userEvent.click(screen.getByRole('button', { name: /Edit/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve Charter' }));
    await screen.findByText(/changed since it was loaded/);
  });
});

test('approval sends the human approval action with observed revision and no privilege fields', async () => {
  routeFetch();
  renderPage();
  await screen.findByRole('heading', { name: 'Authority Index' });
  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return jsonResponse({ success: false }, false, 403);
    return jsonResponse({ success: true, charter: CHARTER });
  });
  await userEvent.click(screen.getByRole('button', { name: /Edit/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Approve Charter' }));
  await screen.findByText(/Sign in as this project’s owner/);
  expect(mockFetch).toHaveBeenCalledWith(expect.stringMatching(/\/projects\/p1\/charter\/approve$/), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': CHARTER.revision },
    body: JSON.stringify({ content: CHARTER.content }),
  });
});

test('a stale successful Charter response cannot restore content after a later access denial', async () => {
  routeFetch();
  renderPage();
  await screen.findByText('Governing docs live here.');
  let resolveOld!: (value: Response) => void;
  let charterCalls = 0;
  mockFetch.mockImplementation(async url => {
    if (String(url).endsWith('/charter')) {
      charterCalls++;
      if (charterCalls === 1) return new Promise<Response>(resolve => { resolveOld = resolve; });
      return jsonResponse({ success: false, code: 'RESOURCE_NOT_FOUND' }, false, 404);
    }
    return jsonResponse({ success: true, project: { id: 'p1', name: 'Fixture' } });
  });
  act(() => window.dispatchEvent(new Event('focus')));
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(charterCalls).toBe(2));
  await waitFor(() => expect(screen.queryByText('Governing docs live here.')).not.toBeInTheDocument());
  await act(async () => { resolveOld(jsonResponse({ success: true, charter: CHARTER })); });
  expect(screen.queryByText('Governing docs live here.')).not.toBeInTheDocument();
});

// LENSES-c gate (i) (card b5c83682): an owner of the Group that owns the
// project is asked for a step-up by the board's challenge, confirms once, and
// the approval is sent ONE more time with the token; administrators and person
// owners are never asked (the test above sends no token).
test('a Group owner answers the Charter step-up challenge once, and the approval is resent with the token', async () => {
  routeFetch();
  renderPage();
  await screen.findByRole('heading', { name: 'Authority Index' });
  const approvals: unknown[] = [];
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/auth/step-up/methods')) return jsonResponse({ success: true, methods: ['password'], preferred: 'password' });
    if (path.endsWith('/auth/step-up')) return jsonResponse({ success: true, stepUpToken: 'rhsu_charter_token' });
    if (init?.method === 'POST' && path.endsWith('/charter/approve')) {
      const body = JSON.parse(String(init.body));
      approvals.push(body);
      if (!body.stepUpToken) {
        return jsonResponse({
          success: false, code: 'STEP_UP_REQUIRED', message: 'This act requires a live single-use step-up token',
          stepUp: { error: 'insufficient_user_authentication', action: 'charter.approve', targetId: 'p1', max_age: 0, methods: ['password'] },
        }, false, 403);
      }
      return jsonResponse({ success: true, charter: { ...CHARTER, version: 5 }, created: false, changed: true });
    }
    if (path.endsWith('/projects/p1/charter')) return jsonResponse({ success: true, charter: CHARTER });
    return jsonResponse({ success: true, project: { id: 'p1', name: 'Fixture' } });
  });
  await userEvent.click(screen.getByRole('button', { name: /Edit/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Approve Charter' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(await within(dialog).findByLabelText('Password'), 'test-password');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(approvals).toHaveLength(2));
  expect(approvals).toEqual([{ content: CHARTER.content }, { content: CHARTER.content, stepUpToken: 'rhsu_charter_token' }]);
});
