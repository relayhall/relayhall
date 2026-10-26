// KnowledgeWriteExecutor.ts — RB-11 Governor v0 (card `b796067e`), THE CORE
// DOOR for note writes (ratified design C.12, ruling E97; declared change D-8).
//
// ── WHAT THIS IS (answer E1) ──
//
// A door RELAY. The three verbs — propose, preview, commit — are relayed to
// the registered source's own write surface (its governor, C.2), and
// the source's answers come back unchanged. The core writes NO core object and
// STORES NO NOTE CONTENT: not the title, not a tag, not the body, not the
// rendered bytes the source returns. What the core keeps is the fail-closed
// audit row of C.15 — ids, enums and digests — and, for a keyed commit, the
// retry receipt, which is a sealed handle and a digest.
//
// ── THE ORDER IS THE CONTRACT (the get executor's shape) ──
//
//   caller input (C.16 bounds, sealed handles unsealed)   → 400, nothing else
//   task context (C.3), core-attested                     → uniform refusal
//   source + WRITE arm set (C.12)                         → uniform refusal
//   sign the write assertion (C.3; one jti per act)
//   INTENT audit row (C.15)  — FAIL CLOSED: no row → no dial
//   dial `${knowledge_write_endpoint}/${op}` under the §4.2 policy
//   field-complete validation of the source's answer
//   OUTCOME audit row — FAIL CLOSED
//   answer (commit: the ref is SEALED into a handle, never returned raw)
//
// The assertion is signed BEFORE the intent row is written so that the row
// carries the `jti` the source will record — the join key of C.15 exists before
// anything leaves the deployment. A signed assertion whose intent row then
// fails is discarded in-process; it never reaches the wire.
//
// ── REFUSALS ──
//
// About the caller's OWN input — sizes, shapes, handles — refusals are NAMED
// (`content_invalid`, the handle tokens, `revision_of_invalid`,
// `task_context_mismatch`): they disclose nothing about the estate. Every
// estate-dependent core-side outcome — the source does not exist, is not
// visible, is not selector-covered, the task is unreadable, the proposal is
// someone else's — is the ONE token `refused` (C.11: "the arms failing on the
// core side give one uniform `refused` without a reason"); the real reason is
// in the audit row only. `source_not_write_capable` is named only for a source
// every visibility arm already admits. The source's own refusals (C.11's
// closed code set) pass through with their status unchanged.
import crypto from 'crypto';
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { actorFromRequest } from '../middleware/sharedAuthorization';
import { authorizationRepository } from './AuthorizationRepository';
import { dialKnowledgeSource } from './KnowledgeDialClient';
import {
  evaluateKnowledgeWriteArms,
  type KnowledgeTaskContext,
  type KnowledgeWriteArmEvaluation,
  type KnowledgeWriteOp,
  type KnowledgeWriteSourceArmRow,
} from './KnowledgeArmEvaluator';
import { signKnowledgeWriteAssertion } from './KnowledgeAssertionSigner';
import { sealKnowledgeHandle, unsealKnowledgeHandle, KnowledgeHandleError } from './KnowledgeHandleSealer';
import { normalizeKnowledgeFilter, OPAQUE_COMPARTMENT_PATTERN } from './KnowledgeV2';
import { resolveChannelCredential, channelAuthDialOptions } from './KnowledgeChannelAuth';
import { newKnowledgeAuditRef } from './KnowledgeAuditService';
import {
  recordKnowledgeWriteAudit,
  readKnowledgeProposalBinding,
  refSha256,
  KnowledgeWriteAuditError,
  type KnowledgeWriteAuditRow,
} from './KnowledgeWriteAuditService';
import { logCaughtFailure } from '../utils/secretSafeLog';

// ───────────────────────────── C.16 limits ──────────────────────────────

export const KNOWLEDGE_WRITE_PROTOCOL_VERSION = 1;
/** Note body, UTF-8 bytes (C.2, C.16). */
export const KNOWLEDGE_NOTE_MAX_CONTENT_BYTES = 32 * 1024;
/** Title, in characters (code points). */
export const KNOWLEDGE_NOTE_MAX_TITLE_CHARS = 200;
export const KNOWLEDGE_NOTE_MAX_TAGS = 16;
export const KNOWLEDGE_NOTE_MAX_BASIS = 25;
/** The whole outbound request: the source's own body cap and its gateway's (C.16). */
export const KNOWLEDGE_WRITE_MAX_REQUEST_BYTES = 64 * 1024;
/**
 * Room left in that cap for the assertion, which is signed after the bound is
 * checked: an EdDSA compact JWS with these claims is well under 1 KiB.
 */
export const KNOWLEDGE_WRITE_ASSERTION_RESERVE_BYTES = 2 * 1024;
/** The source's answer: the rendered note (≤ 32 KiB body plus frontmatter) as base64, plus the audience. */
export const KNOWLEDGE_WRITE_MAX_RESPONSE_BYTES = 256 * 1024;
/** Decoded rendered bytes a proposal may carry: the 64 KiB request cap bounds what can be rendered. */
export const KNOWLEDGE_WRITE_MAX_RENDERED_BYTES = 64 * 1024;
/** The commit leg writes and reads back through the source's store; the v2 get's deadline. */
export const KNOWLEDGE_WRITE_TIMEOUT_MS = 8000;

