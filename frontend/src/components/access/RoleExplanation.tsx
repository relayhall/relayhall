import React from 'react';
import type { RoleCatalogueEntry } from '../../types/roleCatalogue';
import type { RoleCatalogueState } from '../../hooks/useRoleCatalogue';
import './RoleExplanation.css';

/**
 * ONE ROLE, EXPLAINED (card a2d1e317). The only component that renders a
 * role's catalogue entry, so the Roles section, the role-change confirmation
 * and Create identity show the same words: the purpose, what the role may
 * reach, what it never reaches, who it is meant for and who assigns it. Every
 * sentence is the board's (`GET /principals/roles`); nothing is written here.
 */
export const RoleExplanation: React.FC<{
  entry: RoleCatalogueEntry;
  id?: string;
}> = ({ entry, id }) => (
  <div className="role-expl" id={id} data-role={entry.role}>
    <p className="role-expl-purpose">{entry.purpose}</p>
    <dl className="role-expl-facts">
      <div className="role-expl-fact">
        <dt>May reach</dt>
        <dd>{entry.mayReach}</dd>
      </div>
      <div className="role-expl-fact">
        <dt>Never reaches</dt>
        <dd>{entry.neverReaches}</dd>
      </div>
    </dl>
    <p className="role-expl-kinds">{entry.meantForText} {entry.assignedByText}</p>
  </div>
);

/**
 * The explanation under a role selector: the chosen role's entry, a prompt
 * when nothing is chosen, and an honest sentence when the catalogue could not
 * be read.
 */
export const RoleSelectionExplanation: React.FC<{
  catalogue: RoleCatalogueState;
  role: string | null | undefined;
  id?: string;
  emptyText: string;
}> = ({ catalogue, role, id, emptyText }) => {
  if (catalogue.state === 'loading') {
    return <p className="role-expl-status" id={id} role="status">Reading the role catalogue&hellip;</p>;
  }
  if (catalogue.state === 'failed') {
    return (
      <p className="role-expl-status" id={id} role="status">
        The role catalogue could not be read, so this role is not explained here. See the role guide.
      </p>
    );
  }
  const entry = role ? catalogue.roles.find((candidate) => candidate.role === role) : undefined;
  if (!entry) return <p className="role-expl-status" id={id}>{emptyText}</p>;
  return <RoleExplanation entry={entry} id={id} />;
};

/** Every role in the catalogue, in the board's order, each explained. */
export const RoleCatalogueList: React.FC<{ catalogue: RoleCatalogueState }> = ({ catalogue }) => {
  if (catalogue.state !== 'ready') {
    return (
      <p className="role-expl-status" role="status">
        {catalogue.state === 'loading'
          ? 'Reading the role catalogue…'
          : 'The role catalogue could not be read. See the role guide.'}
      </p>
    );
  }
  return (
    <ul className="role-cat-list" aria-label="Role catalogue">
      {catalogue.roles.map((entry) => (
        <li key={entry.role} className="role-cat-item">
          <span className="role-cat-name">{entry.role}</span>
          <RoleExplanation entry={entry} />
        </li>
      ))}
    </ul>
  );
};
