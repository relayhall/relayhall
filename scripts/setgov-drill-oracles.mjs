/**
 * setgov-drill-oracles — the verdicts of `setgov-live-drill.mjs`, as pure
 * functions with their own controls.
 *
 * SETGOV candidate A (card `bbec04de`); acceptance annex `85a2218d` D1, D2,
 * D3, D6, D10, D13, D15, D16, D17, D19, D21.
 *
 * WHY THE VERDICTS LIVE HERE, away from the drill that observes them.
 *
 * This board has been taught the lesson twice that a drill which RECORDS a
 * value and never judges it passes on the bad state (`cba66ebb`, `533db731`,
 * both in the SSO login drill). It has also been taught that an oracle
 * rebuilt inside its own test can be edited to agree with whatever the code
 * does. So: the oracles take the VALUES the drill observed - statuses, bodies,
 * decision captures, log lines, row counts - never a live connection, and
 * `setgov-drill-oracles.test.mjs` hands each one the exact bad state the
 * annex's red mutation produces and requires it to go red.
 *
 * The one asymmetry worth naming: `surfaceStageShape` classifies a RESPONSE,
 * and the annex's D6 assertion is about WHEN that shape appears. Those are two
 * different oracles here on purpose - a classifier that also decided when it
 * was correct could be satisfied by a constant.
 */

/** The named code the surface stage answers on a write family a caller may read. */
export const SURFACE_LEVEL_INSUFFICIENT = 'SURFACE_LEVEL_INSUFFICIENT';
/** The audited act every surface-stage refusal writes (design §3.6). */
export const SURFACE_REFUSAL_ACT = 'surface.refused';
/** The one line the arm prints under RELAYHALL_SURFACE_ARM_TRACE=1. */
export const ARM_TRACE_PREFIX = 'SURFACE ARM INVOCATION';

/**
 * THE canonical path form, spelled exactly as production's
 * `utils/scopeMap.normalizePathForScope` spells it: the query string dropped,
 * repeated slashes collapsed, lower-cased, trailing slashes trimmed, and the
 * empty path answering `/`.
 *
 * It is RE-IMPLEMENTED here on purpose, so these oracles stay pure functions of
 * the values a drill observed and can be proved with `node --test` against a
 * tree that has not been built. A re-implementation is drift waiting to happen,
 * so it never stands alone: `setgov-drill-contract.mjs` exports
 * `normaliserDrift`, which compares this function against the COMPILED
 * production one over a hostile corpus, and both the live drill and this
 * module's own suite run that comparison. The anchor is the real predicate;
 * this is only the copy that reaches a pure oracle.
 */
export function canonicalPath(value) {
  const collapsed = (String(value ?? '') || '/').split('?')[0].replace(/\/{2,}/g, '/').toLowerCase();
  const trimmed = collapsed.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * JSON with object keys in a fixed order, so two equal bodies serialise equal
 * however they were built. Used by `actSignature`, where a body is part of
 * WHICH ACT was performed.
 */
export function stableJson(value) {
  if (value === undefined) return 'undefined';
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.keys(node).sort().map((key) => [key, walk(node[key])]));
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

/**
 * Classify one HTTP answer at the surface stage.
 *
 *   'admitted'            - 2xx or any answer the handler produced
 *   'concealed'           - 404 RESOURCE_NOT_FOUND: the 44d1bf89 pattern
 *   'level-insufficient'  - 403 naming the surface on a write family
 *   'route-refusal'       - the pin's own 403, i.e. the surface stage said
 *                           nothing at all
 *   'handler-refusal'     - a 4xx the handler produced with its own code
 */
export function surfaceStageShape({ status, code, message }) {
  const httpStatus = Number(status);
  if (httpStatus >= 200 && httpStatus < 300) return 'admitted';
  if (httpStatus === 404 && code === 'RESOURCE_NOT_FOUND') return 'concealed';
  if (httpStatus === 403 && code === SURFACE_LEVEL_INSUFFICIENT) {
    // "403 NAMING THE SURFACE" is the ratified shape - a bare 403 is not it.
    return String(message ?? '').trim().length > 0 ? 'level-insufficient' : 'route-refusal';
  }
  if (httpStatus === 403 && code === 'FORBIDDEN') return 'route-refusal';
  return 'handler-refusal';
}

/** Is this shape one the SURFACE STAGE produced? */
export function isSurfaceStageRefusal(shape) {
  return shape === 'concealed' || shape === 'level-insufficient';
}

/**
 * Is this answer a REFUSAL THE AUTHORIZATION STACK PRODUCED — as opposed to
 * "not a 2xx"?
 *
 * Round 1 of this candidate's cross-family review broke three oracles with the
 * same input: an HTTP 500. "Not admitted" was accepted as proof of a refusal by
 * D13, D17 and (through them) parts of D21, so a server that crashed on every
 * request would have passed them all (regressions `f4a8c185`, `4181cb84`). A
 * 401 is excluded for a different reason: it means the CREDENTIAL was not
 * accepted, which is the trap D17's bearer reach control already exists for —
 * four 401s once read as four proofs.
 */
export function isAuthorizationRefusal(observation) {
  const status = Number(observation?.status);
  if (!Number.isFinite(status)) return false;
  if (status < 400 || status >= 500) return false;
  if (status === 401) return false;
  const shape = surfaceStageShape(observation);
  return shape === 'route-refusal' || isSurfaceStageRefusal(shape);
}

/**
 * Is this answer a DECISION THE AUTHORIZATION STACK MADE - as opposed to a
 * crash, a credential that was not accepted, a rate ceiling, or the route map
 * answering?
 *
 * Deliberately WIDER than `isAuthorizationRefusal`, and answering a different
 * question. That predicate judges the SHAPE of a refusal, because D6, D13 and
 * D17 assert WHICH shape appears. This one asks only whether an answer is an
 * authorization outcome at all, which is what a capture COMPARISON needs: two
 * captures are "identical decisions" only if they are decisions.
 *
 * The live drill is what separated the two. `routes/appearanceAdmin.ts` line 29
 * refuses a non-root caller with `res.status(403).json({ error: 'Forbidden',
 * message })` - no `code` at all. That is an authorization refusal in every
 * sense this oracle cares about, and the shape predicate discarded it, so the
 * first form of the `ff9b6437` repair reddened D3(b) on a correct answer.
 */
export function isAuthorizationDecision(observation) {
  const status = Number(observation?.status);
  if (!Number.isFinite(status)) return false;
  // ROUND-4 EXTRA VERDICT `eed02f4e` F2. This admitted every 3xx, so two
  // identical redirects were "a byte-identical authorization decision" and
  // counted toward `minimum` in `capturesIdentical` — the same vacuity a 500
  // gave before `ff9b6437`, one status class further out. A redirect is the
  // ROUTER answering (or a proxy, or a trailing-slash rule); the authorization
  // stack admits with a 2xx and refuses with a 403 or the ratified concealed
  // 404. A 3xx is therefore INDETERMINATE: excluded by name, never compared.
  if (status >= 200 && status < 300) return true;
  if (status === 403) return true;
  if (status === 404 && observation?.code === 'RESOURCE_NOT_FOUND') return true;
  return false;
}

/** Why an observation is not an authorization DECISION, for a reason string. */
export function decisionDefect(observation) {
  const status = Number(observation?.status);
  if (!Number.isFinite(status)) return 'no status at all';
  if (status >= 500) return `a SERVER ERROR (${status}) - a crash is not a decision`;
  if (status === 401) return '401 - the credential was not accepted, which proves nothing about authorization';
  if (status === 429) return '429 - a rate ceiling is not an authorization answer';
  if (status >= 300 && status < 400) return `${status} - a REDIRECT is the router answering, not an authorization decision (eed02f4e F2)`;
  if (status === 404) return '404 carrying no RESOURCE_NOT_FOUND code - the route map answering, not the authorization stack';
  return `${status} ${observation?.code ?? '(no code)'} - not an answer the authorization stack produces`;
}

/** Why an observation is not an authorization refusal, for a reason string. */
export function refusalDefect(observation) {
  const status = Number(observation?.status);
  if (!Number.isFinite(status)) return 'no status at all';
  if (status >= 200 && status < 300) return `ADMITTED (${status})`;
  if (status >= 500) return `a SERVER ERROR (${status}) — a crash is not a refusal`;
  if (status === 401) return '401 — the credential was not accepted, which proves nothing about authorization';
  if (status < 400) return `${status}, which is neither an admission nor a refusal`;
  return `${status} ${observation?.code ?? '(no code)'} — not a shape the authorization stack produces`;
}

const ORDER = { none: 0, use: 1, configure: 2 };
/** The two family classes a surface declares (design §2.4). */
export const LEVEL_FAMILIES = ['read', 'write'];
/** The caller states D5's table names, and D6 measures each `G` family in. */
export const D6_CALLER_STATES = Object.keys(ORDER);

/** Does `level` answer a request on a family of class `family`? (§2.4, I-10.) */
export function levelAnswers(level, family) {
  if (family === 'read') return ORDER[level] >= ORDER.use;
  if (family === 'write') return level === 'configure';
  return false;
}

/**
 * D6 - the surface-stage refusal shape appears EXACTLY when the caller's level
 * is insufficient for the family, and never when it is sufficient.
 *
 * ROUND-3 REGRESSION `2bf39bb7`. The previous form judged each observation
 * against ITS OWN `level` and `family` LABELS and then counted those labels.
 * The drill exercised ONE account, ONE surface and TWO routes; six records all
 * naming the same physical `GET /webhooks` - one of them labelled `none/write`
 * while being a GET - returned `ok:true` with the sentence "all 6 cells of
 * none/use/configure x read/write observed exactly once". A self-labelled
 * six-cell sample is not the annex's "for each caller in D5's table and each
 * `G` surface and each declared family".
 *
 * THE LABELS ARE NO LONGER READ. `census` is the contract-owned expectation
 * built by `setgov-drill-contract.buildD6Census` out of the `access_surfaces`
 * and `access_bundle_members` ROWS THE ARM ITSELF READS: one cell per caller
 * state x governable surface x declared family, each carrying the family class
 * (cross-derived from the catalogue array AND from the production
 * `READ_ONLY_METHODS` set), the level that caller state resolves to for that
 * surface, and the METHOD and canonical PATH a conforming probe must have used.
 *
 * An observation is matched to a cell by (callerState, surfaceKey, familyKey)
 * and must then EQUAL that cell's request - so a record claiming a cell it did
 * not exercise fails on method or path rather than being believed. Every cell
 * must be observed, exactly once, and nothing outside the census counts.
 */
export function d6Verdict(observations, { census } = {}) {
  const cells = census ?? [];
  if (cells.length === 0) {
    return { ok: false, reason: 'no contract census was supplied: D6 cannot be proved against a set the drill named for itself' };
  }
  const seen = observations ?? [];
  if (seen.length === 0) return { ok: false, reason: 'no observations: a drill that measured nothing proves nothing' };

  const byKey = new Map(cells.map((cell) => [cell.key, cell]));
  const counts = new Map();
  const problems = [];
  // Reported BEFORE the missing-cell tally below, and deliberately: a record
  // that names a cell the contract does not have is a more specific diagnosis
  // than the hole it leaves, and reporting the hole first would tell a reader
  // that a cell was "never measured" when in fact something was measured and
  // labelled wrongly.
  const unknown = [];

  for (const o of seen) {
    const label = o?.label ?? '(unlabelled)';
    const key = `${o?.callerState}|${o?.surfaceKey}|${o?.familyKey}`;
    const cell = byKey.get(key);
    if (!cell) {
      unknown.push(`${label}: (${key}) is not a cell of the contract census`);
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    // THE ANTI-LABEL GATE. What the record CLAIMS to be is the key above; what
    // it actually DID must be that cell's own request, in the canonical form
    // production compares paths in.
    const method = String(o?.method ?? '').toUpperCase();
    const path = canonicalPath(o?.route);
    if (method !== cell.method || path !== cell.path) {
      problems.push(`${label}: claims cell ${key}, but the request it made was ${method || '(no method)'} ${path} while that cell is ${cell.method} ${cell.path}`);
      continue;
    }
    // WHICH STAGE ANSWERED IS NOT DECIDABLE FROM THE STATUS CODE, and that is
    // by design. §9.6's concealment is `404 RESOURCE_NOT_FOUND` precisely so a
    // caller cannot tell it from the resource being absent - and a handler's
    // own not-found is the same three fields. The round-3 drill never met the
    // ambiguity because it probed two id-less routes on one surface; the
    // contract census probes every declared family, and
    // `PATCH /services/:id/owner-plane` at `configure` reaches the handler,
    // which answers 404 for an id that resolves nothing. A shape-only oracle
    // reads that as the surface stage concealing from a caller who holds the
    // level.
    //
    // So D6 crosses the seam instead of guessing at it. §3.6 makes the SURFACE
    // STAGE - and only the surface stage - write a `surface.refused` row for
    // every refusal it makes; a handler's 404 writes none. `surfaceRefusalRows`
    // is the count of rows THIS request added to the ledger, measured by the
    // drill around the call, and it is what says which stage answered. The
    // status code still has to be the ratified SHAPE, but it no longer decides
    // WHO produced it.
    const audited = Number(o?.surfaceRefusalRows);
    if (!Number.isFinite(audited) || audited < 0) {
      problems.push(`${label}: carries no count of the surface-stage audit rows its request wrote, so a handler's own 404 cannot be told from the surface stage's concealment`);
      continue;
    }
    const sufficient = levelAnswers(cell.level, cell.familyClass);
    const shape = surfaceStageShape(o);
    if (sufficient) {
      if (audited !== 0) {
        problems.push(`${label}: level ${cell.level} is sufficient for a ${cell.familyClass} family, but the surface stage refused it and wrote ${audited} '${SURFACE_REFUSAL_ACT}' row(s)`);
      }
      continue;
    }
    if (audited < 1) {
      problems.push(`${label}: level ${cell.level} is insufficient for a ${cell.familyClass} family, but the surface stage wrote NO refusal row - whatever answered (${shape}), it was not the arm`);
      continue;
    }
    if (!isSurfaceStageRefusal(shape)) {
      problems.push(`${label}: the surface stage refused and audited it, but answered ${shape} rather than a ratified refusal shape`);
      continue;
    }
    // The asymmetry is ratified, not incidental (§3.3): concealment on a read
    // family and on a surface the caller cannot read at all; the named 403 only
    // where the caller may read and the level is short of `configure`.
    const expected = (cell.familyClass === 'read' || cell.level === 'none') ? 'concealed' : 'level-insufficient';
    if (shape !== expected) problems.push(`${label}: expected ${expected}, observed ${shape}`);
  }

  if (unknown.length > 0) return { ok: false, reason: unknown.join('; ') };
  const missing = cells.filter((cell) => !counts.has(cell.key));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `D6 is a claim about all ${cells.length} contract cells of caller state x governable surface x declared family; ${missing.length} were never measured, among them ${missing.slice(0, 5).map((cell) => cell.key).join(', ')}`,
    };
  }
  const duplicated = [...counts.entries()].filter(([, n]) => n > 1);
  if (duplicated.length > 0) {
    return { ok: false, reason: `${duplicated.map(([key, n]) => `${key} observed ${n} times`).join('; ')} - a repeated cell hides which observation the verdict is about` };
  }
  if (problems.length > 0) return { ok: false, reason: problems.join('; ') };
  const surfaces = new Set(cells.map((cell) => cell.surfaceKey)).size;
  const states = new Set(cells.map((cell) => cell.callerState)).size;
  return {
    ok: true,
    reason: `all ${cells.length} contract cells (${states} caller states x ${surfaces} governable surfaces x their declared families) observed exactly once, each request equal to its cell and each answer the ratified shape for that cell's level and family class`,
  };
}

