/**
 * POST /telemetry/events — the ENDPOINT, driven for real (RH-TW1a candidate B).
 *
 * Review `29874574` finding F3: §4.1's fourth named acceptance test is
 * *"a direct `Account → Agent` credential presenting `telemetry:write` is
 * refused with the distinct error AND the refusal is audited"*, and the
 * service-level suite could not test the second half — `TelemetryPrincipalService`
 * has no audit dependency and never could. **A classification cannot check
 * itself, and a direct-call test proves nothing about the seam that feeds it.**
 * This suite drives the production route across that seam: the refusal, the
 * exact metadata-only audit call, and — the part that matters — that a FAILING
 * audit still refuses the request.
 *
 * It also pins the F1 and F2 repairs at the endpoint, where they are reachable.
 */
import express from 'express';
import type { AddressInfo } from 'net';

const db = {
  statements: [] as Array<{ text: string; params: unknown[] }>,
  /** Principals the REGISTRY says are Connectors. */
  connectors: new Set<string>(),
  /** The current descriptor telemetry block, or null for none declared. */
  descriptor: null as null | { tier: string; products?: string[] },
  /** (principal|surface) -> last accepted ms, modelling telemetry_rate_limits. */
  rateLimits: new Map<string, number>(),
  /** Rows returned by the session_events insert. */
  insertRows: [{ event_id: 'evt-row-1' }] as Array<Record<string, unknown>>,
};

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      db.statements.push({ text, params: params ?? [] });
      if (text.includes('AS is_connector')) {
        return { rows: [{ is_connector: db.connectors.has(String((params ?? [])[0])) }] };
      }
      if (text.includes('service_descriptor_versions')) {
        return db.descriptor
          ? { rows: [{ descriptor: { options: [], telemetry: db.descriptor }, version: 3 }] }
          : { rows: [] };
      }
      if (/INSERT INTO telemetry_rate_limits/.test(text)) {
        const [principalId, surface, nowIso, intervalMs] = (params ?? []) as string[];
        const key = `${principalId}|${surface}`;
        const now = new Date(nowIso).getTime();
        const last = db.rateLimits.get(key);
        if (last !== undefined && now - last < Number(intervalMs)) return { rows: [], rowCount: 0 };
        db.rateLimits.set(key, now);
        return { rows: [{ last_accepted_at: nowIso }], rowCount: 1 };
      }
      if (/UPDATE telemetry_rate_limits/.test(text)) {
        const [principalId, surface] = (params ?? []) as string[];
        const last = db.rateLimits.get(`${principalId}|${surface}`);
        return { rows: last === undefined ? [] : [{ last_accepted_at: new Date(last).toISOString() }] };
      }
      if (/DELETE FROM telemetry_rate_limits/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO session_events/.test(text)) return { rows: db.insertRows, rowCount: db.insertRows.length };
      return { rows: [], rowCount: 0 };
    }),
  },
}));

