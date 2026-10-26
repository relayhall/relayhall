import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MapRoutesWorkerClient, type MapRoutesWorkerPort, type MapRoutesJob } from './mapRoutesWorkerClient';
import { computeMapRoutes, type MapRoutesInput } from './computeMapRoutes';

const input = (): MapRoutesInput => ({ organization: 'horizontal', obstacles: [], envelope: null,
  requests: [{ key: 'edge', mode: 'flow', source: { x: 0, y: 0, w: 10, h: 10 }, target: { x: 100, y: 0, w: 10, h: 10 } }] });
class Port implements MapRoutesWorkerPort {
  sent: Parameters<MapRoutesWorkerPort['postMessage']>[0][] = [];
  onmessage: MapRoutesWorkerPort['onmessage'] = null;
  onerror: MapRoutesWorkerPort['onerror'] = null;
  onmessageerror: MapRoutesWorkerPort['onmessageerror'] = null;
  terminate = vi.fn();
  postMessage = vi.fn((request: Parameters<MapRoutesWorkerPort['postMessage']>[0]) => { this.sent.push(request); });
  reply(index: number, extra = {}) {
    const request = this.sent[index];
    this.onmessage?.({ data: { id: request.id, ok: true, result: computeMapRoutes(request.input), ...extra } } as MessageEvent);
  }
}
const clients: MapRoutesWorkerClient[] = [];
const setup = () => { const port = new Port(), failed = vi.fn(); const client = new MapRoutesWorkerClient(() => port, failed);
  clients.push(client); return { port, client, failed }; };
const observe = (job: MapRoutesJob) => job.result.catch((error: Error) => error);
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

test('snapshot, one occupied slot and latest pending coalescing', async () => {
  const { port, client } = setup(); const value = input();
  const a = observe(client.submit(value)); value.requests[0].source.x = 999;
  expect(port.sent[0].input.requests[0].source.x).toBe(0);
  const b = observe(client.submit(input())), c = client.submit(input());
  expect(port.sent).toHaveLength(1);
  expect(await a).toMatchObject({ name: 'AbortError' }); expect(await b).toMatchObject({ name: 'AbortError' });
  port.reply(0); expect(port.sent).toHaveLength(2);
  port.reply(1); expect(await c.result).toEqual(computeMapRoutes(input()));
});
test('cancellation and unknown/duplicate replies do not release active work', async () => {
  const { port, client } = setup(); const a = client.submit(input()), result = observe(a); a.cancel();
  const b = client.submit(input());
  port.reply(0, { id: 800 }); expect(port.sent).toHaveLength(1);
  port.reply(0); expect(port.sent).toHaveLength(2);
  port.reply(0); expect(vi.getTimerCount()).toBe(1);
  port.reply(1); await b.result; expect(await result).toMatchObject({ name: 'AbortError' });
});
test('pending replacement cannot extend the active dispatch deadline', async () => {
  const { port, client, failed } = setup(); const a = observe(client.submit(input()));
  vi.advanceTimersByTime(29_999); const b = observe(client.submit(input()));
  vi.advanceTimersByTime(1);
  expect(await a).toMatchObject({ name: 'AbortError' }); expect(await b).toMatchObject({ message: 'Map routes timed out' });
  expect(port.sent).toHaveLength(1); expect(port.terminate).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
  expect(await observe(client.submit(input()))).toMatchObject({ message: 'Map routes timed out' });
});
test.each(['missing', 'duplicate', 'wrong-key', 'malformed', 'empty-path'] as const)('rejects %s replies', async kind => {
  const { port, client } = setup(); const value = input(); value.requests.push({ ...value.requests[0], key: 'second' });
  const result = observe(client.submit(value)); const rows = computeMapRoutes(value);
  if (kind === 'missing') rows.pop();
  if (kind === 'duplicate') rows[1] = rows[0];
  if (kind === 'wrong-key') rows[0].key = 'different';
  if (kind === 'empty-path') rows[0].route.d = '';
  port.reply(0, { result: kind === 'malformed' ? null : rows });
  expect(await result).toMatchObject({ message: 'Invalid Map routes reply' }); expect(port.terminate).toHaveBeenCalledOnce();
});
test('empty requests and disposal while active/pending', async () => {
  const { port, client } = setup(); const empty = client.submit({ ...input(), requests: [] }); port.reply(0); expect(await empty.result).toEqual([]);
  const a = observe(client.submit(input())), b = observe(client.submit(input())); client.dispose();
  expect(await a).toMatchObject({ name: 'AbortError' }); expect(await b).toMatchObject({ name: 'AbortError' });
  expect(port.onmessage).toBeNull(); expect(port.terminate).toHaveBeenCalledOnce();
});
test.each(['onerror', 'onmessageerror'] as const)('%s is terminal including while idle', async event => {
  const { port, client, failed } = setup(); port[event]?.(new Event('error') as never);
  expect(await observe(client.submit(input()))).toBeInstanceOf(Error); expect(failed).toHaveBeenCalledOnce();
});
test('construction/posting failures and duplicate request keys fail explicitly', async () => {
  const broken = new MapRoutesWorkerClient(() => { throw new Error('construction'); }); clients.push(broken);
  expect(await observe(broken.submit(input()))).toMatchObject({ message: 'construction' });
  const { port, client } = setup(); const duplicate = input(); duplicate.requests.push(duplicate.requests[0]);
  expect(await observe(client.submit(duplicate))).toMatchObject({ message: 'Duplicate Map route request' });
  expect(port.sent).toHaveLength(0);
  port.postMessage.mockImplementation(() => { throw new Error('posting'); });
  expect(await observe(client.submit(input()))).toMatchObject({ message: 'posting' });
});

test('submission snapshot retains numeric distinctions used by admission signatures', async () => {
  const { port, client } = setup(); const value = input();
  value.requests[0].source = { x: -0, y: NaN, w: Infinity, h: -Infinity };
  const pending = observe(client.submit(value));
  const box = port.sent[0].input.requests[0].source;
  expect(Object.is(box.x, -0)).toBe(true); expect(Number.isNaN(box.y)).toBe(true);
  expect(box.w).toBe(Infinity); expect(box.h).toBe(-Infinity);
  client.dispose(); expect(await pending).toMatchObject({ name: 'AbortError' });
});
