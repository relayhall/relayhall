/**
 * RH-LENSES-b (card 4287af8a) — THE DRILL'S ASSERTIONS, AS NAMED PREDICATES.
 *
 * Build obligation **B-L10b** (design 96f0bd3d §11): *"each control ships at
 * least one red mutation, PROVEN AT BUILD TIME to redden it alone, and a
 * mutation that reddens nothing fails the build. `R-11-v1` needs one mutation
 * per re-derived clause, because its whole claim is that each clause refuses
 * independently."*
 *
 * ── WHY THE ASSERTIONS LIVE HERE AND NOT IN THE DRILL ───────────────────────
 *
 * Two suites need them and they must be the SAME assertions, or the mutation
 * proof is a proof about a copy:
 *
 *  - `lensesCreationDefaultLive.test.ts` drives `POST /projects` through the
 *    PRODUCTION router against a REAL PostgreSQL, collects one `Observation`
 *    per drill case out of the database and the audit ledger, and requires
 *    every named assertion below to be empty. That is the measurement.
 *  - `lensesCreationDefaultMutations.test.ts` takes a GREEN observation set and
 *    corrupts it into the exact state a build carrying one named defect would
 *    have left, then requires that mutation to redden **exactly one** named
 *    assertion. That is the proof that the measurement can fail, and that each
 *    clause is watched by an assertion of its own.
 *
 * Nothing here recomputes the product rule. Every predicate is a statement
 * about what the DATABASE and the LEDGER hold after the act — it cannot be
 * satisfied by a service that agrees with it, only by one that wrote the rows.
 *
 * ── WHY A MUTATED OBSERVATION AND NOT A MUTATED SERVICE ─────────────────────
 *
 * A mutation harness that edited `ProjectService` would be measuring a copy of
 * the service; a harness that injected a seam into the service would be
 * shipping a hole for the drill's convenience. What a defect is OBSERVABLE as
 * is the state it leaves, so the mutations are stated in those terms and the
 * live drill is what binds those states to the real code. Neither half alone
 * carries the guarantee, which is why both are in the gate chain.
 */
import {
  CREATION_DEFAULT_SKIP_REASONS,
  type CreationDefaultSkipReason,
} from '../../services/HomeGroupService';

/** One `grants` row, as the drill reads it back. */
export interface GrantRow {
  granteeType: string;
  granteeId: string;
  resourceType: string;
  resourceId: string | null;
  verb: string;
  origin: string;
  provenance: string | null;
}

/** One `audit_events` row, as the drill reads it back. */
export interface AuditRow {
  action: string;
  outcome: string;
  metadata: Record<string, unknown>;
}

/** What the drill DECLARED the case should produce, before it ran it. */
export type Expectation =
  | { kind: 'apply'; groupId: string }
  | { kind: 'skip'; reason: CreationDefaultSkipReason }
  /**
   * A clause the ordinary route no longer reaches as a skip, because owner
   * contract B refuses the whole create first. `clause` is the re-derived
   * clause the case flipped; `status` and `code` are the answer the contract
   * names. See `assertRefused`.
   */
  | { kind: 'refuse'; clause: CreationDefaultSkipReason; status: number; code: string };

export interface Observation {
  /** The named assertion this case is measured by. */
  assertion: string;
  /** The acting channel, exactly as the middleware resolved it. */
  actor: { authMethod: string; scopes: string[]; principalId: string | null };
  expectation: Expectation;
  /** Null when the act was expected to leave NO project row. */
  projectId: string | null;
  /** Every grants row naming this case's project, of ANY origin. */
  grants: GrantRow[];
  /** Every audit row naming this case's project. */
  audits: AuditRow[];
  /** What the route actually ANSWERED. Carried only by refusal cases, where
   *  the answer is the observation: a refusal nobody read is not a refusal. */
  refusal?: { status: number; code: string };
}

