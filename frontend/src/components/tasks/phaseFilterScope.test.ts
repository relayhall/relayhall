// Card 096fda30 (owner E67): the Tasks board's Phase filter follows the
// Project filter. These pin the one module that decides it; the filter bar
// and the board page are pinned through it in FilterBar.phaseScope.test.tsx
// and TasksPage.phaseScope.test.tsx.
import { describe, expect, test } from 'vitest';
import {
  BACKLOG_PHASE_FILTER,
  UNKNOWN_PROJECT_LABEL,
  describeClearedPhases,
  groupPhasesByProject,
  partitionPhaseSelection,
  phaseMatchesQuery,
  phasesInScope,
  reconcilePhaseFilter,
  selectedProjectIds,
  type PhaseFilterOption,
  type PhaseFilterProject,
} from './phaseFilterScope';

const RELAYHALL_ID = '11111111-1111-4111-8111-111111111111';
const SHOP_ID = '22222222-2222-4222-8222-222222222222';
const PROJECTS: PhaseFilterProject[] = [
  { id: RELAYHALL_ID, name: 'RelayHall' },
  { id: SHOP_ID, name: 'Storefront' },
];
const AUTHORED: PhaseFilterOption = { id: 'phase-rh-1', name: '01 · Authored knowledge', position: 10, projectId: RELAYHALL_ID };
const RELEASE: PhaseFilterOption = { id: 'phase-rh-2', name: '10 · Release lane', position: 11, projectId: RELAYHALL_ID };
const LAUNCH: PhaseFilterOption = { id: 'phase-shop-1', name: 'Shop launch', position: 1, projectId: SHOP_ID };
const ORPHAN: PhaseFilterOption = { id: 'phase-x', name: 'Elsewhere', position: 2, projectId: '33333333-3333-4333-8333-333333333333' };
const PHASES = [AUTHORED, RELEASE, LAUNCH];

describe('selectedProjectIds — which Projects the Project filter selects', () => {
  test('resolves Project names, as the filter options list them', () => {
    expect(selectedProjectIds(['Storefront'], PROJECTS)).toEqual(new Set([SHOP_ID]));
    expect(selectedProjectIds(['Storefront', 'RelayHall'], PROJECTS)).toEqual(new Set([SHOP_ID, RELAYHALL_ID]));
  });

  test('resolves a Project id from a hand-written link, in any case', () => {
    expect(selectedProjectIds([SHOP_ID.toUpperCase()], PROJECTS)).toEqual(new Set([SHOP_ID]));
    // An id with hex letters, so that a change of case is a different string
    // (the server compares uuid values case-insensitively).
    const HEX_ID = 'abcdef12-3456-4789-8abc-def123456789';
    expect(HEX_ID.toUpperCase()).not.toBe(HEX_ID);
    const hex: PhaseFilterProject[] = [{ id: HEX_ID, name: 'Hex' }];
    expect(selectedProjectIds([HEX_ID.toUpperCase()], hex)).toEqual(new Set([HEX_ID]));
    expect(selectedProjectIds(['ABCDEF12-3456-4789-8abc-DEF123456789'], hex)).toEqual(new Set([HEX_ID]));
  });

  test('a name matches exactly, as the server matches it', () => {
    expect(selectedProjectIds(['STOREFRONT'], PROJECTS)).toBeNull();
  });

  test('no scope when nothing is selected, the directory is unknown, or a value names no visible Project', () => {
    expect(selectedProjectIds([], PROJECTS)).toBeNull();
    expect(selectedProjectIds(['Storefront'], null)).toBeNull();
    expect(selectedProjectIds(['Storefront', 'not-a-project'], PROJECTS)).toBeNull();
  });
});

describe('phasesInScope — what the Phase dropdown offers', () => {
  test('only the selected Projects’ Phases (the owner’s report, in miniature)', () => {
    expect(phasesInScope(PHASES, selectedProjectIds(['Storefront'], PROJECTS))).toEqual([LAUNCH]);
  });

  test('every Phase when no scope applies', () => {
    expect(phasesInScope(PHASES, null)).toEqual(PHASES);
  });

  test('a Phase with no Project is outside every scope', () => {
    expect(phasesInScope([{ ...LAUNCH, projectId: null }], new Set([SHOP_ID]))).toEqual([]);
  });
});

