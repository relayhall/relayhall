/**
 * McpSessionTelemetry — MCP-DERIVED AGENT SESSIONS (card `35b73092`; owner
 * finding E76, pulled by E77, 10 Oct 2026).
 *
 * The Agent sessions page lists envelope rows (`session_events`, TW1a/TW1c).
 * A harness that drives the board through MCP all day — a claude.ai connector,
 * a local Codex launcher — never ran a reporter, so it never appeared there,
 * and a client-side reporter for the claude.ai connector would need a second
 * credential. This module closes that gap SERVER-SIDE, from the caller's own
 * MCP traffic, by writing ordinary Tier-0 envelopes and C7 frames through the
 * SAME write paths the reporters use. The session itself adds no table, no
 * column, no route and no read surface; the action log below adds one table
 * (`mcp_action_log`, migration 161) and is read on the existing session point
 * route.
 *
 * ── WHAT IS RECORDED ──
 *
 *  - SESSION START. `relayhall_brief_compile {session: true}` is the bootstrap
 *    (`McpBootstrapService`). When it succeeds, one `kind: session`,
 *    `phase: started` envelope is stored for the new bootstrap EPOCH.
 *  - HEARTBEAT. Every other `tools/call` made inside a live epoch stores one
 *    `kind: session`, `phase: running` envelope keyed on the identity arm
 *    `(stream_generation = mcp.<sessionRef>, source_sequence = floor(now / N))`.
 *    The migration-055 UNIQUE `session_events.idempotency_key` turns every
 *    further call inside the same N-second bucket into a duplicate that stores
 *    nothing — so the bound is the database constraint, atomically and
 *    deployment-wide, with no limiter row, no module state and no migration.
 *  - SESSION END. When the same credential bootstraps again (a refresh inside
 *    the twelve-hour TTL, or after it lapsed), one `phase: completed` envelope
 *    is stored for the PREVIOUS epoch, which the shipped derivation renders
 *    `finished`. An epoch that lapsed is also ended the next time its
 *    credential touches the surface at all (an introspection call is still
 *    answered after a lapse).
 *  - TASK LINK. A C7 status frame with `task_id` — the existing Task-to-
 *    telemetry linkage the Task chip reads (`TelemetryService.livenessForTask`)
 *    — written under the CALLER's principal. Which Tasks MAY be linked is
 *    derived from authoritative board state every time: the Tasks the caller
 *    holds as Assignee with status `in-progress`. Which ONE of them is linked
 *    is, in order: the Task this call names, then the link already shown (the
 *    caller's own most recently set `active` MCP link frame), then the most
 *    recently updated. The shown link is the only preference carried between
 *    calls, and the frame that set it carries it — so a taskId brief (or a
 *    claim, release, move or finish) naming a held Task moves the link there,
 *    and it STAYS there while that Task is held. Linking tools reconcile
 *    immediately; every new heartbeat bucket reconciles too. A link that no
 *    longer holds is cleared with ONE `idle` frame for that Task. A clear or
 *    a set the shared five-second frame gate refuses is retried at the next
 *    reconcile, because both follow from state; a SWITCH between two held
 *    Tasks that the gate refuses is not, because only its frame would have
 *    remembered it.
 *
 * ── WHAT IS NOT ──
 *
 *  - No identity from a tool argument. The owner of every row is the caller:
 *    `connector_id`, `account_id` and `agent_id` come from
 *    `TelemetryPrincipalService.derive` over THIS credential's authenticated
 *    chain (reused unmodified — a third derivation is a REJECT by ruling
 *    `4ae7ce53`), and the frame owner is the acting principal itself. Nothing
 *    here reads a principal, an owner or a Connector out of `args`.
 *  - No consent widening. `derive` refuses a Connector whose current
 *    descriptor declares telemetry tier `none` or none at all (D3), an
 *    Account-plane credential, a direct Account -> Agent chain and a legacy
 *    parentless Connector. A refused caller produces NOTHING — no row, no
 *    audit write (the audited refusal belongs to the ingest route, where a
 *    reporter ASKED to write; here nobody asked).
 *  - No side effect outside the telemetry tables. Writes go only through
 *    `TelemetryEnvelopeStore.store` (session_events + telemetry_raw_blobs)
 *    and `TelemetryService.ingest` (telemetry_frames + telemetry_rate_limits),
 *    plus the action log's `McpActionLog.enqueue` (mcp_action_log);
 *    the two reads of board state are SELECTs. No Task write, no lease
 *    renewal, no feed event, no audit row.
 *  - No effect on the tool. The observer never throws, never changes a tool
 *    result, holds no transaction or lock across the tool, and logs only a
 *    secret-free warning to stderr (the stdio entry's stdout stays the
 *    protocol stream).
 *
 * ── THE ACTION LOG (card `ab8f78e9`, owner ruling E91) ──
 *
 * When `tools/call` hands `settle` the call's outcome, the call is also
 * recorded in the session's ACTION LOG (`McpActionLog`, table
 * `mcp_action_log`): tool, allowlisted target, ok/error with a closed code,
 * duration and time, under the SAME session reference and owner the session's
 * envelope rows carry. Only a call made inside a LIVE epoch is recorded — a
 * call after a lapse belongs to no session. The row is handed to a bounded
 * fire-and-forget writer, so it adds no wait to the tool; the target is read
 * here from the per-tool allowlisted argument and nothing else of `args`
 * leaves this module.
 *
 * ── THE PRODUCT KEY ──
 *
 * Rows carry `source.product = 'mcp'`, a fixed key the SERVER writes. The
 * descriptor's product allowlist (§5.2 / TS-3) bounds what a REPORTER may
 * assert at `POST /telemetry/events`; it is not consulted here, because no
 * reporter is asserting anything. The tier check above is consulted, so a
 * Connector that never consented to telemetry is never shown.
 */
