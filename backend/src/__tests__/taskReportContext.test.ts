/**
 * taskReportContext.test.ts — card 50b5e9c4 slice 3: the bounded Task Report
 * context, measured where its inputs can be controlled.
 *
 *  - the pure contract: request validation, the keyset cursor, the guidance;
 *  - `compileTaskReportContext` over controlled candidates, grants and
 *    metadata: newest-first order, the authorized total, a stable cursor walk
 *    that returns every authorized Report exactly once, pinned evidence
 *    deduplicated from the page and bounded, unreadable Reports neither listed
 *    nor counted, the promotion narrowings, fail-closed without an actor;
 *  - the REST route over the production router: summaries only, typed 400s;
 *  - round-1 B1: this Task's own progress Reports carry their content hash in
 *    a summary, and `GET /tasks/:id/reports/:reportId` serves one of them in
 *    full under Task read authority, through the same checks — and nothing
 *    else.
 *
 * The MCP rendering is measured in mcpTaskReportContext.test.ts.
 *
 * The authorized COUNT over real rows and two principals is measured against
 * PostgreSQL in taskReportContextLive.test.ts.
 */
import express from 'express';
import type { AddressInfo } from 'net';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const fixture = {
  linked: [] as string[],
  progress: [] as string[],
  readable: new Set<string>(),
  readableTasks: new Set<string>(),
  rows: new Map<string, Record<string, unknown>>(),
  /** Rows the assigned-only tier withholds. */
  tierWithheld: new Set<string>(),
  /** Full rows (bodies) the progress-Report read would return. */
  full: new Map<string, Record<string, unknown>>(),
};

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() },
}));
jest.mock('../services/TaskManagerDB', () => {
  const actual = jest.requireActual('../services/TaskManagerDB');
  return {
    ...actual,
    taskManagerDB: {
      queryLinkedReports: jest.fn(async (ids: string[]) => (ids.includes(TASK_ID)
        ? fixture.linked.map((id) => ({ id, taskId: TASK_ID, title: 'linked' }))
        : [])),
      getTask: jest.fn(async () => undefined),
      getBlockingTasks: jest.fn(async () => []),
    },
  };
});
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: {
    authorizedIds: jest.fn(async (_actor: unknown, type: string, ids: string[]) => new Set(ids.filter((id) =>
      (type === 'report' ? fixture.readable : fixture.readableTasks).has(id)))),
  },
}));
jest.mock('../services/ReportManager', () => ({
  // The registry's import chain reads REPORT_TEXT_LIMITS at load time; keep
  // every sibling export and replace only the singleton.
  ...jest.requireActual('../services/ReportManager'),
  reportManager: {
    getContextRows: jest.fn(async (ids: string[]) => ids
      .map((id) => fixture.rows.get(id))
      .filter((row): row is Record<string, unknown> => Boolean(row))),
    getBriefProjections: jest.fn(async () => []),
  },
}));
jest.mock('../services/TaskElementService', () => {
  const actual = jest.requireActual('../services/TaskElementService');
  return {
    ...actual,
    taskElementService: {
      taskReportIds: jest.fn(async () => fixture.progress),
      taskProgressReport: jest.fn(async (_taskId: string, id: string) => fixture.full.get(id) ?? null),
      filterPromotedReports: jest.fn(async (rows: Array<{ id: string }>) => rows.filter((row) => !fixture.tierWithheld.has(row.id))),
    },
  };
});
jest.mock('../services/taskAnalyzer', () => ({ taskAnalyzer: {} }));
jest.mock('../services/TaskReviewerService', () => ({ taskReviewerService: {} }));
jest.mock('../services/TaskOrchestrationService', () => ({
  taskOrchestrationService: {},
  OrchestrationConflictError: class extends Error { },
}));
jest.mock('../services/DiscordThreadService', () => ({ discordThreadService: {} }));
jest.mock('../services/TaskHistoryService', () => ({ taskHistoryService: { recordChange: jest.fn() } }));
jest.mock('../services/TaskNotificationService', () => ({ taskNotificationService: {} }));
jest.mock('../services/CanonicalRuntimeSignalService', () => ({ canonicalRuntimeSignalService: {} }));
jest.mock('../services/PrincipalService', () => ({ principalService: {} }));
jest.mock('../services/UnifiedTaskTimeline', () => ({ unifiedTaskTimeline: {}, decodeCursor: jest.fn() }));

