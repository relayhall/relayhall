/**
 * RH-P5.SSO.W4 candidate C · a refused federated login LANDS ON THE LOGIN
 * PAGE (card `a07f3277`).
 *
 * The callback is reached by top-level navigation from the
 * Identity provider. Before this candidate every refusal answered JSON, so a person
 * was parked on raw callback JSON with no way on — the owner met it. Now a
 * browser (an `Accept` preferring HTML) is redirected to the login page with
 * the refusal's NAMED code, and everything else keeps the JSON envelope.
 *
 * The REAL router is mounted; only the authentication service is doubled,
 * and only to throw the typed refusals the router is being asked to render.
 * Nothing about the refusal's text reaches the redirect — the code does, from
 * a fixed vocabulary, URL-encoded.
 */
import express from 'express';
import http from 'http';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

const completeAuthentication = jest.fn();
jest.mock('../services/identity/SsoAuthenticationService', () => {
  const actual = jest.requireActual('../services/identity/SsoAuthenticationService');
  return {
    ...actual,
    ssoAuthenticationService: {
      startAuthentication: jest.fn(),
      completeAuthentication: (...args: unknown[]) => completeAuthentication(...args),
    },
  };
});

import { createSsoRouter } from '../routes/sso';
import { SsoAuthenticationError } from '../services/identity/SsoAuthenticationService';
import { IdTokenError } from '../services/identity/idTokenValidation';

let server: http.Server;
let baseUrl: string;
const issueBrowserAccessCookie = jest.fn();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/auth/sso', createSsoRouter({ issueBrowserAccessCookie }));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  completeAuthentication.mockReset();
  issueBrowserAccessCookie.mockReset();
});

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

async function callback(accept: string) {
  return fetch(`${baseUrl}/auth/sso/callback?state=s&code=c`, {
    headers: { accept, cookie: 'rh_sso_state=x' },
    redirect: 'manual',
  });
}

describe('a person is sent to the login page with the named refusal', () => {
  it('redirects a browser to the login page carrying ONLY the code', async () => {
    completeAuthentication.mockRejectedValue(new SsoAuthenticationError('SSO_LOGIN_GROUP_REFUSED', 'this account is not a member of a group permitted to sign in at this Identity provider'));
    const response = await callback(BROWSER_ACCEPT);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dashboard/?sso_refused=SSO_LOGIN_GROUP_REFUSED');
    // No login-session cookie on a refusal — only the state cookie is cleared.
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('relayhall_session=');
    expect(setCookie).toContain('rh_sso_state=;');
    expect(issueBrowserAccessCookie).not.toHaveBeenCalled();
  });

  it('never carries the refusal TEXT, only its code, URL-encoded', async () => {
    completeAuthentication.mockRejectedValue(new SsoAuthenticationError('SSO_ACCOUNT_UNAVAILABLE', 'no directory expectation names this subject at this Identity provider'));
    const response = await callback(BROWSER_ACCEPT);
    const location = response.headers.get('location') ?? '';
    expect(location).toBe('/dashboard/?sso_refused=SSO_ACCOUNT_UNAVAILABLE');
    expect(location).not.toContain('expectation');
  });

  it('renders every typed refusal family the same way (an ID-token refusal is a code too)', async () => {
    completeAuthentication.mockRejectedValue(new IdTokenError('SIGNATURE_INVALID', 'the signature did not verify'));
    const response = await callback(BROWSER_ACCEPT);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dashboard/?sso_refused=SSO_ID_TOKEN_REFUSED');
  });
});

describe('everything that is not a person keeps the JSON envelope', () => {
  it('a fetch (no HTML preference) gets the JSON refusal with the same code', async () => {
    completeAuthentication.mockRejectedValue(new SsoAuthenticationError('SSO_LOGIN_GROUP_REFUSED', 'x'));
    const response = await callback('*/*');
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body.code).toBe('SSO_LOGIN_GROUP_REFUSED');
    expect(body.message).toBe('this account is not a member of a group permitted to sign in at this Identity provider');
  });

  it('an untyped failure is NEVER redirected, even for a browser: the 500 envelope stands', async () => {
    completeAuthentication.mockRejectedValue(new Error('the database fell over'));
    const response = await callback(BROWSER_ACCEPT);
    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body.code).toBe('SSO_CALLBACK_FAILED');
    expect(JSON.stringify(body)).not.toContain('fell over');
  });

  it('an admitted login is still a redirect to the return target with the login-session cookie', async () => {
    completeAuthentication.mockResolvedValue({
      sessionToken: 'tok', sessionId: 's1', principalId: 'p1', expiresAt: new Date(Date.now() + 60_000),
      identityProviderId: 'i1', identityLinkId: 'l1', returnTo: '/', groupClaim: { verdict: 'claim_absent', values: [] },
      boundGroupRefs: [], traversedEntryPoint: 'SsoAuthenticationService.completeAuthentication',
    });
    const response = await callback(BROWSER_ACCEPT);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('set-cookie') ?? '').toContain('relayhall_session=tok');
    expect(issueBrowserAccessCookie).toHaveBeenCalledWith(expect.anything(), 'p1');
  });
});
