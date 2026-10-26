/**
 * KnowledgeWriteAuditService.ts — RB-11 Governor v0 (card `b796067e`), the
 * core's half of the write audit (ratified design C.15, declared change D-8).
 *
 * ── FAIL CLOSED, DELIBERATELY THE OPPOSITE OF THE READ AUDIT ──
 *
 * `KnowledgeAuditService` swallows a failed read-audit insert, and says why:
 * refusing a READ because its row could not be written would turn a full disk
 * into an estate-wide read outage (census finding F10). The design states that
 * a write path must NOT inherit that trade: "fail closed: no row → no dial".
 * So this module THROWS. The executor writes an `intent` row before it dials
 * and refuses the act when that insert fails; it writes an `outcome` row after
 * the source answers and fails the act when that insert fails.
 *
 * ── WHAT A ROW HOLDS ──
 *
 * Ids, enums, digests and the opaque compartment id — the columns migration
 * 147 makes the ONLY representable ones. No title, tag, content or raw ref
 * ever reaches this function: the ref is hashed by the caller of `refSha256`
 * below, inside the core, exactly as the read get row hashes it (§7.7).
 */
import crypto from 'crypto';
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import type { KnowledgeWriteOp } from './KnowledgeArmEvaluator';

export class KnowledgeWriteAuditError extends Error {
  constructor(public readonly cause: unknown) {
    super('the knowledge write audit row could not be written');
    this.name = 'KnowledgeWriteAuditError';
  }
}

export interface KnowledgeWriteAuditRow {
  auditRef: string;
  phase: 'intent' | 'outcome';
  op: KnowledgeWriteOp;
  /** `dialing` on an intent row; the core-authored outcome token otherwise. */
  outcome: string;
  accountPrincipalId?: string | null;
  sourceId?: string | null;
  proposalId?: string | null;
  assertionJti?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  contentSha256?: string | null;
  compartment?: string | null;
  refSha256?: string | null;
}

/** sha256 over the DECODED raw ref, computed by the core and never by the source. */
export function refSha256(rawRef: string): string {
  return crypto.createHash('sha256').update(rawRef, 'utf8').digest('hex');
}

/**
 * Write ONE audit row, or throw `KnowledgeWriteAuditError`. Never swallows.
 *
 * The acting principal and the credential come from the AUTHENTICATED request,
 * never from the act's own input, so a row cannot be made to name someone else.
 */
export async function recordKnowledgeWriteAudit(req: AuthRequest, row: KnowledgeWriteAuditRow): Promise<void> {
  const credentialId = typeof req.credentialId === 'string' ? req.credentialId : null;
  try {
    await pool.query(
      `INSERT INTO knowledge_write_audit
         (audit_ref, phase, op, outcome, acting_principal_id, credential_id, account_principal_id,
          source_id, proposal_id, assertion_jti, task_id, project_id, content_sha256, compartment, ref_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        row.auditRef, row.phase, row.op, row.outcome,
        req.principal?.id ?? null, credentialId, row.accountPrincipalId ?? null,
        row.sourceId ?? null, row.proposalId ?? null, row.assertionJti ?? null,
        row.taskId ?? null, row.projectId ?? null,
        row.contentSha256 ?? null, row.compartment ?? null, row.refSha256 ?? null,
      ],
    );
  } catch (e) {
    throw new KnowledgeWriteAuditError(e);
  }
}

/** The proposing row that binds a preview or commit to its proposer (C.8 step 1). */
export interface KnowledgeProposalBinding {
  actingPrincipalId: string | null;
  sourceId: string | null;
  taskId: string | null;
}

/**
 * Read the `proposed` outcome row of a proposal. The binding is the core's own
 * record — never the caller's claim — so a second principal of the same
 * Account cannot preview or commit a proposal it did not make.
 *
 * Proposal ids are minted by the SOURCE. A source that answered two different
 * proposals with one id would make "the newest row" an arbitrary choice, so
 * the binding exists only when every `proposed` row of the id agrees on who
 * proposed, where and in which task; anything else binds nothing.
 */
export async function readKnowledgeProposalBinding(proposalId: string): Promise<KnowledgeProposalBinding | null> {
  const result = await pool.query(
    `SELECT DISTINCT acting_principal_id, source_id, task_id
       FROM knowledge_write_audit
      WHERE proposal_id = $1 AND op = 'propose' AND phase = 'outcome' AND outcome = 'proposed'`,
    [proposalId],
  );
  if (result.rows.length !== 1) return null;
  const binding = result.rows[0];
  return {
    actingPrincipalId: binding.acting_principal_id === null ? null : String(binding.acting_principal_id),
    sourceId: binding.source_id === null ? null : String(binding.source_id),
    taskId: binding.task_id === null ? null : String(binding.task_id),
  };
}
