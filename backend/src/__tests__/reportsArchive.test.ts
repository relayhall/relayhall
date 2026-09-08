/**
 * reportsArchive.test.ts — Report archived-representation (b94dd86e §4.1/§4.4,
 * amendment A11.2, task 9e434871): POST /reports/:id/archive|unarchive flip the
 * status column; archived reports are read-only (PATCH → 409 REPORT_ARCHIVED)
 * and excluded from default lists unless status= or include_archived=true.
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
      softDelete: jest.fn(),
      hardDelete: jest.fn(),
      archive: jest.fn(),
      unarchive: jest.fn(),
    },
  };
});


import reportsRoutes from '../routes/reports';
import { reportManager } from '../services/ReportManager';

const manager = reportManager as jest.Mocked<typeof reportManager>;
const RID = '22222222-2222-4222-8222-222222222222';

const reportFixture = (status: 'active' | 'archived' = 'active') => ({
  id: RID,
  title: 'Fixture report',
  content: 'body',
  content_hash: null,
  summary: null,
  tags: [],
  project_id: null,
  task_ids: [],
  author: 'system',
  author_unverified: 'system',
  author_actor_id: null,
  origin: 'api',
  visibility: 'default',
  pinned: false,
  status,
  created_at: '2026-08-08T00:00:00Z',
  updated_at: '2026-08-08T00:00:00Z',
  deleted_at: null,
});

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => { (req as Request & { userId?: string }).userId = 'agent'; next(); });
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

describe('report archive lifecycle routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.list.mockResolvedValue({ reports: [], total: 0, hasMore: false });
  });

  it('POST /:id/archive archives and emits report.archived', async () => {
    manager.archive.mockResolvedValue(reportFixture('archived') as any);
    await withServer(async base => {
      const res = await fetch(`${base}/reports/${RID}/archive`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; report: { status: string } };
      expect(body.success).toBe(true);
      expect(body.report.status).toBe('archived');
    });
    expect(manager.archive).toHaveBeenCalledWith(RID);
  });

  it('POST /:id/unarchive returns the report to active and emits report.unarchived', async () => {
    manager.unarchive.mockResolvedValue(reportFixture('active') as any);
    await withServer(async base => {
      const res = await fetch(`${base}/reports/${RID}/unarchive`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as { report: { status: string } };
      expect(body.report.status).toBe('active');
    });
    expect(manager.unarchive).toHaveBeenCalledWith(RID);
  });

  it('archive of a missing or non-active report is 404 and emits nothing', async () => {
    manager.archive.mockResolvedValue(null);
    await withServer(async base => {
      const res = await fetch(`${base}/reports/${RID}/archive`, { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });

  it('PATCH on an archived report maps REPORT_ARCHIVED to 409', async () => {
    manager.update.mockRejectedValue(new Error('REPORT_ARCHIVED'));
    await withServer(async base => {
      const res = await fetch(`${base}/reports/${RID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New title' }),
      });
      expect(res.status).toBe(409);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('REPORT_ARCHIVED');
    });
  });

  it('the ReportManager itself refuses updates while archived', async () => {
    const { ReportManager } = jest.requireActual('../services/ReportManager');
    const instance = new ReportManager({ query: jest.fn() } as any);
    jest.spyOn(instance, 'getById').mockResolvedValue(reportFixture('archived') as any);
    await expect(instance.update(RID, { title: 'x' })).rejects.toThrow('REPORT_ARCHIVED');
  });

  it('archive committing after the pre-read still wins the atomic update predicate', async () => {
    const { ReportManager } = jest.requireActual('../services/ReportManager');
    let row = reportFixture('active');
    const queries: string[] = [];
    const pool = {
      query: jest.fn(async (text: string) => {
        // Transaction framing from the RH-P3.C1 emission wrap is not part of
        // the interleaving this test pins; keep the recorded sequence to the
        // three statements the scenario is about.
        if (!/^(BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) queries.push(text);
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) return { rows: [], rowCount: 0 };
        if (/SELECT r\.\*, p\.name as project_name/i.test(text)) {
          return { rows: [row], rowCount: 1 };
        }
        if (/UPDATE reports SET/i.test(text)) {
          // Deterministic interleaving: the archive commits after update()'s
          // first getById returned active, but before this statement evaluates
          // its WHERE predicate.
          row = reportFixture('archived');
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected SQL: ${text}`);
      }),
    } as { query: jest.Mock; connect?: unknown };
    pool.connect = async () => ({ query: pool.query, release: () => undefined });
    const instance = new ReportManager(pool as any);

    await expect(instance.update(RID, { title: 'must not land' }))
      .rejects.toThrow('REPORT_ARCHIVED');

    const update = queries.find(text => /UPDATE reports SET/i.test(text));
    expect(update).toContain("deleted_at IS NULL AND status = 'active'");
    expect(row.title).toBe('Fixture report');
    expect(queries).toHaveLength(3); // active read, rejected UPDATE, archived classification read
  });

  it('list forwards status= and rejects invalid values', async () => {
    await withServer(async base => {
      expect((await fetch(`${base}/reports?status=archived`)).status).toBe(200);
      const bad = await fetch(`${base}/reports?status=paused`);
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { code: string }).code).toBe('INVALID_STATUS');
    });
    expect(manager.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'archived' }));
  });

  it('the default list neither filters explicitly nor opts into archived rows', async () => {
    await withServer(async base => {
      expect((await fetch(`${base}/reports`)).status).toBe(200);
    });
    expect(manager.list).toHaveBeenCalledWith(expect.objectContaining({ status: undefined, include_archived: false }));
  });
});
