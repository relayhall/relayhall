// changeTargets.ts — the target vocabulary of the universal change request
// (kind `change`; design ratified by owner ruling E325, sections 3, 4.2 and
// 5.1; card 502fb19e). One module with no imports, so the request service, the
// decide route and the approvals hub read ONE copy of each list.
//
// Every authority or configuration change a person can make in Settings is a
// target type, IN (requestable) or OUT by a declared rule. The IN list is the
// closed vocabulary migration 158 binds as `approvals_target_type_check`.

/** Every IN target type (section 3), in the order migration 158 lists them. */
export const CHANGE_TARGET_TYPES = [
  'grant.rows', 'grant.edit', 'grant.revoke',
  'credential.scopes', 'credential.issue', 'credential.revoke',
  'identity.create', 'identity.role', 'identity.status',
  'warrant.create', 'warrant.edit', 'warrant.revoke', 'warrant.resume',
  'group.member', 'group.steward', 'group.lifecycle', 'group.ownership_status',
  'profile.assignment',
  'project.owner', 'task.account_owner', 'report.account_owner',
  'project.default_verifier', 'phase.default_verifier',
  'task.roles', 'charter.revision', 'phase.goal', 'task.access', 'phase.access', 'report.visibility',
  'plugin.capability', 'knowledge.compartment', 'knowledge.shared_writer',
] as const;
export type ChangeTargetType = (typeof CHANGE_TARGET_TYPES)[number];

/**
 * The target types slice S1 of train T1 builds (section 11). Every other IN
 * type is refused TARGET_NOT_AVAILABLE, naming the slice that builds it, before
 * anything is written.
 */
export const S1_TARGET_TYPES: readonly ChangeTargetType[] = [
  'grant.rows', 'grant.edit', 'grant.revoke', 'credential.scopes', 'credential.issue',
  'knowledge.compartment', 'knowledge.shared_writer',
];

/**
 * The identity targets slice S4 of train T2 builds (section 11, T2 S4; card
 * 9ce0b0b0): a role, a new Account, an Account's status, another principal's
 * credential revoked, and the four warrant acts.
 */
export const S4_TARGET_TYPES: readonly ChangeTargetType[] = [
  'identity.role', 'identity.create', 'identity.status', 'credential.revoke',
  'warrant.create', 'warrant.edit', 'warrant.revoke', 'warrant.resume',
];

/**
 * The object targets slice S5 of train T2 builds (section 11, T2 S5; card
 * 9ce0b0b0): a Project's owner, a Task's or a standalone Report's account
 * owner, a Project's or a Phase's default Verifier, a Charter revision, a
 * Phase goal, a Task's Shepherd and Verifier, a Task's or a Phase's restricted
 * access, and a Report's opening visibility. Each is about ONE object, named
 * by targetId, and names no grantee: the principal it puts on the object is a
 * field of the change (section 5.5 (d)).
 */
export const S5_TARGET_TYPES: readonly ChangeTargetType[] = [
  'project.owner', 'task.account_owner', 'report.account_owner',
  'project.default_verifier', 'phase.default_verifier',
  'charter.revision', 'phase.goal', 'task.roles', 'task.access', 'phase.access', 'report.visibility',
];

/** Every target type a filing may name today: the slices that have shipped. */
export const BUILT_TARGET_TYPES: readonly ChangeTargetType[] = [...S1_TARGET_TYPES, ...S4_TARGET_TYPES, ...S5_TARGET_TYPES];

/** The object type each S5 target is about (its targetId names one row of it). */
export const S5_OBJECT_TYPE: Readonly<Record<string, 'project' | 'phase' | 'task' | 'report'>> = {
  'project.owner': 'project', 'project.default_verifier': 'project', 'charter.revision': 'project',
  'phase.default_verifier': 'phase', 'phase.goal': 'phase', 'phase.access': 'phase',
  'task.account_owner': 'task', 'task.roles': 'task', 'task.access': 'task',
  'report.account_owner': 'report', 'report.visibility': 'report',
};

