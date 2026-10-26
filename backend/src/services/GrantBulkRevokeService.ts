// GrantBulkRevokeService.ts — owner ruling E413 (2026-10-21): ONE audited,
// step-up-bound revoke of grants that change nobody's access, with the
// owner ruling E407 item 3 method: the authorization engine itself evaluates
// every grant's effect (GrantEffectService), never a copy of its rules.
//
// One call, at most 500 ids:
//   - a DRY RUN (the default) answers a verdict per id and writes nothing: the
//     whole transaction, including the simulated removal and its read-back, is
//     rolled back;
//   - a REAL RUN needs a single-use step-up bound to ('grant.bulk_revoke', the
//     id-set hash) and runs in ONE transaction that holds the grants table
//     against concurrent writers: every id is re-checked live, ONLY the ids
//     still redundant are removed, each through GrantService.remove (its own
//     grant.revoke audit row and acl_changed event), then every question the
//     removed grants could influence is asked again and ANY difference from
//     the answers before rolls the whole batch back. One grant.bulk_revoke
//     summary audit row is written per real call, rolled back or not, and the
//     step-up is spent either way.
// Assignment-carried grants are never removed here (GRANT_CARRIES_ASSIGNMENT).
import crypto from 'crypto';
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { grantService, GrantError } from './GrantService';
import { grantEffectService, type GrantAnswers, type GrantQuestions, type GrantTuple } from './GrantEffectService';
import { stepUpRequiredError, stepUpService } from './StepUpService';

export const BULK_REVOKE_MAX_IDS = 500;
export const BULK_REVOKE_STEP_UP_ACTION = 'grant.bulk_revoke';
export const BULK_REVOKE_VERDICTS = ['redundant', 'effective', 'unevaluable', 'assignment', 'missing', 'expired'] as const;
export type BulkRevokeVerdict = (typeof BULK_REVOKE_VERDICTS)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id-set binding a step-up names: the sha256 of the lower-cased ids,
 * sorted and joined by commas, prefixed with the format. Every call answers
 * it, and the dry run also answers the hash of exactly the ids it found
 * redundant, so a client never computes it.
 */