import type { DelegationActorLink } from './AuthorizationService';
import { pool as defaultPool } from '../db/connection';
import { readBootstrapEpoch, type BootstrapEpoch } from './McpBootstrapService';
import { telemetryPrincipalService } from './TelemetryPrincipalService';
import { telemetryEnvelopeStore } from './TelemetryEnvelopeStore';
import {
  telemetryService, TELEMETRY_STALE_MS, TELEMETRY_MIN_FRAME_INTERVAL_MS,
  type TelemetryFrameInput, type TelemetryIngestOutcome,
} from './TelemetryService';
import type { TelemetryPrincipalResult, TelemetryPrincipalInput } from './TelemetryPrincipalService';
import type { TelemetryEnvelopeStoreOutcome, TelemetryEnvelopeStoreOptions } from './TelemetryEnvelopeStore';
import type { TelemetryPrincipalBinding } from '../types/TelemetryEnvelope';
import { telemetrySessionReference } from '../utils/telemetryPepper';
import { isValidTaskId } from '../utils/taskIds';
import { logCaughtWarning } from '../utils/secretSafeLog';
import { VERSION_RE } from '../utils/telemetryEnvelopeValidator';
import { RELAYHALL_VERSION } from '../version';
import {
  buildMcpActionRow, mcpActionLog, mcpActionTarget,
  type McpActionErrorCode, type McpActionRow,
} from './McpActionLog';

/** The fixed, server-written product key every MCP-derived row carries. */
export const MCP_SESSION_SOURCE_PRODUCT = 'mcp';
/** The adapter label the coverage view shows for MCP-derived rows. */
export const MCP_SESSION_ADAPTER = 'relayhall-mcp';

/**
 * The board version an MCP-derived record states as `source.adapter_version`:
 * the version the board reports, verbatim, when the ingest grammar
 * (`VERSION_RE`) admits it, else nothing — the field is optional, so it is
 * left out.
 *
 * Why (train integration with card `6d549392`, truthful build identity):
 * `RELAYHALL_VERSION` is the release version the image recorded, else
 * `<package>+unreleased`, and is SemVer with build metadata. The grammar takes
 * ONE suffix, so `1.0.0-beta.1+unreleased` - or a release carrying both a
 * prerelease and build metadata - is refused at validation, and the whole
 * record with it: no MCP session would be recorded on such a build. The
 * grammar is not widened and the version is never rewritten (a bare package
 * version must not pass for a release); a version the grammar cannot carry is
 * simply not stated.
 */
export function mcpAdapterVersion(reported: string): string | undefined {
  return VERSION_RE.test(reported) ? reported : undefined;
}
const MCP_SESSION_ADAPTER_VERSION = mcpAdapterVersion(RELAYHALL_VERSION);
/** Marker on MCP-derived link frames, so reconciliation reads only its own. */
export const MCP_LINK_FRAME_ORIGIN = 'mcp';

