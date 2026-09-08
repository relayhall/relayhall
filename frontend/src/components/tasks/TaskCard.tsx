import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Task, type SubtaskTransitionHandler } from '../../types/task';
import { AlertTriangle, Ban, Brain, CalendarClock, CheckCircle2, Clock, Cpu, Eye, Flag, Folder, GripVertical, Link, Lock, OctagonAlert, Radio, RefreshCw, Square, Tag, Terminal } from 'lucide-react';
import { TaskCardMoveMenu } from './TaskCardMoveMenu';
import { captureTaskBoardOrigin } from '../../utils/taskBoardNavigation';
import { dueTone, formatDateTimeLong, formatRelativeDue } from '../../utils/dateFormat';
import { PersonalityBadge } from '../PersonalityBadge';
import { PrincipalAvatar } from '../PrincipalAvatar';
import type { Principal } from '../../types/task';
import './TaskCard.css';

interface TaskCardProps {
  task: Task;
  onDragStart: () => void;
  onDragEnd: () => void;
  onUpdate: (updates: Partial<Task>) => void;
  onSubtaskTransition: SubtaskTransitionHandler;
  onDelete: () => void;
  disableDrag?: boolean;
  /** The move menu performs the same PATCH {status} as a drop (C2 §2.2). */
  onMoveTask?: (taskId: string, targetStatus: string) => void;
  /** Archive appears in the menu only where the board offers it (parity). */
  archiveAvailable?: boolean;
  onArchiveTask?: (taskId: string) => void;
  /** Roving tab stop (C2 §2.2): only one opener board-wide is tabbable. */
  openerTabbable?: boolean;
  /** A7 (986be411 §6): the map tile IS this card — density variants render
   *  the same visual language without the board-only machinery. */
  density?: 'board' | 'map-tile' | 'map-detail';
  /** Map density only (§3): the working agent's name, shown as a pulsing
   *  badge that survives EVERY zoom — it is the "who works now" signal. */
  mapAgent?: string | null;
  /** Map density only (§3): subtask progress for the tile bar. */
  mapProgress?: { done: number; total: number } | null;
  /** Map density only (§5): the RESOLVED detail band flags. These GOVERN what
   *  the tile composes — the table in useMapData is authoritative, not
   *  decorative. Omitted (board density) means "draw everything". */
  mapDetail?: { title: boolean; meta: boolean; progress: boolean; agentName: boolean } | null;
  /** Map open contract: Enter/click opens the routed Task details. */
  onOpen?: () => void;
  onOpenerFocus?: (taskId: string) => void;
  onTagClick?: (tag: string) => void;
  sessionActivityState?: 'active' | 'stale' | null;
  deepLinkTaskId?: string | null;
  onDeepLinkHandled?: () => void;
  /** Principal directory for attribution; empty until the substrate is live. */
  principalsById?: Map<string, Principal>;
  /** The viewing principal — being your own Assignee is the unremarkable case. */
  viewerPrincipalId?: string | null;
}

/**
 * The progress bar's tooltip used to be six bare numbers — "1 0 0 0 0 2" —
 * which is the shape of the counts object and not a sentence anybody can read.
 * Same numbers, said out loud, and the states that are zero stay quiet.
 */
