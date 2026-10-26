/**
 * reportsListQuery.test.ts — reports hardening item 1 (task c655d243):
 * GET /reports updated_since filter (ISO8601, inclusive) and explicit
 * sort=updated_at|created_at with a stable id tiebreak. The legacy
 * pinned-first ordering stays the default.
 */
import express, { Request } from 'express';

jest.mock('../services/ReportManager', () => {
  const actual = jest.requireActual('../services/ReportManager');
  return {
    ...actual,
    reportManager: {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
});

import reportsRoutes from '../routes/reports';
import { reportManager } from '../services/ReportManager';
import * as reportVisibility from '../services/ReportVisibility';

const manager = reportManager as jest.Mocked<typeof reportManager>;
const { ReportManager } = jest.requireActual('../services/ReportManager');

function fakePool() {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  return {
    queries,
    query: jest.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params: params ?? [] });
      if (/COUNT\(\*\)/i.test(text)) return { rows: [{ total: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
}

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => { (req as Request & { userId?: string }).userId = 'service_account'; next(); });
  app.use('/reports', reportsRoutes);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
}

describe('ReportManager.list query building (updated_since + sort)', () => {
  it('keeps the legacy pinned-first ordering and no updated_at filter by default', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).list({});
    const dataQuery = pool.queries[1].text;
    expect(dataQuery).toContain('ORDER BY r.pinned DESC, r.created_at DESC');
    expect(dataQuery).not.toContain('updated_at >=');
  });

  it('adds an inclusive updated_at >= condition for updated_since', async () => {
    const pool = fakePool();
    const since = '2026-07-01T00:00:00Z';
    await new ReportManager(pool as never).list({ updated_since: since });
    const countQuery = pool.queries[0];
    const dataQuery = pool.queries[1];
    expect(countQuery.text).toContain('r.updated_at >= $1::timestamptz');
    expect(countQuery.params).toEqual([since]);
    expect(dataQuery.text).toContain('r.updated_at >= $1::timestamptz');
    expect(dataQuery.params.slice(0, 1)).toEqual([since]);
  });

  it('sorts by updated_at with a stable id tiebreak in the same direction', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).list({ sort: 'updated_at', order: 'asc' });
    expect(pool.queries[1].text).toContain('ORDER BY r.updated_at ASC, r.id ASC');
  });

  it('defaults explicit sort direction to DESC', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).list({ sort: 'created_at' });
    expect(pool.queries[1].text).toContain('ORDER BY r.created_at DESC, r.id DESC');
  });

  it('combines updated_since with other filters using correct parameter order', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).list({ q: 'needle', updated_since: '2026-07-01T00:00:00Z', sort: 'updated_at', order: 'asc' });
    const countQuery = pool.queries[0];
    expect(countQuery.text).toContain('$1');
    expect(countQuery.text).toContain('r.updated_at >= $2::timestamptz');
    expect(countQuery.params).toEqual(['%needle%', '2026-07-01T00:00:00Z']);
  });
});

