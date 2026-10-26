import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../../utils/auth';

/**
 * The Tasks board's Phase filter follows its Project filter (card 096fda30,
 * owner E67).
 *
 * A Phase belongs to exactly one Project, so a Phase from a Project the board
 * is not showing can only ever narrow the board to nothing. This module is the
 * single place that decides which Phases a Project selection admits: the
 * filter bar uses it to choose what the Phase dropdown offers, and the board
 * page uses it to clear a selected Phase that falls outside the chosen
 * Projects, both when the Project selection changes and when a link or stored
 * filter state arrives with one.
 *
 * Every rule here fails OPEN for the list and CLOSED for clearing: when the
 * scope cannot be decided (the Project directory could not be read, or a
 * selected Project value names nothing in it), every Phase stays offered and
 * nothing is cleared. Hiding a Phase is recoverable; clearing a valid
 * selection on a guess is not.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Phase filter's value for the unphased backlog. Never scoped. */
export const BACKLOG_PHASE_FILTER = 'null';

export interface PhaseFilterOption {
  id: string;
  name: string;
  position: number;
  /** The owning Project's id, as GET /phases returns it. */
  projectId: string | null;
}

export interface PhaseFilterProject {
  id: string;
  name: string;
}

export interface PhaseFilterCatalog {
  /** Null until GET /phases answers (and if it never does). */
  phases: PhaseFilterOption[] | null;
  /** Null until the Project directory answers (and if it never does). */
  projects: PhaseFilterProject[] | null;
}

/**
 * The Project ids a Project filter selects, or null when no scope applies.
 *
 * Board Project filter values are Project names — the filter options list
 * names — or, in a hand-written link, Project ids; the board query resolves
 * both, so this does too (a name by exact match, as the server does).
 *
 * Null means "no scope": nothing is selected, the directory is unknown, or a
 * selected value resolves to no Project this caller can see. In the last case
 * the Phases of that Project cannot be known here, so scoping by the others
 * would hide — and clearing would drop — Phases that may well be its own.
 */
export function selectedProjectIds(
  selected: readonly string[],
  projects: readonly PhaseFilterProject[] | null,
): Set<string> | null {
  if (selected.length === 0 || projects === null) return null;
  const ids = new Set<string>();
  for (const value of selected) {
    const isId = UUID_PATTERN.test(value);
    const matches = projects.filter(project =>
      project.name === value || (isId && project.id.toLowerCase() === value.toLowerCase()));
    if (matches.length === 0) return null;
    for (const project of matches) ids.add(project.id);
  }
  return ids;
}

/** The Phases a scope admits; every Phase when there is no scope. */
export function phasesInScope(
  phases: readonly PhaseFilterOption[],
  scope: Set<string> | null,
): PhaseFilterOption[] {
  if (scope === null) return [...phases];
  return phases.filter(phase => phase.projectId !== null && scope.has(phase.projectId));
}

/**
 * Split a Phase selection into what stays and what falls outside the scope.
 *
 * Kept: the backlog value, every Phase inside the scope, and every id the
 * catalog does not list — an archived Phase or one this caller cannot read
 * has no known Project here, and guessing would clear a valid selection.
 */
export function partitionPhaseSelection(
  phaseIds: readonly string[],
  phases: readonly PhaseFilterOption[] | null,
  scope: Set<string> | null,
): { kept: string[]; removed: PhaseFilterOption[] } {
  if (scope === null || phases === null) return { kept: [...phaseIds], removed: [] };
  const byId = new Map(phases.map(phase => [phase.id, phase]));
  const kept: string[] = [];
  const removed: PhaseFilterOption[] = [];
  for (const id of phaseIds) {
    const phase = id === BACKLOG_PHASE_FILTER ? undefined : byId.get(id);
    if (phase && !(phase.projectId !== null && scope.has(phase.projectId))) removed.push(phase);
    else kept.push(id);
  }
  return { kept, removed };
}

/**
 * Clear the selected Phases the selected Projects exclude. Returns the same
 * filters object when nothing is cleared, so a caller can tell a no-op apart.
 */
