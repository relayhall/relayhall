import { authenticatedFetch } from '../../utils/auth';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
import type { MapEdge, MapPhase, MapReport, MapTaskNode } from './mapGraphModel';

/** The filter scope the Map shares with the board (design 986be411 §3). */
export interface MapGraphQuery {
  q?: string;
  priorities?: string[];
  tags?: string[];
  projects?: string[];
  phases?: string[];
  statuses?: string[];
  includeArchived?: boolean;
  mine?: boolean;
  owner?: string;
  unassigned?: boolean;
}

export interface MapGraphResponse {
  nodes: MapTaskNode[];
  edges: MapEdge[];
  /** Phase identity for the band chips (card 8645e81c). */
  phases: MapPhase[];
  /** Reports linked to tasks in scope (§3 report pills). */
  reports: MapReport[];
  generatedAt: string;
  fullCount: number;
  /**
   * Progress for tasks whose SUBTASKS moved without their task row moving —
   * DELTA reads only, and only the tasks that actually changed. Agent does not
   * appear here: it is a column on tasks, so a pickup rotates updated_at and
   * rides on its own node.
   */
  taxonomy?: MapTaxonomyRow[];
}

export interface MapTaxonomyRow {
  id: string;
  progress: { done: number; total: number } | null;
}

const graphParams = (query: MapGraphQuery): URLSearchParams => {
  const params = new URLSearchParams();
  // Design 77950a97 §5 AMENDMENT: the Map reads the task summary row at
  // EVERY zoom. The lod=project aggregate read has retired from this path,
  // so no zoom level changes what is fetched — only what is drawn.
  params.set('lod', 'task');
  if (query.q) params.set('q', query.q);
  if (query.priorities?.length) params.set('priorities', query.priorities.join(','));
  if (query.tags?.length) params.set('tags', query.tags.join(','));
  if (query.projects?.length) params.set('projects', query.projects.join(','));
  if (query.phases?.length) params.set('phaseIds', query.phases.join(','));
  if (query.statuses?.length) params.set('statuses', query.statuses.join(','));
  else if (query.includeArchived) {
    // includeArchived removes the archive exclusion, but the endpoint's default
    // status list still omits archived. Request the full scope explicitly.
    params.set('statuses', 'ideas,todo,in-progress,review,stuck,completed,archived');
  }
  params.set('includeArchived', query.includeArchived ? 'true' : 'false');
  if (query.mine) params.set('mine', 'true');
  if (query.owner) params.set('owner', query.owner);
  if (query.unassigned) params.set('unassigned', 'true');
  return params;
};

/**
 * The Map's bulk read. `updatedSince` MUST be an exact `generatedAt` the
 * server previously emitted — the route validates that encoding strictly and
 * 400s anything else, so it is never synthesized locally.
 */
export async function fetchMapGraph(
  query: MapGraphQuery,
  updatedSince?: string,
): Promise<MapGraphResponse> {
  const params = graphParams(query);
  if (updatedSince) params.set('updatedSince', updatedSince);
  const response = await authenticatedFetch(`${API_BASE_URL}/tasks/graph?${params.toString()}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || 'The Task graph could not be read.');
  }
  // Shapes are read defensively against the RECORDED response, never assumed.
  return {
    nodes: Array.isArray(data.nodes) ? data.nodes : [],
    edges: Array.isArray(data.edges) ? data.edges : [],
    phases: Array.isArray(data.phases) ? data.phases : [],
    reports: Array.isArray(data.reports) ? data.reports : [],
    generatedAt: String(data.generatedAt ?? ''),
    fullCount: Number(data.fullCount ?? 0),
    ...(Array.isArray(data.taxonomy) ? { taxonomy: data.taxonomy } : {}),
  };
}
