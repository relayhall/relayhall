// The controls for the reachability-drill oracles - run with `node --test`.
//
// Each shape the drill exists to catch is handed to the oracle VERBATIM and
// must be refused, beside the good answer that must pass. A mutation that
// drops the endpoint's field, changes its type, or swaps the value has a
// named refusal here, each reddening a DIFFERENT assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedBoundFromEnv, judgeEffectiveConfiguration, parseProbeLine } from './orchestration-config-drill-oracles.mjs';

const good = (orchestration) => ({ status: 200, body: { status: 'configured', source: 'process', orchestration } });
const bounded = { claimSurface: 'always-on', maxActiveGlobal: 7, maxActivePerProject: 3, leaseTtlSeconds: 900 };
const unlimited = { claimSurface: 'always-on', maxActiveGlobal: 'unlimited', maxActivePerProject: 'unlimited', leaseTtlSeconds: 900 };

test('bounded: the handed numbers come back as those numbers', () => {
  assert.equal(judgeEffectiveConfiguration(good(bounded), { maxActiveGlobal: 7, maxActivePerProject: 3 }).ok, true);
});

test('unlimited: nothing handed comes back as the literal word', () => {
  assert.equal(judgeEffectiveConfiguration(good(unlimited), { maxActiveGlobal: 'unlimited', maxActivePerProject: 'unlimited' }).ok, true);
});

test('CONTROL (the C3 shape): a bound handed but the process answers unlimited is RED', () => {
  const v = judgeEffectiveConfiguration(good(unlimited), { maxActiveGlobal: 7, maxActivePerProject: 3 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /maxActiveGlobal handed 7 but the process answers "unlimited"/);
});

test('CONTROL: the field dropped from the answer is RED, by its own reason', () => {
  const { maxActiveGlobal, ...dropped } = bounded;
  const v = judgeEffectiveConfiguration(good(dropped), { maxActiveGlobal: 7, maxActivePerProject: 3 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /dropped maxActiveGlobal/);
  const { maxActivePerProject, ...dropped2 } = bounded;
  assert.match(judgeEffectiveConfiguration(good(dropped2), { maxActiveGlobal: 7, maxActivePerProject: 3 }).reason, /dropped maxActivePerProject/);
});

test('CONTROL: a neighbouring number is RED (7 handed, 8 answered)', () => {
  const v = judgeEffectiveConfiguration(good({ ...bounded, maxActiveGlobal: 8 }), { maxActiveGlobal: 7, maxActivePerProject: 3 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /handed 7 but the process answers 8/);
});

test('CONTROL: the number as a string is RED - the type is part of the contract', () => {
  const v = judgeEffectiveConfiguration(good({ ...bounded, maxActiveGlobal: '7' }), { maxActiveGlobal: 7, maxActivePerProject: 3 });
  assert.equal(v.ok, false);
});

test('CONTROL: null is not "unlimited"', () => {
  const v = judgeEffectiveConfiguration(good({ ...unlimited, maxActivePerProject: null }), { maxActiveGlobal: 'unlimited', maxActivePerProject: 'unlimited' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /maxActivePerProject handed "unlimited" but the process answers null/);
});

test('CONTROL: a claim surface that is not always-on is RED', () => {
  const v = judgeEffectiveConfiguration(good({ ...bounded, claimSurface: 'disabled' }), { maxActiveGlobal: 7, maxActivePerProject: 3 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not reported always-on/);
});

test('CONTROL: a non-200 answer, a non-process source, and no answer at all are each RED by their own reason', () => {
  assert.match(judgeEffectiveConfiguration({ status: 404, body: null }, { maxActiveGlobal: 7, maxActivePerProject: 3 }).reason, /HTTP 404/);
  assert.match(judgeEffectiveConfiguration({ status: 200, body: { status: 'configured', source: 'env', orchestration: bounded } }, { maxActiveGlobal: 7, maxActivePerProject: 3 }).reason, /process-sourced/);
  assert.match(judgeEffectiveConfiguration(null, { maxActiveGlobal: 7, maxActivePerProject: 3 }).reason, /never answered/);
});

test('parseProbeLine: finds the one line, tolerates other output, null when absent or unparsable', () => {
  const stdout = 'banner\nBOOT CHECK PROBE /health/orchestration 200 {"status":"configured","source":"process","orchestration":' + JSON.stringify(bounded) + '}\nBOOT CHECK OK\n';
  const parsed = parseProbeLine(stdout);
  assert.equal(parsed.status, 200);
  assert.deepEqual(parsed.body.orchestration, bounded);
  assert.equal(parseProbeLine('BOOT CHECK OK\n'), null);
  assert.equal(parseProbeLine('BOOT CHECK PROBE /health/orchestration 200 not-json').body, null);
});

test('expectedBoundFromEnv: integer, empty, unset, the word; anything else refused', () => {
  assert.equal(expectedBoundFromEnv('16'), 16);
  assert.equal(expectedBoundFromEnv(''), 'unlimited');
  assert.equal(expectedBoundFromEnv(undefined), 'unlimited');
  assert.equal(expectedBoundFromEnv('unlimited'), 'unlimited');
  assert.throws(() => expectedBoundFromEnv('sixteen'), /integer or "unlimited"/);
});
