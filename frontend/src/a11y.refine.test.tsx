// @vitest-environment jsdom
/**
 * Structural a11y controls for the surfaces walkthrough 023006d0 items R7,
 * R8, R14 and R15 repaired: Home's Currently-working-on widget, the Project,
 * Skill and Report cards, the Skills grid, the Accounts table and the Report
 * detail page's navigation.
 *
 * Each case renders the REAL component tree over a POPULATED fixture. An
 * empty list renders no cards, and a heading-order assertion over no headings
 * is green for the wrong reason -- so every fixture below carries at least two
 * rows, and each test asserts the rendered levels as well as running axe.
 *
 * HONEST SCOPE, inherited from a11y.smoke.test.tsx: jsdom has no layout
 * engine, so axe's colour-contrast rule cannot run here and R7 is NOT covered
 * by this file. R7 is enforced mechanically per Theme by
 * scripts/check-design-contrast.py against the declared pairing matrix, and
 * measured live by the axe walk recorded in qa/a51e5a81-<sha>/.
 */
import axe from 'axe-core';
import { cleanup, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ProjectCard } from './components/projects/ProjectCard';
import { ActiveWorkPreview } from './components/dashboard/ActiveWorkPreview';
import { SkillsPage } from './pages/SkillsPage';
import { PrincipalsPage } from './pages/PrincipalsPage';
import { ReportDetailPage } from './pages/ReportDetailPage';
import type { Project } from './types/project';
import type { Skill } from './types/skill';

const projects: Project[] = [1, 2].map((n) => ({
  id: `project-${n}`,
  name: `Helios Platform Migration ${n}`,
  description: 'Move the estate off the retired kiosk fleet.',
  status: 'active',
  revision: 'rev-1',
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-02T10:00:00.000Z',
  stats: {
    total_tasks: 12, completed_tasks: 4, in_progress_tasks: 3,
    active_agents: 2, last_activity: '2026-09-02T10:00:00.000Z',
  },
}));

const skills: Skill[] = [1, 2].map((n) => ({
  id: `skill-${n}`,
  name: `Terraform review ${n}`,
  is_global: true,
  current_published_version_id: `version-${n}`,
  revision: 'rev-1',
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-02T10:00:00.000Z',
  current_version: null,
  published_version: null,
  version: 3,
  status: 'published',
  category: 'infrastructure',
  description: 'Review a Terraform plan before it is applied.',
  tags: ['infra', 'review'],
  config: {},
  provenance: 'human-authored',
  content_sha256: 'a'.repeat(64),
}));

const principals = [1, 2].map((n) => ({
  id: `principal-${n}`,
  kind: 'agent' as const,
  handle: `agent-${n}`,
  displayName: `Agent ${n}`,
  status: 'active' as const,
  role: 'agent',
  harness: 'claude-code',
  lastSeenAt: '2026-09-02T10:00:00.000Z',
  provenance: 'managed' as const,
}));

const activeTasks = [1, 2].map((n) => ({
  id: `task-${n}`,
  title: `Renew the wildcard certificate ${n}`,
  description: '',
  status: 'in-progress',
  priority: n === 1 ? 'urgent' : 'normal',
  project: 'Helios Platform Migration',
  updated_at: '2026-09-02T10:00:00.000Z',
  created_at: '2026-09-01T10:00:00.000Z',
  subtasks: [
    { id: `sub-${n}-1`, title: 'Rotate the key', status: 'completed', completed: true },
    { id: `sub-${n}-2`, title: 'Reissue', status: 'todo', completed: false },
    { id: `sub-${n}-3`, title: 'Redeploy', status: 'todo', completed: false },
    { id: `sub-${n}-4`, title: 'Verify the chain', status: 'todo', completed: false },
  ],
}));

const report = {
  id: 'report-1',
  title: 'Quarterly platform review',
  content: '# Findings\n\nThe estate is healthy.',
  summary: 'The estate is healthy.',
  tags: ['review'],
  pinned: false,
  created_at: '2026-09-02T10:00:00.000Z',
  updated_at: '2026-09-02T10:00:00.000Z',
  task_ids: [],
};

