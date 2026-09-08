import React, { useEffect, useRef, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { authenticatedFetch } from '../../utils/auth';
import './StepUpDialog.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * Step-up elevation dialog (AZ-S4; design 4d961e37 §7.6, AZ-23).
 *
 * Mints a SINGLE-USE elevation token bound to ONE named action + target by
 * re-entering the password, then hands the token to the caller, which sends
 * it with the elevated act — the consuming endpoint burns it. The dialog
 * never stores the password or the token; a cancelled dialog leaves any
 * minted-but-unused token to its ~5-minute expiry.
 */
interface StepUpDialogProps {
  /** The ratified action string the token binds to (e.g. 'approval.decide'). */
  action: string;
  /** The exact target object id the token binds to. */
  targetId: string;
  /** Human sentence naming the act being elevated. */
  description: string;
  onToken: (stepUpToken: string) => void;
  onCancel: () => void;
}

export const StepUpDialog: React.FC<StepUpDialogProps> = ({ action, targetId, description, onToken, onCancel }) => {
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || !password) return;
    setPending(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`${API_BASE}/auth/step-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action, targetId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success || typeof data.stepUpToken !== 'string') {
        throw new Error(data.message || data.error || 'Step-up failed');
      }
      setPassword('');
      onToken(data.stepUpToken);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Step-up failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="stepup-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="stepup-dialog" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
        <div className="stepup-head">
          <ShieldCheck aria-hidden="true" />
          <h2 id="stepup-title">Confirm it&rsquo;s you</h2>
          <IconButton icon={<X size={16} aria-hidden="true" />} ariaLabel="Cancel step-up" onClick={onCancel} variant="ghost" />
        </div>
        <p className="stepup-description">{description}</p>
        <p className="stepup-note">This mints a single-use elevation token bound to exactly this act. It expires in about five minutes and is burned on use.</p>
        {error && <div className="stepup-error" role="alert">{error}</div>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label htmlFor="stepup-password">Password</label>
            <input
              id="stepup-password"
              ref={inputRef}
              className="form-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <div className="stepup-actions">
            <Button type="button" variant="secondary" size="compact" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="primary" size="compact" disabled={pending || !password}>
              {pending ? 'Verifying…' : 'Continue'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
