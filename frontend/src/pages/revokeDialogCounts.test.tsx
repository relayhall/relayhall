// @vitest-environment jsdom
/**
 * revokeDialogCounts.test.tsx — review `f0c51a8e` finding B2, and the third
 * case review `99ba9444` finding B2 found still open behind it.
 *
 * The Warrant API narrows the NAMES of the Tasks a revoke will unassign
 * (holding a warrant is not authority over the Tasks riding it) and reports
 * the COUNT whole, because the count is what a revoke is acknowledged
 * against. This page modelled only the visible array, so a viewer who could
 * read none of them was shown
 *
 *     "None. Revoking it unassigns nothing."
 *
 * and the dialog then submitted `acknowledgeDependents: true`. The backend was
 * right throughout - `WarrantService.revoke` still refuses on the full
 * dependent set - and the human surface in front of it said the opposite.
 *
 * THE PROPERTY, in one sentence: the surface never reports "nothing" unless a
 * successfully parsed response established that the total is zero. Concealed
 * is not nothing, and UNKNOWN IS NOT NOTHING EITHER.
 *
 * WHAT CHANGED IN THIS FILE, and it is a deliberate change to a control:
 * round 2 asserted `dependentSummary({})` equals `{tasks: [], total: 0,
 * concealed: 0}`. That assertion enshrined the very coercion review
 * `99ba9444` B2 named as the shipped defect - a response that establishes
 * nothing read as a response that establishes zero. The parser now returns an
 * UNCOUNTED state there, and the surviving half of the old assertion (an
 * older response shape with a `tasks` array and no counts still degrades to
 * the truthful "these are all of them") is kept below unchanged.
 *
 * These are helper-level assertions. They do NOT establish that the shipped
 * page consults the helper: that is `revokeDialogSeam.test.tsx`, which renders
 * the page against mocked routes, because a rule that can only be observed by
 * rendering a page is a rule nobody can pin from here.
 */
import { describe, expect, test } from 'vitest';
import {
  acknowledgementReady,
  dependentTasksCount,
  readDependentCount,
  revokeConfirmLabel,
  unassignmentSentence,
  warrantLinkageCount,
  type DependentCount,
} from './AccessManagerPage';

const NOTHING = /nothing is unassigned|unassigns nothing/i;
const A_TASK = { id: 'a', title: 't', status: 'todo' };

const counted = (tasks: typeof A_TASK[], total: number, concealed: number): DependentCount =>
  ({ state: 'counted', tasks, total, concealed });

describe('the revoke surface never says nothing while something is concealed', () => {
  test('the reported case: one carried Task, none of it readable', () => {
    // Exactly what the round-2 fixture produced: tasks [], total 1,
    // concealed 1. The old page said "unassigns nothing" here.
    const sentence = unassignmentSentence(counted([], 1, 1));
    expect(sentence).not.toMatch(NOTHING);
    expect(sentence).toContain('1 not-yet-terminal Task');
    expect(sentence).toContain('UNASSIGNED');
    expect(sentence).toMatch(/cannot be named|none of them can be named/i);
  });

  test('says "nothing" ONLY when a parsed response established a zero total', () => {
    // The negative half. Without it a repair that never says "nothing" at all
    // would pass the assertion above and lie in the other direction.
    expect(unassignmentSentence(counted([], 0, 0))).toMatch(NOTHING);
  });

  test.each([
    ['all concealed', 3, 3],
    ['some concealed', 3, 1],
    ['none concealed', 3, 0],
  ])('reports the FULL count when %s', (_label, total, concealed) => {
    // The nameable ones are the ones not concealed, so these are states the
    // parser would also accept - a sentence asserted against an arrangement
    // the normalizer rejects would prove nothing about the shipped surface.
    const named = Array.from({ length: total - concealed }, (_v, n) => ({ ...A_TASK, id: `t${n}` }));
    expect(dependentTasksCount({ tasks: named, total, concealed }).state).toBe('counted');
    const sentence = unassignmentSentence(counted(named, total, concealed));
    expect(sentence).not.toMatch(NOTHING);
    // The operator decides on the total, never on what happens to be nameable.
    expect(sentence).toContain(`${total} not-yet-terminal Task`);
  });

  test('mentions the withheld ones exactly when there are any', () => {
    const one = [A_TASK];
    const two = [A_TASK, { ...A_TASK, id: 'b' }];
    expect(unassignmentSentence(counted(one, 2, 1))).toContain('1 of them cannot be named');
    expect(unassignmentSentence(counted(two, 2, 0))).not.toMatch(/cannot be named/i);
  });
});

