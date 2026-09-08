/** Package B: real document/registry/router code with persistence mocked.
 * Live row/transaction/authority proofs belong to the separate PG contracts. */
import express from 'express';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import * as documentCode from '../utils/blueprintDocument';
import { BlueprintRegistryService, BlueprintReader } from '../services/BlueprintRegistryService';
import { buildBlueprintPlan, BlueprintPlanContext } from '../services/BlueprintPlanService';
import { jsonBodyOptions } from '../utils/jsonBodyTypes';
import { pool } from '../db/connection';
import router, { blueprintRegistry } from '../routes/blueprints';

jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../services/AuthorizationRepository', () => ({ authorizationRepository: {} }));
jest.mock('../services/AuthorizationService', () => ({ authorizationService: { authorizeRoute: () => ({ allowed: true }) } }));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn(async () => undefined) } }));
jest.mock('../services/BlueprintResolutionService', () => ({ BlueprintResolutionService: jest.fn() }));
jest.mock('../services/BlueprintInstantiationService', () => ({ BlueprintInstantiationService: jest.fn() }));
jest.mock('../services/BlueprintLedgerService', () => ({ BlueprintLedgerService: jest.fn() }));
jest.mock('../middleware/sharedAuthorization', () => ({ actorFromRequest: () => ({ principalId: 'reviewer', scopes: ['root'] }) }));
jest.mock('../utils/auditActor', () => ({ auditActorFromRequest: () => ({ source: 'test' }) }));
jest.mock('../utils/administratorSession', () => ({ isLoginSessionKind: () => true }));
jest.mock('../utils/secretSafeLog', () => ({ logCaughtFailure: jest.fn(() => 'test-error') }));
jest.mock('../routes/plugins', () => ({ getPluginRegistry: jest.fn() }));
jest.mock('../routes/tasks', () => ({ requestActor: jest.fn() }));

const { BLUEPRINT_SCHEMA, BlueprintError, BINDING_SLOTS, PARAMETER_TYPES, blueprintDigests,
  stableBlueprintJson, validateBlueprintDocument, effectiveBlueprintCap } = documentCode;
