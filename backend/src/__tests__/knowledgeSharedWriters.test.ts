/**
 * Card 549cc51f — the shared-area writer list, the parts a mocked pool can
 * measure: the input rules (reason, expiry, Account id) and which source an act
 * or a read is about when the caller names none. Everything that needs stored
 * rows (the gate, the step-up, the audit, the sweep, the snapshot element) is
 * measured against a real PostgreSQL in knowledgeSharedWritersLive.
 */
jest.mock('../db/connection', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));

import {
  canonicalAccountId, resolveSharedWriterSource, validateSharedWriterExpiry, validateSharedWriterReason,
  SharedWriterError, SHARED_WRITER_AUDIT_ACTIONS, SHARED_WRITER_STEP_UP_ACTIONS,
} from '../services/KnowledgeSharedWriterService';

const SOURCE = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'brain', name: 'Brain' };

function queryable(rows: unknown[][]): { query: jest.Mock } {
  const query = jest.fn();
  for (const answer of rows) query.mockResolvedValueOnce({ rows: answer });
  return { query };
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string; field?: string }> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(SharedWriterError);
    const error = e as SharedWriterError;
    return { status: error.status, code: error.code, ...(error.field ? { field: error.field } : {}) };
  }
  throw new Error('expected a refusal');
}

describe('card 549cc51f — the shared-area writer list input rules', () => {
  it('the reason is 20-2000 characters after trimming', () => {
    expect(validateSharedWriterReason(`  ${'r'.repeat(20)}  `)).toBe('r'.repeat(20));
    expect(validateSharedWriterReason('r'.repeat(2000))).toHaveLength(2000);
    for (const bad of ['x'.repeat(19), 'x'.repeat(2001), '', '   ', undefined, 42]) {
      expect(() => validateSharedWriterReason(bad)).toThrow(SharedWriterError);
    }
  });

  it('the expiry is optional, ISO-8601 and in the future', () => {
    const now = Date.parse('2026-10-16T12:00:00.000Z');
    for (const never of [undefined, null, '']) expect(validateSharedWriterExpiry(never, now)).toBeNull();
    expect(validateSharedWriterExpiry('2026-10-17T12:00:00Z', now)).toBe('2026-10-17T12:00:00.000Z');
    for (const bad of ['2026-10-16T11:59:59Z', '2026-10-16T12:00:00Z', 'tomorrow', '2026-10-17', 1, {}]) {
      expect(() => validateSharedWriterExpiry(bad, now)).toThrow(SharedWriterError);
    }
  });

  it('an Account id is a UUID in canonical lower case; anything else is no id', () => {
    expect(canonicalAccountId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe(SOURCE.id);
    for (const bad of ['grace', 'aaaaaaaa', '', null, 7]) expect(canonicalAccountId(bad)).toBeNull();
  });

  it('the step-up actions keep the ratified spelling; the audit actions satisfy the ledger CHECK (087)', () => {
    expect(SHARED_WRITER_STEP_UP_ACTIONS).toEqual({ add: 'knowledge.shared-writer.add', remove: 'knowledge.shared-writer.remove' });
    for (const action of Object.values(SHARED_WRITER_AUDIT_ACTIONS)) expect(action).toMatch(/^[a-z][a-z0-9_.]{2,127}$/);
  });
});

describe('card 549cc51f — which source an act is about', () => {
  it('omitted: the ONE write-configured source', async () => {
    const db = queryable([[SOURCE]]);
    await expect(resolveSharedWriterSource(db, undefined)).resolves.toEqual(SOURCE);
    expect(db.query.mock.calls[0][0]).toMatch(/knowledge_write_endpoint IS NOT NULL AND retired_at IS NULL/);
  });

  it('omitted with two write-configured sources: SHARED_WRITER_SOURCE_REQUIRED, never a pick', async () => {
    const db = queryable([[SOURCE, { ...SOURCE, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]]);
    expect(await refusal(resolveSharedWriterSource(db, undefined)))
      .toEqual({ status: 400, code: 'SHARED_WRITER_SOURCE_REQUIRED', field: 'source' });
  });

  it('omitted with none: SHARED_WRITER_SOURCE_NOT_FOUND', async () => {
    expect(await refusal(resolveSharedWriterSource(queryable([[]]), undefined)))
      .toEqual({ status: 404, code: 'SHARED_WRITER_SOURCE_NOT_FOUND' });
  });

  it('named: a knowledge-configured, unretired Service by canonical id; a malformed name is refused before any read', async () => {
    const db = queryable([[SOURCE]]);
    await expect(resolveSharedWriterSource(db, SOURCE.id.toUpperCase())).resolves.toEqual(SOURCE);
    expect(db.query.mock.calls[0][1]).toEqual([SOURCE.id]);
    expect(db.query.mock.calls[0][0]).toMatch(/knowledge_query_endpoint IS NOT NULL AND retired_at IS NULL/);
    const untouched = queryable([]);
    expect(await refusal(resolveSharedWriterSource(untouched, 'brain')))
      .toEqual({ status: 400, code: 'SHARED_WRITER_INVALID', field: 'source' });
    expect(untouched.query).not.toHaveBeenCalled();
    expect(await refusal(resolveSharedWriterSource(queryable([[]]), SOURCE.id)))
      .toEqual({ status: 404, code: 'SHARED_WRITER_SOURCE_NOT_FOUND' });
  });
});
