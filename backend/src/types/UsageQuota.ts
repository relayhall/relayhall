export interface QuotaWindow {
  id: string; label: string; unit: 'percent' | 'requests' | 'tokens' | 'credits';
  used: number; limit: number; resetsAt?: string;
}
export interface UsageQuotaSnapshot {
  schemaVersion: 'rh.usage-quota/1'; sourceProduct: string; provider: string;
  providerAccountId: string; label: string; observedAt: string;
  checkedAt?: string; errorCode?: 'unavailable'|'auth-required'|'rate-limited'|'timeout'|'untrusted-binary';
  status: 'reported' | 'not-reported' | 'unsupported' | 'removed';
  windows: QuotaWindow[];
}
const slug = /^[a-z][a-z0-9_-]{0,63}$/;
const opaque = /^[A-Za-z0-9_-]{1,128}$/;
const label = /^[^\x00-\x1f\x7f]{1,80}$/;
function text(value: unknown, pattern: RegExp): value is string { return typeof value === 'string' && pattern.test(value); }
function closed(value: unknown, keys: string[]): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
}
export function validQuotaTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [,year,month,day,hour,minute,second] = match;
  const y=Number(year),m=Number(month),d=Number(day);
  return y>=1970 && m>=1 && m<=12 && d>=1 && d<=new Date(Date.UTC(y,m,0)).getUTCDate() &&
    Number(hour)<24 && Number(minute)<60 && Number(second)<60 && Number.isFinite(Date.parse(value));
}
export function validateUsageQuota(value: unknown, now = Date.now()): UsageQuotaSnapshot {
  const fail = (): never => { throw new Error('INVALID_QUOTA_SNAPSHOT'); };
  if (!closed(value, ['schemaVersion','sourceProduct','provider','providerAccountId','label','observedAt','status','windows','checkedAt','errorCode']) ||
      Buffer.byteLength(JSON.stringify(value)) > 16384) return fail();
  if (value.schemaVersion !== 'rh.usage-quota/1' || !text(value.sourceProduct,slug) ||
      !text(value.provider,slug) || !text(value.providerAccountId,opaque) || !text(value.label,label) ||
      !validQuotaTimestamp(value.observedAt) || Date.parse(value.observedAt) > now + 60000 ||
      !['reported','not-reported','unsupported','removed'].includes(value.status) ||
      !Array.isArray(value.windows) || value.windows.length > 16) return fail();
  if (value.checkedAt !== undefined && (!validQuotaTimestamp(value.checkedAt) || Date.parse(value.checkedAt) < Date.parse(value.observedAt) || Date.parse(value.checkedAt) > now + 60000)) return fail();
  // E462 slice S3 (design 4.2): 'untrusted-binary' is the harness binary that failed publisher trust, so its row
  // says so instead of going stale.
  if (value.errorCode !== undefined && !['unavailable','auth-required','rate-limited','timeout','untrusted-binary'].includes(value.errorCode)) return fail();
  if ((value.status === 'reported') !== (value.windows.length > 0)) return fail();
  const ids = new Set<string>();
  const windows: QuotaWindow[] = value.windows.map((w: unknown) => {
    if (!closed(w, ['id','label','unit','used','limit','resetsAt']) || !text(w.id,slug) || ids.has(w.id) ||
        !text(w.label,label) || !['percent','requests','tokens','credits'].includes(w.unit) ||
        typeof w.used !== 'number' || !Number.isFinite(w.used) || w.used < 0 ||
        typeof w.limit !== 'number' || !Number.isFinite(w.limit) || w.limit <= 0 ||
        (w.unit === 'percent' && (w.limit !== 100 || w.used > 100)) ||
        (w.resetsAt !== undefined && !validQuotaTimestamp(w.resetsAt))) return fail();
    ids.add(w.id);
    return { id:w.id,label:w.label,unit:w.unit,used:w.used,limit:w.limit,...(w.resetsAt ? {resetsAt:new Date(w.resetsAt).toISOString()} : {}) };
  });
  return {schemaVersion:'rh.usage-quota/1',sourceProduct:value.sourceProduct,provider:value.provider,
    providerAccountId:value.providerAccountId,label:value.label,observedAt:new Date(value.observedAt).toISOString(),
    status:value.status,windows,checkedAt:new Date(value.checkedAt ?? value.observedAt).toISOString(),...(value.errorCode ? {errorCode:value.errorCode} : {})};
}
