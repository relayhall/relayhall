// unifiedTimeline.test.ts — C1 (RH-UI.7, ratified design 3cdf6e65 §4.1/§8):
// merge correctness incl. the 086 dedup rule, filter taxonomy, keyset
// pagination stability, per-source-nullable attribution, degradation, and
// additive compatibility with the live TaskDetailModal consumer.
import {
  UnifiedTaskTimeline,
  unifiedTaskTimeline,
  timelineView,
  encodeCursor,
  decodeCursor,
  mapStreamRow,
  mapHistoryRow,
} from '../services/UnifiedTaskTimeline';
import { pool } from '../db/connection';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

function baseTask(overrides: Record<string, any> = {}): any {
  return {
    id: TASK_ID,
    title: 'Fixture task',
    created: '2026-08-01T00:00:00.000Z',
    updated: '2026-08-14T12:00:00.000Z',
    startedAt: '2026-08-02T00:00:00.000Z',
    sessionRefs: [],
    reviewHistory: [],
    ...overrides,
  };
}

function streamRow(overrides: Record<string, any> = {}): any {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    task_id: TASK_ID,
    provenance: 'system',
    event_type: 'task.claimed',
    content: 'claimed by agent',
    author_principal_id: 'bbbbbbbb-0000-4000-8000-000000000001',
    author_handle: 'agent-1',
    author_role: 'claimant',
    metadata: {},
    legacy_source: null,
    legacy_source_id: null,
    redacted_at: null,
    redaction_mode: null,
    created_at: '2026-08-10T10:00:00.000Z',
    ...overrides,
  };
}

const options = (over: Partial<{ filter: 'all' | 'handover' | 'system'; before: string | null; limit: number }> = {}) => ({
  filter: 'all' as const,
  before: null,
  limit: 50,
  ...over,
});

