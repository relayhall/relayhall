/**
 * THE ROLE CATALOGUE (card a2d1e317): what it says must be what the code
 * enforces. Every expectation below is computed from the enforcing constants
 * (`scopesForRole`, `MINTABLE_SCOPES`, `ELEVATED_ROLES`, `canAssignRole`,
 * `ROLE_ACT_ISSUER_ROLES`), never copied from the catalogue's own output, so
 * an edit that made the catalogue and its suite agree with each other but not
 * with the authority would still go red.
 */
import {
  ASSIGNABLE_ROLES, ASSIGNABLE_ROLE_NAMES, ELEVATED_ROLES, canAssignRole, type AssignableRole,
} from '../utils/credentialAuthority';
import { scopesForRole } from '../utils/identityScopes';
import { MINTABLE_SCOPES, ROOT_SCOPE } from '../utils/scopeMap';
import { ROLE_ACT_ISSUER_ROLES } from '../utils/administratorSession';
import {
  ROLE_DESCRIPTIONS, roleCatalogue, type RoleDescription,
} from '../utils/roleCatalogue';

const catalogue = roleCatalogue();
const entry = (role: string) => catalogue.find((candidate) => candidate.role === role)!;
const BELOW_ROOT = MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE);

describe('the catalogue covers exactly the assignable roles', () => {
  it('one entry per assignable role, in vocabulary order', () => {
    expect(catalogue.map((row) => row.role)).toEqual([...ASSIGNABLE_ROLE_NAMES]);
    expect(new Set(catalogue.map((row) => row.role))).toEqual(ASSIGNABLE_ROLES);
  });

  it('the tuple and the set the role act checks are the same vocabulary', () => {
    expect([...ASSIGNABLE_ROLES].sort()).toEqual([...ASSIGNABLE_ROLE_NAMES].sort());
    expect(ASSIGNABLE_ROLES.size).toBe(9);
  });
});

describe('a role missing a description fails the build', () => {
  it('compile half: the descriptions are a record over EVERY role name', () => {
    // ts-jest type-checks this file. The assignment compiles only while
    // ROLE_DESCRIPTIONS is a total record; a Partial or a missing key fails
    // here and in `tsc --noEmit` on the module itself.
    const total: Record<AssignableRole, RoleDescription> = ROLE_DESCRIPTIONS;
    expect(Object.keys(total).sort()).toEqual([...ASSIGNABLE_ROLE_NAMES].sort());
    // @ts-expect-error a record over the role names that omits one does not compile
    const incomplete: Record<AssignableRole, RoleDescription> = { admin: ROLE_DESCRIPTIONS.admin };
    expect(incomplete).toBeDefined();
  });

  it('runtime half: a missing description throws ROLE_DESCRIPTION_MISSING', () => {
    const withoutQa: Partial<Record<AssignableRole, RoleDescription>> = { ...ROLE_DESCRIPTIONS };
    delete withoutQa.qa;
    expect(() => roleCatalogue(withoutQa)).toThrow(/ROLE_DESCRIPTION_MISSING: the role 'qa'/);
  });

  it('runtime half: a blank purpose or no kind throws as well', () => {
    expect(() => roleCatalogue({ ...ROLE_DESCRIPTIONS, viewer: { purpose: '  ', meantFor: ['human'] } }))
      .toThrow(/ROLE_DESCRIPTION_MISSING: the role 'viewer'/);
    expect(() => roleCatalogue({ ...ROLE_DESCRIPTIONS, agent: { purpose: 'x', meantFor: [] } }))
      .toThrow(/ROLE_DESCRIPTION_MISSING: the role 'agent'/);
  });

  it('every shipped purpose is one non-empty line', () => {
    for (const row of catalogue) {
      expect(row.purpose.trim().length).toBeGreaterThan(10);
      expect(row.purpose).not.toMatch(/\n/);
      expect(row.meantFor.length).toBeGreaterThan(0);
    }
  });
});

