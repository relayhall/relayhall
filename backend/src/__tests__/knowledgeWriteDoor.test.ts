/**
 * RB-11 Governor v0 — the core door, the parts that are properties of CODE
 * rather than of a database (card `b796067e`; ratified design C.3, C.12, D-8,
 * ruling E97 with answers E1 and E2). The database half — the fail-closed
 * audit, the route ceiling, the relay and the read-back — is measured in
 * `knowledgeWriteDoorLive`.
 *
 *  - the vocabulary amendment and census C3: exactly one route family names
 *    `knowledge-contents:write`, and the read and write scopes never satisfy
 *    each other;
 *  - E2 at the mint seam: mintable onto an Agent, never excluded, never past
 *    the parent's own set;
 *  - the WRITE producer set: the write signer refuses anything the write
 *    evaluator did not mint, the read signer refuses write evaluations, and the
 *    header and claims are the ratified write shape;
 *  - the write arm set: the explicit scope arm and the write predicate;
 *  - the descriptor write block and the write predicate's truth table;
 *  - the caller-input contract (C.16) and the verb URL;
 *  - the three MCP tools: what each composes, and the commit's retry token.
 */
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import crypto from 'crypto';
import { pool } from '../db/connection';
import {
  ALL_SCOPES, MINTABLE_SCOPES, requiredScopeFor, scopesSatisfy, isMintableScope,
} from '../utils/scopeMap';
import { scopesForRole } from '../utils/identityScopes';
import { AGENT_EXCLUDED_SCOPES, validateRequestedScopes, AgentMintService } from '../services/AgentMintService';
import {
  signKnowledgeAssertion, signKnowledgeWriteAssertion, knowledgeAssertionJwks,
  resetKnowledgeAssertionKeysetCache, WRITE_ASSERTION_TYP, ASSERTION_TYP,
} from '../services/KnowledgeAssertionSigner';
import {
  evaluateKnowledgeArms, evaluateKnowledgeWriteArms, isKnowledgeArmEvaluation, isKnowledgeWriteArmEvaluation,
} from '../services/KnowledgeArmEvaluator';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { isKnowledgeWriteCapable, isKnowledgeCapable, type KnowledgeDescriptorBlock } from '../services/KnowledgeSourcePolicy';
import { validateDescriptor } from '../utils/serviceDescriptor';
import {
  parseKnowledgeWriteRequest, knowledgeWriteVerbUrl, KNOWLEDGE_WRITE_SOURCE_REFUSALS,
  KNOWLEDGE_NOTE_MAX_CONTENT_BYTES,
} from '../services/KnowledgeWriteExecutor';
import { toolByName } from '../mcp/registry';
import * as rest from '../mcp/rest';
import { readShippedSource } from './support/moduleMutation';

const SOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TASK_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROJECT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const KEY = (crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64');

beforeEach(() => {
  process.env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS = JSON.stringify({ kw: KEY });
  process.env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY = 'kw';
  delete process.env.RELAYHALL_KNOWLEDGE_ASSERTION_RETIRED_KEYS;
  resetKnowledgeAssertionKeysetCache();
  const emitted = new Set<string>();
  (pool.query as jest.Mock).mockImplementation(async (text: string, params?: unknown[]) => {
    if (text.includes('INSERT INTO knowledge_assertion_jti')) {
      const jti = String((params ?? [])[0]);
      if (emitted.has(jti)) return { rows: [] };
      emitted.add(jti);
      return { rows: [{ jti }] };
    }
    return { rows: [] };
  });
  jest.spyOn(authorizationRepository, 'authorizedIds').mockImplementation(async (_a, _t, ids) => new Set(ids.map(String)));
  jest.spyOn(authorizationRepository, 'selectorCoveredIds').mockImplementation(async (_a, _t, ids) => new Set(ids.map(String)));
});

afterEach(() => jest.restoreAllMocks());

const V2_WRITE_BLOCK: KnowledgeDescriptorBlock & { classes: Array<{ key: string; content: string }> } = {
  classes: [{ key: 'notes', content: 'docs' }], compartments: [], protocol_version: 2,
  compartment_mode: 'dynamic-opaque', categories: ['notes:note'], write: { protocol_version: 1, kinds: ['note'] },
};

function request(scopes: string[]) {
  return {
    principal: { id: ACCOUNT_ID, role: 'user', kind: 'human', status: 'active', parentPrincipalId: null },
    userId: 'holder', credentialId: 'cred-1', scopes,
    authorizationActor: { principalId: ACCOUNT_ID, handle: 'holder', role: 'user', scopes, authenticated: true, delegation: null },
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID, slug: 'writable', status: 'published', retired_at: null,
    knowledge_query_endpoint: 'https://source.example.com/knowledge/search',
    knowledge_write_endpoint: 'https://source.example.com/knowledge/write',
    knowledge_claims_mode: 'asserted', knowledge_subject_mode: 'pairwise', knowledge_relevant_groups: [],
    descriptor: { options: [], knowledgeSource: V2_WRITE_BLOCK },
    ...overrides,
  };
}

const decode = (token: string) => {
  const [h, c] = token.split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), claims: JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) };
};

