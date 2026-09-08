/**
 * c2WebhookSubscriptions.test.ts — RH-P3.C2: subscription CRUD on the
 * anti-beacon plane.
 *
 * A subscription names an identity to observe AS, so creating one is a
 * beacon-shaped act even after ruling ccd53781 took the URL away from it. The
 * plane is root-sentinel scoped (asserted in the census suite); what these
 * tests pin is that the route cannot mint a subscription that would deliver
 * unattributed, as an ephemeral Agent, or as an Account that holds no bearer
 * credential — that a subscription can no longer name an endpoint of its own
 * at all — and that every mutation is audited.
 *
 * ── After the ruling ──
 *
 * R1 · No URL and no secret on the row: the endpoint, the mode and the
 *      signing secret are the subscriber Connector's REGISTRY data. `url` and
 *      `secret` are not accepted by this route, which is asserted below
 *      through the route's own unknown-field rejection rather than by
 *      trusting the schema listing.
 * R1 · Go signals are not observable: `task.ready` is refused at
 *      registration, because it is delivered per-assignee by the work plane.
 * R3 · Subscribers are Connectors.
 */
import express, { Request } from 'express';

jest.mock('../db/connection', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));

import webhooksRoutes from '../routes/webhooks';
import { pool } from '../db/connection';
import { auditService } from '../services/AuditService';

const db = pool as jest.Mocked<typeof pool>;
const audit = auditService as jest.Mocked<typeof auditService>;

const SUBSCRIBER = '44444444-4444-4444-8444-444444444444';
const CREDENTIAL = '88888888-8888-4888-8888-888888888888';
const SUB_ID = '33333333-3333-4333-8333-333333333333';

/**
 * The row the route's joined principal+credential lookup returns.
 *
 * Since review r3 B2 the route ALSO runs the production actor derivation and
 * the `GET /events` route ceiling — the same two calls the delivery worker
 * makes — so a subscription that could never deliver cannot be created. Both
 * statements are answered by the one mocked pool, so this fixture carries the
 * union of the columns they select; the `credential_`-prefixed names are the
 * actor derivation's, the bare ones are the route's own.
 */
const VALID_HASH = 'a'.repeat(64);

function subscriberRow(over: Record<string, unknown> = {}) {
  return {
    // `principals.kind` is human|agent|service; the route derives
    // Connector-ness from a services row (A17.2) as is_connector.
    kind: 'service', is_connector: true, status: 'active',
    credential_id: CREDENTIAL, credential_principal_id: SUBSCRIBER,
    revoked_at: null, expires_at: null,
    // The full acceptance surface, judged by the SAME shared predicate the
    // worker and the auth middleware use (review r2 B2, r3 B3): addressable
    // key id and a digest a presented token could actually match.
    credential_type: 'api_key', key_id: 'c2subkey0001', secret_hash: VALID_HASH,
    grace_until: null, transport: 'any',
    subscriber_principal_id: SUBSCRIBER, subscriber_credential_id: CREDENTIAL,

    // ── what SubscriberActorService.actorFor selects ──
    id: SUBSCRIBER, handle: 'connector-sub', role: 'service',
    parent_principal_id: null, legacy_identity: false,
    credential_type_: undefined,
    credential_key_id: 'c2subkey0001', credential_secret_hash: VALID_HASH,
    credential_principal_id_: undefined,
    credential_scopes: ['tasks:read'],
    credential_revoked_at: null, credential_expires_at: null,
    credential_grace_until: null, credential_transport: 'any',
    ...over,
  };
}

/** House pattern: a real listening express app, driven over HTTP. */
async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    (req as any).principal = { id: 'root-id' };
    (req as any).userId = 'owner';
    next();
  });
  app.use('/webhooks', webhooksRoutes);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
}