describe('unified timeline merge (§4.1)', () => {
  test('merges all four sources and orders at DESC, source, id DESC', () => {
    const task = baseTask({
      sessionRefs: ['sess-1'],
      reviewHistory: [{ id: 'r1', decision: 'pass', completedAt: '2026-08-11T00:00:00.000Z', triggeredBy: 'system' }],
    });
    const result = unifiedTaskTimeline.merge(
      task,
      [streamRow()],
      [{ id: 7, field: 'status', old_value: 'todo', new_value: 'in-progress', changed_by: 'system', note: null, actor_principal_id: null, created_at: '2026-08-12T00:00:00.000Z' }],
      options(),
    );
    expect(result.sourcesUnavailable).toEqual([]);
    expect(result.events.map(e => e.source)).toEqual(['history', 'review', 'stream', 'session']);
    const ats = result.events.map(e => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  test('same-instant events tie-break deterministically by source then id DESC', () => {
    const at = '2026-08-10T10:00:00.000Z';
    const task = baseTask();
    const rows = [
      streamRow({ id: 'aaaaaaaa-0000-4000-8000-000000000002', created_at: at }),
      streamRow({ id: 'aaaaaaaa-0000-4000-8000-000000000001', created_at: at }),
    ];
    const history = [{ id: 3, field: 'status', old_value: null, new_value: 'todo', changed_by: 'system', note: null, actor_principal_id: null, created_at: at }];
    const first = unifiedTaskTimeline.merge(task, rows, history, options());
    const second = unifiedTaskTimeline.merge(task, [...rows].reverse(), history, options());
    expect(first.events.map(e => e.id)).toEqual(second.events.map(e => e.id));
    // history < stream lexicographically; within stream, id DESC
    expect(first.events.map(e => e.id)).toEqual([
      'history-3',
      'aaaaaaaa-0000-4000-8000-000000000002',
      'aaaaaaaa-0000-4000-8000-000000000001',
    ]);
  });

  test('keyset pagination yields no duplicates and no gaps across pages', () => {
    const task = baseTask();
    const rows = Array.from({ length: 7 }, (_, i) => streamRow({
      id: `aaaaaaaa-0000-4000-8000-00000000000${i}`,
      created_at: `2026-08-1${i % 3}T0${i}:00:00.000Z`,
    }));
    const page1 = unifiedTaskTimeline.merge(task, rows, [], options({ limit: 3 }));
    expect(page1.events).toHaveLength(3);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = unifiedTaskTimeline.merge(task, rows, [], options({ limit: 3, before: page1.nextCursor }));
    const page3 = unifiedTaskTimeline.merge(task, rows, [], options({ limit: 3, before: page2.nextCursor }));
    const all = [...page1.events, ...page2.events, ...page3.events].map(e => e.id);
    expect(new Set(all).size).toBe(7);
    expect(all).toHaveLength(7);
    const whole = unifiedTaskTimeline.merge(task, rows, [], options({ limit: 200 }));
    expect(all).toEqual(whole.events.map(e => e.id));
    expect(page3.nextCursor).toBeNull();
  });

  test('cursor round-trips and rejects garbage', () => {
    const event = mapStreamRow(streamRow());
    const cursor = encodeCursor(event);
    expect(decodeCursor(cursor)).toEqual({ at: event.at, source: 'stream', id: event.id });
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('{"nope":1}').toString('base64url'))).toBeNull();
    // semantically invalid tuples are rejected, not silently accepted
    expect(decodeCursor(Buffer.from(JSON.stringify({ at: 'not-a-date', source: 'stream', id: 'x' })).toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ at: '2026-08-10T00:00:00.000Z', source: 'bogus', id: 'x' })).toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ at: '2026-08-10T00:00:00.000Z', source: 'stream', id: '' })).toString('base64url'))).toBeNull();
    // canonical-shape adversaries: same instant, different string — would
    // break lexicographic keyset comparison if accepted
    expect(decodeCursor(Buffer.from(JSON.stringify({ at: '2026-08-10T00:00:00Z', source: 'stream', id: 'x' })).toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ at: '2026-08-10T00:00:00.1Z', source: 'stream', id: 'x' })).toString('base64url'))).toBeNull();
  });

  test('per-source degradation: a failed source is named, the rest returns', () => {
    const task = baseTask({ sessionRefs: ['sess-1'] });
    const result = unifiedTaskTimeline.merge(task, new Error('db down'), [], options());
    expect(result.sourcesUnavailable).toEqual(['stream']);
    expect(result.events.map(e => e.source)).toEqual(['session']);
    const both = unifiedTaskTimeline.merge(task, new Error('a'), new Error('b'), options());
    expect(both.sourcesUnavailable).toEqual(['stream', 'history']);
  });

  test('empty is distinguishable from failed', () => {
    const result = unifiedTaskTimeline.merge(baseTask(), [], [], options());
    expect(result.events).toEqual([]);
    expect(result.sourcesUnavailable).toEqual([]);
  });
});

