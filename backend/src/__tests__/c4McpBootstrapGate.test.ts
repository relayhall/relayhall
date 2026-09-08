/**
 * RH-P3.C4 subtask [1] — the fail-closed bootstrap gate, MEASURED.
 *
 * Contract: strategy `4e40f06f` §2.10 ratified item C2 — "work-plane tool calls
 * from a session that has not bootstrapped return 'bootstrap first' with the
 * index inline — one middleware check that kills the silent-skip hole" — and
 * owner decision D2 (run packet `3e6ec75a` §5[1]): the record is keyed on the
 * CREDENTIAL with a TTL, and the positive control is mandatory: "prove the
 * refusal, not the pass."
 *
 * ── Why this drives every tool rather than a few ──
 *
 * "Work-plane tools refuse" is a UNIVERSAL claim over the registry, and the
 * `dae6b980` rounds settled what a universal claim costs when it is sampled:
 * a control that checks three tools proves three tools. So the sweep below
 * drives EVERY tool in the live `MCP_TOOLS`, over the wire, through the real
 * transport, the real dispatcher and the real in-process routing — and asserts
 * the partition both ways: every `work` tool refuses, every exempt tool does
 * not, and neither side is empty. A tool added later with the wrong plane
 * fails here without anyone remembering to add it to a list.
 *
 * The one-site claim in `mcp/bootstrapGate`'s docblock is checked too, but as
 * a source census — the review-time backstop, not the proof. The proof is the
 * behavioural sweep, because a census cannot see a call site assembled at
 * runtime and this codebase has already been bitten by believing one that
 * could not.
 *
 * ── What is faked, and what that costs ──
 *
 * The database. `mcp_bootstrap_records` is implemented in-memory below, and it
 * REFUSES any SQL against that table it does not recognise, so a change to the
 * production SQL's shape turns this suite red instead of quietly bypassing it.
 * Nothing else is faked: the credential path, the transport pin, the registry,
 * the gate, the Brief route and the record write are the shipped code. The real
 * PostgreSQL semantics — the upsert and the server-clock expiry — are proven
 * separately by the live DEV drill, which is the only place they can be.
 */
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import ts from 'typescript';
import { AddressInfo } from 'net';

// ── the bootstrap record store, implemented rather than stubbed ─────────────
interface FakeRow { credential_id: string; bootstrapped_at: string; expires_at: string }
const store = new Map<string, FakeRow>();
const seenSql: string[] = [];
/** Set to make the NEXT liveness lookup throw, the way a wedged database
 * would. Without it the gate's "we do not know" arm is unreachable, and an
 * unreachable arm is one a mutation can invert without any test noticing —
 * which is exactly what the mutation drill caught. */
let failNextLiveness = false;

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

function bootstrapRecordQuery(sql: string, params: unknown[]): { rows: FakeRow[]; rowCount: number } {
  const text = normalize(sql);
  if (text.startsWith('INSERT INTO mcp_bootstrap_records')) {
    // The production statement must still be the upsert this fake models.
    if (!text.includes('ON CONFLICT (credential_id) DO UPDATE')) {
      throw new Error(`bootstrap INSERT is no longer an upsert — this fake models one: ${text}`);
    }
    const row: FakeRow = {
      credential_id: String(params[0]),
      bootstrapped_at: String(params[1]),
      expires_at: String(params[2]),
    };
    store.set(row.credential_id, row);
    return { rows: [row], rowCount: 1 };
  }
  if (text.startsWith('SELECT 1 FROM mcp_bootstrap_records')) {
    if (failNextLiveness) {
      failNextLiveness = false;
      throw new Error('connection terminated unexpectedly');
    }
    // Expiry must still be decided in SQL against the database clock.
    if (!text.includes('expires_at > now()')) {
      throw new Error(`bootstrap liveness no longer filters on expires_at > now(): ${text}`);
    }
    const row = store.get(String(params[0]));
    const live = row !== undefined && new Date(row.expires_at).getTime() > Date.now();
    return { rows: live ? [row as FakeRow] : [], rowCount: live ? 1 : 0 };
  }
  if (text.startsWith('DELETE FROM mcp_bootstrap_records WHERE credential_id')) {
    const had = store.delete(String(params[0]));
    return { rows: [], rowCount: had ? 1 : 0 };
  }
  if (text.startsWith('DELETE FROM mcp_bootstrap_records WHERE expires_at')) {
    let removed = 0;
    for (const [key, row] of [...store.entries()]) {
      if (new Date(row.expires_at).getTime() <= Date.now()) { store.delete(key); removed += 1; }
    }
    return { rows: [], rowCount: removed };
  }
  throw new Error(`unrecognised mcp_bootstrap_records SQL — the fake must model every shape: ${text}`);
}

