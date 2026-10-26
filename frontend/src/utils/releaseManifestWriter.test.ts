// @vitest-environment node
/**
 * Producer to consumer, across the language seam (card 6d549392): the
 * manifest the frontend image's build step writes, parsed by the parser the
 * About page uses. 13bee2dd recurred because the producer and this parser
 * were never run against each other; here they are, with the builtAt shape
 * the release tooling stamps.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseReleaseManifest } from './releaseInfo';

const here = path.dirname(fileURLToPath(import.meta.url));
const WRITER = path.resolve(here, '../../scripts/write-release-manifest.cjs');
const PACKAGE_JSON = path.resolve(here, '../../package.json');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relayhall-frontend-manifest-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function stamp(buildArgs: Record<string, string>): unknown {
  const output = path.join(dir, 'release-manifest.json');
  const run = spawnSync(process.execPath, [WRITER, 'relayhall-frontend', PACKAGE_JSON, output], {
    env: { PATH: process.env.PATH ?? '', ...buildArgs },
    encoding: 'utf8',
  });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

describe('the frontend manifest as the image writes it', () => {
  test('a release build parses whole, every field present', () => {
    const parsed = parseReleaseManifest(stamp({
      RELEASE_SHA: 'b8210647ce0fdbba0eaa33d3de42f64ec2c72638',
      RELEASE_DIRTY: 'false',
      RELEASE_BUILD_CONTEXT: '2c635d13e9a84f7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b',
      RELEASE_BUILT_AT: '2026-10-10T20:17:04.022529+00:00',
      RELAYHALL_RELEASE_VERSION: '1.0.0-beta.19',
    }));
    expect(parsed).toEqual({
      service: 'relayhall-frontend',
      version: '1.0.0-beta.19',
      sha: 'b8210647ce0fdbba0eaa33d3de42f64ec2c72638',
      dirty: 'false',
      buildContext: '2c635d13e9a84f7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b',
      builtAt: '2026-10-10T20:17:04.022529+00:00',
    });
  });

  test('the documented shell build parses whole too, and an ad-hoc build keeps its version', () => {
    expect(parseReleaseManifest(stamp({
      RELEASE_SHA: 'a'.repeat(40),
      RELEASE_DIRTY: 'true',
      RELEASE_BUILD_CONTEXT: 'relayhall',
      RELEASE_BUILT_AT: '2026-10-11T01:23:45Z',
    }))).toMatchObject({ dirty: 'true', builtAt: '2026-10-11T01:23:45Z', version: expect.stringMatching(/\+unreleased$/) });
    expect(parseReleaseManifest(stamp({}))).toMatchObject({
      sha: null, dirty: null, buildContext: null, builtAt: null, version: expect.stringMatching(/\+unreleased$/),
    });
  });
});
