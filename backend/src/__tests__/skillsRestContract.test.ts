import express from 'express';

jest.mock('../services/WebhookService', () => ({
  webhookService: { emitEvent: jest.fn() },
}));

jest.mock('../services/SkillManager', () => {
  const actual = jest.requireActual('../services/SkillManager');
  return {
    ...actual,
    skillManager: {
      list: jest.fn(), getById: jest.fn(), create: jest.fn(),
      update: jest.fn(), delete: jest.fn(),
    },
  };
});

import skillsRoutes from '../routes/skills';
import { skillManager, SkillContractError } from '../services/SkillManager';

const manager = skillManager as jest.Mocked<typeof skillManager>;
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const skill = { id: ID, name: 'test', category: null, description: null,
  usage_instructions: null, config: {}, tags: [], is_global: false,
  version: 1, revision: REV, created_at: 'now', updated_at: 'now' };

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/skills', skillsRoutes);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('/skills house REST contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.list.mockResolvedValue([skill] as any);
    manager.getById.mockResolvedValue(skill as any);
    manager.create.mockResolvedValue(skill as any);
    manager.update.mockResolvedValue({ ...skill, version: 2 } as any);
    manager.delete.mockResolvedValue(undefined);
  });

  it('fails closed on unknown and duplicate query fields', async () => {
    await withServer(async base => {
      for (const path of ['/skills?surprise=1', '/skills?tag=a&tag=b']) {
        const response = await fetch(base + path);
        expect(response.status).toBe(400);
        const body = await response.json() as { code: string };
        expect(body.code).toMatch(/UNKNOWN_FIELD|INVALID_QUERY_VALUE/);
      }
    });
    expect(manager.list).not.toHaveBeenCalled();
  });

  it.each([
    ['category', 100],
    ['tag', 128],
    ['search', 256],
  ])('rejects over-length %s before manager/DB access', async (field, limit) => {
    await withServer(async base => {
      const response = await fetch(`${base}/skills?${field}=${'x'.repeat(limit + 1)}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({
        success: false,
        code: 'QUERY_VALUE_TOO_LONG',
        details: expect.objectContaining({ field, maxLength: limit }),
      }));
    });
    expect(manager.list).not.toHaveBeenCalled();
  });

  it.each([
    '/skills?category=a&category=b',
    '/skills?tag=a&tag=b',
    '/skills?search=a&search=b',
  ])('rejects repeated query values before manager/DB access: %s', async path => {
    await withServer(async base => {
      const response = await fetch(base + path);
      expect(response.status).toBe(400);
      expect((await response.json() as { code: string }).code).toBe('INVALID_QUERY_VALUE');
    });
    expect(manager.list).not.toHaveBeenCalled();
  });

  it('rejects unknown, over-length and wrongly typed body fields', async () => {
    await withServer(async base => {
      const fixtures = [
        [{ name: 'x', surprise: true }, 400, 'UNKNOWN_FIELD'],
        [{ name: 'x'.repeat(256) }, 422, 'INVALID_SKILL_VALUE'],
        [{ name: 'x', is_global: 'yes' }, 422, 'INVALID_SKILL_VALUE'],
        [{ name: 'x', config: [] }, 422, 'INVALID_SKILL_VALUE'],
      ] as const;
      for (const [payload, status, code] of fixtures) {
        const response = await fetch(`${base}/skills`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        expect(response.status).toBe(status);
        expect(((await response.json()) as { code: string }).code).toBe(code);
      }
    });
    expect(manager.create).not.toHaveBeenCalled();
  });

  it('passes the quoted If-Match revision to update and delete', async () => {
    await withServer(async base => {
      const update = await fetch(`${base}/skills/${ID}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': `"${REV}"` },
        body: JSON.stringify({ description: 'new' }),
      });
      expect(update.status).toBe(201);
      const deletion = await fetch(`${base}/skills/${ID}`, {
        method: 'DELETE', headers: { 'If-Match': `"${REV}"` },
      });
      expect(deletion.status).toBe(200);
    });
    expect(manager.update).toHaveBeenCalledWith(ID, expect.objectContaining({ description: 'new' }), REV, undefined);
    expect(manager.delete).toHaveBeenCalledWith(ID, REV);
  });

  it.each([
    [undefined, 'REVISION_REQUIRED'],
    ['', 'INVALID_REVISION_PRECONDITION'],
    ['   ', 'INVALID_REVISION_PRECONDITION'],
    ['*', 'INVALID_REVISION_PRECONDITION'],
    [`W/"${REV}"`, 'INVALID_REVISION_PRECONDITION'],
    ['""', 'INVALID_REVISION_PRECONDITION'],
    ['"not-a-uuid"', 'INVALID_REVISION_PRECONDITION'],
    ['not-a-uuid', 'INVALID_REVISION_PRECONDITION'],
    [`${REV},${REV}`, 'INVALID_REVISION_PRECONDITION'],
  ])('rejects invalid update If-Match %p before manager/DB access', async (value, code) => {
    await withServer(async base => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (value !== undefined) headers['If-Match'] = value;
      const response = await fetch(`${base}/skills/${ID}`, {
        method: 'PUT', headers, body: JSON.stringify({ description: 'new' }),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { code: string }).code).toBe(code);
    });
    expect(manager.update).not.toHaveBeenCalled();
  });

  it.each([
    ['*'], [`W/"${REV}"`], ['""'], ['"not-a-uuid"'], ['not-a-uuid'],
  ])('rejects invalid delete If-Match %p before manager/DB access', async value => {
    await withServer(async base => {
      const response = await fetch(`${base}/skills/${ID}`, { method: 'DELETE', headers: { 'If-Match': value } });
      expect(response.status).toBe(400);
      expect((await response.json() as { code: string }).code).toBe('INVALID_REVISION_PRECONDITION');
    });
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('maps revision errors to the typed house envelope', async () => {
    manager.update.mockRejectedValue(new SkillContractError(
      412, 'REVISION_MISMATCH', 'The skill changed since it was last read; reload and retry'));
    await withServer(async base => {
      const response = await fetch(`${base}/skills/${ID}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': REV },
        body: JSON.stringify({ description: 'new' }),
      });
      expect(response.status).toBe(412);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toEqual(expect.objectContaining({
        success: false, code: 'REVISION_MISMATCH', error: expect.any(String), message: expect.any(String),
      }));
    });
  });
});