/**
 * THE HEARTBEAT CADENCE: at most one stored heartbeat per session per bucket
 * of this many milliseconds.
 *
 * No reporter cadence is documented, so the number is chosen against the
 * windows that ARE shipped, each imported rather than copied:
 *
 *  - a session calling continuously never derives `stale`. Buckets are fixed,
 *    so the worst gap between two stored heartbeats is just under 2N = 120 s,
 *    against the 540 s `TELEMETRY_STALE_MS` window — asserted, not assumed;
 *  - it sits above the five-second per-principal frame gate
 *    (`TELEMETRY_MIN_FRAME_INTERVAL_MS`) the link frames share — asserted;
 *  - it is three page polls (`TELEMETRY_POLL_MS`, 20 s), so "Last seen" lags
 *    real activity by at most one minute;
 *  - it caps volume at 1,440 heartbeat rows per day for a session that never
 *    stops, under the 90-day envelope retention.
 *
 * Bucketed, not sliding: two heartbeats can land seconds apart across a
 * bucket edge, never two inside one bucket.
 */
export const MCP_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * The two inequalities the cadence is chosen against, as a value the unit
 * suite asserts — computed from the IMPORTED windows, so a change to either
 * shipped constant that breaks the choice turns the suite red.
 */
export function mcpHeartbeatCadenceHolds(intervalMs: number = MCP_HEARTBEAT_INTERVAL_MS): boolean {
  return 2 * intervalMs < TELEMETRY_STALE_MS && intervalMs >= TELEMETRY_MIN_FRAME_INTERVAL_MS;
}

/** The bootstrap verb and the argument that selects its session altitude. */
const BOOTSTRAP_TOOL = 'relayhall_brief_compile';

/**
 * Tools whose success can change which Task the caller is working, and the
 * argument that names that Task. They reconcile the link immediately; every
 * other tool waits for the next heartbeat bucket. A brief only counts at the
 * Task altitude (`taskId`).
 */
export const MCP_LINK_TRIGGER_TOOLS: Readonly<Record<string, 'task' | 'taskId'>> = Object.freeze({
  relayhall_brief_compile: 'taskId',
  relayhall_task_claim: 'task',
  relayhall_task_release: 'task',
  relayhall_task_move: 'task',
  relayhall_task_finish: 'task',
  relayhall_lease_claim: 'task',
  relayhall_lease_release: 'task',
});

/** The caller as the MCP surface resolved it (`mcp/bootstrapGate.resolveMcpCaller`). */
export interface McpSessionCaller {
  credentialId: string;
  principalId: string | null;
  delegationLinks: DelegationActorLink[] | null;
}

/**
 * What `tools/call` measured about one call, for the action log (card
 * `ab8f78e9`). Closed values only: no argument, message or result rides here.
 */
export interface McpCallOutcome {
  /** `null` when the handler succeeded; otherwise the closed code of its failure. */
  errorCode: McpActionErrorCode | null;
  /** The handler's duration in milliseconds. */
  durationMs: number;
}

/** The handle `tools/call` holds across one tool execution. */
export interface McpCallObservation {
  /**
   * Record the call. Never throws, never changes the tool's result. With an
   * `outcome`, the call is also queued for the session's action log.
   */
  settle(succeeded: boolean, outcome?: McpCallOutcome): Promise<void>;
}

