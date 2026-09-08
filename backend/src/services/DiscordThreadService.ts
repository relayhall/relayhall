/**
 * DiscordThreadService — Discord thread notifications for tasks
 *
 * Responsibilities:
 * 1. Create Discord threads for tasks with linked agent sessions
 * 2. Post lifecycle messages (completion summary, error reports)
 * 3. Archive thread on completion
 *
 * P1.3 (§2.6.5/F11): the gateway coupling was retired — no `agent:stream`
 * output mirroring and no gateway-mediated message transport. The service
 * sends through the direct `relayhall-bot` Discord REST transport (or is
 * disabled). Whether task↔Discord threading ships in the product at all is a
 * named open disposition in docs/seams.md.
 */

import { EventEmitter } from 'events';
import { taskManagerDB as taskManager } from './TaskManagerDB';
import {
  createDiscordNotificationTransport,
  loadDiscordTransportConfig,
  type DiscordNotificationTransport,
  type DiscordTransportConfig,
} from './discord';
import { logCaughtFailure, logCaughtWarning } from '../utils/secretSafeLog';

// ── Config ────────────────────────────────────────────────────────────────────

/** Discord channel where task threads are created */
const TASK_THREAD_CHANNEL_ID =
  process.env.RELAYHALL_DISCORD_TASK_THREAD_CHANNEL_ID
  || process.env.DISCORD_TASK_THREAD_CHANNEL_ID
  || ''; // task-thread parent channel (set via env)

/** Batch window: aggregate output for this many ms before posting */
const STREAM_BATCH_MS = 7000;

/** How often to poll for new thread replies (ms) */
const REPLY_POLL_INTERVAL_MS = 15000;

/** Maximum chars per Discord message (hard limit: 2000) */
const MAX_MSG_LEN = 1900;

/** Suppress identical outbound messages to the same thread inside this window. */
const OUTBOUND_DEDUP_TTL_MS = 120000;

/** Keep a short memory of recently-sent thread messages. */
const MAX_RECENT_OUTBOUND = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ThreadState {
  taskId: string;
  taskTitle: string;
  threadId: string;
  sessionKey: string;
  active: boolean;
}

type DiscordThreadServiceConfig = Pick<DiscordTransportConfig,
  'taskThreadChannelId'
  | 'pollIntervalMs'
  | 'streamBatchMs'
  | 'maxMessageLen'
  | 'archiveOnComplete'
  | 'lockOnComplete'
>;

