// The controls for the SETGOV drill oracles — run with `node --test`.
//
// Every control hands the oracle the EXACT bad state its drill's red mutation
// produces and requires it to go red, beside the good state that must pass. An
// oracle that accepted both would be the recorded-but-never-judged value that
// `cba66ebb` and `533db731` were, one altitude up.
//
// Two shapes are guarded here that this board has been bitten by before:
//   - a vacuous pass (a capture of nothing, an arm never invoked, a control
//     that refuses on both sides) is REFUSED by the oracle, not accepted;
//   - a mutation must redden a DIFFERENT assertion from its neighbours
//     (annex §8.1), so each control below names the one it moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARM_TRACE_PREFIX,
  actSignature,
  armRecordExcludes,
  writeOperationSignature,
  canonicalPath,
  pluginBearerNarrowsOnly,
  stableJson,
  bearerNeverWidensCore,
  bootAccepted,
  bootRefused,
  capturesIdentical,
  d6Verdict,
  exactlyOneDecisionMoved,
  isSurfaceStageRefusal,
  levelAnswers,
  refusalsAudited,
  surfaceStageShape,
  authorityMutationArmNeverAdmits,
  authorityMutationSurfacesUnbundled,
  authorityMutationWritesRefused,
  escalationCaptureRefused,
  governableCatalogueIsPartitioned,
  RATIFIED_ESCALATION_ACTS,
  isAuthorizationDecision,
  decisionRecordDefect,
  decisionDefect,
  ADMINISTRATIVE_MEMBER_KEYS,
  AUTHORITY_MUTATION_CODE,
  AUTHORITY_MUTATION_REFUSAL_ACT,
  AUTHORITY_MUTATION_SURFACE_KEYS,
  RULE_FOUR_ARM_CARD,
  SURFACE_LEVEL_INSUFFICIENT,
  SURFACE_REFUSAL_ACT,
  tookEffectImmediately,
} from './setgov-drill-oracles.mjs';

const named403 = { status: 403, code: SURFACE_LEVEL_INSUFFICIENT, message: "Changing 'Webhooks' requires the access level configure" };
const bare403 = { status: 403, code: 'FORBIDDEN', message: 'This identity is not authorized for the requested operation' };
const concealed = { status: 404, code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' };
const ok200 = { status: 200 };

test('shape: the four surface-stage answers classify apart', () => {
  assert.equal(surfaceStageShape(ok200), 'admitted');
  assert.equal(surfaceStageShape(concealed), 'concealed');
  assert.equal(surfaceStageShape(named403), 'level-insufficient');
  assert.equal(surfaceStageShape(bare403), 'route-refusal');
  assert.equal(isSurfaceStageRefusal('route-refusal'), false);
});

test('shape CONTROL: a 403 carrying the named code but NO message is not "naming the surface"', () => {
  // AZ-A5's shape is "403 NAMING THE SURFACE". A code with an empty sentence
  // is the concealment-by-accident the write arm exists to avoid.
  assert.equal(surfaceStageShape({ status: 403, code: SURFACE_LEVEL_INSUFFICIENT, message: '   ' }), 'route-refusal');
});

test('levels: `use` answers reads only — ruling I-10', () => {
  assert.equal(levelAnswers('use', 'read'), true);
  assert.equal(levelAnswers('use', 'write'), false);
  assert.equal(levelAnswers('configure', 'write'), true);
  assert.equal(levelAnswers('none', 'read'), false);
});

// ── D6 ──────────────────────────────────────────────────────────────────────

/**
 * ROUND-4 (finding `2bf39bb7`). `d6Verdict` no longer reads an observation's
 * `level` / `family` LABELS: it takes a CONTRACT CENSUS built from the
 * catalogue rows the arm reads, matches each observation to a cell, and then
 * requires the observation's ACTUAL request to equal the cell's. The fixture
 * below is that census in miniature — one governable surface, one read family,
 * one write family, all three caller states — in exactly the shape
 * `setgov-drill-contract.buildD6Census` produces. A fixture thinner than the
 * real census would hide the gate it exists to prove.
 */
const D6_FAMILIES = [
  { familyKey: 'GET /webhooks', familyClass: 'read', method: 'GET', path: '/webhooks' },
  { familyKey: 'POST /webhooks', familyClass: 'write', method: 'POST', path: '/webhooks' },
];
const d6Census = ['none', 'use', 'configure'].flatMap((callerState) => D6_FAMILIES.map((family) => ({
  key: `${callerState}|settings.webhooks|${family.familyKey}`,
  callerState, level: callerState, surfaceKey: 'settings.webhooks', ...family,
})));
/**
 * A D6 observation as the drill now records it: the request, the answer, AND
 * the number of `surface.refused` rows that request added to the ledger.
 *
 * That last field is what says WHICH STAGE answered. §9.6's concealment is
 * `404 RESOURCE_NOT_FOUND` precisely so a caller cannot tell it from the
 * resource being absent, so the status code cannot decide it and a fixture
 * without the ledger delta would hide the very ambiguity this gate exists for.
 * `surfaceRefusalRows` defaults to the number the ratified behaviour writes:
 * one when the level is insufficient, none when it is sufficient.
 */
const d6Cell = (callerState, familyClass, answer, surfaceRefusalRows) => {
  const family = D6_FAMILIES.find((entry) => entry.familyClass === familyClass);
  const sufficient = levelAnswers(callerState, familyClass);
  return {
    label: `${callerState}/${familyClass}`, callerState, surfaceKey: 'settings.webhooks',
    familyKey: family.familyKey, method: family.method, route: family.path,
    surfaceRefusalRows: surfaceRefusalRows ?? (sufficient ? 0 : 1),
    ...answer,
  };
};
const d6 = (observations, census = d6Census) => d6Verdict(observations, { census });

const d6Good = [
  d6Cell('configure', 'write', ok200),
  d6Cell('configure', 'read', ok200),
  d6Cell('use', 'read', ok200),
  d6Cell('use', 'write', named403),
  d6Cell('none', 'read', concealed),
  d6Cell('none', 'write', concealed),
];

test('D6: the ratified shape appears exactly when the level is insufficient', () => {
  const verdict = d6(d6Good);
  assert.equal(verdict.ok, true, verdict.reason);
});

test('D6 RED (the annex mutation: skip the surface stage): an insufficient caller reaches the handler', () => {
  // The annex's mutation removes the stage, so BOTH of its traces go: the
  // answer is a 2xx and no `surface.refused` row is written.
  const verdict = d6(d6Good.map((o) => (o.label === 'none/read'
    ? { ...o, ...ok200, surfaceRefusalRows: 0 } : o)));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /wrote NO refusal row/);
});

test('D6 RED: a SUFFICIENT caller refused by the surface stage is equally a failure', () => {
  const verdict = d6(d6Good.map((o) => (o.label === 'use/read'
    ? { ...o, ...concealed, surfaceRefusalRows: 1 } : o)));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /is sufficient/);
});

test('D6 RED: the wrong refusal shape — concealing a write family the caller may read', () => {
  const verdict = d6(d6Good.map((o) => (o.label === 'use/write' ? { ...o, ...concealed } : o)));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /expected level-insufficient, observed concealed/);
});

test('D6 RED: leaking the surface name to a caller at `none` is a failure too', () => {
  const verdict = d6(d6Good.map((o) => (o.label === 'none/write' ? { ...o, ...named403 } : o)));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /expected concealed, observed level-insufficient/);
});

test('D6 VACUITY: a census the drill named for ITSELF is refused', () => {
  const verdict = d6Verdict(d6Good, {});
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no contract census/);
});

test('D6 VACUITY: a drill that observed nothing does not pass', () => {
  assert.equal(d6([]).ok, false);
});

// ── D1 / D10 / D19 ──────────────────────────────────────────────────────────

/** A capture entry as the drill now records it: the DECISION, plus the answer
 * it was derived from. Regression `ff9b6437`: the old fixture was a bare
 * status, which is a response SHAPE, and two identical 500s passed as two
 * identical decisions. A fixture thinner than the real record hides that. */
const decisionRecord = (label, admitted, status, code) => ({ label, admitted, evidence: { status, code } });
const admittedNow = (entry) => ({ ...entry, admitted: true, evidence: { status: 200, code: null } });

/**
 * ROUND-4 (finding `2a8087c3`). `capturesIdentical` now REQUIRES a
 * contract-owned label set, so a capture that silently dropped a whole ratified
 * locked surface cannot compare a short list to a short list. These
 * pre-existing controls are about the DECISION comparison, so they hand it the
 * baseline's own labels; the label gate has its own controls further down,
 * where the set is deliberately wrong.
 */
const identical = (baseline, candidate, options = {}) => capturesIdentical(baseline, candidate, {
  expectedLabels: (baseline ?? []).map((row, i) => String(row?.label ?? i)),
  ...options,
});

const capture = [
  decisionRecord('GET /webhooks', false, 404, 'RESOURCE_NOT_FOUND'),
  decisionRecord('POST /webhooks', false, 404, 'RESOURCE_NOT_FOUND'),
  decisionRecord('GET /grants', false, 403, 'FORBIDDEN'),
];

test('D1/D10/D19: identical captures pass', () => {
  assert.equal(identical(capture, capture.map((c) => ({ ...c }))).ok, true);
});

test('D1 RED (a `default_level` column the evaluator reads): one decision moves', () => {
  const after = capture.map((c) => (c.label === 'GET /webhooks' ? admittedNow(c) : c));
  const verdict = identical(capture, after);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /GET \/webhooks/);
});

test('D19 RED: a wildcard surface grant honoured by the evaluator moves EVERY decision', () => {
  const after = capture.map((c) => admittedNow(c));
  assert.equal(identical(capture, after).ok, false);
});

test('VACUITY: an empty capture cannot be "identical" to anything', () => {
  // Two gates now, and they answer two questions. An empty EXPECTED set means
  // the caller declared no contract at all; an empty BASELINE against a real
  // expected set means the capture measured nothing.
  const noContract = identical([], []);
  assert.equal(noContract.ok, false);
  assert.match(noContract.reason, /EMPTY expected label set/);
  const measuredNothing = capturesIdentical([], [], { minimum: 1, expectedLabels: ['GET /webhooks'] });
  assert.equal(measuredNothing.ok, false);
  assert.match(measuredNothing.reason, /required label\(s\) absent/);
});

test('D19 positive control: an `exact` grant moves exactly the surface it names', () => {
  const after = capture.map((c) => (c.label === 'GET /grants' ? admittedNow(c) : c));
  assert.equal(exactlyOneDecisionMoved(capture, after, 'GET /grants').ok, true);
});

test('D19 positive-control RED: a grant that moves NOTHING fails the control', () => {
  const verdict = exactlyOneDecisionMoved(capture, capture, 'GET /grants');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /exactly one decision to move, 0 did/);
});

test('D19 positive-control RED: a grant that moves a DIFFERENT surface fails', () => {
  const after = capture.map((c) => (c.label === 'GET /webhooks' ? admittedNow(c) : c));
  const verdict = exactlyOneDecisionMoved(capture, after, 'GET /grants');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /'GET \/webhooks' did/);
});

// ── D16 ─────────────────────────────────────────────────────────────────────

const armLines = [
  `${ARM_TRACE_PREFIX} /webhooks settings.webhooks`,
  `${ARM_TRACE_PREFIX} /grants settings.access-grants`,
  'some unrelated server log line',
];

test('D16: the arm record names no scope-gated family', () => {
  assert.equal(armRecordExcludes(armLines, ['/tasks']).ok, true);
});

test('D16 RED (move the arm above the `required !== root` refusal): /tasks appears', () => {
  const verdict = armRecordExcludes([...armLines, `${ARM_TRACE_PREFIX} /tasks hostile.fixture`], ['/tasks']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /scope-gated \/tasks/);
});

test('D16 RED: a sub-path of a scope-gated family counts', () => {
  assert.equal(armRecordExcludes([`${ARM_TRACE_PREFIX} /tasks/abc hostile.fixture`], ['/tasks']).ok, false);
});

test('D16 VACUITY (the v2.0 form the reviewer proved empty): an arm never invoked does not pass', () => {
  const verdict = armRecordExcludes(['nothing here'], ['/tasks']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /never invoked/);
});

// ── D13, the shape of "took effect" (round-1 regression `4181cb84`) ─────────

test('D13 RED (round 1, reviewer input): an HTTP 500 is NOT a revocation', () => {
  // The reviewer's exact input: before=200, after=500. The oracle passed,
  // reporting "refused on the very next request". A crash is not a refusal.
  const verdict = tookEffectImmediately({ before: ok200, after: { status: 500, code: 'INTERNAL_ERROR' } });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /SERVER ERROR/);
});

test('D13 CONTROL: the ratified refusal shapes still pass, 401 included', () => {
  // A disabled Account is refused by the AUTHENTICATION stage, so 401 is the
  // expected answer here. D17 excludes 401 for the opposite reason.
  for (const after of [concealed, bare403, { status: 401, code: 'UNAUTHORIZED' }]) {
    const verdict = tookEffectImmediately({ before: ok200, after });
    assert.equal(verdict.ok, true, `${after.status}: ${verdict.reason}`);
  }
});

