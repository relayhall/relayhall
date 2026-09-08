import {
  CanonicalRuntimeSignalService,
  classifyCanonicalRuntimeSignal,
  type CanonicalRuntimeSignalEvidence,
} from '../services/CanonicalRuntimeSignalService';

const now = new Date('2026-07-16T13:00:00.000Z');

function evidence(overrides: Partial<CanonicalRuntimeSignalEvidence> = {}): CanonicalRuntimeSignalEvidence {
  return {
    taskId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    attemptNumber: 1,
    harness: 'hermes',
    linkState: 'bound',
    linkedAt: new Date(now.getTime() - 30_000),
    endedAt: null,
    progressSequence: 0,
    lastProgressAt: null,
    latestEvidenceAt: null,
    lifecycle: null,
    availability: null,
    freshness: null,
    writerLease: 'none',
    ...overrides,
  };
}

describe('canonical orchestrator runtime signals', () => {
  it('requires meaningful recent progress for active and exposes a monotonic progress sequence', () => {
    const signal = classifyCanonicalRuntimeSignal(evidence({
      progressSequence: 7,
      lastProgressAt: new Date(now.getTime() - 15_000),
      latestEvidenceAt: new Date(now.getTime() - 10_000),
      lifecycle: 'running', availability: 'available', freshness: 'fresh',
    }), now);
    expect(signal).toMatchObject({
      state: 'active', reasonCode: 'recent_meaningful_progress', progressSequence: 7,
      lastProgressAt: '2026-07-16T12:59:45.000Z',
    });
  });

  it('distinguishes idle from stale using sourced activity time', () => {
    expect(classifyCanonicalRuntimeSignal(evidence({
      progressSequence: 2,
      lastProgressAt: new Date(now.getTime() - 3 * 60_000),
      latestEvidenceAt: new Date(now.getTime() - 3 * 60_000),
    }), now).state).toBe('idle');

    expect(classifyCanonicalRuntimeSignal(evidence({
      progressSequence: 2,
      lastProgressAt: new Date(now.getTime() - 15 * 60_000),
      latestEvidenceAt: new Date(now.getTime() - 15 * 60_000),
      writerLease: 'active',
    }), now)).toMatchObject({
      state: 'stale', reasonCode: 'writer_lease_active_but_progress_stale',
    });
  });

  it('marks expired ownership and unavailable bound attempts as orphaned', () => {
    expect(classifyCanonicalRuntimeSignal(evidence({ writerLease: 'expired' }), now)).toMatchObject({
      state: 'orphan', reasonCode: 'writer_lease_expired_without_terminal_evidence',
    });
    expect(classifyCanonicalRuntimeSignal(evidence({
      linkedAt: new Date(now.getTime() - 5 * 60_000),
      latestEvidenceAt: new Date(now.getTime() - 5 * 60_000),
      lifecycle: 'unknown', availability: 'unavailable', freshness: 'expired',
    }), now).state).toBe('orphan');
  });

  it('treats terminal source evidence as finished even when it is old', () => {
    expect(classifyCanonicalRuntimeSignal(evidence({
      lifecycle: 'completed', availability: 'available', freshness: 'not_applicable',
      latestEvidenceAt: new Date(now.getTime() - 24 * 60 * 60_000),
    }), now)).toMatchObject({
      state: 'finished', reasonCode: 'terminal_lifecycle_completed',
    });
  });

  it('does not treat session existence or ended_at null as activity', () => {
    expect(classifyCanonicalRuntimeSignal(evidence({
      linkState: 'claimed', linkedAt: new Date(now.getTime() - 30_000),
    }), now)).toMatchObject({
      state: 'unknown', reasonCode: 'insufficient_canonical_evidence',
    });
  });

  it('reads canonical events and leases rather than legacy session presence', async () => {
    const query = jest.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{
      task_id: evidence().taskId,
      attempt_id: evidence().attemptId,
      attempt_number: '3',
      harness: 'openclaw',
      link_state: 'bound',
      linked_at: new Date(now.getTime() - 60_000),
      ended_at: null,
      progress_sequence: '11',
      last_progress_at: new Date(now.getTime() - 20_000),
      latest_evidence_at: new Date(now.getTime() - 10_000),
      lifecycle: 'running',
      availability: 'available',
      freshness: 'fresh',
      writer_lease: 'active',
    }] }));
    const service = new CanonicalRuntimeSignalService({ query } as any);
    const signals = await service.listTaskSignals(evidence().taskId, now);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ state: 'active', attemptNumber: 3, progressSequence: 11 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("e.event_kind IN ('message','tool_call','tool_result','control')");
    expect(sql).toContain("o.ownership_kind='writer'");
    expect(sql).toContain("l.link_state NOT IN ('released','superseded')");
    expect(params).toEqual([evidence().taskId, now]);
  });

  it('rejects invalid decision windows', () => {
    expect(() => classifyCanonicalRuntimeSignal(evidence(), now, { activeMs: 0, staleMs: 1 }))
      .toThrow('runtime signal windows');
    expect(() => classifyCanonicalRuntimeSignal(evidence(), now, { activeMs: 10, staleMs: 9 }))
      .toThrow('runtime signal windows');
  });
});
