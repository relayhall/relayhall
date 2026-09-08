import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import { pool as housePool } from '../db/connection';
import { AuthRequest } from './auth';
import { sendApiError } from '../utils/apiErrors';
import { stableJson } from '../utils/stableJson';
import { logCaughtFailure } from '../utils/secretSafeLog';

/**
 * The mutating-tool retry contract — card fb06c930, design record bf8928ee v5
 * (+ ANNEX A dd3aaa9e), owner rulings 94ecf329 Batch 1 and 1d8dcd5c.
 *
 * ONE per-route middleware, mounted INSIDE each protected router, so it runs
 * after `authMiddleware` / `mcpAuthMiddleware` AND after
 * `sharedAuthorizationMiddleware` (server.ts:199-201, mcp/inProcess.ts:94-104).
 * A replay is therefore served only to the same scope the guard chain has just
 * admitted on THIS request — the 067 ordering property
 * (ProjectResourceService.ts:626-631) that a generic middleware cannot
 * reproduce by running the handler's own gates first.
 *
 * The header is OPTIONAL at REST and REQUIRED on the MCP tool surface: the
 * requirement is enforced in the tool handler (`req(args, 'idempotencyKey')`),
 * because nothing validates a tool's inputSchema (census C-1).
 */

export type ReplayPolicy = 'return' | 'refuse';
export type ScopeKind = 'principal' | 'credential';

export interface IdempotentOperationDeclaration {
  readonly scope: ScopeKind;
  readonly replay: ReplayPolicy;
}

/**
 * The closed operation set (design §3.3). `credential` is the DEFAULT for any
 * operation added later — an explicit `scope` is required here, and the
 * scope-declaration census of §4.3 fails any operation declared `principal`
 * whose route file reads `req.credentialId`. The direction matters: a wrongly
 * credential-scoped operation merely creates two records after a credential
 * rotation, while a wrongly principal-scoped one could serve a replay to a
 * second credential.
 */
/**
 * DECLARED AMENDMENT to design record `bf8928ee` v5 §3.5 / ruling 3, made by the
 * dispatcher under ruling `623632b0` on review round 3's finding B1/B2.
 *
 * WHAT CHANGED. `task.create`, `task.patch` and `task.stream.append` move from
 * `principal` scope to `credential` scope. Everything else is unchanged.
 *
 * WHY. §3.2's ordering argument was that "a replay is served only to the SAME
 * scope the guard chain has just admitted on THIS request", and design round 2
 * traced the mounts and found no handler-level binding a same-scope replay would
 * bypass. It missed two, and they are FIELD-level rather than route-level:
 *
 *   - `POST /tasks` and `PATCH /tasks/:id` refuse an `executionProfile` that
 *     targets a Service without `services:invoke` (`routes/tasks.ts:293-305` —
 *     "bare task-write must never be enough", and the check runs BEFORE any
 *     Service lookup so a bare task-writer learns nothing);
 *   - `POST /tasks/:id/stream` refuses `provenance: 'reported'` without
 *     `services:write` (`routes/tasks.ts:2041-2044`).
 *
 * Under principal scope a full-authority credential could commit one of those
 * calls and a SECOND credential of the SAME principal — carrying `tasks:write`
 * but not the field-level scope — would be served the stored 2xx, receiving a
 * result the handler would have refused it. Credential scope removes that by
 * construction: the second credential resolves to a different scope, so there is
 * no row to replay and the request reaches the handler that refuses it.
 *
 * Ruling 3 already makes `credential` the DEFAULT for exactly this reason: "a
 * wrongly credential-scoped operation merely creates two records after a
 * credential rotation (today's behaviour); a wrongly principal-scoped one can
 * serve a replay to a second credential, which is B4." These three operations
 * are that case. The COST, stated: two credentials of one principal now create
 * two records for these three operations instead of sharing one replay — the
 * behaviour §3.5 assigned to principal-scoped operations is given up for them,
 * deliberately, because it is what carries the bypass.
 *
 * The remaining principal-scoped operations have no field-level authority check
 * beyond their route scope, which `4.1.4`'s no-record baseline now measures with
 * credentials of DIFFERING effective authority rather than identical ones.
 */
