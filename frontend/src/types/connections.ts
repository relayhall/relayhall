/**
 * The day-one connection flow — types and the ONE template table
 * (card 653be44f; owner design record 99d6b0ad §3.1 and decision 1).
 *
 * VOCABULARY. The ratified object is a **Connector** (vocabulary `b94dd86e`
 * A17.2): the registry row and its principal, created together. "Connection"
 * appears here only in product-facing COPY, and only where the owner record
 * uses it — "Connect your agent", "My connections". Every identifier, path and
 * stored value says Connector.
 *
 * WHY A TEMPLATE TABLE AND NOT A COLUMN. A template is what the first wizard
 * step chooses: it fixes the transport class, the bootstrap tab a person lands
 * on, and the registration text. There is no column on `services` to store
 * which template made a Connector, and this lane reserves no migration — so the
 * wizard writes the template's `registrationText` into the registry row's
 * `description` (a field the self-service registration route already accepts)
 * and the list maps it BACK through this same table by EXACT match. One table,
 * both directions, no regex: an unrecognised description is `null` and renders
 * as the plain object word, never as a guess. The honest first-class shape is a
 * column, and that is the bounded question this lane hands the owner.
 */

/** Transport class a template pins on the credential it mints (AUTHZ §7.5). */
export type ConnectionTransport = 'any' | 'mcp' | 'api';

/** Which copy block the bootstrap pane shows first, and which tabs apply. */
export type BootstrapTab = 'claudeCode' | 'codex' | 'generic' | 'cli';

/**
 * What a working agent needs, as the ratified GUI mint panel already defines it
 * (AZ-S5, `AccessManagerPage`). Declared ONCE here and imported there, so the
 * wizard's recommended set and the Access manager's mint dialog can never drift
 * into disagreeing about what an Agent's working set is.
 *
 * Every entry is a MINTABLE scope (`scopeMap.MINTABLE_SCOPES`); none is `root`
 * or an `:admin` family, so no role-derived Member session is ever asked for
 * something it cannot hold.
 */
export const AGENT_WORKING_SCOPES: string[] = [
  'tasks:read', 'tasks:write', 'reports:read', 'reports:write',
  'projects:read', 'phases:read', 'skills:read', 'skills:use',
];

/** A script driving the REST API works tasks and reports; it fetches no skills. */
export const API_SCRIPT_SCOPES: string[] = [
  'tasks:read', 'tasks:write', 'reports:read', 'reports:write',
  'projects:read', 'phases:read',
];

/**
 * THE ONE TOKEN OF A HARNESS CONNECTOR (E462 slice S1; universal harness
 * connector design v1.5 section 3.1).
 *
 * A harness (Claude Code, Codex, VS Code, Antigravity) holds ONE token, and
 * that one token does four jobs: it serves the board's MCP tools, reports
 * telemetry and usage quotas, opens the wake socket and mints task-bounded
 * implementer Agents. So it is the Agent working set PLUS the three scopes the
 * extra jobs need — `telemetry:write` (presence, quotas), `services:read` (the
 * connector reads its own descriptor) and `principals:read` (the Agent mint and
 * the session brief both read the caller's principal).
 *
 * Built from `AGENT_WORKING_SCOPES` rather than restated, so the Agent mint
 * panel and this set cannot drift into disagreeing about the working half.
 *
 * Owner ruling E475 (1) adds three, each the narrowest verb of its family:
 * `knowledge-contents:read` (research through the board's knowledge sources),
 * `personalities:read` (read the Personalities a Task names) and
 * `blueprints:use`. `blueprints:use` is NOT read-only: it lets the connector
 * preview AND instantiate a published Blueprint, and instantiating creates
 * Tasks (which `tasks:write` already allows). It is not `blueprints:read`, so
 * the connector sees the use-only projection of a Blueprint, never its version
 * history or ledger.
 *
 * Owner ruling E480 adds two more, so that the connector can instantiate a
 * Blueprint and not only preview it: `projects:write` (every instantiation
 * writes into, or creates, its target Project) and `phases:write` (a Blueprint
 * that has Phases creates them). They are the ordinary write verbs of those
 * objects, not Blueprint-only; object grants still decide which Projects and
 * Phases. Sixteen in all; see docs/connector-onboarding.md. A credential
 * minted before E480 keeps the scopes it has.
 *
 * This is the ONE definition: the wizard's harness templates mint it, and the
 * local connector's `HARNESS_SCOPES` (cli/relayhall_connector.py) is read back
 * out of this source by a drift test.
 *
 * NEVER `root`, never an `:admin` scope, never `services:write` (design B5): a
 * connector reads its descriptor, it does not rewrite it. A test pins all three
 * absences, the full set written out, and reads every member back out of the
 * board's mintable catalogue.
 */
