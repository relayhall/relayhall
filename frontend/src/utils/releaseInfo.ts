import packageInfo from '../../package.json';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * Build identity as the images stamp it (docs/build-identity.md, card
 * 6d549392). Every field is read on its own: one field the build did not
 * stamp, or stamped in a shape this reader rejects, is that field
 * `null` - shown as Unavailable - and never takes the other fields with it.
 * The archived defect 13bee2dd and its recurrence were exactly that: one
 * builtAt shape blanked the whole panel on every environment.
 */
const SHA_PATTERN = /^[0-9a-f]{40}$/;
/**
 * RFC 3339 date-time with a `Z` or a numeric offset, and a fraction of any
 * length. Both producers in use pass: `date -u +%Y-%m-%dT%H:%M:%SZ` (the
 * documented build) and Python's `datetime.isoformat()` (`+00:00` and
 * microseconds), which a `Z`-only pattern refused.
 */
const BUILT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** SemVer 2.0.0, prerelease and build metadata included. */
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_VERSION_LENGTH = 80;
const MAX_FIELD_LENGTH = 512;

/**
 * The suffix a build carries when the release tooling supplied no release
 * version. A release version never has build metadata, so any `+` marks a
 * build that is not a release.
 */
export const UNRELEASED_SUFFIX = '+unreleased';

export type BuildService = 'relayhall-frontend' | 'relayhall-backend';

export interface BuildIdentity {
  service: BuildService;
  version: string | null;
  sha: string | null;
  dirty: 'true' | 'false' | null;
  buildContext: string | null;
  builtAt: string | null;
}

export interface ApiInfo {
  name: 'RelayHall API';
  version: string | null;
  build: BuildIdentity | null;
}

export function semanticVersion(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && SEMVER_PATTERN.test(value)
    ? value
    : null;
}

/** True for a version the release tooling did not stamp. */
export function isUnreleasedVersion(version: string): boolean {
  return version.includes('+');
}

/**
 * The instant a builtAt stamp names, as an ISO string for `<time dateTime>`,
 * or null. The fraction is cut to milliseconds before parsing: engines differ
 * on longer fractions, and HTML allows at most three digits.
 */
export function builtAtInstant(value: string): string | null {
  if (!BUILT_AT_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/**
 * The version this BUNDLE was built as, for the sign-in footer: the release
 * version the release tooling passed at build time, or the package version
 * marked unreleased. About does not use it - About reads each artefact's own
 * served record, so a constant can never stand in for a deployed version.
 */
export function bundleVersion(stamped: string | undefined, packageVersion: string): string {
  const release = semanticVersion(stamped);
  return release && !isUnreleasedVersion(release) ? release : `${packageVersion}${UNRELEASED_SUFFIX}`;
}

export const RELAYHALL_VERSION = bundleVersion(import.meta.env.VITE_RELAYHALL_RELEASE_VERSION, packageInfo.version);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

/** A printable, trimmed, bounded value; the Dockerfile default `unknown` is not one. */
function textField(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value === 'unknown') return null;
  if (value.trim() !== value || value.length > MAX_FIELD_LENGTH || hasControlCharacter(value)) return null;
  return value;
}

/**
 * One artefact's identity, field by field. Throws only when the document is
 * not an identity of `service` at all - then there is nothing to attribute.
 */
export function parseBuildIdentity(value: unknown, service: BuildService): BuildIdentity {
  const item = objectRecord(value, 'Build identity is unavailable');
  if (item.service !== service) throw new Error('Build identity is unavailable');
  return {
    service,
    version: semanticVersion(item.version),
    sha: typeof item.sha === 'string' && SHA_PATTERN.test(item.sha) ? item.sha : null,
    dirty: item.dirty === 'true' || item.dirty === 'false' ? item.dirty : null,
    buildContext: textField(item.buildContext),
    builtAt: typeof item.builtAt === 'string' && builtAtInstant(item.builtAt) !== null ? item.builtAt : null,
  };
}

export function parseReleaseManifest(value: unknown): BuildIdentity {
  return parseBuildIdentity(value, 'relayhall-frontend');
}

export function parseApiInfo(value: unknown): ApiInfo {
  const item = objectRecord(value, 'API version is unavailable');
  if (item.name !== 'RelayHall API') throw new Error('API version is unavailable');
  let build: BuildIdentity | null = null;
  try {
    build = parseBuildIdentity(item.build, 'relayhall-backend');
  } catch {
    // An API root without a backend identity (an older image, or none was
    // stamped): its version still stands, its build fields are unavailable.
  }
  return { name: item.name, version: semanticVersion(item.version), build };
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('Release information is unavailable');
  return response.json();
}

export async function loadReleaseManifest(signal?: AbortSignal): Promise<BuildIdentity> {
  return parseReleaseManifest(await getJson('/release-manifest.json', signal));
}

export async function loadApiInfo(signal?: AbortSignal): Promise<ApiInfo> {
  return parseApiInfo(await getJson(`${API_BASE}/`, signal));
}
