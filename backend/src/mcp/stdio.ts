#!/usr/bin/env node
/**
 * stdio — the local MCP entry (MCP spec de73f9f8 §1.3 "dual transport";
 * owner decision D1: one registry, two transports).
 *
 * Run by a harness on the same machine as the board process:
 *
 *   RELAYHALL_TOKEN=rh_… node dist/mcp/stdio.js
 *
 * It serves THE registry — the same tools, the same shaping, the same
 * in-process dispatch stamped `mcp` — over stdin/stdout instead of HTTP.
 * There is no second implementation to drift.
 *
 * NOTHING IS EVER WRITTEN TO STDOUT except JSON-RPC frames: stdout IS the
 * transport. Diagnostics go to stderr.
 *
 * That sentence is enforced, not hoped for (card f268a05c): the backend logs
 * with `console.log` in places this entry does not control - the database pool
 * announces every new connection, and the in-process dispatch opens the pool
 * lazily on the first tool call, between two frames. So `main()` claims stdout
 * for the transport BEFORE the registry and the backend behind it are loaded,
 * and from then on every other write to `process.stdout` is a stderr write. The
 * registry is therefore imported inside `main()`, after the claim: a static
 * import would run the backend's module-level code first.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { logCaughtFailure } from '../utils/secretSafeLog';
import { claimStdoutForTransport } from '../utils/stdioStdoutGuard';

async function main(): Promise<void> {
  const token = process.env.RELAYHALL_TOKEN || '';
  if (!token.startsWith('rh_')) {
    process.stderr.write(
      'RELAYHALL_TOKEN must be a RelayHall principal credential (rh_<env>_<keyId>.<secret>).\n'
      + 'Legacy environment keys and dashboard tokens are not accepted on the MCP surface.\n',
    );
    process.exitCode = 2;
    return;
  }
  const transportOutput = claimStdoutForTransport();
  const { buildMcpServer, MCP_PROTOCOL_REVISION } = await import('./server');
  const authorization = `Bearer ${token}`;
  const server = buildMcpServer((toolName) => ({ authorization, toolName }));
  const transport = new StdioServerTransport(process.stdin, transportOutput);
  await server.connect(transport);
  process.stderr.write(`relayhall MCP stdio ready (protocol ${MCP_PROTOCOL_REVISION})\n`);
}

if (require.main === module) {
  main().catch((error) => {
    // Never the caught text: the sink publishes a registered class, a
    // closed-set code and a correlating id, and nothing read off the value.
    const errorId = logCaughtFailure('[MCP stdio] startup failed:', error);
    process.stderr.write(`relayhall MCP stdio failed (errorId ${errorId})\n`);
    process.exitCode = 1;
  });
}

export { main };
