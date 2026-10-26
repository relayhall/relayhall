// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Task } from '../../types/task';
import { TaskActivityBadge } from './TaskActivityBadge';
import { TaskCard } from './TaskCard';
afterEach(cleanup);
const badgeOf = (phrase: string) => screen.getByText(phrase).closest('.task-activity') as HTMLElement;
test.each(['active', 'idle', 'stale', 'unknown', 'unavailable'] as const)('activity %s has accessible words and observation evidence only when present', state => {
  const receivedAt = state === 'unknown' || state === 'unavailable' ? null : '2026-10-06T12:00:00Z';
  const { container } = render(<TaskActivityBadge activity={{ state, receivedAt }} />);
  expect(badgeOf(`Task activity: ${state[0].toUpperCase()+state.slice(1)}`)).toBeInTheDocument();
  expect(container.querySelector('time')?.getAttribute('datetime') ?? null).toBe(receivedAt);
});
test('legacy session and lifecycle cannot turn a board card into running', () => {
  const task = { id: '11111111-1111-4111-8111-111111111111', title: 'Legacy worker', description: '', sessionRefs: [], autoCreated: false, autoStart: false, blockedBy: [], status: 'in-progress', priority: 'high', subtasks: [], tags: [], links: [], created: '', updated: '', executionMode: 'interactive', acpSessionKey: 'old-session', activeAgent: { name: 'Old agent', sessionKey: 'old-session' } } as Task;
  const { container, rerender } = render(<MemoryRouter><TaskCard task={task} onDragStart={vi.fn()} onDragEnd={vi.fn()} onUpdate={vi.fn()} onSubtaskTransition={vi.fn()} onDelete={vi.fn()} /></MemoryRouter>);
  expect(screen.getByText('Task activity: Unknown')).toBeInTheDocument();
  expect(screen.queryByText('Running')).not.toBeInTheDocument(); expect(container.querySelector('.agent-active')).toBeNull();
  rerender(<MemoryRouter><TaskCard task={task} taskActivity={{ state: 'stale', receivedAt: '2026-10-06T12:00:00Z' }} onDragStart={vi.fn()} onDragEnd={vi.fn()} onUpdate={vi.fn()} onSubtaskTransition={vi.fn()} onDelete={vi.fn()} /></MemoryRouter>);
  expect(screen.getByText('Task activity: Stale')).toBeInTheDocument(); expect(container.querySelector('.agent-active')).toBeNull();
});

test('the activity badge adds no tab stop to a card and reads as words with its observation time', () => {
  const task = { id: '22222222-2222-4222-8222-222222222222', title: 'Keyboard card', description: '', autoCreated: false, autoStart: false, blockedBy: [], status: 'in-progress', priority: 'high', subtasks: [], tags: [], links: [], created: '', updated: '' } as unknown as Task;
  const { container, rerender } = render(<MemoryRouter><TaskCard task={task} onDragStart={vi.fn()} onDragEnd={vi.fn()} onUpdate={vi.fn()} onSubtaskTransition={vi.fn()} onDelete={vi.fn()} /></MemoryRouter>);
  const focusable = 'a[href],button,input,select,textarea,[tabindex]';
  const before = [...container.querySelectorAll(focusable)].length;
  rerender(<MemoryRouter><TaskCard task={task} taskActivity={{ state: 'active', receivedAt: '2026-10-06T12:00:00Z' }} onDragStart={vi.fn()} onDragEnd={vi.fn()} onUpdate={vi.fn()} onSubtaskTransition={vi.fn()} onDelete={vi.fn()} /></MemoryRouter>);
  const badge = badgeOf('Task activity: Active');
  expect(badge.querySelectorAll(focusable)).toHaveLength(0);
  expect([...container.querySelectorAll(focusable)]).toHaveLength(before);
  expect(badge).toHaveTextContent(/^Task activity: Active\s*Active\s*Observed /);
  expect(badge.querySelector('.session-status-dot')).toHaveAttribute('aria-hidden', 'true');
  expect(badge.querySelector('time')).toHaveAttribute('title', 'Last actual activity observation');
});

// Card 30d198df (3). ARIA 1.2 prohibits aria-label on a role-less (generic)
// element, so a screen reader may not announce it; the words carry the name.
test('no element of the badge names itself with aria-label without a role; its words name it once', () => {
  for (const state of ['active', 'idle', 'stale', 'unknown', 'unavailable'] as const) {
    const { container, unmount } = render(<TaskActivityBadge activity={{ state, receivedAt: null }} />);
    const badge = container.querySelector('.task-activity') as HTMLElement;
    expect([badge, ...badge.querySelectorAll('*')].filter(node => node.hasAttribute('aria-label') && !node.hasAttribute('role'))).toEqual([]);
    const label = state[0].toUpperCase() + state.slice(1);
    expect(badge.querySelector('.sr-only')).toHaveTextContent(`Task activity: ${label}`);
    // The short visible word is hidden from assistive technology, so the name is read once.
    expect([...badge.querySelectorAll('[aria-hidden="true"]')].map(node => node.textContent)).toEqual(['', label]);
    unmount();
  }
});

// Card 30d198df (2). Outside In Progress no worker holds the Task, so the
// board does not read it and the card shows no badge and no activity style,
// whatever value it is handed.
test.each(['ideas', 'todo', 'review', 'stuck', 'completed', 'archived'])('a %s card shows no activity badge and takes no activity style', status => {
  const task = { id: '33333333-3333-4333-8333-333333333333', title: 'Not in progress', description: '', autoStart: false, blockedBy: [], status, priority: 'normal', subtasks: [], tags: [], links: [], created: '', updated: '' } as unknown as Task;
  for (const state of ['active', 'stale', 'unknown'] as const) {
    const { container, unmount } = render(<MemoryRouter><TaskCard task={task} taskActivity={{ state, receivedAt: state === 'unknown' ? null : '2026-10-06T12:00:00Z' }} onDragStart={vi.fn()} onDragEnd={vi.fn()} onUpdate={vi.fn()} onSubtaskTransition={vi.fn()} onDelete={vi.fn()} /></MemoryRouter>);
    expect(container.querySelector('.task-activity')).toBeNull();
    expect(screen.queryByText(/^Task activity:/)).toBeNull();
    expect(container.querySelector('.agent-active, .session-active, .session-stale')).toBeNull();
    unmount();
  }
});

test('an In Progress card shows its badge and its activity style', () => {
  const task = { id: '44444444-4444-4444-8444-444444444444', title: 'Working', description: '', autoStart: false, blockedBy: [], status: 'in-progress', priority: 'normal', subtasks: [], tags: [], links: [], created: '', updated: '' } as unknown as Task;
  const { container } = render(<MemoryRouter><TaskCard task={task} taskActivity={{ state: 'active', receivedAt: '2026-10-06T12:00:00Z' }} onDragStart={vi.fn()} onDragEnd={vi.fn()} onUpdate={vi.fn()} onSubtaskTransition={vi.fn()} onDelete={vi.fn()} /></MemoryRouter>);
  expect(screen.getByText('Task activity: Active')).toBeInTheDocument();
  expect(container.querySelector('article.agent-active.session-active')).not.toBeNull();
});

test('at narrow width the badge wraps instead of overflowing the card', () => {
  const css = readFileSync(resolve(__dirname, 'TaskActivityBadge.css'), 'utf8').replace(/\s+/g, ' ');
  expect(css).toMatch(/\.task-activity \{[^}]*flex-wrap: wrap;[^}]*min-width: 0;/);
  expect(css).toMatch(/\.task-activity time \{[^}]*overflow-wrap: anywhere;/);
});