// ═══════════ the vocabulary amendment, and census C3 ═══════════

describe('knowledge-contents:write — vocabulary amendment D-8 and census C3', () => {
  it('is ratified vocabulary AND mintable, beside the read scope', () => {
    expect(ALL_SCOPES).toContain('knowledge-contents:write');
    expect(MINTABLE_SCOPES).toContain('knowledge-contents:write');
    expect(isMintableScope('knowledge-contents:write')).toBe(true);
  });

  it('exactly the three write verbs, POST only, require it; every other spelling under the mount is root', () => {
    for (const verb of ['propose', 'preview', 'commit']) {
      expect(requiredScopeFor('POST', `/knowledge-writes/${verb}`)).toBe('knowledge-contents:write');
      expect(requiredScopeFor('GET', `/knowledge-writes/${verb}`)).toBe('root');
    }
    expect(requiredScopeFor('POST', '/knowledge-writes')).toBe('root');
    expect(requiredScopeFor('POST', '/knowledge-writes/delete')).toBe('root');
    expect(requiredScopeFor('POST', '/knowledge-writes/commit/extra')).toBe('root');
  });

  it('C3: the scope-map rule naming knowledge-contents:write is ONE rule, and it is the knowledge-writes family', () => {
    const source = readShippedSource('utils/scopeMap.ts');
    const naming = source.split('\n').filter((line) => /scope:\s*'knowledge-contents:write'/.test(line));
    expect(naming).toEqual([
      "  { pattern: /^\\/knowledge-writes\\/(propose|preview|commit)$/, methods: ['POST'], scope: 'knowledge-contents:write' },",
    ]);
    // …and the read scope's rules never name the write family.
    expect(source.split('\n').filter((line) => /knowledge-writes/.test(line) && /scope: 'knowledge-contents:read'/.test(line))).toEqual([]);
  });

  it('the read scope never satisfies the write scope, nor the reverse; root satisfies both', () => {
    expect(scopesSatisfy(['knowledge-contents:read'], 'knowledge-contents:write')).toBe(false);
    expect(scopesSatisfy(['knowledge-contents:write'], 'knowledge-contents:read')).toBe(false);
    expect(scopesSatisfy(['root'], 'knowledge-contents:write')).toBe(true);
  });

  it('is role-derived like every mintable non-admin scope (stated, not narrowed here: E2 governs Agents only)', () => {
    for (const role of ['user', 'editor', 'agent', 'service', 'qa', 'reviewer', 'operator']) {
      expect({ role, has: scopesForRole(role).includes('knowledge-contents:write') }).toEqual({ role, has: true });
    }
    expect(scopesForRole('viewer')).not.toContain('knowledge-contents:write');
  });
});

// ═══════════ E2 at the Agent mint seam ═══════════