vi.mock('./utils/auth', () => ({
  auth: { isAuthenticated: () => true, getToken: () => 'token', logout: vi.fn(), usedBreakGlass: () => false },
  authenticatedFetch: vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('/skills')) return ok({ success: true, skills });
    if (url.includes('/principals')) return ok({ success: true, principals });
    if (url.includes('/dashboard/active')) return ok({ success: true, tasks: activeTasks });
    if (url.includes('/reports/report-1')) return ok({ success: true, report });
    return ok({ success: true, data: [] });
  }),
}));

afterEach(() => cleanup());

/** Rules jsdom cannot judge. Removing an entry strengthens this file. */
const RULES_JSDOM_CANNOT_JUDGE = { 'color-contrast': { enabled: false } } as const;

async function auditOf(container: HTMLElement): Promise<string> {
  const results = await axe.run(container, {
    rules: RULES_JSDOM_CANNOT_JUDGE,
    resultTypes: ['violations'],
  });
  return results.violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n      ${v.nodes.map((n) => n.html).join('\n      ')}`)
    .join('\n');
}

describe('the audit itself', () => {
  test('reports heading-order and landmark-unique on markup that has them', async () => {
    const { container } = render(
      <main>
        <h1>Page</h1>
        <h3>Card</h3>
        <nav><a href="/a">A</a></nav>
        <nav><a href="/b">B</a></nav>
      </main>
    );
    const found = await auditOf(container);
    expect(found).toMatch(/heading-order/);
    expect(found).toMatch(/landmark-unique/);
  });
});

describe('walkthrough R8 - card titles do not skip a heading level', () => {
  test('a Project card is an h2 section of its page', async () => {
    const { container } = render(
      <main>
        <h1>Projects</h1>
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} onClick={() => undefined} />
        ))}
      </main>
    );
    expect(within(container).getAllByRole('heading', { level: 2 })).toHaveLength(2);
    expect(container.querySelector('.project-card-header h3')).toBeNull();
    expect(await auditOf(container)).toBe('');
  });

  test('a Skill card is an h2, and the grid it scrolls in is a named focus stop (R14)', async () => {
    const { container } = render(
      <main>
        <SkillsPage />
      </main>
    );
    await within(container).findByText('Terraform review 1');
    expect(within(container).getAllByRole('heading', { level: 2 })).toHaveLength(2);
    expect(container.querySelector('.skill-card-name h3')).toBeNull();

    const grid = container.querySelector('.skills-grid') as HTMLElement;
    expect(grid.getAttribute('tabindex')).toBe('0');
    expect(grid.getAttribute('role')).toBe('region');
    expect(grid.getAttribute('aria-label')).toBe('Skills');
    expect(await auditOf(container)).toBe('');
  });

  test('a Currently-working-on item is an h3 under that widget own h2', async () => {
    const { container } = render(
      <MemoryRouter>
        <main>
          <h1>Home</h1>
          <ActiveWorkPreview />
        </main>
      </MemoryRouter>
    );
    await within(container).findByText('Renew the wildcard certificate 1');
    expect(within(container).getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(within(container).getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(container.querySelector('.active-work-task-item-header h4')).toBeNull();
    expect(await auditOf(container)).toBe('');
  });
});

describe('walkthrough R14 - the Accounts table is reachable from the keyboard', () => {
  test('the scrollable table carries a tab stop and a name', async () => {
    // The page links onward to My connections with a router link (the dashboard
    // is mounted under a basename), so it needs a router to render at all.
    const { container } = render(
      <MemoryRouter>
        <main>
          <PrincipalsPage />
        </main>
      </MemoryRouter>
    );
    await within(container).findByText('agent-1');
    const table = container.querySelector('.principals-table') as HTMLElement;
    expect(table.getAttribute('role')).toBe('table');
    expect(table.getAttribute('tabindex')).toBe('0');
    expect(table.getAttribute('aria-label')).toBe('Accounts');
  });
});

describe('walkthrough R15 - Report detail has one navigation landmark', () => {
  test('the repeated back link is not a second unnamed nav', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/reports/report-1']}>
        <Routes>
          <Route path="/reports/:id" element={<main><ReportDetailPage /></main>} />
        </Routes>
      </MemoryRouter>
    );
    await within(container).findByText('Quarterly platform review');
    await waitFor(() => expect(container.querySelectorAll('nav')).toHaveLength(1));
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Report');
    // The convenience repeat is still rendered - it just is not a landmark.
    expect(container.querySelectorAll('.report-back-link')).toHaveLength(2);
    expect(container.querySelector('.report-detail-nav-bottom')?.tagName).toBe('DIV');
  });
});
