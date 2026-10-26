// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import packageInfo from '../../package.json';
import {
  builtAtInstant,
  bundleVersion,
  isUnreleasedVersion,
  loadApiInfo,
  loadReleaseManifest,
  parseApiInfo,
  parseBuildIdentity,
  parseReleaseManifest,
  RELAYHALL_VERSION,
  semanticVersion,
} from './releaseInfo';

afterEach(() => {
  vi.unstubAllGlobals();
});

const manifest = {
  service: 'relayhall-frontend',
  version: '1.0.0-beta.19',
  sha: 'a'.repeat(40),
  dirty: 'false',
  buildContext: 'b'.repeat(64),
  builtAt: '2026-08-14T01:02:03Z',
};

describe('build identity, field by field', () => {
  test('accepts a complete frontend manifest exactly', () => {
    expect(parseReleaseManifest(manifest)).toEqual(manifest);
  });

  test('accepts the builtAt shapes both producers stamp', () => {
    // `date -u +%Y-%m-%dT%H:%M:%SZ` (the documented build) and Python's
    // datetime.isoformat() (the release tooling, 10 Oct 2026). The second
    // one is the recurrence of 13bee2dd: a Z-only pattern refused it.
    for (const builtAt of [
      '2026-10-11T01:23:45Z',
      '2026-10-10T20:17:04.022529+00:00',
      '2026-10-10T22:17:04+02:00',
      '2026-10-10T20:17:04.5Z',
    ]) {
      expect(parseReleaseManifest({ ...manifest, builtAt }).builtAt).toBe(builtAt);
    }
    expect(builtAtInstant('2026-10-10T20:17:04.022529+00:00')).toBe('2026-10-10T20:17:04.022Z');
    expect(builtAtInstant('2026-10-10T22:17:04+02:00')).toBe('2026-10-10T20:17:04.000Z');
  });

  test('a dirty build is a fact, not a refusal', () => {
    expect(parseReleaseManifest({ ...manifest, dirty: 'true' })).toEqual({ ...manifest, dirty: 'true' });
  });

  test('one bad field is that field alone: every other field survives', () => {
    const cases: Array<[Record<string, unknown>, keyof typeof manifest]> = [
      [{ ...manifest, sha: 'abc1234' }, 'sha'],
      [{ ...manifest, sha: 'unknown' }, 'sha'],
      [{ ...manifest, sha: 'A'.repeat(40) }, 'sha'],
      [{ ...manifest, dirty: false }, 'dirty'],
      [{ ...manifest, dirty: 'unknown' }, 'dirty'],
      [{ ...manifest, buildContext: ' ' }, 'buildContext'],
      [{ ...manifest, buildContext: ' padded' }, 'buildContext'],
      [{ ...manifest, buildContext: 'unknown' }, 'buildContext'],
      [{ ...manifest, buildContext: 'line\nbreak' }, 'buildContext'],
      [{ ...manifest, buildContext: 'x'.repeat(513) }, 'buildContext'],
      [{ ...manifest, builtAt: 'yesterday' }, 'builtAt'],
      [{ ...manifest, builtAt: 'unknown' }, 'builtAt'],
      // The basic form is not RFC 3339: Unavailable, not a blank panel.
      [{ ...manifest, builtAt: '20260904T230148Z' }, 'builtAt'],
      [{ ...manifest, builtAt: '2026-10-10T20:17:04' }, 'builtAt'],
      [{ ...manifest, builtAt: '2026-13-40T20:17:04Z' }, 'builtAt'],
      [{ ...manifest, version: 'beta' }, 'version'],
      [{ ...manifest, version: '1.0.0-beta.01' }, 'version'],
      [{ ...manifest, version: 19 }, 'version'],
    ];
    for (const [input, field] of cases) {
      const parsed = parseReleaseManifest(input);
      expect(parsed[field], `${field} from ${JSON.stringify(input[field])}`).toBeNull();
      for (const other of Object.keys(manifest) as Array<keyof typeof manifest>) {
        if (other !== field) expect(parsed[other]).toBe(manifest[other]);
      }
    }
  });

  test('a manifest from before the version field keeps every other fact', () => {
    const legacy: Record<string, unknown> = { ...manifest };
    delete legacy.version;
    expect(parseReleaseManifest(legacy)).toEqual({ ...manifest, version: null });
  });

  test('only a document of the right artefact is attributed to it', () => {
    expect(() => parseReleaseManifest({ ...manifest, service: 'relayhall-backend' })).toThrow('unavailable');
    expect(() => parseBuildIdentity(manifest, 'relayhall-backend')).toThrow('unavailable');
    for (const invalid of [null, 'manifest', [manifest], 42]) {
      expect(() => parseReleaseManifest(invalid)).toThrow('unavailable');
    }
  });

  test('projects only the identity fields', () => {
    const parsed = parseReleaseManifest({ ...manifest, extra: 'x', token: 'secret' });
    expect(Object.keys(parsed).sort()).toEqual(['buildContext', 'builtAt', 'dirty', 'service', 'sha', 'version']);
  });
});

