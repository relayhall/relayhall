/**
 * KnowledgeProvenanceWrapper.ts — RH-KW1 candidate C (card `0b4b779b`).
 *
 * §7.6's quoting rule, discharged BY CONSTRUCTION for the model-facing
 * rendering of a knowledge search.
 *
 * ── THE RULE, AND WHY IT IS TWO RULES ──
 *
 * §7.6: "no source-authored byte is ever emitted outside a delimited quoted
 * block, AND no wrapper string ever contains a source-authored byte."
 *
 * Both halves matter and they fail differently. A renderer that fences the
 * snippet but interpolates the title into a heading has kept the first half
 * and broken the second; one that builds every label from core values but
 * drops the snippet in raw has done the reverse. So this module has exactly
 * two kinds of string in it:
 *
 *   • WRAPPER strings, built only from CORE-side values — the source's
 *     registry id8 and its `SERVICE_SLUG_PATTERN` slug, the compartment
 *     AFTER §7.2's equality check against the declared list, the sealed
 *     handle (base64url, structurally inert), and core-normalized typed
 *     values (`contentKind`, `score`, `updatedAt`).
 *   • QUOTED blocks, which are the ONLY place a source-authored byte appears,
 *     produced by the shipped fencing mechanisms — `mcp/shape.untrusted` for
 *     free text and `promptTemplate.quotedJsonBlock` for structured values.
 *
 * ── THE VOCABULARY ──
 *
 * The design calls this the **provenance wrapper**. "Envelope" is RESERVED
 * for the S-A4/G-7 authority sense and appears nowhere in this feature (§7.6,
 * and breakdown `abc71ffb` §1).
 *
 * ── THE DECLARED CHANGE THIS FILE FORCED (breakdown finding F1) ──
 *
 * `utils/promptTemplate.ts`'s `quotedJsonBlock` and `quotedMarkdownBlock` were
 * NOT exported, though §2.3 and §7.6 name both as shipped mechanisms this
 * feature applies. Candidate C exports them rather than copying them: a
 * second growing-fence implementation is a second thing to get wrong, and the
 * evidence report says plainly that this is a change to a shipped file, not
 * untouched reuse.
 */
import { untrusted } from '../mcp/shape';
import { quotedJsonBlock } from '../utils/promptTemplate';
import type { KnowledgeCoverage } from './KnowledgeCoverage';
import type { KnowledgeGroup, KnowledgeEmittedResult } from './KnowledgeFanoutExecutor';

/**
 * The provenance label for one source: core-side values only.
 *
 * `id8` is the registry id's first eight characters — the shipped short-id
 * convention — and the slug already satisfies `SERVICE_SLUG_PATTERN`
 * (`ServiceRegistry.ts:42`), so neither can carry a byte a source chose.
 */
export function sourceProvenance(sourceId: string, sourceSlug: string): string {
  return `${sourceSlug} (${sourceId.slice(0, 8)})`;
}

/**
 * One result, rendered.
 *
 * The order is deliberate: the core-owned metadata first, so a reader (human
 * or model) sees WHERE this came from before it sees any source bytes, and
 * the fenced blocks last.
 */
export function renderResult(result: KnowledgeEmittedResult, provenance: string): string {
  const metadata = quotedJsonBlock({
    handle: result.handle,
    compartment: result.compartment,
    contentKind: result.contentKind,
    score: result.score,
    ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
    ...(result.parentHandle ? { parentHandle: result.parentHandle } : {}),
  });
  return [
    `- result from ${provenance}, compartment ${result.compartment}`,
    metadata,
    untrusted(`${provenance} title`, result.title),
    untrusted(`${provenance} snippet`, result.snippet),
  ].join('\n');
}

/** One group, rendered under its own core-authored heading. */
export function renderGroup(group: KnowledgeGroup): string {
  const provenance = sourceProvenance(group.sourceId, group.sourceSlug);
  const heading = `## ${provenance} — ${group.results.length} result(s)`;
  return [heading, ...group.results.map((result) => renderResult(result, provenance))].join('\n');
}

/**
 * The whole response, COVERAGE FIRST.
 *
 * §7.3: "coverage FIRST, then groups (ordering load-bearing: MCP text budget
 * must be able to truncate results, never the honesty record)". This function
 * is where that ordering becomes a property of the emitted TEXT rather than
 * of an object's key order, and acceptance item 7's second clause drills it
 * by budgeting the output and asserting the coverage block survived.
 *
 * The coverage record is entirely core-authored — ids, enum tokens and
 * integers — so quoting it is belt-and-braces rather than a containment
 * requirement. It is quoted anyway: a reader that has to decide which blocks
 * are trustworthy has already lost, and a uniform rule costs nothing.
 */
export function renderKnowledgeResponse(
  coverage: KnowledgeCoverage,
  groups: readonly KnowledgeGroup[],
  auditRef: string,
): string {
  const degraded = coverage.timedOut.length > 0
    || coverage.unavailable.length > 0
    || coverage.refusedBySource.length > 0
    || coverage.refusedByPolicy.length > 0
    || coverage.skipped.length > 0;

  return [
    '# Knowledge search coverage',
    // §7.5: "A degraded answer … is STATED in the tool/page rendering, never
    // silent." The sentence is core's, and it is emitted before the record it
    // describes so a truncating reader cannot lose it.
    degraded
      ? 'Some identity-filtered sources were skipped or unreachable — see the coverage record below.'
      : 'Every source in your queryable set answered.',
    quotedJsonBlock(coverage),
    `audit reference: ${auditRef}`,
    '',
    '# Results',
    ...groups.map(renderGroup),
  ].join('\n');
}
