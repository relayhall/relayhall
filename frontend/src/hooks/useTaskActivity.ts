import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../types/task';
import { authenticatedFetch } from '../utils/auth';

export type TaskActivityState = 'active' | 'idle' | 'stale' | 'unknown' | 'unavailable';
export interface TaskActivity { state: TaskActivityState; receivedAt: string | null; freshUntil?: number }
const UNKNOWN: TaskActivity = { state: 'unknown', receivedAt: null };
const UNAVAILABLE: TaskActivity = { state: 'unavailable', receivedAt: null };
const API = import.meta.env.VITE_API_BASE_URL || '/api';
const REFRESH_MS = 30_000;

/** receivedAt comes from the database clock and observedAt from the API
 * process clock. Two clocks disagree a little: an observation up to this far
 * "after" the read is clock skew and counts as age zero; beyond it the
 * response is refused as before. */
export const CLOCK_SKEW_TOLERANCE_MS = 5_000;

/** Activity is read and shown only for a Task In Progress. Outside it no
 * worker holds the Task, so a badge could only ever say Unknown; hiding it
 * there presents nothing, which is not the same as inferring liveness. */
export function activityApplies(task: Pick<Task, 'status'>): boolean {
  return task.status === 'in-progress';
}

/** What one observation is bound to besides the viewer: exactly the fields
 * whose change moves the server's assignment epoch. Lifecycle status and the
 * updated time are deliberately absent, so a board update to a card cannot
 * restart the read or drop the rows already shown. */
function assignmentOf(task: Task): string {
  return JSON.stringify([task.ownerPrincipalId ?? null, task.executionServiceId ?? null,
    task.executionDescriptorVersion ?? null, task.executionProfile ?? null]);
}

/** Scope = the viewer, the visible id set and each Task's assignment, so an
 * old response cannot cross a reassignment or viewer change even before the
 * effect cleanup commits. */
export function activityScope(tasks: Task[], viewer: string | null): string {
  const bound = new Map(tasks.map(task => [task.id.toLowerCase(), assignmentOf(task)]));
  return JSON.stringify([viewer, [...bound].sort((a, b) => a[0].localeCompare(b[0]))]);
}

function parseScope(scope: string): { viewer: string | null; bound: Map<string, string> } {
  const [viewer, entries] = JSON.parse(scope) as [string | null, Array<[string, string]>];
  return { viewer, bound: new Map(entries) };
}

export async function readTaskActivity(ids: string[], signal: AbortSignal): Promise<Map<string, TaskActivity>> {
  const result = new Map<string, TaskActivity>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = ids.slice(offset, offset + 100);
    const requestedAt = performance.now();
    const response = await authenticatedFetch(`${API}/tasks/activity?ids=${batch.join(',')}`, { signal });
    if (!response.ok) throw new Error('Task activity unavailable');
    const body = await response.json();
    const observedAt = Date.parse(body.observedAt);
    if (!body.success || !Array.isArray(body.activity) || body.activity.length > batch.length
      || !Number.isFinite(observedAt) || body.staleAfterMs !== 540_000) {
      throw new Error('Invalid task activity response');
    }
    const allowed = new Set(batch); const seen = new Set<string>();
    for (const row of body.activity) {
      if (!allowed.has(row.taskId) || seen.has(row.taskId)
        || !['active', 'idle', 'stale', 'unknown'].includes(row.state)
        || (row.state === 'unknown' ? row.receivedAt !== null || row.kind !== null
          : !['heartbeat', 'status'].includes(row.kind) || !Number.isFinite(Date.parse(row.receivedAt))
            || Date.parse(row.receivedAt) > observedAt + CLOCK_SKEW_TOLERANCE_MS)) {
        throw new Error('Invalid task activity row');
      }
      seen.add(row.taskId);
      // Skew within the tolerance is age zero: it never adds lifetime.
      const freshUntil = row.receivedAt === null ? undefined
        : requestedAt + body.staleAfterMs - Math.max(0, observedAt - Date.parse(row.receivedAt));
      result.set(row.taskId, { state: row.state, receivedAt: row.receivedAt,
        ...(freshUntil === undefined ? {} : { freshUntil }) });
    }
    // Omitted ids have lost authority or have no visible object. Do not retain
    // a previous successful value or distinguish a private object's existence.
    for (const id of batch) if (!seen.has(id)) result.set(id, UNKNOWN);
  }
  return expireActivity(result);
}

