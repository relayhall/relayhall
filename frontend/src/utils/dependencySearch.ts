import { Task } from '../types/task';

export interface DependencySearchResult {
  task: Task;
  score: number;
}

const normalize = (value: string): string => value.trim().toLowerCase();
const normalizeId = (value: string): string => normalize(value).replace(/-/g, '');

export function scoreDependencyMatch(task: Task, rawQuery: string): number {
  const query = normalize(rawQuery);
  const queryId = normalizeId(rawQuery);
  if (!query) return 0;

  const title = normalize(task.title);
  const project = normalize(task.project || '');
  const fullId = normalize(task.id);
  const compactId = normalizeId(task.id);
  const shortId = compactId.slice(0, 8);

  if (compactId === queryId || fullId === query) return 100;
  if (shortId === queryId) return 95;
  if (title === query) return 90;
  if (title.startsWith(query)) return 80;
  if (title.includes(query)) return 70;
  if (shortId.startsWith(queryId) || compactId.startsWith(queryId)) return 65;
  if (fullId.includes(query) || compactId.includes(queryId)) return 60;
  if (project.startsWith(query)) return 50;
  if (project.includes(query)) return 40;

  return 0;
}

export function filterDependencyTasks(tasks: Task[], rawQuery: string, selectedIds: string[], currentTaskId?: string, limit = 10): Task[] {
  const blocked = new Set(selectedIds);
  const query = normalize(rawQuery);

  return tasks
    .filter(task => task.id !== currentTaskId && task.status !== 'archived' && !blocked.has(task.id))
    .filter(task => !query || scoreDependencyMatch(task, query) > 0)
    .map(task => ({ task, score: scoreDependencyMatch(task, rawQuery) }))
    .sort((a, b) => {
      if (!query) {
        return new Date(b.task.updated).getTime() - new Date(a.task.updated).getTime();
      }

      return b.score - a.score || a.task.title.localeCompare(b.task.title);
    })
    .slice(0, limit)
    .map(result => result.task);
}
