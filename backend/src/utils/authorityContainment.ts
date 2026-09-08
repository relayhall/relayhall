// authorityContainment.ts — deterministic authority-containment checks
// (RH-P3.AZ-S4, card aa48fb12; AUTHZ design 4d961e37 §6, T2/T4/T23).
//
// Three questions, one conservative algebra:
//   1. mint-time ⊆ (§6.1/§6.2, T2): is the REQUESTED object authority
//      within the requester's CURRENT effective authority?
//   2. ceiling containment (§6.2/§6.3): is the requested authority within a
//      Warrant's pinned ceiling rules?
//   3. edit-down (§6.1): is the approver's edited authority within the
//      originally requested authority?
//
// CONSERVATIVE BY DESIGN: a rule is "covered" only when the covering side
// provably contains it under the ratified selector forms — exact ids
// against pinned lists, all-of-type only under all-of-type/wildcard,
// all-except only when the covering exclusions are a subset of the
// requested exclusions, and all-in-project only when the requested PROJECT
// set is a subset of the covering project set.
//
// The fourth form is where "conservative" earns its keep (RH-AZ.PROJ-b). An
// `all-in-project` source names PROJECTS and an `exact` request names TASKS;
// deciding whether those tasks live in those projects needs rows this pure
// algebra deliberately does not read, so it REFUSES rather than guesses — in
// both directions, source and request. Task-role arms, initiator reads and visibility
// deliberately do NOT count as coverage: they are act-identity/read-time
// arms (AZ-26), not delegable object authority — a request the algebra
// cannot prove contained REFUSES, loudly, per T2. Determinism beats
// cleverness (the sol M8 principle §6.3 applies to selection; the same
// principle governs containment).
import type { GrantVerb, GrantResourceType } from '../services/GrantService';
import { SELECTOR_FORMS, type ProfileRule, type SelectorForm } from '../services/AccessProfileService';

/** One covering source: a wildcard/exact grant row or a profile/own rule. */
export interface AuthoritySource {
  resourceType: GrantResourceType;
  /** 'wildcard' = a grants row with resource_id NULL (typed wildcard). */
  selectorForm: SelectorForm | 'wildcard';
  selectorIds: string[];
  verbs: GrantVerb[];
}

/** Normalize the AccessProfileService.effectiveAccess() shape (grants +
 * profile rules) into containment sources. */
export function sourcesFromEffectiveAccess(effective: {
  grants: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
}): AuthoritySource[] {
  const sources: AuthoritySource[] = [];
  for (const grant of effective.grants) {
    sources.push({
      resourceType: grant.resourceType as GrantResourceType,
      selectorForm: grant.resourceId ? 'exact' : 'wildcard',
      selectorIds: grant.resourceId ? [String(grant.resourceId)] : [],
      verbs: [grant.verb as GrantVerb],
    });
  }
  for (const rule of effective.profiles) {
    sources.push({
      resourceType: rule.resourceType as GrantResourceType,
      selectorForm: rule.selectorForm as AuthoritySource['selectorForm'],
      selectorIds: Array.isArray(rule.selectorIds) ? rule.selectorIds.map(String) : [],
      verbs: Array.isArray(rule.verbs) ? (rule.verbs as GrantVerb[]) : [],
    });
  }
  return sources;
}

export function sourcesFromRules(rules: ProfileRule[]): AuthoritySource[] {
  return rules.map((rule) => ({
    resourceType: rule.resourceType,
    selectorForm: rule.selectorForm,
    selectorIds: [...rule.selectorIds],
    verbs: [...rule.verbs],
  }));
}

