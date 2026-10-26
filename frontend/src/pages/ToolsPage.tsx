import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wrench } from 'lucide-react';
import { authenticatedFetch } from '../utils/auth';
import { RequestStatus } from '../components/RequestStatus';
import './ToolsPage.css';

type Effect = 'session' | 'read' | 'change';
type Tool = {
  name: string; description: string; inputSchema: Record<string, unknown>;
  effect: Effect; requiredScope: string | null;
};
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
// The label is what the tool does (`effect`), not the bootstrap plane it is admitted by:
// some tools admitted as `work` only read.
const effectLabels: Record<Effect, string> = { session: 'Session setup', read: 'Read-only', change: 'Board changes' };
function isTool(value: unknown): value is Tool {
  if (!value || typeof value !== 'object') return false;
  const t = value as Tool;
  return typeof t.name === 'string' && typeof t.description === 'string'
    && Object.keys(effectLabels).includes(t.effect)
    && (t.requiredScope === null || typeof t.requiredScope === 'string')
    && !!t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema);
}
export const ToolsPage: React.FC = () => {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [effect, setEffect] = useState('all');
  const sequence = useRef(0);
  useEffect(() => {
    const request = ++sequence.current;
    const controller = new AbortController();
    setLoading(true); setError(null);
    void (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/tool-catalogue`, { signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 403 ? 'Your session cannot read the tool catalogue.' : 'Could not load the tool catalogue. Please retry.');
        const data = await response.json();
        if (!data.success || !Array.isArray(data.tools) || !data.tools.every(isTool)) throw new Error('The server returned an invalid tool catalogue. Please retry.');
        if (request === sequence.current) setTools(data.tools);
      } catch (e) {
        if (request === sequence.current) setError(e instanceof Error ? e.message : 'Could not load the tool catalogue. Please retry.');
      } finally {
        if (request === sequence.current) setLoading(false);
      }
    })();
    return () => { sequence.current += 1; controller.abort(); };
  }, [attempt]);
  const search = query.trim().toLowerCase();
  const visible = tools.filter(t => (effect === 'all' || t.effect === effect)
    && `${t.name} ${t.description} ${t.requiredScope ?? ''}`.toLowerCase().includes(search));
  return <div className="tools-page">
    <header className="tools-header"><h1><Wrench size={24} aria-hidden="true" /> Tools</h1></header>
    <p>Browse RelayHall’s built-in MCP tools. Connected agents use these operations to work with your board.</p>
    <p>Listing a tool does not grant access. Each call checks the agent’s credential, permissions and target. Instructions for agents are in <Link to="/skills">Skills</Link>.</p>
    <RequestStatus loading={loading} label="Loading tool catalogue…" error={error} onRetry={() => setAttempt(a => a + 1)} />
    {!loading && !error && <>
      <div className="tools-filters">
        <label>Search tools<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, description or permission" /></label>
        <label>Operation type<select value={effect} onChange={e => setEffect(e.target.value)}>
          <option value="all">All operations</option>
          {Object.entries(effectLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
      </div>
      <p role="status">{visible.length} of {tools.length} tools</p>
      {tools.length === 0 ? <p>No built-in tools are advertised by this server.</p>
        : visible.length === 0 ? <p>No tools match your filters. Try another search or operation type.</p>
        : <div className="tools-catalogue">{visible.map(tool => <article key={tool.name} className="tool-card">
          <h2>{tool.name}</h2><span className="tool-plane">{effectLabels[tool.effect]}</span>
          <p className="tool-description">{tool.description}</p>
          <p><strong>Declared permission:</strong> {tool.requiredScope ?? 'Depends on the request; access is checked when called.'}</p>
          <details><summary>Parameters and schema</summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
        </article>)}</div>}
    </>}
  </div>;
};
