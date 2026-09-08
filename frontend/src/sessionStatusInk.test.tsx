// @vitest-environment jsdom
/**
 * A session status is a WORD, so it takes a text tier.
 *
 * Review 3ed95da6 F1: `.session-status-idle` sat on --text-quaternary, the
 * contrast-exempt disabled/placeholder tier, and the exemption I wrote for it
 * said "the idle state of a status dot, deliberately recessive". That was
 * wrong about its own markup. The rule colours the PARENT span; the dot inside
 * is painted by `background` on `.session-status-dot` and never took that ink.
 * The only thing the ink reached was the readable label.
 *
 * A census cannot catch that, because the census looked at selectors and the
 * mistake was in the sentence beside one. So this file asserts the two halves
 * that together make it impossible:
 *
 *   the label is really rendered, in the real component, in the real state —
 *   so nobody can claim the rule is decorative again;
 *
 *   and every `.session-status-*` STATE rule paints from a text tier, so the
 *   next state added inherits the rule rather than the oversight.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { TaskCard } from './components/tasks/TaskCard';
import type { Task } from './types/task';

vi.mock('./utils/auth', () => ({
  auth: { isAuthenticated: () => true, getToken: () => 'token', logout: vi.fn(), usedBreakGlass: () => false },
  authenticatedFetch: vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
}));

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const CSS = fs.readFileSync(path.join(SRC, 'components', 'tasks', 'TaskCard.css'), 'utf8');

afterEach(() => cleanup());

/** The parent state rules, not the `.session-status-dot` descendants. */
function stateInk(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of CSS.matchAll(/^\.(session-status-[a-z]+)\s*\{([^}]*)\}/gm)) {
    const colour = /(?:^|[;{\s])color:\s*var\(\s*(--[\w-]+)\s*\)/.exec(m[2]);
    if (colour) out[m[1]] = colour[1];
  }
  return out;
}

const task: Task = {
  id: 'task-idle-1',
  title: 'Renew the wildcard certificate',
  description: '',
  status: 'in-progress',
  priority: 'normal',
  created_at: '2026-09-05T10:00:00.000Z',
  updated_at: '2026-09-05T10:00:00.000Z',
  executionMode: 'interactive',
} as unknown as Task;

describe('a session status is a word, so it takes a text tier', () => {
  test('the idle label really renders, in the real component', () => {
    const { container } = render(
      <MemoryRouter>
        <TaskCard
          task={task}
          onDragStart={() => undefined}
          onDragEnd={() => undefined}
          onUpdate={() => undefined}
          onSubtaskTransition={async () => undefined}
          onDelete={() => undefined}
        />
      </MemoryRouter>,
    );
    const status = container.querySelector('.session-status-idle');
    expect(status).not.toBeNull();
    // The word, not just the class: this is what the false exemption denied.
    expect(status!.textContent).toContain('Idle');
    expect(screen.getByText('Idle')).toBeTruthy();
    // And the dot is a sibling that carries no text, which is why the parent's
    // ink was only ever reaching the label.
    const dot = status!.querySelector('.session-status-dot');
    expect(dot).not.toBeNull();
    expect(dot!.textContent).toBe('');
  });

  test('the stylesheet parse found the state rules at all', () => {
    const ink = stateInk();
    expect(Object.keys(ink).sort()).toEqual(
      ['session-status-completed', 'session-status-idle', 'session-status-running', 'session-status-waiting'],
    );
  });

  test('every session state paints from a text tier', () => {
    const ink = stateInk();
    const wrong = Object.entries(ink)
      .filter(([, token]) => !token.startsWith('--text-'))
      .map(([sel, token]) => `.${sel} uses ${token}`);
    expect(wrong).toEqual([]);
  });

  test('no session state sits on the contrast-exempt disabled tier', () => {
    const ink = stateInk();
    const exempt = Object.entries(ink)
      .filter(([, token]) => token === '--text-quaternary')
      .map(([sel]) => `.${sel}`);
    expect(exempt).toEqual([]);
  });

  test('the detector fires on the shape it exists for', () => {
    // The control for the control: the exact rule this review rejected.
    const parse = (css: string) => {
      const m = /^\.(session-status-[a-z]+)\s*\{([^}]*)\}/m.exec(css);
      if (!m) return null;
      const c = /(?:^|[;{\s])color:\s*var\(\s*(--[\w-]+)\s*\)/.exec(m[2]);
      return c ? c[1] : null;
    };
    expect(parse('.session-status-idle {\n  color: var(--text-quaternary);\n}')).toBe('--text-quaternary');
    expect(parse('.session-status-idle {\n  color: var(--text-tertiary);\n}')).toBe('--text-tertiary');
    // A descendant dot rule must NOT be mistaken for a state rule.
    expect(parse('.session-status-idle .session-status-dot {\n  background: var(--overlay-strong);\n}')).toBeNull();
  });
});
