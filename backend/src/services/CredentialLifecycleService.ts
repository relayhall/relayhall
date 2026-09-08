// CredentialLifecycleService.ts — reveal and terminate (RH-P3.AZ-S3, card
// 25e5fb92; AUTHZ design 4d961e37 §7.1/§7.2/§7.6, A17.10; T16/T20/T24/T30).
//
// REVEAL (AZ-20): re-reveal of a stored secret is gated by CREDENTIAL
// LINEAGE — a bearer caller may reveal only credentials of principals in
// its OWN DESCENDANT subtree (the minting lineage); an authenticated LOGIN
// SESSION (root or the owning Account) reveals under a SINGLE-USE step-up
// token bound to exactly this reveal (§7.6, T16). Graced, revoked and
// expired credentials are never revealable; reveals are rate-limited with
// an audited alert threshold; the decrypt is verified against the stored
// hash before anything returns (T30); every reveal is audited with the
// layer and the step-up evidence.
//
// TERMINATE (A17.10, T24): irreversible offboarding — the target AND its
// whole descendant subtree get the durable `terminated` status, every
// credential in the subtree is revoked permanently, re-enable and
// issuance refuse terminated principals (096 triggers back this), and the
// act is idempotent. Rows are kept for provenance.
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { clearHomePointersForPrincipals } from './HomeGroupService';
import { stepUpService } from './StepUpService';
import { decryptCredentialSecret, sha256Hex, CredentialCryptoError } from '../utils/credentialCrypto';
import { bearerLayerFor } from '../utils/bearerLayers';
import { auditChainFor } from '../utils/auditChain';
import { invalidateApprovalsForCredentials } from '../utils/approvalInvalidation';
import { principalService } from './PrincipalService';

export class CredentialLifecycleError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'CredentialLifecycleError';
  }
}

const err = (status: number, code: string, message: string) =>
  new CredentialLifecycleError(status, code, message);

function parseStoredScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const REVEAL_RATE_LIMIT = 5;               // reveals per principal…
const REVEAL_RATE_WINDOW_MS = 60 * 60 * 1000; // …per hour, alert past it.
const revealWindows = new Map<string, number[]>();

function revealRateExceeded(callerKey: string): boolean {
  const now = Date.now();
  const hits = (revealWindows.get(callerKey) ?? []).filter((t) => now - t < REVEAL_RATE_WINDOW_MS);
  hits.push(now);
  revealWindows.set(callerKey, hits);
  return hits.length > REVEAL_RATE_LIMIT;
}

export interface RevealCaller {
  principalId: string;
  handle: string;
  isRootSession: boolean;
  /** true when the caller authenticated with a bearer credential. */
  viaBearer: boolean;
  /** The middleware-computed EFFECTIVE scope set of the presenting
   * credential (acting identity ∩ presenting credential ∩ chain — §5.2
   * rule 1). The revealed credential's authority must lie within it
   * (AZ-20, T20, review 94aad5aa B3). */
  presentingScopes?: string[] | null;
  stepUpToken?: string | null;
}