/**
 * Review `99ba9444` B2. The two states the old model had no room for, which
 * is why it borrowed zero for both.
 */
describe('an unknown count is never a zero count', () => {
  test('COUNTING says it is still counting, and claims nothing', () => {
    const sentence = unassignmentSentence({ state: 'counting' });
    expect(sentence).not.toMatch(NOTHING);
    expect(sentence).toMatch(/still counting/i);
  });

  test('UNCOUNTED says it could not count, and claims nothing', () => {
    const sentence = unassignmentSentence({ state: 'uncounted', reason: 'the network refused' });
    expect(sentence).not.toMatch(NOTHING);
    expect(sentence).toMatch(/could not count/i);
    expect(sentence).toContain('the network refused');
  });

  test('the acknowledgement is offered ONLY on a counted count', () => {
    expect(acknowledgementReady({ state: 'counting' })).toBe(false);
    expect(acknowledgementReady({ state: 'uncounted', reason: 'x' })).toBe(false);
    expect(acknowledgementReady(counted([], 0, 0))).toBe(true);
    expect(acknowledgementReady(counted([], 4, 4))).toBe(true);
  });

  test('the confirm label carries the TOTAL, not the nameable length', () => {
    // The mutation the round-3 verdict named: a label rebuilt from
    // `dependents.tasks.length` would read "Revoke" here, for three Tasks.
    expect(revokeConfirmLabel(counted([], 3, 3))).toBe('Revoke and unassign 3');
    expect(revokeConfirmLabel(counted([A_TASK], 4, 3))).toBe('Revoke and unassign 4');
    expect(revokeConfirmLabel(counted([], 0, 0))).toBe('Revoke');
    expect(revokeConfirmLabel({ state: 'counting' })).not.toMatch(/^Revoke and unassign/);
    expect(revokeConfirmLabel({ state: 'uncounted', reason: 'x' })).not.toMatch(/^Revoke and unassign/);
  });
});

describe('the counts survive the read', () => {
  test('carries total and concealed off the response', () => {
    expect(dependentTasksCount({ tasks: [A_TASK], total: 4, concealed: 3 }))
      .toEqual({ state: 'counted', tasks: [A_TASK], total: 4, concealed: 3 });
  });

  test('a response without the counts degrades to the TRUTHFUL reading', () => {
    // Not to zero. An older or partial response shape must read as "these are
    // all of them", which is what it used to mean, and never as "there are
    // none" - the failure this whole file exists for.
    expect(dependentTasksCount({ tasks: [A_TASK] }))
      .toEqual({ state: 'counted', tasks: [A_TASK], total: 1, concealed: 0 });
    // An explicitly EMPTY list under the old shape is a genuine none: the
    // response did carry the list, and the list is empty.
    expect(dependentTasksCount({ tasks: [] })).toEqual({ state: 'counted', tasks: [], total: 0, concealed: 0 });
  });

  test('a response that establishes NOTHING reads as uncounted, not as zero', () => {
    // The round-2 control asserted `{tasks: [], total: 0, concealed: 0}` here.
    // That is the shipped defect of review `99ba9444` B2 written down as an
    // expectation, so it is gone.
    expect(dependentTasksCount({}).state).toBe('uncounted');
    expect(dependentTasksCount(undefined).state).toBe('uncounted');
    expect(dependentTasksCount(null).state).toBe('uncounted');
    expect(dependentTasksCount({ total: 0, concealed: 0 }).state).toBe('uncounted');
    expect(unassignmentSentence(dependentTasksCount({}))).not.toMatch(NOTHING);
  });

  test('BOTH surfaces read through the same normalizer', () => {
    // The details panel had a second, laxer copy: it defaulted a missing
    // `concealed` to zero instead of deriving the difference, so a linkage
    // response that omitted it under-reported what is withheld.
    expect(warrantLinkageCount({ carriedTasks: [A_TASK], carriedTotal: 4 }))
      .toEqual({ state: 'counted', tasks: [A_TASK], total: 4, concealed: 3 });
    expect(warrantLinkageCount({ carriedTasks: [A_TASK], carriedTotal: 4, carriedConcealed: 3 }))
      .toEqual(dependentTasksCount({ tasks: [A_TASK], total: 4, concealed: 3 }));
    expect(warrantLinkageCount({}).state).toBe('uncounted');
  });
});