describe('E2 — the Agent layer gets the write scope only by explicit request, inside the parent set', () => {
  it('is NOT in the Agent exclusion set: an explicit request validates', () => {
    expect(AGENT_EXCLUDED_SCOPES.has('knowledge-contents:write')).toBe(false);
    expect([...AGENT_EXCLUDED_SCOPES]).toEqual(['knowledge-contents:read']);
    expect(validateRequestedScopes(['tasks:read', 'knowledge-contents:write'])).toEqual(['tasks:read', 'knowledge-contents:write']);
  });

  it('never by default: the request list is explicit and non-empty', () => {
    expect(() => validateRequestedScopes([])).toThrow(/non-empty/);
    expect(() => validateRequestedScopes(undefined)).toThrow(/non-empty/);
  });

  it('never past the parent: the T2 ceiling refuses it to a requester that does not hold it', () => {
    const service = new AgentMintService();
    let code = 'NOT_REFUSED';
    try {
      service.assertScopesWithinEffective(['tasks:read', 'knowledge-contents:read'], ['knowledge-contents:write']);
    } catch (e) {
      code = (e as { code?: string }).code ?? 'NO_CODE';
    }
    expect(code).toBe('MINT_EXCEEDS_REQUESTER');
    expect(() => service.assertScopesWithinEffective(['tasks:read', 'knowledge-contents:write'], ['knowledge-contents:write'])).not.toThrow();
  });
});

// ═══════════ the WRITE producer set, and the write assertion ═══════════

describe('C.3 — the write assertion: its own typ, its own producer set, op/tsk/prj', () => {
  it('signs the ratified write header and claims, with the core-attested task context', async () => {
    const arms = await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row() as never, 'commit',
      { taskId: TASK_ID, projectId: PROJECT_ID });
    expect(isKnowledgeWriteArmEvaluation(arms)).toBe(true);
    const signed = await signKnowledgeWriteAssertion({ armEvaluation: arms as never, issuer: 'https://board.example/api', callerGroupIds: [] });
    const { header, claims } = decode(signed.token);
    expect(header).toEqual({ alg: 'EdDSA', typ: WRITE_ASSERTION_TYP, kid: 'kw' });
    expect(WRITE_ASSERTION_TYP).toBe('rh-knowledge-write-assertion+jwt');
    expect(WRITE_ASSERTION_TYP).not.toBe(ASSERTION_TYP);
    expect(Object.keys(claims).sort()).toEqual(['act', 'aud', 'exp', 'grp', 'iat', 'iss', 'jti', 'nbf', 'op', 'prj', 'sub', 'tsk']);
    expect(claims).toMatchObject({ act: 'relayhall-core', aud: SOURCE_ID, op: 'commit', tsk: TASK_ID, prj: PROJECT_ID, grp: [] });
    expect(claims.exp - claims.iat).toBe(30);
    expect(claims.nbf).toBe(claims.iat - 10);
    expect(signed.jti).toBe(claims.jti);
    // The signature verifies against the PUBLISHED keyset.
    const jwk = knowledgeAssertionJwks().keys.find((entry) => entry.kid === header.kid)!;
    const publicKey = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
    const [h, c, s] = signed.token.split('.');
    expect(crypto.verify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('no task context: neither tsk nor prj (both or neither)', async () => {
    const arms = await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row() as never, 'propose', null);
    const { claims } = decode((await signKnowledgeWriteAssertion({ armEvaluation: arms as never, issuer: 'i', callerGroupIds: [] })).token);
    expect([claims.tsk, claims.prj]).toEqual([undefined, undefined]);
    expect(claims.op).toBe('propose');
  });

  it('a fresh jti per act', async () => {
    const jtis = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const arms = await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row() as never, 'preview', null);
      jtis.add((await signKnowledgeWriteAssertion({ armEvaluation: arms as never, issuer: 'i', callerGroupIds: [] })).jti);
    }
    expect(jtis.size).toBe(5);
  });

  it('the producer sets are DISJOINT: the read signer refuses a write evaluation, the write signer a read one', async () => {
    const write = await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row() as never, 'propose', null);
    const read = await evaluateKnowledgeArms(request(['knowledge-contents:read']) as never, row() as never);
    expect(isKnowledgeArmEvaluation(read)).toBe(true);
    expect(isKnowledgeArmEvaluation(write)).toBe(false);
    expect(isKnowledgeWriteArmEvaluation(read)).toBe(false);
    await expect(signKnowledgeAssertion({ armEvaluation: write as never, issuer: 'i', callerGroupIds: [] }))
      .rejects.toMatchObject({ code: 'ASSERTION_WITHOUT_ARM_EVALUATION' });
    await expect(signKnowledgeWriteAssertion({ armEvaluation: read as never, issuer: 'i', callerGroupIds: [] }))
      .rejects.toMatchObject({ code: 'WRITE_ASSERTION_WITHOUT_WRITE_ARM_EVALUATION' });
  });

  it('a hand-built evaluation with every field right is refused', async () => {
    const forged = Object.freeze({
      sourceId: SOURCE_ID, sourceSlug: 'writable', claimsMode: 'asserted', subjectMode: 'pairwise', relevantGroups: [],
      accountPrincipalId: ACCOUNT_ID, op: 'commit', taskContext: null, at: Math.floor(Date.now() / 1000),
    });
    await expect(signKnowledgeWriteAssertion({ armEvaluation: forged as never, issuer: 'i', callerGroupIds: [] }))
      .rejects.toMatchObject({ code: 'WRITE_ASSERTION_WITHOUT_WRITE_ARM_EVALUATION' });
  });

  it('the write signer checks its producer set FIRST, and the read path keeps its stated jti bound', () => {
    const source = readShippedSource('services/KnowledgeAssertionSigner.ts');
    const body = source.slice(source.indexOf('export async function signKnowledgeWriteAssertion'));
    const firstStatement = body.slice(body.indexOf('{') + 1).trim().split('\n')[0];
    expect(firstStatement).toBe('if (!isKnowledgeWriteArmEvaluation(input.armEvaluation)) {');
    expect(source).toContain('NOT by `jti`');
    expect(source).toContain('That replay set lives\n// at the SOURCE, not here.');
  });
});

