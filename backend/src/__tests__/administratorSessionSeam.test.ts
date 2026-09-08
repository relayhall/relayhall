/**
 * THE SESSION-CLASSIFICATION SEAM (dispatcher amendment on LENSES verdict
 * `0d0d3548`; owner ruling `60307311` §1.2).
 *
 * "This request is a root/admin LOGIN SESSION, not a bearer credential" must
 * exist ONCE. Three things follow, and this file measures all three:
 *
 *  1. the classifier itself answers correctly for every `authMethod` the audit
 *     vocabulary admits — including the ones that are neither a session nor an
 *     `rh_` key, which a two-value test would leave in a gap;
 *  2. `middleware/sharedAuthorization` has NO second copy: its own
 *     authentication-kind stage must be the same function, proven by reading
 *     the source rather than by trusting the import;
 *  3. the front-end mirror in `frontend/src/utils/administratorSession.ts`
 *     lists the same roles as the backend, proven by reading BOTH files. A
 *     comment asking the next editor to keep two lists in step is not a
 *     control; this is.
 */
import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';
import {
  ADMINISTRATOR_ROLES,
  ROLE_ACT_ISSUER_ROLES,
  REQUIRES_LOGIN_SESSION,
  administratorSessionOf,
  classifyLoginSession,
  isBearerCredentialKind,
  isLoginSessionKind,
} from '../utils/administratorSession';
import { ASSIGNABLE_ROLES } from '../utils/credentialAuthority';
import { resolveActorRole } from '../utils/taskAutomationRole';

/** Every value `AuditAuthMethod` admits — the complete input space. */
const EVERY_AUTH_METHOD = [
  'local_admin', 'dashboard_jwt', 'principal_api_key',
  'legacy_api_key', 'reports_read_key', 'session', 'system', 'unknown',
];

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ── DEFINER DISCOVERY (round-1 review C2, round-2 review C2) ────────────────
//
// "Exactly one thing named `armDecision` is defined in the production tree" is
// a question about DECLARATIONS, and the two previous answers both got it
// wrong in the same way: they described the declarations they expected. A
// regex described them as text (`/\basync armDecision\s*\(/`) and missed
// every other syntax; the AST walk that replaced it described them as five
// node kinds with `Identifier` names, and missed `['armDecision']()`, a
// computed field, and `obj['armDecision'] = …`. Each round found the next
// spelling, and the companion case that was supposed to catch that enumerated
// the SAME five — a control that cannot see a hole the thing it controls has.
//
// So nothing is enumerated here. `ts.getNameOfDeclaration` is the compiler's
// own answer to "what is this declaration called", for every declaration kind
// TypeScript has and every one it gains; `readDeclaredName` then resolves that
// name to TEXT through the type checker, so a literal, a computed literal, a
// computed CONST (`const FN = 'armDecision'; class X { [FN]() {} }`), an
// element assignment and a property assignment all read the same. Adding a
// syntax to the language does not add a line here.
//
// ROUND-3 REVIEW C2, AND THE REGRESS IT NAMES. The above was still an answer
// to "which CONSTRUCTS can install this name", and round 3 found one that is
// not a declaration at all:
//
//     Object.defineProperty(o, 'armDecision', { value: () => 1 });
//
// A call expression installs the property; `getNameOfDeclaration` is never
// asked about it, so it produced no definer, no suspect and no unresolvable
// row — silent, while spelling the target literally. That is three rounds and
// three answers to the same question (a regex, five node kinds, every
// declaration kind), each defeated by the next construct. The question does
// not terminate. So the second layer below stops asking it.
//
// THE BACKSTOP: WATCH THE NAME, NOT THE CONSTRUCT. Any string literal equal to
// `armDecision`, anywhere in the production tree, is a SUSPECT — whatever
// syntax surrounds it, invented or not. Production spells the arm as an
// IDENTIFIER and never as a string, so the expected count is zero and this
// costs nothing to keep true. The AST walk above remains the primary answer to
// "how many DECLARATIONS"; this is the floor under it, and a floor with
// nothing to enumerate cannot be defeated by the next construct.
//
// WHAT IT STILL CANNOT DECIDE, and this sentence does not move again: a
// definition installed under a name ASSEMBLED from pieces that never spell it
// (`o['arm' + 'Decision']`). Nothing static decides that, a reader cannot find
// it either, and the boot-time census in `AccessSurfaceService` governs
// runtime behaviour regardless. The runtime-keyed map writes the walk cannot
// name (`out[key] = value`, thirty-odd of them, every one an ordinary dynamic
// write) are still reported as unresolvable and still fail the census if their
// own statement mentions the arm.

