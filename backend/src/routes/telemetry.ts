/**
 * routes/telemetry.ts — RH-P3.C7: the presence/telemetry ingest surface
 * (strategy §2.6.5, the C5/F11 trim: heartbeat + coarse status frames only).
 *
 * AUTHORITY (AUTHZ design 4d961e37, A17.7 / §9.1 — the ratified A12.2
 * successor): ingest requires `telemetry:write`; telemetry reads stay
 * `tasks:read` on their existing task-read surfaces, with no
 * `telemetry:read` until a dedicated read surface exists. Every /telemetry
 * path other than POST /frames is unmapped and fails closed to `root`.
 *
 * EACH PRINCIPAL WRITES ONLY ITS OWN FRAMES (the A17.7 in-handler identity
 * check): the frame's owner is ALWAYS the authenticated calling principal,
 * recorded server-side — the body cannot name an owner at all (the closed
 * field allowlist refuses any principal/owner field as INVALID_FRAME), and
 * a request with no resolved principal is refused outright. ZERO
 * server-side effect: an accepted frame changes telemetry_frames and
 * nothing else.
 */
import express, { Router, Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import {
  telemetryService,
  TELEMETRY_FRAME_KINDS,
  TELEMETRY_COARSE_STATUSES,
  TELEMETRY_MAX_PAYLOAD_BYTES,
  type TelemetryFrameKind,
  type TelemetryCoarseStatus,
} from '../services/TelemetryService';
import { isValidTaskId } from '../utils/taskIds';
import { telemetryEnvelopeStore } from '../services/TelemetryEnvelopeStore';
import { telemetryPrincipalService } from '../services/TelemetryPrincipalService';
import { productIsDeclared } from '../services/TelemetryDescriptorPolicy';
import { telemetryRateLimitService } from '../services/TelemetryRateLimitService';
import { telemetryQuarantineService } from '../services/TelemetryQuarantineService';
import {
  TELEMETRY_BATCH_MAX_RECORDS,
  TELEMETRY_BATCH_MAX_BYTES,
  NDJSON_BODY_TYPES,
  ndjsonBodyOptions,
} from '../utils/ndjsonBodyTypes';
import { PRODUCT_RE, telemetryAcceptedMajorsAdvertisement } from '../utils/telemetryEnvelopeValidator';
import { auditService } from '../services/AuditService';
import { logCaughtFailure, logCaughtWarning } from '../utils/secretSafeLog';
import { actorFromRequest } from '../middleware/sharedAuthorization';
import { telemetryProjectionService } from '../services/TelemetryProjectionService';
import {
  describeTelemetryReadScope,
  telemetryReadScopeFor,
  type TelemetryReadScope,
} from '../services/TelemetryReadScope';
import { isTelemetryPseudonym } from '../utils/telemetryPepper';

const router = Router();

router.post('/frames', async (req: Request, res: Response): Promise<void> => {
  try {
    const principal = (req as AuthRequest).principal;
    if (!principal?.id) {
      res.status(400).json({ success: false, code: 'PRINCIPAL_REQUIRED', error: 'Telemetry frames require a resolved principal identity' });
      return;
    }

    const body = req.body ?? {};
    const allowed = new Set(['kind', 'status', 'taskId', 'payload']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      res.status(400).json({ success: false, code: 'INVALID_FRAME', error: `Unknown frame field(s): ${unknown.join(', ')}` });
      return;
    }
    const kind = body.kind as TelemetryFrameKind;
    if (!TELEMETRY_FRAME_KINDS.includes(kind)) {
      res.status(400).json({ success: false, code: 'INVALID_FRAME', error: `kind must be one of: ${TELEMETRY_FRAME_KINDS.join(', ')}` });
      return;
    }
    const status = body.status === undefined || body.status === null ? null : body.status as TelemetryCoarseStatus;
    if (kind === 'status' && !TELEMETRY_COARSE_STATUSES.includes(status as TelemetryCoarseStatus)) {
      res.status(400).json({ success: false, code: 'INVALID_FRAME', error: `status must be one of: ${TELEMETRY_COARSE_STATUSES.join(', ')} when kind is 'status'` });
      return;
    }
    if (kind === 'heartbeat' && status !== null) {
      res.status(400).json({ success: false, code: 'INVALID_FRAME', error: 'a heartbeat frame carries no status' });
      return;
    }
    if (body.taskId !== undefined && body.taskId !== null && !isValidTaskId(String(body.taskId))) {
      res.status(400).json({ success: false, code: 'INVALID_FRAME', error: 'taskId must be a Task UUID' });
      return;
    }
    if (body.payload !== undefined && (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload))) {
      res.status(400).json({ success: false, code: 'INVALID_FRAME', error: 'payload must be a JSON object' });
      return;
    }

    const outcome = await telemetryService.ingest(principal.id, {
      kind,
      status,
      taskId: body.taskId ?? null,
      payload: body.payload ?? {},
    });
    if (!outcome.accepted) {
      if (outcome.code === 'PAYLOAD_TOO_LARGE') {
        res.status(413).json({ success: false, code: outcome.code, error: `payload exceeds ${TELEMETRY_MAX_PAYLOAD_BYTES} bytes` });
        return;
      }
      if (outcome.code === 'RATE_LIMITED') {
        res.status(429).json({ success: false, code: outcome.code, error: 'frame rate limit: one frame per interval per principal' });
        return;
      }
      res.status(400).json({ success: false, code: outcome.code, error: 'taskId names no Task' });
      return;
    }
    res.json({ success: true, accepted: true, receivedAt: outcome.receivedAt });
  } catch (err) {
    const errorId = logCaughtFailure('[Telemetry API] frame ingest failed:', err);
    res.status(500).json({ success: false, code: 'TELEMETRY_INGEST_FAILED', error: 'Failed to ingest the telemetry frame', errorId });
  }
});

