/**
 * delegationCore.test.ts — RH-P3.AZ-S3 (card 25e5fb92; AUTHZ design
 * 4d961e37 §5/§7, A17.10).
 *
 * What these pin (pool-boundary mocks per the telemetryFrames precedent;
 * end-to-end behavior rides scripts/test-s3-delegation-live.js and the DEV
 * QA probe):
 *  - effective-scope computation: root never survives delegation (rule 2),
 *    *:admin never reaches the Agent layer (rule 3), NULL own_expression =
 *    EMPTY authority (AZ-24), explicit scope lists intersect, the Account's
 *    role-derived set bounds the chain;
 *  - the SQL chain intersection: sides ANDed after the acting-identity
 *    role arms, owner/visibility never top-level for delegated actors, the
 *    §8.2 bound-task FINAL write cap (T36) wraps everything;
 *  - credential policy: root/agent-admin/legacy/terminated refusals at
 *    issuance; rotation grace bounds; agents never rotate;
 *  - transport: every protected mount carries a declared class (the §7.5
 *    registration lint) and unknown paths are UNCLASSIFIED;
 *  - credential crypto: AEAD roundtrip, row-binding AAD, unknown keys,
 *    canary mismatch loudness (T30);
 *  - migrations 096/097 static pins; baseline untouched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.RELAYHALL_CREDENTIAL_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 3).toString('base64') });
process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY = 'k1';

const db = {
  queries: [] as Array<{ text: string; params?: unknown[] }>,
  script: [] as Array<(text: string, params?: unknown[]) => { rows: any[] } | null>,
};
function scripted(text: string, params?: unknown[]): { rows: any[] } {
  db.queries.push({ text, params });
  for (const handler of db.script) {
    const result = handler(text, params);
    if (result) return result;
  }
  return { rows: [] };
}
jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
    connect: jest.fn(async () => ({
      query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
      release: jest.fn(),
    })),
  },
}));
jest.mock('../services/AuditService', () => ({
  auditService: { record: jest.fn(async () => ({})) },
}));

import { auditService } from '../services/AuditService';
import { delegationService, parseOwnExpression, DelegationEvaluatorError } from '../services/DelegationService';
import { authorizationService, type DelegationActorLink } from '../services/AuthorizationService';
import { principalService, CredentialPolicyError } from '../services/PrincipalService';
import { routeTransportClassFor, DECLARED_TRANSPORT_PATTERNS } from '../utils/transportMap';
import { PROTECTED_ROUTE_MOUNTS } from '../utils/authorizationRouteManifest';
import {
  encryptCredentialSecret, decryptCredentialSecret, runCredentialCanary,
  CredentialCryptoError, resetKeysetCache, loadKeyset, sha256Hex,
} from '../utils/credentialCrypto';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function link(overrides: Partial<DelegationActorLink> & { principalId: string }): DelegationActorLink {
  return {
    kind: 'service', role: null, parentPrincipalId: null, boundTaskId: null,
    legacyIdentity: false, ownExpression: { scopes: 'parent', objects: 'parent' },
    ...overrides,
  };
}

const wideChain = {
  links: [
    { principalId: CONNECTOR, kind: 'service' as const, role: null, status: 'active', parentPrincipalId: ACCOUNT, boundTaskId: null, legacyIdentity: false, ownExpression: parseOwnExpression({ scopes: 'parent', objects: 'parent' }), liveCredentialCount: 1 },
    { principalId: ACCOUNT, kind: 'service' as const, role: 'service', status: 'active', parentPrincipalId: null, boundTaskId: null, legacyIdentity: false, ownExpression: null, liveCredentialCount: 0 },
  ],
  alive: true,
  deadReason: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.queries.length = 0;
  db.script.length = 0;
});

describe('effective scopes (§5.2 rules 1–3, AZ-24/AZ-26)', () => {
  it('root never survives delegation and *:admin never reaches the Agent layer', () => {
    const accountScopes = ['tasks:read', 'tasks:write', 'tasks:admin', 'reports:read'];
    const connectorScopes = delegationService.effectiveScopes(wideChain as any, ['root', 'tasks:read', 'tasks:admin'], accountScopes);
    expect(connectorScopes).not.toContain('root');
    expect(connectorScopes).toContain('tasks:admin'); // rule 3: admin reaches Connectors…
    const agentChain = {
      ...wideChain,
      links: [
        { ...wideChain.links[0], principalId: AGENT, kind: 'agent' as const, parentPrincipalId: CONNECTOR, boundTaskId: TASK },
        wideChain.links[0],
        wideChain.links[1],
      ],
    };
    const agentScopes = delegationService.effectiveScopes(agentChain as any, ['tasks:read', 'tasks:admin'], accountScopes);
    expect(agentScopes).not.toContain('tasks:admin'); // …never Agents.
    expect(agentScopes).toContain('tasks:read');
  });

  it('a NULL own_expression on a delegated link yields EMPTY authority (inheritance is never implicit)', () => {
    const chain = { ...wideChain, links: [{ ...wideChain.links[0], ownExpression: null }, wideChain.links[1]] };
    expect(delegationService.effectiveScopes(chain as any, ['tasks:read'], ['tasks:read'])).toEqual([]);
  });

  it('explicit own scopes and the Account role set both intersect', () => {
    const chain = {
      ...wideChain,
      links: [{ ...wideChain.links[0], ownExpression: parseOwnExpression({ scopes: ['tasks:read', 'reports:read'], objects: 'parent' }) }, wideChain.links[1]],
    };
    const scopes = delegationService.effectiveScopes(chain as any, ['tasks:read', 'tasks:write', 'reports:read'], ['tasks:read', 'tasks:write']);
    expect(scopes.sort()).toEqual(['tasks:read']); // own strips write; account strips reports.
  });

  it('legacy acting identities keep their credential scopes untouched (§10 arm)', () => {
    const chain = { ...wideChain, links: [{ ...wideChain.links[0], legacyIdentity: true }, wideChain.links[1]] };
    expect(delegationService.effectiveScopes(chain as any, ['root', 'tasks:read'], [])).toEqual(['root', 'tasks:read']);
  });
});

describe('parseOwnExpression (AZ-24)', () => {
  it('accepts parent/parent and explicit lists; refuses root scopes and malformed shapes', () => {
    expect(parseOwnExpression(null)).toBeNull();
    expect(parseOwnExpression({ scopes: 'parent', objects: 'parent' })).toEqual({ scopes: 'parent', objects: 'parent' });
    expect(() => parseOwnExpression({ scopes: ['root'], objects: 'parent' })).toThrow(DelegationEvaluatorError);
    expect(() => parseOwnExpression({ scopes: 'parent' })).toThrow();
    expect(() => parseOwnExpression('parent')).toThrow(DelegationEvaluatorError);
  });
});

describe('the SQL chain intersection (§5.1, AZ-26, T36)', () => {
  const resource = { type: 'task' as const, id: 't.id', owner: 't.owner_principal_id', claimant: 't.owner_principal_id', visibility: 't.visibility' };
  const actorFor = (links: DelegationActorLink[], scopes = ['tasks:read']) => ({
    principalId: links[0].principalId, handle: 'chain', role: 'agent', scopes,
    authenticated: true, delegation: { links },
  });

  it('ANDs one side per chain link after the acting-identity role arms', () => {
    const links = [
      link({ principalId: CONNECTOR, parentPrincipalId: ACCOUNT }),
      link({ principalId: ACCOUNT, ownExpression: null }),
    ];
    const decision = authorizationService.sqlCondition(actorFor(links), 'read', resource);
    // Acting role arm (claimant) is a top-level OR arm…
    expect(decision.sql).toContain(`t.owner_principal_id = $1`);
    // …and the intersection arm ANDs the two sides.
    expect(decision.sql).toMatch(/\(\(TRUE.*\) AND \(.*\)\)/s);
    // The Account side carries owner + visibility; the acting side does NOT
    // contribute a top-level visibility arm.
    const beforeIntersection = decision.sql.split(' AND ')[0];
    expect(beforeIntersection).not.toContain("IN ('public'");
  });

  it('a delegated link without own_expression contributes FALSE (fail closed)', () => {
    const links = [
      link({ principalId: CONNECTOR, parentPrincipalId: ACCOUNT, ownExpression: null }),
      link({ principalId: ACCOUNT, ownExpression: null }),
    ];
    const decision = authorizationService.sqlCondition(actorFor(links), 'read', resource);
    expect(decision.sql).toContain('FALSE AND');
  });

  it('T36: the bound-task FINAL write cap wraps the WHOLE condition for Agent writes', () => {
    const links = [
      link({ principalId: AGENT, kind: 'agent', parentPrincipalId: CONNECTOR, boundTaskId: TASK }),
      link({ principalId: CONNECTOR, parentPrincipalId: ACCOUNT }),
      link({ principalId: ACCOUNT, ownExpression: null }),
    ];
    const write = authorizationService.sqlCondition(actorFor(links, ['tasks:write']), 'write', resource);
    expect(write.sql).toMatch(/ AND t\.id = \$\d+\)$/);
    expect(write.params).toContain(TASK);
    // Reads are NOT capped at S3 (the task-context read default rides §8/S5).
    const read = authorizationService.sqlCondition(actorFor(links), 'read', resource);
    expect(read.sql).not.toMatch(/ AND t\.id = \$\d+\)$/);
    // An Agent with no bound task has NO write authority at all.
    const unbound = [{ ...links[0], boundTaskId: null }, links[1], links[2]];
    expect(authorizationService.sqlCondition(actorFor(unbound, ['tasks:write']), 'write', resource).sql).toBe('FALSE');
  });

  it('authorizeResource refuses delegated cross-bound writes in memory and defers authority to SQL', () => {
    const links = [
      link({ principalId: AGENT, kind: 'agent', parentPrincipalId: CONNECTOR, boundTaskId: TASK }),
      link({ principalId: CONNECTOR, parentPrincipalId: ACCOUNT }),
      link({ principalId: ACCOUNT, ownExpression: null }),
    ];
    const actor = { principalId: AGENT, handle: 'a', role: 'agent', scopes: ['tasks:write'], authenticated: true, delegation: { links } };
    const foreign = authorizationService.authorizeResource(actor, 'write', { type: 'task', id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }, []);
    expect(foreign.allowed).toBe(false);
    const claimant = authorizationService.authorizeResource(actor, 'write', { type: 'task', id: TASK, claimantPrincipalId: AGENT }, []);
    expect(claimant.allowed).toBe(true);
    expect(claimant.basis).toBe('claimant');
    // Owner/visibility arms never apply to a parented principal in memory.
    const owned = authorizationService.authorizeResource(actor, 'read', { type: 'report', id: TASK, ownerPrincipalId: AGENT, visibility: 'shared' }, []);
    expect(owned.allowed).toBe(false);
  });
});

describe('credential policy at issuance and rotation (§5.2/§7.3)', () => {
  it('refuses root, agent *:admin, legacy and terminated targets with typed errors', async () => {
    await expect(principalService.issueCredential({ principalId: CONNECTOR, scopes: ['root'] }))
      .rejects.toMatchObject({ code: 'ROOT_NOT_MINTABLE' });

    db.script.push((text) => /SELECT kind, status, legacy_identity, parent_principal_id FROM principals/.test(text)
      ? { rows: [{ kind: 'agent', status: 'active', legacy_identity: false, parent_principal_id: CONNECTOR }] } : null);
    await expect(principalService.issueCredential({ principalId: AGENT, scopes: ['tasks:admin'] }))
      .rejects.toMatchObject({ code: 'ADMIN_NOT_AGENT_DELEGABLE' });

    db.script.length = 0;
    db.script.push((text) => /SELECT kind, status, legacy_identity, parent_principal_id FROM principals/.test(text)
      ? { rows: [{ kind: 'service', status: 'active', legacy_identity: true, parent_principal_id: null }] } : null);
    await expect(principalService.issueCredential({ principalId: CONNECTOR, scopes: ['tasks:read'] }))
      .rejects.toMatchObject({ code: 'LEGACY_FROZEN' });
    expect((auditService.record as jest.Mock).mock.calls.some((call) => call[0].action === 'legacy.refused')).toBe(true);

    db.script.length = 0;
    db.script.push((text) => /SELECT kind, status, legacy_identity, parent_principal_id FROM principals/.test(text)
      ? { rows: [{ kind: 'service', status: 'terminated', legacy_identity: false, parent_principal_id: ACCOUNT }] } : null);
    await expect(principalService.issueCredential({ principalId: CONNECTOR, scopes: ['tasks:read'] }))
      .rejects.toMatchObject({ code: 'PRINCIPAL_TERMINATED' });

    // A17.1/§7.1 (review 94aad5aa B4): Accounts are KEYLESS — a non-legacy
    // parentless target refuses with a typed error.
    db.script.length = 0;
    db.script.push((text) => /SELECT kind, status, legacy_identity, parent_principal_id FROM principals/.test(text)
      ? { rows: [{ kind: 'service', status: 'active', legacy_identity: false, parent_principal_id: null }] } : null);
    await expect(principalService.issueCredential({ principalId: ACCOUNT, scopes: ['tasks:read'] }))
      .rejects.toMatchObject({ code: 'ACCOUNTS_ARE_KEYLESS' });
  });

  it('rotation bounds grace to 0–168h and Agents never rotate', async () => {
    await expect(principalService.rotateCredential('cred', 400)).rejects.toBeInstanceOf(CredentialPolicyError);
    db.script.push((text) => /FROM principal_credentials c JOIN principals p/.test(text)
      ? { rows: [{ cred_id: 'cred', principal_id: AGENT, key_id: 'k', label: null, scopes: '["tasks:read"]', transport: 'any', credential_type: 'api_key', expires_at: null, revoked_at: null, rotated_from_id: null, kind: 'agent', legacy_identity: false, status: 'active', id: AGENT, handle: 'a' }] } : null);
    await expect(principalService.rotateCredential('cred', 24)).rejects.toMatchObject({ code: 'AGENTS_NEVER_ROTATE' });
  });
});

describe('transport classes (§7.5, T26 registration lint)', () => {
  it('every protected mount carries a declared class; unknown paths are unclassified', () => {
    for (const mount of PROTECTED_ROUTE_MOUNTS) {
      if (mount === '/openapi.json') {
        expect(routeTransportClassFor(mount)).toBe('any');
        continue;
      }
      expect(routeTransportClassFor(`${mount}/anything`)).toBeDefined();
    }
    expect(routeTransportClassFor('/some-new-surface')).toBeUndefined();
    expect(DECLARED_TRANSPORT_PATTERNS.length).toBeGreaterThanOrEqual(PROTECTED_ROUTE_MOUNTS.length);
  });
});

describe('credential crypto (§7.2, T9/T30)', () => {
  it('roundtrips under the active key and binds the ciphertext to its row', () => {
    resetKeysetCache();
    const { ciphertext, encryptionKeyId } = encryptCredentialSecret('s3cret-value', 'row-1');
    expect(decryptCredentialSecret(ciphertext, encryptionKeyId, 'row-1')).toBe('s3cret-value');
    expect(() => decryptCredentialSecret(ciphertext, encryptionKeyId, 'row-2'))
      .toThrow(CredentialCryptoError); // cross-wired row fails, never reveals.
    expect(() => decryptCredentialSecret(ciphertext, 'nope', 'row-1')).toThrow(CredentialCryptoError);
  });

  it('the canary fails LOUDLY on a hash mismatch (T30)', async () => {
    resetKeysetCache();
    const good = encryptCredentialSecret('alpha', 'row-a');
    const rows = [
      { id: 'row-a', secret_ciphertext: good.ciphertext, encryption_key_id: good.encryptionKeyId, secret_hash: sha256Hex('alpha') },
    ];
    await expect(runCredentialCanary({ query: async () => ({ rows }) })).resolves.toBe(1);
    rows[0].secret_hash = sha256Hex('tampered');
    await expect(runCredentialCanary({ query: async () => ({ rows }) }))
      .rejects.toMatchObject({ code: 'CREDENTIAL_CANARY_MISMATCH' });
  });

  it('keyset validation refuses malformed environments', () => {
    expect(() => loadKeyset({} as any)).toThrow(CredentialCryptoError);
    expect(() => loadKeyset({ RELAYHALL_CREDENTIAL_KEYS: '{"k":"short"}', RELAYHALL_CREDENTIAL_ACTIVE_KEY: 'k' } as any))
      .toThrow(CredentialCryptoError);
  });
});

describe('round-3 repair pins (review 2fcd548c)', () => {
  it('B4: the connector handle derivation fits VARCHAR(64) for every valid slug and stays plain when it fits', () => {
    const { connectorHandleFor } = require('../services/ServiceRegistry');
    const short = 'a'.repeat(54);
    expect(connectorHandleFor(short)).toBe('connector-' + short);
    const long = 'b'.repeat(64);
    const derived = connectorHandleFor(long);
    expect(derived.length).toBeLessThanOrEqual(64);
    expect(derived.startsWith('connector-' + 'b'.repeat(45))).toBe(true);
    expect(connectorHandleFor(long)).toBe(derived); // deterministic
    expect(connectorHandleFor('c'.repeat(64))).not.toBe(derived); // collision-safe
  });

  it('B3: StepUpError is a typed 403 the reveal route maps (never a 500)', () => {
    const { StepUpError } = require('../services/StepUpService');
    const err = new StepUpError(403, 'STEP_UP_REQUIRED', 'x');
    expect(err.status).toBe(403);
    expect(err.code).toBe('STEP_UP_REQUIRED');
  });

  it('round-5 (review 87fec3e2): root-Account superset, spec transport parity, principal-create contract', () => {
    // B1: a ROOT Account's sentinel is the Account-side SUPERSET — the
    // FULL derivation chain yields the delegated admin scope.
    const rootChain = {
      links: [
        { principalId: CONNECTOR, kind: 'service' as const, role: null, status: 'active', parentPrincipalId: ACCOUNT, boundTaskId: null, legacyIdentity: false, ownExpression: parseOwnExpression({ scopes: 'parent', objects: 'parent' }), liveCredentialCount: 1 },
        { principalId: ACCOUNT, kind: 'human' as const, role: 'admin', status: 'active', parentPrincipalId: null, boundTaskId: null, legacyIdentity: false, ownExpression: null, liveCredentialCount: 0 },
      ],
      alive: true, deadReason: null,
    };
    const { scopesForRole } = require('../utils/identityScopes');
    const effective = delegationService.effectiveScopes(rootChain as any, ['tasks:admin', 'tasks:read', 'root'], scopesForRole('admin'));
    expect(effective).toContain('tasks:admin');
    expect(effective).toContain('tasks:read');
    expect(effective).not.toContain('root'); // rule 2 still strips root itself.
    // …and through the authorization gate with exactly that derived set:
    const links = [
      link({ principalId: CONNECTOR, parentPrincipalId: ACCOUNT }),
      link({ principalId: ACCOUNT, ownExpression: null }),
    ];
    const actor = { principalId: CONNECTOR, handle: 'c', role: 'agent', scopes: effective, authenticated: true, delegation: { links } };
    expect(authorizationService.authorizeRoute(actor, 'tasks:admin').allowed).toBe(true);

    // B5: every spec path declares a transport class consistent with the
    // one transportMap source of truth.
    const { buildOpenApiSpec } = require('../openapi/spec');
    const { routeTransportClassFor } = require('../utils/transportMap');
    const spec: any = buildOpenApiSpec();
    const specPaths = Object.keys(spec.paths);
    expect(specPaths.length).toBeGreaterThan(30);
    for (const specPath of specPaths) {
      const declared = spec.paths[specPath]['x-transport-class'];
      expect(declared).toBeDefined();
      const mapped = routeTransportClassFor(specPath.replace(/\{[^}]+\}/g, 'x'));
      expect(declared).toBe(mapped ?? 'unclassified-fail-closed');
    }

    // B6: the Principal-create contract names the Account-only semantics.
    const specSource = readFileSync(join(__dirname, '../openapi/spec.ts'), 'utf8');
    expect(specSource).toContain('AGENT_MINT_ONLY');
    expect(specSource).toContain('PURPOSE_REQUIRED');
    const apiMd2 = readFileSync(join(__dirname, '../../../docs/api.md'), 'utf8');
    expect(apiMd2).toContain('AGENT_MINT_ONLY');
    // B3: the retired CLI noun is gone, not aliased.
    expect(apiMd2).not.toContain('relayhall key');
    const cli = readFileSync(join(__dirname, '../../../cli/relayhall'), 'utf8');
    expect(cli).toContain('add_parser("credential"');
    expect(cli).not.toContain('aliases=["key"]');
  });

  it('round-6 (review 6c7d68d2): the root-Account SQL side is the authority superset', () => {
    // B2: effective(parent) for an administrator Account is board-wide —
    // the Account SQL side collapses to TRUE while the child's own side
    // and the bound-task cap still bind, and root never delegates.
    const links = [
      link({ principalId: CONNECTOR, parentPrincipalId: ACCOUNT }),
      link({ principalId: ACCOUNT, role: 'admin', ownExpression: null }),
    ];
    const actor = { principalId: CONNECTOR, handle: 'c', role: 'agent', scopes: ['tasks:read'], authenticated: true, delegation: { links } };
    const decision = authorizationService.sqlCondition(actor, 'read',
      { type: 'task', id: 't.id', owner: 't.owner_principal_id', visibility: 't.visibility' });
    // The intersection arm ends with the Account side TRUE…
    expect(decision.sql).toMatch(/ AND TRUE\)/);
    // …and the acting side still exists (no blanket TRUE for the child).
    expect(decision.sql).toContain('FROM grants g');
    // A NON-admin Account keeps its enumerated arms.
    const plainLinks = [links[0], link({ principalId: ACCOUNT, role: 'user', ownExpression: null })];
    const plain = authorizationService.sqlCondition({ ...actor, delegation: { links: plainLinks } }, 'read',
      { type: 'task', id: 't.id', owner: 't.owner_principal_id', visibility: 't.visibility' });
    expect(plain.sql).not.toMatch(/ AND TRUE\)/);
  });

  it('round-4 (review ab857740): ceilings, T36 assignment refusal, runbook parity', () => {
    // B2: a Connector chain reaches per-object admin scopes at the route
    // AND the SQL adapter; an Agent never does.
    const connectorLinks = [
      link({ principalId: CONNECTOR, parentPrincipalId: ACCOUNT }),
      link({ principalId: ACCOUNT, ownExpression: null }),
    ];
    const connectorActor = { principalId: CONNECTOR, handle: 'c', role: 'agent', scopes: ['tasks:admin'], authenticated: true, delegation: { links: connectorLinks } };
    expect(authorizationService.authorizeRoute(connectorActor, 'tasks:admin').allowed).toBe(true);
    const adminSql = authorizationService.sqlCondition(connectorActor, 'admin',
      { type: 'task', id: 't.id', owner: 't.owner_principal_id' });
    expect(adminSql.sql).not.toBe('FALSE');
    const agentLinks = [
      link({ principalId: AGENT, kind: 'agent', parentPrincipalId: CONNECTOR, boundTaskId: TASK }),
      connectorLinks[0],
      connectorLinks[1],
    ];
    const agentActor = { principalId: AGENT, handle: 'a', role: 'agent', scopes: ['tasks:admin'], authenticated: true, delegation: { links: agentLinks } };
    expect(authorizationService.authorizeRoute(agentActor, 'tasks:admin').allowed).toBe(false);
    expect(authorizationService.sqlCondition(agentActor, 'admin', { type: 'task', id: 't.id' }).sql).toBe('FALSE');

    // B4: the published runbook follows the Account→Connector→credential
    // path and uses the ratified Credential noun.
    const apiMd = readFileSync(join(__dirname, '../../../docs/api.md'), 'utf8');
    const runbook = apiMd.slice(apiMd.indexOf('### Issuing a credential (runbook'));
    expect(runbook).toContain('"purpose"');
    expect(runbook).toContain('"kind":"connector"');
    expect(runbook).toContain('connector-principal-id');
    expect(runbook).toContain('relayhall credential issue');
    expect(runbook).not.toContain('it is never shown again');
    expect(apiMd).not.toContain('cannot be read back');
  });

  it('B7: the OpenAPI contract matches the repaired S3 behavior', () => {
    const spec = readFileSync(join(__dirname, '../openapi/spec.ts'), 'utf8');
    expect(spec).toContain('REVEAL_EXCEEDS_PRESENTING');
    expect(spec).toContain('404-concealed foreign targets');
    expect(spec).toContain('delegated assignees since AZ-S3');
    expect(spec).not.toContain('ASSIGNEE_PARENTED');
    expect(spec).not.toContain('REVEAL_OUTSIDE_LINEAGE');
    const apiMd = readFileSync(join(__dirname, '../../../docs/api.md'), 'utf8');
    expect(apiMd).toContain('Connectors and Agents are valid profile assignees');
    expect(apiMd).not.toContain('refused\nuntil AZ-S3');
  });

  it('B1: the 096 legacy disposition is one-time by construction', () => {
    const sql = readFileSync(join(__dirname, '../migrations/096_delegation_substrate.sql'), 'utf8');
    // The disposition UPDATEs live INSIDE the column-creation DO block, so a
    // re-run (column already present) can never touch post-096 identities.
    const doBlock = sql.slice(sql.indexOf("column_name = 'legacy_identity'"), sql.indexOf('Remediation-queue'));
    expect(doBlock).toContain('ADD COLUMN legacy_identity');
    expect(doBlock).toContain('SET legacy_identity = TRUE');
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS legacy_identity/);
  });
});

describe('migrations 096/097 static pins', () => {
  const m096 = readFileSync(join(__dirname, '../migrations/096_delegation_substrate.sql'), 'utf8');
  const m097 = readFileSync(join(__dirname, '../migrations/097_registry_unification.sql'), 'utf8');
  const baseline = readFileSync(join(__dirname, '../../../database/init.sql'), 'utf8');

  it('096 carries the layer CHECKs, terminated guards, legacy disposition and credential columns', () => {
    for (const marker of [
      'principals_human_parentless', 'principals_elevated_parentless', 'principals_agent_shape',
      'enforce_delegation_chain_shape', 'enforce_terminated_is_final', 'enforce_no_credentials_for_terminated',
      'legacy_identity', "LEGACY - pending owner review",
      'secret_ciphertext', 'encryption_key_id', 'reveal_count', 'rotated_from_id', 'grace_until',
      "transport IN ('any', 'mcp', 'api')", 'step_up_tokens', 'own_expression', 'bound_task_id', 'terminated_at',
    ]) {
      expect(m096).toContain(marker);
    }
  });

  it('097 pairs connector rows with principals and backfills as legacy remediation rows', () => {
    expect(m097).toContain('services_connector_principal_required');
    expect(m097).toContain("kind <> 'connector' OR principal_id IS NOT NULL");
    expect(m097).toContain('LEGACY - registry backfill pending owner review');
  });

  it('leaves the baseline untouched (fresh-replay doctrine)', () => {
    expect(baseline).not.toContain('096_delegation_substrate');
    expect(baseline).not.toContain('097_registry_unification');
    expect(baseline).not.toContain('step_up_tokens');
  });
});
