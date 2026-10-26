/**
 * Card 785e1eed P2-B slice 1 (AZ-A10 clause 6): the write-side contract of
 * `roleGrantExpiresAt` that holds on every commit without a database — the
 * field's shape refusals (the deadline conventions, renamed), its place in the
 * assigning act (only beside an executionProfile, never beside a Warrant,
 * after the act's own services:invoke gate), and the MCP surface that forwards
 * it. The stored behaviour — dates on rows and links, the shared-row maximum,
 * the reapers, the audit — is measured on a real PostgreSQL by
 * roleGrantExpiryLive.test.ts.
 */
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { Validator } from '@cfworker/json-schema';
import { pool } from '../db/connection';
import { assigningActExpiry, normalizeRoleGrantExpiresAtWrite } from '../utils/roleGrantExpiry';
import { TaskFieldError } from '../utils/taskWriteFields';
import type { DueAtResolver } from '../utils/dueAtResolver';
import { resolveExecutionProfileWrite } from '../routes/tasks';
import { ProfileValidationError } from '../utils/executionProfile';
import { toolByName } from '../mcp/registry';
import * as rest from '../mcp/rest';
import { buildOpenApiSpec } from '../openapi/spec';
import { CLAUDE_CODE_DESCRIPTOR } from './fixtures/serviceDescriptors';

const SERVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK = '33333333-3333-4333-8333-333333333333';

/** A resolver that answers like PostgreSQL for the two fixed cases the suite
 * uses, and records every call so a refusal can be shown to happen BEFORE it. */
function fakeResolver(): DueAtResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fixedOffset(local, offset) {
      calls.push(`fixed ${local} ${offset}`);
      if (local === '2030-01-15 08:00:00.000000' && offset === '+00:00:00') {
        return { instantIso: '2030-01-15T08:00:00.000000Z', backLocal: '2030-01-15T08:00:00.000000', offsetSeconds: 0, inRange: true };
      }
      return null;
    },
    async zoned(local, zone) {
      calls.push(`zoned ${local} ${zone}`);
      if (zone !== 'Europe/Warsaw') return { zoneKnown: false, zoneName: null, candidates: [] };
      if (local === '2027-03-28 02:30:00.000000') {
        // The forward gap: PostgreSQL normalizes to 03:30, which reads back differently.
        return { zoneKnown: true, zoneName: 'Europe/Warsaw', candidates: [
          { instantIso: '2027-03-28T01:30:00.000000Z', backLocal: '2027-03-28T03:30:00.000000', offsetSeconds: 7200, inRange: true },
        ] };
      }
      return { zoneKnown: true, zoneName: 'Europe/Warsaw', candidates: [
        { instantIso: '2030-01-15T08:00:00.000000Z', backLocal: '2030-01-15T09:00:00.000000', offsetSeconds: 3600, inRange: true },
      ] };
    },
  };
}

async function refusal(value: unknown, resolver = fakeResolver()): Promise<TaskFieldError> {
  try {
    await normalizeRoleGrantExpiresAtWrite(value, resolver);
  } catch (error) {
    expect(error).toBeInstanceOf(TaskFieldError);
    return error as TaskFieldError;
  }
  throw new Error(`expected a refusal for ${JSON.stringify(value)}`);
}

describe('roleGrantExpiresAt: the deadline conventions, renamed for the field', () => {
  it('absence is the default and is not represented', async () => {
    expect(await normalizeRoleGrantExpiresAtWrite(undefined, fakeResolver())).toBeUndefined();
  });

  it("'unlimited' is clause 6's literal for expires_at NULL, and needs no resolver", async () => {
    const resolver = fakeResolver();
    expect(await normalizeRoleGrantExpiresAtWrite('unlimited', resolver)).toEqual({ kind: 'unlimited' });
    expect(resolver.calls).toEqual([]);
  });

  it('an instant is proved by the resolver and returned in the canonical spelling', async () => {
    expect(await normalizeRoleGrantExpiresAtWrite('2030-01-15T08:00:00Z', fakeResolver()))
      .toEqual({ kind: 'instant', instant: '2030-01-15T08:00:00.000000Z' });
  });

  it('{ local, zone } is resolved by the server and carries its receipt', async () => {
    const value = await normalizeRoleGrantExpiresAtWrite({ local: '2030-01-15T09:00:00', zone: 'Europe/Warsaw' }, fakeResolver());
    expect(value).toMatchObject({ kind: 'instant', instant: '2030-01-15T08:00:00.000000Z',
      resolution: { zone: 'Europe/Warsaw', instant: '2030-01-15T08:00:00.000000Z', offset: '+01:00', chosen: 'postgresql' } });
  });

  it.each([
    ['a bare date: it names no instant until a zone is chosen', '2027-01-15', 'INVALID_ROLE_GRANT_EXPIRY'],
    ['null: neither the default nor unlimited', null, 'INVALID_ROLE_GRANT_EXPIRY'],
    ['a capitalized literal', 'Unlimited', 'INVALID_ROLE_GRANT_EXPIRY'],
    ['a number', 1700000000000, 'INVALID_ROLE_GRANT_EXPIRY'],
    ['an array', ['2030-01-15T08:00:00Z'], 'INVALID_ROLE_GRANT_EXPIRY'],
    ['seven fractional digits', '2030-01-15T08:00:00.1234567Z', 'INVALID_ROLE_GRANT_EXPIRY_PRECISION'],
    ['a zone the server does not know', { local: '2030-01-15T09:00:00', zone: 'Nowhere/Atlantis' }, 'INVALID_ROLE_GRANT_EXPIRY_ZONE'],
    ['a wall clock inside the spring-forward gap', { local: '2027-03-28T02:30:00', zone: 'Europe/Warsaw' }, 'INVALID_ROLE_GRANT_EXPIRY_LOCAL_TIME'],
    ['year zero', '0000-06-01T00:00:00Z', 'INVALID_ROLE_GRANT_EXPIRY_RANGE'],
  ])('refuses %s', async (_label, value, code) => {
    const refused = await refusal(value);
    expect([refused.code, refused.field]).toEqual([code, 'roleGrantExpiresAt']);
    expect(refused.message).toContain('roleGrantExpiresAt');
    expect(refused.message).not.toMatch(/\bdueAt\b/);
  });

  it('a bare date is refused by shape, before PostgreSQL is asked anything', async () => {
    const resolver = fakeResolver();
    await refusal('2027-01-15', resolver);
    expect(resolver.calls).toEqual([]);
  });
});

