/**
 * T-SS18 · login-path authority parity — the W1 arm.
 *
 * Threat T-SS18 is "one Account carrying different authority depending on
 * which door it came through". The annex assigns the assertion to W1 and W3:
 * one Account's effective scopes byte-identical through the password path
 * and, once W2 lands, the SSO path.
 *
 * W1 has two doors, so the assertion is checkable NOW: the same Account, at
 * the same moment, resolved through the login-session cookie and through the
 * dashboard token, must carry byte-identical `req.scopes`. It holds because
 * SS-W1 mints `role_snapshot` NULL, so the session door falls through to
 * `principals.role` exactly as the token door does — the same reason W2's SSO
 * door will agree with both. W2 extends this file with its third door rather
 * than writing a third parity story.
 *
 * The negative control matters as much as the parity: a session that DOES
 * carry a snapshot diverges, which is precisely the mechanism SS-9 withdrew.
 */
import jwt from 'jsonwebtoken';

const SECRET = 'w1-parity-secret';
const PRINCIPAL_ID = '88888888-8888-4888-8888-888888888888';
const SESSION_TOKEN = 'w1-parity-session';

const queryMock = jest.fn();
jest.mock('../db/connection', () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

/** One Account, one role. Both doors must land on exactly this authority. */
function principalRow(role: string) {
  return {
    id: PRINCIPAL_ID,
    kind: 'human',
    handle: 'ada',
    display_name: 'Ada',
    status: 'active',
    role,
    source_tag: null,
    harness: null,
    personality_id: null,
    parent_principal_id: null,
    legacy_identity: false,
    purpose: null,
    own_expression: null,
    bound_task_id: null,
    last_seen_at: null,
    metadata: {},
  };
}

function scriptBoth(role: string, roleSnapshot: string | null) {
  queryMock.mockImplementation((sql: string) => {
    const text = String(sql);
    if (text.includes('FROM auth_sessions s')) {
      return Promise.resolve({
        rows: [{ session_id: 'sess-parity', role_snapshot: roleSnapshot, principal_id: PRINCIPAL_ID }],
      });
    }
    if (text.startsWith('UPDATE auth_sessions')) return Promise.resolve({ rows: [], rowCount: 1 });
    if (text.includes('FROM principals WHERE id')) return Promise.resolve({ rows: [principalRow(role)] });
    if (text.includes('FROM principals') && text.includes('handle')) return Promise.resolve({ rows: [principalRow(role)] });
    return Promise.resolve({ rows: [] });
  });
}

async function scopesThrough(headers: Record<string, string>): Promise<string[] | null | undefined> {
  const { authMiddleware } = await import('../middleware/auth');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = { baseUrl: '', path: '/tasks', method: 'GET', headers };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { status: () => res, json: () => res, setHeader: () => res };
  await authMiddleware(req, res, () => undefined);
  return req.scopes;
}

const dashboardDoor = () => ({
  authorization: `Bearer ${(jwt.sign as any)(
    { v: 2, sub: PRINCIPAL_ID, handle: 'ada', kind: 'human' }, SECRET, { expiresIn: '1h' },
  )}`,
});
const sessionDoor = () => ({ cookie: `relayhall_session=${SESSION_TOKEN}` });

beforeEach(() => {
  jest.resetModules();
  queryMock.mockReset();
  process.env.JWT_SECRET = SECRET;
  process.env.RELAYHALL_SESSIONS = 'on';
});

afterEach(() => {
  delete process.env.RELAYHALL_SESSIONS;
});

describe('one Account, two doors, one authority', () => {
  it.each(['orchestrator', 'operator', 'editor', 'viewer'])(
    'a %s Account carries byte-identical scopes through both doors',
    async (role) => {
      scriptBoth(role, null);
      const throughToken = await scopesThrough(dashboardDoor());
      const throughSession = await scopesThrough(sessionDoor());
      expect(throughSession).toEqual(throughToken);
      // Non-vacuity: an authority set that is empty on both sides would
      // satisfy equality while proving nothing about the Account's role.
      expect(Array.isArray(throughToken) && throughToken.length > 0).toBe(true);
      expect(JSON.stringify(throughSession)).toBe(JSON.stringify(throughToken));
    },
  );

  it('the doors DO diverge when a session carries a role snapshot — the withdrawn mechanism', async () => {
    // The negative control. If this ever passes as "equal", the parity test
    // above has stopped depending on `role_snapshot` being NULL and would
    // keep passing while the SS-9 hole was reopened.
    scriptBoth('orchestrator', 'viewer');
    const throughToken = await scopesThrough(dashboardDoor());
    const throughSession = await scopesThrough(sessionDoor());
    expect(throughSession).not.toEqual(throughToken);
  });
});
