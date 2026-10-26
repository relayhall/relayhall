/**
 * Card 19dd180c: a finish dry run answers what the real finish answers.
 *
 * `POST /tasks/{id}/finish` with `dryRun: true` used to return
 * `{valid: true, targetStatus: 'review'}` straight after the input-shape
 * checks, before the Task was read: an assigned Verifier, a principal holding
 * no Task role, a Task that was not In Progress, a Task with unfinished
 * Subtasks and a Report that could not be linked were all told "valid" while
 * the identical real call was refused. This suite measures the PAIR - the
 * dry run's outcome and the real call's outcome for the same actor and the
 * same state - over a REAL PostgreSQL and the PRODUCTION router, through REST
 * and through the MCP `relayhall_task_finish` tool, and that a dry run writes
 * nothing:
 *
 *   (A) every refusal the real finish makes is the dry run's refusal, with
 *       the same status and code, through both transports;
 *   (B) every finish the real call accepts is a valid dry run, and the dry
 *       run leaves the Task, its stream, its Reports, its References, the
 *       feed and the retry-key table exactly as they were;
 *   (C) the retry contract: after a real finish, a dry run is refused the way
 *       an exact retry is (TASK_NOT_FINISHABLE), and finish takes no
 *       idempotency key, so a dry run reserves none;
 *   (D) the MCP answer to a dry run says it is a dry run and never claims the
 *       Task was finished.
 *
 * DESTRUCTIVE: writes principals, credentials, services, projects, tasks,
 * subtasks, Reports and grants. It refuses any deployment database and any
 * non-local host, and FAILS - never skips - without a disposable one.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import http from 'http';
import crypto from 'crypto';

const TEST_DB_URL = process.env.RELAYHALL_TEST_DB_URL;
if (!TEST_DB_URL) {
  throw new Error('RELAYHALL_TEST_DB_URL is required: the finish dry-run parity drill measures stored task, stream '
    + 'and report rows, so it never skips. Load database/init.sql into a disposable database, run npm run migrate, '
    + 'and point RELAYHALL_TEST_DB_URL at it.');
}
const parsed = new URL(TEST_DB_URL);
const TEST_DB_NAME = decodeURIComponent(parsed.pathname.slice(1));
const localDisposable = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  && /test|contract|fixture/.test(TEST_DB_NAME);
const ciService = process.env.CI === 'true' && parsed.hostname === 'postgres' && TEST_DB_NAME === 'relayhall_ci';
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
  || ['relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod'].includes(TEST_DB_NAME)
  || (!localDisposable && !ciService)) {
  throw new Error('Finish dry-run parity drill refuses a non-disposable database target');
}

// The production pool reads DB_* at import time, so the environment is pinned
// BEFORE anything is required.
Object.assign(process.env, {
  DB_HOST: parsed.hostname, DB_PORT: parsed.port || '5432', DB_NAME: TEST_DB_NAME,
  DB_USER: decodeURIComponent(parsed.username), DB_PASSWORD: decodeURIComponent(parsed.password),
  NODE_ENV: 'test', RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

const express = require('express');
const { pool } = require('../db/connection');
const { registerProtectedRoutes } = require('../routeRegistry');
const { authMiddleware } = require('../middleware/auth');
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
const { apiErrorHandler } = require('../utils/apiErrors');
const { jsonBodyOptions } = require('../utils/jsonBodyTypes');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../services/LoginSessionService');
const inProcess = require('../mcp/inProcess');
const mcpRoutes = require('../mcp/httpRoute').default;
const { MCP_ROUTE_PATH } = require('../mcp/httpRoute');

jest.setTimeout(240_000);

// ──────────────────────────────── the app ────────────────────────────────────

let server: http.Server;
let origin: string;

function buildApp(): any {
  const app = express();
  app.use(express.json(jsonBodyOptions));
  app.use(express.urlencoded({ extended: true }));
  app.use(MCP_ROUTE_PATH, mcpRoutes);
  registerProtectedRoutes((mountPath: string, ...handlers: any[]) => {
    app.use(mountPath, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
  });
  app.use(apiErrorHandler);
  return app;
}

interface Dispatched { method: string; path: string; status: number; body: any }
const dispatched: Dispatched[] = [];
const realDispatch = inProcess.dispatchInProcess;

// ──────────────────────────────── callers ────────────────────────────────────

interface Caller { label: string; principalId: string; token: string; headers: Record<string, string> }
interface Answer { status: number; json: any }

async function call(who: { headers: Record<string, string> }, method: string, routePath: string, body?: unknown,
  extra: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(`${origin}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...who.headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

async function mcpCall(token: string, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const response = await fetch(`${origin}${MCP_ROUTE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}
const mcpText = (answer: Answer): string => String(answer.json?.result?.content?.[0]?.text ?? '');
const mcpFailed = (answer: Answer): boolean => Boolean(answer.json?.result?.isError) || Boolean(answer.json?.error);

const tag = (): string => crypto.randomBytes(5).toString('hex');
const hex64 = (): string => crypto.randomBytes(32).toString('hex');

// ─────────────────────────────── fixtures ────────────────────────────────────

const CONNECTOR_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'reports:read', 'reports:write'];

let OWNER: { principalId: string; headers: Record<string, string> };
let WORKER: Caller;    // the Connector whose finish is under test
let OTHER: Caller;     // a second Connector: a claimant that is not WORKER, or a grant holder with no Task role
let PROJECT: string;

async function makePerson(role: string, label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, status, role)
     VALUES ('human', $1, $1, 'active', $2) RETURNING id`,
    [`fdp-${label}-${tag()}`, role],
  );
  return String(result.rows[0].id);
}

async function registerConnector(label: string): Promise<Caller> {
  const slug = `fdp-${label}-${tag()}`;
  const registered = await call(OWNER, 'POST', '/services', {
    slug, name: slug, description: 'Finish dry-run parity drill connector.', kind: 'connector',
    issueCredential: { scopes: CONNECTOR_SCOPES, label: slug, transport: 'any' },
  });
  expect(registered.status).toBe(201);
  const row = await pool.query('SELECT principal_id FROM services WHERE slug = $1', [slug]);
  const token = String(registered.json.onboarding.credential.secretOnce);
  const caller: Caller = { label, principalId: String(row.rows[0].principal_id), token,
    headers: { Authorization: `Bearer ${token}` } };
  // Work-plane MCP tools are refused until the credential is bootstrapped.
  const brief = await mcpCall(token, 'relayhall_brief_compile', { session: true });
  expect(mcpFailed(brief)).toBe(false);
  return caller;
}

interface TaskShape {
  status?: string;
  claimant?: string | null;
  shepherd?: string;
  verifier?: string | null;
}

/** A Task written straight to the table: the state is the fixture, not the act under test. */
async function makeTask(shape: TaskShape): Promise<string> {
  const result = await pool.query(
    `INSERT INTO tasks (title, status, visibility, project_id, owner_principal_id,
                        creator_principal_id, shepherd_principal_id, verifier_principal_id)
     VALUES ($1, $2, 'private', $3, $4, $5, $6, $7) RETURNING id`,
    [`finish parity ${tag()}`, shape.status ?? 'in-progress', PROJECT,
      shape.claimant === undefined ? WORKER.principalId : shape.claimant,
      OWNER.principalId, shape.shepherd ?? OWNER.principalId, shape.verifier ?? null],
  );
  return String(result.rows[0].id);
}

