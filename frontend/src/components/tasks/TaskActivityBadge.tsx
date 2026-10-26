import type { TaskActivity } from '../../hooks/useTaskActivity';
import { formatDateTime } from '../../utils/dateFormat';
import './TaskActivityBadge.css';
const LABELS = { active: 'Active', idle: 'Idle', stale: 'Stale', unknown: 'Unknown', unavailable: 'Unavailable' };
/** A plain span has no role, so it carries no accessible name of its own
 * (ARIA 1.2 prohibits aria-label there). Its words are the name: the full
 * phrase for a screen reader, the short word on screen. */
export function TaskActivityBadge({ activity }: { activity?: TaskActivity }) {
  const state = activity?.state ?? 'unknown';
  return <span className={`task-activity task-activity--${state} ${state === 'idle' ? 'session-status-idle' : ''}`}>
    <span className="session-status-dot" aria-hidden="true" />
    <span className="sr-only">{`Task activity: ${LABELS[state]}`}</span>
    <span aria-hidden="true">{LABELS[state]}</span>
    {activity?.receivedAt && <time dateTime={activity.receivedAt} title="Last actual activity observation">Observed {formatDateTime(new Date(activity.receivedAt))}</time>}
  </span>;
}
