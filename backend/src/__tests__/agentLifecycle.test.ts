/**
 * agentLifecycle.test.ts — RH-P3.AZ-S5 (card bb4a5f79; AUTHZ design
 * 4d961e37 §7.4/§8, AZ-13/AZ-19/AZ-29; T5/T6/T22).
 *
 * What these pin (pool-boundary mocks per the delegationCore precedent;
 * end-to-end behavior rides scripts/test-s5-agent-lifecycle-live.js and
 * the DEV QA probes):
 *  - the §8.2 task-context READ default: an Agent actor's read predicate
 *    carries its bound Task / Phase / Project context arm (acting identity
 *    alone), writes never gain it, non-agent actors never gain it, and the
 *    arm binds the BOUND task id — off-context ids stay refused (T22);
 *  - AZ-29 lease coupling: the explicit renewal re-ups live credentials to
 *    NOW + mint-time max-age (GREATEST — never shortening); a revoked/
 *    suspended warrant or terminal bound task BLOCKS the extension with a
 *    durable denied credential.extend audit; non-agents no-op;
 *  - the terminal-state auto-revoke sweep: one transaction revoking live
 *    credentials of agents bound to completed/archived tasks, with AZ-31c
 *    approval invalidation and full-chain audit rows;
 *    (the heartbeat-route coupling itself is proven end-to-end by the
 *    live proof and the DEV QA probe — the tasks router carries too much
 *    unrelated wiring to mount here honestly);
 *  - §7.4 onboarding packs: composition carries endpoint, §2.10 bootstrap
 *    line, per-harness MCP snippets, CLI env and the authority summary;
 *    the Connector credential-issuance response carries the pack; the
 *    holder-plane GET /delegation/warrants is bearer-only; the §9.3
 *    subtree revoke arm admits a bearer for its own descendants only;
 *  - scope-map pins for the new holder-plane route.
 */
import express from 'express';
import http from 'http';

process.env.RELAYHALL_CREDENTIAL_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 5).toString('base64') });
process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY = 'k1';

const db = {
  queries: [] as Array<{ text: string; params?: unknown[] }>,
  script: [] as Array<(text: string, params?: unknown[]) => { rows: any[] } | null>,
};
function scripted(text: string, params?: unknown[]): { rows: any[] } {
  db.queries.push({ text, params });
  for (const handler of db.script) {
    const result = handler(text, params);
    if (result) return result;
  }
  return { rows: [] };
}
jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
    connect: jest.fn(async () => ({
      query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
      release: jest.fn(),
    })),
  },
}));
const auditRecord = jest.fn(async () => ({}));
jest.mock('../services/AuditService', () => ({ auditService: { record: auditRecord } }));

import { authorizationService, type DelegationActorLink } from '../services/AuthorizationService';
import { agentLifecycleService } from '../services/AgentLifecycleService';
import { composeOnboardingPack } from '../utils/onboardingPack';
import { requiredScopeFor } from '../utils/scopeMap';
import principalsRouter from '../routes/principals';
import credentialsRouter from '../routes/credentials';
import delegationRouter from '../routes/delegation';

const ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CRED = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function link(overrides: Partial<DelegationActorLink> & { principalId: string }): DelegationActorLink {
  return {
    kind: 'service', role: null, parentPrincipalId: null, boundTaskId: null,
    legacyIdentity: false, ownExpression: { scopes: 'parent', objects: 'parent' },
    ...overrides,
  } as DelegationActorLink;
}

const agentActor = (action: string) => ({
  principalId: AGENT, handle: 'agent', role: null, scopes: [action === 'read' ? 'tasks:read' : 'tasks:write'],
  authenticated: true,
  delegation: {
    links: [
      link({ principalId: AGENT, kind: 'agent', parentPrincipalId: CONNECTOR, boundTaskId: TASK, ownExpression: { scopes: 'parent', objects: [] } }),
      link({ principalId: CONNECTOR, parentPrincipalId: ROOT }),
      link({ principalId: ROOT, kind: 'human', role: 'admin' }),
    ],
  },
});