async function insertReport(author: string, taskIds: string[], extra: { origin?: string; sourceTask?: string } = {}): Promise<string> {
  const content = `finish parity evidence ${tag()}`;
  const result = await pool.query(
    `INSERT INTO reports (title, content, content_hash, author, author_actor_id, author_principal_id, visibility,
                          task_ids, origin, source_task_id)
     VALUES ($1, $2, $3, 'finish-parity-suite', $4::text, $8::uuid, 'default', $5::uuid[], $6, $7) RETURNING id`,
    [`finish parity ${tag()}`, content, crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
      author, taskIds, extra.origin ?? 'api', extra.sourceTask ?? null, author],
  );
  return String(result.rows[0].id);
}

/** Everything a finish writes, read back. A dry run must leave all of it exactly as it was. */
async function footprint(taskId: string): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `SELECT t.status, t.updated_at::text AS updated_at,
            (SELECT count(*)::int FROM task_stream_entries WHERE task_id = t.id) AS stream_entries,
            (SELECT count(*)::int FROM task_stream_quarantine WHERE task_id = t.id) AS quarantined,
            (SELECT count(*)::int FROM reports WHERE t.id = ANY(task_ids) OR source_task_id = t.id) AS task_reports,
            (SELECT count(*)::int FROM reports) AS all_reports,
            (SELECT count(*)::int FROM task_references WHERE task_id = t.id) AS task_references,
            (SELECT count(*)::int FROM feed_events) AS feed_events,
            (SELECT count(*)::int FROM operation_idempotency_records) AS retry_records,
            (SELECT revision::text FROM task_assignments WHERE task_id = t.id) AS assignment_revision
       FROM tasks t WHERE t.id = $1`, [taskId]);
  return result.rows[0] ?? { missing: true };
}

