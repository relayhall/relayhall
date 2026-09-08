/**
 * reportsOrigin.test.ts — reports hardening item 5 (task c655d243):
 * origin column recorded from the optional X-RelayHall-Origin header on
 * POST ('api' default), validated as lowercase [a-z0-9_-]{1,32}.
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

describe('report origin header plumbing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.create.mockResolvedValue({ id: RID } as never);
  });

  const post = (base: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ title: 'T', content: 'C' }),
    });

  it('defaults origin to api when the header is absent', async () => {
    await withServer(async base => {
      expect((await post(base)).status).toBe(201);
      expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({ origin: 'api' }));
    });
  });

  it('records a valid X-RelayHall-Origin (case-normalized)', async () => {
    await withServer(async base => {
      expect((await post(base, { 'X-RelayHall-Origin': 'CLI' })).status).toBe(201);
      expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({ origin: 'cli' }));
    });
  });

  it('rejects malformed origins with 400 INVALID_ORIGIN', async () => {
    await withServer(async base => {
      for (const bad of ['spaces here', 'a'.repeat(33), 'semi;colon', '']) {
        const res = await post(base, { 'X-RelayHall-Origin': bad });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('INVALID_ORIGIN');
      }
      expect(manager.create).not.toHaveBeenCalled();
    });
  });
});

describe('ReportManager origin persistence', () => {
  function fakePool() {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    return {
      queries,
      connect: jest.fn(async function () {
        const self = this as { query: (t: string, p?: unknown[]) => Promise<unknown> };
        return { query: (t: string, p?: unknown[]) => self.query(t, p), release: () => undefined };
      }),
      query: jest.fn(async (text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> => {
        queries.push({ text, params: params ?? [] });
        if (/INSERT INTO reports/i.test(text)) return { rows: [{ id: RID, project_id: null, author_actor_id: null }], rowCount: 1 };
        if (/UPDATE reports SET/i.test(text)) return { rows: [{ project_id: null, author_actor_id: null }], rowCount: 1 };
        if (/FROM reports r/i.test(text)) return { rows: [{ id: RID, origin: 'dashboard' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
  }

  it('INSERT persists origin and defaults to api', async () => {
    const pool = fakePool();
    const mgr = new ReportManager(pool as never);
    await mgr.create({ title: 'T', content: 'C', origin: 'dashboard' });
    let insert = pool.queries.find(q => /INSERT INTO reports/i.test(q.text))!;
    expect(insert.text).toContain('origin');
    expect(insert.params).toContain('dashboard');

    pool.queries.length = 0;
    await mgr.create({ title: 'T', content: 'C' });
    insert = pool.queries.find(q => /INSERT INTO reports/i.test(q.text))!;
    expect(insert.params).toContain('api');
  });

  it('mapped rows expose origin (api fallback for legacy rows)', async () => {
    const pool = fakePool();
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.origin).toBe('dashboard');
  });

  it('ReportManager.update has no origin pathway (creation provenance is immutable)', async () => {
    const pool = fakePool();
    pool.query.mockImplementation(async (text: string, params?: unknown[]) => {
      pool.queries.push({ text, params: params ?? [] });
      if (/FROM reports r/i.test(text)) return { rows: [{ id: RID }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    await new ReportManager(pool as never).update(RID, { origin: 'forged' } as never);
    const update = pool.queries.find(q => /UPDATE reports SET/i.test(q.text))!;
    expect(update.text).not.toContain('origin');
  });
});
