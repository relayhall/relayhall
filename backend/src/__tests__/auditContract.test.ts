import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { requiredScopeFor, MINTABLE_SCOPES } from '../utils/scopeMap';

jest.mock('../services/AuditService', () => ({
  auditService: { list: jest.fn() },
}));

import { auditService } from '../services/AuditService';
import auditRouter from '../routes/audit';

let server: http.Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/audit', auditRouter);
  server = app.listen(0, () => {
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});
beforeEach(() => {
  jest.clearAllMocks();
  (auditService.list as jest.Mock).mockResolvedValue({ events: [], nextCursor: null });
});

function get(route: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${route}`, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(text),
      }));
    }).on('error', reject);
  });
}

describe('audit read surface', () => {
  it('is protected by a live, mintable audit:read scope', () => {
    expect(requiredScopeFor('GET', '/audit')).toBe('audit:read');
    expect(MINTABLE_SCOPES).toContain('audit:read');
  });

  it('returns the declared indefinite/no-purge policy', async () => {
    const result = await get('/audit?limit=25&action=grant.create');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      success: true,
      retention: 'indefinite',
      purgeAvailable: false,
      events: [],
    });
    expect(auditService.list).toHaveBeenCalledWith(expect.objectContaining({
      limit: 25,
      action: 'grant.create',
    }));
  });

  it.each([
    '/audit?limit=0',
    '/audit?limit=201',
    '/audit?before=nope',
    '/audit?action=BAD',
    '/audit?surprise=1',
  ])('rejects malformed queries: %s', async (route) => {
    const result = await get(route);
    expect(result.status).toBe(400);
    expect(auditService.list).not.toHaveBeenCalled();
  });

  // Card 96aeacb7. AuditPage binds to THIS route, so the four ways it narrows
  // are part of the route's contract, validated by the same handler, gated by
  // the same `audit:read` rule pinned above. Nothing new is mounted.
  describe('the four filters the bound page reads with', () => {
    it('forwards every filter to the service, unaltered', async () => {
      const result = await get(
        '/audit?limit=25&actionPrefix=credential.&outcome=denied'
        + '&since=2026-09-01T00:00:00.000Z&until=2026-09-02T00:00:00.000Z',
      );
      expect(result.status).toBe(200);
      expect(auditService.list).toHaveBeenCalledWith(expect.objectContaining({
        limit: 25,
        actionPrefix: 'credential.',
        outcome: 'denied',
        since: '2026-09-01T00:00:00.000Z',
        until: '2026-09-02T00:00:00.000Z',
      }));
    });

    it.each([
      // A leap day that EXISTS, so the repair for P2 refuses bad calendars
      // rather than refusing February. And the three legal spellings of the
      // fractional second, since the component comparison has to agree with
      // the grammar rather than with one of its shapes.
      '2024-02-29T00:00:00Z',
      '2026-09-01T00:00:00Z',
      '2026-09-01T00:00:00.5Z',
      '2026-09-01T00:00:00.000Z',
      '2026-12-31T23:59:59.999Z',
    ])('accepts %s, which is a real instant', async (since) => {
      const result = await get(`/audit?since=${encodeURIComponent(since)}`);
      expect(result.status).toBe(200);
      expect(auditService.list).toHaveBeenCalledWith(expect.objectContaining({ since }));
    });

    it('accepts a prefix shorter than an action, which is the point of one', async () => {
      // `action` carries migration 087's three-character minimum. A PREFIX is
      // the head of an action, not an action, and `action=credential` (exact)
      // matches nothing at all.
      const result = await get('/audit?actionPrefix=g');
      expect(result.status).toBe(200);
      expect(auditService.list).toHaveBeenCalledWith(expect.objectContaining({ actionPrefix: 'g' }));
    });

    it.each([
      ['/audit?actionPrefix=', 'actionPrefix'],
      ['/audit?action=', 'action'],
      ['/audit?outcome=', 'outcome'],
      ['/audit?since=', 'since'],
    ])('treats an empty %s as no filter at all, as this route always has', async (route, field) => {
      const result = await get(route);
      expect(result.status).toBe(200);
      const [input] = (auditService.list as jest.Mock).mock.calls[0];
      expect(input[field]).toBeFalsy();
    });

    it.each([
      // A prefix admits the action alphabet and nothing else, so no pattern
      // character and no quote can reach the query builder.
      '/audit?actionPrefix=BAD',
      '/audit?actionPrefix=cred%25',
      "/audit?actionPrefix=a'b",
      '/audit?actionPrefix=.leading',
      // outcome is the ledger's own two-value enum.
      '/audit?outcome=maybe',
      '/audit?outcome=SUCCESS',
      // An instant is a UTC ISO-8601 instant, spelled the one way the ledger
      // emits one. A bare date or a local-time string means different moments
      // to different readers, on the surface whose job is to say when.
      '/audit?since=2026-09-01',
      '/audit?since=2026-09-01T00:00:00',
      '/audit?since=2026-09-01T00:00:00+02:00',
      '/audit?since=yesterday',
      '/audit?until=2026-13-01T00:00:00.000Z',
      // Round-1 review PRODUCTION P2. `Date.parse` does not reject these: V8
      // ROLLS them forward, so 30 February became 2 March and the caller was
      // answered 200 with rows from a day they did not ask about, while
      // docs/api.md promised a 400. Shape plus parseability is not validation
      // of a DATE.
      '/audit?since=2026-02-30T00:00:00.000Z',
      '/audit?until=2026-04-31T12:00:00Z',
      '/audit?since=2026-02-29T00:00:00Z',
      '/audit?since=2026-09-01T24:00:00Z',
      '/audit?since=2026-00-01T00:00:00Z',
      '/audit?since=2026-09-00T00:00:00Z',
      // An inverted or empty window is answerable with nothing, and answering
      // it that way teaches a person the ledger is empty when the question is
      // what is wrong.
      '/audit?since=2026-09-02T00:00:00.000Z&until=2026-09-01T00:00:00.000Z',
      '/audit?since=2026-09-01T00:00:00.000Z&until=2026-09-01T00:00:00.000Z',
    ])('rejects %s without reaching the ledger', async (route) => {
      const result = await get(route);
      expect(result.status).toBe(400);
      expect(auditService.list).not.toHaveBeenCalled();
    });
  });
});

describe('indefinite append-only migration contract', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../migrations/087_audit_events.sql'),
    'utf8',
  );

  it('has no retention or purge deletion path', () => {
    expect(sql).toContain('indefinite append-only audit ledger');
    expect(sql).not.toMatch(/DELETE\s+FROM\s+audit_events/i);
    expect(sql).not.toMatch(/DROP\s+TABLE\s+audit_events/i);
  });

  it('rejects update, delete and truncate even for trigger-replication roles', () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON audit_events/i);
    expect(sql).toMatch(/BEFORE TRUNCATE ON audit_events/i);
    expect(sql).toMatch(/ENABLE ALWAYS TRIGGER trg_audit_events_no_update_delete/i);
    expect(sql).toMatch(/ENABLE ALWAYS TRIGGER trg_audit_events_no_truncate/i);
  });
});

describe('required control-plane audit coverage', () => {
  const sources = [
    '../routes/auth.ts',
    '../routes/webhooks.ts',
    '../services/GrantService.ts',
    '../services/PrincipalService.ts',
    '../services/ServiceRegistry.ts',
    '../services/TaskManagerDB.ts',
  ].map((relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8')).join('\n');

  it.each([
    'auth.break_glass.login',
    'grant.create',
    'grant.revoke',
    'subscription.create',
    'subscription.update',
    'subscription.delete',
    'subscription.configuration.update',
    'credential.mint',
    'credential.revoke',
    'task.arm',
    'task.lifecycle_override.status',
    'task.lifecycle_override.force_release',
    'task.lifecycle_override.roles',
    // RH-P3.C3: one-click meltdown recovery (§2.6.4, C4).
    'task.lifecycle_override.recovery',
  ])('records %s', (action) => {
    expect(sources).toContain(`action: '${action}'`);
  });

  it('does not put webhook secrets or delivery endpoints in audit metadata', () => {
    const webhookSource = fs.readFileSync(path.join(__dirname, '../routes/webhooks.ts'), 'utf8');
    // Ruling ccd53781 R1: an observation subscription carries neither a URL
    // nor a secret, so the strongest statement available is that no statement
    // touching the table reads or writes either column — nothing to leak
    // beats nothing leaked. Asserted over the SQL itself rather than over the
    // prose, which legitimately explains where the endpoint DID move to.
    const sqlLiterals = webhookSource.match(/`[^`]*`/g) ?? [];
    const webhookStatements = sqlLiterals.filter(
      (sql) => /\bwebhooks\b/.test(sql) || /subscriber_principal_id/.test(sql),
    );
    expect(webhookStatements.length).toBeGreaterThan(0);
    for (const sql of webhookStatements) {
      expect(sql).not.toMatch(/\bsecret\b/);
      expect(sql).not.toMatch(/\burl\b/);
    }
    expect(webhookSource).not.toMatch(/metadata:\s*\{[^}]*\b(url|secret):/s);
    const serviceSource = fs.readFileSync(path.join(__dirname, '../services/ServiceRegistry.ts'), 'utf8');
    expect(serviceSource).toContain('deliveryEndpointChanged: input.deliveryEndpoint !== undefined');
    // The delivery secret moved to the registry with the endpoint; the audit
    // records the FACT of a change and never the value.
    expect(serviceSource).toContain('deliverySecretChanged: input.deliverySecret !== undefined');
    expect(serviceSource).not.toMatch(/metadata:\s*\{[^}]*deliveryEndpoint:/s);
    expect(serviceSource).not.toMatch(/metadata:\s*\{[^}]*deliverySecret:/s);
  });

  it('never returns a delivery secret from any registry read path', () => {
    const serviceSource = fs.readFileSync(path.join(__dirname, '../services/ServiceRegistry.ts'), 'utf8');
    // mapRow is the one projection every read goes through. It may report
    // WHETHER a secret is configured; it must never carry the value.
    const mapRow = serviceSource.slice(serviceSource.indexOf('function mapRow'));
    expect(mapRow).toContain('deliveryHasSecret: Boolean(row.delivery_secret)');
    expect(mapRow).not.toMatch(/deliverySecret:\s*row\.delivery_secret/);
  });
});
