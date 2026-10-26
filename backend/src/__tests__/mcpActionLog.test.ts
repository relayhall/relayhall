/**
 * Card ab8f78e9 — the per-session MCP ACTION LOG (owner rulings E91, E89 (c)),
 * at unit scope.
 *
 * The behaviour end to end — a real MCP call making exactly one row, the
 * closed error code, the retention sweep and who may read the rows — is
 * measured against a real PostgreSQL by `mcpActionLogLive.test.ts`. This suite
 * pins what that one cannot enumerate:
 *
 *  (a) THE TARGET ALLOWLIST, per tool, against the REAL registry: every entry
 *      names a registry tool and a declared argument; every allowlisted tool
 *      records its target only from that argument and only for a complete
 *      UUID; every tool NOT allowlisted records no target even when EVERY one
 *      of its declared arguments holds a UUID;
 *  (b) THE CLOSED ERROR CODES, from the error's class and HTTP status only;
 *  (c) NO ARGUMENT IS EVER STORED: a call carrying secret-looking arguments
 *      produces a row with exactly the eleven declared columns, none of which
 *      holds any of them, and the warning a failed write logs holds none
 *      either — even when the driver's error text echoes them;
 *  (d) THE BOUND: queuing never waits, never throws, and at most
 *      `MCP_ACTION_LOG_MAX_IN_FLIGHT` writes are outstanding;
 *  (e) THE SESSION WIRING: the row is written under the live epoch's session
 *      reference and the derived owner, and nothing is queued without a live
 *      session or without an outcome;
 *  (f) THE READ: the projection reads the log only for an `mcp` session whose
 *      header resolved, narrowed per row by the caller's Account;
 *  (g) THE VOCABULARIES the code holds equal the CHECKs migration 161 holds.
 */
import fs from 'fs';
import path from 'path';

process.env.RELAYHALL_TELEMETRY_PEPPERS = process.env.RELAYHALL_TELEMETRY_PEPPERS
  || JSON.stringify({ unitpepper: Buffer.alloc(32, 5).toString('base64') });
process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER || 'unitpepper';

import {
  McpActionLog, MCP_ACTION_ERROR_CODES, MCP_ACTION_LOG_INSERT_SQL, MCP_ACTION_LOG_MAX_IN_FLIGHT,
  MCP_ACTION_LOG_WRITE_TIMEOUT_MS, MCP_ACTION_MAX_DURATION_MS, MCP_ACTION_TARGET_ARGUMENTS, MCP_ACTION_TARGET_TYPES,
  MCP_ACTION_TOOL_NAME_RE, buildMcpActionRow, mcpActionErrorCode, mcpActionTarget, type McpActionRow,
} from '../services/McpActionLog';
import {
  McpSessionTelemetry, MCP_SESSION_SOURCE_PRODUCT, mcpSessionSeed,
  type McpSessionCaller, type McpSessionTelemetryDeps,
} from '../services/McpSessionTelemetry';
import { MCP_ACTION_LOG_PRODUCT, TelemetryProjectionService } from '../services/TelemetryProjectionService';
import { TELEMETRY_RETENTION_CLASSES } from '../services/TelemetryRetentionService';
import { McpToolError, errorFromRest } from '../mcp/shape';
import { MCP_TOOLS } from '../mcp/registry';
import { resetTelemetryPepperCache, telemetrySessionReference } from '../utils/telemetryPepper';
import type { TelemetryReadScope } from '../services/TelemetryReadScope';

beforeAll(() => resetTelemetryPepperCache());

const CREDENTIAL = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const TASK = '55555555-5555-4555-8555-555555555555';
const UUID = 'abcdefab-1234-4abc-8def-0123456789ab';
const REF = `rhp_${'a'.repeat(27)}`;

/** Every argument name a tool declares, its oneOf variants included. */
function declaredArguments(tool: { inputSchema: Record<string, unknown> }): string[] {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; oneOf?: Array<{ properties?: Record<string, unknown> }> };
  const names = new Set(Object.keys(schema.properties ?? {}));
  for (const variant of schema.oneOf ?? []) for (const name of Object.keys(variant.properties ?? {})) names.add(name);
  return [...names].sort();
}

const REGISTRY_NAMES = new Set(MCP_TOOLS.map((tool) => tool.name));

