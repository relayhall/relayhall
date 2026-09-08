/**
 * AccessSurfaceService — the Access-surface catalogue, `resolveSurface`, the
 * surface arm, and the boot-time census.
 *
 * SETGOV candidate A. Contract: design `7a9317b2` v3.3 §2.1, §2.2, §2.6, §3.2,
 * §3.3, §3.4; AUTHZ amendment **AZ-A5** (`4d961e37`) clauses 1–5; vocabulary
 * amendment **A25** (companion `0c321078`) incl. the A25.3 sitting addition
 * (I-10); acceptance annex `85a2218d` D1, D2, D3, D10, D15, D16, D17, D19.
 *
 * ── THE ONE THING THE ARM DOES (AZ-A5 clause 2) ──
 *
 * For an authenticated LOGIN SESSION it substitutes for the `root` sentinel on
 * the declared families of ONE `governable` Access surface, and nothing else.
 * It is reached only AFTER the route stage has already refused a `root`
 * requirement, so there is no code path from an Access surface to a
 * scope-gated route — §2.2's governable rule makes the
 * `tasks:admin`-through-an-Access-bundle defect unrepresentable rather than
 * refused, and annex D16 is the runtime control that holds it when the census
 * is bypassed.
 *
 * ── NO DECISION IS CACHED (AZ-A5 clause 7, AZ-A4 clause 2, annex D11/D13) ──
 *
 * `listSurfaces()` and `surfaceLevel()` both read the database on every call.
 * The arm carries no state in any token and memoises no answer, so a
 * membership removal or a `status='disabled'` write is honoured on the VERY
 * NEXT request. The only memoisation in this seam is
 * `enumerateProtectedRouteFamilies()`, which describes the CODE (the routers
 * are constructed at import and cannot change while the process runs) and
 * never a principal's authority.
 */
import { pool } from '../db/connection';
import { grantService } from './GrantService';
import { accessProfileService, renderAuthoritySeam } from './AccessProfileService';
import {
  enumerateProtectedRouteFamilies,
  familyMatchesRequest,
  familyPathMatches,
  familyPathsOverlap,
  familyRequirement,
  parseFamilyKey,
  READ_ONLY_METHODS,
} from '../utils/routeFamilies';
import { normalizePathForScope, ROOT_SCOPE } from '../utils/scopeMap';
import { isAuthorityMutationSurfaceKey } from '../utils/authorityMutationSurfaces';
import { isLoginSessionKind } from '../utils/administratorSession';

export type SurfaceGovernance = 'governable' | 'always-self' | 'locked';
export type SurfaceOrigin = 'core' | 'plugin';

/**
 * A25.3: the access levels of the (Group, Access bundle) pair, ordered
 * `none < use < configure`. A25.4 requires the COMPOUND wherever an authority
 * verb could be read — these are access levels, never the ratified verb `use`.
 */
export type AccessLevel = 'none' | 'use' | 'configure';

export const ACCESS_LEVELS: readonly AccessLevel[] = ['none', 'use', 'configure'] as const;

/** One line per arm invocation, for annex `85a2218d` D16's invocation record.
 * Off unless `RELAYHALL_SURFACE_ARM_TRACE=1`: an enumerated diagnostic, never a
 * default, and it prints the PATH and the resolved surface key only — never a
 * decision, a principal or a credential. D16 asserts a scope-gated family NEVER
 * appears here, which is a claim about the ORDER the arm's clauses run in, and
 * is why the line is emitted by the arm rather than by its caller (round-1
 * review P4). */
const SURFACE_ARM_TRACE = process.env.RELAYHALL_SURFACE_ARM_TRACE === '1';
export const SURFACE_ARM_TRACE_PREFIX = 'SURFACE ARM INVOCATION';

/**
 * The SQL fragment ONE authority seam opens, and how its parameters bind.
 * Structurally what `GrantService.activeGrantCondition` and
 * `AccessProfileService.activeProfileCondition` already return.
 */
export interface AuthoritySeamFragment {
  sql: string;
  bind: (principalId: string, resourceType: 'surface', verb: 'read' | 'write') => unknown[];
}

/**
 * ONE authority seam: a named authority path through which an authority row can reach a
 * principal, and the SQL fragment that opens it.
 *
 * ROUND-4b REVIEW `252fe7e6` B2. `surfaceLevel` below composed
 * `activeGrantCondition` and `activeProfileCondition` INLINE, so the SET of
 * authority paths existed only as two expressions in one function body. Every consumer
 * that needs the INVENTORY -- the acceptance drill above all -- had to keep its
 * own list, and a reviewer who added a THIRD authority path to `surfaceLevel` found that
 * no list anywhere went red: the drill derived each store's TABLE from the SQL
 * production generates, but WHICH SEAMS EXIST was still a two-entry literal it
 * owned. The inventory is therefore a production EXPORT, and `surfaceLevel` is
 * composed FROM IT rather than beside it.
 *
 * `store` is the ratified name of the authority path: annex `85a2218d` D17 and D21(ii)
 * both spell `surface-grant` and `profile-assignment`.
 */
export interface AuthoritySeam {
  readonly store: string;
  readonly condition: (paramOffset: number) => AuthoritySeamFragment;
}

/**
 * EVERY authority path to a surface access level, enumerated. `surfaceLevel` ORs exactly
 * these and nothing else, which is what makes this array the contract rather
 * than a description of one.
 */
