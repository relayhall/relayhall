/**
 * RH-KW1 candidate C — KNOWLEDGE-DESIGN `94747de9` ACCEPTANCE ITEMS 2, 7, 8,
 * 9, 10 and 13, measured through the REAL fan-out executor against a REAL
 * HTTPS fixture source.
 *
 * ── WHAT IS REAL HERE AND WHAT IS NOT ──
 *
 * REAL: the executor, the coverage builder, the result validator, the dial
 * client and its socket pin, the assertion signer, the handle sealer, the
 * fixture source's TLS listener and its REQUEST LOG. Every outbound leg in
 * this file is an actual TLS connection to a server whose certificate is
 * minted per run.
 *
 * MOCKED: the database pool, and the two authority questions the executor
 * asks the shipped repository (`authorizedIds`, `selectorCoveredIds`). Those
 * two are the SEAM, not the rule: what the rule DOES with real grants,
 * profiles and visibility is measured against a real PostgreSQL in
 * `kw1KnowledgeBoardAuthorization.test.ts`, because a mocked pool can only
 * replay a predicate, never evaluate one. Items 1 and 11 therefore live in
 * that suite; this one measures what the executor does with the answers.
 *
 * ── THE INSTRUMENT FOR "NOTHING WAS SENT" ──
 *
 * The fixture's `requests` array. A refusal observed only as a returned token
 * proves core said no; an EMPTY fixture log proves nothing left the process.
 * Every concealment clause below asserts the log, not just the response.
 */
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import crypto from 'crypto';
import https from 'https';
import os from 'os';
import { pool } from '../db/connection';
import { KnowledgeFixtureSource } from './support/knowledgeFixtureSource';
import { executeKnowledgeQuery } from '../services/KnowledgeFanoutExecutor';
import { KnowledgeCoverageBuilder, KnowledgeCoverageError } from '../services/KnowledgeCoverage';
import { validateSourceResults, KNOWLEDGE_RESPONSE_MAX_BYTES } from '../services/KnowledgeResultValidator';
import { renderKnowledgeResponse } from '../services/KnowledgeProvenanceWrapper';
import {
  unsealKnowledgeHandle,
  sealKnowledgeHandle,
  resetKnowledgeHandleKeysetCache,
} from '../services/KnowledgeHandleSealer';
import { executeKnowledgeGet } from '../services/KnowledgeGetExecutor';
import {
  ASSERTION_MAX_TTL_SECONDS,
  ASSERTION_DEFAULT_TTL_SECONDS,
} from '../services/KnowledgeAssertionSigner';
import {
  KNOWLEDGE_WHOLE_REQUEST_MAX_MS,
  KNOWLEDGE_ADMISSION_MAX_MS,
  KNOWLEDGE_LEDGER_MAX_MS,
  KNOWLEDGE_CANDIDATE_ROWS_MAX,
  KNOWLEDGE_FANOUT_CONCURRENCY,
  knowledgeAdmissionBudgetMs,
  knowledgeMaxAssertionAgeMs,
} from '../services/KnowledgeDeadline';
import { ARM_EVALUATION_MAX_AGE_SECONDS } from '../services/KnowledgeArmEvaluator';
import { KNOWLEDGE_BOARD_SOURCE_SLUG } from '../services/KnowledgeSourcePolicy';
import {
  resetKnowledgeAssertionKeysetCache,
  knowledgeAssertionJwks,
  ASSERTION_TYP,
} from '../services/KnowledgeAssertionSigner';
import { authorizationRepository } from '../services/AuthorizationRepository';
import * as signer from '../services/KnowledgeAssertionSigner';
import * as boardAdapter from '../services/KnowledgeBoardAdapter';
import * as armEvaluator from '../services/KnowledgeArmEvaluator';
import * as dialClient from '../services/KnowledgeDialClient';
import ts from 'typescript';
import { loadMutatedModule, readShippedSource, applyMutations } from './support/moduleMutation';

jest.setTimeout(120_000);

const ASSERTED_ID = 'a1111111-1111-4111-8111-111111111111';
const NONE_ID = 'a2222222-2222-4222-8222-222222222222';
const BOARD_ID = 'a3333333-3333-4333-8333-333333333333';
const CODE_ONLY_ID = 'a4444444-4444-4444-8444-444444444444';
const DEAD_ID = 'a5555555-5555-4555-8555-555555555555';
const ACCOUNT_ID = 'b1111111-1111-4111-8111-111111111111';
const ISSUER = 'https://relayhall.test';

function keypair(): string {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64');
}

// NAMED, because both certificates are handed to the dial client as trust
// anchors below: two self-signed anchors sharing a subject name cannot both be
// verified out of one store, and the symptom is a `connect-failed` that looks
// like the fixture is down.
const asserted = new KnowledgeFixtureSource('kw1-fanout-asserted-fixture');
const quiet = new KnowledgeFixtureSource('kw1-fanout-none-fixture');

/**
 * The fixtures bind to this host's first NON-INTERNAL IPv4, and each source
 * row allow-lists exactly that /32.
 *
 * Not a convenience: §4.2 refuses loopback unconditionally and forbids
 * allow-listing it, so a fixture on 127.0.0.1 would make every leg below
 * `refusedByPolicy` and this suite would measure the outbound policy candidate
 * A already proves instead of the executor it is about. Candidate A's suite
 * binds the same way for the same reason.
 */
function firstExternalIpv4(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

let fixtureHost: string;
/** The /32 that admits the fixtures' own address and nothing else. */
let allowFixturesOnly: string[];

/** The rows `loadCandidateRows` returns. Each drill edits this list. */
let sourceRows: Record<string, unknown>[];
/** Every `knowledge_search_audit` INSERT this run made. */
let searchAudit: unknown[][];
/** Every `knowledge_get_audit` INSERT this run made. */
let getAudit: unknown[][];

const knowledgeBlock = (kinds: string[], compartments: string[]) => ({
  options: [],
  knowledgeSource: {
    classes: kinds.map((kind) => ({ key: kind, content: kind })),
    compartments,
  },
});

function externalRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: ASSERTED_ID,
    slug: 'engine',
    name: 'Engine',
    status: 'published',
    retired_at: null,
    knowledge_query_endpoint: `https://${fixtureHost}:${asserted.port}/knowledge/query`,
    knowledge_get_endpoint: null,
    knowledge_claims_mode: 'asserted',
    knowledge_subject_mode: 'pairwise',
    knowledge_relevant_groups: ['group-1'],
    knowledge_allowed_networks: allowFixturesOnly,
    knowledge_core_credential_ref: 'engine/core',
    current_descriptor_version: 1,
    descriptor: knowledgeBlock(['docs'], ['corpus']),
    ...overrides,
  };
}

beforeAll(async () => {
  const address = firstExternalIpv4();
  // A skip here would be a suite that cannot fail. If this host has no
  // non-internal IPv4, the legs below are unprovable and the suite says so.
  expect(address).not.toBeNull();
  fixtureHost = address as string;
  allowFixturesOnly = [`${fixtureHost}/32`];
  await asserted.start(fixtureHost);
  await quiet.start(fixtureHost);
});

afterAll(async () => {
  await asserted.stop();
  await quiet.stop();
});

let assertionKey: string;

beforeEach(() => {
  jest.restoreAllMocks();
  assertionKey = keypair();
  process.env.RELAYHALL_KNOWLEDGE_ASSERTION_KEYS = JSON.stringify({ ka: assertionKey });
  process.env.RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY = 'ka';
  delete process.env.RELAYHALL_KNOWLEDGE_ASSERTION_RETIRED_KEYS;
  process.env.RELAYHALL_KNOWLEDGE_HANDLE_KEYS = JSON.stringify({
    h1: crypto.randomBytes(32).toString('base64'),
  });
  process.env.RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY = 'h1';
  process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS = JSON.stringify({
    'engine/core': { bearer: 'core-to-engine-token' },
    'quiet/core': { bearer: 'core-to-quiet-token' },
    'dead/core': { bearer: 'core-to-dead-token' },
  });
  delete process.env.RELAYHALL_KNOWLEDGE_KIND_PRIORITY;
  resetKnowledgeAssertionKeysetCache();
  resetKnowledgeHandleKeysetCache();

  asserted.requests.length = 0;
  quiet.requests.length = 0;
  asserted.behaviour = { status: 200, body: '{"results":[]}' };
  quiet.behaviour = { status: 200, body: '{"results":[]}' };

  sourceRows = [externalRow({})];
  searchAudit = [];
  getAudit = [];

  (pool.query as jest.Mock).mockImplementation(async (text: string, params?: unknown[]) => {
    if (text.includes('FROM services s')) return { rows: sourceRows };
    if (text.includes('FROM service_descriptor_versions WHERE service_id')) {
      const row = sourceRows.find((entry) => entry.id === String((params ?? [])[0]));
      return { rows: row ? [{ descriptor: row.descriptor }] : [] };
    }
    if (text.includes('INSERT INTO knowledge_assertion_jti')) {
      return { rows: [{ jti: String((params ?? [])[0]) }] };
    }
    if (text.includes('INSERT INTO knowledge_search_audit')) {
      searchAudit.push((params ?? []) as unknown[]);
      return { rows: [] };
    }
    if (text.includes('INSERT INTO knowledge_get_audit')) {
      getAudit.push((params ?? []) as unknown[]);
      return { rows: [] };
    }
    if (text.includes('FROM reports r')) return { rows: [] };
    if (text.includes('FROM tasks t')) return { rows: [] };
    if (text.includes('FROM skills s')) return { rows: [] };
    return { rows: [] };
  });

  // The SEAM, not the rule: admit every id the executor asks about, so this
  // suite measures what it does with a yes. The rule itself is measured
  // against real rows in the board-authorization suite.
  jest.spyOn(authorizationRepository, 'authorizedIds')
    .mockImplementation(async (_actor, _type, ids) => new Set(ids.map(String)));
  jest.spyOn(authorizationRepository, 'selectorCoveredIds')
    .mockImplementation(async (_actor, _type, ids) => new Set(ids.map(String)));
});

const caller = (scopes: string[] = ['knowledge-contents:read']) => ({
  principal: { id: ACCOUNT_ID, role: 'user' },
  userId: 'holder',
  credentialId: 'cred-1',
  scopes,
  authorizationActor: {
    principalId: ACCOUNT_ID,
    handle: 'holder',
    role: 'user',
    scopes,
    authenticated: true,
    delegation: null,
  },
});

async function search(overrides: Record<string, unknown> = {}, scopes?: string[]) {
  return executeKnowledgeQuery(
    caller(scopes) as never,
    {
      q: 'needle',
      kinds: ['code', 'docs', 'data'],
      limitPerSource: 8,
      timeoutMs: 3000,
      ...overrides,
    } as never,
    // BOTH anchors: each fixture mints its own certificate, and a drill
    // touching the `none`-mode fixture would otherwise fail the handshake
    // and report a transport failure that has nothing to do with its
    // subject (owner decision D7(a) supplies the seam; candidate A drills it).
    {
      issuer: ISSUER,
      callerGroupIds: ['group-1'],
      trustAnchors: [asserted.certificate.cert, quiet.certificate.cert],
    },
  );
}

