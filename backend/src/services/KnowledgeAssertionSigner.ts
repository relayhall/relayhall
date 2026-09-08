// KnowledgeAssertionSigner.ts — RH-KW1 candidate B (card `0b4b779b`).
//
// §5.2's caller-context assertion: ONE component, called only by the fan-out
// executor and the get executor, refusing any call not carrying an
// executor-issued arm-evaluation result. There is no mint endpoint.
//
// ── WHAT AN ASSERTION IS, AND IS NOT (§5.4, §5.6) ──
//
// It authenticates nothing and no one. The CHANNEL authenticates core to the
// source (§4.2); the assertion is attested context riding on that channel,
// like a signed request header. A third party who captures one cannot use it:
// it fails at channel authentication before it is ever read. So the evidence
// may claim exchange-never-passthrough at exactly that strength and no more.
//
// ── THE jti BOUND, STATED HONESTLY (sol R1-7) ──
//
// Core keeps a TTL-bounded seen-set of EMITTED jti values and never emits a
// collision. That is a guarantee about EMISSION. Replay at a relying source
// is bounded by TTL + channel authentication, NOT by `jti`. Nothing here
// detects replay, and mandatory source-side replay detection is deferred
// hardening in the `d77d1f53` class.
import crypto from 'crypto';
import { pool } from '../db/connection';
import {
  isKnowledgeArmEvaluation,
  ARM_EVALUATION_MAX_AGE_SECONDS,
  type KnowledgeArmEvaluation,
} from './KnowledgeArmEvaluator';

/** §5.2: TTL default 30s, max 60s, skew budget ±10s. */
export const ASSERTION_DEFAULT_TTL_SECONDS = 30;
export const ASSERTION_MAX_TTL_SECONDS = 60;
export const ASSERTION_SKEW_SECONDS = 10;
export const ASSERTION_TYP = 'rh-knowledge-assertion+jwt';

export class KnowledgeAssertionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'KnowledgeAssertionError';
  }
}

interface AssertionKeyset {
  keys: Map<string, crypto.KeyObject>;
  retired: Set<string>;
  activeKeyId: string;
}

let cached: AssertionKeyset | null = null;

export function resetKnowledgeAssertionKeysetCache(): void {
  cached = null;
}

export function knowledgeAssertionKeysetConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS && env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY);
}

/**
 * Ed25519 private keys, base64 PKCS#8, from the environment and never the
 * board — the `utils/credentialCrypto.ts` pattern (AZ-S3 §7.2). Node's
 * built-in `crypto` supplies Ed25519 sign/verify and JWK export, so owner
 * decision D4(a) — zero new packages — holds.
 */
