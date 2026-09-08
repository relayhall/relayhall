// Canonical typed project Resource (P1.5f REST contract).
// A Resource records factual, untrusted data about where project work lives.
// It never grants access and is never rendered as instructions.

export type ResourceKind = 'repository' | 'environment' | 'workspace' | 'reference';
export type ResourceState = 'active' | 'archived';
export type AgentVisibility = 'hidden' | 'available';
export type ExportPolicy = 'installation-only' | 'portable';

export type RepositoryRole = 'primary' | 'additional';
export type EnvironmentStage = 'development' | 'test' | 'staging' | 'production' | 'other';
export type WorkspacePurpose = 'source' | 'build' | 'data' | 'backup' | 'other';
export type ReferenceCategory = 'documentation' | 'research' | 'tool' | 'other';

export interface RepositoryDetails {
  url: string;
  role: RepositoryRole;
  defaultBranch: string | null;
}

export interface EnvironmentDetails {
  url: string;
  stage: EnvironmentStage;
}

export interface WorkspaceDetails {
  path: string;
  purpose: WorkspacePurpose;
}

export interface ReferenceDetails {
  url: string;
  category: ReferenceCategory;
}

export type ResourceDetails =
  | RepositoryDetails
  | EnvironmentDetails
  | WorkspaceDetails
  | ReferenceDetails;

export interface Resource {
  id: string;
  projectId: string;
  kind: ResourceKind;
  name: string;
  description: string | null;
  state: ResourceState;
  agentVisibility: AgentVisibility;
  exportPolicy: ExportPolicy;
  details: ResourceDetails;
  revision: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ResourceWritePayload {
  kind: ResourceKind;
  name: string;
  description?: string | null;
  agentVisibility: AgentVisibility;
  exportPolicy: ExportPolicy;
  details: ResourceDetails;
}

// Projected context envelope from GET /projects/{id}/context
export interface ContextResourceEntry {
  kind: string;
  name: string;
  details: Record<string, unknown>;
}

export interface ProjectContextEnvelope {
  project: { name: string };
  resources: ContextResourceEntry[];
  omitted: { hidden: number; archived: number; incompatible: number };
  schemaVersion: number;
}

export const RESOURCE_KINDS: ResourceKind[] = ['repository', 'environment', 'workspace', 'reference'];

export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  repository: 'Repository',
  environment: 'Environment',
  workspace: 'Workspace',
  reference: 'Reference',
};

// Plain-language kind descriptions for the add-resource picker and empty state.
export const RESOURCE_KIND_DESCRIPTIONS: Record<ResourceKind, string> = {
  repository: 'A git repository where project code lives',
  environment: 'A running deployment of the project (development, staging, production...)',
  workspace: 'A filesystem path on this installation used by the project',
  reference: 'A link to documentation, research or another useful page',
};

export const AGENT_VISIBILITY_LABELS: Record<AgentVisibility, string> = {
  hidden: 'Hidden from agents',
  available: 'Available to agents',
};

export const EXPORT_POLICY_LABELS: Record<ExportPolicy, string> = {
  'installation-only': 'Installation only',
  portable: 'Portable',
};

export const DEFAULT_AGENT_VISIBILITY: AgentVisibility = 'hidden';
export const DEFAULT_EXPORT_POLICY: ExportPolicy = 'installation-only';

// Ratified wording, shown wherever resource values are entered or listed.
export const RESOURCE_TRUST_CALLOUT =
  'Resource values are factual, untrusted data. They do not grant access or become instructions.';