const auditRecord = jest.fn(async (..._args: any[]) => ({ id: 'audit-1' } as any));
jest.mock('../services/AuditService', () => ({
  auditService: { record: (...args: unknown[]) => auditRecord(...(args as [])) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const telemetryRouter = require('../routes/telemetry').default;

const ACCOUNT = '00000000-0000-4000-8000-00000000acc7';
const CONNECTOR = '00000000-0000-4000-8000-0000000c0nn3';
const AGENT = '00000000-0000-4000-8000-00000000a63n';
const AGENT2 = '00000000-0000-4000-8000-00000000a63m';

const link = (principalId: string, kind: string, parent: string | null) => ({
  principalId, kind, role: null, parentPrincipalId: parent,
  boundTaskId: null, legacyIdentity: false, ownExpression: null,
});

const CHAIN = {
  connector: [link(CONNECTOR, 'service', ACCOUNT), link(ACCOUNT, 'human', null)],
  agent: [link(AGENT, 'agent', CONNECTOR), link(CONNECTOR, 'service', ACCOUNT), link(ACCOUNT, 'human', null)],
  agent2: [link(AGENT2, 'agent', CONNECTOR), link(CONNECTOR, 'service', ACCOUNT), link(ACCOUNT, 'human', null)],
  directAccountAgent: [link(AGENT, 'agent', ACCOUNT), link(ACCOUNT, 'human', null)],
  legacyConnectorNoChain: null as null | ReturnType<typeof link>[],
};

const identity = {
  principalId: CONNECTOR as string | undefined,
  handle: 'outpost-1',
  links: CHAIN.connector as null | ReturnType<typeof link>[],
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    event_id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'model_call',
    source: { product: 'claude-code', adapter: 'otlp' },
    ...overrides,
  };
}

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
  process.env.RELAYHALL_TELEMETRY_PEPPERS = JSON.stringify({ t: Buffer.alloc(32, 5).toString('base64') });
  process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = 't';
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = identity.principalId ? { id: identity.principalId, handle: identity.handle } : undefined;
    (req as any).delegationLinks = identity.links;
    (req as any).authMethod = 'principal_api_key';
    (req as any).credentialId = 'cred-1';
    (req as any).scopes = ['telemetry:write'];
    next();
  });
  app.use('/telemetry', telemetryRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => {
  delete process.env.RELAYHALL_TELEMETRY_PEPPERS;
  delete process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;
  server.close(() => done());
});
beforeEach(() => {
  db.statements.length = 0;
  db.rateLimits.clear();
  db.connectors = new Set([CONNECTOR]);
  db.descriptor = { tier: 'full', products: ['claude-code'] };
  db.insertRows = [{ event_id: 'evt-row-1' }];
  identity.principalId = CONNECTOR;
  identity.links = CHAIN.connector;
  auditRecord.mockClear();
  auditRecord.mockResolvedValue({ id: 'audit-1' } as never);
});

const post = async (body: unknown) => {
  const res = await fetch(`${base}/telemetry/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
};

describe('§4.1 acceptance (d) — refused AND AUDITED, at the endpoint (F3)', () => {
  it('refuses a direct Account -> Agent presenter with the distinct code', async () => {
    identity.principalId = AGENT;
    identity.links = CHAIN.directAccountAgent;
    const { status, body } = await post(envelope());
    expect(status).toBe(403);
    expect(body.code).toBe('TELEMETRY_PRINCIPAL_NO_CONNECTOR');
  });

  it('writes an audit row whose metadata is IDENTIFIERS ONLY (§6.5.3)', async () => {
    identity.principalId = AGENT;
    identity.links = CHAIN.directAccountAgent;
    await post(envelope({ identity: { user_id: 'victim@example.com' } }));
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const write = (auditRecord.mock.calls[0] as any[])[0] as any;
    expect(write).toMatchObject({
      action: 'telemetry.envelope.refused',
      outcome: 'denied',
      resourceType: 'telemetry_envelope',
    });
    expect(write.actor).toMatchObject({ principalId: AGENT, authMethod: 'principal_api_key' });
    expect(write.metadata).toMatchObject({ code: 'TELEMETRY_PRINCIPAL_NO_CONNECTOR', actingPrincipalId: AGENT });
    // The audit plane is metadata-only BY RULE. No envelope bytes may ride in.
    const serialized = JSON.stringify(write.metadata);
    expect(serialized).not.toContain('victim@example.com');
    expect(serialized).not.toContain('claude-code');
    expect(Object.keys(write.metadata).sort())
      .toEqual(['actingPrincipalId', 'chainDepth', 'chainKinds', 'code']);
  });

  it('STILL refuses when the audit write fails — an audit failure is not an acceptance', async () => {
    // The property that matters and that a service-level test cannot reach.
    identity.principalId = AGENT;
    identity.links = CHAIN.directAccountAgent;
    auditRecord.mockRejectedValue(new Error('audit plane unavailable'));
    const { status, body } = await post(envelope());
    expect(status).toBe(403);
    expect(body.code).toBe('TELEMETRY_PRINCIPAL_NO_CONNECTOR');
    expect(db.statements.some((s) => /INSERT INTO session_events/.test(s.text))).toBe(false);
  });

  it('an ACCEPTED write is not audited as a refusal — the control', async () => {
    // Without this, the three assertions above could pass on a route that
    // audits everything, and "the refusal is audited" would mean nothing.
    const { status } = await post(envelope());
    expect(status).toBe(200);
    expect(auditRecord).not.toHaveBeenCalled();
  });
});

describe('F1 at the endpoint — a Connector with no Account chain is refused', () => {
  it('refuses the migration-097 legacy shape and audits it', async () => {
    identity.principalId = CONNECTOR;
    identity.links = CHAIN.legacyConnectorNoChain;   // auth's §10 arm sets none
    const { status, body } = await post(envelope());
    expect(status).toBe(403);
    expect(body.code).toBe('TELEMETRY_PRINCIPAL_NO_ACCOUNT');
    expect(auditRecord).toHaveBeenCalledTimes(1);
    expect(db.statements.some((s) => /INSERT INTO session_events/.test(s.text))).toBe(false);
  });
});

describe('F2 at the endpoint — the rate budget is PER ACTING PRINCIPAL', () => {
  it('two sibling Agents under one Connector do not starve each other', async () => {
    identity.principalId = AGENT;
    identity.links = CHAIN.agent;
    expect((await post(envelope())).status).toBe(200);

    identity.principalId = AGENT2;
    identity.links = CHAIN.agent2;
    // Keyed on the Connector, this second write was refused 429.
    expect((await post(envelope())).status).toBe(200);
  });

  it('the SAME agent is still limited — the budget is real', async () => {
    identity.principalId = AGENT;
    identity.links = CHAIN.agent;
    expect((await post(envelope())).status).toBe(200);
    const second = await post(envelope());
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('RATE_LIMITED');
  });
});

describe('the batch route is mounted, and a wrong-format body costs nothing', () => {
  it('POST /telemetry/events/batch refuses a JSON body with 415', async () => {
    // Candidate B proved this path was reachable by asserting a 404 on a
    // deliberately handler-less route. Candidate C ships the handler, so the
    // 404 is gone — but the property that mattered survives verbatim: a
    // request the endpoint cannot use stores NOTHING and spends NOTHING. The
    // format is JSONL (design §3.1); a JSON body is the wrong format, and the
    // refusal names what it reads instead of guessing at the contents.
    const res = await fetch(`${base}/telemetry/events/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anything: true }),
    });
    expect(res.status).toBe(415);
    expect((await res.json() as Record<string, unknown>).code).toBe('UNSUPPORTED_MEDIA_TYPE');

    // Review `d9697a35` F3: the earlier version of this control named only
    // `session_events` and the rate-limit map, which were the only stores that
    // existed when it was written. Candidate C adds three more, so a regression
    // that QUARANTINED a refused JSON body — or spent its quarantine quota —
    // would have kept it green while "stores nothing and spends nothing"
    // quietly stopped being true. Every write surface this plane has is named,
    // and a new one has to be added here to be forgotten.
    const WRITE_SURFACES = [
      'session_events',
      'telemetry_raw_blobs',
      'session_quarantine',
      'telemetry_quarantine_budget',
      'telemetry_rate_limits',
    ];
    const writes = db.statements.filter((s) => /\b(INSERT INTO|UPDATE|DELETE FROM)\b/.test(s.text));
    for (const surface of WRITE_SURFACES) {
      expect(writes.filter((s) => s.text.includes(surface))).toEqual([]);
    }
    expect(db.rateLimits.size).toBe(0);
  });

  it('… while /telemetry/events itself is handled — the control', () => {
    // Without this, the refusal above could mean the whole router is unmounted.
    return post(envelope()).then(({ status }) => expect(status).toBe(200));
  });
});

