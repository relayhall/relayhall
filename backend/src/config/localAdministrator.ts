/**
 * The named local administrator Account — SS-W1's narrowing of the
 * break-glass path (design `d95136d7` §8.5).
 *
 * `POST /auth/login` is permanent and no Identity provider configuration can
 * disable it. What SS-W1 changes is what it authenticates: it stops being
 * "the deployment password, and everyone who knows it is the same root
 * identity" and becomes "one NAMED local administrator Account's password".
 * Everybody else gets their own Account and their own login session.
 *
 * The handle is deployment configuration rather than a constant so an estate
 * can retire the seeded owner identity without losing its way back in. The
 * route, its throttle and its audit are unchanged by that narrowing.
 */

/** The 062 seed, and what a deployment that sets nothing keeps using. */
export const DEFAULT_LOCAL_ADMINISTRATOR_HANDLE = 'dashboard_user';

/** Same shape `validateNewHandle` enforces, so a typo cannot name nothing. */
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/;

/**
 * Read at call time (like the feature flags) so a test can vary it per case.
 *
 * This validates the handle's SHAPE and nothing else — it cannot know whether
 * the handle names a live Account, because it has no database. That second
 * half of the guarantee is enforced at the login handler, which does: see
 * `routes/auth.ts`, where a configured handle that does not resolve to an
 * ACTIVE Account falls back to the seed. Stated here because the earlier
 * version of this comment claimed the whole guarantee and delivered half of
 * it, which is how a valid-but-nonexistent handle could strand the owner
 * (review verdict `77046845`).
 */
export function localAdministratorHandle(): string {
  const raw = process.env.RELAYHALL_LOCAL_ADMIN_HANDLE;
  if (typeof raw !== 'string') return DEFAULT_LOCAL_ADMINISTRATOR_HANDLE;
  const value = raw.trim().toLowerCase();
  if (!value || !HANDLE_PATTERN.test(value)) return DEFAULT_LOCAL_ADMINISTRATOR_HANDLE;
  return value;
}
