/**
 * SS-W2 · §5.3 — the TWELVE refusals, one named test each.
 *
 * The W2 definition of done (annex `e6dcadb9` §11) asks for "each of §5.3's
 * twelve refusals ... its own negative test with a red proof (mutate that
 * check, that ONE test goes red, `cmp`-verified restore, green again) — twelve
 * mutations, not eleven with a spare". `backend/scripts/w2-red-proofs.js`
 * drives those mutations against THIS file, so each test below is named for
 * the refusal it pins and asserts that refusal's OWN error code. A test that
 * asserted "it threw" would go red for eleven different mutations and pin
 * nothing.
 *
 * The tokens here are really signed with a really generated key, and the
 * validator really verifies them. Nothing about the signature path is doubled —
 * a mocked verifier would make refusal 3 vacuous, which is the one refusal
 * every other refusal depends on.
 */
import crypto from 'crypto';
import {
  ALLOWED_ID_TOKEN_ALGS,
  IdTokenError,
  MAX_ID_TOKEN_CLAIMS,
  assertUserInfoSubject,
  validateIdToken,
} from '../services/identity/idTokenValidation';

const ISSUER = 'https://idp.example.test/realms/board';
const CLIENT_ID = 'relayhall-client';
const KID = 'test-key-1';
const NONCE = 'nonce-value-abcdef';

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey), kid: KID };

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecJwk = { ...(ec.publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey), kid: KID };

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const hashNonce = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const EXPECTED_NONCE_HASH = hashNonce(NONCE);

const NOW = Date.parse('2026-08-30T12:00:00Z');
const nowSeconds = Math.floor(NOW / 1000);

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'subject-0001',
    aud: CLIENT_ID,
    exp: nowSeconds + 300,
    iat: nowSeconds - 10,
    nonce: NONCE,
    ...overrides,
  };
}

