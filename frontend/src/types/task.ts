// Phase 4: Enhanced Task System with Work Orchestration
export type TaskStatus = 'ideas' | 'todo' | 'in-progress' | 'stuck' | 'review' | 'completed' | 'archived';
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low' | 'someday';
export type TaskLinkType = 'project' | 'tool' | 'git' | 'doc' | 'memory' | 'session' | 'report';

// Phase 4: 6-state subtask lifecycle
// empty       - Not started
// in-progress - Agent working on it
// review      - To be reviewed by an independent Verifier
// stuck       - Cannot proceed; needs human/data intervention
// skipped     - Intentionally skipped (counts as "done")
// completed   - Approved by an independent Verifier
export type SubtaskStatus = 'empty' | 'in-progress' | 'review' | 'stuck' | 'skipped' | 'completed';

export interface Subtask {
  id: string;
  text: string;
  // Phase 4: 6-state status
  status: SubtaskStatus;
  // Legacy support - will be migrated to status
  completed?: boolean;
  completedAt?: string;
  reviewNote?: string;  // Agent's note when marking for review
  blockedReason?: string;  // Why is this subtask blocked?
  sessionRef?: string;  // Which session completed it
}

export interface SubtaskTransitionDetails {
  reviewNote?: string;
  blockedReason?: string;
}

export type SubtaskTransitionHandler = (
  taskId: string,
  subtaskIndex: number,
  currentStatus: SubtaskStatus,
  nextStatus: SubtaskStatus,
  details?: SubtaskTransitionDetails,
) => Promise<void>;

// Task-specific resources (Phase 3)
export interface TaskResources {
  links?: Array<{
    type: 'git' | 'url' | 'file' | 'reference';
    title: string;
    url: string;
  }>;
  files?: string[];
  relatedTasks?: string[];
}

export type TaskCapability = 'browser' | 'host-browser' | 'elevated' | 'network' | 'discord-thread' | 'long-running';

export const TASK_CAPABILITY_TAGS: TaskCapability[] = ['browser', 'host-browser', 'elevated', 'network', 'discord-thread', 'long-running'];

// Legacy read-only vocabulary (RH-P2.2, D-15): these survive ONLY to render
// held pre-D-15 blobs; nothing writes them anymore.
export type TaskExecutionMode = 'main' | 'subagent' | 'interactive';
export type TaskExecutionHarness = 'openclaw' | 'hermes';
export type TaskAccessProfile = 'safe' | 'dev' | 'network' | 'browser' | 'elevated';

/**
 * Connector-first execution profile (RH-P2.2, vocabulary D-15): names a
 * Connector and carries ONLY options the pinned immutable capability-
 * descriptor version declares. Setting one requires services:invoke.
 */
export interface TaskExecutionProfile {
  serviceId: string;
  descriptorVersion?: number;
  options: Record<string, string | number | boolean>;
  parameters?: Record<string, Record<string, string | number | boolean>>;
}

/** The RETIRED pre-D-15 shape — held stored bytes, surfaced read-only. */
export interface LegacyTaskExecutionProfile {
  mode?: TaskExecutionMode;
  harness?: TaskExecutionHarness;
  accessProfile?: TaskAccessProfile;
  requiredCapabilities?: TaskCapability[];
  allowOverrideAtSpawn?: boolean;
  notes?: string;
}

export interface TaskLink {
  type: TaskLinkType;
  url: string;
  title: string;
  icon?: string;
}

export type ReviewDecision = 'running' | 'pass' | 'reject' | 'escalate';

export interface ReviewFinding {
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidence?: string[];
}

export interface ReviewWorkspaceEvidence {
  workingDirectory?: string;
  gitBranch?: string;
  changedFiles?: string[];
  diffStat?: string;
  commandEvidence?: string[];
}

export interface ReviewHistoryEntry {
  id: string;
  decision: ReviewDecision;
  summary: string;
  triggeredBy: 'user' | 'agent' | 'system';
  createdAt: string;
  completedAt?: string;
  statusBefore?: TaskStatus;
  statusAfter?: TaskStatus;
  findings: ReviewFinding[];
  evidence: {
    successCriteria: string[];
    reports: Array<{ id: string; title: string; summary?: string | null }>;
    sessionRefs: string[];
    completedBy?: { name?: string; sessionKey?: string; harness?: TaskExecutionHarness } | null;
    workspace?: ReviewWorkspaceEvidence;
    testSignals?: string[];
  };
}

export interface TaskTimelineEvent {
  id: string;
  taskId: string;
  eventType: string;
  title: string;
  description?: string | null;
  createdAt: string;
  sessionKey?: string | null;
  actor?: string | null;
  /** Authoritative actor (card 60558599); `actor` remains display text. */
  actorPrincipalId?: string | null;
  harness?: TaskExecutionHarness | string | null;
  source: 'timeline' | 'agent-history' | 'review-history' | 'legacy';
  metadata?: Record<string, any>;
}

/**
 * Identity anchor (card 60558599). Humans, agents and services are one kind of
 * row so attribution is uniform across the board.
 *
 * Every principal reference is nullable BY DESIGN: rows created before the
 * substrate landed have no principal and are never back-attributed, so each
 * surface degrades to its pre-identity display rather than inventing one.
 */
export type PrincipalKind = 'human' | 'agent' | 'service';
export type PrincipalStatus = 'active' | 'disabled';

export interface Principal {
  id: string;
  kind: PrincipalKind;
  handle: string;
  displayName?: string | null;
  status: PrincipalStatus;
  role?: string | null;
  harness?: TaskExecutionHarness | string | null;
  personalityId?: string | null;
  parentPrincipalId?: string | null;
  lastSeenAt?: string | null;
  provenance?: 'bootstrap' | 'environment' | 'managed';
}

