#!/usr/bin/env node
/**
 * setgov-contract-census — print, with a shown command, every count the SETGOV
 * drill layer's expected sets are derived from.
 *
 * SETGOV candidate A (card `bbec04de`), round 4. Board lesson
 * `counts-must-be-computed-not-eyeballed`: a figure in a report that no command
 * produces is a figure nobody checked. Every number in the round-4 evidence
 * report comes out of this script, and a reviewer re-derives all of them
 * without a database, without a running server and without trusting a sentence:
 *
 *     node scripts/setgov-contract-census.mjs
 *
 * The catalogue is read from migration `109_access_surfaces.sql` — the seed the
 * arm's rows come from — and the route families from the COMPILED production
 * registry, so the script needs `backend/dist` (`npm run build`) and nothing
 * else. The live drill reads the same catalogue from the DATABASE and asserts
 * the two agree, which is how a database that drifted from the migration in the
 * tree is caught rather than assumed away.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  D21_WRITE_STORES,
  buildD6Census,
  buildLockedCensus,
  buildD21WriteCensus,
  familiesOfClass,
  levelResolverFromMembership,
  loadProductionContract,
  normaliserDrift,
  ratifiedAccessLevels,
  ratifiedAuthorityStores,
  ratifiedBearerLayers,
  authoritySeamCompositionDrift,
  buildD17Census,
  buildPluginLevelCensus,
  parseSeededCatalogue,
} from './setgov-drill-contract.mjs';
import {
  AUTHORITY_MUTATION_SURFACE_KEYS,
  RATIFIED_ESCALATION_ACTS,
  canonicalPath,
} from './setgov-drill-oracles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.RELAYHALL_REPO || path.join(HERE, '..');
const BACKEND = path.join(REPO, 'backend');
const MIGRATION = path.join(BACKEND, 'src', 'migrations', '109_access_surfaces.sql');

const contract = loadProductionContract(BACKEND);
// The caller states are PRODUCTION'S access levels, not this script's list
// (round-4 review 5cfe851b B2).
const callerStates = ratifiedAccessLevels(contract);
const authorityStores = ratifiedAuthorityStores(contract);
const seed = parseSeededCatalogue(readFileSync(MIGRATION, 'utf8'));
const levelFor = levelResolverFromMembership(seed.memberRows, 'administrative');

const governable = familiesOfClass(contract, seed.surfaceRows, 'governable');
const d6Census = buildD6Census(contract, {
  surfaceRows: seed.surfaceRows,
  callerStates,
  levelFor,
  excludeSurfaceKeys: AUTHORITY_MUTATION_SURFACE_KEYS,
});
const locked = buildLockedCensus(contract, seed.surfaceRows);
const attempts = buildD21WriteCensus(AUTHORITY_MUTATION_SURFACE_KEYS);
const withheldFamilies = governable.filter((family) => AUTHORITY_MUTATION_SURFACE_KEYS.includes(family.surfaceKey));
const registry = contract.enumerateProtectedRouteFamilies();
const drift = normaliserDrift(contract, canonicalPath);
// ROUND 5. The three dimensions that used to be the drill's are production's,
// and each is printed with the command that produces it — a reviewer with no
// database can check every count below against the tree.
const bearerLayers = ratifiedBearerLayers(contract);
const seamDrift = await authoritySeamCompositionDrift(contract);
const webhooksRow = seed.surfaceRows.find((row) => row.key === 'settings.webhooks');
const d17Census = buildD17Census(contract, {
  surfaceRow: webhooksRow,
  bearers: bearerLayers,
  stores: authorityStores.map((entry) => entry.store),
});
const pluginCensus = buildPluginLevelCensus(contract, { coreCells: d17Census, levels: callerStates });
// The transcription must name declared WRITE families of the withheld surfaces.
const escalationProblems = RATIFIED_ESCALATION_ACTS.filter((want) => {
  const row = seed.surfaceRows.find((entry) => entry.key === want.surfaceKey);
  return !AUTHORITY_MUTATION_SURFACE_KEYS.includes(want.surfaceKey)
    || !row || !(row.write_families ?? []).includes(want.familyKey);
}).map((want) => `${want.familyKey} (${want.surfaceKey})`);

const byGovernance = new Map();
for (const row of seed.surfaceRows) byGovernance.set(row.governance, (byGovernance.get(row.governance) ?? 0) + 1);

const lines = [
  `migration                       ${path.relative(REPO, MIGRATION)}`,
  `seeded Access surfaces          ${seed.surfaceRows.length}`,
  ...[...byGovernance.entries()].sort().map(([klass, n]) => `  ${klass.padEnd(28)}${n}`),
  `Administrative members          ${levelFor.carried.size} (${[...levelFor.carried].sort().join(', ')})`,
  `governable families             ${governable.length}`,
  `  withheld by ruling 70af4d82   ${withheldFamilies.length} over ${AUTHORITY_MUTATION_SURFACE_KEYS.length} surfaces (D21's, never D6's)`,
  `  D6 subject                    ${governable.length - withheldFamilies.length}`,
  `D6 caller states                ${callerStates.length} (${callerStates.join(', ')}) — production ACCESS_LEVELS`,
  `D17 authority stores            ${authorityStores.length} (${authorityStores.map((s) => `${s.store} -> ${s.table}`).join(', ')}) — production AUTHORITY_SEAMS`,
  `seam composition vs surfaceLevel ${seamDrift.problems.length === 0 ? `AGREES (the residue EQUALS the declared-seam skeleton; ${seamDrift.actualExists} EXISTS subqueries, all declared)` : seamDrift.problems.join(' | ')}`,
  `D17 bearer layers               ${bearerLayers.length} (${bearerLayers.join(', ')}) — production DELEGATED_BEARER_LAYERS`,
  `D17 core matrix cells           ${d17Census.length} = ${bearerLayers.length} layers x ${authorityStores.length} stores x 2 family classes`,
  `D17 plugin matrix cells         ${pluginCensus.length} = the core matrix x ${callerStates.length} ratified levels (${pluginCensus.filter((c) => c.expectAdmitted).length} admit, ${pluginCensus.filter((c) => !c.expectAdmitted).length} refuse)`,
  `D21(iii) ratified escalation    ${RATIFIED_ESCALATION_ACTS.length} acts, transcribed; catalogue agreement ${escalationProblems.length === 0 ? 'OK' : `FAILED: ${escalationProblems.join(', ')}`}`,
  `D6 census cells                 ${d6Census.length}`,
  `locked families (D10 subject)   ${locked.length} over ${new Set(locked.map((f) => f.surfaceKey)).size} locked surfaces`,
  `D21(ii) required attempts       ${attempts.length} = ${AUTHORITY_MUTATION_SURFACE_KEYS.length} withheld surfaces x ${D21_WRITE_STORES.length} write stores`,
  `D21(iii) withheld family sweep  ${withheldFamilies.length}`,
  `protected route families        ${registry.length} served by the registry`,
  `normaliser drift vs production  ${drift.length === 0 ? 'NONE' : drift.join(' | ')}`,
];
console.log(lines.join('\n'));

if (process.argv.includes('--verbose')) {
  console.log('\nD6 cells:');
  for (const cell of d6Census) console.log(`  ${cell.key.padEnd(64)} level=${cell.level.padEnd(10)} ${cell.method} ${cell.path}`);
  console.log('\nlocked families:');
  for (const family of locked) console.log(`  ${family.surfaceKey.padEnd(34)} ${family.method} ${family.path}`);
  console.log('\nD21(ii) attempts:');
  for (const attempt of attempts) console.log(`  ${attempt.key}`);
}

if (drift.length > 0 || seamDrift.problems.length > 0 || escalationProblems.length > 0) process.exit(1);
