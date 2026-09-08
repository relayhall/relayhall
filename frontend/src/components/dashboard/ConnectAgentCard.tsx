import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plug, X } from 'lucide-react';
import { Button } from '../Button';
import { useMyConnections } from '../../hooks/useMyConnections';
import { ConnectAgentWizard } from '../connections/ConnectAgentWizard';
import '../connections/connections.css';
import './ConnectAgentCard.css';

/**
 * The day-one card (owner design record 99d6b0ad §3.1: "First login: a
 * 'Connect your agent' card → three-step wizard").
 *
 * WHEN IT SHOWS. Only for a person who has no Connector at all. The three
 * non-empty outcomes of the read are kept apart deliberately: a failed lookup
 * and an unmigrated substrate both render NOTHING rather than the card, because
 * inviting someone to make their first connection when they may already have
 * one is worse than staying quiet. The empty ARRAY is the only state that earns
 * the card.
 *
 * DISMISSAL. Local to the browser and re-openable from My connections, which is
 * where the same wizard lives permanently. Dismissal is a view preference, so it
 * is stored in the browser and never on the board; a storage that refuses (a
 * locked-down browser, private mode) simply means the card returns next visit,
 * which is the safe direction.
 */

const DISMISS_KEY = 'relayhall.connect-agent-card.dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === 'true';
  } catch {
    return false;
  }
}

export const ConnectAgentCard: React.FC = () => {
  const { connections, loading, unavailable, failed, reload } = useMyConnections();
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  const [open, setOpen] = useState(false);

  // THE ORDER MATTERS, and a live drill is what proved it.
  //
  // The card's visibility rule is "this person has no connection". The wizard
  // is rendered INSIDE the card, and creating a connection makes that rule
  // false — so an unguarded rule unmounts the wizard at the exact moment it is
  // holding the one-time onboarding pack. The credential is rendered once and
  // never stored server-side (AUTHZ §7.4), so the person would be left with a
  // connection whose credential no longer exists anywhere.
  //
  // While the wizard is OPEN the card therefore stays mounted whatever the
  // read now says. It is dismissed the ordinary way, by finishing the wizard.
  const hidden = loading || unavailable || failed || connections.length > 0 || dismissed;
  if (hidden && !open) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, 'true');
    } catch {
      /* A browser that refuses storage just shows the card again next visit. */
    }
  };

  // While the wizard is open it supplies BOTH the heading and the landmark, so
  // the card must supply neither. Rendering its own `aria-labelledby` section
  // around the wizard's produced two nested landmarks with the SAME accessible
  // name ("Connect your agent") and two identical h2s — axe `landmark-unique`.
  // Found only once the composed audit was repaired to actually render this
  // card (round-1 finding T3); the previous version asserted the card was
  // absent and audited a wizard mounted somewhere else entirely.
  //
  // The dismiss control goes with the heading, and is not lost: the wizard
  // carries its own Cancel on step 1 and Done on step 3, both of which close.
  if (open) {
    return (
      <div className="connect-agent-card">
        <ConnectAgentWizard onCreated={reload} onClose={() => { setOpen(false); reload(); }} />
      </div>
    );
  }

  return (
    <section className="connect-agent-card" aria-labelledby="connect-agent-card-heading">
      <div className="connect-agent-card-head">
        <h2 id="connect-agent-card-heading"><Plug aria-hidden="true" /> Connect your agent</h2>
        <button
          type="button"
          className="connect-agent-card-dismiss"
          onClick={dismiss}
          aria-label="Dismiss the connect your agent card"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <p className="connect-agent-card-body">
        Point Claude Code, Codex, your editor or a script at this board and it can read your
        work, claim a task and file a report — inside your own authority, never beyond it.
        It takes three steps and about a minute.
      </p>
      <div className="connect-agent-card-actions">
        <Button onClick={() => setOpen(true)} icon={<Plug size={16} />}>Connect your agent</Button>
        <Link className="connect-agent-card-link" to="/settings/connections">See My connections</Link>
      </div>
    </section>
  );
};