export const HARNESS_CONNECTOR_SCOPES: string[] = [
  ...AGENT_WORKING_SCOPES, 'telemetry:write', 'services:read', 'principals:read',
  'knowledge-contents:read', 'personalities:read', 'blueprints:use',
  'projects:write', 'phases:write',
];

export type HarnessKey = 'claude-code' | 'codex' | 'vscode' | 'antigravity';

/**
 * What a harness connector declares about itself in its first published
 * descriptor: how much telemetry it sends and the one product it reports
 * under. Quota posts need the declared `sourceProduct`, and session telemetry
 * needs a declared tier (both deny by default on the board).
 *
 * `full` for the two harnesses that report quotas and run work; `presence` for
 * the two editor clients, which are human-driven and report presence and
 * MCP-derived sessions only (design section 7). Both cap at the same policy tier
 * on the board today; the difference is what each connector says it SENDS.
 */
export interface HarnessDeclaration {
  /** Names the harness in the install line (`--harness <key>`). */
  key: HarnessKey;
  telemetryTier: 'presence' | 'full';
  telemetryProduct: string;
}

export interface ConnectionTemplate {
  key: string;
  /** Present on a harness template: the install line and the descriptor come from it. */
  harness?: HarnessDeclaration;
  /** The product-facing label in wizard step 1. */
  label: string;
  /** One line under the label: what this choice is for. */
  blurb: string;
  /**
   * Written verbatim into the registry row's `description` at registration and
   * matched back EXACTLY when the list renders. Never parsed, never matched by
   * pattern.
   */
  registrationText: string;
  transport: ConnectionTransport;
  /** The tab the bootstrap pane opens on. */
  defaultTab: BootstrapTab;
  /**
   * The RECOMMENDED authority for this kind of connection — a code-level scope
   * set, because no Access profile exists to point at: nothing seeds
   * `access_profiles`, and profile creation and assignment are root-only, so a
   * Member's wizard could never attach one. (Dispatcher-accepted deviation from
   * packet §1B's "template = an existing Access profile".)
   *
   * IT IS A SUGGESTION AND NEVER A DEFAULT, on EVERY session arm. Decision 1
   * rules that a new connection's default authority is everything the person
   * may delegate, so this set is offered inside the *narrow it* disclosure and
   * is always INTERSECTED with what the session actually holds: a template can
   * only ever narrow.
   *
   * It WAS the default on the root-session arm, by declared amendment UX-A1 to
   * owner design record `99d6b0ad`. The owner ruling of 2026-09-07 (card
   * `07d09eaf`) withdraws that arm, because a working set chosen from this
   * table cannot BOOTSTRAP: `relayhall_brief_compile {session: true}` — the one
   * call every MCP harness must make before the work plane opens to it — needs
   * `principals:read`, and no entry below names it. The scope of the ruling is
   * stated at `defaultScopesFor`; this stays the hint it always was for a
   * Member, now on every arm.
   */
  suggestedScopes: string[];
  /** Present only on a template that cannot be created yet. */
  unavailableReason?: string;
}

/**
 * A19.1 declares Gateway as an extension of the Service kind enum, and
 * migration 076 still constrains `services.kind` to `('service', 'connector')`
 * — so no gateway surface exists to register against. The wizard shows the
 * choice (people ask for it, and hiding it invites a support question) and
 * refuses it with the reason, in ONE place: when the gateway phase lands, this
 * constant flips and the option becomes ordinary.
 */
export const GATEWAY_SURFACE_AVAILABLE = false;

/**
 * The choices of the owner record §3.1, in the record's own order, plus
 * Antigravity (E462 slice S1, design v1.5 section 3.1), which sits with the
 * other three harnesses.
 *
 * THE FOUR HARNESS TEMPLATES (Claude Code, Codex, VS Code, Antigravity) are the
 * exception to the transport rule below: each makes ONE `any`-pinned token with
 * the harness scope set, because that one token serves MCP, reports telemetry,
 * opens the wake socket and mints Agents. See `HARNESS_CONNECTOR_SCOPES`. They
 * are the templates that carry a `harness` declaration; Generic MCP, API script
 * and the gateway are unchanged.
 *
 * Transport, per template, is the record's "the choice sets kind, transport and
 * a default scope template". MCP clients are pinned `mcp`, which is the tighter
 * of the two real options and is exactly what §7.5 pins are for: such a
 * credential succeeds through the board's MCP endpoint and is refused on every
 * REST route. A script that drives the REST API is pinned `api` for the mirror
 * reason. `any` is chosen only where a connection legitimately does both.
 *
 * AUTHORITY is NOT set here. Decision 1 rules that a new connection's default
 * authority is everything the person can do; the wizard reads that from the
 * session (`GET /principals/me`), and the Advanced tab is where it narrows.
 */
