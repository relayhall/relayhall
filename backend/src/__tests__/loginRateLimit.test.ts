import fs from 'fs';
import path from 'path';
import { LoginThrottle, backoffDelayMs, loginClientKey } from '../middleware/loginRateLimit';

describe('login backoff schedule', () => {
  it('lets the first attempt through with no delay', () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(0);
  });

  it('doubles from one second', () => {
    expect(backoffDelayMs(2)).toBe(1_000);
    expect(backoffDelayMs(3)).toBe(2_000);
    expect(backoffDelayMs(4)).toBe(4_000);
    expect(backoffDelayMs(5)).toBe(8_000);
  });

  it('caps so the account is throttled, never permanently locked', () => {
    const cap = 5 * 60_000;
    expect(backoffDelayMs(20)).toBe(cap);
    expect(backoffDelayMs(1_000)).toBe(cap);
    // A very large failure count must not overflow into Infinity or NaN.
    expect(Number.isFinite(backoffDelayMs(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(backoffDelayMs(Number.MAX_SAFE_INTEGER)).toBe(cap);
  });
});

describe('LoginThrottle', () => {
  let now = 1_000_000;
  const clock = () => now;
  let throttle: LoginThrottle;

  beforeEach(() => {
    now = 1_000_000;
    throttle = new LoginThrottle(clock);
  });

  it('allows an unseen source', () => {
    expect(throttle.check('1.2.3.4')).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('allows the first failure without delay, then throttles', () => {
    throttle.recordFailure('1.2.3.4');
    expect(throttle.check('1.2.3.4').allowed).toBe(true);

    throttle.recordFailure('1.2.3.4');
    const decision = throttle.check('1.2.3.4');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('releases once the delay elapses', () => {
    throttle.recordFailure('1.2.3.4');
    throttle.recordFailure('1.2.3.4');
    expect(throttle.check('1.2.3.4').allowed).toBe(false);
    now += 1_000;
    expect(throttle.check('1.2.3.4').allowed).toBe(true);
  });

  it('clears the counter on success, so a legitimate login is never punished', () => {
    for (let i = 0; i < 8; i++) throttle.recordFailure('1.2.3.4');
    expect(throttle.check('1.2.3.4').allowed).toBe(false);

    throttle.recordSuccess('1.2.3.4');
    expect(throttle.check('1.2.3.4')).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('never exceeds the cap however long the attack runs', () => {
    for (let i = 0; i < 500; i++) throttle.recordFailure('1.2.3.4');
    expect(throttle.check('1.2.3.4').retryAfterSeconds).toBeLessThanOrEqual(300);
  });

  it('throttles each source independently', () => {
    for (let i = 0; i < 5; i++) throttle.recordFailure('9.9.9.9');
    expect(throttle.check('9.9.9.9').allowed).toBe(false);
    expect(throttle.check('1.2.3.4').allowed).toBe(true);
  });

  it('forgets idle sources so the map cannot grow without bound', () => {
    throttle.recordFailure('1.2.3.4');
    throttle.recordFailure('1.2.3.4');
    expect(throttle.size()).toBe(1);
    now += 2 * 60 * 60_000;
    throttle.check('other');
    expect(throttle.size()).toBe(0);
  });
});

describe('loginClientKey', () => {
  it('prefers req.ip, which honours the configured trust proxy setting', () => {
    expect(loginClientKey({ ip: '203.0.113.7', socket: { remoteAddress: '172.28.0.5' } }))
      .toBe('203.0.113.7');
  });

  it('falls back to the socket address for direct connections', () => {
    expect(loginClientKey({ socket: { remoteAddress: '172.28.0.5' } })).toBe('172.28.0.5');
  });

  it('never returns empty, which would merge every caller into one bucket', () => {
    expect(loginClientKey({})).toBe('unknown');
  });
});

describe('login route wiring', () => {
  const route = fs.readFileSync(path.join(__dirname, '../routes/auth.ts'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../server.ts'), 'utf8');

  it('throttles before the bcrypt compare', () => {
    expect(route.indexOf('loginThrottle.check')).toBeLessThan(route.indexOf('bcrypt.compare'));
  });

  it('records failure and success against the same key', () => {
    expect(route).toContain('loginThrottle.recordFailure(clientKey)');
    expect(route).toContain('loginThrottle.recordSuccess(clientKey)');
  });

  it('answers 429 with Retry-After', () => {
    expect(route).toContain("res.setHeader('Retry-After'");
    expect(route).toContain('res.status(429)');
  });

  it('trusts the proxy so req.ip is the caller, not the nginx container', () => {
    expect(server).toContain("app.set('trust proxy'");
  });
});

describe('throttle key cannot be chosen by the caller', () => {
  // trust proxy alone is not enough: the backend port is published, so a direct
  // client can set X-Forwarded-For, rotate buckets to escape the throttle, and
  // pin the owner's bucket at 429 — a targeted lockout of the break-glass path.
  const { isTrustedPeer } = require('../middleware/loginRateLimit');

  afterEach(() => {
    delete process.env.TRUSTED_PROXY_IPS;
  });

  it('does not trust the LAN, where a direct attacker would connect from', () => {
    expect(isTrustedPeer('192.0.2.77')).toBe(false);
    expect(isTrustedPeer('::ffff:192.0.2.77')).toBe(false);
    expect(isTrustedPeer('203.0.113.5')).toBe(false);
  });

  it('trusts loopback and the docker bridge ranges the proxy sits on', () => {
    expect(isTrustedPeer('127.0.0.1')).toBe(true);
    expect(isTrustedPeer('::1')).toBe(true);
    expect(isTrustedPeer('172.28.0.5')).toBe(true);
    expect(isTrustedPeer('10.250.1.4')).toBe(true);
  });

  it('honours an exact pin when configured', () => {
    process.env.TRUSTED_PROXY_IPS = '172.28.0.5';
    expect(isTrustedPeer('172.28.0.5')).toBe(true);
    expect(isTrustedPeer('172.28.0.6')).toBe(false);
  });

  it('ignores a spoofed X-Forwarded-For from an untrusted direct peer', () => {
    const key = loginClientKey({ ip: '198.51.100.9', socket: { remoteAddress: '192.0.2.77' } });
    expect(key).toBe('192.0.2.77');
  });

  it('uses the forwarded address only behind a trusted proxy', () => {
    const key = loginClientKey({ ip: '203.0.113.7', socket: { remoteAddress: '172.28.0.5' } });
    expect(key).toBe('203.0.113.7');
  });
});

describe('tracked-source map is bounded', () => {
  it('evicts the oldest entry rather than growing without limit', () => {
    const throttle = new LoginThrottle(() => 1_000_000);
    for (let i = 0; i < 10_050; i++) throttle.recordFailure(`src-${i}`);
    expect(throttle.size()).toBeLessThanOrEqual(10_000);
  });
});
