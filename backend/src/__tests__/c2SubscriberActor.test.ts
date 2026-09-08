/**
 * c2SubscriberActor.test.ts — RH-P3.C2: delivery authority is derived from the
 * subscription's CREDENTIAL, by the production sequence, and can never exceed
 * what that credential could pull.
 *
 * ── Proof discipline (model map 1566f4cf §6 escalation) ──
 *
 * The first version of this suite mocked `delegationService.effectiveScopes`
 * and asserted only which functions were called with what. That is exactly how
 * review r1 B2 got through: the worker substituted the principal's ROLE
 * MAXIMUM for credential scopes, and a test that never supplies a narrowed
 * credential cannot see the difference. The same class of defect (synthetic
 * actor agrees with itself) is the recorded AZ-S3 round-4 failure.
 *
 * So this suite now drives the REAL `delegationService.effectiveScopes`, the
 * REAL `scopesForRole`, and the REAL `authorizeRoute` + `requiredScopeFor`
 * that gate `GET /events`. Only `resolveChain` is stubbed, because it is a
 * database walk; every value it returns is a production-shaped chain.
 *
 * The decisive test is `reproduces review r1 B2 and refuses it`: it rebuilds
 * the reviewer's exact scenario and asserts the outcome is now a refusal.
 *
 * ── Round 2 (verdict c4f396b2, B2 residual) ──
 *
 * Round 1's repair was still incomplete: scopes, revocation and expiry were
 * checked, but `credential_type`, secret usability, `grace_until` and the
 * §7.5 TRANSPORT PIN were not, so an `mcp`-pinned credential that REST
 * ingress answers with 403 TRANSPORT_MISMATCH was accepted here and cleared
 * `tasks:read`. The repair does not re-list those gates in the worker — it
 * routes BOTH the worker and `middleware/auth.ts` through one predicate
 * (`utils/credentialAcceptance`), so parity holds by construction rather than
 * by resemblance. `the ingress and the worker share ONE predicate` below is
 * what keeps that true as the code changes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SubscriberActorService } from '../services/SubscriberActorService';
import { authorizationService } from '../services/AuthorizationService';
import { requiredScopeFor } from '../utils/scopeMap';
import {
  evaluateCredentialAcceptance, evaluateTransportPin, isUsableBearerKeyMaterial,
  DELIVERY_MIRRORED_PATH, DELIVERY_MIRRORED_TRANSPORT,
} from '../utils/credentialAcceptance';

const resolveChain = jest.fn();
jest.mock('../services/DelegationService', () => {
  const actual = jest.requireActual('../services/DelegationService');
  return {
    ...actual,
    delegationService: {
      // REAL implementation — the thing under test must not be mocked.
      effectiveScopes: actual.delegationService.effectiveScopes.bind(actual.delegationService),
      resolveChain: (...args: unknown[]) => resolveChain(...args),
    },
  };
});

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '99999999-9999-4999-8999-999999999999';

function row(over: Record<string, unknown> = {}) {
  return {
    id: CONNECTOR, handle: 'connector-a', role: 'service', status: 'active',
    // `principals.kind` is human|agent|service; Connector-ness comes from a
    // services row (A17.2), surfaced by the query as is_connector.
    kind: 'service', is_connector: true, parent_principal_id: ACCOUNT, legacy_identity: false,
    credential_id: CREDENTIAL, credential_principal_id: CONNECTOR,
    credential_scopes: ['tasks:read'], credential_revoked_at: null,
    // The full acceptance surface, shaped exactly as the production SELECT
    // returns it. A fixture that omits these is how round 2's B2 survived
    // round 1: a test cannot see a gate it never supplies an input for — and
    // how round 3's B3 survived round 2, when usability was a BOOLEAN that
    // could not express "addressable by key id AND a matchable digest".
    credential_type: 'api_key',
    credential_key_id: 'c2conn0000001', credential_secret_hash: 'a'.repeat(64),
    credential_expires_at: null, credential_grace_until: null,
    credential_transport: 'any', ...over,
  };
}

function poolWith(rows: any[]) {
  return { query: jest.fn(async () => ({ rows, rowCount: rows.length })) } as any;
}

/** A production-shaped chain: acting identity first, Account last. */
function chainOf(ownScopes: 'parent' | string[], accountRole = 'admin') {
  return {
    alive: true, deadReason: null,
    links: [
      { principalId: CONNECTOR, kind: 'connector', role: 'service', parentPrincipalId: ACCOUNT, boundTaskId: null, legacyIdentity: false, ownExpression: { scopes: ownScopes, objects: 'parent' } },
      { principalId: ACCOUNT, kind: 'human', role: accountRole, parentPrincipalId: null, boundTaskId: null, legacyIdentity: false, ownExpression: null },
    ],
  };
}

