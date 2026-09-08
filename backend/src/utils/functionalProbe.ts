/**
 * functionalProbe — RH-P3.C8 (strategy §2.12: "an HTTP 200 is not health").
 *
 * The probe exercises the three load-bearing subsystems and FAILS (503)
 * when any of them cannot actually do its job:
 *  - DB: a real query round-trip;
 *  - AUTH: the configured JWT secret signs a probe token in-process and the
 *    dashboard password hash is configured — the two things a login
 *    actually needs (verification stays with the status-aware shared
 *    verifier per the tokenEntryPoints pin);
 *  - FEED: the cursor feed's own read shape answers (the C1 ledger is the
 *    coordination backbone; a feed that cannot be read is an outage even
 *    while plain HTTP still answers).
 *
 * The response carries per-check booleans and a coarse detail word only —
 * never errors, secrets, or topology (the safety floor covers probe output
 * like any other response).
 */
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { getJwtSecret } from '../config/secrets';

export interface FunctionalProbeCheck {
  ok: boolean;
  detail: string;
}

export interface FunctionalProbeResult {
  ok: boolean;
  checks: {
    db: FunctionalProbeCheck;
    auth: FunctionalProbeCheck;
    feed: FunctionalProbeCheck;
  };
}

export async function runFunctionalProbe(pool: Pool = defaultPool): Promise<FunctionalProbeResult> {
  const checks: FunctionalProbeResult['checks'] = {
    db: { ok: false, detail: 'unchecked' },
    auth: { ok: false, detail: 'unchecked' },
    feed: { ok: false, detail: 'unchecked' },
  };

  try {
    await pool.query('SELECT 1');
    checks.db = { ok: true, detail: 'query-ok' };
  } catch {
    checks.db = { ok: false, detail: 'query-failed' };
  }

  try {
    // Signing with the configured secret proves the JWT subsystem can mint
    // tokens; verification deliberately stays with the status-aware shared
    // verifier (the tokenEntryPoints pin) and is not re-implemented here.
    const secret = getJwtSecret();
    jwt.sign({ probe: true }, secret, { expiresIn: '1m' });
    checks.auth = process.env.DASHBOARD_PASSWORD_HASH
      ? { ok: true, detail: 'sign-ok' }
      : { ok: false, detail: 'password-hash-missing' };
  } catch {
    checks.auth = { ok: false, detail: 'jwt-unavailable' };
  }

  try {
    // The feed's own read shape — the same ORDER BY cursor path every
    // consumer uses. An empty ledger is healthy; an unanswerable one is not.
    await pool.query('SELECT cursor FROM feed_events ORDER BY cursor DESC LIMIT 1');
    checks.feed = { ok: true, detail: 'read-ok' };
  } catch {
    checks.feed = { ok: false, detail: 'read-failed' };
  }

  return { ok: checks.db.ok && checks.auth.ok && checks.feed.ok, checks };
}
