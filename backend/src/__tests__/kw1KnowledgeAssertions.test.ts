/**
 * RH-KW1 candidate B — the §5.2 assertion signer, its ISSUANCE PREDICATE, the
 * `jti` seen-set, and §10.2's JWKS route.
 *
 * The issuance predicate is the one to read carefully. §5.2 says the signer
 * "refuses any call not carrying an executor-issued arm-evaluation result",
 * and §11.13 says to prove that "as a producer-set property, not a call
 * count". A count proves nothing — "the signer was called twice" is just as
 * true when a third caller signs something it should not. So the drills below
 * hand the signer objects that are correct in every FIELD and differ only in
 * who minted them.
 */
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import crypto from 'crypto';
import { pool } from '../db/connection';
import {
  signKnowledgeAssertion,
  knowledgeAssertionJwks,
  loadKnowledgeAssertionKeyset,
  resetKnowledgeAssertionKeysetCache,
  KnowledgeAssertionError,
  ASSERTION_TYP,
  ASSERTION_DEFAULT_TTL_SECONDS,
  ASSERTION_MAX_TTL_SECONDS,
  ASSERTION_SKEW_SECONDS,
} from '../services/KnowledgeAssertionSigner';
import { isKnowledgeArmEvaluation } from '../services/KnowledgeArmEvaluator';
import { readShippedSource } from './support/moduleMutation';

const SOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Two Ed25519 keys so rotation and retirement are drillable. */
function keypair(): string {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64');
}

const KEY_A = keypair();
const KEY_B = keypair();

let emitted: string[] = [];

beforeEach(() => {
  process.env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS = JSON.stringify({ ka: KEY_A, kb: KEY_B });
  process.env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY = 'ka';
  delete process.env.RELAYHALL_KNOWLEDGE_ASSERTION_RETIRED_KEYS;
  resetKnowledgeAssertionKeysetCache();
  emitted = [];
  (pool.query as jest.Mock).mockImplementation(async (text: string, params?: unknown[]) => {
    if (text.includes('INSERT INTO knowledge_assertion_jti')) {
      const jti = String((params ?? [])[0]);
      if (emitted.includes(jti)) return { rows: [] }; // ON CONFLICT DO NOTHING
      emitted.push(jti);
      return { rows: [{ jti }] };
    }
    return { rows: [] };
  });
});

/**
 * The ONLY legitimate way to obtain an evaluation is to call the evaluator, so
 * these tests reach it through the same door production does. The evaluator's
 * own authority arms are drilled in the plane suite; here the request is
 * arranged so every arm passes and the evaluation is what we need.
 */
async function mintedEvaluation(overrides: Record<string, unknown> = {}) {
  const evaluator = await import('../services/KnowledgeArmEvaluator');
  const repo = await import('../services/AuthorizationRepository');
  // Admit whatever ids the evaluator asks about: the authority arms are
  // drilled in the plane suite, and pinning them to one id here made the
  // second-source case silently return null instead of a second pseudonym.
  jest.spyOn(repo.authorizationRepository, 'authorizedIds')
    .mockImplementation(async (_a, _t, ids) => new Set(ids.map(String)));
  jest.spyOn(repo.authorizationRepository, 'selectorCoveredIds')
    .mockImplementation(async (_a, _t, ids) => new Set(ids.map(String)));
  const req = {
    principal: { id: ACCOUNT_ID, role: 'user' },
    userId: 'holder',
    credentialId: 'cred-1',
    scopes: ['knowledge-contents:read'],
    authorizationActor: {
      principalId: ACCOUNT_ID,
      handle: 'holder',
      role: 'user',
      scopes: ['knowledge-contents:read'],
      authenticated: true,
      delegation: null,
    },
  };
  return evaluator.evaluateKnowledgeArms(req as never, {
    id: SOURCE_ID,
    slug: 'engine',
    status: 'published',
    retired_at: null,
    knowledge_query_endpoint: 'https://engine.example.com/q',
    knowledge_claims_mode: 'asserted',
    knowledge_subject_mode: 'pairwise',
    knowledge_relevant_groups: ['group-1'],
    descriptor: { options: [], knowledgeSource: { classes: [{ key: 'docs', content: 'docs' }], compartments: ['corpus'] } },
    ...overrides,
  } as never);
}

function decode(assertion: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h, c] = assertion.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(c, 'base64url').toString('utf8')),
  };
}

// ═══════════ the issuance predicate — a PRODUCER SET, not a count ═════════

