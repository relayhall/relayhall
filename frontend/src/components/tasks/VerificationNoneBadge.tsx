import { ShieldOff } from 'lucide-react';
import './VerificationNoneBadge.css';

/**
 * Owner ruling E462 S4b (universal harness connector design, section 6.8):
 * a Task with verification mode `none` has no Verifier, and its finish
 * completes it. The board shows it on the card, on the Task page and in a
 * Blueprint preview. A plain span has no role, so its words are its name.
 */
export function VerificationNoneBadge() {
  return <span className="verification-none-badge" title="Finishing this Task completes it; nobody verifies it">
    <ShieldOff size={16} aria-hidden="true" />
    <span>No verification</span>
  </span>;
}

/** The derived mode beside the Verifier's name (human or service), or nothing. */
export function verificationModeLabel(mode: string | null | undefined): string {
  if (mode === 'human') return ' (verification: human)';
  if (mode === 'service') return ' (verification: service)';
  return '';
}
