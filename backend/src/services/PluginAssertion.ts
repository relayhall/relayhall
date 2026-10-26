import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { PluginConfig } from './PluginLoader';

/** The per-request plugin assertion lives 60 seconds. */
export const PLUGIN_ASSERTION_TTL_SECONDS = 60;

/**
 * Card bedf50cc (E380, design section 9, choice C8): every assertion the core
 * signs carries a random `jti`, and the core records (jti, plugin, sub,
 * capability, exp) until it expires. The plugin backend's effective-settings
 * read is admitted only for a `jti` this process issued for that plugin and
 * that Account: a plugin holds its HS256 key and could mint any `sub`, but it
 * can only name an Account whose real assertion it received.
 *
 * The record is in this process's memory, which the design permits while one
 * backend process serves (a restart forgets at most 60 seconds of assertions;
 * a backend read in that window answers 404 and the next proxied request
 * issues a fresh one). It is bounded: past MAX_ISSUED live entries the oldest
 * is forgotten first, which fails closed.
 */
export interface IssuedPluginAssertion { plugin: string; sub: string; capability: string; exp: number }
const MAX_ISSUED = 100_000;
const issued = new Map<string, IssuedPluginAssertion>();

function forgetExpired(nowSeconds: number): void {
  // Insertion order is expiry order (one fixed lifetime), so the sweep stops
  // at the first live entry.
  for (const [jti, entry] of issued) {
    if (entry.exp > nowSeconds) break;
    issued.delete(jti);
  }
}

export function signPluginAssertion(config: PluginConfig, pluginName: string, accountId: string, actorId: string, capability: string, taskId?: string): string {
  const key = config.access?.assertion_key_env ? process.env[config.access.assertion_key_env] : undefined;
  if (!key || Buffer.byteLength(key) < 32) throw new Error('PLUGIN_ASSERTION_KEY_REQUIRED');
  const jti = crypto.randomBytes(18).toString('base64url');
  const token = jwt.sign({actor:actorId,capability,...(taskId ? {taskId} : {})},key,{algorithm:'HS256',issuer:'relayhall',audience:pluginName,subject:accountId,expiresIn:PLUGIN_ASSERTION_TTL_SECONDS,jwtid:jti});
  const exp = (jwt.decode(token) as jwt.JwtPayload).exp as number;
  forgetExpired(Math.floor(Date.now() / 1000));
  while (issued.size >= MAX_ISSUED) issued.delete(issued.keys().next().value as string);
  issued.set(jti, { plugin: pluginName, sub: accountId, capability, exp });
  return token;
}

/** The live record of an assertion this process issued, or undefined (unknown or expired). */
export function issuedPluginAssertion(jti: unknown): IssuedPluginAssertion | undefined {
  if (typeof jti !== 'string') return undefined;
  const entry = issued.get(jti);
  if (!entry || entry.exp <= Math.floor(Date.now() / 1000)) return undefined;
  return entry;
}

/** Test seam: forget every issued assertion. */
export function forgetIssuedPluginAssertions(): void { issued.clear(); }

/**
 * Verify an assertion a plugin backend presents back to the core (card
 * bedf50cc, C8): HS256 only (the algorithm is pinned), issuer `relayhall`,
 * audience = this plugin, unexpired, signed with this plugin's own key, and a
 * `jti` this process issued for this plugin, this `sub` and this capability.
 * Answers the verified claims, or null for any failure. This key is the
 * plugin's own, never the dashboard secret, so a dashboard token never passes.
 */
export function verifyIssuedPluginAssertion(config: PluginConfig, pluginName: string, token: unknown):
  { sub: string; capability: string } | null {
  const key = config.access?.assertion_key_env ? process.env[config.access.assertion_key_env] : undefined;
  if (typeof token !== 'string' || !token || !key || Buffer.byteLength(key) < 32) return null;
  let claims: string | jwt.JwtPayload;
  try {
    claims = jwt.verify(token, key, { algorithms: ['HS256'], issuer: 'relayhall', audience: pluginName });
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const { sub, jti, capability, exp } = claims;
  if (typeof sub !== 'string' || typeof jti !== 'string' || typeof capability !== 'string' || typeof exp !== 'number') return null;
  const issuedEntry = issuedPluginAssertion(jti);
  if (!issuedEntry || issuedEntry.plugin !== pluginName || issuedEntry.sub !== sub || issuedEntry.capability !== capability) return null;
  return { sub, capability };
}
