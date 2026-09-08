/** Verify both real entry guards without opening a database connection. */
const ALLOWED = 'SCALE_GUARD_REACHED_EXPRESS';
const cases: Array<[string, string, string, string | undefined, boolean]> = [
  ['local fixture', '127.0.0.1', 'relayhall_scale_guard_probe', undefined, true],
  ['localhost fixture', 'localhost', 'relayhall_scale_guard_probe', undefined, true],
  ['CI fixture', 'postgres', 'relayhall_ci', 'true', true],
  ['CI host outside CI', 'postgres', 'relayhall_ci', undefined, false],
  ['false CI marker', 'postgres', 'relayhall_ci', 'false', false],
  ['truthy non-CI marker', 'postgres', 'relayhall_ci', '1', false],
  ['CI host with nonfixture name', 'postgres', 'ordinary_database', 'true', false],
  ['CI host with a local fixture name', 'postgres', 'relayhall_scale_guard_probe', 'true', false],
  ['remote host in CI', 'database.example.test', 'relayhall_ci', 'true', false],
  ['remote host outside CI', 'database.example.test', 'relayhall_scale_guard_probe', undefined, false],
  ...['relayhall_dev', 'relayhall_tst', 'relayhall_prod', 'relayhall'].map(
    (name): [string, string, string, string | undefined, boolean] => [`deployment ${name}`, '127.0.0.1', name, 'true', false],
  ),
  ['missing database', '127.0.0.1', '', undefined, false],
];

describe.each(['seed', 'live suite'] as const)('%s database entry guard', (entry) => {
  test.each(cases)('%s', (_label, host, database, ci, expected) => {
    const saved = { ...process.env };
    let accepted = false;
    let error: unknown;
    try {
      process.env.DB_HOST = host;
      process.env.DB_NAME = database;
      process.env.DB_PORT = '59999';
      process.env.DB_USER = 'scale_guard';
      process.env.DB_PASSWORD = 'scale_guard';
      process.env.RELAYHALL_TEST_DB_URL = `postgres://scale_guard:scale_guard@${host}:59999/${database}`;
      if (ci === undefined) delete process.env.CI;
      else process.env.CI = ci;
      if (entry === 'live suite') {
        // Stop the ACTUAL suite immediately after its URL guard and before
        // it can import the pool, register hooks or contact PostgreSQL.
        jest.doMock('express', () => { throw new Error(ALLOWED); });
      }
      jest.isolateModules(() => {
        try {
          if (entry === 'seed') {
            const { databasePoolConfig } = require('../db/connection');
            expect(databasePoolConfig.host).toBe(host);
            expect(databasePoolConfig.database).toBe(database || 'relayhall_dev');
            require('../../scripts/seed-scale-fixture').assertDisposableTarget();
            accepted = true;
          } else {
            require('./scaleReadLoad.test');
          }
        } catch (caught) { error = caught; }
      });
      if (entry === 'live suite' && error instanceof Error && error.message === ALLOWED) {
        accepted = true;
      }
    } finally {
      process.env = saved;
      jest.dontMock('express');
    }
    expect(accepted).toBe(expected);
    if (!expected) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/deployment database|no database name|not local|non-local host/);
    }
  });
});
