import React, { useState, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { Search, X, Filter, ChevronDown, ChevronUp, UserCheck, ShieldAlert } from 'lucide-react';
import { Task, TaskPriority, TaskStatus } from '../../types/task';
import { Select } from '../ui/Select';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import {
  BACKLOG_PHASE_FILTER,
  groupPhasesByProject,
  phaseFilterLabel,
  phaseMatchesQuery,
  phasesInScope,
  selectedProjectIds,
  type PhaseFilterOption,
  type PhaseFilterProject,
} from './phaseFilterScope';
import './FilterBar.css';

export interface TaskFilters {
  searchQuery: string;
  priorities: TaskPriority[];
  tags: string[];
  projects: string[];
  /** Phase membership (RH-P2.4): phase ids, or the literal 'null' for the
   *  unphased backlog. Empty = no phase constraint. */
  phases: string[];
  /** Task states (design 986be411 §3): narrows which columns the board shows
   *  and fetches. Empty = no state constraint. Kebab-case state names only. */
  statuses: TaskStatus[];
  /** Assignee filters (card 60558599); absent = no Assignee constraint. */
  mine?: boolean;
  owner?: string | null;
  unassigned?: boolean;
  /** Card 41e24358: only Tasks without a usable Verifier (server-side). */
  verifierUnusable?: boolean;
}

interface FilterBarProps {
  tasks: Task[];
  filters: TaskFilters;
  onFiltersChange: (filters: TaskFilters) => void;
  availableTags?: string[];
  availableProjects?: string[];
  /** Handles offered by the Assignee filter; empty hides the control entirely. */
  availableOwners?: string[];
  /** False until the caller resolves a principal — "Mine" is meaningless then. */
  canFilterMine?: boolean;
  /** Every Phase the board can filter by (RH-P2.4), from the board page's
   *  Phase catalog — not from the loaded page of tasks: a Phase whose tasks
   *  are all on a later page must still be filterable. Empty hides the
   *  control: an always-empty Phase filter reads as broken, not as empty. */
  availablePhases?: PhaseFilterOption[];
  /** The Project directory naming those Phases' Projects (card 096fda30).
   *  Null while unknown: the Phase list is then neither scoped nor grouped. */
  phaseProjects?: PhaseFilterProject[] | null;
  /** Said once the board clears Phases the Project selection excludes. */
  phaseScopeNotice?: string | null;
  onDismissPhaseScopeNotice?: () => void;
}

const NO_PHASES: PhaseFilterOption[] = [];

/** The five list filters, which all render through FilterDropdown. */
type ListFilterKey = 'priorities' | 'statuses' | 'tags' | 'projects' | 'phases';

/** One item of a multi-select filter list. */
interface FilterOption {
  value: string;
  /** The item's visible text, which is also its checkbox's accessible name. */
  label: string;
  /** Drawn before the label (the Priority dot). */
  adornment?: React.ReactNode;
  /** Does the filter's search query keep this item? Absent: the label is
   *  matched as a case-insensitive substring of the trimmed query. */
  matches?: (query: string) => boolean;
}

const optionMatches = (option: FilterOption, query: string) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return option.matches ? option.matches(query) : option.label.toLowerCase().includes(needle);
};

interface FilterDropdownProps {
  /** The filter's visible name on its button; the clear controls are named
   *  "Clear <name> filter". */
  name: string;
  /** The items the filter offers, in their list order. */
  options: FilterOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  /** Empty THIS filter: exactly what unticking every selected item does. */
  onClear: () => void;
  open: boolean;
  onOpenChange: () => void;
  disabled?: boolean;
  search?: { placeholder: string; ariaLabel: string; clearLabel: string };
  menuClassName?: string;
  /** Said when the search leaves nothing in either group. */
  emptyText?: string;
  /** Lays out the unselected items (the Phase filter groups them by Project).
   *  Receives the items the search kept and the current query. */
  renderRest?: (rest: FilterOption[], renderOption: (option: FilterOption) => React.ReactNode, query: string) => React.ReactNode;
}