describe('partitionPhaseSelection / reconcilePhaseFilter — clearing what the Projects exclude', () => {
  const scope = new Set([SHOP_ID]);

  test('a Phase of another Project is removed; in-scope Phases and the backlog stay', () => {
    expect(partitionPhaseSelection([AUTHORED.id, LAUNCH.id, BACKLOG_PHASE_FILTER], PHASES, scope))
      .toEqual({ kept: [LAUNCH.id, BACKLOG_PHASE_FILTER], removed: [AUTHORED] });
  });

  test('an id the catalog does not list is kept — its Project cannot be known here', () => {
    expect(partitionPhaseSelection(['archived-or-unreadable'], PHASES, scope))
      .toEqual({ kept: ['archived-or-unreadable'], removed: [] });
  });

  test('nothing is cleared without a scope or without the catalog', () => {
    expect(partitionPhaseSelection([AUTHORED.id], PHASES, null)).toEqual({ kept: [AUTHORED.id], removed: [] });
    expect(partitionPhaseSelection([AUTHORED.id], null, scope)).toEqual({ kept: [AUTHORED.id], removed: [] });
  });

  test('reconcilePhaseFilter clears through the Project names the board stores', () => {
    const filters = { projects: ['Storefront'], phases: [AUTHORED.id, LAUNCH.id], tags: ['keep'] };
    const result = reconcilePhaseFilter(filters, { phases: PHASES, projects: PROJECTS });
    expect(result.filters).toEqual({ projects: ['Storefront'], phases: [LAUNCH.id], tags: ['keep'] });
    expect(result.removed).toEqual([AUTHORED]);
  });

  test('reconcilePhaseFilter returns the SAME object when nothing is cleared', () => {
    const filters = { projects: ['Storefront'], phases: [LAUNCH.id] };
    expect(reconcilePhaseFilter(filters, { phases: PHASES, projects: PROJECTS }).filters).toBe(filters);
    const unscoped = { projects: [], phases: [AUTHORED.id] };
    expect(reconcilePhaseFilter(unscoped, { phases: PHASES, projects: PROJECTS }).filters).toBe(unscoped);
  });

  test('reconcilePhaseFilter waits for BOTH halves of the catalog', () => {
    const filters = { projects: ['Storefront'], phases: [AUTHORED.id] };
    expect(reconcilePhaseFilter(filters, { phases: PHASES, projects: null }).removed).toEqual([]);
    expect(reconcilePhaseFilter(filters, { phases: null, projects: PROJECTS }).removed).toEqual([]);
  });
});

describe('phaseMatchesQuery — "Search phases" matches the name and the number only', () => {
  test('a case-insensitive substring of the name', () => {
    expect(phaseMatchesQuery(AUTHORED, 'authored')).toBe(true);
    expect(phaseMatchesQuery(AUTHORED, '  KNOWLEDGE ')).toBe(true);
    expect(phaseMatchesQuery(LAUNCH, 'authored')).toBe(false);
  });

  test('the number, with or without its #', () => {
    expect(phaseMatchesQuery(RELEASE, '11')).toBe(true);
    expect(phaseMatchesQuery(RELEASE, '#11')).toBe(true);
    expect(phaseMatchesQuery(LAUNCH, '#11')).toBe(false);
    expect(phaseMatchesQuery(LAUNCH, '#1')).toBe(true);
  });

  test('never the id or the Project', () => {
    expect(phaseMatchesQuery(LAUNCH, 'phase-shop')).toBe(false);
    expect(phaseMatchesQuery(LAUNCH, SHOP_ID.slice(0, 8))).toBe(false);
    expect(phaseMatchesQuery(LAUNCH, 'storefront')).toBe(false);
  });

  test('an empty query matches everything', () => {
    expect(phaseMatchesQuery(LAUNCH, '   ')).toBe(true);
  });
});

describe('groupPhasesByProject — the unscoped list is grouped by Project', () => {
  test('Projects alphabetically, Phases in catalog order, unknown Projects last in one group', () => {
    // First seen: Storefront, the unknown Project, RelayHall — the order is
    // the sort's, not the input's.
    const groups = groupPhasesByProject([LAUNCH, ORPHAN, AUTHORED, RELEASE], PROJECTS);
    expect(groups.map(group => group.label)).toEqual(['RelayHall', 'Storefront', UNKNOWN_PROJECT_LABEL]);
    expect(groups.map(group => group.phases.map(phase => phase.id))).toEqual([
      [AUTHORED.id, RELEASE.id], [LAUNCH.id], [ORPHAN.id],
    ]);
    expect(groups.map(group => group.key)).toEqual([RELAYHALL_ID, SHOP_ID, '']);
  });
});

describe('describeClearedPhases — the clearing is said, not silent', () => {
  test('names a single Phase and counts several', () => {
    expect(describeClearedPhases([AUTHORED]))
      .toBe('Phase filter "#10 01 · Authored knowledge" was cleared: it is not in the selected projects.');
    expect(describeClearedPhases([AUTHORED, RELEASE]))
      .toBe('2 phase filters were cleared: they are not in the selected projects.');
  });
});
