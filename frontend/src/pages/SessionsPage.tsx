/**
 * SessionsPage — always-on core surface (F11), now with the TW1c projection.
 *
 * The board holds no connection into any agent runtime: it never scrapes
 * harness state, sessions files, or transcripts. Session activity appears
 * here when reporter outposts self-report it through the typed ingest
 * contract, and — since card `35b73092` — when a Connector that declared a
 * telemetry tier works through the board's own MCP server: the board then
 * records that Connector's session from the tool calls it received, under
 * the product `mcp`. With neither, the page renders its documented empty
 * state — the zero-config default, not an error.
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
 *
 * THE MCP ACTION LOG (card `ab8f78e9`, owner ruling E91). An `mcp` session's
 * expanded timeline also lists the tool calls the board's MCP server received
 * inside it — tool, target, outcome, duration, time; never arguments — with an
 * honest empty state and the plain statement that REST and CLI calls are not
 * shown. It rides the session's own point read, so it adds no visibility.
 *
 * SHORT SESSIONS, THE FILTER AND PAGING (card `0ac41d40`, owner ruling E89
 * (b)). The server hides SHORT sessions — at most three events, under two
 * minutes, no model and no tokens — before its row limit and says how many it
 * hid; "Show N short sessions" asks for them. A Reporter and a Product select
 * narrow the list on the server, and "Load more" asks for the next page.
 *
 * THE POLL REFRESHES THE LOADED WINDOW. Every 20 s the infinite query re-reads
 * EVERY page it has loaded, in order from the first, each next offset taken
 * from the page just re-read — so the page keeps showing the newest
 * (pages × 50) rows under the CURRENT filter and toggle, the number of loaded
 * pages is kept (fewer only when the list itself shrank), and rows are
 * de-duplicated by their triple. The filter, the toggle and every open
 * timeline are the reader's own state: a poll never writes them. Only the
 * reader changing the filter or the toggle starts again from the first page.
 */
