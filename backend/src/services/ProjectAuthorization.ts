// ProjectAuthorization.ts — the shared Project authorization predicate
// (task 47ef04a2; contract 21a04c23 §2.3, strategy §2.3 compiler rule).
//
// Two invariants live here, in one place, so every route that joins objects
// under a Project applies the same test:
//
//   1. Object-level denial is concealed: absence and denial are both 404,
//      with the same code, so a caller cannot enumerate private IDs.
//   2. A child object referenced through a Project route must be bound to
//      that exact Project in the storage predicate BEFORE any private field
//      of the child is read or rendered. Review 20f6068c blocker 2 was
//      precisely this gap in generate-brief: an arbitrary taskId from the
//      request body was fetched and rendered with no proof it belonged to
//      the authorized Project.
import { pool } from '../db/connection';
import { ResourceContractError } from './ProjectResourceService';

export interface AuthorizedProject {
  id: string;
  name: string;
  status: string;
}

export class ProjectAuthorization {
  /**
   * Resolve a Project the caller may read, or throw a concealed 404.
   * Global scope enforcement (projects:read / projects:write) already
   * happened in the auth middleware; this is the object-level step.
   */
  async requireProject(projectId: string): Promise<AuthorizedProject> {
    const result = await pool.query(
      'SELECT id, name, status FROM projects WHERE id = $1',
      [projectId],
    );
    if (result.rows.length === 0) {
      throw new ResourceContractError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    }
    return result.rows[0];
  }

  /** As requireProject, and additionally reject archived Projects for
   * mutation/context surfaces (409 PROJECT_ARCHIVED). */
  async requireActiveProject(projectId: string): Promise<AuthorizedProject> {
    const project = await this.requireProject(projectId);
    if (project.status === 'archived') {
      throw new ResourceContractError(409, 'PROJECT_ARCHIVED', 'Project is archived and read-only; restore it first');
    }
    return project;
  }

  /**
   * Bind a Task to the Project route it was reached through. The predicate
   * carries BOTH ids; a task from any other Project — including one the
   * caller could not read — is indistinguishable from absence. Only the id
   * and title leave this function; the caller re-reads the task through the
   * ordinary task service once binding has been proven.
   */
  async requireTaskInProject(projectId: string, taskId: string): Promise<{ id: string }> {
    if (typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/i.test(taskId)) {
      throw new ResourceContractError(404, 'TASK_NOT_FOUND', 'Task not found');
    }
    const result = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND project_id = $2',
      [taskId, projectId],
    );
    if (result.rows.length === 0) {
      throw new ResourceContractError(404, 'TASK_NOT_FOUND', 'Task not found');
    }
    return result.rows[0];
  }
}

export const projectAuthorization = new ProjectAuthorization();
