/**
 * RH-KW1 candidate A — gate collision G3, owner decision D6(a): the
 * Agent-layer exclusion that vocabulary amendment A21 asserts and that,
 * before this candidate, no mechanism anywhere in the tree implemented.
 *
 * A21, verbatim: `knowledge-contents:read` is "excluded from Agent-layer mints
 * by default". That sentence was copied word for word from A18, whose
 * `telemetry-contents:read` is unbuilt and absent from `scopeMap.ts`. With no
 * per-scope Agent exclusion in existence, the clause said nothing that was not
 * already true of every scope — a control nothing could make fail.
 *
 * ── WHY THE DRILL ASSERTS THE SPECIFIC CODE ──
 *
 * Breakdown `abc71ffb` §3 states the constraint the drill must respect: "A
 * drill that only asserts 'the mint fails' would be satisfied by the shipped
 * `isMintableScope` branch if the scope were ever removed from
 * `MINTABLE_SCOPES`, and proves nothing about the new check." So the check
 * sits BEFORE `isMintableScope`, the drill asserts the code
 * `AGENT_EXCLUDED_SCOPE`, and the mutation deletes the check WITH THE SCOPE
 * STILL MINTABLE — under which the mint SUCCEEDS OUTRIGHT rather than falling
 * to a different refusal. That is the red proof.
 */
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
// COLLECT writes an approval event and an audit row; neither is the subject
// of this suite and both need a real row shape to map.
jest.mock('../services/AuditService', () => ({
  auditService: { record: jest.fn().mockResolvedValue(undefined) },
}));

import {
  AGENT_EXCLUDED_SCOPES,
  validateRequestedScopes,
} from '../services/AgentMintService';
import { MINTABLE_SCOPES, ALL_SCOPES } from '../utils/scopeMap';
import { loadMutatedModule, readShippedSource } from './support/moduleMutation';
import { pool } from '../db/connection';
import { agentMintService } from '../services/AgentMintService';
import { approvalService } from '../services/ApprovalService';

const AGENT_MINT = 'services/AgentMintService.ts';

