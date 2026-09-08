// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';

const authenticatedFetch = vi.fn();
const dashboardCss = readFileSync(resolve(process.cwd(), 'src/pages/DashboardPage.css'), 'utf8');
const legacyResponsiveCss = readFileSync(resolve(process.cwd(), 'src/styles/responsive-phase3.css'), 'utf8');
vi.mock('../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args) }));
vi.mock('../components/dashboard/HeroCard', () => ({ HeroCard: () => null }));
vi.mock('../components/dashboard/ActiveWorkPreview', () => ({ ActiveWorkPreview: () => null }));
vi.mock('../components/dashboard/ActivityFeed', () => ({ ActivityFeed: () => null }));
vi.mock('../components/dashboard/ProjectOverview', () => ({ ProjectOverview: () => null }));
vi.mock('../components/dashboard/SystemStatus', () => ({ SystemStatus: () => null }));
vi.mock('../components/dashboard/ReportsCard', () => ({ ReportsCard: () => null }));
vi.mock('../components/dashboard/NotificationsCard', () => ({ NotificationsCard: () => null }));
// Card 653be44f. Stubbed like every other child card, and for the same reason:
// this suite pins the PAGE'S OWN summary fallback, and the call count below is
// evidence only while the page's children are not reading on their own behalf.
// The day-one card has its own suite (components/dashboard/ConnectAgentCard.test.tsx).
vi.mock('../components/dashboard/ConnectAgentCard', () => ({ ConnectAgentCard: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  authenticatedFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      success: true,
      summary: { ideas: 1, todo: 2, inProgress: 3, review: 4, stuck: 5, completed: 6, archived: 7, recentCompleted: 2 },
    }),
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DashboardPage lifecycle summary', () => {
  test('renders seven ordered cards and never folds Review into Stuck', async () => {
    const { container } = render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    await screen.findByRole('link', { name: /Review 4 awaiting verification/i });
    expect(screen.getByRole('link', { name: /Stuck 5 needs attention/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review 4/i })).toHaveAttribute('href', '/tasks?focus=review');
    const lifecycleGrid = container.querySelector('.dashboard-page-dashboard-stats-grid');
    expect(lifecycleGrid).toBeInTheDocument();
    expect(lifecycleGrid).not.toHaveClass('dashboard-stats-grid');
    const labels = Array.from(container.querySelectorAll('.stats-card-label')).map(node => node.textContent);
    expect(labels).toEqual(['Ideas', 'Todo', 'Progress', 'Review', 'Stuck', 'Completed', 'Archived']);
    expect(container.querySelector('.stats-card-yellow')).toBeInTheDocument();
  });

  test('falls back to task rows and counts review separately', async () => {
    authenticatedFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true, tasks: [
        { id: 'r1', status: 'review' }, { id: 'r2', status: 'review' }, { id: 's1', status: 'stuck' },
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true, tasks: [] }) });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: /Review 2 awaiting verification/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Stuck 1 needs attention/i })).toBeInTheDocument();
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(3));
  });

  test('keeps the page-owned mobile grid out of the legacy six-column stylesheet', () => {
    expect(dashboardCss).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*?\.dashboard-page-dashboard-stats-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,/);
    expect(legacyResponsiveCss).not.toContain('.dashboard-page-dashboard-stats-grid');
  });
});
