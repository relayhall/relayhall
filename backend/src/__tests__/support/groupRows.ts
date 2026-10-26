/**
 * AZ-A12 build 1 (card 20f40e40): THE ONE raw-SQL Group fixture.
 *
 * Migration 146 makes every Group a principal of kind 'group' with the same
 * id (clause 2), and `groups.id` gains a foreign key to `principals(id)`. A
 * test that wrote a `groups` row in raw SQL therefore fails that key unless
 * the principal row comes first. Every such fixture writes through this
 * helper, in the shape the production writers use (`GroupService.create`,
 * the directory reference "Use this group" act): one statement, the
 * principal first, the handle built from the uuid in SQL.
 *
 * It returns the new Group's id (which is also its principal's id).
 */
export interface GroupRowInput {
  name: string;
  description?: string;
  featured?: boolean;
  identityProviderId?: string | null;
  externalGroupRef?: string | null;
  createdByPrincipalId?: string | null;
}

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const INSERT_GROUP_ROW_SQL = `
  WITH group_principal AS (
    INSERT INTO principals (id, kind, handle, display_name, status)
    SELECT minted.id, 'group', 'group:' || minted.id::text, left($1::text, 255), 'active'
      FROM (SELECT gen_random_uuid() AS id) minted
    RETURNING id
  )
  INSERT INTO groups (id, name, description, featured, identity_provider_id, external_group_ref, created_by_principal_id)
  SELECT group_principal.id, $1::text, $2, $3, $4, $5, $6 FROM group_principal
  RETURNING id`;

export async function insertGroupRow(queryable: Queryable, input: GroupRowInput): Promise<string> {
  const result = await queryable.query(INSERT_GROUP_ROW_SQL, [
    input.name,
    input.description ?? '',
    input.featured ?? false,
    input.identityProviderId ?? null,
    input.externalGroupRef ?? null,
    input.createdByPrincipalId ?? null,
  ]);
  return String(result.rows[0].id);
}
