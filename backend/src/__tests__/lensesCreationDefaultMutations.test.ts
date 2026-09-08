/**
 * RH-LENSES-b (card 4287af8a) — THE RED MUTATIONS, PROVEN AT BUILD TIME.
 *
 * Build obligation **B-L10b**: controls `R-7` and `R-11-v1` each ship at least
 * one red mutation, *"proven at build time to redden that control while every
 * other control in the drill stays green; a mutation that reddens nothing is a
 * build failure"*, and `R-11-v1` needs **one per re-derived clause** because
 * its whole claim is that each clause refuses independently.
 *
 * The design record deliberately names none of them (`[R6-Q2]`, annex §A8):
 * three generations of prose mutations shipped defects, two of which could not
 * redden anything at all, so the enumeration moved to the build where whether a
 * mutation reddens is a fact that can be measured instead of asserted.
 *
 * ── WHAT A MUTATION IS HERE ────────────────────────────────────────────────
 *
 * A DEFECT is a thing a build of `ProjectService.applyCreationDefault` could
 * get wrong. Each defect leaves an observable STATE — the rows in `grants` and
 * `audit_events` after the act — and each mutation below is that state,
 * written out. The harness then requires the drill's named assertion for that
 * clause to go RED and **every other named assertion to stay green**.
 *
 * That is the property `B-L10b` asks for, and it is the property three earlier
 * rounds of prose could not establish: not "this mutation looks bad" but
 * "exactly one assertion notices it". A defect two assertions notice is a
 * defect one of them is not needed for; a defect no assertion notices is a hole
 * in the drill.
 *
 * ── WHY THIS FILE IS NOT THE MEASUREMENT ───────────────────────────────────
 *
 * It proves the drill's assertions DISCRIMINATE. It proves nothing about the
 * product: `lensesCreationDefaultLive.test.ts` binds these same assertions to
 * the real service, the production router and a real PostgreSQL. Neither half
 * alone carries the guarantee, which is why both are in the gate chain and why
 * the assertions are imported from one module rather than written twice.
 */
import fs from 'fs';
import path from 'path';
import {
  RATIFIED_PROVENANCE_VALUES,
  REQUIRED_ASSERTIONS,
  assertProvenanceCollisionAvoided,
  assertionSet,
  quotedLiterals,
  type DrillInput,
  type GrantRow,
  type Observation,
  type SerialisationObservation,
} from './acceptance/lensesDrillOracles';
import {
  CREATION_DEFAULT_SKIP_REASONS,
  HOME_GROUP_UNRESOLVED_REASONS,
  classifyHomeGroup,
  decideCreationDefault,
  isCreationDefaultSkipReason,
  isRootLoginSessionActor,
  type HomeGroupState,
} from '../services/HomeGroupService';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const ROOT = '33333333-3333-4333-8333-333333333333';

const grant = (verb: string): GrantRow => ({
  granteeType: 'group', granteeId: GROUP, resourceType: 'project',
  resourceId: PROJECT, verb, origin: 'creation-default', provenance: null,
});

/**
 * Owner contract B's project creator pair, written by
 * `GrantService.createForProjectCreator` inside the SAME creating transaction
 * as the home-group act. Every case whose acting channel resolved a principal
 * leaves these two rows, whether the home-group act applied or skipped, so the
 * baseline carries them: a fixture that still said "a skip leaves zero rows"
 * would be measuring a build that no longer exists.
 */
const creatorGrant = (verb: string): GrantRow => ({
  granteeType: 'principal', granteeId: ROOT, resourceType: 'project',
  resourceId: PROJECT, verb, origin: 'manual', provenance: null,
});
const creatorPair = (): GrantRow[] => [creatorGrant('read'), creatorGrant('write')];

const applied = (): Observation => ({
  assertion: 'apply:two-rows',
  actor: { authMethod: 'session', scopes: ['root'], principalId: ROOT },
  expectation: { kind: 'apply', groupId: GROUP },
  projectId: PROJECT,
  grants: [grant('read'), grant('write'), ...creatorPair()],
  audits: [{
    action: 'project.access_default_apply', outcome: 'success',
    metadata: { projectId: PROJECT, groupId: GROUP, verbs: ['read', 'write'] },
  }],
});