describe('the API root', () => {
  const build = { ...manifest, service: 'relayhall-backend' };

  test('carries the backend version and its own build identity', () => {
    expect(parseApiInfo({ name: 'RelayHall API', version: '1.0.0-beta.19', build }))
      .toEqual({ name: 'RelayHall API', version: '1.0.0-beta.19', build });
  });

  test('an older backend without build identity keeps its version', () => {
    expect(parseApiInfo({ name: 'RelayHall API', version: '1.0.0-beta.1' }))
      .toEqual({ name: 'RelayHall API', version: '1.0.0-beta.1', build: null });
    expect(parseApiInfo({ name: 'RelayHall API', version: '1.0.0-beta.1', build: { ...build, service: 'relayhall-frontend' } }).build)
      .toBeNull();
  });

  test('an invalid version is unavailable on its own; a foreign API is refused', () => {
    expect(parseApiInfo({ name: 'RelayHall API', version: ' ', build })).toEqual({ name: 'RelayHall API', version: null, build });
    expect(() => parseApiInfo({ name: 'Other API', version: '2.0.0' })).toThrow('unavailable');
  });
});

describe('versions', () => {
  test('semantic versions only', () => {
    for (const valid of ['1.0.0', '1.0.0-beta.19', '1.0.0-beta.1+unreleased', '2.10.3-rc.1']) {
      expect(semanticVersion(valid)).toBe(valid);
    }
    for (const invalid of ['v1.0.0', '1.0', '1.0.0-', '01.0.0', ' 1.0.0', '1.0.0-beta.01', `1.0.0-${'a'.repeat(80)}`, undefined]) {
      expect(semanticVersion(invalid)).toBeNull();
    }
    expect(isUnreleasedVersion('1.0.0-beta.1+unreleased')).toBe(true);
    expect(isUnreleasedVersion('1.0.0-beta.19')).toBe(false);
  });

  test('the bundle version is the stamped release, else the package version marked unreleased', () => {
    expect(bundleVersion('1.0.0-beta.19', '1.0.0-beta.1')).toBe('1.0.0-beta.19');
    expect(bundleVersion('', '1.0.0-beta.1')).toBe('1.0.0-beta.1+unreleased');
    expect(bundleVersion(undefined, '1.0.0-beta.1')).toBe('1.0.0-beta.1+unreleased');
    expect(bundleVersion('beta', '1.0.0-beta.1')).toBe('1.0.0-beta.1+unreleased');
    // Build metadata is reserved for the unreleased marker: never a release.
    expect(bundleVersion('1.0.0-beta.19+local', '1.0.0-beta.1')).toBe('1.0.0-beta.1+unreleased');
    // The test build is not a release build.
    expect(RELAYHALL_VERSION).toBe(`${packageInfo.version}+unreleased`);
  });
});

describe('loading', () => {
  test('loads both facts with no-store and fails closed on HTTP errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'RelayHall API', version: '2.0.0' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('no', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadReleaseManifest()).resolves.toEqual(manifest);
    await expect(loadApiInfo()).resolves.toMatchObject({ version: '2.0.0', build: null });
    await expect(loadReleaseManifest()).rejects.toThrow('unavailable');
    expect(fetchMock.mock.calls[0][0]).toBe('/release-manifest.json');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
  });
});
