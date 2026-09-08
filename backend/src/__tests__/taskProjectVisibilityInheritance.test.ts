/**
 * RH-AZ.PROJ-a (card b363a38c) — a Task inherits Project visibility.
 *
 * Owner ruling 44ee41f2 + run packet 16896595 §3 decision 2/3:
 *   - the chain is Task -> Phase -> Project and it honours `restricted_access`;
 *   - the semantics are a UNION: a Task is visible if its OWN visibility
 *     allows OR the live chain allows;
 *   - an ORPHAN Task (`project_id IS NULL`) inherits NOTHING and fails closed.
 *
 * THE THREE SITES (packet §2.3). The rule is expressed at three places and a
 * change landing at one or two of them is the defect shape this project has
 * already paid for:
 *   A · the in-memory point evaluator      AuthorizationService.authorizeResource
 *   B · the account/legacy SQL arm          AuthorizationService.sqlCondition
 *   C · the delegation-chain account arm    AuthorizationService.sqlCondition
 * Each site below has its OWN assertion, so a mutation confined to one site
 * reddens that site's assertion and not the others.
 *
 * WHAT THIS FILE DOES NOT PROVE. It never executes SQL — there is no
 * PostgreSQL in the unit gate, and an evaluator written here would be a model
 * of the database that could be edited to agree with the code under test. The
 * behavioural proof that the generated predicate SELECTS the right rows is the
 * live drill in the evidence report, run against a real database on the lane
 * portal. What is proved HERE is site A end to end, and for B and C the two
 * properties a string can carry honestly: that both arms are emitted, and that
 * the two SQL sites emit the SAME text for the same resource.
 */
import {
  AuthorizationActor,
  AuthorizationResource,
  AuthorizationService,
  AuthorizationSqlResource,
  DelegationActorLink,
} from '../services/AuthorizationService';
import { authorizationRepository, mapResource } from '../services/AuthorizationRepository';

const service = new AuthorizationService();
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHASE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A principal with NO identity relation to the Task and no grants: the only
 *  arm that can ever fire for it is the visibility arm under test. */
function stranger(overrides: Partial<AuthorizationActor> = {}): AuthorizationActor {
  return {
    principalId: STRANGER,
    handle: 'stranger',
    role: 'agent',
    scopes: ['tasks:read'],
    authenticated: true,
    ...overrides,
  };
}

/** The row shape `AuthorizationRepository.resolve` selects for a Task, so the
 *  cases below are written in DATABASE terms and cross the mapping seam rather
 *  than hand-building the evaluator's input. */
interface TaskRow {
  id: string;
  visibility: string;
  project_id: string | null;
  restricted_access: boolean;
  phase_restricted_access: boolean | null;
  project_visibility: string | null;
  project_status: string | null;
}

function row(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK,
    visibility: 'private',
    project_id: PROJECT,
    restricted_access: false,
    phase_restricted_access: null,
    project_visibility: 'shared',
    project_status: 'active',
    ...overrides,
  };
}

/** The case matrix. Every row is a database state, its expected outcome, and
 *  the sentence that makes it the expected outcome. */
