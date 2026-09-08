/**
 * f9b7febe — `concealed` is a decision about the CALLER, not about the verb.
 *
 * The live census (`taskPointRefusalShape`) measures what every Task point
 * route answers. This file measures the decision that produces those answers,
 * as the pure contract it is: WHEN a second question is asked, WHAT it is
 * asked about, and when it is not asked at all.
 *
 * It matters separately from the behaviour because the two ways to pass the
 * census are not equally good. A `concealed` that were simply `!allowed` would
 * make every 4xx a 404 and pass every equality assertion the census makes —
 * and would turn a refused save on a Task the caller is looking at into a Task
 * that appears to have vanished. The distinguishing observation is the SECOND
 * query: it is issued only on a refusal of a non-read action, and it asks
 * about `read`.
 */
import { authorizationRepository } from '../services/AuthorizationRepository';
import { authorizationService } from '../services/AuthorizationService';
import type { AuthorizationActor } from '../services/AuthorizationService';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn() },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { pool } = require('../db/connection');

const TASK_ID = '33333333-4444-4555-8666-777777777777';

const ACTOR: AuthorizationActor = {
  principalId: '11111111-2222-4333-8444-555555555555',
  handle: 'concealment-contract',
  role: 'user',
  scopes: ['tasks:read', 'tasks:write'],
  authenticated: true,
  delegation: null,
};

/** The resolve step reads the module pool; the AUTHORIZED-ids step reads the
 *  queryable it is handed. Keeping them apart is what lets this file count the
 *  authorization queries without counting the resolution. */
function resolvesTo(rows: Array<Record<string, unknown>>): void {
  (pool.query as jest.Mock).mockReset();
  (pool.query as jest.Mock).mockResolvedValue({ rows });
}

/**
 * A queryable that answers the Nth authorization query with the Nth verdict.
 *
 * It answers by ORDER and inspects nothing, which is exactly the weakness
 * round-2 review finding C4-1 (verdict `07971fae`) exploited: changing the
 * second question from `read` to `admin` left every count and every return
 * value green, because a fake that never looks at what was asked can only
 * prove that a question was asked. It is kept for the counts it is good for,
 * and the two assertions that follow measure the ACTION - one at the method
 * boundary, one against the predicate's own rendering.
 */
function verdicts(...allowed: boolean[]): { query: jest.Mock } {
  let call = 0;
  return {
    query: jest.fn(async () => {
      const verdict = allowed[call];
      call += 1;
      if (verdict === undefined) throw new Error(`unexpected authorization query #${call}`);
      return { rows: verdict ? [{ id: TASK_ID }] : [] };
    }),
  };
}

/** The ACTION arguments `authorizePoint` handed to the shared decision, in
 *  order, measured at the method boundary rather than inferred from a count. */
async function actionsAsked(
  action: string,
  ...allowed: boolean[]
): Promise<{ actions: string[]; decision: Awaited<ReturnType<typeof authorizationRepository.authorizePoint>> }> {
  resolvesTo([TASK_ROW]);
  let call = 0;
  const spy = jest.spyOn(authorizationRepository, 'authorizedIds')
    .mockImplementation(async () => {
      const verdict = allowed[call];
      call += 1;
      if (verdict === undefined) throw new Error(`unexpected authorization call #${call}`);
      return new Set(verdict ? [TASK_ID] : []);
    });
  try {
    const decision = await authorizationRepository.authorizePoint(
      ACTOR, 'task', TASK_ID, action as never, { query: async () => ({ rows: [] }) } as never);
    return { actions: spy.mock.calls.map((args) => String(args[3])), decision };
  } finally {
    spy.mockRestore();
  }
}

const TASK_ROW = { id: TASK_ID, visibility: 'private', project_id: null };

