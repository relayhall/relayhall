import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

const { waitForPostgres, classify, BUDGET_MS, INTERVAL_MS, ATTEMPT_MS } = require('../../scripts/wait-for-postgres');
const yaml = require('js-yaml');

type Outcome = 'ok' | 'connect-hang' | 'query-hang' | 'cleanup-hang' | Error;
const never = () => new Promise(() => {});
function harness(outcomes: Outcome[] | ((index: number) => Outcome)) {
  const events: any[] = [];
  const clients: any[] = [];
  const newClient = jest.fn((options) => {
    const index = clients.length;
    const outcome = typeof outcomes === 'function' ? outcomes(index) : outcomes[index] ?? 'ok';
    const client = Object.assign(new EventEmitter(), {
      options,
      connect: jest.fn(async () => {
        if (outcome === 'connect-hang') return never();
        if (outcome instanceof Error) throw outcome;
        return undefined;
      }),
      query: jest.fn(async () => outcome === 'query-hang' ? never() : { rows: [{ '?column?': 1 }] }),
      end: jest.fn(async () => outcome === 'cleanup-hang' ? never() : undefined),
      connection: { stream: { destroy: jest.fn() } },
    });
    clients.push(client);
    return client;
  });
  const run = () => waitForPostgres({ newClient, now: () => Date.now(), log: (event: any) => events.push(event) });
  return { run, events, clients, newClient };
}
const failure = (code: string) => Object.assign(new Error('password=SECRET postgresql://user:SECRET@private/db'), { code });

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); });
afterEach(() => { jest.useRealTimers(); });

it('requires a second successful SELECT separated by two seconds', async () => {
  const h = harness(['ok', 'ok']); const p = h.run();
  await jest.advanceTimersByTimeAsync(INTERVAL_MS - 1);
  expect(h.clients).toHaveLength(1);
  expect(h.events.some(e => e.event === 'postgres-ready')).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await expect(p).resolves.toBe(true);
  expect(h.clients).toHaveLength(2);
  for (const c of h.clients) { expect(c.query).toHaveBeenCalledWith('SELECT 1'); expect(c.end).toHaveBeenCalledTimes(1); }
  expect(jest.getTimerCount()).toBe(0);
});
it('resets the streak after an intervening failure', async () => {
  const h = harness(['ok', failure('57P03'), 'ok', 'ok']); const p = h.run();
  await jest.advanceTimersByTimeAsync(3 * INTERVAL_MS);
  await expect(p).resolves.toBe(true);
  expect(h.events.filter(e => e.event === 'postgres-readiness-probe').map(e => e.consecutive)).toEqual([1, 0, 1, 2]);
});
it('admits observed slow first boot beyond the former 90-second budget', async () => {
  const h = harness(() => Date.now() < 114_000 ? failure('ECONNREFUSED') : 'ok'); const p = h.run();
  await jest.advanceTimersByTimeAsync(116_000);
  await expect(p).resolves.toBe(true);
  expect(h.events.at(-1)).toMatchObject({ event: 'postgres-ready', elapsedMs: 116_000 });
});
it.each([
  ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['ECONNREFUSED', 'network'],
  ['ECONNRESET', 'network'], ['ETIMEDOUT', 'network'], ['EHOSTUNREACH', 'network'],
  ['ENETUNREACH', 'network'], ['28P01', 'authentication'], ['28000', 'authentication'],
  ['3D000', 'database'], ['57P03', 'startup'], ['53300', 'capacity'],
])('reports only the safe code/category for %s', async (code, category) => {
  const h = harness([failure(code), 'ok', 'ok']); const p = h.run();
  await jest.advanceTimersByTimeAsync(2 * INTERVAL_MS); await expect(p).resolves.toBe(true);
  expect(h.events[0]).toMatchObject({ category, code, phase: 'connect' });
  expect(JSON.stringify(h.events)).not.toMatch(/SECRET|password|postgresql:|private/);
});
it('drops unknown hostile error fields and prototype names', () => {
  for (const code of ['SECRET', '__proto__', 'constructor', 'toString']) {
    expect(classify(Object.assign(failure(code), { detail: 'SECRET', stack: 'SECRET' }))).toEqual({ category: 'other', code: 'UNKNOWN' });
  }
});
it.each(['connect-hang', 'query-hang', 'cleanup-hang'] as Outcome[])('bounds %s and still fails closed at the wall deadline', async (outcome) => {
  const h = harness(() => outcome); const p = h.run();
  await jest.advanceTimersByTimeAsync(BUDGET_MS);
  await expect(p).resolves.toBe(false);
  expect(h.events.at(-1)).toMatchObject({ event: 'postgres-readiness-failed', elapsedMs: BUDGET_MS, budgetMs: BUDGET_MS });
  expect(h.events.some(e => e.category === 'timeout')).toBe(true);
  expect(h.events.some(e => e.event === 'postgres-ready')).toBe(false);
  expect(h.clients.some(c => c.connection.stream.destroy.mock.calls.length > 0)).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});
