// credentialCrypto.ts — envelope encryption for credential secrets
// (RH-P3.AZ-S3; AUTHZ design 4d961e37 §7.2, AZ-12/AZ-32, T9/T30).
//
// KEYSET FROM ENVIRONMENT, NEVER THE DB: RELAYHALL_CREDENTIAL_KEYS is a
// JSON object { keyId: base64(32 bytes) }; RELAYHALL_CREDENTIAL_ACTIVE_KEY
// names the encryption key for NEW writes. Key rotation = add a new key,
// re-encrypt row-by-row in the background, retire the old id when no row
// references it. Each row carries its keyset id (encryption_key_id — the
// AEAD header of §7.2, renamed for the 062 key_id collision).
//
// AES-256-GCM; ciphertext format: base64(iv[12] || tag[16] || data). The
// AAD binds the credential row id, so a ciphertext copied onto another row
// fails authentication instead of revealing a foreign secret.
//
// A DB dump leaks nothing usable (T9): the keyset lives outside the DB. A
// corrupted or cross-wired row errors LOUDLY (T30): the reveal path
// additionally verifies H(decrypt) == stored hash before returning, and
// the startup/periodic CANARY decrypts a sample and fails loudly on
// mismatch (registered in server startup, skipped in boot-check mode).
import crypto from 'crypto';

export class CredentialCryptoError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

interface Keyset {
  keys: Map<string, Buffer>;
  activeKeyId: string;
}

let cached: Keyset | null = null;

export function loadKeyset(env: NodeJS.ProcessEnv = process.env): Keyset {
  const raw = env.RELAYHALL_CREDENTIAL_KEYS;
  const activeKeyId = env.RELAYHALL_CREDENTIAL_ACTIVE_KEY || '';
  if (!raw || !activeKeyId) {
    throw new CredentialCryptoError(
      'CREDENTIAL_KEYSET_MISSING',
      'RELAYHALL_CREDENTIAL_KEYS and RELAYHALL_CREDENTIAL_ACTIVE_KEY must be set (design 4d961e37 §7.2)',
    );
  }
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialCryptoError('CREDENTIAL_KEYSET_INVALID', 'RELAYHALL_CREDENTIAL_KEYS is not valid JSON');
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, value] of Object.entries(parsed)) {
    const key = Buffer.from(String(value), 'base64');
    if (key.length !== 32) {
      throw new CredentialCryptoError('CREDENTIAL_KEYSET_INVALID', `keyset entry '${keyId}' is not 32 bytes`);
    }
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new CredentialCryptoError('CREDENTIAL_KEYSET_INVALID', 'RELAYHALL_CREDENTIAL_ACTIVE_KEY names no keyset entry');
  }
  return { keys, activeKeyId };
}

function keyset(): Keyset {
  if (!cached) cached = loadKeyset();
  return cached;
}

/** Test hook: drop the cached keyset (env changed). */
export function resetKeysetCache(): void {
  cached = null;
}

export function credentialKeysetConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RELAYHALL_CREDENTIAL_KEYS && env.RELAYHALL_CREDENTIAL_ACTIVE_KEY);
}

export function encryptCredentialSecret(plaintext: string, rowId: string): { ciphertext: string; encryptionKeyId: string } {
  const { keys, activeKeyId } = keyset();
  const key = keys.get(activeKeyId)!;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(rowId, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([iv, tag, data]).toString('base64'),
    encryptionKeyId: activeKeyId,
  };
}

export function decryptCredentialSecret(ciphertext: string, encryptionKeyId: string, rowId: string): string {
  const { keys } = keyset();
  const key = keys.get(encryptionKeyId);
  if (!key) {
    throw new CredentialCryptoError('CREDENTIAL_KEY_UNKNOWN', `keyset holds no key '${encryptionKeyId}'`);
  }
  const buffer = Buffer.from(ciphertext, 'base64');
  if (buffer.length < 12 + 16 + 1) {
    throw new CredentialCryptoError('CREDENTIAL_CIPHERTEXT_INVALID', 'ciphertext is truncated');
  }
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const data = buffer.subarray(28);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(rowId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialCryptoError('CREDENTIAL_DECRYPT_FAILED', 'ciphertext failed authenticated decryption (T30)');
  }
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * The §7.2 canary: decrypt a sample of encrypted rows and verify
 * H(decrypt) == stored hash. Returns the number checked; throws LOUDLY on
 * the first mismatch. Callers: server startup (after migrations) and a
 * periodic timer. Boot-check mode never reaches it (no DB activity there).
 */
/**
 * SS-7's canary for Identity provider secrets (annex `e6dcadb9` §11a).
 *
 * `principal_credentials` carries a hash to compare a decrypted secret against.
 * `identity_providers` deliberately does not: a client secret is a shared
 * secret presented to the provider, not a verifier we check something against.
 * What a corrupted row fails at here is therefore DECRYPTION — and because the
 * envelope is AEAD-bound to the row id, tampered ciphertext, a wrong `key_id`
 * and a secret copied from another provider's row all fail closed at this
 * point rather than at the first federated login, which is the difference
 * between a loud start and a silent outage.
 *
 * Both secret-bearing columns are checked: `private_key_jwt` providers carry no
 * client secret at all, so checking only the secret would skip them entirely.
 */
export async function runIdentityProviderSecretCanary(
  queryable: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  sampleSize = 5,
): Promise<number> {
  const result = await queryable.query(
    `SELECT id, client_secret_ct, client_secret_key_id,
            client_private_key_ct, client_private_key_key_id
       FROM identity_providers
      WHERE client_secret_ct IS NOT NULL OR client_private_key_ct IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [sampleSize],
  );
  let checked = 0;
  for (const row of result.rows) {
    const columns: Array<[unknown, unknown, string]> = [
      [row.client_secret_ct, row.client_secret_key_id, 'client secret'],
      [row.client_private_key_ct, row.client_private_key_key_id, 'client private key'],
    ];
    for (const [ciphertext, keyId, what] of columns) {
      if (ciphertext === null || ciphertext === undefined) continue;
      try {
        decryptCredentialSecret(String(ciphertext), String(keyId), String(row.id));
      } catch {
        throw new CredentialCryptoError(
          'IDENTITY_PROVIDER_CANARY_FAILED',
          `identity provider ${row.id}: the stored ${what} does not decrypt under its declared key (SS-7) — refusing to run silently`,
        );
      }
      checked += 1;
    }
  }
  return checked;
}

export async function runCredentialCanary(
  queryable: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  sampleSize = 5,
): Promise<number> {
  const result = await queryable.query(
    `SELECT id, secret_ciphertext, encryption_key_id, secret_hash
       FROM principal_credentials
      WHERE secret_ciphertext IS NOT NULL AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [sampleSize],
  );
  for (const row of result.rows) {
    const plaintext = decryptCredentialSecret(String(row.secret_ciphertext), String(row.encryption_key_id), String(row.id));
    if (sha256Hex(plaintext) !== String(row.secret_hash)) {
      throw new CredentialCryptoError(
        'CREDENTIAL_CANARY_MISMATCH',
        `credential ${row.id}: decrypted secret does not match its stored hash (T30) — refusing to run silently`,
      );
    }
  }
  return result.rows.length;
}