/**
 * Ruling D1: on the ordinary route owner contract B refuses a DISABLED
 * creating Account outright, so `actor_inactive` is drilled as a REFUSAL that
 * leaves nothing behind rather than as a skip that leaves the project and the
 * creator pair. The clause's own derivation is still drilled directly, on
 * `classifyHomeGroup`, in section 5 below.
 */
const refused = (): Observation => ({
  assertion: 'refuse:actor_inactive',
  actor: { authMethod: 'session', scopes: ['root'], principalId: ROOT },
  expectation: { kind: 'refuse', clause: 'actor_inactive', status: 409, code: 'PROJECT_CREATOR_UNAVAILABLE' },
  refusal: { status: 409, code: 'PROJECT_CREATOR_UNAVAILABLE' },
  projectId: null, grants: [], audits: [],
});

const skipped = (assertion: string, reason: string, actor?: Observation['actor']): Observation => ({
  assertion,
  actor: actor ?? { authMethod: 'session', scopes: ['root'], principalId: ROOT },
  expectation: { kind: 'skip', reason: reason as any },
  projectId: PROJECT,
  grants: creatorPair(),
  audits: [{ action: 'project.access_default_skip', outcome: 'success', metadata: { reason } }],
});

/** The GREEN baseline: every drill case as a correct build leaves it. */
function greenInput(): DrillInput {
  const cases: Observation[] = [
    applied(),
    {
      assertion: 'apply:atomic',
      actor: { authMethod: 'session', scopes: ['root'], principalId: ROOT },
      expectation: { kind: 'apply', groupId: GROUP },
      projectId: null, grants: [], audits: [],
    },
    skipped('skip:no_home_group', 'no_home_group'),
    skipped('skip:not_featured', 'not_featured'),
    skipped('skip:not_a_member', 'not_a_member'),
    refused(),
    skipped('skip:actor_channel_unavailable:bearer', 'actor_channel_unavailable',
      { authMethod: 'principal_api_key', scopes: ['root'], principalId: ROOT }),
    skipped('skip:actor_channel_unavailable:non-root-session', 'actor_channel_unavailable',
      { authMethod: 'session', scopes: ['projects:write'], principalId: ROOT }),
  ];
  const serialisation: SerialisationObservation = {
    blockedWhileHeld: true,
    featuredAfterHolderCommitted: false,
    grants: [],
    audits: [{ action: 'project.access_default_skip', outcome: 'success', metadata: { reason: 'not_featured' } }],
  };
  return {
    cases,
    schema: {
      provenanceCheckDefs: ["CHECK ((provenance IS NULL) OR (provenance = ANY (ARRAY['assignment:grant'::text, 'assignment:warrant'::text])))"],
      originGroupOnly: true,
      nonManualRows: [grant('read'), grant('write')],
      arbitraryProvenanceRefused: true,
      ratifiedProvenanceAccepted: ['assignment:grant', 'assignment:warrant'],
    },
    serialisation,
    allGrantRows: [grant('read'), grant('write'), ...creatorPair()],
  };
}

/** Apply a mutation to a deep copy, so no mutation can leak into the next. */
function mutate(fn: (input: DrillInput) => void): Record<string, string[]> {
  const input: DrillInput = JSON.parse(JSON.stringify(greenInput()));
  fn(input);
  return assertionSet(input);
}

const caseNamed = (input: DrillInput, name: string): Observation => {
  const found = input.cases.find((obs) => obs.assertion === name);
  if (!found) throw new Error(`the baseline lost its '${name}' case`);
  return found;
};

const red = (result: Record<string, string[]>): string[] =>
  Object.entries(result).filter(([, failures]) => failures.length > 0).map(([name]) => name);

// ═══════════════════════════════════════════════════════════════════════════
// 0 · THE BASELINE IS GREEN, AND IT IS NOT GREEN BY BEING EMPTY
// ═══════════════════════════════════════════════════════════════════════════

