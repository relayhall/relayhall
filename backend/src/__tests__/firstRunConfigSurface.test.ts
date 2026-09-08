/**
 * THE PRE-LOGIN BOOTSTRAP PAYLOAD carries the first-run boolean and NOTHING
 * ELSE about identity (owner ruling `60307311` §1.1).
 *
 * `GET /config` is the one thing an unauthenticated caller reads before the
 * login page renders. Two properties matter and are measured here: the boolean
 * REACHES it (a field the route never passes is a step that never appears),
 * and the payload gains no other identity fact — no handle, no Account count,
 * no role. The second is measured against the WHOLE `auth` block rather than
 * by naming the keys this wave happened to add, so a later field cannot be
 * added without this failing.
 */
import express from 'express';
import type { AddressInfo } from 'net';

process.env.RELAYHALL_SESSIONS = 'on';

const firstRunAvailable = jest.fn(async () => true);

jest.mock('../services/FirstRunService', () => ({
  firstRunService: { firstRunAvailable: (...a: unknown[]) => firstRunAvailable(...(a as [])) },
}));
jest.mock('../services/identity/IdentityProviderService', () => ({
  identityProviderService: { activeProvider: jest.fn(async () => undefined) },
}));
// Spread the REAL module: `config/relayhall` imports BUILT_IN_APPEARANCE from
// here too, and replacing the module wholesale drops every sibling export —
// which surfaced as `effective.displayName` on undefined, not as a missing mock.
jest.mock('../services/AppearanceService', () => {
  const actual = jest.requireActual('../services/AppearanceService');
  return { ...actual, appearanceService: { get: jest.fn(async () => undefined) } };
});
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() },
  BOOT_CHECK_MODE: false,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const configRouter = require('../routes/config').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getPublicConfig, relayhallConfig } = require('../config/relayhall');

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
  const app = express();
  app.use('/config', configRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => { firstRunAvailable.mockReset(); firstRunAvailable.mockResolvedValue(true); });

const read = async () => (await fetch(`${base}/config`)).json();

describe('the first-run boolean on /config', () => {
  it('reaches the payload when the state holds', async () => {
    const body: any = await read();
    expect(body.auth.firstRun).toBe(true);
  });

  it('is false once an administrator exists', async () => {
    firstRunAvailable.mockResolvedValue(false);
    const body: any = await read();
    expect(body.auth.firstRun).toBe(false);
  });

  it('is a BOOLEAN and the auth block gains nothing else', async () => {
    const body: any = await read();
    expect(typeof body.auth.firstRun).toBe('boolean');
    // The whole block, enumerated. A later field lands here as a failure
    // rather than as a silent widening of what a stranger can read.
    expect(Object.keys(body.auth).sort()).toEqual(['firstRun', 'sessions', 'sso']);
    expect(JSON.stringify(body)).not.toContain('dashboard_user');
  });

  it('survives an appearance failure with the boolean intact', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { appearanceService } = require('../services/AppearanceService');
    appearanceService.get.mockRejectedValueOnce(new Error('row corrupt'));
    const body: any = await read();
    expect(body.auth.firstRun).toBe(true);
    expect(body.loginTitle).toBeDefined();
  });
});

describe('getPublicConfig itself', () => {
  it('defaults the field to false when no caller supplies it', () => {
    // An older caller passing three arguments must not advertise a step.
    expect(getPublicConfig(relayhallConfig).auth.firstRun).toBe(false);
    expect(getPublicConfig(relayhallConfig, undefined, undefined).auth.firstRun).toBe(false);
  });

  it('passes a supplied value through unchanged', () => {
    expect(getPublicConfig(relayhallConfig, undefined, undefined, true).auth.firstRun).toBe(true);
    expect(getPublicConfig(relayhallConfig, undefined, undefined, false).auth.firstRun).toBe(false);
  });
});