describe('B2 at the endpoint — descriptor enforcement', () => {
  it('refuses an undeclared product', async () => {
    const { status, body } = await post(envelope({ source: { product: 'gemini-cli', adapter: 'otlp' } }));
    expect(status).toBe(403);
    expect(body.code).toBe('TELEMETRY_PRODUCT_NOT_DECLARED');
  });

  it('refuses a Connector whose descriptor declares no tier', async () => {
    db.descriptor = null;
    const { status, body } = await post(envelope());
    expect(status).toBe(403);
    expect(body.code).toBe('TELEMETRY_TIER_NOT_DECLARED');
  });
});

describe('B4 at the endpoint — stage order and the advertisement', () => {
  it('a refused presenter never reaches the parser or the store', async () => {
    identity.principalId = AGENT;
    identity.links = CHAIN.directAccountAgent;
    await post({ not: 'an envelope at all' });
    expect(db.statements.some((s) => /INSERT INTO session_events/.test(s.text))).toBe(false);
  });

  it('a rate-limited caller does no storage work', async () => {
    await post(envelope());
    db.statements.length = 0;
    expect((await post(envelope())).status).toBe(429);
    expect(db.statements.some((s) => /INSERT INTO session_events/.test(s.text))).toBe(false);
  });

  it('an unknown schema MAJOR carries the accepted-majors advertisement', async () => {
    const { status, body } = await post(envelope({ schema_version: 'rh.ai.telemetry/9.0' }));
    expect(status).toBe(400);
    expect(body.code).toBe('UNSUPPORTED_SCHEMA_MAJOR');
    expect(body.acceptedMajors).toEqual([1]);
    expect(body.schemaFamily).toBe('rh.ai.telemetry');
  });

  it('accepts a legal envelope and reports the dedupe arm', async () => {
    const { status, body } = await post(envelope());
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, accepted: true, duplicate: false, identityArm: 'event_id' });
  });
});
