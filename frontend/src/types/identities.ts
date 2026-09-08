/**
 * THE ONE IDENTITY-CREATION FLOW — copy and rules (card `5592baf6`, defect
 * `43fcd071`, owner ruling 2026-09-07).
 *
 * Access administration used to offer a four-field "New principal" form beside
 * a separate "Connect your agent" wizard in My connections, and the owner read
 * the pair as redundant. Worse, the form could not complete two of the three
 * kinds it offered:
 *
 *   - Kind = Service answered `422 PURPOSE_REQUIRED` because the form never
 *     asked for a purpose (defect `43fcd071`; the rule is AUTHZ 4d961e37 A17.1
 *     and it is enforced in `backend/src/routes/principals.ts`);
 *   - Kind = Agent — the form's own DEFAULT — answered `422 AGENT_MINT_ONLY`,
 *     because `POST /principals` creates ACCOUNTS and Agent identities arrive
 *     only through the delegation machinery (A17.3/AZ-S5).
 *
 * So the unification is not only a UX act. The three kinds reach three
 * different substrate shapes, and this module states which:
 *
 *   HUMAN   — a parentless Account. Accounts are KEYLESS (A17.1/§7.1,
 *             `ACCOUNTS_ARE_KEYLESS`): a person signs in with a password or an
 *             invitation and never holds a bearer key. `POST /principals`.
 *   SERVICE — a parentless Account too, so it is keyless as well; it ACTS
 *             through a Connector registered under it. `POST /principals`
 *             followed by `POST /services` with `ownerAccountId` and
 *             `issueCredential` — the same registration-and-first-credential
 *             transaction the agent flow uses (§7.4, card 3f145fa3).
 *   AGENT   — the caller's own connection: `POST /services` with
 *             `kind: 'connector'` and `issueCredential`, which is exactly what
 *             `ConnectAgentWizard` already does. The wizard is EMBEDDED rather
 *             than reimplemented, so there is one agent code path and two
 *             entry points into it.
 *
 * Nothing here is a new authority. Every act is a route that already existed,
 * called by a session that could already call it.
 */
import type { ConnectionTransport } from './connections';

export type IdentityKind = 'human' | 'service' | 'agent';

export interface IdentityKindChoice {
  kind: IdentityKind;
  label: string;
  /** One sentence: when to use this one (card `66496447`). */
  blurb: string;
}

/**
 * Step 1. The sentences come from card `66496447` — "say when to use which" —
 * and each names the act rather than the object, because the person choosing
 * has not met the object yet.
 */
export const IDENTITY_KINDS: IdentityKindChoice[] = [
  {
    kind: 'human',
    label: 'Human',
    blurb:
      'A person who signs in — a colleague, when no identity provider is configured. '
      + 'They get a password or an invitation, never a key.',
  },
  {
    kind: 'service',
    label: 'Service',
    blurb:
      'Software that acts on its own — a CI bot, an integration, a Connector. '
      + 'It declares what it is for, and it acts through a connection you create for it.',
  },
  {
    kind: 'agent',
    label: 'Agent',
    blurb:
      'An agent, editor or script acting inside your own authority — Claude Code, Codex, a script. '
      + 'This is the same act as Connect an agent in My connections.',
  },
];

export interface RoleChoice {
  value: string;
  label: string;
  /** One line: what this role is for. */
  line: string;
}

/**
 * The roles this form offers, each with one line of purpose.
 *
 * DELIBERATELY A SHORT STATIC LIST, NOT A CATALOGUE. Card `a2d1e317` asks for a
 * backend-served role catalogue with the full scope ceiling per role, rendered
 * everywhere a role is named and gated by a doc-equals-catalogue test. That is
 * its work, not this one's. What is written here is the one-line purpose only,
 * derived from `backend/src/utils/identityScopes.ts` (`scopesForRole`) and
 * `backend/src/utils/credentialAuthority.ts` (`canAssignRole`), and it says
 * nothing a fuller catalogue would have to contradict.
 */
