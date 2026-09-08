/**
 * Hostile-input authorization tests (P15[7]).
 *
 * The existing auth suites all supply well-formed single-valued headers. Node
 * gives `string[]` for a repeated header, and the middleware casts with
 * `as string`, so duplicate-header and wrong-type inputs were entirely
 * unexercised. Everything here must fail CLOSED.
 */
import jwt from 'jsonwebtoken';

// Pre-migration substrate mock: every principal/credential lookup fails with
// undefined_table, and the tolerance contract requires legacy behaviour to
// stay byte-identical on that path.
jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn().mockRejectedValue(Object.assign(new Error('relation "principals" does not exist'), { code: '42P01' })),
  },
}));

const SECRET = 'hostile-test-secret';
const REPORTS_KEY = 'reports-read-secret';
const API_KEY = 'global-service-secret';

interface InvokeResult {
  status: number;
  next: boolean;
  userId?: string;
}

async function invoke(options: {
  baseUrl?: string;
  path?: string;
  method?: string;
  headers?: Record<string, unknown>;
}): Promise<InvokeResult> {
  const { authMiddleware } = await import('../middleware/auth');
  const req: any = {
    baseUrl: options.baseUrl ?? '',
    path: options.path ?? '/',
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
  };
  let status = 200;
  let next = false;
  const res: any = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: () => res,
  };
  await authMiddleware(req, res, () => {
    next = true;
  });
  return { status, next, userId: req.userId };
}

beforeEach(() => {
  jest.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.RELAYHALL_REPORTS_READ_API_KEY = REPORTS_KEY;
  process.env.RELAYHALL_API_KEY = API_KEY;
});

const RID = '11111111-1111-4111-8111-111111111111';

describe('repeated headers fail closed', () => {
  it('rejects a duplicated reports-read key even when one value is correct', async () => {
    const result = await invoke({
      baseUrl: '/reports',
      headers: { 'x-reports-read-key': ['wrong', REPORTS_KEY] },
    });
    expect(result.next).toBe(false);
    expect(result.userId).toBeUndefined();
    // Pre-change this threw inside Buffer.byteLength and surfaced as a 500:
    // it failed closed, but through an unhandled error path.
    expect(result.status).toBe(403);
  });

  it('does not grant service_account for a duplicated api key', async () => {
    const result = await invoke({ headers: { 'x-api-key': [API_KEY, API_KEY] } });
    expect(result.userId).not.toBe('service_account');
  });
});

describe('wrong-typed and malformed credentials fail closed', () => {
  it.each([
    ['number', 42],
    ['object', { toString: () => REPORTS_KEY }],
    ['array of objects', [{}]],
    ['null', null],
    ['boolean', true],
  ])('rejects a %s reports-read key', async (_label, value) => {
    const result = await invoke({
      baseUrl: '/reports',
      headers: { 'x-reports-read-key': value },
    });
    expect(result.userId).toBe(undefined);
  });

  it('does not accept an empty api key when the configured key is empty', async () => {
    process.env.RELAYHALL_API_KEY = '';
    const result = await invoke({ headers: { 'x-api-key': '' } });
    expect(result.userId).not.toBe('service_account');
  });

  it('rejects a bearer token signed with the wrong secret', async () => {
    const forged = jwt.sign({ userId: 'dashboard_user' }, 'not-the-secret');
    const result = await invoke({ headers: { authorization: `Bearer ${forged}` } });
    expect(result.status).toBe(401);
    expect(result.next).toBe(false);
  });

  it('rejects the algorithm-none forgery', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ userId: 'dashboard_user' })).toString('base64url');
    const result = await invoke({ headers: { authorization: `Bearer ${header}.${payload}.` } });
    expect(result.status).toBe(401);
    expect(result.next).toBe(false);
  });
});

describe('scoped keys stay inside their method and path scope', () => {
  it('refuses the reports key on a non-GET method', async () => {
    const result = await invoke({
      baseUrl: '/reports',
      method: 'DELETE',
      headers: { 'x-reports-read-key': REPORTS_KEY },
    });
    expect(result.status).toBe(403);
    expect(result.next).toBe(false);
  });

  it('refuses the reports key outside reports', async () => {
    const result = await invoke({
      baseUrl: '/tasks',
      headers: { 'x-reports-read-key': REPORTS_KEY },
    });
    expect(result.status).toBe(403);
  });

  it('refuses the reports key on the retired journal paths', async () => {
    // journal:read left the reports_reader grant with the Journal plugin
    // (P1.3 ruling A7): the path family that used to be in-scope for this key
    // now fails closed like any other out-of-scope path.
    const result = await invoke({
      baseUrl: '/journal',
      headers: { 'x-reports-read-key': REPORTS_KEY },
    });
    expect(result.status).toBe(403);
    expect(result.next).toBe(false);
  });

  it('still accepts the reports key inside its own scope', async () => {
    await expect(
      invoke({ baseUrl: '/reports', path: `/${RID}`, headers: { 'x-reports-read-key': REPORTS_KEY } })
    ).resolves.toMatchObject({ next: true, userId: 'reports_reader' });
  });
});

