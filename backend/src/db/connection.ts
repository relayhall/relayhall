import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { refusePlaceholderDatabasePassword } from '../config/placeholderSecrets';

dotenv.config();

// The .env.example POSTGRES_PASSWORD placeholder is public: a backend (or a
// migration run) started with it refuses here, before any pool exists, in
// every mode (config/placeholderSecrets).
refusePlaceholderDatabasePassword(process.env);

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

// D11 containment: reject inherited source-database configuration before
// constructing any pool. Keep the exact legacy names below: these are denied
// targets, not product defaults or supported deployment names. An unset name
// is also refused so a missing variable cannot silently choose a database.
// The host denial cannot be released by the explicit database-name opt-in.
export const REFUSED_DB_NAMES: readonly string[] = ['clawboard', 'clawboard_dev'];
export const REFUSED_DB_HOSTS: readonly string[] = ['clawboard-db', 'clawboard-dev-db'];

export function assertDatabaseTargetAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const name = (env.DB_NAME ?? '').trim();
  const host = (env.DB_HOST ?? '').trim();
  const allow = (env.RELAYHALL_ALLOW_DB_NAME ?? '').trim();

  const refuse = (target: string, what: string): never => {
    throw new Error(
      `[db] refusing to create a connection pool: ${what} (${target || '<unset>'}). `
      + 'RelayHall must not inherit a foreign database environment (incident D11, '
      + 'reference 47718b8f). Set DB_NAME to the RelayHall database you mean, or set '
      + `RELAYHALL_ALLOW_DB_NAME=${target || '<name>'} to allow that exact name explicitly.`,
    );
  };

  // The HOST rule is checked FIRST, above the opt-in, and nothing releases it.
  // The incident was reached by a session on the source database SERVER; an
  // opt-in that released this would let one environment variable rebuild that
  // exact configuration under a sibling database name, which is the shape of
  // `relayhall_w2_r4_review` (W1d 4). Reaching that server is never a naming
  // mistake to be waived — it needs a different host.
  if (REFUSED_DB_HOSTS.includes(host)) refuse(host, 'DB_HOST names a refused database server');

  // The single escape hatch, and it releases the NAME rules only: an operator
  // naming the exact database they mean. An unset DB_NAME can never match it,
  // so the opt-in cannot re-open the "no environment at all" case either.
  if (name !== '' && allow !== '' && allow === name) return;

  if (name === '') refuse('', 'DB_NAME is unset, so the pool would choose a database nobody named');
  if (REFUSED_DB_NAMES.includes(name)) refuse(name, 'DB_NAME names a refused database');
}

// Boot-check mode is exempt because its configuration above is pinned, at
// construction, to 127.0.0.1:59998 / relayhall_boot_check_none and therefore
// cannot reach any server the environment names — there is no target to refuse.
if (!BOOT_CHECK_MODE) {
  assertDatabaseTargetAllowed();
}

// Database connection pool
export const pool = new Pool(databasePoolConfig);

// Test database connection
pool.on('connect', () => {
  console.log('✅ Database connected');
});

pool.on('error', (err) => {
  // pg-pool has already removed the failed idle client before emitting this
  // event. Keep the server alive so requests can report database unavailability
  // and later acquisitions can create a replacement after PostgreSQL recovers.
  // Startup schema/canary failures remain fatal at their existing gates.
  logCaughtFailure('[Database] unexpected pool failure', err);
});

// Helper function to query database
export const query = (text: string, params?: any[]) => {
  return pool.query(text, params);
};

export default pool;
