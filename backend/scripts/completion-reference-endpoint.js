// Pure assertion: no driver, configuration files, defaults or connections.
function assertCompletionReferenceEndpoint(env) {
  if (env.RELAYHALL_OWNED_FIXTURE !== 'completion-reference' || !env.RELAYHALL_TEST_DB_URL) throw Error('Explicit owned completion reference fixture required');
  let u; try { u = new URL(env.RELAYHALL_TEST_DB_URL); } catch { throw Error('Invalid owned fixture URL'); }
  const name = decodeURIComponent(u.pathname.slice(1));
  const user = decodeURIComponent(u.username), password = decodeURIComponent(u.password);
  const port = Number(u.port);
  const local = u.hostname === '127.0.0.1' && port > 1024 && port <= 65535 && port !== 5432;
  const ci = env.CI === 'true' && u.hostname === 'postgres' && port === 5432 && user === 'fixture';
  if (!['postgres:','postgresql:'].includes(u.protocol) || !u.port || !/^mixed_cleanup_test(?:_[a-z0-9]+)*$/i.test(name) || !user || !password || u.search || u.hash || (!local && !ci)) throw Error('Explicit owned fixture endpoint required; no default endpoint');
  const fields = {PGHOST:u.hostname, DB_HOST:u.hostname, PGPORT:u.port, DB_PORT:u.port, PGDATABASE:name, DB_NAME:name, PGUSER:user, DB_USER:user, PGPASSWORD:password, DB_PASSWORD:password};
  for (const [key,value] of Object.entries(fields)) if (env[key] !== value) throw Error('Owned fixture endpoint mismatch: ' + key);
  // DATABASE_URL is deliberately ignored: readiness uses PG*, storage DB_*.
  return Object.freeze(fields);
}
module.exports = {assertCompletionReferenceEndpoint};
