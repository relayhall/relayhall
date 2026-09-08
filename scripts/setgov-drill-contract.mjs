/**
 * setgov-drill-contract — the CONTRACT the SETGOV drill layer is measured
 * against, derived at run time from the PRODUCTION build and from the
 * catalogue rows the arm itself reads.
 *
 * SETGOV candidate A (card `bbec04de`); acceptance annex `85a2218d`; owner
 * ruling `83bf1354` item 1 (round 4, commissioned as a design-shaped repair).
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 *
 * Rounds 2 and 3 of this candidate's cross-family review found the same defect
 * seven times, in seven different oracles (`2bf39bb7`, `2a8087c3`, `1324ba78`,
 * `18d170f4`, `e3f57d06`, `2eb2061c`, `c179b66b`). Every instance had one
 * shape: the oracle re-derived what it was measuring from WHAT THE DRILL
 * HAPPENED TO OBSERVE — its `level`/`family` labels, its own path
 * normalisation, its route spellings, its sample size — instead of from the
 * contract. A drill that supplies its own vocabulary and is then judged
 * against that vocabulary can always be made to agree, which is the board's
 * recorded lesson twice over (`test-models-can-be-edited-to-agree`,
 * `drift-controls-need-an-outside-anchor`).
 *
 * So: EVERY expected set below is derived from an anchor OUTSIDE the drill.
 *
 *   1. `backend/dist/utils/routeFamilies.js` — the enumeration of every
 *      (METHOD, mounted path) the protected routers actually serve, the
 *      read-only method set that spells ruling I-10, and `FAMILY_PARAM_SAMPLE`,
 *      the one `:param` stand-in the route map is resolved with.
 *   2. `backend/dist/utils/scopeMap.js` — `normalizePathForScope`, THE
 *      canonical path form. The arm's trace line is literally
 *      `normalizePathForScope(mountedPath)` and the audit row's
 *      `metadata.path` is literally `normalizePathForScope(...)`
 *      (`middleware/sharedAuthorization.ts`), so any drill-side spelling of a
 *      path that is not this function's output is a drill defect.
 *   3. The `access_surfaces` / `access_bundle_members` ROWS — read from the
 *      same database the arm reads them from. Which families a surface
 *      declares, in which class, and which surfaces a bundle carries, are
 *      catalogue facts, never drill labels.
 *   4. Owner ruling `70af4d82` §1.1, TRANSCRIBED (in `setgov-drill-oracles.mjs`)
 *      rather than read back out of the migration these controls measure.
 *
 * This module is deliberately free of verdicts. It builds expected sets; the
 * oracles compare observations against them; the drill only observes.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

/** Both authority stores a matrix write can travel through (§3.4, D21(ii)). */
export const D21_WRITE_STORES = ['profile-rule-projection', 'surface-grant'];
/**
 * D17's authority stores are NOT listed here.
 *
 * ROUND-4b REVIEW `252fe7e6` B2: a two-entry literal in this file was the whole
 * inventory of authority paths to a surface level, so a THIRD authority path added to
 * `AccessSurfaceService.surfaceLevel` appeared in no expected set anywhere.
 * `ratifiedAuthorityStores` now reads production's `AUTHORITY_SEAMS` export and
 * `authoritySeamCompositionDrift` measures that export against the SQL
 * `surfaceLevel` actually emits.
 */
/** The two family classes a surface declares (design §2.4). */
export const FAMILY_CLASSES = ['read', 'write'];

/**
 * Load the compiled production contract.
 *
 * The COMPILED build on purpose, not `tsx` over the sources: it is the artefact
 * the container runs and the artefact `dist/server.js` — the process this drill
 * boots — is made of, so the normaliser this module anchors on is byte-for-byte
 * the one that produced the trace lines and the audit rows being judged.
 */
