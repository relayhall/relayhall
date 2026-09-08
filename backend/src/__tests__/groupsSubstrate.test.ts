/**
 * groupsSubstrate.test.ts — RH-P3.AZ-S1 (card c3716fe7; AUTHZ design
 * 4d961e37 §3, A17.6, AZ-30).
 *
 * What these pin, driving the PRODUCTION router and services where the
 * mock boundary is the database pool (the telemetryFrames precedent):
 *  - T13 scope posture: every /groups mutation is owner-plane (root);
 *    listings are principals:read; the sync-status read stays root;
 *  - the /groups route surface: strict body allowlists, typed refusals
 *    (agent-kind, parented, disabled, missing members; non-empty delete),
 *    and error mapping through the production handlers;
 *  - the group GRANT arm: activeGrantCondition carries the membership
 *    subquery with the ACTIVE-member join (T34's mechanism) in BOTH the
 *    point and list paths — parity is structural because
 *    AuthorizationService.sqlCondition composes the same seam;
 *  - grant creation accepts an existing group grantee and refuses a
 *    missing one;
 *  - migration 094 static pins: triggers, source vocabulary, sync-state
 *    seam, baseline untouched.
 *
 * END-TO-END behavior (real triggers, real joins, T31–T34 live) is proven
 * against a real migrated PostgreSQL by scripts/test-s1-groups-live.js.
 */
import express from 'express';
import http from 'http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requiredScopeFor, scopesSatisfy } from '../utils/scopeMap';

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
jest.mock('../services/AuditService', () => ({
  auditService: { record: jest.fn(async () => ({})) },
}));

import { auditService } from '../services/AuditService';
import { groupService, GroupError } from '../services/GroupService';
import { grantService } from '../services/GrantService';
import { authorizationService } from '../services/AuthorizationService';
import groupsRouter from '../routes/groups';

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';

const groupRow = (overrides: Record<string, unknown> = {}) => ({
  id: GROUP_ID, name: 'ops', description: '', created_by_principal_id: null,
  created_at: 'now', updated_at: 'now', member_count: 0, ...overrides,
});

let server: http.Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/groups', groupsRouter);
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
});

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
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

describe('T13 scope posture — group mutation is owner-plane, listings principals:read', () => {
  it('routes every mutation method to root and every listing to principals:read', () => {
    expect(requiredScopeFor('POST', '/groups')).toBe('root');
    expect(requiredScopeFor('PATCH', `/groups/${GROUP_ID}`)).toBe('root');
    expect(requiredScopeFor('DELETE', `/groups/${GROUP_ID}`)).toBe('root');
    expect(requiredScopeFor('POST', `/groups/${GROUP_ID}/members`)).toBe('root');
    expect(requiredScopeFor('DELETE', `/groups/${GROUP_ID}/members/${MEMBER_ID}`)).toBe('root');
    expect(requiredScopeFor('GET', '/groups')).toBe('principals:read');
    expect(requiredScopeFor('GET', `/groups/${GROUP_ID}`)).toBe('principals:read');
    expect(requiredScopeFor('GET', `/groups/${GROUP_ID}/members`)).toBe('principals:read');
    // The sync-status read is operator telemetry: root, spelling-immune.
    expect(requiredScopeFor('GET', '/groups/directory-sync')).toBe('root');
    expect(requiredScopeFor('GET', '/groups/DIRECTORY-SYNC/')).toBe('root');
  });

  it('no working-plane scope reaches the mutation ceiling (member add via agent → 403 at the route)', () => {
    for (const held of ['principals:read', 'tasks:write', 'tasks:admin', 'services:write', 'principals:admin']) {
      expect(scopesSatisfy([held], requiredScopeFor('POST', `/groups/${GROUP_ID}/members`))).toBe(false);
    }
    expect(scopesSatisfy(['root'], requiredScopeFor('POST', `/groups/${GROUP_ID}/members`))).toBe(true);
    const decision = authorizationService.authorizeRoute(
      { principalId: MEMBER_ID, handle: 'agent-cred', role: 'agent', scopes: ['tasks:write', 'principals:read'], authenticated: true },
      requiredScopeFor('POST', `/groups/${GROUP_ID}/members`),
    );
    expect(decision.allowed).toBe(false);
  });
});

