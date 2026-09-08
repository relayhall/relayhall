/**
 * KnowledgeAuditService.ts — RH-KW1 candidate C (card `0b4b779b`).
 *
 * §7.7's forensic record, and the two DIFFERENT shapes it takes.
 *
 * ── WHY THE SEARCH ROW HOLDS THE QUERY TEXT ──
 *
 * §7.7: "`q` is the first caller-supplied text RelayHall transmits OUTWARD; a
 * prompt-injected caller can exfiltrate a secret by querying it. … the search
 * audit row stores caller, credential, the full fan-out set with per-source
 * outcomes, and the FULL QUERY TEXT (the field an exfiltration rides — a hash
 * defends nothing and destroys the evidence)."
 *
 * That sentence is the whole justification for storing caller text at rest,
 * and it is deliberately narrow: the text is stored because the forensic
 * question — what went where — cannot be answered without it. §7.7 also names
 * the owner-plane flag that MAY reduce capture to sha256+length "where policy
 * demands"; §12.2 confirms the default is full capture, so v1 ships the
 * default and no flag. Adding the flag without its ratified description would
 * be a policy seat with no policy behind it.
 *
 * ── WHY THE GET ROW HOLDS A HASH ──
 *
 * §7.7: "the get audit row stores source, compartment, and a sha256 CORE
 * computes over the decoded raw ref (raw refs are source paths — sensitive;
 * core hashes rather than stores them)". CORE computes it — never the source,
 * and never the caller — so the row cannot be made to agree with a digest
 * someone else chose. Migration 116 backs the rule with a CHECK that refuses
 * anything but 64 hex characters, so a future writer cannot put a path here.
 *
 * ── WHY A FAILED AUDIT WRITE DOES NOT FAIL THE REQUEST ──
 *
 * It does not, and that is a deliberate, stated trade rather than an
 * oversight. The alternative — refusing a read because its audit row could
 * not be written — turns a full disk into an estate-wide outage of a READ
 * path. §7.7 names the row as "item 2's enumerated security-control
 * survivable state", i.e. the record that survives the request, not a gate on
 * it. The failure is logged through the shipped secret-safe logger with an
 * error id, so the gap is visible to an operator.
 */
import crypto from 'crypto';
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { logCaughtFailure } from '../utils/secretSafeLog';
import type { KnowledgeContentKind } from '../utils/serviceDescriptor';

/** One source's line in the fan-out record. Core-authored values only. */
export interface KnowledgeFanoutAuditEntry {
  sourceId: string;
  sourceSlug: string;
  /** The coverage outcome, or `skipped`, exactly as the caller saw it. */
  outcome: string;
  /** Set only for a source that was actually dialed with an assertion. */
  assertionJti?: string;
  /** How many results survived validation. Never the results themselves. */
  resultCount?: number;
  /** Set when core dropped at least one result for validity. */
  invalidResults?: boolean;
  /** Set when core dropped results for volume. */
  truncatedResults?: boolean;
}

export interface KnowledgeSearchAuditInput {
  /**
   * Minted by the CALLER, so the response carries the same identifier whatever
   * the write below does. Absent, one is minted here — the older shape, kept
   * so the get path and any future caller need not care.
   */
  auditRef?: string;
  queryText: string;
  kinds: readonly KnowledgeContentKind[];
  fanout: readonly KnowledgeFanoutAuditEntry[];
}

/** The opaque handle a caller may quote back to an operator (§7.3 `auditRef`). */
export function newKnowledgeAuditRef(): string {
  return `ka_${crypto.randomBytes(16).toString('hex')}`;
}

function callerPrincipalId(req: AuthRequest): string | null {
  return req.principal?.id ?? null;
}

function callerCredentialId(req: AuthRequest): string | null {
  const credentialId = (req as { credentialId?: unknown }).credentialId;
  return typeof credentialId === 'string' ? credentialId : null;
}

/**
 * Write the search row and return its `auditRef`.
 *
 * The ref is returned even if the write failed: it is the identifier the
 * response carries, and a caller quoting a ref an operator cannot find is a
 * better failure than a caller with no ref at all — the operator then knows
 * to look for the logged error id.
 */
export async function recordKnowledgeSearch(
  req: AuthRequest,
  input: KnowledgeSearchAuditInput,
): Promise<string> {
  const auditRef = input.auditRef ?? newKnowledgeAuditRef();
  try {
    await pool.query(
      `INSERT INTO knowledge_search_audit
         (audit_ref, caller_principal_id, caller_credential_id, query_text, kinds, fanout)
       VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb)`,
      [
        auditRef,
        callerPrincipalId(req),
        callerCredentialId(req),
        input.queryText,
        [...input.kinds],
        JSON.stringify(input.fanout),
      ],
    );
  } catch (e) {
    logCaughtFailure('record knowledge search audit', e);
  }
  return auditRef;
}

export interface KnowledgeGetAuditInput {
  sourceId: string;
  compartment: string;
  /** The DECODED raw ref. Hashed here and never stored or logged. */
  rawRef: string;
  /** The core-authored outcome token. */
  outcome: string;
}

/** §7.7's get row: source, compartment, and a CORE-computed ref digest. */
export async function recordKnowledgeGet(
  req: AuthRequest,
  input: KnowledgeGetAuditInput,
): Promise<void> {
  const refSha256 = crypto.createHash('sha256').update(input.rawRef, 'utf8').digest('hex');
  try {
    await pool.query(
      `INSERT INTO knowledge_get_audit
         (caller_principal_id, caller_credential_id, source_id, compartment, ref_sha256, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        callerPrincipalId(req),
        callerCredentialId(req),
        input.sourceId,
        input.compartment,
        refSha256,
        input.outcome,
      ],
    );
  } catch (e) {
    logCaughtFailure('record knowledge get audit', e);
  }
}
