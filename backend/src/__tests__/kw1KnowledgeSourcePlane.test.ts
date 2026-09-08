/**
 * RH-KW1 candidate A — KNOWLEDGE-DESIGN `94747de9` ACCEPTANCE ITEM 6,
 * "Endpoint/config integrity", plus body-sourced drill BD-1 (breakdown
 * `abc71ffb` §2) and the "stated ONCE" property §4.2 asserts of itself.
 *
 * Item 6, verbatim from §11:
 *
 *   "a `services:write` credential setting/changing any §4.2 field refused;
 *    setting an endpoint while the descriptor has no `knowledgeSource` block
 *    OR an empty compartment list refused at set time (sol R1-3); registering
 *    an external source without a core-credential arrangement refused in BOTH
 *    claims modes (sol R1-2); a descriptor publish changes routing only via
 *    declared classes."
 *
 * BD-1, verbatim from §9: "§11.11 mutation-drills the reserved arm itself (a
 * non-reserved row with no endpoints must NOT become capable)". The design
 * cites §11.11, whose item text carries no such clause; breakdown §2 records
 * it as a body-sourced acceptance clause and assigns it HERE, because the
 * reserved arm ships with the predicate in candidate A.
 */
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));

import { pool } from '../db/connection';
import {
  KNOWLEDGE_OWNER_PLANE_FIELDS,
  ServiceRegistry,
  ServiceRegistryError,
} from '../services/ServiceRegistry';
import { validateDescriptor, DescriptorError } from '../utils/serviceDescriptor';
import {
  isKnowledgeCapable,
  KNOWLEDGE_BOARD_SOURCE_SLUG,
  RESERVED_SERVICE_SLUGS,
} from '../services/KnowledgeSourcePolicy';
import { KnowledgeSourceService } from '../services/KnowledgeSourceService';
import { requiredScopeFor, ALL_SCOPES, MINTABLE_SCOPES } from '../utils/scopeMap';
import { loadMutatedModule, readShippedSource } from './support/moduleMutation';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { authorizationService } from '../services/AuthorizationService';
import fs from 'fs';
import path from 'path';

const SERVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVISION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDPOINT = 'https://engine.example.com/knowledge/query';

const registry = new ServiceRegistry();

const KNOWLEDGE_BLOCK = {
  classes: [{ key: 'docs', content: 'docs' as const }],
  compartments: ['corpus'],
};

interface FakeState {
  head: Record<string, unknown> | null;
  versions: Array<{ service_id: string; version: number; descriptor: unknown; content_hash: string }>;
  updates: string[];
}

let state: FakeState;

function headRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SERVICE_ID,
    slug: 'engine',
    name: 'Engine',
    description: '',
    kind: 'service',
    runtime_mode: 'direct',
    status: 'published',
    visibility_tier: 'unrestricted',
    delivery_mode: 'none',
    delivery_endpoint: null,
    delivery_secret: null,
    delivery_poll_interval_seconds: null,
    telemetry_tier: 'none',
    current_descriptor_version: null,
    knowledge_query_endpoint: null,
    knowledge_get_endpoint: null,
    knowledge_core_credential_ref: null,
    knowledge_claims_mode: 'asserted',
    knowledge_subject_mode: 'pairwise',
    knowledge_relevant_groups: [],
    knowledge_allowed_networks: [],
    revision: REVISION,
    created_by_principal_id: 'owner',
    updated_by_principal_id: 'owner',
    created_at: 'now',
    updated_at: 'now',
    retired_at: null,
    ...overrides,
  };
}

function armPool(): void {
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.startsWith('SELECT * FROM services WHERE id = $1')) {
      return { rows: state.head ? [state.head] : [] };
    }
    if (sql.startsWith('SELECT descriptor FROM service_descriptor_versions')) {
      const found = state.versions.find((v) => v.service_id === params[0] && v.version === params[1]);
      return { rows: found ? [{ descriptor: found.descriptor }] : [] };
    }
    if (sql.startsWith('SELECT content_hash FROM service_descriptor_versions')) {
      const found = state.versions.find((v) => v.service_id === params[0] && v.version === params[1]);
      return { rows: found ? [{ content_hash: found.content_hash }] : [] };
    }
    if (sql.startsWith('SELECT COALESCE(MAX(version), 0) + 1')) {
      const max = state.versions.reduce((m, v) => Math.max(m, v.version), 0);
      return { rows: [{ next: max + 1 }] };
    }
    if (sql.startsWith('INSERT INTO service_descriptor_versions')) {
      const row = {
        id: `version-${params[1]}`,
        service_id: params[0] as string,
        version: params[1] as number,
        descriptor: JSON.parse(params[2] as string),
        content_hash: params[3] as string,
        created_by_principal_id: params[4],
        created_at: 'now',
        retired_at: null,
      };
      state.versions.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('UPDATE services')) {
      state.updates.push(sql);
      const next = headRow({ ...state.head, revision: 'rotated' });
      // Reflect the SET list onto the row so a read-back is honest.
      const columns = /UPDATE services SET (.*?) WHERE id = \$1/.exec(sql)?.[1] ?? '';
      columns.split(',').map((c) => c.trim()).forEach((assignment) => {
        const match = /^([a-z_]+) = \$(\d+)$/.exec(assignment);
        if (match) next[match[1]] = params[Number(match[2]) - 1];
      });
      state.head = next;
      return { rows: [next] };
    }
    return { rows: [] };
  };
  (pool.query as jest.Mock).mockImplementation(query);
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
}

