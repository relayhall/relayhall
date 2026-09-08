/**
 * ssoSessionMintCensus.test.ts — SS-9's census (annex `e6dcadb9` §11, SS-W3).
 *
 * ── WHY A CENSUS AND NOT A TEST ──
 *
 * SS-9 withdraws a MECHANISM: no login path derives a board role from an
 * external claim, so `auth_sessions.role_snapshot` is written by nobody. That
 * is an "asserts nothing happens" property, and the annex is explicit that such
 * a check "passes vacuously unless its universe is closed — a write in an
 * unenumerated form is absent from the observed set *and* from the test's
 * model". Behavioural tests can show that THIS path writes NULL; they cannot
 * show that no other path writes anything. So the check is anchored at the
 * SINK: the statements that write the table at all.
 *
 * ── THE INVARIANT, NARROWED TO WHAT SS-9 ACTUALLY NEEDS ──
 *
 * v4 of the annex stated the sink far too broadly — "one typed session-creation
 * function is the only writer of `auth_sessions` ... a census refuses any other
 * statement that writes that table in any form" — and round-4 `437c8c66` F5 was
 * right that this gate is RED BEFORE A LINE IS WRITTEN: `middleware/auth.ts`
 * already touches `last_seen_at`, and W1's own logout and revocation paths must
 * update rows too. A required gate that cannot go green is not a gate; it is an
 * invitation to add silent exemptions. The narrowed form, which is what this
 * file implements:
 *
 *   1. **ONE typed mint is the only production INSERT** into `auth_sessions`,
 *      and it is the only place permitted to set `role_snapshot` at all.
 *   2. **Lifecycle UPDATEs are enumerated with their permitted column sets** —
 *      the liveness touch and revocation, and nothing else.
 *   3. **Migrations and test fixtures are excluded EXPLICITLY and censused
 *      separately**, so an exclusion is a visible list rather than a silent
 *      hole.
 *
 * ── AND THE POSITIVE CONTROL, WHICH IS THE PART v4 LACKED ──
 *
 * A census that refuses everything would satisfy every rule above while proving
 * nothing. So this file also asserts the census ACCEPTS the legitimate writers
 * it must accept — the `last_seen_at` touch and the revocation statements —
 * and that they are really present in the tree. A rule nothing satisfies is not
 * a rule; it is an outage waiting for its first maintainer.
 *
 * Named red-proof targets (driver: `backend/scripts/w3-red-proofs.js`):
 *   - a SECOND production INSERT anywhere        -> census fails, naming it
 *   - any statement that sets `role_snapshot`    -> census fails, naming it
 *   - the MINT INPUT accepting a role snapshot   -> the contract test below
 *     fails, while the code still compiles and every behavioural test stays
 *     green (round-2 R3 B1: the previous third mutation proved the sink rule
 *     twice and left the contract untested; round-3 R3 B1: the first contract
 *     test was a lexical scan an index signature walked straight past, so it
 *     asks the TYPE CHECKER now)
 */
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import * as ts from 'typescript';

const BACKEND = path.resolve(__dirname, '..', '..');
const SRC = path.join(BACKEND, 'src');

/** The mint. Named once, here, so every rule below can refer to it. */
const MINT_FILE = path.join('src', 'services', 'LoginSessionService.ts');
const MINT_FUNCTION = 'mint';

/**
 * The lifecycle updates this table is permitted to receive, by the EXACT set of
 * columns each may set. A statement whose columns are not one of these sets
 * fails the census by name — including a statement that merely adds a column to
 * an otherwise legitimate update.
 */
const PERMITTED_UPDATE_COLUMN_SETS: Array<{ name: string; columns: string[] }> = [
  { name: 'liveness touch', columns: ['last_seen_at'] },
  {
    // SSO-R16 binds ID-token disposal to login-session death, so the retained
    // token is dropped in the SAME statement that revokes it. Splitting that
    // out would create a retention window nobody declared.
    name: 'revocation',
    columns: ['revoked_at', 'revoke_reason', 'id_token_ct', 'id_token_key_id'],
  },
  {
    // Review R2 finding F1: a login session also dies by ABSOLUTE EXPIRY and by
    // IDLE TIMEOUT, and those deaths write nothing — `resolve` simply stops
    // returning the row. Their disposal therefore cannot ride a revocation
    // statement and needs its own permitted set.
    //
    // THIS CENSUS COULD NOT HAVE FOUND THAT GAP, and the limitation is worth
    // stating where the rule lives: a census over update column sets observes
    // the updates that EXIST. A death that performs no update at all is
    // invisible to it. That is why the expiry disposal carries a BEHAVIOURAL
    // proof in scripts/test-w3-group-sync-live.js rather than a census row —
    // absence of a write is not a property a write census can decide.
    name: 'retained-token disposal on a dead login session',
    columns: ['id_token_ct', 'id_token_key_id'],
  },
];

/** Excluded from the production census — and censused separately below. */
const EXCLUDED_DIRECTORIES = ['__tests__', 'migrations'];

interface Statement {
  file: string;
  line: number;
  verb: 'INSERT' | 'UPDATE';
  /** The column names the statement writes. */
  columns: string[];
  text: string;
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.includes(entry.name)) continue;
      walk(full, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Split an `INSERT INTO auth_sessions (...)` column list. */
function insertColumns(text: string): string[] {
  const match = /INSERT\s+INTO\s+auth_sessions\s*\(([^)]*)\)/i.exec(text);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
}

/** Split an `UPDATE auth_sessions SET a = x, b = y WHERE ...` column list. */
function updateColumns(text: string): string[] {
  const match = /UPDATE\s+auth_sessions\s+SET\s+([\s\S]*?)(?:\bWHERE\b|$)/i.exec(text);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((assignment) => assignment.trim().split(/\s*=/)[0].trim())
    .filter((column) => column.length > 0 && /^[a-z_]+$/i.test(column));
}

/**
 * Every production statement that WRITES `auth_sessions`.
 *
 * The scan reads the statement text from the source rather than the AST because
 * the SQL lives in template literals either way; what matters is that the
 * universe is the whole production tree, so an unenumerated write cannot be
 * absent from both the observed set and the model.
 */
