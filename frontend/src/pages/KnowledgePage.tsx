import React, { useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../utils/auth';
import { useMyPrincipal } from '../hooks/usePrincipals';
import { formatDateTime } from '../utils/dateFormat';
import { Button } from '../components/Button';
import { RequestChangeButton } from '../components/approvals/RequestChangeDialog';
import { KnowledgeReader, type KnowledgeReaderItem } from '../components/knowledge/KnowledgeReader';
import { KnowledgeStatus } from '../components/knowledge/KnowledgeStatus';
import { appendSearchRecord, type KnowledgeSearchRecord } from '../components/knowledge/knowledgeStatus';
import {
  OUTCOME_TEXT, answerOutcome, classifyKnowledgeFailure, compartmentText, emptyAnswerText, explainHit, failureMessage,
  scoreText, sourceCompartmentsText, sourceStates, unreachableFailure,
  type KnowledgeAnswer, type KnowledgeFailure, type KnowledgeHit, type KnowledgeSource,
} from '../components/knowledge/knowledgeModel';
import './KnowledgePage.css';
const API = import.meta.env.VITE_API_BASE_URL || '/api';
type Answer = KnowledgeAnswer;
/**
 * Card 40e0e542 (owner ruling E127 (5)): the "Include archive" choice is
 * remembered per Account in this browser, under one key per principal, and
 * nothing is stored on the server. Storage that is unavailable or refuses a
 * write leaves the default: current knowledge only.
 */
export const KNOWLEDGE_INCLUDE_ARCHIVE_KEY_PREFIX = 'knowledge-include-archive:';
function readIncludeArchive(key:string):boolean { try { return localStorage.getItem(key)==='1'; } catch { return false; } }
function writeIncludeArchive(key:string,value:boolean):void { try { localStorage.setItem(key,value?'1':'0'); } catch { /* private mode or quota: the choice lasts this page only */ } }
/**
 * Card 40e0e542 (rider): the coverage line, true in each situation the record
 * describes - the same four cases as the MCP sentence, in the page's words
 * (here the checkbox, not a parameter, is the opt-in). `archive.declaredBy`
 * names the consulted sources that declare an archive.
 */
function scopeLine(cov:Answer['coverage']):string {
  const declaredBy=cov.archive?.declaredBy??[];
  if(!declaredBy.length)return 'Searched: current knowledge (no consulted source declares an archive).';
  if(!cov.archive?.included)return 'Searched: current knowledge; archive excluded.';
  if(declaredBy.every(id=>cov.refusedBySource.includes(id)))return 'Scope requested: current knowledge and the archive; the archive sources refused.';
  return 'Searched: current knowledge and the archive.';
}
/** A failed knowledge request, classified once by the shared failure map. */
class KnowledgeRequestError extends Error {
  constructor(readonly failure:KnowledgeFailure){super(failureMessage(failure));}
}
/**
 * One call to a governed knowledge route. A failure goes through the ONE map
 * the reader uses too (knowledgeModel.ts classifyKnowledgeFailure): the
 * caller's own input in the core's words, an access refusal as one sentence
 * that names no cause, a service that cannot answer now with Retry, anything
 * else as a generic failure with Retry. An answer that is not JSON at all (a
 * proxy page, a dropped connection) is the service being unreachable, and is
 * said so rather than shown as a parse error. The audit reference is kept in
 * either form the core mints.
 */
async function api(path:string, body?:unknown) {
  let response:Response;
  try { response = await authenticatedFetch(API+path, body ? { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) } : {}); } catch { throw new KnowledgeRequestError(unreachableFailure()); }
  let value:any;
  try { value=await response.json(); } catch { throw new KnowledgeRequestError(unreachableFailure()); }
  if (!response.ok) throw new KnowledgeRequestError(classifyKnowledgeFailure(response.status, value, 'search'));
  return value;
}
function failureOf(caught:unknown):KnowledgeFailure {
  return caught instanceof KnowledgeRequestError ? caught.failure : classifyKnowledgeFailure(0, null, 'search');
}
/**
 * THE KNOWLEDGE SEARCH CONSOLE (card 1fd5de08, line 1; absorbed card f580cf50 items
 * 2084723, 2084724 and 2084727).
 *
 * The core's knowledge search surface over the governed routes the MCP tools
 * use - `GET /knowledge-sources`, `POST /knowledge-queries`,
 * `GET /knowledge-contents` - with no new authority: the caller's grants and
 * compartments decide in the core, which filters before it answers. The page
 * shows what came back and nothing else: each source's results in the
 * source's own order with its score, an explain view built from the fields
 * the core returned, the coverage record (complete, partial, unavailable,
 * refused, skipped) and the shared side-panel reader for the cited revision.
 *
 * Line 2 adds the status panel below the results (components/knowledge/
 * KnowledgeStatus.tsx): how the caller's sources answered the searches run on
 * this page, made from the same list and answers, with no request of its own.
 */