beforeEach(() => {
  state = { head: headRow(), versions: [], updates: [] };
  armPool();
});

/** Publish a descriptor version and point the head at it. */
function seedDescriptor(descriptor: unknown, version = 1): void {
  state.versions.push({ service_id: SERVICE_ID, version, descriptor, content_hash: `hash-${version}` });
  state.head = headRow({ ...state.head, current_descriptor_version: version });
}

async function refusal(act: Promise<unknown>): Promise<ServiceRegistryError> {
  try {
    await act;
  } catch (e) {
    return e as ServiceRegistryError;
  }
  throw new Error('the act was expected to be refused and was not');
}

// ══════ item 6 clause 1 — services:write cannot reach any §4.2 field ═══════

describe('item 6 clause 1 — a services:write credential cannot set any §4.2 field', () => {
  it('routes the owner-plane path to the ROOT sentinel, and the agent plane to services:write', () => {
    expect(requiredScopeFor('PATCH', `/services/${SERVICE_ID}/owner-plane`)).toBe('root');
    // The contrast that makes the claim mean something: the ordinary write
    // surface of the SAME family is agent-plane.
    expect(requiredScopeFor('PATCH', `/services/${SERVICE_ID}`)).toBe('services:write');
    expect(requiredScopeFor('POST', '/services')).toBe('services:write');
  });

  it('accepts the seven fields on the owner-plane seat ONLY', () => {
    const routeSource = readShippedSource('routes/services.ts');
    // The owner-plane call spreads the registry's own declaration; the
    // agent-plane calls list their keys literally and name none of ours.
    expect(routeSource).toContain('...KNOWLEDGE_OWNER_PLANE_FIELDS,');
    for (const field of KNOWLEDGE_OWNER_PLANE_FIELDS) {
      // The literal name must not appear in any checkBodyKeys ARRAY other
      // than through the spread — a second occurrence would be a second seat.
      expect(routeSource.split(`'${field}'`).length - 1).toBe(0);
    }
    expect(KNOWLEDGE_OWNER_PLANE_FIELDS).toHaveLength(7);
  });

  it('MUTATION: with the owner-plane scope rule removed, the seat falls to services:write', () => {
    const mutant = loadMutatedModule<typeof import('../utils/scopeMap')>('utils/scopeMap.ts', [{
      find: "  { pattern: /^\\/services\\/[^/]+\\/owner-plane$/, scope: 'root' },\n",
      replace: '',
    }]);
    expect(mutant.requiredScopeFor('PATCH', `/services/${SERVICE_ID}/owner-plane`)).toBe('services:write');
  });
});

// ═══ item 6 clauses 2 and 3 — the endpoint needs a block with compartments ══

