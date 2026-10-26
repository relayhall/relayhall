/**
 * McpActionLog — THE PER-SESSION MCP ACTION LOG (card `ab8f78e9`; owner
 * rulings E91 and E89 (c), 11 Oct 2026).
 *
 * E91 approved "the per-session action log (tool, target, outcome, time;
 * never arguments)" as Telemetry scope. This module is layer 1 of it: every
 * ADMITTED MCP `tools/call` made inside a live MCP-derived session (card
 * `35b73092`, `McpSessionTelemetry`) adds ONE row to `mcp_action_log`
 * (migration 161), and the Agent sessions page shows the rows of a session
 * when that session's row is opened.
 *
 * ── WHAT A ROW HOLDS, AND ONLY THAT ──
 *
 *  - `session_ref`, `connector_id`, `account_id`, `agent_id`: the session the
 *    call belongs to and its owner, exactly as the session's own envelope rows
 *    carry them. The owner comes from `TelemetryPrincipalService.derive` over
 *    the caller's authenticated chain (through `McpSessionTelemetry`), never
 *    from a tool argument.
 *  - `tool_name`: the registry name of the tool that ran. The row is built
 *    only for a name in THE registry (`mcp/registry.MCP_TOOLS`), so the set is
 *    closed; the column CHECK refuses anything outside the tool grammar.
 *  - `target_type` and `target_id`: taken ONLY from one per-tool allowlisted
 *    argument (`MCP_ACTION_TARGET_ARGUMENTS`) and only when its value is a
 *    complete UUID. A tool with no entry, an argument that is absent, and a
 *    value that is not a UUID all record NO target. The type is one of five
 *    (task, report, phase, project, skill); the CHECK holds the same five.
 *  - `outcome` (`ok` | `error`) and, for an error, ONE closed code
 *    (`MCP_ACTION_ERROR_CODES`) derived from the error's CLASS and the board's
 *    HTTP status — never from its message.
 *  - `duration_ms` of the handler, and `observed_at`.
 *
 * NOTHING ELSE. No argument value, no argument name, no free text, no error
 * message and no tool result is ever handed to the row builder — the builder
 * takes the target it is given and the code, and the INSERT names its eleven
 * columns. That is why no redaction is needed: there is nothing to redact.
 *
 * ── NEVER IN THE TOOL'S WAY ──
 *
 * `enqueue` is synchronous, constant-time and never throws. The write runs
 * after the tool has answered, on its own, and is BOUNDED twice: at most
 * `MCP_ACTION_LOG_MAX_IN_FLIGHT` writes are outstanding at once (a further row
 * is dropped and counted, so a slow database cannot queue memory or take the
 * pool's connections from the tools), and each INSERT carries a
 * `query_timeout`. A failed or dropped write logs one rate-limited,
 * secret-free warning (`logCaughtWarning`: category, class and code only) —
 * the row's values are never logged.
 *
 * ── SCOPE ──
 *
 * MCP only. REST and CLI calls made with the same credential do not pass
 * through `tools/call` and are not recorded; the page says so. A call made
 * outside a live session (an introspection call after the bootstrap lapsed, a
 * Connector that declared no telemetry tier, an Account-plane credential)
 * records nothing, because there is no session to hold it. Full transcripts
 * stay parked (E91 (3)).
 *
 * ── RETENTION ──
 *
 * The rows are swept by `TelemetryRetentionService` as class
 * `mcp_action_log`, with a receipt, at the SAME bound as the session's own
 * event metadata (`RELAYHALL_TELEMETRY_RETENTION_DAYS`, default 90 days — E89
 * (c)), so the log never outlives the session it belongs to.
 */
import { pool as defaultPool } from '../db/connection';
import { McpToolError } from '../mcp/shape';
import { logCaughtWarning } from '../utils/secretSafeLog';

/** The five object kinds a target can name (the migration 161 CHECK holds the same five). */
export const MCP_ACTION_TARGET_TYPES = ['task', 'report', 'phase', 'project', 'skill'] as const;
export type McpActionTargetType = (typeof MCP_ACTION_TARGET_TYPES)[number];

