// @vitest-environment jsdom
//
// Card 096fda30 (owner E67): on the Tasks board the Phase dropdown follows the
// Project filter and has a "Search phases" box that behaves like the Project
// search. The owner's report: filtered to one Project, the dropdown still listed
// another Project's Phases and had no search.
import { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FilterBar, type TaskFilters } from './FilterBar';
import type { PhaseFilterOption, PhaseFilterProject } from './phaseFilterScope';

const { RELAYHALL_ID, SHOP_ID, WIRE_PHASES } = vi.hoisted(() => {
  const relayhall = '11111111-1111-4111-8111-111111111111';
  const shop = '22222222-2222-4222-8222-222222222222';
  return {
    RELAYHALL_ID: relayhall,
    SHOP_ID: shop,
    WIRE_PHASES: [
      { id: 'phase-rh-1', name: '01 · Authored knowledge', position: 10, projectId: relayhall },
      { id: 'phase-rh-2', name: '10 · Release lane', position: 11, projectId: relayhall },
      { id: 'phase-shop-1', name: 'Shop launch', position: 1, projectId: shop },
      { id: 'phase-shop-2', name: 'Checkout polish', position: 2, projectId: shop },
    ],
  };
});

// The filter bar before this card fetched GET /phases itself. Answering that
// read as the server would keeps a run of these tests against those sources a
// BEHAVIOURAL red — every Phase listed whatever the Project filter says, no
// search box — rather than a harness crash. The filter bar this card ships
// receives its catalog from the board page and reads nothing itself.
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, phases: WIRE_PHASES }))),
}));

const PROJECTS: PhaseFilterProject[] = [
  { id: RELAYHALL_ID, name: 'RelayHall' },
  { id: SHOP_ID, name: 'Storefront' },
];
const PHASES: PhaseFilterOption[] = WIRE_PHASES;
const empty: TaskFilters = { searchQuery: '', priorities: [], tags: [], projects: [], phases: [], statuses: [], mine: false, owner: null, unassigned: false };

function Harness({ initial = empty, projects = PROJECTS as PhaseFilterProject[] | null }: { initial?: TaskFilters; projects?: PhaseFilterProject[] | null }) {
  const [filters, setFilters] = useState<TaskFilters>(initial);
  return (
    <>
      <FilterBar
        tasks={[]}
        filters={filters}
        onFiltersChange={setFilters}
        availableProjects={['RelayHall', 'Storefront']}
        availablePhases={PHASES}
        phaseProjects={projects}
      />
      <output data-testid="filters">{JSON.stringify(filters)}</output>
    </>
  );
}

const current = (): TaskFilters => JSON.parse(screen.getByTestId('filters').textContent!);
const openPhases = async () => {
  // Let any read the component makes settle first (none in this card's
  // filter bar; GET /phases in the one before it).
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Phase' }));
  act(() => { vi.advanceTimersByTime(20); });
};
const phaseOptionNames = () => screen.getAllByRole('checkbox').map(box => box.closest('label')!.textContent);
const groupNames = () => screen.getAllByRole('group')
  .map(group => document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent);
const searchPhases = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Search phases' }), { target: { value } });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('the Phase list follows the Project filter', () => {
  test('with Storefront selected it lists only Storefront Phases (the owner’s report)', async () => {
    render(<Harness initial={{ ...empty, projects: ['Storefront'] }} />);
    await openPhases();
    expect(phaseOptionNames()).toEqual(['Backlog (no phase)', '#1 Shop launch', '#2 Checkout polish']);
    expect(screen.queryByLabelText('#10 01 · Authored knowledge')).toBeNull();
    expect(screen.queryByLabelText('#11 10 · Release lane')).toBeNull();
  });

  test('selecting a Project narrows the open list at once', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.click(screen.getByLabelText('#RelayHall'));
    await openPhases();
    expect(phaseOptionNames()).toEqual(['Backlog (no phase)', '#10 01 · Authored knowledge', '#11 10 · Release lane']);
  });

  test('two Projects list both, each under its own Project', async () => {
    render(<Harness initial={{ ...empty, projects: ['Storefront', 'RelayHall'] }} />);
    await openPhases();
    expect(groupNames()).toEqual(['RelayHall', 'Storefront']);
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
  });

  test('a Project id from a link scopes exactly as its name does', async () => {
    render(<Harness initial={{ ...empty, projects: [RELAYHALL_ID] }} />);
    await openPhases();
    expect(phaseOptionNames()).toEqual(['Backlog (no phase)', '#10 01 · Authored knowledge', '#11 10 · Release lane']);
  });

  test('with no Project selected it lists every Phase, grouped and labelled by Project', async () => {
    render(<Harness />);
    await openPhases();
    const shop = screen.getByRole('group', { name: 'Storefront' });
    const relayhall = screen.getByRole('group', { name: 'RelayHall' });
    expect(within(shop).getAllByRole('checkbox').map(box => box.closest('label')!.textContent))
      .toEqual(['#1 Shop launch', '#2 Checkout polish']);
    expect(within(relayhall).getAllByRole('checkbox').map(box => box.closest('label')!.textContent))
      .toEqual(['#10 01 · Authored knowledge', '#11 10 · Release lane']);
    // The backlog is not a Phase of any Project: it stays outside the groups.
    expect(within(shop).queryByLabelText('Backlog (no phase)')).toBeNull();
    expect(screen.getByLabelText('Backlog (no phase)')).toBeInTheDocument();
  });

  test('while the Project directory is unknown nothing is hidden or grouped', async () => {
    render(<Harness initial={{ ...empty, projects: ['Storefront'] }} projects={null} />);
    await openPhases();
    expect(screen.queryAllByRole('group')).toHaveLength(0);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1 + PHASES.length);
  });

  test('a Project with no Phases says so instead of showing an empty list', async () => {
    render(<FilterBar tasks={[]} filters={{ ...empty, projects: ['Storefront'] }} onFiltersChange={() => {}}
      availablePhases={PHASES.filter(phase => phase.projectId === RELAYHALL_ID)} phaseProjects={PROJECTS} />);
    await openPhases();
    expect(screen.getByText('No phases in the selected projects')).toBeInTheDocument();
  });

  test('ticking an offered Phase still selects it', async () => {
    render(<Harness initial={{ ...empty, projects: ['Storefront'] }} />);
    await openPhases();
    fireEvent.click(screen.getByLabelText('#1 Shop launch'));
    expect(current().phases).toEqual(['phase-shop-1']);
  });
});

