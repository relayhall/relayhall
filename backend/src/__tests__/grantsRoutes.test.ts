/**
 * /grants route surface (RH-P2.3): strict allowlists, the owner-plane scope
 * posture (every /grants method → root; §2.9), and the secret-safe log sink.
 */
import express from 'express';
import http from 'http';
import { requiredScopeFor } from '../utils/scopeMap';

jest.mock('../services/GrantService', () => {
  const actual = jest.requireActual('../services/GrantService');
  return {
    ...actual,
    grantService: {
      list: jest.fn(),
      create: jest.fn(),
      remove: jest.fn(),
      grantsFor: jest.fn(),
    },
  };
});

// Card ff410dc4 (E407 item 1): the list read goes through the paged list
// service; its query parser stays the real one, so these route mechanics
// still see the real validation.
jest.mock('../services/GrantListService', () => {
  const actual = jest.requireActual('../services/GrantListService');
  return { ...actual, grantListService: { page: jest.fn() } };
});

import { grantService } from '../services/GrantService';
import { grantListService } from '../services/GrantListService';
import grantsRouter from '../routes/grants';

let server: http.Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/grants', grantsRouter);
  server = app.listen(0, () => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => jest.clearAllMocks());

function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('scope posture (§2.9: grant mutation out of the agent plane)', () => {
  it('every /grants method is owner-plane (root)', () => {
    expect(requiredScopeFor('GET', '/grants')).toBe('root');
    expect(requiredScopeFor('POST', '/grants')).toBe('root');
    expect(requiredScopeFor('DELETE', '/grants/abc')).toBe('root');
  });
});

describe('route mechanics', () => {
  it('GET lists and passes filters through', async () => {
    (grantListService.page as jest.Mock).mockResolvedValue({ grants: [], pagination: {} });
    const granteeId = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
    const { status } = await call('GET', `/grants?granteeId=${granteeId}&resourceType=task`);
    expect(status).toBe(200);
    expect(grantListService.page).toHaveBeenCalledWith(expect.objectContaining({
      granteeId, resourceType: 'task', limit: null, made: 'all', sort: 'created',
    }));
  });

  it('GET refuses a malformed filter before any read (card ff410dc4)', async () => {
    const { status, text } = await call('GET', '/grants?granteeId=x');
    expect(status).toBe(400);
    expect(text).toContain('INVALID_QUERY_VALUE');
    expect(grantListService.page).not.toHaveBeenCalled();
  });

  it('GET rejects unknown query params', async () => {
    const { status, text } = await call('GET', '/grants?surprise=1');
    expect(status).toBe(400);
    expect(text).toContain('UNKNOWN_FIELD');
  });

  it('POST rejects unknown body fields', async () => {
    const { status, text } = await call('POST', '/grants', { granteeId: 'x', spy: true });
    expect(status).toBe(400);
    expect(text).toContain('UNKNOWN_FIELD');
    expect(grantService.create).not.toHaveBeenCalled();
  });

  it('POST maps a GrantError to its status + code', async () => {
    const { GrantError } = jest.requireActual('../services/GrantService');
    (grantService.create as jest.Mock).mockRejectedValue(new GrantError(422, 'GROUP_GRANTS_NOT_AVAILABLE', 'no groups', 'granteeType'));
    const { status, text } = await call('POST', '/grants', { granteeType: 'group', granteeId: 'x', resourceType: 'task', verb: 'read' });
    expect(status).toBe(422);
    expect(text).toContain('GROUP_GRANTS_NOT_AVAILABLE');
  });

  it('an unexpected error logs a fixed-text category only, never the raw value', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (grantListService.page as jest.Mock).mockRejectedValue(new Error('rh_live_SECRETMARKER.abc leaked cause'));
    const { status, text } = await call('GET', '/grants');
    expect(status).toBe(500);
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).not.toContain('SECRETMARKER');
    const logged = spy.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(logged).not.toContain('SECRETMARKER');
    expect(logged).toContain('[Grants API]');
    expect(logged).toContain('(Error)');
    spy.mockRestore();
  });
});