/**
 * Does ONE source cover (resourceType, verb, the requested selector)?
 *
 * THE REQUEST FORM IS CHECKED FIRST (round-1 review F1, blocking). Everything
 * below switches on the SOURCE form, and the `wildcard` and `all-of-type` cases
 * answer TRUE immediately — "future-inclusive full width covers every selector
 * shape". That sentence is only true of shapes this algebra KNOWS. The
 * `default` at the bottom protects the source side alone, so a requested rule
 * carrying a form outside the ratified set was reported COVERED beneath any
 * full-width source, before this algebra had decided what the form even means.
 *
 * No presently reachable caller can produce one — every external path runs
 * `validateRules` first — but `rulesCovered` is the containment gate for Agent
 * minting, Approval edit-down, Warrant ceilings and assignment
 * non-escalation, and a reader that admits a form it does not recognise is
 * fail-OPEN whatever today's callers happen to do. A form added to
 * `SELECTOR_FORMS` tomorrow would be admitted here automatically, under the
 * broadest source there is, before anyone had written down its semantics.
 *
 * So: an unrecognised REQUEST form is covered by nothing, exactly as an
 * unrecognised SOURCE form covers nothing.
 */
function sourceCovers(source: AuthoritySource, rule: ProfileRule, verb: GrantVerb): boolean {
  if (source.resourceType !== rule.resourceType) return false;
  if (!source.verbs.includes(verb)) return false;
  if (!(SELECTOR_FORMS as readonly string[]).includes(rule.selectorForm)) return false;
  switch (source.selectorForm) {
    case 'wildcard':
    case 'all-of-type':
      // Future-inclusive full width covers every selector shape.
      return true;
    case 'all-except':
      if (rule.selectorForm === 'exact') {
        // Every requested id must dodge the exclusion list.
        return rule.selectorIds.every((id) => !source.selectorIds.includes(id));
      }
      if (rule.selectorForm === 'all-except') {
        // Containment holds when the covering exclusions are a SUBSET of
        // the requested exclusions (the request excludes at least as much).
        return source.selectorIds.every((id) => rule.selectorIds.includes(id));
      }
      // all-of-type requested under all-except: not contained (the
      // exclusions are missing from the request).
      return false;
    case 'exact':
      // A pinned list covers only exact requests inside it.
      return rule.selectorForm === 'exact'
        && rule.selectorIds.every((id) => source.selectorIds.includes(id));
    case 'all-in-project':
      // A project-bounded source covers a project-bounded request whose
      // perimeter is a SUBSET of its own. It covers nothing else: an `exact`
      // request names object ids and this function reads no rows, so whether
      // those objects live inside the perimeter is unprovable here — and an
      // unprovable request refuses (T2).
      return rule.selectorForm === 'all-in-project'
        && rule.selectorIds.every((id) => source.selectorIds.includes(id));
    default:
      return false;
  }
}

/**
 * Is a requested rule covered by the source set? Verb-by-verb: every
 * requested verb must be covered, though different verbs may be covered by
 * different sources. Within one verb, ONE source must cover the whole
 * selector — deterministic, no cross-source id unions (a request two exact
 * grants jointly cover refuses; split the request instead).
 */
export function ruleCovered(sources: AuthoritySource[], rule: ProfileRule): boolean {
  return rule.verbs.every((verb) => sources.some((source) => sourceCovers(source, rule, verb)));
}

/** Every requested rule covered (empty request = trivially contained). */
export function rulesCovered(sources: AuthoritySource[], rules: ProfileRule[]): { covered: boolean; failing: ProfileRule | null } {
  for (const rule of rules) {
    if (!ruleCovered(sources, rule)) return { covered: false, failing: rule };
  }
  return { covered: true, failing: null };
}

/** Scope-set containment. A NULL ceiling imposes no scope cap here (the
 * mint-time ⊆ check against the requester's effective set still binds). */
export function scopesWithin(ceiling: string[] | null, requested: string[]): { within: boolean; exceeding: string[] } {
  if (ceiling === null) return { within: true, exceeding: [] };
  const exceeding = requested.filter((scope) => !ceiling.includes(scope));
  return { within: exceeding.length === 0, exceeding };
}
