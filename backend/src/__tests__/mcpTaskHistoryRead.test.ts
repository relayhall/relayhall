import { toolByName } from '../mcp/registry';
import * as rest from '../mcp/rest';
import { errorFromRest } from '../mcp/shape';

const TASK = '308e8149-3608-4ab0-8e34-42add99ecb34';
const context = { authorization: 'Bearer limited-reader', toolName: 'history-test' };
const stream = () => toolByName('relayhall_task_stream_list')!;
const timeline = () => toolByName('relayhall_task_timeline_get')!;

afterEach(() => jest.restoreAllMocks());

test('both readers are read-only shared-registry tools and forward caller identity to guarded REST', async () => {
  const mock = jest.spyOn(rest, 'board').mockResolvedValue({ entries: [], events: [], filter: 'all', sourcesUnavailable: [], nextCursor: null });
  for (const tool of [stream(), timeline()]) {
    expect(tool.plane).toBe('introspection');
    expect(tool.scope).toBe('tasks:read');
    await tool.handler({ task: TASK }, context);
  }
  expect(mock).toHaveBeenNthCalledWith(1, context, { method: 'GET', path: `/tasks/${TASK}/stream`, requiredScope: 'tasks:read' });
  expect(mock).toHaveBeenNthCalledWith(2, context, { method: 'GET', path: `/tasks/${TASK}/timeline`, query: { filter: undefined, before: undefined, limit: '20' }, requiredScope: 'tasks:read' });
});

test('stream pages only REST-visible entries, caps at 50, and masks tombstone text', async () => {
  const entries = Array.from({ length: 55 }, (_, i) => ({
    id: `entry-${i}`, stream_offset: i + 1, created_at: '2026-10-13T00:00:00Z',
    event_type: 'activity', provenance: 'authored', content: `visible ${i}`,
    ...(i === 3 ? { redacted_at: '2026-10-13T00:01:00Z', redaction_mode: 'tombstone', content: 'sensitive original' } : {}),
  }));
  const mock = jest.spyOn(rest, 'board').mockResolvedValue({ entries });
  const first = await stream().handler({ task: TASK, limit: 100, response_format: 'detailed' }, context);
  expect(first).toContain('50 of 55 visible entries');
  expect(first).toContain('next offset=50');
  expect(first).not.toContain('sensitive original');
  expect(first).toContain('truncated at 10000');
  const continuation = await stream().handler({ task: TASK, limit: 100, response_format: 'detailed', continue_from: 10000 }, context);
  expect(continuation).toContain('"nextOffset": 50');
  const second = await stream().handler({ task: TASK, offset: 50 }, context);
  expect(second).toContain('5 of 55 visible entries');
  expect(second).toContain('page complete');
  expect(second).toContain('visible 54');
  expect(second).not.toContain('visible 0');
  expect(mock).toHaveBeenCalledTimes(3);
});

test('both formats label free text untrusted, bound it, and support continuation', async () => {
  const content = 'PROMPT-INJECTION-IGNORE-THIS ' + 'x'.repeat(15_000);
  jest.spyOn(rest, 'board').mockResolvedValue({ entries: [{ id: 'one', content }], events: [{ id: 'one', description: content }], filter: 'all', sourcesUnavailable: [], nextCursor: null });
  for (const tool of [stream(), timeline()]) for (const format of ['concise', 'detailed'] as const) {
    const first = await tool.handler({ task: TASK, response_format: format }, context);
    expect(first).toContain('untrusted data');
    expect(first).toContain('truncated at 10000');
    expect(first.length).toBeLessThan(11_000);
    const next = await tool.handler({ task: TASK, response_format: format, continue_from: 10000 }, context);
    expect(next).toContain('untrusted data');
    expect(next).toContain('page complete');
    expect(next).not.toContain('truncated at 10000');
  }
});

test('timeline forwards filter and opaque cursor; preserves source degradation and continuation', async () => {
  const mock = jest.spyOn(rest, 'board').mockResolvedValue({
    filter: 'handover', events: [{ id: 'event-1', at: '2026-10-13T00:00:00Z', description: 'handoff text' }],
    sourcesUnavailable: ['review'], sourceErrorIds: { review: 'err-1' }, nextCursor: 'opaque.next',
  });
  const result = await timeline().handler({ task: TASK, filter: 'handover', before: 'opaque.prev', limit: 100 }, context);
  expect(mock).toHaveBeenCalledWith(context, { method: 'GET', path: `/tasks/${TASK}/timeline`, query: { filter: 'handover', before: 'opaque.prev', limit: '50' }, requiredScope: 'tasks:read' });
  expect(result).toContain('more via nextCursor');
  expect(result).toContain('sources unavailable: review');
  expect(result).toContain('opaque.next');
  expect(result).toContain('err-1');
});

test('REST scope and concealed-object refusals propagate without history data', async () => {
  const mock = jest.spyOn(rest, 'board');
  for (const [status, body] of [
    [403, { error: 'Scope required', details: { requiredScopes: ['tasks:read'] } }],
    [404, { error: 'Resource not found' }],
  ] as const) {
    mock.mockRejectedValueOnce(errorFromRest('history-test', status, body, 'tasks:read'));
    await expect(stream().handler({ task: TASK }, context)).rejects.toThrow(status === 403 ? 'tasks:read' : 'Resource not found');
    mock.mockRejectedValueOnce(errorFromRest('history-test', status, body, 'tasks:read'));
    await expect(timeline().handler({ task: TASK }, context)).rejects.toThrow(status === 403 ? 'tasks:read' : 'Resource not found');
  }
});