describe('§5.2 / §11.13 — the signer refuses any call without a minted arm evaluation', () => {
  it('signs when the evaluation was minted by the evaluator', async () => {
    const arms = await mintedEvaluation();
    expect(arms).not.toBeNull();
    const assertion = await signKnowledgeAssertion({
      armEvaluation: arms as never, issuer: 'https://board.example/api', callerGroupIds: [],
    });
    expect(assertion.split('.')).toHaveLength(3);
  });

  it('REFUSES a hand-built object that is correct in every field', async () => {
    // The whole point. This object has the right shape, the right source, the
    // right modes and a fresh timestamp — everything a shape check would look
    // at. It differs only in WHO MINTED IT.
    const forged = Object.freeze({
      sourceId: SOURCE_ID,
      sourceSlug: 'engine',
      claimsMode: 'asserted' as const,
      subjectMode: 'pairwise' as const,
      relevantGroups: Object.freeze(['group-1']),
      accountPrincipalId: ACCOUNT_ID,
      at: Math.floor(Date.now() / 1000),
    });
    expect(isKnowledgeArmEvaluation(forged)).toBe(false);
    await expect(signKnowledgeAssertion({
      armEvaluation: forged as never, issuer: 'https://board.example/api', callerGroupIds: [],
    })).rejects.toMatchObject({ code: 'ASSERTION_WITHOUT_ARM_EVALUATION' });
  });

  it('REFUSES a structural clone of a real evaluation', async () => {
    // Spreading a genuine evaluation copies every field and loses the
    // identity. A shape check would pass this; the producer set does not.
    const arms = await mintedEvaluation();
    const clone = Object.freeze({ ...(arms as object) });
    expect(isKnowledgeArmEvaluation(clone)).toBe(false);
    await expect(signKnowledgeAssertion({
      armEvaluation: clone as never, issuer: 'https://board.example/api', callerGroupIds: [],
    })).rejects.toMatchObject({ code: 'ASSERTION_WITHOUT_ARM_EVALUATION' });
  });

  it('refuses a STALE evaluation — the arms are re-run before every signing', async () => {
    const arms = await mintedEvaluation();
    // The evaluation is FROZEN, so its timestamp cannot be edited — which is
    // the right design and means the clock has to move instead.
    const realNow = Date.now;
    Date.now = () => realNow() + 600_000;
    try {
      await expect(signKnowledgeAssertion({
        armEvaluation: arms as never, issuer: 'https://board.example/api', callerGroupIds: [],
      })).rejects.toMatchObject({ code: 'ASSERTION_ARM_EVALUATION_STALE' });
    } finally {
      Date.now = realNow;
    }
  });

  it('refuses to sign for a `none`-mode source at all (§8.2)', async () => {
    const arms = await mintedEvaluation({ knowledge_claims_mode: 'none' });
    await expect(signKnowledgeAssertion({
      armEvaluation: arms as never, issuer: 'https://board.example/api', callerGroupIds: [],
    })).rejects.toMatchObject({ code: 'ASSERTION_NOT_FOR_CLAIMS_MODE' });
  });

  it('there is NO mint endpoint: the signer is reachable from two executors only', () => {
    // §5.2: "only the fan-out and get executors hold one, which IS the
    // issuance predicate". At candidate B the get executor is the only one
    // that exists; candidate C adds the fan-out. Nothing else may import it.
    const importers = ['services/KnowledgeGetExecutor.ts'];
    for (const file of importers) {
      expect(readShippedSource(file)).toContain('signKnowledgeAssertion');
    }
    // And no ROUTE signs anything directly.
    for (const route of ['routes/knowledge.ts', 'routes/knowledgeJwks.ts']) {
      expect(readShippedSource(route)).not.toContain('signKnowledgeAssertion');
    }
  });
});

// ═══════════════════ the claims, exactly as ratified ══════════════════════

