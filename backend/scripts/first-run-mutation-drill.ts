/**
 * LANE FIRST-RUN — the mutation drill (card `27322abb`).
 *
 * A control is only evidence if it can go red. Each mutation below reintroduces
 * ONE defect the lane's controls exist to catch, runs the suites, and records
 * which assertions reddened. Nothing here re-implements the scoring: it reuses
 * `classifyJestRun` from `support/mutationDrill`, the classifier that three
 * review rounds hardened (review `a8e380f1` finding 2), so this drill cannot
 * report an assertion while swallowing a suite that never compiled, and cannot
 * call a runner failure a clean green.
 *
 * Every mutation must still COMPILE — a mutation that does not compile proves
 * nothing — and each one must redden a DIFFERENT assertion from its neighbours.
 *
 * Run it:  cd backend && npx tsx scripts/first-run-mutation-drill.ts
 * Every file it touches is restored, including on failure. Developer tool, not
 * a CI step: never point it at a tree with uncommitted work you care about.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  BACKEND_ROOT,
  Classification,
  JestRun,
  Mutation,
  classifyJestRun,
} from '../src/__tests__/support/mutationDrill';

/** The controls this lane ships. */
const SUITES = [
  'src/__tests__/roleChangeAct.test.ts',
  'src/__tests__/firstRunAdministrator.test.ts',
  'src/__tests__/firstRunConfigSurface.test.ts',
  'src/__tests__/administratorSessionSeam.test.ts',
  'src/__tests__/roleChangeAtomicity.test.ts',
];

const SEAM = 'src/utils/administratorSession.ts';
const ROUTE = 'src/routes/principals.ts';
const AUTH = 'src/routes/auth.ts';
const SERVICE = 'src/services/FirstRunService.ts';
const CONFIG = 'src/config/relayhall.ts';
const SERVICE_ROUTE = 'src/routes/services.ts';
const PRINCIPAL_SERVICE = 'src/services/PrincipalService.ts';

