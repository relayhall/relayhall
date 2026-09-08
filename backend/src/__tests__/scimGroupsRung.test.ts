/**
 * THE SCIM `/Groups` RUNG — the parts that are true of the SOURCE and of pure
 * functions, and the A-L34 build gate.
 *
 * RH-LENSES-a, card `74e02a05`. Acceptance `A-L8`, `A-L9`, `A-L11` (the shape
 * halves), `A-L12`, `A-L34`.
 *
 * What is NOT here, and where it is instead: every row that asserts what a
 * REQUEST does to STORED ROWS — `A-L10`, `A-L13`, `A-L14`, `A-L15`, and the
 * uniqueness and mutability refusals of `A-L11` — is measured against a real
 * migrated PostgreSQL through the production router in
 * `directoryCarriageLive.test.ts`. A mocked pool answers what it was told to
 * answer, so a suite built on one would be measuring its own fixtures.
 */
import express from 'express';

import {
  RATIFIED_SCIM_AMENDMENTS,
  SCIM_GROUPS_RUNG_AMENDMENT,
  scimAmendmentRatified,
} from '../services/identity/scimAmendments';
import { ScimError } from '../services/identity/ScimProvisioningService';
import {
  SCIM_GROUP_MAPPED_ATTRIBUTES,
  SCIM_GROUP_SCHEMA,
  parsePatchPath,
  readMembers,
  scimGroupProvisioningService,
  scimGroupResource,
} from '../services/identity/ScimGroupProvisioning';
import scimRouter, { SCIM_ROUTE_CENSUS } from '../routes/scim';

/** Ask the ROUTER what it serves — the same shape `scimProvisioningContract`
 *  uses, because two implementations of "what does this router serve" is one
 *  more than the question has. */
function routesOf(router: any): string[] {
  const found: string[] = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods as Record<string, boolean>)) {
      if (enabled) found.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return found.sort();
}

const GROUP_ROUTES = [
  'DELETE /v2/Groups/:id',
  'GET /v2/Groups',
  'GET /v2/Groups/:id',
  'PATCH /v2/Groups/:id',
  'POST /v2/Groups',
  'PUT /v2/Groups/:id',
];

// ── A-L34 — the build gate ────────────────────────────────────────────────