/**
 * THE DECIDER'S OWN REACH on the object (section 5.1 (5)): the action the
 * DIRECT door of each S5 target asks of its caller on the object, which the
 * decider's live authority must hold at apply time (authorizedIds), so an
 * approval never applies what its decider could not do itself. project.owner
 * and task.account_owner carry no entry: their executors run their own
 * direct predicate on the decider's session (the person owner on a stored
 * session, else an object administrator), which IS that test.
 */
export const S5_DECIDER_ACTION: Readonly<Record<string, 'write' | 'admin' | 'shepherd'>> = {
  'report.account_owner': 'write',
  'project.default_verifier': 'write',
  'phase.default_verifier': 'write',
  'charter.revision': 'write',
  'phase.goal': 'write',
  'task.roles': 'shepherd',
  'task.access': 'admin',
  'phase.access': 'admin',
  'report.visibility': 'write',
};

/** The S4 targets on a principal, named by targetId and never by a grantee (section 5.5 (c)). */
export const PRINCIPAL_TARGETS: readonly ChangeTargetType[] = ['identity.role', 'identity.status'];

/** The four warrant targets (section 3): filed by any principal within its standing, decided by root or an administrator. */
export const WARRANT_TARGETS: readonly ChangeTargetType[] = ['warrant.create', 'warrant.edit', 'warrant.revoke', 'warrant.resume'];

/** Where each IN type not yet built ships (section 11). */
export const CHANGE_TARGET_SLICE: Readonly<Record<string, string>> = {
  'group.member': 'T3 S7', 'group.steward': 'T3 S7', 'group.lifecycle': 'T3 S7',
  'group.ownership_status': 'T3 S7', 'profile.assignment': 'T3 S7',
  'plugin.capability': 'T3 S8',
};

/**
 * The OUT target types and the declared rule for each (sections 3 and 13). A
 * filing naming one is refused TARGET_NOT_REQUESTABLE with the reason: "OUT"
 * never means "later".
 */
export const OUT_TARGET_TYPES: Readonly<Record<string, string>> = {
  'credential.transport': 'a transport pin is never loosened through a request (AZ-A13 clause 9d): root or an administrator loosens it with step-up',
  'credential.expiry': 'a credential expiry has no writer: issue a new credential',
  'credential.rotate': 'rotation is a human act: the new secret must reach the presenting session',
  'credential.reveal': 'reveal is a human act: the secret must reach the presenting session',
  'identity.terminate': 'termination is irreversible and carries its own cascade: a direct root act',
  'project.is_hidden': 'is_hidden confers nothing: it is a content switch',
  'project.visibility': 'the column has no writer',
  'task.visibility': 'the column has no writer',
  'resource.agent_visibility': 'agentVisibility is a Resource field, a content write',
  'knowledge.personal_consent': 'a personal compartment is readable by nobody else (E260(1))',
  'knowledge.shared_read': 'nothing to request: the door is the read grant on the knowledge Service (grant.rows)',
  'service.owner_plane': 'deployment configuration, not authority over a principal',
  'identity_provider.policy': 'a locked surface: the root owner-plane act',
  'skill.lifecycle': 'object governance on its own queue',
  'personality.rows': 'object governance on its own queue',
  'credential.extend': 'an agent-plane system act',
  'agent.mint': 'requested with relayhall_agent_mint (kind agent-mint, kept byte-for-byte)',
};

/** The targets that cover several objects at once (section 2.1, F2). */
export const MULTI_OBJECT_TARGETS: readonly ChangeTargetType[] = ['grant.rows', 'knowledge.compartment'];

/**
 * The targets a ROOT login session alone decides (section 5.1(4); section 12
 * Q3, no DD-12 exception): the root-ceiling executors. A request a non-root
 * administrator session filed on one lands with a root session.
 */
