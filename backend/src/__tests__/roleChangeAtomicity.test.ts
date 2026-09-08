/**
 * THE ROLE CHANGE AND ITS LEDGER ROW COMMIT TOGETHER (review verdict
 * `2c284891` BLOCKING 2; owner ruling `60307311` §1.2).
 *
 * WHY A SECOND SUITE. `roleChangeAct.test.ts` doubles `PrincipalService` so it
 * can control the directory, which is right for what it measures — WHO may act
 * and WHAT they may assign — and is exactly why it could not catch this defect:
 * with the service doubled there is no UPDATE and no connection to observe, so
 * the all-green audit path is the only path it can see. The reviewer said so.
 *
 * Here the service and the audit writer are the PRODUCTION ones and the
 * database is a RECORDING double, so the question this suite asks is the one
 * the finding was about: which connection did the UPDATE go down, did the audit
 * row go down the same one, and what survives when the ledger rejects it.
 *
 * The defect it pins: before the repair, `updatePrincipal` was a standalone
 * autocommit UPDATE and the audit insert followed on its own connection — so a
 * ledger that rejected left the role CHANGED and answered 500. The caller was
 * told the act failed while it had happened, and no ledger row recorded it.
 */
import express from 'express';
import type { AddressInfo } from 'net';

process.env.JWT_SECRET = 'role-atomicity-suite-secret';
process.env.RELAYHALL_SESSIONS = 'on';

const ADMIN = {
  id: '11111111-1111-4111-8111-111111111111', handle: 'ada', kind: 'human',
  status: 'active', role: 'admin', parent_principal_id: null, legacy_identity: false,
  display_name: 'Ada', metadata: {},
};
const TARGET = {
  id: '44444444-4444-4444-8444-444444444444', handle: 'tessa', kind: 'human',
  status: 'active', role: 'viewer', parent_principal_id: null, legacy_identity: false,
  display_name: 'Tessa', metadata: {},
};
const ROWS = [ADMIN, TARGET];

const db = {
  /** Every statement, with the connection it went down. */
  log: [] as Array<{ sql: string; params: unknown[]; on: 'pool' | 'client' }>,
  /** When true the audit INSERT rejects, as a ledger under a CHECK would. */
  ledgerRejects: false,
  /** The role the UPDATE last wrote, so a rollback can be told from a commit. */
  written: null as string | null,
};

function answer(sql: string, params: unknown[]): { rows: any[]; rowCount: number } {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) return { rows: [], rowCount: 0 };
  if (text.startsWith('SELECT * FROM principals WHERE id')) {
    const row = ROWS.find((r) => r.id === params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (text.startsWith('SELECT * FROM principals WHERE handle')) {
    const row = ROWS.find((r) => r.handle === params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (text.startsWith('UPDATE principals SET')) {
    db.written = String(params[1]);
    return { rows: [{ ...TARGET, role: params[1] }], rowCount: 1 };
  }
  if (text.startsWith('INSERT INTO audit_events')) {
    if (db.ledgerRejects) throw new Error('new row violates check constraint');
    return {
      rows: [{
        id: 'audit-1', occurred_at: new Date(), action: params[0], outcome: params[1],
        actor_principal_id: params[2], actor_handle: params[3], auth_method: params[4],
        credential_id: params[5], resource_type: params[6], resource_id: params[7], metadata: {},
      }],
      rowCount: 1,
    };
  }
  return { rows: [], rowCount: 0 };
}

const client = {
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    db.log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params, on: 'client' });
    return answer(String(sql), params);
  }),
  release: jest.fn(),
};

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      db.log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params, on: 'pool' });
      return answer(String(sql), params);
    }),
    connect: jest.fn(async () => client),
  },
  BOOT_CHECK_MODE: false,
}));

jest.mock('../services/LoginSessionService', () => ({
  SESSION_COOKIE_NAME: 'relayhall_session',
  sessionAbsoluteMs: () => 3_600_000,
  loginSessionService: {
    resolve: jest.fn(async (token: string) => (
      token === 'session-admin'
        ? { sessionId: token, principalId: ADMIN.id, roleSnapshot: null }
        : undefined)),
    touch: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authMiddleware } = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sharedAuthorizationMiddleware } = require('../middleware/sharedAuthorization');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const principalsRouter = require('../routes/principals').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { principalService } = require('../services/PrincipalService');

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/principals', authMiddleware, sharedAuthorizationMiddleware, principalsRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => {
  db.log.length = 0;
  db.ledgerRejects = false;
  db.written = null;
  // The production service caches reads; a row cached by the previous case
  // would answer the next one and hide the statement this suite is counting.
  principalService.invalidateHandles([ADMIN.handle, TARGET.handle]);
  principalService.invalidatePrincipals([ADMIN.id, TARGET.id]);
});

