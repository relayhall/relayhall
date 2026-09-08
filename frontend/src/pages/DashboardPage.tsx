import React, { useState, useEffect } from 'react';
import { HeroCard } from '../components/dashboard/HeroCard';
import { StatsCard } from '../components/dashboard/StatsCard';
import { ActiveWorkPreview } from '../components/dashboard/ActiveWorkPreview';
import { ActivityFeed } from '../components/dashboard/ActivityFeed';
import { ProjectOverview } from '../components/dashboard/ProjectOverview';
import { SystemStatus } from '../components/dashboard/SystemStatus';
import { ReportsCard } from '../components/dashboard/ReportsCard';
import { NotificationsCard } from '../components/dashboard/NotificationsCard';
import { ConnectAgentCard } from '../components/dashboard/ConnectAgentCard';
import { Task } from '../types/task';
import { authenticatedFetch } from '../utils/auth';
import './DashboardPage.css';
import { AlertTriangle, Archive, CheckCircle2, Eye, Lightbulb, PenLine, RefreshCw } from 'lucide-react';
import { isIntentionalAbort } from '../utils/fetchAbort';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface DashboardSummary {
  ideas: number;
  todo: number;
  inProgress: number;
  review: number;
  stuck: number;
  completed: number;
  archived: number;
  recentCompleted: number;
}

export const DashboardPage: React.FC = () => {
  const [summary, setSummary] = useState<DashboardSummary>({
    ideas: 0,
    todo: 0,
    inProgress: 0,
    review: 0,
    stuck: 0,
    completed: 0,
    archived: 0,
    recentCompleted: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSummary();
    const interval = setInterval(fetchSummary, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchSummary = async () => {
    // Try the new summary endpoint first
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/dashboard/summary`);
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.summary) {
          setSummary({
            ideas: data.summary.ideas || 0,
            todo: data.summary.todo || 0,
            inProgress: data.summary.inProgress || 0,
            review: data.summary.review || 0,
            stuck: data.summary.stuck || 0,
            completed: data.summary.completed || 0,
            archived: data.summary.archived || 0,
            recentCompleted: data.summary.recentCompleted || 0,
          });
          setError(null);
          setLoading(false);
          return;
        }
      }
    } catch {
      // Fall through to tasks endpoint
    }

    // Fallback: compute from /api/tasks
    try {
      const [response, archivedResponse] = await Promise.all([
        authenticatedFetch(`${API_BASE_URL}/tasks`),
        authenticatedFetch(`${API_BASE_URL}/tasks?status=archived`),
      ]);
      if (!response.ok || !archivedResponse.ok) {
        throw new Error(`HTTP ${response.ok ? archivedResponse.status : response.status}`);
      }
      const [data, archivedData] = await Promise.all([response.json(), archivedResponse.json()]);
      if (data.success && archivedData.success) {
        const tasks: Task[] = data.tasks;
        const archivedTasks: Task[] = archivedData.tasks;
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const ideas = tasks.filter(t => t.status === 'ideas').length;
        const todo = tasks.filter(t => t.status === 'todo').length;
        const inProgress = tasks.filter(t => t.status === 'in-progress').length;
        const review = tasks.filter(t => t.status === 'review').length;
        const stuck = tasks.filter(t => t.status === 'stuck').length;
        const completed = tasks.filter(t => t.status === 'completed').length;
        const archived = archivedTasks.length;
        const recentCompleted = [...tasks, ...archivedTasks].filter(
          t => (t.status === 'completed' || t.status === 'archived') &&
               t.completedAt && new Date(t.completedAt) >= weekAgo
        ).length;

        setSummary({ ideas, todo, inProgress, review, stuck, completed, archived, recentCompleted });
        setError(null);
      }
    } catch (err) {
      if (!isIntentionalAbort(err)) console.error('Failed to fetch tasks:', err);
      setError('Failed to load dashboard data.');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" aria-label="Loading dashboard" />
        <p>Loading dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-page">
        <div className="dashboard-error dashboard-page-dashboard-error" role="alert">
          <span className="dashboard-page-error-icon"><AlertTriangle size={16} aria-hidden="true" /></span>
          <p>{error}</p>
          <button onClick={fetchSummary} className="retry-button dashboard-page-retry-button">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page fade-in">
      {/* Hero Section */}
      <HeroCard />

      <ConnectAgentCard />

      {/* Lifecycle summary: Review and Stuck are intentionally distinct. */}
      <div className="dashboard-page-dashboard-stats-grid">
        <StatsCard
          icon={Lightbulb}
          label="Ideas"
          value={summary.ideas}
          description="things to explore"
          color="purple"
          to="/tasks?focus=ideas"
        />

        <StatsCard
          icon={PenLine}
          label="Todo"
          value={summary.todo}
          description="ready to start"
          color="blue"
          to="/tasks?focus=todo"
        />

        <StatsCard
          icon={RefreshCw}
          label="Progress"
          value={summary.inProgress}
          description="actively working"
          color="orange"
          pulse={summary.inProgress > 0}
          to="/tasks?focus=in-progress"
        />

        <StatsCard
          icon={Eye}
          label="Review"
          value={summary.review}
          description="awaiting verification"
          color="yellow"
          pulse={summary.review > 0}
          to="/tasks?focus=review"
        />

        <StatsCard
          icon={AlertTriangle}
          label="Stuck"
          value={summary.stuck}
          description="needs attention"
          color={summary.stuck > 0 ? 'red' : 'gray'}
          pulse={summary.stuck > 0}
          to="/tasks?focus=stuck"
        />

        <StatsCard
          icon={CheckCircle2}
          label="Completed"
          value={summary.completed}
          description={summary.recentCompleted > 0 ? `${summary.recentCompleted} recent` : 'all time'}
          color="green"
          to="/tasks?focus=completed"
        />

        <StatsCard
          icon={Archive}
          label="Archived"
          value={summary.archived}
          description="filed away"
          color="gray"
          to="/tasks?focus=archived"
        />
      </div>

      {/* Notifications - the §2.12 human notification surface */}
      <NotificationsCard />

      {/* Reports - Recent reports preview */}
      <ReportsCard />

      {/* Currently Working On - All in-progress tasks */}
      <ActiveWorkPreview />

      {/* Activity Feed - full width */}
      <ActivityFeed />

      {/* Projects overview */}
      <div className="dashboard-widget-grid">
        <ProjectOverview />
      </div>

      {/* System Status (live) */}
      <SystemStatus />
    </div>
  );
};