// ═══════════════════════════ (a) the target allowlist ════════════════════════

describe('(a) the per-tool target allowlist, against the real registry', () => {
  it('every entry names a registry tool, a declared argument and one of the five kinds', () => {
    const entries = Object.entries(MCP_ACTION_TARGET_ARGUMENTS);
    expect(entries.length).toBeGreaterThan(40);
    for (const [toolName, candidates] of entries) {
      const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
      expect({ toolName, registered: Boolean(tool) }).toEqual({ toolName, registered: true });
      expect(candidates.length).toBeGreaterThan(0);
      for (const [argument, type] of candidates) {
        expect({ toolName, argument, declared: declaredArguments(tool!).includes(argument) })
          .toEqual({ toolName, argument, declared: true });
        expect(MCP_ACTION_TARGET_TYPES).toContain(type);
      }
    }
  });

  it('an allowlisted tool records its target from that argument, lower-cased, and only for a complete UUID', () => {
    for (const [toolName, candidates] of Object.entries(MCP_ACTION_TARGET_ARGUMENTS)) {
      for (const [argument, type] of candidates) {
        expect(mcpActionTarget(toolName, { [argument]: UUID.toUpperCase() })).toEqual({ type, id: UUID });
        for (const malformed of [UUID.slice(0, 35), `${UUID} `, 'not-a-uuid', 42, null, { id: UUID }, [UUID]]) {
          expect({ toolName, argument, malformed, target: mcpActionTarget(toolName, { [argument]: malformed }) })
            .toEqual({ toolName, argument, malformed, target: null });
        }
      }
    }
  });

  it('an allowlisted tool never reads a target from any OTHER argument, even a UUID-valued one', () => {
    for (const [toolName, candidates] of Object.entries(MCP_ACTION_TARGET_ARGUMENTS)) {
      const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName)!;
      const allowed = new Set(candidates.map(([argument]) => argument));
      const others = Object.fromEntries(declaredArguments(tool).filter((name) => !allowed.has(name)).map((name) => [name, UUID]));
      expect({ toolName, target: mcpActionTarget(toolName, { ...others, unknownField: UUID }) })
        .toEqual({ toolName, target: null });
    }
  });

  it('a tool that is NOT allowlisted records no target, even with a UUID in every declared argument', () => {
    const unlisted = MCP_TOOLS.filter((tool) => !Object.prototype.hasOwnProperty.call(MCP_ACTION_TARGET_ARGUMENTS, tool.name));
    // Non-vacuity: the identity, credential, principal and search tools are among them.
    for (const name of ['relayhall_agent_revoke', 'relayhall_agent_mint', 'relayhall_access_request',
      'relayhall_task_create', 'relayhall_task_list', 'relayhall_report_search', 'relayhall_principal_whoami']) {
      expect(unlisted.map((tool) => tool.name)).toContain(name);
    }
    for (const tool of unlisted) {
      const args = Object.fromEntries([...declaredArguments(tool), 'task', 'taskId', 'projectId'].map((name) => [name, UUID]));
      expect({ tool: tool.name, target: mcpActionTarget(tool.name, args) }).toEqual({ tool: tool.name, target: null });
    }
    // A name that is no tool at all, and an inherited property name.
    expect(mcpActionTarget('relayhall_not_a_tool', { task: UUID })).toBeNull();
    expect(mcpActionTarget('constructor', { task: UUID })).toBeNull();
    expect(mcpActionTarget('__proto__', { task: UUID })).toBeNull();
  });

  it('the Brief records the altitude it compiled, and the session altitude names nothing', () => {
    expect(mcpActionTarget('relayhall_brief_compile', { session: true })).toBeNull();
    expect(mcpActionTarget('relayhall_brief_compile', { taskId: TASK })).toEqual({ type: 'task', id: TASK });
    expect(mcpActionTarget('relayhall_brief_compile', { phaseId: UUID })).toEqual({ type: 'phase', id: UUID });
    expect(mcpActionTarget('relayhall_brief_compile', { projectId: UUID })).toEqual({ type: 'project', id: UUID });
    expect(mcpActionTarget('relayhall_report_get', { reportId: UUID })).toEqual({ type: 'report', id: UUID });
    expect(mcpActionTarget('relayhall_skill_get', { skillId: UUID })).toEqual({ type: 'skill', id: UUID });
    // The Report a Task-scoped read names is not the target: the Task is.
    expect(mcpActionTarget('relayhall_task_report_get', { task: TASK, reportId: UUID })).toEqual({ type: 'task', id: TASK });
    expect(mcpActionTarget('relayhall_task_report_get', { reportId: UUID })).toBeNull();
  });
});