function censusOf(files: string[]): Statement[] {
  const statements: Statement[] = [];
  for (const file of files) {
    const relative = path.relative(BACKEND, file);
    const source = withoutComments(fs.readFileSync(file, 'utf8'));
    const lines = source.split('\n');
    const pattern = /(INSERT\s+INTO|UPDATE)\s+auth_sessions/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const verb = /INSERT/i.test(match[1]) ? 'INSERT' : 'UPDATE';
      const line = source.slice(0, match.index).split('\n').length;
      // Enough text to carry the whole statement, whichever form it takes.
      const text = source.slice(match.index, match.index + 700);
      statements.push({
        file: relative,
        line,
        verb,
        columns: verb === 'INSERT' ? insertColumns(text) : updateColumns(text),
        text: lines[line - 1]?.trim() ?? '',
      });
    }
  }
  return statements;
}

const productionFiles = walk(SRC);
const production = censusOf(productionFiles);

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

describe('SS-9 · the auth_sessions write census', () => {
  test('the census observes a NON-EMPTY universe (the scan itself is not broken)', () => {
    expect(productionFiles.length).toBeGreaterThan(50);
    expect(production.length).toBeGreaterThan(0);
  });

  test('exactly ONE production INSERT into auth_sessions, and it is the typed mint', () => {
    const inserts = production.filter((statement) => statement.verb === 'INSERT');
    const named = inserts.map((statement) => `${statement.file}:${statement.line}`);
    expect(named).toEqual([expect.stringContaining(MINT_FILE.replace(/\\/g, '/'))]);
    expect(inserts).toHaveLength(1);

    // ...and it really is inside the mint, not merely in the same file.
    const source = withoutComments(fs.readFileSync(path.join(BACKEND, MINT_FILE), 'utf8'));
    const mintIndex = source.indexOf(`${MINT_FUNCTION}(input`);
    const insertIndex = source.indexOf('INSERT INTO auth_sessions');
    expect(mintIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(mintIndex);
  });

  test('NO production statement writes role_snapshot — not even the mint (SS-9)', () => {
    const offenders = production
      .filter((statement) => statement.columns.some((column) => column.toLowerCase() === 'role_snapshot'))
      .map((statement) => `${statement.file}:${statement.line} (${statement.verb})`);
    expect(offenders).toEqual([]);
  });

  test('every production UPDATE writes one of the enumerated lifecycle column sets', () => {
    const offenders = production
      .filter((statement) => statement.verb === 'UPDATE')
      .filter((statement) => !PERMITTED_UPDATE_COLUMN_SETS.some((permitted) => sameSet(statement.columns, permitted.columns)))
      .map((statement) => `${statement.file}:${statement.line} sets [${statement.columns.join(', ')}]`);
    expect(offenders).toEqual([]);
  });

  // ── the POSITIVE CONTROL: the census is satisfiable, not merely strict ────
  test('the legitimate lifecycle writers are PRESENT and ACCEPTED', () => {
    const updates = production.filter((statement) => statement.verb === 'UPDATE');
    for (const permitted of PERMITTED_UPDATE_COLUMN_SETS) {
      const matching = updates.filter((statement) => sameSet(statement.columns, permitted.columns));
      // A permitted set that nothing in the tree satisfies would make the rule
      // above vacuous: it would pass by refusing a population of zero.
      expect(matching.length).toBeGreaterThan(0);
    }
    // And the mint's own INSERT is accepted, carrying the columns W2 added.
    const mint = production.find((statement) => statement.verb === 'INSERT');
    expect(mint?.columns).toEqual(expect.arrayContaining(['principal_id', 'token_hash', 'identity_provider_id', 'identity_link_id']));
  });

  /**
   * ── THE MINT-INPUT CONTRACT — the third mutation the annex actually asks for ──
   *
   * Annex §11 SS-W3 names three mutations, and the third is **"the mint
   * accepting a non-NULL snapshot -> its CONTRACT TEST fails"**. Round-2 review
   * R3 finding B1 showed that W3's third mutation was not that at all: it added
   * `role_snapshot` to the mint's INSERT column list, which is a second proof of
   * the SINK rule M-ss9.2 already proves. The reviewer then demonstrated the
   * hole directly — adding `roleSnapshot?: string | null` to the typed mint
   * input, leaving the implementation untouched, kept 22/22 tests green.
   *
   * The gap is real and it is a TYPE-level one: a snapshot the mint ACCEPTS but
   * ignores changes no SQL and no runtime behaviour, so no behavioural test and
   * no sink census can see it. What it does is re-open the door SS-9 closed —
   * the next caller to pass the field would be writing a claim-derived role into
   * a login session, and the contract would have invited them.
   *
   * So the contract is asserted where it lives: the mint's own input type.
   */
  test('EVERY callable signature of the mint refuses a role snapshot (SS-9 contract)', () => {
    // Asked of the TYPE CHECKER, and asked of EVERY SIGNATURE. Three rounds of
    // review took this control apart in three different ways, and each answer
    // was narrower than the rule it was meant to enforce:
    //
    //   round 2 (R3 B1): the third mutation added the column to the mint INSERT,
    //     which is the SINK rule another mutation already proved;
    //   round 3 (R3 B1): the replacement scanned the source for four member
    //     spellings, and `[key: string]: unknown` declares no member while
    //     accepting every one;
    //   round 4 (R3 B1): asking the checker for ONE declaration missed an
    //     OVERLOAD. `mint<T extends { principalId: string }>(input: T)` exposes
    //     only `principalId` and no index signature, so both questions answered
    //     clean while a real call passed `roleSnapshot: 'admin'` through it.
    //
    // The rule SS-9 actually needs is that the mint is CLOSED: no callable
    // signature of it may admit an undeclared key. So the test enumerates every
    // call signature the checker exposes and requires each one's input to be a
    // closed object type — which is a property of the contract rather than of
    // any one way of writing it.
    const config = ts.readConfigFile(path.join(BACKEND, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, BACKEND);
    const mintPath = path.join(BACKEND, MINT_FILE);
    const program = ts.createProgram([mintPath], { ...parsed.options, noEmit: true });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(mintPath);
    expect(source).toBeDefined();

    // ── ANCHORED ON THE EXPORTED SURFACE, NOT THE CLASS DECLARATION ──
    //
    // Round-5 review R3 finding B1: the previous form walked `MethodDeclaration`
    // nodes named `mint` inside the class. Production consumers do not call the
    // class — they call `loginSessionService.mint`, and the type of that export
    // can be WIDER than the class body. The reviewer annotated the exported
    // singleton with an interface adding
    // `mint<T extends { principalId: string }>(input: T)`, called it with
    // `roleSnapshot: 'admin'`, and watched it compile while this test stayed
    // green — 2 suites, 8 tests, exit 0.
    //
    // So the contract is taken from the EXPORT, which is the surface the rule is
    // about. Whatever declares it — the class, an interface, an intersection, an
    // overload set — the checker resolves it to the signatures a caller can
    // reach, and every one of them must be closed.
    const exportSymbol = checker
      .getExportsOfModule(checker.getSymbolAtLocation(source!)!)
      .find((symbol) => symbol.getName() === 'loginSessionService');
    expect(exportSymbol).toBeDefined();

    const serviceType = checker.getTypeOfSymbolAtLocation(exportSymbol!, source!);
    const mintSymbol = serviceType.getProperty(MINT_FUNCTION);
    expect(mintSymbol).toBeDefined();

    const mintType = checker.getTypeOfSymbolAtLocation(mintSymbol!, source!);
    const signatures = mintType.getCallSignatures();
    expect(signatures.length).toBeGreaterThan(0);

    const offences: string[] = [];
    for (const [index, signature] of signatures.entries()) {
      const parameters = signature.getParameters();
      if (parameters.length === 0) {
        offences.push(`signature ${index}: takes no input to constrain`);
        continue;
      }
      const declaration = parameters[0].valueDeclaration ?? parameters[0].declarations?.[0];
      const inputType = checker.getTypeOfSymbolAtLocation(parameters[0], declaration ?? source!);

      // An OPEN input — a type parameter, `any`, `unknown`, or anything
      // carrying an index signature — accepts arbitrary keys including the
      // withdrawn one, while declaring none of them.
      const open =
        (inputType.flags & ts.TypeFlags.TypeParameter) !== 0 ||
        (inputType.flags & ts.TypeFlags.Any) !== 0 ||
        (inputType.flags & ts.TypeFlags.Unknown) !== 0 ||
        checker.getIndexInfoOfType(inputType, ts.IndexKind.String) !== undefined ||
        checker.getIndexInfoOfType(inputType, ts.IndexKind.Number) !== undefined;
      if (open) {
        offences.push(`signature ${index}: input is OPEN (${checker.typeToString(inputType)}) and admits undeclared keys`);
        continue;
      }

      const members = inputType.getProperties().map((symbol) => symbol.getName());
      const forbidden = members.filter((name) => /role|snapshot/i.test(name));
      if (forbidden.length > 0) {
        offences.push(`signature ${index}: declares ${forbidden.join(', ')}`);
      }
      // A closed input must actually describe the mint, not be empty.
      if (members.length < 2) {
        offences.push(`signature ${index}: input declares almost nothing (${members.join(', ') || 'none'})`);
      }
    }
    expect(offences).toEqual([]);
  });

  // ── the exclusions, as a VISIBLE LIST rather than a silent hole ───────────
  test('migrations and test fixtures are censused separately, and named', () => {
    const excludedRoots = [path.join(SRC, 'migrations'), path.join(SRC, '__tests__')]
      .filter((dir) => fs.existsSync(dir));
    expect(excludedRoots.length).toBe(2);

    const excludedFiles: string[] = [];
    for (const root of excludedRoots) {
      const stack = [root];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name.endsWith('.ts') || entry.name.endsWith('.sql')) excludedFiles.push(full);
        }
      }
    }

    const excludedWriters = excludedFiles
      .filter((file) => /(INSERT\s+INTO|UPDATE)\s+auth_sessions/i.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(BACKEND, file).replace(/\\/g, '/'));

    // The census does not FORBID these — a migration must create the table and
    // a fixture must be able to seed one. It records them, so that the boundary
    // between "production writer" and "excluded" is a list a reviewer can read
    // rather than an absence they have to notice.
    expect(Array.isArray(excludedWriters)).toBe(true);
    for (const file of excludedWriters) {
      expect(file.startsWith('src/migrations/') || file.startsWith('src/__tests__/')).toBe(true);
    }
  });
});
// ═════════════════════════════════════════════════════════════════════════════
// SS-9 · THE IMPORTER AND RE-EXPORT CENSUS  (card `007ddf39`)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Round-6 review R2 built a SECOND production module that imports the
 * `loginSessionService` singleton, widens it through an interface with an `as`
 * assertion, and re-exports the widened value; a consumer of that re-export
 * passed `roleSnapshot` and compiled clean. Every rule of the write census
 * above stayed green, and correctly so: the contract test asks the DEFINING
 * module's export, and the construction never touches it — it publishes a
 * second surface beside it.
 *
 * Owner disposition `ec580913` §2 ruled that finding HARDENING rather than
 * blocking, and recorded the repair shape this block implements: enumerate
 * every production module importing the singleton behind a VISIBLE ALLOWLIST,
 * and forbid widening re-exports and type assertions over it, drilled in BOTH
 * directions.
 *
 * ── THE RULE, AND THE TWO REVIEWS THAT SHAPED IT ──
 *
 * The first form asked whether an export REDUCED to the singleton. Round-3
 * review broke it in one line, with no assertion and no `any`:
 *
 *     export const holder = { current: loginSessionService };
 *
 * The second form asked whether the singleton was REACHABLE in an exported
 * value's construction. Round-4 review broke that too, with two shapes that are
 * not constructions at all:
 *
 *     export const holder: { current?: typeof loginSessionService } = {};
 *     holder.current = loginSessionService;
 *     Object.defineProperty(holder, 'current', { value: loginSessionService });
 *
 * Both times the repair chased the shape that had been demonstrated, and both
 * times a shape beside it survived. The third form does not enumerate shapes at
 * all. It asks WHERE, and the tree answers it exactly:
 *
 *   **Outside the definer, the singleton may be referenced at MODULE-EVALUATION
 *   level only by the import that brings it in.**
 *
 * Measured before it was written: across all 172 production modules there are
 * exactly seven module-evaluation-level references to the singleton, and every
 * one of them is the import specifier. Every real use — `resolve` in the REST
 * ingress, `mint` on an admitted federated login, `revoke` on logout — happens
 * inside a function body. So the rule costs the tree nothing and refuses the
 * whole family at once: containers, arrays, wrappers, class fields, late
 * assignment, `Object.defineProperty`, re-exports of every spelling, and
 * assertions at module level. There are no shape branches left to add, and
 * therefore none left to forget.
 *
 * ── WHERE THIS STOPS, WHICH IS THE OWNER'S LINE AND NOT A CONVENIENCE ──
 *
 * Inside a function body it stops. That is where
 * `(input: any) => loginSessionService.mint(input)` lives, and disposition
 * `ec580913` §2 ground 3 records that class as unclosable at the type layer by
 * anyone. Round-4 review confirmed the boundary behaves as ruled by getting an
 * object getter and a `Proxy` get-trap through, and classified both as
 * observations for exactly that reason. It is also where every ordinary call
 * lives, so a rule that reached inside would flag the whole allowlist and be
 * deleted by the first engineer it blocked.
 *
 * Two things stand where this block stops, and both are already here:
 *
 *   1. the SAFETY property is held at the SINK by the write census above, which
 *      does not care what type a caller believed it was holding: the mint's
 *      INSERT carries a fixed column list, and no production statement writes
 *      `role_snapshot`;
 *   2. the POPULATION is held by the allowlist below. A laundering module has
 *      to import the singleton in order to launder it, so it arrives as a diff
 *      to a list a reviewer reads.
 *
 * ── ONE PATH THIS DOES NOT SEE, NAMED RATHER THAN LEFT TO BE FOUND ──
 *
 * `require('../services/LoginSessionService').loginSessionService` at module
 * level resolves to `any`, so no symbol links it back to the singleton and no
 * rule here sees it. That is not an oversight and not a new class: `require`
 * RETURNS `any`, and `any` is the exact form disposition `ec580913` §2 ground 3
 * records as unclosable at the type layer by anyone. It is written down so a
 * reader knows it was weighed rather than missed, and so the next review can
 * spend its time on the shapes that are still open. The write census above is
 * what holds the property if someone ever writes it.
 *
 * ── AND WHY EVERY RULE IS ASKED OF THE TYPE CHECKER ──
 *
 * A scan for the TEXT `loginSessionService` falls to
 * `import { loginSessionService as ls }` in one line. So every rule below
 * resolves identifiers to SYMBOLS: the singleton is recognised by identity
 * rather than by spelling.
 */

