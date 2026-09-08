/**
 * POST /tasks/{id}/brief fails closed on Charter lookup failure
 * (review 6fa91e28 F1): a lookup failure is not confirmed absence — the
 * canonical task compile surface must never return success: true without
 * having established the project's authority-index state. The legitimate
 * no-Charter case (find -> null) stays a 200. Runs the REAL tasks router
 * and the REAL Brief compiler; only the leaf services are faked.
 */
import express from 'express';
import http from 'http';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() },
}));

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_ID = 'tttttttt-1111-4111-8111-111111111111';
// A deliberately secret-shaped lookup failure: none of it may reach a response
// (review a2b2f742 F1).
const SENSITIVE_LOOKUP_DETAIL = 'postgresql://private-user:sentinel-secret@private-db.internal/relayhall';

let charterLookupFails = false;
let charter: any = null;

jest.mock('../services/CharterService', () => {
  const actual = jest.requireActual('../services/CharterService');
  return {
    CharterLookupError: actual.CharterLookupError,
    charterService: {
      find: jest.fn(async () => {
        if (charterLookupFails) throw new Error(SENSITIVE_LOOKUP_DETAIL);
        return charter;
      }),
    },
  };
});

jest.mock('../services/TaskManagerDB', () => ({
  taskManagerDB: {
    getTask: jest.fn(async (id: string) => (id === TASK_ID ? {
      id: TASK_ID, title: 'Fixture task', description: 'Fixture', status: 'todo',
      project: 'Fixture', subtasks: [], model: null,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      phaseId: (global as any).__fixturePhaseId ?? null,
    } : null)),
    getBlockingTasks: jest.fn(async () => []),
    // RH-P3.C5: the compiler resolves referenced Reports on every Brief.
    queryLinkedReports: jest.fn(async () => []),
  },
  SubtaskStatus: {},
  DependencyValidationError: class extends Error {},
  archiveWarningForStatus: jest.fn(() => null),
}));

jest.mock('../services/ProjectService', () => ({
  projectService: {
    list: jest.fn(async () => [{
      id: PROJECT_ID, name: 'Fixture', description: 'Fixture project',
      status: 'active', revision: 'r', is_hidden: false,
      created_at: 'now', updated_at: 'now',
    }]),
  },
}));

jest.mock('../services/ProjectResourceService', () => ({
  projectResourceService: {
    context: jest.fn(async () => ({
      project: { name: 'Fixture' }, resources: [],
      omitted: { hidden: 0, archived: 0, incompatible: 0 }, schemaVersion: 1,
    })),
  },
}));

jest.mock('../services/PhaseService', () => {
  const actual = jest.requireActual('../services/PhaseService');
  return {
    ...actual,
    phaseService: {
      get: jest.fn(async () => {
        if ((global as any).__phaseLookupFails) {
          const e = new Error(SENSITIVE_LOOKUP_DETAIL);
          // Error.name is exception-derived and mutable (review b82cb8bd).
          e.name = SENSITIVE_LOOKUP_DETAIL;
          throw e;
        }
        return {
          id: (global as any).__fixturePhaseId, projectId: PROJECT_ID, name: 'Fixture phase',
          goal: 'Fixture phase goal', status: 'todo', position: 0, revision: 'r',
          createdAt: 'now', updatedAt: 'now',
        };
      }),
    },
  };
});

jest.mock('../services/SkillManager', () => ({
  skillManager: { getEffectiveSkillsForProject: jest.fn(async () => []) },
}));

jest.mock('../services/PersonalityService', () => ({
  personalityService: { getById: jest.fn(async () => null) },
}));

jest.mock('../services/taskAnalyzer', () => ({ taskAnalyzer: {} }));
jest.mock('../services/NotificationManager', () => ({ notificationManager: {} }));
jest.mock('../services/TaskReviewerService', () => ({ taskReviewerService: {} }));
jest.mock('../services/TaskOrchestrationService', () => ({
  taskOrchestrationService: {},
  OrchestrationConflictError: class extends Error {},
}));
jest.mock('../services/DiscordThreadService', () => ({ discordThreadService: {} }));
jest.mock('../services/TaskHistoryService', () => ({ taskHistoryService: { recordChange: jest.fn() } }));
jest.mock('../services/TaskNotificationService', () => ({ taskNotificationService: {} }));
jest.mock('../services/CanonicalRuntimeSignalService', () => ({ canonicalRuntimeSignalService: {} }));