import React, { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, Radio } from 'lucide-react';
import { Button } from '../components/Button';
import { CoreSurfacePlaceholder } from '../components/CoreSurfacePlaceholder';
import { formatDateTime } from '../utils/dateFormat';
import {
  MCP_ACTION_LOG_PRODUCT,
  PRESENCE_LABELS,
  SESSIONS_WINDOW_DAYS,
  SESSION_STATE_HINTS,
  SESSION_STATE_LABELS,
  TELEMETRY_POLL_MS,
  describeActionOutcome,
  describeShortSession,
  fetchPresence,
  fetchSession,
  fetchSessions,
  formatCount,
  reporterName,
  shortSessionRef,
  type TelemetryPresenceRow,
  type TelemetrySessionAction,
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
      <div><dt>Reporter</dt><dd>{reporterName(source)}</dd></div>
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

/**
 * The MCP ACTION LOG of one session (card `ab8f78e9`, owner ruling E91): each
 * tool call the board's MCP server received inside the session — tool, the
 * object it named, outcome, duration, time — and never its arguments. It
 * arrives with the session's own detail read, so it is visible to exactly the
 * readers of the session and to nobody else.
 */
const SessionActions: React.FC<{
  sessionRef: string;
  actions: TelemetrySessionAction[];
  truncated: boolean;
}> = ({ sessionRef, actions, truncated }) => (
  <section className="telemetry-section" aria-label={`MCP tool calls in session ${shortSessionRef(sessionRef)}`}>
    <h3>MCP tool calls</h3>
    {actions.length === 0 ? (
      <p className="telemetry-inline-status">
        No MCP tool calls are recorded for this session. Calls are recorded from the
        first call after this log was introduced, and only inside a live session.
      </p>
    ) : (
      <table className="telemetry-table telemetry-table--timeline">
        <caption className="sr-only">
          MCP tool calls in session {shortSessionRef(sessionRef)}, most recent first
        </caption>
        <thead>
          <tr>
            <th scope="col">Observed</th>
            <th scope="col">Tool</th>
            <th scope="col">Target</th>
            <th scope="col">Outcome</th>
            <th scope="col" className="telemetry-numeric">Duration</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action, index) => (
            <tr key={`${action.observedAt}:${action.toolName}:${index}`}>
              <td><Instant value={action.observedAt} /></td>
              <td><span className="telemetry-mono">{action.toolName}</span></td>
              <td>
                {action.targetType && action.targetId
                  ? <>{action.targetType} <span className="telemetry-mono">{action.targetId}</span></>
                  : '—'}
              </td>
              <td>{describeActionOutcome(action)}</td>
              <td className="telemetry-numeric">{`${formatCount(action.durationMs)} ms`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
    {truncated && (
      <p className="telemetry-inline-status">
        Showing the most recent tool calls only — this session has more than the timeline limit.
      </p>
    )}
    <p className="telemetry-note">
      MCP only: calls made over the REST API or the CLI are not shown here. Tool
      arguments are never recorded.
    </p>
  </section>
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
  const actionLog = sourceProduct === MCP_ACTION_LOG_PRODUCT && detail ? (
    <SessionActions
      sessionRef={sessionRef}
      actions={detail.actions ?? []}
      truncated={detail.actionsTruncated === true}
    />
  ) : null;
  if (!detail || detail.events.length === 0) {
    return (
      <>
        <p className="telemetry-inline-status">This session reported no events inside the window.</p>
        {actionLog}
      </>
    );
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
      {actionLog}
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
        <td>{reporterName(session)}</td>
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
          <td colSpan={9}><SessionTimeline session={session} /></td>
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
        Agent sessions appear here when connectors self-report their activity,
        or when a connector that declared a telemetry tier works through this
        board&apos;s MCP server — the board then records that session from the
        tool calls it received. The board never reads harness state, sessions
        files, or transcripts. An empty page means neither has happened yet,
        not that something is broken.
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
            A connector whose descriptor declares a telemetry tier and that
            works through this board&apos;s MCP server appears here as an{' '}
            <code>mcp</code> source, recorded from the tool calls the board
            itself received — nothing else about its runtime is read.
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

const LinkedSession: React.FC<{sessionRef:string;connectorId:string;sourceProduct:string}> = key => {
  const query=useQuery({queryKey:['telemetry-session',key.connectorId,key.sourceProduct,key.sessionRef],queryFn:()=>fetchSession(key),refetchInterval:TELEMETRY_POLL_MS});
  if(query.isPending) return <p role="status">Loading linked native session…</p>;
  if(query.error || !query.data) return <p role="alert">Linked native session is restricted, expired or unavailable.</p>;
  return <section aria-label="Linked native session"><h2>Linked native session</h2><p>{key.sourceProduct} · {key.connectorId} · {key.sessionRef}</p><SessionTimeline session={query.data.session}/></section>;
};
/** A session's identity, as the React key, the cache key and the route use it. */
const sessionIdentity = (row: { connectorId: string; sourceProduct: string; sessionRef: string }): string =>
  `${row.connectorId}:${row.sourceProduct}:${row.sessionRef}`;

/**
 * The choices the Reporter and Product selects offer: every reporter and
 * product the presence projection names, plus the CURRENT choice even when a
 * poll no longer names it — a select whose value vanished from its options
 * would silently show "All" while the list stayed filtered.
 */
function filterChoices(
  sources: TelemetryPresenceRow[],
  connectorId: string,
  sourceProduct: string,
  knownNames: Map<string, string>,
): { reporters: Array<{ id: string; name: string }>; products: string[] } {
  const reporters = new Map<string, string>();
  for (const source of sources) reporters.set(source.connectorId, reporterName(source));
  if (connectorId && !reporters.has(connectorId)) {
    reporters.set(connectorId, knownNames.get(connectorId) ?? connectorId);
  }
  const products = new Set(sources.map((source) => source.sourceProduct));
  if (sourceProduct) products.add(sourceProduct);
  return {
    reporters: [...reporters.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    products: [...products].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * The URL parameters of a deep link to ONE session (`?sessionRef&connectorId&sourceProduct`):
 * the Action Center drops them when another tab is chosen (owner ruling E453).
 */
export const SESSION_LINK_PARAMS = ['sessionRef', 'connectorId', 'sourceProduct'] as const;

/**
 * The reported agent sessions. Since owner ruling E453 this is the Action
 * Center's Agent sessions tab (`embedded`): the page's own heading gives way to
 * the tab's panel heading, and `/sessions` is an alias of that tab.
 */
export const SessionsPage: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const [params]=useSearchParams();
  const linked={sessionRef:params.get('sessionRef')||'',connectorId:params.get('connectorId')||'',sourceProduct:params.get('sourceProduct')||''};
  const hasLinked=Object.values(linked).some(Boolean);
  const validLinked=/^rhp_[A-Za-z0-9_-]+$/.test(linked.sessionRef) && /^[0-9a-f-]{36}$/i.test(linked.connectorId) && /^[a-z][a-z0-9._-]{0,63}$/.test(linked.sourceProduct);
  // The reader's own choices. Never written by a poll, and NOT kept in the URL:
  // `connectorId` and `sourceProduct` there are the deep link to ONE session.
  const [connectorId, setConnectorId] = useState('');
  const [sourceProduct, setSourceProduct] = useState('');
  const [includeShort, setIncludeShort] = useState(false);
  // The last name each reporter was shown under, so a choice a poll no longer
  // names keeps its name in the select.
  const knownNames = useRef(new Map<string, string>());
  const presenceQuery = useQuery({
    queryKey: ['telemetry-presence'],
    queryFn: fetchPresence,
    refetchInterval: TELEMETRY_POLL_MS,
  });
  const sessionsQuery = useInfiniteQuery({
    // The filter and the toggle are part of the key, so changing either starts
    // a new list at its first page; a poll refetches the pages of THIS key.
    queryKey: ['telemetry-sessions', connectorId, sourceProduct, includeShort],
    queryFn: ({ pageParam }) => fetchSessions({
      offset: pageParam,
      includeShort,
      connectorId: connectorId || undefined,
      sourceProduct: sourceProduct || undefined,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    refetchInterval: TELEMETRY_POLL_MS,
    // While a new filter's first page loads, the previous rows stay on screen
    // (marked busy) rather than the controls unmounting under the reader.
    placeholderData: keepPreviousData,
  });

  const loading = presenceQuery.isPending || sessionsQuery.isPending;
  const error = (presenceQuery.error ?? sessionsQuery.error) as Error | undefined;
  const sources = presenceQuery.data?.sources ?? [];
  for (const source of sources) knownNames.current.set(source.connectorId, reporterName(source));
  const pages = sessionsQuery.data?.pages ?? [];
  // Every count describes the WHOLE filtered list, and the first page of a
  // refresh is the freshest statement of it.
  const firstPage = pages[0];
  const hiddenCount = firstPage?.hiddenCount ?? 0;
  const shortCount = firstPage?.shortCount ?? 0;
  const total = firstPage?.total ?? 0;
  const shortRule = firstPage?.shortSession ?? null;
  // One row per triple: a row that moved between two pages while they were
  // re-read is shown once, at its first place.
  const seen = new Set<string>();
  const sessions = pages.flatMap((page) => page.sessions).filter((session) => {
    const identity = sessionIdentity(session);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  const filtered = connectorId !== '' || sourceProduct !== '';
  const showToggle = shortCount > 0 || includeShort;
  const showSessions = total > 0 || shortCount > 0 || filtered || includeShort;
  const hasData = sources.length > 0 || showSessions;
  const choices = filterChoices(sources, connectorId, sourceProduct, knownNames.current);
  const days = `${formatCount(SESSIONS_WINDOW_DAYS)} days`;
  const shortLabel = `Show ${formatCount(shortCount)} short ${shortCount === 1 ? 'session' : 'sessions'}`;

  const status = `${formatCount(sources.length)} reporting source(s); showing ${formatCount(sessions.length)} of `
    + `${formatCount(total)} session(s) in the last ${days}`
    + (hiddenCount > 0 ? `; ${formatCount(hiddenCount)} short session(s) hidden.` : '.');

  return (
    <div className={embedded ? 'notifications-page-panel' : 'sessions-page'}>
      {hasLinked && (validLinked?<LinkedSession {...linked}/>:<p role="alert">A native session link requires its full Connector, product and session identity.</p>)}
      {embedded ? (
        <div className="notifications-page-toolbar">
          <h2>Agent sessions</h2>
        </div>
      ) : (
        <div className="sessions-header">
          <h1>
            <Radio size={24} aria-hidden="true" /> Agent sessions
          </h1>
        </div>
      )}

      {/* Polling replaces this region in place. `aria-live="polite"` is on the
          status line only, so a refresh announces a change of state rather
          than re-reading the whole table on every poll. */}
      <p className="telemetry-status" aria-live="polite">
        {loading ? 'Loading reported sessions…'
          : error ? 'Sessions could not be read.'
            : hasData ? status
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

          {showSessions && (
            <section
              className="telemetry-section"
              aria-labelledby="telemetry-sessions-heading"
              aria-busy={sessionsQuery.isPlaceholderData}
            >
              <h2 id="telemetry-sessions-heading">Sessions</h2>
              <div className="telemetry-session-controls">
                <div className="form-group telemetry-session-filter">
                  <label htmlFor="telemetry-filter-reporter">Reporter</label>
                  <select
                    id="telemetry-filter-reporter"
                    className="form-select"
                    value={connectorId}
                    onChange={(event) => setConnectorId(event.target.value)}
                  >
                    <option value="">All reporters</option>
                    {choices.reporters.map((reporter) => (
                      <option key={reporter.id} value={reporter.id}>{reporter.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group telemetry-session-filter">
                  <label htmlFor="telemetry-filter-product">Product</label>
                  <select
                    id="telemetry-filter-product"
                    className="form-select"
                    value={sourceProduct}
                    onChange={(event) => setSourceProduct(event.target.value)}
                  >
                    <option value="">All products</option>
                    {choices.products.map((product) => (
                      <option key={product} value={product}>{product}</option>
                    ))}
                  </select>
                </div>
                {showToggle && (
                  <Button
                    variant="secondary"
                    size="compact"
                    ariaPressed={includeShort}
                    ariaDescribedBy={shortRule ? 'telemetry-short-definition' : undefined}
                    onClick={() => setIncludeShort((was) => !was)}
                  >
                    {shortLabel}
                  </Button>
                )}
              </div>
              {showToggle && shortRule && (
                <p id="telemetry-short-definition" className="telemetry-note">
                  Short means {describeShortSession(shortRule)} — typically a connector that opened a
                  session and did nothing else. Short sessions are hidden unless shown here; Stats
                  still count them.
                </p>
              )}

              {sessions.length > 0 ? (
                <div className="telemetry-table-scroll">
                  <table className="telemetry-table">
                    <caption className="sr-only">
                      Reported agent sessions, most recently active first
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Session</th>
                        <th scope="col">Product</th>
                        <th scope="col">Reporter</th>
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
                        <SessionRow key={sessionIdentity(session)} session={session} />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="telemetry-inline-status">
                  {hiddenCount > 0
                    ? `Every session ${filtered ? 'that matches this reporter and product ' : ''}in the last ${days} is short. `
                      + `Use “${shortLabel}” to list ${hiddenCount === 1 ? 'it' : 'them'}.`
                    : filtered
                      ? `No sessions match this reporter and product in the last ${days}.`
                      : `No sessions in the last ${days}.`}
                </p>
              )}

              {sessionsQuery.hasNextPage && (
                <div className="telemetry-load-more">
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={sessionsQuery.isFetchingNextPage}
                    onClick={() => { void sessionsQuery.fetchNextPage(); }}
                  >
                    {sessionsQuery.isFetchingNextPage
                      ? 'Loading more…'
                      : `Load more sessions (${formatCount(Math.max(total - sessions.length, 0))} more)`}
                  </Button>
                </div>
              )}
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