/**
 * POST /telemetry/events — the native envelope surface (owner decision D11).
 *
 * The order of the stages below is the contract, not a preference:
 *
 *   1. **derive the principal** (§4.1/§5.1) — before anything is parsed, so a
 *      refused presenter never reaches the parser;
 *   2. **enforce the descriptor** (D3, §5.2) — tier declared, product declared;
 *   3. **rate-limit** (D6) — deployment-wide, before any storage work;
 *   4. **normalize and store** — the ONE entry point from candidate A, which
 *      runs validate -> dedupe -> redact -> store internally.
 *
 * IDENTITY NEVER COMES FROM THE BODY. The binding handed to the store is
 * derived entirely from the authenticated chain; the envelope's own `identity`
 * block is advisory and the Tier-0 engine keeps only a pseudonym of it (§4.1).
 * There is no code path here that reads an identifier out of the payload.
 */
router.post('/events', async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;

    // ---- 1. principal derivation (§4.1 / §5.1) --------------------------
    const derived = await telemetryPrincipalService.derive({
      actingPrincipalId: authReq.principal?.id,
      delegationLinks: authReq.delegationLinks,
    });

    if (!derived.ok) {
      // The §5.1 refusal is AUDITED. Design §4.1's fourth acceptance test asks
      // for exactly this: "a direct Account->Agent credential presenting
      // telemetry:write is refused with the distinct error AND the refusal is
      // audited." Metadata only — identifiers, never payload bytes (§6.5.3).
      await auditService.record({
        action: 'telemetry.envelope.refused',
        outcome: 'denied',
        actor: {
          principalId: authReq.principal?.id ?? null,
          handle: authReq.principal?.handle ?? 'unknown',
          authMethod: authReq.authMethod ?? 'unknown',
          credentialId: authReq.credentialId ?? null,
        },
        resourceType: 'telemetry_envelope',
        metadata: { code: derived.code, ...derived.audit },
      }).catch((err) => {
        // An audit failure must not turn a refusal into an acceptance, and the
        // caller's outcome does not change — so this is a WARNING, not a
        // request failure with a correlation id the client never sees.
        logCaughtWarning('[Telemetry API] refusal audit write failed:', err);
      });

      const status = derived.code === 'TELEMETRY_PRINCIPAL_REQUIRED' ? 400 : 403;
      res.status(status).json({ success: false, code: derived.code, error: derived.message });
      return;
    }

    const body = req.body ?? {};
    const product = typeof body?.source?.product === 'string' ? body.source.product : null;

    // ---- 2. descriptor enforcement (D3 / §5.2, ratified TS-3) ----------
    if (!product || !productIsDeclared(derived.descriptor, product)) {
      res.status(403).json({
        success: false,
        code: 'TELEMETRY_PRODUCT_NOT_DECLARED',
        error: 'The envelope source.product is not in the owning Connector descriptor declared product list (design 7d5c0cdc §5.2)',
        declaredProducts: derived.descriptor.products ?? [],
      });
      return;
    }

    // ---- 3. deployment-wide receiver limit (D6) ------------------------
    // F2: key on the ACTING principal, not the owning Connector. Keying on the
    // Connector put every Agent beneath it into one shared budget, so two
    // sibling Agents starved each other — and `329dba46`'s DoD, and this
    // endpoint's own 429 text, both say PER PRINCIPAL.
    const rateKey = derived.binding.agentId ?? derived.binding.connectorId;
    const decision = await telemetryRateLimitService.tryAccept(rateKey, 'events');
    if (!decision.accepted) {
      res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
      res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        error: 'envelope ingest rate limit: one accepted event per interval per principal',
        retryAfterMs: decision.retryAfterMs,
      });
      return;
    }

    // ---- 4. the ONE normalization entry point (candidate A) ------------
    const outcome = await telemetryEnvelopeStore.store(derived.binding, body);
    if (!outcome.accepted) {
      // ---- 5. §6.5.2 quarantine, for MALFORMED input only ---------------
      // Design §3 pipeline step 3 and §4.8: input the validator refused still
      // has diagnostic value, and it goes to quarantine under the per-connector
      // quota. A POLICY refusal does not: it is well-formed traffic a
      // deployment declined, and storing it would let a deployment's own tier
      // rule fill the plane.
      //
      // Nothing about the quarantine reaches the reporter. It is operator
      // evidence, and telling a sender whether its junk was stored or dropped
      // would hand it the quota state to aim at.
      if (outcome.stage === 'validation') {
        await telemetryQuarantineService.record(derived.binding, {
          reasonCode: outcome.code,
          field: outcome.field,
          sourceKey: `${derived.binding.connectorId}:${outcome.code}`,
          payload: body,
        }).catch((err) => {
          // A quarantine failure must not turn a refusal into an acceptance,
          // and the caller's outcome does not change — so this is a WARNING.
          logCaughtWarning('[Telemetry API] quarantine write failed:', err);
        });
      }

      const status = outcome.code === 'UNSUPPORTED_SCHEMA_MAJOR' ? 400
        : outcome.code === 'ENVELOPE_TOO_LARGE' ? 413 : 400;
      res.status(status).json({
        success: false,
        code: outcome.code,
        field: outcome.field,
        error: outcome.message,
        // §3.1/§4.8: a major rejection carries the advertisement, so a sender
        // can park its spool instead of pouring it into quarantine.
        ...(outcome.code === 'UNSUPPORTED_SCHEMA_MAJOR' ? telemetryAcceptedMajorsAdvertisement() : {}),
      });
      return;
    }

    res.json({
      success: true,
      accepted: true,
      duplicate: outcome.duplicate,
      eventId: outcome.eventId,
      identityArm: outcome.identityArm,
      redactions: outcome.counts,
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Telemetry API] envelope ingest failed:', err);
    res.status(500).json({ success: false, code: 'TELEMETRY_INGEST_FAILED', error: 'Failed to ingest the telemetry envelope', errorId });
  }
});