export function expireActivity(rows: Map<string, TaskActivity>): Map<string, TaskActivity> {
  const now = performance.now();
  return new Map([...rows].map(([id, row]) => [id,
    (row.state === 'active' || row.state === 'idle') && row.freshUntil !== undefined && row.freshUntil <= now
      ? { ...row, state: 'stale' as const } : row]));
}

interface Snapshot { viewer: string | null; bound: Map<string, string>; rows: Map<string, TaskActivity> }
const EMPTY: Snapshot = { viewer: null, bound: new Map(), rows: new Map() };

/** The rows of a snapshot still valid under a scope: the same viewer and, per
 * Task, the same assignment the row was read under. */
function retained(snapshot: Snapshot, viewer: string | null, bound: Map<string, string>): Map<string, TaskActivity> {
  const rows = new Map<string, TaskActivity>();
  if (snapshot.viewer !== viewer) return rows;
  for (const [id, assignment] of bound) {
    const row = snapshot.rows.get(id);
    if (row && snapshot.bound.get(id) === assignment) rows.set(id, row);
  }
  return rows;
}

/** One sequential refresh loop per surface; never one poller per card.
 * Abort on hidden page, unmount, scope/viewer change; obsolete responses
 * cannot write state even when a transport ignores its AbortSignal. */
export function useTaskActivity(tasks: Task[], viewer: string | null): Map<string, TaskActivity> {
  const scope = activityScope(tasks, viewer);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const latest = useRef<Snapshot>(EMPTY);
  useEffect(() => {
    const { viewer: scopeViewer, bound } = parseScope(scope);
    const ids = [...bound.keys()];
    let disposed = false; let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let visibleRows = new Map<string, TaskActivity>();
    let controller: AbortController | undefined;
    const stop = () => { generation++; controller?.abort(); clearTimeout(timer); clearTimeout(expiryTimer); };
    const commit = (rows: Map<string, TaskActivity>) => {
      latest.current = { viewer: scopeViewer, bound, rows };
      setSnapshot(latest.current);
    };
    const publish = (rows: Map<string, TaskActivity>) => {
      clearTimeout(expiryTimer);
      // Seeing the same observation again cannot renew its display lifetime.
      for (const [id, row] of rows) {
        const old = visibleRows.get(id);
        if (row.receivedAt && row.receivedAt === old?.receivedAt && row.freshUntil !== undefined && old.freshUntil !== undefined) {
          rows.set(id, { ...row, freshUntil: Math.min(row.freshUntil, old.freshUntil) });
        }
      }
      visibleRows = expireActivity(rows);
      commit(visibleRows);
      const deadlines = [...visibleRows.values()].filter(row => row.state === 'active' || row.state === 'idle')
        .flatMap(row => row.freshUntil === undefined ? [] : [row.freshUntil]);
      if (deadlines.length) expiryTimer = setTimeout(() => {
        if (!disposed && !document.hidden) publish(visibleRows);
      }, Math.max(1, Math.min(...deadlines) - performance.now()));
    };
    const refresh = async () => {
      if (disposed || document.hidden || ids.length === 0) return;
      const current = ++generation; controller = new AbortController();
      const requestController = controller;
      const deadline = setTimeout(() => requestController.abort(), 20_000);
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(new DOMException('Aborted', 'AbortError'));
        requestController.signal.addEventListener('abort', abortListener, { once: true });
      });
      try {
        const rows = await Promise.race([readTaskActivity(ids, requestController.signal), aborted]);
        if (!disposed && !document.hidden && current === generation) publish(rows);
      } catch {
        if (!disposed && !document.hidden && current === generation) {
          publish(new Map(ids.map(id => [id, UNAVAILABLE])));
        }
      } finally {
        clearTimeout(deadline);
        if (abortListener) requestController.signal.removeEventListener('abort', abortListener);
        if (!disposed && !document.hidden && current === generation) timer = setTimeout(refresh, REFRESH_MS);
      }
    };
    const visibility = () => {
      stop(); visibleRows = new Map(); commit(visibleRows);
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    // A row read for the same viewer under the same assignment stays shown,
    // with its own deadline, while the changed set is read: only a Task that
    // joined the set, or whose assignment moved, starts without one.
    const kept = retained(latest.current, scopeViewer, bound);
    if (kept.size > 0 && !document.hidden) publish(kept);
    void refresh();
    return () => { disposed = true; stop(); document.removeEventListener('visibilitychange', visibility); };
  }, [scope]);
  return useMemo(() => {
    const { viewer: scopeViewer, bound } = parseScope(scope);
    return retained(snapshot, scopeViewer, bound);
  }, [snapshot, scope]);
}
