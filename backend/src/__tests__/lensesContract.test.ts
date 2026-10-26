/**
 * RH-LENSES-d (card 4e159741): THE LENS CONTRACT, the half that needs no
 * database.
 *
 * Design record v7.1 `96f0bd3d` §8.2/§8.3 with ANNEX `d6637a92` §A7.5. The
 * live half - the same rows over real requests, and control R-8-v1 - is
 * `lensesContractLive.test.ts`; the single-copy control R-14 / A-L52 is the
 * importer register in `administratorSessionSeam.test.ts`. The red mutations
 * for all three files are `scripts/lenses-d-mutations.py`.
 *
 *  B-L9d  the route's ceiling is `authenticated`, and the rule that gives it
 *         sits ABOVE both `/principals` family rules. Asserted twice and both
 *         ways: the production resolver answers `authenticated` (below the
 *         family it would answer `principals:read`, which every ordinary
 *         Account lacks), and the rule's own line precedes both family lines.
 *  A-L30  the admin arm, over the COMPLETE authentication-kind space and both
 *         root answers: admin iff root AND a login session. Two-directional:
 *         a bearer holding root is refused it, and the break-glass dashboard
 *         token receives it.
 *  A-L53  the payload of a caller with no live Group role: exactly `lenses`
 *         and `admin`, and NO `manager` key (an empty row list included).
 *  A-L51  LENSES-c c1-B (card b5c83682; design delta C.8): the manager arm,
 *         emitted only for at least one live steward row, rows unchanged.
 *  I-L2   the static half of R-8-v1: the lens module has exactly ONE importer,
 *         the route that serves it, so no module can hold a lens it copied
 *         at load time where the live control's removal cannot reach it.
 *  B-L21  the manager arm arrives as an OPTIONAL member of the same type.
 */
import fs from 'fs';
import path from 'path';
import { requiredScopeFor } from '../utils/scopeMap';
import { lensesFor, type LensesPayload } from '../utils/lenses';

/** Every value `AuditAuthMethod` admits, and the absent one. */
const EVERY_AUTH_METHOD: Array<string | undefined> = [
  'local_admin', 'dashboard_jwt', 'principal_api_key',
  'legacy_api_key', 'reports_read_key', 'session', 'system', 'unknown', undefined,
];

const LENS_ROUTE = '/principals/me/lenses';

describe('B-L9d - the route ceiling, and the order that gives it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'scopeMap.ts'), 'utf8').split('\n');
  const lineOf = (needle: string): number => {
    const index = source.findIndex((line) => line.includes(needle));
    if (index < 0) throw new Error(`scopeMap.ts no longer contains ${needle}`);
    return index;
  };

  it('GET /principals/me/lenses resolves to the authenticated ceiling, in every spelling the resolver admits', () => {
    for (const spelling of [LENS_ROUTE, `${LENS_ROUTE}/`, '/principals/ME/lenses', `${LENS_ROUTE}?x=1`]) {
      expect({ spelling, scope: requiredScopeFor('GET', spelling) }).toEqual({ spelling, scope: 'authenticated' });
    }
  });

  it('only GET is lifted: every other method stays with the /principals family', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect({ method, scope: requiredScopeFor(method, LENS_ROUTE) }).toEqual({ method, scope: 'principals:admin' });
    }
  });

  it('the rule sits ABOVE both /principals family rules', () => {
    const rule = lineOf("/^\\/principals\\/me\\/lenses$/");
    expect(rule).toBeLessThan(lineOf("/^\\/principals(\\/|$)/, methods: ['GET']"));
    expect(rule).toBeLessThan(lineOf("/^\\/principals(\\/|$)/, scope: 'principals:admin'"));
    expect(source[rule]).toContain("methods: ['GET']");
    expect(source[rule]).toContain("scope: 'authenticated'");
  });

  it('the finder is not vacuous - it throws for a rule that is not there', () => {
    expect(() => lineOf('/^\\/principals\\/me\\/no-such-route$/')).toThrow();
  });
});

