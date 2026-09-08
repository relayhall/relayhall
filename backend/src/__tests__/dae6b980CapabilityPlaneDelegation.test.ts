/**
 * dae6b980 — every bound parameter must be REFERENCED by the statement that
 * binds it (AUTHZ design `4d961e37` §5.1; strategy `4e40f06f` §2.10).
 *
 * ── The defect ──
 *
 * `GET /skills` answered HTTP 500 (`DatabaseError`, `DB_OTHER`) for ANY
 * delegated Connector credential holding `skills:read`, putting the whole
 * Skills index out of reach of the agent plane — over REST and therefore over
 * MCP — for exactly the identities §2.10's session-start granted-skill index
 * exists to serve. Found by the RH-P3.C4 live DEV drill, not by any suite.
 *
 * The cause was one line. `AuthorizationService.sqlCondition`'s Account-side
 * chain arm read
 *
 *     equality(resource.owner, nextParam(link.principalId))
 *
 * `nextParam` pushes a parameter and returns its placeholder; `equality`
 * returns null when the column is undefined. For a resource with no owner
 * column the arm is dropped but the parameter has already been bound, so the
 * statement carries a `$n` nothing references and PostgreSQL refuses it:
 * 42P18, "could not determine data type of parameter $n".
 *
 * The capability plane is exactly that shape — `sqlResource()` gives `skill`,
 * `personality` and `service` an id and a literal visibility and NO owner. A
 * root or materialised actor short-circuits before this SQL and never sees it;
 * a delegated actor does. `personality` and `service` were latent behind route
 * ceilings, so only `skill` had surfaced.
 *
 * ── What this file asserts, and why it is shaped this way ──
 *
 * Not "skills works for a delegated Connector". That would pin the instance
 * and leave the class: the next optional column added to any resource
 * reintroduces it, and `personality`/`service` were already carrying it
 * unnoticed. So the invariant is the general one —
 *
 *     for every resource type, every action, and every actor shape,
 *     every parameter the predicate binds appears in the SQL it returns
 *
 * — driven through the PRODUCTION path (`authorizedIds` at the pool boundary,
 * the telemetryFrames/delegationCore precedent), because the recurring AZ-S3
 * review theme is that tests bypassing the production path miss the defect
 * that lives in it.
 */
import { authorizationRepository } from '../services/AuthorizationRepository';
import { authorizationService } from '../services/AuthorizationService';
import type { GrantResourceType } from '../services/GrantService';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';
const SUBJECT = '55555555-5555-4555-8555-555555555555';

/** Every resource type `sqlResource()` can build a predicate for. */
const RESOURCE_TYPES: GrantResourceType[] = [
  'task', 'project', 'phase', 'report', 'skill', 'personality', 'service',
];
/** The capability plane — the three that declare NO owner column. */
const OWNERLESS: GrantResourceType[] = ['skill', 'personality', 'service'];
const ACTIONS = ['read', 'write', 'use', 'invoke', 'admin'] as const;

interface Captured { text: string; params: unknown[] }

/** A queryable that records the statement instead of executing it. */
function recorder(): { captured: Captured[]; query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> } {
  const captured: Captured[] = [];
  return {
    captured,
    query: async (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      return { rows: [] };
    },
  };
}

const ALL_VERBS = ['read', 'write', 'use', 'invoke', 'admin'];

/**
 * The own() object selectors a delegated link can carry.
 *
 * `parent` is the easy shape and the one the first version of this file used
 * everywhere — which is exactly why it missed. Verdict `62c60012` B1: with
 * every link on `parent`, `ownRuleSql`'s selector branches never execute, so
 * the two `nextParam` sites inside them were never swept and an orphan could
 * be reintroduced there with this suite still green. "A statement-count lower
 * bound is not branch coverage."
 *
 * So the sweep now drives every selector FORM, and asserts below that each
 * binding branch was actually reached.
 */
const selectorsFor = (type: GrantResourceType) => ({
  parent: 'parent' as const,
  exact: [{ resourceType: type, selectorForm: 'exact' as const, selectorIds: [SUBJECT], verbs: ALL_VERBS }],
  allExcept: [{ resourceType: type, selectorForm: 'all-except' as const, selectorIds: [SUBJECT], verbs: ALL_VERBS }],
  allOfType: [{ resourceType: type, selectorForm: 'all-of-type' as const, selectorIds: [], verbs: ALL_VERBS }],
});

/**
 * The selector form a payload ACTUALLY carries.
 *
 * Round-3 verdict `f49362c6`: the sweep tagged each capture with the key it
 * was filed under in `selectorsFor`, so `allOfType: 'parent' as const` kept
 * the key and the statement count while the all-of-type branch went
 * unreachable — the tag said one thing and the payload did another. A tag
 * derived from the payload cannot lie, whatever the entry is called.
 */
