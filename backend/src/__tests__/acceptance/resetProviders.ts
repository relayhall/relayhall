import { pool } from '../../db/connection';

/**
 * Discard a test run's Identity providers AND the links beneath them.
 *
 * The `identity_links.identity_provider_id` FK is ON DELETE RESTRICT since
 * review round 2: a provider delete must never silently destroy stored link
 * proof or its revocation history. Fixtures therefore have to name the links
 * they are discarding, which is exactly the discipline the constraint exists to
 * impose. Scoped by issuer prefix so a shared database is safe.
 */
export async function resetProvidersByIssuerPrefix(prefix: string): Promise<void> {
  await pool.query(
    `DELETE FROM identity_links WHERE identity_provider_id IN
       (SELECT id FROM identity_providers WHERE issuer LIKE $1)`,
    [prefix],
  );
  await pool.query('DELETE FROM identity_providers WHERE issuer LIKE $1', [prefix]);
}