const NOTE_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TAG_PATTERN = /^[a-z0-9-]{1,32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ─────────────────────── C.11, the source's closed code set ───────────────────────

/**
 * The refusal codes a source may answer with, and the HTTP status C.11 binds
 * each to. A refusal passes through ONLY when both the code and its status are
 * the table's; anything else is `source_protocol_error`. `internal_error` is
 * C.7's (a rendered preview whose stamps do not match).
 */
export const KNOWLEDGE_WRITE_SOURCE_REFUSALS: Readonly<Record<string, number>> = Object.freeze({
  assertion_invalid: 403,
  unavailable: 503,
  target_not_writable: 403,
  no_private_scope: 403,
  audience_exceeds_basis: 403,
  basis_unreadable: 403,
  not_own_note: 403,
  content_invalid: 400,
  content_secret_suspect: 403,
  audience_changed: 409,
  preview_mismatch: 409,
  revision_conflict: 409,
  proposal_expired: 410,
  egress_blocked: 403,
  reserved_name: 403,
  daily_cap: 429,
  commit_unverified: 502,
  internal_error: 500,
});

/** Core-authored refusal tokens, with their HTTP status. Source text is NEVER forwarded. */
export const KNOWLEDGE_WRITE_CORE_REFUSALS = Object.freeze({
  content_invalid: 400,
  revision_of_invalid: 400,
  source_required: 400,
  task_context_mismatch: 422,
  handle_malformed: 400,
  handle_tampered: 400,
  handle_key_retired: 400,
  handle_key_unknown: 400,
  handle_version_unsupported: 400,
  refused: 403,
  source_not_write_capable: 403,
  source_protocol_error: 502,
  source_unavailable: 503,
  source_timed_out: 504,
  unavailable: 503,
} as const);
export type KnowledgeWriteCoreRefusal = keyof typeof KNOWLEDGE_WRITE_CORE_REFUSALS;

const HANDLE_REFUSALS: ReadonlySet<string> = new Set([
  'handle_malformed', 'handle_tampered', 'handle_key_retired', 'handle_key_unknown', 'handle_version_unsupported',
]);

// ─────────────────────────────── outcomes ───────────────────────────────

export type KnowledgeWriteOutcome =
  | { ok: true; status: 200; body: Record<string, unknown> }
  | {
    ok: false;
    status: number;
    code: string;
    message: string;
    field?: string;
    auditRef?: string;
    /** True when the code is the source's own (C.11), passed through. */
    fromSource?: boolean;
    /** commit_unverified only: the flagged revision, sealed. */
    handle?: string;
    errorId?: string;
  };

const fail = (code: KnowledgeWriteCoreRefusal, message: string, extra: Partial<KnowledgeWriteOutcome & { ok: false }> = {}): KnowledgeWriteOutcome =>
  ({ ok: false, status: KNOWLEDGE_WRITE_CORE_REFUSALS[code], code, message, ...extra });

/** The uniform refusal of C.11. The message names no cause, deliberately. */
const UNIFORM_MESSAGE = 'The knowledge write was refused.';

// ──────────────────────────── caller input ─────────────────────────────

/** A sealed address unsealed in the core: the source and compartment it names, and the ref. */
interface UnsealedAddress { sourceId: string; compartment: string; ref: string }

interface ProposeRequest {
  op: 'propose';
  source: string | null;
  title: string;
  content: string;
  noteType: string;
  tags: string[];
  target: { kind: 'default' } | { kind: 'personal' } | { kind: 'compartment'; id: string } | null;
  taskId: string | null;
  basis: UnsealedAddress[];
  revisionOf: UnsealedAddress | null;
  expectedRevision: string;
}
interface PreviewRequest { op: 'preview'; source: string | null; proposalId: string }
interface CommitRequest { op: 'commit'; source: string | null; proposalId: string; previewDigest: string; expectedRevision: string }
type WriteRequest = ProposeRequest | PreviewRequest | CommitRequest;

class KnowledgeWriteInputRefusal extends Error {
  constructor(public readonly code: KnowledgeWriteCoreRefusal, message: string, public readonly field?: string) {
    super(message);
  }
}

const invalid = (field: string, message: string): never => {
  throw new KnowledgeWriteInputRefusal('content_invalid', message, field);
};

const PROPOSE_KEYS = ['title', 'content', 'source', 'noteType', 'tags', 'target', 'taskId', 'basis', 'revisionOf', 'expectedRevision'];
const PREVIEW_KEYS = ['proposalId', 'source'];
const COMMIT_KEYS = ['proposalId', 'previewDigest', 'expectedRevision', 'source'];

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !OPAQUE_COMPARTMENT_PATTERN.test(value)) invalid(field, `'${field}' must be a lowercase canonical UUID`);
  return value as string;
}

function requiredUuid(value: unknown, field: string): string {
  const parsed = optionalUuid(value, field);
  if (parsed === null) invalid(field, `'${field}' is required`);
  return parsed as string;
}

