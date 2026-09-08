#!/usr/bin/env node
/**
 * test-s1-groups-live.js — RH-P3.AZ-S1 (card c3716fe7; design 4d961e37 §3,
 * A17.6, AZ-30): behavioral proof of the Groups substrate against a real
 * migrated PostgreSQL, through the PRODUCTION services (GroupService,
 * GrantService, AuthorizationRepository) — never SQL substrings:
 *   - the 094 triggers refuse an agent-kind member and a group-id UPDATE;
 *   - a group grant reaches a member through the production authorization
 *     path (authorizedIds) and never reaches a non-member (two-principal);
 *   - T34: disabling the member Account kills group-derived authority on
 *     the very next query; re-enabling restores it; removal kills it;
 *   - T31: a directory snapshot drops directory rows it no longer lists;
 *   - T33: local rows survive that same snapshot untouched;
 *   - T32: a failed sync keeps the snapshot and only moves the attempt
 *     watermark; staleness trips once last_success_at exceeds threshold;
 *   - deleting a group deletes its grant rows in the same transaction.
 *
 * Run with DB_* env pointed at a DISPOSABLE database carrying the full
 * migration chain (prepare with test-fresh-install-replay.js). Exit 0 =
 * all proofs.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const probe = `
import { pool } from "../src/db/connection";
import { groupService } from "../src/services/GroupService";
import { grantService } from "../src/services/GrantService";
import { authorizationRepository } from "../src/services/AuthorizationRepository";
import { randomUUID } from "crypto";

const ACTOR = { principalId: null, handle: "s1-live-proof", authMethod: "system" as const };

async function main() {
  const tag = "s1-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};
  const mkPrincipal = async (kind: string) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO principals (id, kind, handle, display_name, status) VALUES ($1,$2,$3,$4,'active')",
      [id, kind, tag + "-" + kind + "-" + randomUUID().slice(0, 6), "S1 live " + kind]);
    return id;
  };
  const memberA = await mkPrincipal("service");
  const outsiderB = await mkPrincipal("service");
  const agentX = await mkPrincipal("agent");
  const taskId = randomUUID();
  await pool.query(
    "INSERT INTO tasks (id, title, description, status, priority) VALUES ($1,$2,'','todo','normal')",
    [taskId, "S1 live probe " + tag]);

  const group = await groupService.create({ name: "s1-live " + tag }, ACTOR);
  await groupService.addMember(group.id, { accountPrincipalId: memberA }, ACTOR);

  // Trigger proofs (raw SQL on purpose: the trigger IS the defense).
  out.agentMemberRefused = await pool.query(
    "INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1,$2,'local')",
    [group.id, agentX]).then(() => false, (e) => /Accounts/.test(String(e.message)));
  out.idImmutable = await pool.query(
    "UPDATE groups SET id = $1 WHERE id = $2", [randomUUID(), group.id])
    .then(() => false, (e) => /immutable/.test(String(e.message)));
  const parentedC = randomUUID();
  await pool.query(
    "INSERT INTO principals (id, kind, handle, display_name, status, parent_principal_id) VALUES ($1,'service',$2,'S1 parented','active',$3)",
    [parentedC, tag + "-parented-" + randomUUID().slice(0, 6), memberA]);
  out.parentedMemberRefusedTyped = await groupService
    .addMember(group.id, { accountPrincipalId: parentedC }, ACTOR)
    .then(() => false, (e: any) => e.code === "MEMBER_NOT_ACCOUNT");
  out.parentedMemberRefusedTrigger = await pool.query(
    "INSERT INTO group_members (group_id, account_principal_id, source) VALUES ($1,$2,'local')",
    [group.id, parentedC]).then(() => false, (e) => /parentless/.test(String(e.message)));

  await grantService.create(
    { granteeType: "group", granteeId: group.id, resourceType: "task", resourceId: taskId, verb: "read" },
    ACTOR);

  const actorFor = (principalId: string) => ({
    principalId, handle: "probe", role: "agent", scopes: ["tasks:read"], authenticated: true,
  });
  const canRead = async (principalId: string) =>
    (await authorizationRepository.authorizedIds(actorFor(principalId), "task", [taskId], "read")).has(taskId);

  out.memberAuthorized = await canRead(memberA);
  out.outsiderNotAuthorized = !(await canRead(outsiderB));

  // T34: suspension silences group authority IMMEDIATELY.
  await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [memberA]);
  out.disabledMemberSilenced = !(await canRead(memberA));
  await pool.query("UPDATE principals SET status = 'active' WHERE id = $1", [memberA]);
  out.reenabledMemberRestored = await canRead(memberA);

  // Membership removal kills authority.
  await groupService.removeMember(group.id, memberA, ACTOR);
  out.removedMemberSilenced = !(await canRead(memberA));

  // AZ-30 sync semantics on a second group: A local (survives), B directory.
  const group2 = await groupService.create({ name: "s1-live-sync " + tag }, ACTOR);
  await groupService.addMember(group2.id, { accountPrincipalId: memberA, source: "local" }, ACTOR);
  await groupService.addMember(group2.id, { accountPrincipalId: outsiderB, source: "directory" }, ACTOR);
  // Snapshot no longer lists B (or anyone) for group2:
  const sync1 = await groupService.applyDirectorySnapshot("s1-idp-" + tag, [], ACTOR);
  const remaining = await groupService.members(group2.id);
  out.t31DirectoryRowDropped = sync1.removed >= 1
    && !remaining.some(m => m.accountPrincipalId === outsiderB);
  out.t33LocalRowSurvives = remaining.some(
    m => m.accountPrincipalId === memberA && m.source === "local");

  // T32: failure keeps the snapshot, moves only the attempt watermark.
  const before = (await groupService.syncStatus()).find(s => s.provider === "s1-idp-" + tag)!;
  await groupService.recordSyncFailure("s1-idp-" + tag);
  const after = (await groupService.syncStatus()).find(s => s.provider === "s1-idp-" + tag)!;
  const stillThere = await groupService.members(group2.id);
  out.t32SnapshotKept = stillThere.some(m => m.accountPrincipalId === memberA)
    && String(after.lastSuccessAt) === String(before.lastSuccessAt)
    && after.lastErrorPresent === true
    && after.stale === false;
  await pool.query(
    "UPDATE directory_sync_state SET last_success_at = NOW() - INTERVAL '25 hours' WHERE provider = $1",
    ["s1-idp-" + tag]);
  out.t32StalenessTrips = (await groupService.syncStatus())
    .find(s => s.provider === "s1-idp-" + tag)!.stale === true;

  // Group delete removes its grant rows in the same transaction.
  out.deleteRefusedWhileMember = await groupService.remove(group2.id, ACTOR)
    .then(() => false, (e: any) => e.code === "GROUP_NOT_EMPTY");
  await groupService.removeMember(group2.id, memberA, ACTOR);
  await groupService.remove(group2.id, ACTOR);
  await groupService.remove(group.id, ACTOR);
  out.grantsGoneWithGroup = (await pool.query(
    "SELECT COUNT(*)::int AS n FROM grants WHERE grantee_type = 'group' AND grantee_id = $1",
    [group.id])).rows[0].n === 0;

  console.log(JSON.stringify(out));

  // Tidy the disposable DB for repeat runs.
  // (audit_events is append-only by trigger — probe audit rows stay, which
  // is itself the correct behavior for the ledger.)
  await pool.query("DELETE FROM directory_sync_state WHERE provider = $1", ["s1-idp-" + tag]);
  await pool.query("DELETE FROM tasks WHERE id = $1", [taskId]);
  await pool.query("DELETE FROM principals WHERE id = ANY($1::uuid[])", [[parentedC, memberA, outsiderB, agentX]]);
  await pool.end();

  const failures = Object.entries(out).filter(([, value]) => typeof value === "boolean" && !value);
  if (failures.length > 0) {
    console.error("FAILED:", failures.map(([key]) => key).join(", "));
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
`;

const fs = require("fs");
const tmp = path.join(__dirname, ".s1-groups-probe.ts");
fs.writeFileSync(tmp, probe);
const result = spawnSync(path.join(__dirname, "..", "node_modules", ".bin", "tsx"), [tmp], {
  stdio: "inherit", env: process.env, cwd: path.join(__dirname, ".."),
});
fs.unlinkSync(tmp);
process.exit(result.status ?? 1);
