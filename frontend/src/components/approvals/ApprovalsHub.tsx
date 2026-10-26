import React, { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Select } from '../ui/Select';
import { StepUpDialog } from '../access/StepUpDialog';
import type { StepUpRequest } from '../access/accessShared';
import { ApprovalsQueue, type ApprovalsQueueFilter } from './ApprovalsQueue';
import { ApprovalDrawer } from './ApprovalDrawer';
import {
  HUB_KINDS, approvalKindLabel, countLabel, pendingApprovals, waitingOnVerifier, waitingOnYou,
} from './approvals';
import { isHubGroupFilter } from './hubGrouping';
import { usePrincipals } from '../../hooks/usePrincipals';
import { usePolledResource } from '../../utils/polledResource';
import '../../pages/ApprovalsPage.css';

const STATUS_OPTIONS: Array<{ value: ApprovalsQueueFilter; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'decided', label: 'Decided' },
  { value: 'all', label: 'All' },
];

const GROUP_CLASS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'shared', label: 'Shared projects' },
  { value: 'private', label: 'Private projects' },
  { value: 'board', label: 'Board-level' },
];

/** The URL parameters the hub owns, so a host can clear them when the hub goes away. */
export const HUB_PARAMS = ['status', 'kind', 'group', 'approval'] as const;

/** `?status=` as the design lists it; anything else is the default, pending. */
export function hubStatus(value: string | null): ApprovalsQueueFilter {
  return value === 'decided' || value === 'all' ? value : 'pending';
}

/** `?kind=`: one of the kinds the hub lists, or no filter. */
export function hubKind(value: string | null): string | null {
  return value && (HUB_KINDS as readonly string[]).includes(value) ? value : null;
}

/**
 * THE APPROVALS HUB (design B.1, T8–T11; card b1e3b16d, lanes L1 and the
 * review-and-approve page; card e2dd52b8 Part A, owner E84).
 *
 * ONE BODY FOR EVERY PENDING DECISION the board holds: agent-mint, grant and
 * credential requests, and skill versions waiting for review — grouped by whose
 * they are (one section per Group, Shared projects, Private, Board-level; E45),
 * each saying who asked, what exactly, when, what it is about and who decides
 * (T9, T10). Native verification requests waiting on a task's verifier are
 * listed beside them, READ-ONLY: the verifier records the verdict on the task,
 * so they offer no decision and are counted as "waiting on a verifier", never
 * as waiting on you. Charter revisions and phase goals have no pending state on
 * the board yet, so there is nothing of theirs to list, and the hub says so.
 *
 * TWO HOSTS, ONE COMPONENT (card e2dd52b8 Part A): the hub page
 * (`/dashboard/approvals`, which adds only its own heading) and the Approvals
 * tab of the notification centre (`/dashboard/notifications?tab=approvals`)
 * both render this, so neither can drift from the other. Each host guards on a
 * resolved principal before rendering it.
 *
 * URL STATE (design B.2): `?status=pending|decided|all` (default pending),
 * `?kind=`, `?group=shared|private|board|<Group id>`, and `?approval=<id>`,
 * which opens that item's drawer — the same id the Access manager's published
 * deep link carries, so either link lands on the item, on either host. Every
 * write here changes only its own parameter, so a host's own (`tab`) stays.
 * A `kind` or `group` value the hub does not know is not applied, and the hub
 * says so rather than show an unfiltered list under a filtered link.
 *
 * DECIDING. Nothing new decides anything here. Agent-mint and grant items are
 * decided through the shared `ApprovalsQueue` with step-up, exactly as in the
 * Access manager; a skill version is decided on its Skill's own page. Whether
 * this session may decide an item is the server's answer (`decidable`), and
 * "waiting on you" counts exactly those — the same number the bell and the
 * dashboard notice show.
 */