const CASES: Array<{ name: string; row: TaskRow; visible: boolean }> = [
  {
    name: 'a private Task in a SHARED project is visible through the inherited arm',
    row: row({ visibility: 'private', project_visibility: 'shared' }),
    visible: true,
  },
  {
    name: 'a private Task in a PUBLIC project is visible through the inherited arm',
    row: row({ visibility: 'private', project_visibility: 'public' }),
    visible: true,
  },
  {
    name: 'a private Task in a PRIVATE project stays refused',
    row: row({ visibility: 'private', project_visibility: 'private' }),
    visible: false,
  },
  {
    name: 'an ORPHAN Task (project_id IS NULL) inherits nothing and fails closed',
    row: row({ visibility: 'private', project_id: null, project_visibility: null }),
    visible: false,
  },
  {
    name: 'an orphan Task is refused even if a project row were somehow carried',
    row: row({ visibility: 'private', project_id: null, project_visibility: 'public' }),
    visible: false,
  },
  {
    name: 'a Task under a RESTRICTED Phase in a shared project is refused (ruling 44ee41f2)',
    row: row({ visibility: 'private', project_visibility: 'shared', phase_restricted_access: true }),
    visible: false,
  },
  {
    name: 'a Task under an ordinary Phase in a shared project is visible',
    row: row({ visibility: 'private', project_visibility: 'shared', phase_restricted_access: false }),
    visible: true,
  },
  {
    name: 'a Task with its OWN restricted_access is cut off from the inherited arm',
    row: row({ visibility: 'private', project_visibility: 'public', restricted_access: true }),
    visible: false,
  },
  {
    name: 'UNION: a SHARED Task in a private project is visible through its own arm',
    row: row({ visibility: 'shared', project_visibility: 'private' }),
    visible: true,
  },
  {
    name: 'UNION: restricted_access suppresses only the INHERITED arm, never the own one',
    row: row({ visibility: 'public', project_visibility: 'public', restricted_access: true }),
    visible: true,
  },
  {
    name: 'UNION: a restricted PHASE does not suppress the Task own visibility either',
    row: row({ visibility: 'public', project_visibility: 'private', phase_restricted_access: true }),
    visible: true,
  },
  {
    name: 'an orphan Task that is itself public is still visible through its own arm',
    row: row({ visibility: 'public', project_id: null, project_visibility: null, project_status: null }),
    visible: true,
  },
  {
    name: 'an ARCHIVED Project is not a live source: its private Tasks stop inheriting',
    row: row({ visibility: 'private', project_visibility: 'public', project_status: 'archived' }),
    visible: false,
  },
  {
    name: 'a Project in an UNKNOWN future status confers nothing either (fails closed)',
    row: row({ visibility: 'private', project_visibility: 'public', project_status: 'paused' }),
    visible: false,
  },
  {
    name: 'archiving a Project never suppresses a Task OWN visibility',
    row: row({ visibility: 'public', project_visibility: 'private', project_status: 'archived' }),
    visible: true,
  },
];

describe('AZ.PROJ-a site A — the in-memory point evaluator', () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      const resource = mapResource('task', testCase.row as unknown as Record<string, unknown>);
      const decision = service.authorizeResource(stranger(), 'read', resource, []);
      expect(decision.allowed).toBe(testCase.visible);
      if (testCase.visible) expect(decision.basis).toBe('visibility');
      else expect(decision.denial).toBe('NO_AUTHORITY');
    },
  );

  it('never lets the inherited arm reach a WRITE-class action', () => {
    const resource = mapResource('task', row({ project_visibility: 'public' }) as unknown as Record<string, unknown>);
    for (const action of ['write', 'claim', 'finish', 'release', 'verify', 'shepherd'] as const) {
      expect(service.authorizeResource(stranger(), action, resource, []).allowed).toBe(false);
    }
  });

  it('leaves the pre-117 Phase behaviour of the same arm exactly as ruling 44ee41f2 set it', () => {
    const phase = (restrictedAccess: boolean, inherited: string): AuthorizationResource => ({
      type: 'phase', id: PHASE, inheritedVisibility: inherited as AuthorizationResource['visibility'], restrictedAccess,
    });
    expect(service.authorizeResource(stranger(), 'read', phase(false, 'shared'), []).allowed).toBe(true);
    expect(service.authorizeResource(stranger(), 'read', phase(true, 'shared'), []).allowed).toBe(false);
    expect(service.authorizeResource(stranger(), 'read', phase(false, 'private'), []).allowed).toBe(false);
  });

  it('does not turn the id-independent blanket probe into a blanket read', () => {
    // routes/tasks.ts and FeedEventService probe with a synthetic Task id and
    // NO principal or visibility fields, to ask "is this actor's task-read
    // id-independent?". A visibility arm that fired on an absent field would
    // silently hand every scoped actor the whole board.
    const probe: AuthorizationResource = { type: 'task', id: '00000000-0000-4000-8000-000000000000' };
    expect(service.authorizeResource(stranger(), 'read', probe, []).allowed).toBe(false);
  });
});

