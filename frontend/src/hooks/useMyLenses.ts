import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../utils/auth';
import { MEMBER_ONLY, readLensesBody, type MyLenses } from '../types/lenses';

export type { Lens, MyLenses } from '../types/lenses';
export { MEMBER_ONLY } from '../types/lenses';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * THE CALLER'S LENSES, AS THE SERVER DECIDED THEM (RH-LENSES-d, card
 * 4e159741; design 96f0bd3d s8).
 *
 * `GET /principals/me/lenses` answers which dashboard sections this session
 * is OFFERED: `member` always, `admin` for a root login session. The answer is
 * the server's and only the server's; nothing here derives a lens from scopes,
 * a role or anything else, so the navigation and the server cannot disagree
 * about who is an administrator.
 *
 * A LENS DECIDES ONLY WHAT IS RENDERED (invariant I-L2). Every page a lens
 * links to enforces its own ceiling on the server. A drift here could hide a
 * section from someone entitled to it or show one that would be refused; it
 * could never confer authority on anybody.
 *
 * FAILING CLOSED. Until the board answers, and whenever it does not answer
 * (an older board without the route, a network failure, an unreadable body),
 * the session is shown the member sections only. That is the narrower
 * direction: the administration sections reappear the moment the board says
 * so, and nothing a member may use is withheld meanwhile.
 */
export function useMyLenses(): { lenses: MyLenses; loading: boolean } {
  const [lenses, setLenses] = useState<MyLenses>(MEMBER_ONLY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE}/principals/me/lenses`);
        if (!response || !response.ok) return;
        const answered = readLensesBody(await response.json());
        if (!cancelled) setLenses(answered);
      } catch {
        // The member sections stay: see FAILING CLOSED above.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { lenses, loading };
}