// The Skill registry is a mock ONLY so one arm of the "did not compile"
// control can make the compile throw. Its default behaviour is the same empty
// list the real query would return against this suite's empty database.
jest.mock('../services/SkillManager', () => ({
  skillManager: {
    list: jest.fn(async () => []),
    getEffectiveSkillsForProject: jest.fn(async () => []),
  },
}));

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      seenSql.push(sql);
      if (sql.includes('mcp_bootstrap_records')) return bootstrapRecordQuery(sql, params);
      return { rows: [], rowCount: 0 };
    }),
    connect: jest.fn(async () => {
      throw new Error('this suite does not model a transactional client; nothing under test needs one');
    }),
  },
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
}));

import mcpRoutes from '../mcp/httpRoute';
import { MCP_TOOLS, toolByName, type McpTool } from '../mcp/registry';
import {
  BOOTSTRAP_EXEMPT_PLANES, BOOTSTRAP_REFUSAL_MARKER, BOOTSTRAP_VERB, bootstrapGate,
} from '../mcp/bootstrapGate';
import { BOOTSTRAP_TTL_MS, recordBootstrap, isBootstrapLive, clearBootstrap } from '../services/McpBootstrapService';
import { principalService, type Principal, type PrincipalCredential } from '../services/PrincipalService';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { delegationService } from '../services/DelegationService';
import { skillManager } from '../services/SkillManager';
import { personalityService } from '../services/PersonalityService';
import { reportManager } from '../services/ReportManager';
import { taskManagerDB } from '../services/TaskManagerDB';

const TOKEN = 'rh_dev_keyid01.secretsecretsecretsecret';
const CREDENTIAL_ID = '99999999-9999-4999-8999-999999999999';
const SCOPES = ['principals:read', 'skills:read', 'tasks:read', 'tasks:write', 'reports:read'];

/**
 * A SECOND identity, for the route-to-compiler actor seam (review 0501de28 B1).
 *
 * It is DELEGATED — it carries a parent — because one of the two mutations that
 * proved the seam unguarded substituted `parentPrincipalId ?? id`. Against an
 * unparented principal that substitution is an equivalent mutant and no control
 * could ever catch it; against this one it changes the actor, which is the
 * whole point.
 */
const OTHER_TOKEN = 'rh_dev_keyid02.secretsecretsecretsecret';
const OTHER_CREDENTIAL_ID = '99999999-9999-4999-8999-99999999900b';
const OTHER_PRINCIPAL_ID = '88888888-8888-4888-8888-88888888800b';
const PARENT_PRINCIPAL_ID = '77777777-7777-4777-8777-777777777777';

/**
 * One of EVERYTHING per identity — Skill, bound Task, Personality and attached
 * Report — so "only your own content" has something to be true of on every
 * plane the compiler consults.
 *
 * Review de782259 B1: the first version of this control gave both principals
 * `boundTaskId: null` and `personalityId: null`, so it reached the repository
 * only for Skills. A substituted principal at the Task or Personality
 * predicate left the whole 162-suite set green.
 */
const DEFAULT_PRINCIPAL_ID = '88888888-8888-4888-8888-888888888888';
const SKILL_FOR_DEFAULT = 'a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SKILL_FOR_OTHER = 'b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const TASK_FOR_DEFAULT = 'a2a2a2a2-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const TASK_FOR_OTHER = 'b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const PERSONALITY_FOR_DEFAULT = 'a3a3a3a3-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const PERSONALITY_FOR_OTHER = 'b3b3b3b3-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const REPORT_FOR_DEFAULT = 'a4a4a4a4-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const REPORT_FOR_OTHER = 'b4b4b4b4-bbbb-4bbb-8bbb-bbbbbbbbbbb4';

const SKILL_ROWS = [
  { id: SKILL_FOR_DEFAULT, name: 'Skill of the presenting caller', category: 'ops', version: 1, description: 'DEFAULT-ONLY-SUMMARY', content_sha256: 'sha-a' },
  { id: SKILL_FOR_OTHER, name: 'Skill of the other principal', category: 'ops', version: 1, description: 'OTHER-ONLY-SUMMARY', content_sha256: 'sha-b' },
];

/** Which principal may reach what. Keyed on the ACTOR, deliberately: a grant
 * table that ignored the actor could not tell whose grants were consulted. */
const GRANTS: Record<string, string[]> = {
  [DEFAULT_PRINCIPAL_ID]: [SKILL_FOR_DEFAULT, TASK_FOR_DEFAULT, PERSONALITY_FOR_DEFAULT, REPORT_FOR_DEFAULT],
  [OTHER_PRINCIPAL_ID]: [SKILL_FOR_OTHER, TASK_FOR_OTHER, PERSONALITY_FOR_OTHER, REPORT_FOR_OTHER],
};
const BOUND: Record<string, { taskId: string; personalityId: string; title: string }> = {
  [DEFAULT_PRINCIPAL_ID]: { taskId: TASK_FOR_DEFAULT, personalityId: PERSONALITY_FOR_DEFAULT, title: 'DEFAULT-ONLY-TASK-TITLE' },
  [OTHER_PRINCIPAL_ID]: { taskId: TASK_FOR_OTHER, personalityId: PERSONALITY_FOR_OTHER, title: 'OTHER-ONLY-TASK-TITLE' },
};
const seenActors: Array<{ type: string; action: string; principalId: unknown; handle: unknown }> = [];

