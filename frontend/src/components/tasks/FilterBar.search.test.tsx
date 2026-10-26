// @vitest-environment jsdom
import { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FilterBar, type TaskFilters } from './FilterBar';

vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async () => ({ ok: true, json: async () => ({ success: true, phases: [] }) })),
}));
// Card 41e24358: Clear All also resets the usable-Verifier filter.
const empty: TaskFilters = { searchQuery: '', priorities: [], tags: [], projects: [], phases: [], statuses: [], mine: false, owner: null, unassigned: false, verifierUnusable: false };
function Harness({ onChange = () => {} }: { onChange?: (filters: TaskFilters) => void }) {
  const [filters, setFilters] = useState<TaskFilters>(empty);
  return <><FilterBar tasks={[]} filters={filters} availableProjects={['alpha']} onFiltersChange={next => { onChange(next); setFilters(next); }} />
    <output data-testid="filters">{JSON.stringify(filters)}</output></>;
}
const current = () => JSON.parse(screen.getByTestId('filters').textContent!);
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const search = (value: string) => fireEvent.change(screen.getByPlaceholderText('Search tasks by title or description...'), { target: { value } });
const selectProject = () => { fireEvent.click(screen.getByRole('button', { name: 'Project' })); fireEvent.click(screen.getByLabelText('#alpha')); };
const selectStatus = () => { fireEvent.click(screen.getByRole('button', { name: 'Status' })); fireEvent.click(screen.getByLabelText('To do')); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });
describe('FilterBar search preserves newer filter selections', () => {
  test('does not undo a project chosen immediately after mounting', () => {
    render(<Harness />); selectProject();
    expect(current().projects).toEqual(['alpha']);
    advance(300);
    expect(current().projects).toEqual(['alpha']);
    expect(screen.getByLabelText('#alpha')).toBeChecked();
  });
  test('applies pending search without losing a newer project or status', () => {
    render(<Harness />); advance(300);
    search('report'); advance(100); selectProject(); selectStatus();
    advance(200);
    expect(current()).toMatchObject({ searchQuery: 'report', projects: ['alpha'], statuses: ['todo'] });
    expect(screen.getByLabelText('To do')).toBeChecked();
  });
  test('debounces rapid typing and cancels pending search when all filters are cleared', () => {
    render(<Harness />); advance(300);
    search('first'); advance(100); search('second'); advance(299);
    expect(current().searchQuery).toBe(''); advance(1);
    expect(current().searchQuery).toBe('second');
    selectProject(); search('stale');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' })); advance(300);
    expect(current()).toEqual(empty);
    expect(screen.getByPlaceholderText('Search tasks by title or description...')).toHaveValue('');
  });
  test('does not publish pending search after unmount', () => {
    const changed = vi.fn(); const view = render(<Harness onChange={changed} />); advance(300); changed.mockClear();
    search('cancelled'); view.unmount(); advance(300);
    expect(changed).not.toHaveBeenCalled();
  });
});
