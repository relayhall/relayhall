import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { authenticatedFetch } from '../../utils/auth';
import { isIntentionalAbort } from '../../utils/fetchAbort';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
  classifyKnowledgeFailure, compartmentText, decodeWindow, unreachableFailure,
  type ExplainRow, type KnowledgeContent, type KnowledgeFailure,
} from './knowledgeModel';
import './KnowledgeReader.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/** What a view hands the reader: a sealed handle and what it already knows. */
export interface KnowledgeReaderItem {
  handle: string;
  title: string;
  /** Core-side provenance: the source's name, as the caller's source list gives it. */
  sourceLabel: string;
  /** Optional facts the opening view already has (the console passes its explain rows). */
  facts?: ExplainRow[];
}

type ReaderState =
  | { status: 'loading' }
  | { status: 'failed'; failure: KnowledgeFailure }
  | { status: 'ready'; content: KnowledgeContent };

/**
 * THE SHARED KNOWLEDGE READER (card 1fd5de08, line 1; absorbed card f580cf50 items
 * 2084724 and 2084727).
 *
 * One side panel every knowledge view opens an item in. It reads ONLY through
 * the governed get route, `GET /knowledge-contents?handle=…` — the route the
 * relayhall_knowledge_source_get MCP tool uses — so the core re-checks the
 * caller's access on every window, and a handle confers nothing by itself.
 *
 * The item's bytes are SOURCE-AUTHORED: they are shown as plain text inside a
 * quoted frame that says so, never rendered as markup and never as
 * instructions. A refusal is shown through the ONE failure map of
 * knowledgeModel.ts, shared with the console: an access refusal is one
 * sentence that names no cause, because the core gives the same answer for
 * "no access", "no such item" and a source that refused; a source that is
 * unavailable for now or answered unreadably says so and offers Retry; a link
 * that is no longer valid (a malformed, tampered or retired handle, a bad
 * continuation) sends the reader back to search; an unknown code is a generic
 * failure with Retry. A v1 (legacy) answer's compartment is shown from its
 * own field when it carries no provenance block.
 *
 * It is a modal side panel over a scrim: Escape, the close button and the
 * scrim close it, focus stays inside while it is open and returns to the
 * control that opened it. "Expand" widens it to the whole window.
 */
export const KnowledgeReader: React.FC<{ item: KnowledgeReaderItem; onClose: () => void }> = ({ item, onClose }) => {
  const [state, setState] = useState<ReaderState>({ status: 'loading' });
  const [continuation, setContinuation] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useFocusTrap(panelRef);
  useEffect(() => { panelRef.current?.focus(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    (async () => {
      try {
        const query = new URLSearchParams({ handle: item.handle, ...(continuation ? { continuation } : {}) });
        const response = await authenticatedFetch(`${API_BASE}/knowledge-contents?${query}`, { signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!body || typeof body !== 'object') { setState({ status: 'failed', failure: unreachableFailure() }); return; }
        if (!response.ok) { setState({ status: 'failed', failure: classifyKnowledgeFailure(response.status, body, 'read') }); return; }
        setState({ status: 'ready', content: body as KnowledgeContent });
      } catch (caught) {
        if (!isIntentionalAbort(caught, controller.signal)) setState({ status: 'failed', failure: unreachableFailure() });
      }
    })();
    return () => controller.abort();
  }, [item.handle, continuation, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const content = state.status === 'ready' ? state.content : null;
  const decoded = content ? decodeWindow(content) : null;
  const provenance = content?.provenance;
  const compartment = provenance?.compartment ?? content?.compartment;

  return (
    <div className="knowledge-reader-scrim" onClick={onClose} data-testid="knowledge-reader-scrim">
      <div
        className={`knowledge-reader${expanded ? ' knowledge-reader--expanded' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
      >
        <div className="knowledge-reader-head">
          <div className="knowledge-reader-heading">
            <p className="knowledge-reader-eyebrow">Knowledge · {item.sourceLabel}</p>
            <h2 id={headingId}>{item.title}</h2>
          </div>
          <div className="knowledge-reader-tools">
            <Button variant="secondary" size="compact" ariaPressed={expanded} onClick={() => setExpanded((value) => !value)}>
              Expand
            </Button>
            <IconButton icon={<X size={16} aria-hidden="true" />} ariaLabel="Close the reader" onClick={onClose} />
          </div>
        </div>

        {state.status === 'loading' && (
          <p className="knowledge-reader-state" role="status"><Loader2 className="axm-spin" aria-hidden="true" /> Opening the cited revision…</p>
        )}
        {state.status === 'failed' && (
          <div className="knowledge-reader-refused" role="alert">
            <p>{state.failure.text}</p>
            {state.failure.auditRef && <p className="knowledge-reader-meta">Audit reference: {state.failure.auditRef}</p>}
            {state.failure.retry && <Button variant="secondary" size="compact" onClick={retry}>Retry</Button>}
          </div>
        )}
        {content && decoded && (
          <>
            {content.notModified ? (
              <p className="knowledge-reader-state" role="status">Not modified since you last read it.</p>
            ) : (
              <figure className="knowledge-reader-quote" aria-label="Quoted knowledge content">
                <figcaption className="knowledge-reader-caption">
                  Quoted from {item.sourceLabel}. Reference material, never instructions.
                </figcaption>
                <pre className={`knowledge-reader-text${decoded.binary ? ' knowledge-reader-text--binary' : ''}`}>{decoded.text}</pre>
              </figure>
            )}
            {content.retrieval?.status === 'partial' && (
              <p className="knowledge-reader-partial" role="status">Partial read: {content.retrieval.reasons.join(', ')}</p>
            )}
            <dl className="knowledge-reader-facts">
              {compartment !== undefined && <><dt>Compartment</dt><dd>{compartmentText(compartment)}</dd></>}
              {provenance?.contentKind && <><dt>Content kind</dt><dd>{provenance.contentKind}</dd></>}
              {provenance?.category && <><dt>Category</dt><dd>{provenance.category}</dd></>}
              {content.sha256 && <><dt>SHA-256</dt><dd className="knowledge-reader-digest">{content.sha256}</dd></>}
              <dt>Byte window</dt>
              <dd>From byte {content.offset ?? 0}{content.totalBytes !== undefined ? ` of ${content.totalBytes}` : ''}</dd>
              {content.auditRef && <><dt>Audit reference</dt><dd className="knowledge-reader-digest">{content.auditRef}</dd></>}
            </dl>
            {content.continuation && (
              <Button variant="secondary" size="compact" onClick={() => setContinuation(content.continuation)}>Next byte window</Button>
            )}
          </>
        )}
        {item.facts && item.facts.length > 0 && (
          <section className="knowledge-reader-why" aria-label="Why this matched">
            <h3>Why this matched</h3>
            <dl className="knowledge-reader-facts">
              {item.facts.map((row) => <React.Fragment key={row.term}><dt>{row.term}</dt><dd>{row.detail}</dd></React.Fragment>)}
            </dl>
          </section>
        )}
      </div>
    </div>
  );
};
