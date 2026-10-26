import { describe, expect, it } from 'vitest';
import { administersSkills, skillOwnerLabel } from './skillOwner';
import type { Skill } from '../../types/skill';

const skill = (fields: Partial<Skill>): Skill => ({
  id: 's1', name: 'deploy-runner', is_global: false, current_published_version_id: null, revision: 'r',
  created_at: 't', updated_at: 't', current_version: null, published_version: null, version: 1,
  status: 'draft', category: null, description: null, tags: [], config: {}, provenance: null,
  content_sha256: null, ...fields,
});

describe('card d67e6990: Skill owner helpers', () => {
  it('administers the registry with root or skills:admin only', () => {
    expect(administersSkills(['root'])).toBe(true);
    expect(administersSkills(['skills:read', 'skills:admin'])).toBe(true);
    expect(administersSkills(['skills:read', 'skills:write'])).toBe(false);
    expect(administersSkills(null)).toBe(false);
    expect(administersSkills(undefined)).toBe(false);
  });

  it('names an unowned Skill, a person owner and a Group owner', () => {
    expect(skillOwnerLabel(skill({}))).toBe('Unowned');
    expect(skillOwnerLabel(skill({ owner_principal_id: 'p1', owner_kind: 'human', owner_display_name: 'Second Account' }))).toBe('Second Account');
    expect(skillOwnerLabel(skill({ owner_principal_id: 'g1', owner_kind: 'group', owner_display_name: 'Platform' }))).toBe('Platform (group)');
    expect(skillOwnerLabel(skill({ owner_principal_id: 'p2', owner_kind: 'human', owner_display_name: null }))).toBe('p2');
  });
});