let server: http.Server;
let base = '';

function principalRow(): Principal {
  return {
    id: '88888888-8888-4888-8888-888888888888', kind: 'service', handle: 'connector_one',
    displayName: 'Connector One', status: 'active', role: 'agent', boundTaskId: null,
    purpose: null, legacyIdentity: false, ownExpression: null, sourceTag: null, harness: null,
    personalityId: null, parentPrincipalId: null, lastSeenAt: null, metadata: {},
  };
}

function credentialRow(): PrincipalCredential {
  return {
    id: CREDENTIAL_ID, principalId: principalRow().id, credentialType: 'api_key',
    keyId: 'keyid01', scopes: SCOPES, expiresAt: null, revokedAt: null,
    transport: 'mcp', graceUntil: null, metadata: {},
  };
}

/** The second, DELEGATED identity and its credential. */
function otherPrincipalRow(): Principal {
  return {
    ...principalRow(),
    id: OTHER_PRINCIPAL_ID, handle: 'connector_two', displayName: 'Connector Two',
    parentPrincipalId: PARENT_PRINCIPAL_ID,
  };
}

function otherCredentialRow(): PrincipalCredential {
  return {
    ...credentialRow(), id: OTHER_CREDENTIAL_ID, principalId: OTHER_PRINCIPAL_ID, keyId: 'keyid02',
  };
}

/** Authenticate whichever of the two identities the presented token names. */
function authenticateByToken(): void {
  jest.spyOn(principalService, 'authenticatePrincipalKey').mockImplementation(async (parts) => {
    const keyId = (parts as unknown as { keyId?: string }).keyId;
    return keyId === 'keyid02'
      ? { principal: otherPrincipalRow(), credential: otherCredentialRow() }
      : { principal: principalRow(), credential: credentialRow() };
  });
  // The delegated identity takes the chain arm of acceptPrincipalKey.
  jest.spyOn(delegationService, 'resolveChain').mockResolvedValue({
    alive: true,
    links: [
      { principalId: OTHER_PRINCIPAL_ID, kind: 'service', role: 'agent', parentPrincipalId: PARENT_PRINCIPAL_ID, boundTaskId: null, legacyIdentity: false, ownExpression: null },
      { principalId: PARENT_PRINCIPAL_ID, kind: 'service', role: 'agent', parentPrincipalId: null, boundTaskId: null, legacyIdentity: false, ownExpression: null },
    ],
  } as never);
  jest.spyOn(delegationService, 'effectiveScopes').mockReturnValue(SCOPES as never);
}

interface Wire { status: number; body: any }

function post(payload: unknown, token: string | null = TOKEN): Promise<Wire> {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(data.byteLength),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const callTool = (name: string, args: Record<string, unknown> = {}, token: string = TOKEN): Promise<Wire> =>
  post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, token);

const textOf = (wire: Wire): string => String(wire.body?.result?.content?.[0]?.text ?? '');
const refused = (wire: Wire): boolean => textOf(wire).includes(BOOTSTRAP_REFUSAL_MARKER);

const WORK_TOOLS = MCP_TOOLS.filter((tool) => tool.plane === 'work');
const EXEMPT_TOOLS = MCP_TOOLS.filter((tool) => BOOTSTRAP_EXEMPT_PLANES.includes(tool.plane));

/**
 * The tools that MUST be reachable before a credential has bootstrapped:
 * the bootstrap verb itself and every read-only introspection tool.
 *
 * WRITTEN OUT ON PURPOSE, and reviewed as text. Every other assertion in this
 * file derives its expectation from `tool.plane`, which cannot detect a plane
 * that is simply wrong — review c4409291 B2 moved `relayhall_task_list` into
 * `work` and the whole suite stayed green while a read-only tool started being
 * refused. An expected set derived from the field under test is not a control.
 *
 * Adding a tool here is a review decision: it says "this tool changes no board
 * state and an un-bootstrapped caller may run it".
 */
const EXPECTED_EXEMPT_TOOLS = [
  'relayhall_access_preview',
  'relayhall_brief_compile',
  'relayhall_charter_get',
  'relayhall_personality_list',
  'relayhall_phase_get',
  'relayhall_phase_list',
  'relayhall_principal_list',
  'relayhall_principal_whoami',
  'relayhall_project_context_get',
  'relayhall_project_get',
  'relayhall_project_list',
  'relayhall_project_resource_get',
  'relayhall_project_resource_list',
  'relayhall_report_get',
  'relayhall_report_search',
  'relayhall_service_get',
  'relayhall_service_list',
  'relayhall_skill_get',
  'relayhall_skill_list',
  'relayhall_task_get',
  'relayhall_task_list',
  'relayhall_task_reference_list',
  'relayhall_warrant_list',
];

/** Minimal, schema-shaped arguments — enough to reach the handler if the gate
 * let the call through. They deliberately do NOT have to be valid: a handler
 * that runs answers with its own complaint, which is not the marker. */
