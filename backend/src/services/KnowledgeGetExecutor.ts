// KnowledgeGetExecutor.ts — RH-KW1 candidate B (card `0b4b779b`).
//
// §8.2's get, for EXTERNAL sources. The board pseudo-source branch is
// candidate C's — no board row exists before C, so this refuses it by name
// rather than pretending to serve it.
//
// ── THE ORDER IS THE CONTRACT ──
//
// unseal → arm set → compartment against the PINNED version → mode branch →
// dial. Every step before the dial is core's own evaluation, so a handle held
// by the wrong caller, or by one revoked since it was minted, is refused
// BEFORE any byte leaves the deployment. §8.1's "not caller-bound and
// non-expiring" is only defensible because of that ordering: the handle is an
// ADDRESS, and the authority is re-evaluated at every get.
import crypto from 'crypto';
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { dialKnowledgeSource } from './KnowledgeDialClient';
import {
  evaluateKnowledgeArms,
  isBoardSource,
  type KnowledgeSourceArmRow,
} from './KnowledgeArmEvaluator';
import { signKnowledgeAssertion } from './KnowledgeAssertionSigner';
import { validateRetrieval, KnowledgeCompartment, RetrievalStatus } from './KnowledgeV2';
import { unsealKnowledgeHandle, sealKnowledgeHandle, KnowledgeHandlePayload, KnowledgeHandleError } from './KnowledgeHandleSealer';
import { readBoardObject } from './KnowledgeBoardAdapter';
import { resolveChannelCredential, channelAuthDialOptions } from './KnowledgeChannelAuth';
import { recordKnowledgeGet } from './KnowledgeAuditService';
import type { ServiceDescriptor } from '../utils/serviceDescriptor';

/** Core-authored refusal tokens. Source-authored text is NEVER forwarded. */
export type KnowledgeGetRefusal =
  // ── ABOUT THE HANDLE THE CALLER PRESENTED ──
  //
  // These describe the caller's own input and disclose nothing about the
  // estate, so they stay distinct: an operator has to be able to tell a
  // rotated key from a forged handle from an unsupported version.
  | 'handle_malformed' | 'handle_tampered' | 'handle_key_retired' | 'handle_key_unknown'
  | 'handle_version_unsupported' | 'invalid_continuation' | 'source_protocol_error' | 'source_unavailable' | 'source_timed_out'
  // ── ABOUT ESTATE STATE — ONE TOKEN, DELIBERATELY (§5.5, finding F1) ──
  //
  // "Sources failing (a)-(c) or excluded by (e) are undisclosed absolutely —
  // never dialed, never in coverage, ids naming them in `sources[]` silently
  // ignored (byte-identical to unknown ids; gateway 404-conceal parity)."
  //
  // Round 1 shipped `source_unavailable` for a missing row and
  // `not_authorized` for a row the caller could not read, so a holder of a
  // valid non-expiring handle could tell "this source is gone" from "this
  // source is concealed from me". Every estate-dependent outcome now answers
  // with THIS token and nothing else: no row, retired, unconfigured, not
  // visible, not selector-covered, the reserved board row, and a compartment
  // absent from the handle's pinned version.
  | 'not_authorized'
  // ── ABOUT THE REQUEST'S OWN CONSISTENCY, AND THE SOURCE'S ANSWER ──
  | 'continuation_without_content_hash' | 'content_changed'
  | 'source_refused' | 'source_response_invalid' | 'transport';

export interface KnowledgeV2Content {
  protocol_version: 2; status: 'content'; content_base64: string; sha256: string;
  offset: number; byteLength: number; totalBytes: number; truncated: boolean; continuation?: string;
  provenance: { sourceId: string; compartment: KnowledgeCompartment; contentKind: string; category: string };
  retrieval: RetrievalStatus;
}
export type KnowledgeGetResult =
  | ({ ok: true } & KnowledgeV2Content)
  | { ok: true; content: string; sha256: string; compartment: string; truncated?: boolean }
  | { ok: true; notModified: true }
  | { ok: false; refused: KnowledgeGetRefusal };

export interface KnowledgeGetInput {
  handle: unknown;
  continuation?: unknown;
  auditRef?: string;
  continueFrom?: number;
  contentHash?: string;
  ifNoneMatch?: string;
}