it.each(['connect-hang', 'query-hang'] as Outcome[])('destroys the first %s attempt even when end resolves before the total deadline', async (outcome) => {
  const h = harness([outcome, 'ok', 'ok']); const p = h.run();
  await jest.advanceTimersByTimeAsync(ATTEMPT_MS);
  const firstAttemptDestroyCalls = h.clients[0].connection.stream.destroy.mock.calls.length;
  await jest.advanceTimersByTimeAsync(2 * INTERVAL_MS);
  await expect(p).resolves.toBe(true);
  expect(firstAttemptDestroyCalls).toBe(1);
  expect(h.clients[0].end).toHaveBeenCalledTimes(1);
  expect(Date.now()).toBeLessThan(BUDGET_MS);
});
it('bounds late failure and prevents a lone success at the deadline from passing', async () => {
  const h = harness(() => Date.now() < BUDGET_MS - INTERVAL_MS ? failure('ECONNREFUSED') : 'ok'); const p = h.run();
  await jest.advanceTimersByTimeAsync(BUDGET_MS);
  await expect(p).resolves.toBe(false);
  expect(h.events.some(e => e.consecutive === 1)).toBe(true);
  expect(h.events.some(e => e.event === 'postgres-ready')).toBe(false);
});
it('sets driver bounds and safely captures an asynchronous client error', async () => {
  const h = harness(['query-hang', 'ok', 'ok']); const p = h.run();
  await jest.advanceTimersByTimeAsync(1);
  h.clients[0].emit('error', failure('ECONNRESET'));
  await jest.advanceTimersByTimeAsync(ATTEMPT_MS + 2 * INTERVAL_MS);
  await expect(p).resolves.toBe(true);
  expect(h.clients[0].options).toEqual({ connectionTimeoutMillis: ATTEMPT_MS, query_timeout: ATTEMPT_MS });
  expect(JSON.stringify(h.events)).not.toContain('SECRET');
});