/** The two SQL sites, driven through the SAME resource shape the repository
 *  hands them. `sqlCondition` is deterministic text, so the assertions below
 *  are about WHICH arms exist and whether the two sites agree — never about a
 *  simulated result set. */
// Read from the REPOSITORY, never hand-copied. These assertions have to fail
// when the shape the predicate is actually CONFIGURED with changes; a literal
// copied into the test would keep passing while the product lost an arm.
const TASK_SQL: AuthorizationSqlResource = authorizationRepository.sqlResource('task').resource;
const PHASE_SQL: AuthorizationSqlResource = authorizationRepository.sqlResource('phase').resource;
const PROJECT_SQL: AuthorizationSqlResource = authorizationRepository.sqlResource('project').resource;

// TWO LAYERS, and they must not collapse into one (review cf04a642 finding 4).
//
// The arm TEXT is composed from the configured coordinates, so a shape change
// flows into the expectation and the assertions keep biting. But composing
// alone would let the shape be BOTH implementation and oracle: swapping
// `visibility` to `p.visibility` would move the expectation with it and every
// assertion would stay green while the list SQL read the wrong column. So the
// coordinates themselves are pinned by LITERAL first, in their own control
// below, and only then composed.
const OWN_ARM = `${TASK_SQL.visibility} IN ('public', 'shared', 'default')`;
const INHERITED_ARM = `((${TASK_SQL.inheritanceAnchor}) AND NOT (${TASK_SQL.restrictedAccess})`
  + ` AND ${TASK_SQL.inheritedVisibility} IN ('public', 'shared', 'default'))`;

function accountActor(): AuthorizationActor {
  return { principalId: STRANGER, handle: 'stranger', role: 'agent', scopes: ['tasks:read'], authenticated: true };
}

function delegatedActor(): AuthorizationActor {
  const links: DelegationActorLink[] = [
    {
      principalId: CONNECTOR, kind: 'connector', role: 'user', parentPrincipalId: ACCOUNT,
      boundTaskId: null, legacyIdentity: false,
      ownExpression: { scopes: 'parent', objects: 'parent' },
    },
    {
      principalId: ACCOUNT, kind: 'account', role: 'user', parentPrincipalId: null,
      boundTaskId: null, legacyIdentity: false, ownExpression: null,
    },
  ];
  return {
    principalId: CONNECTOR, handle: 'connector', role: 'user', scopes: ['tasks:read'],
    authenticated: true, delegation: { links },
  };
}

describe('AZ.PROJ-a — the configured coordinates themselves', () => {
  it('pins every column the Task predicate reads, by literal', () => {
    // The oracle for these is the DATABASE, not the code under test: each
    // string below is the column migration 063/079/117 actually created, on
    // the alias the repository actually joins.
    expect(TASK_SQL).toMatchObject({
      type: 'task',
      id: 't.id',
      owner: 't.owner_principal_id',
      claimant: 't.owner_principal_id',
      creator: 't.creator_principal_id',
      shepherd: 't.shepherd_principal_id',
      verifier: 't.verifier_principal_id',
      visibility: 't.visibility',
      inheritedVisibility: 'p.visibility',
      restrictedAccess: '(t.restricted_access OR COALESCE(ph.restricted_access, FALSE))',
      inheritanceAnchor: "t.project_id IS NOT NULL AND p.status = 'active'",
    });
    // A Task's OWN visibility must come from the TASK, and its INHERITED
    // visibility from the PROJECT. Swapping them is the defect this pins.
    expect(TASK_SQL.visibility).not.toBe(TASK_SQL.inheritedVisibility);
    expect(authorizationRepository.sqlResource('task').from).toBe(
      'tasks t LEFT JOIN phases ph ON ph.id = t.phase_id'
      + ' LEFT JOIN projects p ON p.id = t.project_id');
  });

  it('leaves the ratified Phase and Project coordinates exactly as they were', () => {
    expect(PHASE_SQL).toMatchObject({
      type: 'phase', id: 'ph.id', owner: 'p.owner_principal_id',
      inheritedVisibility: 'p.visibility', restrictedAccess: 'ph.restricted_access',
    });
    expect(PHASE_SQL.visibility).toBeUndefined();
    expect(PHASE_SQL.inheritanceAnchor).toBeUndefined();
    expect(PROJECT_SQL).toMatchObject({
      type: 'project', id: 'p.id', owner: 'p.owner_principal_id', visibility: 'p.visibility',
    });
    expect(PROJECT_SQL.inheritedVisibility).toBeUndefined();
  });
});

