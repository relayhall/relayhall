import { GitBranch, FileText, Globe, Box, Link as LinkIcon, Wrench, Database, Calendar } from 'lucide-react';

/**
 * Unified link type definitions for Task links.
 * Project-level generic links were retired by the P1.5f contract: project
 * facts now live in typed Resources (see types/resource.ts).
 */

// All possible link types (superset, used by task links)
export const LINK_TYPES = [
  'git',
  'doc',
  'url',
  'api',
  'project',
  'dashboard',
  'file',
  'tool',
  'memory',
  'session',
  'report'
] as const;

// Task-specific link types
export const TASK_LINK_TYPES = [
  'project',
  'tool',
  'git',
  'doc',
  'memory',
  'session',
  'report'
] as const;

export type LinkType = typeof LINK_TYPES[number];
export type TaskLinkType = typeof TASK_LINK_TYPES[number];

// Type metadata: labels and icons
export const LINK_TYPE_METADATA: Record<LinkType, { label: string; icon: any }> = {
  git: { label: 'Git repository', icon: GitBranch },
  doc: { label: 'Documentation', icon: FileText },
  url: { label: 'URL', icon: Globe },
  api: { label: 'API', icon: Box },
  project: { label: 'Project', icon: LinkIcon },
  dashboard: { label: 'Dashboard', icon: Globe },
  file: { label: 'File', icon: FileText },
  tool: { label: 'Tool', icon: Wrench },
  memory: { label: 'Memory', icon: Database },
  session: { label: 'Session', icon: Calendar },
  report: { label: 'Report', icon: FileText }
};

// Helper functions (tolerant of legacy type values on stored records)
export function getLinkTypeLabel(type: string): string {
  return LINK_TYPE_METADATA[type as LinkType]?.label || type;
}

export function getLinkTypeIcon(type: string): any {
  return LINK_TYPE_METADATA[type as LinkType]?.icon || Globe;
}

export function isTaskLinkType(type: string): type is TaskLinkType {
  return (TASK_LINK_TYPES as readonly string[]).includes(type);
}