/** The gate a real `GET /events` pull must clear. */
function pullAllowed(actor: any): boolean {
  return authorizationService.authorizeRoute(actor, requiredScopeFor('GET', '/events')).allowed;
}

beforeEach(() => resolveChain.mockReset());

describe('C2 delivery authority cannot exceed pull authority (review r1, B2)', () => {
  /**
   * THE regression. Reviewer's reproduction: a live delegated Connector under a
   * root Account, role `service`, ownExpression `parent`, whose ONLY credential
   * holds ['reports:read']. The real derivation refuses it `GET /events`
   * (needs tasks:read); the first candidate's role-derived actor cleared the
   * ceiling and the subscription disclosed private task IDs.
   */
  test('reproduces review r1 B2 and refuses it — a narrow credential does not become a role maximum', async () => {
    resolveChain.mockResolvedValue(chainOf('parent'));
    const service = new SubscriberActorService(
      poolWith([row({ credential_scopes: ['reports:read'] })]),
    );
    const result = await service.actorFor(CONNECTOR, CREDENTIAL);
    expect(result.ok).toBe(true);

    const actor = (result as { actor: any }).actor;
    // The credential's own scopes, NOT scopesForRole('service') — which would
    // contain tasks:read and every other mintable non-admin scope.
    expect(actor.scopes).toEqual(['reports:read']);
    expect(actor.scopes).not.toContain('tasks:read');

    // And the consequence the reviewer measured: this actor cannot clear the
    // route ceiling, so the worker delivers it nothing.
    expect(pullAllowed(actor)).toBe(false);
  });

  test('a credential that DOES hold tasks:read clears the same ceiling', async () => {
    resolveChain.mockResolvedValue(chainOf('parent'));
    const service = new SubscriberActorService(poolWith([row({ credential_scopes: ['tasks:read'] })]));
    const result = await service.actorFor(CONNECTOR, CREDENTIAL);
    expect(pullAllowed((result as { actor: any }).actor)).toBe(true);
  });

  /**
   * The chain's own expression narrows further. Driving the REAL
   * effectiveScopes is the point: a mock would have agreed with whatever the
   * worker did.
   */
  test('a link expression narrower than the credential wins', async () => {
    resolveChain.mockResolvedValue(chainOf(['reports:read']));
    const service = new SubscriberActorService(
      poolWith([row({ credential_scopes: ['tasks:read', 'reports:read'] })]),
    );
    const result = await service.actorFor(CONNECTOR, CREDENTIAL);
    expect((result as { actor: any }).actor.scopes).toEqual(['reports:read']);
    expect(pullAllowed((result as { actor: any }).actor)).toBe(false);
  });

  test('root never survives delegation, however the credential was minted', async () => {
    resolveChain.mockResolvedValue(chainOf('parent'));
    const service = new SubscriberActorService(
      poolWith([row({ credential_scopes: ['root', 'tasks:read'] })]),
    );
    const result = await service.actorFor(CONNECTOR, CREDENTIAL);
    expect((result as { actor: any }).actor.scopes).not.toContain('root');
  });
});