const formOf = (objects: unknown): string => {
  if (objects === 'parent') return 'parent';
  if (Array.isArray(objects) && objects.length > 0) {
    const forms = [...new Set(objects.map(
      (rule) => String((rule as { selectorForm?: unknown }).selectorForm),
    ))].sort();
    return forms.length === 1 ? forms[0] : `mixed(${forms.join('|')})`;
  }
  return `unrecognised(${JSON.stringify(objects)})`;
};

const link = (over: Record<string, unknown>, objects: unknown = 'parent') => ({
  principalId: CONNECTOR, parentPrincipalId: ACCOUNT, kind: 'service', role: 'agent',
  legacyIdentity: false, boundTaskId: null,
  ownExpression: { scopes: 'parent', objects },
  ...over,
});

/** A DELEGATED actor: a Connector under an Account. Root/materialised actors
 * short-circuit before the SQL, which is why this defect never surfaced. */
const delegatedActor = (scopes: string[] = ['skills:read'], objects: unknown = 'parent') => ({
  principalId: CONNECTOR, handle: 'connector_one', role: 'agent', scopes,
  authenticated: true,
  delegation: {
    links: [
      link({}, objects),
      link({ principalId: ACCOUNT, parentPrincipalId: null, kind: 'account', ownExpression: null }),
    ],
  },
});

/** A three-link chain: Agent under Connector under Account. */
const agentActor = (scopes: string[] = ['skills:read'], objects: unknown = 'parent') => ({
  principalId: AGENT, handle: 'agent_one', role: 'agent', scopes,
  authenticated: true,
  delegation: {
    links: [
      link({ principalId: AGENT, kind: 'agent', parentPrincipalId: CONNECTOR, boundTaskId: TASK }, objects),
      link({}, objects),
      link({ principalId: ACCOUNT, parentPrincipalId: null, kind: 'account', ownExpression: null }),
    ],
  },
});