function unsealAddress(handle: unknown, field: string): UnsealedAddress {
  try {
    const payload = unsealKnowledgeHandle(handle);
    return { sourceId: payload.s, compartment: payload.c, ref: payload.r };
  } catch (e) {
    // Only the HANDLE-shaped failures describe the caller's input. A missing
    // or broken keyset is an operator problem and rethrows to the generic 500,
    // exactly as in the get executor.
    if (e instanceof KnowledgeHandleError && HANDLE_REFUSALS.has(e.code)) {
      throw new KnowledgeWriteInputRefusal(e.code as KnowledgeWriteCoreRefusal, `'${field}' is not a usable sealed address (${e.code})`, field);
    }
    throw e;
  }
}

function checkKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    // Named by the FIRST unknown key only, bounded: the refusal goes back to
    // the caller who sent it and quotes nothing else.
    const first = unknown.sort()[0].slice(0, 64);
    invalid(first, `unknown field: ${first}`);
  }
}

/**
 * Parse and bound the caller's input (C.2, C.16). Throws `KnowledgeWriteInputRefusal`; the
 * act has not begun, so nothing is audited and nothing is dialed.
 */
export function parseKnowledgeWriteRequest(op: KnowledgeWriteOp, raw: unknown): WriteRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid('body', 'the request body must be a JSON object');
  const body = raw as Record<string, unknown>;

  if (op === 'preview') {
    checkKeys(body, PREVIEW_KEYS);
    return { op, source: optionalUuid(body.source, 'source'), proposalId: requiredUuid(body.proposalId, 'proposalId') };
  }
  if (op === 'commit') {
    checkKeys(body, COMMIT_KEYS);
    const previewDigest = body.previewDigest;
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) invalid('previewDigest', "'previewDigest' must be the 64-hex preview digest the preview returned");
    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== 'string' || (expectedRevision !== 'absent' && !SHA256_PATTERN.test(expectedRevision))) {
      invalid('expectedRevision', "'expectedRevision' must be \"absent\" or a 64-hex sha256");
    }
    return {
      op, source: optionalUuid(body.source, 'source'), proposalId: requiredUuid(body.proposalId, 'proposalId'),
      previewDigest: previewDigest as string, expectedRevision: expectedRevision as string,
    };
  }

  checkKeys(body, PROPOSE_KEYS);
  const title = body.title;
  if (typeof title !== 'string' || [...title].length < 1 || [...title].length > KNOWLEDGE_NOTE_MAX_TITLE_CHARS
    || CONTROL_CHARACTERS.test(title) || LONE_SURROGATE.test(title)) {
    invalid('title', `'title' must be 1..${KNOWLEDGE_NOTE_MAX_TITLE_CHARS} characters on one line`);
  }
  const content = body.content;
  if (typeof content !== 'string' || LONE_SURROGATE.test(content)) invalid('content', "'content' must be a UTF-8 string");
  if (Buffer.byteLength(content as string, 'utf8') > KNOWLEDGE_NOTE_MAX_CONTENT_BYTES) {
    invalid('content', `'content' must be at most ${KNOWLEDGE_NOTE_MAX_CONTENT_BYTES} bytes of UTF-8`);
  }
  // C.2: content must not begin with a `---` frontmatter block. The source
  // renders the whole frontmatter (C.10); a body that opens one would smuggle
  // stamps past it.
  if ((content as string).replace(/^﻿/, '').startsWith('---')) {
    invalid('content', "'content' must not begin with a '---' frontmatter block; the source renders the frontmatter");
  }
  const noteType = body.noteType === undefined ? 'note' : body.noteType;
  if (typeof noteType !== 'string' || !NOTE_TYPE_PATTERN.test(noteType)) invalid('noteType', `'noteType' must match ${NOTE_TYPE_PATTERN}`);
  const tags = body.tags === undefined ? [] : body.tags;
  if (!Array.isArray(tags) || tags.length > KNOWLEDGE_NOTE_MAX_TAGS
    || !tags.every((tag) => typeof tag === 'string' && TAG_PATTERN.test(tag))) {
    invalid('tags', `'tags' must be at most ${KNOWLEDGE_NOTE_MAX_TAGS} values matching ${TAG_PATTERN}`);
  }

  let target: ProposeRequest['target'] = null;
  if (body.target !== undefined) {
    if (body.target === 'default' || body.target === 'personal') {
      target = { kind: body.target };
    } else if (typeof body.target === 'object' && body.target !== null && !Array.isArray(body.target)
      && Object.keys(body.target).length === 1
      && typeof (body.target as Record<string, unknown>).compartmentId === 'string'
      && OPAQUE_COMPARTMENT_PATTERN.test((body.target as Record<string, string>).compartmentId)) {
      target = { kind: 'compartment', id: (body.target as Record<string, string>).compartmentId };
    } else {
      invalid('target', "'target' must be \"default\", \"personal\" or {compartmentId: <opaque id>}");
    }
  }

  const basisRaw = body.basis === undefined ? [] : body.basis;
  if (!Array.isArray(basisRaw) || basisRaw.length > KNOWLEDGE_NOTE_MAX_BASIS) {
    invalid('basis', `'basis' must be an array of at most ${KNOWLEDGE_NOTE_MAX_BASIS} sealed handles`);
  }
  const basis = (basisRaw as unknown[]).map((handle, i) => unsealAddress(handle, `basis[${i}]`));

  const revisionOf = body.revisionOf === undefined || body.revisionOf === null ? null : unsealAddress(body.revisionOf, 'revisionOf');
  const expectedRaw = body.expectedRevision;
  let expectedRevision = 'absent';
  if (expectedRaw !== undefined) {
    if (typeof expectedRaw !== 'string' || (expectedRaw !== 'absent' && !SHA256_PATTERN.test(expectedRaw))) {
      invalid('expectedRevision', "'expectedRevision' must be \"absent\" or a 64-hex sha256");
    }
    expectedRevision = expectedRaw as string;
  }
  // A create names no revision; an update (C.10) names the sha256 it read.
  if (revisionOf === null && expectedRevision !== 'absent') {
    invalid('expectedRevision', "'expectedRevision' names a revision only together with 'revisionOf'");
  }
  if (revisionOf !== null && expectedRevision === 'absent') {
    invalid('expectedRevision', "an update ('revisionOf') must name the 64-hex sha256 it read as 'expectedRevision'");
  }
  // N14: with revisionOf, the target is absent or equal to the stored
  // compartment — an update never moves a note between compartments.
  if (revisionOf !== null && target !== null && !(target.kind === 'compartment' && target.id === revisionOf.compartment)) {
    throw new KnowledgeWriteInputRefusal('revision_of_invalid', "with 'revisionOf', 'target' must be absent or the revision's own compartment", 'target');
  }

  return {
    op: 'propose',
    source: optionalUuid(body.source, 'source'),
    title: title as string,
    content: content as string,
    noteType: noteType as string,
    tags: [...(tags as string[])],
    target,
    taskId: optionalUuid(body.taskId, 'taskId'),
    basis,
    revisionOf,
    expectedRevision,
  };
}

