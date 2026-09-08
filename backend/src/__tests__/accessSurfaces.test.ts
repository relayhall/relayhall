/**
 * accessSurfaces.test.ts — SETGOV candidate A (card `bbec04de` subtask [2]).
 *
 * Contract: design `7a9317b2` v3.3 §2.1, §2.2, §3.2, §3.3, §3.4; AUTHZ
 * amendment **AZ-A5** clauses 2-5; vocabulary **A25** incl. the A25.3 sitting
 * addition (ruling I-10); acceptance annex `85a2218d` D2, D3, D15, D19.
 *
 * WHAT THESE PIN, and what they deliberately do NOT.
 *
 * These drive the production census, resolver and family test with the
 * database pool as the mock boundary (the accessProfiles/telemetryFrames
 * precedent). They are the STATIC half of the controls:
 *
 *  - the family representation, and that every seeded family names a route the
 *    protected registrations actually serve;
 *  - the census clauses (i)(ii)(iii)(v)(vi)(vii) and D15's overlap refusal,
 *    each with the red mutation the annex names, and each mutation reddening a
 *    DIFFERENT finding;
 *  - resolution: at most one surface, longest prefix, and the adversarial
 *    spellings `normalizePathForScope` already immunises;
 *  - the arm's SQL SHAPE: the two seams, composed verb for verb, with the
 *    surface id bound as the resource-id column.
 *
 * The RUNTIME halves - a `none` caller's 404 at the HTTP seam (D6), a bearer
 * credential ignored on a core surface (D17), a wildcard grant row inserted
 * directly in SQL conferring nothing (D19), a hostile fixture surface never
 * reaching the arm (D16) - are NOT here and cannot be: a mock pool fails only
 * as it is told to. They are `scripts/setgov-live-drill.mjs`, against a real
 * migrated PostgreSQL and a real process.
 */
const db = {
  queries: [] as Array<{ text: string; params?: unknown[] }>,
  script: [] as Array<(text: string, params?: unknown[]) => { rows: any[] } | null>,
};

function scripted(text: string, params?: unknown[]): { rows: any[] } {
  db.queries.push({ text, params });
  for (const handler of db.script) {
    const result = handler(text, params);
    if (result) return result;
  }
  return { rows: [] };
}

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
    connect: jest.fn(async () => ({
      query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
      release: jest.fn(),
    })),
  },
}));

import {
  accessSurfaceService,
  levelAtLeast,
  UNGOVERNED_ROOT_FAMILIES,
  type AccessSurfaceRecord,
  AUTHORITY_SEAMS,
} from '../services/AccessSurfaceService';
import {
  enumerateProtectedRouteFamilies,
  familyMatchesRequest,
  familyPathsOverlap,
  familyRequirement,
  parseFamilyKey,
  READ_ONLY_METHODS,
} from '../utils/routeFamilies';
import { ROOT_SCOPE } from '../utils/scopeMap';
import {
  AUTHORITY_MUTATION_REFUSAL_ACT,
  AUTHORITY_MUTATION_SURFACE_KEYS,
  RULE_FOUR_ARM_CARD,
  authorityMutationRefusalMessage,
  isAuthorityMutationSurfaceKey,
} from '../utils/authorityMutationSurfaces';
import { evaluateSurfaceStage } from '../middleware/sharedAuthorization';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

const ID = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;

function surface(over: Partial<AccessSurfaceRecord> = {}): AccessSurfaceRecord {
  return {
    id: ID(1),
    key: 'settings.webhooks',
    label: 'Webhooks',
    governance: 'governable',
    lockedReference: null,
    readFamilies: ['GET /webhooks'],
    writeFamilies: ['POST /webhooks', 'PATCH /webhooks/:id', 'DELETE /webhooks/:id'],
    excludedFamilies: [],
    menuPath: null,
    origin: 'core',
    pluginName: null,
    retiredAt: null,
    ...over,
  };
}

/** The seven root-gated families with no Access surface, mirroring the seed of
 * migration 109 closely enough for the census clauses to be exercised. */
function seededPair(): AccessSurfaceRecord[] {
  return [
    surface(),
    surface({
      id: ID(2),
      key: 'settings.appearance',
      label: 'Appearance',
      readFamilies: ['GET /appearance/versions'],
      writeFamilies: ['PUT /appearance'],
      excludedFamilies: [
        { family: 'GET /appearance', requirement: 'authenticated' },
        { family: 'GET /appearance/info', requirement: 'authenticated' },
      ],
      menuPath: '/settings/appearance',
    }),
  ];
}

beforeEach(() => {
  db.queries = [];
  db.script = [];
});

describe('route families are derived from the routers, not from a hand list', () => {
  it('enumerates every protected (method, path) with the requirement the route map answers', () => {
    const families = enumerateProtectedRouteFamilies();
    expect(families.length).toBeGreaterThan(200);
    // Spot-check the two shapes that force a family to carry its METHOD: both
    // routers serve a read and a write on the SAME path, so a path-only family
    // could not express ruling I-10's read-only `use` for either of them.
    expect(families.find((f) => f.key === 'GET /webhooks')?.requirement).toBe(ROOT_SCOPE);
    expect(families.find((f) => f.key === 'POST /webhooks')?.requirement).toBe(ROOT_SCOPE);
    expect(families.find((f) => f.key === 'GET /litellm/models')?.requirement).toBe(ROOT_SCOPE);
    expect(families.find((f) => f.key === 'POST /litellm/models')?.requirement).toBe(ROOT_SCOPE);
  });

  it('binds a path parameter to a spelling no literal rule can match', () => {
    // `/principals/:id` resolved with `me` would answer the /principals/me rule
    // instead of the family rule; a UUID cannot collide with a literal segment.
    expect(familyRequirement({ method: 'PATCH', path: '/principals/:id' })).toBe('principals:admin');
    expect(familyRequirement({ method: 'GET', path: '/principals/me' })).toBe('authenticated');
    expect(familyRequirement({ method: 'GET', path: '/access-profiles/:id/events' })).toBe(ROOT_SCOPE);
    expect(familyRequirement({ method: 'GET', path: '/access-profiles/what-if' })).toBe(ROOT_SCOPE);
  });

  it('a family answers only its own method, and inherits path-spelling immunity', () => {
    expect(familyMatchesRequest('GET /webhooks', 'GET', '/webhooks')).toBe(true);
    expect(familyMatchesRequest('GET /webhooks', 'POST', '/webhooks')).toBe(false);
    expect(familyMatchesRequest('PATCH /webhooks/:id', 'PATCH', '/webhooks/abc')).toBe(true);
    expect(familyMatchesRequest('PATCH /webhooks/:id', 'PATCH', '/webhooks/abc/extra')).toBe(false);
    expect(parseFamilyKey('nonsense')).toBeNull();
    expect(parseFamilyKey('GET webhooks')).toBeNull();
  });

  it('UNGOVERNED_ROOT_FAMILIES names only real root-gated families, each with a reason', () => {
    const byKey = new Map(enumerateProtectedRouteFamilies().map((f) => [f.key, f]));
    expect(UNGOVERNED_ROOT_FAMILIES.length).toBeGreaterThan(0);
    for (const entry of UNGOVERNED_ROOT_FAMILIES) {
      expect(byKey.get(entry.family)?.requirement).toBe(ROOT_SCOPE);
      expect(entry.reason.trim().length).toBeGreaterThan(40);
    }
  });
});