/**
 * One multi-select filter of the Tasks board (owner ruling E395). Every list
 * filter — Priority, Status, Tags, Project, Phase — renders through this one
 * component, so they cannot drift apart:
 *
 *  - the selected items lead the list in a "Selected" group (a role=group
 *    named by its visible label), in list order, above the rest; the search
 *    box narrows both groups. The order is taken when the list opens and
 *    holds while it is open, so a tick never moves an item (or its focus);
 *    the next opening, or a clear, sorts it again;
 *  - while the filter has a selection it carries two clear controls, both
 *    named "Clear <name> filter": an x BESIDE its button (a sibling, never
 *    nested, so the button keeps its own activation) and a "Clear" action at
 *    the top of its dropdown. Either empties this filter only.
 *
 * Focus after a clear: the x hands focus to the filter's button (the x itself
 * is gone); the in-menu Clear keeps the dropdown open and hands focus to its
 * search box, or to the first item where the filter has no search.
 */
const FilterDropdown: React.FC<FilterDropdownProps> = ({
  name, options, selected, onToggle, onClear, open, onOpenChange, disabled = false,
  search, menuClassName = '', emptyText, renderRest,
}) => {
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const focusFirstItemAfterClear = useRef(false);
  const selectedLabelId = useId();

  // The search box takes focus when the dropdown opens and is emptied when it
  // closes (the behaviour the Tags, Project and Phase searches always had).
  // Keyed on whether there IS a search, not on the props object: a new object
  // each render must not pull focus back to the box after every tick.
  const searchable = search !== undefined;
  useEffect(() => {
    if (open && searchable) {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 10);
      return () => clearTimeout(timer);
    }
    if (!open) setQuery('');
    return undefined;
  }, [open, searchable]);

  // The in-menu Clear unmounts with the selection it cleared; on a filter
  // with no search box, focus goes to the first item once the list is redrawn.
  useEffect(() => {
    if (!focusFirstItemAfterClear.current) return;
    focusFirstItemAfterClear.current = false;
    rootRef.current?.querySelector<HTMLInputElement>('.filter-dropdown-menu input[type="checkbox"]')?.focus();
  });

  // The order is decided when the list OPENS: the items selected then lead
  // it. Ticking or unticking while it is open moves nothing, so an item never
  // jumps away from the pointer and its checkbox keeps keyboard focus (a moved
  // checkbox would be a new element). Reopening the list, or clearing the
  // filter, sorts it again.
  const [pinned, setPinned] = useState<readonly string[] | null>(null);
  if (open && pinned === null) setPinned([...selected]);
  if (!open && pinned !== null) setPinned(null);
  const leading = new Set(pinned ?? selected);

  const chosen = new Set(selected);
  const kept = options.filter(option => optionMatches(option, query));
  const selectedOptions = kept.filter(option => leading.has(option.value));
  const restOptions = kept.filter(option => !leading.has(option.value));
  const hasSelection = selected.length > 0;

  const renderOption = (option: FilterOption) => (
    <label key={option.value} className="filter-dropdown-item">
      <input
        type="checkbox"
        checked={chosen.has(option.value)}
        onChange={() => onToggle(option.value)}
      />
      {option.adornment}
      <span>{option.label}</span>
    </label>
  );

  const clearFromButton = () => {
    onClear();
    if (open) setPinned([]);
    rootRef.current?.querySelector<HTMLButtonElement>('.filter-dropdown-button')?.focus();
  };

  const clearFromMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClear();
    setPinned([]);
    if (search) searchInputRef.current?.focus();
    else focusFirstItemAfterClear.current = true;
  };

  const selectedGroup = selectedOptions.length > 0 ? (
    <div className="filter-dropdown-group filter-dropdown-selected" role="group" aria-labelledby={selectedLabelId}>
      <div id={selectedLabelId} className="filter-dropdown-group-label">Selected</div>
      {selectedOptions.map(renderOption)}
    </div>
  ) : null;
  const restList = renderRest ? renderRest(restOptions, renderOption, query) : restOptions.map(renderOption);

  return (
    <div className="filter-dropdown" ref={rootRef}>
      <Button
        variant="secondary"
        size="compact"
        ariaExpanded={open}
        ariaHaspopup="true"
        onClick={onOpenChange}
        className={`filter-dropdown-button ${hasSelection ? 'filter-dropdown-button--active' : ''} ${hasSelection ? 'filter-dropdown-button--clearable' : ''}`}
        disabled={disabled}
      >
        <Filter size={16} />
        {name}
        {hasSelection && (
          <span className="filter-badge">{selected.length}</span>
        )}
      </Button>
      {hasSelection && (
        <IconButton
          className="filter-dropdown-clear-x"
          variant="secondary"
          ariaLabel={`Clear ${name} filter`}
          icon={<X size={16} />}
          onClick={clearFromButton}
        />
      )}
      {open && !disabled && (
        <div className={`filter-dropdown-menu ${search ? 'filter-dropdown-menu-with-search' : ''} ${menuClassName}`}>
          {search && (
            <div className="filter-dropdown-search">
              <Search size={16} className="filter-dropdown-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                aria-label={search.ariaLabel}
                placeholder={search.placeholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="filter-dropdown-search-input"
                onClick={(e) => e.stopPropagation()}
              />
              {query && (
                <IconButton
                  className="filter-dropdown-search-clear"
                  variant="ghost"
                  ariaLabel={search.clearLabel}
                  icon={<X size={16} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    setQuery('');
                    searchInputRef.current?.focus();
                  }}
                />
              )}
            </div>
          )}
          {hasSelection && (
            <div className="filter-dropdown-actions">
              <Button variant="secondary" size="compact" ariaLabel={`Clear ${name} filter`} onClick={clearFromMenu}>
                Clear
              </Button>
            </div>
          )}
          <div className="filter-dropdown-items">
            {selectedGroup}
            {restList}
            {emptyText && kept.length === 0 && (
              <div className="filter-dropdown-empty">
                {emptyText}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const FilterBar: React.FC<FilterBarProps> = ({
  tasks, filters, onFiltersChange, availableTags: availableTagsProp, availableProjects: availableProjectsProp,
  availableOwners = [], canFilterMine = false,
  availablePhases = NO_PHASES, phaseProjects = null, phaseScopeNotice = null, onDismissPhaseScopeNotice,
}) => {
  const [searchInput, setSearchInput] = useState(filters.searchQuery);
  /** At most one list filter's dropdown is open at a time. */
  const [openFilter, setOpenFilter] = useState<ListFilterKey | null>(null);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const phaseGroupIdPrefix = useId();

  // Search changes only the query. Keep newer selections when its timer fires,
  // without restarting the typing delay when another filter changes.
  const latestFilters = useRef({ filters, onFiltersChange });
  useLayoutEffect(() => {
    latestFilters.current = { filters, onFiltersChange };
  }, [filters, onFiltersChange]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const { filters: current, onFiltersChange: change } = latestFilters.current;
      if (current.searchQuery !== searchInput) {
        change({ ...current, searchQuery: searchInput });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Extract unique values from all tasks
  const availableTags = useMemo(() => {
    if (availableTagsProp && availableTagsProp.length > 0) return [...availableTagsProp].sort();
    const tagSet = new Set<string>();
    tasks.forEach(task => {
      task.tags?.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [tasks, availableTagsProp]);

  const availableProjects = useMemo(() => {
    if (availableProjectsProp && availableProjectsProp.length > 0) return [...availableProjectsProp].sort();
    const projectSet = new Set<string>();
    tasks.forEach(task => {
      if (task.project) projectSet.add(task.project);
    });
    return Array.from(projectSet).sort();
  }, [tasks, availableProjectsProp]);

  // The Phase list follows the Project filter (card 096fda30): with Projects
  // selected it offers only their Phases; with none it offers every Phase,
  // grouped under its Project. Clearing a selected Phase the Projects exclude
  // is the board page's job (reconcilePhaseFilter), so a link and a click are
  // treated the same way.
  const phaseScope = useMemo(
    () => selectedProjectIds(filters.projects, phaseProjects),
    [filters.projects, phaseProjects],
  );
  const scopedPhases = useMemo(
    () => phasesInScope(availablePhases, phaseScope),
    [availablePhases, phaseScope],
  );

  const priorities: TaskPriority[] = ['urgent', 'high', 'normal', 'low', 'someday'];

  // Enumerated task states (never a wildcard): the same seven the board knows.
  const statusOptions: Array<{ value: TaskStatus; label: string }> = [
    { value: 'ideas', label: 'Ideas' },
    { value: 'todo', label: 'To do' },
    { value: 'in-progress', label: 'In progress' },
    { value: 'review', label: 'Review' },
    { value: 'stuck', label: 'Stuck' },
    { value: 'completed', label: 'Completed' },
    { value: 'archived', label: 'Archived' },
  ];

  const priorityOptions: FilterOption[] = priorities.map(priority => ({
    value: priority,
    label: priority,
    adornment: <span className={`filter-priority-dot priority-dot-${priority}`}></span>,
  }));
  const statusFilterOptions: FilterOption[] = statusOptions.map(option => ({ value: option.value, label: option.label }));
  const tagOptions: FilterOption[] = availableTags.map(tag => ({ value: tag, label: tag }));
  // The '#' is presentation: the search matches the Project's name.
  const projectOptions: FilterOption[] = availableProjects.map(project => ({
    value: project,
    label: `#${project}`,
    matches: query => project.toLowerCase().includes(query.trim().toLowerCase()),
  }));
  // The backlog is not a Phase of any Project: always offered, never searched.
  const phaseById = new Map(scopedPhases.map(phase => [phase.id, phase]));
  const phaseOptions: FilterOption[] = [
    { value: BACKLOG_PHASE_FILTER, label: 'Backlog (no phase)', matches: () => true },
    ...scopedPhases.map(phase => ({
      value: phase.id,
      label: phaseFilterLabel(phase),
      matches: (query: string) => phaseMatchesQuery(phase, query),
    })),
  ];

  const activeFilterCount =
    (filters.searchQuery ? 1 : 0) +
    filters.priorities.length +
    filters.tags.length +
    filters.projects.length +
    filters.phases.length +
    filters.statuses.length +
    (filters.mine ? 1 : 0) +
    (filters.owner ? 1 : 0) +
    (filters.unassigned ? 1 : 0) +
    (filters.verifierUnusable ? 1 : 0);

  const clearAllFilters = () => {
    setSearchInput('');
    onFiltersChange({
      searchQuery: '',
      priorities: [],
      tags: [],
      projects: [],
      phases: [],
      statuses: [],
      mine: false,
      owner: null,
      unassigned: false,
      verifierUnusable: false
    });
  };

  /** One list filter's own clear (owner ruling E395): the state unticking
   *  each of its selected items leaves, and nothing else changes. */
  const clearListFilter = (key: ListFilterKey) => onFiltersChange({ ...filters, [key]: [] });

  /** The three Assignee filters are mutually exclusive server-side, so
   *  selecting one clears the others rather than sending a contradiction. */
  const setOwnership = (next: Pick<TaskFilters, 'mine' | 'owner' | 'unassigned'>) => {
    onFiltersChange({ ...filters, mine: false, owner: null, unassigned: false, ...next });
  };

  /** Tick or untick one item of one list filter. Only the enumerated values
   *  are ever offered for Priority and Status, so the list keeps its type. */
  const toggleIn = (key: ListFilterKey, value: string) => {
    const list: readonly string[] = filters[key];
    const next = list.includes(value) ? list.filter(item => item !== value) : [...list, value];
    onFiltersChange({ ...filters, [key]: next });
  };
  const toggleTag = (tag: string) => toggleIn('tags', tag);

  const dropdownState = (key: ListFilterKey) => ({
    open: openFilter === key,
    onOpenChange: () => setOpenFilter(current => (current === key ? null : key)),
    onClear: () => clearListFilter(key),
  });

  // The unselected Phases, grouped under their Project when the directory is
  // known; the backlog, when not selected, leads them outside any group.
  const renderPhaseRest = (
    rest: FilterOption[],
    renderOption: (option: FilterOption) => React.ReactNode,
    query: string,
  ) => {
    const backlog = rest.filter(option => option.value === BACKLOG_PHASE_FILTER);
    const restPhases = rest
      .map(option => phaseById.get(option.value))
      .filter((phase): phase is PhaseFilterOption => phase !== undefined);
    const anyPhaseMatches = scopedPhases.some(phase => phaseMatchesQuery(phase, query));
    const optionOf = (phase: PhaseFilterOption) => rest.find(option => option.value === phase.id)!;
    let phasesBlock: React.ReactNode = null;
    if (!anyPhaseMatches) {
      phasesBlock = (
        <div className="filter-dropdown-empty">
          {scopedPhases.length === 0 ? 'No phases in the selected projects' : 'No phases found'}
        </div>
      );
    } else if (phaseProjects === null) {
      phasesBlock = restPhases.map(phase => renderOption(optionOf(phase)));
    } else {
      phasesBlock = groupPhasesByProject(restPhases, phaseProjects).map(group => {
        const labelId = `${phaseGroupIdPrefix}-phase-group-${group.key || 'other'}`;
        return (
          <div key={group.key || 'other'} className="filter-dropdown-group" role="group" aria-labelledby={labelId}>
            <div id={labelId} className="filter-dropdown-group-label">{group.label}</div>
            {group.phases.map(phase => renderOption(optionOf(phase)))}
          </div>
        );
      });
    }
    return <>{backlog.map(renderOption)}{phasesBlock}</>;
  };

  const hasActiveTagFilter = filters.tags.length > 0;

  return (
    <div className={`filter-bar ${hasActiveTagFilter ? 'filter-bar-tag-active' : ''}`}>
      {/* Active Tag Filters Display */}
      {hasActiveTagFilter && (
        <div className="filter-bar-active-tags">
          <span className="filter-bar-active-tags-label">Filtering by:</span>
          {filters.tags.map(tag => (
            <span key={tag} className="filter-bar-active-tag">
              {tag}
              <IconButton
                className="filter-bar-active-tag-remove"
                variant="ghost"
                ariaLabel={`Remove ${tag} filter`}
                icon={<X size={16} />}
                onClick={() => toggleTag(tag)}
              />
            </span>
          ))}
          <Button
            variant="secondary"
            size="compact"
            className="filter-bar-clear-tags"
            onClick={() => onFiltersChange({ ...filters, tags: [] })}
          >
            Clear tag filter
          </Button>
        </div>
      )}

      <div className="filter-bar-search">
        <Search size={16} className="filter-bar-search-icon" />
        <input
          type="text"
          placeholder="Search tasks by title or description..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          // Escape BUBBLES to the reveal panel (amendment 2d5e2caa Ruling
          // 2): the panel collapses and hands focus back to the Search
          // control, so no handler is needed here.
          className="filter-bar-search-input"
        />
        {searchInput && (
          <IconButton
            className="filter-bar-clear-search"
            variant="ghost"
            ariaLabel="Clear search"
            icon={<X size={16} />}
            onClick={() => setSearchInput('')}
          />
        )}
      </div>

      <Button
        variant="secondary"
        size="compact"
        className="filter-bar-toggle-mobile"
        icon={<Filter size={16} />}
        ariaExpanded={filtersExpanded}
        onClick={() => setFiltersExpanded(!filtersExpanded)}
      >
        Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
        {filtersExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </Button>

      <div className={`filter-bar-filters ${filtersExpanded ? 'filter-bar-filters-expanded' : ''}`}>
        <FilterDropdown
          name="Priority"
          options={priorityOptions}
          selected={filters.priorities}
          onToggle={value => toggleIn('priorities', value as TaskPriority)}
          {...dropdownState('priorities')}
        />

        {/* Status filter (design 986be411 §3): narrows the board to the
            selected columns; the enumerated seven states only. */}
        <FilterDropdown
          name="Status"
          options={statusFilterOptions}
          selected={filters.statuses}
          onToggle={value => toggleIn('statuses', value as TaskStatus)}
          {...dropdownState('statuses')}
        />

        <FilterDropdown
          name="Tags"
          options={tagOptions}
          selected={filters.tags}
          onToggle={toggleTag}
          disabled={availableTags.length === 0}
          search={{ placeholder: 'Search tags...', ariaLabel: 'Search tags', clearLabel: 'Clear search' }}
          emptyText="No tags found"
          {...dropdownState('tags')}
        />

        <FilterDropdown
          name="Project"
          options={projectOptions}
          selected={filters.projects}
          onToggle={value => toggleIn('projects', value)}
          disabled={availableProjects.length === 0}
          search={{ placeholder: 'Search projects...', ariaLabel: 'Search projects', clearLabel: 'Clear search' }}
          emptyText="No projects found"
          {...dropdownState('projects')}
        />

        {/* Phase filter (RH-P2.4). Hidden entirely when the deployment has no
            phases: an always-empty control reads as broken, not as empty.
            The same search box, keyboard behaviour and focus order as the
            Project search, with an explicit accessible name (card 096fda30). */}
        {availablePhases.length > 0 && (
          <FilterDropdown
            name="Phase"
            options={phaseOptions}
            selected={filters.phases}
            onToggle={value => toggleIn('phases', value)}
            search={{ placeholder: 'Search phases...', ariaLabel: 'Search phases', clearLabel: 'Clear phase search' }}
            menuClassName="filter-dropdown-menu-phases"
            renderRest={renderPhaseRest}
            {...dropdownState('phases')}
          />
        )}

        {/* Assignee filters (card 60558599). Rendered only once identity is
            usable — before the substrate is live these would silently match
            nothing, which reads as a broken board rather than an empty one. */}
        {canFilterMine && (
          <Button
            variant="secondary"
            size="compact"
            className={`filter-ownership-toggle ${filters.mine ? 'filter-ownership-toggle--active' : ''}`}
            icon={<UserCheck size={16} />}
            ariaPressed={Boolean(filters.mine)}
            title="Only tasks assigned to me"
            onClick={() => setOwnership({ mine: !filters.mine })}
          >
            Mine
          </Button>
        )}

        {availableOwners.length > 0 && (
          <Select
            className="filter-owner-select"
            // The three Assignee filters are one mutually-exclusive choice
            // server-side, so they share one control: "Any assignee", a handle,
            // or "Unassigned".
            value={filters.unassigned ? '__unassigned__' : (filters.owner || '')}
            onChange={(e) => {
              const value = e.target.value;
              if (value === '__unassigned__') setOwnership({ unassigned: true });
              else setOwnership({ owner: value || null });
            }}
            aria-label="Filter by Assignee"
            title="Filter by Assignee principal"
          >
            <option value="">Any assignee</option>
            <option value="__unassigned__">Unassigned</option>
            {availableOwners.map(handle => (
              <option key={handle} value={handle}>{handle}</option>
            ))}
          </Select>
        )}

        {/* Card 41e24358: the morning census is this filter over To-Do and
            Review. Decided by the server's usable-Verifier predicate. */}
        <Button
          variant="secondary"
          size="compact"
          className={`filter-ownership-toggle ${filters.verifierUnusable ? 'filter-ownership-toggle--active' : ''}`}
          icon={<ShieldAlert size={16} />}
          ariaPressed={Boolean(filters.verifierUnusable)}
          title="Only tasks without a usable Verifier"
          onClick={() => onFiltersChange({ ...filters, verifierUnusable: !filters.verifierUnusable })}
        >
          Without a usable Verifier
        </Button>

        {/* Clear All Button */}
        {activeFilterCount > 0 && (
          <Button
            variant="secondary"
            size="compact"
            className="filter-clear-all"
            icon={<X size={16} />}
            ariaLabel="Clear all filters"
            onClick={clearAllFilters}
          >
            Clear All ({activeFilterCount})
          </Button>
        )}
      </div>

      {/* Phase scope notice (card 096fda30): the board says when it clears a
          Phase the selected Projects exclude, rather than changing the filter
          silently. The live region stays mounted so a clearing that lands
          after the bar is on screen is announced; empty, it takes no room. */}
      <div className="filter-bar-notice" role="status">
        {phaseScopeNotice && (
          <>
            <span className="filter-bar-notice-text">{phaseScopeNotice}</span>
            {onDismissPhaseScopeNotice && (
              <IconButton
                className="filter-bar-notice-dismiss"
                variant="ghost"
                ariaLabel="Dismiss notice"
                icon={<X size={16} />}
                onClick={onDismissPhaseScopeNotice}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
};
