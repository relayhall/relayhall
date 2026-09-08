import { randomUUID } from 'crypto';
import { NotFoundFault } from '../utils/httpErrors';
import {
  type ReviewFinding,
  type ReviewHistoryEntry,
  type Task,
  type TaskStatus,
  allSubtaskStatusesDone,
  taskManagerDB,
} from './TaskManagerDB';
import { reportManager, type ReviewerReportSummary } from './ReportManager';
import { notificationManager } from './NotificationManager';
import { taskNotificationService } from './TaskNotificationService';
import { discordThreadService } from './DiscordThreadService';
import {
  taskReviewAttemptService,
  type ReviewAttemptIdentity,
  type TaskReviewAttemptService,
} from './TaskReviewAttemptService';

const DEFAULT_MAX_RETRIES = 3;
const REVIEW_HISTORY_LIMIT = 20;
const POSITIVE_TEST_SIGNAL_PATTERN = /(?:\b\d+\s+(?:tests?\s+)?passed\b|\b(?:pytest|jest|vitest|npm test|pnpm test|bun test|cargo test|go test|tests?)\b.{0,80}\bpass(?:ed|ing)?\b|\b(?:build|compile|lint|type[ -]?check)\b.{0,80}\b(?:succeeded|passed|exit(?:ed)?\s+0)\b)/i;
const NEGATIVE_TEST_SIGNAL_PATTERN = /\b(?:pytest|jest|vitest|npm test|pnpm test|bun test|cargo test|go test|tests?|build|compile|lint|type[ -]?check)\b.{0,80}\b(?:fail(?:ed|ing|ure)?|errored|timeout|timed out)\b/i;
const RESOLVED_NEGATIVE_PATTERN = /\b(?:resolved|fixed|now|then|subsequently|after (?:the )?fix)\b.{0,60}\bpass(?:ed|ing)?\b/i;
const TEST_REQUIRED_PATTERN = /\b(?:tests?|build|compile|lint|type[ -]?check)\b/i;

export interface ReviewerDependencies {
  getTask(taskId: string): Promise<Task | undefined>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task>;
  getReportsForTask(taskId: string): Promise<ReviewerReportSummary[]>;
  notifyEscalation(task: Task, summary: string): Promise<void>;
  resolveReviewedSubtasks?(taskId: string, outcome: 'accepted' | 'rejected' | 'stuck', note?: string): Promise<boolean>;
}

export interface ReviewOutcome {
  decision: 'pass' | 'reject' | 'escalate';
  summary: string;
  findings: ReviewFinding[];
  evidence: ReviewHistoryEntry['evidence'];
  applied: {
    status: TaskStatus;
    attemptCount: number;
    maxRetries: number;
    reviewHistoryLength: number;
    mutated: boolean;
  };
  historyEntry: ReviewHistoryEntry;
}

interface RunReviewOptions {
  dryRun?: boolean;
  triggeredBy?: 'user' | 'agent' | 'system';
}