// ───────────────────────────── the two transports ────────────────────────────

interface Outcome { status: number; code: string }

type Transport = 'rest' | 'mcp';

/** One finish through one transport, reduced to (HTTP status, code). */
async function finish(transport: Transport, who: Caller, taskId: string, body: Record<string, unknown>): Promise<Outcome & { text: string; json: any }> {
  if (transport === 'rest') {
    const answer = await call(who, 'POST', `/tasks/${taskId}/finish`, body);
    const code = answer.status === 200
      ? (answer.json?.dryRun === true ? 'DRY_RUN_VALID' : 'FINISHED')
      : String(answer.json?.code ?? 'UNKNOWN');
    return { status: answer.status, code, text: JSON.stringify(answer.json), json: answer.json };
  }
  const mark = dispatched.length;
  const answer = await mcpCall(who.token, 'relayhall_task_finish', { task: taskId, ...body });
  const seen = dispatched.slice(mark).filter((entry) => entry.method === 'POST' && /\/finish$/.test(entry.path));
  // Exactly one in-process dispatch: the tool forwards to the same router.
  expect(seen).toHaveLength(1);
  const status = seen[0].status;
  const envelope = seen[0].body ?? {};
  const code = status === 200
    ? (envelope.dryRun === true ? 'DRY_RUN_VALID' : 'FINISHED')
    : String(envelope.code ?? 'UNKNOWN');
  // The tool result agrees with the dispatch it made.
  expect(mcpFailed(answer)).toBe(status !== 200);
  if (status !== 200) expect(mcpText(answer)).toContain(code);
  return { status, code, text: mcpText(answer), json: envelope };
}

/** What the real call's outcome means for a dry run of the same request. */
function dryEquivalent(real: Outcome): Outcome {
  return real.status === 200 && real.code === 'FINISHED' ? { status: 200, code: 'DRY_RUN_VALID' } : real;
}

beforeAll(async () => {
  jest.spyOn(inProcess, 'dispatchInProcess').mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { method: string; path: string };
    const result = await realDispatch(...(args as [any]));
    dispatched.push({ method: request.method, path: request.path, status: result.status, body: result.body });
    return result;
  });

  await new Promise<void>((resolve) => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const ownerId = await makePerson('user', 'owner');
  const minted = await loginSessionService.mint({ principalId: ownerId });
  OWNER = { principalId: ownerId, headers: { Cookie: `${SESSION_COOKIE_NAME}=${minted.token}` } };

  const created = await call(OWNER, 'POST', '/projects', { name: `Finish parity ${tag()}` });
  expect(created.status).toBe(201);
  PROJECT = String(created.json.project.id);
  await pool.query('UPDATE projects SET owner_principal_id = $1 WHERE id = $2', [ownerId, PROJECT]);

  WORKER = await registerConnector('worker');
  OTHER = await registerConnector('other');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  jest.restoreAllMocks();
  await pool.end();
});