interface DiscordThreadServiceOptions {
  transport?: DiscordNotificationTransport;
  config?: Partial<DiscordThreadServiceConfig>;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class DiscordThreadService extends EventEmitter {
  private threads: Map<string, ThreadState> = new Map(); // taskId → state
  private recentOutbound: Map<string, number> = new Map();
  private transport: DiscordNotificationTransport | null = null;
  private config: DiscordThreadServiceConfig;

  constructor(options: DiscordThreadServiceOptions = {}) {
    super();
    const envConfig = loadDiscordTransportConfig();
    this.config = {
      taskThreadChannelId: options.config?.taskThreadChannelId || envConfig.taskThreadChannelId || TASK_THREAD_CHANNEL_ID,
      pollIntervalMs: options.config?.pollIntervalMs || envConfig.pollIntervalMs || REPLY_POLL_INTERVAL_MS,
      streamBatchMs: options.config?.streamBatchMs || envConfig.streamBatchMs || STREAM_BATCH_MS,
      maxMessageLen: options.config?.maxMessageLen || envConfig.maxMessageLen || MAX_MSG_LEN,
      archiveOnComplete: options.config?.archiveOnComplete ?? envConfig.archiveOnComplete ?? true,
      lockOnComplete: options.config?.lockOnComplete ?? envConfig.lockOnComplete ?? false,
    };
    this.transport = options.transport || null;
  }

  public async sendSystemChannelMessage(channelId: string, message: string): Promise<{ messageId?: string }> {
    const transport = this.getTransport();
    return transport.sendChannelMessage({ channelId, message: message.slice(0, this.config.maxMessageLen) });
  }

  public getSystemNotificationChannelId(): string {
    return this.config.taskThreadChannelId;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Create a Discord thread for an interactive task.
   * If the task already has a discord_thread_id, reuse it.
   * Returns the thread ID or null on failure.
   */
  public async createThreadForTask(taskId: string, taskTitle: string, sessionKey: string): Promise<string | null> {
    try {
      // Check if thread already exists for this task
      const task = await taskManager.getTask(taskId);
      if (task?.discordThreadId) {
        console.log(`♻️  DiscordThreadService: Reusing existing thread ${task.discordThreadId} for task ${taskId}`);
        this.startTracking(taskId, taskTitle, task.discordThreadId, sessionKey);
        return task.discordThreadId;
      }

      const threadName = `🤖 Task: ${taskTitle}`.substring(0, 100);
      const initialMessage = [
        `## 🤖 Task Started`,
        `**${taskTitle}**`,
        ``,
        `An agent session was linked to this task.`,
        ``,
        `📋 Session: \`${sessionKey}\``,
      ].join('\n');

      console.log(`🧵 DiscordThreadService: Creating Discord thread "${threadName}" for task ${taskId}`);

      const transport = this.getTransport();
      const result = await transport.createThread({
        channelId: this.config.taskThreadChannelId,
        threadName,
        initialMessage,
      });

      const threadId = result.threadId;
      if (!threadId) {
        console.error('DiscordThreadService: transport returned no thread ID');
        return null;
      }

      console.log(`✅ DiscordThreadService: Created thread ${threadId} for task ${taskId}`);

      // Persist thread ID in task record
      await taskManager.updateTask(taskId, { discordThreadId: threadId });

      this.startTracking(taskId, taskTitle, threadId, sessionKey);
      return threadId;

    } catch (err) {
      logCaughtFailure('[DiscordThreadService] thread creation failed', err);
      return null;
    }
  }

  /**
   * Post a lifecycle message to the task thread (completion, failure, etc.)
   */
  public async postLifecycleMessage(taskId: string, kind: 'completed' | 'failed' | 'stuck', details?: string): Promise<void> {
    const state = this.threads.get(taskId);
    if (!state) return;

    const icons: Record<string, string> = {
      completed: '✅',
      failed: '❌',
      stuck: '🚫',
    };

    const messages: Record<string, string> = {
      completed: '**Task completed!** The agent finished all subtasks and moved this task to review.',
      failed:    '**Task failed.** The agent encountered an error. Check the logs for details.',
      stuck:     '**Task stuck.** The agent stopped without completing. Manual intervention may be needed.',
    };

    const text = [
      `## ${icons[kind] || '🔔'} ${messages[kind] || `Task ${kind}`}`,
      details ? `\n${details}` : '',
    ].join('').trim();

    await this.sendToThread(state.threadId, text);

    // Archive thread on success
    if (kind === 'completed' && this.config.archiveOnComplete) {
      await this.archiveThread(state);
    }

    this.stopTracking(taskId);
  }

  /**
   * Rebind the tracked session key for a task's thread after a provisional
   * spawn ('pending') resolves to its real Hermes session id. No-op when no
   * thread is tracked for the task.
   */
  public rebindTrackedSession(taskId: string, newSessionKey: string): void {
    const state = this.threads.get(taskId);
    if (!state || !newSessionKey || state.sessionKey === newSessionKey) return;
    console.log(`🔁 DiscordThreadService: Rebound thread ${state.threadId} for task ${taskId}: ${state.sessionKey} → ${newSessionKey}`);
    state.sessionKey = newSessionKey;
  }

  /**
   * Stop tracking a task thread (call on task completion / manual cancel).
   */
  public stopTracking(taskId: string): void {
    const state = this.threads.get(taskId);
    if (!state) return;

    state.active = false;
    this.threads.delete(taskId);
    console.log(`🧹 DiscordThreadService: Stopped tracking task ${taskId}`);
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private startTracking(taskId: string, taskTitle: string, threadId: string, sessionKey: string): void {
    // Stop any existing tracking
    this.stopTracking(taskId);

    const state: ThreadState = {
      taskId,
      taskTitle,
      threadId,
      sessionKey,
      active: true,
    };
    this.threads.set(taskId, state);

    console.log(`📡 DiscordThreadService: Tracking thread ${threadId} for task ${taskId} (session: ${sessionKey})`);
  }

  // Session-output streaming into task threads was removed in P1.3 (F11):
  // the board no longer observes agent output, so there is nothing to mirror.
  // Thread-reply polling and steering forwarding were removed in P1.2 wave 2
  // (strategy §2.8): replies in a task thread no longer inject turns into any
  // agent process.

  /**
   * Send a message to a Discord thread through the configured transport.
   */
  private async sendToThread(threadId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const message = trimmed.substring(0, this.config.maxMessageLen);
    if (this.isRecentDuplicateOutbound(threadId, message)) {
      console.warn(`⚠️ DiscordThreadService: Suppressed duplicate outbound thread message for ${threadId}`);
      return;
    }

    try {
      await this.getTransport().sendThreadMessage({ threadId, message });
      this.rememberOutbound(threadId, message);
    } catch (err) {
      logCaughtFailure('[DiscordThreadService] thread send failed', err);
    }
  }

  /**
   * Archive the Discord thread (lock it so no new messages can be sent).
   */
  private async archiveThread(state: ThreadState): Promise<void> {
    try {
      await this.getTransport().archiveThread({ threadId: state.threadId, locked: this.config.lockOnComplete });
      console.log(`📦 DiscordThreadService: Archived thread ${state.threadId}`);
    } catch (err) {
      // Archiving failing is non-fatal
      logCaughtWarning('[DiscordThreadService] thread archive failed', err);
    }
  }

  private getTransport(): DiscordNotificationTransport {
    if (!this.transport) {
      this.transport = createDiscordNotificationTransport().transport;
    }
    return this.transport;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  private isRecentDuplicateOutbound(threadId: string, message: string): boolean {
    this.pruneRecentOutbound();

    const fingerprint = `${threadId}:${message}`;
    const lastSentAt = this.recentOutbound.get(fingerprint);
    return Boolean(lastSentAt && Date.now() - lastSentAt < OUTBOUND_DEDUP_TTL_MS);
  }

  private rememberOutbound(threadId: string, message: string): void {
    this.pruneRecentOutbound();

    const fingerprint = `${threadId}:${message}`;
    this.recentOutbound.set(fingerprint, Date.now());
    if (this.recentOutbound.size > MAX_RECENT_OUTBOUND) {
      const oldestKey = this.recentOutbound.keys().next().value;
      if (oldestKey) this.recentOutbound.delete(oldestKey);
    }
  }

  private pruneRecentOutbound(): void {
    const now = Date.now();

    for (const [key, ts] of this.recentOutbound.entries()) {
      if (now - ts > OUTBOUND_DEDUP_TTL_MS) {
        this.recentOutbound.delete(key);
      }
    }
  }

}

// Singleton
export const discordThreadService = new DiscordThreadService();
