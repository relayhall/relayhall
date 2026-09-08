import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Archive, Brain, Eye, LayoutGrid, Map as MapIcon, MoreHorizontal, Plus, Search, type LucideIcon } from 'lucide-react';
import { Task, TaskPriority, TaskStatus, SubtaskStatus, SubtaskTransitionDetails } from '../types/task';
import { TaskColumn } from '../components/tasks/TaskColumn';
import { FilterBar, TaskFilters } from '../components/tasks/FilterBar';
import { Button } from '../components/Button';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { MapView } from '../components/map/MapView';
import { IconButton } from '../components/ui/IconButton';
import { ConfirmationModal } from '../components/ConfirmationModal';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { usePrincipals, useMyPrincipal } from '../hooks/usePrincipals';
import { ToastContainer } from '../components/Toast';
import { buildSubtaskLifecycleRequest } from '../utils/subtaskLifecycle';
import { captureTaskBoardOrigin, getTaskBoardOriginTaskId, restoreTaskBoardOrigin } from '../utils/taskBoardNavigation';
import './TasksPage.css';
import { isIntentionalAbort } from '../utils/fetchAbort';

type ColumnKey = 'ideas' | 'todo' | 'in-progress' | 'review' | 'stuck' | 'completed' | 'archived';

const COLUMNS: ColumnKey[] = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];
const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed'];
// Column page = 50 (design 986be411 §5, E4; candidate A4 over the A3 read
// contract — the 6-item window and its archive ceiling retire).
const PER_COLUMN_INITIAL = 50;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const FILTERS_STORAGE_KEY = 'relayhall-task-filters';

// View modes of the Tasks page (design 986be411 §2). "Board" and "Map" are UI
// labels, not glossary objects — the Kanban remains the Kanban (D-20). The
// switcher renders from this registry so a future view is data, not new
// toolbar code. Map ships with A7; until then it is present but disabled —
// honest, not hidden.
type TaskViewId = 'board' | 'map';

interface TaskViewDefinition {
  id: TaskViewId;
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  tooltip: string;
}

export const TASK_VIEW_REGISTRY: readonly TaskViewDefinition[] = [
  { id: 'board', label: 'Board', icon: LayoutGrid, disabled: false, tooltip: 'Board view' },
  { id: 'map', label: 'Map', icon: MapIcon, disabled: false, tooltip: 'Map view' },
];

// Enumerated fallback (never wildcard acceptance): an unknown ?view= value is
// somebody's stale or hand-typed link, and it lands on the Board. A DISABLED
// registry entry resolves the same way, so the radio group always has exactly
// one enabled, selected, tabbable member (review f4ec788c B1). A7a makes the
// Map entry live, so ?view=map now resolves to the Map itself.
export const resolveTaskView = (value: string | null): TaskViewId =>
  TASK_VIEW_REGISTRY.some(view => view.id === value && !view.disabled) ? (value as TaskViewId) : 'board';

const COLUMN_LABELS: Record<ColumnKey, string> = {
  ideas: 'Ideas',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  stuck: 'Stuck',
  completed: 'Completed',
  archived: 'Archived'
};

interface ColumnData {
  items: Task[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  loading: boolean;
}

interface FilterOptions {
  tags: string[];
  projects: string[];
}

const createEmptyColumn = (): ColumnData => ({
  items: [],
  total: 0,
  offset: 0,
  limit: PER_COLUMN_INITIAL,
  hasMore: false,
  loading: false,
});

export const resolveTaskDeepLinkId = (
  routeTaskId: string | undefined,
  searchParams: URLSearchParams,
): string | null => {
  const focusParam = searchParams.get('focus');
  const focusedTaskId = focusParam && !COLUMNS.includes(focusParam as ColumnKey)
    ? focusParam
    : null;

  return routeTaskId
    || searchParams.get('id')
    || searchParams.get('open')
    || searchParams.get('task')
    || focusedTaskId;
};

const EMPTY_FILTERS: TaskFilters = { searchQuery: '', priorities: [], tags: [], projects: [], phases: [], statuses: [] };

const loadFiltersFromStorage = (urlTag?: string | null): TaskFilters => {
  if (urlTag) {
    return { ...EMPTY_FILTERS, tags: [urlTag] };
  }

  try {
    const stored = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (stored) {
      // Assignee filters are stripped on READ as well as on write. The write
      // side alone is not enough: entries left by an earlier build still carry
      // them, and this key is shared across environments, so a stale mine/owner
      // would apply to whoever signs in next — the unexplained empty board this
      // is meant to prevent. Restoring them is never right; they are scoped to
      // a session's identity, not to the board.
      const { mine, owner, unassigned, ...persisted } = JSON.parse(stored) || {};
      return { ...EMPTY_FILTERS, ...persisted };
    }
  } catch (error) {
    console.error('Failed to load filters from localStorage:', error);
  }

  return { ...EMPTY_FILTERS };
};

const TASK_PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'normal', 'low', 'someday'];

const parseListParam = (params: URLSearchParams, key: string): string[] =>
  (params.get(key) ?? '').split(',').map(v => v.trim()).filter(Boolean);

// One filter state, one URL encoding, both views (design 986be411 §3). A deep
// link restores the full filter state; enumerated fields validate against
// their enumerations and silently drop anything else. The Assignee fields ARE
// restored from the URL — unlike localStorage, a shared link states its
// intent explicitly — but a handle unknown to this deployment simply matches
// nothing, exactly as if typed into the picker.
export const parseFiltersFromParams = (
  params: URLSearchParams,
): { filters: TaskFilters; hasAny: boolean } => {
  const tags = parseListParam(params, 'tags');
  const legacyTag = params.get('tag');
  if (legacyTag && !tags.includes(legacyTag)) tags.push(legacyTag);
  const filters: TaskFilters = {
    searchQuery: params.get('q') ?? '',
    priorities: parseListParam(params, 'priorities')
      .filter((v): v is TaskPriority => (TASK_PRIORITIES as readonly string[]).includes(v)),
    tags,
    projects: parseListParam(params, 'projects'),
    phases: parseListParam(params, 'phases'),
    statuses: parseListParam(params, 'statuses')
      .filter((v): v is TaskStatus => (COLUMNS as readonly string[]).includes(v)),
    mine: params.get('mine') === 'true',
    owner: params.get('assignee') || null,
    unassigned: params.get('unassigned') === 'true',
  };
  const hasAny = Boolean(
    filters.searchQuery || filters.priorities.length || filters.tags.length
    || filters.projects.length || filters.phases.length || filters.statuses.length
    || filters.mine || filters.owner || filters.unassigned
  );
  return { filters, hasAny };
};

const createInitialBoardState = (): Record<ColumnKey, ColumnData> => ({
  ideas: createEmptyColumn(),
  todo: createEmptyColumn(),
  'in-progress': createEmptyColumn(),
  review: createEmptyColumn(),
  stuck: createEmptyColumn(),
  completed: createEmptyColumn(),
  archived: createEmptyColumn(),
});