export function KnowledgePage() {
  const [sources,setSources]=useState<KnowledgeSource[]>([]),[loaded,setLoaded]=useState(false),[q,setQ]=useState('');
  const [selected,setSelected]=useState<string[]>([]),[kinds,setKinds]=useState(['code','docs','data']),[categories,setCategories]=useState<string[]>([]);
  const [allSources,setAllSources]=useState(true),[allCategories,setAllCategories]=useState(true);
  const [answer,setAnswer]=useState<Answer|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [retryable,setRetryable]=useState<null|'list'|'search'>(null),[listAttempt,setListAttempt]=useState(0);
  const fail=(caught:unknown,which:'list'|'search')=>{const failure=failureOf(caught);setError(failureMessage(failure));setRetryable(failure.retry?which:null);};
  const [askedQuery,setAskedQuery]=useState('');
  const [explained,setExplained]=useState<Set<string>>(()=>new Set());
  const [reading,setReading]=useState<KnowledgeReaderItem|null>(null);
  // Line 2 (the status panel): every search run on this page, its answer or its
  // failure, in memory only. A reload starts it again; nothing is stored.
  const [searchLog,setSearchLog]=useState<KnowledgeSearchRecord[]>([]);
  const { me }=useMyPrincipal();
  const archiveKey=me?.id?KNOWLEDGE_INCLUDE_ARCHIVE_KEY_PREFIX+me.id:null;
  const [includeArchive,setIncludeArchive]=useState(false);
  // Card 40e0e542 (rider): a tick made before GET /principals/me resolves is the
  // caller's choice - kept, and stored once the key is known. The stored value
  // loads only while the box is still untouched.
  const archiveTouched=useRef(false);
  useEffect(()=>{if(!archiveKey)return;if(archiveTouched.current)writeIncludeArchive(archiveKey,includeArchive);else setIncludeArchive(readIncludeArchive(archiveKey));},[archiveKey,includeArchive]);
  const changeIncludeArchive=(value:boolean)=>{archiveTouched.current=true;setIncludeArchive(value);};
  useEffect(()=>{let live=true;api('/knowledge-sources').then(v=>{if(live){setSources(Array.isArray(v.sources)?v.sources:[]);setLoaded(true);}}).catch(e=>{if(live){fail(e,'list');setLoaded(true);}});return()=>{live=false;};},[listAttempt]);
  const vocabulary=[...new Set(sources.filter(s=>allSources || selected.includes(s.id)).flatMap(s=>s.categories??[]))].sort();
  const toggle=(xs:string[],x:string)=>xs.includes(x)?xs.filter(v=>v!==x):[...xs,x];
  const runSearch=async()=>{setError('');setRetryable(null);setReading(null);setExplained(new Set());
    if(!kinds.length || (!allSources&&!selected.length) || (!allCategories&&!categories.length)){setError('Choose at least one value in each narrowed selector.');return;}
    setBusy(true);setAnswer(null);setAskedQuery(q);try{const value:Answer=await api('/knowledge-queries',{protocol_version:2,q,kinds,...(!allSources?{sources:selected}:{}),...(!allCategories?{categories}:{}),includeArchive,limitPerSource:8,timeoutMs:8000});setAnswer(value);setSearchLog(log=>appendSearchRecord(log,{kind:'answer',answer:value}));}catch(e){fail(e,'search');setSearchLog(log=>appendSearchRecord(log,{kind:'failed',failure:failureOf(e)}));}finally{setBusy(false);}
  };
  const search=(e:React.FormEvent)=>{e.preventDefault();void runSearch();};
  const retry=()=>{if(retryable==='list'){setError('');setRetryable(null);setLoaded(false);setListAttempt(n=>n+1);}else if(retryable==='search')void runSearch();};
  const sourceName=(id:string)=>sources.find(s=>s.id===id)?.name??answer?.groups.find(g=>g.sourceId===id)?.sourceSlug??id;
  const explain=(hit:KnowledgeHit,sourceId:string,rank:number,groupSize:number)=>answer?explainHit({hit,rank,groupSize,sourceId,sourceLabel:sourceName(sourceId),coverage:answer.coverage,query:askedQuery,formatInstant:(value)=>formatDateTime(value,value)}):[];
  const toggleExplain=(key:string)=>setExplained(current=>{const next=new Set(current);if(next.has(key))next.delete(key);else next.add(key);return next;});
  const cov=answer?.coverage;
  const outcome=cov?answerOutcome(cov):null;
  const states=cov?sourceStates(cov,sourceName):[];
  const total=answer?answer.groups.reduce((n,g)=>n+g.results.length,0):0;
  return <main className="knowledge-page">
    <header><p className="knowledge-eyebrow">Your authorized sources</p><h1>Knowledge</h1><p>Search the knowledge sources you may read, see why each result matched, and open the cited revision beside the list. Access is checked by the core on every request.</p></header>
    {error&&<div role="alert" className="knowledge-error"><p>{error}</p>{retryable&&<Button variant="secondary" size="compact" onClick={retry}>Retry</Button>}</div>}
    {loaded&&!sources.length&&!error?<section className="knowledge-card"><h2>No knowledge sources available</h2><p>An owner can configure a knowledge endpoint on an existing Service and grant you read access.</p><RequestChangeButton target={{kind:'knowledge',sources:[]}} intro="Ask for read access to a knowledge Service:"/></section>:<>
    {loaded&&<RequestChangeButton target={{kind:'knowledge',sources:sources.map(s=>({id:s.id,name:s.name}))}} intro="Missing a Project's notes? Ask for its knowledge compartment:"/>}
    <form onSubmit={search} className="knowledge-card" aria-label="Knowledge search">
      <label className="knowledge-query">Search<input aria-label="Search knowledge" value={q} onChange={e=>setQ(e.target.value)} maxLength={1024} required placeholder="Find a note, report or decision…" /></label>
      <div className="knowledge-selectors">
        <fieldset><legend>Sources</legend><label><input type="checkbox" checked={allSources} onChange={e=>setAllSources(e.target.checked)}/>All authorized</label>{!allSources&&sources.map(s=><div className="knowledge-source-option" key={s.id}><label><input type="checkbox" checked={selected.includes(s.id)} onChange={()=>setSelected(toggle(selected,s.id))} aria-describedby={`knowledge-source-${s.id}`}/>{s.name}</label><span className="knowledge-source-note" id={`knowledge-source-${s.id}`}>{sourceCompartmentsText(s)}</span></div>)}</fieldset>
        <fieldset><legend>Content kinds</legend>{['code','docs','data'].map(k=><label key={k}><input type="checkbox" checked={kinds.includes(k)} onChange={()=>setKinds(toggle(kinds,k))}/>{k}</label>)}</fieldset>
        <fieldset><legend>Scope</legend><label><input type="checkbox" checked={includeArchive} onChange={e=>changeIncludeArchive(e.target.checked)}/>Include archive</label></fieldset>
        <fieldset><legend>Categories</legend><label><input type="checkbox" checked={allCategories} onChange={e=>setAllCategories(e.target.checked)}/>All authorized</label>{!allCategories&&vocabulary.map(c=><label key={c}><input type="checkbox" checked={categories.includes(c)} onChange={()=>setCategories(toggle(categories,c))}/>{c}</label>)}</fieldset>
      </div>
      <p className="knowledge-disclosure">This query will be sent to eligible sources in this selection: {sources.filter(s=>allSources||selected.includes(s.id)).map(s=>s.name).join(', ')||'none'}. Identity-filtered sources receive your source-specific identity and permitted groups.</p>
      <Button type="submit" disabled={busy||!loaded}>{busy?'Working…':'Search'}</Button>
    </form>
    {cov&&outcome&&<section className="knowledge-card" aria-label="Search coverage"><h2>Search coverage</h2>
      <p className={`knowledge-outcome knowledge-outcome--${outcome}`}>{OUTCOME_TEXT[outcome]}</p>
      <p>{cov.answered.length} of {cov.consulted.length} consulted sources answered.</p>
      <p>{scopeLine(cov)}</p>
      {states.length>0&&<ul className="knowledge-source-states">{states.map(s=><li key={s.kind+s.id}>{s.text}</li>)}</ul>}
      {cov.truncatedResults.length>0&&<p>Some result lists were truncated. Narrow the search for more precise results.</p>}
      {cov.invalidResults.length>0&&<p>Invalid source results were omitted.</p>}<small>Audit reference: {answer?.auditRef}</small>
    </section>}
    {answer&&cov&&<section className="knowledge-results" aria-label="Results">
      {total===0&&<p className="knowledge-empty" role="status">{emptyAnswerText(cov)}</p>}
      {answer.groups.map((g,gi)=>{const label=sourceName(g.sourceId);return <section className="knowledge-group" key={g.sourceId} aria-labelledby={`knowledge-group-${gi}`}><h2 id={`knowledge-group-${gi}`}>{label}</h2>{!g.results.length?<p>No matching authorized results.</p>:<ol className="knowledge-result-list">{g.results.map((h,i)=>{
        const key=`${gi}-${i}`,open=explained.has(key),rows=explain(h,g.sourceId,i+1,g.results.length);
        return <li className="knowledge-result" key={h.handle+i}>
          <div className="knowledge-tags">{h.contentKind}{h.category?' · '+h.category:''} · {compartmentText(h.compartment)}</div>
          <h3 className="knowledge-result-title"><button type="button" className="knowledge-title" aria-haspopup="dialog" onClick={()=>setReading({handle:h.handle,title:h.title,sourceLabel:label,facts:rows})}>{h.title}</button></h3>
          <p className="knowledge-snippet">{h.snippet}</p>
          <div className="knowledge-result-meta"><span>Source: {label}</span><span>Score: {scoreText(h.score)}</span>
            <Button variant="secondary" size="compact" ariaExpanded={open} ariaControls={`knowledge-explain-${key}`} ariaLabel={`Why this matched: ${h.title}`} onClick={()=>toggleExplain(key)}>Why this matched</Button></div>
          <dl className="knowledge-explain" id={`knowledge-explain-${key}`} hidden={!open}>{rows.map(row=><React.Fragment key={row.term}><dt>{row.term}</dt><dd>{row.detail}</dd></React.Fragment>)}</dl>
        </li>;})}</ol>}</section>;})}
    </section>}
    {loaded&&sources.length>0&&<KnowledgeStatus sources={sources} log={searchLog} label={sourceName}/>}
    </>}
    {reading&&<KnowledgeReader item={reading} onClose={()=>setReading(null)}/>}
  </main>;
}
