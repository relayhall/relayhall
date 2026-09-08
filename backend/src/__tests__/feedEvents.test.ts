/**
 * feedEvents.test.ts — RH-P3.C1: the cursor event feed core.
 *
 * Strategy 4e40f06f §2.6: the feed is AUTHORITATIVE. What these tests pin:
 * dotted names are enforced at the door; emission serializes on the advisory
 * lock BEFORE inserting (cursor order = commit order is the property the
 * whole feed stands on); the read is grant-scoped against the calling
 * principal at query time with the two-tier authorization that lets a
 * content-free tombstone outlive its object; and the migration file carries
 * the append-only and content-free rules as constraints, not comments.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeedEventService } from '../services/FeedEventService';
import { requiredScopeFor } from '../utils/scopeMap';

jest.mock('../db/connection', () => ({ pool: { query: jest.fn(async () => ({ rows: [] })) } }));

const BLANKET_PROBE_ID = '00000000-0000-4000-8000-000000000000';
const authState = { blanket: false };
const liveAllowed = new Set<string>();
jest.mock('../services/AuthorizationService', () => ({
  authorizationService: {
    authorizeResource: jest.fn((_actor: unknown, _action: unknown, resource: { id: string }) =>
      ({ allowed: authState.blanket && resource.id === BLANKET_PROBE_ID })),
  },
}));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: {
    authorizedIds: jest.fn(async (_actor: unknown, type: string, ids: string[]) =>
      new Set(ids.filter(id => liveAllowed.has(`${type}:${id}`)))),
  },
}));

const ACTOR = { principalId: 'aaaaaaaa-1111-4111-8111-111111111111', handle: 'scoped', role: 'agent', scopes: ['tasks:read'], authenticated: true } as never;

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';

function feedRow(cursor: number, over: Record<string, unknown> = {}) {
  return {
    cursor: String(cursor), name: 'task.updated', object_type: 'task', object_id: T1,
    occurred_at: '2026-08-21T12:00:00Z', actor_principal_id: null, actor_handle: null,
    project_id: null, owner_principal_id: null, payload: {},
    ...over,
  };
}

describe('FeedEventService.emit — RH-P3.C1', () => {
  test('rejects a name that is not dotted <singular>.<past-tense>', async () => {
    const service = new FeedEventService({ query: jest.fn() } as never);
    const client = { query: jest.fn() } as never;
    // The colon-punctuated hostile input is assembled at runtime because the
    // webhookTaskEventContract tracked-tree sweep rightly refuses any literal
    // colon event name in the repo — including one that exists only to be
    // rejected here.
    const colonName = ['task', 'updated'].join(':');
    await expect(service.emit(client, { name: colonName, objectType: 'task', objectId: T1 }))
      .rejects.toThrow(/dotted/);
    await expect(service.emit(client, { name: 'TaskUpdated', objectType: 'task', objectId: T1 }))
      .rejects.toThrow(/dotted/);
  });

  test('takes the advisory lock BEFORE the insert — cursor order is commit order', async () => {
    const statements: string[] = [];
    const client = { query: jest.fn(async (text: string) => { statements.push(text); return { rows: [] }; }) };
    const service = new FeedEventService({ query: jest.fn() } as never);
    await service.emit(client as never, { name: 'task.created', objectType: 'task', objectId: T1 });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("pg_advisory_xact_lock(hashtext('feed_events'))");
    expect(statements[1]).toContain('INSERT INTO feed_events');
    // The lock is the whole point: without it, two concurrent writers can
    // commit cursors out of order and a reader silently loses an event.
  });
});

describe('FeedEventService.listSince — grant-scoped at query time', () => {
  afterEach(() => { authState.blanket = false; liveAllowed.clear(); });

  const poolWith = (rows: unknown[]) => ({
    query: jest.fn(async (text: string, _params?: unknown[]) => {
      if (/FROM feed_events/i.test(text)) return { rows };
      if (/FROM grants/i.test(text)) return { rows: [] };
      throw new Error(`unexpected: ${text.slice(0, 60)}`);
    }),
  });

  test('an id-independent (blanket) reader sees every event', async () => {
    authState.blanket = true;
    const service = new FeedEventService(poolWith([feedRow(1), feedRow(2, { object_id: T2 })]) as never);
    const { events, nextCursor } = await service.listSince(ACTOR, 0);
    expect(events).toHaveLength(2);
    expect(nextCursor).toBe('2');
  });

  test('a scoped reader sees only events whose LIVE object authorizes read', async () => {
    liveAllowed.add(`task:${T1}`);
    const service = new FeedEventService(poolWith([feedRow(1), feedRow(2, { object_id: T2 })]) as never);
    const { events } = await service.listSince(ACTOR, 0);
    expect(events.map(e => e.objectId)).toEqual([T1]);
  });

  test('a tombstone outlives its object: recorded ownership authorizes delivery', async () => {
    // No live object, no grants — but the event row remembers the owner.
    const service = new FeedEventService(poolWith([
      feedRow(1, { name: 'task.deleted', object_id: T3, owner_principal_id: (ACTOR as { principalId: string }).principalId }),
      feedRow(2, { name: 'task.deleted', object_id: T2, owner_principal_id: 'someone-else' }),
    ]) as never);
    const { events } = await service.listSince(ACTOR, 0);
    expect(events.map(e => e.objectId)).toEqual([T3]);
  });

  test('a current grant row authorizes a tombstone when the object is gone', async () => {
    const pool = {
      query: jest.fn(async (text: string, params?: unknown[]) => {
        if (/FROM feed_events/i.test(text)) {
          return { rows: [feedRow(1, { name: 'report.deleted', object_type: 'report', object_id: T2 })] };
        }
        if (/FROM grants/i.test(text)) {
          expect(params?.[0]).toBe((ACTOR as { principalId: string }).principalId);
          return { rows: [{ resource_type: 'report', resource_id: T2 }] };
        }
        throw new Error('unexpected');
      }),
    };
    const service = new FeedEventService(pool as never);
    const { events } = await service.listSince(ACTOR, 0);
    expect(events.map(e => e.objectId)).toEqual([T2]);
  });

  test('the typed-NULL wildcard grant covers the whole type', async () => {
    const pool = {
      query: jest.fn(async (text: string) => {
        if (/FROM feed_events/i.test(text)) {
          return { rows: [feedRow(1, { name: 'skill.deleted', object_type: 'skill', object_id: T3 })] };
        }
        if (/FROM grants/i.test(text)) return { rows: [{ resource_type: 'skill', resource_id: null }] };
        throw new Error('unexpected');
      }),
    };
    const { events } = await new FeedEventService(pool as never).listSince(ACTOR, 0);
    expect(events).toHaveLength(1);
  });

  test('recorded ownership does NOT deliver an ORDINARY lifecycle event (round 1, F3)', async () => {
    // A former owner keeps their name on old rows; only the content-free
    // transition pair may honor it. task.updated with the actor's recorded
    // ownership but no live authorization stays invisible.
    const pool = poolWith([
      feedRow(1, { owner_principal_id: (ACTOR as { principalId: string }).principalId }),
      feedRow(2, { name: 'task.deleted', object_id: T2, owner_principal_id: (ACTOR as { principalId: string }).principalId }),
    ]);
    const { events } = await new FeedEventService(pool as never).listSince(ACTOR, 0);
    expect(events.map(e => e.objectId)).toEqual([T2]);
  });

  test('ordinary events never consult the grants residue at all (round 1, F3)', async () => {
    const pool = poolWith([feedRow(1), feedRow(2, { object_id: T2 })]);
    const { events } = await new FeedEventService(pool as never).listSince(ACTOR, 0);
    expect(events).toHaveLength(0);
    const grantQueries = pool.query.mock.calls.filter(([text]) => /FROM grants/i.test(text as string));
    expect(grantQueries).toHaveLength(0);
  });

  test('a globally-visible tombstone reaches any authenticated reader (round 1, F4)', async () => {
    // A global Skill was readable by everyone; its deletion must be too —
    // but the same recorded flag buys nothing for an ordinary event.
    const pool = poolWith([
      feedRow(1, { name: 'skill.deleted', object_type: 'skill', object_id: T3, globally_visible: true }),
      feedRow(2, { object_id: T2, globally_visible: true }),
    ]);
    const { events } = await new FeedEventService(pool as never).listSince(ACTOR, 0);
    expect(events.map(e => e.objectId)).toEqual([T3]);
  });

  test('Project authorization delivers tombstones ONLY for project-inheriting types (round 1 F4, round 4 F1)', async () => {
    // Phase authorization inherits parent-Project authority in the live
    // predicate, so a Project reader was entitled to the Phase and gets its
    // tombstone. A Task is claimant/visibility/grant-scoped — a Project
    // reader was NEVER entitled to a private child Task, and content-free is
    // not identity-free: its tombstone stays concealed (round 4, F1).
    const PROJECT = '44444444-4444-4444-8444-444444444444';
    liveAllowed.add(`project:${PROJECT}`);
    const pool = poolWith([
      feedRow(1, { name: 'phase.deleted', object_type: 'phase', object_id: T2, project_id: PROJECT }),
      feedRow(2, { name: 'phase.deleted', object_type: 'phase', object_id: T3, project_id: '55555555-5555-4555-8555-555555555555' }),
      feedRow(3, { name: 'task.deleted', object_id: T1, project_id: PROJECT }),
      feedRow(4, { name: 'report.deleted', object_type: 'report', object_id: T1, project_id: PROJECT }),
      feedRow(5, { object_id: T1, project_id: PROJECT }),
    ]);
    const { events } = await new FeedEventService(pool as never).listSince(ACTOR, 0);
    expect(events.map(e => `${e.name}:${e.objectId}`)).toEqual([`phase.deleted:${T2}`]);
  });

  test('a revoked grantee still receives the content-free acl_changed (round 2, F3)', async () => {
    // Their grant row is gone by read time, so no current-state basis can
    // fire — the event's recorded affected-principal metadata delivers it.
    const pool = poolWith([
      feedRow(1, { name: 'task.acl_changed', object_id: T2, owner_principal_id: (ACTOR as { principalId: string }).principalId }),
      feedRow(2, { name: 'task.acl_changed', object_id: T3, owner_principal_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    ]);
    const { events } = await new FeedEventService(pool as never).listSince(ACTOR, 0);
    expect(events.map(e => e.objectId)).toEqual([T2]);
  });

  test('nextCursor advances past FILTERED rows so a scoped consumer never re-reads them', async () => {
    const service = new FeedEventService(poolWith([feedRow(7, { object_id: T2 })]) as never);
    const { events, nextCursor } = await service.listSince(ACTOR, 5);
    expect(events).toHaveLength(0);
    expect(nextCursor).toBe('7');
  });

  test('a hostile cursor and limit are clamped, never interpolated', async () => {
    const pool = poolWith([]);
    const service = new FeedEventService(pool as never);
    await service.listSince(ACTOR, "1; DROP TABLE feed_events--" as never, 99999);
    const [text, params] = pool.query.mock.calls[0];
    expect(text).not.toContain('DROP');
    expect(params).toEqual(['0', 500]);
  });
});

describe('migration 091 — the ledger contract lives in constraints', () => {
  const sql = readFileSync(join(__dirname, '../migrations/091_feed_events.sql'), 'utf8');

  test('claims slot 091, append-only by trigger, and is not baseline-stamped', () => {
    expect(sql).toContain('CREATE TABLE feed_events');
    expect(sql).toContain('feed_events is append-only');
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON feed_events/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON feed_events/);
    const baseline = readFileSync(join(__dirname, '../migrations/BASELINE'), 'utf8');
    expect(baseline).not.toContain('091_feed_events.sql');
  });

  test('dotted names and content-free tombstones are CHECK constraints, not conventions', () => {
    expect(sql).toContain("name ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'");
    expect(sql).toContain('feed_events_tombstones_content_free');
    expect(sql).toContain("'%.deleted'");
    expect(sql).toContain("'%.acl_changed'");
    expect(sql).toContain("payload = '{}'::jsonb");
  });

  test('the ledger records global visibility at emission time (round 1, F4)', () => {
    expect(sql).toContain('globally_visible BOOLEAN NOT NULL DEFAULT false');
  });
});

describe('FeedEventService.resolveOwnerPrincipalUuid (round 2, F1)', () => {
  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const UUID_B = '22222222-2222-4222-8222-222222222222';
  const service = () => new FeedEventService({ query: jest.fn() } as never);

  test('a UUID-shaped value must PROVE principals.id — a UUID-shaped HANDLE resolves to ITS principal', async () => {
    // String shape is not identity: handles may be UUID-shaped. Round-2 code
    // passed UUID_A straight through, delivering one principal's transition
    // metadata to whoever owned the colliding UUID.
    const idLookups: string[] = [];
    const client = {
      query: jest.fn(async (text: string, params?: unknown[]) => {
        if (/WHERE id = \$1/.test(text)) { idLookups.push(String(params?.[0])); return { rows: [] }; }
        if (/WHERE handle = \$1/.test(text)) {
          expect(params).toEqual([UUID_A]);
          return { rows: [{ id: UUID_B }] };
        }
        return { rows: [] };
      }),
    };
    await expect(service().resolveOwnerPrincipalUuid(client as never, UUID_A)).resolves.toBe(UUID_B);
    expect(idLookups).toEqual([UUID_A]);
  });

  test('a proven principal UUID passes through without a handle lookup', async () => {
    const client = {
      query: jest.fn(async (text: string) => {
        if (/WHERE id = \$1/.test(text)) return { rows: [{ id: UUID_A }] };
        throw new Error('handle lookup must not run for a proven principal id');
      }),
    };
    await expect(service().resolveOwnerPrincipalUuid(client as never, UUID_A)).resolves.toBe(UUID_A);
  });

  test('a plain handle resolves by handle; unknown values record NULL', async () => {
    const client = {
      query: jest.fn(async (text: string, params?: unknown[]) => {
        if (/WHERE handle = \$1/.test(text) && params?.[0] === 'service_account') return { rows: [{ id: UUID_B }] };
        return { rows: [] };
      }),
    };
    await expect(service().resolveOwnerPrincipalUuid(client as never, 'service_account')).resolves.toBe(UUID_B);
    await expect(service().resolveOwnerPrincipalUuid(client as never, 'nobody')).resolves.toBeNull();
    await expect(service().resolveOwnerPrincipalUuid(client as never, null)).resolves.toBeNull();
  });
});

/**
 * ROUND 1 F1 asked that a HANDLE never reach the UUID-typed
 * `owner_principal_id` column, and it never does — but review `99ba9444` B1
 * showed that resolving `author_actor_id` at all was the defect. The column is
 * untagged: a HANDLE from the REST writer, a UUID from the task-finish writer,
 * and the two encodings can collide. The owner is now read from
 * `reports.author_principal_id`, a foreign key to `principals(id)`, so there
 * is nothing to resolve and nothing to arbitrate.
 */
