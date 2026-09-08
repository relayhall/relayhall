import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Folder } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import { Task } from '../../types/task';
import './ProjectOverview.css';
import { isIntentionalAbort } from '../../utils/fetchAbort';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

// Projects hidden from the dashboard overview (sensitive/private)
const HIDDEN_PROJECTS = ['dream-job-switzerland'];

interface ProjectInfo {
  name: string;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  stuckTasks: number;
  completionPct: number;
}

export const ProjectOverview: React.FC = () => {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchProjectData();
  }, []);

  const fetchProjectData = async () => {
    try {
      // Fetch tasks and compute project stats client-side
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks`);
      if (!response.ok) return;
      const data = await response.json();
      if (!data.success) return;

      const tasks: Task[] = data.tasks;
      const projectMap = new Map<string, Task[]>();

      for (const task of tasks) {
        if (task.project) {
          const existing = projectMap.get(task.project) || [];
          existing.push(task);
          projectMap.set(task.project, existing);
        }
      }

      const projectInfos: ProjectInfo[] = [];
      for (const [name, ptasks] of projectMap) {
        if (HIDDEN_PROJECTS.includes(name)) continue;
        const completed = ptasks.filter(t => t.status === 'completed' || t.status === 'archived').length;
        const inProgress = ptasks.filter(t => t.status === 'in-progress').length;
        const stuck = ptasks.filter(t => t.status === 'stuck').length;
        const total = ptasks.length;
        const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;

        projectInfos.push({
          name,
          totalTasks: total,
          completedTasks: completed,
          inProgressTasks: inProgress,
          stuckTasks: stuck,
          completionPct,
        });
      }

      // Sort by most active (in-progress first, then most tasks)
      projectInfos.sort((a, b) => {
        if (b.inProgressTasks !== a.inProgressTasks) return b.inProgressTasks - a.inProgressTasks;
        return b.totalTasks - a.totalTasks;
      });

      setProjects(projectInfos.slice(0, 5));
    } catch (err) {
      if (!isIntentionalAbort(err)) console.error('Failed to fetch project data:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return null;
  if (projects.length === 0) return null;

  // --yellow-400 and --orange-400 are not defined in any Theme, so two thirds
  // of this ladder resolved to an invalid value and the bar simply lost its
  // fill colour. No gate saw it: check-design-tokens.py reads stylesheets, and
  // an inline style in a .tsx file is not one. src/inlineTokenTruth.test.ts is
  // the control for that blind spot.
  const getBarColor = (pct: number): string => {
    if (pct >= 60) return 'var(--status-success)';
    if (pct >= 30) return 'var(--status-warning)';
    return 'var(--status-danger)';
  };

  return (
    <div className="project-overview">
      <div className="project-overview-header">
        <h2><Folder size={16} aria-hidden="true" /> Active Projects</h2>
      </div>

      <div className="project-overview-list">
        {projects.map(project => (
          <div key={project.name} className="project-overview-item">
            <div className="project-overview-item-header">
              <span className="project-overview-name">{project.name}</span>
              <span className="project-overview-pct">{project.completionPct}%</span>
            </div>

            <div className="project-overview-bar">
              <div
                className="project-overview-bar-fill"
                style={{
                  width: `${project.completionPct}%`,
                  backgroundColor: getBarColor(project.completionPct),
                }}
              />
            </div>

            <div className="project-overview-stats">
              <span>{project.totalTasks} task{project.totalTasks === 1 ? '' : 's'}</span>
              {project.inProgressTasks > 0 && (
                <span className="project-stat-active">{project.inProgressTasks} active</span>
              )}
              {project.stuckTasks > 0 && (
                <span className="project-stat-stuck">{project.stuckTasks} stuck</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <Link to="/projects" className="project-overview-cta">
        View all Projects
        <ChevronRight size={16} />
      </Link>
    </div>
  );
};