// ───────────────────────────── the source row ─────────────────────────────

interface WriteSourceRow extends KnowledgeWriteSourceArmRow {
  knowledge_allowed_networks: string[] | null;
  knowledge_core_credential_ref: string | null;
  current_descriptor_version: number | null;
}

const SOURCE_COLUMNS = `s.id, s.slug, s.status, s.retired_at,
            s.knowledge_query_endpoint, s.knowledge_write_endpoint,
            s.knowledge_claims_mode, s.knowledge_subject_mode,
            s.knowledge_relevant_groups, s.knowledge_allowed_networks,
            s.knowledge_core_credential_ref, s.current_descriptor_version,
            v.descriptor`;

async function readSourceRow(sourceId: string): Promise<WriteSourceRow | null> {
  const result = await pool.query(
    `SELECT ${SOURCE_COLUMNS}
       FROM services s
       LEFT JOIN service_descriptor_versions v
         ON v.service_id = s.id AND v.version = s.current_descriptor_version
      WHERE s.id = $1`,
    [sourceId],
  );
  return (result.rows[0] as WriteSourceRow | undefined) ?? null;
}

async function readWriteConfiguredRows(): Promise<WriteSourceRow[]> {
  const result = await pool.query(
    `SELECT ${SOURCE_COLUMNS}
       FROM services s
       LEFT JOIN service_descriptor_versions v
         ON v.service_id = s.id AND v.version = s.current_descriptor_version
      WHERE s.knowledge_write_endpoint IS NOT NULL
      ORDER BY s.id`,
  );
  return result.rows as WriteSourceRow[];
}

// ───────────────────────────── task context (C.3) ─────────────────────────────

type TaskContextResult =
  | { ok: true; context: KnowledgeTaskContext | null }
  | { ok: false; refusal: KnowledgeWriteOutcome; reason: string };

/**
 * C.3, verbatim in effect: "if the acting principal is an Agent with a live
 * `boundTaskId`, `tsk` = that task and a caller-supplied `taskId` must be
 * absent or equal; otherwise a caller-supplied `taskId` must pass the caller's
 * own task read authorization. `prj` = `tasks.project_id` read server-side; a
 * task without a project yields no `tsk`/`prj` and therefore no task context."
 *
 * The bound task was live-checked by the authentication middleware (terminal
 * status or an expired lease is a 401 before this point).
 */
