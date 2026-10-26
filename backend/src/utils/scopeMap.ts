/**
 * Route-family → required scope, under the ratified five-verb authority model
 * (vocabulary b94dd86e §5, decision D-10, amendment A5; re-cut dispositions
 * amendment A12, task 802e0f49).
 *
 * VERBS, by kind of consequence (§5.1): `read` is disclosure, `write` changes
 * board state, `use` fetches capability text into a context, `invoke` causes
 * execution outside the board, `admin` is delete/grant/force/approve-broadly.
 * Scopes are `<plural-object>:<verb>`.
 *
 * ENFORCEMENT MODEL
 * - Every identity path carries an explicit scope set. JWT/session identities
 *   receive a set derived from their trusted role source, the legacy service
 *   key is explicit root, and rh_ credentials carry their minted set.
 * - Missing/null scopes fail closed. There is no authenticated bypass arm.
 * - `root` (A12.1) is the global sentinel: it satisfies every requirement, is
 *   the credential-management gate, and is what an UNMAPPED route requires.
 *   Defaulting to "allow" would let any key reach anything the map forgot;
 *   this way a gap surfaces as a 403 on a specific route rather than as
 *   silent over-permission everywhere. `admin` is ONLY the per-object verb.
 * - The full ratified grantable table ships in the type (A12.3), but only
 *   scopes with a live route surface are mintable (`MINTABLE_SCOPES`); inert
 *   families become mintable when their objects land in Phase 2.
 * - The status-voice surface was deleted by owner ruling A13.3 (superseding
 *   A12.2's retention); `status:write` left the vocabulary with it. Its
 *   ratified successor is `telemetry:write` (AUTHZ design 4d961e37, A17.7):
 *   the presence/telemetry INGEST verb, minted at slice AZ-S6.
 */

export type Scope =
  // work plane (§5.2)
  | 'tasks:read' | 'tasks:write' | 'tasks:admin'
  | 'projects:read' | 'projects:write' | 'projects:admin'
  | 'phases:read' | 'phases:write' | 'phases:admin'
  | 'reports:read' | 'reports:write' | 'reports:admin'
  // capability plane
  | 'skills:read' | 'skills:use' | 'skills:write' | 'skills:admin'
  | 'personalities:read' | 'personalities:use' | 'personalities:write' | 'personalities:admin'
  // execution plane
  | 'services:read' | 'services:invoke' | 'services:write' | 'services:admin'
  | 'tools:read' | 'tools:invoke'
  | 'blueprints:read' | 'blueprints:use' | 'blueprints:write' | 'blueprints:admin'
  // identity plane
  | 'principals:read' | 'principals:admin'
  | 'audit:read'
  // directory provisioning plane (A24, RH-P5.SSO.W4 / SSO-R7): the object
  // is the inbound SCIM 2.0 surface and the verb is `write`. It is
  // Connector-delegable BY DESIGN, which is the whole reason it exists:
  // the SCIM client is a bearer credential, AZ-18 forbids delegating
  // `root` to one, and A24 is the declared amendment that supplies the
  // alternative. It authorizes creating parentless human Accounts at the
  // fixed minimal role, directory lifecycle attributes, `expected`
  // Identity links and `source='directory'` memberships — and NEVER role
  // elevation, grants, scope or credential administration, or any read
  // beyond provisioning reconciliation. That negative half is enforced by
  // this scope appearing on exactly ONE route family below.
  | 'directory-provisioning:write'
  // presence/telemetry plane (A17.7 — the A12.2 successor; ingest only, no
  // telemetry:read until a dedicated read surface exists)
  | 'telemetry:write'
  // E208: dedicated read-only, Account-bound monitoring collector.
  | 'metrics:read'
  // knowledge plane (vocabulary amendment A21, KNOWLEDGE-DESIGN `94747de9`
  // §5.1). The object is the CONTENTS disclosed — A18's shape, where the
  // selector ranges over knowledge-configured Service registry entries —
  // and the verb is `read` because the consequence is DISCLOSURE. The
  // outbound POST core makes to a source is CORE's act under the
  // owner-configured contract, not the caller exercising `invoke`.
  //
  // This is the FIRST `<compound>-contents:read` in the table.
  // `telemetry-contents:read` (A18) is ratified vocabulary with no code
  // anywhere in this tree; when its lane lands it reuses this shape and
  // the Agent-exclusion mechanism in `AgentMintService`.
  //
  // A21 keeps the ceiling honest in the negative direction too: the board
  // pseudo-source (§9) composes this scope with the SHIPPED object-family
  // scopes — `reports:read` / `tasks:read` / `skills:read`, and
  // `skills:use` for full skill content — so holding this one never
  // dissolves a scope gate that already exists.
  | 'knowledge-contents:read'
  // The WRITE verb on the same object (RB-11 Governor v0, card `b796067e`;
  // ratified design D-8, answer E1). Its consequence is a NOTE written into a
  // registered source's own store through the door: the core relays
  // propose / preview / commit to the source's write surface and stores no
  // content. It is a SEPARATE grant (R4 / D-MM6(c), "separately granted"):
  // holding `knowledge-contents:read` never satisfies it, and it never
  // satisfies the read scope. Agent layer (answer E2): mintable onto an Agent
  // only when requested EXPLICITLY at mint, inside the parent's own grants —
  // which is `AgentMintService`'s explicit request list plus the T2 ceiling,
  // so it is deliberately ABSENT from `AGENT_EXCLUDED_SCOPES`. E149 binds edits
  // too: no edit adds it to an Agent credential (`AGENT_MINT_ONLY_SCOPES` in
  // `AuthorityEditExecutor`, refusal `AGENT_SCOPE_MINT_ONLY`).
  | 'knowledge-contents:write'
  // global sentinel (A12.1)
  | 'root';

/** The complete ratified vocabulary (plus the two A12 declarations). */
export const ALL_SCOPES: Scope[] = [
  'tasks:read', 'tasks:write', 'tasks:admin',
  'projects:read', 'projects:write', 'projects:admin',
  'phases:read', 'phases:write', 'phases:admin',
  'reports:read', 'reports:write', 'reports:admin',
  'skills:read', 'skills:use', 'skills:write', 'skills:admin',
  'personalities:read', 'personalities:use', 'personalities:write', 'personalities:admin',
  'services:read', 'services:invoke', 'services:write', 'services:admin',
  'tools:read', 'tools:invoke',
  'blueprints:read', 'blueprints:use', 'blueprints:write', 'blueprints:admin',
  'principals:read', 'principals:admin',
  'audit:read',
  'telemetry:write',
  'metrics:read',
  'directory-provisioning:write',
  'knowledge-contents:read',
  'knowledge-contents:write',
  'root',
];