type AuthShape = { principal?: { id: string; handle: string; kind: string }; scopes?: string[]; authMethod?: string; credentialId?: string };
let authShape: AuthShape = {};
let server: http.Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req as any, {
      principal: authShape.principal,
      userId: authShape.principal?.handle,
      scopes: authShape.scopes ?? [],
      authMethod: authShape.authMethod ?? 'dashboard_jwt',
      credentialId: authShape.credentialId,
    });
    next();
  });
  app.use('/principals', principalsRouter);
  app.use('/credentials', credentialsRouter);
  app.use('/delegation', delegationRouter);
  server = app.listen(0, () => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => { jest.clearAllMocks(); db.queries.length = 0; db.script.length = 0; authShape = {}; });

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ── §8.2 task-context read default ─────────────────────────────────── */

describe('the §8.2 task-context read default (AZ-19, T22)', () => {
  const resource = (type: 'task' | 'phase' | 'project') => ({
    type, id: 't.id', owner: 't.owner', visibility: undefined,
  } as any);

  it('an Agent read on TASK gains the bound-task arm binding the BOUND id', () => {
    const decision = authorizationService.sqlCondition(agentActor('read') as any, 'read', resource('task'));
    expect(decision.sql).toMatch(/t\.id = \$\d+/);
    expect(decision.params).toContain(TASK);
  });

  it('phase and project reads gain the context subqueries against the bound task', () => {
    const phase = authorizationService.sqlCondition(agentActor('read') as any, 'read', resource('phase'));
    expect(phase.sql).toMatch(/SELECT ctx\.phase_id FROM tasks ctx WHERE ctx\.id = \$\d+/);
    expect(phase.params).toContain(TASK);
    const project = authorizationService.sqlCondition(agentActor('read') as any, 'read', resource('project'));
    expect(project.sql).toMatch(/SELECT ctx\.project_id FROM tasks ctx WHERE ctx\.id = \$\d+/);
  });

  it('writes NEVER gain the context arm; the bound-task FINAL write cap still wraps (T36)', () => {
    const decision = authorizationService.sqlCondition(agentActor('write') as any, 'write', resource('task'));
    expect(decision.sql).not.toMatch(/ctx\.phase_id|ctx\.project_id/);
    // The §8.2 write cap (S3) binds the outcome to the bound task.
    expect(decision.sql).toMatch(/AND t\.id = \$\d+\)$/);
  });

  it('non-agent delegated actors never gain the context arm', () => {
    const connectorActor = {
      principalId: CONNECTOR, handle: 'conn', role: null, scopes: ['tasks:read'], authenticated: true,
      delegation: { links: [link({ principalId: CONNECTOR, parentPrincipalId: ROOT }), link({ principalId: ROOT, kind: 'human', role: 'admin' })] },
    };
    const decision = authorizationService.sqlCondition(connectorActor as any, 'read', resource('task'));
    expect(decision.params).not.toContain(TASK);
  });
});

/* ── AZ-29 lease coupling ───────────────────────────────────────────── */

function scriptAgentRow(overrides: Record<string, unknown> = {}): void {
  db.script.push((text, params) => {
    if (/FROM principals p\s+LEFT JOIN warrants w/.test(text) && params?.[0] === AGENT) {
      return { rows: [{
        id: AGENT, kind: 'agent', bound_task_id: TASK, legacy_identity: false,
        minted_under_warrant_id: null, warrant_status: null, warrant_date_past: null,
        task_status: 'in-progress', ...overrides,
      }] };
    }
    return null;
  });
}

