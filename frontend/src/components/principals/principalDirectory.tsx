import { useQuery } from '@tanstack/react-query';
import { authenticatedFetch } from '../../utils/auth';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export interface DirectoryPrincipal {
  id: string;
  kind: string;
  handle: string;
  displayName: string | null;
  status: string;
}

/** Grant-aware principal lookup (design 986be411 §8): resolves ids to display
 *  names once per surface. A failed or forbidden listing degrades to the
 *  truthful short-id fallback — never a fabricated name. */
export function usePrincipalDirectory() {
  const query = useQuery({
    queryKey: ['principal-directory'],
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, DirectoryPrincipal>> => {
      const response = await authenticatedFetch(`${API_BASE_URL}/principals`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.message || 'Principals could not be loaded.');
      const map = new Map<string, DirectoryPrincipal>();
      for (const principal of (data.principals || []) as DirectoryPrincipal[]) map.set(principal.id, principal);
      return map;
    },
  });
  return { directory: query.data, loading: query.isLoading };
}

export const shortPrincipalId = (id: string): string => id.slice(0, 8);

export function principalDisplayLabel(principal: DirectoryPrincipal | undefined, id: string): string {
  if (!principal) return shortPrincipalId(id);
  return principal.displayName || principal.handle || shortPrincipalId(id);
}

/** Attribution honesty: resolved names render with the UUID as tooltip; an
 *  unresolvable principal renders its truthful short-id, never raw UUID as
 *  primary text and never an invented name. */
export function PrincipalName({ id, directory }: { id: string | null | undefined; directory: Map<string, DirectoryPrincipal> | undefined }) {
  if (!id) return null;
  return <span className="principal-name" title={id}>{principalDisplayLabel(directory?.get(id), id)}</span>;
}
