import fs from 'fs/promises';
import path from 'path';
import { taskManagerDB, type Task } from './TaskManagerDB';
import { taskReviewerService } from './TaskReviewerService';
import { taskNotificationService } from './TaskNotificationService';
import { logCaughtFailure, logCaughtWarning } from '../utils/secretSafeLog';

interface ReviewerHeartbeatState {
  tasks: Record<string, { fingerprint: string; reviewedAt: string; decision?: string }>;
  updatedAt: string;
}

export interface ReviewerHeartbeatDependencies {
  listReviewTasks(): Promise<Task[]>;
  runReview(taskId: string): Promise<{ decision: 'pass' | 'reject' | 'escalate' }>;
  readState(): Promise<ReviewerHeartbeatState>;
  writeState(state: ReviewerHeartbeatState): Promise<void>;
  retryNotifications?(): Promise<unknown>;
}

function normalizeList(value: string | string[] | undefined | null): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(/\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildReviewerHeartbeatFingerprint(task: Task): string {
  const successCriteria = normalizeList(task.successCriteria ?? task.definitionOfDone).join('|');
  const subtasks = (task.subtasks || [])
    .map((subtask, index) => [
      index,
      subtask.id || '',
      subtask.status || 'empty',
      subtask.reviewNote || '',
      subtask.blockedReason || '',
      subtask.completedAt || '',
    ].join(':'))
    .join('|');

  return [
    task.id,
    task.status,
    task.updated,
    task.attemptCount ?? 0,
    task.maxRetries ?? 3,
    task.needsReview ? 'needs-review' : 'no-review-flag',
    successCriteria,
    subtasks,
  ].join('||');
}

async function readHeartbeatState(stateFile: string): Promise<ReviewerHeartbeatState> {
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      tasks: parsed?.tasks || {},
      updatedAt: parsed?.updatedAt || new Date().toISOString(),
    };
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      logCaughtWarning('[ReviewerHeartbeatService] state read failed', error);
    }
    return { tasks: {}, updatedAt: new Date().toISOString() };
  }
}

async function writeHeartbeatState(stateFile: string, state: ReviewerHeartbeatState): Promise<void> {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const tmpFile = `${stateFile}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmpFile, stateFile);
}

export class ReviewerHeartbeatService {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<string>();
  private running = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private stateFile = '/data/reviewer-heartbeat-state.json';
  private pollIntervalMs: number;
  private readonly deps: ReviewerHeartbeatDependencies;

  constructor(
    pollIntervalMs = 15000,
    deps?: ReviewerHeartbeatDependencies,
  ) {
    this.pollIntervalMs = pollIntervalMs;
    this.deps = deps || {
      listReviewTasks: () => taskManagerDB.queryTasks({ status: 'review' }),
      runReview: (taskId: string) => taskReviewerService.runReview(taskId, { triggeredBy: 'system' }),
      readState: () => readHeartbeatState(this.stateFile),
      writeState: (state: ReviewerHeartbeatState) => writeHeartbeatState(this.stateFile, state),
      retryNotifications: () => taskNotificationService.retryDue(),
    };
  }

  configure(pollIntervalMs: number, stateFile: string): void {
    if (this.timer) {
      throw new Error('Verifier heartbeat cannot be reconfigured after start');
    }
    this.pollIntervalMs = pollIntervalMs;
    this.stateFile = stateFile;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.deps.retryNotifications) {
        try {
          await this.deps.retryNotifications();
        } catch (error) {
          logCaughtFailure('[ReviewerHeartbeatService] notification retry failed', error);
        }
      }
      const [tasks, state] = await Promise.all([
        this.deps.listReviewTasks(),
        this.deps.readState(),
      ]);
      let dirty = false;

      for (const task of tasks) {
        const fingerprint = buildReviewerHeartbeatFingerprint(task);
        const existing = state.tasks[task.id];
        if (this.inFlight.has(task.id)) continue;
        if (existing?.fingerprint === fingerprint) continue;

        this.inFlight.add(task.id);
        try {
          const outcome = await this.deps.runReview(task.id);
          state.tasks[task.id] = {
            fingerprint,
            reviewedAt: new Date().toISOString(),
            decision: outcome.decision,
          };
          state.updatedAt = new Date().toISOString();
          dirty = true;
          console.log(`[ReviewerHeartbeatService] Reviewed ${task.id} → ${outcome.decision}`);
        } catch (error) {
          logCaughtFailure('[ReviewerHeartbeatService] task review failed', error);
        } finally {
          this.inFlight.delete(task.id);
        }
      }

      if (dirty) {
        this.writeQueue = this.writeQueue.then(() => this.deps.writeState(state));
        await this.writeQueue;
      }
    } finally {
      this.running = false;
    }
  }
}

export const reviewerHeartbeatService = new ReviewerHeartbeatService();