// ═══════════════════════════════ the cases ═══════════════════════════════════

interface ParityCase {
  name: string;
  /** Builds a FRESH state; the same builder serves the dry run and the real call. */
  arrange: () => Promise<{ taskId: string; who: Caller; body: Record<string, unknown> }>;
  /** What the real finish answers for this state (measured on the base line, never derived from the dry run). */
  real: Outcome;
  /** Process settings the case runs under (the server is in this process), restored afterwards. */
  env?: Record<string, string>;
}

const inlineReport = { report: { title: 'Finish parity evidence', content: 'Work done; evidence attached.' }, handover: 'Done.' };

const CASES: ParityCase[] = [
  {
    name: 'legitimate claimant, In Progress, inline Report',
    arrange: async () => ({ taskId: await makeTask({}), who: WORKER, body: inlineReport }),
    real: { status: 200, code: 'FINISHED' },
  },
  {
    name: 'legitimate claimant naming its own active Report',
    arrange: async () => {
      const taskId = await makeTask({});
      return { taskId, who: WORKER, body: { reportId: await insertReport(WORKER.principalId, []), handover: 'Done.' } };
    },
    real: { status: 200, code: 'FINISHED' },
  },
  {
    name: 'oversized handover auto-promoted to a Report',
    arrange: async () => ({ taskId: await makeTask({}), who: WORKER, body: { handover: 'x'.repeat(9000) } }),
    real: { status: 200, code: 'FINISHED' },
  },
  {
    name: 'no claimant: the shepherd hands the Task back',
    arrange: async () => ({ taskId: await makeTask({ claimant: null, shepherd: WORKER.principalId }), who: WORKER, body: inlineReport }),
    real: { status: 200, code: 'FINISHED' },
  },
  {
    name: 'actor is the assigned Verifier and the shepherd (observed case)',
    arrange: async () => ({
      taskId: await makeTask({ claimant: OTHER.principalId, shepherd: WORKER.principalId, verifier: WORKER.principalId }),
      who: WORKER, body: inlineReport,
    }),
    real: { status: 403, code: 'CLAIMANT_VERIFIER_CONFLICT' },
  },
  {
    name: 'actor holds a Task write grant but no Task role (no claim)',
    arrange: async () => {
      const taskId = await makeTask({ claimant: WORKER.principalId });
      await pool.query(
        `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id)
         VALUES ('principal', $1, 'task', $2, 'write', $3)`, [OTHER.principalId, taskId, OWNER.principalId]);
      return { taskId, who: OTHER, body: inlineReport };
    },
    real: { status: 403, code: 'TASK_ROLE_REQUIRED' },
  },
  {
    name: 'claimant, Task still To Do',
    arrange: async () => ({ taskId: await makeTask({ status: 'todo' }), who: WORKER, body: inlineReport }),
    real: { status: 409, code: 'TASK_NOT_FINISHABLE' },
  },
  {
    name: 'claimant, Task already in Review',
    arrange: async () => ({ taskId: await makeTask({ status: 'review' }), who: WORKER, body: inlineReport }),
    real: { status: 409, code: 'TASK_NOT_FINISHABLE' },
  },
  {
    name: 'claimant, a Subtask not handed back',
    arrange: async () => {
      const taskId = await makeTask({});
      await pool.query(`INSERT INTO subtasks (task_id, index, title, status) VALUES ($1, 0, 'unfinished child', 'in-progress')`, [taskId]);
      return { taskId, who: WORKER, body: inlineReport };
    },
    real: { status: 409, code: 'SUBTASK_NOT_HANDED_BACK' },
  },
  {
    name: 'claimant naming another principal\'s Report',
    arrange: async () => ({
      taskId: await makeTask({}), who: WORKER,
      body: { reportId: await insertReport(OTHER.principalId, []), handover: 'Done.' },
    }),
    real: { status: 400, code: 'REPORT_NOT_LINKABLE' },
  },
  {
    name: 'claimant naming a Task Report filed for a different Task',
    arrange: async () => {
      const taskId = await makeTask({});
      const elsewhere = await makeTask({});
      const reportId = await insertReport(WORKER.principalId, [elsewhere], { origin: 'task-report', sourceTask: elsewhere });
      return { taskId, who: WORKER, body: { reportId, handover: 'Done.' } };
    },
    real: { status: 409, code: 'TASK_REPORT_HANDOFF_PROVENANCE' },
  },
  {
    name: 'claimant naming a native generation the Task does not have',
    arrange: async () => ({
      taskId: await makeTask({}), who: WORKER,
      body: { ...inlineReport, nativeGeneration: { schemaVersion: 2, generationId: crypto.randomUUID(),
        executionId: crypto.randomUUID(), publicationKey: crypto.randomUUID(), requestSha256: hex64() } },
    }),
    real: { status: 409, code: 'CONFLICT' },
  },
  {
    name: 'claimant on a Task held by an imported native quarantine',
    arrange: async () => {
      const taskId = await makeTask({});
      await pool.query(
        `INSERT INTO task_native_import_quarantine (deployment_id, store_id, task_id, snapshot_digest, manifest_digest, manifest, imported_by)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6)`,
        [crypto.randomUUID(), crypto.randomUUID(), taskId, hex64(), hex64(), OWNER.principalId]);
      return { taskId, who: WORKER, body: inlineReport };
    },
    real: { status: 409, code: 'NATIVE_GENERATION_IMPORT_HOLD' },
  },
  {
    name: 'two rules broken at once: the first refusal in finish order wins (wrong state over open Subtask)',
    arrange: async () => {
      const taskId = await makeTask({ status: 'todo' });
      await pool.query(`INSERT INTO subtasks (task_id, index, title, status) VALUES ($1, 0, 'unfinished child', 'in-progress')`, [taskId]);
      return { taskId, who: WORKER, body: inlineReport };
    },
    real: { status: 409, code: 'TASK_NOT_FINISHABLE' },
  },
  {
    name: 'actor is only the assigned Verifier',
    arrange: async () => ({
      taskId: await makeTask({ claimant: OTHER.principalId, verifier: WORKER.principalId }), who: WORKER, body: inlineReport,
    }),
    real: { status: 403, code: 'CLAIMANT_VERIFIER_CONFLICT' },
  },
  {
    name: 'a Task that does not exist',
    arrange: async () => ({ taskId: crypto.randomUUID(), who: WORKER, body: inlineReport }),
    real: { status: 404, code: 'RESOURCE_NOT_FOUND' },
  },
  {
    name: 'oversized handover with the hourly auto-promotion cap spent (quarantined, so no Report)',
    env: { TASK_STREAM_AUTO_PROMOTION_PER_HOUR: '1' },
    arrange: async () => {
      // One auto-promoted Report of the actor's inside the hour spends a cap of one.
      await pool.query(
        `INSERT INTO reports (title, content, author, author_actor_id, author_principal_id, visibility, task_ids, auto_promoted)
         VALUES ($1, 'spent promotion', 'finish-parity-suite', $2::text, $3::uuid, 'default', '{}'::uuid[], TRUE)`,
        [`finish parity cap ${tag()}`, WORKER.principalId, WORKER.principalId]);
      return { taskId: await makeTask({}), who: WORKER, body: { handover: 'x'.repeat(9000) } };
    },
    real: { status: 500, code: 'REPORT_LINK_MISSING' },
  },
  {
    name: 'no Report and a short handover',
    arrange: async () => ({ taskId: await makeTask({}), who: WORKER, body: { handover: 'Done.' } }),
    real: { status: 400, code: 'REPORT_REQUIRED' },
  },
];

