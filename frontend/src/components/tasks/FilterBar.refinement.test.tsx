// @vitest-environment jsdom
//
// Owner ruling E395 (board filters): in every multi-select filter of the Tasks
// board - Priority, Status, Tags, Project and Phase, which the Map shares -
//   (1) the selected items always lead the list, in a "Selected" group above
//       the rest, and the filter's search narrows both groups;
//   (2) each filter has its own clear control: a "Clear" action inside its
//       dropdown and a small x beside its button while it has a selection;
//       either clears THAT filter only, and "Clear All" still clears all;
//   (3) each clear control is named for its filter, both work from the
//       keyboard, focus lands on a stated control afterwards, the x never
//       takes over the filter button's own activation, and the Selected group
//       is a named group a screen reader announces.
//
// Two tests here are the declared reds of controls in
// scripts/ui-refinement-mutations.py ("selected items lead every filter list"
// and "a clear control empties only its own filter"): keep their titles exact.
import { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { FilterBar, type TaskFilters } from './FilterBar';
import type { PhaseFilterOption, PhaseFilterProject } from './phaseFilterScope';

const RELAYHALL_ID = '11111111-1111-4111-8111-111111111111';
const SHOP_ID = '22222222-2222-4222-8222-222222222222';
const PROJECTS: PhaseFilterProject[] = [
  { id: RELAYHALL_ID, name: 'RelayHall' },
  { id: SHOP_ID, name: 'Storefront' },
];
const PHASES: PhaseFilterOption[] = [
  { id: 'phase-rh-1', name: '01 · Authored knowledge', position: 10, projectId: RELAYHALL_ID },
  { id: 'phase-shop-1', name: 'Shop launch', position: 1, projectId: SHOP_ID },
  { id: 'phase-shop-2', name: 'Checkout polish', position: 2, projectId: SHOP_ID },
];
const TAGS = ['alpha', 'beta', 'gamma', 'zeta'];
const PROJECT_NAMES = ['Alpha', 'RelayHall', 'Storefront', 'Zeta'];

const empty: TaskFilters = {
  searchQuery: '', priorities: [], tags: [], projects: [], phases: [], statuses: [],
  mine: false, owner: null, unassigned: false, verifierUnusable: false,
};
/** A selection in every list filter, and the other filters set too, so a
 *  clear that reaches past its own filter changes something visible. */
const everything: TaskFilters = {
  searchQuery: 'report', priorities: ['high', 'low'], tags: ['zeta'], projects: ['Storefront'],
  phases: ['phase-shop-2'], statuses: ['review'], mine: false, owner: 'pat', unassigned: false, verifierUnusable: true,
};

type ListKey = 'priorities' | 'statuses' | 'tags' | 'projects' | 'phases';
const FILTERS: Array<{ key: ListKey; name: string }> = [
  { key: 'priorities', name: 'Priority' },
  { key: 'statuses', name: 'Status' },
  { key: 'tags', name: 'Tags' },
  { key: 'projects', name: 'Project' },
  { key: 'phases', name: 'Phase' },
];

function Harness({ initial }: { initial: TaskFilters }) {
  const [filters, setFilters] = useState<TaskFilters>(initial);
  return (
    <>
      <FilterBar
        tasks={[]}
        filters={filters}
        onFiltersChange={setFilters}
        availableTags={TAGS}
        availableProjects={PROJECT_NAMES}
        availableOwners={['pat']}
        availablePhases={PHASES}
        phaseProjects={PROJECTS}
      />
      <output data-testid="filters">{JSON.stringify(filters)}</output>
    </>
  );
}

const current = (): TaskFilters => JSON.parse(screen.getByTestId('filters').textContent!);
/** The filter's own button: its name starts with the filter's name (a count
 *  badge may follow); the clear controls' names start with "Clear". */
const trigger = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}\\b`) });
const menuOf = (name: string) => {
  const menu = trigger(name).closest('.filter-dropdown')!.querySelector<HTMLElement>('.filter-dropdown-menu');
  expect(menu, `${name} menu is not open`).not.toBeNull();
  return menu!;
};
const optionNames = (root: HTMLElement) =>
  within(root).queryAllByRole('checkbox').map(box => box.closest('label')!.textContent);
const selectedGroup = (menu: HTMLElement) => within(menu).queryByRole('group', { name: 'Selected' });
const open = (name: string) => fireEvent.click(trigger(name));

afterEach(cleanup);

describe('(1) the selected items lead the list', () => {
  test('selected items lead every filter list', () => {
    render(<Harness initial={everything} />);
    const expected: Record<string, { selected: string[]; all: string[] }> = {
      Priority: { selected: ['high', 'low'], all: ['high', 'low', 'urgent', 'normal', 'someday'] },
      Status: { selected: ['Review'], all: ['Review', 'Ideas', 'To do', 'In progress', 'Stuck', 'Completed', 'Archived'] },
      Tags: { selected: ['zeta'], all: ['zeta', 'alpha', 'beta', 'gamma'] },
      Project: { selected: ['#Storefront'], all: ['#Storefront', '#Alpha', '#RelayHall', '#Zeta'] },
      // Scoped to Storefront by the Project filter; the backlog leads the rest.
      Phase: { selected: ['#2 Checkout polish'], all: ['#2 Checkout polish', 'Backlog (no phase)', '#1 Shop launch'] },
    };
    for (const { name } of FILTERS) {
      open(name);
      const menu = menuOf(name);
      expect(optionNames(menu), `${name}: list order`).toEqual(expected[name].all);
      expect(optionNames(selectedGroup(menu)!), `${name}: the Selected group`).toEqual(expected[name].selected);
      // Ticked exactly where they are listed first.
      expect(within(menu).getAllByRole('checkbox').map(box => (box as HTMLInputElement).checked))
        .toEqual(expected[name].all.map((_, index) => index < expected[name].selected.length));
    }
    // A selected backlog leads the Phase list as any selected Phase does.
    cleanup();
    render(<Harness initial={{ ...empty, phases: ['null'], projects: ['Storefront'] }} />);
    open('Phase');
    expect(optionNames(menuOf('Phase'))).toEqual(['Backlog (no phase)', '#1 Shop launch', '#2 Checkout polish']);
    cleanup();
    render(<Harness initial={{ ...empty, phases: ['phase-shop-2'], projects: ['Storefront'] }} />);
    open('Phase');
    expect(optionNames(menuOf('Phase'))).toEqual(['#2 Checkout polish', 'Backlog (no phase)', '#1 Shop launch']);
  });

  test('with nothing selected there is no Selected group and the list keeps its order', () => {
    render(<Harness initial={empty} />);
    for (const { name } of FILTERS) {
      open(name);
      expect(selectedGroup(menuOf(name)), name).toBeNull();
    }
    open('Priority');
    expect(optionNames(menuOf('Priority'))).toEqual(['urgent', 'high', 'normal', 'low', 'someday']);
  });

  test('a tick moves nothing while the list is open; the next opening sorts it', () => {
    render(<Harness initial={empty} />);
    open('Project');
    const box = screen.getByRole('checkbox', { name: '#RelayHall' });
    box.focus();
    fireEvent.click(box);
    expect(current().projects).toEqual(['RelayHall']);
    // The same element, still focused, still in its place.
    expect(screen.getByRole('checkbox', { name: '#RelayHall' })).toBe(box);
    expect(box).toHaveFocus();
    expect(box).toBeChecked();
    expect(optionNames(menuOf('Project'))).toEqual(['#Alpha', '#RelayHall', '#Storefront', '#Zeta']);
    // Closed and opened again: it leads.
    open('Project');
    open('Project');
    expect(optionNames(selectedGroup(menuOf('Project'))!)).toEqual(['#RelayHall']);
    // Unticked in the open list it stays put, unticked, until the next opening.
    fireEvent.click(screen.getByRole('checkbox', { name: '#RelayHall' }));
    expect(current().projects).toEqual([]);
    expect(optionNames(selectedGroup(menuOf('Project'))!)).toEqual(['#RelayHall']);
    expect(screen.getByRole('checkbox', { name: '#RelayHall' })).not.toBeChecked();
    open('Project');
    open('Project');
    expect(selectedGroup(menuOf('Project'))).toBeNull();
    expect(optionNames(menuOf('Project'))).toEqual(['#Alpha', '#RelayHall', '#Storefront', '#Zeta']);
  });

  test('a clear sorts the open list at once: the Selected group goes', () => {
    render(<Harness initial={{ ...empty, tags: ['gamma'] }} />);
    open('Tags');
    expect(optionNames(selectedGroup(menuOf('Tags'))!)).toEqual(['gamma']);
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear Tags filter' })[0]);
    expect(current().tags).toEqual([]);
    expect(selectedGroup(menuOf('Tags'))).toBeNull();
    expect(optionNames(menuOf('Tags'))).toEqual(['alpha', 'beta', 'gamma', 'zeta']);
  });

  test('the search box narrows both the Selected group and the rest', () => {
    render(<Harness initial={{ ...empty, tags: ['alpha', 'zeta'], projects: ['RelayHall', 'Zeta'] }} />);
    open('Tags');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tags' }), { target: { value: 'ta' } });
    let menu = menuOf('Tags');
    expect(optionNames(selectedGroup(menu)!)).toEqual(['zeta']);
    expect(new Set(optionNames(menu))).toEqual(new Set(['zeta', 'beta']));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tags' }), { target: { value: 'gam' } });
    menu = menuOf('Tags');
    expect(selectedGroup(menu)).toBeNull();
    expect(optionNames(menu)).toEqual(['gamma']);

    open('Project');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search projects' }), { target: { value: 'relay' } });
    menu = menuOf('Project');
    expect(optionNames(selectedGroup(menu)!)).toEqual(['#RelayHall']);
    expect(optionNames(menu)).toEqual(['#RelayHall']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search projects' }), { target: { value: 'nothing-matches' } });
    expect(within(menuOf('Project')).getByText('No projects found')).toBeInTheDocument();
  });

  test('the Phase search narrows the Selected group by name and number; the backlog is always offered', () => {
    render(<Harness initial={{ ...empty, phases: ['phase-shop-2', 'phase-rh-1'] }} />);
    open('Phase');
    const search = () => screen.getByRole('textbox', { name: 'Search phases' });
    // No Project selected: the rest is grouped by Project, and a selected
    // Phase has left its Project's group for the Selected group.
    let menu = menuOf('Phase');
    expect(optionNames(selectedGroup(menu)!)).toEqual(['#10 01 · Authored knowledge', '#2 Checkout polish']);
    expect(within(menu).queryByRole('group', { name: 'RelayHall' })).toBeNull();
    expect(optionNames(within(menu).getByRole('group', { name: 'Storefront' }))).toEqual(['#1 Shop launch']);
    fireEvent.change(search(), { target: { value: '#2' } });
    menu = menuOf('Phase');
    expect(optionNames(selectedGroup(menu)!)).toEqual(['#2 Checkout polish']);
    expect(new Set(optionNames(menu))).toEqual(new Set(['#2 Checkout polish', 'Backlog (no phase)']));
    // A query only a selected Phase matches does not say nothing was found.
    expect(within(menu).queryByText('No phases found')).toBeNull();
    fireEvent.change(search(), { target: { value: 'nothing-matches' } });
    menu = menuOf('Phase');
    expect(selectedGroup(menu)).toBeNull();
    expect(within(menu).getByText('No phases found')).toBeInTheDocument();
  });

  test('a selected backlog joins the Selected group and leaves the rest', () => {
    render(<Harness initial={{ ...empty, phases: ['null'] }} />);
    open('Phase');
    const menu = menuOf('Phase');
    expect(optionNames(selectedGroup(menu)!)).toEqual(['Backlog (no phase)']);
    expect(optionNames(menu).filter(name => name === 'Backlog (no phase)')).toHaveLength(1);
  });

  test('screen readers hear the Selected group: a role=group named by its visible label', () => {
    render(<Harness initial={everything} />);
    for (const { name } of FILTERS) {
      open(name);
      const group = selectedGroup(menuOf(name))!;
      const label = document.getElementById(group.getAttribute('aria-labelledby')!)!;
      expect(label, name).toHaveTextContent(/^Selected$/);
      expect(label, name).toBeVisible();
      expect(group, name).toContainElement(label);
    }
  });
});

describe('(2) each filter has its own clear control', () => {
  test('a clear control empties only its own filter', () => {
    for (const { key, name } of FILTERS) {
      for (const via of ['x', 'menu'] as const) {
        render(<Harness initial={everything} />);
        if (via === 'x') {
          fireEvent.click(screen.getByRole('button', { name: `Clear ${name} filter` }));
        } else {
          open(name);
          fireEvent.click(within(menuOf(name)).getByRole('button', { name: `Clear ${name} filter` }));
        }
        expect(current(), `${name} via ${via}`).toEqual({ ...everything, [key]: [] });
        // The main search is left as typed, not merely as stored.
        expect(screen.getByPlaceholderText('Search tasks by title or description...')).toHaveValue('report');
        cleanup();
      }
    }
  });

  test('clearing leaves the state a manual deselect leaves', () => {
    render(<Harness initial={{ ...empty, projects: ['RelayHall'] }} />);
    open('Project');
    fireEvent.click(screen.getByLabelText('#RelayHall'));
    const deselected = current();
    cleanup();
    render(<Harness initial={{ ...empty, projects: ['RelayHall'] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Project filter' }));
    expect(current()).toEqual(deselected);
  });

  test('the x shows only while its filter has a selection; the in-menu Clear likewise', () => {
    render(<Harness initial={{ ...empty, statuses: ['todo'] }} />);
    expect(screen.getByRole('button', { name: 'Clear Status filter' })).toBeInTheDocument();
    for (const name of ['Priority', 'Tags', 'Project', 'Phase']) {
      expect(screen.queryByRole('button', { name: `Clear ${name} filter` }), name).toBeNull();
      open(name);
      expect(within(menuOf(name)).queryByRole('button', { name: `Clear ${name} filter` }), `${name} menu`).toBeNull();
    }
    open('Status');
    fireEvent.click(within(menuOf('Status')).getByRole('button', { name: 'Clear Status filter' }));
    expect(screen.queryAllByRole('button', { name: 'Clear Status filter' })).toHaveLength(0);
    // The menu stays open on the full, unselected list.
    expect(optionNames(menuOf('Status'))).toHaveLength(7);
  });

  test('the in-menu Clear reads "Clear"; Clear All still clears every filter', () => {
    render(<Harness initial={everything} />);
    open('Tags');
    expect(within(menuOf('Tags')).getByRole('button', { name: 'Clear Tags filter' })).toHaveTextContent(/^Clear$/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(current()).toEqual(empty);
  });
});

describe('(3) keyboard, focus and the x beside the button', () => {
  test('the x clears from the keyboard and hands focus to its filter button', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...empty, projects: ['Storefront'] }} />);
    const x = screen.getByRole('button', { name: 'Clear Project filter' });
    // The x is reached by Tab straight after its filter button.
    trigger('Project').focus();
    await user.tab();
    expect(x).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(current().projects).toEqual([]);
    expect(trigger('Project')).toHaveFocus();
    expect(trigger('Project')).toHaveAttribute('aria-expanded', 'false');
  });

  test('Space on the x clears too; the filter button then still opens its menu from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...empty, priorities: ['urgent'] }} />);
    screen.getByRole('button', { name: 'Clear Priority filter' }).focus();
    await user.keyboard(' ');
    expect(current().priorities).toEqual([]);
    expect(trigger('Priority')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(trigger('Priority')).toHaveAttribute('aria-expanded', 'true');
    expect(menuOf('Priority')).toBeInTheDocument();
  });

  test('the x does not take over the filter button: the button opens its menu and clears nothing', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...empty, tags: ['beta'] }} />);
    const x = screen.getByRole('button', { name: 'Clear Tags filter' });
    // Separate controls, never nested: a button inside a button is invalid.
    expect(trigger('Tags')).not.toContainElement(x);
    expect(x).not.toContainElement(trigger('Tags'));
    await user.click(trigger('Tags'));
    expect(current().tags).toEqual(['beta']);
    expect(trigger('Tags')).toHaveAttribute('aria-expanded', 'true');
    // Opening hands focus to the search box; take it back to the button.
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search tags' })).toHaveFocus());
    trigger('Tags').focus();
    await user.keyboard('{Enter}');
    expect(current().tags).toEqual(['beta']);
    expect(trigger('Tags')).toHaveAttribute('aria-expanded', 'false');
    // And the x clears without opening the menu.
    await user.click(x);
    expect(current().tags).toEqual([]);
    expect(trigger('Tags')).toHaveAttribute('aria-expanded', 'false');
  });

  test('the in-menu Clear works from the keyboard and leaves focus in the search box', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...empty, projects: ['Zeta'] }} />);
    await user.click(trigger('Project'));
    const search = screen.getByRole('textbox', { name: 'Search projects' });
    await waitFor(() => expect(search).toHaveFocus());
    await user.tab();
    const clear = within(menuOf('Project')).getByRole('button', { name: 'Clear Project filter' });
    expect(clear).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(current().projects).toEqual([]);
    expect(search).toHaveFocus();
    expect(selectedGroup(menuOf('Project'))).toBeNull();
  });

  test('without a search box, the in-menu Clear leaves focus on the first item', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...empty, statuses: ['stuck'] }} />);
    await user.click(trigger('Status'));
    // From the button: its x, then into the open menu.
    await user.tab();
    expect(screen.getAllByRole('button', { name: 'Clear Status filter' })[0]).toHaveFocus();
    await user.tab();
    const clear = within(menuOf('Status')).getByRole('button', { name: 'Clear Status filter' });
    expect(clear).toHaveFocus();
    await user.keyboard(' ');
    expect(current().statuses).toEqual([]);
    expect(screen.getByRole('checkbox', { name: 'Ideas' })).toHaveFocus();
  });

  test('focus order inside a menu: search box, its clear, the filter Clear, then the items', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...empty, phases: ['phase-shop-1'] }} />);
    await user.click(trigger('Phase'));
    const search = screen.getByRole('textbox', { name: 'Search phases' });
    await waitFor(() => expect(search).toHaveFocus());
    await user.type(search, 'shop');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Clear phase search' })).toHaveFocus();
    await user.tab();
    expect(within(menuOf('Phase')).getByRole('button', { name: 'Clear Phase filter' })).toHaveFocus();
    await user.tab();
    // Then the items (which item comes first is the ordering test's business).
    expect(document.activeElement).toHaveAttribute('type', 'checkbox');
    expect(menuOf('Phase')).toContainElement(document.activeElement as HTMLElement);
  });
});