// ═══════════ the write arm set ═══════════

describe('C.12 — the write arm set', () => {
  it('the explicit scope arm: the read scope alone mints nothing', async () => {
    expect(await evaluateKnowledgeWriteArms(request(['knowledge-contents:read']) as never, row() as never, 'propose', null)).toBe('arms');
    expect(isKnowledgeWriteArmEvaluation(
      await evaluateKnowledgeWriteArms(request(['root']) as never, row() as never, 'propose', null))).toBe(true);
  });

  it('visibility or selector coverage false: the uniform arms refusal, never the named one', async () => {
    jest.spyOn(authorizationRepository, 'selectorCoveredIds').mockResolvedValue(new Set());
    expect(await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row() as never, 'propose', null)).toBe('arms');
    jest.spyOn(authorizationRepository, 'authorizedIds').mockResolvedValue(new Set());
    expect(await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row({ knowledge_write_endpoint: null }) as never, 'propose', null)).toBe('arms');
  });

  it('a visible, covered source without the write half is NOT write-capable — and only then is that named', async () => {
    expect(await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row({ knowledge_write_endpoint: null }) as never, 'propose', null))
      .toBe('not_write_capable');
    const noBlock = { options: [], knowledgeSource: { ...V2_WRITE_BLOCK, write: undefined } };
    expect(await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row({ descriptor: noBlock }) as never, 'propose', null))
      .toBe('not_write_capable');
  });

  it('a retired or unconfigured source, an unknown op and a malformed task context mint nothing', async () => {
    expect(await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row({ retired_at: '2026-01-01' }) as never, 'propose', null)).toBe('arms');
    expect(await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row({ knowledge_query_endpoint: null }) as never, 'propose', null)).toBe('arms');
    expect(await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row() as never, 'delete' as never, null)).toBe('arms');
    expect(await evaluateKnowledgeWriteArms(request(['knowledge-contents:write']) as never, row() as never, 'propose', { taskId: TASK_ID, projectId: 'nope' })).toBe('arms');
  });
});

// ═══════════ the descriptor write block, and the write predicate ═══════════