function probeArgs(tool: McpTool): Record<string, unknown> {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: unknown; enum?: unknown }>;
  const required = (tool.inputSchema.required ?? []) as string[];
  const args: Record<string, unknown> = {};
  for (const key of required) {
    const spec = properties[key] ?? {};
    if (spec.type === 'boolean') args[key] = false;
    else if (spec.type === 'integer' || spec.type === 'number') args[key] = 1;
    else if (spec.type === 'array') args[key] = [];
    else if (spec.type === 'object') args[key] = {};
    else if (Array.isArray(spec.enum)) args[key] = spec.enum[0];
    else args[key] = '11111111-1111-4111-8111-111111111111';
  }
  return args;
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/mcp', mcpRoutes);
  server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => {
  jest.restoreAllMocks();
  store.clear();
  seenSql.length = 0;
  failNextLiveness = false;
  jest.spyOn(principalService, 'bumpLastSeen').mockImplementation(() => undefined as never);
  jest.spyOn(principalService, 'authenticatePrincipalKey')
    .mockResolvedValue({ principal: principalRow(), credential: credentialRow() });
  jest.spyOn(principalService, 'getCredentialWithPrincipal').mockResolvedValue({
    credential: {
      id: CREDENTIAL_ID, principalId: principalRow().id, keyId: 'keyid01', label: 'probe',
      scopes: SCOPES, credentialType: 'api_key', expiresAt: null, revokedAt: null, transport: 'mcp',
    },
    principal: principalRow(),
  });
});

// ════════════════════════ the partition, over the whole registry ═══════════

describe('the exempt set is the registry, not a list someone maintains', () => {
  it('every tool declares a plane, and the two sides partition the surface', () => {
    for (const tool of MCP_TOOLS) {
      expect([tool.name, tool.plane]).toEqual([tool.name, expect.stringMatching(/^(bootstrap|introspection|work)$/)]);
    }
    expect(WORK_TOOLS.length + EXEMPT_TOOLS.length).toBe(MCP_TOOLS.length);
    // Non-vacuous on BOTH sides: an empty work set would make every sweep
    // below pass by having nothing to sweep.
    expect(WORK_TOOLS.length).toBeGreaterThan(10);
    expect(EXEMPT_TOOLS.length).toBeGreaterThan(10);
  });

  it('names the bootstrap verb, and it is the only tool in that plane', () => {
    const bootstrapPlane = MCP_TOOLS.filter((tool) => tool.plane === 'bootstrap');
    expect(bootstrapPlane.map((tool) => tool.name)).toEqual([BOOTSTRAP_VERB]);
  });

  it('matches the REVIEWED exempt inventory, in both directions', () => {
    // Both directions, because each catches what the other cannot: a mutating
    // verb sneaking into the exempt set, and a read-only tool being pushed out
    // of it. The second direction is the one review c4409291 B2 found missing.
    expect([...EXEMPT_TOOLS.map((tool) => tool.name)].sort()).toEqual([...EXPECTED_EXEMPT_TOOLS].sort());
    const workNames = WORK_TOOLS.map((tool) => tool.name);
    for (const name of EXPECTED_EXEMPT_TOOLS) {
      expect([name, workNames.includes(name)]).toEqual([name, false]);
    }
    // The inventory names tools that exist: a stale entry is a failure, not a
    // silently-satisfied expectation.
    const live = MCP_TOOLS.map((tool) => tool.name);
    for (const name of EXPECTED_EXEMPT_TOOLS) {
      expect([name, live.includes(name)]).toEqual([name, true]);
    }
  });

  it('every reviewed-exempt tool is actually reachable un-bootstrapped', async () => {
    // The inventory above is a claim about the registry; this is the same claim
    // measured through the live surface, so a tool that is exempt on paper and
    // refused in practice fails here.
    const wronglyRefused: string[] = [];
    for (const name of EXPECTED_EXEMPT_TOOLS) {
      const tool = toolByName(name);
      if (!tool) { wronglyRefused.push(`${name} (missing from the registry)`); continue; }
      const wire = await callTool(name, probeArgs(tool));
      if (refused(wire)) wronglyRefused.push(name);
    }
    expect(wronglyRefused).toEqual([]);
  }, 60_000);

  it('classifies every mutating verb as work — no write hides in the exempt set', () => {
    const mutating = /_(create|update|move|set|append|finish|claim|release|recover|renew|archive|restore|replace|reject|run|mint|reveal|revoke)$/;
    const misfiled = EXEMPT_TOOLS.filter((tool) => mutating.test(tool.name)).map((tool) => tool.name);
    expect(misfiled).toEqual([]);
    // And the pattern is not inert: it matches most of the work plane.
    expect(WORK_TOOLS.filter((tool) => mutating.test(tool.name)).length).toBeGreaterThan(15);
  });
});