/**
 * `POST /telemetry/events/batch` — the ratified home of canonical batch ingest
 * (owner decisions D2 and D11).
 *
 * WIRE FORMAT, from design §3.1 and not negotiable here: **JSONL of full
 * `rh.ai.telemetry/1.0` records**, one JSON object per line. Integrity rides
 * the authenticated transport at upload; there is no separate payload
 * signature in v1, which is a ratified simplification — do not add one.
 *
 * WHY THE BODY IS PARSED HERE AND NOT GLOBALLY. `server.ts` mounts
 * `express.json()` for the JSON types only, so an NDJSON body would arrive
 * unparsed and every record would look absent. The text parser is mounted on
 * THIS path with the shared options, so the byte limit is enforced by the
 * PARSER rather than by a check after the fact: an oversized body is never
 * fully buffered, never parsed, and never reaches this handler. (A chunked
 * upload is read only until the excess is detectable — the guarantee is
 * bounded buffering, not unread bytes. Review `2b893224` F6.)
 *
 * A BATCH IS ONE REQUEST, so the deployment-wide receiver limit is spent once,
 * on the `events_batch` surface migration 112 already admits. Charging per
 * record would make the endpoint useless for the spool it exists to drain.
 *
 * PARTIAL SUCCESS IS THE NORMAL CASE. Each line is validated, redacted and
 * stored independently, and one bad line must not discard the good ones — a
 * spool that had to be all-or-nothing would retry the whole file forever. The
 * response therefore carries a per-record result, and the HTTP status reports
 * whether the BATCH was usable, not whether every record in it was.
 */