/** The module that DEFINES the singleton — the only one permitted to export it. */
const DEFINER = path.join(BACKEND, MINT_FILE);
const SINGLETON = 'loginSessionService';

/**
 * Every production module permitted to reach the singleton, and why it does.
 *
 * This list is the part that carries the class the type layer cannot close. The
 * rules below refuse every module-evaluation-level hand-off; they cannot refuse
 * a module that calls the singleton inside a function, and are not meant to.
 * What they can do is make the population VISIBLE, so that a new module
 * reaching for the mint arrives as a line a reviewer has to approve rather than
 * as an import nobody was shown.
 */
const PERMITTED_SINGLETON_IMPORTERS: Array<{ module: string; because: string }> = [
  { module: 'src/middleware/auth.ts', because: 'the REST ingress resolves the login-session cookie and touches liveness' },
  { module: 'src/routes/auth.ts', because: 'the local login and logout routes mint, revoke and list login sessions' },
  { module: 'src/routes/sso.ts', because: 'the federated callback resolves the login-session cookie it has just set' },
  { module: 'src/server.ts', because: 'boot schedules the retained-token disposal sweep (SSO-R16)' },
  { module: 'src/services/identity/SsoAuthenticationService.ts', because: 'an admitted federated login mints the login session' },
  { module: 'src/services/identity/SsoLogoutService.ts', because: 'back-channel logout revokes the named login session' },
  // RH-P5.SSO.W4 candidate B (AZ-A4 clause 2): a deprovision signal disables the
  // Account and revokes its login sessions with disabled_user, so the retained
  // ID token is disposed with them (SSO-R16). It mints nothing.
  { module: 'src/services/identity/ScimProvisioningService.ts', because: 'the SCIM deprovision signal revokes the login sessions of the Account it disabled' },
  { module: 'src/services/websocket.ts', because: 'the socket upgrade authenticates from the login-session cookie' },
];

