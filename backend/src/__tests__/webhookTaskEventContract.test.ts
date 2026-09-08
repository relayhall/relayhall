/**
 * webhookTaskEventContract.test.ts — the outbound webhook contract.
 *
 * ── History, so the supersession is legible rather than mysterious ──
 *
 * This suite was written for RH-VOCAB.5 (task 7e16c717), when the internal
 * emitter and WebSocket moved to dotted event names. Its job then was to
 * prove that a RENAME changed nothing observable: same event names, same
 * payload shapes, same registrable set.
 *
 * RH-P3.C2 re-cuts the payload deliberately. Strategy §2.6.4, via analysis
 * d8507677 §4 and runbook daf703a6 §5, contracts SIGNED, ID-ONLY webhooks:
 * a delivery carries identity and nothing else, and a subscriber pulls the
 * object under its own grants to learn anything about it. The VOCAB.5
 * guarantee was never a promise that Phase 3 would leave the payload alone —
 * Phase 3 was already contracted to change it when that guarantee was
 * written — so the payload assertions here are SUPERSEDED and replaced.
 *
 * What is NOT superseded, and is preserved verbatim below: the rule that no
 * colon-punctuated event name survives anywhere in the tree. That is a
 * vocabulary invariant (b94dd86e §6), independent of any payload shape, and
 * C2 must not be allowed to quietly cost the estate that guard.
 *
 * The registrable-set assertions move to c2WebhookEventCensus.test.ts, which
 * checks the set against what the feed can actually emit rather than against
 * a second copy of the same list.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { WEBHOOK_EVENTS } from '../services/WebhookService';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

describe('the outbound webhook contract after C2', () => {
  /**
   * The pre-C2 service dispatched task events from the TaskManagerDB
   * EventEmitter, carrying title/status/priority/project/tags. That path is
   * gone: delivery reads the feed by cursor so it can be grant-scoped,
   * durable across restarts, and reconcilable. This asserts the old path
   * cannot come back through this file.
   */
  test('the emitter-driven dispatch path is retired', () => {
    const service = read('backend/src/services/WebhookService.ts');
    expect(service).not.toContain('taskManagerDB.on');
    expect(service).not.toContain('taskSummary');
    expect(service).not.toContain('emitEvent');
  });

  test('the stored default subscription names only feed-backed events', () => {
    const routes = read('backend/src/routes/webhooks.ts');
    const defaults = routes.match(/ARRAY\[([^\]]*)\]/);
    expect(defaults).not.toBeNull();
    expect(defaults![0]).toBe("ARRAY['task.created','task.updated','task.deleted','task.archived']");
    // Whatever the default is, every name in it must still be registrable —
    // a default that cannot be registered would create subscriptions that
    // silently receive nothing.
    for (const name of [...defaults![0].matchAll(/'([^']+)'/g)].map(m => m[1])) {
      expect(WEBHOOK_EVENTS as readonly string[]).toContain(name);
    }
  });

  /**
   * The six pre-C2 names that leave the registrable set, recorded here as an
   * explicit list so the removal is a stated fact rather than something a
   * reader has to diff two versions to discover. Each has a feed-backed
   * successor: report archival/unarchival arrive as `report.updated` with a
   * status discriminator, and skill version/pin changes as `skill.updated`.
   */
  test('the retired pre-C2 names are gone, and their successors are registrable', () => {
    const retired = [
      'report.archived', 'report.unarchived',
      'skill.version.created', 'skill.version.review-requested',
      'skill.version.rejected', 'skill.version.published', 'skill.version.retired',
      'skill.pin.changed',
    ];
    for (const name of retired) {
      expect(WEBHOOK_EVENTS as readonly string[]).not.toContain(name);
    }
    for (const successor of ['report.updated', 'skill.updated']) {
      expect(WEBHOOK_EVENTS as readonly string[]).toContain(successor);
    }
  });

  /**
   * PRESERVED FROM VOCAB.5 — a vocabulary invariant (b94dd86e §6), unrelated
   * to the payload cut. Events are dotted on every transport; a colon
   * survives only in scopes.
   */
  test('no colon-punctuated event name survives anywhere in the tracked tree', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(f => /\.(ts|tsx|js|jsx|py|md)$/.test(f));
    const colonEvent = /'[A-Za-z_-]+:(?:created|updated|deleted|archived|generated|ready|stuck|expired)'/;
    const offenders = tracked.filter(f => colonEvent.test(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
