// Pure helpers for the typed project Resource UI (P1.5f).

import {
  Resource,
  ResourceKind,
} from '../types/resource';

/**
 * Safe display summary for a resource value.
 * URLs are reduced to their host only — no path, query, fragment or user-info.
 * Workspace paths are shown as-is (they are already plain paths).
 */
export function safeResourceSummary(resource: Pick<Resource, 'kind' | 'details'>): string {
  const details = resource.details as unknown as Record<string, unknown>;
  if (resource.kind === 'workspace') {
    return typeof details.path === 'string' ? details.path : '';
  }
  const url = typeof details.url === 'string' ? details.url : '';
  return safeHost(url);
}

/**
 * Extract the host from a URL-ish value without exposing credentials,
 * paths, query strings or fragments. Handles https, ssh and scp-like
 * git URLs (git@host:org/repo.git).
 */
export function safeHost(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.host) return parsed.host;
  } catch {
    // fall through to scp-like handling
  }
  // scp-like: [user@]host:path
  const scpMatch = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):/);
  if (scpMatch) return scpMatch[1];
  return '';
}

/**
 * Client-generated idempotency key for the replace operation.
 * Two UUIDs concatenated: 72 characters, within the contract's 16..128 range.
 */
export function makeIdempotencyKey(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`;
}

// Form field labels used by the conflict panel and error summary.
export const RESOURCE_FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  agentVisibility: 'Agent visibility',
  exportPolicy: 'Export policy',
  repositoryUrl: 'Repository URL',
  repositoryRole: 'Repository role',
  repositoryDefaultBranch: 'Default branch',
  environmentUrl: 'Environment URL',
  environmentStage: 'Stage',
  workspacePath: 'Workspace path',
  workspacePurpose: 'Purpose',
  referenceUrl: 'Reference URL',
  referenceCategory: 'Category',
};

/** Which form fields belong to which kind (beyond the common fields). */
export const KIND_FIELD_KEYS: Record<ResourceKind, string[]> = {
  repository: ['repositoryUrl', 'repositoryRole', 'repositoryDefaultBranch'],
  environment: ['environmentUrl', 'environmentStage'],
  workspace: ['workspacePath', 'workspacePurpose'],
  reference: ['referenceUrl', 'referenceCategory'],
};