describe('authorizePoint answers which refusal it is', () => {
  it('an unresolvable identifier is absent, and asks nothing further', async () => {
    resolvesTo([]);
    const queryable = verdicts();
    const decision = await authorizationRepository.authorizePoint(
      ACTOR, 'task', TASK_ID, 'write', queryable as any);
    expect(decision).toEqual({ exists: false, allowed: false, concealed: true });
    expect(`authorization queries: ${queryable.query.mock.calls.length}`).toBe('authorization queries: 0');
  });

  it('an ALLOWED act is not concealed, and asks the question once', async () => {
    resolvesTo([TASK_ROW]);
    const queryable = verdicts(true);
    const decision = await authorizationRepository.authorizePoint(
      ACTOR, 'task', TASK_ID, 'write', queryable as any);
    expect(`allowed=${decision.allowed} concealed=${decision.concealed}`).toBe('allowed=true concealed=false');
    expect(`authorization queries: ${queryable.query.mock.calls.length}`).toBe('authorization queries: 1');
  });

  it('a refused READ is concealed WITHOUT a second query — it is the same question', async () => {
    resolvesTo([TASK_ROW]);
    const queryable = verdicts(false);
    const decision = await authorizationRepository.authorizePoint(
      ACTOR, 'task', TASK_ID, 'read', queryable as any);
    expect(`allowed=${decision.allowed} concealed=${decision.concealed}`).toBe('allowed=false concealed=true');
    expect(`authorization queries: ${queryable.query.mock.calls.length}`).toBe('authorization queries: 1');
  });

  it('a refused WRITE on a READABLE resource is NOT concealed', async () => {
    // The bound on the repair, at the decision rather than at the route: this
    // caller learns 403, because it can see the resource and has learned
    // nothing it did not already know.
    resolvesTo([TASK_ROW]);
    const queryable = verdicts(false, true);
    const decision = await authorizationRepository.authorizePoint(
      ACTOR, 'task', TASK_ID, 'write', queryable as any);
    expect(`allowed=${decision.allowed} concealed=${decision.concealed}`).toBe('allowed=false concealed=false');
    expect(`authorization queries: ${queryable.query.mock.calls.length}`).toBe('authorization queries: 2');
  });

  it('a refused WRITE on an UNREADABLE resource is concealed — the defect', async () => {
    resolvesTo([TASK_ROW]);
    const queryable = verdicts(false, false);
    const decision = await authorizationRepository.authorizePoint(
      ACTOR, 'task', TASK_ID, 'write', queryable as any);
    expect(`allowed=${decision.allowed} concealed=${decision.concealed}`).toBe('allowed=false concealed=true');
    expect(`authorization queries: ${queryable.query.mock.calls.length}`).toBe('authorization queries: 2');
  });

  it('the SECOND question is `read` — measured at the method boundary', async () => {
    // Round-2 finding C4-1's required repair. A refusal of a non-read action
    // asks the shared decision twice, and the second call's ACTION argument is
    // the whole point: with `admin` there the predicate compiles to FALSE for
    // an ordinary caller, every readable Task is wrongly concealed, and the
    // call-order fake above cannot tell.
    expect((await actionsAsked('write', false, true)).actions).toEqual(['write', 'read']);
    expect((await actionsAsked('write', false, false)).actions).toEqual(['write', 'read']);
    expect((await actionsAsked('write', true)).actions).toEqual(['write']);
    expect((await actionsAsked('read', false)).actions).toEqual(['read']);
    expect((await actionsAsked('admin', false, true)).actions).toEqual(['admin', 'read']);
    expect((await actionsAsked('claim', false, false)).actions).toEqual(['claim', 'read']);
  });

  it('and the second query RENDERS the read predicate, not another one', async () => {
    // The boundary assertion above is a claim about an argument; this one is a
    // claim about the SQL that argument produces, so a repair that renamed the
    // action without changing what it asks would still be caught. The expected
    // text is produced by the PRODUCTION predicate for `read` on the same
    // resource shape - never a string copied into this file - and the control
    // for the control is that `admin` renders something DIFFERENT, without
    // which this assertion would hold for any action at all.
    resolvesTo([TASK_ROW]);
    const queryable = verdicts(false, false);
    await authorizationRepository.authorizePoint(ACTOR, 'task', TASK_ID, 'write', queryable as never);
    const secondSql = String(queryable.query.mock.calls[1][0]);

    const { resource } = authorizationRepository.sqlResource('task');
    const asRead = authorizationService.sqlCondition(ACTOR, 'read', resource, 2).sql;
    const asAdmin = authorizationService.sqlCondition(ACTOR, 'admin', resource, 2).sql;
    // `authorizedIds` ends its statement with the rendered condition, so the
    // comparison is a SUFFIX one and not a containment one: the `read`
    // rendering is the `admin` rendering plus the visibility arms, so
    // `includes(admin)` is true of the read predicate as well and would have
    // been satisfied by either action.
    expect(`read and admin render differently: ${asRead !== asAdmin}`)
      .toBe('read and admin render differently: true');
    expect(`second query ends in the read predicate: ${secondSql.endsWith(asRead)}`)
      .toBe('second query ends in the read predicate: true');
    expect(`second query ends in the admin predicate: ${secondSql.endsWith(asAdmin)}`)
      .toBe('second query ends in the admin predicate: false');
  });

  it('the same contract holds for every non-read action, not only write', async () => {
    // The defect was that concealment followed the VERB. A repair that fixed
    // `write` alone and left `claim`, `verify`, `shepherd`, `release`,
    // `finish` and `admin` disclosing would be the same defect with a smaller
    // surface.
    const observed: string[] = [];
    for (const action of ['admin', 'claim', 'finish', 'release', 'shepherd', 'verify'] as const) {
      resolvesTo([TASK_ROW]);
      const decision = await authorizationRepository.authorizePoint(
        ACTOR, 'task', TASK_ID, action, verdicts(false, false) as any);
      observed.push(`${action}: concealed=${decision.concealed}`);
    }
    expect(observed).toEqual([
      'admin: concealed=true', 'claim: concealed=true', 'finish: concealed=true',
      'release: concealed=true', 'shepherd: concealed=true', 'verify: concealed=true',
    ]);
  });
});
