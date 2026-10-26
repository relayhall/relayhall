// decisionEvidence.ts — ONE step-up per decision (change-request design
// section 5.3, ratified by owner ruling E325 with section 12 Q6 (a); card
// 502fb19e).
//
// A change decision consumes ONE single-use token bound to (`approval.decide`,
// approval id) inside the decide transaction. The executor that applies the
// approved change in that transaction does NOT consume a second, per-act token:
// it receives the decision's token as pre-consumed EVIDENCE and accepts it only
// when, on the decide client itself,
//   - the step_up_tokens row `tokenId` names the decider, the action
//     `approval.decide` and the approval as its target, and is consumed; and
//   - the approval row is held by this transaction and is still pending.
// Anything else is STEP_UP_REQUIRED, so a direct door cannot pass forged
// evidence, and evidence for another approval, another decider or another act
// is worthless. The direct doors keep their own step-up bindings unchanged.

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const DECISION_STEP_UP_ACTION = 'approval.decide';

export interface DecisionEvidence {
  tokenId: string;
  method: string;
  approvalId: string;
  deciderPrincipalId: string;
}

export class DecisionEvidenceError extends Error {
  readonly status = 403;
  readonly code = 'STEP_UP_REQUIRED';
  constructor(message: string) {
    super(message);
    this.name = 'DecisionEvidenceError';
  }
}

export async function assertDecisionEvidence(client: Queryable, evidence: DecisionEvidence | null | undefined): Promise<void> {
  if (!evidence || !evidence.tokenId || !evidence.approvalId || !evidence.deciderPrincipalId) {
    throw new DecisionEvidenceError('this act applies an approved change only with the decision\'s own consumed step-up as evidence');
  }
  const token = await client.query(
    `SELECT 1 FROM step_up_tokens
      WHERE id::text = $1 AND principal_id = $2 AND action = $3 AND target_id = $4 AND consumed_at IS NOT NULL`,
    [evidence.tokenId, evidence.deciderPrincipalId, DECISION_STEP_UP_ACTION, evidence.approvalId]);
  if (token.rows.length !== 1) {
    throw new DecisionEvidenceError('the evidence names no consumed approval.decide step-up of this decider for this approval');
  }
  // FOR UPDATE on a row this transaction already holds returns at once; on a
  // row it does not hold it waits for the holder, which then has decided it.
  const approval = await client.query(
    `SELECT status FROM approvals WHERE id = $1 FOR UPDATE`, [evidence.approvalId]);
  if (approval.rows.length !== 1 || approval.rows[0].status !== 'pending') {
    throw new DecisionEvidenceError('the evidence names an approval that is not pending in this decision');
  }
}