/**
 * The decision half of a capture entry - the part `capturesIdentical` and
 * `exactlyOneDecisionMoved` compare. `evidence` is carried for VALIDATION and
 * never compared, because §3.3 ratifies a shape change the decision does not
 * make.
 */
export function decisionOf(entry) {
  const { evidence, ...decision } = entry ?? {};
  return decision;
}

/**
 * Why `entry` is not a capture of an authorization decision, or `null`.
 *
 * A decision record is `{ label, admitted: boolean, evidence: { status, code } }`.
 * Requiring the boolean makes "not a 2xx" unrepresentable as a decision at all
 * (regression `ff9b6437`); requiring the evidence keeps the classification
 * checkable rather than trusted. This is the STRUCTURAL half only — whether the
 * ANSWER was an authorization decision is `isAuthorizationDecision`, because a
 * malformed record is always a failure while an indeterminate ANSWER is
 * something a capture can exclude by name.
 */
export function decisionRecordDefect(entry) {
  if (entry === null || typeof entry !== 'object') return 'is not a decision record at all';
  if (typeof entry.admitted !== 'boolean') return "carries no boolean `admitted`: a raw response is a SHAPE, not a decision";
  if (entry.evidence === null || typeof entry.evidence !== 'object') return 'carries no `evidence`, so its decision cannot be checked against the answer it came from';
  const status = Number(entry.evidence.status);
  if (!Number.isFinite(status)) return 'carries evidence with no status at all';
  // `eed02f4e` F2 again, at the structural rung: a record that calls a 3xx an
  // ADMISSION is malformed, because nothing in the authorization stack answers
  // a redirect. A 3xx recorded as `admitted: false` is well-formed and is then
  // excluded by name in `capturesIdentical`.
  if (status >= 300 && status < 400) {
    return entry.admitted
      ? `is recorded as ADMITTED but its evidence answered ${status}, a redirect the authorization stack never produces`
      : null;
  }
  const admittedByEvidence = status >= 200 && status < 300;
  if (admittedByEvidence !== entry.admitted) {
    return `is recorded as ${entry.admitted ? 'admitted' : 'refused'} but its evidence answered ${status}`;
  }
  return null;
}

/**
 * D1 / D10 / D19 - two decision captures must be BYTE-IDENTICAL.
 *
 * A capture is an array of `{ label, status }`; the comparison is on the
 * serialised whole, so a reordering is a difference too. Empty captures are
 * refused: comparing nothing to nothing is the vacuous pass this board has
 * rejected before.
 */
export function capturesIdentical(baseline, candidate, { minimum = 1, expectedLabels } = {}) {
  const a = baseline ?? [];
  const b = candidate ?? [];
  // ROUND-3 REGRESSION `2a8087c3`. This compared whatever two lists it was
  // handed and had no expected set at all, so a capture that silently dropped
  // one of the two RATIFIED locked surfaces compared one identity-provider
  // decision against one identity-provider decision and answered `ok:true` -
  // "1 decisions byte-identical" - while removing the locked short-circuit for
  // notification endpoints stayed green. Every caller must now declare, FROM
  // THE CONTRACT, which labels the capture is required to hold.
  if (expectedLabels === undefined || expectedLabels === null) {
    return { ok: false, reason: 'no expected label set was supplied: a capture cannot be proved complete against a list it chose for itself' };
  }
  const want = [...expectedLabels].map(String).sort();
  if (want.length === 0) {
    return { ok: false, reason: 'an EMPTY expected label set was supplied: comparing nothing to nothing is the vacuous pass this board has rejected before' };
  }
  // ROUND-4 EXTRA VERDICT `eed02f4e` / `d6629eec` F1. The comparison below used
  // to be a SET test — `absent` and `extra` computed with `includes` — so a
  // capture holding `[A, A, B]` satisfied a contract of `[A, B]`: one probe
  // repeated and one ratified probe MISSING, on both sides, stayed green,
  // because the size check that follows only compares the two captures to each
  // other. The contract names a capture of exactly `want.length` decisions,
  // one per label, so the comparison is an exact MULTISET.
  const duplicatedInContract = want.filter((label, index) => index > 0 && want[index - 1] === label);
  if (duplicatedInContract.length > 0) {
    return { ok: false, reason: `the expected label set names ${[...new Set(duplicatedInContract)].join(', ')} more than once: a contract cell must be identifiable, so a duplicated label cannot be a subject` };
  }
  for (const [side, rows] of [['baseline', a], ['candidate', b]]) {
    const got = rows.map((row) => String(row?.label ?? '')).sort();
    const repeated = [...new Set(got.filter((label, index) => index > 0 && got[index - 1] === label))];
    const absent = want.filter((label) => !got.includes(label));
    const extra = [...new Set(got.filter((label) => !want.includes(label)))];
    if (absent.length > 0 || extra.length > 0 || repeated.length > 0 || got.length !== want.length) {
      return {
        ok: false,
        reason: `the ${side} capture is not the contract's ${want.length} labelled decisions (it holds ${got.length}): ${absent.length} required label(s) absent (${absent.slice(0, 6).join(', ') || 'none'}), ${extra.length} outside it (${extra.slice(0, 6).join(', ') || 'none'}), ${repeated.length} repeated (${repeated.slice(0, 6).join(', ') || 'none'})`,
      };
    }
  }
  if (a.length < minimum) return { ok: false, reason: `baseline holds ${a.length} decisions, fewer than the ${minimum} required - a capture that measures nothing cannot be identical to anything` };
  if (a.length !== b.length) return { ok: false, reason: `captures differ in size: ${a.length} vs ${b.length}` };
  // ROUND-2 REGRESSION `ff9b6437`. This compared bytes without ever asking
  // whether the bytes were an AUTHORIZATION DECISION, so two identical
  // captures of HTTP 500 passed: a server that crashed on every probe answered
  // D1, D10 and D19 at once. The entries must now BE decision records, and
  // each must carry the answer it was derived from so the classification can
  // be checked rather than trusted. The evidence is deliberately NOT compared:
  // §3.3 ratifies the 403 -> 404 shape change on a governed read family, so a
  // shape-sensitive comparison would redden D1 for a ratified reason.
  const malformed = [...a.map((row, i) => ['baseline', i, row]), ...b.map((row, i) => ['candidate', i, row])]
    .map(([side, i, row]) => {
      const defect = decisionRecordDefect(row);
      return defect ? `${side}[${row?.label ?? i}] ${defect}` : null;
    })
    .filter(Boolean);
  if (malformed.length > 0) {
    return { ok: false, reason: `${malformed.length} capture entries are not authorization decisions, so "identical" would compare two non-answers: ${malformed.join('; ')}` };
  }
  const differences = [];
  const excluded = [];
  let compared = 0;
  for (let i = 0; i < a.length; i += 1) {
    const label = a[i]?.label ?? i;
    const aDecided = isAuthorizationDecision(a[i].evidence);
    const bDecided = isAuthorizationDecision(b[i].evidence);
    if (!aDecided || !bDecided) {
      // Indeterminate on ONE side is a MOVEMENT: the probe answered a decision
      // in one state and something else in the other, and that is exactly what
      // these drills exist to catch.
      if (aDecided !== bDecided || JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
        differences.push(`${label}: ${JSON.stringify(a[i].evidence)} -> ${JSON.stringify(b[i].evidence)} - one side answered an authorization decision and the other ${decisionDefect((aDecided ? b[i] : a[i]).evidence)}`);
        continue;
      }
      // Indeterminate IDENTICALLY on both sides. The probe proves nothing
      // either way, so it is dropped BY NAME rather than counted as a matching
      // refusal — and `minimum` below is what stops a capture of nothing but
      // exclusions from passing.
      excluded.push(`${label} (${decisionDefect(a[i].evidence)})`);
      continue;
    }
    compared += 1;
    if (JSON.stringify(decisionOf(a[i])) !== JSON.stringify(decisionOf(b[i]))) {
      differences.push(`${label}: ${JSON.stringify(decisionOf(a[i]))} -> ${JSON.stringify(decisionOf(b[i]))}`);
    }
  }
  if (differences.length > 0) return { ok: false, reason: differences.join('; ') };
  if (compared < minimum) {
    return {
      ok: false,
      reason: `only ${compared} of ${a.length} capture entries answered an authorization decision, fewer than the ${minimum} required - excluded: ${excluded.join('; ')}`,
    };
  }
  return {
    ok: true,
    reason: excluded.length === 0
      ? `${compared} decisions byte-identical`
      : `${compared} decisions byte-identical; ${excluded.length} probe(s) EXCLUDED as non-answers and proved nothing either way: ${excluded.join('; ')}`,
  };
}