export const AUTHORITY_SEAMS: readonly AuthoritySeam[] = [
  { store: 'surface-grant', condition: (offset: number) => grantService.activeGrantCondition(offset) },
  { store: 'profile-assignment', condition: (offset: number) => accessProfileService.activeProfileCondition(offset) },
] as const;

export interface ExcludedFamily {
  family: string;
  requirement: string;
}

/**
 * ONE session, as the arm sees it: the two SERVER-DERIVED facts it reads and
 * nothing else — no header, no role, no scope set. `root` is absent because
 * root never reaches the arm (design `7a9317b2` §3.2 I1).
 */
export interface SurfaceArmSession {
  principalId: string | null;
  authMethod: string | undefined;
}

/** Why the arm refused, or `null` when it admitted. */
export type SurfaceArmRefusal =
  | 'NOT_GOVERNABLE'
  | 'AUTHORITY_MUTATION_SURFACE'
  | 'AUTHENTICATION_KIND'
  | 'FAMILY_UNDECLARED'
  | 'SURFACE_CONCEALED'
  | 'SURFACE_LEVEL_INSUFFICIENT';

export interface ArmDecision {
  admitted: boolean;
  level: AccessLevel;
  refusal: SurfaceArmRefusal | null;
}

/** The menu question adds the one fact the arm itself never asks about. */
export interface SettingsMenuSession extends SurfaceArmSession {
  /** Does the ROUTE STAGE already admit this session at `root`? */
  rootAuthorized: boolean;
}

/**
 * One navigation entry, as the server decides it.
 *
 * TWO SHAPES, and the difference is the point. A VISIBLE entry describes
 * itself fully — the session may reach that surface, so telling it the label
 * and the path discloses nothing it could not read from the page. A CONCEALED
 * entry carries its KEY and the `false`, and nothing else: round-1 review P3
 * showed the full shape published a map of the deployment to a session that
 * may not see it, which is exactly what the arm's 404 on a read family
 * prevents at the HTTP seam.
 *
 * The key survives on a concealed CORE row because the core key set is public
 * in `109_access_surfaces.sql`, and because the shell must distinguish
 * "registered and concealed" from "not registered here" — the second falls
 * back to what the entry was reachable by before SETGOV and the first must
 * not. A concealed PLUGIN row is omitted entirely: which plugins a deployment
 * runs is that deployment's shape, and no public file discloses it.
 */
export type SettingsSurfaceEntry =
  | {
      key: string;
      label: string;
      menuPath: string;
      governance: SurfaceGovernance;
      level: AccessLevel;
      visible: true;
    }
  | { key: string; visible: false };

export interface AccessSurfaceRecord {
  id: string;
  key: string;
  label: string;
  governance: SurfaceGovernance;
  lockedReference: string | null;
  readFamilies: string[];
  writeFamilies: string[];
  excludedFamilies: ExcludedFamily[];
  menuPath: string | null;
  origin: SurfaceOrigin;
  pluginName: string | null;
  retiredAt: string | null;
}

/**
 * Root-gated families that are deliberately NOT governed by any Access
 * surface, each with the ratified reason (annex D2 clause (ii)). An enumerated
 * set, never a pattern: growing it is a security-significant code-review event
 * of the same class as growing `PUBLIC_ROUTE_MOUNTS`.
 */
export const UNGOVERNED_ROOT_FAMILIES: ReadonlyArray<{ family: string; reason: string }> = [
  {
    family: 'POST /directory-group-references/:id/use',
    reason: 'LENSES v7.1 96f0bd3d and ruling 60307311: using a reference creates and binds a Group as an owner-plane root-session act; steward administration waits for LENSES-c and the rule-4 arm.',
  },
  {
    family: 'DELETE /directory-group-references/:id',
    reason: 'LENSES v7.1 96f0bd3d: retiring a retained, empty, unbound directory reference is an owner-plane root-session act; it is not delegated through an Access bundle.',
  },
  {
    family: 'DELETE /groups/:id/home-pointers',
    reason:
      'RH-LENSES-b design 96f0bd3d s7.2 (acceptance A-L38): clearing every Account home pointer at one Group is the owner-plane act that makes GroupService.remove\'s GROUP_IS_A_HOME_GROUP refusal actionable. It writes other Accounts\' pointers in one transaction, one audited home_group.clear each, so it is root-session administration of the same class as the two directory-reference acts above -- not an operation delegated through an Access bundle. Declared ungoverned rather than surfaced: putting it on a bundle would widen who may clear another Account\'s pointer, which is a decision this composition does not make.',
  },
  {
    family: 'PUT /projects/:id/charter',
    reason:
      'Design 7a9317b2 §1.6: the Charter is a work-plane document whose root gate encodes an owner ruling about WHO MAY AUTHOR it ("agents propose, the owner approves"), not about who may administer a deployment. It is root-gated, so it COULD be governable, and deliberately is not.',
  },
  {
    family: 'GET /plugins',
    reason:
      'Design 7a9317b2 §1.4/§5.3: the plugin registry read is root only by FALLTHROUGH — `/plugins` has no rule in scopeMap. §5.3 gives it a `principals:read`-class rule narrowed in-handler to the surfaces the caller reaches. That change lands in SETGOV candidate B with the /access-bundles router; until then the family stays ungoverned rather than being declared on a surface it does not yet serve.',
  },
  {
    family: 'GET /plugins/:name',
    reason:
      'Design 7a9317b2 §1.4/§5.3: the per-plugin registry read, root by the same fallthrough as `GET /plugins`, and narrowed by the same candidate-B change.',
  },
];

