/**
 * reportsContentHash.test.ts — reports hardening item 2 (task c655d243):
 * server-computed sha256 content_hash on INSERT/UPDATE (backend code, no
 * trigger); exposed on mapped rows. Backfill itself is covered by migration
 * 056 (pgcrypto digest, verified by dev smoke).
 */
import crypto from 'crypto';
import { ReportManager } from '../services/ReportManager';

const RID = '11111111-1111-4111-8111-111111111111';

function fullRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RID, title: 't', content: 'c', content_hash: 'deadbeef', summary: null,
    tags: [], project_id: null, task_ids: [], author: 'nim', pinned: false,
    created_at: '2026-07-21T00:00:00Z', updated_at: '2026-07-21T00:00:00Z',
    ...overrides,
  };
}

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
      if (/FROM reports r/i.test(text)) return { rows: [fullRow()], rowCount: 1 };
      if (/UPDATE reports SET/i.test(text)) return { rows: [{ project_id: null, author_actor_id: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

describe('report content_hash (server-computed sha256)', () => {
  it('computes the canonical sha256 hex digest', () => {
    expect(ReportManager.computeContentHash('hello world'))
      .toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('INSERT includes content_hash derived from content', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).create({ title: 'T', content: '# body\nline' });
    const insert = pool.queries.find(q => /INSERT INTO reports/i.test(q.text))!;
    expect(insert.text).toContain('content_hash');
    expect(insert.params[2]).toBe(sha256('# body\nline'));
  });

  it('UPDATE with content recomputes content_hash', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).update(RID, { content: 'new content' });
    const update = pool.queries.find(q => /UPDATE reports SET/i.test(q.text))!;
    expect(update.text).toContain('content_hash');
    expect(update.params).toContain(sha256('new content'));
  });

  it('UPDATE without content leaves content_hash untouched', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).update(RID, { title: 'renamed' });
    const update = pool.queries.find(q => /UPDATE reports SET/i.test(q.text))!;
    expect(update.text).not.toContain('content_hash');
  });

  it('mapped rows expose content_hash', async () => {
    const pool = fakePool();
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.content_hash).toBe('deadbeef');
  });
});