describe('item 6 clauses 2 and 3 — no half-configured state can exist', () => {
  it('refuses an endpoint when the descriptor carries NO knowledgeSource block', async () => {
    seedDescriptor({ options: [] });
    const error = await refusal(registry.updateOwnerPlane(
      SERVICE_ID,
      { knowledgeQueryEndpoint: ENDPOINT, knowledgeCoreCredentialRef: 'engine/core-client' },
      REVISION,
      'owner',
    ));
    expect(error.code).toBe('KNOWLEDGE_DESCRIPTOR_BLOCK_REQUIRED');
    expect(state.updates).toHaveLength(0);
  });

  it('refuses an endpoint when the service has no descriptor at all', async () => {
    const error = await refusal(registry.updateOwnerPlane(
      SERVICE_ID,
      { knowledgeQueryEndpoint: ENDPOINT, knowledgeCoreCredentialRef: 'engine/core-client' },
      REVISION,
      'owner',
    ));
    expect(error.code).toBe('KNOWLEDGE_DESCRIPTOR_BLOCK_REQUIRED');
  });

  it('refuses an endpoint against a stored block whose compartment list is EMPTY', async () => {
    // A row in this shape cannot be produced through the descriptor validator
    // (see the next test); it is written directly so the PREDICATE is what is
    // measured, not the validator that normally prevents it.
    seedDescriptor({ options: [], knowledgeSource: { classes: KNOWLEDGE_BLOCK.classes, compartments: [] } });
    const error = await refusal(registry.updateOwnerPlane(
      SERVICE_ID,
      { knowledgeQueryEndpoint: ENDPOINT, knowledgeCoreCredentialRef: 'engine/core-client' },
      REVISION,
      'owner',
    ));
    expect(error.code).toBe('KNOWLEDGE_DESCRIPTOR_BLOCK_REQUIRED');
  });

  it('refuses an EMPTY compartment list in the descriptor validator itself (sol R1-3)', () => {
    expect(() => validateDescriptor({ options: [], knowledgeSource: { classes: KNOWLEDGE_BLOCK.classes, compartments: [] } }))
      .toThrow(DescriptorError);
    // …and admits the canonical single-compartment declaration §4.3 names.
    const ok = validateDescriptor({ options: [], knowledgeSource: KNOWLEDGE_BLOCK });
    expect(ok.knowledgeSource).toEqual(KNOWLEDGE_BLOCK);
  });

  it('ADMITS the endpoint once the block is present, and stores all seven fields', async () => {
    seedDescriptor({ options: [], knowledgeSource: KNOWLEDGE_BLOCK });
    const updated = await registry.updateOwnerPlane(
      SERVICE_ID,
      {
        knowledgeQueryEndpoint: ENDPOINT,
        knowledgeCoreCredentialRef: 'engine/core-client',
        knowledgeClaimsMode: 'none',
        knowledgeSubjectMode: 'direct',
        knowledgeAllowedNetworks: ['10.0.0.0/8'],
      },
      REVISION,
      'owner',
    );
    expect(updated.knowledgeQueryEndpoint).toBe(ENDPOINT);
    expect(updated.knowledgeCoreCredentialRef).toBe('engine/core-client');
    expect(updated.knowledgeClaimsMode).toBe('none');
    expect(updated.knowledgeSubjectMode).toBe('direct');
    expect(updated.knowledgeAllowedNetworks).toEqual(['10.0.0.0/8']);
    expect(state.updates).toHaveLength(1);
  });

  it('refuses a get endpoint with no query endpoint', async () => {
    seedDescriptor({ options: [], knowledgeSource: KNOWLEDGE_BLOCK });
    const error = await refusal(registry.updateOwnerPlane(
      SERVICE_ID,
      { knowledgeGetEndpoint: 'https://engine.example.com/knowledge/get' },
      REVISION,
      'owner',
    ));
    expect(error.code).toBe('KNOWLEDGE_ENDPOINT_INCOMPLETE');
  });

  it('MUTATION: with the descriptor-block check removed, the half-configured state is written', async () => {
    seedDescriptor({ options: [] });
    const mutantRegistry = loadMutatedModule<typeof import('../services/ServiceRegistry')>(
      'services/ServiceRegistry.ts',
      [{
        find: "            if (!isKnowledgeCapable({ slug: head.slug, knowledgeQueryEndpoint: queryEndpoint }, block)) {",
        replace: '            if (false) {',
      }],
      { '../db/connection': { pool } },
    );
    const mutant = new mutantRegistry.ServiceRegistry();
    const updated = await mutant.updateOwnerPlane(
      SERVICE_ID,
      { knowledgeQueryEndpoint: ENDPOINT, knowledgeCoreCredentialRef: 'engine/core-client' },
      REVISION,
      'owner',
    );
    expect(updated.knowledgeQueryEndpoint).toBe(ENDPOINT);
    // The forbidden state now exists on the row — and the READER still
    // refuses it, which is the fail-closed half §4.2 asks for.
    expect(isKnowledgeCapable({ slug: 'engine', knowledgeQueryEndpoint: ENDPOINT }, null)).toBe(false);
  });
});

// ═════ item 6 clause 4 — the core credential is required in BOTH modes ═════

