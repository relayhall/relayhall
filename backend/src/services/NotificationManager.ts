// NotificationManager.ts - Task state change notifications
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logCaughtFailure, logCaughtWarning } from '../utils/secretSafeLog';

export const TASK_NOTIFICATIONS_FILE = process.env.TASK_NOTIFICATIONS_FILE || '/data/task-notifications.json';
const NOTIFICATIONS_FILE = TASK_NOTIFICATIONS_FILE;
const NOTIFICATIONS_DIR = path.dirname(NOTIFICATIONS_FILE);
const MAX_NOTIFICATIONS = 50;

export interface TaskNotification {
  id: string;
  taskId: string;
  taskTitle: string;
  event: 'status_changed' | 'exception';
  from: string;
  to: string;
  changedBy: 'user' | 'agent' | 'system';
  timestamp: string;
  read: boolean;
  /** RH-P3.C8: for event 'exception', the ratified derived-event name
   * ('task.stuck') and its coarse derivation reason. IDs and coarse state
   * only — content stays behind the pull. */
  exception?: { name: string; reason?: string };
  /** RH-P3.C8 round 2 (review 4243b06e B1): the addressed recipient. NULL
   * is a broadcast — but EVERY read of this surface is additionally
   * grant-filtered against the referenced Task, so addressing widens
   * nothing. */
  recipientPrincipalId?: string | null;
}

export interface NotificationData {
  notifications: TaskNotification[];
  updatedAt: string;
}

export class NotificationManager {
  private writeQueue: Promise<void> = Promise.resolve();

  private async readNotificationData(): Promise<NotificationData> {
    // P1.3: the legacy fallback that read task-notifications.json out of the
    // harness sessions mount is gone with the observation mounts.
    for (const candidate of [NOTIFICATIONS_FILE]) {
      try {
        const content = await fs.readFile(candidate, 'utf8');
        return JSON.parse(content);
      } catch (err: any) {
        if (err.code && err.code !== 'ENOENT') {
          logCaughtWarning('[NotificationManager] notification file read failed', err);
        }
      }
    }

    return { notifications: [], updatedAt: new Date().toISOString() };
  }

  /**
   * Emit a task status change notification
   */
  async notifyStatusChange(
    taskId: string,
    taskTitle: string,
    fromStatus: string,
    toStatus: string,
    changedBy: 'user' | 'agent' | 'system' = 'user'
  ): Promise<void> {
    const notification: TaskNotification = {
      id: uuidv4(),
      taskId,
      taskTitle,
      event: 'status_changed',
      from: fromStatus,
      to: toStatus,
      changedBy,
      timestamp: new Date().toISOString(),
      read: false
    };

    await this.addNotification(notification);
    console.log(`[NotificationManager] Task ${taskId} status: ${fromStatus} → ${toStatus}`);
  }

  /**
   * Add a notification to the file (serialized writes)
   */
  private async addNotification(notification: TaskNotification): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        // Read existing notifications
        let data: NotificationData = await this.readNotificationData();

        // Add new notification at the beginning
        data.notifications.unshift(notification);

        // Keep only last MAX_NOTIFICATIONS (FIFO - drop oldest)
        if (data.notifications.length > MAX_NOTIFICATIONS) {
          data.notifications = data.notifications.slice(0, MAX_NOTIFICATIONS);
        }

        data.updatedAt = new Date().toISOString();

        // Ensure directory exists
        await fs.mkdir(NOTIFICATIONS_DIR, { recursive: true });

        // Write atomically (temp file + rename)
        const tmpFile = NOTIFICATIONS_FILE + '.tmp';
        await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tmpFile, NOTIFICATIONS_FILE);

      } catch (err: any) {
        logCaughtFailure('[NotificationManager] notification write failed', err);
        // Don't throw - keep server running
      }
    });

    return this.writeQueue;
  }

  /**
   * Get all notifications
   */
  /**
   * RH-P3.C8 (§2.12): an exception event reaches the human via the same UI
   * notification surface as status changes — the single-human-baseline
   * mandatory path. `from`/`to` carry the coarse observed state, not a
   * status-change claim.
   */
  async notifyException(
    taskId: string,
    taskTitle: string,
    name: string,
    reason?: string,
    recipientPrincipalId?: string | null,
  ): Promise<void> {
    const notification: TaskNotification = {
      id: uuidv4(),
      taskId,
      taskTitle,
      event: 'exception',
      from: 'in-progress',
      to: 'in-progress',
      changedBy: 'system',
      timestamp: new Date().toISOString(),
      read: false,
      exception: { name, ...(reason ? { reason } : {}) },
      recipientPrincipalId: recipientPrincipalId ?? null,
    };
    await this.addNotification(notification);
  }

  async getNotifications(): Promise<TaskNotification[]> {
    try {
      const data = await this.readNotificationData();
      return data.notifications || [];
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return []; // File doesn't exist yet
      }
      logCaughtFailure('[NotificationManager] notification read failed', err);
      return [];
    }
  }

  /**
   * Get unread notifications only
   */
  async getUnreadNotifications(): Promise<TaskNotification[]> {
    const all = await this.getNotifications();
    return all.filter(n => !n.read);
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(notificationId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.writeQueue = this.writeQueue.then(async () => {
        try {
          const data: NotificationData = await this.readNotificationData();

          const notification = data.notifications.find(n => n.id === notificationId);
          if (!notification) {
            resolve(false);
            return;
          }

          notification.read = true;
          data.updatedAt = new Date().toISOString();

          const tmpFile = NOTIFICATIONS_FILE + '.tmp';
          await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
          await fs.rename(tmpFile, NOTIFICATIONS_FILE);

          console.log(`[NotificationManager] Marked notification ${notificationId} as read`);
          resolve(true);
        } catch (err: any) {
          logCaughtFailure('[NotificationManager] mark-read failed', err);
          resolve(false);
        }
      });
    });
  }

  /**
   * Mark all notifications as read
   */
  async markAllAsRead(): Promise<number> {
    return new Promise((resolve) => {
      this.writeQueue = this.writeQueue.then(async () => {
        try {
          const data: NotificationData = await this.readNotificationData();

          let count = 0;
          for (const notification of data.notifications) {
            if (!notification.read) {
              notification.read = true;
              count++;
            }
          }

          if (count > 0) {
            data.updatedAt = new Date().toISOString();
            const tmpFile = NOTIFICATIONS_FILE + '.tmp';
            await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
            await fs.rename(tmpFile, NOTIFICATIONS_FILE);
            console.log(`[NotificationManager] Marked ${count} notifications as read`);
          }

          resolve(count);
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            resolve(0); // No file = no notifications
            return;
          }
          logCaughtFailure('[NotificationManager] mark-all-read failed', err);
          resolve(0);
        }
      });
    });
  }
}

// Singleton instance
export const notificationManager = new NotificationManager();