async function resolveTaskContext(req: AuthRequest, requestedTaskId: string | null): Promise<TaskContextResult> {
  const acting = req.delegationLinks?.[0];
  const boundTaskId = req.principal?.kind === 'agent' && acting?.kind === 'agent' && acting.principalId === req.principal.id
    ? (acting.boundTaskId ?? null) : null;
  let taskId: string | null = null;
  if (boundTaskId) {
    if (requestedTaskId !== null && requestedTaskId !== boundTaskId) {
      return {
        ok: false, reason: 'task_context_mismatch',
        refusal: fail('task_context_mismatch', "an Agent writes in its bound Task's context: 'taskId' must be absent or equal to it", { field: 'taskId' }),
      };
    }
    taskId = boundTaskId;
  } else if (requestedTaskId !== null) {
    const actor = req.authorizationActor ?? actorFromRequest(req);
    const decision = await authorizationRepository.authorizePoint(actor, 'task', requestedTaskId, 'read');
    // An unknown task and an unreadable one are the SAME refusal: no existence oracle.
    if (!decision.allowed) return { ok: false, reason: 'task_unreadable', refusal: fail('refused', UNIFORM_MESSAGE) };
    taskId = requestedTaskId;
  }
  if (taskId === null) return { ok: true, context: null };
  const row = await pool.query('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
  const projectId = row.rows[0]?.project_id ?? null;
  return { ok: true, context: projectId === null ? null : { taskId, projectId: String(projectId) } };
}

// ───────────────────────────── answer validation ─────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInstant = (value: unknown): boolean => typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));

function canonicalBase64(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value && bytes.length <= maxBytes ? bytes : null;
}

function validCompartment(value: unknown, kinds: readonly string[] | null): boolean {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !OPAQUE_COMPARTMENT_PATTERN.test(value.id)) return false;
  if (value.label !== undefined && (typeof value.label !== 'string' || value.label.length > 128)) return false;
  if (kinds !== null && !kinds.includes(value.kind as string)) return false;
  return true;
}

/** C.2's proposal shape (propose and preview), field-complete, with the digest recomputed by the core. */
function validProposalAnswer(answer: Record<string, unknown>, expected: { proposalId?: string; expectedRevision?: string }): boolean {
  if (answer.protocol_version !== KNOWLEDGE_WRITE_PROTOCOL_VERSION || answer.status !== 'proposed') return false;
  if (typeof answer.proposal_id !== 'string' || !OPAQUE_COMPARTMENT_PATTERN.test(answer.proposal_id)) return false;
  if (expected.proposalId !== undefined && answer.proposal_id !== expected.proposalId) return false;
  if (typeof answer.preview_digest !== 'string' || !SHA256_PATTERN.test(answer.preview_digest)) return false;
  if (!isInstant(answer.expires_at)) return false;
  const bytes = canonicalBase64(answer.content_base64, KNOWLEDGE_WRITE_MAX_RENDERED_BYTES);
  if (!bytes || answer.byte_length !== bytes.length) return false;
  // The core computes the digest itself: a source cannot make the core agree
  // with a hash it did not earn (the get executor's rule).
  if (typeof answer.content_sha256 !== 'string' || !SHA256_PATTERN.test(answer.content_sha256)
    || crypto.createHash('sha256').update(bytes).digest('hex') !== answer.content_sha256) return false;
  // `base` is the source's shared compartment: the source alone decides
  // writability; the core relays the act and checks the answer's shape.
  if (!isPlainObject(answer.target) || !validCompartment(answer.target.compartment, ['personal', 'project', 'base'])) return false;
  if (!isPlainObject(answer.audience)) return false;
  if (typeof answer.expected_revision !== 'string'
    || (answer.expected_revision !== 'absent' && !SHA256_PATTERN.test(answer.expected_revision))) return false;
  if (expected.expectedRevision !== undefined && answer.expected_revision !== expected.expectedRevision) return false;
  if (answer.snapshot !== undefined && (!isPlainObject(answer.snapshot)
    || (answer.snapshot.generation !== undefined && !(Number.isSafeInteger(answer.snapshot.generation) && Number(answer.snapshot.generation) >= 0)))) return false;
  return true;
}

/** C.2's commit shape. The ref is validated as an opaque string and NEVER echoed. */
function validCommitAnswer(answer: Record<string, unknown>): boolean {
  return answer.protocol_version === KNOWLEDGE_WRITE_PROTOCOL_VERSION
    && answer.status === 'committed'
    && typeof answer.ref === 'string' && answer.ref.length >= 1 && answer.ref.length <= 2048
    && validCompartment(answer.compartment, null)
    && typeof answer.sha256 === 'string' && SHA256_PATTERN.test(answer.sha256)
    && isInstant(answer.committed_at);
}

// ───────────────────────────── the act ─────────────────────────────

export interface KnowledgeWriteOptions {
  /** The deployment identity that issues assertions (§5.2 `iss`). */
  issuer: string;
  /** The caller's groups, minimised against the source's relevant groups. */
  callerGroupIds?: readonly string[];
}

interface ActContext {
  req: AuthRequest;
  op: KnowledgeWriteOp;
  auditRef: string;
  sourceId: string | null;
  proposalId: string | null;
  context: KnowledgeTaskContext | null;
  accountPrincipalId: string | null;
}

/** One OUTCOME row. Throws on failure (fail closed); the caller maps it. */
function outcomeRow(act: ActContext, outcome: string, extra: Partial<KnowledgeWriteAuditRow> = {}): Promise<void> {
  return recordKnowledgeWriteAudit(act.req, {
    auditRef: act.auditRef,
    phase: 'outcome',
    op: act.op,
    outcome,
    accountPrincipalId: act.accountPrincipalId,
    sourceId: act.sourceId,
    proposalId: act.proposalId,
    taskId: act.context?.taskId ?? null,
    projectId: act.context?.projectId ?? null,
    ...extra,
  });
}