describe('D-8/D-9 — the descriptor write block and the write predicate', () => {
  const base = { options: [] };

  it('accepts exactly {protocol_version: 1, kinds: [note]} on a v2 dynamic-opaque block', () => {
    const descriptor = validateDescriptor({ ...base, knowledgeSource: V2_WRITE_BLOCK });
    expect(descriptor.knowledgeSource?.write).toEqual({ protocol_version: 1, kinds: ['note'] });
  });

  it('refuses a write block on a v1 block, and every malformed write block', () => {
    const v1 = { classes: [{ key: 'docs', content: 'docs' }], compartments: ['corpus'], write: { protocol_version: 1, kinds: ['note'] } };
    expect(() => validateDescriptor({ ...base, knowledgeSource: v1 })).toThrow(/protocol_version 2/);
    for (const write of [{ protocol_version: 2, kinds: ['note'] }, { protocol_version: 1, kinds: ['attachment'] },
      { protocol_version: 1, kinds: ['note', 'note'] }, { protocol_version: 1, kinds: ['note'], extra: true }, 'yes']) {
      expect(() => validateDescriptor({ ...base, knowledgeSource: { ...V2_WRITE_BLOCK, write } })).toThrow();
    }
  });

  it('the predicate: read-capable AND not the board AND the endpoint AND asserted AND the v2 write block', () => {
    const plane = { slug: 'writable', knowledgeQueryEndpoint: 'https://s/q', knowledgeWriteEndpoint: 'https://s/w', knowledgeClaimsMode: 'asserted' };
    expect(isKnowledgeWriteCapable(plane, V2_WRITE_BLOCK)).toBe(true);
    expect(isKnowledgeWriteCapable({ ...plane, knowledgeWriteEndpoint: null }, V2_WRITE_BLOCK)).toBe(false);
    expect(isKnowledgeWriteCapable({ ...plane, knowledgeClaimsMode: 'none' }, V2_WRITE_BLOCK)).toBe(false);
    expect(isKnowledgeWriteCapable({ ...plane, knowledgeQueryEndpoint: null }, V2_WRITE_BLOCK)).toBe(false);
    expect(isKnowledgeWriteCapable(plane, { ...V2_WRITE_BLOCK, write: undefined })).toBe(false);
    expect(isKnowledgeWriteCapable({ ...plane, slug: 'board' }, V2_WRITE_BLOCK)).toBe(false);
    // The board row is READ-capable by §9's exception, and still never write-capable.
    expect(isKnowledgeCapable({ slug: 'board', knowledgeQueryEndpoint: null }, null)).toBe(true);
    expect(isKnowledgeWriteCapable({ ...plane, slug: 'board' }, null)).toBe(false);
  });
});

// ═══════════ the caller-input contract (C.16) ═══════════

