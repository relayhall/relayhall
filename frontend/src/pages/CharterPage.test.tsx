// @vitest-environment jsdom
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../utils/auth';
import { CharterPage } from './CharterPage';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

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
      if (init?.method === 'PUT') {
        return jsonResponse({ success: false, code: 'REVISION_MISMATCH' }, false, 412);
      }
      if (path.endsWith('/projects/p1/charter')) return jsonResponse({ success: true, charter: CHARTER });
      if (path.endsWith('/projects/p1')) return jsonResponse({ success: true, project: { id: 'p1', name: 'Fixture' } });
      throw new Error(`unexpected fetch: ${path}`);
    });

    await userEvent.click(screen.getByRole('button', { name: /Edit/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/changed since it was loaded/);
  });
});
