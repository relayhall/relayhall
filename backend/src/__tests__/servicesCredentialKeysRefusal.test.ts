/**
 * A board with no credential key set answers a NAMED 503 when it is asked for
 * a credential, not an anonymous 500.
 *
 * A fresh install made before `./setup.sh` generated the key sets (or one whose
 * `relayhall.keys.env` was lost) has no `RELAYHALL_CREDENTIAL_KEYS`. The first
 * thing a new operator does is "Connect your agent", which registers a
 * Connector and issues its first credential in one request. Encrypting that
 * credential needs the key set, so the request failed with
 * `500 INTERNAL_ERROR, 'Failed to register the service'`, and the only clue was
 * a line in the backend log.
 *
 * The refusal is now `503 CREDENTIAL_KEYS_NOT_CONFIGURED`, whose message tells
 * the operator what to run. Only the MISSING key set is mapped: every other
 * credential-crypto failure (a malformed key set, an unknown key, a failed
 * decryption) is a different fault and keeps the generic envelope.
 *
 * The registry is replaced by a double here so the mapping is measured on the
 * real route without a database; the same refusal through the real registry,
 * the real transaction and a real PostgreSQL is in
 * `dayOneConnectionAcceptance.test.ts` (`npm run test:day-one-connection`).
 */
import express from 'express';
import http from 'http';
import { CredentialCryptoError, loadKeyset } from '../utils/credentialCrypto';

let rejectWith: () => unknown = () => new Error('unset');

jest.mock('../services/ServiceRegistry', () => {
  const actual = jest.requireActual('../services/ServiceRegistry');
  return {
    ...actual,
    serviceRegistry: {
      register: jest.fn(() => Promise.reject(rejectWith())),
    },
  };
});

import servicesRouter from '../routes/services';
import { CREDENTIAL_KEYS_NOT_CONFIGURED, credentialKeysRefusal } from '../utils/credentialKeysRefusal';

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

afterAll((done) => { server.close(done); });
beforeEach(() => { consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { consoleSpy.mockRestore(); });

function register(): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify({ slug: 'invented-connection', name: 'Invented connection' });
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(text || '{}') }));
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

/** The exact error the real key-set loader throws when nothing is configured. */
function realMissingKeysetError(): unknown {
  try {
    loadKeyset({});
  } catch (error) {
    return error;
  }
  throw new Error('loadKeyset({}) did not throw: the fixture no longer models the real failure');
}

describe('the missing credential key set', () => {
  it('is what the real loader throws for an empty environment', () => {
    const error = realMissingKeysetError();
    expect(error).toBeInstanceOf(CredentialCryptoError);
    expect((error as CredentialCryptoError).code).toBe('CREDENTIAL_KEYSET_MISSING');
  });

  it('answers 503 CREDENTIAL_KEYS_NOT_CONFIGURED on POST /services, telling the operator what to run', async () => {
    rejectWith = realMissingKeysetError;
    const answer = await register();
    expect(answer.status).toBe(503);
    expect(answer.json.code).toBe(CREDENTIAL_KEYS_NOT_CONFIGURED);
    expect(String(answer.json.message)).toMatch(/\.\/setup\.sh/);
    expect(String(answer.json.message)).toMatch(/answer "no"/);
    expect(String(answer.json.message)).toMatch(/restart/i);
    expect(answer.json.code).not.toBe('INTERNAL_ERROR');
  });

  it('names no key material and no environment value', async () => {
    rejectWith = realMissingKeysetError;
    const answer = await register();
    const text = JSON.stringify(answer.json);
    expect(text).not.toMatch(/[A-Za-z0-9+/]{43}=/);
    expect(text).not.toContain('design');
  });
});

describe('other credential-crypto failures keep the generic envelope', () => {
  it.each([
    ['CREDENTIAL_KEYSET_INVALID', 'RELAYHALL_CREDENTIAL_KEYS is not valid JSON'],
    ['CREDENTIAL_KEY_UNKNOWN', "keyset holds no key 'invented'"],
    ['CREDENTIAL_DECRYPT_FAILED', 'ciphertext failed authenticated decryption'],
  ])('%s stays 500 INTERNAL_ERROR', async (code, message) => {
    rejectWith = () => new CredentialCryptoError(code, message);
    const answer = await register();
    expect(answer.status).toBe(500);
    expect(answer.json.code).toBe('INTERNAL_ERROR');
  });

  it('a plain Error stays 500 INTERNAL_ERROR', async () => {
    rejectWith = () => new Error('CREDENTIAL_KEYSET_MISSING');
    const answer = await register();
    expect(answer.status).toBe(500);
    expect(answer.json.code).toBe('INTERNAL_ERROR');
  });
});

describe('credentialKeysRefusal', () => {
  it('maps exactly the missing key set', () => {
    expect(credentialKeysRefusal(realMissingKeysetError())?.status).toBe(503);
    expect(credentialKeysRefusal(new CredentialCryptoError('CREDENTIAL_KEYSET_INVALID', 'x'))).toBeNull();
    expect(credentialKeysRefusal({ code: 'CREDENTIAL_KEYSET_MISSING' })).toBeNull();
    expect(credentialKeysRefusal(undefined)).toBeNull();
  });
});
