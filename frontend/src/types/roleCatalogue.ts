/**
 * One entry of the role catalogue served by `GET /principals/roles`
 * (card a2d1e317). The board derives every field except `purpose` and
 * `meantFor` from the code that enforces it, and composes every sentence;
 * the dashboard renders the sentences as given and never writes its own.
 */
export interface RoleCatalogueEntry {
  role: string;
  purpose: string;
  meantFor: Array<'human' | 'service' | 'agent'>;
  meantForText: string;
  elevated: boolean;
  ceiling: string[];
  mayReach: string;
  neverReaches: string;
  sameCeilingAs: string[];
  assignedBy: string[];
  assignedByText: string;
}