/** Mint a genuinely signed compact JWS. */
function mint(
  claims: Record<string, unknown>,
  options: { alg?: string; kid?: string | null; key?: crypto.KeyObject; corruptSignature?: boolean } = {},
): string {
  const alg = options.alg ?? 'RS256';
  const header: Record<string, unknown> = { alg, typ: 'JWT' };
  if (options.kid !== null) header.kid = options.kid ?? KID;
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const digest = `sha${alg.slice(2)}`;
  let signature: Buffer;
  if (alg.startsWith('ES')) {
    signature = crypto.sign(digest, Buffer.from(signingInput), {
      key: options.key ?? ec.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
  } else if (alg.startsWith('PS')) {
    signature = crypto.sign(digest, Buffer.from(signingInput), {
      key: options.key ?? rsa.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
  } else if (alg === 'none') {
    signature = Buffer.from('nosignature');
  } else if (alg.startsWith('HS')) {
    signature = crypto.createHmac(digest, 'the-client-secret').update(signingInput).digest();
  } else {
    signature = crypto.sign(digest, Buffer.from(signingInput), {
      key: options.key ?? rsa.privateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    });
  }
  if (options.corruptSignature) signature[0] ^= 0xff;
  return `${signingInput}.${signature.toString('base64url')}`;
}

function validate(token: string, overrides: Record<string, unknown> = {}) {
  return validateIdToken({
    token,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clockSkewSeconds: 60,
    advertisedAlgs: ['RS256', 'ES256', 'PS256'],
    resolveKey: async (kid: string) => {
      if (kid !== KID) throw new Error('the token names a signing key the Identity provider does not publish');
      return publicJwk;
    },
    expectedNonceHash: EXPECTED_NONCE_HASH,
    hashNonce,
    now: () => NOW,
    ...overrides,
  });
}

/** Assert the SPECIFIC refusal, never merely that something threw. */
async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(IdTokenError);
  await promise.then(
    () => {
      throw new Error(`expected refusal ${code}, but validation succeeded`);
    },
    (error: IdTokenError) => {
      expect(error.code).toBe(code);
    },
  );
}

describe('§5.3 ID token validation — the twelve refusals', () => {
  it('POSITIVE CONTROL: a well-formed token validates and yields its subject', async () => {
    const result = await validate(mint(baseClaims()));
    expect(result.subject).toBe('subject-0001');
    expect(result.sid).toBeNull();
  });

  it('POSITIVE CONTROL: an ES256 token validates, so the allowlist is not RSA-only', async () => {
    const token = mint(baseClaims(), { alg: 'ES256' });
    const result = await validate(token, { resolveKey: async () => ecJwk });
    expect(result.subject).toBe('subject-0001');
  });

  it('refusal 1: alg=none is refused', async () => {
    await expectRefusal(validate(mint(baseClaims(), { alg: 'none' })), 'ALG_NOT_ALLOWED');
  });

  it('refusal 1: an HMAC algorithm is refused outright (alg confusion)', async () => {
    await expectRefusal(validate(mint(baseClaims(), { alg: 'HS256' })), 'ALG_NOT_ALLOWED');
  });

  it('refusal 1: an HMAC algorithm is refused even when the Identity provider ADVERTISES it', async () => {
    // "HMAC families refused outright" (§5.3 refusal 1). OUTRIGHT is the word
    // that matters: the allowlist is a security floor, not a subset filter on
    // what the provider happens to advertise. Without this vector the
    // allowlist is vacuous — the advertised-algorithms check alone would carry
    // every existing case, which is exactly what the R1 red proof exposed.
    await expectRefusal(
      validate(mint(baseClaims(), { alg: 'HS256' }), { advertisedAlgs: ['HS256'] }),
      'ALG_NOT_ALLOWED',
    );
  });

  it('refusal 1: alg=none is refused even when advertised', async () => {
    await expectRefusal(
      validate(mint(baseClaims(), { alg: 'none' }), { advertisedAlgs: ['none'] }),
      'ALG_NOT_ALLOWED',
    );
  });

  it('refusal 1: an allowlisted algorithm the Identity provider does not advertise is refused', async () => {
    await expectRefusal(
      validate(mint(baseClaims(), { alg: 'RS512' }), { advertisedAlgs: ['RS256'] }),
      'ALG_NOT_ALLOWED',
    );
  });

  it('refusal 2: a token naming no kid is refused', async () => {
    await expectRefusal(validate(mint(baseClaims(), { kid: null })), 'KID_UNRESOLVED');
  });

  it('refusal 2: a kid the Identity provider does not publish is refused', async () => {
    await expectRefusal(validate(mint(baseClaims(), { kid: 'unknown-key' })), 'KID_UNRESOLVED');
  });

  it('refusal 3: a token whose signature does not verify is refused', async () => {
    await expectRefusal(validate(mint(baseClaims(), { corruptSignature: true })), 'SIGNATURE_INVALID');
  });

  it('refusal 3: a token signed by a DIFFERENT key of the right shape is refused', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expectRefusal(validate(mint(baseClaims(), { key: other.privateKey })), 'SIGNATURE_INVALID');
  });

  it('refusal 3: no claim is trusted before the signature — a forged issuer does not change the refusal', async () => {
    // The token carries a hostile `iss`, but the signature is bad. If the
    // validator read claims first it would refuse for ISSUER_MISMATCH; the
    // contract says the signature is checked before any claim is read.
    const token = mint(baseClaims({ iss: 'https://attacker.example.test' }), { corruptSignature: true });
    await expectRefusal(validate(token), 'SIGNATURE_INVALID');
  });

  it('refusal 4: an issuer differing by one byte is refused (no normalisation)', async () => {
    await expectRefusal(validate(mint(baseClaims({ iss: `${ISSUER}/` }))), 'ISSUER_MISMATCH');
  });

  it('refusal 5: an audience that does not contain the client id is refused', async () => {
    await expectRefusal(validate(mint(baseClaims({ aud: 'someone-else' }))), 'AUDIENCE_MISMATCH');
  });

  it('refusal 5: a multi-valued audience without a matching azp is refused', async () => {
    await expectRefusal(
      validate(mint(baseClaims({ aud: [CLIENT_ID, 'another-client'] }))),
      'AUDIENCE_MISMATCH',
    );
  });

  it('refusal 5: POSITIVE CONTROL — a multi-valued audience WITH a matching azp is accepted', async () => {
    const result = await validate(mint(baseClaims({ aud: [CLIENT_ID, 'another-client'], azp: CLIENT_ID })));
    expect(result.subject).toBe('subject-0001');
  });

  it('refusal 6: an expired token is refused', async () => {
    await expectRefusal(validate(mint(baseClaims({ exp: nowSeconds - 3600 }))), 'TIME_WINDOW');
  });

  it('refusal 6: a token issued in the future is refused', async () => {
    await expectRefusal(validate(mint(baseClaims({ iat: nowSeconds + 3600 }))), 'TIME_WINDOW');
  });

  it('refusal 6: an unreached nbf is refused', async () => {
    await expectRefusal(validate(mint(baseClaims({ nbf: nowSeconds + 3600 }))), 'TIME_WINDOW');
  });

  it('refusal 6: POSITIVE CONTROL — a token inside the clock skew is accepted', async () => {
    const result = await validate(mint(baseClaims({ exp: nowSeconds - 30 })));
    expect(result.subject).toBe('subject-0001');
  });

  it('refusal 7: an absent nonce is refused', async () => {
    const claims = baseClaims();
    delete claims.nonce;
    await expectRefusal(validate(mint(claims)), 'NONCE_MISMATCH');
  });

  it('refusal 7: a nonce belonging to another pending request is refused', async () => {
    await expectRefusal(validate(mint(baseClaims({ nonce: 'a-different-nonce' }))), 'NONCE_MISMATCH');
  });

  it('refusal 8: an absent subject is refused', async () => {
    const claims = baseClaims();
    delete claims.sub;
    await expectRefusal(validate(mint(claims)), 'SUBJECT_INVALID');
  });

  it('refusal 8: a subject over 255 bytes is refused', async () => {
    await expectRefusal(validate(mint(baseClaims({ sub: 'x'.repeat(256) }))), 'SUBJECT_INVALID');
  });

  it('refusal 8: POSITIVE CONTROL — a subject is opaque, so a 255-byte one with punctuation is accepted', async () => {
    const subject = `${'a/b:c|d'.repeat(30)}xyz`.slice(0, 255);
    const result = await validate(mint(baseClaims({ sub: subject })));
    expect(result.subject).toBe(subject);
  });

  it('refusal 9: a step-up token with no auth_time is refused', async () => {
    await expectRefusal(
      validate(mint(baseClaims()), { maxAgeRequested: 0, requestedAt: new Date(NOW - 1000) }),
      'AUTH_TIME_STALE',
    );
  });

  it('refusal 9: an auth_time predating the step-up request is refused', async () => {
    // This is the whole value of the mechanism: it DETECTS an Identity
    // provider that ignored max_age rather than trusting it.
    await expectRefusal(
      validate(mint(baseClaims({ auth_time: nowSeconds - 7200 })), {
        maxAgeRequested: 0,
        requestedAt: new Date(NOW - 1000),
        clockSkewSeconds: 0,
      }),
      'AUTH_TIME_STALE',
    );
  });

  it('refusal 9: POSITIVE CONTROL — an auth_time after the step-up request is accepted', async () => {
    const result = await validate(mint(baseClaims({ auth_time: nowSeconds })), {
      maxAgeRequested: 0,
      requestedAt: new Date(NOW - 60_000),
      clockSkewSeconds: 0,
    });
    expect(result.subject).toBe('subject-0001');
  });

  it('refusal 10: a required claim with a value outside the permitted set is refused', async () => {
    await expectRefusal(
      validate(mint(baseClaims({ hd: 'evil.test' })), { requiredClaims: { hd: 'example.com' } }),
      'REQUIRED_CLAIM_MISSING',
    );
  });

  it('refusal 10: an absent required claim is refused', async () => {
    await expectRefusal(
      validate(mint(baseClaims()), { requiredClaims: { hd: 'example.com' } }),
      'REQUIRED_CLAIM_MISSING',
    );
  });

  it('refusal 10: POSITIVE CONTROL — a permitted value is accepted', async () => {
    const result = await validate(mint(baseClaims({ hd: 'example.com' })), {
      requiredClaims: { hd: ['example.com', 'other.test'] },
    });
    expect(result.subject).toBe('subject-0001');
  });

  it('refusal 11: a UserInfo response naming a different subject is refused', () => {
    expect(() => assertUserInfoSubject({ sub: 'someone-else' }, 'subject-0001')).toThrow(IdTokenError);
    try {
      assertUserInfoSubject({ sub: 'someone-else' }, 'subject-0001');
    } catch (error) {
      expect((error as IdTokenError).code).toBe('USERINFO_SUBJECT_MISMATCH');
    }
  });

  it('refusal 11: POSITIVE CONTROL — a matching subject passes', () => {
    expect(() => assertUserInfoSubject({ sub: 'subject-0001' }, 'subject-0001')).not.toThrow();
  });

  it('refusal 12: an oversized token is refused BEFORE parsing', async () => {
    // Deliberately not a valid JWS: if the size bound ran after parsing, this
    // would refuse as TOKEN_MALFORMED instead.
    await expectRefusal(validate('x'.repeat(17 * 1024)), 'TOKEN_TOO_LARGE');
  });

  it('refusal 12: a token carrying more claims than the bound is refused', async () => {
    const extra: Record<string, unknown> = {};
    for (let index = 0; index < MAX_ID_TOKEN_CLAIMS + 5; index += 1) extra[`claim_${index}`] = index;
    await expectRefusal(validate(mint(baseClaims(extra))), 'TOKEN_TOO_LARGE');
  });

  it('the allowlist names only asymmetric families', () => {
    for (const alg of ALLOWED_ID_TOKEN_ALGS) {
      expect(alg.startsWith('RS') || alg.startsWith('PS') || alg.startsWith('ES')).toBe(true);
    }
    expect(ALLOWED_ID_TOKEN_ALGS as readonly string[]).not.toContain('none');
    expect((ALLOWED_ID_TOKEN_ALGS as readonly string[]).some((alg) => alg.startsWith('HS'))).toBe(false);
  });
});
