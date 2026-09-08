/**
 * Closed Phase-2 coverage manifest for the generic lifecycle-policy seam.
 *
 * This deliberately covers canonical work-object creation, lifecycle
 * transition, promotion, retirement and destructive boundaries. It does not
 * cover authentication/authorization, ordinary relationship edits, history
 * append operations, notifications, or UI state. Those remain separate
 * contracts and must not become implicit policy grants.
 */
export const LIFECYCLE_POLICY_COVERAGE = [
  { source: 'ProjectService.ts', method: 'create', action: 'project.create' },
  { source: 'ProjectService.ts', method: 'update', action: 'project.update' },
  { source: 'ProjectService.ts', method: 'archive', action: 'project.archive' },
  { source: 'ProjectService.ts', method: 'unarchive', action: 'project.restore' },

  { source: 'ProjectResourceService.ts', method: 'create', action: 'project-resource.create' },
  { source: 'ProjectResourceService.ts', method: 'patch', action: 'project-resource.update' },
  { source: 'ProjectResourceService.ts', method: 'archive', action: 'project-resource.archive' },
  { source: 'ProjectResourceService.ts', method: 'restore', action: 'project-resource.restore' },
  { source: 'ProjectResourceService.ts', method: 'replace', action: 'project-resource.replace' },

  { source: 'PhaseService.ts', method: 'create', action: 'phase.create' },
  { source: 'PhaseService.ts', method: 'update', action: 'phase.update' },
  { source: 'PhaseService.ts', method: 'archive', action: 'phase.archive' },
  { source: 'PhaseService.ts', method: 'unarchive', action: 'phase.restore' },
  { source: 'PhaseService.ts', method: 'remove', action: 'phase.delete' },

  { source: 'TaskManagerDB.ts', method: 'createTask', action: 'task.create' },
  { source: 'TaskManagerDB.ts', method: 'updateTask', action: 'task.transition' },
  { source: 'TaskManagerDB.ts', method: 'deleteTask', action: 'task.delete' },

  { source: 'SkillManager.ts', method: 'transition', action: 'skill-version.transition' },
  { source: 'SkillManager.ts', method: 'delete', action: 'skill.delete' },

  { source: 'ServiceRegistry.ts', method: 'publishDescriptor', action: 'service-descriptor.publish' },
  { source: 'ServiceRegistry.ts', method: 'retireService', action: 'service.retire' },
  { source: 'ServiceRegistry.ts', method: 'retireDescriptorVersion', action: 'service-descriptor.retire' },
  { source: 'ServiceRegistry.ts', method: 'delete', action: 'service.delete' },
] as const;

export type LifecyclePolicyCoveredAction = (typeof LIFECYCLE_POLICY_COVERAGE)[number]['action'];
