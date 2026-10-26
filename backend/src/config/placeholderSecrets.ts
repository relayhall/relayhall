/**
 * The two secrets `.env.example` ships as placeholders, and the refusal a
 * backend gives when it is started with one of them.
 *
 * `.env.example` is public, and it is the file an operator copies when setting
 * an install up by hand instead of through `./setup.sh`. Its `JWT_SECRET`
 * placeholder would let anyone who read the file sign a dashboard token this
 * backend accepts; its `POSTGRES_PASSWORD` placeholder (the database role's
 * password, which Compose passes to the backend as `DB_PASSWORD`) is equally
 * public. Neither may reach a running board.
 *
 * The comparison is with the LITERAL placeholders only: any other value is
 * accepted unchanged, whatever it contains. The refusal names the variable and
 * the fix, never the value. `placeholderSecretsRefusal.test.ts` reads the
 * placeholders out of `.env.example` itself, so the two cannot drift apart.
 */

export const ENV_EXAMPLE_JWT_SECRET = 'change-this-to-a-random-string';
export const ENV_EXAMPLE_POSTGRES_PASSWORD = 'CHANGE_ME_SECURE_PASSWORD';

export const JWT_SECRET_PLACEHOLDER_REFUSAL =
  'FATAL: JWT_SECRET is still the placeholder from .env.example, which anyone can read, so a dashboard token '
  + 'signed with it would be accepted. Generate a secret of your own (./setup.sh does, or: openssl rand -hex 64), '
  + 'put it in .env and restart the backend.';

export const DB_PASSWORD_PLACEHOLDER_REFUSAL =
  'FATAL: POSTGRES_PASSWORD (passed to the backend as DB_PASSWORD) is still the placeholder from .env.example. '
  + 'Set a password of your own in .env (./setup.sh generates one) and restart. If the database was already '
  + 'started with the placeholder, PostgreSQL keeps that password: change it inside the database too '
  + '(ALTER ROLE <user> PASSWORD ...).';

/** Every placeholder refusal that applies to this environment, in a fixed order. */
export function placeholderSecretRefusals(env: NodeJS.ProcessEnv = process.env): string[] {
  const refusals: string[] = [];
  if (env.JWT_SECRET === ENV_EXAMPLE_JWT_SECRET) refusals.push(JWT_SECRET_PLACEHOLDER_REFUSAL);
  if (env.DB_PASSWORD === ENV_EXAMPLE_POSTGRES_PASSWORD) refusals.push(DB_PASSWORD_PLACEHOLDER_REFUSAL);
  return refusals;
}

/** Throws when JWT_SECRET is exactly the `.env.example` placeholder. */
export function refusePlaceholderJwtSecret(secret: string): void {
  if (secret === ENV_EXAMPLE_JWT_SECRET) throw new Error(JWT_SECRET_PLACEHOLDER_REFUSAL);
}

/** Throws when DB_PASSWORD is exactly the `.env.example` POSTGRES_PASSWORD placeholder. */
export function refusePlaceholderDatabasePassword(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DB_PASSWORD === ENV_EXAMPLE_POSTGRES_PASSWORD) throw new Error(DB_PASSWORD_PLACEHOLDER_REFUSAL);
}