/**
 * The heap the whole-tree scan below needs, in MiB.
 *
 * Measured, not guessed: 512 aborts, 576 passes, and the margin to 640 is
 * deliberate so a marginal environment fails the check rather than the
 * allocator. Raising this number is a real cost and should be noticed.
 */
const REQUIRED_HEAP_MB = 640;

const posix = (absolute: string) => path.relative(BACKEND, absolute).split(path.sep).join('/');
const samePath = (a: string, b: string) => path.normalize(a) === path.normalize(b);

interface SurfaceScan {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** The singleton's own symbol — the identity every rule below compares against. */
  singleton: ts.Symbol;
  /** The modules this scan judges. The definer is always resolvable, never judged. */
  files: string[];
}

/**
 * A scan over `scanned`, plus any VIRTUAL modules given as absolute path ->
 * source text.
 *
 * The virtual half is what lets the known-answer oracle at the bottom of this
 * block run the SAME functions the production rules run, over modules that are
 * never written to disk and never committed. A control whose detector is only
 * ever pointed at a clean tree cannot tell "nothing is wrong" from "the
 * detector is broken"; this one is asked both questions on every run.
 */
function scanOf(scanned: string[], virtual: Map<string, string> = new Map()): SurfaceScan {
  const config = ts.readConfigFile(path.join(BACKEND, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, BACKEND);
  // `noEmit` plus the three emit-shaped flags OFF. Nothing here emits anything,
  // and carrying `declaration`/`declarationMap`/`sourceMap` through cost this
  // scan about 60 MiB of heap for output it never produces.
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  };

  // `setParentNodes` is OFF for the real tree. Every position this file asks
  // for is asked WITH its source file, and the one rule that needs to know a
  // node's parent carries it down its own traversal rather than reading
  // `node.parent` — so building parent pointers for 172 modules is pure heap.
  // The virtual modules below keep them: there are a handful, and they cost
  // nothing.
  const host = ts.createCompilerHost(options, false);
  if (virtual.size > 0) {
    const readReal = host.readFile.bind(host);
    const existsReal = host.fileExists.bind(host);
    const getReal = host.getSourceFile.bind(host);
    host.readFile = (name) => virtual.get(path.normalize(name)) ?? readReal(name);
    host.fileExists = (name) => virtual.has(path.normalize(name)) || existsReal(name);
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
      const source = virtual.get(path.normalize(name));
      return source === undefined
        ? getReal(name, languageVersion, onError, shouldCreate)
        : ts.createSourceFile(name, source, languageVersion, true);
    };
  }

  const program = ts.createProgram([...scanned, DEFINER, ...virtual.keys()], options, host);
  const checker = program.getTypeChecker();
  const definer = program.getSourceFile(DEFINER);
  if (!definer) throw new Error(`the definer did not load: ${DEFINER}`);
  const moduleSymbol = checker.getSymbolAtLocation(definer);
  if (!moduleSymbol) throw new Error('the definer resolved to no module symbol');
  const singleton = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.getName() === SINGLETON);
  if (!singleton) throw new Error(`the definer does not export ${SINGLETON}`);
  return { program, checker, singleton, files: [...scanned, ...virtual.keys()] };
}

