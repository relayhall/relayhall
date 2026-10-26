/**
 * A refusal answers only AFTER its denied audit row is written (the beta.76
 * fix-forward on card 08792425, and the class census over the E413 / E418(b)
 * grant revoke routes beside it). The fast-tier half: no database.
 *
 * The defect this pins: the registration act's catch path answered the
 * refusal and only then wrote the denied row, so a caller (the live suite
 * among them) could read the answer before the row existed, and a reader of
 * the audit log raced the act it was auditing.
 *
 * Deterministic, no timers: the audit write is a stub that does not resolve
 * until the test releases it, and the server records the moment the response
 * leaves (res.end). While the write is held open, nothing may have left;
 * once released, the order must be exactly: the write starts, the write
 * finishes, the response leaves. A route that answers first records the
 * response BEFORE the write starts, whatever the scheduling.
 *
 * knowledge-registration-mutations.py restores respond-first in the
 * registration sender and requires exactly the act's catch-path tests below
 * to fail.
 */
import express from 'express';
import http from 'http';

jest.mock('../db/connection', () => ({ pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() } }));
jest.mock('../services/AuditService', () => ({
  ...jest.requireActual('../services/AuditService'),
  auditService: { record: jest.fn() },
}));
jest.mock('../services/KnowledgeSourceRegistration', () => ({
  ...jest.requireActual('../services/KnowledgeSourceRegistration'),
  registerKnowledgeSource: jest.fn(),
}));

import { auditService } from '../services/AuditService';
import {
  KnowledgeSourceRegistrationError, REGISTRATION_BUNDLE_SCHEMA, registerKnowledgeSource,
} from '../services/KnowledgeSourceRegistration';
import { StepUpError } from '../services/StepUpService';
import { ServiceRegistryError } from '../services/ServiceRegistry';
import { LifecyclePolicyDeniedError } from '../services/LifecyclePolicyService';
import { knowledgeSourceRegistrationsRouter } from '../routes/knowledgeSourceRegistrations';
import grantsRouter from '../routes/grants';

const record = auditService.record as jest.Mock;
const register = registerKnowledgeSource as jest.Mock;

const FINGERPRINT = 'ab'.repeat(32);
const GRANT_ID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const SESSION_ROOT = {
  authMethod: 'session', scopes: ['root'], userId: 'root-account', sessionRole: null,
  principal: { id: '11111111-1111-4111-8111-111111111111', handle: 'root-account', role: 'admin' },
};
const ROOT_BEARER = { ...SESSION_ROOT, authMethod: 'principal_api_key' };

let auth: Record<string, unknown> = SESSION_ROOT;
let events: string[] = [];
let server: http.Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    Object.assign(req, auth);
    const end = res.end.bind(res) as (...args: unknown[]) => unknown;
    (res as unknown as { end: (...args: unknown[]) => unknown }).end = (...args: unknown[]) => {
      events.push('response');
      return end(...args);
    };
    next();
  });
  app.use('/knowledge-source-registrations', knowledgeSourceRegistrationsRouter);
  app.use('/grants', grantsRouter);
  server = app.listen(0, '127.0.0.1', () => {
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  auth = SESSION_ROOT;
});

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The audit write, held open until the test releases it. */
function heldAudit() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const called = new Promise<void>((resolve) => { started = resolve; });
  record.mockImplementation(async (write: { metadata?: { refusal?: string } }) => {
    events.push(`audit:${write.metadata?.refusal}`);
    started();
    await gate;
    events.push('audit:written');
    return { id: 'audit-row' };
  });
  return { release, called };
}

