jest.mock('../db/connection', () => {
  const pool: { query: jest.Mock; connect?: unknown } = { query: jest.fn() };
  // The RH-P3.C1 transactional wrap frames writes with BEGIN/COMMIT and the
  // feed emission statements. Absorb those here so this suite's positional
  // mockResolvedValueOnce queues keep lining up with the REAL statements the
  // tests are about.
  pool.connect = jest.fn(async () => ({
    query: (t: string, p?: unknown[]) =>
      /^(BEGIN|COMMIT|ROLLBACK)/.test(String(t).trim())
        || /pg_advisory_xact_lock|INSERT INTO feed_events/i.test(String(t))
        ? Promise.resolve({ rows: [], rowCount: 0 })
        : pool.query(t, p),
    release: () => undefined,
  }));
  return { pool };
});

import { pool } from '../db/connection';
import { personalityService } from '../services/PersonalityService';
import { PERSONALITY_SNAPSHOT_FIELDS } from '../utils/personalityVersion';

const query = pool.query as jest.Mock;
const row = {
  id: '00000000-0000-4000-8000-000000000099', slug: 'security-reviewer',
  name: 'Security Reviewer', description: null, category: 'custom', color: 'blue',
  content: null, source_file: null, is_custom: true, source: 'managed',
  retired_at: null, retired_reason: null, retired_in_favor_of: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

const versioned = (value: Record<string, unknown>, version = 1) => ({ ...value, current_version: version, resolved_version: version, version_parent_id: value.id, version_snapshot: Object.fromEntries(PERSONALITY_SNAPSHOT_FIELDS.map(key => [key, value[key]])) });

describe('board-managed personalities', () => {
  beforeEach(() => query.mockReset());

  it('creates a managed personality rather than requiring a repository', async () => {
    query.mockResolvedValueOnce({ rows: [row] });
    query.mockResolvedValueOnce({ rows: [versioned(row)] });
    const result = await personalityService.create({ slug: row.slug, name: row.name });
    expect(result?.source).toBe('managed');
    expect(query.mock.calls[0][0]).toContain("'managed'");
  });

  it('updates only the supported mutable fields', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...row, description: 'Adversarial review' }] });
    query.mockResolvedValueOnce({ rows: [versioned({ ...row, description: 'Adversarial review' }, 2)] });
    const result = await personalityService.update(row.id, { description: 'Adversarial review' });
    expect(result?.description).toBe('Adversarial review');
    expect(query.mock.calls[0][0]).toContain('description = $2');
  });

  it('protects the default generalist from retirement', async () => {
    query.mockResolvedValueOnce({ rows: [versioned({ ...row, slug: 'generalist', source: 'built-in' })] });
    await expect(personalityService.retire('00000000-0000-4000-8000-000000000001')).rejects.toThrow('Only managed');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('soft-retires other personalities', async () => {
    const retired = { ...row, retired_at: new Date().toISOString() };
    query.mockResolvedValueOnce({ rows: [versioned(row)] });
    query.mockResolvedValueOnce({ rows: [retired] });
    query.mockResolvedValueOnce({ rows: [versioned(retired)] });
    const result = await personalityService.retire(row.id, 'consolidated');
    expect(result?.retired_at).toBeTruthy();
    expect(query.mock.calls[1][0]).toContain('retired_at = now()');
  });
});