/** Follow an import/export alias chain to the thing it actually names. */
function unalias(scan: SurfaceScan, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  let current = symbol;
  for (let hop = 0; hop < 8 && current && (current.flags & ts.SymbolFlags.Alias) !== 0; hop += 1) {
    let next: ts.Symbol | undefined;
    try {
      next = scan.checker.getAliasedSymbol(current);
    } catch {
      next = undefined;
    }
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

/** Is this identifier the singleton itself, under whatever name it was given? */
function namesSingleton(scan: SurfaceScan, node: ts.Node): boolean {
  return ts.isIdentifier(node) && unalias(scan, scan.checker.getSymbolAtLocation(node)) === scan.singleton;
}

/**
 * Does this expression REDUCE to the singleton ITSELF?
 *
 * Reduction strips exactly the constructions that change what the compiler
 * BELIEVES about a value while leaving the value itself alone — parentheses,
 * `as`, an angle-bracket assertion, `satisfies`, the non-null `!` — and then
 * follows local `const` aliases.
 *
 * This is the ASSERTION rule's predicate, and that rule is about an assertion
 * applied TO the singleton, so "reduces to it" is exactly the question. Every
 * branch here has its own known-answer vector in the oracle, because round-4
 * review showed that four of them could be deleted with the whole suite staying
 * green — a predicate whose branches nothing exercises is four unproven claims
 * wearing one proven one's clothes.
 */
function reducesToSingleton(scan: SurfaceScan, node: ts.Node | undefined, depth = 0): boolean {
  if (!node || depth > 12) return false;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return reducesToSingleton(scan, node.expression, depth + 1);
  }
  if (ts.isIdentifier(node)) {
    if (namesSingleton(scan, node)) return true;
    const symbol = unalias(scan, scan.checker.getSymbolAtLocation(node));
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && reducesToSingleton(scan, declaration.initializer, depth + 1)) {
        return true;
      }
    }
  }
  return false;
}

interface ModuleEvaluationCensus {
  /** The import specifiers that bring the singleton in — the one admitted form. */
  admitted: string[];
  /** Every other module-evaluation-level reference, which is a hand-off. */
  refused: string[];
}

/**
 * Every reference to the singleton OUTSIDE a function body, in a module other
 * than the definer, split into the one admitted form and everything else.
 *
 * The traversal carries the parent down rather than reading `node.parent`,
 * because parent pointers are deliberately not built for the production tree
 * (see `scanOf`). It stops descending at every function-like node, which is the
 * ruled boundary and also the reason the rule costs the tree nothing.
 */
