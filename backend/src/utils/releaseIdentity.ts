import { readFileSync, statSync } from 'fs';

/**
 * The backend image's own build identity (card 6d549392,
 * docs/build-identity.md).
 *
 * The Dockerfile writes `/release-manifest.json` into the image at build
 * time, from the release tooling's build arguments. That file is the ONLY
 * source: never the environment, never a mounted checkout, never
 * package.json - an identity a process could be handed at runtime is not a
 * record of what was built. Every field is read on its own, so one field the
 * build did not stamp is that field `null` and nothing else.
 */
export const IMAGE_MANIFEST_PATH = '/release-manifest.json';

/** Larger than any manifest the writer produces; bounds a corrupt file. */
export const MAX_MANIFEST_BYTES = 16 * 1024;

export interface BuildIdentity {
  service: 'relayhall-backend';
  version: string | null;
  sha: string | null;
  dirty: 'true' | 'false' | null;
  buildContext: string | null;
  builtAt: string | null;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** RFC 3339: `Z` or a numeric offset, a fraction of any length. */
const BUILT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** SemVer 2.0.0, prerelease and build metadata included. */
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_VERSION_LENGTH = 80;
const MAX_FIELD_LENGTH = 512;

/** The suffix a build carries when the release tooling supplied no version. */
export const UNRELEASED_SUFFIX = '+unreleased';

export function semanticVersion(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && SEMVER_PATTERN.test(value)
    ? value
    : null;
}

export function validBuiltAt(value: unknown): value is string {
  if (typeof value !== 'string' || !BUILT_AT_PATTERN.test(value)) return false;
  return Number.isFinite(Date.parse(value.replace(/(\.\d{3})\d+/, '$1')));
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A printable, trimmed, bounded value; the Dockerfile default `unknown` is not one. */
function textField(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value === 'unknown') return null;
  if (value.trim() !== value || value.length > MAX_FIELD_LENGTH || hasControlCharacter(value)) return null;
  return value;
}

/**
 * Projects a parsed manifest onto the fixed identity fields. Returns null
 * only when the document is not a backend identity at all; any other key in
 * the file is dropped, so the public API root can never echo more than these
 * six fields.
 */
export function parseBuildIdentity(value: unknown): BuildIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.service !== 'relayhall-backend') return null;
  return {
    service: 'relayhall-backend',
    version: semanticVersion(item.version),
    sha: typeof item.sha === 'string' && SHA_PATTERN.test(item.sha) ? item.sha : null,
    dirty: item.dirty === 'true' || item.dirty === 'false' ? item.dirty : null,
    buildContext: textField(item.buildContext),
    builtAt: validBuiltAt(item.builtAt) ? item.builtAt : null,
  };
}

export type ManifestReader = (path: string) => string;

/** Reads a regular file no larger than MAX_MANIFEST_BYTES. */
export const readBoundedFile: ManifestReader = (path) => {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('release manifest is not a bounded file');
  return readFileSync(path, 'utf8');
};

/**
 * The image's build identity, or null when the image carries none (a
 * development checkout, the test runner, an image built before the writer).
 * Never throws: a missing identity is a fact to show, not a boot failure.
 */
export function readImageBuildIdentity(
  path: string = IMAGE_MANIFEST_PATH,
  read: ManifestReader = readBoundedFile,
): BuildIdentity | null {
  try {
    const text = read(path);
    if (text.length > MAX_MANIFEST_BYTES) return null;
    return parseBuildIdentity(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The version this backend reports everywhere (`GET /api/`, OpenAPI
 * `info.version`, MCP `serverInfo.version`): the release version the image
 * recorded, else the package version marked unreleased. The package version
 * is never reported bare, so it cannot pass for a release.
 */
export function reportedVersion(identity: BuildIdentity | null, packageVersion: string): string {
  return identity?.version ?? `${packageVersion}${UNRELEASED_SUFFIX}`;
}
