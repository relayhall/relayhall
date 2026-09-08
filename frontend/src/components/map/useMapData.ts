import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useWebSocket } from '../../hooks/useWebSocket';
import type { Task } from '../../types/task';
import { fetchMapGraph, type MapGraphQuery, type MapGraphResponse } from './mapGraphApi';
import type { MapGraph } from './mapGraphModel';

/**
 * The Map's data lifecycle (design 77950a97 §8): ONE read, WS patch-in-place,
 * and a debounced delta reconcile — kept apart from view state and from DOM
 * interaction so the three cannot interfere. Every late round of the
 * abandoned attempt was an interference bug BETWEEN interleaved lifecycles,
 * not a bug within one (diagnosis 7fa7e605 §C).
 */

/**
 * THE LOD TABLE — one pure function, no branching anywhere else.
 *
 * §5 AMENDMENT (design 77950a97): the summary row loads for the full filtered
 * scope at EVERY zoom, and tiles never unmount. Level of detail therefore
 * governs RENDERING ONLY; it has no say over fetching. That single decision
 * removes the entire class of defects the old tier matrix produced — the
 * tier-1 full fetch (review eac02957 B2), the aggregate/task race, and
 * gating on the wrong query (round-11 findings).
 */
export type DetailBand = 'far' | 'overview' | 'mid' | 'close';

export const DETAIL_THRESHOLDS = {
  /** below → far: status-tinted shapes, agent dots, edges. */
  overview: 0.34,
  /** ≥ → mid: + title */
  mid: 0.6,
  /** ≥ → close: + report pills, goal lines, agent names (§5) */
  close: 1.1,
} as const;

export function detailBandFor(scale: number): DetailBand {
  if (scale < DETAIL_THRESHOLDS.overview) return 'far';
  if (scale < DETAIL_THRESHOLDS.mid) return 'overview';
  if (scale < DETAIL_THRESHOLDS.close) return 'mid';
  return 'close';
}

/** What each band draws. A pure table so the contract is readable and testable. */
export const DETAIL_MATRIX: Readonly<Record<DetailBand, {
  title: boolean; meta: boolean; progress: boolean; reports: boolean; goalLine: boolean; agentName: boolean;
}>> = {
  far: { title: false, meta: false, progress: false, reports: false, goalLine: false, agentName: false },
  overview: { title: true, meta: false, progress: false, reports: false, goalLine: false, agentName: false },
  mid: { title: true, meta: true, progress: true, reports: false, goalLine: false, agentName: false },
  close: { title: true, meta: true, progress: true, reports: true, goalLine: true, agentName: true },
};

/**
 * The agent's NAME only. The WS payload carries the whole active-agent object
 * (session key, pid, log path); the map shows and stores nothing but the name,
 * matching what the server projects into the graph read.
 */
function agentNameOf(activeAgent: Task['activeAgent']): string | null {
  if (!activeAgent) return null;
  return typeof activeAgent === 'string' ? activeAgent : (activeAgent.name ?? null);
}

/** Subtask counts in the shape the tile bar consumes; null when there is nothing to show. */
function progressOf(subtasks: Task['subtasks']): { done: number; total: number } | null {
  const total = subtasks.length;
  if (total === 0) return null;
  return { done: subtasks.filter(subtask => subtask.status === 'completed').length, total };
}

const PULSE_MS = 1400;
const DELTA_DEBOUNCE_MS = 300;

export interface UseMapDataResult {
  graph: MapGraph;
  generatedAt: string | null;
  fullCount: number;
  isLoading: boolean;
  error: Error | null;
  /** Ids pulsing from a live change (§6: motion means something happened). */
  pulsed: ReadonlySet<string>;
  refetch: () => void;
}