/** The schema facts control R-7 is a statement about. */
export interface SchemaObservation {
  /** `pg_get_constraintdef` of every CHECK on `grants` mentioning `provenance`. */
  provenanceCheckDefs: string[];
  /**
   * Did the REAL constraint refuse an arbitrary, unratified provenance value?
   * `undefined` when the observation was built without a database (the
   * mutation harness); `false` is a failure of R-7 and not an absence.
   */
  arbitraryProvenanceRefused?: boolean;
  /**
   * Which ratified values the REAL constraint ACCEPTED. The vacuity guard: a
   * CHECK admitting nothing at all would satisfy a refusal-only assertion.
   */
  ratifiedProvenanceAccepted?: string[];
  /** Whether `grants_origin_group_only` exists. */
  originGroupOnly: boolean;
  /** Every live `grants` row whose origin is not 'manual'. */
  nonManualRows: GrantRow[];
}

/** The two states R-11-v1 (iv) admits, and nothing between them. */
export interface SerialisationObservation {
  /** TRUE iff `POST /projects` was still unresolved while the writer held the
   *  Group row's lock. FALSE means the act never waited — no lock was taken. */
  blockedWhileHeld: boolean;
  /** What the holder committed: the Group ended `featured` or it did not. */
  featuredAfterHolderCommitted: boolean;
  grants: GrantRow[];
  audits: AuditRow[];
}

const APPLY_VERBS = ['read', 'write'];
const CREATOR_VERBS = ['read', 'write'];

function creationDefaultRows(obs: Observation): GrantRow[] {
  return obs.grants.filter((row) => row.origin === 'creation-default');
}

/**
 * The rows the OTHER policy on this path writes: owner contract B's project
 * creator pair, written by `GrantService.createForProjectCreator` inside the
 * same creating transaction — `granteeType: 'principal'`, the ACTUAL resolved
 * caller, this project, `read` and `write`, origin `manual` (the creator pair
 * is an ordinary revocable assignment) and no provenance.
 *
 * These oracles were written when the creation default was the only writer on
 * the path, so an apply case expected a TOTAL of two rows and a skip case a
 * total of zero. Composing contract B onto the same transaction makes those
 * totals wrong, and the repair is NOT to filter the creator rows out of the
 * observation: a filter would re-open exactly the hole `obs.grants.length !==
 * rows.length` was written to close, because any extra row could be dressed as
 * a creator row. The totals become the EXACT UNION instead — 2 + 2 on an apply
 * case, 0 + 2 on a skip — and every row outside that union is still red.
 *
 * A case whose acting channel resolved NO principal creates no project creator
 * (`ProjectService.create` writes the pair only under `caller?.principalId`),
 * so its expected pair is empty. That is read off the observation's own actor,
 * not chosen by the assertion.
 */
function creatorRows(obs: Observation): GrantRow[] {
  return obs.grants.filter((row) => row.granteeType === 'principal'
    && obs.actor.principalId !== null
    && row.granteeId === obs.actor.principalId
    && row.resourceType === 'project'
    && row.resourceId === obs.projectId);
}

function assertCreatorPair(obs: Observation): { bad: string[]; rows: GrantRow[] } {
  const bad: string[] = [];
  const rows = creatorRows(obs);
  if (obs.actor.principalId === null) {
    if (rows.length !== 0) {
      bad.push(`an acting channel with no resolved principal left ${rows.length} creator rows`);
    }
    return { bad, rows };
  }
  if (rows.length !== 2) {
    bad.push(`expected exactly two project-creator rows for ${obs.actor.principalId}, saw ${rows.length}`);
  } else {
    const verbs = rows.map((row) => row.verb).sort();
    if (JSON.stringify(verbs) !== JSON.stringify(CREATOR_VERBS)) {
      bad.push(`expected creator verbs ${CREATOR_VERBS.join('+')}, saw ${verbs.join('+') || '(none)'}`);
    }
  }
  for (const row of rows) {
    if (row.origin !== 'manual') {
      bad.push(`a project-creator row carries origin '${row.origin}', not 'manual'`);
    }
    if (row.provenance !== null) {
      bad.push(`a project-creator row carries provenance '${row.provenance}'`);
    }
  }
  return { bad, rows };
}

/** Nothing else may name this project. The set is compared by SIZE against the
 *  rows the two policies account for, so a third writer is red however it is
 *  shaped. */
function assertNoUnaccountedRows(obs: Observation, accounted: GrantRow[]): string[] {
  return obs.grants.length === accounted.length ? []
    : [`a grants row outside the creation default and the creator pair names this `
       + `project: ${JSON.stringify(obs.grants)}`];
}

function skipRows(audits: AuditRow[]): AuditRow[] {
  return audits.filter((row) => row.action === 'project.access_default_skip');
}

