// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../utils/auth';
import { PersonalitiesPage } from './PersonalitiesPage';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const mockFetch = vi.mocked(authenticatedFetch);

const personalities = [
  { id: 'a1', slug: 'generalist', name: 'Generalist', description: 'Default profile', category: 'core', color: 'blue', is_custom: false, source: 'built-in' },
  { id: 'a2', slug: 'backend-architect', name: 'Backend Architect', description: 'Designs services', category: 'custom', color: 'green', is_custom: true, source: 'managed' },
];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function mockListResponse() {
  return jsonResponse({ success: true, personalities, categories: ['core', 'custom'] });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PersonalitiesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mockFetch.mockResolvedValue(mockListResponse());
});

afterEach(cleanup);

describe('PersonalitiesPage', () => {
  test('renders the registry grouped by category after fetch', async () => {
    renderPage();
    expect(await screen.findByText('Generalist')).toBeInTheDocument();
    expect(screen.getByText('Backend Architect')).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(expect.stringMatching(/\/personalities$/));
  });

  test('category filter refetches with the category query parameter', async () => {
    renderPage();
    await screen.findByText('Generalist');
    const select = screen.getByLabelText('Filter by category');
    await userEvent.selectOptions(select, 'core');
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/personalities?category=core'));
    });
  });

  test('search filters client-side and the no-match state offers clearing filters', async () => {
    renderPage();
    await screen.findByText('Generalist');
    await userEvent.type(screen.getByLabelText('Search personalities'), 'zzz-no-such');
    expect(screen.getByText('No personalities match the current filters')).toBeInTheDocument();
    // The registry is not empty, so the create call-to-action is not the empty-state one.
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Generalist')).toBeInTheDocument();
  });

  test('create submits the draft and disables the submit button while in flight', async () => {
    let resolveCreate: (value: Response) => void = () => {};
    renderPage();
    await screen.findByText('Generalist');

    await userEvent.click(screen.getByRole('button', { name: /New personality/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'QA Analyst');
    await userEvent.type(screen.getByLabelText('Slug'), 'qa-analyst');

    mockFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveCreate = resolve; }));
    await userEvent.click(screen.getByRole('button', { name: 'Create personality' }));

    const busy = await screen.findByRole('button', { name: 'Creating…' });
    expect(busy).toBeDisabled();

    // Settle: creation succeeds and the list refetches.
    mockFetch.mockResolvedValue(mockListResponse());
    resolveCreate(jsonResponse({ success: true, personality: { id: 'a3' } }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Creating…' })).not.toBeInTheDocument();
    });

    const createCall = mockFetch.mock.calls.find(([, init]) => init && (init as RequestInit).method === 'POST');
    expect(createCall).toBeTruthy();
    const body = JSON.parse(String((createCall![1] as RequestInit).body));
    expect(body).toMatchObject({ name: 'QA Analyst', slug: 'qa-analyst' });
  });

  test('a create failure renders inside the form, not the page banner', async () => {
    renderPage();
    await screen.findByText('Generalist');
    await userEvent.click(screen.getByRole('button', { name: /New personality/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'Dup');
    await userEvent.type(screen.getByLabelText('Slug'), 'generalist');
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: false, error: 'A personality with this slug already exists' }, false, 409));
    await userEvent.click(screen.getByRole('button', { name: 'Create personality' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A personality with this slug already exists');
    expect(alert.closest('form')).not.toBeNull();
  });

  test('the color field is a closed select over the ratified palette', async () => {
    renderPage();
    await screen.findByText('Generalist');
    await userEvent.click(screen.getByRole('button', { name: /New personality/ }));
    const colorSelect = screen.getByLabelText('Color');
    expect(colorSelect.tagName).toBe('SELECT');
    const values = Array.from(colorSelect.querySelectorAll('option')).map(o => o.getAttribute('value'));
    expect(values).toContain('blue');
    expect(values).toContain('gray');
  });
});
