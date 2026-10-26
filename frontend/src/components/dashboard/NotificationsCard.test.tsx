/*
 * NotificationsCard — "Needs your action" on the dashboard (Notifications and
 * Timeline design sections 3 and 5; card 5854f0d6, Slice B; owner ruling E394).
 *
 * The card lists the first six items of `GET /notifications/actions` in the
 * server's order, each linked to where the act is done, with no read state
 * and no "mark read"; it reads the ONE shared action list the bell reads; a
 * failed read is an error with Retry, never "nothing needs you"; and it never
 * calls the retired history routes.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NotificationsCard } from './NotificationsCard';
import { NotificationBell } from '../notifications/NotificationBell';
import type { ActionItem } from '../notifications/notifications';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const since = new Date(Date.now() - 3 * 3600_000).toISOString();
const item = (kind: ActionItem['kind'], id: string, title: string | null = `Task ${id}`): ActionItem => ({
  key: `${kind}:${id}`, kind, reasons: kind === 'stuck' ? ['status'] : kind === 'verify' ? ['verifier'] : [kind],
  since, object: { type: kind === 'decision' ? 'approval' : kind === 'skill' ? 'skill' : 'task', id, title }, project: null,
  href: kind === 'decision' ? `/notifications?tab=approvals&approval=${id}` : kind === 'skill' ? `/skills?skill=${id}` : `/tasks/${id}`,
  detail: kind === 'decision' ? { approvalKind: 'grant', requesterHandle: 'conn-a' } : {},
});
const answer = (items: ActionItem[]) => ({
  ok: true, status: 200,
  json: async () => ({
    success: true, items,
    counts: { decision: 0, verify: 0, stuck: 0, skill: 0, total: items.length },
    capped: { decision: false, verify: false, stuck: false, skill: false },
  }),
});

const renderCard = () => render(<MemoryRouter><NotificationsCard /></MemoryRouter>);

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => { cleanup(); });

describe('NotificationsCard is "Needs your action"', () => {
  it('lists the first six items in the server\'s order, each linked to where the act is done', async () => {
    const items = [
      item('decision', 'd1', 'Fix the flux'), item('verify', 'v1'), item('verify', 'v2'), item('stuck', 's1'),
      item('stuck', 's2'), item('skill', 'k1', 'terraform-review'), item('stuck', 's3'), item('stuck', 's4'),
    ];
    fetchMock.mockResolvedValue(answer(items));
    renderCard();
    const card = await screen.findByRole('region', { name: 'Needs your action' });
    await within(card).findByText('Fix the flux');
    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => within(row).getByRole('link').textContent)).toEqual([
      'Fix the flux', 'Task v1', 'Task v2', 'Task s1', 'Task s2', 'terraform-review',
    ]);
    expect(within(card).getByRole('link', { name: 'Fix the flux' })).toHaveAttribute('href', '/notifications?tab=approvals&approval=d1');
    expect(within(rows[0]).getByText('Grant request from conn-a waits for your decision')).toBeInTheDocument();
    expect(within(rows[3]).getByText('Its status is Stuck')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Waiting 3 h')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'See all 8' })).toHaveAttribute('href', '/action-center');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/notifications/actions']);
  });

  it('has no read state: nothing to mark read, and a short list links "All notifications"', async () => {
    fetchMock.mockResolvedValue(answer([item('verify', 'v1')]));
    renderCard();
    await screen.findByText('Task v1');
    expect(screen.queryByRole('button', { name: /Mark/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All notifications' })).toHaveAttribute('href', '/action-center');
  });

  it('an empty list says nothing needs you', async () => {
    fetchMock.mockResolvedValue(answer([]));
    renderCard();
    expect(await screen.findByText('Nothing needs your action.')).toBeInTheDocument();
  });

  it('a failed read is an error with Retry, never "nothing needs you"', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn.t check what needs your action/);
    expect(screen.queryByText('Nothing needs your action.')).not.toBeInTheDocument();
    fetchMock.mockResolvedValue(answer([item('stuck', 's1')]));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Task s1')).toBeInTheDocument();
  });

  it('the card and the bell share ONE read and say the same number', async () => {
    fetchMock.mockResolvedValue(answer([item('verify', 'v1'), item('stuck', 's1'), item('stuck', 's2')]));
    render(<MemoryRouter><NotificationBell /><NotificationsCard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Notifications/ })).toHaveAccessibleName('Notifications: 3 need your action'));
    expect(within(screen.getByRole('region', { name: 'Needs your action' })).getAllByRole('listitem')).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/*
 * Card 2b6f21f6 (SQ-2), kept for the new row: a long unwrapped title must not
 * push the row past the card's border. vitest applies no stylesheet, so the
 * rules are read from disk and the row is laid out by the flexbox sizing rules
 * those declarations select (a flex item's automatic minimum is its
 * min-content width unless it declares `min-width: 0`). Every glyph is costed
 * at a quarter em. A browser pass over the built page stays the dispatcher's.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const cardCss = read('./NotificationsCard.css');
const tokens = read('../../styles/variables.css');
const pageCss = read('../../pages/DashboardPage.css');

const ruleBody = (css: string, selector: string, from = 0) => {
  const at = css.indexOf(`${selector} {`, from);
  expect(at, `${selector} is missing`).toBeGreaterThan(-1);
  return css.slice(at + selector.length + 2, css.indexOf('}', at));
};
const tokenPx = (name: string) => {
  const match = tokens.match(new RegExp(`--${name}:\\s*([0-9.]+)(rem|px);`));
  expect(match, `--${name} is missing from variables.css`).not.toBeNull();
  return Number(match![1]) * (match![2] === 'rem' ? 16 : 1);
};
const declared = (body: string, property: string): string | null =>
  body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`))?.[1].trim() ?? null;
const lengthPx = (value: string | null): number => {
  if (value === null || value === '0') return 0;
  const token = value.match(/^var\(--([a-z0-9-]+)\)$/);
  if (token) return tokenPx(token[1]);
  const px = value.match(/^([0-9.]+)px$/);
  expect(px, `unsupported length ${value}`).not.toBeNull();
  return Number(px![1]);
};
const borderPx = (body: string) => lengthPx(declared(body, 'border')?.split(/\s+/)[0] ?? null);
const pagePadding = (width: number) => {
  const mobile = pageCss.indexOf('@media (max-width: 640px)');
  expect(mobile).toBeGreaterThan(-1);
  return lengthPx(declared(ruleBody(pageCss, '.dashboard-page', width <= 640 ? mobile : 0), 'padding'));
};
const minContent = (element: HTMLElement) => {
  const body = ruleBody(cardCss, `.${element.className.split(/\s+/)[0]}`);
  const glyph = lengthPx(declared(body, 'font-size')) / 4;
  const text = element.textContent ?? '';
  if (declared(body, 'white-space') === 'nowrap') return text.length * glyph;
  if (declared(body, 'overflow-wrap') === 'anywhere') return glyph;
  return Math.max(0, ...text.split(/\s+/).map((word) => word.length * glyph));
};
const rowLayout = (row: HTMLElement, viewport: number) => {
  const card = ruleBody(cardCss, '.notifications-card');
  const itemRule = ruleBody(cardCss, '.notifications-card-item');
  const bodyRule = ruleBody(cardCss, '.notifications-card-item-body');
  const cardWidth = Math.min(viewport, 1400) - 2 * pagePadding(viewport);
  const inner = cardWidth - 2 * (borderPx(card) + lengthPx(declared(card, 'padding')))
    - 2 * (borderPx(itemRule) + lengthPx(declared(itemRule, 'padding')));
  const [icon, body] = [...row.children] as HTMLElement[];
  expect(icon).toHaveClass('notifications-card-item-icon');
  expect(body).toHaveClass('notifications-card-item-body');
  const shrinkable = declared(bodyRule, 'min-width') === '0';
  const bodyMin = shrinkable ? 0 : Math.max(0, ...[...body.children].map((line) => minContent(line as HTMLElement)));
  const rowMin = Number(icon.querySelector('svg')!.getAttribute('width')) + lengthPx(declared(itemRule, 'gap')) + bodyMin;
  return { inner, rowRight: Math.max(inner, rowMin) };
};

describe('NotificationsCard — a long title stays inside the card (card 2b6f21f6 SQ-2)', () => {
  const token = 'ci-full_is_red_on_main:real-PG_blueprintLiveContract_D-15/D-20_fails_26/27_because_MCP_'
    .repeat(8).slice(0, 400);

  it.each([1280, 390])('keeps the row inside the card border at %ipx', async (viewport) => {
    fetchMock.mockResolvedValue(answer([item('verify', 'long', token), item('verify', 'short', 'Short fixture task')]));
    renderCard();
    const longLink = await screen.findByRole('link', { name: token });
    const long = rowLayout(longLink.closest('li')!, viewport);
    expect(long.inner).toBeGreaterThan(200);
    expect(long.inner).toBeLessThan(viewport);
    expect(long.rowRight, `row right edge at ${viewport}px`).toBeLessThanOrEqual(long.inner);
  });

  it('truncates the long line with an ellipsis and keeps it whole in a title', async () => {
    fetchMock.mockResolvedValue(answer([item('verify', 'long', token)]));
    renderCard();
    const line = await screen.findByRole('link', { name: token });
    expect(line).toHaveAttribute('title', token);
    const rule = ruleBody(cardCss, '.notifications-card-item-task');
    expect(declared(rule, 'white-space')).toBe('nowrap');
    expect(declared(rule, 'overflow')).toBe('hidden');
    expect(declared(rule, 'text-overflow')).toBe('ellipsis');
  });
});
