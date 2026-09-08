// McpBootstrapService.ts — the fail-closed bootstrap record (RH-P3.C4
// subtask [1]; strategy 4e40f06f §2.10; owner decision D2, run packet
// 3e6ec75a §5[1]; migration 102).
//
// §2.10 ratified item C2: "work-plane tool calls from a session that has not
// bootstrapped return 'bootstrap first' with the index inline — one middleware
// check that kills the silent-skip hole (only Claude Code has a deterministic
// bootstrap hook; every other harness relies on instruction files the model
// can skip)."
//
// This module owns the "has bootstrapped" fact and nothing else. The decision
// that consumes it lives in exactly one place — `mcp/bootstrapGate` — and the
// act that writes it lives in exactly one place: the bootstrap verb's session
// altitude in `mcp/registry`.
//
// KEYED ON THE CREDENTIAL, NOT ON A SESSION. The MCP surface mints and
// consumes no session identifier (de73f9f8 §1.3 as amended by S-A6), so there
// is no session id to key on and inventing one would contradict the posture
// this candidate also gates. The credential is what identity rides on.
import { pool } from '../db/connection';

/**
 * How long a bootstrap stays live.
 *
 * Twelve hours: longer than any single agent session, so a long autonomous run
 * never has to re-bootstrap mid-flight and discover the refusal as a surprise;
 * short enough that a credential sitting in a harness config file cannot stay
 * bootstrapped across days without ever re-reading its working context. It is
 * a constant rather than a deployment variable deliberately — a TTL that a
 * compose file can forget to forward is a control that silently stops holding
 * (the C3 lesson, run packet 3e6ec75a trap T2).
 */
export const BOOTSTRAP_TTL_MS = 12 * 60 * 60 * 1000;

export interface BootstrapRecord {
  credentialId: string;
  bootstrappedAt: string;
  expiresAt: string;
}

/**
 * Record that this credential has bootstrapped, and return the record.
 *
 * An upsert, so re-bootstrapping REFRESHES rather than accumulating rows: a
 * harness that re-reads its working context should not be penalised for it,
 * and a second row would make "is it live" ambiguous.
 */
export async function recordBootstrap(
  credentialId: string,
  now: Date = new Date(),
): Promise<BootstrapRecord> {
  const expiresAt = new Date(now.getTime() + BOOTSTRAP_TTL_MS);
  const result = await pool.query(
    `INSERT INTO mcp_bootstrap_records (credential_id, bootstrapped_at, expires_at)
          VALUES ($1, $2, $3)
     ON CONFLICT (credential_id) DO UPDATE
             SET bootstrapped_at = EXCLUDED.bootstrapped_at,
                 expires_at      = EXCLUDED.expires_at
       RETURNING credential_id, bootstrapped_at, expires_at`,
    [credentialId, now.toISOString(), expiresAt.toISOString()],
  );
  const row = result.rows[0];
  return {
    credentialId: String(row.credential_id),
    bootstrappedAt: new Date(row.bootstrapped_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/**
 * Has this credential bootstrapped, and is that still live?
 *
 * EXPIRY IS EVALUATED IN THE QUERY, against the database's clock — the same
 * clock that wrote `expires_at`. Comparing a stored timestamp to the Node
 * process's own clock would make the gate's verdict depend on the drift
 * between two machines, which is exactly the kind of "usually right" that a
 * fail-closed control cannot afford.
 *
 * A LOOKUP FAILURE IS NOT A "NO" WITH A SHRUG — it propagates. The caller
 * (`mcp/bootstrapGate`) turns any failure into a refusal, so the surface fails
 * closed; swallowing it here and returning `false` would look identical from
 * the outside today and would silently become fail-open the moment someone
 * inverted a default.
 */
export async function isBootstrapLive(credentialId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM mcp_bootstrap_records
      WHERE credential_id = $1 AND expires_at > now()`,
    [credentialId],
  );
  return result.rowCount === 1;
}

/**
 * Drop lapsed rows. Nothing depends on this for correctness — `isBootstrapLive`
 * already refuses an expired row — it exists so the table stays proportional to
 * live credentials rather than to every credential that ever bootstrapped.
 */
export async function purgeExpiredBootstraps(): Promise<number> {
  const result = await pool.query('DELETE FROM mcp_bootstrap_records WHERE expires_at <= now()');
  return result.rowCount ?? 0;
}

/** Test seam: forget one credential's bootstrap without waiting out its TTL. */
export async function clearBootstrap(credentialId: string): Promise<void> {
  await pool.query('DELETE FROM mcp_bootstrap_records WHERE credential_id = $1', [credentialId]);
}
