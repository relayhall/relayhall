#!/usr/bin/env python3
"""Mutation drill for the universal change request, train T1 slices S1, S2 and S3
(card 502fb19e; design ratified by owner ruling E325; migration 158).

Each control below edits ONE literal anchor in a disposable copy of the tree,
runs `backend/src/__tests__/changeRequestsLive.test.ts` against a REAL
disposable PostgreSQL through the production router, and requires the suite to
go red at EXACTLY the predeclared set of tests, for an assertion (not a
compile error, a timeout or a crashed fixture). Every control reddens a
different set, so no two controls can be satisfied by one assertion.

The controls withdraw, one at a time, what the design binds S1 and S2 to:
  1. the change arm of approvals_kind_shape is removed from migration 158;
  2. a self-decision is admitted (section 5.5);
  3. the apply of an approved writer-list change consumes a SECOND step-up
     (section 5.3: one step-up per decision);
  4. the ELSE arm of approvals_kind_shape is changed (it must stay 148's,
     byte for byte, section 2.3 (c));
  5. the E299 F3 filter is dropped from the snapshot's compartment grants
     (section 7.2 (b));
  6. KNOWLEDGE_NOT_EXPORTED is no longer re-checked at decide (section 4.2, F7);
  7. a compartment's Projects are checked for existence instead of read through
     the filer's authority (section 4.2 TARGET_NOT_FOUND, the point-stage rule);
  8. the directory read of a principal-plane object (a Group or Account
     grantee, a credential's holder, a target Connector) is dropped (section 4.2);
  9. the read of a grant's resource object is dropped from grant.edit and
     grant.revoke filing (section 4.2);
 10. a bearer names another grantee beyond its own credential authority
     (section 4.1 row 5, slice S2: an object beyond own() would answer
     ALREADY_HELD and confirm it exists). S1's control here (grant.rows probing
     held rows on an object the filer cannot read) is re-anchored BY NAME to
     the guard that now precedes it: no bearer names another grantee on an
     object its own authority does not reach, and a self-request names the
     filer, which holds nothing there, so the old probe can no longer disclose;
 11. the grant.revoke audit row of a decided change loses the decision ledger
     (section 7.1).
Slice S2 (sections 4, 5 and 6):
 12. the owner tier reads every source, a write grant included (F4);
 13. a multi-object target partly outside the owner scope is admitted (F2);
 14. the preview shows an owner standing for an object the caller cannot read;
 15. the scoped-decider arm is dropped from the approvals self-scope (5.6);
 16. that arm admits an item by overlap instead of containment (F2);
 17-20. one control per self-approval case (a)-(d) (section 5.5, F6);
 21. an administrator decides a root-ceiling target (section 5.1 (4));
 22. a Group manager decides beyond grant.rows (section 5.2);
 23. the hub's decidable is not the decide route's arm for a change item;
 24. an executor applies an approved change without re-checking the
     decision's evidence (section 5.3);
 25. the relationship diff loses the edges a grant.rows change adds (section 6);
 26. a legacy identity decides a legacy kind (section 5.1 (2), Q20 (a)).
Slice S2, repair round (review round 1):
 27. the requester's own status read, queue row and hub item carry the
     relationship diff and the decider (section 6 "Where shown", B1);
 28. a credential change's diff loses what it reaches: the effectiveAfterEdit
     projection and identitiesReached (section 6, B2);
 29. the hub's decidable ignores self-approval (section 5.5 (a), 5.6);
 30. the hub's decidable ignores the decider's liveness (section 5.1 (2));
 31. the owner tier through a bearer reads the type's read scope, not its
     write scope (section 4.1 row 5, the scope half);
 32. an Account-side owner source counts without the delegation chain that
     gates it (section 4.1 row 5, the own() half);
 33. a Task's owner value also names its Project's owner, so the Project
     owner sees a Task with its own account owner (section 5.2, B1);
 34. the scoped-decider arm reads the display scope arrays, the owners of the
     Projects an item spans (section 5.6, B1);
 35. a credential.issue diff carries the identities that the credential
     request's decision block does not show (section 6, B2).
Slice S3 (sections 4.3, 6 and 9.1):
 36. the MCP tool no longer files kind change (its change fields are refused);
 37. the MCP preview composes the list route instead of the preview;
 38. the MCP status list loses the caller's agent-mint requests;
 39. the requester's notification history names the decider.
The migration controls edit the FILE the suite re-applies and reads; the
database the suite runs against keeps the real migration, so a control is red
only where an assertion reads the file.
The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/change-request-mutations.py --output-dir /tmp/change-request-drill
  python3 scripts/change-request-mutations.py --describe   # checks every anchor, no database
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
SUITE = 'src/__tests__/changeRequestsLive.test.ts'
MIGRATION = 'backend/src/migrations/158_universal_change_requests.sql'
SERVICE = 'backend/src/services/ChangeRequestService.ts'
WRITERS = 'backend/src/services/KnowledgeSharedWriterService.ts'
EXPORTER = 'backend/src/services/KnowledgeLifecycleExporter.ts'
GRANTS = 'backend/src/services/GrantService.ts'
REGISTRY = 'backend/src/mcp/registry.ts'
HISTORY = 'backend/src/services/NotificationHistoryService.ts'

# The tests each control must turn red, by title (assertionResults[].title).
M1 = 'M1: migration 158 re-applies inside a transaction and changes nothing it restates'
M2 = 'M2: the change arm admits a well-formed change row, and the other kinds refuse the change columns'
M3 = "M3: 158 restates 148's agent-mint, authority-edit and ELSE arms byte for byte: its text without the change arm is 148's"
M4 = "M4: the five restated arms equal 158 by deparse, and the grant and credential conjuncts stay 145's (the M-2 reading)"
D10 = 'D10: knowledge.shared_writer: approve adds the writer row with the approval and the expiry, and ONE step-up is consumed'
D12 = "D12: self-decision: the requester's own Account is refused SELF_DECISION_REFUSED without spending its step-up"
D13 = 'D13: self-decision: a member of the Group grantee is refused SELF_DECISION_REFUSED'
D14 = 'D14: KNOWLEDGE_NOT_EXPORTED is re-checked at decide: a selection that drops the subject after filing refuses the approval'
X3 = 'X3: E299 F3: a table row for a subject outside the export selection is filtered, never shipped'
X4 = 'X4: a decided knowledge change no generation carried within 20 generations is marked export stalled, once'
F8 = 'F8: a compartment naming a Project the filer cannot read is answered exactly as an absent one, audited; a readable one files'
F9 = ('F9: a Group, an Account, a credential or a Connector the filer cannot read in the directory is answered exactly as an absent one;'
      ' its own subtree and a reader file')
F10 = 'F10: a grant edit or revoke naming a grant on an object the filer cannot read is answered exactly as an absent grant; a readable one files'
F11 = ('F11: a bearer names another grantee only within its own authority: an object beyond own() is refused OWN_CAP_EXCEEDED exactly as'
       ' an absent one; a self-request on an unreadable object files exactly as on an absent one')
D6 = ('D6: grant.revoke removes the row, writes grant.revoke with the decision ledger, and the originating request records'
      ' approval.revoked')

# Slice S2 (standing, deciders, hub).
APPROVALS = 'backend/src/services/ApprovalService.ts'
HUB = 'backend/src/services/ApprovalHubService.ts'
EXECUTOR = 'backend/src/services/AuthorityEditExecutor.ts'
ROUTE = 'backend/src/routes/approvals.ts'
D5 = 'D5: grant.edit is decided by a root session only; root applies the edit in place'
S2 = ('S2: the owner tier: a Project owner names another grantee on its own objects; a write grantee naming another grantee is refused'
      ' REQUEST_STANDING_NONE (F4)')
S3 = "S3: a target spanning two owners' Projects is refused TARGET_OUT_OF_SCOPE with the split-by-project hint (F2)"
S4 = 'S4: the preview answers what may be requested here and writes nothing; an unreadable object answers exactly as an absent one'
S5 = "S5: a scoped decider sees a stranger's request only on its own objects, 404 elsewhere, and decides it as the owner"
S6 = "S6: an item spanning two owners' Projects is invisible to each owner and decided by root (F2)"
S7 = "S7: self-approval (a): the requester's own Account is refused, the owner tier included"
S8 = 'S8: self-approval (b): the owner who is a member of the Group grantee is refused'
S9 = "S9: self-approval (c): the Account the target credential's holder lies under is refused"
S10 = 'S10: self-approval (d): an Account the approved change names is refused'
S11 = 'S11: an operator-filed root-only target is decided by a root session only'
S12 = ("S12: a Group manager sees and decides grant.rows on its Group's Project, and is refused task.access on the same Project with"
       " the reason shown")
S13 = "S13: a Report author sees its Report's item inside another owner's Project, and that Project's owner is 404-concealed (B1)"
S14 = "S14: a Task's own account owner sees that Task's item, and the Project owner is 404-concealed (B1)"
S15 = 'S15: the decision stores the field and relationship diff; the requester view carries the field diff only'
S16 = 'S16: a legacy-kind item reads through the projection with its relationship diff in the hub (F9)'
S17 = "S17: an executor accepts only the decision's own consumed step-up as evidence: forged evidence is refused STEP_UP_REQUIRED"
S18 = 'S18: a legacy identity is refused DECIDER_NO_LONGER_ADMITTED at decide, for every kind, before the step-up is spent'
S19 = ("S19: the requester's own status read, queue row and hub item carry the field diff only, never the relationship diff or the"
       " decider, on the session and the bearer door (B1)")
S20 = ('S20: a credential.scopes diff projects what the change reaches by the legacy projection: effectiveAfterEdit and'
       ' identitiesReached (B2)')
S21 = "S21: the hub's decidable and refusal answer what decide answers: self-approval (a), the owner tier included"
S22 = "S22: the hub's decidable and refusal answer what decide answers: a decider no longer live"
S23 = "S23: section 4.1 row 5's scope half: a bearer without the type's write scope has no owner standing; one with it files"
S24 = "S24: section 4.1 row 5's own() gate: an Account-side owner source counts only where the delegation chain holds"
S25 = ("S25: a credential.issue diff projects what the new credential could exercise, as the credential request's block shows it,"
       " and no identity (B2)")

# Slice S3 (the surfaces for the first use).
C1 = 'C1: preview over MCP answers what may be requested on a Project and writes nothing'
C2 = 'C2: kind change files over MCP for another grantee; a repeat is refused CHANGE_PENDING naming the same request'
C3 = 'C3: status lists every kind, the agent-mint requests included; the default REST list keeps its bytes'
C4 = "C4: the requester's notification history never names the decider; the decider's does (sections 4.3 and 6)"

CHANGE_ARM = """    WHEN 'change' THEN
      target_type IS NOT NULL AND change_spec IS NOT NULL
      AND jsonb_typeof(change_spec) = 'object'
      AND ((target_id IS NOT NULL) <> (target_objects IS NOT NULL))
      AND (target_objects IS NULL OR (jsonb_typeof(target_objects) = 'array' AND jsonb_array_length(target_objects) > 0))
      AND ((requesting_credential_id IS NOT NULL) <> (session_evidence IS NOT NULL))
      AND reason IS NOT NULL AND char_length(reason) BETWEEN 20 AND 2000
      AND ((grantee_principal_id IS NULL) = (grantee_type IS NULL))
      AND requested_scopes = '[]'::jsonb AND requested_rules = '[]'::jsonb
      AND approved_scopes IS NULL AND approved_rules IS NULL
      AND requested_expires_at IS NULL AND approved_expires_at IS NULL
      AND target_task_id IS NULL AND created_grant_ids IS NULL AND issued_credential_id IS NULL
      AND requested_transport IS NULL AND approved_transport IS NULL AND credential_label IS NULL
      AND edit_object_type IS NULL AND edit_object_id IS NULL AND edit_before IS NULL
      AND edit_requested IS NULL AND edit_approved IS NULL
      AND edit_lifetime IS NULL AND edit_revert_at IS NULL AND edit_reverted_at IS NULL
      AND (requested_lifetime IS NULL OR jsonb_typeof(requested_lifetime) = 'object')
      AND (applied_effect IS NULL OR jsonb_typeof(applied_effect) = 'object')
      AND (reverted_at IS NULL OR status = 'approved')