const caller = { actor: { principalId: 'reviewer', scopes: ['root'] }, audit: {}, rootSession: true } as BlueprintReader;
const secret = 'rh_live_abcdefghijklmnopqrstuvwxyz';
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.signature';
const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const shippedLimits = { ...documentCode.blueprintLimits };
const expectedBindings = { 'tasks.roles.shepherd': 'principal-ref', 'tasks.roles.verifier': 'principal-ref', 'humanGates.decider': 'principal-ref', 'target.project': 'project-ref', 'tasks.phase': 'phase-ref', 'tasks.defaults.personality': 'personality-ref', 'tasks.defaults.executionProfile.service': 'service-ref' };
function fixture(): documentCode.BlueprintDocument {
  return { schemaVersion: BLUEPRINT_SCHEMA,
    blueprint: { key: 'boundary-document', name: 'Boundary document', version: 1, summary: '', description: '', tags: [], provenance: 'human-authored' },
    parameters: [{ key: 'answer', label: 'Answer', promptText: 'What happened?', type: 'string', required: true },
      { key: 'person', label: 'Person', promptText: 'Who reviews?', type: 'principal-ref', required: true }],
    references: [], target: { mode: 'new-project', project: { name: 'Project {{answer}}' } },
    phases: [], tasks: [{ key: 'first', title: 'Task {{answer}}', roles: { verifier: '{{person}}' } }],
    humanGates: [], reports: [], dependencies: [] };
}
function context(): BlueprintPlanContext {
  return { target: { mode: 'new-project' }, resolve: jest.fn(async (kind, name) => ({ kind, name, id: uuid })), authorize: jest.fn(async () => true) };
}
let stored: documentCode.BlueprintDocument;
let client: { query: jest.Mock; release: jest.Mock };
let registry: BlueprintRegistryService;
beforeEach(() => {
  stored = fixture(); registry = new BlueprintRegistryService(jsonBodyOptions);
  client = { release: jest.fn(), query: jest.fn(async (sql: string) => {
    if (sql.startsWith('INSERT INTO blueprints')) return { rows: [{ id: 'parent', key: stored.blueprint.key }] };
    if (sql.startsWith('SELECT COALESCE')) return { rows: [{ version: 1 }] };
    if (sql.startsWith('SELECT * FROM blueprint_versions')) return { rows: [{ id: 'version', document: stored, status: 'review', author_principal_id: 'author' }] };
    return { rows: [] };
  }) };
  (pool.connect as jest.Mock).mockResolvedValue(client);
  jest.spyOn(registry, 'resolve').mockResolvedValue({ id: 'parent', key: stored.blueprint.key });
  jest.spyOn(registry, 'get').mockImplementation(async () => ({ status: 'published', document: stored }));
});
afterEach(() => { jest.restoreAllMocks(); jsonBodyOptions.limit = 102400; Object.assign(documentCode.blueprintLimits, shippedLimits); });
async function boundary(point: string, d: documentCode.BlueprintDocument) {
  stored = d;
  if (point === 'save') return registry.save(caller, d);
  if (point === 'publish') return registry.transition('parent', 1, 'publish', caller);
  return registry.export('parent', 1, caller);
}
describe('Blueprint document checkpoints', () => {
  const secrets: Array<[string, (d: documentCode.BlueprintDocument) => void]> = [
    ['rh literal', d => { d.tasks[0].description = secret; }],
    ['JWT triple', d => { d.tasks[0].description = jwt; }],
    ['api_key default', d => { d.parameters[0].key = 'api_key'; d.parameters[0].default = 'ordinary'; }],
  ];
  for (const point of ['save', 'publish', 'export']) {
    test.each(secrets)(`D9 ${point} refuses %s`, async (_name, alter) => {
      const d = fixture(); alter(d);
      await expect(boundary(point, d)).rejects.toMatchObject({ status: 422, code: 'BLUEPRINT_DOCUMENT_REFUSED' });
    });
    test.each(['roles.verifier', 'reference.name', 'description'])(`D12 ${point} refuses UUID in %s`, async position => {
      const d = fixture();
      if (position === 'roles.verifier') d.tasks[0].roles.verifier = uuid;
      if (position === 'reference.name') d.references.push({ kind: 'skill', name: uuid, requirement: 'required' });
      if (position === 'description') d.tasks[0].description = uuid;
      await expect(boundary(point, d)).rejects.toMatchObject({ status: 422, code: 'BLUEPRINT_DOCUMENT_REFUSED' });
    });
    test(`positive ${point} reaches its success result`, async () => {
      const result = await boundary(point, fixture());
      if (point === 'export') expect(JSON.parse(result as string)).toEqual(fixture());
      else expect(result).toMatchObject({ id: 'parent', status: point === 'save' ? 'draft' : 'published' });
    });
  }
  test('D9 parameter type set is exact and contains no secret-bearing type', () => {
    expect([...PARAMETER_TYPES].sort()).toEqual(['string', 'text', 'integer', 'boolean', 'enum', 'date', 'principal-ref', 'project-ref', 'phase-ref', 'skill-ref', 'personality-ref', 'service-ref'].sort());
  });
  test.each(['password', 'format'])('D9 layered schema refuses %s independently of secret detection', name => {
    const d = fixture(); if (name === 'password') d.parameters[0].type = name; else d.parameters[0].format = 'ordinary';
    expect(() => validateBlueprintDocument(d, jsonBodyOptions)).toThrow(name === 'password' ? 'Unknown value' : 'Unknown field');
  });
  const shapes = { UUID: uuid, 'absolute URL': 'https://portal.example.invalid', hostname: 'portal.example.invalid', IPv4: '192.0.2.1', IPv6: '2001:db8::1', credential: secret };
  test('D12 executable forbidden shape set is exactly enumerated', () => {
    expect(Object.keys(documentCode.BLUEPRINT_FORBIDDEN_LITERAL_SHAPES).sort()).toEqual(['uuid', 'absoluteUrl', 'hostname', 'ipv4', 'ipv6'].sort());
  });
  test.each(Object.entries(shapes))('D12 shape set refuses %s', (_shape, value) => {
    const d = fixture(); d.tasks[0].description = value;
    expect(() => validateBlueprintDocument(d, jsonBodyOptions)).toThrow(BlueprintError);
  });
  test('D12 permits a portable key and declared capability name', () => {
    const d = fixture(); d.references.push({ kind: 'skill', name: 'incident-analysis', requirement: 'required' });
    expect(validateBlueprintDocument(d, jsonBodyOptions)).toEqual(d);
  });
  test('D12 rename changes only integrity; every other identity field remains significant', () => {
    const d = fixture(), base = blueprintDigests(d); const renamed = fixture(); renamed.blueprint.key = 'renamed-document';
    const third = fixture(); third.blueprint.key = 'third-document';
    expect(new Set([base.contentSha256, blueprintDigests(renamed).contentSha256, blueprintDigests(third).contentSha256]).size).toBe(3);
    expect(blueprintDigests(renamed).identitySha256).toBe(base.identitySha256);
    expect(blueprintDigests(third).identitySha256).toBe(base.identitySha256);
    for (const alter of [
      (v: documentCode.BlueprintDocument) => { v.tasks[0].title += '!'; },
      (v: documentCode.BlueprintDocument) => { v.blueprint.version = 2; },
      (v: documentCode.BlueprintDocument) => { v.blueprint.provenance = 'imported'; },
      (v: documentCode.BlueprintDocument) => { v.parameters[0].default = 'Default'; },
      (v: documentCode.BlueprintDocument) => { v.tasks.push({ key: 'second', title: 'Second' }); v.dependencies.push({ task: 'second', dependsOn: 'first' }); },
    ]) { const changed = fixture(); alter(changed); const digest = blueprintDigests(changed); expect(digest.identitySha256).not.toBe(base.identitySha256); expect(digest.contentSha256).not.toBe(base.contentSha256); }
  });
});