describe('the ceiling is derived, never restated', () => {
  it.each([...ASSIGNABLE_ROLE_NAMES])('%s: ceiling equals scopesForRole', (role) => {
    expect(entry(role).ceiling).toEqual(scopesForRole(role).map(String));
  });

  it.each([...ASSIGNABLE_ROLE_NAMES])('%s: may-reach and never-reaches follow root', (role) => {
    const holdsRoot = scopesForRole(role).includes(ROOT_SCOPE);
    expect(entry(role).mayReach.startsWith('Everything')).toBe(holdsRoot);
    expect(entry(role).neverReaches.startsWith('Root, so no owner-plane route')).toBe(!holdsRoot);
  });

  it.each([...ASSIGNABLE_ROLE_NAMES])('%s: the sentence counts the scopes the ceiling really holds', (role) => {
    const ceiling = scopesForRole(role);
    if (ceiling.includes(ROOT_SCOPE)) return;
    expect(entry(role).mayReach).toContain(ceiling.length === BELOW_ROOT.length
      ? `(all ${BELOW_ROOT.length} scopes below root)`
      : `(${ceiling.length} of the ${BELOW_ROOT.length} scopes below root)`);
  });

  it('a verb the ceiling lacks entirely is named under never-reaches and not under may-reach', () => {
    for (const role of ASSIGNABLE_ROLE_NAMES) {
      const ceiling = scopesForRole(role);
      if (ceiling.includes(ROOT_SCOPE)) continue;
      const verbs = [...new Set(BELOW_ROOT.map((scope) => scope.split(':')[1]))];
      for (const verb of verbs) {
        const ofVerb = BELOW_ROOT.filter((scope) => scope.endsWith(`:${verb}`));
        const held = ofVerb.filter((scope) => ceiling.includes(scope));
        if (held.length === 0) {
          expect(`${role} never ${entry(role).neverReaches}`).toMatch(new RegExp(`\\b${verb}\\b`));
          expect(`${role} may ${entry(role).mayReach}`).not.toMatch(new RegExp(`\\b${verb}\\b`));
        } else if (held.length === ofVerb.length) {
          expect(`${role} may ${entry(role).mayReach}`).toMatch(new RegExp(`\\b${verb}\\b`));
        }
      }
    }
  });

  it('the three shapes the vocabulary has today read as expected', () => {
    // Derived again, in words: viewer holds exactly the read scopes, the working
    // roles everything but admin, operator everything below root.
    const reads = BELOW_ROOT.filter((scope) => scope.endsWith(':read'));
    expect(scopesForRole('viewer')).toEqual(reads);
    expect(entry('viewer').mayReach).toBe(`Every read scope (${reads.length} of the ${BELOW_ROOT.length} scopes below root).`);
    expect(entry('operator').mayReach).toBe(`Every read, use, write, invoke and admin scope (all ${BELOW_ROOT.length} scopes below root).`);
    expect(entry('user').neverReaches).toBe('Root, so no owner-plane route and no admin scope.');
  });

  it('roles that share a ceiling say so, symmetrically', () => {
    for (const row of catalogue) {
      for (const other of row.sameCeilingAs) {
        expect(entry(other).sameCeilingAs).toContain(row.role);
        expect([...scopesForRole(other)].sort()).toEqual([...scopesForRole(row.role)].sort());
      }
    }
    expect(entry('admin').sameCeilingAs).toEqual(['orchestrator']);
  });
});

describe('elevated roles, kinds and who assigns', () => {
  it.each([...ASSIGNABLE_ROLE_NAMES])('%s: elevated matches ELEVATED_ROLES', (role) => {
    expect(entry(role).elevated).toBe(ELEVATED_ROLES.has(role));
  });

  it('an elevated role is meant for humans only: the role act refuses it anywhere else', () => {
    for (const role of ELEVATED_ROLES) {
      expect(entry(role).meantFor).toEqual(['human']);
      expect(entry(role).meantForText).toBe('Meant for humans.');
    }
  });

  it.each([...ASSIGNABLE_ROLE_NAMES])('%s: assigned by exactly the issuers canAssignRole admits', (role) => {
    const expected = ROLE_ACT_ISSUER_ROLES.filter((issuer) => canAssignRole(issuer, role));
    expect(entry(role).assignedBy).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
    for (const issuer of expected) expect(entry(role).assignedByText).toContain(issuer);
  });

  it('only admin assigns the two roles that derive root', () => {
    expect(entry('admin').assignedBy).toEqual(['admin']);
    expect(entry('orchestrator').assignedBy).toEqual(['admin']);
  });
});
