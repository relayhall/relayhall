/**
 * warrantsApprovals.test.ts — RH-P3.AZ-S4 (card aa48fb12; AUTHZ design
 * 4d961e37 §6, A17.5/A17.11; T2/T3/T4/T7/T17/T21/T23/T27).
 *
 * What these pin (pool-boundary mocks per the delegationCore precedent;
 * end-to-end behavior — the T18 two-connection race above all — rides
 * scripts/test-s4-warrants-live.js and the DEV QA probe). Per the S3
 * review lesson, the ROUTE surfaces are exercised through a real express
 * app so refusals prove the production dispatch, not a service called in
 * isolation:
 *  - T3/T7 board-only: every /warrants and /approvals verb refuses bearer
 *    credentials (403 SESSION_ONLY + durable denied audit); session acts
 *    without a live step-up token refuse 403 STEP_UP_REQUIRED;
 *  - the §9.1 self-scope arm: a non-root session's approval/warrant reads
 *    conceal foreign subjects as 404;
 *  - the mint dispatch (§9.2): bearer via:'approval' creates the pending
 *    quota-bound Approval (202); the T21 quota refuses 429 with a durable
 *    audit; agent-kind bearers refuse 422 AGENT_PLANE_REFUSED (AZ-28);
 *    session mints without step-up refuse; collect by the wrong credential
 *    conceals (404);
 *  - the §6.1 edit-down contract: editedScopes ⊄ requested → 422
 *    EDIT_ONLY_NARROWS;
 *  - the containment algebra (T2/T23): conservative coverage over
 *    exact/all-of-type/all-except/wildcard sources, verb-by-verb, no
 *    cross-source unions;
 *  - warrant-mint validation order under the row lock: revoked/suspended/
 *    expired refusals, ceiling (T23), caps (T17), FOR UPDATE structural
 *    pin (T18's serialization mechanism);
 *  - AZ-31c invalidation SQL shape;
 *  - migration 098 static pins; scope-map/transport/manifest coverage of
 *    the three new mounts.
 */
import express from 'express';
import http from 'http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.RELAYHALL_CREDENTIAL_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
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
jest.mock('../services/NotificationEndpointService', () => ({
  notificationEndpointService: { dispatchException: jest.fn(async () => 0) },
}));

import warrantsRouter from '../routes/warrants';
import principalsRouter from '../routes/principals';
import approvalsRouter from '../routes/approvals';
import delegationRouter from '../routes/delegation';
import { approvalService } from '../services/ApprovalService';
import { warrantService, WarrantError } from '../services/WarrantService';
import { validateRequestedScopes, AgentMintError } from '../services/AgentMintService';
import {
  ruleCovered, rulesCovered, scopesWithin, sourcesFromEffectiveAccess, sourcesFromRules,
} from '../utils/authorityContainment';
import { invalidateApprovalsForCredentials } from '../utils/approvalInvalidation';
import { requiredScopeFor } from '../utils/scopeMap';
import { routeTransportClassFor } from '../utils/transportMap';
import { PROTECTED_ROUTE_MOUNTS } from '../utils/authorizationRouteManifest';
import type { ProfileRule } from '../services/AccessProfileService';

const ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TASK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APPROVAL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CRED = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type AuthShape = {
  principal?: { id: string; handle: string; kind: string };
  scopes?: string[];
  authMethod?: string;
  credentialId?: string;
};
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
  app.use('/warrants', warrantsRouter);
  app.use('/approvals', approvalsRouter);
  app.use('/delegation', delegationRouter);
  app.use('/principals', principalsRouter);
  server = app.listen(0, () => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => {
  jest.clearAllMocks();
  db.queries.length = 0;
  db.script.length = 0;
  authShape = {};
});

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

const asRootSession = () => { authShape = { principal: { id: ROOT, handle: 'owner', kind: 'human' }, scopes: ['root'], authMethod: 'dashboard_jwt' }; };
const asUserSession = (id: string) => { authShape = { principal: { id, handle: 'plain-user', kind: 'human' }, scopes: ['tasks:read'], authMethod: 'dashboard_jwt' }; };
const asBearer = (id: string, kind = 'service') => { authShape = { principal: { id, handle: 'conn', kind }, scopes: ['tasks:read', 'tasks:write', 'reports:write'], authMethod: 'principal_api_key', credentialId: CRED }; };

/* ── T3/T7: board-only surfaces ─────────────────────────────────────── */

describe('session-only surfaces (T3/T7)', () => {
  it.each([
    ['GET', '/warrants'],
    ['POST', '/warrants'],
    ['GET', '/approvals'],
    ['POST', `/approvals/${APPROVAL}/approve`],
    ['POST', `/approvals/${APPROVAL}/deny`],
  ])('%s %s refuses a bearer credential with SESSION_ONLY + durable audit', async (method, path) => {
    asBearer(CONNECTOR);
    const { status, json } = await call(method, path, {});
    expect(status).toBe(403);
    expect(json.code).toBe('SESSION_ONLY');
    const denial = auditRecord.mock.calls.find(
      (c: any[]) => c[0].outcome === 'denied' && c[0].metadata?.refusal === 'SESSION_ONLY',
    );
    expect(denial).toBeDefined();
  });

  it('a session decide without a live step-up token refuses STEP_UP_REQUIRED (T7/T16 shape)', async () => {
    asRootSession();
    db.script.push((text) => {
      if (/FROM approvals a/.test(text)) {
        return { rows: [{ id: APPROVAL, status: 'pending', requester_principal_id: CONNECTOR, requester_handle: 'conn', requesting_credential_id: CRED, session_evidence: null, target_task_id: TASK, target_task_title: 't', requested_scopes: '["tasks:read"]', requested_rules: '[]', approved_scopes: null, approved_rules: null, decided_by_principal_id: null, decided_at: null, denial_reason: null, lapse_reason: null, requested_at: new Date().toISOString(), pending_expires_at: new Date(Date.now() + 86400000).toISOString(), collect_expires_at: null, collected_at: null, minted_principal_id: null }] };
      }
      if (/UPDATE step_up_tokens/.test(text)) return { rows: [] }; // no live token
      return null;
    });
    const { status, json } = await call('POST', `/approvals/${APPROVAL}/approve`, { stepUpToken: 'rhsu_bogus' });
    expect(status).toBe(403);
    expect(json.code).toBe('STEP_UP_REQUIRED');
  });
});