interface SurfaceRow {
  id: string;
  key: string;
  label: string;
  governance: string;
  locked_reference: string | null;
  read_families: string[] | null;
  write_families: string[] | null;
  excluded_families: unknown;
  menu_path: string | null;
  origin: string;
  plugin_name: string | null;
  retired_at: Date | string | null;
}

function mapSurface(row: SurfaceRow): AccessSurfaceRecord {
  const excluded = Array.isArray(row.excluded_families) ? row.excluded_families : [];
  return {
    id: String(row.id),
    key: String(row.key),
    label: String(row.label),
    governance: row.governance as SurfaceGovernance,
    lockedReference: row.locked_reference ?? null,
    readFamilies: row.read_families ?? [],
    writeFamilies: row.write_families ?? [],
    excludedFamilies: excluded
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => ({ family: String(entry.family ?? ''), requirement: String(entry.requirement ?? '') })),
    menuPath: row.menu_path ?? null,
    origin: row.origin as SurfaceOrigin,
    pluginName: row.plugin_name ?? null,
    retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : null,
  };
}

export interface SurfaceMatch {
  surface: AccessSurfaceRecord;
  /** The declared family path that matched, e.g. `/appearance/versions`. */
  familyPath: string;
}

/** Ordering for `none < use < configure` (design §2.5, most-permissive-wins). */
export function levelAtLeast(level: AccessLevel, floor: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(level) >= ACCESS_LEVELS.indexOf(floor);
}

