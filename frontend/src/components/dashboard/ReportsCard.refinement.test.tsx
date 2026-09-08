// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../../utils/auth';
import { ReportsCard } from './ReportsCard';
vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
test('reports a failed load, retries it and exposes native report links', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ reports: [{ id: 'report-1', title: 'Readable report', tags: [], created_at: '2026-01-01T00:00:00Z' }] }), { status: 200 }));
  const user = userEvent.setup(); render(<MemoryRouter><ReportsCard /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Reports could not be loaded');
  expect(screen.queryByText('No reports yet')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('link', { name: /Readable report/ })).toHaveAttribute('href', '/reports/report-1');
  expect(screen.getByRole('link', { name: 'View all Reports' })).toHaveAttribute('href', '/reports');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
