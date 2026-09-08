export type SkillVersionStatus = 'draft' | 'review' | 'published' | 'retired';
export type SkillProvenance = 'human-authored' | 'imported' | 'agent-drafted';

export interface SkillVersion {
  id: string;
  skill_id: string;
  version: number;
  skill_md?: string;
  content_sha256: string;
  description: string;
  category: string | null;
  tags: string[];
  config: Record<string, unknown>;
  provenance: SkillProvenance;
  source_uri: string | null;
  created_by_principal_id: string | null;
  created_at: string;
  status: SkillVersionStatus;
  status_note: string | null;
  status_changed_at: string;
}

export interface Skill {
  id: string;
  name: string;
  is_global: boolean;
  current_published_version_id: string | null;
  revision: string;
  created_at: string;
  updated_at: string;
  current_version: SkillVersion | null;
  /** Exact published Version; current_version may instead be a newer draft. */
  published_version: SkillVersion | null;
  version: number | null;
  status: SkillVersionStatus | null;
  category: string | null;
  description: string | null;
  tags: string[];
  config: Record<string, unknown>;
  provenance: SkillProvenance | null;
  content_sha256: string | null;
}

export interface ProjectSkillLink {
  id: string;
  project_id: string;
  skill_id: string;
  skill_version_id: string;
  created_at: string;
  skill: Skill;
  version: SkillVersion;
  /** Retired compatibility display field; immutable pins never override content. */
  override_instructions?: null;
}

export interface CreateSkillInput {
  name: string;
  skill_md?: string;
  description?: string;
  usage_instructions?: string;
  category?: string;
  config?: Record<string, unknown>;
  tags?: string[];
  provenance?: SkillProvenance;
  source_uri?: string;
}

export type UpdateSkillInput = Omit<CreateSkillInput, 'name'>;
