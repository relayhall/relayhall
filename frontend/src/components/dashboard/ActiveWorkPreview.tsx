import { authenticatedFetch } from '../../utils/auth';
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight, Circle, Clock, RefreshCw, RotateCw } from 'lucide-react';
import { Task, Subtask } from '../../types/task';
import './ActiveWorkPreview.css';
import { isIntentionalAbort } from '../../utils/fetchAbort';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const timeAgo = (dateStr: string): string => {
  const updated = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - updated.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return 'Just now';
};

// This chip is TINTED (--bg-elevated), not filled like the board's priority
// square, so its ink comes from the text tier of each status hue rather than
// from the raw palette scale. The palette scale does not vary by Theme, which
// is why relay-light measured 2.76:1 here (walkthrough item R7).
const getPriorityColor = (priority: string): string => {
  switch (priority) {
    case 'urgent': return 'var(--text-error)';
    case 'high': return 'var(--text-warning)';
    case 'normal': return 'var(--text-info)';
    case 'low': return 'var(--text-tertiary)';
    default: return 'var(--text-info)';
  }
};

const getSubtaskProgress = (subtasks: Subtask[]): { completed: number; total: number } => {
  if (!subtasks || subtasks.length === 0) return { completed: 0, total: 0 };
  const completed = subtasks.filter(s => s.status === 'completed' || s.completed).length;
  return { completed, total: subtasks.length };
};

export const ActiveWorkPreview: React.FC = () => {
  const [inProgressTasks, setInProgressTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchInProgressTasks();
    const interval = setInterval(fetchInProgressTasks, 15000);
    return () => clearInterval(interval);
  }, []);

  const fetchInProgressTasks = async () => {
    try {
      // Try new endpoint first
      let response = await authenticatedFetch(`${API_BASE_URL}/dashboard/active`);
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.tasks) {
          setInProgressTasks(data.tasks);
          setLoading(false);
          return;
        }
      }
    } catch {
      // Fall through to fallback
    }

    try {
      // Fallback: fetch all tasks and filter
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks`);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          const active = data.tasks.filter((t: Task) => t.status === 'in-progress');
          setInProgressTasks(active);
        }
      }
    } catch (err) {
      if (!isIntentionalAbort(err)) console.error('Failed to fetch in-progress tasks:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="active-work-preview">
        <div className="active-work-preview-header">
          <h2 className="active-work-preview-title"><RefreshCw size={16} aria-hidden="true" /> Currently working on</h2>
        </div>
        <div className="active-work-preview-loading">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (inProgressTasks.length === 0) {
    return (
      <div className="active-work-preview active-work-preview-idle">
        <div className="active-work-preview-header">
          <h2 className="active-work-preview-title"><RefreshCw size={16} aria-hidden="true" /> Currently working on</h2>
        </div>

        <div className="active-work-preview-empty">
          <p className="active-work-preview-empty-text">All caught up!</p>
          <p className="active-work-preview-empty-hint">Nothing in progress right now</p>
        </div>

        <Link to="/tasks" className="active-work-preview-cta">
          View all Tasks
          <ChevronRight size={16} />
        </Link>
      </div>
    );
  }

  return (
    <div className="active-work-preview active-work-preview-active">
      <div className="active-work-preview-gradient" />

      <div className="active-work-preview-header">
        <h2 className="active-work-preview-title">
          <RefreshCw size={16} aria-hidden="true" /> Currently working on ({inProgressTasks.length})
        </h2>
      </div>

      <div className="active-work-preview-content">
        <div className="active-work-task-list">
          {inProgressTasks.map(task => {
            const progress = getSubtaskProgress(task.subtasks);
            const progressPct = progress.total > 0
              ? Math.round((progress.completed / progress.total) * 100)
              : 0;

            return (
              <div key={task.id} className="active-work-task-item">
                <div className="active-work-task-item-header">
                  <h3 className="active-work-task-item-title">{task.title}</h3>
                  <span
                    className="active-work-preview-priority"
                    style={{ color: getPriorityColor(task.priority) }}
                  >
                    {task.priority}
                  </span>
                </div>

                <div className="active-work-task-item-meta">
                  {task.project && (
                    <span className="active-work-project-badge">{task.project}</span>
                  )}

                  {progress.total > 0 && (
                    <div className="active-work-subtask-progress">
                      <div className="active-work-progress-bar">
                        <div
                          className="active-work-progress-fill"
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                      <span className="active-work-progress-text">
                        {progress.completed}/{progress.total}
                      </span>
                    </div>
                  )}

                  <span className="active-work-preview-meta-item">
                    <Clock size={16} />
                    {timeAgo(task.updated)}
                  </span>
                </div>

                {task.subtasks && task.subtasks.length > 0 && (
                  <div className="active-work-subtask-list">
                    {task.subtasks.slice(0, 4).map((st, idx) => (
                      <div key={idx} className="active-work-subtask-item">
                        {st.status === 'completed' || st.completed ? (
                          <CheckCircle2 size={16} className="subtask-icon-done" />
                        ) : st.status === 'review' ? (
                          <RotateCw size={16} className="subtask-icon-review" />
                        ) : (
                          <Circle size={16} className="subtask-icon-new" />
                        )}
                        <span className={st.status === 'completed' || st.completed ? 'subtask-text-done' : ''}>
                          {st.text}
                        </span>
                      </div>
                    ))}
                    {task.subtasks.length > 4 && (
                      <span className="active-work-subtask-more">
                        +{task.subtasks.length - 4} more
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Link to="/tasks" className="active-work-preview-cta">
        View all Tasks
        <ChevronRight size={16} />
      </Link>
    </div>
  );
};