"""

# (name, file, anchor, replacement, the exact set of tests that must fail)
CONTROLS = [
    ('section 2.3 (c): the change arm is removed from approvals_kind_shape', MIGRATION,
     CHANGE_ARM, '',
     {M1, M2, M3, M4}),
    ('section 5.5: a self-decision is admitted', SERVICE,
     "    if (cases.length > 0) {\n      throw refuse(403, 'SELF_DECISION_REFUSED',",
     "    if (cases.length < 0) {\n      throw refuse(403, 'SELF_DECISION_REFUSED',",
     {D12, D13, S7, S8, S9, S10, S21}),
    ('section 5.3: the apply of an approved writer-list change consumes a second step-up', WRITERS,
     '    await assertDecisionEvidence(client, input.evidence);\n',
     '    await assertDecisionEvidence(client, input.evidence);\n'
     '    await stepUpService.consume(client, { token: input.evidence.tokenId, principalId: input.deciderPrincipalId,'
     ' action: SHARED_WRITER_STEP_UP_ACTIONS.add, targetId: input.accountId });\n',
     {D10}),
    ("section 2.3 (c): the ELSE arm of approvals_kind_shape is no longer 148's", MIGRATION,
     "      AND requested_expires_at <= requested_at + INTERVAL '90 days'\n",
     "      AND requested_expires_at <= requested_at + INTERVAL '91 days'\n",
     {M1, M3, M4}),
    ('section 7.2 (b), E299 F3: the snapshot ships compartment grants for subjects outside the selection', EXPORTER,
     "    grants:p.status!=='active'?[]:(grantSource.find(x=>x.projectId===p.id)?.grants??[])"
     ".filter(g=>g.subject_type==='user'?ids.has(g.subject_id):groupIds.has(g.subject_id))}));",
     "    grants:p.status!=='active'?[]:(grantSource.find(x=>x.projectId===p.id)?.grants??[])"
     ".filter(g=>g.subject_type.length>0||ids.has(g.subject_id)||groupIds.has(g.subject_id))}));",
     {X3, X4}),
    ('section 4.2 (F7): KNOWLEDGE_NOT_EXPORTED is not re-checked at decide', SERVICE,
     "    if (targetType === 'knowledge.compartment') {\n      this.assertExported(",
     "    if (targetType === 'knowledge.compartment' && targetType.length < 0) {\n      this.assertExported(",
     {D14}),
    ('section 4.2: a compartment checks its Projects exist instead of reading them through the filer', SERVICE,
     "    const readable = await authorizationRepository.authorizedIds(ctx.filer, 'project', projectIds, 'read');\n",
     "    const readable = new Set((await pool.query('SELECT id::text AS id FROM projects WHERE id = ANY($1::uuid[])',"
     " [projectIds])).rows.map((r) => String(r.id)));\n",
     {F8}),
    ('section 4.2: the directory read of a principal-plane object is dropped', SERVICE,
     "    return authorizationService.authorizeRoute(filer, requiredScopeFor('GET', `/${family}/${id}`)).allowed;\n",
     "    return authorizationService.authorizeRoute(filer, requiredScopeFor('GET', `/${family}/${id}`)).allowed || family.length > 0;\n",
     {F9}),
    ("section 4.2: a grant edit or revoke no longer reads the grant's resource object", SERVICE,
     "    if (!row.resource_id) return true;\n",
     "    if (!row.resource_id || granteeId.length > 0) return true;\n",
     {F10}),
    ('section 4.1 row 5: a bearer names another grantee beyond its own credential authority', SERVICE,
     "      if (ctx.door === 'bearer' && !selfGrantee && target.targetType === 'grant.rows' && target.rules && target.rules.length > 0) {\n",
     "      if (ctx.door === 'bearer' && !selfGrantee && target.targetType === 'grant.rows' && target.rules && ctx.door.length < 0) {\n",
     {F11}),
    ('section 7.1: the grant.revoke audit of a decided change loses the decision ledger', GRANTS,
     "          ...(decisionLedger ?? {}),\n",
     "          ...(decisionLedger === undefined ? {} : {}),\n",
     {D6}),

    # ── slice S2: standing, deciders and the hub ──
    ('section 4.1 (F4): the owner tier reads every source, a write grant included', SERVICE,
     "          if (!OWNER_SOURCE_BASES.has(source.basis) || !row[`source_${index}`]) return false;\n",
     "          if ((!OWNER_SOURCE_BASES.has(source.basis) && OWNER_SOURCE_BASES.size < 0) || !row[`source_${index}`]) return false;\n",
     {S2, S24}),
    ('section 4.1 (F2): a multi-object target partly outside the owner scope is admitted', SERVICE,
     "    if (owned.length < target.objects.length) {\n",
     "    if (owned.length < 0) {\n",
     {S3}),
    ('section 4.3: the preview shows an owner standing for an object the caller cannot read', SERVICE,
     "    if (filing && changeTargetAdmitsOwnerTier(targetType) && !(filing.unreadByFiler && filing.unreadByFiler.length > 0)\n",
     "    if (filing && changeTargetAdmitsOwnerTier(targetType)\n",
     {S4}),
    ('section 5.6: the scoped-decider arm is dropped from the approvals self-scope', APPROVALS,
     "  return `(${subtree} OR ${changeOwnerScopeCondition(alias, viewerParam)})`;\n",
     "  return subtree;\n",
     {S5, S8, S12, S13, S14, S15}),
    ('section 5.6 (F2): the scoped-decider arm admits an item by overlap, not containment', APPROVALS,
     "        AND NOT EXISTS (SELECT 1 FROM approval_change_objects scope_object WHERE scope_object.approval_id = ${alias}.id\n"
     "          AND NOT (scope_object.owner_ids &&",
     "        AND EXISTS (SELECT 1 FROM approval_change_objects scope_object WHERE scope_object.approval_id = ${alias}.id\n"
     "          AND (scope_object.owner_ids &&",
     {S6}),
    ("section 5.5 (a): the requester's own Account decides", SERVICE,
     "    if (requesterRoot) named.push({ id: requesterRoot, case: 'a' });\n",
     "    if (requesterRoot && requesterRoot.length < 0) named.push({ id: requesterRoot, case: 'a' });\n",
     {D12, S7, S19, S21}),
    ('section 5.5 (b): a member or steward of a Group grantee decides', SERVICE,
     "    if (found?.member || found?.steward) cases.push('b');\n",
     "    if (found?.member === 'never') cases.push('b');\n",
     {D13, S8}),
    ("section 5.5 (c): the target principal's Account decides", SERVICE,
     "      if (holderRoot) named.push({ id: holderRoot, case: 'c' });\n",
     "      if (holderRoot && holderRoot.length < 0) named.push({ id: holderRoot, case: 'c' });\n",
     {S9}),
    ('section 5.5 (d): an Account the approved change names decides', SERVICE,
     "    if (approved.accountId) named.push({ id: String(approved.accountId), case: 'd' });\n",
     "    if (approved.accountId && targetType.length < 0) named.push({ id: String(approved.accountId), case: 'd' });\n",
     {S10}),
    ('section 5.1 (4): an administrator decides a root-ceiling target', SERVICE,
     "    if (viewer.administratorOk && !rootOnly) return { standing: 'administrator', refusal: null };\n",
     "    if (viewer.administratorOk) return { standing: 'administrator', refusal: null };\n",
     {D5, D6, S11}),
    ('section 5.2: a Group manager decides beyond grant.rows', SERVICE,
     "      else if (!personOnly && managerTier && object.group_manager) standing = 'group-manager';\n",
     "      else if (object.group_manager) standing = 'group-manager';\n",
     {S12}),
    ("section 5.6: the hub's decidable is not the decide route's arm for a change item", HUB,
     "      const standing = kind === 'change' ? arm?.standing ?? null\n",
     "      const standing = kind === 'change' ? 'administrator' as const\n",
     {D5, S11, S12, S21, S22}),
    ("section 5.3: an executor applies an approved change without re-checking the decision's evidence", EXECUTOR,
     "    await assertDecisionEvidence(client, input.evidence);\n    const object = await this.lockObject(client, input.type, canonicalId(input.id));\n",
     "    void assertDecisionEvidence;\n    const object = await this.lockObject(client, input.type, canonicalId(input.id));\n",
     {S17}),
    ('section 6: the relationship diff loses the edges a grant.rows change adds', SERVICE,
     "          edge(grantee, object, verb, held.has(`${object}:${verb}`), true, 'grant');\n",
     "          if (verb.length < 0) edge(grantee, object, verb, held.has(`${object}:${verb}`), true, 'grant');\n",
     {S15, S16, S19}),
    ('section 5.1 (2), Q20 (a): a legacy identity decides a legacy kind', ROUTE,
     "    if (!(await approvalService.deciderLive(viewer.principalId))) {\n",
     "    if (viewer.principalId.length < 0) {\n",
     {S18}),

    # ── slice S2, repair round ──
    ("section 6 (B1): the requester's own reads carry the relationship diff and the decider", SERVICE,
     "export function isRequesterSide(cases: readonly string[]): boolean {\n  return cases.includes('a');\n}\n",
     "export function isRequesterSide(cases: readonly string[]): boolean {\n  return cases.includes('a') && cases.length < 0;\n}\n",
     {S19}),
    ('section 6 (B2): a credential change loses the effectiveAfterEdit and identitiesReached edges', SERVICE,
     "  if (reach && (targetType === 'credential.scopes' || targetType === 'credential.issue')) {\n",
     "  if (reach && targetType.length < 0) {\n",
     {S20, S25}),
    ("section 5.5 (a), 5.6: the hub's decidable ignores self-approval", SERVICE,
     "    if (cases.length > 0) return { standing: null, cases, refusal: { status: 403, code: 'SELF_DECISION_REFUSED',",
     "    if (cases.length < 0) return { standing: null, cases, refusal: { status: 403, code: 'SELF_DECISION_REFUSED',",
     {S21}),
    ("section 5.1 (2): the hub's decidable ignores the decider's liveness", SERVICE,
     "    if (!(await approvalService.deciderLive(viewer.principalId))) {\n      return { standing: null, cases, refusal: {\n",
     "    if (viewer.principalId.length < 0 && approvalService) {\n      return { standing: null, cases, refusal: {\n",
     {S22}),
    ("section 4.1 row 5: the owner tier through a bearer reads the type's read scope, not its write scope", SERVICE,
     "      if (!scopesSatisfy(filer.scopes, `${OWNABLE_FAMILY[type]}:write` as never)) continue;\n",
     "      if (!scopesSatisfy(filer.scopes, `${OWNABLE_FAMILY[type]}:read` as never)) continue;\n",
     {S23}),
    ('section 4.1 row 5: an Account-side owner source counts without the delegation chain that gates it', SERVICE,
     "          if (!source.gate) return true;\n",
     "          if (!source.gate || source.gate.length > 0) return true;\n",
     {S24}),
    ("section 5.2 (B1): a Task's owner value also names its Project's owner", SERVICE,
     "            `SELECT t.project_id, COALESCE(t.account_owner_principal_id, p.owner_principal_id) AS owner\n"
     "               FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [object.id])).rows[0];\n"
     "          if (row) { owners = [row.owner]; ",
     "            `SELECT t.project_id, COALESCE(t.account_owner_principal_id, p.owner_principal_id) AS owner, p.owner_principal_id AS project_owner\n"
     "               FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [object.id])).rows[0];\n"
     "          if (row) { owners = [row.owner, row.project_owner]; ",
     {S14}),
    ('section 5.6 (B1): the scoped-decider arm reads the owners of the Projects in the display scope', APPROVALS,
     "          AND NOT (scope_object.owner_ids && (ARRAY[${viewerParam}::uuid] ||",
     "          AND NOT ((scope_object.owner_ids || (SELECT coalesce(array_agg(scope_project.owner_principal_id), '{}'::uuid[])"
     " FROM projects scope_project WHERE scope_project.id = ANY(${alias}.scope_project_ids))) && (ARRAY[${viewerParam}::uuid] ||",
     {S6, S14}),
    ("section 6 (B2): a credential.issue diff reads identities the credential request's block does not show", SERVICE,
     "    { queryable: q, identities: targetType === 'credential.scopes' });\n",
     "    { queryable: q, identities: targetType.length > 0 });\n",
     {S25}),

    # -- slice S3: the surfaces for the first use --
    ('section 9.1: the MCP tool no longer files kind change', REGISTRY,
     "        if (kind === 'change') {\n",
     "        if (kind === 'change' && kind.length < 0) {\n",
     {C2, C3}),
    ('section 4.3: the MCP preview composes the list route instead of the preview', REGISTRY,
     "path: '/delegation/access-requests/preview', query, requiredScope: 'principals:read' }));\n",
     "path: '/delegation/access-requests', query: { ...query, kind: 'change' }, requiredScope: 'principals:read' }));\n",
     {C1}),
    ("section 9.1: the MCP status list loses the caller's agent-mint requests", REGISTRY,
     "          ...(Array.isArray(mints.approvals) ? mints.approvals as Array<Record<string, unknown>> : []),\n",
     "          ...(Array.isArray(mints.approvals) && mints.approvals.length < 0 ? mints.approvals as Array<Record<string, unknown>> : []),\n",
     {C3}),
    ("sections 4.3 and 6: the requester's notification history names the decider", HISTORY,
     "                 WHEN a.requester_principal_id IN (SELECT id FROM my_subtree) THEN NULL\n",
     "                 WHEN a.requester_principal_id IS NULL THEN NULL\n",
     {C4}),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')


def once(text, anchor, replacement):
    count = text.count(anchor)
    if count != 1:
        raise SystemExit(f'anchor matched {count} times, expected 1: {anchor[:100]!r}')
    return text.replace(anchor, replacement, 1)


def fingerprints(tree):
    found = {}
    for path in tree.rglob('*'):
        relative = path.relative_to(tree)
        if path.is_file() and not any(part in IGNORED for part in relative.parts) and not path.name.endswith('.log'):
            found[str(relative)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return found


def require_disposable_database():
    url = urlparse(os.environ.get('RELAYHALL_TEST_DB_URL', ''))
    name = unquote(url.path.lstrip('/'))
    local = url.hostname in ('127.0.0.1', 'localhost', '::1') and re.search('test|contract|fixture', name)
    ci = os.environ.get('CI') == 'true' and url.hostname == 'postgres' and name == 'relayhall_ci'
    if url.scheme not in ('postgres', 'postgresql') or name in ('relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod') \
            or not (local or ci):
        raise SystemExit('RELAYHALL_TEST_DB_URL must name a disposable local test database')


def run_suite(copy, out, label):
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
               '--runTestsByPath', SUITE, '--json', f'--outputFile={report}']
    with (out / f'{label}.log').open('w') as log:
        code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=900).returncode
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--discover', action='store_true',
                        help='report what each control reddens and continue (for writing the must-fail sets)')
    args = parser.parse_args()

    for _, path, anchor, replacement, _ in CONTROLS:
        once((ROOT / path).read_text(), anchor, replacement)
    sets = [frozenset(c[4]) for c in CONTROLS]
    if len(set(sets)) != len(sets) or any(not s for s in sets):
        raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    if args.describe:
        print(json.dumps([{'control': c[0], 'file': c[1], 'mustFail': sorted(c[4])} for c in CONTROLS], indent=2))
        print(f'{len(CONTROLS)} controls, every anchor found exactly once, every must-fail set distinct')
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='change-request-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        code, tests, _ = run_suite(copy, out, 'baseline')
        titles = [t['title'] for t in tests]
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        if len(set(titles)) != len(titles):
            raise SystemExit('two tests share a title, so a declared title would not name one test')
        for _, _, _, _, must_fail in CONTROLS:
            if not set(must_fail) <= set(titles):
                raise SystemExit(f'a declared test is absent from the suite: {sorted(set(must_fail) - set(titles))}')

        for index, (name, path, anchor, replacement, must_fail) in enumerate(CONTROLS, start=1):
            target = copy / path
            original = target.read_text()
            target.write_text(once(original, anchor, replacement))
            try:
                code, tests, suite_messages = run_suite(copy, out, f'control-{index}')
            finally:
                target.write_text(original)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            semantic = code != 0 and [t['title'] for t in tests] == titles and failed == set(must_fail) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': name, 'file': path, 'mustFail': sorted(must_fail),
                             'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {name} -> {sorted(failed)}", flush=True)
            if not semantic and not args.discover:
                raise SystemExit(f'control did not fail at its declared assertions: {name}')
    finally:
        shutil.rmtree(copy, ignore_errors=True)
        after = fingerprints(ROOT)
        (out / 'closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after, 'copyRemoved': not copy.exists(), 'controls': len(receipts),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    print(f'all {len(receipts)} controls red at their declared assertions; source unchanged')


if __name__ == '__main__':
    main()
