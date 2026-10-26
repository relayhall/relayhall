/**
 * The chain guard G(Task) and the `verifier-agent` arm as SQL (universal
 * harness connector design, section 6.8; owner ruling E462, slice S4b). Pure
 * text, no imports: the authorization predicate and the verification-mode
 * service read the SAME fragments. See services/VerificationModes.ts for the
 * rules each fragment encodes.
 */
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/**
 * G(Task) as ONE SQL subquery yielding `id`, for the Task whose id is the SQL
 * expression `taskId` (correlated: an outer column such as `t.id` is fine).
 * `extraSeeds`, when given, is a SQL expression of type uuid[] added to the
 * seeds (the finishing actor at finish time).
 */
export function guardedPrincipalsSql(taskId: string, extraSeeds?: string): string {
  return `(WITH RECURSIVE g_seed(id) AS (
      SELECT g_svc.principal_id FROM tasks g_t JOIN services g_svc ON g_svc.id = g_t.execution_service_id
       WHERE g_t.id = ${taskId}
      UNION SELECT g_t.owner_principal_id FROM tasks g_t WHERE g_t.id = ${taskId}
      UNION SELECT CASE WHEN g_e.metadata->>'assigneePrincipalId' ~ '${UUID_PATTERN}'
                        THEN (g_e.metadata->>'assigneePrincipalId')::uuid END
              FROM task_stream_entries g_e WHERE g_e.task_id = ${taskId} AND g_e.event_type = 'task.claimed'
      UNION SELECT g_e.author_principal_id FROM task_stream_entries g_e
             WHERE g_e.task_id = ${taskId} AND g_e.event_type = 'handover.finish'
      UNION SELECT g_a.id FROM principals g_a
             WHERE g_a.kind = 'agent' AND g_a.bound_task_id = ${taskId} AND g_a.bound_task_role = 'implementer'
      ${extraSeeds ? `UNION SELECT unnest(${extraSeeds})` : ''}
    ), g_up(id) AS (
      SELECT id FROM g_seed WHERE id IS NOT NULL
      UNION SELECT g_p.parent_principal_id FROM principals g_p JOIN g_up ON g_p.id = g_up.id
             WHERE g_p.parent_principal_id IS NOT NULL
    ), g_down(id) AS (
      SELECT id FROM g_seed WHERE id IS NOT NULL
      UNION SELECT g_c.id FROM principals g_c JOIN g_down ON g_c.parent_principal_id = g_down.id
    )
    SELECT g_m.id FROM (SELECT id FROM g_up UNION SELECT id FROM g_down) g_ids
      JOIN principals g_m ON g_m.id = g_ids.id
     WHERE g_m.kind <> 'human')`;
}

/** The exact Verifier is not a person and is in G(Task): its `verify` arm refuses (VM-N1; a human Account is never refused). */
export function exactVerifierGuardedSql(taskId: string): string {
  return `EXISTS (SELECT 1 FROM tasks gv_t JOIN principals gv_p ON gv_p.id = gv_t.verifier_principal_id
     WHERE gv_t.id = ${taskId} AND gv_p.kind <> 'human' AND gv_p.id IN ${guardedPrincipalsSql(taskId)})`;
}

/** The `verifier-agent` arm for the acting principal `principal` (a SQL uuid expression). */
export function verifierAgentEligibleSql(taskId: string, principal: string): string {
  return `EXISTS (SELECT 1 FROM tasks va_t
       JOIN principals va_s ON va_s.id = va_t.verifier_principal_id
       JOIN principals va_a ON va_a.id = ${principal}
       JOIN warrants va_w ON va_w.id = va_a.minted_under_warrant_id
      WHERE va_t.id = ${taskId} AND NOT va_t.verification_none
        AND va_a.kind = 'agent' AND NOT va_a.legacy_identity AND va_a.status = 'active'
        AND va_a.bound_task_id = va_t.id AND va_a.bound_task_role = 'verifier'
        AND va_a.parent_principal_id = va_t.verifier_principal_id
        AND va_s.kind = 'service' AND va_s.status = 'active'
        AND va_w.status = 'active' AND (va_w.expires_at IS NULL OR va_w.expires_at > clock_timestamp())
        AND va_w.holder_principal_id = va_s.id
        AND va_s.id NOT IN ${guardedPrincipalsSql(taskId)}
        AND va_a.id NOT IN ${guardedPrincipalsSql(taskId)})`;
}

