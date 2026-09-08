// @vitest-environment jsdom
/**
 * AccessVehicle.test.tsx — RH-P3.AZ-S7 (owner ruling 7440b579 R5): the two
 * task-side affordances the ruling names — a Warrant SUGGESTED at task
 * creation, and the "task → its vehicle" linkage view.
 *
 * The load-bearing behaviour under test is not "it renders": it is that the
 * suggestion never becomes a selection (leaving it unset is a real choice
 * that takes the auto-grant fallback), that a warrant which stops being on
 * offer cannot linger as a stale choice, and that the linkage view tells a
 * reader which rows the vehicle OWNS and which it merely depends on —
 * because that distinction is what owner default D4 rests on.
 */
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import AccessVehiclePicker from './AccessVehiclePicker';
import TaskAccessVehicle from './TaskAccessVehicle';
import { authenticatedFetch } from '../../utils/auth';

vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const fetchMock = authenticatedFetch as unknown as ReturnType<typeof vi.fn>;
const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body } as Response);

const SUGGESTION = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  name: 'Phase 3 delivery',
  status: 'active',
  expiresAt: null,
  holderHandle: 'connector-runner',
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('AccessVehiclePicker — the R5 suggestion at task creation', () => {
  it('renders nothing at all when no Connector is being assigned', () => {
    const { container } = render(
      <AccessVehiclePicker phaseId="p1" assigned={false} value={null} onChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers the warrants covering the phase, with the fallback as a real first-class choice', async () => {
    fetchMock.mockImplementation(() => ok({ suggestions: [SUGGESTION] }));
    render(<AccessVehiclePicker phaseId="p1" assigned value={null} onChange={() => {}} />);

    const select = await screen.findByLabelText(/warrant/i);
    expect(select).toHaveAccessibleName();
    // The fallback is an OPTION, not an absence — R2(b) says a vehicle-less
    // assignment materializes auto-grants, never zero access.
    expect(screen.getByRole('option', { name: /automatic grant/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Phase 3 delivery/ })).toBeInTheDocument();
  });

  it('reports the fallback plainly when no warrant covers the phase', async () => {
    fetchMock.mockImplementation(() => ok({ suggestions: [] }));
    render(<AccessVehiclePicker phaseId="p1" assigned value={null} onChange={() => {}} />);
    expect(await screen.findByText(/No live Warrant covers this Phase/i)).toBeInTheDocument();
  });

  it('still lets the task be created when the warrant plane cannot be read', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, json: async () => ({}) } as Response));
    render(<AccessVehiclePicker phaseId="p1" assigned value={null} onChange={() => {}} />);
    // A suggestion is an affordance, not a gate: it degrades to the
    // fallback rather than blocking the create.
    expect(await screen.findByText(/take the automatic grant/i)).toBeInTheDocument();
  });

  it('says so, and asks for nothing, when the task has no phase', () => {
    render(<AccessVehiclePicker phaseId={null} assigned value={null} onChange={() => {}} />);
    expect(screen.getByText(/no Phase, so it takes the automatic grant/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a choice that is no longer on offer rather than letting the server refuse it later', async () => {
    const onChange = vi.fn();
    fetchMock.mockImplementation(() => ok({ suggestions: [] }));
    render(<AccessVehiclePicker phaseId="p1" assigned value={SUGGESTION.id} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  });

  it('reports the chosen warrant upward, and the fallback as null', async () => {
    const onChange = vi.fn();
    fetchMock.mockImplementation(() => ok({ suggestions: [SUGGESTION] }));
    render(<AccessVehiclePicker phaseId="p1" assigned value={null} onChange={onChange} />);
    const select = await screen.findByLabelText(/warrant/i);
    await userEvent.selectOptions(select, SUGGESTION.id);
    expect(onChange).toHaveBeenCalledWith(SUGGESTION.id);
    await userEvent.selectOptions(select, '');
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('TaskAccessVehicle — the R5 task → its vehicle linkage', () => {
  const assignment = {
    taskId: 't1',
    executionServiceId: 's1',
    executionServiceName: 'Runner',
    carriedBy: 'grant' as const,
    warrantName: null,
    warrantStatus: null,
  };
  const grantLink = {
    id: 'l1',
    carriedBy: 'grant' as const,
    warrantName: null,
    targetKind: 'grant' as const,
    createdByAssignment: true,
    landedOnHandle: 'runner-account',
    resourceType: 'task',
    resourceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    verb: 'read',
    profileName: null,
  };

  it('renders nothing for an unassigned task', async () => {
    fetchMock.mockImplementation(() => ok({ assignment: { ...assignment, executionServiceId: null }, links: [] }));
    const { container } = render(<TaskAccessVehicle taskId="t1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('names the connector and the automatic grant, and when it is released', async () => {
    fetchMock.mockImplementation(() => ok({ assignment, links: [grantLink] }));
    render(<TaskAccessVehicle taskId="t1" />);
    expect(await screen.findByText(/Runner/)).toBeInTheDocument();
    expect(screen.getByText(/released when the Task finishes or is unassigned/i)).toBeInTheDocument();
  });

  it('names the warrant, and that revoking it unassigns the task', async () => {
    fetchMock.mockImplementation(() => ok({
      assignment: { ...assignment, carriedBy: 'warrant', warrantName: 'Phase 3 delivery', warrantStatus: 'active' },
      links: [{ ...grantLink, carriedBy: 'warrant', targetKind: 'profile_assignment', profileName: 'Delivery set' }],
    }));
    render(<TaskAccessVehicle taskId="t1" />);
    expect(await screen.findByText(/Phase 3 delivery/)).toBeInTheDocument();
    expect(screen.getByText(/Revoking that Warrant unassigns this Task/i)).toBeInTheDocument();
  });

  // Owner default D4: the vehicle never deletes a row it did not create, so
  // a reader must be able to SEE which rows those are.
  it('marks a pre-existing row the vehicle only depends on', async () => {
    fetchMock.mockImplementation(() => ok({
      assignment,
      links: [{ ...grantLink, createdByAssignment: false }],
    }));
    render(<TaskAccessVehicle taskId="t1" />);
    expect(await screen.findByText(/pre-existing/i)).toBeInTheDocument();
    expect(screen.getByText(/will not remove it/i)).toBeInTheDocument();
  });

  it('does not mark a row the vehicle created', async () => {
    fetchMock.mockImplementation(() => ok({ assignment, links: [grantLink] }));
    render(<TaskAccessVehicle taskId="t1" />);
    await screen.findByText(/Runner/);
    expect(screen.queryByText(/pre-existing/i)).not.toBeInTheDocument();
  });
});
