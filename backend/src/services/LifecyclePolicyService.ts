import { Pool } from 'pg';
import { databasePoolConfig } from '../db/connection';
import { logCaughtFailure } from '../utils/secretSafeLog';

export const LIFECYCLE_POLICY_MODES = ['off', 'observe', 'enforce'] as const;
export type LifecyclePolicyMode = (typeof LIFECYCLE_POLICY_MODES)[number];

export const LIFECYCLE_POLICY_DECISIONS = ['allow', 'warn', 'deny'] as const;
export type LifecyclePolicyDecision = (typeof LIFECYCLE_POLICY_DECISIONS)[number];

export interface LifecyclePolicySubject {
  kind: string;
  id: string;
  revision?: string | null;
}

export interface LifecyclePolicyException {
  id: string;
  owner: string;
  expiresAt: string;
  controlIds: string[];
}

export interface LifecyclePolicyInput {
  action: string;
  subject: LifecyclePolicySubject;
  current?: unknown;
  proposed?: unknown;
  environment: string;
  mode: LifecyclePolicyMode;
  policyId: string;
  policyVersion: string;
  exception?: LifecyclePolicyException;
}

export interface LifecyclePolicyResult {
  decision: LifecyclePolicyDecision;
  controlIds: string[];
  reasonIds: string[];
  remediation?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface LifecyclePolicyEvaluator {
  readonly id: string;
  readonly version: string;
  evaluate(input: Readonly<LifecyclePolicyInput>): Promise<LifecyclePolicyResult> | LifecyclePolicyResult;
}

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface LifecyclePolicyDecisionRecord {
  action: string;
  subjectKind: string;
  subjectId: string;
  subjectRevision: string | null;
  environment: string;
  mode: LifecyclePolicyMode;
  decision: LifecyclePolicyDecision;
  effectiveDecision: 'allow' | 'deny';
  evaluatorId: string;
  evaluatorVersion: string;
  policyId: string;
  policyVersion: string;
  controlIds: string[];
  reasonIds: string[];
  remediation: string | null;
  exceptionId: string | null;
  exceptionOwner: string | null;
  exceptionExpiresAt: string | null;
  exceptionDisposition: 'none' | 'applied' | 'expired' | 'invalid';
  metadata: Record<string, string | number | boolean | null>;
}

export interface LifecyclePolicyDecisionStore {
  record(queryable: Queryable, decision: LifecyclePolicyDecisionRecord): Promise<void>;
  recordIndependent(decision: LifecyclePolicyDecisionRecord): Promise<void>;
}

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIST_ITEMS = 32;
const MAX_TEXT = 1000;
const DEFAULT_TIMEOUT_MS = 100;
const PUBLIC_DENIAL_REMEDIATION = 'Contact an administrator with the control and reason identifiers';

function boundedIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 128 || !IDENTIFIER.test(value)) {
    throw new LifecyclePolicyConfigurationError(`${field} is not a bounded policy identifier`);
  }
  return value;
}

function boundedVersion(value: unknown, field: string): string {
  if (typeof value !== 'string' || !VERSION.test(value)) {
    throw new LifecyclePolicyConfigurationError(`${field} is not a bounded version`);
  }
  return value;
}

function boundedList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new LifecyclePolicyEvaluationError(`${field} must be a bounded list`);
  }
  const normalized = value.map((item) => boundedIdentifier(item, field));
  return [...new Set(normalized)].sort();
}

function boundedMetadata(value: unknown): Record<string, string | number | boolean | null> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LifecyclePolicyEvaluationError('metadata must be a flat object');
  }
  const entries = Object.entries(value);
  if (entries.length > 16) throw new LifecyclePolicyEvaluationError('metadata has too many fields');
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of entries) {
    boundedIdentifier(key, 'metadata key');
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new LifecyclePolicyEvaluationError('metadata values must be scalar');
    }
    if (typeof item === 'string' && item.length > 256) {
      throw new LifecyclePolicyEvaluationError('metadata string is too long');
    }
    result[key] = item;
  }
  if (JSON.stringify(result).length > 4096) {
    throw new LifecyclePolicyEvaluationError('metadata is too large');
  }
  return result;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    const object = value as object;
    if (!seen.has(object)) {
      seen.add(object);
      for (const child of Object.values(object)) deepFreeze(child, seen);
      Object.freeze(object);
    }
  }
  return value;
}