function armPool(): void {
  (pool.query as jest.Mock).mockImplementation(async (text: string) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT * FROM services WHERE')) {
      return { rows: [{
        id: SERVICE_ID, slug: 'my-runner', name: 'My Runner', description: '', kind: 'connector', runtime_mode: 'direct',
        status: 'published', visibility_tier: 'assigned-only', delivery_mode: 'none', delivery_endpoint: null,
        delivery_poll_interval_seconds: null, telemetry_tier: 'none', current_descriptor_version: 1, revision: 'rev',
        created_by_principal_id: null, updated_by_principal_id: null, created_at: 'now', updated_at: 'now', retired_at: null,
      }] };
    }
    if (sql.startsWith('SELECT version, descriptor, content_hash')) {
      return { rows: [{ version: 1, descriptor: CLAUDE_CODE_DESCRIPTOR, content_hash: 'h', created_by_principal_id: null, created_at: 'now', retired_at: null }] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
  });
}

const TARGETING = { executionProfile: { serviceId: 'my-runner', options: { model: 'claude-fable-5' } } };
const invoker = (): any => ({ scopes: ['tasks:write', 'services:invoke'] });
const writerOnly = (): any => ({ scopes: ['tasks:write'] });

async function refusedWith(payload: any, req: any, status: number, code: string): Promise<void> {
  try {
    await resolveExecutionProfileWrite({ ...payload }, req);
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileValidationError);
    expect([(error as ProfileValidationError).status, (error as ProfileValidationError).code]).toEqual([status, code]);
    return;
  }
  throw new Error(`expected ${code}, got success`);
}

