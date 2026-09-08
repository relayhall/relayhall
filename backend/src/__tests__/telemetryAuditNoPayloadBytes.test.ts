/**
 * §6.5.3 — THE AUDIT PLANE CARRIES NO PAYLOAD BYTES.
 *
 * Owner decision D5: "Audit retention. State, do not change; plus the
 * no-payload-bytes control." The statement lives in `docs/observability.md`;
 * this is the control, and it is the half that cannot be satisfied by writing
 * a sentence.
 *
 * Design §6.5.3, verbatim: the platform audit plane is "metadata-only by rule:
 * identities, scopes, verbs, timestamps, object IDs — **never request/response
 * bodies or tool-call arguments**."
 *
 * HOW THE PROPERTY IS ASSERTED. Not by inspecting the fields the route happens
 * to pass — that would be a census, and a census is satisfied by whatever it
 * was written against. A distinctive marker is planted in EVERY
 * reporter-controlled position of a request, the audited path is driven, and
 * the whole argument list of every `auditService.record` call is serialised and
 * searched. If any byte the reporter chose reaches the audit plane, this fails,
 * whatever shape it arrived in.
 *
 * AND THE POSITIVE CONTROL: the audit must actually have happened. An assertion
 * that a marker is absent from zero audit calls is true and worthless, and this
 * suite would be exactly that if the refusal ever stopped being audited.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { NDJSON_BODY_TYPES } from '../utils/ndjsonBodyTypes';

const MARKER = 'AUDIT-LEAK-MARKER-4a91c7';
/**
 * A SECOND marker, in the board's own metadata rather than the reporter's
 * payload. It must APPEAR in the audit: §6.5.3 says the plane carries
 * identities and refuses bodies, so a suite that only proved absence would
 * pass just as well against an audit that recorded nothing at all.
 */
const IDENTITY_MARKER = 'AUDIT-IDENTITY-MARKER-8c02be';

