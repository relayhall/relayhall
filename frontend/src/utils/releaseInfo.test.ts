// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadApiInfo, loadReleaseManifest, parseApiInfo, parseReleaseManifest } from './releaseInfo';

afterEach(() => {
  vi.unstubAllGlobals();
});

const manifest = {
  service: 'relayhall-frontend',
  sha: 'a'.repeat(40),
  dirty: 'false',
  buildContext: 'candidate',
  builtAt: '2026-08-14T01:02:03Z',
};

describe('release information contracts', () => {
  test('accepts an exact frontend manifest and rejects ambiguous identity', () => {
    expect(parseReleaseManifest(manifest)).toEqual(manifest);
    for (const invalid of [
      { ...manifest, service: 'relayhall-backend' },
      { ...manifest, sha: 'abc1234' },
      { ...manifest, dirty: false },
      { ...manifest, dirty: 'true' },
      { ...manifest, buildContext: ' ' },
      { ...manifest, builtAt: 'yesterday' },
    ]) expect(() => parseReleaseManifest(invalid)).toThrow('unavailable');
  });

  test('requires the named API and a non-blank API version', () => {
    expect(parseApiInfo({ name: 'RelayHall API', version: '2.0.0' }))
      .toEqual({ name: 'RelayHall API', version: '2.0.0' });
    expect(() => parseApiInfo({ name: 'Other API', version: '2.0.0' })).toThrow('unavailable');
    expect(() => parseApiInfo({ name: 'RelayHall API', version: ' ' })).toThrow('unavailable');
  });

  test('loads both facts with no-store and fails closed on HTTP errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'RelayHall API', version: '2.0.0' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('no', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadReleaseManifest()).resolves.toEqual(manifest);
    await expect(loadApiInfo()).resolves.toMatchObject({ version: '2.0.0' });
    await expect(loadReleaseManifest()).rejects.toThrow('unavailable');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
  });
});
