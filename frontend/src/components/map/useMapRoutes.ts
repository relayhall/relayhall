import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeMapRoutes, mapRoutesSignature, pendingMapRoute, snapshotMapRoutes,
  type MapRoutesInput, type MapRoutesResult } from './computeMapRoutes';
import { MapRoutesWorkerClient } from './mapRoutesWorkerClient';
import type { EdgeRoute } from './mapGraphModel';

/** Current authority plus revision admit results independently of geometry equality. */
export function useMapRoutes(raw: MapRoutesInput | null, scope: string, revision: object) {
  const signature = raw ? mapRoutesSignature(raw) : null;
  const input = useMemo(() => raw ? snapshotMapRoutes(raw) : null, [signature]);
  const [supportsWorker] = useState(() => typeof Worker !== 'undefined');
  const [retryVersion, setRetryVersion] = useState(0);
  const enabled = Boolean(input?.requests.length);
  const generation = useMemo(() => ({}), [enabled, scope, revision, retryVersion]);
  const [accepted, setAccepted] = useState<{ generation: object; input: MapRoutesInput; rows: MapRoutesResult } | null>(null);
  const [fault, setFault] = useState<{ generation: object; error: Error } | null>(null);
  const clientRef = useRef<MapRoutesWorkerClient | null>(null);
  const current = useRef({ generation, input });
  current.current = { generation, input };

  useEffect(() => {
    if (!supportsWorker || !enabled) return;
    let live = true;
    const client = new MapRoutesWorkerClient(undefined, error => {
      if (live && current.current.generation === generation && error.name !== 'AbortError') setFault({ generation, error });
    });
    clientRef.current = client;
    return () => { live = false; client.dispose(); if (clientRef.current === client) clientRef.current = null; };
  }, [supportsWorker, enabled, generation]);

  useEffect(() => {
    if (!supportsWorker || !enabled || !input || !clientRef.current) return;
    const client = clientRef.current;
    const job = client.submit(input);
    let live = true;
    const isCurrent = () => live && current.current.generation === generation
      && current.current.input === input && clientRef.current === client;
    job.result.then(rows => {
      if (isCurrent()) { setFault(null); setAccepted({ generation, input, rows }); }
    }, error => {
      if (isCurrent() && error?.name !== 'AbortError') setFault({ generation,
        error: error instanceof Error ? error : new Error('Map connections failed') });
    });
    return () => { live = false; job.cancel(); };
  }, [supportsWorker, enabled, input, generation]);

  // Compatibility only. Actual worker failures never run routing on the UI thread.
  const synchronous = useMemo(() => !supportsWorker && input ? computeMapRoutes(input) : null, [supportsWorker, input]);
  const error = fault?.generation === generation ? fault.error : null;
  const complete = !enabled || Boolean(!error && (synchronous || accepted?.generation === generation && accepted.input === input));
  const rows = useMemo<Map<string, EdgeRoute & { pending: boolean }>>(() => {
    if (!input) return new Map();
    const result = synchronous ?? (complete ? accepted?.rows : null);
    return new Map(input.requests.map((request, i) => [request.key, {
      ...(result?.[i]?.route ?? pendingMapRoute(request.source, request.target)), pending: !complete,
    }]));
  }, [input, synchronous, accepted, complete]);
  const retry = useCallback(() => { setFault(null); setRetryVersion(value => value + 1); }, []);
  return { rows, pending: enabled && !complete && !error, error, retry, complete };
}
