/** Test-only target admission; no pool or deployment configuration is imported. */
export function standaloneReportTestTarget(raw: string | undefined, ci: string | undefined): URL {
  if (!raw) throw new Error('RELAYHALL_TEST_DB_URL is required; this gate never skips');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('Invalid disposable Report database target'); }
  const database = parsed.pathname.slice(1);
  const protocol = ['postgres:', 'postgresql:'].includes(parsed.protocol);
  const local = parsed.hostname === '127.0.0.1' && database === 'relayhall_report_sponsor_test';
  const service = ci === 'true' && parsed.hostname === 'postgres' && database === 'relayhall_ci'
    && parsed.username === 'relayhall_ci' && parsed.port === '5432';
  if (!protocol || (!local && !service)) throw new Error('Exact disposable Report database target required');
  return parsed;
}