interface Bound {
  caller: McpSessionCaller & { principalId: string };
  binding: TelemetryPrincipalBinding;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface McpSessionTelemetryDeps {
  pool: Queryable;
  derive: (input: TelemetryPrincipalInput) => Promise<TelemetryPrincipalResult>;
  store: (binding: TelemetryPrincipalBinding, input: unknown, options: TelemetryEnvelopeStoreOptions)
    => Promise<TelemetryEnvelopeStoreOutcome>;
  frame: (principalId: string, frame: TelemetryFrameInput) => Promise<TelemetryIngestOutcome>;
  epoch: (credentialId: string) => Promise<BootstrapEpoch | null>;
  clock: () => Date;
  /** Queue one action-log row. Synchronous and fire-and-forget (`McpActionLog.enqueue`). */
  action: (row: McpActionRow | null) => void;
}

const productionDeps = (): McpSessionTelemetryDeps => ({
  pool: defaultPool as unknown as Queryable,
  derive: (input) => telemetryPrincipalService.derive(input),
  store: (binding, input, options) => telemetryEnvelopeStore.store(binding, input, options),
  frame: (principalId, frame) => telemetryService.ingest(principalId, frame),
  epoch: (credentialId) => readBootstrapEpoch(credentialId),
  clock: () => new Date(),
  action: (row) => { void mcpActionLog.enqueue(row); },
});

/** The session seed: the credential plus the epoch it bootstrapped. Never stored raw. */
export function mcpSessionSeed(credentialId: string, epoch: Pick<BootstrapEpoch, 'bootstrappedAt'>): string {
  return `${credentialId}:${epoch.bootstrappedAt.getTime()}`;
}

/** The heartbeat bucket a moment falls in. */
export function mcpHeartbeatBucket(now: Date): number {
  return Math.floor(now.getTime() / MCP_HEARTBEAT_INTERVAL_MS);
}

type Phase = 'started' | 'running' | 'completed';

/**
 * One `rh.ai.telemetry/1.0` record, built from server-known values only.
 *
 * The seed rides `correlation.conversation_id`, which the Tier-0 engine
 * pseudonymizes into `session_ref` and never stores raw. The identity fields
 * reuse the PSEUDONYM (`sessionRef`), so no credential id lands anywhere.
 */
export function mcpSessionEnvelope(
  seed: string,
  sessionRef: string,
  phase: Phase,
  now: Date,
): Record<string, unknown> {
  const identity = phase === 'running'
    ? { stream_generation: `mcp.${sessionRef}`, source_sequence: mcpHeartbeatBucket(now) }
    : { event_id: `mcp.${phase === 'started' ? 'start' : 'end'}.${sessionRef}` };
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    ...identity,
    occurred_at: now.toISOString(),
    kind: 'session',
    phase,
    source: {
      product: MCP_SESSION_SOURCE_PRODUCT,
      adapter: MCP_SESSION_ADAPTER,
      ...(MCP_SESSION_ADAPTER_VERSION === undefined ? {} : { adapter_version: MCP_SESSION_ADAPTER_VERSION }),
    },
    correlation: { conversation_id: seed },
  };
}

/** The Task a linking tool names, when it names a well-formed one. */
export function linkTriggerTask(toolName: string, args: Record<string, unknown>): string | null | undefined {
  const field = MCP_LINK_TRIGGER_TOOLS[toolName];
  if (!field) return undefined;
  const value = args[field];
  return typeof value === 'string' && isValidTaskId(value) ? value : null;
}

const WARN_INTERVAL_MS = 60_000;

export class McpSessionTelemetry {
  private deps: McpSessionTelemetryDeps;
  private lastWarnAt = 0;

  constructor(deps: Partial<McpSessionTelemetryDeps> = {}) {
    this.deps = { ...productionDeps(), ...deps };
  }

  /**
   * Test seam: drive the observer's clock. The heartbeat bucket, `observed_at`
   * and `occurred_at` all read it, so a suite can move a session through its
   * states without sleeping. `null` restores the wall clock.
   */
  setClockForTests(clock: (() => Date) | null): void {
    this.deps = { ...this.deps, clock: clock ?? (() => new Date()) };
  }

  /**
   * Begin observing one `tools/call`. Called after the bootstrap gate admitted
   * the call and before the handler runs; the returned handle is settled once,
   * after the handler, whatever it did.
   *
   * Only the bootstrap verb's session altitude does anything here: the epoch
   * the credential held BEFORE the handler replaces it is read now, because
   * afterwards it is gone. Everything else is deferred to `settle`.
   */
  async observe(
    toolName: string,
    args: Record<string, unknown>,
    resolveCaller: () => Promise<McpSessionCaller | null>,
  ): Promise<McpCallObservation> {
    const isBootstrap = toolName === BOOTSTRAP_TOOL && args.session === true;
    let bound: Bound | null | undefined;
    let prior: BootstrapEpoch | null = null;
    if (isBootstrap) {
      try {
        bound = await this.bind(resolveCaller);
        if (bound) prior = await this.deps.epoch(bound.caller.credentialId);
      } catch (err) {
        this.warn('[McpSessionTelemetry] pre-bootstrap read failed:', err);
        bound = null;
      }
    }
    return {
      settle: async (succeeded: boolean, outcome?: McpCallOutcome): Promise<void> => {
        try {
          const subject = bound === undefined ? await this.bind(resolveCaller) : bound;
          if (!subject) return;
          const session = await this.record(subject, toolName, args, isBootstrap, prior, succeeded);
          if (session && outcome) this.logAction(subject, session, toolName, args, outcome);
        } catch (err) {
          this.warn('[McpSessionTelemetry] observation failed:', err);
        }
      },
    };
  }

