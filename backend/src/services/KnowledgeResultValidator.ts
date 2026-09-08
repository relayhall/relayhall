/**
 * KnowledgeResultValidator.ts — RH-KW1 candidate C (card `0b4b779b`).
 *
 * §7.2's CORE-SIDE VALIDATION OF EVERY FIELD, applied to whatever a source
 * chose to answer with.
 *
 * ── THE RULE, VERBATIM ──
 *
 * §7.2: "Core-side validation of EVERY field (a result failing any check is
 * dropped; a source with any dropped result named in
 * `coverage.invalidResults`): `ref`/`parentRef` ≤512 printable-ASCII, no
 * backticks/angle brackets, else reject; `title` fenced (§7.6); `snippet`
 * ≤500 then fenced; `contentKind` MUST be one of the request's `kinds` else
 * reject; `compartment` REQUIRED and equality-matched to the declared list
 * (§6.1) else reject; `score` clamped to a core float in [0,1]; `updatedAt`
 * core-parsed ISO or dropped; per-source result count hard-capped at `limit`
 * (excess dropped, source named in `coverage.truncatedResults`);
 * whole-response byte budget enforced; every surviving `ref` SEALED into a
 * content handle (§8.1)."
 *
 * ── DROP versus CLAMP versus TRUNCATE, and why the difference matters ──
 *
 * Three different dispositions appear in that paragraph and conflating them
 * would be a defect in either direction:
 *
 *   • DROP (`ref`, `parentRef`, `contentKind`, `compartment`, and a
 *     structurally wrong result) — the field carries meaning core cannot
 *     repair. A dropped result names its source in `invalidResults`.
 *   • CLAMP / NORMALIZE (`score`, `updatedAt`, `snippet` length) — core owns
 *     the value's form; a source's `score` of 9 or its "yesterday" timestamp
 *     is not a reason to hide a result the caller can use. These do NOT set
 *     `invalidResults`, because nothing was dropped.
 *   • TRUNCATE (result count over `limit`) — the RESULTS were dropped for
 *     volume, not for validity, and §7.3's modifiers keep the two apart:
 *     `truncatedResults`, never `invalidResults` (sol R1-5, R2-4).
 *
 * ── THE MIXED-RESPONSE RULE (R1-5, R2-4) ──
 *
 * "one valid + one hostile ⇒ the valid returned, the hostile dropped,
 * `answered` + `invalidResults` exactly". A source that sends one bad result
 * does not lose its good ones, and an all-dropped response is still
 * `answered` — with an empty group and `invalidResults` naming it.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ──
 *
 * It does not FENCE. §7.6's growing-fence mechanisms are applied where text
 * is rendered into model-facing or page-facing positions, and applying them
 * here would store fenced bytes in the response shape, where a second render
 * would fence them again. It validates and normalizes; the rendering surfaces
 * quote (candidate D's item-4 drills prove that half, through those
 * surfaces).
 */
import { KNOWLEDGE_CONTENT_KINDS, type KnowledgeContentKind } from '../utils/serviceDescriptor';

/** §7.2: `ref`/`parentRef` ≤512 printable-ASCII, no backticks/angle brackets. */
export const KNOWLEDGE_REF_MAX_LENGTH = 512;
/** §7.2: `snippet` ≤500 then fenced. */
export const KNOWLEDGE_SNIPPET_MAX_LENGTH = 500;
/** Core's own bound on a title. Normalized, never a drop reason. */
export const KNOWLEDGE_TITLE_MAX_LENGTH = 500;
/** §7.2's whole-response byte budget, per source. */
export const KNOWLEDGE_RESPONSE_MAX_BYTES = 256 * 1024;

/**
 * A result that survived every check, with core-owned values in every field.
 *
 * `ref` and `parentRef` are still RAW here: they are sealed into handles by
 * the fan-out executor, which owns the sealing keys, and §7.6's "never
 * emitted raw" is a property of what leaves core, not of this intermediate.
 */
export interface ValidatedKnowledgeResult {
  ref: string;
  title: string;
  snippet: string;
  contentKind: KnowledgeContentKind;
  compartment: string;
  score: number;
  updatedAt?: string;
  parentRef?: string;
}

export interface ValidationInput {
  /** Whatever the source sent, unexamined. */
  raw: unknown;
  /** The request's `kinds` — `contentKind` must be one of these. */
  requestedKinds: readonly KnowledgeContentKind[];
  /** The source's DECLARED compartments (§6.1), equality-matched. */
  declaredCompartments: readonly string[];
  /** `limitPerSource`. */
  limit: number;
}

