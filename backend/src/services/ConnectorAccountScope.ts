import { MAX_CHAIN_DEPTH } from './DelegationService';
/** Internal SQL identifiers only; active current Account ancestry at every hop. */
export function activeConnectorAccountSql(connectorColumn: string, accountParameter: string): string {
  return `EXISTS (WITH RECURSIVE chain AS (
    SELECT p.id,p.parent_principal_id,0 AS depth FROM principals p WHERE p.id=${connectorColumn} AND p.status='active'
    UNION ALL SELECT p.id,p.parent_principal_id,c.depth+1 FROM chain c
    JOIN principals p ON p.id=c.parent_principal_id WHERE c.depth < ${MAX_CHAIN_DEPTH} AND p.status='active'
  ) SELECT 1 FROM chain WHERE id=${accountParameter} AND parent_principal_id IS NULL)`;
}
