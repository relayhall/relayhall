import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, LogOut, MonitorSmartphone } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import { formatDateTime } from '../../utils/dateFormat';
import './LoginSessions.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

export interface LoginSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/**
 * SS-W1 · your own login sessions, listed and revocable.
 *
 * Scoped to the signed-in Account by the server, not by a filter here: the
 * endpoint has no "whose" parameter and answers a session id belonging to
 * somebody else exactly as it answers one that does not exist.
 */
export const LoginSessions: React.FC = () => {
  const [sessions, setSessions] = useState<LoginSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE}/auth/sessions`);
      if (!response.ok) {
        setSessions([]);
        return;
      }
      const data = await response.json();
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      setError(null);
    } catch {
      setError('Could not load your sessions.');
      setSessions([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const response = await authenticatedFetch(`${API_BASE}/auth/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!response.ok && response.status !== 204) {
        setError('That session could not be ended.');
      }
      // Ending the session you are using logs you out of this browser too.
      if (sessions?.find((session) => session.id === id)?.current) {
        window.location.reload();
        return;
      }
      await load();
    } catch {
      setError('That session could not be ended.');
    } finally {
      setBusy(null);
    }
  };

  const revokeAll = async () => {
    setBusy('all');
    setError(null);
    try {
      await authenticatedFetch(`${API_BASE}/auth/sessions`, { method: 'DELETE' });
      window.location.reload();
    } catch {
      setError('Those sessions could not be ended.');
      setBusy(null);
    }
  };

  if (sessions === null) {
    return (
      <p className="login-sessions-state">
        <Loader2 size={16} className="login-sessions-spinner" aria-hidden="true" /> Loading your sessions…
      </p>
    );
  }

  return (
    <div className="login-sessions">
      {error && <div className="login-sessions-error" role="alert">{error}</div>}

      {sessions.length === 0 ? (
        <p className="login-sessions-state">
          You have no server-side login sessions on this deployment.
        </p>
      ) : (
        <>
          <ul className="login-sessions-list">
            {sessions.map((session) => (
              <li key={session.id} className="login-sessions-item">
                <MonitorSmartphone size={16} className="login-sessions-icon" aria-hidden="true" />
                <div className="login-sessions-body">
                  <p className="login-sessions-label">
                    {session.userAgent || 'Unknown browser'}
                    {session.current && <span className="login-sessions-badge">This browser</span>}
                  </p>
                  <p className="login-sessions-note">
                    {session.ip ? `${session.ip} · ` : ''}
                    Last seen {formatDateTime(session.lastSeenAt)} · Expires {formatDateTime(session.expiresAt)}
                  </p>
                </div>
                <button
                  type="button"
                  className="login-sessions-revoke"
                  onClick={() => void revoke(session.id)}
                  disabled={busy !== null}
                >
                  {busy === session.id ? 'Ending…' : 'End session'}
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="login-sessions-revoke-all"
            onClick={() => void revokeAll()}
            disabled={busy !== null}
          >
            <LogOut size={16} aria-hidden="true" />
            {busy === 'all' ? 'Signing out everywhere…' : 'Sign out everywhere'}
          </button>
        </>
      )}
    </div>
  );
};