export function loadProductionContract(backendDir) {
  // Absolute on purpose: `createRequire` refuses a relative filename, and a
  // drill resolving the contract against its own cwd would be one more thing
  // the drill owns.
  const backend = path.resolve(backendDir);
  const require_ = createRequire(path.join(backend, 'package.json'));
  const load = (relative) => require_(path.join(backend, 'dist', relative));
  let scopeMap;
  let identityScopes;
  let actorRole;
  let routeFamilies;
  let surfaceService;
  let grantService;
  let profileService;
  let bearerLayers;
  try {
    scopeMap = load('utils/scopeMap.js');
    identityScopes = load('utils/identityScopes.js');
    actorRole = load('utils/taskAutomationRole.js');
    routeFamilies = load('utils/routeFamilies.js');
    surfaceService = load('services/AccessSurfaceService.js');
    grantService = load('services/GrantService.js');
    profileService = load('services/AccessProfileService.js');
    bearerLayers = load('utils/bearerLayers.js');
  } catch (error) {
    throw new Error(`the compiled production contract is not present in ${backendDir}/dist — run \`npm run build\` first (${error.message})`);
  }
  const contract = {
    normalizePathForScope: scopeMap.normalizePathForScope,
    requiredScopeFor: scopeMap.requiredScopeFor,
    // The ROUTE STAGE, as production decides it — D16's amendment control
    // measures whether a caller route-refused on a given family can exist at
    // all, and that question is answered by these three and nothing else.
    scopesSatisfy: scopeMap.scopesSatisfy,
    scopesForRole: identityScopes.scopesForRole,
    resolveActorRole: actorRole.resolveActorRole,
    parseFamilyKey: routeFamilies.parseFamilyKey,
    familySamplePath: routeFamilies.familySamplePath,
    familyKey: routeFamilies.familyKey,
    familyMatchesRequest: routeFamilies.familyMatchesRequest,
    enumerateProtectedRouteFamilies: routeFamilies.enumerateProtectedRouteFamilies,
    READ_ONLY_METHODS: routeFamilies.READ_ONLY_METHODS,
    FAMILY_PARAM_SAMPLE: routeFamilies.FAMILY_PARAM_SAMPLE,
    // Round-4 review `5cfe851b` B2: the RATIFIED DIMENSIONS were still the
    // drill's own arrays. These three are where production keeps them.
    ACCESS_LEVELS: surfaceService.ACCESS_LEVELS,
    levelAtLeast: surfaceService.levelAtLeast,
    activeGrantCondition: grantService.grantService.activeGrantCondition.bind(grantService.grantService),
    activeProfileCondition: profileService.accessProfileService.activeProfileCondition.bind(profileService.accessProfileService),
    // ROUND-4b REVIEW `252fe7e6`, both findings. The two dimensions the drill
    // still OWNED are now production exports: the INVENTORY of authority seams
    // `surfaceLevel` composes, and the enumeration of delegated bearer layers.
    // Neither is derivable from anywhere the drill writes.
    AUTHORITY_SEAMS: surfaceService.AUTHORITY_SEAMS,
    surfaceLevel: surfaceService.accessSurfaceService.surfaceLevel.bind(surfaceService.accessSurfaceService),
    DELEGATED_BEARER_LAYERS: bearerLayers.DELEGATED_BEARER_LAYERS,
    bearerLayerFor: bearerLayers.bearerLayerFor,
  };
  const missing = Object.entries(contract).filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`the compiled production contract is incomplete: ${missing.join(', ')} — the drill cannot derive its expected sets from a module that does not export them`);
  }
  return contract;
}

/**
 * Compare a supplied dimension against the RATIFIED one, and refuse anything
 * but equality.
 *
 * ROUND-4 REVIEW `5cfe851b` B2. `buildD6Census` and `buildD17Census` accepted
 * ANY caller-state / bearer / store list their caller handed them, so a drill
 * could pass a one-state census and the verdict would report "all 20 contract
 * cells (1 caller states x ...)" and answer `ok:true`. A builder that accepts a
 * reduced dimension is not a contract: it is the drill choosing its own subject
 * with an extra function call in the way.
 */
export function assertRatifiedSet(what, supplied, ratified) {
  const got = [...(supplied ?? [])].map(String).sort();
  const want = [...(ratified ?? [])].map(String).sort();
  if (want.length === 0) throw new Error(`the ratified ${what} could not be derived at all, so no census may be built from it`);
  const missing = want.filter((value) => !got.includes(value));
  const extra = got.filter((value) => !want.includes(value));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`the ${what} handed to this census is not the ratified set: missing [${missing.join(', ')}], not ratified [${extra.join(', ')}]; ratified is [${want.join(', ')}]`);
  }
  return want;
}

/**
 * The ratified ACCESS LEVELS, from production.
 *
 * `backend/src/services/AccessSurfaceService.ts` exports
 * `ACCESS_LEVELS = ['none', 'use', 'configure']` and `levelAtLeast` indexes
 * into it, so this is the same array the arm's own ordering is computed from —
 * not a re-spelling of it. D5's caller table is exactly one caller per level.
 */
export function ratifiedAccessLevels(contract) {
  const levels = [...(contract?.ACCESS_LEVELS ?? [])].map(String);
  if (levels.length === 0 || !levels.includes('none')) {
    throw new Error('production exports no ACCESS_LEVELS containing `none`: the D6 caller states cannot be derived');
  }
  return levels;
}

/**
 * The ratified AUTHORITY STORES — production's own inventory of the seams
 * `surfaceLevel` composes, with the table each one opens read out of the SQL
 * that seam generates.
 *
 * ROUND-4b REVIEW `252fe7e6` B2. The previous form derived each store's TABLE
 * from production and kept WHICH SEAMS EXIST as a two-entry literal in this
 * file, so a reviewer who added a third production seam found nothing went red.
 * Both halves now come from `AccessSurfaceService.AUTHORITY_SEAMS`, and
 * `authoritySeamCompositionDrift` below measures that export against the SQL
 * `surfaceLevel` emits — so a path composed INLINE, without an entry, is red too.
 */
