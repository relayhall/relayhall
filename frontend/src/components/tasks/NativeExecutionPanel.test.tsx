// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {cleanup,render,screen,waitFor,act} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,expect,test,vi} from 'vitest';
import {NativeExecutionPanel} from './NativeExecutionPanel';
import {authenticatedFetch} from '../../utils/auth';
const {handlers,subscribe}=vi.hoisted(()=>{
  const handlers=new Map<string,()=>void>();
  return {handlers,subscribe:(type:string,fn:()=>void)=>{handlers.set(type,fn);return()=>handlers.delete(type);}};
});
vi.mock('../../utils/auth',()=>({authenticatedFetch:vi.fn()}));
vi.mock('../../hooks/useWebSocket',()=>({useWebSocket:()=>({connected:true,subscribe})}));
const row={id:'execution',runOrdinal:1,state:'closed',actorPrincipalId:'actual-owner',outcome:'completed',reportId:'own-report'};
const available={state:'attested',sessions:[{state:'available',slotId:'slot',relationship:'resumed',connectorId:'connector',sourceProduct:'claude-code',sessionRef:'rhp_private'}]};
function response(session:unknown){return new Response(JSON.stringify({result:{executions:[{...row,session}]}}));}
function show(){const cache=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={cache}><MemoryRouter><NativeExecutionPanel taskId="task"/></MemoryRouter></QueryClientProvider>);return cache;}
afterEach(()=>{cleanup();vi.mocked(authenticatedFetch).mockReset();handlers.clear();});
test('implementation links exact triple, actual actor and result; process outcome does not claim verified Task',async()=>{
  vi.mocked(authenticatedFetch).mockImplementation(async()=>response(available));show();
  expect(await screen.findByRole('link',{name:'View reported implementation session'})).toHaveAttribute('href','/sessions?sessionRef=rhp_private&connectorId=connector&sourceProduct=claude-code');
  expect(screen.getByText(/Actor actual-owner/)).toBeInTheDocument();
  expect(screen.getByText(/does not verify or complete/)).toBeInTheDocument();
  expect(screen.getByText(/Session-wide activity may include other runs/)).toBeInTheDocument();
  expect(screen.getByRole('link',{name:'Implementation result'})).toHaveAttribute('href','/reports/own-report');
});
test.each(['restricted','expired','unavailable'])('%s never displays stale triple',async state=>{
  vi.mocked(authenticatedFetch).mockImplementation(async()=>response({...available,state}));show();
  expect(await screen.findByText(`Session ${state}.`)).toBeInTheDocument();
  expect(screen.queryByRole('link',{name:'View reported implementation session'})).not.toBeInTheDocument();
});
test('authority hint removes cached links before refreshed denial; late prior response cannot restore them',async()=>{
  let phase=0,finish:(r:Response)=>void=()=>{};
  vi.mocked(authenticatedFetch).mockImplementation(async()=>phase===0?response(available):phase===1?new Promise(resolve=>{finish=resolve;}):new Response('{}',{status:404}));
  const cache=show();expect(await screen.findByRole('link',{name:'View reported implementation session'})).toBeInTheDocument();
  phase=1;act(()=>{void cache.invalidateQueries({queryKey:['native-executions','task']});});
  await waitFor(()=>expect(screen.queryByRole('link',{name:'View reported implementation session'})).not.toBeInTheDocument());
  phase=2;act(()=>{handlers.get('project.authority_changed')!();});
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
  await act(async()=>{finish(response(available));await Promise.resolve();});
  expect(screen.queryByRole('link',{name:'View reported implementation session'})).not.toBeInTheDocument();
});
