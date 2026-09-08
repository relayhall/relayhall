/**
 * c2WebhookDelivery.test.ts — RH-P3.C2: the delivery contract, TWO PLANES.
 *
 * Drives the REAL WebhookDeliveryWorker and the REAL WebhookService (payload
 * and signature are the implementations under test, never stubs). Faked only
 * at the boundaries the deployment does not own: postgres and the receiving
 * HTTP endpoint.
 *
 * Every test states the failure it exists to catch. Tests tagged `pre-review`,
 * `review r1` or `review r2` defend a defect that actually shipped and was
 * caught — those are the places this candidate has already proven fragile.
 *
 * ── The model under test (owner ruling ccd53781) ──
 *
 *   WORK plane · per ASSIGNEE, from the registry. A Connector configured
 *     `delivery_mode='webhook'` with an endpoint and a secret is delivered
 *     `task.ready` doorbells for the tasks assigned to it. No subscription row
 *     exists or is consulted. THIS IS THE B1 REPAIR: the previous cut began
 *     its due-set from `webhooks` rows, so this configuration — the one
 *     §2.6.4 actually describes — delivered nothing at all.
 *   OBSERVATION plane · per SUBSCRIPTION, endpoint still from the registry.
 *     Event-class filters only, never a go signal, never a URL of its own.
 */
import crypto from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebhookDeliveryWorker, DEFAULT_DELIVERY_CONFIG } from '../services/WebhookDeliveryWorker';
import { WebhookService, type WebhookSubscriptionRow } from '../services/WebhookService';

const SUB_ID = '33333333-3333-4333-8333-333333333333';
const SUB_ID_B = '77777777-7777-4777-8777-777777777777';
const SUBSCRIBER = '44444444-4444-4444-8444-444444444444';
const CREDENTIAL = '88888888-8888-4888-8888-888888888888';
const CHILD = '66666666-6666-4666-8666-666666666666';
const OTHER = '55555555-5555-4555-8555-555555555555';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const TASK_OTHER = '2a2a2a2a-2222-4222-8222-222222222222';
const SERVICE_ID = '99999999-9999-4999-8999-999999999999';

const ENDPOINT = 'https://connector.example/hook';
const SECRET = 'topsecret';

function subscription(over: Partial<WebhookSubscriptionRow> = {}): WebhookSubscriptionRow {
  return {
    id: SUB_ID, url: null, secret: null,
    events: ['task.created', 'task.updated'], active: true, description: null,
    subscriber_principal_id: SUBSCRIBER, subscriber_credential_id: CREDENTIAL,
    delivery_cursor: '10', consecutive_failures: 0,
    created_at: '2026-08-24T00:00:00.000Z', last_delivery_at: null,
    last_delivery_status: null, last_delivery_error: null, ...over,
  };
}

function connectorState(over: Record<string, unknown> = {}) {
  return {
    service_id: SERVICE_ID, principal_id: SUBSCRIBER,
    delivery_endpoint: ENDPOINT, delivery_secret: SECRET,
    delivery_cursor: '10', consecutive_failures: 0, ...over,
  };
}

function feedEvent(over: Record<string, unknown> = {}) {
  return {
    cursor: '11', name: 'task.created', objectType: 'task', objectId: TASK_ID,
    occurredAt: '2026-08-24T00:00:00.000Z', actorPrincipalId: OTHER,
    actorHandle: 'someone', projectId: null, ownerPrincipalId: null, payload: {}, ...over,
  };
}

const readyEvent = (over: Record<string, unknown> = {}) =>
  feedEvent({ name: 'task.ready', cursor: '12', ...over });

/**
 * A pool that records every statement and answers both planes.
 *
 * `connectors` drives the WORK plane's registry-first due-set; `subs` drives
 * the OBSERVATION plane. Either may be empty — which is how a
 * registry-only estate (no subscription rows anywhere) is expressed.
 */
