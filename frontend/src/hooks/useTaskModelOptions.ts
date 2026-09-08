import { useEffect, useMemo, useState } from 'react';
import { authenticatedFetch } from '../utils/auth';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

interface ModelCatalogEntry {
  id: string;
  normalized?: string;
}

interface ModelCatalogResponse {
  success?: boolean;
  models?: ModelCatalogEntry[];
  ids?: string[];
}

export interface TaskModelOption {
  value: string;
  label: string;
}

function buildOptions(data: ModelCatalogResponse | null, currentModel?: string): TaskModelOption[] {
  const options: TaskModelOption[] = [{ value: '', label: 'Default (configured default)' }];
  const seen = new Set<string>(['']);

  for (const model of data?.models || []) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    options.push({ value: model.id, label: model.id });
  }

  if (currentModel && !seen.has(currentModel)) {
    options.push({ value: currentModel, label: `${currentModel} (legacy/unavailable)` });
  }

  return options;
}

/**
 * Model options for the task execution-profile pickers.
 *
 * Sourced from GET /models/available — the interim read-only LiteLLM-backed
 * catalog (P1.3 ruling A10; the observation-fed status endpoint was
 * retired). Phase-2 model descriptors replace this coupling.
 */
export function useTaskModelOptions(currentModel?: string) {
  const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchModels = async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE}/models/available`);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data?.success !== false) {
          setCatalog(data);
        }
      } catch {
        // Silent fallback to current value only.
      }
    };

    fetchModels();

    return () => {
      cancelled = true;
    };
  }, []);

  const modelOptions = useMemo(() => buildOptions(catalog, currentModel), [catalog, currentModel]);

  return { modelOptions, modelCatalog: catalog };
}
