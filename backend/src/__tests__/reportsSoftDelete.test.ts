/**
 * reportsSoftDelete.test.ts — reports hardening item 6 (task c655d243):
 * DELETE /reports/:id tombstones (deleted_at) by default; ?hard=true is a
 * dashboard_user-only escape hatch; list/get hide tombstones unless
 * include_deleted=true.
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
      softDelete: jest.fn(),
      hardDelete: jest.fn(),
    },
  };
});

jest.mock('../services/WebhookService', () => ({
  webhookService: { emitEvent: jest.fn() },
}));

import reportsRoutes from '../routes/reports';
import { reportManager } from '../services/ReportManager';

const manager = reportManager as jest.Mocked<typeof reportManager>;
const { ReportManager } = jest.requireActual('../services/ReportManager');
const RID = '11111111-1111-4111-8111-111111111111';

async function withServer(userId: string, run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => { (req as Request & { userId?: string }).userId = userId; next(); });
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

describe('DELETE /reports/:id soft delete route behaviour', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.softDelete.mockResolvedValue(true);
    manager.hardDelete.mockResolvedValue(true);
    manager.list.mockResolvedValue({ reports: [], total: 0, hasMore: false });
    manager.getById.mockResolvedValue(null);
  });

  it('defaults to soft delete for any authenticated identity', async () => {
    await withServer('service_account', async base => {
      const res = await fetch(`${base}/reports/${RID}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, mode: 'soft' });
      expect(manager.softDelete).toHaveBeenCalledWith(RID);
      expect(manager.hardDelete).not.toHaveBeenCalled();
    });
  });

  it('refuses ?hard=true for non-dashboard identities with 403', async () => {
    await withServer('service_account', async base => {
      const res = await fetch(`${base}/reports/${RID}?hard=true`, { method: 'DELETE' });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('HARD_DELETE_FORBIDDEN');
      expect(manager.hardDelete).not.toHaveBeenCalled();
      expect(manager.softDelete).not.toHaveBeenCalled();
    });
  });

  it('allows ?hard=true for dashboard_user', async () => {
    await withServer('dashboard_user', async base => {
      const res = await fetch(`${base}/reports/${RID}?hard=true`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, mode: 'hard' });
      expect(manager.hardDelete).toHaveBeenCalledWith(RID);
    });
  });

  it('404s when the tombstone target does not exist (or is already tombstoned)', async () => {
    manager.softDelete.mockResolvedValue(false);
    await withServer('dashboard_user', async base => {
      const res = await fetch(`${base}/reports/${RID}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  it('threads include_deleted=true through list and get', async () => {
    await withServer('dashboard_user', async base => {
      await fetch(`${base}/reports?include_deleted=true`);
      expect(manager.list).toHaveBeenCalledWith(expect.objectContaining({ include_deleted: true }));
      await fetch(`${base}/reports/${RID}?include_deleted=true`);
      expect(manager.getById).toHaveBeenCalledWith(RID, { includeDeleted: true });
      await fetch(`${base}/reports/${RID}`);
      expect(manager.getById).toHaveBeenLastCalledWith(RID, { includeDeleted: false });
    });
  });
});

describe('ReportManager tombstone SQL', () => {
  function fakePool(rowCount = 1) {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    return {
      queries,
      connect: jest.fn(async function () {
        const self = this as { query: (t: string, p?: unknown[]) => Promise<unknown> };
        return { query: (t: string, p?: unknown[]) => self.query(t, p), release: () => undefined };
      }),
      query: jest.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params: params ?? [] });
        if (/COUNT\(\*\)/i.test(text)) return { rows: [{ total: '0' }], rowCount: 1 };
        // The RH-P3.C1 tombstone emission reads the RETURNING metadata row.
        // Review `99ba9444` B1: the tombstone emission reads the CANONICAL
        // author column, not the untagged provenance string.
        if (/RETURNING project_id, author_principal_id/i.test(text)) {
          return { rows: rowCount > 0 ? [{ project_id: null, author_principal_id: null, deleted_at: null }] : [], rowCount };
        }
        return { rows: [], rowCount };
      }),
    };
  }

  it('softDelete stamps deleted_at only on live rows', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).softDelete(RID);
    const q = pool.queries.find(x => /SET deleted_at = NOW\(\)/.test(x.text))!;
    expect(q.text).toContain('SET deleted_at = NOW()');
    expect(q.text).toContain('deleted_at IS NULL');
    expect(q.params).toEqual([RID]);
  });

  it('hardDelete issues a real DELETE without a tombstone guard', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).hardDelete(RID);
    const del = pool.queries.find(x => /^DELETE FROM reports/.test(x.text))!;
    // The property this pins: the hard path carries NO tombstone guard. The
    // RETURNING clause feeds the RH-P3.C1 tombstone emission's metadata.
    expect(del.text).toMatch(/^DELETE FROM reports WHERE id = \$1 RETURNING/);
    expect(del.text).not.toContain('deleted_at IS NULL');
  });

  it('list hides tombstones by default and reveals them with include_deleted', async () => {
    const pool = fakePool();
    const mgr = new ReportManager(pool as never);
    await mgr.list({});
    expect(pool.queries[0].text).toContain('r.deleted_at IS NULL');
    pool.queries.length = 0;
    await mgr.list({ include_deleted: true });
    expect(pool.queries[0].text).not.toContain('deleted_at');
  });

  it('getById, getByTaskId and listVisibilityRows exclude tombstones', async () => {
    const pool = fakePool(0);
    const mgr = new ReportManager(pool as never);
    await mgr.getById(RID);
    expect(pool.queries[0].text).toContain('r.deleted_at IS NULL');
    await mgr.getById(RID, { includeDeleted: true });
    expect(pool.queries[1].text).not.toContain('deleted_at IS NULL');
    await mgr.getByTaskId(RID);
    expect(pool.queries[2].text).toContain('deleted_at IS NULL');
    await mgr.listVisibilityRows();
    expect(pool.queries[3].text).toContain('WHERE deleted_at IS NULL');
  });
});
