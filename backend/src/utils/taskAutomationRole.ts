/**
 * Automation AUTHORITY tokens, not the product's task-role vocabulary. The
 * ratified role model (vocabulary report b94dd86e §5.3) names the task roles
 * Assignee (label over the `claimant` identifier), Shepherd, and Verifier.
 * These tokens are the legacy wire/stored values that today's authorisation
 * still consults ('reviewer' and 'qa' both carry Verifier authority; 'agent'
 * is the implementation Assignee side; 'orchestrator' is elevated automation).
 * The token strings are stored in principals.role and matched against handles,
 * so renaming them is a data migration belonging to the Phase-2 role-model work
 * (RH-P3.1), not a wording change.
 */
export type TaskAutomationRole = 'agent' | 'qa' | 'reviewer' | 'orchestrator';

export interface ActorRoleInput {
  /** The authenticated identity string (`req.userId`). */
  handle: string;
  /** `principals.role` when a principal resolved; NULL DB roles must be passed as null. */
  principalRole?: string | null;
  /** `auth_sessions.role_snapshot` for humans with a live server session (the Phase-2 OIDC binding wires the input). */
  sessionRole?: string | null;
}

/**
 * Single role-precedence function (spec b48bb799 §2.2):
 *  1. live session role snapshot (group claims at mint — humans only);
 *  2. principals.role when non-NULL (authoritative for agents/services);
 *  3. today's handle switch, verbatim, for unknown-handle legacy JWTs AND for
 *     principals seeded with a NULL role — the seeds with a deliberately NULL
 *     role (system, reports_reader, plus the dormant journal_publisher row
 *     retired with the Journal plugin, P1.3 ruling A7) must keep resolving to
 *     the same effective authority they have today.
 */
export function resolveActorRole(input: ActorRoleInput): string {
  // Presence, not truthiness, makes the server-written session snapshot
  // authoritative. An empty/unknown snapshot must not fall through to a more
  // privileged Principal role; downstream scope derivation fails it closed.
  if (input.sessionRole !== null && input.sessionRole !== undefined) return input.sessionRole;
  if (input.principalRole) return input.principalRole;
  const userId = String(input.handle || '').trim().toLowerCase();
  if (userId === 'dashboard_user') return 'orchestrator';
  if (userId === 'clawbeat_reviewer' || userId === 'hermes_qa_reviewer') return 'reviewer';
  if (userId === 'clawbeat_qa' || userId === 'hermes_qa') return 'qa';
  return 'agent';
}

/**
 * Resolve privileged task lifecycle authority from the authenticated identity.
 * Client-controlled role headers are deliberately not an authority source.
 *
 * Thin wrapper over resolveActorRole: with neither a session role nor a
 * principal role supplied, precedence falls through to the handle switch, so
 * the result is provably one of the four automation roles and byte-identical
 * to the pre-identity behaviour.
 */
export function resolveTaskAutomationRole(authenticatedUserId: unknown): TaskAutomationRole {
  return resolveActorRole({ handle: String(authenticatedUserId || '') }) as TaskAutomationRole;
}


/**
 * Resolve authority for Task lifecycle mutations.
 *
 * The clean-install dashboard password represents the human owner, whose
 * browser review is independent from spawned implementation credentials. It
 * may therefore approve reviewed work. Other identities remain bound to their
 * explicit task role; unknown human/application roles fail closed to agent.
 */
export function resolveTaskLifecycleRole(input: ActorRoleInput): TaskAutomationRole {
  const handle = String(input.handle || '').trim().toLowerCase();
  if (handle === 'dashboard_user') return 'reviewer';
  const role = resolveActorRole(input);
  if (role === 'qa' || role === 'reviewer' || role === 'orchestrator' || role === 'agent') return role;
  if (role === 'admin') return 'orchestrator';
  return 'agent';
}