describe('un-bootstrapped: EVERY work-plane tool refuses, EVERY exempt tool does not', () => {
  it(`refuses all ${WORK_TOOLS.length} work-plane tools with "${BOOTSTRAP_REFUSAL_MARKER}"`, async () => {
    const allowed: string[] = [];
    for (const tool of WORK_TOOLS) {
      const wire = await callTool(tool.name, probeArgs(tool));
      if (!refused(wire)) allowed.push(`${tool.name} -> ${textOf(wire).slice(0, 120)}`);
    }
    expect(allowed).toEqual([]);
  }, 60_000);

  it(`lets all ${EXEMPT_TOOLS.length} exempt tools past the gate`, async () => {
    const wronglyRefused: string[] = [];
    for (const tool of EXEMPT_TOOLS) {
      const wire = await callTool(tool.name, probeArgs(tool));
      if (refused(wire)) wronglyRefused.push(tool.name);
    }
    expect(wronglyRefused).toEqual([]);
  }, 60_000);

  it('refuses BEFORE the handler runs — an invalid work call still gets the gate', async () => {
    // `relayhall_report_create` requires title and content. Sent empty, a
    // handler that ran would answer "Missing argument: title". The marker
    // instead is the ordering proof: nothing downstream of the gate executed.
    const wire = await callTool('relayhall_report_create', {});
    expect(textOf(wire)).toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect(textOf(wire)).not.toContain('Missing argument');
    expect(wire.body.result.isError).toBe(true);
    // A TOOL error, never a protocol error: the model has to be able to read it.
    expect(wire.body.error).toBeUndefined();
  });

  it('says what to call, and carries the granted-skill index inline', async () => {
    const wire = await callTool('relayhall_task_create', probeArgs(MCP_TOOLS.find((t) => t.name === 'relayhall_task_create')!));
    const text = textOf(wire);
    expect(text).toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect(text).toContain(BOOTSTRAP_VERB);
    expect(text).toContain('"session": true');
    // The index is present in one of its three legitimate forms, and the test
    // says WHICH — an assertion that accepted any of them without checking
    // would pass on a refusal that carried no index at all.
    expect(text).toContain('Your granted skill index is empty');
  });
});

// ═══════════════════════ the positive control (D2, mandatory) ══════════════

