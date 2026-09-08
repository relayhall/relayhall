// @vitest-environment jsdom
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../utils/auth';
import { PersonalityDetailPage } from './PersonalityDetailPage';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const mockFetch = vi.mocked(authenticatedFetch);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function detailResponse(source: string) {
  return jsonResponse({
    success: true,
    personality: {
      id: 'p1', slug: 'sample', name: 'Sample', description: 'A sample personality',
      category: 'core', color: 'blue', content: '# Mission\nDo the work well.',
      source_file: null, is_custom: false, source,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
    linkedSessions: [],
    linkedTasks: [],
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/personalities/p1']}>
      <Routes>
        <Route path="/personalities/:id" element={<PersonalityDetailPage />} />
        <Route path="/personalities" element={<div>list page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(cleanup);

describe('PersonalityDetailPage', () => {
  test('a built-in personality shows a read-only badge and no Edit/Retire actions', async () => {
    mockFetch.mockResolvedValue(detailResponse('built-in'));
    renderPage();
    await screen.findByRole('heading', { name: 'Sample' });
    expect(screen.getByText('built-in · read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retire/ })).not.toBeInTheDocument();
  });

  test('an imported personality is labelled read-only too', async () => {
    mockFetch.mockResolvedValue(detailResponse('git'));
    renderPage();
    await screen.findByRole('heading', { name: 'Sample' });
    expect(screen.getByText('imported · read-only')).toBeInTheDocument();
  });

  test('a managed personality offers Edit and Retire, and save disables while in flight', async () => {
    mockFetch.mockResolvedValue(detailResponse('managed'));
    renderPage();
    await screen.findByRole('heading', { name: 'Sample' });
    expect(screen.queryByText(/read-only/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Edit/ }));
    const nameInput = screen.getByLabelText('Name');
    expect(nameInput).toBeRequired();

    let resolveSave: (value: Response) => void = () => {};
    mockFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveSave = resolve; }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const busy = await screen.findByRole('button', { name: 'Saving…' });
    expect(busy).toBeDisabled();

    resolveSave(jsonResponse({ success: true, personality: { name: 'Sample' } }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument();
    });
  });

  test('retire is confirmed through the house modal and sends DELETE on confirm', async () => {
    mockFetch.mockResolvedValue(detailResponse('managed'));
    renderPage();
    await screen.findByRole('heading', { name: 'Sample' });

    await userEvent.click(screen.getByRole('button', { name: /Retire/ }));
    expect(await screen.findByText('Retire Sample?')).toBeInTheDocument();
    expect(mockFetch.mock.calls.every(([, init]) => !init || (init as RequestInit).method !== 'DELETE')).toBe(true);

    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    // The modal's confirm button carries the confirmLabel.
    const dialogButtons = screen.getAllByRole('button', { name: 'Retire' });
    await userEvent.click(dialogButtons[dialogButtons.length - 1]);

    await waitFor(() => {
      const deleteCall = mockFetch.mock.calls.find(([, init]) => init && (init as RequestInit).method === 'DELETE');
      expect(deleteCall).toBeTruthy();
    });
    expect(await screen.findByText('list page')).toBeInTheDocument();
  });

  test('a load failure keeps the back navigation visible', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: false, error: 'Not found' }, false, 404));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found');
    expect(screen.getByRole('button', { name: /Personalities/ })).toBeInTheDocument();
  });
});
