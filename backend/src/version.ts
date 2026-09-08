type PackageIdentity = { version?: unknown };

// package.json is the semantic-version source of truth for the running backend.
// require() deliberately resolves from both src/version.ts and dist/version.js.
const packageIdentity = require('../package.json') as PackageIdentity;

if (typeof packageIdentity.version !== 'string' || packageIdentity.version.trim() === '') {
  throw new Error('RelayHall package version is missing');
}

export const RELAYHALL_VERSION = packageIdentity.version;