describe('lease-tied credential expiry (AZ-29)', () => {
  const actor = { handle: 'agent', authMethod: 'principal_api_key' as const };

  it('an explicit renewal re-ups live credentials with GREATEST + the mint-time max-age', async () => {
    scriptAgentRow();
    db.script.push((text) => (/UPDATE principal_credentials c/.test(text)
      ? { rows: [{ id: CRED, expires_at: new Date(Date.now() + 3600_000).toISOString() }] } : null));
    const result = await agentLifecycleService.extendOnLeaseRenewal(AGENT, TASK, actor);
    expect(result.extended).toBe(true);
    const update = db.queries.find((q) => /UPDATE principal_credentials c/.test(q.text))!;
    expect(update.text).toMatch(/GREATEST\(/);
    expect(update.text).toMatch(/max_age_hours/);
    expect(update.text).toMatch(/revoked_at IS NULL/);
    expect(update.text).toMatch(/grace_until IS NULL/);
    expect(update.text).toMatch(/expires_at > NOW\(\)/);
    const audit = (auditRecord.mock.calls as unknown as any[][]).find((c) => c[0]?.action === 'credential.extend' && !c[0]?.outcome);
    expect(audit).toBeDefined();
  });

  it.each([
    ['a revoked warrant', { minted_under_warrant_id: 'abababab-abab-4aba-8aba-abababababab', warrant_status: 'revoked' }, 'WARRANT_REVOKED'],
    ['a suspended warrant', { minted_under_warrant_id: 'abababab-abab-4aba-8aba-abababababab', warrant_status: 'suspended' }, 'WARRANT_SUSPENDED'],
    ['a terminal bound task', { task_status: 'completed' }, 'TASK_TERMINAL'],
  ])('%s BLOCKS the extension with a durable denied audit (§6.4)', async (_label, overrides, reason) => {
    scriptAgentRow(overrides as Record<string, unknown>);
    const result = await agentLifecycleService.extendOnLeaseRenewal(AGENT, TASK, actor);
    expect(result).toEqual({ extended: false, blockedReason: reason });
    expect(db.queries.some((q) => /UPDATE principal_credentials c/.test(q.text))).toBe(false);
    const denial = (auditRecord.mock.calls as unknown as any[][]).find((c) => c[0]?.action === 'credential.extend' && c[0]?.outcome === 'denied');
    expect(denial![0].metadata.refusal).toBe(reason);
  });

  it('non-agent principals and foreign tasks no-op silently', async () => {
    scriptAgentRow({ kind: 'service' });
    expect(await agentLifecycleService.extendOnLeaseRenewal(AGENT, TASK, actor)).toEqual({ extended: false, blockedReason: null });
    db.script.length = 0;
    scriptAgentRow({ bound_task_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
    expect(await agentLifecycleService.extendOnLeaseRenewal(AGENT, TASK, actor)).toEqual({ extended: false, blockedReason: null });
  });
});

describe('the terminal-state auto-revoke sweep (AZ-29)', () => {
  it('revokes in one transaction with AZ-31c invalidation and full-chain audits', async () => {
    db.script.push((text) => {
      if (/UPDATE principal_credentials c/.test(text) && /t\.status IN \('completed', 'archived'\)/.test(text)) {
        return { rows: [{ id: CRED, principal_id: AGENT, task_id: TASK, task_status: 'completed' }] };
      }
      if (/UPDATE approvals/.test(text)) return { rows: [] };
      return null;
    });
    const count = await agentLifecycleService.sweepTerminalAgents();
    expect(count).toBe(1);
    const begin = db.queries.findIndex((q) => q.text === 'BEGIN');
    const revoke = db.queries.findIndex((q) => /t\.status IN \('completed', 'archived'\)/.test(q.text));
    const invalidate = db.queries.findIndex((q) => /UPDATE approvals/.test(q.text));
    const commit = db.queries.findIndex((q) => q.text === 'COMMIT');
    expect(revoke).toBeGreaterThan(begin);
    expect(invalidate).toBeGreaterThan(revoke);
    expect(commit).toBeGreaterThan(invalidate);
    const audit = (auditRecord.mock.calls as unknown as any[][]).find((c) => c[0]?.action === 'credential.revoke');
    expect(audit![0].metadata.reason).toMatch(/AZ-29 auto-revoke/);
    expect(Array.isArray(audit![0].metadata.chain)).toBe(true);
  });

  it('an empty sweep touches nothing and commits nothing', async () => {
    expect(await agentLifecycleService.sweepTerminalAgents()).toBe(0);
    expect(db.queries.some((q) => q.text === 'COMMIT')).toBe(false);
  });
});

/* ── §7.4 packs + the §9.3 surfaces ─────────────────────────────────── */

describe('onboarding packs (§7.4, AZ-13)', () => {
  it('composition carries endpoint, the §2.10 bootstrap line, harness snippets, CLI env and the authority summary', () => {
    const pack = composeOnboardingPack({
      endpoint: 'https://board.example/api',
      credential: { credentialId: CRED, keyId: 'K1', secretOnce: 'rh_dev_secret', expiresAt: null, transport: 'any' },
      scopes: ['tasks:read'],
      rules: [],
      boundTaskId: TASK,
      brief: 'BRIEF TEXT',
    });
    expect(pack.bootstrapLine).toContain('https://board.example/api');
    // RH-P3.C4: the MCP surface is the board's own in-process /mcp endpoint,
    // so the packs carry a URL and a bearer header — not a command that runs a
    // second process out of a local checkout.
    expect(pack.mcpConfig.claudeCode).toMatchObject({
      mcpServers: { relayhall: { type: 'http', url: 'https://board.example/api/mcp', headers: { Authorization: 'Bearer rh_dev_secret' } } },
    });
    expect(JSON.stringify(pack.mcpConfig)).not.toContain('relayhall_mcp.py');
    expect(pack.mcpConfig.codex).toContain('https://board.example/api/mcp');
    expect(pack.mcpConfig.codex).toContain('bearer_token_env_var = "RELAYHALL_TOKEN"');
    expect(pack.cliEnv.join('\n')).toContain('export RELAYHALL_TOKEN=rh_dev_secret');
    expect(pack.authoritySummary).toEqual({ scopes: ['tasks:read'], rules: [], boundTaskId: TASK });
    expect(pack.brief).toBe('BRIEF TEXT');
    expect(pack.previewPath).toBe('/principals/me/effective-access');
  });

  it('a Connector credential issuance carries the pack; an Account issuance never does', async () => {
    authShape = { principal: { id: ROOT, handle: 'owner', kind: 'human' }, scopes: ['root'], authMethod: 'dashboard_jwt' };
    db.script.push((text, params) => {
      if (/FROM principals\s+WHERE id = \$1/i.test(text) && params?.[0] === CONNECTOR) {
        return { rows: [{ id: CONNECTOR, kind: 'service', handle: 'conn', display_name: null, status: 'active', role: null, harness: null, personality_id: null, parent_principal_id: ROOT, last_seen_at: null, legacy_identity: false, metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      }
      if (/SELECT kind, status, legacy_identity, parent_principal_id FROM principals/.test(text)) {
        return { rows: [{ kind: 'service', status: 'active', legacy_identity: false, parent_principal_id: ROOT }] };
      }
      if (/INSERT INTO principal_credentials/.test(text)) return { rows: [{ id: CRED }] };
      return null;
    });
    const { status, json } = await call('POST', `/principals/${CONNECTOR}/credentials`, { scopes: ['tasks:read'] });
    expect(status).toBe(201);
    expect(json.onboarding).toBeDefined();
    expect(json.onboarding.credential.secretOnce).toBe(json.secretOnce);
    expect(json.onboarding.bootstrapLine).toMatch(/RelayHall board/);
  });

  it('GET /delegation/warrants is the bearer plane: sessions refuse; a bearer reads its held warrants', async () => {
    authShape = { principal: { id: ROOT, handle: 'owner', kind: 'human' }, scopes: ['root'], authMethod: 'dashboard_jwt' };
    const session = await call('GET', '/delegation/warrants');
    expect(session.status).toBe(403);
    expect(session.json.code).toBe('CREDENTIAL_BOUND');
    authShape = { principal: { id: CONNECTOR, handle: 'conn', kind: 'service' }, scopes: ['tasks:read'], authMethod: 'principal_api_key', credentialId: CRED };
    db.script.push((text) => (/FROM warrants w/.test(text)
      ? { rows: [{ id: 'abababab-abab-4aba-8aba-abababababab', name: 'w', description: '', status: 'active', holder_principal_id: CONNECTOR, ceiling_profile_version_id: null, ceiling_rules: '[]', ceiling_scopes: null, expires_at: null, transport_pin: 'any', agent_max_age_hours: null, max_concurrent: null, max_total: null, minted_total: 2 }] } : null));
    const bearer = await call('GET', '/delegation/warrants');
    expect(bearer.status).toBe(200);
    expect(bearer.json.warrants[0]).toMatchObject({ name: 'w', mintedTotal: 2, heldByParentAccount: false });
  });

  it('the §9.3 subtree revoke arm: a bearer revokes its OWN descendant; outside stays manage-gated', async () => {
    authShape = { principal: { id: CONNECTOR, handle: 'conn', kind: 'service' }, scopes: ['tasks:read'], authMethod: 'principal_api_key', credentialId: 'ffffffff-0000-4fff-8fff-000000000000' };
    db.script.push((text) => {
      if (/SELECT c\.\*, p\.kind|c\.id AS cred_id/.test(text) && /JOIN principals p/.test(text)) {
        return { rows: [{ cred_id: CRED, principal_id: AGENT, key_id: 'K', label: null, scopes: '["tasks:read"]', credential_type: 'api_key', expires_at: null, revoked_at: null, id: AGENT, kind: 'agent', handle: 'agent', display_name: null, status: 'active', role: null, harness: null, personality_id: null, parent_principal_id: CONNECTOR, last_seen_at: null, legacy_identity: false, metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      }
      if (/WITH RECURSIVE up/.test(text)) return { rows: [{ hit: 1 }] };
      if (/UPDATE principal_credentials/.test(text) && /revoked_at = now\(\)/.test(text)) {
        return { rows: [{ principal_id: AGENT, key_id: 'K' }] };
      }
      if (/UPDATE approvals/.test(text)) return { rows: [] };
      return null;
    });
    const inSubtree = await call('POST', `/credentials/${CRED}/revoke`, { reason: 'agent retired' });
    expect(inSubtree.status).toBe(200);
    expect(inSubtree.json.revoked).toBe(true);
    db.script.length = 0;
    db.script.push((text) => {
      if (/c\.id AS cred_id/.test(text)) {
        return { rows: [{ cred_id: CRED, principal_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', key_id: 'K', label: null, scopes: '[]', credential_type: 'api_key', expires_at: null, revoked_at: null, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 'agent', handle: 'x', display_name: null, status: 'active', role: null, harness: null, personality_id: null, parent_principal_id: ROOT, last_seen_at: null, legacy_identity: false, metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      }
      if (/WITH RECURSIVE up/.test(text)) return { rows: [] };
      return null;
    });
    const outside = await call('POST', `/credentials/${CRED}/revoke`, {});
    expect(outside.status).toBe(403);
  });
});

/* ── structural pins ────────────────────────────────────────────────── */

describe('structural pins', () => {
  it('the holder-plane route is scope-mapped; the rest of /delegation stays fail-closed', () => {
    expect(requiredScopeFor('GET', '/delegation/warrants')).toBe('authenticated');
    expect(requiredScopeFor('POST', '/delegation/warrants')).toBe('root');
  });

  it('the §9.3 credential acts ride the authenticated ceiling; the rest of the family stays owner-plane', () => {
    expect(requiredScopeFor('POST', '/credentials/x/reveal')).toBe('authenticated');
    expect(requiredScopeFor('POST', '/credentials/x/revoke')).toBe('authenticated');
    expect(requiredScopeFor('POST', '/credentials/x/rotate')).toBe('principals:admin');
    expect(requiredScopeFor('GET', '/credentials')).toBe('principals:admin');
  });
});
