/**
 * Card 41e24358 (design ba22fd01 Part 4): the usable-Verifier predicate, one
 * arm at a time, without a database. The same arms are measured on a real
 * PostgreSQL, through the router and in the list filter, by
 * defaultVerifierLive.test.ts (npm run test:default-verifier).
 */
import { delegationService, DelegationEvaluatorError, type DelegationChain } from '../services/DelegationService';
import {
  principalVerifierUsability, verifierUsabilityOf, verifierNotUsableWarning, VERIFIER_ARM_REASONS,
} from '../services/VerifierUsability';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

interface Row { kind: string; status: string; role: string | null; parent_principal_id: string | null; legacy_identity: boolean }

function queryable(rows: Record<string, Row>, credentials: Record<string, string[][]> = {}) {
  return {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM principals WHERE id = $1')) {
        const row = rows[params[0]];
        return { rows: row ? [{ id: params[0], ...row }] : [] };
      }
      if (sql.includes('FROM principal_credentials')) {
        return { rows: (credentials[params[0]] ?? []).map((scopes) => ({ scopes })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

function link(id: string, row: Row, live = 1) {
  return { principalId: id, kind: row.kind as any, role: row.role, status: row.status,
    parentPrincipalId: row.parent_principal_id, boundTaskId: null, legacyIdentity: row.legacy_identity,
    ownExpression: row.parent_principal_id ? { scopes: 'parent' as const, objects: 'parent' as const } : null,
    liveCredentialCount: live };
}

const account: Row = { kind: 'human', status: 'active', role: 'user', parent_principal_id: null, legacy_identity: false };
const connector: Row = { kind: 'service', status: 'active', role: null, parent_principal_id: ACCOUNT, legacy_identity: false };

function chainOf(alive: boolean, links: ReturnType<typeof link>[]): DelegationChain {
  return { links, alive, deadReason: alive ? null : 'dead' };
}

afterEach(() => jest.restoreAllMocks());

describe('the usable-Verifier predicate, arm by arm', () => {
  it('arm none: no Verifier set', async () => {
    expect(await verifierUsabilityOf(queryable({}), { verifierPrincipalId: null, ownerPrincipalId: null }))
      .toEqual({ usable: false, failedArm: 'none', principalId: null });
  });

  it('arm principal: missing, non-active or Group principals fail before any chain is read', async () => {
    const resolve = jest.spyOn(delegationService, 'resolveChain');
    expect(await principalVerifierUsability(queryable({}), ACCOUNT)).toEqual({ usable: false, failedArm: 'principal' });
    expect(await principalVerifierUsability(queryable({ [ACCOUNT]: { ...account, status: 'disabled' } }), ACCOUNT))
      .toEqual({ usable: false, failedArm: 'principal' });
    expect(await principalVerifierUsability(queryable({ [ACCOUNT]: { ...account, status: 'terminated' } }), ACCOUNT))
      .toEqual({ usable: false, failedArm: 'principal' });
    expect(await principalVerifierUsability(queryable({ [ACCOUNT]: { ...account, kind: 'group', role: null } }), ACCOUNT))
      .toEqual({ usable: false, failedArm: 'principal' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('arm chain: a dead chain, or one the evaluator refuses, fails', async () => {
    const q = queryable({ [CONNECTOR]: connector });
    jest.spyOn(delegationService, 'resolveChain').mockResolvedValueOnce(
      chainOf(false, [link(CONNECTOR, connector, 0), link(ACCOUNT, account)]));
    expect(await principalVerifierUsability(q, CONNECTOR)).toEqual({ usable: false, failedArm: 'chain' });
    jest.spyOn(delegationService, 'resolveChain').mockRejectedValueOnce(new DelegationEvaluatorError('too deep'));
    expect(await principalVerifierUsability(q, CONNECTOR)).toEqual({ usable: false, failedArm: 'chain' });
  });

  it('arm scope: an Account answers with its role-derived set', async () => {
    for (const [role, usable] of [['user', true], ['admin', true], ['viewer', false]] as const) {
      const row = { ...account, role };
      jest.spyOn(delegationService, 'resolveChain').mockResolvedValueOnce(chainOf(true, [link(ACCOUNT, row)]));
      expect(await principalVerifierUsability(queryable({ [ACCOUNT]: row }), ACCOUNT))
        .toEqual(usable ? { usable: true } : { usable: false, failedArm: 'scope' });
    }
  });

  it('arm scope: a Connector needs ONE live credential whose effective scopes keep tasks:write', async () => {
    const chain = chainOf(true, [link(CONNECTOR, connector), link(ACCOUNT, account)]);
    jest.spyOn(delegationService, 'resolveChain').mockResolvedValue(chain);
    expect(await principalVerifierUsability(queryable({ [CONNECTOR]: connector },
      { [CONNECTOR]: [['tasks:read']] }), CONNECTOR)).toEqual({ usable: false, failedArm: 'scope' });
    // Two credentials that each lack it are not unioned into one that has it.
    expect(await principalVerifierUsability(queryable({ [CONNECTOR]: connector },
      { [CONNECTOR]: [['tasks:read'], ['reports:write']] }), CONNECTOR)).toEqual({ usable: false, failedArm: 'scope' });
    expect(await principalVerifierUsability(queryable({ [CONNECTOR]: connector },
      { [CONNECTOR]: [['tasks:read'], ['tasks:read', 'tasks:write']] }), CONNECTOR)).toEqual({ usable: true });
    // The Account layer bounds the chain: a viewer Account's Connector cannot write.
    const viewer = { ...account, role: 'viewer' };
    jest.spyOn(delegationService, 'resolveChain').mockResolvedValue(
      chainOf(true, [link(CONNECTOR, connector), link(ACCOUNT, viewer)]));
    expect(await principalVerifierUsability(queryable({ [CONNECTOR]: connector },
      { [CONNECTOR]: [['tasks:write']] }), CONNECTOR)).toEqual({ usable: false, failedArm: 'scope' });
  });

  it('arm independence: the Verifier must not be the Assignee', async () => {
    const q = queryable({ [ACCOUNT]: account });
    jest.spyOn(delegationService, 'resolveChain').mockResolvedValue(chainOf(true, [link(ACCOUNT, account)]));
    expect(await verifierUsabilityOf(q, { verifierPrincipalId: ACCOUNT, ownerPrincipalId: ACCOUNT }))
      .toEqual({ usable: false, failedArm: 'independence', principalId: ACCOUNT });
    expect(await verifierUsabilityOf(q, { verifierPrincipalId: ACCOUNT, ownerPrincipalId: OTHER }))
      .toEqual({ usable: true, principalId: ACCOUNT });
    expect(await verifierUsabilityOf(q, { verifierPrincipalId: ACCOUNT, ownerPrincipalId: null }))
      .toEqual({ usable: true, principalId: ACCOUNT });
  });

  it('the warning names the arm in fixed text and never a principal name', () => {
    const warning = verifierNotUsableWarning({ usable: false, failedArm: 'scope', principalId: CONNECTOR });
    expect(warning).toEqual({ code: 'VERIFIER_NOT_USABLE', failedArm: 'scope', verifierPrincipalId: CONNECTOR,
      message: `This card is in Review but its Verifier cannot judge it: ${VERIFIER_ARM_REASONS.scope}.` });
  });
});