export const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    reintroduces: 'the session classification is not consulted — a bearer credential performs the act',
    file: SEAM,
    find: '  if (!isLoginSessionKind(input.authMethod)) {',
    replace: '  if (false && !isLoginSessionKind(input.authMethod)) {',
    expects: [
      'a ROOT-SCOPED rh_ bearer credential is REFUSED BY NAME',
      'every refusal is recorded too, naming its reason',
    ],
  },
  {
    id: 'M2',
    reintroduces: 'the classification admits the rh_ bearer arm as well',
    file: SEAM,
    find: "  return authMethod === 'session' || authMethod === 'dashboard_jwt';",
    replace: "  return authMethod === 'session' || authMethod === 'dashboard_jwt' || authMethod === 'principal_api_key';",
    expects: [
      'admits exactly the two doors a PERSON comes through',
      'refuses every machine credential, not only the rh_ one',
      'a bearer credential is refused BEFORE its role is even consulted',
      'a ROOT-SCOPED rh_ bearer credential is REFUSED BY NAME',
    ],
  },
  {
    id: 'M3',
    reintroduces: 'the non-escalation ceiling is dropped — an operator mints an admin',
    file: ROUTE,
    // NOT `if (false && ...)`: TypeScript treats the block as unreachable and
    // RESETS the narrowing of `session` inside it, so the file stops compiling
    // and the run measures nothing. Handing the ceiling a fixed `admin` issuer
    // keeps every type intact and reintroduces exactly the defect — an
    // operator bounded by somebody else's authority.
    find: '    if (!canAssignRole(session.issuerRole, requestedRole)) {',
    replace: "    if (!canAssignRole('admin', requestedRole)) {",
    expects: [
      'an OPERATOR cannot mint an admin',
      'an OPERATOR cannot mint an orchestrator either',
    ],
  },
  {
    id: 'M4',
    reintroduces: 'the self-row refusal never fires — an administrator promotes themselves',
    file: ROUTE,
    find: '    if (req.principal?.id && req.principal.id === target.id) {',
    replace: '    if (req.principal?.id && req.principal.id === target.handle) {',
    expects: ['an administrator cannot change their OWN row'],
  },
  {
    id: 'M5',
    reintroduces: 'the break-glass identity loses its fixed role — the R11 lockout by another verb',
    file: ROUTE,
    // Same reachability rule as M3. The configured handle is lowercased by
    // `localAdministratorHandle`, so an upper-cased comparison never matches
    // and the guard is inert — while every identifier stays used and every
    // narrowing survives.
    find: '    if (target.handle === localAdministratorHandle()) {',
    replace: '    if (target.handle === localAdministratorHandle().toUpperCase()) {',
    expects: ['the break-glass local administrator keeps its role'],
  },
  {
    id: 'M6',
    reintroduces: 'an elevated role lands on a legacy SERVICE row — every rh_ key it holds derives root',
    file: ROUTE,
    // The defect precisely: the PARENT test kept, the KIND test dropped. That
    // is the half migration 096's CHECK does not carry, so a legacy parentless
    // service row — the shape that holds `rh_` keys — becomes promotable.
    find: '    if (ELEVATED_ROLES.has(requestedRole) && (target.kind !== \'human\' || target.parentPrincipalId !== null)) {',
    replace: '    if (ELEVATED_ROLES.has(requestedRole) && (target.parentPrincipalId !== null)) {',
    expects: ['a legacy SERVICE row cannot be promoted to admin'],
  },
  {
    id: 'M7',
    reintroduces: 'the audit records the AFTER role as the before one — the ledger stops being a diff',
    file: ROUTE,
    find: '        before: previousRole,',
    replace: '        before: updated.role,',
    expects: ['a successful change records actor, target, before, after and the seam'],
  },
  {
    id: 'M8',
    reintroduces: 'the response claims the change waits for a re-login — false on this substrate',
    file: ROUTE,
    find: "      effectiveFrom: 'next-request',",
    replace: "      effectiveFrom: 'next-login',",
    expects: ['the response says NEXT REQUEST, not next login'],
  },
  {
    id: 'M9',
    reintroduces: 'the TRANSACTIONAL re-check is gone — the race creates a second administrator',
    file: SERVICE,
    // The OUTER check at the route is a courtesy; this is the binding one, and
    // the first drill run proved the distinction matters: removing the outer
    // check reddened nothing, because this one refused the same attempt.
    find: '      if (await this.administratorExists(client)) {',
    replace: '      if (false) {',
    expects: ['the TRANSACTIONAL re-check refuses on its own'],
  },
  {
    id: 'M10',
    reintroduces: 'the act leaves its transaction — the audit row commits separately from the Account',
    file: SERVICE,
    find: `      }, client);

      await client.query('COMMIT');`,
    replace: `      });

      await client.query('COMMIT');`,
    expects: [
      'commits the Account, its password and its audit row on ONE connection, in order',
      'audits `first_run.administrator_created` against the new Account',
    ],
  },
  {
    id: 'M11',
    reintroduces: 'the NEGATIVE answer is cached too — the step stays open after somebody walks through it',
    file: SERVICE,
    find: '    if (exists) this.administratorSeen = true;',
    replace: '    this.administratorSeen = true;',
    expects: ['caches only the POSITIVE answer'],
  },
  {
    id: 'M12',
    reintroduces: 'an unreadable substrate ADVERTISES the step it could not verify',
    file: SERVICE,
    find: '    } catch {\n      return false;\n    }\n  }',
    replace: '    } catch {\n      return true;\n    }\n  }',
    expects: ['an unreadable substrate withholds the step rather than advertising it'],
  },
  {
    id: 'M13',
    reintroduces: 'the state probe forgets that an administrator must be PARENTLESS',
    file: SERVICE,
    find: "     AND parent_principal_id IS NULL\n",
    replace: '',
    expects: ['asks about ACTIVE PARENTLESS HUMAN Accounts holding admin or operator'],
  },
  {
    id: 'M14',
    reintroduces: 'the /config boolean defaults OPEN — an older caller advertises the step',
    file: CONFIG,
    find: '      firstRun: firstRun ?? false,',
    replace: '      firstRun: firstRun ?? true,',
    expects: ['defaults the field to false when no caller supplies it'],
  },
  {
    id: 'M16',
    reintroduces: 'review verdict 2c284891 B1 — a FIFTH private copy of the classification appears',
    file: SERVICE_ROUTE,
    // The exact line that was living here before the repair. The single-file
    // control this replaced could not have seen it: it read one other file.
    find: '      if (!isLoginSessionKind(req.authMethod) || !req.principal?.id) {',
    replace: "      const sessionLike = req.authMethod === 'dashboard_jwt' || req.authMethod === 'session';\n"
      + '      if (!sessionLike || !req.principal?.id) {',
    expects: ['no source outside the seam compares authMethod to a credential-kind literal'],
  },
  {
    id: 'M17',
    reintroduces: 'review verdict 2c284891 B2 — the role act leaves its transaction again',
    file: ROUTE,
    // The audit row goes back to its own connection: the UPDATE still commits,
    // the ledger row can fail on its own, and the caller is told the act failed
    // while it happened.
    find: '      }, client);\n      await client.query(\'COMMIT\');',
    replace: '      });\n      await client.query(\'COMMIT\');',
    expects: [
      'the UPDATE and the audit row go down ONE connection, inside one transaction',
      'neither write escapes to the pool',
    ],
  },
  {
    id: 'M18',
    reintroduces: 'an UNCOMMITTED row is published into the read caches',
    file: PRINCIPAL_SERVICE,
    find: '    if (client === pool) {\n      this.byId.set(principal.id, { principal, at: Date.now() });',
    replace: '    if (true) {\n      this.byId.set(principal.id, { principal, at: Date.now() });',
    expects: ['the rolled-back role is NOT what the read caches answer'],
  },
  {
    id: 'M15',
    reintroduces: 'the front-end mirror drifts from the backend seam',
    file: '../frontend/src/utils/administratorSession.ts',
    find: "export const ROLE_ACT_ISSUER_ROLES = ['admin', 'operator', 'orchestrator'];",
    replace: "export const ROLE_ACT_ISSUER_ROLES = ['admin', 'operator', 'orchestrator', 'editor'];",
    expects: ['lists the same issuer roles the backend admits'],
  },
];