router.post(
  '/events/batch',
  express.text(ndjsonBodyOptions),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthRequest;

      // ---- 1. principal derivation (§4.1 / §5.1), identical to /events ----
      const derived = await telemetryPrincipalService.derive({
        actingPrincipalId: authReq.principal?.id,
        delegationLinks: authReq.delegationLinks,
      });

      if (!derived.ok) {
        await auditService.record({
          action: 'telemetry.envelope.refused',
          outcome: 'denied',
          actor: {
            principalId: authReq.principal?.id ?? null,
            handle: authReq.principal?.handle ?? 'unknown',
            authMethod: authReq.authMethod ?? 'unknown',
            credentialId: authReq.credentialId ?? null,
          },
          resourceType: 'telemetry_envelope',
          metadata: { code: derived.code, surface: 'events_batch', ...derived.audit },
        }).catch((err) => {
          logCaughtWarning('[Telemetry API] batch refusal audit write failed:', err);
        });

        const status = derived.code === 'TELEMETRY_PRINCIPAL_REQUIRED' ? 400 : 403;
        res.status(status).json({ success: false, code: derived.code, error: derived.message });
        return;
      }

      // ---- 2. the body must BE a batch ------------------------------------
      // `express.text()` only populates a string for the types it is mounted
      // for, so anything else arrives as an object and is refused by media
      // type rather than by guesswork about its contents.
      if (typeof req.body !== 'string') {
        res.status(415).json({
          success: false,
          code: 'UNSUPPORTED_MEDIA_TYPE',
          error: `batch ingest reads JSONL: send one rh.ai.telemetry/1.0 record per line as ${NDJSON_BODY_TYPES.join(' or ')}`,
          acceptedTypes: [...NDJSON_BODY_TYPES],
          maxBytes: TELEMETRY_BATCH_MAX_BYTES,
          maxRecords: TELEMETRY_BATCH_MAX_RECORDS,
        });
        return;
      }

      const lines = req.body.split('\n')
        .map((line, index) => ({ index, text: line.trim() }))
        .filter((line) => line.text.length > 0);

      if (lines.length === 0) {
        res.status(400).json({
          success: false, code: 'EMPTY_BATCH', error: 'a batch must carry at least one record',
        });
        return;
      }
      if (lines.length > TELEMETRY_BATCH_MAX_RECORDS) {
        res.status(413).json({
          success: false,
          code: 'BATCH_TOO_LARGE',
          error: `a batch carries at most ${TELEMETRY_BATCH_MAX_RECORDS} records; split the spool`,
          maxRecords: TELEMETRY_BATCH_MAX_RECORDS,
          received: lines.length,
        });
        return;
      }

      // ---- 3. the receiver limit, once, on the batch surface (D6) ---------
      const rateKey = derived.binding.agentId ?? derived.binding.connectorId;
      const decision = await telemetryRateLimitService.tryAccept(rateKey, 'events_batch');
      if (!decision.accepted) {
        res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
        res.status(429).json({
          success: false,
          code: 'RATE_LIMITED',
          error: 'batch ingest rate limit: one accepted batch per interval per principal',
          retryAfterMs: decision.retryAfterMs,
        });
        return;
      }

      // ---- 4. every record on its own merits ------------------------------
      const results: Array<Record<string, unknown>> = [];
      let accepted = 0;
      let duplicates = 0;
      let refused = 0;
      let majorRejected = false;

      const quarantine = async (reasonCode: string, field: string, payload: unknown) => {
        await telemetryQuarantineService.record(derived.binding, {
          reasonCode,
          field,
          sourceKey: `${derived.binding.connectorId}:${reasonCode}`,
          payload,
        }).catch((err) => {
          logCaughtWarning('[Telemetry API] batch quarantine write failed:', err);
        });
      };

      for (const line of lines) {
        let record: unknown;
        try {
          record = JSON.parse(line.text);
        } catch {
          // A line that is not JSON is malformed input, and malformed input is
          // exactly what quarantine is for. The line itself is NEVER echoed
          // back or stored — only its hash and its shape.
          refused += 1;
          results.push({ index: line.index, accepted: false, code: 'INVALID_JSON_LINE', field: 'line' });
          await quarantine('INVALID_JSON_LINE', 'line', line.text);
          continue;
        }

        const product = typeof (record as { source?: { product?: unknown } })?.source?.product === 'string'
          ? (record as { source: { product: string } }).source.product
          : null;

        if (!product || !productIsDeclared(derived.descriptor, product)) {
          // A descriptor refusal is NOT quarantined: the record may be
          // perfectly well formed, and it is the deployment's own declaration
          // that refused it. Quarantining it would let a descriptor fill the
          // plane the same way a policy tier would.
          refused += 1;
          results.push({
            index: line.index,
            accepted: false,
            code: 'TELEMETRY_PRODUCT_NOT_DECLARED',
            field: 'source.product',
          });
          continue;
        }

        const outcome = await telemetryEnvelopeStore.store(derived.binding, record);
        if (!outcome.accepted) {
          refused += 1;
          majorRejected = majorRejected || outcome.code === 'UNSUPPORTED_SCHEMA_MAJOR';
          results.push({
            index: line.index, accepted: false, code: outcome.code, field: outcome.field,
          });
          if (outcome.stage === 'validation') {
            await quarantine(outcome.code, outcome.field, record);
          }
          continue;
        }

        if (outcome.duplicate) duplicates += 1; else accepted += 1;
        results.push({
          index: line.index,
          accepted: true,
          duplicate: outcome.duplicate,
          eventId: outcome.eventId,
          rawRef: outcome.rawRef,
        });
      }

      res.json({
        success: true,
        received: lines.length,
        accepted,
        duplicates,
        refused,
        results,
        // §3.1/§4.8: a major rejection carries the advertisement, so a sender
        // can park its spool instead of pouring it into quarantine.
        ...(majorRejected ? telemetryAcceptedMajorsAdvertisement() : {}),
      });
    } catch (err) {
      const errorId = logCaughtFailure('[Telemetry API] batch ingest failed:', err);
      res.status(500).json({
        success: false, code: 'TELEMETRY_BATCH_FAILED', error: 'Failed to ingest the telemetry batch', errorId,
      });
    }
  },
);

