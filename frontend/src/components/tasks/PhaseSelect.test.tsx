// @vitest-environment jsdom
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../../utils/auth';
import { PhaseSelect } from './PhaseSelect';

vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const mockFetch = vi.mocked(authenticatedFetch);

const PHASES = [
  { id: 'ph-1', name: 'Substrate', status: 'in-progress', position: 0 },
  { id: 'ph-2', name: 'Enforcement', status: 'archived', position: 1 },
];

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => ({
    ok: true, status: 200, json: async () => ({ success: true, phases: PHASES }),
  } as Response));
});
afterEach(cleanup);

describe('PhaseSelect — the one phase control every task surface renders', () => {
  test('offers nothing and says why when no project is chosen', async () => {
    render(<PhaseSelect projectId={null} value="" onChange={() => {}} />);
    const select = screen.getByRole('combobox');
    expect(select).toBeDisabled();
    expect(screen.getByText('Select a project first')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('calls the unphased option the backlog, not a missing value', async () => {
    render(<PhaseSelect projectId="p1" value="" onChange={() => {}} />);
    expect(await screen.findByText('No phase (backlog)')).toBeInTheDocument();
  });

  test('lists the project\'s phases and marks archived ones', async () => {
    render(<PhaseSelect projectId="p1" value="" onChange={() => {}} />);
    expect(await screen.findByText('#0 Substrate')).toBeInTheDocument();
    expect(screen.getByText('#1 Enforcement (archived)')).toBeInTheDocument();
  });

  test('reports the selected phase id to the caller', async () => {
    const onChange = vi.fn();
    render(<PhaseSelect projectId="p1" value="" onChange={onChange} />);
    await screen.findByText('#0 Substrate');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'ph-1');
    expect(onChange).toHaveBeenCalledWith('ph-1');
  });

  test('keeps an unlisted stored membership visible instead of showing it as backlog', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true, status: 200, json: async () => ({ success: true, phases: [] }),
    } as Response));
    render(
      <PhaseSelect
        projectId="p1"
        value="ph-gone"
        onChange={() => {}}
        currentPhase={{ id: 'ph-gone', name: 'Retired phase' }}
      />,
    );
    expect(await screen.findByText('Retired phase')).toBeInTheDocument();
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('ph-gone');
  });

  test('re-reads when the project changes, so a stale list is never offered', async () => {
    const { rerender } = render(<PhaseSelect projectId="p1" value="" onChange={() => {}} />);
    await screen.findByText('#0 Substrate');
    rerender(<PhaseSelect projectId="p2" value="" onChange={() => {}} />);
    await waitFor(() => {
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/projects/p2/phases'))).toBe(true);
    });
  });
});