/** The positive half of D19 and D1: one named surface's decision DID move, and
 * no other did. Without this, `capturesIdentical` is satisfied by a server that
 * refuses everything. */
export function exactlyOneDecisionMoved(baseline, candidate, movedLabel) {
  const a = baseline ?? [];
  const b = candidate ?? [];
  if (a.length !== b.length || a.length === 0) return { ok: false, reason: 'captures are not comparable' };
  const moved = [];
  for (let i = 0; i < a.length; i += 1) {
    if (JSON.stringify(decisionOf(a[i])) !== JSON.stringify(decisionOf(b[i]))) moved.push(a[i]?.label ?? String(i));
  }
  if (moved.length !== 1) return { ok: false, reason: `expected exactly one decision to move, ${moved.length} did: ${moved.join(', ') || '(none)'}` };
  if (moved[0] !== movedLabel) return { ok: false, reason: `expected '${movedLabel}' to move, '${moved[0]}' did` };
  return { ok: true, reason: `exactly '${movedLabel}' moved` };
}

/**
 * D16 - the arm's invocation record NEVER names a scope-gated family, even with
 * a hostile surface installed by direct SQL that declares one.
 *
 * ROUND-3 REGRESSION `e3f57d06` - THE CLASS, not the named instance the round-3
 * repair closed. That repair rejected only the EMPTY path, then compared
 * case-sensitively with no query removal and no slash normalisation, so all
 * three of
 *
 *     SURFACE ARM INVOCATION /tasks?x=1 hostile.fixture
 *     SURFACE ARM INVOCATION /TASKS hostile.fixture
 *     SURFACE ARM INVOCATION //tasks hostile.fixture
 *
 * were read as clean invocations although each denotes the forbidden `/tasks`
 * family under the route normalizer.
 *
 * Two gates, answering two different questions:
 *
 *   1. THE RECORD SHAPE. Production emits exactly
 *      `SURFACE ARM INVOCATION <normalizePathForScope(path)> <surfaceKey>`
 *      (`backend/src/middleware/sharedAuthorization.ts`). A record with the
 *      wrong arity, a first field that is not a path, or a path that is not
 *      ALREADY in canonical form did not come off that line - and an oracle
 *      that accepts it is judging something other than the arm. A bare
 *      `SURFACE ARM INVOCATION` fails here too, which is the round-2 finding
 *      this gate subsumes.
 *   2. THE COMPARISON. Both sides are canonicalised before the prefix test, so
 *      a record that reached here non-canonically by some other route still
 *      cannot hide a forbidden family behind a spelling.
 */
export function armRecordExcludes(lines, forbiddenPaths, { requireInvocations = true } = {}) {
  const records = [];
  const malformed = [];
  for (const raw of lines ?? []) {
    const line = String(raw);
    const at = line.indexOf(ARM_TRACE_PREFIX);
    if (at < 0) continue;
    const fields = line.slice(at + ARM_TRACE_PREFIX.length).trim().split(/\s+/).filter((field) => field.length > 0);
    if (fields.length !== 2) {
      malformed.push(`'${line.trim()}' carries ${fields.length} field(s), not the path and the surface key the arm prints`);
      continue;
    }
    const [observedPath] = fields;
    if (!observedPath.startsWith('/')) {
      malformed.push(`'${line.trim()}' names '${observedPath}', which is not a path at all`);
      continue;
    }
    if (canonicalPath(observedPath) !== observedPath) {
      malformed.push(`'${line.trim()}' names '${observedPath}', not the canonical '${canonicalPath(observedPath)}' the arm prints - that record did not come from the arm`);
      continue;
    }
    records.push({ path: observedPath, surfaceKey: fields[1] });
  }
  if (malformed.length > 0) {
    return { ok: false, reason: `${malformed.length} arm invocation record(s) are not the shape the arm emits, so this record is not an observation of the arm: ${malformed.join('; ')}` };
  }
  if (requireInvocations && records.length === 0) {
    return { ok: false, reason: 'the arm was never invoked: this drill cannot distinguish an ordering guard from a dead code path' };
  }
  const forbidden = [...new Set((forbiddenPaths ?? []).map(canonicalPath))];
  if (forbidden.length === 0) {
    return { ok: false, reason: 'no forbidden family was named: D16 asserts a scope-gated family never appears, and nothing was named as one' };
  }
  const offending = records.filter((record) => forbidden.some((path) => record.path === path || record.path.startsWith(`${path}/`)));
  return offending.length === 0
    ? { ok: true, reason: `${records.length} arm invocations, each in the canonical form the arm emits, none on a scope-gated family (${forbidden.join(', ')})` }
    : { ok: false, reason: `the arm was invoked on scope-gated ${[...new Set(offending.map((record) => record.path))].join(', ')}` };
}

/**
 * D17 - every bearer request to a core governable surface refuses, AND the
 * owning Account's LOGIN SESSION holding the same authority through its Group
 * gets 2xx on the same URLs.
 *
 * ROUND-3 REGRESSION `1324ba78`. The drill installed the `surface` grant and
 * the direct profile assignment SIMULTANEOUSLY for each bearer, so a defect
 * isolated to either authority store could not be attributed to it; the oracle
 * validated whichever observations it was handed and had no expected matrix, so
 * ONE Connector GET refusal plus ONE matched session GET returned `ok:true`
 * with the sentence "1 bearer requests refused...".
 *
 * `census` is the contract-owned matrix from
 * `setgov-drill-contract.buildD17Census`: bearer x authority store x family
 * class, each cell a SEPARATE run with exactly ONE store armed, and each
 * carrying the METHOD and canonical PATH the probe must have used. The same
 * anti-label gate as D6 applies - a cell is matched by key and then the request
 * must equal it.
 *
 * The other three halves are unchanged and every one of them is still
 * load-bearing:
 *   - the bearer REACH control: the credential must authenticate and reach
 *     SOMETHING, or four 401s read as four refusals (round 1, `f4a8c185`);
 *   - the bearer refusals themselves, as AUTHORIZATION refusals and not merely
 *     "not a 2xx" (round 1, same card: four HTTP 500s passed);
 *   - the same-run SESSION control on the same URLs, without which the refusals
 *     prove only that the authority rows are absent.
 */
