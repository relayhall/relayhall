/**
 * Card 20f40e40 — AZ-A12 build 1, control C-3: the two REGISTERS that keep a
 * Group principal from being admitted by negation.
 *
 * Clause 1 adds a fourth principal kind. Every place the code compares a kind
 * was written when there were three, and a test such as `kind === 'agent'`
 * that refuses one kind ADMITS every other one, a Group included. Such a
 * reader on a caller-supplied target is a defect until a named refusal stands
 * in front of it (or a migration 146 backstop makes the Group unreachable
 * there). Two registers make that a property the tree cannot drift from:
 *
 *   (1) THE KIND-READER REGISTER. A census of every kind comparison in
 *       backend/src (tests and migrations excluded), VALUE-SCOPED: each entry
 *       is the exact trimmed source line, with its classification and the
 *       reason it is safe. A new kind comparison, an edited one, or a removed
 *       one turns its file's case red until it is classified here.
 *   (2) THE PATH-ID ROUTE REGISTER. Every route declared in routes/principals.ts
 *       and routes/groups.ts, classified. Every /principals/:id MUTATION must
 *       run the Group guard as its FIRST statement, naming its own route; the
 *       ownership-status act must canonicalize the Group id before it spends a
 *       step-up (the step-up store compares ids as text).
 *
 * The census command (the regular expression below) is printed by the first
 * test so a reviewer can rerun it: it matches `kind` followed by a comparison
 * against a principal kind literal, or `kind IN (`.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
export const KIND_COMPARISON = /\bkind\s*(===|!==|==|!=|=|<>)\s*'(human|agent|service|group)'|\bkind\s+(NOT\s+)?IN\s*\(/;

type KindReaderClass =
  | 'REFUSES_GROUP'       // a named refusal of a Group principal (clause 3)
  | 'GUARDED_NEGATION'    // a negation on a target that a named Group refusal precedes
  | 'ALLOWLIST'           // admits only the kinds it names; a Group is never one of them
  | 'ACTING_CHAIN'        // reads the ACTING identity or its chain; a Group never authenticates (clause 3a)
  | 'NOT_A_GROUP_ROW'     // reads a row the schema keeps from naming a Group (migration 146)
  | 'GROUP_SELF'          // a Group statement about its OWN principal row
  | 'BACKSTOPPED_FLAGGED' // admits a Group by negation; the migration 146 backstop refuses the write, not by name
  | 'PROSE'               // a comment
  | 'OTHER_VOCABULARY';   // a `kind` that is not a principal kind

/** [file under backend/src, exact trimmed line, class, why it is safe] */
export const KIND_READER_REGISTER: Array<[string, string, KindReaderClass, string]> = [
  ["middleware/sharedAuthorization.ts", "if (required === 'tasks:write' && actingLink?.kind === 'agent'", 'ACTING_CHAIN', "AZ-A10 clause 11c checks the bound verifier Agent's acting chain before route dispatch"],
  ["services/AccessProfileService.ts", "if (row.kind === 'group') {", 'REFUSES_GROUP', "clause 3(e): GROUP_PRINCIPAL_NOT_A_GRANTEE for a principal assignee"],
  ["services/AccessProfileService.ts", "if (row.kind === 'agent' && !row.parent_principal_id && !row.legacy_identity) {", 'GUARDED_NEGATION', "the Group refusal above runs first"],
  ["services/AccessProfileService.ts", "if (row.kind === 'agent') {", 'GUARDED_NEGATION', "the Group refusal above runs first"],
  ["services/AccessVehicleService.ts", "WHERE c.principal_id = $1 AND p.kind = 'agent' AND p.status = 'active'", 'ALLOWLIST', "only active Agent credentials drive expiry synchronization"],
  ["services/AccessVehicleService.ts", "const agentCredential = principal.kind === 'agent' && !input.credentialExpiresAt", 'ALLOWLIST', "role grant creation first admits only agent, human or service principals"],
  ["services/AccessVehicleService.ts", "const expiry = principal.kind === 'agent'", 'ALLOWLIST', "role grant creation first admits only agent, human or service principals"],
  ["services/AccessVehicleService.ts", "if (holder?.kind === 'agent') {", 'NOT_A_GROUP_ROW', "redateRole is reached from validated Task role assignments; Group role columns are schema-refused"],
  ["services/AccessVehicleService.ts", "if (principal.kind === 'agent' && expiry === undefined) {", 'ALLOWLIST', "role grant creation first admits only agent, human or service principals"],
  ["services/AccessVehicleService.ts", "if (principal.kind === 'agent' && input.roleGrantExpiry !== undefined) {", 'ALLOWLIST', "role grant creation first admits only agent, human or service principals"],
  ["services/AccessVehicleService.ts", "if (principal.kind === 'human' && ADMINISTRATOR_ROLES.has(String(principal.role || '').toLowerCase())) {", 'ALLOWLIST', "role grant creation first admits only agent, human or service principals"],
  ["services/AccountControlService.ts", "if (links.length === 1 && acting.kind === 'human' && !acting.parentPrincipalId) return acting.principalId;", 'ACTING_CHAIN', "the acting chain"],
  ["services/AccountControlService.ts", "if (links.length !== 2 || acting.kind !== 'service' || acting.boundTaskId", 'ACTING_CHAIN', "the acting chain"],
  ["services/ProductMetricsService.ts", "if (!chain.alive || chain.links.length !== 2 || acting.kind !== 'service'", 'ACTING_CHAIN', "the metrics collector must be a direct Connector in the live Account chain"],
  ["services/AccountControlService.ts", "|| parent.kind !== 'human' || parent.parentPrincipalId", 'ACTING_CHAIN', "the acting chain"],
  ["services/AccountControlService.ts", "if (chain.links[0].kind === 'human') {", 'ACTING_CHAIN', "the acting chain"],
  ["services/AccountPasswordService.ts", "if (target.kind !== 'human') {", 'ALLOWLIST', "humans only; the /principals/:id password routes refuse a Group first"],
  ["services/AccountPasswordService.ts", "if (!principal || principal.kind !== 'human' || principal.status !== 'active') {", 'ALLOWLIST', "humans only"],
  ["services/AgentLifecycleService.ts", "if (!row || row.kind !== 'agent' || row.legacy_identity) return { extended: false, blockedReason: null };", 'ALLOWLIST', "Agents only"],
  ["services/AgentLifecycleService.ts", "AND p.kind = 'agent' AND NOT p.legacy_identity", 'ALLOWLIST', "Agents only"],
  ["services/AgentMintService.ts", "// The minted Agent (\u00a78.1): kind='agent', FIXED minimal role (NULL \u2014 never", 'PROSE', "comment"],
  ["services/AgentMintService.ts", "WHERE p.kind = 'agent' AND p.bound_task_id = $1 AND p.status = 'active'", 'ALLOWLIST', "Agents only"],
  ["services/ApprovalService.ts", "if (requester.kind === 'agent') {", 'ACTING_CHAIN', "the acting requester"],
  ["services/ApprovalService.ts", "if (account.kind !== 'human' || account.parentPrincipalId) {", 'ALLOWLIST', "the chain-root Account: humans only (clause 3g)"],
  ["services/ApprovalService.ts", "if (kind === 'credential' && requester.kind !== 'service') {", 'ALLOWLIST', "the acting requester: Connectors only"],
  ["services/ApprovalService.ts", "if (objects !== 'parent' && Array.isArray(objects) && objects.length === 0 && row.kind === 'agent'", 'NOT_A_GROUP_ROW', "a minted Agent row carrying own_expression; a Group carries none (principals_group_shape)"],
  ["services/AssignedClaimAuthority.ts", "return Boolean(links && links.length > 1 && links[0].kind === 'service' && !links[0].legacyIdentity", 'ACTING_CHAIN', "the acting chain"],
  ["services/AssignedClaimAuthority.ts", "AND claim_descriptor.retired_at IS NULL AND claim_principal.kind='service'", 'ALLOWLIST', "services only"],
  ["services/AuthorizationRepository.ts", "WHERE rc.parent_principal_id IS NULL AND rc.kind='human' AND rc.alive", 'ALLOWLIST', "humans only"],
  ["services/AuthorityEditExecutor.ts", "WHERE p.parent_principal_id = $1 AND p.kind = 'agent' AND p.status = 'active'", 'ALLOWLIST', "the narrow-all act (AZ-A13 clause 9h): the Connector's live Agents only"],
  ["services/AuthorizationService.ts", ": (objects.length === 0 && link.kind === 'agent' && link.boundTaskId && !link.legacyIdentity", 'ACTING_CHAIN', "AZ-A10 reads the acting Agent link's live role-row cap"],
  ["services/AuthorizationService.ts", "return chain[0].kind === 'agent' ? 2 : 3;", 'ACTING_CHAIN', "the acting chain"],
  // Owner ruling E462 S4b (design section 6.8): the `verifier-agent` arm on the acting Agent.
  ["services/AuthorizationService.ts", "&& actor.delegation?.links?.[0]?.kind === 'agent' && !actor.delegation.links[0].legacyIdentity", 'ACTING_CHAIN', "the verifier-agent arm reads the acting Agent link (E462 S4b)"],
  ["services/AuthorizationService.ts", "if (resource.verificationNone && acting?.kind === 'agent' && !acting.legacyIdentity) {", 'ACTING_CHAIN', "the verifier-agent arm reads the acting Agent link (E462 S4b)"],
  ["services/BlueprintResolutionService.ts", "if (link?.kind === 'agent') return false;", 'ACTING_CHAIN', "a Blueprint caller that is an Agent never sets verification none (E462 S4b)"],
  ["services/VerificationModes.ts", "if (!chain.alive || chain.links[0]?.kind === 'agent') {", 'ACTING_CHAIN', "an Agent never sets verification none: the acting chain (E462 S4b)"],
  ["utils/verificationGuardSql.ts", "AND va_a.kind = 'agent' AND NOT va_a.legacy_identity AND va_a.status = 'active'", 'ACTING_CHAIN', "the verifier-agent arm's acting principal must be an active Agent (E462 S4b)"],
  ["utils/verificationGuardSql.ts", "AND va_s.kind = 'service' AND va_s.status = 'active'", 'ALLOWLIST', "the verifier-agent arm admits only a service Verifier (E462 S4b)"],
  ["utils/verificationGuardSql.ts", "WHERE g_a.kind = 'agent' AND g_a.bound_task_id = ${taskId} AND g_a.bound_task_role = 'implementer'", 'ALLOWLIST', "G(Task) seeds every implementer Agent ever bound to the Task (E462 S4b)"],
  ["utils/verificationGuardSql.ts", "WHERE g_m.kind <> 'human')`;", 'NOT_A_GROUP_ROW', "G(Task) members come from claimants, finish authors, the execution connector, implementer Agents and their parent chains, none of which a Group can be (clause 3c, migration 146); a member only ever narrows who may verify (E462 S4b)"],
  ["utils/verificationGuardSql.ts", "WHERE gv_t.id = ${taskId} AND gv_p.kind <> 'human' AND gv_p.id IN ${guardedPrincipalsSql(taskId)})`;", 'NOT_A_GROUP_ROW', "the exact Verifier, which is never a Group (roles route refusal, migration 146 backstop); the guard only refuses (E462 S4b)"],
  ["services/AuthorizationService.ts", "if (actingChain[0].kind === 'agent' && action !== 'read'", 'ACTING_CHAIN', "the acting chain"],
  ["services/AuthorizationService.ts", "if (action === 'read' && actingLink?.kind === 'agent'", 'ACTING_CHAIN', "the acting chain"],
  ["services/AuthorizationService.ts", "&& resource.assignedClaimPrincipal && chain[0].kind === 'service'", 'ACTING_CHAIN', "the acting chain"],
  ["services/AuthorizationService.ts", "if (chain[0].kind === 'agent' && action !== 'read' && resource.type === 'task') {", 'ACTING_CHAIN', "the acting chain"],
  // Card ee81ee0f (AZ-A12 build 2, clauses 6-8): the Group-owner arm.
  ["services/AuthorizationService.ts", "* fragment matches only a `kind = 'group'` principal. Absent, the path is", 'PROSE', "comment"],
  ["utils/groupOwnerCondition.ts", "AND owning_group.kind = 'group'", 'GROUP_SELF', "the owner value must name an ACTIVE Group principal (clause 6): a person owner never matches this arm, and the person arm stays equality"],
  ["services/BlueprintCaptureService.ts", "if (kind==='service' && descriptorVersion !== undefined) {", 'OTHER_VOCABULARY', "a capture kind, not a principal kind"],
  ["services/BlueprintRegistryService.ts", "const agent = caller.actor.role === 'agent' || caller.actor.delegation?.links[0]?.kind === 'agent';", 'ACTING_CHAIN', "the acting chain; a Group never authenticates (clause 3a)"],
  ["services/BlueprintRegistryService.ts", "if (admin && (caller.actor.delegation?.links[0]?.kind === 'agent' || caller.actor.role === 'agent')) throw new BlueprintError(403, 'BLUEPRINT_AGENT_ADMIN_REFUSED', 'Agent-layer principals cannot administer Blueprint publication');", 'ACTING_CHAIN', "the acting chain"],
  ["services/BlueprintResolutionService.ts", "if (link?.kind === 'agent' && !link.legacyIdentity) return authorizationService.authorizeResource(caller.actor,'write',resource,[]).allowed;", 'ACTING_CHAIN', "the acting chain"],
  ["services/BlueprintResolutionService.ts", "if (!principal || principal.kind === 'agent' && !principal.legacy_identity && principal.bound_task_id) return false;", 'BACKSTOPPED_FLAGGED', "a Blueprint role requirement naming a Group passes this resolution check; the write is refused by the migration 146 backstop, not by name. Flagged for the dispatcher (outside the build-1 change list)"],
  ["services/BlueprintResolutionService.ts", "if (id === requirement.shepherdPrincipalId && principal.kind === 'service' && !route('services:invoke')) return false;", 'BACKSTOPPED_FLAGGED', "same requirement as the line above"],
  ["services/CharterService.ts", "if (!current || current.kind !== 'human' || current.status !== 'active' || current.parent_principal_id", 'ALLOWLIST', "only an active parentless human"],
  ["services/CharterService.ts", "if (owner?.kind !== 'group') return base;", 'GROUP_SELF', "LENSES-c gate (i) round 2 (card b5c83682; C.5): only a refusal on a Group-owned Project carries the arm's audit fields; any other owner keeps today's denied row"],
  ["services/CharterService.ts", "if (!owner || owner.kind !== 'group' || owner.status !== 'active') throw refuse();", 'GROUP_SELF', "LENSES-c gate (i) (card b5c83682): the Group-owner Charter arm applies only to a Project owned by an ACTIVE Group principal; every other owner is CHARTER_APPROVAL_FORBIDDEN"],
  ["services/GroupOwnerStewardTransfer.ts", "if (!person || person.kind !== 'human' || person.status !== 'active' || person.parent_principal_id || person.legacy_identity) {", 'ALLOWLIST', "LENSES-c c1-B (card b5c83682; C.6) steward transfer, step 2: only an active, parentless, non-legacy human acting as itself"],
  ["services/GroupOwnerStewardTransfer.ts", "if (input.targetOwnerId !== null && current?.kind === 'group' && target?.kind !== 'group') {", 'GROUP_SELF', "LENSES-c gate (ii): the OUT shape is an owner value naming a Group principal moving to a non-Group target, which must then be an active member of that Group and an active human"],
  ["services/GroupOwnerStewardTransfer.ts", "if (target?.kind === 'group' && current?.kind !== 'group') {", 'GROUP_SELF', "LENSES-c DD-5: the IN shape is a person-owned object moving into a Group principal the caller live-owns; every other shape is STEWARD_TRANSFER_SHAPE_REFUSED"],
  ["services/DelegationService.ts", "if (acting.kind === 'agent') {", 'ACTING_CHAIN', "the acting chain"],
  // P2-D (card 80892045): shared by credential acceptance (the acting link) and the
  // current-authority preview (the previewed link, a projection that grants nothing).
  // A non-Agent has no bound-Task context or Verifier act cap to apply; a Group never
  // authenticates (clause 3a), so the negation admits it to no act.
  ["services/DelegationService.ts", "if (acting.kind !== 'agent' || !acting.boundTaskId) return true;", 'ACTING_CHAIN', "the acting (or previewed, grant-free) link: only a bound Agent has a Task context to check"],
  ["services/ExplicitTaskActionCaps.ts", "if (acting?.kind !== 'agent' || acting.boundTaskRole !== 'verifier') return true;", 'ACTING_CHAIN', "the acting (or previewed, grant-free) link: only a bound Verifier Agent carries the AZ-A10 11c act cap"],
  ["services/ExplicitTaskActionCaps.ts", "if (links[0].kind === 'agent' && links[0].boundTaskId !== task.id) return false;", 'ACTING_CHAIN', "the acting chain"],
  ["services/ExplicitTaskActionCaps.ts", "if (objects.length === 0 && link.kind === 'agent' && link.boundTaskId === task.id) {", 'ACTING_CHAIN', "AZ-A10 bounds the acting Agent's empty own() cap to its Task and role"],
  ["services/FirstRunService.ts", "WHERE kind = 'human'", 'ALLOWLIST', "humans only"],
  ["services/GrantService.ts", "\"SELECT id FROM principals WHERE id=$1 AND kind='human' AND status='active' AND parent_principal_id IS NULL AND NOT legacy_identity\",", 'ALLOWLIST', "creation Account: humans only"],
  ["services/GrantService.ts", "if (!trusted || trusted.length < 2 || trusted[trusted.length - 1].kind !== 'human') return null;", 'ACTING_CHAIN', "the trusted acting chain"],
  ["services/GrantService.ts", "if (principal.kind === 'group') {", 'REFUSES_GROUP', "clause 3(e): GROUP_PRINCIPAL_NOT_A_GRANTEE"],
  ["services/GrantEffectService.ts", "if (row.kind === 'group') throw new GrantNotEvaluable('a Group principal is never a principal grantee');", 'REFUSES_GROUP', "E407/E413: a Group principal is refused as a grantee to evaluate (clause 3(e)); its grants are group-grantee rows, never evaluated as redundant"],
  ["services/GrantEffectService.ts", "if (row.kind !== 'agent') {", 'GUARDED_NEGATION', "the Group refusal above runs first: only a Connector-capable grantee (an Account or a Connector) gets the descendant probe"],
  ["services/GroupService.ts", "(SELECT gp.status FROM principals gp WHERE gp.id = gr.id AND gp.kind = 'group') AS ownership_status", 'GROUP_SELF', "the Group's own principal row (read model)"],
  ["services/GroupService.ts", "(SELECT gp.status FROM principals gp WHERE gp.id = groups.id AND gp.kind = 'group') AS ownership_status`,", 'GROUP_SELF', "the Group's own principal row (read model)"],
  ["services/GroupService.ts", "WHERE id = $1 AND kind = 'group' RETURNING id`,", 'GROUP_SELF', "the Group's own principal row (rename, terminate)"],
  ["services/GroupService.ts", "WHERE id = $1 AND kind = 'group' RETURNING id`,", 'GROUP_SELF', "the Group's own principal row (rename, terminate)"],
  ["services/GroupService.ts", "if (row.kind === 'agent') {", 'GUARDED_NEGATION', "the Group refusal below runs before any write; the member trigger backstops it"],
  ["services/GroupService.ts", "if (row.kind === 'group') {", 'REFUSES_GROUP', "clause 3(d): MEMBER_NOT_ACCOUNT, no nested Groups"],
  ["services/GroupService.ts", "FROM principals gp WHERE gp.id = $1 AND gp.kind = 'group'`,", 'GROUP_SELF', "GROUP_OWNS_OBJECTS counts"],
  ["services/GroupService.ts", "JOIN principals gp ON gp.id = gr.id AND gp.kind = 'group' AND gp.status <> 'terminated'", 'GROUP_SELF', "the ownership-status act"],
  ["services/GroupService.ts", "`UPDATE principals SET status = $2, updated_at = NOW() WHERE id = $1 AND kind = 'group'`,", 'GROUP_SELF', "the ownership-status act"],
  ["services/KnowledgeWriteExecutor.ts", "const boundTaskId = req.principal?.kind === 'agent' && acting?.kind === 'agent' && acting.principalId === req.principal.id", 'ACTING_CHAIN', "the acting principal and its chain: an Agent's bound Task is its write context (RB-11 Governor v0, C.3); a Group never authenticates (clause 3a)"],
  ["services/GroupStewardService.ts", "if (!person || person.kind !== 'human' || person.status !== 'active' || person.parent_principal_id", 'ALLOWLIST', "LENSES-c gate (iii) standing, step 2: only an active, parentless, non-legacy human acting as itself (CharterService's test)"],
  ["services/ChangeRequestService.ts", "`SELECT id::text AS id FROM principals WHERE id = ANY($1::uuid[]) AND kind = 'group' ORDER BY id`, [ownerIds])).rows.map((r) => String(r.id));", 'GROUP_SELF', "card 502fb19e: which owner values are Group principals, for the scope_group_ids display coordinate; it grants nothing"],
  ["services/ChangeRequestService.ts", "if (!group || !row || row.kind !== 'group') throw absentGroup();", 'GROUP_SELF', "card 502fb19e: a Group grantee of a change request must be a Group and its own principal row (one id, migration 146)"],
  ["services/ChangeRequestService.ts", "if (!row || row.kind !== 'service' || !row.parent_principal_id || !(await this.principalReadable(ctx.filer, ctx.accountId, String(row.id), ctx.tier))) {", 'ALLOWLIST', "card 502fb19e: a credential.issue target is an existing Connector only (a parented service principal); every other kind, a Group included, is TARGET_NOT_FOUND"],
  ["services/ChangeRequestService.ts", "if ((targetType === 'knowledge.shared_writer' || targetType === 'knowledge.compartment') && row.kind !== 'human') {", 'GUARDED_NEGATION', "the Group refusal (if (row.kind === 'group')) runs first on the same row"],
  ["services/ChangeRequestService.ts", "if (row.kind === 'group') {", 'REFUSES_GROUP', "card 502fb19e: a Group named as a principal grantee is refused GRANTEE_NOT_ADMISSIBLE; a Group is named with granteeType group"],
  ["services/ChangeRequestService.ts", "if (row.kind === 'group') {", 'REFUSES_GROUP', "card 9ce0b0b0 S4: a Group named as the principal of an identity target is refused GROUP_PRINCIPAL_MANAGED_BY_GROUPS"],
  ["services/ChangeRequestService.ts", "if (change.kind === 'agent') {", 'ALLOWLIST', "card 9ce0b0b0 S4: identity.create's validated input kind (an Agent is AGENT_MINT_ONLY)"],
  ["services/ChangeRequestService.ts", "if (change.kind !== 'human' && change.kind !== 'service') {", 'ALLOWLIST', "card 9ce0b0b0 S4: identity.create creates a human or a service Account only; a Group is never one of them"],
  ["services/ChangeRequestService.ts", "if (change.kind === 'service' && !purpose) {", 'ALLOWLIST', "card 9ce0b0b0 S4: identity.create's validated input kind"],
  ["services/ChangeRequestService.ts", "if (ELEVATED_ROLES.has(role) && change.kind !== 'human') {", 'ALLOWLIST', "card 9ce0b0b0 S4: identity.create's validated input kind, human or service only"],
  ["services/ChangeRequestService.ts", "&& (await pool.query(\"SELECT 1 FROM principals WHERE id = $1 AND kind = 'group'\", [value])).rows.length > 0;", "GROUP_SELF", "card 9ce0b0b0 S5 (E325, section 3): whether a named role holder is a Group, so an unreadable Group answers as an absent principal; the Group refusal follows (TASK_ROLE_GROUP_PRINCIPAL)"],
  ["services/ChangeRequestService.ts", "const groupRow = (await pool.query(\"SELECT 1 FROM principals WHERE id = $1 AND kind = 'group'\", [next])).rows.length > 0;", "GROUP_SELF", "card 9ce0b0b0 S5 (E325, section 3): whether a named default Verifier is a Group, so an unreadable Group answers as an absent principal; the seam's validator then refuses it DEFAULT_VERIFIER_GROUP_PRINCIPAL"],
  ["services/ChangeRequestService.ts", "if (current === owner.id) throw held(`that ${owner.kind === 'group' ? 'Group' : 'Account'} already owns the ${type}`);", "GROUP_SELF", "card 9ce0b0b0 S5 (E325, section 3): the refusal text names a Group owner as a Group"],
  ["services/ChangeRequestService.ts", "if (row.kind !== 'human' || row.status !== 'active' || row.legacy_identity || row.parent_principal_id) throw invalid();", "GUARDED_NEGATION", "card 9ce0b0b0 S5 (E325, section 3): the Group branch above answers a Group owner first (admitted for project.owner and task.account_owner, INVALID_OWNER otherwise)"],
  ["services/ChangeRequestService.ts", "if (row.kind === 'agent' && !row.legacy_identity && row.bound_task_id && lower(String(row.bound_task_id)) !== lower(taskId)) {", "GUARDED_NEGATION", "card 9ce0b0b0 S5 (E325, section 3): CROSS_BOUND_ROLE, after the Group refusal on the same row"],
  ["services/ChangeRequestService.ts", "if (row.kind === 'group') {", "GROUP_SELF", "card 9ce0b0b0 S5 (E325, section 3): a Group named as an owner is admitted only where the target admits a Group owner (an active Group the filer reads), INVALID_OWNER otherwise"],
  ["services/ChangeRequestService.ts", "if (row?.kind === 'group') {", "REFUSES_GROUP", "card 9ce0b0b0 S5 (E325, section 3): a Group named as a Shepherd or Verifier is refused TASK_ROLE_GROUP_PRINCIPAL, as the roles route refuses it"],
  ["services/ReportAccountOwnershipService.ts", "if (!row || row.kind !== 'human' || row.status !== 'active' || row.parent_principal_id || row.legacy_identity) {", "ALLOWLIST", "card 9ce0b0b0 S5 (E325, section 3): a Report is owned by an active human Account only; a Group is never one"],
  ["services/ChangeRequestService.ts", "AND owning_group.kind = 'group' AND owning_group.status = 'active')", 'GROUP_SELF', "card 502fb19e S2 (section 5.2): the Group a live steward row names is an active Group principal, for the decider arm's Group tier; it grants nothing"],
  ["services/ChangeRequestService.ts", "`WITH me AS (SELECT id FROM principals WHERE id = $2 AND kind = 'human' AND status = 'active'", 'ALLOWLIST', "card 502fb19e S2 (section 5.2): the owner-tier decider is a human Account acting as itself; a service Account's steward row is inert as a decider (LENSES-C)"],
  ["services/KnowledgeSharedWriterService.ts", "if (target.kind !== 'human' || target.parent_principal_id) {", 'ALLOWLIST', "card 502fb19e: the approved-change seam admits the same parentless human Account only (SHARED_WRITER_NOT_AN_ACCOUNT), under migration 157's trigger"],
  ["services/KnowledgeSharedWriterService.ts", "if (row.kind !== 'human' || row.parent_principal_id) {", 'ALLOWLIST', "card 549cc51f: a shared-area writer is a parentless human Account only; every other kind, a Group included, is refused SHARED_WRITER_NOT_AN_ACCOUNT (migration 157's trigger backstops it)"],
  ["services/KnowledgeLifecycleExporter.ts", "const accounts=rows.accounts.filter(a=>(c.accountSelection==='all-human'||accountIds.has(a.id))&&a.kind==='human').map(a=>({id:a.id,assertion_sub:s.knowledge_subject_mode==='direct'?a.id:pairwiseSubject(a.id,s.id),label:a.display_name??a.handle,active:a.status==='active'}));", 'ALLOWLIST', "humans only"],
  ["services/KnowledgeLifecycleExporter.ts", "? \"SELECT id,display_name,handle,status,kind FROM principals WHERE kind='human' ORDER BY id LIMIT 10001\"", 'ALLOWLIST', "humans only"],
  ["services/OwnConnectorsService.ts", "AND p.kind = 'service'", 'ALLOWLIST', "Connectors only"],
  ["services/OwnConnectorsService.ts", "WHERE parent_principal_id = ANY($1::uuid[]) AND kind = 'agent'", 'ALLOWLIST', "Agents only"],
  ["services/PrincipalService.ts", "const EXCLUDE_GROUP_PRINCIPALS = \"kind <> 'group'\";", 'GROUP_SELF', "the directory's default exclusion (clause 3h)"],
  ["services/PrincipalService.ts", "* out unless the caller asks for `kind = 'group'`, so no person picker fed", 'PROSE', "comment"],
  ["services/PrincipalService.ts", "if (target.kind === 'agent' && input.scopes.some((scope) => scope.endsWith(':admin'))) {", 'NOT_A_GROUP_ROW', "issueCredential: a Group is refused ACCOUNTS_ARE_KEYLESS (parentless) and by the credential trigger"],
  ["services/PrincipalService.ts", "if (input.kind === 'group') {", 'REFUSES_GROUP', "only the Group writers create a Group principal (GROUP_PRINCIPAL_WRITER_ONLY)"],
  ["services/PrincipalService.ts", "if (row.kind === 'agent' && !row.legacy_identity) {", 'NOT_A_GROUP_ROW', "credential rotation: a credential row never names a Group (migration 146)"],
  ["services/ProjectOwnershipService.ts", "return !!row && row.kind === 'human' && row.status === 'active' && !row.parent_principal_id;", 'ALLOWLIST', "only an active parentless human; a Group target takes the clause 9(a) branch below, behind the standing test (card 311229fd)"],
  ["services/ProjectOwnershipService.ts", "WHERE kind = 'human' AND status = 'active' AND parent_principal_id IS NULL", 'ALLOWLIST', "owner candidates: humans only"],
  // Card a9b1e69c (AZ-A12 build 5, clauses 12-13): the owner fields and the owner-change fan-out.
  ["services/ProjectOwnershipService.ts", "JOIN principals owning_group ON owning_group.id = membership.group_id AND owning_group.kind = 'group'", 'GROUP_SELF', "clause 13: the owner-change hint fans out to the members of an owner value that is a Group's own principal row"],
  ["services/ApprovalHubService.ts", "LEFT JOIN groups og ON og.id = op.id AND op.kind = 'group'", 'GROUP_SELF', "clause 12: the owning Group's name, joined only for an owner that is a Group's own principal row"],
  ["utils/ownerFacts.ts", "LEFT JOIN groups ${group} ON ${group}.id = ${alias}.id AND ${alias}.kind = 'group'`,", 'GROUP_SELF', "clause 12: the owning Group's name, joined only for an owner that is a Group's own principal row"],
  ["utils/ownerFacts.ts", "if (kind === 'group') return 'group';", 'ALLOWLIST', "clause 12: ownerKind names human or group and nothing else (null)"],
  ["utils/ownerFacts.ts", "if (kind === 'human') return 'human';", 'ALLOWLIST', "clause 12: ownerKind names human or group and nothing else (null)"],
  ["utils/ownerFacts.ts", "* (clause 3(h): `GET /principals` leaves `kind='group'` out).", 'PROSE', "a comment"],
  ["services/ProjectOwnershipService.ts", "FROM groups g JOIN principals gp ON gp.id = g.id AND gp.kind = 'group' AND gp.status = 'active'", 'GROUP_SELF', "AZ-A12 clause 12: the Group owner candidates are the Groups' own enabled principals, listed only to root and administrator sessions"],
  ["services/ProjectOwnershipService.ts", "if (creation && targetRow?.kind !== 'group') {", 'ALLOWLIST', "AZ-A12 clause 10(b): the create form selects a Group only; every other kind is refused OWNER_AT_CREATE_GROUP_ONLY"],
  ["services/ProjectOwnershipService.ts", "if (normalizedOwnerId !== null && targetRow?.kind === 'group') {", 'ALLOWLIST', "AZ-A12 clause 9(a): a Group target must be active and admitted by the standing test, else INVALID_OWNER"],
  ["services/ServiceRegistry.ts", "if (!owner || owner.parent_principal_id || owner.kind === 'agent' || owner.status !== 'active' || owner.legacy_identity) {", 'GUARDED_NEGATION', "the Group refusal below names CONNECTOR_NEEDS_ACCOUNT; the chain trigger backstops it"],
  ["services/ServiceRegistry.ts", "if (owner.kind === 'group') {", 'REFUSES_GROUP', "clause 3(b): no Connector under a Group (CONNECTOR_NEEDS_ACCOUNT)"],
  ["services/SkillManager.ts", "if (principal.rows[0]?.kind !== 'human') {", 'ALLOWLIST', "humans only"],
  ["services/SkillManager.ts", "? await client.query(`SELECT id FROM principals WHERE id = $1 AND kind = 'group' AND status = 'active' FOR SHARE`, [targetId])", 'ALLOWLIST', "AZ-A12 clause 9(a): an active Group target, read only after the standing test admitted the caller (card d67e6990)"],
  ["services/SkillManager.ts", "VALUES ($1, $2, FALSE, (SELECT id FROM principals WHERE id = $3::uuid AND kind = 'human'", 'ALLOWLIST', "only an active parentless human Account owns a Skill as a person (card d67e6990)"],
  ["services/SkillManager.ts", "`SELECT id FROM principals WHERE id = $1 AND kind = 'human' AND status = 'active'", 'ALLOWLIST', "only an active parentless human Account owns a Skill as a person (card d67e6990)"],
  ["services/SubscriberActorService.ts", "if (row.kind === 'agent') return { ok: false, refusal: 'SUBSCRIBER_LAYER_INELIGIBLE' };", 'ACTING_CHAIN', "the subscriber is the acting credential holder; a Group holds no credential (migration 146)"],
  ["services/TaskAccountOwnershipService.ts", "WHERE p.id=$1 AND p.kind='human' AND p.status='active' AND p.parent_principal_id IS NULL", 'ALLOWLIST', "only an active parentless human"],
  ["services/TaskAccountOwnershipService.ts", "const target = await client.query(`SELECT id FROM principals WHERE id=$1 AND kind='human' AND status='active'", 'ALLOWLIST', "only an active human target; a Group target takes the clause 9(a) query below (card 311229fd)"],
  ["services/TaskAccountOwnershipService.ts", "const target = await client.query(`SELECT id FROM principals WHERE id=$1 AND kind='human' AND status='active'", 'ALLOWLIST', "LENSES-c gate (ii) (card b5c83682): the OUT target is an active human Account (and, by the gate, an active member of the Group)"],
  ["services/TaskAccountOwnershipService.ts", "const group = groupInvolved ? await client.query(`SELECT id FROM principals WHERE id=$1 AND kind='group' AND status='active' FOR SHARE`, [targetId]) : { rows: [] };", 'ALLOWLIST', "AZ-A12 clause 9(a): an active Group target, read only after the standing test admitted the caller"],
  ["services/TaskArchiveAuthority.ts", "if (!principal || principal.kind !== 'human' || principal.status !== 'active' || principal.parent_principal_id !== null) return refuse();", 'ALLOWLIST', "humans only"],
  ["services/TaskAuthoritySnapshot.ts", "if (acting.kind === 'agent' && !acting.legacyIdentity && acting.boundTaskId !== taskId) return null;", 'ACTING_CHAIN', "the acting chain"],
  ["services/TaskLifecycleAccess.ts", "if (claim.allowed && actor.delegation?.links[0]?.kind === 'service') {", 'ACTING_CHAIN', "the acting chain"],
  ["services/TaskManagerDB.ts", "if (row.kind === 'agent' && !row.legacy_identity && row.bound_task_id && String(row.bound_task_id) !== taskId) {", 'GUARDED_NEGATION', "assignTaskRoles: role ids from PATCH /tasks/:id/roles, which refuses a Group first (TASK_ROLE_GROUP_PRINCIPAL); migration 146 backstops the columns"],
  ["services/WarrantService.ts", "if (holder.kind !== 'service') {", 'ALLOWLIST', "clause 3(f): service holders only, unchanged"],
  ["services/WarrantService.ts", "AND acct.kind = 'service' AND acct.parent_principal_id IS NULL)))", 'ALLOWLIST', "service Accounts only"],
  ["services/identity/IdentityProviderService.ts", "if (row.kind !== 'service' || row.parent_principal_id !== null) {", 'ALLOWLIST', "parentless service Accounts only"],
  ["services/identity/SsoAuthenticationService.ts", "WHERE kind = 'human' AND status = 'active'", 'ALLOWLIST', "humans only"],
  ["config/deploymentIdentity.ts", "if (row.kind !== 'human' || row.parent_principal_id !== null) {", 'ALLOWLIST', "humans only"],
  ["utils/bearerLayers.ts", "* `rh_\u2026` credential on the working plane: `kind = 'agent'` is a task-bound", 'PROSE', "comment"],
  ["routes/delegation.ts", "if (req.principal.kind === 'agent') {", 'ACTING_CHAIN', "the acting principal"],
  ["routes/delegation.ts", "AND acct.kind = 'service' AND acct.parent_principal_id IS NULL))", 'ALLOWLIST', "service Accounts only"],
  ["routes/principals.ts", "if (kind !== 'group') return false;", 'REFUSES_GROUP', "the GROUP_PRINCIPAL_MANAGED_BY_GROUPS guard"],
  ["routes/principals.ts", "|| req.principal.kind !== 'human' || req.principal.parentPrincipalId) {", 'ACTING_CHAIN', "owner-control: the acting human"],
  ["routes/principals.ts", "if (!human || human.kind !== 'human' || human.status !== 'active' || human.parent_principal_id", 'ACTING_CHAIN', "owner-control: the acting human"],
  ["routes/principals.ts", "|| human.legacy_identity || !connector || connector.kind !== 'service'", 'ALLOWLIST', "owner-control: a direct service Connector only (R60)"],
  ["routes/principals.ts", "OR (p.parent_principal_id IS NULL AND p.kind = 'service'", 'ALLOWLIST', "remediation queue: service Accounts only"],
  ["routes/principals.ts", "if (kind !== 'human' && kind !== 'service' && kind !== 'agent') {", 'ALLOWLIST', "POST /principals keeps refusing kind group (clause 1)"],
  ["routes/principals.ts", "if (kind === 'agent') {", 'ALLOWLIST', "POST /principals: the validated input kind"],
  ["routes/principals.ts", "if (kind === 'service' && !purpose) {", 'ALLOWLIST', "POST /principals: the validated input kind"],
  // Card 9ce0b0b0 (S4): the role act's checks moved into the one role-change seam both doors call.
  ["services/PrincipalRoleService.ts", "if (target.kind === 'group') {", 'REFUSES_GROUP', "card 9ce0b0b0: the role-change seam refuses a Group principal by name (GROUP_PRINCIPAL_MANAGED_BY_GROUPS) before every other check, on both doors"],
  ["services/PrincipalRoleService.ts", "if (ELEVATED_ROLES.has(role) && (target.kind !== 'human' || target.parentPrincipalId !== null)) {", 'GUARDED_NEGATION', "the seam's own Group refusal runs first on the same target"],
  ["routes/principals.ts", "const isConnector = target.kind === 'service' && Boolean(target.parentPrincipalId);", 'GUARDED_NEGATION', "the credentials route runs the Group guard first"],
  ["routes/scim.ts", "* WITHDRAWN \u2014 `kind === 'service'`: the registry predicate refuses an Agent", 'PROSE', "comment"],
  ["routes/skills.ts", "if (body.provenance === undefined) body.provenance = req.principal?.kind === 'human' ? 'human-authored' : 'agent-drafted';", 'ACTING_CHAIN', "the acting principal"],
  ["routes/skills.ts", "if (body.provenance === undefined) body.provenance = req.principal?.kind === 'human' ? 'human-authored' : 'agent-drafted';", 'ACTING_CHAIN', "the acting principal"],
  ["routes/tasks.ts", "if (acting?.kind === 'agent') {", 'ACTING_CHAIN', "the acting chain"],
  // Card 41e24358: the default Verifier write and the usable-Verifier predicate.
  ["routes/defaultVerifierRoute.ts", "if (row?.kind === 'group') {", 'REFUSES_GROUP', "clause 3(c): DEFAULT_VERIFIER_GROUP_PRINCIPAL; migration 155 backstops the columns"],
  ["routes/defaultVerifierRoute.ts", "if (row?.kind === 'agent' && !row.legacy_identity) {", 'GUARDED_NEGATION', "the Group refusal above runs first"],
  ["routes/defaultVerifierRoute.ts", "if (owner.kind === 'human' && owner.id && facts.principalId && owner.id === facts.principalId) return 'owner';", 'ALLOWLIST', "admits only a person owner; a Group-owned Project gets no owner arm (Q3 (a)); the acting session's facts (the request's, or a change decider's: card 9ce0b0b0 S5)"],
  ["routes/defaultVerifierRoute.ts", "WHERE status = 'active' AND (kind = 'human' OR kind = 'service' OR (kind = 'agent' AND legacy_identity))", 'ALLOWLIST', "the picker candidates name the kinds they admit; a Group is never one"],
  ["services/VerifierUsability.ts", "if (!row || String(row.status) !== 'active' || row.kind === 'group') {", 'REFUSES_GROUP', "arm 1 of the usable predicate: a Group is never a usable Verifier"],
  ["routes/tasks.ts", "const groupRole = principals.find((principal) => principal?.kind === 'group');", 'REFUSES_GROUP', "clause 3(c): TASK_ROLE_GROUP_PRINCIPAL"],
  ["routes/tasks.ts", "principal && principal.kind === 'agent' && !principal.legacyIdentity", 'GUARDED_NEGATION', "the Group refusal above runs first"],
  ["routes/tasks.ts", "if (shepherd?.kind === 'service' && !scopesSatisfy(scopes, 'services:invoke')) {", 'GUARDED_NEGATION', "the Group refusal above runs first"],
  ["routes/notifications.ts", "if (top.kind !== 'human' || top.parentPrincipalId) return null;", 'ACTING_CHAIN', "E467: the live delegation chain's root must be a human Account; a service Account's Connector is not a person's and gets its own list"],
  ["routes/notifications.ts", "if (!account || account.status !== 'active' || account.kind !== 'human' || account.parentPrincipalId) return null;", 'ALLOWLIST', "E467: the owning Account is an active, parentless human; nothing else is read as a person's queue"],
  ["routes/webhooks.ts", "if (row.kind === 'agent') {", 'ACTING_CHAIN', "the subscriber is the acting credential holder"],
  ["middleware/auth.ts", "if (principal && principal.kind === 'group') {", 'REFUSES_GROUP', "clause 3(a): 401 on the JWT id and handle paths"],
  ["middleware/auth.ts", "if (principal && principal.kind === 'group') {", 'REFUSES_GROUP', "clause 3(a): 401 on the JWT id and handle paths"],
  ["middleware/auth.ts", "if (acting.kind === 'agent' && acting.boundTaskId) {", 'ACTING_CHAIN', "the acting chain"],
  // Card 1e56dbef (AZ-A12 build 6, clause 12): the Access Explorer read model.
  ["services/AccessExplorerService.ts", "if (!row || row.kind === 'group') return null;", "REFUSES_GROUP", "clause 3(a): the read model builds no actor for a Group principal, so it is never evaluated or listed as a holder (card 1e56dbef)"],
  ["services/AccessExplorerService.ts", "const ownerGroups = [owner, projectOwner].filter((entry) => entry?.kind === 'group').map((entry) => entry!.principalId);", "GROUP_SELF", "clause 12: an owner value whose ownerKind is group is shown as the owning Group (directory data)"],
  ["services/AccessExplorerService.ts", "if (summary.kind !== 'group') continue;", "GROUP_SELF", "clause 12: a shape coordinate naming a Group's own principal row moves to the Groups list as owner, never stays a holder"],
  ["services/AccessExplorerService.ts", "if (!summary || summary.kind === 'group') continue;", "REFUSES_GROUP", "clause 3(c): a Group is never listed as a holder; it never acts"],
  ["services/AccessExplorerService.ts", "if (found.kind === 'group') {", "REFUSES_GROUP", "the principal hop refuses a Group principal by name (GROUP_PRINCIPAL_USE_GROUP_VIEW); a Group is explored through its Group hop"],
  ["services/AccessExplorerService.ts", "if (child.kind === 'group') continue;", "NOT_A_GROUP_ROW", "a child row has a parent, and principals_group_shape keeps a Group parentless (migration 146)"],
];

