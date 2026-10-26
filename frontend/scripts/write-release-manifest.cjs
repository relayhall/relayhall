#!/usr/bin/env node
'use strict';
/**
 * Writes an image's release manifest at build time (card 6d549392,
 * docs/build-identity.md).
 *
 *   node scripts/write-release-manifest.cjs <service> <package.json> <out> [<out>...]
 *
 * Inputs are the Docker build arguments, which RUN sees as environment:
 *   RELEASE_SHA, RELEASE_DIRTY, RELEASE_BUILD_CONTEXT, RELEASE_BUILT_AT
 *     written verbatim (the Dockerfile defaults them to `unknown`); readers
 *     validate each field on its own.
 *   RELAYHALL_RELEASE_VERSION
 *     the release version the release tooling assigns, e.g. 1.0.0-beta.19.
 *     Empty or unset: an unreleased build, recorded as
 *     `<package.json version>+unreleased`. Set but not a SemVer 2.0.0
 *     version without build metadata: the build FAILS, so a malformed
 *     version can never ship.
 *
 * JSON.stringify writes the document, so no argument value can break it.
 *
 * One byte-identical copy lives in each service directory (each image's
 * build context sees only its own directory); a backend test holds them equal.
 */
const fs = require('fs');

const SERVICES = new Set(['relayhall-frontend', 'relayhall-backend']);
const RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const MAX_RELEASE_VERSION_LENGTH = 64;
const UNRELEASED_SUFFIX = '+unreleased';

function fail(message) {
  process.stderr.write(`write-release-manifest: ${message}\n`);
  process.exit(1);
}

function argument(name) {
  const value = process.env[name];
  return typeof value === 'string' && value !== '' ? value : 'unknown';
}

const [service, packagePath, ...outputs] = process.argv.slice(2);
if (!SERVICES.has(service)) fail(`unknown service ${JSON.stringify(service)}`);
if (!packagePath || outputs.length === 0) fail('usage: <service> <package.json> <out> [<out>...]');

let packageVersion;
try {
  packageVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
} catch (error) {
  fail(`cannot read ${packagePath}: ${error.message}`);
}
if (typeof packageVersion !== 'string' || !RELEASE_VERSION.test(packageVersion)) {
  fail(`${packagePath} has no semantic version`);
}

const requested = process.env.RELAYHALL_RELEASE_VERSION || '';
if (requested !== '' && (requested.length > MAX_RELEASE_VERSION_LENGTH || !RELEASE_VERSION.test(requested))) {
  fail(`RELAYHALL_RELEASE_VERSION ${JSON.stringify(requested)} is not a release version (SemVer 2.0.0, no build metadata)`);
}

const manifest = {
  service,
  version: requested !== '' ? requested : `${packageVersion}${UNRELEASED_SUFFIX}`,
  sha: argument('RELEASE_SHA'),
  dirty: argument('RELEASE_DIRTY'),
  buildContext: argument('RELEASE_BUILD_CONTEXT'),
  builtAt: argument('RELEASE_BUILT_AT'),
};
const text = `${JSON.stringify(manifest)}\n`;
for (const output of outputs) {
  fs.writeFileSync(output, text, { mode: 0o644 });
  fs.chmodSync(output, 0o644);
}
process.stdout.write(text);