describe('attribution honesty (§4.1)', () => {
  test('stream rows carry full author attribution when stored', () => {
    const event = mapStreamRow(streamRow());
    expect(event.actorDetail).toEqual({
      principalId: 'bbbbbbbb-0000-4000-8000-000000000001',
      handle: 'agent-1',
      role: 'claimant',
    });
    expect(event.actor).toBe('agent-1');
  });

  test('legacy stream backfill rows with no author yield null attribution — never fabricated', () => {
    const event = mapStreamRow(streamRow({ provenance: 'legacy', author_principal_id: null, author_handle: null, author_role: null, legacy_source: 'task_history', legacy_source_id: '5' }));
    expect(event.actorDetail).toBeNull();
    expect(event.actor).toBeNull();
  });

  test('history rows: display markers are NEVER promoted into structured attribution', () => {
    // changed_by constants and note changedBy= markers are unauthenticated
    // display text. A row without actor_principal_id has NO identity record.
    const pre063 = mapHistoryRow({ id: 1, field: 'status', old_value: 'todo', new_value: 'review', changed_by: 'system', note: null, actor_principal_id: null, created_at: '2026-08-10T00:00:00.000Z' });
    expect(pre063.actor).toBe('system');
    expect(pre063.actorDetail).toBeNull();
    const marker = mapHistoryRow({ id: 3, event_type: 'status', old_value: null, new_value: 'todo', note: 'changedBy=wadera|x', actor_principal_id: null, created_at: '2026-08-10T00:00:00.000Z' });
    expect(marker.actor).toBe('wadera');
    expect(marker.actorDetail).toBeNull();
    // The authenticated 063 column is the ONLY source of the structured
    // record, and it carries no handle claim.
    const newer = mapHistoryRow({ id: 2, event_type: 'status', old_value: null, new_value: 'todo', note: 'changedBy=wadera|x', actor_principal_id: 'cccccccc-0000-4000-8000-000000000001', created_at: '2026-08-10T00:00:00.000Z' });
    expect(newer.actor).toBe('wadera');
    expect(newer.actorDetail).toEqual({ principalId: 'cccccccc-0000-4000-8000-000000000001', handle: null, role: null });
  });

  test('review events carry the trigger category, not a fabricated principal', () => {
    const task = baseTask({ reviewHistory: [{ id: 'r9', decision: 'reject', completedAt: '2026-08-09T00:00:00.000Z', triggeredBy: 'agent' }] });
    const [event] = new UnifiedTaskTimeline().buildReviewEvents(task);
    expect(event.actor).toBe('agent');
    expect(event.actorDetail).toBeNull();
    expect(event.id).toBe('review-r9');
    expect(event.eventType).toBe('review.reject');
  });

  test('synthesized timestamps are stable: sessionRefs use startedAt/created, never updated', () => {
    const task = baseTask({ sessionRefs: ['s1'] });
    const [event] = new UnifiedTaskTimeline().buildSessionEvents(task);
    expect(event.at).toBe('2026-08-02T00:00:00.000Z');
    const neverStarted = baseTask({ sessionRefs: ['s1'], startedAt: null });
    const [fallback] = new UnifiedTaskTimeline().buildSessionEvents(neverStarted);
    expect(fallback.at).toBe('2026-08-01T00:00:00.000Z');
    // review fallback likewise avoids task.updated
    const review = baseTask({ reviewHistory: [{ id: 'r1', decision: 'pass' }] });
    const [reviewEvent] = new UnifiedTaskTimeline().buildReviewEvents(review);
    expect(reviewEvent.at).not.toBe(review.updated);
  });
});

describe('filter taxonomy (§3.6)', () => {
  const classify = (source: any, provenance: any, eventType: string) => timelineView({ source, provenance, eventType });

  test('maps event classes to their ratified views', () => {
    expect(classify('review', 'system', 'review.pass')).toBe('handover');
    expect(classify('session', 'legacy', 'session.reference')).toBe('system');
    expect(classify('history', 'system', 'task.status_changed')).toBe('system');
    expect(classify('stream', 'authored', 'note')).toBe('handover');
    expect(classify('stream', 'reported', 'outpost.progress')).toBe('system');
    expect(classify('stream', 'system', 'handover.finish')).toBe('handover');
    expect(classify('stream', 'system', 'report.promoted')).toBe('handover');
    expect(classify('stream', 'system', 'task.transitioned')).toBe('system');
    expect(classify('stream', 'legacy', 'status')).toBe('system');
  });

  test('report events reach Handovers & reports from EVERY stream provenance (§3.6 row: report created/linked/auto-promoted)', () => {
    expect(classify('stream', 'reported', 'report.created')).toBe('handover');
    expect(classify('stream', 'system', 'report.linked')).toBe('handover');
    expect(classify('stream', 'legacy', 'report.auto_promoted')).toBe('handover');
    expect(classify('stream', 'reported', 'handover.finish')).toBe('handover');
  });

  test('unknown, future, and plugin event types are All-only on every provenance', () => {
    expect(classify('stream', 'system', 'plugin.future')).toBeNull();
    // a FUTURE core verb is unknown until the enumerated set is extended
    expect(classify('stream', 'system', 'task.future_verb')).toBeNull();
    expect(classify('stream', 'system', 'session.future_thing')).toBeNull();
    expect(classify('stream', 'system', 'plugin:acme:thing')).toBeNull();
    expect(classify('stream', 'legacy', 'mystery_event')).toBeNull();
    expect(classify('stream', 'reported', 'weird.new.shape')).toBeNull();
  });

  test('unknown stream types appear under filter=all but under neither named view', () => {
    const task = baseTask();
    const rows = [streamRow({ id: 'aaaaaaaa-0000-4000-8000-000000000021', provenance: 'system', event_type: 'plugin.future', created_at: '2026-08-08T00:00:00.000Z' })];
    expect(unifiedTaskTimeline.merge(task, rows, [], options({ filter: 'all' })).events).toHaveLength(1);
    expect(unifiedTaskTimeline.merge(task, rows, [], options({ filter: 'system' })).events).toHaveLength(0);
    expect(unifiedTaskTimeline.merge(task, rows, [], options({ filter: 'handover' })).events).toHaveLength(0);
  });

  test('filter=handover and filter=system partition known events; unknowns only in all', () => {
    const task = baseTask({ reviewHistory: [{ id: 'r1', decision: 'pass', completedAt: '2026-08-09T00:00:00.000Z' }] });
    const rows = [
      streamRow({ id: 'aaaaaaaa-0000-4000-8000-000000000011', provenance: 'authored', event_type: 'note', created_at: '2026-08-08T00:00:00.000Z' }),
      streamRow({ id: 'aaaaaaaa-0000-4000-8000-000000000012', provenance: 'system', event_type: 'task.claimed', created_at: '2026-08-07T00:00:00.000Z' }),
    ];
    const handover = unifiedTaskTimeline.merge(task, rows, [], options({ filter: 'handover' }));
    expect(handover.events.map(e => e.eventType).sort()).toEqual(['note', 'review.pass']);
    const system = unifiedTaskTimeline.merge(task, rows, [], options({ filter: 'system' }));
    expect(system.events.map(e => e.eventType)).toEqual(['task.claimed']);
  });
});