function makePool(opts: {
  subs?: WebhookSubscriptionRow[];
  connectors?: Array<ReturnType<typeof connectorState>>;
  rateSlot?: boolean;
  registry?: { delivery_mode: string; delivery_endpoint: string | null; delivery_secret: string | null } | null;
  assignedTaskIds?: string[];
} = {}) {
  const subs = opts.subs ?? [];
  const connectors = opts.connectors ?? [];
  const statements: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    statements.push({ sql, params });
    const text = String(sql);

    // ── work plane ──
    if (text.includes('INSERT INTO connector_delivery_state')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM connector_delivery_state st')) {
      return { rows: connectors.map((c) => ({ service_id: c.service_id })), rowCount: connectors.length };
    }
    if (text.includes('UPDATE connector_delivery_state st')) {
      return { rows: connectors, rowCount: connectors.length };
    }
    if (text.includes('FROM tasks')) {
      const assigned = opts.assignedTaskIds ?? [TASK_ID];
      const asked: string[] = params[0] ?? [];
      const rows = asked.filter((id) => assigned.includes(id)).map((id) => ({ id }));
      return { rows, rowCount: rows.length };
    }

    // ── observation plane ──
    if (text.includes('FROM webhooks') && text.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: subs.map((s) => ({ id: s.id })), rowCount: subs.length };
    }
    if (text.includes('UPDATE webhooks') && text.includes('next_attempt_at = NOW() + ')) {
      return { rows: subs, rowCount: subs.length };
    }

    // ── shared ──
    if (text.includes('FROM services')) {
      const registry = opts.registry === undefined
        ? { delivery_mode: 'webhook', delivery_endpoint: ENDPOINT, delivery_secret: SECRET }
        : opts.registry;
      return { rows: registry ? [registry] : [], rowCount: registry ? 1 : 0 };
    }
    if (text.includes('webhook_delivery_rate') && text.includes('INSERT')) {
      const ok = opts.rateSlot !== false;
      return { rows: ok ? [{ subscriber_principal_id: SUBSCRIBER }] : [], rowCount: ok ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    pool: { query, connect: async () => ({ query, release: () => undefined }) } as any,
    statements,
  };
}

function makeWorker(pool: any, events: any[], opts: {
  nextCursor?: string; actorOk?: boolean; refusal?: any;
  actorScopes?: string[]; causal?: string[];
  config?: Partial<typeof DEFAULT_DELIVERY_CONFIG>;
} = {}) {
  const feed = { listSince: jest.fn(async () => ({ events, nextCursor: opts.nextCursor ?? '20' })) } as any;
  const actorResult = () => (opts.actorOk === false
    ? { ok: false, refusal: opts.refusal ?? 'SUBSCRIBER_CHAIN_DEAD' }
    : {
      ok: true,
      credentialId: CREDENTIAL,
      actor: {
        principalId: SUBSCRIBER, handle: 'sub', role: 'service',
        scopes: opts.actorScopes ?? ['tasks:read'], authenticated: true, delegation: null,
      },
    });
  const subscribers = {
    actorFor: jest.fn(async () => actorResult()),
    actorForConnector: jest.fn(async () => actorResult()),
    causalSubtree: jest.fn(async () => new Set<string>(opts.causal ?? [SUBSCRIBER])),
  } as any;
  const worker = new WebhookDeliveryWorker(
    pool, { ...DEFAULT_DELIVERY_CONFIG, ...(opts.config ?? {}) },
    { feed, subscribers, webhooks: new WebhookService() },
  );
  return { worker, feed, subscribers };
}

function capture() {
  const sent: any[] = [];
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    sent.push({ url, init }); return { ok: true, status: 200 } as any;
  });
  return sent;
}

