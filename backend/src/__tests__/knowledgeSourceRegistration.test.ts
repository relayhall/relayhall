/**
 * Card 08792425 (member N6, the core half of two-way registration; the
 * default-store design's choice C7). The fast-tier half: no database.
 *
 *   (B) the registration bundle: every refusal is NAMED and points at its field;
 *   (C) the fingerprint confirmation: a mismatch, a missing method and a typed
 *       colon form;
 *   (G) the gate on every route of the family, decided by the authentication
 *       KIND first: a root bearer, an Account bearer and the API key are
 *       refused as non-sessions; a non-administrator session is refused; root
 *       and an administrator session pass;
 *   (R) the return bundle and the state carry public material and NAMES only;
 *   (D) D7(a): nothing on the dial path reads the registration, so the
 *       confirmed fingerprint is never enforced at dial time and no installer
 *       CA is trusted; and nothing in the MCP registry names the family.
 *
 * The real-PostgreSQL half (the act, the audit rows, the step-up binding, the
 * duplicates and the dial refused until the reference resolves) is
 * knowledgeSourceRegistrationLive.test.ts.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

jest.mock('../db/connection', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));

import {
  buildReturnBundle, checkFingerprintConfirmation, credentialReferenceFor, credentialReferenceKey, displayFingerprint, KnowledgeSourceRegistrationError,
  normalizeFingerprint, parseAllowedNetworks, parseRegistrationBundle, publicJwk, registrationState, slugFrom,
  REGISTRATION_BUNDLE_SCHEMA, RETURN_BUNDLE_JWK_MEMBERS, type RegistrationRow,
} from '../services/KnowledgeSourceRegistration';
import { registrationStanding } from '../routes/knowledgeSourceRegistrations';
import { resetKnowledgeAssertionKeysetCache } from '../services/KnowledgeAssertionSigner';
import { recordLifecyclePublicKey } from '../services/KnowledgeLifecycleExporter';
import type { ServiceRecord } from '../services/ServiceRegistry';

const FINGERPRINT = 'ab'.repeat(32);
const DESCRIPTOR_V2 = {
  options: [],
  knowledgeSource: {
    classes: [{ key: 'notes', content: 'docs' }], compartments: [], protocol_version: 2,
    compartment_mode: 'dynamic-opaque', categories: ['relaybrain:note'],
  },
};

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: REGISTRATION_BUNDLE_SCHEMA,
    name: 'Team knowledge',
    endpoint: 'https://knowledge.example.org/knowledge/search',
    descriptor: DESCRIPTOR_V2,
    certificateSha256: FINGERPRINT,
    ...overrides,
  };
}

function refusalOf(work: () => unknown): { code: string; field?: string; status: number } {
  try {
    work();
  } catch (e) {
    if (e instanceof KnowledgeSourceRegistrationError) return { code: e.code, field: e.field, status: e.status };
    throw e;
  }
  // No refusal at all: answered as a value, so the caller's expect() is what fails.
  return { code: 'NO_REFUSAL', status: 0 };
}

describe('(B) the registration bundle is validated and every refusal is named', () => {
  it('accepts a v2 bundle and derives the slug, the reference name and the bundle digest', () => {
    const parsed = parseRegistrationBundle(bundle(), []);
    expect(parsed.slug).toBe('team-knowledge');
    expect(parsed.certificateSha256).toBe(FINGERPRINT);
    expect(parsed.endpoint).toBe('https://knowledge.example.org/knowledge/search');
    expect(parsed.getEndpoint).toBeNull();
    expect(parsed.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(credentialReferenceFor(parsed.slug)).toBe('knowledge-source/team-knowledge');
    // The same bundle as JSON text parses to the same thing.
    expect(parseRegistrationBundle(JSON.stringify(bundle()), []).bundleSha256).toBe(parsed.bundleSha256);
  });

  it.each([
    ['not JSON', '{not json', 'REGISTRATION_BUNDLE_INVALID', 'bundle'],
    ['an array', [], 'REGISTRATION_BUNDLE_INVALID', 'bundle'],
    ['an unknown field', bundle({ channelBearer: 'x' }), 'REGISTRATION_BUNDLE_INVALID', 'bundle.channelBearer'],
    ['another schema', bundle({ schema: 'rh.something/1' }), 'REGISTRATION_BUNDLE_SCHEMA_UNSUPPORTED', 'bundle.schema'],
    ['no name', bundle({ name: '  ' }), 'REGISTRATION_BUNDLE_INVALID', 'bundle.name'],
    ['a malformed fingerprint', bundle({ certificateSha256: 'abc' }), 'REGISTRATION_FINGERPRINT_INVALID', 'bundle.certificateSha256'],
    ['no fingerprint', bundle({ certificateSha256: undefined }), 'REGISTRATION_FINGERPRINT_INVALID', 'bundle.certificateSha256'],
    ['an http endpoint', bundle({ endpoint: 'http://knowledge.example.org/search' }), 'KNOWLEDGE_ENDPOINT_SCHEME_REFUSED', 'bundle.endpoint'],
    ['a loopback endpoint', bundle({ endpoint: 'https://127.0.0.1/search' }), 'KNOWLEDGE_ENDPOINT_ADDRESS_REFUSED', 'bundle.endpoint'],
    ['a private endpoint without allowed networks', bundle({ endpoint: 'https://100.64.0.7/search' }), 'KNOWLEDGE_ENDPOINT_ADDRESS_REFUSED', 'bundle.endpoint'],
    ['an invalid descriptor', bundle({ descriptor: { tools: [] } }), 'DESCRIPTOR_INVALID_OPTIONS', 'bundle.descriptor.options'],
    ['a v1 descriptor', bundle({ descriptor: { options: [], knowledgeSource: { classes: [{ key: 'notes', content: 'docs' }], compartments: ['corpus'] } } }),
      'REGISTRATION_DESCRIPTOR_NOT_V2', 'bundle.descriptor.knowledgeSource'],
    ['no knowledge block', bundle({ descriptor: { options: [] } }), 'REGISTRATION_DESCRIPTOR_NOT_V2', 'bundle.descriptor.knowledgeSource'],
  ])('refuses %s by name', (_label, raw, code, field) => {
    expect(refusalOf(() => parseRegistrationBundle(raw, []))).toMatchObject({ code, field });
  });

  it('refuses a bundle past its byte bound with 413', () => {
    expect(refusalOf(() => parseRegistrationBundle(JSON.stringify(bundle({ description: 'x'.repeat(400 * 1024) })), [])))
      .toMatchObject({ code: 'REGISTRATION_BUNDLE_TOO_LARGE', status: 413 });
  });

  it('admits a private endpoint only inside the allowed networks the administrator gave, never loopback', () => {
    const networks = parseAllowedNetworks(['100.64.0.0/24']);
    expect(parseRegistrationBundle(bundle({ endpoint: 'https://100.64.0.7/search' }), networks).endpoint).toBe('https://100.64.0.7/search');
    expect(refusalOf(() => parseAllowedNetworks(['127.0.0.0/8']))).toMatchObject({ code: 'KNOWLEDGE_NETWORK_NEVER_ADMISSIBLE', field: 'bundle.allowedNetworks' });
  });
});

describe('(C) the fingerprint confirmation', () => {
  const parsed = parseRegistrationBundle(bundle(), []);

  it('normalizes the forms an installer prints and displays colon pairs', () => {
    expect(normalizeFingerprint(FINGERPRINT.toUpperCase())).toBe(FINGERPRINT);
    expect(normalizeFingerprint(displayFingerprint(FINGERPRINT))).toBe(FINGERPRINT);
    expect(normalizeFingerprint(`sha256 Fingerprint=${displayFingerprint(FINGERPRINT)}`)).toBe(FINGERPRINT);
    expect(normalizeFingerprint('sha256:' + FINGERPRINT)).toBe(FINGERPRINT);
    expect(normalizeFingerprint('ab'.repeat(31))).toBeNull();
    expect(displayFingerprint(FINGERPRINT)).toBe(Array(32).fill('AB').join(':'));
  });

  it('records how it was confirmed, and refuses a mismatch or a missing method by name', () => {
    expect(checkFingerprintConfirmation(parsed, displayFingerprint(FINGERPRINT), 'typed')).toBe('typed');
    expect(checkFingerprintConfirmation(parsed, FINGERPRINT, 'checked')).toBe('checked');
    expect(refusalOf(() => checkFingerprintConfirmation(parsed, 'cd'.repeat(32), 'checked')))
      .toMatchObject({ code: 'REGISTRATION_FINGERPRINT_NOT_CONFIRMED', field: 'confirmedFingerprint' });
    expect(refusalOf(() => checkFingerprintConfirmation(parsed, undefined, 'checked')))
      .toMatchObject({ code: 'REGISTRATION_FINGERPRINT_NOT_CONFIRMED' });
    expect(refusalOf(() => checkFingerprintConfirmation(parsed, FINGERPRINT, undefined)))
      .toMatchObject({ code: 'REGISTRATION_CONFIRMATION_INVALID', field: 'confirmation' });
  });

  it('folds a reference name the way a person reads it: case, Unicode forms, marks, invisible characters, whitespace, separators', () => {
    const key = credentialReferenceKey('knowledge-source/team-knowledge');
    expect(key).toBe('knowledge-source/team-knowledge');
    for (const same of [
      'Knowledge-Source/Team-Knowledge', 'knowledge_source/team.knowledge', ' knowledge-source / team knowledge ',
      'knowledge:source//team--knowledge', '\uFF4Bnowledge-source/team-knowledge', 'knowledge-source/te\u200Bam-knowledge',
      'knowledge-source/te\u0301am-knowledge', 'knowledge-source/team-knowledge/',
    ]) expect({ same, key: credentialReferenceKey(same) }).toEqual({ same, key });
    for (const other of ['knowledge-source/team-knowledge-2', 'knowledge-source/teamknowledge', 'knowledge/source-team-knowledge']) {
      expect({ other, differs: credentialReferenceKey(other) !== key }).toEqual({ other, differs: true });
    }
  });

  it('derives a slug the registry accepts from any name', () => {
    expect(slugFrom('Relay Brain (default store)')).toBe('relay-brain-default-store');
    expect(slugFrom('***')).toBe('knowledge-source');
    expect(slugFrom('x'.repeat(100)).length).toBe(64);
  });
});

describe('(G) the gate is the authentication kind first, then root or an administrator', () => {
  const base = { principal: { id: 'p1', role: 'admin' }, userId: 'someone', sessionRole: null };
  const standing = (req: Record<string, unknown>) => registrationStanding(req as any);

  it.each([
    ['a root bearer', { ...base, authMethod: 'principal_api_key', scopes: ['root'] }],
    ['an Account bearer', { ...base, authMethod: 'principal_api_key', scopes: ['services:write'] }],
    ['the legacy API key', { ...base, authMethod: 'legacy_api_key', scopes: ['root'] }],
    ['the reports key', { ...base, authMethod: 'reports_read_key', scopes: [] }],
  ])('refuses %s as a non-session', (_label, req) => {
    expect(standing(req)).toMatchObject({ ok: false, status: 403, code: 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION' });
  });

  it('refuses a session with no resolved principal, and a non-administrator session', () => {
    expect(standing({ authMethod: 'session', scopes: ['root'] })).toMatchObject({ ok: false, code: 'PRINCIPAL_REQUIRED' });
    expect(standing({ ...base, authMethod: 'session', principal: { id: 'p2', role: 'editor' }, scopes: ['tasks:read'] }))
      .toMatchObject({ ok: false, status: 403, code: 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_ADMINISTRATOR' });
  });

  it('admits root and an administrator login session', () => {
    expect(standing({ ...base, authMethod: 'session', scopes: ['root'] })).toEqual({ ok: true, standing: 'root' });
    expect(standing({ ...base, authMethod: 'session', principal: { id: 'p3', role: 'operator' }, scopes: ['tasks:read'] }))
      .toEqual({ ok: true, standing: 'administrator' });
    expect(standing({ ...base, authMethod: 'dashboard_jwt', principal: { id: 'p4', role: null }, userId: 'dashboard_user', scopes: [] }))
      .toEqual({ ok: true, standing: 'administrator' });
  });
});

describe('(R) the return bundle and the state carry public material and names only', () => {
  const BEARER = `bearer-${crypto.randomBytes(16).toString('hex')}`;
  const assertionKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const lifecycleKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const saved = { ...process.env };
  const service = {
    id: '11111111-2222-4333-8444-555555555555', slug: 'team-knowledge', name: 'Team knowledge', status: 'published',
    currentDescriptorVersion: 1, knowledgeQueryEndpoint: 'https://knowledge.example.org/knowledge/search',
    knowledgeGetEndpoint: null, knowledgeWriteEndpoint: null, knowledgeCoreCredentialRef: 'knowledge-source/team-knowledge',
    knowledgeAllowedNetworks: [],
  } as unknown as ServiceRecord;
  const row: RegistrationRow = {
    service_id: service.id, certificate_sha256: FINGERPRINT, fingerprint_confirmation: 'checked',
    confirmed_by: '99999999-2222-4333-8444-555555555555', confirmed_at: new Date('2026-10-21T12:00:00Z'),
    bundle_sha256: 'cd'.repeat(32), step_up_token_id: '88888888-2222-4333-8444-555555555555',
  };

  beforeAll(() => {
    process.env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS = JSON.stringify({
      k1: assertionKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    });
    process.env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY = 'k1';
    resetKnowledgeAssertionKeysetCache();
    recordLifecyclePublicKey(service.id, 'lc1', lifecycleKey);
  });
  afterAll(() => {
    process.env = saved;
    resetKnowledgeAssertionKeysetCache();
  });
  afterEach(() => { delete process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS; });

  const privateScalars = [assertionKey, lifecycleKey].map((key) => String((key.export({ format: 'jwk' }) as Record<string, string>).d));

  it('carries the audience, the issuer, the public assertion and lifecycle keys, and no secret', () => {
    process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS = JSON.stringify({ [service.knowledgeCoreCredentialRef as string]: { bearer: BEARER } });
    const returned = buildReturnBundle(service, row, 'https://board.example.org');
    expect(returned).toMatchObject({
      schema: 'rh.knowledge-source.return/1', serviceId: service.id, audience: service.id, issuer: 'https://board.example.org',
      certificateSha256: FINGERPRINT, credentialReference: 'knowledge-source/team-knowledge',
    });
    expect(returned.assertionKeys.keys).toHaveLength(1);
    expect(returned.assertionKeys.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: 'k1', alg: 'EdDSA', use: 'sig' });
    expect(returned.lifecycleKey).toMatchObject({ kid: 'lc1', jwk: { kty: 'OKP', crv: 'Ed25519', kid: 'lc1' } });
    const bytes = JSON.stringify(returned);
    for (const jwk of [...returned.assertionKeys.keys, returned.lifecycleKey!.jwk]) {
      expect(Object.keys(jwk).filter((member) => !(RETURN_BUNDLE_JWK_MEMBERS as readonly string[]).includes(member))).toEqual([]);
    }
    expect(bytes).not.toContain(BEARER);
    for (const scalar of privateScalars) expect(bytes).not.toContain(scalar);
    expect(bytes).not.toMatch(/PRIVATE KEY|"d":/);
  });

  it('cuts a JWK down to its public members', () => {
    expect(publicJwk({ kty: 'OKP', crv: 'Ed25519', x: 'X', d: 'D', kid: 'k', extra: 'e', alg: 'EdDSA', use: 'sig' }))
      .toEqual({ kty: 'OKP', crv: 'Ed25519', x: 'X', kid: 'k', alg: 'EdDSA', use: 'sig' });
  });

  it('refuses, never mangles, a key that is not Ed25519: an EC or RSA key would lose public members', () => {
    const ec = crypto.createPublicKey(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey).export({ format: 'jwk' });
    const rsa = crypto.createPublicKey(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey).export({ format: 'jwk' });
    for (const jwk of [{ ...ec, kid: 'ec1' }, { ...rsa, kid: 'rsa1' }, { kty: 'OKP', crv: 'X25519', x: 'X', kid: 'x1' }, { kty: 'OKP', crv: 'Ed25519', kid: 'nox' }]) {
      expect({ kid: jwk.kid, refusal: refusalOf(() => publicJwk(jwk as Record<string, unknown>)) })
        .toMatchObject({ kid: jwk.kid, refusal: { code: 'RETURN_BUNDLE_KEY_UNSUPPORTED', status: 503 } });
    }
    // A lifecycle key recorded from an EC key refuses the whole return bundle by name.
    const ecService = { ...service, id: '22222222-2222-4333-8444-555555555555' } as unknown as ServiceRecord;
    recordLifecyclePublicKey(ecService.id, 'lc-ec', crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
    expect(refusalOf(() => buildReturnBundle(ecService, { ...row, service_id: ecService.id }, 'https://board.example.org')))
      .toMatchObject({ code: 'RETURN_BUNDLE_KEY_UNSUPPORTED', status: 503 });
  });

  it('shows the dial refused until the reference resolves, the operator step by name, and never the value', () => {
    const waiting = registrationState(service, row);
    expect(waiting.channel).toEqual({
      credentialReference: 'knowledge-source/team-knowledge', environmentVariable: 'RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS',
      resolves: false, dial: 'refused', refusal: 'unavailable:transport',
    });
    expect(waiting.operatorSteps.map((step) => [step.id, step.done])).toEqual([['place-channel-bearer', false], ['restart-core', false]]);
    expect(waiting.operatorSteps[0].text).toContain('"knowledge-source/team-knowledge"');
    expect(waiting.operatorSteps[0].text).toContain('RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS');
    expect(waiting.fingerprint).toMatchObject({ sha256: FINGERPRINT, confirmation: 'checked', confirmedAt: '2026-10-21T12:00:00.000Z' });
    expect(waiting.grantsForApproval).toEqual({
      scope: 'knowledge-contents:read', targetType: 'grant.rows', decidedOn: '/approvals',
      change: { rules: [{ resourceType: 'service', selectorForm: 'exact', selectorIds: [service.id], verbs: ['read'] }] },
      direct: { surface: '/settings/access', granteeType: 'principal', resourceType: 'service', resourceId: service.id, verb: 'read' },
    });

    process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS = JSON.stringify({ [service.knowledgeCoreCredentialRef as string]: { bearer: BEARER } });
    const ready = registrationState(service, row);
    expect(ready.channel).toMatchObject({ resolves: true, dial: 'ready', refusal: null });
    expect(ready.operatorSteps.every((step) => step.done)).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(BEARER);
  });
});

describe('(D) D7(a): the dial path never reads the registration, and MCP never names the family', () => {
  const read = (relative: string) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

  it('no dial-path module reads the confirmed fingerprint or the registration table', () => {
    const dialPath = fs.readdirSync(path.join(__dirname, '..', 'services'))
      .filter((file) => /^Knowledge(DialClient|FanoutExecutor|GetExecutor|WriteExecutor|ChannelAuth|SourcePolicy|SourceService)\.ts$/.test(file));
    expect(dialPath).toHaveLength(7);
    for (const file of dialPath) {
      const source = read(path.join('services', file));
      expect({ file, reads: /certificate_sha256|certificateSha256|knowledge_source_registrations|KnowledgeSourceRegistration/.test(source) })
        .toEqual({ file, reads: false });
    }
    // The production dial leaves `ca` to Node's default trust store; the one
    // seam that sets it is the test-only option, unchanged by this card.
    expect(read('services/KnowledgeDialClient.ts')).toContain("...(options.trustAnchors !== undefined ? { ca: options.trustAnchors } : {}),");
    expect(read('services/KnowledgeSourceRegistration.ts')).not.toMatch(/trustAnchors|\bca:/);
  });

  it('no MCP tool reaches the registration routes', () => {
    expect(read('mcp/registry.ts')).not.toContain('knowledge-source-registrations');
  });
});