describe('A-L30 - the admin arm is a ROOT LOGIN SESSION, in both directions', () => {
  it('over every authentication kind and both root answers, admin iff root AND a login session', () => {
    const answers = EVERY_AUTH_METHOD.flatMap((authMethod) => [true, false].map((rootAuthorized) => ({
      authMethod: authMethod ?? '(absent)', rootAuthorized, admin: lensesFor({ authMethod, rootAuthorized }).admin,
    })));
    const admitted = answers.filter((answer) => answer.admin)
      .map((answer) => `${answer.authMethod}/${answer.rootAuthorized}`).sort();
    expect(admitted).toEqual(['dashboard_jwt/true', 'session/true']);
  });

  it('a bearer credential HOLDING root is refused the lens, so root alone is not the test', () => {
    expect(lensesFor({ authMethod: 'principal_api_key', rootAuthorized: true }).admin).toBe(false);
    expect(lensesFor({ authMethod: 'legacy_api_key', rootAuthorized: true }).admin).toBe(false);
  });

  it('the break-glass dashboard token receives it, so the session cookie alone is not the test either', () => {
    expect(lensesFor({ authMethod: 'dashboard_jwt', rootAuthorized: true }).admin).toBe(true);
    expect(lensesFor({ authMethod: 'session', rootAuthorized: true }).admin).toBe(true);
  });

  it('a login session without root is a member and nothing more', () => {
    expect(lensesFor({ authMethod: 'session', rootAuthorized: false })).toStrictEqual({ lenses: ['member'], admin: false });
  });
});

describe('A-L53 - a caller with no live Group role gets no manager key', () => {
  it('a non-admin caller gets exactly { lenses: [member], admin: false } and NO manager key', () => {
    const payload = lensesFor({ authMethod: 'session', rootAuthorized: false });
    expect(payload).toStrictEqual({ lenses: ['member'], admin: false });
    expect(Object.keys(payload).sort()).toEqual(['admin', 'lenses']);
    expect('manager' in payload).toBe(false);
  });

  it('an admin caller gets exactly { lenses: [member, admin], admin: true } and NO manager key', () => {
    const payload = lensesFor({ authMethod: 'session', rootAuthorized: true });
    expect(payload).toStrictEqual({ lenses: ['member', 'admin'], admin: true });
    expect('manager' in payload).toBe(false);
  });

  it('no caller of any kind is handed the manager lens without a live steward row, an EMPTY row list included', () => {
    for (const authMethod of EVERY_AUTH_METHOD) {
      for (const rootAuthorized of [true, false]) {
        for (const stewardedGroups of [undefined, []]) {
          const payload = lensesFor({ authMethod, rootAuthorized, stewardedGroups });
          expect(payload.lenses).not.toContain('manager');
          expect('manager' in payload).toBe(false);
        }
      }
    }
  });
});

describe('A-L51 - the manager arm appears only with a live steward row (LENSES-c c1-B, card b5c83682)', () => {
  const ROWS = [
    { id: 'g1', name: 'Owned', memberCount: 3, featured: true, role: 'owner' as const },
    { id: 'g2', name: 'Managed', memberCount: 1, featured: false, role: 'manager' as const },
  ];

  it('a member with live rows gets [member, manager] and the rows, unchanged and in the order given', () => {
    expect(lensesFor({ authMethod: 'session', rootAuthorized: false, stewardedGroups: ROWS })).toStrictEqual({
      lenses: ['member', 'manager'], admin: false, manager: { stewardedGroups: ROWS },
    });
  });

  it('the arm does not depend on the session kind or on root: a bearer holding rows gets it, an admin session holding none does not', () => {
    expect(lensesFor({ authMethod: 'principal_api_key', rootAuthorized: true, stewardedGroups: ROWS }).lenses)
      .toEqual(['member', 'manager']);
    expect(lensesFor({ authMethod: 'session', rootAuthorized: true, stewardedGroups: [] }))
      .toStrictEqual({ lenses: ['member', 'admin'], admin: true });
  });

  it('with both arms the order is member, manager, admin', () => {
    expect(lensesFor({ authMethod: 'session', rootAuthorized: true, stewardedGroups: ROWS }).lenses)
      .toEqual(['member', 'manager', 'admin']);
  });
});