export function useMapData(query: MapGraphQuery): UseMapDataResult {
  const queryClient = useQueryClient();
  const graphKey = useMemo(() => ['map-graph', JSON.stringify(query)] as const, [query]);

  const graphQuery = useQuery({
    queryKey: graphKey,
    queryFn: () => fetchMapGraph(query),
    staleTime: 15_000,
  });

  const [pulsed, setPulsed] = useState<ReadonlySet<string>>(() => new Set());
  const pulseTimers = useRef(new Map<string, number>());
  const pulse = useCallback((id: string) => {
    setPulsed(previous => new Set(previous).add(id));
    const existing = pulseTimers.current.get(id);
    if (existing !== undefined) window.clearTimeout(existing);
    pulseTimers.current.set(id, window.setTimeout(() => {
      pulseTimers.current.delete(id);
      setPulsed(previous => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }, PULSE_MS));
  }, []);
  useEffect(() => () => {
    pulseTimers.current.forEach(timer => window.clearTimeout(timer));
    pulseTimers.current.clear();
  }, []);

  // The sync anchor is a REF, read at fire time. Reading it from render state
  // is what let a stale value schedule a full refetch.
  // The anchor belongs to ONE scope: reusing scope A's generatedAt as the
  // delta anchor for scope B asks the server "what changed since then"
  // about a different question entirely.
  const lastSyncRef = useRef<string | null>(null);
  const anchorKeyRef = useRef<string>('');
  useEffect(() => {
    const key = JSON.stringify(query);
    if (anchorKeyRef.current !== key) {
      anchorKeyRef.current = key;
      lastSyncRef.current = null;
    }
  }, [query]);
  useEffect(() => {
    if (graphQuery.data?.generatedAt) lastSyncRef.current = graphQuery.data.generatedAt;
  }, [graphQuery.data]);

  const queryRef = useRef(query);
  queryRef.current = query;
  const graphKeyRef = useRef(graphKey);
  graphKeyRef.current = graphKey;

  const deltaTimerRef = useRef<number | null>(null);
  const scheduleDeltaReconcile = useCallback(() => {
    if (deltaTimerRef.current !== null) window.clearTimeout(deltaTimerRef.current);
    deltaTimerRef.current = window.setTimeout(async () => {
      deltaTimerRef.current = null;
      const since = lastSyncRef.current;
      const key = graphKeyRef.current;
      try {
        const delta = await fetchMapGraph(queryRef.current, since ?? undefined);
        const existing = queryClient.getQueryData<MapGraphResponse>(key);
        // A PARTIAL read may not define a scope it never saw whole. With no
        // cache to merge into, "everything changed since T" would install a
        // one-or-two-task map as the entire estate.
        if (!existing && since) {
          const whole = await fetchMapGraph(queryRef.current);
          queryClient.setQueryData<MapGraphResponse>(key, whole);
          lastSyncRef.current = whole.generatedAt;
          return;
        }
        let merged: MapGraphResponse | undefined;
        queryClient.setQueryData<MapGraphResponse>(key, previous => {
          if (!previous) { merged = delta; return delta; }
          const byId = new Map(previous.nodes.map(node => [node.id, node]));
          for (const node of delta.nodes) byId.set(node.id, node);
          // Progress for tasks whose subtasks moved without their row moving.
          // This is the only path by which a progress-only change reaches the
          // screen; an agent change rides on its own node, because active_agent
          // is a column on tasks and rotates updated_at.
          const taxonomyById = new Map((delta.taxonomy ?? []).map(row => [row.id, row]));
          const nodes = [...byId.values()].map(node => {
            const taxonomy = taxonomyById.get(node.id);
            return taxonomy ? { ...node, progress: taxonomy.progress } : node;
          });
          merged = {
            ...previous,
            nodes,
            // Edges, phases and reports arrive whole for the scope, so they
            // replace — a rename, a removed dependency or an unlinked Report
            // must not linger.
            edges: delta.edges,
            phases: delta.phases,
            reports: delta.reports,
            generatedAt: delta.generatedAt,
            fullCount: delta.fullCount,
          };
          return merged;
        });
        lastSyncRef.current = delta.generatedAt;
        // The route documents fullCount as the deletion signal: v1 emits no
        // tombstones, so a merged graph holding MORE nodes than the server
        // counts is carrying ghosts. Fall back to a whole read.
        if (merged && merged.nodes.length > delta.fullCount) {
          const whole = await fetchMapGraph(queryRef.current);
          queryClient.setQueryData<MapGraphResponse>(key, whole);
          lastSyncRef.current = whole.generatedAt;
        }
      } catch {
        // The next event retries; a failed reconcile must never blank the map.
      }
    }, DELTA_DEBOUNCE_MS);
  }, [queryClient]);
  useEffect(() => () => {
    if (deltaTimerRef.current !== null) window.clearTimeout(deltaTimerRef.current);
  }, []);

  const patchNode = useCallback((task: Task) => {
    let known = false;
    let mayHaveLeftScope = false;
    queryClient.setQueryData<MapGraphResponse>(graphKeyRef.current, previous => {
      if (!previous) return previous;
      const current = previous.nodes.find(node => node.id === task.id);
      known = Boolean(current);
      if (!current) return previous;
      // Membership is the SERVER's decision. A patch that changes a field
      // the filter selects on (project, phase, status, priority) may have
      // moved the task out of scope entirely — patching it in place would
      // render it in a lane the current filter excludes.
      mayHaveLeftScope =
        (task.project ?? null) !== current.project ||
        (task.phaseId ?? null) !== current.phaseId ||
        task.status !== current.status ||
        task.priority !== current.priority;
      return {
        ...previous,
        nodes: previous.nodes.map(node => node.id === task.id ? {
          ...node,
          title: task.title,
          status: task.status,
          priority: task.priority,
          project: task.project ?? null,
          phaseId: task.phaseId ?? null,
          updated: (task as { updated?: string }).updated ?? node.updated,
          // §3 liveness and progress patch in place too. An agent pickup is
          // an ordinary event on a task already in scope: it changes no
          // membership field, so it would otherwise schedule no reconcile and
          // the every-zoom badge would sit stale until something else moved.
          // A payload that OMITS the field must not clear it, so each is
          // applied only when the key is actually present.
          ...('activeAgent' in task ? { agent: agentNameOf(task.activeAgent) } : {}),
          ...(Array.isArray(task.subtasks) ? { progress: progressOf(task.subtasks) } : {}),
        } : node),
      };
    });
    if (known) {
      pulse(task.id);
      // A scope-relevant field moved: let the server re-decide membership.
      if (mayHaveLeftScope) scheduleDeltaReconcile();
    } else {
      // Unknown membership — created, or newly matching the filter. Only
      // the server can decide whether it belongs in scope.
      scheduleDeltaReconcile();
    }
  }, [queryClient, pulse, scheduleDeltaReconcile]);

  const removeNode = useCallback((taskId: string) => {
    queryClient.setQueryData<MapGraphResponse>(graphKeyRef.current, previous => previous ? {
      ...previous,
      nodes: previous.nodes.filter(node => node.id !== taskId),
      edges: previous.edges.filter(edge => edge.from !== taskId && edge.to !== taskId),
    } : previous);
  }, [queryClient]);

  const { subscribe, connected } = useWebSocket();
  useEffect(() => {
    const onUpsert = (msg: { task?: Task }) => {
      if (msg?.task?.id) patchNode(msg.task);
      else scheduleDeltaReconcile();
    };
    const onRemove = (msg: { task?: { id?: string }; taskId?: string; id?: string }) => {
      // The production broadcaster emits `{ id }` for deletion and archival
      // (review eac02957 B1 — the client used to read task.id and prune
      // nothing). Older shapes stay tolerated.
      const id = msg?.task?.id ?? msg?.taskId ?? msg?.id;
      if (id) removeNode(id);
      else scheduleDeltaReconcile();
    };
    const subs = [
      subscribe('task.updated', onUpsert),
      subscribe('task.created', onUpsert),
      subscribe('task.deleted', onRemove),
      subscribe('task.archived', event => {
        if (queryRef.current.includeArchived) scheduleDeltaReconcile(); else onRemove(event);
      }),
      subscribe('tasks.updated', scheduleDeltaReconcile),
    ];
    return () => subs.forEach(unsubscribe => unsubscribe?.());
  }, [subscribe, patchNode, removeNode, scheduleDeltaReconcile]);

  // Reconnect reconciles through the SAME debounced delta. With the §5
  // amendment there is no zoom level at which this is the wrong read, which
  // is what made the old version fire a full fetch from far zoom.
  useEffect(() => {
    if (connected) scheduleDeltaReconcile();
  }, [connected, scheduleDeltaReconcile]);

  const data = graphQuery.data;
  const graph = useMemo<MapGraph>(() => ({
    nodes: data?.nodes ?? [],
    edges: data?.edges ?? [],
    phases: data?.phases ?? [],
    reports: data?.reports ?? [],
  }), [data]);

  return {
    graph,
    generatedAt: data?.generatedAt ?? null,
    fullCount: data?.fullCount ?? 0,
    isLoading: graphQuery.isLoading,
    error: (graphQuery.error as Error | null) ?? null,
    pulsed,
    refetch: () => { void graphQuery.refetch(); },
  };
}