describe('0 · the baseline', () => {
  it('passes every assertion', () => {
    expect(red(assertionSet(greenInput()))).toEqual([]);
  });

  it('carries every assertion the drill owes — an absent case is not a pass', () => {
    // A mutation harness whose baseline quietly lost a case would prove that
    // some OTHER case's assertion reddens, which is the vacuity shape the
    // `controls-need-their-own-controls` lesson names.
    expect(Object.keys(assertionSet(greenInput())).sort())
      .toEqual([...REQUIRED_ASSERTIONS].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1 · R-11-v1 — ONE MUTATION PER RE-DERIVED CLAUSE
//
// Each defect below is a build that stopped re-reading ONE clause inside the
// project's transaction. The observable consequence is the same shape every
// time — the act applied where it should have skipped — but it lands on a
// DIFFERENT case, and therefore on a different named assertion. That is the
// independence R-11-v1 claims, measured rather than asserted.
// ═══════════════════════════════════════════════════════════════════════════

describe('1 · R-11-v1, clause by clause', () => {
  const clauseDefects: Array<[string, string, string]> = [
    ['the act never re-reads `featured` under the lock', 'skip:not_featured', 'not_featured'],
    ['the act never re-reads membership under the lock', 'skip:not_a_member', 'not_a_member'],
    ['the act honours a pointer that is gone', 'skip:no_home_group', 'no_home_group'],
  ];

  for (const [defect, assertion] of clauseDefects) {
    it(`${defect} → reddens '${assertion}' and NOTHING else`, () => {
      const result = mutate((input) => {
        const obs = caseNamed(input, assertion);
        // The state that build leaves: it granted anyway.
        obs.grants = [grant('read'), grant('write')];
        obs.audits = [{
          action: 'project.access_default_apply', outcome: 'success',
          metadata: { projectId: PROJECT, groupId: GROUP, verbs: ['read', 'write'] },
        }];
      });
      expect(red(result)).toEqual([assertion]);
    });
  }

  it("a build that names the WRONG clause reddens only that clause's assertion", () => {
    // The subtler defect, and the reason `assertSkipped` compares the reason
    // STRING: the act skipped correctly and audited `not_featured` for a case
    // whose cause was a lost membership. Everything a counting assertion looks
    // at is right.
    const result = mutate((input) => {
      caseNamed(input, 'skip:not_a_member').audits =
        [{ action: 'project.access_default_skip', outcome: 'success', metadata: { reason: 'not_featured' } }];
    });
    expect(red(result)).toEqual(['skip:not_a_member']);
  });

  it('a build that audits no reason at all reddens that clause', () => {
    const result = mutate((input) => {
      caseNamed(input, 'skip:no_home_group').audits = [];
    });
    expect(red(result)).toEqual(['skip:no_home_group']);
  });

  // Ruling D1's clause, in the shape the route now has. Two defects, because
  // the refusal is two claims: that nothing survived it, and that it is the
  // answer contract B names rather than any refusal at all.
  it('a build that let the DISABLED Account create anyway reddens the refusal and NOTHING else', () => {
    const result = mutate((input) => {
      const obs = caseNamed(input, 'refuse:actor_inactive');
      obs.projectId = PROJECT;
      obs.grants = [grant('read'), grant('write'), ...creatorPair()];
      obs.audits = [{
        action: 'project.access_default_apply', outcome: 'success',
        metadata: { projectId: PROJECT, groupId: GROUP, verbs: ['read', 'write'] },
      }];
      obs.refusal = { status: 201, code: '' };
    });
    expect(red(result)).toEqual(['refuse:actor_inactive']);
  });

  it('a build that refused for the WRONG reason reddens the refusal and NOTHING else', () => {
    // The subtler half: the create was refused, nothing survived, and the
    // caller was told the name was taken. A control that only counted rows
    // would call that a pass.
    const result = mutate((input) => {
      caseNamed(input, 'refuse:actor_inactive').refusal =
        { status: 409, code: 'PROJECT_NAME_CONFLICT' };
    });
    expect(red(result)).toEqual(['refuse:actor_inactive']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · R-11-v1 (iii) — THE ACTING CHANNEL, BOTH HALVES
// ═══════════════════════════════════════════════════════════════════════════

describe('2 · R-11-v1, the acting channel', () => {
  it('a build that tests only `scopes.includes(root)` reddens the BEARER case', () => {
    // This is the defect `A-L50` says a build could ship while still passing
    // the non-root-session half: `isBearerCredentialKind` is the discriminator,
    // and a root-scoped bearer walks straight through a scope-only test.
    const result = mutate((input) => {
      const obs = caseNamed(input, 'skip:actor_channel_unavailable:bearer');
      obs.grants = [grant('read'), grant('write')];
      obs.audits = [{
        action: 'project.access_default_apply', outcome: 'success',
        metadata: { projectId: PROJECT, groupId: GROUP, verbs: ['read', 'write'] },
      }];
    });
    expect(red(result)).toEqual(['skip:actor_channel_unavailable:bearer']);
  });

  it('a build that tests only the session KIND reddens the non-root-session case', () => {
    const result = mutate((input) => {
      const obs = caseNamed(input, 'skip:actor_channel_unavailable:non-root-session');
      obs.grants = [grant('read'), grant('write')];
      obs.audits = [{
        action: 'project.access_default_apply', outcome: 'success',
        metadata: { projectId: PROJECT, groupId: GROUP, verbs: ['read', 'write'] },
      }];
    });
    expect(red(result)).toEqual(['skip:actor_channel_unavailable:non-root-session']);
  });

  it('a DRILL that stopped driving a root-scoped bearer reddens the discriminator', () => {
    // Not a defect in the product: a defect in the measurement. The drill that
    // silently stopped exercising the bearer half would still pass every
    // per-case assertion, and `channel:discriminates` is the assertion that
    // exists to notice it.
    const result = mutate((input) => {
      input.cases = input.cases.filter(
        (obs) => obs.assertion !== 'skip:actor_channel_unavailable:bearer');
    });
    expect(red(result)).toEqual(['channel:discriminates']);
  });

  it('a DRILL that stopped flipping one clause reddens the independence assertion', () => {
    const result = mutate((input) => {
      input.cases = input.cases.filter((obs) => obs.assertion !== 'skip:not_featured');
    });
    expect(red(result)).toEqual(['clauses:independent']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · R-11-v1 (i) and (iv) — ATOMICITY AND THE LOCK
// ═══════════════════════════════════════════════════════════════════════════

describe('3 · R-11-v1, atomicity and serialisation', () => {
  it('best-effort attachment — the project survives its failed grant — reddens atomicity alone', () => {
    const result = mutate((input) => {
      caseNamed(input, 'apply:atomic').projectId = PROJECT;
    });
    expect(red(result)).toEqual(['apply:atomic']);
  });

  it('ONE grant row instead of two reddens the apply case alone', () => {
    const result = mutate((input) => {
      caseNamed(input, 'apply:two-rows').grants = [grant('read')];
    });
    expect(red(result)).toEqual(['apply:two-rows']);
  });

  it('a third verb reddens the apply case alone', () => {
    const result = mutate((input) => {
      caseNamed(input, 'apply:two-rows').grants =
        [grant('read'), grant('write'), grant('admin')];
    });
    expect(red(result)).toEqual(['apply:two-rows']);
  });

  it('granting to the PRINCIPAL instead of the Group reddens the apply case alone', () => {
    const result = mutate((input) => {
      const rows = caseNamed(input, 'apply:two-rows').grants;
      for (const row of rows) { row.granteeType = 'principal'; row.granteeId = ROOT; }
    });
    // `A-L23:group-grantee-only` reads the whole-table census, which this
    // mutation does not touch, so the apply case is the only assertion that
    // moves — the two are not one control counted twice.
    expect(red(result)).toEqual(['apply:two-rows']);
  });

  it('a build that never wrote the creator pair reddens the apply case alone', () => {
    // Owner contract B on the SAME transaction: a build that kept the
    // home-group act and dropped the creator pair leaves a set this oracle
    // once called correct, because two rows was the whole of what it asked
    // for. The union is what makes the omission visible.
    const result = mutate((input) => {
      caseNamed(input, 'apply:two-rows').grants = [grant('read'), grant('write')];
    });
    expect(red(result)).toEqual(['apply:two-rows']);
  });

  it('a build that dropped the creator pair on a SKIP case reddens that case alone', () => {
    // The skip is a statement about the home-group act only. A build that let
    // the skip suppress contract B as well would leave the pre-composition
    // zero-row set — which is precisely what this oracle used to require.
    const result = mutate((input) => {
      caseNamed(input, 'skip:not_featured').grants = [];
    });
    expect(red(result)).toEqual(['skip:not_featured']);
  });

  it('a THIRD writer naming the project reddens the case it lands on, alone', () => {
    // The exactness the union has to keep: neither policy accounts for this
    // row, so it is red whatever origin it wears.
    const result = mutate((input) => {
      caseNamed(input, 'skip:no_home_group').grants = [
        ...creatorPair(),
        { granteeType: 'principal', granteeId: GROUP, resourceType: 'project',
          resourceId: PROJECT, verb: 'read', origin: 'manual', provenance: null },
      ];
    });
    expect(red(result)).toEqual(['skip:no_home_group']);
  });

  it('NO FOR SHARE — the request never waited — reddens serialisation alone', () => {
    const result = mutate((input) => {
      input.serialisation.blockedWhileHeld = false;
    });
    expect(red(result)).toEqual(['forShare:serialisation']);
  });

  it('granting against a Group the writer had already unfeatured reddens serialisation alone', () => {
    const result = mutate((input) => {
      input.serialisation.grants = [grant('read'), grant('write')];
      input.serialisation.audits = [{
        action: 'project.access_default_apply', outcome: 'success',
        metadata: { projectId: PROJECT, groupId: GROUP, verbs: ['read', 'write'] },
      }];
    });
    expect(red(result)).toEqual(['forShare:serialisation']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · R-7 — THE PROVENANCE COLLISION
// ═══════════════════════════════════════════════════════════════════════════

describe('4 · R-7, the provenance collision', () => {
  it('the "tidy the columns" refactor — provenance widened to carry origin — reddens R-7 alone', () => {
    // This is the exact future edit R-7 exists for. Widening 099's CHECK makes
    // every creation-default row satisfy the rule-4 arm's `assignment-vehicle`
    // internal-writer reason ("provenance IS NOT NULL"), so a request path
    // declaring that reason could write one.
    const result = mutate((input) => {
      input.schema.provenanceCheckDefs = [
        "CHECK ((provenance IS NULL) OR (provenance = ANY (ARRAY['assignment:grant'::text, 'assignment:warrant'::text, 'creation-default'::text])))",
      ];
    });
    expect(red(result)).toEqual(['R-7:provenance']);
  });

  it('a widening to a value NOBODY THOUGHT TO FORBID reddens R-7 alone', () => {
    // ROUND-1 FINDING B3, reproduced verbatim as the control. The oracle that
    // stood here searched for two substrings and rejected two NAMED smuggled
    // values, so this exact definition returned no failures - a false green in
    // a required authorization control. The oracle now extracts the admitted
    // domain and compares it as a SET, because a forbidden list is always
    // satisfied by the next value nobody listed.
    const result = mutate((input) => {
      input.schema.provenanceCheckDefs = [
        "CHECK ((provenance IS NULL) OR (provenance = ANY (ARRAY['assignment:grant'::text,"
        + " 'assignment:warrant'::text, 'unexpected-third-value'::text])))",
      ];
    });
    expect(red(result)).toEqual(['R-7:provenance']);
  });

  it('a NARROWING reddens R-7 too — the claim is EXACTLY two, not at least two', () => {
    const result = mutate((input) => {
      input.schema.provenanceCheckDefs = [
        "CHECK ((provenance IS NULL) OR (provenance = 'assignment:grant'::text))",
      ];
    });
    expect(red(result)).toEqual(['R-7:provenance']);
  });

  it('PostgreSQL ACCEPTING an unratified value reddens R-7 alone', () => {
    // The definition can say anything; this is the constraint answering. A
    // build whose CHECK reads correctly but does not bind would pass every
    // string comparison above.
    const result = mutate((input) => { input.schema.arbitraryProvenanceRefused = false; });
    expect(red(result)).toEqual(['R-7:provenance']);
  });

  it('a CHECK that refuses EVERYTHING reddens R-7 — the probe is not refusal-only', () => {
    // The vacuity guard on the guard: an assertion that only required a
    // refusal would be perfectly satisfied by a constraint admitting nothing,
    // which is the same shape as the defect this repair exists for.
    const result = mutate((input) => { input.schema.ratifiedProvenanceAccepted = []; });
    expect(red(result)).toEqual(['R-7:provenance']);
  });

  it('a creation-default row that CARRIES a provenance reddens R-7 alone', () => {
    const result = mutate((input) => {
      input.schema.nonManualRows[0].provenance = 'assignment:grant';
    });
    expect(red(result)).toEqual(['R-7:provenance']);
  });

  it('dropping grants_origin_group_only reddens R-7 alone', () => {
    const result = mutate((input) => { input.schema.originGroupOnly = false; });
    expect(red(result)).toEqual(['R-7:provenance']);
  });

  it('a non-manual PRINCIPAL grant in the table reddens A-L23 alone', () => {
    const result = mutate((input) => {
      input.allGrantRows.push({
        granteeType: 'principal', granteeId: ROOT, resourceType: 'project',
        resourceId: PROJECT, verb: 'read', origin: 'creation-default', provenance: null,
      });
    });
    expect(red(result)).toEqual(['A-L23:group-grantee-only']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · B-L20 — THE SKIP-REASON ENUMERATION IS A CLOSED SET
// ═══════════════════════════════════════════════════════════════════════════

describe('5 · B-L20, the closed set', () => {
  it('carries the COMPLETE v1 enumeration, actor_channel_unavailable first', () => {
    expect([...CREATION_DEFAULT_SKIP_REASONS]).toEqual([
      'actor_channel_unavailable', 'no_home_group', 'not_featured', 'not_a_member', 'actor_inactive',
    ]);
  });

  it('the four re-derived reasons are the SAME four the resolver produces', () => {
    // One derivation, two consumers (`GET /principals/me/home-group` and the
    // creation default). If these drifted, a home group could fail to resolve
    // for a reason the creation default has no word for.
    expect([...CREATION_DEFAULT_SKIP_REASONS].slice(1)).toEqual([...HOME_GROUP_UNRESOLVED_REASONS]);
  });

  it('refuses a reason the enumeration does not carry', () => {
    for (const stranger of ['', 'not_active', 'ACTOR_CHANNEL_UNAVAILABLE', 'no home group', 'steward']) {
      expect(isCreationDefaultSkipReason(stranger)).toBe(false);
    }
    for (const known of CREATION_DEFAULT_SKIP_REASONS) {
      expect(isCreationDefaultSkipReason(known)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · THE DERIVATION ITSELF — D-L2, and the acting-channel test
// ═══════════════════════════════════════════════════════════════════════════

describe('6 · derivation D-L2', () => {
  const resolving: HomeGroupState = {
    pointerGroupId: GROUP, groupExists: true, featured: true, isMember: true, actorActive: true,
  };

  it('resolves only when all four clauses hold', () => {
    expect(classifyHomeGroup(resolving)).toEqual({ resolved: true, groupId: GROUP });
  });

  it('each clause on its own produces its own reason', () => {
    expect(classifyHomeGroup({ ...resolving, pointerGroupId: null }))
      .toEqual({ resolved: false, reason: 'no_home_group' });
    expect(classifyHomeGroup({ ...resolving, groupExists: false }))
      .toEqual({ resolved: false, reason: 'no_home_group' });
    expect(classifyHomeGroup({ ...resolving, featured: false }))
      .toEqual({ resolved: false, reason: 'not_featured' });
    expect(classifyHomeGroup({ ...resolving, isMember: false }))
      .toEqual({ resolved: false, reason: 'not_a_member' });
    expect(classifyHomeGroup({ ...resolving, actorActive: false }))
      .toEqual({ resolved: false, reason: 'actor_inactive' });
  });

  it('the precedence is the record’s enumeration order, and it is deterministic', () => {
    // Stated rather than discovered: with several clauses failing at once the
    // FIRST in §7.3.2's order names the cause, so two runs of the same state
    // never audit two different reasons.
    expect(classifyHomeGroup({
      pointerGroupId: GROUP, groupExists: true, featured: false, isMember: false, actorActive: false,
    })).toEqual({ resolved: false, reason: 'not_featured' });
  });
});

describe('6b · the acting-channel test', () => {
  const actor = (authMethod: string | undefined, scopes: string[] | null) =>
    ({ principalId: ROOT, authMethod, scopes, audit: { handle: 'x', authMethod: 'session' as const } });

  it('admits exactly a root login session', () => {
    expect(isRootLoginSessionActor(actor('session', ['root']))).toBe(true);
    expect(isRootLoginSessionActor(actor('dashboard_jwt', ['root']))).toBe(true);
  });

  it('refuses a root-scoped BEARER, and every other machine credential', () => {
    for (const method of ['principal_api_key', 'legacy_api_key', 'reports_read_key', 'system', 'local_admin']) {
      expect(isRootLoginSessionActor(actor(method, ['root']))).toBe(false);
    }
  });

  it('refuses a login session that does not hold root', () => {
    expect(isRootLoginSessionActor(actor('session', ['projects:write', 'projects:admin']))).toBe(false);
    expect(isRootLoginSessionActor(actor('session', []))).toBe(false);
    expect(isRootLoginSessionActor(actor('session', null))).toBe(false);
  });

  it('refuses an ABSENT actor and an actor with no principal — fail-closed', () => {
    expect(isRootLoginSessionActor(undefined)).toBe(false);
    expect(isRootLoginSessionActor(null)).toBe(false);
    expect(isRootLoginSessionActor({
      principalId: null, authMethod: 'session', scopes: ['root'],
      audit: { handle: 'x', authMethod: 'session' },
    })).toBe(false);
  });

  it('a root session that reached the decision with NO resolution throws rather than skipping', () => {
    // Fail loudly: a root-session creator whose home group was never re-derived
    // must not be handed `no_home_group` by omission.
    expect(() => decideCreationDefault(true, null)).toThrow(/no re-derived/);
    expect(decideCreationDefault(false, null)).toEqual(
      { apply: false, reason: 'actor_channel_unavailable' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · THE PARSER R-7 NOW DEPENDS ON, AND THE SCOPE-MAP ORDERING
// ═══════════════════════════════════════════════════════════════════════════

describe('7 · the constraint-definition parser', () => {
  // A control that EXTRACTS a set is only as good as its extraction: a parser
  // that returned nothing would make every comparison above pass by comparing
  // two empty sets, which is precisely the vacuity shape round 1 rejected one
  // altitude up.
  it('reads the domain out of the shape PostgreSQL actually renders', () => {
    expect(quotedLiterals(
      "CHECK ((provenance IS NULL) OR (provenance = ANY (ARRAY['assignment:grant'::text,"
      + " 'assignment:warrant'::text])))",
    )).toEqual(['assignment:grant', 'assignment:warrant']);
  });

  it('reads the single-value form too', () => {
    expect(quotedLiterals("CHECK ((provenance IS NULL) OR (provenance = 'assignment:grant'::text))"))
      .toEqual(['assignment:grant']);
  });

  it('returns nothing for a definition with no literals — and that is a FAILURE, not a pass', () => {
    expect(quotedLiterals('CHECK (provenance IS NULL)')).toEqual([]);
    // ...which the oracle treats as a domain of {}, and {} is not the two.
    expect(assertProvenanceCollisionAvoided({
      provenanceCheckDefs: ['CHECK (provenance IS NULL)'],
      originGroupOnly: true,
      nonManualRows: [],
    })).not.toEqual([]);
  });

  it('does not split a literal containing a doubled quote', () => {
    expect(quotedLiterals("CHECK (x = 'it''s'::text)")).toEqual(["it's"]);
  });

  it('the ratified pair is stated once, and it is the pair 099 admits', () => {
    expect([...RATIFIED_PROVENANCE_VALUES].sort())
      .toEqual(['assignment:grant', 'assignment:warrant']);
  });
});

describe('7b · the scope-map rule sits ABOVE the /principals family', () => {
  // The source comment at that rule cites THIS assertion. B-L9d's lesson one
  // family over: a rule placed below the family fallbacks silently becomes
  // `principals:read` for GET and `principals:admin` for PUT, and every
  // assertion about the route would still pass while the claim that any
  // Account can choose its own home group became false.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'utils', 'scopeMap.ts'), 'utf8').split('\n');
  const lineOf = (needle: string): number => {
    const index = source.findIndex((line) => line.includes(needle));
    if (index < 0) throw new Error(`scopeMap.ts no longer contains ${needle}`);
    return index;
  };

  it('is above BOTH /principals family rules', () => {
    const home = lineOf("/^\\/principals\\/me\\/home-group$/");
    const familyGet = lineOf("/^\\/principals(\\/|$)/, methods: ['GET']");
    const familyRest = lineOf("/^\\/principals(\\/|$)/, scope: 'principals:admin'");
    expect(home).toBeLessThan(familyGet);
    expect(home).toBeLessThan(familyRest);
  });

  it('carries the authenticated ceiling, for every method', () => {
    const rule = source[lineOf("/^\\/principals\\/me\\/home-group$/")];
    expect(rule).toContain("scope: 'authenticated'");
    // No `methods:` key at all: GET, PUT and DELETE are all self-service here,
    // and a method list would let a later edit drop one of them into the family
    // fallbacks without moving this line.
    expect(rule).not.toContain('methods:');
  });

  it('the finder is not vacuous — it throws for a rule that is not there', () => {
    expect(() => lineOf('/^\\/principals\\/me\\/no-such-route$/')).toThrow();
  });
});
