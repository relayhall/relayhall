// KnowledgeSourceService.ts — RH-KW1 candidate A (card `0b4b779b`).
//
// Limb (a) of the §5.5 fan-out predicate: which registered Services are
// KNOWLEDGE-CAPABLE right now. Limbs (b) and (c) — source visibility under the
// shared predicate, and `knowledge-contents:read` grant/selector coverage over
// the source — are the SHIPPED object-authority seam and are composed by the
// caller of this service, named limb by limb, in `routes/knowledge.ts`.
//
// §5.1 is explicit that this is not a new authority mechanism: "S-A7 item 2's
// 'no new grant resource type': source visibility and service grants are
// untouched; the scope+selector is the A18-precedented addition layered on
// them." So there is no second predicate here, and no copy of the shared one.
//
// Contract: KNOWLEDGE-DESIGN v1.4 `94747de9` §4.2, §4.3, §5.5, §9.

import { pool } from '../db/connection';
import {
  isKnowledgeCapable,
  KNOWLEDGE_BOARD_SOURCE_SLUG,
  type KnowledgeClaimsMode,
  type KnowledgeSubjectMode,
} from './KnowledgeSourcePolicy';
import type { DescriptorKnowledgeClass, ServiceDescriptor } from '../utils/serviceDescriptor';

/**
 * What a caller learns about a source it may query.
 *
 * Deliberately NOT here: the dialed endpoints, the core credential reference,
 * `knowledge_allowed_networks` and `knowledge_relevant_groups`. The first two
 * are owner-plane operational configuration and the last two would disclose
 * estate topology — group ids in particular — to every holder of
 * `knowledge-contents:read`. `claimsMode` and `subjectMode` ARE here because
 * §5.3 makes what a source learns about the caller a STANDING DISCLOSURE that
 * §6.3 leads with: a caller is entitled to know whether querying this source
 * discloses their identity context, and under which pseudonym discipline.
 */
export interface KnowledgeSourceSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** §9's reserved in-process pseudo-source, which dials nothing. */
  inProcess: boolean;
  claimsMode: KnowledgeClaimsMode;
  subjectMode: KnowledgeSubjectMode;
  classes: DescriptorKnowledgeClass[];
  compartments: string[];
}

interface CandidateRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  knowledge_query_endpoint: string | null;
  knowledge_claims_mode: KnowledgeClaimsMode;
  knowledge_subject_mode: KnowledgeSubjectMode;
  descriptor: ServiceDescriptor | null;
}

export class KnowledgeSourceService {
  /**
   * **Limb (a) of §5.5: "knowledge-configured".**
   *
   * The SQL below is a bounded PREFILTER, not a second statement of the
   * capability predicate. It is a deliberate strict SUPERSET of the predicate
   * — every row the predicate can admit passes it, and rows it cannot admit
   * may also pass — so the decision is taken in exactly one place,
   * `isKnowledgeCapable`. A row with an endpoint but no descriptor block
   * passes this WHERE clause and is REFUSED by the predicate; that is the
   * fail-closed reading of §4.2's "no half-configured state can exist", and
   * it is drilled by writing that state directly to the row.
   *
   * Retired Services are excluded: a retired row is not a live source, and
   * §5.2's arm set re-evaluates "source knowledge configuration live" before
   * every signing.
   */
  async listKnowledgeCapableSources(): Promise<KnowledgeSourceSummary[]> {
    const result = await pool.query(
      `SELECT s.id, s.slug, s.name, s.description,
              s.knowledge_query_endpoint,
              s.knowledge_claims_mode, s.knowledge_subject_mode,
              v.descriptor
         FROM services s
         LEFT JOIN service_descriptor_versions v
           ON v.service_id = s.id AND v.version = s.current_descriptor_version
        WHERE s.retired_at IS NULL
          AND s.status <> 'retired'
          AND (s.knowledge_query_endpoint IS NOT NULL OR s.slug = $1)
        ORDER BY s.slug`,
      [KNOWLEDGE_BOARD_SOURCE_SLUG],
    );

    const sources: KnowledgeSourceSummary[] = [];
    for (const row of result.rows as CandidateRow[]) {
      const block = row.descriptor?.knowledgeSource ?? null;
      if (!isKnowledgeCapable({ slug: row.slug, knowledgeQueryEndpoint: row.knowledge_query_endpoint }, block)) {
        continue;
      }
      sources.push({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        inProcess: row.slug === KNOWLEDGE_BOARD_SOURCE_SLUG,
        claimsMode: row.knowledge_claims_mode,
        subjectMode: row.knowledge_subject_mode,
        classes: block?.classes ?? [],
        compartments: block?.compartments ?? [],
      });
    }
    return sources;
  }
}

export const knowledgeSourceService = new KnowledgeSourceService();