export const ApprovalsHub: React.FC = () => {
  const { principals } = usePrincipals();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = hubStatus(searchParams.get('status'));
  const rawKind = searchParams.get('kind');
  const rawGroup = searchParams.get('group');
  const kind = hubKind(rawKind);
  const group = isHubGroupFilter(rawGroup) ? rawGroup : null;
  const approvalId = searchParams.get('approval');
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every host renders the hub only for a resolved principal, so it polls from mount.
  const pending = usePolledResource(pendingApprovals, true);

  const principalById = useMemo(() => new Map(principals.map((p) => [p.id, p])), [principals]);
  // The Groups the pending items name, for the group filter's options.
  const groupOptions = useMemo(() => {
    if (pending.status !== 'ready') return [];
    const seen = new Map<string, string>();
    for (const item of pending.value) for (const entry of item.ownership?.groups ?? []) seen.set(entry.id, entry.name);
    if (group && !seen.has(group) && !['shared', 'private', 'board'].includes(group)) seen.set(group, 'this Group');
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [pending, group]);

  const surface = useCallback((which: 'notice' | 'error', message: string) => {
    if (which === 'notice') { setNotice(message); setError(null); }
    else { setError(message); setNotice(null); }
  }, []);

  const setParam = (name: string, value: string | null) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (value === null) params.delete(name);
      else params.set(name, value);
      return params;
    });
  };

  const openHistory = useCallback((approval: { id: string }) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set('approval', approval.id);
      return params;
    });
  }, [setSearchParams]);

  const closeHistory = useCallback(() => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.delete('approval');
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  const yours = pending.status === 'ready' ? waitingOnYou(pending.value).length : 0;
  const verifying = pending.status === 'ready' ? waitingOnVerifier(pending.value).length : 0;
  const others = pending.status === 'ready' ? pending.value.length - yours - verifying : 0;
  const ignored = [
    rawKind !== null && kind === null ? `kind “${rawKind}”` : null,
    rawGroup !== null && group === null ? `group “${rawGroup}”` : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <>
      <p className="approvals-page-intro">
        Every request this session can see that needs a decision — agent mints, grant requests, credential requests,
        authority edits, change requests and skill versions waiting for review — grouped by whose they are, with who
        asked, what exactly, when, and who decides. A change request shows what it would change, before and after. Open an item&rsquo;s history to see who did what. Verification requests waiting on a task&rsquo;s
        verifier are listed too, read-only: the verifier records its verdict on the task, so there is nothing to decide
        here. Charter revisions and phase goals have no pending state on the board yet, so none are listed here.
      </p>
      {error && <div className="axm-error" role="alert">{error}</div>}
      {notice && <div className="axm-notice" role="status">{notice}</div>}

      <div className="approvals-page-summary">
        <p className="approvals-page-waiting" aria-live="polite">
          {pending.status === 'ready' && (yours === 0
            ? 'Nothing is waiting on you.'
            : `${countLabel(yours)} waiting on you.`)}
          {pending.status === 'ready' && others > 0 && ` ${countLabel(others)} waiting on someone else.`}
          {pending.status === 'ready' && verifying > 0 && ` ${countLabel(verifying)} waiting on a verifier.`}
          {pending.status === 'error' && 'Couldn’t check pending decisions.'}
        </p>
        <SegmentedControl<ApprovalsQueueFilter>
          ariaLabel="Show approvals"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(next) => setParam('status', next === 'pending' ? null : next)}
        />
      </div>

      <div className="approvals-page-filters">
        <label className="approvals-page-filter">
          Kind
          <Select value={kind ?? 'all'} onChange={(event) => setParam('kind', event.target.value === 'all' ? null : event.target.value)}>
            <option value="all">Every kind</option>
            {HUB_KINDS.map((value) => <option key={value} value={value}>{approvalKindLabel(value)}</option>)}
          </Select>
        </label>
        <label className="approvals-page-filter">
          Owner
          <Select value={group ?? 'all'} onChange={(event) => setParam('group', event.target.value === 'all' ? null : event.target.value)}>
            <option value="all">Every owner</option>
            {groupOptions.map(([id, name]) => <option key={id} value={id}>Group: {name}</option>)}
            {GROUP_CLASS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </label>
      </div>
      {ignored.length > 0 && (
        <p className="approvals-page-note" role="note">
          This link also filters by {ignored.join(' and ')}, which the hub does not know, so the list below is not
          filtered by {ignored.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      <ApprovalsQueue
        mount="hub"
        statusFilter={status}
        kindFilter={kind}
        groupFilter={group}
        principalById={principalById}
        deepLinkApprovalId={approvalId}
        requestStepUp={setStepUp}
        surface={surface}
        onOpenHistory={openHistory}
      />

      {approvalId && <ApprovalDrawer key={approvalId} approvalId={approvalId} onClose={closeHistory} />}

      {stepUp && (
        <StepUpDialog
          action={stepUp.action}
          targetId={stepUp.targetId}
          description={stepUp.description}
          onToken={(token) => { const request = stepUp; setStepUp(null); request.onToken(token); }}
          onCancel={() => { const request = stepUp; setStepUp(null); request.onCancel?.(); }}
        />
      )}
    </>
  );
};