import tasksRouter from '../routes/tasks';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/tasks', tasksRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  charterLookupFails = false;
  charter = null;
  (global as any).__phaseLookupFails = false;
  (global as any).__fixturePhaseId = null;
});

async function compile(): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/tasks/${TASK_ID}/brief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const json: any = await response.json().catch(() => null);
  return { status: response.status, json };
}

describe('POST /tasks/{id}/brief Charter fail-closed contract', () => {
  it('a Charter lookup failure can never return success: true', async () => {
    charterLookupFails = true;
    const r = await compile();
    expect(r.status).toBe(503);
    expect(r.json.success).toBe(false);
    expect(r.json.code).toBe('CHARTER_LOOKUP_FAILED');
    expect(r.json.brief).toBeUndefined();
  });

  it('the failure envelope is opaque: no internal lookup detail reaches the response (review a2b2f742 F1)', async () => {
    charterLookupFails = true;
    const r = await compile();
    const serialized = JSON.stringify(r.json);
    expect(serialized).not.toContain('sentinel-secret');
    expect(serialized).not.toContain('private-db.internal');
    expect(serialized).not.toContain('postgresql://');
  });

  it('no internal lookup detail reaches server LOGS either (review b45fb44e F1)', async () => {
    charterLookupFails = true;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await compile();
      expect(r.status).toBe(503);
      const logged = JSON.stringify([...errorSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(logged).not.toContain('sentinel-secret');
      expect(logged).not.toContain('private-db.internal');
      expect(logged).not.toContain('postgresql://');
      // The fixed diagnostic still identifies the surface.
      expect(logged).toContain('Charter lookup failed');
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('confirmed absence (find -> null) still compiles a 200 Brief', async () => {
    const r = await compile();
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.brief).toContain('Fixture task');
    expect(r.json.brief).not.toContain('Project Charter');
  });

  it('a chartered project compiles a 200 Brief carrying the index', async () => {
    charter = { id: 'c', projectId: PROJECT_ID, content: 'CHARTER SENTINEL', version: 1, revision: 'rev' };
    const r = await compile();
    expect(r.status).toBe(200);
    expect(r.json.brief).toContain('### Project Charter (authority index)');
    expect(r.json.brief).toContain('CHARTER SENTINEL');
  });
});

/**
 * The Phase goal carries the SAME fail-closed contract as the Charter
 * (review 1a786ae4 F2): the ratified design says the Brief shows the Project
 * and Phase goal (e20a12d6 §4, E-12), so a bound Phase whose lookup FAILED
 * must not yield a plausible Brief with the goal quietly missing. Confirmed
 * absence — an unphased task — still compiles.
 */
describe('phase goal fail-closed on the canonical task compile surface', () => {
  it('refuses to compile when a BOUND phase cannot be established', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (global as any).__fixturePhaseId = 'pppppppp-1111-4111-8111-111111111111';
    (global as any).__phaseLookupFails = true;
    const result = await compile();
    expect(result.status).toBe(503);
    expect(result.json.code).toBe('PHASE_LOOKUP_FAILED');
    expect(result.json.success).toBe(false);
    // Nothing exception-derived reaches the response OR the log.
    expect(JSON.stringify(result.json)).not.toContain('sentinel-secret');
    expect(spy.mock.calls.map((a) => a.join(' ')).join('\n')).not.toContain('sentinel-secret');
    spy.mockRestore();
  });

  it('compiles for an UNPHASED task — absence is not failure', async () => {
    (global as any).__fixturePhaseId = null;
    (global as any).__phaseLookupFails = true;
    const result = await compile();
    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
  });

  it('renders the phase goal when the lookup succeeds', async () => {
    (global as any).__fixturePhaseId = 'pppppppp-1111-4111-8111-111111111111';
    const result = await compile();
    expect(result.status).toBe(200);
    expect(result.json.brief).toContain('Fixture phase goal');
  });
});