describe('A-L34: the Groups slice is ABSENT unless A24.1 is recorded ratified', () => {
  it('records A24.1 with the sitting that allowed it and the companion it folds into', () => {
    const amendment = RATIFIED_SCIM_AMENDMENTS.find((a) => a.id === SCIM_GROUPS_RUNG_AMENDMENT);
    expect(amendment).toBeDefined();
    // The row carries WHERE the owner said yes, so the claim is checkable
    // rather than merely present.
    expect(amendment!.ratifiedBy).toContain('2026-09-04');
    expect(amendment!.ratifiedBy).toContain('60307311');
    expect(amendment!.foldsInto).toContain('0c321078');
    // A24's negative half is unchanged — the amendment says so itself, which
    // is the sentence that keeps it the smallest expressible widening.
    expect(amendment!.authorizes).toContain("A24's negative half is unchanged");
  });

  it('the gate DISCRIMINATES — handed an empty register it answers false', () => {
    // Without this the assertion below would be satisfied by a function that
    // returns true unconditionally, which is a gate that cannot close.
    expect(scimAmendmentRatified('A24.1', [])).toBe(false);
    expect(scimAmendmentRatified('A99.9')).toBe(false);
    expect(scimAmendmentRatified('A24.1')).toBe(true);
  });

  it('RED PROOF: with the amendment unrecorded, the census AND the router lose the six', () => {
    // The gate measured by running it, not by reading the source. The module
    // is re-required with an EMPTY ratification register, and both halves --
    // what the census claims and what the router serves -- must lose the rung
    // together, because both read one decision.
    jest.resetModules();
    jest.doMock('../services/identity/scimAmendments', () => ({
      ...jest.requireActual('../services/identity/scimAmendments'),
      // Only the decision is replaced. Spreading the actual module first keeps
      // every sibling export alive: a wholesale mock drops them, and the
      // symptom is a hang rather than a failure.
      RATIFIED_SCIM_AMENDMENTS: [],
      scimAmendmentRatified: () => false,
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reloaded = require('../routes/scim');
    const census: readonly string[] = reloaded.SCIM_ROUTE_CENSUS;
    const served = routesOf(reloaded.default);
    for (const route of GROUP_ROUTES) {
      expect(census).not.toContain(route);
      expect(served).not.toContain(route);
    }
    // The Users rung is untouched — the gate closes one slice, not the family.
    expect(census).toContain('POST /v2/Users');
    expect(served).toContain('POST /v2/Users');
    // And the two halves still AGREE, which is the property A-L8 protects: a
    // gate that removed the routes and left the census claiming them would
    // have swapped one defect for another.
    expect(served).toEqual([...census].sort());
    jest.dontMock('../services/identity/scimAmendments');
    jest.resetModules();
  });
});

// ── A-L8 — the census and the router agree ────────────────────────────────

describe('A-L8: SCIM_ROUTE_CENSUS and the router AGREE', () => {
  it('serves exactly what the census names, counted structurally', () => {
    // NO LITERAL TOTAL. v5 and v6 of the design wrote one; a literal total is
    // falsified by any correct new route while saying nothing at all about a
    // route that skipped the census, which is the thing this row exists to
    // catch. The agreement property is strictly stronger and carries no number.
    expect(routesOf(scimRouter)).toEqual([...SCIM_ROUTE_CENSUS].sort());
  });

  it('a census line without a handler fails too — the other direction', () => {
    const shadow = express.Router();
    for (const entry of SCIM_ROUTE_CENSUS) {
      const [method, routePath] = entry.split(' ');
      if (entry === 'GET /v2/Groups') continue; // the omitted handler
      (shadow as any)[method.toLowerCase()](routePath, (_r: any, s: any) => s.end());
    }
    expect(routesOf(shadow)).not.toEqual([...SCIM_ROUTE_CENSUS].sort());
  });

  it('names the six Groups routes and no seventh', () => {
    expect([...SCIM_ROUTE_CENSUS].filter((entry) => entry.includes('/v2/Groups')).sort())
      .toEqual(GROUP_ROUTES);
  });

  it('the terminal 404 is MIDDLEWARE and adds no census entry', () => {
    // Design §4.6: an unrouted /scim/v2/* path answered a NON-SCIM body a
    // conforming client reads as a transport failure. The handler that fixes
    // that is not a resource surface, so it is `router.use` and the census
    // stays an enumeration of what this family SERVES.
    const terminal = (scimRouter as any).stack.filter((layer: any) => !layer.route
      && layer.regexp && layer.regexp.source.includes('v2'));
    expect(terminal.length).toBeGreaterThanOrEqual(1);
  });
});

// ── A-L9 — discovery tells the truth ──────────────────────────────────────

describe('A-L9: the Group schema declares only what the endpoint honours', () => {
  it('maps displayName, externalId and members, and nothing else', () => {
    expect([...SCIM_GROUP_MAPPED_ATTRIBUTES]).toEqual(['displayName', 'externalId', 'members']);
  });

  it('renders a resource on the mapped attributes only', () => {
    const resource = scimGroupResource({
      id: '11111111-1111-4111-8111-111111111111',
      identityProviderId: '22222222-2222-4222-8222-222222222222',
      externalGroupRef: 'CN=Engineering,OU=Groups',
      displayName: 'Engineering',
      scimExternalId: 'ext-9',
      firstSeenAt: '2026-09-05T00:00:00.000Z',
      lastSeenAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
      members: ['33333333-3333-4333-8333-333333333333'],
    });
    expect(resource.schemas).toEqual([SCIM_GROUP_SCHEMA]);
    expect(resource.displayName).toBe('Engineering');
    expect(resource.externalId).toBe('ext-9');
    expect((resource.members as any[])[0].type).toBe('User');
    expect((resource.meta as any).resourceType).toBe('Group');
    // The board's own ref is NOT on the wire unless the provider declared the
    // attribute that carries it: it is our storage key, and a client that
    // learned it would start sending it back.
    expect(JSON.stringify(resource)).not.toContain('externalGroupRef');
  });

  it('falls back to the ref for displayName rather than emitting a required attribute empty', () => {
    // RFC 7643 §4.2 makes displayName REQUIRED. The claim producer never
    // supplies one, so a reference first seen at a login has none — and a
    // required attribute rendered null is a schema violation a client may
    // reject outright.
    const resource = scimGroupResource({
      id: '11111111-1111-4111-8111-111111111111',
      identityProviderId: '22222222-2222-4222-8222-222222222222',
      externalGroupRef: '/engineering',
      displayName: null,
      scimExternalId: null,
      firstSeenAt: '2026-09-05T00:00:00.000Z',
      lastSeenAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
      members: [],
    });
    expect(resource.displayName).toBe('/engineering');
    expect(resource.externalId).toBeUndefined();
  });
});

// ── A-L12 — the enumerated PATCH path set, and nothing else ───────────────

describe('A-L12: PATCH honours an enumerated path set', () => {
  it('admits exactly displayName, members and members[value eq "…"]', () => {
    expect(parsePatchPath('displayName')).toEqual({ target: 'displayName' });
    expect(parsePatchPath('members')).toEqual({ target: 'members' });
    expect(parsePatchPath('members[value eq "abc"]')).toEqual({ target: 'members-filtered', value: 'abc' });
    expect(parsePatchPath('members[ value  eq  "abc" ]')).toEqual({ target: 'members-filtered', value: 'abc' });
  });

  it.each([
    ['a path outside the set', 'externalId'],
    ['a nested attribute', 'members.value'],
    ['a filter on the wrong attribute', 'displayName[value eq "x"]'],
    ['a filter with a different operator', 'members[value co "x"]'],
    ['the whole-resource form', null],
    ['the empty path', ''],
    // A path this endpoint silently IGNORED would be a change the client
    // believes it made — which is worse than a refusal, because nothing tells
    // the client to try again.
    ['an unrecognised sub-resource', 'members[type eq "Group"]'],
  ])('refuses %s with 400 invalidPath', (_label, path) => {
    let thrown: unknown;
    try { parsePatchPath(path as string | null); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ScimError);
    expect((thrown as ScimError).status).toBe(400);
    expect((thrown as ScimError).scimType).toBe('invalidPath');
  });
});

// ── NG-1 and the member bound ─────────────────────────────────────────────

describe('the negatives this rung refuses on purpose', () => {
  it('NG-1: a nested group member is refused as a NESTED GROUP, before any lookup', () => {
    // The order is the point. Refusing it as "an Account I cannot find" would
    // tell a client to go and provision a User that does not exist, and the
    // real reason -- derived membership would become a transitive closure over
    // a graph the board does not own -- would never reach anybody.
    let thrown: unknown;
    try {
      readMembers({ members: [{ value: 'g-1', type: 'Group' }] });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ScimError);
    expect((thrown as ScimError).scimType).toBe('invalidValue');
    expect((thrown as ScimError).message).toContain('nested groups');
  });

  it('accepts an omitted type and an explicit User', () => {
    expect(readMembers({ members: [{ value: 'a' }, { value: 'b', type: 'User' }] })).toEqual(['a', 'b']);
    expect(readMembers({})).toEqual([]);
    expect(readMembers({ members: [] })).toEqual([]);
  });

  it('refuses an oversized membership rather than TRUNCATING it', () => {
    // A truncated membership is a silent access change: the people it dropped
    // lose their derived membership and nothing anywhere says why.
    const previous = process.env.DIRECTORY_SCIM_MAX_MEMBERS;
    process.env.DIRECTORY_SCIM_MAX_MEMBERS = '2';
    try {
      let thrown: unknown;
      try {
        readMembers({ members: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] });
      } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(ScimError);
      expect((thrown as ScimError).status).toBe(413);
      expect((thrown as ScimError).scimType).toBe('tooMany');
      // The refusal names the bound so an administrator can raise it
      // deliberately instead of guessing.
      expect((thrown as ScimError).message).toContain('DIRECTORY_SCIM_MAX_MEMBERS');
      // And the bound is REACHED, not merely declared: two still pass.
      expect(readMembers({ members: [{ value: 'a' }, { value: 'b' }] })).toEqual(['a', 'b']);
    } finally {
      if (previous === undefined) delete process.env.DIRECTORY_SCIM_MAX_MEMBERS;
      else process.env.DIRECTORY_SCIM_MAX_MEMBERS = previous;
    }
  });

  it('takes the ref from the DECLARED attribute, verbatim, and refuses its absence by name', () => {
    const byExternalId: any = { id: 'p', scimGroupRefAttribute: 'externalId' };
    const byDisplayName: any = { id: 'p', scimGroupRefAttribute: 'displayName' };
    const body = { displayName: 'Engineering', externalId: 'CN=Eng,OU=Groups' };
    expect(scimGroupProvisioningService.refFor(byExternalId, body)).toBe('CN=Eng,OU=Groups');
    expect(scimGroupProvisioningService.refFor(byDisplayName, body)).toBe('Engineering');

    // NO SILENT FALLBACK. A fallback to the other attribute is how two
    // references for one real group get created, each binding half the people.
    let thrown: unknown;
    try { scimGroupProvisioningService.refFor(byExternalId, { displayName: 'Engineering' }); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ScimError);
    expect((thrown as ScimError).scimType).toBe('invalidValue');
    expect((thrown as ScimError).message).toContain('externalId');
  });
});
