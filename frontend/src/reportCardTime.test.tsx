// @vitest-environment jsdom
/**
 * A Report card names its instant once.
 *
 * Walkthrough item R13 was written as "two time formats on one Report card":
 * `4 Sept 2026` top-right and `2m ago` bottom-right. Candidate 5 unified the
 * formats across the product, which left the sharper defect underneath —
 * BOTH corners read `report.created_at`. The card printed one instant twice
 * and left the reader to work out that the two agreed.
 *
 * The repair adopts the shape `components/tasks/TaskTimeline.tsx` already
 * ships: relative age as the text, absolute date in `title`, machine value in
 * `dateTime`. It adds one thing the Timeline does not — the absolute date as
 * visually-hidden text — because `title` is not reliably announced and `<time>`
 * carries no implicit ARIA role through which `dateTime` would reach assistive
 * technology. Without it, deleting the visible date would take the exact date
 * away from a screen-reader user and leave it for everyone else.
 *
 * So this file pins three things that together make the duplication
 * unrepeatable: exactly ONE time element per card, the exact instant reachable
 * three ways, and the deleted class gone from the markup.
 */
import { render, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const CREATED = '2026-09-05T12:00:00.000Z';

const reports = [
  {
    id: 'report-1',
    title: 'Quarterly platform review',
    summary: 'The estate is healthy.',
    content: '',
    tags: ['review'],
    pinned: false,
    project_id: null,
    project_name: 'Helios Platform Migration',
    task_ids: [],
    author: 'a caller-supplied label',
    author_actor_name: 'agent-1',
    handover: null,
    created_at: CREATED,
    updated_at: CREATED,
  },
  {
    id: 'report-2',
    title: 'Second report, so one card cannot pass for all of them',
    summary: '',
    content: '',
    tags: [],
    pinned: true,
    project_id: null,
    project_name: null,
    task_ids: [],
    author: null,
    author_actor_name: null,
    handover: null,
    created_at: CREATED,
    updated_at: CREATED,
  },
];

vi.mock('./utils/auth', () => ({
  auth: { isAuthenticated: () => true, getToken: () => 'token', logout: vi.fn(), usedBreakGlass: () => false },
  authenticatedFetch: vi.fn(async () => new Response(
    JSON.stringify({ success: true, reports, total: reports.length }), { status: 200 },
  )),
}));

import { ReportsPage } from './pages/ReportsPage';
import { formatDate } from './utils/dateFormat';

afterEach(() => cleanup());
beforeEach(() => { vi.clearAllMocks(); });

async function renderPage() {
  const view = render(
    <MemoryRouter>
      <ReportsPage />
    </MemoryRouter>,
  );
  await within(view.container).findByText('Quarterly platform review');
  return view.container;
}

describe('a Report card names its instant once', () => {
  test('the fixture really renders two cards', async () => {
    const container = await renderPage();
    expect(container.querySelectorAll('.report-card')).toHaveLength(2);
  });

  test('each card carries exactly one time element', async () => {
    const container = await renderPage();
    const cards = [...container.querySelectorAll('.report-card')];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.querySelectorAll('time')).toHaveLength(1);
    }
  });

  test('the instant is reachable three ways from that one element', async () => {
    const container = await renderPage();
    const el = container.querySelector('.report-card time') as HTMLTimeElement;
    expect(el).not.toBeNull();
    // machine-readable, for anything that parses the page
    expect(el.getAttribute('dateTime') ?? el.getAttribute('datetime')).toBe(CREATED);
    // a hover, for a sighted reader who wants the exact date
    expect(el.getAttribute('title')).toBe(formatDate(CREATED));
    // and the same date in the accessible name, which `title` alone would not
    // reliably give and `dateTime` gives to nobody
    expect(el.textContent).toContain(formatDate(CREATED));
  });

  test('the relative age is still what a sighted reader sees', async () => {
    const container = await renderPage();
    const el = container.querySelector('.report-card time') as HTMLTimeElement;
    const visible = [...el.childNodes]
      .filter((n) => !(n instanceof HTMLElement && n.classList.contains('sr-only')))
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    expect(visible).toMatch(/ago$|^Just now$/);
    expect(visible).not.toContain(formatDate(CREATED));
  });

  test('the second rendering of the same instant is gone', async () => {
    const container = await renderPage();
    // The class the header span carried. Its CSS rule is deleted too; if this
    // ever comes back, the card is printing one instant twice again.
    expect(container.querySelectorAll('.report-card-date')).toHaveLength(0);
  });

  test('the detector would notice a second time element', async () => {
    // The control for the control: the assertion above is only worth anything
    // if two time elements in one card would fail it.
    const probe = document.createElement('div');
    probe.className = 'report-card';
    probe.innerHTML = '<time datetime="a">x</time><time datetime="b">y</time>';
    expect(probe.querySelectorAll('time')).toHaveLength(2);
  });
});
