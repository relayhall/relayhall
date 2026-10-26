// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { vi, test, expect, afterEach, beforeEach } from 'vitest';
import { KnowledgePage, KNOWLEDGE_INCLUDE_ARCHIVE_KEY_PREFIX } from './KnowledgePage';
import { authenticatedFetch } from '../utils/auth';
vi.mock('../utils/auth',()=>({authenticatedFetch:vi.fn()}));
const PRINCIPAL='d1111111-1111-4111-8111-111111111111';
const OTHER_PRINCIPAL='d2222222-2222-4222-8222-222222222222';
const source={id:'a1111111-1111-4111-8111-111111111111',name:'Notes',categories:['relaybrain:note'],claimsMode:'asserted'};
const coverage=(extra:Record<string,unknown>={})=>({consulted:[source.id],answered:[source.id],timedOut:[],unavailable:[],refusedBySource:[],refusedByPolicy:[],skipped:[],truncatedResults:[],invalidResults:[],searchedCategories:[{id:source.id,categories:['relaybrain:note']}],archive:{included:false,declaredBy:[source.id]},...extra});
/**
 * The page makes three reads - the caller's principal, the source list and the
 * search - and the mock answers each by its PATH, so the order the effects
 * happen to run in cannot hand one read another's answer.
 */
function serve(answers:{me?:string|null;meGate?:Promise<void>;sources?:unknown;query?:{ok:boolean;body:unknown}}) {
 vi.mocked(authenticatedFetch).mockImplementation(async (input:RequestInfo|URL)=>{
  const url=String(input);
  // Rider: a gate holds the principal read open, so a test can act before it resolves.
  if(url.endsWith('/principals/me')&&answers.meGate)await answers.meGate;
  if(url.endsWith('/principals/me'))return (answers.me===null?{ok:false,status:404,json:async()=>({})}:{ok:true,status:200,json:async()=>({principal:{id:answers.me??PRINCIPAL,kind:'human',handle:'holder',status:'active'}})}) as Response;
  if(url.includes('/knowledge-sources'))return {ok:true,status:200,json:async()=>(answers.sources??{sources:[source]})} as Response;
  if(url.includes('/knowledge-queries'))return {ok:answers.query?.ok??true,status:answers.query?.ok===false?422:200,json:async()=>(answers.query?.body??{coverage:coverage(),groups:[{sourceId:source.id,sourceSlug:'notes',results:[]}],auditRef:'audit'})} as Response;
  throw new Error('unexpected read '+url);
 });
}
const queryBody=()=>{const call=vi.mocked(authenticatedFetch).mock.calls.find(([url])=>String(url).includes('/knowledge-queries'));expect(call).toBeDefined();return JSON.parse(call![1]!.body as string);};
async function ready(){await screen.findByText(/This query will be sent/);await waitFor(()=>expect(screen.getByRole('button',{name:'Search'})).not.toBeDisabled());}
/** Let the principal read resolve, so the per-principal key is known before the box is used. */
async function settle(){await waitFor(()=>expect(vi.mocked(authenticatedFetch).mock.calls.some(([url])=>String(url).endsWith('/principals/me'))).toBe(true));await act(async()=>{await new Promise((resolve)=>setTimeout(resolve,25));});}
async function searchFor(text:string){fireEvent.change(screen.getByLabelText('Search knowledge'),{target:{value:text}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByLabelText('Search coverage');}
beforeEach(()=>{localStorage.clear();});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.restoreAllMocks();localStorage.clear();});
test('native page submits v2 categories and shows partial coverage before result content',async()=>{
 serve({query:{ok:true,body:{coverage:coverage({partialSources:[{id:source.id,reasons:['deadline']}]}),groups:[{sourceId:source.id,sourceSlug:'notes',results:[]}],auditRef:'audit'}}});
 render(<KnowledgePage/>);
 await ready();
 fireEvent.change(screen.getByLabelText('Search knowledge'),{target:{value:'needle'}});
 const all=screen.getAllByLabelText('All authorized');fireEvent.click(all[1]);
 fireEvent.click(await screen.findByLabelText('relaybrain:note'));
 fireEvent.click(screen.getByRole('button',{name:'Search'}));
 await screen.findByText('Notes: partial (deadline)');
 expect(queryBody()).toMatchObject({protocol_version:2,q:'needle',categories:['relaybrain:note']});
 expect(screen.getByLabelText('Search coverage')).toBeTruthy();
});