export const CONNECTION_TEMPLATES: ConnectionTemplate[] = [
  {
    key: 'claude-code',
    harness: { key: 'claude-code', telemetryTier: 'full', telemetryProduct: 'claude-code' },
    label: 'Claude Code',
    blurb: 'The Claude Code CLI, working tasks from the board.',
    registrationText: 'Claude Code, connected from the Connect your agent flow.',
    transport: 'any',
    defaultTab: 'claudeCode',
    suggestedScopes: HARNESS_CONNECTOR_SCOPES,
  },
  {
    key: 'codex',
    harness: { key: 'codex', telemetryTier: 'full', telemetryProduct: 'openai-codex' },
    label: 'Codex',
    blurb: 'The Codex CLI, working tasks from the board.',
    registrationText: 'Codex, connected from the Connect your agent flow.',
    transport: 'any',
    defaultTab: 'codex',
    suggestedScopes: HARNESS_CONNECTOR_SCOPES,
  },
  {
    key: 'vscode',
    harness: { key: 'vscode', telemetryTier: 'presence', telemetryProduct: 'vscode' },
    label: 'VS Code',
    blurb: 'An editor session that reaches the board over MCP.',
    registrationText: 'VS Code, connected from the Connect your agent flow.',
    transport: 'any',
    defaultTab: 'generic',
    suggestedScopes: HARNESS_CONNECTOR_SCOPES,
  },
  {
    key: 'antigravity',
    harness: { key: 'antigravity', telemetryTier: 'presence', telemetryProduct: 'antigravity' },
    label: 'Antigravity',
    blurb: 'Google Antigravity, an editor session that reaches the board over MCP.',
    registrationText: 'Antigravity, connected from the Connect your agent flow.',
    transport: 'any',
    defaultTab: 'generic',
    suggestedScopes: HARNESS_CONNECTOR_SCOPES,
  },
  {
    key: 'generic-mcp',
    label: 'Generic MCP client',
    blurb: 'Any other client that speaks the MCP protocol.',
    registrationText: 'A generic MCP client, connected from the Connect your agent flow.',
    transport: 'mcp',
    defaultTab: 'generic',
    suggestedScopes: AGENT_WORKING_SCOPES,
  },
  {
    key: 'api-script',
    label: 'API script',
    blurb: 'A script or job of your own that calls the REST API.',
    registrationText: 'An API script, connected from the Connect your agent flow.',
    transport: 'api',
    defaultTab: 'cli',
    suggestedScopes: API_SCRIPT_SCOPES,
  },
  {
    key: 'messaging-gateway',
    label: 'Messaging gateway',
    blurb: 'A gateway that speaks for people in a chat venue.',
    registrationText: 'A messaging gateway, connected from the Connect your agent flow.',
    transport: 'any',
    defaultTab: 'generic',
    suggestedScopes: AGENT_WORKING_SCOPES,
    ...(GATEWAY_SURFACE_AVAILABLE ? {} : { unavailableReason: 'Coming with the gateway phase' }),
  },
];

/**
 * The recommended set for a template, bounded by what the session holds.
 *
 * The intersection is the whole point: `POST /services` refuses any scope
 * outside the caller's own effective set, so an unintersected recommendation
 * would offer a person a button that produces a 403.
 */
export function recommendedScopesFor(
  template: ConnectionTemplate,
  available: string[],
): string[] {
  return template.suggestedScopes.filter((scope) => available.includes(scope));
}

/** Is this a harness template — one that makes the one-token harness connector? */
export function isHarnessTemplate(
  template: ConnectionTemplate | null | undefined,
): template is ConnectionTemplate & { harness: HarnessDeclaration } {
  return Boolean(template?.harness);
}

/**
 * THE CEILING A TEMPLATE PUTS ON ITS TOKEN.
 *
 * A harness template cuts the delegable set down to the harness set, in the
 * order the session's own catalogue lists it, so the menu cannot offer
 * `services:write`, an `:admin` scope or anything else outside what the design
 * names — however much the session could delegate. It can only narrow: a scope
 * the session may not delegate is absent, so the wizard never offers a button
 * that produces a 403 — and `harnessScopesMissing` names what was cut, so the
 * wizard warns about it by name instead of issuing a smaller token silently.
 *
 * Every other template, and no template yet, leaves the whole delegable set:
 * decision 1 (owner ruling of 2026-09-07) still governs those.
 */
