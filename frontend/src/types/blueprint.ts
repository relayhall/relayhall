export type BlueprintParameterType = 'string' | 'text' | 'integer' | 'boolean' | 'enum' | 'date' | 'principal-ref' | 'project-ref' | 'phase-ref' | 'skill-ref' | 'personality-ref' | 'service-ref';
export type BlueprintValue = string | number | boolean | null;
export interface BlueprintParameter {
  key: string; label: string; promptText: string; help?: string; type: BlueprintParameterType;
  required?: boolean; default?: BlueprintValue; order?: number;
  constraints?: { min?: number | null; max?: number | null; minLength?: number | null; maxLength?: number | null; enum?: string[] | null; pattern?: string | null };
}
export interface BlueprintDocument {
  schemaVersion: string;
  blueprint: { key: string; version: number; name: string; summary?: string; tags?: string[]; [key: string]: unknown };
  target: { mode: 'new-project' | 'existing-project'; project: string | Record<string, unknown>; [key: string]: unknown };
  parameters: BlueprintParameter[]; references: Record<string, unknown>[]; phases: Record<string, unknown>[];
  tasks: Record<string, unknown>[]; humanGates: Record<string, unknown>[]; reports: Record<string, unknown>[];
  dependencies: { task: string; dependsOn: string }[];
}
export interface BlueprintSummary {
  id: string; key: string; version: number; name: string; summary?: string; tags: string[];
  status?: 'draft' | 'review' | 'published' | 'retired'; authorPrincipalId?: string;
  parameters: BlueprintParameter[]; references: Record<string, unknown>[]; target: BlueprintDocument['target'];
  counts: Record<string, number>; document: BlueprintDocument; projection: 'read' | 'use';
}
export interface BlueprintDetail extends BlueprintSummary {
  status: 'draft' | 'review' | 'published' | 'retired'; contentSha256: string; identitySha256: string;
  availableActions: string[]; statusNote?: string | null; authorPrincipalId?: string;
}
export interface BlueprintReference {
  kind: string; name: string; outcome: 'resolved' | 'missing-required' | 'missing-optional';
  requiredAccess?: string; reason?: string;
  resolved: { kind: string; name: string; id: string; version?: number | string; handle?: string; projectId?: string } | null;
}
export interface BlueprintPlanData {
  target: { mode: string; projectId?: string }; project: Record<string, unknown> | null;
  phases: Record<string, unknown>[]; tasks: (Record<string, unknown> & { key: string; title: string; autoStart: false })[];
  reports: Record<string, unknown>[]; dependencies: { task: string; dependsOn: string }[];
  references: BlueprintReference[];
  authority: { operation: string; scope: string; allowed: boolean; localKey?: string; resourceId?: string; principalIds?: string[] }[];
  humanGates: (Record<string, unknown> & { key: string; disposition: string; allParked: boolean })[];
  refusals: { code: string; error: string; field: string }[];
  counts: Record<string, number>; parameterValues: Record<string, BlueprintValue>;
}
export interface BlueprintRequest {
  target: { mode: 'new-project' | 'existing-project'; project?: string };
  parameterValues: Record<string, BlueprintValue>;
}
export interface BlueprintPreview {
  blueprint: { id: string; key: string; version: number }; plan: BlueprintPlanData; targetArchived: boolean;
}
export interface BlueprintResult {
  executionSetup?: { required: boolean; taskCount: number };
  instantiationId: string; projectId: string; phases: Record<string, string>; tasks: Record<string, string>;
  reports: Record<string, string>; blueprint: { key: string; version: number }; warnings: BlueprintReference[];
}
export interface BlueprintVersion {
  version: number; status: string; status_note?: string | null; status_changed_at?: string;
  author_principal_id?: string; content_sha256?: string; identity_sha256?: string;
}
export interface BlueprintLedgerRow {
  id: string; blueprint_key: string; blueprint_version: number; root_project_id: string;
  actor_principal_id: string; created_at: string; parameter_projection: Record<string, unknown>;
  execution_defaults?: unknown[] | null;
  parameter_values?: Record<string, unknown> | null; reference_outcomes: BlueprintReference[]; response_snapshot: BlueprintResult;
}

export interface BlueprintSetupPlan {
  instantiationId: string; projectId: string; warrantId?: string;
  createWarrant?: {holderPrincipalId:string;ceilingProfileId:string;expiresAt:string};
  grants?: Record<string,unknown>[]; requiresStepUp?: boolean;
  tasks: { id: string; revision: string; title: string; phaseId: string | null; executionProfile: Record<string, unknown> }[];
  allParked: true; assignmentOnly: boolean; confirmationHash: string;
}
export interface BlueprintSetupResult {
  instantiationId: string; taskIds: string[]; warrantId: string; assigned: true; armed: false;
}