export function ratifiedAuthorityStores(contract) {
  const seams = contract?.AUTHORITY_SEAMS;
  if (!Array.isArray(seams) || seams.length === 0) {
    throw new Error('production exports no AUTHORITY_SEAMS: the authority paths to a surface level cannot be derived, so no D17 matrix may be built');
  }
  const stores = [];
  for (const seam of seams) {
    const store = String(seam?.store ?? '');
    if (!store) throw new Error('an exported authority seam carries no `store` name, so the authority path it opens cannot be named');
    if (typeof seam.condition !== 'function') {
      throw new Error(`the exported authority seam '${store}' carries no condition, so the table it opens cannot be derived`);
    }
    const sql = String(seam.condition(1)?.sql ?? '');
    const table = /\bFROM\s+([a-z_][a-z0-9_]*)/i.exec(sql)?.[1];
    if (!table) throw new Error(`the ${store} seam generates SQL naming no table, so the authority store it opens cannot be derived: ${sql.slice(0, 120)}`);
    stores.push({ store, table });
  }
  const names = new Set(stores.map((entry) => entry.store));
  if (names.size !== stores.length) {
    throw new Error(`production exports ${stores.length} authority seams under ${names.size} distinct names: they cannot be told apart`);
  }
  const tables = new Set(stores.map((entry) => entry.table));
  if (tables.size !== stores.length) {
    throw new Error(`the arm's authority seams name ${tables.size} distinct tables for ${stores.length} stores — they are not independent authority paths: ${stores.map((s) => `${s.store}->${s.table}`).join(', ')}`);
  }
  return stores;
}

/**
 * Does the EXPORTED seam inventory account for every authority path `surfaceLevel`
 * actually opens?
 *
 * The export alone would be a list beside the code; this is the outside anchor
 * that binds it to the code. `surfaceLevel` is run against a queryable that
 * only CAPTURES the statement, and the captured SQL must be exactly the seams'
 * own fragments and nothing else:
 *
 *   1. each exported seam's fragment appears VERBATIM (with the resource-id
 *      placeholder substituted the way the arm substitutes it), twice — the
 *      read clause and the write clause;
 *   2. **the RESIDUE — the statement with every declared fragment removed —
 *      IS EXACTLY the skeleton `seams.length` implies**, whitespace aside.
 *      Not a keyword list and not a word vocabulary: an equality.
 *
 * Clause 2 was a count of `EXISTS (SELECT` openings until this round, and that
 * counted only ONE SHAPE of authority path. Measured, before any reviewer saw it: an
 * `EXISTS` authority path was caught and `$1::uuid IN (SELECT surface_id FROM undeclared_source)`,
 * `$1::uuid = ANY (SELECT …)`, `(SELECT count(*) FROM undeclared_source) > 0` and
 * `(SELECT b.allowed FROM undeclared_source b LIMIT 1)` were all MISSED — four authority paths to
 * a surface level, none of them declared, none of them red. A control that
 * enumerates the shapes someone thought of is not a control (board lesson
 * `stop-making-the-census-complete`), so nothing is enumerated and no list of
 * words or keywords is kept. Round-5 review then showed a WORD VOCABULARY is a
 * census too: `seam(FALSE)` is an undeclared authority path spelled entirely in
 * allowed words. The residue is therefore not inspected at all — it is compared
 * for EQUALITY against the one statement the declared seams imply, so a path of
 * any shape whatsoever changes it.
 *
 * The residue of the shipped composition is
 * `SELECT (( <SEAM> ) OR ( <SEAM> )) AS can_read, (( <SEAM> ) OR ( <SEAM> )) AS can_write`
 * — one `SELECT`, no table, no subquery. An authority path of ANY shape leaves one behind.
 *
 * Returns a (possibly empty) list of problems, plus what it measured.
 */
