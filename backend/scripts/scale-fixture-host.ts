/** A CI service name is disposable only inside CI and for its exact fixture. */
export function isScaleFixtureHost(host: string, database: string, ci: string | undefined): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(host)
    || (host === 'postgres' && ci === 'true' && database === 'relayhall_ci');
}
