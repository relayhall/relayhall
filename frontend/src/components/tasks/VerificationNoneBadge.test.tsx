// @vitest-environment jsdom
/**
 * Owner ruling E462 S4b (universal harness connector design, section 6.8):
 * the "No verification" badge on the Task card, the Timeline entry for a
 * `none` set or clear, and the Blueprint preview's per-Task flag and its
 * "no Task in this chain is verified" warning. Rendered at desktop width and
 * at 375 px, and audited with axe.
 *
 * HONEST SCOPE (as a11y.smoke.test.tsx): jsdom has no layout engine, so the
 * phone width is asserted through the badge's own bounding rules in its
 * stylesheet (it never grows past its container and ellipses its words) and
 * colour contrast is judged by scripts/check-design-contrast.py over the
 * Theme tokens the badge uses. What this covers is structure: the words that
 * name the badge, roles, labels and ARIA validity.
 */
import '@testing-library/jest-dom/vitest';
import axe from 'axe-core';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Task } from '../../types/task';
import type { BlueprintPlanData } from '../../types/blueprint';
import { TaskCard } from './TaskCard';
import { VerificationNoneBadge, verificationModeLabel } from './VerificationNoneBadge';
import { TIMELINE_RENDERER_REGISTRY } from './taskTimelineRendererRegistry';
import { BlueprintPlan } from '../blueprints/BlueprintPlan';

afterEach(cleanup);

const RULES_JSDOM_CANNOT_JUDGE = { 'color-contrast': { enabled: false } } as const;
async function violations(root: Element): Promise<axe.Result[]> {
  return (await axe.run(root, { rules: RULES_JSDOM_CANNOT_JUDGE, resultTypes: ['violations'] })).violations;
}
const WIDTHS = [1280, 375] as const;
function atWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}
const baseTask = (fields: Partial<Task>): Task => ({
  id: '11111111-1111-4111-8111-111111111111', title: 'Run the playbook', description: '', sessionRefs: [], autoCreated: false,
  autoStart: false, blockedBy: [], status: 'todo', priority: 'normal', subtasks: [], tags: [], links: [], created: '', updated: '',
  ...fields,
} as Task);
const card = (task: Task) => render(<MemoryRouter><TaskCard task={task} onDragStart={vi.fn()} onDragEnd={vi.fn()} onUpdate={vi.fn()} onSubtaskTransition={vi.fn()} onDelete={vi.fn()} /></MemoryRouter>);

describe.each(WIDTHS)('S4b at %d px', (width) => {
  test('the Task card shows "No verification" only for a none Task', async () => {
    atWidth(width);
    const { container, unmount } = card(baseTask({ verificationNone: true, verificationMode: 'none' }));
    const badge = screen.getByText('No verification').closest('.verification-none-badge') as HTMLElement;
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', expect.stringContaining('completes it'));
    expect(await violations(container)).toEqual([]);
    unmount();
    card(baseTask({ verificationNone: false, verificationMode: 'human', verifierPrincipalId: '22222222-2222-4222-8222-222222222222' }));
    expect(screen.queryByText('No verification')).toBeNull();
  });

  test('the Blueprint preview flags each none Task and warns when no Task in the chain is verified', async () => {
    atWidth(width);
    const plan = {
      target: { mode: 'new-project' }, project: { name: 'Chain' }, phases: [], reports: [], dependencies: [{ task: 'b', dependsOn: 'a' }],
      references: [], authority: [], humanGates: [], refusals: [], counts: { tasks: 2 }, parameterValues: {},
      tasks: [
        { key: 'a', title: 'Run the playbook', autoStart: false, verificationNone: true },
        { key: 'b', title: 'Read the result', autoStart: false, verificationNone: true },
      ],
      warnings: [{ code: 'BLUEPRINT_CHAIN_UNVERIFIED', message: 'No Task in this chain is verified' }],
    } as unknown as BlueprintPlanData;
    const { container } = render(<BlueprintPlan plan={plan} targetArchived={false} />);
    expect(screen.getAllByText('No verification')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Plan warnings' })).toHaveTextContent('No Task in this chain is verified');
    expect(await violations(container)).toEqual([]);
  });
});

test('S4b a verified Task in the preview carries no flag and no warning', () => {
  const plan = {
    target: { mode: 'new-project' }, project: null, phases: [], reports: [], dependencies: [], references: [], authority: [],
    humanGates: [], refusals: [], counts: {}, parameterValues: {},
    tasks: [{ key: 'a', title: 'Verified', autoStart: false }, { key: 'b', title: 'Unverified', autoStart: false, verificationNone: true }],
  } as unknown as BlueprintPlanData;
  render(<BlueprintPlan plan={plan} targetArchived={false} />);
  expect(screen.getAllByText('No verification')).toHaveLength(1);
  expect(screen.queryByRole('region', { name: 'Plan warnings' })).toBeNull();
});

test('S4b the Timeline has its own renderer for a verification-mode entry', () => {
  const renderer = TIMELINE_RENDERER_REGISTRY['task.verification_mode'];
  expect(renderer).toBeDefined();
  expect(renderer.className).toBe('task-verification-mode');
});

test('S4b the derived mode reads beside the Verifier; none and unassigned add nothing there', () => {
  expect(verificationModeLabel('human')).toBe(' (verification: human)');
  expect(verificationModeLabel('service')).toBe(' (verification: service)');
  expect(verificationModeLabel('none')).toBe('');
  expect(verificationModeLabel('unassigned')).toBe('');
  expect(verificationModeLabel(undefined)).toBe('');
});

test('S4b the badge never grows past its container at phone width (its own bounding rules)', async () => {
  const css = readFileSync(resolve(__dirname, 'VerificationNoneBadge.css'), 'utf8');
  expect(css).toMatch(/\.verification-none-badge \{[^}]*max-width: 100%;/);
  expect(css).toMatch(/\.verification-none-badge > span \{[^}]*text-overflow: ellipsis;/);
  const { container } = render(<VerificationNoneBadge />);
  expect(await violations(container)).toEqual([]);
});