describe('ReportManager owner-principal: the canonical column, or NULL', () => {
  const PRINCIPAL = '99999999-9999-4999-8999-999999999999';

  const archiveWith = async (row: Record<string, unknown>) => {
    const { ReportManager } = require('../services/ReportManager');
    const statements: Array<[string, unknown[] | undefined]> = [];
    const client = {
      query: jest.fn(async (text: string, params?: unknown[]) => {
        statements.push([text, params]);
        if (/UPDATE reports/.test(text)) return { rowCount: 1, rows: [row] };
        if (/FROM principals/.test(text)) throw new Error('the owner is the canonical column: no principal lookup may run');
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    const pool = { connect: async () => client, query: jest.fn(async () => ({ rows: [] })) };
    await new ReportManager(pool as never).archive('some-id');
    return statements;
  };

  test('the emitted owner IS author_principal_id, resolved from nothing', async () => {
    const statements = await archiveWith({ project_id: null, author_principal_id: PRINCIPAL });
    const insert = statements.find(([text]) => /INSERT INTO feed_events/.test(text));
    expect(insert).toBeDefined();
    expect(insert![1]).toContain(PRINCIPAL);
    // The write path reads the canonical column, and the ambiguous provenance
    // string is not even returned to it any more.
    const update = statements.find(([text]) => /UPDATE reports/.test(text))!;
    expect(update[0]).toContain('RETURNING project_id, author_principal_id');
    expect(update[0]).not.toContain('RETURNING project_id, author_actor_id');
  });

  test('a row with no canonical author records NULL — never a guess', async () => {
    // Fail closed. The handle sitting in `author_actor_id` is exactly what
    // must NOT be resolved into an owner: it may be another principal's id.
    const statements = await archiveWith({ project_id: null, author_principal_id: null, author_actor_id: 'service_account' });
    const insert = statements.find(([text]) => /INSERT INTO feed_events/.test(text))!;
    expect(insert[1]).not.toContain('service_account');
    expect(insert[1]).toContain(null);
  });
});

describe('emission coverage — every write path announces itself (round 1, F2/F4/F5)', () => {
  const svc = (file: string) =>
    readFileSync(join(__dirname, '../services/' + file), 'utf8');
  // The body of the method declared by `decl`, sliced to the next named
  // declaration — a structural pin that each repaired path still emits.
  const body = (src: string, decl: string, next: string) => {
    const start = src.indexOf(decl);
    const end = src.indexOf(next, start + decl.length);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  test('TaskManagerDB: claim/release/roles, subtask writes, verdicts, dependencies', () => {
    const src = svc('TaskManagerDB.ts');
    for (const [decl, next] of [
      ['async claimTask(', 'async releaseTask('],
      ['async releaseTask(', 'async recoverTask('],
      // RH-P3.C3: meltdown recovery moves the Task back to todo and
      // reassigns it — two changes every consumer must observe.
      ['async recoverTask(', 'async assignTaskRoles('],
      ['async assignTaskRoles(', 'async queryTasks('],
      ['async updateSubtaskStatus(', 'async updateSubtaskStatusById('],
      ['async updateSubtaskStatusById(', 'async markSubtaskInReview('],
      ['async rejectSubtask(', 'async blockSubtask('],
      ['async resolveReviewedSubtasks(', 'async completeSubtask('],
      ['async addDependency(', 'async removeDependency('],
      ['async removeDependency(', 'async getBlockedTasks('],
    ] as const) {
      expect(body(src, decl, next)).toContain('feedEventService.emit');
    }
  });

  test('ReportManager: archive and unarchive emit report.updated', () => {
    const src = svc('ReportManager.ts');
    expect(body(src, 'async archive(', 'async unarchive(')).toContain('feedEventService.emit');
    expect(body(src, 'async unarchive(', 'async softDelete(')).toContain('feedEventService.emit');
  });

  test('PersonalityService: retireDuplicate announces every repointed Task', () => {
    const src = svc('PersonalityService.ts');
    const b = body(src, 'async retireDuplicate(', 'export const personalityService');
    expect(b).toContain('RETURNING id, project_id, owner_principal_id');
    expect(b).toContain("name: 'task.updated'");
  });

  test('SkillManager: the skill tombstone records global visibility (round 1, F4)', () => {
    expect(svc('SkillManager.ts')).toContain('globallyVisible: current.rows[0].is_global === true');
  });

  test('PhaseService: setRestrictedAccess emits the content-free ACL change (round 1, F5)', () => {
    const src = svc('PhaseService.ts');
    expect(body(src, 'async setRestrictedAccess(', 'async archive(')).toContain("name: 'phase.acl_changed'");
  });

  test('GrantService: both ACL transitions record the affected grantee (round 2, F3)', () => {
    const src = svc('GrantService.ts');
    const line = "ownerPrincipalId: grant.granteeType === 'principal' ? grant.granteeId : null";
    expect(src.split(line).length - 1).toBe(2);
  });

  test('orchestration, element, and review-attempt services all emit (round 2, F2)', () => {
    expect(svc('TaskOrchestrationService.ts'))
      .toContain("payload: { status: 'in-progress', previousStatus: 'todo' }");
    expect(svc('TaskReviewAttemptService.ts'))
      .toContain("payload: { status: nextStatus, previousStatus: 'review' }");
    const element = svc('TaskElementService.ts');
    // createReport, linkReport, stream-entry link, finish→review, redaction.
    expect(element.split('feedEventService.emit').length - 1).toBe(5);
    expect(element).toContain("payload: { status: 'review', previousStatus: 'in-progress' }");
  });
});

describe('emission rides the mutating transaction (round 2, F2 — behavioral)', () => {
  const T1 = '11111111-1111-4111-8111-111111111111';
  const TS = '2026-08-21T12:00:00.000Z';

  const orderOf = (statements: string[]) => ({
    feed: statements.findIndex(s => s.includes('INSERT INTO feed_events')),
    commit: statements.lastIndexOf('COMMIT'),
  });

  test('TaskOrchestrationService.claimReadyTask: claim and event commit together', async () => {
    const { TaskOrchestrationService } = require('../services/TaskOrchestrationService');
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (text: string) => {
        statements.push(text);
        if (/FROM tasks\s+WHERE id = \$1\s+FOR UPDATE/.test(text)) {
          return { rowCount: 1, rows: [{ id: T1, title: 'x', status: 'todo', auto_start: true, updated_at: TS, project_id: null, execution_mode: null, execution_profile: null, archive_disposition: null }] };
        }
        if (/FROM task_execution_leases\s+WHERE task_id/.test(text)) return { rowCount: 0, rows: [] };
        if (/FROM task_dependencies/.test(text)) return { rows: [] };
        if (/COUNT\(\*\)::int AS count/.test(text)) return { rows: [{ count: 0 }] };
        if (/INSERT INTO task_execution_leases/.test(text)) {
          return { rows: [{ id: 'lease-1', task_id: T1, resource_key: 'r1', harness: 'hermes', session_key: null, status: 'active', acquired_at: TS, expires_at: TS, metadata: {} }] };
        }
        if (/UPDATE tasks/.test(text)) return { rowCount: 1, rows: [{ id: T1, project_id: null, owner_principal_id: null }] };
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    const service = new TaskOrchestrationService({ connect: async () => client } as never, { enabled: true });
    const result = await service.claimReadyTask({ taskId: T1, snapshotUpdatedAt: TS, harness: 'hermes', resourceKey: 'r1' });
    expect(result.acquired).toBe(true);
    const { feed, commit } = orderOf(statements);
    const move = statements.findIndex(s => s.includes("SET status = 'in-progress'"));
    expect(feed).toBeGreaterThan(move);
    expect(feed).toBeLessThan(commit);
  });

  test('TaskReviewAttemptService.recordVerdict: verdict and event commit together', async () => {
    const { TaskReviewAttemptService } = require('../services/TaskReviewAttemptService');
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (text: string) => {
        statements.push(text);
        if (/FROM task_review_attempts a JOIN tasks t/.test(text)) {
          return { rowCount: 1, rows: [{ id: 'a1', status: 'running', task_status: 'review', attempt_count: 0, max_retries: 3, current_task_updated_at: TS, task_snapshot_updated_at: TS, review_slice: [{ index: 0 }], task_id: T1 }] };
        }
        if (/UPDATE subtasks/.test(text)) return { rowCount: 1, rows: [{ index: 0 }] };
        if (/SELECT status FROM subtasks/.test(text)) return { rows: [{ status: 'completed' }] };
        if (/UPDATE tasks SET status=\$2/.test(text)) return { rowCount: 1, rows: [{ project_id: null, owner_principal_id: null }] };
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    const service = new TaskReviewAttemptService({ connect: async () => client } as never);
    const outcome = await service.recordVerdict('a1', 'pass', [], { summary: 'ok' });
    expect(outcome).toEqual({ status: 'completed', attemptCount: 0, applied: true });
    const { feed, commit } = orderOf(statements);
    const apply = statements.findIndex(s => s.includes('UPDATE tasks SET status=$2'));
    expect(feed).toBeGreaterThan(apply);
    expect(feed).toBeLessThan(commit);
  });

  test('TaskManagerDB.createTask stamps attribution INSIDE the transaction, before task.created (round 4, F2)', async () => {
    // The authorization predicate reads creator/shepherd_principal_id, so
    // the stored Task must never change after its task.created event — no
    // post-COMMIT stamp a consumer could miss forever.
    const { TaskManagerDB } = require('../services/TaskManagerDB');
    const PRINCIPAL = '99999999-9999-4999-8999-999999999999';
    const TS = '2026-08-21T12:00:00.000Z';
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (text: string) => {
        statements.push(text);
        if (/INSERT INTO tasks/.test(text)) {
          return { rows: [{ id: T1, title: 'attribution probe', status: 'todo', created_at: TS, updated_at: TS }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    const pool = {
      connect: async () => client,
      query: jest.fn(async (text: string) => {
        if (/pg_attribute/.test(text)) return { rows: [{ present: true }] };
        return { rows: [] };
      }),
    };
    const manager = new TaskManagerDB(pool as never);
    await manager.createTask({ title: 'attribution probe' }, { principalId: PRINCIPAL, handle: 'qa-principal', role: 'orchestrator' });
    const stamp = statements.findIndex(s => s.includes('creator_principal_id = $2'));
    const feed = statements.findIndex(s => s.includes('INSERT INTO feed_events'));
    const commit = statements.indexOf('COMMIT');
    expect(stamp).toBeGreaterThan(-1);
    expect(feed).toBeGreaterThan(stamp);
    expect(commit).toBeGreaterThan(feed);
    // Nothing mutates the Task after COMMIT — post-commit statements are reads.
    expect(statements.slice(commit + 1).filter(s => /UPDATE tasks/i.test(s))).toEqual([]);
  });

  test('TaskElementService.createReport and linkReport emit on the same client as the write', async () => {
    const { TaskElementService } = require('../services/TaskElementService');
    const R1 = '33333333-3333-4333-8333-333333333333';
    const PRINCIPAL = '99999999-9999-4999-8999-999999999999';
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (text: string) => {
        statements.push(text);
        if (/INSERT INTO reports/.test(text)) return { rows: [{ id: R1 }], rowCount: 1 };
        if (/FROM principals/.test(text)) return { rows: [{ id: PRINCIPAL }] };
        if (/UPDATE reports/.test(text)) return { rows: [{ id: R1, project_id: null, author_actor_id: null }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const task = { id: T1, title: 't', status: 'in-progress', visibility: 'default', project_id: null, masking_enabled: false, claimant_principal_id: null, shepherd_principal_id: 's', verifier_principal_id: null };
    const actor = { principalId: PRINCIPAL, handle: 'agent' };
    const service = new TaskElementService({} as never) as any;

    const created = await service.createReport(client, task, actor, 'T', 'C', undefined, false, null);
    expect(created).toBe(R1);
    expect(statements.findIndex(s => s.includes('INSERT INTO feed_events')))
      .toBeGreaterThan(statements.findIndex(s => s.includes('INSERT INTO reports')));

    statements.length = 0;
    await service.linkReport(client, task, R1, actor);
    expect(statements.findIndex(s => s.includes('INSERT INTO feed_events')))
      .toBeGreaterThan(statements.findIndex(s => s.includes('UPDATE reports')));
  });
});

describe('the /events surface', () => {
  test('reads under the tasks:read ceiling (A12 Brief precedent), never root-defaulted', () => {
    expect(requiredScopeFor('GET', '/events')).toBe('tasks:read');
    expect(requiredScopeFor('GET', '/events/')).toBe('tasks:read');
    // Anything but a read on this surface stays behind the sentinel: there
    // is no agent-plane write into an append-only ledger.
    expect(requiredScopeFor('POST', '/events')).toBe('root');
  });
});