describe('Blueprint substitution territory', () => {
  test('D21 binding slots are exactly the ratified set', () => {
    expect(BINDING_SLOTS).toEqual(expectedBindings);
  });
  test.each(Object.entries(expectedBindings))('D21 declared slot %s accepts its matching type', (slot, type) => {
    const d = fixture(); d.parameters.push({ key: 'bound', label: 'Selection', promptText: 'Which one?', type, required: true });
    const binding = '{{bound}}';
    if (slot === 'target.project' || slot === 'tasks.phase') { d.target = { mode: 'existing-project', project: '{{project}}' }; d.parameters.push({ key: 'project', label: 'Project', promptText: 'Which project?', type: 'project-ref', required: true }); }
    if (slot === 'target.project') d.target.project = binding;
    else if (slot === 'humanGates.decider') d.humanGates.push({ key: 'gate', title: 'Gate', decisionPrompt: 'Proceed?', decider: binding, arms: [{ key: 'yes', label: 'Yes', tasks: ['first'] }] });
    else if (slot === 'tasks.phase') d.tasks[0].phase = binding;
    else if (slot === 'tasks.roles.shepherd') d.tasks[0].roles.shepherd = binding;
    else if (slot === 'tasks.roles.verifier') d.tasks[0].roles.verifier = binding;
    else if (slot === 'tasks.defaults.personality') d.tasks[0].defaults = { personality: binding };
    else d.tasks[0].defaults = { executionProfile: { service: binding, options: {} } };
    expect(validateBlueprintDocument(d, jsonBodyOptions)).toEqual(d);
  });
  test.each(['title', 'description', 'definitionOfDone', 'constraints', 'tags'])('D21 ref binding outside set refuses task %s', field => {
    const d = fixture(); d.tasks[0][field] = field === 'tags' ? ['{{person}}'] : '{{person}}';
    expect(() => validateBlueprintDocument(d, jsonBodyOptions)).toThrow('Substitution is not allowed');
  });
  test.each(['key', 'reference', 'undeclared', 'non-string option'])('D3 refuses forbidden substitution %s', async territory => {
    const d = fixture();
    if (territory === 'key') d.tasks[0].key = '{{answer}}';
    if (territory === 'reference') d.references.push({ kind: 'skill', name: '{{answer}}', requirement: 'required' });
    if (territory === 'undeclared') d.tasks[0].description = '{{unknown}}';
    if (territory === 'non-string option') {
      d.references.push({ kind: 'service', name: 'hermes', requirement: 'required' });
      d.tasks[0].defaults = { executionProfile: { service: 'hermes', options: { retryCount: '{{answer}}' } } };
      const ctx=context();ctx.resolve=jest.fn(async(kind,name)=>({kind,name,id:uuid,version:1,serviceKind:'connector',descriptor:{options:[{key:'retryCount',type:'number' as const}]}}));
      await expect(buildBlueprintPlan(d,{answer:'2',person:'reviewer'},jsonBodyOptions,ctx)).rejects.toThrow('Substitution requires a descriptor string option');
      return;
    }
    expect(() => validateBlueprintDocument(d, jsonBodyOptions)).toThrow(BlueprintError);
  });
  test('D21 text cannot bind a principal', () => {
    const d = fixture(); d.tasks[0].roles.verifier = '{{answer}}';
    expect(() => validateBlueprintDocument(d, jsonBodyOptions)).toThrow('Binding type mismatch');
  });
  test('D3 execution option named title respects its descriptor enum type', async () => {
    const d = fixture(); d.references.push({ kind: 'service', name: 'hermes', requirement: 'optional' });
    d.tasks[0].defaults = { executionProfile: { service: 'hermes', options: { title: '{{answer}}' } } };
    const ctx=context();ctx.resolve=jest.fn(async(kind,name)=>({kind,name,id:uuid,version:1,serviceKind:'connector',descriptor:{options:[{key:'title',type:'enum' as const,values:[{value:'Inspect'}]}]}}));
    await expect(buildBlueprintPlan(d,{answer:'Inspect',person:'reviewer'},jsonBodyOptions,ctx)).rejects.toThrow('Substitution requires a descriptor string option');
  });
  test('D3 literal execution-option boundary preserves literal string and number values', () => {
    const d = fixture(); d.references.push({ kind: 'service', name: 'hermes', requirement: 'optional' });
    d.tasks[0].defaults = { executionProfile: { service: 'hermes', options: { title: 'Literal title', command: 'inspect', retryCount: 2 } } };
    expect(validateBlueprintDocument(d, jsonBodyOptions)).toEqual(d);
  });
  test('D3 D21 one-pass plan text stays literal and resolved principal is absent from text fields', async () => {
    const plan = await buildBlueprintPlan(fixture(), { answer: '{{person}}', person: 'reviewer' }, jsonBodyOptions, context());
    expect(plan.tasks[0].title).toBe('Task {{person}}'); expect(plan.tasks[0].roles.verifierPrincipalId).toBe(uuid);
    const textRows = [plan.project, ...plan.phases, ...plan.tasks, ...plan.reports].map(row => Object.fromEntries(Object.entries(row || {}).filter(([key]) => ['title','name','description','summary','goal','definitionOfDone','constraints','content','tags','subtasks'].includes(key))));
    const contains = (rows: unknown) => JSON.stringify(rows).includes(uuid);
    expect(contains(textRows)).toBe(false); expect(contains([...textRows, { description: uuid }])).toBe(true);
  });
  test.each(['rh literal', 'JWT triple', 'PEM block'])('D22 runtime %s refuses with key-only diagnostics and no resolution', async kind => {
    const value = kind === 'rh literal' ? secret : kind === 'JWT triple' ? jwt : '-----BEGIN PRIVATE KEY-----';
    const ctx = context();
    await expect(buildBlueprintPlan(fixture(), { answer: value, person: 'reviewer' }, jsonBodyOptions, ctx)).rejects.toMatchObject({ status: 422, code: 'PARAMETER_VALUE_REFUSED', field: 'answer', message: 'Parameter value refused' });
    expect(ctx.resolve).not.toHaveBeenCalled(); expect(ctx.authorize).not.toHaveBeenCalled();
  });
  test('D22 recorded production order screens values before substitution and plan callbacks', async () => {
    const order: string[] = []; const actualSubstitute = documentCode.substituteBlueprint;
    // Observe the actual credential predicate at its regex boundary, rather
    // than marking entry into a wrapper that might no longer screen values.
    const nativeTest = RegExp.prototype.test; const probe = 'runtime-order-probe';
    jest.spyOn(RegExp.prototype, 'test').mockImplementation(function(this: RegExp, value: string) {
      if (value === probe && this.source.includes('PRIVATE KEY') && this.source.includes('AKIA')) order.push('screened');
      return nativeTest.call(this, value);
    });
    jest.spyOn(documentCode, 'substituteBlueprint').mockImplementation((...args) => { order.push('substitute'); return actualSubstitute(...args); });
    const ctx = context(); ctx.resolve = async (kind, name) => { order.push('resolve'); return { kind, name, id: uuid }; }; ctx.authorize = async () => { order.push('authorize'); return true; };
    await buildBlueprintPlan(fixture(), { answer: probe, person: 'reviewer' }, jsonBodyOptions, ctx);
    const screenedFirst = (events: string[]) => events.includes('screened') && ['substitute','resolve','authorize'].every(sink => events.includes(sink) && events.indexOf('screened') < events.indexOf(sink));
    expect(screenedFirst(order)).toBe(true);
    expect(screenedFirst(['substitute', 'screened', 'resolve', 'authorize'])).toBe(false);
  });
});

