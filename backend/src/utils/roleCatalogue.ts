/**
 * THE ROLE CATALOGUE (card a2d1e317): one explanation per Account role, served
 * by `GET /principals/roles` and rendered under every role selector, in the
 * generated `docs/roles.md`, and nowhere else.
 *
 * Only two things here are written by hand, per role: the one-line PURPOSE and
 * the identity kinds the role is MEANT FOR. Both live in `ROLE_DESCRIPTIONS`,
 * a record typed over `AssignableRole`, so a role added to
 * `ASSIGNABLE_ROLE_NAMES` without a description fails `tsc` and the build.
 *
 * Everything else is DERIVED from the code that enforces it, never restated:
 *
 *   - the scope ceiling is `scopesForRole` (`utils/identityScopes.ts`), and the
 *     "may reach" and "never reaches" sentences are computed from it against
 *     `MINTABLE_SCOPES`;
 *   - "elevated" is `ELEVATED_ROLES`, and an elevated role belongs only to a
 *     parentless human Account (`PrincipalRoleService`,
 *     `ELEVATED_ROLE_REQUIRES_ACCOUNT`), which the suite holds `meantFor` to;
 *   - "assigned by" is `ROLE_ACT_ISSUER_ROLES` narrowed by `canAssignRole`, the
 *     ceiling both the role act and `POST /principals` apply;
 *   - "same ceiling as" compares the derived scope sets.
 *
 * The sentences are composed here, once, so the dashboard, the docs page and
 * any other reader show the same words.
 */
import { MINTABLE_SCOPES, ROOT_SCOPE } from './scopeMap';
import { scopesForRole } from './identityScopes';
import {
  ASSIGNABLE_ROLE_NAMES, ELEVATED_ROLES, canAssignRole, type AssignableRole,
} from './credentialAuthority';
import { ROLE_ACT_ISSUER_ROLES } from './administratorSession';

/** The identity kinds a role can be meant for (Group principals carry no role). */
export type RoleKind = 'human' | 'service' | 'agent';

export interface RoleDescription {
  /** One line: what the role is for. */
  purpose: string;
  /** Which kinds of identity the role is meant for. */
  meantFor: readonly RoleKind[];
}

/**
 * The hand-written half. Purpose lines say what a role is FOR and never what
 * it reaches: reach is derived below, and a sentence here that restated it
 * would be the second list this catalogue exists to remove.
 */
export const ROLE_DESCRIPTIONS: Record<AssignableRole, RoleDescription> = {
  admin: {
    purpose: 'Administers the whole deployment: settings, identities, credentials and every role.',
    meantFor: ['human'],
  },
  operator: {
    purpose: 'Administers product objects and ordinary Accounts, without the owner plane.',
    meantFor: ['human'],
  },
  editor: {
    purpose: 'Creates and changes the objects the Account is permitted to work on.',
    meantFor: ['human'],
  },
  user: {
    purpose: 'Everyday work on the objects the Account is permitted to work on.',
    meantFor: ['human'],
  },
  viewer: {
    purpose: 'Reads permitted objects without changing them: observers and read-only integrations.',
    meantFor: ['human', 'service'],
  },
  orchestrator: {
    purpose: 'Coordinates the board and its automation from a person’s Account.',
    meantFor: ['human'],
  },
  reviewer: {
    purpose: 'Checks other identities’ work and records evidence; the Task’s Verifier assignment still decides who verifies.',
    meantFor: ['human', 'service', 'agent'],
  },
  qa: {
    purpose: 'Runs quality checks and records test evidence under the same Task verification rules.',
    meantFor: ['service', 'agent'],
  },
  agent: {
    purpose: 'Automation that performs assigned work inside its credential and delegation limits.',
    meantFor: ['service', 'agent'],
  },
};

export interface RoleCatalogueEntry {
  role: AssignableRole;
  purpose: string;
  meantFor: RoleKind[];
  /** "Meant for humans." and the like. */
  meantForText: string;
  /** In `ELEVATED_ROLES`: derives administrative authority. */
  elevated: boolean;
  /** `scopesForRole(role)`, in `MINTABLE_SCOPES` order. */
  ceiling: string[];
  /** One sentence: the most this role may reach. */
  mayReach: string;
  /** One sentence: what this role never reaches. */
  neverReaches: string;
  /** Other roles whose derived ceiling is the same set. */
  sameCeilingAs: AssignableRole[];
  /** The administrator roles that may give this role. */
  assignedBy: string[];
  /** "Assigned by admin." and the like. */
  assignedByText: string;
}

