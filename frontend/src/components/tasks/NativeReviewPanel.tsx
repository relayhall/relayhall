import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { authenticatedFetch } from '../../utils/auth';
import { Button } from '../Button';
import type { ReviewHistoryEntry } from '../../types/task';

const API=import.meta.env.VITE_API_BASE_URL || '/api';
export interface NativeReview {
  id:string; state:string; serviceId:string; verifierPrincipalId:string; createdAt?:string|null; finishedAt?:string|null;
  reviewScope?:{kind:string;includesTaskCriteria:boolean};
  verdict?:{reportId?:string;result?:{status:string}}|null;
  session:{state:string;sessionRef?:string;connectorId?:string;sourceProduct?:string};
}
async function read(path:string, body?:unknown) {
  const response=await authenticatedFetch(`${API}${path}`,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error || 'Native review unavailable');
  return data;
}
export function nativeSessionPath(session:NativeReview['session']):string|null {
  if(session.state!=='available' || !session.sessionRef || !session.connectorId || !session.sourceProduct) return null;
  return '/sessions?'+new URLSearchParams({sessionRef:session.sessionRef,connectorId:session.connectorId,sourceProduct:session.sourceProduct}).toString();
}
export function useNativeReviews(taskId:string) {
  return useQuery({queryKey:['native-reviews',taskId],queryFn:async()=> (await read(`/tasks/${taskId}/native-reviews`)).result as NativeReview[],refetchInterval:15000});
}

export function latestTaskReviewDecision(legacy:ReviewHistoryEntry[]|undefined, native:NativeReview[]|undefined):string {
  const decisions=[
    ...(legacy || []).map(item=>({at:Date.parse(item.completedAt || item.createdAt), label:item.decision, id:item.id})),
    ...(native || []).filter(item=>item.state==='passed' || item.state==='rejected').map(item=>({
      at:Date.parse(item.finishedAt || ''),
      label:item.state==='passed'?'pass (native verification)':'reject (native verification)',
      id:item.id,
    })),
  ];
  if (!decisions.length) return 'None';
  // A missing timestamp must not hide a known result or be guessed older.
  if (decisions.some(item=>!Number.isFinite(item.at))) return 'Unavailable; decision time missing';
  decisions.sort((a,b)=>b.at-a.at || b.id.localeCompare(a.id));
  return decisions[0].label;
}

export function NativeReviewPanel({taskId,verifierPrincipalId,status}:{taskId:string;verifierPrincipalId?:string|null;status:string}) {
  const cache=useQueryClient(); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  const query=useNativeReviews(taskId);
  const capability=useQuery({queryKey:['native-review-capability',taskId,verifierPrincipalId],enabled:status==='review' && !!verifierPrincipalId,queryFn:async()=>{
    const services=(await read(`/tasks/${taskId}/native-reviews/capabilities`)).result as Array<{id:string;name:string;version:number}>;
    return services.length===1?services[0]:null;
  }});
  async function request() {
    if(!capability.data) return; setBusy(true); setError('');
    try {
      const input=(await read(`/tasks/${taskId}/native-reviews/inputs`)).result;
      await read(`/tasks/${taskId}/native-reviews`,{serviceId:capability.data.id,descriptorVersion:capability.data.version,requestKey:crypto.randomUUID(),expectedInputDigest:input.inputDigest});
      await cache.invalidateQueries({queryKey:['native-reviews',taskId]});
    } catch(value) { setError(value instanceof Error?value.message:'Review request failed; inspect requests before trying again.'); }
    finally {setBusy(false);}
  }
  return <section aria-labelledby="native-review-heading"><h3 id="native-review-heading">Native verification</h3>
    <p>The assigned Verifier reviews this Task without taking the implementation assignment.</p>
    {query.isPending?<p role="status">Loading verification requests…</p>:query.error?<p role="alert">Verification requests could not be read.</p>:query.data?.length?<ul>{query.data.map(review=>{
      const path=nativeSessionPath(review.session);
      return <li key={review.id}>Verification {review.state}. Scope: {review.reviewScope?.kind || 'unavailable'}. {review.verdict?.result && <span>Task status: {review.verdict.result.status}.</span>} {['passed','rejected'].includes(review.state) && !review.verdict && <span> Evidence details restricted.</span>} {path?<Link to={path}>View reported native session</Link>:<span>Session {review.session.state}.</span>}
        {['pending','expired'].includes(review.state) && <Button onClick={()=>void read(`/tasks/${taskId}/native-reviews/${review.id}/cancel`,{inputDigest:(review as NativeReview & {inputDigest:string}).inputDigest}).then(()=>cache.invalidateQueries({queryKey:['native-reviews',taskId]})).catch(()=>setError('Cancellation refused; inspect current request.'))}>Cancel unstarted review</Button>}
        {review.verdict?.reportId && <Link to={`/reports/${review.verdict.reportId}`}>Review evidence</Link>}
      </li>;
    })}</ul>:<p>No native verification requested.</p>}
    {status==='review' && (capability.data?<Button disabled={busy || query.data?.some(item=>['pending','leased','attested','uncertain'].includes(item.state))} onClick={()=>void request()}>Request native verification</Button>:<p>The assigned Verifier has no available native review capability.</p>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