export const IDEMPOTENT_OPERATIONS = {
  // Credential-scoped BECAUSE the handler applies a field-level authority check
  // the guard chain does not (the amendment above).
  'task.create':             { scope: 'credential', replay: 'return' },
  'task.stream.append':      { scope: 'credential', replay: 'return' },
  'task.patch':              { scope: 'credential', replay: 'return' },
  // Principal-scoped: no field-level authority check beyond the route scope.
  'task.reference.create':   { scope: 'principal',  replay: 'return' },
  'task.note.append':        { scope: 'principal',  replay: 'return' },
  'report.create':           { scope: 'principal',  replay: 'return' },
  'project.create':          { scope: 'principal',  replay: 'return' },
  'project.resource.create': { scope: 'principal',  replay: 'return' },
  // Credential-bound by ruling 3, and refuse-replay by ruling 2.
  'agent.mint.request':      { scope: 'credential', replay: 'refuse' },
  'agent.mint.collect':      { scope: 'credential', replay: 'refuse' },
} as const satisfies Record<string, IdempotentOperationDeclaration>;

export type IdempotentOperation = keyof typeof IDEMPOTENT_OPERATIONS;

/** §3.6 — retention is stored on the row, not derived at read time (102's reasoning). */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** §3.2 step 5 — the crash-window take-over threshold. */
export const IDEMPOTENCY_IN_FLIGHT_TAKEOVER_MS = 60_000;

export const IDEMPOTENCY_KEY_MIN = 16;
export const IDEMPOTENCY_KEY_MAX = 128;

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'Retry-Replayed';
export const REQUEST_ID_HEADER = 'Retry-Request-Id';

interface IdempotencyRow {
  request_hash: string;
  state: 'in_flight' | 'completed';
  replay_policy: ReplayPolicy;
  response_status: number | null;
  response_body: string | null;
  response_content_type: string | null;
  request_id: string;
  created_at: Date;
  expires_at: Date;
}

/**
 * The pool the middleware uses. The house pool by default; the real-PostgreSQL
 * contract suite points it at its own disposable database, which is the only
 * reason this indirection exists.
 */
let activePool: Pool = housePool;
export function setIdempotencyPool(next: Pool): void { activePool = next; }
export function resetIdempotencyPool(): void { activePool = housePool; }
export function idempotencyPool(): Pool { return activePool; }

export function canonicalRequestHash(req: Request): string {
  return crypto.createHash('sha256')
    .update(stableJson({ params: req.params, body: req.body ?? {} }))
    .digest('hex');
}

/**
 * §3.5 — the scope is a single prefixed value, so a credential id can never
 * collide with a principal id and re-declaring an operation's scope kind can
 * never make an old row replay for a new kind.
 */
export function resolveScope(req: Request, kind: ScopeKind): string | null {
  const auth = req as AuthRequest;
  if (kind === 'credential') {
    // A login session IS the binding on delegation's session-mint path
    // (routes/delegation.ts:190-208), so it is the credential-equivalent there.
    if (auth.credentialId) return `cred:${auth.credentialId}`;
    if (auth.userId) return `user:${auth.userId}`;
    return null;
  }
  if (auth.principal?.id) return `prin:${auth.principal.id}`;
  if (auth.userId) return `user:${auth.userId}`;
  return null;
}

async function readRow(
  pool: Pool, scope: string, operation: string, key: string,
): Promise<IdempotencyRow | null> {
  const result = await pool.query<IdempotencyRow>(
    `SELECT request_hash, state, replay_policy, response_status, response_body,
            response_content_type, request_id, created_at, expires_at
       FROM operation_idempotency_records
      WHERE scope = $1 AND operation = $2 AND idempotency_key = $3`,
    [scope, operation, key],
  );
  return result.rows[0] ?? null;
}

