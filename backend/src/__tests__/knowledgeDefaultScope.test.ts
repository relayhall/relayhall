/**
 * Card 40e0e542 — THE DEFAULT SCOPE (owner ruling E127 (5), selector amendment
 * v1.2), measured through the REAL fan-out executor against a REAL HTTPS fixture
 * source, plus the descriptor rule, the coverage invariants, the rendering and
 * the route's input rule.
 *
 * REAL: the executor, the coverage builder, the result validator, the dial
 * client, the assertion signer, the handle sealer and the fixture's TLS
 * listener and REQUEST LOG. MOCKED, as in the fan-out suite: the database pool
 * and the two authority answers (the seam, not the rule). The same behaviour
 * through the production router, the MCP ingress and a real PostgreSQL is
 * `knowledgeDefaultScopeLive.test.ts`; the mutation controls are
 * `scripts/knowledge-default-scope-mutations.py`.
 *
 * THE RULE UNDER TEST. `includeArchive` is never authority: the core converts it
 * into each source's EXISTING `filter.categories` — (requested ?? declared)
 * minus the source's declared `archiveCategories` unless the caller opted in —
 * and never sends it. The wire body is the instrument for "never sent".
 *
 * THE RIDER (the L3 review). The scope sentence is true in each situation the
 * coverage record describes (`archive.declaredBy` names the consulted sources
 * that declare an archive), and the search ledger records the opt-in on every
 * fan-out entry.
 */
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import crypto from 'crypto';
import os from 'os';
import express from 'express';
import type { AddressInfo } from 'net';
import { pool } from '../db/connection';
import { KnowledgeFixtureSource } from './support/knowledgeFixtureSource';
import * as fanout from '../services/KnowledgeFanoutExecutor';
import { KnowledgeCoverageBuilder, type KnowledgeCoverage } from '../services/KnowledgeCoverage';
import { renderKnowledgeResponse, knowledgeScopeSentence } from '../services/KnowledgeProvenanceWrapper';
import { unsealKnowledgeHandle, resetKnowledgeHandleKeysetCache } from '../services/KnowledgeHandleSealer';
import { resetKnowledgeAssertionKeysetCache } from '../services/KnowledgeAssertionSigner';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { normalizeV2Query, scopedSourceCategories, KnowledgeSelectorError } from '../services/KnowledgeV2';
import { validateDescriptor, DescriptorError } from '../utils/serviceDescriptor';
import { knowledgeQueriesRouter } from '../routes/knowledge';

jest.setTimeout(60_000);

const SOURCE_ID = 'a1111111-1111-4111-8111-111111111111';
const ALL_ARCHIVE_ID = 'a2222222-2222-4222-8222-222222222222';
const PLAIN_ID = 'a3333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = 'b1111111-1111-4111-8111-111111111111';
const COMPARTMENT = 'c1111111-1111-4111-8111-111111111111';
const ISSUER = 'https://relayhall.test';
const ARCHIVE = 'relaybrain:archive';
const CURRENT = ['relaybrain:note', 'relaybrain:shared'];
const WIRE_KEYS = ['assertion', 'budget_ms', 'filter', 'limit', 'protocol_version', 'q'];

const fixture = new KnowledgeFixtureSource('scope40-default-scope-fixture');
let fixtureHost: string;

