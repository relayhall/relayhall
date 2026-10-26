/**
 * scaleReadContracts.test.ts — candidate A3 (design 986be411 §5; runbook
 * daf703a6 §4-A3). Drives the PRODUCTION middleware chain
 * (sharedAuthorizationMiddleware → tasksRouter) for the two new collection
 * reads and pins:
 *   - reachability (classifier treats aggregates/graph as collections);
 *   - grant narrowing (counts and nodes computed over the authorized set —
 *     a count and an id are both disclosures);
 *   - enumerated parameters (statuses, groupBy, lod, strict updatedSince);
 *   - ETag / If-None-Match 304 and the updatedSince delta with fullCount;
 *   - the fixed-query N+1-free property of the service reads;
 *   - the board's perColumn default of 50 with the documented offset
 *     decision.
 */
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const IN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OUT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// Phase identity for the Map band chips (card 8645e81c, design 77950a97 §3).
// PHASE_OPEN is readable; PHASE_RESTRICTED is NOT, and is deliberately hung
// off an AUTHORIZED task so the test proves visibility is decided by the
// authorization predicate, never inherited from a Task the caller can see
// (owner ruling 44ee41f2 restricted_access).
const PHASE_OPEN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PHASE_RESTRICTED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
// §3 taxonomy: a readable report and one the caller may NOT read, both
// hung off AUTHORIZED tasks — so the test proves report visibility is
// decided per Report, never inherited from the task that cites it.
const REPORT_OPEN = '11111111-1111-4111-8111-111111111111';
const REPORT_SECRET = '22222222-2222-4222-8222-222222222222';

const poolQuery: jest.Mock = jest.fn(async () => ({ rows: [] as any[] }));
jest.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args), connect: jest.fn() },
}));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: {
    authorizedIds: jest.fn(async (_a: unknown, _t: unknown, ids: string[]) =>
      ids.filter(id => id !== OUT_C && id !== PHASE_RESTRICTED && id !== REPORT_SECRET)),
    authorizePoint: jest.fn(async () => ({ allowed: true, exists: true })),
    // Card 08f42f36: the board narrows in its own WHERE, so the route asks for
    // the LIST-SCOPE form of the shared predicate. This suite mocks the query
    // layer wholesale, so the scope only has to be well formed here; what it
    // narrows is measured against a real PostgreSQL in listPointParity.
    listScope: jest.fn(() => ({
      type: 'task',
      from: 'tasks t',
      render: () => ({ sql: 'TRUE', params: [] as unknown[] }),
    })),
  },
}));
jest.mock('../services/AuthorizationService', () => ({
  authorizationService: {
    authorizeRoute: jest.fn(() => ({ allowed: true })),
    authorizeResource: jest.fn(() => ({ allowed: false })),
  },
}));

const row = (
  id: string, status: string, project: string | null, updated: string,
  title = 't', phaseId: string | null = null, agent: string | null = null,
) => ({
  id, title, status, priority: 'normal', project, phaseId, updated, agent,
});
const scopeRowsSpy: jest.Mock = jest.fn(async () => [
  row(IN_A, 'completed', 'RelayHall', '2026-08-15T10:00:00.000Z', 'alpha', PHASE_OPEN, 'Scout'),
  row(IN_B, 'in-progress', 'RelayHall', '2026-08-15T12:00:00.000Z', 'beta', PHASE_RESTRICTED),
  row(OUT_C, 'completed', 'Hidden', '2026-08-15T13:00:00.000Z', 'gamma', PHASE_OPEN),
]);
// Mutable so a test can rename a phase without touching any task row.
let phaseFixtures = [
  { id: PHASE_OPEN, name: 'Cutover', goal: 'Zero-downtime switch', projectId: 'proj-1', position: 0 },
  { id: PHASE_RESTRICTED, name: 'Sealed', goal: 'Confidential', projectId: 'proj-1', position: 1 },
];
const phaseSummariesSpy: jest.Mock = jest.fn(async (ids: string[]) =>
  phaseFixtures.filter(phase => ids.includes(phase.id)));
let progressFixtures = [{ taskId: IN_A, done: 2, total: 5 }];
const progressSpy: jest.Mock = jest.fn(async (ids: string[]) =>
  progressFixtures.filter(row => ids.includes(row.taskId)));
let reportFixtures = [
  { id: REPORT_OPEN, taskId: IN_A, title: 'Readable report' },
  { id: REPORT_SECRET, taskId: IN_B, title: 'Sealed report' },
];
const REPORT_FIXTURES_BASE = reportFixtures;
const linkedReportsSpy: jest.Mock = jest.fn(async (ids: string[]) =>
  reportFixtures.filter(row => ids.includes(row.taskId)));
/** Tasks whose SUBTASKS moved without their task row moving. Empty unless a
 *  test is specifically exercising the progress delta channel. */
let progressChangedFixtures: string[] = [];
const progressChangedSpy: jest.Mock = jest.fn(async (ids: string[]) =>
  progressChangedFixtures.filter(id => ids.includes(id)));
/** The edge fixtures, and the shape of the real reads: `queryDependencyEdges`
 *  and `queryKnowledgeEdges` return edges whose BOTH endpoints are in the ids
 *  they were handed. A mock that ignored its ids would hand an empty scope two
 *  edges over Tasks the route never listed — the query layer never does. */
