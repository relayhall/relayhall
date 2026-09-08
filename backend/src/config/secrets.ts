/**
 * Central secret accessors.
 *
 * Every module that needs a shared secret goes through here. Two reasons:
 *
 * 1. `dotenv.config()` runs at the top of this file, before any consumer's
 *    module body. tsconfig emits CommonJS, so `require()` calls are hoisted
 *    above server.ts's own dotenv call — a secret supplied only via a .env
 *    file (bare `npm start`, CI, a non-Docker deploy) would otherwise be
 *    invisible to modules that read process.env at import time.
 * 2. A missing JWT_SECRET throws here, once, for every consumer. There is no
 *    fallback literal anywhere: a published constant is not a secret.
 */
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

let cachedJwtSecret: string | undefined;

export function getJwtSecret(): string {
  if (cachedJwtSecret === undefined) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('FATAL: JWT_SECRET environment variable is required (no insecure fallback).');
    }
    cachedJwtSecret = secret;
  }
  return cachedJwtSecret;
}

export function getApiKey(): string {
  return process.env.RELAYHALL_API_KEY || '';
}

export function getReportsReadKey(): string {
  return process.env.RELAYHALL_REPORTS_READ_API_KEY || '';
}

/**
 * Constant-time secret comparison. Byte length is compared first because
 * timingSafeEqual throws on a length mismatch; length is therefore leaked by
 * design, values are not. An empty configured secret never matches.
 */
export function equalSecret(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !a || !b) return false;
  if (Buffer.byteLength(a) !== Buffer.byteLength(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Reset memoised state. Tests only. */
export function __resetSecretsCacheForTests(): void {
  cachedJwtSecret = undefined;
}
