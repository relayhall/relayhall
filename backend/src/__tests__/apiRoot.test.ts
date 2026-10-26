import express, { RequestHandler } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { apiRootHandler, createApiRootHandler } from '../routes/apiRoot';
import { BACKEND_BUILD_IDENTITY, RELAYHALL_VERSION } from '../version';
import { parseBuildIdentity, readImageBuildIdentity, reportedVersion, type BuildIdentity } from '../utils/releaseIdentity';

/**
 * GET / (served as `/api/`), card 6d549392. The handler is mounted on a real
 * Express app and read over HTTP, so the assertions cover what a client
 * receives - headers included - and not a stubbed response object.
 */
const packageVersion = (require('../../package.json') as { version: string }).version;

const identity = parseBuildIdentity({
  service: 'relayhall-backend',
  version: '1.0.0-beta.19',
  sha: 'e'.repeat(40),
  dirty: 'false',
  buildContext: 'f'.repeat(64),
  builtAt: '2026-10-11T01:23:45Z',
}) as BuildIdentity;

async function get(handler: RequestHandler): Promise<{ status: number; cacheControl: string | null; body: any }> {
  const app = express();
  app.get('/', handler);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`);
    return { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('the API root', () => {
  it('serves the version and the backend build identity, uncached', async () => {
    const response = await get(createApiRootHandler('1.0.0-beta.19', identity));
    expect(response.status).toBe(200);
    expect(response.cacheControl).toBe('no-store');
    expect(response.body).toEqual({
      name: 'RelayHall API',
      version: '1.0.0-beta.19',
      build: identity,
      environment: 'test',
      status: 'running',
    });
  });

  it('says plainly when the image recorded no identity', async () => {
    const response = await get(createApiRootHandler(reportedVersion(null, packageVersion), null));
    expect(response.body.version).toBe(`${packageVersion}+unreleased`);
    expect(response.body.build).toBeNull();
  });

  it('the mounted handler reports what version.ts derived from the image file', async () => {
    const response = await get(apiRootHandler);
    expect(response.body.version).toBe(RELAYHALL_VERSION);
    expect(response.body.build).toEqual(BACKEND_BUILD_IDENTITY);
    // Whatever this machine's image file says - normally nothing, so the
    // package version marked unreleased - and never the bare package version.
    expect(RELAYHALL_VERSION).toBe(reportedVersion(readImageBuildIdentity(), packageVersion));
    expect(RELAYHALL_VERSION).not.toBe(packageVersion);
  });
});

describe('where the backend version comes from', () => {
  const saved = process.env.RELAYHALL_RELEASE_VERSION;

  afterEach(() => {
    if (saved === undefined) delete process.env.RELAYHALL_RELEASE_VERSION;
    else process.env.RELAYHALL_RELEASE_VERSION = saved;
    jest.dontMock('../utils/releaseIdentity');
  });

  function versionModuleWith(recorded: BuildIdentity | null): typeof import('../version') {
    let loaded: typeof import('../version') | undefined;
    jest.isolateModules(() => {
      jest.doMock('../utils/releaseIdentity', () => ({
        ...jest.requireActual('../utils/releaseIdentity'),
        readImageBuildIdentity: () => recorded,
      }));
      loaded = require('../version');
    });
    if (!loaded) throw new Error('version module did not load');
    return loaded;
  }

  it('is the version the image file recorded, whatever the environment says', () => {
    process.env.RELAYHALL_RELEASE_VERSION = '7.7.7';
    const version = versionModuleWith(identity);
    expect(version.RELAYHALL_VERSION).toBe('1.0.0-beta.19');
    expect(version.BACKEND_BUILD_IDENTITY).toEqual(identity);
  });

  it('without a recorded identity is the package version marked unreleased, never the environment', () => {
    process.env.RELAYHALL_RELEASE_VERSION = '7.7.7';
    const version = versionModuleWith(null);
    expect(version.RELAYHALL_VERSION).toBe(`${packageVersion}+unreleased`);
    expect(version.BACKEND_BUILD_IDENTITY).toBeNull();
  });
});
