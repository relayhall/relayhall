import {useEffect,useMemo} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {authenticatedFetch} from '../../utils/auth';
import {useWebSocket} from '../../hooks/useWebSocket';
import {nativeSessionPath} from './NativeReviewPanel';

interface Session {
  state:string;slotId?:string;relationship?:string;sessionRef?:string;connectorId?:string;sourceProduct?:string;expiresAt?:string;
}
interface Execution {
  id:string;runOrdinal:number;state:string;actorPrincipalId:string;outcome:string|null;reportId:string|null;
  reconciliation?:{kind:string;actorPrincipalId:string;stoppedAt:string}|null;
  session:{state:string;sessions?:Session[]};
}
export function NativeExecutionPanel({taskId}:{taskId:string}) {
  const cache=useQueryClient(),{subscribe,connected}=useWebSocket();
  const key=useMemo(()=>['native-executions',taskId],[taskId]);
  const query=useQuery({queryKey:key,refetchInterval:15000,retry:false,queryFn:async({signal})=>{
    const response=await authenticatedFetch(`${import.meta.env.VITE_API_BASE_URL || '/api'}/tasks/${encodeURIComponent(taskId)}/native-executions`,{signal});
    if(!response.ok) throw new Error('Implementation sessions unavailable');
    return (await response.json()).result as {executions:Execution[]};
  }});
  useEffect(()=>{
    const refresh=()=>{void cache.cancelQueries({queryKey:key}).then(()=>cache.resetQueries({queryKey:key}));};
    const stops=['task.updated','task.deleted','task.archived','project.authority_changed'].map(type=>subscribe(type,refresh));
    window.addEventListener('focus',refresh);
    return ()=>{stops.forEach(stop=>stop());window.removeEventListener('focus',refresh);void cache.cancelQueries({queryKey:key});};
  },[cache,key,subscribe]);
  useEffect(()=>{void cache.resetQueries({queryKey:key});},[connected,cache,key]);
  useEffect(()=>{
    const expiry=query.data?.executions.flatMap(row=>row.session.sessions || []).map(session=>Date.parse(session.expiresAt || '')).filter(value=>Number.isFinite(value) && value>Date.now()).sort((a,b)=>a-b)[0];
    if(!expiry) return;
    const timer=window.setTimeout(()=>{void cache.resetQueries({queryKey:key});},Math.min(2147483647,Math.max(1,expiry-Date.now())));
    return ()=>window.clearTimeout(timer);
  },[cache,key,query.data]);
  // Never retain a previously visible triple after a refused/refreshing read.
  const rows=query.isFetching || query.isError?undefined:query.data?.executions;
  return <section aria-labelledby="native-execution-heading"><h3 id="native-execution-heading">Implementation sessions</h3>
    <p>Reported participation in ordinary work. Process completion does not verify or complete the Task.</p>
    {query.isError?<p role="alert">Implementation sessions could not be read.</p>:!rows?<p role="status">Refreshing implementation sessions…</p>:rows.length?<ul>{rows.map(row=><li key={row.id}>
      Run {row.runOrdinal}: {row.state}. Actor {row.actorPrincipalId}. {row.outcome && <span>Process outcome: {row.outcome}.</span>}
      {row.reconciliation && <p>Stopped according to authenticated custody evidence from {row.reconciliation.actorPrincipalId}; no work verdict.</p>}
      {row.session.state==='attested'?<ul>{row.session.sessions?.map((session,index)=>{
        const expired=session.expiresAt && new Date(session.expiresAt)<=new Date();
        const path=expired?null:nativeSessionPath(session);
        return <li key={session.slotId || index}>{session.relationship || 'Session'}: {path?<><Link to={path}>View reported implementation session</Link><span> Session-wide activity may include other runs.</span></>:<span>Session {expired?'expired':session.state}.</span>}</li>;
      })}</ul>:<p>Session {row.session.state}.</p>}
      {row.reportId && <Link to={`/reports/${row.reportId}`}>Implementation result</Link>}
    </li>)}</ul>:<p>No attested implementation runs. Historical activity is not inferred.</p>}
  </section>;
}