// ═══════════════════════════ (b) the closed error codes ══════════════════════

describe('(b) the error code is closed, and comes from the class and the status only', () => {
  it('maps every board status class, and a tool-side refusal, without reading the message', () => {
    const cases: Array<[number, string]> = [
      [400, 'bad_request'], [422, 'bad_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'],
      [409, 'conflict'], [412, 'conflict'], [429, 'rate_limited'], [503, 'unavailable'], [500, 'server_error'],
      [502, 'server_error'], [410, 'rejected'], [413, 'rejected'],
    ];
    for (const [status, code] of cases) {
      expect({ status, code: mcpActionErrorCode(errorFromRest('relayhall_task_get', status, { error: 'not_found' })) })
        .toEqual({ status, code });
    }
    expect(mcpActionErrorCode(new McpToolError('task must be a complete Task UUID.'))).toBe('tool_refused');
    // A message that LOOKS like a status is not one.
    expect(mcpActionErrorCode(new McpToolError('relayhall_task_get failed (HTTP 404)'))).toBe('tool_refused');
    expect(mcpActionErrorCode(new Error('boom'))).toBe('internal');
    expect(mcpActionErrorCode('a thrown string')).toBe('internal');
    expect(mcpActionErrorCode(undefined)).toBe('internal');
    for (const code of [...cases.map(([, c]) => c), 'tool_refused', 'internal']) expect(MCP_ACTION_ERROR_CODES).toContain(code);
  });

  it('the Blueprint refusal path carries the board status too', () => {
    const registry = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'registry.ts'), 'utf8');
    expect(registry).toMatch(/untrusted\('Blueprint refusal fields', json\(result\.body\)\),\n {2}\), result\.status\);/);
  });
});

// ═══════════════════════ (c) no argument is ever stored ══════════════════════

const SECRETS = [
  'rh_live_0123456789abcdef.SuperSecretValue-DO-NOT-STORE',
  'Bearer ghp_examplesecrettokenvalue1234567890',
  'my password is hunter2-correct-horse',
];

const link = (principalId: string, parent: string | null) => ({
  principalId, kind: 'service', role: null, parentPrincipalId: parent, boundTaskId: null,
  legacyIdentity: false, ownExpression: null,
}) as never;
const CALLER: McpSessionCaller = {
  credentialId: CREDENTIAL, principalId: CONNECTOR, delegationLinks: [link(CONNECTOR, ACCOUNT), link(ACCOUNT, null)],
};
const BINDING = { accountId: ACCOUNT, connectorId: CONNECTOR, agentId: null, policyTier: 0 as const };
const EPOCH_AT = new Date(1_800_000_000_000);
const NOW = new Date(1_800_000_030_000);

function harness(options: { live?: boolean; none?: boolean; derived?: boolean; action?: (row: McpActionRow | null) => void } = {}) {
  const actions: Array<McpActionRow | null> = [];
  const deps: Partial<McpSessionTelemetryDeps> = {
    derive: (async () => (options.derived === false
      ? { ok: false, code: 'TELEMETRY_TIER_NOT_DECLARED', message: 'no', audit: {} }
      : { ok: true, binding: BINDING, principalClass: 'connector', descriptor: {} })) as never,
    epoch: async () => (options.none ? null
      : { bootstrappedAt: EPOCH_AT, live: options.live !== false, expiresAt: new Date(EPOCH_AT.getTime() + 1) }),
    store: async () => ({ accepted: true, duplicate: true }) as never,
    frame: async () => ({ accepted: true, receivedAt: 'now' }),
    pool: { query: async (text: string) => (text.includes('FROM telemetry_frames') || text.includes('FROM task_assignments') ? { rows: [] } : { rows: [] }) },
    clock: () => NOW,
    action: (row) => { actions.push(row); options.action?.(row); },
  };
  return { telemetry: new McpSessionTelemetry(deps), actions };
}

