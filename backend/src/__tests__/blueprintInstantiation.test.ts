jest.mock('../utils/executionProfile', () => ({ validateConnectorProfile: jest.fn(async value => value) }));
jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../services/AuthorizationService', () => ({ authorizationService: { authorizeRoute: jest.fn(() => ({ allowed: true })) } }));
jest.mock('../services/AuthorizationRepository', () => ({ authorizationRepository: { listScope: jest.fn(() => ({ from: 'projects p', render: () => ({ sql: 'TRUE', params: [] }) })), authorizedIds: jest.fn(async () => new Set(['project'])) } }));
jest.mock('../services/ProjectService', () => ({ projectService: { create: jest.fn(async () => ({ id: 'project' })) } }));
jest.mock('../services/PhaseService', () => ({ phaseService: { create: jest.fn() } }));
jest.mock('../services/TaskManagerDB', () => ({ taskManagerDB: { createTask: jest.fn(), addDependency: jest.fn(), assignTaskRoles: jest.fn() } }));
jest.mock('../services/TaskElementService', () => ({ taskElementService: { createReference: jest.fn() } }));
jest.mock('../services/ReportManager', () => ({ reportManager: { create: jest.fn() } }));
jest.mock('../services/BlueprintProvenanceService', () => ({ blueprintProvenanceService: { stamp: jest.fn() } }));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));
import { pool } from '../db/connection';
import { projectService } from '../services/ProjectService';
import { BlueprintInstantiationService, BlueprintCreationCaller } from '../services/BlueprintInstantiationService';
import { BlueprintRegistryService } from '../services/BlueprintRegistryService';
import { blueprintRequestHash } from '../services/BlueprintPlanService';
import { BLUEPRINT_SCHEMA } from '../utils/blueprintDocument';
const principalId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const identity = { principalId, handle: 'caller', role: 'user', scopes: ['blueprints:use','projects:write'], authenticated: true };
const caller: BlueprintCreationCaller = { actor: identity, audit: { principalId, handle: 'caller', authMethod: 'session' }, rootSession: false,
  taskActor: { principalId, handle: 'caller', authMethod: 'session', authorization: identity } };
