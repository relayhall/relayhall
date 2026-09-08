/**
 * API-wide per-source rate limiting — RH-P3.C8 (strategy §2.12 abuse
 * controls), generalizing the reviewed login-throttle design: the same
 * proxy-aware source keying, the same bounded in-memory state discipline
 * (TTL sweep + hard entry ceiling), applied as a fixed-window request
 * budget across the whole API surface.
 *
 * Health and readiness probes are exempt — a monitor must never be told
 * 429 about the thing it exists to watch. The login path keeps its own,
 * stricter exponential-backoff throttle underneath this ceiling.
 *
 * State is in-memory and per-process, correct for the single-process
 * backend (the same declaration the login throttle carries); a restart
 * clears windows, which is not attacker-triggerable from these routes.
 */
import type { Request, Response, NextFunction } from 'express';
import { loginClientKey } from './loginRateLimit';

/** Requests allowed per source per window. */
export const API_RATE_LIMIT_MAX_REQUESTS = 300;
export const API_RATE_LIMIT_WINDOW_MS = 60_000;
/** Forget idle sources; cap tracked sources like the login throttle. */
const RECORD_TTL_MS = 10 * 60_000;
const MAX_TRACKED_SOURCES = 10_000;

/** Paths exempt from the ceiling: liveness/readiness/functional probes. */
export const API_RATE_LIMIT_EXEMPT = new Set(['/health', '/readiness', '/health/functional', '/health/orchestration']);

interface WindowRecord {
  windowStartedAt: number;
  count: number;
  lastSeenAt: number;
}

export interface ApiRateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class ApiRateLimiter {
  private readonly windows = new Map<string, WindowRecord>();

  constructor(
    private readonly maxRequests = API_RATE_LIMIT_MAX_REQUESTS,
    private readonly windowMs = API_RATE_LIMIT_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): ApiRateDecision {
    this.sweep();
    const at = this.now();
    const record = this.windows.get(key);
    if (!record || at - record.windowStartedAt >= this.windowMs) {
      this.windows.set(key, { windowStartedAt: at, count: 1, lastSeenAt: at });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    record.lastSeenAt = at;
    if (record.count < this.maxRequests) {
      record.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((record.windowStartedAt + this.windowMs - at) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  private sweep(): void {
    const at = this.now();
    for (const [key, record] of this.windows) {
      if (at - record.lastSeenAt > RECORD_TTL_MS) this.windows.delete(key);
    }
    if (this.windows.size > MAX_TRACKED_SOURCES) {
      const excess = this.windows.size - MAX_TRACKED_SOURCES;
      let removed = 0;
      for (const key of this.windows.keys()) {
        this.windows.delete(key);
        removed += 1;
        if (removed >= excess) break;
      }
    }
  }
}

export const apiRateLimiter = new ApiRateLimiter();

export function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (API_RATE_LIMIT_EXEMPT.has(req.path)) {
    next();
    return;
  }
  const decision = apiRateLimiter.check(loginClientKey(req));
  if (!decision.allowed) {
    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      error: 'API rate limit exceeded for this source; retry after the indicated delay',
    });
    return;
  }
  next();
}
