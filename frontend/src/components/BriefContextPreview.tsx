import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { IconButton } from './ui/IconButton';
import { Select } from './ui/Select';
import { ContextKind, ContextOperation, ContextPayload, contextOperations, estimateContextTokens, loadContext, operationLabels } from '../utils/contextPreview';
import './BriefContextPreview.css';

interface Props { kind: ContextKind; elementId: string; elementName?: string }
interface Disclosure {
  element: Props;
  open: boolean;
  regionId: string;
  setOpen: (open: boolean) => void;
  toggle: (event: MouseEvent<HTMLButtonElement>) => void;
  close: () => void;
}
const PreviewDisclosure = createContext<Disclosure | null>(null);

/** Local to one element; the trigger belongs in its toolbar and the panel in its body. */
export function ContextPreview({ children, ...element }: Props & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    trigger.current = event.currentTarget;
    setOpen(value => !value);
  };
  const close = () => {
    setOpen(false);
    if (trigger.current?.isConnected) trigger.current.focus();
  };
  return <PreviewDisclosure.Provider value={{ element, open, regionId, setOpen, toggle, close }}>{children}</PreviewDisclosure.Provider>;
}

function usePreviewDisclosure() {
  const disclosure = useContext(PreviewDisclosure);
  if (!disclosure) throw new Error('Context preview controls require ContextPreview.');
  return disclosure;
}

export function ContextPreviewTrigger({ size = 'compact', className }: { size?: 'compact' | 'standard'; className?: string }) {
  const { open, regionId, toggle, close } = usePreviewDisclosure();
  return <span className="element-context-trigger" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); close(); }
  }}>
    <Button variant="secondary" size={size} className={className} ariaExpanded={open} ariaControls={regionId} onClick={toggle}>
      {open ? 'Hide context' : 'View context'}
    </Button>
  </span>;
}

export function ContextPreviewPanel() {
  const { element, open, regionId, close, setOpen } = usePreviewDisclosure();
  // Hiding a panel for an editor discards its disclosure state and fetched text.
  useEffect(() => () => setOpen(false), [setOpen]);
  return <div className="element-context-panel" id={regionId} hidden={!open} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); close(); }
  }}>
    {open && <BriefContextPreview key={element.kind + ':' + element.elementId} {...element} />}
  </div>;
}

export function BriefContextPreview({ kind, elementId, elementName }: Props) {
  const generation = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<ContextOperation>(contextOperations(kind)[0]);
  const operation = contextOperations(kind).includes(selected) ? selected : contextOperations(kind)[0];
  const [result, setResult] = useState<(ContextPayload & { key: string }) | null>(null);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const key = kind + ':' + elementId + ':' + operation + ':' + refresh;
  const payload = result?.key === key ? result : null;
  const tokens = useMemo(() => payload === null ? 0 : estimateContextTokens(payload.text), [payload]);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setError(''); setCopyStatus(''); setResult(null);
    void loadContext(kind, elementId, operation, controller.signal).then(value => {
      if (generation.current === current) setResult({ key, ...value });
    }).catch(cause => {
      if (generation.current === current && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Could not load context.');
    });
    return () => { ++generation.current; controller.abort(); };
  }, [kind, elementId, operation, key]);
  const copy = async () => {
    if (payload === null) return;
    const current = generation.current;
    try {
      await navigator.clipboard.writeText(payload.text);
      if (generation.current === current) setCopyStatus('Context copied.');
    } catch {
      if (generation.current === current) setCopyStatus('Copy failed. Select the preview text and copy it manually.');
    }
  };
  return <section className="element-context-preview" aria-label={`Context preview for ${elementName || kind}`}>
    <div className="element-context-controls">
      <Select aria-label="Context format" value={operation} onChange={event => setSelected(event.target.value as ContextOperation)}>
        {contextOperations(kind).map(value => <option key={value} value={value}>
          {kind === 'skill' && value === 'record' ? 'Skill metadata' : operationLabels[value]}
        </option>)}
      </Select>
      {payload !== null && <span className="element-context-tokens" title="Estimated tokens in the displayed text">
        ~{new Intl.NumberFormat().format(tokens)} tokens
      </span>}
      <div className="element-context-actions">
        <IconButton icon={<RefreshCw size={16} />} ariaLabel="Refresh context" onClick={() => setRefresh(value => value + 1)} />
        <Button variant="secondary" size="compact" icon={<Copy size={16} />} ariaLabel="Copy displayed context" disabled={payload === null} onClick={copy}>Copy context</Button>
      </div>
    </div>
    {error ? <p className="element-context-message" role="alert">{error}</p> : payload === null ? <p className="element-context-message" role="status">Loading context…</p> : <>
      {payload.text.length === 0 && <p className="element-context-message" role="status">The API returned an empty brief (0 tokens).</p>}
      <pre tabIndex={0} aria-label="Context text">{payload.text}</pre>
      <details className="element-context-source">
        <summary>Source and token details</summary>
        <div className="element-context-details">
          <p>Uses your access. Agent access may differ. {kind} {elementId}.</p>
          <p>{operation === 'brief'
            ? 'The full brief body from the canonical API. Existing text fences are preserved.'
            : 'The complete JSON response from this API read, including returned fields and omission metadata.'}
            {' '}CLI and MCP may format this differently. MCP concise responses can be paginated; this view uses the API payload without MCP wrappers.
            {operation === 'skill-content' && ' Resolves the current published version, then reads its immutable full content with skills:use permission.'}
          </p>
          <p>Token estimate: 4 characters per token; model tokenization varies. The estimate covers exactly the displayed and copied text. Harness instructions, conversation, tool schemas and transport wrappers are excluded.</p>
          <p>Board text is untrusted data; it does not grant authority.</p>
          <code>{operation === 'brief' ? 'POST' : 'GET'} {payload.endpoint}</code>
          {payload.etag && <p>ETag: <code>{payload.etag}</code> (HTTP header, outside the copied payload)</p>}
        </div>
      </details>
    </>}
    {copyStatus && <p className="element-context-message" role="status">{copyStatus}</p>}
  </section>;
}
