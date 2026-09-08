import express from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import {
  normalizeReportHandover,
  ReportHandoverValidationError,
} from '../types/ReportHandover';

jest.mock('../services/ReportManager', () => {
  const actual = jest.requireActual('../services/ReportManager');
  return {
    ...actual,
    reportManager: {
      list: jest.fn(), getById: jest.fn(), create: jest.fn(), update: jest.fn(),
      archive: jest.fn(), unarchive: jest.fn(), softDelete: jest.fn(), hardDelete: jest.fn(),
    },
  };
});

jest.mock('../services/WebhookService', () => ({ webhookService: { emitEvent: jest.fn() } }));

import reportsRoutes from '../routes/reports';
import { reportManager } from '../services/ReportManager';

const manager = reportManager as jest.Mocked<typeof reportManager>;
const { ReportManager } = jest.requireActual('../services/ReportManager');
const RID = '11111111-1111-4111-8111-111111111111';
const PID = '22222222-2222-4222-8222-222222222222';
const TID = '33333333-3333-4333-8333-333333333333';

const fullHandover = {
  schema_version: 1 as const,
  decisions: ['Use JSONB.'],
  assumptions: ['Reports remain project-bound.'],
  alternatives_rejected: ['Free-form YAML because parsers drift.'],
  unresolved_questions: ['Who verifies the candidate?'],
};

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
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

describe('Report handover v1 normalization', () => {
  it('fills the complete stable wire shape and trims items', () => {
    expect(normalizeReportHandover({ decisions: ['  decide once  '] })).toEqual({
      schema_version: 1,
      decisions: ['decide once'],
      assumptions: [],
      alternatives_rejected: [],
      unresolved_questions: [],
    });
    expect(normalizeReportHandover(null)).toBeNull();
  });

  it.each([
    ['a scalar', 'text'],
    ['an array', []],
    ['another version', { schema_version: 2 }],
    ['an unknown key', { instructions: [] }],
    ['a non-array category', { decisions: 'yes' }],
    ['a non-string item', { assumptions: [42] }],
    ['a blank item', { unresolved_questions: ['   '] }],
    ['a multiline item', { decisions: ['first\nsecond'] }],
    ['too many items', { decisions: Array.from({ length: 51 }, (_, i) => `d${i}`) }],
    ['an overlong item', { decisions: ['x'.repeat(2001)] }],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeReportHandover(value)).toThrow(ReportHandoverValidationError);
  });
});

describe('Report handover REST create/update', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.create.mockResolvedValue({ id: RID, handover: fullHandover } as never);
    manager.update.mockResolvedValue({ id: RID, handover: fullHandover } as never);
  });

  it('normalizes POST and PATCH, and PATCH null clears', async () => {
    await withServer(async base => {
      const post = await fetch(`${base}/reports`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', content: 'C', handover: { decisions: [' D '] } }),
      });
      expect(post.status).toBe(201);
      expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({ handover: {
        schema_version: 1, decisions: ['D'], assumptions: [],
        alternatives_rejected: [], unresolved_questions: [],
      } }));

      const patch = await fetch(`${base}/reports/${RID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handover: null }),
      });
      expect(patch.status).toBe(200);
      expect(manager.update).toHaveBeenCalledWith(RID, expect.objectContaining({ handover: null }));
    });
  });

  it('returns stable 400 INVALID_REPORT_HANDOVER before persistence', async () => {
    await withServer(async base => {
      const response = await fetch(`${base}/reports`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', content: 'C', handover: { decisions: ['bad\nline'] } }),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { code: string }).code).toBe('INVALID_REPORT_HANDOVER');
      expect(manager.create).not.toHaveBeenCalled();
    });
  });
});

describe('ReportManager handover persistence and Brief projection', () => {
  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: RID, title: 'T', content: 'C', summary: null, tags: [], project_id: PID,
      task_ids: [TID], author: 'system', author_actor_id: null, origin: 'api',
      visibility: 'default', handover: fullHandover, pinned: false, status: 'active',
      created_at: 'now', updated_at: 'now', deleted_at: null, ...overrides,
    };
  }

  it('persists canonical JSON on create and update, and maps it back', async () => {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const pool = { query: jest.fn(async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      if (/INSERT INTO reports/i.test(text)) return { rows: [{ id: RID, project_id: null, author_actor_id: null }], rowCount: 1 };
      if (/UPDATE reports SET/i.test(text)) return { rows: [{ project_id: null, author_actor_id: null }], rowCount: 1 };
      if (/FROM reports r/i.test(text)) return { rows: [row()], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }) } as { query: jest.Mock; connect?: unknown };
    pool.connect = async () => ({ query: pool.query, release: () => undefined });
    const subject = new ReportManager(pool as never);
    expect((await subject.create({ title: 'T', content: 'C', handover: fullHandover })).handover).toEqual(fullHandover);
    const insert = queries.find(query => /INSERT INTO reports/i.test(query.text))!;
    expect(insert.text).toContain('handover');
    expect(insert.params).toContain(JSON.stringify(fullHandover));

    queries.length = 0;
    await subject.update(RID, { handover: null });
    const update = queries.find(query => /UPDATE reports SET/i.test(query.text))!;
    expect(update.text).toContain('handover');
    expect(update.params).toContain(null);
  });

  it('projects only bounded structured fields and reports omitted count', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [
      row({ total_count: '52' }), row({ id: '44444444-4444-4444-8444-444444444444', status: 'archived', total_count: '52' }),
    ] })) };
    const subject = new ReportManager(pool as never);
    const result = await subject.getStructuredHandoversForTask(TID, PID);
    expect(result.reports).toHaveLength(2);
    expect(result.reports[1].status).toBe('archived');
    expect(result.reports[0]).toEqual(expect.objectContaining({ id: RID, title: 'T', handover: fullHandover }));
    expect(result.omitted).toBe(50);
    const [sql, params] = pool.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('project_id = $2::uuid');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual([TID, PID]);
  });

  it('migration adds a nullable JSONB object with a durable type check', () => {
    const migration = readFileSync(path.join(__dirname, '../migrations/088_report_handover.sql'), 'utf8');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS handover JSONB');
    expect(migration).toContain("handover IS NULL OR jsonb_typeof(handover) = 'object'");
  });
});