describe('C.16 — the caller input contract, parsed before anything else happens', () => {
  it('propose: defaults, and every bound named by its field', () => {
    expect(parseKnowledgeWriteRequest('propose', { title: 'T', content: 'C' })).toMatchObject({
      op: 'propose', noteType: 'note', tags: [], target: null, basis: [], revisionOf: null, expectedRevision: 'absent', source: null, taskId: null,
    });
    const refusal = (body: unknown) => {
      try { parseKnowledgeWriteRequest('propose', body); return null; } catch (e) { return [(e as { code: string }).code, (e as { field: string }).field]; }
    };
    expect(refusal({ title: 'T', content: 'x'.repeat(KNOWLEDGE_NOTE_MAX_CONTENT_BYTES + 1) })).toEqual(['content_invalid', 'content']);
    expect(refusal({ title: 'T', content: 'x'.repeat(KNOWLEDGE_NOTE_MAX_CONTENT_BYTES) })).toBeNull();
    expect(refusal({ title: 'T', content: '﻿---\nx' })).toEqual(['content_invalid', 'content']);
    expect(refusal({ title: 'T', content: 'a lone \uD800 surrogate' })).toEqual(['content_invalid', 'content']);
    expect(refusal({ title: 'T', content: 'C', taskId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' })).toEqual(['content_invalid', 'taskId']);
    expect(refusal({ title: 'T', content: 'C', target: { compartmentId: SOURCE_ID, extra: 1 } })).toEqual(['content_invalid', 'target']);
    expect(refusal([])).toEqual(['content_invalid', 'body']);
  });

  it('preview and commit: their own closed key sets and shapes', () => {
    expect(parseKnowledgeWriteRequest('preview', { proposalId: SOURCE_ID })).toEqual({ op: 'preview', source: null, proposalId: SOURCE_ID });
    expect(() => parseKnowledgeWriteRequest('preview', { proposalId: SOURCE_ID, title: 'x' })).toThrow(/unknown field: title/);
    expect(() => parseKnowledgeWriteRequest('commit', { proposalId: SOURCE_ID, previewDigest: 'x', expectedRevision: 'absent' })).toThrow(/previewDigest/);
    expect(() => parseKnowledgeWriteRequest('commit', { proposalId: SOURCE_ID, previewDigest: 'a'.repeat(64) })).toThrow(/expectedRevision/);
  });

  it('the verb URL appends the verb to the owner-plane base path, keeping its query', () => {
    expect(knowledgeWriteVerbUrl('https://s.example/knowledge/write', 'propose')).toBe('https://s.example/knowledge/write/propose');
    expect(knowledgeWriteVerbUrl('https://s.example/knowledge/write/', 'commit')).toBe('https://s.example/knowledge/write/commit');
    expect(knowledgeWriteVerbUrl('https://s.example:8443/w?v=1', 'preview')).toBe('https://s.example:8443/w/preview?v=1');
  });

  it('the source refusal table is C.11, each code with its own status', () => {
    expect(KNOWLEDGE_WRITE_SOURCE_REFUSALS).toEqual({
      assertion_invalid: 403, unavailable: 503, target_not_writable: 403, no_private_scope: 403,
      audience_exceeds_basis: 403, basis_unreadable: 403, not_own_note: 403, content_invalid: 400,
      content_secret_suspect: 403, audience_changed: 409, preview_mismatch: 409, revision_conflict: 409,
      proposal_expired: 410, egress_blocked: 403, reserved_name: 403, daily_cap: 429, commit_unverified: 502, internal_error: 500,
    });
  });
});

// ═══════════ the three MCP tools ═══════════

describe('C.12 — the three MCP door relays', () => {
  const CTX = { authorization: 'Bearer fixture', toolName: 'test' };

  it('propose and preview compose their REST twins under the write scope, answers fenced', async () => {
    const board = jest.spyOn(rest, 'board').mockResolvedValue({ success: true, result: { status: 'proposed' } });
    const propose = toolByName('relayhall_knowledge_note_propose')!;
    const text = await propose.handler({ title: 'T', content: 'C', taskId: TASK_ID }, CTX);
    expect(board).toHaveBeenLastCalledWith(expect.anything(), {
      method: 'POST', path: '/knowledge-writes/propose', body: { title: 'T', content: 'C', taskId: TASK_ID }, requiredScope: 'knowledge-contents:write',
    });
    expect(text).toContain('--- untrusted data from the knowledge source proposal');
    const preview = toolByName('relayhall_knowledge_note_preview')!;
    await preview.handler({ proposalId: SOURCE_ID }, CTX);
    expect(board).toHaveBeenLastCalledWith(expect.anything(), {
      method: 'POST', path: '/knowledge-writes/preview', body: { proposalId: SOURCE_ID }, requiredScope: 'knowledge-contents:write',
    });
    await expect(propose.handler({ title: 'T', content: 'C', owner: 'x' }, CTX)).rejects.toThrow(/Unknown arguments: owner/);
  });

  it('commit requires idempotencyKey FIRST and sends it as the Idempotency-Key header, never in the body', async () => {
    const board = jest.spyOn(rest, 'board').mockResolvedValue({ success: true, result: { status: 'committed' } });
    const commit = toolByName('relayhall_knowledge_note_commit')!;
    await expect(commit.handler({ proposalId: SOURCE_ID, previewDigest: 'a'.repeat(64), expectedRevision: 'absent' }, CTX))
      .rejects.toThrow(/idempotencyKey/);
    await expect(commit.handler({ idempotencyKey: 'short', proposalId: SOURCE_ID }, CTX)).rejects.toThrow(/16–128/);
    expect(board).not.toHaveBeenCalled();
    const key = 'commit-key-0123456789';
    await commit.handler({ proposalId: SOURCE_ID, previewDigest: 'a'.repeat(64), expectedRevision: 'absent', idempotencyKey: key }, CTX);
    expect(board).toHaveBeenLastCalledWith(expect.anything(), {
      method: 'POST', path: '/knowledge-writes/commit',
      body: { proposalId: SOURCE_ID, previewDigest: 'a'.repeat(64), expectedRevision: 'absent' },
      headers: { 'Idempotency-Key': key }, requiredScope: 'knowledge-contents:write',
    });
    expect((commit.inputSchema as { required: string[] }).required).toContain('idempotencyKey');
  });
});
