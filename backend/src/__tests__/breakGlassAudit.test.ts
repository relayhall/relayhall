import express from 'express';
import http from 'http';

process.env.JWT_SECRET = 'p27-break-glass-test-secret';
process.env.DASHBOARD_PASSWORD_HASH = '$2b$12$local.admin.hash.for.test.only';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));
jest.mock('../services/PrincipalService', () => ({
  principalService: { getPrincipalByHandle: jest.fn() },
}));
jest.mock('../services/AuditService', () => ({
  auditService: { record: jest.fn() },
}));

import bcrypt from 'bcrypt';
import { principalService } from '../services/PrincipalService';
import { auditService } from '../services/AuditService';
import authRouter from '../routes/auth';

let server: http.Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  server = app.listen(0, '127.0.0.1', () => {
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  (principalService.getPrincipalByHandle as jest.Mock).mockResolvedValue(undefined);
  (auditService.record as jest.Mock).mockResolvedValue({ id: 'audit-1' });
});

async function login(): Promise<{ status: number; body: any; cookie: string | null }> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'local-admin-password' }),
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie'),
  };
}

describe('local administrator break-glass path', () => {
  it('mints a session without any OIDC dependency and records the invocation first', async () => {
    const result = await login();
    expect(result.status).toBe(200);
    expect(result.body.token).toEqual(expect.any(String));
    expect(result.cookie).toContain('nim_browser_access=');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.break_glass.login',
      actor: expect.objectContaining({
        handle: 'dashboard_user',
        authMethod: 'local_admin',
      }),
    }));
  });

  it('fails closed when the audit ledger is unavailable and returns no token or cookie', async () => {
    (auditService.record as jest.Mock).mockRejectedValueOnce(new Error('audit unavailable'));
    const result = await login();
    expect(result.status).toBe(503);
    expect(result.body.token).toBeUndefined();
    expect(result.cookie).toBeNull();
  });
});
