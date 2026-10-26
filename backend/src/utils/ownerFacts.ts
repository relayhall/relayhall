/**
 * AZ-A12 build 5 (card a9b1e69c; amendment AZ-A12 clause 12, ratified E72):
 * THE OWNER FIELDS an owner read carries beside the owner id.
 *
 * `ownerKind` is `human` or `group`, and `ownerDisplayName` is the name the
 * page shows: a Group's own name, else the person's display name, else the
 * handle. Both are joined SERVER-SIDE from the owner column, so a page names a
 * Group owner without listing Group principals in the person directory
 * (clause 3(h): `GET /principals` leaves `kind='group'` out).
 *
 * One text for every owner read that carries the fields: the Project record
 * (`ProjectService.getById` and `list`) and the Task account-owner read
 * (`TaskAccountOwnershipService.read`). An owner of any other kind (a legacy
 * row the transfer acts no longer admit) reads `ownerKind: null` with its
 * display name, never a guessed kind.
 */

/** The kinds an owner column may name (clause 4). */
export type OwnerKind = 'human' | 'group';

/** The principal kind as the owner fields state it: `human`, `group` or null. */
export function ownerKindOf(kind: unknown): OwnerKind | null {
  if (kind === 'group') return 'group';
  if (kind === 'human') return 'human';
  return null;
}

/**
 * The SELECT expressions (`owner_kind`, `owner_display_name`) and the LEFT
 * JOINs that produce them for the uuid column `ownerColumn`. `alias` names the
 * joined principal row; it must be unique inside the outer query.
 */
export function ownerFactsSql(ownerColumn: string, alias: string): { select: string; join: string } {
  const group = `${alias}_group`;
  return {
    select: `${alias}.kind AS owner_kind, COALESCE(${group}.name, ${alias}.display_name, ${alias}.handle) AS owner_display_name`,
    join: `LEFT JOIN principals ${alias} ON ${alias}.id = ${ownerColumn}
           LEFT JOIN groups ${group} ON ${group}.id = ${alias}.id AND ${alias}.kind = 'group'`,
  };
}

/** The two owner fields from a row that selected `ownerFactsSql`; null without an owner. */
export function ownerFactsOf(row: { owner_kind?: unknown; owner_display_name?: unknown }, ownerId: string | null):
  { ownerKind: OwnerKind | null; ownerDisplayName: string | null } {
  if (!ownerId) return { ownerKind: null, ownerDisplayName: null };
  return {
    ownerKind: ownerKindOf(row.owner_kind),
    ownerDisplayName: typeof row.owner_display_name === 'string' ? row.owner_display_name : null,
  };
}