describe('redaction (§3.6)', () => {
  test('tombstoned entries suppress content and carry the redaction record', () => {
    const event = mapStreamRow(streamRow({ redacted_at: '2026-08-13T00:00:00.000Z', redaction_mode: 'tombstone', content: 'should not surface' }));
    expect(event.description).toBeNull();
    expect(event.redaction).toEqual({ mode: 'tombstone', redactedAt: '2026-08-13T00:00:00.000Z' });
  });

  test('span-redacted entries keep the stored (already-redacted) content', () => {
    const event = mapStreamRow(streamRow({ redacted_at: '2026-08-13T00:00:00.000Z', redaction_mode: 'span', content: 'a [redacted] c' }));
    expect(event.description).toBe('a [redacted] c');
    expect(event.redaction!.mode).toBe('span');
  });
});

describe('additive compatibility with the live modal (§8 C1)', () => {
  test('every event keeps the legacy consumer fields with legacy types', () => {
    const task = baseTask({
      sessionRefs: ['sess-1'],
      reviewHistory: [{ id: 'r1', decision: 'pass', completedAt: '2026-08-11T00:00:00.000Z', triggeredBy: 'system' }],
    });
    const result = unifiedTaskTimeline.merge(task, [streamRow()], [
      { id: 7, field: 'status', old_value: 'todo', new_value: 'review', changed_by: 'system', note: null, actor_principal_id: null, created_at: '2026-08-12T00:00:00.000Z' },
    ], options());
    for (const event of result.events) {
      expect(typeof event.id).toBe('string');
      expect(typeof event.eventType).toBe('string');
      expect(typeof event.title).toBe('string');
      expect(typeof event.createdAt).toBe('string');
      expect(event.createdAt).toBe(event.at);
      // the modal renders `actor` directly into text — string or null only
      expect(event.actor === null || typeof event.actor === 'string').toBe(true);
      expect(event.description === null || typeof event.description === 'string').toBe(true);
      expect(event.metadata && typeof event.metadata).toBe('object');
    }
  });
});

describe('086 dedup SQL and no write path', () => {
  test('history query excludes stream-backfilled rows and only ever SELECTs', async () => {
    const spy = jest.spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [{ column_name: 'id' }, { column_name: 'task_id' }, { column_name: 'event_type' }, { column_name: 'old_value' }, { column_name: 'new_value' }, { column_name: 'note' }, { column_name: 'created_at' }, { column_name: 'actor_principal_id' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    await new UnifiedTaskTimeline().listHistoryNotInStream(TASK_ID);
    const sql = String(spy.mock.calls[1][0]);
    expect(sql).toContain("legacy_source = 'task_history'");
    expect(sql).toContain('legacy_source_id = h.id::text');
    expect(sql).toContain('NOT EXISTS');
    for (const call of spy.mock.calls) {
      expect(String(call[0])).not.toMatch(/\b(insert|update|delete|truncate|alter)\b/i);
    }
    spy.mockRestore();
  });
});
