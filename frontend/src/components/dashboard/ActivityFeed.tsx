import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { Button } from '../Button';
import { useRelayHallConfig } from '../../contexts/RelayHallConfigContext';
import { formatDateTime } from '../../utils/dateFormat';
import { isIntentionalAbort } from '../../utils/fetchAbort';
import { TimelineIcon } from '../notifications/NotificationIcon';
import { timeAgo } from '../notifications/notifications';
import {
  NO_TIMELINE_FILTERS, fetchTimelinePage, mergeTimeline, timelineActor, timelineFailure, timelineLink,
  timelineSubject, timelineWhat, type TimelineFailure, type TimelineItem,
} from '../notifications/timeline';
import './ActivityFeed.css';

/** How many rows the widget shows (design section 4.6: "the newest 8 Timeline rows"). */
export const ACTIVITY_ROWS = 8;

type FeedState =
  | { status: 'loading' }
  | { status: 'error'; failure: TimelineFailure }
  | { status: 'ready'; items: TimelineItem[] };

/**
 * THE DASHBOARD ACTIVITY WIDGET (Notifications and Timeline design section
 * 4.6; card 5854f0d6, Slice B; owner ruling E394, choice C11).
 *
 * The newest eight Timeline rows you can see, read from
 * `GET /notifications/timeline` with the Timeline's own defaults (every type,
 * access changes hidden, everything you can see), and a link to the full
 * Timeline. It replaces the widget that read `GET /dashboard/activity` and
 * never rendered. A page of the Timeline may hold more rows than asked for
 * (approval and skill-decision rows ride beside the feed's page), so the rows
 * are sorted by time and cut to eight here.
 *
 * Honest states: a failed read (and the route's 503 TIMELINE_READ_TIMEOUT)
 * says so with Retry; an empty Timeline says it is empty.
 */
export const ActivityFeed: React.FC = () => {
  const { config } = useRelayHallConfig();
  const [state, setState] = useState<FeedState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchTimelinePage(NO_TIMELINE_FILTERS, { limit: ACTIVITY_ROWS }, controller.signal)
      .then((page) => setState({ status: 'ready', items: mergeTimeline([], page.items).items.slice(0, ACTIVITY_ROWS) }))
      .catch((caught) => {
        if (!isIntentionalAbort(caught, controller.signal)) setState({ status: 'error', failure: timelineFailure(caught) });
      });
    return () => controller.abort();
  }, [attempt]);

  const boardName = config.displayName || 'RelayHall';

  return (
    <section className="activity-feed" aria-labelledby="dashboard-activity-heading">
      <div className="activity-feed-header">
        <h2 id="dashboard-activity-heading"><ClipboardList size={16} aria-hidden="true" /> Activity</h2>
        <Link className="activity-feed-all" to="/action-center?tab=timeline">Open the Timeline</Link>
      </div>

      {state.status === 'loading' && <p className="activity-feed-quiet" role="status">Loading recent activity…</p>}
      {state.status === 'error' && (
        <div className="activity-feed-failed" role="alert">
          <span>
            {state.failure === 'timeout' ? 'Recent activity took too long to read.' : 'Couldn’t load recent activity.'}
          </span>
          <Button variant="secondary" size="compact" onClick={retry}>Retry</Button>
        </div>
      )}
      {state.status === 'ready' && state.items.length === 0 && (
        <p className="activity-feed-quiet">Nothing has happened that you can see yet.</p>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <ol className="activity-feed-timeline">
          {state.items.map((item) => {
            const link = timelineLink(item);
            const subject = timelineSubject(item);
            const actor = timelineActor(item, boardName);
            return (
              <li key={item.key} className="activity-feed-item">
                <span className="activity-feed-dot" aria-hidden="true"><TimelineIcon kind={item.kind} /></span>
                <div className="activity-feed-content">
                  <time className="activity-feed-time" dateTime={item.at} title={formatDateTime(item.at, item.at)}>{timeAgo(item.at)}</time>
                  {link
                    ? <Link className="activity-feed-task" to={link}>{subject}</Link>
                    : <span className="activity-feed-task">{subject}</span>}
                  <span className="activity-feed-desc">
                    {item.label}: {timelineWhat(item)}{actor ? `, by ${actor}` : ''}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};
