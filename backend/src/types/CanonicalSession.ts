export type CanonicalHarness = 'hermes' | 'openclaw' | 'unknown';
export type IdentityAuthority = 'source_authoritative' | 'source_reported' | 'derived' | 'legacy';
export type IdentityConfidence = 'authoritative' | 'correlated' | 'ambiguous' | 'quarantined';

export interface CanonicalAliasInput {
  source: string;
  sourceInstance: string;
  kind: string;
  value: string;
  normalizationVersion?: number;
  authority: IdentityAuthority;
  evidenceRef: string;
  observedAt: Date;
}

export interface ResolveAttemptInput {
  harness: CanonicalHarness;
  runtimeKind: string;
  identityConfidence: IdentityConfidence;
  identityReason: string;
  adapter: string;
  adapterVersion: string;
  idempotencyKey: string;
  observedAt: Date;
  aliases: CanonicalAliasInput[];
}

export interface CanonicalAttempt {
  attempt_id: string;
  contract_version: string;
  schema_version: number;
  harness: CanonicalHarness;
  runtime_kind: string;
  first_observed_at: Date;
  identity_confidence: IdentityConfidence;
  identity_reason: string;
  created_by_adapter: string;
}

export interface CanonicalEventInput {
  attemptId: string;
  source: string;
  sourceInstance: string;
  streamGeneration: string;
  eventKind: 'message' | 'tool_call' | 'tool_result' | 'usage' | 'lifecycle' | 'control' | 'error' | 'other';
  sourceEventId?: string;
  sourceSequence?: number | string;
  sourceOccurredAt?: Date;
  payload: Record<string, unknown>;
  redactionPolicyVersion: string;
  correlationId?: string;
  parentEventId?: string;
  idempotencyKey: string;
}

export interface CanonicalEvent {
  event_id: string;
  attempt_id: string;
  event_kind: CanonicalEventInput['eventKind'];
  payload: Record<string, unknown>;
  payload_hash: string;
  idempotency_key: string;
  ingested_at: Date;
}

export interface EventInsertResult {
  event: CanonicalEvent;
  inserted: boolean;
}

export interface CanonicalIngestionGapInput {
  attemptId?: string;
  gapKind: string;
  expectedFrom: string;
  expectedTo: string;
}

export interface CanonicalIngestionBatchInput {
  source: string;
  sourceInstance: string;
  streamGeneration: string;
  /** Monotonic source position. Numeric text avoids JavaScript integer loss. */
  cursorPosition: string;
  /** Safe opaque cursor only; adapters must never put source payloads here. */
  cursorValue: string;
  sourceChecksum: string;
  events: CanonicalEventInput[];
  gaps?: CanonicalIngestionGapInput[];
}

export interface CanonicalIngestionBatchResult {
  insertedEvents: number;
  replayedEvents: number;
  cursorAdvanced: boolean;
  cursorRevision: number;
}

export type CanonicalAdapterHealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'unauthorized' | 'unknown';

export interface CanonicalAdapterHealthInput {
  source: string;
  sourceInstance: string;
  adapterVersion: string;
  status: CanonicalAdapterHealthStatus;
  reasonCode?: string;
  lastSourceAt?: Date;
  succeeded: boolean;
  checkedAt?: Date;
  /** Aggregate/non-secret diagnostics only. */
  safeDetails?: Record<string, number | boolean | null>;
}

export interface CanonicalAdapterHealth {
  source: string;
  source_instance: string;
  adapter_version: string;
  status: CanonicalAdapterHealthStatus;
  reason_code: string | null;
  last_source_at: Date | null;
  last_success_at: Date | null;
  last_error_at: Date | null;
  checked_at: Date;
  safe_details: Record<string, number | boolean | null>;
}

export type TaskAttemptRole = 'implementation' | 'review' | 'orchestration' | 'research' | 'monitor' | 'notification' | 'unknown';
export type TaskAttemptLinkState = 'claimed' | 'bound' | 'released' | 'superseded' | 'unresolved';
export type TaskAttemptLinkSource = 'task_spawn' | 'runtime_callback' | 'operator' | 'backfill' | 'legacy_field';
export type AttemptOwnershipAuthority = 'source_authoritative' | 'task_orchestrator' | 'derived' | 'legacy';
export type AttemptRelationship = 'spawned' | 'delegated' | 'resumed_from' | 'retried_from' | 'replaced' | 'observed_parent';

export interface LinkAttemptContextInput {
  taskId: string;
  subtaskIndex?: number;
  attemptId: string;
  role: TaskAttemptRole;
  attemptNumber: number;
  linkState: TaskAttemptLinkState;
  source: TaskAttemptLinkSource;
  evidenceRef: string;
  project?: {
    projectId: string;
    role: string;
    source: string;
    evidenceRef: string;
  };
  personality?: {
    personalityId: string;
    source: string;
    validFrom: Date;
    validTo?: Date;
    evidenceRef: string;
  };
  parent?: {
    attemptId: string;
    relationship: AttemptRelationship;
    authority: AttemptOwnershipAuthority;
    evidenceRef: string;
  };
}

export interface TaskAttemptHistoryRow {
  link_id: string;
  task_id: string;
  subtask_index: number | null;
  attempt_id: string;
  role: TaskAttemptRole;
  attempt_number: number;
  link_state: TaskAttemptLinkState;
  source: TaskAttemptLinkSource;
  evidence_ref: string;
  linked_at: Date;
  released_at: Date | null;
  release_reason: string | null;
  harness: CanonicalHarness;
  runtime_kind: string;
  first_observed_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  project_links: Array<Record<string, unknown>>;
  personality_links: Array<Record<string, unknown>>;
  parent_edges: Array<Record<string, unknown>>;
  child_edges: Array<Record<string, unknown>>;
}
