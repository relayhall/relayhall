/**
 * Registry-backed data for the connector-first execution profile form
 * (RH-P2.2): the published Connector list and per-service capability
 * descriptors. A small module-level cache keeps the three task modals from
 * refetching the same registry on every mount (the scout flagged the
 * per-mount fetch pattern of useTaskModelOptions as a hazard to avoid).
 */
import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../utils/auth';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const CACHE_TTL_MS = 60_000;

export interface ConnectorSummary {
  id: string;
  slug: string;
  name: string;
  currentDescriptorVersion: number | null;
}

export interface DescriptorEnumValue {
  value: string;
  label?: string;
}

export interface DescriptorField {
  key: string;
  type: 'enum' | 'boolean' | 'number' | 'string' | 'secretReference' | 'resourceSelector';
  label?: string;
  help?: string;
  required?: boolean;
  default?: string | number | boolean;
  values?: DescriptorEnumValue[];
  allowedReferences?: string[];
  parameters?: DescriptorField[];
}

export interface ConnectorDescriptor {
  version: number;
  retired: boolean;
  options: DescriptorField[];
}

let connectorCache: { at: number; list: ConnectorSummary[] } | null = null;
const descriptorCache = new Map<string, { at: number; descriptor: ConnectorDescriptor }>();

/** Test seam: clears the module caches between vitest cases. */
export function clearConnectorOptionCaches(): void {
  connectorCache = null;
  descriptorCache.clear();
}

async function fetchConnectors(): Promise<ConnectorSummary[]> {
  if (connectorCache && Date.now() - connectorCache.at < CACHE_TTL_MS) return connectorCache.list;
  const response = await authenticatedFetch(`${API_BASE}/services?kind=connector&status=published`);
  if (!response.ok) throw new Error(`services list failed (${response.status})`);
  const data = await response.json();
  const list: ConnectorSummary[] = (data?.services || []).map((service: any) => ({
    id: service.id,
    slug: service.slug,
    name: service.name,
    currentDescriptorVersion: service.currentDescriptorVersion ?? null,
  }));
  connectorCache = { at: Date.now(), list };
  return list;
}

async function fetchDescriptor(serviceId: string): Promise<ConnectorDescriptor> {
  const cached = descriptorCache.get(serviceId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.descriptor;
  const response = await authenticatedFetch(`${API_BASE}/services/${encodeURIComponent(serviceId)}/descriptor`);
  if (!response.ok) throw new Error(`descriptor read failed (${response.status})`);
  const data = await response.json();
  const versionRecord = data?.descriptorVersion || {};
  const descriptor: ConnectorDescriptor = {
    version: versionRecord.version ?? 0,
    retired: Boolean(versionRecord.retiredAt),
    options: versionRecord.descriptor?.options || [],
  };
  descriptorCache.set(serviceId, { at: Date.now(), descriptor });
  return descriptor;
}

export function useConnectors(): { connectors: ConnectorSummary[]; loading: boolean; error: string | null } {
  const [connectors, setConnectors] = useState<ConnectorSummary[]>(connectorCache?.list ?? []);
  const [loading, setLoading] = useState(!connectorCache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchConnectors()
      .then((list) => { if (!cancelled) { setConnectors(list); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'registry unavailable'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { connectors, loading, error };
}

export function useConnectorDescriptor(serviceId: string | null): {
  descriptor: ConnectorDescriptor | null;
  loading: boolean;
  error: string | null;
} {
  const [descriptor, setDescriptor] = useState<ConnectorDescriptor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serviceId) {
      setDescriptor(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchDescriptor(serviceId)
      .then((d) => { if (!cancelled) { setDescriptor(d); setError(null); } })
      .catch((e) => { if (!cancelled) { setDescriptor(null); setError(e instanceof Error ? e.message : 'descriptor unavailable'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [serviceId]);

  return { descriptor, loading, error };
}
