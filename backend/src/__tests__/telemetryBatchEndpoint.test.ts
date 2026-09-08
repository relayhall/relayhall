/**
 * POST /telemetry/events/batch — the ratified home of canonical batch ingest
 * (owner decisions D2 and D11), driven for real.
 *
 * The wire format is design §3.1's: JSONL of full `rh.ai.telemetry/1.0`
 * records. What this suite pins is the behaviour a spool depends on — partial
 * success, one rate charge per BATCH, malformed lines quarantined without
 * their bytes, and the media type actually enforced.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import {
  NDJSON_BODY_TYPES,
  TELEMETRY_BATCH_MAX_RECORDS,
} from '../utils/ndjsonBodyTypes';

const db = {
  statements: [] as Array<{ text: string; params: unknown[] }>,
  connectors: new Set<string>(),
  descriptor: null as null | { tier: string; products?: string[] },
  rateLimits: new Map<string, number>(),
  /** Identity keys already stored, so a repeated record reads as a duplicate. */
  storedIdentities: new Set<string>(),
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
      if (/UPDATE telemetry_rate_limits/.test(text)) return { rows: [], rowCount: 0 };
      if (/DELETE FROM telemetry_rate_limits/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO session_quarantine/.test(text)) {
        return { rows: [{ quarantine_id: 'q-1', occurrence_count: 1 }], rowCount: 1 };
      }
      if (/INSERT INTO session_events/.test(text)) {
        // A repeat is a DUPLICATE, exactly as `ON CONFLICT (idempotency_key)
        // DO NOTHING` makes it. The key is the IDENTITY key the production
        // path computes (`rh.telemetry/1|<connector>|<product>|...`), not a
        // hash: `payload_hash` covers the receiver clock, so hashing would
        // have called two sends of the SAME record different from each other,
        // and `schema_version` is the same literal on every record, so keying
        // on that would have called two DIFFERENT records the same.
        const key = String((params ?? []).find(
          (p) => typeof p === 'string' && p.startsWith('rh.telemetry/1|')) ?? JSON.stringify(params));
        // The statement's final SELECT always returns ONE row; both columns are
        // NULL when the event lost its ON CONFLICT (review `d9697a35` F1).
        if (db.storedIdentities.has(key)) {
          return { rows: [{ event_id: null, raw_ref: null }], rowCount: 1 };
        }
        db.storedIdentities.add(key);
        const n = db.storedIdentities.size;
        return { rows: [{ event_id: `evt-${n}`, raw_ref: `rhraw/1:blob-${n}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));

const auditRecord = jest.fn(async (..._args: unknown[]) => ({ id: 'audit-1' }));
jest.mock('../services/AuditService', () => ({
  auditService: { record: (...args: unknown[]) => auditRecord(...(args as [])) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const telemetryRouter = require('../routes/telemetry').default;

const ACCOUNT = '00000000-0000-4000-8000-00000000acc7';
const CONNECTOR = '00000000-0000-4000-8000-0000000c0nn3';

const link = (principalId: string, kind: string, parent: string | null) => ({
  principalId, kind, role: null, parentPrincipalId: parent,
  boundTaskId: null, legacyIdentity: false, ownExpression: null,
});

const identity = {
  principalId: CONNECTOR as string | undefined,
  links: [link(CONNECTOR, 'service', ACCOUNT), link(ACCOUNT, 'human', null)],
};

let counter = 0;
function record(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    event_id: `evt-batch-${counter}`,
    kind: 'model_call',
    source: { product: 'claude-code', adapter: 'otlp' },
    ...overrides,
  };
}

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n');

let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeAll((done) => {
  process.env.RELAYHALL_TELEMETRY_PEPPERS = JSON.stringify({ t: Buffer.alloc(32, 5).toString('base64') });
  process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = 't';
  const app = express();
  // The SERVER's own JSON parser, so the batch route's text parser has to earn
  // its body rather than inherit one this test arranged for it.
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).principal = identity.principalId
      ? { id: identity.principalId, handle: 'outpost-1' } : undefined;
    (req as unknown as Record<string, unknown>).delegationLinks = identity.links;
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
  db.statements.length = 0;
  db.connectors = new Set([CONNECTOR]);
  db.descriptor = { tier: 'full', products: ['claude-code'] };
  db.rateLimits.clear();
  db.storedIdentities.clear();
  auditRecord.mockClear();
});

const send = async (body: string, contentType: string = NDJSON_BODY_TYPES[0]) => {
  const res = await fetch(`${base}/telemetry/events/batch`, {
    method: 'POST', headers: { 'content-type': contentType }, body,
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('§3.1 · the wire format is JSONL, and the media type is enforced', () => {
  it('accepts a batch of records, one per line', async () => {
    const { status, body } = await send(jsonl([record(), record(), record()]));
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, received: 3, accepted: 3, duplicates: 0, refused: 0 });
    expect((body.results as unknown[]).length).toBe(3);
  });

  it('ignores blank lines rather than calling them records', async () => {
    const { body } = await send(`\n${JSON.stringify(record())}\n\n${JSON.stringify(record())}\n\n`);
    expect(body).toMatchObject({ received: 2, accepted: 2 });
  });

  it('refuses a JSON body with 415 and says what it reads', async () => {
    const { status, body } = await send(JSON.stringify({ probe: true }), 'application/json');
    expect(status).toBe(415);
    expect(body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(body.acceptedTypes).toEqual([...NDJSON_BODY_TYPES]);
  });

  it('accepts the other spelling of the same format', async () => {
    const { status } = await send(jsonl([record()]), NDJSON_BODY_TYPES[1]);
    expect(status).toBe(200);
  });

  it('refuses an empty batch', async () => {
    const { status, body } = await send('   \n\n  ');
    expect(status).toBe(400);
    expect(body.code).toBe('EMPTY_BATCH');
  });

  it('refuses more records than the bound admits', async () => {
    const many = Array.from({ length: TELEMETRY_BATCH_MAX_RECORDS + 1 }, () => record());
    const { status, body } = await send(jsonl(many));
    expect(status).toBe(413);
    expect(body).toMatchObject({ code: 'BATCH_TOO_LARGE', maxRecords: TELEMETRY_BATCH_MAX_RECORDS });
  });
});

describe('partial success is the normal case', () => {
  it('one bad line does not discard the good ones', async () => {
    const good = record();
    const { status, body } = await send(`${JSON.stringify(good)}\nnot json at all\n${JSON.stringify(record())}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ received: 3, accepted: 2, refused: 1 });
    const results = body.results as Array<Record<string, unknown>>;
    expect(results[1]).toMatchObject({ accepted: false, code: 'INVALID_JSON_LINE' });
  });

  it('a repeated record is a DUPLICATE, not a refusal', async () => {
    const same = record();
    const { body } = await send(jsonl([same, same]));
    expect(body).toMatchObject({ received: 2, accepted: 1, duplicates: 1, refused: 0 });
  });

  it('an undeclared product is refused and NOT quarantined', async () => {
    // It may be a perfectly well-formed record; it is the deployment's own
    // declaration that refused it, and quarantining that would let a
    // descriptor fill the plane.
    const { body } = await send(jsonl([record({ source: { product: 'other-tool', adapter: 'otlp' } })]));
    expect(body).toMatchObject({ refused: 1, accepted: 0 });
    expect((body.results as Array<Record<string, unknown>>)[0].code).toBe('TELEMETRY_PRODUCT_NOT_DECLARED');
    expect(db.statements.some((s) => /INSERT INTO session_quarantine/.test(s.text))).toBe(false);
  });

  it('carries the accepted-majors advertisement when a major is rejected', async () => {
    const { body } = await send(jsonl([record({ schema_version: 'rh.ai.telemetry/9.0' })]));
    expect(body.refused).toBe(1);
    expect(body.acceptedMajors).toBeDefined();
  });
});

