import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Search, X, Filter, ChevronDown, ChevronUp, UserCheck } from 'lucide-react';
import { Task, TaskPriority, TaskStatus } from '../../types/task';
import { authenticatedFetch } from '../../utils/auth';
import { Select } from '../ui/Select';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
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
}

export const FilterBar: React.FC<FilterBarProps> = ({ tasks, filters, onFiltersChange, availableTags: availableTagsProp, availableProjects: availableProjectsProp, availableOwners = [], canFilterMine = false }) => {
  const [searchInput, setSearchInput] = useState(filters.searchQuery);
  const [showPriorityDropdown, setShowPriorityDropdown] = useState(false);
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [showTagsDropdown, setShowTagsDropdown] = useState(false);
  const [showProjectsDropdown, setShowProjectsDropdown] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  // Phase options (RH-P2.4) come from the board's own phases, not from the
  // loaded page of tasks: a phase whose tasks are all on a later page must
  // still be filterable, or the filter would silently narrow with pagination.
  const [showPhasesDropdown, setShowPhasesDropdown] = useState(false);
  const [availablePhases, setAvailablePhases] = useState<Array<{ id: string; name: string; position: number }>>([]);
  const tagSearchInputRef = useRef<HTMLInputElement>(null);
  const projectSearchInputRef = useRef<HTMLInputElement>(null);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      onFiltersChange({ ...filters, searchQuery: searchInput });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Auto-focus tag search input when dropdown opens, clear when it closes
  useEffect(() => {
    if (showTagsDropdown) {
      // Small delay to ensure the input is rendered
      setTimeout(() => {
        tagSearchInputRef.current?.focus();
      }, 10);
    } else {
      // Clear search when dropdown closes
      setTagSearchQuery('');
    }
  }, [showTagsDropdown]);

  // Auto-focus project search input when dropdown opens, clear when it closes
  useEffect(() => {
    if (showProjectsDropdown) {
      setTimeout(() => {
        projectSearchInputRef.current?.focus();
      }, 10);
    } else {
      setProjectSearchQuery('');
    }
  }, [showProjectsDropdown]);

  // Extract unique values from all tasks
  const availableTags = useMemo(() => {
    if (availableTagsProp && availableTagsProp.length > 0) return [...availableTagsProp].sort();
    const tagSet = new Set<string>();
    tasks.forEach(task => {
      task.tags?.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [tasks, availableTagsProp]);

  // Filter tags based on search query
  const filteredTags = useMemo(() => {
    if (!tagSearchQuery.trim()) {
      return availableTags;
    }
    const query = tagSearchQuery.toLowerCase().trim();
    return availableTags.filter(tag => tag.toLowerCase().includes(query));
  }, [availableTags, tagSearchQuery]);

  const availableProjects = useMemo(() => {
    if (availableProjectsProp && availableProjectsProp.length > 0) return [...availableProjectsProp].sort();
    const projectSet = new Set<string>();
    tasks.forEach(task => {
      if (task.project) projectSet.add(task.project);
    });
    return Array.from(projectSet).sort();
  }, [tasks, availableProjectsProp]);

  const filteredProjects = useMemo(() => {
    if (!projectSearchQuery.trim()) {
      return availableProjects;
    }
    const query = projectSearchQuery.toLowerCase().trim();
    return availableProjects.filter(project => project.toLowerCase().includes(query));
  }, [availableProjects, projectSearchQuery]);

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

  const activeFilterCount =
    (filters.searchQuery ? 1 : 0) +
    filters.priorities.length +
    filters.tags.length +
    filters.projects.length +
    filters.phases.length +
    filters.statuses.length +
    (filters.mine ? 1 : 0) +
    (filters.owner ? 1 : 0) +
    (filters.unassigned ? 1 : 0);

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
      unassigned: false
    });
  };

  /** The three Assignee filters are mutually exclusive server-side, so
   *  selecting one clears the others rather than sending a contradiction. */
  const setOwnership = (next: Pick<TaskFilters, 'mine' | 'owner' | 'unassigned'>) => {
    onFiltersChange({ ...filters, mine: false, owner: null, unassigned: false, ...next });
  };

  const togglePriority = (priority: TaskPriority) => {
    const newPriorities = filters.priorities.includes(priority)
      ? filters.priorities.filter(p => p !== priority)
      : [...filters.priorities, priority];
    onFiltersChange({ ...filters, priorities: newPriorities });
  };

  const toggleStatus = (status: TaskStatus) => {
    const newStatuses = filters.statuses.includes(status)
      ? filters.statuses.filter(s => s !== status)
      : [...filters.statuses, status];
    onFiltersChange({ ...filters, statuses: newStatuses });
  };

  const toggleTag = (tag: string) => {
    const newTags = filters.tags.includes(tag)
      ? filters.tags.filter(t => t !== tag)
      : [...filters.tags, tag];
    onFiltersChange({ ...filters, tags: newTags });
  };

  useEffect(() => {
    const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
    let cancelled = false;
    authenticatedFetch(`${API_BASE_URL}/phases`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data?.success && Array.isArray(data.phases)) {
          setAvailablePhases(data.phases.map((p: { id: string; name: string; position: number }) => ({
            id: p.id, name: p.name, position: p.position,
          })));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const togglePhase = (phaseId: string) => {
    const next = filters.phases.includes(phaseId)
      ? filters.phases.filter(p => p !== phaseId)
      : [...filters.phases, phaseId];
    onFiltersChange({ ...filters, phases: next });
  };

  const toggleProject = (project: string) => {
    const newProjects = filters.projects.includes(project)
      ? filters.projects.filter(p => p !== project)
      : [...filters.projects, project];
    onFiltersChange({ ...filters, projects: newProjects });
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
        {/* Priority Filter */}
        <div className="filter-dropdown">
          <Button
            variant="secondary"
            size="compact"
            ariaExpanded={showPriorityDropdown}
            ariaHaspopup="true"
            onClick={() => {
              setShowPriorityDropdown(!showPriorityDropdown);
              setShowStatusDropdown(false);
              setShowTagsDropdown(false);
              setShowProjectsDropdown(false);
            }}
            className={`filter-dropdown-button ${filters.priorities.length > 0 ? 'filter-dropdown-button--active' : ''}`}
          >
            <Filter size={16} />
            Priority
            {filters.priorities.length > 0 && (
              <span className="filter-badge">{filters.priorities.length}</span>
            )}
          </Button>
          {showPriorityDropdown && (
            <div className="filter-dropdown-menu">
              {priorities.map(priority => (
                <label key={priority} className="filter-dropdown-item">
                  <input
                    type="checkbox"
                    checked={filters.priorities.includes(priority)}
                    onChange={() => togglePriority(priority)}
                  />
                  <span className={`filter-priority-dot priority-dot-${priority}`}></span>
                  <span>{priority}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Status filter (design 986be411 §3): narrows the board to the
            selected columns; the enumerated seven states only. */}
        <div className="filter-dropdown">
          <Button
            variant="secondary"
            size="compact"
            ariaExpanded={showStatusDropdown}
            ariaHaspopup="true"
            onClick={() => {
              setShowStatusDropdown(!showStatusDropdown);
              setShowPriorityDropdown(false);
              setShowTagsDropdown(false);
              setShowProjectsDropdown(false);
              setShowPhasesDropdown(false);
            }}
            className={`filter-dropdown-button ${filters.statuses.length > 0 ? 'filter-dropdown-button--active' : ''}`}
          >
            <Filter size={16} />
            Status
            {filters.statuses.length > 0 && (
              <span className="filter-badge">{filters.statuses.length}</span>
            )}
          </Button>
          {showStatusDropdown && (
            <div className="filter-dropdown-menu">
              {statusOptions.map(option => (
                <label key={option.value} className="filter-dropdown-item">
                  <input
                    type="checkbox"
                    checked={filters.statuses.includes(option.value)}
                    onChange={() => toggleStatus(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Tags Filter */}
        <div className="filter-dropdown">
          <Button
            variant="secondary"
            size="compact"
            ariaExpanded={showTagsDropdown}
            ariaHaspopup="true"
            onClick={() => {
              setShowTagsDropdown(!showTagsDropdown);
              setShowPriorityDropdown(false);
              setShowStatusDropdown(false);
              setShowProjectsDropdown(false);
            }}
            className={`filter-dropdown-button ${filters.tags.length > 0 ? 'filter-dropdown-button--active' : ''}`}
            disabled={availableTags.length === 0}
          >
            <Filter size={16} />
            Tags
            {filters.tags.length > 0 && (
              <span className="filter-badge">{filters.tags.length}</span>
            )}
          </Button>
          {showTagsDropdown && availableTags.length > 0 && (
            <div className="filter-dropdown-menu filter-dropdown-menu-with-search">
              <div className="filter-dropdown-search">
                <Search size={16} className="filter-dropdown-search-icon" />
                <input
                  ref={tagSearchInputRef}
                  type="text"
                  placeholder="Search tags..."
                  value={tagSearchQuery}
                  onChange={(e) => setTagSearchQuery(e.target.value)}
                  className="filter-dropdown-search-input"
                  onClick={(e) => e.stopPropagation()}
                />
                {tagSearchQuery && (
                  <IconButton
                    className="filter-dropdown-search-clear"
                    variant="ghost"
                    ariaLabel="Clear search"
                    icon={<X size={16} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTagSearchQuery('');
                      tagSearchInputRef.current?.focus();
                    }}
                  />
                )}
              </div>
              <div className="filter-dropdown-items">
                {filteredTags.length > 0 ? (
                  filteredTags.map(tag => (
                    <label key={tag} className="filter-dropdown-item">
                      <input
                        type="checkbox"
                        checked={filters.tags.includes(tag)}
                        onChange={() => toggleTag(tag)}
                      />
                      <span>{tag}</span>
                    </label>
                  ))
                ) : (
                  <div className="filter-dropdown-empty">
                    No tags found
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Projects Filter */}
        <div className="filter-dropdown">
          <Button
            variant="secondary"
            size="compact"
            ariaExpanded={showProjectsDropdown}
            ariaHaspopup="true"
            onClick={() => {
              setShowProjectsDropdown(!showProjectsDropdown);
              setShowPriorityDropdown(false);
              setShowStatusDropdown(false);
              setShowTagsDropdown(false);
            }}
            className={`filter-dropdown-button ${filters.projects.length > 0 ? 'filter-dropdown-button--active' : ''}`}
            disabled={availableProjects.length === 0}
          >
            <Filter size={16} />
            Project
            {filters.projects.length > 0 && (
              <span className="filter-badge">{filters.projects.length}</span>
            )}
          </Button>
          {showProjectsDropdown && availableProjects.length > 0 && (
            <div className="filter-dropdown-menu filter-dropdown-menu-with-search">
              <div className="filter-dropdown-search">
                <Search size={16} className="filter-dropdown-search-icon" />
                <input
                  ref={projectSearchInputRef}
                  type="text"
                  placeholder="Search projects..."
                  value={projectSearchQuery}
                  onChange={(e) => setProjectSearchQuery(e.target.value)}
                  className="filter-dropdown-search-input"
                  onClick={(e) => e.stopPropagation()}
                />
                {projectSearchQuery && (
                  <IconButton
                    className="filter-dropdown-search-clear"
                    variant="ghost"
                    ariaLabel="Clear search"
                    icon={<X size={16} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      setProjectSearchQuery('');
                      projectSearchInputRef.current?.focus();
                    }}
                  />
                )}
              </div>
              <div className="filter-dropdown-items">
                {filteredProjects.length > 0 ? (
                  filteredProjects.map(project => (
                    <label key={project} className="filter-dropdown-item">
                      <input
                        type="checkbox"
                        checked={filters.projects.includes(project)}
                        onChange={() => toggleProject(project)}
                      />
                      <span>#{project}</span>
                    </label>
                  ))
                ) : (
                  <div className="filter-dropdown-empty">
                    No projects found
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Phase filter (RH-P2.4). Hidden entirely when the deployment has no
            phases: an always-empty control reads as broken, not as empty. */}
        {availablePhases.length > 0 && (
          <div className="filter-dropdown">
            <Button
              variant="secondary"
              size="compact"
              ariaExpanded={showPhasesDropdown}
              ariaHaspopup="true"
              onClick={() => {
                setShowPhasesDropdown(!showPhasesDropdown);
                setShowPriorityDropdown(false);
                setShowStatusDropdown(false);
                setShowTagsDropdown(false);
                setShowProjectsDropdown(false);
              }}
              className={`filter-dropdown-button ${filters.phases.length > 0 ? 'filter-dropdown-button--active' : ''}`}
            >
              <Filter size={16} />
              Phase
              {filters.phases.length > 0 && (
                <span className="filter-badge">{filters.phases.length}</span>
              )}
            </Button>
            {showPhasesDropdown && (
              <div className="filter-dropdown-menu">
                <div className="filter-dropdown-items">
                  <label className="filter-dropdown-item">
                    <input
                      type="checkbox"
                      checked={filters.phases.includes('null')}
                      onChange={() => togglePhase('null')}
                    />
                    <span>Backlog (no phase)</span>
                  </label>
                  {availablePhases.map(phase => (
                    <label key={phase.id} className="filter-dropdown-item">
                      <input
                        type="checkbox"
                        checked={filters.phases.includes(phase.id)}
                        onChange={() => togglePhase(phase.id)}
                      />
                      <span>#{phase.position} {phase.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
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
    </div>
  );
};
