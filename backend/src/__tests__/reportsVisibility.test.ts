/**
 * reportsVisibility.test.ts — reports hardening item 7 (task c655d243):
 * visibility column plumbing (schema + read/write). Deliberately NO
 * enforcement — that is a fabric-side concern; these tests pin exactly that
 * boundary: the value round-trips but never filters anything.
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

describe('report visibility plumbing (no enforcement)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.create.mockResolvedValue({ id: RID } as never);
    manager.update.mockResolvedValue({ id: RID } as never);
    manager.list.mockResolvedValue({ reports: [], total: 0, hasMore: false });
  });

  it('POST passes a valid visibility through and PATCH can change it', async () => {
    await withServer(async base => {
      const post = await fetch(`${base}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', content: 'C', visibility: 'private' }),
      });
      expect(post.status).toBe(201);
      expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private' }));

      const patch = await fetch(`${base}/reports/${RID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'team' }),
      });
      expect(patch.status).toBe(200);
      expect(manager.update).toHaveBeenCalledWith(RID, expect.objectContaining({ visibility: 'team' }));
    });
  });

  it('rejects malformed visibility values with 400 INVALID_VISIBILITY', async () => {
    await withServer(async base => {
      for (const bad of ['UPPER', 'has space', 'x'.repeat(33), 42]) {
        const res = await fetch(`${base}/reports`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'T', content: 'C', visibility: bad }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('INVALID_VISIBILITY');
      }
      expect(manager.create).not.toHaveBeenCalled();
    });
  });

  it('GET /reports has no visibility filter parameter (enforcement is fabric-side)', async () => {
    await withServer(async base => {
      await fetch(`${base}/reports?visibility=private`);
      expect(manager.list).toHaveBeenCalledTimes(1);
      const opts = manager.list.mock.calls[0][0] as Record<string, unknown>;
      expect('visibility' in opts).toBe(false);
    });
  });
});

describe('ReportManager visibility persistence', () => {
  function fakePool() {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    return {
      queries,
      connect: jest.fn(async function () {
        const self = this as { query: (t: string, p?: unknown[]) => Promise<unknown> };
        return { query: (t: string, p?: unknown[]) => self.query(t, p), release: () => undefined };
      }),
      query: jest.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params: params ?? [] });
        if (/INSERT INTO reports/i.test(text)) return { rows: [{ id: RID, project_id: null, author_actor_id: null }], rowCount: 1 };
        if (/UPDATE reports SET/i.test(text)) return { rows: [{ project_id: null, author_actor_id: null }], rowCount: 1 };
        if (/COUNT\(\*\)/i.test(text)) return { rows: [{ total: '0' }], rowCount: 1 };
        if (/FROM reports r/i.test(text)) return { rows: [{ id: RID, visibility: 'private' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
  }

  it('INSERT persists visibility with a default of default', async () => {
    const pool = fakePool();
    const mgr = new ReportManager(pool as never);
    await mgr.create({ title: 'T', content: 'C', visibility: 'private' });
    let insert = pool.queries.find(q => /INSERT INTO reports/i.test(q.text))!;
    expect(insert.text).toContain('visibility');
    expect(insert.params).toContain('private');

    pool.queries.length = 0;
    await mgr.create({ title: 'T', content: 'C' });
    insert = pool.queries.find(q => /INSERT INTO reports/i.test(q.text))!;
    expect(insert.params).toContain('default');
  });

  it('UPDATE can change visibility; mapped rows expose it; list never filters on it', async () => {
    const pool = fakePool();
    const mgr = new ReportManager(pool as never);
    await mgr.update(RID, { visibility: 'team' });
    const update = pool.queries.find(q => /UPDATE reports SET/i.test(q.text))!;
    expect(update.text).toContain('visibility');
    expect(update.params).toContain('team');

    const report = await mgr.getById(RID);
    expect(report!.visibility).toBe('private');

    pool.queries.length = 0;
    await mgr.list({});
    expect(pool.queries[0].text).not.toContain('visibility');
  });
});