describe('item 6 clause 4 — an external source without a core-credential arrangement is refused', () => {
  it.each(['asserted', 'none'])('refuses in claims mode %s', async (mode) => {
    seedDescriptor({ options: [], knowledgeSource: KNOWLEDGE_BLOCK });
    const error = await refusal(registry.updateOwnerPlane(
      SERVICE_ID,
      { knowledgeQueryEndpoint: ENDPOINT, knowledgeClaimsMode: mode },
      REVISION,
      'owner',
    ));
    expect(error.code).toBe('KNOWLEDGE_CREDENTIAL_REQUIRED');
    expect(state.updates).toHaveLength(0);
  });

  it('refuses CLEARING the credential reference out from under a live endpoint', async () => {
    seedDescriptor({ options: [], knowledgeSource: KNOWLEDGE_BLOCK });
    state.head = headRow({
      ...state.head,
      knowledge_query_endpoint: ENDPOINT,
      knowledge_core_credential_ref: 'engine/core-client',
    });
    const error = await refusal(registry.updateOwnerPlane(
      SERVICE_ID,
      { knowledgeCoreCredentialRef: null },
      REVISION,
      'owner',
    ));
    expect(error.code).toBe('KNOWLEDGE_CREDENTIAL_REQUIRED');
  });

  it('MUTATION: with the credential requirement removed, an unauthenticated source registers', async () => {
    seedDescriptor({ options: [], knowledgeSource: KNOWLEDGE_BLOCK });
    const mutantRegistry = loadMutatedModule<typeof import('../services/ServiceRegistry')>(
      'services/ServiceRegistry.ts',
      [{
        find: '          if (queryEndpoint !== null && credentialRef === null) {',
        replace: '          if (false) {',
      }],
      { '../db/connection': { pool } },
    );
    const mutant = new mutantRegistry.ServiceRegistry();
    const updated = await mutant.updateOwnerPlane(
      SERVICE_ID,
      { knowledgeQueryEndpoint: ENDPOINT, knowledgeClaimsMode: 'none' },
      REVISION,
      'owner',
    );
    expect(updated.knowledgeQueryEndpoint).toBe(ENDPOINT);
    expect(updated.knowledgeCoreCredentialRef).toBeNull();
  });
});

// ═ item 6 clause 5 — a descriptor publish changes routing only via classes ═

describe('item 6 clause 5 — a descriptor publish changes routing, never destination', () => {
  it('re-declaring classes changes the block and touches NO owner-plane column', async () => {
    seedDescriptor({ options: [], knowledgeSource: KNOWLEDGE_BLOCK });
    state.head = headRow({
      ...state.head,
      current_descriptor_version: 1,
      knowledge_query_endpoint: ENDPOINT,
      knowledge_core_credential_ref: 'engine/core-client',
    });
    const result = await registry.publishDescriptor(
      SERVICE_ID,
      {
        options: [],
        knowledgeSource: {
          classes: [{ key: 'code', content: 'code' }, { key: 'docs', content: 'docs' }],
          compartments: ['corpus'],
        },
      },
      REVISION,
      'owner',
    );
    expect(result.descriptorVersion.version).toBe(2);
    // The only UPDATE the publish issues moves the head pointer. No
    // knowledge_* column occurs in any statement it wrote.
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toContain('current_descriptor_version = $2');
    expect(state.updates.join(' ')).not.toContain('knowledge_');
    expect(result.service.knowledgeQueryEndpoint).toBe(ENDPOINT);
  });

  it('refuses a publish that would DROP the block from under a configured endpoint', async () => {
    seedDescriptor({ options: [], knowledgeSource: KNOWLEDGE_BLOCK });
    state.head = headRow({
      ...state.head,
      current_descriptor_version: 1,
      knowledge_query_endpoint: ENDPOINT,
      knowledge_core_credential_ref: 'engine/core-client',
    });
    const error = await refusal(registry.publishDescriptor(
      SERVICE_ID,
      { options: [] },
      REVISION,
      'owner',
    ));
    expect(error.code).toBe('KNOWLEDGE_DESCRIPTOR_BLOCK_REQUIRED');
    expect(state.updates).toHaveLength(0);
  });

  it('leaves an unconfigured Service free to publish without a block', async () => {
    seedDescriptor({ options: [], knowledgeSource: KNOWLEDGE_BLOCK });
    const result = await registry.publishDescriptor(SERVICE_ID, { options: [] }, REVISION, 'owner');
    expect(result.descriptorVersion.version).toBe(2);
  });
});

// ═════════════ BD-1 — the reserved arm, drilled in both directions ═════════

