import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Bell, Check, RefreshCw } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import { isIntentionalAbort } from '../../utils/fetchAbort';
import './NotificationsCard.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const POLL_INTERVAL_MS = 30_000;

/**
 * RH-P3.C8 — the human notification surface (strategy §2.12): exception
 * events (task.stuck) and status changes reach the signed-in human here.
 * The backend read model is recipient-addressed and grant-filtered per
 * caller; this card only renders what that model already allowed.
 */
interface UiNotification {
  id: string;
  taskId: string;
  taskTitle: string;
  event: 'status_changed' | 'exception';
  from: string;
  to: string;
  timestamp: string;
  read: boolean;
  exception?: { name: string; reason?: string };
}

const timeAgo = (dateStr: string): string => {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'Just now';
};

const exceptionLabel = (notification: UiNotification): string => {
  const reason = notification.exception?.reason;
  if (notification.exception?.name === 'task.stuck') {
    if (reason === 'lease_expired') return 'Task stuck — its lease expired';
    if (reason === 'status_stale') return 'Task stuck — no activity for a while';
    return 'Task stuck';
  }
  return notification.exception?.name ?? 'Exception';
};

export const NotificationsCard: React.FC = () => {
  const [notifications, setNotifications] = useState<UiNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const fetchNotifications = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/notifications?unread=true`, { signal });
      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data.notifications)) {
        setNotifications(data.notifications.slice(0, 6));
      }
    } catch (err) {
      if (!isIntentionalAbort(err)) console.error('Failed to fetch notifications:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchNotifications(controller.signal);
    const timer = setInterval(() => { void fetchNotifications(controller.signal); }, POLL_INTERVAL_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [fetchNotifications]);

  const markRead = async (id: string) => {
    try {
      await authenticatedFetch(`${API_BASE_URL}/tasks/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
      setNotifications((current) => current.filter((notification) => notification.id !== id));
    } catch (err) {
      if (!isIntentionalAbort(err)) console.error('Failed to mark the notification read:', err);
    }
  };

  const markAllRead = async () => {
    try {
      await authenticatedFetch(`${API_BASE_URL}/tasks/notifications/read-all`, { method: 'POST' });
      setNotifications([]);
    } catch (err) {
      if (!isIntentionalAbort(err)) console.error('Failed to mark all notifications read:', err);
    }
  };

  if (loading) return null;

  return (
    <section className="notifications-card" aria-label="Notifications">
      <div className="notifications-card-header">
        <h2>
          <Bell size={20} aria-hidden="true" />
          Notifications
        </h2>
        {notifications.length > 0 && (
          <button type="button" className="notifications-card-clear" onClick={() => { void markAllRead(); }}>
            Mark all read
          </button>
        )}
      </div>

      {notifications.length === 0 ? (
        <p className="notifications-card-empty">No unread notifications.</p>
      ) : (
        <ul className="notifications-card-list">
          {notifications.map((notification) => (
            <li key={notification.id} className={`notifications-card-item notifications-card-item--${notification.event}`}>
              <span className="notifications-card-item-icon" aria-hidden="true">
                {notification.event === 'exception' ? <AlertTriangle size={16} /> : <RefreshCw size={16} />}
              </span>
              <button
                type="button"
                className="notifications-card-item-body"
                onClick={() => navigate(`/tasks/${notification.taskId}`)}
              >
                <span className="notifications-card-item-label">
                  {notification.event === 'exception'
                    ? exceptionLabel(notification)
                    : `Status changed: ${notification.from} → ${notification.to}`}
                </span>
                <span className="notifications-card-item-task">{notification.taskTitle}</span>
                <span className="notifications-card-item-time">{timeAgo(notification.timestamp)}</span>
              </button>
              <button
                type="button"
                className="notifications-card-item-read"
                aria-label={`Mark read: ${notification.taskTitle}`}
                onClick={() => { void markRead(notification.id); }}
              >
                <Check size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