export type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export class AccessSurfaceService {
  /**
   * Every live Access surface, read from the database. Not cached: a surface
   * registered after boot (annex D19's "one registered AFTER the row was
   * written") must be visible on the next request, and no authority answer may
   * outlive the row it was derived from.
   */
  async listSurfaces(queryable: Queryable = pool): Promise<AccessSurfaceRecord[]> {
    const result = await queryable.query(
      `SELECT id, key, label, governance, locked_reference, read_families, write_families,
              excluded_families, menu_path, origin, plugin_name, retired_at
         FROM access_surfaces
        WHERE retired_at IS NULL
        ORDER BY key`,
    );
    return result.rows.map((row) => mapSurface(row as SurfaceRow));
  }

  /** Every live surface including retired ones — the census and the drills. */
  async listAllSurfaces(queryable: Queryable = pool): Promise<AccessSurfaceRecord[]> {
    const result = await queryable.query(
      `SELECT id, key, label, governance, locked_reference, read_families, write_families,
              excluded_families, menu_path, origin, plugin_name, retired_at
         FROM access_surfaces ORDER BY key`,
    );
    return result.rows.map((row) => mapSurface(row as SurfaceRow));
  }

  /**
   * Every surface whose declared families claim this path.
   *
   * At most ONE resolves on a sound catalogue — the boot census refuses an
   * overlap (§3.3 property 4, annex D15) — and this returns the full match list
   * precisely so D15 can observe the two-surface resolution its red mutation
   * produces once that refusal is removed.
   */
  resolveSurfaceMatches(surfaces: AccessSurfaceRecord[], mountedPath: string): SurfaceMatch[] {
    const path = normalizePathForScope(mountedPath);
    const matches: SurfaceMatch[] = [];
    for (const surface of surfaces) {
      let best: string | null = null;
      for (const key of [...surface.readFamilies, ...surface.writeFamilies]) {
        const parsed = parseFamilyKey(key);
        if (!parsed || !familyPathMatches(parsed.path, path)) continue;
        if (best === null || parsed.path.length > best.length) best = parsed.path;
      }
      if (best !== null) matches.push({ surface, familyPath: best });
    }
    // Longest declared path first: the ratified longest-prefix rule (§3.3).
    matches.sort((a, b) => b.familyPath.length - a.familyPath.length || a.surface.key.localeCompare(b.surface.key));
    return matches;
  }

  /** The one surface a path resolves to, or null. Longest-prefix wins. */
  resolveSurface(surfaces: AccessSurfaceRecord[], mountedPath: string): AccessSurfaceRecord | null {
    return this.resolveSurfaceMatches(surfaces, mountedPath)[0]?.surface ?? null;
  }

  /**
   * Is this request a `read` family of the surface, a `write` family, or
   * neither? The lists are ALLOWLISTS, not hints: a path in neither is refused
   * even on a resolved surface (§3.3 property 5).
   */
  familyClassFor(
    surface: AccessSurfaceRecord,
    method: string,
    mountedPath: string,
  ): 'read' | 'write' | null {
    const path = normalizePathForScope(mountedPath);
    if (surface.readFamilies.some((key) => familyMatchesRequest(key, method, path))) return 'read';
    if (surface.writeFamilies.some((key) => familyMatchesRequest(key, method, path))) return 'write';
    return null;
  }

  /**
   * THE ARM. The access level one principal holds over one Access surface,
   * read live from the two authority stores — `grants` through
   * `activeGrantCondition` and `access_profile_rules` through
   * `activeProfileCondition`, the same seams every other object type composes,
   * verb for verb. `write` implies `configure`, `read` alone is `use`, neither
   * is `none` (§2.4, §3.4).
   *
   * Precedence is most-permissive-wins (§2.5) BY CONSTRUCTION: each seam is a
   * disjunction over every path that reaches the principal, so the maximum over
   * (Group, Access bundle) paths is what the SQL already answers.
   *
   * Neither `root` nor an administrator ROLE is consulted here. Root never
   * reaches the arm — it satisfies the route stage (I1) — and a role is not an
   * authority row: a level must be written down to be held.
   */
  async surfaceLevel(
    principalId: string | null,
    surfaceId: string,
    queryable: Queryable = pool,
  ): Promise<AccessLevel> {
    if (!principalId) return 'none';
    const params: unknown[] = [surfaceId];
    // Composed FROM `AUTHORITY_SEAMS`, never beside it: the exported inventory
    // and the SQL this function emits are then one fact, and an authority path cannot be
    // opened here without appearing there (round-4b review `252fe7e6` B2).
    const clause = (verb: 'read' | 'write'): string => {
      const resourceId = '$1::uuid';
      const fragments = AUTHORITY_SEAMS.map((seam) => {
        const opened = seam.condition(params.length + 1);
        params.push(...opened.bind(principalId, 'surface', verb));
        // No project column: an Access surface has no project perimeter, so
        // the project-bounded arm renders as `FALSE` here (RH-AZ.PROJ-b), which
        // is the evaluator half of `SELECTOR_FORM_ADMISSIBILITY` closing
        // `surface` to `exact` alone.
        return `(${renderAuthoritySeam(opened.sql, resourceId)})`;
      });
      // No authority path is `none`, and saying so beats emitting `SELECT  AS can_read`.
      if (fragments.length === 0) return 'FALSE';
      return `(${fragments.join(' OR ')})`;
    };
    const readClause = clause('read');
    const writeClause = clause('write');
    const result = await queryable.query(
      `SELECT ${readClause} AS can_read, ${writeClause} AS can_write`,
      params,
    );
    const row = result.rows[0] ?? {};
    if (row.can_write === true) return 'configure';
    if (row.can_read === true) return 'use';
    return 'none';
  }

  /**
   * THE ARM'S VERDICT, as one function.
   *
   * RH-UI.SETTINGS.2 (card `d0f030a9`). `evaluateSurfaceStage` used to inline
   * clauses 4b, 5, 6 and 7 of design `7a9317b2` §3.2 in the middleware body,
   * which was sound while the arm had exactly one consumer. The Settings shell
   * is the second: it must not RENDER a navigation entry for a surface this
   * session cannot reach (SETGOV `83defda6` — a surface a session may not see
   * is not rendered, never merely disabled), and "may this session reach it" is
   * precisely the question the arm answers on a read family.
   *
   * Written twice it would be two definitions, and the shell would come to
   * disagree with the gate — the exact shape a control that does not cross the
   * seam has. So the DECISION lives here, and the middleware keeps only what is
   * its own: the audit write, the response shape, and the route-stage clauses
   * (2, 3, 4) that precede any of this.
   *
   * THE ORDER IS THE RATIFIED ONE and is load-bearing, not incidental: 4b
   * before 5 before the family test before the level. Moving the family test
   * earlier would stop the two audited refusals being written for a request to
   * an undeclared path on one of those surfaces, and annex `85a2218d` D21
   * clause (ii) counts exactly those rows.
   *
   * PRECONDITION, held by both callers: the surface RESOLVED (§3.2 clause 3)
   * and the route stage already refused. A non-`governable` surface is decided
   * by the ratified gate (§3.2 clauses 3/4) and is answered `NOT_GOVERNABLE`
   * here rather than throwing into an authorization path.
   *
   * It performs NO audit write and sends NO response: a caller that refuses a
   * REQUEST records the refusal (`recordSurfaceRefusal`), and a caller that is
   * only describing a menu must not write a denial for a page nobody requested.
   */
  async armDecision(
    session: SurfaceArmSession,
    surface: AccessSurfaceRecord,
    family: 'read' | 'write' | null,
    queryable: Queryable = pool,
    /** The mounted path a REQUEST matched. Absent from a menu question, and
     *  that absence is what keeps the menu out of D16's invocation record. */
    tracePath?: string,
  ): Promise<ArmDecision> {
    const refused = (refusal: SurfaceArmRefusal): ArmDecision =>
      ({ admitted: false, level: 'none', refusal });

    if (surface.governance !== 'governable') return refused('NOT_GOVERNABLE');

    // 4b. AUTHORITY-MUTATION SURFACES (#15, #17, #18) — owner ruling
    //     `70af4d82` §1.1, annex `85a2218d` D21 clause (iii). THE ARM NEVER
    //     ADMITS THEM, and returns BEFORE the level is computed so a row
    //     naming one of them — inserted by any path that bypasses the write
    //     refusals, raw SQL included — confers nothing.
    if (isAuthorityMutationSurfaceKey(surface.key)) return refused('AUTHORITY_MUTATION_SURFACE');

    // 5. AUTHENTICATION KIND (I6). For a core surface the arm is consulted only
    //    for an authenticated login session presenting no bearer credential:
    //    every authority row reached by a bearer-authenticated actor is
    //    IGNORED, not merely insufficient. Plugin surfaces are the deliberate
    //    exception, and only because there the arm can only NARROW.
    if (surface.origin === 'core' && !isLoginSessionKind(session.authMethod)) {
      return refused('AUTHENTICATION_KIND');
    }

    // 6. The family test. The lists are ALLOWLISTS: a path in neither is
    //    refused even on a resolved surface, and with the pin's own 403 — this
    //    design governs the families it declares and leaves every other one
    //    exactly as reachable as it is today (I-7). The menu asks about `read`
    //    and never reaches this arm of the branch.
    if (family === null) return refused('FAMILY_UNDECLARED');

    // THE INVOCATION RECORD, emitted HERE and not by the caller.
    //
    // ROUND-1 REVIEW P4. The base logged this line after the family test and
    // BEFORE awaiting `surfaceLevel`; the first extraction moved it to the
    // middleware, gated on a `levelComputed` flag the decision carried back —
    // so a level query that THREW emitted no line where the base emitted one,
    // and annex `85a2218d` D16's record is a claim about the ORDERING. A flag
    // returned after the await cannot express "we got as far as the await".
    // Emitting it at the base's position makes the equivalence structural
    // instead of something a test has to keep proving.
    //
    // ONLY A REQUEST IS RECORDED. `tracePath` is the mounted path the request
    // stage matched, and the MENU passes none: D16 counts arm invocations made
    // by requests, and a menu that filled the record with invocations nobody
    // made would corrupt the very claim the record exists to support.
    if (SURFACE_ARM_TRACE && tracePath !== undefined) {
      console.log(`${SURFACE_ARM_TRACE_PREFIX} ${normalizePathForScope(tracePath)} ${surface.key}`);
    }

    const level = await this.surfaceLevel(session.principalId, surface.id, queryable);
    const admitted = family === 'read'
      ? levelAtLeast(level, 'use')
      : level === 'configure';
    if (admitted) return { admitted: true, level, refusal: null };

    // 7. THE REFUSAL SHAPE. 404 on a read family — the 44d1bf89 concealment
    //    pattern (§9.6), so a Group at `none` cannot map a deployment by
    //    probing. 403 naming the surface on a write family of a surface the
    //    caller may read, because concealment there presents as a broken save.
    //    A write family the caller cannot even read stays concealed.
    const refusal: SurfaceArmRefusal = (family === 'read' || level === 'none')
      ? 'SURFACE_CONCEALED'
      : 'SURFACE_LEVEL_INSUFFICIENT';
    return { admitted: false, level, refusal };
  }

  /**
   * THE SETTINGS MENU, answered by the server.
   *
   * Card `d0f030a9`. Every catalogue surface that declares a `menu_path`, with
   * ONE boolean saying whether this session may see that navigation entry. The
   * Settings shell renders exactly the entries marked visible and omits the
   * rest; it derives nothing, exactly as the connection surfaces derive nothing
   * from `delegableScopes` (card `6e25ae48`) — a predicate mirrored in the
   * frontend is a predicate that will one day disagree with the gate.
   *
   * THE PREDICATE, clause by clause, and why each is the ratified one:
   *
   *  - `rootAuthorized`, ON A LOGIN SESSION — root satisfies the ROUTE STAGE
   *    and never reaches the arm (design §3.2 I1), so it sees every registered
   *    entry. The login-session qualifier is I6 and is load-bearing: see
   *    `menuEntryVisible` (round-2 review P2).
   *  - `always-self` — the arm is not consulted (§3.2 clause 3). These surfaces
   *    carry their own in-handler self-scope arm, so every authenticated
   *    session holds a genuine view of its OWN subtree there. Visible.
   *  - `locked` — the arm is not consulted and the ratified root gate decides
   *    (§3.2 clause 4; A23.1, A17.8). Not visible below root.
   *  - `governable` — `armDecision(..., 'read')`, the same call the request
   *    path makes. An authority-mutation surface, a bearer credential and a
   *    `none` level are all refused there and all hidden here, by construction.
   *
   * `level` is reported ONLY where the arm computes one; it is `none` on a
   * surface the arm never consults, because a level there would be a fiction
   * about a decision nothing makes. It discloses this session's own authority
   * to itself, and nothing whatever about anybody else's.
   */
  async settingsSurfaces(
    session: SettingsMenuSession,
    queryable: Queryable = pool,
  ): Promise<SettingsSurfaceEntry[]> {
    const surfaces = await this.listSurfaces(queryable);
    const entries: SettingsSurfaceEntry[] = [];

    for (const surface of surfaces) {
      if (surface.menuPath === null) continue;

      const visible = await this.menuEntryVisible(session, surface, queryable);

      // ROUND-1 REVIEW P3. A concealed row used to be published in full —
      // label, menu path, governance and level — to any authenticated caller,
      // which handed a session that may not reach a surface a map of it. That
      // is the disclosure the arm's 404 on a read family exists to prevent, so
      // a concealed row now carries its KEY and nothing else, and a concealed
      // PLUGIN row carries nothing at all: the core key set is public in
      // `109_access_surfaces.sql`, but which plugins a deployment runs is that
      // deployment's shape.
      //
      // The key survives on a core row on purpose. It is what lets the shell
      // tell "registered and concealed" from "this deployment does not
      // register that surface at all" — two states that must not collapse,
      // because the second one falls back to what the entry was reachable by
      // before SETGOV and the first one must not.
      if (!visible.admitted) {
        if (surface.origin === 'plugin') continue;
        entries.push({ key: surface.key, visible: false });
        continue;
      }

      entries.push({
        key: surface.key,
        label: surface.label,
        menuPath: surface.menuPath,
        governance: surface.governance,
        level: visible.level,
        visible: true,
      });
    }

    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * May this session SEE one menu-bearing surface?
   *
   *  - `rootAuthorized`, ON A LOGIN SESSION — root satisfies the ROUTE STAGE
   *    and never reaches the arm (design §3.2 I1), so it sees every registered
   *    entry.
   *  - `always-self` — the arm is not consulted (§3.2 clause 3) and the
   *    ratified in-handler self-scope arm decides. THAT ARM IS A LOGIN-SESSION
   *    ARM: `requireSessionViewer` in `routes/warrants.ts` refuses a bearer
   *    credential outright, and `routes/approvals.ts` shares it. ROUND-1
   *    REVIEW P2 — this clause used to admit any authenticated method, so the
   *    menu told a bearer caller it could see the Access manager while every
   *    primary function of that page answered 403. The authentication-kind
   *    test therefore applies here too, for the same reason it applies inside
   *    the arm.
   *  - `locked` — the arm is not consulted and the ratified root gate decides
   *    (§3.2 clause 4; A23.1, A17.8). Not visible below root.
   *  - `governable` — `armDecision(..., 'read')`, the same call the request
   *    path makes.
   *
   * ── ROUND-2 REVIEW P2: WHY THE ROOT CLAUSE IS NOT FIRST ──
   *
   * It was, and that made the round-1 P2 repair unreachable for the caller it
   * was written about. A `rootAuthorized` machine bearer short-circuited above
   * the authentication-kind test and was handed EVERY registered row in full,
   * `settings.access-manager` included — while `requireSessionViewer`
   * (`routes/warrants.ts`, shared by `routes/approvals.ts`) refuses a bearer
   * BEFORE it ever considers root. The menu said visible where the surface
   * refuses: the same defect, entered by a different door.
   *
   * THE INVARIANT, NAMED — AND IT IS A COMPOSITE, not one clause.
   * ROUND-3 REVIEW N1 corrected an earlier version of this comment that
   * attributed the whole conjunction to I6 and said every menu-bearing core
   * surface's own gate is a login-session gate. That is too broad: migration
   * `109_access_surfaces.sql` catalogues About, Preferences and the Settings
   * shell at `authenticated`, not login-session-only, and `always-self` and
   * `locked` surfaces never enter the arm at all. What actually holds, row by
   * row:
   *
   *  - GOVERNABLE CORE — **I6, the authentication-kind clause**: "for a core
   *    surface the arm is consulted only for an authenticated login session
   *    presenting no bearer credential; every authority row reached by a
   *    bearer-authenticated actor is IGNORED, not merely insufficient"
   *    (`armDecision` clause 5; `utils/administratorSession` spells the same
   *    rule for the administrator plane, AZ-18). A bearer's root buys nothing
   *    here because its authority rows are not read at all.
   *  - ALWAYS-SELF — not I6, but the surface's OWN in-handler gate.
   *    `requireSessionViewer` (`routes/warrants.ts`, shared by
   *    `routes/approvals.ts`) refuses a bearer before it considers root, and
   *    refuses a caller with no resolved principal after that. This clause
   *    mirrors both halves.
   *  - LOCKED — the ratified root ceiling (§3.2 clause 4; A23.1, A17.8), which
   *    the credential model keeps off machine callers.
   *
   * What is NOT the justification is §3.2 I1 on its own. Root satisfying the
   * ROUTE STAGE says nothing about a surface's own in-handler gate, so
   * route-stage root only predicts what a caller can actually do when the
   * caller is a login session. The conjunction is sound under the three rows
   * above together, and is conservative under each of them separately.
   *
   * The test is therefore a conjunction, not a reordering into a blanket
   * refusal: a non-login-session falls THROUGH to the per-governance rules
   * rather than being refused outright, because the arm's deliberate PLUGIN
   * exception to I6 (there the arm can only NARROW) must keep deciding plugin
   * surfaces for a bearer. What a bearer loses here is precisely root's
   * unconditional yes, which was never true for it.
   *
   * `rootAuthorized` is not issuable to a bearer on today's deployments —
   * `scopesForRole` gives `root` to `admin`/`orchestrator` and AZ-18 keeps
   * those off machine credentials — so this was latent, not live. A latent
   * ordering defect in an authorization answer is repaired at the ordering,
   * not left for the day the constraint moves.
   */
  private async menuEntryVisible(
    session: SettingsMenuSession,
    surface: AccessSurfaceRecord,
    queryable: Queryable,
  ): Promise<{ admitted: boolean; level: AccessLevel }> {
    if (session.rootAuthorized && isLoginSessionKind(session.authMethod)) {
      return { admitted: true, level: 'none' };
    }

    if (surface.governance === 'always-self') {
      // ROUND-3 REVIEW, the null-principal domain. The gate this clause speaks
      // for refuses TWO things, and it used to mirror only the first:
      // `requireSessionViewer` rejects a bearer with `SESSION_ONLY` and then
      // rejects a resolved-principal-less caller with `PRINCIPAL_REQUIRED`
      // (`routes/warrants.ts:42-64`). A self-scope surface has nothing to show
      // a session with no self.
      //
      // No caller reaches this today — `GET /principals/me` answers 404 for an
      // unresolved principal before the menu is computed — so this is the same
      // shape as the round-2 P2 repair: a latent disagreement between what the
      // menu says and what the surface does, closed at the clause rather than
      // documented. It also lets the agreement drill MEASURE the null domain
      // instead of excluding it to stay green.
      return {
        admitted: isLoginSessionKind(session.authMethod) && session.principalId !== null,
        level: 'none',
      };
    }
    if (surface.governance !== 'governable') return { admitted: false, level: 'none' };

    const decision = await this.armDecision(session, surface, 'read', queryable);
    return { admitted: decision.admitted, level: decision.level };
  }
  /**
   * The boot-time census (annex D2) plus the overlap refusal (D15).
   *
   * Clauses (i)(ii)(iii)(v)(vi)(vii) are candidate A's. **Clause (iv) — the
   * root-gated families a surface's frontend route actually calls, CAPTURED
   * FROM A RENDERED PAGE — is deliberately deferred to candidate C**, which is
   * where rendered pages exist. The deferral is declared in candidate A's
   * evidence report and in both review briefs; it is not a gap.
   *
   * Returns a list of findings. Empty means sound.
   */
  censusFindings(
    surfaces: AccessSurfaceRecord[],
    lockedMemberKeys: string[] = [],
  ): string[] {
    const findings: string[] = [];
    const live = surfaces.filter((surface) => surface.retiredAt === null);
    const registered = enumerateProtectedRouteFamilies();
    const registeredByKey = new Map(registered.map((family) => [family.key, family]));

    // Every declared family must name a route the protected registrations
    // actually serve. Without this, every clause below is measuring a fiction.
    const owners = new Map<string, string[]>();
    for (const surface of live) {
      for (const key of [...surface.readFamilies, ...surface.writeFamilies]) {
        const parsed = parseFamilyKey(key);
        if (!parsed) {
          findings.push(`surface '${surface.key}' declares a malformed family '${key}' (expected "<METHOD> </path>")`);
          continue;
        }
        if (!registeredByKey.has(key)) {
          findings.push(`surface '${surface.key}' declares family '${key}', which no protected route registration serves`);
          continue;
        }
        owners.set(key, [...(owners.get(key) ?? []), surface.key]);
      }
    }

    // (i) Every root-gated family is in EXACTLY ONE surface's governed lists,
    //     or in the UNGOVERNED set with a reason.
    const ungoverned = new Map(UNGOVERNED_ROOT_FAMILIES.map((entry) => [entry.family, entry.reason]));
    for (const family of registered) {
      if (family.requirement !== ROOT_SCOPE) continue;
      const claimants = owners.get(family.key) ?? [];
      const excused = ungoverned.has(family.key);
      if (claimants.length === 0 && !excused) {
        findings.push(`root-gated family '${family.key}' is in no Access surface and not in UNGOVERNED_ROOT_FAMILIES`);
      }
      if (claimants.length > 1) {
        findings.push(`root-gated family '${family.key}' is declared by more than one Access surface: ${claimants.join(', ')}`);
      }
      if (claimants.length > 0 && excused) {
        findings.push(`family '${family.key}' is both declared by ${claimants.join(', ')} and listed as UNGOVERNED`);
      }
    }

    // (ii) Every UNGOVERNED entry names a real root-gated family and carries a
    //      reason. A stale entry is how the set stops being a census.
    for (const entry of UNGOVERNED_ROOT_FAMILIES) {
      const family = registeredByKey.get(entry.family);
      if (!family) {
        findings.push(`UNGOVERNED_ROOT_FAMILIES names '${entry.family}', which no protected route registration serves`);
        continue;
      }
      if (family.requirement !== ROOT_SCOPE) {
        findings.push(`UNGOVERNED_ROOT_FAMILIES names '${entry.family}', whose requirement is '${family.requirement}', not root`);
      }
      if (!entry.reason.trim()) {
        findings.push(`UNGOVERNED_ROOT_FAMILIES entry '${entry.family}' carries no reason`);
      }
    }

    for (const surface of live) {
      const governed = [...surface.readFamilies, ...surface.writeFamilies];

      // (iii) THE CENSUS'S MOST IMPORTANT ROW (§2.2): no `governable` surface
      //       declares a family whose requirement is not `root`. A plugin-proxy
      //       surface is the second limb of the governable rule — the protected
      //       funnel does not gate those prefixes at all — so it is exempt.
      if (surface.governance === 'governable' && surface.origin === 'core') {
        for (const key of governed) {
          const parsed = parseFamilyKey(key);
          if (!parsed) continue;
          const requirement = familyRequirement(parsed);
          if (requirement !== ROOT_SCOPE) {
            findings.push(`governable surface '${surface.key}' declares family '${key}', whose requirement is '${requirement}', not root (design §2.2)`);
          }
        }
      }

      // (vii) I-10 (record 83defda6, A25.3): the level `use` is READ-ONLY, so
      //       every family in a `governable` surface's read_families is
      //       GET/HEAD-only. Red mutation: declare a POST family as a read
      //       family and boot.
      if (surface.governance === 'governable') {
        for (const key of surface.readFamilies) {
          const parsed = parseFamilyKey(key);
          if (!parsed) continue;
          if (!READ_ONLY_METHODS.has(parsed.method)) {
            findings.push(`governable surface '${surface.key}' declares '${key}' as a READ family, but ${parsed.method} is state-changing — the access level 'use' answers GET/HEAD only (ruling I-10, annex D2(vii))`);
          }
        }
      }

      // (v) Every stored `excluded_families` requirement equals the answer
      //     `requiredScopeFor` gives for that family, so the census fails the
      //     moment a route-map change makes a stored requirement stale.
      for (const excluded of surface.excludedFamilies) {
        const parsed = parseFamilyKey(excluded.family);
        if (!parsed) {
          findings.push(`surface '${surface.key}' excludes a malformed family '${excluded.family}'`);
          continue;
        }
        if (!registeredByKey.has(excluded.family)) {
          findings.push(`surface '${surface.key}' excludes family '${excluded.family}', which no protected route registration serves`);
          continue;
        }
        const actual = familyRequirement(parsed);
        if (actual !== excluded.requirement) {
          findings.push(`surface '${surface.key}' records excluded family '${excluded.family}' at requirement '${excluded.requirement}', but the route map answers '${actual}'`);
        }
      }

      // (vi) No family appears in both `excluded_families` and a governed list
      //      — what stops the column being used to smuggle reach back in.
      const governedSet = new Set(governed);
      for (const excluded of surface.excludedFamilies) {
        if (governedSet.has(excluded.family)) {
          findings.push(`surface '${surface.key}' lists family '${excluded.family}' as both governed and excluded`);
        }
      }

      // A25.1: a `locked` surface carries the ratified sentence its lock cites;
      // a lock without such a citation is void. The schema holds NOT NULL; this
      // holds non-empty.
      if (surface.governance === 'locked' && !(surface.lockedReference ?? '').trim()) {
        findings.push(`locked surface '${surface.key}' carries no locked_reference (A25.1: a lock without a ratified citation is void)`);
      }
    }

    // ── D15, clause 1 — the same registered FAMILY claimed twice ────────────
    for (const [key, claimants] of owners) {
      if (claimants.length > 1) {
        findings.push(`family '${key}' resolves to more than one Access surface: ${claimants.join(', ')} (design §3.3 property 4, annex D15)`);
      }
    }

    // ── D15, clause 2 — the same PATH claimed by two surfaces ───────────────
    //
    // The previous version of this census asserted that "path overlap between
    // two surfaces is exactly key overlap here". THAT IS FALSE, and round 1 of
    // this candidate's cross-family review proved it (regression `fd10af48`):
    // a family key carries its METHOD, so two surfaces declaring `GET /x` and
    // `POST /x` have distinct keys, pass clause 1 — and both resolve at
    // runtime, because `resolveSurfaceMatches` matches on PATH ALONE. The
    // alphabetical tie-break in that sort then picks one surface, and the
    // other surface's method classifies as neither read nor write and is
    // refused. Design §3.3 property 4 says one path resolves to AT MOST ONE
    // Access surface; this is where that is enforced.
    //
    // Pairwise over declared paths rather than over keys, and `:param` on
    // either side collides with a literal, because that is what
    // `familyPathMatches` does at runtime.
    const declaredPaths: Array<{ surface: string; path: string }> = [];
    for (const surface of live) {
      for (const key of [...surface.readFamilies, ...surface.writeFamilies]) {
        const parsed = parseFamilyKey(key);
        if (parsed) declaredPaths.push({ surface: surface.key, path: parsed.path });
      }
    }
    const reportedOverlaps = new Set<string>();
    for (let i = 0; i < declaredPaths.length; i += 1) {
      for (let j = i + 1; j < declaredPaths.length; j += 1) {
        const a = declaredPaths[i];
        const b = declaredPaths[j];
        if (a.surface === b.surface) continue;
        if (!familyPathsOverlap(a.path, b.path)) continue;
        const signature = [`${a.surface}:${a.path}`, `${b.surface}:${b.path}`].sort().join(' <> ');
        if (reportedOverlaps.has(signature)) continue;
        reportedOverlaps.add(signature);
        const [first, second] = [a.surface, b.surface].sort();
        findings.push(
          `path '${a.path}' resolves to more than one Access surface: ${first}, ${second} `
          + `(declared as '${a.path}' and '${b.path}'; resolution is by PATH, not by family key — `
          + 'design §3.3 property 4, annex D15)',
        );
      }
    }

    // D9/D2: a `locked` surface is never an Access-bundle member. The write
    // surface refuses it (candidate B); the census refuses it here.
    for (const key of lockedMemberKeys) {
      findings.push(`Access-bundle membership names locked surface '${key}' — locked surfaces are outside the model (I2, AZ-A5 clause 4)`);
    }

    return findings;
  }

  /** Locked surfaces that are Access-bundle members — the census's input. */
  async lockedMemberSurfaceKeys(queryable: Queryable = pool): Promise<string[]> {
    const result = await queryable.query(
      `SELECT DISTINCT s.key
         FROM access_bundle_members m
         JOIN access_surfaces s ON s.id = m.surface_id
        WHERE s.governance = 'locked'
        ORDER BY s.key`,
    );
    return result.rows.map((row) => String(row.key));
  }

  /**
   * Run the census against the live catalogue and RETURN its findings.
   *
   * Findings are returned rather than thrown so the boot prints data it owns:
   * they name route families, surface keys and ratified requirements — never a
   * secret — and an operator cannot repair the catalogue without reading them.
   * A thrown-and-caught message would reach the console through the redacting
   * failure logger as `(Error) [class=Error code=ERROR_UNCLASSIFIED]`, which is
   * an undiagnosable boot; that is how the first version of this behaved.
   */
  async auditCatalogue(queryable: Queryable = pool): Promise<string[]> {
    const surfaces = await this.listAllSurfaces(queryable);
    const lockedMembers = await this.lockedMemberSurfaceKeys(queryable);
    return this.censusFindings(surfaces, lockedMembers);
  }
}

export const accessSurfaceService = new AccessSurfaceService();