export class CredentialLifecycleService {
  /** Is `candidate` inside `ancestor`'s descendant subtree (strictly below it)? */
  async isDescendant(ancestorId: string, candidateId: string): Promise<boolean> {
    if (ancestorId === candidateId) return false;
    const result = await pool.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_principal_id FROM principals WHERE id = $2
         UNION ALL
         SELECT p.id, p.parent_principal_id FROM principals p
           JOIN up ON p.id = up.parent_principal_id
       )
       SELECT 1 AS hit FROM up WHERE id = $1 AND id <> $2 LIMIT 1`,
      [ancestorId, candidateId],
    );
    return result.rows.length > 0;
  }

  async reveal(credentialId: string, caller: RevealCaller, actor: AuditActor): Promise<{ token: string }> {
    const client = await pool.connect();
    // §5.2 rule 8 (review 731415a7 B4): denial rows carry the chain of the
    // AFFECTED credential's principal when the target resolved, falling
    // back to the caller when it never did.
    let affectedPrincipalId: string | null = null;
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT c.*, p.kind AS principal_kind, p.parent_principal_id, p.legacy_identity, p.status AS principal_status
           FROM principal_credentials c JOIN principals p ON p.id = c.principal_id
          WHERE c.id = $1 FOR UPDATE OF c`,
        [credentialId],
      );
      const row = result.rows[0];
      if (!row) throw err(404, 'CREDENTIAL_NOT_FOUND', 'No such credential');
      affectedPrincipalId = String(row.principal_id);

      // ── AUTHORIZATION AND CONCEALMENT FIRST (review 2fcd548c B2): a
      // caller outside the lineage learns NOTHING — not even that the
      // credential exists, let alone its lifecycle state. Every
      // state-specific response below is reachable only after this gate.
      let stepUpEvidence: { tokenId: string; method: string } | null = null;
      if (caller.viaBearer || !caller.isRootSession) {
        const inSubtree = await this.isDescendant(caller.principalId, String(row.principal_id));
        if (!inSubtree) {
          // §9.1 self-scope arm: conceal, never confirm.
          throw err(404, 'CREDENTIAL_NOT_FOUND', 'No such credential');
        }
      }
      if (!caller.viaBearer) {
        // Session path (root or owning Account): SINGLE-USE step-up bound
        // to exactly this reveal (T16), consumed before any state detail.
        if (!caller.stepUpToken) {
          throw err(403, 'STEP_UP_REQUIRED', 'Session reveals require a step-up token bound to this credential (§7.6)');
        }
        stepUpEvidence = await stepUpService.consume(client, {
          token: caller.stepUpToken,
          principalId: caller.principalId,
          action: 'credential.reveal',
          targetId: credentialId,
        });
      }

      if (row.revoked_at) throw err(409, 'CREDENTIAL_REVOKED', 'A revoked credential is never revealable');
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        throw err(409, 'CREDENTIAL_EXPIRED', 'An expired credential is never revealable');
      }
      if (row.grace_until) {
        throw err(409, 'CREDENTIAL_GRACED', 'A graced predecessor is never revealable (§7.3)');
      }
      if (!row.secret_ciphertext) {
        throw err(409, 'CREDENTIAL_NOT_REVEALABLE', 'This credential predates encrypted storage and cannot be re-revealed (issue or rotate to a new one)');
      }
      if (row.legacy_identity) {
        throw err(409, 'LEGACY_FROZEN', 'Legacy identities are frozen out of the reveal machinery (§10, T37)');
      }
      if (caller.viaBearer) {
        // AZ-20/T20: the revealed authority must lie within (acting
        // identity ∩ PRESENTING credential) — a narrow credential never
        // discloses a broader descendant secret, even inside the lineage.
        const targetScopes = parseStoredScopes(row.scopes);
        const ceiling = caller.presentingScopes ?? [];
        const exceeds = targetScopes.filter((scope) => !ceiling.includes(scope));
        if (exceeds.length > 0) {
          throw err(403, 'REVEAL_EXCEEDS_PRESENTING',
            'The revealed credential authority exceeds the presenting credential (AZ-20): ' + exceeds.join(', '));
        }
      }

      if (revealRateExceeded(caller.principalId)) {
        await auditService.record({
          action: 'credential.reveal_rate_alert', actor, outcome: 'denied',
          resourceType: 'credential', resourceId: credentialId,
          metadata: { threshold: REVEAL_RATE_LIMIT, windowMs: REVEAL_RATE_WINDOW_MS },
        }, client);
        await client.query('COMMIT'); // the alert row must survive the refusal
        throw err(429, 'REVEAL_RATE_LIMITED', 'Reveal rate threshold exceeded — alert recorded');
      }

      // §7.2 (review e5e437a0 B1): the ciphertext holds the FULL token; we
      // verify it against the full-token hash and return it verbatim.
      const token = decryptCredentialSecret(String(row.secret_ciphertext), String(row.encryption_key_id), String(row.id));
      if (sha256Hex(token) !== String(row.secret_hash)) {
        throw err(500, 'CREDENTIAL_INTEGRITY_FAILURE', 'Decrypted token does not match its stored hash (T30) — refusing to reveal');
      }
      await client.query('UPDATE principal_credentials SET reveal_count = reveal_count + 1 WHERE id = $1', [credentialId]);
      // The classification and its ENUMERATION are `utils/bearerLayers`, so a
      // consumer that must reason about every bearer kind reads production
      // rather than keeping its own copy (round-4b review `252fe7e6` B1).
      const layer = bearerLayerFor(row.principal_kind, row.parent_principal_id);
      await auditService.record({
        action: 'credential.reveal', actor,
        resourceType: 'credential', resourceId: credentialId,
        metadata: {
          principalId: String(row.principal_id),
          layer,
          viaBearer: caller.viaBearer,
          stepUp: stepUpEvidence,
          revealCount: Number(row.reveal_count) + 1,
          // §5.2 rule 8: the FULL resolved chain rides every reveal.
          chain: await auditChainFor(client, String(row.principal_id)),
        },
      }, client);
      await client.query('COMMIT');
      return { token };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      // §5.2 rule 8 (review 6c7d68d2 B3): reveal REFUSALS are durable
      // audited denials with reason + full chain — written on the pool so
      // the rollback cannot erase them. Success and rate-alert rows are
      // already committed above.
      const refusalCode = (e instanceof CredentialLifecycleError || e instanceof CredentialCryptoError
        || (e instanceof Error && e.name === 'StepUpError'))
        ? (e as { code?: string }).code ?? 'UNKNOWN'
        : null;
      if (refusalCode && refusalCode !== 'REVEAL_RATE_LIMITED') {
        await auditService.record({
          action: 'credential.reveal', actor, outcome: 'denied',
          resourceType: 'credential', resourceId: credentialId,
          metadata: {
            refusal: refusalCode,
            viaBearer: caller.viaBearer,
            // The AFFECTED chain when the target resolved; the caller's
            // otherwise. Concealment lives in the HTTP response, never in
            // the server-side ledger.
            chain: await auditChainFor(pool, affectedPrincipalId ?? caller.principalId),
          },
        }).catch(() => undefined);
      }
      if (e instanceof CredentialCryptoError) {
        throw err(500, e.code, e.message);
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /** Terminate a principal and its whole descendant subtree (A17.10, T24). */
  async terminate(principalId: string, actor: AuditActor): Promise<{ terminated: string[]; revokedCredentials: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const subtree = await client.query(
        `WITH RECURSIVE subtree AS (
           SELECT id FROM principals WHERE id = $1
           UNION ALL
           SELECT p.id FROM principals p JOIN subtree s ON p.parent_principal_id = s.id
         )
         SELECT id FROM subtree`,
        [principalId],
      );
      if (subtree.rows.length === 0) throw err(404, 'PRINCIPAL_NOT_FOUND', 'No such principal');
      const ids = subtree.rows.map((row) => String(row.id));
      const flipped = await client.query(
        `UPDATE principals
            SET status = 'terminated', terminated_at = COALESCE(terminated_at, NOW())
          WHERE id = ANY($1::uuid[]) AND status <> 'terminated'
          RETURNING id`,
        [ids],
      );
      const revoked = await client.query(
        `UPDATE principal_credentials
            SET revoked_at = COALESCE(revoked_at, NOW()),
                metadata = jsonb_set(metadata, '{revoke_reason}', to_jsonb('principal terminated (A17.10)'::text))
          WHERE principal_id = ANY($1::uuid[]) AND revoked_at IS NULL
          RETURNING id`,
        [ids],
      );
      // AZ-31c (AZ-S4): every Approval bound to a credential this
      // termination revoked lapses in the same transaction.
      await invalidateApprovalsForCredentials(
        client, revoked.rows.map((row) => String(row.id)), 'revoked', actor,
      );
      // RH-LENSES-b, build obligation B-L7b: the home-pointer clear, wired
      // into offboarding. Termination FLIPS `principals.status` rather than
      // deleting the row, so `account_home_groups`' ON DELETE CASCADE never
      // fires and a terminated Account's pointer would sit there holding
      // ON DELETE RESTRICT over a Group nobody can now delete without
      // hunting for who, exactly, still points at it. It goes with the
      // termination, in THIS transaction, and each clear is audited.
      const homePointersCleared = await clearHomePointersForPrincipals(
        client, ids, actor, 'principal.terminate');
      await auditService.record({
        action: 'principal.terminate', actor,
        resourceType: 'principal', resourceId: principalId,
        metadata: {
          subtree: ids,
          newlyTerminated: flipped.rows.map((row) => String(row.id)),
          revokedCredentials: revoked.rows.length,
          homePointersCleared,
          // §5.2 rule 8: the FULL resolved chain of the terminated root.
          chain: await auditChainFor(client, principalId),
        },
      }, client);
      await client.query('COMMIT');
      // A17.10/T24 (review ab857740 B5): a cached active row must not let
      // an already-authenticated login JWT outlive the termination.
      principalService.invalidatePrincipals(ids);
      return { terminated: ids, revokedCredentials: revoked.rows.length };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

export const credentialLifecycleService = new CredentialLifecycleService();
