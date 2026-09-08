/**
 * Tests for the deployment-neutral model catalog:
 *  - LiteLLM /v1/models plus a static degraded-startup floor
 *  - normalization equivalence across provider prefixes
 *  - bounded cache behavior
 */

import {
  getModelCatalog,
  clearModelCatalogCache,
  normalizeModelId,
  isModelAvailable,
  STATIC_FLOOR_MODELS,
  MODEL_CATALOG_TTL_MS,
} from '../services/modelCatalog';

function mockLiteLLM(ids: string[], ok = true, status = 200) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

beforeEach(() => {
  clearModelCatalogCache();
  process.env.LITELLM_ADMIN_API_URL = 'https://litellm.example';
  process.env.LITELLM_MASTER_KEY = 'test-key';
});

afterEach(() => {
  delete (global as any).fetch;
  delete process.env.LITELLM_ADMIN_API_URL;
  delete process.env.LITELLM_MASTER_KEY;
});

describe('normalizeModelId', () => {
  it('strips provider prefixes and lowercases', () => {
    expect(normalizeModelId('openai-codex/gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeModelId('codex/gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeModelId('gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeModelId('anthropic/Claude-Opus-4-8')).toBe('claude-opus-4-8');
  });

  it('treats canonical provider-prefixed forms as equivalent', () => {
    const forms = ['gpt-5.5', 'openai-codex/gpt-5.5', 'codex/gpt-5.5'];
    const normalized = new Set(forms.map(normalizeModelId));
    expect(normalized.size).toBe(1);
  });

  it('strips only the leading provider segment, keeping nested LiteLLM routes distinct', () => {
    expect(normalizeModelId('litellm/gemini/gemini-3-flash-preview')).toBe(
      'gemini/gemini-3-flash-preview'
    );
    // distinct downstream models remain distinct
    expect(normalizeModelId('litellm/gemini/a')).not.toBe(normalizeModelId('litellm/gemini/b'));
  });

  it('returns empty string for empty/nullish input', () => {
    expect(normalizeModelId('')).toBe('');
    expect(normalizeModelId(undefined as any)).toBe('');
  });
});

describe('getModelCatalog aggregation', () => {
  it('aggregates LiteLLM with the static floor', async () => {
    mockLiteLLM(['gemini/gemini-3-flash-preview', 'openai/gpt-5.2']);
    const catalog = await getModelCatalog(true);

    // LiteLLM ids present, both raw and litellm/-prefixed
    expect(catalog.ids).toContain('gemini/gemini-3-flash-preview');
    expect(catalog.ids).toContain('litellm/gemini/gemini-3-flash-preview');
    // static floor present
    for (const id of STATIC_FLOOR_MODELS) expect(catalog.ids).toContain(id);

    expect(catalog.sources.litellm).toBeGreaterThan(0);
    expect(catalog.sources.floor).toBe(STATIC_FLOOR_MODELS.length);
  });

  it('degrades gracefully when LiteLLM is unreachable', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const catalog = await getModelCatalog(true);
    expect(catalog.sources.litellm).toBe(0);
    // The static floor still resolves.
    expect(catalog.ids).toContain('codex/gpt-5.5');
    expect(isModelAvailable('gpt-5.5', catalog)).toBe(true);
  });

  it('degrades gracefully when LiteLLM returns non-200', async () => {
    mockLiteLLM([], false, 401);
    const catalog = await getModelCatalog(true);
    expect(catalog.sources.litellm).toBe(0);
    expect(catalog.ids).toContain('codex/gpt-5.5');
  });

  it('uses only the floor when no LiteLLM credential is configured', async () => {
    delete process.env.LITELLM_MASTER_KEY;
    const catalog = await getModelCatalog(true);
    expect(catalog.sources.litellm).toBe(0);
    expect(catalog.ids).toEqual(STATIC_FLOOR_MODELS);
    expect((global as any).fetch).toBeUndefined();
  });

  it('resolves valid gpt-5.5 pins (all provider forms) against the catalog', async () => {
    mockLiteLLM([]);
    const catalog = await getModelCatalog(true);
    expect(isModelAvailable('gpt-5.5', catalog)).toBe(true);
    expect(isModelAvailable('openai-codex/gpt-5.5', catalog)).toBe(true);
    expect(isModelAvailable('codex/gpt-5.5', catalog)).toBe(true);
    // a genuinely unknown model is not available
    expect(isModelAvailable('no/such-model', catalog)).toBe(false);
  });
});

describe('getModelCatalog TTL cache', () => {
  it('does not re-fetch LiteLLM within the TTL window', async () => {
    const fetchMock = mockLiteLLM(['openai/gpt-5.2']);
    await getModelCatalog(true); // seed cache (1 fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await getModelCatalog(); // cached
    await getModelCatalog(); // cached
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when the cache is expired past the TTL', async () => {
    const fetchMock = mockLiteLLM(['openai/gpt-5.2']);
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1_000_000);
    await getModelCatalog(); // cold -> fetch #1
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + MODEL_CATALOG_TTL_MS + 1);
    await getModelCatalog(); // expired -> fetch #2
    expect(fetchMock).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('force=true bypasses the cache', async () => {
    const fetchMock = mockLiteLLM(['openai/gpt-5.2']);
    await getModelCatalog(); // fetch #1
    await getModelCatalog(true); // forced -> fetch #2
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent cold callers into a single LiteLLM probe', async () => {
    const fetchMock = mockLiteLLM(['openai/gpt-5.2']);
    const [a, b, c] = await Promise.all([
      getModelCatalog(),
      getModelCatalog(),
      getModelCatalog(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