export function loadKnowledgeAssertionKeyset(env: NodeJS.ProcessEnv = process.env): AssertionKeyset {
  const raw = env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS;
  const activeKeyId = env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY || '';
  if (!raw || !activeKeyId) {
    throw new KnowledgeAssertionError(
      'KNOWLEDGE_ASSERTION_KEYSET_MISSING',
      'RELAYHALL_KNOWLEDGE_ASSERTION_KEYS and RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY must be set (design 94747de9 §5.2)',
    );
  }
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KnowledgeAssertionError('KNOWLEDGE_ASSERTION_KEYSET_INVALID', 'RELAYHALL_KNOWLEDGE_ASSERTION_KEYS is not valid JSON');
  }
  const keys = new Map<string, crypto.KeyObject>();
  for (const [keyId, value] of Object.entries(parsed)) {
    let key: crypto.KeyObject;
    try {
      key = crypto.createPrivateKey({
        key: Buffer.from(String(value), 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    } catch {
      throw new KnowledgeAssertionError('KNOWLEDGE_ASSERTION_KEYSET_INVALID', `keyset entry '${keyId}' is not a PKCS#8 key`);
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new KnowledgeAssertionError('KNOWLEDGE_ASSERTION_KEYSET_INVALID', `keyset entry '${keyId}' is not Ed25519`);
    }
    keys.set(keyId, key);
  }
  const retired = new Set(
    (env.RELAYHALL_KNOWLEDGE_ASSERTION_RETIRED_KEYS || '')
      .split(',').map((e) => e.trim()).filter((e) => e.length > 0),
  );
  if (!keys.has(activeKeyId)) {
    throw new KnowledgeAssertionError('KNOWLEDGE_ASSERTION_KEYSET_INVALID', 'RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY names no keyset entry');
  }
  if (retired.has(activeKeyId)) {
    throw new KnowledgeAssertionError('KNOWLEDGE_ASSERTION_KEYSET_INVALID', 'the active assertion key may not also be retired');
  }
  return { keys, retired, activeKeyId };
}

function keyset(): AssertionKeyset {
  if (!cached) cached = loadKnowledgeAssertionKeyset();
  return cached;
}

/**
 * The PUBLIC half of every non-retired key, as a JWK set.
 *
 * Rotation is publish-new / retire-old WITH OVERLAP, so a retired key stays
 * verifiable at the source until its last assertion has expired — but it is
 * dropped from the published set, because publishing it would invite new
 * verifications against a key core will not sign with again.
 */
export function knowledgeAssertionJwks(): { keys: Array<Record<string, string>> } {
  const { keys, retired } = keyset();
  const out: Array<Record<string, string>> = [];
  for (const [kid, key] of keys) {
    if (retired.has(kid)) continue;
    const jwk = crypto.createPublicKey(key).export({ format: 'jwk' }) as Record<string, string>;
    // PUBLIC HALF ONLY. `d` is the private scalar; a JWK set that carried it
    // would hand every reader the signing key. The delete is belt-and-braces
    // — `createPublicKey` already drops it — and the JWKS drill asserts the
    // served bytes, not this line.
    delete jwk.d;
    out.push({ ...jwk, kid, use: 'sig', alg: 'EdDSA' });
  }
  return { keys: out };
}

export interface KnowledgeAssertionClaims {
  iss: string;
  act: 'relayhall-core';
  sub: string;
  grp: string[];
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

const base64url = (value: Buffer | string): string =>
  (Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')).toString('base64url');

/**
 * §5.2's pairwise pseudonym: a per-source stable identifier core derives from
 * `(accountId, sourceId)`. It removes the cross-source join at zero stateful
 * cost — two sources cannot tell they are talking about the same Account —
 * and it is the DEFAULT; `direct` is an owner-plane opt-out per source.
 *
 * HMAC keyed with the ACTIVE assertion key's raw bytes, so the pseudonym is
 * unguessable without the deployment's own key material.
 */
function pairwiseSubject(accountPrincipalId: string, sourceId: string): string {
  const { keys, activeKeyId } = keyset();
  const seed = (keys.get(activeKeyId) as crypto.KeyObject).export({ format: 'der', type: 'pkcs8' });
  return crypto.createHmac('sha256', seed).update(`${accountPrincipalId}|${sourceId}`).digest('base64url');
}

/**
 * Record an EMITTED `jti`. Returns false when the row already exists, which
 * is the collision case: the caller refuses rather than emitting a duplicate.
 * The uniqueness is the PRIMARY KEY, not a read-then-write.
 */
async function recordEmittedJti(jti: string, expiresAt: Date, sourceId: string): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO knowledge_assertion_jti (jti, expires_at, source_id)
     VALUES ($1, $2, $3) ON CONFLICT (jti) DO NOTHING RETURNING jti`,
    [jti, expiresAt.toISOString(), sourceId],
  );
  return result.rows.length === 1;
}

/** Sweep expired rows. Bounded by construction; safe to call at any time. */
export async function sweepExpiredAssertionJti(): Promise<number> {
  const result = await pool.query('DELETE FROM knowledge_assertion_jti WHERE expires_at < NOW() RETURNING jti');
  return result.rows.length;
}

export interface SignAssertionInput {
  /** The ONLY way in: an evaluation this deployment's arm evaluator minted. */
  armEvaluation: KnowledgeArmEvaluation;
  /** The deployment identity that issues assertions. */
  issuer: string;
  /** The caller's groups, before §5.3 minimization. */
  callerGroupIds: readonly string[];
  ttlSeconds?: number;
}

/**
 * Sign one caller-context assertion.
 *
 * THE ISSUANCE PREDICATE IS THE FIRST STATEMENT, deliberately: everything
 * else in this function is unreachable without an evaluation this deployment
 * minted. That is what makes the property a producer set rather than a call
 * count — a caller with every field right but a hand-built token is refused.
 */
export async function signKnowledgeAssertion(input: SignAssertionInput): Promise<string> {
  if (!isKnowledgeArmEvaluation(input.armEvaluation)) {
    throw new KnowledgeAssertionError(
      'ASSERTION_WITHOUT_ARM_EVALUATION',
      'the signer refuses any call not carrying an executor-issued arm-evaluation result (design 94747de9 §5.2)',
    );
  }
  const arms = input.armEvaluation;
  if (arms.claimsMode !== 'asserted') {
    // §8.2: a `none`-mode source receives NO assertion. Signing one anyway
    // would be a disclosure the owner turned off.
    throw new KnowledgeAssertionError(
      'ASSERTION_NOT_FOR_CLAIMS_MODE',
      "a source in claims mode 'none' receives no assertion (design 94747de9 §8.2)",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  if (now - arms.at > ARM_EVALUATION_MAX_AGE_SECONDS) {
    // The arm set is evaluated BEFORE every signing (§5.2). A stale
    // evaluation would sign authority nobody re-checked.
    throw new KnowledgeAssertionError('ASSERTION_ARM_EVALUATION_STALE', 'the arm evaluation is too old to sign against');
  }

  const ttl = Math.min(input.ttlSeconds ?? ASSERTION_DEFAULT_TTL_SECONDS, ASSERTION_MAX_TTL_SECONDS);
  const { keys, activeKeyId } = keyset();
  const key = keys.get(activeKeyId) as crypto.KeyObject;

  // §5.3 minimization: the source receives ONLY the groups its owner declared
  // relevant. An empty list is the empty array, which §7.2 obliges the source
  // to read as "no releasable group context", never as its uniform ceiling.
  const relevant = new Set(arms.relevantGroups);
  const grp = input.callerGroupIds.filter((id) => relevant.has(id));

  const claims: KnowledgeAssertionClaims = {
    iss: input.issuer,
    act: 'relayhall-core',
    sub: arms.subjectMode === 'direct'
      ? arms.accountPrincipalId
      : pairwiseSubject(arms.accountPrincipalId, arms.sourceId),
    grp,
    aud: arms.sourceId,
    iat: now,
    nbf: now - ASSERTION_SKEW_SECONDS,
    exp: now + ttl,
    jti: crypto.randomBytes(18).toString('base64url'),
  };

  // `agt` is DROPPED (round 2): it had no source-side consumer and disclosed
  // fleet structure.
  const header = { alg: 'EdDSA', typ: ASSERTION_TYP, kid: activeKeyId };

  if (!await recordEmittedJti(claims.jti, new Date(claims.exp * 1000), arms.sourceId)) {
    throw new KnowledgeAssertionError(
      'ASSERTION_JTI_COLLISION',
      'refusing to emit a colliding jti (design 94747de9 §5.2)',
    );
  }

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), key);
  return `${signingInput}.${signature.toString('base64url')}`;
}
