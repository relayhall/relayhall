import { checkBody } from '../middleware/validate';
import { WebhookService } from '../services/WebhookService';
import { buildOpenApiSpec } from '../openapi/spec';

describe('validate middleware — checkBody', () => {
  const schema = {
    title: { type: 'string' as const, required: true, maxLen: 10 },
    priority: { type: 'string' as const, enum: ['low', 'normal', 'high'] as const },
    tags: { type: 'array' as const, itemsType: 'string' as const },
    active: { type: 'boolean' as const },
  };

  it('accepts a valid body', () => {
    expect(checkBody({ title: 'ok', priority: 'low', tags: ['a'], active: true }, schema)).toEqual([]);
  });

  it('reports missing required, wrong types, enum and length violations', () => {
    const errors = checkBody({ priority: 'urgent', tags: ['a', 7], active: 'yes', title: 'way too long title' }, schema);
    const fields = errors.map(e => e.field).sort();
    expect(fields).toEqual(['active', 'priority', 'tags', 'title']);
  });

  it('rejects non-object bodies and unknown fields', () => {
    expect(checkBody('nope', schema)[0].field).toBe('(body)');
    expect(checkBody({ title: 'x', bogus: 1 }, schema).some(e => e.field === 'bogus')).toBe(true);
    expect(checkBody({ title: 'x', bogus: 1 }, schema, { allowUnknown: true }).length).toBe(0);
  });
});

describe('WebhookService signatures and payloads (C2: ID-only)', () => {
  const svc = new WebhookService();
  const events = [{
    cursor: '42', name: 'task.updated', objectType: 'task',
    objectId: '22222222-2222-4222-8222-222222222222',
    occurredAt: '2026-08-24T00:00:00.000Z',
  }];

  const target = {
    plane: 'observation' as const, channelId: 'sub-1',
    url: 'https://runner.test/hook', secret: 'topsecret',
  };

  it('builds a stable HMAC-SHA256 signature over the exact body', () => {
    const body = svc.buildPayload(target, events, '2026-08-24T00:00:01.000Z');
    const sig = svc.buildSignature('topsecret', body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(svc.buildSignature('topsecret', body)).toBe(sig);
    expect(svc.buildSignature('other', body)).not.toBe(sig);
  });

  it('payload carries identity and the batch cursor, and NOTHING content-bearing', () => {
    const parsed = JSON.parse(svc.buildPayload(target, events, '2026-08-24T00:00:01.000Z'));
    // Ruling ccd53781 R1: the PLANE is part of the signed bytes. A receiver
    // must never have to guess whether a message is a go signal, and an
    // observation must never be replayable as one.
    expect(parsed.plane).toBe('observation');
    expect(parsed.channelId).toBe('sub-1');
    expect(parsed.cursor).toBe('42');
    expect(parsed.events).toEqual([{
      cursor: '42', name: 'task.updated', objectType: 'task',
      objectId: '22222222-2222-4222-8222-222222222222',
      occurredAt: '2026-08-24T00:00:00.000Z',
    }]);
    // The ID-only contract, asserted as an exact key set rather than by
    // spot-checking absences: a future field cannot slip in unnoticed.
    expect(Object.keys(parsed.events[0]).sort())
      .toEqual(['cursor', 'name', 'objectId', 'objectType', 'occurredAt']);
  });

  it('signs the plane, so a work doorbell cannot be replayed as an observation', () => {
    const workTarget = { ...target, plane: 'work' as const, channelId: 'svc-1' };
    const observationBody = svc.buildPayload(target, events, '2026-08-24T00:00:01.000Z');
    const workBody = svc.buildPayload(workTarget, events, '2026-08-24T00:00:01.000Z');
    expect(workBody).not.toBe(observationBody);
    expect(svc.buildSignature('topsecret', workBody))
      .not.toBe(svc.buildSignature('topsecret', observationBody));
  });

  it('refuses to deliver unsigned or unaddressed rather than sending in the clear', async () => {
    const unsigned = await svc.deliver({ ...target, secret: null }, '{}', '1');
    expect(unsigned).toEqual({ ok: false, status: null, error: 'DELIVERY_UNSIGNED' });
    const unaddressed = await svc.deliver({ ...target, url: '' }, '{}', '1');
    expect(unaddressed).toEqual({ ok: false, status: null, error: 'DELIVERY_UNADDRESSED' });
  });
});

describe('openapi spec', () => {
  it('is valid JSON with the core paths', () => {
    const spec = buildOpenApiSpec() as { paths: Record<string, unknown>; openapi: string };
    expect(spec.openapi).toBe('3.0.3');
    for (const p of ['/tasks', '/tasks/{id}', '/tasks/batch', '/sessions/pipeline-health', '/webhooks', '/openapi.json']) {
      expect(spec.paths[p]).toBeDefined();
    }
    expect(() => JSON.stringify(spec)).not.toThrow();
  });

  it('publishes every canonical Brief altitude and no retired spelling (D4)', () => {
    // Review c4409291 B6: the rename swept the two routes that MOVED and
    // missed the one that was NEW, and no test could tell — inverting the task
    // key back to the retired spelling left this suite green. Both directions
    // are asserted now, and the retired list is checked against the whole key
    // set rather than against a remembered subset.
    const spec = buildOpenApiSpec() as { paths: Record<string, unknown> };
    const keys = Object.keys(spec.paths);
    for (const canonical of [
      '/tasks/{id}/brief', '/phases/{id}/brief', '/projects/{id}/brief', '/principals/me/brief',
    ]) {
      expect([canonical, keys.includes(canonical)]).toEqual([canonical, true]);
    }
    for (const retired of [
      '/tasks/{id}/prompt', '/tasks/{id}/spawn-prompt', '/projects/{id}/generate-brief',
    ]) {
      expect([retired, keys.includes(retired)]).toEqual([retired, false]);
    }
    // Nothing else in the published surface reintroduces a retired spelling
    // under a path shape this list did not anticipate.
    expect(keys.filter((key) => /prompt|generate-brief/.test(key))).toEqual([]);
  });
});