export const MCP_ACTION_OUTCOMES = ['ok', 'error'] as const;
export type McpActionOutcome = (typeof MCP_ACTION_OUTCOMES)[number];

/**
 * The closed error vocabulary (the migration 161 CHECK holds the same set).
 *
 *  - `tool_refused`: the tool itself refused the call before or without the
 *    board answering — almost always its arguments;
 *  - `bad_request` … `server_error`: the board answered with that HTTP class
 *    (400/422, 401, 403, 404, 409/412, 429, 503, another 5xx);
 *  - `rejected`: any other 4xx the board answered;
 *  - `internal`: the handler failed with something that is not a tool error.
 */
export const MCP_ACTION_ERROR_CODES = [
  'tool_refused',
  'bad_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'rejected',
  'unavailable',
  'server_error',
  'internal',
] as const;
export type McpActionErrorCode = (typeof MCP_ACTION_ERROR_CODES)[number];

/**
 * THE TARGET ALLOWLIST: per tool, the ONE argument (or, for the Brief compile
 * verb, the altitude arguments in order) a target may be read from, and the
 * kind it names. A tool absent from this table records no target, whatever it
 * was sent. Entries name the object the call ACTS ON or READS; arguments that
 * name a principal, a credential, a Warrant, a lease, a Resource or anything
 * else are deliberately absent, and so are list and search filters.
 */
export const MCP_ACTION_TARGET_ARGUMENTS: Readonly<Record<string, ReadonlyArray<readonly [string, McpActionTargetType]>>> =
  Object.freeze({
    // Task altitude
    relayhall_task_get: [['task', 'task']],
    relayhall_task_update: [['task', 'task']],
    relayhall_task_archive: [['task', 'task']],
    relayhall_task_restore: [['task', 'task']],
    relayhall_task_move: [['task', 'task']],
    relayhall_task_account_owner_get: [['task', 'task']],
    relayhall_task_account_owner_change: [['task', 'task']],
    relayhall_task_dependency_add: [['taskId', 'task']],
    relayhall_task_dependency_remove: [['taskId', 'task']],
    relayhall_subtask_set: [['task', 'task']],
    relayhall_subtask_create: [['task', 'task']],
    relayhall_subtask_reorder: [['task', 'task']],
    relayhall_subtask_update_text: [['task', 'task']],
    relayhall_task_stream_list: [['task', 'task']],
    relayhall_task_stream_append: [['task', 'task']],
    relayhall_task_timeline_get: [['task', 'task']],
    relayhall_task_report_list: [['task', 'task']],
    relayhall_task_report_get: [['task', 'task']],
    relayhall_task_report_reconcile: [['task', 'task']],
    relayhall_task_report_save: [['task', 'task']],
    relayhall_task_finish: [['task', 'task']],
    relayhall_task_reference_list: [['task', 'task']],
    relayhall_task_reference_create: [['task', 'task']],
    relayhall_task_success_criteria_set: [['task', 'task']],
    relayhall_task_arm: [['task', 'task']],
    relayhall_task_park: [['task', 'task']],
    relayhall_task_claim: [['task', 'task']],
    relayhall_task_release: [['task', 'task']],
    relayhall_task_recover: [['task', 'task']],
    relayhall_task_native_generation: [['task', 'task']],
    relayhall_task_native_execution: [['task', 'task']],
    relayhall_task_native_review: [['task', 'task']],
    relayhall_review_run: [['task', 'task']],
    relayhall_review_reject: [['task', 'task']],
    relayhall_lease_claim: [['task', 'task']],
    relayhall_lease_renew: [['task', 'task']],
    relayhall_lease_release: [['task', 'task']],
    // The Brief: exactly one altitude per call; `session: true` names no object.
    relayhall_brief_compile: [['taskId', 'task'], ['phaseId', 'phase'], ['projectId', 'project']],
    // Report
    relayhall_report_get: [['reportId', 'report']],
    relayhall_report_update: [['reportId', 'report']],
    // Phase
    relayhall_phase_get: [['phaseId', 'phase']],
    relayhall_phase_update: [['phaseId', 'phase']],
    relayhall_phase_archive: [['phaseId', 'phase']],
    relayhall_phase_restore: [['phaseId', 'phase']],
    // Project (a Phase is created under its Project; a Resource is read or
    // written on its Project, and the Resource id itself is not recorded)
    relayhall_phase_create: [['projectId', 'project']],
    relayhall_project_get: [['projectId', 'project']],
    relayhall_project_update: [['projectId', 'project']],
    relayhall_project_archive: [['projectId', 'project']],
    relayhall_project_restore: [['projectId', 'project']],
    relayhall_project_context_get: [['projectId', 'project']],
    relayhall_charter_get: [['projectId', 'project']],
    relayhall_project_resource_list: [['projectId', 'project']],
    relayhall_project_resource_get: [['projectId', 'project']],
    relayhall_project_resource_create: [['projectId', 'project']],
    relayhall_project_resource_update: [['projectId', 'project']],
    relayhall_project_resource_archive: [['projectId', 'project']],
    relayhall_project_resource_restore: [['projectId', 'project']],
    relayhall_project_resource_replace: [['projectId', 'project']],
    // Skill
    relayhall_skill_get: [['skillId', 'skill']],
  });

