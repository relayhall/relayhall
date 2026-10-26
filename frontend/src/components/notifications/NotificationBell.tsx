import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { usePolledResource, type PolledState } from '../../utils/polledResource';
import { ActionRow } from './ActionList';
import {
  ACTION_GROUPS, actionCountLabel, actionItems, actionsCapped, itemsOfKind, markActionsSeen, needYourAction,
  unseenLabel, type ActionsSummary,
} from './notifications';
import './NotificationBell.css';

/** The badge never grows past three characters. */
function badgeText(total: number, capped: boolean): string {
  return total > 99 ? '99+' : `${total}${capped ? '+' : ''}`;
}

/**
 * The bell's accessible name says the count it read, and says "unavailable"
 * for a count it could not read — never a zero it does not know.
 */
export function bellName(actions: PolledState<ActionsSummary>): string {
  if (actions.status === 'loading') return 'Notifications';
  if (actions.status === 'error') return 'Notifications: action count unavailable';
  const unseen = unseenLabel(actions.value);
  return `Notifications: ${needYourAction(actions.value)}${unseen ? `, ${unseen}` : ''}`;
}

/**
 * The badge is the count of open action items you have NOT marked seen (design
 * section 3.2 as owner ruling E455 amends it: "the bell counts only unseen
 * items"): no unread history and no separate approvals poll are added to it,
 * and a seen item, still open, adds nothing. Nothing while the count is
 * loading or zero; an alert mark when it could not be read, because a number
 * shown for an unread count would be wrong without saying so. The "+" of a
 * capped list stays: the unseen count is then a floor too.
 */
export function bellBadge(actions: PolledState<ActionsSummary>):
  { kind: 'none' } | { kind: 'count'; total: number; capped: boolean } | { kind: 'unknown' } {
  if (actions.status === 'error') return { kind: 'unknown' };
  if (actions.status !== 'ready') return { kind: 'none' };
  const unseen = actions.value.counts.unseen;
  return unseen > 0 ? { kind: 'count', total: unseen, capped: actionsCapped(actions.value) } : { kind: 'none' };
}

interface PanelPosition { top: number; left: number; width: number }

const GUTTER = 16;
const PANEL_WIDTH = 360;
const PANEL_OFFSET = 8;

function placePanel(anchor: HTMLElement): PanelPosition {
  const rect = anchor.getBoundingClientRect();
  const viewport = typeof window === 'undefined' ? PANEL_WIDTH + 2 * GUTTER : window.innerWidth;
  const width = Math.max(0, Math.min(PANEL_WIDTH, viewport - 2 * GUTTER));
  const left = Math.min(Math.max(GUTTER, rect.left), Math.max(GUTTER, viewport - GUTTER - width));
  return { top: rect.bottom + PANEL_OFFSET, left, width };
}

/**
 * THE BELL AND ITS POPOVER (Notifications and Timeline design section 3.2;
 * card 5854f0d6, Slice B; owner ruling E394).
 *
 * A CONTROL, NOT A MENU ENTRY. It sits in the sidebar's account row and,
 * below 1280px with the drawer closed, in the floating top bar — the left
 * menu is untouched.
 *
 * Its number is the count of open action items that wait on you and that you
 * have not marked seen (`GET /notifications/actions` `counts.unseen`, owner
 * ruling E455), read through the ONE shared 30 s poll the Notifications tab
 * and the dashboard card read, so every surface on screen shows one number.
 * An item leaves when it is resolved; "Mark all seen" in the header takes the
 * open ones off the badge and leaves them listed, shown as seen.
 *
 * THE POPOVER pins its header and its footer and scrolls only the list
 * between them (the design's N6, which is also the later card 394131bd's
 * pinned header and footer). The header names the list and its count; the
 * list is grouped by kind, longest-waiting first; the footer links "All
 * notifications", "Timeline" and "Approvals".
 *
 * It is a non-modal dialog portalled to the document body, so neither the
 * rail's horizontal clip nor the mobile drawer's transform can cut it. Opening
 * it moves focus into it; Tab then walks the header, each row's link in list
 * order, and the footer's three links; Escape closes it and returns focus to
 * the bell; a press outside, or focus moving to something outside, closes it.
 */
