/**
 * principalsAgentMint.test.ts — RH-P3.AZ-S3 round-10 (review 70aca6f8 B1):
 * POST /principals with kind=agent is the S3 T11 defense (scoping note 1).
 * It must refuse 422 AGENT_MINT_ONLY, create NO principal row, and write a
 * durable denied credential.mint audit (§5.2 rule 8).
 */
import express from 'express';
import http from 'http';

const db = {
  queries: [] as Array<{ text: string; params?: unknown[] }>,
};
jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => { db.queries.push({ text, params }); return { rows: [] }; }),
    connect: jest.fn(async () => ({
      query: jest.fn(async (text: string, params?: unknown[]) => { db.queries.push({ text, params }); return { rows: [] }; }),
      release: jest.fn(),
    })),
  },
}));
const auditRecord = jest.fn(async () => ({}));
jest.mock('../services/AuditService', () => ({ auditService: { record: auditRecord } }));

import { auditService } from '../services/AuditService';
import principalsRouter from '../routes/principals';

let server: http.Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', handle: 'owner' };
    (req as any).userId = 'owner';
    (req as any).scopes = ['root'];
    next();
  });
  app.use('/principals', principalsRouter);
  server = app.listen(0, () => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => { jest.clearAllMocks(); db.queries.length = 0; });

function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('POST /principals kind=agent (T11 defense, review 70aca6f8 B1)', () => {
  it('refuses 422 AGENT_MINT_ONLY, creates no principal row, and audits the denial', async () => {
    const { status, json } = await post('/principals', { handle: 'sneaky-agent', kind: 'agent' });
    expect(status).toBe(422);
    expect(json.code).toBe('AGENT_MINT_ONLY');
    // No principal INSERT happened.
    expect(db.queries.some((q) => /INSERT INTO principals/.test(q.text))).toBe(false);
    // The denial is durably audited with the reason and the requested handle.
    const denial = (auditService.record as jest.Mock).mock.calls.find(
      (call) => call[0].action === 'credential.mint' && call[0].outcome === 'denied'
        && call[0].metadata?.refusal === 'AGENT_MINT_ONLY',
    );
    expect(denial).toBeDefined();
    expect(denial![0].metadata.requestedHandle).toBe('sneaky-agent');
  });
});