const TRANSPORTS: Transport[] = ['rest', 'mcp'];

describe('(A)+(B) the dry run answers what the real finish answers, and writes nothing', () => {
  for (const transport of TRANSPORTS) {
    describe(`through ${transport === 'rest' ? 'POST /tasks/{id}/finish' : 'MCP relayhall_task_finish'}`, () => {
      test.each(CASES.map((entry) => [entry.name, entry] as const))('%s', async (_name, entry) => {
        const saved: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(entry.env ?? {})) { saved[name] = process.env[name]; process.env[name] = value; }
        try {
          // The dry run and the real call each meet their own fresh copy of the
          // same state, so neither can be explained by what the other did.
          const dryState = await entry.arrange();
          const before = await footprint(dryState.taskId);
          const dry = await finish(transport, dryState.who, dryState.taskId, { ...dryState.body, dryRun: true });
          const after = await footprint(dryState.taskId);

          const realState = await entry.arrange();
          const real = await finish(transport, realState.who, realState.taskId, realState.body);

          // The real call is measured against its own expectation first, so a
          // pairing failure can never hide behind both sides having moved.
          expect({ real: [real.status, real.code] }).toEqual({ real: [entry.real.status, entry.real.code] });
          // THE PAIR.
          expect({ pair: [dry.status, dry.code] }).toEqual({ pair: [dryEquivalent(real).status, dryEquivalent(real).code] });
          // A dry run moved nothing, whatever it answered.
          expect(after).toEqual(before);
          if (real.code === 'FINISHED') {
            expect(dry.json).toMatchObject({ valid: true, dryRun: true, targetStatus: 'review' });
            expect((await footprint(realState.taskId)).status).toBe('review');
          } else {
            expect((await footprint(realState.taskId)).status).toBe((await footprint(dryState.taskId)).status);
          }
        } finally {
          for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
          }
        }
      });
    });
  }
});