afterEach(() => { delete (global as any).fetch; jest.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────
describe('C2 WORK plane: registry configuration alone delivers (review r2, B1)', () => {
  /**
   * THE round-2 regression, in the reviewer's own terms.
   *
   * "root configures a published Connector's canonical registry row as
   * delivery_mode='webhook' with delivery_endpoint='https://connector.example/hook',
   * but no separate `webhooks` row exists. Every pass selects zero due rows,
   * never queries `services`, and sends nothing."
   *
   * Here there is deliberately NO subscription anywhere in the estate — the
   * observation plane is empty — and the doorbell must still arrive.
   */
  test('a webhook-mode Connector with NO subscription row is delivered its assigned task.ready', async () => {
    const { pool, statements } = makePool({ subs: [], connectors: [connectorState()] });
    const { worker } = makeWorker(pool, [readyEvent()]);
    const sent = capture();

    const result = await worker.runPass();

    expect(result.subscriptionsExamined).toBe(0);      // the old due-set is empty…
    expect(result.connectorsExamined).toBe(1);         // …and the registry one is not
    expect(result.workDeliveries).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(ENDPOINT);

    // The statement the previous cut never issued.
    expect(statements.some((s) => s.sql.includes('FROM connector_delivery_state st'))).toBe(true);

    const body = JSON.parse(sent[0].init.body);
    expect(body.plane).toBe('work');
    expect(body.channelId).toBe(SERVICE_ID);
    expect(body.events.map((e: any) => e.name)).toEqual(['task.ready']);
  });

  test('the doorbell is signed with the REGISTRY secret, over the exact transmitted bytes', async () => {
    const { pool } = makePool({ connectors: [connectorState()] });
    const { worker } = makeWorker(pool, [readyEvent()]);
    const sent = capture();
    await worker.runPass();

    const body = sent[0].init.body;
    const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(sent[0].init.headers['X-RelayHall-Signature']).toBe(expected);
    expect(sent[0].init.headers['X-RelayHall-Plane']).toBe('work');
    expect(sent[0].init.headers['X-RelayHall-Channel-Id']).toBe(SERVICE_ID);
  });

  /**
   * `poll` and `none` are not errors and not failures — a poll-mode Connector
   * pulls "my ready tasks" on its own cron (§2.6.4). They are simply never in
   * the due-set, which is asserted by the SQL rather than by a runtime branch:
   * a mode filter that lived in JavaScript would still wake every Connector.
   */
  test('only published webhook-mode Connectors are ever claimed', async () => {
    const { pool, statements } = makePool({ connectors: [connectorState()] });
    const { worker } = makeWorker(pool, []);
    capture();
    await worker.runPass();

    const claim = statements.find((s) => s.sql.includes('FOR UPDATE OF st SKIP LOCKED'))!;
    expect(claim.sql).toContain("s.delivery_mode = 'webhook'");
    expect(claim.sql).toContain("s.status = 'published'");
    expect(claim.sql).toContain("s.kind = 'connector'");
    expect(claim.sql).toContain('FOR UPDATE OF st SKIP LOCKED');
  });

  /**
   * R2/B7's delivery-side consequence: a go signal reaches the ASSIGNEE, not
   * whoever happens to be listening. The filter is evaluated at delivery time
   * against the CURRENT assignment.
   */
  test('a task.ready for a task assigned elsewhere is NOT delivered', async () => {
    const { pool } = makePool({
      connectors: [connectorState()],
      assignedTaskIds: [],                       // this Connector is assigned nothing
    });
    const { worker } = makeWorker(pool, [readyEvent()]);
    const sent = capture();
    const result = await worker.runPass();

    expect(result.workDeliveries).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test('a mixed batch delivers only the tasks assigned to THIS Connector', async () => {
    const { pool } = makePool({
      connectors: [connectorState()],
      assignedTaskIds: [TASK_ID],
    });
    const { worker } = makeWorker(pool, [
      readyEvent({ cursor: '12', objectId: TASK_ID }),
      readyEvent({ cursor: '13', objectId: TASK_OTHER }),
    ]);
    const sent = capture();
    await worker.runPass();

    const body = JSON.parse(sent[0].init.body);
    expect(body.events.map((e: any) => e.objectId)).toEqual([TASK_ID]);
  });

  /**
   * The work plane carries GO SIGNALS and nothing else: everything a
   * Connector merely wants to watch is observation, and mixing the two would
   * make a doorbell indistinguishable from a notification.
   */
  test('ordinary lifecycle events are not work deliveries', async () => {
    const { pool } = makePool({ connectors: [connectorState()] });
    const { worker } = makeWorker(pool, [feedEvent({ name: 'task.updated' })]);
    const sent = capture();
    const result = await worker.runPass();
    expect(result.workDeliveries).toBe(0);
    expect(sent).toHaveLength(0);
  });

  /**
   * §2.6.4: "chains advance by construction … the next assignee's task.ready
   * fires through ITS OWN delivery mode". When the next assignee is the same
   * Connector that just completed the parent, the causing actor IS the
   * addressee — so the observation plane's causation guard must NOT apply
   * here, or every single-assignee chain stalls.
   */
  test('a Connector still receives a doorbell it caused itself (chains advance by construction)', async () => {
    const { pool } = makePool({ connectors: [connectorState()] });
    const { worker } = makeWorker(
      pool,
      [readyEvent({ actorPrincipalId: SUBSCRIBER })],   // caused by the addressee
      { causal: [SUBSCRIBER] },
    );
    const sent = capture();
    const result = await worker.runPass();
    expect(result.workDeliveries).toBe(1);
    expect(sent).toHaveLength(1);
  });

  test('an unusable assignee credential withholds delivery and records the reason', async () => {
    const { pool, statements } = makePool({ connectors: [connectorState()] });
    const { worker } = makeWorker(pool, [readyEvent()], {
      actorOk: false, refusal: 'SUBSCRIBER_TRANSPORT_MISMATCH',
    });
    const sent = capture();
    const result = await worker.runPass();

    expect(result.refusedSubscribers).toBe(1);
    expect(sent).toHaveLength(0);
    const failure = statements.find((s) => s.sql.includes('UPDATE connector_delivery_state')
      && s.sql.includes('consecutive_failures = $2'));
    expect(failure?.params).toContain('SUBSCRIBER_TRANSPORT_MISMATCH');
  });

  test('an assignee whose scopes cannot clear the pull ceiling receives nothing', async () => {
    const { pool } = makePool({ connectors: [connectorState()] });
    const { worker } = makeWorker(pool, [readyEvent()], { actorScopes: ['reports:read'] });
    const sent = capture();
    const result = await worker.runPass();
    expect(result.refusedSubscribers).toBe(1);
    expect(sent).toHaveLength(0);
  });

  test('the work cursor advances only on success, and never past the examined window', async () => {
    const { pool, statements } = makePool({ connectors: [connectorState()] });
    const { worker } = makeWorker(pool, [readyEvent()], { nextCursor: '20' });
    capture();
    await worker.runPass();

    const settle = statements.find((s) => s.sql.includes('UPDATE connector_delivery_state')
      && s.sql.includes('delivery_cursor = GREATEST'));
    expect(settle?.params[1]).toBe('20');
  });

  test('a failed POST leaves the work cursor UNMOVED so the batch is retried', async () => {
    const { pool, statements } = makePool({ connectors: [connectorState()] });
    const { worker } = makeWorker(pool, [readyEvent()]);
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 503 } as any));

    const result = await worker.runPass();
    expect(result.failures).toBe(1);
    expect(statements.some((s) => s.sql.includes('UPDATE connector_delivery_state')
      && s.sql.includes('delivery_cursor = GREATEST'))).toBe(false);
  });

  test('a first-seen Connector starts at the feed HEAD, never at cursor zero', async () => {
    const { pool, statements } = makePool({ connectors: [] });
    const { worker } = makeWorker(pool, []);
    capture();
    await worker.runPass();

    const seed = statements.find((s) => s.sql.includes('INSERT INTO connector_delivery_state'));
    expect(seed).toBeDefined();
    expect(seed!.sql).toContain('SELECT COALESCE(MAX(cursor), 0) FROM feed_events');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('C2 OBSERVATION plane: filters only, endpoint from the registry', () => {
  test('the endpoint comes from the registry, never from the subscription', async () => {
    const { pool } = makePool({
      subs: [subscription()],
      registry: { delivery_mode: 'webhook', delivery_endpoint: ENDPOINT, delivery_secret: SECRET },
    });
    const { worker } = makeWorker(pool, [feedEvent()]);
    const sent = capture();
    await worker.runPass();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(ENDPOINT);
    const body = JSON.parse(sent[0].init.body);
    expect(body.plane).toBe('observation');
    expect(body.channelId).toBe(SUB_ID);
  });

  /**
   * The single-source rule, asserted where it can actually be violated: even
   * with a stale URL still on the row (as the deactivated pre-C2 rows carry),
   * nothing may be sent there.
   */
  test('a legacy url on the row is never used as a delivery target', async () => {
    const { pool } = makePool({
      subs: [subscription({ url: 'https://attacker.example/steal' })],
    });
    const { worker } = makeWorker(pool, [feedEvent()]);
    const sent = capture();
    await worker.runPass();
    expect(sent[0].url).toBe(ENDPOINT);
    expect(sent.some((s) => String(s.url).includes('attacker'))).toBe(false);
  });

  /**
   * Live-QA finding Q1: the estate's own Connector is `draft`, and requiring
   * publication here made a subscription the route had just accepted
   * undeliverable — with no error the operator would ever see, because the
   * refusal lands on the subscription row rather than the create response.
   */
  test('a DRAFT Connector still receives its observations (live-QA Q1)', async () => {
    const { pool } = makePool({
      subs: [subscription()],
      registry: { delivery_mode: 'webhook', delivery_endpoint: ENDPOINT, delivery_secret: SECRET },
    });
    const { worker } = makeWorker(pool, [feedEvent()]);
    const sent = capture();
    const result = await worker.runPass();
    expect(result.observationDeliveries).toBe(1);
    expect(sent).toHaveLength(1);
  });

  test('the observation registry lookup does not filter on registration status', async () => {
    const { pool, statements } = makePool({ subs: [subscription()] });
    const { worker } = makeWorker(pool, [feedEvent()]);
    capture();
    await worker.runPass();
    const lookup = statements.find((s) => s.sql.includes('FROM services')
      && s.sql.includes('delivery_secret'))!;
    expect(lookup.sql).toContain("kind = 'connector'");
    expect(lookup.sql).not.toContain("status = 'published'");
  });

  test('a subscriber with no registry row is refused, not delivered', async () => {
    const { pool } = makePool({ subs: [subscription()], registry: null });
    const { worker } = makeWorker(pool, [feedEvent()]);
    const sent = capture();
    const result = await worker.runPass();
    expect(result.refusedSubscribers).toBe(1);
    expect(sent).toHaveLength(0);
  });

  test.each(['poll', 'none'])('registry mode %s withholds without failing or moving the cursor', async (mode) => {
    const { pool, statements } = makePool({
      subs: [subscription()],
      registry: { delivery_mode: mode, delivery_endpoint: null, delivery_secret: null },
    });
    const { worker } = makeWorker(pool, [feedEvent()]);
    const sent = capture();
    const result = await worker.runPass();

    expect(result.registryWithheld).toBe(1);
    expect(result.failures).toBe(0);
    expect(sent).toHaveLength(0);
    expect(statements.some((s) => s.sql.includes('delivery_cursor = GREATEST'))).toBe(false);
  });

  /**
   * R1: "Observation delivery never carries go-signal or claim semantics."
   * Unrepresentable in the table and refused at registration — and refused a
   * third time here, because a row that reaches the table another way must
   * still not turn this plane into a work-delivery path.
   */
  test('a go signal is never delivered on the observation plane, even if the row asks for it', async () => {
    const { pool } = makePool({
      subs: [subscription({ events: ['task.created', 'task.ready'] })],
    });
    const { worker } = makeWorker(pool, [readyEvent(), feedEvent({ cursor: '13' })]);
    const sent = capture();
    await worker.runPass();

    const body = JSON.parse(sent[0].init.body);
    expect(body.events.map((e: any) => e.name)).toEqual(['task.created']);
  });

  test('an event the subscription did not register is not delivered', async () => {
    const { pool } = makePool({ subs: [subscription({ events: ['report.created'] })] });
    const { worker } = makeWorker(pool, [feedEvent()]);
    const sent = capture();
    const result = await worker.runPass();
    expect(result.observationDeliveries).toBe(0);
    expect(sent).toHaveLength(0);
  });

  /** review r1, B4 — the guard walks the subscriber's DESCENDANT subtree. */
  test("a subscriber is not told about its own child's write", async () => {
    const { pool } = makePool({ subs: [subscription()] });
    const { worker } = makeWorker(
      pool, [feedEvent({ actorPrincipalId: CHILD })], { causal: [SUBSCRIBER, CHILD] },
    );
    const sent = capture();
    const result = await worker.runPass();
    expect(result.observationDeliveries).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test('an unattributed event is still delivered, so the rate cap is load-bearing', async () => {
    const { pool } = makePool({ subs: [subscription()] });
    const { worker } = makeWorker(pool, [feedEvent({ actorPrincipalId: null })]);
    const sent = capture();
    const result = await worker.runPass();
    expect(result.observationDeliveries).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('C2 loop guards hold across BOTH planes', () => {
  /**
   * review r1, B5: the window is keyed by the SUBSCRIBER PRINCIPAL, so N
   * channels do not multiply the ceiling by N. With the work plane added,
   * that now spans planes too — a Connector's doorbells and its observations
   * share one budget.
   */
  test('the rate window is keyed by the subscriber principal, not by the channel', async () => {
    const { pool, statements } = makePool({
      subs: [subscription({ id: SUB_ID }), subscription({ id: SUB_ID_B })],
    });
    const { worker } = makeWorker(pool, [feedEvent()]);
    capture();
    await worker.runPass();

    const claims = statements.filter((s) => s.sql.includes('webhook_delivery_rate') && s.sql.includes('INSERT'));
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) expect(claim.params[0]).toBe(SUBSCRIBER);
  });

  test('the rate claim is ONE conditional statement, so it holds across replicas', async () => {
    const { pool, statements } = makePool({ subs: [subscription()] });
    const { worker } = makeWorker(pool, [feedEvent()]);
    capture();
    await worker.runPass();

    const claim = statements.find((s) => s.sql.includes('webhook_delivery_rate') && s.sql.includes('INSERT'))!;
    expect(claim.sql).toContain('ON CONFLICT (subscriber_principal_id) DO UPDATE');
    expect(claim.sql).toContain('WHERE webhook_delivery_rate.window_started_at');
    expect(claim.sql).toContain('RETURNING subscriber_principal_id');
  });

  test('a full window defers WITHOUT advancing either cursor', async () => {
    const { pool, statements } = makePool({
      subs: [subscription()], connectors: [connectorState()], rateSlot: false,
    });
    const { worker } = makeWorker(pool, [readyEvent(), feedEvent({ cursor: '13' })]);
    const sent = capture();
    const result = await worker.runPass();

    expect(result.rateLimited).toBe(2);          // once per plane
    expect(sent).toHaveLength(0);
    expect(statements.some((s) => s.sql.includes('delivery_cursor = GREATEST'))).toBe(false);
  });

  test('the event cap bounds amplification, not just the POST count', () => {
    // A POST cap alone permits batchSize events per POST; the event cap is
    // what actually bounds a self-driving subscriber.
    expect(DEFAULT_DELIVERY_CONFIG.rateLimitEventsPerWindow).toBeGreaterThan(0);
    expect(DEFAULT_DELIVERY_CONFIG.rateLimitEventsPerWindow)
      .toBeLessThan(DEFAULT_DELIVERY_CONFIG.rateLimitPerWindow * DEFAULT_DELIVERY_CONFIG.batchSize);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('C2 delivery invariants that must not regress', () => {
  test('the payload is ID-only on both planes', async () => {
    const { pool } = makePool({ subs: [subscription()], connectors: [connectorState()] });
    const { worker } = makeWorker(pool, [readyEvent(), feedEvent({ cursor: '13' })]);
    const sent = capture();
    await worker.runPass();

    expect(sent.length).toBe(2);
    for (const message of sent) {
      const body = JSON.parse(message.init.body);
      for (const event of body.events) {
        expect(Object.keys(event).sort())
          .toEqual(['cursor', 'name', 'objectId', 'objectType', 'occurredAt']);
      }
    }
  });

  test('cursors are validated to the EXACT emitted encoding', async () => {
    const { pool, statements } = makePool({ subs: [subscription()] });
    const { worker } = makeWorker(pool, [feedEvent()], { nextCursor: '12abc' });
    capture();
    await worker.runPass();

    const settle = statements.find((s) => s.sql.includes('delivery_cursor = GREATEST'))!;
    // A permissive parse would have accepted '12abc' as 12 and silently moved
    // the channel's position (runbook §2 rejection class).
    expect(settle.params[1]).toBe('0');
  });

  test('a pass never overlaps itself', async () => {
    const { pool } = makePool({ subs: [subscription()] });
    const { worker } = makeWorker(pool, [feedEvent()]);
    capture();
    const [a, b] = await Promise.all([worker.runPass(), worker.runPass()]);
    const total = a.deliveries + b.deliveries;
    expect(total).toBe(1);
  });

  test('the worker contains no authorization logic of its own', () => {
    const source = readFileSync(join(__dirname, '..', 'services', 'WebhookDeliveryWorker.ts'), 'utf8');
    // Every authorization decision belongs to the ratified evaluator and the
    // shared acceptance predicate. A grants query here would be a second,
    // divergent authorization implementation.
    expect(source).not.toMatch(/FROM grants/);
    expect(source).not.toMatch(/scopesForRole/);
  });
});
