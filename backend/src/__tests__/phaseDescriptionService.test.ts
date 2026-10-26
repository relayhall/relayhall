/** AZ-A10 clause 12: description storage and the route-facing length limit. */
jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../services/FeedEventService', () => ({
  feedEventService: { emit: jest.fn() },
  // Card 5854f0d6: the emit helper the service composes, kept real.
  feedActorFields: jest.requireActual('../services/FeedEventService').feedActorFields,
}));
jest.mock('../services/LifecyclePolicyService', () => ({
  lifecyclePolicyService: { evaluate: jest.fn() },
}));

import { pool } from '../db/connection';
import { PhaseError, phaseService } from '../services/PhaseService';

const PROJECT = '22222222-2222-4222-8222-222222222222';
const PHASE = '11111111-1111-4111-8111-111111111111';
const REVISION = '33333333-3333-4333-8333-333333333333';
const row = (description: string | null) => ({
  id: PHASE, project_id: PROJECT, name: 'Slice', goal: null, description,
  status: 'todo', position: 0, restricted_access: false, revision: REVISION,
  created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z',
});

const query = jest.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes('FROM projects')) return { rows: [{ id: PROJECT, status: 'active' }] };
  if (sql.includes('FROM phases')) return { rows: [row('Earlier context')] };
  if (sql.includes('INSERT INTO phases')) return { rows: [row((params?.[4] as string | null) ?? null)] };
  if (sql.includes('UPDATE phases SET')) return { rows: [row((params?.[0] as string | null) ?? null)] };
  return { rows: [] };
});

beforeEach(() => {
  query.mockClear();
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
});

it('stores and returns a description on create, including the 20,000-character boundary', async () => {
  const description = '😀'.repeat(20000);
  const created = await phaseService.create({ projectId: PROJECT, name: 'Slice', description }, {});
  expect(created.description).toBe(description);
  const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO phases'));
  expect(insert?.[0]).toContain('goal, description, status');
  expect(insert?.[1]?.[4]).toBe(description);
});

it('refuses overlong descriptions and invalid types before an insert', async () => {
  for (const description of ['x'.repeat(20001), 5]) {
    await expect(phaseService.create({ projectId: PROJECT, name: 'Slice', description }, {}))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_PHASE_VALUE', field: 'description' } satisfies Partial<PhaseError>);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO phases'))).toBe(false);
  }
});

it('clears description with null on revision-bound update and preserves it by omission', async () => {
  const cleared = await phaseService.update(PHASE, { revision: REVISION, description: null });
  expect(cleared.description).toBeNull();
  const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE phases SET'));
  expect(update?.[0]).toContain('description = $1');
  expect(update?.[1]?.[0]).toBeNull();

  query.mockClear();
  await phaseService.update(PHASE, { revision: REVISION, name: 'Renamed' });
  const rename = query.mock.calls.find(([sql]) => sql.includes('UPDATE phases SET'));
  expect(rename?.[0]).not.toContain('description =');
});
