/**
 * RH-P3.C4 subtask [3] — the version-pinned disposable skill cache can
 * actually revalidate.
 *
 * Strategy 4e40f06f §2.10, cache doctrine [RATIFIED 2026-08-02 — C3]:
 * "keep nothing local" gives way to a version-pinned DISPOSABLE skill cache —
 * "etag revalidation at session start" (its words; the session it means is an
 * AGENT session). The route already emitted an `ETag` and then ignored
 * `If-None-Match`, so the tag was a value no caller could ever spend: every
 * agent session start refetched every pinned SKILL.md in full.
 * An etag header without a 304 is not etag support, and the doctrine is
 * unimplementable without one.
 *
 * The security-relevant half is the ORDER: authorization runs first, so a
 * caller who may not read a version gets that version's error and never a
 * 304 — which would otherwise confirm that the content they hold is current.
 */
import { skillManager } from '../services/SkillManager';
import { principalService, type Principal, type PrincipalCredential } from '../services/PrincipalService';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { dispatchInProcess } from '../mcp/inProcess';

const SKILL = '55555555-5555-4555-8555-555555555555';
const VERSION = '3';
const SHA = 'a'.repeat(64);
const ETAG = `"${SHA}"`;
const TOKEN = 'rh_dev_keyid01.secretsecretsecretsecret';
const BEARER = `Bearer ${TOKEN}`;

function authenticateWith(scopes: string[]): void {
  const principal: Principal = {
    id: '66666666-6666-4666-8666-666666666666', kind: 'service', handle: 'connector_one',
    displayName: null, status: 'active', role: 'agent', boundTaskId: null, purpose: null,
    legacyIdentity: false, ownExpression: null, sourceTag: null, harness: null,
    personalityId: null, parentPrincipalId: null, lastSeenAt: null, metadata: {},
  };
  const credential: PrincipalCredential = {
    id: '77777777-7777-4777-8777-777777777777', principalId: principal.id, credentialType: 'api_key',
    keyId: 'keyid01', scopes, expiresAt: null, revokedAt: null, transport: 'mcp',
    graceUntil: null, metadata: {},
  };
  jest.spyOn(principalService, 'authenticatePrincipalKey').mockResolvedValue({ principal, credential });
}

const contentPath = `/skills/${SKILL}/versions/${VERSION}/content`;

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(principalService, 'bumpLastSeen').mockImplementation(() => undefined as never);
  // The per-row grant check needs a database; the route ceiling above it is
  // what this suite is about, so the row is granted and the scope gate is not.
  jest.spyOn(authorizationRepository, 'authorizePoint').mockResolvedValue({ exists: true, allowed: true } as never);
  authenticateWith(['skills:use', 'skills:read']);
  jest.spyOn(skillManager, 'getVersion').mockResolvedValue({
    id: 'version-row', skill_id: SKILL, version: 3, content: '# SKILL.md\nbody',
    content_sha256: SHA, status: 'published',
  } as never);
});

describe('etag revalidation on the full-content surface', () => {
  it('emits an ETag a caller can spend', async () => {
    const first = await dispatchInProcess({ method: 'GET', path: contentPath, authorization: BEARER });
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe(ETAG);
    expect(first.body).toMatchObject({ success: true });
  });

  it('answers 304 with no body when the caller already holds this version', async () => {
    const revalidated = await dispatchInProcess({
      method: 'GET', path: contentPath, authorization: BEARER, headers: { 'If-None-Match': ETAG },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.body).toBeUndefined();
    // The tag still comes back, so a cache can keep pinning it.
    expect(revalidated.headers.etag).toBe(ETAG);
  });

  it('matches weakly, accepts a list, and honours *', async () => {
    for (const header of [`W/${ETAG}`, `"other", ${ETAG}`, '*']) {
      const result = await dispatchInProcess({
        method: 'GET', path: contentPath, authorization: BEARER, headers: { 'If-None-Match': header },
      });
      expect([header, result.status]).toEqual([header, 304]);
    }
  });

  it('resends in full when the pinned version changed under the caller', async () => {
    const stale = await dispatchInProcess({
      method: 'GET', path: contentPath, authorization: BEARER,
      headers: { 'If-None-Match': `"${'b'.repeat(64)}"` },
    });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ success: true });
  });

  it('AUTHORIZES FIRST: a caller without skills:use is refused, never told 304', async () => {
    // The control that matters. If the comparison ran before the scope gate,
    // a caller who may not read this content could still learn that the copy
    // they hold is current — a disclosure the 403 exists to prevent.
    authenticateWith(['skills:read']);
    const refused = await dispatchInProcess({
      method: 'GET', path: contentPath, authorization: BEARER, headers: { 'If-None-Match': ETAG },
    });
    expect(refused.status).toBe(403);
    expect(refused.status).not.toBe(304);
  });

  it('and a version the caller cannot see errors rather than 304s', async () => {
    jest.spyOn(skillManager, 'getVersion').mockRejectedValue(
      Object.assign(new Error('not found'), { name: 'SkillContractError', status: 404, code: 'SKILL_NOT_FOUND' }),
    );
    const missing = await dispatchInProcess({
      method: 'GET', path: contentPath, authorization: BEARER, headers: { 'If-None-Match': ETAG },
    });
    expect(missing.status).not.toBe(304);
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });
});
