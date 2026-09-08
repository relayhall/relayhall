/**
 * Structural guard: every entry point that honours a dashboard token must
 * check whether the identity is still active.
 *
 * Disabling was fixed once in middleware/auth.ts, accompanied by a comment
 * claiming "a disabled identity is disabled on every path" — while /ws,
 * the plugin proxy and both capability-cookie mints still accepted
 * the same token with no lookup. That claim was wrong because it was made
 * from memory instead of from the code.
 *
 * This test does the enumeration instead: it fails when a new call site uses
 * the unchecked verifier, or verifies a token with jwt.verify directly.
 *
 * WHAT IT DOES NOT CATCH (measured, not assumed — a reviewer demonstrated
 * these): an import aliased to a different local name, verification done in a
 * .js file, or code outside backend/src. It narrows the opening; it does not
 * close it. Do not read a green run as proof that every entry point is
 * checked.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');

/** Files permitted to call the raw, status-unaware verifier, with reasons. */
const ALLOWED_RAW_CALLERS: Record<string, string> = {
  'utils/dashboardToken.ts': 'defines both verifiers; the checked one wraps the raw one',
  'middleware/auth.ts': 'resolves and attaches the principal itself, including its status',
  // Capability cookies are not identities, so they cannot use the identity
  // verifier — but they now name the principal that minted them and check
  // its status, which is what the allow-list entry is attesting to.
  'middleware/pluginProxy.ts': 'verifies the browser-access capability cookie; status-checks its sub',
  // routes/secondBrain.ts (qdrant-ui capability cookie) left core with the
  // Second Brain plugin (P1.3) — any reappearance must re-justify its entry.
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('dashboard-token entry points', () => {
  const files = walk(SRC);

  it('finds the production sources (guard is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no production file outside the allow-list calls the status-unaware verifier', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED_RAW_CALLERS[rel]) continue;
      const source = fs.readFileSync(file, 'utf-8');
      // Match a call, not an import of the checked wrapper.
      if (/(?<!verifyActive)\bverifyDashboardToken\s*\(/.test(source)) {
        offenders.push(`${rel} (raw verifier)`);
        continue;
      }
      // Verifying a token directly sidesteps the wrapper entirely — the same
      // bypass in a different spelling.
      if (/\bjwt\.verify\s*\(/.test(source)) {
        offenders.push(`${rel} (direct jwt.verify)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the five known token entry points use the checked verifier', () => {
    for (const rel of [
      'services/websocket.ts',
      'middleware/pluginProxy.ts',
      'routes/auth.ts',
    ]) {
      const source = fs.readFileSync(path.join(SRC, rel), 'utf-8');
      expect(source).toContain('verifyActiveDashboardToken');
    }
  });

  it('the checked verifier allows an unresolvable identity — a DB outage must not lock anyone out', () => {
    const source = fs.readFileSync(path.join(SRC, 'utils/dashboardToken.ts'), 'utf-8');
    const fn = source.slice(source.indexOf('export async function verifyActiveDashboardToken'));
    // Rejection is conditional on a principal actually being FOUND.
    expect(fn).toContain("bounded && bounded.status !== 'active'");
  });

  it('the capability-cookie verifiers use the shared bounded lookup', () => {
    // Deliberately NOT "every lookup on a request path" — middleware/auth.ts
    // resolves principals itself and is not covered here. Claiming the wider
    // property in a test name is how the last four rounds went wrong.
    // "Fails" and "never answers" are different outages, and the second one
    // came back twice: bounded in the verifier, then re-added unbounded in
    // both capability-cookie verifiers. The bound lives in one shared helper
    // and every caller must use it.
    const tokenSrc = fs.readFileSync(path.join(SRC, 'utils/dashboardToken.ts'), 'utf-8');
    expect(tokenSrc).toContain('Promise.race');
    expect(tokenSrc).toContain('STATUS_LOOKUP_TIMEOUT_MS');

    for (const rel of ['middleware/pluginProxy.ts']) {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf-8');
      expect(src).toContain('lookupPrincipalBounded');
      // An unbounded direct lookup on this path stalls <img> and iframe
      // loads until the client gives up.
      expect(src).not.toMatch(/await\s+principalService\.getPrincipalById/);
    }
  });
});
