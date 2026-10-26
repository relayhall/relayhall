import React, { useEffect, useState } from 'react';
import { Button } from '../Button';
import { StepUpDialog } from '../access/StepUpDialog';
import { useStepUpRetry } from '../access/useStepUpRetry';
import { sendWithStepUpRetry } from '../../utils/stepUpChallenge';
import { ScopeNarrowing } from './ScopeNarrowing';
import { authenticatedFetch } from '../../utils/auth';
import type { ConnectionCredential } from '../../types/connections';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
export const EDIT_PERMISSIONS_COPY = 'Edit this credential in place. Narrowing applies immediately; widening needs confirmation. Its secret, identifier and history stay the same.';

export const CredentialPermissionsEditor: React.FC<{
  credential: ConnectionCredential; delegableScopes: string[] | null | undefined;
  mayLoosenTransport: boolean;
  onChanged: () => void;
  onLockedChange?: (locked: boolean) => void;
}> = ({ credential, delegableScopes, mayLoosenTransport, onChanged, onLockedChange }) => {
  const [selected, setSelected] = useState(credential.scopes);
  const [transport, setTransport] = useState(credential.transport);
  const [narrowAgents, setNarrowAgents] = useState(false);
  const [lifetime, setLifetime] = useState('keep');
  const [revertAt, setRevertAt] = useState('');
  const [taskId, setTaskId] = useState('');
  const [pending, setPending] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { askForToken, retryDialog } = useStepUpRetry();
  useEffect(() => { onLockedChange?.(pending || stepUp); }, [pending, stepUp, onLockedChange]);
  useEffect(() => () => onLockedChange?.(false), [onLockedChange]);
  useEffect(() => { setSelected(credential.scopes); setTransport(credential.transport); }, [credential, mayLoosenTransport]);
  const available = Array.isArray(delegableScopes) ? delegableScopes.filter(s => s !== 'root') : [];
  const transportLoosens = transport !== credential.transport && credential.transport !== 'any';
  const widening = selected.some(s => !credential.scopes.includes(s))
    || transportLoosens;
  const changed = transport !== credential.transport || selected.length !== credential.scopes.length
    || selected.some(s => !credential.scopes.includes(s));
  const save = async (stepUpToken?: string) => {
    setStepUp(false); setPending(true); setError(null); setNotice(null);
    try {
      const send = (token: string | undefined) => authenticatedFetch(`${API_BASE}/credentials/${credential.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes: selected, transport,
          ...(widening ? { stepUpToken: token, lifetime: lifetime === 'keep' ? { choice: 'keep' }
            : { choice: 'until-task', ...(taskId ? { taskId } : {}), ...(revertAt ? { revertAt: new Date(revertAt).toISOString() } : {}) } }
            : { narrowAgents }),
        }),
      });
      // Card 72b8fb97 (SU-33): a widening whose token no longer counts when
      // it arrives is answered with the step-up challenge for this very
      // credential; the person confirms once more and the SAME edit is sent
      // ONE more time. A narrowing carries no token and is never retried.
      const sent = widening && stepUpToken
        ? await sendWithStepUpRetry(send, stepUpToken, { action: 'credential.edit', targetId: credential.id }, askForToken)
        : await (async () => { const response = await send(undefined); return { response, body: await response.json().catch(() => null) }; })();
      const response = sent.response;
      const data = (sent.body ?? {}) as { success?: boolean; code?: string; message?: string };
      if (!response.ok || data.success !== true) {
        setError(['EXCEEDS_ACCOUNT_AUTHORITY', 'EXCEEDS_CONNECTOR_OWN', 'ISSUE_EXCEEDS_SESSION'].includes(data.code ?? '')
          ? `${data.code}: ${data.message || 'The owner’s current authority caps this credential. Nothing was saved or filed.'}`
          : data.message || 'The board refused the permissions edit.');
        return;
      }
      setNotice('Permissions saved on the existing credential.'); onChanged();
    } catch { setError('Could not save permissions. Try again.'); }
    finally { setPending(false); }
  };
  return <div className="conn-permissions-editor">
    <p className="conn-note">{EDIT_PERMISSIONS_COPY}</p>
    {error && <p role="alert" className="conn-error">{error}</p>}
    {notice && <p role="status" className="conn-notice">{notice}</p>}
    {Array.isArray(delegableScopes) ? <ScopeNarrowing available={available} selected={selected}
      onChange={setSelected} readOnly={pending || stepUp} idPrefix={`edit-${credential.id}`} />
      : <p role="status" className="conn-note">The board did not disclose delegable scopes. Permissions editing is unavailable.</p>}
    {credential.scopes.some(s => !available.includes(s)) && <p className="conn-note">Current scopes outside this session’s delegable set: {credential.scopes.filter(s => !available.includes(s)).join(', ')}. Clear the selection to remove them.</p>}
    <label>Transport <select aria-label="Credential transport" value={transport} disabled={pending || stepUp}
      onChange={e => setTransport(e.target.value)}>
        {(mayLoosenTransport || credential.transport === 'any') && <option value="any">MCP and API</option>}
        {(mayLoosenTransport || credential.transport === 'any' || credential.transport === 'mcp') && <option value="mcp">MCP only</option>}
        {(mayLoosenTransport || credential.transport === 'any' || credential.transport === 'api') && <option value="api">API only</option>}
      </select></label>
    {widening ? <div>
      <label>Widening lifetime <select aria-label="Widening lifetime" value={lifetime} onChange={e => setLifetime(e.target.value)} disabled={pending || stepUp}>
        <option value="keep">Keep (until narrowed)</option><option value="until-task">Until this task ends or a date</option></select></label>
      {lifetime !== 'keep' && <><label>Related task <input aria-label="Related task" value={taskId} disabled={pending || stepUp} onChange={e => setTaskId(e.target.value)} /></label>
        <label>Revert date <input aria-label="Revert date" type="datetime-local" value={revertAt} disabled={pending || stepUp} onChange={e => setRevertAt(e.target.value)} /></label></>}
    </div> : <label><input type="checkbox" checked={narrowAgents} disabled={pending || stepUp} onChange={e => setNarrowAgents(e.target.checked)} /> Also narrow all live agents beneath this connection</label>}
    <Button disabled={!changed || !Array.isArray(delegableScopes) || pending || stepUp || credential.state !== 'live' || (transportLoosens && !mayLoosenTransport) || (widening && lifetime !== 'keep' && !taskId && !revertAt)}
      onClick={() => widening ? setStepUp(true) : void save()}>{pending ? 'Saving…' : 'Save permissions'}</Button>
    {stepUp && <StepUpDialog action="credential.edit" targetId={credential.id} description="Confirm widening this connection’s permissions." onToken={token => void save(token)} onCancel={() => setStepUp(false)} />}
    {retryDialog}
  </div>;
};