function runSuites(): JestRun {
  const result = spawnSync('npx', ['jest', '--runInBand', '--verbose', ...SUITES], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) return { exitCode: null, output: String(result.error.message) };
  return { exitCode: result.status, output: [result.stdout ?? '', result.stderr ?? ''].join('\n') };
}

interface Result { mutation: Mutation; classification: Classification; unmet: string[] }

function drillOne(mutation: Mutation): Result {
  const target = path.join(BACKEND_ROOT, mutation.file);
  const original = fs.readFileSync(target, 'utf8');
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    return {
      mutation,
      classification: {
        status: 'INVALID',
        reds: [],
        reason: `the mutation's anchor occurs ${occurrences} times in ${mutation.file}`
          + ' — the drill table has drifted from the tree and measures nothing',
      },
      unmet: mutation.expects,
    };
  }
  try {
    fs.writeFileSync(target, original.replace(mutation.find, mutation.replace));
    const classification = classifyJestRun(runSuites());
    const unmet = mutation.expects.filter(
      (expected) => !classification.reds.some((red) => red.includes(expected)),
    );
    return { mutation, classification, unmet };
  } finally {
    fs.writeFileSync(target, original);
  }
}

function main(): number {
  const wanted = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
  const selected = wanted.length > 0 ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS;
  if (selected.length === 0) {
    process.stdout.write(`no mutation matched ${JSON.stringify(wanted)}\n`);
    return 1;
  }

  process.stdout.write('=== baseline: the unmutated tree must be GREEN\n');
  const baseline = classifyJestRun(runSuites());
  process.stdout.write(`    ${baseline.status} — ${baseline.reason}\n\n`);
  let failures = baseline.status === 'GREEN' ? 0 : 1;

  for (const mutation of selected) {
    const { classification, unmet } = drillOne(mutation);
    process.stdout.write(`=== ${mutation.id} · ${mutation.reintroduces}\n`);
    process.stdout.write(`    ${classification.status} — ${classification.reason}\n`);
    for (const red of classification.reds) process.stdout.write(`    red: ${red}\n`);
    if (classification.status !== 'RED' || unmet.length > 0) {
      failures += 1;
      for (const missing of unmet) process.stdout.write(`    UNMET: ${missing}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(failures === 0
    ? `all ${selected.length} mutations reddened exactly what the table says\n`
    : `${failures} mutation(s) did not\n`);
  return failures === 0 ? 0 : 1;
}

process.exit(main());