/**
 * ─────────────────────── THE TW1c READ SURFACE (card `50e74c1d`) ────────────
 *
 * Four GETs, and one rule that governs all four: **the narrowing is derived
 * once, before anything is read, and it is a REQUIRED argument to every
 * projection call.** `telemetryReadScopeFor` returns `null` for a caller it
 * cannot place, and `null` is a 403 here — never a wide read, because
 * `TelemetryReadScope` has no member that means "everything I could not
 * narrow".
 *
 * SCOPE STRING. These routes ride `services:read` (`utils/scopeMap.ts`), the
 * EXISTING read scope of the object they are about: per
 * `utils/connectorRegistry.ts` a Connector is "a `services` row with
 * `kind = 'connector'`", and the §5.3 selectable object is keyed
 * `(owning connector_id, source.product)`. Design §5.3 is explicit that "Tier
 * 0/1 events and rollups ride existing read scopes"; there is still NO
 * `telemetry:read`, and `telemetryFrames.test.ts` still asserts its absence
 * from `ALL_SCOPES`. The scope is the CEILING; `TelemetryReadScope` is the
 * subtree. Neither substitutes for the other, and both are enforced.
 *
 * TIER 2 IS NOT HERE. Nothing on these routes returns content: Tier 0 stores
 * none (§6.3 default OFF, and the policy engine nulls all four content
 * references). `telemetry-contents:read`, its selector machinery and its
 * per-read audit are TW5 scope, and this card does not claim any of it exists.
 */