export interface ValidationOutcome {
  results: ValidatedKnowledgeResult[];
  /** At least one result was DROPPED for validity ⇒ `invalidResults`. */
  invalid: boolean;
  /** Results were dropped for VOLUME ⇒ `truncatedResults`. */
  truncated: boolean;
}

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const FORBIDDEN_IN_REF = /[`<>]/;

function validRef(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= KNOWLEDGE_REF_MAX_LENGTH
    && PRINTABLE_ASCII.test(value)
    && !FORBIDDEN_IN_REF.test(value);
}

/** §7.2: "`score` clamped to a core float in [0,1]". */
function clampScore(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

/** §7.2: "`updatedAt` core-parsed ISO or dropped" — the FIELD, not the result. */
function parseUpdatedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Validate ONE source's answer.
 *
 * The `truncated` flag the source itself may send is NOT trusted as the
 * modifier: §7.3's `truncatedResults` states what CORE dropped, and a source
 * claiming truncation it did not perform would otherwise write core's honesty
 * record for it. A source's own flag is ignored here; core's count decides.
 */
export function validateSourceResults(input: ValidationInput): ValidationOutcome {
  const raw = input.raw as { results?: unknown } | null | undefined;
  const rawResults = Array.isArray(raw?.results) ? (raw as { results: unknown[] }).results : null;
  if (rawResults === null) {
    // A response with no `results` array is not a valid envelope at all. The
    // caller decides what that means for the outcome bucket; here it is
    // simply zero results with nothing dropped for validity.
    return { results: [], invalid: false, truncated: false };
  }

  const kinds = new Set(input.requestedKinds);
  const declared = new Set(input.declaredCompartments);
  const results: ValidatedKnowledgeResult[] = [];
  let invalidCount = 0;
  let bytes = 0;
  // Set only when a row was dropped for VOLUME — the cap or the byte budget —
  // with rows still remaining. That is the entire condition for
  // `truncatedResults`, and keeping it as one flag written at two places is
  // why an all-invalid response can never set it.
  let stoppedForVolume = false;

  // The per-source cap is applied to the results core ACCEPTS, so a source
  // cannot spend the cap on rejects and hide its valid rows behind them.
  for (const entry of rawResults) {
    if (results.length >= input.limit) { stoppedForVolume = true; break; }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      invalidCount += 1;
      continue;
    }
    const row = entry as Record<string, unknown>;

    if (!validRef(row.ref)) { invalidCount += 1; continue; }
    if (row.parentRef !== undefined && row.parentRef !== null && !validRef(row.parentRef)) {
      invalidCount += 1; continue;
    }
    if (typeof row.title !== 'string') { invalidCount += 1; continue; }
    if (row.snippet !== undefined && row.snippet !== null && typeof row.snippet !== 'string') {
      invalidCount += 1; continue;
    }
    // §7.2: "`contentKind` MUST be one of the request's `kinds` else reject".
    // Two conjuncts, not one: it must be a kind AT ALL (a source cannot mint
    // vocabulary), and it must be one the request asked for.
    if (typeof row.contentKind !== 'string'
      || !(KNOWLEDGE_CONTENT_KINDS as readonly string[]).includes(row.contentKind)
      || !kinds.has(row.contentKind as KnowledgeContentKind)) {
      invalidCount += 1; continue;
    }
    // §7.2: "`compartment` REQUIRED and equality-matched to the declared list".
    // Equality, never prefix and never case-folded: the declared list is the
    // vocabulary, and a near-match is a different compartment.
    if (typeof row.compartment !== 'string' || !declared.has(row.compartment)) {
      invalidCount += 1; continue;
    }

    const title = row.title.length > KNOWLEDGE_TITLE_MAX_LENGTH
      ? row.title.slice(0, KNOWLEDGE_TITLE_MAX_LENGTH)
      : row.title;
    const snippetRaw = typeof row.snippet === 'string' ? row.snippet : '';
    const snippet = snippetRaw.length > KNOWLEDGE_SNIPPET_MAX_LENGTH
      ? snippetRaw.slice(0, KNOWLEDGE_SNIPPET_MAX_LENGTH)
      : snippetRaw;
    const updatedAt = parseUpdatedAt(row.updatedAt);

    const validated: ValidatedKnowledgeResult = {
      ref: row.ref,
      title,
      snippet,
      contentKind: row.contentKind as KnowledgeContentKind,
      compartment: row.compartment,
      score: clampScore(row.score),
      ...(updatedAt ? { updatedAt } : {}),
      ...(typeof row.parentRef === 'string' ? { parentRef: row.parentRef } : {}),
    };

    // The whole-response byte budget. Exceeding it drops the REST of the
    // results for volume, which is a truncation, not an invalidity.
    bytes += Buffer.byteLength(JSON.stringify(validated), 'utf8');
    if (bytes > KNOWLEDGE_RESPONSE_MAX_BYTES) { stoppedForVolume = true; break; }

    results.push(validated);
  }

  // §7.3, sol R1-5/R2-4: "all-dropped ⇒ answered + invalidResults with an
  // empty group; `truncatedResults` ONLY if an independent over-limit drop
  // also occurred". `stoppedForVolume` is that independent drop, and nothing
  // else sets it — so a response whose extra rows were all INVALID reports
  // `invalidResults` alone, and a response that hit the cap with valid rows
  // still waiting reports `truncatedResults`.
  return { results, invalid: invalidCount > 0, truncated: stoppedForVolume };
}