/* ── §9.1 self-scope: conceal foreign subjects ──────────────────────── */

describe('the self-scope arm (§6.1/§9.1)', () => {
  it('a non-root session list binds its own principal into the subtree filter', async () => {
    asUserSession(ROOT);
    db.script.push((text) => (/FROM approvals a/.test(text) ? { rows: [] } : null));
    const { status } = await call('GET', '/approvals');
    expect(status).toBe(200);
    const listQuery = db.queries.find((q) => /FROM approvals a/.test(q.text));
    expect(listQuery).toBeDefined();
    expect(listQuery!.text).toMatch(/WITH RECURSIVE subtree/);
    expect(listQuery!.params).toContain(ROOT);
  });

  it('a foreign approval 404-conceals for a non-root session', async () => {
    asUserSession(ROOT);
    db.script.push((text) => {
      if (/FROM approvals a/.test(text)) {
        return { rows: [{ id: APPROVAL, status: 'pending', requester_principal_id: FOREIGN, requester_handle: 'foreign', requesting_credential_id: CRED, session_evidence: null, target_task_id: TASK, target_task_title: null, requested_scopes: '[]', requested_rules: '[]', approved_scopes: null, approved_rules: null, decided_by_principal_id: null, decided_at: null, denial_reason: null, lapse_reason: null, requested_at: new Date().toISOString(), pending_expires_at: new Date().toISOString(), collect_expires_at: null, collected_at: null, minted_principal_id: null }] };
      }
      if (/WITH RECURSIVE up/.test(text)) return { rows: [] }; // not a descendant
      return null;
    });
    const { status, json } = await call('GET', `/approvals/${APPROVAL}`);
    expect(status).toBe(404);
    expect(json.code).toBe('APPROVAL_NOT_FOUND');
  });

  it('root retains the full view: no subtree filter on the root list', async () => {
    asRootSession();
    db.script.push((text) => (/FROM approvals a/.test(text) ? { rows: [] } : null));
    await call('GET', '/approvals');
    const listQuery = db.queries.find((q) => /FROM approvals a/.test(q.text));
    expect(listQuery!.text).not.toMatch(/WITH RECURSIVE subtree/);
  });
});

/* ── the mint dispatch (§9.2) ───────────────────────────────────────── */

