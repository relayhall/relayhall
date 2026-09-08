import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';
import { logCaughtFailure } from '../utils/secretSafeLog';

dotenv.config();

// Boot-check mode (RELAYHALL_BOOT_CHECK=1) exists so a boot gate can prove the
// server constructs and binds without ever reaching a database — even when the
// environment carries live credentials. The pool is pinned to an unreachable
// endpoint here, at construction, so no code path in the process can open a
// live connection regardless of what the environment contains.
export const BOOT_CHECK_MODE = process.env.RELAYHALL_BOOT_CHECK === '1';

// Shared configuration is also used by the tiny, independent lifecycle-policy
// denial-evidence pool. Keeping it explicit prevents a saturated mutation pool
// from deadlocking every enforced denial while each transaction waits to write
// its durable evidence.
export const databasePoolConfig: PoolConfig = BOOT_CHECK_MODE
    ? {
        host: '127.0.0.1',
        port: 59998,
        database: 'relayhall_boot_check_none',
        user: 'none',
        password: 'none',
        max: 1,
        connectionTimeoutMillis: 500,
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'relayhall_dev',
        user: process.env.DB_USER || 'relayhall_dev',
        password: process.env.DB_PASSWORD || 'dev_password_change_me',
        max: 20, // Maximum number of clients in the pool
        idleTimeoutMillis: 30000,
        // 590e88cc. This was 2000, and it was the second half of the reported
        // "intermittent 500s across five task-read paths and the AutoArchive
        // job". The first half was a per-row fan-out in GET /tasks that offered
        // this pool nine thousand acquisitions for one request; that is gone.
        // What remained was this number, and what it was being spent on.
        //
        // MEASURED, on the 5,200-Task fixture, GET /tasks alone, nine runs at
        // each value (concurrency 12, 16 and 24, three runs each):
        //
        //   2000ms   127 of 156 requests answered 200 — twenty-nine lost
        //   15000ms  156 of 156 requests answered 200 — none lost
        //
        // Every one of the twenty-nine was pg's acquisition timeout: a plain
        // Error with no `code`, message "timeout exceeded when trying to
        // connect", which is exactly the class=Error code=ERROR_UNCLASSIFIED
        // this card's fifteen recorded failures carried. Some of them did not
        // even surface as 500s: a failed session read on that path answers 401,
        // so a signed-in operator was told their credential was invalid.
        //
        // THE POOL WAS NEVER EXHAUSTED IN EITHER RUN. `waitingCount` peaked at
        // 32 against a `max` of 20 and drained continuously, at BOTH values,
        // and the event loop stalled by the same 0.5-0.9s at both. The deadline
        // is wall-clock, and wall clock includes the time this process spends
        // not running the pool's callbacks — serializing an unpaginated
        // whole-estate list response is ~6MB of JSON, and sixteen concurrent
        // copies of it stall the loop for longer than a fifth of the old
        // deadline at a time. So 2000ms was not protecting the database from
        // anything; it was failing requests the database was ready to serve.
        //
        // 15000ms is chosen against that measurement and not against taste: it
        // is an order of magnitude above the worst stall observed under a load
        // mix this product supports, and comfortably below the proxy and
        // browser deadlines that bound a request anyway. A database that is
        // genuinely unreachable does not wait for it — a refused or unresolved
        // connection fails immediately with its own error, not through this
        // timer.
        //
        // The RIGHT long-term repair is to stop building 6MB responses (card
        // 7104b5c2, an API-contract decision). This makes the failure stop; it
        // does not make the response small.
        connectionTimeoutMillis: 15000,
      };

// Database connection pool
export const pool = new Pool(databasePoolConfig);

// Test database connection
pool.on('connect', () => {
  console.log('✅ Database connected');
});

pool.on('error', (err) => {
  logCaughtFailure('[Database] unexpected pool failure', err);
  process.exit(-1);
});

// Helper function to query database
export const query = (text: string, params?: any[]) => {
  return pool.query(text, params);
};

export default pool;
