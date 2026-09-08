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
