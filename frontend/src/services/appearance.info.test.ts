// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/auth', () => ({ authenticatedFetch }));

import { loadAppearanceInfo, parseAppearanceInfo } from './appearance';

afterEach(() => {
  vi.clearAllMocks();
});

describe('authenticated appearance info contract', () => {
  test('loads the narrow surface with no-store', async () => {
    authenticatedFetch.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { displayName: 'Operations', description: 'Internal', links: [{ kind: 'support', label: 'Support', url: 'https://example.test' }], teamMarkdown: '**Team**' },
    }), { status: 200 }));
    await expect(loadAppearanceInfo()).resolves.toMatchObject({ description: 'Internal' });
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/appearance/info', expect.objectContaining({ cache: 'no-store' }));
  });

  test('rejects malformed response shapes instead of presenting partial facts', () => {
    expect(() => parseAppearanceInfo({ displayName: null, description: '', links: 'not-an-array', teamMarkdown: '' }))
      .toThrow('unavailable');
    expect(() => parseAppearanceInfo({ displayName: null, description: '', links: [{ kind: 'billing', label: 'Support', url: 'https://example.test' }], teamMarkdown: '' }))
      .toThrow('unavailable');
  });
});