function normalizeTextList(value: string | string[] | undefined | null): string[] {
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

function truncate(text: string, max = 200): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 3)}...`;
}

export class TaskReviewerService {
  private readonly attemptService?: TaskReviewAttemptService;

  constructor(
    private readonly deps: ReviewerDependencies = defaultDependencies,
    attemptService?: TaskReviewAttemptService,
  ) {
    this.attemptService = attemptService || (deps === defaultDependencies ? taskReviewAttemptService : undefined);
  }

  async runReview(taskId: string, options: RunReviewOptions = {}): Promise<ReviewOutcome> {
    const task = await this.requireTask(taskId);
    const triggeredBy = options.triggeredBy || 'user';
    const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;
    const successCriteria = normalizeTextList(task.successCriteria ?? task.definitionOfDone);
    const reports = await this.deps.getReportsForTask(task.id);
    const testSignals = this.extractTestSignals(reports);
    const negativeTestSignals = this.extractNegativeTestSignals(reports);
    const evidence: ReviewHistoryEntry['evidence'] = {
      successCriteria,
      reports: reports.map((report) => ({ id: report.id, title: report.title, summary: report.summary })),
      sessionRefs: task.sessionRefs || [],
      completedBy: task.completedBy
        ? {
            name: task.completedBy.name,
            sessionKey: task.completedBy.sessionKey,
            harness: task.completedBy.harness,
          }
        : null,
      testSignals,
    };

    let attempt: ReviewAttemptIdentity | undefined;
    if (!options.dryRun && this.attemptService) {
      attempt = await this.attemptService.beginAttempt(task, evidence);
    }

    const findings: ReviewFinding[] = [];
    if (task.status !== 'review') {
      findings.push({
        severity: 'error',
        message: `Task is not currently in review (status=${task.status}).`,
        evidence: [task.status],
      });
    }

    const subtasks = task.subtasks || [];
    const firstReviewIndex = subtasks.findIndex((subtask) => subtask.status === 'review');
    const invalidPrefix = firstReviewIndex < 0
      ? subtasks
      : subtasks.slice(0, firstReviewIndex).filter((subtask) => !['completed', 'skipped'].includes(subtask.status));
    const reviewGap = firstReviewIndex >= 0 && subtasks
      .slice(firstReviewIndex + 1)
      .some((subtask, relativeIndex) => subtask.status === 'review'
        && subtasks[firstReviewIndex + relativeIndex].status !== 'review');
    if (firstReviewIndex < 0 || invalidPrefix.length > 0 || reviewGap) {
      findings.push({
        severity: 'error',
        message: 'Task is not ready for review: review items must form a contiguous slice after a completed/skipped prefix.',
        evidence: invalidPrefix.map((subtask) => `[${subtask.status}] ${subtask.text}`),
      });
    }

    if (successCriteria.length === 0) {
      findings.push({
        severity: 'error',
        message: 'Task has no explicit success criteria for the automated Verifier to evaluate.',
      });
    }

    if (reports.length === 0) {
      findings.push({
        severity: 'error',
        message: 'No linked review report was found; session metadata alone cannot prove an implementation attempt.',
      });
    }

    if (negativeTestSignals.length > 0) {
      findings.push({
        severity: 'error',
        message: 'Linked evidence contains an unresolved failing test/build signal.',
        evidence: negativeTestSignals,
      });
    }

    if (successCriteria.some((criterion) => TEST_REQUIRED_PATTERN.test(criterion)) && testSignals.length === 0) {
      findings.push({
        severity: 'error',
        message: 'Success criteria require tests/build validation, but no positive test/build signal was found in linked reports.',
      });
    }

    let decision: ReviewOutcome['decision'] = 'pass';
    if (findings.some((finding) => finding.severity === 'error')) {
      decision = successCriteria.length === 0 ? 'escalate' : 'reject';
    }
    const countsAsRejection = decision === 'reject';

    const allDoneAfterAcceptance = (task.subtasks || []).every((subtask) =>
      subtask.status === 'completed' || subtask.status === 'skipped' || subtask.status === 'review');
    let nextStatus: TaskStatus = decision === 'pass'
      ? (allDoneAfterAcceptance ? 'completed' : 'todo')
      : task.status;
    let nextAttemptCount = task.attemptCount ?? 0;
    if (decision === 'reject') {
      nextAttemptCount += 1;
      if (nextAttemptCount >= maxRetries) {
        decision = 'escalate';
        nextStatus = 'stuck';
        findings.push({
          severity: 'error',
          message: `The automated Verifier retry budget exhausted (${nextAttemptCount}/${maxRetries}).`,
        });
      } else {
        nextStatus = 'todo';
      }
    } else if (decision === 'escalate') {
      nextStatus = 'stuck';
    }

    const summary = this.buildSummary(decision, task, findings, nextAttemptCount, maxRetries);
    const historyEntry: ReviewHistoryEntry = {
      id: randomUUID(),
      decision,
      summary,
      triggeredBy,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      statusBefore: task.status,
      statusAfter: nextStatus,
      findings,
      evidence,
    };

    const reviewHistory = [...(task.reviewHistory || []), historyEntry].slice(-REVIEW_HISTORY_LIMIT);

    let mutated = false;
    let persistedReviewHistoryLength = reviewHistory.length;
    if (!options.dryRun) {
      let authoritativeVerdictApplied = true;
      if (attempt && this.attemptService) {
        const applied = await this.attemptService.recordVerdict(
          attempt.id,
          decision,
          findings,
          { summary, historyEntryId: historyEntry.id },
          undefined,
          countsAsRejection,
        );
        nextStatus = applied.status as TaskStatus;
        nextAttemptCount = applied.attemptCount;
        historyEntry.statusAfter = nextStatus;
        authoritativeVerdictApplied = applied.applied;
      }
      if (authoritativeVerdictApplied) {
        const attemptResolvedImmutableSlice = Boolean(attempt && this.attemptService);
        let fallbackSubtasks: Task['subtasks'] | undefined;
        if (decision === 'pass' && !attemptResolvedImmutableSlice) {
          if (this.deps.resolveReviewedSubtasks) {
            const allDone = await this.deps.resolveReviewedSubtasks(task.id, 'accepted', summary);
            nextStatus = allDone ? 'completed' : 'todo';
          } else {
            const completedAt = new Date().toISOString();
            fallbackSubtasks = (task.subtasks || []).map((subtask) => subtask.status === 'review'
              ? {
                ...subtask,
                status: 'completed' as const,
                completed: true,
                reviewNote: summary,
                blockedReason: undefined,
                completedAt,
              }
              : subtask);
            nextStatus = allSubtaskStatusesDone(fallbackSubtasks.map((subtask) => subtask.status))
              ? 'completed'
              : 'todo';
          }
          historyEntry.statusAfter = nextStatus;
        } else if (decision === 'reject' && !attemptResolvedImmutableSlice) {
          if (this.deps.resolveReviewedSubtasks) {
            await this.deps.resolveReviewedSubtasks(task.id, 'rejected', summary);
          } else {
            fallbackSubtasks = (task.subtasks || []).map((subtask) => subtask.status === 'review'
              ? {
                ...subtask,
                status: 'empty' as const,
                completed: false,
                reviewNote: summary,
                blockedReason: undefined,
                completedAt: undefined,
              }
              : subtask);
          }
          nextStatus = 'todo';
          historyEntry.statusAfter = nextStatus;
        } else if (decision === 'escalate' && !attemptResolvedImmutableSlice) {
          if (this.deps.resolveReviewedSubtasks) {
            await this.deps.resolveReviewedSubtasks(task.id, 'stuck', summary);
          } else {
            fallbackSubtasks = (task.subtasks || []).map((subtask) => subtask.status === 'review'
              ? {
                ...subtask,
                status: 'stuck' as const,
                completed: false,
                reviewNote: summary,
                blockedReason: summary,
                completedAt: undefined,
              }
              : subtask);
          }
        }
        await this.deps.updateTask(task.id, {
          status: nextStatus,
          attemptCount: nextAttemptCount,
          reviewHistory,
          needsReview: decision === 'escalate',
          ...(fallbackSubtasks ? { subtasks: fallbackSubtasks } : {}),
        });
        mutated = true;
      } else {
        // A competing Verifier already committed this attempt. The attempt row
        // is authoritative; do not append duplicate compatibility history or
        // repeat escalation side effects from this stale outcome.
        const current = await this.requireTask(task.id);
        nextStatus = current.status;
        nextAttemptCount = current.attemptCount ?? nextAttemptCount;
        historyEntry.statusAfter = nextStatus;
        persistedReviewHistoryLength = current.reviewHistory?.length || 0;
      }
      if (decision === 'escalate' && authoritativeVerdictApplied) {
        await this.deps.notifyEscalation(task, summary);
      }
    }

    return {
      decision,
      summary,
      findings,
      evidence,
      applied: {
        status: nextStatus,
        attemptCount: nextAttemptCount,
        maxRetries,
        reviewHistoryLength: persistedReviewHistoryLength,
        mutated,
      },
      historyEntry,
    };
  }

  async rejectTask(taskId: string, reason: string, options: RunReviewOptions = {}): Promise<ReviewOutcome> {
    const task = await this.requireTask(taskId);
    const triggeredBy = options.triggeredBy || 'user';
    const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;
    let nextAttemptCount = (task.attemptCount ?? 0) + 1;
    const exhausted = nextAttemptCount >= maxRetries;
    const decision: ReviewOutcome['decision'] = exhausted ? 'escalate' : 'reject';
    let nextStatus: TaskStatus = exhausted ? 'stuck' : 'todo';
    const findings: ReviewFinding[] = [{ severity: 'error', message: reason }];
    const summary = exhausted
      ? `Verifier escalation after manual rejection: ${reason}`
      : `Verifier rejected task: ${reason}`;
    const manualEvidence: ReviewHistoryEntry['evidence'] = {
      successCriteria: normalizeTextList(task.successCriteria ?? task.definitionOfDone),
      reports: [],
      sessionRefs: task.sessionRefs || [],
      completedBy: task.completedBy
        ? {
            name: task.completedBy.name,
            sessionKey: task.completedBy.sessionKey,
            harness: task.completedBy.harness,
          }
        : null,
    };
    const attempt = this.attemptService
      ? await this.attemptService.beginAttempt(task, manualEvidence)
      : undefined;
    const historyEntry: ReviewHistoryEntry = {
      id: randomUUID(),
      decision,
      summary,
      triggeredBy,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      statusBefore: task.status,
      statusAfter: nextStatus,
      findings,
      evidence: manualEvidence,
    };
    const reviewHistory = [...(task.reviewHistory || []), historyEntry].slice(-REVIEW_HISTORY_LIMIT);

    let authoritativeVerdictApplied = true;
    let persistedReviewHistoryLength = reviewHistory.length;
    if (attempt && this.attemptService) {
      const applied = await this.attemptService.recordVerdict(
        attempt.id,
        decision,
        findings,
        { summary, historyEntryId: historyEntry.id },
        undefined,
        true,
      );
      nextStatus = applied.status as TaskStatus;
      nextAttemptCount = applied.attemptCount;
      historyEntry.statusAfter = nextStatus;
      authoritativeVerdictApplied = applied.applied;
    }
    if (authoritativeVerdictApplied) {
      if (!(attempt && this.attemptService)) {
        await this.deps.resolveReviewedSubtasks?.(
          task.id,
          decision === 'escalate' ? 'stuck' : 'rejected',
          summary,
        );
      }
      await this.deps.updateTask(task.id, {
        status: nextStatus,
        attemptCount: nextAttemptCount,
        reviewHistory,
        needsReview: decision === 'escalate',
      });
    } else {
      const current = await this.requireTask(task.id);
      nextStatus = current.status;
      nextAttemptCount = current.attemptCount ?? nextAttemptCount;
      historyEntry.statusAfter = nextStatus;
      persistedReviewHistoryLength = current.reviewHistory?.length || 0;
    }
    if (decision === 'escalate' && authoritativeVerdictApplied) {
      await this.deps.notifyEscalation(task, summary);
    }

    return {
      decision,
      summary,
      findings,
      evidence: historyEntry.evidence,
      applied: {
        status: nextStatus,
        attemptCount: nextAttemptCount,
        maxRetries,
        reviewHistoryLength: persistedReviewHistoryLength,
        mutated: authoritativeVerdictApplied,
      },
      historyEntry,
    };
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.deps.getTask(taskId);
    if (!task) {
      throw new NotFoundFault(`Task not found: ${taskId}`, 'TASK_NOT_FOUND');
    }
    return task;
  }

  private extractTestSignals(reports: ReviewerReportSummary[]): string[] {
    const signals = new Set<string>();
    const candidates = reports.map((report) => `${report.title}\n${report.summary || ''}\n${report.content || ''}`);

    for (const candidate of candidates) {
      for (const line of candidate.split(/\n+/)) {
        const trimmed = line.trim();
        if (trimmed && POSITIVE_TEST_SIGNAL_PATTERN.test(trimmed)) {
          signals.add(truncate(trimmed));
        }
      }
    }

    return Array.from(signals).slice(0, 10);
  }

  private extractNegativeTestSignals(reports: ReviewerReportSummary[]): string[] {
    const signals = new Set<string>();
    const candidates = reports.map((report) => `${report.title}\n${report.summary || ''}\n${report.content || ''}`);

    for (const candidate of candidates) {
      for (const line of candidate.split(/\n+/)) {
        const trimmed = line.trim();
        if (
          trimmed
          && NEGATIVE_TEST_SIGNAL_PATTERN.test(trimmed)
          && !RESOLVED_NEGATIVE_PATTERN.test(trimmed)
        ) {
          signals.add(truncate(trimmed));
        }
      }
    }

    return Array.from(signals).slice(0, 10);
  }

  private buildSummary(
    decision: ReviewOutcome['decision'],
    task: Task,
    findings: ReviewFinding[],
    attemptCount: number,
    maxRetries: number,
  ): string {
    if (decision === 'pass') {
      return `The automated Verifier passed task ${task.id.slice(0, 8)} with ${findings.length} finding(s).`;
    }
    const topFinding = findings.find((finding) => finding.severity === 'error') || findings[0];
    const prefix = decision === 'escalate' ? 'The automated Verifier escalated' : 'The automated Verifier rejected';
    return `${prefix} task ${task.id.slice(0, 8)} (${attemptCount}/${maxRetries} attempts): ${topFinding?.message || 'unspecified issue'}`;
  }
}

const INTERNAL_REVIEWER_ACTOR = {
  principalId: null,
  handle: 'task-reviewer-service',
  role: 'reviewer',
} as const;

const defaultDependencies: ReviewerDependencies = {
  getTask: (taskId: string) => taskManagerDB.getTask(taskId),
  updateTask: (taskId: string, updates: Partial<Task>) => taskManagerDB.updateTask(taskId, updates, INTERNAL_REVIEWER_ACTOR),
  getReportsForTask: (taskId: string) => reportManager.getByTaskId(taskId),
  resolveReviewedSubtasks: (taskId, outcome, note) => taskManagerDB.resolveReviewedSubtasks(taskId, outcome, note),
  notifyEscalation: async (task: Task, summary: string) => {
    await notificationManager.notifyStatusChange(task.id, task.title, task.status, 'stuck', 'system');
    const notificationDestination = task.discordThreadId || discordThreadService.getSystemNotificationChannelId();
    if (notificationDestination) {
      const result = await taskNotificationService.deliver({
        taskId: task.id,
        kind: 'review-escalation',
        stateVersion: `attempt-${(task.attemptCount ?? 0) + 1}`,
        destination: notificationDestination,
        message: [
          '## 🚨 RelayHall review escalation',
          `**${task.title}** exhausted its bounded review retry budget and requires independent human/orchestrator attention.`,
          summary,
        ].join('\n\n'),
      });
      if (result.status === 'failed') {
        console.warn(`[TaskReviewerService] Discord escalation delivery for ${task.id} remains retryable`);
      }
    }
    console.warn(`[TaskReviewerService] Escalated task ${task.id}: ${summary}`);
  },
};

export const taskReviewerService = new TaskReviewerService();
