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
      }));
    });
  });

  it('keeps the default list call shape when the new params are absent', async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/reports`);
      expect(res.status).toBe(200);
      expect(manager.list).toHaveBeenCalledWith(expect.objectContaining({
        updated_since: undefined, sort: undefined, order: undefined,
      }));
    });
  });
});
