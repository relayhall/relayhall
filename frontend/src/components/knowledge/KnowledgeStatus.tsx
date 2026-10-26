import { formatDateTime } from '../../utils/dateFormat';
import type { KnowledgeSource } from './knowledgeModel';
import {
  lastTurnText, searchedText, summarizeKnowledgeStatus, type KnowledgeSearchRecord, type SourceStatus,
} from './knowledgeStatus';
import './KnowledgeStatus.css';

/**
 * The figures of the observability direction that this page does NOT show,
 * because they are counted inside the knowledge service and never reach the
 * core. The panel names them so their absence reads as "not available here",
 * never as zero.
 */
export const KNOWLEDGE_STATUS_NOT_SHOWN: readonly string[] = [
  'index and storage size',
  'items and chunks per collection',
  'items by source',
  'ingestion pipeline status',
  'retrieval quality (MRR and Recall@k, with the evaluation date)',
  'content health: broken links, missing front matter, stale items, duplicates and orphans',
  'items over time',
  "the knowledge service's own health checks",
];

interface Props {
  sources: KnowledgeSource[];
  log: KnowledgeSearchRecord[];
  label: (id: string) => string;
}

function SourceFacts({ status }: { status: SourceStatus }) {
  const when = (value: string) => formatDateTime(value, value);
  return <dl className="knowledge-status-facts">
    {status.listed ? <>
      <dt>Kind</dt><dd>{status.inProcess ? "The board's own source" : 'A knowledge Service'}</dd>
      <dt>Protocol</dt><dd>Version {status.protocolVersion}</dd>
      <dt>Categories</dt><dd>{status.categories === null ? 'None declared' : `${status.categories} declared`}</dd>
    </> : <>
      <dt>Listed</dt><dd>No longer among the sources you can search.</dd>
    </>}
    <dt>Searches</dt><dd>{searchedText(status)}</dd>
    {status.last && (status.searched > 0 || status.skipped > 0) && <><dt>Last search</dt><dd>{lastTurnText(status.last)}</dd></>}
    {status.results > 0 && <>
      <dt>Results returned</dt><dd>{status.results}</dd>
      <dt>Newest update</dt><dd>{status.newest ? when(status.newest) : 'No result reported an update time'}</dd>
      {status.oldest && status.oldest !== status.newest && <><dt>Oldest update</dt><dd>{when(status.oldest)}</dd></>}
      {status.undated > 0 && status.newest && <><dt>Without an update time</dt><dd>{status.undated}</dd></>}
    </>}
  </dl>;
}

/**
 * THE KNOWLEDGE STATUS PANEL (card 1fd5de08, line 2; absorbed card f580cf50
 * items 2084722 and 2084726, the statistics half of 0c8c50bf, owner direction
 * E124).
 *
 * Scoped observability from what the core already returned to this caller:
 * the sources they may search, and how each answered their searches on this
 * page (answered in full or in part, timed out, unavailable, refused, not
 * searched), with the update times of the results they were shown. Every
 * figure is the caller's own; there is no request of its own and nothing is
 * stored. The statistics counted inside the knowledge service are named as
 * not shown here rather than estimated.
 */
export function KnowledgeStatus({ sources, log, label }: Props) {
  const summary = summarizeKnowledgeStatus(sources, log, label);
  const noAnswer = summary.emptyAnswers + summary.failedSearches;
  return <section className="knowledge-status" aria-labelledby="knowledge-status-heading">
    <h2 id="knowledge-status-heading">Source status</h2>
    <p className="knowledge-status-intro">How the sources you may search answered your searches on this page since you opened it.
      It is made only from what the core already returned to you: nothing is requested for it, nothing is stored, and nothing
      is counted from sources you cannot read. Reloading the page starts it again.</p>
    <dl className="knowledge-status-totals">
      <div className="knowledge-status-total"><dt>Sources you can search</dt><dd>{summary.sourcesListed}</dd></div>
      <div className="knowledge-status-total"><dt>Searches on this page</dt><dd>{summary.searches}</dd></div>
      <div className="knowledge-status-total"><dt>Complete answers</dt><dd>{summary.completeAnswers}</dd></div>
      <div className="knowledge-status-total"><dt>Partial answers</dt><dd>{summary.partialAnswers}</dd></div>
      <div className="knowledge-status-total"><dt>Searches with no answer</dt><dd>{noAnswer}</dd></div>
      <div className="knowledge-status-total"><dt>Results shown</dt><dd>{summary.resultsShown}</dd></div>
    </dl>
    {summary.failedSearches > 0 && <p className="knowledge-status-note">{summary.failedSearches === 1
      ? '1 search was refused or could not be answered at all; it is counted under no answer.'
      : `${summary.failedSearches} searches were refused or could not be answered at all; they are counted under no answer.`}</p>}
    <ul className="knowledge-status-sources">
      {summary.sources.map((status) => <li className="knowledge-status-source" key={status.id}>
        <h3>{status.label}</h3>
        <SourceFacts status={status} />
      </li>)}
    </ul>
    <div className="knowledge-status-elsewhere">
      <h3>Not shown here</h3>
      <p>These figures are counted inside the knowledge service and never reach the core, so this page neither shows nor
        estimates them:</p>
      <ul>{KNOWLEDGE_STATUS_NOT_SHOWN.map((item) => <li key={item}>{item}</li>)}</ul>
      <p>They are planned for the knowledge service&apos;s own admin pages, counted only over what you may read.</p>
    </div>
  </section>;
}
