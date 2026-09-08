/**
 * Per-principal preferences (RH-UI.2, task 07113036): the value space, the
 * absence-vs-null distinction, and the property the whole surface exists to
 * guarantee — a principal can reach their own row and no other (review S-F11,
 * spec 9f01ba4b §5.1).
 *
 * The service is mocked for the route tests: this file pins the SURFACE and
 * the shape of the calls it makes. Storage behaviour is proven live on PG16
 * (fresh-replay + upgrade-path evidence on the task).
 */
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';

jest.mock('../services/PrincipalPreferencesService', () => {
  const actual = jest.requireActual('../services/PrincipalPreferencesService');
  return {
    ...actual,
    principalPreferencesService: { get: jest.fn(), save: jest.fn() },
  };
});

import {
  principalPreferencesService,
  parsePreferencesPatch,
  PreferencesValidationError,
  THEME_PREFERENCE_VALUES,
  REDUCED_MOTION_VALUES,
  DEFAULT_PREFERENCES,
} from '../services/PrincipalPreferencesService';
import preferencesRouter from '../routes/preferences';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

let server: http.Server;
let baseUrl: string;
/** The identity the fake auth layer resolves for the next request. */
let caller: { id: string } | undefined = { id: ALICE };

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = caller;
    next();
  });
  app.use('/preferences', preferencesRouter);
  server = app.listen(0, () => {
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => {
  jest.clearAllMocks();
  caller = { id: ALICE };
});

function call(method: string, urlPath: string, body?: unknown):
  Promise<{ status: number; json: any }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${baseUrl}${urlPath}`,
      {
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: response.statusCode || 0, json: parsed });
        });
      }
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

describe('preference value space', () => {
  it('is exactly the three Themes plus the system directive', () => {
    expect([...THEME_PREFERENCE_VALUES].sort()).toEqual(
      ['high-contrast', 'relay-dark', 'relay-light', 'system']);
  });

  it('treats reduced motion as a tri-state defaulting to system', () => {
    expect([...REDUCED_MOTION_VALUES]).toEqual(['system', 'reduce', 'no-preference']);
    expect(DEFAULT_PREFERENCES).toEqual({ theme: null, reducedMotion: 'system' });
  });
});

describe('parsePreferencesPatch', () => {
  it('accepts every declared value', () => {
    for (const theme of THEME_PREFERENCE_VALUES) {
      expect(parsePreferencesPatch({ theme })).toEqual({ theme });
    }
    for (const reducedMotion of REDUCED_MOTION_VALUES) {
      expect(parsePreferencesPatch({ reducedMotion })).toEqual({ reducedMotion });
    }
  });

  it('distinguishes an explicit null from an absent field', () => {
    expect('theme' in parsePreferencesPatch({ theme: null })).toBe(true);
    expect('theme' in parsePreferencesPatch({ reducedMotion: 'reduce' })).toBe(false);
  });

  it('rejects rather than coerces an unknown Theme', () => {
    expect(() => parsePreferencesPatch({ theme: 'relay-sepia' }))
      .toThrow(PreferencesValidationError);
    expect(() => parsePreferencesPatch({ theme: 'RELAY-DARK' }))
      .toThrow(PreferencesValidationError);
    expect(() => parsePreferencesPatch({ reducedMotion: true }))
      .toThrow(PreferencesValidationError);
  });

  it('rejects a body that says nothing', () => {
    expect(() => parsePreferencesPatch({})).toThrow(PreferencesValidationError);
    expect(() => parsePreferencesPatch(null)).toThrow(PreferencesValidationError);
    expect(() => parsePreferencesPatch([])).toThrow(PreferencesValidationError);
  });

  it('ignores fields that are not preferences, including an identity claim', () => {
    expect(parsePreferencesPatch({ theme: 'relay-light', principalId: BOB, isAdmin: true }))
      .toEqual({ theme: 'relay-light' });
  });
});

describe('the surface cannot name another principal', () => {
  it('reads the row of the authenticated principal', async () => {
    (principalPreferencesService.get as jest.Mock).mockResolvedValue(
      { theme: 'relay-light', reducedMotion: 'system' });
    const response = await call('GET', '/preferences');
    expect(response.status).toBe(200);
    expect(principalPreferencesService.get).toHaveBeenCalledWith(ALICE);
    expect(response.json.data).toEqual({ theme: 'relay-light', reducedMotion: 'system' });
  });

  it('writes the row of the authenticated principal even when the body claims another', async () => {
    (principalPreferencesService.save as jest.Mock).mockResolvedValue(
      { theme: 'high-contrast', reducedMotion: 'system' });
    const response = await call('PUT', '/preferences',
      { theme: 'high-contrast', principalId: BOB, principal_id: BOB });
    expect(response.status).toBe(200);
    expect(principalPreferencesService.save).toHaveBeenCalledWith(ALICE, { theme: 'high-contrast' });
  });

  it('has no route that accepts an identifier, on any method', async () => {
    for (const method of ['GET', 'PUT']) {
      const response = await call(method, `/preferences/${BOB}`, { theme: 'relay-dark' });
      expect(response.status).toBe(404);
    }
    expect(principalPreferencesService.get).not.toHaveBeenCalled();
    expect(principalPreferencesService.save).not.toHaveBeenCalled();
  });

  it('serves two principals their own rows and never the other one', async () => {
    (principalPreferencesService.get as jest.Mock).mockImplementation(
      async (principalId: string) => ({
        theme: principalId === ALICE ? 'relay-light' : 'high-contrast',
        reducedMotion: 'system',
      }));

    caller = { id: ALICE };
    expect((await call('GET', '/preferences')).json.data.theme).toBe('relay-light');
    caller = { id: BOB };
    expect((await call('GET', '/preferences')).json.data.theme).toBe('high-contrast');

    expect((principalPreferencesService.get as jest.Mock).mock.calls).toEqual([[ALICE], [BOB]]);
  });

  it('never derives the principal from anything but the session', () => {
    // A source-text pin, because this is a property of the SHAPE of the file:
    // no path parameter and no read of an identity field off the request body
    // can be introduced without this failing.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'routes', 'preferences.ts'), 'utf8');
    expect(source).not.toMatch(/router\.(get|put|post|patch|delete)\(\s*['"][^'"]*:/);
    expect(source).not.toMatch(/req\.body\.principal/i);
    expect(source).not.toMatch(/req\.params/);
    expect(source).toMatch(/req\.principal\?\.id/);
  });
});

describe('identities with no principal row', () => {
  it('are refused with a reason instead of silently discarding the setting', async () => {
    caller = undefined;
    const read = await call('GET', '/preferences');
    const write = await call('PUT', '/preferences', { theme: 'relay-dark' });
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(write.json.message).toMatch(/principal/i);
    expect(principalPreferencesService.save).not.toHaveBeenCalled();
  });
});

describe('unexpected failures never serialize the exception', () => {
  // Review 241ce388 F2. The safety floor forbids private values in logs, and
  // this route's exceptions come from Postgres — a CHECK or unique violation
  // carries a `detail` that QUOTES THE OFFENDING ROW, so logging the caught
  // object would print a principal's stored preferences. The repository's
  // P2.1/P2.2/P2.3 secret-safe sink is the standard; this route now uses it.
  const MARKER = 'SYNTHETIC_PRIVATE_VALUE_DO_NOT_LOG_7f6c';

  async function probe(method: 'GET' | 'PUT') {
    const captured: unknown[][] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => {
      captured.push(args);
    });
    try {
      const failure = new Error(MARKER);
      (principalPreferencesService.get as jest.Mock).mockRejectedValue(failure);
      (principalPreferencesService.save as jest.Mock).mockRejectedValue(failure);
      const response = await call(method, '/preferences',
        method === 'PUT' ? { theme: 'relay-dark' } : undefined);
      return { response, captured };
    } finally {
      spy.mockRestore();
    }
  }

  it.each(['GET', 'PUT'] as const)(
    'returns a fixed 500 and logs nothing exception-derived (%s)', async (method) => {
      const { response, captured } = await probe(method);

      expect(response.status).toBe(500);
      expect(JSON.stringify(response.json)).not.toContain(MARKER);

      // Not in the message, not in a nested argument, not via an Error object
      // handed to the logger for it to serialize.
      expect(captured.length).toBeGreaterThan(0);
      const flattened = captured.flat();
      expect(JSON.stringify(flattened)).not.toContain(MARKER);
      for (const argument of flattened) {
        expect(argument).not.toBeInstanceOf(Error);
        expect(String(argument)).not.toContain(MARKER);
      }
      // What it DOES log: fixed context plus a bounded category.
      expect(String(flattened[0])).toMatch(/^\[Preferences API\] (read|write) failed: \((Error|NonError)\) \[class=/);
    });

  it('classifies a non-Error throw without serializing it either', async () => {
    const captured: unknown[][] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => {
      captured.push(args);
    });
    try {
      (principalPreferencesService.get as jest.Mock).mockRejectedValue({ secret: MARKER });
      const response = await call('GET', '/preferences');
      expect(response.status).toBe(500);
      expect(JSON.stringify(captured)).not.toContain(MARKER);
      expect(String(captured.flat()[0])).toContain('(NonError)');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('validation failures are named', () => {
  it('returns 400 with the legal values, and writes nothing', async () => {
    const response = await call('PUT', '/preferences', { theme: 'relay-sepia' });
    expect(response.status).toBe(400);
    expect(response.json.message).toContain('relay-dark');
    expect(principalPreferencesService.save).not.toHaveBeenCalled();
  });
});
