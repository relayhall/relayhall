import React, { useState, useRef, useEffect } from 'react';
import { Subtask, SubtaskStatus, SubtaskTransitionDetails } from '../../types/task';
import { AlertCircle, Check, CheckCircle2, ChevronDown, ChevronUp, Circle, Clock, Loader2, Pencil, RefreshCw, SkipForward, Square } from 'lucide-react';
import { SubtaskStatusSelect } from './SubtaskStatusSelect';
import { IconButton } from '../ui/IconButton';
import './SubtaskList.css';

interface SubtaskListProps {
  subtasks: Subtask[];
  onStatusChange?: (subtaskId: string, status: SubtaskStatus, details?: SubtaskTransitionDetails) => Promise<void> | void;
  onEditText?: (subtaskId: string, newText: string) => void;
  onReorder?: (subtaskId: string, direction: 'up' | 'down') => void;
  compact?: boolean;
  readOnly?: boolean;
}

// Helper to get effective status (handles legacy field and old status names)
const getSubtaskStatus = (subtask: Subtask): SubtaskStatus => {
  let status = subtask.status;
  // Legacy fallback
  if (!status) {
    return subtask.completed ? 'completed' : 'empty';
  }
  // Normalize old status names
  if (status === 'empty' as any) return 'empty';
  if (status === 'in_review' as any) return 'review';
  return status;
};

// Statuses that count as "done"