describe('the /groups route surface (production router, pool mocked)', () => {
  it('creates a group and audits it', async () => {
    db.script.push((text) => /INSERT INTO groups/.test(text) ? { rows: [groupRow()] } : null);
    const { status, json } = await call('POST', '/groups', { name: 'ops' });
    expect(status).toBe(201);
    expect(json.group.id).toBe(GROUP_ID);
    expect((auditService.record as jest.Mock).mock.calls[0][0]).toMatchObject({ action: 'group.create' });
  });

  it('refuses unknown body fields with UNKNOWN_FIELD', async () => {
    const { status, json } = await call('POST', '/groups', { name: 'ops', extra: 1 });
    expect(status).toBe(400);
    expect(json.code).toBe('UNKNOWN_FIELD');
  });

  it('refuses empty and oversized names with typed 422s', async () => {
    for (const name of ['', '   ', 'x'.repeat(121)]) {
      const { status, json } = await call('POST', '/groups', { name });
      expect(status).toBe(422);
      expect(json.code).toBe('INVALID_GROUP_VALUE');
    }
  });

  it('member add: refuses agent-kind, parented, disabled and missing principals with typed refusals', async () => {
    db.script.push((text) => /FROM groups gr WHERE gr.id/.test(text) ? { rows: [groupRow()] } : null);
    const cases: Array<[any[], string]> = [
      [[], 'MEMBER_NOT_FOUND'],
      [[{ id: MEMBER_ID, handle: 'x', kind: 'agent', status: 'active', parent_principal_id: null }], 'MEMBER_NOT_ACCOUNT'],
      [[{ id: MEMBER_ID, handle: 'x', kind: 'service', status: 'active', parent_principal_id: GROUP_ID }], 'MEMBER_NOT_ACCOUNT'],
      [[{ id: MEMBER_ID, handle: 'x', kind: 'service', status: 'disabled', parent_principal_id: null }], 'MEMBER_DISABLED'],
    ];
    for (const [rows, code] of cases) {
      db.script.length = 1;
      db.script.push((text) => /FROM principals WHERE id/.test(text) ? { rows } : null);
      const { status, json } = await call('POST', `/groups/${GROUP_ID}/members`, { accountPrincipalId: MEMBER_ID });
      expect(status).toBe(422);
      expect(json.code).toBe(code);
    }
  });

  it('adds an active Account member and audits the source', async () => {
    db.script.push((text) => /FROM groups gr WHERE gr.id/.test(text) ? { rows: [groupRow()] } : null);
    db.script.push((text) => /FROM principals WHERE id/.test(text)
      ? { rows: [{ id: MEMBER_ID, handle: 'svc', kind: 'service', status: 'active', parent_principal_id: null }] } : null);
    db.script.push((text) => /INSERT INTO group_members/.test(text)
      ? { rows: [{ group_id: GROUP_ID, account_principal_id: MEMBER_ID, source: 'local', added_by_principal_id: null, added_at: 'now' }] } : null);
    const { status, json } = await call('POST', `/groups/${GROUP_ID}/members`, { accountPrincipalId: MEMBER_ID });
    expect(status).toBe(201);
    expect(json.member).toMatchObject({ accountPrincipalId: MEMBER_ID, kind: 'service', source: 'local' });
    expect((auditService.record as jest.Mock).mock.calls.some(
      (call_) => call_[0].action === 'group.member_add' && call_[0].metadata.source === 'local',
    )).toBe(true);
  });

  it('refuses deleting a populated group (GROUP_NOT_EMPTY) and never touches its grants', async () => {
    db.script.push((text) => /COUNT\(\*\)::int AS n FROM group_members/.test(text) ? { rows: [{ n: 2 }] } : null);
    const { status, json } = await call('DELETE', `/groups/${GROUP_ID}`);
    expect(status).toBe(409);
    expect(json.code).toBe('GROUP_NOT_EMPTY');
    expect(db.queries.some((q) => /DELETE FROM grants/.test(q.text))).toBe(false);
  });

  it('deleting an empty group deletes its grant rows in the same transaction', async () => {
    db.script.push((text) => /COUNT\(\*\)::int AS n FROM group_members/.test(text) ? { rows: [{ n: 0 }] } : null);
    db.script.push((text) => /DELETE FROM grants WHERE grantee_type = 'group'/.test(text) ? { rows: [{ id: 'g1' }, { id: 'g2' }] } : null);
    db.script.push((text) => /DELETE FROM groups WHERE id/.test(text) ? { rows: [groupRow()] } : null);
    const { status } = await call('DELETE', `/groups/${GROUP_ID}`);
    expect(status).toBe(200);
    const grantDelete = db.queries.findIndex((q) => /DELETE FROM grants WHERE grantee_type = 'group'/.test(q.text));
    expect(grantDelete).toBeGreaterThan(-1);
    expect((auditService.record as jest.Mock).mock.calls.some(
      (call_) => call_[0].action === 'group.delete' && call_[0].metadata.revokedGrantRows === 2,
    )).toBe(true);
  });
});