export async function authoritySeamCompositionDrift(contract) {
  const seams = contract?.AUTHORITY_SEAMS ?? [];
  if (typeof contract?.surfaceLevel !== 'function') {
    return { problems: ['production exports no bound `surfaceLevel`, so the composed SQL cannot be captured at all'], statement: null, expectedExists: 0, actualExists: 0 };
  }
  const captured = [];
  const capturing = {
    query: async (text) => { captured.push(String(text)); return { rows: [{ can_read: false, can_write: false }] }; },
  };
  const PRINCIPAL = '11111111-1111-4111-8111-111111111111';
  const SURFACE = '22222222-2222-4222-8222-222222222222';
  await contract.surfaceLevel(PRINCIPAL, SURFACE, capturing);
  const problems = [];
  if (captured.length !== 1) {
    problems.push(`surfaceLevel issued ${captured.length} statements, not the single composed SELECT this control reads`);
    return { problems, statement: captured[0] ?? null, expectedExists: 0, actualExists: 0 };
  }
  const statement = captured[0];
  const countExists = (text) => (text.match(/EXISTS\s*\(\s*SELECT/gi) ?? []).length;
  // The offsets differ between the read and the write clause, so fragments are
  // matched with their parameter numbers made positional-blind.
  const shape = (text) => String(text).replace(/\$\d+(?!::)/g, '$N');
  // The marker is deliberately NOT a word: round-5 review found a residue made
  // only of ALLOWED words (`seam(FALSE)`) satisfied a vocabulary check, so the
  // marker must be something no SQL identifier can be.
  const SEAM_MARK = '\u0000SEAM\u0000';
  let residue = shape(statement);
  let expectedExists = 0;
  for (const seam of seams) {
    const fragment = String(seam.condition(1)?.sql ?? '').split('<RESOURCE_ID_COLUMN>').join('$1::uuid')
      // A surface has no project perimeter: the project-bounded arm (card
      // 95572530) is FALSE here, exactly as `renderAuthoritySeam` renders it.
      .split('<PROJECT_BOUNDED_ARM>').join('FALSE');
    const occurrences = residue.split(shape(fragment)).length - 1;
    if (occurrences !== 2) {
      problems.push(`the exported seam '${seam.store}' contributes its fragment ${occurrences} time(s) to the composed statement, not the 2 (read + write) \`surfaceLevel\` must compose`);
    }
    residue = residue.split(shape(fragment)).join(SEAM_MARK);
    expectedExists += countExists(fragment) * 2;
  }
  // THE RESIDUE, COMPARED STRUCTURALLY.
  //
  // ROUND-5 REVIEW (half A2, finding B1). The first form of this check asked
  // whether the residue held one `SELECT` and no word outside a closed
  // vocabulary. The reviewer composed `seam(FALSE)` into both clauses -- an
  // undeclared authority path built ENTIRELY out of allowed words, because
  // `seam` was the marker and `false` was the no-seam branch -- and the check
  // passed. A vocabulary is a census of the words someone thought of, which is
  // the defect this whole round exists to end, one rung further in.
  //
  // So nothing is inspected. The residue is compared, whitespace-normalised,
  // against the ONE statement `surfaceLevel` can emit for a given number of
  // exported seams. That skeleton is not a description kept beside the code: it
  // is derived from `seams.length` alone, and what it is compared against is
  // the SQL production really emitted. Anything added, removed or reordered --
  // a subquery, a join, a set membership, a function call, a bare column, an
  // extra output column -- changes it.
  const clauseSkeleton = seams.length === 0
    ? 'FALSE'
    : `(${seams.map(() => `(${SEAM_MARK})`).join(' OR ')})`;
  const expectedResidue = `SELECT ${clauseSkeleton} AS can_read, ${clauseSkeleton} AS can_write`;
  const flatten = (text) => String(text).replace(/\s+/g, ' ').trim();
  const show = (text) => flatten(text).split(SEAM_MARK).join('<SEAM>');
  if (flatten(residue) !== flatten(expectedResidue)) {
    problems.push(`with every declared seam fragment removed, \`surfaceLevel\` composes something other than the ${seams.length}-seam disjunction it declares: got \`${show(residue).slice(0, 240)}\`, expected \`${show(expectedResidue)}\` -- an authority path is composed into \`surfaceLevel\` that AUTHORITY_SEAMS does not declare, or the composition changed shape`);
  }
  const actualExists = countExists(statement);
  if (actualExists !== expectedExists) {
    problems.push(`the composed statement opens ${actualExists} EXISTS subqueries and the ${seams.length} exported seam(s) account for ${expectedExists}: an authority path is composed into \`surfaceLevel\` that AUTHORITY_SEAMS does not declare`);
  }
  return { problems, statement, residue, expectedExists, actualExists };
}

/**
 * The ratified DELEGATED BEARER LAYERS, from production.
 *
 * ROUND-4b REVIEW `252fe7e6` B1: `buildD17Census` took `bearers` AND
 * `ratifiedBearers` and compared one caller argument to the other, both of them
 * built from the drill's own fixture manifest — so a caller that reduced both
 * identically got a smaller census and a green verdict. The ratified side is
 * now `utils/bearerLayers.DELEGATED_BEARER_LAYERS`, which no drill writes.
 */
export function ratifiedBearerLayers(contract) {
  const layers = [...(contract?.DELEGATED_BEARER_LAYERS ?? [])].map(String);
  if (layers.length === 0) {
    throw new Error('production exports no DELEGATED_BEARER_LAYERS: D17 has no ratified bearer dimension and no matrix may be built');
  }
  return layers;
}

/**
 * The access-level FLOOR a family class answers at (design §2.4, ruling I-10),
 * TRANSCRIBED — `use` answers a read family, `configure` answers a write one.
 * The ORDERING is production's (`levelAtLeast` indexes into `ACCESS_LEVELS`);
 * only the two floors are transcribed here, and D2(vii) is what refuses a
 * catalogue where a method and its declared class disagree.
 */
export const CLASS_LEVEL_FLOOR = { read: 'use', write: 'configure' };

/** Does a caller at `level` answer a family of class `klass`? Production's ordering. */
export function levelAnswersClass(contract, level, klass) {
  const floor = CLASS_LEVEL_FLOOR[klass];
  if (!floor) throw new Error(`'${klass}' is not a ratified family class, so no level floor is defined for it`);
  return contract.levelAtLeast(String(level), floor) === true;
}

/**
 * The class a METHOD puts a family in, per sitting ruling I-10 (record
 * `83defda6`) as the production module spells it: `use` is READ-ONLY, so a
 * read family carries a read-only method and every state-changing method is a
 * write family. Derived from the production set, never re-spelled here.
 */
export function familyClassForMethod(contract, method) {
  return contract.READ_ONLY_METHODS.has(String(method).toUpperCase()) ? 'read' : 'write';
}

/**
 * The families one catalogue ROW declares, with the class the row puts each in
 * AND the class the METHOD puts it in — which must agree.
 *
 * The two derivations are independent on purpose: `read_families` /
 * `write_families` is the catalogue's claim, `READ_ONLY_METHODS` is the route
 * map's. D2(vii) is the boot census that refuses a catalogue where they
 * disagree; this is the drill-side control that refuses to BUILD a census from
 * one, so a hostile row inserted by SQL cannot quietly redefine what a cell
 * means.
 */
export function declaredFamilies(contract, surfaceRow) {
  const out = [];
  const problems = [];
  for (const [klass, keys] of [['read', surfaceRow.read_families ?? surfaceRow.readFamilies ?? []],
    ['write', surfaceRow.write_families ?? surfaceRow.writeFamilies ?? []]]) {
    for (const key of keys) {
      const parsed = contract.parseFamilyKey(key);
      if (!parsed) { problems.push(`${surfaceRow.key}: '${key}' is not a family key`); continue; }
      const byMethod = familyClassForMethod(contract, parsed.method);
      if (byMethod !== klass) {
        problems.push(`${surfaceRow.key}: '${key}' sits in ${klass}_families but its method makes it a ${byMethod} family (I-10 / D2(vii))`);
        continue;
      }
      const route = contract.familySamplePath(parsed.path);
      out.push({
        surfaceKey: surfaceRow.key,
        familyKey: key,
        familyClass: klass,
        method: parsed.method,
        /** The concrete URL a probe of this family must request. */
        route,
        /** That URL in the ONE canonical form production compares with. */
        path: contract.normalizePathForScope(route),
      });
    }
  }
  if (problems.length > 0) {
    throw new Error(`the catalogue disagrees with the route map, so no expected census can be built from it: ${problems.join('; ')}`);
  }
  return out;
}

/** Every declared family of every row in `governance`, in a stable order. */
export function familiesOfClass(contract, surfaceRows, governance) {
  return (surfaceRows ?? [])
    .filter((row) => row.governance === governance)
    .flatMap((row) => declaredFamilies(contract, row))
    .sort((a, b) => `${a.surfaceKey} ${a.familyKey}`.localeCompare(`${b.surfaceKey} ${b.familyKey}`));
}

/**
 * The level a caller in `callerState` holds over `surfaceKey`, derived from the
 * `access_bundle_members` ROWS rather than from anything the drill declares.
 *
 * This is the whole of §3.4 that D6 needs: assigning a bundle's `use` or
 * `configure` profile moves the caller's level on the surfaces that bundle
 * CARRIES, and on no others. Owner ruling `70af4d82` §1.1 removed #15/#17/#18
 * from every bundle, so those stay at `none` in all three caller states — and
 * that fact is read out of the rows here, not asserted.
 */
export function levelResolverFromMembership(memberRows, bundleKey) {
  const carried = new Set((memberRows ?? [])
    .filter((row) => String(row.bundleKey) === bundleKey)
    .map((row) => String(row.surfaceKey)));
  const resolve = (callerState, surfaceKey) => (carried.has(String(surfaceKey)) ? callerState : 'none');
  resolve.carried = carried;
  return resolve;
}

/**
 * D6's census: for each caller state, each `governable` surface, and each
 * DECLARED family — the annex's "for each caller in D5's table and each `G`
 * surface and each declared family".
 *
 * Each cell carries the exact METHOD and canonical PATH a conforming probe must
 * have used. That is what makes the label unnecessary: an observation is
 * matched to a cell by (caller state, surface key, family key) and then its
 * ACTUAL request must equal the cell's — so six records naming six different
 * cells while all issuing one physical `GET /webhooks` (finding `2bf39bb7`)
 * match one cell and fail the other five on method or path.
 */
export function buildD6Census(contract, { surfaceRows, callerStates, levelFor, excludeSurfaceKeys = [] }) {
  // ROUND-4 REVIEW `5cfe851b` B2: the caller states must BE production's
  // ratified access levels, not whatever the drill passed.
  assertRatifiedSet('D6 caller states', callerStates, ratifiedAccessLevels(contract));
  // THE ONE EXCLUSION, AND IT IS THE OWNER'S, NOT THE DRILL'S.
  //
  // Owner ruling `70af4d82` §1.1 took the three authority-mutation surfaces
  // (#15, #17, #18) OUT OF THE ARM ENTIRELY: `evaluateSurfaceStage` returns the
  // ratified ROOT refusal for them at step 4b, before a level is computed, so
  // their behaviour is unchanged from before SETGOV. D6 asserts the SURFACE
  // STAGE'S OWN shape - the 404 concealment and the 403 naming the surface -
  // and asserting it on a family the ruling removed from the arm would assert
  // the opposite of what the ruling ratified. Those families are D21(iii)'s,
  // exactly as annex D6's last sentence says ("Families whose handler applies
  // rule 4 to a Group target are D21's, not D6's"), and D21(iii)'s withheld
  // family sweep measures EVERY one of them rather than the five acts alone.
  //
  // The exclusion is passed in, never assumed here, so the drill must name the
  // ruling's list and the two sets can be checked to partition the governable
  // catalogue between them.
  const excluded = new Set((excludeSurfaceKeys ?? []).map(String));
  const cells = [];
  for (const family of familiesOfClass(contract, surfaceRows, 'governable')) {
    if (excluded.has(family.surfaceKey)) continue;
    for (const callerState of callerStates) {
      cells.push({
        key: `${callerState}|${family.surfaceKey}|${family.familyKey}`,
        callerState,
        level: levelFor(callerState, family.surfaceKey),
        ...family,
      });
    }
  }
  return cells;
}

/**
 * D10's census: EVERY route of EVERY `locked` surface.
 *
 * The annex names both `/identity-providers` and `/notification-endpoints`;
 * round 3 found the drill capturing only the first (`2a8087c3`), and the
 * comparator had no expected set at all, so dropping a whole locked surface
 * stayed green. The set is read from the catalogue's `locked` rows, so a
 * ratified third locked surface is covered the day it is seeded.
 */
export function buildLockedCensus(contract, surfaceRows) {
  const families = familiesOfClass(contract, surfaceRows, 'locked');
  if (families.length === 0) {
    throw new Error('the catalogue declares no locked surface at all: D10 has no subject');
  }
  return families.map((family) => ({ label: family.familyKey, ...family }));
}

/**
 * D17's census: bearer x authority store x family class, over one core
 * governable surface.
 *
 * Round 3 (`1324ba78`) found the drill installing the grant AND the profile
 * assignment simultaneously, so a defect isolated to either store could not be
 * attributed, and the oracle accepting whatever subset it was handed. Each cell
 * below is a SEPARATE run with exactly ONE store armed.
 */
export function buildD17Census(contract, { surfaceRow, bearers, stores }) {
  // ROUND-4 REVIEW `5cfe851b` B2 and ROUND-4b REVIEW `252fe7e6` B1/B2. BOTH
  // ratified dimensions come from production and neither from the caller: the
  // stores are the seams `AUTHORITY_SEAMS` declares (and
  // `authoritySeamCompositionDrift` binds that declaration to the SQL
  // `surfaceLevel` emits), and the bearer layers are
  // `DELEGATED_BEARER_LAYERS`. This builder no longer accepts a
  // `ratifiedBearers` argument at all — an equality whose ratified side is
  // supplied by the party it judges is not a check.
  assertRatifiedSet('D17 authority stores', stores, ratifiedAuthorityStores(contract).map((entry) => entry.store));
  assertRatifiedSet('D17 bearer layers', bearers, ratifiedBearerLayers(contract));
  const families = declaredFamilies(contract, surfaceRow);
  const byClass = new Map();
  for (const family of families) if (!byClass.has(family.familyClass)) byClass.set(family.familyClass, family);
  const missing = FAMILY_CLASSES.filter((klass) => !byClass.has(klass));
  if (missing.length > 0) {
    throw new Error(`D17 needs a ${missing.join(' and ')} family on '${surfaceRow.key}' and the catalogue declares none`);
  }
  const cells = [];
  for (const bearer of bearers) {
    for (const store of stores) {
      for (const klass of FAMILY_CLASSES) {
        const family = byClass.get(klass);
        cells.push({
          key: `${bearer}|${store}|${klass}`,
          bearer, store, familyClass: klass,
          surfaceKey: surfaceRow.key, familyKey: family.familyKey,
          method: family.method, route: family.route, path: family.path,
        });
      }
    }
  }
  return cells;
}

/**
 * D17's PLUGIN census: the core matrix x EVERY ratified access level.
 *
 * ROUND-4 extra verdict `36e8588e` B3. The plugin half exercised `none` and
 * `configure` and never `use`, so the middle rung of the ordering the arm is
 * FOR — the one place `read` and `write` families must answer differently —
 * was unmeasured on the surface origin where the arm only narrows. The levels
 * are production's `ACCESS_LEVELS` (a drill that drops one goes red in
 * `assertRatifiedSet`), and each cell carries the admission the ORDERING
 * requires, computed with production's own `levelAtLeast`.
 */
export function buildPluginLevelCensus(contract, { coreCells, levels }) {
  assertRatifiedSet('D17 plugin access levels', levels, ratifiedAccessLevels(contract));
  const cells = [];
  for (const cell of coreCells ?? []) {
    for (const level of levels) {
      cells.push({
        ...cell,
        key: `${cell.key}|${level}`,
        coreKey: cell.key,
        level,
        expectAdmitted: levelAnswersClass(contract, level, cell.familyClass),
      });
    }
  }
  if (cells.length === 0) {
    throw new Error('the plugin level census is empty: it is built from the core D17 matrix and that matrix has no cells');
  }
  return cells;
}

/** The distinct URLs D17's session control must be ADMITTED on. */
export function d17ControlUrls(cells) {
  const seen = new Map();
  for (const cell of cells) seen.set(`${cell.method} ${cell.path}`, { method: cell.method, route: cell.route, path: cell.path });
  return [...seen.values()];
}

/**
 * D21(ii)'s required attempt multiset: EVERY withheld surface through EVERY
 * write store.
 *
 * Round 3 (`2eb2061c`) found the oracle passing on one refusal covering only
 * #15 plus an unrelated `GET /health` 200. The surface keys come from the
 * ruling's transcription in `setgov-drill-oracles.mjs`, never from the seed.
 */
export function buildD21WriteCensus(withheldSurfaceKeys, stores = D21_WRITE_STORES) {
  const keys = [...(withheldSurfaceKeys ?? [])].sort();
  if (keys.length === 0) throw new Error('D21(ii) has no withheld surfaces to attempt');
  return stores.flatMap((store) => keys.map((surfaceKey) => ({ key: `${store}|${surfaceKey}`, store, surfaceKey })));
}

/**
 * A hostile corpus for the normaliser drift control: every spelling round 3
 * broke `armRecordExcludes` with (`e3f57d06`), plus the shapes the audit
 * correlation depends on.
 */
export const CANONICAL_PATH_CORPUS = [
  '/tasks', '/TASKS', '//tasks', '/tasks?x=1', '/tasks/', '/tasks//', '//TASKS//?a=b&c=d',
  '/Tasks/Sub', '/', '', '//', '/webhooks/00000000-0000-4000-8000-000000000000',
  '/GROUPS/11111111-1111-4111-8111-111111111111/Members?x=1',
  '/access-profiles/what-if', '/appearance/asset-history/:kind', '/a/b/c/d/e',
];

/**
 * Does the drill-layer normaliser still agree with production's?
 *
 * `setgov-drill-oracles.mjs` carries its own `canonicalPath` so the oracles stay
 * pure functions with no build dependency — and a re-implementation is exactly
 * the drift the board has been bitten by. This is the outside anchor: the two
 * are compared over the hostile corpus every time the live drill runs and every
 * time the oracle suite runs against a built tree.
 */
export function normaliserDrift(contract, canonicalPath, corpus = CANONICAL_PATH_CORPUS) {
  const drifted = [];
  for (const input of corpus) {
    const mine = canonicalPath(input);
    const theirs = contract.normalizePathForScope(input);
    if (mine !== theirs) drifted.push(`'${input}' -> drill '${mine}' vs production '${theirs}'`);
  }
  return drifted;
}

/**
 * Is every family the catalogue declares a route the protected registry
 * actually SERVES?
 *
 * The boot census (D2) is the review-time control for this; running it here
 * makes the drill's own probe list answerable to the registry too, so a probe
 * addressed at a route no router serves cannot be counted as an observation of
 * anything. Enumerating the registry constructs the routers; it starts no
 * listener and opens no connection.
 */
export function familiesAbsentFromRegistry(contract, families) {
  const served = contract.enumerateProtectedRouteFamilies();
  const keys = new Set(served.map((entry) => entry.key));
  return (families ?? []).filter((family) => !keys.has(family.familyKey)).map((family) => `${family.surfaceKey}: ${family.familyKey}`);
}

/**
 * Parse migration 109's seeded catalogue — the Access surfaces and the Access
 * bundle memberships — out of the SQL text.
 *
 * WHY A PARSER AND NOT A CONSTANT. The live drill reads the catalogue from the
 * DATABASE, because that is where the arm reads it; the census printer must run
 * with no database at all, because a reviewer sandbox has neither `psql` nor
 * `docker` (this is a standing harness fact, not an inconvenience). Parsing the
 * migration gives both the same source, and the live drill ASSERTS the two
 * agree — so a database that drifted from the migration in the tree is caught
 * rather than assumed away, and neither side is trusted alone.
 *
 * This is deliberately NOT the control for owner ruling `70af4d82` §1.1's
 * membership: `backend/src/__tests__/accessSurfaces.test.ts` proves the
 * COMPLETE set of `access_bundle_members` writes with its own independent
 * extraction (finding `c179b66b`), and two independent derivations that must
 * agree is the point.
 */
export function parseSeededCatalogue(sql) {
  // Comments FIRST. Migration 109's are prose, and prose carries the very
  // characters this parser tracks - unbalanced parentheses, apostrophes,
  // brackets. A parser that read them would silently mis-slice the VALUES list
  // and hand every expected set below a short catalogue, which is exactly the
  // kind of quiet under-measurement round 3 was full of.
  const text = stripSqlComments(String(sql ?? ''));
  const anchor = text.indexOf('INSERT INTO access_surfaces');
  if (anchor < 0) throw new Error('migration 109 seeds no access_surfaces rows: the catalogue cannot be parsed');
  const valuesAt = text.indexOf('VALUES', anchor);
  const surfaceRows = [];
  for (const group of topLevelGroups(text.slice(valuesAt + 'VALUES'.length))) {
    const fields = topLevelFields(group);
    if (fields.length < 7) continue;
    const key = unquote(fields[0]);
    if (key === null || !key.startsWith('settings.')) break;
    surfaceRows.push({
      key,
      label: unquote(fields[1]),
      governance: unquote(fields[2]),
      read_families: sqlArray(fields[4]),
      write_families: sqlArray(fields[5]),
    });
  }
  if (surfaceRows.length === 0) throw new Error('migration 109 parsed to zero surfaces: the parser and the migration have diverged');

  const memberRows = [];
  const bundleAt = /\b(?:ELS)?IF\s+bundle_key\s*=\s*'([a-z-]+)'/g;
  const bundles = [];
  let hit;
  while ((hit = bundleAt.exec(text)) !== null) bundles.push({ index: hit.index, bundleKey: hit[1] });
  const insertAt = /INSERT INTO access_bundle_members\b/g;
  while ((hit = insertAt.exec(text)) !== null) {
    const statement = text.slice(hit.index, indexOrEnd(text, ';', hit.index));
    const owner = [...bundles].reverse().find((bundle) => bundle.index < hit.index);
    if (!owner) throw new Error('an access_bundle_members INSERT sits outside every bundle branch: its membership cannot be attributed');
    const inList = /s\.key\s+IN\s*\(([^)]*)\)/.exec(statement);
    if (!inList) throw new Error(`the ${owner.bundleKey} membership INSERT names no surface keys in a form this parser reads`);
    for (const raw of inList[1].split(',')) {
      const key = unquote(raw.trim());
      if (key) memberRows.push({ bundleKey: owner.bundleKey, surfaceKey: key });
    }
  }
  return { surfaceRows, memberRows };
}

