/**
 * c49ProjectSkillsErrors.test.ts — review 3db17273 B1: the Project-Skill
 * list, pin, and unpin failure envelopes each surface the correlating
 * errorId from the secret-safe sink, keep their fixed developer-authored
 * messages, and never relay the caught value's text.
 */
import express from 'express';
import type { AddressInfo } from 'net';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() },
}));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: {
    authorizedIds: jest.fn(async (_actor: unknown, _type: string, ids: string[]) => new Set(ids)),
  },
}));
const behavior: {
  getById: () => Promise<unknown>;
  getProjectSkills: () => Promise<unknown>;
  pinToProject: () => Promise<unknown>;
  unlinkFromProject: () => Promise<unknown>;
} = {
  getById: async () => ({ id: 'p1', name: 'P1', status: 'active' }),
  getProjectSkills: async () => { throw new Error('SECRET pg text: relation skills not found'); },
  pinToProject: async () => { throw new Error('SECRET pin driver text'); },
  unlinkFromProject: async () => { throw new Error('SECRET unpin driver text'); },
};
jest.mock('../services/ProjectService', () => ({
  projectService: { getById: jest.fn(async () => behavior.getById()) },
}));
jest.mock('../services/ProjectStatsService', () => ({ projectStatsService: {} }));
jest.mock('../services/SkillManager', () => ({
  skillManager: {
    getProjectSkills: jest.fn(async () => behavior.getProjectSkills()),
    pinToProject: jest.fn(async () => behavior.pinToProject()),
    unlinkFromProject: jest.fn(async () => behavior.unlinkFromProject()),
  },
  SkillContractError: class SkillContractError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));
jest.mock('../services/ProjectResourceService', () => ({
  projectResourceService: {},
  ResourceContractError: class ResourceContractError extends Error { },
}));
jest.mock('../services/ProjectAuthorization', () => ({ projectAuthorization: {} }));
jest.mock('../services/CharterService', () => ({
  charterService: {},
  CharterError: class CharterError extends Error { },
}));
jest.mock('../services/PhaseService', () => ({
  phaseService: {},
  PhaseError: class PhaseError extends Error { },
}));
jest.mock('../services/WebhookService', () => ({
  webhookService: { emitEvent: jest.fn() },
}));
jest.mock('../services/ReportManager', () => ({ reportManager: {} }));
jest.mock('../services/LifecyclePolicyService', () => ({
  lifecyclePolicyService: {},
  lifecyclePolicyDenialEnvelope: jest.fn(() => null),
}));

import projectsRouter from '../routes/projects';
import { NotFoundFault } from '../utils/httpErrors';

let server: ReturnType<typeof express.application.listen>;
let base = '';

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: '99999999-9999-4999-8999-999999999999', handle: 'qa' };
    (req as any).scopes = ['projects:read', 'projects:write', 'skills:write'];
    (req as any).userId = 'qa';
    next();
  });
  app.use('/projects', projectsRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
afterEach(() => {
  behavior.getById = async () => ({ id: 'p1', name: 'P1', status: 'active' });
  behavior.getProjectSkills = async () => { throw new Error('SECRET pg text: relation skills not found'); };
  behavior.pinToProject = async () => { throw new Error('SECRET pin driver text'); };
  behavior.unlinkFromProject = async () => { throw new Error('SECRET unpin driver text'); };
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

test('list failure: fixed message, typed code, errorId — no caught text', async () => {
  const { status, body } = await call('GET', '/projects/p1/skills');
  expect(status).toBe(500);
  expect(body).toMatchObject({
    success: false,
    code: 'PROJECT_SKILLS_READ_FAILED',
    error: 'Project skills could not be read',
  });
  expect(typeof body.errorId).toBe('string');
  expect(body.errorId.length).toBeGreaterThan(8);
  expect(JSON.stringify(body)).not.toContain('SECRET');
});

test('list of a missing project: typed NotFoundFault answers 404 with its developer-authored message', async () => {
  behavior.getById = async () => { throw new NotFoundFault('Project not found: p-gone', 'PROJECT_NOT_FOUND'); };
  const { status, body } = await call('GET', '/projects/p-gone/skills');
  expect(status).toBe(404);
  expect(body).toMatchObject({ success: false, code: 'PROJECT_NOT_FOUND', error: 'Project not found: p-gone' });
});

test('list: a FOREIGN error carrying a dispatch phrase is NOT sniffed into a 404 (review 3db17273 B4)', async () => {
  behavior.getById = async () => { throw new Error('SECRET driver: project row not found in shard'); };
  const { status, body } = await call('GET', '/projects/p1/skills');
  expect(status).toBe(500);
  expect(body.code).toBe('PROJECT_SKILLS_READ_FAILED');
  expect(JSON.stringify(body)).not.toContain('SECRET');
});

test('pin failure: envelope carries details.errorId and no caught text', async () => {
  const { status, body } = await call('PUT', '/projects/p1/skills/s1', { version: '3' });
  expect(status).toBe(500);
  expect(body).toMatchObject({ success: false, code: 'INTERNAL_ERROR' });
  expect(typeof body.details?.errorId).toBe('string');
  expect(body.details.errorId.length).toBeGreaterThan(8);
  expect(JSON.stringify(body)).not.toContain('SECRET');
});

test('unpin failure: envelope carries details.errorId and no caught text', async () => {
  const { status, body } = await call('DELETE', '/projects/p1/skills/s1');
  expect(status).toBe(500);
  expect(body).toMatchObject({ success: false, code: 'INTERNAL_ERROR' });
  expect(typeof body.details?.errorId).toBe('string');
  expect(JSON.stringify(body)).not.toContain('SECRET');
});