export function scopeCeilingFor(
  template: ConnectionTemplate | null | undefined,
  connectable: string[],
): string[] {
  if (!isHarnessTemplate(template)) return connectable;
  return connectable.filter((scope) => HARNESS_CONNECTOR_SCOPES.includes(scope));
}

/**
 * THE PART OF THE HARNESS SET THIS SESSION CANNOT PASS ON (E462 S2, carried
 * from the S1 review).
 *
 * `scopeCeilingFor` cuts the harness set down to what the session may
 * delegate, which is right (the wizard never offers a scope the board would
 * refuse), but on its own it was SILENT: a Member who cannot delegate, say,
 * `telemetry:write` got a token without it and a sentence counting against the
 * cut-down ceiling, as if nothing were missing. This names what was cut, in the
 * order the harness set lists it, so the wizard can say so by name.
 */
export function harnessScopesMissing(connectable: string[]): string[] {
  return HARNESS_CONNECTOR_SCOPES.filter((scope) => !connectable.includes(scope));
}

/**
 * The sentence for a harness token, in place of "everything you can do", which
 * would be false here: the harness set is a deliberate subset, and a screen
 * promising more than it issues is the defect class this file keeps being
 * repaired for.
 *
 * It counts against the WHOLE harness set (`HARNESS_CONNECTOR_SCOPES`), never
 * against what this session happened to be able to delegate, so "16 of the 16"
 * is only ever said of a token that really has the full set.
 */
export function harnessAuthoritySentence(chosen: number): string {
  return `This connection gets one token for the board's tools, reporting and wake: ${chosen} of the ${HARNESS_CONNECTOR_SCOPES.length} things a harness connection can be given. It is never given administrator rights or the right to change services.`;
}

/**
 * The warning, by name, when the session cannot delegate part of the harness
 * set. Null when nothing is missing. `relayhall connector check` fails on the
 * same condition, so the sentence says what the person will meet next.
 */
export function harnessDelegationWarning(missing: string[]): string | null {
  if (missing.length === 0) return null;
  const names = missing.length === 1
    ? missing[0]
    : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  const verb = missing.length === 1 ? 'it' : 'them';
  return `You cannot pass on ${names}, so this token will not have ${verb}. The connector needs the whole harness set: relayhall connector check will fail until someone who can delegate ${verb} widens the token on the Credentials page.`;
}

/**
 * What the installer does for this harness that the generic install sentence
 * does not say, shown under the install line. For Antigravity (owner ruling
 * E475 (2)) the installer writes one entry into Antigravity's own MCP config
 * file and keeps a backup of that file beside it first. Null for every other
 * harness.
 */
export function installNoteFor(template: ConnectionTemplate | null | undefined): string | null {
  if (!isHarnessTemplate(template) || template.harness.key !== 'antigravity') return null;
  return "For Antigravity the installer adds one entry, relayhall, to ~/.gemini/config/mcp_config.json. Before it changes that file it keeps a timestamped backup beside it, unless the file holds another server's credential, which is never copied. The entry starts the local proxy and holds no token; restart Antigravity afterwards.";
}

/**
 * The first capability descriptor a harness connector registers with: no
 * execution options, one declared telemetry tier and one declared product.
 * Null for a template that is not a harness.
 */
export function connectorDescriptorFor(
  template: ConnectionTemplate | null | undefined,
): { options: never[]; telemetry: { tier: 'presence' | 'full'; products: string[] } } | null {
  if (!isHarnessTemplate(template)) return null;
  return {
    options: [],
    telemetry: { tier: template.harness.telemetryTier, products: [template.harness.telemetryProduct] },
  };
}

/**
 * The one line a person runs on the machine where the harness lives, instead
 * of a configuration snippet:
 * `relayhall connector install --harness <h> --board <origin>`.
 *
 * It names the harness and the board's ORIGIN and nothing else. The token is
 * never on it: the installer asks for the token at a hidden prompt, so it never
 * reaches a command line, a shell history or a process listing. The origin is
 * taken from the pack's board endpoint (`<origin>/api`), and an endpoint that
 * is not a URL yields no line rather than a guess.
 */