describe('(c) no argument, argument name or message ever reaches a row or a log line', () => {
  it('a call carrying secret-looking arguments yields exactly the eleven columns, none holding them', async () => {
    const h = harness();
    const args = {
      task: TASK, content: SECRETS[0], idempotencyKey: SECRETS[1], title: SECRETS[2],
      nested: { token: SECRETS[0] }, list: [SECRETS[1]],
    };
    const observation = await h.telemetry.observe('relayhall_task_stream_append', args, async () => CALLER);
    await observation.settle(true, { errorCode: null, durationMs: 12.6 });
    expect(h.actions).toHaveLength(1);
    const row = h.actions[0]!;
    expect(Object.keys(row).sort()).toEqual([
      'account_id', 'agent_id', 'connector_id', 'duration_ms', 'error_code', 'observed_at', 'outcome',
      'session_ref', 'target_id', 'target_type', 'tool_name',
    ]);
    const serialized = JSON.stringify(row);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    for (const argumentName of ['content', 'idempotencyKey', 'title', 'nested', 'list', 'token']) {
      expect(serialized).not.toContain(argumentName);
    }
    expect(row).toEqual({
      session_ref: telemetrySessionReference(MCP_SESSION_SOURCE_PRODUCT,
        { conversation_id: mcpSessionSeed(CREDENTIAL, { bootstrappedAt: EPOCH_AT }) }),
      connector_id: CONNECTOR, account_id: ACCOUNT, agent_id: null,
      tool_name: 'relayhall_task_stream_append', target_type: 'task', target_id: TASK,
      outcome: 'ok', error_code: null, duration_ms: 13, observed_at: NOW,
    });
  });

  it('an error records the closed code and nothing of the message', async () => {
    const h = harness();
    const observation = await h.telemetry.observe('relayhall_task_get', { task: TASK }, async () => CALLER);
    const error = errorFromRest('relayhall_task_get', 404, { error: SECRETS[2] });
    await observation.settle(false, { errorCode: mcpActionErrorCode(error), durationMs: 3 });
    expect(h.actions[0]).toMatchObject({ outcome: 'error', error_code: 'not_found', target_id: TASK });
    expect(JSON.stringify(h.actions[0])).not.toContain(SECRETS[2]);
  });

  it('the INSERT names its eleven columns and binds exactly the row values, nothing else', async () => {
    const sent: Array<{ text: string; values: unknown[]; query_timeout?: number }> = [];
    const log = new McpActionLog({ query: async (config) => { sent.push(config); return {}; } });
    const row = buildMcpActionRow({
      sessionRef: REF, connectorId: CONNECTOR, accountId: ACCOUNT, agentId: null, toolName: 'relayhall_task_get',
      target: { type: 'task', id: TASK }, errorCode: null, durationMs: 5, observedAt: NOW,
    }, REGISTRY_NAMES)!;
    await log.enqueue(row);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(MCP_ACTION_LOG_INSERT_SQL);
    expect(sent[0].values).toEqual([REF, CONNECTOR, ACCOUNT, null, 'relayhall_task_get', 'task', TASK, 'ok', null, 5, NOW]);
    expect(sent[0].query_timeout).toBe(MCP_ACTION_LOG_WRITE_TIMEOUT_MS);
    const columns = /\(([^)]*)\)\s*VALUES/.exec(MCP_ACTION_LOG_INSERT_SQL)![1].split(',').map((c) => c.trim());
    expect(columns).toEqual(['session_ref', 'connector_id', 'account_id', 'agent_id', 'tool_name', 'target_type',
      'target_id', 'outcome', 'error_code', 'duration_ms', 'observed_at']);
  });

  it('a failed write logs a secret-free warning, even when the driver error echoes the values', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const log = new McpActionLog({
        query: async () => { throw Object.assign(new Error(`Failing row contains (${SECRETS.join(', ')})`), { code: '23514', detail: SECRETS[0] }); },
      });
      const row = buildMcpActionRow({
        sessionRef: REF, connectorId: CONNECTOR, accountId: ACCOUNT, agentId: null, toolName: 'relayhall_task_get',
        target: null, errorCode: 'internal', durationMs: 1, observedAt: NOW,
      }, REGISTRY_NAMES);
      await expect(log.enqueue(row)).resolves.toBeUndefined();
      const printed = [...warn.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls].map((call) => call.map(String).join(' ')).join('\n');
      expect(printed).toContain('[McpActionLog] write failed');
      for (const secret of SECRETS) expect(printed).not.toContain(secret);
      expect(printed).not.toContain(REF);
    } finally {
      warn.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('a name outside the registry, or a code outside the closed set, builds no row', () => {
    const base = {
      sessionRef: REF, connectorId: CONNECTOR, accountId: ACCOUNT, agentId: null,
      target: null, errorCode: null, durationMs: 1, observedAt: NOW,
    };
    expect(buildMcpActionRow({ ...base, toolName: 'relayhall_not_a_tool' }, REGISTRY_NAMES)).toBeNull();
    expect(buildMcpActionRow({ ...base, toolName: 'relayhall_task_get', errorCode: 'stack trace here' as never }, REGISTRY_NAMES)).toBeNull();
    // The default name set IS the registry.
    expect(buildMcpActionRow({ ...base, toolName: 'relayhall_task_get' })).not.toBeNull();
    expect(buildMcpActionRow({ ...base, toolName: 'relayhall_not_a_tool' })).toBeNull();
    // A forged target that is not one of the five kinds, or not a UUID, is dropped.
    expect(buildMcpActionRow({ ...base, toolName: 'relayhall_task_get', target: { type: 'credential' as never, id: TASK } }, REGISTRY_NAMES))
      .toMatchObject({ target_type: null, target_id: null });
    expect(buildMcpActionRow({ ...base, toolName: 'relayhall_task_get', target: { type: 'task', id: SECRETS[0] } }, REGISTRY_NAMES))
      .toMatchObject({ target_type: null, target_id: null });
    // Durations are whole, non-negative and bounded.
    expect(buildMcpActionRow({ ...base, toolName: 'relayhall_task_get', durationMs: -4 }, REGISTRY_NAMES)!.duration_ms).toBe(0);
    expect(buildMcpActionRow({ ...base, toolName: 'relayhall_task_get', durationMs: Number.NaN }, REGISTRY_NAMES)!.duration_ms).toBe(0);
    expect(buildMcpActionRow({ ...base, toolName: 'relayhall_task_get', durationMs: 9e12 }, REGISTRY_NAMES)!.duration_ms)
      .toBe(MCP_ACTION_MAX_DURATION_MS);
  });
});