async function changeRole(role: string) {
  const response = await fetch(`${base}/principals/${TARGET.id}/role`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'relayhall_session=session-admin' },
    body: JSON.stringify({ role }),
  });
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: response.status, body };
}

/** The statements that went down the transactional connection, as a shape. */
const shapeOnClient = () => db.log
  .filter((entry) => entry.on === 'client')
  .map((entry) => {
    if (/^BEGIN$/i.test(entry.sql)) return 'BEGIN';
    if (/^COMMIT$/i.test(entry.sql)) return 'COMMIT';
    if (/^ROLLBACK$/i.test(entry.sql)) return 'ROLLBACK';
    if (entry.sql.startsWith('UPDATE principals SET')) return 'UPDATE';
    if (entry.sql.startsWith('INSERT INTO audit_events')) return 'AUDIT';
    return entry.sql.slice(0, 24);
  });

describe('the happy path', () => {
  it('the UPDATE and the audit row go down ONE connection, inside one transaction', async () => {
    const { status } = await changeRole('editor');
    expect(status).toBe(200);
    expect(shapeOnClient()).toEqual(['BEGIN', 'UPDATE', 'AUDIT', 'COMMIT']);
  });

  it('neither write escapes to the pool', async () => {
    await changeRole('editor');
    const escaped = db.log.filter((entry) => entry.on === 'pool' && (
      entry.sql.startsWith('UPDATE principals SET')
      || entry.sql.startsWith('INSERT INTO audit_events')));
    expect(escaped).toEqual([]);
  });

  it('the ledger row carries the before and after roles from the same statement pair', async () => {
    await changeRole('editor');
    const audit = db.log.find((entry) => entry.sql.startsWith('INSERT INTO audit_events'))!;
    expect(audit.params[0]).toBe('principal.role.changed');
    expect(audit.params[1]).toBe('success');
    expect(JSON.parse(String(audit.params[8]))).toMatchObject({ before: 'viewer', after: 'editor' });
  });
});

describe('when the ledger rejects the row', () => {
  it('the transaction ROLLS BACK and never commits', async () => {
    db.ledgerRejects = true;
    const { status, body } = await changeRole('editor');
    expect(status).toBe(500);
    expect(body.code).toBe('ROLE_CHANGE_FAILED');
    const shape = shapeOnClient();
    expect(shape).toContain('ROLLBACK');
    expect(shape).not.toContain('COMMIT');
  });

  it('...and the caller is told it failed, which is now TRUE', async () => {
    // The defect this pins: before the repair the UPDATE had already
    // autocommitted by the time the audit insert rejected, so this same 500 was
    // a lie — the role HAD changed, and no ledger row said so.
    db.ledgerRejects = true;
    await changeRole('editor');
    const updates = db.log.filter((entry) => entry.sql.startsWith('UPDATE principals SET'));
    expect(updates).toHaveLength(1);
    expect(updates[0].on).toBe('client');
    // The one statement that could have made it durable never ran.
    expect(shapeOnClient().filter((step) => step === 'COMMIT')).toEqual([]);
  });

  it('the rolled-back role is NOT what the read caches answer', async () => {
    // Publishing it would advertise a change that never committed, for a whole
    // cache TTL — which is why `updatePrincipal` writes no cache on the
    // transactional path and the route publishes only after COMMIT.
    //
    // The instrument is the VALUE, not whether a query ran: the route's own
    // target lookup legitimately cached the pre-change row a moment earlier, so
    // "it re-reads" would be measuring the wrong thing, and this case said so
    // the first time it ran.
    db.ledgerRejects = true;
    await changeRole('editor');
    expect((await principalService.getPrincipalById(TARGET.id)).role).toBe('viewer');
  });

  it('...while a COMMITTED change IS published — the control for the pair', async () => {
    // Without this, the case above would pass just as happily against a route
    // that never published anything at all.
    const { status } = await changeRole('editor');
    expect(status).toBe(200);
    expect((await principalService.getPrincipalById(TARGET.id)).role).toBe('editor');
  });
});

describe('a REFUSAL keeps its fire-and-forget ledger write', () => {
  it('a ledger outage does not turn a refusal into a 500', async () => {
    // The asymmetry is deliberate and is the safe direction: a refusal changes
    // nothing, so the caller must be refused whether or not the ledger is up.
    db.ledgerRejects = true;
    const response = await fetch(`${base}/principals/${TARGET.id}/role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'relayhall_session=session-admin' },
      body: JSON.stringify({ role: 'root' }),
    });
    expect(response.status).toBe(400);
    expect(db.log.some((entry) => entry.sql.startsWith('UPDATE principals SET'))).toBe(false);
  });
});