const DEP_EDGES = [{ from: IN_B, to: IN_A }];
const KNOW_EDGES = [{ from: IN_A, to: IN_B }];
const edgesWithin = (edges: Array<{ from: string; to: string }>, ids: string[]) =>
  edges.filter(edge => ids.includes(edge.from) && ids.includes(edge.to));
const depEdgesSpy: jest.Mock = jest.fn(async (ids: string[]) => edgesWithin(DEP_EDGES, ids));
const knowEdgesSpy: jest.Mock = jest.fn(async (ids: string[]) => edgesWithin(KNOW_EDGES, ids));
const boardSpy: jest.Mock = jest.fn(async () => ({ columns: {} }));
jest.mock('../services/TaskManagerDB', () => ({
  ...(jest.requireActual('../services/TaskManagerDB') as Record<string, unknown>),
  taskManagerDB: {
    queryScopeRows: (...args: unknown[]) => scopeRowsSpy(...args),
    queryDependencyEdges: (...args: unknown[]) => depEdgesSpy(...args),
    queryKnowledgeEdges: (...args: unknown[]) => knowEdgesSpy(...args),
    queryPhaseSummaries: (...args: unknown[]) => phaseSummariesSpy(...args),
    queryTaskProgress: (...args: unknown[]) => progressSpy(...args),
    queryLinkedReports: (...args: unknown[]) => linkedReportsSpy(...args),
    queryProgressChangedSince: (...args: unknown[]) => progressChangedSpy(...args),
    queryBoardColumns: (...args: unknown[]) => boardSpy(...args),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tasksRouter = require('../routes/tasks').default;

let server: http.Server;
let base: string;

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).userId = 'scale-tester';
    (req as any).principal = { id: '99999999-9999-4999-8999-999999999999', role: 'member' };
    (req as any).scopes = ['tasks:read'];
    next();
  });
  app.use('/tasks', sharedAuthorizationMiddleware, tasksRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
afterEach(() => jest.clearAllMocks());

const request = async (path: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    json: (text ? JSON.parse(text) : null) as any,
  };
};

describe('GET /tasks/aggregates', () => {
  test('is reachable through the production chain and counts only the authorized set', async () => {
    const { status, json } = await request('/tasks/aggregates');
    expect(status).toBe(200);
    // OUT_C is out-of-grant: its completed row must not count.
    expect(json.statuses).toEqual({ completed: 1, 'in-progress': 1 });
    expect(json.total).toBe(2);
  });

  test('groupBy=project returns per-project counts and archived-excluded progress', async () => {
    scopeRowsSpy.mockResolvedValueOnce([
      row(IN_A, 'completed', 'RelayHall', '2026-08-15T10:00:00.000Z'),
      row(IN_B, 'archived', 'RelayHall', '2026-08-15T11:00:00.000Z'),
      row('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'todo', 'RelayHall', '2026-08-15T12:00:00.000Z'),
    ]);
    const { json } = await request('/tasks/aggregates?groupBy=project&statuses=completed,archived,todo');
    expect(json.projects).toHaveLength(1);
    const project = json.projects[0];
    expect(project.project).toBe('RelayHall');
    expect(project.total).toBe(3);
    expect(project.byStatus).toEqual({ completed: 1, archived: 1, todo: 1 });
    // Progress ignores the archived attic: 1 completed of 2 active.
    expect(project.progress).toBe(0.5);
  });

  test('unknown statuses and unknown groupBy are typed 400s, never silent empties', async () => {
    expect((await request('/tasks/aggregates?statuses=finished')).status).toBe(400);
    expect((await request('/tasks/aggregates?groupBy=phase')).status).toBe(400);
    expect(scopeRowsSpy).not.toHaveBeenCalled();
  });
});

describe('GET /tasks/graph', () => {
  test('task LOD returns narrowed nodes and both edge families, edge queries fed ONLY authorized ids', async () => {
    const { status, json, etag } = await request('/tasks/graph');
    expect(status).toBe(200);
    expect(etag).toMatch(/^"g-[0-9a-f]{32}"$/);
    expect(json.nodes.map((n: any) => n.id).sort()).toEqual([IN_A, IN_B]);
    expect(json.edges).toEqual([
      { from: IN_B, to: IN_A, kind: 'dependency' },
      { from: IN_A, to: IN_B, kind: 'knowledge' },
    ]);
    expect(json.fullCount).toBe(2);
    expect(depEdgesSpy).toHaveBeenCalledWith([IN_A, IN_B]);
    expect(knowEdgesSpy).toHaveBeenCalledWith([IN_A, IN_B]);
  });

  test('the ETag is stable for an unchanged scope and If-None-Match answers 304', async () => {
    const first = await request('/tasks/graph');
    const second = await request('/tasks/graph');
    expect(second.etag).toBe(first.etag);
    const cached = await request('/tasks/graph', { 'If-None-Match': first.etag! });
    expect(cached.status).toBe(304);
  });

  test('an edge-ONLY mutation invalidates the ETag — never a stale 304 (review 3475a71e B1)', async () => {
    const before = await request('/tasks/graph');
    // A knowledge edge appears without any Task updated_at rotating — the
    // production reference path does exactly this.
    const bothWays = [{ from: IN_A, to: IN_B }, { from: IN_B, to: IN_A }];
    knowEdgesSpy.mockImplementation(async (ids: string[]) => edgesWithin(bothWays, ids));
    try {
      const after = await request('/tasks/graph', { 'If-None-Match': before.etag! });
      expect(after.status).toBe(200);
      expect(after.etag).not.toBe(before.etag);
      expect(after.json.edges.filter((e: any) => e.kind === 'knowledge')).toHaveLength(2);
      // Edge REMOVAL invalidates too.
      knowEdgesSpy.mockImplementation(async () => []);
      const removed = await request('/tasks/graph', { 'If-None-Match': after.etag! });
      expect(removed.status).toBe(200);
      expect(removed.etag).not.toBe(after.etag);
    } finally {
      // Restore the id-faithful default, not a fixed list: later suites hand
      // the edge reads an EMPTY scope and expect an empty answer.
      knowEdgesSpy.mockImplementation(async (ids: string[]) => edgesWithin(KNOW_EDGES, ids));
    }
  });

  test('updatedSince accepts ONLY the emitted encoding and returns the delta with fullCount', async () => {
    for (const bad of ['2026-08-15', '2026-08-15T12:00:00Z', 'yesterday', '1755264000000']) {
      expect((await request(`/tasks/graph?updatedSince=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
    const { json } = await request('/tasks/graph?updatedSince=2026-08-15T11%3A00%3A00.000Z');
    expect(json.nodes.map((n: any) => n.id)).toEqual([IN_B]);
    expect(json.deltaOf).toBe('2026-08-15T11:00:00.000Z');
    // fullCount stays the whole authorized scope so a client can detect
    // deletions and fall back to a full refetch (documented v1 contract).
    expect(json.fullCount).toBe(2);
  });

  test('project LOD returns aggregate hub nodes and no edges; unknown LOD is a 400', async () => {
    const { json } = await request('/tasks/graph?lod=project');
    expect(json.nodes).toEqual([
      expect.objectContaining({ kind: 'project', project: 'RelayHall', total: 2 }),
    ]);
    expect(json.edges).toEqual([]);
    expect(depEdgesSpy).not.toHaveBeenCalled();
    expect((await request('/tasks/graph?lod=galaxy')).status).toBe(400);
  });
});

describe('board perColumn default (§5, E4)', () => {
  test('without a perColumn param the board pages at 50', async () => {
    await request('/tasks/board');
    expect(boardSpy).toHaveBeenCalled();
    expect(boardSpy.mock.calls[0][2]).toBe(50);
  });

  test('the explicit param and the 100 cap still hold', async () => {
    await request('/tasks/board?perColumn=6');
    expect(boardSpy.mock.calls[0][2]).toBe(6);
    await request('/tasks/board?perColumn=500');
    expect(boardSpy.mock.calls[1][2]).toBe(100);
  });
});

describe('service reads are N+1-free (fixed query counts)', () => {
  const { taskManagerDB } = jest.requireActual('../services/TaskManagerDB');

  afterEach(() => {
    poolQuery.mockReset();
    poolQuery.mockImplementation(async () => ({ rows: [] }));
  });

  test('queryScopeRows is ONE query regardless of scope size', async () => {
    poolQuery.mockImplementationOnce(async () => ({
      rows: Array.from({ length: 500 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        title: 't', status: 'todo', priority: 'normal', project: null, phase_id: null,
        updated_at: new Date('2026-08-15T00:00:00.000Z'),
      })),
    }));
    const rows = await taskManagerDB.queryScopeRows(['todo']);
    expect(rows).toHaveLength(500);
    expect(poolQuery.mock.calls.filter(call => String(call[0]).includes('FROM tasks'))).toHaveLength(1);
  });

  test('the column order is TOTAL: created_at DESC with the id tie-break (review e0f52de7 B1)', async () => {
    poolQuery.mockImplementation(async () => ({ rows: [] }));
    await taskManagerDB.queryBoardColumns(['todo'], {}, 2, {}, {
      // The order assertion is about the ORDER BY, so the widest scope keeps
      // the predicate out of the way (root renders as `TRUE`, no parameters).
      type: 'task',
      from: 'tasks t LEFT JOIN phases ph ON ph.id = t.phase_id LEFT JOIN projects p ON p.id = t.project_id',
      render: () => ({ sql: 'TRUE', params: [] }),
    });
    const dataQuery = poolQuery.mock.calls.map(call => String(call[0])).find(sql => sql.includes('LEFT JOIN personalities'));
    expect(dataQuery).toContain('ORDER BY t.created_at DESC, t.id DESC');
  });

  test('edge reads are one parameterized query each and short-circuit on empty id sets', async () => {
    poolQuery.mockImplementationOnce(async () => ({ rows: [{ task_id: IN_A, depends_on_task_id: IN_B }] }));
    await taskManagerDB.queryDependencyEdges([IN_A, IN_B]);
    expect(String(poolQuery.mock.calls[0][0])).toContain('ANY($1::uuid[])');

    poolQuery.mockClear();
    expect(await taskManagerDB.queryDependencyEdges([])).toEqual([]);
    expect(await taskManagerDB.queryKnowledgeEdges([])).toEqual([]);
    expect(poolQuery).not.toHaveBeenCalled();
  });
});

/**
 * Phase identity in the Map's bulk read (card 8645e81c, design 77950a97 §3;
 * closes the name half of census defect 7fa7e605 A13). Verified against the
 * pre-change route: every test here fails there — `phases` is absent, so the
 * shape, the authorization filter and the validator assertions all fail.
 */
describe('GET /tasks/graph — phase identity for the band chips', () => {
  it('emits name and goal for the phases the authorized nodes reference', async () => {
    const { status, json } = await request('/tasks/graph');
    expect(status).toBe(200);
    // The node still carries only the id...
    const node = json.nodes.find((n: any) => n.id === IN_A);
    expect(node.phaseId).toBe(PHASE_OPEN);
    // ...and the collection supplies the identity the chip renders.
    const open = json.phases.find((p: any) => p.id === PHASE_OPEN);
    expect(open).toMatchObject({
      id: PHASE_OPEN, name: 'Cutover', goal: 'Zero-downtime switch', position: 0,
    });
  });

  it('never discloses a phase the caller may not read, even when an authorized Task sits in it', async () => {
    const { json } = await request('/tasks/graph');
    // IN_B is authorized and references the restricted phase.
    expect(json.nodes.map((n: any) => n.id)).toContain(IN_B);
    expect(json.nodes.find((n: any) => n.id === IN_B).phaseId).toBe(PHASE_RESTRICTED);
    // The name and goal must NOT leak.
    expect(json.phases.map((p: any) => p.id)).not.toContain(PHASE_RESTRICTED);
    expect(JSON.stringify(json)).not.toContain('Sealed');
    expect(JSON.stringify(json)).not.toContain('Confidential');
  });

  it('reads phase identity only for referenced ids — never the whole table', async () => {
    await request('/tasks/graph');
    expect(phaseSummariesSpy).toHaveBeenCalledTimes(1);
    const requested = (phaseSummariesSpy.mock.calls[0] as any[])[0] as string[];
    expect(new Set(requested)).toEqual(new Set([PHASE_OPEN, PHASE_RESTRICTED]));
  });

  it('rotates the ETag when a phase is renamed with NO task update', async () => {
    const before = await request('/tasks/graph');
    phaseFixtures = phaseFixtures.map(phase =>
      phase.id === PHASE_OPEN ? { ...phase, name: 'Cutover (revised)' } : phase);
    // Same tasks, same edges, same updated_at — only the phase changed.
    const cached = await request('/tasks/graph', { 'If-None-Match': before.etag! });
    expect(cached.status).toBe(200);
    expect(cached.json.phases.find((p: any) => p.id === PHASE_OPEN).name).toBe('Cutover (revised)');
    phaseFixtures = phaseFixtures.map(phase =>
      phase.id === PHASE_OPEN ? { ...phase, name: 'Cutover' } : phase);
  });

  it('rotates the ETag when a phase GOAL changes with no task update', async () => {
    const before = await request('/tasks/graph');
    phaseFixtures = phaseFixtures.map(phase =>
      phase.id === PHASE_OPEN ? { ...phase, goal: 'Rollback rehearsed' } : phase);
    const cached = await request('/tasks/graph', { 'If-None-Match': before.etag! });
    expect(cached.status).toBe(200);
    expect(cached.json.phases.find((p: any) => p.id === PHASE_OPEN).goal).toBe('Rollback rehearsed');
    phaseFixtures = phaseFixtures.map(phase =>
      phase.id === PHASE_OPEN ? { ...phase, goal: 'Zero-downtime switch' } : phase);
  });

  it('keeps the phase collection on a delta read, so a band chip can always render', async () => {
    const { json } = await request('/tasks/graph?updatedSince=2026-08-15T11:00:00.000Z');
    // Only the newer task is in the delta window...
    expect(json.nodes.map((n: any) => n.id)).toEqual([IN_B]);
    // ...but identity for the phases in scope still arrives.
    expect(json.phases.map((p: any) => p.id)).toContain(PHASE_OPEN);
  });

  it('omits the phase collection from the project aggregate level', async () => {
    const { json } = await request('/tasks/graph?lod=project');
    expect(json.phases).toBeUndefined();
    expect(phaseSummariesSpy).not.toHaveBeenCalled();
  });
});

/**
 * §3 node taxonomy data (review 8b1cca24 B2). The tile renders a live agent
 * badge, a progress bar and report pills; none of that could exist while
 * the node summary carried no such data.
 */
describe('GET /tasks/graph — taxonomy data for the map tiles', () => {
  it('carries the active agent NAME and nothing else about the session', async () => {
    const { json } = await request('/tasks/graph');
    const node = json.nodes.find((n: any) => n.id === IN_A);
    expect(node.agent).toBe('Scout');
    // Session internals must never ride a bulk map read.
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('sessionKey');
    expect(serialized).not.toContain('logPath');
    expect(serialized).not.toContain('pid');
    // A task with no agent reports null rather than omitting the field.
    expect(json.nodes.find((n: any) => n.id === IN_B).agent).toBeNull();
  });

  it('carries subtask progress, and omits it when a task has no subtasks', async () => {
    const { json } = await request('/tasks/graph');
    expect(json.nodes.find((n: any) => n.id === IN_A).progress).toEqual({ done: 2, total: 5 });
    expect(json.nodes.find((n: any) => n.id === IN_B).progress).toBeNull();
  });

  it('reads progress and reports only for AUTHORIZED ids', async () => {
    await request('/tasks/graph');
    for (const spy of [progressSpy, linkedReportsSpy]) {
      expect(spy).toHaveBeenCalledTimes(1);
      const ids = (spy.mock.calls[0] as any[])[0] as string[];
      expect(ids).toContain(IN_A);
      expect(ids).not.toContain(OUT_C);
    }
  });

  it('never discloses a Report the caller may not read, even via an authorized Task', async () => {
    const { json } = await request('/tasks/graph');
    expect(json.reports.map((r: any) => r.id)).toContain(REPORT_OPEN);
    expect(json.reports.map((r: any) => r.id)).not.toContain(REPORT_SECRET);
    expect(JSON.stringify(json)).not.toContain('Sealed report');
  });

  it('rotates the ETag when progress changes with NO task update', async () => {
    const before = await request('/tasks/graph');
    progressFixtures = [{ taskId: IN_A, done: 3, total: 5 }];
    const after = await request('/tasks/graph', { 'If-None-Match': before.etag! });
    expect(after.status).toBe(200);
    expect(after.json.nodes.find((n: any) => n.id === IN_A).progress).toEqual({ done: 3, total: 5 });
    progressFixtures = [{ taskId: IN_A, done: 2, total: 5 }];
  });

  it('rotates the ETag when an agent picks a task up with no task update', async () => {
    const before = await request('/tasks/graph');
    scopeRowsSpy.mockImplementationOnce(async () => [
      row(IN_A, 'completed', 'RelayHall', '2026-08-15T10:00:00.000Z', 'alpha', PHASE_OPEN, 'Relay'),
      row(IN_B, 'in-progress', 'RelayHall', '2026-08-15T12:00:00.000Z', 'beta', PHASE_RESTRICTED),
      row(OUT_C, 'completed', 'Hidden', '2026-08-15T13:00:00.000Z', 'gamma', PHASE_OPEN),
    ]);
    const after = await request('/tasks/graph', { 'If-None-Match': before.etag! });
    expect(after.status).toBe(200);
    expect(after.json.nodes.find((n: any) => n.id === IN_A).agent).toBe('Relay');
  });

  it('rotates the ETag when a Report TITLE changes with no task and no membership update', async () => {
    const before = await request('/tasks/graph');
    // Same task, same updated_at, same report MEMBERSHIP — only the title.
    reportFixtures = reportFixtures.map(report =>
      report.id === REPORT_OPEN ? { ...report, title: 'Readable report (revised)' } : report);
    const after = await request('/tasks/graph', { 'If-None-Match': before.etag! });
    expect(after.status).toBe(200);
    expect(after.json.reports.find((r: any) => r.id === REPORT_OPEN).title)
      .toBe('Readable report (revised)');
    reportFixtures = REPORT_FIXTURES_BASE;
  });

  // PRESERVATION PIN, not a regression test. Verified by falsification: this
  // one PASSES on the pre-repair bytes, because the old signature omitted the
  // title entirely and so had no delimiter to forge. What it guards is the
  // NEXT edit — a future simplification of the fix to a plain
  // `r:task:id:title` interpolation would make it red. The falsifying test for
  // the reviewed defect is the title-only rotation above.
  it('frames Report titles so a delimiter in free text cannot forge a second report', async () => {
    // Under a naive interpolation these two sets serialise identically:
    //   one report titled 'X,r:<task>:<id2>:Y'  vs  two reports titled 'X' and 'Y'.
    // The length prefix is what keeps distinct rendered state off one validator.
    const SECOND = '33333333-3333-4333-8333-333333333333';
    reportFixtures = [{ id: REPORT_OPEN, taskId: IN_A, title: `X,r:${IN_A}:${SECOND}:Y` }];
    const forged = await request('/tasks/graph');
    reportFixtures = [
      { id: REPORT_OPEN, taskId: IN_A, title: 'X' },
      { id: SECOND, taskId: IN_A, title: 'Y' },
    ];
    const genuine = await request('/tasks/graph');
    expect(forged.etag).not.toBe(genuine.etag);
    reportFixtures = REPORT_FIXTURES_BASE;
  });

  it('carries progress on a DELTA read for a task OUTSIDE the updated_at window', async () => {
    // Review 51a17ab2 B3: progress rode only on deltaRows, selected by each
    // task's updated_at. subtasks is a separate table with its own updated_at
    // and no trigger writing back to tasks, so a subtask ticking over leaves
    // the task row untouched — the ETag rotated while the payload carried no
    // node able to express the change.
    progressChangedFixtures = [IN_A];
    const { json } = await request('/tasks/graph?updatedSince=2026-08-15T11:00:00.000Z');
    // IN_A is OUTSIDE the delta window...
    expect(json.nodes.map((n: any) => n.id)).toEqual([IN_B]);
    // ...but its progress still arrives, because its subtasks moved.
    expect(json.taxonomy.map((row: any) => row.id)).toEqual([IN_A]);
    expect(json.taxonomy[0].progress).toEqual({ done: 2, total: 5 });
    progressChangedFixtures = [];
  });

  it('asks for progress changes only over AUTHORIZED ids', async () => {
    progressChangedFixtures = [IN_A, OUT_C];
    const { json } = await request('/tasks/graph?updatedSince=2026-08-15T11:00:00.000Z');
    // The unauthorized task is never even offered to the progress query.
    expect(progressChangedSpy).toHaveBeenCalledWith(
      expect.not.arrayContaining([OUT_C]), expect.anything());
    expect(json.taxonomy.map((row: any) => row.id)).not.toContain(OUT_C);
    progressChangedFixtures = [];
  });

  it('sends NO taxonomy when no progress moved, so a quiet delta stays small', async () => {
    // The first cut of this repair walked the whole scope on every delta,
    // which made a delta nearly the size of a full read at estate scale.
    progressChangedFixtures = [];
    const { json } = await request('/tasks/graph?updatedSince=2026-08-15T11:00:00.000Z');
    expect(json.taxonomy).toBeUndefined();
  });

  it('omits taxonomy from a FULL read, which already carries progress per node', async () => {
    const { json } = await request('/tasks/graph');
    expect(json.taxonomy).toBeUndefined();
    expect(json.nodes.find((n: any) => n.id === IN_A).progress).toEqual({ done: 2, total: 5 });
    // A full read must not pay for the delta-only query at all.
    expect(progressChangedSpy).not.toHaveBeenCalled();
  });

  it('omits the taxonomy reads at the project aggregate level', async () => {
    const { json } = await request('/tasks/graph?lod=project');
    expect(json.reports).toBeUndefined();
    expect(progressSpy).not.toHaveBeenCalled();
    expect(linkedReportsSpy).not.toHaveBeenCalled();
  });
});

/**
 * The Map's MCP read, driven end to end: `relayhall_task_graph`'s REAL handler
 * -> `callBoard` -> the REAL in-process ingress (`mcpAuthMiddleware`,
 * `sharedAuthorizationMiddleware`, the production tasks router) -> the SAME
 * mocked query layer and authorization predicate every REST assertion above
 * runs against. Nothing here mocks the dispatcher: the negatives for a
 * restricted Phase and a concealed Report are measured on what the TOOL
 * returns, under the caller's own credential, not cited from the REST tests.
 *
 * The credential is resolved by the ingress exactly as the wire suite resolves
 * it (`c4McpProtocol`): `authenticatePrincipalKey` is the one seam mocked, and
 * it hands back a principal with `tasks:read` and no delegation chain.
 */
describe('relayhall_task_graph — the same route, through the in-process MCP ingress', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { toolByName } = require('../mcp/registry');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { principalService } = require('../services/PrincipalService');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { authorizationService } = require('../services/AuthorizationService');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { TEXT_BUDGET } = require('../mcp/shape');

  const PRINCIPAL_ID = '88888888-8888-4888-8888-888888888888';
  const CALLER = { authorization: 'Bearer rh_dev_keyid01.secretsecretsecretsecret', toolName: 'relayhall_task_graph' };
  const graph = (args: Record<string, unknown> = {}): Promise<string> =>
    toolByName('relayhall_task_graph').handler(args, CALLER);
  const detailed = async (args: Record<string, unknown> = {}): Promise<any> =>
    JSON.parse(await graph({ ...args, response_format: 'detailed' }));
  const STRICT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  beforeAll(() => {
    jest.spyOn(principalService, 'bumpLastSeen').mockImplementation(() => undefined as never);
    jest.spyOn(principalService, 'authenticatePrincipalKey').mockResolvedValue({
      principal: {
        id: PRINCIPAL_ID, kind: 'service', handle: 'map_reader', displayName: 'Map reader',
        status: 'active', role: 'agent', boundTaskId: null, purpose: null, legacyIdentity: false,
        ownExpression: null, sourceTag: null, harness: null, personalityId: null,
        parentPrincipalId: null, lastSeenAt: null, metadata: {},
      },
      credential: {
        id: '99999999-9999-4999-8999-999999999999', principalId: PRINCIPAL_ID,
        credentialType: 'api_key', keyId: 'keyid01', scopes: ['tasks:read'],
        expiresAt: null, revokedAt: null, transport: 'mcp', graceUntil: null, metadata: {},
      },
    });
  });

  afterAll(() => {
    (principalService.authenticatePrincipalKey as jest.Mock).mockRestore();
    (principalService.bumpLastSeen as jest.Mock).mockRestore();
  });

  test('detailed output IS the REST envelope for the same scope — same nodes, edges, etag; never the out-of-grant Task', async () => {
    const rest = await request('/tasks/graph');
    const mcp = await detailed();
    expect(rest.status).toBe(200);
    expect(mcp.etag).toBe(rest.etag);
    const { etag: _etag, generatedAt: mcpAt, ...mcpBody } = mcp;
    const { generatedAt: restAt, ...restBody } = rest.json;
    expect(mcpBody).toEqual(restBody);
    expect(mcpAt).toMatch(STRICT_INSTANT);
    expect(restAt).toMatch(STRICT_INSTANT);
    expect(mcp.nodes.map((n: any) => n.id).sort()).toEqual([IN_A, IN_B]);
    expect(mcp.nodes.map((n: any) => n.id)).not.toContain(OUT_C);
    expect(JSON.stringify(mcp)).not.toContain('gamma');
    expect(mcp.edges).toEqual([
      { from: IN_B, to: IN_A, kind: 'dependency' },
      { from: IN_A, to: IN_B, kind: 'knowledge' },
    ]);
    expect(mcp.fullCount).toBe(2);
    // The route was reached through the ingress under THIS credential: the
    // edge reads were fed only the authorized ids, exactly as over REST.
    expect(depEdgesSpy).toHaveBeenCalledWith([IN_A, IN_B]);
    expect(knowEdgesSpy).toHaveBeenCalledWith([IN_A, IN_B]);
  });

  test('NEGATIVE: a restricted Phase hung off an authorized Task is never disclosed through the tool', async () => {
    const mcp = await detailed();
    // Allowed projection: the authorized node still carries its phaseId, and
    // the readable Phase arrives with its identity.
    expect(mcp.nodes.find((n: any) => n.id === IN_B).phaseId).toBe(PHASE_RESTRICTED);
    expect(mcp.phases.find((p: any) => p.id === PHASE_OPEN)).toMatchObject({ id: PHASE_OPEN, name: 'Cutover', goal: 'Zero-downtime switch', position: 0 });
    // Hidden projection: name and goal of the restricted Phase are absent from
    // BOTH formats the model can ask for.
    expect(mcp.phases.map((p: any) => p.id)).not.toContain(PHASE_RESTRICTED);
    const detailedText = await graph({ response_format: 'detailed' });
    const conciseText = await graph();
    for (const text of [detailedText, conciseText]) {
      expect(text).not.toContain('Sealed');
      expect(text).not.toContain('Confidential');
    }
    expect(conciseText).toContain('phases: 1');
  });

  test('NEGATIVE: a concealed Report linked to an authorized Task is never disclosed through the tool', async () => {
    const mcp = await detailed();
    expect(mcp.reports.map((r: any) => r.id)).toContain(REPORT_OPEN);
    expect(mcp.reports.map((r: any) => r.id)).not.toContain(REPORT_SECRET);
    const detailedText = await graph({ response_format: 'detailed' });
    const conciseText = await graph();
    for (const text of [detailedText, conciseText]) expect(text).not.toContain('Sealed report');
    expect(conciseText).toContain('reports: 1');
    // Report and progress reads were asked only over authorized ids.
    for (const spy of [progressSpy, linkedReportsSpy]) {
      const ids = (spy.mock.calls[0] as any[])[0] as string[];
      expect(ids).toContain(IN_A);
      expect(ids).not.toContain(OUT_C);
    }
  });

  test('spends the returned etag: If-None-Match answers not modified, and an edge-only change breaks the match', async () => {
    const first = await detailed();
    expect(first.etag).toMatch(/^"g-[0-9a-f]{32}"$/);
    const cached = await graph({ ifNoneMatch: first.etag });
    expect(cached).toContain('not modified');
    expect(cached).toContain(first.etag);
    knowEdgesSpy.mockImplementationOnce(async (ids: string[]) =>
      edgesWithin([{ from: IN_A, to: IN_B }, { from: IN_B, to: IN_A }], ids));
    const changed = await detailed({ ifNoneMatch: first.etag });
    expect(changed.etag).not.toBe(first.etag);
    expect(changed.edges.filter((e: any) => e.kind === 'knowledge')).toHaveLength(2);
  });

  test('delta read: only the updated node, scoped phases/reports and fullCount kept, taxonomy for moved progress', async () => {
    const quiet = await detailed({ updatedSince: '2026-08-15T11:00:00.000Z' });
    expect(quiet.nodes.map((n: any) => n.id)).toEqual([IN_B]);
    expect(quiet.deltaOf).toBe('2026-08-15T11:00:00.000Z');
    expect(quiet.fullCount).toBe(2);
    expect(quiet.phases.map((p: any) => p.id)).toContain(PHASE_OPEN);
    expect(quiet.reports.map((r: any) => r.id)).toEqual([REPORT_OPEN]);
    expect(quiet.taxonomy).toBeUndefined();
    progressChangedFixtures = [IN_A];
    try {
      const moved = await detailed({ updatedSince: '2026-08-15T11:00:00.000Z' });
      expect(moved.nodes.map((n: any) => n.id)).toEqual([IN_B]);
      expect(moved.taxonomy).toEqual([{ id: IN_A, progress: { done: 2, total: 5 } }]);
      const concise = await graph({ updatedSince: '2026-08-15T11:00:00.000Z' });
      expect(concise).toContain('nodes: 1');
      expect(concise).toContain('fullCount: 2');
      expect(concise).toContain('taxonomy: 1');
      expect(concise).toContain('deltaOf: 2026-08-15T11:00:00.000Z');
    } finally {
      progressChangedFixtures = [];
    }
  });

  test('generatedAt is the strict instant the route emits, and is accepted back as updatedSince', async () => {
    const full = await detailed();
    expect(full.generatedAt).toMatch(STRICT_INSTANT);
    const later = await detailed({ updatedSince: full.generatedAt });
    expect(later.deltaOf).toBe(full.generatedAt);
    expect(later.nodes).toEqual([]);
    expect(later.fullCount).toBe(2);
    expect(await graph()).toMatch(/^generatedAt: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m);
  });

  test('project LOD returns aggregate hubs and no edges, phases or reports', async () => {
    const mcp = await detailed({ lod: 'project' });
    expect(mcp.lod).toBe('project');
    expect(mcp.nodes).toEqual([expect.objectContaining({ kind: 'project', project: 'RelayHall', total: 2 })]);
    expect(mcp.edges).toEqual([]);
    expect(mcp).not.toHaveProperty('phases');
    expect(mcp).not.toHaveProperty('reports');
    expect(depEdgesSpy).not.toHaveBeenCalled();
    expect(phaseSummariesSpy).not.toHaveBeenCalled();
    expect(linkedReportsSpy).not.toHaveBeenCalled();
    const concise = await graph({ lod: 'project' });
    expect(concise).toContain('lod: project');
    expect(concise).toContain('edges: 0 (dependency 0, knowledge 0)');
  });

  test('every filter, including the Assignee narrowing, reaches the scope query exactly as the route parses it', async () => {
    await graph({
      statuses: ['todo', 'stuck'], projects: ['RelayHall'], phaseIds: ['null', PHASE_OPEN],
      priorities: ['high'], tags: ['x'], q: 'alpha', includeArchived: true,
      mine: true, unassigned: true, owner: 'scout',
    });
    expect(scopeRowsSpy).toHaveBeenCalledTimes(1);
    expect(scopeRowsSpy.mock.calls[0]).toEqual([
      ['todo', 'stuck'],
      {
        q: 'alpha', projects: ['RelayHall'], phaseIds: [null, PHASE_OPEN], priorities: ['high'],
        tags: ['x'], includeArchived: true,
        // `mine` resolves to the CALLING principal the ingress authenticated —
        // never an id the tool could name.
        ownerPrincipalId: PRINCIPAL_ID, unassigned: true, ownerHandle: 'scout',
      },
    ]);
  });

  test('an empty scope is an empty graph with fullCount 0, in both formats', async () => {
    scopeRowsSpy.mockResolvedValueOnce([]);
    const mcp = await detailed();
    expect(mcp).toMatchObject({ lod: 'task', nodes: [], edges: [], phases: [], reports: [], fullCount: 0 });
    // The edge reads were scoped to the EMPTY authorized set — the empty
    // `edges` above is the query layer's honest answer to that, not a mock's
    // fixed list surviving an empty scope.
    expect(depEdgesSpy).toHaveBeenCalledWith([]);
    expect(knowEdgesSpy).toHaveBeenCalledWith([]);
    expect(linkedReportsSpy).toHaveBeenCalledWith([]);
    scopeRowsSpy.mockResolvedValueOnce([]);
    const concise = await graph();
    expect(concise).toContain('fullCount: 0');
    expect(concise).toContain('nodes: 0');
  });

  test('a large graph passes through the real ingress whole: 12,000 nodes, past the text budget, never cut', async () => {
    const rows12k = Array.from({ length: 12_000 }, (_, index) =>
      row(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, 'todo', 'RelayHall', '2026-08-15T10:00:00.000Z', `node ${index}`));
    scopeRowsSpy.mockResolvedValueOnce(rows12k);
    const text = await graph({ response_format: 'detailed' });
    expect(text.length).toBeGreaterThan(TEXT_BUDGET);
    expect(text).not.toContain('truncated at');
    expect(text).not.toContain('continue_from');
    const parsed = JSON.parse(text);
    expect(parsed.nodes).toHaveLength(12_000);
    expect(parsed.fullCount).toBe(12_000);
    expect(parsed.nodes[11_999].title).toBe('node 11999');
  });

  test('the route 400s come back as instructive tool errors carrying the route message, with no scope read', async () => {
    await expect(graph({ statuses: ['finished'] })).rejects.toThrow(/statuses must name known states only/);
    await expect(graph({ lod: 'galaxy' })).rejects.toThrow(/lod must be one of/);
    for (const bad of ['2026-08-15', '2026-08-15T12:00:00Z', 'yesterday']) {
      await expect(graph({ updatedSince: bad })).rejects.toThrow(/updatedSince must be an ISO 8601/);
    }
    expect(scopeRowsSpy).not.toHaveBeenCalled();
  });

  test("a route-ceiling refusal is a 403 carrying the board's own code, with no scope read", async () => {
    (authorizationService.authorizeRoute as jest.Mock).mockImplementation(() => ({ allowed: false }));
    try {
      // The ceiling answers a bare FORBIDDEN, not an explicit scope code, so the
      // tool error carries that code and the whoami / access_preview pointers
      // and does not assert a cause the board did not state.
      await expect(graph()).rejects.toThrow(/\(HTTP 403\) \[FORBIDDEN\]/);
      await expect(graph()).rejects.toThrow(/relayhall_principal_whoami/);
      await expect(graph()).rejects.not.toThrow(/issue or extend a credential/);
      expect(scopeRowsSpy).not.toHaveBeenCalled();
    } finally {
      (authorizationService.authorizeRoute as jest.Mock).mockImplementation(() => ({ allowed: true }));
    }
  });

  test('unknown or mis-shaped arguments are refused before the ingress is touched', async () => {
    for (const bad of [{ limit: 10 }, { offset: 0 }, { continue_from: 0 }, { statuses: 'todo' }, { tags: [1] }]) {
      await expect(graph(bad)).rejects.toThrow(/Unknown arguments|must be an array of strings/);
    }
    expect(principalService.authenticatePrincipalKey).not.toHaveBeenCalled();
    expect(scopeRowsSpy).not.toHaveBeenCalled();
  });
});