export const SubtaskList: React.FC<SubtaskListProps> = ({ 
  subtasks, 
  onStatusChange,
  onEditText,
  onReorder,
  compact = false,
  readOnly = false
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [transitionError, setTransitionError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  if (!subtasks || subtasks.length === 0) return null;

  // Phase 4: Count by status (6-state)
  const statusCounts = subtasks.reduce((acc, s) => {
    const status = getSubtaskStatus(s);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {} as Record<SubtaskStatus, number>);
  
  const completed = statusCounts.completed || 0;
  const skipped = statusCounts.skipped || 0;
  const review = statusCounts.review || 0;
  const inProgress = statusCounts['in-progress'] || 0;
  const stuck = statusCounts.stuck || 0;
  const empty = statusCounts.empty || 0;
  const total = subtasks.length;
  const done = completed + skipped;
  // Progress bar widths calculated from done/review/inProgress/stuck/total

  const handleStartEdit = (subtask: Subtask) => {
    if (readOnly || !onEditText) return;
    setEditingId(subtask.id);
    setEditText(subtask.text);
  };

  const handleSaveEdit = () => {
    if (editingId && editText.trim() && onEditText) {
      onEditText(editingId, editText.trim());
    }
    setEditingId(null);
    setEditText('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const canMoveUp = (index: number) => index > 0;
  const canMoveDown = (index: number) => index < subtasks.length - 1;

  const handleStatusChange = async (subtask: Subtask, currentStatus: SubtaskStatus, nextStatus: SubtaskStatus) => {
    if (!onStatusChange || !subtask.id || transitioningId) return;

    const details: SubtaskTransitionDetails = {};
    if (nextStatus === 'review') {
      const note = window.prompt('Review handoff note (optional):', subtask.reviewNote || '');
      if (note === null) return;
      if (note.trim()) details.reviewNote = note.trim();
    }
    if (nextStatus === 'stuck') {
      const reason = window.prompt('Why is this subtask stuck?', subtask.blockedReason || '');
      if (reason === null) return;
      if (!reason.trim()) {
        setTransitionError('A stuck reason is required.');
        return;
      }
      details.blockedReason = reason.trim();
    }
    if (currentStatus === 'review' && nextStatus === 'empty') {
      const note = window.prompt('Why is this subtask being rejected?', subtask.reviewNote || '');
      if (note === null) return;
      if (!note.trim()) {
        setTransitionError('A rejection note is required.');
        return;
      }
      details.reviewNote = note.trim();
    }

    setTransitionError('');
    setTransitioningId(subtask.id);
    try {
      await onStatusChange(subtask.id, nextStatus, details);
    } catch (error) {
      setTransitionError(error instanceof Error ? error.message : 'The lifecycle transition was rejected.');
    } finally {
      setTransitioningId(null);
    }
  };

  // Get status display info (6-state)
  const getStatusInfo = (status: SubtaskStatus) => {
    switch (status) {
      case 'completed':
        return { icon: <Check size={16} />, className: 'subtask-status-completed', tooltip: 'Completed' };
      case 'skipped':
        return { icon: <SkipForward size={16} />, className: 'subtask-status-skipped', tooltip: 'Skipped' };
      case 'review':
        return { icon: <Clock size={16} />, className: 'subtask-status-review', tooltip: 'To be reviewed' };
      case 'in-progress':
        return { icon: <Loader2 size={16} />, className: 'subtask-status-in-progress', tooltip: 'In Progress' };
      case 'stuck':
        return { icon: <AlertCircle size={16} />, className: 'subtask-status-blocked', tooltip: 'Stuck' };
      case 'empty':
      default:
        return { icon: null, className: 'subtask-status-empty', tooltip: 'Not started' };
    }
  };

  return (
    <div className={`subtask-list ${compact ? 'subtask-list-compact' : ''} ${stuck > 0 ? 'has-blocked' : ''}`}>
      {/* Progress summary */}
      <div className="subtask-progress">
        <div className="subtask-progress-bar">
          {/* Completed segment (green) */}
          <div
            className="subtask-progress-fill subtask-progress-completed"
            style={{ width: `${(completed / total) * 100}%` }}
          />
          {/* Skipped segment (gray) */}
          <div
            className="subtask-progress-fill subtask-progress-skipped"
            style={{ width: `${(skipped / total) * 100}%`, left: `${(completed / total) * 100}%` }}
          />
          {/* Review segment (yellow) */}
          <div
            className="subtask-progress-fill subtask-progress-review"
            style={{ width: `${(review / total) * 100}%`, left: `${((completed + skipped) / total) * 100}%` }}
          />
          {/* In-progress segment (blue) */}
          <div
            className="subtask-progress-fill subtask-progress-in-progress"
            style={{ width: `${(inProgress / total) * 100}%`, left: `${((completed + skipped + review) / total) * 100}%` }}
          />
          {/* Stuck segment (red) */}
          <div
            className="subtask-progress-fill subtask-progress-blocked"
            style={{ width: `${(stuck / total) * 100}%`, left: `${((completed + skipped + review + inProgress) / total) * 100}%` }}
          />
        </div>
        <span className="subtask-progress-text">
          {compact ? (
            `${done}/${total}`
          ) : (
            <>
              {completed > 0 && <span className="progress-completed"><CheckCircle2 size={16} aria-hidden="true" />{completed}</span>}
              {skipped > 0 && <span className="progress-skipped"><SkipForward size={16} aria-hidden="true" />{skipped}</span>}
              {review > 0 && <span className="progress-review"><Circle size={16} aria-hidden="true" />{review}</span>}
              {inProgress > 0 && <span className="progress-in-progress"><RefreshCw size={16} aria-hidden="true" />{inProgress}</span>}
              {stuck > 0 && <span className="progress-blocked"><AlertCircle size={16} aria-hidden="true" />{stuck}</span>}
              {empty > 0 && <span className="progress-empty"><Square size={16} aria-hidden="true" />{empty}</span>}
            </>
          )}
        </span>
      </div>

      {transitionError && (
        <div className="subtask-transition-error" role="alert">
          {transitionError}
        </div>
      )}

      {/* Explicit lifecycle controls; no checkbox/status cycling. */}
      <ul className="subtask-items">
        {subtasks.map((subtask, index) => {
          const status = getSubtaskStatus(subtask);
          const statusInfo = getStatusInfo(status);
          
          return (
          <li
            key={subtask.id || `subtask-${index}`}
            className={`subtask-item ${statusInfo.className} ${editingId === subtask.id ? 'subtask-editing' : ''}`}
          >
            {!readOnly && onStatusChange ? (
              <SubtaskStatusSelect
                value={status}
                subtaskText={subtask.text}
                className="subtask-list-status"
                disabled={transitioningId === subtask.id}
                onChange={(nextStatus) => void handleStatusChange(subtask, status, nextStatus)}
              />
            ) : (
              <span
                className={`subtask-status-indicator ${statusInfo.className}`}
                aria-label={`${statusInfo.tooltip}: ${subtask.text}`}
                title={statusInfo.tooltip}
              >
                {statusInfo.icon}
              </span>
            )}
            
            {editingId === subtask.id ? (
              <input
                ref={inputRef}
                type="text"
                className="subtask-edit-input"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSaveEdit}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span 
                className={`subtask-text ${!readOnly && onEditText ? 'subtask-text-editable' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleStartEdit(subtask);
                }}
                title={!readOnly && onEditText ? 'Click to edit' : undefined}
              >
                {subtask.text}
              </span>
            )}

            {(subtask.reviewNote || subtask.blockedReason || status === 'skipped') && (
              <div className="subtask-lifecycle-context">
                {subtask.reviewNote && (
                  <div className="subtask-review-note" role="note">
                    <strong>Review note:</strong> {subtask.reviewNote}
                  </div>
                )}
                {subtask.blockedReason && (
                  <div className="subtask-blocked-reason" role="note">
                    <strong>Stuck reason:</strong> {subtask.blockedReason}
                  </div>
                )}
                {status === 'skipped' && (
                  <div className="subtask-skipped-note" role="note">Skipped intentionally.</div>
                )}
              </div>
            )}

            {/* Action buttons (only show when not editing and not compact/readonly) */}
            {!compact && !readOnly && editingId !== subtask.id && (
              <div className="subtask-actions">
                {onEditText && (
                  <IconButton
                    className="subtask-action-btn subtask-edit-btn"
                    variant="ghost"
                    ariaLabel="Edit subtask"
                    title="Edit"
                    icon={<Pencil size={16} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartEdit(subtask);
                    }}
                  />
                )}
                {onReorder && (
                  <>
                    <IconButton
                      className="subtask-action-btn subtask-move-btn"
                      variant="ghost"
                      ariaLabel="Move up"
                      title="Move up"
                      icon={<ChevronUp size={16} />}
                      disabled={!canMoveUp(index)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (subtask.id && canMoveUp(index)) {
                          onReorder(subtask.id, 'up');
                        }
                      }}
                    />
                    <IconButton
                      className="subtask-action-btn subtask-move-btn"
                      variant="ghost"
                      ariaLabel="Move down"
                      title="Move down"
                      icon={<ChevronDown size={16} />}
                      disabled={!canMoveDown(index)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (subtask.id && canMoveDown(index)) {
                          onReorder(subtask.id, 'down');
                        }
                      }}
                    />
                  </>
                )}
              </div>
            )}
          </li>
        )})}
      </ul>
    </div>
  );
};
