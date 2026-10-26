import React, { useCallback, useEffect } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { Inbox, Loader2 } from 'lucide-react';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { ApprovalsHub, HUB_PARAMS } from '../components/approvals/ApprovalsHub';
import { MyRequests } from '../components/approvals/MyRequests';
import { ActionList } from '../components/notifications/ActionList';
import { TimelinePanel } from '../components/notifications/TimelinePanel';
import { TIMELINE_PARAMS } from '../components/notifications/timeline';
import { useRelayHallConfig } from '../contexts/RelayHallConfigContext';
import { useMyPrincipal } from '../hooks/usePrincipals';
import { SessionsPage, SESSION_LINK_PARAMS } from './SessionsPage';
import './NotificationsPage.css';

/** The Action Center's own path (owner ruling E453). `/notifications` and `/sessions` are aliases of it. */
export const ACTION_CENTER_PATH = '/action-center';

export type NotificationsTab = 'notifications' | 'timeline' | 'approvals' | 'requests' | 'sessions';

/** `?tab=` as the design lists it (plus Approvals, owner E84, My requests, the change-request
 * design section 9.4, and Agent sessions, owner E453); anything else is the default tab. */
export function notificationsTab(value: string | null): NotificationsTab {
  return value === 'timeline' || value === 'approvals' || value === 'requests' || value === 'sessions' ? value : 'notifications';
}

/** The tab's id and the id of the one panel it controls (the page mounts only the active panel). */
export const notificationsTabId = (tab: NotificationsTab) => `notifications-tab-${tab}`;
export const notificationsPanelId = (tab: NotificationsTab) => `notifications-panel-${tab}`;

/** The document title names the view: "Approvals · Action Center · RelayHall". */
export function notificationsTitle(tab: NotificationsTab, displayName: string): string {
  const view = TAB_OPTIONS.find((option) => option.value === tab)?.label;
  return tab === 'notifications' || !view ? `Action Center · ${displayName}` : `${view} · Action Center · ${displayName}`;
}

/**
 * The paths that moved INTO the Action Center (owner ruling E453), and where
 * each lands: `/notifications` is the page under its old name, `/sessions` is
 * its Agent sessions tab. The query and the fragment are carried across, so a
 * bookmarked `?tab=approvals&approval=<id>` or a native-review session link
 * (`/sessions?sessionRef=…`) still opens what it named.
 */
export function actionCenterAliasTarget(from: 'notifications' | 'sessions', location: { search?: string; hash?: string }): string {
  const search = location.search ?? '';
  const hash = location.hash ?? '';
  if (from === 'notifications') return `${ACTION_CENTER_PATH}${search}${hash}`;
  const carried = new URLSearchParams(search);
  const params = new URLSearchParams({ tab: 'sessions' });
  for (const [name, value] of carried) if (name !== 'tab') params.append(name, value);
  return `${ACTION_CENTER_PATH}?${params.toString()}${hash}`;
}

/** An alias replaces itself in history with its Action Center target. It carries no authority. */
export const ActionCenterAlias: React.FC<{ from: 'notifications' | 'sessions' }> = ({ from }) => {
  const location = useLocation();
  return <Navigate replace to={actionCenterAliasTarget(from, location)} />;
};

/**
 * The retired history's own URL filters. Nothing reads them any more, so a
 * tab switch drops them rather than carrying a filter no view applies.
 */
const RETIRED_HISTORY_PARAMS = ['who', 'unread'] as const;

const TAB_OPTIONS: Array<{ value: NotificationsTab; label: string }> = [
  { value: 'notifications', label: 'Notifications' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'requests', label: 'My requests' },
  { value: 'sessions', label: 'Agent sessions' },
];

const TAB_IDS = { tabId: notificationsTabId, panelId: notificationsPanelId };

