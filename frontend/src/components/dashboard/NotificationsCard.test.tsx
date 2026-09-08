/*
 * NotificationsCard — RH-P3.C8: the §2.12 human notification surface.
 * The card renders exactly what the recipient-addressed, grant-filtered
 * backend read model returned: exception notices with honest coarse labels,
 * status changes, mark-as-read flows, and the empty state.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NotificationsCard } from './NotificationsCard';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const jsonResponse = (payload: unknown) => ({
  ok: true,
  json: async () => payload,
});

const NOTIFICATIONS = [
  {
    id: 'n1', taskId: 't1', taskTitle: 'Stuck fixture task', event: 'exception',
    from: 'in-progress', to: 'in-progress', timestamp: new Date().toISOString(),
    read: false, exception: { name: 'task.stuck', reason: 'status_stale' },
  },
  {
    id: 'n2', taskId: 't2', taskTitle: 'Moved fixture task', event: 'status_changed',
    from: 'todo', to: 'in-progress', timestamp: new Date().toISOString(), read: false,
  },
];

const renderCard = () => render(<MemoryRouter><NotificationsCard /></MemoryRouter>);

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('NotificationsCard', () => {
  it('renders the exception notice with its honest coarse label and the status change', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, notifications: NOTIFICATIONS }));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Task stuck — no activity for a while')).toBeInTheDocument();
    });
    expect(screen.getByText('Stuck fixture task')).toBeInTheDocument();
    expect(screen.getByText('Status changed: todo → in-progress')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain('/tasks/notifications?unread=true');
  });

  it('marks one notification read and drops it from the list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, notifications: NOTIFICATIONS }));
    renderCard();
    await waitFor(() => {
      expect(screen.getByLabelText('Mark read: Stuck fixture task')).toBeInTheDocument();
    });
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await userEvent.click(screen.getByLabelText('Mark read: Stuck fixture task'));
    await waitFor(() => {
      expect(screen.queryByText('Stuck fixture task')).not.toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.some(([url, init]: any[]) =>
      String(url).includes('/tasks/notifications/n1/read') && init?.method === 'POST')).toBe(true);
  });

  it('mark all read empties the surface', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, notifications: NOTIFICATIONS }));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Mark all read')).toBeInTheDocument();
    });
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await userEvent.click(screen.getByText('Mark all read'));
    await waitFor(() => {
      expect(screen.getByText('No unread notifications.')).toBeInTheDocument();
    });
  });

  it('shows the empty state when the filtered read model returns nothing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, notifications: [] }));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('No unread notifications.')).toBeInTheDocument();
    });
  });
});