router.get('/presence', async (req: Request, res: Response): Promise<void> => {
  await serveProjection(req, res, 'presence', (scope) =>
    telemetryProjectionService.presence(scope, projectionOptions(req)).then((sources) => ({ sources })));
});

router.get('/sessions', async (req: Request, res: Response): Promise<void> => {
  await serveProjection(req, res, 'sessions', (scope) =>
    telemetryProjectionService.sessions(scope, projectionOptions(req)).then((sessions) => ({ sessions })));
});

/**
 * The POINT route.
 *
 * A session's identity is the TRIPLE `(connectorId, sourceProduct,
 * sessionRef)`, and all three are REQUIRED. `session_ref` is
 * `HMAC(domain, product|seed)` — namespaced by the product but not by the
 * Connector — so two Connectors under one Account reporting the same product
 * and the same source-side session id share a pseudonym. Round-1 review
 * `f4c56960` showed that keying on the pseudonym alone returned one session's
 * header with two sessions' events. The missing members are refused here, with
 * their own code, so the service is never handed a partial key.
 *
 * A `session_ref` belonging to another Account and one that names nothing
 * answer IDENTICALLY — same status, same code, same message — because the
 * projection applies the same narrowing and returns `null` for both. A point
 * route that distinguished them would be an existence oracle over another
 * Account's sessions, the defect class card `45e7110a` closed on the mint
 * surface. A WRONG-but-well-formed connector or product lands on that same
 * arm, so guessing at the other two members discloses nothing either.
 */
