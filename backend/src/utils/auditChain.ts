// auditChain.ts — the §5.2-rule-8 canonical FULL-CHAIN audit record
// (RH-P3.AZ-S3 round-2 repair, review 94aad5aa B5).
//
// Every delegation-lifecycle audit row (mint, reveal, rotation, revocation,
// terminate, and their refusals where the target resolves) carries the
// SERVER-RESOLVED chain of the affected principal: acting identity first,
// ancestors up to the Account — [{principalId, kind, handle}] — one
// canonical representation for every writer and the Access manager.
interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

export interface AuditChainLink {
  principalId: string;
  kind: string;
  handle: string;
}

export async function auditChainFor(
  queryable: Queryable,
  principalId: string,
): Promise<AuditChainLink[]> {
  try {
    const result = await queryable.query(
      `WITH RECURSIVE chain AS (
         SELECT id, kind, handle, parent_principal_id, 0 AS depth
           FROM principals WHERE id = $1
         UNION ALL
         SELECT p.id, p.kind, p.handle, p.parent_principal_id, chain.depth + 1
           FROM principals p JOIN chain ON p.id = chain.parent_principal_id
          WHERE chain.depth < 5
       )
       SELECT id, kind, handle FROM chain ORDER BY depth ASC`,
      [principalId],
    );
    return result.rows.map((row) => ({
      principalId: String(row.id),
      kind: String(row.kind),
      handle: String(row.handle),
    }));
  } catch {
    // The audit row must never be lost to a chain-lookup failure: record
    // the degraded marker instead of throwing inside an audit path.
    return [{ principalId, kind: 'unresolved', handle: 'unresolved' }];
  }
}