describe('client-asserted identity is never an authority source', () => {
  // x-journal-publish-key is the retired Journal publish header (P1.3 ruling
  // A7): its middleware branch is gone, so the header must stay inert — a
  // hit here means the env-key branch grew back.
  it.each([
    'x-relayhall-role',
    'x-orchestrator-key',
    'x-user-id',
    'x-forwarded-user',
    'x-oidc-username',
    'x-journal-publish-key',
  ])('ignores %s', async header => {
    const result = await invoke({ headers: { [header]: 'dashboard_user' } });
    expect(result.next).toBe(false);
    expect(result.userId).toBeUndefined();
  });

  it('does not let a cookie-presented identity JWT authenticate any path', async () => {
    // The name is the retired Content Engine media cookie (P1.3 ruling A5):
    // its middleware branch is gone, so even a signature-valid identity token
    // in that cookie — or any cookie — must never authenticate. A failure
    // here means a cookie identity branch grew back.
    const token = jwt.sign({ userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({
      baseUrl: '/tasks',
      headers: { cookie: `nim_content_engine_media=${token}` },
    });
    expect(result.status).toBe(401);
    expect(result.next).toBe(false);
  });

  it('does not let the browser capability cookie authenticate the API', async () => {
    const token = jwt.sign({ scope: 'browser-access' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({
      baseUrl: '/tasks',
      headers: { cookie: `nim_browser_access=${token}` },
    });
    expect(result.status).toBe(401);
    expect(result.next).toBe(false);
  });
});

describe('a capability token is not an API identity', () => {
  // The original suite only presented this token as a cookie, which passed
  // while the Bearer transport authenticated the entire API. Independent
  // review caught the gap; both transports are pinned here.
  it('rejects the browser capability token presented as a Bearer', async () => {
    const token = jwt.sign({ scope: 'browser-access' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({
      baseUrl: '/tasks',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(401);
    expect(result.next).toBe(false);
    expect(result.userId).toBeUndefined();
  });

  it('rejects any scoped token, not just this one scope', async () => {
    const token = jwt.sign({ scope: 'some-other-capability' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({ baseUrl: '/tasks', headers: { authorization: `Bearer ${token}` } });
    expect(result.status).toBe(401);
  });

  it('rejects a signature-valid token that names no identity', async () => {
    const token = jwt.sign({}, SECRET, { expiresIn: '1h' });
    const result = await invoke({ baseUrl: '/tasks', headers: { authorization: `Bearer ${token}` } });
    expect(result.status).toBe(401);
    expect(result.next).toBe(false);
  });

  it('rejects a non-string userId', async () => {
    const token = jwt.sign({ userId: 42 }, SECRET, { expiresIn: '1h' });
    const result = await invoke({ baseUrl: '/tasks', headers: { authorization: `Bearer ${token}` } });
    expect(result.status).toBe(401);
  });

  it('still accepts a genuine dashboard identity', async () => {
    const token = jwt.sign({ userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
    const result = await invoke({ baseUrl: '/tasks', headers: { authorization: `Bearer ${token}` } });
    expect(result.next).toBe(true);
    expect(result.userId).toBe('dashboard_user');
  });
});

describe('capabilities are not fungible with each other', () => {
  const { verifyDashboardToken } = require('../utils/dashboardToken');

  it.each(['browser-access', 'some-other-capability', 'anything-else'])(
    'refuses a %s token as an identity',
    scope => {
      const token = jwt.sign({ scope, userId: 'dashboard_user' }, SECRET, { expiresIn: '1h' });
      expect(() => verifyDashboardToken(token)).toThrow();
    }
  );

  it('refuses a non-string scope claim too', () => {
    for (const scope of [42, ['a'], { a: 1 }, null]) {
      const token = jwt.sign({ scope, userId: 'dashboard_user' } as object, SECRET, { expiresIn: '1h' });
      expect(() => verifyDashboardToken(token)).toThrow();
    }
  });

  it('accepts a plain identity', () => {
    const token = jwt.sign({ userId: 'hermes_task_agent' }, SECRET, { expiresIn: '1h' });
    expect(verifyDashboardToken(token)).toEqual({ userId: 'hermes_task_agent' });
  });
});