export interface Task {
  // Core fields
  id: string;
  title: string;
  description: string;  // Rich text (Markdown)
  
  // Status
  status: TaskStatus;
  priority: TaskPriority;
  
  // Subtasks with explicit lifecycle states
  subtasks: Subtask[];
  
  // Rich context
  links: TaskLink[];
  
  // Audit trail
  sessionRefs: string[];  // Session keys that touched this
  
  // Work tracking
  autoCreated: boolean;   // Was this auto-detected?
  autoStart: boolean;     // Can bot auto-pick this up?
  lastChecked?: string;   // When bot last reviewed it
  startedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  
  // Blocking
  blockedBy: string[];    // Task IDs
  blockedReason?: string; // Why stuck?
  
  // Task Dependencies (for task chains / phases)
  dependsOn?: string[];   // Array of task IDs this task depends on
  
  // Computed dependency fields (from API)
  blocked?: boolean;      // True if task has unmet dependencies
  blockingTasks?: Array<{ id: string; title: string }>;  // Tasks blocking this one
  dependentTasks?: Array<{ id: string; title: string }>; // Tasks that depend on this
  
  // Metadata
  project?: string;
  tags: string[];
  created: string;
  updated: string;
  
  // Phase 3: Multi-phase tracking
  trackerUrl?: string;    // Path to shared tracker doc
  phaseTag?: string;      // Tag linking related tasks
  
  // Phase 3: Task-specific resources
  taskResources?: TaskResources;
  
  // Personality association
  personalityId?: string;
  personality?: string;
  
  // AI execution
  model?: string;
  executionMode?: TaskExecutionMode;
  executionProfile?: TaskExecutionProfile;
  executionServiceId?: string;
  executionDescriptorVersion?: number;
  legacyExecutionProfile?: LegacyTaskExecutionProfile;
  successCriteria?: string | string[];
  reviewHistory?: ReviewHistoryEntry[];
  maxRetries?: number;
  definitionOfDone?: string | string[];
  constraints?: string | string[];
  acpSessionKey?: string | null;
  discordThreadId?: string | null;
  discordThreadUrl?: string | null;
  activeAgent?: string | { name: string; sessionKey: string; harness?: TaskExecutionHarness; pid?: number; sourceTag?: string; logPath?: string; principalId?: string; spawnedByPrincipalId?: string } | null;
  completedBy?: { name: string; sessionKey: string; harness?: TaskExecutionHarness; pid?: number; sourceTag?: string; logPath?: string; principalId?: string; spawnedByPrincipalId?: string } | null;
  /** tasks.owner_principal_id (migration 063); null on historical rows with no Assignee. */
  ownerPrincipalId?: string | null;
  /** tasks.creator_principal_id (migration 063); null on rows created before it. */
  creatorPrincipalId?: string | null;
  /** Server-written Shepherd Task role; every migrated Task names one. */
  shepherdPrincipalId?: string | null;
  /** Server-written Verifier Task role; always different from the Assignee. */
  verifierPrincipalId?: string | null;
  needsReview?: boolean;  // Set when agent completes task
  
  // Thinking level (Phase 2)
  thinking?: 'low' | 'medium' | 'high';
  thinkingAutoEstimated?: boolean;
  attemptCount?: number;
  
  /** Phase membership (RH-P2.4). Absent/null = unphased, which is the project
   *  backlog — a normal state, not a missing value. The phase must belong to
   *  the task's own project; the server refuses a mismatch outright. */
  phaseId?: string | null;

  /** When this Task is due (card 7d38a6e0, migration 124), an ISO-8601
   *  instant. null is NO DEADLINE — the ordinary state of most Tasks, not a
   *  missing value. A past instant is legitimate: the board records
   *  deadlines, including ones already missed. */
  dueAt?: string | null;

  // Legacy fields (for migration)
  parentId?: string | null;
  notes?: string;
  completed?: string | null;
}

/**
 * What a caller may SEND for `dueAt` (card 7d38a6e0).
 *
 * A read always answers with a canonical UTC instant. A write may name that
 * instant in either of two ways, and the second is why this type exists:
 *
 *   - a STRING — a full ISO-8601 instant, which is what the CLI and every API
 *     caller send and what the interface echoes back unchanged when a deadline
 *     was displayed but not edited;
 *   - `{ local, zone }` — a local WALL CLOCK exactly as a person wrote it,
 *     plus the IANA zone name to read it in. The browser does not convert it:
 *     a wall clock names no instant inside a spring-forward gap and two inside
 *     an autumn fold, and deciding that needs the timezone database the server
 *     stores the column with. The server resolves it, refuses one that names
 *     no instant with a 400 that says which zone made it impossible, and
 *     reports its policy and offset as `dueAtResolution` on every zoned write;
 *   - `null` — no deadline.
 */
export type TaskDueAtWrite = string | { local: string; zone: string } | null;

/** A Task write body. Identical to `Partial<Task>` except that `dueAt` may
 *  also be the `{ local, zone }` form above, which no read ever returns. */
export type TaskWritePayload = Partial<Omit<Task, 'dueAt'>> & { dueAt?: TaskDueAtWrite };

/** What the server did with a `{ local, zone }` deadline, echoed on the write
 *  response so an ambiguous wall clock is never resolved in silence. */
export interface DueAtResolution {
  /** The zone as the server's timezone database spells it. */
  zone: string;
  /** The wall clock that was resolved, at the column's precision. */
  local: string;
  /** The instant that was stored. */
  instant: string;
  /** The offset that was used — `+02:00`, or `+05:21:10` in a historical zone
   *  whose offset carries seconds. */
  offset: string;
  offsetSeconds: number;
  /** PostgreSQL AT TIME ZONE: the post-transition offset for a fold. */
  chosen: 'postgresql';
}