import tasksRouter from '../routes/tasks';
import {
  compileTaskReportContext,
  decodeReportCursor,
  encodeReportCursor,
  parseReportContextRequest,
  readTaskProgressReport,
  reportContextGuidance,
  ReportContextRequestError,
  REPORT_CONTEXT_PINNED_LIMIT,
  type TaskReportContext,
} from '../services/TaskReportContext';
import { reportManager } from '../services/ReportManager';
import { taskManagerDB } from '../services/TaskManagerDB';
import { taskElementService } from '../services/TaskElementService';

const ACTOR = { principalId: '99999999-9999-4999-8999-999999999999', handle: 'reader', role: null, scopes: ['tasks:read'], authenticated: true };

const idOf = (n: number): string => `22222222-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Report n: created at second n (so a higher n is newer), unless `createdKey` is given. */
function addReport(n: number, over: Record<string, unknown> = {}): string {
  const id = idOf(n);
  const createdKey = (over.created_key as string | undefined)
    ?? `2026-10-01T00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000000Z`;
  fixture.rows.set(id, {
    id, title: `Report ${n}`, status: 'active', summary: `summary ${n}`, pinned: false, origin: 'api',
    auto_promoted: false, source_task_id: null, source_outpost_visibility_tier: null,
    author_principal_id: null, has_handover: false,
    created_key: createdKey, created_at: createdKey, updated_at: createdKey, ...over,
  });
  fixture.linked.push(id);
  fixture.readable.add(id);
  return id;
}

beforeEach(() => {
  fixture.linked = [];
  fixture.progress = [];
  fixture.readable = new Set();
  fixture.readableTasks = new Set();
  fixture.rows = new Map();
  fixture.tierWithheld = new Set();
  fixture.full = new Map();
  jest.clearAllMocks();
});
afterEach(() => jest.restoreAllMocks());

/** Follow nextCursor to the end; every id served, in order. */
async function walk(limit: number, extra: Record<string, unknown> = {}): Promise<{ ids: string[]; pages: TaskReportContext[] }> {
  const pages: TaskReportContext[] = [];
  let cursor: string | null = null;
  do {
    const page: TaskReportContext = await compileTaskReportContext(TASK_ID, ACTOR, { limit, cursor, ...extra });
    pages.push(page);
    cursor = page.pagination.nextCursor;
    expect(pages.length).toBeLessThan(100);
  } while (cursor);
  return { ids: pages.flatMap((page) => page.reports.map((report) => report.id)), pages };
}

describe('the pure contract', () => {
  test('requests are validated once, with typed codes', () => {
    expect(parseReportContextRequest({})).toEqual({});
    expect(parseReportContextRequest({ scope: 'progress', limit: '7', pinned: 'true' }))
      .toEqual({ scope: 'progress', limit: 7, pinnedOnly: true });
    const refusals: Array<[Record<string, unknown>, string, string]> = [
      [{ scope: 'everything' }, 'INVALID_REPORT_SCOPE', 'scope'],
      [{ limit: '0' }, 'INVALID_REPORT_PAGE', 'limit'],
      [{ limit: '51' }, 'INVALID_REPORT_PAGE', 'limit'],
      [{ limit: '2.5' }, 'INVALID_REPORT_PAGE', 'limit'],
      [{ limit: ['1', '2'] }, 'INVALID_REPORT_PAGE', 'limit'],
      [{ offset: '-1' }, 'INVALID_REPORT_PAGE', 'offset'],
      [{ cursor: '' }, 'INVALID_REPORT_CURSOR', 'cursor'],
      [{ cursor: 'rc1.x', offset: '3' }, 'INVALID_REPORT_PAGE', 'offset'],
      [{ pinned: 'yes' }, 'INVALID_REPORT_PAGE', 'pinned'],
    ];
    for (const [input, code, field] of refusals) {
      let caught: unknown;
      try { parseReportContextRequest(input); } catch (error) { caught = error; }
      expect([JSON.stringify(input), caught instanceof ReportContextRequestError, (caught as ReportContextRequestError)?.code, (caught as ReportContextRequestError)?.field])
        .toEqual([JSON.stringify(input), true, code, field]);
      expect((caught as ReportContextRequestError).status).toBe(400);
    }
  });

  test('the cursor round-trips, and is refused for another scope, pinned mode or shape', () => {
    const position = { createdKey: '2026-10-01T00:00:01.123456Z', id: idOf(1) };
    const cursor = encodeReportCursor('linked', false, position);
    expect(decodeReportCursor(cursor, 'linked', false)).toEqual(position);
    for (const [value, scope, pinned] of [
      [cursor, 'progress', false], [cursor, 'linked', true], ['rc1.not-json', 'linked', false],
      ['offset=5', 'linked', false], [`rc1.${Buffer.from('{"s":"linked","p":0,"c":"yesterday","i":"x"}').toString('base64url')}`, 'linked', false],
      [`rc1.${'A'.repeat(600)}`, 'linked', false],
    ] as Array<[string, 'linked' | 'progress', boolean]>) {
      expect(() => decodeReportCursor(value, scope, pinned)).toThrow(ReportContextRequestError);
    }
  });

  test('the guidance names the real tool, route and flag, and says when nothing is left', () => {
    const base = {
      taskId: TASK_ID, scope: 'linked' as const, pinnedOnly: false,
      pinned: { reports: [], total: 0, returned: 0, hasMore: false },
    };
    const more = reportContextGuidance({ ...base, pagination: { limit: 5, offset: 0, total: 12, returned: 5, hasMore: true, nextCursor: 'rc1.abc' } });
    expect(more).toContain('7 more authorized Report summaries');
    expect(more).toContain(`relayhall_task_report_list {"task":"${TASK_ID}","cursor":"rc1.abc"}`);
    expect(more).toContain(`GET /api/tasks/${TASK_ID}/reports?cursor=rc1.abc`);
    expect(more).toContain(`relayhall task-reports ${TASK_ID} --all`);
    expect(more).toContain('relayhall_report_get');
    // Round-1 B1: with no progress Report in view, the line names the Report read only ...
    expect(more).not.toContain('relayhall_task_report_get');
    // ... and with one in view it also names the Task-authority body read, on every surface.
    const progressSummary = {
      id: idOf(1), title: 'progress', status: 'active' as const, relevance: 'progress' as const, pinned: false, origin: 'task-report',
      createdAt: null, updatedAt: null, summary: null, authorPrincipalId: null, hasStructuredHandover: false, contentHash: 'b'.repeat(64),
    };
    const withProgress = reportContextGuidance({ ...base, reports: [progressSummary], pagination: { limit: 5, offset: 0, total: 1, returned: 1, hasMore: false, nextCursor: null } });
    expect(withProgress).toContain('relayhall_task_report_get');
    expect(withProgress).toContain(`GET /api/tasks/${TASK_ID}/reports/{reportId}`);
    expect(withProgress).toContain(`relayhall task-reports ${TASK_ID} --report REPORT_ID`);
    const mcp = reportContextGuidance({ ...base, scope: 'progress', pagination: { limit: 5, offset: 0, total: 12, returned: 5, hasMore: true, nextCursor: 'rc1.abc' } }, 'mcp');
    expect(mcp).toContain(`relayhall_task_report_list with {"task":"${TASK_ID}","scope":"progress","cursor":"rc1.abc"}`);
    expect(mcp).not.toContain('GET /api');
    expect(mcp).toContain(`relayhall_task_report_get {"task":"${TASK_ID}","reportId":"<id>"} (tasks:read)`);
    expect(reportContextGuidance({ ...base, pagination: { limit: 5, offset: 0, total: 3, returned: 3, hasMore: false, nextCursor: null } }))
      .toContain('All 3 authorized Report summaries are listed.');
    expect(reportContextGuidance({ ...base, pagination: { limit: 5, offset: 0, total: 0, returned: 0, hasMore: false, nextCursor: null } }))
      .toContain('No authorized Reports in this scope.');
  });
});

describe('compileTaskReportContext', () => {
  test('defaults to the five newest authorized summaries, newest first, never a body', async () => {
    for (let n = 1; n <= 12; n += 1) addReport(n);
    const context = await compileTaskReportContext(TASK_ID, ACTOR);
    expect(context.reports.map((report) => report.id)).toEqual([12, 11, 10, 9, 8].map(idOf));
    expect(context.pagination).toMatchObject({ limit: 5, offset: 0, total: 12, returned: 5, hasMore: true });
    expect(typeof context.pagination.nextCursor).toBe('string');
    expect(JSON.stringify(context)).not.toContain('"content"');
    expect(context.retrieval).toContain('7 more authorized Report summaries');
  });

  test('a creation-instant tie is broken by id, so the order is total', async () => {
    const tie = '2026-10-01T00:00:00.000001Z';
    addReport(3, { created_key: tie });
    addReport(1, { created_key: tie });
    addReport(2, { created_key: tie });
    const context = await compileTaskReportContext(TASK_ID, ACTOR, { limit: 2 });
    expect(context.reports.map((report) => report.id)).toEqual([idOf(3), idOf(2)]);
    const rest = await compileTaskReportContext(TASK_ID, ACTOR, { limit: 2, cursor: context.pagination.nextCursor });
    expect(rest.reports.map((report) => report.id)).toEqual([idOf(1)]);
  });

  test('a cursor walk serves every authorized Report exactly once and ends with a null cursor', async () => {
    for (let n = 1; n <= 23; n += 1) addReport(n);
    const { ids, pages } = await walk(7);
    expect(ids).toEqual(Array.from({ length: 23 }, (_, index) => idOf(23 - index)));
    expect(pages.map((page) => page.pagination.offset)).toEqual([0, 7, 14, 21]);
    expect(pages[pages.length - 1].pagination).toMatchObject({ hasMore: false, nextCursor: null, returned: 2 });
    expect(pages[pages.length - 1].retrieval).toContain('Last page: 23 authorized Report summaries in all.');
  });

  test('the cursor is stable: Reports created after the first page never shift a later page', async () => {
    for (let n = 1; n <= 10; n += 1) addReport(n);
    const first = await compileTaskReportContext(TASK_ID, ACTOR, { limit: 4 });
    addReport(50); // newer than everything served so far
    addReport(51);
    const second = await compileTaskReportContext(TASK_ID, ACTOR, { limit: 4, cursor: first.pagination.nextCursor });
    expect(second.reports.map((report) => report.id)).toEqual([6, 5, 4, 3].map(idOf));
    // The positional alternative would have shifted by two.
    const shifted = await compileTaskReportContext(TASK_ID, ACTOR, { limit: 4, offset: 4 });
    expect(shifted.reports.map((report) => report.id)).toEqual([8, 7, 6, 5].map(idOf));
    expect(second.pagination.total).toBe(12);
  });

  test('a Report the caller cannot read is neither listed nor counted, anywhere in the envelope', async () => {
    for (let n = 1; n <= 9; n += 1) addReport(n, { pinned: n === 2 });
    const hidden = [idOf(9), idOf(4), idOf(2)];
    for (const id of hidden) fixture.readable.delete(id);
    const context = await compileTaskReportContext(TASK_ID, ACTOR, { limit: 50 });
    expect(context.pagination.total).toBe(6);
    expect(context.pinned.total).toBe(0);
    const text = JSON.stringify(context);
    for (const id of hidden) expect(text).not.toContain(id);
    // Metadata was read only for readable ids.
    expect((reportManager.getContextRows as jest.Mock).mock.calls[0][0]).not.toEqual(expect.arrayContaining([idOf(9)]));
  });

  test('pinned evidence is listed separately, deduplicated from the page and bounded', async () => {
    for (let n = 1; n <= 20; n += 1) addReport(n, { pinned: [19, 12, 9, 6, 3].includes(n) });
    const context = await compileTaskReportContext(TASK_ID, ACTOR);
    // 19 is on the page (20..16): it is not repeated in the pinned selection.
    expect(context.reports.map((report) => report.id)).toContain(idOf(19));
    expect(context.reports.find((report) => report.id === idOf(19))?.relevance).toBe('pinned');
    expect(context.pinned.reports.map((report) => report.id)).toEqual([12, 9, 6].map(idOf));
    expect(context.pinned).toMatchObject({ total: 5, returned: REPORT_CONTEXT_PINNED_LIMIT, hasMore: true });
    expect(context.retrieval).toContain('More pinned Reports');
    // pinned=true pages through the pinned Reports alone; no second selection.
    const pinnedOnly = await walk(2, { pinnedOnly: true });
    expect(pinnedOnly.ids).toEqual([19, 12, 9, 6, 3].map(idOf));
    expect(pinnedOnly.pages[0].pinned.reports).toEqual([]);
    expect(pinnedOnly.pages[0].pagination.total).toBe(5);
  });

  test('relevance distinguishes progress, handover, stream and plain links', async () => {
    addReport(1, { origin: 'task-report', source_task_id: TASK_ID });
    addReport(2, { origin: 'task-finish' });
    addReport(3, { origin: 'task-finish', auto_promoted: true, source_task_id: TASK_ID });
    addReport(4);
    fixture.readableTasks.add(TASK_ID);
    const context = await compileTaskReportContext(TASK_ID, ACTOR);
    expect(context.reports.map((report) => report.relevance)).toEqual(['linked', 'stream', 'handover', 'progress']);
  });

  test('the promotion narrowings of a point read apply: hidden source Task and assigned-only tier', async () => {
    const otherTask = '33333333-3333-4333-8333-333333333333';
    addReport(1, { auto_promoted: true, source_task_id: otherTask });
    addReport(2, { auto_promoted: true, source_task_id: TASK_ID, source_outpost_visibility_tier: 'assigned-only' });
    addReport(3);
    fixture.readableTasks.add(TASK_ID);
    fixture.tierWithheld.add(idOf(2));
    const context = await compileTaskReportContext(TASK_ID, ACTOR);
    expect(context.reports.map((report) => report.id)).toEqual([idOf(3)]);
    expect(context.pagination.total).toBe(1);
    expect(taskElementService.filterPromotedReports).toHaveBeenCalledWith(
      expect.any(Array), expect.objectContaining({ principalId: ACTOR.principalId, root: false }),
    );
  });

  test('no actor fails closed: nothing is read, listed or counted', async () => {
    for (let n = 1; n <= 3; n += 1) addReport(n);
    const context = await compileTaskReportContext(TASK_ID, null);
    expect(context.pagination).toMatchObject({ total: 0, returned: 0, hasMore: false, nextCursor: null });
    expect(taskManagerDB.queryLinkedReports).not.toHaveBeenCalled();
    expect(reportManager.getContextRows).not.toHaveBeenCalled();
  });

  test('scope progress reads the task-bound candidates, not the association union', async () => {
    addReport(1);
    const progressId = addReport(2, { origin: 'task-report', source_task_id: TASK_ID });
    fixture.progress = [progressId];
    const context = await compileTaskReportContext(TASK_ID, ACTOR, { scope: 'progress' });
    expect(context.reports.map((report) => report.id)).toEqual([progressId]);
    expect(taskManagerDB.queryLinkedReports).not.toHaveBeenCalled();
    expect(context.scope).toBe('progress');
  });

  test('a summary carries the content hash only for this Task\'s own progress Reports', async () => {
    const plain = addReport(1, { content_hash: 'a'.repeat(64) });
    const progress = addReport(2, { origin: 'task-report', source_task_id: TASK_ID, content_hash: 'b'.repeat(64) });
    // Server-bound to this Task, but its genuine Reference is gone: no longer a progress Report.
    const unbound = addReport(3, { origin: 'task-report', source_task_id: TASK_ID, content_hash: 'c'.repeat(64) });
    const foreign = addReport(4, { origin: 'task-report', source_task_id: '33333333-3333-4333-8333-333333333333', content_hash: 'd'.repeat(64) });
    fixture.progress = [progress];
    const context = await compileTaskReportContext(TASK_ID, ACTOR);
    expect(Object.fromEntries(context.reports.map((report) => [report.id, report.contentHash])))
      .toEqual({ [plain]: null, [progress]: 'b'.repeat(64), [unbound]: null, [foreign]: null });
    expect(JSON.stringify(context)).not.toContain('"content"');
    const scoped = await compileTaskReportContext(TASK_ID, ACTOR, { scope: 'progress' });
    expect(scoped.reports.map((report) => [report.id, report.contentHash])).toEqual([[progress, 'b'.repeat(64)]]);
  });

  test('a Task with no task-report rows reads no progress binding for its summaries', async () => {
    for (let n = 1; n <= 3; n += 1) addReport(n, { content_hash: 'e'.repeat(64) });
    const context = await compileTaskReportContext(TASK_ID, ACTOR);
    expect(context.reports.every((report) => report.contentHash === null)).toBe(true);
    expect(taskElementService.taskReportIds).not.toHaveBeenCalled();
  });

  test('a page larger than the hard cap and a foreign cursor are refused before any read', async () => {
    addReport(1);
    await expect(compileTaskReportContext(TASK_ID, ACTOR, { limit: 51 })).rejects.toMatchObject({ code: 'INVALID_REPORT_PAGE' });
    const foreign = encodeReportCursor('progress', false, { createdKey: '2026-10-01T00:00:00.000000Z', id: idOf(1) });
    await expect(compileTaskReportContext(TASK_ID, ACTOR, { cursor: foreign })).rejects.toMatchObject({ code: 'INVALID_REPORT_CURSOR' });
    expect(taskManagerDB.queryLinkedReports).not.toHaveBeenCalled();
  });
});

describe('readTaskProgressReport (round-1 B1)', () => {
  test('serves one of this Task\'s readable progress Reports in full, and nothing else', async () => {
    const progress = addReport(1, { origin: 'task-report', source_task_id: TASK_ID, content_hash: 'b'.repeat(64) });
    const linkedOnly = addReport(2);
    const unreadable = addReport(3, { origin: 'task-report', source_task_id: TASK_ID });
    const withheld = addReport(4, { origin: 'task-report', source_task_id: TASK_ID, auto_promoted: true });
    fixture.progress = [progress, unreadable, withheld];
    fixture.readable.delete(unreadable);
    fixture.readableTasks.add(TASK_ID);
    fixture.tierWithheld.add(withheld);
    for (const id of [progress, linkedOnly, unreadable, withheld]) fixture.full.set(id, { id, content: `BODY ${id}`, content_hash: 'h' });
    expect(await readTaskProgressReport(TASK_ID, progress, ACTOR)).toEqual({ id: progress, content: `BODY ${progress}`, content_hash: 'h' });
    // Linked but not a progress Report; unreadable; withheld by a promotion narrowing; no actor.
    for (const id of [linkedOnly, unreadable, withheld]) expect([id, await readTaskProgressReport(TASK_ID, id, ACTOR)]).toEqual([id, null]);
    expect(await readTaskProgressReport(TASK_ID, progress, null)).toBeNull();
    // The full row is read only after every check passed, and only for the served Report.
    expect((taskElementService.taskProgressReport as jest.Mock).mock.calls).toEqual([[TASK_ID, progress]]);
  });
});

describe('GET /tasks/:id/reports over the production router', () => {
  let server: ReturnType<typeof express.application.listen>;
  let base: string;
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).principal = { id: ACTOR.principalId, handle: ACTOR.handle };
      (req as any).scopes = ['tasks:read'];
      (req as any).userId = ACTOR.handle;
      next();
    });
    app.use('/tasks', tasksRouter);
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  afterAll((done) => { server.close(() => done()); });

  test('answers the bounded envelope: summaries, counts, cursor and guidance, no bodies', async () => {
    for (let n = 1; n <= 8; n += 1) addReport(n);
    const response = await fetch(`${base}/tasks/${TASK_ID}/reports`);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.reports).toHaveLength(5);
    expect(body.pagination).toMatchObject({ limit: 5, offset: 0, total: 8, returned: 5, hasMore: true });
    expect(body.retrieval).toContain('3 more authorized Report summaries');
    for (const report of body.reports) expect(Object.keys(report)).not.toContain('content');
    const next = await fetch(`${base}/tasks/${TASK_ID}/reports?cursor=${encodeURIComponent(body.pagination.nextCursor)}`);
    const nextBody = await next.json() as any;
    expect(nextBody.reports.map((report: { id: string }) => report.id)).toEqual([3, 2, 1].map(idOf));
    expect(nextBody.pagination).toMatchObject({ offset: 5, hasMore: false, nextCursor: null });
  });

  test('GET /tasks/:id/reports/:reportId serves a readable progress Report in full; anything else is one 404', async () => {
    const progress = addReport(1, { origin: 'task-report', source_task_id: TASK_ID, content_hash: 'b'.repeat(64) });
    const linkedOnly = addReport(2, { content_hash: 'c'.repeat(64) });
    fixture.progress = [progress];
    fixture.full.set(progress, { id: progress, title: 'Report 1', content: 'PROGRESS BODY', content_hash: 'b'.repeat(64) });
    fixture.full.set(linkedOnly, { id: linkedOnly, title: 'Report 2', content: 'LINKED BODY', content_hash: 'c'.repeat(64) });
    const list = await (await fetch(`${base}/tasks/${TASK_ID}/reports`)).json() as any;
    expect(list.reports.map((report: { id: string; contentHash: string | null }) => [report.id, report.contentHash]))
      .toEqual([[linkedOnly, null], [progress, 'b'.repeat(64)]]);
    const served = await fetch(`${base}/tasks/${TASK_ID}/reports/${progress.toUpperCase()}`);
    const body = await served.json() as any;
    expect([served.status, body.success, body.taskId, body.report.content, body.report.content_hash])
      .toEqual([200, true, TASK_ID, 'PROGRESS BODY', 'b'.repeat(64)]);
    const refused = await fetch(`${base}/tasks/${TASK_ID}/reports/${linkedOnly}`);
    const refusedText = await refused.text();
    expect([refused.status, JSON.parse(refusedText).code]).toEqual([404, 'TASK_REPORT_NOT_FOUND']);
    expect(refusedText).not.toContain('LINKED BODY');
    const malformed = await fetch(`${base}/tasks/${TASK_ID}/reports/not-a-report`);
    const malformedBody = await malformed.json() as any;
    expect([malformed.status, malformedBody.code, malformedBody.details?.field]).toEqual([400, 'INVALID_REPORT_ID', 'reportId']);
  });

  test('a malformed page request is a typed 400 naming the field', async () => {
    for (const [query, code, field] of [
      ['cursor=garbage', 'INVALID_REPORT_CURSOR', 'cursor'],
      ['limit=500', 'INVALID_REPORT_PAGE', 'limit'],
      ['scope=all', 'INVALID_REPORT_SCOPE', 'scope'],
    ]) {
      const response = await fetch(`${base}/tasks/${TASK_ID}/reports?${query}`);
      const body = await response.json() as any;
      expect([query, response.status, body.code, body.details?.field]).toEqual([query, 400, code, field]);
    }
  });
});
