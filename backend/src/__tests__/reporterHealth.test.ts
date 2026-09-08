import { derivePipelineStatus } from '../routes/reporterHealth';

// Pins the aggregation semantics of GET /sessions/pipeline-health — the
// reporter-ingest health seed kept through the P1.3 observer retirement
// (ruling A18). The frontend MessageQueueCard test that previously pinned
// these semantics left with the card; this is the surviving contract test.
describe('reporter-ingest pipeline health aggregation', () => {
  it('reports unknown when no adapters have ever reported', () => {
    expect(derivePipelineStatus([])).toBe('unknown');
  });

  it('reports healthy only when every adapter is healthy', () => {
    expect(derivePipelineStatus([
      { status: 'healthy' },
      { status: 'healthy' },
    ])).toBe('healthy');
  });

  it('reports degraded when any adapter is not healthy', () => {
    expect(derivePipelineStatus([
      { status: 'healthy' },
      { status: 'degraded' },
    ])).toBe('degraded');
    expect(derivePipelineStatus([{ status: 'unavailable' }])).toBe('degraded');
    expect(derivePipelineStatus([{ status: 'unauthorized' }])).toBe('degraded');
    expect(derivePipelineStatus([{ status: 'unknown' }])).toBe('degraded');
  });
});