export function installLineFor(
  template: ConnectionTemplate | null | undefined,
  boardEndpoint: string | null | undefined,
): string | null {
  if (!isHarnessTemplate(template) || !boardEndpoint) return null;
  let origin: string;
  try {
    const parsed = new URL(boardEndpoint);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    origin = parsed.origin;
  } catch {
    return null;
  }
  return `relayhall connector install --harness ${template.harness.key} --board ${origin}`;
}

/* ── WHAT A NEW CONNECTION MAY BE GIVEN (card 6e25ae48) ──────────────── */

/**
 * The global authority sentinel. Named here because three functions below have
 * to say "not that one", and a bare string literal repeated three times is a
 * typo away from a menu that offers it.
 */
export const ROOT_SCOPE_NAME = 'root';

/** Does this session hold the sentinel? Its own authority, not what it may pass on. */
export function holdsRoot(scopes: string[] | null | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(ROOT_SCOPE_NAME);
}

/**
 * THE MENU, THE CEILING AND THE SOURCE OF THE DEFAULT.
 *
 * Until card `6e25ae48` this was simply the session's own effective scopes, and
 * for the two roles a fresh deployment can be administered by — `admin` and
 * `orchestrator` — that set is exactly `['root']`
 * (`backend/src/utils/identityScopes.ts`). `root` is the one scope credential
 * issuance refuses outright (AUTHZ §5.2 rule 2 / AZ-18), so the wizard offered
 * a first-time administrator one choice and the board refused it: HTTP 500, no
 * credential, and an orphan Connector left behind.
 *
 * The delegable set is now the SERVER'S answer (`GET /principals/me` ->
 * `delegableScopes`), not a rule restated here. That matters more than it looks:
 * the honest menu for a root session is "every mintable scope except `root`",
 * and mirroring the mintable catalogue into the frontend would be a list that
 * silently rots every time a scope family lands — the failure the reserved-slug
 * mirror needs a drift control to survive. There is nothing to drift here.
 *
 * The `root` filter on both arms is belt AND braces: the server already omits
 * it, and this function must never be able to put it on screen if a future
 * board answers differently.
 */
export function connectableScopes(
  scopes: string[] | null | undefined,
  delegable: string[] | null | undefined,
): string[] {
  const source = Array.isArray(delegable) ? delegable : (Array.isArray(scopes) ? scopes : []);
  return source.filter((scope) => scope !== ROOT_SCOPE_NAME);
}

/**
 * THE DEFAULT SELECTION for a new connection
 * (owner design record `99d6b0ad` decision 1; owner ruling 2026-09-07, card
 * `07d09eaf`, which WITHDRAWS declared amendment UX-A1's root-session arm).
 *
 * ONE ARM, FOR EVERY SESSION AND EVERY TEMPLATE: a new connection starts with
 * everything the caller may delegate — the catalogue the board itself answers
 * on `GET /principals/me` -> `delegableScopes`, with `root` filtered out by
 * `connectableScopes`. Narrowing is a later act: under *Narrow it* here, or in
 * My connections.
 *
 * WHY THE ROOT ARM WENT. UX-A1 made the step-1 TEMPLATE's working set the
 * administrator default, on the reading that a silent widening matters most for
 * the one role that can do everything. Card `07d09eaf` is what that cost. Every
 * work-plane MCP tool is closed to a credential until it calls
 * `relayhall_brief_compile {session: true}`; that call reads the caller's own
 * principal and so requires `principals:read`; and no template working set in
 * this file names that scope. So the headline day-one flow handed a first-time
 * administrator a credential that answered 403 to the ONLY call that opens the
 * board to it — a dead end for the exact person the flow exists for. The owner
 * ruled the DEFAULT, not the check: `brief_compile` still requires what it
 * requires, and the wizard now starts from the full delegable catalogue.
 *
 * WHAT THE RATIFIED SENTENCE STILL MEANS. "An administrator's own authority is
 * never given to a connection" is unchanged in its original sense: `root` is
 * not delegable (§5.2 rule 2 / AZ-18), `connectableScopes` never offers it, and
 * `PrincipalService.issueCredential` refuses it. What changed is the default
 * SELECTION inside the delegable catalogue, which is a different sentence.
 *
 * THERE IS NO MAIN-HARNESS NOTION TO KEY THE RULING ON. The ruling names the
 * main harness; this table types a template by TRANSPORT and BOOTSTRAP TAB and
 * by nothing else, and adding a `mainHarness` column would be a third thing to
 * keep true with no writer behind it and no surface reading it. The ruling is
 * therefore applied to EVERY template — which is what decision 1 already did
 * for every non-root session, so the change removes an arm rather than adding
 * one, and the two session kinds can no longer disagree about the default.
 */