function safeClone<T>(value: T): T {
  if (value === undefined) return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 65536) {
      throw new LifecyclePolicyConfigurationError('policy input exceeds 64 KiB');
    }
    return JSON.parse(serialized) as T;
  } catch (error) {
    if (error instanceof LifecyclePolicyConfigurationError) throw error;
    throw new LifecyclePolicyConfigurationError('policy input must be JSON serializable');
  }
}

export class LifecyclePolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecyclePolicyConfigurationError';
  }
}

export class LifecyclePolicyEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecyclePolicyEvaluationError';
  }
}

export class LifecyclePolicyDeniedError extends Error {
  readonly status = 409;
  readonly code = 'LIFECYCLE_POLICY_DENIED';

  constructor(
    public readonly action: string,
    public readonly subject: LifecyclePolicySubject,
    public readonly controlIds: string[],
    public readonly reasonIds: string[],
    public readonly remediation: string | null,
  ) {
    super('The lifecycle policy denied this operation');
    this.name = 'LifecyclePolicyDeniedError';
  }
}

/** House-envelope fields only; never expose evaluator-authored free text, metadata or input. */
export function lifecyclePolicyDenialEnvelope(error: unknown): {
  status: number;
  code: string;
  message: string;
  details: { action: string; subjectKind: string; controlIds: string[]; reasonIds: string[]; remediation: string | null };
} | null {
  if (!(error instanceof LifecyclePolicyDeniedError)) return null;
  return {
    status: error.status,
    code: error.code,
    message: error.message,
    details: {
      action: error.action,
      subjectKind: error.subject.kind,
      controlIds: error.controlIds,
      reasonIds: error.reasonIds,
      remediation: PUBLIC_DENIAL_REMEDIATION,
    },
  };
}

export class AllowAllLifecyclePolicyEvaluator implements LifecyclePolicyEvaluator {
  readonly id = 'relayhall.noop';
  readonly version = '1';

  evaluate(): LifecyclePolicyResult {
    return { decision: 'allow', controlIds: [], reasonIds: [] };
  }
}

export class AdvisoryLifecyclePolicyEvaluator implements LifecyclePolicyEvaluator {
  readonly id = 'relayhall.advisory-fixture';
  readonly version = '1';

  evaluate(input: Readonly<LifecyclePolicyInput>): LifecyclePolicyResult {
    return {
      decision: 'warn',
      controlIds: ['fixture.lifecycle-review'],
      reasonIds: ['fixture.advisory-only'],
      remediation: `Review ${input.action} before enabling an installed policy package`,
    };
  }
}

export class PostgresLifecyclePolicyDecisionStore implements LifecyclePolicyDecisionStore {
  private readonly independentPool: Pool;

  constructor(independentPool?: Pool) {
    this.independentPool = independentPool ?? new Pool({ ...databasePoolConfig, max: 2 });
    this.independentPool.on('error', (error) => {
      logCaughtFailure('[LifecyclePolicy] independent evidence pool failure', error);
    });
  }

  async record(queryable: Queryable, decision: LifecyclePolicyDecisionRecord): Promise<void> {
    await queryable.query(
      `INSERT INTO lifecycle_policy_decisions
         (action, subject_kind, subject_id, subject_revision, environment, mode,
          decision, effective_decision, evaluator_id, evaluator_version,
          policy_id, policy_version, control_ids, reason_ids, remediation,
          exception_id, exception_owner, exception_expires_at,
          exception_disposition, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb)`,
      [
        decision.action,
        decision.subjectKind,
        decision.subjectId,
        decision.subjectRevision,
        decision.environment,
        decision.mode,
        decision.decision,
        decision.effectiveDecision,
        decision.evaluatorId,
        decision.evaluatorVersion,
        decision.policyId,
        decision.policyVersion,
        decision.controlIds,
        decision.reasonIds,
        decision.remediation,
        decision.exceptionId,
        decision.exceptionOwner,
        decision.exceptionExpiresAt,
        decision.exceptionDisposition,
        JSON.stringify(decision.metadata),
      ],
    );
  }

  async recordIndependent(decision: LifecyclePolicyDecisionRecord): Promise<void> {
    await this.record(this.independentPool, decision);
  }
}

