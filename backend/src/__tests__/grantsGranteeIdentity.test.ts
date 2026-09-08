/**
 * grantsGranteeIdentity.test.ts — card f03d459e.
 *
 * A fresh install presented "Access grants 1", and the row read
 * `Unknown principal · read · report / Every resource of this type · No expiry
 * · Revoke`. The grantee was the seeded compatibility identity `reports_reader`
 * (migration 062), hidden from every directory listing by 065 and carrying the
 * pre-grant 078 migrated into `grants`; the page named grantees by looking
 * them up in a listing that is ALLOWED not to contain them.
 *
 * The repair is that the row arrives naming its own grantee, so these
 * assertions are about the ROUTE: a governance surface whose only affordance is
 * "Revoke" must be able to say what it is asking about.
 */
import express from 'express';

jest.mock('../services/GrantService', () => ({
  grantService: { list: jest.fn(), create: jest.fn(), remove: jest.fn() },
  GrantError: class extends Error {},
}));
jest.mock('../services/PrincipalService', () => ({
  principalService: { getPrincipalById: jest.fn() },
}));

import grantsRoutes from '../routes/grants';
import { grantService } from '../services/GrantService';
import { principalService } from '../services/PrincipalService';

const grants = grantService as jest.Mocked<typeof grantService>;
const principals = principalService as jest.Mocked<typeof principalService>;

const READER_ID = 'df2425ad-e41d-4e2b-8774-476269649574';
const ADMIN_ID = '9afb0f9f-9e08-4e8d-85e4-090156891344';
const GONE_ID = '00000000-0000-4000-8000-0000000000ff';

/** The seeded row exactly as 062 writes it and 065 leaves it. */
const REPORTS_READER = {
  id: READER_ID,
  kind: 'service',
  handle: 'reports_reader',
  displayName: 'Knowledge-fabric reports reader',
  status: 'disabled',
  metadata: { compatibility: true, hidden_until_configured: true },
};

const ADMIN = {
  id: ADMIN_ID,
  kind: 'human',
  handle: 'ada',
  displayName: 'Ada',
  status: 'active',
  metadata: {},
};

/** The pre-grant, exactly as the card's `GET /api/grants` reported it. */
const SEEDED_GRANT = {
  id: '00078bff-f8fa-436d-b89e-7fa555ba60fb',
  granteeType: 'principal',
  granteeId: READER_ID,
  resourceType: 'report',
  resourceId: null,
  verb: 'read',
  grantedByPrincipalId: ADMIN_ID,
  expiresAt: null,
  createdAt: '2026-09-05T02:27:23.033Z',
};

async function listGrants(): Promise<any> {
  const app = express();
  app.use(express.json());
  app.use('/grants', grantsRoutes);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    const response = await fetch(`http://127.0.0.1:${address.port}/grants`);
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  principals.getPrincipalById.mockImplementation(async (id: string) => {
    if (id === READER_ID) return REPORTS_READER as never;
    if (id === ADMIN_ID) return ADMIN as never;
    return undefined;
  });
});

describe('GET /grants names the identity every grant is held by', () => {
  it('names the HIDDEN compatibility grantee the directory listing omits', async () => {
    grants.list.mockResolvedValue([SEEDED_GRANT] as never);
    const answer = await listGrants();
    expect(answer.status).toBe(200);
    const [row] = answer.json.grants;
    // The whole defect in one assertion: the row can be named.
    expect(row.grantee).toEqual({
      id: READER_ID,
      handle: 'reports_reader',
      displayName: 'Knowledge-fabric reports reader',
      kind: 'service',
      status: 'disabled',
      compatibility: true,
    });
  });

  it('says the grant is held by a dormant BUILT-IN identity, not merely by a name', async () => {
    // Naming it is not enough for a surface whose only affordance is "Revoke":
    // the operator has to be able to tell a seeded compatibility grant from
    // one somebody made. `compatibility` and `status` are what carry that.
    grants.list.mockResolvedValue([SEEDED_GRANT] as never);
    const [row] = (await listGrants()).json.grants;
    expect(`compatibility: ${row.grantee.compatibility}`).toBe('compatibility: true');
    expect(`status: ${row.grantee.status}`).toBe('status: disabled');
  });

  it('names the granter too, so a standing grant says who made it', async () => {
    grants.list.mockResolvedValue([SEEDED_GRANT] as never);
    const [row] = (await listGrants()).json.grants;
    expect(row.grantedBy).toMatchObject({ handle: 'ada', compatibility: false });
  });

  it('a grantee whose row is genuinely gone resolves to null, not to a wrong name', async () => {
    // The surface then says so about a SPECIFIC id, which is a different
    // statement from "I could not find a name for this".
    grants.list.mockResolvedValue([{ ...SEEDED_GRANT, granteeId: GONE_ID }] as never);
    const [row] = (await listGrants()).json.grants;
    expect(row.grantee).toBeNull();
    expect(row.granteeId).toBe(GONE_ID);
  });

  it('resolves EVERY row, not just the first', async () => {
    // A per-row resolution that only ran once would pass every assertion
    // above and leave a second grant unnamed on the page.
    grants.list.mockResolvedValue([
      { ...SEEDED_GRANT, id: 'a' },
      { ...SEEDED_GRANT, id: 'b', granteeId: ADMIN_ID },
    ] as never);
    const rows = (await listGrants()).json.grants;
    expect(rows.map((row: any) => row.grantee?.handle)).toEqual(['reports_reader', 'ada']);
  });
});