/** The flagged readers may not grow: a new one needs a named refusal instead. */
const FLAGGED_CEILING = 2;

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

function census(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (KIND_COMPARISON.test(line)) {
        found.set(rel, [...(found.get(rel) ?? []), line.trim()]);
      }
    }
  }
  return found;
}

const CENSUS = census();
const REGISTERED = new Map<string, string[]>();
for (const [file, text] of KIND_READER_REGISTER) {
  REGISTERED.set(file, [...(REGISTERED.get(file) ?? []), text]);
}
const FILES = [...new Set([...CENSUS.keys(), ...REGISTERED.keys()])].sort();

describe('C-3 kind-reader register (AZ-A12 clause 1: a fourth kind is admitted by every negation that predates it)', () => {
  it('the census finds kind comparisons at all, and states its command', () => {
    // A census of nothing proves nothing.
    expect(KIND_COMPARISON.source).toContain('human|agent|service|group');
    expect([...CENSUS.values()].flat().length).toBeGreaterThan(50);
  });

  it.each(FILES)('kind-reader register: %s is classified line by line', (file) => {
    const found = [...(CENSUS.get(file) ?? [])].sort();
    const registered = [...(REGISTERED.get(file) ?? [])].sort();
    expect({ file, lines: found }).toEqual({ file, lines: registered });
  });

  it('every refusal clause 3 names is registered, and the flagged readers do not grow', () => {
    const refusals = KIND_READER_REGISTER.filter((entry) => entry[2] === 'REFUSES_GROUP').map((entry) => entry[0]).sort();
    expect([...new Set(refusals)]).toEqual([
      'middleware/auth.ts', 'routes/defaultVerifierRoute.ts', 'routes/principals.ts', 'routes/tasks.ts',
      // Card 1e56dbef: the Access Explorer never evaluates or lists a Group as an actor.
      'services/AccessExplorerService.ts', 'services/AccessProfileService.ts',
      'services/ChangeRequestService.ts',
      // Owner rulings E407 item 2 and E413: the grant-effect evaluator refuses
      // a Group principal as a grantee to evaluate.
      'services/GrantEffectService.ts',
      'services/GrantService.ts', 'services/GroupService.ts', 'services/PrincipalRoleService.ts', 'services/PrincipalService.ts',
      'services/ServiceRegistry.ts',
      // Card 41e24358: arm 1 of the usable-Verifier predicate.
      'services/VerifierUsability.ts',
    ]);
    expect(KIND_READER_REGISTER.filter((entry) => entry[2] === 'BACKSTOPPED_FLAGGED').length).toBeLessThanOrEqual(FLAGGED_CEILING);
  });
});