describe('(C) the retry contract: finish takes no key and a dry run spends nothing', () => {
  test.each(TRANSPORTS)('%s: dry runs repeat freely, the real finish still lands once, then dry run and retry are both refused', async (transport) => {
    const taskId = await makeTask({});
    const before = await footprint(taskId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dry = await finish(transport, WORKER, taskId, { ...inlineReport, dryRun: true });
      expect([dry.status, dry.code]).toEqual([200, 'DRY_RUN_VALID']);
    }
    expect(await footprint(taskId)).toEqual(before);

    const real = await finish(transport, WORKER, taskId, inlineReport);
    expect([real.status, real.code]).toEqual([200, 'FINISHED']);
    const finished = await footprint(taskId);

    const dryAfter = await finish(transport, WORKER, taskId, { ...inlineReport, dryRun: true });
    const retry = await finish(transport, WORKER, taskId, inlineReport);
    expect([retry.status, retry.code]).toEqual([409, 'TASK_NOT_FINISHABLE']);
    expect([dryAfter.status, dryAfter.code]).toEqual([retry.status, retry.code]);
    // Neither the refused retry nor the dry run moved anything after the finish.
    expect(await footprint(taskId)).toEqual(finished);
  });
});

describe('(D) the MCP answer to a dry run never claims the Task was finished', () => {
  test('a valid dry run says it is a dry run, and the real finish still says it finished', async () => {
    const dryTask = await makeTask({});
    const dry = await finish('mcp', WORKER, dryTask, { ...inlineReport, dryRun: true });
    expect([dry.status, dry.code]).toEqual([200, 'DRY_RUN_VALID']);
    expect(dry.text).not.toContain('finished to Review');
    expect(dry.text).toContain('dry run');
    expect((await footprint(dryTask)).status).toBe('in-progress');

    const realTask = await makeTask({});
    const real = await finish('mcp', WORKER, realTask, inlineReport);
    expect([real.status, real.code]).toEqual([200, 'FINISHED']);
    expect(real.text).toContain('finished to Review');
  });
});