function refusalCode(scopes: unknown): string {
  try {
    validateRequestedScopes(scopes);
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NOT_REFUSED';
}

describe('G3 — the fourth check at the Agent mint seam', () => {
  it('refuses knowledge-contents:read with its OWN code', () => {
    expect(refusalCode(['knowledge-contents:read'])).toBe('AGENT_EXCLUDED_SCOPE');
    // And refuses it inside a mixed request, not only alone.
    expect(refusalCode(['tasks:read', 'knowledge-contents:read'])).toBe('AGENT_EXCLUDED_SCOPE');
  });

  it('the positive control actually reaches the same function', () => {
    // If the setup could not mint anything, the refusal above would prove
    // nothing about this seam.
    expect(validateRequestedScopes(['tasks:read', 'reports:read'])).toEqual(['tasks:read', 'reports:read']);
  });

  it('keeps the three shipped rules answering with THEIR codes', () => {
    expect(refusalCode(['root'])).toBe('ROOT_NOT_MINTABLE');
    expect(refusalCode(['tasks:admin'])).toBe('ADMIN_NOT_AGENT_DELEGABLE');
    expect(refusalCode(['tools:read'])).toBe('INVALID_MINT_SCOPES');
    // Four codes, four distinct rules: the new one did not absorb a sibling.
    expect(new Set([
      refusalCode(['root']),
      refusalCode(['tasks:admin']),
      refusalCode(['tools:read']),
      refusalCode(['knowledge-contents:read']),
    ]).size).toBe(4);
  });

  it('the excluded scope is MINTABLE — so the generic branch is not what refuses', () => {
    expect(ALL_SCOPES).toContain('knowledge-contents:read');
    expect(MINTABLE_SCOPES).toContain('knowledge-contents:read');
    expect([...AGENT_EXCLUDED_SCOPES]).toEqual(['knowledge-contents:read']);
  });

  it('the error code is unique across AgentMintService', () => {
    const source = readShippedSource(AGENT_MINT);
    expect(source.split("'AGENT_EXCLUDED_SCOPE'").length - 1).toBe(1);
  });

  it('MUTATION: delete the fourth check and the mint SUCCEEDS — no refusal at all', () => {
    const mutant = loadMutatedModule<typeof import('../services/AgentMintService')>(AGENT_MINT, [{
      find: '    if (AGENT_EXCLUDED_SCOPES.has(scope)) {',
      replace: '    if (false) {',
    }]);
    // With the scope still in MINTABLE_SCOPES, nothing downstream refuses it.
    expect(mutant.validateRequestedScopes(['knowledge-contents:read']))
      .toEqual(['knowledge-contents:read']);
  });

  it('MUTATION: with the scope no longer mintable, the SPECIFIC code still comes first', () => {
    // The ordering is load-bearing. Below `isMintableScope` this refusal
    // would be shadowed the moment the scope left MINTABLE_SCOPES, and a
    // caller could not tell an EXCLUDED scope from a misspelt one. Here the
    // scope is taken out of MINTABLE_SCOPES — the world in which a
    // wrongly-ordered check goes silent — and the shipped check must still
    // answer with its own code.
    const narrowedScopeMap = loadMutatedModule<typeof import('../utils/scopeMap')>('utils/scopeMap.ts', [{
      find: "  'telemetry:write',\n  'directory-provisioning:write',\n  'knowledge-contents:read',\n  'root',\n];\n\n/** `root` is the global sentinel",
      replace: "  'telemetry:write',\n  'directory-provisioning:write',\n  'root',\n];\n\n/** `root` is the global sentinel",
    }]);
    expect(narrowedScopeMap.isMintableScope('knowledge-contents:read')).toBe(false);

    const mint = loadMutatedModule<typeof import('../services/AgentMintService')>(
      AGENT_MINT,
      [],
      { '../utils/scopeMap': narrowedScopeMap },
    );
    let code = 'NOT_REFUSED';
    try {
      mint.validateRequestedScopes(['knowledge-contents:read']);
    } catch (e) {
      code = (e as { code?: string }).code ?? 'NO_CODE';
    }
    expect(code).toBe('AGENT_EXCLUDED_SCOPE');
  });

  it('the check is written ABOVE the generic mintability branch', () => {
    const source = readShippedSource(AGENT_MINT);
    expect(source.indexOf('AGENT_EXCLUDED_SCOPES.has(scope)'))
      .toBeLessThan(source.indexOf('if (!isMintableScope(scope))'));
  });

  it('the comment records the precedent the A18 telemetry lane reuses', () => {
    const source = readShippedSource(AGENT_MINT);
    expect(source).toContain('A18 telemetry lane reuses this set');
  });
});

// ═══ round-1 finding S3-F1 — COLLECT re-runs the complete validation ═════

describe('S3-F1 (verdict b7348598) — a stored approval cannot mint an excluded scope', () => {
  /** The COLLECT row shape the service locks, with a stored scope list. */
  function approvalRow(scopes: string[]): Record<string, unknown> {
    return {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'approved',
      requesting_credential_id: 'cred-1',
      requester_principal_id: 'principal-1',
      target_task_id: 'task-1',
      collect_expires_at: null,
      approved_scopes: JSON.stringify(scopes),
      approved_rules: JSON.stringify([]),
    };
  }

  function armPool(scopes: string[]): { statements: string[] } {
    const statements: string[] = [];
    const query = async (text: string) => {
      statements.push(text.replace(/\s+/g, ' ').trim());
      if (text.includes('FROM approvals WHERE id')) return { rows: [approvalRow(scopes)] };
      return { rows: [] };
    };
    (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
    (pool.query as jest.Mock).mockImplementation(query);
    return { statements };
  }

  const collectInput = {
    approvalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    presentingCredentialId: 'cred-1',
    presentingPrincipalId: 'principal-1',
    presentingEffectiveScopes: ['tasks:read', 'knowledge-contents:read'],
  };

  it('LAPSES a stored approval carrying an Agent-excluded scope, and never mints', async () => {
    armPool(['knowledge-contents:read']);
    const mint = jest.spyOn(agentMintService, 'executeMint');
    try {
      await expect(
        approvalService.collect(collectInput as never, { principalId: 'p', handle: 'h', authMethod: 'unknown' } as never),
      ).rejects.toMatchObject({ code: 'APPROVAL_LAPSED' });
      // The whole point: the mint was never reached.
      expect(mint).not.toHaveBeenCalled();
    } finally {
      mint.mockRestore();
    }
  });

  it('leaves a still-legal stored approval alone — the repair is fail-CLOSED, not fail-shut', async () => {
    armPool(['tasks:read']);
    const mint = jest.spyOn(agentMintService, 'executeMint')
      .mockResolvedValue({ principalId: 'minted' } as never);
    const live = jest.spyOn(agentMintService, 'assertRequesterLive').mockResolvedValue(undefined as never);
    const mintable = jest.spyOn(agentMintService, 'assertTaskMintable').mockResolvedValue(undefined as never);
    const slot = jest.spyOn(agentMintService, 'assertWriterSlotFree').mockResolvedValue(undefined as never);
    const within = jest.spyOn(agentMintService, 'assertScopesWithinEffective').mockReturnValue(undefined as never);
    const objects = jest.spyOn(agentMintService, 'assertObjectAuthorityCovers').mockResolvedValue(undefined as never);
    try {
      await approvalService.collect(
        collectInput as never,
        { principalId: 'p', handle: 'h', authMethod: 'unknown' } as never,
      );
      expect(mint).toHaveBeenCalledTimes(1);
      // …and the list it received is the VALIDATED one, not the stored blob.
      expect((mint.mock.calls[0][1] as { authority: { scopes: string[] } }).authority.scopes)
        .toEqual(['tasks:read']);
    } finally {
      for (const spy of [mint, live, mintable, slot, within, objects]) spy.mockRestore();
    }
  });

  it('the validation is the FIRST statement inside the terminal-validation try', () => {
    const source = readShippedSource('services/ApprovalService.ts');
    const tryAt = source.indexOf('let mintScopes: string[] = approvedScopes;');
    const validateAt = source.indexOf('mintScopes = validateRequestedScopes(approvedScopes);', tryAt);
    // Searched FROM the try, not from the file head: `assertRequesterLive`
    // is called on other mint paths earlier in this file, and a bare
    // indexOf would compare against one of those instead.
    const liveAt = source.indexOf('agentMintService.assertRequesterLive(', validateAt);
    expect(tryAt).toBeGreaterThan(-1);
    expect(validateAt).toBeGreaterThan(tryAt);
    expect(liveAt).toBeGreaterThan(validateAt);
    // executeMint consumes the validated list, never the stored one.
    expect(source).toContain('authority: { scopes: mintScopes, rules: approvedRules },');
  });
});