async function reserve(
  pool: Pool, scope: string, operation: string, key: string,
  hash: string, policy: ReplayPolicy,
): Promise<string | null> {
  const result = await pool.query<{ request_id: string }>(
    `INSERT INTO operation_idempotency_records
       (scope, operation, idempotency_key, request_hash, state, replay_policy, expires_at)
     VALUES ($1, $2, $3, $4, 'in_flight', $5, now() + ($6 || ' milliseconds')::interval)
     ON CONFLICT (scope, operation, idempotency_key) DO NOTHING
     RETURNING request_id`,
    [scope, operation, key, hash, policy, String(IDEMPOTENCY_RETENTION_MS)],
  );
  return result.rows[0]?.request_id ?? null;
}

async function releaseReservation(
  pool: Pool, scope: string, operation: string, key: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM operation_idempotency_records
      WHERE scope = $1 AND operation = $2 AND idempotency_key = $3 AND state = 'in_flight'`,
    [scope, operation, key],
  );
}

/**
 * The one durable sweep for this table (§3.6). Bounded per tick, wired beside
 * the other server sweeps and never in boot-check mode.
 */
export async function sweepExpiredIdempotencyRecords(): Promise<number> {
  const result = await activePool.query(
    `DELETE FROM operation_idempotency_records
      WHERE ctid IN (
        SELECT ctid FROM operation_idempotency_records WHERE expires_at <= now() LIMIT 1000
      )`,
  );
  return result.rowCount ?? 0;
}

/**
 * §3.2 step 6 — capture the bytes the framework actually sends.
 *
 * The route keeps calling `res.json(body)`; Express's `res.json` serializes
 * with the application's own `json replacer` / `json spaces` / `json escape`
 * settings and then calls `res.send(<string>)`. Wrapping `send` therefore
 * captures EXACTLY the string that goes on the wire, with no re-implementation
 * of Express's serializer to drift from — and the completion row is written
 * BEFORE those bytes leave.
 */
function captureAndComplete(
  res: Response, pool: Pool,
  scope: string, operation: string, key: string, policy: ReplayPolicy,
): void {
  const originalSend = res.send.bind(res);
  let intercepted = false;
  /**
   * The RECORD's state, not the response's. `intercepted` says the wrapper has
   * taken the handler's answer; `resolved` says the retry record reached the
   * state this request owes it — completed for a success, gone for a refusal.
   *
   * Review r1 finding B2 turned on conflating the two: the wrapper set one flag
   * before an ASYNCHRONOUS database call and the close handler then read that
   * flag as "nothing to clean up", so a client that went away while the
   * completion or the delete was still in flight left the reservation behind.
   * The close handler now asks whether the RECORD is resolved.
   */
  let resolved = false;

  /**
   * FAIL CLOSED. The contract this middleware sells is that a retry carrying
   * the same token does not repeat the act; that promise is kept by the record,
   * and if the record could not be written the promise is not kept.
   *
   * The first build sent the handler's nominal answer anyway, with a header
   * naming the failure. Review r1 B2 is right that this is the wrong direction:
   * the caller reads a 2xx, believes the act is recorded, and a retry either
   * runs the handler AGAIN or is refused as IN_FLIGHT for a minute. A caller
   * who is told the truth can retry deliberately; a caller who is told 201 and
   * silently handed a broken contract cannot.
   *
   * What this does NOT do is undo the handler's own write — that transaction
   * committed and this middleware never rewrites a committed result. It says so
   * in the error: the act may have landed, and the retry token did not.
   */
  function failClosed(err: unknown, what: string): void {
    const errorId = logCaughtFailure(`[idempotency] ${what}`, err);
    if (res.headersSent) return;
    res.status(500);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    originalSend(JSON.stringify({
      success: false,
      error: 'The retry record for this call could not be written',
      code: 'IDEMPOTENCY_RECORD_UNAVAILABLE',
      message: 'The retry record for this call could not be written, so the retry contract cannot be honoured for this token.',
      suggestion: 'The operation itself may have been applied. Re-read the resource before retrying, and retry with a NEW token.',
      details: { errorId },
    }) as never);
  }

  (res as Response).send = ((body?: unknown) => {
    if (intercepted) return originalSend(body as never);
    intercepted = true;

    const status = res.statusCode;
    if (status < 200 || status >= 300) {
      // A refused first attempt is not an outcome to replay — 067 records only
      // on commit. The reservation goes BEFORE the refusal leaves: a caller that
      // has been answered may retry immediately, and a reservation still in
      // flight at that moment would answer IDEMPOTENCY_KEY_IN_FLIGHT for a call
      // that already finished (§4.1.7). If it cannot go, the caller is told.
      return void releaseReservation(pool, scope, operation, key).then(
        () => { resolved = true; originalSend(body as never); },
        (err) => { failClosed(err, 'releasing a refused reservation failed'); },
      );
    }

    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const contentType = String(res.getHeader('Content-Type') ?? 'application/json; charset=utf-8');
    const store = policy === 'refuse'
      ? { status: null as number | null, body: null as string | null, type: null as string | null }
      : { status, body: text, type: contentType };

    // The completion row is written BEFORE the bytes leave. 4.1.12 asserts that
    // ordering directly, at the trigger seam, with a synchronous send-boundary
    // count (B-3) rather than a timeout.
    return void pool.query(
      `UPDATE operation_idempotency_records
          SET state = 'completed', response_status = $4, response_body = $5, response_content_type = $6
        WHERE scope = $1 AND operation = $2 AND idempotency_key = $3`,
      [scope, operation, key, store.status, store.body, store.type],
    ).then(
      () => { resolved = true; originalSend(body as never); },
      (err) => { failClosed(err, 'completing a retry record failed'); },
    );
  }) as Response['send'];

  /**
   * A connection that goes away leaves the reservation behind unless something
   * removes it, and the DELETE is scoped to `state = 'in_flight'`, so running it
   * can never destroy a completed record — which is what makes it safe to run
   * whenever the record is UNRESOLVED, including while a completion is still in
   * flight. That is the second half of B2: the old guard skipped cleanup
   * precisely in the case that needed it.
   */
  res.on('close', () => {
    if (resolved) return;
    void releaseReservation(pool, scope, operation, key)
      .catch((err) => logCaughtFailure('[idempotency] releasing an abandoned reservation failed', err));
  });
}

function serveReplay(res: Response, row: IdempotencyRow): void {
  res.setHeader(REPLAYED_HEADER, 'true');
  res.setHeader(REQUEST_ID_HEADER, row.request_id);
  res.status(row.response_status as number)
    .type(row.response_content_type as string)
    .send(row.response_body as string);
}

/**
 * `idempotent(operation)` — the per-route mount. Throws at module load for an
 * undeclared name, so a mount can never carry an operation the declaration
 * table does not know.
 */
export function idempotent(operation: IdempotentOperation) {
  const declaration = IDEMPOTENT_OPERATIONS[operation] as IdempotentOperationDeclaration | undefined;
  if (!declaration) {
    throw new Error(`idempotent(): '${operation}' is not a declared operation (middleware/idempotency.ts)`);
  }

  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.headers[IDEMPOTENCY_HEADER];
    const key = Array.isArray(header) ? header[0] : header;

    // 1. Header absent → unchanged behaviour. OPTIONAL at REST.
    if (typeof key !== 'string' || key.length === 0) { next(); return; }

    // 2. Validate.
    if (key.length < IDEMPOTENCY_KEY_MIN || key.length > IDEMPOTENCY_KEY_MAX) {
      sendApiError(res, 400, 'IDEMPOTENCY_KEY_INVALID',
        `Idempotency-Key must be ${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} characters`,
        'Send the same value on every retry of the same call; a UUID is fine.');
      return;
    }

    // 3. Resolve the scope for this operation's declared kind.
    const scope = resolveScope(req, declaration.scope);
    if (!scope) {
      sendApiError(res, 400, 'IDEMPOTENCY_SCOPE_UNAVAILABLE',
        'This request carries no identity to scope a retry token to',
        'Authenticate with a principal credential and retry.');
      return;
    }

    const pool = activePool;
    const hash = canonicalRequestHash(req);

    try {
      // 5. Reserve.
      let requestId = await reserve(pool, scope, operation, key, hash, declaration.replay);

      if (requestId === null) {
        let row = await readRow(pool, scope, operation, key);

        if (row && row.expires_at.getTime() <= Date.now()) {
          // A row past expires_at is an ABSENT row (§3.6's read rule is what
          // makes the contract true regardless of sweep timing).
          await pool.query(
            `DELETE FROM operation_idempotency_records
              WHERE scope = $1 AND operation = $2 AND idempotency_key = $3`,
            [scope, operation, key],
          );
          requestId = await reserve(pool, scope, operation, key, hash, declaration.replay);
          row = requestId === null ? await readRow(pool, scope, operation, key) : null;
        }

        if (requestId === null) {
          if (!row) { next(); return; }

          if (row.state === 'completed') {
            if (row.request_hash !== hash) {
              res.setHeader(REQUEST_ID_HEADER, row.request_id);
              sendApiError(res, 409, 'IDEMPOTENCY_KEY_REUSED',
                'That retry token has already been used for a different request',
                'Use a fresh token for a new act, or resend the identical request to retry the first one.');
              return;
            }
            if (row.replay_policy === 'refuse') {
              res.setHeader(REQUEST_ID_HEADER, row.request_id);
              sendApiError(res, 409, 'IDEMPOTENCY_REPLAY_UNAVAILABLE',
                'This mint has already been committed under that key. The one-time pack is never stored, so it cannot be returned again; use relayhall_agent_reveal for the credential\'s secret, or mint again with a new key.',
                'Mint again with a new retry token if you need a second credential.');
              return;
            }
            serveReplay(res, row);
            return;
          }

          // state = 'in_flight'
          const age = Date.now() - row.created_at.getTime();
          if (age <= IDEMPOTENCY_IN_FLIGHT_TAKEOVER_MS) {
            res.setHeader(REQUEST_ID_HEADER, row.request_id);
            sendApiError(res, 409, 'IDEMPOTENCY_KEY_IN_FLIGHT',
              'The first call carrying that retry token is still running',
              'Wait for it to answer, then retry with the same token.');
            return;
          }

          // Older than the take-over threshold: the stated one-statement crash
          // window (§3.2). Take the row over and proceed.
          const takeover = await pool.query<{ request_id: string }>(
            `UPDATE operation_idempotency_records
                SET request_hash = $4, created_at = now(),
                    expires_at = now() + ($5 || ' milliseconds')::interval
              WHERE scope = $1 AND operation = $2 AND idempotency_key = $3
                AND state = 'in_flight'
                AND created_at <= now() - ($6 || ' milliseconds')::interval
              RETURNING request_id`,
            [scope, operation, key, hash, String(IDEMPOTENCY_RETENTION_MS),
             String(IDEMPOTENCY_IN_FLIGHT_TAKEOVER_MS)],
          );
          if (takeover.rowCount === 0) {
            // Somebody else moved it while we looked: re-read and re-branch once.
            const fresh = await readRow(pool, scope, operation, key);
            if (fresh && fresh.state === 'completed' && fresh.request_hash === hash
                && fresh.replay_policy === 'return') {
              serveReplay(res, fresh);
              return;
            }
            res.setHeader(REQUEST_ID_HEADER, fresh?.request_id ?? row.request_id);
            sendApiError(res, 409, 'IDEMPOTENCY_KEY_IN_FLIGHT',
              'The first call carrying that retry token is still running',
              'Wait for it to answer, then retry with the same token.');
            return;
          }
          requestId = takeover.rows[0].request_id;
        }
      }

      // 6-7. Run the handler, capturing the bytes it sends.
      res.setHeader(REQUEST_ID_HEADER, requestId);
      captureAndComplete(res, pool, scope, operation, key, declaration.replay);
      next();
    } catch (err) {
      await releaseReservation(pool, scope, operation, key).catch(() => undefined);
      const errorId = logCaughtFailure('[idempotency] retry-record handling failed', err);
      sendApiError(res, 500, 'INTERNAL_ERROR', 'Unexpected server error',
        'Retry once; if it persists check backend logs.', { errorId });
    }
  };
}

export default idempotent;