const KIND_PLURAL: Record<RoleKind, string> = { human: 'humans', service: 'services', agent: 'agents' };
const KIND_ORDER: RoleKind[] = ['human', 'service', 'agent'];
/** The verbs of the scope vocabulary, in the order a sentence lists them. */
const VERB_ORDER = ['read', 'use', 'write', 'invoke', 'admin'];

function joinWords(words: string[], conjunction: 'and' | 'or'): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} ${conjunction} ${words[words.length - 1]}`;
}

/** Every mintable scope except `root`: the scopes a ceiling can be measured against. */
function scopesBelowRoot(): string[] {
  return MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE);
}

function verbOf(scope: string): string {
  return scope.slice(scope.indexOf(':') + 1);
}

/** For each verb, which of its scopes the ceiling holds and which it lacks. */
function verbSplit(ceiling: string[]) {
  const below = scopesBelowRoot();
  const verbs = [...VERB_ORDER, ...below.map(verbOf).filter((verb) => !VERB_ORDER.includes(verb))]
    .filter((verb, index, all) => all.indexOf(verb) === index)
    .filter((verb) => below.some((scope) => verbOf(scope) === verb));
  return verbs.map((verb) => {
    const all = below.filter((scope) => verbOf(scope) === verb);
    const held = all.filter((scope) => ceiling.includes(scope));
    return { verb, all, held, lacked: all.filter((scope) => !held.includes(scope)) };
  });
}

function mayReachSentence(ceiling: string[]): string {
  if (ceiling.includes(ROOT_SCOPE)) {
    return 'Everything: it holds root, which satisfies every scope check, owner-plane routes included.';
  }
  if (ceiling.length === 0) return 'Nothing: no scope at all.';
  const split = verbSplit(ceiling);
  const whole = split.filter((part) => part.held.length > 0 && part.lacked.length === 0).map((part) => part.verb);
  const partial = split.filter((part) => part.held.length > 0 && part.lacked.length > 0);
  const below = scopesBelowRoot().length;
  const pieces: string[] = [];
  if (whole.length > 0) pieces.push(`every ${joinWords(whole, 'and')} scope`);
  for (const part of partial) pieces.push(`the ${part.verb} scopes ${part.held.join(', ')}`);
  const sentence = joinWords(pieces, 'and');
  const lead = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  const count = ceiling.length === below ? `all ${below} scopes below root` : `${ceiling.length} of the ${below} scopes below root`;
  return `${lead} (${count}).`;
}

function neverReachesSentence(ceiling: string[]): string {
  if (ceiling.includes(ROOT_SCOPE)) {
    return 'No scope is out of reach; root itself is never put on a bearer credential, so keys stay below it.';
  }
  const split = verbSplit(ceiling);
  const none = split.filter((part) => part.held.length === 0).map((part) => part.verb);
  const partial = split.filter((part) => part.held.length > 0 && part.lacked.length > 0);
  const pieces = ['root, so no owner-plane route'];
  if (none.length > 0) pieces.push(`no ${joinWords(none, 'or')} scope`);
  for (const part of partial) pieces.push(`not ${part.lacked.join(', ')}`);
  const text = joinWords(pieces, 'and');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function meantForSentence(kinds: readonly RoleKind[]): string {
  const ordered = KIND_ORDER.filter((kind) => kinds.includes(kind)).map((kind) => KIND_PLURAL[kind]);
  return `Meant for ${joinWords(ordered, 'and')}.`;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((scope) => b.includes(scope));
}

/**
 * The whole catalogue, one entry per assignable role, in vocabulary order.
 *
 * `descriptions` defaults to `ROLE_DESCRIPTIONS`; it is a parameter so the
 * suite can prove the runtime half of "a role missing a description fails the
 * build": a role with no description, a blank purpose or no kind throws
 * `ROLE_DESCRIPTION_MISSING` rather than rendering an empty line. (The compile
 * half is the record type above.)
 */
export function roleCatalogue(
  descriptions: Readonly<Partial<Record<AssignableRole, RoleDescription>>> = ROLE_DESCRIPTIONS,
): RoleCatalogueEntry[] {
  const ceilings = new Map<AssignableRole, string[]>(
    ASSIGNABLE_ROLE_NAMES.map((role) => [role, scopesForRole(role).map(String)]),
  );
  return ASSIGNABLE_ROLE_NAMES.map((role) => {
    const description = descriptions[role];
    if (!description || !description.purpose.trim() || description.meantFor.length === 0) {
      throw new Error(`ROLE_DESCRIPTION_MISSING: the role '${role}' has no purpose or no kind in ROLE_DESCRIPTIONS`);
    }
    const ceiling = ceilings.get(role)!;
    const assignedBy = ROLE_ACT_ISSUER_ROLES.filter((issuer) => canAssignRole(issuer, role));
    return {
      role,
      purpose: description.purpose,
      meantFor: KIND_ORDER.filter((kind) => description.meantFor.includes(kind)),
      meantForText: meantForSentence(description.meantFor),
      elevated: ELEVATED_ROLES.has(role),
      ceiling,
      mayReach: mayReachSentence(ceiling),
      neverReaches: neverReachesSentence(ceiling),
      sameCeilingAs: ASSIGNABLE_ROLE_NAMES.filter((other) => other !== role && sameSet(ceilings.get(other)!, ceiling)),
      assignedBy,
      assignedByText: `Assigned by ${joinWords(assignedBy, 'or')}.`,
    };
  });
}

/** The committed documentation page, repository-relative. */
export const ROLE_CATALOGUE_DOC = 'docs/roles.md';
/** The dashboard tests' committed copy of the catalogue, repository-relative. */
export const ROLE_CATALOGUE_FIXTURE = 'frontend/src/components/access/roleCatalogue.generated.json';

/** The dashboard tests' copy: exactly the route's `roles` payload. */
export function renderRoleCatalogueFixture(entries: RoleCatalogueEntry[] = roleCatalogue()): string {
  return `${JSON.stringify({ roles: entries }, null, 2)}\n`;
}

/** Markdown table cells may not carry a pipe or a line break. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/**
 * `docs/roles.md`, rendered from the catalogue. `roleCatalogueDoc.test.ts`
 * fails when the committed page differs from this output; regenerate it with
 * `npm --prefix backend run docs:roles`.
 */
export function renderRoleCatalogueMarkdown(entries: RoleCatalogueEntry[] = roleCatalogue()): string {
  const lines: string[] = [
    '# Account roles',
    '',
    '<!-- Generated from backend/src/utils/roleCatalogue.ts by `npm --prefix backend run docs:roles`.',
    '     Do not edit by hand: backend/src/__tests__/roleCatalogueDoc.test.ts fails when this page',
    '     and the catalogue differ. -->',
    '',
    'Every Account carries one role. The role sets a scope ceiling: the most the',
    'Account may reach. It never grants an object by itself; ownership, grants,',
    'Task assignments, credential scopes and delegation limits still apply. Choose',
    'the least powerful role that fits the work.',
    '',
    'This table is the role catalogue the board serves at `GET /principals/roles`',
    '(`principals:read`). The dashboard shows the same text under every role',
    'selector: the Access manager\'s Roles section, the role-change confirmation and',
    'Create identity.',
    '',
    '| Role | Purpose | May reach | Never reaches | Meant for | Assigned by |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of entries) {
    lines.push(`| \`${entry.role}\` | ${cell(entry.purpose)} | ${cell(entry.mayReach)} | ${cell(entry.neverReaches)} | ${cell(entry.meantForText)} | ${cell(entry.assignedByText)} |`);
  }
  lines.push('');
  lines.push('## Roles that share a ceiling');
  lines.push('');
  lines.push('Roles with the same ceiling differ in intended use, not in reach.');
  lines.push('');
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.sameCeilingAs.length === 0 || seen.has(entry.role)) continue;
    const group = [entry.role, ...entry.sameCeilingAs];
    group.forEach((role) => seen.add(role));
    lines.push(`- ${group.map((role) => `\`${role}\``).join(', ')}`);
  }
  lines.push('');
  lines.push('## Elevated roles');
  lines.push('');
  const elevated = entries.filter((entry) => entry.elevated).map((entry) => `\`${entry.role}\``);
  lines.push(`${joinWords(elevated, 'and')} derive administrative authority. They belong only to a`);
  lines.push('parentless human Account: the role change refuses them on a service or an agent');
  lines.push('identity (`ELEVATED_ROLE_REQUIRES_ACCOUNT`).');
  lines.push('');
  return lines.join('\n');
}
