import React from 'react';
import { Select } from '../ui/Select';
import type { SubtaskStatus } from '../../types/task';

export const SUBTASK_STATUS_OPTIONS: ReadonlyArray<{ value: SubtaskStatus; label: string }> = [
  { value: 'empty', label: 'Not started' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'review', label: 'To be reviewed' },
  { value: 'stuck', label: 'Stuck' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'completed', label: 'Completed' },
];

export interface SubtaskLifecycleOption {
  value: SubtaskStatus;
  label: string;
  authorityNote?: string;
}

export const SUBTASK_LIFECYCLE_ACTIONS: Readonly<Record<SubtaskStatus, ReadonlyArray<SubtaskLifecycleOption>>> = {
  empty: [
    { value: 'in-progress', label: 'Start work' },
    { value: 'skipped', label: 'Skip', authorityNote: 'Verifier/orchestrator' },
  ],
  'in-progress': [
    { value: 'review', label: 'Send to review' },
    { value: 'stuck', label: 'Mark stuck' },
  ],
  review: [
    { value: 'completed', label: 'Approve', authorityNote: 'Verifier only' },
    { value: 'empty', label: 'Reject to not started', authorityNote: 'Verifier/orchestrator' },
    { value: 'stuck', label: 'Mark stuck' },
  ],
  stuck: [
    { value: 'in-progress', label: 'Resume work' },
    { value: 'empty', label: 'Return to not started', authorityNote: 'Verifier/orchestrator' },
    { value: 'skipped', label: 'Skip', authorityNote: 'Verifier/orchestrator' },
  ],
  skipped: [
    { value: 'empty', label: 'Reopen', authorityNote: 'Verifier/orchestrator' },
  ],
  completed: [
    { value: 'empty', label: 'Reopen', authorityNote: 'Verifier/orchestrator' },
  ],
};

interface SubtaskStatusSelectProps {
  value: SubtaskStatus;
  onChange: (status: SubtaskStatus) => void;
  subtaskText: string;
  className?: string;
  disabled?: boolean;
}

const statusLabel = (status: SubtaskStatus): string =>
  SUBTASK_STATUS_OPTIONS.find(option => option.value === status)?.label || status;

export const SubtaskStatusSelect: React.FC<SubtaskStatusSelectProps> = ({
  value,
  onChange,
  subtaskText,
  className = '',
  disabled = false,
}) => {
  const actions = SUBTASK_LIFECYCLE_ACTIONS[value];
  return (
    <Select
      className={`subtask-status-select status-${value} ${className}`.trim()}
      value={value}
      disabled={disabled || actions.length === 0}
      aria-label={`Lifecycle action for ${subtaskText}. Current status: ${statusLabel(value)}`}
      title="Choose an allowed lifecycle action. Verifier-only actions are enforced by the server."
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        event.stopPropagation();
        const nextStatus = event.target.value as SubtaskStatus;
        if (nextStatus !== value) onChange(nextStatus);
      }}
    >
      <option value={value}>Current: {statusLabel(value)}</option>
      {actions.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}{option.authorityNote ? ` — ${option.authorityNote}` : ''}
        </option>
      ))}
    </Select>
  );
};
