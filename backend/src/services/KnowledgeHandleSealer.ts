// KnowledgeHandleSealer.ts — RH-KW1 candidate B (card `0b4b779b`).
//
// §8.1's AEAD-sealed content handles. A handle is
// `base64url(AEAD-seal(k_kid, payload)) + '.' + kid`, payload
// `{v:1, s, dv, c, r, iat}`.
//
// ── THE PROPERTIES, ALL DECLARED DECISIONS (§8.1) ──
//
//  confidential       the raw ref is SEALED, so a caller or a model cannot
//                     decode it — which is what §9's row-space claim and
//                     §7.7's ref-hashing rest on
//  source-bound       `s`; a handle for source A presented against B is
//                     refused at core BEFORE any dial
//  version-pinned     `dv`; the §6.1 compartment re-check runs against the
//                     MINTING descriptor version, so a later publish never
//                     invalidates outstanding handles wholesale
//  integrity-protected the AEAD tag; a tampered handle is refused
//  stateless          no core state at all: the key is process configuration,
//                     so a restart changes nothing (BD-2 asserts the DECISION,
//                     not key-file persistence)
//  NOT caller-bound,
//  NON-expiring       declared: a handle is an ADDRESS, not authority. Every
//                     get re-runs the full §5.2 arm set, so a handle held by
//                     the wrong caller — or by one revoked since it was
//                     minted — yields a REFUSAL. Binding the caller into the
//                     handle would make that refusal look like a decode
//                     failure and hide which control actually fired.
//
// ── KEYS ──
//
// The keyset lives in the environment and never on the board, on the shipped
// `utils/credentialCrypto.ts` pattern (AZ-S3 §7.2): a DB dump leaks nothing
// usable. Rotation is publish-new / retire-old with overlap; `kid` selects,
// and a handle under a RETIRED kid is refused with the named
// `handle_key_retired` rather than a generic decode failure, because the
// operator needs to tell "rotated" from "forged".
import crypto from 'crypto';

export const KNOWLEDGE_HANDLE_VERSION = 1;

export class KnowledgeHandleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'KnowledgeHandleError';
  }
}

export interface KnowledgeHandlePayload {
  /** Schema version. A handle minted under another version is refused. */
  v: number;
  /** Source (Service) id the handle addresses. */
  s: string;
  /** Descriptor version the compartment was declared in. */
  dv: number;
  /** The declared compartment this content sits in. */
  c: string;
  /** The source's own opaque ref. Sealed; never emitted raw (§7.6). */
  r: string;
  /** Mint time, seconds. Diagnostic only — a handle does not expire. */
  iat: number;
}

interface HandleKeyset {
  keys: Map<string, Buffer>;
  retired: Set<string>;
  activeKeyId: string;
}

let cached: HandleKeyset | null = null;

/** Test hook: drop the cached keyset (the environment changed). */
export function resetKnowledgeHandleKeysetCache(): void {
  cached = null;
}

export function knowledgeHandleKeysetConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RELAYHALL_KNOWLEDGE_HANDLE_KEYS && env.RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY);
}