function sized(bytes: number) {
  const d = fixture(); d.tasks = Array.from({ length: bytes > 40000 ? 9 : 3 }, (_, i) => ({ key: `task-${i}`, title: 'Task', description: 'x'.repeat(7000) }));
  d.blueprint.description = 'x'.repeat(bytes - Buffer.byteLength(stableBlueprintJson(d)));
  expect(Buffer.byteLength(stableBlueprintJson(d))).toBe(bytes); return d;
}
function app() { const a = express(); a.use(express.json(jsonBodyOptions)); a.use('/blueprints', router); return a; }
async function importRequest(document: documentCode.BlueprintDocument) {
  const server = app().listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback server');
    const response = await fetch(`http://127.0.0.1:${address.port}/blueprints/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document }) });
    return { status: response.status, body: await response.json() as any };
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
describe('Blueprint actual import parser boundary', () => {
  test('D13 published-at-cap document is revalidated against tightened limits before plan callbacks', async () => {
    const d = fixture(); d.tasks = Array.from({ length: 100 }, (_, i) => ({ key: `task-${i}`, title: 'Task' }));
    await expect(boundary('publish', d)).resolves.toMatchObject({ status: 'published' });
    documentCode.blueprintLimits.tasks = 99;
    const ctx = context();
    await expect(buildBlueprintPlan(d, { answer: 'ordinary', person: 'reviewer' }, jsonBodyOptions, ctx)).rejects.toMatchObject({ status: 422, code: 'BLUEPRINT_DOCUMENT_REFUSED' });
    expect(ctx.resolve).not.toHaveBeenCalled(); expect(ctx.authorize).not.toHaveBeenCalled();
  });
  test.each([0, -1, 1.5, 101, Number.NaN])('D13 invalid task limit %s fails closed', value => {
    documentCode.blueprintLimits.tasks = value;
    expect(() => validateBlueprintDocument(fixture(), jsonBodyOptions)).toThrow('Invalid Blueprint limit configuration');
  });
  test.each([65536, 65537])('D18 canonical %i bytes reaches Blueprint import validation', async bytes => {
    stored = sized(bytes);
    const response = await importRequest(stored);
    if (bytes === 65536) expect(response.status).toBe(201);
    else { expect(response.status).toBe(422); expect(response.body.code).toBe('BLUEPRINT_DOCUMENT_TOO_LARGE'); }
  });
  test.each(['password','secret','token','api key','private key','credential','passphrase'])('D22 import refuses prompt requesting %s', async word => {
    const d = fixture(); d.parameters[0].promptText = 'Provide a ' + word;
    const response = await importRequest(d);
    expect(response.status).toBe(422); expect(response.body.code).toBe('BLUEPRINT_DOCUMENT_REFUSED');
  });
  test('D25 shared real server configuration is read live by the registry', () => {
    expect(blueprintRegistry.bodyConfiguration).toBe(jsonBodyOptions);
    expect(effectiveBlueprintCap(blueprintRegistry.bodyConfiguration)).toBe(65536);
    jsonBodyOptions.limit = 32768;
    expect(effectiveBlueprintCap(blueprintRegistry.bodyConfiguration)).toBe(28672);
  });
  test('D25 lower actual parser limit preserves named Blueprint byte refusal with envelope space', async () => {
    jsonBodyOptions.limit = 32768;
    stored = sized(28672); expect((await importRequest(stored)).status).toBe(201);
    stored.blueprint.description += 'x'; const response = await importRequest(stored);
    expect(response.status).toBe(422); expect(response.body.code).toBe('BLUEPRINT_DOCUMENT_TOO_LARGE');
  });
  test('D25 parser/registry source passes the imported shared object, with a duplicate-literal negative control', () => {
    function sharedArgument(source: string, constructor: boolean): boolean {
      const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
      let imported = false; const args: ts.Expression[] = [];
      function walk(node: ts.Node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /\/utils\/jsonBodyTypes$/.test(node.moduleSpecifier.text)) {
          const named = node.importClause?.namedBindings;
          imported ||= !!named && ts.isNamedImports(named) && named.elements.some(e => e.name.text === 'jsonBodyOptions' && (e.propertyName?.text ?? e.name.text) === 'jsonBodyOptions');
        }
        if (!constructor && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(ast) === 'express' && node.expression.name.text === 'json') args.push(node.arguments[0]);
        if (constructor && ts.isNewExpression(node) && node.expression.getText(ast) === 'BlueprintRegistryService') args.push(node.arguments?.[0]!);
        ts.forEachChild(node, walk);
      }
      walk(ast); return imported && args.length > 0 && args.every(a => a && ts.isIdentifier(a) && a.text === 'jsonBodyOptions');
    }
    for (const relative of ['server.ts', 'mcp/inProcess.ts', 'routes/blueprints.ts']) {
      const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
      expect(sharedArgument(source, relative.startsWith('routes'))).toBe(true);
    }
    const copied = "import { jsonBodyOptions } from '../utils/jsonBodyTypes'; app.use(express.json({ limit: 102400 }));";
    expect(sharedArgument(copied, false)).toBe(false);
  });
});