async function post(base: string, body: unknown) {
  const res = await fetch(`${base}/webhooks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function get(base: string) {
  const res = await fetch(`${base}/webhooks`);
  return { status: res.status, body: (await res.json()) as any };
}

/** A transaction client that answers the INSERT/UPDATE with `row`. */
function txClient(row: any) {
  const query = jest.fn(async (sql: string) => {
    if (/INSERT INTO webhooks|UPDATE webhooks/.test(sql)) return { rows: [row], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { query, release: jest.fn() };
}

const createdRow = {
  id: SUB_ID, events: ['task.created'],
  active: true, description: null, subscriberPrincipalId: SUBSCRIBER,
  subscriberCredentialId: CREDENTIAL,
  deliveryCursor: '0', consecutiveFailures: 0, nextAttemptAt: null,
  created_at: '2026-08-24T00:00:00Z', last_delivery_at: null,
  last_delivery_status: null, last_delivery_error: null,
};

const VALID = {
  subscriberPrincipalId: SUBSCRIBER,
  // Delivery authority is derived from THIS credential's own scopes, exactly
  // as a real request is (review r1, B2) — so an active subscription must
  // name one.
  subscriberCredentialId: CREDENTIAL,
  events: ['task.created'],
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: the subscriber principal exists, is active, and is a Connector.
  (db.query as jest.Mock).mockResolvedValue({ rows: [subscriberRow()], rowCount: 1 });
  (db.connect as jest.Mock).mockResolvedValue(txClient(createdRow));
});

describe('C2 subscription creation refuses what cannot be delivered safely', () => {
  /**
   * Ruling ccd53781 R1, at the surface where it is easiest to violate: a
   * subscription cannot NAME an endpoint. Asserted through the route's own
   * unknown-field rejection, so it stays true if the schema is edited.
   */
  test.each(['url', 'secret'])('a subscription may not carry its own %s', async (field) => {
    await withServer(async (base) => {
      const response = await post(base, { ...VALID, [field]: 'https://attacker.example/steal' });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(db.connect).not.toHaveBeenCalled();
    });
  });

  /**
   * R1: the observation plane never carries go-signal semantics. task.ready
   * is delivered to the ASSIGNEE by the work plane; letting an observer
   * register it would hand a go signal to a party the work was not assigned
   * to — the premature-pickup failure arming exists to close.
   */
  test('a go signal cannot be registered as an observation', async () => {
    await withServer(async (base) => {
      const response = await post(base, { ...VALID, events: ['task.created', 'task.ready'] });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('GO_SIGNAL_NOT_OBSERVABLE');
      expect(String(response.body.error)).toMatch(/task\.ready/);
      expect(db.connect).not.toHaveBeenCalled();
    });
  });

  test('an unknown event name is still refused, and separately', async () => {
    await withServer(async (base) => {
      const response = await post(base, { ...VALID, events: ['task.exploded'] });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('UNKNOWN_EVENT');
    });
  });

  test('an active subscription without a subscriber principal is refused as unattributed', async () => {
    await withServer(async (base) => {
      const response = await post(base, { events: ['task.created'] });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('SUBSCRIPTION_UNATTRIBUTED');
      expect(db.connect).not.toHaveBeenCalled();
    });
  });

  /**
   * review r1 B2: without a credential the worker had nothing to derive from
   * and fell back to the principal's role MAXIMUM, which widened authority
   * past what the principal could actually pull.
   */
  test('an active subscription without a subscriber CREDENTIAL is refused', async () => {
    await withServer(async (base) => {
      const { subscriberCredentialId, ...withoutCredential } = VALID;
      const response = await post(base, withoutCredential);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('SUBSCRIPTION_UNATTRIBUTED');
      expect(db.connect).not.toHaveBeenCalled();
    });
  });

  test.each([
    ['a credential that does not exist', subscriberRow({ credential_id: null })],
    ['a revoked credential', subscriberRow({ revoked_at: '2026-08-01T00:00:00Z', credential_revoked_at: '2026-08-01T00:00:00Z' })],
    ['an expired credential', subscriberRow({ expires_at: '2026-08-01T00:00:00Z', credential_expires_at: '2026-08-01T00:00:00Z' })],
    ['a non-api_key credential', subscriberRow({ credential_type: 'password' })],
    ['a credential with no usable secret', subscriberRow({ secret_hash: null, credential_secret_hash: null })],
    ['a credential with an unaddressable key id (r3 B3)', subscriberRow({ key_id: null, credential_key_id: null })],
    ['a credential whose digest is not a SHA-256 hex value (r3 B3)', subscriberRow({ secret_hash: 'not-a-digest', credential_secret_hash: 'not-a-digest' })],
    ['a credential whose rotation grace has elapsed', subscriberRow({ grace_until: '2026-08-01T00:00:00Z', credential_grace_until: '2026-08-01T00:00:00Z' })],
    ['an mcp-pinned credential (refused the equivalent pull)', subscriberRow({ transport: 'mcp', credential_transport: 'mcp' })],
    // review r3, B2: the row is impeccable, but the credential's own scopes
    // cannot clear GET /events — so the subscription could never deliver and
    // must not be creatable.
    ['a credential that cannot clear the mirrored pull route (r3 B2)', subscriberRow({ credential_scopes: ['reports:read'] })],
    ["another principal's credential", subscriberRow({ credential_principal_id: '99999999-9999-4999-8999-999999999999' })],
  ])('%s is refused', async (_label, row) => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [row], rowCount: 1 });
    await withServer(async (base) => {
      const response = await post(base, VALID);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_SUBSCRIBER');
    });
  });

  /**
   * An Account cannot subscribe: it holds no bearer credential (4d961e37
   * A17.1) and acts through login sessions, so there is no non-interactive
   * pull authority for a delivery to mirror.
   */
  test('an Account principal is refused as a subscriber', async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [subscriberRow({ kind: 'human', is_connector: false })], rowCount: 1 });
    await withServer(async (base) => {
      const response = await post(base, VALID);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_SUBSCRIBER');
      expect(String(response.body.error)).toMatch(/Connector/);
    });
  });

  /**
   * Agents are task-bounded and die with their task (4d961e37 §5.2/§7.3). A
   * subscription bound to one would spend most of its life unable to deliver,
   * and its authority would be resurrected by whatever Agent held the id next.
   */
  test('an Agent principal is refused as a subscriber', async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [subscriberRow({ kind: 'agent', is_connector: false })], rowCount: 1 });
    await withServer(async (base) => {
      const response = await post(base, VALID);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_SUBSCRIBER');
      expect(String(response.body.error)).toMatch(/Agent/);
    });
  });

  test('a disabled subscriber principal is refused', async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [subscriberRow({ status: 'disabled' })], rowCount: 1 });
    await withServer(async (base) => {
      const response = await post(base, VALID);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_SUBSCRIBER');
    });
  });

  test('an unknown subscriber principal is refused', async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [], rowCount: 0 });
    await withServer(async (base) => {
      const response = await post(base, VALID);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_SUBSCRIBER');
    });
  });

  test('an unregistrable event name is refused, and the valid set is named in the hint', async () => {
    await withServer(async (base) => {
      const response = await post(base, {
        ...VALID, events: ['task.created', 'skill.version.published'],
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('UNKNOWN_EVENT');
      expect(JSON.stringify(response.body)).toContain('skill.version.published');
      // The hint names what a SUBSCRIPTION may register, so a go signal must
      // not appear in it — offering task.ready here would advertise exactly
      // the registration the next test proves is refused.
      expect(JSON.stringify(response.body)).toContain('task.created');
      expect(JSON.stringify(response.body)).not.toContain('task.ready');
    });
  });

  test('an INACTIVE subscription may be created without a subscriber — it cannot deliver', async () => {
    (db.connect as jest.Mock).mockResolvedValue(txClient({ ...createdRow, active: false }));
    await withServer(async (base) => {
      const response = await post(base, { events: ['task.created'], active: false });
      expect(response.status).toBe(201);
    });
  });

  /**
   * Live-QA finding: a new subscription started at cursor 0 and replayed the
   * entire retained feed before delivering anything current — 7,360 events on
   * DEV alone. A subscription starts at the HEAD; replay is opt-in.
   */
  test('a new subscription starts at the current feed head, not at zero', async () => {
    let insertSql = '';
    let insertParams: any[] = [];
    (db.connect as jest.Mock).mockResolvedValue({
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (/INSERT INTO webhooks/.test(sql)) {
          insertSql = String(sql); insertParams = params;
          return { rows: [createdRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    });
    await withServer(async (base) => {
      expect((await post(base, VALID)).status).toBe(201);
    });
    expect(insertSql).toContain('delivery_cursor');
    expect(insertSql).toContain('SELECT COALESCE(MAX(cursor), 0) FROM feed_events');
    // No explicit cursor was asked for, so the COALESCE falls through to the head.
    expect(insertParams[5]).toBeNull();
  });

  test('replay from an explicit cursor is opt-in and validated', async () => {
    let insertParams: any[] = [];
    (db.connect as jest.Mock).mockResolvedValue({
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (/INSERT INTO webhooks/.test(sql)) { insertParams = params; return { rows: [createdRow], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    });
    await withServer(async (base) => {
      expect((await post(base, { ...VALID, deliveryCursor: '0' })).status).toBe(201);
    });
    expect(insertParams[5]).toBe('0');

    await withServer(async (base) => {
      const bad = await post(base, { ...VALID, deliveryCursor: '12abc' });
      expect(bad.status).toBe(400);
    });
  });

  test('a valid subscription is created', async () => {
    await withServer(async (base) => {
      const response = await post(base, VALID);
      expect(response.status).toBe(201);
      expect(response.body.webhook.id).toBe(SUB_ID);
    });
  });
});

describe('C2 subscription mutations are audited', () => {
  test('creation records a subscription.create act naming the subscriber, never the secret', async () => {
    await withServer(async (base) => {
      const response = await post(base, VALID);
      expect(response.status).toBe(201);
      expect(audit.record).toHaveBeenCalledTimes(1);
      const [act] = (audit.record as jest.Mock).mock.calls[0];
      expect(act.action).toBe('subscription.create');
      expect(act.resourceType).toBe('subscription');
      expect(act.metadata.subscriberPrincipalId).toBe(SUBSCRIBER);
      expect(JSON.stringify(act)).not.toContain('s3cret');
    });
  });

  test('the delivery cursor is exposed so a subscriber can reconcile a dropped webhook', async () => {
    let listingSql = '';
    (db.query as jest.Mock).mockImplementation(async (sql: string) => {
      listingSql = String(sql);
      return { rows: [{ ...createdRow, deliveryCursor: '4211' }], rowCount: 1 };
    });
    await withServer(async (base) => {
      const response = await get(base);
      expect(response.status).toBe(200);
      // The reconciliation contract: the webhook is a hint, the feed is the
      // truth, and this is the position a subscriber pulls GET /events from.
      expect(response.body.webhooks[0].deliveryCursor).toBe('4211');
    });
    // Pin the PROJECTION, not just the echo: without this the route could
    // stop selecting the cursor and the test above would still pass, because
    // it only proves the handler returns whatever the pool handed it.
    expect(listingSql).toContain('delivery_cursor::text AS "deliveryCursor"');
    expect(listingSql).toContain('FROM webhooks');
  });

  /**
   * The property is that the secret VALUE never leaves — not that the
   * substring "secret" is absent, which would be false anyway: the projection
   * deliberately exposes `(secret IS NOT NULL) AS has_secret` so an operator
   * can see WHETHER a subscription is signable without seeing the key.
   */
  test('the listing projects neither a secret nor an endpoint (ruling ccd53781 R1)', async () => {
    const REAL_SECRET = 'super-secret-signing-key-value';
    let listingSql = '';
    (db.query as jest.Mock).mockImplementation(async (sql: string) => {
      listingSql = String(sql);
      // A realistic projected row: what the route's own SELECT would produce.
      // The deactivated pre-C2 rows still HOLD a url and a secret in the
      // table, which is exactly why the projection must not reach for them.
      return { rows: [createdRow], rowCount: 1 };
    });
    await withServer(async (base) => {
      const response = await get(base);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(REAL_SECRET);
      expect(response.body.webhooks[0]).not.toHaveProperty('url');
      expect(response.body.webhooks[0]).not.toHaveProperty('secret');
    });
    // Nothing to mask, because nothing is selected: the subscription simply
    // has no endpoint and no secret of its own any more.
    expect(listingSql).not.toMatch(/\bsecret\b/);
    expect(listingSql).not.toMatch(/\burl\b/);
  });

  /**
   * Pre-review F5: an empty string is NOT NULL, so a NULL-only CHECK left an
   * ACTIVE subscription that could never sign and therefore never deliver —
   * the invariant read as held while the subscription was quietly bricked.
   */
  /**
   * The PATCH surface must not become the back door the ruling closed on
   * POST: neither an endpoint of its own nor a go signal may be edited in.
   *
   * (The pre-review F5 concern — an ACTIVE subscription left unable to sign —
   * moved with the secret onto the registry, where the 101
   * `services_webhook_requires_signing` CHECK and the owner-plane validation
   * hold it. Asserted in c2WebhookEventCensus and serviceRegistry.)
   */
  test.each(['url', 'secret'])('PATCH may not introduce a %s either', async (field) => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/webhooks/${SUB_ID}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: 'https://attacker.example/steal' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).code).toBe('VALIDATION_FAILED');
    });
  });

  test('PATCH may not introduce a go signal', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/webhooks/${SUB_ID}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: ['task.ready'] }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).code).toBe('GO_SIGNAL_NOT_OBSERVABLE');
    });
  });
});