// ════════════════════════════════ (d) the bound ══════════════════════════════

describe('(d) queuing never waits, never throws, and is bounded', () => {
  const row = (): McpActionRow => buildMcpActionRow({
    sessionRef: REF, connectorId: CONNECTOR, accountId: ACCOUNT, agentId: null, toolName: 'relayhall_task_get',
    target: null, errorCode: null, durationMs: 1, observedAt: NOW,
  }, REGISTRY_NAMES)!;

  it('at most MAX writes are outstanding; the rest are dropped and counted, and a settled write frees its slot', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pending: Array<() => void> = [];
      const log = new McpActionLog({ query: () => new Promise((resolve) => { pending.push(() => resolve({})); }) });
      for (let i = 0; i < MCP_ACTION_LOG_MAX_IN_FLIGHT + 3; i += 1) void log.enqueue(row());
      expect(log.stats()).toEqual({ inFlight: MCP_ACTION_LOG_MAX_IN_FLIGHT, dropped: 3 });
      expect(pending).toHaveLength(MCP_ACTION_LOG_MAX_IN_FLIGHT);
      pending.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
      expect(log.stats().inFlight).toBe(MCP_ACTION_LOG_MAX_IN_FLIGHT - 1);
      void log.enqueue(row());
      expect(log.stats()).toEqual({ inFlight: MCP_ACTION_LOG_MAX_IN_FLIGHT, dropped: 3 });
    } finally {
      warn.mockRestore();
    }
  });

  it('a pool that throws synchronously, and a null row, never throw', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const log = new McpActionLog({ query: () => { throw new Error('sync failure'); } });
      expect(() => log.enqueue(row())).not.toThrow();
      expect(() => log.enqueue(null)).not.toThrow();
      expect(log.stats().inFlight).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('settle does not wait for the write: it resolves while the INSERT is still outstanding', async () => {
    const log = new McpActionLog({ query: () => new Promise(() => undefined) });
    const { telemetry } = harness({ action: (r) => { void log.enqueue(r); } });
    const observation = await telemetry.observe('relayhall_task_get', { task: TASK }, async () => CALLER);
    await expect(observation.settle(true, { errorCode: null, durationMs: 1 })).resolves.toBeUndefined();
    expect(log.stats().inFlight).toBe(1);
  });
});