test('D13 RED: a 2xx after the disable is the failure this drill exists for', () => {
  const verdict = tookEffectImmediately({ before: ok200, after: ok200 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /still succeeded/);
});

// ── D17 ─────────────────────────────────────────────────────────────────────

/**
 * ROUND-4 (finding `1324ba78`). `bearerNeverWidensCore` takes the CONTRACT
 * MATRIX — bearer x authority store x family class — because round 3's form
 * validated whatever subset it was handed: ONE Connector GET refusal plus ONE
 * matched session GET returned `ok:true`. The fixture is the shape
 * `setgov-drill-contract.buildD17Census` produces, and it is COMPLETE, so a
 * control that removes a cell reddens for the reason it is about.
 */
const D17_BEARERS = ['connector', 'agent'];
const D17_STORES = ['surface-grant', 'profile-assignment'];
const d17Census = D17_BEARERS.flatMap((bearer) => D17_STORES.flatMap((store) => D6_FAMILIES.map((family) => ({
  key: `${bearer}|${store}|${family.familyClass}`,
  bearer, store, familyClass: family.familyClass,
  surfaceKey: 'settings.webhooks', familyKey: family.familyKey,
  method: family.method, route: family.path, path: family.path,
}))));
const bearerRefused = d17Census.map((cell) => ({
  label: `${cell.bearer} via ${cell.store}: ${cell.method} ${cell.route}`,
  bearer: cell.bearer, store: cell.store, familyClass: cell.familyClass,
  method: cell.method, route: cell.route, ...concealed,
}));
const sessionAdmitted = [
  { label: 'account session GET /webhooks', method: 'GET', route: '/webhooks', ...ok200 },
  { label: 'account session POST /webhooks', method: 'POST', route: '/webhooks', ...ok200 },
];
const reachOk = { status: 200 };
const d17 = (overrides = {}) => bearerNeverWidensCore({
  bearerObservations: bearerRefused, sessionObservations: sessionAdmitted,
  bearerReach: reachOk, census: d17Census, ...overrides,
});

test('D17: every matrix cell refused, session control admitted on the same URLs', () => {
  const verdict = d17();
  assert.equal(verdict.ok, true, verdict.reason);
});

test('D17 CONTROL-OF-THE-CONTROL: a credential that never authenticated cannot pass on its 401s', () => {
  // Observed on this drill's first run: the server ran on a different NODE_ENV
  // than the seeder, every `rh_dev_...` key answered 401, and four refusals
  // looked exactly like four proofs.
  const verdict = d17({
    bearerObservations: bearerRefused.map((o) => ({ ...o, status: 401, code: undefined })),
    bearerReach: { status: 401 },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /never authenticated/);
});

test('D17 RED (remove the origin===core authentication-kind check): a bearer reaches the family', () => {
  const verdict = d17({
    bearerObservations: bearerRefused.map((o, i) => (i === 0 ? { ...o, ...ok200 } : o)),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not an authorization refusal/);
});

test('D17 VACUITY: without the same-run session control the drill proves only that rows are absent', () => {
  const verdict = d17({ sessionObservations: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /only that the authority rows are absent/);
});

test('D17 CONTROL-OF-THE-CONTROL: a session control that itself refuses invalidates the drill', () => {
  const verdict = d17({ sessionObservations: sessionAdmitted.map((o) => ({ ...o, ...concealed })) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no same-run session control ADMITTED on the identical URL/);
});

test('D17 RED (round 1, reviewer input): bearer HTTP 500s are not refusals', () => {
  // The reviewer's exact input. "Not admitted" was the whole test, so a server
  // erroring on every request passed D17 (regression `f4a8c185`).
  const verdict = d17({ bearerObservations: bearerRefused.map((o) => ({ ...o, status: 500, code: 'INTERNAL_ERROR' })) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /SERVER ERROR/);
});

test('D17 RED (round 1, reviewer input): a session 200 on an UNRELATED URL is not a control', () => {
  // The reviewer supplied one 200 on /appearance against bearer requests on
  // /webhooks; the old reason string claimed "same URLs" regardless.
  const verdict = d17({
    sessionObservations: [{ label: 'session GET /appearance', method: 'GET', route: '/appearance', ...ok200 }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /identical URL/);
});

test('`1324ba78` RED (reviewer input): ONE Connector GET refusal plus ONE matched session GET is not the matrix', () => {
  // The A2 round-3 probe's exact input. The old oracle answered `ok:true` with
  // "1 bearer requests refused..." — a subset of one store, one bearer and one
  // family class read as the whole contract.
  const verdict = d17({ bearerObservations: [bearerRefused[0]] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /matrix cells were never exercised/);
});

test('`1324ba78` RED: dropping ONE authority store leaves a defect in it unattributable', () => {
  const verdict = d17({ bearerObservations: bearerRefused.filter((o) => o.store !== 'profile-assignment') });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /profile-assignment/);
});

test('`1324ba78` RED: dropping the WRITE family class leaves I-10 unmeasured for bearers', () => {
  const verdict = d17({ bearerObservations: bearerRefused.filter((o) => o.familyClass !== 'write') });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /never exercised/);
});

test('`1324ba78` RED: a cell claimed twice cannot stand in for a cell never run', () => {
  const dropped = bearerRefused.filter((o) => o.key !== undefined || true).slice(1);
  const verdict = d17({ bearerObservations: [bearerRefused[0], bearerRefused[0], ...dropped.slice(1)] });
  assert.equal(verdict.ok, false);
});

test('`1324ba78` ANTI-LABEL: a cell that claims a class it did not request is refused', () => {
  const verdict = d17({
    bearerObservations: bearerRefused.map((o) => (o.familyClass === 'write' ? { ...o, method: 'GET' } : o)),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /but requested GET/);
});

test('D17 VACUITY: no contract matrix at all is refused', () => {
  const verdict = bearerNeverWidensCore({
    bearerObservations: bearerRefused, sessionObservations: sessionAdmitted, bearerReach: reachOk,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no contract matrix/);
});

// ── D17's PLUGIN half (I6) ──────────────────────────────────────────────────

/**
 * ROUND-4 EXTRA VERDICT `36e8588e` B3. The plugin matrix carries the ACCESS
 * LEVEL as a fourth dimension — the shape `buildPluginLevelCensus` produces —
 * because `use` was never exercised where the arm narrows, and `use` is the one
 * level at which a read family and a write family must answer DIFFERENTLY.
 */
const PLUGIN_LEVELS = ['none', 'use', 'configure'];
const pluginLevelCensus = d17Census.flatMap((cell) => PLUGIN_LEVELS.map((level) => ({
  ...cell,
  key: `${cell.key}|${level}`,
  coreKey: cell.key,
  level,
  expectAdmitted: levelAnswers(level, cell.familyClass),
})));
const pluginCell = (cell, answer) => ({
  label: `plugin at ${cell.level}, ${cell.bearer} via ${cell.store}: ${cell.method} ${cell.route}`,
  bearer: cell.bearer, store: cell.store, familyClass: cell.familyClass, level: cell.level,
  method: cell.method, route: cell.route, ...answer,
});
const pluginObserved = pluginLevelCensus.map((cell) => pluginCell(
  cell,
  cell.expectAdmitted ? (cell.familyClass === 'write' ? { status: 201 } : ok200) : concealed,
));
const plugin = (overrides = {}) => pluginBearerNarrowsOnly({
  observations: pluginObserved,
  coreContrast: bare403, census: pluginLevelCensus, ...overrides,
});

test('D17 plugin: admitted at the level, refused at `none`, and refused on the same URL when core', () => {
  const verdict = plugin();
  assert.equal(verdict.ok, true, verdict.reason);
});

test('D17 plugin RED (I6 inverted): a bearer holding the level refused on a PLUGIN surface', () => {
  const verdict = plugin({
    observations: pluginObserved.map((o) => (o.level === 'configure' && o.familyClass === 'read' ? { ...o, ...concealed } : o)),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /only narrows/);
});

test('`5cfe851b` B3 RED (reviewer input): one row each is not the plugin matrix', () => {
  // The A2 round-4 probe's exact input: the old oracle answered `ok:true` with
  // "1 plugin-surface requests admitted ... and 1 refused", so a defect
  // isolated to the Agent bearer or the surface-grant store stayed green.
  const verdict = plugin({ observations: [pluginObserved[0]] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /matrix cells unexercised/);
});

test('`5cfe851b` B3 RED: dropping ONE authority store from the plugin half is caught', () => {
  const verdict = plugin({ observations: pluginObserved.filter((o) => o.store !== 'surface-grant') });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /surface-grant/);
});

test('`36e8588e` B3 RED (reviewer input): a plugin half that never exercises `use` is refused', () => {
  // THE finding, verbatim: `none` and `configure` only. `use` is the one level
  // at which a read family and a write family must answer differently, so a
  // plugin branch that ignored the ordering entirely stayed green.
  const verdict = plugin({ observations: pluginObserved.filter((o) => o.level !== 'use') });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /ACCESS LEVEL/);
  assert.match(verdict.reason, /\|use/);
});

test('`36e8588e` B3 RED: at `use` a WRITE family must still be refused on a plugin surface', () => {
  const verdict = plugin({
    observations: pluginObserved.map((o) => (o.level === 'use' && o.familyClass === 'write' ? { ...o, status: 201, code: undefined } : o)),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not refused BY THE SURFACE STAGE/);
});

test('`36e8588e` B3 RED: at `use` a READ family must be ADMITTED on a plugin surface', () => {
  const verdict = plugin({
    observations: pluginObserved.map((o) => (o.level === 'use' && o.familyClass === 'read' ? { ...o, ...concealed } : o)),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /only narrows/);
});

test('`36e8588e` B3 CONTROL-OF-THE-CONTROL: a matrix with no refused cell proves nothing', () => {
  const allAdmitted = pluginLevelCensus.map((cell) => ({ ...cell, expectAdmitted: true }));
  const verdict = pluginBearerNarrowsOnly({
    observations: pluginObserved.map((o) => ({ ...o, ...ok200 })),
    coreContrast: bare403, census: allAdmitted,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /never has to narrow/);
});

test('`5cfe851b` B3 ANTI-LABEL: a plugin cell that claims a class it did not request is refused', () => {
  const verdict = plugin({
    observations: pluginObserved.map((o) => (o.familyClass === 'write' ? { ...o, method: 'GET' } : o)),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /but requested GET/);
});

test('D17 plugin VACUITY: no contract matrix at all is refused', () => {
  const verdict = pluginBearerNarrowsOnly({ observations: pluginObserved, coreContrast: bare403 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no contract matrix/);
});

test('D17 plugin RED: a bearer at `none` admitted on a plugin surface is a widening', () => {
  const verdict = plugin({
    observations: pluginObserved.map((o) => (o.level === 'none' ? { ...o, ...ok200 } : o)),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not refused BY THE SURFACE STAGE/);
});

test('D17 plugin CONTROL-OF-THE-CONTROL: without the CORE contrast the admission proves nothing', () => {
  const verdict = plugin({ coreContrast: null });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no core contrast/);
});

test('D17 plugin CONTROL-OF-THE-CONTROL: a core contrast that was ADMITTED means the caller is admitted everywhere', () => {
  const verdict = plugin({ coreContrast: ok200 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /did not refuse/);
});

// ── D21 ─────────────────────────────────────────────────────────────────────
// ── D21 ─────────────────────────────────────────────────────────────────────

// ── D21, AS RESCOPED (owner ruling `70af4d82` on escalation `94c77997`) ─────
//
// The retired oracle here asserted a HANDLER rule-4 refusal that no handler
// performs. Its replacement is three assertions plus the escalation's own
// capture, and each control below names the single assertion it moves.

const SEEDED_SURFACES = [
  { key: 'settings.about', governance: 'always-self' },
  { key: 'settings.access-grants', governance: 'governable' },
  { key: 'settings.access-profiles-groups', governance: 'governable' },
  { key: 'settings.appearance', governance: 'governable' },
  { key: 'settings.connector-owner-plane', governance: 'governable' },
  { key: 'settings.identities', governance: 'governable' },
  { key: 'settings.identity-providers', governance: 'locked' },
  { key: 'settings.model-catalogue', governance: 'governable' },
  { key: 'settings.webhooks', governance: 'governable' },
];
const SEEDED_MEMBERS = [
  ...ADMINISTRATIVE_MEMBER_KEYS.map((key) => ({ bundleKey: 'administrative', surfaceKey: key })),
  { bundleKey: 'personal', surfaceKey: 'settings.about' },
];
const seededAdmin = () => ADMINISTRATIVE_MEMBER_KEYS.slice();

test('D21 (i): governable, in no bundle, Administrative exactly the four', () => {
  const verdict = authorityMutationSurfacesUnbundled({
    surfaceRows: SEEDED_SURFACES, memberRows: SEEDED_MEMBERS, administrativeMemberKeys: seededAdmin(),
  });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('D21 (i) RED — the annex`s named mutation: add #15 to Administrative`s seed', () => {
  const verdict = authorityMutationSurfacesUnbundled({
    surfaceRows: SEEDED_SURFACES,
    memberRows: [...SEEDED_MEMBERS, { bundleKey: 'administrative', surfaceKey: 'settings.access-grants' }],
    administrativeMemberKeys: [...seededAdmin(), 'settings.access-grants'],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /IS an Access-bundle member/);
});

test('D21 (i) RED: adding #15 to a DIFFERENT bundle is refused too — the ruling says NO bundle', () => {
  const verdict = authorityMutationSurfacesUnbundled({
    surfaceRows: SEEDED_SURFACES,
    memberRows: [...SEEDED_MEMBERS, { bundleKey: 'operational', surfaceKey: 'settings.identities' }],
    administrativeMemberKeys: seededAdmin(),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /settings\.identities in operational/);
});

test('D21 (i) EVASION: deleting the three rows outright does not satisfy the ruling', () => {
  const verdict = authorityMutationSurfacesUnbundled({
    surfaceRows: SEEDED_SURFACES.filter((row) => row.key !== 'settings.identities'),
    memberRows: SEEDED_MEMBERS, administrativeMemberKeys: seededAdmin(),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not REGISTERED at all/);
});

test('D21 (i) EVASION: re-classing #15 as `locked` is a different catalogue', () => {
  const verdict = authorityMutationSurfacesUnbundled({
    surfaceRows: SEEDED_SURFACES.map((row) => (row.key === 'settings.access-grants' ? { ...row, governance: 'locked' } : row)),
    memberRows: SEEDED_MEMBERS, administrativeMemberKeys: seededAdmin(),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /registered, but not as `governable`/);
});

test('D21 (i) RED: Administrative gaining ANY other member is a finding', () => {
  const verdict = authorityMutationSurfacesUnbundled({
    surfaceRows: SEEDED_SURFACES, memberRows: SEEDED_MEMBERS,
    administrativeMemberKeys: [...seededAdmin(), 'settings.identity-providers'],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /ruling 70af4d82/);
});

test('D21 (i) VACUITY: an empty catalogue read must not pass', () => {
  const verdict = authorityMutationSurfacesUnbundled({ surfaceRows: [], memberRows: [], administrativeMemberKeys: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /must not pass on an empty catalogue/);
});

// ── (ii) ────────────────────────────────────────────────────────────────────

/**
 * ROUND-4 (finding `2eb2061c`). `authorityMutationWritesRefused` takes the
 * CONTRACT ATTEMPT MULTISET — every withheld surface through every write store
 * — because round 3's form validated whatever it was handed: ONE refusal
 * covering only #15 plus an unrelated `GET /health` 200 returned `ok:true`. The
 * fixture is complete, in the shape `buildD21WriteCensus` produces.
 */
const D21_STORES = ['profile-rule-projection', 'surface-grant'];
const d21Attempts = D21_STORES.flatMap((store) => [...AUTHORITY_MUTATION_SURFACE_KEYS].sort()
  .map((surfaceKey) => ({ key: `${store}|${surfaceKey}`, store, surfaceKey })));
/**
 * ROUND-4 REVIEW `43520bf5` B1: the correlation is on WHAT WAS SENT, so a
 * fixture must carry the operation, not just a `store` label. The surface id
 * stands in for the ONE thing a refusal and its control may differ in.
 */
const surfaceIdOf = (surfaceKey) => `id-of-${surfaceKey}`;
const writeOp = (store, surfaceKey) => (store === 'profile-rule-projection'
  ? { method: 'POST', route: '/access-profiles/fixture-profile/versions', body: { rules: [{ resourceType: 'surface', selectorForm: 'exact', selectorIds: [surfaceIdOf(surfaceKey)], verbs: ['read', 'write'] }] } }
  : { method: 'POST', route: '/grants', body: { granteeType: 'group', granteeId: 'g', resourceType: 'surface', resourceId: surfaceIdOf(surfaceKey), verb: 'write' } });
const refusedWrite = (store, surfaceKey) => ({
  label: `${store} naming ${surfaceKey}`, store, surfaceKey, surfaceId: surfaceIdOf(surfaceKey),
  ...writeOp(store, surfaceKey),
  status: 422, code: AUTHORITY_MUTATION_CODE,
  message: `Access surface '${surfaceKey}' mutates authority itself ... design card ${RULE_FOUR_ARM_CARD} (AUTHZ amendment AZ-A7)`,
});
const goodRefusals = d21Attempts.map((attempt) => refusedWrite(attempt.store, attempt.surfaceKey));
const goodControls = D21_STORES.map((store) => ({
  label: `${store} naming settings.webhooks`, store, surfaceKey: 'settings.webhooks',
  surfaceId: surfaceIdOf('settings.webhooks'), ...writeOp(store, 'settings.webhooks'), status: 201,
}));
const goodWriteAudit = goodRefusals.map((refusal) => ({
  action: AUTHORITY_MUTATION_REFUSAL_ACT,
  metadata: { surfaceKey: refusal.surfaceKey, arm: RULE_FOUR_ARM_CARD, refusal: AUTHORITY_MUTATION_CODE },
}));
const d21ii = (overrides = {}) => authorityMutationWritesRefused({
  refusals: goodRefusals, controls: goodControls, auditRows: goodWriteAudit,
  expectedAttempts: d21Attempts, ...overrides,
});

test('D21 (ii): every withheld surface, through every store, refused, controlled and audited', () => {
  const verdict = d21ii();
  assert.equal(verdict.ok, true, verdict.reason);
});

test('D21 (ii) RED — remove the membership refusal: the write succeeds', () => {
  const verdict = d21ii({ refusals: goodRefusals.map((r, i) => (i === 0 ? { ...r, status: 201, code: undefined } : r)) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /SUCCEEDED/);
});

test('D21 (ii) EVASION: refused by SOME other validator is not this closure', () => {
  const verdict = d21ii({ refusals: goodRefusals.map((r, i) => (i === 0 ? { ...r, code: 'INVALID_PROFILE_VALUE' } : r)) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /NOT by this closure/);
});

test('D21 (ii) EVASION: a refusal that names no missing arm is not actionable', () => {
  const verdict = d21ii({
    refusals: goodRefusals.map((r, i) => (i === 0 ? { ...r, message: `Access surface '${r.surfaceKey}' may not be conferred` } : r)),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /must NAME the surface and the missing arm/);
});

test('D21 (ii) VACUITY: with no positive control, a write surface that refuses everything would pass', () => {
  const verdict = d21ii({ controls: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no same-run positive control/);
});

test('D21 (ii) CONTROL-OF-THE-CONTROL: a refused positive control unattributes the refusals', () => {
  const verdict = d21ii({ controls: goodControls.map((c) => ({ ...c, status: 422 })) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /unattributed/);
});

test('D21 (ii) RED: refused but never audited', () => {
  const verdict = d21ii({ auditRows: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /under-audited/);
});

test('D21 (ii) RED: an audit row that names no missing arm', () => {
  const verdict = d21ii({
    auditRows: goodWriteAudit.map((row) => ({ ...row, metadata: { surfaceKey: row.metadata.surfaceKey } })),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /name no missing arm/);
});

test('`2eb2061c` RED (reviewer input): ONE refusal covering only #15 is not the closure', () => {
  // The A1 round-3 probe's exact input: one refusal naming `settings.access-grants`
  // and an unrelated positive control. The old oracle answered `ok:true`.
  const verdict = d21ii({
    refusals: [refusedWrite('profile-rule-projection', 'settings.access-grants')],
    controls: [{ label: 'GET /health', store: 'profile-rule-projection', status: 200 }],
    auditRows: [goodWriteAudit[0]],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /required attempts were never made/);
});

test('`2eb2061c` RED: dropping ONE write store leaves that authority path unmeasured', () => {
  const kept = goodRefusals.filter((r) => r.store !== 'surface-grant');
  const verdict = d21ii({ refusals: kept, auditRows: goodWriteAudit.slice(0, kept.length) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /surface-grant/);
});

test('`2eb2061c` RED: a control through a DIFFERENT operation attributes nothing', () => {
  // The control must be the identical write through the identical store. A 2xx
  // that arrived some other way is what round 3 accepted.
  const verdict = d21ii({
    controls: [{
      label: 'GET /health', store: 'profile-rule-projection', surfaceId: surfaceIdOf('settings.webhooks'),
      method: 'GET', route: '/health', body: { note: surfaceIdOf('settings.webhooks') }, status: 200,
    }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /IDENTICAL operation/);
});

test('`43520bf5` B1 RED (reviewer input): an unrelated 2xx cannot become a control by being RELABELLED', () => {
  // The A1 round-4 probe's exact input: two `GET /health` 200s whose only
  // correlation to the refusals was a forged `store` field. The old oracle
  // answered `ok:true` with "each with a same-run control admitted through the
  // SAME store".
  const verdict = d21ii({
    controls: D21_STORES.map((store) => ({
      label: `GET /health relabelled as ${store}`, store, surfaceKey: 'settings.webhooks',
      surfaceId: surfaceIdOf('settings.webhooks'),
      method: 'GET', route: `/health/${surfaceIdOf('settings.webhooks')}`, body: {}, status: 200,
    })),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /IDENTICAL operation/);
});

test('`43520bf5` B1 VACUITY: an observation that names no surface id cannot be correlated', () => {
  const verdict = d21ii({ controls: goodControls.map(({ surfaceId, ...rest }) => rest) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /names no surface id/);
});

test('`43520bf5` B1 VACUITY: a declared surface id that appears nowhere in the request is refused', () => {
  const verdict = d21ii({ controls: goodControls.map((row) => ({ ...row, surfaceId: 'not-in-this-request' })) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /appears nowhere in the request/);
});

test('`43520bf5` B1 CONTROL: the SAME operation differing only in the surface named still correlates', () => {
  const verdict = d21ii();
  assert.equal(verdict.ok, true, verdict.reason);
});

test('writeOperationSignature: the surface named is elided, everything else is not', () => {
  const a = refusedWrite('surface-grant', 'settings.access-grants');
  const b = refusedWrite('surface-grant', 'settings.identities');
  assert.equal(writeOperationSignature(a), writeOperationSignature(b));
  assert.notEqual(writeOperationSignature(a), writeOperationSignature(refusedWrite('profile-rule-projection', 'settings.access-grants')));
});

test('`2eb2061c` RED: audit correlated as a MULTISET — one row cannot cover two refusals of one surface', () => {
  const verdict = d21ii({ auditRows: goodWriteAudit.filter((row, i) => i < 3) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /under-audited/);
});

test('D21 (ii) VACUITY: no contract attempt multiset at all is refused', () => {
  const verdict = authorityMutationWritesRefused({
    refusals: goodRefusals, controls: goodControls, auditRows: goodWriteAudit,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no required attempt multiset/);
});

// ── (iii) ───────────────────────────────────────────────────────────────────
// ── (iii) ───────────────────────────────────────────────────────────────────

const ACT_TARGETS = [
  { method: 'POST', path: '/grants' },
  { method: 'POST', path: '/groups' },
  { method: 'POST', path: '/groups/g/members' },
  { method: 'POST', path: '/access-profiles' },
  { method: 'POST', path: '/access-profiles/p/versions' },
];
// The fixture above must BE the ratified five, or every control below would be
// measuring a set the oracle now refuses for an unrelated reason.
assert.equal(ACT_TARGETS.length, RATIFIED_ESCALATION_ACTS.length);
// ROUND-2 REGRESSION `989fc650`. These fixtures used to carry a label and a
// status and nothing else, while the drill records METHOD and ROUTE on every
// act. A correlation between the escalation and the ROOT control cannot be
// measured against a double that omits the fields it correlates on — the
// fixture is now the shape `escalationActs` actually pushes.
const goodActs = ACT_TARGETS.map((target) => ({
  label: `${target.method} ${target.path}`, method: target.method, route: target.path, ...bare403,
}));
const goodRootActs = goodActs.map((act) => ({
  label: act.label, method: act.method, route: act.route, status: 201,
}));
const goodArmAudit = [{ action: SURFACE_REFUSAL_ACT, metadata: { surfaceKey: 'settings.access-grants', accessLevel: 'none', refusal: AUTHORITY_MUTATION_CODE } }];
/**
 * ROUND-4 REVIEW `5cfe851b` B1 at this rung: five acts used to be accepted
 * against every row the run had written by then, because the correlation was a
 * MEMBERSHIP test. Each act now carries the ids of the rows ITS OWN request
 * wrote, so the fixture must too.
 */
const goodArmAuditPerAct = ACT_TARGETS.map((target, i) => ({
  id: `arm-row-${i}`,
  action: SURFACE_REFUSAL_ACT,
  metadata: {
    surfaceKey: 'settings.access-grants', accessLevel: 'none',
    refusal: AUTHORITY_MUTATION_CODE, method: target.method, path: target.path,
  },
}));
const ACT_EXPECTATIONS = ACT_TARGETS.map((target, i) => ({ ...target, rowIds: [`arm-row-${i}`] }));
/**
 * A stand-in for production's `familyMatchesRequest`, deliberately CRUDE: it
 * matches a family key against a request by turning each `:param` into one path
 * segment. The real matcher is production's and the live drill passes THAT one;
 * this fixture exists only so the controls below can be pure.
 */
const familyMatchesFixture = (familyKey, method, path) => {
  const [wantMethod, wantPath] = String(familyKey).split(' ');
  if (String(method).toUpperCase() !== wantMethod) return false;
  const pattern = new RegExp(`^${wantPath.split('/').map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
  return pattern.test(String(path));
};
const armInput = (overrides = {}) => ({
  observations: goodActs,
  ratifiedActs: RATIFIED_ESCALATION_ACTS,
  familyMatches: familyMatchesFixture,
  rowsBefore: 7,
  rowsAfter: 7,
  sufficientControl: { status: 201 },
  rootControl: { acts: goodRootActs, rowsBefore: 7, rowsAfter: 12 },
  auditRows: goodArmAuditPerAct,
  expectedRefusals: ACT_EXPECTATIONS,
  ...overrides,
});

test('D21 (iii): the arm never admits, the root refusal stands, nothing written', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput());
  assert.equal(verdict.ok, true, verdict.reason);
});

test('D21 (iii) RED — remove the arm short-circuit: the escalation reproduces', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({
    observations: [{ label: 'POST /grants', status: 201 }, ...goodActs.slice(1)], rowsAfter: 8,
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /escalation reproduced/);
});

test('D21 (iii) EVASION: this design`s 404 concealment is NOT the root refusal', () => {
  // Ruling §1.1: "their behaviour today is unchanged: root-only, as before
  // SETGOV". A 404 discloses less, but it is a different answer, and it is
  // what an implementation that only reduced the SEED would produce.
  const verdict = authorityMutationArmNeverAdmits(armInput({
    observations: [{ label: 'POST /grants', ...concealed }, ...goodActs.slice(1)],
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /NOT with the ratified root refusal/);
});

test('D21 (iii) EVASION: the 403 NAMING the surface is not it either', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({
    observations: [{ label: 'POST /grants', ...named403 }, ...goodActs.slice(1)],
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /NOT with the ratified root refusal/);
});

test('D21 (iii) SETUP: a caller holding nothing refuses everything and proves nothing', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({ sufficientControl: concealed }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /SETUP control/);
});

test('D21 (iii) RED: a refusal that still wrote a row', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({ rowsAfter: 8 }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /still wrote a row/);
});

test('D21 (iii) CONTROL-OF-THE-CONTROL: a refused ROOT control unattributes the refusals', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({
    rootControl: { acts: [{ label: 'POST /grants', ...bare403 }], rowsBefore: 7, rowsAfter: 12 },
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /ROOT control did not succeed/);
});

test('D21 (iii) CONTROL-OF-THE-CONTROL: a ROOT control that wrote nothing cannot witness "no row written"', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({
    rootControl: { acts: goodRootActs, rowsBefore: 7, rowsAfter: 7 },
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /wrote NO row/);
});

test('D21 (iii) RED: the arm declined silently', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({
    auditRows: [{ action: SURFACE_REFUSAL_ACT, metadata: { surfaceKey: 'settings.webhooks', accessLevel: 'none', refusal: 'SURFACE_CONCEALED' } }],
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /audited with reason/);
});

test('`5cfe851b` B1 RED: an act audited by a SIBLING request`s row is not audited', () => {
  // The rows exist and match the method and path, but they belong to other
  // requests. A membership test passes; an attributed one does not.
  const verdict = authorityMutationArmNeverAdmits(armInput({
    expectedRefusals: ACT_EXPECTATIONS.map((want, i) => (i === 0 ? { ...want, rowIds: ['arm-row-1'] } : want)),
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not audited BY THEIR OWN REQUEST/);
});

test('`5cfe851b` B1 VACUITY: an act whose own request recorded no rows cannot be proved audited', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({
    expectedRefusals: ACT_EXPECTATIONS.map(({ rowIds, ...rest }, i) => (i === 0 ? rest : { rowIds, ...rest })),
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /recorded no rows for its own request/);
});

test('D21 (iii) RED (round 1, reviewer input): ONE audit row for FIVE acts must not pass', () => {
  // The reviewer's exact mutation: keep the first act's row, drop the other
  // four. The oracle reported "5 escalation acts met the root refusal, 1
  // audited" and passed (regression `e776b244`).
  const verdict = authorityMutationArmNeverAdmits(armInput({ auditRows: [goodArmAuditPerAct[0]] }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /4 of 5 refusals were not audited BY THEIR OWN REQUEST/);
});

test('D21 (iii) VACUITY: an unnamed or short expected-audit list must not pass', () => {
  assert.equal(authorityMutationArmNeverAdmits(armInput({ expectedRefusals: undefined })).ok, false);
  assert.equal(authorityMutationArmNeverAdmits(armInput({ expectedRefusals: ACT_TARGETS.slice(0, 1) })).ok, false);
});

test('D21 (iii) EVASION: an audit row for the WRONG act does not cover a missing one', () => {
  const wrong = [...goodArmAuditPerAct.slice(0, 4), {
    action: SURFACE_REFUSAL_ACT,
    metadata: { surfaceKey: 'settings.webhooks', accessLevel: 'none', refusal: AUTHORITY_MUTATION_CODE, method: 'GET', path: '/webhooks' },
  }];
  const verdict = authorityMutationArmNeverAdmits(armInput({ auditRows: wrong }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /access-profiles\/p\/versions/);
});

// ── the negative control ────────────────────────────────────────────────────

const refusedCapture = () => ({
  grants: { status: 403, code: 'FORBIDDEN', rowsBefore: 1, rowsAfter: 1, createdGrant: null },
  groups: { status: 403, code: 'FORBIDDEN', createdId: null },
  groupMembers: { status: 403, code: 'FORBIDDEN', targetIsForeignAccount: true },
  accessProfiles: { status: 403, code: 'FORBIDDEN', createdId: null },
  accessProfileVersion: { status: 403, code: 'FORBIDDEN', ruleSpanned: 'task / all-of-type / read+write+admin' },
  caller: { handle: 'setgov-drill-member', role: 'viewer', scopes: ['tasks:read'] },
});

test('D21 negative control: the escalation`s own instrument now refuses on all five', () => {
  const verdict = escalationCaptureRefused(refusedCapture());
  assert.equal(verdict.ok, true, verdict.reason);
});

test('D21 negative control RED: the escalation reproduced verbatim', () => {
  const capture = refusedCapture();
  capture.grants = { status: 201, rowsBefore: 1, rowsAfter: 2, createdGrant: { verb: 'admin' } };
  const verdict = escalationCaptureRefused(capture);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /reproduced VERBATIM/);
});

test('D21 negative control VACUITY: a capture that skipped an act must not pass', () => {
  const capture = refusedCapture();
  delete capture.groupMembers;
  const verdict = escalationCaptureRefused(capture);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no status for groupMembers/);
});

test('D21 negative control CONFOUND: a ROOT caller is exempt and proves nothing', () => {
  const capture = refusedCapture();
  capture.caller = { handle: 'root', role: 'admin', scopes: ['root'] };
  const verdict = escalationCaptureRefused(capture);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /proves nothing/);
});

test('D21 negative control RED: a refusal that still moved the grants count', () => {
  const capture = refusedCapture();
  capture.grants.rowsAfter = 2;
  const verdict = escalationCaptureRefused(capture);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /still wrote a grants row/);
});

// ── D2 / D15 ────────────────────────────────────────────────────────────────

test('D2/D15: a boot refused for the census reason passes', () => {
  const verdict = bootRefused({
    exitCode: 1,
    output: "Access-surface census failed ... 'use' answers GET/HEAD only",
    expectedFragment: "'use' answers GET/HEAD only",
  });
  assert.equal(verdict.ok, true);
});

test('D2 RED: a boot that SUCCEEDS on a catalogue the census must refuse', () => {
  assert.equal(bootRefused({ exitCode: 0, output: 'census passed', expectedFragment: 'x' }).ok, false);
});

test('D2 CONFOUND: a boot that failed for some OTHER reason is not evidence', () => {
  const verdict = bootRefused({ exitCode: 1, output: 'ECONNREFUSED', expectedFragment: 'not root' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not for the census reason/);
});

test('D2 CONFOUND: no expected sentence means no verdict', () => {
  assert.equal(bootRefused({ exitCode: 1, output: 'anything' }).ok, false);
});

test('D2 setup: a sound catalogue boots AND the census announces itself', () => {
  assert.equal(bootAccepted({ exitCode: 0, output: '... Access-surface census passed ...' }).ok, true);
  const silent = bootAccepted({ exitCode: 0, output: 'server started' });
  assert.equal(silent.ok, false);
  assert.match(silent.reason, /may not have run at all/);
});

// ── D13 ─────────────────────────────────────────────────────────────────────

test('D13: admitted before the write, refused on the very next request', () => {
  assert.equal(tookEffectImmediately({ before: ok200, after: concealed }).ok, true);
});

test('D13 RED (serve the principal from a cache the status write does not clear)', () => {
  const verdict = tookEffectImmediately({ before: ok200, after: ok200 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /still succeeded/);
});

test('D13 VACUITY: a caller that never reached the surface proves nothing by later refusing', () => {
  const verdict = tookEffectImmediately({ before: concealed, after: concealed });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /unattributed/);
});

// ── §3.6 audit ──────────────────────────────────────────────────────────────

/**
 * ROUND-4 REVIEW `5cfe851b` B1. §3.6's correlation is ATTRIBUTED, not
 * aggregated: each expectation carries the ids of the rows ITS OWN request
 * wrote, and every row in the run must be claimed by some recorded request.
 * A fixture without the ledger would hide the very hole this repairs.
 */
const RUN = { runId: 'run-fixture-0001', startedAt: '2026-09-03T00:00:00.000Z', preExistingIds: [] };
let auditRowSeq = 0;
const auditRow = (method, path, extra = {}) => ({
  id: `row-${(auditRowSeq += 1)}`,
  occurredAt: '2026-09-03T00:00:01.000Z',
  action: SURFACE_REFUSAL_ACT,
  metadata: { surfaceKey: 'settings.webhooks', accessLevel: 'none', family: null, method, path, ...extra },
});
/** Production's ratified levels, as the drill hands them to the oracle. */
const RATIFIED_LEVELS = ['none', 'use', 'configure'];
/** One recorded request, and the expectation it justifies. */
const request = (method, path, rows) => ({
  ledger: { seq: `req-${method}-${path}-${rows.map((row) => row.id).join('+')}`, method, path, rowIds: rows.map((row) => row.id) },
  expected: { method, path, rowIds: rows.map((row) => row.id) },
  rows,
});
const audited = (rows, options = {}) => refusalsAudited(rows, {
    accessLevels: RATIFIED_LEVELS,
  runBoundary: RUN,
  ledger: (options.expected ?? []).map((want) => ({ seq: 0, rowIds: want.rowIds ?? [] })),
  accessLevels: RATIFIED_LEVELS,
  ...options,
});

const CAUSED_ROWS = [auditRow('GET', '/webhooks'), auditRow('POST', '/webhooks')];
const CAUSED = CAUSED_ROWS.map((row) => ({
  method: row.metadata.method, path: row.metadata.path, rowIds: [row.id],
}));

test('audit: every CAUSED refusal has its row, carrying the surface key and the computed level', () => {
  const verdict = audited(CAUSED_ROWS, { expected: CAUSED });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('audit RED: a refusal row with no computed level', () => {
  const rows = CAUSED_ROWS.map((row) => ({ ...row, metadata: { ...row.metadata, accessLevel: undefined } }));
  assert.equal(audited(rows, { expected: CAUSED }).ok, false);
});

test('audit RED: no refusal rows at all', () => {
  const rows = [{ id: 'row-x', occurredAt: '2026-09-03T00:00:01.000Z', action: 'grant.create', metadata: {} }];
  assert.equal(audited(rows, { expected: CAUSED }).ok, false);
});

test('audit RED (round 1, reviewer input): unrelated rows must not satisfy an aggregate', () => {
  // The reviewer's exact mutation: three well-formed rows for requests the
  // drill never made, while the refusals it DID cause wrote nothing. The old
  // oracle counted and passed (regression `e776b244`).
  const unrelated = [
    auditRow('GET', '/appearance/versions'),
    auditRow('GET', '/litellm/models'),
    auditRow('PATCH', '/services/x/owner-plane'),
  ];
  const verdict = refusalsAudited(unrelated, {
    accessLevels: RATIFIED_LEVELS,
    runBoundary: RUN, expected: CAUSED,
    ledger: [{ seq: 1, rowIds: unrelated.map((row) => row.id) }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not audited BY THEIR OWN REQUEST/);
});

test('`5cfe851b` B1 RED (reviewer input): an unrelated EARLIER SAME-RUN row cannot cover a request that wrote none', () => {
  // The A2 round-4 probe's exact shape. Both rows are inside the run and the
  // aggregate method/path count is satisfied; the expected request wrote
  // nothing. The old form answered `ok:true`.
  const sibling = auditRow('GET', '/webhooks');
  const verdict = refusalsAudited([sibling], {
    accessLevels: RATIFIED_LEVELS,
    runBoundary: RUN,
    expected: [{ method: 'GET', path: '/webhooks', rowIds: [] }],
    ledger: [{ seq: 1, rowIds: [sibling.id] }, { seq: 2, rowIds: [] }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not audited BY THEIR OWN REQUEST/);
});

test('`5cfe851b` B1 RED: a row NO recorded request claims makes the correlation unsound', () => {
  const orphan = auditRow('GET', '/webhooks');
  const verdict = refusalsAudited([...CAUSED_ROWS, orphan], {
    runBoundary: RUN, expected: CAUSED,
    ledger: CAUSED.map((want) => ({ seq: 0, rowIds: want.rowIds })),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /attributed to NO request/);
});

test('`5cfe851b` B1 RED: two requests claiming ONE row is not a partition', () => {
  const verdict = refusalsAudited(CAUSED_ROWS, {
    accessLevels: RATIFIED_LEVELS,
    runBoundary: RUN, expected: CAUSED,
    ledger: [{ seq: 1, rowIds: CAUSED_ROWS.map((row) => row.id) }, { seq: 2, rowIds: [CAUSED_ROWS[0].id] }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /claimed by more than one request/);
});

test('`5cfe851b` B1 VACUITY: no request ledger at all is refused', () => {
  const verdict = refusalsAudited(CAUSED_ROWS, { runBoundary: RUN, expected: CAUSED });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no request ledger/);
});

test('audit VACUITY: with nothing expected, the oracle refuses rather than counting', () => {
  const verdict = audited(CAUSED_ROWS, { expected: [], ledger: [{ seq: 1, rowIds: CAUSED_ROWS.map((r) => r.id) }] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no expected refusals were named/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUND-2 CHECKPOINT [4]// ═══════════════════════════════════════════════════════════════════════════
// ROUND-2 CHECKPOINT [4] — the independent reviewer's hostile inputs, kept
// VERBATIM as permanent controls.
//
// `qa-oracle-hostile-probe.mjs` attacked the exported oracles directly and
// found four false-greens, filed as `1bfd5420` (D6), `ff9b6437` (D10),
// `989fc650` (D21 root control) and `4e894e2d` (audit multiplicity), plus a
// fifth the probe demonstrated and no card names (D16's blank invocation).
// Each input below is the reviewer's own, and each must go RED. Beside each is
// the control-of-the-control: the legitimate state the repair must still pass,
// so a repair cannot be a refusal of everything.
// ═══════════════════════════════════════════════════════════════════════════

test('`1bfd5420` RED (reviewer input): ONE correct cell is not D6', () => {
  const verdict = d6([d6Cell('none', 'read', concealed)]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /contract cells/);
});

test('`1bfd5420` CONTROL: the complete grid still passes', () => {
  const verdict = d6(d6Good);
  assert.equal(verdict.ok, true, verdict.reason);
});

test('`1bfd5420` RED: a REPEATED cell cannot stand in for a missing one', () => {
  const withoutUseWrite = d6Good.filter((o) => o.label !== 'use/write');
  const useRead = d6Good.find((o) => o.label === 'use/read');
  const verdict = d6([...withoutUseWrite, { ...useRead, label: 'use/read (again)' }]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /never measured|observed 2 times/);
});

test('`1bfd5420` RED: a caller state outside the ratified three is not a cell', () => {
  const verdict = d6(d6Good.map((o) => (o.label === 'none/read' ? { ...o, callerState: 'root' } : o)));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /is not a cell of the contract census/);
});

test('`ff9b6437` RED (reviewer input): two identical HTTP 500 captures are not an unchanged decision', () => {
  const crash = [{ label: 'locked', status: 500, code: 'INTERNAL_ERROR' }];
  const verdict = identical(crash, crash.map((c) => ({ ...c })), { minimum: 1 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not authorization decisions/);
});

test('`ff9b6437` RED: a crash RECORDED as a refusal cannot carry the whole capture', () => {
  const crash = [decisionRecord('GET /webhooks', false, 500, 'INTERNAL_ERROR')];
  const verdict = identical(crash, crash.map((c) => ({ ...c })));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /a crash is not a decision/);
  assert.match(verdict.reason, /fewer than the 1 required/);
});

test('`ff9b6437` CONTROL: an indeterminate probe is EXCLUDED BY NAME, and the rest still decide', () => {
  // The live drill found this. In D3(b)'s window the member is ADMITTED to
  // `GET /litellm/models`, whose upstream is absent, so it answers 503. The old
  // capture recorded that crash as `admitted:false` and compared it to itself:
  // had the SQL rule widened access, the probe would have answered 503 anyway.
  const withCrash = (extra) => [...capture, decisionRecord('GET /litellm/models', false, 503, 'UPSTREAM_UNAVAILABLE'), ...extra];
  const verdict = identical(withCrash([]), withCrash([]), { minimum: 3 });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(verdict.reason, /1 probe\(s\) EXCLUDED as non-answers/);
  assert.match(verdict.reason, /GET \/litellm\/models/);
});

test('`ff9b6437` CONTROL-OF-THE-CONTROL: exclusions cannot carry a capture past `minimum`', () => {
  const allCrashes = capture.map((c) => ({ ...c, evidence: { status: 503, code: 'UPSTREAM_UNAVAILABLE' } }));
  const verdict = identical(allCrashes, allCrashes.map((c) => ({ ...c })), { minimum: 3 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /only 0 of 3 capture entries answered an authorization decision/);
});

test('`ff9b6437` RED: indeterminate on ONE side is a MOVEMENT, never an exclusion', () => {
  const before = [decisionRecord('GET /litellm/models', false, 404, 'RESOURCE_NOT_FOUND'), ...capture];
  const after = [decisionRecord('GET /litellm/models', false, 503, 'UPSTREAM_UNAVAILABLE'), ...capture];
  const verdict = identical(before, after, { minimum: 3 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /one side answered an authorization decision and the other/);
});

test('`ff9b6437` CONTROL-OF-THE-CONTROL: the CODE-LESS 403 the root ceiling answers IS a decision', () => {
  // The live drill found this: `routes/appearanceAdmin.ts` refuses a non-root
  // caller with `{ error: 'Forbidden', message }` and no `code`. The first form
  // of this repair borrowed the SHAPE predicate written for D13/D17 and
  // reddened D3(b) on a correct answer. A capture asks a wider question than a
  // shape assertion does, and now has its own predicate.
  const bare = [decisionRecord('GET /appearance/asset-history/x', false, 403, undefined)];
  assert.equal(identical(bare, bare.map((c) => ({ ...c }))).ok, true);
});

test('`ff9b6437` RED: a bare 404 with no RESOURCE_NOT_FOUND code is the route map, not a decision', () => {
  const bare404 = [decisionRecord('GET /nowhere', false, 404, undefined)];
  const verdict = identical(bare404, bare404.map((c) => ({ ...c })));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /the route map answering/);
});

test('`ff9b6437` RED: a 429 rate ceiling is not an authorization answer', () => {
  const limited = [decisionRecord('GET /webhooks', false, 429, 'RATE_LIMITED')];
  const verdict = identical(limited, limited.map((c) => ({ ...c })));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /a rate ceiling/);
});

test('`ff9b6437` RED: a 401 recorded as a refusal is the D17 trap inside a capture', () => {
  const unauth = [decisionRecord('GET /webhooks', false, 401, 'AUTHENTICATION_REQUIRED')];
  const verdict = identical(unauth, unauth.map((c) => ({ ...c })));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /the credential was not accepted/);
  assert.match(verdict.reason, /fewer than the 1 required/);
});

test('`ff9b6437` CONTROL-OF-THE-CONTROL: a decision that disagrees with its own evidence is refused', () => {
  const lying = [decisionRecord('GET /webhooks', true, 404, 'RESOURCE_NOT_FOUND')];
  const verdict = identical(lying, lying.map((c) => ({ ...c })));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /recorded as admitted but its evidence answered 404/);
});

test('`ff9b6437` CONTROL: the RATIFIED 403 -> 404 shape change is not a decision change', () => {
  // Design §3.3 REQUIRES exactly this movement once the catalogue is in place.
  // A repair that reddened D1 here would have broken the design to close a card.
  const before = [decisionRecord('GET /webhooks', false, 404, 'RESOURCE_NOT_FOUND')];
  const after = [decisionRecord('GET /webhooks', false, 403, 'FORBIDDEN')];
  assert.equal(identical(before, after).ok, true);
});

test('D16 RED (reviewer input, never carded): an invocation line naming NO path is not an observation', () => {
  const verdict = armRecordExcludes([ARM_TRACE_PREFIX], ['/tasks']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not the shape the arm emits/);
});

test('D16 CONTROL: a real invocation on an ungated family still passes', () => {
  assert.equal(armRecordExcludes([`${ARM_TRACE_PREFIX} /webhooks settings.webhooks`], ['/tasks']).ok, true);
});

test('`989fc650` RED (reviewer input): one unrelated root 200 is not the same-acts control', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({
    rootControl: { acts: [{ label: 'unrelated', method: 'GET', route: '/health', status: 200 }], rowsBefore: 7, rowsAfter: 12 },
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /did not run the same acts/);
});

test('`989fc650` RED: a root control MISSING one of the acts fails', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({
    rootControl: { acts: goodRootActs.slice(0, 4), rowsBefore: 7, rowsAfter: 12 },
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /did not run the same acts/);
});

test('`989fc650` RED: a root control running one act TWICE does not cover the act it skipped', () => {
  const doubled = [goodRootActs[0], ...goodRootActs.slice(0, 4)];
  const verdict = authorityMutationArmNeverAdmits(armInput({
    rootControl: { acts: doubled, rowsBefore: 7, rowsAfter: 12 },
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /did not run the same acts/);
});

test('`989fc650` RED: a root control running an EXTRA act fails too', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput({
    rootControl: { acts: [...goodRootActs, { label: 'extra', method: 'POST', route: '/tasks', status: 201 }], rowsBefore: 7, rowsAfter: 12 },
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /did not run the same acts/);
});

test('`989fc650` CONTROL-OF-THE-CONTROL: acts that name no method or route cannot be correlated at all', () => {
  // The shape the OLD fixtures had. Without this, the repair would be
  // satisfied by two lists of unnamed acts — a correlation over empty keys.
  const unnamed = goodActs.map(({ method, route, ...rest }) => rest);
  const verdict = authorityMutationArmNeverAdmits(armInput({
    observations: unnamed,
    rootControl: { acts: unnamed.map((a) => ({ label: a.label, status: 201 })), rowsBefore: 7, rowsAfter: 12 },
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /name no method or route/);
});

test('`18d170f4` RED (reviewer input): two DIFFERENT fixed targets must not correlate as the same acts', () => {
  // The A2 round-3 probe's exact input, and the defect it found in the ROUND-3
  // REPAIR: `normaliseActRoute` collapsed EVERY uuid segment, so a member act
  // on group `1111…` and a root act on group `2222…` both normalised to
  // `/groups/:id/members` and the oracle printed "the ROOT control ran the same
  // acts". The normaliser is WITHDRAWN — the drill's two runs are byte-identical
  // by construction — so these are two different acts, which is what they are.
  const memberRoute = '/groups/11111111-1111-4111-8111-111111111111/members';
  const rootRoute = '/groups/22222222-2222-4222-8222-222222222222/members';
  const observations = goodActs.map((act, i) => (i === 2 ? { ...act, route: memberRoute } : act));
  const verdict = authorityMutationArmNeverAdmits(armInput({
    observations,
    expectedRefusals: observations.map((act) => ({ method: act.method, path: act.route })),
    auditRows: observations.map((act) => auditRow(act.method, act.route, { refusal: AUTHORITY_MUTATION_CODE })),
    rootControl: {
      acts: goodRootActs.map((act, i) => (i === 2 ? { ...act, route: rootRoute } : act)),
      rowsBefore: 7, rowsAfter: 12,
    },
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /did not run the same acts/);
});

test('`18d170f4` CONTROL: two runs issuing IDENTICAL acts still correlate', () => {
  const verdict = authorityMutationArmNeverAdmits(armInput());
  assert.equal(verdict.ok, true, verdict.reason);
});

test('`18d170f4` RED: acts differing only in their request BODY are different acts', () => {
  // §4.3's acts are distinguished by their TARGETS. Two `POST /grants` naming
  // different resources are not the same act, and a signature that ignored the
  // body would say they were.
  const observations = goodActs.map((act, i) => (i === 0 ? { ...act, body: { resourceId: 'task-A' } } : act));
  const verdict = authorityMutationArmNeverAdmits(armInput({
    observations,
    rootControl: {
      acts: goodRootActs.map((act, i) => (i === 0 ? { ...act, body: { resourceId: 'task-B' } } : act)),
      rowsBefore: 7, rowsAfter: 12,
    },
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /did not run the same acts/);
});

test('`18d170f4` CONTROL: a signature is stable under key ORDER, so two equal bodies correlate', () => {
  const observations = goodActs.map((act, i) => (i === 0 ? { ...act, body: { a: 1, b: 2 } } : act));
  const verdict = authorityMutationArmNeverAdmits(armInput({
    observations,
    rootControl: {
      acts: goodRootActs.map((act, i) => (i === 0 ? { ...act, body: { b: 2, a: 1 } } : act)),
      rowsBefore: 7, rowsAfter: 12,
    },
  }));
  assert.equal(verdict.ok, true, verdict.reason);
});

test('`4e894e2d` RED (reviewer input): ONE audit row does not audit TWO identical caused refusals', () => {
  // Two identical caused requests, ONE row. Under attribution the second
  // request has no row of its own, which is the same finding stated exactly.
  const only = auditRow('GET', '/webhooks');
  const verdict = refusalsAudited([only], {
    accessLevels: RATIFIED_LEVELS,
    runBoundary: RUN, minimum: 1,
    expected: [
      { method: 'GET', path: '/webhooks', rowIds: [only.id] },
      { method: 'GET', path: '/webhooks', rowIds: [] },
    ],
    ledger: [{ seq: 1, rowIds: [only.id] }, { seq: 2, rowIds: [] }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not audited BY THEIR OWN REQUEST/);
});

test('`4e894e2d` CONTROL: two rows for two identical caused refusals pass', () => {
  const first = auditRow('GET', '/webhooks');
  const second = auditRow('GET', '/webhooks');
  const verdict = refusalsAudited([first, second], {
    accessLevels: RATIFIED_LEVELS,
    runBoundary: RUN, minimum: 2,
    expected: [
      { method: 'GET', path: '/webhooks', rowIds: [first.id] },
      { method: 'GET', path: '/webhooks', rowIds: [second.id] },
    ],
    ledger: [{ seq: 1, rowIds: [first.id] }, { seq: 2, rowIds: [second.id] }],
  });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('`4e894e2d` RED: a row cannot be claimed by TWO expectations', () => {
  const only = auditRow('GET', '/webhooks');
  const verdict = refusalsAudited([only], {
    accessLevels: RATIFIED_LEVELS,
    runBoundary: RUN, minimum: 1,
    expected: [
      { method: 'GET', path: '/webhooks', rowIds: [only.id] },
      { method: 'GET', path: '/webhooks', rowIds: [only.id] },
    ],
    ledger: [{ seq: 1, rowIds: [only.id] }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not audited BY THEIR OWN REQUEST/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUND 4 — THE ROUND-3 REVIEWERS' HOSTILE INPUTS, KEPT VERBATIM.// ═══════════════════════════════════════════════════════════════════════════
// ROUND 4 — THE ROUND-3 REVIEWERS' HOSTILE INPUTS, KEPT VERBATIM.
//
// Owner ruling `83bf1354` item 1 commissions the round-3 repairs as a
// DESIGN-SHAPED change and requires every round-2/round-3 hostile probe to
// become a permanent control that goes RED against the pre-repair shape and
// GREEN after. The inputs below are the reviewers' own, from
// `a2-round3-hostile-probe.mjs` (A2, verdict `261d4148`) and
// `d21-reviewer-probe.mjs` (A1, verdict `b0456469`); each is paired with the
// legitimate state the repair must still pass, so a repair cannot be a refusal
// of everything.
// ═══════════════════════════════════════════════════════════════════════════

// ── `2bf39bb7` (A2 B1): six labels, one physical route ──────────────────────

test('`2bf39bb7` RED (reviewer input): six claimed cells over ONE physical GET route', () => {
  // The reviewer's probe supplied six records naming all six cells while every
  // one of them issued the same `GET /webhooks` — one of them labelled
  // `none/write` while being a GET. The old oracle answered `ok:true` with
  // "all 6 cells ... observed exactly once". The census now says what each cell
  // is, and a record that did not make that request cannot claim it.
  const sixLabelsOneRoute = d6Good.map((o) => ({ ...o, method: 'GET', route: '/webhooks' }));
  const verdict = d6(sixLabelsOneRoute);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /the request it made was GET \/webhooks/);
});

test('`2bf39bb7` RED: a record naming a surface outside the census is not an observation', () => {
  const verdict = d6(d6Good.map((o) => (o.label === 'none/read' ? { ...o, surfaceKey: 'settings.invented' } : o)));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /is not a cell of the contract census/);
});

test('`2bf39bb7` CONTROL: the same request under a DIFFERENT canonical spelling still matches its cell', () => {
  // `//WEBHOOKS/?x=1` is the same request under the production normaliser, and
  // the anti-label gate must not redden a correct observation over spelling.
  const verdict = d6(d6Good.map((o) => (o.familyKey === 'GET /webhooks' ? { ...o, route: '//WEBHOOKS/?x=1' } : o)));
  assert.equal(verdict.ok, true, verdict.reason);
});

// ── `2a8087c3` (A2 B2): the locked capture that dropped a whole surface ─────

const LOCKED_CONTRACT_LABELS = [
  'GET /identity-providers', 'POST /identity-providers',
  'GET /notification-endpoints', 'PUT /notification-endpoints',
];
const lockedCapture = (labels) => labels.map((label) => decisionRecord(label, false, 403, 'FORBIDDEN'));

test('`2a8087c3` RED (reviewer input): one identity-provider capture is not both ratified locked surfaces', () => {
  // The reviewer supplied a single identity-provider capture and received
  // `ok:true` — "1 decisions byte-identical" — so removing the locked
  // short-circuit for notification endpoints stayed green.
  const one = lockedCapture(['GET /identity-providers']);
  const verdict = capturesIdentical(one, one, { minimum: 1, expectedLabels: LOCKED_CONTRACT_LABELS });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /notification-endpoints/);
});

test('`2a8087c3` CONTROL: the complete locked family set compares and passes', () => {
  const full = lockedCapture(LOCKED_CONTRACT_LABELS);
  const verdict = capturesIdentical(full, full, { minimum: LOCKED_CONTRACT_LABELS.length, expectedLabels: LOCKED_CONTRACT_LABELS });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('`2a8087c3` RED: a capture carrying a label OUTSIDE the contract set is refused too', () => {
  const wrong = lockedCapture([...LOCKED_CONTRACT_LABELS, 'GET /invented']);
  const verdict = capturesIdentical(wrong, wrong, { minimum: 1, expectedLabels: LOCKED_CONTRACT_LABELS });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /outside it/);
});

test('`2a8087c3` RED: the locked grant moving ONE decision is still caught', () => {
  const before = lockedCapture(LOCKED_CONTRACT_LABELS);
  const after = before.map((row, i) => (i === 2 ? admittedNow(row) : row));
  const verdict = capturesIdentical(before, after, { minimum: 1, expectedLabels: LOCKED_CONTRACT_LABELS });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /notification-endpoints/);
});

// ── `e3f57d06` (A2 B5): the malformed arm trace records ────────────────────

test('`e3f57d06` RED (reviewer input): /tasks?x=1 is the forbidden family', () => {
  const verdict = armRecordExcludes([`${ARM_TRACE_PREFIX} /tasks?x=1 hostile.fixture`], ['/tasks']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not the shape the arm emits/);
});

test('`e3f57d06` RED (reviewer input): /TASKS is the forbidden family', () => {
  const verdict = armRecordExcludes([`${ARM_TRACE_PREFIX} /TASKS hostile.fixture`], ['/tasks']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not the shape the arm emits/);
});

test('`e3f57d06` RED (reviewer input): //tasks is the forbidden family', () => {
  const verdict = armRecordExcludes([`${ARM_TRACE_PREFIX} //tasks hostile.fixture`], ['/tasks']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not the shape the arm emits/);
});

test('`e3f57d06` RED: a record with the wrong arity did not come from the arm', () => {
  const verdict = armRecordExcludes([`${ARM_TRACE_PREFIX} /webhooks settings.webhooks extra`], ['/tasks']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /carries 3 field\(s\)/);
});

test('`e3f57d06` RED: a first field that is not a path is not an invocation', () => {
  const verdict = armRecordExcludes([`${ARM_TRACE_PREFIX} tasks settings.webhooks`], ['/tasks']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not a path at all/);
});

test('`e3f57d06` CONTROL: the CANONICAL line production emits still passes', () => {
  const verdict = armRecordExcludes([`${ARM_TRACE_PREFIX} /webhooks settings.webhooks`], ['/tasks']);
  assert.equal(verdict.ok, true, verdict.reason);
});

test('`e3f57d06` CONTROL: a forbidden family named non-canonically still catches a canonical record', () => {
  // The comparison canonicalises BOTH sides, so a caller naming the forbidden
  // family as `//TASKS/` cannot let a real `/tasks` invocation through.
  const verdict = armRecordExcludes([`${ARM_TRACE_PREFIX} /tasks/sub settings.hostile`], ['//TASKS/']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /was invoked on scope-gated/);
});

test('`e3f57d06` VACUITY: naming NO forbidden family proves nothing', () => {
  const verdict = armRecordExcludes([`${ARM_TRACE_PREFIX} /webhooks settings.webhooks`], []);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no forbidden family was named/);
});

// ── `93a7cbdb`: the run boundary ───────────────────────────────────────────

test('`93a7cbdb` RED: a row from a PREVIOUS run cannot cover this run`s refusal', () => {
  const stale = { ...auditRow('GET', '/webhooks'), occurredAt: '2026-09-02T23:00:00.000Z' };
  const verdict = audited([stale], { expected: [{ method: 'GET', path: '/webhooks', rowIds: [stale.id] }] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /OUTSIDE run/);
});

test('`93a7cbdb` RED: a row named in the boundary`s pre-existing set is excluded by IDENTITY', () => {
  const row = auditRow('GET', '/webhooks');
  const verdict = refusalsAudited([row], {
    accessLevels: RATIFIED_LEVELS,
    expected: [{ method: 'GET', path: '/webhooks', rowIds: [row.id] }],
    ledger: [{ seq: 1, rowIds: [row.id] }],
    runBoundary: { ...RUN, preExistingIds: [row.id] },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /OUTSIDE run/);
});

test('`93a7cbdb` RED: a row carrying no time at all cannot be placed in the run', () => {
  const undated = { ...auditRow('GET', '/webhooks'), occurredAt: undefined };
  const verdict = audited([undated], { expected: [{ method: 'GET', path: '/webhooks', rowIds: [undated.id] }] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /OUTSIDE run/);
});

test('`93a7cbdb` VACUITY: no boundary at all is refused, however good the rows are', () => {
  const verdict = refusalsAudited([auditRow('GET', '/webhooks')], { expected: [{ method: 'GET', path: '/webhooks', rowIds: [] }], ledger: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no run boundary/);
});

test('`93a7cbdb` VACUITY: a boundary with no pre-existing id list bounds nothing by identity', () => {
  const verdict = refusalsAudited([auditRow('GET', '/webhooks')], {
    expected: [{ method: 'GET', path: '/webhooks', rowIds: [] }],
    ledger: [],
    runBoundary: { runId: 'r', startedAt: RUN.startedAt },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /pre-existing row ids/);
});

test('`93a7cbdb` CONTROL: rows INSIDE the boundary still correlate, and the run is named', () => {
  const row = auditRow('GET', '/webhooks');
  const verdict = audited([row], { expected: [{ method: 'GET', path: '/webhooks', rowIds: [row.id] }] });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(verdict.reason, /run-fixture-0001/);
});

// ── the drill layer's copy of the production normaliser ────────────────────

test('canonicalPath: the spellings round 3 broke all collapse to one form', () => {
  for (const spelling of ['/tasks', '/TASKS', '//tasks', '/tasks?x=1', '/tasks/', '//TASKS//?a=b']) {
    assert.equal(canonicalPath(spelling), '/tasks', spelling);
  }
  assert.equal(canonicalPath(''), '/');
  assert.equal(canonicalPath('//'), '/');
  assert.equal(canonicalPath(undefined), '/');
});

test('stableJson: two equal bodies serialise equal whatever the key order', () => {
  assert.equal(stableJson({ a: 1, b: { d: 4, c: 3 } }), stableJson({ b: { c: 3, d: 4 }, a: 1 }));
  assert.notEqual(stableJson({ a: 1 }), stableJson({ a: 2 }));
  assert.equal(stableJson(undefined), 'undefined');
});

test('actSignature: the act is method, canonical path AND body', () => {
  const base = { method: 'POST', route: '/grants', body: { resourceId: 'x' } };
  assert.equal(actSignature(base), actSignature({ ...base, route: '//GRANTS/?y=1' }));
  assert.notEqual(actSignature(base), actSignature({ ...base, body: { resourceId: 'y' } }));
  assert.notEqual(actSignature(base), actSignature({ ...base, route: '/groups' }));
});

// ── D6 crosses the seam: the LEDGER says which stage answered ──────────────
//
// Found by the round-4 contract census on its first live run. The round-3 D6
// probed two id-less routes on one surface and never met the ambiguity; the
// census probes every declared family, and `PATCH /services/:id/owner-plane` at
// `configure` reaches the HANDLER, which answers `404 RESOURCE_NOT_FOUND` for
// an id that resolves nothing — byte-identical to §9.6's concealment, and
// deliberately so. A shape-only oracle read that as the surface stage refusing
// a caller who holds the level. §3.6 is the discriminator: only the surface
// stage writes `surface.refused`.

test('D6 SEAM: a HANDLER 404 for a caller who holds the level is not the surface stage', () => {
  // The live case, exactly: sufficient level, `404 RESOURCE_NOT_FOUND`, and NO
  // audit row — because the arm admitted and the handler answered.
  const verdict = d6(d6Good.map((o) => (o.label === 'configure/write'
    ? { ...o, ...concealed, surfaceRefusalRows: 0 } : o)));
  assert.equal(verdict.ok, true, verdict.reason);
});

test('D6 SEAM RED: the SAME 404 WITH an audit row is the surface stage refusing a sufficient caller', () => {
  const verdict = d6(d6Good.map((o) => (o.label === 'configure/write'
    ? { ...o, ...concealed, surfaceRefusalRows: 1 } : o)));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /is sufficient .* but the surface stage refused it and wrote 1/);
});

test('D6 SEAM RED: an insufficient caller refused by something that wrote NO row is not the arm', () => {
  // The mutation this gate exists for in the other direction: the arm stops
  // auditing (or stops running) and some other stage answers with a shape that
  // happens to look right. The ledger is what notices.
  const verdict = d6(d6Good.map((o) => (o.label === 'none/read'
    ? { ...o, surfaceRefusalRows: 0 } : o)));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /wrote NO refusal row/);
});

test('D6 SEAM RED: an audited refusal in the WRONG shape is still a failure', () => {
  const verdict = d6(d6Good.map((o) => (o.label === 'none/read'
    ? { ...o, status: 500, code: 'INTERNAL_ERROR', surfaceRefusalRows: 1 } : o)));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /rather than a ratified refusal shape/);
});

test('D6 SEAM VACUITY: an observation that never measured the ledger cannot be judged', () => {
  const verdict = d6(d6Good.map(({ surfaceRefusalRows, ...rest }) => rest));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no count of the surface-stage audit rows/);
});

// ════════════════════════════════════════════════════════════════════════════
// ROUND-5 RED PROOFS — one per repaired finding, each with the reviewer's own
// input as the bad state and each reddening a DIFFERENT assertion (annex §8.1).
//
// Sources: A2 re-review `252fe7e6` (B1, B2) and the four uncommissioned
// verdicts `eed02f4e` / `d6629eec` (A1 F1, F2, F4) and `36e8588e` /
// `17ee72f7` (A2 B2 partition, B3 `use`, B4 D16, B5 five acts, B6 wrong row).
// ════════════════════════════════════════════════════════════════════════════

import {
  assertRatifiedSet,
  buildD17Census,
  buildPluginLevelCensus,
  levelAnswersClass,
  ratifiedAuthorityStores,
  ratifiedBearerLayers,
  authoritySeamCompositionDrift,
} from './setgov-drill-contract.mjs';

// ── `eed02f4e` F1: the expected label set is a MULTISET ─────────────────────

const decision = (label, status) => ({ label, admitted: status >= 200 && status < 300, evidence: { status, code: null } });

test('`eed02f4e` F1 RED (reviewer input): a capture of [A, A, B] does not satisfy a contract of [A, B, C]', () => {
  // The finding verbatim: the comparison was `includes`-based in both
  // directions, so a duplicated label stood in for a MISSING ratified one and
  // the size check that follows only compared the two captures to each other.
  const doubled = [decision('A', 200), decision('A', 200), decision('B', 403)];
  const verdict = capturesIdentical(doubled, doubled, { expectedLabels: ['A', 'B', 'C'], minimum: 1 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /required label\(s\) absent \(C\)/);
  assert.match(verdict.reason, /1 repeated \(A\)/);
});

test('`eed02f4e` F1 RED: a capture holding a ratified label TWICE and no other defect is still refused', () => {
  const doubled = [decision('A', 200), decision('A', 200)];
  const verdict = capturesIdentical(doubled, doubled, { expectedLabels: ['A', 'B'], minimum: 1 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /repeated/);
});

test('`eed02f4e` F1 CONTROL: the exact contract multiset still passes', () => {
  const exact = [decision('A', 200), decision('B', 403)];
  const verdict = capturesIdentical(exact, exact, { expectedLabels: ['A', 'B'], minimum: 2 });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('`eed02f4e` F1 CONTROL-OF-THE-CONTROL: a contract naming a label twice is not a contract', () => {
  const exact = [decision('A', 200), decision('A', 200)];
  const verdict = capturesIdentical(exact, exact, { expectedLabels: ['A', 'A'], minimum: 1 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /more than once/);
});

// ── `eed02f4e` F2: a 3xx is not an authorization decision ───────────────────

test('`eed02f4e` F2 RED (reviewer input): two identical 302s are not a byte-identical DECISION', () => {
  const redirected = [decision('A', 302), decision('B', 302)];
  const verdict = capturesIdentical(redirected, redirected, { expectedLabels: ['A', 'B'], minimum: 1 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /excluded/i);
});

test('`eed02f4e` F2: the predicate itself refuses a redirect', () => {
  assert.equal(isAuthorizationDecision({ status: 302 }), false);
  assert.equal(isAuthorizationDecision({ status: 200 }), true);
  assert.equal(isAuthorizationDecision({ status: 403 }), true);
  assert.match(String(decisionDefect({ status: 302 })), /REDIRECT/);
});

test('`eed02f4e` F2 RED: a record calling a 3xx an ADMISSION is malformed', () => {
  assert.match(String(decisionRecordDefect({ label: 'A', admitted: true, evidence: { status: 302 } })), /redirect/);
  assert.equal(decisionRecordDefect({ label: 'A', admitted: false, evidence: { status: 302 } }), null);
});

test('`eed02f4e` F2 CONTROL: a capture of nothing but redirects cannot reach `minimum`', () => {
  const redirected = [decision('A', 302), decision('B', 302)];
  const verdict = capturesIdentical(redirected, redirected, { expectedLabels: ['A', 'B'], minimum: 2 });
  assert.equal(verdict.ok, false);
});

// ── `36e8588e` B2: the partition is over (surface, family) PAIRS ────────────

const PARTITION_FAMILIES = [
  { surfaceKey: 'settings.webhooks', familyKey: 'GET /webhooks' },
  { surfaceKey: 'settings.webhooks', familyKey: 'POST /webhooks' },
  { surfaceKey: 'settings.access-grants', familyKey: 'POST /grants' },
];
const partitionInput = (overrides = {}) => governableCatalogueIsPartitioned({
  governableFamilies: PARTITION_FAMILIES,
  d6Cells: ['none', 'use', 'configure'].flatMap((state) => PARTITION_FAMILIES
    .filter((family) => family.surfaceKey === 'settings.webhooks')
    .map((family) => ({ callerState: state, ...family }))),
  withheldFamilies: PARTITION_FAMILIES.filter((family) => family.surfaceKey === 'settings.access-grants'),
  ...overrides,
});

test('`36e8588e` B2 CONTROL: D6 and D21 covering every pair exactly once passes', () => {
  const verdict = partitionInput();
  assert.equal(verdict.ok, true, verdict.reason);
});

test('`36e8588e` B2 RED (reviewer input): dropping ONE family of a multi-family surface is caught', () => {
  // The finding verbatim: the old form compared a Set of SURFACE KEYS, so
  // `settings.webhooks` stayed "covered" by its other family while
  // `POST /webhooks` was measured by nothing at all.
  const verdict = partitionInput({
    d6Cells: partitionInput().ok ? ['none', 'use', 'configure'].map((state) => ({
      callerState: state, surfaceKey: 'settings.webhooks', familyKey: 'GET /webhooks',
    })) : [],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /settings\.webhooks\|POST \/webhooks/);
  assert.match(verdict.reason, /NEITHER/);
});

test('`36e8588e` B2 RED: a family measured by BOTH drills is a contract defect, not a redundancy', () => {
  const verdict = partitionInput({ withheldFamilies: PARTITION_FAMILIES });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /in BOTH/);
});

test('`36e8588e` B2 RED: a measured family outside the governable catalogue is refused', () => {
  const verdict = partitionInput({
    withheldFamilies: [{ surfaceKey: 'invented.everything', familyKey: 'POST /tasks' },
      ...PARTITION_FAMILIES.filter((family) => family.surfaceKey === 'settings.access-grants')],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not governable families/);
});

test('`36e8588e` B2 VACUITY: an empty governable catalogue has nothing to partition', () => {
  const verdict = governableCatalogueIsPartitioned({ governableFamilies: [], d6Cells: [], withheldFamilies: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no governable family/);
});

// ── `36e8588e` B5: the replay must BE the ratified five acts ────────────────

test('`36e8588e` B5 RED (reviewer input): a ONE-ACT escalation with a matching one-act root list', () => {
  // The finding verbatim: `ok:true` about a fifth of the escalation, because
  // the two act lists were only ever compared to EACH OTHER.
  const oneAct = goodActs.slice(0, 1);
  const verdict = authorityMutationArmNeverAdmits(armInput({
    observations: oneAct,
    rootControl: { acts: goodRootActs.slice(0, 1), rowsBefore: 7, rowsAfter: 12 },
    auditRows: goodArmAuditPerAct.slice(0, 1),
    expectedRefusals: ACT_EXPECTATIONS.slice(0, 1),
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not the ratified escalation/);
  assert.match(verdict.reason, /4 ratified act\(s\) never run/);
});

test('`36e8588e` B5 RED: an act OUTSIDE the ratified five cannot stand in for one of them', () => {
  const swapped = [{ label: 'POST /health', method: 'POST', route: '/health', ...bare403 }, ...goodActs.slice(1)];
  const verdict = authorityMutationArmNeverAdmits(armInput({
    observations: swapped,
    rootControl: { acts: swapped.map((act) => ({ ...act, status: 201, code: undefined })), rowsBefore: 7, rowsAfter: 12 },
  }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /act\(s\) outside it/);
});

test('`36e8588e` B5 VACUITY: no ratified set, and no production matcher, are both refused', () => {
  assert.match(authorityMutationArmNeverAdmits(armInput({ ratifiedActs: [] })).reason, /no ratified act set/);
  assert.match(authorityMutationArmNeverAdmits(armInput({ familyMatches: undefined })).reason, /no production family matcher/);
});

test('`36e8588e` B5 CONTROL-OF-THE-TRANSCRIPTION: the five acts name the three withheld surfaces', () => {
  // The transcription is only worth its agreement with the ruling: every act
  // must name a surface owner ruling `70af4d82` §1.1 withheld. The live drill
  // additionally checks each key against the CATALOGUE before using it.
  for (const want of RATIFIED_ESCALATION_ACTS) {
    assert.ok(AUTHORITY_MUTATION_SURFACE_KEYS.includes(want.surfaceKey), want.familyKey);
    assert.match(want.familyKey, /^POST \//);
  }
  assert.equal(RATIFIED_ESCALATION_ACTS.length, 5);
});

// ── `36e8588e` B6: the row must agree with what the contract knows ──────────

test('`36e8588e` B6 RED (reviewer input): a row for the right URL naming the WRONG surface', () => {
  const wrong = auditRow('GET', '/webhooks', { surfaceKey: 'settings.appearance' });
  const verdict = audited([wrong], {
    expected: [{ method: 'GET', path: '/webhooks', surfaceKey: 'settings.webhooks', rowIds: [wrong.id] }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /surfaceKey 'settings.appearance' where the contract says 'settings.webhooks'/);
});

test('`36e8588e` B6 RED: a row carrying a level the caller does not hold', () => {
  const wrong = auditRow('GET', '/webhooks', { accessLevel: 'configure' });
  const verdict = audited([wrong], {
    expected: [{ method: 'GET', path: '/webhooks', accessLevel: 'none', rowIds: [wrong.id] }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /accessLevel 'configure' where the contract says 'none'/);
});

test('`36e8588e` B6 RED: a row claiming the wrong FAMILY CLASS', () => {
  const wrong = auditRow('GET', '/webhooks', { family: 'write' });
  const verdict = audited([wrong], {
    expected: [{ method: 'GET', path: '/webhooks', family: 'read', rowIds: [wrong.id] }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /family 'write' where the contract says 'read'/);
});

test('`36e8588e` B6 RED: `accessLevel: yes` no longer satisfies a truthiness test', () => {
  const wrong = auditRow('GET', '/webhooks', { accessLevel: 'yes' });
  const verdict = audited([wrong], { expected: [{ method: 'GET', path: '/webhooks', rowIds: [wrong.id] }] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not one of the ratified/);
});

test('`36e8588e` B6 VACUITY: no ratified level vocabulary is refused outright', () => {
  const row = auditRow('GET', '/webhooks');
  const verdict = refusalsAudited([row], {
    runBoundary: RUN, ledger: [{ seq: 1, rowIds: [row.id] }],
    expected: [{ method: 'GET', path: '/webhooks', rowIds: [row.id] }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no ratified access levels/);
});

test('`36e8588e` B6 CONTROL: a row agreeing with every named field passes', () => {
  const right = auditRow('GET', '/webhooks', { family: 'read' });
  const verdict = audited([right], {
    expected: [{
      method: 'GET', path: '/webhooks', surfaceKey: 'settings.webhooks',
      accessLevel: 'none', family: 'read', rowIds: [right.id],
    }],
  });
  assert.equal(verdict.ok, true, verdict.reason);
});

// ── `252fe7e6` B1 / B2: the two dimensions come from PRODUCTION ─────────────

/** A fake production contract — the shape `loadProductionContract` returns. */
const fakeSeam = (table) => (offset) => ({
  sql: `EXISTS (SELECT 1 FROM ${table} t WHERE t.p = $${offset} AND t.r = $${offset + 1} AND t.v = $${offset + 2} AND t.rid = <RESOURCE_ID_COLUMN>)`,
  bind: (principalId, resourceType, verb) => [principalId, resourceType, verb],
});
const fakeContract = (overrides = {}) => ({
  // The route-map helpers `declaredFamilies` needs, spelled the way production
  // spells them so the census below is built the same way it is in the drill.
  parseFamilyKey: (key) => {
    const [method, path] = String(key).split(' ');
    return method && path ? { method, path } : null;
  },
  familySamplePath: (path) => String(path).split('/').map((part) => (part.startsWith(':') ? 'sample' : part)).join('/'),
  normalizePathForScope: (path) => String(path).replace(/\/+/g, '/').replace(/\?.*$/, '').replace(/(.)\/$/, '$1').toLowerCase(),
  READ_ONLY_METHODS: new Set(['GET', 'HEAD', 'OPTIONS']),
  ACCESS_LEVELS: ['none', 'use', 'configure'],
  levelAtLeast: (level, floor) => ['none', 'use', 'configure'].indexOf(level) >= ['none', 'use', 'configure'].indexOf(floor),
  DELEGATED_BEARER_LAYERS: ['agent', 'connector'],
  AUTHORITY_SEAMS: [
    { store: 'surface-grant', condition: fakeSeam('grants') },
    { store: 'profile-assignment', condition: fakeSeam('access_profile_assignments') },
  ],
  ...overrides,
});
/** A `surfaceLevel` composed FROM the inventory, the way production composes it. */
const composedSurfaceLevel = (seams, extra = '') => async (principalId, surfaceId, queryable) => {
  const params = [surfaceId];
  const clause = (verb) => {
    const fragments = seams.map((seam) => {
      const opened = seam.condition(params.length + 1);
      params.push(...opened.bind(principalId, 'surface', verb));
      return `(${opened.sql.split('<RESOURCE_ID_COLUMN>').join('$1::uuid')
        // A surface has no project perimeter, so the project-bounded arm
        // (card 95572530) renders FALSE - what `renderAuthoritySeam` does.
        .split('<PROJECT_BOUNDED_ARM>').join('FALSE')})`;
    });
    return `(${[...fragments, ...(extra ? [extra] : [])].join(' OR ')})`;
  };
  const sql = `SELECT ${clause('read')} AS can_read, ${clause('write')} AS can_write`;
  await queryable.query(sql, params);
  return 'none';
};

test('`252fe7e6` B2 CONTROL: the exported seams and the composed SQL agree', async () => {
  const contract = fakeContract();
  contract.surfaceLevel = composedSurfaceLevel(contract.AUTHORITY_SEAMS);
  const drift = await authoritySeamCompositionDrift(contract);
  assert.deepEqual(drift.problems, []);
  assert.equal(drift.actualExists, 4);
});

test('`252fe7e6` B2 RED (reviewer input): a THIRD authority path opened INLINE is unaccounted for', () => {
  // The finding verbatim: the reviewer added a third production seam and it
  // appeared in no expected set. It appears here, in the one place that reads
  // the SQL rather than a list.
  const contract = fakeContract();
  contract.surfaceLevel = composedSurfaceLevel(
    contract.AUTHORITY_SEAMS,
    'EXISTS (SELECT 1 FROM undeclared_source b WHERE b.p = $1::uuid)',
  );
  return authoritySeamCompositionDrift(contract).then((drift) => {
    assert.ok(drift.problems.length > 0);
    assert.match(drift.problems.join(' | '), /AUTHORITY_SEAMS does not declare/);
  });
});

test('`252fe7e6` B2 RED: a seam DECLARED but not composed is caught in the other direction', async () => {
  const contract = fakeContract();
  contract.AUTHORITY_SEAMS = [...contract.AUTHORITY_SEAMS, { store: 'ghost', condition: fakeSeam('ghost_rows') }];
  contract.surfaceLevel = composedSurfaceLevel(contract.AUTHORITY_SEAMS.slice(0, 2));
  const drift = await authoritySeamCompositionDrift(contract);
  assert.ok(drift.problems.length > 0);
  assert.match(drift.problems.join(' | '), /'ghost' contributes its fragment 0 time\(s\)/);
});

test('`252fe7e6` B2 RED: an undeclared authority path of ANY SHAPE is caught, not just the EXISTS one', async () => {
  // SELF-FOUND, before the round-5 verdicts: the first form of this control
  // counted `EXISTS (SELECT` openings, so it caught an EXISTS form and MISSED
  // `IN (SELECT ...)`, `= ANY (SELECT ...)`, a scalar subquery, a bare
  // `(SELECT ... LIMIT 1)` and a plain function call - five authority paths to a surface
  // level, none of them declared, none of them red. The control now measures
  // the RESIDUE against a closed vocabulary, so the shape does not matter.
  const shapes = {
    'EXISTS': 'EXISTS (SELECT 1 FROM undeclared_source b WHERE b.p = $1::uuid)',
    'IN (SELECT)': '$1::uuid IN (SELECT surface_id FROM undeclared_source)',
    '= ANY (SELECT)': '$1::uuid = ANY (SELECT surface_id FROM undeclared_source)',
    'scalar subquery': '(SELECT count(*) FROM undeclared_source) > 0',
    'bare subquery': '(SELECT b.allowed FROM undeclared_source b LIMIT 1)',
    'function call': 'undeclared_source_check($1::uuid)',
    'column reference': 'undeclared_source_allowed',
    // ROUND-5 REVIEW (half A2, B1), verbatim: an undeclared authority path
    // spelled ENTIRELY in words the first, vocabulary-based form of this
    // control allowed -- `seam` was its own marker and `false` its no-seam
    // branch. The residue is now compared for EQUALITY, so the words in it
    // stopped mattering.
    'allowed words only': 'seam(FALSE)',
    'marker forgery': 'seam',
    'always-false term': 'FALSE',
  };
  for (const [form, sqlPath] of Object.entries(shapes)) {
    const contract = fakeContract();
    contract.surfaceLevel = composedSurfaceLevel(contract.AUTHORITY_SEAMS, sqlPath);
    const drift = await authoritySeamCompositionDrift(contract);
    assert.ok(drift.problems.length > 0, `${form} form was NOT caught`);
    assert.match(drift.problems.join(' | '), /AUTHORITY_SEAMS does not declare|residue/);
  }
});

test('round-5 A2 B1 CONTROL: the residue is an EQUALITY, so no vocabulary can be forged past it', async () => {
  const contract = fakeContract();
  contract.surfaceLevel = composedSurfaceLevel(contract.AUTHORITY_SEAMS, 'seam(FALSE)');
  const drift = await authoritySeamCompositionDrift(contract);
  assert.ok(drift.problems.length > 0);
  assert.match(drift.problems.join(' | '), /composes something other than the 2-seam disjunction/);
});

test('`252fe7e6` B2 CONTROL-OF-THE-CONTROL: the SHIPPED composition leaves a clean residue', async () => {
  // The control above is only worth its false-positive rate: if the residue
  // check reddened on the real composition it would be noise, and the drill
  // would be disabled the first time someone reformatted the arm.
  const contract = fakeContract();
  contract.surfaceLevel = composedSurfaceLevel(contract.AUTHORITY_SEAMS);
  const drift = await authoritySeamCompositionDrift(contract);
  assert.deepEqual(drift.problems, []);
  assert.match(drift.residue, /^SELECT/);
  assert.ok(!/undeclared_source/.test(drift.residue));
  // and the marker is not a word anything could write
  assert.ok(drift.residue.includes('\u0000SEAM\u0000'));
});

test('`252fe7e6` B2: a seam DECLARED and composed twice over is still exactly two occurrences', async () => {
  // The occurrence check and the residue check must not cover for each other:
  // a fragment composed FOUR times leaves a clean residue but is not the
  // read+write pair `surfaceLevel` must compose.
  const contract = fakeContract();
  const seams = contract.AUTHORITY_SEAMS;
  contract.surfaceLevel = async (principalId, surfaceId, queryable) => {
    const params = [surfaceId];
    const clause = () => {
      const fragments = seams.map((seam) => {
        const opened = seam.condition(params.length + 1);
        params.push(...opened.bind(principalId, 'surface', 'read'));
        return `(${opened.sql.split('<RESOURCE_ID_COLUMN>').join('$1::uuid')
        // A surface has no project perimeter, so the project-bounded arm
        // (card 95572530) renders FALSE - what `renderAuthoritySeam` does.
        .split('<PROJECT_BOUNDED_ARM>').join('FALSE')})`;
      });
      return `(${fragments.join(' OR ')})`;
    };
    await queryable.query(`SELECT ${clause()} AS can_read, ${clause()} AS can_write, ${clause()} AS can_read`, params);
    return 'none';
  };
  const drift = await authoritySeamCompositionDrift(contract);
  assert.ok(drift.problems.length > 0);
  assert.match(drift.problems.join(' | '), /contributes its fragment 3 time\(s\)/);
});

test('`252fe7e6` B2: a third exported seam grows the ratified store set with no list edited', () => {
  const contract = fakeContract();
  assert.deepEqual(ratifiedAuthorityStores(contract).map((entry) => entry.store), ['surface-grant', 'profile-assignment']);
  contract.AUTHORITY_SEAMS = [...contract.AUTHORITY_SEAMS, { store: 'third-path', condition: fakeSeam('third_rows') }];
  const grown = ratifiedAuthorityStores(contract).map((entry) => entry.store);
  assert.deepEqual(grown, ['surface-grant', 'profile-assignment', 'third-path']);
  // ...and a drill that keeps testing two of the three now goes red.
  assert.throws(() => assertRatifiedSet('D17 authority stores', ['surface-grant', 'profile-assignment'], grown),
    /not the ratified set/);
});

test('`252fe7e6` B2 VACUITY: no exported inventory at all is refused', () => {
  assert.throws(() => ratifiedAuthorityStores(fakeContract({ AUTHORITY_SEAMS: [] })), /exports no AUTHORITY_SEAMS/);
});

test('`252fe7e6` B1 RED (reviewer input): the D17 census can no longer be handed its own ratified side', () => {
  // The finding verbatim: `buildD17Census` took `bearers` AND `ratifiedBearers`
  // and compared one caller argument to the other, so a caller reducing BOTH
  // identically got a smaller green census. The ratified side is production's
  // and the reduced call now throws.
  const contract = fakeContract();
  const surfaceRow = {
    key: 'settings.webhooks',
    read_families: ['GET /webhooks'], write_families: ['POST /webhooks'],
  };
  const args = { surfaceRow, stores: ['surface-grant', 'profile-assignment'] };
  assert.throws(
    () => buildD17Census(contract, { ...args, bearers: ['agent'], ratifiedBearers: ['agent'] }),
    /D17 bearer layers .* not the ratified set/,
  );
  const full = buildD17Census(contract, { ...args, bearers: ['agent', 'connector'] });
  assert.equal(full.length, 2 * 2 * 2);
});

test('`252fe7e6` B1 VACUITY: production exporting no bearer layers refuses the matrix', () => {
  assert.throws(() => ratifiedBearerLayers(fakeContract({ DELEGATED_BEARER_LAYERS: [] })),
    /exports no DELEGATED_BEARER_LAYERS/);
});

// ── `36e8588e` B3 at the census rung: the level dimension is production's ───

test('`36e8588e` B3: the plugin census refuses a level set that is not production\'s', () => {
  const contract = fakeContract();
  const coreCells = [{ key: 'agent|surface-grant|read', bearer: 'agent', store: 'surface-grant', familyClass: 'read' }];
  assert.throws(() => buildPluginLevelCensus(contract, { coreCells, levels: ['none', 'configure'] }),
    /D17 plugin access levels .* not the ratified set/);
  const full = buildPluginLevelCensus(contract, { coreCells, levels: ['none', 'use', 'configure'] });
  assert.equal(full.length, 3);
  assert.deepEqual(full.map((cell) => cell.expectAdmitted), [false, true, true]);
});

test('`36e8588e` B3: the admission per cell is production\'s ordering, not a table here', () => {
  const contract = fakeContract();
  assert.equal(levelAnswersClass(contract, 'use', 'read'), true);
  assert.equal(levelAnswersClass(contract, 'use', 'write'), false);
  assert.equal(levelAnswersClass(contract, 'configure', 'write'), true);
  assert.equal(levelAnswersClass(contract, 'none', 'read'), false);
});