/**
 * THE ACTION CENTER (`/dashboard/action-center`; owner ruling E453 renamed
 * the notification centre of the Notifications and Timeline design, Slice B,
 * card 5854f0d6, owner ruling E394).
 *
 * The left menu's "Action Center" entry, under Dashboard, opens it; the bell's
 * footer, the dashboard's cards and the decision notice reach it too. The old
 * paths are aliases: `/notifications` lands here and `/sessions` on the Agent
 * sessions tab, each with its query. Five views, chosen by `?tab=` and switched
 * by a tablist (role tablist / tab / tabpanel; arrow keys move focus and
 * select; the document title names the view):
 *
 *  - Notifications: "Needs your action" (`GET /notifications/actions`) — only
 *    the open items that wait on you, grouped Decisions, Verify, Stuck, Skill
 *    reviews, longest-waiting first. An item can be marked seen (owner E455):
 *    it stays listed until it is resolved, and the bell counts only the unseen.
 *  - Timeline: every change you can see (`GET /notifications/timeline`),
 *    newest first, grouped by day, paged lazily, with a text search and a
 *    filter bar folded to its active filters (owner E453) — all in the URL.
 *  - Approvals (owner E84): the approvals hub itself, `ApprovalsHub`, with its
 *    grouped list, drawers, step-up and URL state.
 *  - My requests (change-request design section 9.4): the change requests this
 *    Account and its identities filed.
 *  - Agent sessions (owner E453): the reported agent sessions, moved here from
 *    the left menu, with their own deep link to one session.
 *
 * Switching tabs drops the parameters the next view does not own: the
 * Timeline's leave with the Timeline, the hub's with the hub and a session
 * link with Agent sessions, so a copied link never carries a filter the
 * visible tab ignores and a stale `?approval=` never reopens a drawer.
 */
export const NotificationsPage: React.FC = () => {
  const { me, loading: authorityLoading } = useMyPrincipal();
  const { config } = useRelayHallConfig();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = notificationsTab(searchParams.get('tab'));

  const selectTab = useCallback((next: NotificationsTab) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      const from = notificationsTab(current.get('tab'));
      if (next !== 'timeline') for (const name of TIMELINE_PARAMS) params.delete(name);
      if (next !== 'approvals' && from === 'approvals') for (const name of HUB_PARAMS) params.delete(name);
      if (next !== 'sessions') for (const name of SESSION_LINK_PARAMS) params.delete(name);
      for (const name of RETIRED_HISTORY_PARAMS) params.delete(name);
      if (next === 'notifications') params.delete('tab');
      else params.set('tab', next);
      return params;
    });
  }, [setSearchParams]);

  useEffect(() => {
    const previous = document.title;
    document.title = notificationsTitle(tab, config.displayName);
    return () => { document.title = previous; };
  }, [tab, config.displayName]);

  if (authorityLoading) {
    return <div className="notifications-page-state" role="status"><Loader2 className="axm-spin" aria-hidden="true" /> Checking authority…</div>;
  }
  if (!me) {
    return <div className="notifications-page-failed" role="alert">The Action Center needs a resolved identity for this session.</div>;
  }

  return (
    <div className="notifications-page">
      <header className="notifications-page-header">
        <Inbox size={24} aria-hidden="true" />
        <h1>Action Center</h1>
      </header>

      <SegmentedControl<NotificationsTab>
        ariaLabel="Action Center view"
        className="notifications-page-tabs"
        options={TAB_OPTIONS}
        value={tab}
        onChange={selectTab}
        tabs={TAB_IDS}
      />

      <div
        role="tabpanel"
        id={notificationsPanelId(tab)}
        aria-labelledby={notificationsTabId(tab)}
        tabIndex={0}
      >
        {tab === 'approvals' ? (
          <ApprovalsHub />
        ) : tab === 'requests' ? (
          <MyRequests />
        ) : tab === 'timeline' ? (
          <TimelinePanel />
        ) : tab === 'sessions' ? (
          <SessionsPage embedded />
        ) : (
          <ActionList />
        )}
      </div>
    </div>
  );
};
