/**
 * Dual-stack token-compat matrix (CB-2 [9], spec b48bb799 §2.2).
 *
 * Old-shape {userId} and v2 {v:2,sub,handle,kind} payloads, each signed with
 * the "dev" and "prod" secrets, verified under each stack's secret. The
 * contract: a token verifies iff its signing secret matches the stack, and
 * BOTH payload shapes verify — v2 login mints must not orphan long-lived
 * cached legacy tokens (CLI token caches, harness token files), and legacy stacks are
 * never presented v2 tokens cross-env because the secrets already differ.
 */
import jwt from 'jsonwebtoken';

const DEV_SECRET = 'compat-dev-secret';
const PROD_SECRET = 'compat-prod-secret';
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';

type Verify = (token: string) => { userId: string; principalId?: string; kind?: string };

async function verifierUnder(secret: string): Promise<Verify> {
  jest.resetModules();
  process.env.JWT_SECRET = secret;
  const { verifyDashboardToken } = await import('../utils/dashboardToken');
  return verifyDashboardToken;
}

// Same `as any` idiom the login route uses: the @types StringValue template
// rejects a plain-string expiresIn.
const oldShape = (secret: string, expiresIn = '1h') =>
  (jwt.sign as any)({ userId: 'dashboard_user' }, secret, { expiresIn }) as string;
const v2Shape = (secret: string, expiresIn = '1h') =>
  (jwt.sign as any)({ v: 2, sub: PRINCIPAL_ID, handle: 'dashboard_user', kind: 'human' }, secret, { expiresIn }) as string;

describe('token-compat matrix: shape × signing secret × verifying stack', () => {
  it.each([
    ['old-shape', 'dev', DEV_SECRET, DEV_SECRET, true],
    ['old-shape', 'prod', PROD_SECRET, PROD_SECRET, true],
    ['old-shape', 'cross', DEV_SECRET, PROD_SECRET, false],
    ['old-shape', 'cross', PROD_SECRET, DEV_SECRET, false],
    ['v2', 'dev', DEV_SECRET, DEV_SECRET, true],
    ['v2', 'prod', PROD_SECRET, PROD_SECRET, true],
    ['v2', 'cross', DEV_SECRET, PROD_SECRET, false],
    ['v2', 'cross', PROD_SECRET, DEV_SECRET, false],
  ])('%s token, %s (signed≟verified)', async (shape, _label, signSecret, verifySecret, shouldVerify) => {
    const verify = await verifierUnder(verifySecret);
    const token = shape === 'v2' ? v2Shape(signSecret) : oldShape(signSecret);
    if (shouldVerify) {
      const identity = verify(token);
      expect(identity.userId).toBe('dashboard_user');
      if (shape === 'v2') {
        expect(identity.principalId).toBe(PRINCIPAL_ID);
        expect(identity.kind).toBe('human');
      } else {
        expect(identity.principalId).toBeUndefined();
      }
    } else {
      // jest.resetModules gives the verifier its own jsonwebtoken class, so
      // assert on the error message rather than constructor identity.
      expect(() => verify(token)).toThrow('invalid signature');
    }
  });

  it('v2 userId is the handle, so every req.userId consumer is byte-identical', async () => {
    const verify = await verifierUnder(DEV_SECRET);
    expect(verify(v2Shape(DEV_SECRET)).userId).toBe(verify(oldShape(DEV_SECRET)).userId);
  });

  it('still rejects capability tokens (scope claim) in both eras', async () => {
    const verify = await verifierUnder(DEV_SECRET);
    const capability = jwt.sign({ scope: 'browser-access' }, DEV_SECRET, { expiresIn: '1h' });
    expect(() => verify(capability)).toThrow('capability token is not an identity');
    const v2Capability = jwt.sign({ v: 2, sub: PRINCIPAL_ID, handle: 'x', scope: 'browser-access' }, DEV_SECRET);
    expect(() => verify(v2Capability)).toThrow('capability token is not an identity');
  });

  it('rejects identityless payloads of either shape', async () => {
    const verify = await verifierUnder(DEV_SECRET);
    expect(() => verify(jwt.sign({}, DEV_SECRET))).toThrow('token carries no identity');
    expect(() => verify(jwt.sign({ v: 2, sub: PRINCIPAL_ID }, DEV_SECRET))).toThrow('token carries no identity');
    expect(() => verify(jwt.sign({ v: 2, handle: 'dashboard_user' }, DEV_SECRET))).toThrow('token carries no identity');
  });

  it('rejects expired tokens of both shapes with TokenExpiredError', async () => {
    const verify = await verifierUnder(DEV_SECRET);
    for (const token of [oldShape(DEV_SECRET, '-10m'), v2Shape(DEV_SECRET, '-10m')]) {
      let thrown: Error | undefined;
      try { verify(token); } catch (err) { thrown = err as Error; }
      expect(thrown?.name).toBe('TokenExpiredError');
    }
  });
});