const ARM_DECISION = 'armDecision';

/** A declaration's name as TEXT, or `unresolvable` when it is not static. */
type DeclaredName = { text: string } | { unresolvable: true } | null;

/**
 * Build a checker-backed program over `files`. `noResolve`/`noLib` keep it
 * fast (seconds, not minutes) and cost only cross-file inference, which
 * downgrades a name to a SUSPECT rather than to silence.
 */
function programOver(files: string[]): ts.Program {
  return ts.createProgram(files, {
    noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.Latest,
  });
}

function makeNameReader(checker: ts.TypeChecker): (name: ts.Node | undefined) => DeclaredName {
  const literalOf = (expr: ts.Node): string | null => {
    if (ts.isStringLiteralLike(expr) || ts.isNumericLiteral(expr)) return expr.text;
    const type = checker.getTypeAtLocation(expr);
    return type && typeof type.isStringLiteral === 'function' && type.isStringLiteral() ? type.value : null;
  };
  const read = (name: ts.Node | undefined): DeclaredName => {
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return { text: name.text };
    if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return { text: name.text };
    if (ts.isComputedPropertyName(name)) {
      const literal = literalOf(name.expression);
      return literal === null ? { unresolvable: true } : { text: literal };
    }
    if (ts.isPropertyAccessExpression(name)) return read(name.name);
    if (ts.isElementAccessExpression(name)) {
      const literal = literalOf(name.argumentExpression);
      return literal === null ? { unresolvable: true } : { text: literal };
    }
    // A binding pattern is not a name; its ELEMENTS are declarations of their
    // own and the walk reaches each of them.
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return null;
    return { unresolvable: true };
  };
  return read;
}

interface DefinerScan {
  /** Every declaration whose name resolves to `armDecision`, as `file:line`. */
  definers: string[];
  /**
   * Everything that could install the arm and is not a counted declaration:
   * a declaration with no static name whose statement mentions it, AND — the
   * round-3 backstop — every string literal that IS the name, wherever it sits.
   */
  suspects: string[];
  /** Every declaration with no static name, whatever it is called. */
  unresolvable: string[];
}