/**
 * I-L2, THE STATIC HALF OF R-8-v1: the lens module has ONE importer.
 *
 * The live control removes the lens surface by replacing the lens module's
 * exports in the running process, which every consumer reads at call time.
 * The one consumer shape that removal cannot reach is a module that copies a
 * lens function out at LOAD time - and a lens has no business being loaded by
 * any module but the route that serves it. So the importers are enumerated
 * from the tree, every spelling of a module specifier that RESOLVES to
 * `utils/lenses` (static import, re-export, `require`, dynamic `import()`),
 * and compared with a register a person edits deliberately.
 */
const LENS_IMPORTER_REGISTER: Record<string, string> = {
  'routes/principals.ts': 'GET /principals/me/lenses serves the lens and nothing else reads it',
};

/** Every module specifier in a source text: static import, re-export, `require` and dynamic `import()`. */
const SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"`]([^'"`]+)['"`]/g;
const specifiersIn = (code: string): string[] => [...code.matchAll(SPECIFIER)].map((match) => match[1]);
const BACKEND_SRC = path.join(__dirname, '..');
const LENS_MODULE = path.join(BACKEND_SRC, 'utils', 'lenses');
/** Does this specifier, written in `fromFile`, name the lens module? */
const namesLensModule = (fromFile: string, specifier: string): boolean => specifier.startsWith('.')
  && path.resolve(path.dirname(fromFile), specifier).replace(/\.(ts|js)$/, '') === LENS_MODULE;

function lensImporters(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts|js)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      if (full === `${LENS_MODULE}.ts`) continue;
      for (const specifier of specifiersIn(fs.readFileSync(full, 'utf8'))) {
        if (namesLensModule(full, specifier)) found.push(path.relative(BACKEND_SRC, full).split(path.sep).join('/'));
      }
    }
  };
  walk(BACKEND_SRC);
  return [...new Set(found)].sort();
}

describe('I-L2 - the lens module has exactly the registered importers', () => {
  it('no module but the route that serves the lens imports the lens module', () => {
    expect(lensImporters()).toEqual(Object.keys(LENS_IMPORTER_REGISTER).sort());
  });

  it('the importer reader is not vacuous - it reads every specifier spelling and resolves it', () => {
    // The SAME reader the census uses, driven over each spelling a consumer
    // could write, from a file in routes/ and from a sibling in utils/.
    const fromRoute = path.join(BACKEND_SRC, 'routes', 'probe.ts');
    const fromUtil = path.join(BACKEND_SRC, 'utils', 'probe.ts');
    for (const [code, from] of [
      ["import { lensesFor } from '../utils/lenses';", fromRoute],
      ["export { lensesFor as facts } from '../utils/lenses';", fromRoute],
      ["const l = require('../utils/lenses').lensesFor;", fromRoute],
      ['const l = await import("../utils/lenses.js");', fromRoute],
      ["import { lensesFor } from './lenses';", fromUtil],
    ] as Array<[string, string]>) {
      expect({ code, names: specifiersIn(code).some((specifier) => namesLensModule(from, specifier)) })
        .toEqual({ code, names: true });
    }
    expect(specifiersIn("import { x } from './lensesHelpers';").some((specifier) => namesLensModule(fromUtil, specifier)))
      .toBe(false);
    expect(lensImporters()).toContain('routes/principals.ts');
  });
});

describe('B-L21 - the manager arm is additive', () => {
  it('a payload carrying the c1-B arm is the SAME type, so adding it changes no field v1 returns', () => {
    // A compile-time statement first: this literal type-checks against the v1
    // type. The runtime half pins that every v1 field keeps its meaning.
    const later: LensesPayload = {
      lenses: ['member', 'manager'],
      admin: false,
      manager: { stewardedGroups: [{ id: 'g', name: 'Team', memberCount: 3, featured: true, role: 'owner' }] },
    };
    const v1 = lensesFor({ authMethod: 'session', rootAuthorized: false });
    expect(Object.keys(v1).every((key) => key in later)).toBe(true);
    expect(typeof later.admin).toBe(typeof v1.admin);
    expect(Array.isArray(later.lenses)).toBe(Array.isArray(v1.lenses));
  });
});
