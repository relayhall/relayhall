import React, { useState, useEffect } from 'react';
import { AlertTriangle, Archive, ArrowRight, CheckCircle2, ClipboardList, Clock, Plus } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import './ActivityFeed.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface ActivityEvent {
  type: string;
  taskId: string;
  taskTitle: string;
  oldValue?: string;
  newValue?: string;
  timestamp: string;
  note?: string;
}

const timeAgo = (dateStr: string): string => {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'Just now';
};

const getEventIcon = (type: string, newValue?: string) => {
  if (type === 'status_change') {
    if (newValue === 'completed') return <CheckCircle2 size={16} className="activity-icon-completed" />;
    if (newValue === 'stuck') return <AlertTriangle size={16} className="activity-icon-stuck" />;
    if (newValue === 'archived') return <Archive size={16} className="activity-icon-archived" />;
    return <ArrowRight size={16} className="activity-icon-moved" />;
  }
  if (type === 'created') return <Plus size={16} className="activity-icon-created" />;
  return <Clock size={16} className="activity-icon-default" />;
};

const getEventDescription = (event: ActivityEvent): string => {
  if (event.type === 'status_change') {
    return `moved to ${event.newValue}`;
  }
  if (event.type === 'created') return 'created';
  if (event.type === 'subtask_completed') return 'subtask completed';
  if (event.type === 'priority_change') return `priority → ${event.newValue}`;
  return event.type.replace(/_/g, ' ');
};

export const ActivityFeed: React.FC = () => {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    fetchActivity();
  }, []);

  const fetchActivity = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/dashboard/activity?limit=8`);
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.events) {
          setEvents(data.events);
          setLoaded(true);
          return;
        }
      }
      // Endpoint not available yet — hide widget
      setAvailable(false);
    } catch {
      setAvailable(false);
    } finally {
      setLoaded(true);
    }
  };

  // Don't render if endpoint not available
  if (!available || (!loaded)) return null;
  if (events.length === 0 && loaded) return null;

  return (
    <div className="activity-feed">
      <div className="activity-feed-header">
        <h2><ClipboardList size={16} aria-hidden="true" /> Activity Feed</h2>
      </div>

      <div className="activity-feed-timeline">
        {events.map((event, idx) => (
          <div key={idx} className="activity-feed-item">
            <div className="activity-feed-dot">
              {getEventIcon(event.type, event.newValue)}
            </div>
            <div className="activity-feed-content">
              <span className="activity-feed-time">{timeAgo(event.timestamp)}</span>
              <span className="activity-feed-task">{event.taskTitle}</span>
              <span className="activity-feed-desc">{getEventDescription(event)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
