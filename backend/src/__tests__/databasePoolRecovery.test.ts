import { spawnSync } from 'child_process';
import path from 'path';

// The production connection module and real pg-pool run in a child process:
// process.exit is deliberately NOT mocked. Only the wire Client is replaced,
// so these controls exercise pool ownership/replacement without opening a DB.
// Actual PostgreSQL stop/recovery is a separate disposable acceptance gate.
const backendRoot = path.resolve(__dirname, '../..');
const connectionPath = path.join(backendRoot, 'src/db/connection.ts');
const secretSentinel = 'private-driver-value-must-not-be-logged';

function probe(mode: 'idle' | 'query' | 'queue') {
  const script = `
    const assert = require('node:assert/strict');
    const { EventEmitter } = require('node:events');
    const { pool, BOOT_CHECK_MODE } = require(${JSON.stringify(connectionPath)});
    assert.equal(BOOT_CHECK_MODE, true);
    let constructed = 0;
    class WireClient extends EventEmitter {
      constructor() { super(); this._queryable = true; this._ending = false; this.number = ++constructed; }
      connect(callback) { queueMicrotask(() => callback(null)); }
      query(text, _values, callback) {
        queueMicrotask(() => text === 'fail'
          ? callback(new Error(${JSON.stringify(secretSentinel)}))
          : callback(null, { rows: [{ client: this.number }], rowCount: 1 }));
      }
      end(callback) { this._ending = true; this.emit('end'); if (callback) callback(); }
    }
    pool.Client = WireClient;
    // A real socket keeps Node alive; the wire fake needs that lifetime too.
    const keepAlive = setInterval(() => {}, 1000);
    (async () => {
      let removed = 0;
      pool.on('remove', () => { removed += 1; });
      if (${JSON.stringify(mode)} === 'queue') {
        const held = await pool.connect();
        // Test-local short deadline; production configuration is unchanged.
        pool.options.connectionTimeoutMillis = 20;
        await assert.rejects(pool.connect(), /timeout exceeded/);
        held.release();
        const result = await pool.query('select fixture');
        assert.equal(result.rows[0].client, 1);
        await pool.end();
        process.stdout.write('QUEUE_TIMEOUT_REJECTED_AND_RECOVERED');
        return;
      }
      if (${JSON.stringify(mode)} === 'idle') {
        const client = await pool.connect();
        client.release();
        assert.equal(pool.idleCount, 1);
        client.emit('error', new Error(${JSON.stringify(secretSentinel)}));
        assert.equal(pool.totalCount, 0);
        assert.equal(pool.idleCount, 0);
        assert.equal(removed, 1);
      } else {
        await assert.rejects(pool.query('fail'), { message: ${JSON.stringify(secretSentinel)} });
        assert.equal(pool.totalCount, 0);
        assert.equal(removed, 1);
      }
      const replacement = await pool.query('select fixture');
      assert.equal(replacement.rows[0].client, 2);
      assert.equal(constructed, 2);
      await pool.end();
      process.stdout.write('POOL_RECOVERY_RESULT=' + JSON.stringify({ mode: ${JSON.stringify(mode)}, replaced: true, propagatedQueryFailure: ${JSON.stringify(mode)} === 'query' }) + '\\n');
    })().catch(() => { process.stderr.write('POOL_RECOVERY_PROBE_FAILED\\n'); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
  `;
  return spawnSync(process.execPath, ['--import', require.resolve('tsx'), '--eval', script], {
    cwd: backendRoot,
    env: { ...process.env, RELAYHALL_BOOT_CHECK: '1' },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

describe('production database pool recovery', () => {
  it('still rejects queued acquisition timeout and can use the released client', () => {
    const result = probe('queue');
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('QUEUE_TIMEOUT_REJECTED_AND_RECOVERED');
    expect(result.stderr).not.toContain('[Database] unexpected pool failure');
  });

  it('logs an idle-client error without terminating and replaces that failed client', () => {
    const result = probe('idle');
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('POOL_RECOVERY_RESULT={"mode":"idle","replaced":true');
    expect(result.stderr.match(/\[Database\] unexpected pool failure/g)).toHaveLength(1);
    expect(result.stderr).toMatch(/\[class=Error code=ERROR_UNCLASSIFIED id=[0-9a-f-]{36}\]/);
    expect(result.stdout + result.stderr).not.toContain(secretSentinel);
  });

  it('still rejects a failed query and replaces its discarded client', () => {
    const result = probe('query');
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"propagatedQueryFailure":true');
    expect(result.stderr).not.toContain('[Database] unexpected pool failure');
    expect(result.stdout + result.stderr).not.toContain(secretSentinel);
  });
});