describe('roleGrantExpiresAt belongs to the assigning act', () => {
  beforeEach(() => { jest.clearAllMocks(); armPool(); });

  it('is refused without an executionProfile, or beside a null one: there is no assignment to date', async () => {
    await refusedWith({ roleGrantExpiresAt: 'unlimited' }, invoker(), 422, 'ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT');
    await refusedWith({ executionProfile: null, roleGrantExpiresAt: 'unlimited' }, invoker(), 422, 'ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT');
  });

  it('is refused beside a Warrant, which writes no grant rows to date', async () => {
    await refusedWith({ ...TARGETING, executionWarrantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', roleGrantExpiresAt: 'unlimited' },
      invoker(), 422, 'ROLE_GRANT_EXPIRY_WITH_WARRANT');
  });

  it('meets the act\'s own services:invoke gate first: a writer without it learns nothing about the date', async () => {
    await refusedWith({ ...TARGETING, roleGrantExpiresAt: 'not a date' }, writerOnly(), 403, 'PROFILE_INVOKE_REQUIRED');
  });

  it('asks nothing about WHO the assigner is: any credential that performs the act carries the date through', async () => {
    const out = await resolveExecutionProfileWrite({ ...TARGETING, roleGrantExpiresAt: 'unlimited' }, invoker());
    expect(assigningActExpiry(out)).toEqual({ kind: 'unlimited' });
    expect('roleGrantExpiresAt' in out).toBe(false);
    expect(out.executionServiceId).toBe(SERVICE_ID);
  });

  it('is absent from the payload when the caller did not send it', async () => {
    const out = await resolveExecutionProfileWrite({ ...TARGETING }, invoker());
    expect(assigningActExpiry(out)).toBeUndefined();
  });

  // Review round 1, B1: the normalized date once rode the payload as a
  // body-shaped key, which PATCH /tasks/:id read straight from the body.
  it('reads no body field as the date: a raw roleGrantExpiry from a JSON body is never the act\'s date', async () => {
    const raw = { roleGrantExpiry: { kind: 'instant', instant: 'garbage' } };
    const bare = await resolveExecutionProfileWrite(JSON.parse(JSON.stringify(raw)), writerOnly());
    expect(assigningActExpiry(bare)).toBeUndefined();
    const beside = await resolveExecutionProfileWrite(JSON.parse(JSON.stringify({ ...TARGETING, ...raw })), invoker());
    expect(assigningActExpiry(beside)).toBeUndefined();
    const both = await resolveExecutionProfileWrite(
      JSON.parse(JSON.stringify({ ...TARGETING, ...raw, roleGrantExpiresAt: 'unlimited' })), invoker());
    expect(assigningActExpiry(both)).toEqual({ kind: 'unlimited' });
  });
});

describe('the MCP surface forwards the date and prints what was applied', () => {
  afterEach(() => jest.restoreAllMocks());
  const properties = (name: string) => (toolByName(name)!.inputSchema.properties as Record<string, any>);

  it('relayhall_task_create and relayhall_task_recover share ONE schema object', () => {
    expect(properties('relayhall_task_recover').roleGrantExpiresAt).toBe(properties('relayhall_task_create').roleGrantExpiresAt);
  });

  const validator = new Validator(properties('relayhall_task_create').roleGrantExpiresAt);
  it.each(['2030-01-15T08:00:00Z', 'unlimited', { local: '2030-01-15T09:00:00', zone: 'Europe/Warsaw' }])(
    'admits %j structurally', (value) => expect(validator.validate(value).valid).toBe(true));
  it.each([null, 1, [], {}, { local: '2030-01-15T09:00:00' }, { local: '2030-01-15T09:00:00', zone: 'Europe/Warsaw', extra: 1 }])(
    'refuses %j structurally', (value) => expect(validator.validate(value).valid).toBe(false));

  it('relayhall_task_create sends the field to POST /tasks and prints the applied date', async () => {
    const board = jest.spyOn(rest, 'board').mockResolvedValue({
      task: { id: TASK, title: 'Dated', status: 'todo' }, roleGrantExpiresAt: '2030-01-15T08:00:00.000000Z',
    });
    const text = await toolByName('relayhall_task_create')!.handler(
      { title: 'Dated', idempotencyKey: 'dated-retry-token-0001', executionProfile: { serviceId: SERVICE_ID }, roleGrantExpiresAt: '2030-01-15T08:00:00Z' },
      { authorization: 'Bearer fixture', toolName: 'relayhall_task_create' });
    expect(board).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      method: 'POST', path: '/tasks', body: expect.objectContaining({ roleGrantExpiresAt: '2030-01-15T08:00:00Z' }),
    }));
    expect(text).toContain('assignment grant rows expire: 2030-01-15T08:00:00.000000Z');
  });

  it('relayhall_task_create says "until the task or the assignment ends" for unlimited, and nothing when no grant rows were dated', async () => {
    jest.spyOn(rest, 'board').mockResolvedValueOnce({ task: { id: TASK, title: 'U', status: 'todo' }, roleGrantExpiresAt: 'unlimited' })
      .mockResolvedValueOnce({ task: { id: TASK, title: 'P', status: 'todo' } });
    const ctx = { authorization: 'Bearer fixture', toolName: 'relayhall_task_create' };
    const unlimited = await toolByName('relayhall_task_create')!.handler({ title: 'U', idempotencyKey: 'dated-retry-token-0002' }, ctx);
    expect(unlimited).toContain('until the task or the assignment ends');
    const plain = await toolByName('relayhall_task_create')!.handler({ title: 'P', idempotencyKey: 'dated-retry-token-0003' }, ctx);
    expect(plain).not.toContain('assignment grant rows');
  });

  it('relayhall_task_recover forwards the field to POST /tasks/:id/recover', async () => {
    const board = jest.spyOn(rest, 'board').mockResolvedValue({ recovery: { outcome: 'recovered' } });
    await toolByName('relayhall_task_recover')!.handler(
      { task: TASK, executionProfile: { serviceId: SERVICE_ID }, roleGrantExpiresAt: 'unlimited' },
      { authorization: 'Bearer fixture', toolName: 'relayhall_task_recover' });
    expect(board).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      path: `/tasks/${TASK}/recover`, body: expect.objectContaining({ roleGrantExpiresAt: 'unlimited' }),
    }));
  });

  it('OpenAPI documents the field on the shared Task write schema, with every refusal code', () => {
    const spec = buildOpenApiSpec() as any;
    const description = String(spec.components.schemas.TaskSharedWriteFields.properties.roleGrantExpiresAt.description);
    for (const code of ['ROLE_GRANT_EXPIRY_WITHOUT_ASSIGNMENT', 'ROLE_GRANT_EXPIRY_WITH_WARRANT', 'INVALID_EXPIRY',
      'INVALID_ROLE_GRANT_EXPIRY', 'INVALID_ROLE_GRANT_EXPIRY_PRECISION', 'INVALID_ROLE_GRANT_EXPIRY_RANGE',
      'INVALID_ROLE_GRANT_EXPIRY_ZONE', 'INVALID_ROLE_GRANT_EXPIRY_LOCAL_TIME']) {
      expect(description).toContain(code);
    }
    expect(description).toMatch(/EARLIER/);
  });
});