/** Placeholders `$1..$n` the statement actually references. */
function referenced(text: string): Set<number> {
  return new Set([...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
}

/** Bound parameters with no `$n` referencing them — the 42P18 condition. */
export function unreferencedParameters(capture: Captured): number[] {
  const used = referenced(capture.text);
  const orphans: number[] = [];
  for (let index = 1; index <= capture.params.length; index += 1) {
    if (!used.has(index)) orphans.push(index);
  }
  return orphans;
}

describe('dae6b980 — the capability plane is reachable by a delegated actor', () => {
  it('reproduces the exact reported failure shape: a delegated read of skills', async () => {
    // The control this card was filed for. Before the repair the statement
    // carried a parameter nothing referenced and PostgreSQL answered 42P18,
    // which the route surfaced as 500 DB_OTHER.
    const queryable = recorder();
    await authorizationRepository.authorizedIds(
      delegatedActor() as never, 'skill', [SUBJECT], 'read', queryable as never,
    );
    expect(queryable.captured).toHaveLength(1);
    expect(unreferencedParameters(queryable.captured[0])).toEqual([]);
  });

  it('binds no unreferenced parameter at ANY binding site the predicate can reach', async () => {
    // The general invariant. Pinning `skill` alone would leave the class:
    // personality and service were already carrying the same defect behind
    // route ceilings, and the next optional column would reintroduce it.
    //
    // Every selector FORM is driven, so the binding sites inside `ownRuleSql`
    // are swept too — verdict `62c60012` B1 reintroduced an orphan at one of
    // them and this suite stayed green because it only ever drove `parent`.
    const offences: string[] = [];
    // Captures keep the FORM that produced them. Round-2 verdicts efb3556d /
    // 3b173619: searching the aggregate SQL let `all-except` satisfy the
    // `exact` evidence, because `NOT (… = ANY($n::uuid[]))` CONTAINS
    // `= ANY($n::uuid[])`. Reachability has to be attributed, not just seen.
    const statements: Array<{ form: string; text: string }> = [];
    const SCOPES = ['skills:read', 'personalities:read', 'services:read',
      'tasks:read', 'tasks:write', 'projects:read', 'reports:read'];
    for (const type of RESOURCE_TYPES) {
      const selectors = selectorsFor(type);
      for (const action of ACTIONS) {
        for (const objects of Object.values(selectors)) {
          // Derived from the payload, never from the key — see `formOf`.
          const form = formOf(objects);
          for (const [shape, actor] of [
            ['connector', delegatedActor(SCOPES, objects)],
            ['agent', agentActor(SCOPES, objects)],
          ] as const) {
            const queryable = recorder();
            await authorizationRepository.authorizedIds(
              actor as never, type, [SUBJECT], action as never, queryable as never,
            );
            for (const capture of queryable.captured) {
              statements.push({ form, text: capture.text });
              const orphans = unreferencedParameters(capture);
              if (orphans.length > 0) {
                offences.push(`${type}/${action}/${form}/${shape}: unreferenced $${orphans.join(', $')}`);
              }
            }
          }
        }
      }
    }
    expect(offences).toEqual([]);

    // ── BRANCH REACHABILITY, attributed to the SELECTOR ACTUALLY SUPPLIED ──
    //
    // Three rounds were lost here, each to a weaker version of the same idea:
    //   r1 (`62c60012`) counted STATEMENTS — a count is not branch coverage;
    //   r2 (`efb3556d`/`3b173619`) searched the AGGREGATE SQL — but
    //      `all-except` emits `NOT (… = ANY($n::uuid[]))`, which CONTAINS the
    //      `exact` pattern, so exact could go unreachable while green;
    //   r3 (`f49362c6`) attributed captures to the object-map KEY — so
    //      `allOfType: 'parent'` kept the key and the count while the
    //      all-of-type branch went unreachable, and nothing witnessed it.
    //
    // The lesson each time: evidence that is chosen, labelled or counted by
    // the test proves less than evidence the PRODUCTION CODE had to emit. So
    // the tag now comes from the payload (`formOf`), every observed form must
    // have a witness, and the witnesses' mutual exclusivity is COMPUTED below
    // rather than asserted — I have been wrong about substring containment
    // twice, and the suite should not depend on my being right a third time.
    const forms = [...new Set(statements.map((entry) => entry.form))].sort();
    expect(forms).toEqual(['all-except', 'all-of-type', 'exact', 'parent']);

    // The cap SQL each selector form makes `ownRuleSql` emit, measured from
    // the real statements rather than read off the implementation. The cap
    // appears as `<cap> AND (<cap> OR …`, which is what these anchor on;
    // matching the cap POSITION is what keeps `parent` (`TRUE`) and
    // `all-of-type` (`(TRUE)`) apart.
    const WITNESS: Record<string, RegExp> = {
      'parent': /\bTRUE AND \(TRUE OR /,
      'all-of-type': /\(TRUE\) AND \(\(TRUE\) OR /,
      'exact': /\([\w.]+ = ANY\(\$\d+::uuid\[\]\)\) AND \(\([\w.]+ = ANY\(\$\d+::uuid\[\]\)\) OR /,
      'all-except': /\(NOT \([\w.]+ = ANY\(\$\d+::uuid\[\]\)\)\) AND \(\(NOT \([\w.]+ = ANY\(\$\d+::uuid\[\]\)\)\) OR /,
    };

    // Every form the sweep produced must have a witness. `all-of-type` had
    // none in round 3, which is exactly how it went unnoticed: a form with no
    // witness is invisible, not proven.
    expect(Object.keys(WITNESS).sort()).toEqual(forms);

    const matches = (form: string, pattern: RegExp): boolean =>
      statements.some((entry) => entry.form === form && pattern.test(entry.text));

    // Positive: each form's witness appears in a capture OF THAT FORM.
    expect(forms.filter((form) => !matches(form, WITNESS[form]))).toEqual([]);

    // Negative, computed over every ordered pair: a witness must match NOTHING
    // produced by another form. If two patterns are not actually
    // discriminating, this fails here instead of silently witnessing for each
    // other the way `exact` and `all-except` did in round 2.
    const ambiguous: string[] = [];
    for (const form of forms) {
      for (const other of forms) {
        if (form === other) continue;
        if (matches(other, WITNESS[form])) {
          ambiguous.push(`${form} witness also matches ${other} captures`);
        }
      }
    }
    expect(ambiguous).toEqual([]);

    expect(statements.length).toBeGreaterThanOrEqual(
      RESOURCE_TYPES.length * ACTIONS.length * forms.length * 2,
    );
  });

  it('the owner-less families still evaluate to a real predicate, not a blanket refusal', async () => {
    // A statement with no orphan parameters would also be satisfied by
    // returning FALSE for everything. The capability plane is shared-visibility
    // data the agent plane is meant to read, so the predicate must still carry
    // the visibility arm rather than refuse outright.
    for (const type of OWNERLESS) {
      const decision = authorizationService.sqlCondition(
        delegatedActor() as never, 'read',
        { type, id: `${type}.id`, visibility: "'shared'" } as never,
      );
      expect([type, decision.sql]).not.toEqual([type, 'FALSE']);
      expect([type, decision.sql.includes("'shared'")]).toEqual([type, true]);
    }
  });

  it('the detector itself catches an orphan parameter (the zero above is meaningful)', () => {
    // Sensitivity control: if `unreferencedParameters` could not see an
    // orphan, every assertion above would pass on a broken predicate.
    expect(unreferencedParameters({ text: 'SELECT 1 WHERE a = $1', params: ['a'] })).toEqual([]);
    expect(unreferencedParameters({ text: 'SELECT 1 WHERE a = $1', params: ['a', 'orphan'] })).toEqual([2]);
    expect(unreferencedParameters({ text: 'SELECT 1 WHERE a = $2', params: ['orphan', 'b'] })).toEqual([1]);
    // `$1` must not be read as a reference to `$10`.
    expect(unreferencedParameters({ text: 'SELECT 1 WHERE a = $10', params: new Array(10).fill('x') }))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