describe('C2 subscriber refusals are fail-closed', () => {
  test.each([
    ['an unknown principal', [], CREDENTIAL, 'SUBSCRIBER_NOT_FOUND'],
    ['a disabled principal', [row({ status: 'disabled' })], CREDENTIAL, 'SUBSCRIBER_NOT_ACTIVE'],
    ['a terminated principal', [row({ status: 'terminated' })], CREDENTIAL, 'SUBSCRIBER_NOT_ACTIVE'],
    ['an Agent-layer principal', [row({ kind: 'agent', is_connector: false })], CREDENTIAL, 'SUBSCRIBER_LAYER_INELIGIBLE'],
    ['an Account (holds no bearer credential)', [row({ kind: 'human', is_connector: false, parent_principal_id: null })], CREDENTIAL, 'SUBSCRIBER_LAYER_INELIGIBLE'],
    ['a plain service principal that is not a registered Connector', [row({ is_connector: false })], CREDENTIAL, 'SUBSCRIBER_LAYER_INELIGIBLE'],
    ['no credential named', [row()], null, 'SUBSCRIBER_CREDENTIAL_MISSING'],
    ['a credential that does not exist', [row({ credential_id: null })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_MISSING'],
    ['a revoked credential', [row({ credential_revoked_at: '2026-08-01T00:00:00Z' })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_NOT_LIVE'],
    ['an expired credential', [row({ credential_expires_at: '2026-08-01T00:00:00Z' })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_NOT_LIVE'],
    ["another principal's credential", [row({ credential_principal_id: FOREIGN })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_FOREIGN'],
    // ── Round 2, B2: the gates the pull path applies and the worker did not ──
    ['a password credential (not a bearer credential at all)', [row({ credential_type: 'password' })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_TYPE'],
    ['a jwt_subject credential', [row({ credential_type: 'jwt_subject', credential_has_secret: false })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_TYPE'],
    ['a legacy_env credential', [row({ credential_type: 'legacy_env' })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_TYPE'],
    ['an api_key with no stored secret', [row({ credential_secret_hash: null })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_SECRET_UNUSABLE'],
    // ── Round 3, B3: the reviewer's reproduction — a row that no bearer
    // token could ever authenticate with was accepted for delivery.
    ['a credential with a NULL key id, addressable by no token', [row({ credential_key_id: null })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_SECRET_UNUSABLE'],
    ['a credential with a blank key id', [row({ credential_key_id: '   ' })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_SECRET_UNUSABLE'],
    ['a credential whose digest is not SHA-256 hex', [row({ credential_secret_hash: 'not-a-sha256-digest' })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_SECRET_UNUSABLE'],
    ['a credential whose digest is the wrong length', [row({ credential_secret_hash: 'abc123' })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_SECRET_UNUSABLE'],
    ['a credential whose rotation grace has elapsed (§7.3)', [row({ credential_grace_until: '2026-08-01T00:00:00Z' })], CREDENTIAL, 'SUBSCRIBER_CREDENTIAL_GRACE_ELAPSED'],
    ['an MCP-pinned credential (§7.5 — 403 TRANSPORT_MISMATCH on the pull)', [row({ credential_transport: 'mcp' })], CREDENTIAL, 'SUBSCRIBER_TRANSPORT_MISMATCH'],
  ])('%s is refused', async (_label, rows, credential, refusal) => {
    const service = new SubscriberActorService(poolWith(rows as any[]));
    const result = await service.actorFor(CONNECTOR, credential as string | null);
    expect(result.ok).toBe(false);
    expect((result as { refusal: string }).refusal).toBe(refusal);
    expect((result as { actor?: unknown }).actor).toBeUndefined();
  });

  test('a dead delegation chain is refused, never downgraded', async () => {
    resolveChain.mockResolvedValue({ links: [], alive: false, deadReason: 'revoked' });
    const service = new SubscriberActorService(poolWith([row()]));
    const result = await service.actorFor(CONNECTOR, CREDENTIAL);
    expect(result.ok).toBe(false);
    expect((result as { refusal: string }).refusal).toBe('SUBSCRIBER_CHAIN_DEAD');
  });

  test('an evaluator failure is refused, not treated as "no delegation"', async () => {
    resolveChain.mockRejectedValue(new Error('evaluator exploded'));
    const service = new SubscriberActorService(poolWith([row()]));
    const result = await service.actorFor(CONNECTOR, CREDENTIAL);
    expect((result as { refusal: string }).refusal).toBe('SUBSCRIBER_EVALUATOR_FAILED');
  });

  test('a database failure is refused rather than raised into the delivery pass', async () => {
    const pool = { query: jest.fn(async () => { throw new Error('pg down'); }) } as any;
    const result = await new SubscriberActorService(pool).actorFor(CONNECTOR, CREDENTIAL);
    expect((result as { refusal: string }).refusal).toBe('SUBSCRIBER_EVALUATOR_FAILED');
  });

  test('the principal and its credential are read in ONE statement', async () => {
    const pool = poolWith([row()]);
    resolveChain.mockResolvedValue(chainOf('parent'));
    await new SubscriberActorService(pool).actorFor(CONNECTOR, CREDENTIAL);
    // Two reads could observe a credential revoked between them and deliver
    // once more on authority that no longer exists.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(String(pool.query.mock.calls[0][0])).toContain('LEFT JOIN principal_credentials');
  });
});

describe('C2 round-2 B2: push authority cannot exceed pull authority', () => {
  /**
   * The reviewer's round-2 reproduction, rebuilt: an ACTIVE Connector
   * subscription bound to a live credential holding `tasks:read` but PINNED
   * to `mcp`. A real `GET /api/events` over REST returns 403
   * TRANSPORT_MISMATCH; the candidate accepted the row, cleared the
   * route-scope ceiling, and the worker could send private task IDs.
   *
   * Both halves are asserted from the REAL predicates — the production
   * transport evaluation and the production route ceiling — so this cannot
   * pass by agreeing with itself.
   */
  test('reproduces review r2 B2 and refuses it — an mcp-pinned credential is not deliverable', async () => {
    resolveChain.mockResolvedValue(chainOf('parent'));
    const service = new SubscriberActorService(
      poolWith([row({ credential_transport: 'mcp', credential_scopes: ['tasks:read'] })]),
    );
    const result = await service.actorFor(CONNECTOR, CREDENTIAL);

    // The worker refuses it outright — no actor is produced at all.
    expect(result.ok).toBe(false);
    expect((result as { refusal: string }).refusal).toBe('SUBSCRIBER_TRANSPORT_MISMATCH');

    // And the production ingress predicate agrees, which is the parity the
    // finding was actually about: REST stamps `api`, the pin says `mcp`.
    expect(evaluateTransportPin('mcp', DELIVERY_MIRRORED_PATH, DELIVERY_MIRRORED_TRANSPORT).allowed).toBe(false);
    // The same credential over its own transport class is fine — proving the
    // refusal is the PIN and not a blanket rejection (a positive control).
    expect(evaluateTransportPin('api', DELIVERY_MIRRORED_PATH, DELIVERY_MIRRORED_TRANSPORT).allowed).toBe(true);
    expect(evaluateTransportPin('any', DELIVERY_MIRRORED_PATH, DELIVERY_MIRRORED_TRANSPORT).allowed).toBe(true);
  });

  /**
   * The structural guarantee behind the repair. If a future change re-lists
   * the gates inside the worker instead of asking the shared predicate, this
   * fails — which is the whole point: two implementations drifting apart is
   * how B2 survived a round.
   */
  test('the ingress and the worker share ONE predicate', () => {
    const actorSource = readFileSync(join(__dirname, '..', 'services', 'SubscriberActorService.ts'), 'utf8');
    const authSource = readFileSync(join(__dirname, '..', 'middleware', 'auth.ts'), 'utf8');
    const principalSource = readFileSync(join(__dirname, '..', 'services', 'PrincipalService.ts'), 'utf8');

    for (const source of [actorSource, principalSource]) {
      expect(source).toContain('evaluateCredentialAcceptance');
    }
    for (const source of [actorSource, authSource]) {
      expect(source).toContain('evaluateTransportPin');
    }
    // The worker must not carry its own copies of the gates.
    expect(actorSource).not.toMatch(/credential_type\s*!==\s*'api_key'/);
    expect(actorSource).not.toMatch(/grace_until[\s\S]{0,80}Date\.now\(\)/);
  });

  /**
   * A truth table over the shared predicate itself, at the boundaries rather
   * than near them: `<=` means a watermark exactly reached is EXPIRED, which
   * is what "dies then, sweep or no sweep" requires.
   */
  /**
   * Round 3, B3: the reviewer built a credential row with `key_id=NULL` and
   * `secret_hash='not-a-sha256-digest'` and the worker accepted it, while no
   * `rh_...` bearer could address a NULL key id or timing-safely match that
   * digest. Usability is key MATERIAL, and it is defined once so selection,
   * worker acceptance and pull authentication ask the same question.
   */
  test('usable bearer key material means addressable AND matchable', () => {
    expect(isUsableBearerKeyMaterial('c2conn0000001', 'a'.repeat(64))).toBe(true);
    expect(isUsableBearerKeyMaterial('c2conn0000001', 'A'.repeat(64))).toBe(true);   // hex is case-insensitive
    expect(isUsableBearerKeyMaterial(null, 'a'.repeat(64))).toBe(false);             // unaddressable
    expect(isUsableBearerKeyMaterial('   ', 'a'.repeat(64))).toBe(false);
    expect(isUsableBearerKeyMaterial('c2conn0000001', 'not-a-sha256-digest')).toBe(false);
    expect(isUsableBearerKeyMaterial('c2conn0000001', 'a'.repeat(63))).toBe(false);  // wrong length
    expect(isUsableBearerKeyMaterial('c2conn0000001', 'z'.repeat(64))).toBe(false);  // not hex
    expect(isUsableBearerKeyMaterial('c2conn0000001', null)).toBe(false);
  });

  test('the pull path asks the SAME usability question', () => {
    const source = readFileSync(join(__dirname, '..', 'services', 'PrincipalService.ts'), 'utf8');
    expect(source).toContain('isUsableBearerKeyMaterial(row.key_id, row.secret_hash)');
  });

  test('the shared predicate is exact at the expiry and grace boundaries', () => {
    const now = Date.parse('2026-08-24T12:00:00Z');
    const base = {
      credentialType: 'api_key', keyId: 'c2conn0000001', secretHash: 'a'.repeat(64),
      revokedAt: null, expiresAt: null, graceUntil: null, principalStatus: 'active',
    };
    expect(evaluateCredentialAcceptance(base, now).ok).toBe(true);
    expect(evaluateCredentialAcceptance({ ...base, expiresAt: '2026-08-24T12:00:00Z' }, now))
      .toEqual({ ok: false, denial: 'CREDENTIAL_EXPIRED' });
    expect(evaluateCredentialAcceptance({ ...base, expiresAt: '2026-08-24T12:00:01Z' }, now).ok).toBe(true);
    expect(evaluateCredentialAcceptance({ ...base, graceUntil: '2026-08-24T12:00:00Z' }, now))
      .toEqual({ ok: false, denial: 'CREDENTIAL_GRACE_ELAPSED' });
    expect(evaluateCredentialAcceptance({ ...base, graceUntil: '2026-08-24T12:00:01Z' }, now).ok).toBe(true);
  });
});

describe('C2 work plane: the ASSIGNEE actor (ruling ccd53781 R1, D7)', () => {
  /**
   * The work plane has no subscription to name a credential, so it selects
   * one — and that selection must never be a way to dodge the gates. The
   * chosen row goes through the very same `actorFor` sequence.
   */
  test('selects a live api_key of THIS Connector whose pin permits the mirrored surface', async () => {
    resolveChain.mockResolvedValue(chainOf('parent'));
    const queries: string[] = [];
    const pool = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        // Order matters: the subscriber SELECT mentions `FROM services sv`
        // inside its is_connector EXISTS, so the principals read is matched
        // first and the registry lookup is matched on its own WHERE clause.
        if (sql.includes('FROM principals p')) return { rows: [row()], rowCount: 1 };
        if (sql.includes("kind = 'connector'")) return { rows: [{ principal_id: CONNECTOR }], rowCount: 1 };
        if (sql.includes('FROM principal_credentials c')) return { rows: [{ id: CREDENTIAL }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    } as any;
    const result = await new SubscriberActorService(pool).actorForConnector('service-1');
    expect(result.ok).toBe(true);

    const selection = queries.find((sql) => sql.includes('FROM principal_credentials')) ?? '';
    // Deterministic: same estate, same choice, every pass.
    expect(selection).toContain('ORDER BY c.created_at DESC, c.id DESC');
    // And narrow: the pre-filter refuses everything the shared predicate
    // would refuse anyway, so a bad credential is never even a candidate.
    expect(selection).toContain("c.credential_type = 'api_key'");
    // r3 B3: unaddressable or malformed key material is not even a candidate.
    expect(selection).toContain('c.key_id IS NOT NULL');
    expect(selection).toContain("c.secret_hash ~* '^[0-9a-f]{64}$'");
    expect(selection).toContain('c.revoked_at IS NULL');
    expect(selection).toContain('c.expires_at IS NULL OR c.expires_at > NOW()');
    expect(selection).toContain('c.grace_until IS NULL OR c.grace_until > NOW()');
    expect(selection).toContain("COALESCE(c.transport, 'any') IN ('any', $2)");
  });

  test('a Connector with no usable credential is simply not deliverable', async () => {
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM principals p')) return { rows: [row()], rowCount: 1 };
        if (sql.includes("kind = 'connector'")) return { rows: [{ principal_id: CONNECTOR }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    } as any;
    const result = await new SubscriberActorService(pool).actorForConnector('service-1');
    expect(result.ok).toBe(false);
    expect((result as { refusal: string }).refusal).toBe('SUBSCRIBER_CREDENTIAL_MISSING');
  });

  test('a service id that is not a Connector yields no actor', async () => {
    const pool = poolWith([]);
    const result = await new SubscriberActorService(pool).actorForConnector('service-1');
    expect(result.ok).toBe(false);
    expect((result as { refusal: string }).refusal).toBe('SUBSCRIBER_NOT_FOUND');
  });

  /**
   * The selection changes WHICH credential is used, never HOW strictly it is
   * judged: a selected credential that fails the shared predicate is refused
   * exactly as a named one would be.
   */
  test('a selected credential still clears the full acceptance sequence', async () => {
    resolveChain.mockResolvedValue(chainOf('parent'));
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM principals p')) return { rows: [row({ credential_transport: 'mcp' })], rowCount: 1 };
        if (sql.includes("kind = 'connector'")) return { rows: [{ principal_id: CONNECTOR }], rowCount: 1 };
        if (sql.includes('FROM principal_credentials c')) return { rows: [{ id: CREDENTIAL }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    } as any;
    const result = await new SubscriberActorService(pool).actorForConnector('service-1');
    expect(result.ok).toBe(false);
    expect((result as { refusal: string }).refusal).toBe('SUBSCRIBER_TRANSPORT_MISMATCH');
  });
});

describe('C2 causal subtree walks DESCENDANTS (review r1, B4)', () => {
  /**
   * `resolveChain` walks ANCESTORS. Causation needs the other direction: a
   * subscriber acts through the identities BELOW it, and those are the writes
   * that must not be delivered back to it.
   */
  test('the subtree query recurses through parent_principal_id downward', async () => {
    const pool = poolWith([{ id: CONNECTOR }, { id: 'child-1' }, { id: 'child-2' }]);
    const causal = await new SubscriberActorService(pool).causalSubtree(CONNECTOR);
    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql).toContain('WITH RECURSIVE');
    // Downward: a child joins ON child.parent_principal_id = parent.id.
    expect(sql).toContain('JOIN subtree s ON child.parent_principal_id = s.id');
    expect(causal.has(CONNECTOR)).toBe(true);
    expect(causal.has('child-1')).toBe(true);
    expect(causal.has('child-2')).toBe(true);
  });

  test('an unresolvable subtree still suppresses the subscriber itself', async () => {
    const pool = { query: jest.fn(async () => { throw new Error('pg down'); }) } as any;
    const causal = await new SubscriberActorService(pool).causalSubtree(CONNECTOR);
    expect(causal.has(CONNECTOR)).toBe(true);
    expect(causal.size).toBe(1);
  });
});
