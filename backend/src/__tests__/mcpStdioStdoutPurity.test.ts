/**
 * The stdio MCP entry keeps stdout for JSON-RPC frames (card f268a05c).
 *
 * `src/mcp/stdio.ts` promises that NOTHING IS EVER WRITTEN TO STDOUT except
 * JSON-RPC frames, because stdout IS the transport. The promise was broken by
 * the connection pool: `src/db/connection.ts` logs "Database connected" with
 * `console.log` on every new pool connection, the in-process dispatch opens
 * the pool lazily on the first tool call, and so a harness reading frames off
 * the pipe saw that line between two of them. The SDK v2 live drill found it
 * (qa/sdkmig-7e0a04d/live-drill.txt rows 43-48); the v1 drill had never
 * started the stdio entry, so nobody had.
 *
 * WHAT THIS MEASURES. It starts the REAL entry, as a child process, with a
 * real `pg` pool aimed at a stand-in PostgreSQL that completes the wire
 * handshake. Then it drives the entry exactly as a harness does - initialize,
 * then a tools/call that reaches the database - and reads stdout and stderr
 * separately:
 *
 *  - every non-empty stdout line must parse as a JSON-RPC 2.0 frame, BEFORE and
 *    AFTER the first pool connection (the stand-in counts the handshakes, so
 *    "after the pool connected" is observed rather than assumed);
 *  - the pool's own log line must be present on STDERR. That half is the
 *    control: a repair that merely silenced the logger, or a drill whose pool
 *    never connected, would also show a clean stdout.
 *
 * A second test pins the control itself. The same pool, started WITHOUT the
 * stdio entry, does write the line to stdout, so "no such line on stdout" above
 * is a statement about the guard and not about a stand-in that never triggers
 * the log.
 *
 * The suite needs no database: the stand-in answers every query with an error,
 * which the tool call reports as an ordinary JSON-RPC result.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import net from 'net';
import path from 'path';
import { Console } from 'console';
import { PassThrough } from 'stream';

import { claimStdoutForTransport } from '../utils/stdioStdoutGuard';

jest.setTimeout(120_000);

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// A structurally valid principal credential (rh_(live|dev)_<keyId>.<secret>,
// services/PrincipalService.parsePrincipalKey). Anything malformed is refused
// before the database is touched, which would defeat the drill; this one is
// looked up, and the stand-in database - which refuses every query - then
// authenticates nothing.
const FAKE_TOKEN = 'rh_dev_a1b2c3d4e5f6a7b8.stdio_stand_in_secret_00000';
const POOL_LOG_LINE = 'Database connected';

// ───────────────────────── a stand-in PostgreSQL ─────────────────────────

interface FakePostgres {
  port: number;
  /** Connections that completed the startup handshake (the pool 'connect' event follows each). */
  handshakes(): number;
  close(): Promise<void>;
}

function errorResponse(message: string): Buffer {
  const fields = Buffer.concat([
    Buffer.from('SERROR\0', 'latin1'),
    Buffer.from('CXX000\0', 'latin1'),
    Buffer.from(`M${message}\0`, 'latin1'),
    Buffer.from('\0', 'latin1'),
  ]);
  const header = Buffer.alloc(5);
  header.write('E', 0, 'latin1');
  header.writeInt32BE(4 + fields.length, 1);
  return Buffer.concat([header, fields]);
}

const READY_FOR_QUERY = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]); // 'Z', len 5, idle
const AUTHENTICATION_OK = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]); // 'R', len 8, ok
const SSL_REQUEST_CODE = 80877103;
const PROTOCOL_3_0 = 196608;

