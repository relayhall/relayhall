import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeMapPlane, type MapPlaneInput } from './computeMapPlane';
import { MapPlaneWorkerClient, type MapPlaneJob } from './mapPlaneWorkerClient';
import type { PlaneLayoutResult } from './mapPlaneModel';
import { projectPendingPlane } from './projectPendingPlane';

interface AcceptedPlane {
  generation: object;
  scope: string;
  input: MapPlaneInput;
  layout: PlaneLayoutResult;
}
/** Authority-qualified input only; null immediately hides any prior result. */
export function useMapPlaneLayout(input: MapPlaneInput | null, scope: string,
  onAccepted: (input: MapPlaneInput, result: PlaneLayoutResult) => void) {
  const [supportsWorker] = useState(() => typeof Worker !== 'undefined');
  const [retryVersion, setRetryVersion] = useState(0);
  const [accepted, setAccepted] = useState<AcceptedPlane | null>(null);
  const [clientFault, setClientFault] = useState<{ generation: object; error: Error } | null>(null);
  const [fault, setFault] = useState<{ input: MapPlaneInput; scope: string; generation: object; error: Error } | null>(null);
  const clientRef = useRef<MapPlaneWorkerClient | null>(null);
  const adopted = useRef<AcceptedPlane | null>(null);
  const enabled = input !== null;
  const generation = useMemo(() => ({}), [enabled, scope, retryVersion]);
  const current = useRef({ input, scope, generation, onAccepted });
  current.current = { input, scope, generation, onAccepted };

  useEffect(() => {
    if (!supportsWorker || !enabled) return;
    let live = true;
    const client = new MapPlaneWorkerClient(undefined, error => {
      if (live && current.current.generation === generation && error.name !== 'AbortError') {
        setClientFault({ generation, error });
      }
    });
    clientRef.current = client;
    return () => { live = false; client.dispose(); if (clientRef.current === client) clientRef.current = null; };
  }, [supportsWorker, enabled, scope, retryVersion, generation]);

  useEffect(() => {
    if (!supportsWorker || !input || !clientRef.current) return;
    const target = adopted.current;
    adopted.current = null;
    if (target?.generation === generation && target.scope === scope
      && target.input.graph === input.graph && target.input.sizes === input.sizes
      && target.input.organization === input.organization && input.anchors === target.layout.anchors) {
      setAccepted({ ...target, input });
      return;
    }
    const client = clientRef.current;
    const job = client.submit('layout', input);
    let live = true;
    const isCurrent = () => live && current.current.input === input && current.current.scope === scope
      && current.current.generation === generation
      && clientRef.current === client;
    job.result.then(layout => {
      if (!isCurrent()) return;
      try {
        current.current.onAccepted(input, layout);
        setFault(null);
        setAccepted({ generation, scope, input, layout });
      } catch (error) {
        setFault({ generation, input, scope,
          error: error instanceof Error ? error : new Error('Map layout could not be committed') });
      }
    }, error => {
      if (isCurrent() && error?.name !== 'AbortError') setFault({ generation, input, scope,
        error: error instanceof Error ? error : new Error('Map layout failed') });
    });
    return () => { live = false; job.cancel(); };
  }, [supportsWorker, input, scope, retryVersion, generation]);

  // Unsupported environments retain the exact pure calculation. A failed
  // actual worker never reaches this compatibility branch.
  const synchronous = useMemo(() => !supportsWorker && input ? computeMapPlane(input) : null,
    [supportsWorker, input]);
  useLayoutEffect(() => {
    if (!synchronous || !input) return;
    try {
      current.current.onAccepted(input, synchronous);
      setFault(null);
      setAccepted({ generation, scope, input, layout: synchronous });
    } catch (error) {
      setFault({ generation, input, scope,
        error: error instanceof Error ? error : new Error('Map layout could not be committed') });
    }
  }, [synchronous, input, scope, generation]);

  const visible = useMemo(() => {
    if (!input) return null;
    if (synchronous) return { graph: input.graph, layout: synchronous, pendingTaskCount: 0, pendingReportCount: 0 };
    if (!accepted || accepted.generation !== generation || accepted.scope !== scope || accepted.input.organization !== input.organization) return null;
    return accepted.input.graph === input.graph
      ? { graph: input.graph, layout: accepted.layout, pendingTaskCount: 0, pendingReportCount: 0 }
      : projectPendingPlane(accepted.layout, accepted.input.graph, input.graph);
  }, [accepted, input, scope, synchronous, generation]);
  const error = clientFault?.generation === generation ? clientFault.error
    : fault?.generation === generation && fault.scope === scope && fault.input === input ? fault.error : null;
  const complete = Boolean(!error && input && accepted?.generation === generation && accepted.scope === scope && accepted.input === input);
  const retry = useCallback(() => { setFault(null); setRetryVersion(value => value + 1); }, []);
  const requestTarget = useCallback((target: MapPlaneInput): MapPlaneJob => {
    if (supportsWorker && clientRef.current) return clientRef.current.submit('switch', target);
    if (supportsWorker) return { result: Promise.reject(new Error('Map calculation is not ready')), cancel: () => {} };
    let cancelled = false;
    const snapshot = structuredClone(target);
    return { result: Promise.resolve().then(() => {
      if (cancelled) throw new DOMException('Map switch cancelled', 'AbortError');
      return computeMapPlane(snapshot);
    }), cancel: () => { cancelled = true; } };
  }, [supportsWorker]);
  const adoptTarget = useCallback((target: MapPlaneInput, layout: PlaneLayoutResult) => {
    if (current.current.generation !== generation || !current.current.input) {
      throw new DOMException('Map authority changed', 'AbortError');
    }
    current.current.onAccepted(target, layout);
    const snapshot = { generation, scope, input: target, layout };
    adopted.current = snapshot;
    setFault(null);
    setAccepted(snapshot);
  }, [generation, scope]);
  return { visible, complete, error, retry, supportsWorker, requestTarget, adoptTarget };
}
