/**
 * RH-AZ.PROJ-b (card 95572530) — the FOURTH selector form, `all-in-project`.
 *
 * The card adds a project-bounded selector form to Access profiles, extending
 * the ratified closed set `exact | all-of-type | all-except`. The form is a
 * NARROWING tool: it admits a strict subset of what `all-of-type` admits for
 * the same (resource_type, verbs) pair, and it is admitted only for the
 * resource types that carry a project coordinate.
 *
 * ── THE SITES ──────────────────────────────────────────────────────────────
 * A form added to `SELECTOR_FORMS` is reachable at six coordinates, because
 * `validateRules` is the shared validator for profile versions, warrant
 * ceilings, approval requests AND delegation `own()` expressions:
 *
 *   1 · the vocabulary              AccessProfileService.SELECTOR_FORMS
 *   2 · the per-type write closure  AccessProfileService.SELECTOR_FORM_ADMISSIBILITY
 *   3 · the evaluator seam          AccessProfileService.activeProfileCondition
 *                                   + renderAuthoritySeam
 *   4 · the resource shapes         AuthorizationRepository.sqlResource
 *   5 · the own() AND-cap           AuthorizationService.sqlCondition (ownRuleSql)
 *   6 · the containment algebra     authorityContainment.sourceCovers
 *       and the assignment coupling AccessVehicleService.ownRulesCoverTaskRead
 *
 * Sites 5 and 6 are why this suite exists in the shape it does. BOTH carried a
 * trailing `else` that meant "`all-except`" — the widest arm either can
 * express. A fourth form reaching an unrepaired `else` would have been read as
 * "everything EXCEPT these ids", turning a rule pinned to one Project into
 * board-wide authority. Each site below has its OWN assertion, so a defect
 * confined to one site reddens that site's assertion and no other; the drill
 * table in `support/mutationDrill.ts` (M11-M16) is the red proof that each one
 * measures what it claims.
 *
 * ── WHAT THIS FILE DOES NOT PROVE ──────────────────────────────────────────
 * It never executes SQL. There is no PostgreSQL in the unit gate, and an
 * evaluator written here would be a model of the database that could be edited
 * to agree with the code under test. The behavioural proof — two principals,
 * the production router, expected sets read back from `GET /tasks/:id` — is
 * the live drill in the evidence report, run against a real database. What is
 * proved HERE are the properties a string and a pure function can carry
 * honestly.
 */
import {
  SELECTOR_FORMS,
  SELECTOR_FORM_ADMISSIBILITY,
  PROJECT_BOUNDED_SELECTOR_FORMS,
  SEAM_PROJECT_BOUNDED_TOKEN,
  accessProfileService,
  assertProjectBoundedSelectors,
  renderAuthoritySeam,
  validateRules,
  type ProfileRule,
  type SelectorForm,
} from '../services/AccessProfileService';
import { GRANT_RESOURCE_TYPES, type GrantResourceType } from '../services/GrantService';
import {
  AuthorizationService,
  type AuthorizationActor,
  type DelegationActorLink,
} from '../services/AuthorizationService';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { ownRulesCoverTaskRead } from '../services/AccessVehicleService';
import { ruleCovered, type AuthoritySource } from '../utils/authorityContainment';
import fs from 'fs';
import path from 'path';

const service = new AuthorizationService();

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROJECT_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const MIGRATION = path.resolve(
  __dirname, '..', 'migrations', '125_project_bounded_selector_form.sql',
);