describe('BD-1 — the §9 reserved arm admits the board row and NOTHING else', () => {
  it('a non-reserved row with no endpoints is NOT knowledge-capable', () => {
    expect(isKnowledgeCapable({ slug: 'engine', knowledgeQueryEndpoint: null }, null)).toBe(false);
    expect(isKnowledgeCapable({ slug: 'engine', knowledgeQueryEndpoint: null }, KNOWLEDGE_BLOCK)).toBe(false);
    // …and neither is a row with an endpoint but no compartments.
    expect(isKnowledgeCapable({ slug: 'engine', knowledgeQueryEndpoint: ENDPOINT }, { compartments: [] })).toBe(false);
    // The reserved row is, with no endpoint at all.
    expect(isKnowledgeCapable({ slug: KNOWLEDGE_BOARD_SOURCE_SLUG, knowledgeQueryEndpoint: null }, null)).toBe(true);
  });

  it('MUTATION: widen the reserved arm and every endpoint-less row becomes capable', () => {
    const mutant = loadMutatedModule<typeof import('../services/KnowledgeSourcePolicy')>(
      'services/KnowledgeSourcePolicy.ts',
      [{
        find: '  if (service.slug === KNOWLEDGE_BOARD_SOURCE_SLUG) return true;',
        replace: '  if (service.knowledgeQueryEndpoint === null) return true;',
      }],
    );
    expect(mutant.isKnowledgeCapable({ slug: 'engine', knowledgeQueryEndpoint: null }, null)).toBe(true);
  });

  it('the reserved slug cannot be claimed through the registration surface', async () => {
    state.head = null;
    const error = await refusal(registry.register(
      { slug: KNOWLEDGE_BOARD_SOURCE_SLUG, name: 'Impostor' },
      'attacker',
    ));
    expect(error.code).toBe('RESERVED_SERVICE_SLUG');
    expect([...RESERVED_SERVICE_SLUGS]).toEqual([KNOWLEDGE_BOARD_SOURCE_SLUG]);
  });
});

// ═══════════ the capability predicate is stated exactly ONCE ══════════════

describe('§4.2 — the knowledge-capability predicate is stated once', () => {
  it('only KnowledgeSourcePolicy decides capability; everything else asks it', () => {
    const srcRoot = path.join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    const relative = (file: string) => path.relative(srcRoot, file).split(path.sep).join('/');
    const contents = new Map(files.map((file) => [relative(file), fs.readFileSync(file, 'utf8')]));

    // §4.2's predicate needs BOTH halves in one place: the owner-plane
    // endpoint AND a non-empty compartment list. A file that tests both is
    // stating the predicate; exactly one shipped file may.
    const deciders = [...contents.entries()]
      .filter(([, text]) => /compartments(\?)?\.length/.test(text) && /knowledgeQueryEndpoint/.test(text))
      .map(([file]) => file);
    expect(deciders).toEqual(['services/KnowledgeSourcePolicy.ts']);

    // The one other file that measures a compartment list is the descriptor
    // validator, and what it measures there is the §4.3 BOUNDS rule (1..64,
    // never empty) — a shape check on a declaration, not a decision about a
    // Service. It cannot state the predicate because it never sees the
    // owner-plane half, and this assertion is what keeps that true.
    const compartmentReaders = [...contents.entries()]
      .filter(([, text]) => /compartments(\?)?\.length/.test(text))
      .map(([file]) => file)
      .sort();
    expect(compartmentReaders).toEqual([
      'services/KnowledgeSourcePolicy.ts',
      'utils/serviceDescriptor.ts',
    ]);
    expect(contents.get('utils/serviceDescriptor.ts')).not.toContain('knowledgeQueryEndpoint');

    // And every consumer reaches the predicate by name.
    for (const consumer of ['services/KnowledgeSourceService.ts', 'services/ServiceRegistry.ts']) {
      expect(readShippedSource(consumer)).toContain('isKnowledgeCapable');
    }
  });
});

// ═════════ limb (a) of §5.5 — what GET /knowledge-sources may list ════════