const resultBody = (count: number, overrides: Record<string, unknown> = {}) => JSON.stringify({
  results: Array.from({ length: count }, (_, index) => ({
    ref: `doc-${index}`,
    title: `Title ${index}`,
    snippet: 'a snippet',
    contentKind: 'docs',
    compartment: 'corpus',
    score: 0.5,
    ...overrides,
  })),
});

// ══════════════════ item 9 — the coverage partition ═══════════════════════

describe('§7.5 / item 9 — the coverage record is a partition, and cannot be built otherwise', () => {
  it('a run touching several outcomes keeps the buckets pairwise disjoint and covering consulted', async () => {
    sourceRows = [
      externalRow({}),
      externalRow({
        id: NONE_ID,
        slug: 'quiet',
        knowledge_claims_mode: 'none',
        knowledge_query_endpoint: `https://${fixtureHost}:${quiet.port}/knowledge/query`,
        knowledge_core_credential_ref: 'quiet/core',
      }),
      externalRow({
        id: DEAD_ID,
        slug: 'dead',
        // Port 1 is not listening: a connect failure, not a policy refusal.
        knowledge_query_endpoint: `https://${fixtureHost}:9/knowledge/query`,
        knowledge_core_credential_ref: 'dead/core',
      }),
      externalRow({
        id: CODE_ONLY_ID,
        slug: 'codeonly',
        descriptor: knowledgeBlock(['code'], ['corpus']),
      }),
    ];
    asserted.behaviour = { status: 200, body: resultBody(1) };
    quiet.behaviour = { status: 429, headers: { 'retry-after': '42' }, body: '' };

    const response = await search({ kinds: ['docs'] });
    const { coverage } = response;

    const buckets = [
      coverage.answered,
      coverage.timedOut,
      coverage.unavailable.map((entry) => entry.id),
      coverage.refusedBySource,
      coverage.refusedByPolicy,
    ];
    const flat = buckets.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.sort()).toEqual([...coverage.consulted].sort());

    // The `code`-only source passed (a)-(c),(e) and failed (d): NAMED, with
    // the one reason v1 has, and disjoint from `consulted`.
    expect(coverage.skipped).toEqual([{ id: CODE_ONLY_ID, reason: 'kinds' }]);
    expect(coverage.consulted).not.toContain(CODE_ONLY_ID);

    for (const id of [...coverage.truncatedResults, ...coverage.invalidResults]) {
      expect(coverage.answered).toContain(id);
    }
  });

  it('the builder refuses to encode a second outcome for one source', () => {
    const builder = new KnowledgeCoverageBuilder();
    builder.record('s1', 'answered');
    expect(() => builder.record('s1', 'timedOut')).toThrow(KnowledgeCoverageError);
  });

  it('the builder refuses a modifier on a source that did not answer', () => {
    const builder = new KnowledgeCoverageBuilder();
    builder.record('s1', 'timedOut');
    expect(() => builder.markTruncated('s1')).toThrow(KnowledgeCoverageError);
    expect(() => builder.markInvalid('s1')).toThrow(KnowledgeCoverageError);
  });

  it('the builder refuses a source that is both skipped and consulted, in either order', () => {
    const one = new KnowledgeCoverageBuilder();
    one.markSkipped('s1');
    expect(() => one.record('s1', 'answered')).toThrow(KnowledgeCoverageError);
    const two = new KnowledgeCoverageBuilder();
    two.record('s2', 'answered');
    expect(() => two.markSkipped('s2')).toThrow(KnowledgeCoverageError);
  });
});

// ═══════════════════ item 8 — failure honesty ═════════════════════════════

describe('§7.3 / item 8 — every failure lands in the bucket the design names', () => {
  it('a slow source is timedOut', async () => {
    asserted.behaviour = { status: 200, body: resultBody(1), delayMs: 1500 };
    const { coverage } = await search({ timeoutMs: 500 });
    expect(coverage.timedOut).toEqual([ASSERTED_ID]);
    expect(coverage.answered).toEqual([]);
  });

  it('a refused connection is unavailable:transport', async () => {
    sourceRows = [externalRow({
      id: DEAD_ID,
      slug: 'dead',
      knowledge_query_endpoint: `https://${fixtureHost}:9/knowledge/query`,
      knowledge_core_credential_ref: 'dead/core',
    })];
    const { coverage } = await search();
    expect(coverage.unavailable).toEqual([{ id: DEAD_ID, reason: 'transport' }]);
  });

  it('a 429 is unavailable:rate-limited with the Retry-After value passed through', async () => {
    asserted.behaviour = { status: 429, headers: { 'retry-after': '17' }, body: '' };
    const { coverage } = await search();
    expect(coverage.unavailable).toEqual([{ id: ASSERTED_ID, reason: 'rate-limited', retryAfterSeconds: 17 }]);
  });

  it('a channel-auth failure is unavailable:transport, and nothing reaches the source', async () => {
    // The deployment holds no material for this source's reference name: core
    // cannot authenticate ITSELF, so §4.2 forbids the dial outright.
    sourceRows = [externalRow({ knowledge_core_credential_ref: 'engine/absent' })];
    const { coverage } = await search();
    expect(coverage.unavailable).toEqual([{ id: ASSERTED_ID, reason: 'transport' }]);
    expect(asserted.requests).toHaveLength(0);
  });

  it('a redirect is refusedByPolicy and is not followed', async () => {
    asserted.behaviour = { status: 302, headers: { location: 'https://elsewhere.invalid/' }, body: '' };
    const { coverage } = await search();
    expect(coverage.refusedByPolicy).toEqual([ASSERTED_ID]);
  });

  it('an explicit denial envelope is refusedBySource', async () => {
    asserted.behaviour = { status: 200, body: '{"refused":true}' };
    const { coverage } = await search();
    expect(coverage.refusedBySource).toEqual([ASSERTED_ID]);
  });

  it('a candidate whose arm fails between selection and signing is ABSENT, not refused', async () => {
    jest.spyOn(armEvaluator, 'evaluateKnowledgeArms').mockResolvedValue(null);
    const { coverage, groups } = await search();
    expect(coverage.consulted).toEqual([]);
    expect(coverage.skipped).toEqual([]);
    expect(groups).toEqual([]);
    expect(asserted.requests).toHaveLength(0);
  });
});

// ═══════════════════ item 7 — flooding ════════════════════════════════════

describe('§7.2 / item 7 — a flooding source is capped, and the honesty record survives', () => {
  it('ten times the limit is capped, and the source is named in truncatedResults', async () => {
    asserted.behaviour = { status: 200, body: resultBody(80) };
    const { coverage, groups } = await search({ limitPerSource: 8 });
    expect(groups[0].results).toHaveLength(8);
    expect(coverage.answered).toEqual([ASSERTED_ID]);
    expect(coverage.truncatedResults).toEqual([ASSERTED_ID]);
    expect(coverage.invalidResults).toEqual([]);
  });

  it('the coverage record is rendered BEFORE results, so a text budget takes results', async () => {
    asserted.behaviour = { status: 200, body: resultBody(8) };
    const response = await search();
    const rendered = renderKnowledgeResponse(response.coverage, response.groups, response.auditRef);
    const coverageIndex = rendered.indexOf('Knowledge search coverage');
    const resultsIndex = rendered.indexOf('# Results');
    expect(coverageIndex).toBeGreaterThanOrEqual(0);
    expect(resultsIndex).toBeGreaterThan(coverageIndex);
    // Budgeting to the length of the coverage half keeps the whole record.
    const budgeted = rendered.slice(0, resultsIndex);
    expect(budgeted).toContain(ASSERTED_ID);
    expect(budgeted).toContain('"consulted"');
  });
});

// ═════════ item 10 — oracle resistance, measured as byte equality ═════════

describe('§5.5 / item 10 — a concealed source is byte-identical to one that never existed', () => {
  it('naming an unreachable real id and naming a random UUID produce the same response', async () => {
    const hidden = externalRow({ id: NONE_ID, slug: 'hidden' });
    sourceRows = [externalRow({}), hidden];
    // The caller may not reach the hidden source: limb (b) says no.
    jest.spyOn(authorizationRepository, 'authorizedIds')
      .mockImplementation(async (_actor, _type, ids) =>
        new Set(ids.map(String).filter((id) => id !== NONE_ID)));
    asserted.behaviour = { status: 200, body: resultBody(1) };

    const named = await search({ sources: [ASSERTED_ID, NONE_ID] });
    asserted.requests.length = 0;
    const random = await search({ sources: [ASSERTED_ID, 'c0000000-0000-4000-8000-000000000000'] });

    const strip = (response: Awaited<ReturnType<typeof search>>) =>
      JSON.stringify({
        coverage: response.coverage,
        groups: response.groups.map((group) => ({ ...group, results: group.results.length })),
      });
    expect(strip(named)).toEqual(strip(random));
  });

  it('a kinds-skipped source is named with reason kinds — the one disposition that is disclosed', async () => {
    sourceRows = [externalRow({ id: CODE_ONLY_ID, slug: 'codeonly', descriptor: knowledgeBlock(['code'], ['corpus']) })];
    const { coverage } = await search({ kinds: ['docs'] });
    expect(coverage.skipped).toEqual([{ id: CODE_ONLY_ID, reason: 'kinds' }]);
    expect(asserted.requests).toHaveLength(0);
  });
});

// ═════════ item 13 — statelessness observables, at the signer seam ════════

