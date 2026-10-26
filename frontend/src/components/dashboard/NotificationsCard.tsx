import React from 'react';
import { Link } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { Button } from '../Button';
import { usePolledResource } from '../../utils/polledResource';
import { ActionIcon } from '../notifications/NotificationIcon';
import {
  actionCountLabel, actionHref, actionItems, actionReason, actionSubject, waitedFor,
} from '../notifications/notifications';
import './NotificationsCard.css';

/** How many items the dashboard card lists (design section 5: "the first 6 items"). */
export const DASHBOARD_ACTION_ROWS = 6;

/**
 * THE DASHBOARD CARD: "Needs your action" (Notifications and Timeline design
 * sections 3 and 5; card 5854f0d6, Slice B; owner ruling E394).
 *
 * The first six items of the action list — the open items that wait on you,
 * in the server's order (Decisions, Verify, Stuck, Skill reviews; the
 * longest-waiting first inside each) — each linked to where the act is done.
 * No read state and no "mark read": an item leaves when it is resolved. It
 * reads the one shared action list the bell reads, so the card and the bell
 * say the same number. A failed read says so and offers Retry; it is never
 * shown as "nothing needs you".
 */
export const NotificationsCard: React.FC = () => {
  const actions = usePolledResource(actionItems);
  const rows = actions.status === 'ready' ? actions.value.items.slice(0, DASHBOARD_ACTION_ROWS) : [];

  return (
    <section className="notifications-card" aria-labelledby="dashboard-actions-heading">
      <div className="notifications-card-header">
        <h2 id="dashboard-actions-heading">
          <Bell size={20} aria-hidden="true" />
          Needs your action
        </h2>
        <Link className="notifications-card-all" to="/action-center">
          {actions.status === 'ready' && actions.value.counts.total > DASHBOARD_ACTION_ROWS
            ? `See all ${actionCountLabel(actions.value)}`
            : 'All notifications'}
        </Link>
      </div>

      {actions.status === 'loading' && <p className="notifications-card-empty" role="status">Checking what needs you…</p>}
      {actions.status === 'error' && (
        <div className="notifications-card-failed" role="alert">
          <span>Couldn&rsquo;t check what needs your action.</span>
          <Button variant="secondary" size="compact" onClick={() => { void actionItems.refresh(); }}>Retry</Button>
        </div>
      )}
      {actions.status === 'ready' && rows.length === 0 && (
        <p className="notifications-card-empty">Nothing needs your action.</p>
      )}
      {rows.length > 0 && (
        <ul className="notifications-card-list">
          {rows.map((item) => {
            const href = actionHref(item);
            const subject = actionSubject(item);
            return (
              <li key={item.key} className="notifications-card-item">
                <span className="notifications-card-item-icon" aria-hidden="true"><ActionIcon kind={item.kind} /></span>
                <div className="notifications-card-item-body">
                  {href
                    ? <Link className="notifications-card-item-task" to={href} title={subject}>{subject}</Link>
                    : <span className="notifications-card-item-task" title={subject}>{subject}</span>}
                  <span className="notifications-card-item-label">{actionReason(item)}</span>
                  <span className="notifications-card-item-time">{waitedFor(item.since)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
