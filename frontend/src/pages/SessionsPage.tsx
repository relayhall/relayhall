/**
 * SessionsPage — always-on core surface (F11), now with the TW1c projection.
 *
 * The board holds no connection into any agent runtime: it never scrapes
 * harness state, sessions files, or transcripts. Session activity appears
 * here only when reporter outposts self-report it through the typed ingest
 * contract. With no reporters connected the page renders its documented empty
 * state — the zero-config default, not an error — and that empty state is the
 * one UI-REFINE polished, unchanged.
 *
 * WHAT IS NEW (card `50e74c1d`): when reporters HAVE pushed, the page renders
 * the derived presence projection (one chip per telemetry source, on the
 * shipped `active | idle | stale` vocabulary) and the Tier-0 session timeline
 * above the same explanatory material.
 *
 * TIER 0 ONLY. Every column here is metadata the Tier-0 policy engine already
 * bounded — a pseudonymous session reference, a product name, a model name, a
 * token count, a timestamp. There is no transcript pane, because Tier 0 stores
 * no content at all (§6.3 default OFF); the transcript surface arrives with
 * TW5 and its `telemetry-contents:read` selector, and nothing on this page
 * anticipates it.
 *
 * THREE STATES, NEVER CONFLATED. Loading, error and empty are separate: a
 * refusal renders as a refusal, not as "no reporters connected". An operator
 * reading the empty state must be able to trust that it means what it says.
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, Radio } from 'lucide-react';
import { CoreSurfacePlaceholder } from '../components/CoreSurfacePlaceholder';
import { formatDateTime } from '../utils/dateFormat';
import {
  PRESENCE_LABELS,
  SESSION_STATE_HINTS,
  SESSION_STATE_LABELS,
  TELEMETRY_POLL_MS,
  fetchPresence,
  fetchSession,
  fetchSessions,
  formatCount,
  shortSessionRef,
  type TelemetryPresenceRow,
  type TelemetrySessionRow,
} from '../utils/telemetryProjection';
import '../styles/telemetry-projection.css';
import './SessionsPage.css';

/** One instant, rendered once, by the one date formatter. */
const Instant: React.FC<{ value: string }> = ({ value }) => (
  <time dateTime={value}>{formatDateTime(value)}</time>
);

const PresenceChip: React.FC<{ source: TelemetryPresenceRow }> = ({ source }) => (
  <li className="telemetry-source-card">
    <div className="telemetry-source-head">
      <span className="telemetry-source-product">{source.sourceProduct}</span>
      <span
        className={`telemetry-chip telemetry-chip--${source.state}`}
        // The state word alone does not say what it means, and a `title` is
        // mouse-only. The description rides the accessible name instead.
        aria-label={`${PRESENCE_LABELS[source.state]} — ${SESSION_STATE_HINTS[source.state]}`}
      >
        {PRESENCE_LABELS[source.state]}
      </span>
    </div>
    <dl className="telemetry-source-facts">
      <div><dt>Reporter</dt><dd>{source.connectorHandle ?? source.connectorId}</dd></div>
      <div><dt>Last seen</dt><dd><Instant value={source.lastSeenAt} /></dd></div>
      <div><dt>Sessions</dt><dd>{formatCount(source.sessionCount)}</dd></div>
      <div><dt>Events</dt><dd>{formatCount(source.eventCount)}</dd></div>
    </dl>
    {source.connectorFrame && (
      <p className="telemetry-source-frame">
        {/* Deliberately beside the state and never folded into it: a C7 frame
            proves the REPORTER process is alive and names no product, so it
            cannot say which source is alive. */}
        Reporter process {PRESENCE_LABELS[source.connectorFrame.state].toLowerCase()} at{' '}
        <Instant value={source.connectorFrame.receivedAt} />
      </p>
    )}
  </li>
);