// ─────────────────────────── the path-id route register ───────────────────────────

type RouteClass =
  | 'GUARDED'                 // a /principals/:id mutation: the Group guard runs first
  | 'REFUSES_BY_CONSTRUCTION' // the target must be a shape a Group never has
  | 'READ'                    // a read; GET /principals lists no Group unless asked
  | 'SELF'                    // the caller's own principal: a Group never authenticates
  | 'CREATE'                  // POST /principals: kind group stays refused (clause 1)
  | 'GROUP_ID'                // a /groups route: the id is the Group's, and so its principal's
  | 'GROUP_ID_STEP_UP'        // the ownership-status act: canonical id before the step-up
  | 'GROUP_ROLE';             // LENSES-c c1-A: a Group role route; the holder is an Account by the 152 trigger's allowlist

const ROUTE_REGISTER: Record<string, RouteClass> = {
  'POST /principals/:id/owner-control': 'REFUSES_BY_CONSTRUCTION',
  'GET /principals': 'READ',
  // Card a2d1e317: the role catalogue names no principal at all.
  'GET /principals/roles': 'READ',
  'GET /principals/me': 'SELF',
  'POST /principals/me/brief': 'SELF',
  'GET /principals/me/effective-access': 'SELF',
  // Card 4e159741 (RH-LENSES-d): the caller's own lenses; no path id at all.
  'GET /principals/me/lenses': 'SELF',
  'GET /principals/me/home-group': 'SELF',
  'PUT /principals/me/home-group': 'SELF',
  'DELETE /principals/me/home-group': 'SELF',
  'PUT /principals/:id/home-group': 'GUARDED',
  'GET /principals/me/directory-group-references': 'SELF',
  'GET /principals/me/connectors': 'SELF',
  'GET /principals/remediation-queue': 'READ',
  'POST /principals': 'CREATE',
  'PATCH /principals/:id': 'GUARDED',
  'POST /principals/:id/role': 'GUARDED',
  'GET /principals/:id/credentials': 'READ',
  'GET /principals/:id/grants': 'READ',
  'POST /principals/:id/credentials': 'GUARDED',
  'PUT /principals/:id/password': 'GUARDED',
  'DELETE /principals/:id/password': 'GUARDED',
  'POST /principals/:id/terminate': 'GUARDED',
  'GET /groups': 'READ',
  'GET /groups/directory-sync': 'READ',
  'GET /groups/:id': 'GROUP_ID',
  'GET /groups/:id/members': 'GROUP_ID',
  'POST /groups': 'GROUP_ID',
  'PATCH /groups/:id': 'GROUP_ID',
  'DELETE /groups/:id': 'GROUP_ID',
  'DELETE /groups/:id/home-pointers': 'GROUP_ID',
  'PUT /groups/:id/ownership-status': 'GROUP_ID_STEP_UP',
  'POST /groups/:id/members': 'GROUP_ID',
  'DELETE /groups/:id/members/:principalId': 'GROUP_ID',
  // LENSES-c c1-A (card 46cfbd1d). The Group id is the Group's; the
  // principal id names a Group ROLE holder, which the 152 holder trigger
  // admits only from {human, service} (a Group principal is never one), and
  // GroupStewardService canonicalizes both ids before any step-up is spent.
  'GET /groups/:id/stewards': 'GROUP_ROLE',
  'GET /groups/:id/grants': 'GROUP_ID',
  'POST /groups/:id/stewards': 'GROUP_ROLE',
  // LENSES-c c1-B (card b5c83682): gate (iii)'s appointment. The Group id is the
  // Group's; the appointee is an Account member, canonicalized before the step-up.
  'POST /groups/:id/managers': 'GROUP_ROLE',
  'DELETE /groups/:id/stewards/:principalId': 'GROUP_ROLE',
  'DELETE /groups/:id/managers/:principalId': 'GROUP_ROLE',
  // Card 1e56dbef (AZ-A12 build 6). SR-3 reads one member through one Group:
  // the Group id is the Group's, the principal id a member, which the 094
  // member trigger admits only from Accounts. The Access Explorer hops are
  // reads; the principal hop refuses a Group principal by name and sends it
  // to the Group hop.
  'GET /groups/:id/members/:principalId/access': 'GROUP_ID',
  'GET /access-explorer/objects/:type/:id': 'READ',
  'GET /access-explorer/groups/:id': 'GROUP_ID',
  'GET /access-explorer/principals/:id': 'READ',
};

