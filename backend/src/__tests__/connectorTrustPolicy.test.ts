/**
 * GET /connectors/trust-policy is NARROW-ONLY (universal harness connector
 * design v1.5 section 4.3, choice C5, check finding B3; owner ruling E462,
 * slice S3).
 *
 * - The board's ceiling IS the connector release's policy: deep-equal to
 *   cli/connector_trust_policy.json, and the pinned sha256 is that file's.
 * - The narrow-only rule is the connector's rule: both run the shared cases in
 *   cli/connector_trust_override_cases.json.
 * - Through the real router: a deployment override that tries to widen (a new
 *   publisher, a replaced signer, a lower minimum, a product the release does
 *   not trust) is never served, only named by path and code; a narrowing entry
 *   beside it is served.
 * - The route is registered on the one registry, with ceiling services:read,
 *   transport `any`, in the authorization manifest and in OpenAPI.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';

const mockConfig: Record<string, unknown> = {};
jest.mock('../config/relayhall', () => ({ ...jest.requireActual('../config/relayhall'), relayhallConfig: mockConfig }));

import connectorsRoutes from '../routes/connectors';
import {
  CONNECTOR_TRUST_OVERRIDE_SCHEMA, connectorTrustPolicyResponse, validateConnectorTrustOverride, versionTuple,
} from '../services/ConnectorTrustPolicy';
import { CONNECTOR_TRUST_CEILING, CONNECTOR_TRUST_CEILING_SHA256 } from '../services/connectorTrustCeiling';
import { requiredScopeFor } from '../utils/scopeMap';
import { routeTransportClassFor } from '../utils/transportMap';
import { PROTECTED_ROUTE_MOUNTS } from '../utils/authorizationRouteManifest';

const CLI = path.resolve(__dirname, '..', '..', '..', 'cli');
const CEILING_FILE = path.join(CLI, 'connector_trust_policy.json');
const CASES = JSON.parse(fs.readFileSync(path.join(CLI, 'connector_trust_override_cases.json'), 'utf8')).cases as Array<{
  name: string; override: unknown; accepted: unknown; rejected: Array<[string, string]>;
}>;

const sortPairs = (pairs: Array<[string, string]>) => [...pairs].sort((a, b) => (a.join('\0') < b.join('\0') ? -1 : 1));

describe('the board ceiling is the connector release ceiling', () => {
  it('is deep-equal to cli/connector_trust_policy.json and pins that file by sha256', () => {
    const raw = fs.readFileSync(CEILING_FILE);
    expect(crypto.createHash('sha256').update(raw).digest('hex')).toBe(CONNECTOR_TRUST_CEILING_SHA256);
    expect(JSON.parse(raw.toString('utf8'))).toEqual(CONNECTOR_TRUST_CEILING);
  });

  it('pins the same digest the connector module pins', () => {
    const source = fs.readFileSync(path.join(CLI, 'relayhall_connector_trust.py'), 'utf8');
    expect(source).toContain(`CEILING_SHA256 = "${CONNECTOR_TRUST_CEILING_SHA256}"`);
  });

  it('parses versions with the connector grammar', () => {
    expect(versionTuple('msix', '26.1016.8120.0')).toEqual([26, 1016, 8120, 0]);
    expect(versionTuple('msix', '26.1016.8120')).toBeNull();
    expect(versionTuple('msix', '70000.0.0.0')).toBeNull();
    expect(versionTuple('npm-native', '2.1.246')).toEqual([2, 1, 246]);
    expect(versionTuple('npm-native', '2.1.246-beta.1')).toBeNull();
  });
});

describe('narrow-only: the shared cases', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { accepted, rejected } = validateConnectorTrustOverride(c.override);
    expect(accepted).toEqual(c.accepted);
    expect(sortPairs(rejected.map((r) => [r.path, r.code] as [string, string]))).toEqual(sortPairs(c.rejected));
  });

  it('runs a non-trivial set: every refusal code is exercised', () => {
    const codes = new Set(CASES.flatMap((c) => c.rejected.map(([, code]) => code)));
    expect([...codes].sort()).toEqual([
      'OVERRIDE_LOWERS_MINIMUM', 'OVERRIDE_MALFORMED', 'OVERRIDE_UNKNOWN_FIELD', 'OVERRIDE_UNKNOWN_PRODUCT',
      'OVERRIDE_UNKNOWN_PUBLISHER', 'OVERRIDE_WIDENING_FIELD',
    ]);
  });
});

const EVIL_SUBJECT = 'CN="Evil Corp", O="Evil Corp", C=US';
const WIDENING = {
  schemaVersion: CONNECTOR_TRUST_OVERRIDE_SCHEMA,
  products: {
    codex: { windows: {
      publishers: [{ id: 'evil', binarySigner: { subject: EVIL_SUBJECT } }],
      binarySigner: { subject: EVIL_SUBJECT },
      minimumVersion: '1.0.0.0',
    } },
    'claude-code': { windows: { minimumVersion: '2.1.300', denyVersions: ['2.1.301'] } },
    'gemini-cli': { windows: { minimumVersion: '0.1.0' } },
  },
};

describe('GET /connectors/trust-policy through the real router', () => {
  let server: ReturnType<typeof express.application.listen>;
  let base: string;

  beforeAll((done) => {
    const app = express();
    app.use('/connectors', connectorsRoutes);
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  afterAll((done) => { server.close(done); });
  afterEach(() => { delete mockConfig.connectorTrustPolicy; });

  const get = async () => {
    const response = await fetch(`${base}/connectors/trust-policy`);
    return { status: response.status, headers: response.headers, text: await response.text() };
  };

  it('serves the release policy alone when the deployment configures nothing', async () => {
    const { status, text, headers } = await get();
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(text)).toEqual({
      schemaVersion: 'rh.connector-trust-policy/1', ceilingSha256: CONNECTOR_TRUST_CEILING_SHA256,
      source: 'none', override: null, rejected: [],
    });
  });

  it('REFUSES a widening attempt: nothing that widens is served, each entry is named, the narrowing is kept', async () => {
    mockConfig.connectorTrustPolicy = WIDENING;
    const { status, text } = await get();
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.source).toBe('deployment');
    expect(body.override).toEqual({ schemaVersion: CONNECTOR_TRUST_OVERRIDE_SCHEMA, products: {
      'claude-code': { windows: { minimumVersion: '2.1.300', denyVersions: ['2.1.301'] } } } });
    expect(sortPairs(body.rejected.map((r: { path: string; code: string }) => [r.path, r.code]))).toEqual(sortPairs([
      ['products.codex.windows.publishers', 'OVERRIDE_WIDENING_FIELD'],
      ['products.codex.windows.binarySigner', 'OVERRIDE_WIDENING_FIELD'],
      ['products.codex.windows.minimumVersion', 'OVERRIDE_LOWERS_MINIMUM'],
      ['products.gemini-cli.windows', 'OVERRIDE_UNKNOWN_PRODUCT'],
    ]));
    // A refused entry is named by path and code, never echoed.
    expect(text).not.toContain('Evil Corp');
    expect(text).not.toContain('1.0.0.0');
    expect(text).not.toContain('gemini-cli.windows.minimumVersion');
  });

  it('a wholly widening override serves no override at all', async () => {
    mockConfig.connectorTrustPolicy = { schemaVersion: CONNECTOR_TRUST_OVERRIDE_SCHEMA, products: {
      codex: { windows: { minimumVersion: '0.0.0.0', publishers: [] } } } };
    const body = JSON.parse((await get()).text);
    expect(body.override).toBeNull();
    expect(body.rejected.map((r: { code: string }) => r.code).sort()).toEqual(['OVERRIDE_LOWERS_MINIMUM', 'OVERRIDE_WIDENING_FIELD']);
  });

  it('a malformed configuration is refused whole, never half-read', async () => {
    mockConfig.connectorTrustPolicy = 'deny everything';
    expect(JSON.parse((await get()).text)).toMatchObject({ override: null, rejected: [{ path: '', code: 'OVERRIDE_MALFORMED' }] });
  });

  it('the response builder and the route agree', async () => {
    mockConfig.connectorTrustPolicy = WIDENING;
    expect(JSON.parse((await get()).text)).toEqual(JSON.parse(JSON.stringify(connectorTrustPolicyResponse())));
  });
});

describe('the route is registered once, with its ceiling', () => {
  it('rides services:read for GET and fails closed to root for anything else', () => {
    expect(requiredScopeFor('GET', '/connectors/trust-policy')).toBe('services:read');
    expect(requiredScopeFor('POST', '/connectors/trust-policy')).toBe('root');
    expect(requiredScopeFor('PUT', '/connectors/trust-policy')).toBe('root');
    expect(requiredScopeFor('GET', '/connectors/anything-else')).toBe('root');
  });

  it('is classified for every transport and is in the authorization manifest and OpenAPI', () => {
    expect(routeTransportClassFor('/connectors/trust-policy')).toBe('any');
    expect(PROTECTED_ROUTE_MOUNTS).toContain('/connectors');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PROTECTED_ROUTE_REGISTRATIONS } = require('../routeRegistry');
    expect(PROTECTED_ROUTE_REGISTRATIONS.filter((r: { path: string }) => r.path === '/connectors')).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildOpenApiSpec } = require('../openapi/spec');
    const spec = buildOpenApiSpec() as { paths: Record<string, Record<string, unknown>> };
    const entry = spec.paths['/connectors/trust-policy'] ?? {};
    expect(Object.keys(entry).filter((key) => !key.startsWith('x-'))).toEqual(['get']);
    expect(entry['x-transport-class']).toBe('any');
  });
});

describe('a refused harness binary reads as untrusted, not stale (design 4.2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { validateUsageQuota } = require('../types/UsageQuota');
  const base = {
    schemaVersion: 'rh.usage-quota/1', sourceProduct: 'claude-code', provider: 'claude-code',
    providerAccountId: 'anthropic-0123456789abcdef', label: 'Claude', observedAt: '2026-10-24T17:00:00.000Z',
    checkedAt: '2026-10-24T17:00:00.000Z', status: 'not-reported', windows: [],
  };
  const now = Date.parse('2026-10-24T17:00:30.000Z');

  it("accepts errorCode 'untrusted-binary' from the connector's collector", () => {
    expect(validateUsageQuota({ ...base, errorCode: 'untrusted-binary' }, now).errorCode).toBe('untrusted-binary');
  });

  it('still refuses any other code', () => {
    expect(() => validateUsageQuota({ ...base, errorCode: 'PROVIDER_READ' }, now)).toThrow();
    expect(() => validateUsageQuota({ ...base, errorCode: 'untrusted' }, now)).toThrow();
  });
});