  /**
   * The caller and its derived binding, or null when nothing may be written.
   *
   * A chain of fewer than two links cannot carry an Account distinct from the
   * acting principal, and `derive` refuses EVERY such chain (no Account, or no
   * Connector). Asking it anyway would cost the registry round trips on every
   * call from an Account-plane credential to reach an answer that cannot
   * differ, so that one shape is skipped here; the decision on every other
   * shape is `derive`'s alone.
   */
  private async bind(resolveCaller: () => Promise<McpSessionCaller | null>): Promise<Bound | null> {
    const caller = await resolveCaller();
    if (!caller || !caller.principalId) return null;
    const links = caller.delegationLinks ?? [];
    if (links.length < 2) return null;
    const derived = await this.deps.derive({ actingPrincipalId: caller.principalId, delegationLinks: links });
    if (!derived.ok) return null;
    return { caller: { ...caller, principalId: caller.principalId }, binding: derived.binding };
  }

  /**
   * Record the session side of one call. Returns the LIVE epoch the call was
   * made in — the session its action-log row belongs to — or null when there
   * is none (no bootstrap, or a lapsed one).
   */
  private async record(
    subject: Bound,
    toolName: string,
    args: Record<string, unknown>,
    isBootstrap: boolean,
    prior: BootstrapEpoch | null,
    succeeded: boolean,
  ): Promise<BootstrapEpoch | null> {
    const epoch = await this.deps.epoch(subject.caller.credentialId);
    if (!epoch) return null;
    const now = this.deps.clock();

    if (!epoch.live) {
      // The epoch lapsed: the session it carried has ended. Idempotent — the
      // end event's id is fixed per epoch, so a second contact stores nothing.
      await this.write(subject, epoch, 'completed', now);
      return null;
    }

    if (isBootstrap && succeeded) {
      if (prior && prior.bootstrappedAt.getTime() !== epoch.bootstrappedAt.getTime()) {
        await this.write(subject, prior, 'completed', now);
      }
      await this.write(subject, epoch, 'started', now);
      await this.reconcileLink(subject.caller.principalId, null, true);
      return epoch;
    }

    const stored = await this.write(subject, epoch, 'running', now);
    const newBucket = stored.accepted && !stored.duplicate;
    const trigger = succeeded ? linkTriggerTask(toolName, args) : undefined;
    if (newBucket || trigger !== undefined) {
      await this.reconcileLink(subject.caller.principalId, trigger ?? null, newBucket);
    }
    return epoch;
  }

  /**
   * Queue the call's action-log row under the session it was made in (card
   * `ab8f78e9`). The row is built from server-known values, the target read
   * from the per-tool allowlisted argument, and the closed outcome — no other
   * part of `args` is read. Queuing is synchronous and never awaited.
   */
  private logAction(
    subject: Bound,
    epoch: Pick<BootstrapEpoch, 'bootstrappedAt'>,
    toolName: string,
    args: Record<string, unknown>,
    outcome: McpCallOutcome,
  ): void {
    const sessionRef = telemetrySessionReference(
      MCP_SESSION_SOURCE_PRODUCT, { conversation_id: mcpSessionSeed(subject.caller.credentialId, epoch) });
    if (!sessionRef) return;
    this.deps.action(buildMcpActionRow({
      sessionRef,
      connectorId: subject.binding.connectorId,
      accountId: subject.binding.accountId,
      agentId: subject.binding.agentId,
      toolName,
      target: mcpActionTarget(toolName, args),
      errorCode: outcome.errorCode,
      durationMs: outcome.durationMs,
      observedAt: this.deps.clock(),
    }));
  }

