/**
 * Deployment-neutral model-catalog resolver.
 *
 * The board reads the configured LiteLLM catalog through explicit deployment
 * environment variables and keeps a small static floor for degraded startup.
 * It never reads an agent harness configuration file (strategy F11/A10).
 */

import { logCaughtWarning } from '../utils/secretSafeLog';

/** Cache TTL — 10 minutes. Do not hit LiteLLM per request. */
export const MODEL_CATALOG_TTL_MS = 10 * 60_000;

/** Timeout for the LiteLLM /v1/models probe. */
const LITELLM_TIMEOUT_MS = 4_000;

/** Provider prefixes stripped for equivalence comparison. */
const STRIPPABLE_PREFIXES = [
  'litellm/',
  'anthropic/',
  'openai-codex/',
  'openai/',
  'codex-cli/',
  'codex/',
  'google/',
  'gemini/',
  'hermes/',
];

/**
 * Small degraded-startup floor. Phase 2 replaces these interim model strings
 * with board-native model descriptors.
 */
export const STATIC_FLOOR_MODELS: string[] = [
  'gpt-5.5',
  'openai-codex/gpt-5.5',
  'codex/gpt-5.5',
  // Anthropic ids
  'claude-opus-4-8',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-3-5',
  'anthropic/claude-opus-4-8',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-haiku-3-5',
];

export interface ModelCatalog {
  /** All raw model ids collected across sources (deduped, insertion order). */
  ids: string[];
  /** Normalized set (provider prefixes stripped, lowercased) for comparison. */
  normalized: Set<string>;
  /** Which sources contributed, for diagnostics. */
  sources: {
    litellm: number;
    floor: number;
  };
  /** When this catalog was resolved (ms epoch). */
  resolvedAt: number;
}

/**
 * Normalize a model id for equivalence comparison: strip a single known
 * provider prefix (longest-match first so `openai-codex/` wins over `openai/`)
 * and lowercase. e.g. `openai-codex/gpt-5.5` -> `gpt-5.5`, `codex/gpt-5.5` ->
 * `gpt-5.5`, `litellm/gemini/gemini-3-flash-preview` -> `gemini/gemini-3-flash-preview`.
 *
 * Only the leading provider segment is stripped; nested provider paths inside a
 * LiteLLM route (e.g. `litellm/gemini/...`) keep their inner path so distinct
 * downstream models stay distinct.
 */
export function normalizeModelId(model: string): string {
  let id = String(model || '').trim().toLowerCase();
  if (!id) return '';
  // Longest prefix first to avoid `openai/` shadowing `openai-codex/`.
  const ordered = [...STRIPPABLE_PREFIXES].sort((a, b) => b.length - a.length);
  for (const prefix of ordered) {
    if (id.startsWith(prefix)) {
      id = id.slice(prefix.length);
      break;
    }
  }
  return id;
}

let cache: ModelCatalog | null = null;
let inflight: Promise<ModelCatalog> | null = null;

interface LiteLLMConn {
  baseUrl: string;
  apiKey: string;
}

function readLiteLLMConn(): LiteLLMConn | null {
  const configuredBase = process.env.LITELLM_ADMIN_API_URL || 'http://ai-litellm:4000';
  const apiKey = process.env.LITELLM_MASTER_KEY || '';
  if (!apiKey) return null;
  const trimmed = configuredBase.replace(/\/+$/, '');
  return {
    baseUrl: trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`,
    apiKey,
  };
}

async function fetchLiteLLMModels(conn: LiteLLMConn): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LITELLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${conn.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${conn.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`⚠️ LiteLLM /models returned ${res.status}; skipping live catalog source`);
      return [];
    }
    const body: any = await res.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    const ids: string[] = [];
    for (const entry of data) {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (typeof id === 'string' && id.trim()) {
        const trimmed = id.trim();
        // LiteLLM ids are the raw provider routes; expose them both as-is and
        // under the `litellm/` prefix so config-style pins resolve too.
        ids.push(trimmed);
        if (!trimmed.startsWith('litellm/')) ids.push(`litellm/${trimmed}`);
      }
    }
    return ids;
  } catch (err: any) {
    logCaughtWarning('[ModelCatalog] LiteLLM model discovery failed', err);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCatalog(): Promise<ModelCatalog> {
  let litellmIds: string[] = [];
  const conn = readLiteLLMConn();
  if (conn) {
    litellmIds = await fetchLiteLLMModels(conn);
  }

  // Aggregate and dedupe while preserving source order.
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (list: string[]) => {
    for (const id of list) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  };
  add(litellmIds);
  add(STATIC_FLOOR_MODELS);

  const normalized = new Set<string>();
  for (const id of ids) {
    const n = normalizeModelId(id);
    if (n) normalized.add(n);
  }

  return {
    ids,
    normalized,
    sources: {
      litellm: litellmIds.length,
      floor: STATIC_FLOOR_MODELS.length,
    },
    resolvedAt: Date.now(),
  };
}

/**
 * Return the resolved model catalog, using the cached copy while fresh
 * (~10 min TTL). Concurrent callers during a cold/expired window share a single
 * in-flight resolution so we never fan out multiple LiteLLM probes.
 *
 * @param force - bypass the cache and re-resolve (used by tests / manual refresh)
 */
export async function getModelCatalog(force = false): Promise<ModelCatalog> {
  const now = Date.now();
  if (!force && cache && now - cache.resolvedAt < MODEL_CATALOG_TTL_MS) {
    return cache;
  }
  if (!force && inflight) return inflight;

  const p = resolveCatalog()
    .then((catalog) => {
      cache = catalog;
      return catalog;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  if (!force) inflight = p;
  return p;
}

/** Test/maintenance hook: drop the cached catalog. */
export function clearModelCatalogCache(): void {
  cache = null;
  inflight = null;
}

/**
 * True if `pin` matches some entry in the catalog under normalization.
 * `gpt-5.5`, `openai-codex/gpt-5.5`, `codex/gpt-5.5` are all equivalent.
 */
export function isModelAvailable(pin: string, catalog: ModelCatalog): boolean {
  const n = normalizeModelId(pin);
  if (!n) return false;
  return catalog.normalized.has(n);
}