describe('GET /reports route validation (updated_since + sort)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.list.mockResolvedValue({ reports: [], total: 0, hasMore: false });
  });

  it('rejects a non-ISO updated_since with 400 INVALID_UPDATED_SINCE', async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/reports?updated_since=not-a-date`);
      expect(res.status).toBe(400);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('INVALID_UPDATED_SINCE');
      expect(manager.list).not.toHaveBeenCalled();
    });
  });

  it('rejects unknown sort and order values with 400', async () => {
    await withServer(async base => {
      const badSort = await fetch(`${base}/reports?sort=title`);
      expect(badSort.status).toBe(400);
      expect(((await badSort.json()) as { code: string }).code).toBe('INVALID_SORT');
      const badOrder = await fetch(`${base}/reports?sort=updated_at&order=sideways`);
      expect(badOrder.status).toBe(400);
      expect(((await badOrder.json()) as { code: string }).code).toBe('INVALID_ORDER');
      expect(manager.list).not.toHaveBeenCalled();
    });
  });

  it('passes valid updated_since/sort/order through to the manager', async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/reports?updated_since=2026-07-01T00:00:00Z&sort=updated_at&order=asc`);
      expect(res.status).toBe(200);
      expect(manager.list).toHaveBeenCalledWith(expect.objectContaining({
        updated_since: '2026-07-01T00:00:00Z',
        sort: 'updated_at',
        order: 'asc',
      }), expect.any(Function));
    });
  });

  it('keeps the default list call shape when the new params are absent', async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/reports`);
      expect(res.status).toBe(200);
      expect(manager.list).toHaveBeenCalledWith(expect.objectContaining({
        updated_since: undefined, sort: undefined, order: undefined,
      }), expect.any(Function));
    });
  });
});


describe('visibility before report pagination', () => {
  it('counts and pages only readable ids, including rows beyond a hidden first page', async () => {
    const candidates = Array.from({ length: 35 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      auto_promoted: index % 2 === 0,
      source_task_id: null,
      source_outpost_visibility_tier: null,
    }));
    const visible = candidates.slice(15); // Entire first source page hidden.
    const queries: Array<{ text: string; params: any[] }> = [];
    const pool = { query: jest.fn(async (text: string, params: any[] = []) => {
      // Capture values now; the manager adds its visibility binding later.
      queries.push({ text, params: [...params] });
      if (text.includes('COUNT(*)')) return { rows: [{ total: String(visible.length) }] };
      if (text.includes('LIMIT')) {
        const allowed = new Set(params[params.length - 3]);
        const [limit, offset] = params.slice(-2);
        return { rows: candidates.filter(row => allowed.has(row.id)).slice(offset, offset + limit) };
      }
      return { rows: candidates };
    }) };
    const narrow = jest.fn(async () => visible);
    const mgr = new ReportManager(pool as never);
    const first = await mgr.list({ limit: 10, tags: ['selected'] }, narrow);
    expect(first.reports.map((row: { id: string }) => row.id)).toEqual(visible.slice(0, 10).map(row => row.id));
    expect(first.total).toBe(20);
    expect(first.hasMore).toBe(true);
    expect(narrow).toHaveBeenCalledWith(candidates);
    expect(queries[0].text).not.toContain('r.*');
    expect(queries[0].text).toContain('r.tags @> $1::text[]');
    expect(queries[0].params).toEqual([['selected']]);
    for (const query of queries.slice(1)) {
      expect(query.text).toContain('r.id = ANY($2::uuid[])');
      expect(query.params[1]).toEqual(visible.map(row => row.id));
    }
    expect(queries[2].text).toContain('ORDER BY r.pinned DESC, r.created_at DESC, r.id DESC');
    const last = await mgr.list({ limit: 10, offset: 10 }, narrow);
    expect(last.reports.map((row: { id: string }) => row.id)).toEqual(visible.slice(10).map(row => row.id));
    expect(last.hasMore).toBe(false);
  });

  it('binds an empty allowlist when every matching report is hidden', async () => {
    const pool = fakePool();
    const narrow = jest.fn(async () => []);
    const result = await new ReportManager(pool as never).list({}, narrow);
    expect(result).toEqual({ reports: [], total: 0, hasMore: false });
    expect(pool.queries[1].text).toContain('r.id = ANY($1::uuid[])');
    expect(pool.queries[1].params).toEqual([[]]);
  });

  it('preserves all shared visibility restrictions and returns the visible total and next page', async () => {
    const rows = [{ id: 'allowed' }, { id: 'hidden' }];
    const filter = jest.spyOn(reportVisibility, 'filterVisibleReports').mockResolvedValue([rows[0]]);
    manager.list.mockImplementationOnce(async (_opts, narrow) => {
      expect(narrow).toBeDefined();
      const allowed = await narrow!(rows as never);
      expect(allowed).toEqual([rows[0]]);
      return { reports: [rows[0]] as never, total: 123, hasMore: true };
    });
    try {
      await withServer(async base => {
        const res = await fetch(`${base}/reports?limit=10&offset=10`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, reports: [rows[0]], total: 123, hasMore: true });
      });
      expect(filter).toHaveBeenCalledTimes(2);
    } finally {
      filter.mockRestore();
    }
  });
  it('excludes content that became private after candidate authorization without rewriting the earlier total', async () => {
    const candidate = { id: 'changed', visibility: 'shared' };
    const fetched = { id: 'changed', visibility: 'private', content: 'new private content' };
    const filter = jest.spyOn(reportVisibility, 'filterVisibleReports')
      .mockResolvedValueOnce([candidate] as never)
      .mockResolvedValueOnce([]);
    manager.list.mockImplementationOnce(async (_opts, narrow) => {
      expect(await narrow!([candidate] as never)).toEqual([candidate]);
      return { reports: [fetched] as never, total: 1, hasMore: false };
    });
    try {
      await withServer(async base => {
        const res = await fetch(`${base}/reports`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, reports: [], total: 1, hasMore: false });
      });
      expect(filter).toHaveBeenNthCalledWith(2, expect.anything(), [fetched]);
    } finally { filter.mockRestore(); }
  });

});
