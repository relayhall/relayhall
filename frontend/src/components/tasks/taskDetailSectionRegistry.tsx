import type { ReactNode } from 'react';
import type { Task } from '../../types/task';

export type TaskDetailRegion = 'left-rail' | 'content' | 'timeline';

export interface TaskDetailSectionContext {
  sections: Record<string, ReactNode>;
}

export interface TaskDetailSectionDescriptor {
  id: string;
  region: TaskDetailRegion;
  order: number;
  render: (task: Task, context: TaskDetailSectionContext) => ReactNode;
}

const section = (id: string, region: TaskDetailRegion, order: number): TaskDetailSectionDescriptor => ({
  id,
  region,
  order,
  render: (_task, context) => context.sections[id] ?? null,
});

// D9: deliberately static in v1. Future extension points can add registration
// without changing the page's ordered composition contract.
export const TASK_DETAIL_SECTION_REGISTRY: readonly TaskDetailSectionDescriptor[] = [
  section('placement', 'left-rail', 10),
  section('people', 'left-rail', 20),
  section('execution', 'left-rail', 30),
  section('relations', 'left-rail', 40),
  section('dates-counters', 'left-rail', 50),
  section('advanced', 'left-rail', 60),
  section('description', 'content', 10),
  // Candidate A5 (986be411 §7): the structured Definition-of-done and
  // Constraints fields are canonical, so they are first-class sections.
  section('dod', 'content', 12),
  section('constraints', 'content', 14),
  section('agent-instructions', 'content', 20),
  section('notes', 'content', 30),
  section('verifier-settings', 'content', 40),
  section('subtasks', 'content', 50),
  // Candidate A5: create mode's Links slot (edit mode renders links in the
  // Relations rail and provides no 'links' content section — the registry
  // returns null there; candidate A6 makes links editable on the page).
  section('links', 'content', 55),
  section('reports-handovers', 'content', 60),
  section('timeline-rail', 'timeline', 10),
] as const;

export function taskDetailSectionsFor(region: TaskDetailRegion): readonly TaskDetailSectionDescriptor[] {
  return TASK_DETAIL_SECTION_REGISTRY.filter(descriptor => descriptor.region === region)
    .sort((left, right) => left.order - right.order);
}