/** §8.2: full-content cap 256 KiB per get. */
export const KNOWLEDGE_GET_MAX_BYTES = 256 * 1024;

const refuse = (refused: KnowledgeGetRefusal): KnowledgeGetResult => ({ ok: false, refused });

/**
 * A window of `text`, in UTF-8 BYTES, that never splits a code point.
 *
 * Buffer slicing alone would cut a multi-byte sequence in half and hand the
 * caller a replacement character it can never resume from; the trailing
 * partial sequence is dropped instead, so the next `continueFrom` the caller
 * is given is always a real boundary.
 */
function utf8Window(text: string, startByte: number, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (startByte >= bytes.length) return '';
  const end = Math.min(bytes.length, startByte + maxBytes);
  let cut = end;
  // A continuation byte is 10xxxxxx; walk back to the start of the sequence.
  while (cut > startByte && cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(startByte, cut).toString('utf8');
}

/**
 * Every estate-dependent refusal, collapsed (§5.5; finding F1).
 *
 * `internal` is the reason a human would want, and it deliberately goes
 * NOWHERE near the response. §7.7's audit row is where the real reason
 * belongs, and that row ships with the audit emitter in candidate C; until
 * then this argument documents the distinction the caller must not see.
 */
const conceal = (internal: string): KnowledgeGetResult => {
  void internal;
  return { ok: false, refused: 'not_authorized' };
};

/** The handle failures a CALLER may be told about. Nothing else maps. */
const HANDLE_REFUSALS: ReadonlySet<KnowledgeGetRefusal> = new Set([
  'handle_malformed', 'handle_tampered', 'handle_key_retired',
  'handle_key_unknown', 'handle_version_unsupported',
]);

interface SourceRow extends KnowledgeSourceArmRow {
  knowledge_get_endpoint: string | null;
  knowledge_allowed_networks: string[] | null;
  knowledge_core_credential_ref: string | null;
}

async function executeKnowledgeGetInner(
  req: AuthRequest,
  input: KnowledgeGetInput,
  options: { issuer: string; callerGroupIds?: readonly string[]; trustAnchors?: string | string[] } ,
): Promise<KnowledgeGetResult> {
  // ── 1. UNSEAL ──
  let payload;
  try {
    payload = unsealKnowledgeHandle(input.handle);
  } catch (e) {
    // Only the HANDLE-shaped failures are refusals. A keyset that is missing
    // or misconfigured is an operator problem, not a statement about the
    // caller's handle, and turning it into a refusal token would both lie to
    // the caller and disclose deployment state. It rethrows and becomes the
    // route's generic 500 with an error id.
    if (e instanceof KnowledgeHandleError && HANDLE_REFUSALS.has(e.code as KnowledgeGetRefusal)) {
      return refuse(e.code as KnowledgeGetRefusal);
    }
    throw e;
  }

  // ── 2. §8.3's continuation rule, BEFORE anything is dialed ──
  //
  // "Any `continueFrom > 0` MUST carry `contentHash` = the first window's
  // sha256; mismatch → named `content_changed`." Checked here because a
  // continuation with no anchor is a splice request, and there is nothing to
  // ask a source about.
  let continuation: KnowledgeHandlePayload | undefined;
  if (payload.v === 2) {
    if (input.continueFrom !== undefined || input.contentHash !== undefined || (input.continuation !== undefined && input.ifNoneMatch !== undefined)) return refuse('invalid_continuation');
    if (input.ifNoneMatch !== undefined && !/^[a-f0-9]{64}$/.test(input.ifNoneMatch)) return refuse('invalid_continuation');
    if (input.continuation !== undefined) {
      try { continuation = unsealKnowledgeHandle(input.continuation, 'continuation'); } catch { return refuse('invalid_continuation'); }
      if (['s','dv','c','r','fh'].some(k => continuation![k as keyof KnowledgeHandlePayload] !== payload[k as keyof KnowledgeHandlePayload])) return refuse('invalid_continuation');
    }
  } else if (input.continuation !== undefined) return refuse('invalid_continuation');
  const continueFrom = continuation?.next ?? Number(input.continueFrom ?? 0);
  const contentHash = continuation?.h ?? input.contentHash;
  if (Number.isFinite(continueFrom) && continueFrom > 0 && !contentHash) {
    return refuse('continuation_without_content_hash');
  }

  // ── 3. THE SOURCE IS THE HANDLE'S, NEVER THE CALLER'S ──
  //
  // Acceptance item 3: "a handle for source A presented against B refused at
  // core with B's log empty". This function takes no source parameter at all,
  // so B is not merely refused — it is unaddressable. The source id comes
  // only from the SEALED payload, which is integrity-protected.
  const result = await pool.query(
    `SELECT s.id, s.slug, s.status, s.retired_at,
            s.knowledge_query_endpoint, s.knowledge_get_endpoint,
            s.knowledge_claims_mode, s.knowledge_subject_mode,
            s.knowledge_relevant_groups, s.knowledge_allowed_networks,
            s.knowledge_core_credential_ref,
            v.descriptor
       FROM services s
       LEFT JOIN service_descriptor_versions v
         ON v.service_id = s.id AND v.version = s.current_descriptor_version
      WHERE s.id = $1`,
    [payload.s],
  );
  if (result.rows.length === 0) return conceal('no such source row');
  const row = result.rows[0] as SourceRow;

  /**
   * §7.7's get row, for every terminal outcome from here on.
   *
   * Written AFTER the source row is known, because the row's whole purpose is
   * to say WHICH source a ref was read from; before that point there is no
   * source to name and the refusal is about the caller's own handle. The
   * digest is computed inside `recordKnowledgeGet` from the DECODED raw ref —
   * this function never passes a ref anywhere else, and nothing here logs one.
   */
  const auditGet = (outcome: string): Promise<void> => recordKnowledgeGet(req, {
    ...(input.auditRef ? { auditRef: input.auditRef } : {}),
    sourceId: row.id,
    compartment: payload.c,
    rawRef: payload.r,
    outcome,
  });

  // ── 4. THE FULL §5.2 ARM SET, re-run at every get ──
  const arms = await evaluateKnowledgeArms(req, row);
  if (!arms) {
    await auditGet('not_authorized');
    return conceal('an arm of the §5.2 set was false');
  }

  // ── 5. THE COMPARTMENT, AGAINST THE HANDLE'S PINNED VERSION (§8.1) ──
  //
  // `dv` is why a later publish cannot invalidate outstanding handles
  // wholesale: the re-check runs against the version the handle was minted
  // from, and descriptor versions are immutable and historically readable
  // even once retired (census `abc71ffb` F7). A handle whose sealed
  // compartment was never declared in its OWN pinned version is refused —
  // that is the forgery case, not the rotation case.
  const pinned = await pool.query(
    'SELECT descriptor FROM service_descriptor_versions WHERE service_id = $1 AND version = $2',
    [payload.s, payload.dv],
  );
  if (pinned.rows.length === 0) {
    await auditGet('not_authorized');
    return conceal('the handle pins a version that does not exist');
  }
  const pinnedBlock = (pinned.rows[0].descriptor as ServiceDescriptor | null)?.knowledgeSource ?? null;
  if (!pinnedBlock || (payload.v === 2
    ? pinnedBlock.protocol_version !== 2 || pinnedBlock.compartment_mode !== 'dynamic-opaque'
    : !pinnedBlock.compartments.includes(payload.c))) {
    // A core-minted handle cannot reach here: §8.1's pin means a compartment
    // DROPPED by a later publish still validates against its own version. So
    // this is the forgery case — and it is concealed like every other
    // estate-dependent outcome, because "that compartment was never declared"
    // is itself a fact about the estate.
    await auditGet('not_authorized');
    return conceal('the sealed compartment was never declared in its pinned version');
  }

  // ── 5b. THE BOARD BRANCH (§8.2, §9) ──
  //
  // §9: "At GET, §8.2's board branch RE-RUNS the same composed authorization
  // on the addressed object before reading." It runs here, AFTER the §5.2 arm
  // set and AFTER the pinned-compartment check, and before anything is read:
  // the handle says which object was addressed, never that the caller may
  // still have it.
  //
  // No channel, no assertion, no dial — acceptance item 13 measures ZERO
  // signings for board gets at the signer seam, and this branch cannot reach
  // the signer.
  if (isBoardSource(row.slug)) {
    const object = await readBoardObject(req, payload.r, payload.c);
    if (!object) {
      // Indistinguishable, deliberately: a report B may not read, A's own
      // report after A lost read, and a handle naming a row that never
      // existed all answer with the same token (§11.11, §11.10).
      await auditGet('not_authorized');
      return conceal('the addressed board object is not readable by this caller');
    }
    const full = object.content;
    const documentSha256 = crypto.createHash('sha256').update(full, 'utf8').digest('hex');

    // §8.3's anchor, applied to core's own document exactly as it is applied
    // to a source's: a continuation must be of the SAME document.
    if (continueFrom > 0 && input.contentHash && input.contentHash !== documentSha256) {
      await auditGet('content_changed');
      return refuse('content_changed');
    }
    // §8.3's ORDERING, which core owes as a source: the compartment was
    // evaluated above; only now may an ifNoneMatch comparison happen. A
    // caller who lost the compartment reached the refusal before this line.
    if (input.ifNoneMatch && input.ifNoneMatch === documentSha256) {
      await auditGet('not_modified');
      return { ok: true, notModified: true };
    }

    // §8.3: `window` is `document` only in v1, so the window is a byte range
    // of one document and never a chunk address.
    //
    // ROUND-1 FINDING P5: this used to be `String.slice`, which counts UTF-16
    // code units against a constant named in BYTES — 262,144 "characters" of
    // ordinary emoji content emitted 524,288 bytes. The window is cut in UTF-8
    // bytes now, and `continueFrom` counts the same units, so a caller that
    // resumes at the offset core reported resumes where core stopped.
    const window = utf8Window(full, continueFrom, KNOWLEDGE_GET_MAX_BYTES);
    const truncated = continueFrom + Buffer.byteLength(window, 'utf8') < Buffer.byteLength(full, 'utf8');
    await auditGet('ok');
    return {
      ok: true,
      content: window,
      sha256: documentSha256,
      compartment: object.compartment,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  // ── 6. THE §8.2 MODE BRANCH (review R2-1) ──
  //
  // `asserted` ⇒ channel + a FRESH assertion. `none` ⇒ channel, NO assertion
  // — the arm set was still re-run at core, because authority is core's
  // evaluation and the channel is the authenticator, exactly as at search.
  let assertion: string | undefined;
  if (row.knowledge_claims_mode === 'asserted') {
    assertion = await signKnowledgeAssertion({
      armEvaluation: arms,
      issuer: options.issuer,
      callerGroupIds: options.callerGroupIds ?? [],
    });
  }

  // §4.2: the get endpoint DEFAULTS to the query endpoint.
  const endpoint = row.knowledge_get_endpoint ?? row.knowledge_query_endpoint;
  if (!endpoint) {
    await auditGet('not_authorized');
    return conceal('the source carries no dialable endpoint');
  }

  // The get contract of §8.2. `assertion?` is present iff the source is
  // `asserted`; `ifNoneMatch` is FORWARDED, never compared here.
  const body = JSON.stringify({
    ref: payload.r,
    ...(payload.v === 2 ? { protocol_version: 2, compartment_id: payload.c, filter: payload.f, limitBytes: KNOWLEDGE_GET_MAX_BYTES, ...(contentHash ? { contentHash } : {}) } : {}),
    ...(continueFrom > 0 ? { continueFrom } : {}),
    ...(input.ifNoneMatch ? { ifNoneMatch: input.ifNoneMatch } : {}),
    ...(assertion ? { assertion } : {}),
  });

  // §4.2's channel authentication, on the GET leg too: "every knowledge dial
  // (search and get) authenticates core to the source over this channel". A
  // source core cannot authenticate itself to is not dialed, and the caller
  // sees the same transport token an unreachable source produces.
  const credential = resolveChannelCredential(row.knowledge_core_credential_ref);
  if (!credential) {
    await auditGet('transport');
    return refuse('transport');
  }
  const channel = channelAuthDialOptions(credential);

  const dialed = await dialKnowledgeSource({
    url: endpoint,
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...(channel.headers ?? {}) },
    allowedNetworks: row.knowledge_allowed_networks ?? [],
    ...(channel.clientCertificate ? { clientCertificate: channel.clientCertificate } : {}),
    maxResponseBytes: payload.v === 2 ? 384 * 1024 : KNOWLEDGE_GET_MAX_BYTES,
    ...(payload.v === 2 ? { timeoutMs: 8000 } : {}),
    ...(options.trustAnchors !== undefined ? { trustAnchors: options.trustAnchors } : {}),
  });
  if (!dialed.ok) {
    await auditGet('transport');
    return refuse(payload.v === 2 ? (dialed.failure === 'timedOut' ? 'source_timed_out' : 'source_unavailable') : 'transport');
  }

  if (payload.v === 2 && [401,403,404].includes(dialed.status)) { await auditGet('source_refused'); return refuse('source_refused'); }
  if (payload.v === 2 && (dialed.status < 200 || dialed.status >= 300)) { await auditGet('transport'); return refuse('source_unavailable'); }
  // ── 7. FIELD-COMPLETE VALIDATION OF THE SOURCE'S ANSWER ──
  let answer: Record<string, unknown>;
  try {
    answer = JSON.parse(dialed.body) as Record<string, unknown>;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('Invalid response');
  } catch {
    await auditGet('source_response_invalid');
    return refuse(payload.v === 2 ? 'source_protocol_error' : 'source_response_invalid');
  }

  if (payload.v === 2) {
    if (dialed.status === 401 || dialed.status === 403 || dialed.status === 404) { await auditGet('source_refused'); return refuse('source_refused'); }
    if (dialed.status < 200 || dialed.status >= 300) { await auditGet('transport'); return refuse('source_unavailable'); }
    if (answer.protocol_version !== 2) {
      await auditGet('source_response_invalid');
      return refuse('source_protocol_error');
    }
    if (answer.status === 'notModified') {
      if (!input.ifNoneMatch) {
        await auditGet('source_response_invalid');
        return refuse('source_protocol_error');
      }
      await auditGet('not_modified'); return { ok: true, notModified: true };
    }
    if (answer.status === 'refused') {
      await auditGet('source_refused');
      return refuse(answer.code === 'content_changed' && continuation ? 'content_changed' : 'source_refused');
    }
    const v2 = validateV2KnowledgeContent(answer, payload, continueFrom, contentHash, pinnedBlock.categories ?? []);
    await auditGet(v2.ok ? 'ok' : v2.refused);
    return v2;
  }

  // §8.3: ONLY the source produces `notModified`, and its contract obliges
  // compartment evaluation strictly BEFORE the comparison. Core forwards
  // `ifNoneMatch` and stores or compares no digests of its own.
  if (answer.notModified === true) {
    if (!input.ifNoneMatch) {
      // A source that answers `notModified` to a request that carried no
      // `ifNoneMatch` is answering a question nobody asked. Out-of-order or
      // simply wrong, it is not a usable answer.
      await auditGet('source_response_invalid');
      return refuse('source_response_invalid');
    }
    await auditGet('not_modified');
    return { ok: true, notModified: true };
  }
  if (answer.refused === true) {
    await auditGet('source_refused');
    return refuse('source_refused');
  }

  const content = answer.content;
  const compartment = answer.compartment;
  const sha256 = answer.sha256;
  if (typeof content !== 'string' || typeof compartment !== 'string' || typeof sha256 !== 'string') {
    await auditGet('source_response_invalid');
    return refuse('source_response_invalid');
  }
  // §7.2's required equality: the label the source returns must be the
  // compartment the handle was sealed with. A source that answers about a
  // different compartment is answering about content the caller never
  // addressed.
  if (compartment !== payload.c) {
    await auditGet('source_response_invalid');
    return refuse('source_response_invalid');
  }

  // Core computes the digest itself and compares it to the source's claim; a
  // source cannot make core agree with a hash it did not earn.
  const computed = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  if (computed !== sha256) {
    await auditGet('source_response_invalid');
    return refuse('source_response_invalid');
  }

  // §8.3's anchor: a continuation must be of the SAME document the caller
  // first saw. `content_changed` is the KF CAS discipline — no splicing two
  // versions into one answer.
  if (continueFrom > 0 && input.contentHash && input.contentHash !== sha256) {
    await auditGet('content_changed');
    return refuse('content_changed');
  }

  await auditGet('ok');
  return {
    ok: true,
    content,
    sha256: computed,
    compartment,
    ...(answer.truncated === true ? { truncated: true } : {}),
  };
}

/** Validate byte-window metadata before releasing any source byte. Partial windows
 * cannot be full-document-hash-verified by core; the satellite owns that proof. */
export function validateV2KnowledgeContent(answer: Record<string, unknown>, payload: KnowledgeHandlePayload, offset: number, contentHash: string | undefined, declaredCategories: readonly string[]): KnowledgeGetResult {
  const invalid = (): KnowledgeGetResult => refuse('source_protocol_error');
  const compartment = answer.compartment as KnowledgeCompartment | null;
  const retrieval = validateRetrieval(answer.retrieval);
  if (answer.status !== 'content' || typeof answer.content_base64 !== 'string' || typeof answer.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(answer.sha256)
    || !compartment || compartment.id !== payload.c || (compartment.label !== undefined && (typeof compartment.label !== 'string' || compartment.label.length > 128))
    || !payload.f?.kinds.includes(answer.contentKind as never) || typeof answer.category !== 'string' || !declaredCategories.includes(answer.category)
    || (payload.f.categories !== undefined && !payload.f.categories.includes(answer.category)) || !retrieval) return invalid();
  const bytes = Buffer.from(answer.content_base64, 'base64');
  if (bytes.toString('base64') !== answer.content_base64 || bytes.length > KNOWLEDGE_GET_MAX_BYTES
    || ![answer.offset, answer.byteLength, answer.totalBytes].every(n => Number.isSafeInteger(n) && Number(n) >= 0)
    || answer.offset !== offset || answer.byteLength !== bytes.length || typeof answer.truncated !== 'boolean') return invalid();
  const total = answer.totalBytes as number;
  const end = offset + bytes.length;
  if ((bytes.length === 0 && (total !== 0 || offset !== 0)) || !Number.isSafeInteger(end) || end > total || (answer.truncated ? bytes.length === 0 || end >= total : end !== total)) return invalid();
  if (contentHash && contentHash !== answer.sha256) return refuse('content_changed');
  if (offset === 0 && !answer.truncated && crypto.createHash('sha256').update(bytes).digest('hex') !== answer.sha256) return invalid();
  return { ok: true, protocol_version: 2, status: 'content', content_base64: answer.content_base64, sha256: answer.sha256,
    offset, byteLength: bytes.length, totalBytes: total, truncated: answer.truncated,
    ...(answer.truncated ? { continuation: sealKnowledgeHandle({ s: payload.s, dv: payload.dv, c: payload.c, r: payload.r, f: payload.f, domain: 'continuation', h: answer.sha256, next: end }) } : {}),
    provenance: { sourceId: payload.s, compartment: { id: compartment.id, ...(compartment.label ? { label: compartment.label } : {}) }, contentKind: answer.contentKind as string, category: answer.category },
    retrieval };
}

/** V2 presentation adds a receipt while the legacy wire remains byte-compatible. */
export async function executeKnowledgeGet(
  req: AuthRequest, input: KnowledgeGetInput,
  options: { issuer: string; callerGroupIds?: readonly string[]; trustAnchors?: string | string[] },
): Promise<KnowledgeGetResult & { protocol_version?: 2; status?: string; code?: string; auditRef?: string }> {
  let v2 = false;
  try { v2 = unsealKnowledgeHandle(input.handle).v === 2; } catch { /* inner owns exact refusal */ }
  const auditRef = v2 ? crypto.randomUUID() : undefined;
  const outcome = await executeKnowledgeGetInner(req, { ...input, ...(auditRef ? { auditRef } : {}) }, options);
  if (!v2) return outcome;
  if (!outcome.ok) return { ...outcome, protocol_version: 2, auditRef, status: 'refused', code: outcome.refused === 'not_authorized' || outcome.refused === 'source_refused' ? 'refused' : outcome.refused };
  if ('notModified' in outcome) return { ...outcome, protocol_version: 2, auditRef, status: 'notModified' };
  return { ...outcome, protocol_version: 2, auditRef, status: 'content' };
}