const root = path.resolve(__dirname, '../../..');
const fullSources = ['.gitea/workflows/ci-full.yml', '.github/workflows/ci-full.yml'].map(p => fs.readFileSync(path.join(root, p), 'utf8'));
const full = () => yaml.load(fullSources[0]);
const ownedName = 'completion_reference_lifecycle';
const ownedPreparation = 'node scripts/wait-for-postgres.js && node scripts/load-base-schema.js && npx ts-node --transpile-only src/db/migrate.ts';
const { assertCompletionReferenceEndpoint } = require('../../scripts/completion-reference-endpoint');
function assertFullReadiness(workflow: any): void {
  // Card 1a38270d adds authority_edit_controls (the AZ-A13 live suite and its
  // mutation drill, about 45 minutes, in a job of its own so it lengthens no
  // other job's budget). It is an ordinary job: the wait-before-schema rules
  // below hold for it as for the others. Machinery queue 9b761f09 adds
  // drill_controls (the drills that ran in no tier) after mutation_controls,
  // an ordinary job under the same rules, and board_drill_controls after it
  // (the two drills that bring their own databases, moved out so neither job
  // comes near its budget), ordinary too.
  expect(Object.keys(workflow.jobs)).toEqual([
    'carriage_controls', 'mutation_controls', 'drill_controls', 'board_drill_controls', 'authority_edit_controls', 'blueprint_controls',
    'assignment_coupling_controls', 'live_gates', 'feata_drills', 'scale_load', ownedName,
  ]);
  function unconditional(value: any): void {
    if (!value || typeof value !== 'object') return;
    expect(value.if).toBeUndefined();
    expect(value['continue-on-error'] ?? value.continueOnError).toBeUndefined();
    for (const child of Object.values(value)) unconditional(child);
  }
  unconditional(workflow.jobs);
  for (const [name, job] of Object.entries(workflow.jobs) as [string, any][]) {
    expect(job.defaults.run['working-directory']).toBe('backend');
    expect(job.services.postgres.image).toBe('postgres:16');
    if (name === ownedName) {
      // This is an inline owned preparation chain, NOT a direct-helper step
      // and NOT the later Jest entry wrapper. Exact && order fails closed:
      // readiness failure cannot reach schema or migration.
      expect(job.container).toBe('node:22.23.4-bookworm@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384');
      expect(job['timeout-minutes']).toBe(10);
      const prepare = job.steps.filter((step: any) => step.run === ownedPreparation);
      expect(prepare).toHaveLength(1);
      const schemaSteps = job.steps.filter((step: any) => step.run?.includes('load-base-schema'));
      expect(schemaSteps).toEqual(prepare);
      const runIndex = job.steps.findIndex((step: any) => step.run === 'npm run test:completion-reference-lifecycle');
      expect(runIndex).toBeGreaterThan(job.steps.indexOf(prepare[0]));
      const env = job.env;
      expect(() => assertCompletionReferenceEndpoint(env)).not.toThrow();
      expect(env.CI).toBe('true');
      expect(env.PGHOST).toBe('postgres');
      expect(env.PGPORT).toBe('5432');
      expect(env.PGUSER).toBe('fixture');
      expect(env.PGDATABASE).toBe('mixed_cleanup_test_lifecycle');
      expect(job.services.postgres.env).toEqual({POSTGRES_USER: env.PGUSER, POSTGRES_PASSWORD: env.PGPASSWORD, POSTGRES_DB: env.PGDATABASE});
      const entry = fs.readFileSync(path.join(root, 'backend/scripts/completion-reference-entry.js'), 'utf8');
      const guardIndex = entry.indexOf("require('./completion-reference-endpoint').assertCompletionReferenceEndpoint(process.env)");
      expect(guardIndex).toBeGreaterThan(-1);
      expect(guardIndex).toBeLessThan(entry.indexOf('const p=spawnSync('));
      const config = fs.readFileSync(path.join(root, 'backend/jest.completion-reference.config.js'), 'utf8');
      expect(config.indexOf('assertCompletionReferenceEndpoint(process.env)')).toBeLessThan(config.indexOf("require('./jest.config')"));
    } else {
      const waits = job.steps.filter((step: any) => step.run === 'node scripts/wait-for-postgres.js');
      expect(waits).toHaveLength(1);
      const schemaIndex = job.steps.findIndex((step: any) => step.run?.includes('load-base-schema'));
      expect(job.steps.indexOf(waits[0])).toBeLessThan(schemaIndex);
      expect(waits[0].env.PGHOST).toBe('postgres');
      expect(job.services.postgres.options).toContain('pg_isready -h 127.0.0.1 -U relayhall_ci -d relayhall_ci');
      expect(job.services.postgres.options).toContain('--health-start-period 120s');
      expect(job.services.postgres.options).toContain('--health-interval 10s --health-timeout 5s --health-retries 10');
    }
  }
}
it('both full workflows wait before schema in all eleven unconditional jobs', () => {
  expect(fullSources[0]).toBe(fullSources[1]);
  expect(fullSources[0]).not.toContain('for (let attempt = 1; attempt <= 45');
  assertFullReadiness(full());
});
it.each([
  ['omit readiness', (j: any) => { j.steps[2].run = ownedPreparation.replace('node scripts/wait-for-postgres.js && ', ''); }],
  ['schema before readiness', (j: any) => { j.steps[2].run = 'node scripts/load-base-schema.js && node scripts/wait-for-postgres.js'; }],
  ['semicolon continues on failure', (j: any) => { j.steps[2].run = ownedPreparation.replace(' && ', '; '); }],
  ['mask readiness failure', (j: any) => { j.steps[2].run = ownedPreparation.replace(' && ', ' || true; '); }],
  ['conditional job', (j: any) => { j.if = 'false'; }],
  ['conditional preparation', (j: any) => { j.steps[2].if = 'false'; }],
  ['continue on error', (j: any) => { j.steps[2]['continue-on-error'] = true; }],
  ['different storage endpoint', (j: any) => { j.env.DB_HOST = 'elsewhere'; }],
  ['missing owned marker', (j: any) => { delete j.env.RELAYHALL_OWNED_FIXTURE; }],
  ['different service database', (j: any) => { j.services.postgres.env.POSTGRES_DB = 'unrelated'; }],
  ['test before preparation', (j: any) => { [j.steps[2], j.steps[3]] = [j.steps[3], j.steps[2]]; }],
  ['extra schema before readiness', (j: any) => { j.steps.unshift({run: 'node scripts/load-base-schema.js'}); }],
] as [string, (job: any) => void][])('rejects owned workflow drift: %s', (_name, mutate) => {
  const workflow = full(); mutate(workflow.jobs[ownedName]);
  expect(() => assertFullReadiness(workflow)).toThrow();
});
it('enumerates rather than counting jobs and retains classic direct-helper order', () => {
  const omitted = full(); delete omitted.jobs[ownedName];
  expect(() => assertFullReadiness(omitted)).toThrow();
  const renamed = full(); renamed.jobs.unreviewed = renamed.jobs[ownedName]; delete renamed.jobs[ownedName];
  expect(() => assertFullReadiness(renamed)).toThrow();
  const reordered = full(); const steps = reordered.jobs.scale_load.steps;
  const wait = steps.findIndex((s: any) => s.run === 'node scripts/wait-for-postgres.js');
  const schema = steps.findIndex((s: any) => s.run?.includes('load-base-schema'));
  [steps[wait], steps[schema]] = [steps[schema], steps[wait]];
  expect(() => assertFullReadiness(reordered)).toThrow();
});
it('the pure owned endpoint guard rejects default/remote/foreign and mismatched fields without a connection', () => {
  const env = full().jobs[ownedName].env;
  for (const patch of [
    {CI: 'false'}, {PGPORT: '5433'}, {DB_NAME: 'relayhall_ci'},
    {RELAYHALL_TEST_DB_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/mixed_cleanup_test_lifecycle'},
    {RELAYHALL_TEST_DB_URL: 'postgresql://fixture:fixture@remote:5432/mixed_cleanup_test_lifecycle'},
    {RELAYHALL_TEST_DB_URL: 'postgresql://fixture:fixture@postgres:5432/production'},
  ]) expect(() => assertCompletionReferenceEndpoint({...env, ...patch})).toThrow();
  expect(() => assertCompletionReferenceEndpoint({...env, DATABASE_URL: 'ignored'})).not.toThrow();
});
