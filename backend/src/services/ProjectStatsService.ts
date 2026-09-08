// ProjectStatsService.ts - Calculate project statistics from the task database
//
// ── CARD 72258a60, THE CENSUS ARM ───────────────────────────────────────────
//
// Every method here counts Tasks, and none of them used to ask who was
// counting: `GET /projects?includeStats=true`, `GET /projects/{id}/stats` and
// `GET /projects/stats/distribution` reported totals, per-status counts and
// recent-activity counts over the whole estate to any caller with
// `projects:read`. It is the same disclosure the dashboard summary was
// reported for — a count over rows the caller may not read — on three more
// surfaces, and `stats/distribution` did it without even the Project ceiling,
// naming every Project and how much work sits in it.
//
// The narrowing is a REQUIRED first parameter rather than something each
// method remembers to do: these count in JS over rows already fetched, so the
// row-form narrowing is honest here (nothing is paginated and no total is
// computed in SQL), and a caller that forgets it fails to compile.
import { taskManagerDB as taskManager } from './TaskManagerDB';
import { projectService } from './ProjectService';
import type { AuthorizedTaskNarrowing } from '../middleware/sharedAuthorization';

export interface ProjectStats {
  total_tasks: number;
  completed_tasks: number;
  in_progress_tasks: number;
  active_agents: number;
  last_activity: string | null;
}

export class ProjectStatsService {
  async getStatsByName(visible: AuthorizedTaskNarrowing, projectName: string): Promise<ProjectStats> {
    const tasks = await visible(
      await taskManager.queryTasks({ project: projectName }),
      (task) => task.id,
    );

    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const inProgress = tasks.filter(t => t.status === 'in-progress').length;
    const activeAgents = new Set(
      tasks.filter(t => t.activeAgent).map(t => t.activeAgent!.name)
    ).size;

    let lastActivity: string | null = null;
    for (const t of tasks) {
      const ts = t.completedAt || t.startedAt || t.lastChecked || t.created;
      if (ts && (!lastActivity || ts > lastActivity)) {
        lastActivity = ts;
      }
    }

    return {
      total_tasks: total,
      completed_tasks: completed,
      in_progress_tasks: inProgress,
      active_agents: activeAgents,
      last_activity: lastActivity,
    };
  }

  async getAllStats(visible: AuthorizedTaskNarrowing): Promise<Map<string, ProjectStats>> {
    const projects = await projectService.list();
    const statsMap = new Map<string, ProjectStats>();

    for (const project of projects) {
      statsMap.set(project.id, await this.getStatsByName(visible, project.name));
    }

    return statsMap;
  }

  async getRecentActivity(visible: AuthorizedTaskNarrowing, projectName: string, days: number = 7): Promise<{
    tasks_created: number;
    tasks_updated: number;
    tasks_completed: number;
  }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString();

    const tasks = await visible(
      await taskManager.queryTasks({ project: projectName }),
      (task) => task.id,
    );

    return {
      tasks_created: tasks.filter(t => t.created && t.created >= cutoffStr).length,
      tasks_updated: tasks.filter(t => t.lastChecked && t.lastChecked >= cutoffStr).length,
      tasks_completed: tasks.filter(t => t.status === 'completed' && t.completedAt && t.completedAt >= cutoffStr).length,
    };
  }

  async getTaskDistribution(visible: AuthorizedTaskNarrowing): Promise<Array<{ project_name: string; task_count: number }>> {
    const allTasks = await visible(await taskManager.getAllTasks(), (task) => task.id);
    const dist: Record<string, number> = {};
    for (const t of allTasks) {
      const name = t.project || '(unassigned)';
      dist[name] = (dist[name] || 0) + 1;
    }
    return Object.entries(dist)
      .map(([project_name, task_count]) => ({ project_name, task_count }))
      .sort((a, b) => b.task_count - a.task_count);
  }
}

export const projectStatsService = new ProjectStatsService();
