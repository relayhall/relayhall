#!/usr/bin/env python3
"""Mutation drill for AZ-A12 build 1, "Groups become principals" (card 20f40e40;
amendment AZ-A12 clauses 1-3 and 15 M-a; drill 11 of the amendment's test
plan).

Each control below edits ONE literal anchor in a disposable copy of the tree -
the TypeScript that refuses a Group principal, or migration 146 itself - and
runs three suites against a REAL disposable PostgreSQL through the production
router and the MCP ingress:

  backend/src/__tests__/groupPrincipalLive.test.ts      (drills 5, 7, 12, M, W)
  backend/src/__tests__/groupPrincipalRegisters.test.ts (the C-3 registers)
  backend/src/__tests__/groupsSubstrate.test.ts         (the mocked /groups surface)

The live suite's first test re-applies migration 146 FROM THE COPY, so a
migration mutation lands in the database before the tests that measure it, and
the next control's run re-applies the original file and restores it (146 is
idempotent: every constraint is dropped and re-added by name, every function is
CREATE OR REPLACE, every trigger DROP IF EXISTS first). A closing baseline run
proves the restore.

A control is RED only when the suites fail at EXACTLY its declared set of
tests, each for an assertion (never a compile error, a timeout or a crashed
fixture). Every control declares a different set, so no two controls can be
satisfied by one assertion, and a mutation that reddens nothing fails the drill.
The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/group-principal-mutations.py --output-dir /tmp/group-principal-drill [--only ID,ID]
  python3 scripts/group-principal-mutations.py --describe   # checks every anchor, no database
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
SUITES = [
    'src/__tests__/groupPrincipalLive.test.ts',
    'src/__tests__/groupPrincipalRegisters.test.ts',
    'src/__tests__/groupsSubstrate.test.ts',
]
MIGRATION = 'backend/src/migrations/146_group_principal_kind.sql'
GROUPS = 'backend/src/services/GroupService.ts'
CARRIAGE = 'backend/src/services/DirectoryCarriageService.ts'
GROUP_ROUTES = 'backend/src/routes/groups.ts'
PRINCIPAL_ROUTES = 'backend/src/routes/principals.ts'
PRINCIPALS = 'backend/src/services/PrincipalService.ts'
AUTH = 'backend/src/middleware/auth.ts'
GRANTS = 'backend/src/services/GrantService.ts'
PROFILES = 'backend/src/services/AccessProfileService.ts'
REGISTRY = 'backend/src/services/ServiceRegistry.ts'
TASK_ROUTES = 'backend/src/routes/tasks.ts'
HANDLES = 'backend/src/utils/credentialAuthority.ts'
WARRANTS = 'backend/src/services/WarrantService.ts'
SCOPES = 'backend/src/utils/scopeMap.ts'
SURFACES = 'backend/src/services/AccessSurfaceService.ts'

MANAGED = 'GROUP_PRINCIPAL_MANAGED_BY_GROUPS'

# ── the tests, by title (assertionResults[].title) ──
BACKFILL = 'backfill: Groups from before 146 gain exactly one kind=group principal each with the canonical handle, and a second run is a no-op'
SELF_HANDLE = 'self-check: a non-Group principal holding a group: handle stops the migration, naming the count'
SELF_ID = 'self-check: a non-Group principal sharing an id with a Group stops the migration, naming the count'
POST_CHECK = 'post-check: a Group whose principal lacks the canonical handle stops the migration'
WRITER = 'POST /groups writes the Group principal in the same statement: kind group, canonical handle, display name, active, no role, no parent'
NAME = 'a name collision is GROUP_NAME_EXISTS, matched by the index name'
BIND = 'Use this group (the directory reference bind) writes the Group principal too'
RENAME = 'renaming a Group carries the Group principal display name in the same transaction'
READ = 'GET /groups and GET /groups/:id read ownershipStatus from the Group principal'
SHAPE = 'principals_group_shape: a Group principal carrying a role or an Agent column is refused; a person with a role is admitted'
HANDLE = 'principals_group_handle: the group: prefix belongs to kind group alone'
CRED = 'principal_credentials refuses a Group principal in raw SQL; a person row is admitted'
SESSION = 'auth_sessions refuses a Group principal in raw SQL; a person row is admitted'
LINK = 'identity_links refuses a Group principal in raw SQL; a person row is admitted'
HOME = 'account_home_groups refuses a Group principal as the Account in raw SQL; a person row is admitted'
MEMBER_ROUTE = 'a Group is never a member of a Group: POST /groups/:id/members refuses MEMBER_NOT_ACCOUNT; a person is added'
MEMBER_SQL = 'a Group is never a member of a Group: the member trigger refuses it in raw SQL; a person row is admitted'
CHAIN_PARENT = 'a Group principal is never a chain parent: raw SQL refuses a Connector and an Agent under one; a Connector under a person is admitted'
CHAIN_SELF = 'a parented Group principal is refused by the chain trigger by name'
CONNECTOR = 'Connector registration under a Group owner is refused CONNECTOR_NEEDS_ACCOUNT; under a person it registers'
GRANT = "grants: granteeType 'principal' naming a Group is refused GROUP_PRINCIPAL_NOT_A_GRANTEE; granteeType 'group' and a person still work"
PROFILE = "profiles: assigneeType 'principal' naming a Group is refused GROUP_PRINCIPAL_NOT_A_GRANTEE; assigneeType 'group' and a person still work"
WARRANT = 'a Group is never a warrant holder: the unchanged holder rule refuses it INVALID_HOLDER_SHAPE'
COLUMN = {c: f'tasks.{c} refuses a Group principal; a person is admitted'
          for c in ('owner_principal_id', 'shepherd_principal_id', 'verifier_principal_id', 'creator_principal_id')}
AUTHOR = 'reports.author_principal_id refuses a Group principal; a person is admitted'
ORDER = 'the tasks backstop fires after trg_tasks_shepherd_fallback (BEFORE triggers fire in name order)'
NO_WRITE = 'the Group backstop functions write nothing: they read NEW and raise or return it'
ROLES = 'PATCH /tasks/:id/roles refuses a Group Shepherd or Verifier by name; a person is assigned'
ROUTE_NAMES = ['PUT /principals/:id/home-group', 'PATCH /principals/:id', 'POST /principals/:id/role',
               'POST /principals/:id/credentials', 'PUT /principals/:id/password', 'DELETE /principals/:id/password',
               'POST /principals/:id/terminate']
ROUTE = {r: f'{MANAGED} on {r}: refused first, both rows unchanged, audited; a person id answers as before' for r in ROUTE_NAMES}
ROUTE_REG = {r: f'route register: {r} runs the Group guard first, naming itself' for r in ROUTE_NAMES}
LIST = 'GET /principals lists no Group; kind=group lists them; kind filters; an unknown kind is 400; includeHidden adds no Group'
MCP = 'relayhall_principal_list through the MCP ingress lists no Group, and still lists people'
POST_PRINCIPALS = 'POST /principals refuses a group: handle by name and still refuses kind group; a person is created'
CREATE_PRINCIPAL = 'createPrincipal refuses kind group: only the Group writers create a Group principal'
JWT_ID = 'a JWT naming a Group is refused 401 on the principal-id path; a person JWT is admitted'
JWT_HANDLE = 'a legacy handle JWT naming a Group is refused 401; a person handle JWT is admitted'
OWNS = 'GROUP_OWNS_OBJECTS answers a count per object type and never an id'
DELETE = 'a cleared Group deletes: principal terminated with terminated_at, groups row gone, Group grants deleted, audited'
PRECEDENCE = 'GROUP_NOT_EMPTY, GROUP_GATES_LOGIN and GROUP_IS_A_HOME_GROUP still answer, and before GROUP_OWNS_OBJECTS'
OPERATOR = 'an operator login session is refused at the /groups root ceiling, and its step-up survives'
BEARER = 'a bearer credential holding root is refused REQUIRES_LOGIN_SESSION, audited, and spends nothing'
STEP_UP = 'a root login session without a valid step-up is refused STEP_UP_REQUIRED, and no refusal before the consume spends the token'
DISABLE = 'a root login session with a step-up disables the Group principal: audited with from, to, reason and stepUpTokenId; the token is spent'
N3 = "while disabled, the Group's grants still admit its members (N3), and a person's own grant is unchanged"
ENABLE = 'a root login session with a step-up enables it again: audited group.principal_enable'
UPPER = 'an uppercase path id behaves identically: the step-up minted for the canonical id is spent through it'
REG_FILE = lambda f: f'kind-reader register: {f} is classified line by line'
REG_ROUTES = 'every route in routes/principals.ts and routes/groups.ts is classified, and no entry outlives its route'
REG_GUARD_SQL = 'the guard resolves the kind BY UUID in SQL, never through the id-keyed read cache'
REG_CANON = 'the ownership-status act canonicalizes the Group id before it spends the step-up, and binds the act to it'
CENSUS = 'the Access-surface boot census classifies PUT /groups/:id/ownership-status as an UNGOVERNED root-session act'
MOCK_DELETE = 'deleting an empty group deletes its grant rows in the same transaction'
MOCK_DUPLICATE = 'create maps ONLY a ux_groups_name_ci collision to GROUP_NAME_EXISTS'
MOCK_CEILING = 'routes every mutation method to root and every listing to principals:read'
MOCK_CEILING_2 = 'no working-plane scope reaches the mutation ceiling (member add via agent → 403 at the route)'


def trigger(name, table, column):
    return (f"CREATE TRIGGER {name}\n  BEFORE INSERT OR UPDATE OF {column} ON {table}\n"
            f"  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_reference('{column}');\n")


def guard(route):
    return f"  if (await refuseGroupPrincipal(req, res, '{route}')) return;\n"


# (id, what it reintroduces, file, anchor, replacement, the exact set of tests that must fail, cleanup SQL or None)
CONTROLS = [
    # ── migration 146: the clause 3(a) guard triggers ──
    ('T1', 'a credential row may name a Group principal', MIGRATION,
     trigger('trg_principal_credentials_not_group', 'principal_credentials', 'principal_id'), '', {CRED}, None),
    ('T2', 'a login session row may name a Group principal', MIGRATION,
     trigger('trg_auth_sessions_not_group', 'auth_sessions', 'principal_id'), '', {SESSION}, None),
    ('T3', 'an Identity link may name a Group principal', MIGRATION,
     trigger('trg_identity_links_not_group', 'identity_links', 'account_principal_id'), '', {LINK}, None),
    ('T4', 'a home pointer may name a Group principal as its Account', MIGRATION,
     trigger('trg_account_home_groups_not_group', 'account_home_groups', 'account_principal_id'), '', {HOME}, None),
    # ── migration 146: the replaced 094 / 096 functions ──
    ('T5', 'the 094 member trigger admits a Group as a member (nested groups)', MIGRATION,
     "  IF member_kind = 'group' THEN\n    RAISE EXCEPTION 'group members must be Accounts (A17.6): a Group is never a member of a Group (AZ-A12 clause 3d)'\n      USING ERRCODE = 'check_violation';\n  END IF;\n",
     '', {MEMBER_SQL}, None),
    ('T6', 'the 096 chain trigger admits a Connector or an Agent under a Group parent', MIGRATION,
     "  IF NEW.parent_principal_id IS NOT NULL\n     AND EXISTS (SELECT 1 FROM principals WHERE id = NEW.parent_principal_id AND kind = 'group') THEN\n",
     "  IF NEW.parent_principal_id IS NOT NULL AND FALSE\n     AND EXISTS (SELECT 1 FROM principals WHERE id = NEW.parent_principal_id AND kind = 'group') THEN\n",
     {CHAIN_PARENT}, None),
    ('T7', 'the 096 chain trigger no longer names a parented Group (only the shape CHECK, unnamed, stops it)', MIGRATION,
     "  IF NEW.kind = 'group' AND NEW.parent_principal_id IS NOT NULL THEN\n",
     "  IF NEW.kind = 'group' AND NEW.parent_principal_id IS NOT NULL AND FALSE THEN\n",
     {CHAIN_SELF}, None),
    # ── migration 146: the clause 3(c) backstop, column by column ──
    ('T8', 'the backstop drops the claimant column', MIGRATION,
     "BEFORE INSERT OR UPDATE OF owner_principal_id, shepherd_principal_id, verifier_principal_id, creator_principal_id ON tasks\n  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor(\n    'owner_principal_id', 'shepherd_principal_id',",
     "BEFORE INSERT OR UPDATE OF shepherd_principal_id, verifier_principal_id, creator_principal_id ON tasks\n  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor(\n    'shepherd_principal_id',",
     {COLUMN['owner_principal_id']}, None),
    ('T9', 'the backstop drops the shepherd column', MIGRATION,
     "BEFORE INSERT OR UPDATE OF owner_principal_id, shepherd_principal_id, verifier_principal_id, creator_principal_id ON tasks\n  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor(\n    'owner_principal_id', 'shepherd_principal_id',",
     "BEFORE INSERT OR UPDATE OF owner_principal_id, verifier_principal_id, creator_principal_id ON tasks\n  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor(\n    'owner_principal_id',",
     {COLUMN['shepherd_principal_id']}, None),
    ('T10', 'the backstop drops the verifier column', MIGRATION,
     "shepherd_principal_id, verifier_principal_id, creator_principal_id ON tasks\n  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor(\n    'owner_principal_id', 'shepherd_principal_id', 'verifier_principal_id', 'creator_principal_id');",
     "shepherd_principal_id, creator_principal_id ON tasks\n  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor(\n    'owner_principal_id', 'shepherd_principal_id', 'creator_principal_id');",
     {COLUMN['verifier_principal_id']}, None),
    ('T11', 'the backstop drops the creator column', MIGRATION,
     "verifier_principal_id, creator_principal_id ON tasks\n  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor(\n    'owner_principal_id', 'shepherd_principal_id', 'verifier_principal_id', 'creator_principal_id');",
     "verifier_principal_id ON tasks\n  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor(\n    'owner_principal_id', 'shepherd_principal_id', 'verifier_principal_id');",
     {COLUMN['creator_principal_id']}, None),
    ('T12', 'reports.author_principal_id loses its backstop', MIGRATION,
     "CREATE TRIGGER trg_reports_unassignable_group_principal\n  BEFORE INSERT OR UPDATE OF author_principal_id ON reports\n  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor('author_principal_id');\n",
     '', {AUTHOR}, None),
    ('T13', 'the tasks backstop is named to fire BEFORE the shepherd fallback', MIGRATION,
     "DROP TRIGGER IF EXISTS trg_tasks_unassignable_group_principal ON tasks;\nCREATE TRIGGER trg_tasks_unassignable_group_principal\n",
     "DROP TRIGGER IF EXISTS trg_tasks_unassignable_group_principal ON tasks;\nDROP TRIGGER IF EXISTS trg_tasks_a_unassignable_group_principal ON tasks;\nCREATE TRIGGER trg_tasks_a_unassignable_group_principal\n",
     {ORDER}, 'DROP TRIGGER IF EXISTS trg_tasks_a_unassignable_group_principal ON tasks'),
    ('T14', 'the backstop WRITES (assigns NEW) instead of only reading it', MIGRATION,
     "  candidate jsonb := to_jsonb(NEW);\n  column_name text;\n  referenced uuid;\nBEGIN\n",
     "  candidate jsonb := to_jsonb(NEW);\n  column_name text;\n  referenced uuid;\nBEGIN\n  NEW.updated_at := NEW.updated_at;\n",
     {NO_WRITE}, None),
    # ── migration 146: the two CHECKs, the backfill and its checks ──
    ('T15', 'principals_group_handle is dropped: the group: prefix is no longer reserved', MIGRATION,
     "ALTER TABLE principals ADD CONSTRAINT principals_group_handle\n  CHECK ((kind = 'group') = (handle LIKE 'group:%'));\n",
     '', {HANDLE}, None),
    ('T16', 'principals_group_shape is dropped: a Group may carry a role and Agent columns', MIGRATION,
     "ALTER TABLE principals ADD CONSTRAINT principals_group_shape\n  CHECK (kind <> 'group' OR (\n    parent_principal_id IS NULL AND role IS NULL AND bound_task_id IS NULL\n    AND own_expression IS NULL AND owner_control_account_id IS NULL\n    AND personality_id IS NULL AND minted_under_warrant_id IS NULL\n    AND purpose IS NULL AND harness IS NULL AND source_tag IS NULL\n    AND NOT legacy_identity));\n",
     '', {SHAPE}, None),
    ('T17', 'the backfill is skipped: a Group from before 146 gets no principal', MIGRATION,
     "INSERT INTO principals (id, kind, handle, display_name, status)\nSELECT g.id, 'group', 'group:' || g.id::text, left(g.name, 255), 'active'\n  FROM groups g\n WHERE NOT EXISTS (SELECT 1 FROM principals p WHERE p.id = g.id);\n",
     '', {BACKFILL}, None),
    ('T18', 'the post-check is skipped: a mis-handled Group principal passes', MIGRATION,
     "  IF unpaired > 0 THEN\n", "  IF unpaired > 0 AND FALSE THEN\n", {POST_CHECK}, None),
    ('T19', 'the self-check does not count reserved-prefix handles', MIGRATION,
     "  IF prefixed > 0 THEN\n", "  IF prefixed > 0 AND FALSE THEN\n", {SELF_HANDLE}, None),
    ('T20', 'the self-check does not count principals sharing a Group id', MIGRATION,
     "  IF colliding > 0 THEN\n", "  IF colliding > 0 AND FALSE THEN\n", {SELF_ID}, None),
    # ── the writers ──
    ('W1', 'GroupService.create writes the Group principal without the Group name', GROUPS,
     "           SELECT minted.id, 'group', 'group:' || minted.id::text, $1::text, 'active'\n             FROM (SELECT gen_random_uuid() AS id) minted\n           RETURNING id\n         )\n         INSERT INTO groups (id, name, description, created_by_principal_id)",
     "           SELECT minted.id, 'group', 'group:' || minted.id::text, 'unnamed', 'active'\n             FROM (SELECT gen_random_uuid() AS id) minted\n           RETURNING id\n         )\n         INSERT INTO groups (id, name, description, created_by_principal_id)",
     {WRITER}, None),
    ('W2', 'the directory reference bind writes the Group principal without the Group name', CARRIAGE,
     "             SELECT minted.id, 'group', 'group:' || minted.id::text, $1::text, 'active'",
     "             SELECT minted.id, 'group', 'group:' || minted.id::text, 'unnamed', 'active'",
     {BIND}, None),
    ('W3', 'a rename no longer carries the Group principal display name', GROUPS,
     "      if (changed.name !== undefined) {\n        // AZ-A12 clause 2 (R69)",
     "      if (changed.name !== undefined && sets.length < 0) {\n        // AZ-A12 clause 2 (R69)",
     {RENAME}, None),
    ('W4', 'create maps every duplicate key to GROUP_NAME_EXISTS again', GROUPS,
     "      await client.query('ROLLBACK');\n      if (isUniqueViolationOn(e, 'ux_groups_name_ci')) {",
     "      await client.query('ROLLBACK');\n      if (e instanceof Error && e.message.includes('duplicate key')) {",
     {MOCK_DUPLICATE}, None),
    ('W5', 'create matches the wrong index name, so a real name collision escapes as a 500', GROUPS,
     "      await client.query('ROLLBACK');\n      if (isUniqueViolationOn(e, 'ux_groups_name_ci')) {",
     "      await client.query('ROLLBACK');\n      if (isUniqueViolationOn(e, 'ux_groups_name_cx')) {",
     {NAME, MOCK_DUPLICATE}, None),
    ('W6', 'the Group read model stops carrying ownershipStatus', GROUPS,
     "    ownershipStatus: (row.ownership_status as GroupOwnershipStatus | null | undefined) ?? null,",
     "    ownershipStatus: null as GroupOwnershipStatus | null,",
     {READ, WRITER, DELETE, DISABLE, ENABLE}, None),
    # ── clause 3 refusals in the services and routes ──
    ('S1', 'addMember admits a Group (only the member trigger stops it, as a 500)', GROUPS,
     "      throw err(422, 'MEMBER_NOT_ACCOUNT', 'group members must be Accounts (A17.6): a Group is never a member of a Group', 'accountPrincipalId');",
     "      void err;", {MEMBER_ROUTE}, None),
    ('S2', "grants admit a Group principal as a granteeType 'principal' grantee", GRANTS,
     "        throw err(422, 'GROUP_PRINCIPAL_NOT_A_GRANTEE', GROUP_GRANTEE_MESSAGE, 'granteeId');",
     "        void GROUP_GRANTEE_MESSAGE;", {GRANT}, None),
    ('S3', 'profile assignments admit a Group principal as a principal assignee', PROFILES,
     "        throw err(422, 'GROUP_PRINCIPAL_NOT_A_GRANTEE', GROUP_ASSIGNEE_MESSAGE, 'assigneeId');",
     "        void GROUP_ASSIGNEE_MESSAGE;", {PROFILE}, None),
    ('S4', 'Connector registration admits a Group owner (only the chain trigger stops it, as a 500)', REGISTRY,
     "          throw err(422, 'CONNECTOR_NEEDS_ACCOUNT', 'A Connector parent must be an Account; a Group principal is never a parent (AZ-A12 clause 3b)');",
     "          void err;", {CONNECTOR}, None),
    ('S5', 'PATCH /tasks/:id/roles admits a Group Shepherd or Verifier (only the backstop stops it, as a 500)', TASK_ROUTES,
     "    if (groupRole) {\n", "    if (groupRole && roleIds.length < 0) {\n", {ROLES}, None),
    ('S6', 'POST /principals no longer names the reserved group: prefix', HANDLES,
     "  if (value.toLowerCase().startsWith('group:')) {\n", "  if (value.toLowerCase().startsWith('group:') && value.length < 0) {\n",
     {POST_PRINCIPALS}, None),
    ('S7', 'createPrincipal creates a Group principal outside the Group writers', PRINCIPALS,
     "      throw new GroupPrincipalWriterError();", "      void GroupPrincipalWriterError;", {CREATE_PRINCIPAL}, None),
    ('S8', 'the warrant holder rule admits a Group (clause 3f, stated unchanged)', WARRANTS,
     "    if (holder.kind !== 'service') {", "    if (holder.kind !== 'service' && holder.kind !== 'group') {",
     {WARRANT, REG_FILE('services/WarrantService.ts')}, None),
    ('S9', 'the JWT principal-id path admits a token naming a Group', AUTH,
     "      // naming one is answered exactly like a disabled identity's.\n      if (principal && principal.kind === 'group') {\n        res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });\n        return;\n      }",
     "      // naming one is answered exactly like a disabled identity's.\n      if (principal && principal.kind === 'group') {\n        void res;\n      }",
     {JWT_ID}, None),
    ('S10', 'the JWT handle path admits a token naming a Group', AUTH,
     "      // AZ-A12 clause 3(a): the handle path refuses a Group principal too.\n      if (principal && principal.kind === 'group') {\n        res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });\n        return;\n      }",
     "      // AZ-A12 clause 3(a): the handle path refuses a Group principal too.\n      if (principal && principal.kind === 'group') {\n        void res;\n      }",
     {JWT_HANDLE}, None),
    ('S11', 'the directory lists Group principals by default (listPrincipals loses its exclusion)', PRINCIPALS,
     "      conditions.push(EXCLUDE_GROUP_PRINCIPALS);", "      void EXCLUDE_GROUP_PRINCIPALS;", {LIST, MCP}, None),
    ('S12', 'a new kind comparison lands without a classification', PROFILES,
     "        throw err(422, 'GROUP_PRINCIPAL_NOT_A_GRANTEE', GROUP_ASSIGNEE_MESSAGE, 'assigneeId');\n      }\n",
     "        throw err(422, 'GROUP_PRINCIPAL_NOT_A_GRANTEE', GROUP_ASSIGNEE_MESSAGE, 'assigneeId');\n      }\n      if (row.kind !== 'agent') void row;\n",
     {REG_FILE('services/AccessProfileService.ts')}, None),
    ('S13', 'a new /principals/:id route lands unclassified', PRINCIPAL_ROUTES,
     "export default router;\n",
     "router.post('/:id/unregistered', async (_req: AuthRequest, res: Response): Promise<void> => { res.status(404).end(); });\n\nexport default router;\n",
     {REG_ROUTES}, None),
    ('S14', 'the guard resolves the kind through the id-keyed read cache', PRINCIPAL_ROUTES,
     "    const row = await pool.query('SELECT kind FROM principals WHERE id = $1', [id]);\n    kind = row.rows[0]?.kind ?? null;",
     "    kind = (await principalService.getPrincipalById(id))?.kind ?? null;",
     {REG_GUARD_SQL}, None),
] + [
    (f'R{index}', f'{route} loses the Group guard', PRINCIPAL_ROUTES, guard(route), '', {ROUTE[route], ROUTE_REG[route]}, None)
    for index, route in enumerate(ROUTE_NAMES, start=1)
] + [
    # ── drill 7: deletion ──
    ('D1', 'GROUP_OWNS_OBJECTS is withdrawn: a Group that owns objects deletes and orphans them', GROUPS,
     "      if (owned.projects + owned.tasks + owned.reports + owned.skills > 0) {", "      if (owned.projects + owned.tasks + owned.reports + owned.skills < 0) {",
     {OWNS}, None),
    ('D2', 'delete no longer terminates the Group principal', GROUPS,
     "        `UPDATE principals SET status = 'terminated', terminated_at = NOW(), updated_at = NOW()\n          WHERE id = $1 AND kind = 'group' RETURNING id`,",
     "        `UPDATE principals SET updated_at = NOW()\n          WHERE id = $1 AND kind = 'group' RETURNING id`,",
     {DELETE, MOCK_DELETE}, None),
    ('D3', 'GROUP_OWNS_OBJECTS answers before the three existing refusals', GROUPS,
     "      const members = await client.query(\n        'SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = $1', [id],",
     "      const early = await this.ownedCounts(id, client);\n      if (early.projects > 0) throw new GroupError(409, 'GROUP_OWNS_OBJECTS', 'early', undefined, { owned: early });\n      const members = await client.query(\n        'SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = $1', [id],",
     {PRECEDENCE}, None),
    # ── drill 12: the ownership-status act ──
    ('E1', 'the step-up is never consumed', GROUPS,
     "        const evidence = await stepUpService.consume(client, {\n          token: stepUp.token,\n          principalId: stepUp.principalId,\n          action: GROUP_OWNERSHIP_STATUS_ACT,\n          targetId: groupId,\n        });",
     "        const evidence = { tokenId: `${stepUp.token.length}`, method: 'none' };\n        void stepUpService;",
     {STEP_UP, DISABLE, ENABLE, UPPER, REG_CANON}, None),
    ('E2', 'the login-session test is skipped: a bearer holding root performs the act', GROUP_ROUTES,
     "    const session = classifyLoginSession(req.authMethod, \"Enabling or disabling a Group's ownership\");\n    if (!session.ok) {",
     "    const session = classifyLoginSession(req.authMethod, \"Enabling or disabling a Group's ownership\");\n    if (!session.ok && Object.keys(body).length < 0) {",
     {BEARER}, None),
    ('E3', 'the act no longer canonicalizes the Group id before the step-up', GROUPS,
     "    const groupId = canonicalGroupId(id);\n    const to: GroupOwnershipStatus",
     "    const groupId = requireGroupId(id);\n    const to: GroupOwnershipStatus",
     {UPPER, REG_CANON}, None),
    ('E4', '"already in that state" no longer refuses before the consume, so it spends the step-up', GROUPS,
     "      if (from === to) {", "      if (from === to && input.reason.length < 0) {", {STEP_UP}, None),
    ('E5', 'disabling the ownership also deletes the Group grants (note N3 broken)', GROUPS,
     "        `UPDATE principals SET status = $2, updated_at = NOW() WHERE id = $1 AND kind = 'group'`,\n        [groupId, to],\n      );",
     "        `UPDATE principals SET status = $2, updated_at = NOW() WHERE id = $1 AND kind = 'group'`,\n        [groupId, to],\n      );\n      if (to === 'disabled') await client.query(\"DELETE FROM grants WHERE grantee_type = 'group' AND grantee_id = $1\", [groupId]);",
     {N3}, None),
    ('E7', 'the ownership-status family drops out of the Access-surface census: a full boot refuses to serve', SURFACES,
     "    family: 'PUT /groups/:id/ownership-status',", "    family: 'PUT /groups/:id/ownership-status-retired',",
     {CENSUS}, None),
    ('E6', 'the /groups non-GET ceiling drops from root (an operator session reaches the act)', SCOPES,
     "  { pattern: /^\\/groups(\\/|$)/, scope: 'root' },", "  { pattern: /^\\/groups(\\/|$)/, scope: 'principals:read' },",
     {OPERATOR, MOCK_CEILING, MOCK_CEILING_2, CENSUS}, None),
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
    return url


def run_sql(copy, sql):
    script = ("const { Client } = require('pg');"
              "const c = new Client({ connectionString: process.env.RELAYHALL_TEST_DB_URL });"
              "c.connect().then(() => c.query(process.argv[1])).then(() => c.end()).catch((e) => { console.error(e.message); process.exit(1); });")
    subprocess.run(['node', '-e', script, sql], cwd=copy / 'backend', check=True, timeout=120)


def run_suites(copy, out, label):
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
               '--runTestsByPath', *SUITES, '--json', f'--outputFile={report}']
    with (out / f'{label}.log').open('w') as log:
        code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=1800).returncode
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--only', help='comma-separated control ids to run (the full table is still checked)')
    args = parser.parse_args()

    for _, _, path, anchor, replacement, _, _ in CONTROLS:
        once((ROOT / path).read_text(), anchor, replacement)
    ids = [c[0] for c in CONTROLS]
    sets = [frozenset(c[5]) for c in CONTROLS]
    if len(set(ids)) != len(ids):
        raise SystemExit('two controls share an id')
    if len(set(sets)) != len(sets) or any(not s for s in sets):
        raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    selected = CONTROLS
    if args.only:
        wanted = set(args.only.split(','))
        unknown = wanted - set(ids)
        if unknown:
            raise SystemExit(f'unknown control ids: {sorted(unknown)}')
        selected = [c for c in CONTROLS if c[0] in wanted]
    if args.describe:
        print(json.dumps([{'id': c[0], 'reintroduces': c[1], 'file': c[2], 'mustFail': sorted(c[5])} for c in selected], indent=2))
        print(f'{len(selected)} controls, every anchor found exactly once, every must-fail set distinct')
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='group-principal-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        code, tests, _ = run_suites(copy, out, 'baseline')
        titles = [t['title'] for t in tests]
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        # jest orders the three files by its own timing cache, so test lists are
        # compared as sets of titles, never as sequences.
        if len(set(titles)) != len(titles):
            raise SystemExit('two tests share a title, so a declared title would not name one test')
        for control in CONTROLS:
            if not set(control[5]) <= set(titles):
                raise SystemExit(f'{control[0]}: a declared test is absent from the suites: {sorted(set(control[5]) - set(titles))}')
        print(f'baseline green: {len(titles)} tests', flush=True)

        for control_id, reintroduces, path, anchor, replacement, must_fail, cleanup in selected:
            target = copy / path
            original = target.read_text()
            target.write_text(once(original, anchor, replacement))
            try:
                code, tests, suite_messages = run_suites(copy, out, f'control-{control_id}')
            finally:
                target.write_text(original)
                if cleanup:
                    run_sql(copy, cleanup)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            semantic = code != 0 and sorted(t['title'] for t in tests) == sorted(titles) and failed == set(must_fail) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': control_id, 'reintroduces': reintroduces, 'file': path,
                             'mustFail': sorted(must_fail), 'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {control_id} {reintroduces} -> {len(failed)} failed", flush=True)
            if not semantic:
                print(f'   expected {sorted(must_fail)}\n   failed   {sorted(failed)}', flush=True)

        # The closing run re-applies the ORIGINAL migration and proves the restore.
        code, tests, _ = run_suites(copy, out, 'closure')
        closure_green = code == 0 and all(t['status'] == 'passed' for t in tests) and sorted(t['title'] for t in tests) == sorted(titles)
        print(f"closure baseline {'green' if closure_green else 'NOT GREEN'}", flush=True)
    finally:
        shutil.rmtree(copy, ignore_errors=True)
        after = fingerprints(ROOT)
        (out / 'source-closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after, 'copyRemoved': not copy.exists(), 'controls': len(receipts),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    misses = [r['control'] for r in receipts if not r['red']]
    if misses or not closure_green:
        raise SystemExit(f'controls that did not fail at their declared assertions: {misses}; closure green: {closure_green}')
    print(f'all {len(receipts)} controls red at their declared assertions; closure green; source unchanged')


if __name__ == '__main__':
    main()