describe('"Search phases" — the Project search’s behaviour, on name and number', () => {
  test('the box is named "Search phases", not merely placeholdered', async () => {
    render(<Harness />);
    await openPhases();
    const box = screen.getByRole('textbox', { name: 'Search phases' });
    expect(box).toHaveAttribute('aria-label', 'Search phases');
    expect(box).toHaveAttribute('placeholder', 'Search phases...');
  });

  test('the box takes focus when the dropdown opens', async () => {
    render(<Harness />);
    await openPhases();
    expect(screen.getByPlaceholderText('Search phases...')).toHaveFocus();
  });

  test('the query is emptied when the dropdown closes', async () => {
    render(<Harness />);
    await openPhases();
    fireEvent.change(screen.getByPlaceholderText('Search phases...'), { target: { value: 'launch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Phase' }));
    await openPhases();
    expect(screen.getByPlaceholderText('Search phases...')).toHaveValue('');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1 + PHASES.length);
  });

  test('matches the Phase name, case-insensitively', async () => {
    render(<Harness />);
    await openPhases();
    searchPhases('AUTHORED');
    expect(phaseOptionNames()).toEqual(['Backlog (no phase)', '#10 01 · Authored knowledge']);
    expect(screen.getAllByRole('group').map(group => group.textContent)).toEqual(['RelayHall#10 01 · Authored knowledge']);
  });

  test('matches the Phase number, with or without #', async () => {
    render(<Harness />);
    await openPhases();
    searchPhases('#11');
    expect(phaseOptionNames()).toEqual(['Backlog (no phase)', '#11 10 · Release lane']);
    searchPhases('2');
    expect(phaseOptionNames()).toEqual(['Backlog (no phase)', '#2 Checkout polish']);
  });

  test('does not match the Project name or the Phase id', async () => {
    render(<Harness />);
    await openPhases();
    searchPhases('storefront');
    expect(screen.getByText('No phases found')).toBeInTheDocument();
    searchPhases('phase-rh');
    expect(screen.getByText('No phases found')).toBeInTheDocument();
  });

  test('searches within the Project scope, never past it', async () => {
    render(<Harness initial={{ ...empty, projects: ['Storefront'] }} />);
    await openPhases();
    searchPhases('release');
    expect(screen.getByText('No phases found')).toBeInTheDocument();
    expect(screen.queryByLabelText('#11 10 · Release lane')).toBeNull();
  });

  test('the clear button empties the query and returns focus to the box', async () => {
    render(<Harness />);
    await openPhases();
    searchPhases('launch');
    // fireEvent.click never moves focus, so the button is focused first, as a
    // real click or Enter would focus it. The button then unmounts with the
    // emptied query; without the refocus, focus would fall to <body>.
    const clear = screen.getByRole('button', { name: 'Clear phase search' });
    clear.focus();
    expect(clear).toHaveFocus();
    fireEvent.click(clear);
    const box = screen.getByRole('textbox', { name: 'Search phases' });
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1 + PHASES.length);
  });

  test('focus order: the box, its clear button, then the options', async () => {
    render(<Harness />);
    await openPhases();
    searchPhases('o');
    const menu = screen.getByRole('textbox', { name: 'Search phases' }).closest('.filter-dropdown-menu')!;
    const focusable = Array.from(menu.querySelectorAll<HTMLElement>('input, button'));
    expect(focusable[0]).toBe(screen.getByRole('textbox', { name: 'Search phases' }));
    expect(focusable[1]).toBe(screen.getByRole('button', { name: 'Clear phase search' }));
    expect(focusable.slice(2).every(element => element.getAttribute('type') === 'checkbox')).toBe(true);
  });

  test('opening another filter closes the Phase dropdown', async () => {
    render(<Harness />);
    await openPhases();
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(screen.queryByRole('textbox', { name: 'Search phases' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Phase' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('the Phase scope notice', () => {
  test('is a mounted live region, empty until the board clears a Phase', async () => {
    const dismiss = vi.fn();
    const { rerender } = render(<FilterBar tasks={[]} filters={empty} onFiltersChange={() => {}}
      availablePhases={PHASES} phaseProjects={PROJECTS} onDismissPhaseScopeNotice={dismiss} />);
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    rerender(<FilterBar tasks={[]} filters={empty} onFiltersChange={() => {}}
      availablePhases={PHASES} phaseProjects={PROJECTS} onDismissPhaseScopeNotice={dismiss}
      phaseScopeNotice='Phase filter "#10 01 · Authored knowledge" was cleared: it is not in the selected projects.' />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Phase filter "#10 01 · Authored knowledge" was cleared: it is not in the selected projects.');
    fireEvent.click(within(region).getByRole('button', { name: 'Dismiss notice' }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