export function bearerNeverWidensCore({ bearerObservations, sessionObservations, bearerReach, census }) {
  const bearer = bearerObservations ?? [];
  const session = sessionObservations ?? [];
  const cells = census ?? [];
  if (cells.length === 0) {
    return { ok: false, reason: 'no contract matrix was supplied: D17 is a claim about both bearer kinds through BOTH authority stores over both family classes, and a drill cannot declare its own subject' };
  }
  if (surfaceStageShape(bearerReach ?? {}) !== 'admitted') {
    return { ok: false, reason: `the bearer credential never authenticated (reach control answered ${bearerReach?.status ?? 'nothing'}) - its refusals below are not the arm's` };
  }
  if (bearer.length === 0) return { ok: false, reason: 'no bearer observations' };
  if (session.length === 0) return { ok: false, reason: 'no same-run session control: without it this proves only that the authority rows are absent' };

  const byKey = new Map(cells.map((cell) => [cell.key, cell]));
  const counts = new Map();
  const mismatched = [];
  for (const o of bearer) {
    const key = `${o?.bearer}|${o?.store}|${o?.familyClass}`;
    const cell = byKey.get(key);
    if (!cell) { mismatched.push(`${o?.label ?? key}: (${key}) is not a cell of the contract matrix`); continue; }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const method = String(o?.method ?? '').toUpperCase();
    const path = canonicalPath(o?.route);
    if (method !== cell.method || path !== cell.path) {
      mismatched.push(`${o?.label ?? key}: claims ${key} but requested ${method || '(no method)'} ${path}, while that cell is ${cell.method} ${cell.path}`);
    }
  }
  if (mismatched.length > 0) return { ok: false, reason: mismatched.join('; ') };
  const unmeasured = cells.filter((cell) => !counts.has(cell.key));
  if (unmeasured.length > 0) {
    return {
      ok: false,
      reason: `${unmeasured.length} of ${cells.length} matrix cells were never exercised, so a defect in a store or a family class could not be attributed: ${unmeasured.map((cell) => cell.key).join(', ')}`,
    };
  }
  const duplicated = [...counts.entries()].filter(([, n]) => n > 1);
  if (duplicated.length > 0) {
    return { ok: false, reason: `${duplicated.map(([key, n]) => `${key} exercised ${n} times`).join('; ')} - a repeated cell hides which run the verdict is about` };
  }

  // ROUND-1 REGRESSION `f4a8c185`, both halves.
  //
  // (1) "not admitted" was accepted as a refusal, so four HTTP 500s passed;
  // (2) the session control was only required to be NON-EMPTY, so one 200 on
  //     an unrelated URL satisfied a reason string that claimed "same URLs".
  const notRefusals = bearer.filter((o) => !isAuthorizationRefusal(o));
  if (notRefusals.length > 0) {
    return {
      ok: false,
      reason: `a bearer answer is not an authorization refusal: ${notRefusals.map((o) => `${o.label} ${refusalDefect(o)}`).join('; ')}`,
    };
  }
  const uncontrolled = bearer.filter((o) => !session.some((c) => (
    String(c.method).toUpperCase() === String(o.method).toUpperCase()
    && canonicalPath(c.route) === canonicalPath(o.route)
    && surfaceStageShape(c) === 'admitted'
  )));
  if (uncontrolled.length > 0) {
    return {
      ok: false,
      reason: `no same-run session control ADMITTED on the identical URL for: ${[...new Set(uncontrolled.map((o) => `${o.method} ${canonicalPath(o.route)}`))].join(', ')} - those bearer refusals prove only that the authority rows are absent`,
    };
  }
  const refusedControl = session.filter((o) => surfaceStageShape(o) !== 'admitted');
  if (refusedControl.length > 0) {
    return { ok: false, reason: `the session control did NOT reach: ${refusedControl.map((o) => `${o.label} (${o.status})`).join(', ')} - the bearer refusals above are therefore unattributed` };
  }
  const stores = [...new Set(cells.map((cell) => cell.store))];
  const bearers = [...new Set(cells.map((cell) => cell.bearer))];
  return {
    ok: true,
    reason: `all ${cells.length} matrix cells (${bearers.join(' + ')} x ${stores.join(' + ')} x read/write) exercised once with exactly ONE store armed each, every bearer request an authorization refusal, each with a same-run session control admitted on the identical URL`,
  };
}

/**
 * D17's PLUGIN half - the opposite expectation (annex D17 last sentence, design
 * I6): on a `plugin`-origin surface the arm only NARROWS, so the SAME bearer
 * credential that is refused on a core surface is ADMITTED at `use`/`configure`
 * and refused at `none`.
 *
 * Both halves are required, and they are the control for one another: an
 * implementation that admitted every bearer on a plugin surface would satisfy
 * the first half alone, and one that refused every bearer everywhere - which is
 * what the core half asserts - would satisfy the second alone.
 */
export function pluginBearerNarrowsOnly({ observations, coreContrast, census }) {
  const cells = census ?? [];
  // ROUND-4 REVIEW `5cfe851b` B3. This required only NON-EMPTY admitted and
  // refused arrays, so one request each satisfied "repeat the whole matrix for
  // a plugin surface": a defect isolated to the Agent bearer or to the
  // surface-grant store stayed green in the half that is supposed to prove the
  // arm still NARROWS. The plugin half now consumes the same contract matrix
  // the core half does, with the same anti-label gate.
  if (cells.length === 0) {
    return { ok: false, reason: 'no contract matrix was supplied: the plugin half is a claim about both bearer kinds through BOTH authority stores over both family classes AT EVERY RATIFIED LEVEL, and a drill cannot declare its own subject' };
  }
  // ROUND-4 EXTRA VERDICT `36e8588e` B3. The plugin half exercised two states,
  // `none` and `configure`, and the two arrays it was handed carried their own
  // expectation. `use` — the middle rung, and the ONLY level at which a read
  // family and a write family must answer DIFFERENTLY — was never exercised on
  // the origin where the arm narrows, so a plugin branch that ignored the
  // ordering entirely stayed green. The matrix now carries the LEVEL as a
  // dimension and each cell carries the admission production's own
  // `levelAtLeast` requires, so neither the states nor the expectations are the
  // drill's to choose.
  const byKey = new Map(cells.map((cell) => [cell.key, cell]));
  {
    const counts = new Map();
    const problems = [];
    for (const o of observations ?? []) {
      const key = `${o?.bearer}|${o?.store}|${o?.familyClass}|${o?.level}`;
      const cell = byKey.get(key);
      if (!cell) { problems.push(`${o?.label ?? key}: (${key}) is not a cell of the contract matrix`); continue; }
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const method = String(o?.method ?? '').toUpperCase();
      const path = canonicalPath(o?.route);
      if (method !== cell.method || path !== cell.path) {
        problems.push(`${o?.label ?? key}: claims ${key} but requested ${method || '(no method)'} ${path}, while that cell is ${cell.method} ${cell.path}`);
        continue;
      }
      const shape = surfaceStageShape(o);
      if (cell.expectAdmitted && shape !== 'admitted') {
        problems.push(`${o?.label ?? key}: a bearer at \`${cell.level}\` was NOT admitted on a plugin \`${cell.familyClass}\` family (${o?.status} ${o?.code ?? ''}) - on a plugin surface the arm only narrows (I6)`);
      }
      if (!cell.expectAdmitted && !isSurfaceStageRefusal(shape)) {
        problems.push(`${o?.label ?? key}: a bearer at \`${cell.level}\` was not refused BY THE SURFACE STAGE on a \`${cell.familyClass}\` family (${o?.status}, ${shape})`);
      }
    }
    if (problems.length > 0) return { ok: false, reason: problems.join('; ') };
    const unmeasured = cells.filter((cell) => !counts.has(cell.key));
    if (unmeasured.length > 0) {
      return {
        ok: false,
        reason: `the plugin half left ${unmeasured.length} of ${cells.length} matrix cells unexercised, so a defect isolated to a bearer kind, an authority store or an ACCESS LEVEL stays green: ${unmeasured.map((cell) => cell.key).join(', ')}`,
      };
    }
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1);
    if (duplicated.length > 0) {
      return { ok: false, reason: `the plugin half exercised ${duplicated.map(([key, n]) => `${key} ${n} times`).join('; ')} - a repeated cell hides which run the verdict is about` };
    }
    const admittedCells = cells.filter((cell) => cell.expectAdmitted);
    const refusedCells = cells.filter((cell) => !cell.expectAdmitted);
    if (admittedCells.length === 0 || refusedCells.length === 0) {
      return { ok: false, reason: `the matrix expects ${admittedCells.length} admissions and ${refusedCells.length} refusals: a plugin half in which the arm never has to narrow, or never has to admit, is satisfied by an arm that does one thing everywhere` };
    }
  }
  // THE CONTRAST CONTROL. Without it, "admitted on a plugin surface" is
  // satisfied by a substrate that admits that bearer everywhere - which is
  // precisely the defect D17's core half exists to catch. The identical
  // credential on the identical URL, with the surface's origin flipped back to
  // `core`, must refuse.
  if (!coreContrast) {
    return { ok: false, reason: 'no core contrast: without the same credential refused on the same URL as a `core` surface, the plugin admission proves only that the caller is admitted everywhere' };
  }
  if (!isAuthorizationRefusal(coreContrast)) {
    return { ok: false, reason: `the core contrast did not refuse (${coreContrast.status} ${coreContrast.code ?? ''}): ${refusalDefect(coreContrast)}` };
  }
  const bearers = [...new Set(cells.map((cell) => cell.bearer))];
  const stores = [...new Set(cells.map((cell) => cell.store))];
  const levels = [...new Set(cells.map((cell) => cell.level))];
  return {
    ok: true,
    reason: `all ${cells.length} plugin matrix cells (${bearers.join(' + ')} x ${stores.join(' + ')} x read/write x ${levels.join('/')}) answered as the ratified ORDERING requires — admitted exactly where the level reaches the family's floor and refused by the surface stage everywhere else — while the identical credential on the identical URL is refused when the surface is \`core\` (${coreContrast.status})`,
  };
}

/**
 * ── D21, AS RESCOPED ────────────────────────────────────────────────────────
 *
 * Owner ruling `70af4d82` §1.1 (2026-09-02) on escalation `94c77997`. The
 * previous oracle here, `ruleFourStillRefuses`, asserted that a surface-stage
 * admission met the HANDLER's rule-4 refusal. It was UNSATISFIABLE: measured
 * over HTTP on a real PostgreSQL, `routes/grants.ts`, `routes/groups.ts` and
 * `routes/accessProfiles.ts` carry no descendant-subtree check of any kind -
 * rule 4 has been satisfied vacuously for those families since they were
 * written, because their whole gate is the `root` route ceiling this design's
 * arm substitutes for. The arm itself is design card `3e76cfcc` (AZ-A7).
 *
 * Until it lands, the annex asserts three separable things, one oracle each,
 * so a mutation reddens exactly one of them (§8.1):
 *
 *   (i)   the seeded catalogue keeps #15/#17/#18 `governable` and in NO bundle;
 *   (ii)  a matrix write that would confer one is refused, and audited;
 *   (iii) the ARM never admits them, whatever rows exist.
 *
 * THE EXPECTATIONS BELOW ARE TRANSCRIBED FROM THE RULING, not read back from
 * the migration these oracles measure. An oracle that derived Administrative's
 * membership from the seed would agree with any seed.
 */

/** The audited denial a write surface writes when it refuses one of the three. */
export const AUTHORITY_MUTATION_REFUSAL_ACT = 'access_bundle.refused';
/** The refused code, and the arm's audit reason for the same closure. */
export const AUTHORITY_MUTATION_CODE = 'AUTHORITY_MUTATION_SURFACE';
/** The card that lifts the closure. Every refusal sentence must name it. */
export const RULE_FOUR_ARM_CARD = '3e76cfcc';
/** Ruling §1.1: the three surfaces that mutate authority itself. */
export const AUTHORITY_MUTATION_SURFACE_KEYS = [
  'settings.access-grants', 'settings.identities', 'settings.access-profiles-groups',
];
/** Ruling §1.1: Administrative's four remaining members (#14, #21, #22, #23). */
export const ADMINISTRATIVE_MEMBER_KEYS = [
  'settings.appearance', 'settings.connector-owner-plane',
  'settings.model-catalogue', 'settings.webhooks',
];

/**
 * D21 (i) - registered `governable`, member of NOTHING, and Administrative is
 * exactly the four.
 *
 * "Registered governable" is asserted POSITIVELY on purpose: deleting the three
 * rows outright would also empty every bundle of them, and that is a different
 * catalogue from the one the ruling describes.
 */