router.get('/sessions/:sessionRef', async (req: Request, res: Response): Promise<void> => {
  const sessionRef = String(req.params.sessionRef ?? '');
  const connectorId = stringQuery(req.query.connectorId);
  const sourceProduct = stringQuery(req.query.sourceProduct);
  if (!isTelemetryPseudonym(sessionRef)) {
    // Shape refusal, and it says only that the shape is wrong. A malformed id
    // cannot name a row, so answering it differently discloses nothing — but
    // it is deliberately a DIFFERENT code from the not-found below, so the
    // not-found arm stays the single indistinguishable answer.
    res.status(400).json({
      success: false,
      code: 'INVALID_SESSION_REF',
      error: 'sessionRef must be a telemetry session pseudonym',
    });
    return;
  }
  if (!connectorId || !isValidTaskId(connectorId) || !sourceProduct || !PRODUCT_RE.test(sourceProduct)) {
    // Also a SHAPE refusal, and for the same reason it discloses nothing: it
    // is about the request, not about any row. `isValidTaskId` is the shipped
    // UUID predicate this file already imports for frame ingest; a Connector
    // id is a principal UUID and the same shape test applies.
    //
    // `PRODUCT_RE` is the INGEST product grammar, IMPORTED from
    // `telemetryEnvelopeValidator` rather than restated. Review `a4a748d5`
    // (MINOR) found this arm checking presence and a 256-character ceiling
    // while the comment above claimed a malformed key was refused before any
    // row was read. Nothing leaked — the query is parameterized and the 404 is
    // common — but a product key that ingest could never have stored has no
    // business reaching the service, and a claim in a comment is a claim.
    res.status(400).json({
      success: false,
      code: 'INCOMPLETE_SESSION_KEY',
      error:
        'A session is identified by connectorId, sourceProduct and sessionRef together '
        + '(design 7d5c0cdc §5.3); connectorId must be a UUID and sourceProduct must match the '
        + 'ingest product grammar.',
    });
    return;
  }
  await serveProjection(req, res, 'session', async (scope) => {
    const detail = await telemetryProjectionService.session(
      scope,
      { sessionRef, connectorId, sourceProduct },
      { ...projectionOptions(req), events: numericQuery(req.query.events) },
    );
    if (!detail) return null;
    return detail;
  });
});

/** One query parameter as a non-empty string, or null. Arrays take the first. */
function stringQuery(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 256 ? raw : null;
}

router.get('/stats', async (req: Request, res: Response): Promise<void> => {
  await serveProjection(req, res, 'stats', (scope) =>
    telemetryProjectionService.stats(scope, projectionOptions(req)));
});

function numericQuery(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Narrow-only request bounds; the service clamps them against its ceilings. */
function projectionOptions(req: Request): { windowDays?: number; limit?: number } {
  return {
    windowDays: numericQuery(req.query.windowDays),
    limit: numericQuery(req.query.limit),
  };
}

/**
 * The ONE place the four read routes derive their narrowing, refuse, and
 * report. Written once so a fifth route cannot be added with a fourth
 * spelling of the refusal — the shape that lets two answers drift apart.
 */
async function serveProjection(
  req: Request,
  res: Response,
  surface: string,
  read: (scope: TelemetryReadScope) => Promise<unknown>,
): Promise<void> {
  try {
    const authReq = req as AuthRequest;
    const actor = authReq.authorizationActor ?? actorFromRequest(authReq);
    const scope = telemetryReadScopeFor(actor);
    if (!scope) {
      res.status(403).json({
        success: false,
        code: 'TELEMETRY_READ_SCOPE_REQUIRED',
        error:
          'The telemetry projection is read within the caller Account subtree (design 7d5c0cdc §5.3). '
          + 'This credential resolves to no Account, so no subtree can be narrowed to.',
      });
      return;
    }
    const data = await read(scope);
    if (data === null) {
      res.status(404).json({ success: false, code: 'TELEMETRY_SESSION_NOT_FOUND', error: 'No such session' });
      return;
    }
    res.json({ success: true, scope: describeTelemetryReadScope(scope), ...(data as Record<string, unknown>) });
  } catch (err) {
    const errorId = logCaughtFailure(`[Telemetry API] ${surface} projection failed:`, err);
    res.status(500).json({
      success: false,
      code: 'TELEMETRY_PROJECTION_FAILED',
      error: 'Failed to read the telemetry projection',
      errorId,
    });
  }
}

export default router;
