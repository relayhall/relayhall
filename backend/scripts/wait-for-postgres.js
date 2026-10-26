#!/usr/bin/env node
'use strict';

// CI-only gate: credentials stay in pg's normal environment handling. Never
// print a connection string, environment value, or raw driver error/message.
const { performance } = require('node:perf_hooks');
const BUDGET_MS = 180_000;
const INTERVAL_MS = 2_000;
const ATTEMPT_MS = 5_000;
const CLEANUP_MS = 500;
const CODES = Object.freeze({
  ENOTFOUND: 'dns', EAI_AGAIN: 'dns',
  ECONNREFUSED: 'network', ECONNRESET: 'network', ETIMEDOUT: 'network',
  EHOSTUNREACH: 'network', ENETUNREACH: 'network',
  '28P01': 'authentication', '28000': 'authentication',
  '3D000': 'database', '57P03': 'startup', '53300': 'capacity',
});

function classify(error) {
  // Only literal allowlisted codes cross the diagnostic boundary.
  const code = error && typeof error.code === 'string' ? error.code : '';
  return Object.hasOwn(CODES, code)
    ? { category: CODES[code], code }
    : { category: 'other', code: 'UNKNOWN' };
}

async function bounded(operation, ms) {
  if (ms <= 0) throw new Error('deadline');
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function waitForPostgres({
  newClient = (options) => new (require('pg').Client)(options),
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (event) => console.log(JSON.stringify(event)),
} = {}) {
  const started = now();
  const remaining = () => Math.max(0, BUDGET_MS - (now() - started));
  let consecutive = 0;
  let attempt = 0;
  while (remaining() > 0) {
    attempt++;
    let client;
    let failure;
    let phase = 'connect';
    let timedOut = false;
    let connectionError;
    const attemptStarted = now();
    const limit = Math.min(ATTEMPT_MS, remaining());
    try {
      client = newClient({ connectionTimeoutMillis: limit, query_timeout: limit });
      // Late connection errors must neither crash the process nor leak raw text.
      client.on('error', (error) => { connectionError = error; });
      await bounded(async () => {
        await client.connect();
        phase = 'query';
        await client.query('SELECT 1');
      }, limit).catch((error) => {
        // Driver timeouts have no stable code; the elapsed cap is authoritative.
        timedOut = remaining() <= 0 || now() - attemptStarted >= limit;
        throw error;
      });
    } catch (error) { failure = error; }
    finally {
      if (client) {
        // end() can be a no-op during connection setup; a timed-out attempt
        // must relinquish its socket even when graceful cleanup resolves.
        if (timedOut) client.connection?.stream?.destroy();
        try { await bounded(() => client.end(), Math.min(CLEANUP_MS, remaining())); }
        catch (error) {
          if (!failure) { failure = error; phase = 'cleanup'; timedOut = true; }
          // pg exposes its owned stream here; close a stuck attempt before retry.
          client.connection?.stream?.destroy();
        }
      }
    }
    if (!failure && connectionError) failure = connectionError;
    if (failure || remaining() <= 0) {
      consecutive = 0;
      const diagnosis = timedOut || remaining() <= 0
        ? { category: 'timeout', code: 'DEADLINE' } : classify(failure);
      log({ event: 'postgres-readiness-probe', attempt, elapsedMs: Math.round(now() - started), phase, consecutive, ...diagnosis });
    } else {
      consecutive++;
      log({ event: 'postgres-readiness-probe', attempt, elapsedMs: Math.round(now() - started), phase: 'query', consecutive, category: 'success', code: 'OK' });
      if (consecutive === 2) {
        log({ event: 'postgres-ready', attempt, elapsedMs: Math.round(now() - started) });
        return true;
      }
    }
    if (remaining() > 0) await sleep(Math.min(INTERVAL_MS, remaining()));
  }
  log({ event: 'postgres-readiness-failed', attempt, elapsedMs: Math.round(now() - started), budgetMs: BUDGET_MS });
  return false;
}

module.exports = { waitForPostgres, classify, BUDGET_MS, INTERVAL_MS, ATTEMPT_MS };
if (require.main === module) {
  waitForPostgres().then((ready) => process.exit(ready ? 0 : 1), () => {
    console.error(JSON.stringify({ event: 'postgres-readiness-failed', category: 'internal' }));
    process.exit(1);
  });
}