export function bulkRevokeIdSetHash(ids: readonly string[]): string {
  const canonical = [...ids].map((id) => id.toLowerCase()).sort().join(',');
  return `grant-ids-v1:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

export interface BulkRevokeResult {
  id: string;
  verdict: BulkRevokeVerdict;
  reason: string;
  removed: boolean;
  grant?: { granteeId: string; resourceType: string; resourceId: string | null; verb: string };
}

export interface BulkRevokeAnswer {
  dryRun: boolean;
  idSetHash: string;
  redundantIdSetHash: string | null;
  results: BulkRevokeResult[];
  removed: number;
  skipped: Record<BulkRevokeVerdict, number>;
  readBack: { principals: number; checks: number; differences: number };
  rolledBack: boolean;
  /** Dry run only: the simulated batch found a difference, so the same real
   * call would roll back. */
  wouldRollBack?: boolean;
  summaryAuditId?: string;
}

export interface BulkRevokeInput {
  ids: unknown;
  dryRun?: unknown;
  stepUpToken?: unknown;
  principalId: string;
  actor: AuditActor;
}

const refuse = (status: number, code: string, message: string, field?: string) => new GrantError(status, code, message, field);

export class GrantBulkRevokeService {
  /** Validates the body. Returns the canonical (lower-case) ids in request order. */
  parse(input: BulkRevokeInput): { ids: string[]; dryRun: boolean; stepUpToken: string | null } {
    if (!Array.isArray(input.ids) || input.ids.length === 0) {
      throw refuse(400, 'BULK_REVOKE_IDS_REQUIRED', 'ids must be a non-empty array of grant ids', 'ids');
    }
    if (input.ids.length > BULK_REVOKE_MAX_IDS) {
      throw refuse(400, 'BULK_REVOKE_TOO_MANY', `at most ${BULK_REVOKE_MAX_IDS} grant ids per call; split the list into batches`, 'ids');
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const raw of input.ids) {
      if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
        throw refuse(400, 'INVALID_GRANT_ID', 'every id must be a full grant UUID', 'ids');
      }
      const id = raw.toLowerCase();
      if (seen.has(id)) throw refuse(400, 'BULK_REVOKE_DUPLICATE_ID', `grant id ${id} appears more than once`, 'ids');
      seen.add(id);
      ids.push(id);
    }
    if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
      throw refuse(400, 'INVALID_FIELD', 'dryRun must be true or false (default true)', 'dryRun');
    }
    const dryRun = input.dryRun !== false;
    if (input.stepUpToken !== undefined && input.stepUpToken !== null && typeof input.stepUpToken !== 'string') {
      throw refuse(400, 'INVALID_FIELD', 'stepUpToken must be a string', 'stepUpToken');
    }
    const stepUpToken = typeof input.stepUpToken === 'string' && input.stepUpToken ? input.stepUpToken : null;
    return { ids, dryRun, stepUpToken };
  }

  /**
   * The read-back: every question each removed grant could influence, asked
   * again in the state after the batch, compared with the answers taken
   * before anything was removed. A seam of its own so the live suite can
   * prove that ONE difference rolls back the whole batch.
   */
  async readBack(questions: GrantQuestions[], baseline: GrantAnswers, client: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> })
    : Promise<{ checks: number; differences: number }> {
    const now: GrantAnswers = {};
    for (const set of questions) Object.assign(now, await grantEffectService.answers(set, client));
    const differences = grantEffectService.diff(baseline, now).length;
    return { checks: Object.keys(baseline).length, differences };
  }

  async run(input: BulkRevokeInput): Promise<BulkRevokeAnswer> {
    const { ids, dryRun, stepUpToken } = this.parse(input);
    const idSetHash = bulkRevokeIdSetHash(ids);
    if (!dryRun && !stepUpToken) {
      throw await stepUpRequiredError(input.principalId, BULK_REVOKE_STEP_UP_ACTION, idSetHash,
        'A real bulk revoke needs a single-use step-up bound to (grant.bulk_revoke, this id set)');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let stepUp: { tokenId: string; method: string } | null = null;
      if (!dryRun) {
        // No other writer may add, edit or remove a grant while this batch is
        // decided and read back; a busy table refuses rather than waits long.
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query('LOCK TABLE grants IN SHARE ROW EXCLUSIVE MODE');
        // Burned in this transaction: a refused act never spends it.
        stepUp = await stepUpService.consume(client, {
          token: stepUpToken!, principalId: input.principalId, action: BULK_REVOKE_STEP_UP_ACTION, targetId: idSetHash,
        });
      }

      const rows = new Map<string, any>((await client.query(
        `SELECT id::text, grantee_type, grantee_id::text, resource_type, resource_id::text, verb, provenance,
                (expires_at IS NOT NULL AND expires_at <= NOW()) AS expired
           FROM grants WHERE id = ANY($1::uuid[])`, [ids])).rows.map((row) => [row.id, row]));

      const results: BulkRevokeResult[] = [];
      const redundant: Array<{ id: string; questions: GrantQuestions; before: GrantAnswers; granteeId: string }> = [];
      for (const id of ids) {
        const row = rows.get(id);
        if (!row) { results.push({ id, verdict: 'missing', reason: 'no such grant', removed: false }); continue; }
        const grant = { granteeId: row.grantee_id, resourceType: row.resource_type, resourceId: row.resource_id, verb: row.verb };
        if (row.expired) {
          results.push({ id, verdict: 'expired', reason: 'expired: it confers nothing and is not revoked here', removed: false, grant });
          continue;
        }
        if (row.provenance) {
          results.push({ id, verdict: 'assignment', removed: false, grant,
            reason: "carries an assignment's access (GRANT_CARRIES_ASSIGNMENT): unassign the Task or revoke the Warrant" });
          continue;
        }
        const tuple: GrantTuple & { id: string } = { id, granteeType: row.grantee_type, ...grant };
        const check = await grantEffectService.checkExisting(tuple, client);
        results.push({ id, verdict: check.verdict, reason: check.reason, removed: false, grant });
        if (check.verdict === 'redundant') {
          redundant.push({ id, questions: check.questions!, before: check.before!, granteeId: row.grantee_id });
        }
      }

      // The batch, inside a savepoint: removed through the product's own
      // revoke path, then read back against the answers before ANY removal.
      await client.query('SAVEPOINT bulk_revoke_batch');
      const baseline: GrantAnswers = {};
      for (const item of redundant) Object.assign(baseline, item.before);
      if (dryRun) {
        // The simulation removes the rows only: no revoke audit row and no
        // feed event is written (and so no feed lock is held), and the whole
        // transaction is rolled back below.
        if (redundant.length > 0) await client.query('DELETE FROM grants WHERE id = ANY($1::uuid[])', [redundant.map((item) => item.id)]);
      } else {
        for (const item of redundant) {
          await grantService.remove(item.id, input.actor, client, { bulkRevoke: { idSetHash, rule: 'E413' } });
        }
      }
      const readBack = redundant.length > 0
        ? await this.readBack(redundant.map((item) => item.questions), baseline, client)
        : { checks: 0, differences: 0 };
      const differs = readBack.differences > 0;
      const keep = !dryRun && !differs;
      if (keep) await client.query('RELEASE SAVEPOINT bulk_revoke_batch');
      else await client.query('ROLLBACK TO SAVEPOINT bulk_revoke_batch');
      if (keep) for (const result of results) if (result.verdict === 'redundant') result.removed = true;

      const removed = keep ? redundant.length : 0;
      const skipped = Object.fromEntries(BULK_REVOKE_VERDICTS.map((verdict) => [verdict,
        results.filter((result) => result.verdict === verdict && !result.removed).length])) as Record<BulkRevokeVerdict, number>;
      const answer: BulkRevokeAnswer = {
        dryRun, idSetHash,
        redundantIdSetHash: redundant.length > 0 ? bulkRevokeIdSetHash(redundant.map((item) => item.id)) : null,
        results, removed, skipped,
        readBack: { principals: new Set(redundant.map((item) => item.granteeId)).size, ...readBack },
        rolledBack: !dryRun && differs,
        ...(dryRun ? { wouldRollBack: differs } : {}),
      };

      if (dryRun) {
        await client.query('ROLLBACK');
        return answer;
      }
      const summary = await auditService.record({
        action: 'grant.bulk_revoke', actor: input.actor, resourceType: 'grant', resourceId: null,
        metadata: {
          idSetHash, requested: ids.length, removed, skipped, readBack: answer.readBack, rolledBack: answer.rolledBack,
          stepUp: stepUp ? { tokenId: stepUp.tokenId, method: stepUp.method } : null, rule: 'E413',
        },
      }, client);
      answer.summaryAuditId = summary.id;
      await client.query('COMMIT');
      return answer;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

export const grantBulkRevokeService = new GrantBulkRevokeService();
