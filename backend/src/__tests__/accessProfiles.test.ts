/**
 * accessProfiles.test.ts — RH-P3.AZ-S2 (card 559393f5; AUTHZ design
 * 4d961e37 §4, A17.4).
 *
 * What these pin, driving the PRODUCTION router and services with the
 * database pool as the mock boundary (the telemetryFrames precedent):
 *  - scope posture: profile MUTATION is owner-plane (root); listings are
 *    principals:read; what-if and provenance events stay root; the self
 *    preview rides the /principals principals:read family;
 *  - the profile seam: activeProfileCondition joins assignments through
 *    published_version_id (T14 by construction), yields nothing for
 *    unpublished profiles (T35), evaluates all three selector forms
 *    against the live resource id column, and resolves group assignees by
 *    the SAME active-member join as the group grant arm; sqlCondition
 *    composes it for point AND list (parity structural);
 *  - route/service refusals: draft-assign (T35), parented/agent assignee
 *    (the AZ-S2 sequencing guard), disabled assignee, missing group,
 *    rollback-is-republish, rule validation;
 *  - migration 095 static pins: immutability + append-only + pairing
 *    triggers, selector shape CHECK, baseline untouched.
 *
 * END-TO-END behavior (real triggers/joins, T14/T35 live, selector
 * future-inclusion) is proven against a real migrated PostgreSQL by
 * scripts/test-s2-profiles-live.js.
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
import {
  accessProfileService, AccessProfileError, validateRules, assertGovernableSurfaceSelectors,
} from '../services/AccessProfileService';
import { authorizationService } from '../services/AuthorizationService';
import accessProfilesRouter from '../routes/accessProfiles';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const ASSIGNEE_ID = '33333333-3333-4333-8333-333333333333';

const profileRow = (overrides: Record<string, unknown> = {}) => ({
  id: PROFILE_ID, name: 'reader', description: '', published_version_id: null,
  published_version_number: null, version_count: 0, assignment_count: 0,
  created_by_principal_id: null, created_at: 'now', updated_at: 'now', ...overrides,
});

let server: http.Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/access-profiles', accessProfilesRouter);
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

describe('scope posture (§9.1: profile mutation owner-plane; introspection principals:read)', () => {
  it('routes every mutation to root, listings to principals:read, what-if/events to root', () => {
    expect(requiredScopeFor('POST', '/access-profiles')).toBe('root');
    expect(requiredScopeFor('PATCH', `/access-profiles/${PROFILE_ID}`)).toBe('root');
    expect(requiredScopeFor('DELETE', `/access-profiles/${PROFILE_ID}`)).toBe('root');
    expect(requiredScopeFor('POST', `/access-profiles/${PROFILE_ID}/versions`)).toBe('root');
    expect(requiredScopeFor('POST', `/access-profiles/${PROFILE_ID}/publish`)).toBe('root');
    expect(requiredScopeFor('POST', `/access-profiles/${PROFILE_ID}/assignments`)).toBe('root');
    expect(requiredScopeFor('DELETE', `/access-profiles/${PROFILE_ID}/assignments/x`)).toBe('root');
    expect(requiredScopeFor('GET', '/access-profiles')).toBe('principals:read');
    expect(requiredScopeFor('GET', `/access-profiles/${PROFILE_ID}`)).toBe('principals:read');
    expect(requiredScopeFor('GET', `/access-profiles/${PROFILE_ID}/versions`)).toBe('principals:read');
    expect(requiredScopeFor('GET', `/access-profiles/${PROFILE_ID}/assignments`)).toBe('principals:read');
    // What-if discloses another principal's authority; events carry actor
    // detail — both owner-plane, spelling-immune.
    expect(requiredScopeFor('GET', '/access-profiles/what-if')).toBe('root');
    expect(requiredScopeFor('GET', '/access-profiles/WHAT-IF/')).toBe('root');
    expect(requiredScopeFor('GET', `/access-profiles/${PROFILE_ID}/events`)).toBe('root');
    // SETGOV `D-5` (AZ-A5 clause 9b, accepted by `dda2cdcc` §1): the SELF
    // preview leaves the /principals family rule for `authenticated`, so an
    // Account whose role maps to [] can render the Settings shell at all. The
    // what-if preview above stays root - it discloses ANOTHER principal.
    expect(requiredScopeFor('GET', '/principals/me/effective-access')).toBe('authenticated');
    for (const held of ['principals:read', 'tasks:admin', 'services:admin']) {
      expect(scopesSatisfy([held], 'root')).toBe(false);
    }
  });
});

describe('rule validation (closed vocabularies, selector shapes)', () => {
  const T1 = '44444444-4444-4444-8444-444444444444';

  it('accepts the three selector forms with their shape rules', () => {
    const rules = validateRules([
      { resourceType: 'task', selectorForm: 'exact', selectorIds: [T1], verbs: ['read'] },
      { resourceType: 'report', selectorForm: 'all-of-type', verbs: ['read', 'write'] },
      { resourceType: 'project', selectorForm: 'all-except', selectorIds: [T1], verbs: ['read'] },
    ]);
    expect(rules).toHaveLength(3);
    expect(rules[1].selectorIds).toEqual([]);
  });

  it('refuses malformed rules with typed 422s', () => {
    const bad: Array<unknown> = [
      [],                                                                              // empty
      [{ resourceType: 'nope', selectorForm: 'exact', selectorIds: [T1], verbs: ['read'] }],
      [{ resourceType: 'task', selectorForm: 'some-of', selectorIds: [T1], verbs: ['read'] }],
      [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [], verbs: ['read'] }],   // exact needs ids
      [{ resourceType: 'task', selectorForm: 'all-of-type', selectorIds: [T1], verbs: ['read'] }], // no ids allowed
      [{ resourceType: 'task', selectorForm: 'all-except', verbs: ['read'] }],         // needs exclusions
      [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [T1], verbs: [] }],
      [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [T1], verbs: ['fly'] }],
      [{ resourceType: 'task', selectorForm: 'exact', selectorIds: ['nope'], verbs: ['read'] }],
      [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [T1], verbs: ['read'], extra: 1 }],
    ];
    for (const rules of bad) {
      expect(() => validateRules(rules)).toThrow(AccessProfileError);
    }
  });
});

describe('the /access-profiles route surface (production router, pool mocked)', () => {
  it('creates a profile and writes the provenance event + audit act', async () => {
    db.script.push((text) => /INSERT INTO access_profiles/.test(text) ? { rows: [profileRow()] } : null);
    const { status, json } = await call('POST', '/access-profiles', { name: 'reader' });
    expect(status).toBe(201);
    expect(json.profile.id).toBe(PROFILE_ID);
    expect(db.queries.some((q) => /INSERT INTO access_profile_events/.test(q.text)
      && q.params?.[2] === 'profile.created')).toBe(true);
    expect((auditService.record as jest.Mock).mock.calls[0][0]).toMatchObject({ action: 'profile.create' });
  });

  it('refuses assigning an UNPUBLISHED profile (T35)', async () => {
    db.script.push((text) => /FROM access_profiles ap\s+WHERE ap.id/.test(text) ? { rows: [profileRow()] } : null);
    const { status, json } = await call('POST', `/access-profiles/${PROFILE_ID}/assignments`,
      { assigneeType: 'principal', assigneeId: ASSIGNEE_ID });
    expect(status).toBe(409);
    expect(json.code).toBe('PROFILE_UNPUBLISHED');
    expect(db.queries.some((q) => /INSERT INTO access_profile_assignments/.test(q.text))).toBe(false);
  });

  it('accepts Connector/Agent assignees since AZ-S3 (the §5 caps intersect live) and keeps disabled/malformed refusals', async () => {
    db.script.push((text) => /FROM access_profiles ap\s+WHERE ap.id/.test(text)
      ? { rows: [profileRow({ published_version_id: VERSION_ID, published_version_number: 1 })] } : null);
    // Delegated identities ARE assignable now (review 94aad5aa B1): their
    // effective authority stays own ∩ parent, so assignment cannot escalate.
    const accepted: any[] = [
      { id: ASSIGNEE_ID, kind: 'service', status: 'active', parent_principal_id: PROFILE_ID, legacy_identity: false },
      { id: ASSIGNEE_ID, kind: 'agent', status: 'active', parent_principal_id: PROFILE_ID, legacy_identity: false },
    ];
    for (const row of accepted) {
      db.script.length = 1;
      db.script.push((text) => /FROM principals WHERE id/.test(text) ? { rows: [row] } : null);
      db.script.push((text) => /INSERT INTO access_profile_assignments/.test(text)
        ? { rows: [{ id: '77777777-7777-4777-8777-777777777777', profile_id: PROFILE_ID, assignee_type: 'principal', assignee_id: ASSIGNEE_ID, assigned_by_principal_id: null, created_at: 'now' }] } : null);
      const { status } = await call('POST', `/access-profiles/${PROFILE_ID}/assignments`,
        { assigneeType: 'principal', assigneeId: ASSIGNEE_ID });
      expect(status).toBe(201);
    }
    const refused: Array<[any, string]> = [
      [{ id: ASSIGNEE_ID, kind: 'agent', status: 'active', parent_principal_id: null, legacy_identity: false }, 'ASSIGNEE_NOT_ACCOUNT'],
      [{ id: ASSIGNEE_ID, kind: 'service', status: 'disabled', parent_principal_id: null, legacy_identity: false }, 'ASSIGNEE_DISABLED'],
    ];
    for (const [row, code] of refused) {
      db.script.length = 1;
      db.script.push((text) => /FROM principals WHERE id/.test(text) ? { rows: [row] } : null);
      const { status, json } = await call('POST', `/access-profiles/${PROFILE_ID}/assignments`,
        { assigneeType: 'principal', assigneeId: ASSIGNEE_ID });
      expect(status).toBe(422);
      expect(json.code).toBe(code);
    }
  });

  it('refuses a group assignee that resolves to no group', async () => {
    db.script.push((text) => /FROM access_profiles ap\s+WHERE ap.id/.test(text)
      ? { rows: [profileRow({ published_version_id: VERSION_ID })] } : null);
    db.script.push((text) => /SELECT id FROM groups WHERE id/.test(text) ? { rows: [] } : null);
    const { status, json } = await call('POST', `/access-profiles/${PROFILE_ID}/assignments`,
      { assigneeType: 'group', assigneeId: ASSIGNEE_ID });
    expect(status).toBe(422);
    expect(json.code).toBe('ASSIGNEE_NOT_FOUND');
  });

  it('publish refuses re-pointing to an older or equal version (rollback is republish)', async () => {
    db.script.push((text) => /FROM access_profiles WHERE id = \$1 FOR UPDATE/.test(text)
      ? { rows: [{ id: PROFILE_ID, published_version_id: VERSION_ID }] } : null);
    db.script.push((text, params) => /FROM access_profile_versions WHERE id/.test(text)
      ? { rows: [params?.[0] === VERSION_ID
          ? { id: VERSION_ID, profile_id: PROFILE_ID, version_number: 2 }
          : { id: params?.[0], profile_id: PROFILE_ID, version_number: 1 }] }
      : null);
    const oldVersion = '55555555-5555-4555-8555-555555555555';
    const { status, json } = await call('POST', `/access-profiles/${PROFILE_ID}/publish`, { versionId: oldVersion });
    expect(status).toBe(409);
    expect(json.code).toBe('ROLLBACK_IS_REPUBLISH');
    expect(db.queries.some((q) => /UPDATE access_profiles SET published_version_id/.test(q.text))).toBe(false);
  });

  it('refuses deleting a profile with versions (immutable history) or assignments', async () => {
    db.script.push((text) => /COUNT\(\*\)::int AS n FROM access_profile_versions/.test(text) ? { rows: [{ n: 2 }] } : null);
    const { status, json } = await call('DELETE', `/access-profiles/${PROFILE_ID}`);
    expect(status).toBe(409);
    expect(json.code).toBe('PROFILE_HAS_VERSIONS');
  });

  it('refuses unknown body fields', async () => {
    const { status, json } = await call('POST', '/access-profiles', { name: 'x', extra: 1 });
    expect(status).toBe(400);
    expect(json.code).toBe('UNKNOWN_FIELD');
  });
});

describe('the profile seam (point/list parity is structural)', () => {
  it('activeProfileCondition joins through published_version_id with all four selector forms and the active-member group join', () => {
    const seam = accessProfileService.activeProfileCondition(7);
    expect(seam.sql).toContain('ap.published_version_id IS NOT NULL');
    expect(seam.sql).toContain('apr.version_id = ap.published_version_id');
    expect(seam.sql).toContain("apa.assignee_type = 'principal' AND apa.assignee_id = $7");
    expect(seam.sql).toContain("apa.assignee_type = 'group'");
    expect(seam.sql).toContain('FROM group_members gm');
    expect(seam.sql).toContain("mp.status = 'active'");
    expect(seam.sql).toContain("apr.selector_form = 'all-of-type'");
    expect(seam.sql).toContain("apr.selector_form = 'exact' AND <RESOURCE_ID_COLUMN> = ANY(apr.selector_ids)");
    expect(seam.sql).toContain("apr.selector_form = 'all-except'");
    // The FOURTH form (RH-AZ.PROJ-b, card 95572530) is deferred to the
    // substituter rather than emitted here, because the seam cannot know the
    // project coordinate of the shape it will be composed against. Its own
    // assertions live in `projectBoundedSelectorForm.test.ts`; what belongs
    // HERE is that the seam still carries it at all.
    expect(seam.sql).toContain('<PROJECT_BOUNDED_ARM>');
    expect(seam.sql).toContain('$9 = ANY(apr.verbs)');
    expect(seam.bind(ASSIGNEE_ID, 'task', 'read')).toEqual([ASSIGNEE_ID, 'task', 'read']);
  });

  it('EVALUATOR HALF: the two future-inclusive forms are withheld from `surface` (AZ-A5 clause 3, annex D3(b))', () => {
    const seam = accessProfileService.activeProfileCondition(7);
    // `exact` is honoured for every type including `surface`; `all-of-type` and
    // `all-except` are honoured for the eight ratified types and IGNORED for
    // `surface`, so a rule of either form inserted directly in SQL - bypassing
    // `validateRules` - changes no decision. The write refusal and this are
    // independent halves of one closure (D3 a and b).
    expect(seam.sql).toContain("apr.selector_form = 'all-of-type' AND apr.resource_type <> 'surface'");
    expect(seam.sql).toContain("apr.selector_form = 'all-except' AND apr.resource_type <> 'surface'");
    expect(seam.sql).toContain("apr.selector_form = 'exact' AND <RESOURCE_ID_COLUMN> = ANY(apr.selector_ids)");
  });

  it('THE AUTHORITY-MUTATION CLOSURE: a `surface` rule naming #15/#17/#18 is refused and audited (ruling 70af4d82 §1.1)', async () => {
    // §3.4 makes an Access bundle's profile pair the PROJECTION of its
    // membership onto its governable members, so a matrix write that would add
    // #15 to a bundle lands HERE as an `exact` `surface` rule. Refusing the
    // projection refuses the membership whichever route writes it - candidate
    // B's `/access-bundles` included. Annex D21 clause (ii), D9's family.
    const withheld = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const allowed = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const catalogue = {
      query: async () => ({
        rows: [
          { id: withheld, key: 'settings.access-grants', governance: 'governable' },
          { id: allowed, key: 'settings.webhooks', governance: 'governable' },
        ],
      }),
    };
    const actor = { principalId: 'root-id', handle: 'root', authMethod: 'dashboard_jwt' as const };
    const rule = (id: string) => ([{ resourceType: 'surface' as const, selectorForm: 'exact' as const, selectorIds: [id], verbs: ['read' as const, 'write' as const] }]);

    await expect(assertGovernableSurfaceSelectors(rule(withheld), catalogue, actor))
      .rejects.toThrow(/settings\.access-grants[\s\S]*3e76cfcc/);
    // POSITIVE CONTROL, same catalogue, same call: a governable surface that is
    // NOT one of the three passes, so this is not a validator that refuses
    // every `surface` rule.
    await expect(assertGovernableSurfaceSelectors(rule(allowed), catalogue, actor)).resolves.toBeUndefined();

    const denial = (auditService.record as jest.Mock).mock.calls
      .map(([write]) => write)
      .find((write: any) => write.action === 'access_bundle.refused');
    expect(denial).toBeDefined();
    expect(denial.outcome).toBe('denied');
    expect(denial.metadata).toMatchObject({
      surfaceKey: 'settings.access-grants', act: 'profile.version.create', arm: '3e76cfcc',
    });
  });

  it('sqlCondition (the ONE adapter behind point AND list) composes the profile arm after the grant arm', () => {
    const decision = authorizationService.sqlCondition(
      { principalId: ASSIGNEE_ID, handle: 'svc', role: 'agent', scopes: ['tasks:read'], authenticated: true },
      'read',
      { type: 'task', id: 't.id', owner: 't.owner_principal_id', visibility: 't.visibility' },
    );
    expect(decision.sql).toContain('FROM access_profile_assignments apa');
    expect(decision.sql).toContain('ap.published_version_id IS NOT NULL');
    const grantArm = decision.sql.indexOf('FROM grants g');
    const profileArm = decision.sql.indexOf('FROM access_profile_assignments');
    const visibilityArm = decision.sql.indexOf("IN ('public', 'shared', 'default')");
    expect(grantArm).toBeGreaterThan(-1);
    expect(profileArm).toBeGreaterThan(grantArm);
    expect(visibilityArm).toBeGreaterThan(profileArm);
  });
});

describe('migration 095 static pins', () => {
  const sql = readFileSync(join(__dirname, '../migrations/095_access_profiles.sql'), 'utf8');
  const baseline = readFileSync(join(__dirname, '../../../database/init.sql'), 'utf8');

  it('carries immutability, append-only and published-pairing triggers plus the selector shape CHECK', () => {
    expect(sql).toContain('reject_access_profile_version_mutation');
    expect(sql).toContain('reject_access_profile_event_mutation');
    expect(sql).toContain('enforce_published_version_pairing');
    expect(sql).toContain('access_profile_rules_selector_shape');
    expect(sql).toContain("selector_form IN ('exact', 'all-of-type', 'all-except')");
    expect(sql).toContain('published_version_id');
  });

  it('leaves the baseline untouched (fresh-replay doctrine)', () => {
    expect(baseline).not.toContain('095_access_profiles.sql');
    expect(baseline).not.toContain('access_profiles');
  });
});