describe('the boot census (annex D2 (i)(ii)(iii)(v)(vi)(vii)) and D15', () => {
  /** Clause (i) is a claim about the WHOLE catalogue, and these fixtures are
   * deliberately partial, so it fires for every root family the fixture omits.
   * Dropping those lines leaves the clauses that are properties of the
   * fixture's OWN rows - which is what each red mutation below moves. The real
   * thirteen-row seed is proved sound where the census actually runs: at a live
   * boot against a migrated database (scripts/setgov-live-drill.mjs). */
  const ownFindings = (surfaces: AccessSurfaceRecord[], locked: string[] = []): string[] =>
    accessSurfaceService.censusFindings(surfaces, locked)
      .filter((finding) => !finding.includes('is in no Access surface'));

  it('the fixture surfaces are internally sound', () => {
    expect(ownFindings(seededPair())).toEqual([]);
  });

  it('(iii) RED: a governable surface declaring a SCOPE-GATED family fails the boot', () => {
    // The annex\'s own red mutation: "declare `/tasks` on Appearance".
    const findings = ownFindings([surface({ readFamilies: ['GET /webhooks', 'GET /tasks'] })]);
    expect(findings.some((f) => f.includes("declares family 'GET /tasks'") && f.includes('not root'))).toBe(true);
  });

  it('(vii) RED: a POST family declared as a READ family fails the boot (ruling I-10)', () => {
    const findings = ownFindings([surface({ readFamilies: ['GET /webhooks', 'POST /webhooks'], writeFamilies: ['PATCH /webhooks/:id'] })]);
    expect(findings.some((f) => f.includes('POST /webhooks') && f.includes("'use' answers GET/HEAD only"))).toBe(true);
    // ...and it reddens (vii) ALONE: POST /webhooks is root-gated, so (iii) is
    // silent, and it is still claimed by exactly one surface, so (i) is silent.
    expect(findings.filter((f) => f.includes('not root'))).toEqual([]);
    expect(findings.filter((f) => f.includes('more than one Access surface'))).toEqual([]);
  });

  it('(i) RED: a root-gated family in no surface and not UNGOVERNED fails the boot', () => {
    const findings = accessSurfaceService.censusFindings([]);
    expect(findings.some((f) => f.includes("root-gated family 'GET /webhooks' is in no Access surface"))).toBe(true);
  });

  it('(v) RED: a STALE excluded requirement fails the boot', () => {
    const findings = ownFindings([surface({ excludedFamilies: [{ family: 'GET /appearance', requirement: 'principals:read' }] })]);
    expect(findings.some((f) => f.includes("at requirement 'principals:read', but the route map answers 'authenticated'"))).toBe(true);
  });

  it('(vi) RED: a family both governed and excluded fails the boot', () => {
    const findings = ownFindings([surface({ excludedFamilies: [{ family: 'GET /webhooks', requirement: ROOT_SCOPE }] })]);
    expect(findings.some((f) => f.includes('both governed and excluded'))).toBe(true);
  });

  it('D15 RED: two surfaces claiming one family is the overlap the boot refuses', () => {
    const findings = ownFindings([
      surface(),
      surface({ id: ID(3), key: 'settings.webhooks-shadow', readFamilies: ['GET /webhooks'], writeFamilies: [] }),
    ]);
    expect(findings.some((f) => f.includes("family 'GET /webhooks' resolves to more than one Access surface"))).toBe(true);
  });

  it('D9/D2: a LOCKED surface named as an Access-bundle member fails the boot', () => {
    const findings = ownFindings(seededPair(), ['settings.identity-providers']);
    expect(findings.some((f) => f.includes("locked surface 'settings.identity-providers'"))).toBe(true);
  });

  it('a declared family that no registration serves fails the boot', () => {
    const findings = ownFindings([surface({ writeFamilies: ['POST /webhooks', 'POST /invented'] })]);
    expect(findings.some((f) => f.includes("'POST /invented', which no protected route registration serves"))).toBe(true);
  });

  it('a lock without a ratified citation is void (A25.1)', () => {
    const findings = ownFindings([surface({ governance: 'locked', lockedReference: '  ' })]);
    expect(findings.some((f) => f.includes('carries no locked_reference'))).toBe(true);
  });

  it('a governable PLUGIN surface is exempt from (iii): the proxy prefix is the second limb of the rule', () => {
    // §2.2/§11: plugin prefixes never reach the route map at all - the proxy is
    // mounted BEFORE the protected funnel - so requiring `root` of them would
    // be measuring against a map that does not describe them.
    const findings = ownFindings([
      surface({
        key: 'plugin.fixture.dashboard', origin: 'plugin', pluginName: 'fixture',
        readFamilies: ['GET /webhooks'], writeFamilies: [],
      }),
    ]);
    expect(findings.filter((f) => f.includes('not root'))).toEqual([]);
  });
});

describe('resolveSurface (§3.3 properties 3, 4, 5)', () => {
  it('resolves by path, longest declared prefix first, and at most one on a sound catalogue', () => {
    const surfaces = seededPair();
    expect(accessSurfaceService.resolveSurface(surfaces, '/webhooks')?.key).toBe('settings.webhooks');
    expect(accessSurfaceService.resolveSurface(surfaces, '/webhooks/abc')?.key).toBe('settings.webhooks');
    expect(accessSurfaceService.resolveSurface(surfaces, '/appearance/versions')?.key).toBe('settings.appearance');
    expect(accessSurfaceService.resolveSurface(surfaces, '/tasks')).toBeNull();
    expect(accessSurfaceService.resolveSurfaceMatches(surfaces, '/webhooks')).toHaveLength(1);
  });

  it('adversarial spellings resolve to the same surface as the canonical form (D15)', () => {
    const surfaces = seededPair();
    for (const spelling of ['/webhooks/', '//webhooks', '/WEBHOOKS', '/webhooks//', '/Webhooks/']) {
      expect(accessSurfaceService.resolveSurface(surfaces, spelling)?.key).toBe('settings.webhooks');
    }
  });

  it('an overlapping catalogue resolves to TWO surfaces — which is why the boot refuses it', () => {
    const surfaces = [
      surface(),
      surface({ id: ID(3), key: 'settings.webhooks-shadow', readFamilies: ['GET /webhooks'], writeFamilies: [] }),
    ];
    expect(accessSurfaceService.resolveSurfaceMatches(surfaces, '/webhooks')).toHaveLength(2);
  });

  it('the family lists are ALLOWLISTS: a path in neither is neither read nor write', () => {
    const [webhooks] = seededPair();
    expect(accessSurfaceService.familyClassFor(webhooks, 'GET', '/webhooks')).toBe('read');
    expect(accessSurfaceService.familyClassFor(webhooks, 'POST', '/webhooks')).toBe('write');
    expect(accessSurfaceService.familyClassFor(webhooks, 'PATCH', '/webhooks/abc')).toBe('write');
    expect(accessSurfaceService.familyClassFor(webhooks, 'PUT', '/webhooks')).toBeNull();
  });

  it('every read family of a governable surface is GET/HEAD, by construction of the seed', () => {
    for (const s of seededPair()) {
      for (const key of s.readFamilies) {
        expect(READ_ONLY_METHODS.has(parseFamilyKey(key)!.method)).toBe(true);
      }
    }
  });
});

describe('the arm (AZ-A5 clause 2, design §3.4)', () => {
  it('composes BOTH authority stores, verb for verb, with the surface id as the resource id', async () => {
    db.script.push(() => ({ rows: [{ can_read: false, can_write: false }] }));
    const level = await accessSurfaceService.surfaceLevel(ID(9), ID(1));
    expect(level).toBe('none');
    const sql = db.queries[0].text;
    expect(sql).toContain('FROM grants g');
    expect(sql).toContain('FROM access_profile_assignments apa');
    // No `<RESOURCE_ID_COLUMN>` placeholder survives into the statement.
    expect(sql).not.toContain('<RESOURCE_ID_COLUMN>');
    expect(sql).toContain('$1::uuid');
    // Four seams: grant+profile for `read`, grant+profile for `write`.
    expect(db.queries[0].params).toEqual([
      ID(1),
      ID(9), 'surface', 'read', ID(9), 'surface', 'read',
      ID(9), 'surface', 'write', ID(9), 'surface', 'write',
    ]);
  });

  it("`write` is configure, `read` alone is use, neither is none", async () => {
    for (const [row, expected] of [
      [{ can_read: true, can_write: true }, 'configure'],
      [{ can_read: true, can_write: false }, 'use'],
      [{ can_read: false, can_write: false }, 'none'],
      // A `write` row with no `read` row is still `configure`: the level is the
      // maximum over every path that reaches the principal (§2.5).
      [{ can_read: false, can_write: true }, 'configure'],
    ] as const) {
      db.queries = [];
      db.script = [() => ({ rows: [row] })];
      expect(await accessSurfaceService.surfaceLevel(ID(9), ID(1))).toBe(expected);
    }
  });

  it('an unresolved principal holds no level, and asks the database nothing', async () => {
    expect(await accessSurfaceService.surfaceLevel(null, ID(1))).toBe('none');
    expect(db.queries).toHaveLength(0);
  });

  it('the level ordering is none < use < configure (§2.5)', () => {
    expect(levelAtLeast('configure', 'use')).toBe(true);
    expect(levelAtLeast('use', 'use')).toBe(true);
    expect(levelAtLeast('none', 'use')).toBe(false);
    expect(levelAtLeast('use', 'configure')).toBe(false);
  });
});

// ── THE AUTHORITY-MUTATION CLOSURE (owner ruling `70af4d82` §1.1) ───────────
//
// The RUNTIME half — a non-root Account at Administrative `configure` meeting
// the root refusal over HTTP, with a same-run root control that succeeds — is
// annex D21 clauses (ii) and (iii) in `scripts/setgov-live-drill.mjs`, and it
// cannot be here: a mock pool fails only as it is told to. What IS here is the
// mechanism and the seed: that the arm returns BEFORE it computes a level, and
// that migration 109 seeds what the ruling says.

