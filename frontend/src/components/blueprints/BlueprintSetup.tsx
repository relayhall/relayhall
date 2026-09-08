import { StepUpDialog } from '../access/StepUpDialog';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../Button';
import type { BlueprintSetupPlan, BlueprintSetupResult } from '../../types/blueprint';
import { blueprintError, blueprintJson, blueprintRequest, BlueprintRequestError } from './api';
import { BlueprintData } from './BlueprintPlan';

type Attempt = { key: string; body: string };
/** Assignment is a separately confirmed act. Never derive authority from the
 * staged profile, or send an activation field with this request. */
export function BlueprintSetup({ instantiationId }: { instantiationId: string }) {
  const inputId = useId();
  const [warrantId, setWarrantId] = useState('');
  const [mode,setMode]=useState('existing');
  const [holder,setHolder]=useState('');const [profile,setProfile]=useState('');const [expiresAt,setExpiresAt]=useState('');
  const [profiles,setProfiles]=useState<Array<{id:string;name:string}>>([]);
  const [holders,setHolders]=useState<Array<{id:string;handle:string;kind:string}>>([]);
  const [stepUp,setStepUp]=useState(false);
  useEffect(()=>{if(mode!=='new')return;let live=true;
    blueprintRequest<{profiles:typeof profiles}>('/access-profiles').then(data=>{if(live)setProfiles(data.profiles || []);}).catch(()=>{});
    blueprintRequest<{principals:typeof holders}>('/principals').then(data=>{if(live)setHolders((data.principals || []).filter(row=>row.kind==='service'));}).catch(()=>{});
    return()=>{live=false;};
  },[mode]);
  const [plan, setPlan] = useState<BlueprintSetupPlan | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [result, setResult] = useState<BlueprintSetupResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<BlueprintRequestError | null>(null);
  const generation = useRef(0); const inFlight = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null); const planRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (plan) planRef.current?.focus(); }, [plan]);
  const path = `/instantiations/${encodeURIComponent(instantiationId)}/setup`;
  const preview = async () => {
    if (inFlight.current) return;
    inFlight.current = true; const current = ++generation.current;
    setPending(true); setError(null); setPlan(null); setAttempt(null);
    try {
      const next = await blueprintRequest<{ plan: BlueprintSetupPlan }>(`${path}/preview`, blueprintJson(mode==='existing' ? { warrantId: warrantId.trim() } : {createWarrant:{holderPrincipalId:holder,ceilingProfileId:profile,expiresAt:new Date(expiresAt+'Z').toISOString()}}));
      if (current === generation.current) setPlan(next.plan);
    } catch (failure) { if (current === generation.current) setError(blueprintError(failure)); }
    finally { inFlight.current = false; if (current === generation.current) setPending(false); }
  };
  const apply = async (confirmed: Attempt) => {
    if (inFlight.current) return;
    inFlight.current = true; const current = ++generation.current; setPending(true); setError(null);
    try {
      const next = await blueprintRequest<BlueprintSetupResult>(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': confirmed.key }, body: confirmed.body,
      });
      if (current === generation.current) setResult(next);
    } catch (failure) { if (current === generation.current) setError(blueprintError(failure)); }
    finally { inFlight.current = false; if (current === generation.current) setPending(false); }
  };
  const confirm = (stepUpToken?: string) => {
    if (!plan || attempt || inFlight.current) return;
    try {
      const key = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const next = { key, body: JSON.stringify({ ...(plan.createWarrant ? {createWarrant:{holderPrincipalId:plan.createWarrant.holderPrincipalId,ceilingProfileId:plan.createWarrant.ceilingProfileId,expiresAt:plan.createWarrant.expiresAt},stepUpToken} : {warrantId:plan.warrantId}),
        tasks: plan.tasks.map(task => ({ id: task.id, revision: task.revision })), confirmationHash: plan.confirmationHash }) };
      setAttempt(next); void apply(next);
    } catch { setError(new BlueprintRequestError('A safe retry identifier could not be created.', 'CONFIRMATION_UNAVAILABLE')); }
  };
  const edit = () => { setPlan(null); setAttempt(null); setError(null); };
  return <section className="blueprint-setup" aria-label="Workflow execution setup">
    <h3>Set up workflow</h3>
    <p>The workflow already exists. Assign its displayed Tasks using an existing Warrant, or confirm a new Warrant and its exact access profile assignments. Setup keeps every Task parked and does not enroll later Tasks.</p>
    {error && <div ref={errorRef} className="blueprint-error" role="alert" tabIndex={-1}><strong>{error.code}</strong>: {error.message}{error.field && <p>Field: {error.field}</p>}</div>}
    {result ? <><p role="status">Execution was assigned. No Tasks were armed.</p><BlueprintData value={result} /></> : <>
      {!plan && !attempt && <form onSubmit={event => { event.preventDefault(); void preview(); }}>
        <label>Workflow authority<select value={mode} disabled={pending} onChange={event=>setMode(event.target.value)}><option value="existing">Use an existing Warrant</option><option value="new">Create a Warrant for this workflow</option></select></label>
        {mode==='existing' ? <><label htmlFor={inputId}>Existing Warrant ID</label>
        <input id={inputId} value={warrantId} required disabled={pending} onChange={event => { setWarrantId(event.target.value); setError(null); }} autoComplete="off" spellCheck={false} />
        <p>Use the ID of an existing Warrant that covers these Tasks. The server checks its current authority when you confirm.</p>
        </> : <>
          <label>Workflow Connector or service Account<select required value={holder} onChange={event=>setHolder(event.target.value)}><option value="">Choose a holder</option>{holders.map(row=><option key={row.id} value={row.id}>{row.handle}</option>)}</select></label>
          <label>Published access profile<select required value={profile} onChange={event=>setProfile(event.target.value)}><option value="">Choose a profile</option>{profiles.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          <label>Warrant expiry (UTC)<input type="datetime-local" required value={expiresAt} onChange={event=>setExpiresAt(event.target.value)} /></label>
          <p>The preview checks that you hold every permission this profile delegates.</p>
        </>}
        <Button type="submit" disabled={pending || (mode==='existing' ? !warrantId.trim() : !holder || !profile || !expiresAt)}>{pending ? 'Preparing setup…' : 'Preview execution setup'}</Button>
      </form>}
      {plan && <><h4 ref={planRef} tabIndex={-1}>Confirm this exact Task set</h4>
        {plan.createWarrant ? <><h4>New Warrant</h4><BlueprintData value={plan.createWarrant} /><h4>Access to be assigned</h4><BlueprintData value={plan.grants} /></> : <p>Warrant: {plan.warrantId}</p>}<p>{plan.tasks.length} Tasks. Service profiles and options below are the staged defaults visible to this session.</p>
        <BlueprintData value={plan.tasks} />
        {!attempt && <div className="blueprint-actions"><Button variant="secondary" onClick={edit} disabled={pending}>Change Warrant</Button><Button onClick={()=>plan.requiresStepUp ? setStepUp(true) : confirm()} disabled={pending}>Confirm execution setup</Button></div>}
      </>}
      {attempt && <><p role="status">{pending ? 'Assigning the confirmed Task set…' : 'No successful setup receipt has been received.'}</p>
        {error?.uncertain && <p>Setup may have committed. Retry this exact request to recover its receipt before making another setup plan.</p>}
        <div className="blueprint-actions"><Button onClick={() => void apply(attempt)} disabled={pending}>Retry same setup</Button>
          {!pending && error && !error.uncertain && <Button variant="secondary" onClick={edit}>Preview setup again</Button>}</div>
      </>}
    </>}
    {stepUp && plan?.createWarrant && <StepUpDialog action="warrant.create" targetId={plan.createWarrant.holderPrincipalId}
      description="Confirm the displayed workflow Warrant and access assignments." onCancel={()=>setStepUp(false)}
      onToken={token=>{setStepUp(false);confirm(token);}} />}
  </section>;
}