export function loadKnowledgeHandleKeyset(env: NodeJS.ProcessEnv = process.env): HandleKeyset {
  const raw = env.RELAYHALL_KNOWLEDGE_HANDLE_KEYS;
  const activeKeyId = env.RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY || '';
  if (!raw || !activeKeyId) {
    throw new KnowledgeHandleError(
      'KNOWLEDGE_HANDLE_KEYSET_MISSING',
      'RELAYHALL_KNOWLEDGE_HANDLE_KEYS and RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY must be set (design 94747de9 §8.1)',
    );
  }
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KnowledgeHandleError('KNOWLEDGE_HANDLE_KEYSET_INVALID', 'RELAYHALL_KNOWLEDGE_HANDLE_KEYS is not valid JSON');
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, value] of Object.entries(parsed)) {
    const key = Buffer.from(String(value), 'base64');
    if (key.length !== 32) {
      throw new KnowledgeHandleError('KNOWLEDGE_HANDLE_KEYSET_INVALID', `keyset entry '${keyId}' is not 32 bytes`);
    }
    keys.set(keyId, key);
  }
  // A RETIRED key stays in the keyset: an outstanding handle under it must be
  // refused by NAME, and a key that is simply absent cannot be told from a
  // forged `kid`.
  const retired = new Set(
    (env.RELAYHALL_KNOWLEDGE_HANDLE_RETIRED_KEYS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  if (!keys.has(activeKeyId)) {
    throw new KnowledgeHandleError('KNOWLEDGE_HANDLE_KEYSET_INVALID', 'RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY names no keyset entry');
  }
  if (retired.has(activeKeyId)) {
    throw new KnowledgeHandleError('KNOWLEDGE_HANDLE_KEYSET_INVALID', 'the active handle key may not also be retired');
  }
  return { keys, retired, activeKeyId };
}

function keyset(): HandleKeyset {
  if (!cached) cached = loadKnowledgeHandleKeyset();
  return cached;
}

/** `kid` is carried OUTSIDE the ciphertext, so it is authenticated as AAD. */
export function sealKnowledgeHandle(payload: Omit<KnowledgeHandlePayload, 'v' | 'iat'>): string {
  const { keys, activeKeyId } = keyset();
  const key = keys.get(activeKeyId) as Buffer;
  const full: KnowledgeHandlePayload = {
    v: KNOWLEDGE_HANDLE_VERSION,
    s: payload.s,
    dv: payload.dv,
    c: payload.c,
    r: payload.r,
    iat: Math.floor(Date.now() / 1000),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(activeKeyId, 'utf8'));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(full), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${Buffer.concat([iv, tag, sealed]).toString('base64url')}.${activeKeyId}`;
}

/**
 * Unseal and verify. Every failure is a NAMED code, because the operator has
 * to be able to tell a rotated key from a forged handle from a wrong version.
 */
export function unsealKnowledgeHandle(handle: unknown): KnowledgeHandlePayload {
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > 8192) {
    throw new KnowledgeHandleError('handle_malformed', 'handle must be a non-empty string');
  }
  const split = handle.lastIndexOf('.');
  if (split <= 0 || split === handle.length - 1) {
    throw new KnowledgeHandleError('handle_malformed', 'handle must be <sealed>.<kid>');
  }
  const kid = handle.slice(split + 1);
  const { keys, retired } = keyset();
  // A RETIRED key is still in the keyset, and the retirement check is
  // deliberately NOT made here (round-2 finding R2-F1). Answering
  // `handle_key_retired` to an unauthenticated blob would give a FORGERY that
  // merely names a retired `kid` the same answer as an authentic rotated
  // handle — which destroys the one distinction that token exists to draw.
  // Authenticate first; the retirement is decided below, on a handle this
  // deployment provably sealed.
  const key = keys.get(kid);
  if (!key) {
    throw new KnowledgeHandleError('handle_key_unknown', 'handle names no known key');
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(handle.slice(0, split), 'base64url');
  } catch {
    throw new KnowledgeHandleError('handle_malformed', 'handle body is not base64url');
  }
  if (raw.length < 12 + 16 + 1) {
    throw new KnowledgeHandleError('handle_malformed', 'handle body is too short');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(kid, 'utf8'));
  decipher.setAuthTag(raw.subarray(12, 28));
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    // The AEAD tag failed: the handle was tampered with, or sealed under a
    // different key with the same id. Either way it is not ours.
    throw new KnowledgeHandleError('handle_tampered', 'handle failed authentication');
  }
  // AUTHENTICATED from here on: the AEAD tag verified, so this handle was
  // sealed by this deployment under this key. Only now is "retired" a
  // statement about OUR key rather than about a string an attacker chose.
  if (retired.has(kid)) {
    throw new KnowledgeHandleError('handle_key_retired', `handle key '${kid}' is retired (design 94747de9 §8.1)`);
  }
  let parsed: KnowledgeHandlePayload;
  try {
    parsed = JSON.parse(plaintext) as KnowledgeHandlePayload;
  } catch {
    throw new KnowledgeHandleError('handle_tampered', 'handle payload is not JSON');
  }
  if (parsed.v !== KNOWLEDGE_HANDLE_VERSION) {
    throw new KnowledgeHandleError('handle_version_unsupported', `handle version ${String(parsed.v)} is not supported`);
  }
  if (typeof parsed.s !== 'string' || typeof parsed.c !== 'string'
    || typeof parsed.r !== 'string' || typeof parsed.dv !== 'number') {
    throw new KnowledgeHandleError('handle_tampered', 'handle payload is not the §8.1 shape');
  }
  return parsed;
}

/** The `kid` a handle names, without unsealing it. Diagnostics only. */
export function knowledgeHandleKid(handle: string): string | null {
  const split = handle.lastIndexOf('.');
  return split > 0 && split < handle.length - 1 ? handle.slice(split + 1) : null;
}