function applyRows(audits: AuditRow[]): AuditRow[] {
  return audits.filter((row) => row.action === 'project.access_default_apply');
}

/**
 * A-L21 / R-11-v1 (i): a root login session with a resolving home group gets
 * the project AND exactly two rows — read and write, to the GROUP, over this
 * project, stamped `creation-default` — and one apply audit.
 *
 * Composed with owner contract B, the EXACT set over this project is four rows:
 * that group pair plus the creator pair, and nothing else.
 */
export function assertApplied(obs: Observation): string[] {
  const bad: string[] = [];
  if (obs.expectation.kind !== 'apply') return ['assertApplied called on a skip case'];
  if (!obs.projectId) return ['the project row is absent, so the act wrote nothing to measure'];
  const rows = creationDefaultRows(obs);
  if (rows.length !== 2) bad.push(`expected exactly two creation-default rows, saw ${rows.length}`);
  const creator = assertCreatorPair(obs);
  bad.push(...creator.bad);
  bad.push(...assertNoUnaccountedRows(obs, [...rows, ...creator.rows]));
  const verbs = rows.map((row) => row.verb).sort();
  if (JSON.stringify(verbs) !== JSON.stringify(APPLY_VERBS)) {
    bad.push(`expected verbs ${APPLY_VERBS.join('+')}, saw ${verbs.join('+') || '(none)'}`);
  }
  for (const row of rows) {
    if (row.granteeType !== 'group') bad.push(`granteeType is ${row.granteeType}, not group`);
    if (row.granteeId !== obs.expectation.groupId) {
      bad.push(`granteeId is ${row.granteeId}, not the resolved home group ${obs.expectation.groupId}`);
    }
    if (row.resourceType !== 'project') bad.push(`resourceType is ${row.resourceType}, not project`);
    if (row.resourceId !== obs.projectId) {
      bad.push(`resourceId is ${row.resourceId}, not the project this act created`);
    }
    if (row.provenance !== null) bad.push(`a creation-default row carries provenance ${row.provenance}`);
  }
  if (applyRows(obs.audits).length !== 1) {
    bad.push(`expected one project.access_default_apply, saw ${applyRows(obs.audits).length}`);
  }
  if (skipRows(obs.audits).length !== 0) bad.push('an apply case also audited a skip');
  return bad;
}

/**
 * A-L21's atomicity half: with the grant write forced to fail, NOTHING lands —
 * no project row and no grant row. Best-effort attachment is refused.
 */
export function assertAtomicRollback(obs: Observation): string[] {
  const bad: string[] = [];
  if (obs.projectId !== null) bad.push('the project row survived a failed grant write');
  if (obs.grants.length !== 0) bad.push(`${obs.grants.length} grant rows survived the rollback`);
  if (obs.audits.length !== 0) bad.push('an audit row survived the rollback');
  return bad;
}

/**
 * A-L22 / A-L50 / R-11-v1 (ii)+(iii): the act skipped, wrote NO creation-default
 * row, and audited the EXACT declared reason. Composed with owner contract B,
 * the EXACT set over this project is the creator pair and nothing else — two
 * rows where this oracle once required zero, because the skip is a statement
 * about the home-group act, not about every writer on the path.
 *
 * The reason is compared as a string, not merely counted: "some skip was
 * audited" is satisfied by a build that names the wrong clause, and naming the
 * wrong clause is how an operator debugs the wrong thing.
 */
export function assertSkipped(obs: Observation): string[] {
  const bad: string[] = [];
  if (obs.expectation.kind !== 'skip') return ['assertSkipped called on an apply case'];
  if (!obs.projectId) bad.push('the project row is absent: a skip still creates the project');
  const defaults = creationDefaultRows(obs);
  if (defaults.length !== 0) {
    bad.push(`a skip wrote ${defaults.length} creation-default rows: ${JSON.stringify(defaults)}`);
  }
  const creator = assertCreatorPair(obs);
  bad.push(...creator.bad);
  bad.push(...assertNoUnaccountedRows(obs, [...defaults, ...creator.rows]));
  const skips = skipRows(obs.audits);
  if (skips.length !== 1) {
    bad.push(`expected one project.access_default_skip, saw ${skips.length}`);
  } else if (skips[0].metadata.reason !== obs.expectation.reason) {
    bad.push(`the audited reason is '${String(skips[0].metadata.reason)}', not '${obs.expectation.reason}'`);
  }
  if (applyRows(obs.audits).length !== 0) bad.push('a skip case also audited an apply');
  return bad;
}

