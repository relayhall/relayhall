/**
 * RH-P5.SSO.W4 candidate C · the deprovision-detected flag is SURFACED IN THE
 * ACCESS MANAGER (AZ-30; AZ-A4 clause 2 "in addition to raising the flag").
 *
 * The remediation queue is the Access manager's list of identities that need
 * a human. A directory-provisioned Account whose Identity provider signalled
 * deprovision joins it with the signal named, so the flag candidate B raised
 * on the provenance row is a thing an operator SEES rather than a column.
 * The REAL route over an armed pool; the assertion reads the SQL issued and
 * the entry rendered.
 */
import express from 'express';
import http from 'http';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import principalsRouter from '../routes/principals';

let server: http.Server;
let baseUrl: string;
let statements: string[];

const FLAGGED = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 'human', handle: 'ada', display_name: 'Ada', status: 'disabled',
  role: 'user', purpose: null, legacy_identity: false, parent_principal_id: null, created_at: new Date('2026-09-01T10:00:00Z'),
  deprovision_signal: 'removed', deprovisioned_at: new Date('2026-09-02T10:00:00Z'), identity_provider_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  live_credentials: 1,
};
const LEGACY = {
  id: '11111111-1111-4111-8111-111111111111', kind: 'service', handle: 'old-bot', display_name: null, status: 'active',
  role: 'agent', purpose: 'LEGACY - pending owner review', legacy_identity: true, parent_principal_id: null,
  created_at: new Date('2026-01-01T00:00:00Z'), deprovision_signal: null, deprovisioned_at: null, identity_provider_id: null,
  live_credentials: 0,
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: 'p-root', handle: 'owner', kind: 'human', role: 'orchestrator' };
    (req as any).scopes = ['root'];
    (req as any).authMethod = 'session';
    next();
  });
  app.use('/principals', principalsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  statements = [];
  (pool.query as jest.Mock).mockImplementation(async (text: string) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    statements.push(sql);
    if (sql.includes('FROM principals p') && sql.includes('live_credentials')) return { rows: [LEGACY, FLAGGED] };
    throw new Error(`unexpected sql: ${sql.slice(0, 100)}`);
  });
});

describe('the remediation queue carries the deprovision-detected flag', () => {
  it('lists the flagged Account with its signal, its instant and a reason naming AZ-A4 clause 2', async () => {
    const response = await fetch(`${baseUrl}/principals/remediation-queue`);
    expect(response.status).toBe(200);
    const body = await response.json() as { queue: Array<Record<string, unknown>> };
    const entry = body.queue.find((e) => e.handle === 'ada');
    expect(entry).toBeDefined();
    expect(entry!.deprovisionSignal).toBe('removed');
    expect(entry!.deprovisionedAt).toBe('2026-09-02T10:00:00.000Z');
    expect(entry!.identityProviderId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(String(entry!.reason)).toMatch(/deprovision detected by the directory \(removed\)/);
    expect(String(entry!.reason)).toMatch(/AZ-A4 clause 2/);
    expect(entry!.status).toBe('disabled');
  });

  it('asks the provenance row in the QUERY: the flag is a WHERE arm, not a post-filter', async () => {
    await fetch(`${baseUrl}/principals/remediation-queue`);
    const sql = statements.find((s) => s.includes('live_credentials'))!;
    expect(sql).toContain('LEFT JOIN directory_provisioned_accounts d ON d.account_principal_id = p.id');
    expect(sql).toContain('OR d.deprovision_signal IS NOT NULL');
  });

  it('CONTROL: the legacy arms still read as before, unflagged', async () => {
    const response = await fetch(`${baseUrl}/principals/remediation-queue`);
    const body = await response.json() as { queue: Array<Record<string, unknown>> };
    const legacy = body.queue.find((e) => e.handle === 'old-bot')!;
    expect(legacy.deprovisionSignal).toBeNull();
    expect(String(legacy.reason)).toMatch(/legacy_identity/);
  });
});
