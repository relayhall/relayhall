import packageInfo from '../../package.json';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const BUILT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const RELAYHALL_VERSION = packageInfo.version;

export interface ReleaseManifest {
  service: 'relayhall-frontend';
  sha: string;
  dirty: 'false';
  buildContext: string;
  builtAt: string;
}

export interface ApiInfo {
  name: 'RelayHall API';
  version: string;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Release information is unavailable');
  }
  return value as Record<string, unknown>;
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const item = objectRecord(value);
  const builtAt = typeof item.builtAt === 'string' ? Date.parse(item.builtAt) : Number.NaN;
  if (
    item.service !== 'relayhall-frontend' ||
    typeof item.sha !== 'string' || !SHA_PATTERN.test(item.sha) ||
    item.dirty !== 'false' ||
    typeof item.buildContext !== 'string' || item.buildContext.trim() === '' || item.buildContext.trim() !== item.buildContext ||
    typeof item.builtAt !== 'string' || !BUILT_AT_PATTERN.test(item.builtAt) || !Number.isFinite(builtAt)
  ) {
    throw new Error('Release information is unavailable');
  }
  return {
    service: item.service,
    sha: item.sha,
    dirty: item.dirty,
    buildContext: item.buildContext,
    builtAt: item.builtAt,
  };
}

export function parseApiInfo(value: unknown): ApiInfo {
  const item = objectRecord(value);
  if (item.name !== 'RelayHall API' || typeof item.version !== 'string' || item.version.trim() === '') {
    throw new Error('API version is unavailable');
  }
  return { name: item.name, version: item.version.trim() };
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('Release information is unavailable');
  return response.json();
}

export async function loadReleaseManifest(signal?: AbortSignal): Promise<ReleaseManifest> {
  return parseReleaseManifest(await getJson('/release-manifest.json', signal));
}

export async function loadApiInfo(signal?: AbortSignal): Promise<ApiInfo> {
  return parseApiInfo(await getJson(`${API_BASE}/`, signal));
}
