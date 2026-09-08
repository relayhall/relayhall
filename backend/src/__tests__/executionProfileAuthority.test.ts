/**
 * The §2.1 profile-set authority check (RH-P2.2): setting a profile that
 * TARGETS a service requires services:invoke (or root) on top of the
 * route's tasks:write — filling arguments is choosing what executes, so
 * bare task-write must never be enough. Clearing a profile and writing a
 * basic (no-service) task stay plain tasks:write. Missing/null scopes fail
 * closed on every identity path.
 *
 * Also pinned: the D-15 hard cut — executionMode and the legacy profile
 * shape are refused on the write path with the retirement named.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import { resolveExecutionProfileWrite } from '../routes/tasks';
import { ProfileValidationError } from '../utils/executionProfile';
import { CLAUDE_CODE_DESCRIPTOR } from './fixtures/serviceDescriptors';

const SERVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function armPool(): void {
  (pool.query as jest.Mock).mockImplementation(async (text: string) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT * FROM services WHERE')) {
      return {
        rows: [{
          id: SERVICE_ID, slug: 'my-runner', name: 'My Runner', description: '',
          kind: 'connector', runtime_mode: 'direct', status: 'published',
          visibility_tier: 'assigned-only', delivery_mode: 'none',
          delivery_endpoint: null, delivery_poll_interval_seconds: null,
          telemetry_tier: 'none', current_descriptor_version: 1,
          revision: 'rev', created_by_principal_id: null, updated_by_principal_id: null,
          created_at: 'now', updated_at: 'now', retired_at: null,
        }],
      };
    }
    if (sql.startsWith('SELECT version, descriptor, content_hash')) {
      return {
        rows: [{
          version: 1, descriptor: CLAUDE_CODE_DESCRIPTOR, content_hash: 'h',
          created_by_principal_id: null, created_at: 'now', retired_at: null,
        }],
      };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
  });
}

const TARGETING = { executionProfile: { serviceId: 'my-runner', options: { model: 'claude-fable-5' } } };

function req(scopes: string[] | null): any {
  return { scopes };
}

async function expectRefusal(payload: any, request: any, status: number, code: string): Promise<void> {
  try {
    await resolveExecutionProfileWrite({ ...payload }, request);
    throw new Error(`expected ProfileValidationError ${code}, got success`);
  } catch (e) {
    if (e instanceof ProfileValidationError) {
      expect(e.status).toBe(status);
      expect(e.code).toBe(code);
      return;
    }
    throw e;
  }
}

beforeEach(armPool);

describe('§2.1: profile-set targeting a service needs invoke, never bare task-write', () => {
  it('a scoped key WITHOUT services:invoke is refused (403)', async () => {
    await expectRefusal(TARGETING, req(['tasks:write', 'services:write']), 403, 'PROFILE_INVOKE_REQUIRED');
  });

  it('authority precedes lookup: a task-writer-only request performs ZERO registry reads and gets one generic refusal regardless of guessed content (review 66c78a1d F1)', async () => {
    // Existing service, nonsense service, undeclared options — identical
    // generic refusal, and the Service registry is never consulted, so
    // neither service existence nor descriptor vocabulary can leak.
    const guesses = [
      TARGETING,
      { executionProfile: { serviceId: 'no-such-service', options: {} } },
      { executionProfile: { serviceId: 'my-runner', options: { privateProbe: 1 } } },
    ];
    for (const guess of guesses) {
      await expectRefusal(guess, req(['tasks:write']), 403, 'PROFILE_INVOKE_REQUIRED');
    }
    expect(pool.query as jest.Mock).not.toHaveBeenCalled();
  });

  it('services:invoke passes and the pin columns are populated', async () => {
    const out = await resolveExecutionProfileWrite({ ...TARGETING }, req(['tasks:write', 'services:invoke']));
    expect(out.executionServiceId).toBe(SERVICE_ID);
    expect(out.executionDescriptorVersion).toBe(1);
    expect(out.executionProfile.options.model).toBe('claude-fable-5');
  });

  it('root passes', async () => {
    const out = await resolveExecutionProfileWrite({ ...TARGETING }, req(['root']));
    expect(out.executionServiceId).toBe(SERVICE_ID);
  });

  it('null-scope identities fail closed before any registry lookup', async () => {
    (pool.query as jest.Mock).mockClear();
    await expectRefusal(TARGETING, req(null), 403, 'PROFILE_INVOKE_REQUIRED');
    expect(pool.query as jest.Mock).not.toHaveBeenCalled();
  });

  it('clearing a profile needs no invoke', async () => {
    const out = await resolveExecutionProfileWrite({ executionProfile: null }, req(['tasks:write']));
    expect(out.executionProfile).toBeNull();
    expect(out.executionServiceId).toBeNull();
    expect(out.executionDescriptorVersion).toBeNull();
  });

  it('a basic task (no profile) needs no invoke', async () => {
    const out = await resolveExecutionProfileWrite({ title: 'x', model: 'claude-fable-5' }, req(['tasks:write']));
    expect(out.executionProfile).toBeUndefined();
  });
});

describe('D-15 hard cut on the write path', () => {
  it('executionMode is refused with the retirement named', async () => {
    await expectRefusal({ executionMode: 'subagent' }, req(['root']), 400, 'FIELD_RETIRED');
  });

  it('the legacy mode/harness/accessProfile shape is refused with the retirement named', async () => {
    await expectRefusal(
      { executionProfile: { mode: 'subagent', harness: 'hermes', accessProfile: 'dev' } },
      req(['root']),
      400,
      'FIELD_RETIRED',
    );
  });
});