/** Lets every already-queued callback run, so a response already written would be recorded. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function expectAnswerAfterAudit(method: string, path: string, body: unknown, refusal: string) {
  const audit = heldAudit();
  const pending = call(method, path, body);
  await audit.called;
  await drain();
  // The write is still open: nothing may have left.
  expect(events).toEqual([`audit:${refusal}`]);
  audit.release();
  const answer = await pending;
  expect(events).toEqual([`audit:${refusal}`, 'audit:written', 'response']);
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0][0]).toMatchObject({ outcome: 'denied', metadata: { refusal } });
  expect(answer.body.code).toBe(refusal);
  return answer;
}

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: REGISTRATION_BUNDLE_SCHEMA,
    name: 'Team knowledge',
    endpoint: 'https://knowledge.example.org/knowledge/search',
    descriptor: {
      options: [],
      knowledgeSource: {
        classes: [{ key: 'notes', content: 'docs' }], compartments: [], protocol_version: 2,
        compartment_mode: 'dynamic-opaque', categories: ['relaybrain:note'],
      },
    },
    certificateSha256: FINGERPRINT,
    ...overrides,
  };
}
const VALID = { bundle: bundle(), confirmedFingerprint: FINGERPRINT, confirmation: 'checked', stepUpToken: 'held-token' };

const LO = '(O) the registration act answers a refusal only after its denied audit row is written';
const GO = '(O) the grant revoke routes (E413, E418(b)) answer a refusal only after its denied audit row is written';

describe(LO, () => {
  it('the gate: a bearer is refused only after the denied row is written', async () => {
    auth = ROOT_BEARER;
    const answer = await expectAnswerAfterAudit('POST', '/knowledge-source-registrations', VALID, 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION');
    expect(answer.status).toBe(403);
    expect(register).not.toHaveBeenCalled();
  });

  it('an unknown field is refused only after the denied row is written', async () => {
    const answer = await expectAnswerAfterAudit('POST', '/knowledge-source-registrations', { ...VALID, surprise: true }, 'UNKNOWN_FIELD');
    expect(answer.status).toBe(400);
    expect(register).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid bundle', () => undefined, { ...VALID, bundle: '{not json' }, 'REGISTRATION_BUNDLE_INVALID', 422],
    ['a step-up refusal', () => register.mockRejectedValue(new StepUpError(403, 'STEP_UP_REQUIRED', 'A step-up is required', {
      error: 'insufficient_user_authentication', action: 'knowledge.source.register', targetId: FINGERPRINT, max_age: 0,
    })), VALID, 'STEP_UP_REQUIRED', 403],
    ['a Service registry refusal', () => register.mockRejectedValue(new ServiceRegistryError(409, 'SERVICE_SLUG_TAKEN', 'The slug is taken', 'slug')),
      VALID, 'SERVICE_SLUG_TAKEN', 409],
    ['a lifecycle policy denial', () => register.mockRejectedValue(new LifecyclePolicyDeniedError(
      'service.publish', { kind: 'service' } as never, ['control'], ['reason'], null)), VALID, 'LIFECYCLE_POLICY_DENIED', 409],
    ['a taken channel-credential reference', () => register.mockRejectedValue(new KnowledgeSourceRegistrationError(409,
      'REGISTRATION_CREDENTIAL_REFERENCE_TAKEN', 'The reference is taken', 'slug', { reason: 'resolves' })),
    VALID, 'REGISTRATION_CREDENTIAL_REFERENCE_TAKEN', 409],
  ])('a refusal from the act (%s) answers only after its denied row is written', async (_label, arrange, body, code, status) => {
    arrange();
    const answer = await expectAnswerAfterAudit('POST', '/knowledge-source-registrations', body, code as string);
    expect(answer.status).toBe(status);
  });

  it('the denied row carries the named details of the refusal it answers', async () => {
    register.mockRejectedValue(new KnowledgeSourceRegistrationError(409,
      'REGISTRATION_CREDENTIAL_REFERENCE_TAKEN', 'The reference is taken', 'slug', { reason: 'resolves' }));
    const answer = await expectAnswerAfterAudit('POST', '/knowledge-source-registrations', VALID, 'REGISTRATION_CREDENTIAL_REFERENCE_TAKEN');
    expect(answer.body.reason).toBe('resolves');
    expect(record.mock.calls[0][0].metadata).toMatchObject({ reason: 'resolves', certificateSha256: FINGERPRINT });
  });

  it('a failed denied-audit write still answers the refusal by name, after the attempt, and is logged as a warning without the caught text', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      register.mockRejectedValue(new StepUpError(403, 'STEP_UP_REQUIRED', 'A step-up is required'));
      record.mockImplementation(async (write: { metadata?: { refusal?: string } }) => {
        events.push(`audit:${write.metadata?.refusal}`);
        throw new Error('audit store unavailable: secret-marker-7f3a');
      });
      const answer = await call('POST', '/knowledge-source-registrations', VALID);
      expect(events).toEqual(['audit:STEP_UP_REQUIRED', 'response']);
      expect(answer.status).toBe(403);
      expect(answer.body.code).toBe('STEP_UP_REQUIRED');
      const logged = warn.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(logged).toContain('[Knowledge source registration] refusal audit write failed:');
      expect(logged).not.toContain('secret-marker-7f3a');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['GET /', '/knowledge-source-registrations'],
    ['GET /:id', `/knowledge-source-registrations/${GRANT_ID}`],
    ['GET /:id/return-bundle', `/knowledge-source-registrations/${GRANT_ID}/return-bundle`],
  ])('a refused read (%s) answers by name and writes no audit row, by design', async (_label, path) => {
    auth = ROOT_BEARER;
    const answer = await call('GET', path);
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION');
    expect(record).not.toHaveBeenCalled();
    expect(events).toEqual(['response']);
  });
});

describe(GO, () => {
  it('DELETE /grants/:id: a bearer is refused SESSION_ONLY only after the denied row is written', async () => {
    auth = ROOT_BEARER;
    const answer = await expectAnswerAfterAudit('DELETE', `/grants/${GRANT_ID}`, { stepUpToken: 'held-token' }, 'SESSION_ONLY');
    expect(answer.status).toBe(403);
  });

  it('DELETE /grants/:id: a missing step-up is refused only after the denied row is written', async () => {
    const answer = await expectAnswerAfterAudit('DELETE', `/grants/${GRANT_ID}`, {}, 'STEP_UP_REQUIRED');
    expect(answer.status).toBe(403);
    expect(answer.body.stepUp).toMatchObject({ action: 'grant.revoke', targetId: GRANT_ID });
  });

  it('POST /grants/bulk-revoke: a bearer is refused SESSION_ONLY only after the denied row is written', async () => {
    auth = ROOT_BEARER;
    const answer = await expectAnswerAfterAudit('POST', '/grants/bulk-revoke', { ids: [GRANT_ID], dryRun: false }, 'SESSION_ONLY');
    expect(answer.status).toBe(403);
  });

  it('POST /grants/bulk-revoke: a real run without a step-up is refused only after the denied row is written', async () => {
    const answer = await expectAnswerAfterAudit('POST', '/grants/bulk-revoke', { ids: [GRANT_ID], dryRun: false }, 'STEP_UP_REQUIRED');
    expect(answer.status).toBe(403);
    expect(answer.body.stepUp).toMatchObject({ action: 'grant.bulk_revoke' });
  });
});