/** A complete UUID, any version, either case — the shape `target_id UUID` stores. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The tool-name grammar the migration 161 CHECK holds (`relayhall_<noun>_<verb>`). */
export const MCP_ACTION_TOOL_NAME_RE = /^relayhall_[a-z][a-z0-9_]{0,95}$/;
/** The longest handler duration a row states; a longer one is stated as this. */
export const MCP_ACTION_MAX_DURATION_MS = 86_400_000;

export interface McpActionTarget {
  type: McpActionTargetType;
  id: string;
}

/**
 * The target of one call: the first allowlisted argument of THIS tool whose
 * value is a complete UUID, lower-cased; otherwise none. Only the allowlist
 * is consulted — no other argument is read, whatever it holds.
 */
export function mcpActionTarget(toolName: string, args: Record<string, unknown>): McpActionTarget | null {
  if (!Object.prototype.hasOwnProperty.call(MCP_ACTION_TARGET_ARGUMENTS, toolName)) return null;
  for (const [key, type] of MCP_ACTION_TARGET_ARGUMENTS[toolName]) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    const value = args[key];
    if (typeof value === 'string' && UUID_RE.test(value)) return { type, id: value.toLowerCase() };
  }
  return null;
}

/** The closed code for a handler failure — from the error's class and HTTP status, never its text. */
export function mcpActionErrorCode(error: unknown): McpActionErrorCode {
  if (!(error instanceof McpToolError)) return 'internal';
  const status = error.httpStatus;
  if (status === undefined) return 'tool_refused';
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 412) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'server_error';
  return 'rejected';
}

/** The row as it is inserted — eleven columns, each named. */
export interface McpActionRow {
  session_ref: string;
  connector_id: string;
  account_id: string;
  agent_id: string | null;
  tool_name: string;
  target_type: McpActionTargetType | null;
  target_id: string | null;
  outcome: McpActionOutcome;
  error_code: McpActionErrorCode | null;
  duration_ms: number;
  observed_at: Date;
}

export interface McpActionRowInput {
  sessionRef: string;
  connectorId: string;
  accountId: string;
  agentId: string | null;
  toolName: string;
  target: McpActionTarget | null;
  /** `null` means the handler succeeded. */
  errorCode: McpActionErrorCode | null;
  durationMs: number;
  observedAt: Date;
}

/** The registry's tool names — read lazily, so importing this module does not load the router. */
let registeredNames: ReadonlySet<string> | null = null;
function registryToolNames(): ReadonlySet<string> {
  if (!registeredNames) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MCP_TOOLS } = require('../mcp/registry') as { MCP_TOOLS: Array<{ name: string }> };
    registeredNames = new Set(MCP_TOOLS.map((tool) => tool.name));
  }
  return registeredNames;
}

