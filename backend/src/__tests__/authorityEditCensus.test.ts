/**
 * Card 1a38270d — AUTHZ amendment AZ-A13 (ratified 2026-10-11, E95), the census
 * controls of section G.1: C-1, the WRITER register, and C-2, the READER
 * register, on the shape of `livenessWriteCensus.test.ts` and
 * `groupPrincipalRegisters.test.ts`: the tree is ENUMERATED and compared to a
 * register a person wrote, so a missing entry fails, not only a misjudged one.
 *
 * C-1. Every statement in backend/src (tests and migrations excluded) that
 * writes `principal_credentials`, `warrants` or `grants` is registered, line by
 * line, with its class. The edited columns are
 *   - principal_credentials.scopes and .transport;
 *   - warrants.ceiling_profile_version_id, .ceiling_rules, .ceiling_scopes,
 *     .expires_at, .transport_pin, .max_concurrent, .max_total;
 *   - grants.verb, .expires_at and .resource_id.
 * After an INSERT, the ONE writer of those columns is
 * `AuthorityEditExecutor.apply` (clause 7), including the narrow-all write to
 * Agent credential scopes (clause 9h) and the revert (clause 6j); the one other
 * UPDATE of a register column is the assignment vehicle shortening the expiry
 * of a provenance row it owns (migration 143), which AZ-A13 never edits (clause
 * 11c). The SET clause of every other UPDATE is read and must name none of
 * them. A new UPDATE of a register column anywhere else turns this red.
 *
 * C-2. Every reader of a credential's scopes or transport (and the grace
 * filters beside them) is registered as reading the stored row when it is
 * used. Clause 12 ("new authority takes effect on the next request") depends on
 * that: a cache in front of the auth path would serve the old scopes. The
 * auth path itself is checked structurally: it selects the row per call and
 * names no cache.
 *
 * The census commands are the regular expressions below (B.0 C1-C3 and R1 of
 * the amendment), so a reviewer can rerun them with grep.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
export const WRITER = /INSERT INTO (principal_credentials|warrants|grants)\b|UPDATE (principal_credentials|warrants|grants)\b|DELETE FROM grants\b/;
export const READER = /c\.scopes|c\.transport|pc\.scopes|pc\.transport|SELECT scopes FROM principal_credentials|scopes, *transport|transport, *secret|c\.grace_until/;
const READER_DIRS = ['services', 'routes', 'utils', 'mcp', 'middleware'];

/** The columns an AZ-A13 edit writes in place, per table. */
export const EDITED_COLUMNS: Record<string, string[]> = {
  principal_credentials: ['scopes', 'transport'],
  warrants: ['ceiling_profile_version_id', 'ceiling_rules', 'ceiling_scopes', 'expires_at', 'transport_pin', 'max_concurrent', 'max_total'],
  grants: ['verb', 'expires_at', 'resource_id'],
};

type WriterClass =
  | 'INSERT'                    // the row is written once
  | 'DELETE'                    // a grant is revoked by deleting it
  | 'AUTHORITY_EDIT'            // AuthorityEditExecutor.apply, the one writer of the edited columns
  | 'PROVENANCE_EXPIRY'         // the vehicle shortens a provenance row's expiry (migration 143)
  | 'DYNAMIC_NAME_DESCRIPTION'  // WarrantService.update: name and description only
  | 'UPDATE_OTHER';             // its SET clause names no edited column

type ReaderClass =
  | 'PER_REQUEST_READ'   // reads the stored row when it is used
  | 'LIVENESS_FILTER'    // a grace/liveness filter beside a read
  | 'EDIT_PATH'          // the edit reads the row it locks
  | 'NOT_A_READER';      // text, a request body, an INSERT column list, a value already read

