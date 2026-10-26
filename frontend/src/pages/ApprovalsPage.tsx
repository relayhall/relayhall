import React from 'react';
import { Gavel, Loader2 } from 'lucide-react';
import { ApprovalsHub } from '../components/approvals/ApprovalsHub';
import { useMyPrincipal } from '../hooks/usePrincipals';
import './ApprovalsPage.css';

// The hub's URL helpers live with the hub; re-exported where they always were.
export { hubKind, hubStatus } from '../components/approvals/ApprovalsHub';

/**
 * THE APPROVALS HUB PAGE (`/dashboard/approvals`; design B.1, T8–T11; card
 * b1e3b16d, lanes L1 and the review-and-approve page).
 *
 * The page is a guard and a heading around `ApprovalsHub`, the one hub body
 * (card e2dd52b8 Part A): the notification centre's Approvals tab renders the
 * same component, so the list, its drawers, step-up and URL state are one
 * implementation on both surfaces. What the hub lists and how it decides is
 * written down there.
 *
 * LINK-ONLY. It is not a navigation entry anywhere (E16). The Access manager's
 * "Open in approvals hub" link leads here; the sidebar bell and the dashboard's
 * decision notice lead to the Approvals tab of `/dashboard/notifications`
 * (owner E84). `?approval=<id>` still opens that item's drawer here, the same
 * id the Access manager's published deep link carries.
 */
export const ApprovalsPage: React.FC = () => {
  const { me, loading: authorityLoading } = useMyPrincipal();

  if (authorityLoading) {
    return <div className="axm-state"><Loader2 className="axm-spin" aria-hidden="true" /> Checking authority…</div>;
  }
  if (!me) {
    return <div className="axm-error" role="alert">The approvals hub needs a resolved identity for this session.</div>;
  }

  return (
    <div className="approvals-page">
      <header className="approvals-page-header">
        <Gavel size={24} aria-hidden="true" />
        <h1>Approvals</h1>
      </header>
      <ApprovalsHub />
    </div>
  );
};