describe('authority-mutation surfaces are governable, unbundled, and outside the arm', () => {
  const MIGRATION = readFileSync(
    join(__dirname, '..', 'migrations', '109_access_surfaces.sql'), 'utf8',
  );

  it('the withheld set is exactly the three the ruling names, matched EXACTLY', () => {
    expect([...AUTHORITY_MUTATION_SURFACE_KEYS].sort()).toEqual([
      'settings.access-grants', 'settings.access-profiles-groups', 'settings.identities',
    ]);
    expect(isAuthorityMutationSurfaceKey('settings.access-grants')).toBe(true);
    // Not a prefix, not a substring: a look-alike key is governed normally.
    expect(isAuthorityMutationSurfaceKey('settings.access-grants-legacy')).toBe(false);
    expect(isAuthorityMutationSurfaceKey('access-grants')).toBe(false);
    expect(isAuthorityMutationSurfaceKey('settings.webhooks')).toBe(false);
  });

  it('the audited denial act SATISFIES THE LEDGER`S OWN CHECK (087)', () => {
    // The first spelling was `access-bundle.refused`. 087 constrains
    // `audit_events.action` to `^[a-z][a-z0-9_.]{2,127}$`, which admits `_` and
    // `.` and NOT `-`; every insert violated it, the service's swallowing
    // `catch` hid it, and the drill's audit assertion is what found it. The
    // pattern below is transcribed from the migration, and asserted against it.
    const LEDGER_ACTION_CHECK = /^[a-z][a-z0-9_.]{2,127}$/;
    const migration = readFileSync(
      join(__dirname, '..', 'migrations', '087_audit_events.sql'), 'utf8',
    );
    expect(migration).toContain('[a-z][a-z0-9_.]{2,127}');
    expect(AUTHORITY_MUTATION_REFUSAL_ACT).toMatch(LEDGER_ACTION_CHECK);
    expect(AUTHORITY_MUTATION_REFUSAL_ACT).toBe('access_bundle.refused');
    // And the act the ARM writes, on the same ledger, for the same reason.
    expect('surface.refused').toMatch(LEDGER_ACTION_CHECK);
  });

  it('the refusal sentence names the surface AND the missing arm', () => {
    const message = authorityMutationRefusalMessage('settings.identities');
    expect(message).toContain('settings.identities');
    expect(message).toContain(RULE_FOUR_ARM_CARD);
    expect(RULE_FOUR_ARM_CARD).toBe('3e76cfcc');
  });

  /**
   * ROUND-3 REGRESSION `c179b66b`.
   *
   * The control this replaces inspected three `s.key IN (...)` FRAGMENTS. The
   * A1 reviewer appended a perfectly valid statement that carries no `IN (...)`
   * at all —
   *
   *     INSERT INTO access_bundle_members (bundle_id, surface_id)
   *       SELECT b.id, s.id FROM access_bundles b, access_surfaces s
   *        WHERE b.key = 'administrative' AND s.key = 'settings.access-grants';
   *
   * — and every shipped assertion still passed, although executing that
   * migration would put #15 into Administrative in violation of owner ruling
   * `70af4d82` §1.1 and annex D21(i).
   *
   * A control over ONE SQL SPELLING is not a control over the membership. The
   * helpers below prove the COMPLETE set instead: every statement in the
   * migration that writes `access_bundle_members`, attributed to the bundle
   * branch it sits in, and every surface key any of them names in ANY spelling.
   * Board lesson `stop-making-the-census-complete`: the assertion is a
   * comparison of whole sets, not a list of the shapes anyone thought of.
   */
  const withoutSqlComments = (sql: string): string => {
    let out = '';
    let quoted = false;
    for (let i = 0; i < sql.length; i += 1) {
      const ch = sql[i];
      if (quoted) { out += ch; if (ch === "'") quoted = false; continue; }
      if (ch === "'") { quoted = true; out += ch; continue; }
      if (ch === '-' && sql[i + 1] === '-') {
        const nl = sql.indexOf('\n', i);
        if (nl < 0) break;
        out += '\n';
        i = nl;
        continue;
      }
      out += ch;
    }
    return out;
  };

  /**
   * Split the migration into statements at top-level `;`, quotes respected.
   *
   * ROUND-4 REVIEW `43520bf5` B2. The previous form matched a LIST OF VERBS
   * (`INSERT INTO|UPDATE|COPY|MERGE INTO access_bundle_members`) against the
   * bare table name, and the reviewer walked past it three ways: a
   * schema-qualified `INSERT INTO public.access_bundle_members`, a
   * `TRUNCATE access_bundle_members`, and a second `SELECT array_append(...)`
   * that rewrote the projection after the checked one. A control that
   * enumerates the shapes someone thought of is not a control over the
   * membership (board lesson `stop-making-the-census-complete`).
   *
   * So nothing is enumerated. EVERY statement that so much as MENTIONS
   * `access_bundle_members` or `governable_ids` is CLASSIFIED, and a statement
   * that matches no known classification FAILS. A new spelling, a new verb, a
   * schema qualification, a destructive statement, a second assignment — all
   * of them are unclassified, and unclassified is red.
   */
  const sqlStatements = (sql: string): string[] => {
    const text = withoutSqlComments(sql);
    const out: string[] = [];
    let quoted = false;
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) { if (ch === "'") quoted = false; continue; }
      if (ch === "'") { quoted = true; continue; }
      if (ch === ';') { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
  };

  const surfaceKeysIn = (statement: string): string[] =>
    [...statement.matchAll(/'(settings\.[a-z-]+)'/g)].map((match) => match[1]).sort();

  /**
   * The statement with every string LITERAL blanked.
   *
   * Classification must read CODE, not prose. Migration 109's profile
   * description literally contains the sentence "the projection of
   * access_bundle_members onto the bundle's governable members", so a
   * classifier that matched the raw text would call a `INSERT INTO
   * access_profiles` statement a membership write. Surface keys are still read
   * from the ORIGINAL statement, because there they ARE the literals.
   */
  const codeOf = (statement: string): string => {
    let out = '';
    let quoted = false;
    for (let i = 0; i < statement.length; i += 1) {
      const ch = statement[i];
      if (quoted) { if (ch === "'") { quoted = false; out += "''"; } continue; }
      if (ch === "'") { quoted = true; continue; }
      out += ch;
    }
    return out;
  };

  /**
   * Every statement whose CODE mentions `access_bundle_members`, classified.
   *
   *   `ddl`         — CREATE TABLE / CREATE INDEX / COMMENT ON / ALTER TABLE
   *   `membership`  — exactly one `INSERT INTO access_bundle_members`, inside a
   *                   bundle branch (PL/pgSQL `IF`/`ELSIF` may precede it in
   *                   the same statement, so the branch is looked for there
   *                   first and in the preceding text second)
   *   `unknown`     — ANYTHING else, which is a finding
   */
  const membershipStatements = (sql: string) => {
    const text = withoutSqlComments(sql);
    const priorBranches = [...text.matchAll(/\b(?:ELS)?IF\s+bundle_key\s*=\s*'([a-z-]+)'/gi)]
      .map((match) => ({ index: match.index ?? 0, bundleKey: match[1] }));
    let cursor = 0;
    return sqlStatements(sql)
      .map((statement) => {
        const at = text.indexOf(statement, cursor);
        cursor = at >= 0 ? at + statement.length : cursor;
        return { statement, code: codeOf(statement), at };
      })
      .filter(({ code }) => /\baccess_bundle_members\b/i.test(code))
      .map(({ statement, code, at }) => {
        const surfaceKeys = surfaceKeysIn(statement);
        if (/^\s*(?:CREATE\s+(?:TABLE|UNIQUE\s+INDEX|INDEX)|COMMENT\s+ON|ALTER\s+TABLE)\b/i.test(code)) {
          return { kind: 'ddl' as const, bundleKey: null, surfaceKeys: [] as string[], statement };
        }
        const mentions = (code.match(/\baccess_bundle_members\b/gi) ?? []).length;
        const inserts = [...code.matchAll(/\bINSERT\s+INTO\s+access_bundle_members\s*\(/gi)];
        const own = [...statement.matchAll(/\b(?:ELS)?IF\s+bundle_key\s*=\s*'([a-z-]+)'/gi)];
        const prior = [...priorBranches].reverse().find((branch) => branch.index < at);
        const bundleKey = own.length > 0 ? own[own.length - 1][1] : (prior?.bundleKey ?? null);
        if (mentions !== 1 || inserts.length !== 1 || bundleKey === null) {
          return { kind: 'unknown' as const, bundleKey, surfaceKeys, statement };
        }
        return { kind: 'membership' as const, bundleKey, surfaceKeys, statement };
      });
  };

  /**
   * Every statement whose CODE mentions `governable_ids` — §3.4's PROJECTION,
   * the other door to the same authority — classified the same way.
   */
  const projectionStatements = (sql: string) =>
    sqlStatements(sql)
      .map((statement) => ({ statement, code: codeOf(statement) }))
      .filter(({ code }) => /\bgovernable_ids\b/.test(code))
      .map(({ statement, code }) => {
        const surfaceKeys = surfaceKeysIn(statement);
        if (/\bgovernable_ids\s+UUID\[\]/i.test(code) || /^\s*DECLARE\b/i.test(code)) {
          return { kind: 'declare' as const, surfaceKeys: [] as string[], statement };
        }
        const assigns = [...code.matchAll(/\bINTO\s+governable_ids\b/gi)];
        if (assigns.length === 1 && /\bSELECT\s+array_agg\(\s*s\.id/i.test(code)) {
          // ROUND-5 REVIEW (half A1, finding F2): this is the statement the
          // reviewer widened with `OR s.label = 'Access grants'`, which moved
          // the surfaces entering the projection without moving the key list
          // `surfaceKeysIn` reads. A selection that is a pure CONJUNCTION can
          // only narrow, so the literals over-approximate what it selects.
          if (!surfaceSelectionIsBounded(statement, code)) {
            return { kind: 'unknown' as const, surfaceKeys, statement };
          }
          return { kind: 'assign' as const, surfaceKeys, statement };
        }
        if (assigns.length === 0 && /\bgovernable_ids\s+IS\s+NOT\s+NULL\b/i.test(code)
          && /\bINSERT\s+INTO\s+access_profile_rules\b/i.test(code)) {
          return { kind: 'consume' as const, surfaceKeys, statement };
        }
        if (assigns.length === 0 && /\bgovernable_ids\s+IS\s+NOT\s+NULL\b/i.test(code)) {
          return { kind: 'guard' as const, surfaceKeys, statement };
        }
        return { kind: 'unknown' as const, surfaceKeys, statement };
      });

  /**
   * EVERY TABLE AN ACCESS LEVEL CAN COME OUT OF, named by PRODUCTION.
   *
   * ROUND-4 EXTRA VERDICT `eed02f4e` F4. The two censuses above are keyed on
   * two TOKEN SPELLINGS — `access_bundle_members` and `governable_ids` — so the
   * reviewer's `UPDATE access_profile_rules SET selector_ids = …` reached the
   * ratified projection while mentioning neither, and no control saw it. A
   * census that must be complete is a census that will be incomplete (board
   * lesson `stop-making-the-census-complete`), so this one is not written down
   * at all: the tables are read out of the SQL production's own authority seams
   * generate, plus the membership table §3.4 makes the projection FROM.
   *
   * A door added to `surfaceLevel` therefore widens this census with no edit
   * here, and every WRITE to any of these tables in the migration must be
   * classified — unclassified is red, whatever its verb or qualification.
   */
  const AUTHORITY_TABLES: string[] = (() => {
    const tables = new Set<string>(['access_bundle_members']);
    for (const seam of AUTHORITY_SEAMS) {
      const seamSql = seam.condition(1).sql;
      for (const match of seamSql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)) {
        tables.add(String(match[1]).toLowerCase());
      }
    }
    return [...tables].sort();
  })();

  const AUTHORITY_WRITE_VERB =
    /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|COPY|MERGE\s+INTO)\s+(?:ONLY\s+)?(?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/gi;

  /** Does this statement's CODE so much as NAME an authority table? */
  const mentionsAuthorityTable = (code: string): string[] =>
    AUTHORITY_TABLES.filter((table) => new RegExp(`\\b${table}\\b`, 'i').test(code));

  /**
   * Is a statement's SURFACE SELECTION a pure conjunction?
   *
   * ROUND-5 REVIEW (half A1, finding F2). `surfaceKeysIn` reads key-shaped
   * literals, and the reviewer widened the projection with
   * `OR s.label = 'Access grants'`: the surfaces entering the projection
   * changed and the key list did not, so the withheld-surface loop could not
   * see it. Parsing predicates harder is the census that will always be
   * incomplete, so the SHAPE is constrained instead: with no `OR` and no
   * negation anywhere in the statement, every additional term can only NARROW,
   * so the key literals are an over-approximation of the selected set — and an
   * over-approximation is the safe direction for "no withheld key may enter".
   *
   * `IS NOT NULL` is the one negation the seeded statements use and it narrows,
   * so it is removed before the test rather than excused by name.
   */
  /**
   * Do the collected key literals BOUND what this statement selects?
   *
   * ROUND-5 REVIEW (half A1, finding F2, second pass — verdict `0b1d5e88`).
   * The first form of this asked only whether the selection was a pure
   * conjunction, which constrains its BOOLEAN STRUCTURE and says nothing about
   * the relationship between the literals `surfaceKeysIn` reads and the rows
   * the statement actually selects. The reviewer's input is valid SQL, is a
   * pure conjunction, keeps exactly the four expected literals, and selects
   * withheld surfaces:
   *
   *     AND s.key LIKE 'settings.%'
   *     AND ARRAY['settings.appearance', …] IS NOT NULL
   *
   * A blacklist of Boolean keywords cannot fix that, and enumerating the
   * predicate forms that widen is the census that is always incomplete. What is
   * required instead is a CONTAINMENT ARGUMENT, stated as four conditions that
   * together make the selection unsatisfiable for any surface outside the
   * literal set:
   *
   *   1. `access_surfaces` is bound EXACTLY ONCE in the statement, under an
   *      alias, and that alias's `id` is what the statement projects — so a
   *      second binding cannot smuggle in rows the predicate never constrained;
   *   2. the selection is a FLAT conjunction: no disjunction, no negation
   *      (`IS [NOT] NULL` removed first, because it narrows), and NO SUBQUERY.
   *      Every term is then a top-level CONJUNCT and any one of them alone
   *      bounds the result. The no-subquery half was self-found after the four
   *      conditions were first written: `AND (SELECT count(*) FROM …
   *      WHERE s.key IN (<the four literals>)) >= 0` satisfies every other
   *      condition and bounds nothing, because the `IN` term sits inside an
   *      always-true scalar subquery instead of beside it;
   *   3. exactly one term mentions `<alias>.key`, and it is the positive form
   *      `<alias>.key IN ( <string literals> )` — nothing else in the selection
   *      may mention the key column at all;
   *   4. that term's literal set is EXACTLY the set `surfaceKeysIn` collects
   *      from the statement, so the two readings cannot disagree and a literal
   *      cannot hide anywhere else (an `ARRAY[…]` decoy included).
   *
   * Given (1)–(4): every selected row satisfies the `IN` conjunct, so its key
   * is in the literal set, so the literal set is a sound OVER-APPROXIMATION of
   * what the statement selects — which is the safe direction for "no withheld
   * key may enter", and is exactly what the withheld-key assertions rely on.
   *
   * A statement that selects no surfaces at all is vacuously bounded.
   */
  const surfaceSelectionIsBounded = (statement: string, code: string): boolean => {
    const bindings = (code.match(/\baccess_surfaces\b/gi) ?? []).length;
    const from = /\bFROM\s+access_surfaces\b/i.exec(code);
    if (!from) return bindings === 0;
    // (1) one binding, aliased, and that alias's id is what is projected
    if (bindings !== 1) return false;
    const alias = /\bFROM\s+access_surfaces\s+(?:AS\s+)?([a-z_][a-z0-9_]*)/i.exec(code)?.[1];
    if (!alias || alias.toLowerCase() === 'where') return false;
    const projection = code.slice(0, from.index);
    if (!new RegExp(`\\b${alias}\\.id\\b`, 'i').test(projection)) return false;
    // (2) a FLAT conjunction: no disjunction, no negation, no branch, no union,
    //     and no subquery -- a term nested inside a subquery is not a conjunct
    //     of the selection and bounds nothing (self-found; see the note above).
    const selection = code.slice(from.index).replace(/\bIS\s+(?:NOT\s+)?NULL\b/gi, ' ');
    if (/\bOR\b/i.test(selection) || /\bNOT\b/i.test(selection)
      || /\bCASE\b/i.test(selection) || /\bUNION\b/i.test(selection)
      || /\bSELECT\b/i.test(selection)) return false;
    // (3) exactly one mention of the key column, in the positive IN form
    const keyMentions = (selection.match(new RegExp(`\\b${alias}\\.key\\b`, 'gi')) ?? []).length;
    if (keyMentions !== 1) return false;
    const inTerm = new RegExp(`\\b${alias}\\.key\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(selection);
    if (!inTerm) return false;
    // the IN list must be string literals and nothing else - `codeOf` has
    // blanked them to `''`, so the ORIGINAL statement is where they are read
    if (!/^\s*(?:''\s*,\s*)*''\s*$/.test(inTerm[1])) return false;
    // (4) the IN list IS the set the assertions read
    const originalIn = new RegExp(`\\b${alias}\\.key\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(statement);
    if (!originalIn) return false;
    const inKeys = [...originalIn[1].matchAll(/'([^']*)'/g)].map((match) => match[1]).sort();
    const collected = [...surfaceKeysIn(statement)].sort();
    return inKeys.length === collected.length && inKeys.every((key, i) => key === collected[i]);
  };


  /**
   * Every statement that NAMES an authority table, classified.
   *
   * ROUND-5 REVIEW (half A1, finding F1). The trigger used to be a WRITE-VERB
   * GRAMMAR over the authority tables, and the reviewer walked four writes past
   * it: `INSERT INTO "access_bundle_members"`, `INSERT INTO public . grants`,
   * a dynamic `EXECUTE format('INSERT INTO grants ...')` and
   * `SELECT ... INTO grants`. A grammar is a census of the spellings someone
   * thought of — the defect this control was written to remove, one rung in.
   *
   * So the trigger is a MENTION, which no spelling of a write can avoid, and
   * the classification is what has to recognise the statement. Thirteen
   * statements of migration 109 name an authority table; each must be one of
   * the six ratified kinds and anything else is `unknown`, which is a finding.
   * Dynamic SQL fails closed outright: `EXECUTE` hides its table name inside a
   * string literal where no static reader can see it, and this migration ships
   * none.
   */
  const authorityWriteStatements = (sql: string) => {
    const text = withoutSqlComments(sql);
    const priorBranches = [...text.matchAll(/\b(?:ELS)?IF\s+bundle_key\s*=\s*'([a-z-]+)'/gi)]
      .map((match) => ({ index: match.index ?? 0, bundleKey: match[1] }));
    let cursor = 0;
    return sqlStatements(sql)
      .map((statement) => {
        const at = text.indexOf(statement, cursor);
        cursor = at >= 0 ? at + statement.length : cursor;
        return { statement, code: codeOf(statement), at };
      })
      .map((entry) => ({ ...entry, tables: mentionsAuthorityTable(entry.code) }))
      // A MENTION, or DYNAMIC SQL of any kind. Round-5 review A1 F1's fourth
      // spelling was `EXECUTE format('INSERT INTO grants ...')`: the table name
      // lives inside a string literal, which `codeOf` blanks, so a mention
      // trigger alone never sees it. Dynamic SQL is unclassifiable by
      // construction and this migration ships none, so it is surfaced whatever
      // its literals say.
      .filter((entry) => entry.tables.length > 0 || /\bEXECUTE\b/i.test(entry.code))
      .map(({ statement, code, at, tables }) => {
        const surfaceKeys = surfaceKeysIn(statement);
        const writes = [...code.matchAll(AUTHORITY_WRITE_VERB)]
          .map((match) => ({ verb: String(match[1]).replace(/\s+/g, ' ').toUpperCase(), table: String(match[2]).toLowerCase() }))
          .filter((write) => AUTHORITY_TABLES.includes(write.table));
        const base = { bundleKey: null as string | null, surfaceKeys, writes, tables, statement };
        // Dynamic SQL: the table name lives in a literal, so nothing static can
        // classify it. Migration 109 ships none; if it ever does, this is where
        // the decision has to be made deliberately.
        if (/\bEXECUTE\b/i.test(code)) return { ...base, kind: 'unknown' as const };
        const only = (verb: string, table: string) => writes.length === 1
          && writes[0].verb === verb && writes[0].table === table;
        if (writes.length === 0) {
          // A statement that names an authority table without writing one is
          // DDL or nothing. `CREATE TABLE`, `CREATE [UNIQUE] INDEX`,
          // `COMMENT ON` and `ALTER TABLE` are the four this migration uses.
          if (/^\s*(?:CREATE\s+(?:TABLE|UNIQUE\s+INDEX|INDEX)|COMMENT\s+ON|ALTER\s+TABLE)\b/i.test(code)) {
            return { ...base, kind: 'ddl' as const, surfaceKeys: [] as string[] };
          }
          return { ...base, kind: 'unknown' as const };
        }
        const own = [...statement.matchAll(/\b(?:ELS)?IF\s+bundle_key\s*=\s*'([a-z-]+)'/gi)];
        const prior = [...priorBranches].reverse().find((branch) => branch.index < at);
        const bundleKey = own.length > 0 ? own[own.length - 1][1] : (prior?.bundleKey ?? null);
        if (only('INSERT INTO', 'access_bundle_members') && bundleKey !== null
          && (code.match(/\baccess_bundle_members\b/gi) ?? []).length === 1
          && surfaceSelectionIsBounded(statement, code)) {
          return { ...base, kind: 'membership' as const, bundleKey };
        }
        if (only('INSERT INTO', 'access_profile_rules') && /\bgovernable_ids\b/.test(code)
          && surfaceSelectionIsBounded(statement, code)) {
          return { ...base, kind: 'projection' as const, bundleKey };
        }
        if (only('INSERT INTO', 'access_profiles') && surfaceKeys.length === 0) {
          return { ...base, kind: 'bundle-profile' as const, bundleKey };
        }
        if (only('UPDATE', 'access_profiles') && /\bSET\s+published_version_id\s*=\s*version_id\b/i.test(code)
          && surfaceKeys.length === 0) {
          return { ...base, kind: 'publish' as const, bundleKey };
        }
        return { ...base, kind: 'unknown' as const, bundleKey };
      });
  };

  /** The five the migration ships, by kind. A sixth of any kind is a finding. */
  const EXPECTED_AUTHORITY_WRITES: Record<string, number> = {
    ddl: 8, membership: 2, projection: 1, 'bundle-profile': 1, publish: 1,
  };

  const EXPECTED_MEMBERSHIP: Record<string, string[]> = {
    // Ruling `70af4d82` §1.1 and design §4.1-§4.3, TRANSCRIBED. Operational is
    // empty at this pin and therefore writes no membership statement at all.
    personal: ['settings.about', 'settings.access-manager', 'settings.preferences', 'settings.shell'],
    administrative: ['settings.appearance', 'settings.connector-owner-plane',
      'settings.model-catalogue', 'settings.webhooks'],
  };

  it('SEED (annex D21 clause (i)): migration 109 registers all three, and bundles NONE of them', () => {
    // The static half of D21 (i), so a seed edit is caught without a database.
    // The expectation is transcribed from ruling `70af4d82` §1.1, not read back
    // from the file it measures.
    for (const key of AUTHORITY_MUTATION_SURFACE_KEYS) {
      expect(MIGRATION).toContain(`('${key}',`);
    }

    // EVERY statement that mentions the membership table, classified. An
    // unclassified statement is a finding, whatever its verb or qualification.
    const statements = membershipStatements(MIGRATION);
    expect(statements.filter((entry) => entry.kind === 'unknown')).toEqual([]);
    const memberships = statements.filter((entry) => entry.kind === 'membership');
    expect(memberships.map((entry) => entry.bundleKey).sort()).toEqual(['administrative', 'personal']);
    for (const entry of memberships) {
      expect(entry.surfaceKeys).toEqual(EXPECTED_MEMBERSHIP[entry.bundleKey as string]);
    }

    // §3.4 makes a bundle's profile pair the PROJECTION of its membership, so
    // a key reaching `governable_ids` confers the surface with no membership
    // row at all. Same treatment: every mention classified, one assignment.
    const projection = projectionStatements(MIGRATION);
    expect(projection.filter((entry) => entry.kind === 'unknown')).toEqual([]);
    const assignments = projection.filter((entry) => entry.kind === 'assign');
    expect(assignments).toHaveLength(1);
    expect(assignments[0].surfaceKeys).toEqual(EXPECTED_MEMBERSHIP.administrative);

    for (const withheld of AUTHORITY_MUTATION_SURFACE_KEYS) {
      for (const entry of [...memberships, ...projection]) {
        expect(entry.surfaceKeys).not.toContain(withheld);
      }
    }
  });

  it('SEED (`eed02f4e` F4): EVERY write to an authority table is classified, and the set is the ratified five', () => {
    // The census is anchored on the tables PRODUCTION reads a level out of, so
    // it covers doors nobody thought to spell — the reviewer's
    // `UPDATE access_profile_rules` among them.
    expect(AUTHORITY_TABLES).toEqual(expect.arrayContaining([
      'access_bundle_members', 'access_profile_rules', 'grants',
    ]));
    const writes = authorityWriteStatements(MIGRATION);
    expect(writes.filter((entry) => entry.kind === 'unknown')).toEqual([]);
    const counted: Record<string, number> = {};
    for (const entry of writes) counted[entry.kind] = (counted[entry.kind] ?? 0) + 1;
    expect(counted).toEqual(EXPECTED_AUTHORITY_WRITES);
    for (const entry of writes) {
      for (const withheld of AUTHORITY_MUTATION_SURFACE_KEYS) {
        expect(entry.surfaceKeys).not.toContain(withheld);
      }
    }
  });

  it('SEED RED (`eed02f4e` F4, reviewer input): a SECOND projection write that mentions neither token is caught', () => {
    // The finding verbatim: `governable_ids` and `access_bundle_members` are
    // both absent from this statement, so both censuses above walk past it —
    // and it writes the projection the profile pair is published from.
    const hostile = `${MIGRATION}\n    UPDATE access_profile_rules SET selector_ids = selector_ids\n      || (SELECT array_agg(s.id) FROM access_surfaces s WHERE s.key = 'settings.access-grants')\n     WHERE resource_type = 'surface';\n`;
    expect(projectionStatements(hostile).filter((entry) => entry.kind === 'unknown')).toHaveLength(0);
    expect(membershipStatements(hostile).filter((entry) => entry.kind === 'unknown')).toHaveLength(0);
    const unknown = authorityWriteStatements(hostile).filter((entry) => entry.kind === 'unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].surfaceKeys).toContain('settings.access-grants');
  });

  it('SEED RED (`eed02f4e` F4): a grant written straight into the authority store is caught too', () => {
    // Nothing in the migration writes `grants`, and nothing should: the table
    // is in the census because a seam READS it, which is the point — a door is
    // a door whichever end it is opened from.
    const hostile = `${MIGRATION}\n    INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)\n      SELECT 'group', b.id, 'surface', s.id, 'write' FROM access_bundles b, access_surfaces s\n       WHERE s.key = 'settings.identities';\n`;
    const unknown = authorityWriteStatements(hostile).filter((entry) => entry.kind === 'unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].writes.map((write) => write.table)).toContain('grants');
  });

  it('SEED RED (`eed02f4e` F4): a SIXTH write of a ratified KIND is a finding as well', () => {
    const hostile = `${MIGRATION}\n    UPDATE access_profiles SET published_version_id = version_id WHERE id = profile_id;\n`;
    const writes = authorityWriteStatements(hostile);
    const counted: Record<string, number> = {};
    for (const entry of writes) counted[entry.kind] = (counted[entry.kind] ?? 0) + 1;
    expect(counted).not.toEqual(EXPECTED_AUTHORITY_WRITES);
    expect(counted.publish).toBe(2);
  });

  it('SEED RED (round-5 review A1 F1, reviewer inputs): four write spellings the VERB GRAMMAR missed', () => {
    // The reviewer's four, verbatim. Each writes an authority table and each
    // walked past the previous form of this census, which triggered on a verb
    // grammar. The trigger is now a MENTION, which no spelling can avoid.
    //
    // What is asserted is DETECTION, not a bucket: three of the four land in
    // `unknown`, and the quoted one is classified as the membership write it
    // genuinely is — caught by the two assertions that carry the claim, namely
    // that the ratified kind multiset moves and that a withheld surface key
    // appears. A control that demanded the `unknown` label would be asserting
    // an implementation detail of the classifier instead of the property.
    const spellings: Record<string, string> = {
      quoted: `INSERT INTO "access_bundle_members" (bundle_id, surface_id)\n        SELECT b.id, s.id FROM access_bundles b, access_surfaces s WHERE s.key = 'settings.identities'`,
      spacedSchema: `INSERT INTO public . grants (grantee_type, grantee_id, resource_type, resource_id, verb)\n        SELECT 'group', b.id, 'surface', s.id, 'write' FROM access_bundles b, access_surfaces s WHERE s.key = 'settings.identities'`,
      dynamic: `EXECUTE format('INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb) VALUES (%L, %L, %L, %L, %L)', 'group', bundle_id, 'surface', governable_ids[1], 'write')`,
      selectInto: `SELECT b.id, s.id INTO grants FROM access_bundles b, access_surfaces s WHERE s.key = 'settings.identities'`,
    };
    const baseline = authorityWriteStatements(MIGRATION);
    for (const [spelling, write] of Object.entries(spellings)) {
      const hostile = `${MIGRATION}\n    ${write};\n`;
      const writes = authorityWriteStatements(hostile);
      // 1. the statement is SEEN at all — the mention trigger fires
      expect({ spelling, seen: writes.length }).toEqual({ spelling, seen: baseline.length + 1 });
      const counted: Record<string, number> = {};
      for (const entry of writes) counted[entry.kind] = (counted[entry.kind] ?? 0) + 1;
      // 2. and it is a finding: either unclassifiable, or it moves the ratified
      //    kind multiset, or it names a surface the ruling withholds.
      const unclassified = writes.filter((entry) => entry.kind === 'unknown').length;
      const multisetMoved = JSON.stringify(counted) !== JSON.stringify(EXPECTED_AUTHORITY_WRITES);
      const namesWithheld = writes.some((entry) => entry.surfaceKeys
        .some((key) => (AUTHORITY_MUTATION_SURFACE_KEYS as readonly string[]).includes(key)));
      expect({ spelling, detected: unclassified > 0 || multisetMoved || namesWithheld })
        .toEqual({ spelling, detected: true });
    }
  });

  it('SEED CONTROL (round-5 review A1 F1): the mention trigger does not redden the shipped migration', () => {
    // A trigger this wide is only usable if the thirteen statements the
    // migration really ships all classify. They do, and the kind multiset is
    // asserted above; this names the count so a fourteenth is visible.
    const writes = authorityWriteStatements(MIGRATION);
    expect(writes).toHaveLength(13);
    expect(writes.filter((entry) => entry.kind === 'unknown')).toEqual([]);
  });

  /**
   * The projection's `SELECT array_agg(s.id ...) ... WHERE ... AND s.key IN (...)`
   * is where every F2 mutation below lands. Helper so each control states only
   * the ONE thing it changes.
   */
  const withProjectionSelector = (replacement: string): string => {
    const original = "       AND s.key IN ('settings.appearance', 'settings.webhooks',\n"
      + "                     'settings.model-catalogue', 'settings.connector-owner-plane')";
    expect(MIGRATION).toContain(original);
    return MIGRATION.replace(original, replacement);
  };

  it('SEED RED (round-5 A1 F2, THE REVIEWER’S OWN INPUT): a LIKE bound with an ARRAY decoy', () => {
    // Verbatim from verdict `0b1d5e88`. Valid SQL, a pure conjunction, and the
    // four expected literals are all still present -- but they are in an
    // `ARRAY[...]` that constrains nothing, and the actual bound is a LIKE that
    // admits every `settings.%` surface, withheld ones included. The previous
    // form of this control passed it.
    const hostile = withProjectionSelector(
      "       AND s.key LIKE 'settings.%'\n"
      + "       AND ARRAY['settings.appearance', 'settings.webhooks',\n"
      + "                 'settings.model-catalogue', 'settings.connector-owner-plane'] IS NOT NULL",
    );
    expect(hostile).not.toEqual(MIGRATION);
    // the literals the assertions read are UNCHANGED -- that is the whole point
    const assign = projectionStatements(hostile).find((entry) => /array_agg/i.test(entry.statement));
    expect(assign?.surfaceKeys).toEqual(EXPECTED_MEMBERSHIP.administrative);
    // ...and it is now unclassifiable, because condition (3) fails: the only
    // mention of the key column is not the positive `IN (<literals>)` form.
    expect(assign?.kind).toBe('unknown');
    expect(projectionStatements(hostile).filter((entry) => entry.kind === 'assign')).toHaveLength(0);
  });

  it('SEED RED (F2, condition 1): the key predicate bounds a DIFFERENT binding than the one projected', () => {
    // Mine. `array_agg(s.id ORDER BY s.key)` is untouched, so the `assign`
    // shape regex still matches and the pre-repair rule classified this. The
    // predicate now bounds `s2`, a second binding of the catalogue that nothing
    // projects, while `s` -- the alias whose ids ARE collected -- is bounded by
    // nothing at all. Every surface enters, and the four literals are intact.
    const hostile = MIGRATION.replace(
      "      FROM access_surfaces s\n     WHERE s.governance = 'governable'",
      "      FROM access_surfaces s, access_surfaces s2\n     WHERE s2.governance = 'governable'",
    ).replace(
      "       AND s.key IN ('settings.appearance', 'settings.webhooks',",
      "       AND s2.key IN ('settings.appearance', 'settings.webhooks',",
    );
    expect(hostile).not.toEqual(MIGRATION);
    const assign = projectionStatements(hostile).find((entry) => /array_agg/i.test(entry.statement));
    // the literals the assertions read are UNCHANGED
    expect(assign?.surfaceKeys).toEqual(EXPECTED_MEMBERSHIP.administrative);
    // ...and condition (1) refuses it: two bindings, so the projected alias is
    // not the one the key predicate constrains.
    expect(assign?.kind).toBe('unknown');
  });

  it('SEED RED (F2, condition 2, SELF-FOUND): the IN term nested inside an always-true subquery', () => {
    // Found by the author before this round went to review. Every other
    // condition is satisfied -- one binding, no disjunction, the key column
    // mentioned exactly once, the positive `IN` form, and exactly the four
    // collected literals -- and the selection is bounded by NOTHING, because
    // the term sits inside a scalar subquery that is always true.
    const hostile = withProjectionSelector(
      "       AND (SELECT count(*) FROM access_bundles b\n"
      + "             WHERE s.key IN ('settings.appearance', 'settings.webhooks',\n"
      + "                             'settings.model-catalogue', 'settings.connector-owner-plane')) >= 0",
    );
    expect(hostile).not.toEqual(MIGRATION);
    const assign = projectionStatements(hostile).find((entry) => /array_agg/i.test(entry.statement));
    expect(assign?.surfaceKeys).toEqual(EXPECTED_MEMBERSHIP.administrative);
    expect(assign?.kind).toBe('unknown');
  });

  it('SEED RED (F2, condition 3): a SECOND key predicate widens what the IN term bounds', () => {
    // Mine. The positive `IN` is still there, verbatim, with the four literals.
    // A second mention of the key column sits beside it -- and because the
    // control requires the key column to be mentioned exactly ONCE, the pair
    // cannot be reasoned about and is refused rather than half-read.
    const hostile = withProjectionSelector(
      "       AND s.key IN ('settings.appearance', 'settings.webhooks',\n"
      + "                     'settings.model-catalogue', 'settings.connector-owner-plane')\n"
      + "       AND s.key >= 'settings.'",
    );
    expect(hostile).not.toEqual(MIGRATION);
    const assign = projectionStatements(hostile).find((entry) => /array_agg/i.test(entry.statement));
    expect(assign?.kind).toBe('unknown');
  });

  it('SEED RED (F2, condition 3): an IN list that is a SUBQUERY, not literals', () => {
    // Mine. `s.key IN (SELECT ...)` is the positive form and mentions the key
    // column exactly once, but its accepted set is not statically known at all.
    const hostile = withProjectionSelector(
      "       AND s.key IN (SELECT key FROM access_surfaces WHERE governance = 'governable')",
    );
    expect(hostile).not.toEqual(MIGRATION);
    const assign = projectionStatements(hostile).find((entry) => /array_agg/i.test(entry.statement));
    expect(assign?.kind).toBe('unknown');
  });

  it('SEED RED (F2, condition 4): a key literal that is in the IN term but NOT the collected set', () => {
    // Mine, and the direction the previous control could never see: the IN term
    // genuinely bounds the selection, but it admits a key `surfaceKeysIn` does
    // not collect -- so the two readings disagree and the assertions built on
    // the collected set would be reasoning about the wrong list.
    const hostile = withProjectionSelector(
      "       AND s.key IN ('settings.appearance', 'settings.webhooks',\n"
      + "                     'settings.model-catalogue', 'settings.connector-owner-plane',\n"
      + "                     'hostile.fixture')",
    );
    expect(hostile).not.toEqual(MIGRATION);
    const assign = projectionStatements(hostile).find((entry) => /array_agg/i.test(entry.statement));
    expect(assign?.surfaceKeys).toEqual(EXPECTED_MEMBERSHIP.administrative);
    expect(assign?.kind).toBe('unknown');
  });

  it('SEED RED (F2): the same widening inside a MEMBERSHIP selection is caught', () => {
    const hostile = MIGRATION.replace(
      "         WHERE s.key IN ('settings.appearance', 'settings.webhooks',\n"
      + "                         'settings.model-catalogue', 'settings.connector-owner-plane');",
      "         WHERE s.key LIKE 'settings.%'\n"
      + "           AND ARRAY['settings.appearance', 'settings.webhooks',\n"
      + "                     'settings.model-catalogue', 'settings.connector-owner-plane'] IS NOT NULL;",
    );
    expect(hostile).not.toEqual(MIGRATION);
    const unknown = authorityWriteStatements(hostile).filter((entry) => entry.kind === 'unknown');
    expect(unknown).toHaveLength(1);
  });

  it('SEED CONTROL (F2): the SHIPPED selectors are bounded, and narrowing terms stay green', () => {
    // The containment argument is only usable if it accepts what the migration
    // really ships and the ordinary ways it might be tightened. A control that
    // reddened on a narrowing edit would be noise and would be loosened.
    expect(projectionStatements(MIGRATION).filter((entry) => entry.kind === 'assign')).toHaveLength(1);
    expect(authorityWriteStatements(MIGRATION).filter((entry) => entry.kind === 'unknown')).toEqual([]);
    const narrowed = withProjectionSelector(
      "       AND s.key IN ('settings.appearance', 'settings.webhooks',\n"
      + "                     'settings.model-catalogue', 'settings.connector-owner-plane')\n"
      + "       AND s.origin = 'core'",
    );
    const assign = projectionStatements(narrowed).find((entry) => /array_agg/i.test(entry.statement));
    expect(assign?.kind).toBe('assign');
    // DECLARED STRICTNESS: a narrowing term that needs a SUBQUERY is refused
    // too, because condition (2) cannot tell a narrowing subquery from the
    // always-true one above. That is the safe direction, and it is a
    // deliberate cost: an edit that wants one must update this control on
    // purpose rather than have it quietly accept a nested predicate.
    const narrowedBySubquery = withProjectionSelector(
      "       AND s.key IN ('settings.appearance', 'settings.webhooks',\n"
      + "                     'settings.model-catalogue', 'settings.connector-owner-plane')\n"
      + "       AND s.id IN (SELECT surface_id FROM access_bundle_members)",
    );
    const refused = projectionStatements(narrowedBySubquery).find((entry) => /array_agg/i.test(entry.statement));
    expect(refused?.kind).toBe('unknown');
  });

  it('SEED RED (`c179b66b`, the A1 round-3 mutation): an APPENDED membership INSERT is caught', () => {
    const hostile = `${MIGRATION}\n    INSERT INTO access_bundle_members (bundle_id, surface_id)\n      SELECT b.id, s.id FROM access_bundles b, access_surfaces s\n       WHERE b.key = 'administrative' AND s.key = 'settings.access-grants';\n`;
    const statements = membershipStatements(hostile);
    // Either classification is a finding: a third membership write, or an
    // unclassified one. What the shipped assertion checks is the SET, and the
    // set is no longer the ratified two.
    const counted = statements.filter((entry) => entry.kind !== 'ddl');
    expect(counted.length).toBeGreaterThan(2);
    expect(counted.some((entry) => entry.surfaceKeys.includes('settings.access-grants'))).toBe(true);
    expect(counted.filter((entry) => entry.kind === 'membership').map((entry) => entry.bundleKey).sort())
      .not.toEqual(['administrative', 'personal']);
  });

  it('SEED RED (`43520bf5` B2, the A1 round-4 mutation): a SCHEMA-QUALIFIED write is caught', () => {
    // The reviewer's exact evasion: the previous control matched the bare table
    // name after a fixed verb list, so `public.access_bundle_members` was not a
    // write at all as far as it was concerned.
    const hostile = `${MIGRATION}\n    INSERT INTO public.access_bundle_members (bundle_id, surface_id)\n      SELECT b.id, s.id FROM access_bundles b, access_surfaces s\n       WHERE b.key = 'administrative' AND s.key = 'settings.access-grants';\n`;
    const unknown = membershipStatements(hostile).filter((entry) => entry.kind === 'unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].surfaceKeys).toContain('settings.access-grants');
  });

  it('SEED RED (`43520bf5` B2): a DESTRUCTIVE membership statement is caught', () => {
    // `TRUNCATE` names no surface key and adds nothing, so a key-set assertion
    // could never see it — and it silently empties every ratified Access
    // bundle. Classification is what notices, because it is not an INSERT.
    for (const destructive of ['TRUNCATE access_bundle_members', "DELETE FROM access_bundle_members WHERE true"]) {
      const hostile = `${MIGRATION}\n    ${destructive};\n`;
      expect(membershipStatements(hostile).filter((entry) => entry.kind === 'unknown')).toHaveLength(1);
    }
  });

  it('SEED RED (`43520bf5` B2): a LATER rewrite of the projection is caught', () => {
    // The reviewer appended a second assignment after the checked one, so the
    // value actually consumed by the profile-rule insert was not the value the
    // control inspected. One assignment, or it is a finding.
    const hostile = MIGRATION.replace(
      'FOREACH level IN ARRAY',
      "SELECT array_append(governable_ids, s.id) INTO governable_ids FROM access_surfaces s WHERE s.key = 'settings.access-grants';\n\n    FOREACH level IN ARRAY",
    );
    expect(hostile).not.toEqual(MIGRATION);
    const projection = projectionStatements(hostile);
    const assignments = projection.filter((entry) => entry.kind === 'assign');
    const unknown = projection.filter((entry) => entry.kind === 'unknown');
    expect(assignments.length + unknown.length).toBeGreaterThan(1);
    expect([...assignments, ...unknown].some((entry) => entry.surfaceKeys.includes('settings.access-grants'))).toBe(true);
  });

  it('SEED RED: a withheld key added INSIDE the existing Administrative membership is caught', () => {
    const hostile = MIGRATION.replace(
      "WHERE s.key IN ('settings.appearance', 'settings.webhooks',",
      "WHERE s.key IN ('settings.access-grants', 'settings.appearance', 'settings.webhooks',",
    );
    expect(hostile).not.toEqual(MIGRATION);
    const admin = membershipStatements(hostile).find((entry) => entry.bundleKey === 'administrative' && entry.kind === 'membership');
    expect(admin?.surfaceKeys).toContain('settings.access-grants');
  });

  it('SEED RED: a withheld key added to the PROJECTION alone is caught, membership untouched', () => {
    const hostile = MIGRATION.replace(
      "AND s.key IN ('settings.appearance', 'settings.webhooks',",
      "AND s.key IN ('settings.access-grants', 'settings.appearance', 'settings.webhooks',",
    );
    expect(hostile).not.toEqual(MIGRATION);
    for (const entry of membershipStatements(hostile).filter((row) => row.kind === 'membership')) {
      expect(entry.surfaceKeys).toEqual(EXPECTED_MEMBERSHIP[entry.bundleKey as string]);
    }
    const assign = projectionStatements(hostile).find((entry) => entry.kind === 'assign');
    expect(assign?.surfaceKeys).toContain('settings.access-grants');
  });

  it('SEED CONTROL: a membership write hidden in a COMMENT is not a write', () => {
    // The comment stripper is load-bearing in both directions: a commented-out
    // statement must not be counted, or the control fails on documentation.
    const commented = `${MIGRATION}\n    -- INSERT INTO access_bundle_members (bundle_id, surface_id) VALUES ('x', 'settings.access-grants');\n`;
    expect(membershipStatements(commented).filter((entry) => entry.kind === 'unknown')).toEqual([]);
    expect(membershipStatements(commented).filter((entry) => entry.kind === 'membership')).toHaveLength(2);
  });

  it('SEED NOTE: the EXECUTABLE proof of this claim is the live drill, not this control', () => {
    // A1 round 4 asked for migration execution into a disposable schema. That
    // is not available in a jest suite with a mock pool, and it already exists
    // where it can: the live drill runs `database/init.sql` then `npm run
    // migrate` against a real disposable PostgreSQL, then asserts
    // `contract (database is migration 109)` — the DATABASE rows equal this
    // migration's parsed seed — and D21 (i) asserts the runtime membership. So
    // this control is the static BACKSTOP that catches a seed edit without a
    // database, and the executable proof is elsewhere by design.
    expect(MIGRATION).toContain('access_bundle_members');
    // Ruling 70af4d82 §1.1's four, transcribed once at the top of this block
    // and asserted here against the ratified spelling, so the two cannot drift.
    expect(EXPECTED_MEMBERSHIP.administrative).toEqual([
      'settings.appearance', 'settings.connector-owner-plane',
      'settings.model-catalogue', 'settings.webhooks',
    ]);
  });

  it('THE ARM RETURNS BEFORE IT COMPUTES A LEVEL, and refuses exactly as the route ceiling did', async () => {
    // The caller HOLDS `configure` here: the scripted level answers
    // can_write:true. If the short-circuit were removed, this request would be
    // ADMITTED - which is the escalation, and is what the annex's red mutation
    // for clause (iii) produces.
    db.script.push((text) => (text.includes('FROM access_surfaces') && text.includes('retired_at IS NULL')
      ? { rows: [{
        id: ID(3), key: 'settings.access-grants', label: 'Access grants', governance: 'governable',
        locked_reference: null, read_families: ['GET /grants'], write_families: ['POST /grants'],
        excluded_families: [], menu_path: null, origin: 'core', plugin_name: null, retired_at: null,
      }] }
      : null));
    db.script.push((text) => (text.includes('AS can_read') ? { rows: [{ can_read: true, can_write: true }] } : null));

    const sent: Array<{ status: number; body: any }> = [];
    const res: any = { status: (code: number) => ({ json: (body: any) => { sent.push({ status: code, body }); return res; } }) };
    const req: any = {
      method: 'POST', baseUrl: '', path: '/grants', authMethod: 'dashboard_jwt',
      principal: { id: ID(9), handle: 'member' },
    };

    const admitted = await evaluateSurfaceStage(req, res, '/grants', ROOT_SCOPE);

    expect(admitted).toBe(false);
    // The ratified ROOT refusal, byte for byte - not this design's 404
    // concealment and not its 403 naming the surface. Ruling §1.1: "their
    // behaviour today is unchanged: root-only, as before SETGOV".
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(403);
    expect(sent[0].body.code).toBe('FORBIDDEN');
    // And the level was never asked for: the arm did not consult the stores.
    expect(db.queries.some((query) => query.text.includes('AS can_read'))).toBe(false);
  });

  it('CONTROL: the same request on a governable surface that is NOT withheld reaches the arm and is admitted', async () => {
    // Without this, the assertion above is satisfied by a stage that refuses
    // everything, and the closure would be indistinguishable from a bug.
    db.script.push((text) => (text.includes('FROM access_surfaces') && text.includes('retired_at IS NULL')
      ? { rows: [{
        id: ID(4), key: 'settings.webhooks', label: 'Webhooks', governance: 'governable',
        locked_reference: null, read_families: ['GET /webhooks'], write_families: ['POST /webhooks'],
        excluded_families: [], menu_path: null, origin: 'core', plugin_name: null, retired_at: null,
      }] }
      : null));
    db.script.push((text) => (text.includes('AS can_read') ? { rows: [{ can_read: true, can_write: true }] } : null));

    const sent: any[] = [];
    const res: any = { status: (code: number) => ({ json: (body: any) => { sent.push({ status: code, body }); return res; } }) };
    const req: any = {
      method: 'POST', baseUrl: '', path: '/webhooks', authMethod: 'dashboard_jwt',
      principal: { id: ID(9), handle: 'member' },
    };

    expect(await evaluateSurfaceStage(req, res, '/webhooks', ROOT_SCOPE)).toBe(true);
    expect(sent).toHaveLength(0);
    expect(db.queries.some((query) => query.text.includes('AS can_read'))).toBe(true);
  });
});

// ── D15 clause 2 — ONE PATH, ONE SURFACE (regression `fd10af48`) ────────────
//
// Round 1 of this candidate's cross-family review broke the census here. It
// keyed ownership by the full `METHOD /path` family and refused only duplicate
// KEYS, while `resolveSurfaceMatches` resolves by PATH ALONE. Two surfaces
// splitting `GET /x` and `POST /x` therefore passed the census, both resolved
// at runtime, and the alphabetical tie-break silently shadowed one — whose
// method then classified as neither read nor write and was refused.
//
// The live half is `D15 RED (path split)` in `scripts/setgov-live-drill.mjs`,
// which installs the split surface and requires the BOOT to refuse.

describe('D15 clause 2: one normalised path resolves to at most one surface', () => {
  const webhooks = () => surface({ id: ID(1), key: 'settings.webhooks' });
  // A partial catalogue trips clause (i) for every root-gated family it does
  // not own, which is correct and is a DIFFERENT clause; these controls are
  // about D15 clause 2 only.
  const overlaps = (findings: string[]) => findings.filter((f) => f.includes('resolves to more than one Access surface'));

  it('the collision predicate is what runtime matching does, params included', () => {
    expect(familyPathsOverlap('/webhooks', '/webhooks')).toBe(true);
    expect(familyPathsOverlap('/webhooks', '/webhooks/:id')).toBe(false);
    // A literal and a parameter in the same position DO collide: one request
    // path matches both, which is exactly what `familyPathMatches` allows.
    expect(familyPathsOverlap('/groups/:id', '/groups/directory-sync')).toBe(true);
    expect(familyPathsOverlap('/groups/:id', '/groups/:groupId')).toBe(true);
    expect(familyPathsOverlap('/groups/:id', '/grants/:id')).toBe(false);
    expect(familyPathsOverlap('/WEBHOOKS/', '/webhooks')).toBe(true);
  });

  it('RED: a GET/POST ownership SPLIT across two surfaces is refused', () => {
    const thief = surface({
      id: ID(2), key: 'zz.webhooks-post-thief', label: 'POST thief',
      readFamilies: [], writeFamilies: ['POST /webhooks'],
    });
    const findings = accessSurfaceService.censusFindings([
      surface({ readFamilies: ['GET /webhooks'], writeFamilies: [] }), thief,
    ]);
    expect(findings.join(' | ')).toMatch(/resolves to more than one Access surface/);
    expect(findings.join(' | ')).toContain('settings.webhooks');
    expect(findings.join(' | ')).toContain('zz.webhooks-post-thief');
  });

  it('RED: a parameterised path that shadows a literal one on another surface is refused', () => {
    const findings = accessSurfaceService.censusFindings([
      surface({ id: ID(3), key: 'a.groups', readFamilies: ['GET /groups/directory-sync'], writeFamilies: [] }),
      surface({ id: ID(4), key: 'b.groups', readFamilies: ['GET /groups/:id'], writeFamilies: [] }),
    ]);
    expect(findings.join(' | ')).toMatch(/resolves to more than one Access surface/);
  });

  it('CONTROL: ONE surface owning both methods on a path is the shipped shape and passes', () => {
    // #21 Webhooks and #22 Model catalogue each serve a read and a write on the
    // SAME path — the very reason a family carries its METHOD (ruling I-10).
    // A census that refused this would make the seeded catalogue unbootable.
    expect(overlaps(accessSurfaceService.censusFindings([webhooks()]))).toEqual([]);
  });

  it('CONTROL: two surfaces on genuinely different paths pass', () => {
    const findings = accessSurfaceService.censusFindings([
      webhooks(),
      surface({ id: ID(5), key: 'settings.model-catalogue', readFamilies: ['GET /litellm/models'], writeFamilies: ['POST /litellm/models'] }),
    ]);
    expect(overlaps(findings)).toEqual([]);
  });

  it('CONTROL: a RETIRED surface does not collide with a live one', () => {
    const findings = accessSurfaceService.censusFindings([
      webhooks(),
      surface({ id: ID(6), key: 'zz.retired', retiredAt: '2026-01-01T00:00:00Z' }),
    ]);
    expect(overlaps(findings)).toEqual([]);
  });
});

// ── THE WRITER CENSUS, and the boot logger's source order ───────────────────
//
// Round 2 of this candidate's cross-family review found two things a passing
// suite could not see, and both are the same shape: a claim about the WHOLE
// TREE that nothing measured.
//
//   `3b9ff322` — AZ-A5 clause 3 says the `surface` closure is "refused at every
//   write surface", and `assertGovernableSurfaceSelectors` was reached from
//   `AccessProfileService.createVersion` alone. `WarrantService.publish-
//   CeilingProfile` writes `access_profile_rules` directly and did not call it.
//
//   `2cef1098` — `server.ts` registered `uncaughtException` /
//   `unhandledRejection` handlers that call `logCaughtFailure` ~130 imports
//   before the import that binds it, so any failure during module evaluation
//   died as `ReferenceError: Cannot access 'secretSafeLog_1' before
//   initialization` instead of the real diagnostic. (Pre-existing on `main`.)
//
// Both controls below are TREE censuses on purpose: they catch the NEXT writer
// and the NEXT reordering, which a test of the two known ones would not.

describe('tree censuses the round-2 review asked for', () => {
  const SRC = join(__dirname, '..');

  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((entry: Dirent) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
      return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });

  const sources = () => walk(SRC).map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  it('every writer of access_profile_rules passes the surface-selector guard', () => {
    const writers = sources()
      .filter((s) => /INSERT\s+INTO\s+access_profile_rules/i.test(s.text))
      .map((s) => s.file.slice(SRC.length + 1));
    // Both are named, so a THIRD writer appearing later fails this line first.
    expect(writers.sort()).toEqual([
      'services/AccessProfileService.ts',
      'services/WarrantService.ts',
    ]);
    for (const writer of writers) {
      const text = readFileSync(join(SRC, writer), 'utf8');
      expect(text).toContain('assertGovernableSurfaceSelectors(');
    }
  });

  it('every writer of grants passes the surface closure, or is a declared mirror', () => {
    const writers = sources()
      .filter((s) => /INSERT\s+INTO\s+grants\s*\(/i.test(s.text))
      .map((s) => s.file.slice(SRC.length + 1))
      .sort();
    expect(writers).toEqual([
      'services/AccessVehicleService.ts',
      'services/GrantService.ts',
      'services/ProjectService.ts',
    ]);
    // GrantService.create carries the closure.
    expect(readFileSync(join(SRC, 'services/GrantService.ts'), 'utf8'))
      .toContain('authorityMutationSurfacesAmong(');
    // AccessVehicleService MIRRORS an authority the assigner already holds: its
    // `resourceType` is read back out of the two stores, so it cannot introduce
    // one. Declared, and pinned so the declaration cannot go stale silently.
    expect(readFileSync(join(SRC, 'services/AccessVehicleService.ts'), 'utf8'))
      .toContain('resourceType: reference.resourceType');
    // RH-LENSES-b (card 4287af8a): the creation default, and the THIRD writer
    // this line admits. It cannot reach the `surface` closure because it
    // cannot write a `surface` row at all: `grantee_type` and `resource_type`
    // are LITERALS in the statement, so neither is steerable by a caller, and
    // the only bound values are the resolved Group, the project the same
    // transaction just created, a verb drawn from a frozen two-element array,
    // the acting principal and the origin constant. Pinned as the exact
    // statement rather than as prose, because a later edit that made either
    // literal a variable would otherwise leave this declaration standing.
    const creationDefault = readFileSync(join(SRC, 'services/ProjectService.ts'), 'utf8');
    expect(creationDefault).toContain("VALUES ('group', $1, 'project', $2, $3, $4, $5)");
    expect(creationDefault).toContain('CREATION_DEFAULT_ORIGIN');
    // ...and it is the ONLY INSERT INTO grants in that file, so the pin above
    // covers every grant row the service can write.
    expect(creationDefault.match(/INSERT\s+INTO\s+grants/gi) || []).toHaveLength(1);
  });

  it('the failure logger is imported BEFORE the handlers that call it', () => {
    const server = readFileSync(join(SRC, 'server.ts'), 'utf8').split('\n');
    const importLine = server.findIndex((line) => /^import \{[^}]*logCaughtFailure/.test(line));
    const firstUse = server.findIndex((line) => /(?<!import \{[^\n]*)logCaughtFailure\(/.test(line));
    expect(importLine).toBeGreaterThanOrEqual(0);
    expect(firstUse).toBeGreaterThanOrEqual(0);
    // `tsc` emits `require` calls in import order, so an import BELOW its first
    // use is a temporal dead zone for anything that throws while the modules
    // between them are still evaluating.
    expect(importLine).toBeLessThan(firstUse);
  });
});
