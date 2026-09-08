import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { sendApiError } from '../utils/apiErrors';
import { auditService } from '../services/AuditService';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z0-9_.]{2,127}$/;

/**
 * A PREFIX is not an action, so it does not carry the action CHECK's minimum
 * length: `grant` and `credential.` are both legitimate heads. It admits the
 * SAME alphabet and nothing else, so no wildcard character can reach the
 * query — and `AuditService.list` matches with `left()` rather than `LIKE`
 * for the same reason, since `_` is a LIKE wildcard and this alphabet
 * contains it. Card 96aeacb7: the page browses the ledger by family, and
 * `action=credential` (exact) matches nothing at all.
 */
const ACTION_PREFIX = /^[a-z][a-z0-9_.]{0,127}$/;

/** `outcome` is a two-value enum in the ledger's own CHECK (migration 087). */
const OUTCOMES = new Set(['success', 'denied']);

/**
 * An instant, spelled the ONE way the ledger emits one: a UTC ISO-8601
 * timestamp, which is exactly what `AuditEvent.occurredAt` gives a caller
 * back. Accepting a looser grammar would mean accepting a local-time string
 * whose meaning depends on the reader's offset, on a surface whose entire
 * purpose is to say when something happened.
 */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * An instant, and A DATE THAT EXISTS.
 *
 * Round-1 review, PRODUCTION P2: shape plus `Date.parse` is not enough.
 * `Date.parse('2026-02-30T00:00:00.000Z')` does not fail — V8 ROLLS the day
 * forward and answers 2 March — so a query naming a day the calendar does not
 * have was accepted, bound into a `::timestamptz`, and answered 200 with rows
 * from a different day than the caller asked about. `docs/api.md` said such a
 * value is refused with 400, and it was not.
 *
 * So every component is compared back against the parsed instant. Nothing is
 * normalised on the caller's behalf: a date the calendar does not have is a
 * question that cannot be answered, and answering a nearby one is worse than
 * refusing.
 */
function isInstant(value: string): boolean {
  const parts = INSTANT.exec(value);
  if (!parts) return false;
  const [, y, mo, d, h, mi, s, frac] = parts;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.getUTCFullYear() === Number(y)
    && date.getUTCMonth() === Number(mo) - 1
    && date.getUTCDate() === Number(d)
    && date.getUTCHours() === Number(h)
    && date.getUTCMinutes() === Number(mi)
    && date.getUTCSeconds() === Number(s)
    && date.getUTCMilliseconds() === Number((frac ?? '').padEnd(3, '0') || '0');
}

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const allowed = new Set([
    'limit', 'before', 'action', 'actorPrincipalId', 'resourceType', 'resourceId',
    // Card 96aeacb7. The same handler, the same service and the same
    // `audit:read` route rule; four more ways for it to narrow, because a
    // ledger a person can only page through newest-first is not one they can
    // answer a question with.
    'actionPrefix', 'outcome', 'since', 'until',
  ]);
  const unknown = Object.keys(req.query).find((key) => !allowed.has(key));
  if (unknown) {
    sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown query parameter '${unknown}'`);
    return;
  }
  if (Object.values(req.query).some(Array.isArray)) {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'Duplicate query parameters are not accepted');
    return;
  }
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  const before = req.query.before as string | undefined;
  const actorPrincipalId = req.query.actorPrincipalId as string | undefined;
  const action = req.query.action as string | undefined;
  const actionPrefix = req.query.actionPrefix as string | undefined;
  const outcome = req.query.outcome as string | undefined;
  const since = req.query.since as string | undefined;
  const until = req.query.until as string | undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'limit must be an integer from 1 to 200');
    return;
  }
  if (before && !UUID.test(before)) {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'before must be an audit event UUID');
    return;
  }
  if (actorPrincipalId && !UUID.test(actorPrincipalId)) {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'actorPrincipalId must be a Principal UUID');
    return;
  }
  if (action && !ACTION.test(action)) {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'action is not a valid audit action');
    return;
  }
  if (actionPrefix && !ACTION_PREFIX.test(actionPrefix)) {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'actionPrefix is not a valid audit action prefix');
    return;
  }
  if (outcome && !OUTCOMES.has(outcome)) {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'outcome must be success or denied');
    return;
  }
  if (since && !isInstant(since)) {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'since must be a UTC ISO-8601 instant');
    return;
  }
  if (until && !isInstant(until)) {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'until must be a UTC ISO-8601 instant');
    return;
  }
  // An inverted range is answerable — with nothing — and answering it that way
  // teaches a person that the ledger is empty when what is wrong is the
  // question. The range is half-open [since, until), so since === until is
  // inverted too: it selects nothing by construction.
  if (since && until && Date.parse(since) >= Date.parse(until)) {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'since must be earlier than until');
    return;
  }
  const result = await auditService.list({
    limit,
    before,
    action,
    actionPrefix,
    outcome: outcome as 'success' | 'denied' | undefined,
    since,
    until,
    actorPrincipalId,
    resourceType: req.query.resourceType as string | undefined,
    resourceId: req.query.resourceId as string | undefined,
  });
  res.json({ success: true, ...result, retention: 'indefinite', purgeAvailable: false });
});

export default router;
