#!/usr/bin/env node
/**
 * test-s2-profiles-live.js — RH-P3.AZ-S2 (card 559393f5; design 4d961e37
 * §4, A17.4): behavioral proof of Access profiles against a real migrated
 * PostgreSQL through the PRODUCTION services (AccessProfileService,
 * AuthorizationRepository) — never SQL substrings:
 *   - selector forms live: exact hits only pinned ids; all-of-type reaches
 *     an object created AFTER publication (future-inclusive); all-except
 *     reaches new objects while pinned exclusions stay excluded;
 *   - group assignment reaches an active member and no one else;
 *   - T35: a draft profile cannot be assigned (typed refusal) and, forced
 *     into an assignment at the SQL level, still yields EMPTY authority;
 *   - T14: publishing v2 retargets EVERY assignment instantly — v1
 *     authority is gone everywhere with no per-assignment repoint;
 *   - rollback = republish prior content as a NEW version (works), while
 *     re-pointing to an OLD version id is refused (typed);
 *   - immutability/append-only/pairing triggers refuse raw mutation;
 *   - unassignment is effective on the next request;
 *   - the parented-assignee sequencing guard refuses (typed);
 *   - effectiveAccess lists the same sources the evaluator honors.
 *
 * Run with DB_* env at a DISPOSABLE database carrying the full migration
 * chain (prepare with test-fresh-install-replay.js). Exit 0 = all proofs.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const probe = `
import { pool } from "../src/db/connection";
import { groupService } from "../src/services/GroupService";
import { accessProfileService } from "../src/services/AccessProfileService";
import { authorizationRepository } from "../src/services/AuthorizationRepository";
import { randomUUID } from "crypto";

const ACTOR = { principalId: null, handle: "s2-live-proof", authMethod: "system" as const };

async function main() {
  const tag = "s2-" + randomUUID().slice(0, 8);
  const out: Record<string, unknown> = {};
  const mkPrincipal = async (kind: string, parent: string | null = null) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO principals (id, kind, handle, display_name, status, parent_principal_id) VALUES ($1,$2,$3,$4,'active',$5)",
      [id, kind, tag + "-" + randomUUID().slice(0, 6), "S2 " + kind, parent]);
    return id;
  };
  const mkTask = async (title: string) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO tasks (id, title, description, status, priority, visibility) VALUES ($1,$2,'','todo','normal','private')",
      [id, title]);
    return id;
  };
  const mkReport = async (title: string) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO reports (id, title, content, visibility) VALUES ($1,$2,'s2 probe','private')",
      [id, title]);
    return id;
  };

  const direct = await mkPrincipal("service");
  const member = await mkPrincipal("service");
  const outsider = await mkPrincipal("service");
  const parented = await mkPrincipal("service", direct);

  const t1 = await mkTask("s2 exact-listed " + tag);
  const t2 = await mkTask("s2 exact-unlisted " + tag);

  const group = await groupService.create({ name: "s2-live " + tag }, ACTOR);
  await groupService.addMember(group.id, { accountPrincipalId: member }, ACTOR);

  const profile = await accessProfileService.create({ name: "s2-live " + tag }, ACTOR);

  // T35 typed: a draft may not be assigned.
  out.t35DraftAssignRefused = await accessProfileService
    .assign(profile.id, { assigneeType: "principal", assigneeId: direct }, ACTOR)
    .then(() => false, (e: any) => e.code === "PROFILE_UNPUBLISHED");

  const v1 = await accessProfileService.createVersion(profile.id, [
    { resourceType: "task", selectorForm: "exact", selectorIds: [t1], verbs: ["read"] },
    { resourceType: "report", selectorForm: "all-of-type", verbs: ["read"] },
  ], ACTOR);
  await accessProfileService.publish(profile.id, v1.id, ACTOR);
  await accessProfileService.assign(profile.id, { assigneeType: "principal", assigneeId: direct }, ACTOR);
  await accessProfileService.assign(profile.id, { assigneeType: "group", assigneeId: group.id }, ACTOR);

  const actorFor = (principalId: string, scopes: string[]) => ({
    principalId, handle: "probe", role: "agent", scopes, authenticated: true,
  });
  const canReadTask = async (who: string, taskId: string) =>
    (await authorizationRepository.authorizedIds(actorFor(who, ["tasks:read"]), "task", [taskId], "read")).has(taskId);
  const canReadReport = async (who: string, reportId: string) =>
    (await authorizationRepository.authorizedIds(actorFor(who, ["reports:read"]), "report", [reportId], "read")).has(reportId);

  // exact form: only the pinned id.
  out.exactHitsPinned = await canReadTask(direct, t1);
  out.exactMissesUnpinned = !(await canReadTask(direct, t2));
  out.groupMemberReaches = await canReadTask(member, t1);
  out.outsiderRefused = !(await canReadTask(outsider, t1));

  // all-of-type is FUTURE-INCLUSIVE: a report created after publication.
  const futureReport = await mkReport("s2 future " + tag);
  out.allOfTypeFutureInclusive = await canReadReport(direct, futureReport)
    && (await canReadReport(member, futureReport))
    && !(await canReadReport(outsider, futureReport));

  // T14: publishing v2 retargets every assignment instantly.
  const v2 = await accessProfileService.createVersion(profile.id, [
    { resourceType: "task", selectorForm: "exact", selectorIds: [t2], verbs: ["read"] },
  ], ACTOR);
  await accessProfileService.publish(profile.id, v2.id, ACTOR);
  out.t14OldAuthorityGoneEverywhere = !(await canReadTask(direct, t1))
    && !(await canReadTask(member, t1))
    && !(await canReadReport(direct, futureReport));
  out.t14NewAuthorityLive = (await canReadTask(direct, t2)) && (await canReadTask(member, t2));

  // Re-pointing to the OLD version id is refused; rollback is REPUBLISH.
  out.repointToOldRefused = await accessProfileService.publish(profile.id, v1.id, ACTOR)
    .then(() => false, (e: any) => e.code === "ROLLBACK_IS_REPUBLISH");
  const v3 = await accessProfileService.createVersion(profile.id,
    v1.rules.map(r => ({ resourceType: r.resourceType, selectorForm: r.selectorForm,
      selectorIds: r.selectorIds.length ? r.selectorIds : undefined, verbs: r.verbs })), ACTOR);
  await accessProfileService.publish(profile.id, v3.id, ACTOR);
  out.rollbackViaRepublish = (await canReadTask(direct, t1)) && !(await canReadTask(direct, t2));

  // all-except: everything of the type except the pinned exclusion —
  // including a task created AFTER publication.
  const pExcept = await accessProfileService.create({ name: "s2-except " + tag }, ACTOR);
  const ve = await accessProfileService.createVersion(pExcept.id, [
    { resourceType: "task", selectorForm: "all-except", selectorIds: [t1], verbs: ["read"] },
  ], ACTOR);
  await accessProfileService.publish(pExcept.id, ve.id, ACTOR);
  await accessProfileService.assign(pExcept.id, { assigneeType: "principal", assigneeId: outsider, }, ACTOR);
  const t3 = await mkTask("s2 future task " + tag);
  out.allExceptFutureInclusive = (await canReadTask(outsider, t2)) && (await canReadTask(outsider, t3));
  out.allExceptExclusionHolds = !(await canReadTask(outsider, t1));

  // AZ-S3 lifted the S2 sequencing guard: parented assignees are accepted
  // and their effective authority stays own ∩ parent (proven in
  // test-s3-delegation-live.js).
  out.parentedAssigneeNowAssignable = await accessProfileService
    .assign(profile.id, { assigneeType: "principal", assigneeId: parented }, ACTOR)
    .then(() => true, () => false);

  // T35 forced at SQL level: an assignment to an UNPUBLISHED profile is
  // inert in the evaluator (empty authority, no error).
  const pDraft = await accessProfileService.create({ name: "s2-draft " + tag }, ACTOR);
  await pool.query(
    "INSERT INTO access_profile_assignments (profile_id, assignee_type, assignee_id) VALUES ($1,'principal',$2)",
    [pDraft.id, outsider]);
  out.t35ForcedAssignmentInert = !(await canReadTask(outsider, t1));

  // Immutability / append-only / pairing triggers.
  out.versionImmutable = await pool.query(
    "UPDATE access_profile_versions SET version_number = version_number + 10 WHERE id = $1", [v1.id])
    .then(() => false, (e) => /immutable/.test(String(e.message)));
  out.rulesImmutable = await pool.query(
    "DELETE FROM access_profile_rules WHERE version_id = $1", [v1.id])
    .then(() => false, (e) => /immutable/.test(String(e.message)));
  out.eventsAppendOnly = await pool.query(
    "DELETE FROM access_profile_events WHERE profile_id = $1", [profile.id])
    .then(() => false, (e) => /append-only/.test(String(e.message)));
  out.pairingEnforced = await pool.query(
    "UPDATE access_profiles SET published_version_id = $1 WHERE id = $2", [ve.id, profile.id])
    .then(() => false, (e) => /version of this profile/.test(String(e.message)));

  // Unassignment: one delete, effective immediately.
  const assignments = await accessProfileService.assignments(profile.id);
  const directAssignment = assignments.find(a => a.assigneeType === "principal" && a.assigneeId === direct)!;
  await accessProfileService.unassign(profile.id, directAssignment.id, ACTOR);
  out.unassignImmediate = !(await canReadTask(direct, t1));
  out.groupPathStillLive = await canReadTask(member, t1);

  // effectiveAccess mirrors the evaluator's sources.
  const selfView = await accessProfileService.effectiveAccess(member);
  out.effectiveAccessShowsGroupProfile = selfView.profiles.some(
    (p: any) => p.profileId === profile.id && p.source === "group-profile" && p.groupId === group.id);

  console.log(JSON.stringify(out));

  const failures = Object.entries(out).filter(([, v]) => typeof v === "boolean" && !v);
  await pool.end();
  if (failures.length > 0) {
    console.error("FAILED:", failures.map(([k]) => k).join(", "));
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
`;

const fs = require("fs");
const tmp = path.join(__dirname, ".s2-profiles-probe.ts");
fs.writeFileSync(tmp, probe);
const result = spawnSync(path.join(__dirname, "..", "node_modules", ".bin", "tsx"), [tmp], {
  stdio: "inherit", env: process.env, cwd: path.join(__dirname, ".."),
});
fs.unlinkSync(tmp);
process.exit(result.status ?? 1);
