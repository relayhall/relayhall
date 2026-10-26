import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Subtask } from '../../types/task';
import { SubtaskList } from './SubtaskList';

const subtask = (overrides: Partial<Subtask> = {}): Subtask => ({
  id: 'subtask-1',
  text: 'Collect proof',
  status: 'empty',
  completed: false,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SubtaskList lifecycle controls', () => {
  test('renders review notes and stuck reasons as visible text', () => {
    const tree = renderer.create(
      <SubtaskList
        readOnly
        subtasks={[
          subtask({ status: 'review', reviewNote: 'Check the exact candidate' }),
          subtask({ id: 'subtask-2', status: 'stuck', blockedReason: 'Waiting for access' }),
        ]}
      />,
    );
    const serialized = JSON.stringify(tree.toJSON());
    expect(serialized).toContain('Review note:');
    expect(serialized).toContain('Check the exact candidate');
    expect(serialized).toContain('Stuck reason:');
    expect(serialized).toContain('Waiting for access');
  });

  test('captures an explicit review handoff note before submitting', async () => {
    const prompt = vi.fn(() => 'Fresh screenshots attached');
    vi.stubGlobal('window', { prompt });
    const onStatusChange = vi.fn(async () => undefined);
    const tree = renderer.create(<SubtaskList subtasks={[subtask({ status: 'in-progress' })]} onStatusChange={onStatusChange} />);

    await act(async () => {
      tree.root.findByType('select').props.onChange({
        target: { value: 'review' },
        stopPropagation: vi.fn(),
      });
      await Promise.resolve();
    });

    expect(prompt).toHaveBeenCalledWith('Review handoff note (optional):', '');
    expect(onStatusChange).toHaveBeenCalledWith('subtask-1', 'review', { reviewNote: 'Fresh screenshots attached' });
  });

  // E388 Subtasks: each subtask is its own container, the state selector sits
  // ABOVE the text so the text gets the full card width, and the review note
  // sits on a distinct background. Markup order plus the owning stylesheet.
  test('E388: each subtask is a card with its state selector above full-width text and a note block below', async () => {
    const fs = await import('fs');
    const css = fs.readFileSync('src/components/tasks/SubtaskList.css', 'utf8');
    const tree = renderer.create(
      <SubtaskList
        onStatusChange={vi.fn()}
        onEditText={vi.fn()}
        subtasks={[subtask({ status: 'review', reviewNote: 'Check the exact candidate' })]}
      />,
    );
    const item = tree.root.find(node => node.type === 'li');
    expect(String(item.props.className)).toContain('subtask-item');
    const order = item.children
      .filter((child): child is renderer.ReactTestInstance => typeof child !== 'string')
      .map(child => String(child.props.className || child.type));
    expect(order[0]).toContain('subtask-list-status');
    expect(order[1]).toContain('subtask-text');
    expect(order[2]).toContain('subtask-lifecycle-context');
    expect(item.findByProps({ role: 'note' }).props.className).toBe('subtask-review-note');

    const block = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`))?.[0] ?? '';
    expect(css).not.toMatch(/190px|calc\(100% - 214px\)/);
    expect(block('.subtask-item')).toContain('display: grid');
    expect(block('.subtask-item')).toMatch(/grid-template-areas:\s*"status actions"\s*"text text"\s*"context context"/);
    expect(block('.subtask-item')).toContain('border: 1px solid var(--border-subtle)');
    expect(block('.subtask-item')).toContain('border-inline-start: var(--space-1) solid');
    expect(block('.subtask-status-select')).toContain('grid-area: status');
    expect(block('.subtask-text')).toContain('grid-area: text');
    expect(block('.subtask-review-note,\n.subtask-blocked-reason,\n.subtask-skipped-note')).toContain('background: var(--bg-elevated)');
    expect(block('.subtask-review-note,\n.subtask-blocked-reason,\n.subtask-skipped-note')).toContain('border-inline-start: var(--space-1) solid');
  });

  test('E388: row actions take no row of their own and show on hover, focus and coarse pointers', async () => {
    const fs = await import('fs');
    const css = fs.readFileSync('src/components/tasks/SubtaskList.css', 'utf8');
    expect(css).toMatch(/\.subtask-actions \{[^}]*grid-area: actions/);
    expect(css).not.toMatch(/\.subtask-actions \{[^}]*margin-left: auto/);
    expect(css).toMatch(/\.subtask-item:hover \.subtask-actions,\s*\.subtask-item:focus-within \.subtask-actions \{[^}]*opacity: 1/);
    expect(css).toMatch(/@media \(pointer: coarse\), \(max-width: 767px\) \{\s*\.subtask-actions \{[^}]*opacity: 1/);
  });

  test('E388: progress counts carry words for screen readers', () => {
    const tree = renderer.create(
      <SubtaskList
        readOnly
        subtasks={[
          subtask({ id: 'a', status: 'completed' }),
          subtask({ id: 'b', status: 'completed' }),
          subtask({ id: 'c', status: 'in-progress' }),
          subtask({ id: 'd', status: 'review' }),
          subtask({ id: 'e', status: 'empty' }),
        ]}
      />,
    );
    const summary = tree.root.find(node => node.props.className === 'subtask-progress-text');
    const words = summary.findAll(node => node.props.className === 'sr-only').map(node => node.children.join(''));
    expect(words).toEqual([' completed', ' to be reviewed', ' in progress', ' not started']);
  });

  test('shows server transition failures instead of silently changing local state', async () => {
    vi.stubGlobal('window', { prompt: vi.fn() });
    const onStatusChange = vi.fn(async () => { throw new Error('Only an independent Verifier can approve.'); });
    const tree = renderer.create(<SubtaskList subtasks={[subtask({ status: 'review' })]} onStatusChange={onStatusChange} />);

    await act(async () => {
      tree.root.findByType('select').props.onChange({
        target: { value: 'completed' },
        stopPropagation: vi.fn(),
      });
      await Promise.resolve();
    });

    const alerts = tree.root.findAll(node => node.props.role === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].children.join('')).toContain('Only an independent Verifier can approve.');
  });
});
