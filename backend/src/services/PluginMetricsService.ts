import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { validQuotaTimestamp } from '../types/UsageQuota';
import { activeConnectorAccountSql } from './ConnectorAccountScope';
export interface ServiceMetrics {
  schemaVersion:'rh.plugin.metrics/1';sourceProduct:string;observedAt:string;
  queue:{value:number;unit:'jobs'}|null;
  throughput:{value:number;unit:'jobs/minute';windowSeconds:number}|null;
}
export function validateServiceMetrics(value:any,now=Date.now()):ServiceMetrics {
  const object=(v:any,keys:string[]) => v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).every(k=>keys.includes(k));
  const finite=(n:any) => typeof n==='number' && Number.isFinite(n) && n>=0;
  if (!object(value,['schemaVersion','sourceProduct','observedAt','queue','throughput']) ||
      Buffer.byteLength(JSON.stringify(value))>4096 || value.schemaVersion!=='rh.plugin.metrics/1' ||
      typeof value.sourceProduct!=='string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.sourceProduct) ||
      !validQuotaTimestamp(value.observedAt) || Date.parse(value.observedAt)>now+60000 ||
      (value.queue!==null && (!object(value.queue,['value','unit']) || !finite(value.queue.value) || !Number.isInteger(value.queue.value) || value.queue.unit!=='jobs')) ||
      (value.throughput!==null && (!object(value.throughput,['value','unit','windowSeconds']) || !finite(value.throughput.value) || value.throughput.unit!=='jobs/minute' ||
       !Number.isInteger(value.throughput.windowSeconds) || value.throughput.windowSeconds<1 || value.throughput.windowSeconds>86400)))
    throw new Error('INVALID_SERVICE_METRICS');
  return {schemaVersion:'rh.plugin.metrics/1',sourceProduct:value.sourceProduct,observedAt:new Date(value.observedAt).toISOString(),queue:value.queue,throughput:value.throughput};
}
export class PluginMetricsService {
  constructor(private readonly db:Pool=defaultPool){}
  async store(account:string,connector:string,snapshot:ServiceMetrics) {
    const result=await this.db.query(`INSERT INTO plugin_service_metrics(account_id,connector_id,source_product,observed_at,snapshot)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(account_id,connector_id,source_product) DO UPDATE SET
      observed_at=EXCLUDED.observed_at,snapshot=EXCLUDED.snapshot WHERE plugin_service_metrics.observed_at<EXCLUDED.observed_at
      RETURNING observed_at`,[account,connector,snapshot.sourceProduct,snapshot.observedAt,JSON.stringify(snapshot)]);
    if (result.rowCount) return 'accepted';
    const current=await this.db.query(
      `SELECT observed_at,snapshot=$4::jsonb AS equal FROM plugin_service_metrics
       WHERE account_id=$1 AND connector_id=$2 AND source_product=$3`,
       [account,connector,snapshot.sourceProduct,JSON.stringify(snapshot)]);
    const row=current.rows[0];
    if(!row)return 'conflict';
    if(new Date(row.observed_at).getTime()>Date.parse(snapshot.observedAt))return 'older';
    return row.equal ? 'duplicate' : 'conflict';
  }
  async read(account:string,product?:string){
    const result=await this.db.query(`SELECT connector_id,source_product,snapshot FROM plugin_service_metrics m
      WHERE account_id=$1 AND ($2::text IS NULL OR source_product=$2) AND ${activeConnectorAccountSql('m.connector_id','$1')}
      ORDER BY observed_at DESC,connector_id,source_product LIMIT 201`,[account,product ?? null]);
    return {truncated:result.rows.length>200,sources:result.rows.slice(0,200).map(r=>{
      const s=r.snapshot,source={connectorId:r.connector_id,sourceProduct:r.source_product};
      const stamp={observedAt:s.observedAt,source,stale:Date.now()-Date.parse(s.observedAt)>90000};
      return {schemaVersion:'rh.plugin.metrics/1',...stamp,queue:s.queue?{...s.queue,...stamp}:null,throughput:s.throughput?{...s.throughput,...stamp}:null};
    })};
  }
}
export const pluginMetricsService=new PluginMetricsService();