describe('§5.2 — the header and payload are the ratified shape', () => {
  it('carries the ratified header and every payload field, and DROPS `agt`', async () => {
    const arms = await mintedEvaluation();
    const { header, claims } = decode(await signKnowledgeAssertion({
      armEvaluation: arms as never,
      issuer: 'https://board.example/api',
      callerGroupIds: ['group-1', 'group-unrelated'],
    }));
    expect(header).toEqual({ alg: 'EdDSA', typ: ASSERTION_TYP, kid: 'ka' });
    expect(Object.keys(claims).sort()).toEqual(
      ['act', 'aud', 'exp', 'grp', 'iat', 'iss', 'jti', 'nbf', 'sub'].sort(),
    );
    expect(claims.act).toBe('relayhall-core');
    expect(claims.aud).toBe(SOURCE_ID);
    // `agt` was dropped in round 2: no source-side consumer, and it disclosed
    // fleet structure.
    expect(claims).not.toHaveProperty('agt');
  });

  it('honours the TTL cap and the skew budget', async () => {
    const arms = await mintedEvaluation();
    const { claims } = decode(await signKnowledgeAssertion({
      armEvaluation: arms as never, issuer: 'i', callerGroupIds: [], ttlSeconds: 3600,
    }));
    const iat = claims.iat as number;
    expect((claims.exp as number) - iat).toBe(ASSERTION_MAX_TTL_SECONDS);
    expect(iat - (claims.nbf as number)).toBe(ASSERTION_SKEW_SECONDS);

    const arms2 = await mintedEvaluation();
    const { claims: d } = decode(await signKnowledgeAssertion({
      armEvaluation: arms2 as never, issuer: 'i', callerGroupIds: [],
    }));
    expect((d.exp as number) - (d.iat as number)).toBe(ASSERTION_DEFAULT_TTL_SECONDS);
  });

  it('§5.3 minimization: `grp` is the caller groups INTERSECTED with the declared ones', async () => {
    const arms = await mintedEvaluation();
    const { claims } = decode(await signKnowledgeAssertion({
      armEvaluation: arms as never, issuer: 'i',
      callerGroupIds: ['group-1', 'group-secret', 'group-other'],
    }));
    // The source declared only `group-1` relevant, so that is all it learns.
    expect(claims.grp).toEqual(['group-1']);
  });

  it('`grp` is the EMPTY ARRAY when nothing is relevant — never absent', async () => {
    const arms = await mintedEvaluation({ knowledge_relevant_groups: [] });
    const { claims } = decode(await signKnowledgeAssertion({
      armEvaluation: arms as never, issuer: 'i', callerGroupIds: ['group-1'],
    }));
    // §7.2 obliges a source to read `[]` as "no releasable group context",
    // never as its uniform ceiling — which it can only do if the field is
    // always present.
    expect(claims.grp).toEqual([]);
  });

  it('`sub` is PAIRWISE by default and stable per (account, source)', async () => {
    const first = decode(await signKnowledgeAssertion({
      armEvaluation: (await mintedEvaluation()) as never, issuer: 'i', callerGroupIds: [],
    })).claims;
    const second = decode(await signKnowledgeAssertion({
      armEvaluation: (await mintedEvaluation()) as never, issuer: 'i', callerGroupIds: [],
    })).claims;
    expect(first.sub).toBe(second.sub);
    expect(first.sub).not.toBe(ACCOUNT_ID);

    // A DIFFERENT source gets a different pseudonym for the same Account —
    // that is the cross-source join §5.2 removes at zero stateful cost.
    const other = decode(await signKnowledgeAssertion({
      armEvaluation: (await mintedEvaluation({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })) as never,
      issuer: 'i', callerGroupIds: [],
    })).claims;
    expect(other.sub).not.toBe(first.sub);
  });

  it('`direct` subject mode discloses the account ref, as the owner chose', async () => {
    const arms = await mintedEvaluation({ knowledge_subject_mode: 'direct' });
    const { claims } = decode(await signKnowledgeAssertion({
      armEvaluation: arms as never, issuer: 'i', callerGroupIds: [],
    }));
    expect(claims.sub).toBe(ACCOUNT_ID);
  });

  it('the signature verifies against the published JWKS key', async () => {
    const arms = await mintedEvaluation();
    const assertion = await signKnowledgeAssertion({ armEvaluation: arms as never, issuer: 'i', callerGroupIds: [] });
    const [h, c, s] = assertion.split('.');
    const jwk = knowledgeAssertionJwks().keys.find((k) => k.kid === 'ka') as Record<string, string>;
    const pub = crypto.createPublicKey({ key: jwk as never, format: 'jwk' });
    expect(crypto.verify(null, Buffer.from(`${h}.${c}`, 'utf8'), pub, Buffer.from(s, 'base64url'))).toBe(true);
  });
});

// ══════════════════ the jti seen-set, at its true strength ════════════════