  private async write(
    subject: Bound, epoch: Pick<BootstrapEpoch, 'bootstrappedAt'>, phase: Phase, now: Date,
  ): Promise<{ accepted: boolean; duplicate: boolean }> {
    const seed = mcpSessionSeed(subject.caller.credentialId, epoch);
    const sessionRef = telemetrySessionReference(MCP_SESSION_SOURCE_PRODUCT, { conversation_id: seed });
    if (!sessionRef) return { accepted: false, duplicate: false };
    const outcome = await this.deps.store(
      subject.binding, mcpSessionEnvelope(seed, sessionRef, phase, now), { observedAt: now });
    if (!outcome.accepted) {
      // A record built from server-known values that the store refuses is a
      // defect here, not traffic to drop silently.
      this.warn('[McpSessionTelemetry] envelope refused:', new Error(`${outcome.stage}:${outcome.code}`));
      return { accepted: false, duplicate: false };
    }
    return { accepted: true, duplicate: outcome.duplicate };
  }

  /**
   * Make the caller's Task link agree with the board.
   *
   * HELD: the Tasks the caller holds as Assignee with status `in-progress`,
   * newest `updated_at` first. SHOWN: every Task whose newest MCP-origin link
   * frame from this principal is `active`, most recently set first; the first
   * of them is the CURRENT link. DESIRED: the Task this call names if it is
   * held, else the current link if it is still held, else the newest held.
   *
   * The frame gate admits one frame per interval, so each reconcile writes at
   * most one, in this order:
   *
   *  1. a shown Task the caller no longer holds is cleared with an `idle`
   *     frame — truthfulness first;
   *  2. a desired Task that is not shown is set with an `active` frame. When
   *     another held Task is still shown this is a SWITCH: the new link is set
   *     before the old one is cleared, so the new frame becomes the current
   *     link and the next reconcile keeps it instead of falling back to
   *     `updated_at` (a taskId brief does not touch `updated_at`);
   *  3. a shown Task that is held but not desired is cleared with `idle` — the
   *     second half of a switch;
   *  4. on a new heartbeat bucket the desired link is refreshed, so the chip
   *     stays fresh while the session works.
   */
  private async reconcileLink(principalId: string, namedTaskId: string | null, refresh: boolean): Promise<void> {
    const shownResult = await this.deps.pool.query(
      `SELECT task_id
         FROM (
           SELECT DISTINCT ON (task_id) task_id, status, received_at, id
             FROM telemetry_frames
            WHERE principal_id = $1
              AND task_id IS NOT NULL
              AND kind = 'status'
              AND payload->>'origin' = $2
            ORDER BY task_id, received_at DESC, id DESC
         ) newest
        WHERE status = 'active'
        ORDER BY received_at DESC, id DESC`,
      [principalId, MCP_LINK_FRAME_ORIGIN],
    );
    const shown = shownResult.rows.map((row) => String(row.task_id));

    const heldResult = await this.deps.pool.query(
      `SELECT t.id
         FROM task_assignments a
         JOIN tasks t ON t.id = a.task_id
        WHERE a.claimant_principal_id = $1
          AND t.status = 'in-progress'
        ORDER BY t.updated_at DESC, t.id ASC`,
      [principalId],
    );
    const held = heldResult.rows.map((row) => String(row.id));
    const isHeld = (taskId: string | null): taskId is string => taskId !== null && held.includes(taskId);

    const current = shown[0] ?? null;
    const desired = isHeld(namedTaskId) ? namedTaskId : isHeld(current) ? current : (held[0] ?? null);

    const released = shown.find((taskId) => !isHeld(taskId));
    if (released) {
      await this.frame(principalId, released, 'idle');
      return;
    }
    if (desired && !shown.includes(desired)) {
      await this.frame(principalId, desired, 'active');
      return;
    }
    const superseded = shown.find((taskId) => taskId !== desired);
    if (superseded) {
      await this.frame(principalId, superseded, 'idle');
      return;
    }
    if (desired && refresh) {
      await this.frame(principalId, desired, 'active');
    }
  }

  private async frame(principalId: string, taskId: string, status: 'active' | 'idle'): Promise<void> {
    // RATE_LIMITED and TASK_NOT_FOUND are outcomes, not failures: the next
    // reconcile recomputes the same decision from the same state.
    await this.deps.frame(principalId, {
      kind: 'status', status, taskId, payload: { origin: MCP_LINK_FRAME_ORIGIN },
    });
  }

  private warn(context: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    logCaughtWarning(context, err);
  }
}

export const mcpSessionTelemetry = new McpSessionTelemetry();