function indexOrEnd(text, needle, from) {
  const at = text.indexOf(needle, from);
  return at < 0 ? text.length : at;
}

/** The top-level `( ... )` groups of a VALUES list, quotes and brackets respected. */
function topLevelGroups(text) {
  const groups = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") { quoted = true; continue; }
    if (ch === '(' || ch === '[') { if (depth === 0 && ch === '(') start = i + 1; depth += 1; continue; }
    if (ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) { groups.push(text.slice(start, i)); start = -1; }
      if (depth < 0) return groups;
      continue;
    }
    if (ch === ';' && depth === 0) return groups;
  }
  return groups;
}

/** The top-level comma-separated fields of one VALUES group. */
function topLevelFields(group) {
  const fields = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < group.length; i += 1) {
    const ch = group[i];
    if (quoted) { if (ch === "'") quoted = false; continue; }
    if (ch === "'") { quoted = true; continue; }
    if (ch === '(' || ch === '[') { depth += 1; continue; }
    if (ch === ')' || ch === ']') { depth -= 1; continue; }
    if (ch === ',' && depth === 0) { fields.push(group.slice(start, i).trim()); start = i + 1; }
  }
  fields.push(group.slice(start).trim());
  return fields;
}

/** `'settings.webhooks'` -> `settings.webhooks`; anything else -> null. */
function unquote(field) {
  const match = /^'((?:[^']|'')*)'/.exec(String(field ?? '').trim());
  return match ? match[1].replace(/''/g, "'") : null;
}