const SessionTimeline: React.FC<{ session: TelemetrySessionRow }> = ({ session }) => {
  const { sessionRef, connectorId, sourceProduct } = session;
  const query = useQuery({
    // The cache key is the TRIPLE, for the same reason the route is: two
    // Connectors reporting one product and one source-side session id share a
    // pseudonym, and a cache keyed on the pseudonym alone would serve one
    // session's timeline for the other.
    queryKey: ['telemetry-session', connectorId, sourceProduct, sessionRef],
    queryFn: () => fetchSession({ sessionRef, connectorId, sourceProduct }),
    refetchInterval: TELEMETRY_POLL_MS,
  });

  if (query.isPending) return <p className="telemetry-inline-status">Loading the timeline…</p>;
  if (query.isError) {
    return (
      <p className="telemetry-inline-status telemetry-inline-status--error" role="alert">
        {(query.error as Error).message}
      </p>
    );
  }
  const detail = query.data;
  if (!detail || detail.events.length === 0) {
    return <p className="telemetry-inline-status">This session reported no events inside the window.</p>;
  }

  return (
    <>
      <table className="telemetry-table telemetry-table--timeline">
        <caption className="sr-only">
          Tier-0 event timeline for session {shortSessionRef(sessionRef)}
        </caption>
        <thead>
          <tr>
            <th scope="col">Observed</th>
            <th scope="col">Kind</th>
            <th scope="col">Phase</th>
            <th scope="col">Model</th>
            <th scope="col">Outcome</th>
            <th scope="col" className="telemetry-numeric">In</th>
            <th scope="col" className="telemetry-numeric">Out</th>
            <th scope="col" className="telemetry-numeric">Duration</th>
          </tr>
        </thead>
        <tbody>
          {detail.events.map((event) => (
            <tr key={event.eventId}>
              <td><Instant value={event.observedAt} /></td>
              <td>{event.kind}</td>
              <td>{event.phase ?? '—'}</td>
              <td>{event.modelResolved ?? '—'}</td>
              <td>{event.errorType ?? event.outcomeStatus ?? '—'}</td>
              <td className="telemetry-numeric">
                {event.inputTokens === null ? '—' : formatCount(event.inputTokens)}
              </td>
              <td className="telemetry-numeric">
                {event.outputTokens === null ? '—' : formatCount(event.outputTokens)}
              </td>
              <td className="telemetry-numeric">
                {event.durationMs === null ? '—' : `${formatCount(Math.round(event.durationMs))} ms`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail.truncated && (
        <p className="telemetry-inline-status">
          Showing the most recent events only — this session has more than the timeline limit.
        </p>
      )}
    </>
  );
};

const SessionRow: React.FC<{ session: TelemetrySessionRow }> = ({ session }) => {
  const [open, setOpen] = useState(false);
  // The DOM id carries the whole key too: two rows sharing a pseudonym would
  // otherwise emit duplicate ids, which is both an axe violation and an
  // `aria-controls` that points at the wrong panel.
  const panelId = `telemetry-timeline-${session.connectorId}-${session.sourceProduct}-${session.sessionRef}`;
  return (
    <>
      <tr>
        <td>
          <button
            type="button"
            className="telemetry-disclosure"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            <span className="telemetry-mono">{shortSessionRef(session.sessionRef)}</span>
          </button>
        </td>
        <td>{session.sourceProduct}</td>
        <td>
          <span
            className={`telemetry-chip telemetry-chip--${session.state}`}
            aria-label={`${SESSION_STATE_LABELS[session.state]} — ${SESSION_STATE_HINTS[session.state]}`}
          >
            {SESSION_STATE_LABELS[session.state]}
          </span>
        </td>
        <td><Instant value={session.startedAt} /></td>
        <td><Instant value={session.lastSeenAt} /></td>
        <td>{session.models.length > 0 ? session.models.join(', ') : '—'}</td>
        <td className="telemetry-numeric">{formatCount(session.eventCount)}</td>
        <td className="telemetry-numeric">{formatCount(session.totalTokens)}</td>
      </tr>
      {open && (
        <tr id={panelId} className="telemetry-timeline-row">
          <td colSpan={8}><SessionTimeline session={session} /></td>
        </tr>
      )}
    </>
  );
};

const EMPTY_STATE = (
  <CoreSurfacePlaceholder
    icon={<Radio size={56} aria-hidden="true" />}
    heading="No reporters connected"
    description={
      <>
        Agent sessions appear here when connectors self-report their activity.
        The board never reads harness state, sessions files, or transcripts
        — everything on this page arrives because a reporter chose to send
        it. An empty page means no reporter is installed, not that
        something is broken.
      </>
    }
    sections={[
      {
        title: 'How session reporting works',
        items: [
          <>
            <strong>Outposts</strong> — reporters that run alongside your
            agent runtime — push session events to the board. An outpost
            runs beside the runtime; a plugin installs into the board.
          </>,
          <>
            The board stores only what reporters send. There is no
            board-side polling, file watching, or transcript scraping.
          </>,
          <>
            The typed ingest contract lives at{' '}
            <code>backend/src/types/CanonicalSession.ts</code>; ingest
            health is served at{' '}
            <code>GET /api/sessions/pipeline-health</code>.
          </>,
        ],
      },
      {
        title: 'How to set it up',
        ordered: true,
        items: [
          <>
            Install a reporter outpost next to the agent runtime you
            want to see here.
          </>,
          <>
            Give it a board credential scoped for reporting and point it at
            this board&apos;s API.
          </>,
          <>
            Agent sessions stream in as the reporter sends them — there is
            nothing to configure board-side.
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

export const SessionsPage: React.FC = () => {
  const presenceQuery = useQuery({
    queryKey: ['telemetry-presence'],
    queryFn: fetchPresence,
    refetchInterval: TELEMETRY_POLL_MS,
  });
  const sessionsQuery = useQuery({
    queryKey: ['telemetry-sessions'],
    queryFn: fetchSessions,
    refetchInterval: TELEMETRY_POLL_MS,
  });

  const loading = presenceQuery.isPending || sessionsQuery.isPending;
  const error = (presenceQuery.error ?? sessionsQuery.error) as Error | undefined;
  const sources = presenceQuery.data?.sources ?? [];
  const sessions = sessionsQuery.data?.sessions ?? [];
  const hasData = sources.length > 0 || sessions.length > 0;

  return (
    <div className="sessions-page">
      <div className="sessions-header">
        <h1>
          <Radio size={24} aria-hidden="true" /> Agent sessions
        </h1>
      </div>

      {/* Polling replaces this region in place. `aria-live="polite"` is on the
          status line only, so a refresh announces a change of state rather
          than re-reading the whole table on every poll. */}
      <p className="telemetry-status" aria-live="polite">
        {loading ? 'Loading reported sessions…'
          : error ? 'Sessions could not be read.'
            : hasData ? `${formatCount(sources.length)} reporting source(s), ${formatCount(sessions.length)} session(s).`
              : 'No reported sessions.'}
      </p>

      {error && (
        <div className="telemetry-error" role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <div>
            <strong>Sessions could not be read.</strong>
            <p>{error.message}</p>
          </div>
        </div>
      )}

      {!loading && !error && hasData && (
        <>
          {sources.length > 0 && (
            <section className="telemetry-section" aria-labelledby="telemetry-presence-heading">
              <h2 id="telemetry-presence-heading">Reporting sources</h2>
              <ul className="telemetry-source-list">
                {sources.map((source) => (
                  <PresenceChip key={`${source.connectorId}:${source.sourceProduct}`} source={source} />
                ))}
              </ul>
            </section>
          )}

          {sessions.length > 0 && (
            <section className="telemetry-section" aria-labelledby="telemetry-sessions-heading">
              <h2 id="telemetry-sessions-heading">Sessions</h2>
              <div className="telemetry-table-scroll">
                <table className="telemetry-table">
                  <caption className="sr-only">
                    Reported agent sessions, most recently active first
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Session</th>
                      <th scope="col">Product</th>
                      <th scope="col">State</th>
                      <th scope="col">Started</th>
                      <th scope="col">Last seen</th>
                      <th scope="col">Models</th>
                      <th scope="col" className="telemetry-numeric">Events</th>
                      <th scope="col" className="telemetry-numeric">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((session) => (
                      <SessionRow
                        key={`${session.connectorId}:${session.sourceProduct}:${session.sessionRef}`}
                        session={session}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="telemetry-note">
                Metadata only. Tier&nbsp;0 stores no prompts, responses, or tool
                payloads, so there is nothing on this page to open into a
                transcript.
              </p>
            </section>
          )}
        </>
      )}

      {!loading && !error && !hasData && EMPTY_STATE}
    </div>
  );
};