/**
 * Review `99ba9444`, non-blocking observations: `typeof value === 'number'`
 * admits NaN, Infinity, negatives and fractions, and the shipped helper duly
 * printed the impossible sentence "3 ... Tasks ... 4 of them cannot be named"
 * for `{total: 3, concealed: 4}`.
 */
describe('a count that cannot be true is refused, not narrated', () => {
  test.each([
    ['NaN total', { tasks: [], total: NaN, concealed: 0 }],
    ['Infinite total', { tasks: [], total: Infinity, concealed: 0 }],
    ['negative total', { tasks: [], total: -1, concealed: 0 }],
    ['fractional total', { tasks: [], total: 1.5, concealed: 0 }],
    ['NaN concealed', { tasks: [], total: 2, concealed: NaN }],
    ['negative concealed', { tasks: [], total: 2, concealed: -1 }],
    ['fractional concealed', { tasks: [], total: 2, concealed: 0.5 }],
    ['string total', { tasks: [], total: '3', concealed: 0 }],
    ['null total', { tasks: [], total: null, concealed: 0 }],
    ['more concealed than there are', { tasks: [], total: 3, concealed: 4 }],
    ['more named than there are', { tasks: [A_TASK, { ...A_TASK, id: 'b' }], total: 1, concealed: 0 }],
    ['fewer named than are claimed nameable', { tasks: [], total: 3, concealed: 0 }],
    // ROUND 1 FINDING T1/P2: the one-sided predicate accepted this.
    // Two named plus two withheld is FOUR, for a total of three, and it
    // was narrated as "3 … Tasks … 2 of them cannot be named" beside two
    // named ones — and acknowledgeable. The named and the withheld must
    // ADD UP, so the invariant is an equality.
    ['more classified than there are', { tasks: [A_TASK, { ...A_TASK, id: 'b' }], total: 3, concealed: 2 }],
    ['every name repeated in the withheld count', { tasks: [A_TASK], total: 1, concealed: 1 }],
    ['tasks is not a list', { tasks: 'three', total: 3, concealed: 0 }],
  ])('%s is UNCOUNTED', (_label, payload) => {
    const count = dependentTasksCount(payload);
    expect(count.state).toBe('uncounted');
    const sentence = unassignmentSentence(count);
    expect(sentence).not.toMatch(NOTHING);
    expect(sentence).not.toMatch(/cannot be named here/i);
    expect(acknowledgementReady(count)).toBe(false);
  });

  test('the named impossible sentence is never composed', () => {
    // The reviewer probe: `{total: 3, concealed: 4}` printed
    // "3 not-yet-terminal Tasks ... 4 of them cannot be named here".
    expect(unassignmentSentence(dependentTasksCount({ tasks: [], total: 3, concealed: 4 })))
      .not.toContain('4 of them cannot be named');
  });

  test('the named and the withheld ADD UP, in both directions', () => {
    // Round 1 finding P2. The equality is stated here on its own, because a
    // test.each row can be satisfied by a predicate that happens to reject
    // that case for another reason.
    const two = [A_TASK, { ...A_TASK, id: 'b' }];
    expect(dependentTasksCount({ tasks: two, total: 3, concealed: 2 }).state).toBe('uncounted');
    expect(dependentTasksCount({ tasks: two, total: 3, concealed: 0 }).state).toBe('uncounted');
    // And the arrangement that DOES add up is still counted, so the rule did
    // not simply become "refuse everything".
    expect(dependentTasksCount({ tasks: two, total: 3, concealed: 1 }))
      .toEqual({ state: 'counted', tasks: two, total: 3, concealed: 1 });
  });

  test('the normalizer is the same function underneath', () => {
    expect(readDependentCount([], 3, 4).state).toBe('uncounted');
    expect(readDependentCount([], 3, 3)).toEqual({ state: 'counted', tasks: [], total: 3, concealed: 3 });
  });
});
