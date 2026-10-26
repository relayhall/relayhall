import crypto from 'crypto';
import type { KnowledgeContentKind } from '../utils/serviceDescriptor';

export const CATEGORY_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9._-]*$/;
export const OPAQUE_COMPARTMENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface KnowledgeFilter { version: 2; kinds: KnowledgeContentKind[]; categories?: string[] }
export interface KnowledgeCompartment { id: string; label?: string }
export const RETRIEVAL_REASONS = ['store-unavailable', 'deadline', 'acl-stale', 'ingest-stale'] as const;
export type RetrievalReason = typeof RETRIEVAL_REASONS[number];
export interface RetrievalStatus { status: 'complete' | 'partial'; reasons: RetrievalReason[] }
/**
 * Card 3e0ae06e: which budget a source's `deadline` reason belongs to —
 * `caller_deadline` the `budget_ms` core sent, `source_deadline` the source's
 * own default (it was sent none). Optional on the wire, never a fifth reason.
 */
export const DEADLINE_FIRED = ['caller_deadline', 'source_deadline'] as const;
export type DeadlineFired = typeof DEADLINE_FIRED[number];
export class KnowledgeSelectorError extends Error {
  constructor(public code: string, public status = 400, public readonly auditRef?: string) { super(code === 'SOURCE_SELECTION_TOO_BROAD' ? 'Narrow the authorized source selection to at most 16 sources.' : 'Invalid knowledge selector'); }
}
export function normalizeKnowledgeFilter(kinds: readonly KnowledgeContentKind[], categories?: readonly string[]): KnowledgeFilter {
  return { version: 2, kinds: [...new Set(kinds)].sort(), ...(categories === undefined ? {} : { categories: [...new Set(categories)].sort() }) };
}
export function knowledgeFilterHash(filter: KnowledgeFilter): string {
  // ASCII-only RFC8785 subset; object keys sorted, selected values normalized.
  const canonical = JSON.stringify({ ...(filter.categories ? { categories: filter.categories } : {}), kinds: filter.kinds, version: 2 });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
export function validKnowledgeFilter(value: unknown): value is KnowledgeFilter {
  const f = value as KnowledgeFilter;
  if (!f || f.version !== 2 || !Array.isArray(f.kinds) || !f.kinds.length || f.kinds.length > 3 || !f.kinds.every(k => ['code','docs','data'].includes(k))) return false;
  if (f.categories !== undefined && (!Array.isArray(f.categories) || !f.categories.length || f.categories.length > 32 || !f.categories.every(c => typeof c === 'string' && c.length <= 128 && CATEGORY_PATTERN.test(c)))) return false;
  const normalized = normalizeKnowledgeFilter(f.kinds, f.categories);
  return JSON.stringify(f.kinds) === JSON.stringify(normalized.kinds) && JSON.stringify(f.categories) === JSON.stringify(normalized.categories);
}
export function validateRetrieval(value: unknown): RetrievalStatus | null {
  const v = value as RetrievalStatus;
  if (!v || !['complete','partial'].includes(v.status) || !Array.isArray(v.reasons) || v.reasons.length > 4 || new Set(v.reasons).size !== v.reasons.length || !v.reasons.every(r => RETRIEVAL_REASONS.includes(r))) return null;
  if ((v.status === 'complete') !== (v.reasons.length === 0)) return null;
  return { status: v.status, reasons: [...v.reasons] };
}
/**
 * The request keys of `selector-v2.schema.json#/$defs/query`, and nothing else.
 * `includeArchive` is selector amendment v1.2 (card 40e0e542, owner ruling
 * E127 (5)): the caller's opt-in to the archive categories a source declares.
 * The schema pin suite compares this list with the schema's own property set.
 */
export const V2_QUERY_KEYS = ['protocol_version', 'q', 'sources', 'kinds', 'categories', 'limitPerSource', 'timeoutMs', 'includeArchive'] as const;
export function normalizeV2Query(body: Record<string, unknown>): { kinds: KnowledgeContentKind[]; sources?: string[]; categories?: string[]; includeArchive?: true } {
  if (Object.keys(body).some(k => !(V2_QUERY_KEYS as readonly string[]).includes(k))) throw new KnowledgeSelectorError('INVALID_SELECTOR');
  if (body.includeArchive !== undefined && typeof body.includeArchive !== 'boolean') throw new KnowledgeSelectorError('INVALID_SELECTOR');
  if (Buffer.byteLength(JSON.stringify(body)) > 65536) throw new KnowledgeSelectorError('INVALID_SELECTOR');
  for (const [key, minimum, maximum] of [['limitPerSource', 1, 25], ['timeoutMs', 500, 8000]] as const) {
    if (body[key] !== undefined && (!Number.isInteger(body[key]) || Number(body[key]) < minimum || Number(body[key]) > maximum)) throw new KnowledgeSelectorError('INVALID_SELECTOR');
  }
  const out: { kinds: KnowledgeContentKind[]; sources?: string[]; categories?: string[]; includeArchive?: true } = { kinds: ['code','data','docs'], ...(body.includeArchive === true ? { includeArchive: true as const } : {}) };
  for (const dimension of ['kinds','sources','categories'] as const) {
    const raw = body[dimension]; if (raw === undefined) continue;
    if (!Array.isArray(raw) || !raw.length || raw.length > 256 || !raw.every(x => typeof x === 'string')) throw new KnowledgeSelectorError('INVALID_SELECTOR');
    const values = [...new Set(raw as string[])].sort();
    const valid = dimension === 'kinds' ? values.every(x => ['code','docs','data'].includes(x)) : dimension === 'sources' ? values.every(x => OPAQUE_COMPARTMENT_PATTERN.test(x)) : values.every(x => x.length <= 128 && CATEGORY_PATTERN.test(x));
    if (!valid || values.length > (dimension === 'sources' ? 16 : dimension === 'categories' ? 32 : 3)) throw new KnowledgeSelectorError('INVALID_SELECTOR');
    if (dimension === 'kinds') out.kinds = values as KnowledgeContentKind[]; else out[dimension] = values;
  }
  return out;
}

/**
 * THE DEFAULT SCOPE — card 40e0e542, owner ruling E127 (5): searches cover
 * current knowledge by default, and a source's ARCHIVE categories are searched
 * only when the caller opts in.
 *
 * `includeArchive` is NEVER authority and never leaves the core. It decides one
 * thing: whether the categories a source declares as archive
 * (`knowledgeSource.archiveCategories`, a validated subset of its declared
 * `categories`) are SUBTRACTED from the categories that source is asked to
 * search. Categories AND with authority at the source (amendment v1.1 §2), so
 * a subtraction can only narrow and stopping it restores exactly the request
 * the caller could already make — the flag grants nothing.
 *
 *   - opted in, or a source that declares no archive: the requested categories,
 *     unchanged (`undefined` when the request named none);
 *   - otherwise: (requested ?? declared) minus the archive, sorted. An EMPTY
 *     result means nothing current is left to search, and the executor skips
 *     the source with the existing reason `categories`.
 */
export function scopedSourceCategories(input: {
  requested?: readonly string[];
  declared?: readonly string[];
  archive?: readonly string[];
  includeArchive: boolean;
}): string[] | undefined {
  if (input.includeArchive || !input.archive?.length) return input.requested === undefined ? undefined : [...input.requested];
  const archive = new Set(input.archive);
  return [...new Set(input.requested ?? input.declared ?? [])].filter((category) => !archive.has(category)).sort();
}