/** A refusal that is audited first. If the row cannot be written, the act fails closed. */
async function auditedRefusal(act: ActContext, outcome: string, refusal: KnowledgeWriteOutcome, extra: Partial<KnowledgeWriteAuditRow> = {}): Promise<KnowledgeWriteOutcome> {
  await outcomeRow(act, outcome, extra);
  return refusal.ok ? refusal : { ...refusal, auditRef: act.auditRef };
}

/** The verb URL: the owner-plane BASE URL with `/<op>` appended to its path. */
export function knowledgeWriteVerbUrl(base: string, op: KnowledgeWriteOp): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${op}`;
  return url.toString();
}

/** Seal a committed ref into a v2 handle against the source's CURRENT descriptor version. */
function sealCommitted(row: WriteSourceRow, compartment: string, ref: string): string {
  return sealKnowledgeHandle({
    s: row.id,
    dv: Number(row.current_descriptor_version),
    c: compartment,
    r: ref,
    // A write source is a v2 dynamic-opaque source (the write predicate), so
    // the handle is a v2 address; the filter does not narrow by kind or
    // category — the get re-checks the category against the declaration.
    f: normalizeKnowledgeFilter(['code', 'data', 'docs']),
  });
}

async function executeKnowledgeWriteInner(
  req: AuthRequest, op: KnowledgeWriteOp, request: WriteRequest, options: KnowledgeWriteOptions, act: ActContext,
): Promise<KnowledgeWriteOutcome> {
  // ── 1. THE PROPOSAL BINDING (preview, commit; C.8 step 1) ──
  let requestedTaskId: string | null = null;
  if (request.op === 'propose') {
    requestedTaskId = request.taskId;
  } else {
    act.proposalId = request.proposalId;
    const binding = await readKnowledgeProposalBinding(request.proposalId);
    act.sourceId = binding?.sourceId ?? request.source;
    if (!binding || binding.actingPrincipalId === null || binding.actingPrincipalId !== req.principal?.id
      || binding.sourceId === null || (request.source !== null && request.source !== binding.sourceId)) {
      return auditedRefusal(act, 'refused_proposal_binding', fail('refused', UNIFORM_MESSAGE));
    }
    requestedTaskId = binding.taskId;
  }

  // ── 2. TASK CONTEXT (C.3) — re-attested on every verb ──
  const task = await resolveTaskContext(req, requestedTaskId);
  if (!task.ok) {
    act.sourceId = act.sourceId ?? request.source;
    return auditedRefusal(act, task.reason, task.refusal);
  }
  act.context = task.context;
  // A preview or commit re-attests the PROPOSING context: the bound task of an
  // Agent must still be the proposal's task.
  if (request.op !== 'propose' && requestedTaskId !== null && task.context !== null && task.context.taskId !== requestedTaskId) {
    return auditedRefusal(act, 'refused_task_context', fail('refused', UNIFORM_MESSAGE));
  }

  // ── 3. THE SOURCE AND THE WRITE ARM SET (C.12) ──
  let row: WriteSourceRow | null = null;
  let evaluation: KnowledgeWriteArmEvaluation | null = null;
  const sourceId = request.op === 'propose' ? request.source : act.sourceId;
  if (sourceId !== null) {
    act.sourceId = sourceId;
    row = await readSourceRow(sourceId);
    if (!row) return auditedRefusal(act, 'refused_unknown_source', fail('refused', UNIFORM_MESSAGE));
    const armed = await evaluateKnowledgeWriteArms(req, row, op, act.context);
    if (armed === 'arms') return auditedRefusal(act, 'refused_arms', fail('refused', UNIFORM_MESSAGE));
    if (armed === 'not_write_capable') {
      return auditedRefusal(act, 'source_not_write_capable',
        fail('source_not_write_capable', 'This knowledge source accepts no writes through the door: it has no owner-plane write endpoint or no declared write block.'));
    }
    evaluation = armed;
  } else {
    // C.12: "omitted = the one write-capable source the caller's arms admit,
    // else `source_required`". ONE code for zero and for several, so the
    // answer does not count the estate (N12).
    const admitted: Array<{ row: WriteSourceRow; evaluation: KnowledgeWriteArmEvaluation }> = [];
    for (const candidate of await readWriteConfiguredRows()) {
      const armed = await evaluateKnowledgeWriteArms(req, candidate, op, act.context);
      if (typeof armed === 'object') admitted.push({ row: candidate, evaluation: armed });
    }
    if (admitted.length !== 1) {
      return auditedRefusal(act, 'source_required',
        fail('source_required', "Name the knowledge source to write to with 'source': the door could not choose exactly one write-capable source for you.", { field: 'source' }));
    }
    row = admitted[0].row;
    evaluation = admitted[0].evaluation;
    act.sourceId = row.id;
  }
  act.accountPrincipalId = evaluation.accountPrincipalId;

  // A same-source rule for the update target (C.12: "only refs of the same
  // source are passed on as refs"; a revision lives in the source it is a
  // revision of).
  if (request.op === 'propose' && request.revisionOf !== null && request.revisionOf.sourceId !== row.id) {
    return auditedRefusal(act, 'revision_of_invalid',
      fail('revision_of_invalid', "'revisionOf' must be a revision of the source being written to", { field: 'revisionOf' }));
  }

  // ── 4. THE OUTBOUND BODY, BOUNDED BEFORE ANYTHING IS SIGNED ──
  const payload: Record<string, unknown> = { protocol_version: KNOWLEDGE_WRITE_PROTOCOL_VERSION };
  if (request.op === 'propose') {
    payload.title = request.title;
    payload.content = request.content;
    payload.note_type = request.noteType;
    payload.tags = request.tags;
    payload.target = request.revisionOf !== null
      ? { kind: 'compartment', id: request.revisionOf.compartment }
      : (request.target ?? { kind: 'default' });
    // Basis items are UNSEALED here and the source is told only what C.2
    // allows: a ref of ITS OWN, or for any other source (the board included)
    // just which source and compartment — never another source's ref.
    payload.basis = request.basis.map((item) => (item.sourceId === row!.id
      ? { ref: item.ref, compartment: item.compartment }
      : { source: item.sourceId, compartment: item.compartment }));
    if (request.revisionOf !== null) payload.revision_of = { ref: request.revisionOf.ref, compartment: request.revisionOf.compartment };
    payload.expected_revision = request.expectedRevision;
  } else if (request.op === 'preview') {
    payload.proposal_id = request.proposalId;
  } else {
    payload.proposal_id = request.proposalId;
    payload.preview_digest = request.previewDigest;
    payload.expected_revision = request.expectedRevision;
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') + KNOWLEDGE_WRITE_ASSERTION_RESERVE_BYTES > KNOWLEDGE_WRITE_MAX_REQUEST_BYTES) {
    return auditedRefusal(act, 'content_invalid',
      fail('content_invalid', `the serialized write request exceeds ${KNOWLEDGE_WRITE_MAX_REQUEST_BYTES} bytes (C.16)`, { field: 'content' }));
  }

  // The channel credential is resolved before the intent row: a source the
  // core cannot authenticate itself to is never dialed (§4.2).
  const credential = resolveChannelCredential(row.knowledge_core_credential_ref);
  if (!credential || !row.knowledge_write_endpoint) {
    return auditedRefusal(act, 'source_unavailable', fail('source_unavailable', 'The knowledge source could not be reached.'));
  }
  const channel = channelAuthDialOptions(credential);

  // ── 5. SIGN (C.3) — the write signer, one fresh jti for this act ──
  const signed = await signKnowledgeWriteAssertion({
    armEvaluation: evaluation,
    issuer: options.issuer,
    callerGroupIds: options.callerGroupIds ?? [],
  });

  // ── 6. THE INTENT ROW — FAIL CLOSED: no row, no dial (C.15) ──
  try {
    await recordKnowledgeWriteAudit(req, {
      auditRef: act.auditRef, phase: 'intent', op, outcome: 'dialing',
      accountPrincipalId: act.accountPrincipalId, sourceId: row.id, proposalId: act.proposalId,
      assertionJti: signed.jti, taskId: act.context?.taskId ?? null, projectId: act.context?.projectId ?? null,
    });
  } catch (e) {
    const errorId = logCaughtFailure('record knowledge write intent', e instanceof KnowledgeWriteAuditError ? e.cause : e);
    return fail('unavailable', 'The knowledge write could not be recorded, so it was not sent. Nothing was written.', { errorId });
  }

  // ── 7. DIAL ──
  const dialed = await dialKnowledgeSource({
    url: knowledgeWriteVerbUrl(row.knowledge_write_endpoint, op),
    method: 'POST',
    body: JSON.stringify({ ...payload, assertion: signed.token }),
    headers: { 'content-type': 'application/json', ...(channel.headers ?? {}) },
    allowedNetworks: row.knowledge_allowed_networks ?? [],
    ...(channel.clientCertificate ? { clientCertificate: channel.clientCertificate } : {}),
    maxResponseBytes: KNOWLEDGE_WRITE_MAX_RESPONSE_BYTES,
    timeoutMs: KNOWLEDGE_WRITE_TIMEOUT_MS,
  });

  const jtiExtra = { assertionJti: signed.jti };
  if (!dialed.ok) {
    // The shared dial client answers a 429 from its Retry-After header alone
    // and never reads that body. C.11's ONLY 429 is `daily_cap`, so a source's
    // 429 IS that refusal, passed through with its status as every other.
    if (dialed.failure === 'rate-limited') {
      return auditedRefusal(act, 'daily_cap', {
        ok: false, status: KNOWLEDGE_WRITE_SOURCE_REFUSALS.daily_cap, code: 'daily_cap',
        message: `The knowledge source refused the ${op}: daily_cap.`, fromSource: true,
      }, jtiExtra);
    }
    const code = dialed.failure === 'timedOut' ? 'source_timed_out' : 'source_unavailable';
    return auditedRefusal(act, code, fail(code, 'The knowledge source could not be reached.'), jtiExtra);
  }

  // ── 8. FIELD-COMPLETE VALIDATION ──
  let answer: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(dialed.body) as unknown;
    answer = isPlainObject(parsed) ? parsed : null;
  } catch {
    answer = null;
  }
  const protocolError = (): Promise<KnowledgeWriteOutcome> => auditedRefusal(act, 'source_protocol_error',
    fail('source_protocol_error', 'The knowledge source answered outside the write contract.'), jtiExtra);
  if (!answer) return protocolError();

  if (dialed.status < 200 || dialed.status >= 300) {
    // C.11: the source's refusal passes through iff it is the one shape, a
    // code from the closed set, and that code's own status.
    const code = answer.status === 'refused' && answer.protocol_version === KNOWLEDGE_WRITE_PROTOCOL_VERSION
      && typeof answer.code === 'string' ? answer.code : null;
    if (code === null || KNOWLEDGE_WRITE_SOURCE_REFUSALS[code] === undefined || KNOWLEDGE_WRITE_SOURCE_REFUSALS[code] !== dialed.status) {
      return protocolError();
    }
    // C.8 step 6: `commit_unverified` is answered "with the ref, never a
    // silent success". The core seals it, so the caller can read the flagged
    // revision back without the raw ref ever leaving the core.
    let handle: string | undefined;
    let flagged: Partial<KnowledgeWriteAuditRow> = {};
    if (code === 'commit_unverified' && typeof answer.ref === 'string' && answer.ref.length >= 1 && answer.ref.length <= 2048
      && validCompartment(answer.compartment, null)) {
      const compartment = (answer.compartment as { id: string }).id;
      handle = sealCommitted(row, compartment, answer.ref);
      flagged = { compartment, refSha256: refSha256(answer.ref) };
    }
    return auditedRefusal(act, code, {
      ok: false,
      status: dialed.status,
      code,
      message: `The knowledge source refused the ${op}: ${code}.`,
      fromSource: true,
      ...(handle ? { handle } : {}),
    }, { ...jtiExtra, ...flagged });
  }

  if (op === 'commit') {
    if (!validCommitAnswer(answer)) return protocolError();
    const compartment = answer.compartment as { id: string; label?: string };
    const handle = sealCommitted(row, compartment.id, answer.ref as string);
    await outcomeRow(act, 'committed', {
      ...jtiExtra, contentSha256: answer.sha256 as string, compartment: compartment.id, refSha256: refSha256(answer.ref as string),
    });
    return {
      ok: true,
      status: 200,
      body: {
        source: row.id,
        auditRef: act.auditRef,
        // The source's commit answer with ONE substitution, C.8 step 9: the raw
        // ref is SEALED into a handle. Every other field is the source's own.
        result: {
          protocol_version: answer.protocol_version,
          status: answer.status,
          handle,
          compartment: answer.compartment,
          sha256: answer.sha256,
          committed_at: answer.committed_at,
        },
      },
    };
  }

  const expected = request.op === 'propose'
    ? { expectedRevision: request.expectedRevision }
    : { proposalId: (request as PreviewRequest).proposalId };
  if (!validProposalAnswer(answer, expected)) return protocolError();
  act.proposalId = answer.proposal_id as string;
  await outcomeRow(act, 'proposed', {
    ...jtiExtra,
    proposalId: answer.proposal_id as string,
    contentSha256: answer.content_sha256 as string,
    compartment: ((answer.target as Record<string, unknown>).compartment as { id: string }).id,
  });
  // The source's answer, UNCHANGED: the exact bytes it will write and the
  // audience it resolved. Relayed, never stored.
  return { ok: true, status: 200, body: { source: row.id, auditRef: act.auditRef, result: answer } };
}

/**
 * Run one write verb through the door. Every return is an outcome; an
 * unexpected failure (a missing keyset, a database outage outside the audit
 * seam) throws and becomes the route's generic 500 with an error id.
 */
export async function executeKnowledgeWrite(
  req: AuthRequest, op: KnowledgeWriteOp, body: unknown, options: KnowledgeWriteOptions,
): Promise<KnowledgeWriteOutcome> {
  let request: WriteRequest;
  try {
    request = parseKnowledgeWriteRequest(op, body);
  } catch (e) {
    if (e instanceof KnowledgeWriteInputRefusal) {
      return { ok: false, status: KNOWLEDGE_WRITE_CORE_REFUSALS[e.code], code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) };
    }
    throw e;
  }
  const act: ActContext = {
    req, op, auditRef: newKnowledgeAuditRef(), sourceId: null, proposalId: null, context: null, accountPrincipalId: null,
  };
  try {
    return await executeKnowledgeWriteInner(req, op, request, options, act);
  } catch (e) {
    if (e instanceof KnowledgeWriteAuditError) {
      // FAIL CLOSED (C.15). An outcome row that cannot be written fails the
      // act: the caller is told the truth — the source may have acted — and a
      // retry of a commit reaches the source, which answers a committed
      // proposal with its stored commit (C.8 step 8).
      const errorId = logCaughtFailure('record knowledge write outcome', e.cause);
      return fail('unavailable', 'The knowledge write could not be recorded. The source may have acted; retry the same act to read its answer.', { errorId });
    }
    throw e;
  }
}