/**
 * OWNER CONTRACT B, and the C9 composition ruling D1.
 *
 * `GrantService.createForProjectCreator` takes `FOR SHARE` on the creating
 * caller's principal chain and refuses `PROJECT_CREATOR_UNAVAILABLE` when any
 * of it is not `active` - a Project created by a disabled Account, with no
 * read or write on it, is precisely what that check exists to prevent - and
 * that refusal takes the whole creating transaction with it.
 *
 * So on the ordinary route the `actor_inactive` clause is no longer reachable
 * as a SKIP: the request never gets far enough to audit one. The clause is not
 * gone. It stays in `CREATION_DEFAULT_SKIP_REASONS`, it stays derived by
 * `classifyHomeGroup` (drilled directly, on its own, in the mutation harness),
 * and it still governs `GET /principals/me/home-group` and any caller path
 * that creates without a resolved creator. What changed is this route's
 * terminal state, so the drill measures the terminal state it now has.
 *
 * The assertion is that NOTHING survived the refusal - no project, no grant,
 * no audit - and that the answer is the one the contract names rather than
 * merely some 4xx. A case that recorded no answer at all fails: an
 * expectation cannot be its own evidence.
 */
export function assertRefused(obs: Observation): string[] {
  const bad: string[] = [];
  if (obs.expectation.kind !== 'refuse') return ['assertRefused called on a non-refusal case'];
  if (obs.projectId) bad.push(`a refused create left a project row behind: ${obs.projectId}`);
  if (obs.grants.length !== 0) {
    bad.push(`a refused create left ${obs.grants.length} grants rows: ${JSON.stringify(obs.grants)}`);
  }
  if (obs.audits.length !== 0) {
    bad.push(`a refused create left ${obs.audits.length} audit rows: ${JSON.stringify(obs.audits)}`);
  }
  if (!obs.refusal) {
    bad.push('the case recorded no answer: a refusal nobody read is not an observation');
  } else {
    if (obs.refusal.status !== obs.expectation.status) {
      bad.push(`the route answered ${obs.refusal.status}, not ${obs.expectation.status}`);
    }
    if (obs.refusal.code !== obs.expectation.code) {
      bad.push(`the route named '${obs.refusal.code}', not '${obs.expectation.code}'`);
    }
  }
  return bad;
}

/**
 * A-L50's discriminator, asserted over the WHOLE set rather than per case: the
 * bearer half and the non-root-session half must BOTH be present, and both must
 * carry `actor_channel_unavailable`.
 *
 * Without this, a build that tested only `scopes.includes('root')` would pass
 * every per-case assertion for the non-root session and be wrong about the one
 * caller `isBearerCredentialKind` exists to catch.
 */
export function assertChannelDiscriminates(observations: Observation[]): string[] {
  const bad: string[] = [];
  const channelSkips = observations.filter(
    (obs) => obs.expectation.kind === 'skip' && obs.expectation.reason === 'actor_channel_unavailable');
  const bearer = channelSkips.filter((obs) => obs.actor.authMethod === 'principal_api_key');
  const rootBearer = bearer.filter((obs) => obs.actor.scopes.includes('root'));
  const nonRootSession = channelSkips.filter(
    (obs) => obs.actor.authMethod !== 'principal_api_key' && !obs.actor.scopes.includes('root'));
  if (rootBearer.length === 0) {
    bad.push('no case drove a principal_api_key bearer HOLDING root: `root` alone cannot be the test');
  }
  if (nonRootSession.length === 0) {
    bad.push('no case drove a NON-ROOT login session: the session kind alone cannot be the test');
  }
  for (const obs of channelSkips) {
    if (obs.actor.authMethod === 'session' && obs.actor.scopes.includes('root')) {
      bad.push('a ROOT LOGIN SESSION was declared an unavailable channel');
    }
  }
  return bad;
}

/**
 * R-11-v1 (ii)'s independence claim: each of the four re-derived clauses is
 * flipped by a case of its own, and every one of the four reasons is observed.
 * A drill that flipped two clauses at once would prove only that some clause
 * refused.
 */
