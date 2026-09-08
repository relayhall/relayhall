// Project types for frontend
export type ProjectStatus = 'active' | 'archived';

export interface ProjectStats {
  total_tasks: number;
  completed_tasks: number;
  in_progress_tasks: number;
  active_agents: number;
  last_activity: string | null;
}

export interface Project {
  id: string;
  blueprintKey?: string | null;
  blueprintVersion?: number | null;
  blueprintContentSha256?: string | null;
  blueprintIdentitySha256?: string | null;
  instantiationId?: string | null;
  instantiatedAt?: string | null;
  instantiatedByPrincipalId?: string | null;
  name: string;
  description?: string;
  /** The project's outcome statement (RH-P2.4). A PROPERTY at two altitudes
   *  with the phase goal, never an object of its own (vocabulary D-6). */
  goal?: string | null;
  status: ProjectStatus;
  is_hidden?: boolean;
  /**
   * Opaque concurrency token. Rotates on every mutation; sent back as
   * If-Match on PATCH /projects/{id}, POST /projects/{id}/archive and
   * POST /projects/{id}/unarchive. A stale value yields 412 REVISION_MISMATCH.
   */
  revision: string;
  created_at: string;
  updated_at: string;
  stats?: ProjectStats;
  // NOTE: the API may still return legacy JSONB fields on this record
  // (links, resources and similar). They are deliberately untyped here:
  // the owner-facing UI ignores them. Typed Resources live under
  // /projects/{id}/resources — see types/resource.ts.
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  status?: ProjectStatus;
  is_hidden?: boolean;
}