describe('the group grant arm (point/list parity is structural)', () => {
  it('activeGrantCondition carries the membership subquery with the ACTIVE-member join (T34)', () => {
    const seam = grantService.activeGrantCondition(4);
    expect(seam.sql).toContain("g.grantee_type = 'principal' AND g.grantee_id = $4");
    expect(seam.sql).toContain("g.grantee_type = 'group'");
    expect(seam.sql).toContain('FROM group_members gm');
    expect(seam.sql).toContain("mp.status = 'active'");
    expect(seam.sql).toContain('gm.account_principal_id = $4');
    expect(seam.bind(MEMBER_ID, 'task', 'read')).toEqual([MEMBER_ID, 'task', 'read']);
  });

  it('sqlCondition (the ONE adapter behind point AND list decisions) composes the same seam', () => {
    const decision = authorizationService.sqlCondition(
      { principalId: MEMBER_ID, handle: 'svc', role: 'agent', scopes: ['tasks:read'], authenticated: true },
      'read',
      { type: 'task', id: 't.id', owner: 't.owner_principal_id', visibility: 't.visibility' },
    );
    expect(decision.sql).toContain("g.grantee_type = 'group'");
    expect(decision.sql).toContain('FROM group_members gm');
    expect(decision.sql).toContain("mp.status = 'active'");
  });

  it('grant creation accepts an existing group grantee and refuses a missing one', async () => {
    db.script.push((text) => /SELECT id FROM groups WHERE id/.test(text) ? { rows: [{ id: GROUP_ID }] } : null);
    db.script.push((text) => /INSERT INTO grants/.test(text)
      ? { rows: [{ id: '33333333-3333-4333-8333-333333333333', grantee_type: 'group', grantee_id: GROUP_ID, resource_type: 'task', resource_id: null, verb: 'read', granted_by_principal_id: null, expires_at: null, created_at: 'now' }] } : null);
    const grant = await grantService.create(
      { granteeType: 'group', granteeId: GROUP_ID, resourceType: 'task', verb: 'read' },
      { handle: 'owner', authMethod: 'session' },
    );
    expect(grant.granteeType).toBe('group');
    const insert = db.queries.find((q) => /INSERT INTO grants/.test(q.text))!;
    expect(insert.params?.[0]).toBe('group');

    db.script.length = 0;
    db.script.push((text) => /SELECT id FROM groups WHERE id/.test(text) ? { rows: [] } : null);
    await expect(grantService.create(
      { granteeType: 'group', granteeId: GROUP_ID, resourceType: 'task', verb: 'read' },
      { handle: 'owner', authMethod: 'session' },
    )).rejects.toMatchObject({ code: 'GRANTEE_NOT_FOUND' });
  });
});

describe('AZ-30 sync seam semantics (pool mocked; live proof in scripts/test-s1-groups-live.js)', () => {
  it('a failed sync only moves the attempt watermark (T32)', async () => {
    await groupService.recordSyncFailure('idp');
    const q = db.queries.find((entry) => /directory_sync_state/.test(entry.text))!;
    expect(q.text).toContain('last_attempt_at');
    expect(q.text).toContain('last_error_present');
    expect(q.text.includes('last_success_at = NOW()')).toBe(false);
  });

  it('an invalid snapshot entry fails the whole call before any write (fail closed)', async () => {
    await expect(groupService.applyDirectorySnapshot('idp', [{ groupId: 'not-a-uuid', accountPrincipalId: MEMBER_ID }], { handle: 'sync', authMethod: 'system' }))
      .rejects.toBeInstanceOf(GroupError);
    expect(db.queries.some((q) => /DELETE FROM group_members|INSERT INTO group_members/.test(q.text))).toBe(false);
  });
});

describe('migration 094 static pins', () => {
  const sql = readFileSync(join(__dirname, '../migrations/094_groups.sql'), 'utf8');
  const baseline = readFileSync(join(__dirname, '../../../database/init.sql'), 'utf8');

  it('carries the Account-only membership trigger, the id-immutability trigger and the source vocabulary', () => {
    expect(sql).toContain('enforce_group_member_is_account');
    expect(sql).toContain('enforce_group_id_immutable');
    expect(sql).toContain("source IN ('local', 'directory')");
    expect(sql).toContain('parentless');
    expect(sql).toContain('directory_sync_state');
    expect(sql).toContain('staleness_threshold_hours');
  });

  it('leaves the baseline untouched (fresh-replay doctrine)', () => {
    expect(baseline).not.toContain('094_groups.sql');
    expect(baseline).not.toContain('CREATE TABLE IF NOT EXISTS groups');
  });
});
