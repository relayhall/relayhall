import type { Skill } from '../../types/skill';

/** Registry administration: root or skills:admin (card d67e6990). */
export function administersSkills(scopes: string[] | null | undefined): boolean {
  return Array.isArray(scopes) && (scopes.includes('root') || scopes.includes('skills:admin'));
}

/** The owner a Skill names, as the server joined it (card d67e6990). */
export function skillOwnerLabel(skill: Skill): string {
  if (!skill.owner_principal_id) return 'Unowned';
  const name = skill.owner_display_name || skill.owner_principal_id;
  return skill.owner_kind === 'group' ? `${name} (group)` : name;
}
