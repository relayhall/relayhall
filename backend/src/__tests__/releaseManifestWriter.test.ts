import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readImageBuildIdentity } from '../utils/releaseIdentity';

/**
 * The build-time writer each Dockerfile runs (card 6d549392). No CI job builds
 * the images, so this is where the writer is proven: the real script, run
 * the way `RUN` runs it - Docker build arguments arrive as environment - and
 * its output read back by the real backend reader.
 */
const BACKEND_WRITER = join(__dirname, '..', '..', 'scripts', 'write-release-manifest.cjs');
const FRONTEND_WRITER = join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'write-release-manifest.cjs');

let dir: string;
let packageJson: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relayhall-manifest-writer-'));
  packageJson = join(dir, 'package.json');
  writeFileSync(packageJson, JSON.stringify({ name: 'fixture', version: '1.0.0-beta.1' }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Only PATH is inherited, so a variable on the test host cannot leak in. */
function write(service: string, buildArgs: Record<string, string>, outputs = [join(dir, 'release-manifest.json')]) {
  const run = spawnSync(process.execPath, [BACKEND_WRITER, service, packageJson, ...outputs], {
    env: { PATH: process.env.PATH ?? '', ...buildArgs },
    encoding: 'utf8',
  });
  return { status: run.status, stderr: run.stderr, outputs };
}

const RELEASE = {
  RELEASE_SHA: 'a'.repeat(40),
  RELEASE_DIRTY: 'false',
  RELEASE_BUILD_CONTEXT: 'b'.repeat(64),
  // datetime.isoformat(), as the release tooling stamps it.
  RELEASE_BUILT_AT: '2026-10-10T20:17:04.022529+00:00',
  RELAYHALL_RELEASE_VERSION: '1.0.0-beta.19',
};

describe('the release manifest writer', () => {
  it('is one script: the frontend copy is byte-identical to the backend copy', () => {
    expect(readFileSync(FRONTEND_WRITER)).toEqual(readFileSync(BACKEND_WRITER));
  });

  it('records the release version and every argument, readable by the backend reader', () => {
    const outputs = [join(dir, 'root.json'), join(dir, 'web.json')];
    const run = write('relayhall-backend', RELEASE, outputs);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const text = readFileSync(outputs[0], 'utf8');
    expect(readFileSync(outputs[1], 'utf8')).toBe(text);
    expect(JSON.parse(text)).toEqual({
      service: 'relayhall-backend',
      version: '1.0.0-beta.19',
      sha: RELEASE.RELEASE_SHA,
      dirty: 'false',
      buildContext: RELEASE.RELEASE_BUILD_CONTEXT,
      builtAt: RELEASE.RELEASE_BUILT_AT,
    });
    expect(statSync(outputs[0]).mode & 0o777).toBe(0o644);
    // Producer to consumer: what the writer stamps, the reader accepts whole.
    const read = readImageBuildIdentity(outputs[0]);
    expect(read).not.toBeNull();
    expect(Object.values(read ?? {}).every((value) => value !== null)).toBe(true);
  });

  it('an empty or unset version is an unreleased build, never a bare package version', () => {
    for (const version of ['', undefined]) {
      const args: Record<string, string> = { ...RELEASE };
      if (version === undefined) delete args.RELAYHALL_RELEASE_VERSION;
      else args.RELAYHALL_RELEASE_VERSION = version;
      const run = write('relayhall-frontend', args);
      expect(run.status).toBe(0);
      expect(JSON.parse(readFileSync(run.outputs[0], 'utf8')).version).toBe('1.0.0-beta.1+unreleased');
    }
  });

  it('writes provenance it was not given as unknown, and any value as valid JSON', () => {
    const quoted = { RELEASE_BUILD_CONTEXT: 'ctx "quoted" \\ back\nslash' };
    const run = write('relayhall-backend', quoted);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(readFileSync(run.outputs[0], 'utf8'));
    expect(parsed).toEqual({
      service: 'relayhall-backend',
      version: '1.0.0-beta.1+unreleased',
      sha: 'unknown',
      dirty: 'unknown',
      buildContext: quoted.RELEASE_BUILD_CONTEXT,
      builtAt: 'unknown',
    });
    // The reader then shows each of those fields as unavailable, and only them.
    expect(readImageBuildIdentity(run.outputs[0])).toEqual({
      service: 'relayhall-backend',
      version: '1.0.0-beta.1+unreleased',
      sha: null,
      dirty: null,
      buildContext: null,
      builtAt: null,
    });
  });

  it('fails the build on a malformed release version and writes nothing', () => {
    for (const version of ['beta', 'v1.0.0-beta.19', '1.0.0-beta.19+build', ' 1.0.0-beta.19', '1.0.0-beta.01', '1.0', `1.0.0-${'a'.repeat(64)}`]) {
      const output = join(dir, 'refused.json');
      const run = write('relayhall-backend', { ...RELEASE, RELAYHALL_RELEASE_VERSION: version }, [output]);
      expect({ version, status: run.status }).toEqual({ version, status: 1 });
      expect(run.stderr).toContain('RELAYHALL_RELEASE_VERSION');
      expect(existsSync(output)).toBe(false);
    }
  });

  it('refuses an unknown service', () => {
    const run = write('another-service', RELEASE);
    expect(run.status).toBe(1);
    expect(existsSync(run.outputs[0])).toBe(false);
  });
});