export function reconcilePhaseFilter<T extends { projects: string[]; phases: string[] }>(
  filters: T,
  catalog: PhaseFilterCatalog,
): { filters: T; removed: PhaseFilterOption[] } {
  const scope = selectedProjectIds(filters.projects, catalog.projects);
  const { kept, removed } = partitionPhaseSelection(filters.phases, catalog.phases, scope);
  if (removed.length === 0) return { filters, removed };
  return { filters: { ...filters, phases: kept }, removed };
}

/** The label every Phase surface shows: `#<position> <name>`. */
export function phaseFilterLabel(phase: PhaseFilterOption): string {
  return `#${phase.position} ${phase.name}`;
}

/**
 * "Search phases": a case-insensitive substring of the Phase NAME, or of its
 * NUMBER written `#<position>` (so `10` and `#10` both find Phase 10). Nothing
 * else — not the id, not the Project — is searched.
 */
export function phaseMatchesQuery(phase: PhaseFilterOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return phase.name.toLowerCase().includes(needle) || `#${phase.position}`.includes(needle);
}

export interface PhaseFilterGroup {
  /** Stable key: the Project id, or '' for Phases of no Project this caller can see. */
  key: string;
  label: string;
  phases: PhaseFilterOption[];
}

export const UNKNOWN_PROJECT_LABEL = 'Other project';

/**
 * Group Phases under their Project's name, Projects alphabetically, Phases in
 * the order given (the catalog's own position order). Phases whose Project
 * the directory does not list share one trailing group.
 */
export function groupPhasesByProject(
  phases: readonly PhaseFilterOption[],
  projects: readonly PhaseFilterProject[],
): PhaseFilterGroup[] {
  const names = new Map(projects.map(project => [project.id, project.name]));
  const groups = new Map<string, PhaseFilterGroup>();
  for (const phase of phases) {
    const name = phase.projectId !== null ? names.get(phase.projectId) : undefined;
    const key = name !== undefined ? phase.projectId! : '';
    let group = groups.get(key);
    if (!group) {
      group = { key, label: name ?? UNKNOWN_PROJECT_LABEL, phases: [] };
      groups.set(key, group);
    }
    group.phases.push(phase);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === '' || b.key === '') return a.key === '' ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
}

/** What the board says when it clears Phases the Project selection excludes. */
export function describeClearedPhases(removed: readonly PhaseFilterOption[]): string {
  if (removed.length === 1) {
    return `Phase filter "${phaseFilterLabel(removed[0])}" was cleared: it is not in the selected projects.`;
  }
  return `${removed.length} phase filters were cleared: they are not in the selected projects.`;
}

/**
 * The Phase catalog the board filters with: every Phase GET /phases lists for
 * this caller, and the Project directory that names their Projects (hidden and
 * archived Projects included, because the board's Project options include the
 * Projects of archived tasks). Either half stays null if its read fails.
 */
export function usePhaseFilterCatalog(): PhaseFilterCatalog {
  const [catalog, setCatalog] = useState<PhaseFilterCatalog>({ phases: null, projects: null });

  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(`${API_BASE_URL}/phases`)
      .then(r => r.json())
      .then(data => {
        if (cancelled || !data?.success || !Array.isArray(data.phases)) return;
        const phases: PhaseFilterOption[] = data.phases.map((p: { id: string; name: string; position: number; projectId?: string | null }) => ({
          id: p.id, name: p.name, position: p.position, projectId: p.projectId ?? null,
        }));
        setCatalog(previous => ({ ...previous, phases }));
      })
      .catch(() => {});
    authenticatedFetch(`${API_BASE_URL}/projects?includeHidden=true&includeArchived=true`)
      .then(r => r.json())
      .then(data => {
        if (cancelled || !data?.success || !Array.isArray(data.projects)) return;
        const projects: PhaseFilterProject[] = data.projects
          .filter((p: { id?: unknown; name?: unknown }) => typeof p?.id === 'string' && typeof p?.name === 'string')
          .map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }));
        setCatalog(previous => ({ ...previous, projects }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return catalog;
}