export const TasksPage: React.FC = () => {
  const { taskId: routeTaskId } = useParams<{ taskId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [boardData, setBoardData] = useState<Record<ColumnKey, ColumnData>>(createInitialBoardState);
  // THE board snapshot for synchronous decisions (RH-UI.19 + hardening
  // 76d06394). Mutating this during render would publish a snapshot that a
  // discarded render never committed, and a functional setState writer would
  // leave it stale until the next render — so a WS patch could then overwrite
  // a fetch that had already landed. Every writer therefore goes through
  // commitBoard: it derives the next value FROM the ref, advances the ref
  // synchronously, and hands React a plain value. Two commits in one batch
  // compose, because the second reads what the first just wrote.
  const boardDataRef = useRef(boardData);

  const commitBoard = useCallback((
    updater: (previous: Record<ColumnKey, ColumnData>) => Record<ColumnKey, ColumnData>
  ) => {
    const previous = boardDataRef.current;
    const next = updater(previous);
    if (next === previous) return previous;
    boardDataRef.current = next;
    setBoardData(next);
    return next;
  }, []);
  const [initialLoading, setInitialLoading] = useState(true);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnKey>>(new Set(['ideas', 'archived']));
  const [mobileActiveTab, setMobileActiveTab] = useState<ColumnKey>('todo');
  const [isMobile, setIsMobile] = useState(false);
  // URL wins over localStorage: a deep link carries explicit intent, storage
  // only carries habit (design 986be411 §3).
  const [filters, setFilters] = useState<TaskFilters>(() => {
    const fromUrl = parseFiltersFromParams(searchParams);
    return fromUrl.hasAny ? fromUrl.filters : loadFiltersFromStorage(searchParams.get('tag'));
  });
  const [deepLinkTaskId, setDeepLinkTaskId] = useState<string | null>(null);
  // Search-on-activation (amendment 2d5e2caa Ruling 2, replacing the
  // 986be411 §2.1 persistent bar): this state gates the panel at EVERY
  // width — never as a function of filter state. A deep link or restored
  // filter opens the panel so its clearing control is visible.
  const [searchPanelOpen, setSearchPanelOpen] = useState(() => {
    const fromUrl = parseFiltersFromParams(searchParams);
    const initial = fromUrl.hasAny ? fromUrl.filters : loadFiltersFromStorage(searchParams.get('tag'));
    return !!(initial.searchQuery || initial.priorities.length || initial.tags.length || initial.projects.length
      || initial.phases.length || initial.statuses.length || initial.mine || initial.owner || initial.unassigned);
  });
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ tags: [], projects: [] });
  const [showArchived, setShowArchived] = useState(() =>
    searchParams.get('archived') === 'true' || searchParams.get('focus') === 'archived');
  const selectedView = resolveTaskView(searchParams.get('view'));
  const [overflowOpen, setOverflowOpen] = useState(false);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

  // Identity/attribution (card 60558599). Both degrade to empty: the board
  // must render exactly as it did pre-identity when the substrate is absent.
  const { byId: principalsById, principals } = usePrincipals();
  const { me: myPrincipal } = useMyPrincipal();
  // Only humans and services can meaningfully be Assignees; per-spawn agent
  // principals are one-per-task and would swamp the picker.
  const ownerHandles = useMemo(
    () => principals.filter(p => p.kind !== 'agent').map(p => p.handle).sort(),
    [principals]
  );
  const boardInnerRef = useRef<HTMLDivElement>(null);
  const scrollPositionRef = useRef<number>(0);
  const touchStartX = useRef<number>(0);
  const touchEndX = useRef<number>(0);
  const swipeFromEdge = useRef(false);
  const { subscribe, connected } = useWebSocket();
  const { toasts, success, warning } = useToast();

  // A status filter narrows the columns themselves; an explicitly selected
  // Archived state shows the Archived column regardless of the eye toggle,
  // because the selection IS the intent.
  const visibleColumns = useMemo(() => {
    const base = showArchived ? COLUMNS : DEFAULT_VISIBLE_COLUMNS;
    if (!filters.statuses.length) return base;
    return COLUMNS.filter(column => filters.statuses.includes(column));
  }, [showArchived, filters.statuses]);

  // Archived is always fetched (even when hidden) so the "plus N archived"
  // count in the header stays honest.
  const fetchedColumns = useMemo<ColumnKey[]>(
    () => (visibleColumns.includes('archived') ? visibleColumns : [...visibleColumns, 'archived'] as ColumnKey[]),
    [visibleColumns]
  );

  const allLoadedTasks = useMemo(
    () => COLUMNS.flatMap(column => boardData[column].items),
    [boardData]
  );

  useEffect(() => {
    if (initialLoading) return;
    const originTaskId = getTaskBoardOriginTaskId();
    if (!originTaskId) return;
    const originTask = allLoadedTasks.find(task => task.id === originTaskId);
    if (!originTask) return;
    const originColumn = originTask.status as ColumnKey;
    if (originColumn === 'archived') setShowArchived(true);
    setCollapsedColumns(previous => {
      if (!previous.has(originColumn)) return previous;
      const next = new Set(previous);
      next.delete(originColumn);
      return next;
    });
    setMobileActiveTab(originColumn);
    const timer = window.setTimeout(() => restoreTaskBoardOrigin(), 0);
    return () => window.clearTimeout(timer);
  }, [initialLoading, allLoadedTasks]);

  // Every filter that reaches the server must be counted here and keyed in
  // boardQueryKey below. Both enumerations drive user-visible behaviour — the
  // badge that tells you a filter is on, and the effect that refetches when
  // one changes — so a field added to TaskFilters and missed here produces a
  // filter that is silently inert or silently invisible.
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

  const boardQueryKey = useMemo(() => JSON.stringify({
    showArchived,
    searchQuery: filters.searchQuery,
    priorities: filters.priorities,
    tags: filters.tags,
    projects: filters.projects,
    phases: filters.phases,
    statuses: filters.statuses,
    mine: filters.mine,
    owner: filters.owner,
    unassigned: filters.unassigned,
  }), [showArchived, filters.searchQuery, filters.priorities, filters.tags, filters.projects,
       filters.phases, filters.statuses, filters.mine, filters.owner, filters.unassigned]);

  const fetchBoardRef = useRef<((offsetOverrides?: Partial<Record<ColumnKey, number>>, statusesSubset?: ColumnKey[]) => Promise<void>) | null>(null);
  // The reconnect reconcile's delta anchor: the last instant the loaded board
  // was known live (stamped on fetches and applied WS patches).
  const lastSyncRef = useRef<string>(new Date().toISOString());

  const fetchFilterOptions = useCallback(async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/filter-options?includeArchived=true`);
      const data = await response.json();
      if (data.success) {
        setFilterOptions({ tags: data.tags || [], projects: data.projects || [] });
      }
    } catch (error) {
      if (!isIntentionalAbort(error)) console.error('Failed to fetch task filter options:', error);
    }
  }, []);

  const fetchBoard = useCallback(async (
    offsetOverrides?: Partial<Record<ColumnKey, number>>,
    statusesSubset?: ColumnKey[],
  ) => {
    const statuses: ColumnKey[] = statusesSubset && statusesSubset.length > 0
      ? fetchedColumns.filter(column => statusesSubset.includes(column))
      : fetchedColumns;
    if (statuses.length === 0) return;
    const params = new URLSearchParams();
    params.set('statuses', statuses.join(','));
    params.set('perColumn', String(PER_COLUMN_INITIAL));
    params.set('includeArchived', showArchived ? 'true' : 'false');
    if (filters.searchQuery) params.set('q', filters.searchQuery);
    if (filters.priorities.length) params.set('priorities', filters.priorities.join(','));
    if (filters.tags.length) params.set('tags', filters.tags.join(','));
    if (filters.projects.length) params.set('projects', filters.projects.join(','));
    // Phase membership (RH-P2.4) — server-side like projects, so column totals
    // and pagination match what the board shows. 'null' = unphased backlog.
    if (filters.phases.length) params.set('phaseIds', filters.phases.join(','));
    // Assignee filters (card 60558599) — server-side so column totals and
    // pagination stay consistent with what the board is showing.
    if (filters.mine) params.set('mine', 'true');
    if (filters.owner) params.set('owner', filters.owner);
    if (filters.unassigned) params.set('unassigned', 'true');

    statuses.forEach((status) => {
      const offset = offsetOverrides?.[status] ?? 0;
      params.set(`offset_${status}`, String(offset));
    });

    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/board?${params.toString()}`);
      const data = await response.json();
      if (data.success) {
        lastSyncRef.current = new Date().toISOString();
        commitBoard(prev => {
          const next = { ...prev };
          statuses.forEach((status: ColumnKey) => {
            const column = data.columns?.[status];
            next[status] = {
              items: column?.items || [],
              total: column?.total || 0,
              offset: column?.offset || 0,
              limit: column?.limit || PER_COLUMN_INITIAL,
              hasMore: column?.hasMore || false,
              loading: false,
            };
          });
          return next;
        });
      }
    } catch (error) {
      if (!isIntentionalAbort(error)) console.error('Failed to fetch board:', error);
    } finally {
      setInitialLoading(false);
    }
  }, [commitBoard, fetchedColumns, filters, showArchived]);

  const loadMoreColumn = useCallback(async (column: ColumnKey) => {
    // Read the live snapshot, not a render-time closure: a load-more fired
    // from a scroll handler must see rows a WS patch just added.
    const current = boardDataRef.current[column];
    if (current.loading || !current.hasMore) return;

    commitBoard(prev => ({
      ...prev,
      [column]: { ...prev[column], loading: true },
    }));

    const params = new URLSearchParams();
    params.set('statuses', column);
    params.set('perColumn', String(PER_COLUMN_INITIAL));
    params.set('includeArchived', column === 'archived' ? 'true' : String(showArchived));
    params.set(`offset_${column}`, String(current.items.length));
    if (filters.searchQuery) params.set('q', filters.searchQuery);
    if (filters.priorities.length) params.set('priorities', filters.priorities.join(','));
    if (filters.tags.length) params.set('tags', filters.tags.join(','));
    if (filters.projects.length) params.set('projects', filters.projects.join(','));
    // Phase membership (RH-P2.4) — server-side like projects, so column totals
    // and pagination match what the board shows. 'null' = unphased backlog.
    if (filters.phases.length) params.set('phaseIds', filters.phases.join(','));
    // Assignee filters (card 60558599) — server-side so column totals and
    // pagination stay consistent with what the board is showing.
    if (filters.mine) params.set('mine', 'true');
    if (filters.owner) params.set('owner', filters.owner);
    if (filters.unassigned) params.set('unassigned', 'true');

    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/board?${params.toString()}`);
      const data = await response.json();
      if (data.success) {
        const incoming = data.columns?.[column];
        commitBoard(prev => ({
          ...prev,
          [column]: {
            // Id-dedup accumulation — the documented OFFSET drift coping
            // (A3 route decision): a Task entering the scope mid-pagination
            // shifts offsets and repeats a row; the duplicate collapses here.
            items: (() => {
              const seen = new Set(prev[column].items.map(item => item.id));
              return [...prev[column].items, ...(incoming?.items || []).filter((item: Task) => !seen.has(item.id))];
            })(),
            total: incoming?.total || prev[column].total,
            offset: incoming?.offset || prev[column].offset,
            limit: incoming?.limit || prev[column].limit,
            hasMore: incoming?.hasMore || false,
            loading: false,
          },
        }));
      }
    } catch (error) {
      if (!isIntentionalAbort(error)) console.error(`Failed to load more tasks for ${column}:`, error);
      commitBoard(prev => ({
        ...prev,
        [column]: { ...prev[column], loading: false },
      }));
    }
  }, [commitBoard, filters, showArchived]);

  const refreshBoard = useCallback(async (showInitialLoader = false) => {
    if (showInitialLoader) setInitialLoading(true);
    await fetchBoard();
  }, [fetchBoard]);

  const handleBoardScroll = useCallback(() => {
    if (boardInnerRef.current) {
      scrollPositionRef.current = boardInnerRef.current.scrollLeft;
    }
  }, []);

  useEffect(() => {
    if (boardInnerRef.current && scrollPositionRef.current > 0) {
      boardInnerRef.current.scrollLeft = scrollPositionRef.current;
    }
  });

  useEffect(() => {
    fetchBoardRef.current = fetchBoard;
  }, [fetchBoard]);

  useEffect(() => {
    fetchFilterOptions();
  }, [fetchFilterOptions]);

  useEffect(() => {
    setInitialLoading(true);
    fetchBoardRef.current?.();
  }, [boardQueryKey]);

  // WS-driven refreshes are DEBOUNCED: a bulk archive emits dozens of
  // task.archived events, and refetch-per-event turned into a storm of
  // aborted board requests in live QA. One trailing refetch is honest and
  // calm. (Patch-in-place arrives with candidate A4.)
  const wsRefreshTimerRef = useRef<number | null>(null);
  const scheduleBoardRefresh = useCallback(() => {
    if (wsRefreshTimerRef.current !== null) window.clearTimeout(wsRefreshTimerRef.current);
    wsRefreshTimerRef.current = window.setTimeout(() => {
      wsRefreshTimerRef.current = null;
      fetchBoardRef.current?.();
    }, 300);
  }, []);
  useEffect(() => () => {
    if (wsRefreshTimerRef.current !== null) window.clearTimeout(wsRefreshTimerRef.current);
  }, []);

  // ---- WS patch-in-place (design 986be411 §5, E4; candidate A4) ----
  // task.updated / task.created patch the loaded window directly with a
  // visual pulse — never a full refetch. Deletions, archives and bulk
  // signals keep the debounced refetch (their payloads carry no task row).
  const [pulsedTaskIds, setPulsedTaskIds] = useState<Set<string>>(new Set());
  const pulseTimersRef = useRef<Map<string, number>>(new Map());
  const pulseTask = useCallback((taskId: string) => {
    setPulsedTaskIds(previous => new Set(previous).add(taskId));
    const existing = pulseTimersRef.current.get(taskId);
    if (existing !== undefined) window.clearTimeout(existing);
    pulseTimersRef.current.set(taskId, window.setTimeout(() => {
      pulseTimersRef.current.delete(taskId);
      setPulsedTaskIds(previous => {
        const next = new Set(previous);
        next.delete(taskId);
        return next;
      });
    }, 1400));
  }, []);
  useEffect(() => () => { pulseTimersRef.current.forEach(timer => window.clearTimeout(timer)); }, []);

  // Insert preserving the server's TOTAL order (created_at DESC, id DESC).
  const insertSorted = (items: Task[], task: Task): Task[] => {
    const key = (candidate: Task) => `${candidate.created}#${candidate.id}`;
    const next = items.filter(item => item.id !== task.id);
    const index = next.findIndex(item => key(item) < key(task));
    if (index === -1) next.push(task); else next.splice(index, 0, task);
    return next;
  };

  // Filters compose with windowing (§5; review 3bb32ead B3): a WS row enters
  // the filtered view only if it MATCHES the active filters, and a loaded row
  // that stops matching leaves it. The predicate mirrors the server-backed
  // filter classes; the free-text arm approximates the server's q (title +
  // description) — a divergence self-corrects on the next fetch/reconcile.
  const matchesActiveFilters = useCallback((task: Task): boolean => {
    if (filters.searchQuery) {
      const query = filters.searchQuery.toLowerCase();
      const haystack = `${task.title ?? ''}\n${task.description ?? ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filters.priorities.length && !filters.priorities.includes(task.priority as typeof filters.priorities[number])) return false;
    if (filters.tags.length && !filters.tags.some(tag => (task.tags ?? []).includes(tag))) return false;
    if (filters.projects.length && !filters.projects.includes(task.project ?? '')) return false;
    if (filters.phases.length && !filters.phases.includes((task.phaseId ?? 'null') as string)) return false;
    if (filters.statuses.length && !filters.statuses.includes(task.status as typeof filters.statuses[number])) return false;
    if (filters.mine && task.ownerPrincipalId !== myPrincipal?.id) return false;
    if (filters.owner) {
      const ownerPrincipal = principals.find(principal => principal.handle === filters.owner);
      if (!ownerPrincipal || task.ownerPrincipalId !== ownerPrincipal.id) return false;
    }
    if (filters.unassigned && task.ownerPrincipalId) return false;
    return true;
  }, [filters, myPrincipal, principals]);

  // Totals adjust ONLY with certain knowledge (review 3bb32ead B2): a
  // creation grows the scope total; a move between LOADED columns transfers
  // one; an update whose prior membership is off-window is reconciled
  // through the bounded debounced refetch instead of guessed at — a
  // windowed column never lies about its server-computed size.
  const applyTaskPatch = useCallback((task: Task, source: 'created' | 'updated') => {
    lastSyncRef.current = new Date().toISOString();
    const matches = matchesActiveFilters(task);
    let outcome: 'patched' | 'reconcile' | 'ignored' = 'ignored';
    // The decision and the write both come from the write-through snapshot
    // ref: the outcome is knowable SYNCHRONOUSLY (an updater closure only
    // runs eagerly by scheduler accident), and WS bursts between renders
    // compose through the same mirror.
    const patchFromSnapshot = (prev: Record<ColumnKey, ColumnData>): Record<ColumnKey, ColumnData> => {
      const next = { ...prev };
      let previousColumn: ColumnKey | null = null;
      for (const column of COLUMNS) {
        if (prev[column].items.some(item => item.id === task.id)) { previousColumn = column; break; }
      }
      const targetColumn = task.status as ColumnKey;
      if (!COLUMNS.includes(targetColumn)) return prev;
      if (previousColumn && !matches) {
        // The row left the filtered scope: remove it and shrink the scope total.
        outcome = 'patched';
        next[previousColumn] = {
          ...prev[previousColumn],
          items: prev[previousColumn].items.filter(item => item.id !== task.id),
          total: Math.max(prev[previousColumn].total - 1, 0),
        };
        return next;
      }
      if (!matches) {
        // A nonmatching CREATE was never in the scope — ignore. A
        // nonmatching UPDATE with unknown prior membership may have LEFT
        // the counted scope (it could sit beyond the loaded window), so the
        // bounded reconcile must settle the total (review 34eeaa31 B1).
        if (source === 'updated') outcome = 'reconcile';
        return prev;
      }
      if (previousColumn === targetColumn) {
        outcome = 'patched';
        next[targetColumn] = {
          ...prev[targetColumn],
          items: prev[targetColumn].items.map(item => (item.id === task.id ? task : item)),
        };
        return next;
      }
      if (previousColumn) {
        outcome = 'patched';
        next[previousColumn] = {
          ...prev[previousColumn],
          items: prev[previousColumn].items.filter(item => item.id !== task.id),
          total: Math.max(prev[previousColumn].total - 1, 0),
        };
        next[targetColumn] = {
          ...prev[targetColumn],
          items: insertSorted(prev[targetColumn].items, task),
          total: prev[targetColumn].total + 1,
        };
        return next;
      }
      if (source === 'created') {
        outcome = 'patched';
        next[targetColumn] = {
          ...prev[targetColumn],
          items: insertSorted(prev[targetColumn].items, task),
          total: prev[targetColumn].total + 1,
        };
        return next;
      }
      // An UPDATE whose prior membership is unknown (off-window or an
      // unloaded source column): no total can be adjusted with certainty.
      outcome = 'reconcile';
      return prev;
    };
    commitBoard(patchFromSnapshot);
    // Assigned inside patchFromSnapshot, invisible to TS flow analysis.
    if ((outcome as string) === 'reconcile') scheduleBoardRefresh();
    else if ((outcome as string) === 'patched') pulseTask(task.id);
  }, [commitBoard, matchesActiveFilters, pulseTask, scheduleBoardRefresh]);

  const handleTaskCreated = useCallback((msg: { task: Task }) => {
    if (msg?.task?.id) applyTaskPatch(msg.task, 'created');
    else scheduleBoardRefresh();
  }, [applyTaskPatch, scheduleBoardRefresh]);

  const handleTaskUpdated = useCallback((msg: { task: Task }) => {
    const task = msg.task;
    if (task.needsReview && task.completedBy) {
      if (task.status === 'completed') success(`Agent completed: ${task.title}`, 7000);
      else if (task.status === 'stuck') warning(`Agent encountered issues: ${task.title}`, 7000);
    }
    if (task?.id) applyTaskPatch(task, 'updated');
    else scheduleBoardRefresh();
  }, [applyTaskPatch, scheduleBoardRefresh, success, warning]);

  const handleTaskRemoved = useCallback(() => {
    scheduleBoardRefresh();
  }, [scheduleBoardRefresh]);

  const handleTasksUpdated = useCallback(() => {
    scheduleBoardRefresh();
  }, [scheduleBoardRefresh]);

  useEffect(() => {
    const unsubs = [
      subscribe('task.created', handleTaskCreated),
      subscribe('task.updated', handleTaskUpdated),
      subscribe('task.deleted', handleTaskRemoved),
      subscribe('task.archived', handleTaskRemoved),
      subscribe('tasks.updated', handleTasksUpdated),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [subscribe, handleTaskCreated, handleTaskUpdated, handleTaskRemoved, handleTasksUpdated]);

  // Reconnect reconcile (986be411 §5): on the false→true connection edge,
  // read the graph delta since the last known-live instant and refetch ONLY
  // the columns that actually changed — never a blanket refetch. Debounced so
  // a flapping socket cannot storm the API.
  const prevConnectedRef = useRef<boolean>(Boolean(connected));
  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    prevConnectedRef.current = Boolean(connected);
    if (!connected || wasConnected) return;
    const since = lastSyncRef.current;
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        params.set('statuses', fetchedColumns.join(','));
        params.set('updatedSince', since);
        params.set('includeArchived', String(fetchedColumns.includes('archived')));
        const response = await authenticatedFetch(`${API_BASE_URL}/tasks/graph?${params.toString()}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) return;
        const changedColumns = [...new Set((data.nodes as Array<{ status: string }>).map(node => node.status))]
          .filter((status): status is ColumnKey => (fetchedColumns as string[]).includes(status));
        if (changedColumns.length > 0 || (data.fullCount ?? 0) !== visibleTaskCount) {
          await fetchBoardRef.current?.(undefined, changedColumns.length > 0 ? changedColumns : undefined);
        }
      } catch (error) {
        if (!isIntentionalAbort(error)) console.error('Reconnect reconcile failed:', error);
      }
    }, 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    try {
      // Assignee filters are deliberately NOT persisted. "Mine" and
      // owner=<handle> are scoped to whoever is signed in, and this key is
      // shared across environments — a restored Assignee filter could refer
      // to a different identity, or a handle that does not exist here, and
      // present as an unexplained empty board. Tags/projects/priorities are
      // stable across identities, so they keep persisting.
      const { mine: _mine, owner: _owner, unassigned: _unassigned, ...persistable } = filters;
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(persistable));
    } catch (error) {
      console.error('Failed to save filters to localStorage:', error);
    }
    // Canonical URL encoding of the whole filter state (986be411 §3): the
    // address bar is always a shareable deep link to what is on screen.
    // Foreign params (view, focus, deep-link ids) pass through untouched;
    // the legacy ?tag= entry alias is absorbed into ?tags= on first write.
    setSearchParams(prev => {
      const writeParam = (key: string, value: string) => {
        if (value) prev.set(key, value);
        else prev.delete(key);
      };
      writeParam('q', filters.searchQuery);
      writeParam('priorities', filters.priorities.join(','));
      writeParam('tags', filters.tags.join(','));
      writeParam('projects', filters.projects.join(','));
      writeParam('phases', filters.phases.join(','));
      writeParam('statuses', filters.statuses.join(','));
      writeParam('assignee', filters.owner || '');
      writeParam('mine', filters.mine ? 'true' : '');
      writeParam('unassigned', filters.unassigned ? 'true' : '');
      writeParam('archived', showArchived ? 'true' : '');
      prev.delete('tag');
      return prev;
    }, { replace: true });
  }, [filters, showArchived, setSearchParams]);

  const handleDeepLinkHandled = useCallback(() => {
    setDeepLinkTaskId(null);
  }, []);

  const handleTagClick = useCallback((tag: string) => {
    setFilters(prev => ({ ...prev, tags: [tag] }));
  }, []);

  const handleFiltersChange = useCallback((newFilters: TaskFilters) => {
    setFilters(newFilters);
  }, []);

  // The 1500 ms collapse-on-clear timer that used to live here retires with
  // A1 (986be411 §2.1): clearing filters clears VALUES; it never unmounts or
  // hides the search control. TasksPage.toolbar.test.tsx pins the mechanism.

  const selectView = useCallback((view: TaskViewId) => {
    const definition = TASK_VIEW_REGISTRY.find(candidate => candidate.id === view);
    if (!definition || definition.disabled) return;
    setSearchParams(prev => {
      prev.set('view', view);
      return prev;
    }, { replace: true });
  }, [setSearchParams]);

  // Mobile overflow menu (986be411 §2 mobile): closes on Escape (focus
  // returns to its trigger) and on any pointer press outside it.
  const closeOverflow = useCallback((refocus: boolean) => {
    setOverflowOpen(false);
    if (refocus) overflowTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!overflowOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeOverflow(true);
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (overflowMenuRef.current?.contains(target)) return;
      if (overflowTriggerRef.current?.contains(target)) return;
      closeOverflow(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [overflowOpen, closeOverflow]);

  const handleTagClickWithPanel = useCallback((tag: string) => {
    setSearchPanelOpen(true);
    handleTagClick(tag);
  }, [handleTagClick]);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 767);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    const focusColumn = searchParams.get('focus') as ColumnKey | null;
    if (focusColumn === 'archived') {
      setShowArchived(true);
      setCollapsedColumns(prev => {
        const next = new Set(prev);
        next.delete('archived');
        return next;
      });
    } else if (focusColumn && COLUMNS.includes(focusColumn)) {
      const columnsToCollapse = visibleColumns.filter(col => col !== focusColumn);
      setCollapsedColumns(new Set(columnsToCollapse));
      setTimeout(() => {
        const el = document.querySelector(`[data-status="${focusColumn}"]`);
        el?.scrollIntoView?.({ behavior: 'smooth', inline: 'center' });
      }, 200);
    }
  }, [searchParams, visibleColumns]);

  useEffect(() => {
    const idParam = resolveTaskDeepLinkId(routeTaskId, searchParams);
    if (!idParam || initialLoading) return;

    let cancelled = false;

    const canonicalize = (target: Task) => {
      // Hand the details page a board-return URL so its return control
      // restores view + filters. captureTaskBoardOrigin strips the one-shot
      // opening params (focus/id/open/task) so the return never resolves the
      // deep link again and bounces back (review 52a37007 B1).
      captureTaskBoardOrigin(target.id, searchParams.toString() ? `/tasks?${searchParams.toString()}` : '/tasks');
      navigate(`/tasks/${target.id}`, { replace: true });
    };

    const existing = allLoadedTasks.find(t => t.id === idParam || t.id.startsWith(idParam));
    if (existing) {
      canonicalize(existing);
      return;
    }

    (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(idParam)}`);
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled || !data.success || !data.task) return;
        const target = data.task as Task;
        const taskColumn = target.status as ColumnKey;
        commitBoard(prev => {
          const current = prev[taskColumn] || createEmptyColumn();
          if (current.items.some(t => t.id === target.id)) return prev;
          return {
            ...prev,
            [taskColumn]: {
              ...current,
              items: [target, ...current.items],
              total: Math.max(current.total, current.items.length + 1),
            },
          };
        });
        canonicalize(target);
      } catch (error) {
        if (!isIntentionalAbort(error)) console.error('Failed to resolve task deep link:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routeTaskId, searchParams, allLoadedTasks, initialLoading, navigate, commitBoard]);

  // Roving tab stop over card openers (C2 §2.2): exactly one opener is in
  // the tab order at a time; arrows move focus and focusing an opener moves
  // the stop. React-managed (prop-driven tabIndex) so the invariant survives
  // ANY re-render — DOM-patched tabIndex resets whenever nodes re-create.
  const [rovingTaskId, setRovingTaskId] = useState<string | null>(null);
  const rovingActiveTaskId = useMemo(() => {
    // Only RENDERED openers can carry the stop: on mobile only the active
    // tab's column mounts cards, and a collapsed desktop column renders none
    // (review 9d14f226 — a hidden candidate would leave ZERO tabbable
    // openers on the board).
    const renderedColumns = isMobile
      ? [mobileActiveTab]
      : visibleColumns.filter(column => !collapsedColumns.has(column));
    const ordered = renderedColumns.flatMap(column => boardData[column]?.items ?? []);
    if (rovingTaskId && ordered.some(item => item.id === rovingTaskId)) return rovingTaskId;
    return ordered[0]?.id ?? null;
  }, [rovingTaskId, boardData, visibleColumns, collapsedColumns, isMobile, mobileActiveTab]);

  // Focus lands once the (possibly keep-alive-mounted) opener exists — the
  // second half of the virtual-boundary keyboard contract (review 3bb32ead
  // B1): setting the roving stop mounts the target; this effect focuses it
  // on the render that carries it.
  const pendingFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const node = document.querySelector(`.task-card-open-button[data-task-id="${pendingFocusRef.current}"]`) as HTMLElement | null;
    if (node) {
      pendingFocusRef.current = null;
      node.focus();
      node.scrollIntoView?.({ block: 'nearest' });
    }
  });

  // The listener registers ONCE and reads the LATEST board state through a
  // render-refreshed ref: a deps-driven re-registration leaves a window
  // where a stale (empty-board) closure handles the key and silently
  // no-ops — observed as the nondeterministic End-key failure (review
  // 4dce263d B1).
  const createTaskHrefRef = useRef<() => string>(() => '/tasks/new');
  const rovingNavStateRef = useRef({ boardData, visibleColumns, collapsedColumns, isMobile, mobileActiveTab });
  rovingNavStateRef.current = { boardData, visibleColumns, collapsedColumns, isMobile, mobileActiveTab };
  createTaskHrefRef.current = () => createTaskHref();

  useEffect(() => {
    const handleKeyboard = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault();
          navigate(createTaskHrefRef.current());
          break;
        case 'arrowdown':
        case 'arrowup':
        case 'arrowleft':
        case 'arrowright':
        case 'home':
        case 'end': {
          // Scoped roving pattern (C2 §2.2): arrows act ONLY while focus is
          // on a card opener; every other control keeps its own arrows.
          // Navigation is LOGICAL over the loaded order (review 3bb32ead
          // B1): under virtualization the DOM holds only a window, so the
          // target comes from boardData; the roving stop keeps it mounted
          // (the keep-alive) and focus lands after render.
          const active = document.activeElement as HTMLElement | null;
          if (!active?.classList.contains('task-card-open-button')) break;
          e.preventDefault();
          const activeId = active.getAttribute('data-task-id');
          const nav = rovingNavStateRef.current;
          const renderedColumns = (nav.isMobile
            ? [nav.mobileActiveTab]
            : nav.visibleColumns.filter(column => !nav.collapsedColumns.has(column))
          ).filter(column => nav.boardData[column].items.length > 0);
          let colIdx = -1;
          let rowIdx = -1;
          for (let index = 0; index < renderedColumns.length; index++) {
            const found = nav.boardData[renderedColumns[index]].items.findIndex(item => item.id === activeId);
            if (found !== -1) { colIdx = index; rowIdx = found; break; }
          }
          if (colIdx === -1) break;
          const key = e.key.toLowerCase();
          const items = nav.boardData[renderedColumns[colIdx]].items;
          let target: Task | undefined;
          if (key === 'arrowdown') target = items[Math.min(rowIdx + 1, items.length - 1)];
          else if (key === 'arrowup') target = items[Math.max(rowIdx - 1, 0)];
          else if (key === 'home') target = items[0];
          else if (key === 'end') target = items[items.length - 1];
          else {
            const nextColIdx = key === 'arrowright'
              ? Math.min(colIdx + 1, renderedColumns.length - 1)
              : Math.max(colIdx - 1, 0);
            if (nextColIdx !== colIdx) {
              const targets = nav.boardData[renderedColumns[nextColIdx]].items;
              target = targets[Math.min(rowIdx, targets.length - 1)];
            }
          }
          if (target && target.id !== activeId) {
            // The pending target is established BEFORE the state update: the
            // focus effect may run on the roving-state render, and a ref set
            // afterwards would miss it (review 4dce263d B1 — observed as a
            // nondeterministic End-key failure under the full suite).
            pendingFocusRef.current = target.id;
            setRovingTaskId(target.id);
            const immediate = document.querySelector(`.task-card-open-button[data-task-id="${target.id}"]`) as HTMLElement | null;
            if (immediate) {
              pendingFocusRef.current = null;
              immediate.focus();
              immediate.scrollIntoView?.({ block: 'nearest' });
            }
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, []);

  // Creation is the routed /tasks/new page (986be411 §7, E6): the modal and
  // the window.prompt quick-add retire. The filtered board hands its context
  // through the query string; the column plus-button carries its status.
  const createTaskHref = useCallback((statusContext?: string): string => {
    const params = new URLSearchParams();
    if (statusContext) params.set('status', statusContext);
    if (filters.projects.length === 1) params.set('project', filters.projects[0]);
    if (filters.phases.length === 1 && filters.phases[0] !== 'null') params.set('phaseId', filters.phases[0]);
    const query = params.toString();
    return query ? `/tasks/new?${query}` : '/tasks/new';
  }, [filters.projects, filters.phases]);

  const handleQuickAdd = (status: string) => {
    navigate(createTaskHref(status));
  };

  const handleUpdateTask = async (taskId: string, updates: Partial<Task>) => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        const message = data.error || data.message || 'The Task update was rejected';
        warning(message);
        return;
      }
      // Success-side warnings (unified archive policy, DoD nudge) are
      // surfaced, never swallowed (C2 §2.2 honesty rule).
      if (data.warning) warning(data.warning);
      await refreshBoard();
    } catch (error) {
      console.error('Failed to update task:', error);
      warning(error instanceof Error ? error.message : 'Failed to update the Task');
    }
  };

  // The move menu's Archive routes through the same confirm as the board's
  // archive actions; the PATCH carries the policy warning surfaced above.
  const handleArchiveFromMenu = (taskId: string) => {
    const target = allLoadedTasks.find(t => t.id === taskId);
    if (!confirm(`Archive "${target?.title ?? 'this task'}"? Archived tasks leave the active board but stay on the Archived column and can be unarchived.`)) return;
    handleUpdateTask(taskId, { status: 'archived' as ColumnKey });
  };

  const handleSubtaskTransition = async (
    taskId: string,
    subtaskIndex: number,
    currentStatus: SubtaskStatus,
    nextStatus: SubtaskStatus,
    details?: SubtaskTransitionDetails,
  ): Promise<void> => {
    try {
      const request = buildSubtaskLifecycleRequest(
        API_BASE_URL,
        taskId,
        subtaskIndex,
        currentStatus,
        nextStatus,
        details,
      );
      const response = await authenticatedFetch(request.path, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || data.message || 'The subtask lifecycle transition was rejected.');
      }
      await refreshBoard();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The subtask lifecycle transition failed.';
      warning(message);
      throw new Error(message);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Are you sure you want to delete this task?')) return;
    try {
      await authenticatedFetch(`${API_BASE_URL}/tasks/${taskId}`, { method: 'DELETE' });
      await refreshBoard();
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const handleDragStart = (task: Task) => setDraggedTask(task);
  const handleDragEnd = () => setDraggedTask(null);

  const handleDrop = (column: ColumnKey) => {
    if (!draggedTask) return;
    let updates: Partial<Task> = { status: column };
    // Drag between columns never changes autoStart - arming is explicit only.
    handleUpdateTask(draggedTask.id, updates);
    setDraggedTask(null);
  };

  const swipeEdgeZone = 40;
  const handleTouchStart = (e: React.TouchEvent) => {
    const x = e.touches[0].clientX;
    const screenW = window.innerWidth;
    swipeFromEdge.current = x < swipeEdgeZone || x > screenW - swipeEdgeZone;
    touchStartX.current = x;
    touchEndX.current = x;
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = () => {
    if (!swipeFromEdge.current) return;
    const diff = touchStartX.current - touchEndX.current;
    if (Math.abs(diff) < 50) return;
    const currentIdx = visibleColumns.indexOf(mobileActiveTab);
    if (diff > 0 && currentIdx < visibleColumns.length - 1) {
      setMobileActiveTab(visibleColumns[currentIdx + 1]);
    } else if (diff < 0 && currentIdx > 0) {
      setMobileActiveTab(visibleColumns[currentIdx - 1]);
    }
  };

  const handleMoveTask = async (taskId: string, targetStatus: string) => {
    await handleUpdateTask(taskId, { status: targetStatus as ColumnKey });
  };

  const handleToggleCollapse = (column: ColumnKey) => {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      const wasCollapsed = next.has(column);
      if (wasCollapsed) {
        next.delete(column);
        setTimeout(() => {
          const el = document.querySelector(`[data-status="${column}"]`);
          el?.scrollIntoView?.({ behavior: 'smooth', inline: 'nearest' });
        }, 100);
      } else {
        next.add(column);
      }
      return next;
    });
  };

  const isColumnCollapsed = (column: ColumnKey): boolean => {
    if (isMobile && column === mobileActiveTab) return false;
    return collapsedColumns.has(column);
  };

  const visibleTaskCount = visibleColumns.reduce((sum, col) => sum + boardData[col].total, 0);
  const hiddenArchivedCount = showArchived ? 0 : boardData.archived.total;

  // Unarchive-to-prior-state (design 986be411 §4, owner ruling E5; resolves
  // 7092b73d): the server derives the archived-from state (fallback
  // Completed) and the toast announces where the Task actually went.
  const handleRestoreArchived = async (taskId: string) => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${taskId}/unarchive`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        warning(data.error || 'The Task could not be unarchived');
        return;
      }
      success(`Unarchived to ${COLUMN_LABELS[data.restoredTo as ColumnKey] ?? data.restoredTo}`);
      await refreshBoard();
    } catch (error) {
      console.error('Failed to unarchive task:', error);
      warning('The Task could not be unarchived');
    }
  };

  const revealArchivedColumn = () => {
    setShowArchived(true);
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      next.delete('archived');
      return next;
    });
    if (isMobile) setMobileActiveTab('archived');
    setTimeout(() => {
      const el = document.querySelector('[data-status="archived"]');
      el?.scrollIntoView?.({ behavior: 'smooth', inline: 'nearest' });
    }, 120);
  };

  // Bulk archive-completed of the FILTERED SCOPE (design 986be411 §4, E3):
  // the id set comes from the server-side IDs-only scope read — NEVER the
  // loaded column window (the 6-item ceiling this replaces, d8507677 §7).
  const [bulkArchive, setBulkArchive] = useState<{ ids: string[]; total: number; scope: string } | null>(null);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  // Client batch UNDER the server cap of 200: one oversized request sat
  // behind the proxy long enough to be aborted mid-flight in live QA (120
  // sequential archives), which mis-reported server-completed work as
  // failed. Smaller batches keep each request short and the progress honest.
  const BULK_ARCHIVE_BATCH = 50;

  const describeFilterScope = useCallback((): string => {
    const parts: string[] = [];
    if (filters.searchQuery) parts.push(`search "${filters.searchQuery}"`);
    if (filters.projects.length) parts.push(`projects ${filters.projects.join(', ')}`);
    if (filters.tags.length) parts.push(`tags ${filters.tags.join(', ')}`);
    if (filters.priorities.length) parts.push(`priorities ${filters.priorities.join(', ')}`);
    if (filters.phases.length) parts.push(`${filters.phases.length} phase filter${filters.phases.length === 1 ? '' : 's'}`);
    if (filters.statuses.length) parts.push(`states ${filters.statuses.join(', ')}`);
    if (filters.mine) parts.push('assigned to me');
    if (filters.owner) parts.push(`assignee ${filters.owner}`);
    if (filters.unassigned) parts.push('unassigned');
    return parts.length ? `Filtered view: ${parts.join(' · ')}` : 'No filters active — every completed task on the board.';
  }, [filters]);

  const buildCompletedScopeParams = useCallback((): string => {
    const params = new URLSearchParams();
    params.set('statuses', 'completed');
    params.set('includeArchived', 'false');
    if (filters.searchQuery) params.set('q', filters.searchQuery);
    if (filters.priorities.length) params.set('priorities', filters.priorities.join(','));
    if (filters.tags.length) params.set('tags', filters.tags.join(','));
    if (filters.projects.length) params.set('projects', filters.projects.join(','));
    if (filters.phases.length) params.set('phaseIds', filters.phases.join(','));
    if (filters.mine) params.set('mine', 'true');
    if (filters.owner) params.set('owner', filters.owner);
    if (filters.unassigned) params.set('unassigned', 'true');
    return params.toString();
  }, [filters]);

  const handleArchiveCompleted = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/ids?${buildCompletedScopeParams()}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        warning(data.error || 'The archive scope could not be read');
        return;
      }
      if (!data.ids.length) {
        warning('No completed tasks to archive in the current view');
        return;
      }
      setBulkArchive({ ids: data.ids, total: data.total, scope: describeFilterScope() });
    } catch (error) {
      console.error('Failed to read the archive scope:', error);
      warning('The archive scope could not be read');
    }
  };

  // Batches above the server cap are the client's job; per-Task failures are
  // surfaced honestly (the old console-only catch retires).
  const runBulkArchive = async () => {
    const scope = bulkArchive;
    if (!scope) return;
    let archived = 0;
    const failures: Array<{ id: string; code: string; error?: string }> = [];
    for (let index = 0; index < scope.ids.length; index += BULK_ARCHIVE_BATCH) {
      const batch = scope.ids.slice(index, index + BULK_ARCHIVE_BATCH);
      setBulkProgress(`Archiving ${Math.min(index + batch.length, scope.ids.length)} of ${scope.ids.length}…`);
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/tasks/bulk-archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskIds: batch }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
          batch.forEach(id => failures.push({ id, code: 'REQUEST_FAILED', error: data.error }));
          continue;
        }
        for (const result of data.results as Array<{ id: string; archived: boolean; code: string; error?: string }>) {
          if (result.archived) archived += 1;
          else failures.push(result);
        }
      } catch (error) {
        console.error('Bulk archive batch failed:', error);
        batch.forEach(id => failures.push({ id, code: 'REQUEST_FAILED' }));
      }
    }
    setBulkProgress(null);
    setBulkArchive(null);
    if (archived > 0) success(`Archived ${archived} completed task${archived === 1 ? '' : 's'}`);
    if (failures.length > 0) {
      const codes = Array.from(new Set(failures.map(f => f.code))).join(', ');
      warning(`${failures.length} task${failures.length === 1 ? '' : 's'} could not be archived (${codes})`, 10000);
    }
    revealArchivedColumn();
    await refreshBoard();
  };

  if (initialLoading) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
        <span>Loading tasks...</span>
      </div>
    );
  }

  return (
    <div className="tasks-page-container fade-in">
      <ToastContainer toasts={toasts} />
      <div className="tasks-page-main">
        {/* Title row + toolbar merged (census A15, owner ruling in
            7fa7e605): ONE header row carries the title and every control —
            view switcher, Search, Show archived, Archive completed, New
            task — all at the compact 36px size (§7: toolbars are compact).
            The search & filter panel (amendment 2d5e2caa Ruling 2) renders
            only after activating Search, on its own full-width row below;
            deep links carrying restored filters open revealed. */}
        <div className="tasks-page-header">
          <div className="tasks-page-header-title">
            <h1><Brain size={16} aria-hidden="true" /> On My Mind</h1>
            <p>
              {visibleTaskCount} thing{visibleTaskCount !== 1 && 's'} in view{hiddenArchivedCount > 0 ? `, plus ${hiddenArchivedCount} archived` : ''}
            </p>
          </div>
          <div className="tasks-page-header-actions">
            <SegmentedControl
              ariaLabel="Task view"
              className="tasks-view-switcher"
              value={selectedView}
              onChange={selectView}
              options={TASK_VIEW_REGISTRY.map(view => {
                const Icon = view.icon;
                return {
                  value: view.id,
                  ariaLabel: view.label,
                  disabled: view.disabled,
                  title: view.tooltip,
                  label: (
                    <>
                      <Icon size={16} aria-hidden="true" />
                      <span className="tasks-view-option-label">{view.label}</span>
                    </>
                  )
                };
              })}
            />

            <button
              ref={searchToggleRef}
              className={`search-toggle-btn ${activeFilterCount > 0 ? 'has-filters' : ''} ${searchPanelOpen ? 'search-toggle-btn--active' : ''}`}
              onClick={() => {
                const next = !searchPanelOpen;
                setSearchPanelOpen(next);
                if (next) requestAnimationFrame(() => {
                  document.querySelector<HTMLInputElement>('#tasks-search-panel input')?.focus();
                });
              }}
              aria-expanded={searchPanelOpen}
              aria-controls="tasks-search-panel"
              aria-label={activeFilterCount > 0 ? `Search and filter (${activeFilterCount} active)` : 'Search and filter'}
              title="Search and filter"
            >
              <Search size={16} aria-hidden="true" />
              <span className="search-toggle-label">Search</span>
              {activeFilterCount > 0 && (
                <span className="search-toggle-badge">{activeFilterCount}</span>
              )}
            </button>

            {!isMobile && (
              <>
                <Button
                  onClick={() => {
                    if (showArchived) setShowArchived(false);
                    else revealArchivedColumn();
                  }}
                  variant={showArchived ? 'primary' : 'secondary'}
                  size="compact"
                  icon={<Eye size={16} />}
                  ariaLabel="Show archived"
                  ariaPressed={showArchived}
                >
                  Show archived
                </Button>

                <Button
                  onClick={handleArchiveCompleted}
                  variant="secondary"
                  size="compact"
                  icon={<Archive size={16} />}
                  ariaLabel="Archive completed"
                  title="Archives completed tasks in the current filtered view"
                >
                  Archive completed
                  {boardData.completed.total > 0 && (
                    <span className="tasks-action-count">{boardData.completed.total}</span>
                  )}
                </Button>
              </>
            )}

            {isMobile && (
              <div className="tasks-toolbar-overflow">
                <IconButton
                  ref={overflowTriggerRef}
                  icon={<MoreHorizontal size={16} />}
                  ariaLabel="More actions"
                  ariaHaspopup="menu"
                  ariaExpanded={overflowOpen}
                  onClick={() => setOverflowOpen(previous => !previous)}
                />
                {overflowOpen && (
                  <div ref={overflowMenuRef} role="menu" aria-label="More actions" className="tasks-overflow-menu">
                    <button
                      role="menuitemcheckbox"
                      aria-checked={showArchived}
                      className="tasks-overflow-item"
                      onClick={() => {
                        if (showArchived) setShowArchived(false);
                        else revealArchivedColumn();
                        closeOverflow(true);
                      }}
                    >
                      <Eye size={16} aria-hidden="true" />
                      Show archived
                    </button>
                    <button
                      role="menuitem"
                      className="tasks-overflow-item"
                      onClick={() => {
                        closeOverflow(true);
                        handleArchiveCompleted();
                      }}
                    >
                      <Archive size={16} aria-hidden="true" />
                      Archive completed
                      {boardData.completed.total > 0 && (
                        <span className="tasks-action-count">{boardData.completed.total}</span>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}

            <Button
              onClick={() => navigate(createTaskHref())}
              variant="primary"
              size="compact"
              icon={<Plus size={16} />}
              ariaLabel="Create new task"
            >
              New task
            </Button>
          </div>
        </div>

        {searchPanelOpen && (
          <div className="tasks-toolbar">
            <div
              id="tasks-search-panel"
              className="search-filter-panel search-filter-panel-open"
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setSearchPanelOpen(false);
                  searchToggleRef.current?.focus();
                }
              }}
            >
              <div className="search-filter-panel-inner">
                <FilterBar
                  tasks={allLoadedTasks}
                  filters={filters}
                  onFiltersChange={handleFiltersChange}
                  availableTags={filterOptions.tags}
                  availableProjects={filterOptions.projects}
                  availableOwners={ownerHandles}
                  canFilterMine={Boolean(myPrincipal)}
                />
              </div>
            </div>
          </div>
        )}

        {/* Board-only chrome. The mobile status tabs drive mobileActiveTab, which
            the Map does not consume, so on the Map they were live controls for
            a surface that was not on screen (review b74ba787 B2). */}
        {isMobile && selectedView === 'board' && (
          <div className="tasks-mobile-tabs">
            {visibleColumns.map(column => {
              const count = boardData[column].total;
              return (
                <button
                  key={column}
                  className={`tasks-mobile-tab ${mobileActiveTab === column ? 'tasks-mobile-tab--active' : ''}`}
                  onClick={() => setMobileActiveTab(column)}
                >
                  <span className="tasks-mobile-tab-label">{COLUMN_LABELS[column].split(' ')[0]}</span>
                  {count > 0 && <span className="tasks-mobile-tab-count">{count}</span>}
                </button>
              );
            })}
          </div>
        )}

        {selectedView === 'map' ? (
          <MapView
            query={{
              q: filters.searchQuery || undefined,
              priorities: filters.priorities,
              tags: filters.tags,
              projects: filters.projects,
              phases: filters.phases,
              // ONE filter state across both views: omitting statuses made
              // the Map request the full status scope while the board
              // honoured the selection (review 8b1cca24 B1).
              statuses: filters.statuses,
              includeArchived: showArchived,
              mine: filters.mine || undefined,
              owner: filters.owner || undefined,
              unassigned: filters.unassigned || undefined,
            }}
            onOpenTask={taskId => {
              // Capture the FULL current URL, not just the id: the return
              // control needs ?view=map and every active filter, or Back
              // lands on the bare Board (review 8b1cca24 B4).
              captureTaskBoardOrigin(taskId, searchParams.toString() ? `/tasks?${searchParams.toString()}` : '/tasks');
              navigate(`/tasks/${taskId}`);
            }}
            onOpenReport={reportId => navigate(`/reports/${reportId}`)}
          />
        ) : (
        <div
          className="tasks-page-board"
          onTouchStart={isMobile ? handleTouchStart : undefined}
          onTouchMove={isMobile ? handleTouchMove : undefined}
          onTouchEnd={isMobile ? handleTouchEnd : undefined}
        >
          <div className="tasks-page-board-inner" ref={boardInnerRef} onScroll={handleBoardScroll}>
            {(isMobile ? [mobileActiveTab] : visibleColumns).map(column => (
              <TaskColumn
                key={column}
                status={column as any}
                title={COLUMN_LABELS[column]}
                tasks={boardData[column].items}
                total={boardData[column].total}
                hasMore={boardData[column].hasMore}
                loadingMore={boardData[column].loading}
                onLoadMore={() => loadMoreColumn(column)}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDrop={() => handleDrop(column)}
                onUpdateTask={handleUpdateTask}
                onSubtaskTransition={handleSubtaskTransition}
                onDeleteTask={handleDeleteTask}
                onQuickAdd={handleQuickAdd}
                collapsed={isColumnCollapsed(column)}
                onToggleCollapse={() => handleToggleCollapse(column)}
                isMobile={isMobile}
                onMoveTask={handleMoveTask}
                archiveAvailable={showArchived}
                onArchiveTask={handleArchiveFromMenu}
                pulsedTaskIds={pulsedTaskIds}
                rovingTaskId={rovingActiveTaskId}
                onOpenerFocus={setRovingTaskId}
                onTagClick={handleTagClickWithPanel}
                deepLinkTaskId={deepLinkTaskId}
                onDeepLinkHandled={handleDeepLinkHandled}
                onRestoreArchived={column === 'archived' ? handleRestoreArchived : undefined}
                principalsById={principalsById}
                viewerPrincipalId={myPrincipal?.id ?? null}
              />
            ))}
          </div>
        </div>
        )}
      </div>

      {bulkArchive && (
        <ConfirmationModal
          title={`Archive ${bulkArchive.total} completed task${bulkArchive.total === 1 ? '' : 's'}?`}
          message={(
            <>
              <p>{bulkArchive.scope}</p>
              <p>Archived tasks leave the active board but stay on the Archived column and can be unarchived.</p>
              <p role="status" aria-live="polite">{bulkProgress ?? ''}</p>
            </>
          )}
          confirmLabel={`Archive ${bulkArchive.total}`}
          onConfirm={runBulkArchive}
          onCancel={() => { if (!bulkProgress) setBulkArchive(null); }}
        />
      )}

    </div>
  );
};
