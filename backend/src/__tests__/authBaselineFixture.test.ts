import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

type Probe = {
  id: string;
  method: string;
  path: string;
  status: number;
  content_type: string;
  body: string;
};

const fixturePath = path.join(__dirname, 'fixtures', 'auth-baseline-post-089.json');
const captureScriptPath = path.join(__dirname, '..', '..', 'scripts', 'auth-baseline-capture.sh');
const oldFixtureHashes = new Map([
  ['auth-baseline-cb2.json', ['35cb8c5deb9dbcf3', '73e1520b62d7783d', 'e80c6c6a8ba6acd6', '22edfede0b1c65c8'].join('')],
  ['auth-baseline-prod-pre-cb5.json', ['1043e230475b6f4d', '1d431c63773d0f8a', 'a4cda7205d4c95a5', '4a7d9fe736f61fb6'].join('')],
]);

const probes = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Probe[];
const byId = new Map(probes.map((probe) => [probe.id, probe]));

describe('post-089 live authentication baseline fixture', () => {
  it('is deterministic, unique, and secret-free', () => {
    expect(probes).toHaveLength(39);
    expect(probes.map(({ id }) => id)).toEqual([...probes.map(({ id }) => id)].sort());
    expect(byId.size).toBe(probes.length);
    expect(JSON.stringify(probes)).not.toMatch(/rh_(?:dev|live)_[A-Za-z0-9]{6,64}\.[A-Za-z0-9_-]{20,128}/);
  });

  it('targets the live health and Skills routes, not retired paths', () => {
    expect(byId.get('014-none-health')).toMatchObject({ path: '/health', status: 200, body: '' });
    expect(byId.get('044-jwt-health')).toMatchObject({ path: '/health', status: 200, body: '' });
    expect(byId.get('091-reports-key-skills-offscope')).toMatchObject({
      path: '/skills',
      status: 403,
      body: '{"error":"Forbidden","message":"Reports read key is invalid or out of scope"}',
    });
    expect(probes.some(({ path: probePath }) => probePath === '/status' || probePath === '/journal')).toBe(false);
  });

  it('pins generic fail-closed authorization after proving the same principal key works in scope', () => {
    expect(byId.get('095-rh-key-tasks-in-scope')).toEqual({
      id: '095-rh-key-tasks-in-scope',
      method: 'GET',
      path: '/tasks',
      status: 200,
      content_type: 'application/json; charset=utf-8',
      body: '',
    });

    const reportsProbe = byId.get('096-rh-key-reports-offscope');
    expect(reportsProbe).toMatchObject({
      method: 'GET',
      path: '/reports',
      status: 403,
      content_type: 'application/json; charset=utf-8',
    });
    const denial = JSON.parse(reportsProbe?.body ?? '{}');
    expect(denial).toEqual({
      success: false,
      error: 'This identity is not authorized for the requested operation',
      code: 'FORBIDDEN',
      message: 'This identity is not authorized for the requested operation',
    });
    expect(Object.keys(denial)).toEqual(['success', 'error', 'code', 'message']);
    expect(reportsProbe?.body).not.toMatch(/reports:read|required scope/i);

    // a658e191 captured a scope-disclosing denial. The shared-authorization
    // hardening in bcf89ccb and 54566ac supersedes that stale expectation.
  });

  it('keeps both historical fixtures byte-identical', () => {
    for (const [filename, expectedHash] of oldFixtureHashes) {
      const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', filename));
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(expectedHash);
    }
  });

  it('captures with a private one-time-key config and exit-trap revocation', () => {
    const script = fs.readFileSync(captureScriptPath, 'utf8');
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('umask 077');
    expect(script).toContain('mktemp -d "${TMPDIR:-/tmp}/relayhall-auth-baseline.XXXXXX"');
    expect(script).toContain('chmod 0600 "$SCOPED_KEY_CURL_CONFIG"');
    expect(script).toContain('unset SCOPED_KEY');
    expect(script).toContain('trap cleanup EXIT INT TERM');
    expect(script).toContain('$BASE_URL/credentials/$CREDENTIAL_ID/revoke');
    expect(script).toContain('args+=(--config "$PROBE_CURL_CONFIG")');
    expect(script).not.toContain('Authorization: Bearer $SCOPED_KEY');
    expect(script.match(/^\s*probe "/gm)).toHaveLength(39);
  });
});
