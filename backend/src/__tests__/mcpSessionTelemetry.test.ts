/**
 * Card 35b73092 — the MCP-derived session observer, at unit scope.
 *
 * The behaviour is proven end to end against a real PostgreSQL by
 * `mcpDerivedSessionsLive.test.ts`. This suite pins what that one cannot
 * isolate: the cadence inequalities against the SHIPPED windows, that every
 * record the observer builds passes the real validator and the real Tier-0
 * engine without leaking the credential, that the chain short-cut in `bind`
 * skips only shapes the ratified derivation refuses anyway, and the decision
 * table of start / heartbeat / end / link with every dependency faked.
 */
import crypto from 'crypto';

process.env.RELAYHALL_TELEMETRY_PEPPERS = process.env.RELAYHALL_TELEMETRY_PEPPERS
  || JSON.stringify({ unitpepper: Buffer.alloc(32, 5).toString('base64') });
process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER || 'unitpepper';

import {
  McpSessionTelemetry, MCP_HEARTBEAT_INTERVAL_MS, MCP_LINK_TRIGGER_TOOLS, MCP_SESSION_SOURCE_PRODUCT,
  linkTriggerTask, mcpAdapterVersion, mcpHeartbeatBucket, mcpHeartbeatCadenceHolds, mcpSessionEnvelope, mcpSessionSeed,
  type McpSessionCaller, type McpSessionTelemetryDeps,
} from '../services/McpSessionTelemetry';
import { TELEMETRY_STALE_MS, TELEMETRY_MIN_FRAME_INTERVAL_MS } from '../services/TelemetryService';
import { TelemetryPrincipalService } from '../services/TelemetryPrincipalService';
import { applyTelemetryPolicy } from '../services/TelemetryPolicyEngine';
import { telemetryEventIdentityKey, validateTelemetryEnvelope } from '../utils/telemetryEnvelopeValidator';
import { resetTelemetryPepperCache, telemetrySessionReference } from '../utils/telemetryPepper';
import { toolByName } from '../mcp/registry';
import { RELAYHALL_VERSION } from '../version';
import type { TelemetryEnvelope } from '../types/TelemetryEnvelope';

beforeAll(() => resetTelemetryPepperCache());

const CREDENTIAL = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const TASK_X = '55555555-5555-4555-8555-555555555555';
const TASK_Y = '66666666-6666-4666-8666-666666666666';
const TASK_Z = '77777777-7777-4777-8777-777777777777';

const link = (principalId: string, parent: string | null) => ({
  principalId, kind: 'service', role: null, parentPrincipalId: parent, boundTaskId: null,
  legacyIdentity: false, ownExpression: null,
}) as never;

const CALLER: McpSessionCaller = {
  credentialId: CREDENTIAL,
  principalId: CONNECTOR,
  delegationLinks: [link(CONNECTOR, ACCOUNT), link(ACCOUNT, null)],
};
const BINDING = { accountId: ACCOUNT, connectorId: CONNECTOR, agentId: null, policyTier: 0 as const };

// ═══════════════════════════════ the cadence ═════════════════════════════════