export function assertEveryClauseDrilledIndependently(observations: Observation[]): string[] {
  const reDerived = CREATION_DEFAULT_SKIP_REASONS.filter((r) => r !== 'actor_channel_unavailable');
  // Ruling D1: a clause the route now REFUSES on is still flipped by a case of
  // its own, on its own row, under the same barrier. The independence claim is
  // about which clause each case flipped, not about how the act ended, so a
  // refusal case discharges its clause exactly as a skip case does - and a
  // clause NO case flipped is still missing, in either shape.
  const seen = new Set(observations.map((obs) => (obs.expectation.kind === 'skip'
    ? obs.expectation.reason
    : obs.expectation.kind === 'refuse' ? obs.expectation.clause : null))
    .filter((reason): reason is CreationDefaultSkipReason => reason !== null));
  const missing = reDerived.filter((reason) => !seen.has(reason));
  return missing.length === 0 ? []
    : [`no case flipped these clauses on their own: ${missing.join(', ')}`];
}

/**
 * R-11-v1 (iv): the `FOR SHARE` blocks. The act either serialises BEFORE the
 * writer (skip) or AFTER its commit (two rows) — never between — and the drill
 * PROVES a lock was taken at all by requiring the request to have been
 * outstanding while the writer held the row.
 */
export function assertSerialised(obs: SerialisationObservation): string[] {
  const bad: string[] = [];
  if (!obs.blockedWhileHeld) {
    bad.push('POST /projects resolved while the Group row was locked: no FOR SHARE was taken');
  }
  const created = obs.grants.filter((row) => row.origin === 'creation-default');
  const applied = obs.audits.some((row) => row.action === 'project.access_default_apply');
  const skipped = obs.audits.some((row) => row.action === 'project.access_default_skip');
  if (applied === skipped) bad.push('the act audited both an apply and a skip, or neither');
  if (obs.featuredAfterHolderCommitted) {
    if (!applied) bad.push('the writer left the Group featured, so the act should have applied');
    if (created.length !== 2) bad.push(`expected two rows after a featured commit, saw ${created.length}`);
  } else {
    if (!skipped) bad.push('the writer cleared featured before the act resolved, so it should have skipped');
    if (created.length !== 0) bad.push(`expected no rows after an unfeatured commit, saw ${created.length}`);
  }
  return bad;
}

/**
 * R-7: the `provenance` collision stays avoided. The CHECK still admits exactly
 * the two assignment values, `grants_origin_group_only` still exists, and no
 * non-manual row carries a provenance — so the rule-4 arm's
 * `assignment-vehicle` internal-writer reason ("provenance IS NOT NULL") still
 * matches no creation-default row.
 */
/**
 * The two values `099:55-59` admits, and the ONLY two. `R-7`'s whole claim is
 * that this set does not grow, so the control compares a SET rather than
 * searching for members of it.
 */
export const RATIFIED_PROVENANCE_VALUES = ['assignment:grant', 'assignment:warrant'];

/**
 * Every single-quoted literal in a constraint definition, in order.
 *
 * `pg_get_constraintdef` renders the CHECK as, e.g.,
 *   CHECK (provenance IS NULL OR provenance = ANY (ARRAY['assignment:grant'::text, ...]))
 * so the admitted domain IS the set of quoted literals. Doubled quotes inside
 * a literal are handled; there are none today, and a parser that silently
 * mishandled one would be a second false green.
 */
export function quotedLiterals(definition: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < definition.length) {
    if (definition[i] !== "'") { i += 1; continue; }
    let value = '';
    i += 1;
    while (i < definition.length) {
      if (definition[i] === "'") {
        if (definition[i + 1] === "'") { value += "'"; i += 2; continue; }
        i += 1; break;
      }
      value += definition[i]; i += 1;
    }
    out.push(value);
  }
  return out;
}

