// @vitest-environment jsdom
/**
 * THE RENDERED ROLE LIST EQUALS THE BACKEND CATALOGUE (card a2d1e317).
 *
 * `roleCatalogue.generated.json` is the board's `GET /principals/roles`
 * payload, rendered by the backend and held byte-equal to the catalogue module
 * by `backend/src/__tests__/roleCatalogueDoc.test.ts`. So "the list on the
 * screen equals this fixture" is "the list on the screen equals the backend
 * catalogue", with the backend half measured on the backend side.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import fixture from './roleCatalogue.generated.json';
import type { RoleCatalogueEntry } from '../../types/roleCatalogue';
import { RoleCatalogueList, RoleExplanation, RoleSelectionExplanation } from './RoleExplanation';

const ROLES = fixture.roles as unknown as RoleCatalogueEntry[];
const READY = { state: 'ready' as const, roles: ROLES };

afterEach(cleanup);

describe('the catalogue list', () => {
  test('lists exactly the catalogue roles, in the catalogue order', () => {
    render(<RoleCatalogueList catalogue={READY} />);
    const items = within(screen.getByRole('list', { name: 'Role catalogue' })).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('.role-cat-name')?.textContent)).toEqual(ROLES.map((entry) => entry.role));
  });

  test('every item carries its entry verbatim: purpose, both ceiling sentences, kinds and assigners', () => {
    render(<RoleCatalogueList catalogue={READY} />);
    const items = within(screen.getByRole('list', { name: 'Role catalogue' })).getAllByRole('listitem');
    items.forEach((item, index) => {
      const entry = ROLES[index];
      expect(item.querySelector('.role-expl-purpose')?.textContent).toBe(entry.purpose);
      const facts = Array.from(item.querySelectorAll('.role-expl-fact')).map((fact) => [
        fact.querySelector('dt')?.textContent, fact.querySelector('dd')?.textContent,
      ]);
      expect(facts).toEqual([['May reach', entry.mayReach], ['Never reaches', entry.neverReaches]]);
      expect(item.querySelector('.role-expl-kinds')?.textContent).toBe(`${entry.meantForText} ${entry.assignedByText}`);
    });
  });

  test('the fixture is the whole vocabulary, each role described', () => {
    // A vacuity control: an empty or truncated fixture would make the cases
    // above pass by comparing two short lists.
    expect(ROLES.map((entry) => entry.role)).toEqual([
      'admin', 'operator', 'editor', 'user', 'viewer', 'orchestrator', 'reviewer', 'qa', 'agent',
    ]);
    for (const entry of ROLES) {
      expect(entry.purpose.length).toBeGreaterThan(10);
      expect(entry.meantFor.length).toBeGreaterThan(0);
    }
  });

  test('a catalogue that could not be read says so instead of an empty list', () => {
    render(<RoleCatalogueList catalogue={{ state: 'failed', roles: null }} />);
    expect(screen.queryByRole('list', { name: 'Role catalogue' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/could not be read/);
  });
});

describe('one role under a selector', () => {
  test('the chosen role renders the same element the list renders', () => {
    const { container } = render(
      <>
        <RoleSelectionExplanation catalogue={READY} role="viewer" emptyText="none" />
        <RoleExplanation entry={ROLES.find((entry) => entry.role === 'viewer')!} />
      </>,
    );
    const [selected, listed] = Array.from(container.querySelectorAll('.role-expl[data-role="viewer"]'));
    expect(selected.textContent).toBe(listed.textContent);
  });

  test('no choice renders the prompt, an unknown role the prompt too', () => {
    render(<RoleSelectionExplanation catalogue={READY} role="" emptyText="Choose a role." />);
    expect(screen.getByText('Choose a role.')).toBeInTheDocument();
    cleanup();
    render(<RoleSelectionExplanation catalogue={READY} role="no-such-role" emptyText="Choose a role." />);
    expect(screen.getByText('Choose a role.')).toBeInTheDocument();
  });
});