export const WRITER_REGISTER: Array<[string, string, WriterClass, string]> = [
  ["services/AccessVehicleService.ts", "`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id, provenance, expires_at)", 'INSERT', "an INSERT writer: the row is written once, at issue or creation"],
  ["services/AccessVehicleService.ts", "`UPDATE grants SET expires_at = $2::timestamptz", 'PROVENANCE_EXPIRY', "the assignment vehicle shortens a provenance row it owns (migration 143); AZ-A13 refuses provenance rows (clause 11c)"],
  ["services/AccessVehicleService.ts", "`DELETE FROM grants WHERE id = $1 AND provenance IS NOT NULL", 'DELETE', "a DELETE: a grant is revoked by deleting it (078 doctrine)"],
  ["services/AccountPasswordService.ts", "`UPDATE principal_credentials", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/AccountPasswordService.ts", "`INSERT INTO principal_credentials (principal_id, credential_type, secret_hash, label, created_by_principal_id)", 'INSERT', "an INSERT writer: the row is written once, at issue or creation"],
  ["services/AccountPasswordService.ts", "`UPDATE principal_credentials", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/AgentLifecycleService.ts", "`UPDATE principal_credentials c", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/AgentLifecycleService.ts", "`UPDATE principal_credentials c", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/ApprovalService.ts", "await client.query('DELETE FROM grants WHERE id = $1', [prior.id]);", 'DELETE', "a DELETE: a grant is revoked by deleting it (078 doctrine)"],
  ["services/ChangeRequestService.ts", "await client.query('DELETE FROM grants WHERE id = $1', [existing.id]);", 'DELETE', "card 502fb19e: an EXPIRED identical row is replaced in a change decide (the legacy grant kind's rule); a DELETE, never an edit"],
  ["services/AuthorityEditExecutor.ts", "`UPDATE principal_credentials SET scopes = $2::jsonb, transport = $3 WHERE id = $1`,", 'AUTHORITY_EDIT', "AuthorityEditExecutor.apply: the one writer of the edited columns (AZ-A13 clause 7)"],
  ["services/AuthorityEditExecutor.ts", "`UPDATE warrants", 'AUTHORITY_EDIT', "AuthorityEditExecutor.apply: the one writer of the edited columns (AZ-A13 clause 7)"],
  ["services/AuthorityEditExecutor.ts", "await client.query('DELETE FROM grants WHERE id = $1', [clash.id]);", 'DELETE', "a DELETE: a grant is revoked by deleting it (078 doctrine)"],
  ["services/AuthorityEditExecutor.ts", "`UPDATE grants SET verb = $2, expires_at = $3, resource_id = $4::uuid WHERE id = $1`,", 'AUTHORITY_EDIT', "AuthorityEditExecutor.apply: the one writer of the edited columns (AZ-A13 clause 7)"],
  ["services/AuthorityEditExecutor.ts", "`UPDATE principal_credentials SET scopes = $2::jsonb WHERE id = $1 AND revoked_at IS NULL`,", 'AUTHORITY_EDIT', "AuthorityEditExecutor.apply: the one writer of the edited columns (AZ-A13 clause 7)"],
  ["services/CredentialLifecycleService.ts", "await client.query('UPDATE principal_credentials SET reveal_count = reveal_count + 1 WHERE id = $1', [credentialId]);", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/CredentialLifecycleService.ts", "`UPDATE principal_credentials", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/FirstRunService.ts", "`INSERT INTO principal_credentials", 'INSERT', "an INSERT writer: the row is written once, at issue or creation"],
  ["services/GrantService.ts", "`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id, expires_at, approval_id)", 'INSERT', "an INSERT writer: the row is written once, at issue or creation"],
  ["services/GrantService.ts", "`INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id, expires_at)", 'INSERT', "an INSERT writer: the row is written once, at issue or creation"],
  ["services/GrantService.ts", "const result = await client.query('DELETE FROM grants WHERE id = $1 RETURNING *', [id]);", 'DELETE', "a DELETE: a grant is revoked by deleting it (078 doctrine)"],
  ["services/GrantEffectService.ts", "const deleted = await client.query('DELETE FROM grants WHERE id = $1', [grant.id]);", 'DELETE', "E407/E413: the engine is asked without the row inside a SAVEPOINT that is always rolled back; a DELETE, never an edit"],
  ["services/GrantBulkRevokeService.ts", "if (redundant.length > 0) await client.query('DELETE FROM grants WHERE id = ANY($1::uuid[])', [redundant.map((item) => item.id)]);", 'DELETE', "E413: the dry run's simulated batch, inside a transaction that is always rolled back; a DELETE, never an edit"],
  ["services/GroupService.ts", "`DELETE FROM grants WHERE grantee_type = 'group' AND grantee_id = $1 RETURNING id`, [id],", 'DELETE', "a DELETE: a grant is revoked by deleting it (078 doctrine)"],
  ["services/OAuthAuthorizationService.ts", "`UPDATE principal_credentials", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/PrincipalService.ts", "`INSERT INTO principal_credentials", 'INSERT', "an INSERT writer: the row is written once, at issue or creation"],
  ["services/PrincipalService.ts", "UPDATE principal_credentials", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/PrincipalService.ts", "`UPDATE principal_credentials", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/PrincipalService.ts", "`UPDATE principal_credentials", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/PrincipalService.ts", "`INSERT INTO principal_credentials (principal_id, credential_type, key_id, secret_hash, label, scopes)", 'INSERT', "an INSERT writer: the row is written once, at issue or creation"],
  ["services/PrincipalService.ts", "`UPDATE principal_credentials SET last_used_at = now() WHERE credential_type = 'legacy_env' AND key_id = $1`,", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/PrincipalService.ts", ": pool.query(`UPDATE principal_credentials SET last_used_at = now() WHERE id = $1`, [credentialIdOrEnvName])", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/ProjectService.ts", "`INSERT INTO grants", 'INSERT', "an INSERT writer: the row is written once, at issue or creation"],
  ["services/ServiceRegistry.ts", "`UPDATE principal_credentials", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/ServiceRegistry.ts", "UPDATE principal_credentials", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/WarrantService.ts", "`INSERT INTO warrants", 'INSERT', "an INSERT writer: the row is written once, at issue or creation"],
  ["services/WarrantService.ts", "await client.query(`UPDATE warrants SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);", 'DYNAMIC_NAME_DESCRIPTION', "WarrantService.update: name and description only (asserted below)"],
  ["services/WarrantService.ts", "`UPDATE warrants SET status = 'revoked', revoked_at = NOW(), updated_at = NOW() WHERE id = $1`,", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/WarrantService.ts", "`UPDATE warrants SET status = 'active', suspended_reason = NULL, suspended_at = NULL, updated_at = NOW() WHERE id = $1`,", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/WarrantService.ts", "`UPDATE warrants SET status = 'suspended', suspended_reason = $2, suspended_at = NOW(), updated_at = NOW()", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/WarrantService.ts", "await client.query('UPDATE warrants SET minted_total = minted_total + 1, updated_at = NOW() WHERE id = $1', [warrant.id]);", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/WarrantService.ts", "'UPDATE warrants SET anchors_terminal_since = NOW(), updated_at = NOW() WHERE id = $1',", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/WarrantService.ts", "'UPDATE warrants SET anchors_terminal_since = NULL, updated_at = NOW() WHERE id = $1',", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["services/WarrantService.ts", "`UPDATE warrants SET status = 'expired', expired_at = NOW(), suspended_reason = NULL, suspended_at = NULL, updated_at = NOW() WHERE id = $1`,", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["utils/accessRequestTerminal.ts", "`UPDATE grants SET approval_id = NULL, provenance = $2 WHERE id = $1`,", 'UPDATE_OTHER', "writes no edited column (asserted below by the SET clause)"],
  ["utils/accessRequestTerminal.ts", "await client.query('DELETE FROM grants WHERE id = $1', [grantId]);", 'DELETE', "a DELETE: a grant is revoked by deleting it (078 doctrine)"],
];

export const READER_REGISTER: Array<[string, string, ReaderClass, string]> = [
  ["mcp/registry.ts", "description: 'Who this credential acts as: handle, kind, role, and the credential\\'s own label, scopes, transport pin and expiry. The first call to make in a new agent session, and the one that proves your configuration works.',", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["routes/delegation.ts", "scopes: issued.scopes, transport: issued.transport, expiresAt: issued.expiresAt,", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["routes/services.ts", "const scopes = Array.isArray(spec?.scopes) ? spec.scopes.map(String) : [];", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["routes/services.ts", "const transport = spec?.transport === undefined ? 'any' : String(spec.transport);", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["routes/webhooks.ts", "c.credential_type, c.revoked_at, c.expires_at, c.grace_until, c.transport,", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/AccountControlService.ts", "`SELECT scopes FROM principal_credentials WHERE id=$1 AND principal_id=$2", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/ProductMetricsService.ts", "const credential = await client.query(`SELECT scopes FROM principal_credentials", 'PER_REQUEST_READ', "the collector credential is reread inside each scrape's read-only transaction"],
  ["services/AgentLifecycleService.ts", "AND c.grace_until IS NULL", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/AgentMintService.ts", "AND (c.grace_until IS NULL OR c.grace_until > NOW())", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/AgentMintService.ts", "AND c.scopes::jsonb ? 'tasks:write')", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/AccessVehicleService.ts", "AND (c.grace_until IS NULL OR c.grace_until > clock_timestamp())`,", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/ApprovalService.ts", "? await pool.query('SELECT scopes FROM principal_credentials WHERE id = $1', [input.requestingCredentialId])", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/ChangeRequestService.ts", "'requester', '3', 'the credential.issue spec is {scopes, transport?, label?, expiresAt?}', { fields: unknown });", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ChangeRequestService.ts", "const has = new Set<string>(Array.isArray(spec.scopes) ? spec.scopes : []);", 'NOT_A_READER', "card 502fb19e S2: the relationship diff reads the approved or requested spec, a value already read"],
  ["services/ChangeRequestService.ts", "for (const scope of [...new Set<string>(Array.isArray(spec.scopes) ? spec.scopes : [])].sort()) {", 'NOT_A_READER', "card 502fb19e S2: the relationship diff reads the approved or requested spec, a value already read"],
  ["services/ChangeRequestService.ts", "const reach = await credentialReach(connectorId, [targetType === 'credential.scopes' ? scopes(before.scopes) : [], scopes(spec.scopes)],", 'NOT_A_READER', "card 502fb19e S2 repair: the change diff hands the stored before-state and the spec, values already read, to credentialReach, whose per-request read is ApprovalService's"],
  ["services/ChangeRequestService.ts", "`SELECT id, label, key_id, scopes, transport FROM principal_credentials", 'PER_REQUEST_READ', "card 502fb19e: the credential.issue ALREADY_HELD check reads the Connector's live credentials when it runs, at filing, decide and collect"],
  ["services/ChangeRequestService.ts", "await this.assertCredentialNotHeld(pool, String(row.id), scopes, transport);", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ChangeRequestService.ts", "const metadata = { kind: 'change', targetType: 'credential.issue', ...effect, scopes: issued.scopes, transport: issued.transport, expiresAt: issued.expiresAt };", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ChangeRequestService.ts", "requested: { scopes, transport, label, expiresAt },", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ChangeRequestService.ts", "spec.transportPin = prepared.transportPin;", 'NOT_A_READER', "card 9ce0b0b0 S4: a warrant.create filing records the pin the creation validators normalised from its own request body, a value already read"],
  ["services/ChangeRequestService.ts", "requested: { scopes: (target.after as { scopes: string[] }).scopes, transport: before.transport },", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ChangeRequestService.ts", "return { after: { authorized: { scopes, transport: approved.transport, expiresAt: approved.expiresAt } }, effect: {}, revertAt: String(approved.expiresAt) };", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ChangeRequestService.ts", "throw refuse(422, 'INVALID_ACCESS_REQUEST', `a credential.issue change carries scopes, transport, label and expiresAt only (got ${unknown.join(', ')})`,", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ApprovalService.ts", "const credential = await client.query('SELECT scopes FROM principal_credentials WHERE id = $1', [row.requesting_credential_id]);", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/ApprovalService.ts", "await this.assertCredentialNotAlreadyHeld(pool, input.requesterPrincipalId, scopes, transport as string, kind);", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ApprovalService.ts", "relatedTaskId: related.taskId, relatedPhaseId: related.phaseId, scopes, transport, label,", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ApprovalService.ts", "scopes: filed.scopes, transport: filed.transport, label: filed.label,", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ApprovalService.ts", "`SELECT id, key_id, label, scopes, transport, expires_at, revoked_at FROM principal_credentials WHERE id = $1`,", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/ApprovalService.ts", "await this.assertCredentialNotAlreadyHeld(client, requesterId, scopes, transport, kind);", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ApprovalService.ts", "scopes: issued.scopes, transport: issued.transport, expiresAt: issued.expiresAt, label: issued.label,", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/ApprovalService.ts", "`SELECT id, label, key_id, scopes, transport, expires_at FROM principal_credentials", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/ApprovalService.ts", "`SELECT p.id, p.handle, c.id AS credential_id, c.scopes FROM principals p", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/ApprovalService.ts", "WHERE p.parent_principal_id = $1 AND p.status = 'active' AND c.revoked_at IS NULL AND c.grace_until IS NULL", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/ApprovalService.ts", "`SELECT id, label, key_id, scopes, transport, revoked_at, expires_at FROM principal_credentials WHERE id = $1`,", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/ApprovalService.ts", "`SELECT id, label, key_id, scopes, transport, expires_at FROM principal_credentials", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/ApprovalService.ts", "OR c.grace_until IS NOT NULL)`,", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  // P2-D (card 80892045): each preview request reads the identity's credential rows
  // (and a selected credential beyond the bounded list) when it is used; no cache.
  ["services/AuthorityPreviewService.ts", "`SELECT id,scopes,transport,expires_at,revoked_at,grace_until,", 'PER_REQUEST_READ', "each preview request reads the identity's credential rows when it is used, with no cache"],
  ["services/AuthorityPreviewService.ts", "`SELECT id,scopes,transport,expires_at,", 'PER_REQUEST_READ', "a selected credential beyond the bounded list is reread by id in the same request, with no cache"],
  ["services/AuthorityEditExecutor.ts", "`SELECT id, principal_id, credential_type, key_id, label, scopes, transport, expires_at, revoked_at,", 'EDIT_PATH', "the edit itself reads the row under FOR UPDATE"],
  ["services/AuthorityEditExecutor.ts", "return { scopes, transport };", 'EDIT_PATH', "the edit itself reads the row under FOR UPDATE"],
  ["services/AuthorityEditExecutor.ts", "{ principalId: String(object.row.principal_id), scopes: target.scopes, transport: target.transport },", 'EDIT_PATH', "the edit itself reads the row under FOR UPDATE"],
  ["services/AuthorityEditExecutor.ts", "finalState = { scopes: target.scopes, transport: target.transport };", 'EDIT_PATH', "the edit itself reads the row under FOR UPDATE"],
  ["services/AuthorityEditExecutor.ts", "AND c.revoked_at IS NULL AND c.grace_until IS NOT NULL`,", 'EDIT_PATH', "the edit itself reads the row under FOR UPDATE"],
  ["services/AuthorityEditExecutor.ts", "`SELECT p.id AS principal_id, c.id AS credential_id, c.scopes, c.key_id", 'EDIT_PATH', "the edit itself reads the row under FOR UPDATE"],
  ["services/AuthorityEditExecutor.ts", "AND c.revoked_at IS NULL AND c.grace_until IS NULL", 'EDIT_PATH', "the edit itself reads the row under FOR UPDATE"],
  ["services/AuthorityEditExecutor.ts", "`SELECT p.id AS principal_id, c.id AS credential_id, c.scopes, c.key_id", 'EDIT_PATH', "the edit itself reads the row under FOR UPDATE"],
  ["services/AuthorityEditExecutor.ts", "AND c.revoked_at IS NULL AND c.grace_until IS NULL", 'EDIT_PATH', "the edit itself reads the row under FOR UPDATE"],
  ["services/AuthorizationRepository.ts", "AND (c.expires_at IS NULL OR c.expires_at>NOW()) AND (c.grace_until IS NULL OR c.grace_until>NOW())))) AS alive", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/AuthorizationRepository.ts", "AND (c.expires_at IS NULL OR c.expires_at>NOW()) AND (c.grace_until IS NULL OR c.grace_until>NOW())))", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/ConnectorCredentialIssuance.ts", "{ principalId: input.connectorPrincipalId, scopes, transport: input.transport }, actor, client);", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/DelegationService.ts", "AND (c.grace_until IS NULL OR c.grace_until > clock_timestamp())", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/GrantService.ts", "`SELECT scopes FROM principal_credentials", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/PrincipalService.ts", "c.scopes, c.expires_at, c.revoked_at, c.transport, c.grace_until,", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/PrincipalService.ts", "{ principalId: input.principalId, scopes: input.scopes, transport: input.transport }, actor, transaction);", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/PrincipalService.ts", "transport, secret_ciphertext, encryption_key_id, rotated_from_id,", 'NOT_A_READER', "not a read of a stored credential (text, a request body, an INSERT column list or a value already read)"],
  ["services/PrincipalService.ts", "reveal_count, grace_until, transport, secret_ciphertext IS NOT NULL AS revealable", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/PrincipalService.ts", "`SELECT c.id AS cred_id, c.principal_id, c.key_id, c.label, c.scopes,", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/PrincipalService.ts", "c.credential_type, c.expires_at, c.revoked_at, c.transport, p.*", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/PrincipalService.ts", "`SELECT c.id AS cred_id, c.principal_id, c.key_id, c.label, c.scopes, c.transport,", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/PrincipalService.ts", "c.credential_type, c.expires_at, c.revoked_at, c.grace_until, c.rotated_from_id, p.*", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/SubscriberActorService.ts", "c.scopes AS credential_scopes,", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/SubscriberActorService.ts", "c.grace_until AS credential_grace_until,", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/SubscriberActorService.ts", "c.transport AS credential_transport", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/SubscriberActorService.ts", "AND (c.grace_until IS NULL OR c.grace_until > NOW())", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/SubscriberActorService.ts", "AND COALESCE(c.transport, 'any') IN ('any', $2)", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/TaskElementService.ts", "const credential = await client.query(`SELECT scopes FROM principal_credentials WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  // Card 41e24358: arm 3 of the usable-Verifier predicate reads every live credential's scopes when it is evaluated.
  ["services/VerifierUsability.ts", "`SELECT scopes FROM principal_credentials", 'PER_REQUEST_READ', "reads the stored row when it is used, with no cache"],
  ["services/WarrantService.ts", "AND (c.grace_until IS NULL OR c.grace_until > NOW()))`,", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
  ["services/WarrantService.ts", "AND (c.grace_until IS NULL OR c.grace_until > NOW())) AS live", 'LIVENESS_FILTER', "a grace/liveness filter, not a scope reader"],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(SRC, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (rel === '__tests__' || rel === 'migrations') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Hit { file: string; text: string; index: number; content: string }

function census(pattern: RegExp, dirs: string[] | null): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (dirs && !dirs.includes(rel.split('/')[0])) continue;
    const content = fs.readFileSync(file, 'utf8');
    let offset = 0;
    for (const line of content.split('\n')) {
      const match = pattern.exec(line);
      if (match) hits.push({ file: rel, text: line.trim(), index: offset + match.index, content });
      offset += line.length + 1;
    }
  }
  return hits;
}

/** The columns an UPDATE's SET clause assigns: the text between SET and WHERE. */
export function setColumns(content: string, index: number): string[] {
  const segment = content.slice(index, index + 4000);
  const set = segment.search(/\bSET\b/);
  const where = segment.search(/\bWHERE\b/);
  if (set < 0 || where < set) return [];
  const clause = segment.slice(set + 3, where);
  return [...clause.matchAll(/(?:^|[\s,])([a-z_]+)\s*=(?!=)/g)].map((m) => m[1]);
}

function tableOf(text: string): string {
  return (/(?:INSERT INTO|UPDATE|DELETE FROM) (principal_credentials|warrants|grants)\b/.exec(text) as RegExpExecArray)[1];
}

const WRITERS = census(WRITER, null);
const READERS = census(READER, READER_DIRS);

function byFile(entries: Array<[string, string, string, string]>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [file, text] of entries) map.set(file, [...(map.get(file) ?? []), text]);
  return map;
}
function hitsByFile(hits: Hit[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const hit of hits) map.set(hit.file, [...(map.get(hit.file) ?? []), hit.text]);
  return map;
}

describe('C-1 the writer register (AZ-A13 G.1): AuthorityEditExecutor.apply is the one writer of the edited columns', () => {
  const registered = byFile(WRITER_REGISTER);
  const found = hitsByFile(WRITERS);
  const files = [...new Set([...registered.keys(), ...found.keys()])].sort();

  it('the census finds the writers at all, and states its command', () => {
    expect(WRITER.source).toContain('principal_credentials|warrants|grants');
    expect(WRITERS.length).toBeGreaterThan(30);
    expect(WRITER_REGISTER.length).toBe(WRITERS.length);
  });

  it.each(files)('writer register: %s is classified line by line', (file) => {
    expect({ file, lines: [...(found.get(file) ?? [])].sort() }).toEqual({ file, lines: [...(registered.get(file) ?? [])].sort() });
  });

  it('no UPDATE outside the executor writes an edited column, and the executor is the only AUTHORITY_EDIT writer', () => {
    const classOf = new Map(WRITER_REGISTER.map(([file, text, cls]) => [`${file}\u0000${text}`, cls]));
    const violations: string[] = [];
    for (const hit of WRITERS) {
      if (!/\bUPDATE (principal_credentials|warrants|grants)\b/.test(hit.text)) continue;
      const table = tableOf(hit.text);
      const writes = setColumns(hit.content, hit.index).filter((column) => EDITED_COLUMNS[table].includes(column));
      const cls = classOf.get(`${hit.file}\u0000${hit.text}`);
      if (writes.length === 0) continue;
      if (cls === 'AUTHORITY_EDIT' && hit.file === 'services/AuthorityEditExecutor.ts') continue;
      if (cls === 'PROVENANCE_EXPIRY' && table === 'grants' && writes.join() === 'expires_at'
        && /provenance IS NOT NULL/.test(hit.content.slice(hit.index, hit.index + 600))) continue;
      violations.push(`${hit.file}: ${hit.text} writes ${writes.join(', ')}`);
    }
    expect(violations).toEqual([]);
    expect(WRITER_REGISTER.filter((entry) => entry[2] === 'AUTHORITY_EDIT').every((entry) => entry[0] === 'services/AuthorityEditExecutor.ts')).toBe(true);
    // The executor writes the edited columns in place, and nothing else of the row.
    const executor = WRITERS.filter((hit) => hit.file === 'services/AuthorityEditExecutor.ts' && /UPDATE principal_credentials/.test(hit.text));
    expect(executor.map((hit) => setColumns(hit.content, hit.index).sort().join(','))).toEqual(['scopes,transport', 'scopes']);
  });

  it('every UPDATE_OTHER really writes no edited column (the SET clause is read)', () => {
    const others = WRITER_REGISTER.filter((entry) => entry[2] === 'UPDATE_OTHER');
    expect(others.length).toBeGreaterThan(10);
    for (const [file, text] of others) {
      const hit = WRITERS.find((candidate) => candidate.file === file && candidate.text === text);
      // A registered line the tree no longer carries is the per-file test's
      // finding; here it reads as writing nothing it could be checked for.
      const table = tableOf(text);
      const writes = hit ? setColumns(hit.content, hit.index).filter((column) => EDITED_COLUMNS[table].includes(column)) : ['<absent>'];
      expect({ file, text, writes }).toEqual({ file, text, writes: [] });
    }
  });

  it('the dynamic warrant UPDATE builds its SET clause from name and description only', () => {
    const source = fs.readFileSync(path.join(SRC, 'services', 'WarrantService.ts'), 'utf8');
    const pushes = [...source.matchAll(/sets\.push\(`([a-z_]+) = /g)].map((m) => m[1]).sort();
    expect(pushes).toEqual(['description', 'name']);
  });
});

describe('C-2 the reader register (AZ-A13 G.1, clause 12): the scopes and the pin are read per request, with no cache', () => {
  const registered = byFile(READER_REGISTER);
  const found = hitsByFile(READERS);
  const files = [...new Set([...registered.keys(), ...found.keys()])].sort();

  it('the census finds the readers at all, and states its command', () => {
    expect(READER.source).toContain('SELECT scopes FROM principal_credentials');
    expect(READERS.length).toBeGreaterThan(25);
  });

  it.each(files)('reader register: %s is classified line by line', (file) => {
    expect({ file, lines: [...(found.get(file) ?? [])].sort() }).toEqual({ file, lines: [...(registered.get(file) ?? [])].sort() });
  });

  it('the bearer auth path selects the credential row on every call and names no cache', () => {
    const principal = fs.readFileSync(path.join(SRC, 'services', 'PrincipalService.ts'), 'utf8');
    const start = principal.indexOf('async authenticatePrincipalKey(');
    const end = principal.indexOf('\n  }\n', start);
    const body = principal.slice(start, end);
    expect(body).toMatch(/pool\.query\(\s*`SELECT c\.id AS credential_id[\s\S]*c\.scopes[\s\S]*c\.transport[\s\S]*FROM principal_credentials c/);
    expect(body).not.toMatch(/cache|memo|new Map|lru/i);
    const auth = fs.readFileSync(path.join(SRC, 'middleware', 'auth.ts'), 'utf8');
    const at = auth.indexOf('export async function acceptPrincipalKey(');
    expect(at).toBeGreaterThan(-1);
    const accept = auth.slice(at, at + 6000);
    expect(accept).toContain('authenticatePrincipalKey');
    expect(accept).not.toMatch(/credentialCache|scopeCache|authCache|new Map/);
  });
});

describe('clause 15b (OP-12): the agent plane composes no edit route', () => {
  it('the MCP registry composes no PATCH on an authority object, and no /grants, /warrants or /credentials/:id path but reveal and revoke', () => {
    const registry = fs.readFileSync(path.join(SRC, 'mcp', 'registry.ts'), 'utf8');
    // Method-specific: every PATCH the registry composes, by the path it names.
    const patched = [...registry.matchAll(/method:\s*'PATCH',\s*path:\s*[`'](\/[a-z-]+)/g)].map((m) => m[1]);
    expect(patched.length).toBeGreaterThan(0);
    expect(patched.filter((family) => ['/credentials', '/warrants', '/grants'].includes(family))).toEqual([]);
    const credentialPaths = [...registry.matchAll(/path:\s*`\/credentials\/\$\{[^}]+\}([^`]*)`/g)].map((m) => m[1]).sort();
    expect(credentialPaths).toEqual(['/reveal', '/revoke']);
    for (const family of ['/grants', '/warrants']) {
      expect(registry).not.toContain(`path: '${family}`);
      expect(registry).not.toContain(`path: \`${family}`);
    }
  });
});