describe('AZ.PROJ-a site B — the account/legacy SQL arm', () => {
  it('emits BOTH union arms for a Task', () => {
    const { sql } = service.sqlCondition(accountActor(), 'read', TASK_SQL, 1);
    expect(sql).toContain(OWN_ARM);
    expect(sql).toContain(INHERITED_ARM);
  });

  it('anchors the inherited arm on a LIVE, existing Project', () => {
    const { sql } = service.sqlCondition(accountActor(), 'read', TASK_SQL, 1);
    // Review 66281121 finding 1: an archived Project is not a live source.
    // `= 'active'` rather than `<> 'archived'` so a status value added later
    // confers nothing until someone decides it should.
    //
    // The conjunct is asserted WHOLE and PARENTHESISED, on purpose. A bare
    // `toContain("p.status = 'active'")` passed while the anchor had been
    // mutated away, because the group-membership join inside the grant seam
    // carries `mp.status = 'active'` — a substring assertion answered by an
    // unrelated clause is a control that cannot fail (drill M4, round 1).
    expect(sql).toContain("(t.project_id IS NOT NULL AND p.status = 'active')");
    expect(sql).not.toContain("p.status <> 'archived'");
    // The anchor is a conjunct OF the inherited arm, never a free-standing
    // arm: `project_id IS NOT NULL` on its own would make every projected
    // Task readable by anyone.
    expect(sql).not.toContain(`OR t.project_id IS NOT NULL)`);
  });

  it('suppresses the inherited arm from EITHER the Task or its Phase', () => {
    const { sql } = service.sqlCondition(accountActor(), 'read', TASK_SQL, 1);
    expect(sql).toContain('NOT ((t.restricted_access OR COALESCE(ph.restricted_access, FALSE)))');
  });

  it('emits no visibility arm at all for a write-class action', () => {
    const { sql } = service.sqlCondition(accountActor(), 'write', TASK_SQL, 1);
    expect(sql).not.toContain("IN ('public', 'shared', 'default')");
  });

  it('leaves the ratified Phase text byte-identical to its pre-117 form', () => {
    const { sql } = service.sqlCondition(accountActor(), 'read', PHASE_SQL, 1);
    expect(sql).toContain("(NOT (ph.restricted_access) AND p.visibility IN ('public', 'shared', 'default'))");
    // A Phase has no own visibility column, so it must gain no own arm.
    expect(sql).not.toContain("ph.visibility IN ('public', 'shared', 'default')");
  });

  it('leaves a single-visibility resource with exactly one arm', () => {
    const { sql } = service.sqlCondition(accountActor(), 'read', PROJECT_SQL, 1);
    expect(sql).toContain("p.visibility IN ('public', 'shared', 'default')");
    expect(sql.match(/IN \('public', 'shared', 'default'\)/g)).toHaveLength(1);
  });
});

