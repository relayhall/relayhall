/**
 * Identity/authz feature flags (epic 60558599). Env-based by design: flips are
 * deploy-gated and audit-visible in compose diffs, and a runtime-writable kill
 * switch for auth enforcement would itself be an attack surface.
 *
 * Every flag defaults OFF; with all flags off behaviour is byte-identical to
 * the pre-identity code (pinned by backend/scripts/auth-baseline-capture.sh).
 * Read at call time, not module init, so tests can flip per-case.
 */
export function isFlagOn(envName: string): boolean {
  return process.env[envName] === 'on';
}

export const FLAG_AUTH_REQUIRE_PRINCIPAL = 'RELAYHALL_AUTH_REQUIRE_PRINCIPAL';
export const FLAG_SESSIONS = 'RELAYHALL_SESSIONS';