export function subtaskProgressLabel(
  counts: { completed: number; inProgress: number; review: number; blocked: number; skipped: number; empty: number },
  total: number,
): string {
  const rest: string[] = [];
  if (counts.inProgress > 0) rest.push(`${counts.inProgress} in progress`);
  if (counts.review > 0) rest.push(`${counts.review} in review`);
  if (counts.blocked > 0) rest.push(`${counts.blocked} stuck`);
  if (counts.skipped > 0) rest.push(`${counts.skipped} skipped`);
  const head = `${counts.completed} of ${total} Subtasks done`;
  return rest.length > 0 ? `${head} · ${rest.join(' · ')}` : head;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  onDragStart,
  onDragEnd,

  disableDrag = false,
  onMoveTask,
  archiveAvailable = false,
  onArchiveTask,
  openerTabbable = true,
  density = 'board',
  mapAgent = null,
  mapProgress = null,
  mapDetail = null,
  onOpen,
  onOpenerFocus,
  onTagClick,
  sessionActivityState,
  deepLinkTaskId,
  onDeepLinkHandled,
  principalsById,
  viewerPrincipalId,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [isDragging, setIsDragging] = useState(false);
  const [elapsed, setElapsed] = useState('');
  const [moveMenuAnchor, setMoveMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  // HTML5 drag is never offered on coarse pointers at any width (§2.2) —
  // the move menu is the touch path everywhere, scroll stays scroll.
  const coarsePointer = useMemo(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
    [],
  );
  const dragEnabled = !disableDrag && !coarsePointer;

  const openMoveMenu = () => {
    const rect = handleRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMoveMenuAnchor({
      x: Math.min(rect.right + 4, Math.max(0, window.innerWidth - 240)),
      y: Math.min(rect.top, Math.max(0, window.innerHeight - 320)),
    });
  };
  const closeMoveMenu = () => {
    setMoveMenuAnchor(null);
    handleRef.current?.focus();
  };
  // The origin handoff carries the FULL board URL (path + query) so the
  // details page's return surfaces restore view + filters (986be411 §3).
  const openTask = () => {
    captureTaskBoardOrigin(task.id, `${location.pathname}${location.search}`);
    navigate(`/tasks/${task.id}`);
  };

  // Legacy board deep links resolve against loaded cards, then replace with the
  // canonical full-UUID page route. No modal state survives this handoff.
  useEffect(() => {
    if (deepLinkTaskId && task.id === deepLinkTaskId) {
      captureTaskBoardOrigin(task.id, `${location.pathname}${location.search}`);
      navigate(`/tasks/${task.id}`, { replace: true });
      onDeepLinkHandled?.();
    }
  }, [deepLinkTaskId, task.id, navigate, onDeepLinkHandled, location.pathname, location.search]);

  const isInteractive = task.executionMode === 'interactive';

  // Duration timer for active interactive sessions
  useEffect(() => {
    if (!isInteractive || !task.startedAt || task.status === 'completed' || task.status === 'archived') return;

    const updateElapsed = () => {
      const start = new Date(task.startedAt!).getTime();
      const diff = Math.max(0, Date.now() - start);
      const mins = Math.floor(diff / 60000);
      const hrs = Math.floor(mins / 60);
      if (hrs > 0) {
        setElapsed(`${hrs}h ${mins % 60}m`);
      } else {
        setElapsed(`${mins}m`);
      }
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 60000);
    return () => clearInterval(interval);
  }, [isInteractive, task.startedAt, task.status]);

  // Derive interactive session status
  const getSessionStatus = (): { label: string; className: string } | null => {
    if (!isInteractive) return null;
    if (task.status === 'completed' || task.status === 'archived') {
      return { label: 'Completed', className: 'session-status-completed' };
    }
    if (task.status === 'stuck') {
      return { label: 'Waiting for Input', className: 'session-status-waiting' };
    }
    if (task.activeAgent && task.status === 'in-progress') {
      if (sessionActivityState === 'stale') {
        return { label: 'Idle', className: 'session-status-idle' };
      }
      return { label: 'Running', className: 'session-status-running' };
    }
    if (task.acpSessionKey && task.status === 'in-progress') {
      return { label: 'Running', className: 'session-status-running' };
    }
    return { label: 'Idle', className: 'session-status-idle' };
  };

  const sessionStatus = getSessionStatus();

  // Check if any subtask is blocked
  const hasBlockedSubtask = task.subtasks?.some(s => s.status === 'stuck') || false;
  const dependencyIds = task.dependsOn || [];
  const blockingTasks = task.blockingTasks || [];
  const dependentTasks = task.dependentTasks || [];
  const hasDependencies = dependencyIds.length > 0;
  const dependencyTitle = hasDependencies
    ? `Depends on: ${dependencyIds.map(id => id.slice(0, 8)).join(', ')}`
    : '';
  const blockingTitle = blockingTasks.length > 0
    ? `Blocked by incomplete: ${blockingTasks.map(t => `${t.title} (${t.id.slice(0, 8)})`).join(', ')}`
    : dependencyTitle;
  const blocksTitle = dependentTasks.length > 0
    ? `Blocks: ${dependentTasks.map(t => `${t.title} (${t.id.slice(0, 8)})`).join(', ')}`
    : '';

  // The chip renders one letter — U, H, N, L, S. That is legible as a colour
  // band and illegible as a word, and a screen reader read it as "U". The
  // letter stays; the meaning is now attached to it.
  const priorityLabel = `Priority: ${task.priority}`;

  const getPriorityClass = (): string => {
    switch (task.priority) {
      case 'urgent': return 'priority-urgent';
      case 'high': return 'priority-high';
      case 'normal': return 'priority-normal';
      case 'low': return 'priority-low';
      case 'someday': return 'priority-someday';
      default: return 'priority-normal';
    }
  };


  // ---- A7 map density variants: same card language, read-only tile. ----
  // §5: contracted content is FADED, never unmounted. Keeping every element
  // mounted is also what makes the LOD continuous — the tile box is measured
  // and fed back into the layout, so adding or removing children at a
  // threshold would move tiles, bands and edge endpoints (review b74ba787 B1).
  const contracted = (shown: boolean) => (shown ? '' : ' map-contracted');
  // EXACTLY ONE real opener (the stretched button): the <article> carries no
  // role and no onClick, so the tile is a single tab stop with one name.
  if (density === 'map-tile' || density === 'map-detail') {
    return (
      <article
        className={`task-card task-card-compact task-card--${density} ${getPriorityClass()}`}
        data-status={task.status}
      >
        <button
          type="button"
          className="task-card-map-open"
          /* The routed return needs to find THIS control again to give it back
             focus (review 7fc68646 B2). Same hook the board opener uses. */
          data-task-id={task.id}
          aria-label={`${task.title} — ${task.status}, priority ${task.priority}${task.project ? `, Project ${task.project}` : ''}`}
          onClick={onOpen}
        />
        {/* The live-agent badge is deliberately the FIRST child and lives
            OUTSIDE the faded content: §3 says it survives every zoom, so
            it must not be part of what the far detail band fades out. */}
        {mapAgent ? (
          <span className="task-card-map-agent" title={`${mapAgent} is working on this now`}>
            <span className="task-card-map-agent-dot" aria-hidden="true" />
            {/* The DOT is ungated (§3: liveness survives every zoom); only the
                NAME is close-only, and the table decides that — not CSS. */}
            <span className={`task-card-map-agent-name${contracted(!mapDetail || mapDetail.agentName)}`}>
              {mapAgent}
            </span>
            <span className="sr-only">{mapAgent} is working on this now</span>
          </span>
        ) : null}
        <p className={`task-card-title-compact${contracted(!mapDetail || mapDetail.title)}`}>
          {task.title}
        </p>
        {mapProgress && mapProgress.total > 0 ? (
          <span className={`task-card-map-progress${contracted(!mapDetail || mapDetail.progress)}`}
            role="img"
            aria-label={`${mapProgress.done} of ${mapProgress.total} subtasks done`}>
            <span
              className="task-card-map-progress-fill"
              style={{ width: `${Math.round((mapProgress.done / mapProgress.total) * 100)}%` }}
            />
          </span>
        ) : null}
        {(
          <div className={`task-card-map-meta${contracted(!mapDetail || mapDetail.meta)}`}>
            <span className={`task-card-map-status task-card-map-status--${task.status}`}>{task.status}</span>
            {/* §3 names the priority chip as part of the tile. It reuses the
                board card's own chip so the map speaks the same language. */}
            <span
              className={`task-card-priority-compact ${getPriorityClass()}`}
              role="img"
              aria-label={priorityLabel}
              title={priorityLabel}
            >
              {task.priority.charAt(0).toUpperCase()}
            </span>
            {task.project ? (
              <span className={`task-card-map-project${contracted(density === 'map-detail')}`}>
                {task.project}
              </span>
            ) : null}
          </div>
        )}
      </article>
    );
  }

  return (
    <>
      {/* Move menu — portal-mounted OUTSIDE the handle button (§2.2) */}
      {moveMenuAnchor && (
        <TaskCardMoveMenu
          taskTitle={task.title}
          currentStatus={task.status}
          archiveAvailable={archiveAvailable && Boolean(onArchiveTask)}
          anchor={moveMenuAnchor}
          onSelect={(target) => { setMoveMenuAnchor(null); onMoveTask?.(task.id, target); }}
          onArchive={() => { setMoveMenuAnchor(null); onArchiveTask?.(task.id); }}
          onClose={closeMoveMenu}
        />
      )}

      {/* Compact Card — the article carries NO interactive role of its own
          (a7df1af repair, preserved). Drag initiates ONLY from the handle. */}
      <article
        ref={articleRef}
        className={`task-card task-card-compact ${isDragging ? 'dragging' : ''} ${task.blocked ? 'task-blocked' : ''} ${hasBlockedSubtask ? 'subtask-blocked' : ''} ${task.activeAgent && task.status === 'in-progress' ? 'agent-active' : ''} ${sessionActivityState === 'active' ? 'session-active' : ''} ${sessionActivityState === 'stale' ? 'session-stale' : ''}`}
      >
        {/* Left-edge grip-strip drag handle: 24px visible, 44px hit (§2.1).
            Enter/Space/click opens the keyboard move menu. */}
        <button
          ref={handleRef}
          type="button"
          className="task-card-drag-handle"
          aria-label={`Move task: ${task.title}`}
          aria-haspopup="menu"
          aria-expanded={moveMenuAnchor ? 'true' : 'false'}
          draggable={dragEnabled}
          onDragStart={dragEnabled ? (e) => {
            // Firefox requires setData in dragstart; the board drop path keys
            // off React state (spike-verified primary mechanism).
            e.dataTransfer.setData('text/plain', task.id);
            if (articleRef.current) e.dataTransfer.setDragImage(articleRef.current, 24, 24);
            setIsDragging(true);
            onDragStart();
          } : undefined}
          onDragEnd={dragEnabled ? () => { setIsDragging(false); onDragEnd(); } : undefined}
          onClick={openMoveMenu}
        >
          <GripVertical size={16} aria-hidden="true" />
        </button>

        {/* Stretched open surface: a non-interactive overlay forwarding to the
            opener's action. The accessibility tree keeps exactly ONE named
            opener (the title button); this adds no role and no tab stop. */}
        <span
          className="task-card-open-surface"
          aria-hidden="true"
          onClick={openTask}
        />
        {/* Compact Card Content */}
        <div className="task-card-compact-header">
          {/* Title (1 line, truncated) */}
          <h3 className="task-card-title-compact">
            <button
              type="button"
              className="task-card-open-button"
              data-task-id={task.id}
              aria-label={`Open task: ${task.title}`}
              tabIndex={openerTabbable ? 0 : -1}
              onFocus={() => onOpenerFocus?.(task.id)}
              onClick={openTask}
            >
              {task.title}
            </button>
          </h3>
          
          {/* Header Icons: Auto-start, Blocked/NeedsReview, Session Link */}
          {task.autoStart === true && (
            <span className="task-card-icon-flag" title="Auto-pickup enabled (orchestrator may pick this up)">
              <Flag size={16} />
            </span>
          )}
          {hasBlockedSubtask && (
            <span className="task-card-subtask-blocked-flag" title="A subtask is stuck">
              <OctagonAlert size={16} aria-hidden="true" />
            </span>
          )}
          {(task.blocked || task.needsReview) && (
            <span className={`task-card-icon-alert ${task.needsReview ? 'needs-review' : 'is-blocked'}`} title={task.needsReview ? 'Needs human review' : 'Blocked'}>
              <AlertTriangle size={16} />
            </span>
          )}
          
          {/* Active Agent Session Link. A CHIP, exempt from the s7 two-size
              rule by owner ruling de70a6dd R7 (declared amendment 7-A1 on
              design 77950a97): inline metadata inside a dense record surface,
              a shortcut rather than the card's primary action, and never the
              only route to what it does. */}
          {task.activeAgent && typeof task.activeAgent === 'object' && task.activeAgent.sessionKey && task.activeAgent.sessionKey !== 'pending' && (
            <button
              className="task-card-session-link"
              onClick={(e) => {
                e.stopPropagation();
                const sessionKey = typeof task.activeAgent === 'object' && task.activeAgent ? task.activeAgent.sessionKey : '';
                navigate(`/sessions?session=${sessionKey}`);
              }}
              title={`View agent session: ${typeof task.activeAgent === 'object' ? task.activeAgent.sessionKey : ''}`}
              aria-label="View active agent session"
            >
              <Radio size={16} />
            </button>
          )}
        </div>

        {/* Interactive Session Badge + Status */}
        {isInteractive && (
          <div className="task-card-interactive-row">
            <span className="task-card-interactive-badge">
              <Terminal size={16} />
              <span>Interactive</span>
            </span>
            {sessionStatus && (
              <span className={`task-card-session-status ${sessionStatus.className}`}>
                <span className="session-status-dot" />
                <span>{sessionStatus.label}</span>
              </span>
            )}
            {elapsed && task.status !== 'completed' && task.status !== 'archived' && (
              <span className="task-card-session-timer">
                <Clock size={16} />
                <span>{elapsed}</span>
              </span>
            )}
          </div>
        )}

        {/* Project Badge — before tags */}
        {task.project && (
          <button
            type="button"
            className="task-card-project-badge"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/projects?open=${encodeURIComponent(task.project!)}`);
            }}
            title={`Project: ${task.project}`}
          >
            <Folder size={16} aria-hidden="true" />
            <span>{task.project}</span>
          </button>
        )}
        
        {/* Personality badge */}
        {(task as any).personality && (
          <PersonalityBadge personality={(task as any).personality} size="sm" />
        )}

        {/* Tags — after project */}
        {task.tags && task.tags.length > 0 && (
          <div className="task-card-tags">
            {task.tags.slice(0, 3).map((tag) => (
              <button
                key={tag}
                className="task-card-tag"
                onClick={(e) => {
                  e.stopPropagation();
                  onTagClick?.(tag);
                }}
                title={`Filter by tag: ${tag}`}
              >
                <Tag size={16} />
                <span>{tag}</span>
              </button>
            ))}
            {task.tags.length > 3 && (
              <span className="task-card-tag-more">+{task.tags.length - 3}</span>
            )}
          </div>
        )}

        {/* Subtask Progress Bar */}
        {task.subtasks && task.subtasks.length > 0 && (() => {
          const counts = task.subtasks.reduce(
            (acc, s) => {
              if (s.status === 'completed' || s.completed) acc.completed++;
              else if (s.status === 'in-progress') acc.inProgress++;
              else if (s.status === 'review') acc.review++;
              else if (s.status === 'stuck') acc.blocked++;
              else if (s.status === 'skipped') acc.skipped++;
              else acc.empty++;
              return acc;
            },
            { completed: 0, inProgress: 0, review: 0, blocked: 0, skipped: 0, empty: 0 }
          );
          const total = task.subtasks.length;
          const pct = (n: number) => `${(n / total) * 100}%`;
          return (
            <div className="task-card-subtask-progress" title={subtaskProgressLabel(counts, total)}>
              <div className="subtask-bar">
                {counts.completed > 0 && <div className="subtask-bar-segment bar-completed" style={{ width: pct(counts.completed) }} />}
                {counts.inProgress > 0 && <div className="subtask-bar-segment bar-in-progress" style={{ width: pct(counts.inProgress) }} />}
                {counts.review > 0 && <div className="subtask-bar-segment bar-review" style={{ width: pct(counts.review) }} />}
                {counts.blocked > 0 && <div className="subtask-bar-segment bar-blocked" style={{ width: pct(counts.blocked) }} />}
                {counts.skipped > 0 && <div className="subtask-bar-segment bar-skipped" style={{ width: pct(counts.skipped) }} />}
              </div>
              <span className="subtask-counts">
                {counts.completed > 0 && <span><CheckCircle2 size={16} aria-hidden="true" />{counts.completed}</span>}
                {counts.inProgress > 0 && <span><RefreshCw size={16} aria-hidden="true" />{counts.inProgress}</span>}
                {counts.review > 0 && <span><Eye size={16} aria-hidden="true" />{counts.review}</span>}
                {counts.blocked > 0 && <span><Ban size={16} aria-hidden="true" />{counts.blocked}</span>}
                {counts.empty > 0 && <span><Square size={16} aria-hidden="true" />{counts.empty}</span>}
              </span>
            </div>
          );
        })()}

        {/* Dependency Badges */}
        {(task.blocked || hasDependencies) && (
          <div
            className={task.blocked ? "task-card-blocked" : "task-card-depends"}
            title={blockingTitle}
          >
            <Lock size={16} />
            <span>
              {task.blocked && blockingTasks.length > 0
                ? `Blocked by ${blockingTasks.length} task${blockingTasks.length > 1 ? 's' : ''}`
                : `Depends on ${dependencyIds.length} task${dependencyIds.length > 1 ? 's' : ''}`}
            </span>
          </div>
        )}
        
        {dependentTasks.length > 0 && (
          <div className="task-card-blocks" title={blocksTitle}>
            <Link size={16} />
            <span>Blocks {dependentTasks.length} task{dependentTasks.length > 1 ? 's' : ''}</span>
          </div>
        )}

        {/* Working now: who is on this task. Prefers the resolved spawn
            principal; falls back to the free-text agent name that predates
            attribution so historical/unresolved rows read exactly as before. */}
        {task.activeAgent && (() => {
          const agentName = typeof task.activeAgent === 'string'
            ? task.activeAgent
            : task.activeAgent?.name || 'agent';
          const principalId = typeof task.activeAgent === 'object' ? task.activeAgent?.principalId : undefined;
          const principal = principalId ? principalsById?.get(principalId) : undefined;
          return (
            <div className="task-card-agent-compact">
              {principal
                ? <PrincipalAvatar principal={principal} size="sm" />
                : <><Cpu size={16} /><span>{agentName}</span></>}
            </div>
          );
        })()}

        {/* Assignee, shown only when it ISN'T you. Historical rows carry none
            by design, and a chip repeating your own name on every card is
            noise — what earns space on a dense card is work belonging to
            someone else. */}
        {task.ownerPrincipalId
          && task.ownerPrincipalId !== viewerPrincipalId
          && principalsById?.get(task.ownerPrincipalId) && (
          <div className="task-card-owner">
            <PrincipalAvatar principal={principalsById.get(task.ownerPrincipalId)} size="sm" />
          </div>
        )}

        {/* Card Footer: Priority + Deadline + Thinking (moved to bottom) */}
        <div className="task-card-footer">
          <span
            className={`task-card-priority-compact ${getPriorityClass()}`}
            role="img"
            aria-label={priorityLabel}
            title={priorityLabel}
          >
            {task.priority.charAt(0).toUpperCase()}
          </span>

          {/* The deadline, said as a distance (card 7d38a6e0). Urgency is
              carried by the WORDS — "Overdue by 3 d" reads as overdue with no
              colour at all — and the tone token only reinforces it, because a
              state a reader has to see in a hue is a state some readers never
              see. The exact instant rides along for a screen reader and as the
              hover title, so the card never makes a deadline unreadable by
              abbreviating it. */}
          {task.dueAt && (
            <span
              className={`task-card-due task-card-due--${dueTone(task.dueAt)}`}
              title={`Due ${formatDateTimeLong(task.dueAt)}`}
            >
              <CalendarClock size={16} aria-hidden="true" />
              {formatRelativeDue(task.dueAt)}
              <span className="sr-only">{`, due ${formatDateTimeLong(task.dueAt)}`}</span>
            </span>
          )}
          
          {task.thinking && (
            <div className={`task-card-thinking thinking-${task.thinking}`}>
              <Brain size={16} />
              <span>{task.thinking === 'low' ? 'Low' : task.thinking === 'medium' ? 'Med' : 'High'}</span>
              {task.thinkingAutoEstimated && <span className="task-card-thinking-auto"title="Auto-estimated"></span>}
              {(task.attemptCount ?? 0) > 0 && (
                <span className="task-card-attempt"title={`Attempt #${task.attemptCount}`}>{task.attemptCount}</span>
              )}
            </div>
          )}
        </div>
      </article>
    </>
  );
};