/**
 * Scopes that can be minted onto a credential today (A12.3): every member has
 * a live route surface. `skills:read/write/admin` gained theirs with the
 * `/skills` registry (RH-VOCAB.3, A14.1); `services:read/write/admin` gained
 * theirs with the `/services` registry (RH-P2.1); `phases:read/write/admin`
 * gained theirs with the `/phases` object (RH-P2.4) — the A12.3 promise that
 * "inert families become mintable when their objects land", kept in the same
 * candidate that lands the surface. `blueprints:*` and
 * `personalities:use` are
 * ratified vocabulary with no reachable object yet — issuable never, until
 * its object lands. `skills:use` is live for exact full SKILL.md fetches;
 * Brief compilation independently stays under `tasks:read` per A12/§10.
 * `services:invoke` became mintable with RH-P2.2: its consuming surface is
 * the §2.1 field-level check on the task profile-set paths — setting a
 * profile that targets a service requires invoke (or root) on top of
 * tasks:write. It is deliberately NOT a route-family rule: the verb gates a
 * field write inside POST/PATCH /tasks, so enforcement lives in the tasks
 * handlers (utils/executionProfile.ts + routes/tasks.ts), not this table.
 * `tools:*` waits for the Tool object surface itself: descriptors DECLARE
 * exposed Tools as data (D-3), but no route serves them yet (A14.2).
 * `telemetry:write` became mintable at AZ-S6 with its consuming surface,
 * POST /telemetry/frames (A17.7): the /telemetry family left the root
 * parking, each service writes only its own frames (in-handler identity
 * check in routes/telemetry.ts), and reads stay `tasks:read` — no
 * `telemetry:read` exists until a dedicated read surface does.
 * `knowledge-contents:read` (A21) becomes mintable at RH-KW1 candidate A
 * with its consuming surface, `GET /knowledge-sources` — the SAME rule and
 * the SAME commit shape as `telemetry:write` at AZ-S6 and
 * `directory-provisioning:write` at SSO.W4: the scope enters ALL_SCOPES
 * and MINTABLE_SCOPES in the same commit as the route family that
 * consumes it, never before. A21 additionally excludes it from
 * Agent-layer mints by default, which is NOT a property of this list:
 * mintable means "a credential may carry it", and the Agent-layer
 * exclusion is a separate, named check at the Agent mint seam
 * (`AgentMintService.validateRequestedScopes`, error code
 * `AGENT_EXCLUDED_SCOPE`). Both are required — a scope excluded from
 * Agent mints but absent here could not be minted onto ANY credential,
 * and the surface would be unreachable.
 * `knowledge-contents:write` (RB-11 Governor v0, D-8) becomes mintable in the
 * same commit as its consuming surface, the `/knowledge-writes` family
 * (propose / preview / commit) — the same rule again. It is NOT in the
 * Agent-layer exclusion set: answer E2 makes it mintable onto an Agent only
 * when the mint names it explicitly, inside the parent's own grants.
 * `directory-provisioning:write` (A24) became mintable at RH-P5.SSO.W4
 * candidate A with its consuming surface, the inbound SCIM 2.0 endpoint
 * family under /scim — the SAME rule and the SAME commit-shape as
 * `telemetry:write` at AZ-S6. Its route rule is the ONLY one in the table
 * that names it, which is how A24's "never ... any read beyond provisioning
 * reconciliation" is kept true as the table grows: a second family quietly
 * acquiring this scope is a census failure, not a silent widening.
 */
export const MINTABLE_SCOPES: Scope[] = [
  'blueprints:read', 'blueprints:use', 'blueprints:write', 'blueprints:admin',
  'tasks:read', 'tasks:write', 'tasks:admin',
  'projects:read', 'projects:write', 'projects:admin',
  'phases:read', 'phases:write', 'phases:admin',
  'reports:read', 'reports:write', 'reports:admin',
  'skills:read', 'skills:use', 'skills:write', 'skills:admin',
  'personalities:read', 'personalities:write', 'personalities:admin',
  'services:read', 'services:invoke', 'services:write', 'services:admin',
  'principals:read', 'principals:admin',
  'audit:read',
  'telemetry:write',
  'metrics:read',
  'directory-provisioning:write',
  'knowledge-contents:read',
  'knowledge-contents:write',
  'root',
];

/** `root` is the global sentinel: holding it satisfies every check (A12.1). */
export const ROOT_SCOPE: Scope = 'root';

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (ALL_SCOPES as string[]).includes(value);
}

export function isMintableScope(value: unknown): value is Scope {
  return typeof value === 'string' && (MINTABLE_SCOPES as string[]).includes(value);
}

export type RequiredScope = Scope | 'authenticated';

interface ScopeRule {
  /** Matched against the mounted path (baseUrl + path), which has no /api prefix. */
  pattern: RegExp;
  /** Methods this rule covers; omitted means all. */
  methods?: string[];
  scope: RequiredScope;
}

/**
 * Normalises a request path into the single form the rules are written
 * against.
 *
 * Express routes with `strict:false` and `caseSensitive:false`, so
 * `/tasks/x/brief`, `/tasks/x/brief/` and `/tasks/x/BRIEF` all reach the
 * SAME handler. A matcher that only recognises the canonical spelling lets
 * the other spellings fall through to the next matching rule. Post-A12 the
 * Brief rule NARROWS (read instead of the generic POST write rule), so a
 * missed spelling now fails closed to the STRONGER `tasks:write` — but the
 * immunity is kept so the requirement stays uniform across spellings.
 */