function rule(over: Partial<ProfileRule> = {}): ProfileRule {
  return {
    resourceType: 'task',
    selectorForm: 'all-in-project',
    selectorIds: [PROJECT_A],
    verbs: ['read'],
    ...over,
  } as ProfileRule;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE VOCABULARY
// ═══════════════════════════════════════════════════════════════════════════

describe('site 1 — the vocabulary', () => {
  it('the ratified set is the three forms PLUS the project-bounded fourth', () => {
    expect([...SELECTOR_FORMS]).toEqual(['exact', 'all-of-type', 'all-except', 'all-in-project']);
    // The `all-` prefix is the family's grammar for future-inclusive: `exact`
    // is the only pinned form, and the fourth joins the future-inclusive ones.
    const futureInclusive = SELECTOR_FORMS.filter((form) => form.startsWith('all-'));
    expect(futureInclusive).toContain('all-in-project');
    expect(SELECTOR_FORMS.filter((form) => !form.startsWith('all-'))).toEqual(['exact']);
  });

  it('the project-bounded set names the forms whose ids are PROJECT ids', () => {
    expect([...PROJECT_BOUNDED_SELECTOR_FORMS]).toEqual(['all-in-project']);
    for (const form of PROJECT_BOUNDED_SELECTOR_FORMS) {
      expect(SELECTOR_FORMS).toContain(form);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE PER-TYPE WRITE CLOSURE
// ═══════════════════════════════════════════════════════════════════════════

describe('site 2 — the per-type admissibility table', () => {
  it('is TOTAL over the grantable resource types and names only ratified forms', () => {
    // The table is the thing a fourth `if` would have been. Totality is what
    // makes a resource type added later a compile-time decision rather than a
    // branch its author happened to remember.
    expect(Object.keys(SELECTOR_FORM_ADMISSIBILITY).sort())
      .toEqual([...GRANT_RESOURCE_TYPES].sort());
    for (const type of GRANT_RESOURCE_TYPES) {
      const admission = SELECTOR_FORM_ADMISSIBILITY[type];
      expect(admission.forms.length).toBeGreaterThan(0);
      expect(admission.because.trim()).not.toBe('');
      for (const form of admission.forms) expect(SELECTOR_FORMS).toContain(form);
    }
  });

  it('admits the project-bounded form for task and phase ALONE', () => {
    const admitting = GRANT_RESOURCE_TYPES
      .filter((type) => SELECTOR_FORM_ADMISSIBILITY[type].forms.includes('all-in-project'));
    expect([...admitting].sort()).toEqual(['phase', 'task']);
    // `project` is excluded on purpose and not by omission: it IS its own
    // project coordinate, so the form would be a second spelling of `exact`.
    expect(SELECTOR_FORM_ADMISSIBILITY.project.because).toMatch(/second spelling of 'exact'/);
    // AZ-A5 clause 3 survives the generalisation that absorbed it.
    expect([...SELECTOR_FORM_ADMISSIBILITY.surface.forms]).toEqual(['exact']);
  });

  it('validateRules ACCEPTS the project-bounded form on a type that carries a project', () => {
    const parsed = validateRules([
      { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [PROJECT_A, PROJECT_B], verbs: ['read'] },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].selectorForm).toBe('all-in-project');
    expect(parsed[0].selectorIds).toEqual([PROJECT_A, PROJECT_B]);
  });

  it('validateRules REFUSES the project-bounded form on every type with no project coordinate', () => {
    // ANCHORED OUTSIDE THE TABLE (drill finding, M14). This list was derived
    // FROM `SELECTOR_FORM_ADMISSIBILITY` — the same table the validator reads —
    // so a mutation that admitted the form for `report` simply removed `report`
    // from the list and the assertion stayed green. A control derived from the
    // thing it checks cannot fail. The list now comes from the SQL SHAPES: a
    // type whose resource shape declares no project column has no perimeter to
    // be bounded by, whatever the table says, so the validator must refuse it.
    const withoutProject = GRANT_RESOURCE_TYPES.filter((type) => {
      try {
        return !authorizationRepository.sqlResource(type).resource.project;
      } catch {
        return true; // no SQL shape at all: certainly no project coordinate
      }
    });
    expect(withoutProject.length).toBeGreaterThan(0);
    for (const type of withoutProject) {
      expect(() => validateRules([
        { resourceType: type, selectorForm: 'all-in-project', selectorIds: [PROJECT_A], verbs: ['read'] },
      ])).toThrow(new RegExp(`selectorForm must be one of.*for resourceType '${type}'`));
    }
  });

  it('validateRules keeps the AZ-A5 closure: a surface rule may still only be exact', () => {
    for (const form of ['all-of-type', 'all-except', 'all-in-project'] as SelectorForm[]) {
      expect(() => validateRules([
        {
          resourceType: 'surface',
          selectorForm: form,
          selectorIds: form === 'all-of-type' ? [] : [PROJECT_A],
          verbs: ['read'],
        },
      ])).toThrow(/AZ-A5 clause 3/);
    }
  });

  it('validateRules requires a NON-EMPTY id list for the project-bounded form', () => {
    // `all-of-type` is the only form whose list is empty; a project-bounded
    // rule with no perimeter would be `all-of-type` under another name.
    expect(() => validateRules([
      { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [], verbs: ['read'] },
    ])).toThrow(/non-empty UUID array for all-in-project/);
    expect(() => validateRules([
      { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: ['not-a-uuid'], verbs: ['read'] },
    ])).toThrow(/must be full UUIDs/);
  });
});

describe('site 2b — the asynchronous half: the ids must name real Projects', () => {
  it('refuses a selector naming a Project that does not exist, and passes one that does', async () => {
    const catalogue = (present: string[]) => ({
      query: async () => ({ rows: present.map((id) => ({ id })) }),
    });
    await expect(assertProjectBoundedSelectors([rule()], catalogue([])))
      .rejects.toThrow(new RegExp(`Project ${PROJECT_A} in an 'all-in-project' selector, which does not exist`));
    // POSITIVE CONTROL, same call: the validator is not one that refuses every
    // project-bounded rule.
    await expect(assertProjectBoundedSelectors([rule()], catalogue([PROJECT_A])))
      .resolves.toBeUndefined();
  });

  it('does not query at all when no rule carries a project-bounded form', async () => {
    // A validator that queried unconditionally would put a round trip on every
    // version write; and a validator whose refusal is reachable for rules it
    // does not govern is a refusal nobody can predict.
    let queried = 0;
    const counting = { query: async () => { queried += 1; return { rows: [] }; } };
    await assertProjectBoundedSelectors(
      [rule({ selectorForm: 'exact', selectorIds: [TASK] })], counting,
    );
    await assertProjectBoundedSelectors(
      [rule({ selectorForm: 'all-of-type', selectorIds: [] })], counting,
    );
    expect(queried).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · THE EVALUATOR SEAM
// ═══════════════════════════════════════════════════════════════════════════

describe('site 3 — the seam and its ONE substituter', () => {
  it('the profile seam emits the project-bounded arm as a PLACEHOLDER, not a column', () => {
    // The seam cannot know the project coordinate of the shape it will be
    // composed against — most shapes have none — so it defers, and the
    // substituter decides. The three ratified arms are untouched.
    const seam = accessProfileService.activeProfileCondition(7);
    expect(seam.sql).toContain(SEAM_PROJECT_BOUNDED_TOKEN);
    expect(seam.sql).toContain("apr.selector_form = 'all-of-type' AND apr.resource_type <> 'surface'");
    expect(seam.sql).toContain("apr.selector_form = 'exact' AND <RESOURCE_ID_COLUMN> = ANY(apr.selector_ids)");
    expect(seam.sql).toContain("apr.selector_form = 'all-except' AND apr.resource_type <> 'surface'");
  });

  it('a shape WITH a project coordinate gets the bounded arm, stated down to the NULL case', () => {
    const rendered = renderAuthoritySeam(
      accessProfileService.activeProfileCondition(7).sql, 't.id', 't.project_id',
    );
    expect(rendered).toContain(
      "(apr.selector_form = 'all-in-project' AND t.project_id IS NOT NULL"
      + ' AND t.project_id = ANY(apr.selector_ids))',
    );
    // An ORPHAN row is refused as a STATED property of the predicate, not as
    // an emergent consequence of `NULL = ANY(...)`.
    expect(rendered).toContain('t.project_id IS NOT NULL');
  });

  it('a shape with NO project coordinate renders the arm as the literal FALSE', () => {
    // This is the evaluator half of the closure: an `all-in-project` row
    // written straight into `access_profile_rules` in SQL, bypassing every
    // validator, changes no decision for a type that has no project.
    const rendered = renderAuthoritySeam(
      accessProfileService.activeProfileCondition(7).sql, 'r.id',
    );
    expect(rendered).toContain('OR FALSE');
    expect(rendered).not.toContain("selector_form = 'all-in-project'");
  });

  it('refuses to hand back text that still carries a placeholder', () => {
    // The control that makes the substituter mandatory. A caller that
    // substituted one token and missed the other used to ship SQL with a
    // literal `<PROJECT_BOUNDED_ARM>` in it, which PostgreSQL reports as a
    // syntax error at REQUEST time. It fails here, at compose time.
    expect(() => renderAuthoritySeam('SELECT <SOMETHING_ELSE>', 't.id', 't.project_id'))
      .toThrow(/unsubstituted placeholder <SOMETHING_ELSE>/);
    // The seam's own `<>` operator is not a placeholder and must not trip it.
    expect(renderAuthoritySeam(
      "x <> 'surface' AND <RESOURCE_ID_COLUMN> = 1 AND <PROJECT_BOUNDED_ARM>", 't.id', 't.project_id',
    )).toContain("x <> 'surface'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · THE RESOURCE SHAPES — the cross-check that ties both halves together
// ═══════════════════════════════════════════════════════════════════════════

describe('site 4 — a shape declares a project column IFF the table admits the form', () => {
  it('holds for every grantable resource type', () => {
    // The two halves of the closure are ONE fact asserted once, not two lists
    // that can drift. A type the SQL side cannot shape at all (no point/list
    // plane exists for it) contributes no column, which is the fail-closed
    // reading.
    for (const type of GRANT_RESOURCE_TYPES) {
      let projectColumn: string | undefined;
      try {
        projectColumn = authorizationRepository.sqlResource(type).resource.project;
      } catch {
        projectColumn = undefined; // no SQL shape exists for this type
      }
      const admitted = SELECTOR_FORM_ADMISSIBILITY[type].forms.includes('all-in-project');
      expect({ type, declaresProjectColumn: Boolean(projectColumn) })
        .toEqual({ type, declaresProjectColumn: admitted });
    }
  });

  it('names the Task its OWN project_id and the Phase its own, never a joined alias', () => {
    // One Task, one project perimeter: a reader never has to ask which of two
    // answers a selector meant. `t.project_id` is also the coordinate the 117
    // inheritance anchor uses, so the two rules cannot disagree about which
    // Project a Task is in.
    expect(authorizationRepository.sqlResource('task').resource.project).toBe('t.project_id');
    expect(authorizationRepository.sqlResource('phase').resource.project).toBe('ph.project_id');
    expect(authorizationRepository.sqlResource('project').resource.project).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · THE own() AND-CAP — the first catch-all `else`
// ═══════════════════════════════════════════════════════════════════════════

function chainActor(objects: DelegationActorLink['ownExpression'] extends null ? never : any): AuthorizationActor {
  return {
    principalId: AGENT,
    handle: 'agent',
    role: 'agent',
    scopes: ['tasks:read'],
    authenticated: true,
    delegation: {
      links: [
        {
          principalId: AGENT,
          kind: 'agent',
          role: 'agent',
          parentPrincipalId: ACCOUNT,
          boundTaskId: null,
          legacyIdentity: false,
          ownExpression: { scopes: 'parent', objects },
        },
        {
          principalId: ACCOUNT,
          kind: 'account',
          role: 'editor',
          parentPrincipalId: null,
          boundTaskId: null,
          legacyIdentity: false,
          ownExpression: null,
        },
      ] as DelegationActorLink[],
    },
  };
}

describe('site 5 — own() reads a project-bounded rule as a NARROWING, never as all-except', () => {
  const projectBounded = [{
    resourceType: 'task' as GrantResourceType,
    selectorForm: 'all-in-project' as SelectorForm,
    selectorIds: [PROJECT_A],
    verbs: ['read' as const],
  }];

  it('emits the bounded arm on a shape that HAS a project coordinate', () => {
    const shape = authorizationRepository.sqlResource('task').resource;
    const { sql, params } = service.sqlCondition(chainActor(projectBounded), 'read', shape, 1);
    // The own() side is an AND-cap; the project-bounded rule contributes its
    // perimeter and the perimeter alone.
    // The own()-cap arm binds the rule's ids as a PARAMETER; the profile seam
    // reads the stored column (`ANY(apr.selector_ids)`). Both live in one
    // predicate, so every assertion here is anchored on the PARAMETER form —
    // an assertion that cannot tell the two apart is answered by the wrong one.
    expect(sql).toMatch(/t\.project_id IS NOT NULL AND t\.project_id = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContainEqual([PROJECT_A]);
    // THE DEFECT THIS ASSERTION EXISTS FOR: the trailing `else` used to mean
    // `all-except`, so the cap would have been "every task EXCEPT project A" —
    // an inversion from a perimeter into board-wide authority. No arm of the
    // own() cap may negate this rule's id list.
    expect(sql).not.toMatch(/NOT \(t\.id = ANY\(\$\d+::uuid\[\]\)\)/);
    // …and it must not have silently fallen through to `exact` either.
    expect(sql).not.toMatch(/[^(]t\.id = ANY\(\$\d+::uuid\[\]\)/);
  });

  it('contributes NOTHING on a shape with no project coordinate, so the cap refuses', () => {
    // A form the cap cannot express must admit nothing. An arm absent from the
    // OR-list is exactly that, and the surrounding code turns an empty side
    // into `FALSE`.
    const shape = authorizationRepository.sqlResource('report').resource;
    const reportRule = [{ ...projectBounded[0], resourceType: 'report' as GrantResourceType }];
    const { sql } = service.sqlCondition(chainActor(reportRule), 'read', shape, 1);
    // The seam half: a shape with no project coordinate renders the arm away
    // entirely, so the phrase does not occur anywhere in the predicate.
    expect(sql).not.toContain("selector_form = 'all-in-project'");
    // The cap half: no parameter-bound arm at all — neither a negation…
    expect(sql).not.toMatch(/NOT \(r\.id = ANY\(\$\d+::uuid\[\]\)\)/);
    // …nor a pinned-list one, nor an unconditional TRUE.
    expect(sql).not.toMatch(/r\.id = ANY\(\$\d+::uuid\[\]\)/);
    // The delegated side therefore collapses to FALSE and the whole
    // intersection with it: the identity reaches NOTHING through a rule this
    // cap cannot honour. `(FALSE AND` is that collapse, in the emitted text.
    expect(sql).toContain('(FALSE AND');
  });

  it('leaves the three ratified forms reading exactly as they did', () => {
    const shape = authorizationRepository.sqlResource('task').resource;
    const exact = service.sqlCondition(chainActor([
      { ...projectBounded[0], selectorForm: 'exact' as SelectorForm, selectorIds: [TASK] },
    ]), 'read', shape, 1);
    expect(exact.sql).toContain('t.id = ANY(');
    const allExcept = service.sqlCondition(chainActor([
      { ...projectBounded[0], selectorForm: 'all-except' as SelectorForm, selectorIds: [TASK] },
    ]), 'read', shape, 1);
    expect(allExcept.sql).toContain('NOT (t.id = ANY(');
    const allOfType = service.sqlCondition(chainActor([
      { ...projectBounded[0], selectorForm: 'all-of-type' as SelectorForm, selectorIds: [] },
    ]), 'read', shape, 1);
    expect(allOfType.sql).toContain('TRUE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · THE ASSIGNMENT COUPLING — the second catch-all `else`
// ═══════════════════════════════════════════════════════════════════════════

describe('site 6a — the assignment coupling refuses what it cannot prove', () => {
  const base = { resourceType: 'task' as GrantResourceType, verbs: ['read' as const] };

  it('reads a project-bounded own() rule as UNPROVEN, never as "every task except these"', () => {
    // This is a pure function of (rules, taskId): the answer needs the Task's
    // project row, which it does not read. The conservative algebra therefore
    // REFUSES — a narrowing, since the caller turns it into
    // ASSIGNEE_AUTHORITY_EXCLUDES_TASK. Read as `all-except` it would have
    // covered every task on the board but three.
    expect(ownRulesCoverTaskRead(
      [{ ...base, selectorForm: 'all-in-project', selectorIds: [PROJECT_A] }] as ProfileRule[],
      TASK,
    )).toBe(false);
  });

  it('leaves the three ratified forms answering exactly as they did', () => {
    const forms: Array<[SelectorForm, string[], string, boolean]> = [
      ['all-of-type', [], TASK, true],
      ['exact', [TASK], TASK, true],
      ['exact', [PROJECT_A], TASK, false],
      ['all-except', [PROJECT_A], TASK, true],
      ['all-except', [TASK], TASK, false],
    ];
    for (const [selectorForm, selectorIds, taskId, expected] of forms) {
      expect({ selectorForm, selectorIds, covered: ownRulesCoverTaskRead(
        [{ ...base, selectorForm, selectorIds }] as ProfileRule[], taskId,
      ) }).toEqual({ selectorForm, selectorIds, covered: expected });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6b · THE CONTAINMENT ALGEBRA
// ═══════════════════════════════════════════════════════════════════════════

describe('site 6b — containment refuses in both directions rather than guessing', () => {
  const source = (over: Partial<AuthoritySource>): AuthoritySource => ({
    resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [PROJECT_A, PROJECT_B],
    verbs: ['read'], ...over,
  });

  it('a full-width source covers a project-bounded request', () => {
    for (const form of ['all-of-type', 'wildcard'] as Array<AuthoritySource['selectorForm']>) {
      expect(ruleCovered([source({ selectorForm: form, selectorIds: [] })], rule())).toBe(true);
    }
  });

  it('a project-bounded source covers a request whose perimeter is a SUBSET of its own', () => {
    expect(ruleCovered([source({})], rule({ selectorIds: [PROJECT_A] }))).toBe(true);
    expect(ruleCovered([source({})], rule({ selectorIds: [PROJECT_A, PROJECT_B] }))).toBe(true);
  });

  it('a project-bounded source does NOT cover a wider perimeter, an exact request, or a full-width one', () => {
    const outside = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    // A perimeter it does not hold.
    expect(ruleCovered([source({})], rule({ selectorIds: [PROJECT_A, outside] }))).toBe(false);
    // An `exact` request names OBJECT ids; whether those objects live inside
    // the perimeter needs rows this pure algebra deliberately does not read,
    // so it refuses (T2) rather than guessing in either direction.
    expect(ruleCovered([source({})], rule({ selectorForm: 'exact', selectorIds: [TASK] }))).toBe(false);
    expect(ruleCovered([source({})], rule({ selectorForm: 'all-of-type', selectorIds: [] }))).toBe(false);
    expect(ruleCovered([source({})], rule({ selectorForm: 'all-except', selectorIds: [TASK] }))).toBe(false);
    // …and the mirror: an exact or all-except SOURCE proves nothing about a
    // project-bounded request.
    expect(ruleCovered([source({ selectorForm: 'exact', selectorIds: [TASK] })], rule())).toBe(false);
    expect(ruleCovered([source({ selectorForm: 'all-except', selectorIds: [TASK] })], rule())).toBe(false);
  });

  it('an unrecognised SOURCE form covers nothing', () => {
    expect(ruleCovered(
      [source({ selectorForm: 'made-up' as AuthoritySource['selectorForm'] })], rule(),
    )).toBe(false);
  });

  it('an unrecognised REQUEST form is covered by nothing, INCLUDING a full-width source', () => {
    // ROUND-1 REVIEW F1, BLOCKING. The assertion above mutated only the SOURCE
    // side, and the `default: false` it exercised protects only that side.
    // `sourceCovers` switches on the source form, and its `wildcard` and
    // `all-of-type` cases answered TRUE before anything established that the
    // REQUESTED form was in the ratified set — so a request carrying an unknown
    // form was reported COVERED beneath the broadest source there is.
    //
    // Full width is exactly where it mattered: those are the two cases that
    // never look at the request at all.
    const unknown = rule({ selectorForm: 'made-up' as SelectorForm });
    for (const form of ['wildcard', 'all-of-type'] as Array<AuthoritySource['selectorForm']>) {
      expect({ source: form, covered: ruleCovered(
        [source({ selectorForm: form, selectorIds: [] })], unknown,
      ) }).toEqual({ source: form, covered: false });
    }
    // …and beneath the narrower sources too, which already refused.
    for (const form of ['exact', 'all-except', 'all-in-project'] as Array<AuthoritySource['selectorForm']>) {
      expect(ruleCovered([source({ selectorForm: form })], unknown)).toBe(false);
    }
    // POSITIVE CONTROL on the same two sources: a RATIFIED request is still
    // covered by full width, so this is not a guard that refuses everything.
    for (const form of ['wildcard', 'all-of-type'] as Array<AuthoritySource['selectorForm']>) {
      expect(ruleCovered([source({ selectorForm: form, selectorIds: [] })], rule())).toBe(true);
    }
  });

  it('the guard reads the ratified vocabulary, so every form in it is admitted', () => {
    // Derived from SELECTOR_FORMS rather than a hand-typed list: a fifth form
    // added to the vocabulary is admitted by the guard the moment it lands, and
    // is then decided by the switch below it rather than refused by the guard
    // above it. Otherwise the repair for F1 would quietly become a second,
    // stricter vocabulary that nobody remembered to update.
    for (const form of SELECTOR_FORMS) {
      const ids = form === 'all-of-type' ? [] : [PROJECT_A];
      expect({ form, covered: ruleCovered(
        [source({ selectorForm: 'wildcard', selectorIds: [] })],
        rule({ selectorForm: form, selectorIds: ids }),
      ) }).toEqual({ form, covered: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · THE MIGRATION — the third, independent half of the write closure
// ═══════════════════════════════════════════════════════════════════════════

describe('site 7 — migration 125 makes the bad row unrepresentable', () => {
  const sql = () => fs.readFileSync(MIGRATION, 'utf8');

  it('widens the vocabulary CHECK and names the admitted forms explicitly in the shape CHECK', () => {
    expect(sql()).toContain(
      "CHECK (selector_form IN ('exact', 'all-of-type', 'all-except', 'all-in-project'))",
    );
    // The shape CHECK used to test `selector_form <> 'all-of-type'`, so a
    // FIFTH form would silently inherit the pinned-list branch. Naming the
    // forms means an unknown one fails BOTH branches and is refused until
    // someone decides its shape.
    expect(sql()).toContain("OR (selector_form IN ('exact', 'all-except', 'all-in-project')");
    expect(sql()).not.toContain("OR (selector_form <> 'all-of-type' AND array_length");
    // The empty-array hole this card's live drill found: `array_length` answers
    // NULL for `'{}'`, `FALSE OR NULL` is NULL, and a CHECK admits anything not
    // FALSE — so an `all-except` rule with an EMPTY exclusion list was
    // representable in SQL and excluded nothing, i.e. it was `all-of-type`.
    // `cardinality` answers 0, so the branch is FALSE and the row is refused.
    expect(sql()).toContain('cardinality(selector_ids) >= 1');
    expect(sql()).not.toMatch(/CHECK \([^;]*array_length\(selector_ids/);
  });

  it('refuses the form in SQL for every type with no project coordinate', () => {
    // ROUND-1 REVIEW F2. This derived `admitted` from
    // SELECTOR_FORM_ADMISSIBILITY — the SERVICE half — so mutating that table
    // reddened this SQL assertion even though the SQL was untouched, and the
    // drill receipt could not show the SQL half failing on its own.
    //
    // The anchor is now the SQL RESOURCE SHAPES, outside both halves. Each of
    // the three closure halves is now measured against the same third thing
    // rather than against each other: the table (in the cross-check above), the
    // SQL (here), and the evaluator (in the seam assertions). Agreement between
    // any two then follows, and each can fail alone.
    const admitted = GRANT_RESOURCE_TYPES
      .filter((type) => {
        try {
          return Boolean(authorizationRepository.sqlResource(type).resource.project);
        } catch {
          return false;
        }
      })
      .sort();
    const match = sql().match(
      /CHECK \(selector_form <> 'all-in-project' OR resource_type IN \(([^)]*)\)\)/,
    );
    expect(match).not.toBeNull();
    const inSql = (match![1].match(/'([a-z_]+)'/g) ?? [])
      .map((quoted) => quoted.slice(1, -1)).sort();
    expect(inSql).toEqual(admitted);
  });

  it('asserts its own postcondition rather than trusting a generated constraint name', () => {
    // `DROP CONSTRAINT IF EXISTS` on a wrong name is a SILENT no-op: a green
    // migration and a feature that refuses every row it was built to accept.
    const text = sql();
    expect(text).toContain("conrelid = 'access_profile_rules'::regclass");
    expect(text).toContain("pg_get_constraintdef(oid) NOT LIKE '%all-in-project%'");
    expect(text).toContain('RAISE EXCEPTION');
  });

  it('is reserved in the append-only ledger', () => {
    const reserved = fs.readFileSync(path.resolve(__dirname, '..', 'migrations', 'RESERVED'), 'utf8');
    expect(reserved).toMatch(/^125 rh-95572530-az-proj-b 95572530$/m);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · THE NAMING SWEEP — every copy of the ratified list qualifies the fourth
// ═══════════════════════════════════════════════════════════════════════════

describe('the naming sweep (subtask [2]): no copy of the list still says three', () => {
  const REPO = path.resolve(__dirname, '..', '..', '..');
  // Migrations are REPLAYED HISTORY and are not edited in place: 095 records
  // the vocabulary as it stood, and 125 supersedes it with a `COMMENT ON
  // COLUMN` naming all four forms. The migration directory is therefore swept
  // by a different rule, below, rather than exempted by name.
  const COPIES = [
    'backend/src/services/AccessProfileService.ts',
    'backend/src/services/AuthorizationService.ts',
    'backend/src/utils/authorityContainment.ts',
    'backend/src/openapi/spec.ts',
    'backend/src/mcp/registry.ts',
    'frontend/src/pages/AccessManagerPage.tsx',
    'docs/api.md',
  ];

  it('every file that enumerates the selector forms enumerates the fourth', () => {
    // A vocabulary lives in as many places as someone wrote it down. The DB
    // CHECK is the copy everybody remembers; these are the ones that go stale.
    const missing = COPIES.filter((rel) => {
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
      return text.includes('all-except') && !text.includes('all-in-project');
    });
    expect(missing).toEqual([]);
  });

  it('no migration ADDED at or after 125 still enumerates the old vocabulary', () => {
    // The rule that survives another lane adding a migration tomorrow: a file
    // older than this card's is history 125's COMMENT ON supersedes, and a file
    // at or after it that still lists three forms is a copy that went stale
    // before it was written. Pinning the historical set by name would go red
    // for the wrong reason the next time anyone adds a migration.
    const dir = path.resolve(__dirname, '..', 'migrations');
    const stale = fs.readdirSync(dir)
      .filter((name) => /^\d{3}_.*\.sql$/.test(name))
      .filter((name) => Number(name.slice(0, 3)) >= 125)
      .filter((name) => {
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        return text.includes('all-except') && !text.includes('all-in-project');
      });
    expect(stale).toEqual([]);
    // …and the supersession is real: 125 re-COMMENTs the column with all four.
    const migration = fs.readFileSync(MIGRATION, 'utf8');
    expect(migration).toContain('COMMENT ON COLUMN access_profile_rules.selector_form');
    for (const form of SELECTOR_FORMS) expect(migration).toContain(form);
  });

  it('no source file still declares the three-literal union by hand', () => {
    // The union was hand-copied at three coordinates and the type checker
    // caught one of them. A literal union is a copy that cannot notice
    // `SELECTOR_FORMS` changing, so there must be none left.
    const HAND_COPIED = /'exact'\s*\|\s*'all-of-type'\s*\|\s*'all-except'\s*[;,)]/;
    const offenders = COPIES
      .filter((rel) => rel.startsWith('backend/'))
      .filter((rel) => HAND_COPIED.test(fs.readFileSync(path.join(REPO, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