export interface LifecyclePolicyServiceOptions {
  mode?: LifecyclePolicyMode;
  environment?: string;
  policyId?: string;
  policyVersion?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export class LifecyclePolicyService {
  private readonly mode: LifecyclePolicyMode;
  private readonly environment: string;
  private readonly policyId: string;
  private readonly policyVersion: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly evaluator: LifecyclePolicyEvaluator = new AllowAllLifecyclePolicyEvaluator(),
    private readonly store: LifecyclePolicyDecisionStore = new PostgresLifecyclePolicyDecisionStore(),
    options: LifecyclePolicyServiceOptions = {},
  ) {
    const mode = options.mode ?? 'off';
    if (!(LIFECYCLE_POLICY_MODES as readonly string[]).includes(mode)) {
      throw new LifecyclePolicyConfigurationError('mode must be off, observe, or enforce');
    }
    this.mode = mode;
    this.environment = boundedIdentifier(options.environment ?? 'unknown', 'environment');
    this.policyId = boundedIdentifier(options.policyId ?? 'relayhall.contract-only', 'policyId');
    this.policyVersion = boundedVersion(options.policyVersion ?? '1', 'policyVersion');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 5000) {
      throw new LifecyclePolicyConfigurationError('timeoutMs must be an integer from 1 to 5000');
    }
    this.now = options.now ?? (() => new Date());
    boundedIdentifier(this.evaluator.id, 'evaluator id');
    boundedVersion(this.evaluator.version, 'evaluator version');
  }

  async evaluate(
    queryable: Queryable,
    input: Omit<LifecyclePolicyInput, 'environment' | 'mode' | 'policyId' | 'policyVersion'>,
  ): Promise<void> {
    if (this.mode === 'off') return;
    const normalized = this.normalizeInput(input);
    let validated: ReturnType<LifecyclePolicyService['normalizeResult']>;
    try {
      validated = this.normalizeResult(await this.evaluateBounded(normalized));
    } catch (error) {
      validated = this.normalizeResult({
        decision: 'deny',
        controlIds: ['relayhall.evaluator-health'],
        reasonIds: [error instanceof LifecyclePolicyEvaluationError ? 'evaluator.malformed' : 'evaluator.timeout-or-failure'],
        remediation: 'Repair or disable the installed lifecycle-policy evaluator package',
      });
    }

    const exception = this.classifyException(normalized.exception, validated.decision, validated.controlIds);
    const enforcedDeny = this.mode === 'enforce' && validated.decision === 'deny' && exception.disposition !== 'applied';
    const record: LifecyclePolicyDecisionRecord = {
      action: normalized.action,
      subjectKind: normalized.subject.kind,
      subjectId: normalized.subject.id,
      subjectRevision: normalized.subject.revision ?? null,
      environment: normalized.environment,
      mode: normalized.mode,
      decision: validated.decision,
      effectiveDecision: enforcedDeny ? 'deny' : 'allow',
      evaluatorId: this.evaluator.id,
      evaluatorVersion: this.evaluator.version,
      policyId: normalized.policyId,
      policyVersion: normalized.policyVersion,
      controlIds: validated.controlIds,
      reasonIds: validated.reasonIds,
      remediation: validated.remediation ?? null,
      exceptionId: normalized.exception?.id ?? null,
      exceptionOwner: normalized.exception?.owner ?? null,
      exceptionExpiresAt: normalized.exception?.expiresAt ?? null,
      exceptionDisposition: exception.disposition,
      metadata: validated.metadata,
    };

    if (enforcedDeny) {
      await this.store.recordIndependent(record);
      throw new LifecyclePolicyDeniedError(
        normalized.action,
        normalized.subject,
        validated.controlIds,
        validated.reasonIds,
        validated.remediation ?? null,
      );
    }
    await this.store.record(queryable, record);
  }

  private normalizeInput(
    input: Omit<LifecyclePolicyInput, 'environment' | 'mode' | 'policyId' | 'policyVersion'>,
  ): Readonly<LifecyclePolicyInput> {
    const action = boundedIdentifier(input.action, 'action');
    const kind = boundedIdentifier(input.subject?.kind, 'subject kind');
    if (typeof input.subject?.id !== 'string' || input.subject.id.length < 1 || input.subject.id.length > 256) {
      throw new LifecyclePolicyConfigurationError('subject id is not bounded');
    }
    if (input.subject.revision !== undefined && input.subject.revision !== null &&
        (typeof input.subject.revision !== 'string' || input.subject.revision.length > 256)) {
      throw new LifecyclePolicyConfigurationError('subject revision is not bounded');
    }
    const normalized: LifecyclePolicyInput = {
      action,
      subject: {
        kind,
        id: input.subject.id,
        revision: input.subject.revision ?? null,
      },
      current: safeClone(input.current),
      proposed: safeClone(input.proposed),
      environment: this.environment,
      mode: this.mode,
      policyId: this.policyId,
      policyVersion: this.policyVersion,
      exception: input.exception ? this.normalizeException(input.exception) : undefined,
    };
    return deepFreeze(normalized);
  }

  private normalizeException(exception: LifecyclePolicyException): LifecyclePolicyException {
    if (!UUID.test(exception.id)) throw new LifecyclePolicyConfigurationError('exception id must be a UUID');
    if (typeof exception.owner !== 'string' || exception.owner.length < 1 || exception.owner.length > 256) {
      throw new LifecyclePolicyConfigurationError('exception owner is not bounded');
    }
    const expiresAt = new Date(exception.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) throw new LifecyclePolicyConfigurationError('exception expiry is invalid');
    return {
      id: exception.id,
      owner: exception.owner,
      expiresAt: expiresAt.toISOString(),
      controlIds: boundedList(exception.controlIds, 'exception controlIds'),
    };
  }

  private async evaluateBounded(input: Readonly<LifecyclePolicyInput>): Promise<LifecyclePolicyResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(this.evaluator.evaluate(input)),
        new Promise<LifecyclePolicyResult>((_, reject) => {
          timer = setTimeout(() => reject(new Error('lifecycle policy evaluator timeout')), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private normalizeResult(result: LifecyclePolicyResult): Required<Omit<LifecyclePolicyResult, 'remediation'>> & { remediation?: string } {
    if (result === null || typeof result !== 'object' ||
        !(LIFECYCLE_POLICY_DECISIONS as readonly string[]).includes(result.decision)) {
      throw new LifecyclePolicyEvaluationError('decision is invalid');
    }
    if (result.remediation !== undefined &&
        (typeof result.remediation !== 'string' || result.remediation.length > MAX_TEXT)) {
      throw new LifecyclePolicyEvaluationError('remediation is not bounded');
    }
    return {
      decision: result.decision,
      controlIds: boundedList(result.controlIds, 'controlIds'),
      reasonIds: boundedList(result.reasonIds, 'reasonIds'),
      remediation: result.remediation,
      metadata: boundedMetadata(result.metadata),
    };
  }

  private classifyException(
    exception: LifecyclePolicyException | undefined,
    decision: LifecyclePolicyDecision,
    controlIds: string[],
  ): { disposition: LifecyclePolicyDecisionRecord['exceptionDisposition'] } {
    if (!exception) return { disposition: 'none' };
    if (new Date(exception.expiresAt).getTime() <= this.now().getTime()) return { disposition: 'expired' };
    if (decision !== 'deny' || controlIds.length === 0 || controlIds.some((control) => !exception.controlIds.includes(control))) {
      return { disposition: 'invalid' };
    }
    return { disposition: 'applied' };
  }
}

function modeFromEnvironment(): LifecyclePolicyMode {
  const value = process.env.RELAYHALL_LIFECYCLE_POLICY_MODE ?? 'off';
  if (!(LIFECYCLE_POLICY_MODES as readonly string[]).includes(value)) {
    throw new LifecyclePolicyConfigurationError('RELAYHALL_LIFECYCLE_POLICY_MODE must be off, observe, or enforce');
  }
  return value as LifecyclePolicyMode;
}

export const lifecyclePolicyService = new LifecyclePolicyService(
  new AllowAllLifecyclePolicyEvaluator(),
  new PostgresLifecyclePolicyDecisionStore(),
  {
    mode: modeFromEnvironment(),
    environment: process.env.RELAYHALL_ENVIRONMENT ?? process.env.NODE_ENV ?? 'unknown',
    policyId: process.env.RELAYHALL_LIFECYCLE_POLICY_ID ?? 'relayhall.contract-only',
    policyVersion: process.env.RELAYHALL_LIFECYCLE_POLICY_VERSION ?? '1',
  },
);