/**
 * Build the row, or null when it cannot be stated truthfully: a tool name the
 * registry does not hold, or a code outside the closed set. The input carries
 * no argument, so nothing here can copy one.
 */
export function buildMcpActionRow(
  input: McpActionRowInput,
  toolNames: ReadonlySet<string> = registryToolNames(),
): McpActionRow | null {
  if (!toolNames.has(input.toolName) || !MCP_ACTION_TOOL_NAME_RE.test(input.toolName)) return null;
  if (input.errorCode !== null && !(MCP_ACTION_ERROR_CODES as readonly string[]).includes(input.errorCode)) return null;
  const target = input.target
    && (MCP_ACTION_TARGET_TYPES as readonly string[]).includes(input.target.type) && UUID_RE.test(input.target.id)
    ? input.target : null;
  const duration = Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : 0;
  return {
    session_ref: input.sessionRef,
    connector_id: input.connectorId,
    account_id: input.accountId,
    agent_id: input.agentId,
    tool_name: input.toolName,
    target_type: target ? target.type : null,
    target_id: target ? target.id.toLowerCase() : null,
    outcome: input.errorCode === null ? 'ok' : 'error',
    error_code: input.errorCode,
    duration_ms: Math.min(Math.max(duration, 0), MCP_ACTION_MAX_DURATION_MS),
    observed_at: input.observedAt,
  };
}

/** At most this many log writes outstanding at once; a further row is dropped and counted. */
export const MCP_ACTION_LOG_MAX_IN_FLIGHT = 8;
/** Each INSERT gives up after this long; the tool answered long before. */
export const MCP_ACTION_LOG_WRITE_TIMEOUT_MS = 2_000;

export const MCP_ACTION_LOG_INSERT_SQL = `INSERT INTO mcp_action_log
  (session_ref, connector_id, account_id, agent_id, tool_name, target_type, target_id,
   outcome, error_code, duration_ms, observed_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

interface Insertable {
  query(config: { text: string; values: unknown[]; query_timeout?: number }): Promise<unknown>;
}

const WARN_INTERVAL_MS = 60_000;

export class McpActionLog {
  private inFlight = 0;
  private droppedCount = 0;
  private lastWarnAt = 0;

  constructor(private readonly pool: Insertable = defaultPool as unknown as Insertable) {}

  /**
   * Record one row, after the tool answered. Synchronous, never throws, never
   * awaited by the caller: the returned promise exists for tests only.
   */
  enqueue(row: McpActionRow | null): Promise<void> {
    try {
      if (!row) return Promise.resolve();
      if (this.inFlight >= MCP_ACTION_LOG_MAX_IN_FLIGHT) {
        this.droppedCount += 1;
        this.warn('[McpActionLog] write dropped: too many outstanding writes', new Error('MCP_ACTION_LOG_SATURATED'));
        return Promise.resolve();
      }
      // The slot is taken only once a write is really outstanding: a pool that
      // throws synchronously lands in the catch below holding no slot.
      const pending = this.pool.query({
        text: MCP_ACTION_LOG_INSERT_SQL,
        values: [
          row.session_ref, row.connector_id, row.account_id, row.agent_id, row.tool_name,
          row.target_type, row.target_id, row.outcome, row.error_code, row.duration_ms, row.observed_at,
        ],
        query_timeout: MCP_ACTION_LOG_WRITE_TIMEOUT_MS,
      });
      this.inFlight += 1;
      return pending.then(
        () => undefined,
        (err: unknown) => { this.warn('[McpActionLog] write failed:', err); },
      ).finally(() => { this.inFlight -= 1; });
    } catch (err) {
      this.warn('[McpActionLog] write failed:', err);
      return Promise.resolve();
    }
  }

  /** Writes outstanding now, and rows dropped since start — for tests and diagnostics. */
  stats(): { inFlight: number; dropped: number } {
    return { inFlight: this.inFlight, dropped: this.droppedCount };
  }

  private warn(context: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    logCaughtWarning(context, err);
  }
}

export const mcpActionLog = new McpActionLog();
