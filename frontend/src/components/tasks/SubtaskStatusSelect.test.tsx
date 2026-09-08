import renderer from 'react-test-renderer';
import { describe, expect, test, vi } from 'vitest';
import { SUBTASK_LIFECYCLE_ACTIONS, SUBTASK_STATUS_OPTIONS, SubtaskStatusSelect } from './SubtaskStatusSelect';

describe('SubtaskStatusSelect', () => {
  test('retains all six canonical owner-facing states', () => {
    expect(SUBTASK_STATUS_OPTIONS).toEqual([
      { value: 'empty', label: 'Not started' },
      { value: 'in-progress', label: 'In progress' },
      { value: 'review', label: 'To be reviewed' },
      { value: 'stuck', label: 'Stuck' },
      { value: 'skipped', label: 'Skipped' },
      { value: 'completed', label: 'Completed' },
    ]);
  });

  test('shows only valid next actions instead of arbitrary direct state jumps', () => {
    const tree = renderer.create(
      <SubtaskStatusSelect value="empty" onChange={() => undefined} subtaskText="proof" />,
    );
    const options = tree.root.findAllByType('option');
    expect(options.map(option => option.props.value)).toEqual(['empty', 'in-progress', 'skipped']);
    expect(SUBTASK_LIFECYCLE_ACTIONS.review.map(option => option.value)).toEqual(['completed', 'empty', 'stuck']);
    expect(SUBTASK_LIFECYCLE_ACTIONS.completed.map(option => option.value)).toEqual(['empty']);
  });

  test('labels independent Verifier-owned transitions explicitly', () => {
    const tree = renderer.create(
      <SubtaskStatusSelect value="review" onChange={() => undefined} subtaskText="proof" />,
    );
    const optionLabels = tree.root.findAllByType('option').map(option => option.children.join(''));
    expect(optionLabels).toContain('Approve — Verifier only');
    expect(optionLabels).toContain('Reject to not started — Verifier/orchestrator');
  });

  test('emits the explicitly selected lifecycle action', () => {
    const onChange = vi.fn();
    const tree = renderer.create(
      <SubtaskStatusSelect value="review" onChange={onChange} subtaskText="proof" />,
    );
    tree.root.findByType('select').props.onChange({
      target: { value: 'completed' },
      stopPropagation: vi.fn(),
    });
    expect(onChange).toHaveBeenCalledWith('completed');
  });
});
