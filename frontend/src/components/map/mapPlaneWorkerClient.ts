import type { MapPlaneInput } from './computeMapPlane';
import type { PlaneLayoutResult } from './mapPlaneModel';
import type { MapPlaneChannel, MapPlaneRequest } from './mapPlaneWorkerProtocol';

export interface MapPlaneWorkerPort {
  postMessage: (request: MapPlaneRequest) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}
interface Job {
  request: MapPlaneRequest;
  resolve: (result: PlaneLayoutResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
}
export interface MapPlaneJob {
  result: Promise<PlaneLayoutResult>;
  cancel: () => void;
}

const aborted = () => new DOMException('Map calculation superseded', 'AbortError');
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
// Partial structural validation, not a complete geometry/schema validator:
// nested anchors, optional regions and kind-specific fields remain the pure
// engine's responsibility. Validate the envelope and common output structure.
function isLayout(value: unknown): value is PlaneLayoutResult {
  return object(value) && Array.isArray(value.elements)
    && value.elements.every(element => object(element) && typeof element.id === 'string'
      && ['tile', 'band', 'container', 'chip', 'lane', 'pill', 'hull'].includes(element.kind as string)
      && ['x', 'y', 'w', 'h'].every(key => typeof element[key] === 'number' && Number.isFinite(element[key]))
      && (element.kind !== 'tile' || (object(element.node) && element.node.id === element.id)))
    && typeof value.width === 'number' && Number.isFinite(value.width)
    && typeof value.height === 'number' && Number.isFinite(value.height)
    && object(value.anchors) && value.anchors.version === 1 && Array.isArray(value.anchors.laneOrder)
    && ['slots', 'segOrder'].every(key => object((value.anchors as Record<string, unknown>)[key]));
}

/** One occupied worker slot; cancelled calculations still occupy that slot. */
export class MapPlaneWorkerClient {
  private worker: MapPlaneWorkerPort | null = null;
  private failure: Error | null = null;
  private active: Job | null = null;
  private pending = new Map<MapPlaneChannel, Job>();
  private nextId = 0;
  private lastChannel: MapPlaneChannel = 'switch';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(factory: () => MapPlaneWorkerPort = () => new Worker(
    new URL('./mapPlane.worker.ts', import.meta.url), { type: 'module' }) as MapPlaneWorkerPort,
    private readonly onFailure?: (error: Error) => void) {
    try {
      this.worker = factory();
      this.worker.onmessage = event => this.receive(event.data);
      this.worker.onerror = () => this.fail(new Error('Map calculation worker failed'));
      this.worker.onmessageerror = () => this.fail(new Error('Map calculation reply could not be read'));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Map calculation worker could not start'));
    }
  }

  submit(channel: MapPlaneChannel, input: MapPlaneInput): MapPlaneJob {
    let resolve!: Job['resolve'], reject!: Job['reject'];
    const result = new Promise<PlaneLayoutResult>((yes, no) => { resolve = yes; reject = no; });
    if (this.failure) { reject(this.failure); return { result, cancel: () => {} }; }
    let snapshot: MapPlaneInput;
    try { snapshot = structuredClone(input); }
    catch (error) {
      reject(error instanceof Error ? error : new Error('Map input could not be copied'));
      return { result, cancel: () => {} };
    }
    const job: Job = { request: { id: ++this.nextId, channel, input: snapshot }, resolve, reject, settled: false };
    if (this.active?.request.channel === channel) this.reject(this.active, aborted());
    const old = this.pending.get(channel);
    if (old) this.reject(old, aborted());
    this.pending.set(channel, job);
    this.dispatch();
    return { result, cancel: () => {
      this.reject(job, aborted());
      if (this.pending.get(channel) === job) this.pending.delete(channel);
    } };
  }

  dispose(): void { this.fail(aborted()); }

  private reject(job: Job, error: Error): void {
    if (!job.settled) { job.settled = true; job.reject(error); }
  }

  private dispatch(): void {
    if (this.failure || this.active || !this.worker) return;
    const preferred: MapPlaneChannel = this.lastChannel === 'layout' ? 'switch' : 'layout';
    const next = this.pending.get(preferred) ?? this.pending.get(this.lastChannel);
    if (!next) return;
    this.pending.delete(next.request.channel);
    this.active = next;
    this.lastChannel = next.request.channel;
    // Dispatch, not submission or replacement, starts the computation deadline.
    this.timer = setTimeout(() => this.fail(new Error('Map calculation timed out')), 30_000);
    try { this.worker.postMessage(next.request); }
    catch (error) { this.fail(error instanceof Error ? error : new Error('Map calculation could not be sent')); }
  }

  private receive(value: unknown): void {
    const job = this.active;
    if (!job || this.failure) return;
    if (!object(value) || !Number.isSafeInteger(value.id)) {
      this.fail(new Error('Invalid Map calculation reply')); return;
    }
    // An old duplicate cannot release a newer occupied slot.
    if (value.id !== job.request.id) return;
    if (value.channel !== job.request.channel
      || (value.ok !== true && value.ok !== false)
      || (value.ok === true ? !isLayout(value.result) : typeof value.error !== 'string')) {
      this.fail(new Error('Invalid Map calculation reply')); return;
    }
    if (value.ok === false) { this.fail(new Error(value.error as string)); return; }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
    if (!job.settled) { job.settled = true; job.resolve(value.result as PlaneLayoutResult); }
    this.dispatch();
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) this.reject(this.active, error);
    this.active = null;
    for (const job of this.pending.values()) this.reject(job, error);
    this.pending.clear();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.onFailure?.(error);
  }
}