export function authorityMutationSurfacesUnbundled({ surfaceRows, memberRows, administrativeMemberKeys }) {
  const rows = surfaceRows ?? [];
  if (rows.length === 0) {
    return { ok: false, reason: 'no catalogue rows were read: this oracle must not pass on an empty catalogue' };
  }
  const governanceByKey = new Map(rows.map((row) => [String(row.key), String(row.governance)]));
  const absent = AUTHORITY_MUTATION_SURFACE_KEYS.filter((key) => !governanceByKey.has(key));
  if (absent.length > 0) {
    return { ok: false, reason: `not REGISTERED at all: ${absent.join(', ')} - the ruling keeps them governable, it does not delete them` };
  }
  const misclassed = AUTHORITY_MUTATION_SURFACE_KEYS.filter((key) => governanceByKey.get(key) !== 'governable');
  if (misclassed.length > 0) {
    return { ok: false, reason: `registered, but not as \`governable\`: ${misclassed.map((key) => `${key}=${governanceByKey.get(key)}`).join(', ')}` };
  }
  const bundled = (memberRows ?? [])
    .filter((row) => AUTHORITY_MUTATION_SURFACE_KEYS.includes(String(row.surfaceKey)));
  if (bundled.length > 0) {
    return { ok: false, reason: `an authority-mutation surface IS an Access-bundle member: ${bundled.map((row) => `${row.surfaceKey} in ${row.bundleKey}`).join(', ')}` };
  }
  const observed = [...(administrativeMemberKeys ?? [])].map(String).sort();
  const expected = [...ADMINISTRATIVE_MEMBER_KEYS].sort();
  if (observed.join('|') !== expected.join('|')) {
    return { ok: false, reason: `Administrative's members are [${observed.join(', ')}]; ruling 70af4d82 §1.1 names [${expected.join(', ')}]` };
  }
  return {
    ok: true,
    reason: `#15/#17/#18 registered governable and in no bundle; Administrative = ${expected.length} members, exactly as ruled`,
  };
}

/**
 * D21 (ii) - the matrix write refusal, audited, naming the surface AND the arm.
 *
 * ROUND-3 REGRESSION `2eb2061c`. The previous form validated only non-empty
 * arrays, response shape/code/message, SOME successful 2xx control, and audit
 * membership BY SURFACE KEY. It never required that #15, #17 and #18 were all
 * attempted, never required both write stores, and never correlated the control
 * to the same operation: ONE refusal covering only #15 plus an unrelated
 * `GET /health` 200 returned `ok:true`, and so did two refusals with one audit
 * row.
 *
 * `expectedAttempts` is the contract-owned multiset from
 * `setgov-drill-contract.buildD21WriteCensus` - every withheld surface through
 * every write store - built from the ruling's transcription below and never
 * from the seed these controls measure.
 *
 * FOUR halves, each load-bearing:
 *   - the complete attempt multiset, exactly, with nothing outside it;
 *   - the refusals themselves, by THIS closure's code and not by some other
 *     validator that happens to reject the same body;
 *   - a same-run POSITIVE CONTROL THROUGH THE SAME WRITE STORE: the identical
 *     operation naming a surface the bundle DOES carry must SUCCEED, or a write
 *     surface that refuses everything would pass this oracle - and an unrelated
 *     2xx attributes nothing;
 *   - the audit rows, correlated as a MULTISET so two refusals of one surface
 *     need two rows, each carrying the missing arm.
 */
/**
 * The canonical signature of one MATRIX WRITE, with the surface it names
 * elided.
 *
 * ROUND-4 REVIEW `43520bf5` B1. The previous form correlated a refusal to its
 * positive control by comparing a `store` STRING that the drill supplied — so
 * two unrelated `GET /health` 200s, relabelled, satisfied "a same-run control
 * admitted through the SAME store". That is the self-declared label this whole
 * round exists to remove, surviving in the one place a label still decided a
 * verdict.
 *
 * The signature is computed from WHAT WAS SENT — method, canonical path,
 * canonical body — with the surface id the write NAMES replaced by a
 * placeholder, because that id is the ONLY thing a refusal and its control are
 * allowed to differ in. `store` is now a reporting field and nothing more.
 */
export function writeOperationSignature(row) {
  const surfaceId = String(row?.surfaceId ?? '');
  const elide = (text) => (surfaceId.length > 0 ? String(text).split(surfaceId).join(':surfaceId') : String(text));
  return `${String(row?.method ?? '').toUpperCase()} ${elide(canonicalPath(row?.route))} ${elide(stableJson(row?.body))}`;
}

/** Why a matrix-write observation cannot be correlated, or `null`. */
export function writeOperationDefect(row) {
  if (!String(row?.method ?? '').trim()) return 'names no method';
  if (!String(row?.route ?? '').trim()) return 'names no route';
  if (row?.body === undefined) return 'carries no request body, so two writes of different rules would sign the same';
  const surfaceId = String(row?.surfaceId ?? '');
  if (!surfaceId) return 'names no surface id, so the one permitted difference cannot be elided';
  const sent = `${canonicalPath(row.route)} ${stableJson(row.body)}`;
  if (!sent.includes(surfaceId)) {
    return `declares surface id '${surfaceId}', which appears nowhere in the request it sent — the elision would be vacuous`;
  }
  return null;
}

export function authorityMutationWritesRefused({ refusals, controls, auditRows, expectedAttempts }) {
  const observed = refusals ?? [];
  const required = expectedAttempts ?? [];
  const attemptKey = (row) => `${String(row?.store ?? '')}|${String(row?.surfaceKey ?? '')}`;
  if (required.length === 0) {
    return { ok: false, reason: 'no required attempt multiset was supplied: D21(ii) is a claim about EVERY withheld surface through EVERY write store, and a drill cannot declare its own subject' };
  }
  if (observed.length === 0) return { ok: false, reason: 'no write attempts were observed' };

  const wantKeys = required.map((want) => want.key ?? attemptKey(want));
  const seen = new Map();
  for (const row of observed) seen.set(attemptKey(row), (seen.get(attemptKey(row)) ?? 0) + 1);
  const never = wantKeys.filter((key) => !seen.has(key));
  if (never.length > 0) {
    return { ok: false, reason: `${never.length} of ${wantKeys.length} required attempts were never made, so the refusals below cover a subset of the closure: ${never.join(', ')}` };
  }
  const outside = [...seen.keys()].filter((key) => !wantKeys.includes(key));
  if (outside.length > 0) {
    return { ok: false, reason: `${outside.length} attempt(s) fall outside the contract census and cannot be counted toward it: ${outside.join(', ')}` };
  }

  const admitted = observed.filter((row) => surfaceStageShape(row) === 'admitted');
  if (admitted.length > 0) {
    return { ok: false, reason: `a write naming an authority-mutation surface SUCCEEDED: ${admitted.map((row) => `${row.label} ${row.status}`).join(', ')}` };
  }
  const wrongCode = observed.filter((row) => row.code !== AUTHORITY_MUTATION_CODE);
  if (wrongCode.length > 0) {
    return { ok: false, reason: `refused, but NOT by this closure: ${wrongCode.map((row) => `${row.label} ${row.status} ${row.code ?? '(no code)'}`).join(', ')}` };
  }
  const unnamed = observed.filter((row) => {
    const message = String(row.message ?? '');
    return !message.includes(String(row.surfaceKey)) || !message.includes(RULE_FOUR_ARM_CARD);
  });
  if (unnamed.length > 0) {
    return { ok: false, reason: `the refusal must NAME the surface and the missing arm (${RULE_FOUR_ARM_CARD}); these do not: ${unnamed.map((row) => row.label).join(', ')}` };
  }

  const positive = controls ?? [];
  if (positive.length === 0) {
    return { ok: false, reason: 'no same-run positive control: a write surface that refuses everything would pass' };
  }
  // ROUND-4 REVIEW `43520bf5` B1. Correlation is now on WHAT WAS SENT, not on
  // a `store` label the drill supplied: an unrelated 2xx cannot become a
  // control by being relabelled.
  const uncorrelatable = [...observed, ...positive]
    .map((row) => { const defect = writeOperationDefect(row); return defect ? `${row?.label ?? '(unlabelled)'} ${defect}` : null; })
    .filter(Boolean);
  if (uncorrelatable.length > 0) {
    return { ok: false, reason: `${uncorrelatable.length} matrix-write observation(s) cannot be correlated to an operation: ${uncorrelatable.join('; ')}` };
  }
  const refusedControl = positive.filter((row) => surfaceStageShape(row) !== 'admitted');
  if (refusedControl.length > 0) {
    return { ok: false, reason: `the positive control did NOT succeed: ${refusedControl.map((row) => `${row.label} ${row.status}`).join(', ')} - the refusals above are unattributed` };
  }
  const controlSignatures = new Set(positive.map(writeOperationSignature));
  const uncontrolled = observed.filter((row) => !controlSignatures.has(writeOperationSignature(row)));
  if (uncontrolled.length > 0) {
    return {
      ok: false,
      reason: `no same-run control ran the IDENTICAL operation (method, canonical path and body, differing only in the surface named) for: ${uncontrolled.map((row) => `${row.label} [${writeOperationSignature(row)}]`).join('; ')} - a 2xx from a different operation attributes nothing`,
    };
  }

  // ROUND-3 REGRESSION `2eb2061c`, the audit half: this was a MEMBERSHIP test
  // over surface keys, so one row covered two refusals of the same surface.
  const audited = (auditRows ?? []).filter((row) => row.action === AUTHORITY_MUTATION_REFUSAL_ACT);
  const rowCounts = new Map();
  for (const row of audited) {
    const key = String((row.metadata ?? {}).surfaceKey ?? '(no surfaceKey)');
    rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
  }
  const wantCounts = new Map();
  for (const row of observed) wantCounts.set(String(row.surfaceKey), (wantCounts.get(String(row.surfaceKey)) ?? 0) + 1);
  const short = [];
  for (const [key, n] of wantCounts) {
    const m = rowCounts.get(key) ?? 0;
    if (m < n) short.push(`${key}: refused ${n}, audited ${m}`);
  }
  if (short.length > 0) {
    return { ok: false, reason: `${short.length} of ${wantCounts.size} refused surfaces are under-audited as '${AUTHORITY_MUTATION_REFUSAL_ACT}': ${short.join('; ')}` };
  }
  const armless = audited.filter((row) => (row.metadata ?? {}).arm !== RULE_FOUR_ARM_CARD);
  if (armless.length > 0) {
    return { ok: false, reason: `${armless.length} audit rows name no missing arm - an operator cannot act on them` };
  }
  return {
    ok: true,
    reason: `all ${wantKeys.length} contract attempts (${[...new Set(required.map((want) => want.surfaceKey))].length} withheld surfaces x ${[...new Set(required.map((want) => want.store))].length} write stores) refused and audited one-for-one naming ${RULE_FOUR_ARM_CARD}, each correlated to a same-run control that ran the IDENTICAL operation (${controlSignatures.size} distinct operation signatures)`,
  };
}