const key = 'one-stable-retry-key';
function fixture(options: { replay?: boolean; archived?: boolean; hidden?: boolean; retired?: boolean; noWriteAuthority?: boolean; changed?: boolean } = {}) {
  const doc = { schemaVersion: BLUEPRINT_SCHEMA, blueprint: { key: 'minimal-project', name: 'Minimal', version: 1, summary: '', description: '', tags: [], provenance: 'human-authored' },
    parameters: [{ key: 'name', label: 'Name', promptText: 'Which name?', type: 'string', required: false, default: 'Example' }],
    target: { mode: 'new-project', project: { name: '{{name}}' } }, phases: [], tasks: [], dependencies: [], references: [], humanGates: [], reports: [] };
  const snapshot = { status: 201, projectId: 'project', instantiationId: 'instance', blueprint: { key: 'minimal-project', version: 1 } };
  const request = { target: { mode: 'new-project' as const }, parameterValues: {} };
  const events: string[] = [];
  const client = { release: jest.fn(), query: jest.fn(async (sql: string, values?: any[]) => {
    events.push(sql);
    if (sql.includes('FROM blueprint_instantiation_requests')) return { rows: options.replay ? [{ blueprint_version_id: 'version-1', request_hash: options.changed ? 'different' : blueprintRequestHash('version-1', { mode: 'new-project' }, { name: 'Example' }), response_snapshot: snapshot }] : [] };
    if (sql.includes('FROM blueprint_versions')) return { rows: [{ id: values?.[0], version: 1, status: options.retired ? 'retired' : 'published', document: doc, content_sha256: 'a'.repeat(64), identity_sha256: 'b'.repeat(64) }] };
    if (sql.includes('FROM projects p')) return { rows: options.hidden ? [] : [{ id: 'project', status: options.archived ? 'archived' : 'active' }] };
    return { rows: [] };
  }) };
  (pool.connect as jest.Mock).mockResolvedValue(client);
  const registry = { bodyConfiguration: { limit: 102400 }, resolve: jest.fn(async () => { events.push('resolve blueprint'); return { id: 'blueprint', key: 'minimal-project', published_version_id: options.retired ? null : 'version-1' }; }) };
  const resolve = jest.fn(); const authorize = jest.fn(async () => !options.noWriteAuthority);
  const context = jest.fn(() => ({ target: { mode: 'new-project' as const }, resolve, authorize }));
  const service = new BlueprintInstantiationService(registry as unknown as BlueprintRegistryService, context);
  return { service, registry, client, request, snapshot, events, context, resolve, authorize };
}
describe('ordered Blueprint instantiation boundary', () => {
  beforeEach(() => jest.clearAllMocks());
  test.each([undefined, '', 'short', 'x'.repeat(129)])('invalid key refuses before connection acquisition', async key => {
    const f = fixture(); await expect(f.service.instantiate('minimal-project', f.request, key, caller)).rejects.toThrow('Idempotency-Key');
    expect(pool.connect).not.toHaveBeenCalled();
  });
  test('fresh success writes canonical Project, provenance, ledger and retry record in one commit', async () => {
    const f = fixture(); const result = await f.service.instantiate('minimal-project', f.request, key, caller);
    expect(result.projectId).toBe('project'); expect(result.status).toBe(201);
    expect(projectService.create).toHaveBeenCalledWith({ name: 'Example', description: undefined, goal: undefined }, expect.objectContaining({ principalId, audit: caller.audit }), expect.objectContaining({ client: f.client, actor: caller.taskActor }), expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(f.events.findIndex(e => e.includes('INSERT INTO blueprint_instantiations('))).toBeLessThan(f.events.findIndex(e => e.includes('INSERT INTO blueprint_instantiation_requests(')));
    expect(f.events.at(-1)).toBe('COMMIT'); expect(f.client.release).toHaveBeenCalledTimes(1);
  });
  test('retired committed replay returns original snapshot without re-deciding authority or invoking writers', async () => {
    const f = fixture({ replay: true, retired: true, noWriteAuthority: true });
    // A current body-limit reduction cannot invalidate a committed retry.
    f.registry.bodyConfiguration.limit = 4096;
    expect(await f.service.instantiate('minimal-project', f.request, key, caller)).toBe(f.snapshot);
    expect(f.context).not.toHaveBeenCalled(); expect(projectService.create).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe('COMMIT');
  });
  test.each([{ archived: true }, { hidden: true }])('new-project replay rechecks root concealment and archive: %j', async options => {
    const f = fixture({ replay: true, ...options });
    await expect(f.service.instantiate('minimal-project', f.request, key, caller)).rejects.toThrow(options.archived ? 'archived' : 'not found');
    expect(f.events.at(-1)).toBe('ROLLBACK'); expect(projectService.create).not.toHaveBeenCalled();
  });
  test('existing target archive is checked before Blueprint or retry resolution', async () => {
    const f = fixture({ archived: true, replay: true });
    await expect(f.service.instantiate('minimal-project', { target: { mode: 'existing-project', project: 'project' }, parameterValues: {} }, key, caller)).rejects.toThrow('archived');
    expect(f.registry.resolve).not.toHaveBeenCalled();
    expect(f.events.some(sql => sql.includes('blueprint_instantiation_requests'))).toBe(false);
  });
  test('changed key input refuses without touching created-root visibility or writers', async () => {
    const f = fixture({ replay: true, changed: true });
    await expect(f.service.instantiate('minimal-project', f.request, key, caller)).rejects.toThrow('different input');
    expect(f.events.some(sql => sql.includes('FROM projects'))).toBe(false); expect(projectService.create).not.toHaveBeenCalled();
  });
  test('missing whole-plan authority refuses before the first canonical create', async () => {
    const f = fixture({ noWriteAuthority: true });
    await expect(f.service.instantiate('minimal-project', f.request, key, caller)).rejects.toThrow('projects:write');
    expect(projectService.create).not.toHaveBeenCalled(); expect(f.events.some(sql => sql.startsWith('INSERT'))).toBe(false);
  });
  test('runtime credential rejection runs even on replay, before any snapshot returns', async () => {
    const f = fixture({ replay: true });
    await expect(f.service.instantiate('minimal-project', { ...f.request, parameterValues: { name: 'rh_live_abcdefghijklmnopqrstuvwxyz' } }, key, caller)).rejects.toThrow('Parameter value refused');
    expect(f.events.some(sql => sql.includes('FROM projects'))).toBe(false); expect(f.context).not.toHaveBeenCalled();
  });
});
