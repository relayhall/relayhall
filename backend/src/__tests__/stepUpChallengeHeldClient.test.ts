/**
 * Card 72b8fb97, review r1 change 2: the SU-14 challenge's `methods` lookup
 * runs on the step-up consumer's HELD client, never on a second pool
 * connection.
 *
 * A refused consumer still holds its transaction client (and, for a reveal,
 * a row lock). Asking the pool for up to four more connections from there
 * waits, under a saturated pool, for the pool's connection timeout and then
 * drops `methods`. These pin that every read of the challenge goes through
 * the client the consumer handed `consume` (or `stepUpRequiredError`), in
 * order, and that the pool is never touched: the pool double below fails
 * every query, so a pool read would leave `methods` out and turn these red.
 */
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(async () => { throw new Error('the pool must not be asked while the client is held'); }) },
}));

import { pool } from '../db/connection';
import { stepUpService, stepUpRequiredError, StepUpError } from '../services/StepUpService';

interface HeldClient { seen: string[]; query: jest.Mock }

/** A transaction client double: the refused UPDATE, then the methods reads. */
function heldClient(options: { password: boolean }): HeldClient {
  const seen: string[] = [];
  const query = jest.fn(async (text: string) => {
    seen.push(text);
    if (/UPDATE step_up_tokens/.test(text)) return { rows: [] };
    if (/FROM principal_credentials/.test(text)) return { rows: options.password ? [{ hit: 1 }] : [] };
    if (/FROM identity_providers/.test(text)) return { rows: [] };
    if (/FROM identity_links/.test(text)) return { rows: [] };
    throw new Error('unexpected query on the held client');
  });
  return { seen, query };
}

const PRINCIPAL = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const savedHash = process.env.DASHBOARD_PASSWORD_HASH;

beforeEach(() => {
  delete process.env.DASHBOARD_PASSWORD_HASH;
  (pool.query as jest.Mock).mockClear();
});
afterAll(() => {
  if (savedHash === undefined) delete process.env.DASHBOARD_PASSWORD_HASH;
  else process.env.DASHBOARD_PASSWORD_HASH = savedHash;
});

describe('the challenge is built on the consumer\'s held client', () => {
  it('a refused consume reads methods through the client it was given, after its own UPDATE, and never the pool', async () => {
    const client = heldClient({ password: true });
    const refused = await stepUpService.consume(client, {
      token: 'rhsu_not_live', principalId: PRINCIPAL, action: 'approval.decide', targetId: TARGET,
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StepUpError);
    expect(refused).toMatchObject({
      status: 403, code: 'STEP_UP_REQUIRED',
      challenge: { error: 'insufficient_user_authentication', action: 'approval.decide', targetId: TARGET, max_age: 0, methods: ['password'] },
    });
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.seen[0]).toMatch(/UPDATE step_up_tokens/);
    expect(client.seen.slice(1).map((text) => (/FROM (\w+)/.exec(text) ?? [])[1])).toEqual([
      'principal_credentials', 'identity_providers',
    ]);
  });

  it('stepUpRequiredError (a consumer refusing before consume) uses the client it is handed', async () => {
    const client = heldClient({ password: false });
    const refusal = await stepUpRequiredError(PRINCIPAL, 'credential.reveal', TARGET, 'fixed sentence', client);
    expect(refusal.challenge).toEqual({
      error: 'insufficient_user_authentication', action: 'credential.reveal', targetId: TARGET, max_age: 0, methods: [],
    });
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.seen.length).toBeGreaterThan(0);
  });

  it('the control: with no client the lookup is the pool\'s, and a pool that fails leaves methods out and the refusal unchanged', async () => {
    const refusal = await stepUpRequiredError(PRINCIPAL, 'credential.reveal', TARGET, 'fixed sentence');
    expect(pool.query).toHaveBeenCalled();
    expect(refusal).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED', message: 'fixed sentence' });
    expect(refusal.challenge).toEqual({ error: 'insufficient_user_authentication', action: 'credential.reveal', targetId: TARGET, max_age: 0 });
  });
});