interface Declared { route: string; line: number; next: string }

function declaredRoutes(file: string, mount: string): Declared[] {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n');
  const out: Declared[] = [];
  lines.forEach((line, index) => {
    const match = /^router\.(get|post|put|patch|delete)\('([^']*)'/.exec(line);
    if (!match) return;
    const suffix = match[2] === '/' ? '' : match[2];
    out.push({ route: `${match[1].toUpperCase()} ${mount}${suffix}`, line: index + 1, next: lines[index + 1] ?? '' });
  });
  return out;
}

const DECLARED = [
  ...declaredRoutes('routes/principals.ts', '/principals'),
  ...declaredRoutes('routes/groups.ts', '/groups'),
  ...declaredRoutes('routes/accessExplorer.ts', '/access-explorer'),
];

describe('C-3 path-id route register (AZ-A12 clause 2: a Group principal is managed only through /groups)', () => {
  // Card 1e56dbef: DECLARED also carries routes/accessExplorer.ts; the title stays, as the drill declares it.
  it('every route in routes/principals.ts and routes/groups.ts is classified, and no entry outlives its route', () => {
    expect(DECLARED.map((declared) => declared.route).sort()).toEqual(Object.keys(ROUTE_REGISTER).sort());
  });

  it.each(Object.entries(ROUTE_REGISTER).filter(([, klass]) => klass === 'GUARDED').map(([route]) => route))(
    'route register: %s runs the Group guard first, naming itself',
    (route) => {
      const declared = DECLARED.find((candidate) => candidate.route === route);
      expect(declared?.next).toBe(`  if (await refuseGroupPrincipal(req, res, '${route}')) return;`);
    },
  );

  it('the guard resolves the kind BY UUID in SQL, never through the id-keyed read cache', () => {
    const source = fs.readFileSync(path.join(SRC, 'routes/principals.ts'), 'utf8');
    const start = source.indexOf('async function refuseGroupPrincipal(');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain("pool.query('SELECT kind FROM principals WHERE id = $1', [id])");
    expect(body).not.toMatch(/getPrincipalById|=== id\b|id ===/);
  });

  it('the ownership-status act canonicalizes the Group id before it spends the step-up, and binds the act to it', () => {
    const source = fs.readFileSync(path.join(SRC, 'services/GroupService.ts'), 'utf8');
    const start = source.indexOf('  async setOwnershipStatus(');
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    const canonical = body.indexOf('const groupId = canonicalGroupId(id);');
    const consume = body.indexOf('stepUpService.consume(client, {');
    expect(canonical).toBeGreaterThan(-1);
    expect(consume).toBeGreaterThan(canonical);
    expect(body.slice(consume)).toMatch(/action: GROUP_OWNERSHIP_STATUS_ACT,\s+targetId: groupId,/);
  });
});
