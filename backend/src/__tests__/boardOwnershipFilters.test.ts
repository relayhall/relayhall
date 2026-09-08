/**
 * Board Assignee filters (CB-4).
 *
 * CB-2 added owner/mine/unassigned to GET /tasks, but the board UI renders
 * from GET /tasks/board — so the predicates had to reach queryBoardColumns
 * too. Filtering server-side (rather than in the client) is what keeps each
 * column's total honest, since the client only ever holds one page per column.
 */
import { buildBoardOwnershipFilters } from '../utils/boardFilters';

describe('buildBoardOwnershipFilters', () => {
  const principalId = '11111111-1111-4111-8111-111111111111';

  it('returns nothing when no Assignee filter is requested', () => {
    expect(buildBoardOwnershipFilters({}, null)).toEqual({});
  });

  it('maps mine=true to the caller principal id', () => {
    expect(buildBoardOwnershipFilters({ mine: 'true' }, principalId))
      .toEqual({ ownerPrincipalId: principalId });
  });

  it('signals empty when mine=true but no principal resolved', () => {
    // The caller owns nothing yet; an empty board beats an error while the
    // substrate is still rolling out.
    expect(buildBoardOwnershipFilters({ mine: 'true' }, null)).toEqual({ __empty: true });
  });

  it('maps owner=<handle>', () => {
    expect(buildBoardOwnershipFilters({ owner: 'dashboard_user' }, principalId))
      .toEqual({ ownerHandle: 'dashboard_user' });
  });

  it('maps unassigned=true', () => {
    expect(buildBoardOwnershipFilters({ unassigned: 'true' }, principalId))
      .toEqual({ unassigned: true });
  });

  it('ignores non-"true" values rather than guessing intent', () => {
    expect(buildBoardOwnershipFilters({ mine: 'false', unassigned: '1' }, principalId)).toEqual({});
  });

  it('ignores an empty owner handle', () => {
    expect(buildBoardOwnershipFilters({ owner: '' }, principalId)).toEqual({});
  });
});

describe('buildBoardOwnershipFilters hostile input', () => {
  const principalId = '11111111-1111-4111-8111-111111111111';

  // Every one of these params NARROWS the board. Express's qs parser produces
  // arrays for ?p[]=x and ?p=x&p=y, and objects for ?p[k]=v. Ignoring those
  // shapes drops the filter and returns the WHOLE board — a filter failing
  // open. Each case must match nothing instead.
  it.each([
    ['owner array', { owner: ['system', 'other'] }],
    ['owner single-element array', { owner: ['system'] }],
    ['owner object', { owner: { foo: 'bar' } }],
    ['mine array', { mine: ['true', 'true'] }],
    ['mine object', { mine: { a: 'true' } }],
    ['unassigned array', { unassigned: ['true', 'true'] }],
    ['unassigned object', { unassigned: { a: 'true' } }],
  ])('fails CLOSED on %s', (_label, query) => {
    expect(buildBoardOwnershipFilters(query as Record<string, unknown>, principalId))
      .toEqual({ __empty: true });
  });

  it('still accepts plain scalars', () => {
    expect(buildBoardOwnershipFilters({ owner: 42 }, principalId)).toEqual({ ownerHandle: '42' });
    expect(buildBoardOwnershipFilters({ mine: true }, principalId))
      .toEqual({ ownerPrincipalId: principalId });
  });
});