describe('the positive control: refuse, bootstrap, succeed, expire, refuse again', () => {
  const WORK_CALL = 'relayhall_report_create';
  const WORK_ARGS = { title: 'probe', content: 'body' };

  it('runs the whole cycle on ONE unchanged call', async () => {
    // 1 — before bootstrapping, refused.
    const before = await callTool(WORK_CALL, WORK_ARGS);
    expect(textOf(before)).toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect(await isBootstrapLive(CREDENTIAL_ID)).toBe(false);

    // 2 — the bootstrap verb succeeds and records the credential.
    const bootstrap = await callTool(BOOTSTRAP_VERB, { session: true });
    expect(bootstrap.body.result.isError).toBeFalsy();
    expect(textOf(bootstrap)).toContain('Bootstrapped.');
    expect(textOf(bootstrap)).toContain('Board workflow doctrine');
    expect(await isBootstrapLive(CREDENTIAL_ID)).toBe(true);

    // 3 — the IDENTICAL call is no longer refused by the gate.
    const after = await callTool(WORK_CALL, WORK_ARGS);
    expect(textOf(after)).not.toContain(BOOTSTRAP_REFUSAL_MARKER);

    // 4 — a lapsed record refuses again. The TTL is applied to the `now` the
    // writer is given, so a `now` one hour past the window produces a record
    // that is genuinely expired rather than one the test declared expired.
    await recordBootstrap(CREDENTIAL_ID, new Date(Date.now() - BOOTSTRAP_TTL_MS - 3_600_000));
    expect(await isBootstrapLive(CREDENTIAL_ID)).toBe(false);
    const lapsed = await callTool(WORK_CALL, WORK_ARGS);
    expect(textOf(lapsed)).toContain(BOOTSTRAP_REFUSAL_MARKER);

    // 5 — and re-bootstrapping refreshes rather than duplicating.
    await callTool(BOOTSTRAP_VERB, { session: true });
    expect(store.size).toBe(1);
    expect(await isBootstrapLive(CREDENTIAL_ID)).toBe(true);
  }, 30_000);

  it('a forgotten record refuses again — the gate reads state, it does not remember', async () => {
    await callTool(BOOTSTRAP_VERB, { session: true });
    expect(refused(await callTool(WORK_CALL, WORK_ARGS))).toBe(false);
    await clearBootstrap(CREDENTIAL_ID);
    expect(refused(await callTool(WORK_CALL, WORK_ARGS))).toBe(true);
  }, 30_000);

  it('a liveness lookup that THREW refuses — "we do not know" is not "yes"', async () => {
    // Bootstrap for real first, so the ONLY difference in the call below is
    // that the lookup failed. Without that control this would pass on a gate
    // that refuses everything.
    await callTool(BOOTSTRAP_VERB, { session: true });
    expect(refused(await callTool(WORK_CALL, WORK_ARGS))).toBe(false);

    failNextLiveness = true;
    const wedged = await callTool(WORK_CALL, WORK_ARGS);
    expect(textOf(wedged)).toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect(textOf(wedged)).toContain('could not establish');

    // …and the wedge was momentary: the next call is allowed again, so the
    // refusal above was caused by the failure and not by losing the record.
    expect(refused(await callTool(WORK_CALL, WORK_ARGS))).toBe(false);
  }, 30_000);

  it('a credential revoked between the door and the gate refuses', async () => {
    await callTool(BOOTSTRAP_VERB, { session: true });
    expect(refused(await callTool(WORK_CALL, WORK_ARGS))).toBe(false);

    // The ingress authenticates, then the gate re-resolves. Revocation lands in
    // that window: the door says yes, the gate must say no. This is the whole
    // reason the gate resolves the credential itself instead of trusting one
    // handed down a transport.
    let call = 0;
    jest.spyOn(principalService, 'authenticatePrincipalKey').mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { principal: principalRow(), credential: credentialRow() }
        : (undefined as never);
    });
    const revoked = await callTool(WORK_CALL, WORK_ARGS);
    expect(textOf(revoked)).toContain(BOOTSTRAP_REFUSAL_MARKER);
    expect(textOf(revoked)).toContain('did not authenticate');
  }, 30_000);

  it('ignores a credential id supplied on the call context — it resolves its own', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000ff';
    // Give the SUPPLIED id a live record and the real credential none. A gate
    // that trusted what it was handed would let this through; one that resolves
    // for itself refuses.
    await recordBootstrap(OTHER);
    expect(await isBootstrapLive(OTHER)).toBe(true);
    expect(await isBootstrapLive(CREDENTIAL_ID)).toBe(false);

    const tool = toolByName(WORK_CALL)!;
    const refusal = await bootstrapGate(tool, {
      authorization: `Bearer ${TOKEN}`,
      toolName: WORK_CALL,
      credentialId: OTHER,
    } as never);
    expect(refusal).toContain(BOOTSTRAP_REFUSAL_MARKER);

    // Not vacuous: the same call passes once the REAL credential is recorded.
    await recordBootstrap(CREDENTIAL_ID);
    expect(await bootstrapGate(tool, {
      authorization: `Bearer ${TOKEN}`, toolName: WORK_CALL, credentialId: OTHER,
    } as never)).toBeNull();
  }, 30_000);

  it('the TTL is a TTL — bounded at both ends, so the record really does lapse', () => {
    // A control that scales with the constant it is testing cannot catch a
    // constant that was widened: the expiry case above computes its `now` from
    // BOOTSTRAP_TTL_MS, so a TTL of a century would still pass it. This is the
    // assertion that does not move — long enough that a real session never
    // meets the refusal mid-run, short enough that a credential parked in a
    // config file cannot stay bootstrapped indefinitely.
    expect(BOOTSTRAP_TTL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(BOOTSTRAP_TTL_MS).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it.each([
    ['the credential row cannot be read', () => {
      jest.spyOn(principalService, 'getCredentialWithPrincipal').mockResolvedValue(undefined);
    }],
    ['the compile itself throws', () => {
      const { skillManager } = jest.requireMock('../services/SkillManager') as {
        skillManager: { list: jest.Mock };
      };
      skillManager.list.mockRejectedValueOnce(new Error('registry unavailable'));
    }],
  ])('a Brief that did not compile does not mark the credential bootstrapped (%s)', async (_label, arrange) => {
    // The record is written AFTER the compile succeeds. A payload that was
    // never delivered must not satisfy the gate that exists to make sure it
    // was — otherwise "has bootstrapped" degrades into "asked once". Two
    // failure points, because a control that only exercises the earliest one
    // cannot see the write being moved past it.
    arrange();
    const wire = await callTool(BOOTSTRAP_VERB, { session: true });
    expect(wire.body.result.isError).toBe(true);
    expect(await isBootstrapLive(CREDENTIAL_ID)).toBe(false);
    expect(store.size).toBe(0);
    // And the work-plane call it was supposed to unlock is still refused.
    expect(refused(await callTool(WORK_CALL, WORK_ARGS))).toBe(true);
  }, 30_000);

  it('bootstrapping one credential does not bootstrap another', async () => {
    await callTool(BOOTSTRAP_VERB, { session: true });
    expect(await isBootstrapLive(CREDENTIAL_ID)).toBe(true);
    expect(await isBootstrapLive('00000000-0000-4000-8000-000000000000')).toBe(false);
  }, 30_000);
});

// ═══════════════════════ the session brief itself (subtask [2]) ════════════

describe('the session brief is what a harness bootstraps with (strategy §2.10)', () => {
  it('carries every part §2.10 names, and says what it is', async () => {
    const wire = await callTool(BOOTSTRAP_VERB, { session: true });
    const text = textOf(wire);
    expect(text).toContain('Session brief');
    expect(text).toContain('This identity');
    expect(text).toContain('Granted skill index');
    expect(text).toContain('Board workflow doctrine');
    // Board free text rides inside the §4.1 untrusted fence, as everywhere else.
    expect(text).toContain('untrusted data');
  }, 30_000);

  it('refuses more than one altitude, and refuses none', async () => {
    const both = await callTool(BOOTSTRAP_VERB, { session: true, taskId: '11111111-1111-4111-8111-111111111111' });
    expect(textOf(both)).toContain('exactly one altitude');
    const neither = await callTool(BOOTSTRAP_VERB, {});
    expect(textOf(neither)).toContain('exactly one altitude');
    // Neither attempt bootstrapped anything.
    expect(await isBootstrapLive(CREDENTIAL_ID)).toBe(false);
  }, 30_000);
});

// ═══════ the route-to-compiler actor seam (review 0501de28 B1) ═════════════

describe('the Brief route hands the compiler the PRESENTING caller actor', () => {
  // Every other content control calls compileSessionBrief directly, so a route
  // that passed the wrong actor left all 162 suites green — the reviewer proved
  // it twice, substituting a parent actor and an unrelated one. This one drives
  // the REAL route through the REAL transport with two identities whose grants
  // differ, and asserts both halves: each caller sees only its own content, and
  // the authorization repository received the presenting principal's actor.
  /** Each identity, bound to its own Task and its own Personality. */
  const boundPrincipal = (credentialId: string): Principal => {
    const base = credentialId === OTHER_CREDENTIAL_ID ? otherPrincipalRow() : principalRow();
    const binding = BOUND[base.id];
    return { ...base, boundTaskId: binding.taskId, personalityId: binding.personalityId };
  };

  beforeEach(() => {
    seenActors.length = 0;
    authenticateByToken();
    // The authenticating identity is bound too, or the compiler would see the
    // unbound row and never reach the Task or Personality planes at all.
    jest.spyOn(principalService, 'authenticatePrincipalKey').mockImplementation(async (parts) => {
      const keyId = (parts as unknown as { keyId?: string }).keyId;
      return keyId === 'keyid02'
        ? { principal: boundPrincipal(OTHER_CREDENTIAL_ID), credential: otherCredentialRow() }
        : { principal: boundPrincipal(CREDENTIAL_ID), credential: credentialRow() };
    });
    jest.spyOn(principalService, 'getCredentialWithPrincipal').mockImplementation(async (id) => ({
      credential: {
        id, principalId: id === OTHER_CREDENTIAL_ID ? OTHER_PRINCIPAL_ID : principalRow().id,
        keyId: 'k', label: 'probe', scopes: SCOPES, credentialType: 'api_key',
        expiresAt: null, revokedAt: null, transport: 'mcp',
      },
      principal: boundPrincipal(id),
    }));
    (skillManager.list as jest.Mock).mockImplementation(async () => SKILL_ROWS);
    jest.spyOn(taskManagerDB, 'getTask').mockImplementation(async (id) => {
      const owner = Object.entries(BOUND).find(([, b]) => b.taskId === id);
      return owner
        ? { id, title: owner[1].title, status: 'in-progress', subtasks: [], tags: [] } as never
        : undefined;
    });
    jest.spyOn(taskManagerDB, 'queryLinkedReports').mockImplementation(async (taskIds) => {
      const forDefault = (taskIds as string[]).includes(TASK_FOR_DEFAULT);
      return [{ id: forDefault ? REPORT_FOR_DEFAULT : REPORT_FOR_OTHER, taskId: (taskIds as string[])[0], title: 'linked' }] as never;
    });
    jest.spyOn(reportManager, 'getBriefProjections').mockImplementation(async (ids) => (ids as string[]).map((id) => ({
      id, title: 'Linked report', status: 'published',
      summary: id === REPORT_FOR_DEFAULT ? 'DEFAULT-ONLY-REPORT' : 'OTHER-ONLY-REPORT',
      handover: null, content: 'body', content_hash: 'h',
    })) as never);
    jest.spyOn(personalityService, 'getById').mockImplementation(async (id) => ({
      id, name: id === PERSONALITY_FOR_DEFAULT ? 'Default Personality' : 'Other Personality',
      category: 'engineering',
      content: id === PERSONALITY_FOR_DEFAULT ? 'DEFAULT-ONLY-PERSONALITY' : 'OTHER-ONLY-PERSONALITY',
    }) as never);
    // Grant-scoped by the ACTOR it is handed — the one thing the seam decides.
    jest.spyOn(authorizationRepository, 'authorizedIds').mockImplementation(
      async (actor, type, ids, action) => {
        seenActors.push({ type, action, principalId: actor?.principalId, handle: actor?.handle });
        const allowed = GRANTS[String(actor?.principalId)] ?? [];
        return new Set(ids.filter((id) => allowed.includes(id)));
      },
    );
  });

  it('gives each caller ITS OWN content on EVERY plane, never the other principal one', async () => {
    const mine = textOf(await callTool(BOOTSTRAP_VERB, { session: true }, TOKEN));
    for (const own of ['DEFAULT-ONLY-SUMMARY', 'DEFAULT-ONLY-TASK-TITLE', 'DEFAULT-ONLY-PERSONALITY', 'DEFAULT-ONLY-REPORT']) {
      expect([own, mine.includes(own)]).toEqual([own, true]);
    }
    for (const theirs of ['OTHER-ONLY-SUMMARY', 'OTHER-ONLY-TASK-TITLE', 'OTHER-ONLY-PERSONALITY', 'OTHER-ONLY-REPORT', SKILL_FOR_OTHER, TASK_FOR_OTHER, PERSONALITY_FOR_OTHER, REPORT_FOR_OTHER]) {
      expect([theirs, mine.includes(theirs)]).toEqual([theirs, false]);
    }

    const theirBrief = textOf(await callTool(BOOTSTRAP_VERB, { session: true }, OTHER_TOKEN));
    for (const own of ['OTHER-ONLY-SUMMARY', 'OTHER-ONLY-TASK-TITLE', 'OTHER-ONLY-PERSONALITY', 'OTHER-ONLY-REPORT']) {
      expect([own, theirBrief.includes(own)]).toEqual([own, true]);
    }
    for (const mineOnly of ['DEFAULT-ONLY-SUMMARY', 'DEFAULT-ONLY-TASK-TITLE', 'DEFAULT-ONLY-PERSONALITY', 'DEFAULT-ONLY-REPORT', SKILL_FOR_DEFAULT, TASK_FOR_DEFAULT, PERSONALITY_FOR_DEFAULT, REPORT_FOR_DEFAULT]) {
      expect([mineOnly, theirBrief.includes(mineOnly)]).toEqual([mineOnly, false]);
    }
  }, 30_000);

  it('asks about the presenting principal at EVERY plane, with the ratified verb', async () => {
    await callTool(BOOTSTRAP_VERB, { session: true }, OTHER_TOKEN);
    const planes = seenActors.map((entry) => `${entry.type}/${entry.action}`);
    for (const expected of ['task/read', 'personality/use', 'report/read', 'skill/read']) {
      expect([expected, planes.includes(expected)]).toEqual([expected, true]);
    }
    for (const entry of seenActors) {
      expect([entry.type, entry.principalId]).toEqual([entry.type, OTHER_PRINCIPAL_ID]);
    }
  }, 30_000);

  it('passes the PRESENTING principal to the authorization plane, not its parent', async () => {
    await callTool(BOOTSTRAP_VERB, { session: true }, OTHER_TOKEN);
    expect(seenActors.length).toBeGreaterThan(0);
    for (const entry of seenActors) {
      // The delegated identity's OWN id — not PARENT_PRINCIPAL_ID, which is what
      // a `parentPrincipalId ?? id` substitution would produce, and not any
      // other principal, which is what an unrelated-uuid substitution would.
      expect(entry.principalId).toBe(OTHER_PRINCIPAL_ID);
      expect(entry.principalId).not.toBe(PARENT_PRINCIPAL_ID);
      expect(entry.handle).toBe('connector_two');
    }
  }, 30_000);

  it('and the same for the unparented identity — the seam is not per-shape', async () => {
    await callTool(BOOTSTRAP_VERB, { session: true }, TOKEN);
    expect(seenActors.length).toBeGreaterThan(0);
    for (const entry of seenActors) {
      expect(entry.principalId).toBe(DEFAULT_PRINCIPAL_ID);
      expect(entry.handle).toBe('connector_one');
    }
  }, 30_000);
});

// ═══════════════ the census: the review-time backstop, named as one ════════

describe('source census (a backstop for review, not the proof above)', () => {
  const mcpDir = path.join(__dirname, '..', 'mcp');
  const read = (file: string): string => fs.readFileSync(path.join(mcpDir, file), 'utf8');
  const files = fs.readdirSync(mcpDir, { recursive: true } as never) as string[];

  it('invokes a tool handler from exactly one site, and the gate guards that site', () => {
    // Parsed, not grepped: a comment or a string that mentions the call is not
    // a call site, and the first version of this census counted its own
    // docblock. Only a real CallExpression counts.
    const sites: string[] = [];
    for (const file of files.filter((name) => String(name).endsWith('.ts'))) {
      const name = String(file);
      const sourceFile = ts.createSourceFile(name, read(name), ts.ScriptTarget.ES2020, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'handler'
          && node.expression.expression.getText() === 'tool') {
          sites.push(name + ': ' + node.getText().replace(/\s+/g, ' '));
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(sites).toHaveLength(1);
    expect(sites[0]).toContain('server.ts');
    const server = read('server.ts');
    // The gate is awaited BEFORE that invocation, in the same handler.
    expect(server.indexOf('await bootstrapGate(')).toBeGreaterThan(-1);
    expect(server.indexOf('await bootstrapGate(')).toBeLessThan(server.indexOf('await tool.handler('));
  });

  it('writes the bootstrap record from exactly one site, and it is the Brief route', () => {
    const backend = path.join(__dirname, '..');
    const sites: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', '__tests__', 'migrations'].includes(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = fs.readFileSync(full, 'utf8');
        if (/\brecordBootstrap\s*\(/.test(source) && !full.endsWith('McpBootstrapService.ts')) {
          sites.push(path.relative(backend, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(backend);
    expect(sites).toEqual(['routes/principals.ts']);
  });
});