/** `ARRAY['GET /x', 'POST /x']` or `'{}'` -> a list of family keys. */
function sqlArray(field) {
  const text = String(field ?? '').trim();
  if (/^'\{\s*\}'$/.test(text) || text === "'{}'") return [];
  const inner = /^ARRAY\s*\[([\s\S]*)\]$/.exec(text);
  if (!inner) return [];
  return [...inner[1].matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'"));
}

/**
 * Drop SQL comments, leaving quoted text alone.
 *
 * Comments FIRST, and this is not fussiness: migration 109's comments are
 * PROSE, and prose carries the very characters the slicers below track —
 * unbalanced parentheses ("(`GET /` at the API root ...)"), apostrophes,
 * brackets. A parser that read them would silently mis-slice the VALUES list
 * and hand every expected set a SHORT catalogue, which is exactly the quiet
 * under-measurement rounds 2 and 3 were full of.
 */
function stripSqlComments(text) {
  const NEWLINE = String.fromCharCode(10);
  let out = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      out += ch;
      if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") { quoted = true; out += ch; continue; }
    if (ch === '-' && text[i + 1] === '-') {
      const nl = text.indexOf(NEWLINE, i);
      if (nl < 0) break;
      out += NEWLINE;
      i = nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    out += ch;
  }
  return out;
}