describe('§5.5 limb (a) — the queryable set starts from CAPABLE sources only', () => {
  const service = new KnowledgeSourceService();

  const row = (overrides: Record<string, unknown>) => ({
    id: SERVICE_ID,
    slug: 'engine',
    name: 'Engine',
    description: '',
    knowledge_query_endpoint: ENDPOINT,
    knowledge_claims_mode: 'asserted',
    knowledge_subject_mode: 'pairwise',
    descriptor: { options: [], knowledgeSource: KNOWLEDGE_BLOCK },
    ...overrides,
  });

  it('lists a configured source with its declared classes and compartments', async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [row({})] });
    const sources = await service.listKnowledgeCapableSources();
    expect(sources).toEqual([{
      id: SERVICE_ID,
      slug: 'engine',
      name: 'Engine',
      description: '',
      inProcess: false,
      claimsMode: 'asserted',
      subjectMode: 'pairwise',
      classes: KNOWLEDGE_BLOCK.classes,
      compartments: KNOWLEDGE_BLOCK.compartments,
    }]);
  });

  it('drops a row that passed the SQL prefilter but fails the predicate', async () => {
    // The prefilter is a deliberate SUPERSET; this row is what that means.
    (pool.query as jest.Mock).mockResolvedValue({ rows: [row({ descriptor: { options: [] } })] });
    expect(await service.listKnowledgeCapableSources()).toEqual([]);
  });

  it('lists the reserved board row with no endpoint, marked in-process', async () => {
    (pool.query as jest.Mock).mockResolvedValue({
      rows: [row({ slug: KNOWLEDGE_BOARD_SOURCE_SLUG, knowledge_query_endpoint: null, descriptor: null })],
    });
    const sources = await service.listKnowledgeCapableSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].inProcess).toBe(true);
  });

  it('discloses no endpoint, credential reference, network or group to a caller', async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [row({})] });
    const [source] = await service.listKnowledgeCapableSources();
    for (const forbidden of ['Endpoint', 'CredentialRef', 'AllowedNetworks', 'RelevantGroups']) {
      expect(Object.keys(source).join(' ')).not.toContain(forbidden);
    }
  });
});

// ═══════════════ the scope ships with its surface, and only it ════════════

describe('A21 — knowledge-contents:read ships with its consuming surface', () => {
  it('is in ALL_SCOPES and MINTABLE_SCOPES in the same commit as its route', () => {
    expect(ALL_SCOPES).toContain('knowledge-contents:read');
    expect(MINTABLE_SCOPES).toContain('knowledge-contents:read');
    expect(requiredScopeFor('GET', '/knowledge-sources')).toBe('knowledge-contents:read');
  });

  it('is named by EXACTLY the knowledge routes, and by nothing else', () => {
    // This asserted ONE rule while candidate A was the only knowledge surface.
    // Candidate B ships §8.2's drill-down, so the true count is two — and the
    // PROPERTY the assertion exists for is unchanged and is now stated
    // directly: the scope is named by the knowledge families and no other.
    // A second family acquiring it is still a census failure, not a silent
    // widening (the `directory-provisioning:write` discipline).
    const source = readShippedSource('utils/scopeMap.ts');
    const patterns = source
      .split('\n')
      .filter((line) => line.trim().startsWith('{ pattern:') && line.includes("'knowledge-contents:read'"))
      .map((line) => (/\/\^\\\/([a-z-]+)/.exec(line) ?? [])[1]);
    expect(patterns).toEqual(['knowledge-sources', 'knowledge-contents', 'knowledge-queries']);
  });

  it('leaves every UNSHIPPED knowledge path failing closed to root', () => {
    // `/knowledge-queries` is candidate C's and has no handler yet, so it must
    // still fail closed. `/knowledge-contents` landed with candidate B.
    // Candidate C shipped `/knowledge-queries`, so the POST it serves now
    // carries the scope its object needs. The METHOD half of the rule is
    // still fail-closed and is asserted here: a GET on that path is not a
    // surface this feature ships, and it falls to the root sentinel.
    expect(requiredScopeFor('POST', '/knowledge-queries')).toBe('knowledge-contents:read');
    expect(requiredScopeFor('GET', '/knowledge-queries')).toBe('root');
    expect(requiredScopeFor('GET', '/knowledge-contents')).toBe('knowledge-contents:read');
    // Both shipped surfaces are READ-only: a write to either is not the read
    // scope, so a POST cannot ride the disclosure ceiling.
    expect(requiredScopeFor('POST', '/knowledge-sources')).toBe('root');
    expect(requiredScopeFor('POST', '/knowledge-contents')).toBe('root');
  });
});

// ═══ round-1 finding S2-B1 — limb (c) is a real conjunct ═════════════════