/** Scan a built program for declarations named `armDecision`. */
function scanForDefiners(program: ts.Program, files: string[], relativeTo: string): DefinerScan {
  const readName = makeNameReader(program.getTypeChecker());
  const scan: DefinerScan = { definers: [], suspects: [], unresolvable: [] };
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const visit = (node: ts.Node): void => {
      // A member ACCESS is not a declaration, and an assignment TO one is.
      //
      // `getNameOfDeclaration` answers for expressions as well, which cuts
      // both ways: `accessSurfaceService.armDecision(...)` — a CALL — reads
      // back as a definition of it, while `o['armDecision'] = fn` reads back
      // as nothing, because the compiler only names the assignment shapes it
      // recognises as declarations. So the one construct that is not a
      // declaration in the compiler's sense is handled here explicitly: a
      // plain `=` onto a member is a definition of that member, whatever the
      // shape of the thing it is written onto. This is a rule about ONE
      // syntactic form, not a list of the ways to declare something — that
      // list is still the compiler's.
      const nameOf = (): ts.Node | undefined => {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const target = node.left;
          return ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)
            ? target
            : undefined;
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return undefined;
        return ts.getNameOfDeclaration(node as ts.Declaration);
      };
      const name = nameOf();
      // The name must BELONG to this node. `getNameOfDeclaration` answers for
      // an expression too, so without this every name is counted twice — once
      // at its declaration and once at the identifier itself.
      if (name && name.parent === node) {
        const reading = readName(name);
        if (reading) {
          const at = `${path.relative(relativeTo, file)}:${
            source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
          if ('text' in reading) {
            if (reading.text === ARM_DECISION) scan.definers.push(at);
          } else {
            scan.unresolvable.push(at);
            const statement = node.getText(source);
            if (statement.includes(ARM_DECISION)) scan.suspects.push(`${at} ${statement.slice(0, 80)}`);
          }
        }
      }
      // THE BACKSTOP (round-3 review C2). The name, as a string, anywhere.
      // `Object.defineProperty(o, 'armDecision', …)`, a decorator argument, a
      // `Reflect.defineProperty`, a container registration, whatever comes
      // next: all of them must spell the name, and this sees the spelling
      // without knowing the construct. Production uses the identifier and
      // never the string, so the expected count is zero.
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        && node.text === ARM_DECISION) {
        scan.suspects.push(`${path.relative(relativeTo, file)}:${
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        } the arm's name as a string literal: ${node.parent.getText(source).slice(0, 90).replace(/\s+/g, ' ')}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return scan;
}

/** Scan one snippet of source, through the SAME discovery the census uses. */
function scanSnippet(code: string): DefinerScan {
  const name = 'probe.ts';
  const source = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: (requested) => (requested === name ? source : undefined),
    writeFile: () => undefined,
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (n) => n,
    getCurrentDirectory: () => '',
    getNewLine: () => '\n',
    fileExists: (n) => n === name,
    readFile: () => code,
  };
  const program = ts.createProgram([name], { noResolve: true, noLib: true, types: [] }, host);
  return scanForDefiners(program, [name], '');
}


describe('the classification', () => {
  it('admits exactly the two doors a PERSON comes through', () => {
    const admitted = EVERY_AUTH_METHOD.filter((method) => isLoginSessionKind(method));
    expect(admitted.sort()).toEqual(['dashboard_jwt', 'session']);
  });

  it('refuses every machine credential, not only the rh_ one', () => {
    // A test that only checked `principal_api_key` would pass with the legacy
    // service key silently admitted — and that key is broadly distributed.
    for (const method of ['principal_api_key', 'legacy_api_key', 'reports_read_key', 'system', 'local_admin']) {
      expect(isLoginSessionKind(method)).toBe(false);
    }
  });

  it('refuses an absent authMethod — an unclassified request is not a session', () => {
    expect(isLoginSessionKind(undefined)).toBe(false);
    expect(isLoginSessionKind('')).toBe(false);
  });

  it('carries a NAMED refusal, not a bare boolean', () => {
    const refused = classifyLoginSession('principal_api_key', 'Publishing a lens');
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.code).toBe(REQUIRES_LOGIN_SESSION);
    expect(refused.status).toBe(403);
    // The act names itself, so one shared seam still yields a refusal the
    // caller can act on.
    expect(refused.message).toContain('Publishing a lens');
    expect(classifyLoginSession('session', 'Publishing a lens').ok).toBe(true);
  });
});

/**
 * THE CENSUS — round 1's blocking finding, repaired at the class.
 *
 * The control that stood here read ONE consumer's source and asserted it no
 * longer decided for itself. Review verdict `2c284891` B1 showed why that is
 * not a control at all: four MORE private copies of the same comparison were
 * living in `routes/services.ts`, `routes/warrants.ts`, `routes/delegation.ts`
 * and `routes/principals.ts`, and a single-file assertion is structurally
 * incapable of seeing them — it false-greens by looking in the one place that
 * was already fixed.
 *
 * So it is replaced, not supplemented. This walks EVERY non-test TypeScript
 * source under `backend/src` and fails on any comparison of `authMethod`
 * against the three credential-kind literals, wherever it appears. A fifth copy
 * is now a red gate rather than something the next reviewer has to find.
 *
 * The ONE exemption is the seam itself, and it is exempted BY FILE deliberately
 * and narrowly: that file is where the literals are supposed to live, and it is
 * 120 lines whose whole content is this decision. Every other file in the tree
 * is covered with no exemption at all.
 */
const CREDENTIAL_KIND_LITERALS = ['session', 'dashboard_jwt', 'principal_api_key'];
const SEAM_FILE = path.join('utils', 'administratorSession.ts');