function firstExternalIpv4(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

const v2Descriptor = (categories: string[], archiveCategories?: string[]) => ({
  options: [],
  knowledgeSource: {
    classes: [{ key: 'docs', content: 'docs' }],
    compartments: [],
    protocol_version: 2,
    compartment_mode: 'dynamic-opaque',
    categories,
    ...(archiveCategories ? { archiveCategories } : {}),
  },
});

function row(id: string, slug: string, descriptor: unknown): Record<string, unknown> {
  return {
    id,
    slug,
    name: slug,
    status: 'published',
    retired_at: null,
    knowledge_query_endpoint: `https://${fixtureHost}:${fixture.port}/knowledge/${slug}`,
    knowledge_get_endpoint: null,
    knowledge_claims_mode: 'asserted',
    knowledge_subject_mode: 'pairwise',
    knowledge_relevant_groups: [],
    knowledge_allowed_networks: [`${fixtureHost}/32`],
    knowledge_core_credential_ref: 'scope/core',
    current_descriptor_version: 1,
    descriptor,
  };
}

let sourceRows: Record<string, unknown>[];

/** The fixture answers every search with one hit per category it was asked for (or all it declares). */
function hit(category: string, ref = `rb://${category}/doc`) {
  return { ref, title: `${category} title`, snippet: 'snippet', contentKind: 'docs', category, compartment: { id: COMPARTMENT, label: 'fixture' }, score: 0.5 };
}
function answer(results: unknown[]) {
  return JSON.stringify({ protocol_version: 2, retrieval: { status: 'complete', reasons: [] }, results });
}

beforeAll(async () => {
  const address = firstExternalIpv4();
  expect(address).not.toBeNull();
  fixtureHost = address as string;
  await fixture.start(fixtureHost);
});

afterAll(async () => {
  await fixture.stop();
});

beforeEach(() => {
  jest.restoreAllMocks();
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  process.env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS = JSON.stringify({ ka: (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64') });
  process.env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY = 'ka';
  process.env.RELAYHALL_KNOWLEDGE_HANDLE_KEYS = JSON.stringify({ h1: crypto.randomBytes(32).toString('base64') });
  process.env.RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY = 'h1';
  process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS = JSON.stringify({ 'scope/core': { bearer: 'core-to-scope-token' } });
  resetKnowledgeAssertionKeysetCache();
  resetKnowledgeHandleKeysetCache();
  fixture.reset();
  fixture.behaviour = { requireBearer: 'Bearer core-to-scope-token', body: answer([hit('relaybrain:note')]) };
  sourceRows = [row(SOURCE_ID, 'scope-source', v2Descriptor([ARCHIVE, ...CURRENT], [ARCHIVE]))];
  (pool.query as jest.Mock).mockImplementation(async (text: string) => {
    if (text.includes('FROM services s')) return { rows: sourceRows };
    if (text.includes('INSERT INTO knowledge_assertion_jti')) return { rows: [{ jti: 'x' }] };
    return { rows: [] };
  });
  jest.spyOn(authorizationRepository, 'authorizedIds').mockImplementation(async (_a, _t, ids) => new Set(ids.map(String)));
  jest.spyOn(authorizationRepository, 'selectorCoveredIds').mockImplementation(async (_a, _t, ids) => new Set(ids.map(String)));
});

const caller = () => ({
  principal: { id: ACCOUNT_ID, role: 'user', kind: 'human', status: 'active', parentPrincipalId: null },
  userId: 'holder',
  credentialId: 'cred-1',
  scopes: ['knowledge-contents:read'],
  authorizationActor: { principalId: ACCOUNT_ID, handle: 'holder', role: 'user', scopes: ['knowledge-contents:read'], authenticated: true, delegation: null },
});

/**
 * One search through the real executor. It must SETTLE: a coverage record the
 * builder refuses to build (an invariant broken by the code under test) is a
 * rejection, and it is reported here, at an assertion, with the error in the
 * received value - never as a crash of the test.
 */
async function search(overrides: Record<string, unknown> = {}) {
  const outcome = await fanout.executeKnowledgeQuery(
    caller() as never,
    { q: 'needle', kinds: ['code', 'docs', 'data'], limitPerSource: 8, timeoutMs: 3000, protocol_version: 2, ...overrides } as never,
    { issuer: ISSUER, callerGroupIds: [], trustAnchors: [fixture.certificate.cert] },
  ).then((value) => ({ settled: true as const, value }), (error: unknown) => ({ settled: false as const, error: String(error) }));
  expect(outcome).toMatchObject({ settled: true });
  return (outcome as { value: Awaited<ReturnType<typeof fanout.executeKnowledgeQuery>> }).value;
}

const wire = (index = 0) => JSON.parse(fixture.requests[index].body);

describe('card 40e0e542 — the request field', () => {
  it('includeArchive is a boolean v2 key: true is carried, false and absent are the default, anything else is refused', () => {
    expect(normalizeV2Query({ includeArchive: true })).toEqual({ kinds: ['code', 'data', 'docs'], includeArchive: true });
    expect(normalizeV2Query({ includeArchive: false })).toEqual({ kinds: ['code', 'data', 'docs'] });
    expect(normalizeV2Query({})).toEqual({ kinds: ['code', 'data', 'docs'] });
    for (const value of ['true', 1, null, [], {}]) {
      expect(() => normalizeV2Query({ includeArchive: value })).toThrow(KnowledgeSelectorError);
    }
    expect(() => normalizeV2Query({ include_archive: true })).toThrow(KnowledgeSelectorError);
  });

  it('the route refuses a non-boolean includeArchive and the key on a v1 request, and hands the executor the boolean', async () => {
    const seen: unknown[] = [];
    jest.spyOn(fanout, 'executeKnowledgeQuery').mockImplementation(async (_req, request) => {
      seen.push(request);
      return { coverage: new KnowledgeCoverageBuilder().build(), groups: [], auditRef: 'ka_' + 'a'.repeat(32) };
    });
    const app = express();
    app.use(express.json());
    app.use('/knowledge-queries', knowledgeQueriesRouter);
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      const post = async (body: unknown) => {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/knowledge-queries`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: response.status, json: await response.json() as { code?: string } };
      };
      expect(await post({ protocol_version: 2, q: 'needle', includeArchive: 'yes' })).toMatchObject({ status: 400, json: { code: 'INVALID_SELECTOR' } });
      expect(await post({ q: 'needle', includeArchive: true })).toMatchObject({ status: 400, json: { code: 'INVALID_SELECTOR' } });
      expect(seen).toHaveLength(0);
      expect((await post({ protocol_version: 2, q: 'needle', includeArchive: true })).status).toBe(200);
      expect((await post({ protocol_version: 2, q: 'needle' })).status).toBe(200);
      expect(seen[0]).toMatchObject({ includeArchive: true, protocol_version: 2 });
      expect(seen[1]).not.toHaveProperty('includeArchive');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('card 40e0e542 — the subtraction', () => {
  it('scopedSourceCategories: (requested ?? declared) minus the archive by default; unchanged on opt-in or without an archive', () => {
    const declared = [ARCHIVE, ...CURRENT];
    expect(scopedSourceCategories({ declared, archive: [ARCHIVE], includeArchive: false })).toEqual(CURRENT);
    expect(scopedSourceCategories({ declared, archive: [ARCHIVE], includeArchive: true })).toBeUndefined();
    expect(scopedSourceCategories({ requested: [ARCHIVE, 'relaybrain:note'], declared, archive: [ARCHIVE], includeArchive: false })).toEqual(['relaybrain:note']);
    expect(scopedSourceCategories({ requested: [ARCHIVE], declared, archive: [ARCHIVE], includeArchive: false })).toEqual([]);
    expect(scopedSourceCategories({ requested: [ARCHIVE], declared, archive: [ARCHIVE], includeArchive: true })).toEqual([ARCHIVE]);
    expect(scopedSourceCategories({ declared: [ARCHIVE], archive: [ARCHIVE], includeArchive: false })).toEqual([]);
    expect(scopedSourceCategories({ declared: CURRENT, includeArchive: false })).toBeUndefined();
    expect(scopedSourceCategories({ requested: ['relaybrain:note'], declared: CURRENT, archive: [], includeArchive: false })).toEqual(['relaybrain:note']);
  });

  it('DEFAULT: the source is asked for its declared categories minus the archive, and every handle binds that narrowed filter', async () => {
    const response = await search();
    expect(fixture.requests).toHaveLength(1);
    expect(wire().filter).toEqual({ version: 2, kinds: ['code', 'data', 'docs'], categories: CURRENT });
    expect(response.groups[0].results).toHaveLength(1);
    expect(unsealKnowledgeHandle(response.groups[0].results[0].handle).f).toEqual(wire().filter);
    expect(response.coverage.searchedCategories).toEqual([{ id: SOURCE_ID, categories: CURRENT }]);
    expect(response.coverage.archive).toEqual({ included: false, declaredBy: [SOURCE_ID] });
  });

  it('OPT-IN: the request is unchanged — no category filter is sent, the coverage says all and archive included', async () => {
    const response = await search({ includeArchive: true });
    expect(wire().filter).toEqual({ version: 2, kinds: ['code', 'data', 'docs'] });
    expect(unsealKnowledgeHandle(response.groups[0].results[0].handle).f).toEqual(wire().filter);
    expect(response.coverage.searchedCategories).toEqual([{ id: SOURCE_ID, categories: 'all' }]);
    expect(response.coverage.archive).toEqual({ included: true, declaredBy: [SOURCE_ID] });
  });

  it('THE FLAG NEVER LEAVES THE CORE: whatever includeArchive says, the source request carries exactly q, limit, protocol_version, filter, assertion and budget_ms', async () => {
    // A source WITHOUT an archive, so this control measures the wire alone and
    // not the subtraction (which has its own controls above and below).
    sourceRows = [row(PLAIN_ID, 'plain', v2Descriptor(CURRENT))];
    for (const includeArchive of [true, false, undefined]) {
      fixture.reset();
      fixture.behaviour = { requireBearer: 'Bearer core-to-scope-token', body: answer([hit('relaybrain:note')]) };
      await search(includeArchive === undefined ? {} : { includeArchive });
      expect(fixture.requests).toHaveLength(1);
      const body = wire();
      expect(Object.keys(body).sort()).toEqual(WIRE_KEYS);
      expect(Object.keys(body.filter).every((key) => ['version', 'kinds', 'categories'].includes(key))).toBe(true);
      expect(fixture.requests[0].body).not.toMatch(/includeArchive|include_archive/);
      const claims = JSON.parse(Buffer.from(String(body.assertion).split('.')[1], 'base64url').toString('utf8'));
      expect(JSON.stringify(claims)).not.toMatch(/includeArchive|include_archive/);
    }
  });

  it('a source whose declared categories are ALL archive is skipped with reason categories by default (never dialed) and consulted on opt-in', async () => {
    sourceRows = [row(ALL_ARCHIVE_ID, 'all-archive', v2Descriptor([ARCHIVE], [ARCHIVE]))];
    fixture.behaviour = { requireBearer: 'Bearer core-to-scope-token', body: answer([hit(ARCHIVE)]) };
    const byDefault = await search();
    expect(byDefault.coverage.skipped).toEqual([{ id: ALL_ARCHIVE_ID, reason: 'categories' }]);
    expect(byDefault.coverage.consulted).toEqual([]);
    expect(byDefault.coverage.searchedCategories).toEqual([]);
    expect(fixture.requests).toHaveLength(0);
    const optIn = await search({ includeArchive: true });
    expect(optIn.coverage.consulted).toEqual([ALL_ARCHIVE_ID]);
    expect(optIn.coverage.skipped).toEqual([]);
    expect(optIn.groups[0].results.map((result) => result.category)).toEqual([ARCHIVE]);
    expect(fixture.requests).toHaveLength(1);
  });

  it('a source that declares no archive is unaffected: default and opt-in send the same filter', async () => {
    sourceRows = [row(PLAIN_ID, 'plain', v2Descriptor(CURRENT))];
    await search();
    await search({ includeArchive: true });
    await search({ categories: ['relaybrain:note'] });
    expect(fixture.requests.map((request) => JSON.parse(request.body).filter)).toEqual([
      { version: 2, kinds: ['code', 'data', 'docs'] },
      { version: 2, kinds: ['code', 'data', 'docs'] },
      { version: 2, kinds: ['code', 'data', 'docs'], categories: ['relaybrain:note'] },
    ]);
  });

  it('explicit categories: archive-only is skipped by default, a mixed request is narrowed, and opt-in keeps the request', async () => {
    const archiveOnly = await search({ categories: [ARCHIVE] });
    expect(archiveOnly.coverage.skipped).toEqual([{ id: SOURCE_ID, reason: 'categories' }]);
    expect(fixture.requests).toHaveLength(0);
    await search({ categories: [ARCHIVE, 'relaybrain:note'] });
    expect(wire(0).filter.categories).toEqual(['relaybrain:note']);
    fixture.behaviour = { requireBearer: 'Bearer core-to-scope-token', body: answer([hit(ARCHIVE)]) };
    const kept = await search({ categories: [ARCHIVE], includeArchive: true });
    expect(wire(1).filter.categories).toEqual([ARCHIVE]);
    expect(kept.coverage.searchedCategories).toEqual([{ id: SOURCE_ID, categories: [ARCHIVE] }]);
  });

  it('a source that answers an ARCHIVE hit to a default search has it dropped and named in invalidResults; no handle carries it', async () => {
    fixture.behaviour = { requireBearer: 'Bearer core-to-scope-token', body: answer([hit('relaybrain:note'), hit(ARCHIVE)]) };
    const response = await search();
    expect(response.coverage.invalidResults).toEqual([SOURCE_ID]);
    expect(response.groups[0].results.map((result) => result.category)).toEqual(['relaybrain:note']);
    for (const result of response.groups[0].results) {
      expect(unsealKnowledgeHandle(result.handle).r).not.toBe(`rb://${ARCHIVE}/doc`);
    }
  });
});

describe('card 40e0e542 — the coverage record and the answer', () => {
  it('searchedCategories names only consulted ids, once, never an empty list; an excluded archive cannot be named', () => {
    const notConsulted = new KnowledgeCoverageBuilder();
    expect(() => notConsulted.markSearchedCategories(SOURCE_ID, CURRENT)).toThrow('modifier of consulted');
    const twice = new KnowledgeCoverageBuilder();
    twice.record(SOURCE_ID, 'answered');
    twice.markSearchedCategories(SOURCE_ID, CURRENT);
    expect(() => twice.markSearchedCategories(SOURCE_ID, CURRENT)).toThrow('already names');
    const empty = new KnowledgeCoverageBuilder();
    empty.record(SOURCE_ID, 'answered');
    expect(() => empty.markSearchedCategories(SOURCE_ID, [])).toThrow('no categories');
    for (const reached of [[ARCHIVE, 'relaybrain:note'], 'all'] as const) {
      const leak = new KnowledgeCoverageBuilder({ archiveIncluded: false });
      leak.record(SOURCE_ID, 'timedOut');
      leak.markSearchedCategories(SOURCE_ID, reached, [ARCHIVE]);
      expect(() => leak.build()).toThrow('archive is excluded');
      const optedIn = new KnowledgeCoverageBuilder({ archiveIncluded: true });
      optedIn.record(SOURCE_ID, 'timedOut');
      optedIn.markSearchedCategories(SOURCE_ID, reached, [ARCHIVE]);
      expect(optedIn.build()).toMatchObject({ archive: { included: true }, searchedCategories: [{ id: SOURCE_ID }] });
    }
    const honest = new KnowledgeCoverageBuilder();
    honest.record(SOURCE_ID, 'answered');
    honest.markSearchedCategories(SOURCE_ID, ['relaybrain:shared', 'relaybrain:note'], [ARCHIVE]);
    expect(honest.build()).toMatchObject({ searchedCategories: [{ id: SOURCE_ID, categories: CURRENT }], archive: { included: false } });
    // Invariant 7 (rider): declaredBy is the CONSULTED sources that declare an
    // archive - a skipped one is never named, nor one without an archive.
    const declared = new KnowledgeCoverageBuilder();
    declared.markSkipped(ALL_ARCHIVE_ID, 'categories');
    declared.record(SOURCE_ID, 'answered');
    declared.markSearchedCategories(SOURCE_ID, CURRENT, [ARCHIVE]);
    declared.record(PLAIN_ID, 'timedOut');
    declared.markSearchedCategories(PLAIN_ID, 'all');
    expect(declared.build().archive).toEqual({ included: false, declaredBy: [SOURCE_ID] });
  });

  it('the scope sentence is true in each situation: no declaring source, the default, the opt-in, and an opt-in every declaring source refused', async () => {
    const NONE = 'Searched: current knowledge (no consulted source declares an archive).';
    const EXCLUDED = 'Searched: current knowledge; archive excluded (pass includeArchive: true).';
    const INCLUDED = 'Searched: current knowledge and the archive (includeArchive: true).';
    const REFUSED = 'Scope requested: current knowledge and the archive; the archive sources refused.';
    // Exactly one scope sentence per rendered answer, before the record and the results.
    const sentenceOf = (coverage: KnowledgeCoverage): string => {
      const text = renderKnowledgeResponse(coverage, [], 'ka_' + 'b'.repeat(32));
      const lines = text.split('\n').filter((line) => /^(Searched|Scope requested):/.test(line));
      expect(lines).toEqual([knowledgeScopeSentence(coverage)]);
      expect(text.indexOf(lines[0])).toBeLessThan(text.indexOf('# Results'));
      return lines[0];
    };
    // 1. No consulted source declares an archive: there is none to exclude or
    //    include, whatever the flag says (the L3 review's first probe).
    sourceRows = [row(PLAIN_ID, 'plain', v2Descriptor(CURRENT))];
    const plain = await search();
    expect(plain.coverage.archive).toEqual({ included: false, declaredBy: [] });
    expect(sentenceOf(plain.coverage)).toBe(NONE);
    const plainOptIn = await search({ includeArchive: true });
    expect(plainOptIn.coverage.archive).toEqual({ included: true, declaredBy: [] });
    expect(sentenceOf(plainOptIn.coverage)).toBe(NONE);
    // 2. The default over a declaring source, built through the builder so this
    //    control stands apart from the subtraction's own (the DEFAULT test above
    //    drives the executor and pins declaredBy there).
    const byDefault = new KnowledgeCoverageBuilder();
    byDefault.record(SOURCE_ID, 'answered');
    byDefault.markSearchedCategories(SOURCE_ID, CURRENT, [ARCHIVE]);
    expect(sentenceOf(byDefault.build())).toBe(EXCLUDED);
    // 3. The opt-in over a declaring source that answers.
    sourceRows = [row(SOURCE_ID, 'scope-source', v2Descriptor([ARCHIVE, ...CURRENT], [ARCHIVE]))];
    const optIn = await search({ includeArchive: true });
    expect(optIn.coverage).toMatchObject({ answered: [SOURCE_ID], archive: { included: true, declaredBy: [SOURCE_ID] } });
    expect(sentenceOf(optIn.coverage)).toBe(INCLUDED);
    // 4. The opt-in, and the only declaring source refused it (the probe A6).
    fixture.behaviour = { requireBearer: 'Bearer core-to-scope-token', status: 403, body: '{}' };
    const refused = await search({ includeArchive: true });
    expect(refused.coverage).toMatchObject({ refusedBySource: [SOURCE_ID], archive: { included: true, declaredBy: [SOURCE_ID] } });
    expect(sentenceOf(refused.coverage)).toBe(REFUSED);
    // A source WITHOUT an archive answering does not make a refused archive searched...
    const archiveRefused = new KnowledgeCoverageBuilder({ archiveIncluded: true });
    archiveRefused.record(SOURCE_ID, 'refusedBySource');
    archiveRefused.markSearchedCategories(SOURCE_ID, 'all', [ARCHIVE]);
    archiveRefused.record(PLAIN_ID, 'answered');
    archiveRefused.markSearchedCategories(PLAIN_ID, 'all');
    expect(sentenceOf(archiveRefused.build())).toBe(REFUSED);
    // ...and one declaring source that did not refuse is enough for the archive to have been searched.
    const partly = new KnowledgeCoverageBuilder({ archiveIncluded: true });
    partly.record(SOURCE_ID, 'refusedBySource');
    partly.markSearchedCategories(SOURCE_ID, 'all', [ARCHIVE]);
    partly.record(ALL_ARCHIVE_ID, 'answered');
    partly.markSearchedCategories(ALL_ARCHIVE_ID, 'all', [ARCHIVE]);
    expect(partly.build().archive).toEqual({ included: true, declaredBy: [SOURCE_ID, ALL_ARCHIVE_ID] });
    expect(sentenceOf(partly.build())).toBe(INCLUDED);
  });

  it('the search ledger records the caller\'s archive opt-in on every fan-out entry', async () => {
    sourceRows = [row(PLAIN_ID, 'plain', v2Descriptor(CURRENT))];
    // The fan-out document is the sixth parameter of the ledger INSERT.
    const ledger = (): Array<Array<{ sourceId: string; outcome: string; archiveIncluded?: boolean }>> => (pool.query as jest.Mock).mock.calls
      .filter(([text]) => String(text).includes('INSERT INTO knowledge_search_audit'))
      .map(([, params]) => JSON.parse(String((params as unknown[])[5])));
    const base = ledger().length;
    await search();
    await search({ includeArchive: true });
    expect(ledger().slice(base).map((fanout) => fanout.map((entry) => [entry.sourceId, entry.outcome, entry.archiveIncluded])))
      .toEqual([[[PLAIN_ID, 'answered', false]], [[PLAIN_ID, 'answered', true]]]);
  });
});

describe('card 40e0e542 — the descriptor field', () => {
  const block = (extra: Record<string, unknown>) => ({ options: [], knowledgeSource: { ...v2Descriptor([ARCHIVE, ...CURRENT]).knowledgeSource, ...extra } });
  const refusal = (input: unknown): DescriptorError | null => {
    try { validateDescriptor(input); return null; } catch (error) { return error as DescriptorError; }
  };

  it('archiveCategories is accepted as a subset of the declared categories, all of them included', () => {
    expect(validateDescriptor(block({ archiveCategories: [ARCHIVE] })).knowledgeSource?.archiveCategories).toEqual([ARCHIVE]);
    expect(validateDescriptor(block({ archiveCategories: [ARCHIVE, ...CURRENT] })).knowledgeSource?.archiveCategories).toEqual([ARCHIVE, ...CURRENT]);
    expect(validateDescriptor(block({})).knowledgeSource).not.toHaveProperty('archiveCategories');
  });

  it('archiveCategories outside the declared categories is refused, so the real archive cannot stay in the default search', () => {
    expect(refusal(block({ archiveCategories: ['relaybrain:snapshot'] }))).toMatchObject({ code: 'DESCRIPTOR_INVALID_KNOWLEDGE_SOURCE', field: 'descriptor.knowledgeSource.archiveCategories' });
    expect(refusal(block({ archiveCategories: [ARCHIVE, 'relaybrain:snapshot'] }))).toMatchObject({ field: 'descriptor.knowledgeSource.archiveCategories' });
  });

  it('archiveCategories must be a non-empty array without duplicates, and only on a v2 block', () => {
    for (const value of [[], [ARCHIVE, ARCHIVE], ARCHIVE, [1]]) {
      expect(refusal(block({ archiveCategories: value }))).toMatchObject({ field: 'descriptor.knowledgeSource.archiveCategories' });
    }
    expect(refusal({ options: [], knowledgeSource: { classes: [{ key: 'docs', content: 'docs' }], compartments: ['corpus'], archiveCategories: [ARCHIVE] } }))
      .toMatchObject({ code: 'DESCRIPTOR_INVALID_KNOWLEDGE_SOURCE' });
  });
});