describe('S2-B1 (verdict 8981983f) — the selector limb can actually refuse', () => {
  const ACTOR = {
    principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    handle: 'holder',
    role: 'user',
    scopes: ['knowledge-contents:read'],
    authenticated: true,
    delegation: null,
  };

  interface Captured {
    sql: string;
    params: unknown[];
    queryable: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  }

  function captureSql(rows: Array<{ id: string }>): Captured {
    const seen: Captured = {
      sql: '',
      params: [],
      queryable: { query: async () => ({ rows: [] }) },
    };
    seen.queryable = {
      query: async (text: string, params?: unknown[]) => {
        seen.sql = text;
        seen.params = params ?? [];
        return { rows };
      },
    };
    return seen;
  }

  it('asks the SELECTOR question, not the visibility question', async () => {
    const captured = captureSql([{ id: 'source-a' }]);
    const covered = await authorizationRepository.selectorCoveredIds(
      ACTOR as never,
      'service',
      ['source-a', 'source-b'],
      'read',
      captured.queryable as never,
    );
    expect([...covered]).toEqual(['source-a']);

    // The two SHIPPED fragments are both present…
    expect(captured.sql).toContain('EXISTS (SELECT 1 FROM grants g');
    expect(captured.sql).toContain('access_profile');
    // …and the arm that made limb (b) unconditional for `service` rows is NOT.
    expect(captured.sql).not.toContain("IN ('public', 'shared', 'default')");
    expect(captured.sql).not.toContain("'shared'");
  });

  it('the CONTRAST that made this necessary: the shipped read predicate carries that arm', () => {
    // The reviewer's evidence, promoted. `sqlCondition` for a `service` read
    // ends in the unconditional visibility literal, which is exactly why the
    // selector had to be asked separately.
    const condition = authorizationService.sqlCondition(
      ACTOR as never,
      'read',
      { type: 'service', id: 'se.id', visibility: "'shared'" } as never,
      2,
    );
    expect(condition.sql).toContain("'shared' IN ('public', 'shared', 'default')");
  });

  it('an actor with no principal covers nothing', async () => {
    const covered = await authorizationRepository.selectorCoveredIds(
      { ...ACTOR, principalId: null } as never,
      'service',
      ['source-a'],
    );
    expect(covered.size).toBe(0);
  });

  it('the route intersects the two limbs and exempts ONLY root', () => {
    const route = readShippedSource('routes/knowledge.ts');
    expect(route).toContain('selectorCoveredIds');
    expect(route).toContain('covered.has(source.id)');
    // The sentinel is the only exemption, and it is named.
    expect(route).toContain('ROOT_SCOPE');
    for (const role of ['admin', 'operator', 'orchestrator']) {
      expect(route).not.toContain(`'${role}'`);
    }
  });
});

// ═══ round-2 finding R2-F2 — limb (c) keeps the delegation chain ═════════

describe('R2-F2 (verdict cd392c55) — the selector question is the SHIPPED predicate minus visibility', () => {
  // The REAL production chain shape (terminal-round control finding): the
  // ACTING identity is `links[0]` and the parent Account is last —
  // `AuthorizationService` reads `links[0]` as the acting link and refuses
  // the whole chain when `links[0].legacyIdentity` is set. The earlier
  // fixture had the Account first and omitted the stored fields, so it
  // exercised a chain the product never builds.
  const DELEGATED = {
    principalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    handle: 'delegate',
    role: 'agent',
    scopes: ['knowledge-contents:read'],
    authenticated: true,
    delegation: {
      links: [
        {
          principalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          kind: 'agent',
          role: 'agent',
          parentPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          boundTaskId: null,
          legacyIdentity: false,
          ownExpression: { scopes: 'parent', objects: 'parent' },
        },
        {
          principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          kind: 'account',
          role: 'user',
          parentPrincipalId: null,
          boundTaskId: null,
          legacyIdentity: false,
          ownExpression: null,
        },
      ],
    },
  };

  function capture(): { sql: string; queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> } } {
    const seen = { sql: '', queryable: { query: async () => ({ rows: [] }) } } as {
      sql: string;
      queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> };
    };
    seen.queryable = {
      query: async (text: string) => {
        seen.sql = text;
        return { rows: [] };
      },
    };
    return seen;
  }

  it('carries the DELEGATION CHAIN, which the hand-composed version dropped', async () => {
    const captured = capture();
    await authorizationRepository.selectorCoveredIds(
      DELEGATED as never,
      'service',
      ['source-a'],
      'read',
      captured.queryable as never,
    );
    // The shipped predicate answers a delegated actor differently from a bare
    // one. Whatever it emits, it must be what `sqlCondition` emits — that is
    // the whole content of the repair.
    const { visibility: _v, ...selectorResource } = {
      type: 'service' as const,
      id: 'se.id',
      visibility: "'shared'",
    };
    const expected = authorizationService.sqlCondition(
      DELEGATED as never,
      'read',
      selectorResource as never,
      2,
    );
    expect(captured.sql).toContain(expected.sql);
  });

  it('still removes ONLY the visibility arms', () => {
    const withVisibility = authorizationService.sqlCondition(
      DELEGATED as never,
      'read',
      { type: 'service', id: 'se.id', visibility: "'shared'" } as never,
      2,
    );
    const withoutVisibility = authorizationService.sqlCondition(
      DELEGATED as never,
      'read',
      { type: 'service', id: 'se.id' } as never,
      2,
    );
    expect(withVisibility.sql).toContain("'shared' IN ('public', 'shared', 'default')");
    expect(withoutVisibility.sql).not.toContain("IN ('public', 'shared', 'default')");
  });

  it('the administrator residual is SETTLED in the source, not merely declared', () => {
    // This assertion used to pin the residual's WORDING — that the
    // administrator arm still applied and had been "raised rather than
    // taken". Owner ruling `623632b0` option (a) settled it, so what gets
    // pinned now is the settled state, and that the old escape hatch is gone.
    const source = readShippedSource('services/AuthorizationRepository.ts');
    expect(source).toContain('withoutAdministratorArm: true');
    expect(source).toContain('623632b0');
    expect(source).not.toContain('raised rather than taken');
  });
});

