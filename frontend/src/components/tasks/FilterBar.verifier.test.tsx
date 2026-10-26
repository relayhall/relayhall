// @vitest-environment jsdom
// Card 41e24358 (design ba22fd01 Part 7): the "without a usable Verifier" filter.
import { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FilterBar, type TaskFilters } from './FilterBar';
import { parseFiltersFromParams } from '../../pages/TasksPage';

vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async () => ({ ok: true, json: async () => ({ success: true, phases: [] }) })),
}));
const empty: TaskFilters = { searchQuery: '', priorities: [], tags: [], projects: [], phases: [], statuses: [] };
function Harness() {
  const [filters, setFilters] = useState<TaskFilters>(empty);
  return <><FilterBar tasks={[]} filters={filters} onFiltersChange={setFilters} />
    <output data-testid="filters">{JSON.stringify(filters)}</output></>;
}
const current = () => JSON.parse(screen.getByTestId('filters').textContent!);

afterEach(() => { cleanup(); });

describe('the usable-Verifier filter', () => {
  test('toggles verifierUnusable, reports it pressed and counts it in Clear All', () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: 'Without a usable Verifier' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(current().verifierUnusable).toBe(true);
    expect(screen.getByRole('button', { name: 'Without a usable Verifier' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(current().verifierUnusable).toBe(false);
  });

  test('a deep link restores it, and nothing else turns it on', () => {
    expect(parseFiltersFromParams(new URLSearchParams('verifierUnusable=true&statuses=todo,review')))
      .toMatchObject({ hasAny: true, filters: { verifierUnusable: true, statuses: ['todo', 'review'] } });
    expect(parseFiltersFromParams(new URLSearchParams('verifierUnusable=yes')).filters.verifierUnusable).toBe(false);
  });
});