test('search refusal shows the opaque audit reference for operator follow-up',async()=>{
 const auditRef='ka_'+'a'.repeat(32);
 serve({sources:{sources:[{id:auditRef,name:'Notes',claimsMode:'asserted'}]},query:{ok:false,body:{message:'Narrow the authorized source selection to at most 16 sources.',auditRef}}});
 render(<KnowledgePage/>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Search'})).not.toBeDisabled());
 fireEvent.change(screen.getByLabelText('Search knowledge'),{target:{value:'needle'}});
 fireEvent.click(screen.getByRole('button',{name:'Search'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Audit reference: '+auditRef);
});

// ── Card 3e0ae06e: a cold first search gets the whole budget ──

test('a search sends timeoutMs 8000, the longest the core allows, so a cold first search can answer rows',async()=>{
 serve({});
 render(<KnowledgePage/>);
 await ready();
 await searchFor('needle');
 expect(queryBody().timeoutMs).toBe(8000);
});

// ── Card 40e0e542 (owner ruling E127 (5)): the default scope ──

test('Include archive is OFF by default: the search sends includeArchive false and the coverage line says the archive was excluded',async()=>{
 serve({});
 render(<KnowledgePage/>);
 await ready();
 const box=screen.getByLabelText('Include archive') as HTMLInputElement;
 expect(box.checked).toBe(false);
 await searchFor('needle');
 expect(queryBody()).toMatchObject({protocol_version:2,q:'needle',includeArchive:false});
 expect(screen.getByLabelText('Search coverage')).toHaveTextContent('Searched: current knowledge; archive excluded.');
});

test('ticking Include archive sends includeArchive true, says so in coverage, and is remembered for THIS principal only',async()=>{
 serve({query:{ok:true,body:{coverage:coverage({archive:{included:true,declaredBy:[source.id]}}),groups:[],auditRef:'audit'}}});
 const first=render(<KnowledgePage/>);
 await ready();
 // The stored choice needs the principal: let the key resolve before ticking.
 await settle();
 expect(localStorage.getItem(KNOWLEDGE_INCLUDE_ARCHIVE_KEY_PREFIX+PRINCIPAL)).toBeNull();
 fireEvent.click(screen.getByLabelText('Include archive'));
 await waitFor(()=>expect(localStorage.getItem(KNOWLEDGE_INCLUDE_ARCHIVE_KEY_PREFIX+PRINCIPAL)).toBe('1'));
 await searchFor('needle');
 expect(queryBody()).toMatchObject({protocol_version:2,q:'needle',includeArchive:true});
 expect(screen.getByLabelText('Search coverage')).toHaveTextContent('Searched: current knowledge and the archive.');
 first.unmount();
 // A reload as the same principal restores the choice...
 vi.mocked(authenticatedFetch).mockClear();
 const again=render(<KnowledgePage/>);
 await ready();
 await waitFor(()=>expect((screen.getByLabelText('Include archive') as HTMLInputElement).checked).toBe(true));
 again.unmount();
 // ...and another principal in the same browser starts from the default.
 serve({me:OTHER_PRINCIPAL});
 render(<KnowledgePage/>);
 await ready();
 await settle();
 expect((screen.getByLabelText('Include archive') as HTMLInputElement).checked).toBe(false);
 expect(localStorage.getItem(KNOWLEDGE_INCLUDE_ARCHIVE_KEY_PREFIX+OTHER_PRINCIPAL)).toBeNull();
 await searchFor('needle');
 expect(queryBody()).toMatchObject({includeArchive:false});
});

test('storage that throws leaves the default: current knowledge only, and the page still searches',async()=>{
 vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('blocked');});
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('blocked');});
 serve({});
 render(<KnowledgePage/>);
 await ready();
 await settle();
 expect((screen.getByLabelText('Include archive') as HTMLInputElement).checked).toBe(false);
 fireEvent.click(screen.getByLabelText('Include archive'));
 expect((screen.getByLabelText('Include archive') as HTMLInputElement).checked).toBe(true);
 await searchFor('needle');
 expect(queryBody()).toMatchObject({includeArchive:true});
});

// ── Card 40e0e542 rider (the L3 review) ──

test('the coverage line is true in each situation: no declaring source, the default, the opt-in, and an opt-in every declaring source refused',async()=>{
 const cases:[string,Record<string,unknown>,string][]=[
  ['no declaring source',{archive:{included:false,declaredBy:[]}},'Searched: current knowledge (no consulted source declares an archive).'],
  ['no declaring source, opted in',{archive:{included:true,declaredBy:[]}},'Searched: current knowledge (no consulted source declares an archive).'],
  ['the default',{archive:{included:false,declaredBy:[source.id]}},'Searched: current knowledge; archive excluded.'],
  ['the opt-in',{archive:{included:true,declaredBy:[source.id]}},'Searched: current knowledge and the archive.'],
  ['the opt-in, every declaring source refused',{answered:[],refusedBySource:[source.id],archive:{included:true,declaredBy:[source.id]}},'Scope requested: current knowledge and the archive; the archive sources refused.'],
 ];
 for(const [label,extra,line] of cases){
  serve({query:{ok:true,body:{coverage:coverage(extra),groups:[],auditRef:'audit'}}});
  render(<KnowledgePage/>);
  await ready();
  await searchFor('needle');
  expect({label,line:screen.getByLabelText('Search coverage').textContent?.includes(line)}).toEqual({label,line:true});
  cleanup();
 }
});

test('a tick made before GET /principals/me resolves is kept and stored once the principal is known, never overwritten by the stored value',async()=>{
 // A stored "off" from an earlier visit, and a principal read that has not answered yet.
 localStorage.setItem(KNOWLEDGE_INCLUDE_ARCHIVE_KEY_PREFIX+PRINCIPAL,'0');
 let release:()=>void=()=>undefined;
 const meGate=new Promise<void>((resolve)=>{release=resolve;});
 serve({meGate,query:{ok:true,body:{coverage:coverage({archive:{included:true,declaredBy:[source.id]}}),groups:[],auditRef:'audit'}}});
 render(<KnowledgePage/>);
 await ready();
 fireEvent.click(screen.getByLabelText('Include archive'));
 expect((screen.getByLabelText('Include archive') as HTMLInputElement).checked).toBe(true);
 await act(async()=>{release();});
 // The tick is stored under this principal's key once it is known...
 await waitFor(()=>expect(localStorage.getItem(KNOWLEDGE_INCLUDE_ARCHIVE_KEY_PREFIX+PRINCIPAL)).toBe('1'));
 // ...and the stored "off" never replaced it.
 expect((screen.getByLabelText('Include archive') as HTMLInputElement).checked).toBe(true);
 await searchFor('needle');
 expect(queryBody()).toMatchObject({includeArchive:true});
});