// ═══ terminal finding P2 — the selector binds EVERY non-root caller ══════

describe('P2 (verdict 5778b07f, ruling 623632b0 (a)) — no role is exempt from the selector', () => {
  const ADMIN_ROLES = ['admin', 'operator', 'orchestrator'];
  const RESOURCE = { type: 'service', id: 'se.id' };

  const actorWithRole = (role: string, scopes: string[] = ['knowledge-contents:read']) => ({
    principalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    handle: role,
    role,
    scopes,
    authenticated: true,
    delegation: null,
  });

  it.each(ADMIN_ROLES)('a non-delegated %s no longer short-circuits the selector question', (role) => {
    const shipped = authorizationService.sqlCondition(
      actorWithRole(role) as never, 'read', RESOURCE as never, 2,
    );
    const selector = authorizationService.sqlCondition(
      actorWithRole(role) as never, 'read', RESOURCE as never, 2, { withoutAdministratorArm: true },
    );
    // The shipped read question still answers TRUE for the role — untouched.
    expect(shipped.sql).toBe('TRUE');
    // The SELECTOR question does not: it asks about grants and profiles.
    expect(selector.sql).not.toBe('TRUE');
    expect(selector.sql).toContain('EXISTS (SELECT 1 FROM grants g');
  });

  it('root KEEPS its A12.1 sentinel even under the suppression', () => {
    const selector = authorizationService.sqlCondition(
      actorWithRole('operator', ['root']) as never,
      'read',
      RESOURCE as never,
      2,
      { withoutAdministratorArm: true },
    );
    expect(selector.sql).toBe('TRUE');
  });

  it('the flag is OPT-IN: every other caller of the predicate is unchanged', () => {
    for (const role of [...ADMIN_ROLES, 'user', 'editor']) {
      const withFlagAbsent = authorizationService.sqlCondition(
        actorWithRole(role) as never, 'read', RESOURCE as never, 2,
      );
      const withEmptyOptions = authorizationService.sqlCondition(
        actorWithRole(role) as never, 'read', RESOURCE as never, 2, {},
      );
      expect(withEmptyOptions.sql).toEqual(withFlagAbsent.sql);
    }
  });

  it('the repository asks the SUPPRESSED question, and the route says what it costs', () => {
    expect(readShippedSource('services/AuthorizationRepository.ts'))
      .toContain('withoutAdministratorArm: true');
    const route = readShippedSource('routes/knowledge.ts');
    expect(route).toContain('deliberately STRICTER than the shipped');
    // The comment that was false is now true, and says so.
    expect(route).toContain('That sentence was FALSE when it was first written');
  });

  it('MUTATION: restore the administrator arm and limb (c) stops refusing again', () => {
    const mutant = loadMutatedModule<typeof import('../services/AuthorizationService')>(
      'services/AuthorizationService.ts',
      [{
        find: [
          '    if (!options.withoutAdministratorArm',
          "      && !chain && ADMINISTRATOR_ROLES.has(String(actor.role || '').toLowerCase())) {",
        ].join(String.fromCharCode(10)),
        replace: "    if (!chain && ADMINISTRATOR_ROLES.has(String(actor.role || '').toLowerCase())) {",
      }],
    );
    const mutated = mutant.authorizationService.sqlCondition(
      actorWithRole('operator') as never, 'read', RESOURCE as never, 2, { withoutAdministratorArm: true },
    );
    expect(mutated.sql).toBe('TRUE');
    expect(authorizationService.sqlCondition(
      actorWithRole('operator') as never, 'read', RESOURCE as never, 2, { withoutAdministratorArm: true },
    ).sql).not.toBe('TRUE');
  });
});