describe('§5.2 / item 13 — signings are counted at the ONE assertion-signer seam', () => {
  it('exactly ONE signing per asserted-source dial on the search leg', async () => {
    const spy = jest.spyOn(signer, 'signKnowledgeAssertion');
    asserted.behaviour = { status: 200, body: resultBody(1) };
    await search();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(asserted.requests).toHaveLength(1);
  });

  it('ZERO signings for a none-mode dial, and the wire carries no assertion', async () => {
    const spy = jest.spyOn(signer, 'signKnowledgeAssertion');
    sourceRows = [externalRow({
      id: NONE_ID,
      slug: 'quiet',
      knowledge_claims_mode: 'none',
      knowledge_query_endpoint: `https://${fixtureHost}:${quiet.port}/knowledge/query`,
      knowledge_core_credential_ref: 'quiet/core',
    })];
    quiet.behaviour = { status: 200, body: resultBody(1) };
    await search();
    expect(spy).not.toHaveBeenCalled();
    expect(quiet.requests).toHaveLength(1);
    expect(JSON.parse(quiet.requests[0].body).assertion).toBeUndefined();
  });

  it('a none-mode source STILL receives a channel-authenticated dial (mutation: remove the material)', async () => {
    sourceRows = [externalRow({
      id: NONE_ID,
      slug: 'quiet',
      knowledge_claims_mode: 'none',
      knowledge_query_endpoint: `https://${fixtureHost}:${quiet.port}/knowledge/query`,
      knowledge_core_credential_ref: 'quiet/core',
    })];
    quiet.behaviour = { status: 200, body: resultBody(1) };
    const authenticated = await search();
    expect(authenticated.coverage.answered).toEqual([NONE_ID]);
    expect(quiet.requests[0].headers.authorization).toBe('Bearer core-to-quiet-token');

    // THE MUTATION: disable channel auth for the `none` fixture. The drill
    // must redden — that is sol R1-2's whole point, that `none` omits the
    // ASSERTION and never the channel.
    quiet.requests.length = 0;
    process.env.RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS = JSON.stringify({});
    const mutated = await search();
    expect(mutated.coverage.answered).toEqual([]);
    expect(mutated.coverage.unavailable).toEqual([{ id: NONE_ID, reason: 'transport' }]);
    expect(quiet.requests).toHaveLength(0);
  });

  it('ZERO signings for a board dial, and the board adapter is the one that ran', async () => {
    const spy = jest.spyOn(signer, 'signKnowledgeAssertion');
    const board = jest.spyOn(boardAdapter, 'searchBoard')
      .mockResolvedValue({ results: [], truncated: false });
    sourceRows = [{
      ...externalRow({}),
      id: BOARD_ID,
      slug: 'board',
      knowledge_query_endpoint: null,
      knowledge_core_credential_ref: null,
      descriptor: knowledgeBlock(['docs'], ['reports', 'tasks', 'skills']),
    }];
    const { coverage } = await search();
    expect(spy).not.toHaveBeenCalled();
    expect(board).toHaveBeenCalledTimes(1);
    expect(coverage.answered).toEqual([BOARD_ID]);
    expect(asserted.requests).toHaveLength(0);
  });

  it('the signer refuses a caller outside its producer set — the property, not a count', async () => {
    // The whole producer set, re-proved at the executor's own seam: an
    // evaluation with every field right, minted by nobody, is refused.
    const forged = Object.freeze({
      sourceId: ASSERTED_ID,
      sourceSlug: 'engine',
      claimsMode: 'asserted',
      subjectMode: 'pairwise',
      relevantGroups: [],
      accountPrincipalId: ACCOUNT_ID,
      at: Math.floor(Date.now() / 1000),
    });
    await expect(signer.signKnowledgeAssertion({
      armEvaluation: forged as never,
      issuer: ISSUER,
      callerGroupIds: [],
    })).rejects.toMatchObject({ code: 'ASSERTION_WITHOUT_ARM_EVALUATION' });
  });
});

// ═════════════ item 2 — assertions and the channel that carries them ══════

