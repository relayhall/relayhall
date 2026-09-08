/**
 * orchestration-config-drill-oracles - the verdicts of
 * `orchestration-config-reachability-drill.mjs`, as pure functions with
 * their own controls (card 590c638a, ruling 4).
 *
 * The drill exists because of RH-P3.C3: a compose file never forwarded a
 * switch, every suite stayed green, and the claim/lease surface answered
 * ORCHESTRATION_DISABLED on every deployment. The oracle therefore judges
 * the EXACT value the process answers against the EXACT value handed to it:
 * a number must come back as that number (never a string, never a
 * neighbour), an absent bound must come back as the literal word
 * "unlimited" - and a missing field is a red verdict, not a pass.
 */

export const PROBE_PATH = '/health/orchestration';
export const PROBE_LINE_PREFIX = `BOOT CHECK PROBE ${PROBE_PATH} `;

/**
 * Parse the single probe line the boot-check emits. Returns null when the
 * line is absent: a process that never answered is the finding.
 */
export function parseProbeLine(stdout) {
  const line = String(stdout ?? '').split('\n').find((l) => l.startsWith(PROBE_LINE_PREFIX));
  if (!line) return null;
  const rest = line.slice(PROBE_LINE_PREFIX.length);
  const space = rest.indexOf(' ');
  if (space < 0) return null;
  const status = Number(rest.slice(0, space));
  let body;
  try { body = JSON.parse(rest.slice(space + 1)); } catch { return { status, body: null }; }
  return { status, body };
}

function sameBound(actual, expected) {
  if (expected === 'unlimited') return actual === 'unlimited';
  return typeof actual === 'number' && Number.isInteger(actual) && actual === expected;
}

/**
 * Judge an answer against what was handed to the process.
 *   expected = { maxActiveGlobal: 7 | 'unlimited', maxActivePerProject: 3 | 'unlimited' }
 */
export function judgeEffectiveConfiguration(answer, expected) {
  if (!answer) return { ok: false, reason: 'the process never answered the probe' };
  if (answer.status !== 200) return { ok: false, reason: `the endpoint answered HTTP ${answer.status}, not 200` };
  const body = answer.body;
  if (!body || typeof body !== 'object') return { ok: false, reason: 'the answer is not a JSON object' };
  if (body.status !== 'configured' || body.source !== 'process') return { ok: false, reason: 'the answer is not the process-sourced configuration envelope' };
  const o = body.orchestration;
  if (!o || typeof o !== 'object') return { ok: false, reason: 'the answer carries no orchestration block' };
  if (o.claimSurface !== 'always-on') return { ok: false, reason: 'the claim surface is not reported always-on' };
  if (!('maxActiveGlobal' in o)) return { ok: false, reason: 'the answer dropped maxActiveGlobal' };
  if (!('maxActivePerProject' in o)) return { ok: false, reason: 'the answer dropped maxActivePerProject' };
  if (!sameBound(o.maxActiveGlobal, expected.maxActiveGlobal)) {
    return { ok: false, reason: `maxActiveGlobal handed ${JSON.stringify(expected.maxActiveGlobal)} but the process answers ${JSON.stringify(o.maxActiveGlobal)}` };
  }
  if (!sameBound(o.maxActivePerProject, expected.maxActivePerProject)) {
    return { ok: false, reason: `maxActivePerProject handed ${JSON.stringify(expected.maxActivePerProject)} but the process answers ${JSON.stringify(o.maxActivePerProject)}` };
  }
  if (!Number.isInteger(o.leaseTtlSeconds) || o.leaseTtlSeconds < 30) return { ok: false, reason: 'leaseTtlSeconds is not a sane integer' };
  return { ok: true, reason: `the process answers the configuration it was handed (global ${JSON.stringify(o.maxActiveGlobal)}, per-project ${JSON.stringify(o.maxActivePerProject)})` };
}

/** "7" -> 7, "" / undefined / "unlimited" -> 'unlimited'; anything else throws. */
export function expectedBoundFromEnv(raw) {
  if (raw === undefined || raw === '' || raw === 'unlimited') return 'unlimited';
  if (!/^\d+$/.test(raw)) throw new Error(`expected bound must be an integer or "unlimited", got ${JSON.stringify(raw)}`);
  return Number(raw);
}