export function defaultScopesFor(connectable: string[]): string[] {
  return [...connectable];
}

/**
 * The one-sentence summary shown before the person opens the chooser.
 *
 * Both arms say the same thing about the DEFAULT, because since the 2026-09-07
 * ruling it IS the same default: everything the caller may delegate, narrowable
 * here or later. They differ only in how they name the ceiling — a Member's
 * ceiling is what they can do, an administrator's is not, because `root` is
 * theirs and is never delegable. Telling an administrator the connection "can
 * do everything you can do" would be false, and a screen promising more than it
 * issues is the defect class this file keeps being repaired for.
 */
export function defaultAuthoritySentence(sessionHoldsRoot: boolean): string {
  return sessionHoldsRoot
    ? "An administrator's own authority is never given to a connection, so this one starts with everything you may delegate — narrow it here, or later in My connections."
    : 'By default this connection can do everything you can do — narrow it here, or later in My connections.';
}

/** The same sentence once a selection exists, counted against the real ceiling. */
export function chosenAuthoritySentence(
  chosen: number,
  connectable: number,
  sessionHoldsRoot: boolean,
): string {
  return sessionHoldsRoot
    ? `This connection will be able to do ${chosen} of the ${connectable} things a connection can be given.`
    : `This connection will be able to do ${chosen} of the ${connectable} things you can do.`;
}

/**
 * What the disclosure control does. The default is the ceiling on every arm
 * now, so the control can only ever narrow — which is what it says.
 *
 * It was "Choose what it can do" for a root session for as long as UX-A1 made
 * that arm's default a template working set the control could WIDEN. The
 * 2026-09-07 ruling withdrew that arm, and a label describing a widening the
 * control no longer offers would be the same lie in the other direction, so the
 * per-arm function goes with it: one label, because there is one behaviour.
 */
export const SCOPE_DISCLOSURE_LABEL = 'Narrow it';

/**
 * MAY THIS SESSION REGENERATE a connection's credential?
 *
 * ONE predicate with two callers, and that is the whole point of it existing.
 * My connections enables or disables its *Regenerate credential* control from
 * this; the wizard's lost-credential recovery sentence is built from this. When
 * they were independent, the wizard told a Member to "regenerate it" while the
 * next screen refused them exactly that (round-2 finding P3-R2) — a screen
 * contradicting the screen it sends you to.
 *
 * The rule it encodes is the substrate's, not a preference:
 * `POST /credentials/:id/rotate` sits behind `principals:admin` in `scopeMap.ts`
 * plus `requireManageAuthority`, so only a root session can rotate. Whether that
 * SHOULD be so is a standing owner question (self-service rotation, AUTHZ §9.2);
 * until it is answered, this is what the board actually does, and both surfaces
 * now say the same thing about it because they cannot say different things.
 */
export function mayRegenerateCredential(scopes: string[] | null | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes('root');
}

/** The reason shown wherever regeneration is refused. */
export const REGENERATE_ADMIN_ONLY = 'Regeneration is an administrator act in this release';

/**
 * What to tell someone whose credential may be lost — phrased as an action the
 * session can actually take, derived from the same predicate as the control.
 */
export function lostCredentialRecovery(scopes: string[] | null | undefined): string {
  return mayRegenerateCredential(scopes)
    ? 'regenerate its credential from My connections'
    : 'connect a replacement agent from My connections and disable this one';
}

/** The template a Connector was created from, or null when nothing matches. */
export function templateForDescription(description: string | null | undefined): ConnectionTemplate | null {
  if (!description) return null;
  return CONNECTION_TEMPLATES.find((template) => template.registrationText === description) ?? null;
}

/**
 * What "kind" a connection is called in a list. Falls back to the ratified
 * object word rather than inventing a label for a row this table does not know.
 */
export function kindLabelForDescription(description: string | null | undefined): string {
  return templateForDescription(description)?.label ?? 'Connector';
}

/** Which bootstrap tabs a transport class admits, and why the others do not. */
export const MCP_TABS: BootstrapTab[] = ['claudeCode', 'codex', 'generic'];

export function tabAppliesToTransport(tab: BootstrapTab, transport: ConnectionTransport): boolean {
  if (transport === 'any') return true;
  if (transport === 'mcp') return MCP_TABS.includes(tab);
  return tab === 'cli';
}

export const TAB_LABELS: Record<BootstrapTab, string> = {
  claudeCode: 'Claude Code',
  codex: 'Codex',
  generic: 'Generic MCP client',
  cli: 'CLI and scripts',
};