describe('§5.2 / §5.4 / item 2 — what the source can and cannot verify', () => {
  async function capturedAssertion(): Promise<string> {
    asserted.behaviour = { status: 200, body: resultBody(1) };
    await search();
    return JSON.parse(asserted.requests[0].body).assertion as string;
  }

  /** The fixture's verification, as a relying source would perform it. */
  function verify(compact: string, expectedAudience: string): boolean {
    const [header, payload, signature] = compact.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    if (head.alg !== 'EdDSA') return false;
    const jwk = knowledgeAssertionJwks().keys.find((key) => key.kid === head.kid);
    if (!jwk) return false;
    const key = crypto.createPublicKey({ key: jwk as never, format: 'jwk' });
    const verified = crypto.verify(
      null,
      Buffer.from(`${header}.${payload}`, 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    );
    if (!verified) return false;
    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== expectedAudience) return false;
    if (typeof claims.exp !== 'number' || claims.exp < now) return false;
    if (typeof claims.nbf !== 'number' || claims.nbf > now + 10) return false;
    return true;
  }

  it('an untampered assertion verifies, and its audience is THIS source', async () => {
    const assertion = await capturedAssertion();
    // The expectation is the SOURCE's id, not the token's own claim (round-1
    // CONTROL finding): an assertion addressed to a different source must fail
    // here, and a check that read `aud` from the token could never say so.
    expect(verify(assertion, ASSERTED_ID)).toBe(true);
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'));
    expect(claims.aud).toBe(ASSERTED_ID);
  });

  it('a tampered signature is refused by the fixture', async () => {
    const assertion = await capturedAssertion();
    const [header, payload, signature] = assertion.split('.');
    const bytes = Buffer.from(signature, 'base64url');
    bytes[0] ^= 0xff;
    expect(verify(`${header}.${payload}.${bytes.toString('base64url')}`, ASSERTED_ID)).toBe(false);
  });

  it('alg:none is refused by the fixture', async () => {
    const assertion = await capturedAssertion();
    const [, payload, signature] = assertion.split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(verify(`${header}.${payload}.${signature}`, ASSERTED_ID)).toBe(false);
  });

  it('a wrong audience is refused by the fixture', async () => {
    const assertion = await capturedAssertion();
    expect(verify(assertion, 'https://someone-else.invalid')).toBe(false);
  });

  /**
   * Re-sign a mutated payload with the deployment's own key.
   *
   * Round-1 CONTROL finding: the temporal mutations used to keep the ORIGINAL
   * signature, so the fixture's verifier refused them at the signature step
   * and the `exp` and `nbf` branches were never reached — the drills were
   * green for the wrong reason. Re-signing makes the temporal claim the ONLY
   * thing that differs from a token that verifies.
   */
  function resign(claims: Record<string, unknown>): string {
    const key = crypto.createPrivateKey({
      key: Buffer.from(assertionKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: ASSERTION_TYP, kid: 'ka' }))
      .toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto.sign(null, Buffer.from(`${header}.${payload}`, 'utf8'), key);
    return `${header}.${payload}.${signature.toString('base64url')}`;
  }

  it('a re-signed but EXPIRED assertion is refused on its exp, not its signature', async () => {
    const assertion = await capturedAssertion();
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'));

    // The control on the control: re-signing an UNCHANGED payload verifies, so
    // a failure below is the temporal claim and not the re-signing.
    expect(verify(resign(claims), ASSERTED_ID)).toBe(true);

    const expired = resign({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 });
    expect(verify(expired, ASSERTED_ID)).toBe(false);
  });

  it('a re-signed assertion with a future nbf is refused on its nbf', async () => {
    const assertion = await capturedAssertion();
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'));
    const future = resign({ ...claims, nbf: Math.floor(Date.now() / 1000) + 600 });
    expect(verify(future, ASSERTED_ID)).toBe(false);
  });

  it('a captured assertion replayed by a party that cannot channel-authenticate is refused BEFORE it is read', async () => {
    const assertion = await capturedAssertion();
    expect(verify(assertion, ASSERTED_ID)).toBe(true);

    // The fixture now behaves as §7.2 obliges a source to behave: it
    // channel-authenticates core BEFORE reading anything.
    asserted.requests.length = 0;
    asserted.channelRefusals.length = 0;
    asserted.behaviour = { status: 200, body: resultBody(1), requireBearer: 'Bearer core-to-engine-token' };

    // THE REPLAYER: holds the captured assertion, cannot authenticate as core.
    const replayStatus = await new Promise<number>((resolve, reject) => {
      const request = https.request({
        host: fixtureHost,
        port: asserted.port,
        path: '/knowledge/query',
        method: 'POST',
        ca: asserted.certificate.cert,
        headers: { 'content-type': 'application/json' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end(JSON.stringify({ q: 'needle', limit: 8, assertion }));
    });

    expect(replayStatus).toBe(401);
    // The instrument: the fixture refused at the CHANNEL and never read a
    // body, so the assertion the replayer holds was never even parsed (§5.4 —
    // possession by a non-core party confers nothing).
    expect(asserted.channelRefusals).toHaveLength(1);
    expect(asserted.requests).toHaveLength(0);

    // The same fixture, dialed by CORE, is answered — so the refusal above is
    // the channel and not the fixture being broken.
    const core = await search();
    expect(core.coverage.answered).toEqual([ASSERTED_ID]);
    expect(asserted.requests).toHaveLength(1);
  });

  it('core refuses to emit a colliding jti — the uniqueness is the constraint', async () => {
    (pool.query as jest.Mock).mockImplementation(async (text: string, params?: unknown[]) => {
      if (text.includes('FROM services s')) return { rows: sourceRows };
      // The row already exists: ON CONFLICT DO NOTHING returned nothing.
      if (text.includes('INSERT INTO knowledge_assertion_jti')) return { rows: [] };
      if (text.includes('INSERT INTO knowledge_search_audit')) {
        searchAudit.push((params ?? []) as unknown[]);
        return { rows: [] };
      }
      return { rows: [] };
    });
    // §7.5: "a failed source never fails the whole query" — the query RETURNS.
    //
    // WHAT THE SOURCE'S OUTCOME IS changed with the owner default on Q-S3
    // (dispatcher 2026-09-05): the signer's result is established at ADMISSION,
    // before the final set is frozen, and "sources refused at signing are
    // excluded from the set and indistinguishable from never-selected (§5.5)".
    // A collision core cannot resolve therefore CONCEALS this source rather
    // than naming it `unavailable:transport`, and the fail-closed rule still
    // means nothing was dialed without a fresh assertion. Ratified acceptance
    // item 8 names connection refusal, 429, channel-auth failure and the
    // deadline; it does not name the signer, which is the seat the default
    // fills.
    const answer = await search();
    expect(answer.coverage.consulted).toEqual([]);
    expect(answer.coverage.unavailable).toEqual([]);
    expect(answer.coverage.answered).toEqual([]);
    expect(asserted.requests).toHaveLength(0);
    // Concealed everywhere, not only in coverage: no group, no audit line.
    expect(answer.groups).toEqual([]);
    expect(JSON.parse(String(searchAudit[0][5]))).toEqual([]);
  });
});

// ══════════════ item 14 — audit forensics, and §7.2 validation ════════════

describe('§7.7 / item 14 — the search row alone reconstructs what text went where', () => {
  it('carries the caller, the FULL query text, and every source with its outcome', async () => {
    sourceRows = [
      externalRow({}),
      externalRow({
        id: DEAD_ID,
        slug: 'dead',
        knowledge_query_endpoint: `https://${fixtureHost}:9/knowledge/query`,
        knowledge_core_credential_ref: 'dead/core',
      }),
    ];
    asserted.behaviour = { status: 200, body: resultBody(2) };
    const q = 'the exact text a prompt-injected caller would exfiltrate';
    const response = await search({ q });

    expect(searchAudit).toHaveLength(1);
    const [auditRef, principalId, credentialId, queryText, kinds, fanout] = searchAudit[0];
    expect(auditRef).toBe(response.auditRef);
    expect(principalId).toBe(ACCOUNT_ID);
    expect(credentialId).toBe('cred-1');
    // The FULL text, not a hash: §7.7 says a hash defends nothing here.
    expect(queryText).toBe(q);
    expect(kinds).toEqual(['code', 'docs', 'data']);

    const entries = JSON.parse(String(fanout));
    expect(entries.map((entry: { sourceId: string }) => entry.sourceId).sort())
      .toEqual([ASSERTED_ID, DEAD_ID].sort());
    const answered = entries.find((entry: { sourceId: string }) => entry.sourceId === ASSERTED_ID);
    expect(answered.outcome).toBe('answered');
    expect(answered.resultCount).toBe(2);
    // The jti ties the row to the assertion core emitted for that dial.
    expect(typeof answered.assertionJti).toBe('string');
    const unreachable = entries.find((entry: { sourceId: string }) => entry.sourceId === DEAD_ID);
    expect(unreachable.outcome).toBe('unavailable');
  });

  it('the fan-out record never carries result content — only counts and tokens', async () => {
    asserted.behaviour = { status: 200, body: resultBody(1, { snippet: 'SECRET-SNIPPET-VALUE' }) };
    await search();
    expect(String(searchAudit[0][5])).not.toContain('SECRET-SNIPPET-VALUE');
  });
});

describe('§7.2 — validation drops what it must and normalizes what it may', () => {
  const validate = (results: unknown[], limit = 8) => validateSourceResults({
    raw: { results },
    requestedKinds: ['docs'],
    declaredCompartments: ['corpus'],
    limit,
  });

  it('the mixed response: the valid result survives, the hostile one is dropped and named', () => {
    const outcome = validate([
      { ref: 'ok', title: 't', snippet: 's', contentKind: 'docs', compartment: 'corpus', score: 0.4 },
      { ref: 'bad`ref', title: 't', snippet: 's', contentKind: 'docs', compartment: 'corpus', score: 0.4 },
    ]);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.invalid).toBe(true);
    expect(outcome.truncated).toBe(false);
  });

  it('an all-dropped response is invalid but NOT truncated', () => {
    const outcome = validate([
      { ref: 'a', title: 't', contentKind: 'docs', compartment: 'undeclared', score: 1 },
      { ref: 'b', title: 't', contentKind: 'data', compartment: 'corpus', score: 1 },
    ]);
    expect(outcome.results).toEqual([]);
    expect(outcome.invalid).toBe(true);
    expect(outcome.truncated).toBe(false);
  });

  it('an over-limit response is truncated but NOT invalid', () => {
    const outcome = validate(Array.from({ length: 5 }, (_, index) => ({
      ref: `r${index}`, title: 't', snippet: 's', contentKind: 'docs', compartment: 'corpus', score: 0.2,
    })), 2);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.invalid).toBe(false);
    expect(outcome.truncated).toBe(true);
  });

  it('clamps a score and normalizes a timestamp without dropping the result', () => {
    const outcome = validate([{
      ref: 'r', title: 't', snippet: 's', contentKind: 'docs', compartment: 'corpus',
      score: 9, updatedAt: 'not a date',
    }]);
    expect(outcome.results[0].score).toBe(1);
    expect(outcome.results[0].updatedAt).toBeUndefined();
    expect(outcome.invalid).toBe(false);
  });
});

describe('§8.1 — every ref leaves core sealed, and only sealed', () => {
  it('the emitted result carries a handle that unseals to the source, version and ref', async () => {
    asserted.behaviour = {
      status: 200,
      body: JSON.stringify({
        results: [{
          ref: '/secret/path.md', parentRef: '/secret', title: 't', snippet: 's',
          contentKind: 'docs', compartment: 'corpus', score: 0.5,
        }],
      }),
    };
    const { groups } = await search();
    const [result] = groups[0].results;
    expect(JSON.stringify(result)).not.toContain('/secret/path.md');
    const payload = unsealKnowledgeHandle(result.handle);
    expect(payload.s).toBe(ASSERTED_ID);
    expect(payload.dv).toBe(1);
    expect(payload.c).toBe('corpus');
    expect(payload.r).toBe('/secret/path.md');
    expect(unsealKnowledgeHandle(result.parentHandle as string).r).toBe('/secret');
  });
});


// ═══════ items 13 and 14, the GET leg — the same seam, the other route ════

describe('§8.2 / items 13 and 14 — the get leg signs once, and audits a HASH', () => {
  const handleFor = (sourceId: string, ref: string): string => sealKnowledgeHandle({
    s: sourceId, dv: 1, c: 'corpus', r: ref,
  });

  async function get(sourceId: string, ref: string): Promise<unknown> {
    return executeKnowledgeGet(
      caller() as never,
      { handle: handleFor(sourceId, ref) },
      {
        issuer: ISSUER,
        callerGroupIds: ['group-1'],
        trustAnchors: [asserted.certificate.cert, quiet.certificate.cert],
      },
    );
  }

  const contentBody = (content: string) => JSON.stringify({
    content,
    compartment: 'corpus',
    sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
  });

  it('exactly ONE signing for an ASSERTED-mode get, at the signer seam', async () => {
    const spy = jest.spyOn(signer, 'signKnowledgeAssertion');
    asserted.behaviour = { status: 200, body: contentBody('the document') };
    const outcome = await get(ASSERTED_ID, '/docs/one.md') as { ok: boolean; content?: string };
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe('the document');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ZERO signings for a NONE-mode get, which is still dialed over an authenticated channel', async () => {
    const spy = jest.spyOn(signer, 'signKnowledgeAssertion');
    sourceRows = [externalRow({
      id: NONE_ID,
      slug: 'quiet',
      knowledge_claims_mode: 'none',
      knowledge_query_endpoint: `https://${fixtureHost}:${quiet.port}/knowledge/query`,
      knowledge_core_credential_ref: 'quiet/core',
    })];
    quiet.behaviour = { status: 200, body: contentBody('the other document') };
    const outcome = await get(NONE_ID, '/docs/two.md') as { ok: boolean };
    expect(outcome.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(quiet.requests[0].headers.authorization).toBe('Bearer core-to-quiet-token');
    expect(JSON.parse(quiet.requests[0].body).assertion).toBeUndefined();
  });

  it('the get audit row carries a CORE-computed hash and no raw ref anywhere', async () => {
    asserted.behaviour = { status: 200, body: contentBody('the document') };
    const ref = '/secret/paths/are/sensitive.md';
    await get(ASSERTED_ID, ref);

    expect(getAudit).toHaveLength(1);
    const [, , sourceId, compartment, refSha256, outcome] = getAudit[0];
    expect(sourceId).toBe(ASSERTED_ID);
    expect(compartment).toBe('corpus');
    expect(outcome).toBe('ok');
    // CORE computes it — over the DECODED raw ref, which is why the row can
    // answer "was this the same document" without holding a source path.
    expect(refSha256).toBe(crypto.createHash('sha256').update(ref, 'utf8').digest('hex'));
    expect(JSON.stringify(getAudit)).not.toContain(ref);
  });

  it('a refusal is audited too, with the same hash and no content', async () => {
    // A source that answers about a different compartment than the handle was
    // sealed with is refused — and the refusal is as auditable as a read.
    asserted.behaviour = {
      status: 200,
      body: JSON.stringify({ content: 'x', compartment: 'elsewhere', sha256: 'x' }),
    };
    const outcome = await get(ASSERTED_ID, '/docs/three.md') as { ok: boolean; refused?: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.refused).toBe('source_response_invalid');
    expect(getAudit).toHaveLength(1);
    expect(getAudit[0][5]).toBe('source_response_invalid');
  });
});

describe('§5.2 / item 2 — the staleness bound is DOCUMENTED, not drilled as prevention', () => {
  it('caps assertion TTL at 60 seconds, which is the whole of the bound core offers', () => {
    // §5.2 caps the TTL; §11.2 asks for "<=TTL source staleness asserted as a
    // DOCUMENTED bound", and the deferred register says replay at a relying
    // source is bounded by TTL + channel authentication and is NOT drilled as
    // prevented (sol R1-7, the `d77d1f53` class). This assertion is that bound
    // and claims nothing beyond it.
    expect(ASSERTION_MAX_TTL_SECONDS).toBe(60);
  });
});


// ═══ the round-1, round-2 and TERMINAL repairs, each with its own red proof ═══

describe('P1/P2 — ONE admission decides the final set, and one failure stays its own', () => {
  const PER_SOURCE_MS = 500;

  function ghosts(): string[] {
    const ids = [
      'd1111111-1111-4111-8111-111111111111',
      'd2222222-2222-4222-8222-222222222222',
      'd3333333-3333-4333-8333-333333333333',
      'd4444444-4444-4444-8444-444444444444',
    ];
    sourceRows = [
      externalRow({}),
      ...ids.map((id, index) => externalRow({ id, slug: `ghost-${index}` })),
    ];
    return ids;
  }

  /** Only the survivor's arms hold; the four others fail their ONE evaluation. */
  function onlyTheSurvivorSurvives() {
    const shippedArms = armEvaluator.evaluateKnowledgeArms;
    return jest.spyOn(armEvaluator, 'evaluateKnowledgeArms').mockImplementation(async (req, row) => (
      String(row.id) === ASSERTED_ID ? shippedArms(req, row) : null
    ));
  }

  const mutatedExecutor = (
    mutations: Array<{ find: string; replace: string }>,
    overrides: Record<string, unknown> = {},
  ) =>
    loadMutatedModule<typeof import('../services/KnowledgeFanoutExecutor')>(
      'services/KnowledgeFanoutExecutor.ts',
      mutations,
      overrides,
    );

  const runExecutor = (
    executor: typeof import('../services/KnowledgeFanoutExecutor'),
    overrides: Record<string, unknown> = {},
  ) => executor.executeKnowledgeQuery(
    caller() as never,
    {
      q: 'needle', kinds: ['code', 'docs', 'data'], limitPerSource: 8, timeoutMs: 3000, ...overrides,
    } as never,
    {
      issuer: ISSUER,
      callerGroupIds: ['group-1'],
      trustAnchors: [asserted.certificate.cert, quiet.certificate.cert],
    },
  );

  it('four concealed sources leave no trace a caller can read', async () => {
    ghosts();
    onlyTheSurvivorSurvives();
    asserted.behaviour = { status: 200, body: resultBody(1) };
    const answer = await search({ timeoutMs: PER_SOURCE_MS });

    expect(answer.coverage.consulted).toEqual([ASSERTED_ID]);
    expect(answer.coverage.skipped).toEqual([]);
    expect(answer.groups.map((group) => group.sourceId)).toEqual([ASSERTED_ID]);
    // Not in the forensic record either: the audit row carries what the caller
    // was told, and it was told nothing about them.
    expect(JSON.parse(String(searchAudit[0][5])).map((entry: { sourceId: string }) => entry.sourceId))
      .toEqual([ASSERTED_ID]);
  });

  it('MUTATION: an executor that ADMITS the absent sources fails that drill', async () => {
    ghosts();
    onlyTheSurvivorSurvives();
    asserted.behaviour = { status: 200, body: resultBody(1) };
    // ONE edit, because there is now ONE concealment coordinate: the terminal
    // repair collapsed PREPARE and the leg's re-evaluation into a single
    // admission, so a source is dropped exactly once, in exactly one place.
    // The mutant admits it instead, and the drill above goes red on every
    // surface the caller can read.
    const mutated = mutatedExecutor([{
      find: '    const arms = await evaluateKnowledgeArms(req, source.row);\n    if (!arms) return null;',
      replace: '    const arms = await evaluateKnowledgeArms(req, source.row);\n    if (!arms) return { source };',
    }]);
    const answer = await runExecutor(mutated, { timeoutMs: PER_SOURCE_MS });

    // The mutant names them, which is exactly what the drill above forbids.
    expect(answer.coverage.consulted.length).toBe(5);
    expect(JSON.parse(String(searchAudit[0][5])).length).toBe(5);
  });

  it('the WAVE COUNT comes from the final set, not from the selected set', async () => {
    // The budget itself is not caller-observable — a first-wave leg is bounded
    // by `min(timeoutMs, deadline - now)` and the deadline is never below
    // `timeoutMs`, which is why two runs differing only by concealed sources
    // look identical from outside. What IS checkable is which count the
    // executor computes with, so this drill mutates that one expression and
    // watches the count the executor hands its own deadline module.
    ghosts();
    onlyTheSurvivorSurvives();
    asserted.behaviour = { status: 200, body: resultBody(1) };

    const counts: number[] = [];
    const deadlines = await import('../services/KnowledgeDeadline');
    const shippedDeadline = deadlines.knowledgeWholeRequestDeadlineMs;
    jest.spyOn(deadlines, 'knowledgeWholeRequestDeadlineMs')
      .mockImplementation((finalCount: number, timeoutMs: number) => {
        counts.push(finalCount);
        return shippedDeadline(finalCount, timeoutMs);
      });

    // Shipped: FOUR of the five sources fail admission, so the budget is sized
    // for the one that was admitted — and it is sized AFTER admission decided.
    await search({ timeoutMs: PER_SOURCE_MS });
    expect(counts).toEqual([1]);
    // …and the arithmetic itself, at the boundary the concurrency sets.
    expect(shippedDeadline(1, PER_SOURCE_MS)).toBe(PER_SOURCE_MS);
    expect(shippedDeadline(4, PER_SOURCE_MS)).toBe(PER_SOURCE_MS);
    expect(shippedDeadline(5, PER_SOURCE_MS)).toBe(PER_SOURCE_MS * 2);
    expect(shippedDeadline(1000, 8000)).toBe(20000);

    // The mutant counts the SELECTED set — five — which is two waves and twice
    // the budget. The leg is still capped by `timeoutMs`, which is precisely
    // why this is asserted on the computed deadline rather than on an outcome.
    const mutated = mutatedExecutor([{
      find: 'clock.openLegs(admitted.length, request.timeoutMs)',
      replace: 'clock.openLegs(selected.length, request.timeoutMs)',
    }]);
    counts.length = 0;
    asserted.requests.length = 0;
    await runExecutor(mutated, { timeoutMs: PER_SOURCE_MS });
    // The mutant sizes the budget from the SELECTED set — the five that
    // include four sources the caller is never told about.
    expect(counts).toEqual([5]);
  });

  it('…and the concealed sources do not occupy a WORKER either', async () => {
    // The final set has TWO enforcement coordinates, because terminal finding
    // P2 named two effects of the same defect: a concealed source could size
    // the deadline AND hold one of the bounded pool's workers. The drill above
    // owns the first; this one owns the second, and each has its own mutant.
    ghosts();
    onlyTheSurvivorSurvives();
    asserted.behaviour = { status: 200, body: resultBody(1) };

    await search({ timeoutMs: PER_SOURCE_MS });
    // One member, one dial. The four concealed sources are not in the list the
    // pool is given, so they cannot hold a worker.
    expect(asserted.requests).toHaveLength(1);

    asserted.requests.length = 0;
    const mutated = mutatedExecutor([{
      find: '  const settledLegs = await runBounded(admitted, FANOUT_CONCURRENCY, async (entry) => ({',
      replace: '  const settledLegs = await runBounded(selected.map((source) => ({ source })), FANOUT_CONCURRENCY, async (entry) => ({',
    }]);
    const answer = await runExecutor(mutated, { timeoutMs: PER_SOURCE_MS });
    // The mutant hands the pool the SELECTED set: the concealed sources take
    // workers, are dialed, and surface in the record the caller reads.
    expect(asserted.requests.length).toBe(5);
    expect(answer.coverage.consulted.length).toBe(5);
  });

  it('a leg behind a SLOW first wave still answers — the assertion is not remade', async () => {
    // Round-2 finding: PREPARE used to sign what IT had evaluated, and an
    // evaluation older than five seconds is refused by the signer, so a fifth
    // leg behind four slow ones aborted the whole query. The terminal repair
    // removes the second evaluation entirely: the assertion this leg carries
    // was signed at admission from an evaluation made microseconds earlier, and
    // it is still inside its own TTL when the dial finally happens.
    const ids = [
      'f1111111-1111-4111-8111-111111111111',
      'f2222222-2222-4222-8222-222222222222',
      'f3333333-3333-4333-8333-333333333333',
      'f4444444-4444-4444-8444-444444444444',
    ];
    sourceRows = [
      ...ids.map((id, index) => externalRow({
        id,
        slug: `slow-${index}`,
        knowledge_query_endpoint: `https://${fixtureHost}:${quiet.port}/knowledge/query`,
        knowledge_core_credential_ref: 'quiet/core',
      })),
      externalRow({}),
    ];
    // The first wave takes longer than the arm evaluation's own five-second
    // freshness bound.
    quiet.behaviour = { status: 200, body: '{"results":[]}', delayMs: 5500 };
    asserted.behaviour = { status: 200, body: resultBody(1) };

    const answer = await search({ timeoutMs: 8000 });
    // The query RETURNED, with per-source outcomes — the point of §7.5.
    expect(answer.coverage.consulted).toHaveLength(5);
    expect(answer.coverage.answered).toContain(ASSERTED_ID);
    expect(answer.groups.find((group) => group.sourceId === ASSERTED_ID)?.results).toHaveLength(1);
  }, 60_000);

  // ── the terminal round's P2: ONE signing per ADMITTED source, and no
  //    membership question after the count is frozen ──

  it('every asserted source is evaluated ONCE, and only an admitted one is signed', async () => {
    // The owner default on Q-S3, measured at both seams: five asserted sources
    // are each evaluated exactly once, the one that survives is signed exactly
    // once, and the count is frozen only after every one of those decisions.
    ghosts();
    const evaluations = onlyTheSurvivorSurvives();
    const signings = jest.spyOn(signer, 'signKnowledgeAssertion');
    const counts: number[] = [];
    const deadlines = await import('../services/KnowledgeDeadline');
    const shippedDeadline = deadlines.knowledgeWholeRequestDeadlineMs;
    jest.spyOn(deadlines, 'knowledgeWholeRequestDeadlineMs')
      .mockImplementation((finalCount: number, timeoutMs: number) => {
        counts.push(finalCount);
        return shippedDeadline(finalCount, timeoutMs);
      });
    asserted.behaviour = { status: 200, body: resultBody(1) };

    await search({ timeoutMs: PER_SOURCE_MS });

    expect(evaluations).toHaveBeenCalledTimes(5);
    const evaluated = evaluations.mock.calls.map((call) => String((call[1] as { id: string }).id));
    expect(new Set(evaluated).size).toBe(5);
    expect(signings).toHaveBeenCalledTimes(1);
    expect(asserted.requests).toHaveLength(1);
    expect(counts).toEqual([1]);
  });

  it('MUTATION: a leg that re-evaluates AFTER the freeze fails that drill', async () => {
    ghosts();
    const evaluations = onlyTheSurvivorSurvives();
    asserted.behaviour = { status: 200, body: resultBody(1) };
    // The mutant asks the membership question a second time, in the leg, after
    // the final set and the budget are frozen — the exact state terminal
    // finding P2 named and the owner default forbids.
    const mutated = mutatedExecutor([{
      find: '  const { source, assertion } = entry;',
      replace: '  const { source } = entry;\n  const assertion = (await evaluateKnowledgeArms(req, source.row)) ? entry.assertion : undefined;',
    }]);
    await runExecutor(mutated, { timeoutMs: PER_SOURCE_MS });

    // Six evaluations for five sources: the survivor was asked twice.
    expect(evaluations).toHaveBeenCalledTimes(6);
  });

  it('the whole fan-out is bounded SHORTER than the assertion it carries', () => {
    // ROUND-5 FINDING F3. What this drill used to assert was TRUE and did not
    // cover the defect: it compared ONE phase's ceiling with the TTL, while an
    // assertion minted in phase 1 and dialed in phase 2 ages across BOTH. The
    // comparison is now against the sum, and it is derived from the three
    // shipped constants rather than restated, so a later TTL cut or ceiling
    // raise reddens HERE rather than expiring assertions at a source.
    expect(knowledgeMaxAssertionAgeMs())
      .toBe(KNOWLEDGE_ADMISSION_MAX_MS + KNOWLEDGE_WHOLE_REQUEST_MAX_MS);
    expect(knowledgeMaxAssertionAgeMs()).toBeLessThan(ASSERTION_DEFAULT_TTL_SECONDS * 1000);
    // …and the phase-1 ceiling cuts nothing the signer would have accepted:
    // an arm evaluation older than its own freshness bound is refused anyway,
    // which is why 5 000 is the slice and not a number picked to fit.
    expect(KNOWLEDGE_ADMISSION_MAX_MS)
      .toBeGreaterThanOrEqual(ARM_EVALUATION_MAX_AGE_SECONDS * 1000);
  });

  // ── round-4 finding F1: admission is bounded, and the legs keep their whole
  //    budget — the two halves of "the clock question" ──

  it('an admission that never settles is EXCLUDED, and the query still returns', async () => {
    // F1: moving the evaluation and the signing ahead of the count moved them
    // out from under the only clock the fan-out had, so a signer that never
    // settled kept the whole query pending — "starting a clock does not
    // enforce a deadline". Each source's admission now has §7.1's per-source
    // budget, and a source that misses it is excluded like any other source
    // whose authority core could not establish.
    sourceRows = [externalRow({})];
    asserted.behaviour = { status: 200, body: resultBody(1) };
    jest.spyOn(signer, 'signKnowledgeAssertion')
      .mockImplementation(() => new Promise<string>(() => { /* never settles */ }));

    const started = Date.now();
    const answer = await search({ timeoutMs: PER_SOURCE_MS });
    const elapsed = Date.now() - started;

    expect(answer.coverage.consulted).toEqual([]);
    expect(answer.groups).toEqual([]);
    expect(asserted.requests).toHaveLength(0);
    // Bounded, and bounded by the budget rather than by the test's patience.
    expect(elapsed).toBeLessThan(PER_SOURCE_MS * 8);

    // THE MUTANT waits for the admission instead of racing it, which is the
    // shipped code of the previous round: the query never settles at all.
    const mutated = mutatedExecutor([{
      find: '  const outcome = await clock.race(work, clock.admissionBudgetMs(timeoutMs));',
      replace: "  const outcome = await work.then((value) => ({ kind: 'settled' as const, value }));",
    }]);
    const hung = await Promise.race([
      runExecutor(mutated, { timeoutMs: PER_SOURCE_MS }).then(() => 'returned'),
      new Promise<string>((resolve) => { setTimeout(() => resolve('still-pending'), PER_SOURCE_MS * 4); }),
    ]);
    expect(hung).toBe('still-pending');
  }, 60_000);

  it('a SLOW concealed source does not spend an admitted source\'s budget', async () => {
    // The other half, and the reason the legs' clock starts where it does.
    // Round-1 finding P1 is not only about which number reaches §7.1's
    // formula: its reason is that "a source nobody was told about changed how
    // much time the others had — and a slow survivor came back `answered` in
    // one run and `timedOut` in the byte-identical run without them". A budget
    // measured from the start of the fan-out spends itself on ADMISSION, so a
    // concealed candidate that is slow to evaluate would buy that difference
    // back by another route.
    // Eight of them, so that at a concurrency of four they take three waves —
    // more wall-clock than the whole request's own budget.
    const slowIds = Array.from({ length: 8 }, (_, index) => `e0000000-0000-4000-8000-00000000000${index}`);
    sourceRows = [
      externalRow({}),
      ...slowIds.map((id, index) => externalRow({ id, slug: `slow-ghost-${index}` })),
    ];
    const shippedArms = armEvaluator.evaluateKnowledgeArms;
    jest.spyOn(armEvaluator, 'evaluateKnowledgeArms').mockImplementation(async (req, row) => {
      if (String(row.id) === ASSERTED_ID) return shippedArms(req, row);
      // Concealed, and slow about it: each takes a large part of the request's
      // budget to say nothing, and each is well inside its own admission
      // budget while doing so.
      await new Promise((resolve) => { setTimeout(resolve, PER_SOURCE_MS * 0.6); });
      return null;
    });
    asserted.behaviour = { status: 200, body: resultBody(1) };

    const answer = await search({ timeoutMs: PER_SOURCE_MS });
    // Identical to the run without them: the survivor answered.
    expect(answer.coverage.consulted).toEqual([ASSERTED_ID]);
    expect(answer.coverage.answered).toEqual([ASSERTED_ID]);
    expect(asserted.requests).toHaveLength(1);

    // THE MUTANT starts the legs' clock at the beginning of the fan-out, so
    // the concealed four spend the survivor's budget before it dials.
    asserted.requests.length = 0;
    // The clock owns the origin now, so the mutant is a mutated CLOCK handed
    // to an UNMODIFIED executor — which is a stronger drill than the one it
    // replaces: it shows the property is enforced by the object the ruling
    // gave it to, not by an expression that happened to sit in the executor.
    const originMutant = loadMutatedModule('services/KnowledgeRequestClock.ts', [{
      find: '    this.legsDeadlineAt = Date.now() + knowledgeWholeRequestDeadlineMs(finalCount, timeoutMs);',
      replace: '    this.legsDeadlineAt = this.startedAt + knowledgeWholeRequestDeadlineMs(finalCount, timeoutMs);',
    }]);
    const mutated = mutatedExecutor([], { './KnowledgeRequestClock': originMutant });
    const squeezed = await runExecutor(mutated, { timeoutMs: PER_SOURCE_MS });
    expect(squeezed.coverage.timedOut).toEqual([ASSERTED_ID]);
    expect(asserted.requests).toHaveLength(0);
  }, 60_000);

  it('the admission budget is a function of the REQUEST and the clock, never of a count', () => {
    // Derived from the shipped constants, and asserted at both ends: a budget
    // computed from how many candidates there are would put the number of
    // concealed sources back into an admitted source's outcome.
    expect(knowledgeAdmissionBudgetMs(0, 500)).toBe(500);
    // …and never more than what is left of PHASE 1's ceiling, which is now
    // SMALLER than the largest `timeoutMs` a caller may ask for. §7.1 gives
    // `timeoutMs` as the PER-SOURCE LEG budget, and it still is one on the
    // wire; the phase before the wire is the 5 000 ms slice the assertion
    // arithmetic needs, so an 8 000 ms request is clipped HERE and nowhere the
    // caller can see.
    expect(knowledgeAdmissionBudgetMs(0, 8000)).toBe(KNOWLEDGE_ADMISSION_MAX_MS);
    expect(knowledgeAdmissionBudgetMs(KNOWLEDGE_ADMISSION_MAX_MS - 10, 8000)).toBe(10);
    // Past the absolute ceiling the budget floors rather than going negative,
    // so a later source is excluded rather than waited on forever.
    expect(knowledgeAdmissionBudgetMs(KNOWLEDGE_ADMISSION_MAX_MS + 1000, 8000)).toBe(1);
    // ROUND-5 FINDING F3: phase 1's ceiling used to BE phase 2's, which is what
    // put the sum of the two outside the assertion TTL. It is now the smaller
    // slice, and the drill above compares the SUM with the signer's constant.
    expect(KNOWLEDGE_ADMISSION_MAX_MS).toBeLessThan(KNOWLEDGE_WHOLE_REQUEST_MAX_MS);
    // …and the floor is NOT what bounds the phase. A floored budget still costs
    // a scheduler turn per item; the queue-level stop is drilled below.
  });

  // ── the terminal round's P1: no single source's failure fails the query ──

  it('one source whose ARM EVALUATION throws is concealed, and the query answers', async () => {
    const ids = ghosts();
    const shippedArms = armEvaluator.evaluateKnowledgeArms;
    jest.spyOn(armEvaluator, 'evaluateKnowledgeArms').mockImplementation(async (req, row) => {
      if (String(row.id) === ids[0]) throw new Error('the arm evaluator could not answer');
      return shippedArms(req, row);
    });
    asserted.behaviour = { status: 200, body: resultBody(1) };

    const answer = await search();

    // §7.5: the query RETURNED, and its four healthy peers answered.
    expect(answer.coverage.answered.slice().sort())
      .toEqual([ASSERTED_ID, ids[1], ids[2], ids[3]].sort());
    expect(asserted.requests).toHaveLength(4);
    // Core could not establish that source's authority, so §5.5 gives it
    // silence rather than a bucket: no coverage, no group, no audit line.
    expect(JSON.stringify(answer.coverage)).not.toContain(ids[0]);
    expect(JSON.stringify(answer.groups)).not.toContain(ids[0]);
    expect(String(searchAudit[0][5])).not.toContain(ids[0]);
  });

  it('one source whose LEG throws is NAMED unavailable, and the query answers', async () => {
    // The other half of the same rule. This source WAS admitted — the caller
    // has already been told it exists — so an unexpected failure inside its leg
    // is item 8's named bucket, not concealment. The two dispositions differ
    // because the two moments differ, which is the whole content of §5.5.
    sourceRows = [
      externalRow({}),
      externalRow({
        id: NONE_ID,
        slug: 'quiet',
        knowledge_query_endpoint: `https://${fixtureHost}:${quiet.port}/knowledge/query`,
        knowledge_core_credential_ref: 'quiet/core',
      }),
    ];
    asserted.behaviour = { status: 200, body: resultBody(1) };
    const shippedDial = dialClient.dialKnowledgeSource;
    jest.spyOn(dialClient, 'dialKnowledgeSource').mockImplementation(async (input) => {
      if (String(input.url).includes(`:${quiet.port}/`)) throw new Error('the dial client threw');
      return shippedDial(input);
    });

    const answer = await search();

    expect(answer.coverage.answered).toEqual([ASSERTED_ID]);
    expect(answer.coverage.unavailable).toEqual([{ id: NONE_ID, reason: 'transport' }]);
    expect(answer.coverage.consulted.slice().sort()).toEqual([ASSERTED_ID, NONE_ID].sort());
  });

  it('MUTATION: a bounded pool that PROPAGATES one rejection fails both drills', async () => {
    // Terminal finding P1: `runBounded` handed `work`'s promise straight to
    // `Promise.all`, so one source's rejection ended the whole query. The
    // mutant restores exactly that, at both callers — admission and the legs.
    const mutated = mutatedExecutor([{
      find: '      try {\n        results[index] = { ok: true, value: await work(items[index]) };\n      } catch (error) {\n        results[index] = { ok: false, error };\n      }',
      replace: '      results[index] = { ok: true, value: await work(items[index]) };',
    }]);

    // (a) the ADMISSION caller
    const ids = ghosts();
    const shippedArms = armEvaluator.evaluateKnowledgeArms;
    jest.spyOn(armEvaluator, 'evaluateKnowledgeArms').mockImplementation(async (req, row) => {
      if (String(row.id) === ids[0]) throw new Error('the arm evaluator could not answer');
      return shippedArms(req, row);
    });
    asserted.behaviour = { status: 200, body: resultBody(1) };
    await expect(runExecutor(mutated)).rejects.toThrow('the arm evaluator could not answer');

    // (b) the LEG caller. One source, whose arms the spy above still evaluates
    // for real, and whose dial throws.
    sourceRows = [externalRow({})];
    jest.spyOn(dialClient, 'dialKnowledgeSource').mockImplementation(async () => {
      throw new Error('the dial client threw');
    });
    await expect(runExecutor(mutated)).rejects.toThrow('the dial client threw');

    // …and the SHIPPED module answers where the mutant rejected.
    const answer = await search();
    expect(answer.coverage.unavailable).toEqual([{ id: ASSERTED_ID, reason: 'transport' }]);
  });
});


// ══════ round 5 — ONE clock owns the request, and nothing escapes it ══════

/**
 * The dispatcher's ruling on STOP report `0ee4c4a5` (option (a)): the five
 * rounds of this candidate were one finding — the fan-out's clock had no owner
 * — so the repair is an OWNER rather than a fifth patch. `KnowledgeRequestClock`
 * holds the request's deadline, every blocking await goes through it, phase 1
 * stops dequeuing at its ceiling, and the two ceilings are chosen so their sum
 * fits inside the assertion TTL.
 *
 * Each of round 5's three PRODUCTION findings is reproduced here as a red
 * mutation, and the reviewer's own board-leg hang probe is committed as the
 * control it should always have been.
 */
describe('round-5 — one KnowledgeRequestClock owns the request', () => {
  const PER_SOURCE_MS = 500;

  /**
   * Every AWAIT-SHAPED CONSTRUCT in a TypeScript source, named.
   *
   * A plain call is named by its callee, so the frozen set reads as the list
   * of things this file waits on. Anything else — a bare promise, an
   * expression, a `for await`, an `await using`, a `yield*` — is named LOUDLY,
   * because those are the forms that would otherwise escape silently.
   *
   * ── WHAT THIS CENSUS DOES NOT SEE, STATED RATHER THAN CLAIMED AWAY ──
   *
   * Round-1 finding C1 was that the first version of this census used a
   * regular expression and could not see `await foreignPromise` or
   * `await (foreignCall())`. Round 2 accepted the AST repair and found the
   * BOUNDARY of the whole approach: PROMISE ADOPTION. An async function that
   * RETURNS a foreign promise or a `.then()` chain blocks its caller with no
   * `await` anywhere — so `runLeg` could adopt a never-settling promise and
   * this census would be byte-identical.
   *
   * That is a real limit of any await census and it is NOT covered by making
   * the census cleverer. What covers it is TERMINATION measured at the
   * behaviour: the board-hang drill, the ledger-hang drill, the candidate-load
   * drill and the 4 000-admission drill all assert that the REQUEST ENDS, and
   * they go red for an adopted promise exactly as they do for an unraced
   * await. The drill below this one proves that pair: it builds an adoption
   * mutant, shows the census cannot see it, and then shows the termination
   * drill that can.
   *
   * So this census is a BACKSTOP against a new await being added without a
   * phase, and it is not, and does not claim to be, a proof that every
   * blocking construct is bounded.
   */
  const censusOf = (source: string): string[] => {
    const file = ts.createSourceFile('census.ts', source, ts.ScriptTarget.ES2022, true);
    const names: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isAwaitExpression(node)) {
        let inner: ts.Expression = node.expression;
        while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
        names.push(ts.isCallExpression(inner)
          ? inner.expression.getText(file)
          : `AWAIT NOT A CALL: ${inner.getText(file).replace(/\s+/g, ' ').slice(0, 48)}`);
      }
      if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) names.push('FOR-AWAIT');
      // `await using` is an await-using VARIABLE DECLARATION, not an
      // `AwaitExpression` — round-2 finding C1 — and a never-settling async
      // disposer blocks the scope's exit just as an unraced await would.
      if (ts.isVariableStatement(node)
        && (node.declarationList.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing) {
        names.push('AWAIT-USING');
      }
      // `yield*` delegates to another async iterable, which is an await the
      // delegating function never spells.
      if (ts.isYieldExpression(node) && node.asteriskToken !== undefined) names.push('YIELD-STAR');
      ts.forEachChild(node, visit);
    };
    visit(file);
    return names.sort();
  };

  const mutatedExecutor = (
    mutations: Array<{ find: string; replace: string }>,
    overrides: Record<string, unknown> = {},
  ) =>
    loadMutatedModule<typeof import('../services/KnowledgeFanoutExecutor')>(
      'services/KnowledgeFanoutExecutor.ts',
      mutations,
      overrides,
    );

  const runExecutor = (
    executor: typeof import('../services/KnowledgeFanoutExecutor'),
    overrides: Record<string, unknown> = {},
  ) => executor.executeKnowledgeQuery(
    caller() as never,
    {
      q: 'needle', kinds: ['code', 'docs', 'data'], limitPerSource: 8, timeoutMs: 3000, ...overrides,
    } as never,
    {
      issuer: ISSUER,
      callerGroupIds: ['group-1'],
      trustAnchors: [asserted.certificate.cert, quiet.certificate.cert],
    },
  );

  /** The reserved in-query pseudo-source (§9), as the signing drills build it. */
  const boardRow = () => ({
    ...externalRow({}),
    id: BOARD_ID,
    slug: KNOWLEDGE_BOARD_SOURCE_SLUG,
    knowledge_query_endpoint: null,
    knowledge_core_credential_ref: null,
    descriptor: knowledgeBlock(['docs'], ['reports', 'tasks', 'skills']),
  });

  /** Replace ONE query's answer and leave every other one the suite's own. */
  function interceptQuery(match: string, answer: (params?: unknown[]) => Promise<unknown>) {
    const shipped = (pool.query as jest.Mock).getMockImplementation() as
      (text: string, params?: unknown[]) => Promise<unknown>;
    (pool.query as jest.Mock).mockImplementation((text: string, params?: unknown[]) => (
      String(text).includes(match) ? answer(params) : shipped(text, params)
    ));
  }

  // ── F2 — the board leg. PRE-EXISTING since `15be96a`, and missed by three
  //    earlier rounds: the leg deadline was checked only BEFORE a leg started,
  //    and the board branch then awaited PostgreSQL with no deadline at all. ──

  it('F2: a board leg that never settles is timedOut, and the query still returns', async () => {
    sourceRows = [boardRow()];
    jest.spyOn(boardAdapter, 'searchBoard')
      .mockImplementation(() => new Promise(() => { /* never settles */ }));

    const started = Date.now();
    const answer = await search({ timeoutMs: PER_SOURCE_MS });
    const elapsed = Date.now() - started;

    // In the final set, so it gets a BUCKET — §7.1's own answer for a source
    // unfinished at the deadline — and not the silence §5.5 gives a concealed
    // candidate.
    expect(answer.coverage.consulted).toEqual([BOARD_ID]);
    expect(answer.coverage.timedOut).toEqual([BOARD_ID]);
    expect(answer.groups).toEqual([]);
    expect(elapsed).toBeLessThan(PER_SOURCE_MS * 8);
    // The forensic record was WRITTEN. The reviewer's probe of the shipped
    // predecessor found the query still pending with no audit row at all.
    expect(searchAudit).toHaveLength(1);
    expect(JSON.parse(String(searchAudit[0][5])))
      .toEqual([{ sourceId: BOARD_ID, sourceSlug: KNOWLEDGE_BOARD_SOURCE_SLUG, outcome: 'timedOut' }]);
  }, 60_000);

  it('MUTATION: a board branch that awaits searchBoard directly hangs the whole request', async () => {
    sourceRows = [boardRow()];
    jest.spyOn(boardAdapter, 'searchBoard')
      .mockImplementation(() => new Promise(() => { /* never settles */ }));

    // The shipped code of every candidate-C SHA before this one.
    const mutated = mutatedExecutor([{
      find: `    const raced = await clock.race(searchBoard(req, {
      q: request.q,
      kinds: request.kinds,
      limit: request.limitPerSource,
    }), remaining);`,
      replace: `    const raced = { kind: 'settled' as const, value: await searchBoard(req, {
      q: request.q,
      kinds: request.kinds,
      limit: request.limitPerSource,
    }) };`,
    }]);
    const hung = await Promise.race([
      runExecutor(mutated, { timeoutMs: PER_SOURCE_MS }).then(() => 'returned'),
      new Promise<string>((resolve) => { setTimeout(() => resolve('still-pending'), PER_SOURCE_MS * 6); }),
    ]);
    expect(hung).toBe('still-pending');
  }, 60_000);

  // ── F1 — the admission phase's bound is CARDINALITY-INDEPENDENT ──

  /** Four thousand candidates whose admission never settles. */
  function fourThousandHungCandidates() {
    sourceRows = Array.from({ length: 4000 }, (_, index) => externalRow({
      id: `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      slug: `bulk-${String(index).padStart(4, '0')}`,
    }));
    return jest.spyOn(armEvaluator, 'evaluateKnowledgeArms')
      .mockImplementation(() => new Promise(() => { /* never settles */ }));
  }

  it('F1: 4 000 hung admissions finish under the ceiling, and the phase stops DEQUEUING', async () => {
    const evaluations = fourThousandHungCandidates();

    const started = Date.now();
    const answer = await search({ timeoutMs: PER_SOURCE_MS });
    const elapsed = Date.now() - started;

    // The reviewer's probe of the predecessor returned in 21 493 ms against a
    // 20 000 ms ceiling, because past the ceiling every remaining candidate was
    // still launched with a 1 ms timer.
    expect(elapsed).toBeLessThanOrEqual(KNOWLEDGE_ADMISSION_MAX_MS + 1500);
    expect(answer.coverage.consulted).toEqual([]);

    // THE MECHANISM, not just the wall clock: the phase can only ever REACH
    // this many candidates, whatever the list's length — four workers, each
    // cycling once per source budget, for the length of the ceiling.
    const reachable = KNOWLEDGE_FANOUT_CONCURRENCY
      * (Math.ceil(KNOWLEDGE_ADMISSION_MAX_MS / PER_SOURCE_MS) + 1);
    expect(evaluations.mock.calls.length).toBeLessThanOrEqual(reachable);
    expect(evaluations.mock.calls.length).toBeLessThan(sourceRows.length);
  }, 90_000);

  it('MUTATION: without the queue-level stop the phase reaches every candidate', async () => {
    const evaluations = fourThousandHungCandidates();
    const total = sourceRows.length;

    // The shipped code of round 4: the per-item budget floors at 1 ms instead
    // of the queue stopping, which is a bound on one SOURCE and not on the
    // PHASE.
    const mutated = mutatedExecutor([{
      find: '    () => !clock.admissionOpen(),\n',
      replace: '',
    }]);
    const started = Date.now();
    await runExecutor(mutated, { timeoutMs: PER_SOURCE_MS });
    const elapsed = Date.now() - started;

    expect(evaluations.mock.calls.length).toBe(total);
    expect(elapsed).toBeGreaterThan(KNOWLEDGE_ADMISSION_MAX_MS);
  }, 120_000);

  // ── F3 — the two ceilings and the assertion they have to fit inside ──

  it('F3: MUTATION — widening phase 1 back to phase 2 reddens the TTL inequality', () => {
    const widened = loadMutatedModule<typeof import('../services/KnowledgeDeadline')>(
      'services/KnowledgeDeadline.ts',
      [{
        find: 'export const KNOWLEDGE_ADMISSION_MAX_MS = 5000;',
        replace: 'export const KNOWLEDGE_ADMISSION_MAX_MS = 20000;',
      }],
    );
    // Exactly the state round 5 measured: 20 000 + 20 000 against a 30 s TTL,
    // which dialed an assertion aged 37 950 ms. The drill above asserts the
    // shipped sum is UNDER the TTL; this one shows that assertion is not
    // vacuous, by producing the constants for which it fails.
    expect(widened.knowledgeMaxAssertionAgeMs())
      .toBeGreaterThanOrEqual(ASSERTION_DEFAULT_TTL_SECONDS * 1000);
    expect(knowledgeMaxAssertionAgeMs()).toBeLessThan(ASSERTION_DEFAULT_TTL_SECONDS * 1000);
  });

  // ── THE SEAM ITSELF: nothing awaits foreign code except through the clock ──

  it('every await-shaped construct in the fan-out is one of the frozen set', () => {
    // A COMPLETE comparison rather than a filtered census: the whole set of
    // awaited expressions in the shipped file is compared with a frozen list,
    // so there is no rule for a new await to fall outside of. Adding one — a
    // new database call, a new adapter, a leg that stops going through the
    // clock — reddens this drill and forces the author to say which phase
    // bounds it.
    //
    // ROUND-1 FINDING C1, AND THE REASON THIS WALKS AN AST. The first version
    // of this census matched `await <callee>(` with a regular expression, and
    // the reviewer showed it returned an EMPTY census for `await
    // foreignPromise` and for `await (foreignCall())` — so the control that
    // exists to say "nothing escapes the clock" could itself be escaped by two
    // ordinary spellings. `censusOf` now walks every `AwaitExpression` node the
    // TypeScript compiler finds, unwraps parentheses, and names any await that
    // is not a plain call so it cannot be silent. `for await` is named too.
    // The drill below this one is this control's own control: it feeds the
    // census the three forms the regex missed and watches each one appear.
    expect(censusOf(readShippedSource('services/KnowledgeFanoutExecutor.ts'))).toEqual([
      // joins the bounded pool's WORKERS; a worker's body cannot reject
      'Promise.all',
      // the three selection queries: core's own questions about its own estate
      'clock.mustSettle', 'clock.mustSettle', 'clock.mustSettle',
      // admission, the board leg, the dial, the §7.7 ledger write
      'clock.race', 'clock.race', 'clock.race', 'clock.race',
      // the two halves of ONE admission chain — the chain itself is the
      // promise `clock.race` above races, so neither can outlive phase 1
      'evaluateKnowledgeArms',
      // inside `loadCandidateRows`, whose promise `clock.mustSettle` races
      'pool.query',
      // the bounded pool, twice: admission and the legs
      'runBounded', 'runBounded',
      // one admitted source's leg, which races everything it touches
      'runLeg',
      'signKnowledgeAssertion',
      // the pool calling its own item; the failure is contained at the item
      'work',
    ].sort());

    // And the seam's own module: one race, and one caller of it.
    expect(censusOf(readShippedSource('services/KnowledgeRequestClock.ts')))
      .toEqual(['Promise.race', 'this.race'].sort());
  });

  it('MUTATION: the census names the four await forms an AwaitExpression regex missed', () => {
    // The control's own control. Round 1's CONTROL finding was that a census
    // built from `/await\s+ident\(/` returns nothing for a bare promise or a
    // parenthesised call; round 2's was that an `AwaitExpression` walk alone
    // returns nothing for `await using`. So an unraced await could be added in
    // four ordinary spellings while the census stayed green. Each mutation
    // below is the shipped executor with ONE await rewritten into one of those
    // forms, and each must SHOW UP.
    const shipped = readShippedSource('services/KnowledgeFanoutExecutor.ts');
    const theRacedAdmission = '  const outcome = await clock.race(work, clock.admissionBudgetMs(timeoutMs));';

    // (a) a bare promise — the form the regex could not see at all
    const bare = censusOf(applyMutations(shipped, [{
      find: theRacedAdmission, replace: '  const outcome = await work;',
    }]));
    expect(bare).toContain('AWAIT NOT A CALL: work');
    // …and the race it replaced is gone: four in the shipped file, three here.
    expect(bare.filter((name) => name === 'clock.race')).toHaveLength(3);

    // (b) a parenthesised call — a call the regex also could not see
    const parenthesised = censusOf(applyMutations(shipped, [{
      find: theRacedAdmission,
      replace: '  const outcome = await (signKnowledgeAssertion(work as never));',
    }]));
    expect(parenthesised.filter((name) => name === 'signKnowledgeAssertion')).toHaveLength(2);

    // (c) `for await` — an await with no AwaitExpression callee at all
    const streamed = censusOf(applyMutations(shipped, [{
      find: theRacedAdmission,
      replace: '  for await (const outcome of work as never) { void outcome; }',
    }]));
    expect(streamed).toContain('FOR-AWAIT');

    // (d) `await using` — round-2 finding C1: TypeScript models this as an
    // await-using VARIABLE DECLARATION, so an `AwaitExpression` walk alone
    // returned the frozen 15 for it and a never-settling async disposer stayed
    // pending.
    const disposed = censusOf(applyMutations(shipped, [{
      find: theRacedAdmission,
      replace: '  await using outcome = work as never;',
    }]));
    expect(disposed).toContain('AWAIT-USING');

    // …and each of the four differs from the shipped set, which is the whole
    // point: the drill above would have gone red for any of them.
    const frozen = censusOf(shipped);
    for (const mutant of [bare, parenthesised, streamed, disposed]) {
      expect(mutant).not.toEqual(frozen);
    }
  });

  it('PROMISE ADOPTION is invisible to the census, and the TERMINATION drill catches it (round-2 C1)', async () => {
    // The census's boundary, drilled from both sides rather than argued.
    //
    // An async function that RETURNS a foreign promise blocks its caller with
    // no `await` anywhere. This mutant ADDS such a return to `runLeg` and
    // REMOVES nothing, so the shipped file's frozen set is untouched — and the
    // request hangs. A census cannot be made to see this; a drill that
    // measures whether the REQUEST ENDS sees it immediately.
    const shipped = readShippedSource('services/KnowledgeFanoutExecutor.ts');
    const adoptionAnchor = `  const { source, assertion } = entry;
  const remaining = clock.legsRemainingMs();`;
    const adoptionMutation = [{
      find: adoptionAnchor,
      replace: `  const { source, assertion } = entry;
  if (isBoardSource(source.row.slug)) {
    return searchBoard(req, { q: request.q, kinds: request.kinds, limit: request.limitPerSource })
      .then(() => ({ kind: 'timedOut' as const }));
  }
  const remaining = clock.legsRemainingMs();`,
    }];

    // ONE: the census is byte-identical. This assertion is the finding, kept.
    expect(censusOf(applyMutations(shipped, adoptionMutation))).toEqual(censusOf(shipped));

    // TWO: the termination drill is not.
    sourceRows = [boardRow()];
    jest.spyOn(boardAdapter, 'searchBoard')
      .mockImplementation(() => new Promise(() => { /* never settles */ }));
    const mutated = mutatedExecutor(adoptionMutation);
    const hung = await Promise.race([
      runExecutor(mutated, { timeoutMs: PER_SOURCE_MS }).then(() => 'returned'),
      new Promise<string>((resolve) => { setTimeout(() => resolve('still-pending'), PER_SOURCE_MS * 6); }),
    ]);
    expect(hung).toBe('still-pending');
  }, 60_000);

  // ── the awaits the previous rounds never reached at all ──

  it('a §7.7 ledger write that never settles does not hold the response', async () => {
    asserted.behaviour = { status: 200, body: resultBody(1) };
    interceptQuery('INSERT INTO knowledge_search_audit', () => new Promise(() => { /* hangs */ }));

    const started = Date.now();
    const answer = await search({ timeoutMs: PER_SOURCE_MS });
    const elapsed = Date.now() - started;

    // Treated exactly like the write that FAILS, which this feature already
    // logs rather than raising: the caller keeps its answer and the `auditRef`
    // core minted for the query, and the operator has the logged error id.
    expect(elapsed).toBeLessThan(KNOWLEDGE_LEDGER_MAX_MS + PER_SOURCE_MS * 8);
    expect(answer.coverage.answered).toEqual([ASSERTED_ID]);
    expect(answer.auditRef).toMatch(/^ka_[0-9a-f]{32}$/);
  }, 60_000);

  it('a candidate load that never settles ENDS the request instead of hanging it', async () => {
    interceptQuery('FROM services s', () => new Promise(() => { /* hangs */ }));

    const started = Date.now();
    // Not a source's failure — core could not decide who may be asked — so it
    // is not dressed up as one of item 8's per-source buckets.
    await expect(search({ timeoutMs: PER_SOURCE_MS })).rejects.toMatchObject({
      name: 'KnowledgeRequestTimeoutError',
      phase: 'candidate load',
    });
    expect(Date.now() - started).toBeLessThanOrEqual(KNOWLEDGE_ADMISSION_MAX_MS + 1500);
  }, 60_000);

  it('the candidate query is CAPPED, and the board is ordered ahead of the cap', async () => {
    let loadText = '';
    let loadParams: unknown[] = [];
    const shipped = (pool.query as jest.Mock).getMockImplementation() as
      (text: string, params?: unknown[]) => Promise<unknown>;
    (pool.query as jest.Mock).mockImplementation((text: string, params?: unknown[]) => {
      if (String(text).includes('FROM services s')) {
        loadText = String(text);
        loadParams = (params ?? []) as unknown[];
      }
      return shipped(text, params);
    });

    await search();

    // Defence in depth and NOT the phase's bound — the queue stop above is —
    // but the cap must be real and the board must survive it.
    expect(loadText).toContain('LIMIT $2');
    expect(loadParams[1]).toBe(KNOWLEDGE_CANDIDATE_ROWS_MAX);
    expect(loadText).toContain('ORDER BY (s.slug <> $1), s.slug');
    expect(loadParams[0]).toBe(KNOWLEDGE_BOARD_SOURCE_SLUG);
    // …and §7.4's slug order is restored outside the capped subquery, so
    // nothing downstream sees a different sequence than before.
    expect(loadText.trimEnd().endsWith('ORDER BY c.slug')).toBe(true);
  });
});

describe('round-1 P2 — an explicitly empty sources list narrows to NOTHING', () => {
  it('consults nobody and dials nobody', async () => {
    sourceRows = [externalRow({})];
    asserted.behaviour = { status: 200, body: resultBody(1) };
    const answer = await search({ sources: [] });
    expect(answer.coverage.consulted).toEqual([]);
    expect(answer.groups).toEqual([]);
    expect(asserted.requests).toHaveLength(0);
  });

  it('…while an OMITTED list still fans out, so the two are not the same thing', async () => {
    sourceRows = [externalRow({})];
    asserted.behaviour = { status: 200, body: resultBody(1) };
    const answer = await search();
    expect(answer.coverage.consulted).toEqual([ASSERTED_ID]);
    expect(asserted.requests).toHaveLength(1);
  });
});

describe('round-1 P4 — the byte budget belongs to the RESPONSE, not to each source', () => {
  it('caps the merged response and names every source whose results were cut', async () => {
    // Eleven sources, each answering with results well inside its own former
    // per-source budget. Before the repair the merged response was ~300 KB
    // against a 262,144-byte declared budget.
    const ids = Array.from({ length: 11 }, (_, index) =>
      `e${index}111111-1111-4111-8111-11111111111${index.toString(16)}`);
    sourceRows = ids.map((id, index) => externalRow({ id, slug: `bulk-${index}` }));
    const filler = 'x'.repeat(4000);
    asserted.behaviour = {
      status: 200,
      body: JSON.stringify({
        results: Array.from({ length: 25 }, (_, index) => ({
          ref: `bulk-${index}`,
          title: filler,
          snippet: filler,
          contentKind: 'docs',
          compartment: 'corpus',
          score: 0.5,
        })),
      }),
    };
    const answer = await search({ limitPerSource: 25 });

    const emitted = Buffer.byteLength(JSON.stringify(answer.groups), 'utf8');
    expect(emitted).toBeLessThanOrEqual(KNOWLEDGE_RESPONSE_MAX_BYTES);
    // The honesty half: the sources whose results were cut are NAMED, and
    // every one of them answered.
    expect(answer.coverage.truncatedResults.length).toBeGreaterThan(0);
    for (const id of answer.coverage.truncatedResults) {
      expect(answer.coverage.answered).toContain(id);
    }
    // The coverage record itself is not charged against the budget — §7.3
    // makes it the thing that must survive.
    expect(answer.coverage.consulted).toHaveLength(11);
  });
});