export const NotificationBell: React.FC<{ className?: string }> = ({ className = '' }) => {
  const actions = usePolledResource(actionItems);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const panelId = `notification-bell-panel-${useId().replace(/:/g, '')}`;
  const titleId = `${panelId}-title`;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) bellRef.current?.focus();
  }, []);

  // A navigation (a row, a footer link) ends the popover's job.
  useEffect(() => { setOpen(false); }, [location.pathname, location.search]);

  useLayoutEffect(() => {
    if (!open || !bellRef.current) return;
    const anchor = bellRef.current;
    const place = () => setPosition(placePanel(anchor));
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Focus moves INTO the popover when it opens: it is portalled to the end of
  // the document, so without this a keyboard user would have to tab through
  // the whole page to reach what they just opened.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // CAPTURE phase, and the event stops here: inside the open mobile drawer
    // the sidebar also closes on Escape, and one Escape must close only the
    // top-most thing — the popover — not both.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || bellRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, close]);

  const badge = bellBadge(actions);
  const name = bellName(actions);
  const follow = () => close(false);

  return (
    <>
      <IconButton
        ref={bellRef}
        className={`notification-bell ${className}`}
        variant="secondary"
        ariaLabel={name}
        ariaExpanded={open}
        ariaControls={open ? panelId : undefined}
        ariaHaspopup="dialog"
        onClick={() => (open ? close(false) : setOpen(true))}
        icon={(
          <>
            <Bell size={16} aria-hidden="true" />
            {badge.kind === 'count' && (
              <span className="notification-bell-badge" aria-hidden="true">{badgeText(badge.total, badge.capped)}</span>
            )}
            {badge.kind === 'unknown' && (
              <span className="notification-bell-badge notification-bell-badge--unknown" aria-hidden="true">!</span>
            )}
          </>
        )}
      />
      {open && typeof document !== 'undefined' && createPortal(
        <div
          id={panelId}
          ref={panelRef}
          className="notification-bell-panel"
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          style={position ? { top: position.top, left: position.left, width: position.width } : undefined}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (!next || panelRef.current?.contains(next) || bellRef.current?.contains(next)) return;
            close(false);
          }}
        >
          <div className="notification-bell-panel-head">
            <h2 id={titleId} className="notification-bell-panel-title">Needs your action</h2>
            {actions.status === 'ready' && actions.value.counts.total > 0 && (
              <span className="notification-bell-panel-count">{actionCountLabel(actions.value)}</span>
            )}
            {actions.status === 'ready' && actions.value.counts.unseen > 0 && (
              <Button
                variant="secondary"
                size="compact"
                className="notification-bell-panel-mark"
                onClick={() => { void markActionsSeen({ all: true }).catch(() => undefined); }}
              >
                Mark all seen
              </Button>
            )}
          </div>

          <div className="notification-bell-panel-body">
            {actions.status === 'loading' && <p className="notification-bell-quiet" role="status">Checking what needs you…</p>}
            {actions.status === 'error' && (
              <div className="notification-bell-failed" role="alert">
                <span>Couldn&rsquo;t check what needs your action.</span>
                <Button variant="secondary" size="compact" onClick={() => { void actionItems.refresh(); }}>Retry</Button>
              </div>
            )}
            {actions.status === 'ready' && actions.value.counts.total === 0 && (
              <p className="notification-bell-quiet">Nothing needs your action.</p>
            )}
            {actions.status === 'ready' && ACTION_GROUPS.map(({ kind, heading }) => {
              const items = itemsOfKind(actions.value, kind);
              if (items.length === 0) return null;
              const groupId = `${panelId}-${kind}`;
              return (
                <div key={kind}>
                  <h3 id={groupId} className="notification-bell-group-title">
                    {heading} ({items.length}{actions.value.capped[kind] ? '+' : ''})
                  </h3>
                  <ul className="notification-bell-list" aria-labelledby={groupId}>
                    {items.map((item) => <ActionRow key={item.key} item={item} onFollow={follow} compact />)}
                  </ul>
                </div>
              );
            })}
          </div>

          <nav className="notification-bell-panel-foot" aria-label="Notification views">
            <Link to="/action-center" onClick={follow}>All notifications</Link>
            <Link to="/action-center?tab=timeline" onClick={follow}>Timeline</Link>
            <Link to="/action-center?tab=approvals" onClick={follow}>Approvals</Link>
          </nav>
        </div>,
        document.body,
      )}
    </>
  );
};