describe('§6.5.2 · a malformed line is quarantined, and its bytes are not', () => {
  const marker = 'BATCH-LINE-MARKER-71ce4d';

  it('quarantines the line without binding a byte of it', async () => {
    await send(`{"broken": "${marker}"`);
    const quarantine = db.statements.filter((s) => /INSERT INTO session_quarantine/.test(s.text));
    expect(quarantine).toHaveLength(1);
    const sent = `${quarantine[0].text} ${quarantine[0].params.map(String).join(' ')}`;
    expect(sent).not.toContain(marker);
  });

  it('does not echo the line back to the sender either', async () => {
    const { body } = await send(`{"broken": "${marker}"`);
    expect(JSON.stringify(body)).not.toContain(marker);
  });
});

describe('D6 · a batch is ONE request, charged once', () => {
  it('spends the receiver limit once for a hundred records', async () => {
    const many = Array.from({ length: 100 }, () => record());
    await send(jsonl(many));
    const gates = db.statements.filter((s) => /INSERT INTO telemetry_rate_limits/.test(s.text));
    expect(gates).toHaveLength(1);
  });

  it('charges the events_batch surface, not the single-event one', async () => {
    await send(jsonl([record()]));
    const gate = db.statements.find((s) => /INSERT INTO telemetry_rate_limits/.test(s.text));
    expect(gate?.params).toContain('events_batch');
    expect(gate?.params).not.toContain('events');
  });

  it('refuses a second batch inside the interval with 429 and Retry-After', async () => {
    await send(jsonl([record()]));
    const res = await fetch(`${base}/telemetry/events/batch`, {
      method: 'POST',
      headers: { 'content-type': NDJSON_BODY_TYPES[0] },
      body: jsonl([record()]),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect((await res.json() as Record<string, unknown>).code).toBe('RATE_LIMITED');
  });

  it('does not spend the limit when the principal is refused first', async () => {
    // Order matters: a caller that cannot report at all must not consume a
    // budget it was never entitled to.
    db.connectors = new Set();
    const { status } = await send(jsonl([record()]));
    expect(status).toBe(403);
    expect(db.statements.some((s) => /INSERT INTO telemetry_rate_limits/.test(s.text))).toBe(false);
    expect(auditRecord).toHaveBeenCalledTimes(1);
  });
});