/**
 * The credential token grammar, mirrored from the server so a test that claims
 * "no secret is on this screen" can actually FAIL.
 *
 * The board mints `rh_<env>_<keyId>.<secret>` — `PrincipalService.parsePrincipalKey`
 * is the authority: `/^rh_(live|dev)_([A-Za-z0-9]{6,64})\.([A-Za-z0-9_-]{20,128})$/`.
 * The separator between the key id and the secret is a DOT, and getting that
 * wrong is not academic: a live QA probe written with an underscore there
 * matched nothing, so its "no credential leaked" answer was true by
 * construction and worth nothing. A negative control that cannot fire is not a
 * control.
 *
 * The PUBLIC key id (`rh_dev_abc123def456`) is shown freely — it names a
 * credential without being one — and deliberately does NOT match this pattern.
 */
/**
 * Ways a surface can tell someone to replace a credential — the act a Member
 * cannot perform. ONE pattern, used by the census control and the parity
 * control, because two matchers drift exactly as two sentences did.
 *
 * Round 3 defeated a single-phrase matcher by appending "or regenerate it";
 * round 4 defeated the word-stem matcher with "issue a new credential". Each
 * form below is there because a review got past the previous version, and each
 * has its own red control.
 */
export const RECOVERY_INTENT_PATTERN =
  /\b(?:re-?generat\w*|regen|rotat\w*|roll(?:ing)?\s+(?:a|the)\s+credential|issu(?:e|es|ing)\s+(?:a|the)\s+new\s+credential)\b/i;

export const CREDENTIAL_TOKEN_PATTERN = /rh_(live|dev)_[A-Za-z0-9]{6,64}\.[A-Za-z0-9_-]{20,128}/;

/* ── The read model of GET /principals/me/connectors ──────────────────── */

export interface ConnectionCredential {
  id: string;
  keyId: string | null;
  label: string | null;
  scopes: string[];
  transport: string;
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  graceUntil: string | null;
  revealCount: number;
  revealable: boolean;
  state: 'live' | 'graced' | 'replaced' | 'expired' | 'revoked';
}

export interface ConnectionAgent {
  id: string;
  handle: string;
  displayName: string | null;
  status: string;
  lastSeenAt: string | null;
  boundTaskId: string | null;
  mintedUnderWarrantId: string | null;
  terminatedAt: string | null;
  credentials: ConnectionCredential[];
}

export interface Connection {
  ownerControl?: boolean;
  principalId: string;
  handle: string;
  displayName: string | null;
  status: string;
  lastSeenAt: string | null;
  purpose: string | null;
  service: {
    id: string;
    slug: string;
    name: string;
    description: string;
    status: string;
    runtimeMode: string;
    createdAt: string | null;
  };
  credentials: ConnectionCredential[];
  agents: ConnectionAgent[];
}

export interface BootstrapInstructions {
  boardEndpoint: string;
  bootstrapLine: string;
  /** Card 94e8bb0b: the copyable bootstrap prompt; never carries a credential. */
  bootstrapPrompt?: string;
  /** Card 94e8bb0b: secure configuration guidance, one sentence per entry. */
  configurationGuidance?: string[];
  mcpConfig: { claudeCode: unknown; codex: string; generic: unknown };
  cliEnv: string[];
  previewPath: string;
  credentialPlaceholder: string;
}

/**
 * The one-time onboarding pack, as the Connector-creation response returns it
 * (AUTHZ §7.4). It is never stored server-side and never re-fetchable: what the
 * wizard shows in step 3 is this object, held only in the open page.
 */
export interface OnboardingPack extends BootstrapInstructions {
  credential: {
    credentialId: string;
    keyId: string;
    secretOnce: string;
    expiresAt: string | null;
    transport: string;
  };
  authoritySummary: { scopes: string[]; rules: unknown[] };
}

/**
 * Slugs the board reserves and will not let any write surface claim.
 *
 * A DECLARED MIRROR of `RESERVED_SERVICE_SLUGS` in
 * `backend/src/services/KnowledgeSourcePolicy.ts`, which `validateSlug` — and
 * therefore `ServiceRegistry.register()` — enforces with a 422.
 *
 * WHY A MIRROR AND NOT AN IMPORT. That module pulls in Node's `net`, so it can
 * never be bundled for a browser, and the frontend image is built from
 * `frontend/` alone, so a cross-package import would not even resolve. The
 * estate's existing answer to exactly this is a declared mirror — see
 * `utils/discordLinks.ts`, "frontend mirror of backend/src/utils/discordLinks.ts".
 *
 * WHAT STOPS IT ROTTING. `connectionReservedSlugDrift.test.ts` reads the backend
 * module and FAILS when these two sets disagree in either direction. That is the
 * whole point: the previous version of this file had no idea the board reserved
 * anything, so the wizard told a person the name "Board" was usable and the
 * board then refused it (round-4 finding P-R4-REBASE).
 */
