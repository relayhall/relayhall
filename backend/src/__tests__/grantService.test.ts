/**
 * GrantService semantics (RH-P2.3).
 *
 * Load-bearing claims: grantees are principals or Groups (the 078 seam,
 * consumed at AZ-S1); a principal grantee must be ACTIVE, a group grantee
 * must exist; the
 * resource-type and verb vocabularies are enforced; resourceId is a full
 * UUID or the type-wide wildcard (null); expiry must be future; a duplicate
 * (grantee, resource, verb) is 409; revocation is a DELETE returning the
 * removed row; the P2.5 seam condition honours wildcard + expiry.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('../services/PrincipalService', () => ({
  principalService: { getPrincipalById: jest.fn() },
}));
jest.mock('../services/AuditService', () => ({
  auditService: { record: jest.fn() },
}));

import { pool } from '../db/connection';
import { principalService } from '../services/PrincipalService';
import { auditService } from '../services/AuditService';
import { grantService, GrantError, GRANT_RESOURCE_TYPES, GRANT_VERBS } from '../services/GrantService';

const GRANTEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESOURCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GRANT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function grantRow(overrides: Record<string, any> = {}): any {
  return {
    id: GRANT_ID, grantee_type: 'principal', grantee_id: GRANTEE,
    resource_type: 'task', resource_id: RESOURCE, verb: 'read',
    granted_by_principal_id: 'owner', expires_at: null, created_at: 'now',
    ...overrides,
  };
}

function armActivePrincipal(status = 'active'): void {
  (principalService.getPrincipalById as jest.Mock).mockResolvedValue({ id: GRANTEE, status });
}

/**
 * The AUTHORITY-MUTATION lookup (owner ruling `70af4d82` §1.1) runs on the SAME
 * mocked pool as the insert, so a blanket `mockResolvedValue` would answer it
 * with a grant row whose `key` is undefined and every `surface` grant would
 * refuse for the wrong reason. This dispatches on the query text, so a control
 * that means "this id is not an authority-mutation surface" says exactly that.
 */
function armPool(rows: any[], authorityMutationRows: any[] = []): void {
  (pool.query as jest.Mock).mockImplementation((text: string) => Promise.resolve(
    String(text).includes('FROM access_surfaces') ? { rows: authorityMutationRows } : { rows },
  ));
}

