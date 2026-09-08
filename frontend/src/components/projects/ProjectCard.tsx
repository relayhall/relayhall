import React from 'react';
import { Project } from '../../types/project';
import { Bot, Clock, Eye, ListTodo } from 'lucide-react';
import './ProjectCard.css';

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
  onViewTasks?: (projectName: string) => void;
}

export const ProjectCard: React.FC<ProjectCardProps> = ({ project, onClick, onViewTasks }) => {
  const stats = project.stats;

  // Get time ago for last activity
  const getTimeAgo = (dateString: string | null): string => {
    if (!dateString) return 'No activity';

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;

    const diffMonths = Math.floor(diffDays / 30);
    return `${diffMonths}mo ago`;
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'active': return 'status-active';
      case 'archived': return 'status-archived';
      default: return 'status-active';
    }
  };

  return (
    <div className="project-card" onClick={onClick}>
      {/* Header: Name + Status Badge (+ lock icon for hidden projects) */}
      <div className="project-card-header">
        <h2 className="project-card-name">
          {project.is_hidden && <span className="project-card-lock"title="Secret project"></span>}
          {project.name}
        </h2>
        <span className={`project-card-status ${getStatusColor(project.status)}`}>
          {project.status}
        </span>
      </div>

      {/* Description — truncated to 2 lines */}
      {project.description && (
        <p className="project-card-description">{project.description}</p>
      )}

      {/* Compact inline stats row */}
      {stats && (
        <div className="project-card-stats-inline">
          <span className="stat-pill project-card-stat-total">{stats.total_tasks} total</span>
          {stats.in_progress_tasks > 0 && (
            <>
              <span className="stat-sep">·</span>
              <span className="stat-pill project-card-stat-progress">{stats.in_progress_tasks} in progress</span>
            </>
          )}
          {stats.completed_tasks > 0 && (
            <>
              <span className="stat-sep">·</span>
              <span className="stat-pill stat-done">{stats.completed_tasks} done</span>
            </>
          )}
          {stats.active_agents > 0 && (
            <>
              <span className="stat-sep">·</span>
              <span className="stat-pill project-card-stat-agents"><Bot size={16} aria-hidden="true" /> {stats.active_agents}</span>
            </>
          )}
        </div>
      )}

      {/* Quick Actions */}
      <div className="project-card-actions">
        <button
          className="project-card-action-btn"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title="View project details"
        >
          <Eye size={16} />
          <span>Details</span>
        </button>

        {stats && stats.total_tasks > 0 && (
          <button
            className="project-card-action-btn"
            onClick={(e) => {
              e.stopPropagation();
              onViewTasks?.(project.name);
            }}
            title="View tasks for this project"
          >
            <ListTodo size={16} />
            <span>Tasks ({stats.total_tasks})</span>
          </button>
        )}
      </div>

      {/* Last Activity */}
      <div className="project-card-footer">
        <Clock size={16} />
        <span className="project-card-last-activity">
          {getTimeAgo(stats?.last_activity || null)}
        </span>
      </div>
    </div>
  );
};