export const ROLE_CHOICES: RoleChoice[] = [
  {
    value: 'user',
    label: 'User',
    line: 'Ordinary work on the board: read and write tasks, reports and projects. No administration.',
  },
  {
    value: 'agent',
    label: 'Agent',
    line: 'The same reach as User, meant for automation rather than a person.',
  },
  {
    value: 'reviewer',
    label: 'Verifier',
    line: 'The same reach as User, for identities whose job is checking somebody else’s work.',
  },
  {
    value: 'orchestrator',
    label: 'Orchestrator',
    line: 'Administers the board, identities and credentials included. Only an administrator may assign it.',
  },
];

/** The default role per kind — the working set, never an elevated one. */
export function defaultRoleFor(kind: IdentityKind): string {
  return kind === 'human' ? 'user' : 'agent';
}

/**
 * A17.1, in the board's own words.
 *
 * This is the sentence `POST /principals` answers when a service Account
 * arrives without a purpose, quoted so the form can refuse BEFORE the request
 * and the person reads one wording rather than two. `identityPurposeRuleDrift`
 * fails the build if the route stops saying it.
 */
export const PURPOSE_REQUIRED_MESSAGE =
  'service Accounts must declare a purpose at creation (design 4d961e37 A17.1)';

/** `POST /principals` refuses a purpose longer than this (`INVALID_PURPOSE`). */
export const PURPOSE_MAX_LENGTH = 500;

export interface ServiceTransportChoice {
  value: Extract<ConnectionTransport, 'api' | 'mcp'>;
  label: string;
  note: string;
}

/**
 * What a service connection may be pinned to (§7.5, `POST /services`
 * `issueCredential.transport`). The pin is real: an `mcp` credential is refused
 * on every REST route with 403 TRANSPORT_MISMATCH and the reverse, so this
 * choice decides which setup tab the last step can even offer.
 *
 * `any` is deliberately not offered. A credential that speaks both is a wider
 * credential than the person asked for, and the two named answers cover what a
 * service actually is.
 */
export const SERVICE_TRANSPORTS: ServiceTransportChoice[] = [
  {
    value: 'api',
    label: 'REST or CLI',
    note: 'Scripts, CI jobs and the relayhall CLI.',
  },
  {
    value: 'mcp',
    label: 'MCP client',
    note: 'An MCP client such as Claude Code or Codex.',
  },
];

/** Dispatcher default for step 3 of the Service arm. */
export const DEFAULT_SERVICE_TRANSPORT: ServiceTransportChoice['value'] = 'api';

/**
 * The handle shape `validateNewHandle` accepts, mirrored so the form refuses
 * before the request rather than after a 400.
 */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function handleIsUsable(handle: string): boolean {
  const trimmed = handle.trim();
  return trimmed.length > 0 && trimmed.length <= 64 && HANDLE_PATTERN.test(trimmed);
}

/**
 * The refusals `POST /principals` actually emits, each said in the person's
 * words. An enumerated set over the CODE — never a pattern over the message —
 * so a server-side rewording cannot silently turn a named refusal generic.
 */
export function principalRefusalMessage(
  status: number,
  data: { code?: string; message?: string } | null | undefined,
): string {
  switch (data?.code) {
    case 'PURPOSE_REQUIRED':
      // The form refuses this before the request; reaching it means the two
      // wordings have drifted, and the drift control fails that build.
      return PURPOSE_REQUIRED_MESSAGE;
    case 'INVALID_PURPOSE':
      return `A purpose may be at most ${PURPOSE_MAX_LENGTH} characters. Shorten it and try again.`;
    case 'AGENT_MINT_ONLY':
      // Unreachable from this wizard — the Agent arm never calls this route —
      // but named anyway: an enumerated refusal written only for reachable
      // codes is a generic 500 waiting for the day one becomes reachable.
      return 'An agent identity is created by connecting it, not by this form. Choose Agent on the first step.';
    default:
      break;
  }
  if (status === 409) return 'That handle is already taken. Pick another.';
  if (status === 401 || status === 403) return 'You are not permitted to create an identity with this session.';
  if (status === 503) return 'This deployment has not migrated the identity substrate yet, so identities cannot be created.';
  return data?.message || 'The board refused the request. Nothing was created.';
}
