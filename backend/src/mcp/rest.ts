/**
 * rest — the one call a tool handler makes.
 *
 * Every tool composes board routes through `callBoard`, which dispatches
 * in-process with the `mcp` stamp (see `mcp/inProcess`) and turns a non-2xx
 * into the instructive `McpToolError` §3 requires. No tool reaches a service,
 * a repository or the pool directly: "every authorization decision therefore
 * happens exactly once, in the backend's central authz helper"
 * (de73f9f8 §1.1), and that helper sits behind these routes.
 */
import { dispatchInProcess, type InProcessRequest } from './inProcess';
import { errorFromRest } from './shape';

export interface McpCallContext {
  /** The caller's `Authorization` header, forwarded verbatim (§2.1). */
  authorization: string;
  /** `clientInfo` from the MCP handshake — audit correlation only (§4.3). */
  client?: { name?: string; version?: string };
  /** The tool being executed, for error text and audit correlation. */
  toolName: string;
}

export interface BoardCall extends Omit<InProcessRequest, 'authorization'> {
  /** The scope this route requires, quoted back on a 403 (§3). */
  requiredScope?: string;
  /** Statuses to hand back as a value instead of throwing (e.g. 304, 409). */
  tolerate?: number[];
}

export interface BoardResult {
  status: number;
  body: unknown;
  headers: Record<string, string | number | string[] | undefined>;
}

export async function callBoard(ctx: McpCallContext, call: BoardCall): Promise<BoardResult> {
  const { requiredScope, tolerate, ...request } = call;
  const result = await dispatchInProcess({ ...request, authorization: ctx.authorization });
  if (result.status >= 200 && result.status < 300) return result;
  if (tolerate?.includes(result.status)) return result;
  throw errorFromRest(ctx.toolName, result.status, result.body, requiredScope);
}

/** The common case: a 2xx JSON envelope, returned as a plain object. */
export async function board(ctx: McpCallContext, call: BoardCall): Promise<Record<string, unknown>> {
  const result = await callBoard(ctx, call);
  return (result.body ?? {}) as Record<string, unknown>;
}