export function assertProvenanceCollisionAvoided(schema: SchemaObservation): string[] {
  const bad: string[] = [];
  if (schema.provenanceCheckDefs.length === 0) {
    bad.push('no CHECK on grants mentions provenance: 099:55-59 is gone');
  }
  for (const def of schema.provenanceCheckDefs) {
    // THE SET, not two substrings and a forbidden list (round-1 review
    // finding B3). A list of values that must not appear is satisfied by the
    // next value nobody thought to forbid, which is exactly how this control
    // was green for `'unexpected-third-value'`. The admitted domain is
    // EXTRACTED and COMPARED, so any widening at all is red.
    const admitted = quotedLiterals(def)
      .filter((value) => value !== '')
      .sort();
    const expected = [...RATIFIED_PROVENANCE_VALUES].sort();
    if (JSON.stringify(admitted) !== JSON.stringify(expected)) {
      bad.push(
        `the provenance CHECK admits {${admitted.join(', ')}}, not exactly `
        + `{${expected.join(', ')}}: ${def}`);
    }
  }
  // The REAL constraint's own answer, when the drill measured it: an
  // arbitrary third token must be REFUSED by PostgreSQL. A definition this
  // build parsed is a string; this is the database.
  if (schema.arbitraryProvenanceRefused === false) {
    bad.push('PostgreSQL ACCEPTED an unratified provenance value: the CHECK is not the closure');
  }
  for (const value of RATIFIED_PROVENANCE_VALUES) {
    if (schema.ratifiedProvenanceAccepted && !schema.ratifiedProvenanceAccepted.includes(value)) {
      // The control is not vacuous by refusing everything: a CHECK that
      // admitted NOTHING would pass a refusal-only assertion perfectly.
      bad.push(`PostgreSQL refused the ratified provenance value '${value}'`);
    }
  }
  if (!schema.originGroupOnly) bad.push('grants_origin_group_only is gone (A-L23 has no closure)');
  for (const row of schema.nonManualRows) {
    if (row.provenance !== null) {
      bad.push(`an origin='${row.origin}' row carries provenance '${row.provenance}'`);
    }
  }
  return bad;
}

/** A-L23: no non-manual origin may name a PRINCIPAL grantee. */
export function assertNoPrincipalGranteeOffManual(rows: GrantRow[]): string[] {
  return rows
    .filter((row) => row.origin !== 'manual' && row.granteeType !== 'group')
    .map((row) => `origin='${row.origin}' names a ${row.granteeType} grantee`);
}

/**
 * The whole assertion set, by NAME. The live drill requires every entry to be
 * empty; the mutation harness requires each mutation to make exactly one
 * non-empty.
 */
export interface DrillInput {
  cases: Observation[];
  schema: SchemaObservation;
  serialisation: SerialisationObservation;
  allGrantRows: GrantRow[];
}

export function assertionSet(input: DrillInput): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const obs of input.cases) {
    if (out[obs.assertion]) {
      out[obs.assertion] = [...out[obs.assertion], `duplicate case name '${obs.assertion}'`];
      continue;
    }
    if (obs.assertion === 'apply:atomic') out[obs.assertion] = assertAtomicRollback(obs);
    else if (obs.expectation.kind === 'apply') out[obs.assertion] = assertApplied(obs);
    else if (obs.expectation.kind === 'refuse') out[obs.assertion] = assertRefused(obs);
    else out[obs.assertion] = assertSkipped(obs);
  }
  out['channel:discriminates'] = assertChannelDiscriminates(input.cases);
  out['clauses:independent'] = assertEveryClauseDrilledIndependently(input.cases);
  out['forShare:serialisation'] = assertSerialised(input.serialisation);
  out['R-7:provenance'] = assertProvenanceCollisionAvoided(input.schema);
  out['A-L23:group-grantee-only'] = assertNoPrincipalGranteeOffManual(input.allGrantRows);
  return out;
}

/** The names every drill run must carry. A case silently renamed or dropped
 *  would otherwise leave its assertion vacuously absent rather than red. */
export const REQUIRED_ASSERTIONS = [
  'apply:two-rows',
  'apply:atomic',
  'skip:no_home_group',
  'skip:not_featured',
  'skip:not_a_member',
  // Ruling D1: the clause is drilled as contract B's REFUSAL, and the name
  // says so - a case named `skip:` that observed a 409 would be the kind of
  // quiet re-interpretation this register exists to prevent.
  'refuse:actor_inactive',
  'skip:actor_channel_unavailable:bearer',
  'skip:actor_channel_unavailable:non-root-session',
  'channel:discriminates',
  'clauses:independent',
  'forShare:serialisation',
  'R-7:provenance',
  'A-L23:group-grantee-only',
] as const;