// ═══════════════════════════ (e) the session wiring ══════════════════════════

describe('(e) a row only under a live session, and only with an outcome', () => {
  it('no live epoch, no epoch, a refused derivation, or no outcome: nothing is queued', async () => {
    for (const [label, options] of [['lapsed', { live: false }], ['none', { none: true }], ['refused', { derived: false }]] as const) {
      const h = harness(options);
      const observation = await h.telemetry.observe('relayhall_task_get', { task: TASK }, async () => CALLER);
      await observation.settle(true, { errorCode: null, durationMs: 1 });
      expect({ label, actions: h.actions }).toEqual({ label, actions: [] });
    }
    const h = harness();
    const observation = await h.telemetry.observe('relayhall_task_get', { task: TASK }, async () => CALLER);
    await observation.settle(true);
    expect(h.actions).toEqual([]);
    // No caller at all.
    const anonymous = harness();
    const none = await anonymous.telemetry.observe('relayhall_task_get', { task: TASK }, async () => null);
    await none.settle(true, { errorCode: null, durationMs: 1 });
    expect(anonymous.actions).toEqual([]);
  });

  it('the bootstrap call itself is the first row of the session it starts', async () => {
    const h = harness();
    const observation = await h.telemetry.observe('relayhall_brief_compile', { session: true }, async () => CALLER);
    await observation.settle(true, { errorCode: null, durationMs: 2 });
    expect(h.actions).toHaveLength(1);
    expect(h.actions[0]).toMatchObject({ tool_name: 'relayhall_brief_compile', target_type: null, outcome: 'ok' });
  });

  it('the action log product is the server-written MCP product key', () => {
    expect(MCP_ACTION_LOG_PRODUCT).toBe(MCP_SESSION_SOURCE_PRODUCT);
  });
});

// ═══════════════════════════════ (f) the read ════════════════════════════════

