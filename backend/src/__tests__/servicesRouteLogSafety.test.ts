/**
 * Log-sink safety for the Service routes (reviews f52e44db B1 + b82cb8bd B1).
 *
 * The safety floor covers LOGS as well as responses: a secret-shaped value
 * carried by an unexpected exception (adapter payloads, connection strings,
 * descriptor bytes echoed into error messages) must never reach
 * console.error. Every new /services catch boundary is exercised with a
 * registry rejection whose name, message, stack, cause AND custom
 * properties all carry secret-shaped markers (round 2: Error.name is a
 * mutable instance string, so it is a leak channel too); a second sweep
 * throws a NON-Error object made of secret-shaped strings. The pins assert
 * no marker appears in the HTTP response or any captured log argument,
 * while the response stays the generic INTERNAL_ERROR envelope.
 */
import express from 'express';
import http from 'http';

const SECRET_MARKER = 'rh_live_SECRETMARKER.6zXq1vAbCdEfGh'; // gitleaks:allow — synthetic marker planted to PROVE logs never leak secrets

/** A hostile Error: every exception-derived string channel carries the marker. */
function hostileError(): Error {
  const e = new Error(`adapter exploded: ${SECRET_MARKER}-message`);
  e.name = `${SECRET_MARKER}-name`;
  e.stack = `${SECRET_MARKER}-stack`;
  (e as Error & { cause?: unknown }).cause = `${SECRET_MARKER}-cause`;
  (e as unknown as Record<string, unknown>).adapterPayload = `${SECRET_MARKER}-custom`;
  return e;
}

/** A hostile non-Error: plain object made of secret-shaped strings. */
function hostileNonError(): Record<string, unknown> {
  return { secret: `${SECRET_MARKER}-nonerror`, toString: () => `${SECRET_MARKER}-tostring` };
}

let rejectWith: () => unknown = hostileError;

jest.mock('../services/ServiceRegistry', () => {
  const actual = jest.requireActual('../services/ServiceRegistry');
  const reject = () => Promise.reject(rejectWith());
  return {
    ...actual,
    serviceRegistry: {
      list: jest.fn(reject),
      getByIdOrSlug: jest.fn(reject),
      register: jest.fn(reject),
      update: jest.fn(reject),
      updateOwnerPlane: jest.fn(reject),
      publishDescriptor: jest.fn(reject),
      getCurrentDescriptor: jest.fn(reject),
      listDescriptorVersions: jest.fn(reject),
      getDescriptorVersion: jest.fn(reject),
      retireService: jest.fn(reject),
      retireDescriptorVersion: jest.fn(reject),
      delete: jest.fn(reject),
    },
  };
});

import servicesRouter from '../routes/services';

let server: http.Server;
let baseUrl: string;
let consoleSpy: jest.SpyInstance;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/services', servicesRouter);
  server = app.listen(0, () => {
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${baseUrl}${path}`,
      {
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

// Every new catch boundary in routes/services.ts, one entry per route.
// Rows are always 3-tuples: a shorter row would make jest treat the unfilled
// parameter as a done-callback and hang the test.
const BOUNDARIES: Array<[string, string, unknown]> = [
  ['GET', '/services', undefined],
  ['POST', '/services', { slug: 'x', name: 'X' }],
  ['GET', '/services/some-service', undefined],
  ['PATCH', '/services/some-service', { name: 'X' }],
  ['PATCH', '/services/some-service/owner-plane', { visibilityTier: 'unrestricted' }],
  ['GET', '/services/some-service/descriptor', undefined],
  ['PUT', '/services/some-service/descriptor', { descriptor: { options: [] } }],
  ['GET', '/services/some-service/descriptor/versions', undefined],
  ['GET', '/services/some-service/descriptor/versions/1', undefined],
  ['POST', '/services/some-service/retire', {}],
  ['POST', '/services/some-service/descriptor/versions/1/retire', {}],
  ['DELETE', '/services/some-service', undefined],
];

function capturedLogText(): string {
  return consoleSpy.mock.calls
    .map((args: unknown[]) => args.map((a) => {
      try {
        return typeof a === 'string' ? a : JSON.stringify(a) ?? String(a);
      } catch {
        return String(a);
      }
    }).join(' '))
    .join('\n');
}

function assertClean(status: number, text: string, expectedCategory: string): void {
  // The generic envelope, never the underlying failure detail.
  expect(status).toBe(500);
  expect(text).toContain('INTERNAL_ERROR');
  expect(text).not.toContain(SECRET_MARKER);
  expect(text).not.toContain('adapter exploded');
  // The log sink saw fixed diagnostics plus the bounded category only.
  expect(consoleSpy).toHaveBeenCalled();
  const logged = capturedLogText();
  expect(logged).not.toContain(SECRET_MARKER);
  expect(logged).not.toContain('adapter exploded');
  expect(logged).toContain('[Services API]');
  expect(logged).toContain(`(${expectedCategory})`);
}

describe('no secret-shaped value reaches the log sink or the response (hostile Error: name/message/stack/cause/custom all poisoned)', () => {
  it.each(BOUNDARIES)('%s %s', async (method, path, body) => {
    rejectWith = hostileError;
    const { status, text } = await call(method, path, body);
    assertClean(status, text, 'Error');
  });
});

describe('no secret-shaped value reaches the log sink or the response (hostile non-Error throw)', () => {
  it.each(BOUNDARIES)('%s %s', async (method, path, body) => {
    rejectWith = hostileNonError;
    const { status, text } = await call(method, path, body);
    assertClean(status, text, 'NonError');
  });
});