function startFakePostgres(): Promise<FakePostgres> {
  let handshakes = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* a killed child resets its sockets */ });
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          const code = buffer.readInt32BE(4);
          buffer = buffer.subarray(length);
          if (code === SSL_REQUEST_CODE) { socket.write('N'); continue; }
          if (code !== PROTOCOL_3_0) { socket.destroy(); return; }
          started = true;
          handshakes += 1;
          socket.write(Buffer.concat([AUTHENTICATION_OK, READY_FOR_QUERY]));
          continue;
        }
        if (buffer.length < 5) return;
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        if (buffer.length < 1 + length) return;
        buffer = buffer.subarray(1 + length);
        // Simple query ('Q') and the extended protocol's Sync ('S') both end
        // a cycle: refuse it and say the connection is idle again.
        if (type === 'Q' || type === 'S') {
          socket.write(Buffer.concat([errorResponse('stand-in database refuses every query'), READY_FOR_QUERY]));
        } else if (type === 'X') {
          socket.end();
          return;
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') { reject(new Error('no address')); return; }
      resolve({
        port: address.port,
        handshakes: () => handshakes,
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

// ───────────────────────── driving the child ─────────────────────────

function databaseEnv(port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'test',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(port),
    DB_NAME: 'relayhall_test_stdio_stand_in',
    DB_USER: 'relayhall_test_stdio',
    DB_PASSWORD: 'stand-in-password',
    JWT_SECRET: 'qa-stdio-only',
    DATA_DIR: './qa-stdio-data',
    RELAYHALL_CREDENTIAL_KEYS: process.env.RELAYHALL_CREDENTIAL_KEYS ?? '',
    RELAYHALL_CREDENTIAL_ACTIVE_KEY: process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY ?? '',
  };
}

interface Captured {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Collect a child's output; kill it if it overstays, so the suite never leaks it. */
function collect(child: ChildProcessWithoutNullStreams, killAfterMs: number): { done: Promise<Captured>; snapshot(): Captured } {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
  const done = new Promise<Captured>((resolve, reject) => {
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not exit within ${killAfterMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, killAfterMs);
    child.once('exit', (code) => { clearTimeout(killer); resolve({ stdout, stderr, code }); });
    child.once('error', (error) => { clearTimeout(killer); reject(error); });
  });
  return { done, snapshot: () => ({ stdout, stderr, code: null }) };
}

function frameIds(stdout: string): Array<number | string> {
  return stdout.split('\n').filter((line) => line.trim() !== '').flatMap((line) => {
    try {
      const frame = JSON.parse(line) as { id?: number | string };
      return frame.id === undefined ? [] : [frame.id];
    } catch { return []; }
  });
}

async function until(label: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Every non-empty line must be one JSON-RPC 2.0 frame. Returns the offending
 * lines, so a failure prints exactly what leaked.
 */
function nonFrameLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.trim() !== '').filter((line) => {
    try {
      const frame = JSON.parse(line) as unknown;
      return !(frame !== null && typeof frame === 'object' && !Array.isArray(frame)
        && (frame as { jsonrpc?: unknown }).jsonrpc === '2.0');
    } catch { return true; }
  });
}

describe('nonFrameLines (the check the stdio drill relies on)', () => {
  it('passes JSON-RPC frames and names anything else', () => {
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
    expect(nonFrameLines(`${frame}\n${frame}\n`)).toEqual([]);
    expect(nonFrameLines(`${frame}\n✅ Database connected\n${frame}\n`)).toEqual(['✅ Database connected']);
    expect(nonFrameLines('{"id":1}\n[]\n42\nnull\n')).toEqual(['{"id":1}', '[]', '42', 'null']);
  });
});

describe('claimStdoutForTransport', () => {
  function streams() {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let outText = '';
    let errText = '';
    stdout.setEncoding('utf8').on('data', (data: string) => { outText += data; });
    stderr.setEncoding('utf8').on('data', (data: string) => { errText += data; });
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    return {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      out: () => outText,
      err: () => errText,
      settle,
    };
  }

  it("sends the transport's frames to stdout in order, and every other write to stderr", async () => {
    const io = streams();
    const transportOutput = claimStdoutForTransport(io.stdout, io.stderr);

    // Everything a dependency can do to stdout: a string, a Buffer, a write
    // with an encoding and a callback, and console.log / console.info /
    // console.debug (a Console writes through `stream.write` at call time).
    io.stdout.write('direct string\n');
    io.stdout.write(Buffer.from('direct buffer\n'));
    await new Promise<void>((resolve) => io.stdout.write('with callback\n', 'utf8', () => resolve()));
    const logger = new Console(io.stdout, io.stderr);
    logger.log('console.log line');
    logger.info('console.info line');
    logger.debug('console.debug line');

    transportOutput.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    transportOutput.write(Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'));
    await io.settle();

    expect(io.out()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n');
    for (const line of ['direct string', 'direct buffer', 'with callback', 'console.log line', 'console.info line', 'console.debug line']) {
      expect(io.err()).toContain(line);
      expect(io.out()).not.toContain(line);
    }
  });

  it('refuses a second claim instead of capturing the diverted write as the real one', async () => {
    const io = streams();
    const transportOutput = claimStdoutForTransport(io.stdout, io.stderr);
    expect(() => claimStdoutForTransport(io.stdout, io.stderr)).toThrow(/already claimed/);
    transportOutput.write('frame\n');
    io.stdout.write('noise\n');
    await io.settle();
    expect(io.out()).toBe('frame\n');
    expect(io.err()).toBe('noise\n');
  });
});

describe('the stdio MCP entry - stdout carries JSON-RPC frames and nothing else', () => {
  let database: FakePostgres;
  beforeAll(async () => { database = await startFakePostgres(); });
  afterAll(async () => { await database.close(); });

  it('writes only frames to stdout across the first pool connection, and logs the pool line to stderr', async () => {
    const child = spawn(process.execPath, [TSX_CLI, 'src/mcp/stdio.ts'], {
      cwd: BACKEND_DIR,
      env: { ...databaseEnv(database.port), RELAYHALL_TOKEN: FAKE_TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = collect(child, 100_000);
    const send = (message: unknown): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
    try {
      // BEFORE the first pool connection: the handshake, and nothing has
      // touched the database yet.
      send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stdio-purity-drill', version: '0.0.0' } },
      });
      await until('the initialize answer', () => frameIds(output.snapshot().stdout).includes(1), 60_000);
      expect(database.handshakes()).toBe(0);
      expect(nonFrameLines(output.snapshot().stdout)).toEqual([]);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      // The first tools/call reaches the database: the pool connects here.
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'relayhall_principal_whoami', arguments: {} } });
      await until('the tools/call answer', () => frameIds(output.snapshot().stdout).includes(2), 60_000);

      // AFTER the pool connected: observed at the stand-in, not assumed.
      expect(database.handshakes()).toBeGreaterThan(0);
    } finally {
      child.stdin.end();
      setTimeout(() => child.kill('SIGTERM'), 3_000).unref();
    }
    const finished = await output.done;

    expect(nonFrameLines(finished.stdout)).toEqual([]);
    expect(frameIds(finished.stdout)).toEqual(expect.arrayContaining([1, 2]));
    // Card 233d8959: stdio must use the same tool-result trust boundary as
    // HTTP, including the error text this stand-in database may produce.
    const callFrame = finished.stdout.split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> } })
      .find((frame) => frame.id === 2);
    expect(callFrame?.result?.content?.[0]?.text).toContain('--- untrusted data from MCP tool result:');
    expect(finished.stdout).not.toContain(POOL_LOG_LINE);
    // The control half: the pool DID log, and the line went where logs go.
    expect(finished.stderr).toContain(POOL_LOG_LINE);
    expect(finished.stderr).toContain('relayhall MCP stdio ready');
  });

  it('control: the same pool, outside the stdio entry, does log that line to stdout', async () => {
    // Without this, a clean stdout above could mean the stand-in never made the
    // pool log at all.
    const child = spawn(process.execPath, [TSX_CLI, '-e',
      "const { pool } = require('./src/db/connection'); pool.query('SELECT 1').catch(() => {}).finally(() => process.exit(0));",
    ], { cwd: BACKEND_DIR, env: databaseEnv(database.port), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    const finished = await collect(child, 60_000).done;
    expect(finished.code).toBe(0);
    expect(finished.stdout).toContain(POOL_LOG_LINE);
  });
});