describe('(f) the projection reads the log only behind the session, narrowed per row', () => {
  const OWN: TelemetryReadScope = { kind: 'account', accountId: ACCOUNT };
  const ROOT: TelemetryReadScope = { kind: 'root' };
  const HEAD = {
    session_ref: REF, connector_id: CONNECTOR, source_product: 'mcp', started_at: NOW, last_seen_at: NOW,
    event_count: 2, error_count: 0, input_tokens: 0, output_tokens: 0, requests: 0, models: [], last_phase: 'running',
  };
  function recording(headRows: Record<string, unknown>[], actionRows: Record<string, unknown>[] = []) {
    const statements: Array<{ text: string; params: unknown[] }> = [];
    const pool = {
      async query(text: string, params: unknown[] = []) {
        statements.push({ text, params });
        if (text.includes('FROM mcp_action_log')) return { rows: actionRows };
        if (text.includes('WITH grouped')) return { rows: headRows };
        return { rows: [] };
      },
    };
    return { statements, service: new TelemetryProjectionService(pool as never) };
  }
  const reads = (statements: Array<{ text: string; params: unknown[] }>) => statements.filter((s) => s.text.includes('FROM mcp_action_log'));

  it('an mcp session that resolved reads its log narrowed by the caller Account, and returns it newest first', async () => {
    const { statements, service } = recording([HEAD], [
      { observed_at: NOW, tool_name: 'relayhall_task_get', target_type: 'task', target_id: TASK, outcome: 'ok', error_code: null, duration_ms: 4 },
    ]);
    const detail = await service.session(OWN, { sessionRef: REF, connectorId: CONNECTOR, sourceProduct: 'mcp' });
    expect(detail!.actions).toEqual([{
      observedAt: NOW.toISOString(), toolName: 'relayhall_task_get', targetType: 'task', targetId: TASK,
      outcome: 'ok', errorCode: null, durationMs: 4,
    }]);
    expect(detail!.actionsTruncated).toBe(false);
    const [read] = reads(statements);
    expect(read.text).toMatch(/a\.account_id = \$3/);
    expect(read.params).toEqual([REF, CONNECTOR, ACCOUNT, expect.any(Number)]);
    expect(read.text).toMatch(/ORDER BY a\.observed_at DESC, a\.id DESC/);
    // root reads every Account's rows, by the same rendered predicate.
    const rooted = recording([HEAD]);
    await rooted.service.session(ROOT, { sessionRef: REF, connectorId: CONNECTOR, sourceProduct: 'mcp' });
    expect(reads(rooted.statements)[0].text).toContain('AND TRUE');
  });

  it('a session the caller cannot read, and a product other than mcp, read no log at all', async () => {
    const hidden = recording([]);
    expect(await hidden.service.session(OWN, { sessionRef: REF, connectorId: CONNECTOR, sourceProduct: 'mcp' })).toBeNull();
    expect(reads(hidden.statements)).toEqual([]);
    const other = recording([{ ...HEAD, source_product: 'claude-code' }]);
    const detail = await other.service.session(OWN, { sessionRef: REF, connectorId: CONNECTOR, sourceProduct: 'claude-code' });
    expect(detail!.actions).toEqual([]);
    expect(reads(other.statements)).toEqual([]);
  });

  it('the log is cut at the event limit and says so', async () => {
    const many = Array.from({ length: 4 }, () => ({
      observed_at: NOW, tool_name: 'relayhall_task_get', target_type: null, target_id: null, outcome: 'ok', error_code: null, duration_ms: 1,
    }));
    const { service } = recording([HEAD], many);
    const detail = await service.session(OWN, { sessionRef: REF, connectorId: CONNECTOR, sourceProduct: 'mcp' }, { events: 3 });
    expect(detail!.actions).toHaveLength(3);
    expect(detail!.actionsTruncated).toBe(true);
  });
});

// ═══════════════════ (g) the code's vocabularies equal migration 161 ═════════

describe('(g) the vocabularies in code equal the CHECKs migration 161 holds', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '161_mcp_action_log.sql'), 'utf8');
  const listIn = (constraint: string): string[] => {
    const match = new RegExp(`CONSTRAINT ${constraint}\\s+CHECK \\(([^;]*?)\\)(?:,|\\n\\);)`, 's').exec(migration);
    expect(match).not.toBeNull();
    return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  };

  it('target kinds, outcomes and error codes', () => {
    expect(listIn('mcp_action_log_target_type_check')).toEqual([...MCP_ACTION_TARGET_TYPES]);
    expect(listIn('mcp_action_log_outcome_check')).toEqual(['ok', 'error']);
    expect(listIn('mcp_action_log_error_code_check')).toEqual([...MCP_ACTION_ERROR_CODES]);
  });

  it('the tool-name grammar is the same in both, and admits every registry tool', () => {
    expect(migration).toContain(`CHECK (tool_name ~ '${MCP_ACTION_TOOL_NAME_RE.source}')`);
    for (const name of REGISTRY_NAMES) expect({ name, ok: MCP_ACTION_TOOL_NAME_RE.test(name) }).toEqual({ name, ok: true });
    expect(migration).toContain(`CHECK (duration_ms BETWEEN 0 AND ${MCP_ACTION_MAX_DURATION_MS})`);
  });

  it('the table has no column that could hold an argument or free text', () => {
    const body = /CREATE TABLE IF NOT EXISTS mcp_action_log \(([\s\S]*?)\n\);/.exec(migration)![1];
    const columns = body.split('\n').map((line) => line.trim()).filter((line) => /^[a-z_]+ /.test(line) && !line.startsWith('CONSTRAINT'))
      .map((line) => line.split(' ')[0]);
    expect(columns).toEqual(['id', 'session_ref', 'connector_id', 'account_id', 'agent_id', 'tool_name', 'target_type',
      'target_id', 'outcome', 'error_code', 'duration_ms', 'observed_at']);
    expect(body).not.toMatch(/\bJSONB?\b/i);
  });

  it('the retention sweep governs the log as its own receipted class', () => {
    expect(TELEMETRY_RETENTION_CLASSES).toContain('mcp_action_log');
  });
});
