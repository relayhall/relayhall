/**
 * Card bedf50cc (plugin availability and settings, owner ruling E380, design
 * section 7): the gate on the Account's own plugin writes, `ownSessionAccount`
 * in routes/pluginHost.ts. The live suite (pluginAvailabilityLive U1) measures
 * the gate through the production routers with bearers and a delegated
 * Connector, but the authentication middleware sets delegation links only on a
 * bearer, so no live fixture can present a LOGIN SESSION that carries one. This
 * unit test presents exactly that request to the gate itself: the
 * no-delegation-link condition is the only thing that refuses it.
 */
import { ownSessionAccount } from '../routes/pluginHost';
import { principalService } from '../services/PrincipalService';
import { auditService } from '../services/AuditService';

const ACCOUNT = '6f1c2a4e-3b5d-4c7e-8f90-a1b2c3d4e5f6';

function response() {
  const answer: { status?: number; body?: any } = {};
  const res: any = {
    status(code: number) { answer.status = code; return res; },
    json(body: unknown) { answer.body = body; return res; },
  };
  return { res, answer };
}

function sessionRequest(extra: Record<string, unknown> = {}): any {
  return {
    authMethod: 'session', userId: 'own-session-account',
    principal: { id: ACCOUNT, handle: 'own-session-account', kind: 'human', status: 'active', parentPrincipalId: null, role: 'editor' },
    ...extra,
  };
}

let recorded: any[] = [];
beforeEach(() => {
  recorded = [];
  jest.spyOn(principalService, 'getPrincipalById').mockImplementation(async (id: string) =>
    ({ id, status: 'active', kind: 'human', parentPrincipalId: null } as any));
  jest.spyOn(auditService, 'record').mockImplementation(async (entry: any) => { recorded.push(entry); return undefined as any; });
});
afterEach(() => jest.restoreAllMocks());

describe("the Account's own plugin-write gate (card bedf50cc, design section 7)", () => {
  it('admits the Account\'s own login session, and refuses the same session carrying a delegation link SESSION_ONLY, audited', async () => {
    const own = response();
    expect(await ownSessionAccount(sessionRequest(), own.res, 'plugin.choice.set')).toBe(ACCOUNT);
    expect([own.answer.status, recorded.length]).toEqual([undefined, 0]);

    // The same login session, the same principal, the Account resolving to
    // itself, and one delegation link: refused, and nothing else differs.
    const delegated = response();
    const links = [{ principalId: ACCOUNT, kind: 'human', role: 'editor', parentPrincipalId: null }];
    expect(await ownSessionAccount(sessionRequest({ delegationLinks: links }), delegated.res, 'plugin.choice.set')).toBeNull();
    expect([delegated.answer.status, delegated.answer.body?.code]).toEqual([403, 'SESSION_ONLY']);
    expect(recorded.map((entry) => [entry.action, entry.outcome, entry.metadata?.refusal]))
      .toEqual([['plugin.choice.set', 'denied', 'SESSION_ONLY']]);
  });
});