describe('the heartbeat cadence, against the shipped windows', () => {
  it('a continuously active session can never derive stale, and the cadence clears the frame gate', () => {
    expect(mcpHeartbeatCadenceHolds()).toBe(true);
    expect(2 * MCP_HEARTBEAT_INTERVAL_MS).toBeLessThan(TELEMETRY_STALE_MS);
    expect(MCP_HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(TELEMETRY_MIN_FRAME_INTERVAL_MS);
  });

  it('the inequality is computed, not decorative: an interval breaking either side fails it', () => {
    expect(mcpHeartbeatCadenceHolds(TELEMETRY_STALE_MS / 2)).toBe(false);
    expect(mcpHeartbeatCadenceHolds(TELEMETRY_MIN_FRAME_INTERVAL_MS - 1)).toBe(false);
  });

  it('buckets are fixed: one key inside a bucket, a new key across its edge', () => {
    const start = 1_800_000_000_000 - (1_800_000_000_000 % MCP_HEARTBEAT_INTERVAL_MS);
    const seed = mcpSessionSeed(CREDENTIAL, { bootstrappedAt: new Date(start - 5_000) });
    const ref = telemetrySessionReference(MCP_SESSION_SOURCE_PRODUCT, { conversation_id: seed }) as string;
    const key = (ms: number): string => telemetryEventIdentityKey(
      CONNECTOR, mcpSessionEnvelope(seed, ref, 'running', new Date(ms)) as unknown as TelemetryEnvelope).key;
    expect(key(start)).toBe(key(start + MCP_HEARTBEAT_INTERVAL_MS - 1));
    expect(key(start + MCP_HEARTBEAT_INTERVAL_MS)).not.toBe(key(start));
    expect(mcpHeartbeatBucket(new Date(start + MCP_HEARTBEAT_INTERVAL_MS))).toBe(mcpHeartbeatBucket(new Date(start)) + 1);
  });
});

// ═════════════════════════════ the records ═══════════════════════════════════

describe('every record the observer builds is a valid Tier-0 envelope that carries no credential', () => {
  const now = new Date('2026-10-10T21:00:30.000Z');
  const seed = mcpSessionSeed(CREDENTIAL, { bootstrappedAt: new Date('2026-10-10T21:00:00.000Z') });
  const ref = (): string => telemetrySessionReference(MCP_SESSION_SOURCE_PRODUCT, { conversation_id: seed }) as string;

  it.each(['started', 'running', 'completed'] as const)('%s passes the real validator', (phase) => {
    const result = validateTelemetryEnvelope(mcpSessionEnvelope(seed, ref(), phase, now));
    expect(result.ok).toBe(true);
    expect(result.ok && result.identityArm).toBe(phase === 'running' ? 'stream_sequence' : 'event_id');
  });

  it('states the reported board version only where the ingest grammar admits it, verbatim (train integration with 6d549392)', () => {
    expect(mcpAdapterVersion('1.0.0-beta.1')).toBe('1.0.0-beta.1');
    expect(mcpAdapterVersion('1.0.0+unreleased')).toBe('1.0.0+unreleased');
    expect(mcpAdapterVersion('1.0.0-beta.1+unreleased')).toBeUndefined();
    expect(mcpAdapterVersion('1.0.0-beta.1+0123abc')).toBeUndefined();
    // What THIS build emits: the reported version when it fits, else no key.
    const source = mcpSessionEnvelope(seed, ref(), 'started', now).source as Record<string, unknown>;
    const stated = mcpAdapterVersion(RELAYHALL_VERSION);
    expect(source.adapter_version).toBe(stated);
    expect(Object.prototype.hasOwnProperty.call(source, 'adapter_version')).toBe(stated !== undefined);
  });

  it.each(['started', 'running', 'completed'] as const)('%s survives Tier 0 with the session pseudonym and no credential', (phase) => {
    const envelope = mcpSessionEnvelope(seed, ref(), phase, now) as unknown as TelemetryEnvelope;
    const policy = applyTelemetryPolicy(0, envelope, { observedAt: now });
    expect(policy.sessionRef).toBe(ref());
    expect(policy.record.phase).toBe(phase);
    expect(policy.record.source.product).toBe('mcp');
    const stored = JSON.stringify(policy.record);
    expect(stored).not.toContain(CREDENTIAL);
    expect(stored).not.toContain(seed);
  });

  it('start and end are distinct, fixed per epoch, so a retry of either stores nothing new', () => {
    const start = mcpSessionEnvelope(seed, ref(), 'started', now);
    const end = mcpSessionEnvelope(seed, ref(), 'completed', now);
    expect(start.event_id).not.toBe(end.event_id);
    expect(mcpSessionEnvelope(seed, ref(), 'started', new Date(now.getTime() + 5_000)).event_id).toBe(start.event_id);
  });
});

// ════════════════════ the chain short-cut equals derive ══════════════════════

describe('bind skips only the chains the ratified derivation refuses anyway', () => {
  const service = (connector: boolean): TelemetryPrincipalService => new TelemetryPrincipalService({
    query: async (sql: string) => {
      if (sql.includes('is_connector')) return { rows: [{ is_connector: connector }], rowCount: 1 };
      if (sql.includes('service_descriptor_versions')) {
        return { rows: [{ descriptor: { telemetry: { tier: 'presence', products: ['x'] } }, version: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as never);

  it.each([true, false])('chains of zero and one link are refused (registry says connector=%s)', async (connector) => {
    for (const links of [[], [link(CONNECTOR, null)]]) {
      const result = await service(connector).derive({ actingPrincipalId: CONNECTOR, delegationLinks: links });
      expect(result.ok).toBe(false);
    }
  });

  it('positive control: the same fake admits a two-link Connector chain', async () => {
    const result = await service(true).derive({ actingPrincipalId: CONNECTOR, delegationLinks: CALLER.delegationLinks });
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════ the decision table ══════════════════════════════

interface Harness {
  telemetry: McpSessionTelemetry;
  stored: Array<{ binding: unknown; phase: string; seed: string }>;
  frames: Array<{ principalId: string; status: string; taskId: string }>;
  sql: string[];
  derive: jest.Mock;
}

function harness(options: {
  epochs?: Array<{ bootstrappedAt: Date; live: boolean } | null>;
  derived?: boolean;
  duplicate?: boolean;
  /** Tasks whose newest MCP link frame is `active`, most recently set first. */
  shown?: string[];
  /** Tasks the caller holds in progress, newest `updated_at` first. */
  held?: string[];
  storeThrows?: boolean;
} = {}): Harness {
  const stored: Harness['stored'] = [];
  const frames: Harness['frames'] = [];
  const sql: string[] = [];
  const epochs = [...(options.epochs ?? [{ bootstrappedAt: new Date(1_800_000_000_000), live: true }])];
  const derive = jest.fn(async () => (options.derived === false
    ? { ok: false, code: 'TELEMETRY_TIER_NOT_DECLARED', message: 'no', audit: {} }
    : { ok: true, binding: BINDING, principalClass: 'connector', descriptor: {} }));
  const deps: Partial<McpSessionTelemetryDeps> = {
    derive: derive as never,
    epoch: async () => {
      const next = epochs.length > 1 ? epochs.shift() : epochs[0];
      return next ? { ...next, expiresAt: new Date(next.bootstrappedAt.getTime() + 1) } : null;
    },
    store: async (binding, input) => {
      if (options.storeThrows) throw new Error('database unavailable');
      const envelope = input as Record<string, any>;
      stored.push({ binding, phase: envelope.phase, seed: envelope.correlation.conversation_id });
      return { accepted: true, duplicate: options.duplicate === true } as never;
    },
    frame: async (principalId, frame) => {
      frames.push({ principalId, status: String(frame.status), taskId: String(frame.taskId) });
      return { accepted: true, receivedAt: 'now' };
    },
    pool: {
      query: async (text: string) => {
        sql.push(text);
        if (text.includes('FROM telemetry_frames')) return { rows: (options.shown ?? []).map((id) => ({ task_id: id })) };
        if (text.includes('FROM task_assignments')) return { rows: (options.held ?? []).map((id) => ({ id })) };
        throw new Error(`unexpected SQL: ${text}`);
      },
    },
    clock: () => new Date(1_800_000_030_000),
  };
  return { telemetry: new McpSessionTelemetry(deps), stored, frames, sql, derive };
}

const run = async (h: Harness, tool: string, args: Record<string, unknown>, caller: McpSessionCaller | null = CALLER, succeeded = true): Promise<void> => {
  const observation = await h.telemetry.observe(tool, args, async () => caller);
  await observation.settle(succeeded);
};

describe('the observer decision table', () => {
  it('writes nothing when no caller resolves, for an Account-plane chain, or when derive refuses', async () => {
    const none = harness();
    await run(none, 'relayhall_principal_whoami', {}, null);
    const accountPlane = harness();
    await run(accountPlane, 'relayhall_principal_whoami', {}, { ...CALLER, delegationLinks: null });
    const refused = harness({ derived: false });
    await run(refused, 'relayhall_principal_whoami', {});
    for (const h of [none, accountPlane, refused]) {
      expect(h.stored).toEqual([]);
      expect(h.frames).toEqual([]);
    }
    expect(accountPlane.derive).not.toHaveBeenCalled();
    expect(refused.derive).toHaveBeenCalledTimes(1);
  });

  it('writes nothing before a bootstrap exists', async () => {
    const h = harness({ epochs: [null] });
    await run(h, 'relayhall_principal_whoami', {});
    expect(h.stored).toEqual([]);
  });

  it('the owner is the derived binding and the calling principal, whatever the arguments name', async () => {
    const h = harness({ held: [TASK_X] });
    await run(h, 'relayhall_task_claim', { task: TASK_X, principalId: OTHER, owner: OTHER, connectorId: OTHER });
    expect(h.stored.map((row) => row.binding)).toEqual([BINDING]);
    expect(h.frames).toEqual([{ principalId: CONNECTOR, status: 'active', taskId: TASK_X }]);
    expect(h.derive).toHaveBeenCalledWith({ actingPrincipalId: CONNECTOR, delegationLinks: CALLER.delegationLinks });
  });

  it('a re-bootstrap ends the previous epoch and starts the new one, in that order', async () => {
    const before = new Date(1_800_000_000_000);
    const after = new Date(1_800_000_020_000);
    const h = harness({ epochs: [{ bootstrappedAt: before, live: true }, { bootstrappedAt: after, live: true }] });
    await run(h, 'relayhall_brief_compile', { session: true });
    expect(h.stored.map((row) => [row.phase, row.seed])).toEqual([
      ['completed', mcpSessionSeed(CREDENTIAL, { bootstrappedAt: before })],
      ['started', mcpSessionSeed(CREDENTIAL, { bootstrappedAt: after })],
    ]);
  });

  it('a lapsed epoch is ended at the next contact and nothing else is written', async () => {
    const h = harness({ epochs: [{ bootstrappedAt: new Date(1_800_000_000_000), live: false }], held: [TASK_X] });
    await run(h, 'relayhall_principal_whoami', {});
    expect(h.stored.map((row) => row.phase)).toEqual(['completed']);
    expect(h.frames).toEqual([]);
  });

  it('a duplicate heartbeat on a non-linking tool reads no board state at all', async () => {
    const h = harness({ duplicate: true, held: [TASK_X] });
    await run(h, 'relayhall_principal_whoami', {});
    expect(h.stored.map((row) => row.phase)).toEqual(['running']);
    expect(h.sql).toEqual([]);
    expect(h.frames).toEqual([]);
  });

  it('a failed linking call reconciles nothing; a failed call still heartbeats', async () => {
    const h = harness({ duplicate: true, held: [TASK_X] });
    await run(h, 'relayhall_task_claim', { task: TASK_X }, CALLER, false);
    expect(h.stored.map((row) => row.phase)).toEqual(['running']);
    expect(h.sql).toEqual([]);
  });

  // [label, shown (most recently set first), held (newest updated_at first),
  //  tool + named Task, new bucket?, frames written]
  it.each([
    ['shown X no longer held, Y held -> clear X only (truthfulness first)',
      [TASK_X], [TASK_Y], ['relayhall_task_move', TASK_Y], false, [['idle', TASK_X]]],
    ['shown nothing, Y held -> set Y', [], [TASK_Y], ['relayhall_task_move', TASK_Y], false, [['active', TASK_Y]]],
    ['X held but shown idle -> set X', [], [TASK_X], ['relayhall_task_move', TASK_X], false, [['active', TASK_X]]],
    ['shown Y, Y held, same bucket -> nothing', [TASK_Y], [TASK_Y], ['relayhall_task_move', TASK_Y], false, []],
    ['shown Y, Y held, new bucket -> refresh Y', [TASK_Y], [TASK_Y], ['relayhall_principal_whoami', null], true, [['active', TASK_Y]]],
    ['shown X, nothing held -> clear X', [TASK_X], [], ['relayhall_task_release', TASK_X], false, [['idle', TASK_X]]],
    ['nothing shown, nothing held, new bucket -> nothing', [], [], ['relayhall_principal_whoami', null], true, []],
    ['shown X, X and Y held, a brief names Y -> SWITCH: set Y first',
      [TASK_X], [TASK_X, TASK_Y], ['relayhall_brief_compile', TASK_Y], false, [['active', TASK_Y]]],
    ['after the switch: Y current, X still active, X newer updated_at -> clear X; the switch survives',
      [TASK_Y, TASK_X], [TASK_X, TASK_Y], ['relayhall_principal_whoami', null], true, [['idle', TASK_X]]],
    ['shown Y, X and Y held, X newer updated_at, new bucket -> refresh Y (the shown link outranks updated_at)',
      [TASK_Y], [TASK_X, TASK_Y], ['relayhall_principal_whoami', null], true, [['active', TASK_Y]]],
    ['shown X, X held, a brief names Z the caller does not hold -> nothing',
      [TASK_X], [TASK_X], ['relayhall_brief_compile', TASK_Z], false, []],
    ['a brief names X, the shown-but-superseded Task, Y current -> keep X, clear Y',
      [TASK_Y, TASK_X], [TASK_X, TASK_Y], ['relayhall_brief_compile', TASK_X], false, [['idle', TASK_Y]]],
  ] as const)('%s', async (_label, shown, held, [tool, named], newBucket, expected) => {
    const h = harness({ shown: [...shown], held: [...held], duplicate: !newBucket });
    const args: Record<string, unknown> = tool === 'relayhall_brief_compile'
      ? { taskId: named }
      : { task: named ?? TASK_X, status: 'in-progress' };
    await run(h, tool, args);
    expect(h.frames.map((frame) => [frame.status, frame.taskId])).toEqual(expected);
    for (const frame of h.frames) expect(frame.principalId).toBe(CONNECTOR);
  });

  it('never throws, and never lets a failure reach the tool', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness({ storeThrows: true });
    await expect(run(h, 'relayhall_principal_whoami', {})).resolves.toBeUndefined();
    const broken = new McpSessionTelemetry({ derive: async () => { throw new Error('registry down'); } });
    const observation = await broken.observe('relayhall_brief_compile', { session: true }, async () => CALLER);
    await expect(observation.settle(true)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('the linking tools are real tools that name a Task', () => {
  it('every trigger exists in the registry and takes the argument it is read from', () => {
    for (const [name, field] of Object.entries(MCP_LINK_TRIGGER_TOOLS)) {
      const tool = toolByName(name);
      expect({ name, exists: Boolean(tool) }).toEqual({ name, exists: true });
      const properties = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect({ name, field, declared: field in properties }).toEqual({ name, field, declared: true });
    }
  });

  it('reads only a well-formed Task id, and only for a linking tool', () => {
    const id = crypto.randomUUID();
    expect(linkTriggerTask('relayhall_task_claim', { task: id })).toBe(id);
    expect(linkTriggerTask('relayhall_brief_compile', { taskId: id })).toBe(id);
    expect(linkTriggerTask('relayhall_brief_compile', { session: true })).toBeNull();
    expect(linkTriggerTask('relayhall_task_claim', { task: 'not-a-uuid' })).toBeNull();
    expect(linkTriggerTask('relayhall_task_get', { task: id })).toBeUndefined();
  });
});