/**
 * D21 (iii) - the arm never admits them, and the caller gets the ratified ROOT
 * refusal it got before SETGOV (ruling §1.1: "their behaviour today is
 * unchanged: root-only").
 *
 * `route-refusal` is required, not merely "not admitted": this design's own
 * 404 concealment or its 403 naming the surface would BOTH be behaviour
 * changes on an authority-mutation family, and both would satisfy a weaker
 * oracle.
 *
 * FOUR controls, and every one of them is load-bearing:
 *   - the SETUP control: the caller must be admitted somewhere the REDUCED
 *     Administrative bundle still confers, or five refusals prove only that
 *     the fixture holds nothing;
 *   - no row written;
 *   - the same-run ROOT control, which must both succeed AND move rows, or
 *     "no row written" is not a property of the refusal;
 *   - the audited denial, which names why the arm declined.
 */
/**
 * The canonical signature of ONE escalation act: what was done, to what, with
 * what body.
 *
 * ROUND-3 REGRESSION `18d170f4` - A DEFECT IN THE ROUND-3 REPAIR ITSELF. That
 * repair correlated method plus a route with EVERY uuid segment replaced by
 * `:id`, because the escalation replay and its ROOT control each created their
 * own rows and their routes therefore differed by design. Collapsing every uuid
 * also aliased a STABLE fixture Group target with a freshly generated profile
 * id: member `/groups/1111.../members` and root `/groups/2222.../members` both
 * normalised to `/groups/:id/members`, and the oracle claimed "the ROOT control
 * ran the same acts" about two acts on two different Groups.
 *
 * THE REPAIR IS NOT A CLEVERER NORMALISER - IT IS NO NORMALISER. `normaliseActRoute`
 * is withdrawn. The drill's two runs are now byte-identical BY CONSTRUCTION:
 * every act targets a stable fixture id, and the two names the escalation
 * invents are minted ONCE, outside both runs, so the replay and the root
 * control issue the same method, the same route and the same body. The
 * correlation is therefore exact, over a signature that includes the body -
 * because §4.3's acts are distinguished by their targets, and two `POST /grants`
 * differing only in `resourceId` are different acts. A mechanism that does not
 * exist cannot alias.
 *
 * `canonicalPath` is still applied to the route, for the same reason D16 applies
 * it: it is the form production writes into the audit ledger, so a signature in
 * any other spelling would not correlate with the rows this drill must find.
 */
export function actSignature(act) {
  return `${String(act?.method ?? '').toUpperCase()} ${canonicalPath(act?.route)} ${stableJson(act?.body)}`;
}

/** A one-line description of how two act lists differ as MULTISETS of canonical
 * act signature, or `null` when they are the same acts. */
