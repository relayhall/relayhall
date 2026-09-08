import React, { useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { auth } from '../utils/auth';
import './BreakGlassBanner.css';

/**
 * THE BREAK-GLASS ANNOUNCEMENT (owner ruling `60307311` §1.1).
 *
 * `POST /auth/login` is permanent and no configuration can disable it — it is
 * the lockout escape hatch, and design `d95136d7` §8.5 makes that permanence
 * explicit. What the ruling adds is that using it on a deployment which HAS an
 * administrator Account should not be silent: it is recorded in the audit
 * ledger (`auth.break_glass.login` with `administratorExists: true`) and it is
 * said on the board.
 *
 * The banner renders only when BOTH halves hold — this session came through
 * the password door, and an administrator Account existed when it did — so a
 * genuinely bootstrapping deployment, where the password door is the only
 * door there is, is not scolded for using it.
 *
 * Dismissal is per-visit and deliberately not persisted: the next break-glass
 * sign-in is a new event and says so again.
 */
export const BreakGlassBanner: React.FC = () => {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !auth.usedBreakGlass()) return null;

  return (
    <div className="break-glass-banner" role="status" data-testid="break-glass-banner">
      <span className="break-glass-banner__icon" aria-hidden="true"><KeyRound size={16} /></span>
      <p className="break-glass-banner__text">
        <strong>Signed in through the break-glass door.</strong>{' '}
        This deployment has an administrator Account — sign in as that person for everyday work.
        This sign-in is recorded in the audit ledger.
      </p>
      <button
        type="button"
        className="break-glass-banner__dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss the break-glass notice"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
};