function everySource(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      everySource(full, found);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Every `authMethod === '<kind>'` / `!== '<kind>'`, as `file:line`. */
export function privateClassifications(source: string, label: string): string[] {
  const hits: string[] = [];
  source.split('\n').forEach((line, index) => {
    for (const literal of CREDENTIAL_KIND_LITERALS) {
      for (const operator of ['===', '!==']) {
        if (line.includes(`authMethod ${operator} '${literal}'`)
          || line.includes(`authMethod ${operator} "${literal}"`)) {
          hits.push(`${label}:${index + 1}`);
          return;
        }
      }
    }
  });
  return hits;
}

describe('there is only ONE copy of it — the repository-wide census', () => {
  const backendSrc = path.join(REPO_ROOT, 'backend', 'src');
  const sources = everySource(backendSrc);

  it('sees the whole tree — the census is not vacuous', () => {
    // A walker that returned nothing, or that skipped the routes, would make
    // every assertion below pass by looking at nothing.
    expect(sources.length).toBeGreaterThan(100);
    for (const expected of ['routes/principals.ts', 'routes/delegation.ts', 'routes/warrants.ts',
      'routes/services.ts', 'routes/credentials.ts', 'middleware/sharedAuthorization.ts']) {
      expect(sources.some((file) => file.endsWith(path.join(...expected.split('/'))))).toBe(true);
    }
  });

  it('no source outside the seam compares authMethod to a credential-kind literal', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const relative = path.relative(backendSrc, file);
      if (relative === SEAM_FILE) continue;
      offenders.push(...privateClassifications(fs.readFileSync(file, 'utf8'), relative));
    }
    // Named, not counted: a failure has to say WHERE, or the next person
    // repeats the round-1 hunt.
    expect(offenders).toEqual([]);
  });

  it('the seam is where those literals DO live — the exemption is not vacuous', () => {
    const seam = fs.readFileSync(path.join(backendSrc, SEAM_FILE), 'utf8');
    expect(privateClassifications(seam, SEAM_FILE).length).toBeGreaterThanOrEqual(2);
  });

  it('the detector fires on each of the four shapes the tree actually had', () => {
    // The red proof, run here rather than asserted: these are the literal lines
    // that were living in the four routes before this repair, plus the negated
    // form. If the detector stops seeing any of them it stops being a control.
    const planted = [
      "  const sessionLike = req.authMethod === 'dashboard_jwt' || req.authMethod === 'session';",
      "  const viaBearer = req.authMethod === 'principal_api_key';",
      "  if (req.authMethod !== 'principal_api_key' || !req.principal?.id) {",
      '  const x = req.authMethod === "session";',
    ];
    planted.forEach((line, index) => {
      expect(privateClassifications(line, `planted-${index}`)).toEqual([`planted-${index}:1`]);
    });
    // ...and does NOT fire on the assignments that WRITE the field, which are
    // how the middleware sets it and are not a classification at all.
    expect(privateClassifications("  req.authMethod = 'session';", 'assignment')).toEqual([]);
    expect(privateClassifications("  req.authMethod = 'principal_api_key';", 'assignment')).toEqual([]);
  });

  it('the Access-surface arm delegates rather than re-deciding', () => {
    // The arm's authentication-kind clause lived in
    // `middleware/sharedAuthorization` when this control was written, and card
    // `d0f030a9` moved it into `AccessSurfaceService.armDecision` so the
    // Settings menu could ask the SAME function the request path asks. A
    // control that names the old file would have gone green on a stub there
    // while the real clause drifted somewhere else, so it FINDS the arm.
    //
    // ROUND-1 REVIEW C2. The first version of that discovery walked only `.ts`
    // and recognised only `/\basync armDecision\s*\(/`, so a second definition
    // written `export const armDecision = async (...) =>`, or as a class field,
    // or in a `.tsx` production file, was invisible to it: the gate stayed
    // green on one recognised definer while two real ones existed — defeating
    // the exact condition it claims to enforce. A regex over source cannot
    // decide what a DECLARATION is, so this asks the TypeScript parser, which
    // is the same tool `errorEnvelopeDiscipline` already uses for the same
    // class of question.
    const backendSrcRoot = path.join(REPO_ROOT, 'backend', 'src');
    const production: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
        } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          production.push(full);
        }
      }
    };
    walk(backendSrcRoot);
    expect(production.length).toBeGreaterThan(100);

    const scan = scanForDefiners(programOver(production), production, REPO_ROOT);

    // EXACTLY ONE. Two would be two definitions of one authorization decision,
    // which is the whole defect this card removed; zero would mean the arm was
    // renamed and this control silently stopped measuring anything.
    expect(scan.definers).toHaveLength(1);
    expect(scan.definers[0]).toContain('AccessSurfaceService.ts');

    // ROUND-2 AND ROUND-3 REVIEW C2. What the discovery could not NAME is
    // reported, not dropped — and so is the NAME itself wherever it appears as
    // a string, which is what an installer that is not a declaration must do.
    // Both channels land in `suspects`, and there must be none.
    expect(scan.suspects).toEqual([]);
    // ...and the suspect channel is reachable rather than decorative: the tree
    // really does contain names this cannot resolve, so an empty `suspects` is
    // a filtered result and not an empty scan.
    expect(scan.unresolvable.length).toBeGreaterThan(0);

    const source = fs.readFileSync(path.join(REPO_ROOT, scan.definers[0].split(':')[0]), 'utf8');
    expect(source).toContain("import { isLoginSessionKind } from '../utils/administratorSession'");

    // And the stage that composes it holds no private copy of its own: the
    // repository-wide census above already proves that for every file, and
    // this is the arm-specific reading of the same fact.
    const stage = fs.readFileSync(
      path.join(REPO_ROOT, 'backend', 'src', 'middleware', 'sharedAuthorization.ts'), 'utf8',
    );
    expect(privateClassifications(stage, 'sharedAuthorization.ts')).toEqual([]);
  });

  it('the definer discovery sees a second definition however it is spelled', () => {
    // THE CONTROL ON THE CONTROL — and, this round, on the control ON the
    // control. Round 1's version listed the same five node kinds the census
    // listed, in its own copy of the code: when round 2 found a sixth spelling
    // the census missed, this case had missed it too, for the same reason and
    // in the same words. A companion that repeats the implementation is a
    // second chance to make the identical mistake.
    //
    // It now drives `scanSnippet`, which IS the census's discovery — the same
    // `scanForDefiners` over a one-file program. A spelling that defeats the
    // census defeats this case, so the two cannot be wrong apart.
    const shapes: Array<[string, string]> = [
      ['class method', 'class X { async armDecision(a: number) { return a; } }'],
      ['class field arrow', 'class X { armDecision = async (a: number) => a; }'],
      ['exported const arrow', 'export const armDecision = async (a: number) => a;'],
      ['function declaration', 'export async function armDecision(a: number) { return a; }'],
      ['object literal property', 'export const arm = { armDecision: async (a: number) => a };'],
      // The sixth, seventh and eighth: round-2 review C2's finding, and the
      // neighbours it belongs with. A computed name is a real declaration.
      ['computed method', "class X { ['armDecision']() { return 1; } }"],
      ['computed field', "class X { ['armDecision'] = 1; }"],
      ['computed name from a const', "const FN = 'armDecision'; class X { [FN]() { return 1; } }"],
      ['element assignment', "const o: any = {}; o['armDecision'] = () => 1;"],
      ['property assignment', 'const o: any = {}; o.armDecision = () => 1;'],
      ['a getter', 'class X { get armDecision() { return 1; } }'],
      ['a quoted member', "export const arm = { 'armDecision': 1 };"],
      ['an interface member', 'export interface Arm { armDecision(a: number): number; }'],
    ];
    for (const [label, code] of shapes) {
      expect([label, scanSnippet(code).definers.length]).toEqual([label, 1]);
    }

    // ...and it does not fire on something merely NAMED near the arm, or the
    // "exactly one" assertion would be unsatisfiable in a file that mentions it.
    expect(scanSnippet('const x = arm.armDecision(1);').definers).toEqual([]);
    expect(scanSnippet("const label = 'armDecision';").definers).toEqual([]);
  });

  it('an installer that is not a declaration is caught by the NAME, not the syntax', () => {
    // ROUND-3 REVIEW C2's finding, and the neighbours it belongs with. None of
    // these is a declaration; every one spells the arm; the backstop does not
    // need to know what any of them are.
    const installers: Array<[string, string]> = [
      ['Object.defineProperty', "const o: any = {}; Object.defineProperty(o, 'armDecision', { value: () => 1 });"],
      ['Reflect.defineProperty', "const o: any = {}; Reflect.defineProperty(o, 'armDecision', { value: () => 1 });"],
      ['a decorator argument', "declare function named(n: string): ClassDecorator; @named('armDecision') class X {}"],
      ['a container registration', "declare const c: any; c.register('armDecision', () => 1);"],
      ['a bare computed write', "const o: any = {}; o['armDecision'.toString()] = () => 1;"],
    ];
    for (const [label, code] of installers) {
      const scan = scanSnippet(code);
      expect([label, scan.suspects.length > 0]).toEqual([label, true]);
    }

    // ...and it does not fire on the arm spelled as an IDENTIFIER, which is how
    // production spells it — or the census could never be green.
    expect(scanSnippet('class S { async armDecision() { return 1; } }').suspects).toEqual([]);
    expect(scanSnippet('const x = arm.armDecision(1);').suspects).toEqual([]);
  });

  it('a name it cannot resolve becomes a SUSPECT rather than a silence', () => {
    // The other half of round-2 review C2. The census's honesty depends on an
    // unresolvable name being reported, so this drives both answers.
    const dynamic = 'declare const key: string; const o: any = {}; o[key] = 1;';
    expect(scanSnippet(dynamic).unresolvable.length).toBeGreaterThan(0);
    expect(scanSnippet(dynamic).suspects).toEqual([]);

    // The same shape, with the arm's name anywhere in the statement: a suspect.
    const suspicious = 'declare const pick: (s: string) => string; const o: any = {};'
      + " o[pick('armDecision')] = 1;";
    const scan = scanSnippet(suspicious);
    expect(scan.definers).toEqual([]);
    // BOTH channels see it, and that is the point: the unresolved-name channel
    // because the write has no static key, and the round-3 backstop because the
    // statement spells the name. Either alone would be enough to fail the
    // census; the overlap is what makes the floor a floor.
    expect(scan.suspects.length).toBeGreaterThanOrEqual(1);
    for (const suspect of scan.suspects) expect(suspect).toContain(ARM_DECISION);
    expect(scan.suspects.some((s) => s.includes("string literal"))).toBe(true);
    expect(scan.unresolvable.length).toBeGreaterThan(0);
  });

  it('the bearer half is named too, and answers only for that kind', () => {
    for (const method of EVERY_AUTH_METHOD) {
      expect(isBearerCredentialKind(method)).toBe(method === 'principal_api_key');
    }
    // The two halves are not each other's negation: `local_admin` is neither.
    expect(isLoginSessionKind('local_admin')).toBe(false);
    expect(isBearerCredentialKind('local_admin')).toBe(false);
  });
});

