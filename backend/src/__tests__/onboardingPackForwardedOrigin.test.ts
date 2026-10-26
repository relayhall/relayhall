/**
 * The address an onboarding pack names, for the headers the shipped nginx now
 * forwards (frontend/nginx.conf: `Host $relayhall_forwarded_host`, the Host
 * header as it arrived, port included; `X-Forwarded-Proto
 * $relayhall_forwarded_proto`, the outer proxy's https or http, else nginx's
 * own scheme), and for `RELAYHALL_PUBLIC_API_URL`, which docker-compose.yml now
 * forwards and which is EMPTY when an operator leaves it unset.
 *
 * Measured through a real Express app with `trust proxy` set as server.ts sets
 * it by default, so `req.get('host')` and `req.protocol` behave as they do in
 * the backend.
 */
import express from 'express';
import http from 'http';
import { boardEndpointFor } from '../utils/onboardingPack';

let server: http.Server;
let port = 0;
const saved = process.env.RELAYHALL_PUBLIC_API_URL;

beforeAll((done) => {
  const app = express();
  app.set('trust proxy', 1);
  app.get('/probe', (req, res) => { res.json({ endpoint: boardEndpointFor(req) }); });
  server = app.listen(0, () => {
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    done();
  });
});
afterAll((done) => { server.close(done); });
afterEach(() => {
  if (saved === undefined) delete process.env.RELAYHALL_PUBLIC_API_URL;
  else process.env.RELAYHALL_PUBLIC_API_URL = saved;
});

function probe(headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/probe', headers }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve(JSON.parse(text).endpoint));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('derived from the request (no declared public URL)', () => {
  beforeEach(() => { delete process.env.RELAYHALL_PUBLIC_API_URL; });

  it('a direct install on its frontend port keeps the port', async () => {
    expect(await probe({ Host: 'localhost:8082', 'X-Forwarded-Proto': 'http' })).toBe('http://localhost:8082/api');
  });

  it('behind a TLS proxy on its own port: the scheme and the port of the browser origin', async () => {
    expect(await probe({ Host: 'board.example.test:18766', 'X-Forwarded-Proto': 'https' }))
      .toBe('https://board.example.test:18766/api');
  });

  it('an outer proxy that declares X-Forwarded-Host still wins over Host', async () => {
    expect(await probe({ Host: 'relayhall-frontend', 'X-Forwarded-Host': 'board.example.test:18766', 'X-Forwarded-Proto': 'https' }))
      .toBe('https://board.example.test:18766/api');
  });

  it('a standard https port, sent without a port, stays without one', async () => {
    expect(await probe({ Host: 'board.example.test', 'X-Forwarded-Proto': 'https' })).toBe('https://board.example.test/api');
  });
});

describe('RELAYHALL_PUBLIC_API_URL', () => {
  it('empty, as Compose forwards it when unset, is no declaration', async () => {
    process.env.RELAYHALL_PUBLIC_API_URL = '';
    expect(await probe({ Host: 'localhost:8082', 'X-Forwarded-Proto': 'http' })).toBe('http://localhost:8082/api');
  });

  it('declared, it wins over every header', async () => {
    process.env.RELAYHALL_PUBLIC_API_URL = 'https://board.example.test/api/';
    expect(await probe({ Host: 'localhost:8082', 'X-Forwarded-Proto': 'http' })).toBe('https://board.example.test/api');
  });
});