export const ROOT_SESSION_ONLY_TARGETS: readonly ChangeTargetType[] = [
  'grant.edit', 'grant.revoke', 'group.member', 'group.lifecycle', 'group.ownership_status',
  'profile.assignment', 'identity.create', 'identity.status',
];

/** The two-step targets: approve records, the target's own credential collects (section 7.2(a)). */
export const TWO_STEP_TARGETS: readonly ChangeTargetType[] = ['credential.issue'];

export function isChangeTargetType(value: unknown): value is ChangeTargetType {
  return typeof value === 'string' && (CHANGE_TARGET_TYPES as readonly string[]).includes(value);
}

/** Whether a decider standing may decide a change of this target type. */
export function changeTargetNeedsRootSession(targetType: string | null | undefined): boolean {
  return typeof targetType === 'string' && (ROOT_SESSION_ONLY_TARGETS as readonly string[]).includes(targetType);
}

/**
 * The targets the OWNER TIER reaches (section 4.1 row 3 for filing, section
 * 5.2 for deciding): a Project person owner, a Report's account owner or
 * author, or a Group owner (or, for grant.rows alone, a Group manager) whose
 * object every one of the target's objects is. Everything else is root's or an
 * administrator's.
 */
export const OWNER_TIER_TARGETS: readonly ChangeTargetType[] = [
  'grant.rows', 'knowledge.compartment', 'project.default_verifier', 'phase.default_verifier',
  'charter.revision', 'phase.goal', 'task.roles', 'task.access', 'phase.access',
  'report.visibility', 'report.account_owner', 'group.steward', 'project.owner',
];

/** The one target a Group MANAGER row decides: grant.rows with verbs in the write set (section 5.2). */
export const MANAGER_TIER_TARGETS: readonly ChangeTargetType[] = ['grant.rows'];

/**
 * The owner-tier targets a PERSON owner alone decides: no Group tier reaches
 * them (section 5.2; DV:57 for the default Verifier; R12:150, the `admin` arm
 * admits no Group tier, for restricted access; R12:205-211 for a Project's
 * owner, moved by its person owner to another person, and into, out of or
 * between Groups by root or an administrator alone).
 */
export const PERSON_OWNER_ONLY_TARGETS: readonly ChangeTargetType[] = [
  'project.default_verifier', 'phase.default_verifier', 'task.access', 'phase.access', 'project.owner',
];

/** The targets whose executor requires a STORED login session: the break-glass JWT is refused DECIDER_SESSION_KIND (section 5.1 (1)). */
export const STORED_SESSION_TARGETS: readonly ChangeTargetType[] = ['task.account_owner'];

export function changeTargetAdmitsOwnerTier(targetType: string | null | undefined): boolean {
  return typeof targetType === 'string' && (OWNER_TIER_TARGETS as readonly string[]).includes(targetType);
}

/**
 * WHO DECIDES ONE CHANGE ITEM, as the page says it (section 5.6: decidersRule
 * per item). It names the standings, never a person.
 */
export function changeDecidersRule(targetType: string | null | undefined): string {
  if (changeTargetNeedsRootSession(targetType)) {
    return 'A root session, with step-up. No administrator or owner decides this change.';
  }
  if (typeof targetType === 'string' && (MANAGER_TIER_TARGETS as readonly string[]).includes(targetType)) {
    return 'Root, an administrator signed in to the dashboard, or the owner of every object it names (a person, or a Group owner or manager), with step-up.';
  }
  if (typeof targetType === 'string' && (PERSON_OWNER_ONLY_TARGETS as readonly string[]).includes(targetType)) {
    return 'Root, an administrator signed in to the dashboard, or the person who owns every object it names, with step-up.';
  }
  if (changeTargetAdmitsOwnerTier(targetType)) {
    return 'Root, an administrator signed in to the dashboard, or the owner of every object it names (a person, or a Group owner), with step-up.';
  }
  return 'Root, or an administrator signed in to the dashboard, with step-up.';
}
