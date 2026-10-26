import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MAX_MANIFEST_BYTES,
  parseBuildIdentity,
  readImageBuildIdentity,
  reportedVersion,
  semanticVersion,
} from '../utils/releaseIdentity';

/**
 * Card 6d549392: the backend image's build identity, read field by field
 * from the file the Dockerfile wrote. Real files in a temporary directory -
 * no `fs` mock, so the bounded reader is the one under test.
 */
const complete = {
  service: 'relayhall-backend',
  version: '1.0.0-beta.19',
  sha: 'c'.repeat(40),
  dirty: 'false',
  buildContext: 'd'.repeat(64),
  builtAt: '2026-10-10T20:17:04.022529+00:00',
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relayhall-release-identity-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manifestFile(content: string): string {
  const path = join(dir, 'release-manifest.json');
  writeFileSync(path, content);
  return path;
}

describe('backend build identity', () => {
  it('reads a complete identity from the image file, both builtAt shapes included', () => {
    expect(readImageBuildIdentity(manifestFile(JSON.stringify(complete)))).toEqual(complete);
    const shell = { ...complete, builtAt: '2026-10-11T01:23:45Z' };
    expect(readImageBuildIdentity(manifestFile(JSON.stringify(shell)))).toEqual(shell);
  });

  it('keeps a dirty build as dirty=true', () => {
    expect(parseBuildIdentity({ ...complete, dirty: 'true' })?.dirty).toBe('true');
  });

  it('nulls exactly the field that is missing or malformed, and keeps the rest', () => {
    const cases: Array<[Record<string, unknown>, keyof typeof complete]> = [
      [{ ...complete, sha: 'unknown' }, 'sha'],
      [{ ...complete, sha: 'c'.repeat(39) }, 'sha'],
      [{ ...complete, dirty: 'unknown' }, 'dirty'],
      [{ ...complete, buildContext: 'unknown' }, 'buildContext'],
      [{ ...complete, buildContext: 'tab\tinside' }, 'buildContext'],
      [{ ...complete, buildContext: 'x'.repeat(513) }, 'buildContext'],
      [{ ...complete, builtAt: 'unknown' }, 'builtAt'],
      [{ ...complete, builtAt: '20260904T230148Z' }, 'builtAt'],
      [{ ...complete, version: 'beta' }, 'version'],
      [{ ...complete, version: undefined }, 'version'],
    ];
    for (const [input, field] of cases) {
      const parsed = parseBuildIdentity(input);
      expect(parsed?.[field]).toBeNull();
      for (const other of Object.keys(complete) as Array<keyof typeof complete>) {
        if (other !== field) expect(parsed?.[other]).toBe(complete[other]);
      }
    }
  });

  it('projects only the six identity fields, so the public API root cannot echo more', () => {
    const parsed = parseBuildIdentity({ ...complete, secret: 'x', env: { TOKEN: 'y' } });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['buildContext', 'builtAt', 'dirty', 'service', 'sha', 'version']);
  });

  it('is null when the image carries no backend identity', () => {
    expect(readImageBuildIdentity(join(dir, 'absent.json'))).toBeNull();
    expect(readImageBuildIdentity(manifestFile('{not json'))).toBeNull();
    expect(readImageBuildIdentity(manifestFile(JSON.stringify({ ...complete, service: 'relayhall-frontend' })))).toBeNull();
    expect(readImageBuildIdentity(manifestFile('[]'))).toBeNull();
    const directory = join(dir, 'a-directory');
    mkdirSync(directory);
    expect(readImageBuildIdentity(directory)).toBeNull();
  });

  it('refuses a manifest larger than its bound', () => {
    const padded = JSON.stringify({ ...complete, padding: 'p'.repeat(MAX_MANIFEST_BYTES) });
    expect(readImageBuildIdentity(manifestFile(padded))).toBeNull();
    let reads = 0;
    expect(readImageBuildIdentity('/any', () => { reads += 1; return padded; })).toBeNull();
    expect(reads).toBe(1);
  });

  it('reports the recorded release version, else the package version marked unreleased', () => {
    expect(reportedVersion(parseBuildIdentity(complete), '1.0.0-beta.1')).toBe('1.0.0-beta.19');
    expect(reportedVersion(null, '1.0.0-beta.1')).toBe('1.0.0-beta.1+unreleased');
    expect(reportedVersion(parseBuildIdentity({ ...complete, version: 'beta' }), '1.0.0-beta.1'))
      .toBe('1.0.0-beta.1+unreleased');
    expect(semanticVersion('1.0.0-beta.1+unreleased')).toBe('1.0.0-beta.1+unreleased');
    expect(semanticVersion('1.0.0-beta.01')).toBeNull();
  });
});