export const RESERVED_CONNECTION_SLUGS: ReadonlySet<string> = new Set(['board']);

/** Why a slug cannot be used, or null when it can. */
export type SlugRefusal = 'shape' | 'reserved';

/**
 * The single place a slug is judged. Both reasons are the board's own rules —
 * the shape comes from migration 076, the reservation from the policy module —
 * and both are refused in the form rather than by a surprise from the server.
 */
export function slugRefusal(slug: string): SlugRefusal | null {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return 'shape';
  if (RESERVED_CONNECTION_SLUGS.has(slug)) return 'reserved';
  return null;
}

/**
 * The board slug for a connection name. Registration constrains slugs to
 * `^[a-z0-9][a-z0-9-]{0,63}$` (migration 076), so this is a contract, not a
 * nicety: a name that cannot produce a legal slug must be refused in the form
 * rather than by a 400 from the server.
 */
export function slugForName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return base;
}

export function slugIsLegal(slug: string): boolean {
  return slugRefusal(slug) === null;
}

/**
 * The refusals `POST /services` actually emits, each said in the person's words.
 *
 * It lives here rather than beside the wizard because the Create identity flow
 * reaches the same route for a Service's Connector (card `5592baf6`), and two
 * surfaces reading one route must not keep two tables of its refusals.
 * An enumerated set — never a pattern over the message — so a server-side
 * rewording cannot silently turn a named refusal into a generic one.
 */
export function connectionRefusalMessage(
  status: number,
  data: { code?: string; message?: string },
): string {
  switch (data?.code) {
    case 'RESERVED_SERVICE_SLUG':
      // The form refuses reserved names before this can fire; if the board's
      // reserved set has grown past the mirror, the person still gets a named
      // reason rather than a raw server sentence — and the drift control fails
      // the build that let the two disagree.
      return 'That name is one the board keeps for itself. Pick another.';
    case 'SERVICE_SLUG_TAKEN':
      // `services.slug` is GLOBALLY unique (migration 076), not per-Account, so
      // the clash may be with somebody else's connection entirely. Saying "you
      // already have one" would be false in exactly that case.
      return 'That name is already taken on this board. Pick another.';
    case 'ROOT_NOT_MINTABLE':
      // The wizard cannot ask for this any more (`connectableScopes` never
      // offers it), so reaching this arm means a hand-made request or a board
      // whose delegable answer disagrees with its issuance rule. Named anyway:
      // an enumerated refusal that is only written for reachable codes is a
      // generic 500 waiting for the day one becomes reachable again.
      return 'Your own authority is never given to a connection. Choose the concrete things this connection needs and try again.';
    case 'ISSUE_EXCEEDS_SESSION':
      return 'That is more authority than you hold yourself, so the board refused it. Narrow the selection and try again.';
    case 'SESSION_ONLY':
      return 'Connections are created from a signed-in browser session. Sign in and try again.';
    case 'OWNER_OUT_OF_SUBTREE':
      return 'A connection can only be created under your own account.';
    case 'CONNECTOR_NEEDS_ACCOUNT':
      return 'Your identity cannot own a connection. An administrator has to look at this.';
    case 'CONNECTOR_UNPAIRED':
      // Card 3f145fa3. This used to say the connection HAD been registered and
      // sent the person off to recover a credential, because that was true:
      // registration committed before issuance was attempted. Registration and
      // its first credential are now one transaction, so the honest sentence is
      // the short one, and leaving the old words would send somebody hunting a
      // connection the rollback removed.
      return 'The board could not give the connection an identity, so nothing was created. Try again — if it happens twice, an administrator has to look at this.';
    case 'CREDENTIAL_KEYS_NOT_CONFIGURED':
      // A server-side configuration state (no credential key set), not
      // something the person can change in this form. Name who fixes it and how.
      return 'This server has no credential key set yet, so it cannot give the connection a credential, and nothing was created. Whoever runs this server can fix it: run ./setup.sh on the server, answer "no" to keep the existing configuration, then restart the backend. Then try again.';
    default:
      break;
  }
  if (status === 401 || status === 403) return 'You are not permitted to create a connection with this session.';
  return data?.message || 'The board refused the request. Nothing was created.';
}