export function normalizePathForScope(mountedPath: string): string {
  const collapsed = (mountedPath || '/')
    .split('?')[0]
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
  const trimmed = collapsed.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * First match wins, so the narrower rules are listed before their families.
 *
 * EXECUTION-ADJACENT ROUTES, pinned deliberately (A12.6 — no `invoke`
 * surface exists at v1; these are board plumbing and this list is the diff
 * surface a future widening must show up in):
 *   POST /tasks/:id/notifications/deliver  -> tasks:write  (outbound Discord)
 *   POST /tasks/:id/breakdown              -> tasks:write  (may call a model)
 *   POST /litellm/*                        -> root         (external service admin)
 *   (POST /personalities/sync left this list 2026-08-09 — the repository-import
 *    surface was removed by owner ruling; the path now falls to the
 *    /personalities family write rule and answers 404, no handler exists.)
 */
const RULES: ScopeRule[] = [
  { pattern: /^\/metrics$/, methods: ['GET'], scope: 'metrics:read' },
  // Brief compilation is a disclosure act (§10, A7): the retired tasks:prompt
  // scope folds into read. RH-P3.C4 (ii) / D4: the route is `/brief` now, at
  // every altitude; `/prompt`, `/spawn-prompt` and `/generate-brief` are gone
  // and are NOT aliased, so a caller on an old spelling gets a 404 rather than
  // a silently-still-working retired name.
  { pattern: /^\/tasks\/[^/]+\/brief$/, scope: 'tasks:read' },
  { pattern: /^\/projects\/[^/]+\/brief$/, scope: 'tasks:read' },

  // Hard removal is the admin verb (§4.4, §5.1): task deletion leaves the
  // routine write plane. Dependency/note/subtask deletes remain writes below.
  { pattern: /^\/tasks\/[^/]+$/, methods: ['DELETE'], scope: 'tasks:admin' },

  // The exceptional Task confidentiality mode (migration 117, ruling
  // 44ee41f2) is an OWNER-PLANE act, not a content write - the 085/phases
  // precedent one line at a time. It is listed before the tasks family rules
  // so a PATCH cannot fall through to `tasks:write`.
  { pattern: /^\/tasks\/[^/]+\/access$/, scope: 'tasks:admin' },

  // Identity plane (A12.5): the principal directory and a caller's own grant
  // introspection are agent-plane-readable; mutation and cross-principal
  // introspection sit behind principals:admin + the in-handler manage gate.
  // The §10 remediation queue (AZ-S4) discloses legacy shapes and their
  // live-credential counts — operator data, owner-plane like the what-if.
  // Blueprints read/use are independent. The two discovery routes admit
  // authentication here and enforce their disjunction plus object predicate
  // in BlueprintRegistryService; no other Blueprint route uses that ceiling.
  { pattern: /^\/blueprints(?:\/[^/]+)?$/, methods: ['GET'], scope: 'authenticated' },
  { pattern: /^\/blueprints\/[^/]+\/instantiations(?:\/preview)?$/, methods: ['POST'], scope: 'blueprints:use' },
  { pattern: /^\/blueprints\/[^/]+\/versions\/[^/]+\/(reject|publish|retire)$/, methods: ['POST'], scope: 'blueprints:admin' },
  { pattern: /^\/blueprints(\/|$)/, methods: ['GET'], scope: 'blueprints:read' },
  { pattern: /^\/blueprints(\/|$)/, scope: 'blueprints:write' },
  { pattern: /^\/instantiations\/[^/]+$/, methods: ['GET'], scope: 'blueprints:read' },
  { pattern: /^\/instantiations\/[^/]+\/setup(?:\/preview)?$/, methods: ['POST'], scope: 'blueprints:use' },
  { pattern: /^\/principals\/remediation-queue$/, scope: 'root' },
  // The SESSION altitude of the Brief family (RH-P3.C4 (ii), strategy §2.10):
  // THE BOOTSTRAP. Its ceiling is a SELF-IDENTITY rule (card 1118fefa), on the
  // `/preferences` and SETGOV `D-5` precedent below: the route takes no target
  // identifier, so authentication plus the resolved caller principal is the
  // whole boundary, and it discloses the caller to itself. It was
  // `principals:read`, which left every Agent minted without that scope — the
  // ordinary tasks/reports worker — unable to bootstrap, and so unable to
  // claim, move or report (reproduced on production 2026-10-09).
  // `principals:read` is the scope for reading OTHER principals, and it stays
  // exactly that on the family rules below.
  //
  // What the payload ENCLOSES is not decided by this row. Every enclosed piece
  // — the bound Task, the Personality, the attached Reports and the granted
  // skill index — is evaluated against the caller's own grants (review
  // e2c2a49f B1), AND is admitted only to a credential carrying a content
  // scope: `SESSION_BRIEF_CONTENT_SCOPES` in `utils/promptTemplate`, which is
  // `tasks:read` (the Brief family's read ceiling at every other altitude) or
  // `principals:read` (this row's former ceiling, so every caller that compiled
  // before receives the same Brief). A credential with neither receives its
  // identity block and the doctrine and nothing else; `compileSessionBrief` is
  // where to check that rather than take it on trust. Being recorded as
  // bootstrapped opens no route: the MCP gate admits a TOOL, and this table
  // still decides every call the tool makes.
  //
  // It must sit ABOVE the `/principals` family rules, which would otherwise put
  // a POST behind `principals:admin` and make the fail-closed bootstrap gate
  // unbootstrappable for exactly the agent identities it exists to serve.
  { pattern: /^\/principals\/me\/brief$/, methods: ['POST'], scope: 'authenticated' },
  // SETGOV `D-5` (design 7a9317b2 §1.5/§10, AUTHZ amendment AZ-A5 clause 9b),
  // ACCEPTED by owner ruling `dda2cdcc` §1: the caller's own principal and its
  // own effective access move from `principals:read` to `authenticated`, on the
  // `/preferences` precedent below - "The route has no target identifier, so
  // authentication plus the resolved caller principal is the whole boundary".
  // Both routes are that shape: no target identifier, disclosing the caller to
  // itself and nothing else. Without the move, the claim that EVERY Account
  // reaches the Settings shell is false at the pin - `scopesForRole` returns []
  // for a role outside its known set, so `me` 403s and no Settings link renders.
  // `POST /principals/me/brief` ABOVE kept `principals:read` here because it
  // encloses Task, Personality and Report content; card 1118fefa moved it to
  // the same self-identity ceiling and admits that content by scope inside the
  // compiler instead. The rest of the /principals family is untouched.
  { pattern: /^\/principals\/me$/, methods: ['GET'], scope: 'authenticated' },
  { pattern: /^\/principals\/me\/effective-access$/, methods: ['GET'], scope: 'authenticated' },
  // RH-LENSES-a (card 74e02a05, design 07764243 §5.1): a person's OWN
  // directory group references. Same shape as the two rules above and same
  // reason — no target identifier, disclosing the caller to itself and
  // nothing else — so it takes the same `authenticated` ceiling on the D-5
  // precedent rather than deciding the family's rule for itself.
  //
  // IT MUST SIT ABOVE THE FAMILY FALLBACKS BELOW. A rule placed after
  // `/principals(\/|$)` GET silently becomes `principals:read`, and the
  // claim that every Account can see its own directory groups would be
  // false for exactly the ordinary Accounts it is about.
  { pattern: /^\/principals\/me\/directory-group-references$/, methods: ['GET'], scope: 'authenticated' },
  // RH-LENSES-d (card 4e159741; design 96f0bd3d s8.3, obligation B-L9d): the
  // caller's OWN lenses - which dashboard sections it is offered. Same shape
  // as the `/principals/me` rules above (no target identifier; it discloses
  // the caller to itself), so it takes their `authenticated` ceiling and
  // inherits the D-5 move rather than making it (DBD-11).
  //
  // THE PLACEMENT IS LOAD-BEARING and asserted, not assumed:
  // `__tests__/lensesContract.test.ts` requires this line ABOVE both
  // `/principals` family rules and requires the resolver to answer
  // `authenticated` for it. Below them it would silently become
  // `principals:read`, which an ordinary Account does not hold, and the one
  // read every dashboard needs to draw its navigation would refuse exactly the
  // people it is for. GET only: no other method exists here.
  { pattern: /^\/principals\/me\/lenses$/, methods: ['GET'], scope: 'authenticated' },
  // RH-LENSES-b (card 4287af8a; design 96f0bd3d s7.2). The caller's OWN home
  // group, on the `/preferences` and D-5 precedent immediately above: the
  // route has no target identifier, so authentication plus the resolved
  // caller principal is the whole boundary, and it discloses the caller to
  // itself and nothing else.
  //
  // THE PLACEMENT IS LOAD-BEARING, and it is asserted rather than assumed:
  // `__tests__/lensesCreationDefaultMutations.test.ts` reads this file and
  // requires this rule to appear ABOVE both `/principals` family rules.
  // Below them a GET here would silently become `principals:read` and a PUT
  // would become `principals:admin` - and the claim that every Account can
  // choose its own home group would be false. (Round-1 review NB1: this
  // comment named a suite that does not exist - the working name of the file
  // above - and a control cited by a name nothing answers to is a control
  // nobody can find.)
  //
  // The act CONFERS NOTHING (design s7.2): authority moves at one later act,
  // the creation default of s7.3, which re-derives `featured`, membership and
  // `active` at its own write rather than trusting this pointer.
  { pattern: /^\/principals\/me\/home-group$/, scope: 'authenticated' },
  { pattern: /^\/principals\/[^/]+\/owner-control$/, methods: ['POST'], scope: 'authenticated' },
  { pattern: /^\/principals(\/|$)/, methods: ['GET'], scope: 'principals:read' },
  { pattern: /^\/principals(\/|$)/, scope: 'principals:admin' },
  // The §9.3 agent-plane credential acts (AZ-S5): reveal and revoke
  // dispatch by AUTHENTICATION KIND in their handlers — bearer callers
  // strictly inside their own descendant lineage (reveal additionally
  // under the presenting-authority ceiling, revoke as the protective
  // direction), sessions under step-up/subtree arms, everything else
  // falling to the manage gate. The route ceiling is therefore
  // 'authenticated'; a working-plane credential outside the lineage still
  // learns nothing (404-conceal / 403). Rotation and the rest of the
  // family stay owner-plane.
  { pattern: /^\/credentials\/[^/]+\/(reveal|revoke)$/, scope: 'authenticated' },
  // AZ-A13 clause 15a (ratified 2026-10-11, E95) — DECLARED ROUTE-CEILING
  // CHANGE on the reveal/revoke precedent: the in-place edit of a Connector
  // credential. The real gate is in the handler: a login session (a bearer is
  // refused SESSION_ONLY, audited), and root, an administrator session, or the
  // owning Account's subtree; a widening also needs a step-up bound to the
  // credential. Listed before the family row below: the first match wins.
  { pattern: /^\/credentials\/[^/]+$/, methods: ['PATCH'], scope: 'authenticated' },
  { pattern: /^\/credentials(\/|$)/, scope: 'principals:admin' },

  // Owner-plane configuration stays behind the sentinel (A12.7).
  { pattern: /^\/webhooks(\/|$)/, scope: 'root' },
  { pattern: /^\/litellm(\/|$)/, scope: 'root' },
  // Grant management (RH-P2.3, §2.9): creation/widening/revocation stays out
  // of the agent plane — every /grants method is owner-plane. A principal's
  // OWN grants are introspectable at /principals/{id}/grants under the
  // principals family rules below (A12.5 pattern, in-handler own/manage split).
  { pattern: /^\/grants(\/|$)/, scope: 'root' },
  // Groups (AZ-S1, design 4d961e37 §3/§9.1, A17.6): group MUTATION is
  // owner-plane like /grants — group self-escalation by an agent
  // credential dies at this route ceiling (T13). Group LISTINGS are
  // directory disclosure under principals:read (the A12.5 pattern). The
  // directory-sync staleness read is operator telemetry and stays behind
  // the sentinel with the mutation surface.
  // Access profiles (AZ-S2, design 4d961e37 §4/§9.1, A17.4): profile
  // MUTATION is owner-plane; LISTINGS are principals:read introspection.
  // The what-if preview discloses ANOTHER principal's authority and the
  // provenance events read carries actor detail — both stay behind the
  // sentinel (narrower rules listed first; first match wins).
  { pattern: /^\/access-profiles\/what-if$/, scope: 'root' },
  { pattern: /^\/access-profiles\/[^/]+\/events$/, scope: 'root' },
  { pattern: /^\/access-profiles(\/|$)/, methods: ['GET'], scope: 'principals:read' },
  { pattern: /^\/access-profiles(\/|$)/, scope: 'root' },
  // AZ-A12 build 6 (card 1e56dbef; clause 12): the Access Explorer read model.
  // GET rides `principals:read` for the reason `/groups` GET does (design
  // 4d961e37 §5.3: Groups, membership, Group roles and Group ownership are
  // directory data); the handlers narrow it: the object hop answers only a
  // caller that reads the object, and another principal's authority only a
  // `root` caller (the what-if standard). The family has no mutation.
  { pattern: /^\/access-explorer(\/|$)/, methods: ['GET'], scope: 'principals:read' },
  { pattern: /^\/access-explorer(\/|$)/, scope: 'root' },
  // Warrants + Approvals (AZ-S4, design 4d961e37 §6/§9.1): NO new scope
  // families. Both surfaces are SESSION-ONLY human planes carrying the
  // §6.1 self-scope step-up arm IN THE HANDLERS (the owning Account sees
  // and decides only its own subtree, 404-concealed outside it; root full
  // view; every decide/create act consumes a single-use step-up token;
  // bearer credentials refuse with a durable audit). The route ceiling is
  // therefore 'authenticated' — the real gate is authentication KIND plus
  // subtree containment, which a scope string cannot express.
  { pattern: /^\/warrants(\/|$)/, scope: 'authenticated' },
  { pattern: /^\/approvals(\/|$)/, scope: 'authenticated' },
  // The one mint route (§9.2, review r5-F1): dispatched by authentication
  // kind in the handler — a Connector bearer credential (request /
  // warrant-mint / collect, gated by the §5.2 non-escalation contract and
  // the full §6 validation) or an authenticated login session + step-up
  // (§6.1a). Same reasoning: 'authenticated' ceiling, contract-enforcing
  // handlers.
  { pattern: /^\/delegation\/agent-mints(\/|$)/, scope: 'authenticated' },
  // AZ-A9 clause 9 (ratified 2026-10-10 (E43); card 785e1eed) — DECLARED ROUTE-CEILING
  // AMENDMENT on the AZ-A5 clause 9b precedent. Grant and credential REQUESTS
  // are filed, read, withdrawn and collected here, beside the mint route
  // (§9.2: "agent-plane REST mirrors of the §9.3 operations under
  // /delegation/*"). The handlers are bearer-only — a login-session caller is
  // refused AGENT_PLANE_ONLY — and filing changes no authority table (clause
  // 2); deciding stays on /approvals, and /grants keeps `root` above.
  { pattern: /^\/delegation\/access-requests(\/|$)/, scope: 'authenticated' },
  // The §9.3 holder-plane warrant view (AZ-S5): a bearer Connector reads
  // ONLY its own standing mint authorizations — the handler refuses every
  // non-bearer caller; the management registry stays session-only on
  // /warrants.
  { pattern: /^\/delegation\/warrants$/, methods: ['GET'], scope: 'authenticated' },
  // ── RH-LENSES-a: the remote-group catalog (card 74e02a05) ───────────
  //
  // READ rides `principals:read` for the reason `/groups` GET does
  // (`4d961e37` §5.3: "group list and membership are directory data —
  // readable under `principals:read`"), and the in-handler §5.3 projection
  // narrows it further: a non-root caller gets `200` and an EMPTY LIST, so
  // the ceiling is the outer bound and not the whole boundary.
  //
  // MUTATION rides `root` for the reason `/groups` non-GET does: *Use this
  // group* creates and binds a Group, which are rule-4 acts A-4 and A-5,
  // and the housekeeping delete forgets what the directory showed. NO NEW
  // SCOPE — A17.8 holds, and this family mints nothing.
  //
  // The `/use` rule is listed FIRST so the literal segment cannot resolve
  // as a reference id under the GET rule below it.
  { pattern: /^\/directory-group-references\/[^/]+\/use$/, methods: ['POST'], scope: 'root' },
  { pattern: /^\/directory-group-references(\/|$)/, methods: ['GET'], scope: 'principals:read' },
  { pattern: /^\/directory-group-references(\/|$)/, scope: 'root' },
  // LENSES-c c1-A (card 46cfbd1d; design delta C.4 removal, ruling E98 Q3):
  // a Group OWNER removes a MANAGER row through this route, so its ceiling is
  // `authenticated` and the boundary is the in-handler gate (a login session,
  // a human Account acting as itself, a live owner-role row on the Group, the
  // target a manager row, a step-up) -- the /credentials/:id/(reveal|revoke)
  // shape. It is listed BEFORE the /groups rules: first match wins, and
  // without it the DELETE would fall to the family's `root` rule below. The
  // order is asserted by groupStewardsRegisters.test.ts (LC-C3).
  //
  // LENSES-c c1-B (card b5c83682; design delta C.4, gate (iii)): a Group OWNER
  // appoints a MANAGER in that Group through POST /groups/:id/managers, on the
  // same shape: ceiling `authenticated`, the in-handler gate the boundary (a
  // login session, a human Account acting as itself, a live owner-role row on
  // the Group, an eligible member appointee, a step-up). Listed with the DELETE
  // rule, BEFORE the /groups rules; lensesGatesRegisters.test.ts asserts it.
  { pattern: /^\/groups\/[^/]+\/managers$/, methods: ['POST'], scope: 'authenticated' },
  { pattern: /^\/groups\/[^/]+\/managers\/[^/]+$/, methods: ['DELETE'], scope: 'authenticated' },
  { pattern: /^\/groups\/directory-sync$/, scope: 'root' },
  { pattern: /^\/groups(\/|$)/, methods: ['GET'], scope: 'principals:read' },
  { pattern: /^\/groups(\/|$)/, scope: 'root' },
  // Appearance is owner-plane configuration. The full object and deployment
  // information are authenticated disclosures, but every mutation, version
  // history and historical byte read requires the global sentinel. No
  // appearance:* vocabulary is introduced (RH-DESIGN.6 §5.1/§7).
  { pattern: /^\/appearance\/?$/, methods: ['GET'], scope: 'authenticated' },
  { pattern: /^\/appearance\/info\/?$/, methods: ['GET'], scope: 'authenticated' },
  { pattern: /^\/appearance(\/|$)/, scope: 'root' },
  // The caller's own display preferences are authenticated self-service, not
  // a new grantable object family. The route shape prevents cross-user access.
  { pattern: /^\/preferences(\/|$)/, scope: 'authenticated' },
  // The core append-only ledger lands with RH-P2.7. It is disclosure-only;
  // there is deliberately no mutation or purge route in v1.
  { pattern: /^\/audit(\/|$)/, methods: ['GET'], scope: 'audit:read' },

  // The cursor event feed (RH-P3.C1, strategy 4e40f06f §2.6) is a
  // disclosure act over work objects, gated like the Brief compile under the
  // A12 §10 precedent: tasks:read, with per-event grant scoping in the
  // handler. No new scope is minted; the feed read carries no write surface.
  { pattern: /^\/events(\/|$)/, methods: ['GET'], scope: 'tasks:read' },

  // Card 5854f0d6 (Notifications and Timeline, E394, choice C3): "Needs your
  // action", the Timeline and the caller's OWN last-seen cursor. The route
  // ceiling is tasks:read; every other object type's arm requires its own
  // read scope IN the query (design section 4.5), so a tasks:read-only bearer
  // sees no report, phase, project or skill row. The seen POST writes only the
  // caller's own read mark, a disclosure-plane convenience, hence tasks:read.
  // EXACT: any other path or method under the mount matches no rule and falls
  // to root, fail closed.
  { pattern: /^\/notifications\/(actions|timeline)$/, methods: ['GET'], scope: 'tasks:read' },
  { pattern: /^\/notifications\/timeline\/seen$/, methods: ['POST'], scope: 'tasks:read' },
  // Owner ruling E455 (Action Center, card 5854f0d6): the caller marks its OWN
  // action items seen. It writes only the caller's own seen marks, for keys on
  // the caller's own list, the same disclosure-plane convenience as the
  // Timeline's last-seen cursor, hence the same ceiling as the list itself.
  { pattern: /^\/notifications\/actions\/seen$/, methods: ['POST'], scope: 'tasks:read' },
  // Owner ruling E467: the read-only owner-queue form of the list (the items
  // waiting on the owning person's Account, for that person's own Connector or
  // an Agent under it, as well as the caller's own). It writes nothing; every
  // item beyond what the caller reads is kind and id only, so the ceiling is
  // the list's own. Exact, like its neighbours.
  { pattern: /^\/notifications\/actions\/owner$/, methods: ['GET'], scope: 'tasks:read' },

  // LENSES-c c1-B (card b5c83682; design delta C.6, gate (ii) and DD-5): the
  // steward transfer of a Task's account owner. Its ceiling is `tasks:write`
  // and it MUST be listed before the two /tasks family rules below: the first
  // match wins, and the family's write rule already shadows the account-owner
  // rule further down (census correction CC-8). The gate is in the handler
  // (TaskAccountOwnershipService.changeAsGroupOwner); lensesGatesRegisters
  // asserts the order.
  { pattern: /^\/tasks\/[^/]+\/account-owner\/steward$/, methods: ['PUT'], scope: 'tasks:write' },
  { pattern: /^\/tasks(\/|$)/, methods: ['GET'], scope: 'tasks:read' },
  { pattern: /^\/tasks(\/|$)/, scope: 'tasks:write' },

  { pattern: /^\/reports\/[^/]+$/, methods: ['DELETE'], scope: 'reports:admin' },
  { pattern: /^\/reports(\/|$)/, methods: ['GET'], scope: 'reports:read' },
  { pattern: /^\/reports(\/|$)/, scope: 'reports:write' },

  // Compatibility inventory is a management surface (contract 21a04c23 §2.3):
  // counts of compatibility-held legacy Project data — the projects admin verb.
  { pattern: /^\/projects\/[^/]+\/compatibility$/, scope: 'projects:admin' },

  // Charter (A9, task f2735f1b): reading the authority index is ordinary
  // project disclosure; direct mutation is owner-plane by ruling ("agents propose,
  // the owner approves"), so the original PUT sits behind the root sentinel
  // like /webhooks and /litellm — deliberately NOT the mintable
  // projects:write, which would put the Charter in the agent plane.
  // Named human project approval has additional transactional identity and
  // ownership checks. This does not grant Charter authorship to write tokens.
  { pattern: /^\/projects\/[^/]+\/charter\/approve$/, methods: ['POST'], scope: 'projects:write' },
  { pattern: /^\/projects\/[^/]+\/charter(\/|$)/, methods: ['GET'], scope: 'projects:read' },
  { pattern: /^\/projects\/[^/]+\/charter(\/|$)/, scope: 'root' },

  // A Project's Phases reached through the Project route family (RH-P2.4):
  // the same rows the /phases family serves, Project-bound. Ordinary project
  // disclosure, listed before the generic project rules so the narrower
  // pattern wins.
  { pattern: /^\/projects\/[^/]+\/phases$/, methods: ['GET'], scope: 'projects:read' },

  { pattern: /^\/tasks\/[^/]+\/account-owner$/, methods: ['PUT'], scope: 'tasks:admin' },
  // LENSES-c c1-B (card b5c83682; design delta C.6): the steward transfer of a
  // Project's owner, an explicit `projects:write` rule listed before the
  // administrator route's `projects:admin` and before the family rules. The
  // gate is in the handler (ProjectOwnershipService.changeAsGroupOwner).
  { pattern: /^\/projects\/[^/]+\/owner\/steward$/, methods: ['PUT'], scope: 'projects:write' },
  { pattern: /^\/projects\/[^/]+\/owner$/, methods: ['PUT'], scope: 'projects:admin' },
  // Card 41e24358 (design ba22fd01 Part 2; check F2) - DECLARED ROUTE-CEILING
  // CHANGE on the AZ-A13 credential-edit precedent: the default Verifier of a
  // Project or Phase. The real gate is in the handler (routes/
  // defaultVerifierRoute.ts): a login session (a bearer is refused
  // SESSION_ONLY, audited), and root, an administrator session or the person
  // owner of the Project; on a Group-owned Project only root or an
  // administrator. Listed before the family rows: the first match wins.
  { pattern: /^\/projects\/[^/]+\/default-verifier$/, methods: ['PUT'], scope: 'authenticated' },
  { pattern: /^\/projects\/[^/]+\/owner-candidates$/, methods: ['GET'], scope: 'projects:admin' },
  { pattern: /^\/projects(\/|$)/, methods: ['GET'], scope: 'projects:read' },
  { pattern: /^\/projects(\/|$)/, scope: 'projects:write' },

  // Phase object (RH-P2.4): reads are disclosure; content writes and the
  // reversible archive/unarchive verbs are the write verb; hard delete is the
  // admin verb (§4.4/§5.1). The Brief compile at /phases/{id}/brief rides
  // phases:read HERE and additionally requires tasks:read inside the handler,
  // because its output discloses Task content and Brief-compile authority is
  // tasks:read per A12/§10 — the RH-P2.2 field-level-check pattern. It is
  // listed before the family write rule because it is a POST that must not
  // require phases:write.
  { pattern: /^\/phases\/[^/]+\/default-verifier$/, methods: ['PUT'], scope: 'authenticated' },
  { pattern: /^\/phases\/[^/]+$/, methods: ['DELETE'], scope: 'phases:admin' },
  { pattern: /^\/phases\/[^/]+\/access$/, scope: 'phases:admin' },
  { pattern: /^\/phases\/[^/]+\/brief$/, scope: 'phases:read' },
  { pattern: /^\/phases(\/|$)/, methods: ['GET'], scope: 'phases:read' },
  { pattern: /^\/phases(\/|$)/, scope: 'phases:write' },

  // sessions:read retired (A12.2): the pipeline-health seed is an ops
  // disclosure like the other read-only reference surfaces.
  { pattern: /^\/sessions(\/|$)/, methods: ['GET'], scope: 'tasks:read' },

  // Personality registry (A12.4): reads split off the ops bundle; create and
  // update are the write verb; retire is the admin verb. The in-handler manage
  // gate stays on every mutation, so nothing widens relative to the pre-A12
  // admin-by-fallthrough posture. The /personalities/sync rule left with the
  // repository-import surface (removed 2026-08-09): the old path now falls to
  // the family write rule below and answers 404 — no handler exists.
  { pattern: /^\/personalities\/[^/]+$/, methods: ['DELETE'], scope: 'personalities:admin' },
  { pattern: /^\/personalities(\/|$)/, methods: ['GET'], scope: 'personalities:read' },
  { pattern: /^\/personalities(\/|$)/, scope: 'personalities:write' },

  // Immutable Skills registry (A14.1 / RH-P2.10): metadata is read, exact
  // SKILL.md content is use, draft/review transitions are write, and broad
  // publication/audience/retirement plus hard removal are admin.
  { pattern: /^\/skills\/[^/]+\/versions\/[^/]+\/content$/, methods: ['GET'], scope: 'skills:use' },
  { pattern: /^\/skills\/[^/]+\/versions\/[^/]+\/(publish|retire)$/, scope: 'skills:admin' },
  { pattern: /^\/skills\/[^/]+\/audience$/, scope: 'skills:admin' },
  // Card d67e6990: setting a Skill's owner is registry administration.
  { pattern: /^\/skills\/[^/]+\/owner$/, methods: ['PUT'], scope: 'skills:admin' },
  { pattern: /^\/skills\/[^/]+$/, methods: ['DELETE'], scope: 'skills:admin' },
  { pattern: /^\/skills(\/|$)/, methods: ['GET'], scope: 'skills:read' },
  { pattern: /^\/skills(\/|$)/, scope: 'skills:write' },

  // Knowledge plane (RH-KW1, KNOWLEDGE-DESIGN `94747de9` §5.1/§10.2,
  // vocabulary amendment A21). `/knowledge-sources` discloses the
  // caller's QUERYABLE SET — which knowledge-configured Services it may
  // address — and is therefore the disclosure verb on the contents
  // object, exactly like every other read surface here.
  //
  // This rule is the ONLY one in the table that names
  // `knowledge-contents:read`, and that is load-bearing: it is how A21's
  // ceiling stays true as the table grows. A second family quietly
  // acquiring this scope is a census failure, not a silent widening —
  // the `directory-provisioning:write` discipline, applied again.
  //
  // Candidates B–D of RH-KW1 add `/knowledge-contents` (§8) and
  // `/knowledge-queries` (§7) beside it; the JWKS route of §10.2 is
  // deliberately NOT here, because it mounts OUTSIDE the protected mesh
  // on the OAuth well-known precedent and serves public keys only.
  { pattern: /^\/knowledge-sources(\/|$)/, methods: ['GET'], scope: 'knowledge-contents:read' },
  // Candidate B: §8.2's drill-down. The SAME scope, because it discloses
  // the same object — the CONTENTS — and A21's ceiling is written against
  // that object, not against a route.
  { pattern: /^\/knowledge-contents(\/|$)/, methods: ['GET'], scope: 'knowledge-contents:read' },
  // Candidate C: §7's search. POST, because a query carries a body — but it
  // is a READ in every sense that matters here, and it takes the same READ
  // scope rather than a write one. A21's ceiling is written against the
  // CONTENTS disclosed, and this route discloses exactly those contents.
  { pattern: /^\/knowledge-queries(\/|$)/, methods: ['POST'], scope: 'knowledge-contents:read' },
  // RB-11 Governor v0 (card `b796067e`, D-8): the three write verbs, each a
  // door relay to the source's own write surface (answer E1). This rule is
  // the ONLY one in the table that names `knowledge-contents:write` — census
  // C3 of the design's test plan — and it is EXACT: the three verbs, POST
  // only. Any other path or method under `/knowledge-writes` matches no rule
  // and falls to `root`, fail closed.
  { pattern: /^\/knowledge-writes\/(propose|preview|commit)$/, methods: ['POST'], scope: 'knowledge-contents:write' },
  // Card 549cc51f (owner rulings E298, E299, E310): the shared-area writer
  // list. The LIST is a `services:read` disclosure (design section 4): every
  // human role holds it, and an Agent or Connector holds it only when granted.
  // The two CHANGES are `authenticated` with the real gate in the handler, the
  // /warrants and /approvals precedent above: a root OR an administrator LOGIN
  // SESSION (an `operator` administrator holds no `root`, so a root ceiling
  // here would refuse the ratified administrator), with a step-up on every
  // change; a bearer credential is refused SHARED_WRITER_REQUIRES_SESSION.
  // EXACT: any other path or method under the mount matches no rule and falls
  // to `root`, fail closed.
  { pattern: /^\/knowledge-shared-writers$/, methods: ['GET'], scope: 'services:read' },
  { pattern: /^\/knowledge-shared-writers(\/remove)?$/, methods: ['POST'], scope: 'authenticated' },
  // Card 08792425 (member N6, the core half of two-way registration; the
  // default-store design's choice C7): registering a knowledge source from an
  // installer's bundle, its state and its return bundle. `authenticated` with
  // the real gate in the handler, as for the shared-area writer list: root OR
  // an administrator LOGIN SESSION (an `operator` administrator holds no
  // `root`), a step-up on the registration, and every bearer credential, a
  // root bearer included, refused KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION.
  // EXACT: any other path or method under the mount falls to `root`.
  { pattern: /^\/knowledge-source-registrations$/, methods: ['GET', 'POST'], scope: 'authenticated' },
  { pattern: /^\/knowledge-source-registrations\/[^/]+(\/return-bundle)?$/, methods: ['GET'], scope: 'authenticated' },

  // Service and Connector registry (RH-P2.1): reads are disclosure;
  // registration, metadata and descriptor publishing are the write verb;
  // retire and hard delete are the admin verb (§4.4; RH-DESIGN.5 R5 stages
  // descriptor retirement behind services:admin). The owner-plane subroute
  // carries SUBSCRIPTION-CLASS data (§2.6.4: delivery endpoint, the mode
  // switch, visibility tier, runtime mode) and stays behind the root
  // sentinel like /webhooks — a prompt-injected connector holding
  // services:write must not be able to repoint its own delivery.
  //
  // RH-KW1: the seven §4.2 knowledge fields join that SAME seat and are
  // covered by this SAME rule. No new owner-plane route was added, which
  // is why a `services:write` credential setting a knowledge endpoint is
  // refused by construction rather than by a new check (acceptance 6).
  { pattern: /^\/services\/[^/]+\/owner-plane$/, scope: 'root' },
  { pattern: /^\/services\/[^/]+$/, methods: ['DELETE'], scope: 'services:admin' },
  { pattern: /^\/services\/[^/]+\/retire$/, scope: 'services:admin' },
  { pattern: /^\/services\/[^/]+\/descriptor\/versions\/[^/]+\/retire$/, scope: 'services:admin' },
  { pattern: /^\/services(\/|$)/, methods: ['GET'], scope: 'services:read' },
  { pattern: /^\/services(\/|$)/, scope: 'services:write' },

  // Human notification endpoints (RH-P3.C8, §2.12): SUBSCRIPTION-CLASS
  // data. The endpoint and its enablement are settable only through the
  // human surface or the admin credential class — an agent-writable
  // notification endpoint pointed at an attacker URL would be a signed,
  // board-originated beacon (the §2.6.4 argument applied to humans). The
  // whole family, reads included, stays behind the root sentinel.
  { pattern: /^\/notification-endpoints(\/|$)/, scope: 'root' },

  // RH-P5.SSO.W2 — the Identity provider (vocabulary A23.1, design d95136d7
  // SS-3). OWNER-PLANE configuration of an external OIDC issuer: it decides
  // who may authenticate as whom, so the whole family — reads included —
  // stays behind the root sentinel and MINTS NO SCOPE FAMILY (A23.6).
  // A17.8 ruled /notification-endpoints "permanently root... that IS its
  // ratified home, not a parking"; this follows that precedent rather than
  // minting an `identity-providers:admin` family nobody asked for.
  { pattern: /^\/identity-providers(\/|$)/, scope: 'root' },

  // RH-P5.SSO.W4 — the inbound SCIM 2.0 provisioning surface (design
  // d95136d7 §7.4 rung 2; vocabulary A24; AZ-A4 clause 3; SSO-R7). The
  // ONE family that requires `directory-provisioning:write`, and it
  // deliberately does NOT require `root`: the caller is the Identity
  // Identity provider's SCIM client holding a service Account's Connector
  // (A17.2), and AZ-18 forbids delegating root to a bearer credential.
  // `root` still reaches it, as the global sentinel reaches everything.
  //
  // ONE rule for the whole family, including its GET routes, because A24
  // scopes a single `write` verb to "the directory provisioning surface
  // (the SCIM 2.0 endpoints)" as one object. The reconciliation reads it
  // permits are reads INSIDE that object; the reads it refuses are
  // everything outside it, which every other rule in this table already
  // gates behind a scope this credential does not hold.
  { pattern: /^\/scim(\/|$)/, scope: 'directory-provisioning:write' },

  // Presence/telemetry ingest (RH-P3.C7, §2.6.5). The AUTHZ-DESIGN sitting
  // ratified the A12.2 successor (design 4d961e37, A17.7): ingest is
  // `telemetry:write`, each service writes only its own frames (the
  // in-handler identity check in routes/telemetry.ts), and telemetry READS
  // stay `tasks:read` on their existing task-read surfaces — no
  // `telemetry:read` until a dedicated read surface exists. Only the ingest
  // route is mapped; every other /telemetry path is deliberately unmapped
  // and fails closed to `root` like any unknown route.
  { pattern: /^\/telemetry\/frames$/, methods: ['POST'], scope: 'telemetry:write' },
  { pattern: /^\/telemetry\/service-metrics$/, methods: ['POST'], scope: 'telemetry:write' },
  { pattern: /^\/telemetry\/quotas$/, methods: ['POST'], scope: 'telemetry:write' },
  { pattern: /^\/telemetry\/quotas$/, methods: ['GET'], scope: 'services:read' },
  { pattern: /^\/plugins$/, methods: ['GET'], scope: 'services:read' },
  { pattern: /^\/plugin-host\/[^/]+\/bridge$/, methods: ['GET'], scope: 'services:read' },
  // Card bedf50cc (plugin availability and settings, owner ruling E380, design
  // section 7): no new scope and no plugin grant. The Account's own reads ride
  // the bridge's `services:read`; the Account is derived by activePluginAccount
  // in the handler and no path names one. The two writes are `authenticated`
  // because their gate is the authentication KIND (the Account's own login
  // session, no delegation link), which a scope string cannot say. The
  // backend effective-settings read is not here: it is mounted before the
  // protected funnel and authenticates by its plugin assertion alone.
  { pattern: /^\/plugin-host\/choices$/, methods: ['GET'], scope: 'services:read' },
  { pattern: /^\/plugin-host\/[^/]+\/settings$/, methods: ['GET'], scope: 'services:read' },
  { pattern: /^\/plugin-host\/[^/]+\/settings\/account$/, methods: ['PUT'], scope: 'authenticated' },
  { pattern: /^\/plugin-host\/[^/]+\/choice$/, methods: ['PUT'], scope: 'authenticated' },
  // The administrator surface: an `admin` or `operator` LOGIN SESSION checked
  // in the handler (administratorSessionOf with PLUGIN_ADMIN_ACT), a step-up
  // per write, and root bearers refused (C5, C11). `authenticated` for the
  // same reason as the shared-writer precedent: the gate is a kind plus a role,
  // and an `operator` administrator holds no `root`.
  { pattern: /^\/plugin-admin$/, methods: ['GET'], scope: 'authenticated' },
  { pattern: /^\/plugin-admin\/[^/]+\/(policy|settings)$/, methods: ['GET', 'PUT'], scope: 'authenticated' },
  { pattern: /^\/plugin-admin\/[^/]+\/settings\/cleanup$/, methods: ['POST'], scope: 'authenticated' },

  // RH-TW1a candidate B (owner decision D11): the native envelope surface, on
  // the SAME scope as frames. `telemetry:write` is the ingest verb for this
  // whole plane (A17.7); there is still no `telemetry:read`, because there is
  // still no dedicated read surface. Every other /telemetry path stays
  // deliberately unmapped and fails closed to `root`.
  { pattern: /^\/telemetry\/events$/, methods: ['POST'], scope: 'telemetry:write' },
  { pattern: /^\/telemetry\/events\/batch$/, methods: ['POST'], scope: 'telemetry:write' },

  // RH-TW1b slice 1 (card dac2ca71): the OTLP/HTTP receivers, on the SAME
  // ingest verb. The second rule is the refusal route for any other OTLP
  // version or signal, which answers with the accepted-version advertisement
  // (design 7d5c0cdc §3.1) and writes nothing but an adapter-health counter.
  { pattern: /^\/telemetry\/otlp\/v1\/(traces|logs|metrics)$/, methods: ['POST'], scope: 'telemetry:write' },
  { pattern: /^\/telemetry\/otlp\/[^/]+\/[^/]+$/, methods: ['POST'], scope: 'telemetry:write' },
  // The ingest discovery response: protocol metadata (accepted majors, OTLP
  // versions, paths, bounds), the same for every caller, no object data.
  { pattern: /^\/telemetry\/discovery$/, methods: ['GET'], scope: 'authenticated' },

  // RH-TW1c (card 50e74c1d): the FIRST telemetry READ surface — the presence
  // projection, the Sessions timeline and the Stats rollups.
  //
  // It rides `services:read`, an EXISTING read scope, and mints no new one.
  // Design 7d5c0cdc §5.3: "Tier 0/1 events and rollups ride existing read
  // scopes." The object these surfaces are about IS a services-registry row —
  // `utils/connectorRegistry.ts`: a Connector is "a `services` row with
  // `kind = 'connector'` whose REQUIRED `principal_id` names the acting
  // principal" — and the §5.3 selectable object is keyed
  // `(owning connector_id, source.product)`. So `services:read` is not a
  // convenient neighbour; it is the read verb of that object family.
  //
  // `telemetry:read` STILL DOES NOT EXIST and this card does not create one.
  // `telemetryFrames.test.ts` asserts its absence from ALL_SCOPES, and that
  // assertion is untouched. A17.7's condition was "no telemetry:read until a
  // dedicated read surface exists"; a surface existing is leave to ASK the
  // sitting for the scope, not licence to mint one in a lane.
  //
  // The scope is only the CEILING. Row-level narrowing to the caller's own
  // Account subtree is `services/TelemetryReadScope.ts`, applied inside every
  // handler as a REQUIRED argument. Neither substitutes for the other.
  //
  // GET ONLY, and each path spelled exactly: every other /telemetry path —
  // a POST to any of these three included — stays unmapped and fails closed
  // to `root`, exactly as it did before this card.
  { pattern: /^\/telemetry\/presence$/, methods: ['GET'], scope: 'services:read' },
  { pattern: /^\/telemetry\/sessions$/, methods: ['GET'], scope: 'services:read' },
  { pattern: /^\/telemetry\/sessions\/[^/]+$/, methods: ['GET'], scope: 'services:read' },
  { pattern: /^\/telemetry\/stats$/, methods: ['GET'], scope: 'services:read' },

  // E462 slice S3 (design v1.5 section 4.3, choice C5): the board's
  // NARROW-ONLY override of the connector trust policy. `services:read`, as
  // the design names it, which the harness token carries. GET only; every
  // other /connectors path stays unmapped and fails closed to `root`.
  { pattern: /^\/connectors\/trust-policy$/, methods: ['GET'], scope: 'services:read' },

  // Built-in protocol metadata, same disclosure as MCP tools/list; no object data.
  { pattern: /^\/tool-catalogue\/?$/, methods: ['GET'], scope: 'authenticated' },

  // Read-only reference surfaces every consumer needs. `/tools` left this
  // rule with RH-VOCAB.3 (A14.2): the v1 Tools page is frontend-only, so any
  // stray API call on /tools is unmapped and fails closed to root.
  { pattern: /^\/openapi\.json$/, methods: ['GET'], scope: 'authenticated' },
  { pattern: /^\/(models|dashboard)(\/|$)/, methods: ['GET'], scope: 'tasks:read' },
];

/**
 * The scope a request requires. Returns `root` for anything unmapped — see
 * the fail-closed rationale above.
 */
export function requiredScopeFor(method: string, mountedPath: string): RequiredScope {
  const path = normalizePathForScope(mountedPath);
  for (const rule of RULES) {
    if (rule.methods && !rule.methods.includes(method.toUpperCase())) continue;
    if (rule.pattern.test(path)) return rule.scope;
  }
  return ROOT_SCOPE;
}

/** Does this scope set satisfy the requirement? `root` satisfies everything. */
export function scopesSatisfy(
  held: string[] | null | undefined,
  required: RequiredScope
): boolean {
  if (!held) return false;
  // An explicit empty set is still an authenticated identity. Null/undefined
  // is not: it is an invalid missing-ceiling state and fails closed.
  if (required === 'authenticated') return true;
  return held.includes(ROOT_SCOPE) || held.includes(required);
}

/**
 * The scope a refusal may name as data (`details.requiredScopes`), or
 * `undefined` when it may name none. There is one rule, and every emitter that
 * puts the field on a refusal asks this function.
 *
 * `AuthorizationService.authorizeRoute` already says why it refused:
 * `SCOPE_CEILING` is the one denial whose cause is that the credential carries
 * neither the required scope nor `root`. A role ceiling, an unauthenticated
 * caller and every object-level refusal are different causes and name nothing.
 * `root` and `authenticated` are sentinels, not scopes a credential can be
 * issued, so a refusal against them names nothing either. What is named is the
 * requirement, never what the credential holds.
 */
export function scopesNamedByDenial(
  required: RequiredScope,
  denial: string | undefined,
): string[] | undefined {
  if (denial !== 'SCOPE_CEILING') return undefined;
  if (required === ROOT_SCOPE || required === 'authenticated') return undefined;
  return [required];
}