export function actMultisetDifference(expected, actual) {
  const tally = (rows) => {
    const counts = new Map();
    for (const row of rows ?? []) {
      const key = actSignature(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const want = tally(expected);
  const got = tally(actual);
  const problems = [];
  for (const [key, n] of want) {
    const m = got.get(key) ?? 0;
    if (m < n) problems.push(`${key} run ${n} time(s) by the escalation and ${m} by the control`);
  }
  for (const [key, m] of got) {
    const n = want.get(key) ?? 0;
    if (m > n) problems.push(`${key} run ${m} time(s) by the control and ${n} by the escalation`);
  }
  return problems.length === 0 ? null : problems.join('; ');
}

/**
 * D6's census and D21's withheld set must PARTITION the governable catalogue.
 *
 * ROUND-4 EXTRA VERDICT `36e8588e` B2. The live drill asserted this with a
 * `Set` of SURFACE KEYS: every governable family passed if its SURFACE appeared
 * somewhere in D6's census. Dropping all three state cells of ONE family of a
 * surface that has other families left the surface in the set and the family
 * measured by nothing at all — the exact gap the assertion exists to close.
 *
 * The comparison is now over `(surfaceKey, familyKey)` PAIRS, in both
 * directions, and the two sides must be DISJOINT: a family in both is measured
 * under two contradictory expectations (D6 asserts the arm's own refusal shape,
 * D21(iii) asserts the ratified root refusal), which is a contract defect, not
 * a redundancy.
 */
export function governableCatalogueIsPartitioned({ governableFamilies, d6Cells, withheldFamilies }) {
  const pair = (row) => `${row?.surfaceKey}|${row?.familyKey}`;
  const all = new Set((governableFamilies ?? []).map(pair));
  if (all.size === 0) {
    return { ok: false, reason: 'the catalogue declares no governable family at all: there is nothing to partition and every drill below has no subject' };
  }
  const inD6 = new Set((d6Cells ?? []).map(pair));
  const inD21 = new Set((withheldFamilies ?? []).map(pair));
  const unmeasured = [...all].filter((key) => !inD6.has(key) && !inD21.has(key));
  const both = [...all].filter((key) => inD6.has(key) && inD21.has(key));
  const foreign = [...new Set([...inD6, ...inD21])].filter((key) => !all.has(key));
  const problems = [];
  if (unmeasured.length > 0) {
    problems.push(`${unmeasured.length} governable family/families are in NEITHER D6's census nor the withheld set, so they are measured by no drill at all: ${unmeasured.slice(0, 8).join(', ')}`);
  }
  if (both.length > 0) {
    problems.push(`${both.length} family/families are in BOTH, so two drills assert contradictory refusal shapes for them: ${both.slice(0, 8).join(', ')}`);
  }
  if (foreign.length > 0) {
    problems.push(`${foreign.length} measured family/families are not governable families of the catalogue at all: ${foreign.slice(0, 8).join(', ')}`);
  }
  return problems.length === 0
    ? { ok: true, reason: `all ${all.size} governable (surface, family) pairs are measured exactly once — ${inD6.size} by D6's census and ${inD21.size} by D21(iii)'s withheld sweep, with no pair in both and none outside the catalogue` }
    : { ok: false, reason: problems.join('; ') };
}

/**
 * The FIVE ACTS of escalation `94c77997`, TRANSCRIBED from annex `85a2218d`
 * D21 as rescoped by owner ruling `70af4d82` §1.1 — by the family key each one
 * exercises, never by the URL the drill happens to send.
 *
 * ROUND-4 EXTRA VERDICT `36e8588e` B5. `authorityMutationArmNeverAdmits` proved
 * the escalation replay and the ROOT control ran the SAME acts, and never that
 * they were THESE acts: a one-act escalation with a matching one-act root list
 * answered `ok:true`. The transcription is the ratified side of that equality,
 * and it is checked against the CATALOGUE before it is used — every key below
 * must be a declared WRITE family of an authority-mutation surface — so the
 * transcription cannot name a fiction and the drill cannot shrink the set.
 */
export const RATIFIED_ESCALATION_ACTS = [
  { familyKey: 'POST /grants', surfaceKey: 'settings.access-grants', act: 'a task/admin grant to a Group' },
  { familyKey: 'POST /groups', surfaceKey: 'settings.access-profiles-groups', act: 'creating a Group' },
  { familyKey: 'POST /groups/:id/members', surfaceKey: 'settings.access-profiles-groups', act: 'adding a foreign Account to a Group' },
  { familyKey: 'POST /access-profiles', surfaceKey: 'settings.access-profiles-groups', act: 'creating an Access profile' },
  { familyKey: 'POST /access-profiles/:id/versions', surfaceKey: 'settings.access-profiles-groups', act: 'a task/all-of-type/read+write+admin profile version' },
];

export function authorityMutationArmNeverAdmits({
  observations, rowsBefore, rowsAfter, sufficientControl, rootControl, auditRows, expectedRefusals,
  ratifiedActs, familyMatches,
}) {
  const acts = observations ?? [];
  if (acts.length === 0) return { ok: false, reason: 'no escalation acts were replayed' };
  if (!Array.isArray(ratifiedActs) || ratifiedActs.length === 0) {
    return { ok: false, reason: 'no ratified act set was supplied: an escalation replay judged only against itself proves nothing about WHICH acts were replayed' };
  }
  if (typeof familyMatches !== 'function') {
    return { ok: false, reason: "no production family matcher was supplied: a drill matching its own URLs against its own transcription with its own comparison is the shape this control exists to remove" };
  }
  if (surfaceStageShape(sufficientControl ?? {}) !== 'admitted') {
    return {
      ok: false,
      reason: `the SETUP control answered ${sufficientControl?.status ?? 'nothing'}: the caller does not hold Administrative \`configure\` over a surface the reduced bundle DOES confer, so its refusals below say nothing about the arm`,
    };
  }
  const admitted = acts.filter((row) => surfaceStageShape(row) === 'admitted');
  if (admitted.length > 0) {
    return { ok: false, reason: `the escalation reproduced: ${admitted.map((row) => `${row.label} ${row.status}`).join(', ')}` };
  }
  const notRoot = acts.filter((row) => surfaceStageShape(row) !== 'route-refusal');
  if (notRoot.length > 0) {
    return {
      ok: false,
      reason: `refused, but NOT with the ratified root refusal these families gave before SETGOV: ${notRoot.map((row) => `${row.label} ${row.status} ${row.code ?? ''} (${surfaceStageShape(row)})`).join(', ')}`,
    };
  }
  if (Number(rowsAfter) !== Number(rowsBefore)) {
    return { ok: false, reason: `a refusal still wrote a row: ${rowsBefore} -> ${rowsAfter}` };
  }
  const rootActs = rootControl?.acts ?? [];
  if (rootActs.length === 0) {
    return { ok: false, reason: 'no same-run ROOT control: the refusals above are not attributable to the closure' };
  }
  const rootRefused = rootActs.filter((row) => surfaceStageShape(row) !== 'admitted');
  if (rootRefused.length > 0) {
    return { ok: false, reason: `the ROOT control did not succeed on ${rootRefused.map((row) => `${row.label} ${row.status}`).join(', ')} - the fixtures, not the closure, may be what refused` };
  }
  // ROUND-2 REGRESSION `989fc650`. The verdict's own sentence claimed "the
  // ROOT control ran the same acts", and nothing here ever checked it: ONE
  // unrelated admitted `GET /health` plus any row movement satisfied the whole
  // control, so the five refusals above were attributable to nothing. The two
  // act lists must now correlate ONE-TO-ONE on method and route, counted as
  // multisets so a duplicate cannot stand in for a missing act. Routes are
  // compared with their generated identifiers normalised, because the root run
  // creates its own rows and the ids necessarily differ.
  // A correlation over acts that carry no method or route would tally the same
  // empty key on both sides and pass vacuously — the shape this repair exists
  // to remove. Both lists must name what they ran.
  const unnamed = [...acts.map((row) => ['escalation', row]), ...rootActs.map((row) => ['root', row])]
    .filter(([, row]) => !String(row?.method ?? '').trim() || !String(row?.route ?? '').trim())
    .map(([side, row]) => `${side} act '${row?.label ?? '(unlabelled)'}'`);
  if (unnamed.length > 0) {
    return { ok: false, reason: `${unnamed.length} acts name no method or route, so the escalation and the ROOT control cannot be correlated at all: ${unnamed.join(', ')}` };
  }
  // ROUND-4 EXTRA VERDICT `36e8588e` B5. Everything below proves the escalation
  // replay and the ROOT control ran the SAME acts. NOTHING proved they were the
  // annex's acts, so a one-act escalation with a matching one-act root list was
  // a green verdict about a fifth of the escalation. The replay must now
  // correlate ONE-TO-ONE with the ratified transcription, matched by
  // PRODUCTION'S OWN family matcher — the drill's concrete URLs carry generated
  // ids, and `familyMatchesRequest` is what turns `POST /groups/<uuid>/members`
  // into the family it belongs to.
  {
    const unclaimed = [];
    const claimedBy = new Map();
    for (const act of acts) {
      const method = String(act?.method ?? '').toUpperCase();
      const path = canonicalPath(act?.route);
      const hits = ratifiedActs.filter((want) => familyMatches(want.familyKey, method, path));
      if (hits.length === 0) { unclaimed.push(`${act?.label ?? `${method} ${path}`} is not any of the ${ratifiedActs.length} ratified acts`); continue; }
      if (hits.length > 1) { unclaimed.push(`${act?.label ?? `${method} ${path}`} matches ${hits.length} ratified acts (${hits.map((h) => h.familyKey).join(', ')}), so the correlation is not one-to-one`); continue; }
      claimedBy.set(hits[0].familyKey, [...(claimedBy.get(hits[0].familyKey) ?? []), act?.label ?? `${method} ${path}`]);
    }
    const missing = ratifiedActs.filter((want) => !claimedBy.has(want.familyKey));
    const repeated = [...claimedBy.entries()].filter(([, labels]) => labels.length > 1);
    if (unclaimed.length > 0 || missing.length > 0 || repeated.length > 0) {
      return {
        ok: false,
        reason: `the replay is not the ratified escalation: ${missing.length} ratified act(s) never run (${missing.map((w) => `${w.familyKey} — ${w.act}`).join('; ') || 'none'}); ${unclaimed.length} act(s) outside it (${unclaimed.join('; ') || 'none'}); ${repeated.length} act(s) run more than once (${repeated.map(([key, labels]) => `${key} x${labels.length}`).join(', ') || 'none'})`,
      };
    }
  }
  const rootMismatch = actMultisetDifference(acts, rootActs);
  if (rootMismatch) {
    return { ok: false, reason: `the ROOT control did not run the same acts as the escalation, so its success attributes nothing: ${rootMismatch}` };
  }
  if (!(Number(rootControl.rowsAfter) > Number(rootControl.rowsBefore))) {
    return { ok: false, reason: `the ROOT control wrote NO row (${rootControl.rowsBefore} -> ${rootControl.rowsAfter}), so "no row written" above is not a property of the refusal` };
  }
  // ROUND-1 REGRESSION `e776b244`: this required at least ONE audit row for
  // all five acts, so four of five could write nothing and the oracle still
  // passed. The drill now names the method and path of every act, and each
  // must have its own row.
  const audited = (auditRows ?? []).filter((row) => (row.metadata ?? {}).refusal === AUTHORITY_MUTATION_CODE);
  if (audited.length === 0) {
    return { ok: false, reason: `no refusal was audited with reason '${AUTHORITY_MUTATION_CODE}': the arm declined silently` };
  }
  if (!Array.isArray(expectedRefusals) || expectedRefusals.length !== acts.length) {
    return { ok: false, reason: `the drill named ${expectedRefusals?.length ?? 0} expected audit targets for ${acts.length} acts: without one per act, a single row would satisfy all of them` };
  }
  // ROUND-4 REVIEW `5cfe851b` B1, the same defect at this rung: five acts were
  // accepted against 84 in-run rows, because a MEMBERSHIP test over all the
  // rows this run wrote is satisfied by a sibling request. Each act must be
  // audited by ITS OWN request's rows, which the drill records, and a row may
  // satisfy at most one act.
  const consumedRows = new Set();
  const unaudited = expectedRefusals.filter((want) => {
    if (!Array.isArray(want?.rowIds)) return true;
    const own = audited.filter((row) => want.rowIds.map(String).includes(String(row.id))
      && !consumedRows.has(String(row.id))
      && String((row.metadata ?? {}).method ?? '').toUpperCase() === String(want.method).toUpperCase()
      && String((row.metadata ?? {}).path ?? '') === String(want.path));
    if (own.length === 0) return true;
    consumedRows.add(String(own[0].id));
    return false;
  });
  if (unaudited.length > 0) {
    return {
      ok: false,
      reason: `${unaudited.length} of ${expectedRefusals.length} refusals were not audited BY THEIR OWN REQUEST: ${unaudited.map((want) => `${want.method} ${want.path}${Array.isArray(want?.rowIds) ? '' : ' (the drill recorded no rows for its own request)'}`).join(', ')}`,
    };
  }
  return {
    ok: true,
    reason: `${acts.length} escalation acts met the root refusal, each with its OWN audit row (${audited.length} rows), no row written; the ROOT control ran the same acts and moved ${rootControl.rowsAfter - rootControl.rowsBefore} rows`,
  };
}

/**
 * D21 negative control - the ESCALATION'S OWN capture, re-run.
 *
 * `qa/setgov-d21-capture.mjs` is the instrument that produced the five 201s in
 * escalation `94c77997` §2, committed as a fixture by ruling `70af4d82` §2. It
 * is the answer to "did the drill above pass because you rewrote the probe?".
 * This oracle judges its JSON, and refuses a capture that reported nothing.
 */
export function escalationCaptureRefused(evidence) {
  const e = evidence ?? {};
  const acts = [
    ['grants', e.grants], ['groups', e.groups], ['groupMembers', e.groupMembers],
    ['accessProfiles', e.accessProfiles], ['accessProfileVersion', e.accessProfileVersion],
  ];
  const missing = acts.filter(([, value]) => !value || value.status === undefined);
  if (missing.length > 0) {
    return { ok: false, reason: `the capture reported no status for ${missing.map(([name]) => name).join(', ')} - it may not have run those acts at all` };
  }
  const succeeded = acts.filter(([, value]) => Number(value.status) >= 200 && Number(value.status) < 300);
  if (succeeded.length > 0) {
    return { ok: false, reason: `the escalation reproduced VERBATIM: ${succeeded.map(([name, value]) => `${name} ${value.status}`).join(', ')}` };
  }
  if (Number(e.grants.rowsAfter) !== Number(e.grants.rowsBefore)) {
    return { ok: false, reason: `the capture's refusal still wrote a grants row: ${e.grants.rowsBefore} -> ${e.grants.rowsAfter}` };
  }
  const role = e.caller?.role ?? null;
  if (role === null) {
    return { ok: false, reason: 'the capture could not read its own role, so it cannot show the caller was non-root' };
  }
  if (role === 'root' || (e.caller?.scopes ?? []).includes('root')) {
    return { ok: false, reason: `the capture ran as ${role} holding ${JSON.stringify(e.caller?.scopes ?? [])} - a root caller is exempt and proves nothing` };
  }
  return {
    ok: true,
    reason: `all five captured acts refused (${acts.map(([name, value]) => `${name} ${value.status}`).join(', ')}), no row written, caller role '${role}'`,
  };
}

/**
 * D2 / D15 - a boot that must FAIL, and fail for the stated reason.
 *
 * A non-zero exit alone is not evidence: a typo in the fixture also exits
 * non-zero. The census's own sentence must appear.
 */
export function bootRefused({ exitCode, output, expectedFragment }) {
  if (Number(exitCode) === 0) return { ok: false, reason: 'the boot SUCCEEDED on a catalogue the census must refuse' };
  const text = String(output ?? '');
  if (!expectedFragment) return { ok: false, reason: 'no expected census sentence was named: a non-zero exit proves only that something failed' };
  if (!text.includes(expectedFragment)) {
    return { ok: false, reason: `the boot failed, but not for the census reason - '${expectedFragment}' is absent from its output` };
  }
  return { ok: true, reason: `the boot refused, naming: ${expectedFragment}` };
}

/** The mirror of `bootRefused`: the sound catalogue must boot, and say so. */
export function bootAccepted({ exitCode, output, expectedFragment = 'Access-surface census passed' }) {
  if (Number(exitCode) !== 0) return { ok: false, reason: `the boot FAILED on a sound catalogue (exit ${exitCode})` };
  return String(output ?? '').includes(expectedFragment)
    ? { ok: true, reason: 'the census ran and passed' }
    : { ok: false, reason: 'the boot succeeded but the census never announced itself - it may not have run at all' };
}

/**
 * D13 - a write that must take effect on the VERY NEXT request. `before` must
 * be admitted and `after` must not; a drill where both refuse proves nothing.
 */
export function tookEffectImmediately({ before, after }) {
  if (surfaceStageShape(before ?? {}) !== 'admitted') {
    return { ok: false, reason: 'the caller did not reach the surface BEFORE the write, so its later refusal is unattributed' };
  }
  // ROUND-1 REGRESSION `4181cb84`: this accepted EVERY non-2xx answer, so an
  // HTTP 500 read as proof that disabling the Account took effect. A crash is
  // not a revocation.
  if (surfaceStageShape(after ?? {}) === 'admitted') {
    return { ok: false, reason: `the request AFTER the write still succeeded (${after?.status})` };
  }
  // A disabled Account is refused by the AUTHENTICATION stage, so 401 is a
  // ratified answer HERE — unlike D17, where a 401 means the credential was
  // never accepted and the refusal proves nothing. What is refused in both is
  // a 5xx: a crash is not a revocation.
  const afterStatus = Number(after?.status);
  if (!Number.isFinite(afterStatus) || afterStatus < 400 || afterStatus >= 500) {
    return { ok: false, reason: `the request AFTER the write answered ${refusalDefect(after ?? {})}, which does not show that disabling the Account took effect` };
  }
  return { ok: true, reason: `admitted before the write (${before?.status}), refused on the very next request (${after?.status} ${after?.code ?? ''})` };
}

/** Every named refusal wrote its audit row, carrying the surface key and the
 * COMPUTED LEVEL (design §3.6). An audited denial with no level is the
 * recorded-not-judged shape again. */
export function refusalsAudited(rows, { expected = [], minimum = 1, runBoundary, ledger, accessLevels } = {}) {
  // ROUND-3 GAP `93a7cbdb`, self-filed by the round-3 repair session. The drill
  // read EVERY `surface.refused` row in the table, so on a REUSED database an
  // earlier run's rows covered this run's refusals - measured at 136 -> 272 ->
  // 408 rows across three runs of one drill against one database.
  //
  // ROUND-4 REVIEW `5cfe851b` B1 showed the run boundary was necessary and NOT
  // SUFFICIENT: bounding by RUN still left an aggregate method/path count, and
  // the drill makes many unregistered requests EARLIER IN THE SAME RUN that
  // write matching rows. 68 caused refusals were being checked against 191
  // in-run rows, so a stage that stopped auditing could be covered by a
  // sibling request rather than by history.
  //
  // The correlation is therefore ATTRIBUTED, not aggregated. Every request the
  // drill makes records the ids of the rows IT created (`ledger`), each
  // expected refusal carries its own request's `rowIds`, and a row may satisfy
  // at most one expectation. The aggregate multiset check remains below as a
  // backstop, not as the proof.
  if (!runBoundary || typeof runBoundary !== 'object') {
    return { ok: false, reason: 'no run boundary was supplied: rows written by an EARLIER run against this database would cover this run\'s refusals' };
  }
  if (!runBoundary.runId || !runBoundary.startedAt) {
    return { ok: false, reason: 'the run boundary names no run id or no start, so it bounds nothing' };
  }
  const started = new Date(runBoundary.startedAt).getTime();
  if (!Number.isFinite(started)) {
    return { ok: false, reason: `the run boundary's start '${runBoundary.startedAt}' is not a time` };
  }
  if (!Array.isArray(runBoundary.preExistingIds)) {
    return { ok: false, reason: 'the run boundary carries no list of pre-existing row ids, so it cannot exclude them by identity' };
  }
  const preExisting = new Set(runBoundary.preExistingIds.map(String));
  const outside = (rows ?? []).filter((row) => {
    if (preExisting.has(String(row?.id))) return true;
    const at = new Date(row?.occurredAt ?? row?.occurred_at ?? NaN).getTime();
    return !Number.isFinite(at) || at < started;
  });
  if (outside.length > 0) {
    return {
      ok: false,
      reason: `${outside.length} of ${(rows ?? []).length} audit rows are from OUTSIDE run ${runBoundary.runId} (a pre-existing id, or written before ${runBoundary.startedAt}): correlating this run's refusals against them proves nothing about this run`,
    };
  }

  if (!Array.isArray(ledger)) {
    return { ok: false, reason: 'no request ledger was supplied: without the rows each request created, a refusal that wrote NOTHING is covered by any sibling request that wrote one' };
  }
  const relevant = (rows ?? []).filter((row) => row.action === SURFACE_REFUSAL_ACT);
  const byId = new Map(relevant.map((row) => [String(row.id), row]));

  // TOTAL ATTRIBUTION. Every row this run wrote belongs to exactly one request.
  // A row nothing claims is a row the drill cannot reason about at all.
  const claimed = new Map();
  for (const entry of ledger) {
    for (const id of entry?.rowIds ?? []) {
      claimed.set(String(id), [...(claimed.get(String(id)) ?? []), entry]);
    }
  }
  const unattributed = relevant.filter((row) => !claimed.has(String(row.id)));
  if (unattributed.length > 0) {
    return {
      ok: false,
      reason: `${unattributed.length} of ${relevant.length} '${SURFACE_REFUSAL_ACT}' rows in this run are attributed to NO request the drill recorded: a correlation that cannot say which request wrote a row cannot say a request wrote none`,
    };
  }
  const doubleClaimed = [...claimed.entries()].filter(([, entries]) => entries.length > 1);
  if (doubleClaimed.length > 0) {
    return { ok: false, reason: `${doubleClaimed.length} audit row(s) are claimed by more than one request, so attribution is not a partition` };
  }

  // EACH EXPECTED REFUSAL IS SATISFIED BY ITS OWN REQUEST'S ROWS, and a row
  // may satisfy at most one expectation.
  if (!Array.isArray(expected) || expected.length === 0) {
    return { ok: false, reason: 'no expected refusals were named: an aggregate count cannot show that EVERY refusal was audited' };
  }
  const consumed = new Set();
  const unproved = [];
  for (const want of expected) {
    const wantMethod = String(want?.method ?? '').toUpperCase();
    const wantPath = String(want?.path ?? '');
    if (!Array.isArray(want?.rowIds)) {
      unproved.push(`${wantMethod} ${wantPath}: the drill did not record which rows ITS OWN request wrote`);
      continue;
    }
    // ROUND-4 EXTRA VERDICT `36e8588e` B6. The match was METHOD and PATH only,
    // and the surface key and level were then checked for TRUTHINESS at the
    // end of this function - so a row for the right URL naming the WRONG
    // SURFACE, or carrying a level the caller does not hold, satisfied the
    // expectation. Whatever the drill's contract KNOWS about a refusal - which
    // surface must have refused, which family class, which computed level -
    // the row must agree with, exactly. A field the contract does not name is
    // not asserted here, and the vocabulary check below still applies to it.
    const disagreements = [];
    const own = want.rowIds
      .map((id) => byId.get(String(id)))
      .filter((row) => row && !consumed.has(String(row.id)))
      .filter((row) => {
        const metadata = row.metadata ?? {};
        if (String(metadata.method ?? '').toUpperCase() !== wantMethod) return false;
        if (String(metadata.path ?? '') !== wantPath) return false;
        const mismatched = [];
        if (want.surfaceKey !== undefined && String(metadata.surfaceKey ?? '') !== String(want.surfaceKey)) {
          mismatched.push(`surfaceKey '${metadata.surfaceKey ?? '(none)'}' where the contract says '${want.surfaceKey}'`);
        }
        if (want.accessLevel !== undefined && String(metadata.accessLevel ?? '') !== String(want.accessLevel)) {
          mismatched.push(`accessLevel '${metadata.accessLevel ?? '(none)'}' where the contract says '${want.accessLevel}'`);
        }
        if (want.family !== undefined) {
          const actual = metadata.family === null || metadata.family === undefined ? null : String(metadata.family);
          if (actual !== (want.family === null ? null : String(want.family))) {
            mismatched.push(`family '${actual ?? 'null'}' where the contract says '${want.family ?? 'null'}'`);
          }
        }
        if (mismatched.length > 0) { disagreements.push(mismatched.join(', ')); return false; }
        return true;
      });
    if (own.length === 0) {
      unproved.push(disagreements.length > 0
        ? `${wantMethod} ${wantPath}: its own request's row(s) carry ${disagreements.join(' / ')}`
        : `${wantMethod} ${wantPath}: its own request wrote ${want.rowIds.length} '${SURFACE_REFUSAL_ACT}' row(s), none of them for this method and path`);
      continue;
    }
    consumed.add(String(own[0].id));
  }
  if (unproved.length > 0) {
    return {
      ok: false,
      reason: `${unproved.length} of ${expected.length} caused refusals are not audited BY THEIR OWN REQUEST: ${unproved.join('; ')}`,
    };
  }
  // ROUND-1 REGRESSION `e776b244`. This oracle used to require an aggregate
  // MINIMUM and then check fields on whatever rows happened to exist. Three
  // unrelated rows satisfied it while four of five expected refusals wrote
  // NOTHING — so §3.6's "every refusal is auditable" was never measured. The
  // attributed correlation above is the proof now; what follows is the
  // BACKSTOP, kept because a multiset shortfall is a different symptom and
  // says so more clearly.
  if (relevant.length < minimum) {
    return { ok: false, reason: `expected at least ${minimum} '${SURFACE_REFUSAL_ACT}' audit rows, found ${relevant.length}` };
  }
  // ROUND-2 REGRESSION `4e894e2d`. This asked, for each expected refusal,
  // whether SOME row matched it - a membership test, so ONE row satisfied two
  // identical caused requests and a subset of a repeated refusal could write
  // nothing at all. §3.6 is a claim about EVERY refusal, so the correlation is
  // now a multiset: two `GET /webhooks` refusals need two rows.
  const rowCounts = new Map();
  for (const row of relevant) {
    const metadata = row.metadata ?? {};
    const key = `${String(metadata.method ?? '').toUpperCase()} ${String(metadata.path ?? '')}`;
    rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
  }
  const wantCounts = new Map();
  for (const want of expected) {
    const key = `${String(want.method).toUpperCase()} ${String(want.path)}`;
    wantCounts.set(key, (wantCounts.get(key) ?? 0) + 1);
  }
  const short = [];
  for (const [key, n] of wantCounts) {
    const m = rowCounts.get(key) ?? 0;
    if (m < n) short.push(`${key}: caused ${n}, audited ${m}`);
  }
  if (short.length > 0) {
    return {
      ok: false,
      reason: `${short.length} of ${wantCounts.size} refusal targets the drill CAUSED are under-audited: ${short.join('; ')}`,
    };
  }
  // The VOCABULARY check, over every row and not only the correlated ones.
  // `36e8588e` B6 again: "carries a surfaceKey and an accessLevel" was a
  // truthiness test, so `accessLevel: 'yes'` passed it. The levels must be
  // production's ratified `ACCESS_LEVELS`, handed in rather than re-spelled
  // here, and the family must be one of the two ratified classes or the
  // explicit `null` steps 4b/5 write before a class exists.
  const ratifiedLevels = [...(accessLevels ?? [])].map(String);
  if (ratifiedLevels.length === 0) {
    return { ok: false, reason: 'no ratified access levels were supplied: a row\'s computed level can then only be checked for truthiness, which `accessLevel: \'yes\'` satisfies' };
  }
  const incomplete = relevant.map((row) => {
    const metadata = row.metadata ?? {};
    const faults = [];
    if (!metadata.surfaceKey || typeof metadata.surfaceKey !== 'string') faults.push('no surfaceKey');
    if (!ratifiedLevels.includes(String(metadata.accessLevel))) faults.push(`accessLevel '${metadata.accessLevel ?? '(none)'}' is not one of the ratified ${ratifiedLevels.join('/')}`);
    const family = metadata.family === undefined ? undefined : metadata.family;
    if (!(family === null || family === 'read' || family === 'write')) faults.push(`family '${String(family)}' is neither ratified class nor the explicit null the pre-family rungs write`);
    return faults.length > 0 ? `${String(metadata.method ?? '?')} ${String(metadata.path ?? '?')}: ${faults.join('; ')}` : null;
  }).filter(Boolean);
  return incomplete.length === 0
    ? { ok: true, reason: `all ${expected.length} caused refusals audited BY THEIR OWN REQUEST across ${wantCounts.size} targets, each row agreeing with every field the contract names for it; all ${relevant.length} rows in run ${runBoundary.runId} are attributed to one of the ${ledger.length} requests the drill recorded, and every row carries a surface key, a ratified computed level and a ratified family class (${runBoundary.preExistingIds.length} pre-existing rows excluded by id)` }
    : { ok: false, reason: `${incomplete.length} refusal row(s) do not carry the ratified vocabulary: ${incomplete.slice(0, 6).join(' | ')}` };
}
