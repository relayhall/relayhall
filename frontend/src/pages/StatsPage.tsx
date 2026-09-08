/**
 * StatsPage — always-on core surface (F11), now with the TW1c rollups.
 *
 * Stats are computed from reporter-fed session activity. The board never
 * scrapes transcripts or harness files to derive analytics, so until reporter
 * outposts are connected there is nothing to aggregate and this page renders
 * its documented empty state — the zero-config default, not an error.
 *
 * WHAT IS NEW (card `50e74c1d`): usage/token rollups, the model mix, cost with
 * its BASIS shown, and the adapter coverage view (design §10.3) — the fourth
 * quarter of MVP acceptance criterion 4, which asks a Tier-0-only deployment
 * to render exactly these with zero content stored.
 *
 * THE BASIS IS NEVER HIDDEN. §4.7 and §9.3: an ingested envelope can only ever
 * claim `provider` or `estimated`, `reconciled` is reachable only through a
 * reconciliation receipt, and a cost total that did not say which it was would
 * be presenting an estimate as an invoice. So every cost row carries its basis
 * as visible text, not as a tooltip or a colour.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3 } from 'lucide-react';
import { CoreSurfacePlaceholder } from '../components/CoreSurfacePlaceholder';
import { formatDateTime } from '../utils/dateFormat';
import {
  PRESENCE_LABELS,
  SESSION_STATE_HINTS,
  TELEMETRY_POLL_MS,
  fetchStats,
  formatAmount,
  formatCount,
} from '../utils/telemetryProjection';
import '../styles/telemetry-projection.css';
import './StatsPage.css';

const Instant: React.FC<{ value: string }> = ({ value }) => (
  <time dateTime={value}>{formatDateTime(value)}</time>
);

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="telemetry-stat">
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
);

const EMPTY_STATE = (
  <CoreSurfacePlaceholder
    icon={<BarChart3 size={56} aria-hidden="true" />}
    heading="No activity data to chart"
    description={
      <>
        Stats aggregate the session activity that reporters send to the
        board. Nothing is scraped from transcripts or harness state, so
        with no reporters connected there is no data to chart yet.
      </>
    }
    sections={[
      {
        title: 'Where stats come from',
        items: [
          <>
            <strong>Outposts</strong> — reporters that run alongside your
            agent runtime — self-report session events; stats are computed
            from those reports.
          </>,
          <>
            The same reporters feed both this page and the Sessions page —
            one setup covers both surfaces.
          </>,
        ],
      },
      {
        title: 'How to set it up',
        ordered: true,
        items: [
          <>
            Install a reporter outpost next to your agent runtime.
          </>,
          <>
            Give it a board credential scoped for reporting and point it at
            this board&apos;s API.
          </>,
          <>
            Charts populate as reported activity accumulates — no
            board-side configuration needed.
          </>,
        ],
      },
    ]}
    footer={
      <>
        <strong>Docs:</strong> see <code>docs/observability.md</code> in
        the repository for the reporter model, the ingest contract, and the
        pipeline-health surface.
      </>
    }
  />
);

export const StatsPage: React.FC = () => {
  const statsQuery = useQuery({
    queryKey: ['telemetry-stats'],
    queryFn: () => fetchStats(),
    refetchInterval: TELEMETRY_POLL_MS,
  });

  const stats = statsQuery.data;
  const error = statsQuery.error as Error | undefined;
  const hasData = Boolean(stats && stats.totals.events > 0);

  return (
    <div className="stats-page">
      <div className="stats-header stats-page-stats-header">
        <h1>
          <BarChart3 size={24} aria-hidden="true" /> Stats &amp; Analytics
        </h1>
      </div>

      <p className="telemetry-status" aria-live="polite">
        {statsQuery.isPending ? 'Loading reported activity…'
          : error ? 'Stats could not be read.'
            : hasData
              ? `${formatCount(stats!.totals.events)} event(s) from ${formatCount(stats!.totals.sources)} source(s) since `
              : 'No reported activity.'}
        {!statsQuery.isPending && !error && hasData && <Instant value={stats!.windowStart} />}
      </p>

      {error && (
        <div className="telemetry-error" role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <div>
            <strong>Stats could not be read.</strong>
            <p>{error.message}</p>
          </div>
        </div>
      )}

      {!statsQuery.isPending && !error && hasData && stats && (
        <>
          <section className="telemetry-section" aria-labelledby="telemetry-usage-heading">
            <h2 id="telemetry-usage-heading">Usage</h2>
            <dl className="telemetry-stat-grid">
              <Stat label="Events" value={formatCount(stats.totals.events)} />
              <Stat label="Sessions" value={formatCount(stats.totals.sessions)} />
              <Stat label="Sources" value={formatCount(stats.totals.sources)} />
              <Stat label="Requests" value={formatCount(stats.totals.requests)} />
              <Stat label="Input tokens" value={formatCount(stats.totals.inputTokens)} />
              <Stat label="Output tokens" value={formatCount(stats.totals.outputTokens)} />
              <Stat label="Cached read tokens" value={formatCount(stats.totals.cachedReadTokens)} />
              <Stat label="Reasoning tokens" value={formatCount(stats.totals.reasoningTokens)} />
              <Stat label="Tool tokens" value={formatCount(stats.totals.toolTokens)} />
              <Stat label="Errors" value={formatCount(stats.totals.errors)} />
            </dl>
          </section>

          <section className="telemetry-section" aria-labelledby="telemetry-model-heading">
            <h2 id="telemetry-model-heading">Model mix</h2>
            {stats.modelMix.length === 0 ? (
              <p className="telemetry-inline-status">No reported model calls in this window.</p>
            ) : (
              <div className="telemetry-table-scroll">
                <table className="telemetry-table">
                  <caption className="sr-only">Reported model usage, busiest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col">Model</th>
                      <th scope="col" className="telemetry-numeric">Events</th>
                      <th scope="col" className="telemetry-numeric">Input</th>
                      <th scope="col" className="telemetry-numeric">Output</th>
                      <th scope="col" className="telemetry-numeric">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.modelMix.map((row) => (
                      <tr key={`${row.provider ?? '?'}:${row.model ?? '?'}`}>
                        <td>{row.provider ?? '—'}</td>
                        <td>{row.model ?? '—'}</td>
                        <td className="telemetry-numeric">{formatCount(row.events)}</td>
                        <td className="telemetry-numeric">{formatCount(row.inputTokens)}</td>
                        <td className="telemetry-numeric">{formatCount(row.outputTokens)}</td>
                        <td className="telemetry-numeric">{formatCount(row.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="telemetry-section" aria-labelledby="telemetry-cost-heading">
            <h2 id="telemetry-cost-heading">Cost</h2>
            {stats.cost.length === 0 ? (
              <p className="telemetry-inline-status">No reported cost in this window.</p>
            ) : (
              <>
                <div className="telemetry-table-scroll">
                  <table className="telemetry-table">
                    <caption className="sr-only">Reported cost by basis and currency</caption>
                    <thead>
                      <tr>
                        <th scope="col">Basis</th>
                        <th scope="col">Currency</th>
                        <th scope="col" className="telemetry-numeric">Amount</th>
                        <th scope="col" className="telemetry-numeric">Events</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.cost.map((row) => (
                        <tr key={`${row.basis}:${row.currency ?? '?'}`}>
                          <td>{row.basis}</td>
                          <td>{row.currency ?? '—'}</td>
                          <td className="telemetry-numeric telemetry-mono">{formatAmount(row.amount)}</td>
                          <td className="telemetry-numeric">{formatCount(row.events)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="telemetry-note">
                  <strong>estimated</strong> is what a reporter computed;{' '}
                  <strong>provider</strong> is what a provider stated. Neither is
                  reconciled — reconciliation against provider accounting arrives
                  with the accounting connectors, and only a reconciliation
                  receipt can move a figure to that basis.
                </p>
              </>
            )}
          </section>

          <section className="telemetry-section" aria-labelledby="telemetry-coverage-heading">
            <h2 id="telemetry-coverage-heading">Adapter coverage</h2>
            <div className="telemetry-table-scroll">
              <table className="telemetry-table">
                <caption className="sr-only">
                  Reporting sources with their declared coverage labels
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Reporter</th>
                    <th scope="col">Adapter</th>
                    <th scope="col">Mechanism</th>
                    <th scope="col">Support</th>
                    <th scope="col">Tier</th>
                    <th scope="col">State</th>
                    <th scope="col">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.coverage.map((source) => (
                    <tr key={`${source.connectorId}:${source.sourceProduct}`}>
                      <td>{source.sourceProduct}</td>
                      <td>{source.connectorHandle ?? source.connectorId}</td>
                      <td>
                        {source.adapter ?? '—'}
                        {source.adapterVersion ? ` ${source.adapterVersion}` : ''}
                      </td>
                      <td>{source.mechanism ?? 'unstated'}</td>
                      <td>{source.supportLevel ?? 'unstated'}</td>
                      <td>{source.policyTier === null ? '—' : `Tier ${source.policyTier}`}</td>
                      <td>
                        <span
                          className={`telemetry-chip telemetry-chip--${source.state}`}
                          aria-label={`${PRESENCE_LABELS[source.state]} — ${SESSION_STATE_HINTS[source.state]}`}
                        >
                          {PRESENCE_LABELS[source.state]}
                        </span>
                      </td>
                      <td><Instant value={source.lastSeenAt} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="telemetry-note">
              Coverage is what each source DECLARED about itself, shown as
              declared. <strong>unstated</strong> means the reporter sent no such
              label — it is never filled in with a guess, because a coverage
              claim nobody made is the one thing this view must not invent.
            </p>
          </section>
        </>
      )}

      {!statsQuery.isPending && !error && !hasData && EMPTY_STATE}
    </div>
  );
};
