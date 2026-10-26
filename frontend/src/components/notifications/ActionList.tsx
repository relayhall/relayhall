import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCheck, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../Button';
import { usePolledResource } from '../../utils/polledResource';
import { formatDateTime } from '../../utils/dateFormat';
import { ActionIcon } from './NotificationIcon';
import {
  ACTION_GROUPS, actionHref, actionItems, actionReason, actionSubject, itemsOfKind, markActionsSeen, needYourAction,
  unseenLabel, waitedFor,
  type ActionItem,
} from './notifications';
import './ActionList.css';

/**
 * One open item: what it is about (linked to where the act is done), why it
 * waits on you, and for how long. A seen item (E455) says so, and is drawn
 * quieter; with `onMarkSeen`, an unseen one offers "Mark seen".
 */
export const ActionRow: React.FC<{
  item: ActionItem; onFollow?: () => void; compact?: boolean; onMarkSeen?: (item: ActionItem) => void; marking?: boolean;
}> = ({ item, onFollow, compact = false, onMarkSeen, marking = false }) => {
  const href = actionHref(item);
  const subject = actionSubject(item);
  const classes = ['action-list-item', compact ? 'action-list-item--compact' : '', item.seen ? 'action-list-item--seen' : '']
    .filter(Boolean).join(' ');
  return (
    <li className={classes}>
      <span className="action-list-item-icon" aria-hidden="true"><ActionIcon kind={item.kind} /></span>
      <div className="action-list-item-body">
        {href
          ? <Link className="action-list-item-subject" to={href} onClick={onFollow}>{subject}</Link>
          : <span className="action-list-item-subject">{subject}</span>}
        <span className="action-list-item-reason">{actionReason(item)}</span>
        <span className="action-list-item-meta">
          {item.seen ? <span className="action-list-item-seen">Seen</span> : null}
          {item.project?.name ? <span className="action-list-item-project">{item.project.name}</span> : null}
          <time dateTime={item.since} title={formatDateTime(item.since, item.since)}>{waitedFor(item.since)}</time>
        </span>
      </div>
      {onMarkSeen && !item.seen && (
        <Button
          variant="secondary"
          size="compact"
          className="action-list-item-mark"
          disabled={marking}
          ariaLabel={`Mark seen: ${subject}`}
          onClick={() => onMarkSeen(item)}
        >
          Mark seen
        </Button>
      )}
    </li>
  );
};

/**
 * THE NOTIFICATIONS TAB: "Needs your action" (design section 3; card
 * 5854f0d6, Slice B; owner ruling E394, choices C1 and C2).
 *
 * Only the open items that wait on YOU, grouped by kind in the design's order
 * — Decisions, Verify, Stuck, Skill reviews — and, inside a kind, the item
 * that has waited longest on top (the server's order). Each row says how long
 * it has waited and links to where the act is done. There is no dismiss: an
 * item leaves when it is resolved. Owner ruling E455: each item can be marked
 * seen, one at a time or all at once; a seen item stays here, shown as seen,
 * and only unseen items count on the bell. A kind the server cut at its cap
 * says so, so a count is never passed off as a total.
 *
 * It reads the one shared action list the bell and the dashboard card read,
 * so all three show the same items at the same moment.
 */
export const ActionList: React.FC = () => {
  const actions = usePolledResource(actionItems);
  const [marking, setMarking] = useState(false);
  const [markFailed, setMarkFailed] = useState(false);
  const mark = async (request: { keys: string[] } | { all: true }) => {
    setMarking(true);
    setMarkFailed(false);
    try {
      await markActionsSeen(request);
    } catch {
      setMarkFailed(true);
    } finally {
      setMarking(false);
    }
  };
  const anyUnseen = actions.status === 'ready' && actions.value.counts.unseen > 0;

  return (
    <section className="notifications-page-panel" aria-labelledby="notifications-actions-heading">
      <div className="notifications-page-toolbar">
        <h2 id="notifications-actions-heading">Needs your action</h2>
        <Button
          variant="secondary"
          size="compact"
          icon={<RefreshCw size={16} />}
          onClick={() => { void actionItems.refresh(); }}
          ariaLabel="Refresh the action list"
        >
          Refresh
        </Button>
        {anyUnseen && (
          <Button
            variant="secondary"
            size="compact"
            icon={<CheckCheck size={16} />}
            disabled={marking}
            onClick={() => { void mark({ all: true }); }}
          >
            Mark all seen
          </Button>
        )}
      </div>
      <p className="action-list-note" role="status" aria-live="polite">
        {actions.status === 'ready'
          ? `${needYourAction(actions.value)}${unseenLabel(actions.value) ? `, ${unseenLabel(actions.value)}` : ''}. `
          : ''}
        An item leaves this list when it is resolved. Marking it seen keeps it here and takes it off the bell.
      </p>
      {markFailed && (
        <p className="notifications-page-failed" role="alert">Couldn&rsquo;t mark it seen. Try again.</p>
      )}

      {actions.status === 'loading' && (
        <div className="notifications-page-state" role="status"><Loader2 className="axm-spin" aria-hidden="true" /> Checking what needs you…</div>
      )}
      {actions.status === 'error' && (
        <div className="notifications-page-failed" role="alert">
          <span>Couldn&rsquo;t check what needs your action.</span>
          <Button variant="secondary" size="compact" onClick={() => { void actionItems.refresh(); }}>Retry</Button>
        </div>
      )}
      {actions.status === 'ready' && actions.value.counts.total === 0 && (
        <p className="notifications-page-state">
          Nothing needs your action. A decision, a Task to verify, a stuck Task or a skill review that waits on you
          will be listed here. Everything that happened is on the <Link to="/action-center?tab=timeline">Timeline</Link>.
        </p>
      )}
      {actions.status === 'ready' && ACTION_GROUPS.map(({ kind, heading }) => {
        const items = itemsOfKind(actions.value, kind);
        if (items.length === 0) return null;
        const capped = actions.value.capped[kind];
        const headingId = `notifications-actions-${kind}`;
        return (
          <section key={kind} className="action-list-group" aria-labelledby={headingId}>
            <h3 id={headingId}>
              {heading} <span className="action-list-count">({items.length}{capped ? '+' : ''})</span>
            </h3>
            {capped && (
              <p className="action-list-capped" role="note">
                Showing the {items.length} that have waited longest; more are waiting. They appear here as these are resolved.
              </p>
            )}
            <ol className="action-list-items">
              {items.map((item) => (
                <ActionRow
                  key={item.key}
                  item={item}
                  marking={marking}
                  onMarkSeen={(seen) => { void mark({ keys: [seen.key] }); }}
                />
              ))}
            </ol>
          </section>
        );
      })}
    </section>
  );
};
