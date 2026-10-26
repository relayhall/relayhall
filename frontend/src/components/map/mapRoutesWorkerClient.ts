import { snapshotMapRoutes, type MapRoutesInput, type MapRoutesResult } from './computeMapRoutes';

interface Request { id: number; input: MapRoutesInput }
export interface MapRoutesWorkerPort {
  postMessage: (request: Request) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}
export interface MapRoutesJob { result: Promise<MapRoutesResult>; cancel: () => void }
interface Job { request: Request; resolve: (result: MapRoutesResult) => void;
  reject: (error: Error) => void; settled: boolean }
const aborted = () => new DOMException('Map routes superseded', 'AbortError');
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class MapRoutesWorkerClient {
  private worker: MapRoutesWorkerPort | null = null;
  private active: Job | null = null;
  private pending: Job | null = null;
  private failure: Error | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private id = 0;
  constructor(factory: () => MapRoutesWorkerPort = () => new Worker(
    new URL('./mapRoutes.worker.ts', import.meta.url), { type: 'module' }) as MapRoutesWorkerPort,
    private readonly onFailure?: (error: Error) => void) {
    try {
      this.worker = factory();
      this.worker.onmessage = event => this.receive(event.data);
      this.worker.onerror = () => this.fail(new Error('Map routes worker failed'));
      this.worker.onmessageerror = () => this.fail(new Error('Map routes reply could not be read'));
    } catch (error) { this.fail(error instanceof Error ? error : new Error('Map routes worker could not start')); }
  }
  submit(input: MapRoutesInput): MapRoutesJob {
    let resolve!: Job['resolve'], reject!: Job['reject'];
    const result = new Promise<MapRoutesResult>((yes, no) => { resolve = yes; reject = no; });
    if (this.failure) { reject(this.failure); return { result, cancel: () => {} }; }
    let snapshot: MapRoutesInput;
    try {
      snapshot = snapshotMapRoutes(input);
      if (new Set(snapshot.requests.map(r => r.key)).size !== snapshot.requests.length) {
        throw new Error('Duplicate Map route request');
      }
    } catch (error) { reject(error instanceof Error ? error : new Error('Map routes input invalid'));
      return { result, cancel: () => {} }; }
    const job: Job = { request: { id: ++this.id, input: snapshot }, resolve, reject, settled: false };
    if (this.active) this.reject(this.active, aborted());
    if (this.pending) this.reject(this.pending, aborted());
    this.pending = job;
    this.dispatch();
    return { result, cancel: () => {
      this.reject(job, aborted());
      if (this.pending === job) this.pending = null;
    } };
  }
  dispose(): void { this.fail(aborted()); }
  private reject(job: Job, error: Error) {
    if (!job.settled) { job.settled = true; job.reject(error); }
  }
  private dispatch() {
    if (this.failure || this.active || !this.worker || !this.pending) return;
    const job = this.pending; this.pending = null; this.active = job;
    this.timer = setTimeout(() => this.fail(new Error('Map routes timed out')), 30_000);
    try { this.worker.postMessage(job.request); }
    catch (error) { this.fail(error instanceof Error ? error : new Error('Map routes could not be sent')); }
  }
  private receive(value: unknown) {
    const job = this.active;
    if (!job || this.failure) return;
    if (!object(value) || !Number.isSafeInteger(value.id)) { this.fail(new Error('Invalid Map routes reply')); return; }
    if (value.id !== job.request.id) return;
    if (value.ok === false && typeof value.error === 'string') { this.fail(new Error(value.error)); return; }
    const rows = value.result;
    // Exact count/order/key coverage: missing and duplicate results cannot settle.
    if (value.ok !== true || !Array.isArray(rows) || rows.length !== job.request.input.requests.length
      || !rows.every((row, i) => object(row) && row.key === job.request.input.requests[i].key
        && object(row.route) && typeof row.route.d === 'string' && row.route.d.length > 0
        && typeof row.route.clipped === 'boolean')) {
      this.fail(new Error('Invalid Map routes reply')); return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null; this.active = null;
    if (!job.settled) { job.settled = true; job.resolve(rows as MapRoutesResult); }
    this.dispatch();
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) this.reject(this.active, error);
    if (this.pending) this.reject(this.pending, error);
    this.active = null; this.pending = null;
    if (this.worker) {
      this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
    this.onFailure?.(error);
  }
}