const db = {
  statements: [] as Array<{ text: string; params: unknown[] }>,
  connectors: new Set<string>(),
  descriptor: null as null | { tier: string; products?: string[] },
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
        return { rows: [{ last_accepted_at: new Date().toISOString() }], rowCount: 1 };
      }
      if (/INSERT INTO session_quarantine/.test(text)) {
        return { rows: [{ quarantine_id: 'q-1', occurrence_count: 1 }], rowCount: 1 };
      }
      if (/INSERT INTO session_events/.test(text)) {
        return { rows: [{ event_id: 'evt-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));

const auditCalls: unknown[][] = [];
jest.mock('../services/AuditService', () => ({
  auditService: {
    record: async (...args: unknown[]) => {
      auditCalls.push(args);
      return { id: 'audit-1' };
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const telemetryRouter = require('../routes/telemetry').default;

const ACCOUNT = '00000000-0000-4000-8000-00000000acc7';
const AGENT = '00000000-0000-4000-8000-00000000a63n';

const link = (principalId: string, kind: string, parent: string | null) => ({
  principalId, kind, role: null, parentPrincipalId: parent,
  boundTaskId: null, legacyIdentity: false, ownExpression: null,
});

/**
 * A direct `Account → Agent` chain: §4.1's fourth acceptance test, and the ONE
 * telemetry path that writes to the audit plane at all.
 */
const DIRECT_ACCOUNT_AGENT = [link(AGENT, 'agent', ACCOUNT), link(ACCOUNT, 'human', null)];

/** Every position a reporter controls, each carrying the marker. */
function poisoned() {
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    event_id: `evt-${MARKER}`,
    kind: 'model_call',
    stream_generation: MARKER,
    source: { product: MARKER, adapter: MARKER, instance_ref: MARKER },
    identity: { email: `${MARKER}@example.test`, human: MARKER },
    outcome: { error_message: MARKER, error_type: MARKER },
    attributes: { [MARKER]: MARKER },
    correlation: { conversation_id: MARKER },
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
    (req as unknown as Record<string, unknown>).principal = { id: AGENT, handle: `agent-${IDENTITY_MARKER}` };
    (req as unknown as Record<string, unknown>).delegationLinks = DIRECT_ACCOUNT_AGENT;
    (req as unknown as Record<string, unknown>).authMethod = 'principal_api_key';
    (req as unknown as Record<string, unknown>).credentialId = 'cred-1';
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
  auditCalls.length = 0;
  db.statements.length = 0;
  db.descriptor = { tier: 'full', products: [MARKER] };
});

/** Everything the route handed the audit plane, as one searchable string. */
const auditedText = () => JSON.stringify(auditCalls);

describe('§6.5.3 · the audit plane is metadata-only', () => {
  it('audits the §4.1 refusal on /telemetry/events — the POSITIVE control', async () => {
    // Without this, "the marker is absent" would be true of zero audit calls.
    const res = await fetch(`${base}/telemetry/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(poisoned()),
    });
    expect(res.status).toBe(403);
    expect(auditCalls).toHaveLength(1);
    expect(auditedText()).toContain('telemetry.envelope.refused');
  });

  it('carries NO byte the reporter chose — body, product, adapter, identity or attributes', async () => {
    await fetch(`${base}/telemetry/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(poisoned()),
    });
    expect(auditCalls).toHaveLength(1);
    expect(auditedText()).not.toContain(MARKER);
  });

  it('carries no payload bytes on the BATCH surface either', async () => {
    const line = JSON.stringify(poisoned());
    const res = await fetch(`${base}/telemetry/events/batch`, {
      method: 'POST',
      headers: { 'content-type': NDJSON_BODY_TYPES[0] },
      body: `${line}\n${line}`,
    });
    expect(res.status).toBe(403);
    expect(auditCalls).toHaveLength(1);
    expect(auditedText()).toContain('telemetry.envelope.refused');
    expect(auditedText()).not.toContain(MARKER);
  });

  it('DOES carry the identity — the control that keeps the absence meaningful', async () => {
    await fetch(`${base}/telemetry/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(poisoned()),
    });
    expect(auditedText()).toContain(IDENTITY_MARKER);
    expect(auditedText()).not.toContain(MARKER);
  });

  it('records the metadata it IS for — the code, the surface and the identifiers', async () => {
    // The absence above must not be achieved by auditing nothing useful.
    await fetch(`${base}/telemetry/events/batch`, {
      method: 'POST',
      headers: { 'content-type': NDJSON_BODY_TYPES[0] },
      body: JSON.stringify(poisoned()),
    });
    const [[entry]] = auditCalls as Array<[Record<string, unknown>]>;
    const metadata = entry.metadata as Record<string, unknown>;
    expect(entry.action).toBe('telemetry.envelope.refused');
    expect(entry.outcome).toBe('denied');
    expect(metadata.code).toBe('TELEMETRY_PRINCIPAL_NO_CONNECTOR');
    expect(metadata.surface).toBe('events_batch');
    expect((entry.actor as Record<string, unknown>).principalId).toBe(AGENT);
  });

  it('every audited VALUE is a metadata shape, not free text', async () => {
    // The marker control catches bytes this request supplied. This one catches
    // the shape of what is passed at all: identifiers, codes, verbs and flags —
    // nothing long enough or free-form enough to be a body.
    await fetch(`${base}/telemetry/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(poisoned()),
    });
    const [[entry]] = auditCalls as Array<[Record<string, unknown>]>;
    const scalars: unknown[] = [];
    const walk = (value: unknown) => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (typeof value === 'object') { Object.values(value).forEach(walk); return; }
      scalars.push(value);
    };
    walk(entry);
    for (const scalar of scalars) {
      if (typeof scalar !== 'string') continue;
      expect(scalar.length).toBeLessThanOrEqual(96);
      expect(scalar).not.toMatch(/\s{2,}/);
    }
  });
});