function scriptHealthyConnectorRequest(): void {
  db.script.push((text, params) => {
    // principalService.getPrincipalById cache-missing lookup
    if (/FROM principals\s+WHERE id = \$1/i.test(text) && params?.[0] === CONNECTOR) {
      return { rows: [{ id: CONNECTOR, kind: 'service', handle: 'conn', display_name: null, status: 'active', role: null, harness: null, personality_id: null, parent_principal_id: ROOT, last_seen_at: null, legacy_identity: false, metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
    }
    if (/WITH RECURSIVE chain/.test(text)) {
      return { rows: [
        { id: CONNECTOR, kind: 'service', role: null, status: 'active', parent_principal_id: ROOT, bound_task_id: null, legacy_identity: false, own_expression: JSON.stringify({ scopes: 'parent', objects: 'parent' }), live_credential_count: 1, depth: 0 },
        { id: ROOT, kind: 'human', role: 'admin', status: 'active', parent_principal_id: null, bound_task_id: null, legacy_identity: false, own_expression: null, live_credential_count: 0, depth: 1 },
      ] };
    }
    if (/SELECT revoked_at, expires_at, grace_until FROM principal_credentials/.test(text)) {
      return { rows: [{ revoked_at: null, expires_at: null, grace_until: null }] };
    }
    if (/SELECT status FROM tasks/.test(text)) return { rows: [{ status: 'todo' }] };
    return null;
  });
}

describe('POST /delegation/agent-mints — bearer dispatch (§6.1/§6.2)', () => {
  it("via:'approval' creates the pending quota-bound Approval (202)", async () => {
    asBearer(CONNECTOR);
    scriptHealthyConnectorRequest();
    db.script.push((text) => {
      if (/COUNT\(\*\) FILTER/.test(text)) return { rows: [{ pending: 0, daily: 0 }] };
      if (/INSERT INTO approvals/.test(text)) return { rows: [{ id: APPROVAL }] };
      if (/SELECT a\.\*, rp\.handle/.test(text)) {
        return { rows: [{ id: APPROVAL, status: 'pending', requester_principal_id: CONNECTOR, requester_handle: 'conn', requesting_credential_id: CRED, session_evidence: null, target_task_id: TASK, target_task_title: 't', requested_scopes: '["tasks:read"]', requested_rules: '[]', approved_scopes: null, approved_rules: null, decided_by_principal_id: null, decided_at: null, denial_reason: null, lapse_reason: null, requested_at: new Date().toISOString(), pending_expires_at: new Date(Date.now() + 86400000).toISOString(), collect_expires_at: null, collected_at: null, minted_principal_id: null }] };
      }
      return null;
    });
    const { status, json } = await call('POST', '/delegation/agent-mints', {
      via: 'approval', targetTaskId: TASK, requestedScopes: ['tasks:read'],
    });
    expect(status).toBe(202);
    expect(json.path).toBe('approval');
    expect(json.approval.id).toBe(APPROVAL);
    // The approval binds to the EXACT presenting credential (AZ-31c).
    const insert = db.queries.find((q) => /INSERT INTO approvals/.test(q.text));
    expect(insert!.params).toContain(CRED);
  });

  it('the T21 quota refuses 429 MINT_QUOTA_EXCEEDED with a durable audit', async () => {
    asBearer(CONNECTOR);
    scriptHealthyConnectorRequest();
    db.script.push((text) => (/COUNT\(\*\) FILTER/.test(text) ? { rows: [{ pending: 5, daily: 5 }] } : null));
    const { status, json } = await call('POST', '/delegation/agent-mints', {
      via: 'approval', targetTaskId: TASK, requestedScopes: ['tasks:read'],
    });
    expect(status).toBe(429);
    expect(json.code).toBe('MINT_QUOTA_EXCEEDED');
    const denial = auditRecord.mock.calls.find(
      (c: any[]) => c[0].outcome === 'denied' && c[0].metadata?.refusal === 'MINT_QUOTA_EXCEEDED',
    );
    expect(denial).toBeDefined();
    expect(db.queries.some((q) => /INSERT INTO approvals/.test(q.text))).toBe(false);
  });

  it('an Agent-layer bearer refuses 422 AGENT_PLANE_REFUSED (AZ-28)', async () => {
    asBearer(CONNECTOR, 'agent');
    const { status, json } = await call('POST', '/delegation/agent-mints', {
      targetTaskId: TASK, requestedScopes: ['tasks:read'],
    });
    expect(status).toBe(422);
    expect(json.code).toBe('AGENT_PLANE_REFUSED');
  });

  it('requested root / *:admin scopes refuse before any dispatch (§5.2 rules 2/3)', async () => {
    asBearer(CONNECTOR);
    const root = await call('POST', '/delegation/agent-mints', { targetTaskId: TASK, requestedScopes: ['root'] });
    expect(root.status).toBe(422);
    expect(root.json.code).toBe('ROOT_NOT_MINTABLE');
    const admin = await call('POST', '/delegation/agent-mints', { targetTaskId: TASK, requestedScopes: ['tasks:admin'] });
    expect(admin.status).toBe(422);
    expect(admin.json.code).toBe('ADMIN_NOT_AGENT_DELEGABLE');
  });

  it('a session mint without a live step-up token refuses (§6.1a)', async () => {
    asRootSession();
    db.script.push((text) => (/UPDATE step_up_tokens/.test(text) ? { rows: [] } : null));
    const { status, json } = await call('POST', '/delegation/agent-mints', {
      targetTaskId: TASK, requestedScopes: ['tasks:read'], stepUpToken: 'rhsu_bogus',
    });
    expect(status).toBe(403);
    expect(json.code).toBe('STEP_UP_REQUIRED');
  });

  it('collect by a DIFFERENT credential conceals the approval (404, AZ-31c)', async () => {
    asBearer(CONNECTOR);
    db.script.push((text) => {
      if (/SELECT \* FROM approvals WHERE id = \$1 FOR UPDATE/.test(text)) {
        return { rows: [{ id: APPROVAL, status: 'approved', requester_principal_id: FOREIGN, requesting_credential_id: 'ffffffff-0000-4fff-8fff-000000000000', target_task_id: TASK, approved_scopes: '["tasks:read"]', approved_rules: '[]', collect_expires_at: new Date(Date.now() + 3600000).toISOString() }] };
      }
      return null;
    });
    const { status, json } = await call('POST', `/delegation/agent-mints/${APPROVAL}/collect`, {});
    expect(status).toBe(404);
    expect(json.code).toBe('APPROVAL_NOT_FOUND');
  });
});

/* ── §6.1 edit-down ─────────────────────────────────────────────────── */

describe('edit-before-approve narrows only (§6.1)', () => {
  it('editedScopes outside the request refuse 422 EDIT_ONLY_NARROWS', async () => {
    asRootSession();
    db.script.push((text) => {
      if (/UPDATE step_up_tokens/.test(text)) return { rows: [{ id: 'su-1', method: 'password' }] };
      if (/SELECT \* FROM approvals WHERE id = \$1 FOR UPDATE/.test(text)) {
        return { rows: [{ id: APPROVAL, status: 'pending', requester_principal_id: CONNECTOR, requesting_credential_id: CRED, target_task_id: TASK, requested_scopes: '["tasks:read"]', requested_rules: '[]', pending_expires_at: new Date(Date.now() + 86400000).toISOString() }] };
      }
      if (/FROM approvals a/.test(text)) {
        return { rows: [{ id: APPROVAL, status: 'pending', requester_principal_id: CONNECTOR, requester_handle: 'conn', requesting_credential_id: CRED, session_evidence: null, target_task_id: TASK, target_task_title: 't', requested_scopes: '["tasks:read"]', requested_rules: '[]', approved_scopes: null, approved_rules: null, decided_by_principal_id: null, decided_at: null, denial_reason: null, lapse_reason: null, requested_at: new Date().toISOString(), pending_expires_at: new Date(Date.now() + 86400000).toISOString(), collect_expires_at: null, collected_at: null, minted_principal_id: null }] };
      }
      return null;
    });
    const { status, json } = await call('POST', `/approvals/${APPROVAL}/approve`, {
      stepUpToken: 'rhsu_ok', editedScopes: ['tasks:read', 'tasks:write'],
    });
    expect(status).toBe(422);
    expect(json.code).toBe('EDIT_ONLY_NARROWS');
  });
});

/* ── the containment algebra (T2/T23) ───────────────────────────────── */

describe('authority containment (conservative, deterministic)', () => {
  const rule = (overrides: Partial<ProfileRule>): ProfileRule => ({
    resourceType: 'task', selectorForm: 'exact', selectorIds: ['id-1'], verbs: ['read'], ...overrides,
  });

  it('exact requests sit inside exact/wildcard/all-of-type sources; all-of-type needs full width', () => {
    const sources = sourcesFromEffectiveAccess({
      grants: [
        { resourceType: 'task', resourceId: 'id-1', verb: 'read' },
        { resourceType: 'report', resourceId: null, verb: 'write' },
      ],
      profiles: [
        { resourceType: 'phase', selectorForm: 'all-of-type', selectorIds: [], verbs: ['read'] },
      ],
    });
    expect(ruleCovered(sources, rule({}))).toBe(true);
    expect(ruleCovered(sources, rule({ selectorIds: ['id-1', 'id-2'] }))).toBe(false);
    expect(ruleCovered(sources, rule({ resourceType: 'report', selectorForm: 'all-of-type', selectorIds: [], verbs: ['write'] }))).toBe(true);
    expect(ruleCovered(sources, rule({ resourceType: 'phase', selectorForm: 'all-of-type', selectorIds: [], verbs: ['read'] }))).toBe(true);
    // an exact grant never covers all-of-type breadth
    expect(ruleCovered(sources, rule({ selectorForm: 'all-of-type', selectorIds: [] }))).toBe(false);
  });

  it('all-except containment: covering exclusions ⊆ requested exclusions; exact must dodge them', () => {
    const sources = sourcesFromRules([
      { resourceType: 'task', selectorForm: 'all-except', selectorIds: ['x'], verbs: ['read'] },
    ]);
    expect(ruleCovered(sources, rule({ selectorForm: 'all-except', selectorIds: ['x', 'y'] }))).toBe(true);
    expect(ruleCovered(sources, rule({ selectorForm: 'all-except', selectorIds: ['y'] }))).toBe(false);
    expect(ruleCovered(sources, rule({ selectorIds: ['y'] }))).toBe(true);
    expect(ruleCovered(sources, rule({ selectorIds: ['x'] }))).toBe(false);
    expect(ruleCovered(sources, rule({ selectorForm: 'all-of-type', selectorIds: [] }))).toBe(false);
  });

  it('verb-by-verb: every requested verb needs a covering source; one source per verb-selector', () => {
    const sources = sourcesFromRules([
      { resourceType: 'task', selectorForm: 'exact', selectorIds: ['id-1'], verbs: ['read'] },
      { resourceType: 'task', selectorForm: 'exact', selectorIds: ['id-1'], verbs: ['write'] },
      { resourceType: 'task', selectorForm: 'exact', selectorIds: ['id-2'], verbs: ['read'] },
    ]);
    expect(ruleCovered(sources, rule({ verbs: ['read', 'write'] }))).toBe(true);
    // no cross-source id union: id-1+id-2 jointly covered, but no ONE source covers both
    expect(ruleCovered(sources, rule({ selectorIds: ['id-1', 'id-2'] }))).toBe(false);
    const check = rulesCovered(sources, [rule({ verbs: ['use'] })]);
    expect(check.covered).toBe(false);
    expect(check.failing).not.toBeNull();
  });

  it('scope ceilings: NULL imposes nothing here; exceedances are named', () => {
    expect(scopesWithin(null, ['tasks:write']).within).toBe(true);
    const result = scopesWithin(['tasks:read'], ['tasks:read', 'reports:write']);
    expect(result.within).toBe(false);
    expect(result.exceeding).toEqual(['reports:write']);
  });

  it('validateRequestedScopes refuses root, *:admin and unknown scopes', () => {
    expect(() => validateRequestedScopes(['root'])).toThrow(AgentMintError);
    expect(() => validateRequestedScopes(['tasks:admin'])).toThrow(/rule 3/);
    expect(() => validateRequestedScopes(['made:up'])).toThrow(/not a mintable scope/);
    expect(validateRequestedScopes(['tasks:read', 'tasks:read'])).toEqual(['tasks:read']);
  });
});

/* ── warrant-mint validation under the lock (§6.2–6.4) ──────────────── */

function warrantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ababaaba-abab-4aba-8aba-abababababab',
    name: 'w', description: '', holder_principal_id: CONNECTOR,
    created_by_principal_id: ROOT, status: 'active',
    ceiling_profile_version_id: null,
    ceiling_rules: JSON.stringify([{ resourceType: 'task', selectorForm: 'exact', selectorIds: [TASK], verbs: ['read'] }]),
    ceiling_scopes: JSON.stringify(['tasks:read']),
    expires_at: null, transport_pin: 'any', agent_max_age_hours: null,
    max_concurrent: null, max_total: null, minted_total: 0,
    suspended_reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('mintUnderWarrant (T4/T17/T18/T23 shapes)', () => {
  const mint = (row: Record<string, unknown>, authority = { scopes: ['tasks:read'], rules: [] as ProfileRule[] }, extraScript?: (text: string, params?: unknown[]) => { rows: any[] } | null) =>
    (async () => {
      db.script.length = 0;
      db.script.push((text, params) => {
        if (/SELECT \* FROM warrants WHERE id = \$1 FOR UPDATE/.test(text)) return { rows: [row] };
        if (/SELECT parent_principal_id, kind FROM principals/.test(text)) return { rows: [{ parent_principal_id: ROOT, kind: 'service' }] };
        if (/SELECT status, role, kind, parent_principal_id FROM principals/.test(text) && params?.[0] === ROOT) {
          return { rows: [{ status: 'active', role: 'admin', kind: 'human', parent_principal_id: null }] };
        }
        if (/FROM warrant_anchors wa/.test(text)) return { rows: [{ '?column?': 1 }] };
        if (extraScript) return extraScript(text, params);
        return null;
      });
      scriptHealthyConnectorRequest();
      return warrantService.mintUnderWarrant({
        actingPrincipalId: CONNECTOR,
        actingCredentialScopes: ['tasks:read', 'tasks:write'],
        targetTaskId: TASK,
        warrantId: String(row.id),
        authority,
      }, { handle: 'conn', authMethod: 'principal_api_key' });
    })();

  it.each([
    ['revoked', 'WARRANT_REVOKED'],
    ['suspended', 'WARRANT_SUSPENDED'],
    ['expired', 'WARRANT_EXPIRED'],
  ])('a %s warrant refuses %s', async (status, code) => {
    await expect(mint(warrantRow({ status, suspended_reason: 'x' }))).rejects.toMatchObject({ code });
  });

  it('a past expiry refuses LIVE, sweep or no sweep (§6.2)', async () => {
    await expect(mint(warrantRow({ expires_at: new Date(Date.now() - 1000).toISOString() })))
      .rejects.toMatchObject({ code: 'WARRANT_EXPIRED' });
  });

  it('requested authority above the ceiling refuses CEILING_EXCEEDED (T23 shape)', async () => {
    await expect(mint(warrantRow(), { scopes: ['tasks:read', 'tasks:write'], rules: [] }))
      .rejects.toMatchObject({ code: 'CEILING_EXCEEDED' });
    await expect(mint(warrantRow(), {
      scopes: ['tasks:read'],
      rules: [{ resourceType: 'report', selectorForm: 'all-of-type', selectorIds: [], verbs: ['write'] }],
    })).rejects.toMatchObject({ code: 'CEILING_EXCEEDED' });
  });

  it('an exhausted max_total refuses loudly (T17)', async () => {
    await expect(mint(warrantRow({ max_total: 3, minted_total: 3 })))
      .rejects.toMatchObject({ code: 'WARRANT_CAP_EXHAUSTED' });
  });

  it('an exhausted max_concurrent (live count via the provenance FK) refuses (T17)', async () => {
    await expect(mint(warrantRow({ max_concurrent: 1 }), undefined, (text) => {
      if (/COUNT\(\*\)::int AS live FROM principals p/.test(text)) return { rows: [{ live: 1 }] };
      return null;
    })).rejects.toMatchObject({ code: 'WARRANT_CAP_EXHAUSTED' });
  });

  it('a foreign holder conceals the warrant (404 shape)', async () => {
    await expect(mint(warrantRow({ holder_principal_id: FOREIGN })))
      .rejects.toMatchObject({ code: 'WARRANT_NOT_FOUND', status: 404 });
  });

  it('the warrant row is taken FOR UPDATE (the T18 serialization mechanism)', async () => {
    await mint(warrantRow({ status: 'revoked' })).catch(() => undefined);
    expect(db.queries.some((q) => /FROM warrants WHERE id = \$1 FOR UPDATE/.test(q.text))).toBe(true);
  });

  it('auto-select refuses on multiplicity (sol M8) — the error names AMBIGUOUS_WARRANT', async () => {
    db.script.push((text) => {
      if (/SELECT w\.id FROM warrants w/.test(text)) {
        return { rows: [{ id: 'ababaaba-abab-4aba-8aba-abababababab' }, { id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd' }] };
      }
      if (/FROM warrant_anchors wa/.test(text)) return { rows: [{ '?column?': 1 }] };
      return null;
    });
    await expect(warrantService.mintUnderWarrant({
      actingPrincipalId: CONNECTOR, actingCredentialScopes: [], targetTaskId: TASK,
      warrantId: null, authority: { scopes: ['tasks:read'], rules: [] },
    }, { handle: 'conn', authMethod: 'principal_api_key' })).rejects.toMatchObject({ code: 'AMBIGUOUS_WARRANT' });
  });
});

/* ── round-2 repairs (review 1897c959) ──────────────────────────────── */

describe('B1: the warrant ceiling scope half binds the creator (§6.2/AZ-31a)', () => {
  it('a non-root creator cannot put scopes it does not hold into ceilingScopes', async () => {
    db.script.push((text, params) => {
      if (/FROM principals\s+WHERE id = \$1/i.test(text) && params?.[0] === CONNECTOR) {
        return { rows: [{ id: CONNECTOR, kind: 'service', handle: 'conn', display_name: null, status: 'active', role: null, harness: null, personality_id: null, parent_principal_id: ROOT, last_seen_at: null, legacy_identity: false, metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      }
      if (/SELECT 1 FROM tasks WHERE id = \$1/.test(text)) return { rows: [{ '?column?': 1 }] };
      if (/FROM grants g/.test(text)) {
        return { rows: [{ id: 'g1', grantee_type: 'principal', grantee_id: FOREIGN, resource_type: 'task', resource_id: null, verb: 'read', expires_at: null, group_name: null }] };
      }
      if (/FROM access_profile_assignments apa/.test(text)) return { rows: [] };
      return null;
    });
    await expect(warrantService.create({
      name: 'b1', holderPrincipalId: CONNECTOR,
      anchors: [{ anchorType: 'task', anchorId: TASK }],
      ceilingRules: [{ resourceType: 'task', selectorForm: 'all-of-type', selectorIds: [], verbs: ['read'] }],
      ceilingScopes: ['tasks:read', 'tasks:write'],
    } as any, { principalId: FOREIGN, isRoot: false, sessionScopes: ['tasks:read'], stepUp: { tokenId: 'x', method: 'password' } },
    { handle: 'plain', authMethod: 'session' })).rejects.toMatchObject({ code: 'CEILING_EXCEEDS_CREATOR' });
  });
});

describe('B2: decision-time revalidation uses the CURRENT effective scopes (§6.1/T27)', () => {
  it('an own()-narrowed requester refuses at decide even though the stored credential scopes still cover', async () => {
    asRootSession();
    db.script.push((text, params) => {
      if (/UPDATE step_up_tokens/.test(text)) return { rows: [{ id: 'su-1', method: 'password' }] };
      if (/SELECT \* FROM approvals WHERE id = \$1 FOR UPDATE/.test(text)) {
        return { rows: [{ id: APPROVAL, status: 'pending', requester_principal_id: CONNECTOR, requesting_credential_id: CRED, target_task_id: TASK, requested_scopes: '["tasks:read","tasks:write"]', requested_rules: '[]', pending_expires_at: new Date(Date.now() + 86400000).toISOString() }] };
      }
      if (/FROM approvals a/.test(text)) {
        return { rows: [{ id: APPROVAL, status: 'pending', requester_principal_id: CONNECTOR, requester_handle: 'conn', requesting_credential_id: CRED, session_evidence: null, target_task_id: TASK, target_task_title: 't', requested_scopes: '["tasks:read","tasks:write"]', requested_rules: '[]', approved_scopes: null, approved_rules: null, decided_by_principal_id: null, decided_at: null, denial_reason: null, lapse_reason: null, requested_at: new Date().toISOString(), pending_expires_at: new Date(Date.now() + 86400000).toISOString(), collect_expires_at: null, collected_at: null, minted_principal_id: null }] };
      }
      if (/FROM principals\s+WHERE id = \$1/i.test(text) && params?.[0] === CONNECTOR) {
        return { rows: [{ id: CONNECTOR, kind: 'service', handle: 'conn', display_name: null, status: 'active', role: null, harness: null, personality_id: null, parent_principal_id: ROOT, last_seen_at: null, legacy_identity: false, metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      }
      if (/WITH RECURSIVE chain/.test(text)) {
        // The requester's own() scope cap was NARROWED to tasks:read AFTER
        // the request — the stored credential still says read+write.
        return { rows: [
          { id: CONNECTOR, kind: 'service', role: null, status: 'active', parent_principal_id: ROOT, bound_task_id: null, legacy_identity: false, own_expression: JSON.stringify({ scopes: ['tasks:read'], objects: 'parent' }), live_credential_count: 1, depth: 0 },
          { id: ROOT, kind: 'human', role: 'admin', status: 'active', parent_principal_id: null, bound_task_id: null, legacy_identity: false, own_expression: null, live_credential_count: 0, depth: 1 },
        ] };
      }
      if (/SELECT revoked_at, expires_at, grace_until FROM principal_credentials/.test(text)) {
        return { rows: [{ revoked_at: null, expires_at: null, grace_until: null }] };
      }
      if (/SELECT status FROM tasks/.test(text)) return { rows: [{ status: 'todo' }] };
      if (/SELECT scopes FROM principal_credentials/.test(text)) return { rows: [{ scopes: '["tasks:read","tasks:write"]' }] };
      return null;
    });
    const { status, json } = await call('POST', `/approvals/${APPROVAL}/approve`, { stepUpToken: 'rhsu_ok' });
    expect(status).toBe(403);
    expect(json.code).toBe('MINT_EXCEEDS_REQUESTER');
  });
});

/* ── AZ-31c invalidation SQL shape ──────────────────────────────────── */

describe('approval invalidation on credential death (AZ-31c)', () => {
  it('lapses pending/approved rows bound to the credentials with reason CREDENTIAL_ROTATED', async () => {
    db.script.push((text) => {
      if (/UPDATE approvals/.test(text)) return { rows: [{ id: APPROVAL, requesting_credential_id: CRED }] };
      return null;
    });
    const count = await invalidateApprovalsForCredentials(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require('../db/connection') as any).pool,
      [CRED], 'rotated', { handle: 'system', authMethod: 'system' },
    );
    expect(count).toBe(1);
    const update = db.queries.find((q) => /UPDATE approvals/.test(q.text));
    expect(update!.text).toMatch(/CREDENTIAL_ROTATED/);
    expect(update!.text).toMatch(/status IN \('pending', 'approved'\)/);
    const event = db.queries.find((q) => /INSERT INTO approval_events/.test(q.text));
    expect(event).toBeDefined();
  });
});

describe('F1 (review 644a2538): warrant update is a transactional, fully audited act (§9.7)', () => {
  const scriptGetWarrant = () => {
    db.script.push((text) => {
      if (/FROM warrants w/.test(text)) return { rows: [warrantRow()] };
      if (/FROM warrant_anchors WHERE warrant_id/.test(text) || /SELECT anchor_type, anchor_id/.test(text)) return { rows: [] };
      if (/COUNT\(\*\)::int AS live/.test(text)) return { rows: [{ live: 0 }] };
      return null;
    });
  };

  it('the mutation, the warrant.updated event and the central audit act share one transaction, chain included', async () => {
    scriptGetWarrant();
    await warrantService.update('ababaaba-abab-4aba-8aba-abababababab', { name: 'renamed' }, { handle: 'owner', authMethod: 'session' });
    const begin = db.queries.findIndex((q) => q.text === 'BEGIN');
    const update = db.queries.findIndex((q) => /UPDATE warrants SET name/.test(q.text));
    const event = db.queries.findIndex((q) => /INSERT INTO warrant_events/.test(q.text));
    const commit = db.queries.findIndex((q) => q.text === 'COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(update).toBeGreaterThan(begin);
    expect(event).toBeGreaterThan(update);
    expect(commit).toBeGreaterThan(event);
    const audit = (auditRecord.mock.calls as unknown as any[][]).find((c) => c[0]?.action === 'warrant.update');
    expect(audit).toBeDefined();
    expect(Array.isArray(audit![0].metadata.chain)).toBe(true);
    // The audit rode the SAME client (second arg present = transactional).
    expect(audit![1]).toBeDefined();
  });

  it('a failed ledger write rolls the edit back — no partial mutation survives', async () => {
    scriptGetWarrant();
    db.script.push((text) => {
      if (/INSERT INTO warrant_events/.test(text)) { throw new Error('ledger down'); }
      return null;
    });
    await expect(warrantService.update('ababaaba-abab-4aba-8aba-abababababab', { name: 'renamed' }, { handle: 'owner', authMethod: 'session' }))
      .rejects.toThrow('ledger down');
    const rollback = db.queries.findIndex((q) => q.text === 'ROLLBACK');
    expect(rollback).toBeGreaterThan(db.queries.findIndex((q) => /UPDATE warrants SET name/.test(q.text)));
    expect(db.queries.some((q) => q.text === 'COMMIT')).toBe(false);
  });
});

describe('B3 backend seam: session subtree credential introspection (§9.2)', () => {
  it('an authenticated session lists a DESCENDANT identity\'s credentials (secrets excluded)', async () => {
    asUserSession(ROOT);
    db.script.push((text) => {
      if (/WITH RECURSIVE up/.test(text)) return { rows: [{ hit: 1 }] }; // descendant
      if (/FROM principal_credentials\s+WHERE principal_id = \$1/i.test(text)) {
        return { rows: [{ id: CRED, key_id: 'K', label: null, scopes: '["tasks:read"]', credential_type: 'api_key', created_at: new Date().toISOString(), expires_at: null, revoked_at: null, last_used_at: null, reveal_count: 2, grace_until: null, transport: 'any', revealable: true }] };
      }
      return null;
    });
    const { status, json } = await call('GET', `/principals/${FOREIGN}/credentials`);
    expect(status).toBe(200);
    expect(json.credentials[0].revealCount).toBe(2);
    expect(json.credentials[0].revealable).toBe(true);
  });

  it('a session outside the subtree keeps the manage gate; a working-plane bearer never widens', async () => {
    asUserSession(ROOT);
    db.script.push((text) => (/WITH RECURSIVE up/.test(text) ? { rows: [] } : null));
    const outside = await call('GET', `/principals/${FOREIGN}/credentials`);
    expect(outside.status).toBe(403);
    asBearer(CONNECTOR);
    const bearer = await call('GET', `/principals/${FOREIGN}/credentials`);
    expect(bearer.status).toBe(403);
  });
});

/* ── structural pins ────────────────────────────────────────────────── */

// ── AZ-A3: the inline-rules convenience path (owner gate 553c3a5f) ──────
//
// A ceiling sent as `ceilingRules` is PUBLISHED as a real Access profile
// inside the warrant's own transaction. Review 3e0a103d B7 caught the first
// cut recording only `profile.create` centrally while performing a genuine
// publication — §9.7 audits publish, and §5.2 rule 8 audits every authority
// act, so a required act was simply absent from audit_events on the new
// happy path.
describe('AZ-A3 — inline rules publish a profile inside the warrant transaction', () => {
    const PROFILE = "11111111-1111-4111-8111-111111111111";
    const VERSION = "22222222-2222-4222-8222-222222222222";
    const WARRANT = "33333333-3333-4333-8333-333333333333";
    const CEILING = [{ resourceType: 'task', selectorForm: 'all-except', selectorIds: [TASK], verbs: ['read'] }];
    const rootCreator = {
      principalId: ROOT, isRoot: true, sessionScopes: ['root'],
      stepUp: { tokenId: 'x', method: 'password' },
    } as any;

    function armPublishScript(failAt?: RegExp): void {
      db.queries.length = 0;
      db.script.length = 0;
      auditRecord.mockClear();
      db.script.push((text: string, params?: unknown[]) => {
        if (failAt && failAt.test(text)) throw new Error('scripted failure');
        if (/FROM principals\s+WHERE id = \$1/i.test(text) && params?.[0] === CONNECTOR) {
          return { rows: [{ id: CONNECTOR, kind: 'service', handle: 'conn', display_name: null, status: 'active', role: null, harness: null, personality_id: null, parent_principal_id: ROOT, last_seen_at: null, legacy_identity: false, metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
        }
        if (/SELECT 1 FROM tasks WHERE id = \$1/.test(text)) return { rows: [{ '?column?': 1 }] };
        if (/INSERT INTO access_profiles/.test(text)) return { rows: [{ id: PROFILE }] };
        if (/INSERT INTO access_profile_versions/.test(text)) return { rows: [{ id: VERSION }] };
        if (/INSERT INTO warrants/.test(text)) return { rows: [{ id: WARRANT }] };
        return null;
      });
    }

    it('records BOTH central acts — the creation and the publication', async () => {
      armPublishScript();
      await warrantService.create({
        name: 'aza3', holderPrincipalId: CONNECTOR,
        anchors: [{ anchorType: 'task', anchorId: TASK }],
        ceilingRules: CEILING,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      } as any, rootCreator, { handle: 'owner', authMethod: 'session' }).catch(() => undefined);

      const actions = auditRecord.mock.calls.map((call: any[]) => call[0]?.action);
      expect(actions).toContain('profile.create');
      // The finding: this one was missing while a publication really happened.
      expect(actions).toContain('profile.publish');
      expect(actions).toContain('warrant.create');
    });

    it('publishes through the SAME client as the warrant write — one transaction', async () => {
      armPublishScript();
      await warrantService.create({
        name: 'aza3-txn', holderPrincipalId: CONNECTOR,
        anchors: [{ anchorType: 'task', anchorId: TASK }],
        ceilingRules: CEILING,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      } as any, rootCreator, { handle: 'owner', authMethod: 'session' }).catch(() => undefined);

      const texts = db.queries.map((q) => q.text.replace(/\s+/g, ' ').trim());
      const begin = texts.findIndex((t) => t === 'BEGIN');
      const profile = texts.findIndex((t) => /INSERT INTO access_profiles/.test(t));
      const published = texts.findIndex((t) => /UPDATE access_profiles SET published_version_id/.test(t));
      const warrant = texts.findIndex((t) => /INSERT INTO warrants/.test(t));
      const commit = texts.findIndex((t) => t === 'COMMIT');
      // The publication happens BEFORE the warrant row and both are inside
      // one BEGIN..COMMIT: a warrant that fails validation later cannot
      // leave a published profile behind.
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(profile).toBeGreaterThan(begin);
      expect(published).toBeGreaterThan(profile);
      expect(warrant).toBeGreaterThan(published);
      expect(commit).toBeGreaterThan(warrant);
    });

    // POSITIVE CONTROL: when the warrant write itself fails, the whole
    // transaction rolls back — the profile does not survive its warrant.
    it('rolls the published profile back with the warrant', async () => {
      armPublishScript(/INSERT INTO warrants/);
      await expect(warrantService.create({
        name: 'aza3-rollback', holderPrincipalId: CONNECTOR,
        anchors: [{ anchorType: 'task', anchorId: TASK }],
        ceilingRules: CEILING,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      } as any, rootCreator, { handle: 'owner', authMethod: 'session' })).rejects.toBeDefined();

      const texts = db.queries.map((q) => q.text.replace(/\s+/g, ' ').trim());
      expect(texts).toContain('ROLLBACK');
      expect(texts).not.toContain('COMMIT');
      // And the profile really had been written before the failure — a test
      // that never reached the publication would pass vacuously.
      expect(texts.some((t) => /INSERT INTO access_profiles/.test(t))).toBe(true);
    });
  });

describe('structural pins (098 / scope map / transport / manifest)', () => {
  const migration = readFileSync(join(__dirname, '..', 'migrations', '098_warrants_approvals.sql'), 'utf8');

  it('098 declares the §6 substrate: tables, provenance FK, append-only ledgers, one-way triggers', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS warrants/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS warrant_anchors/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS approvals/);
    expect(migration).toMatch(/minted_under_warrant_id UUID REFERENCES warrants\(id\)/);
    expect(migration).toMatch(/warrants_ceiling_present/);
    expect(migration).toMatch(/minted_total INTEGER NOT NULL DEFAULT 0/);
    expect(migration).toMatch(/trg_warrant_events_append_only/);
    expect(migration).toMatch(/trg_approvals_one_way/);
    expect(migration).toMatch(/trg_warrants_one_way/);
    expect(migration).toMatch(/'pending', 'approved', 'denied', 'collected', 'lapsed'/);
  });

  it('the new families are scope-mapped (authenticated + in-handler contract) and the remediation queue is owner-plane', () => {
    expect(requiredScopeFor('GET', '/warrants')).toBe('authenticated');
    expect(requiredScopeFor('POST', '/approvals/x/approve')).toBe('authenticated');
    expect(requiredScopeFor('POST', '/delegation/agent-mints')).toBe('authenticated');
    expect(requiredScopeFor('GET', '/principals/remediation-queue')).toBe('root');
    // Anything else under /delegation stays unmapped → root (fail closed).
    expect(requiredScopeFor('POST', '/delegation/other')).toBe('root');
  });

  it('the new mounts carry declared transport classes and ride the protected manifest', () => {
    expect(routeTransportClassFor('/warrants')).toBe('any');
    expect(routeTransportClassFor('/approvals/x/approve')).toBe('any');
    expect(routeTransportClassFor('/delegation/agent-mints')).toBe('any');
    for (const mount of ['/warrants', '/approvals', '/delegation']) {
      expect(PROTECTED_ROUTE_MOUNTS).toContain(mount);
    }
  });

  it('the WarrantError/AgentMintError taxonomy separates terminal from transient (T27)', () => {
    expect(new WarrantError(409, 'X', 'x')).toBeInstanceOf(Error);
    const terminal = new AgentMintError(409, 'TASK_TERMINAL', 'x', 'terminal');
    const transient = new AgentMintError(409, 'WRITER_SLOT_TAKEN', 'x');
    expect(terminal.disposition).toBe('terminal');
    expect(transient.disposition).toBe('transient');
  });

  it('the approval TTL constants match the ratified §6.1 numbers', () => {
    const { APPROVAL_PENDING_TTL_MS, APPROVAL_COLLECT_TTL_MS, APPROVAL_QUOTA_PENDING, APPROVAL_QUOTA_DAILY } = jest.requireActual('../services/ApprovalService');
    expect(APPROVAL_PENDING_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(APPROVAL_COLLECT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(APPROVAL_QUOTA_PENDING).toBe(5);
    expect(APPROVAL_QUOTA_DAILY).toBe(20);
    void approvalService;
  });
});
