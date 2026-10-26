import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { activeConnectorAccountSql } from './ConnectorAccountScope';
import type { UsageQuotaSnapshot } from '../types/UsageQuota';
export class UsageQuotaService {
  constructor(private readonly db: Pool = defaultPool) {}
  async store(accountId: string, connectorId: string, snapshot: UsageQuotaSnapshot): Promise<'accepted'|'duplicate'|'older'|'conflict'> {
    const args = [accountId,connectorId,snapshot.provider,snapshot.providerAccountId,snapshot.observedAt,JSON.stringify(snapshot)];
    const result = await this.db.query(
      `INSERT INTO usage_quota_snapshots(account_id,connector_id,provider,provider_account_id,observed_at,snapshot)
       VALUES($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT(account_id,connector_id,provider,provider_account_id) DO UPDATE
       SET observed_at=EXCLUDED.observed_at,snapshot=EXCLUDED.snapshot,received_at=NOW()
       WHERE usage_quota_snapshots.observed_at < EXCLUDED.observed_at
       OR (usage_quota_snapshots.observed_at = EXCLUDED.observed_at
         AND (usage_quota_snapshots.snapshot - 'checkedAt' - 'errorCode') = (EXCLUDED.snapshot - 'checkedAt' - 'errorCode')
         AND (usage_quota_snapshots.snapshot->>'checkedAt')::timestamptz < (EXCLUDED.snapshot->>'checkedAt')::timestamptz)
       RETURNING observed_at`, args);
    if (result.rowCount) return 'accepted';
    const current = await this.db.query(
      `SELECT observed_at, snapshot = $5::jsonb AS equal FROM usage_quota_snapshots
       WHERE account_id=$1 AND connector_id=$2 AND provider=$3 AND provider_account_id=$4`,
       [accountId,connectorId,snapshot.provider,snapshot.providerAccountId,JSON.stringify(snapshot)]);
    const row = current.rows[0];
    if (!row) return 'conflict';
    if (new Date(row.observed_at).getTime() > Date.parse(snapshot.observedAt)) return 'older';
    return row.equal ? 'duplicate' : 'conflict';
  }
  async read(accountId: string) {
    const result = await this.db.query(
      `SELECT q.connector_id,q.snapshot,q.observed_at FROM usage_quota_snapshots q
       WHERE q.account_id=$1 AND q.snapshot->>'status' <> 'removed' AND ${activeConnectorAccountSql('q.connector_id','$1')}
       ORDER BY q.observed_at DESC,q.connector_id,q.provider,q.provider_account_id LIMIT 201`, [accountId]);
    return {schemaVersion:'rh.usage-quota/1',truncated:result.rows.length > 200,
      accounts:result.rows.slice(0,200).map(r => ({connectorId:r.connector_id,...r.snapshot,
        stale:Date.now()-new Date(r.observed_at).getTime()>900000}))};
  }
}
export const usageQuotaService = new UsageQuotaService();