describe('the administrator bound', () => {
  it('an administrator, for the first-run state, is admin or operator', () => {
    expect([...ADMINISTRATOR_ROLES].sort()).toEqual(['admin', 'operator']);
  });

  it('the role act admits those two plus orchestrator, and nothing else', () => {
    expect([...ROLE_ACT_ISSUER_ROLES].sort()).toEqual(['admin', 'operator', 'orchestrator']);
  });

  it('every issuer role the act admits derives at least the operator ceiling', () => {
    // Why `orchestrator` is not a widening: it is admitted only because it
    // already holds everything the act could confer. This reads that from
    // `scopesForRole` rather than asserting it in prose.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { scopesForRole } = require('../utils/identityScopes');
    for (const role of ROLE_ACT_ISSUER_ROLES) {
      const scopes = scopesForRole(role);
      expect(scopes.includes('root') || scopes.includes('principals:admin')).toBe(true);
    }
  });

  it('a session whose role is none of them is refused by name', () => {
    for (const role of ['user', 'editor', 'viewer', 'agent', 'qa', 'reviewer']) {
      const outcome = administratorSessionOf(
        { authMethod: 'session', handle: 'x', principalRole: role, sessionRole: null },
        resolveActorRole,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('unreachable');
      expect(outcome.code).toBe('ROLE_ACT_REQUIRES_ADMINISTRATOR');
    }
  });

  it('a bearer credential is refused BEFORE its role is even consulted', () => {
    // An admin-roled Connector: if the role were consulted first this would
    // pass. The order is the control.
    const outcome = administratorSessionOf(
      { authMethod: 'principal_api_key', handle: 'connector', principalRole: 'admin', sessionRole: null },
      resolveActorRole,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('ROLE_ACT_REQUIRES_SESSION');
  });
});

describe('the front-end mirror', () => {
  const mirror = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend', 'src', 'utils', 'administratorSession.ts'), 'utf8',
  );

  /** Read an exported string-array literal out of the mirror's source. */
  function listed(name: string): string[] {
    const match = new RegExp('export const ' + name + '[^=]*=\\s*\\[([^\\]]*)\\]').exec(mirror);
    if (!match) throw new Error(`the mirror no longer exports ${name}`);
    return match[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
      .sort();
  }

  it('lists the same issuer roles the backend admits', () => {
    expect(listed('ROLE_ACT_ISSUER_ROLES')).toEqual([...ROLE_ACT_ISSUER_ROLES].sort());
  });

  it('lists the same assignable roles the backend allows', () => {
    expect(listed('ASSIGNABLE_ROLES')).toEqual([...ASSIGNABLE_ROLES].sort());
  });

  it('the reader is not vacuous — it really parses the mirror', () => {
    // A regex that matched nothing would make both cases above pass by
    // comparing two empty sets.
    expect(listed('ROLE_ACT_ISSUER_ROLES').length).toBe(3);
    expect(listed('ASSIGNABLE_ROLES').length).toBe(ASSIGNABLE_ROLES.size);
    expect(() => listed('NO_SUCH_LIST')).toThrow();
  });
});
