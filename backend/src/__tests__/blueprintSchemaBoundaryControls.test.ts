/** Actual Express import/parser and Registry validation; authority/persistence
 * are mocked. This does not claim PostgreSQL or live authorization evidence. */
import express from 'express';
import { BLUEPRINT_SCHEMA, type BlueprintDocument } from '../utils/blueprintDocument';
import { jsonBodyOptions } from '../utils/jsonBodyTypes';
import { pool } from '../db/connection';
import router from '../routes/blueprints';

jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../services/AuthorizationRepository', () => ({ authorizationRepository: {} }));
jest.mock('../services/AuthorizationService', () => ({ authorizationService: { authorizeRoute: () => ({ allowed: true }) } }));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn(async () => undefined) } }));
jest.mock('../services/BlueprintResolutionService', () => ({ BlueprintResolutionService: jest.fn() }));
jest.mock('../services/BlueprintInstantiationService', () => ({ BlueprintInstantiationService: jest.fn() }));
jest.mock('../services/BlueprintLedgerService', () => ({ BlueprintLedgerService: jest.fn() }));
jest.mock('../middleware/sharedAuthorization', () => ({ actorFromRequest: () => ({ principalId: 'schema-author', scopes: ['root'] }) }));
jest.mock('../utils/auditActor', () => ({ auditActorFromRequest: () => ({ source: 'test' }) }));
jest.mock('../utils/administratorSession', () => ({ isLoginSessionKind: () => true }));
jest.mock('../utils/secretSafeLog', () => ({ logCaughtFailure: jest.fn(() => 'schema-test-error') }));
jest.mock('../routes/plugins', () => ({ getPluginRegistry: jest.fn() }));
jest.mock('../routes/tasks', () => ({ requestActor: jest.fn() }));

function fixture(): BlueprintDocument {
  return { schemaVersion: BLUEPRINT_SCHEMA,
    blueprint: { key: 'schema-boundary', name: 'Schema boundary', version: 1, summary: '', description: '', tags: [], provenance: 'human-authored' },
    parameters: [{ key: 'answer', label: 'Answer', promptText: 'Which analysis?', type: 'string', required: true }],
    references: [{ kind: 'skill', name: 'incident-analysis', requirement: 'required' }],
    target: { mode: 'new-project', project: { name: 'Project {{answer}}' } },
    tasks: [{ key: 'first', title: 'Task {{answer}}' }], phases: [], humanGates: [], reports: [], dependencies: [] };
}
beforeEach(() => {
  jest.clearAllMocks();
  (pool.connect as jest.Mock).mockResolvedValue({ release: jest.fn(), query: jest.fn(async (sql: string, values: unknown[]) => {
    if (sql.startsWith('INSERT INTO blueprints(')) return { rows: [{ id: 'schema-parent', key: values[0] }] };
    if (sql.startsWith('SELECT COALESCE(MAX(version),0)+1')) return { rows: [{ version: 1 }] };
    if (sql.startsWith('INSERT INTO blueprint_versions(') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    throw new Error('Unexpected persistence call in schema boundary fixture');
  }) });
});

async function importDocument(document: BlueprintDocument) {
  const app = express(); app.use(express.json(jsonBodyOptions)); app.use('/blueprints', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback test server');
    const response = await fetch(`http://127.0.0.1:${address.port}/blueprints/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document }),
    });
    return { status: response.status, body: await response.json() as any };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('Blueprint named schema import controls', () => {
  test('positive ordinary document reaches the real import success boundary', async () => {
    expect(await importDocument(fixture())).toMatchObject({ status: 201, body: { success: true, blueprint: { key: 'schema-boundary', version: 1, status: 'draft' } } });
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });
  test.each(['grants', 'principals', 'credentials', 'groups', 'warrants', 'accessProfiles', 'charter', 'skills', 'personalities', 'services', 'plugins', 'blueprints'])('D5 actual import refuses forbidden creation kind %s', async key => {
    const document = fixture(); document[key] = [];
    expect(await importDocument(document)).toEqual({ status: 422, body: { success: false, code: 'BLUEPRINT_DOCUMENT_REFUSED', error: 'Unknown field', field: 'document.' + key } });
    expect(pool.connect).not.toHaveBeenCalled();
  });
  test('D3 actual import refuses substitution into a reference name', async () => {
    const document = fixture(); document.references[0].name = '{{answer}}';
    expect(await importDocument(document)).toEqual({ status: 422, body: { success: false, code: 'BLUEPRINT_DOCUMENT_REFUSED', error: 'Substitution is not allowed in this field', field: 'references.0.name' } });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
