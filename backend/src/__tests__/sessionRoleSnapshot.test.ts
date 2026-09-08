/**
 * SS-W1 · `auth_sessions.role_snapshot` — BOTH behaviours, pinned.
 *
 * Annex `e6dcadb9` §11 W1: "both `role_snapshot` behaviours pinned with red
 * proofs, because they differ and v2 stated them backwards — a NULL snapshot
 * falls through to `principals.role`, while an empty or unknown snapshot
 * string yields []".
 *
 * They are pinned HERE, at the middleware seam, not only on the pure
 * functions: what matters is the SCOPE SET a request ends up carrying, and
 * that is produced by `attachSessionPrincipal` feeding `resolveActorRole`
 * into `scopesForRole`. A pure-function test would keep passing if the
 * middleware stopped consulting either of them.
 *
 * These are the named red-proof targets (see `backend/scripts/red-proof.sh`):
 *   - mutate `resolveActorRole`'s presence test to truthiness → the NULL arm
 *     goes red (an orchestrator Account would keep root through a session
 *     that carries no snapshot, which is the mechanism SS-9 withdrew)
 *   - mutate `scopesForRole`'s fail-closed tail to return MINTABLE_SCOPES →
 *     the empty/unknown arm goes red
 */
import crypto from 'crypto';
import { ROOT_SCOPE } from '../utils/scopeMap';

const SECRET = 'w1-role-snapshot-secret';
const PRINCIPAL_ID = '55555555-5555-4555-8555-555555555555';
const SESSION_TOKEN = 'w1-session-token';

const queryMock = jest.fn();
jest.mock('../db/connection', () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

beforeEach(() => {
  jest.resetModules();
  queryMock.mockReset();
  process.env.JWT_SECRET = SECRET;
  process.env.RELAYHALL_SESSIONS = 'on';
});

afterEach(() => {
  delete process.env.RELAYHALL_SESSIONS;
});

/** The Account is an ORCHESTRATOR: `principals.role` alone resolves to root. */
function principalRow() {
  return {
    id: PRINCIPAL_ID,
    kind: 'human',
    handle: 'ada',
    display_name: 'Ada',
    status: 'active',
    role: 'orchestrator',
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

function scriptSession(roleSnapshot: string | null) {
  queryMock.mockImplementation((sql: string) => {
    const text = String(sql);
    if (text.includes('FROM auth_sessions s')) {
      return Promise.resolve({
        rows: [{ session_id: 'sess-w1', role_snapshot: roleSnapshot, principal_id: PRINCIPAL_ID }],
      });
    }
    if (text.startsWith('UPDATE auth_sessions')) return Promise.resolve({ rows: [], rowCount: 1 });
    if (text.includes('FROM principals WHERE id')) return Promise.resolve({ rows: [principalRow()] });
    return Promise.resolve({ rows: [] });
  });
}

interface SessionInvocation { next: boolean; userId?: string; scopes?: string[] | null; sessionRole?: string | null }

async function invokeWithSession(): Promise<SessionInvocation> {
  const { authMiddleware } = await import('../middleware/auth');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = { baseUrl: '', path: '/tasks', method: 'GET', headers: { cookie: `relayhall_session=${SESSION_TOKEN}` } };
  let next = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { status: () => res, json: () => res, setHeader: () => res };
  await authMiddleware(req, res, () => { next = true; });
  return { next, userId: req.userId, scopes: req.scopes, sessionRole: req.sessionRole };
}

describe('role_snapshot NULL — falls through to principals.role', () => {
  it('gives the orchestrator Account its own root ceiling', async () => {
    scriptSession(null);
    const result = await invokeWithSession();
    expect(result.next).toBe(true);
    expect(result.userId).toBe('ada');
    expect(result.sessionRole).toBeNull();
    // The Account's OWN role decided this, not the session.
    expect(result.scopes).toEqual([ROOT_SCOPE]);
  });

  it('is what SS-W1 mints: the mint statement never names the column', async () => {
    // Structural, not behavioural: the mint function has no snapshot
    // parameter, so the only way a snapshot could appear is if the INSERT
    // named the column. Assert on the statement the service actually runs.
    queryMock.mockResolvedValue({ rows: [{ id: 'new-session' }] });
    const { loginSessionService } = await import('../services/LoginSessionService');
    await loginSessionService.mint({ principalId: PRINCIPAL_ID });
    const insert = queryMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO auth_sessions'));
    expect(insert).toBeDefined();
    expect(String(insert?.[0])).not.toContain('role_snapshot');
  });
});

describe('role_snapshot empty or unknown — fails closed to []', () => {
  it('yields no scopes for an empty string, NOT the Account role', async () => {
    scriptSession('');
    const result = await invokeWithSession();
    expect(result.next).toBe(true);
    expect(result.sessionRole).toBe('');
    expect(result.scopes).toEqual([]);
  });

  it('yields no scopes for an unknown role string', async () => {
    scriptSession('archduke');
    const result = await invokeWithSession();
    expect(result.next).toBe(true);
    expect(result.sessionRole).toBe('archduke');
    expect(result.scopes).toEqual([]);
  });

  it('the two behaviours are genuinely different — the point of pinning both', async () => {
    scriptSession(null);
    const withNull = await invokeWithSession();
    queryMock.mockReset();
    scriptSession('');
    const withEmpty = await invokeWithSession();
    expect(withNull.scopes).not.toEqual(withEmpty.scopes);
  });
});

describe('a session token is a COOKIE and never a bearer credential (AZ-18/A17.1)', () => {
  // The design's claim is that a login session can never become an
  // `Authorization: Bearer` value. It holds structurally — an opaque session
  // token is not a JWT, so `verifyDashboardToken` rejects it — but "holds
  // structurally" is exactly the kind of reasoning that stops being true
  // after a refactor, so it is checked rather than argued.
  it('refuses the raw session token presented as a bearer', async () => {
    scriptSession(null);
    const { authMiddleware } = await import('../middleware/auth');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = {
      baseUrl: '', path: '/tasks', method: 'GET',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    };
    let next = false;
    let status = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = { status: (code: number) => { status = code; return res; }, json: () => res, setHeader: () => res };
    await authMiddleware(req, res, () => { next = true; });
    expect(next).toBe(false);
    expect(status).toBe(401);
    expect(req.userId).toBeUndefined();
    expect(req.scopes).toBeUndefined();
  });

  it('the same token in the COOKIE authenticates — so the refusal is about the vehicle, not the value', async () => {
    // The negative control. Without it, a middleware that refused everything
    // would satisfy the assertion above while proving nothing.
    scriptSession(null);
    const result = await invokeWithSession();
    expect(result.next).toBe(true);
    expect(result.userId).toBe('ada');
  });
});

describe('the session token is hashed, never queried raw', () => {
  it('sends only the digest to the database', async () => {
    scriptSession(null);
    await invokeWithSession();
    const lookup = queryMock.mock.calls.find((call) => String(call[0]).includes('FROM auth_sessions s'));
    const expected = crypto.createHash('sha256').update(SESSION_TOKEN).digest('hex');
    expect(lookup?.[1]?.[0]).toBe(expected);
    expect(JSON.stringify(lookup?.[1])).not.toContain(SESSION_TOKEN);
  });
});