async function expectError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected GrantError ${code}, got success`);
  } catch (e) {
    if (e instanceof GrantError) {
      expect(e.status).toBe(status);
      expect(e.code).toBe(code);
      return;
    }
    throw e;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  const client = {
    query: jest.fn((text: string, params?: unknown[]) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      return (pool.query as jest.Mock)(text, params);
    }),
    release: jest.fn(),
  };
  (pool.connect as jest.Mock).mockResolvedValue(client);
  (auditService.record as jest.Mock).mockResolvedValue({ id: 'audit-event' });
});

describe('create', () => {
  it('creates a principal grant with a specific resource', async () => {
    armActivePrincipal();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [grantRow()] });
    const grant = await grantService.create(
      { granteeId: GRANTEE, resourceType: 'task', resourceId: RESOURCE, verb: 'read' },
      'owner',
    );
    expect(grant.granteeType).toBe('principal');
    expect(grant.resourceId).toBe(RESOURCE);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'grant.create', resourceId: GRANT_ID }),
      expect.any(Object),
    );
  });

  it('accepts a type-wide wildcard when resourceId is omitted', async () => {
    armActivePrincipal();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [grantRow({ resource_id: null })] });
    const grant = await grantService.create(
      { granteeId: GRANTEE, resourceType: 'report', verb: 'read' },
      'owner',
    );
    expect(grant.resourceId).toBeNull();
    const insertParams = (pool.query as jest.Mock).mock.calls[0][1];
    expect(insertParams[3]).toBeNull(); // resource_id bound as NULL
  });

  it("refuses a granteeType outside the vocabulary ('principal' | 'group' since AZ-S1)", async () => {
    await expectError(
      grantService.create({ granteeType: 'team', granteeId: GRANTEE, resourceType: 'task', verb: 'read' }, 'owner'),
      422, 'INVALID_GRANT_VALUE',
    );
    expect(pool.query as jest.Mock).not.toHaveBeenCalled();
  });

  it('accepts a group grantee that resolves to an existing group (the 078 seam, consumed at AZ-S1)', async () => {
    (pool.query as jest.Mock).mockImplementation((text: string) => {
      if (/SELECT id FROM groups WHERE id/.test(text)) return Promise.resolve({ rows: [{ id: GRANTEE }] });
      return Promise.resolve({ rows: [grantRow({ grantee_type: 'group' })] });
    });
    const grant = await grantService.create(
      { granteeType: 'group', granteeId: GRANTEE, resourceType: 'task', resourceId: RESOURCE, verb: 'read' }, 'owner',
    );
    expect(grant.granteeType).toBe('group');
    expect(principalService.getPrincipalById).not.toHaveBeenCalled();
  });

  it('refuses a group grantee that resolves to no group', async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
    await expectError(
      grantService.create({ granteeType: 'group', granteeId: GRANTEE, resourceType: 'task', verb: 'read' }, 'owner'),
      422, 'GRANTEE_NOT_FOUND',
    );
  });

  it('refuses a grantee that resolves to no principal', async () => {
    (principalService.getPrincipalById as jest.Mock).mockResolvedValue(null);
    await expectError(
      grantService.create({ granteeId: GRANTEE, resourceType: 'task', verb: 'read' }, 'owner'),
      422, 'GRANTEE_NOT_FOUND',
    );
  });

  it('refuses a disabled grantee', async () => {
    armActivePrincipal('disabled');
    await expectError(
      grantService.create({ granteeId: GRANTEE, resourceType: 'task', verb: 'read' }, 'owner'),
      422, 'GRANTEE_DISABLED',
    );
  });

  it('enforces the resource-type and verb vocabularies', async () => {
    armActivePrincipal();
    await expectError(
      grantService.create({ granteeId: GRANTEE, resourceType: 'session', verb: 'read' }, 'owner'),
      422, 'INVALID_GRANT_VALUE',
    );
    await expectError(
      grantService.create({ granteeId: GRANTEE, resourceType: 'task', verb: 'manage' }, 'owner'),
      422, 'INVALID_GRANT_VALUE',
    );
  });

  it('refuses a non-UUID resourceId and a past expiry', async () => {
    armActivePrincipal();
    await expectError(
      grantService.create({ granteeId: GRANTEE, resourceType: 'task', resourceId: 'not-a-uuid', verb: 'read' }, 'owner'),
      422, 'INVALID_GRANT_VALUE',
    );
    await expectError(
      grantService.create({ granteeId: GRANTEE, resourceType: 'task', verb: 'read', expiresAt: '2000-01-01T00:00:00Z' }, 'owner'),
      422, 'INVALID_GRANT_VALUE',
    );
  });

  it('maps a duplicate to 409', async () => {
    armActivePrincipal();
    (pool.query as jest.Mock).mockRejectedValue(new Error('duplicate key value violates unique constraint "grants_..."'));
    await expectError(
      grantService.create({ granteeId: GRANTEE, resourceType: 'task', resourceId: RESOURCE, verb: 'read' }, 'owner'),
      409, 'GRANT_EXISTS',
    );
  });

  it('the closed resource-type list includes Surface and Blueprint while the five verbs are unchanged', async () => {
    armActivePrincipal();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [grantRow()] });
    // SETGOV (A25.5, AZ-A5 clause 1): a DELIBERATE CONTRACT CHANGE, not a
    // weakening. `078_grants_substrate.sql` declares this list is where future
    // object types land, and `surface` is stricter than any of the eight - see
    // the closure controls below.
    expect(GRANT_RESOURCE_TYPES).toEqual(['task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'plugin', 'surface', 'blueprint']);
    expect(GRANT_VERBS).toEqual(['read', 'write', 'use', 'invoke', 'admin']);
  });

  it('the ratified object types including Blueprint keep the typed wildcard (078: resource_id NULL is all objects of the type)', async () => {
    armActivePrincipal();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [grantRow()] });
    for (const resourceType of GRANT_RESOURCE_TYPES.filter((type) => type !== 'surface')) {
      await grantService.create({ granteeId: GRANTEE, resourceType, verb: 'read' }, 'owner');
    }
  });

  it("'surface' requires an explicit resourceId and admits read/write only (AZ-A5 clause 3)", async () => {
    armActivePrincipal();
    // The catalogue answers EMPTY: this id names a governable surface that is
    // not one of the three the ruling withholds - the positive control for the
    // closure below.
    armPool([grantRow()]);
    await grantService.create({ granteeId: GRANTEE, resourceType: 'surface', resourceId: RESOURCE, verb: 'read' }, 'owner');
    await grantService.create({ granteeId: GRANTEE, resourceType: 'surface', resourceId: RESOURCE, verb: 'write' }, 'owner');
  });

  it("NEGATIVE CONTROL: a 'surface' grant naming an AUTHORITY-MUTATION surface is refused (ruling 70af4d82 §1.1)", async () => {
    armActivePrincipal();
    // #15, #17 and #18 belong to NO Access bundle until the rule-4 arm lands
    // (card 3e76cfcc). The arm reads BOTH authority stores, so a `surface`
    // grant naming one of them confers exactly what a membership would - the
    // reduced seed alone leaves this door open, which is why it is closed here.
    armPool([grantRow()], [{ id: RESOURCE, key: 'settings.access-grants' }]);
    await expectError(
      grantService.create({ granteeId: GRANTEE, resourceType: 'surface', resourceId: RESOURCE, verb: 'write' }, 'owner'),
      422, 'AUTHORITY_MUTATION_SURFACE',
    );
  });

  it('the refusal NAMES the surface and the missing arm, and is audited (ruling 70af4d82 §1.1)', async () => {
    armActivePrincipal();
    armPool([grantRow()], [{ id: RESOURCE, key: 'settings.access-profiles-groups' }]);
    await expect(grantService.create(
      { granteeId: GRANTEE, resourceType: 'surface', resourceId: RESOURCE, verb: 'read' },
      { principalId: 'owner', handle: 'root', authMethod: 'dashboard_jwt' },
    )).rejects.toThrow(/settings\.access-profiles-groups[\s\S]*3e76cfcc/);
    const denial = (auditService.record as jest.Mock).mock.calls
      .map(([write]) => write)
      .find((write) => write.action === 'access_bundle.refused');
    expect(denial).toBeDefined();
    expect(denial.outcome).toBe('denied');
    expect(denial.metadata).toMatchObject({
      surfaceKey: 'settings.access-profiles-groups', act: 'grant.create', arm: '3e76cfcc',
    });
  });

  it('CONTROL: the refusal is EXACT, not a prefix - a look-alike key is not withheld', async () => {
    armActivePrincipal();
    // `authorityMutationSurfacesAmong` filters by an equality set in SQL, so a
    // surface whose key merely STARTS with a withheld one is unaffected. The
    // catalogue answering empty is that case.
    armPool([grantRow()], []);
    await grantService.create({ granteeId: GRANTEE, resourceType: 'surface', resourceId: RESOURCE, verb: 'write' }, 'owner');
  });

  it("NEGATIVE CONTROL: a WILDCARD 'surface' grant is refused (annex D19, design §2.6 I4)", async () => {
    armActivePrincipal();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [grantRow()] });
    // One hand-written wildcard surface grant would confer an access level on
    // every current AND FUTURE governable Access surface - the future-inclusive
    // shape `all-of-type` is excluded for, reached through the grant store.
    await expectError(
      grantService.create({ granteeId: GRANTEE, resourceType: 'surface', verb: 'read' }, 'owner'),
      422, 'INVALID_GRANT_VALUE',
    );
    await expectError(
      grantService.create({ granteeId: GRANTEE, resourceType: 'surface', resourceId: null, verb: 'read' }, 'owner'),
      422, 'INVALID_GRANT_VALUE',
    );
  });

  it("NEGATIVE CONTROL: 'surface' refuses the verbs use, invoke and admin (AZ-A5 clause 3)", async () => {
    armActivePrincipal();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [grantRow()] });
    for (const verb of ['use', 'invoke', 'admin'] as const) {
      await expectError(
        grantService.create({ granteeId: GRANTEE, resourceType: 'surface', resourceId: RESOURCE, verb }, 'owner'),
        422, 'INVALID_GRANT_VALUE',
      );
    }
  });
});

describe('remove', () => {
  it('deletes and returns the removed row', async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [grantRow()] });
    const removed = await grantService.remove(GRANT_ID);
    expect(removed.id).toBe(GRANT_ID);
    // AZ-S7: a provenance probe now precedes the delete, so the DELETE is
    // no longer call 0. What matters is unchanged — an owner-plane grant
    // (provenance NULL) still reaches the DELETE.
    const statements = (pool.query as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(statements.some((statement) => statement.includes('DELETE FROM grants'))).toBe(true);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'grant.revoke', resourceId: GRANT_ID }),
      expect.any(Object),
    );
  });

  // RH-P3.AZ-S7 (ruling 7440b579 R1): a grant materialized as an
  // assignment's ACCESS VEHICLE is not owner-plane configuration. Deleting
  // it here would recreate the assigned-but-invisible state R1 makes
  // unrepresentable, so it refuses and names the act that does remove it.
  //
  // POSITIVE CONTROL: the assertion that no DELETE was issued is what
  // makes this test able to fail if the guard is ever removed — a refusal
  // that still deleted would pass a code-only check.
  it('refuses to delete a grant the assignment access-vehicle machinery owns', async () => {
    (pool.query as jest.Mock).mockImplementation(async (text: string) => {
      if (/SELECT provenance FROM grants/.test(text)) {
        return { rows: [{ provenance: 'assignment:grant' }] };
      }
      return { rows: [grantRow()] };
    });
    await expectError(grantService.remove(GRANT_ID), 409, 'GRANT_CARRIES_ASSIGNMENT');
    const statements = (pool.query as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(statements.some((statement) => statement.includes('DELETE FROM grants'))).toBe(false);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'grant.revoke', outcome: 'denied', resourceId: GRANT_ID }),
    );
  });

  it('404s an absent grant and 400s a malformed id', async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
    await expectError(grantService.remove(GRANT_ID), 404, 'GRANT_NOT_FOUND');
    await expectError(grantService.remove('nope'), 400, 'INVALID_GRANT_ID');
  });
});

describe('the P2.5 seam', () => {
  it('activeGrantCondition honours wildcard and expiry and binds three params', () => {
    const cond = grantService.activeGrantCondition(5);
    expect(cond.sql).toContain('$5');
    expect(cond.sql).toContain('$6');
    expect(cond.sql).toContain('$7');
    // The typed wildcard is unchanged for the eight ratified object types...
    expect(cond.sql).toContain("g.resource_id IS NULL AND g.resource_type <> 'surface'");
    expect(cond.sql).toContain('expires_at IS NULL OR g.expires_at > NOW()');
    expect(cond.bind(GRANTEE, 'task', 'read')).toEqual([GRANTEE, 'task', 'read']);
  });

  it('EVALUATOR HALF: the wildcard is not available to `surface` (AZ-A5 clause 3, annex D19)', () => {
    const cond = grantService.activeGrantCondition(5);
    // ...and is withheld from `surface`, so a NULL-resource_id surface row
    // inserted by any path that bypasses `create` widens nothing. The two
    // halves are independent: either may be removed without the other failing,
    // which is why D19 drills the write refusal AND the ignored row.
    expect(cond.sql).not.toContain('(g.resource_id IS NULL OR g.resource_id =');
    expect(cond.sql).toContain('g.resource_id = <RESOURCE_ID_COLUMN>');
  });
});
