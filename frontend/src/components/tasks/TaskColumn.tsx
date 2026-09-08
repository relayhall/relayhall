import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Handshake, Inbox, Lightbulb, LoaderCircle, PartyPopper, Plus, Search, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Task, TaskStatus, Principal, SubtaskTransitionHandler } from '../../types/task';
import { TaskCard } from './TaskCard';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import './TaskColumn.css';

const EMPTY_STATES: Record<string, { icon: LucideIcon; message: string; hint: string }> = {
  'ideas': { icon: Lightbulb, message: 'No ideas yet', hint: 'Drag tasks here to save for later' },
  'todo': { icon: ClipboardList, message: 'All caught up!', hint: 'Drag tasks here for automation to pick up' },
  'in-progress': { icon: Zap, message: 'Nothing active', hint: 'Pick a task to start working' },
  'review': { icon: Search, message: 'Nothing awaiting review', hint: 'Finished tasks appear here' },
  'stuck': { icon: Handshake, message: 'All clear!', hint: 'Tasks needing human help appear here' },
  'completed': { icon: PartyPopper, message: 'Nothing completed yet', hint: 'Finished tasks land here' },
  'archived': { icon: Archive, message: 'No archived tasks', hint: 'Auto-archives after 7 days' },
};

interface TaskColumnProps {
  status: TaskStatus | string;
  title: string;
  tasks: Task[];
  total?: number;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Tasks whose card should play the live-update pulse (A4). */
  pulsedTaskIds?: Set<string>;
  onDragStart: (task: Task) => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  onSubtaskTransition: SubtaskTransitionHandler;
  onDeleteTask: (taskId: string) => void;
  onQuickAdd?: (status: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isMobile?: boolean;
  onMoveTask?: (taskId: string, targetStatus: string) => void;
  /** Archive appears in the card move menu only where the board offers it. */
  archiveAvailable?: boolean;
  onArchiveTask?: (taskId: string) => void;
  /** The single task whose opener is currently in the tab order (roving). */
  rovingTaskId?: string | null;
  onOpenerFocus?: (taskId: string) => void;
  onTagClick?: (tag: string) => void;
  sessionActivityMap?: Map<string, number>;
  deepLinkTaskId?: string | null;
  onDeepLinkHandled?: () => void;
  onRestoreArchived?: (taskId: string) => void;
  /** Principal directory for attribution; empty until the substrate is live. */
  principalsById?: Map<string, Principal>;
  /** The viewing principal — being your own Assignee is the unremarkable case. */
  viewerPrincipalId?: string | null;
}

// Stale threshold: 10 minutes in milliseconds
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

function getSessionActivityState(
  task: Task,
  sessionActivityMap?: Map<string, number>
): 'active' | 'stale' | null {
  if (task.status !== 'in-progress' || !task.activeAgent) return null;
  
  const sessionKey = typeof task.activeAgent === 'object' ? task.activeAgent.sessionKey : null;
  if (!sessionKey || sessionKey === 'pending' || !sessionActivityMap) {
    // Has activeAgent but no session data — treat as stale if in-progress
    if (task.status === 'in-progress' && task.activeAgent) return 'stale';
    return null;
  }
  
  const lastActivity = sessionActivityMap.get(sessionKey);
  if (lastActivity === undefined) {
    // Session not found in gateway — agent may have finished, treat as stale
    return 'stale';
  }
  
  const elapsed = Date.now() - lastActivity;
  return elapsed <= STALE_THRESHOLD_MS ? 'active' : 'stale';
}

export const TaskColumn: React.FC<TaskColumnProps> = ({
  status,
  title,
  tasks,
  total,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  pulsedTaskIds,
  onDragStart,
  onDragEnd,
  onDrop,
  onUpdateTask,
  onSubtaskTransition,
  onDeleteTask,
  onQuickAdd,
  collapsed = false,
  onToggleCollapse,
  isMobile = false,
  onMoveTask,
  archiveAvailable,
  onArchiveTask,
  rovingTaskId,
  onOpenerFocus,
  onTagClick,
  sessionActivityMap,
  deepLinkTaskId,
  onDeepLinkHandled,
  onRestoreArchived,
  principalsById,
  viewerPrincipalId,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const remainingCount = Math.max((total || 0) - tasks.length, 0);

  // ---- Render virtualization (986be411 §5, E4; candidate A4) ----
  // A render window over the LOADED set: below the threshold every card
  // renders exactly as before (small boards and unit tests stay byte-true);
  // above it, only the scrolled-to slice mounts between two height spacers.
  // The roving-tabindex and deep-link cards are kept alive even off-window —
  // the keyboard contract derives from the RENDER tree (C2 §2.2).
  const VIRTUAL_THRESHOLD = 60;
  const APPROX_ROW_PX = 148;
  const VIRTUAL_OVERSCAN = 8;
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrollWindow, setScrollWindow] = useState({ start: 0, end: VIRTUAL_THRESHOLD });
  const virtualized = tasks.length > VIRTUAL_THRESHOLD && !collapsed;
  const handleContentScroll = () => {
    const node = contentRef.current;
    if (!node || !virtualized) return;
    const start = Math.max(Math.floor(node.scrollTop / APPROX_ROW_PX) - VIRTUAL_OVERSCAN, 0);
    const end = Math.min(Math.ceil((node.scrollTop + node.clientHeight) / APPROX_ROW_PX) + VIRTUAL_OVERSCAN, tasks.length);
    setScrollWindow(previous => (previous.start === start && previous.end === end ? previous : { start, end }));
  };
  const { renderedTasks, topSpacerPx, bottomSpacerPx } = useMemo(() => {
    if (!virtualized) return { renderedTasks: tasks, topSpacerPx: 0, bottomSpacerPx: 0 };
    const start = Math.min(scrollWindow.start, Math.max(tasks.length - 1, 0));
    const end = Math.min(Math.max(scrollWindow.end, start + 1), tasks.length);
    const windowSlice = tasks.slice(start, end);
    const keepAliveIds = new Set([rovingTaskId, deepLinkTaskId].filter(Boolean) as string[]);
    for (const task of tasks) {
      if (keepAliveIds.has(task.id) && !windowSlice.some(item => item.id === task.id)) {
        windowSlice.push(task);
      }
    }
    return {
      renderedTasks: windowSlice,
      topSpacerPx: start * APPROX_ROW_PX,
      bottomSpacerPx: Math.max(tasks.length - end, 0) * APPROX_ROW_PX,
    };
  }, [virtualized, tasks, scrollWindow, rovingTaskId, deepLinkTaskId]);

  // Genuine load-on-scroll: an IntersectionObserver sentinel at the list end
  // triggers the next A3 page; the labelled button stays as the accessible,
  // observer-free fallback (and the only path under jsdom).
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !onLoadMore || !hasMore || loadingMore || collapsed) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onLoadMore();
    }, { root: contentRef.current, rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, loadingMore, collapsed, tasks.length]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    onDrop();
  };

  const columnClass = [
    'task-column',
    collapsed ? 'task-column-collapsed' : 'task-column-expanded',
    isDragOver ? 'task-column-drag-over' : ''
  ].filter(Boolean).join(' ');

  return (
    <div 
      className={columnClass}
      data-status={status}
      role="group"
      aria-label={`${title} column, ${tasks.length} tasks`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="task-column-header">
        <div className="task-column-title">
          <h2>{title}</h2>
        </div>
        <div className="task-column-header-right">
          {onQuickAdd && !collapsed && (
            <IconButton
              className="task-column-quick-add"
              variant="ghost"
              ariaLabel={`Add task to ${title}`}
              title={`Add task to ${title}`}
              icon={<Plus size={16} />}
              onClick={(e) => { e.stopPropagation(); onQuickAdd(status); }}
            />
          )}
          <div className="task-column-count">{typeof total === 'number' ? total : tasks.length}</div>
          {onToggleCollapse && (
            <IconButton
              className="task-column-collapse-btn"
              variant="ghost"
              ariaLabel={collapsed ? 'Expand column' : 'Collapse column'}
              title={collapsed ? 'Expand column' : 'Collapse column'}
              ariaExpanded={!collapsed}
              icon={collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapse();
              }}
            />
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="task-column-content" ref={contentRef} onScroll={handleContentScroll}>
          {status === 'archived' && (total || tasks.length) > 0 && (
            <div className="task-column-insight">
              <span className="task-column-insight-eyebrow">Archived stays close</span>
              <strong>
                {(total || tasks.length)} archived task{(total || tasks.length) === 1 ? '' : 's'} still live on the board
              </strong>
              <p>Search them, browse them, and restore anything straight back to Completed without losing context.</p>
            </div>
          )}

          {tasks.length === 0 ? (
            <div className="task-column-empty">
              <div className="task-column-empty-icon">
                {(() => {
                  const EmptyIcon = EMPTY_STATES[status]?.icon ?? Inbox;
                  return <EmptyIcon size={28} aria-hidden="true" />;
                })()}
              </div>
              <div className="task-column-empty-message">{EMPTY_STATES[status]?.message || 'No tasks'}</div>
              <div className="task-column-empty-hint">{EMPTY_STATES[status]?.hint || ''}</div>
            </div>
          ) : (
            <>
              {topSpacerPx > 0 && <div className="task-column-virtual-spacer" style={{ height: topSpacerPx }} aria-hidden="true" />}
              {renderedTasks.map(task => (
                <div key={task.id} className={`task-card-wrapper ${pulsedTaskIds?.has(task.id) ? 'task-card-wrapper--pulse' : ''}`}>
                  <TaskCard
                    task={task}
                    onDragStart={() => onDragStart(task)}
                    onDragEnd={onDragEnd}
                    onUpdate={(updates) => onUpdateTask(task.id, updates)}
                    onSubtaskTransition={onSubtaskTransition}
                    onDelete={() => onDeleteTask(task.id)}
                    disableDrag={isMobile}
                    onMoveTask={onMoveTask}
                    archiveAvailable={archiveAvailable}
                    onArchiveTask={onArchiveTask}
                    openerTabbable={rovingTaskId == null || rovingTaskId === task.id}
                    onOpenerFocus={onOpenerFocus}
                    onTagClick={onTagClick}
                    sessionActivityState={getSessionActivityState(task, sessionActivityMap)}
                    deepLinkTaskId={deepLinkTaskId}
                    onDeepLinkHandled={onDeepLinkHandled}
                    principalsById={principalsById}
                    viewerPrincipalId={viewerPrincipalId}
                  />
                  {status === 'archived' && onRestoreArchived && (
                    <Button
                      variant="secondary"
                      size="compact"
                      className="task-column-restore-action"
                      icon={<ArchiveRestore size={16} />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRestoreArchived(task.id);
                      }}
                    >
                      Unarchive
                    </Button>
                  )}
                </div>
              ))}
              {bottomSpacerPx > 0 && <div className="task-column-virtual-spacer" style={{ height: bottomSpacerPx }} aria-hidden="true" />}
              <div ref={sentinelRef} className="task-column-scroll-sentinel" aria-hidden="true" />
              {hasMore && onLoadMore && (
                <Button
                  variant="secondary"
                  size="compact"
                  className="task-column-load-more"
                  onClick={onLoadMore}
                  disabled={loadingMore}
                  ariaLabel={loadingMore ? `Loading more tasks in ${title}` : `Load ${remainingCount} more tasks in ${title}`}
                >
                  <span className="task-column-load-more-copy">
                    <span className="task-column-load-more-label">
                      {loadingMore ? (
                        <>
                          <LoaderCircle size={16} className="task-column-load-more-spinner" />
                          Loading next batch
                        </>
                      ) : (
                        <>
                          <ChevronDown size={16} />
                          Load more from {title}
                        </>
                      )}
                    </span>
                    <span className="task-column-load-more-meta">
                      {loadingMore ? 'Pulling more cards into this lane' : `${remainingCount} still waiting in this column`}
                    </span>
                  </span>
                  <span className="task-column-load-more-pill">{remainingCount}</span>
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
