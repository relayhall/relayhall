import { Writable } from 'stream';

/**
 * stdioStdoutGuard - give the MCP stdio transport the process's real stdout,
 * and divert everything else that is written there to stderr (card f268a05c).
 *
 * `src/mcp/stdio.ts` serves JSON-RPC over stdin/stdout, so stdout IS the
 * transport: one stray line between two frames breaks the client's parse. The
 * backend is not written for that. `db/connection.ts` logs "Database
 * connected" with `console.log` on every new pool connection, config loading
 * and other services log the same way, and the in-process dispatch opens the
 * pool lazily on the first tool call - which is after the transport started.
 * Auditing every logger in the backend for stdout use would be a census that
 * the next `console.log` quietly defeats, so the guard takes the other side of
 * the boundary: from the moment it is claimed, ONLY the writable returned here
 * reaches the real stdout, and `process.stdout.write` itself - the thing every
 * `console.log`, `console.info`, `console.debug` and direct write goes through -
 * is a stderr write.
 *
 * What it does not cover, said plainly: a native addon or a child process that
 * inherits file descriptor 1 writes to it without passing through Node's
 * stream. Nothing on the MCP path starts one, and a gate that started the real
 * entry (`mcpStdioStdoutPurity.test.ts`) is what would notice if that changed.
 *
 * It is a module of its own, outside `src/mcp`, on purpose: the MCP posture
 * gate censuses every write to surviving process state under `src/mcp`, and
 * this one is process plumbing that the entry makes once, before any request
 * exists, not state a caller can reach.
 */

const claimed = new WeakSet<object>();

type AnyWrite = (chunk: unknown, ...rest: unknown[]) => boolean;

/**
 * Take `stdout` for the transport. Returns the only stream that still reaches
 * the real stdout; hand it to `StdioServerTransport` as its output. After this
 * call `stdout.write` forwards to `stderr`. Throws if `stdout` was already
 * claimed: a second claim would capture the diverted write as "the real one"
 * and send the transport's frames to stderr.
 */
export function claimStdoutForTransport(
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): Writable {
  if (claimed.has(stdout)) throw new Error('stdout is already claimed for the MCP stdio transport');
  claimed.add(stdout);

  const realWrite = (stdout.write as unknown as AnyWrite).bind(stdout);
  const divertedWrite = (stderr.write as unknown as AnyWrite).bind(stderr);

  // The transport sees an ordinary Writable: it awaits 'drain' when `write`
  // returns false and listens for 'error', and this passes both through from
  // the real stream (the callback is how a failed write, e.g. a closed pipe,
  // reaches it).
  const transportOutput = new Writable({
    decodeStrings: false,
    write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      if (typeof chunk === 'string') realWrite(chunk, encoding, callback);
      else realWrite(chunk, callback);
    },
  });

  stdout.write = ((chunk: unknown, ...rest: unknown[]) => divertedWrite(chunk, ...rest)) as typeof stdout.write;
  return transportOutput;
}