function moduleEvaluationCensus(scan: SurfaceScan): ModuleEvaluationCensus {
  const admitted: string[] = [];
  const refused: string[] = [];
  const seenAdmitted = new Set<string>();
  const seenRefused = new Set<string>();
  for (const file of scan.files) {
    if (samePath(file, DEFINER)) continue;
    const source = scan.program.getSourceFile(file);
    if (!source) continue;
    const visit = (node: ts.Node, insideFunction: boolean, insideType: boolean, parent: ts.Node | undefined): void => {
      if (ts.isFunctionLike(node)) {
        // The owner-ruled boundary. Everything past here is the class the
        // design answers with the statement-level write census above.
        ts.forEachChild(node, (child) => visit(child, true, insideType, node));
        return;
      }
      // A TYPE position is not a hand-off and cannot become one: types are
      // erased, so `let held: typeof loginSessionService` gives a consumer
      // nothing. Flagging it would be the over-reach that gets a rule deleted,
      // and it costs no detection — the two module-evaluation shapes round-4
      // review found DECLARE themselves with exactly that annotation and are
      // still caught, by the assignment that follows it.
      const nowInsideType = insideType || ts.isTypeNode(node);
      if (!insideFunction && !nowInsideType && namesSingleton(scan, node)) {
        const where = `${posix(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        // The ONE admitted form is the import specifier that brings it in —
        // which is exactly what the allowlist above governs. An EXPORT
        // specifier is not an import specifier, and that distinction is
        // drilled by M-ss9.19.
        //
        // It used to admit `ImportClause` and `NamespaceImport` too, and
        // round-5 review showed both could be deleted with all sixteen tests
        // still green. They were unreachable rather than merely undrilled: a
        // default import cannot name the singleton, because the definer has no
        // default export, and a namespace import binds the MODULE — a
        // module-evaluation use of `m.loginSessionService` resolves through a
        // property access, whose parent is not a namespace import, so it is
        // refused exactly as it should be. Dead structure inside the one
        // admitted form is an unproven claim in the most dangerous position
        // this rule has, so it is deleted rather than given a vector.
        const isImportBinding = !!parent && ts.isImportSpecifier(parent);
        (isImportBinding ? seenAdmitted : seenRefused).add(where);
      }
      ts.forEachChild(node, (child) => visit(child, insideFunction, nowInsideType, node));
    };
    visit(source, false, false, undefined);
  }
  admitted.push(...seenAdmitted);
  refused.push(...seenRefused);
  return { admitted: admitted.sort(), refused: refused.sort() };
}

/** Every type assertion in the scan that is applied to the singleton. */
function assertionsOverSingleton(scan: SurfaceScan): string[] {
  const findings = new Set<string>();
  for (const file of scan.files) {
    const source = scan.program.getSourceFile(file);
    if (!source) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
        if (reducesToSingleton(scan, node.expression)) {
          findings.add(`${posix(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...findings].sort();
}

interface AllowlistFindings {
  /** Modules that reach the singleton and are not on the list. */
  unlisted: string[];
  /** Listed modules that no longer reach it — the list rotting. */
  stale: string[];
  /** Listed modules whose entry carries no reason — the list going mute. */
  reasonless: string[];
  /**
   * The two POPULATIONS the rules were actually answered over, reported back so
   * the caller can prove it handed over the real ones. See the seam note below.
   */
  listed: string[];
  observed: string[];
}

/**
 * The three allowlist rules, as ONE PURE FUNCTION over (list, observed).
 *
 * ── WHY IT IS A FUNCTION AND NOT THREE INLINE EXPECTATIONS ──
 *
 * Round-6 review removed the reason predicate AND blanked an entry's reason,
 * and the whole census stayed green: nothing else in the file notices a mute
 * entry, so the rule could be deleted and violated in the same breath without a
 * single test moving. It was the last claim in this block with no known-answer
 * vector behind it.
 *
 * The reason it had none is structural rather than careless. The other rules
 * are drilled by mutating the DETECTOR and watching a fixture redden, but these
 * three are about the LIST, and the tree has no bad list to observe — every
 * entry is listed, live and reasoned. A rule whose violation never occurs
 * cannot be proven against the tree at all; it has to be handed a bad list.
 *
 * So the rules take their inputs as arguments, and the oracle below hands them
 * exactly that: a list carrying one of each defect, and one entry that is
 * perfectly fine. Removing any predicate now costs a named line.
 */
function allowlistFindings(
  permitted: Array<{ module: string; because: string }>,
  reachingModules: string[],
): AllowlistFindings {
  const listed = new Set(permitted.map((entry) => entry.module));
  const observed = new Set(reachingModules);
  return {
    unlisted: reachingModules.filter((module) => !listed.has(module)).sort(),
    stale: permitted.map((entry) => entry.module).filter((module) => !observed.has(module)).sort(),
    reasonless: permitted.filter((entry) => entry.because.trim().length === 0).map((entry) => entry.module).sort(),
    listed: [...listed].sort(),
    observed: [...observed].sort(),
  };
}

/**
 * Every module in the scan, other than the definer, that reaches the singleton
 * ANYWHERE — inside function bodies included, because the allowlist is about
 * who holds it at all, not about where they use it.
 */
function modulesReachingSingleton(scan: SurfaceScan): string[] {
  const reaching: string[] = [];
  for (const file of scan.files) {
    if (samePath(file, DEFINER)) continue;
    const source = scan.program.getSourceFile(file);
    if (!source) continue;
    let reaches = false;
    const visit = (node: ts.Node): void => {
      if (reaches) return;
      if (namesSingleton(scan, node)) {
        reaches = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (reaches) reaching.push(posix(file));
  }
  return reaching.sort();
}

/**
 * ── THE KNOWN-ANSWER ORACLE ──
 *
 * Modules that are never written to disk, held in memory and compiled against
 * the REAL definer. Each carries a construction with a known answer, and they
 * are run through the same functions the production rules use — so a detector
 * weakened until the tree agrees with it reddens here instead of passing
 * quietly, which is the failure a census over a clean tree cannot otherwise
 * distinguish from success.
 *
 * Round-4 review's control finding is why `assertedForms` exists: it showed
 * that four of the reduction's five wrapper branches could be deleted with
 * every vector still green. Each branch now has a line that needs it.
 */
const ORACLE_DIR = path.join(SRC, '__ss9_importer_oracle__');
const ORACLE_WIDENED = path.join(ORACLE_DIR, 'widened.ts');
const ORACLE_RENAMED = path.join(ORACLE_DIR, 'renamed.ts');
const ORACLE_ALIASED = path.join(ORACLE_DIR, 'aliased.ts');
const ORACLE_HELD = path.join(ORACLE_DIR, 'held.ts');
const ORACLE_COLLECTED = path.join(ORACLE_DIR, 'collected.ts');
const ORACLE_LATE = path.join(ORACLE_DIR, 'late.ts');
const ORACLE_DEFINED = path.join(ORACLE_DIR, 'defined.ts');
const ORACLE_STATIC = path.join(ORACLE_DIR, 'staticField.ts');
const ORACLE_ASSERTED_FORMS = path.join(ORACLE_DIR, 'assertedForms.ts');
const ORACLE_ORDINARY = path.join(ORACLE_DIR, 'ordinary.ts');

const ORACLE_MODULES = new Map<string, string>([
  [
    // Round-6 review R2's construction, reproduced as it was filed.
    ORACLE_WIDENED,
    `import { loginSessionService, MintedLoginSession } from '../services/LoginSessionService';

interface WidenedLoginSessions {
  mint<T extends { principalId: string }>(input: T): Promise<MintedLoginSession>;
}

export const widenedLoginSessions = loginSessionService as unknown as WidenedLoginSessions;
`,
  ],
  [
    // A plain rename on the way out: no assertion at all, so a rule that keyed
    // on `as` would let the singleton straight through. It is also the vector
    // that keeps the import carve-out honest — an EXPORT specifier must not be
    // mistaken for the import that brings the singleton in.
    ORACLE_RENAMED,
    `export { loginSessionService as loginSessions } from '../services/LoginSessionService';
`,
  ],
  [
    // A local alias, then an export of the alias.
    ORACLE_ALIASED,
    `import { loginSessionService } from '../services/LoginSessionService';

const held = loginSessionService;

export const handedOut = held;
`,
  ],
  [
    // Round-3 review's evasion, reproduced as it was written: no assertion, no
    // `any`, just a container.
    ORACLE_HELD,
    `import { loginSessionService } from '../services/LoginSessionService';

export const heldSingleton = { current: loginSessionService };
`,
  ],
  [
    // A sibling of it that no review demonstrated — an array, through an alias.
    ORACLE_COLLECTED,
    `import { loginSessionService } from '../services/LoginSessionService';

const registry = [loginSessionService];

export const collected = registry;
`,
  ],
  [
    // Round-4 review's first evasion: the hand-off is not in the initializer at
    // all, it is a statement after it. No construction-shaped rule can see this.
    ORACLE_LATE,
    `import { loginSessionService } from '../services/LoginSessionService';

export const late: { current?: typeof loginSessionService } = {};

late.current = loginSessionService;
`,
  ],
  [
    // Round-4 review's second evasion, same move through the reflection API.
    ORACLE_DEFINED,
    `import { loginSessionService } from '../services/LoginSessionService';

export const defined: { current?: typeof loginSessionService } = {};

Object.defineProperty(defined, 'current', { value: loginSessionService });
`,
  ],
  [
    // A class field, which is a module-evaluation-level write wearing a
    // declaration's clothes. Round-4 review found the previous rule's class
    // traversal could be removed with everything still green; this is the
    // vector that makes it load-bearing.
    ORACLE_STATIC,
    `import { loginSessionService } from '../services/LoginSessionService';

export class StaticHolder {
  static current = loginSessionService;
}
`,
  ],
  [
    // ONE LINE PER REDUCTION BRANCH — and the last three lines are the ones
    // that took two rounds to get right.
    //
    // Round-4 review deleted four wrapper branches and watched every vector
    // stay green. The first repair added a direct line for each, and round-5
    // review showed THREE of them were still not load-bearing: the assertion
    // scan visits every nested assertion node in its own right, so
    // `loginSessionService satisfies object` reduces straight from the
    // identifier without ever needing the `satisfies` branch. A direct line
    // exercises the SCAN, not the branch.
    //
    // A branch is only needed when a wrapper sits INSIDE something else being
    // reduced — which is what the three `nested*` exports do: each asserts over
    // a local whose initializer is one of the wrapped forms, so reducing it has
    // to step through that branch to reach the singleton. Delete the branch and
    // that line, and only that line, disappears from the list below.
    ORACLE_ASSERTED_FORMS,
    `import { loginSessionService } from '../services/LoginSessionService';

const aliased = loginSessionService;
const wrappedInAs = loginSessionService as unknown;
const wrappedInSatisfies = loginSessionService satisfies object;
const wrappedInAngle = <unknown>loginSessionService;

export const throughAlias = aliased as unknown as { mint(input: unknown): Promise<unknown> };
export const throughParens = (loginSessionService) as unknown;
export const throughNonNull = loginSessionService! as unknown;
export const throughSatisfies = loginSessionService satisfies object;
export const throughAngle = <unknown>loginSessionService;
export const nestedAs = wrappedInAs as unknown;
export const nestedSatisfies = wrappedInSatisfies as unknown;
export const nestedAngle = wrappedInAngle as unknown;
`,
  ],
  [
    // The GREEN direction: an ordinary import, called inside a function and
    // never handed out. The allowlist must see it; the module-evaluation rule
    // and the assertion rule must not.
    ORACLE_ORDINARY,
    `import { loginSessionService } from '../services/LoginSessionService';

export async function resolveOrdinarily(token: string): Promise<boolean> {
  const found = await loginSessionService.resolve(token);
  return Boolean(found);
}
`,
  ],
]);

describe('SS-9 · the loginSessionService importer and re-export census', () => {
  /**
   * Both scans are run HERE and only their RESULTS are kept.
   *
   * A `ts.Program` over the production tree is by far the largest object this
   * file allocates, and holding two of them alive at once made the suite need
   * more than 512 MiB of heap. Each scan lives in its own block and is
   * unreachable before the next one is built, and the tests below read plain
   * arrays.
   */
  let universe = 0;
  let singletonName = '';
  let reaching: string[] = [];
  let admitted: string[] = [];
  let refused: string[] = [];
  let assertions: string[] = [];
  let oracleRefused: string[] = [];
  let oracleAssertions: string[] = [];
  let oracleReaching: string[] = [];

  beforeAll(() => {
    // ── THE HEAP THIS COSTS, NAMED RATHER THAN HIT ──
    //
    // Type-checking the whole production tree is what closes the universe, and
    // it is not free: this block needs roughly 640 MiB, where the write census
    // above and `tsc --noEmit` itself both fit inside 512. The extra is
    // structural — a second TypeScript program inside a jest worker that is
    // already holding ts-jest's own compiler state.
    //
    // Under a smaller cap V8 aborts the worker, and an OOM abort is a terrible
    // way to learn that: round-1 review read the crash as an environment fault
    // and spent a round on it. So the requirement is CHECKED and NAMED, and the
    // block fails as a test with a reason instead. A control that cannot run
    // must not report green, and it must say why.
    //
    // The structural repair — running this scan in its own process, the way
    // `w2-conformance-gate.js` and `w3-naming-audit.py` already do — is carded.
    const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
    if (heapLimitMb < REQUIRED_HEAP_MB) {
      throw new Error(
        `the importer census needs about ${REQUIRED_HEAP_MB} MiB of heap and this process has ${heapLimitMb} MiB. `
        + 'Raise it with NODE_OPTIONS=--max-old-space-size, or run the suite with no cap at all.',
      );
    }
    {
      const production = scanOf(productionFiles);
      universe = production.files.length;
      singletonName = production.singleton.getName();
      reaching = modulesReachingSingleton(production);
      const census = moduleEvaluationCensus(production);
      admitted = census.admitted;
      refused = census.refused;
      assertions = assertionsOverSingleton(production);
    }
    {
      // Every fixture in ONE population, so the green direction below is a
      // DISCRIMINATION among them rather than an absence measured on its own:
      // a detector that flagged everything would fail it in the same breath
      // that the red direction passes.
      const oracle = scanOf([], ORACLE_MODULES);
      oracleRefused = moduleEvaluationCensus(oracle).refused;
      oracleAssertions = assertionsOverSingleton(oracle);
      oracleReaching = modulesReachingSingleton(oracle);
    }
  });

  test('the scan observes a NON-EMPTY universe and resolves the singleton by symbol', () => {
    expect(universe).toBeGreaterThan(50);
    expect(singletonName).toBe(SINGLETON);
    // A scan that reached nothing would satisfy every rule below by observing
    // an empty population — the vacuity this programme has been bitten by.
    expect(reaching.length).toBeGreaterThan(0);
  });

  // ── THE SEAM, AND WHY EACH TEST BELOW BINDS ONE POPULATION AND NOT BOTH ──
  //
  // Round-7 review handed each of these calls an empty argument and watched the
  // census stay green: the rules were proven as a pure function while the seam
  // that feeds them the REAL list and the REAL scan was only half bound. A rule
  // answered over nothing is satisfied by nothing, which is the vacuity this
  // block already warns about eight lines up — and the warning guarded the
  // variable, in a sibling test, rather than the argument at the seam.
  //
  // Each test binds the population its own rules CANNOT notice the emptiness
  // of, and only that one, so every line here is load-bearing:
  //   · `unlisted` is computed from the scan, so an empty LIST already reddens
  //     it (everything observed becomes unlisted) — the scan is what it cannot
  //     see go missing, so this test binds `observed`.
  //   · `stale` and `reasonless` are computed from the list, so an empty SCAN
  //     already reddens `stale` (everything listed becomes stale) — the list is
  //     what they cannot see go missing, so that test binds `listed`.
  //
  // The expectation side re-derives from the real variable rather than from the
  // argument, so swapping the argument cannot move both halves together.

  test('every production module reaching the singleton is on the VISIBLE allowlist', () => {
    const findings = allowlistFindings(PERMITTED_SINGLETON_IMPORTERS, reaching);
    expect(findings.observed).toEqual([...reaching].sort());
    expect(findings.unlisted).toEqual([]);
  });

  test('the allowlist carries no STALE entry, and every entry carries its reason', () => {
    // An allowlist that outlives what it lists stops being a review artefact
    // and becomes a hole with a comment on it; one that keeps its entries and
    // loses their reasons stops being one more quietly still.
    const findings = allowlistFindings(PERMITTED_SINGLETON_IMPORTERS, reaching);
    expect(findings.listed).toEqual(PERMITTED_SINGLETON_IMPORTERS.map((entry) => entry.module).sort());
    expect(findings.stale).toEqual([]);
    expect(findings.reasonless).toEqual([]);
  });

  test('OUTSIDE a function body, no production module but the definer touches the singleton', () => {
    expect(refused).toEqual([]);
  });

  test('the module-evaluation scan is SATISFIABLE: it sees the eight imports it admits', () => {
    // The positive control. Without it the rule above could pass by observing
    // nothing at all — a traversal that never reaches module-evaluation level
    // refuses an empty population and looks identical to a clean tree.
    expect(admitted).toHaveLength(PERMITTED_SINGLETON_IMPORTERS.length);
    expect(admitted.map((where) => where.replace(/:\d+$/, '')).sort())
      .toEqual(PERMITTED_SINGLETON_IMPORTERS.map((entry) => entry.module).sort());
  });

  test('NO production type assertion is applied to the singleton', () => {
    expect(assertions).toEqual([]);
  });

  test('ORACLE, red direction: every hand-off shape two reviews found is refused', () => {
    expect(oracleRefused).toEqual([
      // Each line is a point at which that fixture touches the singleton
      // OUTSIDE a function body. Where a fixture launders through a local
      // alias, the refusal lands on the ALIAS's own line rather than on the
      // export that carries it — the module is caught either way, and the
      // ASSERTION rule below catches the export line too, which is how the two
      // rules cover the same module without being one rule reported twice.
      `${posix(ORACLE_ALIASED)}:3`,
      `${posix(ORACLE_ASSERTED_FORMS)}:10`,
      `${posix(ORACLE_ASSERTED_FORMS)}:11`,
      `${posix(ORACLE_ASSERTED_FORMS)}:12`,
      `${posix(ORACLE_ASSERTED_FORMS)}:3`,
      `${posix(ORACLE_ASSERTED_FORMS)}:4`,
      `${posix(ORACLE_ASSERTED_FORMS)}:5`,
      `${posix(ORACLE_ASSERTED_FORMS)}:6`,
      `${posix(ORACLE_ASSERTED_FORMS)}:9`,
      `${posix(ORACLE_COLLECTED)}:3`,
      // Round-4 review's two evasions. Both DECLARE their holder with a
      // `typeof` annotation, which the type-position exclusion ignores, and
      // both are caught by the assignment that follows it.
      `${posix(ORACLE_DEFINED)}:5`,
      `${posix(ORACLE_HELD)}:3`,
      `${posix(ORACLE_LATE)}:5`,
      `${posix(ORACLE_RENAMED)}:1`,
      `${posix(ORACLE_STATIC)}:4`,
      `${posix(ORACLE_WIDENED)}:7`,
    ]);
    // ...and every fixture is counted as reaching it, which is what puts a new
    // one in front of a reviewer in the first place.
    expect(oracleReaching).toEqual([...ORACLE_MODULES.keys()].map(posix).sort());
  });

  test('ORACLE: EVERY RETAINED branch of the assertion reduction is load-bearing', () => {
    // ── WHAT ROUND-5 REVIEW TAUGHT THIS LIST ──
    //
    // The first version of it spent one DIRECT line on each wrapper form and
    // claimed each branch was load-bearing. Round-5 review removed the `as`,
    // `satisfies` and angle-bracket branches one at a time and watched all
    // sixteen tests stay green, because `assertionsOverSingleton` visits every
    // nested assertion node in its own right: a direct
    // `loginSessionService satisfies object` reduces straight from the
    // identifier and never enters the `satisfies` branch at all. A direct line
    // exercises the SCAN, not the branch.
    //
    // Lines 13-15 are the repair. Each asserts over a LOCAL whose initializer
    // is one of the wrapped forms, so the reduction has to step through that
    // branch to reach the singleton. Remove the branch and exactly one of those
    // three lines disappears — which is what M-ss9.22, M-ss9.23 and M-ss9.24
    // require.
    expect(oracleAssertions).toEqual([
      `${posix(ORACLE_ASSERTED_FORMS)}:10`,
      `${posix(ORACLE_ASSERTED_FORMS)}:11`,
      `${posix(ORACLE_ASSERTED_FORMS)}:12`,
      `${posix(ORACLE_ASSERTED_FORMS)}:13`,
      `${posix(ORACLE_ASSERTED_FORMS)}:14`,
      `${posix(ORACLE_ASSERTED_FORMS)}:15`,
      `${posix(ORACLE_ASSERTED_FORMS)}:4`,
      `${posix(ORACLE_ASSERTED_FORMS)}:5`,
      `${posix(ORACLE_ASSERTED_FORMS)}:6`,
      `${posix(ORACLE_ASSERTED_FORMS)}:8`,
      `${posix(ORACLE_ASSERTED_FORMS)}:9`,
      `${posix(ORACLE_WIDENED)}:7`,
    ]);
  });

  test('ORACLE: the ALLOWLIST rules each catch their own defect, and spare the good entry', () => {
    // The known-answer vector the list rules lacked until round-6 review found
    // it. One list, three defects and one entry that is entirely fine, so each
    // predicate is answered by a case only it can catch — and the good entry is
    // named by none of them, which is what stops a rule that flags everything
    // from passing this test.
    const findings = allowlistFindings(
      [
        { module: 'src/kept.ts', because: 'a real reason, and this module is really reached' },
        { module: 'src/reasonless.ts', because: '   ' },
        { module: 'src/stale.ts', because: 'listed, reasoned, and nothing reaches it any more' },
      ],
      ['src/kept.ts', 'src/reasonless.ts', 'src/unlisted.ts'],
    );
    expect(findings.unlisted).toEqual(['src/unlisted.ts']);
    expect(findings.stale).toEqual(['src/stale.ts']);
    expect(findings.reasonless).toEqual(['src/reasonless.ts']);
    expect([...findings.unlisted, ...findings.stale, ...findings.reasonless]).not.toContain('src/kept.ts');
  });

  test('ORACLE, green direction: an ordinary import and call is refused by NEITHER rule', () => {
    // Judged in the SAME population as every refused fixture above.
    const ordinary = posix(ORACLE_ORDINARY);
    expect(oracleRefused.filter((finding) => finding.startsWith(`${ordinary}:`))).toEqual([]);
    expect(oracleAssertions.filter((finding) => finding.startsWith(`${ordinary}:`))).toEqual([]);
    // It is still enumerated: the allowlist is the part that governs it.
    expect(oracleReaching).toContain(ordinary);
  });
});