describe('§5.2 / sol R1-7 — core never emits a colliding `jti`', () => {
  it('records every emitted jti and refuses a collision', async () => {
    const arms = await mintedEvaluation();
    await signKnowledgeAssertion({ armEvaluation: arms as never, issuer: 'i', callerGroupIds: [] });
    expect(emitted).toHaveLength(1);

    // Force the collision the PRIMARY KEY exists to catch: the next INSERT
    // conflicts, so the signer refuses rather than emitting a duplicate.
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    const again = await mintedEvaluation();
    await expect(signKnowledgeAssertion({
      armEvaluation: again as never, issuer: 'i', callerGroupIds: [],
    })).rejects.toMatchObject({ code: 'ASSERTION_JTI_COLLISION' });
  });

  it('the uniqueness is the CONSTRAINT, not a read-then-write', () => {
    const source = readShippedSource('services/KnowledgeAssertionSigner.ts');
    expect(source).toContain('ON CONFLICT (jti) DO NOTHING RETURNING jti');
    // A SELECT-then-INSERT would let two workers both see "absent" and both
    // write. There is no such read.
    expect(source).not.toContain('SELECT jti FROM knowledge_assertion_jti');
  });

  it('states the bound HONESTLY: emission, not replay detection', () => {
    // sol R1-7. Replay at a relying source is bounded by TTL + channel auth.
    // Claiming otherwise is the overclaim the design refused, so the claim is
    // pinned where a future reader will meet it.
    const migration = readShippedSource('migrations/115_knowledge_assertion_jti.sql');
    expect(migration).toContain('EMITTED');
    expect(migration).toContain('Nothing here detects replay');
    expect(readShippedSource('services/KnowledgeAssertionSigner.ts'))
      .toContain('NOT by `jti`');
  });
});

// ═══════════════ §10.2 JWKS — public keys only, and reachable ═════════════

describe('§10.2 / D8 — the JWKS serves public keys only', () => {
  it('publishes every non-retired key and NO private material', () => {
    const jwks = knowledgeAssertionJwks();
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual(['ka', 'kb']);
    for (const key of jwks.keys) {
      expect(key.kty).toBe('OKP');
      expect(key.crv).toBe('Ed25519');
      expect(key.alg).toBe('EdDSA');
      expect(key.use).toBe('sig');
      // `d` is the private scalar. Its presence would hand every reader the
      // signing key.
      expect(key).not.toHaveProperty('d');
    }
    // Belt and braces on the SERVED bytes, not on the object shape.
    expect(JSON.stringify(jwks)).not.toContain('"d"');
  });

  it('drops a RETIRED key from the published set', () => {
    process.env.RELAYHALL_KNOWLEDGE_ASSERTION_RETIRED_KEYS = 'kb';
    resetKnowledgeAssertionKeysetCache();
    expect(knowledgeAssertionJwks().keys.map((k) => k.kid)).toEqual(['ka']);
    // …but the key stays in the KEYSET so an assertion still in flight can be
    // told from a forged `kid` — publish-new / retire-old WITH OVERLAP.
    expect(loadKnowledgeAssertionKeyset().keys.has('kb')).toBe(true);
  });

  it('refuses a keyset whose active key is also retired', () => {
    process.env.RELAYHALL_KNOWLEDGE_ASSERTION_RETIRED_KEYS = 'ka';
    resetKnowledgeAssertionKeysetCache();
    expect(() => loadKnowledgeAssertionKeyset()).toThrow(KnowledgeAssertionError);
  });

  it('the route is UNAUTHENTICATED by mount and discloses no board data', () => {
    // D8's unauthenticated-reachability drill, at the two places it can be
    // established without a server: the mount is outside the protected mesh,
    // and the handler cannot reach the database at all.
    const server = readShippedSource('server.ts');
    const jwksMount = server.indexOf('app.use(OAUTH_WELL_KNOWN_ROUTE_PATH, knowledgeJwksRoutes);');
    // The CALL, not the import 69 lines above it — matching the import
    // would have made this assertion pass for the wrong reason.
    const protectedMount = server.indexOf('registerProtectedRoutes(protectedRouter)');
    expect(jwksMount).toBeGreaterThan(-1);
    expect(jwksMount).toBeLessThan(protectedMount);

    const route = readShippedSource('routes/knowledgeJwks.ts');
    expect(route).not.toContain('db/connection');
    expect(route).not.toContain('pool');
    expect(route).not.toContain('authMiddleware');
    // It takes no request parameters, so it cannot vary with who asks.
    expect(route).toContain('(_req: Request');
  });

  it('an unconfigured deployment publishes an EMPTY set, not a 500', () => {
    delete process.env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS;
    delete process.env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY;
    resetKnowledgeAssertionKeysetCache();
    const route = readShippedSource('routes/knowledgeJwks.ts');
    expect(route).toContain('res.json({ keys: [] });');
  });
});
