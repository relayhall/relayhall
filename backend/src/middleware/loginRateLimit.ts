import dns from 'dns/promises';
/**
 * Per-source exponential backoff for the password login route.
 *
 * The login path bcrypt-compares a single shared password with no limiter, so
 * it is both an unlimited online guessing oracle and an unauthenticated DoS:
 * bcrypt.compare runs on the libuv threadpool (4 slots by default), which is
 * the same pool every filesystem read uses. Throttling happens BEFORE the
 * compare so a flood is rejected without touching that pool.
 *
 * Two rules follow from "throttle, never permanently lock" — this is the only
 * credential that reaches the dashboard, and it stays the break-glass path once
 * OIDC lands, so an attacker must never be able to lock the owner out:
 *
 *  - the delay is capped, so access always returns on its own
 *  - a successful login clears the counter immediately
 *
 * State is in-memory, which is correct here: the backend is a single process
 * with no cluster/PM2 and no replicas. A restart clears throttles, which is
 * acceptable — restarts are not attacker-triggerable from this route.
 */

export interface LoginThrottleDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface AttemptRecord {
  failures: number;
  nextAllowedAt: number;
}

/** First failure is free; the delay starts after that and doubles. */
const BASE_DELAY_MS = 1_000;
/** Cap: 5 minutes. Reached at 9 consecutive failures, then held, never raised. */
const MAX_DELAY_MS = 5 * 60_000;
/** Forget an idle source so the map cannot grow without bound. */
const RECORD_TTL_MS = 60 * 60_000;
/** Hard ceiling on tracked sources; the oldest entry is evicted past this. */
const MAX_TRACKED_SOURCES = 10_000;

export function backoffDelayMs(failures: number): number {
  if (failures <= 1) return 0;
  const exponent = Math.min(failures - 1, 20);
  return Math.min(BASE_DELAY_MS * 2 ** (exponent - 1), MAX_DELAY_MS);
}

export class LoginThrottle {
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  check(key: string): LoginThrottleDecision {
    this.sweep();
    const record = this.attempts.get(key);
    if (!record) return { allowed: true, retryAfterSeconds: 0 };
    const remaining = record.nextAllowedAt - this.now();
    if (remaining <= 0) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.ceil(remaining / 1000) };
  }

  recordFailure(key: string): void {
    if (!this.attempts.has(key) && this.attempts.size >= MAX_TRACKED_SOURCES) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.attempts.keys().next();
      if (!oldest.done) this.attempts.delete(oldest.value);
    }
    const current = this.attempts.get(key);
    const failures = (current?.failures ?? 0) + 1;
    this.attempts.set(key, {
      failures,
      nextAllowedAt: this.now() + backoffDelayMs(failures),
    });
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  /** Test seam. */
  size(): number {
    return this.attempts.size;
  }

  private sweep(): void {
    const cutoff = this.now() - RECORD_TTL_MS;
    for (const [key, record] of this.attempts) {
      if (record.nextAllowedAt < cutoff) this.attempts.delete(key);
    }
  }
}

/**
 * Identify the caller.
 *
 * X-Forwarded-For is only believed when the immediate peer really is our proxy.
 * Express's `trust proxy` is not sufficient on its own: it trusts one hop from
 * whatever socket connected, and the backend port is published on 0.0.0.0, so a
 * LAN client can connect directly and choose its own X-Forwarded-For. That
 * would let an attacker rotate buckets to escape the throttle AND pin the
 * owner's bucket at 429 — a targeted lockout of the break-glass credential.
 *
 * Trusted peers default to loopback plus the private ranges the compose
 * networks live in, and can be pinned exactly with TRUSTED_PROXY_IPS.
 */
// Loopback and Docker bridge ranges only. Deliberately exclude 192.168.0.0/16:
// many deployments use it for client networks, where trusting it would let a
// direct client choose its own key. Pin TRUSTED_PROXY_IPS to be exact.
const DEFAULT_TRUSTED_PEER = /^(?:::1$|127\.|::ffff:127\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|::ffff:10\.|::ffff:172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * Resolved addresses of TRUSTED_PROXY_HOSTS. Container addresses change on every
 * recreate, so the proxy is named rather than pinned by IP, and re-resolved on
 * an interval. Until the first resolution completes the configured ranges apply,
 * which is the conservative direction: it never trusts more than the default.
 */
const resolvedProxyAddresses = new Set<string>();

function proxyHostNames(): string[] {
  return (process.env.TRUSTED_PROXY_HOSTS || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

export async function refreshTrustedProxyAddresses(): Promise<void> {
  const hosts = proxyHostNames();
  if (hosts.length === 0) return;
  const found = new Set<string>();
  for (const host of hosts) {
    try {
      const records = await dns.lookup(host, { all: true });
      for (const record of records) {
        found.add(record.address);
        // Node reports IPv4 peers as ::ffff:x.y.z.w over a dual-stack socket.
        if (record.family === 4) found.add(`::ffff:${record.address}`);
      }
    } catch {
      // Keep the previous answer rather than widening or emptying the set.
    }
  }
  if (found.size > 0) {
    resolvedProxyAddresses.clear();
    for (const address of found) resolvedProxyAddresses.add(address);
  }
}

export function isTrustedPeer(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const pinned = (process.env.TRUSTED_PROXY_IPS || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  if (pinned.length > 0) return pinned.includes(remoteAddress);
  // A named proxy is authoritative once resolved: nothing else is trusted, so a
  // sibling container on the same docker network cannot choose its own key.
  if (proxyHostNames().length > 0) {
    return resolvedProxyAddresses.size === 0
      ? DEFAULT_TRUSTED_PEER.test(remoteAddress)
      : resolvedProxyAddresses.has(remoteAddress);
  }
  return DEFAULT_TRUSTED_PEER.test(remoteAddress);
}

/** Test seam. */
export function __setResolvedProxyAddressesForTests(addresses: string[]): void {
  resolvedProxyAddresses.clear();
  for (const address of addresses) resolvedProxyAddresses.add(address);
}

export function loginClientKey(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const peer = req.socket?.remoteAddress;
  // Direct connection: the socket address is the only unspoofable identifier.
  if (!isTrustedPeer(peer)) return peer || 'unknown';
  return req.ip || peer || 'unknown';
}

export const loginThrottle = new LoginThrottle();
