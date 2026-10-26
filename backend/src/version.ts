import { readImageBuildIdentity, reportedVersion, type BuildIdentity } from './utils/releaseIdentity';

type PackageIdentity = { version?: unknown };

// package.json supplies only the BASE of the unreleased fallback; it is never
// reported bare. require() deliberately resolves from both src/version.ts and
// dist/version.js.
const packageIdentity = require('../package.json') as PackageIdentity;

if (typeof packageIdentity.version !== 'string' || packageIdentity.version.trim() === '') {
  throw new Error('RelayHall package version is missing');
}

/**
 * What this image recorded about its own build (card 6d549392): read once,
 * from the file the Dockerfile wrote, and never from the environment.
 */
export const BACKEND_BUILD_IDENTITY: BuildIdentity | null = readImageBuildIdentity();

/** The release version the image was built as, else `<package>+unreleased`. */
export const RELAYHALL_VERSION = reportedVersion(BACKEND_BUILD_IDENTITY, packageIdentity.version);