describe('AZ.PROJ-a site C — the delegation-chain account arm', () => {
  it('emits BOTH union arms on the Account side of the chain intersection', () => {
    const { sql } = service.sqlCondition(delegatedActor(), 'read', TASK_SQL, 1);
    expect(sql).toContain(OWN_ARM);
    expect(sql).toContain(INHERITED_ARM);
  });

  it('carries the visibility arms IDENTICALLY to site B — the two cannot drift', () => {
    // Both sites call one implementation; this asserts the OBSERVABLE
    // consequence, so replacing site C body with a copy that differs by a
    // single conjunct reddens here and nowhere else.
    const accountSql = service.sqlCondition(accountActor(), 'read', TASK_SQL, 1).sql;
    const chainSql = service.sqlCondition(delegatedActor(), 'read', TASK_SQL, 1).sql;
    const arms = (sql: string): string[] =>
      [OWN_ARM, INHERITED_ARM].filter((arm) => sql.includes(arm));
    expect(arms(chainSql)).toEqual([OWN_ARM, INHERITED_ARM]);
    expect(arms(chainSql)).toEqual(arms(accountSql));
  });

  it('keeps the inherited arm CAPPED by the delegated own() expression', () => {
    // The Account side is one side of an intersection; the delegated side's
    // own()-cap is the other. A Connector whose own() names a DIFFERENT Task
    // must not read this one just because the Project is shared, so the cap
    // has to BOUND the Account side rather than sit beside it.
    const capped = delegatedActor();
    capped.delegation!.links[0].ownExpression = {
      scopes: 'parent',
      objects: [{ resourceType: 'task', selectorForm: 'exact', selectorIds: [PHASE], verbs: ['read'] }],
    };
    const { sql } = service.sqlCondition(capped, 'read', TASK_SQL, 1);
    const cap = 't.id = ANY(';
    const capAt = sql.indexOf(cap);
    const armAt = sql.indexOf(INHERITED_ARM);
    expect(capAt).toBeGreaterThan(-1);
    expect(armAt).toBeGreaterThan(capAt);
    // Between the cap and the Account side lies the intersection operator:
    // the two are AND-ed sides, never OR-ed alternatives.
    expect(sql.slice(capAt, armAt)).toContain(') AND (');
    expect(sql.slice(capAt, armAt)).not.toContain(') OR (' + INHERITED_ARM);
  });

  it('gives a bound Agent no inherited read beyond its task context', () => {
    const links: DelegationActorLink[] = [
      {
        principalId: CONNECTOR, kind: 'agent', role: 'agent', parentPrincipalId: ACCOUNT,
        boundTaskId: TASK, legacyIdentity: false,
        ownExpression: { scopes: 'parent', objects: 'parent' },
      },
      {
        principalId: ACCOUNT, kind: 'account', role: 'user', parentPrincipalId: null,
        boundTaskId: null, legacyIdentity: false, ownExpression: null,
      },
    ];
    const actor: AuthorizationActor = {
      principalId: CONNECTOR, handle: 'agent', role: 'agent', scopes: ['tasks:read'],
      authenticated: true, delegation: { links },
    };
    const { sql } = service.sqlCondition(actor, 'write', TASK_SQL, 1);
    // A write never reaches any visibility arm, inherited or not.
    expect(sql).not.toContain("IN ('public', 'shared', 'default')");
  });
});

describe('AZ.PROJ-a — the mapping seam between the database row and site A', () => {
  it('reads Project liveness from the row, not from the Task', () => {
    const archived = mapResource('task', row({ project_status: 'archived' }) as unknown as Record<string, unknown>);
    expect(archived.inheritedVisibility).toBeNull();
    const live = mapResource('task', row({ project_status: 'active' }) as unknown as Record<string, unknown>);
    expect(live.inheritedVisibility).toBe('shared');
  });

  it('collapses the Phase and Task opt-outs into the one suppression flag', () => {
    expect(mapResource('task', row({ restricted_access: true }) as unknown as Record<string, unknown>)
      .restrictedAccess).toBe(true);
    expect(mapResource('task', row({ phase_restricted_access: true }) as unknown as Record<string, unknown>)
      .restrictedAccess).toBe(true);
    expect(mapResource('task', row() as unknown as Record<string, unknown>).restrictedAccess).toBe(false);
  });

  it('never coerces an orphan Task inherited visibility to a value', () => {
    const orphan = mapResource('task', row({ project_id: null, project_visibility: 'public' }) as unknown as Record<string, unknown>);
    expect(orphan.inheritedVisibility).toBeNull();
    // The Task own visibility keeps its NOT NULL coercion, unchanged.
    expect(orphan.visibility).toBe('private');
  });

  it('leaves the Phase mapping exactly as 085 left it', () => {
    const phase = mapResource('phase', {
      id: PHASE, restricted_access: true, project_visibility: 'public',
      project_owner_principal_id: ACCOUNT,
    });
    expect(phase.restrictedAccess).toBe(true);
    expect(phase.inheritedVisibility).toBe('public');
    expect(phase.visibility).toBeUndefined();
  });
});
